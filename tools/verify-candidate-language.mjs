/**
 * The candidate's preferred language (0102), in a real browser.
 *
 *   1  the registration form offers English / తెలుగు / हिन्दी, and the choice
 *      travels with the registration (stored by the server)
 *   2  the Profile page has a "Preferred language" card; choosing Telugu
 *      saves to the server and survives a refresh; the Languages card
 *      (languages spoken) is untouched
 *   3  Home's "AI career suggestions" card is answered by the server
 *      (GET /api/career-assistant/suggestion), in Telugu, marked Basic mode;
 *      the browser's cpAnswer() no longer answers anything
 *   4  the card says "unavailable" when the server fails - no made-up answer
 *   5  the assistant: romanized Telugu in, romanized Telugu out; Hindi in,
 *      Hindi out - from the real open job
 *   6  phone width: no sideways scroll on the profile card
 *
 * Creates accounts and a job, so it refuses :4323. Run against an isolated instance:
 *   TL_URL=http://127.0.0.1:4421/ node tools/verify-candidate-language.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4421/').replace(/\/?$/, '/');
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}
const SHOTS = process.env.TL_SHOTS || join(tmpdir(), 'tl-verify-language');
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
const TELUGU = /[ఀ-౿]/;
const DEVANAGARI = /[ऀ-ॿ]/;

const browser = await chromium.launch();
const errors = [];
const ready = (page) => page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
async function open(ctx, hash) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE + hash);
  await ready(page);
  await page.waitForTimeout(500);
  return page;
}
const wizardAway = (page) => page.evaluate(() => {
  document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((b) => b.click());
});
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
const settle = (page) => page.waitForFunction(() => !TLCareerAssistant.state().sending, null, { timeout: 60000 });

/* one open job under the recruiter's own company */
let jobTitle = `Billing Assistant ${stamp}`;
{
  const rc = await browser.newContext();
  const rp = await open(rc, '#/');
  const out = await rp.evaluate(async ({ e, p, title }) => {
    try {
      await TL.api.post('/auth/login', { email: e, password: p, role: 'recruiter' });
      const boot = await TL.api.get('/bootstrap');
      const myCo = ((boot.data.recruiters || []).find((r) => boot.session && r.id === boot.session.id) || {}).companyId;
      const j = await TL.api.post('/jobs', { title, companyId: myCo, location: 'Nellore', mode: 'Onsite', exp: '0-2 yrs',
        pay: '₹3 LPA', salaryMin: 3, salaryMax: 3, type: 'Full-time', status: 'open',
        skills: ['Tally', 'GST', 'Communication'], description: 'Verification job - safe to delete.' });
      return j.job.id;
    } catch (err) { return 'ERR ' + err.message; }
  }, { e: RECRUITER, p: RECRUITER_PW, title: jobTitle });
  must(!String(out).startsWith('ERR'), 'could not publish the test job: ' + out);
  await rc.close();
}

console.log(`\npreferred language  (${BASE})`);

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await open(ctx, '#/register/candidate');
const cand = { email: `language.${stamp}@tl-verify.test`, password: `Lang${stamp}9` };
let candId;

await check('1. the registration form offers the three languages and the choice reaches the server', async () => {
  await page.waitForSelector('#regPrefLang', { timeout: 15000 });
  const opts = await page.$$eval('#regPrefLang option', (o) => o.map((x) => x.value + '=' + x.textContent));
  must(opts.length === 3 && /te=తెలుగు/.test(opts.join('|')) && /hi=हिन्दी/.test(opts.join('|')), 'options: ' + opts.join('|'));
  await page.selectOption('#regPrefLang', 'hi');
  await page.$eval('#regPrefLang', (el) => el.scrollIntoView({ block: 'center' }));
  await shot(page, '01-register');
  // The form's own request goes through TL.api.post; the module adds the choice to it.
  const reg = await page.evaluate((b) => TL.api.post('/auth/register', b).then((r) => 'ok:' + r.candidateId, (e) => e.message), {
    name: 'Lakshmi Verify', ...cand, phone: phone(), preferredLocation: 'Nellore', expectedCtc: 3,
    noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'],
  });
  must(String(reg).startsWith('ok:'), 'could not register: ' + reg);
  candId = reg.slice(3);
  const me = await page.evaluate((id) => TL.api.get('/candidates/' + id), candId);
  must(me.candidate.preferredLanguage === 'hi', 'stored: ' + me.candidate.preferredLanguage);
  await page.evaluate((id) => TL.api.put('/candidates/' + id, { title: 'Accounts Trainee', skills: ['MS Excel'],
    languages: ['Telugu', 'English'] }), candId);
});

