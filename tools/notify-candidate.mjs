/**
 * Send one candidate the message for where they stand right now.
 *
 *     node tools/notify-candidate.mjs sravanthimangalapalli715@gmail.com
 *     node tools/notify-candidate.mjs "Mangalapalli Sravanthi"
 *
 * Finds that person's most recent application and sends the update for
 * its CURRENT stage through the ordinary notification path — the same
 * endpoint a recruiter's "Send update" uses, the same templates, the
 * same delivery log. Nothing is special-cased for one person.
 *
 * NOT a replay of old messages. If they applied and have not yet been
 * interviewed they get the invitation and its two-day deadline; if the
 * AI interview is done they get that instead. A three-day-old "your
 * interview is scheduled" is worse than silence once it has moved.
 *
 * Goes through the RUNNING server rather than opening its own database
 * connection: the embedded development engine serves one client at a
 * time, so a second connection is refused while the API holds it.
 *
 * Needs `npm run dev` on :4323.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';
const RECRUITER = process.env.TL_RECRUITER || 'recruiter@teamlink.com';

const who = process.argv.slice(2).join(' ').trim();
if (!who) {
  console.log('\n  usage: node tools/notify-candidate.mjs <email or name>\n');
  process.exit(1);
}

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const api = async (method, path, body) => {
  const r = await page.evaluate(([m, p, b]) =>
    window.TL.api[m](p, b).then(
      (ok) => ({ ok: true, value: ok }),
      (e) => ({ ok: false, code: e.code, message: e.message })),
    [method, path, body]);
  if (r.ok) return r.value;
  throw new Error(`${r.code || 'FAILED'}: ${r.message || ''}`);
};

try {
  await api('post', '/auth/login',
    { email: RECRUITER, password: PASSWORD, role: 'recruiter' });

  // Find the person first. Find Candidates searches name, title and
  // address, and RLS narrows it again underneath - no profile the
  // recruiter cannot already see is reachable here.
  const { candidates = [] } = await api('get',
    `/candidates?q=${encodeURIComponent(who)}&limit=25`);

  if (!candidates.length) {
    console.log(`\n  No candidate found for "${who}".`);
    console.log('  Check the spelling, or the address they registered with.\n');
    process.exit(1);
  }

  // Two people with similar names must never be resolved by a guess.
  if (candidates.length > 1) {
    console.log(`\n  "${who}" matches ${candidates.length} people:`);
    for (const c of candidates.slice(0, 10)) console.log(`    ${c.name} <${c.email}>`);
    console.log('\n  Give the full email address so there is no doubt which one.\n');
    process.exit(1);
  }

  const cand = candidates[0];
  const { applications = [] } = await api('get',
    `/applications?candidateId=${encodeURIComponent(cand.id)}&limit=100`);

  if (!applications.length) {
    console.log(`\n  ${cand.name} has not applied to anything, so there is no`);
    console.log('  stage to report. Nothing was sent.\n');
    process.exit(1);
  }

  // Most recently applied first.
  applications.sort((a, b) => String(b.appliedAt || '').localeCompare(String(a.appliedAt || '')));
  const app = applications[0];

  console.log(`\n  candidate ${cand.name} <${cand.email}>`);
  if (applications.length > 1) {
    console.log(`  note      ${applications.length} applications; the most recent was chosen`);
  }

  const out = await api('post', `/notifications/applications/${app.id}/send`);
  const status = (out.delivery_status || {}).email;

  console.log(`  about     ${out.jobTitle}  (${out.reference || app.id})`);
  console.log(`  stage     ${out.stageLabel}`);
  console.log(`\n  message   ${out.event}`);
  console.log(`  to        ${out.to}`);
  console.log(`  email     ${status}`);

  if (status === 'sent' || status === 'delivered') {
    console.log('\n  ACCEPTED by the provider. That is not the same as delivered —');
    console.log('  the provider\'s own history is the record of what reached an inbox.\n');
  } else {
    console.log('\n  NOT SENT. Run `npm run check:mail`, which says exactly what is');
    console.log('  missing rather than leaving it to the delivery log.\n');
    process.exitCode = 1;
  }
} catch (err) {
  console.log(`\n  ${err.message}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
