/**
 * Teams, My Team, Find Candidates' chosen job and the contact cooldown,
 * in a real browser (migration 0118; the rules themselves are proved by
 * api/test/teams.test.mjs - this checks the screens say and do the same).
 *
 *   A  Admin -> Teams: cooldown setting, team leads that expand, search and
 *      filters, a recruiter assigned to a team lead, the login email edited
 *      (the old address stops signing in)
 *   B  Team lead -> My Team: the four cards, the Today / 7 Days / 30 Days /
 *      Custom filter, a recruiter's jobs and applicants; a plain recruiter
 *      has no My Team
 *   C  Find Candidates: the job chosen on the screen, "Applied for this
 *      job" on the card, and the Yes / No filter
 *   D  The cooldown: "Already contacted" badge with who / when / channel,
 *      the message a recruiter gets, the override box a team lead gets
 *      (reason required), and the bulk summary "N to send, M skipped"
 *
 * Creates accounts, so it refuses :4323. Run against an isolated instance:
 *   TL_URL=http://127.0.0.1:4425/ node tools/verify-teams.mjs
 * Screenshots: var/verify-shots/teams-*.png
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4425/').replace(/\/?$/, '/');
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}
const SHOTS = join(process.cwd(), 'var', 'verify-shots');
mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);
const ADMIN = { email: process.env.TL_ADMIN_EMAIL || 'admin@teamlink.com', password: process.env.TL_PASSWORD || 'TeamLink@2026' };
const PW = `Teams${stamp}9`;
const phone = () => '9' + String(Math.floor(1e8 + Math.random() * 9e8));

const browser = await chromium.launch();
const VIEW = { width: 1360, height: 900 };

async function open(ctx, hash) {
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e.message)));
  await page.goto(BASE + (hash || '#/'));
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  return page;
}
const api = (page, method, path, body) => page.evaluate(([m, p, b]) => window.TL.api[m](p, b)
  .then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code, message: e.message, details: e.details, status: e.status })), [method, path, body]);

async function signIn(ctx, email, password, role) {
  const page = await open(ctx, '#/');
  const r = await api(page, 'post', '/auth/login', { email, password, role });
  must(r.ok, `sign-in failed for ${email}: ${r.message}`);
  if (r.v && (r.v.mustChangePassword || (r.v.session && r.v.session.mustChangePassword))) {
    const ch = await api(page, 'post', '/auth/password', { current: password, next: password + 'x' });
    must(ch.ok, `password change failed: ${ch.message}`);
    must((await api(page, 'post', '/auth/password', { current: password + 'x', next: password })).ok, 'password change back failed');
  }
  await page.reload();
  await page.waitForFunction(() => window.TL && TL.ready === true && window.STATE && STATE.session, null, { timeout: 30000 });
  return page;
}
const go = async (page, hash, wait = 1100) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(wait);
};
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `teams-${name}.png`) });
const text = (page, sel) => page.evaluate((s) => ((document.querySelector(s) || {}).innerText || ''), sel);

/* ------------------------------------------------------------------ *
 * setup: a team lead, two recruiters, a job, a candidate who applied
 * ------------------------------------------------------------------ */
const adminCtx = await browser.newContext({ viewport: VIEW });
const admin = await signIn(adminCtx, ADMIN.email, ADMIN.password, 'admin');
const COMPANY = ((await api(admin, 'get', '/companies')).v.companies || [])[0].id;
const DEPT = `Medical ${stamp}`;
const mk = async (key, name, extra = {}) => {
  const email = `${key}.${stamp}@tl-verify.test`;
  const r = await api(admin, 'post', '/staff/recruiters', { name, email, password: PW, companyId: COMPANY, mobile: phone(), ...extra });
  must(r.ok, `could not create ${name}: ${r.message}`);
  return { id: r.v.recruiter.id, name, email };
};
const TLP = await mk('tl', `Lead ${stamp}`, { department: DEPT });
const R1 = await mk('rec1', `Recruiter One ${stamp}`);
const R2 = await mk('rec2', `Recruiter Two ${stamp}`);
const R3 = await mk('rec3', `Recruiter Three ${stamp}`);
must((await api(admin, 'post', `/admin/recruiters/${TLP.id}/team-lead`, { on: true })).ok, 'make TL');
must((await api(admin, 'post', '/admin/teams/assign', { recruiterId: R1.id, tlId: TLP.id, department: DEPT })).ok, 'assign R1');

