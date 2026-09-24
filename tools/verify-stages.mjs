/**
 * With BDE, Hold and Joined, driven through the running server.
 *
 *     node tools/verify-stages.mjs      (needs the dev server on :4323)
 *
 * The three stages were being kept in somebody's head. Adding rows to a
 * table is the easy half; the half worth testing is what each one does
 * to everything else:
 *
 *   - a recruiter can actually move an application to all three
 *   - With BDE and Hold send the candidate NOTHING - no email, no SMS,
 *     no WhatsApp, no call, and no portal notification. "Your
 *     application has moved to With BDE" means nothing to the person
 *     reading it; "you are on Hold" loses somebody who was only ever
 *     waiting a week.
 *   - Joined DOES send, with its own wording, because it is the outcome
 *     and it is theirs
 *   - the history records every move either way, including the silent
 *     ones - a stage nobody was told about still has to be auditable
 *   - the existing nine stages kept their order and their meaning
 *
 * It creates one application and removes it again: this runs against the
 * real development database and a test that leaves candidates behind is
 * a test that damages the thing it tests.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const RECRUITER = {
  email: process.env.TL_RECRUITER || 'teamlinkmed001@tmlink.in',
  password: process.env.TL_RECRUITER_PASSWORD || 'Teamlink@2026',
  role: 'recruiter',
};

const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const browser = await chromium.launch();
const open = async () => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
  return {
    page,
    api: async (m, p, b) => {
      const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
        .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })), [m, p, b]);
      if (!r.ok) throw Object.assign(new Error(`${r.c || 'FAILED'}: ${r.m || ''}`), { code: r.c });
      return r.v;
    },
  };
};

const rec = await open();
await rec.api('post', '/auth/login', RECRUITER);

/* ---- the stages exist, in the right places ------------------------- */
const boot = await rec.page.evaluate(() => DATA.stages.map((s) => s.id));
for (const [id, label] of [['with_bde', 'With BDE'], ['hold', 'Hold'], ['joined', 'Joined']]) {
  check(boot.includes(id), `${label} is a stage the whole application can see`);
}
check(boot.indexOf('with_bde') > boot.indexOf('shortlisted')
   && boot.indexOf('with_bde') < boot.indexOf('client_review'),
  'With BDE sits after Shortlisted and before Client Review');
check(boot.indexOf('joined') > boot.indexOf('selected'),
  'Joined comes after Selected - the outcome after the decision');

const ORDER = ['applied', 'ai_screening', 'shortlisted', 'interview_scheduled',
               'ai_interview_done', 'client_review', 'offer_extended', 'selected', 'rejected'];
const kept = boot.filter((id) => ORDER.includes(id));
check(JSON.stringify(kept) === JSON.stringify(ORDER),
  `the nine existing stages kept their order (${kept.join(' > ')})`);

const kanban = await rec.page.evaluate(() => DATA.kanbanStages.map((s) => s.id));
check(kanban.length === 5,
  `the board still has its five columns, so nothing on screen moved (${kanban.length})`);

/* ---- a real application to move ------------------------------------ */
const stamp = Date.now();
const companies = (await rec.api('get', '/companies')).companies || [];
const job = (await rec.api('post', '/jobs', {
  title: `Stage Test ${stamp}`, companyId: (companies[0] || {}).id,
  location: 'Hyderabad', department: 'Engineering', skills: ['Java'],
  status: 'open', desc: 'Raised by verify-stages, removed at the end.',
})).job;

const cand = await open();
const email = `stage.${stamp}@example.invalid`;
await cand.api('post', '/auth/register',
  { name: `Stage Candidate ${stamp}`, email, password: 'Stage@2026' });
const applied = await cand.api('post', '/applications', { jobId: job.id });
const appId = applied.application.id;
const candidateId = applied.application.candidateId;

const sent = async () => ((await rec.api('get',
  `/intake/applications/${appId}/communications`)).communications || []);
// The stage half of the record. /intake/timeline carries
// application_events; stage moves live in application_stage_history and
// come back from here.
const history = async () => ((await rec.api('get',
  `/applications/${appId}/history`)).history || []);

const move = (stage) => rec.api('put', `/applications/${appId}/status`, { stage });

/* ---- With BDE: moves, and says nothing ----------------------------- */
const before = (await sent()).length;
const bde = await move('with_bde');
check(bde.application.stage === 'with_bde',
  `a recruiter can move an application to With BDE (${bde.application.stage})`);
check(bde.notified === false,
  'and the API says plainly that the candidate was not told');
