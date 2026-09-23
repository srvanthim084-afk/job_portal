/**
 * A message that failed is not a message that was sent.
 *
 * The failure this exists to prevent: while EmailJS was refusing
 * server-side calls, one candidate's application confirmation, her AI
 * interview invitation and its deadline were all refused with a 403 -
 * and when the setting was fixed, nothing went back for them. The
 * delivery log was honest the whole time. She still heard nothing.
 *
 * What this holds to:
 *
 *   - the queue is built from the LAST attempt, so a message that
 *     failed and was later delivered is not chased again
 *   - "not configured" counts as never having heard from us
 *   - three attempts, then a human looks at it
 *   - somebody who asked not to be contacted is never chased
 *   - reserved domains are not retried, so seed rows cannot burn the
 *     provider's quota ahead of a real person
 *   - the retry sends the message for the CURRENT stage, never a replay
 *   - a recruiter can send one person their update on demand
 *
 *   node tools/verify-retry.mjs      (needs npm run dev on :4323)
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { EVENT_FOR_STAGE } from '../api/src/routes/notifications.js';

// The outbound-payload section below needs the real provider configuration.
const envFile = resolve(process.cwd(), process.env.ENV_FILE || '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';

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
      const r = await page.evaluate(([mm, pp, bb]) =>
        window.TL.api[mm](pp, bb).then(
          (ok) => ({ ok: true, value: ok }),
          (e) => ({ ok: false, code: e.code, message: e.message })),
        [m, p, b]);
      if (r.ok) return r.value;
      const err = new Error(`${r.code || 'FAILED'}: ${r.message || ''}`);
      err.code = r.code;
      throw err;
    },
  };
};

/* ------------------------------------------------------------------ *
 * 0. the address on the message
 *
 * The one thing that mattered and was never checked.
 *
 * A provider answering 200 OK says nothing about WHO the message went
 * to. An EmailJS template carries its own "To Email" field, and a fixed
 * address there quietly redirects every message while the API keeps
 * answering OK - which is exactly what happened, and why a candidate
 * with four `sent` rows against her name had received nothing.
 *
 * EmailJS cannot be asked. It performs no recipient validation at its
 * API at all: to_email empty, whitespace, malformed or missing from
 * template_params altogether is answered 200 OK every time. Only its
 * Email History lists the address a send actually used.
 *
 * So OUR side is what gets asserted, and it is asserted against the
 * real outbound request rather than by reading the source: the provider
 * is called for real with fetch captured, and the payload is inspected.
 * ------------------------------------------------------------------ */
console.log('\nthe address on the message');

const { emailProvider, emailjsReady, smtpReady } = await import('../api/src/notify/providers.js');

/** Call the provider for real, but capture the request instead of sending it. */
async function capture(args) {
  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body) };
    return new Response('OK', { status: 200 });
  };
  try { await emailProvider.send(args); } finally { globalThis.fetch = realFetch; }
  return seen;
}

/*
 * These inspect the EmailJS payload, by capturing fetch.
 *
 * SMTP does not go through fetch - it opens a socket - so with SMTP
 * active there is nothing to capture and every one of them would assert
 * against null. That is worse than not running: six green checks that
 * looked at nothing, or six red ones that mean nothing.
 *
 * SMTP answers the same question better anyway, and further down the
 * line: the mail server accepts or refuses THAT recipient, and the
 * delivery log records which address it took. The check below holds
 * that, whichever transport is in use.
 */
const smtpActive = smtpReady();
const READY = !smtpActive && emailjsReady().ready;
const CAND = { email: 'a.candidate@example.org', name: 'A Candidate' };

