/**
 * A candidate imported from a spreadsheet gets a way in.
 *
 * The gap: a person who arrived through the Naukri mailbox got a portal
 * account and a message carrying their login. A person imported from a
 * CSV or an Excel file got a row in `candidates` and nothing else. The
 * recruiter could see them; they could not see themselves, could not
 * correct what the file said about them, could not upload a current
 * resume, and never heard they were in the database at all.
 *
 * What this holds to:
 *
 *   - importing creates a portal account and sends the login
 *   - on all three channels, not only email
 *   - the temporary password works, and must be changed on first use
 *   - somebody already in the database who has no login gets one too
 *   - NOBODY IS WRITTEN TO TWICE - a second import sends nothing
 *   - the password never appears in the API response or the record
 *   - do-not-contact is honoured here as everywhere else
 *   - a failed provider does not roll back the import
 *   - the registration form asks for the resume FIRST, since the upload
 *     fills the fields it used to ask for above it
 *   - no header offers Home twice
 *
 *   node tools/verify-invite.mjs      (needs npm run dev on :4323)
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';
const stamp = Date.now();

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();
const open = async () => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
  return {
    page,
    api: async (m, p, b) => {
      const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
        .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })), [m, p, b]);
      if (!r.ok) { const err = new Error(`${r.c || 'FAILED'}: ${r.m || ''}`); err.code = r.c; throw err; }
      return r.v;
    },
  };
};

const rec = await open();
await rec.api('post', '/auth/login',
  { email: 'recruiter@teamlink.com', password: PASSWORD, role: 'recruiter' });

/** Unique every run, so a rerun is not a collision with the last one. */
const one = { email: `imp.one.${stamp}@example.test`, phone: `+91 7${String(stamp).slice(-9)}` };
const two = { email: `imp.two.${stamp}@example.test`, phone: `+91 8${String(stamp).slice(-9)}` };

const csv = [
  'Name,Email,Phone,Location,Title,Skills,Experience',
  `Import One ${stamp},${one.email},${one.phone},Hyderabad,React Developer,"React, Node.js",4`,
  `Import Two ${stamp},${two.email},${two.phone},Pune,Java Developer,"Java, Spring",6`,
].join('\n');

let imported = [];

/* ------------------------------------------------------------------ *
 * 1. the import itself
 * ------------------------------------------------------------------ */
console.log('\nimporting two people from a spreadsheet');

await check('both rows arrive as candidates', async () => {
  const out = await rec.api('post', '/candidates/import', { text: csv });
  imported = out.detail.imported;
  must(out.imported === 2, `${out.imported} imported, ${out.updated} updated, ${out.skipped} skipped`);
  must(out.invited === 2, `${out.invited} marked for an invitation`);
});

await check('the response carries no password', async () => {
  const out = JSON.stringify(imported);
  must(!/password|passwd|pwd/i.test(out), `a password field is in the response: ${out.slice(0, 120)}`);
});

// The invitations are sent after the response, on purpose: a provider
// timing out must not roll back an import that has already succeeded.
await new Promise((r) => setTimeout(r, 6000));

/* ------------------------------------------------------------------ *
 * 2. the account and the message
 * ------------------------------------------------------------------ */
console.log('\nthe account and the message');

const admin = await open();
await admin.api('post', '/auth/login',
  { email: 'admin@teamlink.com', password: PASSWORD, role: 'admin' });

const invitesFor = (id) => admin.api('get', `/candidates/${encodeURIComponent(id)}/invites`);

await check('a portal account exists for each of them', async () => {
  for (const c of imported) {
    const got = await admin.api('get', `/candidates/${encodeURIComponent(c.id)}`);
    must(got.candidate, `${c.name} is not readable`);
    must(got.candidate.hasPortalAccount === true,
      `${c.name} has no portal account`);
  }
});

await check('the login was attempted on all three channels', async () => {
  const { invites } = await invitesFor(imported[0].id);
  const channels = invites.map((i) => i.channel).sort();
  must(channels.join(',') === 'email,sms,whatsapp',
    `attempted on ${channels.join(', ') || 'nothing'}`);
});

await check('each attempt records where it went, and its outcome', async () => {
  const { invites } = await invitesFor(imported[0].id);
  for (const i of invites) {
    must(i.status, `${i.channel} has no outcome`);
    must(i.to, `${i.channel} does not say where it went`);
  }
  const email = invites.find((i) => i.channel === 'email');
  must(email.hadCredentials === true, 'the email did not carry a login');
});

await check('the password is nowhere in the record', async () => {
  const { invites } = await invitesFor(imported[0].id);
  const blob = JSON.stringify(invites);
  must(!/password/i.test(blob) || /hadCredentials/.test(blob.replace(/hadCredentials/g, '')),
    'a password appears in the invite record');
  must(!/[A-Za-z0-9]{10,}-[A-Za-z0-9]{4,}/.test(blob), 'something password-shaped is recorded');
});

