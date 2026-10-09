/**
 * Apply Now, the applied date and the "Applied Date" calendar (0130), in a
 * real browser, desktop and 390px.
 *
 *   TL_URL=http://127.0.0.1:4471/ TL_SINK_LOG=<mail-sink log> node tools/verify-applied-date.mjs
 *
 * Creates jobs, candidates and applications, so it refuses :4323 - run it
 * against an isolated instance whose mail goes to tools/mail-sink.mjs.
 *
 *   A  one click on Search Jobs: no form; "Applied ✓ · <date>" (off); toast
 *      "Applied successfully to <job> at <company>" with the soft "Complete
 *      your profile" line; never twice
 *   B  the date everywhere: job page, Saved Jobs, the profile-menu count
 *   C  Applications page: first, "Applied on <date>" (time on hover),
 *      "Applied today", the timeline Applied → Screening → Interview → Offer
 *   D  candidate filters: calendar presets, future days off, chips, count,
 *      AND with search, Clear all, Oldest first
 *   N  the in-app notification and the confirmation email say "Applied on"
 *   F  an API failure: Retry, and never a false "Applied"
 *   R  recruiter: the new application arrives by itself; Applied On column
 *      (date, time on hover, TeamLink Portal), sortable; calendar + stage +
 *      search (AND), chips, count, Clear all; the export is the filtered
 *      rows with Applied On; the notice; the profile timeline
 *   T  Talent Pool: Applied on / Added on
 *   M  390px: bottom-sheet calendar, the bottom-bar count, no sideways scroll
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4471/').replace(/\/?$/, '/');
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}
const PW = process.env.TL_PASSWORD || 'TeamLink@2026';
const SINK_LOG = process.env.TL_SINK_LOG || '';
const SHOTS = resolve(process.env.TL_SHOTS || 'var/test-resumes'); mkdirSync(SHOTS, { recursive: true });
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };
const stamp = Date.now().toString(36);
const mobile = () => '9' + String(Math.floor(100000000 + Math.random() * 899999999));
const indiaDay = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 10);
const TODAY = indiaDay(Date.now());
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (ymd) => `${ymd.slice(8, 10)} ${MON[+ymd.slice(5, 7) - 1]} ${ymd.slice(0, 4)}`;
const TODAY_TXT = fmt(TODAY);
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const browser = await chromium.launch();
async function open(hash, opts = { viewport: { width: 1360, height: 900 } }) {
  const ctx = await browser.newContext({ ...opts, acceptDownloads: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e.message)));
  await page.goto(BASE + (hash || '#/'));
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 60000 });
  await page.waitForTimeout(600);
  return page;
}
const api = (page, method, path, body) => page.evaluate(({ m, p, b }) =>
  window.TL.api[m](p, b).then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.code, msg: e.message })),
  { m: method, p: path, b: body });
const go = async (page, hash, wait = 900) => {
  await page.evaluate((x) => { location.hash = x; }, hash);
  await page.waitForTimeout(wait);
  /* the "Build your profile" prompt, if it is up */
  await page.evaluate(() => document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((b) => b.click()));
};
const text = (page, sel) => page.evaluate((s) => (document.querySelector(s) || {}).textContent || '', sel);
const toastText = (page) => text(page, '#tl1cToastHost');

