/**
 * Message bodies, one per channel.
 *
 * Every channel is rendered from the SAME inputs in one call, so the job
 * id, the link and the expiry cannot drift between an SMS and an email.
 * That is a requirement, and it is also the kind of thing that quietly
 * breaks when each provider formats its own copy of the date.
 */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** "Fri 23 Sep, 6:30 PM" — readable, unambiguous, no locale surprises. */
function human(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  /*
   * A missing date must never reach a candidate as the word "undefined".
   *
   * It did: an invitation went out reading "Your AI interview for Java
   * Developer - due undefined", because the caller had not passed the
   * deadline and String(undefined) is a perfectly good string. "Soon" is
   * not as good as a date, but it is a sentence a person can read - and
   * the caller is the thing that actually needs fixing.
   */
  if (ts === undefined || ts === null || ts === '') return 'soon';
  if (Number.isNaN(d.getTime())) return 'soon';
  return d.toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'UTC',
  }) + ' UTC';
}

export function buildMessages({
  candidateName, jobTitle, company, jobId, interviewUrl, expiry, appliedAt,
}) {
  const name = String(candidateName || 'there').split(' ')[0];
  const when = human(expiry);

  // SMS is billed per segment and truncated by carriers, so it carries only
  // what a candidate needs to act: the role, the link, the deadline.
  const sms =
    `TeamLink: Your application for ${jobTitle} at ${company} is confirmed. ` +
    `Complete your AI interview by ${when}: ${interviewUrl}`;

  const whatsapp =
    `*TeamLink — Interview Invitation*\n\n` +
    `Hi ${name}, your application for *${jobTitle}* at *${company}* is confirmed.\n\n` +
    `*Your AI interview link:*\n${interviewUrl}\n\n` +
    `*Expires:* ${when}\n\n` +
    `*Before you start:*\n` +
    `• Find a quiet place with a stable connection\n` +
    `• Allow microphone and camera access when prompted\n` +
    `• It takes about 15 minutes — 10 questions, spoken answers\n` +
    `• Speak clearly; you cannot go back to a previous question\n\n` +
    `_Job ref: ${jobId}_`;

  const text =
    `Hi ${name},\n\n` +
    `Your application for ${jobTitle} at ${company} has been confirmed.\n\n` +
    `The next step is a short AI interview. It takes about 15 minutes and you ` +
    `can take it whenever suits you, as long as it is before the link expires.\n\n` +
    `Start your interview: ${interviewUrl}\n` +
    `This link expires on ${when}.\n\n` +
    `Before you begin:\n` +
    `  - Find somewhere quiet with a stable internet connection\n` +
    `  - Allow microphone and camera access when prompted\n` +
    `  - You will be asked 10 questions and answer out loud\n` +
    `  - You cannot return to a previous question, so take a moment before answering\n\n` +
    `Job reference: ${jobId}\n` +
    `Applied: ${human(appliedAt)}\n\n` +
    `— TeamLink Consultants`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f7fa">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fa;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #dde2ea;border-radius:10px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#141d2e">
        <tr><td style="padding:24px 26px 8px">
          <div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#4f46e5">TeamLink Consultants</div>
          <h1 style="margin:10px 0 0;font-size:20px;line-height:1.3">Your application is confirmed</h1>
        </td></tr>
        <tr><td style="padding:8px 26px 0;font-size:14px;line-height:1.6;color:#2c3648">
          <p style="margin:12px 0">Hi ${esc(name)},</p>
          <p style="margin:12px 0">
            We have received your application for
            <strong>${esc(jobTitle)}</strong> at <strong>${esc(company)}</strong>.
          </p>
          <p style="margin:12px 0">
            The next step is a short AI interview — about 15 minutes, taken whenever
            suits you before the link expires.
          </p>
        </td></tr>
        <tr><td style="padding:16px 26px" align="center">
          <a href="${esc(interviewUrl)}"
             style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 28px;border-radius:8px">
            Start your interview
          </a>
          <div style="margin-top:10px;font-size:12.5px;color:#5b6678">
            Expires <strong>${esc(when)}</strong>
          </div>
        </td></tr>
        <tr><td style="padding:4px 26px 0">
          <div style="background:#f6f7fa;border:1px solid #e2e7ee;border-radius:8px;padding:14px 16px">
            <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#5b6678;margin-bottom:8px">Before you begin</div>
            <ul style="margin:0;padding-left:18px;font-size:13.5px;line-height:1.7;color:#2c3648">
              <li>Find somewhere quiet with a stable internet connection</li>
              <li>Allow microphone and camera access when prompted</li>
              <li>You will be asked 10 questions and answer out loud</li>
              <li>You cannot return to a previous question</li>
            </ul>
          </div>
        </td></tr>
        <tr><td style="padding:18px 26px 24px;font-size:12px;color:#8a94a6;line-height:1.6">
          Job reference ${esc(jobId)} &middot; Applied ${esc(human(appliedAt))}<br>
          If the button does not work, paste this into your browser:<br>
          <span style="word-break:break-all;color:#5b6678">${esc(interviewUrl)}</span>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;

  // What Naukri shows inside the candidate's Applications / Messages view.
  const naukri =
    `Your application for ${jobTitle} at ${company} has been confirmed. ` +
    `Complete your AI interview before ${when}: ${interviewUrl} (Job ref ${jobId})`;

  return {
    sms,
    whatsapp,
    naukri,
    email: { subject: `Your interview for ${jobTitle} at ${company}`, text, html },
  };
}