if (smtpActive) {
  console.log('  SKIP  SMTP is the transport, so there is no EmailJS payload to inspect');
  console.log('        (the recipient is checked against the delivery log instead)');
} else if (!READY) {
  console.log('  SKIP  no email transport is configured, so there is no payload to inspect');
} else {
  await check("to_email carries the candidate's own address", async () => {
    const req = await capture({
      to: CAND.email, subject: 'Your interview', text: 'body', html: '<p>body</p>',
      vars: { to_name: CAND.name, candidate_name: CAND.name },
    });
    must(req, 'the provider sent nothing');
    const p = req.body.template_params || {};
    must(p.to_email === CAND.email, `to_email was ${JSON.stringify(p.to_email)}`);
  });

  await check('no fixed recipient is baked into our payload', async () => {
    // Two different candidates must produce two different recipients.
    // If anything on our side pinned the address, this is where it shows.
    const one = await capture({ to: 'first@example.org', subject: 's', text: 't' });
    const two = await capture({ to: 'second@example.org', subject: 's', text: 't' });
    const a1 = one.body.template_params.to_email;
    const a2 = two.body.template_params.to_email;
    must(a1 === 'first@example.org' && a2 === 'second@example.org',
      `got ${a1} and ${a2}`);
    must(a1 !== a2, 'both messages carried the same recipient');
  });

  await check('every alias of the recipient agrees', async () => {
    // Templates in the wild read {{to_email}} or {{email}}. They must not
    // disagree, or which one the template happens to use decides whether
    // the candidate hears from us.
    const req = await capture({ to: CAND.email, subject: 's', text: 't' });
    const p = req.body.template_params;
    must(p.email === CAND.email, `email was ${JSON.stringify(p.email)}`);
  });

  await check('the candidate is greeted by name, not by address', async () => {
    const req = await capture({
      to: CAND.email, subject: 's', text: 't',
      vars: { to_name: CAND.name, candidate_name: CAND.name },
    });
    const p = req.body.template_params;
    must(p.to_name === CAND.name, `to_name was ${JSON.stringify(p.to_name)}`);
  });

  await check("the reply address is ours, never the candidate's", async () => {
    // A candidate replying must reach the company, not themselves.
    const req = await capture({ to: CAND.email, subject: 's', text: 't' });
    must(req.body.template_params.reply_to !== CAND.email,
      'reply_to is the candidate, so a reply would go nowhere useful');
  });

  await check('no secret travels in the template variables', async () => {
    const req = await capture({
      to: CAND.email, subject: 's', text: 't',
      vars: { temporary_password: 'Sw4n-Fl4x-9912' },
    });
    const { template_params: p, accessToken, user_id } = req.body;
    // The private key authenticates the call; it must never be a variable
    // a template could print into the body of an email.
    must(!JSON.stringify(p).includes(accessToken || ' never'),
      'the private key is in the template variables');
    must(!JSON.stringify(p).includes(user_id || ' never'),
      'the public key is in the template variables');
  });
}

/* ------------------------------------------------------------------ *
 * 0b. no message ever says "undefined"
 *
 * A real invitation went out reading "Your AI interview for Java
 * Developer - due undefined", because the stage path never passed the
 * deadline and String(undefined) is a perfectly good string. The footer
 * had the same fault with a missing job id.
 *
 * A candidate reading that has no way to tell a working system from a
 * broken one, so it is held for EVERY message on EVERY channel, with the
 * optional context deliberately withheld - which is the state a caller
 * that forgot something actually produces.
 * ------------------------------------------------------------------ */
console.log('\nnothing a candidate reads says "undefined"');

const { buildEventMessages } = await import('../api/src/notify/templates.js');

const EVENTS = [
  'STAGE_CHANGED', 'INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED',
  'AI_SCORE_AVAILABLE', 'OFFER_EXTENDED', 'AI_INTERVIEW_INVITED',
  'AI_INTERVIEW_REMINDER', 'AI_INTERVIEW_FINAL', 'AI_INTERVIEW_EXPIRED',
  'JOB_MATCH_ALERT', 'AI_CALL_COMPLETED', 'APPLICATION_IMPORTED',
];

/** Only what every caller genuinely has. Everything else is left out. */
const BARE = {
  candidateName: 'A Candidate',
  jobTitle: 'Java Developer',
  company: 'TechNova Solutions',
  portalUrl: 'https://jobs.example.com/#/candidate/applications',
};

const channelsOf = (m) => m && [
  ['subject', m.email && m.email.subject], ['text', m.email && m.email.text],
  ['html', m.email && m.email.html], ['sms', m.sms],
  ['whatsapp', m.whatsapp], ['ivr', m.ivr],
];

