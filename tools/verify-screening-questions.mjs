/**
 * Screening questions, in a real browser.
 *
 *   1  recruiter opens a job's screening questions and makes "willing to
 *      relocate" a must-have
 *   2  candidate A applies, answers "No" -> the normal success, nothing
 *      about a must-have anywhere on the page
 *   3  candidate B applies and passes
 *   4  recruiter's Applications list: red "Must-have not met" on A,
 *      "Combined n%" on B; the screening filter narrows to A
 *   5  the answers panel shows who answered and the scores
 *   6  an application that arrived without answers: the no-password link
 *      (caught by this script's own SMTP sink) opens the questions, the
 *      answers go in, and the same link then refuses a second use
 *   7  AI Job Creation: questions chosen (standard + an AI JD Generator
 *      suggestion) before publishing are saved with the new job
 *
 * Creates accounts and jobs, so it refuses :4323. Run against an isolated
 * instance whose EMAIL_SMTP_HOST/PORT point at this script's sink:
 *   TL_URL=http://localhost:4424/ TL_SINK_PORT=2604 node tools/verify-screening-questions.mjs
 * (nothing else may be listening on the sink port).
 */
import { chromium } from 'playwright';
import { SMTPServer } from 'smtp-server';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.TL_URL || 'http://localhost:4424/').replace(/\/?$/, '/');
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}
const SINK_PORT = Number(process.env.TL_SINK_PORT || 2604);
const SHOTS = process.env.TL_SHOTS || join(process.env.TEMP || '/tmp', 'tl-verify-screening');
mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);
const phone = () => '9' + String(Math.floor(1e8 + Math.random() * 9e8));

/* ---- a local SMTP sink: what the instance mails, this script reads ---- */
const mails = [];
const sink = new SMTPServer({
  authOptional: true, hideSTARTTLS: true, disabledCommands: ['STARTTLS'],
  onAuth(_a, _s, cb) { cb(null, { user: 'sink' }); },
  onData(stream, session, cb) {
    let raw = '';
    stream.on('data', (c) => { raw += c; });
    stream.on('end', () => {
      const decoded = raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16)));
      mails.push({ to: session.envelope.rcptTo.map((r) => r.address), raw: decoded });
      cb();
    });
  },
});
await new Promise((resolve, reject) => {
  sink.on('error', reject);
  sink.listen(SINK_PORT, '127.0.0.1', resolve);
});

const browser = await chromium.launch();
async function open(ctx, hash) {
  const page = await ctx.newPage();
  await page.goto(BASE + hash);
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  return page;
}
const wizardAway = (page) => page.evaluate(() => {
  document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((b) => b.click());
});
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });

/* The current-location answer offers places from the places search as you
   type (GET /api/places/search, or the link-token route on the
   no-password page). Pick one the way a person would: type, choose. */
async function pickPlace(page, sel, typed, want, shotName) {
  const input = `${sel} input[data-place]`;
  await page.fill(input, typed);
  await page.waitForSelector(`${sel} .tlsq-sug:not([hidden]) .tlsq-sugi`, { timeout: 15000 });
  if (shotName) await shot(page, shotName);
  const items = await page.$$eval(`${sel} .tlsq-sugi`, (xs) => xs.map((x) => x.textContent));
  const i = Math.max(0, items.findIndex((t) => t.startsWith(want)));
  await page.click(`${sel} [data-place-pick="${i}"]`);
  const v = await page.inputValue(input);
  must(v.startsWith(want), `picked "${v}", wanted ${want} (offered: ${items.slice(0, 4).join(' | ')})`);
  must(await page.$eval(`${sel} .tlsq-sug`, (b) => b.hidden), 'the suggestion list stayed open');
  return v;
}

/* ---- the recruiter and a job ---- */
const RECRUITER = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';
const RECRUITER_PW = process.env.TL_RECRUITER_PASSWORD || process.env.DEV_PASSWORD || 'TeamLink@2026';
const rc = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const rp = await open(rc, '#/');
const job = await rp.evaluate(async ({ e, p, s }) => {
  await TL.api.post('/auth/login', { email: e, password: p, role: 'recruiter' });
  const boot = await TL.api.get('/bootstrap');
  const myCo = ((boot.data.recruiters || []).find((r) => boot.session && r.id === boot.session.id) || {}).companyId; const co = (boot.data.companies || []).find((x) => x.id === myCo) || (boot.data.companies || [])[0];
  const j = await TL.api.post('/jobs', { title: `Field Sales Executive ${s}`, companyId: co.id, location: 'Hyderabad',
    mode: 'Onsite', exp: '1-3 yrs', pay: '₹3-4 LPA', salaryMin: 3, salaryMax: 4, type: 'Full-time', status: 'open',
    skills: ['Field Sales', 'Negotiation'], description: 'Verification job - safe to delete.' });
  return { id: j.job.id, title: j.job.title };
}, { e: RECRUITER, p: RECRUITER_PW, s: stamp });
await rp.reload();
await rp.waitForFunction(() => window.TL && TL.ready === true);

