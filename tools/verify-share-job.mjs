/**
 * Share Job, the way a candidate does it.
 *
 *   1  walk-in job: the sheet shows a preview with the Walk-in badge; the
 *      WhatsApp message has the walk-in block, the venue, the main-gate note,
 *      the contact and this job's own link
 *   2  regular job: no walk-in lines anywhere
 *   3  a job with empty fields: no "undefined" / "null" / "NaN", rows left out
 *   4  WhatsApp: wa.me with the message encoded (emojis, ₹, &, new lines)
 *   5  Copy Link copies ONLY the link, and that link opens this very job;
 *      Copy Job Details copies the whole message
 *   6  phone: the sheet fits, no sideways scroll; "More" uses the device's
 *      share sheet with the message and the link
 *
 * Creates accounts and jobs, so it refuses :4323.
 *   TL_URL=http://127.0.0.1:4419/ node tools/verify-share-job.mjs
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4419/').replace(/\/?$/, '/');
const u = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts and jobs. Use an isolated instance.`);
  process.exit(2);
}
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const s = Date.now().toString(36);
const RECRUITER = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';
const PW = process.env.TL_RECRUITER_PASSWORD || process.env.DEV_PASSWORD || 'TeamLink@2026';
const lines = (t) => String(t || '').split('\n');

const b = await chromium.launch();

/* the jobs, published by the seed recruiter of this isolated instance */
const setup = await b.newContext();
const sp = await setup.newPage();
await sp.goto(BASE + '#/');
await sp.waitForFunction(() => window.TL && TL.ready === true);
const J = await sp.evaluate(async ({ e, pw, s }) => {
  await TL.api.post('/auth/login', { email: e, password: pw, role: 'recruiter' });
  const boot = await TL.api.get('/bootstrap');
  const me = (boot.data.recruiters || []).find((r) => r.id === boot.session.id) || {};
  const base = { companyId: me.companyId, status: 'open', skills: ['Communication'] };
  const walk = await TL.api.post('/jobs', { ...base, title: `HR Recruiter ${s}`, location: 'KPHB, Hyderabad', mode: 'Onsite',
    exp: '0-Any', pay: '₹3 LPA', salaryMin: 3, salaryMax: 3, type: 'Walk-in', postingKind: 'walkin', education: 'Any Degree',
    requirements: ['Good Communication Skills', 'Telugu & English are Mandatory'],
    walkinDate: '2026-10-10', walkinFrom: '10:00', walkinTo: '16:00',
    walkinVenue: 'TeamLink Consultants (OPC) Pvt. Ltd.', walkinAddress: 'Plot 12, KPHB Phase 1, Hyderabad 500072',
    walkinContact: 'HR Desk', walkinPhone: '9032321414',
    desc: 'Verification job - safe to delete.' });
  const reg = await TL.api.post('/jobs', { ...base, title: `Software Developer ${s}`, location: 'Hyderabad', mode: 'Hybrid',
    exp: '1-3 yrs', pay: '₹5-8 LPA', salaryMin: 5, salaryMax: 8, type: 'Full-time', education: 'B.Tech / M.Tech',
    requirements: ['JavaScript', 'REST APIs'], desc: 'Verification job - safe to delete.' });
  const thin = await TL.api.post('/jobs', { ...base, title: `Field Assistant ${s}`, location: 'Nellore', type: 'Full-time',
    desc: 'Verification job - safe to delete.' });
  for (const id of [walk.job.id, reg.job.id, thin.job.id]) {
    await TL.api.put(`/jobs/${id}/screening-questions`, { questions: [] }).catch(() => {});
  }
  await TL.api.post('/auth/logout', {});
  return { walk: walk.job.id, reg: reg.job.id, thin: thin.job.id };
}, { e: RECRUITER, pw: PW, s });
await setup.close();

