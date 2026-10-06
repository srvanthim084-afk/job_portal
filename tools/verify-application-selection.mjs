/**
 * Recruiter -> Applications: the "N selected" bar and the one selection
 * Set behind it (web/teamlink-app-selection.js), in a real browser.
 *
 *   setup  the seed recruiter posts a job (screening questions off); twelve
 *          candidates register (consent given) and apply to it - every
 *          third on a 2-month notice, the rest Immediate
 *   1  N = 0: no bar
 *   2  ticking rows: "N selected"; role=status + aria-live=polite; the
 *      header box is indeterminate on a partial selection
 *   3  the header box selects the VISIBLE rows only, then deselects them
 *   4  a filter that re-renders the table (Notice period: Immediate):
 *      the Set is kept, "(M hidden by filters)", the re-rendered rows are
 *      ticked, the header box selects only what is visible
 *   5  a filter that hides rows in place (Screening): every selected row
 *      hidden is counted; the header box is plain unchecked
 *   6  clearing the filter: same count, rows re-rendered ticked
 *   7  the bulk actions use the Set: "Send screening questions" posts
 *      exactly the selected application ids; Export says the same people
 *   8  open a candidate and come back: the selection is still there
 *   9  reload (first paint with a pre-selected Set): the very first frame
 *      that has the table already shows the ticks and the bar
 *  10  keyboard: Tab reaches Clear selection, Enter empties the Set, hides
 *      the bar, unticks every row, and focus lands on the header box
 *  11  390px: tick, bar, Clear
 *  12  no page errors anywhere
 *
 * The Applications table has no pagination (every row renders in one
 * scrolling table), so there is no page change to make; the Set does not
 * depend on which rows are in the DOM, which 4-6 show.
 *
 * Creates accounts, so it refuses :4323. Run against an isolated instance:
 *   TL_URL=http://127.0.0.1:4437/ node tools/verify-application-selection.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4437/').replace(/\/?$/, '/');
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}
const SHOTS = process.env.TL_SHOTS || join(process.cwd(), 'var', 'verify-shots');
mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);
const REC = { email: process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com', password: process.env.TL_PASSWORD || 'TeamLink@2026' };
const PW = `Select${stamp}9`;
const phone = () => '9' + String(Math.floor(1e8 + Math.random() * 9e8));
const errors = [];

const browser = await chromium.launch();
async function open(ctx, hash) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + (hash || '#/'));
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(300);
  return page;
}
const api = (page, method, path, body) => page.evaluate(([m, p, b]) => window.TL.api[m](p, b)
  .then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code, message: e.message })), [method, path, body]);
const shot = (page, name, full = false) => page.screenshot({ path: join(SHOTS, `app-selection-${name}.png`), fullPage: full });

/* ---------------- setup ---------------- */
const rctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const R = await open(rctx);
must((await api(R, 'post', '/auth/login', { ...REC, role: 'recruiter' })).ok, 'recruiter sign-in');
await R.reload();
await R.waitForFunction(() => window.TL && TL.ready === true && window.STATE && STATE.session, null, { timeout: 30000 });
const companyId = await R.evaluate(() => DATA.recruiterById(STATE.session.id).companyId);
const jr = await api(R, 'post', '/jobs', { companyId, title: `Staff Nurse ${stamp}`, location: 'Hyderabad', mode: 'Onsite',
  exp: '0-2 yrs', pay: '₹3 LPA', status: 'open', skills: ['Nursing'], desc: 'Verification job - safe to delete.', type: 'Full-time' });
must(jr.ok, 'job: ' + jr.message);
const JOB = jr.v.job;
must((await api(R, 'put', `/jobs/${JOB.id}/screening-questions`, { questions: [] })).ok, 'screening questions off');