console.log(`\nscreening questions  (${BASE})`);

await check('1. recruiter makes "willing to relocate" a must-have in the job\'s question editor', async () => {
  await rp.evaluate(() => { location.hash = '#/recruiter/jobs'; });
  await rp.waitForSelector(`[data-tlsq-job="${job.id}"]`, { timeout: 15000 });
  await rp.click(`[data-tlsq-job="${job.id}"]`);
  await rp.waitForSelector('#tlsqEditor [data-text]', { timeout: 15000 });
  const idx = await rp.evaluate(() => Array.from(document.querySelectorAll('#tlsqEditor [data-text]'))
    .findIndex((i) => /willing to work/i.test(i.value)));
  must(idx >= 0, 'no relocation question');
  await rp.click(`#tlsqEditor [data-ko="${idx}"]`);
  await rp.waitForSelector('#tlsqEditor [data-rule="equals"]');
  await shot(rp, '1-editor');
  await rp.click('#tlsqEdSave');
  await rp.waitForSelector('#tlsqEditor', { state: 'detached', timeout: 10000 });
  const qs = await rp.evaluate((id) => TL.api.get(`/jobs/${id}/screening-questions`), job.id);
  const rel = qs.questions.find((q) => q.stdKey === 'relocate');
  must(rel && rel.isKnockout && rel.knockoutRule.equals === 'yes', 'the rule was not saved: ' + JSON.stringify(rel));
  must(qs.questions.length === 6, 'six questions expected');
});

async function candidateApplies(name, relocate, mobile) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 900 } });
  const p = await open(ctx, '#/');
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}.${stamp}@tl-verify.test`;
  const r = await p.evaluate((b) => TL.api.post('/auth/register', b).then((x) => x.candidateId, (e) => 'ERR ' + e.message), {
    name, email, password: `Screen${stamp}9`, phone: phone(), preferredLocation: 'Hyderabad', expectedCtc: 4,
    noticePeriod: '15 days', preferredWorkModes: ['Work From Office'] });
  must(!String(r).startsWith('ERR'), r);
  await p.reload(); await p.waitForFunction(() => window.TL && TL.ready === true); await p.waitForTimeout(800);
  await wizardAway(p);
  await p.evaluate((id) => { location.hash = '#/job/' + id; }, job.id);
  await p.waitForTimeout(1500);
  await wizardAway(p);
  const clicked = await p.evaluate(() => {
    const b = Array.from(document.querySelectorAll('#app button')).find((x) => /Apply Now|Easy Apply/.test(x.textContent) && x.offsetParent);
    if (!b) return false; b.click(); return true;
  });
  must(clicked, 'no Apply button');
  /* What stands before the questions for a brand-new candidate: one-click
     apply's "Fill N things to apply" (no resume yet) or, for a complete but
     thin profile, the resume-score hint. Past each the way a candidate in a
     hurry would go. */
  for (let i = 0; i < 4; i++) {
    const at = await p.waitForSelector('#tlsqApply .tlsq-q, #tlpuWithout, #tlrsApplyAnyway', { timeout: 15000 });
    const id = await at.evaluate((e) => e.id);
    if (id !== 'tlpuWithout' && id !== 'tlrsApplyAnyway') break;
    await at.click(); await p.waitForTimeout(800);
  }
  await p.waitForSelector('#tlsqApply .tlsq-q', { timeout: 15000 });
  const prog = await p.textContent('#tlsqApply .tlsq-progtext');
  must(/of 6 answered/.test(prog), 'no progress line: ' + prog);
  must(/[1-9] of 6/.test(prog), 'nothing was pre-filled: ' + prog);
  const fill = async (re, fn) => {
    const qid = await p.evaluate((src) => {
      const r2 = new RegExp(src, 'i');
      const el = Array.from(document.querySelectorAll('#tlsqApply [data-q]')).find((d) => r2.test(d.querySelector('label.t').textContent));
      return el ? el.getAttribute('data-q') : null;
    }, re.source);
    must(qid, 'question not found: ' + re);
    await fn(`#tlsqApply [data-q="${qid}"]`);
  };
  await fill(/current CTC/, (s) => p.fill(`${s} input`, '3'));
  await fill(/located/, (s) => pickPlace(p, s, 'Hyderab', 'Hyderabad', `2-places${mobile ? '-mobile' : ''}`));
  await fill(/willing to work/, (s) => p.click(`${s} [data-set="${relocate}"]`));
  await fill(/another consultancy/, (s) => p.click(`${s} [data-set="no"]`));
  await p.waitForTimeout(200);
  must(/6 of 6 answered/.test(await p.textContent('#tlsqApply .tlsq-progtext')), 'not all answered');
  await shot(p, `2-apply-${relocate}${mobile ? '-mobile' : ''}`);
  await p.click('#tlsqSubmit');
  await p.waitForTimeout(3500);
  await wizardAway(p);
  const apps = await p.evaluate((id) => TL.api.get('/applications').then((o) => o.applications.filter((a) => a.jobId === id)), job.id);
  must(apps.length === 1, 'not applied');
  const text = await p.evaluate(() => document.body.innerText);
  must(!/must-have|knock|not met|rejected/i.test(text), 'the candidate was told something about the must-have');
  await shot(p, `3-applied-${relocate}`);
  return { ctx, page: p, name, appId: apps[0].id, email };
}

