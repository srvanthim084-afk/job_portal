/**
 * Job portal upgrades in a real browser, on a phone-sized screen.
 *
 *   1  signed out: the chip row, "Log in to see your match", the link preview
 *   2  candidate Search Jobs: tap "Fresher" -> the results change, ?qf= in the URL
 *   3  the card carries the server's match line ("82% match · ✓ … · ✗ …")
 *   4  Share -> WhatsApp opens wa.me with the job and no client name
 *   5  one tap applies -> "Applied ✓" toast -> Undo withdraws it -> apply again
 *   6  urgent + "3 days left" badges on the card
 *   7  an incomplete profile gets "Fill 2 things to apply", and saving applies
 *   8  the urgent alert is in the candidate's bell, with its match
 *   9  the job page: full breakdown; the recruiter sees "Shared N times · M applies"
 *  10  a job past its last date: "Applications closed", and the server refuses
 *  11  the admin's chip editor; the recruiter's posting form has the two fields
 *
 * Creates accounts and jobs, so it refuses :4323. Run against an isolated
 * instance started as in the project notes, with PUBLIC_ORIGIN set to it:
 *   TL_URL=http://127.0.0.1:4423/ node tools/verify-portal-upgrades.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4423/').replace(/\/?$/, '/');
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
const CLIENT = `Apollo Verify Clinics ${stamp}`;
const PW = process.env.TL_PASSWORD || 'TeamLink@2026';
const phoneNo = () => '9' + String(Math.floor(1e8 + Math.random() * 9e8));
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const browser = await chromium.launch();
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` }); };

async function open(ctx, hash) {
  const page = await ctx.newPage();
  await page.goto(BASE + (hash || '#/'));
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  return page;
}
const away = (p) => p.evaluate(() => {
  document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((b) => b.click());
});
const go = async (p, hash) => { await p.evaluate((x) => { location.hash = x; }, hash); await p.waitForTimeout(900); await away(p); };
const asCand = (p, email, pw) => p.evaluate(async ({ email, pw }) => {
  await TL.api.post('/auth/login', { email, password: pw, role: 'candidate' });
  await TL.refresh();
}, { email, pw });

/* ---- setup: a client company, three jobs, two candidates ---- */
const setup = await (async () => {
  const ctx = await browser.newContext();
  const p = await open(ctx);
  const out = await p.evaluate(async ({ s, client, pw }) => {
    try {
      await TL.api.post('/auth/login', { email: 'admin@teamlink.com', password: pw, role: 'admin' });
      const co = await TL.api.post('/companies', { id: 'apv_' + s, name: client });
      await TL.api.post('/auth/logout', {}).catch(() => {});
      await TL.api.post('/auth/login', { email: 'recruiter@teamlink.com', password: pw, role: 'recruiter' });
      const mk = (title, exp, skills) => TL.api.post('/jobs', {
        title: `${title} ${s}`, companyId: co.company ? co.company.id : 'apv_' + s, location: 'Hyderabad', mode: 'Onsite',
        exp, pay: '₹3-5 LPA', salaryMin: 3, salaryMax: 5, type: 'Full-time', status: 'open', skills,
      }).then((r) => r.job);
      const fresher = await mk('Junior Java Developer', 'Fresher', ['Java', 'Spring', 'AWS', 'SQL']);
      const senior = await mk('Java Developer', '2-4 yrs', ['Java', 'Spring', 'AWS', 'SQL']);
      const closing = await mk('Java Support Engineer', '2-4 yrs', ['Java', 'Spring', 'AWS', 'SQL']);
      return { fresher, senior, closing };
    } catch (e) { return String(e.message); }
  }, { s: stamp, client: CLIENT, pw: PW });
  await ctx.close();
  return out;
})();
if (typeof setup === 'string') { console.error('setup failed: ' + setup); process.exit(1); }
const { fresher, senior, closing } = setup;