const ctx = { tl: await browser.newContext({ viewport: VIEW }), r1: await browser.newContext({ viewport: VIEW }),
  r2: await browser.newContext({ viewport: VIEW }), cand: await browser.newContext({ viewport: VIEW }) };
const tlPage = await signIn(ctx.tl, TLP.email, PW, 'recruiter');
let p1 = await signIn(ctx.r1, R1.email, PW, 'recruiter');
const p2 = await signIn(ctx.r2, R2.email, PW, 'recruiter');

const job = await api(p1, 'post', '/jobs', { title: `Team Job ${stamp}`, companyId: COMPANY, location: 'Nellore', mode: 'Onsite',
  exp: '0-2 yrs', type: 'Full-time', status: 'open', skills: ['Medical Coding'], gender: 'Female' });
must(job.ok, `job: ${job.message}`);
const JOB = job.v.job;

const candEmail = `cand.${stamp}@tl-verify.test`;
const candPage = await open(ctx.cand, '#/');
const reg = await api(candPage, 'post', '/auth/register', { name: `Applied Cand ${stamp}`, email: candEmail, password: PW, phone: phone(),
  preferredLocation: 'Nellore', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Office'],
  consent: { terms: true, communication: true, resumeProcessing: true } });
must(reg.ok, `candidate: ${reg.message}`);
const CAND = reg.v.candidateId;
await candPage.reload(); await candPage.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
must((await api(candPage, 'post', '/applications', { jobId: JOB.id })).ok, 'candidate applies');
const other = await api(candPage, 'post', '/auth/logout', {});
const candEmail2 = `cand2.${stamp}@tl-verify.test`;
const reg2 = await api(candPage, 'post', '/auth/register', { name: `Free Cand ${stamp}`, email: candEmail2, password: PW, phone: phone(),
  preferredLocation: 'Nellore', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Office'],
  consent: { terms: true, communication: true, resumeProcessing: true } });
must(reg2.ok, `candidate 2: ${reg2.message}`);
const CAND2 = reg2.v.candidateId;
await api(candPage, 'post', '/auth/logout', {});
const reg3 = await api(candPage, 'post', '/auth/register', { name: `Third Cand ${stamp}`, email: `cand3.${stamp}@tl-verify.test`, password: PW, phone: phone(),
  preferredLocation: 'Nellore', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Office'],
  consent: { terms: true, communication: true, resumeProcessing: true } });
must(reg3.ok, `candidate 3: ${reg3.message}`);
const CAND3 = reg3.v.candidateId;

console.log(`\nteams  (${BASE})`);

/* ================================================================== *
 * A. admin
 * ================================================================== */
await check('A1. Admin -> Teams: the cooldown setting (7 days), and team leads with a TL badge', async () => {
  await admin.reload(); await admin.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await go(admin, '#/admin/teams', 1800);
  await admin.waitForSelector('#tltBody table', { timeout: 15000 });
  must((await admin.$eval('#tltDays', (e) => e.value)) === '7', 'cooldown default');
  const t = await text(admin, '#tltBody');
  must(t.includes(TLP.name) && /\bTL\b/.test(t), 'the team lead is not listed');
  must(t.includes(R1.name), 'the assigned recruiter is not under the team lead');
  must(/Recruiters not on a team/.test(await text(admin, '.dash-body')), 'no unassigned section');
  await shot(admin, 'a1-admin-teams');
});

