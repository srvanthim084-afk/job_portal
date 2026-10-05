/**
 * The AI Career Assistant, in a real browser.
 *
 *   1  the page loads with the greeting and, without an AI key, a "Basic mode" label
 *   2  a chip sends its text: the user bubble shows at once, a typing bubble, then the reply
 *   3  replies render bold and links to #/job/<id> - and nothing else becomes markup
 *   4  what the candidate types is shown as text, never as HTML
 *   5  a refresh keeps the conversation (it is stored by the server)
 *   6  the floating "TeamLink AI" chat shows the same conversation and answers there too
 *   7  when the server fails, the page says the assistant is unavailable - no made-up answer
 *   8  the hourly limit's message is shown as the server wrote it
 *   9  TLCareerAssistant.openWith({ interviewId }) opens the page and asks about the interview
 *  10  Clear chat empties it, and a refresh shows it empty
 *  11  phone width: no sideways scroll
 *  12  Home's "AI career suggestions" card comes from the server (same engine), not cpAnswer()
 *  13  Basic mode answers romanized Telugu in romanized Telugu (0102)
 *
 * Creates an account and a job, so it refuses :4323. Run against an isolated instance:
 *   TL_URL=http://127.0.0.1:4425/ node tools/verify-career-assistant.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4425/').replace(/\/?$/, '/');
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}
const SHOTS = process.env.TL_SHOTS || join(tmpdir(), 'tl-verify-assistant');
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
const bubbles = (page) => page.$$eval('#assistantChatBox .chat-msg', (xs) => xs.map((x) => ({
  cls: x.className, text: x.innerText.trim(), html: x.querySelector('.bubble').innerHTML,
})));
const settle = (page) => page.waitForFunction(() => !TLCareerAssistant.state().sending, null, { timeout: 60000 });

/* one open job, so "What jobs match me?" has something real to answer with */
{
  const rc = await browser.newContext();
  const rp = await open(rc, '#/');
  const out = await rp.evaluate(async ({ e, p, s }) => {
    try {
      await TL.api.post('/auth/login', { email: e, password: p, role: 'recruiter' });
      const boot = await TL.api.get('/bootstrap');
      const myCo = ((boot.data.recruiters || []).find((r) => boot.session && r.id === boot.session.id) || {}).companyId; const co = (boot.data.companies || []).find((x) => x.id === myCo) || (boot.data.companies || [])[0];
      const j = await TL.api.post('/jobs', { title: `Support Associate ${s}`, companyId: co.id, location: 'Nellore',
        mode: 'Onsite', exp: '0-2 yrs', pay: '₹3 LPA', salaryMin: 3, salaryMax: 3, type: 'Full-time',
        status: 'open', skills: ['Communication', 'Telugu'], description: 'Verification job - safe to delete.' });
      return j.job.id;
    } catch (err) { return 'ERR ' + err.message; }
  }, { e: RECRUITER, p: RECRUITER_PW, s: stamp });
  must(!String(out).startsWith('ERR'), 'could not publish the test job: ' + out);
  await rc.close();
}

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await open(ctx, '#/');
const cand = { email: `assistant.${stamp}@tl-verify.test`, password: `Asst${stamp}9` };
const reg = await page.evaluate((b) => TL.api.post('/auth/register', b).then((r) => 'ok:' + r.candidateId, (e) => e.message), {
  name: 'Assistant Verify', ...cand, phone: phone(),
  preferredLocation: 'Nellore', expectedCtc: 3, noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'],
});
must(String(reg).startsWith('ok:'), 'could not register: ' + reg);
const upd = await page.evaluate((id) => TL.api.put('/candidates/' + id, {
  title: 'Support Associate', skills: ['Communication', 'Telugu'] }).then(() => 'ok', (e) => e.message), reg.slice(3));
must(upd === 'ok', 'could not update the profile: ' + upd);
await page.goto('about:blank'); await page.goto(BASE + '#/candidate/assistant'); await ready(page);
await page.waitForTimeout(1500); await wizardAway(page); await page.waitForTimeout(600); await wizardAway(page);

console.log(`\nAI career assistant  (${BASE})`);

await check('1. the page loads with the greeting and the "Basic mode" label (no AI key here)', async () => {
  await page.waitForSelector('#assistantChatBox .chat-msg');
  const b = await bubbles(page);
  must(b.length === 1 && /Career Assistant/.test(b[0].text), 'greeting: ' + JSON.stringify(b));
  const label = await page.$('.tlca-panel .tlca-basic');
  must(label && /Basic mode/.test(await label.innerText()), 'no Basic mode label');
  await shot(page, '01-assistant-empty');
});

