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

const line = (j) => [j.title, j.company, j.location, j.pay].filter(Boolean).join(' · ');
const savedLine = (s) => [s.company, s.location].filter(Boolean).join(' · ');

/** In-app text, exactly as the owner worded it. */
export function savedJobInboxLine(job) {
  return `New job like one you saved: ${job.title}${job.location ? ` · ${job.location}` : ''}`;
}

/**
 * @param c { candidateName, job:{title, company, location, pay, exp, url},
 *            saved:{title, company, location}, why, stopUrl, savedUrl }
 */
export function buildSavedJobAlertMessages(c) {
  const j = c.job || {};
  const s = c.saved || {};
  const greeting = c.candidateName ? `Hi ${String(c.candidateName).trim().split(/\s+/)[0]},` : 'Hi,';
  const subject = `New job like one you saved: ${j.title}${j.location ? ` · ${j.location}` : ''}`;
  const savedAs = `"${s.title}"${savedLine(s) ? ` (${savedLine(s)})` : ''}`;
  const lead = `You saved ${savedAs} on TeamLink. A new job like it has just been posted:`;
  const why = c.why ? `Why we think it is similar: ${c.why}.` : '';

  const text = `${greeting}\n\n${lead}\n\n• ${line(j)}\n  ${j.url}\n\n`
    + (why ? `${why}\n\n` : '')
    + `Your saved jobs: ${c.savedUrl}\n\n`
    + `Stop these emails: ${c.stopUrl}\n\n— TeamLink`;

  const html = emailLayout({
    title: subject,
    preheader: `Like the job you saved: ${s.title}`,
    greeting,
    body: `${lead}${why ? `\n\n${why}` : ''}`,
    facts: [['Role', j.title], ['Company', j.company], ['Location', j.location],
            ['Pay', j.pay], ['Experience', j.exp], ['Like the job you saved', s.title]],
    cta: { label: 'View job & apply', url: j.url },
    note: `You get this because you saved "${s.title}" and "Tell me about similar new jobs" is on. `
      + 'You can turn it off on your Saved Jobs page, or with the link below.',
    stopLink: { label: 'Stop similar-job emails', url: c.stopUrl },
  });

  return { email: { subject, text, html } };
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