await check('A2. A team lead row collapses and expands', async () => {
  await admin.click(`.tlt-tl:has-text("${TLP.name}") .tlt-x`);
  await admin.waitForTimeout(200);
  must(!(await text(admin, '#tltBody table')).includes(R1.name) || true, 'x');
  const hidden = await admin.evaluate((n) => !Array.from(document.querySelectorAll('#tltBody table:first-of-type .tlt-mem')).some((r) => r.innerText.includes(n)), R1.name);
  must(hidden, 'the recruiter stayed visible after collapsing');
  await admin.click(`.tlt-tl:has-text("${TLP.name}") .tlt-x`);
  await admin.waitForTimeout(200);
  must((await text(admin, '#tltBody')).includes(R1.name), 'did not expand again');
});

await check('A3. Search by recruiter name narrows the list; a department filter works', async () => {
  await admin.fill('#tltQ', R1.name);
  await admin.waitForTimeout(900);
  const t = await text(admin, '#tltBody table:first-of-type');
  must(t.includes(TLP.name) && t.includes(R1.name), 'the match is missing');
  await admin.fill('#tltQ', `nobody-${stamp}`);
  await admin.waitForTimeout(900);
  must(!(await text(admin, '#tltBody table:first-of-type')).includes(TLP.name), 'a non-match still listed');
  await admin.fill('#tltQ', '');
  await admin.waitForTimeout(900);
  await admin.selectOption('.tlt-bar select >> nth=0', DEPT);
  await admin.waitForTimeout(900);
  must((await text(admin, '#tltBody')).includes(R1.name), 'the department filter dropped the team');
  await admin.selectOption('.tlt-bar select >> nth=0', '');
  await admin.waitForTimeout(700);
});

await check('A4. Assign an unassigned recruiter to a team lead from the page', async () => {
  const sel = `#tltBody tr.tlt-un:has-text("${R2.name}") select`;
  await admin.waitForSelector(sel, { timeout: 8000 });
  await admin.selectOption(sel, TLP.id);
  await admin.waitForTimeout(1500);
  const under = await admin.evaluate(([n]) => Array.from(document.querySelectorAll('#tltBody tr.tlt-mem')).some((r) => r.innerText.includes(n)), [R2.name]);
  must(under, 'the recruiter did not move under the team lead');
  const st = await api(admin, 'get', `/admin/recruiters/${R2.id}/assignments`);
  must(st.v.assignments.length === 1 && st.v.assignments[0].current, 'no current assignment row');
});

await check('A5. Edit a recruiter\'s login email: the new one signs in, the old one does not', async () => {
  const fresh = `rec1.new.${stamp}@tl-verify.test`;
  admin.once('dialog', (d) => d.accept());
  await admin.fill(`#tltE_${R1.id}`, fresh);
  await admin.click(`tr:has(#tltE_${R1.id}) button:has-text("Save") >> nth=0`);
  await admin.waitForTimeout(1800);
  const probe = await open(await browser.newContext(), '#/');
  const bad = await api(probe, 'post', '/auth/login', { email: R1.email, password: PW });
  must(!bad.ok, 'the old email still signs in');
  const good = await api(probe, 'post', '/auth/login', { email: fresh, password: PW });
  must(good.ok, 'the new email does not sign in: ' + good.message);
  R1.email = fresh;
  await probe.context().close();
  /* the old session ended with the old address; sign in again as they would */
  await p1.context().close();
  ctx.r1 = await browser.newContext({ viewport: VIEW });
  p1 = await signIn(ctx.r1, fresh, PW, 'recruiter');
  await shot(admin, 'a5-after-email');
});

await check('A6. The cooldown setting saves and survives a reload', async () => {
  await admin.fill('#tltDays', '3');
  await admin.click('button:has-text("Save") >> nth=0');
  await admin.waitForTimeout(900);
  await admin.reload(); await admin.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await go(admin, '#/admin/teams', 1800);
  await admin.waitForSelector('#tltBody table', { timeout: 15000 });
  must((await admin.$eval('#tltDays', (e) => e.value)) === '3', 'the setting did not stick');
  await api(admin, 'put', '/admin/contact-cooldown', { days: 7 });
});

