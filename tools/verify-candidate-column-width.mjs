/**
 * The recruiter's Applications table: a candidate whose title / company is a whole sentence (an
 * imported resume or email) must not stretch the pinned Candidate column over the other columns.
 *
 *   TL_URL=http://127.0.0.1:4461/ node tools/verify-candidate-column-width.mjs
 *
 * Injects one row with a very long title into the rendered table and measures the column at 1100 px.
 * Refuses :4323.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4461/').replace(/\/?$/, '/');
if (/:4323\//.test(BASE)) { console.error('Refusing to run against the live instance.'); process.exit(2); }
const REC = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';
const PW = process.env.TL_RECRUITER_PASSWORD || 'TeamLink@2026';

const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1100, height: 640 } })).newPage();
await p.goto(BASE + '#/'); await p.waitForFunction(() => window.TL && TL.ready === true);
await p.evaluate(async ({ e, pw }) => { await TL.api.post('/auth/login', { email: e, password: pw, role: 'recruiter' }); }, { e: REC, pw: PW });
await p.goto('about:blank'); await p.goto(BASE + '#/recruiter/applications');
await p.waitForFunction(() => window.TL && TL.ready === true && document.querySelector('.tl-apps-wrap table'));
await p.waitForTimeout(1500);

const m = await p.evaluate(() => {
  const t = document.querySelector('.tl-apps-wrap table');
  const long = 'Project Coordinator and Senior Operations Executive handling client onboarding, payroll, statutory compliance and vendor management across Hyderabad Bengaluru Chennai and Pune regions';
  const cell = personCell({ name: 'Asadhya sunka', title: long, currentCompany: 'Qure.ai Healthcare Technologies Private Limited and Associates', location: 'Hyderabad', exp: '1y 4m' });
  const n = t.querySelectorAll('thead th').length;
  t.querySelector('tbody').innerHTML = '<tr><td class="clickable">' + cell + '</td>' + Array.from({ length: n - 1 }, (_, i) => '<td>col' + i + '</td>').join('') + '</tr>';
  const th = t.querySelector('thead th');
  return { col: Math.round(th.getBoundingClientRect().width), wrap: Math.round(t.parentElement.getBoundingClientRect().width) };
});
const ok = m.col <= 400 && m.col < m.wrap;
console.log(`${ok ? 'PASS' : 'FAIL'}  the Candidate column stays readable with a very long title (${m.col}px in a ${m.wrap}px box)`);
await b.close();
process.exit(ok ? 0 : 1);
