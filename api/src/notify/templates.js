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
  if (Number.isNaN(d.getTime())) return String(ts);
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
};

const BODIES = {
  STAGE_CHANGED: (c) =>
    `Your application for ${c.jobTitle} at ${c.company} has moved to "${c.stageLabel || c.stage}".`
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
    `Your AI interview for ${c.jobTitle} has been assessed. `
    + `Overall score: ${c.overall}%`
    + (c.technical != null ? ` (technical ${c.technical}%, communication ${c.communication}%)` : '')
    + '.\n\nYou can see the full breakdown on your applications page.',

  OFFER_EXTENDED: (c) =>
    `${c.company} has extended an offer for ${c.jobTitle}.`
    + (c.ctc ? `\n\nOffered CTC: ${c.ctc}` : '')
    + (c.joiningDate ? `\nProposed joining date: ${human(c.joiningDate)}` : ''),
};

export function buildEventMessages(event, c) {
  const subject = SUBJECTS[event];
  const body = BODIES[event];
  if (!subject || !body) return null;

  const text = body(c);
  const ref = `Job ID: ${c.jobId} · Application ID: ${c.applicationId}`;

  return {
    email: {
      subject: subject(c),
      text: `Hi ${c.candidateName},\n\n${text}\n\n${ref}\n\n${c.portalUrl}\n\n— TeamLink`,
      html:
        `<p>Hi ${esc(c.candidateName)},</p>` +
        `<p>${esc(text).replace(/\n/g, '<br>')}</p>` +
        `<p style="color:#666;font-size:13px">${esc(ref)}</p>` +
        `<p><a href="${esc(c.portalUrl)}">View your applications</a></p>` +
        `<p>— TeamLink</p>`,
    },
    // Kept short on purpose: an SMS that runs to three segments costs three
    // times as much and is read no more carefully.
    sms: `TeamLink: ${text.split('\n')[0]} (Job ${c.jobId}). ${c.portalUrl}`.slice(0, 320),
    // Spoken aloud: no link, no ids, and the candidate's name first so
    // they know the call is for them.
    ivr: `Hello ${c.candidateName}. This is a call from TeamLink. `
         + `${text.split('\n')[0]} `
         + 'Please check your TeamLink applications page for details. Thank you.',
    whatsapp: `*TeamLink*\n\nHi ${c.candidateName},\n\n${text}\n\n${ref}\n${c.portalUrl}`,
  };
}