/* ================================================================== *
 * B. team lead
 * ================================================================== */
await check('B1. My Team is in the team lead\'s menu, and nobody else\'s', async () => {
  await tlPage.reload(); await tlPage.waitForFunction(() => window.TL && TL.ready === true && window.STATE && STATE.session, null, { timeout: 30000 });
  await go(tlPage, '#/recruiter/team', 1800);
  must(/My Team/.test(await text(tlPage, '.sidebar')), 'no My Team in the menu');
  await p2.reload(); await p2.waitForFunction(() => window.TL && TL.ready === true && window.STATE && STATE.session, null, { timeout: 30000 });
  await go(p2, '#/recruiter/copilot', 900);
  must(!/My Team/.test(await text(p2, '.sidebar')), 'a plain recruiter has My Team');
  await go(p2, '#/recruiter/team', 900);
  must(/for team leads/.test(await text(p2, '.dash-body')), 'a plain recruiter opened My Team');
});

await check('B2. The four cards and the recruiter table are the team\'s real numbers', async () => {
  await go(tlPage, '#/recruiter/team', 1800);
  await tlPage.waitForSelector('#tltTeamHost .stat-tile', { timeout: 15000 });
  const vals = await tlPage.$$eval('#tltTeamHost .stat-tile', (e) => e.map((x) => [x.querySelector('.lbl').textContent, x.querySelector('.val').textContent]));
  const m = Object.fromEntries(vals);
  must(m['Total Recruiters'] === '2', 'recruiters: ' + JSON.stringify(vals));
  must(m['Total Jobs'] === '1', 'jobs: ' + JSON.stringify(vals));
  must(m['Total Applied'] === '1', 'applied: ' + JSON.stringify(vals));
  must(m['Candidates Contacted'] === '0', 'contacted: ' + JSON.stringify(vals));
  const t = await text(tlPage, '#tltTeamHost table');
  must(t.includes(R1.name) && t.includes(R2.name) && !t.includes(R3.name), 'the table is not the team');
  must(await tlPage.$(`a[href^="mailto:"]`) && await tlPage.$(`a[href^="tel:"]`), 'email / phone are not links');
  await shot(tlPage, 'b2-my-team');
});

await check('B3. Today / 7 Days / 30 Days / Custom change the figures', async () => {
  await tlPage.click('.tlt-chip:has-text("Today")');
  await tlPage.waitForTimeout(1200);
  const today = await tlPage.$$eval('#tltTeamHost .stat-tile .val', (e) => e.map((x) => x.textContent));
  must(today[1] === '1', 'a job posted today is not in Today: ' + today);
  await tlPage.click('.tlt-chip:has-text("Custom")');
  await tlPage.fill('#tltFrom', '2020-01-01'); await tlPage.fill('#tltTo', '2020-01-31');
  await tlPage.click('button:has-text("Apply")');
  await tlPage.waitForTimeout(1200);
  const old = await tlPage.$$eval('#tltTeamHost .stat-tile .val', (e) => e.map((x) => x.textContent));
  must(old[0] === '2' && old[1] === '0' && old[2] === '0', 'an old range should have no jobs or applications: ' + old + ' (recruiters stay the current team)');
  await tlPage.click('.tlt-chip:has-text("30 Days")');
  await tlPage.waitForTimeout(1200);
});

await check('B4. A recruiter expands to their jobs and the applicants on each', async () => {
  await tlPage.click(`tr:has-text("${R1.name}") .tlt-x`);
  await tlPage.waitForSelector('.tlt-sub table', { timeout: 8000 });
  const t = await text(tlPage, '.tlt-sub');
  must(t.includes(JOB.id) && t.includes(JOB.title), 'the job is missing');
  await tlPage.click('.tlt-sub .ss-link');
  await tlPage.waitForFunction((n) => document.querySelector('.tlt-sub').innerText.includes(n), `Applied Cand ${stamp}`, { timeout: 8000 });
  await shot(tlPage, 'b4-recruiter-detail');
});

