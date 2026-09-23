/**
 * The SMS and WhatsApp settings a carrier checks, driven as a recruiter.
 *
 * Both channels have composed a message at every stage since the
 * dispatcher was built, and both report `not_configured` because the
 * keys are not on the server. The keys are the user's to add. What is
 * tested here is everything else those carriers require, because a
 * correct key with none of it still produces a rejected message:
 *
 *   - the fields exist and a recruiter can save them
 *   - what is typed reaches the SERVER, read back on a later request
 *   - NO input on the page takes a credential, and the endpoint REFUSES
 *     a body carrying one rather than ignoring it - an endpoint that
 *     silently drops a secret still had the secret in the request
 *   - the settings reach the outbound payload: a WhatsApp template name
 *     turns a text message into a template message, which is the whole
 *     point of the field
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

const heads = await page.$$eval('#tlChannels .panel-head h2', (ns) => ns.map((n) => n.textContent.trim()));
check(heads.includes('SMS Configuration'), 'the SMS configuration panel is on the screen');
check(heads.includes('WhatsApp Configuration'), 'the WhatsApp configuration panel is on the screen');

const labels = await page.$$eval('#tlChannels .fgroup label', (ns) => ns.map((n) => n.textContent.trim()));
for (const want of ['Sender ID / Header', 'DLT Entity ID', 'DLT Template ID',
                    'Message Template Name', 'Template Language']) {
  check(labels.includes(want), `the form asks for ${want}`);
}

const credentialInputs = await page.$$eval('#tlChannels input',
  (ns) => ns.filter((n) => /key|token|secret|password/i.test(n.id + n.name + (n.placeholder || ''))).length);
check(credentialInputs === 0, 'no input anywhere on the page takes a credential');

/* ---- what is typed reaches the server ------------------------------ */
const sms = { senderId: 'TMLINK', dltEntityId: '1101234567890123456',
              dltTemplateId: '1107654321098765432' };
await page.fill('#chSmsSender', sms.senderId);
await page.fill('#chSmsEntity', sms.dltEntityId);
await page.fill('#chSmsTemplate', sms.dltTemplateId);
await page.click('#chSave_sms');
await page.waitForTimeout(2200);

const wa = { templateName: 'teamlink_update', templateLanguage: 'en' };
await page.fill('#chWaTemplate', wa.templateName);
await page.fill('#chWaLang', wa.templateLanguage);
await page.click('#chSave_whatsapp');
await page.waitForTimeout(2200);

const saved = await page.evaluate(() => window.TL.api.get('/notifications/channels')
  .then((r) => r.settings));
for (const [k, v] of Object.entries(sms)) {
  check(saved.sms[k] === v, `sms.${k} reached the server (${JSON.stringify(saved.sms[k])})`);
}
for (const [k, v] of Object.entries(wa)) {
  check(saved.whatsapp[k] === v, `whatsapp.${k} reached the server (${JSON.stringify(saved.whatsapp[k])})`);
}

/* ---- a credential is refused, not ignored -------------------------- */
const refused = await page.evaluate(() => window.TL.api
  .patch('/notifications/channels/sms', { senderId: 'TMLINK', apiKey: 'sk-should-never-be-accepted' })
  .then(() => null).catch((e) => String(e.message || e)));
check(refused !== null, `a body carrying an API key is refused (${refused || 'IT WAS ACCEPTED'})`);

/* ---- clearing really clears ---------------------------------------- */
await page.fill('#chSmsTemplate', '');
await page.click('#chSave_sms');
await page.waitForTimeout(2200);
const cleared = await page.evaluate(() => window.TL.api.get('/notifications/channels')
  .then((r) => r.settings.sms.dltTemplateId));
check(cleared === null || cleared === undefined,
  `clearing the DLT template id really clears it (${JSON.stringify(cleared)})`);

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);

/*
 * Put the desk back as it was found.
 *
 * The values above are invented - a real DLT entity id is issued by an
 * operator - and leaving them behind would put fake registration
 * numbers on a live screen where the next person reads them as real.
 */
await page.evaluate(() => Promise.all([
  window.TL.api.patch('/notifications/channels/sms',
    { senderId: '', dltEntityId: '', dltTemplateId: '' }),
  window.TL.api.patch('/notifications/channels/whatsapp',
    { templateName: '', templateLanguage: 'en' }),
]));
const emptied = await page.evaluate(() => window.TL.api.get('/notifications/channels')
  .then((r) => r.settings));
check(!emptied.sms.senderId && !emptied.whatsapp.templateName,
  'the test values were cleared again, so nothing invented is left on screen');

await browser.close();

/* ---- the settings reach the outbound payload ------------------------ *
 * Not a screen test, and not a network one either. These two functions
 * ARE the difference between a message the carrier accepts and one it
 * rejects, so the branch is exercised directly: "the field saved" and
 * "the field changes the message" are different claims, and the send
 * path only ever exercises the second by accident.
 *
 * Importing them needs no database - which is the point, because the
 * embedded engine serves one client at a time and the dev server holds
 * it.
 */
const { whatsappBody, smsBody } = await import('../api/src/notify/providers.js');

const tmpl = whatsappBody('Your interview is scheduled.', wa);
check(tmpl.type === 'template',
  `a configured template name makes the message a template (type=${tmpl.type})`);
check(tmpl.template.name === wa.templateName,
  `the approved template name is the one sent (${tmpl.template.name})`);
check(tmpl.template.language.code === 'en', 'the template language is carried');
check(tmpl.template.components[0].parameters[0].text === 'Your interview is scheduled.',
  'the composed wording goes into the template body, not a second copy');

const plain = whatsappBody('Your interview is scheduled.', {});
check(plain.type === 'text',
  'with no template configured it still sends text, which is right inside the 24-hour window');

const withDlt = smsBody('+919030048228', 'Your interview is scheduled.', sms);
check(withDlt.sender === sms.senderId, 'the SMS header is the configured sender');
check(withDlt.entityId === sms.dltEntityId && withDlt.templateId === sms.dltTemplateId,
  'the DLT entity and template reach the SMS payload');

const noDlt = smsBody('+919030048228', 'Hello', {});
check(!('entityId' in noDlt) && !('templateId' in noDlt),
  'an aggregator that does not use DLT is not handed empty DLT keys');

console.log(fail.length ? `\n${fail.length} failed` : `\nall good`);
process.exit(fail.length ? 1 : 0);