/* ---- setup: a client, six TeamLink jobs owned by the recruiter ---------- */
const setupPage = await open('#/');
const setup = await setupPage.evaluate(async ({ s, pw }) => {
  try {
    await TL.api.post('/auth/login', { email: 'admin@teamlink.com', password: pw, role: 'admin' });
    const co = await TL.api.post('/companies', { id: 'adv_' + s, name: 'Applied Date Clinics ' + s });
    await TL.api.post('/auth/logout', {}).catch(() => {});
    await TL.api.post('/auth/login', { email: 'recruiter@teamlink.com', password: pw, role: 'recruiter' });
    const jobs = [];
    for (const t of ['Staff Nurse', 'Radiographer', 'Lab Technician', 'Pharmacist', 'Physiotherapist', 'Dietician']) {
      const r = await TL.api.post('/jobs', {
        title: `${t} ${s}`, companyId: co.company ? co.company.id : 'adv_' + s, location: 'Hyderabad', mode: 'Onsite',
        exp: '2-4 yrs', pay: '₹3-5 LPA', salaryMin: 3, salaryMax: 5, type: 'Full-time', status: 'open', skills: ['Patient care', 'Records'],
      });
      await TL.api.put(`/jobs/${r.job.id}/screening-questions`, { questions: [] }).catch(() => {});
      jobs.push({ id: r.job.id, title: r.job.title });
    }
    await TL.api.post('/auth/logout', {}).catch(() => {});
    return { jobs, company: 'Applied Date Clinics ' + s };
  } catch (e) { return String(e && e.message || e); }
}, { s: stamp, pw: PW });
await setupPage.context().close();
if (typeof setup === 'string') { console.error('setup failed: ' + setup); process.exit(1); }
const [J1, J2, J3, J4, J5] = setup.jobs;
check(setup.jobs.length === 6, 'setup: six TeamLink jobs for the recruiter');

/* ---- the candidate ------------------------------------------------------ */
const cand = await open('#/');
const CEMAIL = `applied.date.${stamp}@mailbox-teamlink-tests.in`;
const CPASS = 'Applied' + stamp + '7';
const CNAME = 'Applied Date ' + stamp;
const reg = await api(cand, 'post', '/auth/register', {
  name: CNAME, email: CEMAIL, password: CPASS, phone: mobile(),
  preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Office'],
  consent: { terms: true, communication: true, resumeProcessing: true },
});
check(reg.ok, 'setup: a candidate registers' + (reg.ok ? '' : ' - ' + reg.msg));
await cand.evaluate(async () => {
  await TL.refresh();
  const f = new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 37, 37, 69, 79, 70, 10])], 'resume.pdf', { type: 'application/pdf' });
  await TL.uploadResume(f);
  await TL.refresh();
});
const CID = await cand.evaluate(() => STATE.session && STATE.session.id);
const myApps = async () => { const r = await api(cand, 'get', '/applications'); return r.ok ? r.r.applications : []; };

/* ---- A: one click on Search Jobs --------------------------------------- */
await go(cand, '#/candidate/search', 1500);
await cand.evaluate((t) => { const b = document.querySelector('#tlY2HistQ'); return t; }, J1.title);
const cardBtn = (page, id) => page.locator(`#app button[onclick*="rjApplyJob('${id}')"]`).first();
let found = await cardBtn(cand, J1.id).count();
if (!found) { await go(cand, '#/job/' + J1.id, 1200); }
const btn = found ? cardBtn(cand, J1.id) : cand.locator('#app button.btn-block:not([disabled]):has-text("Apply")').first();
await btn.click();
await cand.waitForFunction(() => !!document.getElementById('tl1cDone'), null, { timeout: 15000 }).catch(() => {});
const t1 = await toastText(cand);
check(new RegExp('Applied successfully to ' + J1.title + ' at ' + setup.company).test(t1), `A: toast "Applied successfully to ${J1.title} at ${setup.company}"`);
check(/Complete your profile to improve your chances/.test(t1), 'A: the soft "Complete your profile to improve your chances" line (the apply was not blocked)');
check(await cand.evaluate(() => !document.querySelector('#fcrModalHost .fcr-modal, #tlafForm, .tlpu-sheet')), 'A: no form or modal opened');
await cand.waitForTimeout(700);
const dated = await cand.evaluate((id) => {
  const b = Array.from(document.querySelectorAll('#app button')).find((x) => x.disabled && x.textContent.trim() === 'Applied ✓'
    && (x.getAttribute('data-tlao-job') === id));
  return b ? { on: b.getAttribute('data-applied-on'), after: getComputedStyle(b, '::after').content, title: b.title } : null;
}, J1.id);
check(!!dated && dated.on === TODAY_TXT, `A: the button is "Applied ✓" and off, dated ${TODAY_TXT} (${JSON.stringify(dated)})`);
check(!!dated && /Applied on .*IST/.test(dated.title), 'A: ...the time on hover (IST)');
check(!!dated && dated.after.includes(TODAY_TXT), 'A: ...shown as "Applied ✓ · <date>"');
/* never twice: the plain apply and a second one-click */
const twice = await api(cand, 'post', '/applications/one-click', { jobId: J1.id });
check(twice.ok && twice.r.existing === true, 'A: a second one-click returns the same application');
check((await myApps()).filter((a) => a.jobId === J1.id).length === 1, 'A: one application for the job');
const a1 = (await myApps()).find((a) => a.jobId === J1.id);
check(a1 && a1.stage === 'applied' && a1.source === 'teamlink' && /T/.test(a1.appliedAt), `A: stage applied, source teamlink (TeamLink Portal), applied_at ${a1 && a1.appliedAt}`);

