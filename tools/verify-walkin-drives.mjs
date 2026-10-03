/**
 * Walk-in drives, in a real browser.
 *
 *   recruiter  1  creates a drive through the form (and the form refuses a bad one)
 *              2  the drive is listed with its counts
 *   candidate  3  "Walk-in Drives" is in the header nav and the mobile drawer
 *              4  the list shows the drive card: company, role, date, venue, "X days left", AI match
 *              5  filters: city, role, date, keyword; an empty result says so
 *              6  details: documents to carry, Google Maps link, contact
 *              7  Register -> confirmation with Add to Calendar (a real .ics)
 *              8  My Registrations lists it; a refresh keeps it (server state)
 *              9  Cancel registration, register again
 *   recruiter 10  registrations: search, status filter, attendance on a running drive
 *             11  export CSV and Excel downloads
 *             12  edit a drive -> the candidate is told; the bell opens the drive
 *             13  phone width: no sideways scroll, cards stack
 *
 * Creates accounts and drives, so it refuses :4323. Run against an isolated instance:
 *   TL_URL=http://127.0.0.1:4425/ node tools/verify-walkin-drives.mjs
 * Screenshots go to TL_SHOTS (default: <os temp>/tl-verify-walkins).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4425/').replace(/\/?$/, '/');
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts and drives. Use an isolated instance.`);
  process.exit(2);
}
const SHOTS = process.env.TL_SHOTS || join(tmpdir(), 'tl-verify-walkins');
mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);
const phone = () => '9' + String(Math.floor(1e8 + Math.random() * 9e8));
const RECRUITER = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';
const RECRUITER_PW = process.env.TL_RECRUITER_PASSWORD || process.env.DEV_PASSWORD || 'TeamLink@2026';
const istDay = (plus = 0) => new Date(Date.now() + 330 * 60000 + plus * 86400000).toISOString().slice(0, 10);
const CITY = `Kavali ${stamp.slice(-4)}`;
const TITLE = `Verify Walk-in ${stamp}`;

const browser = await chromium.launch();
const errors = [];

const ready = (page) => page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
async function open(ctx, hash) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(BASE + hash);
  await ready(page);
  await page.waitForTimeout(500);
  return page;
}
const wizardAway = (page) => page.evaluate(() => {
  document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip, .tlpo-ov [data-act="later"]').forEach((b) => b.click());
});
const text = (page, sel = '#app') => page.evaluate((s) => ((document.querySelector(s) || {}).innerText || ''), sel);
const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(1200); await wizardAway(page); };
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
async function signIn(page, email, password, role, hash) {
  const r = await page.evaluate((b) => TL.api.post('/auth/login', b).then(() => 'ok', (x) => x.message), { email, password, role });
  must(r === 'ok', `${role} could not sign in: ${r}`);
  await page.goto('about:blank'); await page.goto(BASE + hash); await ready(page); await page.waitForTimeout(1200);
  await wizardAway(page); await page.waitForTimeout(800); await wizardAway(page);
}

/* ---------------- recruiter ---------------- */
const rc = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
const rp = await open(rc, '#/');
await signIn(rp, RECRUITER, RECRUITER_PW, 'recruiter', '#/recruiter/walkins');

console.log(`\nwalk-in drives  (${BASE})`);
let driveId = null;
let todayId = null;

await check('1. recruiter creates a drive through the form; a bad one is refused with the reason', async () => {
  must(/Walk-in Drives/.test(await text(rp, '.sidebar')), 'no Walk-in Drives item in the recruiter sidebar');
  await rp.click('text=+ Create drive');
  await rp.waitForSelector('#wkForm');
  await rp.fill('#wkF_title', TITLE);
  await rp.fill('#wkF_jobRole', 'Customer Support Executive');
  await rp.fill('#wkF_driveDate', istDay(-1));
  await rp.fill('#wkF_venueName', 'Hotel Grand');
  await rp.fill('#wkF_city', CITY);
  await rp.fill('#wkF_fullAddress', '12 Trunk Road, near Bus Stand');
  await rp.click('#wkForm button.btn-primary');
  await rp.waitForTimeout(1000);
  must(/past/.test(await text(rp, '#wkForm')), 'a past date was not refused: ' + (await text(rp, '#wkForm')).slice(0, 160));
  await rp.fill('#wkF_driveDate', istDay(3));
  await rp.fill('#wkF_mapLink', 'https://maps.google.com/?q=Hotel+Grand');
  await rp.fill('#wkF_salaryRange', '₹1.8–2.4 LPA');
  await rp.fill('#wkF_experienceRequired', '0–2 yrs');
  await rp.fill('#wkF_qualification', 'Any degree');
  await rp.fill('#wkF_skills', 'Communication, Telugu, MS Excel');
  await rp.fill('#wkF_contactPersonName', 'Ravi');
  await rp.fill('#wkF_contactPhone', '9000011111');
  await rp.fill('#wkF_maxSeats', '25');
  await rp.selectOption('#wkF_companyId', { index: 1 }).catch(() => {});
  await shot(rp, '01-recruiter-form');
  await rp.click('#wkForm button.btn-primary');
  await rp.waitForTimeout(1500);
  const list = await rp.evaluate(() => TL.api.get('/recruiter/walkin-drives'));
  const d = list.drives.find((x) => x.title === TITLE);
  must(d, 'the drive was not created');
  must(d.documentsToCarry.length === 3, 'documents: ' + JSON.stringify(d.documentsToCarry));
  driveId = d.id;
});

