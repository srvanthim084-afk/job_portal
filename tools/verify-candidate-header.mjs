/*
 * The candidate header on the job page and the other pages a candidate
 * opens from the portal, in a real browser, at 1366px and at 390px.
 * The owner's Candidate-Header-On-Detail test:
 *
 *   a  candidate login -> Jobs list -> View Job -> the candidate header,
 *      Jobs lit, never the public header
 *   b  signed out -> a job link -> the public header, exactly as before
 *   c  refresh on #/job/<id> as a candidate -> the candidate header stays,
 *      and the public header never appears, not even for a frame (a
 *      MutationObserver installed before the page's own scripts records
 *      every header that is ever put in the DOM)
 *   d  Jobs on the job page -> the candidate jobs list
 *
 * and: the browser's Back / Forward; company, internship, jobs board,
 * About, "Job not found", the external job page and Career Resources;
 * the bell, messages and profile menu, the phone drawer and bottom bar,
 * the sticky header, ← Back to Jobs uncovered; recruiter and admin keep
 * their own layouts; no page errors.
 *
 * Creates jobs and accounts, so it refuses :4323. Run against an isolated
 * instance:  TL_URL=http://127.0.0.1:4432/ node tools/verify-candidate-header.mjs
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4432/').replace(/\/?$/, '/');
{
  const u = new URL(BASE);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.port === '4323') {
    console.error(`Refusing to run against ${BASE}: this creates jobs and accounts. Use an isolated instance.`);
    process.exit(2);
  }
}
const PW = process.env.TL_RECRUITER_PASSWORD || 'TeamLink@2026';
const ADMIN_PW = process.env.TL_ADMIN_PASSWORD || PW;
const SHOTS = process.env.SHOTS_DIR || process.env.TEMP || '/tmp';
const s = Date.now().toString(36);
const TOKEN = `Chq${s}`;
const CAND_TABS = ['Jobs', 'Internships', 'Walk-in Jobs', 'Companies', 'Career Resources', 'External Jobs'];
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const phone = () => '9' + String(Math.floor(1e8 + Math.random() * 9e8));

const b = await chromium.launch();
const errors = [];

/* Every header that is ever put in the page, from the first paint on. */
const HEADER_WATCH = () => {
  window.__tlHdr = { pub: 0, cand: 0, firstPaint: null };
  const look = () => {
    const app = document.getElementById('app');
    if (!app) return;
    const pub = !!app.querySelector('.site-header');
    const cand = !!app.querySelector('.cp-hd');
    if (pub) window.__tlHdr.pub += 1;
    if (cand) window.__tlHdr.cand += 1;
    if (window.__tlHdr.firstPaint === null && app.children.length) {
      window.__tlHdr.firstPaint = pub ? 'public' : cand ? 'candidate' : 'none';
    }
  };
  new MutationObserver(look).observe(document, { childList: true, subtree: true });
};

/* ---------------- the jobs ---------------- */
const setup = await (await b.newContext()).newPage();
await setup.goto(BASE + '#/');
await setup.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
const made = await setup.evaluate(async ({ pw, s, token }) => {
  await TL.api.post('/auth/login', { email: 'recruiter@teamlink.com', password: pw, role: 'recruiter' });
  const boot = await TL.api.get('/bootstrap');
  const me = (boot.data.recruiters || []).find((r) => r.id === boot.session.id) || {};
  const base = { companyId: me.companyId, location: 'Hyderabad', mode: 'Onsite', exp: '1-4 yrs', pay: '₹5-8 LPA',
    salaryMin: 5, salaryMax: 8, status: 'open', skills: ['Java', 'SQL'], department: 'Engineering', education: 'B.Tech',
    desc: 'Build and support services used by candidates every day. '.repeat(30), responsibilities: ['Own a service'], requirements: ['Java'] };
  const out = {};
  for (const [k, extra] of [['job', { title: `${token} Engineer`, type: 'Full-time' }],
    ['job2', { title: `${token} Analyst`, type: 'Full-time' }],
    ['intern', { title: `${token} Intern`, type: 'Internship', internshipDuration: '3 months', internshipType: 'Paid', stipend: 10000 }]]) {
    const r = await TL.api.post('/jobs', { ...base, ...extra });
    await TL.api.put(`/jobs/${r.job.id}/screening-questions`, { questions: [] }).catch(() => {});
    out[k] = { id: r.job.id, title: extra.title };
  }
  await TL.api.post('/auth/logout', {});
  return { ...out, companyId: me.companyId };
}, { pw: PW, s, token: TOKEN });
await setup.context().close();

