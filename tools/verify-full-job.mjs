/*
 * "View Job" → the complete Job Details page, in a real browser, at desktop
 * and at 390px. The owner's final test (Full-Job-Navigation, 15 steps):
 *
 *    1 open the portal               9 Apply Now → the existing application flow
 *    2 find a job                   10 ← Back to Jobs → the same search, scrolled where it was
 *    3 click View Job               11 open another job
 *    4 the complete page opens      12 its own data shows
 *    5 the URL has the right id     13 refresh the job page
 *    6 no "undefined"               14 still the same complete page
 *    7 scroll the whole page        15 the browser's Back works
 *    8 everything belongs to that job
 *
 * and: a signed-out direct URL, an unknown id ("Job not found", no
 * redirect), a job with no labels (clean fallbacks), Search Jobs, candidate
 * Home and the public list all open the job they show, an external job
 * stays external, no "undefined" in #app, no page errors.
 *
 * Creates jobs and candidates, so it refuses :4323. Run against an isolated
 * instance:  TL_URL=http://127.0.0.1:4431/ node tools/verify-full-job.mjs
 */
import { chromium } from 'playwright';
import { completeApplyForm, closeApplyForm } from './lib/apply-form.mjs';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4431/').replace(/\/?$/, '/');
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
const TOKEN = `Fjq${s}`;
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const phone = () => '9' + String(Math.floor(1e8 + Math.random() * 9e8));

const b = await chromium.launch();
const errors = [];

/* ---------------- the jobs: six that share a search word, one bare ---------------- */
const setup = await (await b.newContext()).newPage();
await setup.goto(BASE + '#/');
await setup.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
const made = await setup.evaluate(async ({ pw, s, token }) => {
  await TL.api.post('/auth/login', { email: 'recruiter@teamlink.com', password: pw, role: 'recruiter' });
  const boot = await TL.api.get('/bootstrap');
  const me = (boot.data.recruiters || []).find((r) => r.id === boot.session.id) || {};
  const cities = ['Hyderabad', 'Pune', 'Chennai', 'Bengaluru', 'Kochi', 'Nagpur'];
  const out = [];
  for (let i = 0; i < 6; i++) {
    const j = {
      title: `${token} Engineer ${i + 1}`, companyId: me.companyId, location: cities[i], mode: i % 2 ? 'Hybrid' : 'Onsite',
      exp: `${i + 1}-${i + 4} yrs`, pay: `₹${4 + i}-${8 + i} LPA`, salaryMin: 4 + i, salaryMax: 8 + i, type: 'Full-time', status: 'open',
      skills: ['Java', 'SQL', `Skill${i + 1}${s}`], department: `Team ${i + 1} ${s}`, education: `Degree ${i + 1} ${s}`,
      desc: `Role ${i + 1} for ${token}. ` + 'You will build and support services used by candidates every day. '.repeat(12),
      responsibilities: [`Own area ${i + 1} ${s}`, 'Review changes', 'Fix defects'],
      requirements: [`Requirement ${i + 1} ${s}`, 'Team experience'],
    };
    const r = await TL.api.post('/jobs', j);
    await TL.api.put(`/jobs/${r.job.id}/screening-questions`, { questions: [] }).catch(() => {});
    out.push({ ...j, id: r.job.id });
  }
  /* no mode, experience, pay or type: the page must not print "undefined" */
  const bare = await TL.api.post('/jobs', { title: `Bare ${token} Role`, companyId: me.companyId, location: 'Hyderabad', status: 'open', skills: ['Java'] });
  await TL.api.put(`/jobs/${bare.job.id}/screening-questions`, { questions: [] }).catch(() => {});
  await TL.api.post('/auth/logout', {});
  return { jobs: out, bare: { id: bare.job.id, title: `Bare ${token} Role` } };
}, { pw: PW, s, token: TOKEN });
const JOBS = made.jobs;
const BARE = made.bare;
const byId = Object.fromEntries(JOBS.map((j) => [j.id, j]));