await check('2. a chip sends its text: user bubble at once, typing bubble, then the reply', async () => {
  // slow the answer down a little so the in-between state can be seen
  await page.route('**/api/career-assistant/messages', async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
  await page.click('.chat-chip-row button:has-text("What jobs match me?")');
  await page.waitForTimeout(250);
  const mid = await bubbles(page);
  must(mid.some((x) => /user/.test(x.cls) && x.text === 'What jobs match me?'), 'no user bubble straight away');
  must(await page.$('#assistantChatBox .tlca-typing'), 'no typing bubble');
  await settle(page);
  await page.unroute('**/api/career-assistant/messages');
  const b = await bubbles(page);
  const last = b[b.length - 1];
  must(/assistant/.test(last.cls) && /match/.test(last.text), 'reply: ' + last.text);
  must(!(await page.$('#assistantChatBox .tlca-typing')), 'typing bubble stayed');
});

await check('3. replies render bold and links to #/job/<id>, nothing else', async () => {
  const b = await bubbles(page);
  const last = b[b.length - 1];
  must(/<a class="tlca-a" href="#\/job\/[A-Za-z0-9_-]+">/.test(last.html), 'no job link: ' + last.html.slice(0, 200));
  must(/<b>\d+% match<\/b>/.test(last.html), 'no bold');
  must(!last.text.includes('**') && !last.text.includes(']('), 'raw markdown left in: ' + last.text);
  // and the renderer itself: everything else stays text
  const out = await page.evaluate(() => TLCareerAssistant._md('**hi** [x](javascript:alert(1)) [y](#/job/j1) <img src=x onerror=alert(1)> [z](https://evil.example)'));
  must(out.includes('<b>hi</b>') && out.includes('href="#/job/j1"'), 'allowed markup missing: ' + out);
  must(!/<img|href="javascript|href="https/.test(out), 'unsafe markup got through: ' + out);
  await shot(page, '03-assistant-reply');
});

await check('4. what the candidate types is shown as text, never as HTML', async () => {
  await page.fill('#assistantInput', '<img src=x onerror="window.__pwned=1"> improve my profile');
  await page.click('.chat-input-row button[type=submit]');
  await settle(page);
  must(!(await page.$('#assistantChatBox img')), 'an <img> was rendered');
  must(!(await page.evaluate(() => window.__pwned)), 'script ran');
  const b = await bubbles(page);
  must(b.some((x) => x.text.startsWith('<img src=x')), 'the text was not shown as typed');
});

await check('5. a refresh keeps the conversation', async () => {
  const before = (await bubbles(page)).length;
  await page.reload(); await ready(page); await page.waitForTimeout(2000); await wizardAway(page);
  await page.waitForSelector('#assistantChatBox .chat-msg.user');
  const after = await bubbles(page);
  must(after.length === before, `${before} bubbles before, ${after.length} after`);
  must(after[0].text === 'What jobs match me?', 'first message: ' + after[0].text);
});

await check('6. the floating chat shows the same conversation and answers there too', async () => {
  await page.evaluate(() => { location.hash = '#/candidate/home'; });
  await page.waitForTimeout(1500); await wizardAway(page);
  await page.click('.cp-fab');
  await page.waitForTimeout(800);
  const n = await page.$$eval('#cpChatBody .cp-msg', (x) => x.length);
  must(n >= 4, 'the floating chat does not show the history: ' + n);
  await page.fill('#cpChatIn', 'Salary fit');
  await page.press('#cpChatIn', 'Enter');
  await settle(page);
  await page.waitForTimeout(300);
  const last = await page.$$eval('#cpChatBody .cp-msg', (x) => x[x.length - 1].innerText);
  must(/salary|LPA/i.test(last), 'no salary answer: ' + last);
  await shot(page, '06-assistant-fab');
  await page.click('.cp-chat .cp-ico');
});

await check('7. a server failure says "unavailable" and invents nothing', async () => {
  await page.evaluate(() => { location.hash = '#/candidate/assistant'; });
  await page.waitForTimeout(1200);
  await page.route('**/api/career-assistant/messages', (route) => route.fulfill({
    status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'ASSISTANT_UNAVAILABLE', message: 'Assistant is unavailable right now, please try again.' } }),
  }));
  const before = (await bubbles(page)).length;
  await page.fill('#assistantInput', 'Should I apply?');
  await page.click('.chat-input-row button[type=submit]');
  await settle(page);
  const b = await bubbles(page);
  const last = b[b.length - 1];
  must(b.length === before + 2, 'expected the question and one error line');
  must(/tlca-err/.test(last.cls) && /Assistant is unavailable right now, please try again/.test(last.text), 'error: ' + last.text);
  await shot(page, '07-assistant-unavailable');
  await page.unroute('**/api/career-assistant/messages');
});

await check('8. the hourly limit is explained in the server\'s words', async () => {
  await page.route('**/api/career-assistant/messages', (route) => route.fulfill({
    status: 429, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'ASSISTANT_RATE_LIMITED', message: 'You have sent 30 messages to the assistant in the last hour. Please try again in about 12 minutes.' } }),
  }));
  await page.fill('#assistantInput', 'one more');
  await page.click('.chat-input-row button[type=submit]');
  await settle(page);
  const b = await bubbles(page);
  must(/30 messages .* about 12 minutes/.test(b[b.length - 1].text), b[b.length - 1].text);
  await page.unroute('**/api/career-assistant/messages');
});

