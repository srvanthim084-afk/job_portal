/**
 * Admin -> Availability (four cards) and the slimmer Users module, in a real browser.
 *
 *     TL_URL=http://127.0.0.1:4471 node tools/verify-availability-cards.mjs   (LOAD_SEED=true: admin@ / recruiter@teamlink.com)
 *
 *  1 exactly four cards - Total Candidates, Attended Interviews, Moved to ATS, Not Looking - with the server's numbers;
 *    no status tiles, no "Still looking?" section, no "Run re-confirmation now"
 *  2 each card opens its list on the same page; the list's total equals the card; search, a filter, pages, back to summary
 *  3 a candidate's name opens their record
 *  4 Users has no Candidates / Clients / Shared candidates / Privacy requests tabs; their old addresses land on Users
 *  5 a recruiter has no Availability module and the API refuses them
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4471/').replace(/\/$/, '');
const SHOTS = process.env.SHOTS || '.';
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };
const browser = await chromium.launch();

async function signedIn(email, role, viewport = { width: 1360, height: 950 }) {
  const page = await (await browser.newContext({ viewport })).newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e.message)));
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  const r = await page.evaluate(async ({ e, r }) => { try { await TL.api.post('/auth/login', { email: e, password: 'TeamLink@2026', role: r }); await TL.refresh(); return 'ok'; } catch (x) { return x.message; } }, { e: email, r: role });
  check(r === 'ok', `${role} signs in (${r})`);
  return page;
}
const go = async (page, hash) => { await page.evaluate((x) => { location.hash = x; }, hash); await page.waitForTimeout(900); };
const api = (page, p) => page.evaluate(async (p) => { try { return { ok: true, body: await TL.api.get(p) }; } catch (e) { return { ok: false, status: e.status }; } }, p);

const admin = await signedIn('admin@teamlink.com', 'admin');
await go(admin, '#/admin/availability');
await admin.waitForFunction(() => document.querySelectorAll('.tlav-card').length === 4 && ![...document.querySelectorAll('.tlav-card .val')].some((v) => v.textContent === '…'), null, { timeout: 20000 });

/* 1 */
const cards = await admin.evaluate(() => [...document.querySelectorAll('.tlav-card')].map((c) => ({ k: c.dataset.card, label: c.querySelector('.lbl').textContent, val: Number(c.querySelector('.val').textContent) })));
check(JSON.stringify(cards.map((c) => c.label)) === JSON.stringify(['Total Candidates', 'Attended Interviews', 'Moved to ATS', 'Not Looking']), `exactly the four cards (${cards.map((c) => c.label).join(' | ')})`);
const sum = (await api(admin, '/admin/availability/summary')).body.summary;
check(cards[0].val === sum.totalCandidates && cards[1].val === sum.attendedInterviews && cards[2].val === sum.movedToAts && cards[3].val === sum.notLooking,
  `the cards show the server's counts (${cards.map((c) => c.val).join(' / ')})`);
const text = await admin.evaluate(() => document.querySelector('#app').innerText);
check(!/Still looking|Run re-confirmation|No answer \(14 days\)/.test(text) && !(await admin.evaluate(() => !!document.querySelector('.tlav-tiles'))), 'no status tiles, no "Still looking?" section, no re-confirmation button');
check(await admin.evaluate(() => (document.querySelector('.dash-admin .sidebar a.active .lbl') || {}).textContent === 'Availability'), 'the Availability module is lit in the sidebar');
await admin.screenshot({ path: `${SHOTS}/avc-summary.png` });