/* one external posting, through the admin's manual source, when the layer is on */
await setup.context().close();
async function makeExternal() {
  const ap = await (await b.newContext()).newPage();
  await ap.goto(BASE + '#/');
  await ap.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  const out = await ap.evaluate(async ({ pw, s }) => {
  let step = 'admin login';
  try {
    await TL.api.post('/auth/login', { email: 'admin@teamlink.com', password: pw, role: 'admin' });
    const src = `f2src_${s}`;
    step = 'source';
    await TL.api.post('/external/sources', { id: src, name: `F2 Source ${s}`, collectionMethod: 'manual',
      applicationMethod: 'redirect', active: true });
    step = 'approved domain';
    await TL.api.put(`/external/sources/${src}/config`, { allowedDomains: ['example.com'] });
    step = 'posting';
    await TL.api.post('/external/jobs', { sourceId: src, jobs: [{ id: `F2-${s}`, title: `External Check ${s}`, company: 'Example Works',
      location: 'Hyderabad', skills: ['Java'], experience: '2-5 yrs', employmentType: 'Full-time',
      url: `https://example.com/jobs/f2-${s}`, postedAt: new Date().toISOString(), description: 'An external posting.' }] });
    await TL.api.post('/auth/logout', {});
    const r = await fetch('/api/portal/external-jobs?limit=500', { cache: 'no-store' }).then((x) => x.json());
    const j = (r.jobs || []).find((x) => x.title === `External Check ${s}`);
    return j ? { id: j.id, title: j.title } : { skip: 'not listed: ' + JSON.stringify(r).slice(0, 120) };
  } catch (e) { return { skip: `${step}: ${e.message}` }; }
  }, { pw: ADMIN_PW, s });
  await ap.context().close();
  return out;
}
let ext = await makeExternal();
if (!ext.id) ext = await makeExternal();

/* ---------------- helpers ---------------- */
const appText = (p) => p.evaluate(() => (document.getElementById('app') || {}).innerText || '');
const noUndefined = async (p, where) => {
  const t = await appText(p);
  const m = t.match(/.{0,40}\bundefined\b.{0,40}/);
  must(!m, `${where}: "undefined" on the page: …${m && m[0]}…`);
};
const h1 = (p) => p.evaluate(() => ((document.querySelector('#app h1') || {}).textContent || '').trim());
const hash = (p) => p.evaluate(() => location.hash);
const wizardAway = (p) => p.evaluate(() => document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((x) => x.click()));
const waitTitle = (p, title, timeout = 15000) => p.waitForFunction((t) => {
  const e = document.querySelector('#app h1'); return !!e && e.textContent.indexOf(t) >= 0;
}, title, { timeout });
const viewJobBtn = (p, id) => p.locator(`#app button[onclick="navigate('/job/${id}')"]`).first();
async function registerCandidate(p, tag) {
  await p.goto(BASE + '#/');
  await p.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  const r = await p.evaluate(async ({ tag, s, ph }) => TL.api.post('/auth/register', {
    name: 'Full Job Check', email: `fulljob.${tag}.${s}@tl-verify.test`, password: `FullJob${s}9x`, phone: ph,
    preferredLocation: 'Hyderabad', expectedCtc: 6, noticePeriod: 'Immediate', preferredWorkModes: ['Onsite'], skills: ['Java'],
    consent: { terms: true, communication: true, resumeProcessing: true },
  }).then(() => 'ok', (e) => e.message), { tag, s, ph: phone() });
  must(r === 'ok', 'could not register the test candidate: ' + r);
}
async function open(p, h) {
  await p.goto(BASE + `?z=${Date.now()}${h}`);
  await p.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await p.waitForTimeout(1200);
  await wizardAway(p);
}
/* the complete page: every section, the buttons, the way back */
async function completePage(p, job, where) {
  const t = await appText(p);
  for (const sec of ['Job description', 'Responsibilities', 'Requirements', 'Key skills', 'Education', 'Team', 'About ']) {
    must(t.includes(sec), `${where}: no "${sec}" section`);
  }
  /* the match panel: "Your match", or M2's "🎯 N% AI Match" once the score is in */
  must(/Your match|% AI Match/.test(t), `${where}: no "Your match" / "AI Match" section`);
  must(await p.locator('#app .tljd-back:visible').count() >= 1, `${where}: no "← Back to Jobs"`);
  must(/Apply Now|Easy Apply|Application submitted/.test(t), `${where}: no Apply Now`);
  must(/Save job|Saved/.test(t), `${where}: no Save Job`);
  must(/Not interested/.test(t) || /Application submitted/.test(t), `${where}: no Not Interested`);
  must(await p.locator('#app .tlpu-share:visible').count() >= 1, `${where}: no Share`);
  if (job) {
    for (const v of [job.location, job.pay, job.exp, job.department, job.education, job.responsibilities[0], job.requirements[0], job.skills[2]]) {
      must(t.includes(v), `${where}: "${v}" of ${job.title} is not on the page`);
    }
  }
}

