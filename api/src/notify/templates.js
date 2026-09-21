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
