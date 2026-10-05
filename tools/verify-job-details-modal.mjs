/*
 * The Job description modal: full window, the header and its ✕ never scroll,
 * only the content does, and the page behind it stays where it was.
 *
 * Creates a job and a candidate, so it refuses :4323. Run against an
 * isolated instance:  TL_URL=http://127.0.0.1:4419/ node tools/verify-job-details-modal.mjs
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4419/').replace(/\/?$/, '/');
if (/:4323\//.test(BASE)) { console.error('Refusing to run against the live instance (:4323).'); process.exit(2); }
const PW = process.env.TL_RECRUITER_PASSWORD || 'TeamLink@2026';
const s = Date.now().toString(36);
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

const b = await chromium.launch();
const errors = [];

/* a job with a long description, so the content really scrolls */
const setup = await (await b.newContext()).newPage();
await setup.goto(BASE + '#/');
await setup.waitForFunction(() => window.TL && TL.ready === true);
const TITLE = `Modal Check Engineer ${s}`;
const jobId = await setup.evaluate(async ({ title, pw }) => {
  await TL.api.post('/auth/login', { email: 'recruiter@teamlink.com', password: pw, role: 'recruiter' });
  const boot = await TL.api.get('/bootstrap');
  const me = (boot.data.recruiters || []).find((r) => r.id === boot.session.id) || {};
  const para = 'You will design, build and support services used by thousands of candidates every day. ';
  const r = await TL.api.post('/jobs', {
    title, companyId: me.companyId, location: 'Hyderabad', mode: 'Onsite', exp: '2-4 yrs', pay: '₹4-7 LPA',
    salaryMin: 4, salaryMax: 7, type: 'Full-time', status: 'open', skills: ['Java', 'SQL', 'Spring'],
    desc: Array.from({ length: 40 }, (_, i) => `${i + 1}. ${para}`).join('\n'),
    requirements: Array.from({ length: 12 }, (_, i) => `Requirement ${i + 1}: hands-on experience`),
  });
  await TL.api.put(`/jobs/${r.job.id}/screening-questions`, { questions: [] }).catch(() => {});
  await TL.api.post('/auth/logout', {});
  return r.job.id;
}, { title: TITLE, pw: PW });
await setup.context().close();

