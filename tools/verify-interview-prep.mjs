/**
 * Interview prep kit, in a real browser.
 *
 *   1  recruiter schedules an in-person interview from Schedule Interview,
 *      with a venue, duration and instructions - venue NOT released
 *   2  candidate: Interviews -> "📘 Prep Kit" -> the kit: role, round,
 *      questions, tips, bring-list; no company name anywhere in it; the
 *      venue says "will be shared"; ticks two checklist items
 *   3  recruiter's Applications list: "Kit sent ✓ · Viewed ✓ · Checklist 2 of 6"
 *   4  recruiter releases the venue in the Prep kit panel
 *   5  candidate sees the address and a Google Maps link
 *   6  the .ics has the role and no company; the old interviewPrepFor()
 *      no longer puts the company into a question
 *   7  the candidate chooses Telugu on their profile (0102): the kit's
 *      headings, tips and checklist are in Telugu, the questions stay
 *      English, the ticks are kept, and still no company name
 *
 * Creates accounts, so it refuses :4323:
 *   TL_URL=http://localhost:4424/ node tools/verify-interview-prep.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.TL_URL || 'http://localhost:4424/').replace(/\/?$/, '/');
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}
const SHOTS = process.env.TL_SHOTS || join(process.env.TEMP || '/tmp', 'tl-verify-prep');
mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);
const phone = () => '9' + String(Math.floor(1e8 + Math.random() * 9e8));
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });

const browser = await chromium.launch();
async function open(ctx, hash) {
  const page = await ctx.newPage();
  await page.goto(BASE + hash);
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  return page;
}
const ready = (p) => p.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
const wizardAway = (page) => page.evaluate(() => {
  document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((b) => b.click());
});

const RECRUITER = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';
const RECRUITER_PW = process.env.TL_RECRUITER_PASSWORD || process.env.DEV_PASSWORD || 'TeamLink@2026';

/* A client company with an unusual name, a job for it, and a candidate
   who applied. The name is what every candidate-facing check looks for. */
const ADMIN = process.env.TL_ADMIN_EMAIL || 'admin@teamlink.com';
const COMPANY = `Velmora Quartzworks ${stamp}`;
const DESK = { email: `prep.desk.${stamp}@tl-sink.local`, password: `PrepDesk${stamp}9` };
{
  const ac = await browser.newContext();
  const ap = await open(ac, '#/');
  // The company, and a recruiter on its desk: interviews are scheduled by
  // the recruiters of the job's company (the interviews policy).
  const made = await ap.evaluate(async ({ e, p, name, id, re, rpw }) => {
    await TL.api.post('/auth/login', { email: e, password: p, role: 'admin' });
    const co = await TL.api.post('/companies', { id, name }).then(() => 'ok', (err) => err.message);
    if (co !== 'ok') return co;
    return TL.api.post('/staff/recruiters', { name: 'Prep Desk Recruiter', email: re, password: rpw, companyId: id })
      .then(() => 'ok', (err) => err.message);
  }, { e: ADMIN, p: RECRUITER_PW, name: COMPANY, id: `velmora_${stamp}`, re: DESK.email, rpw: DESK.password });
  must(made === 'ok', 'could not create the client company: ' + made);
  await ac.close();
}
const rc = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const rp = await open(rc, '#/');
const job = await rp.evaluate(async ({ e, p, s, coId }) => {
  await TL.api.post('/auth/login', { email: e, password: p, role: 'recruiter' });
  // A new staff account must choose its own password first.
  await TL.api.post('/auth/password', { current: p, next: p + 'x' });
  const co = { id: coId };
  const j = await TL.api.post('/jobs', { title: `Warehouse Supervisor ${s}`, companyId: co.id, location: 'Pune',
    mode: 'Onsite', exp: '3-6 yrs', pay: '₹4-6 LPA', salaryMin: 4, salaryMax: 6, type: 'Full-time', status: 'open',
    skills: ['Inventory Management', 'WMS', 'Team Leadership'], description: 'Verification job - safe to delete.' });
  return { id: j.job.id, title: j.job.title };
}, { e: DESK.email, p: DESK.password, s: stamp, coId: `velmora_${stamp}` });
await rp.reload();
await rp.waitForFunction(() => window.TL && TL.ready === true);
job.company = COMPANY;

const cc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const cp = await open(cc, '#/');
const cand = await cp.evaluate(async ({ s, jobId, ph }) => {
  const r = await TL.api.post('/auth/register', { name: `Deepa Prep ${s}`, email: `deepa.prep.${s}@tl-verify.test`,
    password: `Prepkit${s}9`, phone: ph, preferredLocation: 'Pune', expectedCtc: 5, noticePeriod: 'Immediate',
    preferredWorkModes: ['Work From Office'] });
  const a = await TL.api.post('/applications', { jobId });
  return { id: r.candidateId, appId: a.application.id };
}, { s: stamp, jobId: job.id, ph: phone() });

const date = new Date(Date.now() + 3 * 86400000 + 330 * 60000).toISOString().slice(0, 10);
const VENUE = `Plot 14, MIDC Bhosari, Pune 411026 (${stamp})`;
let ivId;

