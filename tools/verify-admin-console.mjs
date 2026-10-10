/**
 * The Admin panel - seven modules, and Admin posting jobs - in a real browser.
 *
 *     TL_URL=http://127.0.0.1:4459 node tools/verify-admin-console.mjs   (LOAD_SEED=true: admin@ / recruiter@teamlink.com)
 *
 *  1 the sidebar is exactly Users, Recruiters & Teams, Jobs, Reports & Audit Log, Availability, Job Sources,
 *    Integrations (in that order), with the Admin profile and Exit at the bottom - nothing else
 *  2 every module opens; every page that used to have its own entry is a tab, at the same address, and works
 *  3 Admin posts a job with no recruiter (draft, publish), and manages it (edit, unpublish, close, reopen,
 *    duplicate, archive, restore); the sources come from the publishing service; "Posted By ... Admin"
 *  4 the audit log records Admin as the creator
 *  5 a recruiter still posts their own jobs; a recruiter cannot archive Admin's job; a candidate cannot post
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const PW = 'TeamLink@2026';
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };
const stamp = Date.now().toString(36);
const browser = await chromium.launch();

async function signedIn(email, role) {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 950 } })).newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e.message)));
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  if (email) {
    const r = await page.evaluate(async ({ e, r }) => { try { await TL.api.post('/auth/login', { email: e, password: 'TeamLink@2026', role: r }); await TL.refresh(); return 'ok'; } catch (x) { return x.message; } }, { e: email, r: role });
    check(r === 'ok', `${role} signs in (${r})`);
  }
  return page;
}
const go = async (page, hash) => { await page.evaluate((x) => { location.hash = x; }, hash); await page.waitForTimeout(900); };
const api = (page, m, p, b) => page.evaluate(async ({ m, p, b }) => { try { return { ok: true, body: await TL.api[m](p, b) }; } catch (e) { return { ok: false, status: e.status, message: e.message }; } }, { m, p, b });

/* ---- 1. the sidebar ----------------------------------------------------- */
const admin = await signedIn('admin@teamlink.com', 'admin');
await go(admin, '#/admin/users');
const side = await admin.evaluate(() => [...document.querySelectorAll('.dash-admin .sidebar a')].map((a) => a.querySelector('.lbl') ? a.querySelector('.lbl').textContent.trim() : a.textContent.trim()).filter(Boolean));
const modules = side.filter((t) => !/^Exit$/i.test(t));
check(JSON.stringify(modules) === JSON.stringify(['Users', 'Recruiters & Teams', 'Jobs', 'Reports & Audit Log', 'Availability', 'Job Sources', 'Integrations']),
  `the sidebar is exactly the seven, in order (${modules.join(' | ')})`);
check(await admin.evaluate(() => /Admin User|Admin/.test((document.querySelector('.dash-admin .sidebar') || {}).innerText || '') && !!document.querySelector('.dash-admin .sidebar [onclick*="doLogout"], .dash-admin .sidebar button')), 'the Admin profile and Exit stay at the bottom');

/* ---- 2. every module and every tab -------------------------------------------- */
const groups = await admin.evaluate(() => TLAdminConsole.groups.map((g) => ({ key: g.key, label: g.label, tabs: g.tabs })));
for (const g of groups) {
  for (const [key, label] of g.tabs) {
    await go(admin, '#/admin/' + key);
    const st = await admin.evaluate((k) => ({
      title: (document.querySelector('.dash-admin h1, .dash-admin .topbar h1, .dash-admin .page-title') || {}).textContent || '',
      active: (document.querySelector('.dash-admin .sidebar a.active .lbl') || {}).textContent || '',
      tabOn: (document.querySelector('.tlac-tab.on') || {}).textContent || '',
      body: ((document.querySelector('.dash-admin main, .dash-admin .main, .dash-admin .content') || document.body).innerText || '').length,
    }), key);
    check(st.active === g.label && (g.tabs.length < 2 || st.tabOn === label) && st.body > 80,
      `${g.label} › ${label} opens (#/admin/${key}; sidebar "${st.active}", tab "${st.tabOn}")`);
  }
}
check(admin.errors.length === 0, `no page errors on the module pages (${admin.errors.slice(0, 3).join(' | ')})`);

/* ---- 3. Admin posts a job --------------------------------------------------- */
await go(admin, '#/admin/jobs');
await admin.click('.tlac-jobbar button');
await admin.waitForSelector('#tlacModal, .tlac-card', { timeout: 10000 });
await admin.waitForFunction(() => !/Loading job sources/.test((document.querySelector('.tlac-card') || {}).innerText || ''), null, { timeout: 15000 });
const sources = await admin.evaluate(() => [...document.querySelectorAll('.tlac-dest')].map((l) => l.innerText.replace(/\s+/g, ' ').trim()));
check(sources.length >= 1 && sources.some((s) => /TeamLink/i.test(s)), `job sources come from the publishing service (${sources.join(' / ')})`);
check(await admin.evaluate(() => [...document.querySelectorAll('.tlac-dest input')].every((i) => !/Integration Required/.test(i.closest('label').innerText) || i.disabled)), 'a source that is not connected cannot be chosen');
/* publishing without the required fields is refused */
await admin.click('.tlac-ft .btn-primary');
check(/Job title is required/.test(await admin.innerText('.tlac-card')), 'required fields are checked');
const title = `Admin Posted Nurse ${stamp}`;
await admin.fill('#tlacF_title', title);
await admin.fill('#tlacF_location', 'Hyderabad');
await admin.fill('#tlacF_exp', '1-3 yrs');
await admin.fill('#tlacF_salaryMin', '3'); await admin.fill('#tlacF_salaryMax', '5');
await admin.fill('#tlacF_skills', 'Patient care, ICU, BLS, patient care');
await admin.fill('#tlacF_desc', 'Staff nurse for the ICU: patient monitoring, medication, charting and family communication across day and night shifts.');
await admin.click('.tlac-ft .btn-primary');
await admin.waitForFunction(() => /Saved and published/.test((document.querySelector('.tlac-card') || {}).innerText || ''), null, { timeout: 30000 });
const posted = await admin.evaluate((t) => (DATA.jobs || []).find((j) => j.title === t), title);
check(!!posted && posted.status === 'open', `Admin published a job with no recruiter (${posted && posted.status})`);
check(!!posted && posted.createdByRole === 'admin' && !posted.recruiterId, `it is recorded as posted by Admin (${posted && posted.createdByName} / ${posted && posted.createdByRole})`);
check(!!posted && JSON.stringify(posted.skills) === JSON.stringify(['Patient care', 'ICU', 'BLS']), 'skills de-duplicated');
check(/Publishing status/i.test(await admin.innerText('.tlac-card')), 'the publishing status per source is shown');