/* ---- B: the date everywhere ------------------------------------------- */
await go(cand, '#/job/' + J1.id, 1200);
check(await cand.evaluate((d) => Array.from(document.querySelectorAll('#app button[disabled]')).some((b) => b.getAttribute('data-applied-on') === d), TODAY_TXT),
  'B: the job page: "Applied ✓ · <date>"');
await cand.evaluate(async (ids) => { for (const id of ids) { if (typeof toggleSaveJob === 'function') await toggleSaveJob(id); } }, [J1.id, J2.id]);
await go(cand, '#/candidate/saved', 1200);
await cand.waitForFunction((id) => Array.from(document.querySelectorAll('#app button')).some((b) => (b.getAttribute('onclick') || '').includes(`cpEasyApply('${id}')`) && b.getAttribute('data-applied-on')),
  J1.id, { timeout: 10000 }).catch(() => {});
const saved = await cand.evaluate(({ j1, j2 }) => {
  const forJob = (id) => Array.from(document.querySelectorAll('#app button')).filter((b) => (b.getAttribute('onclick') || '').includes(`cpEasyApply('${id}')`) && /Appl(y|ied)/.test(b.textContent));
  const b1 = forJob(j1)[0], b2 = forJob(j2)[0];
  return { one: b1 ? { dis: b1.disabled, t: b1.textContent.trim(), on: b1.getAttribute('data-applied-on') } : null,
    two: b2 ? { dis: b2.disabled, t: b2.textContent.trim() } : null, hash: location.hash,
    saved: window.STATE && STATE.savedJobs ? Array.from(STATE.savedJobs) : null,
    cards: Array.from(document.querySelectorAll('.cp-wrap .cp-card')).map((c) => c.textContent.replace(/\s+/g, ' ').slice(0, 60)) };
}, { j1: J1.id, j2: J2.id });
check(!!saved.one && saved.one.dis && saved.one.t === 'Applied ✓' && saved.one.on === TODAY_TXT, `B: Saved Jobs: the applied job says "Applied ✓ · <date>" (${JSON.stringify(saved.one || saved)})`);
check(!saved.two || !saved.two.dis, `B: Saved Jobs: a job not applied to keeps Apply (${JSON.stringify(saved.two)})`);
check(await cand.evaluate(() => {
  const b = document.querySelector('.cp-menu button[onclick*="#/candidate/applications"] .tlao-badge');
  return !!b && b.textContent === '1';
}), 'B: the profile menu shows "My Applications 1"');

/* two more, from the job page */
for (const J of [J2, J3]) {
  await go(cand, '#/job/' + J.id, 1200);
  await cand.locator('#app button.btn-block:not([disabled]):has-text("Apply")').first().click();
  await cand.waitForFunction(() => !!document.getElementById('tl1cDone'), null, { timeout: 15000 }).catch(() => {});
  await cand.waitForTimeout(600);
}
check((await myApps()).length === 3, 'B: three applications');
check(await cand.evaluate(() => (document.querySelector('.cp-menu button[onclick*="#/candidate/applications"] .tlao-badge') || {}).textContent === '3'),
  'B: the count updated to 3 without a reload');

