/**
 * "Post A Walk-in Job" (the modal, Save & Post): the job is SAVED on the server with its address, and a
 * candidate can see it.
 *
 *   TL_URL=http://127.0.0.1:4491/ node tools/verify-walkin-modal-post.mjs
 *
 * WHAT WAS WRONG. The modal's walk-in details (address, map, documents, instructions, capacity) were attached to
 * the job only after it had been pushed - and the push is what saves it. The server requires an address for a
 * walk-in, so the first save was refused, the page still said "Walk-in job published", and no candidate ever
 * saw the job. Creates one job, so it refuses :4323.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4491/').replace(/\/?$/, '/');
if (/:4323\//.test(BASE)) { console.error('Refusing to run against the live instance.'); process.exit(2); }
const EMAIL = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';
const PW = process.env.TL_RECRUITER_PASSWORD || 'TeamLink@2026';
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const posts = [];
p.on('response', async (r) => {
  if (/\/api\/jobs$/.test(r.url()) && r.request().method() === 'POST') { let t = ''; try { t = await r.text(); } catch (e) { /* gone */ } posts.push({ status: r.status(), body: t, req: r.request().postData() || '' }); }
});
await p.goto(BASE + '#/'); await p.waitForFunction(() => window.TL && TL.ready === true);
const login = await p.evaluate(async ([e, pw]) => { try { await TL.api.post('/auth/login', { email: e, password: pw, role: 'recruiter' }); return 'ok'; } catch (x) { return x.message; } }, [EMAIL, PW]);
check(login === 'ok', `recruiter signs in (${login})`);
await p.goto('about:blank'); await p.goto(BASE + '#/recruiter/jobs'); await p.waitForFunction(() => window.TL && TL.ready === true); await p.waitForTimeout(1500);
await p.evaluate(() => window.tnavWalkinModal());
await p.waitForSelector('#twTitle');
const title = 'Walk-in modal check ' + Date.now().toString(36);
const set = (id, v) => p.evaluate(([i, val]) => { const e = document.getElementById(i); e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, [id, v]);
const date = new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10);
for (const [id, v] of [['twTitle', title], ['twLoc', 'Hyderabad'], ['twDate', date], ['twFrom', '10:00'], ['twTo', '16:00'], ['twVenue', 'TeamLink Office, Madhapur'],
  ['tlwkTAddress', 'Plot 12, Madhapur, Hyderabad 500081'], ['tlwkTCap', '40'], ['tlwkTDocs', 'Resume\nID proof'], ['tlwkTInstr', 'Report at the front desk'],
  ['twExp', '0-2 yrs'], ['twQual', 'Any degree'], ['twPay', '3 LPA'], ['twContact', 'HR Team'], ['twPhone', '9876543210'], ['twSkills', 'Sales, Communication'],
  ['twGender', 'Male'], ['twAccom', 'no']]) await set(id, v);
await p.getByRole('button', { name: /Save & Post/i }).first().click();
await p.waitForFunction(() => !document.getElementById('twTitle'), null, { timeout: 15000 }).catch(() => {});
await p.waitForTimeout(3000);

check(posts.length === 1, `the job was sent to the server once (${posts.length})`);
check(posts[0] && posts[0].status === 201, `the server accepted it (${posts[0] && posts[0].status} ${posts[0] && posts[0].status !== 201 ? posts[0].body.slice(0, 120) : ''})`);
check(posts[0] && /"walkinAddress":"Plot 12, Madhapur, Hyderabad 500081"/.test(posts[0].req), 'the address, venue and capacity went with the first save');
check(posts[0] && /"walkinCapacity":40/.test(posts[0].req), 'the capacity went with it');

const mine = await p.evaluate(async (t) => { const r = await TL.api.get('/jobs?limit=200'); return (r.jobs || []).filter((j) => j.title === t).map((j) => ({ status: j.status, addr: j.walkinAddress })); }, title);
check(mine.length === 1 && mine[0].status === 'open' && /Madhapur/.test(mine[0].addr || ''), `the recruiter sees it, open, with its address (${JSON.stringify(mine)})`);

const anon = await (await b.newContext()).newPage();
await anon.goto(BASE + '#/'); await anon.waitForFunction(() => window.TL && TL.ready === true);
const seen = await anon.evaluate(async (t) => { const r = await TL.api.get('/jobs?limit=200'); return (r.jobs || []).filter((j) => j.title === t).length; }, title);
check(seen === 1, `a candidate (signed out) can see the walk-in job in the portal (${seen})`);

await b.close();
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