/* ------------------------------------------------------------------ *
 * Every other event a candidate hears about
 *
 * One place, so the three channels cannot drift: an SMS that says
 * "shortlisted" and an email that says "under review" is worse than
 * sending nothing. Each message names the job, the job id and the
 * application id, because "your application" is useless to somebody who
 * applied to six roles.
 * ------------------------------------------------------------------ */

const SUBJECTS = {
  STAGE_CHANGED:          (c) => `Update on your application for ${c.jobTitle}`,
  INTERVIEW_SCHEDULED:    (c) => `Interview scheduled — ${c.jobTitle}`,
  AI_INTERVIEW_COMPLETED: (c) => `Your AI interview for ${c.jobTitle} is complete`,
  AI_SCORE_AVAILABLE:     (c) => `Your interview result for ${c.jobTitle}`,
  OFFER_EXTENDED:         (c) => `An offer for ${c.jobTitle}`,

  // No deadline in hand means no deadline in the subject line, rather
  // than a subject that reads "due soon" and says nothing at all.
  AI_INTERVIEW_INVITED:   (c) => `Your AI interview for ${c.jobTitle}`
    + (c.dueAt ? ` — due ${human(c.dueAt)}` : ''),
  AI_INTERVIEW_REMINDER:  (c) => `Reminder: your AI interview for ${c.jobTitle} closes tomorrow`,
  AI_INTERVIEW_FINAL:     (c) => `Last chance: your AI interview for ${c.jobTitle} closes in 2 hours`,
  AI_INTERVIEW_EXPIRED:   (c) => `Your AI interview window for ${c.jobTitle} has closed`,

  JOB_MATCH_ALERT:        (c) => `A ${c.jobTitle} role matching your profile`,
  AI_CALL_COMPLETED:      (c) => `AI call completed - ${c.candidateName}, ${c.jobTitle}`,
  APPLICATION_IMPORTED:   (c) => `Your application for ${c.jobTitle} - ${c.company}`,
  CANDIDATE_INVITED:      (c) => `Your ${c.company || 'TeamLink'} candidate portal login`,
};