const cctx = await browser.newContext();
const C = await open(cctx);
const APPS = [];          // { id, ref, candidateId, notice }
for (let i = 0; i < 12; i += 1) {
  const notice = i % 3 === 0 ? '2 Months' : 'Immediate';
  const reg = await api(C, 'post', '/auth/register', { name: `Sel${String.fromCharCode(65 + i)} Verify ${stamp}`,
    email: `sel${i}.${stamp}@tl-verify.test`, password: PW, phone: phone(), preferredLocation: 'Hyderabad',
    expectedCtc: 4, noticePeriod: notice, preferredWorkModes: ['Work From Office'],
    consent: { terms: true, communication: true, resumeProcessing: true } });
  must(reg.ok, `register ${i}: ${reg.message}`);
  const ap = await api(C, 'post', '/applications', { jobId: JOB.id });
  must(ap.ok, `apply ${i}: ${ap.message}`);
  APPS.push({ id: ap.v.application.id, ref: ap.v.application.reference, candidateId: ap.v.application.candidateId, notice });
  await api(C, 'post', '/auth/logout', {});
}
await cctx.close();
/* The recruiter's page loaded before these applications existed. */
await R.reload();
await R.waitForFunction(() => window.TL && TL.ready === true && window.STATE && STATE.session, null, { timeout: 30000 });

const LATE = APPS.filter((a) => a.notice !== 'Immediate');
const NOW = APPS.filter((a) => a.notice === 'Immediate');

/* ---------------- helpers on the recruiter page ---------------- */
const P = R;
async function toApps(page = P) {
  await page.evaluate(() => { location.hash = '#/recruiter/applications'; });
  await page.waitForSelector('.tl-apps-wrap tbody tr[data-app-id] input.tlas-row', { timeout: 20000 });
  await page.waitForTimeout(500);
}
const state = (page = P) => page.evaluate(() => {
  const bar = document.getElementById('tlasBar');
  const all = document.querySelector('.tl-apps-wrap thead input.tlas-all');
  const rows = Array.from(document.querySelectorAll('.tl-apps-wrap tbody tr[data-app-id]'));
  const vis = rows.filter((tr) => tr.style.display !== 'none');
  return {
    set: TLAppSelection.get().sort(),
    size: TLAppSelection.size,
    bar: bar && !bar.hidden && bar.offsetParent ? bar.innerText.replace(/\s+/g, ' ').trim() : null,
    barText: bar ? bar.querySelector('.tlas-n').textContent + (bar.querySelector('.tlas-h').textContent ? ' ' + bar.querySelector('.tlas-h').textContent : '') : null,
    head: all ? { checked: all.checked, ind: all.indeterminate } : null,
    rows: rows.length,
    visible: vis.length,
    ticked: rows.filter((tr) => tr.querySelector('input.tlas-row').checked).map((tr) => tr.querySelector('input.tlas-row').getAttribute('data-app-id')).sort(),
    visibleIds: vis.map((tr) => tr.querySelector('input.tlas-row').getAttribute('data-app-id')),
  };
});
const tick = (id, page = P) => page.locator(`.tl-apps-wrap tr input.tlas-row[data-app-id="${id}"]`).click();
const clickHead = (page = P) => page.locator('.tl-apps-wrap thead input.tlas-all').click();
const sorted = (a) => a.slice().sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

console.log(`\napplication selection  (${BASE})`);
await toApps();
const all0 = await state();
console.log(`  (${all0.rows} rows on the table, ${APPS.length} created here)`);

await check('1. N = 0: no selection bar', async () => {
  const s = await state();
  must(s.size === 0, 'Set not empty: ' + s.size);
  must(s.bar === null, 'bar shown: ' + s.bar);
  must(s.head && !s.head.checked && !s.head.ind, 'header ' + JSON.stringify(s.head));
});

