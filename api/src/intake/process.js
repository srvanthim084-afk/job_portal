/**
 * Naukri email in, candidate out - and everything that follows from it.
 *
 *   message
 *     -> is this an application at all?
 *     -> extract what is actually there
 *     -> is this person already in the database?  (email, then mobile)
 *     -> create or UPDATE the candidate, never fork them
 *     -> which requirement?  no confident answer -> the recruiter's queue
 *     -> create the application, which gets TL-APP-2026-00452
 *     -> create the portal account with a password nobody types
 *     -> email, SMS and WhatsApp, all quoting the same reference
 *     -> write the timeline
 *
 * Rules that hold throughout:
 *
 *   - the same message is processed once. `email_messages` has a unique
 *     (mailbox, message_id) and every sync records what it saw BEFORE it
 *     decides anything.
 *   - one person, many applications. A second Naukri email for a
 *     different role adds an application to the same candidate.
 *   - nothing is invented. A field absent from the email stays empty and
 *     the candidate fills it in on the portal.
 *   - a failed message never stops the sync, and a failed SMS never
 *     undoes a created candidate.
 */
import { randomBytes } from 'node:crypto';
import { withUser } from '../db.js';
import { config } from '../config.js';
import { hashPassword } from '../auth.js';
import { toJob, toCandidate } from '../shapes.js';
import { providers } from '../notify/providers.js';
import { buildEventMessages } from '../notify/templates.js';
import { parseMessage, matchRequirement, DEFAULT_RULES } from './parse.js';
import { matchCandidate } from '../ai/match.js';
import { screenApplication } from '../ai/screening.js';
import { mailboxProvider, mailboxReadiness, newMessageId } from './mailbox.js';

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** The identity the importer runs as: it must see every candidate. */
const ENGINE = { userId: '', role: 'admin', profileId: null };

/* ------------------------------------------------------------------ *
 * the temporary password
 * ------------------------------------------------------------------ */

/**
 * A password the candidate can read off a screen and type on a phone,
 * generated from a cryptographic source.
 *
 * No ambiguous characters: 0/O and 1/l/I are read wrong far more often
 * than they are typed wrong, and a candidate who cannot log in does not
 * email support, they give up.
 */
export function temporaryPassword() {
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = upper + lower + digits;
  const pick = (set) => set[randomBytes(1)[0] % set.length];

  // Shape: TL@ + 5 characters, with at least one of each class, which
  // satisfies the server's own password rule without being a puzzle.
  let body = pick(upper) + pick(lower) + pick(digits);
  while (body.length < 5) body += pick(all);
  body = body.split('').sort(() => (randomBytes(1)[0] % 2 ? 1 : -1)).join('');
  return `TL@${body}`;
}

/* ------------------------------------------------------------------ *
 * one message
 * ------------------------------------------------------------------ */

/**
 * @returns {{status, reason, candidateId?, applicationId?, reference?, delivery?}}
 */