/* ---- C: Applications page ---------------------------------------------- */
await go(cand, '#/candidate/applications', 2500);
const appsPage = await cand.evaluate(() => {
  const cards = Array.from(document.querySelectorAll('.cp-wrap > .cp-card')).filter((c) => c.style.display !== 'none' && /navigate\('\/job\//.test(c.innerHTML));
  const first = cards[0];
  const on = first && first.querySelector('.tlao-on');
  const tl = first && first.querySelector('.tlao-tl');
  return {
    n: cards.length, firstTitle: first ? first.querySelector('div[style*="font-size:15.5px"]').textContent : '',
    on: on ? on.textContent : '', onTitle: on ? on.title : '', rel: first ? (first.querySelector('.tlao-rel') || {}).textContent : '',
    steps: tl ? Array.from(tl.querySelectorAll('li')).map((li) => ({ l: li.querySelector('.l').textContent, c: li.className, w: (li.querySelector('.w') || {}).textContent || '' })) : [],
    info: (document.getElementById('tlY2HistInfo') || {}).textContent || '',
  };
});
check(appsPage.n === 3, `C: three cards (${appsPage.n})`);
check(appsPage.firstTitle === J3.title, `C: the latest application is at the top (${appsPage.firstTitle})`);
check(appsPage.on === 'Applied on ' + TODAY_TXT, `C: "Applied on ${TODAY_TXT}" (${appsPage.on})`);
check(/Applied at \d{1,2}:\d{2} (AM|PM) IST/.test(appsPage.onTitle), `C: the time on hover (${appsPage.onTitle})`);
check(appsPage.rel === 'Applied today', `C: "Applied today" (${appsPage.rel})`);
check(appsPage.steps.map((s) => s.l).join('>') === 'Applied>Screening>Interview>Offer', `C: timeline Applied → Screening → Interview → Offer (${appsPage.steps.map((s) => s.l).join('>')})`);
check(appsPage.steps[0] && new RegExp(TODAY_TXT + ', \\d{1,2}:\\d{2} (AM|PM)').test(appsPage.steps[0].w), `C: "Applied" carries the date and time (${appsPage.steps[0] && appsPage.steps[0].w})`);
check(appsPage.steps[0] && /now|done/.test(appsPage.steps[0].c) && /todo/.test(appsPage.steps[3].c), 'C: Applied is reached, Offer is not');
check(/^3 applications/.test(appsPage.info), `C: the count "3 applications" (${appsPage.info})`);
await cand.screenshot({ path: resolve(SHOTS, `applied-date-candidate-${stamp}.png`), fullPage: false });

/* ---- D: candidate filters ---------------------------------------------- */
await cand.click('#tldr_candAppDate');
await cand.waitForSelector('#tldrPop', { timeout: 5000 });
const pop = await cand.evaluate(() => ({
  presets: Array.from(document.querySelectorAll('#tldrPop .tldr-pre button')).map((b) => b.textContent),
  future: Array.from(document.querySelectorAll('#tldrPop button[data-day]')).filter((b) => b.disabled).map((b) => b.getAttribute('data-day')),
  nextOff: !!document.querySelector('#tldrPop button[data-nav="1"]:disabled'),
}));
check(pop.presets.join('|') === 'Today|Yesterday|Last 7 days|Last 30 days|This month|Last month|Custom range', `D: presets on the left (${pop.presets.join(', ')})`);
check(pop.future.every((d) => d > TODAY) && pop.nextOff, `D: future days off (${pop.future.length} later this month), no next month`);
await cand.click('#tldrPop .tldr-pre button[data-preset="yesterday"]');
await cand.click('#tldrPop button[data-act="apply"]');
await cand.waitForTimeout(1500);
check(/No applications match/.test(await text(cand, '#tlY2HistInfo')), 'D: Yesterday: no applications');
check(/Applied Date: /.test(await text(cand, '#tlY2AppChips')), 'D: a removable "Applied Date" chip');
await cand.click('#tlY2AppChips .tlao-chip button');
await cand.waitForTimeout(1500);
check(/^3 applications/.test(await text(cand, '#tlY2HistInfo')), 'D: removing the chip brings all three back');
/* Custom range: a start, then an end (both today) - and a single day */
await cand.click('#tldr_candAppDate');
await cand.click('#tldrPop .tldr-pre button[data-preset="custom"]');
await cand.click(`#tldrPop button[data-day="${TODAY}"]`);
await cand.click('#tldrPop button[data-act="apply"]');
await cand.waitForTimeout(1500);
check((await text(cand, '#tldr_candAppDate')).includes(TODAY_TXT), `D: the field shows "${TODAY_TXT}"`);
check(/^3 applications/.test(await text(cand, '#tlY2HistInfo')), 'D: a single-day range (today): 3');
await cand.fill('#tlY2HistQ', J2.title);
await cand.waitForTimeout(1800);
check(/^1 application\b/.test(await text(cand, '#tlY2HistInfo')), `D: AND with the search: 1 (${await text(cand, '#tlY2HistInfo')})`);
check((await cand.locator('#tlY2AppChips .tlao-chip').count()) === 2, 'D: two chips (search + date)');
await cand.click('#tlY2AppChips .tlao-clearall');
await cand.waitForTimeout(1800);
check(/^3 applications/.test(await text(cand, '#tlY2HistInfo')) && !(await cand.locator('#tlY2AppChips').count()), 'D: Clear all');
await cand.selectOption('#tlY2HistSort', 'oldest');
await cand.waitForTimeout(1800);
const oldestFirst = await cand.evaluate(() => {
  const c = Array.from(document.querySelectorAll('.cp-wrap > .cp-card')).filter((x) => x.style.display !== 'none' && /navigate\('\/job\//.test(x.innerHTML))[0];
  return c ? c.querySelector('div[style*="font-size:15.5px"]').textContent : '';
});
check(oldestFirst === J1.title, `D: Oldest first puts ${J1.title} on top (${oldestFirst})`);
await cand.selectOption('#tlY2HistSort', 'latest');
await cand.waitForTimeout(800);

/* ---- N: notification and email ----------------------------------------- */
const notes = await api(cand, 'get', '/notifications');
const mine = notes.ok ? notes.r.notifications.find((n) => n.title === 'You applied for ' + J1.title) : null;
check(!!mine && /Applied on \d{2} \w{3} \d{4}, \d{1,2}:\d{2} (AM|PM) IST/.test(mine.message), `N: in-app "You applied for ${J1.title}" with "Applied on <date, time>"`);
if (SINK_LOG && existsSync(SINK_LOG)) {
  let mail = '';
  for (let i = 0; i < 20 && !mail.includes('You applied for ' + J1.title); i++) { await cand.waitForTimeout(1000); mail = readFileSync(SINK_LOG, 'utf8'); }
  check(mail.includes('You applied for ' + J1.title) && mail.includes(CEMAIL), `N: the confirmation email reached the sink: "You applied for ${J1.title}" to the candidate`);
} else {
  console.log('skip  N: no TL_SINK_LOG - the email is checked by the API test');
}

/* ---- F: failure - Retry, never a false Applied ------------------------- */
await go(cand, '#/job/' + J5.id, 1200);
await cand.route('**/api/applications/one-click', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Service unavailable' } }) }));
await cand.locator('#app button.btn-block:not([disabled]):has-text("Apply")').first().click();
await cand.waitForFunction(() => !!document.getElementById('tl1cFail'), null, { timeout: 10000 }).catch(() => {});
check(await cand.evaluate(() => !!document.getElementById('tl1cRetry')), 'F: a retry toast');
check(await cand.evaluate(() => !Array.from(document.querySelectorAll('#app button')).some((b) => /Applied ✓/.test(b.textContent))
  && Array.from(document.querySelectorAll('#app button')).some((b) => /Apply/.test(b.textContent) && !b.disabled)), 'F: no "Applied" state, Apply Now is back');
await cand.unroute('**/api/applications/one-click');
check(!(await myApps()).some((a) => a.jobId === J5.id), 'F: nothing was created');
check(cand.errors.length === 0, `candidate: no page errors (${cand.errors.join(' | ')})`);

/* ---- R: recruiter ------------------------------------------------------ */
const rec = await open('#/');
await rec.evaluate(async (pw) => { await TL.api.post('/auth/login', { email: 'recruiter@teamlink.com', password: pw, role: 'recruiter' }); await TL.refresh(); }, PW);
await go(rec, '#/recruiter/applications', 2000);
/* The screen starts on the recruiter's own company; these jobs are a client's. */
await rec.evaluate(() => { if (typeof tlCoMode === 'function') tlCoMode('all'); });
await rec.waitForTimeout(900);
const rowOf = (page, jobTitle) => page.evaluate(({ t, n }) => {
  const tr = Array.from(document.querySelectorAll('.tl-apps-wrap tbody tr')).find((r) => r.textContent.includes(t) && r.textContent.includes(n));
  if (!tr) return null;
  const on = tr.querySelector('.tl-applied-on');
  return { text: tr.textContent, on: on ? on.querySelector('b').textContent : '', title: on ? on.title : '' };
}, { t: jobTitle, n: CNAME });
const r1 = await rowOf(rec, J1.title);
check(!!r1, 'R: the application is in the recruiter list');
check(!!r1 && r1.on === TODAY_TXT && /, \d{1,2}:\d{2} (AM|PM) IST/.test(r1.title), `R: Applied On "${TODAY_TXT}", the time on hover (${r1 && r1.title})`);
check(!!r1 && /TeamLink Portal/.test(r1.text) && /Applied/.test(r1.text) && /%/.test(r1.text), 'R: came from TeamLink Portal, stage Applied, AI Match %');
check(!!r1 && /TL-APP-/.test(r1.text), 'R: the reference');
/* live: the candidate applies while the recruiter's list is open */
await go(cand, '#/job/' + J4.id, 1200);
await cand.locator('#app button.btn-block:not([disabled]):has-text("Apply")').first().click();
await cand.waitForFunction(() => !!document.getElementById('tl1cDone'), null, { timeout: 15000 }).catch(() => {});
let live = null;
for (let i = 0; i < 40 && !live; i++) { await rec.waitForTimeout(1000); live = await rowOf(rec, J4.title); }
check(!!live, 'R: a new application appears in the open list by itself');
const bell = await api(rec, 'get', '/notifications');
const notice = bell.ok ? bell.r.notifications.find((n) => n.type === 'APPLICATION_RECEIVED' && n.title === `${CNAME} applied for ${J4.title}`) : null;
check(!!notice && /Applied on .* IST/.test(notice.message) && /TeamLink Portal/.test(notice.message), `R: the notice "${CNAME} applied for ${J4.title}" with Applied on`);
/* sorting */
const head = rec.locator('th.tl-sortable');
check((await head.getAttribute('aria-sort')) === 'descending', 'R: Applied On is sorted newest first by default');
await head.click(); await rec.waitForTimeout(700);
check((await rec.locator('th.tl-sortable').getAttribute('aria-sort')) === 'ascending', 'R: a click turns it to oldest first');
await rec.locator('th.tl-sortable').click(); await rec.waitForTimeout(500);
/* filters: calendar + search + stage, AND; chips, count, Clear all */
await rec.click('#tldr_appDate');
await rec.click('#tldrPop .tldr-pre button[data-preset="today"]');
await rec.click('#tldrPop button[data-act="apply"]');
await rec.waitForTimeout(900);
await rec.fill('.tlaf .fld.wide input', CNAME);
await rec.waitForTimeout(900);
const fl = await rec.evaluate(() => ({
  rows: document.querySelectorAll('.tl-apps-wrap tbody tr').length,
  count: (document.querySelector('.tlaf .tlaf-count') || {}).textContent || '',
  chips: Array.from(document.querySelectorAll('.tlaf-chips .tlaf-chip')).map((c) => c.textContent.replace('✕', '').trim()),
}));
check(fl.rows === 4 && /^4 applications/.test(fl.count), `R: today + this candidate: 4 rows, "4 applications" (${fl.rows}, ${fl.count})`);
check(fl.chips.some((c) => c === 'Applied Date: ' + TODAY_TXT) && fl.chips.some((c) => c.startsWith('Search: ')), `R: chips (${fl.chips.join(' | ')})`);
await rec.locator('.tlaf .fld', { hasText: 'Applied for' }).locator('select').selectOption(J2.title);
await rec.waitForTimeout(800);
check((await rec.evaluate(() => document.querySelectorAll('.tl-apps-wrap tbody tr').length)) === 1, 'R: + Applied for: 1 row (AND)');
/* the export: exactly the filtered rows, with Applied On */
await rec.click('#tlxBtn');
await rec.waitForSelector('.tlx-box', { timeout: 10000 });
await rec.check('input[name="tlxScope"][value="filtered"]');
await rec.check('input[name="tlxFormat"][value="csv"]');
const appliedCol = rec.locator('.tlxCol[value="appliedOn"]');
if (await appliedCol.count()) await appliedCol.check();
const [dl] = await Promise.all([rec.waitForEvent('download', { timeout: 15000 }), rec.click('#tlxGo')]);
const csv = readFileSync(await dl.path(), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/);
const hdr = csv[0].split(',');
const ai = hdr.indexOf('Applied On');
check(csv.length === 2, `R: the export has the one filtered application (${csv.length - 1} rows)`);
check(ai >= 0 && new RegExp(TODAY_TXT + ', \\d{1,2}:\\d{2} (AM|PM) IST').test(csv[1] || ''), `R: ...with Applied On (${(csv[1] || '').slice(0, 120)})`);
check((csv[1] || '').includes(J2.title), 'R: ...for the filtered role');
await rec.screenshot({ path: resolve(SHOTS, `applied-date-recruiter-${stamp}.png`) });
await rec.click('.tlaf-chips .tlaf-clearall');
await rec.waitForTimeout(800);
check(!(await rec.locator('.tlaf-chips').count()) && /^\d+ applications?/.test(await text(rec, '.tlaf .tlaf-count')), 'R: Clear all');
await rec.click('#tldr_appDate');
await rec.click('#tldrPop .tldr-pre button[data-preset="yesterday"]');
await rec.click('#tldrPop button[data-act="apply"]');
await rec.waitForTimeout(800);
check(!(await rowOf(rec, J1.title)), 'R: Yesterday: none of today\'s applications');
await rec.click('.tlaf .tldr-x');
await rec.waitForTimeout(800);
check(!!(await rowOf(rec, J1.title)), 'R: the ✕ in the field clears it');
/* the profile timeline */
await go(rec, '#/recruiter/candidate-profile?id=' + CID, 3000);
const tl = await text(rec, '#tlY2Timeline');
check(tl.includes(`Applied for ${J1.title} on ${TODAY_TXT}`), `R: the profile timeline: "Applied for ${J1.title} on ${TODAY_TXT}"`);

/* ---- T: Talent Pool --------------------------------------------------- */
await go(rec, '#/recruiter/talent-pool', 2500);
const tpHas = () => rec.evaluate((n) => (document.getElementById('tpHost') || document.getElementById('app')).textContent.includes(n), CNAME);
await rec.click('#tldr_tp_applied');
await rec.click('#tldrPop .tldr-pre button[data-preset="today"]');
await rec.click('#tldrPop button[data-act="apply"]');
await rec.waitForTimeout(2000);
check(await tpHas(), 'T: Applied on: today finds the candidate');
check(/Applied on: /.test(await text(rec, '.tp-date-chips')), 'T: a chip for it');
await rec.click('#tldr_tp_added');
await rec.click('#tldrPop .tldr-pre button[data-preset="lastMonth"]');
await rec.click('#tldrPop button[data-act="apply"]');
await rec.waitForTimeout(2000);
check(!(await tpHas()), 'T: + Added on: last month - not this candidate (AND)');
await rec.click('.tp-date-chips .tlaf-clearall');
await rec.waitForTimeout(1500);
check(rec.errors.length === 0, `recruiter: no page errors (${rec.errors.join(' | ')})`);

/* ---- M: 390px ---------------------------------------------------------- */
const ph = await open('#/', PHONE);
await ph.evaluate(async ({ e, p }) => { await TL.api.post('/auth/login', { email: e, password: p, role: 'candidate' }); await TL.refresh(); }, { e: CEMAIL, p: CPASS });
await go(ph, '#/candidate/applications', 2500);
await ph.waitForFunction(() => !!document.querySelector('.cp-bottom button[onclick*="#/candidate/applications"] .tlao-badge'), null, { timeout: 8000 }).catch(() => {});
const mob = await ph.evaluate(() => ({
  bottom: ((document.querySelector('.cp-bottom') || {}).outerHTML || 'none').slice(0, 300),
  apps: (DATA.applications || []).filter((a) => a.candidateId === (STATE.session || {}).id).length,
  over: document.documentElement.scrollWidth - window.innerWidth,
  badge: (document.querySelector('.cp-bottom button[onclick*="#/candidate/applications"] .tlao-badge') || {}).textContent || '',
}));
check(mob.over <= 2, `M: no sideways scroll on the Applications page (${mob.over}px)`);
check(mob.badge === '4', `M: the bottom bar shows Applications 4 (${mob.badge}${mob.badge ? '' : ' ' + JSON.stringify(mob)})`);
await ph.click('#tldr_candAppDate');
await ph.waitForSelector('#tldrPop', { timeout: 5000 });
const sheet = await ph.evaluate(() => {
  const r = document.getElementById('tldrPop').getBoundingClientRect();
  return { left: r.left, right: Math.round(r.right), bottom: Math.round(r.bottom), w: window.innerWidth, h: window.innerHeight,
    presets: document.querySelectorAll('#tldrPop .tldr-pre button').length };
});
check(sheet.left === 0 && sheet.right === sheet.w && Math.abs(sheet.bottom - sheet.h) <= 1 && sheet.presets === 7, `M: the calendar is a bottom sheet with the presets (${JSON.stringify(sheet)})`);
await ph.screenshot({ path: resolve(SHOTS, `applied-date-phone-sheet-${stamp}.png`) });
await ph.click('#tldrPop .tldr-pre button[data-preset="last7"]');
await ph.click('#tldrPop button[data-act="apply"]');
await ph.waitForTimeout(1800);
check(/^4 applications/.test(await text(ph, '#tlY2HistInfo')), 'M: Last 7 days: 4');
/* one tap on a phone */
await go(ph, '#/job/' + J5.id, 1500);
await ph.locator('#app button.btn-block:not([disabled]):has-text("Apply")').first().tap();
await ph.waitForFunction(() => !!document.getElementById('tl1cDone'), null, { timeout: 15000 }).catch(() => {});
check(await ph.evaluate(() => !!document.getElementById('tl1cDone') && !document.querySelector('#fcrModalHost .fcr-modal')), 'M: one tap applies, no form');
const rph = await open('#/', PHONE);
await rph.evaluate(async (pw) => { await TL.api.post('/auth/login', { email: 'recruiter@teamlink.com', password: pw, role: 'recruiter' }); await TL.refresh(); }, PW);
await go(rph, '#/recruiter/applications', 2500);
await rph.evaluate(() => { if (typeof tlCoMode === 'function') tlCoMode('all'); });
await rph.waitForTimeout(900);
await rph.locator('#tldr_appDate').scrollIntoViewIfNeeded();
await rph.click('#tldr_appDate');
const rsheet = await rph.evaluate(() => { const r = document.getElementById('tldrPop').getBoundingClientRect(); return { left: r.left, w: Math.round(r.width), vw: window.innerWidth }; });
check(rsheet.left === 0 && rsheet.w === rsheet.vw, 'M: recruiter: the same bottom sheet');
await rph.screenshot({ path: resolve(SHOTS, `applied-date-phone-recruiter-${stamp}.png`) });
check(ph.errors.length === 0 && rph.errors.length === 0, `phone: no page errors (${ph.errors.concat(rph.errors).join(' | ')})`);

await browser.close();
console.log(fail.length ? `\n${fail.length} FAILED` : '\nall passed');
process.exit(fail.length ? 1 : 0);