await check('2. the drive is listed with its counts', async () => {
  const t = await text(rp);
  must(t.includes(TITLE) && t.includes(CITY), 'not in the table');
  must(!(await rp.$('#wkForm')), 'the form stayed open after saving');
  await shot(rp, '02-recruiter-list');
  // and one running today, for attendance (made through the API: the form is covered above)
  const today = await rp.evaluate((b) => TL.api.post('/recruiter/walkin-drives', b), {
    title: `Today Drive ${stamp}`, jobRole: 'Warehouse Picker', driveDate: istDay(0), startTime: '00:00', endTime: '23:59',
    venueName: 'Depot Hall', fullAddress: '4 Industrial Estate Road', city: CITY, skills: ['Forklift'],
    documentsToCarry: ['Resume'],
  });
  todayId = today.drive.id;
  must(today.drive.status === 'ONGOING', 'status ' + today.drive.status);
});

/* ---------------- candidate ---------------- */
const cc = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const cp = await open(cc, '#/');
const cand = { email: `walkin.${stamp}@tl-verify.test`, password: `Walk${stamp}9`, name: 'Walkin Verify' };
const reg = await cp.evaluate((b) => TL.api.post('/auth/register', b).then(() => 'ok', (e) => e.message), {
  name: cand.name, email: cand.email, password: cand.password, phone: phone(),
  preferredLocation: CITY, expectedCtc: 3, noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'],
});
must(reg === 'ok', 'could not register the candidate: ' + reg);
await cp.goto('about:blank'); await cp.goto(BASE + '#/candidate/home'); await ready(cp); await cp.waitForTimeout(1200); await wizardAway(cp);
// give the profile the role and skills a match is computed from
await cp.evaluate(async () => {
  const id = STATE.session.id;
  await TL.api.put('/candidates/' + id, { title: 'Customer Support Executive', skills: ['Communication', 'Telugu'] }).catch(() => null);
});

await check('3. "Walk-in Drives" is in the header nav and opens the list', async () => {
  await go(cp, '#/candidate/home');
  await wizardAway(cp);
  const link = await cp.$('nav.cp-nav a:has-text("Walk-in Drives")');
  must(link, 'no header link');
  await link.click();
  await cp.waitForTimeout(1500);
  must((await cp.evaluate(() => location.hash)).startsWith('#/candidate/walkins'), 'did not navigate');
});

await check('4. the list shows the drive card: company, role, date, venue, "X days left", AI match', async () => {
  await cp.waitForTimeout(800);
  const t = await text(cp);
  must(t.includes(TITLE), 'the drive is not listed: ' + t.slice(0, 300));
  must(/3 days left/.test(t), 'no "3 days left" badge');
  must(t.includes('Hotel Grand') && t.includes(CITY), 'no venue / city');
  must(/% match/.test(t), 'no AI match % on a matching role');
  must(t.includes('Happening now'), 'the running drive is not marked');
  await shot(cp, '03-candidate-list');
});