export async function processMessage(session, { mailbox, message, rowId }) {
  const rules = { ...DEFAULT_RULES, ...(mailbox.rules || {}) };
  const parsed = parseMessage(message, rules);

  const finish = async (status, reason, extra = {}) => {
    await withUser(ENGINE, (c) => c.query(
      `select email_message_result($1,$2,$3,$4::jsonb,$5,$6)`,
      [rowId, status, reason, JSON.stringify({ ...parsed, ...(extra.parsed || {}) }),
       extra.candidateId || null, extra.applicationId || null]));
    return { status, reason, ...extra };
  };

  if (!parsed.isApplication) {
    return finish('ignored', parsed.why);
  }

  const c = parsed.candidate;
  if (!c.name) {
    return finish('needs_review', 'No candidate name could be read from this email.');
  }
  if (!c.email && !c.phone) {
    return finish('needs_review',
      'No email address and no mobile number - there is nothing to contact this candidate on.');
  }

  /*
   * A missing email address does NOT stop the import.
   *
   * The candidate and the application are still created - throwing away
   * a real application because one field is absent is the worst possible
   * answer - but no portal account can be made without an address, so
   * the message is flagged for a recruiter to complete rather than
   * marked done.
   */
  //
  // The candidates table requires an email address, so there is no
  // halfway house: without one the person cannot be created at all.
  // Rather than failing with a constraint error nobody can act on, the
  // message is handed to a recruiter with the reason stated - and the
  // parsed details are kept on the row so they only have to add the
  // address, not retype the application.
  if (!c.email) {
    return finish('needs_review',
      'Candidate email missing. Manual verification required - add an address to import this application.');
  }

  const warnings = [];

  /* ---- the person ------------------------------------------------- */
  const found = await withUser(ENGINE, async (cl) => {
    const digits = String(c.phone || '').replace(/\D/g, '');
    const { rows } = await cl.query(
      `select * from candidates
        where ($1 <> '' and lower(email) = $1)
           or ($2 <> '' and length($2) >= 10
               and right(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'), 10) = right($2, 10))
        order by case when lower(email) = $1 then 0 else 1 end
        limit 1`,
      [String(c.email || '').toLowerCase(), digits]);
    return rows[0] || null;
  });

  let candidateId = found ? found.id : null;
  let candidateIsNew = false;

  if (found) {
    // Fill gaps only. The profile in the database has usually been
    // through a human or a resume parse; an email template has not.
    await withUser(ENGINE, async (cl) => {
      const sets = [];
      const vals = [];
      const fill = (col, v, cast) => {
        if (v === undefined || v === null || v === '') return;
        vals.push(v);
        sets.push(`${col} = coalesce(nullif(${col}::text,''), $${vals.length})${cast || ''}`);
      };
      fill('email', c.email && c.email.toLowerCase());
      fill('phone', c.phone);
      fill('location', c.location);
      fill('preferred_location', c.preferredLocation);
      fill('title', c.title);
      fill('current_company', c.currentCompany);
      fill('education', c.education);
      fill('notice_period', c.noticePeriod);
      fill('exp', c.experience);
      if (c.expYears) {
        vals.push(c.expYears);
        sets.push(`exp_years = coalesce(exp_years, $${vals.length}::numeric)`);
      }
      if ((c.skills || []).length) {
        vals.push(c.skills);
        sets.push(`skills = case when coalesce(array_length(skills,1),0)=0
                                 then $${vals.length}::text[] else skills end`);
      }
      if (sets.length) {
        vals.push(found.id);
        await cl.query(`update candidates set ${sets.join(', ')}, updated_at = now()
                         where id = $${vals.length}`, vals);
      }
    });
  } else {
    candidateId = newId('cand');
    candidateIsNew = true;
    await withUser(ENGINE, (cl) => cl.query(
      // No `source` column here on purpose: where somebody came FROM is a
      // property of the application, not of the person. The same Rahul can
      // arrive from Naukri for one role and LinkedIn for another, and the
      // applications carry one source each.
      `insert into candidates
         (id, name, email, phone, location, preferred_location, title, current_company,
          exp, exp_years, ctc, expected_ctc, notice_period, education, skills,
          technical_skills, summary)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16)`,
      [candidateId, c.name, c.email || null, c.phone || null, c.location || null,
       c.preferredLocation || null, c.title || null, c.currentCompany || null,
       c.experience || null, c.expYears || null, c.currentCtc || null,
       null, c.noticePeriod || null, c.education || null, c.skills || [],
       c.summary || null]));
  }

  await withUser(ENGINE, (cl) => cl.query(
    `select app_event(null,$1,$2,$3,'system',$4::jsonb)`,
    [candidateId,
     candidateIsNew ? 'candidate.created' : 'candidate.matched',
     candidateIsNew
       ? `Candidate profile created automatically from a Naukri email`
       : `Existing candidate matched - no duplicate profile created`,
     JSON.stringify({ messageId: message.messageId, source: 'naukri' })]));

  /* ---- the requirement -------------------------------------------- */
  const jobs = await withUser(ENGINE, async (cl) => (await cl.query(
    `select j.*, co.name as company_name from jobs j
       left join companies co on co.id = j.company_id
      where j.status = 'open' and not j.paused and not j.archived limit 500`)).rows);

  const match = matchRequirement(
    c,
    jobs.map((j) => ({
      ...toJob(j), companyName: j.company_name, status: 'open',
      recruiterId: j.recruiter_id, createdAt: j.created_at, publishedAt: j.published_at,
    })),
    { preferRecruiterId: mailbox.recruiter_id || null });

  if (!match.job) {
    // The candidate is kept. The application waits for a human to say
    // which requirement it belongs to, because putting somebody in front
    // of the wrong client is not a recoverable mistake.
    return finish('needs_mapping',
      `Applied role could not be identified - ${match.why}. Map it to a requirement to continue.`,
      { candidateId });
  }

  /* ---- the application -------------------------------------------- */
  const existingApp = await withUser(ENGINE, async (cl) => (await cl.query(
    `select * from applications where candidate_id=$1 and job_id=$2`,
    [candidateId, match.job.id])).rows[0]);

  if (existingApp) {
    return finish('duplicate',
      `This candidate already has an application for ${match.job.title} (${existingApp.reference}).`,
      { candidateId, applicationId: existingApp.id, reference: existingApp.reference });
  }

  const applicationId = newId('app');

  // The pipeline shows an AI match percentage for every application. An
  // imported one with no score renders as "undefined%", so it is scored
  // here with the same engine the job alerts use - against the candidate
  // as the email described them, which is all anybody knows yet.
  const scored = await withUser(ENGINE, async (cl) => {
    const row = (await cl.query(`select * from candidates where id=$1`, [candidateId])).rows[0];
    if (!row) return null;
    try {
      return matchCandidate(
        { ...toJob(match.job), companyName: match.job.company_name },
        toCandidate(row));
    } catch (err) {
      console.error('[intake] could not score the match:', err.message);
      return null;
    }
  });

  const application = await withUser(ENGINE, async (cl) => {
    await cl.query(
      `insert into applications
         (id, job_id, candidate_id, recruiter_id, stage, source, import_method,
          source_message_id, imported_by, imported_at, resume_path, match_score)
       values ($1,$2,$3,$4,'applied','naukri','recruiter_email',$5,$6,now(),$7,$8)`,
      [applicationId, match.job.id, candidateId, mailbox.recruiter_id || null,
       message.messageId, mailbox.recruiter_id || null, c.resumeName || null,
       scored ? scored.score : null]);
    return (await cl.query(`select * from applications where id=$1`, [applicationId])).rows[0];
  });

  const reference = application.reference;

  await withUser(ENGINE, (cl) => cl.query(
    `select app_event($1,$2,'application.created',$3,'system',$4::jsonb)`,
    [applicationId, candidateId,
     `Application ${reference} created for ${match.job.title} from a Naukri email`,
     JSON.stringify({
       messageId: message.messageId, from: message.from, subject: message.subject,
       receivedAt: message.receivedAt, source: 'naukri', matchedBy: match.why,
       resume: c.resumeName || null,
     })]));

  /* ---- the portal account ----------------------------------------- */
  let credentials = null;
  if (c.email) {
    const password = temporaryPassword();
    const hash = await hashPassword(password);
    const account = await withUser(ENGINE, async (cl) => (await cl.query(
      `select candidate_portal_account($1,$2,$3) as out`,
      [candidateId, c.email, hash])).rows[0].out);

    if (account.created) {
      credentials = { email: c.email, password };
      await withUser(ENGINE, (cl) => cl.query(
        `select app_event($1,$2,'portal.account_created',$3,'system','{}'::jsonb)`,
        [applicationId, candidateId, 'Candidate portal account created']));
    } else {
      await withUser(ENGINE, (cl) => cl.query(
        `select app_event($1,$2,'portal.account_exists',$3,'system','{}'::jsonb)`,
        [applicationId, candidateId, `Portal account: ${account.reason}`]));
    }
  }

  /* ---- screen it, like any other application ----------------------- */
  try {
    await screenApplication(applicationId, { actor: 'system' });
  } catch (err) {
    console.error('[intake] screening failed:', err.message);
  }

  /* ---- tell the candidate ------------------------------------------ */
  const delivery = await notifyCandidate({
    candidate: { id: candidateId, name: c.name, email: c.email, phone: c.phone },
    job: match.job,
    applicationId,
    reference,
    credentials,
  });

  await withUser(ENGINE, (cl) => cl.query(
    `select app_event($1,$2,'candidate.notified',$3,'system',$4::jsonb)`,
    [applicationId, candidateId,
     `Registration message sent - ${Object.entries(delivery)
       .map(([ch, st]) => `${ch}: ${st}`).join(', ')}`,
     JSON.stringify(delivery)]));

  if (warnings.length) {
    await withUser(ENGINE, (cl) => cl.query(
      `select app_event($1,$2,'import.needs_attention',$3,'system','{}'::jsonb)`,
      [applicationId, candidateId, warnings.join(' ')]));
  }

  // Imported either way; `needs_review` means a human has something to
  // finish, not that the import failed.
  return finish(
    warnings.length ? 'needs_review' : 'processed',
    warnings.length
      ? `${warnings.join(' ')} Application ${reference} for ${match.job.title} was still created.`
      : `${candidateIsNew ? 'Candidate created' : 'Existing candidate'}, application ${reference} for ${match.job.title}`,
    { candidateId, applicationId, reference, delivery, credentialsIssued: !!credentials });
}