/* one external posting, through the admin's manual source */
async function makeExternal() {
  const ap = await (await b.newContext()).newPage();
  await ap.goto(BASE + '#/');
  await ap.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  const out = await ap.evaluate(async ({ pw, s }) => {
    let step = 'admin login';
    try {
      await TL.api.post('/auth/login', { email: 'admin@teamlink.com', password: pw, role: 'admin' });
      const src = `h2src_${s}`;
      step = 'source';
      await TL.api.post('/external/sources', { id: src, name: `H2 Source ${s}`, collectionMethod: 'manual', applicationMethod: 'redirect', active: true });
      step = 'approved domain';
      await TL.api.put(`/external/sources/${src}/config`, { allowedDomains: ['example.com'] });
      step = 'posting';
      await TL.api.post('/external/jobs', { sourceId: src, jobs: [{ id: `H2-${s}`, title: `External Header ${s}`, company: 'Example Works',
        location: 'Hyderabad', skills: ['Java'], experience: '2-5 yrs', employmentType: 'Full-time',
        url: `https://example.com/jobs/h2-${s}`, postedAt: new Date().toISOString(), description: 'An external posting.' }] });
      await TL.api.post('/auth/logout', {});
      const r = await fetch('/api/portal/external-jobs?limit=500', { cache: 'no-store' }).then((x) => x.json());
      const j = (r.jobs || []).find((x) => x.title === `External Header ${s}`);
      return j ? { id: j.id, title: j.title } : { skip: 'not listed' };
    } catch (e) { return { skip: `${step}: ${e.message}` }; }
  }, { pw: ADMIN_PW, s });
  await ap.context().close();
  return out;
}
let ext = await makeExternal();
if (!ext.id) ext = await makeExternal();

