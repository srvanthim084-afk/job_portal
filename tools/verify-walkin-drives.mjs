/**
 * Walk-in drives, in a real browser.
 *
 *   recruiter  1  creates a drive through the form (and the form refuses a bad one)
 *              2  the drive is listed with its counts
 *   candidate  3  no "Walk-in Drives" tab in the candidate header; the drawer keeps it
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
 *   public    14  signed out: header link and jobs-page entry; list and filters; the API has no contact phone
 *             15  details while signed out: venue, documents, map, no contact phone
 *             16  Register -> registration form "You're registering for: <drive>"; refresh keeps it; Cancel
 *             17  sign up -> registered for that same drive, automatically (and #/walkins now opens the
 *                 candidate's own page)
 *             18  Register -> Log in (a wrong password first) -> registered for that drive
 *   admin     19  every recruiter's drives with status / city / recruiter / date filters
 *             20  registrations, attendance and CSV on another recruiter's drive
 *             21  edit and cancel through the admin screen; the candidates are told
 *             22  phone width: the public list does not scroll sideways
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

await check('3. no "Walk-in Drives" tab in the candidate header (owner, 2026-10-05); External Jobs stays; the list still opens', async () => {
  await go(cp, '#/candidate/home');
  await wizardAway(cp);
  must(!(await cp.$('nav.cp-nav a:has-text("Walk-in Drives")')), 'the header still has a Walk-in Drives tab');
  must(!(await cp.$('.cp-mscroll button:has-text("Walk-in Drives")')), 'the phone header still has a Walk-in Drives tab');
  await go(cp, '#/candidate/walkins');
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

/* ---------------- public (signed out) ---------------- */
const pc = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pp = await open(pc, '#/jobs');
const fresh = { email: `walkin.public.${stamp}@tl-verify.test`, name: 'Walkin Public ' + stamp };
const pubText = () => pp.evaluate(() => ((document.querySelector('#app') || {}).innerText || ''));
const intentText = () => pp.evaluate(() => ((document.querySelector('.tl-walkin-intent') || {}).innerText || '').split(String.fromCharCode(10)).join(' '));

await check('14. signed out: no walk-in links in the header or on the jobs page (owner, 2026-10-05); #/walkins still lists and filters', async () => {
  must(await pp.evaluate(() => !STATE.session), 'should be signed out');
  must(!(await pp.$('header .main-nav a[href="#/walkins"]')), 'a Walk-ins link is in the signed-out header');
  must(!(await pp.$('a.wk-jobs-entry')), 'a Walk-in Drives entry is on the signed-out jobs page');
  await shot(pp, '14-public-jobs-entry');
  await pp.evaluate(() => { location.hash = '#/walkins'; });
  await pp.waitForTimeout(1500);
  must((await pp.evaluate(() => location.hash)) === '#/walkins', 'did not open #/walkins');
  let t = await pubText();
  must(t.includes(TITLE) && t.includes(`Today Drive ${stamp}`), 'the drives are not listed: ' + t.slice(0, 300));
  must(/Happening now/.test(t), 'the running drive is not marked');
  must(!/% match/.test(t), 'a match % shown to a visitor');
  await shot(pp, '14-public-list');
  await pp.selectOption('#wkpCity', CITY); await pp.waitForTimeout(1200);
  t = await pubText();
  must(t.includes(TITLE), 'city filter lost the drive');
  await pp.fill('#wkpRole', 'warehouse'); await pp.press('#wkpRole', 'Tab'); await pp.waitForTimeout(1200);
  t = await pubText();
  must(t.includes(`Today Drive ${stamp}`) && !t.includes(TITLE), 'role filter');
  await pp.click('text=Clear'); await pp.waitForTimeout(1200);
  await pp.fill('#wkpQ', 'nothing-matches-' + stamp); await pp.press('#wkpQ', 'Enter'); await pp.waitForTimeout(1200);
  must(/No upcoming drives/.test(await pubText()), 'no empty state');
  await pp.click('text=Show all drives'); await pp.waitForTimeout(1200);
  // the public API carries no contact phone, no recruiter, no registrations
  const api = await pp.evaluate(() => fetch('/api/public/walkin-drives').then((r) => r.text()));
  must(!api.includes('9000011111') && !/contactPhone|recruiter|myRegistration/i.test(api), 'the public API leaks: ' + api.slice(0, 200));
});