/* ------------------------------------------------------------------ *
 * the message to the candidate
 * ------------------------------------------------------------------ */

async function notifyCandidate({ candidate, job, applicationId, reference, credentials }) {
  const base = config.publicOrigin.replace(/\/$/, '');
  const portalUrl = `${base}/#/login/candidate`;

  const messages = buildEventMessages('APPLICATION_IMPORTED', {
    candidateName: candidate.name,
    jobTitle: job.title,
    company: job.company_name || job.companyName || 'TeamLink Consultants',
    jobId: job.id,
    applicationId,
    reference,
    portalUrl,
    linkLabel: 'Open the candidate portal',
    loginEmail: credentials ? credentials.email : null,
    tempPassword: credentials ? credentials.password : null,
    smsLead: `Your application for ${job.title} is registered. Ref ${reference}. `
           + 'Log in to complete your profile:',
  });

  const status = {};
  for (const channel of ['email', 'sms', 'whatsapp']) {
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
            job_title: job.title,
            company_name: job.company_name || job.companyName || '',
            application_id: reference,
            portal_link: portalUrl,
            interview_link: portalUrl,
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
    status[channel] = result.status;

    await withUser(ENGINE, (c) => c.query(
      `select record_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),null)`,
      [applicationId, candidate.id, job.id, channel, result.status, to || null,
       result.provider || null, result.ref || null, result.error || null]))
      .catch((err) => console.error('[intake] delivery not recorded:', err.message));
  }

  // The in-app notification, so it is on their portal the moment they
  // log in even if every outbound channel failed.
  await withUser(ENGINE, (c) => c.query(
    `select notify_create($1,$2,'candidate','APPLICATION_IMPORTED',$3,$4,$5,$6,$7,null,$8::jsonb)`,
    [newId('ntf'), candidate.id, 'Your application has been registered',
     `Application ${reference} for ${job.title}. Complete your profile to continue.`,
     job.id, applicationId, candidate.id, JSON.stringify({ reference })]))
    .catch(() => {});

  return status;
}