/* ---------------- helpers ---------------- */
const hash = (p) => p.evaluate(() => location.hash);
const h1 = (p) => p.evaluate(() => ((document.querySelector('#app h1') || {}).textContent || '').trim());
const wizardAway = (p) => p.evaluate(() => document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((x) => x.click()));
const waitTitle = (p, title, timeout = 15000) => p.waitForFunction((t) => {
  const e = document.querySelector('#app h1'); return !!e && e.textContent.indexOf(t) >= 0;
}, title, { timeout });
const viewJobBtn = (p, id) => p.locator(`#app button[onclick="navigate('/job/${id}')"]`).first();
async function ready(p) {
  await p.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
}
async function open(p, h) {
  await p.goto(BASE + `?z=${Date.now()}${h}`);
  await ready(p);
  await p.waitForTimeout(1200);
  await wizardAway(p);
}
async function go(p, h) {
  await p.evaluate((x) => { location.hash = x; }, h);
  await p.waitForTimeout(1200);
  await wizardAway(p);
}
/* which header is on screen, and what is in it */
const header = (p) => p.evaluate(() => {
  const app = document.getElementById('app');
  const vis = (e) => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const navA = Array.from(app.querySelectorAll('.cp-hd .cp-nav a'));
  const bottomOn = app.querySelector('.cp-bottom button.on');
  return {
    pub: app.querySelectorAll('.site-header').length,
    cand: app.querySelectorAll('.cp-hd').length,
    footer: app.querySelectorAll('.site-footer').length,
    tabs: navA.map((a) => a.textContent.trim()),
    on: navA.filter((a) => a.classList.contains('on')).map((a) => a.textContent.trim()),
    navVisible: vis(app.querySelector('.cp-hd .cp-nav')),
    bell: !!app.querySelector('.cp-hd button[title="Notifications"]'),
    msgs: !!app.querySelector('.cp-hd button[title="Messages"]'),
    me: !!app.querySelector('.cp-hd .cp-me'),
    burger: vis(app.querySelector('.cp-hd .cp-burger')),
    bottomOn: bottomOn ? bottomOn.textContent.trim() : '',
    bottomVisible: vis(app.querySelector('.cp-bottom')),
  };
});
async function candidateHeader(p, where, lit) {
  const h = await header(p);
  must(h.pub === 0, `${where}: the public header is on the page`);
  must(h.cand === 1, `${where}: ${h.cand} candidate headers`);
  must(h.footer === 0, `${where}: the public footer is on the page`);
  must(JSON.stringify(h.tabs) === JSON.stringify(CAND_TABS), `${where}: tabs are ${h.tabs.join(' · ')}`);
  must(h.bell && h.msgs && h.me, `${where}: bell ${h.bell}, messages ${h.msgs}, profile ${h.me}`);
  if (lit !== undefined) must(JSON.stringify(h.on) === JSON.stringify(lit ? [lit] : []), `${where}: lit tab(s) ${JSON.stringify(h.on)}, want ${lit || 'none'}`);
  return h;
}
async function publicHeader(p, where) {
  const h = await header(p);
  must(h.cand === 0, `${where}: the candidate header is on the page`);
  must(h.pub === 1, `${where}: ${h.pub} public headers`);
  const t = await p.evaluate(() => document.querySelector('#app .site-header').textContent);
  for (const w of ['Home', 'AI Hiring Demo', 'AI WhatsApp Agent', 'For Recruiters', 'For Clients', 'Admin']) must(t.includes(w), `${where}: public header has no "${w}"`);
  return t;
}
/* the job page itself is untouched: its sections, buttons and way back */
async function jobPageIntact(p, where) {
  const t = await p.evaluate(() => document.getElementById('app').innerText);
  for (const sec of ['Job description', 'Responsibilities', 'Requirements', 'Key skills']) must(t.includes(sec), `${where}: no "${sec}"`);
  must(/Apply Now|Easy Apply|Application submitted/.test(t), `${where}: no Apply Now`);
  must(/Save job|Saved/.test(t), `${where}: no Save job`);
  must(!/\bundefined\b/.test(t), `${where}: "undefined" on the page`);
  await wizardAway(p);
  const hit = await p.evaluate(() => {
    const x = Array.from(document.querySelectorAll('#app .tljd-back')).find((e) => e.offsetParent);
    if (!x) return 'no ← Back to Jobs';
    x.scrollIntoView({ block: 'center' });
    const r = x.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return at === x || x.contains(at) ? 'ok' : 'covered by ' + (at && at.className);
  });
  await p.evaluate(() => window.scrollTo(0, 0));
  must(hit === 'ok', `${where}: ← Back to Jobs ${hit}`);
}
async function jobsLit(p, where, mobile) {
  const h = await candidateHeader(p, where, 'Jobs');
  if (mobile) {
    must(!h.navVisible && h.burger && h.bottomVisible, `${where}: phone header: nav ${h.navVisible}, ☰ ${h.burger}, bottom bar ${h.bottomVisible}`);
    must(h.bottomOn === 'Jobs' || h.bottomOn === '💼Jobs', `${where}: bottom bar lights "${h.bottomOn}"`);
  } else must(h.navVisible, `${where}: the tabs are not visible`);
}

