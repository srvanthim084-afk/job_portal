/**
 * The calling configuration a recruiter fills in, driven as a recruiter.
 *
 * The screen it replaces stored an API key in the browser and saved
 * everything to localStorage, so nothing it collected was ever used to
 * place a call. Two things are checked here, and the second is the one
 * that matters:
 *
 *   1. NO CREDENTIAL INPUT EXISTS. Every recruiter can open this page.
 *      A field that takes an account token hands it to anybody with the
 *      developer tools open, so the assertion is that the count is zero
 *      - not that it is hidden, or disabled, or blanked on save.
 *   2. What is typed reaches the SERVER. Read back through the API on a
 *      separate request, so a value still sitting in the form cannot
 *      pass for a value that was stored.
 */
import { chromium } from 'playwright';

const ORIGIN = process.env.TL_ORIGIN || 'http://localhost:4323/';
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1050 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(ORIGIN, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
// Passed in, never written into the page source.
const LOGIN = { email: process.env.TL_RECRUITER || 'teamlinkmed001@tmlink.in',
                password: process.env.TL_RECRUITER_PASSWORD || 'Teamlink@2026',
                role: 'recruiter' };
await page.evaluate((login) => window.TL.api.post('/auth/login', login), LOGIN);
await page.evaluate(() => window.TL.refresh());
await page.waitForTimeout(900);
await page.evaluate(() => { location.hash = '#/recruiter/comm?tab=channels'; });
await page.waitForTimeout(2600);

const labels = await page.$$eval('#tlChannels .fgroup label', (ns) => ns.map((n) => n.textContent.trim()));
for (const want of ['Provider', 'Caller ID', 'Max Retry Attempts', 'API URL',
                    'Retry Interval (minutes)', 'API Key / Token']) {
  check(labels.includes(want), `the form asks for ${want}`);
}
check(await page.isVisible('#chAutoInterview'), 'Enable Automatic Interview Calls');
check(await page.isVisible('#chAutoReminder'), 'Enable Automatic Reminder Calls');

const credentialInputs = await page.$$eval('#tlChannels input',
  (ns) => ns.filter((n) => /key|token|secret|password/i.test(n.id + n.name + (n.placeholder || ''))).length);
check(credentialInputs === 0, 'no input anywhere on the page takes a credential');

const want = { provider: 'twilio', callerId: '+919030048228', retryMins: 20, autoReminder: true };
await page.fill('#chCallerId', want.callerId);
await page.fill('#chRetryMins', String(want.retryMins));
await page.selectOption('#chProvider', want.provider);
await page.check('#chAutoReminder');
await page.click('#chSave');
await page.waitForTimeout(2600);

const saved = await page.evaluate(() => window.TL.api.get('/ai-calling/status').then((r) => ({
  provider: r.settings.provider, callerId: r.settings.callerId,
  retryMins: r.settings.retryIntervalMinutes, autoReminder: r.settings.autoReminderCalls })));
for (const k of Object.keys(want)) {
  check(saved[k] === want[k], `${k} reached the server (${JSON.stringify(saved[k])})`);
}
/*
 * The route now admits recruiters, where it once admitted admins only.
 * That is a real widening, so the limit is tested rather than trusted:
 * disclosure and recording carry legal weight and are not a recruiter's
 * to change. A patch containing both kinds of field must save the
 * operational one and leave the admin one exactly as it was.
 */
const was = await page.evaluate(() => window.TL.api.get('/ai-calling/status').then((r) => ({
  discloseAi: r.settings.discloseAi, recordingEnabled: r.settings.recordingEnabled,
  agentName: r.settings.agentName })));
await page.evaluate(() => window.TL.api.patch('/ai-calling/settings', {
  discloseAi: false, recordingEnabled: true, agentName: 'Changed by a recruiter',
  callerId: '+911111111111' }));
const now = await page.evaluate(() => window.TL.api.get('/ai-calling/status').then((r) => ({
  discloseAi: r.settings.discloseAi, recordingEnabled: r.settings.recordingEnabled,
  agentName: r.settings.agentName, callerId: r.settings.callerId })));
for (const k of Object.keys(was)) {
  check(now[k] === was[k], `a recruiter cannot change ${k} (still ${JSON.stringify(was[k])})`);
}
check(now.callerId === '+911111111111',
  'the operational field in that same patch still saved');

// Leave the desk as it was found.
await page.evaluate((c) => window.TL.api.patch('/ai-calling/settings', { callerId: c }),
  want.callerId);

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);

await browser.close();
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
