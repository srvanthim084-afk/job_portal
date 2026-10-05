/**
 * Resume score + improvement tips, in a real browser (phone and desktop).
 *
 *   1  the score page: a 0-100 ring, a label, eight section bars, at most
 *      five tips each with points and a Fix now button
 *   2  Profile shows the score card; "Fix now" opens that exact field
 *   3  the profile improves -> Re-score -> "Score improved from X to Y"
 *   4  score under 60 -> the application form shows a gentle hint line; it still applies
 *   5  a resume upload -> "Your resume scored N/100", optional (Later)
 *   6  an unreadable file -> "We could not read your resume. Try a PDF or
 *      DOCX", never a 0
 *   7  recruiter: a score badge in Talent Pool, and the 70+ filter
 *   8  recruiter: Find Candidates - ticking "Resume score 70+" asks the server
 *      (resumeScoreMin=70) and narrows the results; unticking brings them back
 *
 * Creates accounts, so it refuses :4323. Run against an isolated instance:
 *   TL_URL=http://127.0.0.1:4422/ node tools/verify-resume-score.mjs
 */
import { chromium } from 'playwright';
import { completeApplyForm, closeApplyForm } from './lib/apply-form.mjs';
import { mkdirSync } from 'node:fs';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4422/').replace(/\/?$/, '/');
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}
const SHOTS = process.env.TL_SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);
const phone = () => '9' + String(Math.floor(1e8 + Math.random() * 9e8));
const PW = process.env.DEV_PASSWORD || 'TeamLink@2026';
const RECRUITER = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';

const browser = await chromium.launch();
async function open(ctx, hash) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('        page error:', e.message));
  await page.goto(BASE + hash);
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  return page;
}
const ready = (page) => page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
const signedIn = async (page) => {
  await page.reload(); await ready(page);
  await page.waitForFunction(() => window.STATE && STATE.session, null, { timeout: 15000 });
  await page.waitForTimeout(600);
};
const go = async (page, hash) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(1200);
  await page.evaluate(() => { document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((b) => b.click()); });
};
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