/* ---------------- a candidate, at desktop and phone width ---------------- */
for (const [label, vp, mobile] of [['desktop', { width: 1366, height: 820 }, false], ['phone', { width: 390, height: 844 }, true]]) {
  console.log(`\n${label} (${vp.width}px)  ${BASE}`);
  const ctx = await b.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile });
  await ctx.addInitScript(HEADER_WATCH);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  const email = `hdr.${label}.${s}@tl-verify.test`, password = `Header${s}9x`;
  await p.goto(BASE + '#/');
  await ready(p);
  const reg = await p.evaluate(async ({ email, password, ph }) => {
    try {
      await TL.api.post('/auth/register', { name: 'Header Check', email, password, phone: ph,
        preferredLocation: 'Hyderabad', expectedCtc: 6, noticePeriod: 'Immediate', preferredWorkModes: ['Onsite'], skills: ['Java'],
        consent: { terms: true, communication: true, resumeProcessing: true } });
      await TL.api.post('/auth/logout', {});
      return 'ok';
    } catch (e) { return e.message; }
  }, { email, password, ph: phone() });
  if (reg !== 'ok') { console.log(`  STOP  ${label}: could not register the candidate: ${reg}`); failed += 1; await ctx.close(); continue; }

  await check(`${label} a. candidate login -> Jobs list -> View Job: the candidate header, Jobs lit`, async () => {
    await open(p, '#/login/candidate');
    await publicHeader(p, 'login page');
    await p.fill('.auth-form input[name="email"]', email);
    await p.fill('.auth-form input[name="password"]', password);
    await p.click('.auth-form button[type="submit"]');
    await p.waitForFunction(() => STATE.session && STATE.session.role === 'candidate' && /^#\/candidate\//.test(location.hash), null, { timeout: 15000 });
    await p.waitForTimeout(1200);
    await wizardAway(p);
    if (mobile) await p.locator('#app .cp-bottom button:has-text("Jobs")').click();
    else await p.locator('#app .cp-nav a', { hasText: /^Jobs$/ }).click();
    await p.waitForSelector('#rjQ', { timeout: 10000 });
    must(await hash(p) === '#/candidate/search', 'Jobs went to ' + await hash(p));
    await p.fill('#rjQ', TOKEN);
    await p.press('#rjQ', 'Enter');
    await viewJobBtn(p, made.job.id).waitFor({ timeout: 10000 });
    await viewJobBtn(p, made.job.id).scrollIntoViewIfNeeded();
    await viewJobBtn(p, made.job.id).click();
    await waitTitle(p, made.job.title);
    await p.waitForTimeout(1500);
    must(await hash(p) === '#/job/' + made.job.id, 'URL is ' + await hash(p));
    await jobsLit(p, 'job page', mobile);
    await jobPageIntact(p, 'job page');
    await p.waitForFunction(() => !!document.querySelector('#app .tlpu-jp'), null, { timeout: 10000 });
    await p.screenshot({ path: `${SHOTS}/cand-header-${label}-job.png` });
  });
  await check(`${label} sticky: the candidate header stays at the top while the job page scrolls`, async () => {
    const r = await p.evaluate(async () => {
      window.scrollTo(0, 900);
      await new Promise((res) => setTimeout(res, 300));
      const hd = document.querySelector('#app .cp-hd').getBoundingClientRect();
      const out = { y: scrollY, top: Math.round(hd.top), sw: document.documentElement.scrollWidth, vw: innerWidth };
      window.scrollTo(0, 0);
      return out;
    });
    must(r.y > 300, 'the page did not scroll: ' + r.y);
    must(r.top === 0, 'header top is ' + r.top + 'px after scrolling');
    must(r.sw <= r.vw + 1, `sideways scroll: ${r.sw} > ${r.vw}`);
  });
  await check(`${label} the profile menu and the bell open on the job page`, async () => {
    await p.click('#app .cp-hd .cp-me');
    await p.waitForSelector('#app .cp-menu.on', { timeout: 5000 });
    must(/Logout/.test(await p.locator('#app .cp-menu.on').innerText()), 'no Logout in the menu');
    await p.mouse.click(5, vp.height - 5);
    await p.waitForTimeout(400);
    must(!(await p.$('#app .cp-menu.on')), 'the menu did not close');
    await p.click('#app .cp-hd button[title="Notifications"]');
    await p.waitForSelector('#app .cp-panel.on', { timeout: 5000 });
    await p.mouse.click(5, vp.height - 5);
    await p.waitForTimeout(400);
    must(await hash(p) === '#/job/' + made.job.id, 'moved to ' + await hash(p));
    await jobsLit(p, 'after the menus', mobile);
  });
  if (mobile) {
    await check(`${label} the ☰ drawer opens on the job page and goes where it says`, async () => {
      await p.click('#app .cp-hd .cp-burger');
      await p.waitForSelector('.nk-draw.on', { timeout: 5000 });
      const rows = await p.locator('.nk-draw.on .nk-row').allInnerTexts();
      must(rows.some((r) => /Saved Jobs/.test(r)), 'drawer rows: ' + rows.join(' | '));
      await p.screenshot({ path: `${SHOTS}/cand-header-${label}-drawer.png` });
      await p.click('.nk-draw.on .nk-x');
      await p.waitForTimeout(400);
      must(!(await p.$('.nk-draw.on')), 'the drawer did not close');
      must(await hash(p) === '#/job/' + made.job.id, 'moved to ' + await hash(p));
    });
  }
  await check(`${label} c. refresh on the job page: the candidate header, and the public one never appears`, async () => {
    await p.reload();
    await ready(p);
    await waitTitle(p, made.job.title);
    await p.waitForTimeout(1500);
    await wizardAway(p);
    must(await hash(p) === '#/job/' + made.job.id, 'after the refresh: ' + await hash(p));
    const w = await p.evaluate(() => window.__tlHdr);
    must(w.pub === 0, `the public header was put in the page ${w.pub} time(s) during the load (first paint: ${w.firstPaint})`);
    must(w.cand > 0, 'the candidate header never appeared');
    must(w.firstPaint !== 'public', 'first paint was the public header');
    await jobsLit(p, 'after the refresh', mobile);
    await jobPageIntact(p, 'after the refresh');
  });
  await check(`${label} d. Jobs on the job page -> the candidate jobs list`, async () => {
    if (mobile) await p.locator('#app .cp-bottom button:has-text("Jobs")').click();
    else await p.locator('#app .cp-nav a', { hasText: /^Jobs$/ }).click();
    await p.waitForSelector('#rjQ', { timeout: 10000 });
    must(await hash(p) === '#/candidate/search', 'Jobs went to ' + await hash(p));
    await candidateHeader(p, 'jobs list');
  });
  await check(`${label} Back / Forward between the list and the job keep the candidate header`, async () => {
    await p.fill('#rjQ', TOKEN);
    await p.press('#rjQ', 'Enter');
    await viewJobBtn(p, made.job2.id).waitFor({ timeout: 10000 });
    await viewJobBtn(p, made.job2.id).scrollIntoViewIfNeeded();
    await viewJobBtn(p, made.job2.id).click();
    await waitTitle(p, made.job2.title);
    await p.evaluate(() => { window.__tlHdr.pub = 0; });
    await p.goBack();
    await p.waitForFunction(() => location.hash === '#/candidate/search' && !!document.getElementById('rjQ'), null, { timeout: 10000 });
    await p.waitForTimeout(600);
    await candidateHeader(p, 'after Back');
    await p.goForward();
    await waitTitle(p, made.job2.title);
    await p.waitForTimeout(800);
    must(await hash(p) === '#/job/' + made.job2.id, 'after Forward: ' + await hash(p));
    await jobsLit(p, 'after Forward', mobile);
    must(await p.evaluate(() => window.__tlHdr.pub) === 0, 'the public header appeared during Back / Forward');
    /* ← Back to Jobs, too */
    await p.locator('#app .tljd-back:visible').first().click();
    await p.waitForSelector('#rjQ', { timeout: 10000 });
    await candidateHeader(p, 'after ← Back to Jobs');
  });
  await check(`${label} internship detail: the candidate header`, async () => {
    await go(p, '#/job/' + made.intern.id);
    await waitTitle(p, made.intern.title);
    await jobsLit(p, 'internship', mobile);
    await jobPageIntact(p, 'internship');
  });
  await check(`${label} company detail (#/company/<id>, the job page's company link): the candidate header, Companies lit`, async () => {
    await go(p, '#/job/' + made.job.id);
    await waitTitle(p, made.job.title);
    const link = p.locator(`#app a[href="#/company/${made.companyId}"]`).first();
    if (await link.count()) await link.click(); else await go(p, '#/company/' + made.companyId);
    await p.waitForTimeout(1000);
    must(await hash(p) === '#/company/' + made.companyId, 'at ' + await hash(p));
    must((await h1(p)).length > 0, 'no company heading');
    await candidateHeader(p, 'company page', 'Companies');
    must(await p.locator('#app').innerText().then((t) => /Open roles/.test(t)), 'the company page content is missing');
  });
  await check(`${label} the public jobs board (#/jobs) and About: the candidate header`, async () => {
    await go(p, '#/jobs');
    await candidateHeader(p, '#/jobs', 'Jobs');
    await go(p, '#/about');
    await candidateHeader(p, '#/about', '');
  });
  await check(`${label} an unknown job id: "Job not found" inside the candidate header`, async () => {
    await go(p, `#/job/j_nosuch_${s}`);
    await p.waitForFunction(() => /Job not found/.test((document.querySelector('#app h1') || {}).textContent || ''), null, { timeout: 10000 });
    await jobsLit(p, 'not found', mobile);
  });
  if (ext.id) {
    await check(`${label} the external job page: the candidate header, External Jobs lit; Apply stays external`, async () => {
      await open(p, '#/job/' + ext.id);
      await waitTitle(p, ext.title);
      await candidateHeader(p, 'external job', 'External Jobs');
      const oc = await p.evaluate(() => Array.from(document.querySelectorAll('#app button')).map((x) => x.getAttribute('onclick') || '').find((x) => /tlpxApply/.test(x)) || '');
      must(oc.includes(ext.id), 'Apply is not the external apply: ' + oc);
      must(await p.locator('#app .tljd-back:visible').count() === 1, 'no ← Back to Jobs');
      must(await p.evaluate(() => window.__tlHdr.pub) === 0, 'the public header appeared while it loaded');
      if (!mobile) await p.screenshot({ path: `${SHOTS}/cand-header-${label}-external.png` });
    });
  } else console.log(`  SKIP  ${label} external job: ${ext.skip}`);
  await check(`${label} Career Resources: the candidate header, Career Resources lit`, async () => {
    await go(p, '#/candidate/career');
    await candidateHeader(p, 'career', 'Career Resources');
  });
  await ctx.close();
}