/* manage it */
const state = async () => (await admin.evaluate((id) => { const j = DATA.jobById(id); return j ? { status: j.status, archived: !!j.archived } : null; }, posted.id));
const click = async (label) => {
  await admin.evaluate((l) => { const b = [...document.querySelectorAll('.tlac-acts button')].find((x) => x.textContent.trim() === l); if (b) b.click(); }, label);
  await admin.waitForTimeout(1800);
};
await click('Unpublish'); check((await state()).status === 'draft', 'Unpublish -> draft');
await click('Publish'); check((await state()).status === 'open', 'Publish -> published');
await click('Close'); check((await state()).status === 'closed', 'Close -> closed');
await click('Reopen'); check((await state()).status === 'open', 'Reopen -> published');
await click('Archive'); check((await state()).archived === true, 'Archive');
await click('Restore'); check((await state()).archived === false, 'Restore');
/* edit */
await admin.fill('#tlacF_location', 'Bengaluru');
await admin.click('.tlac-ft .btn-ghost:nth-of-type(2)');
await admin.waitForTimeout(1800);
check(await admin.evaluate((id) => DATA.jobById(id).location === 'Bengaluru', posted.id), 'Edit -> saved');
/* duplicate -> a new draft */
await click('Duplicate');
check(/\(copy\)/.test(await admin.inputValue('#tlacF_title')), 'Duplicate opens a copy');
await admin.click('.tlac-ft .btn-ghost:nth-of-type(2)');
await admin.waitForFunction(() => /Saved as a draft/.test((document.querySelector('.tlac-card') || {}).innerText || ''), null, { timeout: 20000 });
check(await admin.evaluate((t) => (DATA.jobs || []).some((j) => j.title === t + ' (copy)' && j.status === 'draft'), title), 'the copy is a separate draft');
await admin.click('.tlac-x');
/* the list says Posted By ... Admin, with Manage */
await go(admin, '#/admin/jobs');
await admin.waitForTimeout(800);
const row = await admin.evaluate((t) => { const tr = [...document.querySelectorAll('.dash-admin table.data tbody tr')].find((r) => r.innerText.includes(t)); return tr ? tr.innerText.replace(/\s+/g, ' ') : ''; }, title);
check(/Admin/.test(row) && /Manage/.test(row), `the Jobs list: Posted By with the Admin tag, and Manage (${row.slice(0, 120)})`);

/* ---- 4. the audit log ----------------------------------------------------------- */
const audit = await api(admin, 'get', '/admin/audit-log?pageSize=50');
const created = audit.ok ? (audit.body.rows || []).find((r) => r.action === 'job.created' && r.entityId === posted.id) : null;
check(!!created && created.role === 'admin', `the audit log: job.created by the admin (${created && created.user})`);

/* ---- 5. permissions -------------------------------------------------------------- */
const rec = await signedIn('recruiter@teamlink.com', 'recruiter');
const recJob = await api(rec, 'post', '/jobs', { title: `Recruiter Job ${stamp}`, companyId: posted.companyId, location: 'Pune', status: 'draft' });
check(recJob.ok, `a recruiter still posts their own jobs (${recJob.ok ? 'ok' : recJob.message})`);
const recArch = await api(rec, 'post', `/jobs/${posted.id}/archive`, { archived: true });
check(!recArch.ok && (recArch.status === 403 || recArch.status === 404), `a recruiter cannot archive Admin's job (${recArch.status})`);
await go(rec, '#/recruiter/home');
check(await rec.evaluate(() => !document.querySelector('.tlac-tabs') && !document.querySelector('.tlac-jobbar')), 'the recruiter pages are unchanged (no admin tabs)');
const anon = await signedIn(null, null);
const anonPost = await api(anon, 'post', '/jobs', { title: 'Nope', companyId: posted.companyId, location: 'X' });
check(!anonPost.ok && (anonPost.status === 401 || anonPost.status === 403), `signed out: cannot post (${anonPost.status})`);
const anonArch = await api(anon, 'post', `/jobs/${posted.id}/archive`, { archived: true });
check(!anonArch.ok && (anonArch.status === 401 || anonArch.status === 403), `signed out: cannot archive (${anonArch.status})`);
check(admin.errors.length === 0, `no page errors (${admin.errors.slice(0, 3).join(' | ')})`);

await browser.close();
console.log(fail.length ? `\n${fail.length} FAILED:\n - ${fail.join('\n - ')}` : '\nall passed');
process.exit(fail.length ? 1 : 0);