await check('2. Profile: the Preferred language card saves Telugu to the server and keeps it after a refresh', async () => {
  await page.goto('about:blank'); await page.goto(BASE + '#/candidate/profile'); await ready(page);
  await page.waitForTimeout(1500); await wizardAway(page); await page.waitForTimeout(400); await wizardAway(page);
  await page.waitForSelector('#tllangCard', { timeout: 15000 });
  must(await page.$eval('#tllangCard .tllang-opt.on', (b) => b.getAttribute('data-lang')) === 'hi', 'Hindi not shown as chosen');
  await page.click('#tllangCard [data-lang="te"]');
  await page.waitForFunction(() => {
    const on = document.querySelector('#tllangCard .tllang-opt.on');
    return on && on.getAttribute('data-lang') === 'te' && !document.querySelector('#tllangCard [disabled]');
  }, null, { timeout: 10000 });
  await page.reload(); await ready(page); await page.waitForTimeout(1500); await wizardAway(page);
  await page.waitForSelector('#tllangCard');
  must(await page.$eval('#tllangCard .tllang-opt.on', (b) => b.getAttribute('data-lang')) === 'te', 'not kept after refresh');
  const me = await page.evaluate((id) => TL.api.get('/candidates/' + id), candId);
  must(me.candidate.preferredLanguage === 'te', 'server has ' + me.candidate.preferredLanguage);
  must(JSON.stringify(me.candidate.languages) === '["Telugu","English"]', 'spoken languages changed: ' + JSON.stringify(me.candidate.languages));
  await page.$eval('#tllangCard', (el) => el.scrollIntoView({ block: 'center' }));
  await shot(page, '02-profile-card');
});

await check('3. Home: the career suggestion comes from the server, in Telugu, marked Basic mode', async () => {
  const calls = [];
  page.on('request', (r) => { if (r.url().includes('/api/career-assistant/suggestion')) calls.push(r.url()); });
  await page.evaluate(() => { location.hash = '#/candidate/home'; });
  await page.waitForTimeout(500); await wizardAway(page);
  await page.waitForFunction(() => {
    const el = document.getElementById('tlcaSuggest');
    return el && /[ఀ-౿]/.test(el.innerText) && !/చూస్తున్నాం…/.test(el.innerText);
  }, null, { timeout: 20000 });
  must(calls.length >= 1, 'the card did not ask the server');
  const txt = await page.$eval('#tlcaSuggest', (el) => el.innerText);
  must(/స్కిల్స్/.test(txt), 'not the skills answer: ' + txt);
  must(/Basic mode/.test(txt), 'no Basic mode label');
  must(await page.evaluate(() => window.cpAnswer('what skills should I learn', {})) === '', 'cpAnswer still answers in the browser');
  await page.$eval('#tlcaSuggest', (el) => el.scrollIntoView({ block: 'center' }));
  await shot(page, '03-home-suggestion');
});

await check('4. Home: when the server fails the card says so and invents nothing', async () => {
  const p2 = await open(ctx, '#/candidate/profile');
  await p2.route('**/api/career-assistant/suggestion', (route) => route.fulfill({
    status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'ASSISTANT_UNAVAILABLE', message: 'Assistant is unavailable right now, please try again.' } }),
  }));
  await p2.evaluate(() => { location.hash = '#/candidate/home'; });
  await p2.waitForTimeout(500); await wizardAway(p2);
  await p2.waitForFunction(() => {
    const el = document.getElementById('tlcaSuggest');
    return el && /అందుబాటులో లేవు/.test(el.innerText);
  }, null, { timeout: 15000 });
  const txt = await p2.$eval('#tlcaSuggest', (el) => el.innerText);
  must(!/match|%/.test(txt), 'something was invented: ' + txt);
  await p2.close();
});

await check('5. the assistant answers romanized Telugu in romanized Telugu, Hindi in Hindi, from the real job', async () => {
  await page.goto('about:blank'); await page.goto(BASE + '#/candidate/assistant'); await ready(page);
  await page.waitForTimeout(1500); await wizardAway(page); await page.waitForTimeout(600); await wizardAway(page);
  await shot(page, '05a-assistant-open');
  await page.fill('#assistantInput', 'naaku job kavali');
  await page.press('#assistantInput', 'Enter');   // the floating chat button can sit over Send at this size
  await settle(page);
  let last = await page.$$eval('#assistantChatBox .chat-msg', (x) => x[x.length - 1].innerText);
  must(/saripoye jobs/.test(last) && !TELUGU.test(last), 'romanized reply: ' + last);
  must(last.includes(jobTitle), 'the real job is not in the answer: ' + last);
  await page.fill('#assistantInput', 'मुझे नौकरी चाहिए');
  await page.press('#assistantInput', 'Enter');   // the floating chat button can sit over Send at this size
  await settle(page);
  last = await page.$$eval('#assistantChatBox .chat-msg', (x) => x[x.length - 1].innerText);
  must(DEVANAGARI.test(last) && /मैच/.test(last), 'Hindi reply: ' + last);
  await shot(page, '05-assistant-languages');
});

await check('6. phone width: the profile card fits, no sideways scroll', async () => {
  const mc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await open(mc, '#/');
  await mp.evaluate((b) => TL.api.post('/auth/login', b), { email: cand.email, password: cand.password, role: 'candidate' });
  await mp.goto('about:blank'); await mp.goto(BASE + '#/candidate/profile'); await ready(mp); await mp.waitForTimeout(1500); await wizardAway(mp);
  await mp.waitForSelector('#tllangCard');
  const wide = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  must(wide <= 1, `${wide}px wider than the screen`);
  await mp.$eval('#tllangCard', (el) => el.scrollIntoView({ block: 'center' }));
  await shot(mp, '06-profile-mobile');
  await mc.close();
});

await check('no script errors', async () => { must(!errors.length, errors.slice(0, 3).join(' | ')); });

await browser.close();
console.log(`\nscreenshots: ${SHOTS}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
