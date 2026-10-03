/**
 * Messages about a scheduled interview, for the candidate: scheduled (with
 * the prep kit link), the kit sent again, the day-before and two-hour
 * reminders, rescheduled and cancelled.
 *
 * NO COMPANY, ANYWHERE. Not in the subject, the body, the SMS or the
 * WhatsApp text - and no interviewer name either, which is usually
 * somebody at the client. The venue or meeting link appears only when the
 * recruiter has released it (the caller passes it only then).
 *
 * Listed on Notification Settings as "Interview Prep Kit — Scheduled /
 * Reminder / Rescheduled / Cancelled" (0098).
 */
import { emailLayout } from './layout.js';

const KINDS = {
  scheduled:   { subject: (c) => `Interview scheduled — ${c.jobTitle}, ${c.when}`,
                 lead: (c) => `Your interview for ${c.jobTitle} is scheduled for ${c.when}.` },
  kit:         { subject: (c) => `Your interview prep kit — ${c.jobTitle}`,
                 lead: (c) => `Your prep kit for the ${c.jobTitle} interview on ${c.when} is ready.` },
  day_before:  { subject: (c) => `Reminder: your ${c.jobTitle} interview is tomorrow`,
                 lead: (c) => `A reminder that your interview for ${c.jobTitle} is tomorrow, ${c.when}.` },
  two_hours:   { subject: (c) => `Your ${c.jobTitle} interview starts in about 2 hours`,
                 lead: (c) => `Your interview for ${c.jobTitle} starts at ${c.time || 'the scheduled time'} today.` },
  rescheduled: { subject: (c) => `Interview rescheduled — ${c.jobTitle}, ${c.when}`,
                 lead: (c) => `Your interview for ${c.jobTitle} has been moved to ${c.when}. Please ignore the earlier time.` },
  cancelled:   { subject: (c) => `Interview cancelled — ${c.jobTitle}`,
                 lead: (c) => `Your interview for ${c.jobTitle} on ${c.when} has been cancelled. The recruitment team will contact you about next steps.` },
};

/**
 * @param kind  scheduled | kit | day_before | two_hours | rescheduled | cancelled
 * @param c     { candidateName, jobTitle, when, time, round, modeLabel, kitUrl,
 *                venue, meetingLink, contact, withKit }
 */
export function buildInterviewMessages(kind, c) {
  const k = KINDS[kind];
  if (!k) throw new Error(`unknown interview message ${kind}`);
  const first = String(c.candidateName || '').trim().split(/\s+/)[0] || '';
  const greeting = first ? `Hi ${first},` : 'Hi,';
  const lead = k.lead(c);
  const subject = k.subject(c);
  const where = c.venue ? `Venue: ${c.venue}` : c.meetingLink ? `Meeting link: ${c.meetingLink}` : '';
  const kitLine = c.withKit && c.kitUrl && kind !== 'cancelled'
    ? `Your prep kit - likely questions, tips and what to bring: ${c.kitUrl}` : '';
  const body = [lead, [c.round, c.modeLabel].filter(Boolean).join(' · '), where,
    c.contact ? `Contact: ${c.contact}` : '', kitLine].filter(Boolean).join('\n\n');

  const text = `${greeting}\n\n${body}\n\n— TeamLink Consultants`;
  const html = emailLayout({
    title: subject,
    preheader: lead,
    greeting,
    body: [lead, kind === 'cancelled' ? '' : 'Open your prep kit for likely questions, tips and a checklist of what to bring.']
      .filter(Boolean).join('\n\n'),
    facts: [['Role', c.jobTitle], ['When', c.when], ['Round', c.round], ['Mode', c.modeLabel],
      ['Venue', c.venue], ['Meeting link', c.meetingLink], ['Contact', c.contact]],
    cta: kind === 'cancelled' ? { label: 'Open your interviews', url: c.interviewsUrl }
      : c.withKit && c.kitUrl ? { label: 'Open your prep kit', url: c.kitUrl } : { label: 'Open your interviews', url: c.interviewsUrl },
  });

  const smsTail = kind === 'cancelled' ? '' : c.withKit && c.kitUrl ? ` Prep kit: ${c.kitUrl}` : '';
  const smsWhere = c.venue ? ` Venue: ${c.venue}.` : c.meetingLink ? ` Link: ${c.meetingLink}` : '';
  const sms = `TeamLink: ${lead}${kind === 'two_hours' || kind === 'day_before' ? smsWhere : ''}${smsTail}`.slice(0, 480);
  const whatsapp = `*TeamLink*\n\n${greeting}\n\n${body}`;
  return { email: { subject, text, html }, sms, whatsapp };
}
