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
import { mailboxProvider, mailboxReadiness, newMessageId,
         mailboxSecrets, credentialFingerprint, isAuthFailure } from './mailbox.js';
import { looksLikeDigest, parseNaukriDigest } from './naukri.js';
import { looksLikeNvite, parseNvite } from './nvite.js';
import { looksLikeShine, parseShine } from './shine.js';
import { extractResumeText } from '../resume/extract.js';
import { extractFields } from '../resume/fields.js';
import { detectSource, rulesFor, wantedBy } from './source.js';
import { storeAttachedResume } from './attachment.js';
// For re-reading a message out of the database, where all that was kept
// is the raw MIME the server sent.
import { bodyOf, attachmentsOf } from './mime.js';

/**
 * The fields inside an attached CV.
 *
 * Both boards now hide the candidate's email address and phone number
 * behind a login - Naukri behind "View Contact Details", Shine behind
 * its own - so the MESSAGE genuinely carries neither, and the attached
 * CV is the only place they exist. Reading it is what makes these
 * candidates contactable at all; without it every one of them lands as
 * "nothing to contact them on".
 *
 * A CV that cannot be read is not a failure worth losing the candidate
 * over. The file is still stored and the person is still created - a
 * name and a role in front of a recruiter beats nothing.
 */
async function fieldsFromAttachedCv(message) {
  const files = message.attachments || [];
  if (!files.length) return {};
  try {
    const doc = await extractResumeText(files[0].buffer, files[0].filename);
    return extractFields(doc.text).fields || {};
  } catch (err) {
    console.error('[intake] the attached CV could not be read:', err.message);
    return {};
  }
}

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** The identity the importer runs as: it must see every candidate. */
const ENGINE = { userId: '', role: 'admin', profileId: null };

/* ------------------------------------------------------------------ *
 * the requirement nobody posted yet
 * ------------------------------------------------------------------ */

/**
 * Is this string a job title, or is it something else the parser found?
 *
 * The role comes off a job board's own email - "Radiologist", "Duty
 * Doctor", "Staff Nurse" - and is usually exactly what a requirement
 * would be called. Usually is not always, and a requirement created from
 * a misread line is worse than none: it appears in the recruiter's list,
 * in their reports, and in the dropdown they map future candidates with.
 *
 * So this refuses anything that does not look like a title: too long or
 * too short, a whole sentence, an address, or one of the words a board
 * writes when it means "nothing here".
 */
const NOT_A_ROLE = new Set([
  'not mentioned', 'not specified', 'none', 'n/a', 'na', 'other', 'others',
  'various', 'multiple', 'any', 'unknown', 'job title blank', 'blank',
]);