async function newCandidate(ctx, tag) {
  const p = await open(ctx, '#/');
  const id = await p.evaluate((b) => TL.api.post('/auth/register', b).then((r) => r.candidateId, (e) => 'ERR ' + e.message), {
    name: `Score ${tag} ${stamp}`, email: `score.${tag}.${stamp}@tl-verify.test`, password: `Score${stamp}9`, phone: phone(),
    preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  if (String(id).startsWith('ERR')) throw new Error(id);
  await signedIn(p);
  return { p, id };
}

/* A recruiter job to apply to. */
const rc = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const rp = await open(rc, '#/');
await rp.evaluate(({ e, p }) => TL.api.post('/auth/login', { email: e, password: p }), { e: RECRUITER, p: PW });
await signedIn(rp);
const job = await rp.evaluate(async (s) => {
  const boot = await TL.api.get('/bootstrap');
  const myCo = ((boot.data.recruiters || []).find((r) => boot.session && r.id === boot.session.id) || {}).companyId; const co = (boot.data.companies || []).find((x) => x.id === myCo) || (boot.data.companies || [])[0];
  const j = await TL.api.post('/jobs', { title: `Accounts Assistant ${s}`, companyId: co.id, location: 'Hyderabad',
    mode: 'Onsite', exp: '0-2 yrs', pay: '₹3 LPA', salaryMin: 3, salaryMax: 3, type: 'Full-time',
    status: 'open', skills: ['Tally ERP', 'GST', 'Excel'], description: 'Verification job - safe to delete.' });
  /* Every new job gets the six standard screening questions (0097). This
     script tests the resume-score hint, so its job asks none; the questions
     path is verify-screening-questions.mjs. */
  await TL.api.put(`/jobs/${j.job.id}/screening-questions`, { questions: [] });
  return { id: j.job.id, title: j.job.title };
}, stamp);

const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const A = await newCandidate(phoneCtx, 'a');

console.log(`\nresume score  (${BASE})`);

let first = null;
await check('1. the score page: ring, label, eight sections, at most five tips', async () => {
  await go(A.p, '#/candidate/resume-score');
  await A.p.waitForSelector('.tlrs-ring', { timeout: 15000 });
  const info = await A.p.evaluate(() => ({
    total: Number((document.querySelector('.tlrs-ring .n b') || {}).textContent),
    label: (document.querySelector('.tlrs-lbl') || {}).textContent,
    sections: document.querySelectorAll('.tlrs-sec .bar').length,
    tips: document.querySelectorAll('.tlrs-tips .tlrs-tip').length,
    fix: Array.from(document.querySelectorAll('.tlrs-tip button')).map((b) => b.textContent),
    gains: Array.from(document.querySelectorAll('.tlrs-tip .tlrs-gain')).map((b) => b.textContent),
  }));
  must(info.total >= 0 && info.total <= 100, 'total ' + info.total);
  must(['Needs Work', 'Good', 'Strong', 'Excellent'].includes(info.label), 'label ' + info.label);
  must(info.sections === 8, 'sections ' + info.sections);
  must(info.tips > 0 && info.tips <= 5, 'tips ' + info.tips);
  must(info.gains.every((g) => /^\+\d+ points$/.test(g)), info.gains.join(','));
  must(info.fix.some((t) => /Fix now|Upload resume/.test(t)), 'no Fix now');
  first = info.total;
  await shot(A.p, 'score-page-phone');
});

await check('2. Profile shows the score; "Fix now" opens that exact field', async () => {
  await go(A.p, '#/candidate/profile');
  await A.p.waitForSelector('#tlrsMini .tlrs-ring', { timeout: 15000 });
  await shot(A.p, 'score-profile-phone');
  const field = await A.p.evaluate(() => {
    const s = TLResumeScore.get();
    const t = (s.tips || []).find((x) => ['skills', 'summary', 'education', 'basic', 'certifications', 'projects'].includes(x.field));
    tlrsFix(t.field);
    return t.field;
  });
  await A.p.waitForTimeout(900);
  const open = await A.p.evaluate((f) => {
    const tl = document.querySelector(`[data-tlps="${f}"] .cpe-form`);
    const cap = Array.from(document.querySelectorAll('.cap-card')).find((c) => c.querySelector('.cpe-form'));
    const head = cap ? (cap.querySelector('.cap-bh h4') || {}).textContent : '';
    return { tl: !!tl, head };
  }, field);
  const want = { skills: /Key skills/, summary: /Profile summary/, education: /Education/, basic: /Basic details/, certifications: /Certification/, projects: /Projects/ };
  must(open.tl || want[field].test(open.head || ''), `field ${field} did not open (open card: ${open.head})`);
  await shot(A.p, 'score-fix-now-phone');
});

await check('3. the profile improves -> Re-score -> "Score improved from X to Y"', async () => {
  const r = await A.p.evaluate((id) => TL.api.put(`/candidates/${id}`, {
    location: 'Hyderabad', summary: 'Accounts assistant with 2 years of GST filing and Tally ERP. Handled 120 invoices a day and cut billing errors by 15%.',
    skills: ['Tally ERP', 'GST', 'Excel', 'Accounts Payable', 'Bank Reconciliation', 'TDS', 'Invoicing', 'MS Excel pivot tables'],
    certifications: ['Tally Prime', 'GST Practitioner'], education: 'B.Com, Osmania University, 2022', preferredRole: 'Accounts Assistant',
  }).then(() => 'ok', (e) => e.message), A.id);
  must(r === 'ok', r);
  await go(A.p, '#/candidate/resume-score');
  await A.p.waitForSelector('.tlrs-ring');
  await A.p.evaluate(() => tlrsRescore());
  await A.p.waitForSelector('.tlrs-msg.good', { timeout: 15000 });
  const msg = await A.p.evaluate(() => document.querySelector('.tlrs-msg.good').textContent);
  const m = /Score improved from (\d+) to (\d+)/.exec(msg);
  must(m && Number(m[2]) > Number(m[1]), msg);
  await shot(A.p, 'score-improved-phone');
});

const deskCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const B = await newCandidate(deskCtx, 'b');

await check('4. a score under 60: the application form shows a gentle hint, and applying still works', async () => {
  /* The hint is for a profile that is complete but thin. A profile still
     missing what one-click apply needs gets "Fill N things to apply"
     instead (one nudge, not two) - so B gets those things, thinly. */
  await B.p.evaluate(async ({ id }) => {
    await TL.api.put('/candidates/' + id, { skills: ['Excel'], exp: '1 yr', expYears: 1 });
    await TL.uploadResume(new File(['Score B Candidate, Hyderabad. Looking for an accounts assistant job. Excel.'], 'resume.txt', { type: 'text/plain' }));
    await TL.refresh();
  }, { id: B.id });
  await B.p.evaluate(() => TLResumeScore.load(true));
  await B.p.waitForTimeout(1500);
  const left = await B.p.evaluate(() => TLPortalUpgrades.missing());
  must(!left.length, 'still missing for one-click: ' + left.join(', '));
  const s = await B.p.evaluate(() => TLResumeScore.load(true));
  must(s && s.status === 'scored' && s.total < 60, 'score ' + (s && s.total));
  await go(B.p, `#/job/${job.id}`);
  /* Since 0106 the hint is one line inside the application form
     (teamlink-walkin-jobs.js) rather than a pop-up before it. */
  await B.p.evaluate((id) => { applyToJob(id); }, job.id);
  await B.p.waitForSelector('#tlafForm .tlaf-hint', { timeout: 8000 });
  const text = await B.p.evaluate(() => document.querySelector('#tlafForm .tlaf-hint').innerText);
  must(/resume score is \d+\/100/.test(text) && /Improve it/.test(text), text);
  await shot(B.p, 'score-apply-hint');
  const done = await completeApplyForm(B.p);
  must(done.state === 'done', 'form: ' + JSON.stringify(done));
  await closeApplyForm(B.p);
  await B.p.waitForTimeout(1000);
  const n = await B.p.evaluate((id) => TL.api.get('/applications').then((o) => o.applications.filter((a) => a.jobId === id).length), job.id);
  must(n === 1, `applications: ${n}`);
});

const RESUME_TXT = `Score B Candidate\nHyderabad\nSUMMARY\nAccounts executive with 3 years in retail billing and GST returns. Handled 150 invoices a day and reduced payment delays by 20%.\nEXPERIENCE\nAccounts Executive, Retail Mart, Jan 2022 - Mar 2025\n- Managed billing for 3 stores, 150 invoices a day\n- Prepared GST returns and maintained ledgers in Tally ERP\n- Reduced vendor payment delays by 20% by following up with 40 vendors\nEDUCATION\nB.Com, Osmania University, 2021\nSKILLS\nTally ERP, GST, Excel, Accounts Payable, Bank Reconciliation, TDS, Invoicing\nCERTIFICATIONS\nTally Prime; GST Practitioner\n` + 'Worked with store managers on monthly closing and stock audits. '.repeat(20);

await check('5. a resume upload -> "Your resume scored N/100", optional', async () => {
  await go(B.p, '#/candidate/resume');
  await B.p.evaluate((t) => TL.uploadResume(new File([t], 'resume.txt', { type: 'text/plain' })), RESUME_TXT);
  await B.p.waitForSelector('#tlrsFloat', { timeout: 20000 });
  const t = await B.p.evaluate(() => document.getElementById('tlrsFloat').innerText);
  must(/Your resume scored \d+\/100/.test(t), t);
  await shot(B.p, 'score-after-upload');
  await B.p.evaluate(() => tlrsLater());
  must(await B.p.evaluate(() => !document.getElementById('tlrsFloat')), 'Later did not close it');
});

await check('6. an unreadable file -> the message, never a 0', async () => {
  // A one-pixel PNG: stored, but there is no text to read.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  await B.p.evaluate((b64) => {
    const bin = atob(b64); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) u[i] = bin.charCodeAt(i);
    return TL.uploadResume(new File([u], 'photo.png', { type: 'image/png' }));
  }, png);
  await B.p.waitForSelector('#tlrsFloat', { timeout: 20000 });
  const t = await B.p.evaluate(() => document.getElementById('tlrsFloat').innerText);
  must(t.includes('We could not read your resume. Try a PDF or DOCX'), t);
  const s = await B.p.evaluate(() => TLResumeScore.get());
  must(s.status === 'unreadable' && s.total == null, JSON.stringify(s).slice(0, 120));
  await B.p.evaluate(() => tlrsLater());
  await go(B.p, '#/candidate/resume-score');
  const page = await B.p.evaluate(() => document.querySelector('.cp-wrap').innerText);
  must(page.includes('We could not read your resume') && !/\b0\s*\/\s*100\b/.test(page), 'page: ' + page.slice(0, 200));
  await shot(B.p, 'score-unreadable');
  // Put the readable one back for the recruiter checks.
  await B.p.evaluate((t2) => TL.uploadResume(new File([t2], 'resume.txt', { type: 'text/plain' })), RESUME_TXT);
  await B.p.waitForTimeout(3000);
});