const BODIES = {
  // Without a stage name this says the application has moved, which is
  // still true and still worth reading; naming a stage of "undefined" is
  // not.
  STAGE_CHANGED: (c) =>
    (c.stageLabel || c.stage
      ? `Your application for ${c.jobTitle} at ${c.company} has moved to "${c.stageLabel || c.stage}".`
      : `Your application for ${c.jobTitle} at ${c.company} has moved to the next stage.`)
    + (c.note ? `\n\nNote from the team: ${c.note}` : ''),

  INTERVIEW_SCHEDULED: (c) =>
    `Your interview for ${c.jobTitle} at ${c.company} is scheduled for `
    + `${human(c.scheduledAt) || 'a time the team will confirm'}`
    + (c.mode ? ` (${c.mode})` : '') + '.'
    + (c.interviewer ? `\n\nYou will be meeting ${c.interviewer}.` : ''),

  AI_INTERVIEW_COMPLETED: (c) =>
    `Your AI interview for ${c.jobTitle} at ${c.company} has been completed successfully `
    + `and submitted for review. You answered ${c.questionsAnswered ?? 'all'} of `
    + `${c.questionsAsked ?? 'the'} questions.`,

  AI_SCORE_AVAILABLE: (c) =>
    `Your AI interview for ${c.jobTitle} has been assessed.`
    // No number in hand means none is quoted. "Overall score: undefined%"
    // is worse than sending them to the page that has the real one.
    + (c.overall != null
      ? ` Overall score: ${c.overall}%`
        + (c.technical != null
          ? ` (technical ${c.technical}%, communication ${c.communication}%)` : '')
        + '.'
      : '')
    + '\n\nYou can see the full breakdown on your applications page.',

  OFFER_EXTENDED: (c) =>
    `${c.company} has extended an offer for ${c.jobTitle}.`
    + (c.ctc ? `\n\nOffered CTC: ${c.ctc}` : '')
    + (c.joiningDate ? `\nProposed joining date: ${human(c.joiningDate)}` : ''),

  /* ---- the AI interview and its two-day window -------------------- *
   *
   * Every one of these states the deadline in full. "Complete it soon"
   * is not a deadline, and a candidate who reads the reminder on the
   * train needs the date, not a countdown they have to compute.
   * ------------------------------------------------------------------ */

  AI_INTERVIEW_INVITED: (c) =>
    `Your application for ${c.jobTitle} at ${c.company} includes a short AI interview: `
    + '15 questions about your background, this role and your resume, taken in your browser.'
    + `\n\nIt must be completed by ${human(c.dueAt)}`
    + (c.dueAt ? ' — two days from now. ' : '. ')
    + 'You can take it at any time before then, and it takes about 20 minutes.',

  AI_INTERVIEW_REMINDER: (c) =>
    `You have not yet taken the AI interview for ${c.jobTitle} at ${c.company}.`
    + `\n\nThe window closes ${human(c.dueAt)} — about 24 hours from now. `
    + 'After that the application cannot move forward.',

  AI_INTERVIEW_FINAL: (c) =>
    `Final reminder: the AI interview for ${c.jobTitle} at ${c.company} closes `
    + `${human(c.dueAt)}, in about two hours.`
    + '\n\nIf you have started it, please finish it before then.',

  /* ---- a candidate imported from a job board ---------------------- *
   *
   * The one message in the system that carries credentials, so it is the
   * one that has to be careful: the password appears here and nowhere
   * else - not in a log, not in an API response, not in the recruiter's
   * view of the candidate. It is generated, sent once, and stored only as
   * a hash.
   *
   * Sections for values we do not have are omitted rather than printed
   * empty: "Notice Period: N/A" in a first contact reads as a broken
   * system.
   * ------------------------------------------------------------------ */
  /* ---- a candidate added to the database, with no application yet -- *
   *
   * Somebody imported from a spreadsheet is in the database and cannot
   * see themselves: no login, no way to correct what the file said about
   * them, and no idea they are on a recruiter's list at all. This is the
   * message that fixes that.
   *
   * It carries credentials, so it follows the same rule as the one
   * below: the password appears HERE and nowhere else - not in a log,
   * not in an API response, not in the recruiter's view of the
   * candidate. Generated, sent once, stored only as a hash.
   *
   * It promises nothing about a role. They have not applied for
   * anything, and a first message implying a live application would be
   * a lie the recruiter has to explain later.
   * ------------------------------------------------------------------ */
  CANDIDATE_INVITED: (c) => {
    const lines = [
      `Your profile has been added to the ${c.company || 'TeamLink'} candidate database`
        + `${c.addedBy ? ` by ${c.addedBy}` : ''}.`,
      '',
      'You can sign in to see what we hold about you, correct anything that is '
        + 'wrong, upload your current resume and set the roles and locations you '
        + 'want to hear about.',
    ];

    if (c.loginEmail && c.tempPassword) {
      lines.push(
        '',
        'Candidate Portal login:',
        `  Email: ${c.loginEmail}`,
        `  Temporary password: ${c.tempPassword}`,
        '',
        'You will be asked to choose your own password the first time you sign in.');
    } else if (c.loginEmail) {
      lines.push('', 'You already have a TeamLink account - sign in with your existing password.');
    }

    lines.push(
      '',
      'If you would rather not hear from us, reply to this message and we will '
        + 'remove you.');

    return lines.join('\n');
  },

  APPLICATION_IMPORTED: (c) => {
    const lines = [
      `Thank you for applying for the ${c.jobTitle} position.`,
      '',
      `We have received your application through ${c.sourceLabel || 'Naukri'} and it has been `
        + `registered with ${c.company}.`,
      '',
      ...(c.reference ? [`Application ID: ${c.reference}`] : []),
      `Applied Role: ${c.jobTitle}`,
    ];

    if (c.loginEmail && c.tempPassword) {
      lines.push(
        '',
        'Candidate Portal login:',
        `  Email: ${c.loginEmail}`,
        `  Temporary password: ${c.tempPassword}`,
        '',
        'Please log in and complete your profile. You will be asked to choose your own '
          + 'password the first time you sign in.');
    } else if (c.loginEmail) {
      lines.push('', 'You already have a TeamLink account - sign in with your existing password.');
    }

    lines.push(
      '',
      'Please verify and complete:',
      '  - Resume',
      '  - Total experience',
      '  - Current company and designation',
      '  - Current and expected CTC',
      '  - Notice period',
      '  - Preferred work mode and location',
      '  - Skills',
      '',
      // Named only when there is one to name.
      c.reference
        ? `Your Application ID ${c.reference} is used to track this application, your `
          + 'interview and the rest of the process. Quote it in any reply.'
        : 'Your Application ID is on your applications page, and is used to track this '
          + 'application, your interview and the rest of the process.');

    return lines.join('\n');
  },

  /* ---- what the AI calling agent found ---------------------------- *
   *
   * This one is addressed to the RECRUITER, not the candidate: it is the
   * hand-off at the end of a call, and it leads with the thing they have
   * to do rather than with the summary.
   * ------------------------------------------------------------------ */
  AI_CALL_COMPLETED: (c) =>
    `AI call completed for ${c.candidateName} - ${c.jobTitle}.`
    + (c.recruiterAction ? `

Action needed: ${c.recruiterAction}.` : '')
    + `

${c.summary || ''}`,

  /* ---- a new requirement that matches this profile ---------------- *
   *
   * Says WHY they were contacted, with the skills that matched. An alert
   * that cannot explain itself reads like spam, and the first thing a
   * candidate does with spam is stop reading everything we send.
   * ------------------------------------------------------------------ */
  JOB_MATCH_ALERT: (c) =>
    `A new ${c.jobTitle} opportunity at ${c.company} matches your profile.`
    + `\n\nRole: ${c.jobTitle}`
    + (c.location ? `\nLocation: ${c.location}` : '')
    + (c.expLabel ? `\nExperience: ${c.expLabel}` : '')
    + (c.payLabel ? `\nCompensation: ${c.payLabel}` : '')
    + (c.matchedSkills && c.matchedSkills.length
        ? `\n\nWe matched you on: ${c.matchedSkills.join(', ')}.` : '')
    + '\n\nIf it interests you, open it and apply — your saved profile and '
    + 'resume are used, so it takes one click.',

  AI_INTERVIEW_EXPIRED: (c) =>
    `The window to take the AI interview for ${c.jobTitle} at ${c.company} closed `
    + `${human(c.dueAt)}, and the interview was not completed.`
    + '\n\nIf something prevented you from taking it, reply to this message and '
    + 'the team can reopen it.',
};