check((await sent()).length === before,
  `nothing was sent to the candidate (${(await sent()).length - before} message(s))`);

/* ---- Hold: the same ------------------------------------------------- */
const hold = await move('hold');
check(hold.application.stage === 'hold', 'an application can be put on Hold');
check(hold.notified === false, 'and Hold is silent too');
check((await sent()).length === before,
  `still nothing sent (${(await sent()).length - before} message(s))`);

/* ---- but the move is recorded either way --------------------------- */
/*
 * A silent stage is not an invisible one. Nobody was emailed, and the
 * pipeline still has to be able to answer "where did this profile sit
 * for three weeks and who put it there".
 */
const moves = (await history()).map((h) => h.to_stage);
check(moves.includes('with_bde'), `the move to With BDE is recorded (${moves.join(' > ')})`);
check(moves.includes('hold'), 'the move to Hold is recorded');
check(moves.indexOf('hold') > moves.indexOf('with_bde'),
  'and in the order they happened');

/* ---- Joined: sends, in its own words -------------------------------- */
const joined = await move('joined');
check(joined.application.stage === 'joined', 'an application can be marked Joined');
check(joined.notified === true, 'and Joined does reach the candidate');

const after = await sent();
check(after.length > before,
  `a message went out (${after.length - before} delivery record(s))`);
check(after.some((m) => m.channel === 'email' && (m.status === 'sent' || m.status === 'delivered')),
  `the email was accepted by the provider (${after.filter((m) => m.channel === 'email')
    .map((m) => m.status).join(', ')})`);

/*
 * The delivery log records CHANNEL and STATUS, not the words - so what
 * was actually said is checked where it is composed. A stage with no
 * wording of its own falls through to "your application has moved to
 * Joined", which is a sentence nobody should receive on their first
 * morning.
 */
const { buildEventMessages } = await import('../api/src/notify/templates.js');
const msg = buildEventMessages('STAGE_JOINED', {
  candidateName: 'Stage Candidate', jobTitle: 'Staff Nurse',
  company: 'Apollo Hospitals', joiningDate: 'Monday, 5 Oct 2026',
  portalUrl: 'https://example.invalid/#/candidate',
});
check(!!msg, 'Joined has wording of its own rather than falling through');
check(/welcome aboard/i.test((msg && msg.email.subject) || ''),
  `and it reads like a welcome (${msg && msg.email.subject})`);
check(!/moved to/i.test((msg && msg.email.subject) || ''),
  'not "your application has moved to Joined"');
check(/Apollo Hospitals/.test((msg && msg.email.text) || '')
   && /Monday, 5 Oct 2026/.test((msg && msg.email.text) || ''),
  'and it names the company and the joining date');

const generic = buildEventMessages('STAGE_CHANGED', {
  candidateName: 'Stage Candidate', jobTitle: 'Staff Nurse',
  company: 'Apollo Hospitals', stageLabel: 'Joined',
  portalUrl: 'https://example.invalid/#/candidate',
});
check((msg && msg.email.subject) !== (generic && generic.email.subject),
  'the two are genuinely different messages');

/* ---- clean up ------------------------------------------------------- */
try {
  const admin = await open();
  await admin.api('post', '/auth/login', {
    email: process.env.TL_ADMIN || 'admin@teamlink.com',
    password: process.env.TL_ADMIN_PASSWORD || process.env.TL_PASSWORD || 'TeamLink@2026',
    role: 'admin',
  });
  await admin.api('del', `/jobs/${job.id}`);
  const left = ((await admin.api('get',
    `/jobs?q=${encodeURIComponent(`Stage Test ${stamp}`)}`)).jobs || [])
    .filter((j) => j.title === `Stage Test ${stamp}`);
  check(left.length === 0, 'the test requirement was removed again');

  /*
   * And the CANDIDATE, which is the part that used to be impossible.
   *
   * There is no route that deletes an applicant and there should not be
   * - an ATS where a recruiter can erase somebody has no audit trail -
   * so every run used to leave one person behind, sitting in the
   * recruiter's portal looking exactly like a real application. The
   * database now allows exactly this: an admin removing a candidate
   * whose address is on a domain reserved for testing, and nothing else.
   */
  if (candidateId) {
    const gone = await admin.api('post', '/admin/purge-test-candidate',
      { candidateId: candidateId });
    check(gone && gone.removed === true,
      `the test candidate was removed too (${JSON.stringify(gone)})`);
  }

} catch (e) {
  console.log(`  NOTE: the test requirement was left behind (${e.message})`);
}

await browser.close();
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