await check('7. recruiter: a score badge in Talent Pool, and the 70+ filter', async () => {
  await rp.reload(); await ready(rp);
  await go(rp, '#/recruiter/talent-pool');
  await rp.evaluate((n) => { tpSet('q', n); }, `Score b ${stamp}`);
  await rp.waitForSelector('[data-tlrs-b]', { timeout: 15000 });
  /* read it in one step: the list repaints when the badges land, and the element found a moment ago can be gone */
  const badge = await (await rp.waitForFunction(() => { const b = document.querySelector('[data-tlrs-b]'); return b && b.textContent; },
    null, { timeout: 15000 })).jsonValue();
  must(/\d+/.test(badge), badge);
  await shot(rp, 'score-talent-pool');
  const total = await rp.evaluate(() => STATE.talentPool.total);
  must(total === 1, 'pool total ' + total);
  must(await rp.evaluate(() => !!document.querySelector('#tlrsFilter input')), 'no 70+ filter');
  const score = Number(badge.replace(/\D/g, ''));
  await rp.evaluate(() => tlrsSetMin(true));
  await rp.waitForTimeout(2500);
  const after = await rp.evaluate(() => STATE.talentPool.total);
  must(after === (score >= 70 ? 1 : 0), `with 70+: ${after} (score ${score})`);
  await rp.evaluate(() => tlrsSetMin(false));
  await rp.waitForTimeout(1500);
});