async function makeCandidate(name, full) {
  const ctx = await browser.newContext();
  const p = await open(ctx);
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${stamp}@tl-sink.local`;
  const pw = `Portal${stamp}9`;
  const r = await p.evaluate(async ({ name, email, pw, phone, full }) => {
    try {
      const reg = await TL.api.post('/auth/register', {
        name, email, password: pw, phone, preferredLocation: 'Hyderabad', expectedCtc: 4,
        noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'],
      });
      if (full) {
        await TL.api.put('/candidates/' + reg.candidateId, {
          location: 'Hyderabad', exp: '3 yrs', expYears: 3, skills: ['Java', 'Spring', 'AWS'],
        });
        const f = new File(['Java developer with Spring and AWS. Built REST services.'], 'cv.txt', { type: 'text/plain' });
        await TL.uploadResume(f, reg.candidateId);
      } else {
        await TL.api.put('/candidates/' + reg.candidateId, { location: 'Hyderabad', exp: '3 yrs', expYears: 3 });
      }
      return reg.candidateId;
    } catch (e) { return 'ERR ' + e.message; }
  }, { name, email, pw, phone: phoneNo(), full });
  await ctx.close();
  if (String(r).startsWith('ERR')) throw new Error(r);
  return { id: r, email, pw };
}
const ready = await makeCandidate('Ready Candidate', true);
const partial = await makeCandidate('Partial Candidate', false);

/* urgent + last date in 3 days on the senior job; a past date on `closing` */
{
  const ctx = await browser.newContext();
  const p = await open(ctx);
  const r = await p.evaluate(async ({ pw, senior, closing }) => {
    const d = (n) => new Date(Date.now() + 330 * 60000 + n * 86400000).toISOString().slice(0, 10);
    await TL.api.post('/auth/login', { email: 'recruiter@teamlink.com', password: pw, role: 'recruiter' });
    const a = await TL.api.put('/jobs/' + senior.id + '/deadline', { lastDate: d(3), urgent: true })
      .catch((e) => { throw new Error((e.code || '') + ' ' + e.message + ' ' + JSON.stringify(e.details || {})); });
    const b = await TL.api.put('/jobs/' + closing.id + '/deadline', { lastDate: d(1) });
    return [a.job.urgent, b.job.expiresAt];
  }, { pw: PW, senior, closing }).catch((e) => { throw new Error('deadline setup: ' + e.message); });
  must(r[0] === true, 'urgent did not stick');
  await ctx.close();
}

console.log(`\njob portal upgrades  (${BASE}, phone 390x844)`);

/* ---------------- 1. signed out ---------------- */
await check('1. signed out: chips above the jobs, and "Log in to see your match" on the cards', async () => {
  const ctx = await browser.newContext(PHONE);
  const p = await open(ctx, '#/');
  await p.waitForTimeout(1200);
  const chips = await p.$$eval('.tlpu-chips .tlpu-chip', (b) => b.map((x) => x.textContent.trim()));
  must(chips.length === 8 && chips[0] === 'Fresher' && chips.includes('Urgent hiring'), 'chips: ' + chips.join(','));
  const login = await p.$$eval('.tlpu-why a', (a) => a.map((x) => x.textContent));
  must(login.some((t) => /Log in to see your match/.test(t)), 'no login hint on the cards');
  await shot(p, '01-signed-out-home');
  await ctx.close();
});

await check('1b. the shared link serves Open Graph tags without the client name, and opens the job', async () => {
  const res = await fetch(`${BASE}job/${senior.id}`, { headers: { 'user-agent': 'WhatsApp/2.24' } });
  const html = await res.text();
  must(res.status === 200, 'status ' + res.status);
  must(html.includes(`og:title" content="${senior.title} - Hyderabad"`), 'no og:title');
  must(!html.slice(0, 5000).includes(CLIENT), 'the client name is in the preview');
  const ctx = await browser.newContext(PHONE);
  const p = await ctx.newPage();
  await p.goto(`${BASE}job/${senior.id}`);
  await p.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await p.waitForTimeout(1200);
  must((await p.evaluate(() => location.hash)) === `#/job/${senior.id}`, 'not on the job route: ' + await p.evaluate(() => location.href));
  must(await p.evaluate(() => document.querySelector('#app').innerText.includes('Log in to see your match')), 'no login hint on the job page');
  await shot(p, '01b-shared-link-job-page');
  await ctx.close();
});

/* ---------------- 2-8. the ready candidate ---------------- */
const cctx = await browser.newContext(PHONE);
/* WhatsApp and LinkedIn are never actually reached: the share window
   lands on a local stub, and the URL it was sent to is what is checked. */