export function roleTitle(raw) {
  let t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  // A board's phrasing, not part of the job: "Hiring for an OBGY".
  t = t.replace(/^hiring\s+for\s+/i, '').replace(/^(an?|the)\s+/i, '').trim();
  t = t.replace(/[.,;:]+$/, '').trim();
  if (t.length < 2 || t.length > 80) return '';
  if (NOT_A_ROLE.has(t.toLowerCase())) return '';
  if (/[@]|https?:\/\//i.test(t)) return '';          // an address, not a role
  if ((t.match(/[A-Za-z]/g) || []).length < 2) return '';
  if (t.split(' ').length > 8) return '';               // a sentence
  return t;
}

/**
 * The requirement this person applied to, created if it does not exist.
 *
 * WHY THIS EXISTS. A board tells us the role a candidate answered -
 * Shine sends seventeen responses for "Radiologist", "Duty Doctor" and
 * "OBGY" - and if the recruiter has not posted a requirement with that
 * name there is nothing to attach the application to. Every one of those
 * candidates stopped in the queue saying "no requirement matches
 * Radiologist", which is true and leaves fifteen real people parked
 * behind a piece of admin.
 *
 * IT IS CREATED AS A DRAFT, and that is the important part. A job with
 * status 'open' is readable by the public policy - it would appear on
 * the job board, live, because somebody applied to it. Nothing here
 * should publish a posting. A draft is visible to the recruiter and to
 * admin, applications attach to it and show in their lists, and
 * publishing it stays a decision a person makes.
 *
 * An existing requirement always wins, whatever its status, so a second
 * Radiologist joins the first rather than creating another.
 */
export async function requirementForRole(role, mailbox) {
  const title = roleTitle(role);
  if (!title) return null;

  const recruiterId = mailbox && mailbox.recruiter_id ? mailbox.recruiter_id : null;

  return withUser(ENGINE, async (c) => {
    const owner = recruiterId
      ? (await c.query(`select id, company_id from recruiters where id=$1`, [recruiterId])).rows[0]
      : null;
    const companyId = owner ? owner.company_id : null;

    /*
     * Matched on the title, case and spacing ignored, within the company
     * that would own it. Archived ones are skipped - somebody put those
     * away deliberately - but a draft or a closed one is the same
     * requirement and is reused.
     */
    const found = (await c.query(
      `select j.*, co.name as company_name from jobs j
         left join companies co on co.id = j.company_id
        where lower(btrim(j.title)) = lower(btrim($1))
          and not j.archived
          and ($2::text is null or j.company_id = $2 or j.company_id is null)
        order by (j.status = 'open') desc, j.created_at asc
        limit 1`, [title, companyId])).rows[0];
    if (found) return { job: found, created: false };

    const id = newId('j');
    await c.query(
      `insert into jobs (id, title, company_id, recruiter_id, status, source,
                         openings, description)
       values ($1,$2,$3,$4,'draft','intake',1,$5)`,
      [id, title, companyId, recruiterId,
       'Created automatically because a candidate applied for this role and no '
       + 'requirement existed for it. Add the details and publish it when you are ready.']);

    const job = (await c.query(
      `select j.*, co.name as company_name from jobs j
         left join companies co on co.id = j.company_id where j.id=$1`, [id])).rows[0];
    return { job, created: true };
  });
}

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
export async function processMessage(session, { mailbox, message, rowId, provider }) {
  /*
   * Which board sent it, before anything else is decided.
   *
   * The rules were Naukri's alone - its sender domains, its subject
   * wording, its keywords - so a Shine response scored too low to be
   * looked at and was filed as "not an application". A recruiter using
   * both boards saw half their candidates.
   */
  const source = detectSource(message);
  const rules = rulesFor(source, { ...DEFAULT_RULES, ...(mailbox.rules || {}) });

  // "Sync Shine" means Shine. A Naukri email is left exactly as it was,
  // unread, for the sync that wants it.
  if (!wantedBy(provider, source)) {
    return { status: 'skipped', reason: 'not this provider', skipped: true };
  }

  const parsed = parseMessage(message, rules);

  const finish = async (status, reason, extra = {}) => {
    await withUser(ENGINE, (c) => c.query(
      `select email_message_result($1,$2,$3,$4::jsonb,$5,$6)`,
      [rowId, status, reason, JSON.stringify({ ...parsed, ...(extra.parsed || {}) }),
       extra.candidateId || null, extra.applicationId || null]));
    return { status, reason, ...extra };
  };

  /*
   * Naukri's daily digest, which is most of what actually arrives.
   *
   * It is not one application per email: it is a summary carrying the
   * top few candidates for one requirement, and the single-candidate
   * parser below finds no labelled block in it. Every one of them used
   * to end as "no candidate name could be read" - 87 real applications
   * saying nothing useful.
   *
   * Handled first, because a digest that also happens to satisfy the
   * single-candidate parser would otherwise import one person and
   * silently drop the rest.
   */
  if (looksLikeDigest(message.text || message.raw || '')) {
    // `raw` so the parser can find the link to the full response list -
    // the one the email itself labels "View all 426 responses".
    const digest = parseNaukriDigest(message.text || '',
      { subject: message.subject, raw: message.raw });
    if (digest.candidates.length) {
      return importDigest(session, { mailbox, message, rowId, digest, finish, source });
    }
  }

  /*
   * NAUKRI'S NVITE RESPONSE: one applicant, with their CV attached.
   *
   * This is the email that matters most and it was being discarded.
   * Fifteen of them sat in the mailbox marked "No candidate name could
   * be read from this email" - every one a real person, every one with a
   * resume on the message - because NVite writes its labels on their own
   * line and the labelled-block reader is looking for a colon.
   *
   * THE RESUME IS READ FIRST, and that is the point rather than a
   * detail. Naukri now hides the email address and the phone number
   * behind a "View Contact Details" link, so the MESSAGE genuinely has
   * neither - but the attached CV has both. Reading it before the
   * candidate is created is what makes them contactable at all; without
   * it every one of these would land as "nothing to contact them on".
   */
  if (looksLikeNvite(message)) {
    const nv = parseNvite(message);
    if (nv && nv.name) {
      const fromCv = await fieldsFromAttachedCv(message);

      /*
       * The EMAIL's facts win over the CV's where both have one - Naukri
       * knows which role this application is for and the CV does not -
       * and the CV supplies what the email is not allowed to carry.
       */
      parsed.isApplication = true;
      parsed.why = 'NVite response';
      parsed.candidate = {
        ...parsed.candidate,
        name: nv.name,
        email: fromCv.email || '',
        phone: fromCv.phone || fromCv.altPhone || '',
        appliedRole: nv.appliedRole || (parsed.candidate || {}).appliedRole || '',
        location: nv.location || fromCv.location || '',
        preferredLocation: nv.preferredLocation || fromCv.preferredLocation || '',
        experience: nv.experience || fromCv.expYears || '',
        noticePeriod: nv.noticePeriod || fromCv.noticePeriod || '',
        education: nv.education || fromCv.education || '',
        currentCompany: fromCv.currentCompany || '',
        skills: (nv.skills && nv.skills.length ? nv.skills : (fromCv.skills || [])),
      };
    }
  }

  /*
   * SHINE'S EMAIL RESPONSE: one applicant, with their CV attached.
   *
   * source.js carried Shine's shapes for months marked
   * `verified: false` - "no Shine message has been seen yet" - and that
   * was wrong. Seventeen of them were in the mailbox, every one a real
   * person with a resume on the message, every one recorded as "No
   * candidate name could be read from this email". They were never
   * detected because the name in a Shine response is not labelled: it
   * sits on a bare line under a single-letter avatar, and the
   * labelled-block reader has nothing to look for.
   *
   * The CV is read first, for the same reason it is under NVite: Shine
   * keeps the contact details behind a login and the attachment does
   * not.
   */
  /*
   * NO `!parsed.isApplication` GUARD HERE, and that was a real bug.
   *
   * Teaching source.js the words Shine actually sends made the classifier
   * score these AS applications - correctly - and a branch that only ran
   * when the classifier had given up therefore never ran at all. All
   * seventeen went on reporting "No candidate name could be read from
   * this email" with the parser that could read them sitting one line
   * away. A message that looks like Shine is read by the Shine reader
   * whatever the generic classifier already thinks of it.
   */
  if (looksLikeShine(message)) {
    const sh = parseShine(message);
    if (sh && sh.name) {
      const fromCv = await fieldsFromAttachedCv(message);

      /*
       * Shine's facts win where both have one - Shine knows which of the
       * recruiter's own postings this answers and the CV cannot - and
       * the CV supplies what the message is not allowed to carry.
       */
      parsed.isApplication = true;
      parsed.why = 'Shine email response';
      parsed.candidate = {
        ...parsed.candidate,
        name: sh.name,
        email: fromCv.email || '',
        phone: fromCv.phone || fromCv.altPhone || '',
        appliedRole: sh.appliedRole || (parsed.candidate || {}).appliedRole || '',
        location: sh.location || fromCv.location || '',
        preferredLocation: sh.preferredLocation || fromCv.preferredLocation || '',
        experience: sh.experience || fromCv.expYears || '',
        noticePeriod: fromCv.noticePeriod || '',
        education: sh.education || fromCv.education || '',
        // Shine's bare second line is the candidate's DESIGNATION -
        // "Ct & Mri Technician" - which is the `title` column, not the
        // employer. Writing it to currentCompany would put a job title
        // where the recruiter reads a company name.
        title: sh.title || fromCv.title || '',
        currentCompany: fromCv.currentCompany || '',
        skills: (sh.skills && sh.skills.length ? sh.skills : (fromCv.skills || [])),
      };
    }
  }

  if (!parsed.isApplication) {
    return finish('ignored', parsed.why);
  }

  const c = parsed.candidate;
  if (!c.name) {
    return finish('needs_review', 'No candidate name could be read from this email.');
  }
  /*
   * NO CONTACT DETAILS IS NOT A REASON TO THROW SOMEBODY AWAY.
   *
   * Two refusals used to stand here. One turned away anybody with
   * neither an email address nor a mobile; the other turned away anybody
   * without an email, on the stated grounds that "the candidates table
   * requires an email address". That has not been true since migration
   * 0034, which is titled "a candidate without an email address is still
   * a candidate" and was written for exactly this - Naukri's digest
   * carries names and no contact details at all, and fifty-five
   * candidates in this database have no email today.
   *
   * The single-candidate path never caught up. Two of Shine's seventeen
   * responses stopped here: real people, with real CVs attached, whose
   * contact details were unreadable because one CV is a photograph and
   * the other a scanned PDF. Shine's own email carries no address. So
   * they were not imported, their CVs were never stored - storing one
   * needs a candidate to attach it to - and the recruiter was left with
   * a filename in a queue and no way to open it.
   *
   * They are imported now. What cannot be done is still not done: no
   * portal account is created without an address, nothing is sent, and
   * the warning below says so on the message. A recruiter can open the
   * CV and read the number off it, which is the only way those two were
   * ever going to be reached.
   */
  const warnings = [];
  if (!c.email && !c.phone) {
    warnings.push('No email address or mobile number could be read from this email or the '
      + 'attached CV, so this candidate cannot be contacted automatically. Their resume is '
      + 'on the profile - open it to add the details.');
  } else if (!c.email) {
    warnings.push('No email address, so no portal account was created. Add one to invite them.');
  }

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
    if (rows[0]) return rows[0];

    /*
     * Nothing to match on. This is the same fall-back the digest import
     * has always used for people who arrive without contact details: the
     * name TOGETHER WITH where they are and who they work for. Name alone
     * would merge two different people who happen to share one, which is
     * common and unrecoverable - so all three have to agree, and a second
     * email about the same person finds them again instead of creating a
     * duplicate.
     */
    if (String(c.email || '').trim() || digits) return null;
    const { rows: byName } = await cl.query(
      `select * from candidates
        where lower(name) = lower($1)
          and coalesce(lower(location), '') = coalesce(lower($2), '')
          and coalesce(lower(current_company), '') = coalesce(lower($3), '')
        limit 1`,
      [c.name, c.location || '', c.currentCompany || '']);
    return byName[0] || null;
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
          technical_skills, summary, owner_recruiter_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$17)`,
      [candidateId, c.name, c.email || null, c.phone || null, c.location || null,
       c.preferredLocation || null, c.title || null, c.currentCompany || null,
       c.experience || null, c.expYears || null, c.currentCtc || null,
       null, c.noticePeriod || null, c.education || null, c.skills || [],
       c.summary || null,
       // Whoever's inbox it arrived in. Naukri writes to a recruiter's
       // own mailbox, so that recruiter is the one working the lead.
       mailbox.recruiter_id || null]));
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

  /*
   * NO REQUIREMENT FOR THIS ROLE? CREATE ONE.
   *
   * The board named the role this person applied to. If the recruiter has
   * not posted it, the application has nothing to attach to and the
   * candidate waits in the queue behind a piece of admin - fifteen of the
   * seventeen Shine responses stopped exactly there, for "Radiologist",
   * "Duty Doctor" and "OBGY".
   *
   * The requirement is created as a DRAFT: visible to the recruiter,
   * applications attach to it, and it is not on the public job board
   * until a person publishes it.
   *
   * Only when the role is a title worth creating. roleTitle() refuses a
   * sentence, an address, or a board's way of writing "nothing here",
   * because a requirement invented from a misread line ends up in the
   * recruiter's reports and in the dropdown they map future candidates
   * with.
   */
  let createdRequirement = false;
  if (!match.job) {
    const made = await requirementForRole(c.appliedRole, mailbox).catch((err) => {
      console.error('[intake] the requirement could not be created:', err.message);
      return null;
    });
    if (made && made.job) {
      match.job = {
        ...toJob(made.job), companyName: made.job.company_name, status: made.job.status,
        recruiterId: made.job.recruiter_id, createdAt: made.job.created_at,
        publishedAt: made.job.published_at,
      };
      match.why = made.created
        ? `no requirement existed for "${match.job.title}", so one was created as a draft`
        : `matched the existing "${match.job.title}" requirement`;
      createdRequirement = made.created;
    }
  }

  if (!match.job) {
    /*
     * THE CV IS STORED BEFORE THE QUESTION IS ASKED.
     *
     * The candidate is kept and the application waits for a human to say
     * which requirement it belongs to - putting somebody in front of the
     * wrong client is not a recoverable mistake. But the resume used to
     * be stored further down, after an application existed, so a message
     * that stopped here left the recruiter deciding which role this
     * person is for with no way to read their CV. Fifteen of the
     * seventeen Shine responses stop exactly here.
     *
     * There is no application to hang a timeline event on yet, which is
     * why this passes none; the file goes on the candidate, and the
     * event is written when the mapping creates the application.
     */
    const early = await storeAttachedResume({ candidateId, attachments: message.attachments });
    return finish('needs_mapping',
      `Applied role could not be identified - ${match.why}. Map it to a requirement to continue.`,
      { candidateId, resume: early.status === 'stored' ? early.filename : undefined });
  }

  /* ---- the application -------------------------------------------- */
  const existingApp = await withUser(ENGINE, async (cl) => (await cl.query(
    `select * from applications where candidate_id=$1 and job_id=$2`,
    [candidateId, match.job.id])).rows[0]);

  if (existingApp) {
    /*
     * THE CV STILL COMES IN, even though the application is not new.
     *
     * This returned here and nothing further ran, so a resume could never
     * catch up with an application that already existed. That is exactly
     * the case that needs it: a candidate imported before the attachment
     * could be read, or before the format was accepted at all - a
     * photographed CV was refused until this week - keeps the same
     * application forever and the file never arrives.
     *
     * storeAttachedResume() will not overwrite a resume already on file,
     * so a re-sync can only ever fill a gap.
     */
    const late = await storeAttachedResume({
      candidateId, applicationId: existingApp.id, attachments: message.attachments,
    });
    return finish('duplicate',
      `This candidate already has an application for ${match.job.title} (${existingApp.reference}).`
      + (late.status === 'stored' ? ` Their resume (${late.filename}) was added.` : ''),
      { candidateId, applicationId: existingApp.id, reference: existingApp.reference,
        resume: late.status === 'stored' ? late.filename : undefined });
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

  /*
   * THE BOARD THAT ACTUALLY SENT IT.
   *
   * This column was the literal string 'naukri' on every row. The
   * intake had worked out the real answer twenty lines into
   * processMessage - detectSource() reads it off the sender - and then
   * threw it away here, so seventeen candidates who came from Shine were
   * filed, displayed and reported as Naukri. A recruiter deciding which
   * board is worth paying for was reading a constant.
   *
   * 'naukri' stays the fallback for a message whose sender could not be
   * placed, because that is what this mailbox has always been for, and
   * an empty source is worse than a wrong one for anything that groups
   * by it.
   */
  const board = (source && source.id) || 'naukri';

  const application = await withUser(ENGINE, async (cl) => {
    await cl.query(
      `insert into applications
         (id, job_id, candidate_id, recruiter_id, stage, source, import_method,
          source_message_id, imported_by, imported_at, resume_path, match_score)
       values ($1,$2,$3,$4,'applied',$9,'recruiter_email',$5,$6,now(),$7,$8)`,
      [applicationId, match.job.id, candidateId, mailbox.recruiter_id || null,
       message.messageId, mailbox.recruiter_id || null, c.resumeName || null,
       scored ? scored.score : null, board]);
    return (await cl.query(`select * from applications where id=$1`, [applicationId])).rows[0];
  });

  const reference = application.reference;

  /*
   * A requirement that appeared by itself has to say where it came from.
   * A recruiter finding a draft "Radiologist" in their list tomorrow
   * should not have to guess who made it or why.
   */
  if (createdRequirement) {
    await withUser(ENGINE, (cl) => cl.query(
      `select app_event($1,$2,'requirement.created',$3,'system',$4::jsonb)`,
      [applicationId, candidateId,
       `The requirement "${match.job.title}" did not exist, so it was created as a `
       + `draft from this application. Publish it when you are ready.`,
       JSON.stringify({ jobId: match.job.id, title: match.job.title,
                        status: 'draft', from: (source && source.id) || 'intake' })]))
      .catch((err) => console.error('[intake] could not record the new requirement:', err.message));
  }

  await withUser(ENGINE, (cl) => cl.query(
    `select app_event($1,$2,'application.created',$3,'system',$4::jsonb)`,
    [applicationId, candidateId,
     `Application ${reference} created for ${match.job.title} from a ${
       (source && source.label) || 'Naukri'} email`,
     JSON.stringify({
       messageId: message.messageId, from: message.from, subject: message.subject,
       receivedAt: message.receivedAt, source: board,
       sourceLabel: (source && source.label) || 'Naukri',
       // Why this board and not another - the sender, usually - so a
       // wrong answer can be traced instead of argued about.
       sourceWhy: (source && source.why) || null,
       matchedBy: match.why,
       resume: c.resumeName || null,
     })]));

  /* ---- the resume that came with it -------------------------------- *
   * Before the screening, not after: the screening reads the resume,
   * and one that arrives a moment too late produces a score computed
   * from a name and a job title.
   */
  const resumeImport = await storeAttachedResume({
    candidateId, applicationId, attachments: message.attachments,
  });
  if (resumeImport.status === 'unreadable') {
    warnings.push(`An attached file (${resumeImport.filename}) could not be stored as a resume.`);
  }

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
    { candidateId, applicationId, reference, delivery,
      credentialsIssued: !!credentials, resume: resumeImport });
}

/* ------------------------------------------------------------------ *
 * the message to the candidate
 * ------------------------------------------------------------------ */


/**
 * Import every candidate in one Naukri digest.
 *
 * A digest is one email and several applicants, so one row in the queue
 * has to account for all of them. The result says how many were
 * imported, how many were already known and how many could not be
 * placed, rather than collapsing to a single status that is wrong for
 * most of them.
 *
 * WHAT IS NOT IN A DIGEST: an email address or a phone number. Naukri
 * keeps contact details behind the "View" link on their site. A missing
 * field leaves that column empty; it never rejects the candidate, since
 * throwing away a real application because one field is absent is the
 * worst available answer. What depends on an address degrades honestly:
 * no portal account is created, and every send records
 * `skipped_no_address` instead of pretending.
 */
/*
 * `source` is destructured here because the body uses it - and it was
 * not, so every digest that reached the line naming the board threw
 * "source is not defined" and the email was recorded as failed. Ten of
 * them, each one a summary carrying candidates nobody ever saw. The
 * caller has always passed it.
 */
async function importDigest(session, { mailbox, message, rowId, digest, finish, source }) {
  const jobs = await withUser(ENGINE, async (cl) => (await cl.query(
    `select j.*, co.name as company_name from jobs j
       left join companies co on co.id = j.company_id
      where j.status = 'open' and not j.paused and not j.archived limit 500`)).rows);

  const shaped = jobs.map((j) => ({
    ...toJob(j), companyName: j.company_name, status: 'open',
    recruiterId: j.recruiter_id, createdAt: j.created_at, publishedAt: j.published_at,
  }));

  /*
   * The digest names its requirement in the body - "87 candidates
   * applied to your job today / Human Resource Recruiter" - which is a
   * far better signal than guessing from a candidate's skills. It is
   * matched against the open requirements by title; if none matches, the
   * candidates are still created and the applications wait for a human,
   * because putting somebody in front of the wrong client is not a
   * recoverable mistake.
   */
  const wanted = String(digest.jobTitle || '').toLowerCase().trim();
  const job = wanted
    ? shaped.find((j) => String(j.title || '').toLowerCase().trim() === wanted)
      || shaped.find((j) => String(j.title || '').toLowerCase().includes(wanted))
      || shaped.find((j) => wanted.includes(String(j.title || '').toLowerCase().trim()))
    : null;

  const out = { imported: 0, duplicates: 0, unmapped: 0, candidates: [] };
  let firstCandidateId = null;
  let firstApplicationId = null;

  for (const person of digest.candidates) {
    /*
     * Finding somebody again without an address to match on.
     *
     * The usual keys - email, phone - are simply absent here, so the
     * match is the name together with where they are and who they work
     * for. Name alone would merge two different people who happen to
     * share one, which is common and unrecoverable.
     */
    const existing = await withUser(ENGINE, async (cl) => (await cl.query(
      `select * from candidates
        where lower(name) = lower($1)
          and coalesce(lower(location), '') = coalesce(lower($2), '')
          and coalesce(lower(current_company), '') = coalesce(lower($3), '')
        limit 1`,
      [person.name, person.location || '', person.currentCompany || ''])).rows[0]);

    let candidateId;
    if (existing) {
      candidateId = existing.id;
      out.duplicates++;
      // Fill the gaps, never overwrite: what is already on the profile
      // has usually been through a human, and a digest has not.
      await withUser(ENGINE, (cl) => cl.query(
        `update candidates set
            title = coalesce(nullif(title, ''), $2),
            exp = coalesce(nullif(exp, ''), $3),
            exp_years = coalesce(exp_years, $4),
            ctc = coalesce(nullif(ctc, ''), $5),
            notice_period = coalesce(nullif(notice_period, ''), $6),
            education = coalesce(nullif(education, ''), $7),
            preferred_location = coalesce(nullif(preferred_location, ''), $8),
            skills = case when coalesce(array_length(skills, 1), 0) = 0
                          then $9::text[] else skills end,
            updated_at = now()
          where id = $1`,
        [candidateId, person.title || null, person.experience || null,
         person.expYears, person.currentCtc || null, person.noticePeriod || null,
         person.education || null, person.preferredLocation || null,
         person.skills || []]));
    } else {
      candidateId = newId('cand');
      await withUser(ENGINE, (cl) => cl.query(
        `insert into candidates
           (id, name, email, phone, location, preferred_location, title,
            current_company, exp, exp_years, ctc, notice_period, education,
            skills, technical_skills, owner_recruiter_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15)`,
        [candidateId, person.name,
         // Absent in a digest. NULL rather than '' so every "do we have
         // an address" check gives the right answer.
         person.email || null, person.phone || null,
         person.location || null, person.preferredLocation || null,
         person.title || null, person.currentCompany || null,
         person.experience || null, person.expYears,
         person.currentCtc || null, person.noticePeriod || null,
         person.education || null, person.skills || [],
         mailbox.recruiter_id || null]));
      out.imported++;
    }

    firstCandidateId = firstCandidateId || candidateId;
    out.candidates.push({ id: candidateId, name: person.name, new: !existing });

    if (!job) { out.unmapped++; continue; }

    // One application per person per requirement, however many digests
    // mention them.
    const already = await withUser(ENGINE, async (cl) => (await cl.query(
      `select id from applications where candidate_id = $1 and job_id = $2 limit 1`,
      [candidateId, job.id])).rows[0]);
    if (already) { firstApplicationId = firstApplicationId || already.id; continue; }

    const applicationId = newId('app');
    // The board that sent the digest, for the same reason as above.
    const board = (source && source.id) || 'naukri';
    await withUser(ENGINE, (cl) => cl.query(
      `insert into applications
         (id, job_id, candidate_id, recruiter_id, stage, source, import_method,
          source_message_id, imported_by, imported_at)
       values ($1,$2,$3,$4,'applied',$7,'recruiter_email',$5,$6,now())`,
      [applicationId, job.id, candidateId, mailbox.recruiter_id || null,
       message.messageId, mailbox.recruiter_id || null, board]));

    firstApplicationId = firstApplicationId || applicationId;

    await withUser(ENGINE, (cl) => cl.query(
      `select app_event($1,$2,'application.created',$3,'system',$4::jsonb)`,
      [applicationId, candidateId,
       `Imported from a ${(source && source.label) || 'Naukri'} response summary`
         + ` received by ${mailbox.address}`,
       JSON.stringify({ source: (source && source.id) || 'naukri', digest: true,
                        subject: message.subject,
                        ofTotal: digest.totalResponses || undefined })]));

    /*
     * A resume, but only when it can be said WHOSE.
     *
     * A digest carries several people. One attached file against six
     * names cannot be attributed, and putting somebody else's CV on a
     * candidate is worse than having none: it is what gets sent to a
     * client. So the file is imported only where the digest names one
     * person, and is otherwise recorded, unattached, for a human.
     */
    if (digest.candidates.length === 1) {
      const got = await storeAttachedResume({
        candidateId, applicationId, attachments: message.attachments,
      });
      if (got.status === 'stored') out.resumes = (out.resumes || 0) + 1;
    }

    // Screened like any other application, so the recruiter sees a score
    // rather than a row that says only where it came from.
    try { await screenApplication(applicationId, { actor: 'system' }); }
    catch (err) { console.error('[intake] screening failed:', err.message); }
  }

  const unattributed = (message.attachments || []).length && digest.candidates.length > 1
    ? ` — ${message.attachments.length} attached file(s) could not be matched to one of the `
      + `${digest.candidates.length} candidates in this summary`
    : '';

  /*
   * Said in the summary, not only stored. A sync that reports "3
   * imported" about an email covering 426 responses is accurate and
   * misleading in the same breath.
   */
  const ofTotal = digest.totalResponses && digest.totalResponses > digest.candidates.length
    ? ` — this email listed ${digest.candidates.length} of ${digest.totalResponses}`
      + ' responses; the rest are on Naukri'
    : '';

  const summary = `${out.imported} imported, ${out.duplicates} already known`
    + (out.resumes ? `, ${out.resumes} with a resume` : '')
    + (out.unmapped ? `, ${out.unmapped} awaiting a requirement` : '')
    + unattributed
    + ofTotal
    + (digest.jobTitle ? ` — "${digest.jobTitle}"` : '')
    + (job ? '' : ' (no open requirement matches that title)');

  /*
   * The status is the one that describes MOST of what happened. A digest
   * where nothing could be placed is not "imported", and one where
   * everybody was already known is not "needs review".
   */
  const status = !job ? 'needs_mapping'
    : out.imported ? 'processed'
    : out.duplicates ? 'duplicate'
    : 'needs_review';

  return finish(status, summary, {
    candidateId: firstCandidateId,
    applicationId: firstApplicationId,
    parsed: {
      digest: true,
      jobTitle: digest.jobTitle,
      matchedJobId: job ? job.id : null,
      candidates: out.candidates,
      imported: out.imported,
      duplicates: out.duplicates,
      unmapped: out.unmapped,
      /*
       * WHAT THIS EMAIL DID NOT CONTAIN.
       *
       * The digest is a teaser: it names the top few and says "View all
       * 426 responses" with a link. Recording the two numbers and that
       * link is what lets the screen say "3 of 426 are here" instead of
       * showing three candidates and leaving a recruiter to assume that
       * was everyone who applied.
       */
      appliedCount: digest.appliedCount,
      totalResponses: digest.totalResponses,
      responsesUrl: digest.responsesUrl,
    },
  });
}

/**
 * Does the intake write to the candidates it imports?
 *
 * OFF UNLESS SOMEBODY TURNS IT ON, and that default is deliberate.
 *
 * An import is not a conversation the candidate started. These people
 * applied on Naukri or Shine; the first they hear from TeamLink is a
 * message saying their application is registered here, with portal
 * credentials. That may be exactly right - it is why the feature exists -
 * but it is an outward-facing action on somebody else's mailbox, and one
 * re-sync of a mailbox holding a hundred and fifty messages can write to
 * a hundred people in a minute.
 *
 * Sixty-nine real candidates were emailed that way during this work, by
 * repeated syncs run while the parsing was being fixed. Nothing about
 * fixing the parsing required writing to any of them.
 *
 * So the switch is off, and turning it on is a decision somebody makes:
 *
 *     INTAKE_NOTIFY_CANDIDATES=true
 *
 * With it off the candidate, the application, the resume and the
 * screening are all created exactly as before. The only thing that does
 * not happen is the outbound message, and it is recorded as paused with
 * the reason, so nobody later mistakes it for a delivery.
 */
function intakeMayNotify() {
  return String(process.env.INTAKE_NOTIFY_CANDIDATES || '').trim().toLowerCase() === 'true';
}

async function notifyCandidate({ candidate, job, applicationId, reference, credentials }) {
  if (!intakeMayNotify()) {
    return {
      email: 'not_configured', sms: 'not_configured', whatsapp: 'not_configured',
      paused: 'INTAKE_NOTIFY_CANDIDATES is not set, so imported candidates are not written to',
    };
  }
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
/**
 * The outcomes a second attempt is allowed to revisit.
 *
 * WHY THIS EXISTS. The sync records every message before it decides
 * anything, and a message it has already decided on is skipped forever -
 * which is right for a candidate who was imported and wrong for one it
 * could not read. Seventeen real Shine responses sat at
 * `needs_review` saying "No candidate name could be read from this
 * email", and when the parser that could read them was written there was
 * no way to point it at them: the sync saw them, said "already
 * processed", and moved on. The fix for the parser fixed nothing.
 *
 * WHY ONLY THESE THREE. Every one of them is a dead end where NOTHING
 * was created - all three `needs_review` returns happen before the
 * candidate row, `ignored` never gets that far, and `failed` threw.
 * There is nothing to duplicate by trying again.
 *
 * `needs_mapping` IS HERE NOW, and it was not before. The reasoning for
 * leaving it out was that it is "waiting on a recruiter's decision" - but
 * a message at needs_mapping has a candidate and NO application, and the
 * decision it waits on is which requirement to attach it to. Since the
 * intake can now create that requirement when a board names a role
 * nobody has posted, reconsidering these is the whole point: fifteen
 * Shine candidates sat there behind a requirement called "Radiologist"
 * that did not exist.
 *
 * Re-running one cannot fork a person: the candidate is found again by
 * email or mobile and updated, never created twice. It cannot duplicate
 * an application either - there is none yet, and the application insert
 * below checks for an existing one first.
 *
 * `duplicate` IS HERE TOO, for one reason: the resume. A message whose
 * application already exists used to stop before the attachment was
 * stored, so a CV could never catch up with a candidate imported before
 * it could be read - or before the format was accepted at all, which is
 * what kept a photographed CV out. Re-running one creates nothing: the
 * application is found, reported as a duplicate exactly as before, and
 * the only new thing that can happen is a resume filling an empty slot.
 *
 * `processed` and `updated` stay out. Those finished, and re-running
 * them would send the candidate their welcome message a second time.
 */
const RETRYABLE = new Set(['needs_review', 'ignored', 'failed', 'needs_mapping', 'duplicate']);

/**
 * How far back to fetch, and how much.
 *
 * An ordinary sync asks "what is new", so it starts at the last sync and
 * takes the newest fifty. A RETRY asks a different question - "look again
 * at what you could not read" - and the same window makes it useless: the
 * seventeen Shine responses were months old, the window since the last
 * sync was minutes wide, and a retry over it found seven messages, none
 * of them the ones that mattered.
 *
 * So the window is taken FROM THE RECORDS BEING RETRIED. The database
 * already knows the date of the oldest message still sitting at an
 * outcome where nothing was created; that date, less a day for IMAP's
 * date-only SINCE, is exactly how far back there is any point going.
 *
 * The limit rises with it, because a narrow limit re-creates the same
 * problem in the other direction: the provider keeps the NEWEST n of
 * whatever the search returns, so asking for three months of mail fifty
 * messages at a time returns three months of the most recent fifty and
 * drops the old failures again.
 */
async function fetchWindow(mailboxId, { since, limit, retry }) {
  const from = since || null;
  if (!retry) return { since: from, limit };

  const oldest = await withUser(ENGINE, async (c) => (await c.query(
    `select min(received_at) as at, count(*)::int as n
       from email_messages
      where mailbox_id = $1 and status = any($2)`,
    [mailboxId, [...RETRYABLE]])).rows[0]);

  if (!oldest || !oldest.at || !oldest.n) return { since: from, limit };

  const at = new Date(oldest.at);
  at.setUTCDate(at.getUTCDate() - 1);
  return {
    since: from && new Date(from) < at ? from : at,
    // Room for the retryable mail and everything that has arrived since.
    limit: Math.max(limit, oldest.n * 4, 200),
  };
}

export async function syncMailbox(session, mailboxId,
  // `board` is the JOB BOARD to sync - naukri, shine, or all. `provider`
  // below is the mailbox transport (imap/gmail), which is a different
  // thing entirely and was already using that name.
  // `retry` re-runs the pipeline over mail this reader has already given
  // up on. Off by default: an ordinary sync should not redo old work.
  { since, limit = 50, board = 'all', retry = false } = {}) {
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
      // A retry reaches back to the oldest message it has to reconsider;
      // an ordinary sync asks only for what is new. Both `since` and
      // `limit` come from here - spreading this after a plain `limit`
      // would let the narrow value win and undo the widening.
      ...(await fetchWindow(mailboxId, { since, limit, retry })),
    });
  } catch (err) {
    await withUser(ENGINE, (c) => c.query(`select mailbox_synced($1,$2)`, [mailboxId, err.message]));

    /*
     * A REFUSED CREDENTIAL is remembered, by fingerprint, so the timer
     * does not keep sending it. A server that simply did not answer is
     * not - that is a network problem and retrying is exactly right.
     */
    if (isAuthFailure(err)) {
      const mark = credentialFingerprint(mailbox.address, mailboxSecrets(mailbox.address).password);
      if (mark) {
        await withUser(ENGINE, (c) => c.query(
          `select mailbox_auth_refused($1,$2)`, [mailboxId, mark])).catch(() => {});
      }
    }

    return {
      mailbox: mailbox.address, provider: mailbox.provider,
      error: err.code || 'fetch_failed', message: err.message,
      seen: 0, imported: 0, results: [],
    };
  }

  // It answered, so whatever was remembered about a refusal is stale.
  await withUser(ENGINE, (c) => c.query(
    `select mailbox_auth_accepted($1)`, [mailboxId])).catch(() => {});

  const results = [];
  let imported = 0;
  let retried = 0;

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
      const retrying = retry && RETRYABLE.has(prior && prior.status);
      if (prior && prior.status !== 'new' && !retrying) {
        results.push({
          messageId: message.messageId, status: 'already_processed',
          reason: prior.reason || `already ${prior.status}`,
        });
        continue;
      }
      if (retrying) retried++;
    }

    try {
      const out = await processMessage(session, { mailbox, message, rowId: stored, provider: board });
      if (out.status === 'processed') imported++;
      // The board goes on the result so the summary can say how many of
      // each arrived, not just how many emails there were.
      results.push({ messageId: message.messageId, subject: message.subject,
                     source: (detectSource(message) || {}).id, ...out });
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
    retried,
    needsMapping: results.filter((r) => r.status === 'needs_mapping').length,
    needsReview: results.filter((r) => r.status === 'needs_review').length,
    ignored: results.filter((r) => r.status === 'ignored').length,
    duplicates: results.filter((r) => r.status === 'duplicate' || r.status === 'already_processed').length,
    results,
  };
}

/** Every mailbox with auto-sync on. Used by the scheduler and by "Sync now". */
export async function syncAll(session,
  { onlyAuto = true, board = 'all', retry = false } = {}) {
  const boxes = await withUser(ENGINE, async (c) => (await c.query(
    `select id, address, auth_refused_fingerprint
       from email_mailboxes ${onlyAuto ? 'where auto_sync' : ''} order by created_at`)).rows);

  const out = [];
  for (const b of boxes) {
    /*
     * A password the server has already refused is NOT sent again.
     *
     * This sweep runs on a timer, so without this a mailbox connected
     * with the wrong password attempted a login every few minutes for
     * as long as it stayed connected. Repeated failed logins are how
     * Google locks an account, and the account belongs to the recruiter.
     *
     * The fingerprint is of the credential, never the credential, so
     * changing it in the environment changes the mark and the next
     * sweep tries again by itself. "Sync now" is not affected: a person
     * pressing a button is asking on purpose.
     */
    if (onlyAuto && b.auth_refused_fingerprint) {
      const now = credentialFingerprint(b.address, mailboxSecrets(b.address).password);
      if (now && now === b.auth_refused_fingerprint) {
        out.push({
          mailboxId: b.id, mailbox: b.address, error: 'auth_refused',
          message: 'The mail server refused this credential. It will not be sent '
            + 'again until it is changed on the server.',
          seen: 0, imported: 0, results: [],
        });
        continue;
      }
    }

    try {
      out.push(await syncMailbox(session, b.id, { board, retry }));
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

  /*
   * THE STORED MESSAGE IS DECODED, not handed over as raw MIME.
   *
   * This used to pass `text: row.raw`, which is the whole message with
   * its headers, its multipart boundaries and its quoted-printable
   * encoding still on it, and no attachments at all. Two things followed
   * from that, and both were silent:
   *
   *   - the parsers re-read a body that does not look like a body. Shine
   *     and NVite both read line by line, and "Experience: 3 Yrs" wrapped
   *     as "Experience: 3=0D=0A Yrs" is not that line any more.
   *   - `attachments` was undefined, so storing the attached CV found
   *     nothing to store. A recruiter mapping a message to a requirement
   *     got the application and never got the resume - the one thing they
   *     had just read the candidate's details off.
   *
   * `raw` is kept as well, because the classifier uses it to look at
   * headers the body does not carry.
   */
  const body = bodyOf(row.raw);
  const attachments = attachmentsOf(row.raw);
  const message = {
    messageId: row.message_id, from: row.from_address, to: row.to_address,
    subject: row.subject,
    text: (typeof body === 'string' ? body : body.text) || row.raw,
    raw: row.raw,
    attachments,
    receivedAt: row.received_at,
    attachmentName: (attachments[0] && attachments[0].filename) || row.attachment_name,
    hasAttachment: attachments.length > 0 || row.has_attachment,
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
