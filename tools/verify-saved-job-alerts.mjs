/**
 * "New job like one you saved" (0110) in a real browser, on a phone-sized
 * screen, against an isolated instance whose mail goes to a local sink.
 *
 *   1  a candidate saves a job with the star on its page -> the server has it
 *   2  the Saved Jobs page shows it, with "Tell me about similar new jobs" ON
 *   3  the recruiter posts a RELATED job -> a bell entry, and an email at the
 *      SMTP sink naming the saved job (no "Client" anywhere in it)
 *   4  the bell shows "New job like one you saved"
 *   5  the recruiter posts an UNRELATED job -> no bell entry, no email
 *   6  the switch turns off from the page, and the server keeps it
 *   7  the email's unsubscribe link works signed out
 *
 * The SMTP sink is THIS script: it listens on SINK_PORT (2605) and the
 * instance must be started with EMAIL_SMTP_HOST=127.0.0.1
 * EMAIL_SMTP_PORT=2605 (agent Z's start script does). Creates accounts and
 * jobs, so it refuses :4323.
 *
 *   TL_URL=http://127.0.0.1:4425/ node tools/verify-saved-job-alerts.mjs
 */
import { chromium } from 'playwright';
import { SMTPServer } from 'smtp-server';
import { mkdirSync } from 'node:fs';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4425/').replace(/\/?$/, '/');
const SINK_PORT = Number(process.env.SINK_PORT || 2605);
const SHOTS = process.env.SHOTS || '';
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/* ---- the mail sink ---- */
const mails = [];
const decodeQP = (s) => Buffer.from(s.replace(/=\r?\n/g, '')
  .replace(/=([0-9A-F]{2})/g, (m, x) => String.fromCharCode(parseInt(x, 16))), 'latin1').toString('utf8');
/* "=?UTF-8?Q?New_job...?=" / "=?UTF-8?B?...?=" -> text */
const decodeWord = (s) => s.replace(/=\?UTF-8\?([QB])\?([^?]*)\?=\s*/gi, (m, enc, t) => (enc.toUpperCase() === 'B'
  ? Buffer.from(t, 'base64').toString('utf8')
  : Buffer.from(t.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (x, hx) => String.fromCharCode(parseInt(hx, 16))), 'latin1').toString('utf8')));
const sink = new SMTPServer({
  authOptional: true, hideSTARTTLS: true, disabledCommands: ['STARTTLS'],
  onAuth(a, _s, cb) { cb(null, { user: a.username }); },
  onData(stream, session, cb) {
    let raw = '';
    stream.on('data', (c) => { raw += c; });
    stream.on('end', () => {
      const subj = (raw.match(/^Subject:\s*(.+(?:\r?\n[ \t].+)*)/im) || [])[1] || '';
      mails.push({ to: session.envelope.rcptTo.map((r) => r.address), subject: decodeWord(subj.replace(/\r?\n[ \t]/g, ' ')).trim(), raw: decodeQP(raw) });
      cb();
    });
  },
});
await new Promise((resolve, reject) => {
  sink.on('error', reject);
  sink.listen(SINK_PORT, '127.0.0.1', resolve);
}).catch((e) => { console.error(`The mail sink could not listen on ${SINK_PORT}: ${e.message}`); process.exit(2); });