/* ---------------- signed out ---------------- */
console.log('\nsigned out');
for (const [label, vp] of [['desktop', { width: 1366, height: 820 }], ['phone', { width: 390, height: 844 }]]) {
  const ctx = await b.newContext({ viewport: vp, isMobile: label === 'phone', hasTouch: label === 'phone' });
  await ctx.addInitScript(HEADER_WATCH);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`signed out ${label}: ${e.message}`));
  await check(`signed out ${label} b. a job link: the public header, as before`, async () => {
    await open(p, '#/job/' + made.job.id);
    await waitTitle(p, made.job.title);
    const t = await publicHeader(p, 'job page');
    must(/Login/.test(t) && /Register/.test(t), 'no Login / Register in the public header');
    must((await header(p)).footer === 1, 'no public footer');
    must(await p.evaluate(() => window.__tlHdr.cand) === 0, 'the candidate header appeared');
    await p.reload();
    await ready(p);
    await waitTitle(p, made.job.title);
    await publicHeader(p, 'after the refresh');
    if (label === 'phone') await p.screenshot({ path: `${SHOTS}/cand-header-signedout-${label}.png` });
  });
  await check(`signed out ${label}: company page and jobs board keep the public header`, async () => {
    await go(p, '#/company/' + made.companyId);
    await publicHeader(p, 'company page');
    await go(p, '#/jobs');
    await publicHeader(p, '#/jobs');
  });
  if (ext.id) {
    await check(`signed out ${label}: the external job page is unchanged (no candidate header)`, async () => {
      await open(p, '#/job/' + ext.id);
      await waitTitle(p, ext.title);
      must((await header(p)).cand === 0, 'the candidate header is on the page');
    });
  }
  await ctx.close();
}

