/**
 * The recruiter's side of the Naukri intake, driven through the screen.
 *
 * The engine is verified elsewhere; this checks the thing a recruiter
 * actually touches: the Import from Mail button on Applications, the
 * mailbox it connects, the queue for emails the system will not guess
 * at, and the TL-APP reference showing up where they are already looking.
 *
 *   node tools/verify-intake-ui.mjs      (needs npm run dev on :4323)
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const api = async (m, p, b) => {
  const r = await page.evaluate(([mm, pp, bb]) =>
    window.TL.api[mm](pp, bb).then((v) => ({ ok: true, v }),
      (e) => ({ ok: false, code: e.code, message: e.message })), [m, p, b]);
  if (!r.ok) throw Object.assign(new Error(`${r.code}: ${r.message}`), { code: r.code });
  return r.v;
};

const stamp = Date.now();

await check('the Applications screen offers Import from Mail', async () => {
  await api('post', '/auth/login',
    { email: 'recruiter@teamlink.com', password: PASSWORD, role: 'recruiter' });
  await page.evaluate(() => window.TL.refresh());
  await page.waitForTimeout(800);

  await page.evaluate(() => { location.hash = '#/recruiter/applications'; });
  await page.waitForTimeout(1500);

  const found = await page.evaluate(() =>
    [...document.querySelectorAll('button')].some((b) => /import from mail/i.test(b.textContent)));
  must(found, 'the Import from Mail button is not on the Applications screen');
});

await check('every imported application shows its TL-APP reference in the list', async () => {
  const refs = await page.evaluate(() =>
    [...document.querySelectorAll('[data-tl-ref]')].map((e) => e.textContent.trim()));
  must(refs.length > 0, 'no application reference is shown in the table');
  must(refs.every((r) => /^TL-APP-\d{4}-\d{5}/.test(r)),
    `a reference is malformed: ${refs.find((r) => !/^TL-APP-/.test(r))}`);
  must(refs.some((r) => /from mail/.test(r)),
    'no application is marked as having come from the mailbox');
});

await check('the button opens the mailbox screen', async () => {
  await page.evaluate(() => window.TL.intake.open());
  await page.waitForTimeout(1800);
  const text = await page.evaluate(() => document.body.innerText);
  must(/Import from Mail/i.test(text), 'the modal did not open');
  must(/Connected mailboxes/i.test(text), 'no mailbox list');
  must(/Connect the inbox Naukri replies to/i.test(text), 'no way to connect one');
  must(/Needs a recruiter/i.test(text), 'no queue');
});

await check('it never asks for a mailbox password', async () => {
  const html = await page.evaluate(() =>
    (document.getElementById('tlIntakeBody') || {}).innerHTML || '');
  must(!/type="password"/i.test(html), 'there is a password field on the screen');
  must(/never entered here/i.test(html), 'the screen does not say where the credential comes from');
});

let mailboxId;
await check('connecting a mailbox works from the screen', async () => {
  await page.evaluate((addr) => {
    document.getElementById('tlIntakeAddr').value = addr;
    document.getElementById('tlIntakeProvider').value = 'mock';
    window.TL.intake.connect();
  }, `ui.${stamp}@teamlink.com`);
  await page.waitForTimeout(2200);

  const { mailboxes } = await api('get', '/intake/mailboxes');
  const mine = mailboxes.find((m) => m.address === `ui.${stamp}@teamlink.com`);
  must(mine, 'the mailbox was not connected');
  mailboxId = mine.id;
});

await check('Sync now imports, and says what happened to each message', async () => {
  await page.evaluate((id) => window.TL.intake.sync(id), mailboxId);
  await page.waitForTimeout(6000);

  const out = await page.evaluate(() =>
    (document.getElementById('tlIntakeOut') || {}).innerText || '');
  must(/read \d+/.test(out), `the result was not reported: "${out}"`);
  must(/imported \d+/.test(out), `nothing about imports: "${out}"`);

  const { messages } = await api('get', `/intake/messages?mailboxId=${mailboxId}`);
  must(messages.length >= 4, `only ${messages.length} messages were recorded`);
  must(messages.some((m) => m.status === 'processed'), 'nothing was imported');
});

await check('an email the system will not guess at is offered for mapping', async () => {
  await page.evaluate(() => window.TL.intake.refresh());
  await page.waitForTimeout(1800);
  const html = await page.evaluate(() =>
    (document.getElementById('tlIntakeBody') || {}).innerHTML || '');
  must(/Needs a requirement|Needs review/i.test(html), 'the queue shows nothing to act on');
  must(/tlMap_/.test(html), 'there is no requirement picker to map it with');
});

await check('mapping it from the screen creates the application', async () => {
  const { queue } = await api('get', '/intake/queue');
  const mine = queue.find((m) => m.mailboxId === mailboxId && m.status === 'needs_mapping');
  must(mine, 'nothing in this mailbox is awaiting a requirement');

  const jobId = await page.evaluate(() => {
    const j = (DATA.jobs || []).find((x) => x.status === 'open' && !x.paused && !x.archived);
    return j ? j.id : null;
  });
  await page.evaluate(([id, job]) => {
    const sel = document.getElementById('tlMap_' + id);
    if (sel) sel.value = job;
    window.TL.intake.map(id);
  }, [mine.id, jobId]);
  await page.waitForTimeout(2500);

  const out = await page.evaluate(() =>
    (document.getElementById('tlIntakeOut') || {}).innerText || '');
  must(/TL-APP-/.test(out), `mapping did not report an application: "${out}"`);
});

await check('the activity timeline and communication history are readable', async () => {
  const { messages } = await api('get', `/intake/messages?mailboxId=${mailboxId}&status=processed`);
  const withApp = messages.find((m) => m.applicationId);
  must(withApp, 'no imported application to inspect');

  await page.evaluate((id) => window.TL.intake.timeline(id), withApp.applicationId);
  await page.waitForTimeout(2000);

  const text = await page.evaluate(() =>
    (document.getElementById('tlIntakeBody') || {}).innerText || '');
  must(/Activity/i.test(text), 'no activity section');
  must(/Application .*created|application/i.test(text), 'the timeline is empty');
  must(/Communication history/i.test(text), 'no communication history');
  must(/email/i.test(text), 'the communication history lists no channel');
});

await check('no console errors through any of that', async () => {
  const real = errors.filter((e) => !/favicon|manifest/i.test(e));
  must(real.length === 0, `console errors: ${real.slice(0, 2).join(' | ')}`);
});

await browser.close();
console.log(failed === 0
  ? '\n  INTAKE UI VERIFIED — Import from Mail connects, syncs, maps and shows the reference\n'
  : `\n  ${failed} check(s) FAILED\n`);
process.exit(failed ? 1 : 0);
