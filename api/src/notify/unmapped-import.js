/**
 * "This applicant has no requirement to go on" - the email to the recruiter (0151).
 *
 * Called when an imported Naukri / Shine email ends as needs_mapping (see intake/process.js). One email per message:
 * the database claim (intake_unmapped_notice_claim) decides, so a re-sync or a second process cannot repeat it. It
 * never holds up or undoes the import, and a failed send is retried on a later sync.
 */
import { withUser } from '../db.js';
import { providers } from './providers.js';
import { recruiterResponseEmails } from '../intake/recruiter-policy.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BOARD = { naukri: 'Naukri', shine: 'Shine' };
const base = () => String(process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '');
const sentOk = (r) => r && (r.status === 'sent' || r.status === 'delivered');

export function composeUnmappedEmail(info) {
  const board = BOARD[info.source] || 'job board';
  const p = info.parsed || {};
  const digest = !!p.digest;
  const who = info.candidateName
    || (digest ? `${p.unmapped || p.candidates || 'Several'} candidate(s) in a ${board} digest` : 'A candidate');
  const role = (digest && p.jobTitle) || String(info.subject || '').replace(/^\s*(re|fwd?):\s*/i, '').trim() || 'a role we could not read';
  const subject = digest
    ? `Action needed: ${board} candidates for "${role}" have no requirement to go on`
    : `Action needed: ${who} applied on ${board} but no requirement matches`;
  const link = `${base()}/#/recruiter/applications`;
  const lines = [
    `Hello ${info.recruiterName || 'there'},`,
    '',
    `An application came into the ${board} mailbox ${info.mailbox || ''} but it could not be placed on any requirement, so it is waiting for you.`,
    '',
    `Candidate: ${who}`,
    ...(info.candidateEmail ? [`Email: ${info.candidateEmail}`] : []),
    ...(info.candidatePhone ? [`Phone: ${info.candidatePhone}`] : []),
    `Applied for: ${role}`,
    ...(info.reason ? [`Why it is waiting: ${info.reason}`] : []),
    '',
    'What to do: open the Recruiter Portal -> Applications -> "Import from email" -> "Needs a requirement", choose the requirement this person',
    'belongs to and press Map. If there is no such requirement yet, create it first. The candidate and their CV are already saved; nobody is lost.',
    '',
    link,
  ];
  const html = `<p>Hello ${esc(info.recruiterName || 'there')},</p>`
    + `<p>An application came into the <b>${esc(board)}</b> mailbox ${esc(info.mailbox || '')} but it could not be placed on any requirement, so it is waiting for you.</p>`
    + `<table cellpadding="4" style="border-collapse:collapse"><tr><td><b>Candidate</b></td><td>${esc(who)}</td></tr>`
    + (info.candidateEmail ? `<tr><td><b>Email</b></td><td>${esc(info.candidateEmail)}</td></tr>` : '')
    + (info.candidatePhone ? `<tr><td><b>Phone</b></td><td>${esc(info.candidatePhone)}</td></tr>` : '')
    + `<tr><td><b>Applied for</b></td><td>${esc(role)}</td></tr>`
    + (info.reason ? `<tr><td><b>Why it is waiting</b></td><td>${esc(info.reason)}</td></tr>` : '') + '</table>'
    + '<p><b>What to do:</b> open the Recruiter Portal &rarr; Applications &rarr; <i>Import from email</i> &rarr; <i>Needs a requirement</i>, '
    + 'choose the requirement this person belongs to and press <b>Map</b>. If there is no such requirement yet, create it first. '
    + 'The candidate and their CV are already saved; nobody is lost.</p>'
    + `<p><a href="${esc(link)}">Open the Applications screen</a></p>`;
  return { subject, text: lines.join('\n'), html, link };
}

/**
 * @returns {Promise<{status: string}>} 'portal' (told inside TeamLink) | 'sent' (emailed, only with INTAKE_RECRUITER_EMAILS=true) |
 *          'skipped' (already told, or not waiting) | 'no_recipient' | 'failed'
 *
 * The recruiter is told in the portal - a notification in their own list pointing at Applications. Their own email address is
 * written to only when the administrator has switched response emails on (see intake/recruiter-policy.js).
 */
export async function notifyUnmapped(rowId) {
  let info = null;
  try {
    info = await withUser(ENGINE, async (c) => (await c.query(`select intake_unmapped_notice_claim($1) as j`, [rowId])).rows[0].j);
    if (!info) return { status: 'skipped' };

    if (!recruiterResponseEmails()) {
      if (!info.recruiterId) return { status: 'no_recipient' };
      const msg = composeUnmappedEmail(info);
      const first = String(msg.text).split('\n').filter(Boolean)[1] || msg.subject;
      await withUser(ENGINE, (c) => c.query(
        `select notify_create($1,$2,'recruiter',$3,$4,$5,null,null,null,$2,$6::jsonb)`,
        [`ntf_${rowId}`, info.recruiterId, `IMPORT_NEEDS_REQUIREMENT#${rowId}`, msg.subject, first,
         JSON.stringify({ kind: 'import_needs_requirement', messageId: rowId, url: msg.link })]));
      return { status: 'portal' };
    }

    if (!String(info.recruiterEmail || '').trim()) return { status: 'no_recipient' };     // the claim stays: nobody to tell

    const msg = composeUnmappedEmail(info);
    const r = await providers.email.send({
      to: info.recruiterEmail, subject: msg.subject, html: msg.html, text: msg.text,
      vars: { to_name: info.recruiterName, subject: msg.subject, message: msg.text, portal_link: msg.link, notice_kind: 'import_needs_requirement' },
    });
    if (sentOk(r)) return { status: 'sent' };
    await withUser(ENGINE, (c) => c.query(`select intake_unmapped_notice_release($1)`, [rowId]));
    return { status: 'failed' };
  } catch (err) {
    console.error('[intake] could not tell the recruiter about an unmapped import:', err.message);
    if (info) await withUser(ENGINE, (c) => c.query(`select intake_unmapped_notice_release($1)`, [rowId])).catch(() => {});
    return { status: 'failed' };
  }
}