await check('8. recruiter: Find Candidates, the 70+ filter narrows the results on the server', async () => {
  /* Both of this run's candidates ("Score a ..." and "Score b ..."), found by the stamp in their names. */
  const sent = [];
  const onReq = (req) => { const u = req.url(); if (/\/api\/candidates\?/.test(u)) sent.push(u); };
  rp.on('request', onReq);
  try {
    await go(rp, '#/recruiter/find-candidates');
    await rp.evaluate(() => { if (typeof window.runCandidateSearch === 'function') runCandidateSearch(); });
    await rp.waitForTimeout(1200);
    await rp.evaluate((s) => fcrSet('anyKw', s), stamp);
    await rp.waitForFunction((s) => window.TL && TL.fcr && !TL.fcr.loading && (TL.fcr.rows || []).some((c) => String(c.name).includes(s)),
      stamp, { timeout: 15000 });
    await rp.waitForTimeout(800);
    const before = await rp.evaluate((s) => ({
      total: TL.fcr.total, ids: TL.fcr.rows.filter((c) => String(c.name).includes(s)).map((c) => c.id),
      cards: Array.from(document.querySelectorAll('.fcr-card')).filter((x) => x.innerText.includes(s)).length,
    }), stamp);
    must(before.ids.length === 2 && before.cards === 2, `before the filter: ${JSON.stringify(before)}`);
    const scores = await rp.evaluate((ids) => TL.api.get('/resume-scores?ids=' + ids.join(',')).then((o) => o.scores || {}), before.ids);
    const high = before.ids.filter((id) => scores[id] && scores[id].status === 'scored' && scores[id].total >= 70);
    await rp.waitForSelector('#tlrsFilter input', { timeout: 10000 });
    await shot(rp, 'score-find-candidates-before');
    sent.length = 0;
    await rp.click('#tlrsFilter input');                      // the real checkbox, as a recruiter ticks it
    await rp.waitForFunction(() => window.TL && TL.fcr && !TL.fcr.loading, null, { timeout: 15000 });
    await rp.waitForTimeout(1500);
    must(sent.some((u) => /[?&]resumeScoreMin=70(&|$)/.test(u)), 'the server was not asked with resumeScoreMin=70: ' + sent.join(' | '));
    const after = await rp.evaluate((s) => ({
      ids: (TL.fcr.rows || []).filter((c) => String(c.name).includes(s)).map((c) => c.id),
      cards: Array.from(document.querySelectorAll('.fcr-card')).filter((x) => x.innerText.includes(s)).length,
      checked: !!(document.querySelector('#tlrsFilter input') || {}).checked,
    }), stamp);
    await shot(rp, 'score-find-candidates-70');
    must(after.checked, 'the checkbox did not stay ticked after the repaint');
    must(after.ids.slice().sort().join() === high.slice().sort().join() && after.cards === high.length,
      `with 70+: ${JSON.stringify(after)}; scores ${JSON.stringify(before.ids.map((id) => scores[id] && scores[id].total))}`);
    must(after.ids.length < before.ids.length, `the filter did not narrow (${before.ids.length} -> ${after.ids.length})`);
    console.log(`        Find Candidates: ${before.ids.length} -> ${after.ids.length} with 70+ (scores ${before.ids.map((id) => (scores[id] ? scores[id].total : 'none')).join(', ')}); asked the server: resumeScoreMin=70`);
    /* and off again: both back */
    sent.length = 0;
    await rp.click('#tlrsFilter input');
    await rp.waitForFunction(() => window.TL && TL.fcr && !TL.fcr.loading, null, { timeout: 15000 });
    await rp.waitForTimeout(1500);
    must(sent.length && sent.every((u) => !/resumeScoreMin=/.test(u)), 'unticked, the server was still asked for 70+');
    const back = await rp.evaluate((s) => (TL.fcr.rows || []).filter((c) => String(c.name).includes(s)).length, stamp);
    must(back === 2, `unticked: ${back}`);
  } finally { rp.off('request', onReq); }
});

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