console.log(`\ninterview prep kit  (${BASE})`);

await check('1. the recruiter schedules an in-person interview with venue, duration and instructions', async () => {
  await rp.reload(); await ready(rp);
  await rp.evaluate(() => { location.hash = '#/recruiter/applications'; });
  await rp.waitForTimeout(1500);
  await rp.evaluate(({ appId, jobId }) => window.mjInterviewModal(appId, jobId), { appId: cand.appId, jobId: job.id });
  await rp.waitForSelector('#tlpkFields', { timeout: 10000 });
  await rp.fill('#mjIvDate', date);
  await rp.fill('#mjIvTime', '11:00');
  await rp.selectOption('#mjIvMode', 'In Person');
  await rp.waitForTimeout(200);
  must(await rp.inputValue('#tlpkLoc') === 'in_person', 'the location type did not follow the mode');
  await rp.fill('#tlpkVenue', VENUE);
  await rp.fill('#tlpkDur', '45');
  await rp.fill('#tlpkInstr', 'Ask for the TeamLink desk at reception.');
  must(/may reveal the company/.test(await rp.textContent('#tlpkFields')), 'no release warning');
  await shot(rp, '1-schedule');
  await rp.click('#fcrModalHost .btn-primary, .fcr-jd-actions .btn-primary');
  await rp.waitForTimeout(2500);
  const ivs = await rp.evaluate((cid) => TL.api.get('/interviews?candidateId=' + cid), cand.id);
  must(ivs.interviews.length === 1, 'no interview');
  ivId = ivs.interviews[0].id;
  const kit = await rp.evaluate((id) => TL.api.get('/interviews/' + id + '/prep-kit'), ivId);
  must(kit.kit && kit.kit.sentAt, 'the kit was not made and sent');
  must(kit.interview.venueAddress === VENUE && kit.interview.durationMinutes === 45, 'details not saved');
  must(!kit.interview.detailsReleasedAt, 'released too early');
});

let kitText = '';
await check('2. the candidate opens the Prep Kit: no company name; venue not yet shown; ticks two items', async () => {
  await cp.reload(); await ready(cp); await wizardAway(cp);
  await cp.evaluate(() => { location.hash = '#/candidate/interviews'; });
  await cp.waitForTimeout(1500);
  await wizardAway(cp);
  const btn = await cp.$('button:has-text("Prep Kit")');
  must(btn, 'no Prep Kit button on the Interviews page');
  must(!(await cp.$('button:has-text("Prepare with AI")')), 'the old Prepare with AI button is still there');
  await btn.click();
  await cp.waitForSelector('#tlpkRoot .tlpk details', { timeout: 15000 });
  kitText = await cp.textContent('#tlpkRoot');
  must(kitText.includes(job.title), 'role title missing');
  must(!/velmora|quartzworks/i.test(kitText), `the kit names the company "${job.company}"`);
  must(!/\bclient\b/i.test(kitText), 'the kit says "client"');
  must(/will be shared here once it is confirmed/.test(kitText), 'venue placeholder missing');
  must(!kitText.includes('MIDC Bhosari'), 'the venue shows before release');
  const qn = await cp.$$eval('#tlpkRoot details', (d) => d.length);
  must(qn >= 6 && qn <= 10, `${qn} questions`);
  await cp.click('#tlpkRoot details summary');
  await shot(cp, '2-kit-mobile');
  const boxes = await cp.$$('#tlpkRoot input[data-tick]');
  must(boxes.length === 6, `${boxes.length} checklist items`);
  await boxes[0].check(); await cp.waitForTimeout(500);
  await boxes[1].check(); await cp.waitForTimeout(800);
  must(/2 of 6 ready/.test(await cp.textContent('#tlpkCount')), 'the count did not move');
  await cp.reload(); await ready(cp);
  await cp.waitForSelector('#tlpkRoot .tlpk details', { timeout: 15000 });
  must(await cp.$$eval('#tlpkRoot input[data-tick]:checked', (x) => x.length) === 2, 'ticks did not persist');
});

await check('3. the recruiter sees "Kit sent ✓ · Viewed ✓ · Checklist 2 of 6"', async () => {
  await rp.evaluate(() => { location.hash = '#/recruiter/jobs'; });
  await rp.waitForTimeout(500);
  await rp.evaluate(() => { location.hash = '#/recruiter/applications'; });
  await rp.waitForFunction((id) => {
    const tr = document.querySelector(`tr[data-tlpk-iv="${id}"]`);
    return tr && /Kit sent ✓ · Viewed ✓ · Checklist 2 of 6/.test(tr.innerText);
  }, ivId, { timeout: 25000 });
  await shot(rp, '3-recruiter-status');
});