let A, B;
await check('2. candidate A answers "No" to the must-have and sees the normal success (mobile)', async () => {
  A = await candidateApplies(`Arun Screen ${stamp}`, 'no', true);
});
await check('3. candidate B passes', async () => {
  B = await candidateApplies(`Bhavya Screen ${stamp}`, 'yes', false);
});

await check('4. the recruiter sees a red badge on A and a combined score on B; the filter narrows to A', async () => {
  await rp.evaluate(() => { location.hash = '#/recruiter/applications'; });
  await rp.waitForTimeout(1500);
  await rp.evaluate(() => TL.syncNow && TL.syncNow()).catch(() => {});
  await rp.reload(); await rp.waitForFunction(() => window.TL && TL.ready === true);
  await rp.evaluate(() => { location.hash = '#/recruiter/applications'; });
  await rp.waitForFunction((n) => Array.from(document.querySelectorAll('tr[data-tlsq-app]'))
    .some((tr) => tr.innerText.includes(n) && /Must-have not met/.test(tr.innerText)), A.name, { timeout: 20000 });
  const rowB = await rp.evaluate((n) => (Array.from(document.querySelectorAll('tr[data-tlsq-app]')).find((tr) => tr.innerText.includes(n)) || {}).innerText || '', B.name);
  must(/Combined \d+%/.test(rowB), 'no combined score on B: ' + rowB.replace(/\s+/g, ' ').slice(0, 200));
  must(!/Must-have not met/.test(rowB), 'B is flagged');
  must(/Notice: /.test(rowB) && /Exp\. CTC: /.test(rowB) && /Relocate: Yes/.test(rowB), 'notice / CTC / relocate missing on B');
  await shot(rp, '4-applications');
  await rp.selectOption('.tlsq-bar select[data-f="status"]', 'knocked_out');
  await rp.waitForTimeout(300);
  const vis = await rp.evaluate(() => Array.from(document.querySelectorAll('tr[data-tlsq-app]')).filter((tr) => tr.style.display !== 'none').map((tr) => tr.innerText));
  must(vis.length >= 1 && vis.every((t) => /Must-have not met/.test(t)), 'the filter did not narrow to must-have failures');
  await shot(rp, '4b-filtered');
  await rp.selectOption('.tlsq-bar select[data-f="status"]', '');
});