await check('9. openWith({ interviewId }) opens the page and asks about the interview', async () => {
  await page.evaluate(() => { location.hash = '#/candidate/home'; });
  await page.waitForTimeout(1000);
  const sent = [];
  await page.route('**/api/career-assistant/messages', async (route) => {
    sent.push(JSON.parse(route.request().postData() || '{}'));
    await route.continue();
  });
  await page.evaluate(() => TLCareerAssistant.openWith({ interviewId: 'iv_does_not_exist' }));
  await settle(page);
  await page.unroute('**/api/career-assistant/messages');
  must((await page.evaluate(() => location.hash)).startsWith('#/candidate/assistant'), 'not on the assistant');
  must(sent.length === 1 && sent[0].context && sent[0].context.interviewId === 'iv_does_not_exist', 'context: ' + JSON.stringify(sent));
  const b = await bubbles(page);
  must(/interview/i.test(b[b.length - 1].text), 'reply: ' + b[b.length - 1].text);
});

await check('10. Clear chat empties it, and a refresh shows it empty', async () => {
  await page.click('.tlca-panel button:has-text("Clear chat")');
  await page.waitForTimeout(1200);
  let b = await bubbles(page);
  must(b.length === 1 && /Career Assistant/.test(b[0].text), 'not cleared: ' + b.length);
  await page.reload(); await ready(page); await page.waitForTimeout(2000); await wizardAway(page);
  b = await bubbles(page);
  must(b.length === 1, 'came back after a refresh: ' + b.length);
});

await check('11. phone width: no sideways scroll', async () => {
  const mc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await open(mc, '#/');
  await mp.evaluate((b) => TL.api.post('/auth/login', b), { email: cand.email, password: cand.password, role: 'candidate' });
  await mp.goto('about:blank'); await mp.goto(BASE + '#/candidate/assistant'); await ready(mp); await mp.waitForTimeout(1500); await wizardAway(mp);
  await mp.click('.chat-chip-row button:has-text("Interview prep")');
  await settle(mp);
  const wide = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  must(wide <= 1, `${wide}px wider than the screen`);
  await shot(mp, '11-assistant-mobile');
  await mc.close();
});

await check('12. Home: the "AI career suggestions" card is answered by the server, not by cpAnswer()', async () => {
  const calls = [];
  const onReq = (r) => { if (r.url().includes('/api/career-assistant/suggestion')) calls.push(r.url()); };
  const msgsBefore = await page.evaluate(() => TL.api.get('/career-assistant/conversations')
    .then((c) => (c.conversations || []).reduce((n, x) => n + x.messages, 0)));
  page.on('request', onReq);
  await page.evaluate(() => { location.hash = '#/candidate/home'; });
  await page.waitForTimeout(500); await wizardAway(page);
  await page.waitForFunction(() => {
    const el = document.getElementById('tlcaSuggest');
    return el && /skills|profile/i.test(el.innerText) && !/Looking at your profile/.test(el.innerText);
  }, null, { timeout: 20000 });
  page.off('request', onReq);
  must(calls.length >= 1, 'the card did not ask the server');
  const txt = await page.$eval('#tlcaSuggest', (el) => el.innerText);
  must(/Basic mode/.test(txt), 'no Basic mode label: ' + txt);
  must(await page.evaluate(() => window.cpAnswer('what skills should I learn', {})) === '', 'cpAnswer still answers');
  const conv = await page.evaluate(() => TL.api.get('/career-assistant/conversations'));
  const total = (conv.conversations || []).reduce((n, c) => n + c.messages, 0);
  must(total === msgsBefore, `the suggestion wrote into the chat (${msgsBefore} messages before, ${total} after)`);
  await page.$eval('#tlcaSuggest', (el) => el.scrollIntoView({ block: 'center' }));
  await shot(page, '12-home-suggestion');
});

await check('13. Basic mode: romanized Telugu in, romanized Telugu out', async () => {
  await page.evaluate(() => { location.hash = '#/candidate/assistant'; });
  await page.waitForTimeout(1200); await wizardAway(page);
  await page.fill('#assistantInput', 'naaku job kavali');
  await page.press('#assistantInput', 'Enter');
  await settle(page);
  const b = await bubbles(page);
  const last = b[b.length - 1];
  must(/saripoye jobs/.test(last.text) && !/[\u0C00-\u0C7F]/.test(last.text), 'reply: ' + last.text);
  must(/href="#\/job\//.test(last.html), 'no real job link');
});

await check('no script errors', async () => { must(!errors.length, errors.slice(0, 3).join(' | ')); });

await browser.close();
console.log(`\nscreenshots: ${SHOTS}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
