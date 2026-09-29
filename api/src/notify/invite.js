/**
 * Giving an imported candidate a way in.
 *
 * A person who arrives through the Naukri mailbox gets a portal account
 * and a message carrying their login. A person imported from a
 * spreadsheet got a row in `candidates` and nothing else: the recruiter
 * could see them, they could not see themselves, could not correct what
 * the file said about them, and never heard they were in the database.
 *
 * Same account creation as the mail intake - candidate_portal_account()
 * - and the same three channels, so a candidate who reads only WhatsApp
 * is reached the same way whichever door they came through.
 *
 * THE PASSWORD LIVES FOR THE LENGTH OF THIS FUNCTION. It is generated,
 * hashed into `users`, put into the outgoing message, and returned to
 * nobody. It is not logged, not stored, and never appears in an API
 * response or in the recruiter's view of the candidate.
 */
import { config } from '../config.js';
import { withUser } from '../db.js';
import { hashPassword } from '../auth.js';
import { providers } from './providers.js';
import { buildEventMessages } from './templates.js';
import { temporaryPassword } from '../intake/process.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };
const CHANNELS = ['email', 'sms', 'whatsapp'];

/**
 * Invite one candidate to the portal.
 *
 * @param candidate  { id, name, email, phone }
 * @param opts.invitedBy  who ran the import, for the record
 * @param opts.companyName  whose database they have been added to
 * @returns { invited, accountCreated, delivery } - never a password
 */
export async function inviteCandidate(candidate, opts = {}) {
  const out = { invited: false, accountCreated: false, delivery: {} };
  if (!candidate || !candidate.id) return out;

  /*
   * Never twice.
   *
   * An import run a second time must not send the same person another
   * set of credentials: the first ones still work, and a message saying
   * "here is your password" when it is not the password they were given
   * is worse than no message at all.
   */
  const already = await withUser(ENGINE, async (c) => (await c.query(
    `select candidate_invited($1) as yes`, [candidate.id])).rows[0].yes);
  if (already) { out.reason = 'already invited'; return out; }

  // Somebody who asked not to be contacted is not contacted, whichever
  // door the request came through.
  const person = await withUser(ENGINE, async (c) => (await c.query(
    `select do_not_contact from candidates where id = $1`, [candidate.id])).rows[0]);
  if (person && person.do_not_contact) { out.reason = 'do not contact'; return out; }

  /* ---- the account ------------------------------------------------- *
   *
   * THE LOGIN IS THE ADDRESS WHEN THERE IS ONE, AND THE NUMBER WHEN
   * THERE IS NOT.
   *
   * `users.email` is not nullable and is the unique key, so an account
   * for somebody who has only a phone still needs a value in it. That
   * value is synthesised from the number and is NEVER shown to anybody,
   * never mailed, and never presented as their address: they sign in by
   * typing their phone number, which auth_find_login resolves (0071).
   *
   * The `.invalid` domain is reserved by RFC 2606 and is already on this
   * application's own list of addresses that must never be written to,
   * so a stray "send them an email" can never reach it by accident.
   */
  const digits10 = String(candidate.phone || '').replace(/\D/g, '').slice(-10);
  const loginEmail = candidate.email
    || (digits10.length === 10 ? `${digits10}@phone.invalid` : null);

  let credentials = null;
  if (loginEmail) {
    const password = temporaryPassword();
    const hash = await hashPassword(password);
    const account = await withUser(ENGINE, async (c) => (await c.query(
      `select candidate_portal_account($1,$2,$3) as out`,
      [candidate.id, loginEmail, hash])).rows[0].out);

    if (account.created) {
      out.accountCreated = true;
      /*
       * What they TYPE to sign in, which is the number when there is no
       * address - printing a `@phone.invalid` login on a message would
       * be worse than printing nothing.
       */
      credentials = { email: candidate.email || digits10, password };
    } else {
      // They can already sign in. Tell them they are in the database,
      // but do not hand out a password that is not theirs.
      out.reason = account.reason;
    }
  }

  /* ---- the message ------------------------------------------------- */
  const base = String(config.publicOrigin || '').replace(/\/$/, '');
  const portalUrl = `${base}/#/login/candidate`;
  const company = opts.companyName || config.emailFromName || 'TeamLink Consultants';

  const messages = buildEventMessages('CANDIDATE_INVITED', {
    candidateName: candidate.name,
    company,
    addedBy: opts.addedBy || null,
    portalUrl,
    linkLabel: 'Open the candidate portal',
    loginEmail: credentials ? credentials.email : (candidate.email || null),
    tempPassword: credentials ? credentials.password : null,
    smsLead: `You have been added to the ${company} candidate database. `
           + 'Sign in to complete your profile:',
  });
  if (!messages) return out;

  for (const channel of CHANNELS) {
    const to = channel === 'email' ? candidate.email : candidate.phone;
    let result;

    if (!to) {
      result = { status: 'skipped_no_address', provider: channel };
    } else {
      try {
        result = await providers[channel].send({
          to,
          vars: {
            to_name: candidate.name,
            candidate_name: candidate.name,
            company_name: company,
            portal_link: portalUrl,
            login_email: credentials ? credentials.email : '',
            temporary_password: credentials ? credentials.password : '',
          },
          subject: messages.email.subject,
          html: messages.email.html,
          text: channel === 'sms' ? messages.sms
              : channel === 'whatsapp' ? messages.whatsapp
              : messages.email.text,
        });
      } catch (err) {
        result = { status: 'failed', provider: channel, error: err.message };
      }
    }

    out.delivery[channel] = result.status;
    if (result.status === 'sent') out.invited = true;

    await withUser(ENGINE, (c) => c.query(
      `select candidate_invite_record($1,$2,$3,$4,$5,$6,$7,$8)`,
      [candidate.id, channel, result.status, to || null,
       result.provider || null, result.error || null,
       // Whether it carried a password. Never the password.
       !!credentials, opts.invitedBy || 'system']));
  }

  return out;
}

