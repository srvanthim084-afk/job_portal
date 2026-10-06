/**
 * "New job like one you saved" - the instant message and the evening
 * digest (0110).
 *
 * Kept beside templates.js like the screening and interview templates, so
 * the feature reads in one place. The Notification Settings screen lists
 * both as "Saved Job — Similar New Job" / "Saved Job — Daily Digest",
 * where an EmailJS template id can be attached like any other.
 *
 * COMPANY. Only the label the candidate already sees on the job's card,
 * passed in by the engine through companyLabel() (portal/alerts.js), which
 * turns anything that would read "Client" into TeamLink. Nothing here
 * reads a company itself.
 */
import { emailLayout } from './layout.js';
import { jobOpportunityMessages } from './job-opportunity.js';

const line = (j) => [j.title, j.company, j.location, j.pay].filter(Boolean).join(' · ');

/** In-app text, exactly as the owner worded it. */
export function savedJobInboxLine(job) {
  return `New job like one you saved: ${job.title}${job.location ? ` · ${job.location}` : ''}`;
}

/**
 * The instant alert, in the shared job-opportunity format
 * (job-opportunity.js, owner 2026-10-06). The opening line says which saved
 * job it is like - the reason this alert exists; the body is the same as
 * every other job alert's.
 *
 * @param c { candidateName, job:{...the job record (toJob shape), company, url},
 *            saved:{title, company, location}, why, stopUrl, savedUrl }
 * @returns {{ email:{subject,text,html}, inApp:string, whatsapp:string, sms:string }}
 */
export function buildSavedJobAlertMessages(c) {
  const j = c.job || {};
  const s = c.saved || {};
  const subject = `New job like one you saved: ${j.title}${j.location ? ` · ${j.location}` : ''}`;
  const why = c.why ? `Why we think it is similar: ${c.why}.` : '';
  const m = jobOpportunityMessages(j, {
    kind: 'saved_job', applyUrl: j.url, company: j.company,
    savedTitle: s.title, savedCompany: s.company, savedLocation: s.location,
    email: {
      subject,
      preheader: `Like the job you saved: ${s.title}`,
      note: [why, `You get this because you saved "${s.title}" and "Tell me about similar new jobs" is on. `
        + `You can turn it off on your Saved Jobs page (${c.savedUrl}), or with the link below.`].filter(Boolean).join(' '),
      stopLink: { label: 'Stop similar-job emails', url: c.stopUrl },
      ctaLabel: 'View job & apply',
    },
  });
  return { email: m.email, inApp: m.inApp, whatsapp: m.whatsapp, sms: m.sms };
}

/**
 * The evening summary: the jobs over the day's cap, in one message.
 *
 * @param c { candidateName, jobs:[{title, company, location, pay, url, savedTitle}],
 *            total, stopUrl, savedUrl }
 */
export function buildSavedJobDigestMessages(c) {
  const jobs = (c.jobs || []).slice(0, 10);
  const total = Math.max(Number(c.total) || 0, jobs.length);
  const greeting = c.candidateName ? `Hi ${String(c.candidateName).trim().split(/\s+/)[0]},` : 'Hi,';
  const subject = `${total} more new job${total === 1 ? '' : 's'} like ones you saved`;
  const lead = `${total} more new job${total === 1 ? ' like one' : 's like ones'} you saved `
    + `${total === 1 ? 'was' : 'were'} posted today.`;
  const more = total > jobs.length ? `\n\n…and ${total - jobs.length} more on TeamLink.` : '';
  const item = (j) => `• ${line(j)}${j.savedTitle ? ` (like "${j.savedTitle}")` : ''}`;

  const text = `${greeting}\n\n${lead}\n\n`
    + jobs.map((j) => `${item(j)}\n  ${j.url}`).join('\n') + more
    + `\n\nYour saved jobs: ${c.savedUrl}\n\nStop these emails: ${c.stopUrl}\n\n— TeamLink`;

  const html = emailLayout({
    title: subject,
    preheader: lead,
    greeting,
    body: `${lead}\n\n${jobs.map(item).join('\n')}${more}`,
    cta: { label: jobs.length === 1 ? 'View job & apply' : 'See your saved jobs',
           url: jobs.length === 1 ? jobs[0].url : c.savedUrl },
    note: 'You get this summary because more similar jobs were posted today than we send one by one. '
      + 'You can turn these off on your Saved Jobs page, or with the link below.',
    stopLink: { label: 'Stop similar-job emails', url: c.stopUrl },
  });

  return { email: { subject, text, html } };
}
