/**
 * Give one candidate their portal login, and say honestly what happened.
 *
 *     node tools/send-credentials.mjs sravanthimangalapalli715@gmail.com
 *
 * If they have no account, one is created and the credentials are sent.
 * If they already have one, a NEW temporary password is issued - but
 * only when the message actually leaves. A reset that writes the new
 * password first and sends it second locks somebody out the moment a
 * provider is down: they lose the password they had and never receive
 * the one that replaced it. So nothing is committed until a message has
 * gone.
 *
 * Email, SMS and WhatsApp, the same three as everything else. The
 * password is never printed here, never logged, and never returned by
 * the API.
 *
 * Needs `npm run dev` on :4323.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';
const RECRUITER = process.env.TL_RECRUITER || 'recruiter@teamlink.com';

const who = process.argv.slice(2).join(' ').trim();
if (!who) {
  console.log('\n  usage: node tools/send-credentials.mjs <email or name>\n');
  process.exit(1);
}

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const api = async (m, p, b) => {
  const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
    .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })), [m, p, b]);
  if (r.ok) return r.v;
  throw new Error(`${r.c || 'FAILED'}: ${r.m || ''}`);
};

try {
  await api('post', '/auth/login', { email: RECRUITER, password: PASSWORD, role: 'recruiter' });

  const { candidates = [] } = await api('get',
    `/candidates?q=${encodeURIComponent(who)}&limit=25`);

  if (!candidates.length) {
    console.log(`\n  No candidate found for "${who}".\n`);
    process.exit(1);
  }
  if (candidates.length > 1) {
    console.log(`\n  "${who}" matches ${candidates.length} people:`);
    for (const c of candidates.slice(0, 10)) console.log(`    ${c.name} <${c.email}>`);
    console.log('\n  Give the full email address so there is no doubt which one.\n');
    process.exit(1);
  }

  const c = candidates[0];
  console.log(`\n  candidate   ${c.name} <${c.email}>`);
  console.log(`  account     ${c.hasPortalAccount ? 'already has one' : 'none yet'}`);

  const out = await api('post', `/candidates/${encodeURIComponent(c.id)}/invite`, {});

  console.log('');
  for (const ch of ['email', 'sms', 'whatsapp']) {
    console.log(`  ${ch.padEnd(10)}  ${out.delivery[ch] || '-'}`);
  }

  if (out.sent) {
    console.log(out.accountCreated
      ? '\n  ACCOUNT CREATED and the login was sent.'
      : out.passwordReplaced
        ? '\n  A NEW TEMPORARY PASSWORD was issued and sent. The previous one'
          + '\n  no longer works, and they will be asked to choose their own.'
        : '\n  SENT.');
    console.log('\n  Accepted is not delivered - the provider\'s own history is the'
      + '\n  record of what reached an inbox.\n');
  } else {
    console.log(`\n  NOTHING WAS SENT${out.reason ? ` - ${out.reason}` : ''}.`);
    if (c.hasPortalAccount) {
      console.log('\n  Their existing password is untouched, deliberately: issuing a new'
        + '\n  one that cannot be delivered would lock them out of an account that'
        + '\n  still works.');
    }
    console.log('\n  Run `npm run check:mail` - it says exactly what is missing.\n');
    process.exitCode = 1;
  }
} catch (err) {
  console.log(`\n  ${err.message}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