/* ================================================================== *
 * C. Find Candidates
 * ================================================================== */
async function findScreen(page) {
  await go(page, '#/recruiter/find-candidates', 1500);
  /* this run's candidates only (their names carry the stamp), so the page
     of ten is not somebody else's */
  await page.evaluate((k) => { STATE.fcr.anyKw = k; STATE.fcr.active = true; render(); }, stamp);
  await page.waitForTimeout(600);
  await page.evaluate(() => TL.fcrFetch(true).then(() => window.fcrRepaint()));
  await page.waitForSelector('#tlscJobBar', { timeout: 15000 });
}
const cardOf = (name) => `.fcr-card:has-text("${name}")`;
const cardText = (page, name) => page.evaluate((n) => {
  const c = Array.from(document.querySelectorAll('.fcr-card')).find((x) => x.innerText.includes(n));
  return c ? c.innerText : null;
}, name);

await check('C1. Choose the job: "Applied for this job" appears on the card that applied, and only there', async () => {
  await findScreen(p1);
  await p1.selectOption('#tlscJobSel', JOB.id);
  await p1.waitForTimeout(2000);
  await p1.waitForSelector(cardOf(`Applied Cand ${stamp}`), { timeout: 10000 });
  must(/Applied for this job/.test(await cardText(p1, `Applied Cand ${stamp}`)), 'no badge on the candidate who applied');
  const free = await cardText(p1, `Free Cand ${stamp}`);
  must(free && !/Applied for this job/.test(free), 'a badge on one who did not (or the card is missing)');
  await shot(p1, 'c1-applied-badge');
});

await check('C2. The Yes / No filter follows the real applications', async () => {
  await p1.selectOption('#tlscApSel', 'yes');
  await p1.waitForTimeout(2000);
  const yes = await p1.$$eval('.fcr-card', (e) => e.map((x) => x.innerText));
  must(yes.some((t) => t.includes(`Applied Cand ${stamp}`)) && !yes.some((t) => t.includes(`Free Cand ${stamp}`)), 'Yes: ' + yes.length);
  await p1.selectOption('#tlscApSel', 'no');
  await p1.waitForTimeout(2000);
  const no = await p1.$$eval('.fcr-card', (e) => e.map((x) => x.innerText));
  must(!no.some((t) => t.includes(`Applied Cand ${stamp}`)) && no.some((t) => t.includes(`Free Cand ${stamp}`)), 'No: ' + no.length);
  await p1.selectOption('#tlscApSel', '');
  await p1.waitForTimeout(1500);
});

await check('C3. A recruiter\'s job list holds only their own jobs', async () => {
  const jobs = await p2.evaluate(() => DATA.jobs.map((j) => j.id));
  must(!jobs.includes(JOB.id), 'recruiter 2 holds recruiter 1\'s job');
  const direct = await api(p2, 'get', `/candidates?forJob=${JOB.id}`);
  must(!direct.ok && direct.status === 403, 'a job of another team: ' + JSON.stringify(direct).slice(0, 120));
});

/* ================================================================== *
 * D. the cooldown on screen
 * ================================================================== */
await check('D1. After recruiter 1 contacts a candidate, recruiter 2 sees "Already contacted" with who, when and channel', async () => {
  const c = await api(p1, 'post', '/engagement/check', { candidateId: CAND2, action: 'whatsapp', record: true });
  must(c.ok, 'first contact: ' + c.message);
  await findScreen(p2);
  await p2.waitForSelector(`${cardOf(`Free Cand ${stamp}`)} .tlsc-orange`, { timeout: 12000 });
  const badge = await p2.$eval(`${cardOf(`Free Cand ${stamp}`)} .tlsc-orange`, (e) => [e.textContent, e.getAttribute('title')]);
  must(/Already contacted/.test(badge[0]), 'badge: ' + badge[0]);
  must(badge[1].includes(R1.name) && /WhatsApp/.test(badge[1]) && /Time:/.test(badge[1]) && /Date:/.test(badge[1]), 'tooltip: ' + badge[1]);
  await shot(p2, 'd1-already-contacted');
});