await check('2. ticking rows shows "N selected"; role=status, aria-live=polite; header indeterminate', async () => {
  await tick(APPS[0].id); await tick(APPS[1].id); await tick(APPS[2].id);
  await P.waitForTimeout(150);
  const s = await state();
  must(s.size === 3 && same(s.set, APPS.slice(0, 3).map((a) => a.id)), 'Set ' + s.set);
  must(s.bar && /^3 selected Clear selection$/.test(s.bar), 'bar ' + s.bar);
  must(s.head.ind && !s.head.checked, 'header ' + JSON.stringify(s.head));
  const a11y = await P.$eval('#tlasBar', (b) => [b.getAttribute('role'), b.getAttribute('aria-live')]);
  must(a11y[0] === 'status' && a11y[1] === 'polite', 'a11y ' + a11y);
  const place = await P.$eval('#tlasBar', (b) => [b.nextElementSibling && b.nextElementSibling.classList.contains('tl-apps-wrap'),
    b.previousElementSibling && b.previousElementSibling.className]);
  must(place[0], 'bar is not directly above the table');
  must(/tlsq-bar/.test(place[1] || ''), 'bar is not under the filter bar: ' + place[1]);
  const style = await P.$eval('#tlasBar', (b) => { const c = getComputedStyle(b); return [c.backgroundColor, c.color, c.fontSize, c.padding]; });
  must(style[0] === 'rgb(238, 241, 255)' && style[1] === 'rgb(61, 52, 196)', 'colours ' + style);
  const sq = await P.$eval('.tlsq-bar', (b) => { const c = getComputedStyle(b); return [c.fontSize, c.padding]; });
  must(style[2] === sq[0] && style[3] === sq[1], `font/spacing ${style.slice(2)} vs filter bar ${sq}`);
  await shot(P, '1-partial');
});

await check('3. header box selects the visible rows only, and deselects them', async () => {
  await clickHead();
  await P.waitForTimeout(150);
  let s = await state();
  must(s.size === s.visible && same(s.set, s.visibleIds), `selected ${s.size} of ${s.visible} visible`);
  must(s.head.checked && !s.head.ind, 'header ' + JSON.stringify(s.head));
  must(s.bar.startsWith(`${s.visible} selected`), 'bar ' + s.bar);
  await clickHead();
  await P.waitForTimeout(150);
  s = await state();
  must(s.size === 0 && s.bar === null && s.ticked.length === 0, 'not cleared: ' + JSON.stringify(s).slice(0, 200));
  must(!s.head.checked && !s.head.ind, 'header ' + JSON.stringify(s.head));
});

let SEL = [];
await check('4. a re-rendering filter keeps the Set, says "(M hidden by filters)", rows re-render ticked', async () => {
  SEL = [LATE[0].id, NOW[0].id, NOW[1].id];
  for (const id of SEL) await tick(id);
  await P.evaluate(() => { document.querySelector('.tl-apps-wrap table').__probe = 1; });
  /* Notice period lives under "More filters". */
  const more = P.locator('.tlaf button.more');
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
  await P.waitForTimeout(300);
  const noticeSel = P.locator('.tlaf .fld', { hasText: 'Notice period' }).locator('select');
  await noticeSel.selectOption('now');
  await P.waitForTimeout(700);
  const rerendered = await P.evaluate(() => !document.querySelector('.tl-apps-wrap table').__probe);
  must(rerendered, 'the filter did not re-render the table');
  let s = await state();
  must(same(s.set, SEL), 'Set changed: ' + s.set);
  must(!s.visibleIds.includes(LATE[0].id), 'the 2-month row is still visible');
  must(s.barText === '3 selected (1 hidden by filters)', 'bar ' + s.barText);
  must(same(s.ticked, [NOW[0].id, NOW[1].id]), 'ticked after re-render ' + s.ticked);
  must(s.head.ind, 'header should be indeterminate: ' + JSON.stringify(s.head));
  await shot(P, '2-hidden-by-filter');
  await clickHead();
  await P.waitForTimeout(150);
  s = await state();
  must(s.set.includes(LATE[0].id), 'the hidden row was deselected');
  must(s.size === s.visible + 1, `select-all reached beyond the visible rows: ${s.size} vs ${s.visible}+1`);
  must(s.barText === `${s.size} selected (1 hidden by filters)`, 'bar ' + s.barText);
  must(s.head.checked && !s.head.ind, 'header ' + JSON.stringify(s.head));
  /* back to the three */
  await clickHead();
  await P.waitForTimeout(150);
  s = await state();
  must(same(s.set, [LATE[0].id]), 'deselect visible should leave only the hidden one: ' + s.set);
  for (const id of [NOW[0].id, NOW[1].id]) await tick(id);
  s = await state();
  must(same(s.set, SEL), 'Set ' + s.set);
});