let failed = 0, passed = 0;
let failShot = null;
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (e) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`);
    if (failShot) await failShot(`fail-${passed + failed}`).catch(() => {});
  }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now().toString(36);
const PW = process.env.TL_PASSWORD || 'TeamLink@2026';
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
/* After a reload the app restores its own last route a moment later, so
   the hash is set until it sticks. */
const go = async (p, hash) => {
  for (let i = 0; i < 6; i += 1) {
    await p.evaluate((x) => { if (location.hash !== x) location.hash = x; }, hash);
    await p.waitForTimeout(1000);
    if (await p.evaluate((x) => location.hash === x, hash)) break;
  }
  await away(p);
};

/* ---- the recruiter, in a page of their own ---- */
const rctx = await browser.newContext();
const rp = await open(rctx);
const co = await rp.evaluate(async (pw) => {
  const r = await TL.api.post('/auth/login', { email: 'recruiter@teamlink.com', password: pw, role: 'recruiter' });
  if (r.session && r.session.mustChangePassword) throw new Error('the seeded recruiter must change their password first');
  const boot = await TL.api.get('/bootstrap');
  const mine = (boot.data.recruiters || []).find((x) => boot.session && x.id === boot.session.id) || {};
  const c = (boot.data.companies || []).find((x) => x.id === mine.companyId) || (boot.data.companies || [])[0];
  return { id: c.id, name: c.name };
}, PW).catch((e) => { console.error('recruiter sign-in failed: ' + e.message); process.exit(1); });
const postJob = (title, skills) => rp.evaluate(async ({ title, skills, co }) => {
  const r = await TL.api.post('/jobs', {
    title, companyId: co, location: 'Hyderabad', mode: 'Onsite', exp: '1-3 yrs', pay: '₹3-4 LPA',
    salaryMin: 3, salaryMax: 4, type: 'Full-time', status: 'open', skills,
  });
  return r.job;
}, { title, skills, co: co.id });

/* ---- the candidate ---- */
const email = `saved.jobs.${stamp}@tl-sink.local`;
const cpw = `Saved${stamp}9`;
const cctx = await browser.newContext(PHONE);
const cp = await open(cctx);
const candId = await cp.evaluate(async ({ email, pw }) => {
  const reg = await TL.api.post('/auth/register', {
    name: 'Sravya Saved', email, password: pw, phone: '9' + String(Math.floor(1e8 + Math.random() * 9e8)),
    preferredLocation: 'Hyderabad', expectedCtc: 3, noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'],
  });
  await TL.refresh();
  return reg.candidateId;
}, { email, pw: cpw });
failShot = (n) => shot(cp, n);
const inbox = () => cp.evaluate(async () => ((await TL.api.get('/notifications')).notifications || [])
  .filter((n) => n.type === 'SAVED_JOB_SIMILAR' || n.type === 'SAVED_JOB_DIGEST'));

console.log(`\nsaved-job alerts  (${BASE}, phone 390x844, mail sink :${SINK_PORT})`);

const saved = await postJob('Staff Nurse', ['Patient Care', 'IV Cannulation', 'BLS']);
await wait(1500);   // the job's own publish hook runs before the candidate saves it
await cp.evaluate(() => TL.refresh());

await check('1. the star on the job page saves it on the server', async () => {
  await go(cp, `#/job/${saved.id}`);
  const sel = `button[onclick="toggleSaveJob('${saved.id}')"]`;
  await cp.waitForSelector(sel, { timeout: 8000 });
  await cp.evaluate((s) => { const b = Array.from(document.querySelectorAll(s)).find((x) => x.offsetParent); (b || document.querySelector(s)).click(); }, sel);
  let list = [];
  for (let i = 0; i < 20 && !list.includes(saved.id); i += 1) {
    await wait(250);
    list = (await cp.evaluate(() => TL.api.get('/saved-jobs'))).saved || [];
  }
  must(list.includes(saved.id), 'GET /saved-jobs: ' + JSON.stringify(list));
  await shot(cp, '01-saved-from-job-page');
});

await check('2. Saved Jobs lists it, with "Tell me about similar new jobs" switched on', async () => {
  /* a fresh page load: the list comes back from the server, not from memory */
  await cp.reload();
  await cp.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await go(cp, '#/candidate/saved');
  await cp.waitForSelector('#tlsjaToggle:not([disabled])', { timeout: 8000, state: 'attached' }).catch(async (e) => {
    throw new Error(e.message.split('\n')[0] + ' :: ' + JSON.stringify(await cp.evaluate(() => ({
      hash: location.hash, sess: STATE.session, s: window.TLSavedJobAlerts && TLSavedJobAlerts.settings(),
      pref: !!document.getElementById('tlsjaPref'), app: document.querySelector('#app').innerText.slice(0, 160) }))));
  });
  const t = await cp.evaluate(() => ({
    on: document.getElementById('tlsjaToggle').checked,
    text: document.getElementById('tlsjaPref').innerText,
    listed: document.querySelector('#app').innerText.includes('Staff Nurse'),
  }));
  must(t.on, 'the switch is off');
  must(/Tell me about similar new jobs/.test(t.text), t.text);
  must(t.listed, 'the saved job is not on the page');
  await shot(cp, '02-saved-jobs-toggle-on');
});

const before = mails.length;
let related;
await check('3. a related job: a bell entry and an email naming the saved job', async () => {
  related = await postJob('ICU Staff Nurse', ['Patient Care', 'Ventilator Care']);
  let n = [];
  for (let i = 0; i < 60 && !n.some((x) => x.jobId === related.id); i += 1) { await wait(500); n = await inbox(); }
  const hit = n.find((x) => x.jobId === related.id);
  must(hit, 'no SAVED_JOB_SIMILAR entry for the related job');
  /* the entry carries the full job-opportunity message (owner, 2026-10-06); the owner's line is its summary */
  must((hit.metadata || {}).summary === 'New job like one you saved: ICU Staff Nurse · Hyderabad', JSON.stringify(hit.metadata));
  must(/^\*🚀 NEW JOB OPPORTUNITY – Hyderabad\*/.test(hit.message) && hit.message.includes('🏥 *ICU Staff Nurse*')
    && hit.message.includes(`#/job/${related.id}`), hit.message.slice(0, 200));
  let m = null;
  for (let i = 0; i < 30 && !m; i += 1) {
    m = mails.slice(before).find((x) => x.to.includes(email) && /New job like one you saved/.test(x.subject));
    if (!m) await wait(500);
  }
  must(m, 'no email at the sink for ' + email + ' (got: ' + mails.slice(before).map((x) => x.subject).join(' | ') + ')');
  must(/You saved "Staff Nurse"/.test(m.raw) || /You saved &quot;Staff Nurse&quot;/.test(m.raw), 'the email does not name the saved job');
  must(m.raw.includes(`#/job/${related.id}`), 'no link to the job');
  must(/saved-job-alerts\/stop\?token=/.test(m.raw), 'no unsubscribe link');
  must(!/\bclients?\b/i.test(m.raw.replace(/^[\s\S]*?\r?\n\r?\n/, '')), 'the word Client is in the email');
});