async function page(ctxOpts = {}, init) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, ...ctxOpts });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: u.origin });
  /* WhatsApp is never contacted: the link the sheet opens is recorded and answered locally. */
  ctx.__wa = [];
  await ctx.route(/^https:\/\/(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)\//, (route) => {
    ctx.__wa.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>whatsapp stub</p>' });
  });
  if (init) await ctx.addInitScript(init);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  await p.goto(BASE + '#/');
  await p.waitForFunction(() => window.TL && TL.ready === true);
  await p.evaluate(async (s) => {
    await TL.api.post('/auth/register', { name: 'Share Tester', email: `share.${s}.${Math.random().toString(36).slice(2, 6)}@tl-verify.test`,
      password: `Shr${s}99x`, phone: '9' + String(Math.floor(1e8 + Math.random() * 9e8)), preferredLocation: 'Hyderabad',
      expectedCtc: 3, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'] });
  }, s);
  return { ctx, p, errors };
}
const openJob = async (p, id) => {
  await p.goto('about:blank');
  await p.goto(BASE + `?v=${Date.now()}#/job/${id}`);
  await p.waitForFunction(() => window.TL && TL.ready === true);
  await p.waitForTimeout(1800);
  await p.evaluate(() => document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((x) => x.click()));
};
const openSheet = async (p) => {
  await p.click('#app .tlpu-share');
  await p.waitForSelector('#tlpuOverlay .tlpu-sheet', { timeout: 5000 });
  return p.evaluate(() => document.querySelector('#tlpuOverlay .tlpu-sheet').innerText);
};
const viaWhatsApp = async (ctx, p) => {
  const before = ctx.__wa.length;
  const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }), p.click('#tlpuOverlay [data-ch="whatsapp"]')]);
  for (let i = 0; i < 40 && ctx.__wa.length === before; i++) await p.waitForTimeout(150);
  await popup.close().catch(() => {});
  return ctx.__wa[ctx.__wa.length - 1] || '';
};
const waText = (url) => {
  const raw = new URL(url).searchParams.get('text');
  return raw == null ? '' : raw;
};

console.log(`\nshare job  (${BASE})`);
const A = await page();

let walkUrl = '';
await check('1. walk-in job: preview with the Walk-in badge; the WhatsApp message carries the walk-in block and this job\'s link', async () => {
  await openJob(A.p, J.walk);
  const sheet = await openSheet(A.p);
  must(/Share this Job/.test(sheet) && /Walk-in Interview/.test(sheet) && sheet.includes(`HR Recruiter ${s}`), 'preview: ' + sheet.slice(0, 160));
  must(/TeamLink Consultants/.test(sheet), 'company missing in the preview');
  walkUrl = await viaWhatsApp(A.ctx, A.p);
  const t = waText(walkUrl);
  /* the job-opportunity format (owner, 2026-10-06), the walk-in block before the apply CTA */
  for (const l of ['*🚀 NEW JOB OPPORTUNITY – KPHB, Hyderabad*',
    'Hi! 👋 We found a job opportunity that could be a great match for your profile!', `🏥 *HR Recruiter ${s}*`,
    '🎓 Qualification: Any Degree', '💰 Salary: *₹3 LPA*', '📍 Location: *KPHB, Hyderabad*', "*⭐ What We're Looking For*",
    '*🚶 Walk-In Interview*', '📅 Walk-In Date: 10 October 2026', '⏰ Interview Time: 10:00 AM – 4:00 PM',
    '*👉 Interested? Explore the complete job details and apply now:*', "📩 Don't miss this opportunity — apply today!",
    '⚠️ Important: The job post copy must be shown at the main gate entrance.', '📍 Venue:',
    'TeamLink Consultants (OPC) Pvt. Ltd.', 'Plot 12, KPHB Phase 1, Hyderabad 500072', '📞 Contact: HR Desk – 9032321414', '✅ Telugu & English are Mandatory']) {
    must(lines(t).includes(l), `missing: ${l}`);
  }
  must(new RegExp(`^🔗 \\S+/job/${J.walk}\\?ref=[A-Za-z0-9_-]+$`, 'm').test(t), 'no link to this job');
  const tl = lines(t);
  must(tl.indexOf('*🚶 Walk-In Interview*') < tl.indexOf('*👉 Interested? Explore the complete job details and apply now:*'), 'the walk-in block is not before the apply CTA');
});