await check('5. the answers panel: scores, who answered, and the failed must-have', async () => {
  await rp.click(`[data-tlsq-open="${A.appId}"]`);
  await rp.waitForSelector('#tlsqDetail .tlsq-ans', { timeout: 10000 });
  const t = await rp.textContent('#tlsqDetail');
  must(/AI resume score/.test(t) && /Combined/.test(t), 'scores missing');
  must(/Must-have not met/.test(t), 'the flag is missing');
  must(/Answered by the candidate/.test(t), 'who answered is missing');
  await shot(rp, '5-answers-panel');
  /* "Answered on call": the location answer offers places too (not saved). */
  await rp.click('#tlsqDetail [data-act="call"]');
  await rp.waitForSelector('#tlsqCallForm input[data-place]', { timeout: 10000 });
  const callQ = await rp.$eval('#tlsqCallForm input[data-place]', (i) => i.closest('[data-q]').getAttribute('data-q'));
  await pickPlace(rp, `#tlsqCallForm [data-q="${callQ}"]`, 'Vijayaw', 'Vijayawada', '5b-call-places');
  await rp.click('#tlsqDetail .tlsq-ft [data-close]');
});

await check('6. an application without answers: the no-password link works once', async () => {
  const c = await browser.newContext();
  const p = await open(c, '#/');
  const candId = await p.evaluate((b) => TL.api.post('/auth/register', b).then((x) => x.candidateId), {
    name: `Chitra Link ${stamp}`, email: `chitra.link.${stamp}@tl-sink.local`, password: `Screen${stamp}9`, phone: phone(),
    preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'] });
  await c.close();
  const appId = await rp.evaluate(async ({ jobId, candId }) => {
    const a = await TL.api.post('/applications', { jobId, candidateId: candId, source: 'naukri' });
    await TL.api.post(`/screening/applications/${a.application.id}/reopen`, {});
    return a.application.id;
  }, { jobId: job.id, candId });
  const deadline = Date.now() + 20000;
  let link = null;
  // The sweep may have sent a link just before "Re-open" replaced it, so
  // the LAST message is the live one.
  const linksFor = () => mails.filter((x) => x.to.includes(`chitra.link.${stamp}@tl-sink.local`) && /screening-answers\//.test(x.raw));
  while (!linksFor().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  await new Promise((r) => setTimeout(r, 1500));
  const all = linksFor();
  if (all.length) link = /(https?:\/\/[^\s"<>]+#\/screening-answers\/[A-Za-z0-9_.-]+)/.exec(all[all.length - 1].raw)[1];
  must(link, 'no link email reached the sink');
  const mail = mails.find((x) => x.raw.includes(link));
  must(!/client/i.test(mail.raw.replace(/X-[^\n]*\n/g, '')), 'the email uses the word "client"');

  const anon = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const q = await anon.newPage();
  await q.goto(link.replace(/^https?:\/\/[^/]+\//, BASE));
  await q.waitForSelector('#tlsqLinkForm .tlsq-q', { timeout: 20000 });
  await shot(q, '6-link-page');
  const ids = await q.evaluate(() => Array.from(document.querySelectorAll('#tlsqLinkForm [data-q]')).map((d) => ({
    id: d.getAttribute('data-q'), text: d.querySelector('label.t').textContent,
    yn: !!d.querySelector('[data-set="yes"]'), chips: !!d.querySelector('[data-set]'), input: !!d.querySelector('input') })));
  for (const x of ids) {
    const sel = `#tlsqLinkForm [data-q="${x.id}"]`;
    if (x.yn) await q.click(`${sel} [data-set="yes"]`);
    else if (x.chips) await q.click(`${sel} [data-set="Immediate"]`);
    else if (await q.$(`${sel} input[data-place]`)) await pickPlace(q, sel, 'Nellor', 'Nellore', '6a-link-places');
    else {
      const cur = await q.inputValue(`${sel} input`);
      if (!cur) await q.fill(`${sel} input`, /CTC/i.test(x.text) ? '3' : 'Hyderabad');
    }
  }
  await q.click('#tlsqLinkSubmit');
  await q.waitForFunction(() => /Thank you/.test(document.body.innerText), null, { timeout: 15000 });
  await shot(q, '6b-link-done');
  const st = await rp.evaluate((id) => TL.api.get(`/screening/applications/${id}`), appId);
  must(st.summary.status === 'answered' || st.summary.status === 'knocked_out', 'not answered: ' + st.summary.status);
  must(st.answers.every((a) => a.source === 'link'), 'answers not recorded as from the link');

  const again = await anon.newPage();
  await again.goto(link.replace(/^https?:\/\/[^/]+\//, BASE));
  await again.waitForFunction(() => /already been answered/.test(document.body.innerText), null, { timeout: 15000 });
  await anon.close();
});

await check('7. AI Job Creation: questions chosen before publishing are saved with the new job', async () => {
  const title = `Accounts Assistant ${stamp}`;
  await rp.evaluate(() => { location.hash = '#/recruiter/jobs'; });
  await rp.waitForSelector('#njTitle', { timeout: 15000 });
  await rp.fill('#njTitle', title);
  await rp.fill('#njLoc', 'Vijayawada');
  await rp.fill('#njExp', '1-3 yrs');
  await rp.fill('#njPay', '₹3-4 LPA');
  await rp.fill('#njReqs', 'Tally, GST Filing');
  await rp.click('[data-tlsq-draft]');
  await rp.waitForSelector('#tlsqEditor [data-text]', { timeout: 15000 });
  const n0 = await rp.$$eval('#tlsqEditor [data-text]', (x) => x.length);
  must(n0 === 6, `${n0} standard questions offered`);
  // Swap "another consultancy" for the JD generator's Tally question.
  const del = await rp.evaluate(() => Array.from(document.querySelectorAll('#tlsqEditor [data-text]')).findIndex((i) => /another consultancy/.test(i.value)));
  await rp.click(`#tlsqEditor [data-del="${del}"]`);
  await rp.waitForSelector('#tlsqEditor [data-addsugg]');
  const sugg = await rp.evaluate(() => { const b = Array.from(document.querySelectorAll('#tlsqEditor [data-addsugg]')).find((x) => /Tally/.test(x.textContent)); return b ? b.getAttribute('data-addsugg') : null; });
  must(sugg !== null, 'no AI suggestion for Tally');
  await rp.click(`#tlsqEditor [data-addsugg="${sugg}"]`);
  await shot(rp, '7-draft-editor');
  await rp.click('#tlsqEdSave');
  await rp.waitForSelector('#tlsqEditor', { state: 'detached' });
  await rp.evaluate(() => window.generateJobWithAI());
  await rp.waitForTimeout(1600);
  await rp.selectOption('#njGender', { index: 1 });
  await rp.click('button:has-text("Publish job")');
  let saved = null;
  for (let i = 0; i < 30 && !saved; i += 1) {
    await rp.waitForTimeout(500);
    saved = await rp.evaluate(async (t) => {
      const j = (DATA.jobs || []).find((x) => x.title === t && !/^jnew/.test(''));
      if (!j) return null;
      const r = await TL.api.get('/jobs/' + j.id + '/screening-questions').catch(() => null);
      return r && r.questions.some((q) => /Tally/.test(q.text)) ? r.questions : null;
    }, title);
  }
  must(saved, 'the chosen questions were not saved with the job');
  must(saved.length === 6 && !saved.some((q) => q.stdKey === 'other_consultancy'), 'the saved set is not the one chosen');
});

await check('8. admin: "AI calls ask the pending screening questions" is on AI Settings, off by default, and saves', async () => {
  const ac = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const ap = await open(ac, '#/');
  await ap.evaluate(async (pw) => TL.api.post('/auth/login', { email: 'admin@teamlink.com', password: pw, role: 'admin' }), RECRUITER_PW);
  await ap.reload(); await ap.waitForFunction(() => window.TL && TL.ready === true);
  await wizardAway(ap);
  await ap.evaluate(() => { location.hash = '#/admin/ai-settings'; });
  await ap.waitForSelector('#tlsqAiCalls', { timeout: 15000 });
  const before = (await ap.evaluate(() => TL.api.get('/screening/settings'))).askOnAiCalls;
  must((await ap.isChecked('#tlsqAiCalls')) === before, 'the box does not show the stored value');
  await ap.$eval('#tlsqAiCalls', (b) => b.scrollIntoView({ block: 'center' }));
  await shot(ap, '8-admin-ai-calls');
  await ap.click('#tlsqAiCalls');
  await ap.click('#tlsqAdminSave');
  await ap.waitForTimeout(800);
  const after = (await ap.evaluate(() => TL.api.get('/screening/settings'))).askOnAiCalls;
  must(after === !before, 'not saved');
  await ap.evaluate((v) => TL.api.put('/screening/settings', { askOnAiCalls: v }), before);   // put it back
  await ac.close();
});

if (A) await A.ctx.close();
if (B) await B.ctx.close();
await rc.close();
await browser.close();
await new Promise((r) => sink.close(r));
console.log(`\nscreenshots: ${SHOTS}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