await check('5. filters: city, role, date, keyword; an empty result says so', async () => {
  await cp.fill('#wkRole', 'warehouse'); await cp.press('#wkRole', 'Tab'); await cp.waitForTimeout(1200);
  let t = await text(cp);
  must(t.includes(`Today Drive ${stamp}`) && !t.includes(TITLE), 'role filter');
  await cp.click('text=Clear'); await cp.waitForTimeout(1200);
  await cp.fill('#wkDate', istDay(3)); await cp.dispatchEvent('#wkDate', 'change'); await cp.waitForTimeout(1200);
  t = await text(cp);
  must(t.includes(TITLE) && !t.includes(`Today Drive ${stamp}`), 'date filter');
  await cp.click('text=Clear'); await cp.waitForTimeout(1200);
  await cp.fill('#wkQ', 'nothing-matches-' + stamp); await cp.press('#wkQ', 'Enter'); await cp.waitForTimeout(1200);
  t = await text(cp);
  must(/No upcoming drives/.test(t), 'no empty state');
  await shot(cp, '05-candidate-empty');
  await cp.click('text=Show all drives'); await cp.waitForTimeout(1200);
  const opts = await cp.$$eval('#wkCity option', (o) => o.map((x) => x.value));
  must(opts.includes(CITY), 'city not offered in the city filter');
});

await check('6. details: documents to carry, Google Maps link, contact', async () => {
  await go(cp, '#/candidate/walkins?id=' + encodeURIComponent(driveId));
  const t = await text(cp);
  for (const s of ['Documents to carry', 'Resume', 'Passport-size photo', 'Ravi', '9000011111', 'Any degree']) must(t.includes(s), 'missing ' + s);
  const maps = await cp.$eval('a:has-text("Open in Google Maps")', (a) => a.href);
  must(maps.startsWith('https://maps.google.com/'), 'maps link ' + maps);
  await shot(cp, '06-candidate-detail');
});

await check('7. Register -> confirmation with Add to Calendar (a real .ics)', async () => {
  await cp.click('text=Register for this drive');
  await cp.waitForTimeout(1500);
  const t = await text(cp);
  must(/You are registered!/.test(t), 'no confirmation: ' + t.slice(0, 200));
  must(/done=1/.test(await cp.evaluate(() => location.hash)), 'not on the confirmation');
  const href = await cp.$eval('.wk-confirm a:has-text("Add to Calendar")', (a) => a.getAttribute('href'));
  const ics = await cp.evaluate((h) => fetch(h).then((r) => r.text()), href);
  must(/BEGIN:VCALENDAR/.test(ics) && /DTSTART:\d{8}T\d{6}Z/.test(ics) && ics.includes('Hotel Grand'), 'not an .ics: ' + ics.slice(0, 80));
  await shot(cp, '07-candidate-confirmation');
});

await check('8. My Registrations lists it, and a refresh keeps it', async () => {
  await go(cp, '#/candidate/walkins?tab=mine');
  let t = await text(cp);
  must(t.includes(TITLE) && /Registered/.test(t), 'not in My Registrations');
  await cp.reload(); await ready(cp); await cp.waitForTimeout(1500); await wizardAway(cp);
  t = await text(cp);
  must(t.includes(TITLE), 'gone after a refresh');
  await shot(cp, '08-candidate-mine');
});

await check('9. cancel the registration, then register again', async () => {
  await go(cp, '#/candidate/walkins?id=' + encodeURIComponent(driveId));
  cp.once('dialog', (d) => d.accept());
  await cp.click('text=Cancel registration');
  await cp.waitForTimeout(1500);
  must(await cp.$('text=Register for this drive'), 'Register is not offered again');
  const st = await cp.evaluate(() => TL.api.get('/my-walkin-registrations'));
  must(st.past.some((d) => d.myRegistration.status === 'CANCELLED'), 'not cancelled on the server');
  await cp.click('text=Register for this drive');
  await cp.waitForTimeout(1500);
  must(/You are registered!/.test(await text(cp)), 'could not register again');
  // and the running drive, for attendance
  const r = await cp.evaluate((id) => TL.api.post('/walkin-drives/' + id + '/register', {}).then(() => 'ok', (e) => e.message), todayId);
  must(r === 'ok', 'register for today: ' + r);
});

/* ---------------- recruiter, again ---------------- */
await check('10. registrations: search, status filter, attendance on a running drive', async () => {
  await go(rp, '#/recruiter/walkins?id=' + encodeURIComponent(driveId));
  let t = await text(rp);
  must(t.includes(cand.name), 'the candidate is not listed');
  must(/once the drive starts/.test(t), 'attendance is offered before the drive');
  await rp.fill('#wkrQ', 'nobody-' + stamp); await rp.press('#wkrQ', 'Enter'); await rp.waitForTimeout(1000);
  must(/No registrations match/.test(await text(rp)), 'search did not filter');
  await rp.fill('#wkrQ', 'walkin verify'); await rp.press('#wkrQ', 'Enter'); await rp.waitForTimeout(1000);
  must((await text(rp)).includes(cand.name), 'search did not find the candidate');
  await rp.fill('#wkrQ', ''); await rp.press('#wkrQ', 'Enter'); await rp.waitForTimeout(800);

  await go(rp, '#/recruiter/walkins?id=' + encodeURIComponent(todayId));
  await rp.click('button:has-text("Attended")');
  await rp.waitForTimeout(1200);
  t = await text(rp);
  must(/Attended/.test(t) && await rp.$('button:has-text("Undo")'), 'attendance not marked');
  await rp.selectOption('#wkrS', 'NO_SHOW'); await rp.waitForTimeout(1000);
  must(/No registrations match/.test(await text(rp)), 'status filter');
  await rp.selectOption('#wkrS', ''); await rp.waitForTimeout(1000);
  await shot(rp, '10-recruiter-registrations');
});