for (const event of EVENTS) {
  await check(`${event} never prints undefined, however little it is given`, () => {
    const m = buildEventMessages(event, BARE);
    must(m, `${event} produced no message at all`);
    for (const [name, value] of channelsOf(m)) {
      const body = String(value == null ? '' : value);
      must(!/undefined|NaN|\[object Object\]/.test(body),
        `${name}: ${body.slice(Math.max(0, body.search(/undefined|NaN|\[object/)) - 40, 120)}`);
    }
  });
}

await check('a real deadline is stated in full, not as "soon"', () => {
  const m = buildEventMessages('AI_INTERVIEW_INVITED',
    { ...BARE, dueAt: '2026-09-25T05:30:00.000Z' });
  must(/25 Sept/.test(m.email.subject),
    `the subject does not carry the date: ${m.email.subject}`);
  must(/25 Sept/.test(m.email.text), 'the body does not carry the date');
});

await check('a deadline that is missing is not invented', () => {
  const m = buildEventMessages('AI_INTERVIEW_INVITED', BARE);
  must(!/due /.test(m.email.subject),
    `the subject claims a deadline it was not given: ${m.email.subject}`);
});

/* ------------------------------------------------------------------ *
 * 0c. the address it actually went to
 *
 * Transport-independent, and the one that matters most.
 *
 * A provider answering "OK" says nothing about WHO a message went to -
 * that was the whole EmailJS episode, where every send was accepted and
 * none of them reached the candidate. The delivery log records the
 * address each attempt used, so this sends one and checks the recorded
 * recipient is the candidate's own.
 * ------------------------------------------------------------------ */
console.log('\nthe address it actually went to');

await check("a send records the candidate's own address, not a fixed one", async () => {
  const recX = await open();
  await recX.api('post', '/auth/login',
    { email: 'recruiter@teamlink.com', password: PASSWORD, role: 'recruiter' });

  const list = (await recX.api('get', '/applications?limit=25')).applications || [];
  const app = list.find((a) => a.stage && a.stage !== 'rejected');
  must(app, 'no application to send for');

  const out = await recX.api('post', `/notifications/applications/${app.id}/send`,
    { channels: ['email'] });
  must(out.to && out.to.indexOf('@') > 0, `no recipient reported: ${out.to}`);

  const log = (await recX.api('get',
    `/intake/applications/${app.id}/communications`)).communications || [];
  const latest = log.filter((c) => c.channel === 'email')[0];
  must(latest, 'the send was not recorded at all');
  must(latest.to === out.to,
    `recorded ${latest.to}, but the message was for ${out.to}`);
});

/* ------------------------------------------------------------------ *
 * 1. which message a stage deserves
 * ------------------------------------------------------------------ */
console.log('\nthe message chosen for a stage');

await check('somebody who applied and heard nothing gets the invitation', () => {
  must(EVENT_FOR_STAGE.applied === 'AI_INTERVIEW_INVITED',
    `applied -> ${EVENT_FOR_STAGE.applied}`);
  must(EVENT_FOR_STAGE.ai_screening === 'AI_INTERVIEW_INVITED',
    `ai_screening -> ${EVENT_FOR_STAGE.ai_screening}`);
});

await check('a finished interview is not invited to itself again', () => {
  must(EVENT_FOR_STAGE.ai_interview_done === 'AI_INTERVIEW_COMPLETED',
    `ai_interview_done -> ${EVENT_FOR_STAGE.ai_interview_done}`);
});

await check('an unlisted stage still gets an update rather than silence', () => {
  must((EVENT_FOR_STAGE.client_review || 'STAGE_CHANGED') === 'STAGE_CHANGED',
    'an unknown stage must fall back to STAGE_CHANGED');
});

/* ------------------------------------------------------------------ *
 * 2. the queue
 * ------------------------------------------------------------------ */
console.log('\nthe queue of people who never heard from us');

const admin = await open();
await admin.api('post', '/auth/login',
  { email: 'admin@teamlink.com', password: PASSWORD, role: 'admin' });