/**
 * Send somebody who ALREADY has an account a fresh set of credentials.
 *
 * Different from an invitation in one way that matters: this replaces a
 * password that may still work. So the order is deliberate -
 *
 *   generate -> SEND -> only then write the new hash
 *
 * not the obvious one. A reset that commits first and sends second is a
 * trap: if the provider is down, out of quota or misconfigured, the
 * person loses the password they had and never receives the one that
 * replaced it. They are locked out by the act of helping them.
 *
 * Sending first means the worst case is that nothing happens.
 *
 * @returns { sent, delivery, reason } - never the password
 */
export async function resendCredentials(candidate, opts = {}) {
  const out = { sent: false, delivery: {} };
  if (!candidate || !candidate.id) return out;
  /* A way to reach them, not one particular way: somebody whose login is
     their phone number is reissued over SMS or WhatsApp. */
  if (!candidate.email && !candidate.phone) {
    out.reason = 'no email address or phone number';
    return out;
  }

  const person = await withUser(ENGINE, async (c) => (await c.query(
    `select c.do_not_contact, c.user_id, u.email as login_email
       from candidates c left join users u on u.id = c.user_id
      where c.id = $1`, [candidate.id])).rows[0]);
  if (!person) { out.reason = 'no such candidate'; return out; }
  if (person.do_not_contact) { out.reason = 'do not contact'; return out; }
  if (!person.user_id) { out.reason = 'no account to reset'; return out; }

  const password = temporaryPassword();

  /*
   * WHAT THEY TYPE, not what the database stores.
   *
   * An account created for somebody with no email address carries a
   * synthesised `<number>@phone.invalid` login (see inviteCandidate);
   * printing that on a message would tell them to type an address that
   * does not exist. They sign in with the number.
   */
  const storedLogin = String(person.login_email || '');
  const loginEmail = /@phone\.invalid$/i.test(storedLogin)
    ? String(candidate.phone || '').replace(/\D/g, '').slice(-10)
    : (storedLogin || candidate.email);

  const base = String(config.publicOrigin || '').replace(/\/$/, '');
  const portalUrl = `${base}/#/login/candidate`;
  const company = opts.companyName || config.emailFromName || 'TeamLink Consultants';

  const messages = buildEventMessages('CANDIDATE_INVITED', {
    candidateName: candidate.name,
    company,
    portalUrl,
    linkLabel: 'Open the candidate portal',
    loginEmail,
    tempPassword: password,
    smsLead: `Your ${company} candidate portal login:`,
  });
  if (!messages) { out.reason = 'no template'; return out; }

  for (const channel of CHANNELS) {
    const to = channel === 'email' ? candidate.email : candidate.phone;
    let result;

    if (!to) {
      result = { status: 'skipped_no_address', provider: channel };
    } else {
      try {
        result = await providers[channel].send({
          to,
          vars: {
            to_name: candidate.name,
            candidate_name: candidate.name,
            company_name: company,
            portal_link: portalUrl,
            login_email: loginEmail,
            temporary_password: password,
          },
          subject: messages.email.subject,
          html: messages.email.html,
          text: channel === 'sms' ? messages.sms
              : channel === 'whatsapp' ? messages.whatsapp
              : messages.email.text,
        });
      } catch (err) {
        result = { status: 'failed', provider: channel, error: err.message };
      }
    }

    out.delivery[channel] = result.status;
    if (result.status === 'sent') out.sent = true;

    await withUser(ENGINE, (c) => c.query(
      `select candidate_invite_record($1,$2,$3,$4,$5,$6,$7,$8)`,
      [candidate.id, channel, result.status, to || null,
       result.provider || null, result.error || null,
       // Only true where the message actually left with a password in it.
       result.status === 'sent', opts.invitedBy || 'system']));
  }

  /*
   * The password is committed ONLY if at least one message left. If
   * nothing did, the one they already have keeps working and the new one
   * is discarded here, unused.
   */
  if (!out.sent) {
    out.reason = 'nothing was delivered, so the existing password was left alone';
    return out;
  }

  const hash = await hashPassword(password);

  /*
   * THROUGH THE DEFINER FUNCTION. The direct UPDATE that used to be here
   * matched no row-level-security policy on `users`, so it affected zero
   * rows and raised nothing: this function emailed somebody a brand new
   * temporary password, wrote it nowhere, and returned success. The
   * password in that message had never worked. See 0070.
   *
   * Every session is ended here - no token is kept - because reissuing
   * credentials is precisely the moment you want whoever held the old
   * ones signed out.
   */
  const stored = await withUser(ENGINE, async (c) => (await c.query(
    `select auth_set_password($1,$2,true,null) as ok`,
    [person.user_id, hash])).rows[0]);

  if (!stored || stored.ok !== true) {
    /* Said plainly. The message has already gone, so the person now
       holds a password that does not work, and somebody has to know. */
    out.reason = 'the new password could not be stored';
    out.sent = false;
    console.error('[invite] the reissued password was not stored for user', person.user_id);
  }

  return out;
}

/**
 * Invite a list, one at a time.
 *
 * Deliberately sequential. A spreadsheet of four hundred people fired at
 * a provider in parallel is a rate limit at best and a spam report at
 * worst, and the import has already returned by the time this runs.
 */
export async function inviteCandidates(list, opts = {}) {
  const summary = { invited: 0, accountsCreated: 0, skipped: 0 };
  for (const candidate of list) {
    try {
      const out = await inviteCandidate(candidate, opts);
      if (out.invited) summary.invited++; else summary.skipped++;
      if (out.accountCreated) summary.accountsCreated++;
    } catch (err) {
      summary.skipped++;
      console.error(`[invite] ${candidate.id} failed:`, err.message);
    }
  }
  return summary;
}