/* 2 */
for (const c of cards) {
  await admin.click(`.tlav-card[data-card="${c.k}"]`);
  await admin.waitForFunction(() => /candidate/.test((document.querySelector('.tlav-pg') || {}).innerText || '') || /No candidates/.test((document.querySelector('#tlavRows') || {}).innerText || ''), null, { timeout: 20000 });
  const st = await admin.evaluate(() => ({
    title: (document.querySelector('.tlav-list h2') || {}).textContent,
    on: (document.querySelector('.tlav-card.on .lbl') || {}).textContent,
    pg: (document.querySelector('.tlav-pg') || {}).innerText || '',
    rows: document.querySelectorAll('#tlavRows tbody tr.tlav-row').length,
  }));
  const total = Number((/of (\d+) candidate/.exec(st.pg) || [])[1] || 0);
  check(st.title === c.label && st.on === c.label && (total === c.val || (c.val === 0 && st.rows === 0)),
    `${c.label}: opens its list, total ${total} = card ${c.val} (${st.rows} rows on the page)`);
}
/* search, filter, pages, back - on Total Candidates */
await admin.click('.tlav-card[data-card="total"]');
await admin.waitForSelector('#tlavRows tbody tr.tlav-row', { timeout: 20000 });
const firstName = await admin.evaluate(() => document.querySelector('#tlavRows .tlav-name').textContent);
await admin.fill('#tlavQ', firstName);
await admin.waitForTimeout(1500);
const searched = await admin.evaluate(() => [...document.querySelectorAll('#tlavRows .tlav-name')].map((b) => b.textContent));
check(searched.length >= 1 && searched.every((n) => n.toLowerCase().includes(firstName.toLowerCase().split(' ')[0])), `search narrows the list (${searched.length} for "${firstName}")`);
check(await admin.evaluate(() => document.activeElement && document.activeElement.id === 'tlavQ'), 'the search box keeps its focus while the rows refresh');
await admin.fill('#tlavQ', 'zzzz-nobody-here');
await admin.waitForTimeout(1500);
check(/No candidates match these filters/.test(await admin.innerText('#tlavRows')), 'an empty search says so');
await admin.click('text=Clear filters');
await admin.waitForTimeout(1500);
await admin.selectOption('#tlavAv', 'actively_looking');
await admin.waitForTimeout(1500);
const avs = await admin.evaluate(() => [...document.querySelectorAll('#tlavRows tbody tr.tlav-row .tlav-pill')].map((p) => p.textContent));
check(avs.length > 0 && avs.every((t) => /Actively looking|Not confirmed/.test(t)), `the availability filter applies (${avs.length} rows)`);
await admin.click('text=Clear filters');
await admin.waitForTimeout(1500);
const pages = await admin.evaluate(() => (document.querySelector('.tlav-pg') || {}).innerText || '');
if (/Page 1 of [2-9]/.test(pages)) {
  const p1 = await admin.evaluate(() => [...document.querySelectorAll('#tlavRows .tlav-row')].map((r) => r.dataset.id));
  await admin.click('.tlav-pg button:has-text("Next")');
  await admin.waitForTimeout(1500);
  const p2 = await admin.evaluate(() => [...document.querySelectorAll('#tlavRows .tlav-row')].map((r) => r.dataset.id));
  check(p2.length > 0 && !p2.some((id) => p1.includes(id)) && /Page 2 of/.test(await admin.innerText('.tlav-pg')), 'Next shows the second page, no repeats');
} else check(/Page 1 of 1/.test(pages), `one page only (${pages.replace(/\s+/g, ' ')})`);

/* 3 */
await admin.click('#tlavRows .tlav-name');
await admin.waitForFunction(() => /Applications/.test((document.querySelector('#fcrModalHost') || {}).innerText || ''), null, { timeout: 20000 });
const modal = await admin.innerText('#fcrModalHost');
check(/Applications/.test(modal) && /Interviews/.test(modal) && /Timeline/.test(modal), 'a name opens the candidate record (applications, interviews, timeline)');
await admin.screenshot({ path: `${SHOTS}/avc-profile.png` });
await admin.click('#fcrModalHost .fcr-jd-actions button');
await admin.click('text=← Back to summary');
await admin.waitForTimeout(600);
check(await admin.evaluate(() => !document.querySelector('.tlav-card.on') && /Choose a card/.test(document.querySelector('#tlavAdmin').innerText)), 'Back to summary');
await admin.click('.tlav-card[data-card="attended"]');
await admin.waitForTimeout(1800);
await admin.screenshot({ path: `${SHOTS}/avc-attended.png` });

/* 4 */
await go(admin, '#/admin/users');
check(await admin.evaluate(() => !document.querySelector('.tlac-tabs')), 'Users has no tabs (only Users)');
for (const old of ['candidates', 'clients', 'shared-candidates', 'privacy-requests']) {
  await go(admin, '#/admin/' + old);
  await admin.waitForTimeout(400);
  check(await admin.evaluate(() => location.hash === '#/admin/users'), `#/admin/${old} lands on Users`);
}
check(admin.errors.length === 0, `no page errors (${admin.errors.slice(0, 3).join(' | ')})`);

/* phone width */
const mob = await signedIn('admin@teamlink.com', 'admin', { width: 390, height: 844 });
await go(mob, '#/admin/availability');
await mob.waitForSelector('.tlav-card', { timeout: 20000 });
await mob.click('.tlav-card[data-card="total"]');
await mob.waitForTimeout(2000);
const over = await mob.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(over <= 1, `no sideways page scroll at 390px (${over}px)`);
await mob.screenshot({ path: `${SHOTS}/avc-mobile.png`, fullPage: false });

/* 5 */
const rec = await signedIn('recruiter@teamlink.com', 'recruiter');
check((await api(rec, '/admin/availability/summary')).status === 403, 'the API refuses a recruiter');
await go(rec, '#/recruiter/home');
check(await rec.evaluate(() => !document.querySelector('.tlav-card') && ![...document.querySelectorAll('.sidebar a .lbl')].some((l) => /Availability/.test(l.textContent))), 'no Availability module for a recruiter');

await browser.close();
console.log(fail.length ? `\n${fail.length} FAILED:\n - ${fail.join('\n - ')}` : '\nall passed');
process.exit(fail.length ? 1 : 0);
