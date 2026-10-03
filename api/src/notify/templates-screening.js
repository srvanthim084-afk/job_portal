/**
 * "A few quick questions about your application" - the message that
 * carries the no-password answer link, and its one reminder.
 *
 * It names the ROLE and nothing else about the job: the candidate must
 * never learn the client's name from us (migration 0051), so there is no
 * company in the subject, the body, the SMS or the WhatsApp text.
 *
 * Kept beside templates.js rather than inside it so the screening feature
 * can be read in one place; the Notification Settings screen lists it as
 * "Screening Questions — Answer Link" / "— Reminder" (0097), where an
 * EmailJS template id can be attached like any other.
 */
import { emailLayout } from './layout.js';

const fmtDate = (d) => {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return '';
  return t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
};

/**
 * @param c { candidateName, jobTitle, url, expiresAt, count, reminder }
 */
export function buildScreeningLinkMessages(c) {
  const first = String(c.candidateName || '').trim().split(/\s+/)[0] || '';
  const greeting = first ? `Hi ${first},` : 'Hi,';
  const until = fmtDate(c.expiresAt);
  const n = Number(c.count) || 0;
  const many = n ? `${n} short question${n === 1 ? '' : 's'}` : 'a few short questions';

  const subject = c.reminder
    ? `Reminder: a few quick questions about your ${c.jobTitle} application`
    : `A few quick questions about your ${c.jobTitle} application`;
  const lead = c.reminder
    ? `We are still waiting for your answers to ${many} about your application for ${c.jobTitle}.`
    : `Thank you for your application for ${c.jobTitle}. The recruitment team has ${many} for you - notice period, salary expectations and similar.`;
  const how = 'It takes about two minutes and you do not need to sign in. '
    + (until ? `The link works until ${until}.` : 'The link works for 7 days.');

  const text = `${greeting}\n\n${lead}\n\n${how}\n\nAnswer here: ${c.url}\n\n`
    + 'If you did not apply for this role, you can ignore this message.\n\n— TeamLink Consultants';

  const html = emailLayout({
    title: subject,
    preheader: lead,
    greeting,
    body: `${lead}\n\n${how}`,
    facts: [['Role', c.jobTitle], ['Link valid until', until]],
    cta: { label: 'Answer the questions', url: c.url },
    note: 'If you did not apply for this role, you can ignore this message.',
  });

  const sms = (c.reminder
    ? `TeamLink: Reminder - please answer ${many} for your ${c.jobTitle} application: ${c.url}`
    : `TeamLink: ${many.charAt(0).toUpperCase() + many.slice(1)} for your ${c.jobTitle} application (2 min, no login): ${c.url}`)
    .slice(0, 320);

  const whatsapp = `*TeamLink*\n\n${greeting}\n\n${lead}\n\n${how}\n\n${c.url}`;

  return { email: { subject, text, html }, sms, whatsapp };
}