/* ------------------------------------------------------------------ *
 * a sync
 * ------------------------------------------------------------------ */

/**
 * Read one mailbox and process whatever is new.
 *
 * Every message is RECORDED before it is judged, so a crash half way
 * through cannot cause a re-import, and a message that fails to process
 * is marked failed rather than left to be retried forever.
 */
export async function syncMailbox(session, mailboxId, { since, limit = 50 } = {}) {
  const mailbox = await withUser(ENGINE, async (c) =>
    (await c.query(`select * from email_mailboxes where id=$1`, [mailboxId])).rows[0]);
  if (!mailbox) throw new Error('no such mailbox');

  const ready = mailboxReadiness(mailbox);
  if (!ready.ready) {
    await withUser(ENGINE, (c) => c.query(`select mailbox_synced($1,$2)`,
      [mailboxId, `Not configured: set ${ready.missing.join(', ')}`]));
    return {
      mailbox: mailbox.address, provider: mailbox.provider,
      error: 'not_configured', missing: ready.missing,
      seen: 0, imported: 0, results: [],
    };
  }

  const provider = mailboxProvider(mailbox.provider);
  let fetched;
  try {
    fetched = await provider.fetchNew(mailbox, {
      since: since || mailbox.last_sync_at || new Date(Date.now() - 7 * 86400000),
      limit,
    });
  } catch (err) {
    await withUser(ENGINE, (c) => c.query(`select mailbox_synced($1,$2)`, [mailboxId, err.message]));
    return {
      mailbox: mailbox.address, provider: mailbox.provider,
      error: err.code || 'fetch_failed', message: err.message,
      seen: 0, imported: 0, results: [],
    };
  }

  const results = [];
  let imported = 0;

  for (const message of fetched) {
    const rowId = newMessageId();
    let stored;
    try {
      stored = await withUser(ENGINE, async (c) => (await c.query(
        `select email_message_seen($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as id`,
        [rowId, mailboxId, message.messageId, message.from, message.to, message.subject,
         message.receivedAt, String(message.text || '').slice(0, 2000),
         String(message.raw || message.text || ''), !!message.hasAttachment,
         message.attachmentName || null])).rows[0].id);
    } catch (err) {
      results.push({ messageId: message.messageId, status: 'failed', reason: err.message });
      continue;
    }

    // Seen before: the unique index handed back the existing row.
    if (stored !== rowId) {
      const prior = await withUser(ENGINE, async (c) => (await c.query(
        `select status, reason from email_messages where id=$1`, [stored])).rows[0]);
      if (prior && prior.status !== 'new') {
        results.push({
          messageId: message.messageId, status: 'already_processed',
          reason: prior.reason || `already ${prior.status}`,
        });
        continue;
      }
    }

    try {
      const out = await processMessage(session, { mailbox, message, rowId: stored });
      if (out.status === 'processed') imported++;
      results.push({ messageId: message.messageId, subject: message.subject, ...out });
    } catch (err) {
      console.error('[intake] message failed:', err.message);
      await withUser(ENGINE, (c) => c.query(
        `select email_message_result($1,'failed',$2,null,null,null)`,
        [stored, err.message])).catch(() => {});
      results.push({ messageId: message.messageId, status: 'failed', reason: err.message });
    }
  }

  await withUser(ENGINE, (c) => c.query(`select mailbox_synced($1,null)`, [mailboxId]));

  return {
    mailbox: mailbox.address,
    provider: mailbox.provider,
    seen: fetched.length,
    imported,
    needsMapping: results.filter((r) => r.status === 'needs_mapping').length,
    needsReview: results.filter((r) => r.status === 'needs_review').length,
    ignored: results.filter((r) => r.status === 'ignored').length,
    duplicates: results.filter((r) => r.status === 'duplicate' || r.status === 'already_processed').length,
    results,
  };
}