await check('4. the recruiter releases the venue from the Prep kit panel (with the warning)', async () => {
  await rp.click(`[data-tlpk-open="${ivId}"]`);
  await rp.waitForSelector('#tlpkPanel #tlpkRelease', { timeout: 10000 });
  const t = await rp.textContent('#tlpkPanel');
  must(/may reveal the company/.test(t), 'no warning');
  must(t.includes(job.title) && !/MIDC Bhosari[\s\S]*What the candidate sees[\s\S]*MIDC/.test(t), 'preview wrong');
  await shot(rp, '4-panel-before');
  await rp.check('#tlpkPanel #tlpkRelease');
  await rp.click('#tlpkPanel [data-act="details"]');
  await rp.waitForTimeout(1500);
  const kit = await rp.evaluate((id) => TL.api.get('/interviews/' + id + '/prep-kit'), ivId);
  must(kit.interview.detailsReleasedAt, 'not released');
  must(kit.preview.venue === VENUE, 'the preview does not show the released venue');
  await shot(rp, '4b-panel-released');
});

await check('5. the candidate now sees the address and a Google Maps link', async () => {
  await cp.reload(); await ready(cp);
  await cp.waitForSelector('#tlpkRoot .tlpk details', { timeout: 15000 });
  const t = await cp.textContent('#tlpkRoot');
  must(t.includes('MIDC Bhosari'), 'the venue is not shown');
  const maps = await cp.getAttribute('#tlpkRoot a[href*="google.com/maps"]', 'href');
  must(maps && maps.includes(encodeURIComponent('Plot 14')), 'no Maps link');
  await wizardAway(cp); await cp.waitForTimeout(400);
  await cp.evaluate(() => window.scrollTo(0, 0));
  await shot(cp, '5-kit-released');
});

await check('6. the .ics and the assistant prep carry no company name', async () => {
  const ics = await cp.evaluate((id) => fetch('/api/candidate/interviews/' + id + '/prep-kit.ics', { credentials: 'include' }).then((r) => r.text()), ivId);
  must(/BEGIN:VEVENT/.test(ics) && /DTSTART:\d{8}T053000Z/.test(ics), 'bad .ics: ' + ics.slice(0, 120));
  must(ics.includes(job.title.replace(/,/g, '\\,')), 'role missing from the .ics');
  must(!/velmora|quartzworks/i.test(ics), 'the .ics names the company');
  const prep = await cp.evaluate((id) => {
    const iv = (DATA.interviews || []).find((x) => x.id === id);
    return JSON.stringify(window.interviewPrepFor(iv));
  }, ivId);
  must(!/velmora|quartzworks/i.test(prep), 'interviewPrepFor still names the company');
});

await check('7. preferred language Telugu: headings, tips and checklist in Telugu; questions English; no company', async () => {
  const before = await cp.$$eval('#tlpkRoot details summary', (x) => x.map((s) => s.firstChild.textContent));
  await cp.evaluate(() => { location.hash = '#/candidate/profile'; });
  await cp.waitForTimeout(1200); await wizardAway(cp);
  await cp.waitForSelector('#tllangCard', { timeout: 15000 });
  await cp.click('#tllangCard [data-lang="te"]');
  await cp.waitForFunction(() => {
    const on = document.querySelector('#tllangCard .tllang-opt.on');
    return on && on.getAttribute('data-lang') === 'te' && !document.querySelector('#tllangCard [disabled]');
  }, null, { timeout: 10000 });
  await cp.evaluate((id) => { location.hash = '#/candidate/interview-prep/' + encodeURIComponent(id); }, ivId);
  await cp.waitForFunction(() => {
    const el = document.querySelector('#tlpkRoot .tlpk');
    return el && el.getAttribute('lang') === 'te' && el.querySelector('details');
  }, null, { timeout: 15000 });
  const t = await cp.textContent('#tlpkRoot');
  must(t.includes('అడిగే అవకాశం ఉన్న ప్రశ్నలు') && t.includes('సూచనలు') && t.includes('సిద్ధంగా ఉంచుకోవాల్సినవి'), 'headings not in Telugu');
  must(/ఇంటర్వ్యూ జరిగే చోటుకి 15 నిమిషాలు ముందుగానే చేరుకోండి/.test(t), 'tips not in Telugu');
  must(/మీ రెజ్యూమ్ రెండు ప్రింట్ కాపీలు/.test(t), 'checklist not in Telugu');
  must(/6లో 2 సిద్ధం/.test(await cp.textContent('#tlpkCount')), 'count: ' + await cp.textContent('#tlpkCount'));
  const after = await cp.$$eval('#tlpkRoot details summary', (x) => x.map((s) => s.firstChild.textContent));
  must(JSON.stringify(after) === JSON.stringify(before), 'the questions changed');
  must(!/[\u0C00-\u0C7F]/.test(after.join(' ')), 'a question was translated');
  must(!/velmora|quartzworks/i.test(t) && !/\bclient\b/i.test(t), 'company or "client" on the Telugu kit');
  await cp.evaluate(() => window.scrollTo(0, 0));
  await shot(cp, '7-kit-telugu');
  await cp.evaluate(() => { const el = document.getElementById('tlpkCount'); if (el) el.scrollIntoView({ block: 'start' }); });
  await shot(cp, '7b-kit-telugu-checklist');
});

await cc.close(); await rc.close();
await browser.close();
console.log(`\nscreenshots: ${SHOTS}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