await check('15. details while signed out: venue, documents, map; no contact phone', async () => {
  await go(pp, '#/walkins?id=' + encodeURIComponent(driveId));
  const t = await pubText();
  for (const s of ['Hotel Grand Annexe', 'Documents to carry', 'Passport-size photo', 'Any degree']) must(t.includes(s), 'missing ' + s);
  must(!t.includes('9000011111'), 'the contact phone is shown to a visitor');
  must(await pp.$('a:has-text("Open in Google Maps")'), 'no maps link');
  await shot(pp, '15-public-detail');
});

await check('16. Register while signed out -> registration with "You\'re registering for"; Cancel returns to the drive', async () => {
  await pp.click('text=Register for this drive');
  await pp.waitForTimeout(1200);
  must(/^#\/register\/candidate/.test(await pp.evaluate(() => location.hash)), 'not on the registration page');
  let b = await intentText();
  must(b.includes("You're registering for") && b.includes(TITLE), 'banner: ' + b);
  await shot(pp, '16-register-banner');
  await pp.reload(); await ready(pp); await pp.waitForTimeout(1500);
  must((await intentText()).includes(TITLE), 'the drive was lost on a refresh');
  await pp.click('.tl-walkin-intent button:has-text("Cancel")');
  await pp.waitForTimeout(1200);
  must((await pp.evaluate(() => location.hash)).includes(encodeURIComponent(driveId)), 'Cancel did not return to the drive');
  must(await pp.evaluate(() => sessionStorage.getItem('tl_walkin_intent_v1')) === null, 'still remembered after Cancel');
});

await check('17. Register -> sign up -> registered for that same drive, automatically', async () => {
  await pp.click('text=Register for this drive');
  await pp.waitForTimeout(1200);
  await pp.fill('#regName', fresh.name);
  await pp.fill('#regMobile', phone());
  await pp.fill('#regLocation', CITY);
  await pp.fill('#regEmail', fresh.email);
  await pp.fill('#regPassword', 'Walk' + stamp + '7');
  await pp.evaluate(() => {
    const q = document.getElementById('regQualification');
    const opt = Array.from(q.options).find((o) => o.value); q.value = opt.value; q.dispatchEvent(new Event('change', { bubbles: true }));
    const n = document.getElementById('regNotice');
    const o2 = Array.from(n.options).find((o) => o.value); n.value = o2.value; n.dispatchEvent(new Event('change', { bubbles: true }));
    const m = document.querySelector('#regWorkModeGroup input[type="checkbox"]'); if (m && !m.checked) m.click();
    ['regConsentTerms', 'regConsentResume'].forEach((id) => { const c = document.getElementById(id); if (!c.checked) c.click(); });
  });
  await pp.fill('#regSkills', 'Communication, Telugu');
  await pp.fill('#regPrefLocation', CITY);
  await pp.fill('#regExpSalary', '3');
  await pp.evaluate(() => { ['regPrefLocation', 'regExpSalary', 'regNotice'].forEach((id) => window.regTouch && regTouch(id)); validateRegisterForm(); });
  must(await pp.evaluate(() => !document.getElementById('regSubmitBtn').disabled), 'the form did not validate');
  await pp.click('#regSubmitBtn');
  await pp.waitForFunction(() => STATE.session && STATE.session.role === 'candidate', null, { timeout: 20000 });
  await pp.waitForTimeout(3500);
  await wizardAway(pp);
  const hash = await pp.evaluate(() => location.hash);
  must(hash.includes(encodeURIComponent(driveId)) && /done=1/.test(hash), 'not on the drive confirmation: ' + hash);
  must(/You are registered!/.test(await pubText()), 'no confirmation');
  const mine = await pp.evaluate(() => TL.api.get('/my-walkin-registrations'));
  must(mine.upcoming.filter((d) => d.id === driveId && d.myRegistration.status === 'REGISTERED').length === 1, 'not registered on the server');
  must(await pp.evaluate(() => sessionStorage.getItem('tl_walkin_intent_v1')) === null, 'the drive is still remembered');
  await shot(pp, '17-registered-after-signup');
  // signed in now: the public address opens the candidate's own drive page
  await go(pp, '#/walkins?id=' + encodeURIComponent(driveId));
  await pp.waitForTimeout(800);
  must((await pp.evaluate(() => location.hash)).startsWith('#/candidate/walkins'), 'a candidate stays on the public page');
  must((await pubText()).includes('9000011111'), 'the signed-in candidate does not see the contact');
});

await check('18. Register -> Log in (existing account) -> registered for that drive', async () => {
  const LOGIN_T = `Login Path Drive ${stamp}`;
  const made = await rp.evaluate((b) => TL.api.post('/recruiter/walkin-drives', b), {
    title: LOGIN_T, jobRole: 'Retail Associate', driveDate: istDay(6), startTime: '09:30', endTime: '13:00',
    venueName: 'Town Mall', fullAddress: '1 Market Street', city: CITY, documentsToCarry: ['Resume'],
  });
  const loginId = made.drive.id;
  const lc = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const lp = await open(lc, '#/walkins?id=' + encodeURIComponent(loginId));
  await lp.waitForTimeout(800);
  await lp.click('text=Register for this drive');
  await lp.waitForTimeout(1200);
  await lp.click('.tl-walkin-intent a:has-text("Log in to register")');
  await lp.waitForTimeout(1200);
  const b = await lp.evaluate(() => ((document.querySelector('.tl-walkin-intent') || {}).innerText || ''));
  must(b.includes(LOGIN_T), 'no banner on the login page: ' + b);
  await shot(lp, '18-login-banner');
  // one wrong password first: the drive is kept
  await lp.fill('form.auth-form input[name="email"]', cand.email);
  await lp.fill('form.auth-form input[name="password"]', 'wrong-' + stamp);
  await lp.click('form.auth-form button[type="submit"]');
  await lp.waitForTimeout(1500);
  must(await lp.evaluate(() => !STATE.session), 'signed in with a wrong password?');
  must((await lp.evaluate(() => ((document.querySelector('.tl-walkin-intent') || {}).innerText || ''))).includes(LOGIN_T), 'the drive was lost after a failed sign-in');
  await lp.fill('form.auth-form input[name="email"]', cand.email);
  await lp.fill('form.auth-form input[name="password"]', cand.password);
  await lp.click('form.auth-form button[type="submit"]');
  await lp.waitForFunction(() => STATE.session && STATE.session.role === 'candidate', null, { timeout: 20000 });
  await lp.waitForTimeout(3000);
  await wizardAway(lp);
  const hash = await lp.evaluate(() => location.hash);
  must(hash.includes(encodeURIComponent(loginId)) && /done=1/.test(hash), 'not on the drive confirmation: ' + hash);
  const regs = await lp.evaluate(() => TL.api.get('/my-walkin-registrations'));
  must(regs.upcoming.filter((d) => d.id === loginId).length === 1, 'not registered on the server');
  await lc.close();
});

/* ---------------- admin ---------------- */
await check('19. admin: Walk-in Drives lists every recruiter\'s drives, with filters', async () => {
  const ac = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
  const ap = await open(ac, '#/');
  await signIn(ap, process.env.TL_ADMIN_EMAIL || 'admin@teamlink.com', process.env.TL_ADMIN_PASSWORD || RECRUITER_PW, 'admin', '#/admin/walkins');
  globalThis.__ap = ap; globalThis.__ac = ac;
  must(/Walk-in Drives/.test(await text(ap, '.sidebar')), 'no Walk-in Drives in the admin sidebar');
  await ap.waitForTimeout(800);
  let t = await text(ap);
  must(t.includes(TITLE) && t.includes(`Today Drive ${stamp}`), 'drives not listed: ' + t.slice(0, 300));
  const recName = await ap.$eval(`tr:has-text("${TITLE}") td:nth-child(2)`, (td) => td.innerText.trim());
  must(recName && recName !== 'Admin', 'no recruiter name: ' + recName);
  await shot(ap, '19-admin-list');
  await ap.selectOption('#wkaStatus', 'ONGOING'); await ap.waitForTimeout(1200);
  t = await text(ap);
  must(t.includes(`Today Drive ${stamp}`) && !t.includes(TITLE), 'status filter');
  await ap.selectOption('#wkaStatus', ''); await ap.waitForTimeout(1000);
  await ap.selectOption('#wkaCity', CITY); await ap.waitForTimeout(1000);
  const recOpt = await ap.$eval('#wkaRec', (s) => Array.from(s.options).filter((o) => o.value && o.value !== 'none').map((o) => o.value));
  must(recOpt.length >= 1, 'no recruiters to filter by');
  await ap.fill('#wkaFrom', istDay(3)); await ap.dispatchEvent('#wkaFrom', 'change'); await ap.waitForTimeout(1000);
  t = await text(ap);
  must(t.includes(TITLE) && !t.includes(`Today Drive ${stamp}`), 'date filter');
  await ap.click('button:has-text("Clear")'); await ap.waitForTimeout(1000);
});

await check('20. admin: registrations, attendance and export on another recruiter\'s drive', async () => {
  const ap = globalThis.__ap;
  await go(ap, '#/admin/walkins?id=' + encodeURIComponent(todayId));
  let t = await text(ap);
  must(t.includes(cand.name) && /Run by/.test(t), 'registrations not shown: ' + t.slice(0, 200));
  const row = `tr:has-text("${cand.name}")`;
  const btn = await ap.$(`${row} button:has-text("No-show")`);
  must(btn, 'no attendance buttons');
  await btn.click(); await ap.waitForTimeout(1200);
  t = await text(ap);
  must(/No-show/.test(t) && await ap.$(`${row} button:has-text("Undo")`), 'attendance not marked');
  const [csv] = await Promise.all([ap.waitForEvent('download'), ap.click('text=Export CSV')]);
  const pth = join(SHOTS, `admin-registrations-${stamp}.csv`);
  await csv.saveAs(pth);
  const { readFileSync } = await import('node:fs');
  must(readFileSync(pth, 'utf8').includes(cand.name), 'CSV content');
  await shot(ap, '20-admin-registrations');
  await ap.click(`${row} button:has-text("Undo")`); await ap.waitForTimeout(800);
});

await check('21. admin: edit and cancel tell the registered candidates', async () => {
  const ap = globalThis.__ap;
  await go(ap, '#/admin/walkins');
  await ap.click(`tr:has-text("${TITLE}") button:has-text("Edit")`);
  await ap.waitForSelector('#wkForm');
  await ap.fill('#wkF_venueName', 'Hotel Grand Main Hall');
  await ap.click('#wkForm button.btn-primary');
  await ap.waitForTimeout(2500);
  let d = (await ap.evaluate(() => TL.api.get('/recruiter/walkin-drives'))).drives.find((x) => x.title === TITLE);
  must(d.venueName === 'Hotel Grand Main Hall' && d.version === 3, 'admin edit not saved: ' + d.venueName + ' v' + d.version);
  ap.once('dialog', (dlg) => dlg.accept('Venue closed for repairs'));
  await ap.click(`tr:has-text("${TITLE}") button:has-text("Cancel")`);
  await ap.waitForTimeout(2500);
  d = (await ap.evaluate(() => TL.api.get('/recruiter/walkin-drives'))).drives.find((x) => x.title === TITLE);
  must(d.status === 'CANCELLED', 'not cancelled: ' + d.status);
  must(/Cancelled/.test(await ap.$eval(`tr:has-text("${TITLE}")`, (tr) => tr.innerText)), 'the list does not say Cancelled');
  await shot(ap, '21-admin-cancelled');
  // the candidates registered for it were told (portal bell), and the drive left the public list
  const notes = await pp.evaluate(() => TL.api.get('/notifications').then((r) => (r.notifications || []).map((n) => n.title)));
  must(notes.includes('Walk-in drive details changed') && notes.includes('Walk-in drive cancelled'), 'notifications: ' + JSON.stringify(notes));
  const pub = await ap.evaluate(() => fetch('/api/public/walkin-drives').then((r) => r.json()));
  must(!pub.drives.some((x) => x.title === TITLE), 'a cancelled drive is still public');
  await globalThis.__ac.close();
});

await check('22. phone width: the public list and the admin screen do not scroll sideways', async () => {
  const mc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await open(mc, '#/walkins');
  await mp.waitForTimeout(1200);
  const wide = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  must(wide <= 1, `public list is ${wide}px wider than the screen`);
  must((await text(mp)).includes(`Today Drive ${stamp}`), 'list not shown on a phone');
  await shot(mp, '22-mobile-public');
  await mc.close();
});

await check('no script errors on any page', async () => {
  must(!errors.length, errors.slice(0, 3).join(' | '));
});

await browser.close();
console.log(`\nscreenshots: ${SHOTS}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