for (const [label, vp, mobile] of [['desktop', { width: 1366, height: 820 }, false], ['phone', { width: 390, height: 844 }, true]]) {
  const ctx = await b.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  await p.goto(BASE + '#/');
  await p.waitForFunction(() => window.TL && TL.ready === true);
  const reg = await p.evaluate(async (s) => TL.api.post('/auth/register', {
      name: 'Modal Check', email: `modal.${s}.${Math.random().toString(36).slice(2, 6)}@tl-verify.test`, password: `Modal${s}9x`,
      phone: '9' + String(Math.floor(1e8 + Math.random() * 9e8)), preferredLocation: 'Hyderabad', expectedCtc: 5,
      noticePeriod: 'Immediate', preferredWorkModes: ['Onsite'],
      consent: { terms: true, communication: true, resumeProcessing: true },
    }).then(() => 'ok', (e) => `${e.message} ${JSON.stringify(e.details || {})}`), s);
  if (reg !== 'ok') throw new Error('could not register the test candidate: ' + reg);
  await p.goto('about:blank');
  await p.goto(BASE + `?z=${Date.now()}#/candidate/search`);
  await p.waitForFunction(() => window.TL && TL.ready === true);
  await p.waitForTimeout(2000);
  await p.evaluate(() => document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((x) => x.click()));

  const xBox = () => p.evaluate(() => {
    const x = document.querySelector('#fcrModalHost .fcr-jd-x');
    if (!x) return null;
    const r = x.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, onTop: !!hit && (hit === x || x.contains(hit)), vw: innerWidth, vh: innerHeight };
  });

  await check(`${label}: the card's "Job description" opens a full-window modal with the ✕ in view`, async () => {
    await p.evaluate(() => window.scrollTo(0, 260));
    const btn = await p.$(`#app button[onclick*="tlJdModal('${jobId}')"]`);
    if (btn) { await btn.scrollIntoViewIfNeeded(); await btn.click(); } else await p.evaluate((id) => window.tlJdModal(id), jobId);
    await p.waitForSelector('#fcrModalHost.tl-jd-full .fcr-jd-body');
    /* where the page stood when the modal opened - it must not move until it closes */
    const before = await p.evaluate(() => scrollY);
    const m = await p.evaluate(() => {
      const r = document.querySelector('#fcrModalHost .fcr-modal').getBoundingClientRect();
      return { w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, sw: document.documentElement.scrollWidth,
        title: document.querySelector('#fcrModalHost .fcr-jd-head h3').textContent };
    });
    must(m.title.includes(TITLE), 'the wrong job: ' + m.title);
    must(Math.abs(m.w - m.vw) <= 2 && Math.abs(m.h - m.vh) <= 2, `not full window: ${m.w}x${m.h} of ${m.vw}x${m.vh}`);
    must(m.sw <= m.vw + 1, `sideways scroll: ${m.sw} > ${m.vw}`);
    const x = await xBox();
    must(x && x.top >= 0 && x.bottom <= x.vh && x.right <= x.vw && x.onTop, 'the ✕ is not visible: ' + JSON.stringify(x));
    p.__before = before;
  });

  await check(`${label}: scrolled to the middle and to the bottom, only the content moves and the ✕ stays put`, async () => {
    const start = await xBox();
    const sc = await p.evaluate(() => { const b = document.querySelector('#fcrModalHost .fcr-jd-body'); return { sh: b.scrollHeight, ch: b.clientHeight }; });
    must(sc.sh > sc.ch + 200, `the content does not scroll (scrollHeight ${sc.sh}, clientHeight ${sc.ch})`);
    for (const where of ['middle', 'bottom']) {
      await p.evaluate((w) => { const b = document.querySelector('#fcrModalHost .fcr-jd-body'); b.scrollTop = w === 'middle' ? (b.scrollHeight - b.clientHeight) / 2 : b.scrollHeight; }, where);
      await p.mouse.wheel(0, 400);
      await p.waitForTimeout(250);
      const x = await xBox();
      must(x && x.onTop && Math.abs(x.top - start.top) < 1, `${where}: the ✕ moved or is covered: ${JSON.stringify(x)}`);
    }
    const end = await p.evaluate(() => { const b = document.querySelector('#fcrModalHost .fcr-jd-body'); return b.scrollTop + b.clientHeight >= b.scrollHeight - 2; });
    must(end, 'did not reach the bottom of the content');
    must((await p.evaluate(() => scrollY)) === p.__before, 'the page behind the modal scrolled');
  });

  await check(`${label}: the ✕ closes it from the bottom; the page is where it was and scrolls again`, async () => {
    await p.click('#fcrModalHost .fcr-jd-x');
    await p.waitForTimeout(200);
    must(!(await p.$('#fcrModalHost')), 'the modal is still open');
    must((await p.evaluate(() => scrollY)) === p.__before, 'the page jumped');
    const ov = await p.evaluate(() => [document.body.style.overflow, document.documentElement.style.overflow]);
    must(!ov[0] && !ov[1], 'page scrolling not restored: ' + ov.join(','));
  });

  await check(`${label}: it opens again correctly, and Esc closes it`, async () => {
    await p.evaluate((id) => window.tlJdModal(id), jobId);
    await p.waitForSelector('#fcrModalHost.tl-jd-full .fcr-jd-body');
    must((await p.evaluate(() => document.querySelector('#fcrModalHost .fcr-jd-body').scrollTop)) === 0, 'reopened scrolled down');
    const x = await xBox();
    must(x && x.onTop, 'the ✕ is not visible on reopening');
    await p.screenshot({ path: `${process.env.TEMP || '/tmp'}/jd-modal-${label}.png` });
    await p.keyboard.press('Escape');
    await p.waitForTimeout(200);
    must(!(await p.$('#fcrModalHost')), 'Esc did not close it');
    const ov = await p.evaluate(() => document.body.style.overflow);
    must(!ov, 'page scrolling not restored after Esc');
  });
  await ctx.close();
}

await check('no page errors', async () => { must(!errors.length, errors.join(' | ')); });
await b.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