await check('4. the bell shows it', async () => {
  await cp.evaluate(() => TL.refreshNotifications && TL.refreshNotifications());
  await go(cp, '#/candidate/home');
  await cp.waitForTimeout(800);
  /* the candidate portal's own bell (cpShell) */
  const badge = await cp.evaluate(() => (document.querySelector('.cp-hd .cp-ico[title="Notifications"] .cp-b') || {}).textContent || '');
  must(/\d/.test(badge), 'no unread badge on the bell');
  await cp.click('.cp-hd .cp-ico[title="Notifications"]');
  await cp.waitForTimeout(600);
  const txt = await cp.evaluate(() => { const p = document.querySelector('.cp-hd .cp-panel.on'); return p ? p.innerText : ''; });
  must(/New job like one you saved: ICU Staff Nurse · Hyderabad/.test(txt), 'bell: ' + txt.slice(0, 200));
  must(/like “Staff Nurse”, which you saved/.test(txt), 'the bell does not name the saved job');
  await shot(cp, '04-bell-entry');
  /* tapping the entry opens the job and marks it read on the server */
  await cp.evaluate(() => {
    const row = Array.from(document.querySelectorAll('.cp-hd .cp-panel.on .cp-row')).find((r) => /New job like one you saved/.test(r.innerText));
    if (row) row.click();
  });
  await cp.waitForTimeout(1200);
  must(await cp.evaluate((id) => location.hash === `#/job/${id}`, related.id), 'the entry did not open the job');
  /* ...with the full message over it */
  const sheet = await cp.evaluate(() => { const x = document.querySelector('#tlpuOverlay .tlpu-sheet'); return x ? x.innerText : ''; });
  must(/NEW JOB OPPORTUNITY/.test(sheet) && /You saved "Staff Nurse"/.test(sheet) && /View Job & Apply/.test(sheet), 'sheet: ' + sheet.slice(0, 200));
  await shot(cp, '04b-full-message');
  await cp.evaluate(() => window.tlpuCloseSheet && tlpuCloseSheet());
  const read = (await inbox()).find((x) => x.jobId === related.id);
  must(read && read.read === true, 'not marked read on the server');
});

await check('5. an unrelated job: nothing in the bell, nothing in the mail', async () => {
  const mark = mails.length;
  const other = await postJob('Electrician', ['Wiring', 'Panel Boards']);
  await wait(9000);
  const n = await inbox();
  must(!n.some((x) => x.jobId === other.id), 'a bell entry for the unrelated job');
  must(!mails.slice(mark).some((x) => x.to.includes(email)), 'an email for the unrelated job: '
    + mails.slice(mark).filter((x) => x.to.includes(email)).map((x) => x.subject).join(' | '));
});

await check('6. the switch turns off from the page and the server keeps it', async () => {
  await go(cp, '#/candidate/saved');
  await cp.waitForSelector('#tlsjaToggle:not([disabled])', { timeout: 8000, state: 'attached' });
  await cp.click('.tlsja-switch span');
  let s = null;
  for (let i = 0; i < 20; i += 1) {
    await wait(250);
    s = (await cp.evaluate(() => TL.api.get('/saved-job-alerts/settings'))).settings;
    if (s && s.enabled === false) break;
  }
  must(s && s.enabled === false, 'server says ' + JSON.stringify(s));
  await cp.reload();
  await cp.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await go(cp, '#/candidate/saved');
  await cp.waitForSelector('#tlsjaToggle:not([disabled])', { timeout: 8000, state: 'attached' });
  must(!(await cp.evaluate(() => document.getElementById('tlsjaToggle').checked)), 'the switch is back on after a reload');
  await shot(cp, '06-saved-jobs-toggle-off');
  /* on again for the last check */
  await cp.click('.tlsja-switch span');
  await wait(800);
});

await check('7. the email\'s unsubscribe link works signed out', async () => {
  const m = mails.find((x) => x.to.includes(email) && /New job like one you saved/.test(x.subject));
  must(m, 'no email to read the link from');
  const link = (/(https?:\/\/[^\s"<>]+\/api\/saved-job-alerts\/stop\?token=[^\s"<>]+)/.exec(m.raw) || [])[1];
  must(link, 'no link in the email');
  const local = new URL(link);
  const res = await fetch(new URL(local.pathname + local.search, BASE));   // no cookies
  const html = await res.text();
  must(res.status === 200 && /Similar-job emails stopped/.test(html), `status ${res.status}`);
  const s = (await cp.evaluate(() => TL.api.get('/saved-job-alerts/settings'))).settings;
  must(s.enabled === false && s.changedVia === 'email_link', JSON.stringify(s));
});

await browser.close();
await new Promise((r) => sink.close(r));
console.log(`\n${passed} passed, ${failed} failed  (candidate ${candId})`);
process.exitCode = failed ? 1 : 0;