await cctx.route(/^https:\/\/(wa\.me|api\.whatsapp\.com|www\.linkedin\.com)\//, (route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' }));
const cp = await open(cctx, '#/');
await asCand(cp, ready.email, ready.pw);
await go(cp, '#/candidate/search');
await cp.waitForTimeout(1500);

const cardFor = (id) => `#app .rj-card[data-tlpu="${id}"]`;

await check('2. tapping "Fresher" changes the results, and the URL carries it', async () => {
  const before = await cp.$$eval('#app .rj-card', (c) => c.length);
  must(before >= 2, 'expected at least two jobs, saw ' + before);
  await cp.click('.tlpu-chip[data-k="fresher"]');
  await cp.waitForTimeout(1200);
  const after = await cp.$$eval('#app .rj-card', (c) => c.map((x) => x.getAttribute('data-tlpu') || ''));
  must(after.length < before, `still ${after.length} of ${before}`);
  must(after.includes(fresher.id), 'the fresher job is gone');
  must(!after.includes(senior.id) && !after.includes(closing.id), 'a non-fresher job survived: ' + after.join(','));
  must(/qf=fresher/.test(await cp.evaluate(() => location.hash)), 'URL: ' + await cp.evaluate(() => location.hash));
  must(await cp.$eval('.tlpu-chip[data-k="fresher"]', (b) => b.classList.contains('on')), 'chip not on');
  await shot(cp, '02-fresher-chip');
  await cp.click('.tlpu-chip[data-k="fresher"]');
  await cp.waitForTimeout(1000);
  must((await cp.$$eval('#app .rj-card', (c) => c.length)) === before, 'turning it off did not restore the list');
});

await check('3. the card shows the server match line', async () => {
  await cp.waitForSelector(`${cardFor(senior.id)} .tlpu-why`, { timeout: 8000 });
  const line = await cp.$eval(`${cardFor(senior.id)} .tlpu-why`, (e) => e.textContent);
  must(/✓ Java, Spring, AWS/.test(line) && /✓ 3 yrs/.test(line) && /✗ SQL/.test(line), 'line: ' + line);
  const server = await cp.evaluate((id) => TL.api.get('/job-matches/explain?jobIds=' + id).then((r) => r.matches[0].score), senior.id);
  const shown = await cp.$eval(`${cardFor(senior.id)} .rj-score b`, (e) => e.textContent.trim()).catch(() => '');
  must(shown === server + '%', `card says ${shown}, server says ${server}%`);
  await shot(cp, '03-match-line');
});

await check('6. urgent and "3 days left" badges on the card', async () => {
  const b = await cp.$eval(`${cardFor(senior.id)} .tlpu-badges`, (e) => e.textContent);
  must(/Urgent hiring/.test(b) && /3 days left/.test(b), 'badges: ' + b);
});

await check('4. Share -> WhatsApp opens wa.me with the job and no client name', async () => {
  await cp.click(`${cardFor(senior.id)} .tlpu-share`);
  await cp.waitForSelector('.tlpu-sheet [data-ch="whatsapp"]', { timeout: 5000 });
  await shot(cp, '04-share-sheet');
  const [popup] = await Promise.all([
    cctx.waitForEvent('page', { timeout: 8000 }),
    cp.click('.tlpu-sheet [data-ch="whatsapp"]'),
  ]);
  await popup.waitForURL(/wa\.me|whatsapp/, { timeout: 8000 }).catch(() => {});
  const wa = decodeURIComponent(popup.url().replace(/\+/g, ' '));
  must(/wa\.me\/\?text=/.test(popup.url()) || /whatsapp/.test(popup.url()), 'opened ' + popup.url());
  must(wa.includes(senior.title) && wa.includes('Apply on TeamLink') && wa.includes(`/job/${senior.id}?ref=`), 'text: ' + wa);
  must(!wa.includes(CLIENT) && !/apollo/i.test(wa), 'the client name is in the share');
  await popup.close();
  await cp.evaluate(() => window.tlpuCloseSheet());
});

const apps = (id) => cp.evaluate((j) => TL.api.get('/applications').then((r) => r.applications.filter((a) => a.jobId === j).length), id);

await check('5. one tap applies, "Applied ✓" with Undo, Undo withdraws, apply again', async () => {
  await cp.click(`${cardFor(senior.id)} .rj-btn.pri`, { trial: true, timeout: 4000 }).catch(async (e) => {
    await shot(cp, '05-blocked');
    throw new Error('the Apply button cannot be tapped: ' + String(e.message).split(String.fromCharCode(10)).slice(0, 6).join(' | '));
  });
  await cp.click(`${cardFor(senior.id)} .rj-btn.pri`);
  await cp.waitForSelector('.tlpu-toast', { timeout: 8000 });
  const t = await cp.$eval('.tlpu-toast', (e) => e.textContent);
  must(/Applied ✓/.test(t) && /Undo/.test(t), 'toast: ' + t);
  must(await apps(senior.id) === 1, 'not applied');
  must(/#\/candidate\/search/.test(await cp.evaluate(() => location.hash)), 'one tap left the page');
  await shot(cp, '05-applied-toast');
  await cp.click('.tlpu-toast .toast-action');
  await cp.waitForTimeout(1500);
  must(await apps(senior.id) === 0, 'Undo did not withdraw it');
  await shot(cp, '05b-after-undo');
  const btn = await cp.$eval(`${cardFor(senior.id)} .rj-foot`, (e) => e.innerText).catch((e) => 'no card: ' + e.message);
  must(await cp.$(`${cardFor(senior.id)} .rj-btn.pri`), 'after Undo the card shows: ' + btn + ' / hasApplication=' + await cp.evaluate((id) => DATA.hasApplication(STATE.session.id, id), senior.id));
  await cp.click(`${cardFor(senior.id)} .rj-btn.pri`);
  await cp.waitForSelector('.tlpu-toast', { timeout: 8000 });
  await cp.waitForTimeout(800);
  must(await apps(senior.id) === 1, 'applying again failed');
  const same = await cp.evaluate((id) => TL.api.post('/applications/one-click', { jobId: id }).then((r) => r.existing === true), senior.id);
  must(same, 'a second one-click apply was not idempotent');
  must(await apps(senior.id) === 1, 'duplicate application');
});

await check('5b. the home page Easy Apply keeps its review step, and Submit applies', async () => {
  const seen = await cp.evaluate((id) => {
    window.cpEasyApply(id);
    const t = document.body.innerText;
    return { review: t.includes('Resume on file'), submit: [...document.querySelectorAll('button')].some((b) => /submit application/i.test(b.textContent)) };
  }, fresher.id);
  must(seen.review && seen.submit, 'no review step: ' + JSON.stringify(seen));
  await cp.evaluate(() => [...document.querySelectorAll('button')].find((b) => /submit application/i.test(b.textContent)).click());
  await cp.waitForTimeout(2500);
  must(await apps(fresher.id) === 1, 'Submit did not apply');
});

await check('8. the urgent-hiring alert is in the bell with the match', async () => {
  await cp.evaluate(() => TL.refreshNotifications());
  await go(cp, '#/candidate/home');
  await cp.waitForTimeout(800);
  const html = await cp.evaluate(() => (typeof candidateBellHtml === 'function' ? candidateBellHtml() : ''));
  must(/Urgent hiring/.test(html) && /% match/.test(html) && /Apply now/.test(html), 'bell: ' + html.replace(/<[^>]+>/g, ' ').slice(0, 300));
  must(!/\bclient\b/i.test(html.replace(/<[^>]+>/g, ' ')), 'the word client in the bell');
});

await check('9. the job page shows the full breakdown and Improve your match', async () => {
  await go(cp, '#/job/' + fresher.id);
  await cp.waitForSelector('.tlpu-jp .tlpu-kv', { timeout: 8000 });
  const t = await cp.$eval('.tlpu-jp', (e) => e.innerText);
  must(/Your match · \d+%/.test(t) && /Skills/.test(t) && /Experience/.test(t) && /Location/.test(t) && /Salary/.test(t), 'panel: ' + t);
  must(/\+ SQL/.test(t), 'no Improve your match');
  await shot(cp, '09-job-page-breakdown');
});

await check('10. past its last date: "Applications closed" on the page, and the server refuses', async () => {
  const r = await cp.evaluate((id) => TL.api.post('/applications/one-click', { jobId: id }).then(() => 'applied', (e) => e.message), closing.id);
  must(r === 'applied', 'should still be open today: ' + r);
  /* the deadline passes while the page is open */
  await go(cp, '#/job/' + senior.id);
  await cp.evaluate((id) => { const j = DATA.jobById(id); j.expiresAt = new Date(Date.now() - 60000).toISOString(); render(); }, senior.id);
  await cp.waitForTimeout(600);
  const t = await cp.$eval('#app', (e) => e.innerText);
  must(/Applications closed/.test(t), 'no Applications closed');
  const live = await cp.$$eval('#app button', (b) => b.filter((x) => /Apply Now/.test(x.textContent) && !x.disabled).length);
  must(live === 0, 'an Apply button is still live');
  await shot(cp, '10-applications-closed');
});
await cctx.close();

/* ---------------- 7. the incomplete profile ---------------- */
await check('7. an incomplete profile gets "Fill 2 things to apply", and saving applies', async () => {
  const ctx = await browser.newContext(PHONE);
  const p = await open(ctx, '#/');
  await asCand(p, partial.email, partial.pw);
  await go(p, '#/job/' + fresher.id);
  await p.waitForTimeout(800);
  const clicked = await p.evaluate(() => {
    const b = Array.from(document.querySelectorAll('#app button')).find((x) => /Apply Now|Easy Apply/.test(x.textContent) && !x.disabled);
    if (!b) return false; b.click(); return true;
  });
  must(clicked, 'no Apply button');
  await p.waitForSelector('.tlpu-sheet h3', { timeout: 6000 });
  const h = await p.$eval('.tlpu-sheet h3', (e) => e.textContent);
  must(h === 'Fill 2 things to apply', 'sheet: ' + h);
  await shot(p, '07-missing-fields-sheet');
  await p.fill('#tlpuF_skills', 'Java, Spring');
  await p.setInputFiles('#tlpuF_resume', { name: 'resume.txt', mimeType: 'text/plain', buffer: Buffer.from('Java developer, Spring, two years of REST services.') });
  await p.click('#tlpuSaveApply');
  await p.waitForSelector('.tlpu-toast', { timeout: 15000 });
  const n = await p.evaluate((id) => TL.api.get('/applications').then((r) => r.applications.filter((a) => a.jobId === id).length), fresher.id);
  must(n === 1, 'not applied after filling the sheet');
  await ctx.close();
});

/* ---------------- recruiter + admin ---------------- */
await check('9b. the recruiter sees "Shared N times · M applies"; the posting form has the two fields', async () => {
  const ctx = await browser.newContext(PHONE);
  const p = await open(ctx, '#/');
  await p.evaluate(async (pw) => {
    await TL.api.post('/auth/login', { email: 'recruiter@teamlink.com', password: pw, role: 'recruiter' });
    await TL.refresh();
  }, PW);
  await go(p, '#/job/' + senior.id);
  await p.waitForSelector('.tlpu-stats', { timeout: 8000 });
  await p.waitForFunction(() => /Shared \d+ times? · \d+ appl/.test((document.querySelector('.tlpu-stats') || {}).textContent || ''), null, { timeout: 8000 });
  const s = await p.$eval('.tlpu-stats', (e) => e.textContent);
  must(/Shared [1-9]\d* times? · \d+ appl/.test(s), 'stats: ' + s);
  await shot(p, '09b-recruiter-share-stats');
  await go(p, '#/recruiter/jobs');
  await p.waitForTimeout(1200);
  const hasForm = await p.evaluate(() => !!document.getElementById('njStatus'));
  if (hasForm) {
    await p.waitForSelector('#tlpuDeadline #tlpuLastDate', { timeout: 5000 });
    must(await p.$('#tlpuDeadline #tlpuUrgent'), 'no Urgent hiring toggle');
    await p.evaluate(() => document.getElementById('tlpuDeadline').scrollIntoView());
    await shot(p, '11-posting-form-fields');
  }
  await ctx.close();
});

await check('11. the admin can reorder and hide chips', async () => {
  const ctx = await browser.newContext(PHONE);
  const p = await open(ctx, '#/');
  await p.evaluate(async (pw) => {
    await TL.api.post('/auth/login', { email: 'admin@teamlink.com', password: pw, role: 'admin' });
    await TL.refresh();
  }, PW);
  await go(p, '#/admin/quick-filters');
  await p.waitForSelector('.tlpu-qf-admin .rowx', { timeout: 8000 });
  must((await p.$$('.tlpu-qf-admin .rowx')).length === 8, 'not eight rows');
  await shot(p, '11b-admin-chips');
  await ctx.close();
});

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