/* ---------------- recruiter and admin keep their own layouts ---------------- */
console.log('\nrecruiter / admin');
for (const [role, email, pw, home] of [['recruiter', 'recruiter@teamlink.com', PW, '#/recruiter/home'], ['admin', 'admin@teamlink.com', ADMIN_PW, '#/admin/users']]) {
  const ctx = await b.newContext({ viewport: { width: 1366, height: 820 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${role}: ${e.message}`));
  await check(`${role}: the job page keeps the public header; the dashboard keeps its own layout`, async () => {
    await p.goto(BASE + '#/');
    await ready(p);
    const r = await p.evaluate(async ({ email, pw, role }) => TL.api.post('/auth/login', { email, password: pw, role }).then(() => 'ok', (e) => e.message), { email, pw, role });
    must(r === 'ok', 'login: ' + r);
    await open(p, '#/job/' + made.job.id);
    await waitTitle(p, made.job.title);
    must(await p.evaluate(() => STATE.session && STATE.session.role) === role, 'not signed in as ' + role);
    await publicHeader(p, `${role} job page`);
    await open(p, home);
    const h = await header(p);
    must(h.cand === 0 && h.pub === 0, `${role} dashboard: candidate header ${h.cand}, public header ${h.pub}`);
    must(await p.evaluate(() => !!document.querySelector('#app .sidebar, #app .topbar, #app .dash-body, #app .rec-find-nav, #app [class*="rec-"]')), `${role} dashboard: its layout is missing`);
  });
  await ctx.close();
}

await check('no page errors', async () => { must(!errors.length, errors.join(' | ')); });
await b.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