export function buildEventMessages(event, c) {
  const subject = SUBJECTS[event];
  const body = BODIES[event];
  if (!subject || !body) return null;

  const text = body(c);
  // An alert has no application yet, and pointing it at "your
  // applications" would be pointing at an empty page.
  // The reference is what a person quotes back; the internal id is not
  // for them to see, and printing both makes the message contradict
  // itself about which one to use.
  const quoted = c.reference || c.applicationId;
  // An id that is missing is left out rather than printed. The footer
  // once read "Job ID: undefined" whenever a caller did not supply one,
  // which makes a real message look like a broken one.
  const ids = [
    c.jobId ? `Job ID: ${c.jobId}` : null,
    quoted ? `Application ID: ${quoted}` : null,
  ].filter(Boolean);
  const ref = ids.join(' · ');

  return {
    email: {
      subject: subject(c),
      text: `Hi ${c.candidateName},\n\n${text}\n\n`
        + (ref ? `${ref}\n\n` : '')
        + `${c.portalUrl}\n\n— TeamLink`,
      html:
        `<p>Hi ${esc(c.candidateName)},</p>` +
        `<p>${esc(text).replace(/\n/g, '<br>')}</p>` +
        (ref ? `<p style="color:#666;font-size:13px">${esc(ref)}</p>` : '') +
        `<p><a href="${esc(c.portalUrl)}">${esc(c.linkLabel || 'View your applications')}</a></p>` +
        `<p>— TeamLink</p>`,
    },
    // Kept short on purpose: an SMS that runs to three segments costs three
    // times as much and is read no more carefully.
    sms: (c.smsLead
      ? `TeamLink: ${c.smsLead} ${c.portalUrl}`
      : `TeamLink: ${text.split('\n')[0]}`
        + (c.jobId ? ` (Job ${c.jobId})` : '')
        + `. ${c.portalUrl}`).slice(0, 320),
    // Spoken aloud: no link, no ids, and the candidate's name first so
    // they know the call is for them.
    ivr: `Hello ${c.candidateName}. This is a call from TeamLink. `
         + `${text.split('\n')[0]} `
         + 'Please check your TeamLink applications page for details. Thank you.',
    whatsapp: `*TeamLink*\n\nHi ${c.candidateName},\n\n${text}\n\n`
      + (ref ? `${ref}\n` : '') + `${c.portalUrl}`,
  };
}
