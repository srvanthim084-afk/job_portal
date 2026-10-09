/**
 * Administration -> Integrations -> Email / SMS / WhatsApp configuration, through the real UI.
 *
 *   TL_URL=http://127.0.0.1:4461/ node tools/verify-channel-config.mjs
 *   TL_SHOTS=<dir>   also write screenshots
 *
 * Creates nothing in the portal's data but the channel settings, and refuses :4323. A real SMTP
 * server on localhost receives the test email, so "Test" is proven against the actual protocol.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { SMTPServer } from 'smtp-server';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4461/').replace(/\/?$/, '/');
const u = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.port === '4323') { console.error('Refusing to run against the live instance.'); process.exit(2); }
const SHOTS = process.env.TL_SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const ADMIN = process.env.TL_ADMIN || 'admin@teamlink.com';
const PW = process.env.TL_ADMIN_PASSWORD || process.env.TL_PASSWORD || 'TeamLink@2026';
const SMTP_PASS = 'Smtp-pass-verify-2026';
const SMTP_PORT = 2641;

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

const mails = [];
const smtp = new SMTPServer({
  authOptional: false, hideSTARTTLS: true, disabledCommands: ['STARTTLS'],
  onAuth(a, _s, cb) { return a.password === SMTP_PASS ? cb(null, { user: 1 }) : cb(new Error('Invalid login')); },
  onData(stream, _s, cb) { let d = ''; stream.on('data', (x) => { d += x; }); stream.on('end', () => { mails.push(d); cb(); }); },
});
await new Promise((r) => smtp.listen(SMTP_PORT, '127.0.0.1', r));

const browser = await chromium.launch();
const errors = [];
const bodies = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|mediapipe|Content Security Policy|connect-src|fonts\.g|40[0-9]/i.test(m.text())) errors.push(m.text().slice(0, 200)); });
p.on('response', async (r) => { if (/integration-channels/.test(r.url())) { try { bodies.push(await r.text()); } catch (e) { /* gone */ } } });
const ready = () => p.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
const shot = async (name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` }); };

await p.goto(BASE + '#/'); await ready();
const login = await p.evaluate(async ({ e, pw }) => { try { await TL.api.post('/auth/login', { email: e, password: pw, role: 'admin' }); return 'ok'; } catch (x) { return x.code || x.message; } }, { e: ADMIN, pw: PW });
if (login !== 'ok') { console.log(`  FAIL  could not sign in as ${ADMIN}: ${login}`); await browser.close(); process.exit(1); }
await p.goto('about:blank'); await p.goto(BASE + '#/admin/integrations'); await ready();
await p.waitForFunction(() => document.querySelectorAll('#tlccPanel .tlcc-card').length === 3, null, { timeout: 20000 });

console.log(`\nChannel configuration  (${BASE})`);

await check('the three cards sit on the Integrations page with all five buttons; the existing cards are still there', async () => {
  const cards = await p.$$eval('#tlccPanel .tlcc-card', (els) => els.map((e) => ({
    name: e.querySelector('.tlcc-name').textContent, badges: [...e.querySelectorAll('.tlcc-b')].map((b) => b.textContent),
    buttons: [...e.querySelectorAll('.tlcc-act button')].map((b) => b.textContent.trim()) })));
  must(cards.map((c) => c.name).join('|') === 'Email (SMTP)|SMS Gateway|WhatsApp Business', JSON.stringify(cards.map((c) => c.name)));
  for (const c of cards) {
    must(c.badges.join('|') === 'Not Connected|Demo', `${c.name} badges ${c.badges}`);
    must(c.buttons.join('|') === 'Connect|Test|Disconnect|History|Configure →', `${c.name} buttons ${c.buttons}`);
  }
  must(await p.evaluate(() => (document.getElementById('tljpAdmHost') || {}).innerText.length > 100), 'the existing job-site cards are gone');
  await shot('1-integrations-1280');
});

await check('Configure Email: centred modal, title with icon, x, uppercase labels, secret label, footer note, Cancel + Save & Connect', async () => {
  await p.click('#tlccCard_email .tlcc-cfg');
  await p.waitForSelector('#tlccOv .tlcc-modal');
  const m = await p.evaluate(() => {
    const r = document.querySelector('.tlcc-modal').getBoundingClientRect();
    const lab = [...document.querySelectorAll('.tlcc-f label')].map((l) => ({ t: l.textContent.trim(), up: getComputedStyle(l).textTransform }));
    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), vw: innerWidth, vh: innerHeight,
      title: document.querySelector('.tlcc-head h3').textContent, icon: document.querySelector('.tlcc-head .tlcc-ico').textContent,
      x: !!document.querySelector('.tlcc-x'), lab, foot: document.querySelector('.tlcc-fnote').textContent,
      btns: [...document.querySelectorAll('.tlcc-fbtn button')].map((b) => b.textContent.trim()),
      bodyScroll: getComputedStyle(document.querySelector('.tlcc-body')).overflowY, footPos: document.querySelector('.tlcc-foot').getBoundingClientRect().bottom <= innerHeight };
  });
  must(Math.abs(m.cx - m.vw / 2) <= 2 && Math.abs(m.cy - m.vh / 2) <= 40, `not centred ${m.cx},${m.cy} in ${m.vw}x${m.vh}`);
  must(m.title === 'Configure Email (SMTP)' && m.icon, m.title);
  must(m.x, 'no close button');
  must(m.lab.every((l) => l.up === 'uppercase'), 'a label is not uppercase');
  must(m.lab.map((l) => l.t).join('|').startsWith('SMTP Host|Port|From Address|Username|Password / App Key · STORED ENCRYPTED, NEVER SHOWN'), m.lab.map((l) => l.t).join('|'));
  must(m.foot === 'Credentials are encrypted on the server before they are stored and are never sent back to this page. This channel really contacts the provider once it is connected.', m.foot);
  must(m.btns.join('|') === 'Cancel|Save & Connect', m.btns.join('|'));
  must(m.bodyScroll === 'auto' && m.footPos, 'the body does not scroll / the footer is off screen');
  await shot('2-email-modal');
});

await check('Save & Connect with nothing filled in shows inline errors under each field and saves nothing', async () => {
  await p.fill('#tlccF_port', '');
  await p.click('#tlccSave');
  await p.waitForSelector('#tlccOv .tlcc-f.err');
  const errs = await p.$$eval('#tlccOv .tlcc-f.err', (els) => els.map((e) => e.id.replace('tlccW_', '') + ': ' + e.querySelector('.tlcc-e').textContent));
  must(errs.some((x) => /^host: .*required/i.test(x)) && errs.some((x) => /^port: /.test(x)) && errs.some((x) => /^fromAddress: /.test(x))
    && errs.some((x) => /^username: /.test(x)) && errs.some((x) => /^secret: .*required/i.test(x)), errs.join(' | '));
  const list = await p.evaluate(async () => (await TL.api.get('/admin/integration-channels')).channels.find((c) => c.channel === 'email'));
  must(list.status === 'Not Connected', 'something was saved');
});

await check('a valid Email setup saves, connects (Live) and the card shows host:port', async () => {
  await p.fill('#tlccF_host', '127.0.0.1'); await p.fill('#tlccF_port', String(SMTP_PORT));
  await p.fill('#tlccF_fromAddress', 'hr@tmlink.in'); await p.fill('#tlccF_username', 'mailer');
  await p.fill('#tlccF_secret', SMTP_PASS); await p.selectOption('#tlccF_encryption', 'None'); await p.fill('#tlccF_fromName', 'TeamLink HR');
  await p.click('#tlccSave');
  await p.waitForFunction(() => !document.getElementById('tlccOv'), null, { timeout: 15000 });
  const t = await p.textContent('#tlccCard_email');
  must(/Connected/.test(t) && !/Not Connected/.test(t) && /Live/.test(t), t.slice(0, 200));
  must(t.includes(`127.0.0.1:${SMTP_PORT}`), 'no host:port summary');
  await shot('3-email-connected');
});

await check('the password is never shown again: masked placeholder, empty box, and no response or page text carries it', async () => {
  await p.click('#tlccCard_email .tlcc-cfg');
  await p.waitForSelector('#tlccF_secret');
  const f = await p.evaluate(() => { const i = document.getElementById('tlccF_secret'); return { value: i.value, ph: i.placeholder, type: i.type }; });
  must(f.value === '' && f.type === 'password', JSON.stringify(f));
  must(/^••••••.*leave blank to keep, "-" to clear$/.test(f.ph), f.ph);
  must(!(await p.content()).includes(SMTP_PASS), 'the password is in the page');
  must(bodies.length > 0 && bodies.every((b) => !b.includes(SMTP_PASS)), 'a response carried the password');
  await p.click('.tlcc-fbtn .tlcc-sec2');
});

await check('Test sends a real email through the SMTP server and shows the result on the card', async () => {
  const before = mails.length;
  await p.click('#tlccCard_email .tlcc-act button:nth-child(2)');
  await p.waitForSelector('#tlccTo');
  await p.click('.tlcc-prim');
  await p.waitForFunction(() => /Test passed/.test((document.getElementById('tlccCard_email') || {}).textContent || ''), null, { timeout: 25000 });
  must(mails.length === before + 1 && /Subject: TeamLink test email/.test(mails[mails.length - 1]), 'the SMTP server did not receive the test email');
});

await check('History lists the actions, without any value', async () => {
  await p.click('#tlccCard_email .tlcc-act button:nth-child(4)');
  await p.waitForFunction(() => /Connected/.test((document.getElementById('tlccHist') || {}).textContent || ''), null, { timeout: 8000 });
  const t = await p.textContent('#tlccHist');
  must(/Test passed/.test(t) && /Settings saved/.test(t) && /Secret saved/.test(t), t);
  must(!t.includes(SMTP_PASS), 'history shows the secret');
  await p.click('.tlcc-fbtn .tlcc-sec2');
});

await check('SMS: the Twilio Account SID appears only for Twilio; WhatsApp has its nine fields', async () => {
  await p.click('#tlccCard_sms .tlcc-cfg'); await p.waitForSelector('#tlccF_provider');
  const labels = await p.$$eval('#tlccOv .tlcc-f label', (ls) => ls.map((l) => l.textContent.trim()));
  must(labels.join('|').startsWith('Provider|Sender ID (6 chars) / Twilio From Number|API Key / Auth Token · STORED ENCRYPTED, NEVER SHOWN|Twilio Account SID|DLT Template ID, Agreement Link|DLT Template ID, OTP|DLT Template ID, Bulk / General'), labels.join('|'));
  must(await p.$eval('#tlccW_twilioSid', (e) => e.hidden), 'SID visible for MSG91');
  await p.selectOption('#tlccF_provider', 'Twilio');
  must(!(await p.$eval('#tlccW_twilioSid', (e) => e.hidden)), 'SID hidden for Twilio');
  must((await p.getAttribute('#tlccF_twilioSid', 'placeholder')) === 'Twilio only (AC…)', 'SID placeholder');
  must((await p.getAttribute('#tlccF_dltAgreement', 'placeholder')) === 'vars: name, agreement no., link', 'agreement placeholder');
  await p.click('.tlcc-x');
  await p.click('#tlccCard_whatsapp .tlcc-cfg'); await p.waitForSelector('#tlccF_phoneNumberId');
  const wl = await p.$$eval('#tlccOv .tlcc-f label', (ls) => ls.map((l) => l.textContent.trim()));
  must(wl.length === 9, `${wl.length} WhatsApp fields: ${wl.join('|')}`);
  must((await p.getAttribute('#tlccF_phoneNumberId', 'placeholder')) === 'from Meta → WhatsApp → API Setup', 'phone id placeholder');
  must((await p.getAttribute('#tlccF_templateAgreement', 'placeholder')) === 'body {{1}} name, {{2}} agreement no., {{3}} link', 'template placeholder');
  await p.keyboard.press('Escape');
  must(!(await p.$('#tlccOv')), 'Escape did not close the modal');
});

await check('Disconnect turns the card back to Not Connected / Demo', async () => {
  p.once('dialog', (d) => d.accept());
  await p.click('#tlccCard_email .tlcc-act button:nth-child(3)');
  await p.waitForFunction(() => /Not Connected/.test((document.getElementById('tlccCard_email') || {}).textContent || ''), null, { timeout: 8000 });
  must(/Demo/.test(await p.textContent('#tlccCard_email')), 'not Demo');
});

await check('at 390px the cards stack and the modal fits the screen with its footer visible; no sideways scroll', async () => {
  await p.setViewportSize({ width: 390, height: 780 });
  await p.waitForTimeout(300);
  must(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page scrolls sideways');
  await p.click('#tlccCard_sms .tlcc-cfg'); await p.waitForSelector('#tlccOv .tlcc-modal');
  const g = await p.evaluate(() => { const r = document.querySelector('.tlcc-modal').getBoundingClientRect(); const f = document.querySelector('.tlcc-foot').getBoundingClientRect();
    return { l: r.left, r: r.right, b: f.bottom, vw: innerWidth, vh: innerHeight }; });
  must(g.l >= 0 && g.r <= g.vw && g.b <= g.vh, JSON.stringify(g));
  await shot('4-sms-modal-390');
  await p.click('.tlcc-x');
  await p.setViewportSize({ width: 1280, height: 900 });
});

await check('a recruiter cannot reach the channels', async () => {
  const r = await p.evaluate(async () => { try { await TL.api.post('/auth/logout', {}); await TL.api.post('/auth/login', { email: 'recruiter@teamlink.com', password: 'TeamLink@2026', role: 'recruiter' }); await TL.api.get('/admin/integration-channels'); return 200; } catch (e) { return e.status; } });
  must(r === 403, `status ${r}`);
});

await check('no page errors', async () => { must(errors.length === 0, errors.slice(0, 3).join(' | ')); });
await browser.close();
await new Promise((r) => smtp.close(r));
console.log(failed ? `\n${failed} check(s) failed` : '\nall passed');
process.exit(failed ? 1 : 0);