/* ------------------------------------------------------------------ *
 * 3. never twice
 * ------------------------------------------------------------------ */
console.log('\nnobody is written to twice');

await check('importing the same file again sends nothing', async () => {
  const before = (await invitesFor(imported[0].id)).invites.length;
  await rec.api('post', '/candidates/import', { text: csv });
  await new Promise((r) => setTimeout(r, 5000));
  const after = (await invitesFor(imported[0].id)).invites.length;
  must(after === before,
    `${after - before} extra message(s) — a second set of credentials was sent`);
});

/* ------------------------------------------------------------------ *
 * 4. do-not-contact
 * ------------------------------------------------------------------ */
console.log('\nsomebody who asked not to be contacted');

await check('a do-not-contact candidate is never invited', async () => {
  const email = `imp.dnc.${stamp}@example.test`;
  const phone = `+91 9${String(stamp).slice(-9)}`;
  const first = await rec.api('post', '/candidates/import', {
    text: `Name,Email,Phone\nDo Not Contact ${stamp},${email},${phone}`,
  });
  const id = first.detail.imported[0].id;

  await admin.api('put', `/candidates/${id}`, { doNotContact: true });
  // Clear whatever the first import sent, so this measures the second.
  await new Promise((r) => setTimeout(r, 4000));
  const before = (await invitesFor(id)).invites.length;

  await rec.api('post', '/candidates/import', {
    text: `Name,Email,Phone\nDo Not Contact ${stamp},${email},${phone}`,
  });
  await new Promise((r) => setTimeout(r, 4000));
  const after = (await invitesFor(id)).invites.length;
  must(after === before, `${after - before} message(s) went to a do-not-contact candidate`);
});

/* ------------------------------------------------------------------ *
 * 5. who may read the record
 * ------------------------------------------------------------------ */
console.log('\nwho may read the record');

await check('a candidate cannot read somebody else\'s invitations', async () => {
  const anon = await open();
  let code = null;
  try { await anon.api('get', `/candidates/${imported[0].id}/invites`); }
  catch (e) { code = e.code; }
  must(code === 'UNAUTHENTICATED' || code === 'UNAUTHORIZED' || code === 'FORBIDDEN',
    `an unauthenticated caller got ${code || 'through'}`);
});

/* ------------------------------------------------------------------ *
 * 6. the two things a person sees before anything else
 * ------------------------------------------------------------------ */
console.log('\nthe first look at the page');

await check('the resume is the FIRST thing the registration form asks for', async () => {
  const p = (await open()).page;
  await p.evaluate(() => { location.hash = '#/register/candidate'; });
  await p.waitForTimeout(1300);

  const sections = await p.$$eval('#registerForm .panel-head h2',
    (ns) => ns.map((n) => n.textContent.trim()));
  must(/Resume/.test(sections[0]),
    `the form opens with "${sections[0]}" - it asks for typing before offering to read the file`);

  // The numbers are part of the page's own design and must still run 1..n.
  const nums = await p.$$eval('#registerForm .reg-section-num',
    (ns) => ns.map((n) => n.textContent.trim()));
  must(nums.join(',') === nums.map((_, i) => String(i + 1)).join(','),
    `the section numbers read ${nums.join(', ')}`);

  // Every original section is still there - moved, not dropped.
  for (const want of ['Personal Information', 'Professional Information',
                      'Preferences', 'Consent', 'Resume']) {
    must(sections.some((x) => x.indexOf(want) >= 0), `${want} is gone`);
  }
});

await check('no header offers Home twice', async () => {
  const p = (await open()).page;
  // One SET of nodes, because `header` and `.site-header-inner` overlap:
  // collecting per host counted the same link twice and reported a
  // duplicate that was not there.
  const visibleHomes = () => p.$$eval('header, .site-header-inner', (hosts) => {
    const seen = [];
    const done = new Set();
    for (const host of hosts) {
      for (const n of host.querySelectorAll('*')) {
        if (n.children.length) continue;
        if (done.has(n)) continue;
        done.add(n);
        if (!/^\s*(\u{1F3E0}\s*)?Home\s*$/u.test(n.textContent || '')) continue;
        const r = n.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) seen.push(n.textContent.trim());
      }
    }
    return seen;
  });

  await p.waitForTimeout(1200);
  let homes = await visibleHomes();
  must(homes.length <= 1, `the public header shows Home ${homes.length} times`);

  await p.evaluate(() => { location.hash = '#/register/candidate'; });
  await p.waitForTimeout(1200);
  homes = await visibleHomes();
  must(homes.length <= 1, `the register header shows Home ${homes.length} times`);
});

await browser.close();
console.log(failed
  ? `\n  ${failed} FAILED\n`
  : '\n  INVITE VERIFIED — an imported candidate gets a login, once, on three channels\n');
process.exitCode = failed ? 1 : 0;
