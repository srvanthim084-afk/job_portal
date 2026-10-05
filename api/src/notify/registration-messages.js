/**
 * The two messages a new registration earns (0109):
 *
 *   welcome            straight after the account is created, with the
 *                      Candidate ID in it
 *   profile_reminder   ONE reminder, REGISTRATION_REMINDER_HOURS (48 by
 *                      default) later, only if the profile is still thin
 *
 * WHAT IT WILL NOT DO
 *   - send either message twice: a row is claimed in
 *     candidate_registration_messages BEFORE anything is sent, keyed
 *     (candidate, kind, channel), so a restart, a second server or a
 *     double submit finds the claim and stops;
 *   - write to somebody marked do-not-contact, who switched email off,
 *     or who withdrew communication consent - those are recorded as
 *     skipped_*, so the reason is visible;
 *   - remind anybody who did not register through this flow (the
 *     reminder query only considers candidates with a welcome row), so
 *     the existing database is never suddenly written to;
 *   - report "sent" from anything but the provider's own answer.
 *
 * A failed welcome is retried by the sweep, at most three attempts in all,
 * ten minutes apart at the least; the row reads 'retrying' while it is.
 */
import { config } from '../config.js';
import { withUser } from '../db.js';
import { providers } from './providers.js';
import { emailLayout } from './layout.js';
import { registrationSettings } from '../registration/settings.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };

const base = () => String(config.publicOrigin || '').replace(/\/$/, '');

function firstName(name) {
  const n = String(name || '').trim().split(/\s+/)[0];
  return n && n.length <= 40 ? n : '';
}

/** The words. Plain, short, nothing about any employer. */
export function buildRegistrationEmail(kind, person) {
  const hi = firstName(person.name) ? `Hi ${firstName(person.name)},` : 'Hi,';
  const code = person.candidate_code || person.candidateCode || '';
  const profileUrl = `${base()}/#/candidate/profile`;
  const loginUrl = `${base()}/#/login/candidate`;

  if (kind === 'welcome') {
    const subject = 'Welcome to TeamLink! Your Candidate ID is ' + code;
    const body = 'Your TeamLink profile has been created successfully.\n\n'
      + 'Keep your Candidate ID handy - quote it whenever you speak to a TeamLink recruiter.\n\n'
      + 'A complete profile is matched to more roles. Add anything you skipped - your education, '
      + 'experience, skills and links - whenever you are ready.';
    return {
      subject,
      text: [hi, '', 'Your TeamLink profile has been created successfully.', '',
        `Candidate ID: ${code}`, `Sign in: ${loginUrl}`, '',
        'Keep your Candidate ID handy - quote it whenever you speak to a TeamLink recruiter.',
        'A complete profile is matched to more roles. Complete it here:', profileUrl, '',
        'TeamLink Consultants'].join('\n'),
      html: emailLayout({
        title: 'Welcome to TeamLink!',
        preheader: `Your Candidate ID is ${code}`,
        greeting: hi,
        body,
        facts: [['Candidate ID', code], ['Sign in with', person.email]],
        cta: { label: 'Complete Profile', url: profileUrl },
        note: 'You are receiving this because you created a TeamLink candidate account. '
          + 'We will never ask for your password by email.',
      }),
    };
  }

  const subject = 'A few details left on your TeamLink profile';
  const body = 'Your TeamLink profile is set up, but a few sections are still empty.\n\n'
    + 'Recruiters search by skills, education, experience and preferences - the more of '
    + 'those your profile has, the more roles it is matched to.';
  return {
    subject,
    text: [hi, '', 'Your TeamLink profile is set up, but a few sections are still empty.',
      'The more your profile says, the more roles it is matched to.', '',
      `Candidate ID: ${code}`, `Complete your profile: ${profileUrl}`, '',
      'This is the only reminder we will send about it.', '', 'TeamLink Consultants'].join('\n'),
    html: emailLayout({
      title: 'Complete your TeamLink profile',
      preheader: 'A few sections are still empty',
      greeting: hi,
      body,
      facts: [['Candidate ID', code]],
      cta: { label: 'Complete Profile', url: profileUrl },
      note: 'This is the only reminder we will send about your profile.',
    }),
  };
}

/**
 * Send one message to one candidate, at most once.
 *
 * @returns {{status:string, reason?:string}}
 */