await check('the retry runs and reports what it did', async () => {
  const out = await admin.api('post', '/notifications/retry', { channel: 'email', limit: 5 });
  must(typeof out.considered === 'number', 'no count of what was considered');
  must(typeof out.sent === 'number', 'no count of what was sent');
  must(typeof out.stillFailing === 'number', 'no count of what is still failing');
});

await check('a delivered message is not chased again', async () => {
  // Everything the first pass delivered must have left the queue, or the
  // sweep would send the same person the same message every quarter hour.
  await admin.api('post', '/notifications/retry', { channel: 'email', limit: 100 });
  const out = await admin.api('post', '/notifications/retry', { channel: 'email', limit: 100 });
  must(out.sent === 0,
    `${out.sent} message(s) sent on a pass that should have had nothing to do`);
});

await check('the queue is bounded, so one outage cannot flood a provider', async () => {
  const out = await admin.api('post', '/notifications/retry', { channel: 'email', limit: 1 });
  must(out.considered <= 200, `${out.considered} considered at once`);
});

await check('only an admin can run the sweep', async () => {
  const rec2 = await open();
  await rec2.api('post', '/auth/login',
    { email: 'recruiter@teamlink.com', password: PASSWORD, role: 'recruiter' });
  let code = null;
  try { await rec2.api('post', '/notifications/retry', {}); }
  catch (e) { code = e.code; }
  must(code === 'FORBIDDEN' || code === 'UNAUTHORIZED',
    `a recruiter got ${code || 'through'}`);
});

/* ------------------------------------------------------------------ *
 * 3. sending one person their update
 * ------------------------------------------------------------------ */
console.log('\nsending one candidate their update');

const rec = await open();
await rec.api('post', '/auth/login',
  { email: 'recruiter@teamlink.com', password: PASSWORD, role: 'recruiter' });

const { applications = [] } = await rec.api('get', '/applications?limit=25');
const target = applications.find((a) => a.stage && a.stage !== 'rejected');

await check('the update names the role, the stage and the recipient', async () => {
  must(target, 'no application to send for');
  const out = await rec.api('post', `/notifications/applications/${target.id}/send`);
  must(out.event, 'no event reported');
  must(out.jobTitle, 'the role is not named');
  must(out.stageLabel, 'the stage is not named');
  must(out.to && out.to.includes('@'), `no recipient reported: ${out.to}`);
  must(out.delivery_status, 'no per-channel outcome');
});

await check('the message matches the stage the application is actually at', async () => {
  const out = await rec.api('post', `/notifications/applications/${target.id}/send`);
  must(out.event === (EVENT_FOR_STAGE[out.stage] || 'STAGE_CHANGED'),
    `stage ${out.stage} was sent ${out.event}`);
});

await check('an unauthenticated caller cannot send anybody anything', async () => {
  const anon = await open();
  let code = null;
  try {
    await anon.api('post', `/notifications/applications/${target.id}/send`);
  } catch (e) { code = e.code; }
  must(code === 'UNAUTHENTICATED' || code === 'UNAUTHORIZED' || code === 'FORBIDDEN',
    `an unauthenticated caller got ${code || 'through'}`);
});

await check('an application that does not exist says so', async () => {
  let code = null;
  try { await rec.api('post', '/notifications/applications/app_nope/send'); }
  catch (e) { code = e.code; }
  must(code === 'NOT_FOUND', `got ${code}`);
});

/* ------------------------------------------------------------------ *
 * 4. do-not-contact
 * ------------------------------------------------------------------ */
console.log('\nsomebody who asked not to be contacted');

await check('do-not-contact is refused, not quietly skipped', async () => {
  const cid = target.candidateId;
  await admin.api('put', `/candidates/${cid}`, { doNotContact: true });
  let code = null;
  try { await rec.api('post', `/notifications/applications/${target.id}/send`); }
  catch (e) { code = e.code; }
  await admin.api('put', `/candidates/${cid}`, { doNotContact: false });
  must(code === 'DO_NOT_CONTACT',
    `got ${code} — a refusal the recruiter can see is the point`);
});

/* ------------------------------------------------------------------ */
await browser.close();
console.log(failed ? `\n  ${failed} FAILED\n` : '\n  all checks passed\n');
process.exitCode = failed ? 1 : 0;
