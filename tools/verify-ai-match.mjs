/**
 * The AI Match and the candidate job card, in a real browser (owner, 2026-10-05).
 *
 *   AI Match % = the JD's required skills the candidate has / the JD's
 *   required skills x 100 - one number, from GET /job-matches/explain.
 *
 * At desktop (1366), tablet (768) and phone (390), on Search Jobs:
 *   1  the card shows ONE percentage, top right, equal to the API's; a JD with
 *      no skills shows none; no "Why this job matches you" / "Skill gap" on the
 *      card; the bottom gap line has no "%"; "0 applicants"; "+N more" skills
 *   2  "Why this match? ↓" expands the details beside (wide) or under (narrow)
 *      the card, the button reads "Hide match details ↑", a second click
 *      collapses it; the details carry the same % and the same matched /
 *      missing skills as the API, plus Experience / Location / AI
 *      Recommendation reasons
 *   3  "✕ Remove" takes away exactly one reason; removing them all shows
 *      "No match reasons selected."; the skills stay; the % never moves; the
 *      removals survive a reload (this viewer, this job)
 *   4  a job with every skill (no missing), the external job card (no %, Apply
 *      Now opens the original posting), the tiered "Jobs in <place>" cards and
 *      the Find Jobs card carry the same single number
 *   5  every action still works: Apply Now (the application form, and one
 *      real application on desktop), Save, Job Description, View Job, Share
 *   6  no horizontal overflow, collapsed and expanded; no page errors
 *
 * Creates accounts and jobs, so it refuses :4323. Run against an isolated
 * instance:  TL_URL=http://127.0.0.1:4429/ SHOTS=<dir> node tools/verify-ai-match.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { completeApplyForm, closeApplyForm, applyFormOpen } from './lib/apply-form.mjs';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4429/').replace(/\/?$/, '/');
const SHOTS = process.env.SHOTS || '';
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let failed = 0, passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (e) { failed += 1; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);
const PW = process.env.TL_PASSWORD || 'TeamLink@2026';
const EXT_URL = `https://www.naukri.com/job-listings-verify-ai-match-${stamp}`;

const browser = await chromium.launch();
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }); };
async function open(ctx, hash) {
  const page = await ctx.newPage();
  page.__errors = [];
  page.on('pageerror', (e) => page.__errors.push(e.message));
  await page.goto(BASE + (hash || '#/'));
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 60000 });
  await page.waitForTimeout(400);
  return page;
}
const away = (p) => p.evaluate(() => {
  document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((b) => b.click());
});
const go = async (p, hash) => { await p.evaluate((x) => { location.hash = x; }, hash); await p.waitForTimeout(1200); await away(p); };

/* ---- setup: three TeamLink jobs, one external job, one candidate ---- */
const setup = await (async () => {
  const ctx = await browser.newContext();
  const p = await open(ctx);
  const out = await p.evaluate(async ({ s, pw, extUrl }) => {
    try {
      /* the external posting: an admin-made manual source, a fictional employer */
      await TL.api.post('/auth/login', { email: 'admin@teamlink.com', password: pw, role: 'admin' });
      const src = 'aim_src_' + s;
      const body = { id: src, name: 'Naukri verify ' + s, sourceType: 'partner_api', collectionMethod: 'manual',
        connector: 'naukri', applicationMethod: 'redirect' };
      await TL.api.post('/external/sources', { ...body, active: false });
      await TL.api.put(`/external/sources/${src}/licence`, { collectionMethod: 'partner_feed', licenceStatus: 'active',
        consentStatus: 'granted', termsUrl: 'https://partner.verify-ui-testing.in/terms', dataUsageAllowed: true,
        applicationRedirectAllowed: true, owner: 'verify-ai-match', notes: 'verification only - test licence' });
      await TL.api.post('/external/sources', { ...body, active: true });
      await TL.api.post('/external/jobs', { sourceId: src, jobs: [{ id: 'AIM-' + s, title: `External Verify Role ${s}`,
        company: 'Verify External Co', location: 'Hyderabad', skills: ['Java', 'Spring'], experience: '2-5 yrs',
        employmentType: 'Full-time', url: extUrl, postedAt: new Date().toISOString(), description: 'A sample posting for this check.' }] });
      await TL.api.post('/auth/logout', {}).catch(() => {});

      await TL.api.post('/auth/login', { email: 'recruiter@teamlink.com', password: pw, role: 'recruiter' });
      const boot = await TL.api.get('/bootstrap');
      const myCo = ((boot.data.recruiters || []).find((r) => boot.session && r.id === boot.session.id) || {}).companyId;
      const co = (boot.data.companies || []).find((x) => x.id === myCo) || (boot.data.companies || [])[0];
      const mk = (title, skills, extra = {}) => TL.api.post('/jobs', {
        title: `${title} ${s}`, companyId: co.id, location: 'Hyderabad', mode: 'Onsite', exp: '2-4 yrs',
        pay: '₹3-5 LPA', salaryMin: 3, salaryMax: 5, type: 'Full-time', status: 'open', skills, ...extra,
      }).then(async (r) => { await TL.api.put(`/jobs/${r.job.id}/screening-questions`, { questions: [] }); return r.job; });
      const gap = await mk('AIM Java Backend', ['Java', 'Python', 'SQL', 'Spring Boot', 'AWS', 'Docker', 'Kubernetes']);
      const full = await mk('AIM Python Analyst', ['Python', 'SQL']);
      const none = await mk('AIM Field Executive', []);
      await TL.api.post('/auth/logout', {}).catch(() => {});

      const email = `aim.cand.${s}@tl-sink.local`, password = `Portal${s}9`;
      const reg = await TL.api.post('/auth/register', { name: 'Aim Candidate', email, password,
        phone: '9' + String(Math.floor(1e8 + Math.random() * 9e8)), preferredLocation: 'Hyderabad', expectedCtc: 4,
        noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'] });
      await TL.api.put('/candidates/' + reg.candidateId, { location: 'Hyderabad', exp: '3 yrs', expYears: 3,
        skills: ['Java', 'Python', 'SQL', 'React', 'HTML', 'CSS'] });
      const f = new File(['Java and Python developer. SQL reporting. React front ends.'], 'cv.txt', { type: 'text/plain' });
      await TL.uploadResume(f, reg.candidateId);
      return { gap, full, none, ext: 'AIM-' + s, email, password };
    } catch (e) { return 'ERR ' + (e.code || '') + ' ' + e.message + ' ' + JSON.stringify(e.details || {}); }
  }, { s: stamp, pw: PW, extUrl: EXT_URL });
  await ctx.close();
  return out;
})();
if (typeof setup === 'string') { console.error('setup failed: ' + setup); process.exit(1); }
const { gap, full, none } = setup;

async function signIn(ctx) {
  /* the external Apply opens the original posting: it lands on a stub, never the real site */
  await ctx.route(/^https:\/\/(www\.)?naukri\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>stub' }));
  const p = await open(ctx, '#/');
  await p.evaluate(async ({ e, pw }) => {
    await TL.api.post('/auth/login', { email: e, password: pw, role: 'candidate' });
    await TL.refresh();
  }, { e: setup.email, pw: setup.password });
  return p;
}
const apiMatch = (p, id) => p.evaluate((j) => TL.api.get('/job-matches/explain?jobIds=' + j).then((r) => r.matches[0]), id);
const card = (id) => `#app .rj-card.tlc[data-tljob="${id}"]`;
/* wait for a selector; on a miss, say what the card held instead */
const waitIn = (p, sel, id, timeout = 6000) => p.waitForSelector(sel, { timeout }).catch(async () => {
  const held = await p.$eval(card(id), (e) => e.innerText.replace(/\s+/g, ' ').slice(0, 400)).catch(() => 'no card');
  throw new Error(`no ${sel} - the card shows: ${held}`);
});
const noOverflow = (p) => p.evaluate(() => {
  const d = document.documentElement;
  return { ok: d.scrollWidth <= d.clientWidth + 1, sw: d.scrollWidth, cw: d.clientWidth };
});

const VIEWS = [
  { name: 'desktop', vp: { viewport: { width: 1366, height: 900 } } },
  { name: 'tablet', vp: { viewport: { width: 768, height: 1024 }, hasTouch: true } },
  { name: 'phone', vp: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
];

for (const V of VIEWS.filter((v) => !process.env.VIEW || process.env.VIEW.split(',').includes(v.name))) {
  console.log(`\nAI Match + job card (${BASE}, ${V.name})`);
  const ctx = await browser.newContext(V.vp);
  const p = await signIn(ctx);
  await go(p, '#/candidate/search');
  await p.waitForSelector(`${card(gap.id)} .tlc-pct`, { timeout: 15000 }).catch(() => {});
  if (V.name !== VIEWS[0].name && !process.env.VIEW) {
    await check(`${V.name} 0. reasons removed on the last screen stay removed here (the candidate's own preference)`, async () => {
      const v = await p.evaluate(() => localStorage.getItem('tlpu.whyHidden.v1'));
      must(v && /experience/.test(v), 'not carried over: ' + v);
    });
  }
  /* each screen size starts with every reason showing */
  await p.evaluate(() => localStorage.removeItem('tlpu.whyHidden.v1'));
  await p.waitForTimeout(300);
  const A = await apiMatch(p, gap.id);
  const B = await apiMatch(p, full.id);
  const C = await apiMatch(p, none.id);

  await check(`${V.name} 1. one % on the card, equal to the API (${A.score}%), top right`, async () => {
    must(A.score === 43, `API says ${A.score}, expected 3 of 7 = 43`);
    const t = await p.$eval(card(gap.id), (e) => e.innerText);
    const pcts = t.match(/\d+\s*%/g) || [];
    must(pcts.length === 1 && pcts[0].replace(/\s/g, '') === `${A.score}%`, 'percentages on the card: ' + JSON.stringify(pcts));
    must((await p.$eval(`${card(gap.id)} .rj-score b`, (e) => e.textContent.trim())) === `${A.score}%`, 'badge');
    must(/AI Match/.test(await p.$eval(`${card(gap.id)} .tlc-pct`, (e) => e.textContent)), 'not labelled AI Match');
    const pos = await p.evaluate((s) => {
      const c = document.querySelector(s).getBoundingClientRect();
      const b = document.querySelector(s + ' .tlc-pct').getBoundingClientRect();
      const t = document.querySelector(s + ' .rj-t').getBoundingClientRect();
      return { right: c.right - b.right, top: b.top - t.top, phone: innerWidth < 600 };
    }, card(gap.id));
    must(pos.phone ? pos.top < 120 : (pos.right < 40 && pos.top < 30), 'not top right / near the title: ' + JSON.stringify(pos));
  });

  await check(`${V.name} 1b. no reasons or skill gap on the card; the gap line has no %; 0 applicants; +N more`, async () => {
    const t = await p.$eval(card(gap.id), (e) => e.innerText);
    must(!/Why this job matches you/i.test(t) && !/Skill gap/i.test(t) && !/AI recommendation/i.test(t), 'reasons on the card: ' + t.slice(0, 300));
    const g = await p.$eval(`${card(gap.id)} .tlpu-gap`, (e) => e.innerText).catch(() => '');
    must(g && !/%/.test(g), 'gap line: ' + g);
    must(/⚠ Spring Boot/.test(g) && /⚠ AWS/.test(g), 'gap line lists the missing skills: ' + g);
    must(/0 applicants/.test(t), 'no "0 applicants"');
    const more = await p.$eval(`${card(gap.id)} .tlc-more`, (e) => e.textContent.trim());
    must(more === '+2 more', 'expander: ' + more);
    const vis = () => p.$$eval(`${card(gap.id)} .tlc-sk .sk`, (a) => a.filter((x) => x.offsetParent).length);
    must(await vis() === 5, 'first five pills');
    await p.click(`${card(gap.id)} .tlc-more`);
    must(await vis() === 7, 'all seven after +2 more');
    must((await p.$eval(`${card(gap.id)} .tlc-more`, (e) => e.textContent.trim())) === 'Show less', 'Show less');
    await p.click(`${card(gap.id)} .tlc-more`);
    must(await vis() === 5, 'collapsed again');
    await shot(p, `${V.name}-01-card`);
  });

  await check(`${V.name} 1c. a JD with no skills shows no percentage at all`, async () => {
    must(C.score === null, 'API score ' + C.score);
    const t = await p.$eval(card(none.id), (e) => e.innerText);
    must(!/\d+\s*%/.test(t), 'a % on the no-skills card: ' + t.slice(0, 200));
    must(!/0% AI Match/.test(t), '0%');
  });

  await check(`${V.name} 2. Why this match? expands beside / under the card; same % and skills as the API; collapses`, async () => {
    const btn = `${card(gap.id)} .rj-why`;
    must((await p.$eval(btn, (e) => e.textContent.trim())) === 'Why this match? ↓', 'button text');
    const hashBefore = await p.evaluate(() => location.hash);
    await p.click(btn);
    await p.waitForSelector(`${card(gap.id)} .tlc-detail .tlc-reasons`, { timeout: 5000 });
    must((await p.evaluate(() => location.hash)) === hashBefore, 'navigated away');
    must((await p.$eval(btn, (e) => e.textContent.trim())) === 'Hide match details ↑', 'toggle text');
    must((await p.$eval(btn, (e) => e.getAttribute('aria-expanded'))) === 'true', 'aria-expanded');
    const d = await p.$eval(`${card(gap.id)} .tlc-detail`, (e) => ({
      text: e.innerText,
      ok: [...e.querySelectorAll('.tlc-chip.ok')].map((x) => x.textContent.replace(/^✓\s*/, '').trim()),
      miss: [...e.querySelectorAll('.tlc-chip.miss')].map((x) => x.textContent.replace(/^○\s*/, '').trim()),
      rows: [...e.querySelectorAll('.tlc-r')].map((x) => x.getAttribute('data-reason')),
    }));
    must(/🎯 Why this job matches you/.test(d.text), 'title');
    must(new RegExp(`Matched Skills \\(${A.matchedSkills.length}/${A.required}\\)`).test(d.text), 'matched heading');
    must(new RegExp(`Missing Skills \\(${A.missingSkills.length}\\)`).test(d.text), 'missing heading');
    must(JSON.stringify(d.ok) === JSON.stringify(A.matchedSkills), `matched ${d.ok} vs ${A.matchedSkills}`);
    must(JSON.stringify(d.miss) === JSON.stringify(A.missingSkills), `missing ${d.miss} vs ${A.missingSkills}`);
    const pcts = d.text.match(/\d+\s*%/g) || [];
    must(pcts.every((x) => x.replace(/\s/g, '') === `${A.score}%`), 'a different % in the details: ' + pcts);
    for (const k of ['experience', 'location', 'ai']) must(d.rows.includes(k), `no ${k} reason: ${d.rows}`);
    must(/Experience Match/.test(d.text) && /Location Match/.test(d.text) && /AI Recommendation/.test(d.text), 'reason headings');
    /* beside on a wide card, under on a narrow one */
    const geo = await p.evaluate((s) => {
      const m = document.querySelector(s + ' .tlc-main').getBoundingClientRect();
      const x = document.querySelector(s + ' .tlc-detail').getBoundingClientRect();
      return { beside: x.left >= m.right - 2 && x.top < m.bottom, under: x.top >= m.bottom - 2 };
    }, card(gap.id));
    if (V.name === 'desktop') must(geo.beside, 'desktop: not beside the card ' + JSON.stringify(geo));
    if (V.name === 'phone') must(geo.under, 'phone: not under the card ' + JSON.stringify(geo));
    const of = await noOverflow(p);
    must(of.ok, 'horizontal overflow when expanded ' + JSON.stringify(of));
    await p.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'start' }), card(gap.id));
    await shot(p, `${V.name}-02-expanded`);
    await p.click(btn);
    must(!(await p.$(`${card(gap.id)} .tlc-detail`)), 'still open after the second click');
    must((await p.$eval(btn, (e) => e.textContent.trim())) === 'Why this match? ↓', 'toggle text back');
  });

  await check(`${V.name} 3. ✕ Remove takes away exactly one reason; all gone -> "No match reasons selected."; % unchanged; kept on reload`, async () => {
    await p.click(`${card(gap.id)} .rj-why`);
    await waitIn(p, `${card(gap.id)} .tlc-r`, gap.id);
    const rows = () => p.$$eval(`${card(gap.id)} .tlc-r`, (a) => a.map((x) => x.getAttribute('data-reason')));
    const before = await rows();
    must(before.length >= 3, 'rows ' + before);
    await p.click(`${card(gap.id)} .tlc-r[data-reason="${before[0]}"] .tlc-rm`);
    const after = await rows();
    must(after.length === before.length - 1 && JSON.stringify(after) === JSON.stringify(before.slice(1)), `${before} -> ${after}`);
    must(await p.evaluate(() => !!document.activeElement && document.activeElement.classList.contains('tlc-rm')), 'focus left the details');
    while ((await rows()).length) await p.click(`${card(gap.id)} .tlc-r .tlc-rm`);
    const none2 = await p.$eval(`${card(gap.id)} .tlc-none`, (e) => !e.hidden && e.textContent.trim());
    must(none2 === 'No match reasons selected.', 'empty message: ' + none2);
    must((await p.$$(`${card(gap.id)} .tlc-chip`)).length === A.matchedSkills.length + A.missingSkills.length, 'the skills went too');
    must((await p.$eval(`${card(gap.id)} .rj-score b`, (e) => e.textContent.trim())) === `${A.score}%`, 'the % moved');
    must((await apiMatch(p, gap.id)).score === A.score, 'the server score moved');
    await shot(p, `${V.name}-03-all-removed`);
    /* the removals are this candidate's own preference (user_prefs, through
       the page's storage shim, saved 400 ms after the last change) */
    await p.waitForTimeout(1500);
    await p.reload();
    await p.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
    await p.waitForTimeout(1500); await away(p);
    await waitIn(p, `${card(gap.id)} .rj-why`, gap.id, 10000);
    await p.click(`${card(gap.id)} .rj-why`);
    await waitIn(p, `${card(gap.id)} .tlc-detail .tlc-none`, gap.id);
    must((await rows()).length === 0, 'removed reasons came back after a reload');
    await p.click(`${card(gap.id)} .rj-why`);
  });

  await check(`${V.name} 4. a job with every skill: 100%, "Missing Skills (0)"`, async () => {
    must(B.score === 100 && B.missingSkills.length === 0, JSON.stringify(B).slice(0, 200));
    must((await p.$eval(`${card(full.id)} .rj-score b`, (e) => e.textContent.trim())) === '100%', 'badge');
    must(!(await p.$(`${card(full.id)} .tlpu-gap`)) || !/Python|SQL/.test(await p.$eval(`${card(full.id)} .tlpu-gap`, (e) => e.innerText)), 'a matched skill listed as a gap');
    await p.click(`${card(full.id)} .rj-why`);
    await p.waitForSelector(`${card(full.id)} .tlc-detail`, { timeout: 5000 });
    must(/Missing Skills \(0\)/.test(await p.$eval(`${card(full.id)} .tlc-detail`, (e) => e.innerText)), 'no "Missing Skills (0)"');
    await p.click(`${card(full.id)} .rj-why`);
  });

  await check(`${V.name} 4b. the external job card: no %, Apply Now opens the original posting`, async () => {
    const sel = '#app .rj-card[data-external="1"]';
    await p.waitForSelector(sel, { timeout: 10000 });
    const ext = await p.$$eval(sel, (a, t) => a.filter((x) => x.innerText.includes(t)).map((x) => x.innerText), `External Verify Role ${stamp}`);
    must(ext.length === 1, 'external card not listed');
    must(!/\d+\s*%/.test(ext[0]), 'a % on the external card');
    const [pop] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 8000 }),
      p.$$eval(sel, (a, t) => { const c = a.find((x) => x.innerText.includes(t)); c.querySelector('.rj-btn.pri').click(); }, `External Verify Role ${stamp}`),
    ]);
    await pop.waitForLoadState().catch(() => {});
    must(pop.url() === EXT_URL, 'opened ' + pop.url());
    await pop.close();
  });

  await check(`${V.name} 5. every action still works: Save, Job Description, Share, View Job, Apply Now`, async () => {
    const save = `${card(gap.id)} .rj-foot .rj-btn:nth-child(2)`;
    must(/☆ Save/.test(await p.$eval(save, (e) => e.textContent)), 'save label');
    await p.click(save); await p.waitForTimeout(600);
    must(/★ Saved/.test(await p.$eval(save, (e) => e.textContent)), 'not saved');
    await p.click(save); await p.waitForTimeout(600);

    await p.click(`${card(gap.id)} .rj-foot button[onclick^="tlJdModal"]`);
    await p.waitForSelector('#fcrModalHost', { timeout: 5000 });
    must(/AIM Java Backend/.test(await p.$eval('#fcrModalHost', (e) => e.innerText)), 'job description modal');
    await p.evaluate(() => fcrCloseModal());

    await p.click(`${card(gap.id)} .tlpu-share`);
    await p.waitForSelector('.tlpu-sheet [data-ch="copy"]', { timeout: 5000 });
    await p.evaluate(() => tlpuCloseSheet());

    const applyOn = V.name === 'desktop' ? full.id : gap.id;
    await p.click(`${card(applyOn)} .rj-btn.pri`);
    const hint = await p.waitForSelector('#tlrsApplyAnyway', { timeout: 2500 }).catch(() => null);
    if (hint) { await hint.click(); await p.waitForTimeout(400); }
    must(await applyFormOpen(p, 8000), 'Apply Now did not open the application form');
    if (V.name === 'desktop') {
      /* one real application, in this throwaway instance */
      const r = await completeApplyForm(p);
      must(r.state === 'done', 'apply: ' + JSON.stringify(r));
    }
    await closeApplyForm(p);
    await p.waitForTimeout(800);
    if (V.name === 'desktop') {
      await go(p, '#/candidate/search');
      await p.waitForSelector(card(full.id), { timeout: 8000 });
      must(/✓ Applied/.test(await p.$eval(card(full.id), (e) => e.innerText)), 'the card does not say Applied');
    }

    await p.click(`${card(gap.id)} .rj-foot button[onclick^="navigate('/job/"]`);
    await p.waitForTimeout(1200);
    must((await p.evaluate(() => location.hash)).startsWith(`#/job/${gap.id}`), 'View Job: ' + await p.evaluate(() => location.hash));
    await go(p, '#/candidate/search');
  });

  await check(`${V.name} 6. the "Jobs in <place>" cards and Find Jobs carry the same single number`, async () => {
    await p.evaluate(() => { tlLocState('candHome').tags = ['Hyderabad']; render(); });
    await p.waitForTimeout(1200);
    await p.waitForSelector(`${card(gap.id)} .rj-score b`, { timeout: 8000 });
    const t = await p.$eval(card(gap.id), (e) => e.innerText);
    const pcts = t.match(/\d+\s*%/g) || [];
    must(pcts.length === 1 && pcts[0] === `${A.score}%`, 'tiered card: ' + pcts);
    await shot(p, `${V.name}-04-tiered`);
    await p.evaluate(() => { tlLocState('candHome').tags = []; if (STATE.rj && STATE.rj.f) STATE.rj.f.locTags = []; render(); });
    await go(p, '#/jobs');
    await p.waitForTimeout(800);
    const jc = await p.$$eval('#app .job-card', (a, id) => a.filter((x) => x.innerHTML.includes(id)).map((x) => x.innerText), gap.id);
    if (jc.length) {
      const pc = jc[0].match(/\d+\s*%/g) || [];
      must(pc.length === 1 && pc[0] === `${A.score}%`, 'Find Jobs card: ' + pc);
      must(/AI Match/.test(jc[0]), 'Find Jobs badge not labelled AI Match');
    }
    await go(p, '#/candidate/search');
  });

  await check(`${V.name} 7. no horizontal overflow; no page errors`, async () => {
    const of = await noOverflow(p);
    must(of.ok, JSON.stringify(of));
    must(!p.__errors.length, 'page errors: ' + p.__errors.slice(0, 3).join(' | '));
  });
  await ctx.close();
}

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
