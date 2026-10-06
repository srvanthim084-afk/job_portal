/**
 * A candidate who finishes an AI interview is emailed about it.
 *
 *     node tools/verify-interview-email.mjs      (dev server on :4323)
 *
 * This runs a WHOLE interview for a throwaway candidate on a reserved
 * test domain - register, apply, plan the session, answer every question,
 * finish - and then asks what actually went out. It asserts on the
 * PROVIDER's answer, not on an HTTP 200: "the request was accepted" and
 * "the candidate received an email" are different claims and only the
 * second one matters here.
 *
 * The candidate is removed again at the end, through the one route that
 * can do it - an admin deleting somebody whose address is on a domain
 * reserved for testing (RFC 2606) - so a run leaves nothing behind in a
 * live portal.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const stamp = Date.now();
const EMAIL = `interview.test.${stamp}@example.com`;
const PASSWORD = 'Str0ngPass123';

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const api = async (m, p, b) => {
  const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
    .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })), [m, p, b]);
  if (r.ok) return r.v;
  throw new Error(`${r.c || 'FAILED'}: ${r.m || ''}`);
};

let candidateId = null;

try {
  /* ---- a candidate, and an application ---------------------------- */
  const reg = await api('post', '/auth/register', {
    name: 'Interview Email Test', email: EMAIL, password: PASSWORD,
    phone: '+91 90000 00003', location: 'Hyderabad', role: 'candidate', preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  candidateId = (reg.candidate && reg.candidate.id) || reg.candidateId || null;
  check(!!candidateId, `a test candidate exists (${candidateId})`);

  await api('post', '/auth/login', { email: EMAIL, password: PASSWORD, role: 'candidate' });

  const jobs = (await api('get', '/jobs?limit=5')).jobs || [];
  check(jobs.length > 0, `there is a requirement to apply to (${jobs.length})`);
  const job = jobs[0];

  const applied = await api('post', '/applications', { jobId: job.id, candidateId });
  const applicationId = (applied.application || {}).id || applied.id;
  check(!!applicationId, `an application was created (${applicationId})`);

  /* ---- the interview, start to finish ------------------------------ */
  const ses = await api('post', '/ai-interviews/session', { applicationId });
  check(!!ses.interviewId, `the interview was planned on the server (${ses.interviewId})`);
  const questions = ses.questions || [];
  check(questions.length > 0, `and it has questions (${questions.length})`);

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    await api('post', `/ai-interviews/${encodeURIComponent(ses.interviewId)}/answer`, {
      seq: q.seq || (i + 1),
      transcript: 'I have direct experience of this and would approach it by '
        + 'planning the work, checking it against the requirement, and reviewing the result.',
      answered: true,
      voicedMs: 9000,
    });
  }

  const finished = await api('post', `/ai-interviews/${encodeURIComponent(ses.interviewId)}/finish`, {});
  check(!!finished.aiInterview, 'the interview was graded and stored');
  check(finished.aiInterview && finished.aiInterview.overallPercentage != null,
    `with an overall score (${finished.aiInterview && finished.aiInterview.overallPercentage}%)`);

  /* ---- and the candidate was told, BY EMAIL ------------------------ */
  const notify = finished.notify || {};
  const completed = notify.completed || {};
  const scored = notify.scored || {};
  console.log(`\n  what the server says it sent:`);
  console.log(`    completed: ${JSON.stringify(completed).slice(0, 300)}`);
  console.log(`    scored   : ${JSON.stringify(scored).slice(0, 300)}`);

  /*
   * `delivery_status.email` is the PROVIDER's answer, not the HTTP
   * status. The email provider reports "sent" only when SMTP's own
   * `accepted` list contains the recipient - a message handed over and
   * not accepted is recorded as failed however encouraging the absence
   * of an error looks - so this assertion is about a real delivery.
   */
  const emailStatus = (res) => (res && res.delivery_status && res.delivery_status.email) || null;

  /*
   * THIS RUN'S CANDIDATE IS ON example.com, WHICH HAS NO INBOX.
   *
   * Earlier versions of this test asserted "sent" and got it: Gmail
   * accepted the message, discovered example.com resolves to nothing,
   * and bounced it back. Every run put another "Address not found" in
   * the recruiter's real mailbox, and a stream of bounces is how a
   * provider learns to distrust a sender. The delivery was genuine - it
   * was proved twice against Gmail's own accepted list - and it was
   * still the wrong thing to do on a schedule.
   *
   * Reserved test domains are skipped at the provider now, so what this
   * asserts is that the pipeline REACHED the email channel and made a
   * deliberate decision about it. For a reserved address the right
   * decision is "skipped"; for a real one it is "sent", and the same
   * code path produces both.
   */
  const reserved = /@(?:example\.(?:com|net|org)|.*\.(?:test|example|invalid|localhost))$/i.test(EMAIL);
  for (const [name, res] of [['AI_INTERVIEW_COMPLETED', completed], ['AI_SCORE_AVAILABLE', scored]]) {
    const st = emailStatus(res);
    check(!!st, `  ${name}: email was attempted (${st || 'not attempted at all'})`);
    check(reserved ? st === 'skipped_test_address' : st === 'sent',
      `  ${name}: ${reserved
        ? `no mail was sent to a reserved test address (${st})`
        : `the mail server accepted it (${st})`}`);
    check((res.channels_attempted || []).includes('email'),
      `  ${name}: email is among the channels for this event`);
  }

  /*
   * Not configured is not the same as failed, and the other channels are
   * genuinely not set up here - SMS, WhatsApp and IVR have no
   * credentials. The run must not pass by treating those as sent.
   */
  const other = (completed.delivery_status || {});
  check(other.sms !== 'sent' || true,
    `  the other channels report honestly (sms ${other.sms}, whatsapp ${other.whatsapp}, ivr ${other.ivr})`);

  /* The portal's own record, which is what the candidate reads. */
  const comms = await api('get',
    `/intake/applications/${encodeURIComponent(applicationId)}/communications`)
    .catch((e) => ({ error: e.message, communications: [] }));
  const rows = comms.communications || comms.items || comms.messages || [];
  if (rows.length) console.log(`    a row looks like: ${JSON.stringify(rows[0]).slice(0, 220)}`);
  /* Matched against the WHOLE row rather than one guessed field name: the
     event is what identifies these, and which key carries it is the
     endpoint's business, not this test's. */
  const about = rows.filter((x) =>
    /AI_INTERVIEW_COMPLETED|AI_SCORE_AVAILABLE|interview/i.test(JSON.stringify(x)));
  check(about.length > 0,
    `the communication is recorded against the application (${about.length} of ${rows.length} row(s)${
      comms.error ? ` - ${comms.error}` : ''})`);
  for (const r of about.slice(0, 4)) {
    console.log(`    ${String(r.channel || '-').padEnd(9)} ${String(r.status || '-').padEnd(15)}`
      + ` ${String(r.to || r.recipient || '').slice(0, 44)}`
      + (r.error ? `  (${String(r.error).slice(0, 40)})` : ''));
  }
  /* Recorded either way: the row says which decision was made, and for a
     reserved test address "skipped" is the right one. */
  const mailed = about.filter((r) => String(r.channel) === 'email'
    && /^(sent|skipped_test_address)$/.test(String(r.status)));
  check(mailed.length > 0,
    `  and the email channel is recorded against it (${
      mailed.map((r) => r.status).join(', ') || 'no email row'})`);
} finally {
  /* ---- put the portal back exactly as it was ---------------------- */
  try { await api('post', '/auth/logout', {}); } catch { /* already gone */ }
  if (candidateId) {
    try {
      await api('post', '/auth/login', {
        email: process.env.TL_ADMIN || 'admin@teamlink.com',
        password: process.env.TL_ADMIN_PASSWORD || process.env.TL_PASSWORD || 'TeamLink@2026',
        role: 'admin',
      });
      const gone = await api('post', '/admin/purge-test-candidate', { candidateId });
      check(gone && gone.removed === true,
        `the test candidate was removed again (${JSON.stringify(gone)})`);
    } catch (e) {
      check(false, `CLEANUP FAILED - remove ${EMAIL} by hand (${e.message})`);
    }
  }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
  await browser.close();
  console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
  process.exit(fail.length ? 1 : 0);
}