await check('11. export CSV and Excel', async () => {
  const [csv] = await Promise.all([rp.waitForEvent('download'), rp.click('text=Export CSV')]);
  const csvPath = join(SHOTS, `registrations-${stamp}.csv`);
  await csv.saveAs(csvPath);
  const { readFileSync } = await import('node:fs');
  const body = readFileSync(csvPath, 'utf8');
  must(body.includes('Walkin Verify') && /Attended|ATTENDED/.test(body), 'CSV content');
  const [xl] = await Promise.all([rp.waitForEvent('download'), rp.click('text=Export Excel')]);
  must(/\.xlsx$/.test(xl.suggestedFilename()), 'excel name ' + xl.suggestedFilename());
  const xp = join(SHOTS, `registrations-${stamp}.xlsx`);
  await xl.saveAs(xp);
  must(readFileSync(xp).slice(0, 2).toString() === 'PK', 'not an xlsx');
});

await check('12. an edit that matters reaches the candidate; the bell opens the drive', async () => {
  await go(rp, '#/recruiter/walkins');
  await rp.click(`tr:has-text("${TITLE}") button:has-text("Edit")`);
  await rp.waitForSelector('#wkForm');
  await rp.fill('#wkF_venueName', 'Hotel Grand Annexe');
  await rp.click('#wkForm button.btn-primary');
  await rp.waitForTimeout(2500);
  const d = (await rp.evaluate(() => TL.api.get('/recruiter/walkin-drives'))).drives.find((x) => x.title === TITLE);
  must(d.venueName === 'Hotel Grand Annexe' && d.version === 2, 'not saved');

  await cp.goto('about:blank'); await cp.goto(BASE + '#/candidate/walkins'); await ready(cp); await cp.waitForTimeout(1500); await wizardAway(cp);
  const notes = await cp.evaluate(() => (TL.notifications || []).filter((n) => /^WALKIN_/.test(n.type)).map((n) => n.title));
  must(notes.includes('Walk-in registration confirmed') && notes.includes('Walk-in drive details changed'), 'notifications: ' + JSON.stringify(notes));
  await cp.click('button.cp-ico[title="Notifications"]');
  await cp.waitForTimeout(500);
  const row = await cp.$('.cp-panel.on .cp-row:has-text("details changed")');
  must(row, 'not in the bell');
  await shot(cp, '12-candidate-bell');
  await row.click();
  await cp.waitForTimeout(1500);
  must((await cp.evaluate(() => location.hash)).includes(encodeURIComponent(driveId)), 'the bell did not open the drive');
  must((await text(cp)).includes('Hotel Grand Annexe'), 'the drive does not show the new venue');
});

await check('13. phone width: no sideways scroll, and the drawer has Walk-in Drives', async () => {
  const mc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await open(mc, '#/');
  await signIn(mp, cand.email, cand.password, 'candidate', '#/candidate/walkins');
  await mp.waitForTimeout(1500);
  const wide = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  must(wide <= 1, `page is ${wide}px wider than the screen`);
  must((await text(mp)).includes(TITLE), 'list not shown on a phone');
  await shot(mp, '13-mobile-list');
  await go(mp, '#/candidate/walkins?id=' + encodeURIComponent(driveId));
  const wide2 = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  must(wide2 <= 1, `details page is ${wide2}px wider than the screen`);
  await shot(mp, '13-mobile-detail');
  await mp.evaluate(() => window.nkDrawer && nkDrawer(true));
  await mp.waitForTimeout(500);
  must(await mp.$('.nk-draw.on button:has-text("Walk-in Drives")'), 'not in the mobile drawer');
  await shot(mp, '13-mobile-drawer');
  await mc.close();
});

await check('no script errors on any page', async () => {
  must(!errors.length, errors.slice(0, 3).join(' | '));
});

await browser.close();
console.log(`\nscreenshots: ${SHOTS}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