for (const [label, vp, mobile] of [['desktop', { width: 1366, height: 820 }, false], ['phone', { width: 390, height: 844 }, true]]) {
  console.log(`\n${label} (${vp.width}px)  ${BASE}`);
  const ctx = await b.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  await registerCandidate(p, label);

  let A = null, B = null, listY = 0, cardTop = 0;
  await check(`${label} 1. the portal opens (Search Jobs)`, async () => {
    await open(p, '#/candidate/search');
    must(await hash(p) === '#/candidate/search', 'at ' + await hash(p));
    await p.waitForSelector('#rjQ', { timeout: 10000 });
  });
  await check(`${label} 2. find a job: search, then scroll down the results`, async () => {
    await p.fill('#rjQ', TOKEN);
    await p.press('#rjQ', 'Enter');
    await p.waitForFunction((n) => document.querySelectorAll('#app .rj-card').length >= n, 6, { timeout: 10000 });
    const ids = await p.evaluate((tok) => Array.from(document.querySelectorAll('#app .rj-card'))
      .filter((c) => c.textContent.includes(tok))
      .map((c) => { const x = c.querySelector('button[onclick^="navigate(\'/job/"]'); return x ? x.getAttribute('onclick') : ''; })
      .map((oc) => (/\/job\/([^']+)'/.exec(oc || '') || [])[1]).filter(Boolean), TOKEN)
      .then((all) => all.filter((id) => byId[id]));     /* the six full jobs, not the bare one */
    must(ids.length >= 6, 'only ' + ids.length + ' of our jobs in the results');
    A = byId[ids[ids.length - 2]]; B = byId[ids[0]];
    must(A && B && A.id !== B.id, 'could not pick two jobs');
    await viewJobBtn(p, A.id).scrollIntoViewIfNeeded();
    await p.mouse.wheel(0, 120);
    await p.waitForTimeout(400);
    listY = await p.evaluate(() => scrollY);
    must(listY > 200, 'the results did not scroll: ' + listY);
    cardTop = await viewJobBtn(p, A.id).evaluate((e) => e.closest('.rj-card').getBoundingClientRect().top);
  });
  if (!A || !B) { console.log(`  STOP  ${label}: steps 3-15 need the two jobs from step 2`); failed += 1; await ctx.close(); continue; }
  await check(`${label} 3-5. View Job opens the complete page of that job, at #/job/<its id>, and stays`, async () => {
    await viewJobBtn(p, A.id).click();
    await waitTitle(p, A.title);
    await p.waitForTimeout(2500);                     /* nothing sends it back by itself */
    must(await hash(p) === '#/job/' + A.id, 'URL is ' + await hash(p));
    must((await h1(p)).includes(A.title), 'heading: ' + await h1(p));
    must(await p.evaluate(() => scrollY) < 50, 'the page did not open at the top');
    await p.waitForFunction(() => /Your match ·|% AI Match/.test((document.querySelector('.tlpu-jp') || {}).textContent || ''), null, { timeout: 10000 });
    await completePage(p, A, 'job page');
    /* "← Back to Jobs" is on screen and nothing (the header) covers it */
    const hit = await p.evaluate(() => {
      const x = Array.from(document.querySelectorAll('#app .tljd-back')).find((e) => e.offsetParent);
      if (!x) return 'none';
      const r = x.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return at === x || x.contains(at) ? 'ok' : 'covered by ' + (at && at.className);
    });
    must(hit === 'ok', '← Back to Jobs: ' + hit);
    await p.screenshot({ path: `${SHOTS}/full-job-${label}-top.png` });
  });
  await check(`${label} 6. no "undefined" anywhere on the page`, async () => { await noUndefined(p, 'job page'); });
  await check(`${label} 7. the whole page scrolls, to the footer, with nothing sideways`, async () => {
    const r = await p.evaluate(async () => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((res) => setTimeout(res, 300));
      const f = document.querySelector('.site-footer');
      const fr = f ? f.getBoundingClientRect() : null;
      /* a signed-in candidate's job page is inside the candidate shell
         (verify-candidate-header), which has no public footer: there the
         page's last panel is what comes into view at the bottom */
      const last = Array.from(document.querySelectorAll('#app .tljd .panel')).filter((e) => e.offsetParent)
        .reduce((a, e) => (!a || e.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? e : a), null);
      const lr = last ? last.getBoundingClientRect() : null;
      return { y: scrollY, ih: innerHeight, sh: document.documentElement.scrollHeight, sw: document.documentElement.scrollWidth, vw: innerWidth,
        shell: !!document.querySelector('#app .cp-hd'),
        footer: !!fr && fr.top < innerHeight && fr.bottom > 0,
        lastPanel: !!lr && lr.bottom <= innerHeight + 1 && lr.bottom > 0 };
    });
    must(r.sh > r.ih, 'the page is not taller than the window');
    must(r.y + r.ih >= r.sh - 2, `did not reach the bottom (${r.y}+${r.ih} of ${r.sh})`);
    must(r.shell ? r.lastPanel : r.footer, r.shell ? 'the last panel is not in view at the bottom' : 'the footer is not in view at the bottom');
    must(r.sw <= r.vw + 1, `sideways scroll: ${r.sw} > ${r.vw}`);
    if (mobile) {
      const order = await p.evaluate(() => {
        const apply = Array.from(document.querySelectorAll('#app .tljd-act button')).find((x) => x.offsetParent);
        const desc = Array.from(document.querySelectorAll('#app .panel-head h2')).find((x) => x.textContent === 'Job description');
        return apply && desc ? apply.getBoundingClientRect().top < desc.getBoundingClientRect().top : null;
      });
      must(order === true, 'on a phone Apply Now is not above the description');
      await p.screenshot({ path: `${SHOTS}/full-job-${label}-bottom.png` });
    }
    await p.evaluate(() => window.scrollTo(0, 0));
  });
  await check(`${label} 8. everything on it belongs to that job, the match too`, async () => {
    await completePage(p, A, 'job page');
    const m = await p.evaluate(() => (document.querySelector('.tlpu-jp') || {}).getAttribute('data-tlpu-job'));
    must(m === A.id, 'the match panel is for ' + m);
    /* other jobs may be listed under "Similar jobs"; none of their own data is on the page */
    must(!(await h1(p)).includes(B.title), 'another job\'s heading');
    const t = await appText(p);
    must(!t.includes(B.responsibilities[0]) && !t.includes(B.education), 'another job\'s details are on the page');
  });
  await check(`${label} 9. Apply Now opens the existing application form, and applies to THIS job`, async () => {
    await p.locator('#app .tljd-act button.btn-primary:visible').first().click();
    const f = await completeApplyForm(p, { timeout: 8000 });
    must(f.state === 'done', 'application form: ' + JSON.stringify(f));
    await closeApplyForm(p);
    must(await hash(p) === '#/job/' + A.id, 'moved to ' + await hash(p));
    const n = await p.evaluate((id) => TL.api.get('/applications').then((o) => o.applications.filter((a) => a.jobId === id).length), A.id);
    must(n === 1, `${n} applications for the job`);
  });
  await check(`${label} 10. ← Back to Jobs: the same search, scrolled where it was`, async () => {
    await p.evaluate(() => window.scrollTo(0, 400));
    await p.locator('#app .tljd-back:visible').first().click();
    await p.waitForSelector('#rjQ', { timeout: 10000 });
    await p.waitForTimeout(900);
    must(await hash(p) === '#/candidate/search', 'at ' + await hash(p));
    must(await p.inputValue('#rjQ') === TOKEN, 'the search was lost: ' + await p.inputValue('#rjQ'));
    /* scrolled back down, with the card that was opened where it was in the window */
    const y = await p.evaluate(() => scrollY);
    must(y > listY / 2, `scroll ${y}, was ${listY}`);
    const top = await viewJobBtn(p, A.id).evaluate((e) => e.closest('.rj-card').getBoundingClientRect().top);
    must(Math.abs(top - cardTop) <= 40, `the opened job's card is at ${Math.round(top)}px, was ${Math.round(cardTop)}px`);
  });
  await check(`${label} 11-12. another job opens with its own data`, async () => {
    await viewJobBtn(p, B.id).scrollIntoViewIfNeeded();
    await viewJobBtn(p, B.id).click();
    await waitTitle(p, B.title);
    await p.waitForTimeout(1200);
    must(await hash(p) === '#/job/' + B.id, 'URL is ' + await hash(p));
    await completePage(p, B, 'second job');
    must(!(await appText(p)).includes(A.responsibilities[0]), 'the first job\'s data is still on the page');
    await noUndefined(p, 'second job');
  });
  await check(`${label} 13-14. refresh: the same complete page, no redirect`, async () => {
    await p.reload();
    await p.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
    await waitTitle(p, B.title);
    await p.waitForTimeout(2500);
    must(await hash(p) === '#/job/' + B.id, 'after the refresh: ' + await hash(p));
    await completePage(p, B, 'after refresh');
    await noUndefined(p, 'after refresh');
  });
  await check(`${label} 15. the browser's Back returns to the portal`, async () => {
    await p.goBack();
    await p.waitForFunction(() => window.TL && TL.ready === true && location.hash === '#/candidate/search' && !!document.getElementById('rjQ'), null, { timeout: 15000 })
      .catch(async () => { throw new Error('at ' + await hash(p) + ' / ' + await h1(p)); });
  });

  await check(`${label} extra: candidate Home → View Job opens that job; Back to Jobs returns Home`, async () => {
    await open(p, '#/candidate/home');
    await p.waitForTimeout(1500);           /* Home rearranges itself once its panels arrive */
    const first = p.locator(`#app button[onclick^="navigate('/job/"]:visible`).first();
    must(await first.count(), 'no View Job on Home');
    const id = (/\/job\/([^']+)'/.exec(await first.getAttribute('onclick')) || [])[1];
    /* Home repaints its panels as they load; a click can land between two */
    for (let i = 0; i < 4; i++) {
      try { await viewJobBtn(p, id).click({ timeout: 4000 }); break; } catch (e) { if (i === 3) throw e; await p.waitForTimeout(700); }
    }
    await p.waitForFunction((i) => location.hash === '#/job/' + i && !!document.querySelector('#app .tljd'), id, { timeout: 10000 });
    await p.waitForTimeout(1500);
    const want = await p.evaluate((i) => DATA.jobById(i).title, id);
    must((await h1(p)).includes(want), `heading ${await h1(p)} is not ${want}`);
    await noUndefined(p, 'from Home');
    await p.locator('#app .tljd-back:visible').first().click();
    await p.waitForTimeout(800);
    must(await hash(p) === '#/candidate/home', 'back at ' + await hash(p));
  });
  await check(`${label} extra: the job description modal's "Open full job page" opens the page`, async () => {
    await open(p, '#/candidate/search');
    await p.fill('#rjQ', TOKEN); await p.press('#rjQ', 'Enter');
    await p.waitForTimeout(800);
    const jd = p.locator(`#app button[onclick="tlJdModal('${B.id}')"]`).first();
    if (await jd.count()) { await jd.scrollIntoViewIfNeeded(); await jd.click(); } else await p.evaluate((i) => tlJdModal(i), B.id);
    await p.waitForSelector('#fcrModalHost .fcr-jd-actions');
    await p.click('#fcrModalHost button:has-text("Open full job page")');
    await waitTitle(p, B.title);
    await p.waitForTimeout(1500);
    must(await hash(p) === '#/job/' + B.id, 'URL is ' + await hash(p));
    must(!(await p.$('#fcrModalHost')), 'the modal is still open');
    must(await p.evaluate(() => document.body.style.overflow === ''), 'page scrolling still locked');
    await completePage(p, B, 'from the modal');
  });
  await check(`${label} extra: a job with no labels shows clean fallbacks, never "undefined"`, async () => {
    await p.evaluate((i) => navigate('/job/' + i), BARE.id);
    await waitTitle(p, BARE.title);
    await p.waitForTimeout(1500);
    await noUndefined(p, 'bare job');
    const t = await appText(p);
    must(/Not specified|not specified/.test(t), 'no "Not specified" fallback');
    await completePage(p, null, 'bare job');
  });
  await check(`${label} extra: an unknown id says "Job not found", stays, and Back to Jobs works`, async () => {
    await open(p, `#/job/j_nosuch_${s}`);
    await p.waitForFunction(() => /Job not found/.test((document.querySelector('#app h1') || {}).textContent || ''), null, { timeout: 10000 });
    await p.waitForTimeout(2500);
    must(await hash(p) === `#/job/j_nosuch_${s}`, 'redirected to ' + await hash(p));
    await noUndefined(p, 'not found');
    if (label === 'phone') await p.screenshot({ path: `${SHOTS}/full-job-${label}-notfound.png` });
    await p.locator('#app .tljd-back:visible').first().click();
    await p.waitForTimeout(800);
    must(await hash(p) === '#/candidate/search', 'Back to Jobs went to ' + await hash(p));
  });
  if (ext.id) {
    await check(`${label} extra: an external job stays external; Apply opens the original site`, async () => {
      await open(p, '#/job/' + ext.id);
      await waitTitle(p, ext.title);
      const t = await appText(p);
      must(/External/.test(t), 'not marked external');
      const oc = await p.evaluate(() => Array.from(document.querySelectorAll('#app button')).map((x) => x.getAttribute('onclick') || '').find((x) => /tlpxApply/.test(x)) || '');
      must(oc.includes(ext.id), 'Apply is not the external apply: ' + oc);
      must(!(await p.$('#app .tljd-act')), 'turned into a TeamLink job page');
      must(await p.locator('#app .tljd-back:visible').count() === 1, 'no Back to Jobs');
      await noUndefined(p, 'external job');
    });
  } else console.log(`  SKIP  ${label} external job: ${ext.skip}`);
  await ctx.close();
}

/* signed out */
console.log('\nsigned out');
for (const [label, vp] of [['desktop', { width: 1366, height: 820 }], ['phone', { width: 390, height: 844 }]]) {
  const ctx = await b.newContext({ viewport: vp, isMobile: label === 'phone', hasTouch: label === 'phone' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`signed out ${label}: ${e.message}`));
  await check(`signed out ${label}: a direct URL opens the complete page; Back to Jobs → the jobs list`, async () => {
    const A = JOBS[2];
    await open(p, '#/job/' + A.id);
    await waitTitle(p, A.title);
    await p.waitForTimeout(2500);
    must(await hash(p) === '#/job/' + A.id, 'redirected to ' + await hash(p));
    const t = await appText(p);
    must(/Log in to see your match/.test(t), 'no "Log in to see your match"');
    for (const v of [A.location, A.pay, A.department, A.education, A.requirements[0]]) must(t.includes(v), `"${v}" missing`);
    await noUndefined(p, 'signed out');
    await p.locator('#app .tljd-back:visible').first().click();
    await p.waitForTimeout(1000);
    must(await hash(p) === '#/jobs', 'Back to Jobs went to ' + await hash(p));
  });
  await check(`signed out ${label}: the public list opens the job clicked, and Back returns to the list`, async () => {
    await open(p, '#/jobs?q=' + encodeURIComponent(TOKEN));
    const row = p.locator(`#app [onclick="navigate('/job/${JOBS[4].id}')"]`).first();
    must(await row.count(), 'the job is not in the public list');
    await row.scrollIntoViewIfNeeded();
    const listHash = await hash(p);
    await row.click();
    await waitTitle(p, JOBS[4].title);
    must(await hash(p) === '#/job/' + JOBS[4].id, 'URL is ' + await hash(p));
    await noUndefined(p, 'public job');
    await p.locator('#app .tljd-back:visible').first().click();
    await p.waitForTimeout(1000);
    must(await hash(p) === listHash, `back at ${await hash(p)}, not ${listHash}`);
    await noUndefined(p, 'public list');
  });
  await ctx.close();
}

await check('no page errors', async () => { must(!errors.length, errors.join(' | ')); });
await b.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