await check('4. WhatsApp: wa.me, the message encoded (emojis, ₹, &, line breaks survive)', async () => {
  must(/^https:\/\/(wa\.me|api\.whatsapp\.com)\//.test(walkUrl), walkUrl.slice(0, 80));
  const t = waText(walkUrl);
  must(t.includes('👋') && t.includes('₹') && t.includes('&') && t.includes('\n'), 'characters lost');
  must(!/%(?![0-9A-F]{2})/i.test(walkUrl), 'a broken escape');
});

await check('5. Copy Link copies only the link, which opens this very job; Copy Job Details copies the message', async () => {
  await A.p.evaluate(() => window.tlpuCloseSheet && tlpuCloseSheet());
  await openSheet(A.p);
  await A.p.click('#tlpuOverlay [data-ch="copy"]');
  await A.p.waitForTimeout(1200);
  const link = await A.p.evaluate(() => navigator.clipboard.readText());
  must(/^https?:\/\/\S+\/job\/[^\s?]+\?ref=[A-Za-z0-9_-]+$/.test(link), 'clipboard: ' + link.slice(0, 120));
  await A.p.click('#tlpuOverlay [data-ch="details"]');
  await A.p.waitForTimeout(1200);
  const details = await A.p.evaluate(() => navigator.clipboard.readText());
  must(details.startsWith('*🚀 NEW JOB OPPORTUNITY') && details.includes('*🚶 Walk-In Interview*') && details.includes('🔗 '), 'details: ' + details.slice(0, 80));
  /* a friend opens the link */
  const F = await b.newContext();
  const fp = await F.newPage();
  await fp.goto(link);
  await fp.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await fp.waitForTimeout(1500);
  const opened = await fp.evaluate(() => location.hash + ' | ' + (document.querySelector('#app').innerText || '').slice(0, 400));
  must(opened.includes(`#/job/${J.walk}`) && opened.includes(`HR Recruiter ${s}`), 'opened: ' + opened.slice(0, 120));
  await F.close();
});

await check('2. regular job: normal message, no walk-in lines, its own link', async () => {
  await openJob(A.p, J.reg);
  const sheet = await openSheet(A.p);
  must(!/Walk-in Interview/.test(sheet), 'walk-in badge on a regular job');
  const t = waText(await viaWhatsApp(A.ctx, A.p));
  for (const l of [`🏥 *Software Developer ${s}*`, '🎓 Qualification: B.Tech / M.Tech', '💼 Experience: *1-3 yrs*', '💰 Salary: *₹5-8 LPA*',
    '📍 Location: *Hyderabad*', '🕐 Job Type: Full-time', '🏠 Work From Home: Hybrid', '✅ JavaScript', '✅ REST APIs']) must(lines(t).includes(l), `missing: ${l}`);
  for (const w of ['Walk-In', 'Venue', 'main gate', 'Hard Copy', 'Please carry']) must(!t.includes(w), `"${w}" in a regular job's share`);
  must(t.includes(`/job/${J.reg}?ref=`), 'not this job\'s link');
});

await check('3. a job with empty fields: no undefined / null / NaN, the rows are simply left out', async () => {
  await openJob(A.p, J.thin);
  const sheet = await openSheet(A.p);
  must(!/undefined|null|NaN/.test(sheet), 'preview: ' + sheet);
  const t = waText(await viaWhatsApp(A.ctx, A.p));
  for (const w of ['undefined', 'null', 'NaN', 'Salary', 'Qualification']) must(!t.includes(w), `"${w}" in:\n${t}`);
  must(lines(t).includes(`🏥 *Field Assistant ${s}*`), 'title missing');
});

await check('privacy: nothing about the person sharing is in the message', async () => {
  const t = waText(walkUrl);
  for (const w of ['Share Tester', 'tl-verify.test', 'cand_', 'TL-CAN', 'stage', 'score']) must(!t.includes(w), `"${w}" in the share`);
});

await check('6. phone: the sheet fits with no sideways scroll; More uses the device share sheet', async () => {
  const M = await page({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    () => { window.__shared = null; navigator.share = (d) => { window.__shared = d; return Promise.resolve(); }; });
  await openJob(M.p, J.walk);
  await openSheet(M.p);
  must(await M.p.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, 'sideways scroll');
  const box = await M.p.evaluate(() => { const r = document.querySelector('#tlpuOverlay .tlpu-sheet').getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth }; });
  must(box.l >= 0 && box.r <= box.w, 'the sheet is wider than the screen');
  await M.p.waitForTimeout(800);
  await M.p.click('#tlpuOverlay [data-ch="native"]');
  await M.p.waitForTimeout(1200);
  const d = await M.p.evaluate(() => window.__shared);
  must(d && /\/job\//.test(d.url) && d.text.startsWith('*🚀 NEW JOB OPPORTUNITY') && !d.text.includes('🔗 '), 'share data: ' + JSON.stringify(d).slice(0, 160));
  must(!M.errors.length, M.errors.join(' | '));
  await M.ctx.close();
});

await check('no script errors on the way', async () => { must(!A.errors.length, A.errors.join(' | ')); });

await b.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