/** Every mailbox with auto-sync on. Used by the scheduler and by "Sync now". */
export async function syncAll(session, { onlyAuto = true } = {}) {
  const boxes = await withUser(ENGINE, async (c) => (await c.query(
    `select id from email_mailboxes ${onlyAuto ? 'where auto_sync' : ''} order by created_at`)).rows);

  const out = [];
  for (const b of boxes) {
    try {
      out.push(await syncMailbox(session, b.id));
    } catch (err) {
      out.push({ mailboxId: b.id, error: 'sync_failed', message: err.message });
    }
  }
  return out;
}

/**
 * The recruiter said which requirement an unmapped email belongs to.
 * Everything after the mapping is the same path a matched email takes.
 */
export async function mapMessage(session, { messageId, jobId, actor }) {
  const row = await withUser(ENGINE, async (c) => (await c.query(
    `select m.*, b.recruiter_id, b.rules, b.address
       from email_messages m left join email_mailboxes b on b.id = m.mailbox_id
      where m.id = $1`, [messageId])).rows[0]);
  if (!row) throw new Error('no such message');
  if (row.status === 'processed') throw new Error('that email has already been imported');

  const message = {
    messageId: row.message_id, from: row.from_address, to: row.to_address,
    subject: row.subject, text: row.raw, raw: row.raw,
    receivedAt: row.received_at, attachmentName: row.attachment_name,
    hasAttachment: row.has_attachment,
  };

  // The recruiter's choice replaces the matcher's opinion: the parsed
  // role is overridden with this requirement's exact title.
  const job = await withUser(ENGINE, async (c) => (await c.query(
    `select j.*, co.name as company_name from jobs j
       left join companies co on co.id = j.company_id where j.id = $1`, [jobId])).rows[0]);
  if (!job) throw new Error('no such requirement');

  const mailbox = {
    id: row.mailbox_id, address: row.address, recruiter_id: row.recruiter_id,
    rules: row.rules || {},
  };

  // Re-run the pipeline with the role forced, so one code path creates
  // applications however the requirement was decided.
  const forced = { ...message, text: `${message.text}\nApplied Role: ${job.title}` };
  const out = await processMessage(session, { mailbox, message: forced, rowId: messageId });

  if (out.applicationId) {
    await withUser(ENGINE, (c) => c.query(
      `select app_event($1,$2,'application.mapped',$3,$4,'{}'::jsonb)`,
      [out.applicationId, out.candidateId,
       `Mapped to ${job.title} by a recruiter`, actor || 'recruiter']));
  }
  return out;
}