export async function sendRegistrationMessage(candidateId, kind) {
  if (!['welcome', 'profile_reminder'].includes(kind)) throw new Error('unknown message kind');

  const target = await withUser(ENGINE, async (c) => (await c.query(
    `select * from registration_message_target($1)`, [candidateId])).rows[0]);
  if (!target || !target.has_account) return { status: 'skipped', reason: 'no account' };

  /* The refusals are recorded too (claim, then mark), so "why did they
     not get a welcome?" has an answer in the table. */
  let refusal = null;
  if (target.do_not_contact) refusal = 'skipped_do_not_contact';
  else if (target.email_opt_in === false) refusal = 'skipped_opted_out';
  else if (target.communication === 'withdrawn') refusal = 'skipped_no_consent';
  else if (!String(target.email || '').trim()) refusal = 'skipped_no_address';

  const claimed = await withUser(ENGINE, async (c) => (await c.query(
    `select registration_message_claim($1,$2,$3) as ok`, [candidateId, kind, target.email || null])).rows[0].ok);
  if (!claimed) return { status: 'duplicate' };

  if (refusal) {
    await withUser(ENGINE, (c) => c.query(`select registration_message_done($1,$2,$3,$4,$5)`,
      [candidateId, kind, refusal, null, null]));
    return { status: refusal };
  }

  const msg = buildRegistrationEmail(kind, target);
  let result;
  try {
    result = await providers.email.send({
      to: target.email, subject: msg.subject, html: msg.html, text: msg.text,
      vars: {
        to_name: target.name, candidate_name: target.name, candidate_email: target.email,
        candidate_id: target.candidate_code,
        portal_login_url: `${base()}/#/login/candidate`,
        portal_link: `${base()}/#/candidate/profile`,
      },
    });
  } catch (err) {
    result = { status: 'failed', provider: 'email', error: err.message };
  }
  const status = String((result && result.status) || 'failed');
  await withUser(ENGINE, (c) => c.query(`select registration_message_done($1,$2,$3,$4,$5)`,
    [candidateId, kind, status === 'delivered' ? 'sent' : status,
     (result && result.provider) || 'email', (result && result.error) || null]));
  return { status };
}

/** After a registration: never awaited by the request, never throws. */
export function queueWelcome(candidateId) {
  setImmediate(() => {
    sendRegistrationMessage(candidateId, 'welcome').catch((err) => {
      console.error('[registration] welcome could not be sent:', err.message);
    });
  });
}

/** One pass: retry failed welcomes, then the reminders that are due. */
export async function runRegistrationSweep({ limit = 100 } = {}) {
  const out = { retried: 0, reminded: 0 };
  const failed = await withUser(ENGINE, async (c) => (await c.query(
    `select candidate_id from candidate_registration_messages
      where kind = 'welcome' and status = 'failed' and attempts < 3
        and updated_at < now() - interval '10 minutes'
      order by updated_at limit $1`, [limit])).rows);
  for (const r of failed) {
    const s = await sendRegistrationMessage(r.candidate_id, 'welcome');
    if (s.status !== 'duplicate') out.retried++;
  }

  const hours = registrationSettings().reminderHours;
  const due = await withUser(ENGINE, async (c) => (await c.query(
    `select id from registration_reminders_due($1,$2)`, [hours, limit])).rows);
  for (const r of due) {
    const s = await sendRegistrationMessage(r.id, 'profile_reminder');
    if (s.status !== 'duplicate') out.reminded++;
  }
  return out;
}

/** The background pass: not on boot, every half hour by default. */
export function startRegistrationSweep() {
  const every = Number(process.env.REGISTRATION_SWEEP_MS || 30 * 60 * 1000);
  let stopped = false;
  let running = false;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const out = await runRegistrationSweep();
      if (out.retried || out.reminded) {
        console.log(`[registration] ${out.reminded} reminder(s), ${out.retried} welcome retr(ies)`);
      }
    } catch (err) {
      console.error('[registration] the sweep failed:', err.message);
    } finally { running = false; }
  };
  const first = setTimeout(run, Number(process.env.REGISTRATION_SWEEP_FIRST_MS || 5 * 60 * 1000));
  const timer = setInterval(run, every);
  first.unref?.();
  timer.unref?.();
  return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
}