await check('5. a filter that hides rows in place (Screening) counts them as hidden', async () => {
  await P.selectOption('.tlsq-bar select[data-f="status"]', 'knocked_out');
  await P.waitForTimeout(400);
  let s = await state();
  must(s.visible === 0, 'rows still visible: ' + s.visible);
  must(s.barText === '3 selected (3 hidden by filters)', 'bar ' + s.barText);
  must(!s.head.checked && !s.head.ind, 'header ' + JSON.stringify(s.head));
  await P.selectOption('.tlsq-bar select[data-f="status"]', '');
  await P.waitForTimeout(400);
  s = await state();
  must(s.barText === '3 selected (1 hidden by filters)', 'bar after ' + s.barText);
});

await check('6. clearing the filter: same count, every selected row re-rendered ticked', async () => {
  await P.locator('.tlaf .hd .clr').click();
  await P.waitForTimeout(700);
  const s = await state();
  must(same(s.set, SEL) && s.size === 3, 'Set ' + s.set);
  must(s.barText === '3 selected', 'bar ' + s.barText);
  must(same(s.ticked, SEL), 'ticked ' + s.ticked);
  must(s.head.ind, 'header ' + JSON.stringify(s.head));
});

await check('7. bulk actions act on exactly the Set (Send screening questions; Export)', async () => {
  const req = P.waitForRequest((r) => r.url().includes('/api/screening/send') && r.method() === 'POST', { timeout: 10000 });
  await P.locator('.tlsq-bar [data-bulk]').click();
  const body = JSON.parse((await req).postData() || '{}');
  must(same(body.applicationIds || [], SEL), 'posted ' + JSON.stringify(body.applicationIds) + ' vs ' + SEL);
  await P.waitForTimeout(800);
  const s = await state();
  must(same(s.set, SEL), 'the send changed the selection: ' + s.set);
  /* Export: the same three people */
  const cands = APPS.filter((a) => SEL.includes(a.id)).map((a) => a.candidateId);
  must(same(await P.evaluate(() => TLAppSelection.candidateIds()), cands), 'candidateIds');
  await P.waitForFunction(() => /\(3 selected\)/.test((document.getElementById('tlxBtn') || {}).textContent || ''), null, { timeout: 5000 });
  await P.locator('#tlxBtn').click();
  await P.waitForSelector('.tlx-box', { timeout: 10000 });
  const t = await P.textContent('.tlx-box');
  must(/3 selected/.test(t), 'export dialog: ' + t.slice(0, 120));
  await P.locator('#tlxCancel').click();
  const refs = await P.evaluate(() => TLAppSelection.references());
  must(same(refs, APPS.filter((a) => SEL.includes(a.id)).map((a) => a.ref)) && refs.every((r) => /^TL-APP-/.test(r)), 'references ' + refs);
});

await check('8. open a candidate and come back: the selection is kept', async () => {
  const cand = APPS.find((a) => a.id === NOW[0].id).candidateId;
  await P.locator(`tr[data-app-id="${NOW[0].id}"] td.clickable`).first().click();
  await P.waitForFunction((c) => location.hash.includes('candidate-profile') && location.hash.includes(c), cand, { timeout: 10000 });
  await P.waitForTimeout(600);
  await P.goBack();
  await P.waitForSelector('.tl-apps-wrap tbody tr input.tlas-row', { timeout: 15000 });
  await P.waitForTimeout(400);
  const s = await state();
  must(same(s.set, SEL) && s.barText === '3 selected' && same(s.ticked, SEL), JSON.stringify({ set: s.set, bar: s.barText, ticked: s.ticked }));
});