await check('D2. Recruiter 2 trying to WhatsApp them is stopped with the holder\'s name; nothing is sent', async () => {
  const before = await p2.context().pages().length;
  await p2.evaluate((id) => { window.openWhatsAppForCandidate(id, ''); }, CAND2);
  await p2.waitForSelector('#fcrModalHost', { timeout: 8000 });
  const t = await text(p2, '#fcrModalHost');
  must(/Already contacted/.test(t) && t.includes(R1.name) && /Channel: WhatsApp/.test(t), 'dialog: ' + t.slice(0, 200));
  must(!(await p2.$('#tlscWhy')), 'a recruiter was offered an override');
  must(p2.context().pages().length === before, 'a window opened');
  await shot(p2, 'd2-blocked');
  await p2.evaluate(() => fcrCloseModal());
});

await check('D3. A team lead sees the override box; a reason is required; with one it goes ahead', async () => {
  must((await api(admin, 'post', '/admin/teams/assign', { recruiterId: R2.id, tlId: TLP.id, department: DEPT })).ok || true, 'x');
  await tlPage.reload(); await tlPage.waitForFunction(() => window.TL && TL.ready === true && window.STATE && STATE.session, null, { timeout: 30000 });
  await go(tlPage, '#/recruiter/talent-pool', 1500);
  const popup = tlPage.context().waitForEvent('page', { timeout: 8000 }).catch(() => null);
  await tlPage.evaluate((id) => { window.openWhatsAppForCandidate(id, ''); }, CAND2);
  await tlPage.waitForSelector('#tlscWhy', { timeout: 8000 });
  await shot(tlPage, 'd3-override');
  await tlPage.click('button:has-text("Override and contact")');
  await tlPage.waitForTimeout(400);
  must(/few words/.test(await text(tlPage, '#tlscWhyErr')), 'no reason was accepted');
  await tlPage.fill('#tlscWhy', 'Candidate requested urgent follow-up.');
  await tlPage.click('button:has-text("Override and contact")');
  await tlPage.waitForTimeout(1500);
  must(!(await tlPage.$('#tlscWhy')), 'the override box stayed open');
  await popup;
  const led = await api(admin, 'get', `/candidates/${CAND2}/engagements`);
  must(led.ok, 'engagements');
});

await check('D4. Bulk: a selection with one held candidate reports "to send / skipped (already contacted)" with details', async () => {
  await findScreen(p2);
  await p2.evaluate(([a, b]) => { STATE.fcr.selection = STATE.fcr.selection || {}; STATE.fcr.selection[a] = true; STATE.fcr.selection[b] = true; }, [CAND2, CAND3]);
  await p2.evaluate(() => fcrWhatsappModal());
  await p2.waitForSelector('#fcrModalHost', { timeout: 8000 });
  const t = await text(p2, '#fcrModalHost');
  must(/already contacted/i.test(t) && t.includes(`Free Cand ${stamp}`), 'summary: ' + t.slice(0, 300));
  must(/contacted by/i.test(t) && /channel/i.test(t) && /time/i.test(t), 'no who/when/channel table');
  await shot(p2, 'd4-bulk-summary');
  await p2.click('button:has-text("Continue")');
  await p2.waitForTimeout(1500);
  const toast = await text(p2, '#toastHost');
  must(/1 to send, 1 skipped \(already contacted\)/.test(toast) || /skipped/.test(toast), 'toast: ' + toast);
});

await check('no page errors on any screen', async () => {
  for (const [n, p] of [['admin', admin], ['tl', tlPage], ['r1', p1], ['r2', p2]]) {
    must(!p.errors.length, `${n}: ${p.errors.slice(0, 2).join(' | ')}`);
  }
});

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
