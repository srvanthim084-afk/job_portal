/**
 * Three reviews, one interview, and a candidate who is never told about
 * a client.
 *
 *     node tools/verify-review-chain.mjs
 *
 * The desk works a profile through three hands - the recruiter reads the
 * CV, the BDE decides whether to put their name to it, the client decides
 * whether to interview - and the candidate is shown none of that
 * machinery. The two halves are easy to get right separately and easy to
 * break together, because the stage id, the recruiter's label, the
 * candidate's label, the portal notification and the email all have to
 * agree about one move.
 *
 * So this walks one application the whole way down the chain and, at
 * every step, checks BOTH sides: that the desk sees who is holding the
 * file, and that nothing the candidate can read contains the word
 * "client".
 *
 * It creates its own candidate, job and application on an RFC-2606
 * reserved domain - which migration 0047 makes the provider decline, so
 * no message leaves the building - and purges all of it at the end. No
 * real candidate is moved, and no real candidate is emailed.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const STAMP = Date.now();
const EMAIL = `reviewchain.${STAMP}@example.test`;
const PASSWORD = `Probe@${STAMP}`;

const fail = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) fail.push(what);
};

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const METHOD = { delete: 'del' };
const api = async (m0, p, b) => {
  const m = METHOD[m0] || m0;
  const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
    .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })), [m, p, b]);
  if (r.ok) return r.v;
  const err = new Error(`${r.c || 'FAILED'}: ${r.m || ''}`);
  err.code = r.c;
  throw err;
};

const login = (role) => api('post', '/auth/login', {
  email: role === 'admin' ? (process.env.TL_ADMIN || 'admin@teamlink.com')
    : (process.env.TL_RECRUITER || 'teamlinkmed001@tmlink.in'),
  password: role === 'admin'
    ? (process.env.TL_ADMIN_PASSWORD || 'TeamLink@2026')
    : (process.env.TL_RECRUITER_PASSWORD || 'Teamlink@2026'),
  role,
});

/** Anything a candidate can read must never contain this. */
const FORBIDDEN = /\bclients?\b/i;

let candidateId = null;
let applicationId = null;

