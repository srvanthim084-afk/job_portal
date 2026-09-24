/**
 * A candidate applies for a role nobody posted, and the requirement is
 * created for them.
 *
 *     node tools/verify-requirement-from-application.mjs   (dev server on :4323)
 *
 * WHY. A job board tells us the role a candidate answered. Shine sent
 * seventeen responses for "Radiologist", "Duty Doctor", "Radiology" and
 * "OBGY", and this account had four requirements - none of them those -
 * so there was nothing to attach the applications to. Fifteen real
 * people with real CVs stopped in the intake queue behind the sentence
 * "no requirement matches Radiologist", which is true and useless.
 *
 * THE DANGEROUS PART IS PUBLISHING. A job with status 'open' is readable
 * by the public policy: it appears on the job board, to anybody, signed
 * in or not. Creating one automatically because somebody applied would
 * put a live advertisement on the site that no person approved. So the
 * requirement is created as a DRAFT - the recruiter sees it, applications
 * attach to it, and publishing stays a decision somebody makes.
 *
 * The second dangerous part is inventing rubbish. A requirement created
 * from a misread line ends up in the recruiter's list, their reports, and
 * the dropdown they map future candidates with. So this also checks that
 * nothing absurd has been created.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const api = async (m, p, b) => {
  const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
    .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })), [m, p, b]);
  if (r.ok) return r.v;
  throw new Error(`${r.c || 'FAILED'}: ${r.m || ''}`);
};

/* ---- what anybody can see, before signing in ---------------------- */
const publicJobs = (await api('get', '/jobs?limit=200')).jobs || [];
const publicTitles = publicJobs.map((j) => j.title);
check(publicJobs.every((j) => j.status === 'open'),
  `the public board shows only open roles (${publicJobs.length})`);

/* ---- the recruiter's own list, drafts included --------------------- */
await api('post', '/auth/login', {
  email: process.env.TL_RECRUITER || 'teamlinkmed001@tmlink.in',
  password: process.env.TL_RECRUITER_PASSWORD || 'Teamlink@2026',
  role: 'recruiter',
});
const all = (await api('get', '/jobs?view=all&limit=200')).jobs || [];
const drafts = all.filter((j) => j.status === 'draft');
check(all.length > publicJobs.length,
  `the recruiter sees more than the public board does (${all.length} vs ${publicJobs.length})`);
check(drafts.length > 0,
  `and at least one requirement was created from an application (${drafts.length})`);

console.log('\n  requirements created this way:');
for (const j of drafts) {
  console.log(`    ${String(j.title).padEnd(28)} ${String(j.status).padEnd(7)}`
    + ` published=${j.publishedAt || 'no'}`);
}

/*
 * A requirement that appeared by itself must say so on its own record.
 * A recruiter finding a draft "Radiologist" in their list tomorrow
 * should not have to work out who created it, or why, or what to do with
 * it - the description is where they will look.
 */
for (const j of drafts) {
  check(/created automatically because a candidate applied/i.test(String(j.desc || '')),
    `  "${j.title}" says on its own record where it came from`);
  check(/publish it when you are ready/i.test(String(j.desc || '')),
    `  and what is left for a person to decide`);
}

/* ---- none of them is on the public board -------------------------- */
for (const j of drafts) {
  check(!publicTitles.includes(j.title),
    `  "${j.title}" is NOT advertised publicly`);
  check(!j.publishedAt, `  and has never been published (${j.publishedAt || 'no date'})`);
}

/* ---- each one exists because somebody applied --------------------- */
const apps = (await api('get', '/applications?limit=500')).applications || [];
const byJob = {};
apps.forEach((a) => { byJob[a.jobId] = (byJob[a.jobId] || 0) + 1; });
for (const j of drafts) {
  check((byJob[j.id] || 0) > 0,
    `  "${j.title}" has ${byJob[j.id] || 0} application(s) attached to it`);
}

/* ---- one requirement per role, not one per candidate --------------- */
const seen = {};
const dupes = [];
for (const j of all) {
  const k = String(j.title).trim().toLowerCase();
  if (seen[k]) dupes.push(j.title); else seen[k] = 1;
}
check(dupes.length === 0,
  `no role has two requirements - a second applicant joins the first (${
    dupes.join(', ') || 'none duplicated'})`);

/* ---- nothing absurd was invented ----------------------------------- */
const NOT_A_ROLE = ['not mentioned', 'not specified', 'none', 'n/a', 'na',
  'other', 'others', 'various', 'multiple', 'any', 'unknown', 'blank',
  'job title blank'];
const bad = all.filter((j) => {
  const t = String(j.title || '').trim();
  if (!t || t.length < 2 || t.length > 80) return true;
  if (NOT_A_ROLE.includes(t.toLowerCase())) return true;
  if (/[@]|https?:\/\//i.test(t)) return true;
  if (t.split(/\s+/).length > 8) return true;
  if ((t.match(/[A-Za-z]/g) || []).length < 2) return true;
  return false;
});
check(bad.length === 0,
  `every requirement title is a job title (${bad.map((j) => JSON.stringify(j.title)).join(', ') || 'all of them'})`);

/* A leading article is the board's phrasing, not part of the job:
   "Hiring for an OBGY" must not become a requirement called "an OBGY". */
const articled = all.filter((j) => /^(an?|the)\s+/i.test(String(j.title || '')));
check(articled.length === 0,
  `no title begins with an article (${articled.map((j) => j.title).join(', ') || 'none does'})`);

/* ---- and the queue emptied of the ones it could place --------------- */
const queue = await api('get', '/intake/queue');
const stillWaiting = (queue.queue || []).filter((m) =>
  /no requirement matches/i.test(String(m.reason || '')));
check(stillWaiting.length === 0,
  `nothing is still parked for want of a requirement (${stillWaiting.length})`);

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
await browser.close();
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