await check('9. reload: the first frame with the table already shows the ticks, header and bar', async () => {
  await P.addInitScript(() => {
    window.__firstFrame = null;
    const probe = () => {
      const t = document.querySelector('.tl-apps-wrap table');
      if (t && t.querySelector('tbody tr[data-app-id]')) {
        const bar = document.getElementById('tlasBar');
        const all = t.querySelector('thead input.tlas-all');
        window.__firstFrame = {
          ticked: Array.from(t.querySelectorAll('input.tlas-row:checked')).map((i) => i.getAttribute('data-app-id')),
          boxes: t.querySelectorAll('input.tlas-row').length,
          bar: bar && !bar.hidden ? bar.querySelector('.tlas-n').textContent : null,
          ind: !!(all && all.indeterminate),
        };
        return;
      }
      requestAnimationFrame(probe);
    };
    requestAnimationFrame(probe);
  });
  await P.reload();
  await P.waitForFunction(() => window.__firstFrame, null, { timeout: 30000 });
  const f = await P.evaluate(() => window.__firstFrame);
  must(f.boxes > 0 && same(f.ticked, SEL), 'first frame ticks ' + JSON.stringify(f));
  must(f.bar === '3 selected', 'first frame bar ' + f.bar);
  must(f.ind, 'first frame header not indeterminate');
});

await check('10. keyboard: Tab reaches Clear selection; Enter clears everything and hides the bar', async () => {
  await P.waitForSelector('.tlsq-bar [data-bulk]', { timeout: 15000 });
  await P.locator('.tlsq-bar [data-bulk]').focus();
  await P.keyboard.press('Tab');
  const focused = await P.evaluate(() => document.activeElement && document.activeElement.className);
  must(/tlas-clear/.test(focused || ''), 'Tab landed on ' + focused);
  await P.keyboard.press('Enter');
  await P.waitForTimeout(200);
  const s = await state();
  must(s.size === 0 && s.bar === null && s.ticked.length === 0, JSON.stringify({ size: s.size, bar: s.bar, ticked: s.ticked }));
  must(!s.head.checked && !s.head.ind, 'header ' + JSON.stringify(s.head));
  const where = await P.evaluate(() => document.activeElement && document.activeElement.className);
  must(where === 'tlas-all', 'focus went to ' + where);
  must(await P.evaluate(() => { try { return sessionStorage.getItem('tl.appSelection.v1'); } catch (e) { return 'x'; } }) === null, 'storage not cleared');
  await shot(P, '3-cleared');
});

await check('11. 390px: tick two rows, the bar says so, Clear empties it', async () => {
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await m.addCookies(await rctx.cookies());
  const mp = await open(m);
  await toApps(mp);
  await tick(NOW[2].id, mp); await tick(LATE[1].id, mp);
  await mp.waitForTimeout(200);
  let s = await state(mp);
  must(s.size === 2 && s.barText === '2 selected', 'bar ' + s.barText);
  const bar = await mp.$eval('#tlasBar', (b) => { const r = b.getBoundingClientRect(); return [r.left, r.right, document.documentElement.scrollWidth]; });
  must(bar[0] >= 0 && bar[1] <= 390 && bar[2] <= 390, 'bar overflows ' + bar);
  await mp.locator('#tlasBar').scrollIntoViewIfNeeded();
  await shot(mp, '4-mobile');
  await mp.locator('#tlasBar .tlas-clear').click();
  await mp.waitForTimeout(200);
  s = await state(mp);
  must(s.size === 0 && s.bar === null && s.ticked.length === 0, 'not cleared on mobile');
  await m.close();
});

await check('12. no page errors', async () => {
  must(!errors.length, errors.slice(0, 3).join(' | '));
});

await browser.close();
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