try {
  await login('recruiter');

  /* ---- the stage table itself ------------------------------------ */
  console.log('The three reviews are named, and the candidate reads something else\n');

  const stages = (await api('get', '/bootstrap')).data.stages || [];
  const byId = Object.fromEntries(stages.map((s) => [s.id, s]));

  check(byId.shortlisted?.label === 'Recruiter Review',
    `  shortlisted reads "${byId.shortlisted?.label}" to the desk`);
  check(byId.with_bde?.label === 'BDE Review',
    `  with_bde reads "${byId.with_bde?.label}" to the desk`);
  check(byId.client_review?.label === 'Client Review',
    `  client_review reads "${byId.client_review?.label}" to the desk`);
  check(!!byId.client_interview,
    `  the client's own interview has a stage of its own ("${byId.client_interview?.label}")`);

  /* Every stage a candidate can be shown, checked for the word. */
  const leaks = stages.filter((s) => {
    const shown = s.candidateLabel || s.label;
    return FORBIDDEN.test(shown);
  });
  check(leaks.length === 0,
    `  no stage shows a candidate the word "client" (${leaks.map((s) => s.id).join(', ') || 'none'})`);

  check(byId.client_review?.candidateLabel === 'Recruiter Review',
    `  client_review reads "${byId.client_review?.candidateLabel}" to the candidate`);
  check(byId.client_interview?.candidateLabel === 'Interview',
    `  client_interview reads "${byId.client_interview?.candidateLabel}" to the candidate`);
  check(byId.shortlisted?.candidateLabel === 'Shortlisted',
    `  and "Shortlisted" is kept for them — it is the one stage that is good news`);

  /* ---- a candidate to walk down the chain ------------------------ */
  console.log('\nOne application, walked the whole way down\n');

  const jobs = ((await api('get', '/bootstrap')).data.jobs || [])
    .filter((j) => j.status === 'open' || j.status === undefined);
  const job = jobs[0];
  if (!job) throw new Error('there is no job to apply to');

  const reg = await api('post', '/auth/register', {
    name: 'Review Chain Probe',
    email: EMAIL,
    password: PASSWORD,
    phone: '9000000001',
    location: 'Hyderabad',
  });
  candidateId = reg.candidate?.id || reg.candidateId || reg.profileId;
  check(!!candidateId, `  a probe candidate was created (${EMAIL})`);

  await login('recruiter');
  const created = await api('post', '/applications', {
    jobId: job.id, candidateId, source: 'portal',
  });
  applicationId = created.application?.id || created.id;
  check(!!applicationId, `  and applied to "${job.title}"`);

  /*
   * THE CHAIN. Each move is the real endpoint - the one the buttons call
   * - so the history, the portal notification and the message all happen
   * exactly as they would for a real candidate.
   */
  const CHAIN = [
    ['shortlisted', 'recruiter', 'Recruiter Review', 'Shortlisted'],
    ['with_bde', 'bde', 'BDE Review', null],
    ['client_review', 'client', 'Client Review', 'Recruiter Review'],
    ['client_interview', 'client', 'Client Interview', 'Interview'],
  ];

  const expected = [];
  for (const [stage, owner, deskLabel, candLabel] of CHAIN) {
    const out = await api('put', `/applications/${applicationId}/status`, { stage });
    check(out.application?.stage === stage,
      `  moved to ${deskLabel} (owner: ${owner})`);

    if (candLabel === null) {
      check(out.notified === false,
        `    the candidate is told nothing — ${deskLabel} is ours, not theirs`);
    } else {
      check(out.notified === true, '    the candidate was told');
      expected.push(candLabel);
    }
  }

  /* ---- the verdict ------------------------------------------------ */
  console.log('\nThe interview ends in a decision, and the candidate hears it\n');

  const verdict = await api('put', `/applications/${applicationId}/status`,
    { stage: 'selected', note: 'Client confirmed after interview' });
  check(verdict.application?.stage === 'selected', '  recorded as Selected');
  check(verdict.notified === true, '  the candidate was told');

  const sent = verdict.notify || {};
  const channels = Object.keys(sent.delivery_status || {});
  check(sent.event === 'STAGE_SELECTED' || sent.event === 'STAGE_CHANGED',
    `  a message was composed (${sent.event}, channels: ${channels.join(', ') || 'none'})`);
  check(sent.skipped !== 'no template',
    `  and it had wording to send — not "no template"`);

  /* Rejection takes the other branch and must also have wording. */
  const rej = await api('put', `/applications/${applicationId}/status`, { stage: 'rejected' });
  check(rej.notified === true && (rej.notify?.event || '').startsWith('STAGE_'),
    `  a rejection is told too (${rej.notify?.event})`);
  check(rej.notify?.skipped !== 'no template', '  and it has its own wording');

  /* ---- read it as the person it is about ------------------------- */
  console.log('\nEverything this candidate can actually read\n');

  /*
   * SIGNED IN AS THE CANDIDATE, deliberately.
   *
   * A recruiter cannot read another person's notifications and should not
   * be able to - so checking the wording from the recruiter's session
   * found nothing at all and passed its assertions vacuously. The only
   * honest place to ask "what does the candidate see" is their session.
   */
  await api('post', '/auth/logout', {}).catch(() => {});
  await api('post', '/auth/login', { email: EMAIL, password: PASSWORD, role: 'candidate' });

  const mine = (await api('get', '/bootstrap')).data || {};
  const notes = mine.notifications || [];
  const seen = notes.map((n) => `${n.title || ''} ${n.message || ''}`).join(' | ');

  check(notes.length > 0, `  ${notes.length} notification(s) reached their portal`);
  for (const want of [...new Set(expected)]) {
    check(seen.includes(want), `  they were told "${want}"`);
  }
  check(/selected/i.test(seen), '  and that they were Selected');
  check(!FORBIDDEN.test(seen),
    '  NOTHING they can read says "client"'
    + (FORBIDDEN.test(seen) ? `: ${JSON.stringify(seen.slice(0, 140))}` : ''));

  /* The rail they are shown, built the way the screen builds it. */
  const rail = await page.evaluate(() => {
    if (typeof window.tlStageTrack !== 'function') return { skipped: true };
    return { html: window.tlStageTrack({ id: 'probe', stage: 'client_review' },
      { only: window.tlCandidateStages(), audience: 'candidate' }) };
  });
  if (!rail.skipped) {
    check(!/clients?/i.test(rail.html), '  and their pipeline rail does not either');
  }

  const history = (await api('get', `/applications/${applicationId}/history`)).history || [];
  check(history.length >= CHAIN.length,
    `  the stage history recorded every move (${history.length})`);
} catch (e) {
  check(false, `the run failed (${e.message})`);
} finally {
  console.log('\nCleaning up\n');
  try {
    await api('post', '/auth/logout', {}).catch(() => {});
    await login('admin');
    if (candidateId) {
      const gone = await api('post', '/admin/purge-test-candidate', { candidateId })
        .catch((err) => ({ removed: false, error: err.message }));
      check(gone?.removed === true, `  removed the probe candidate (${EMAIL})`);
    }
    const left = ((await api('get', '/candidates?limit=500')).candidates || [])
      .filter((c) => /@example\.test$/i.test(c.email || ''));
    check(left.length === 0, `  no probe candidate is left behind (${left.length})`);
  } catch (e) {
    check(false, `CLEANUP FAILED — remove ${EMAIL} by hand (${e.message})`);
  }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
  await browser.close();
  console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
  process.exit(fail.length ? 1 : 0);
}
