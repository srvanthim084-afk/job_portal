/**
 * Will email actually go out, and if not, exactly why?
 *
 * Checks whichever transport is configured - EmailJS or SMTP - the same
 * way the application will use it, and says what is missing in words
 * somebody can act on. Nothing is sent unless the configuration is
 * complete, and no secret is ever printed.
 *
 * Run this BEFORE assuming mail works: a wrong credential does not fail
 * loudly anywhere else - every send simply records `failed` in the
 * delivery log, which reads like a network problem rather than a
 * configuration one.
 *
 *   npm run check:mail
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const envFile = resolve(process.cwd(), process.env.ENV_FILE || '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const { config } = await import('../api/src/config.js');
const { verifySmtp, emailjsReady, smtpReady } = await import('../api/src/notify/providers.js');

/* ------------------------------------------------------------------ *
 * EmailJS
 *
 * Checked first, because a deployment using EmailJS has no SMTP host at
 * all and would otherwise be told it has no email configured.
 * ------------------------------------------------------------------ */
async function checkEmailJs() {
  const e = config.emailjs;
  const ready = emailjsReady();

  console.log('\n  provider  EmailJS');
  console.log(`  service   ${e.serviceId || '(not set)'}`);
  console.log(`  template  ${e.templateId || '(NOT SET)'}`);
  console.log(`  public    ${e.publicKey ? `${e.publicKey.slice(0, 6)}… (${e.publicKey.length} chars)` : '(not set)'}`);
  console.log(`  private   ${e.privateKey ? 'set' : 'not set (only needed in strict mode)'}`);
  console.log(`  from      ${config.emailFrom || '(not set)'}`);

  // Ask EmailJS rather than guessing. With no template configured this
  // sends a template id that cannot exist, so nothing goes out - and the
  // answer still says whether the service, the key and non-browser access
  // are all in order.
  //
  // NO Origin header, because the application does not send one either.
  // An earlier version of this check did, which made EmailJS treat it as
  // a browser and answer "template not found" - so it reported the
  // configuration as working while every real send was refused with a
  // 403. A check that exercises a different path from the code is worse
  // than no check at all.
  const probe = await fetch(e.apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_id: e.serviceId,
      template_id: e.templateId || 'template_probe_not_real',
      user_id: e.publicKey,
      ...(e.privateKey ? { accessToken: e.privateKey } : {}),
      template_params: {
        to_email: config.emailFrom || 'probe@example.com',
        subject: 'TeamLink configuration check',
        message: 'TeamLink configuration check',
      },
    }),
  }).then(async (res) => ({ status: res.status, text: (await res.text()).slice(0, 300) }))
    .catch((err) => ({ status: 0, text: err.message }));

  if (ready.ready && probe.status === 200) {
    /*
     * ACCEPTED is not the same as ADDRESSED, and the difference is what
     * cost a real candidate every message TeamLink sent her.
     *
     * An EmailJS template carries its OWN "To Email" field. If that field
     * holds a fixed address instead of {{to_email}}, every message goes
     * to that one address, the API still answers 200 OK, and the delivery
     * log still records `sent`. There is no error anywhere to find.
     *
     * This CANNOT be detected from the API. It was worth trying, and the
     * attempt is recorded here so nobody repeats it: EmailJS performs no
     * recipient validation whatsoever at this boundary. A send with
     * to_email empty, whitespace, malformed, or omitted from
     * template_params altogether is answered 200 OK in every case. It
     * validates the template id (400 when wrong) and nothing about the
     * recipient. So an accepted probe says nothing about which address
     * the template resolves - only the provider's own Email History
     * lists the recipient a message actually went to.
     *
     * What CAN be checked is our own side: that the address TeamLink puts
     * in to_email is the candidate's. `npm run verify:retry` asserts that
     * against the real outbound payload.
     */
    console.log(`\n  EMAILJS ACCEPTED — a message was sent to ${config.emailFrom}.`);
    console.log('\n  Two things this does NOT establish, both worth knowing:');
    console.log('\n    1. WHO IT WENT TO. The template has its own "To Email" field, and');
    console.log('       a fixed address there sends every message to that address while');
    console.log('       the API still answers OK. EmailJS does not validate the recipient');
    console.log('       here at all, so this check cannot tell the difference.');
    console.log(`       Confirm the field reads exactly {{to_email}}:\n         https://dashboard.emailjs.com/admin/templates/${e.templateId}/settings`);
    console.log('       and confirm the recipient of a real send in Email History:');
    console.log('         https://dashboard.emailjs.com/admin/history');
    console.log('\n    2. THAT IT ARRIVED. Accepted means queued, not delivered. Email');
    console.log('       History is the record of what a mail server took.');
    console.log('\n  Our own side IS checked: `npm run verify:retry` asserts that the');
    console.log("  address in to_email is the candidate's, against the real payload.\n");
    return 0;
  }

  if (/template id not found/i.test(probe.text)) {
    console.log('\n  The service and public key are ACCEPTED, and non-browser API calls');
    console.log('  are allowed — only the template is missing.');
    console.log('  Find it at https://dashboard.emailjs.com/admin/templates');
    console.log('  (it looks like template_xxxxxxx) and set EMAILJS_TEMPLATE_ID.\n');
    return 1;
  }

  // Strict mode is the SAFER choice of the two, so it gets its own
  // message rather than being lumped in with "the gate is shut": the
  // account holder did the right thing and only needs to hand the key to
  // the server.
  if (/strict mode/i.test(probe.text)) {
    console.log('\n  EmailJS is in STRICT MODE, which is the secure setting — it just');
    console.log('  needs the Private Key, which lives on the server and never reaches');
    console.log('  a browser.');
    console.log('  Find it at https://dashboard.emailjs.com/admin/account');
    console.log('  under API Keys, next to the Public Key, and set EMAILJS_PRIVATE_KEY.\n');
    return 1;
  }

  if (/non-browser/i.test(probe.text)) {
    console.log('\n  EmailJS is refusing calls from a server, so nothing can be sent.');
    console.log('  Tick "Allow EmailJS API for non-browser applications" at');
    console.log('    https://dashboard.emailjs.com/admin/account/security');
    console.log('  That one setting is all that is missing — the service, the template');
    console.log('  and the key are otherwise in order.\n');
    return 1;
  }

  if (/public key is invalid|user id/i.test(probe.text)) {
    console.log('\n  EmailJS does not recognise the public key. Check it under');
    console.log('  Account → General → Public Key.\n');
    return 1;
  }

  console.log(`\n  REFUSED — HTTP ${probe.status}: ${probe.text}\n`);
  return 1;
}

/* ------------------------------------------------------------------ *
 * SMTP
 * ------------------------------------------------------------------ */
async function checkSmtp() {
  console.log(`\n  provider  SMTP`);
  console.log(`  host      ${config.smtpHost}:${config.smtpPort} ` +
              `(${config.smtpSecure ? 'TLS' : 'STARTTLS'})`);
  console.log(`  user      ${config.smtpUser || '(none)'}`);
  console.log(`  from      ${config.emailFrom || config.smtpUser || '(none)'}`);
  console.log(`  pass      ${config.smtpPass ? `${config.smtpPass.length} characters` : 'NOT SET'}`);

  /*
   * The length is printed for a reason.
   *
   * `.env` treats an unquoted # as the start of a comment, so a password
   * containing one is silently TRUNCATED at that character - a
   * 16-character secret arrives as two, the server says "wrong
   * password", and nothing anywhere suggests the file is at fault.
   * Seeing the length catches it in one glance.
   */
  if (config.smtpPass && /[#'"\s]/.test(config.smtpPass)) {
    console.log('            note: contains # or a quote — the value in .env must be');
    console.log('            wrapped in double quotes or it will be cut short.');
  }

  /*
   * A Google App Password is sixteen LOWERCASE LETTERS, nothing else.
   * Anything with digits or punctuation is an ordinary password, and
   * Gmail will refuse it however many times it is retyped.
   */
  if (/gmail|google/i.test(config.smtpHost) && config.smtpPass
      && !/^[a-z]{16}$/.test(config.smtpPass.replace(/\s+/g, ''))) {
    console.log('            note: this does not look like a Google App Password,');
    console.log('            which is 16 lowercase letters with no digits or symbols.');
  }

  const r = await verifySmtp();
  if (r.ok) {
    console.log('\n  MAILBOX ACCEPTED — the application can send mail as this user.\n');
    return 0;
  }

  console.log(`\n  REFUSED — ${String(r.error).split('\n')[0]}`);
  if (/5\.7\.8|BadCredentials|5\.7\.9|application-specific/i.test(String(r.error))) {
    console.log('\n  This is an authentication refusal, not a network problem.');
    if (/gmail|google/i.test(config.smtpHost)) {
      console.log('  Gmail does not accept account passwords over SMTP. Turn on 2-Step');
      console.log('  Verification, generate an App Password at');
      console.log('    https://myaccount.google.com/apppasswords');
      console.log('  and put those 16 characters in EMAIL_SMTP_PASS.');
    }
  }
  console.log();
  return 1;
}

/* ------------------------------------------------------------------ */

let code;
/*
 * Check the transport that will ACTUALLY be used.
 *
 * SMTP is preferred over EmailJS, but only once all four of its parts are
 * present - a host written into .env before the password arrives is not a
 * preference, it is a half-finished setting, and mail keeps going out
 * over EmailJS meanwhile. Reporting on SMTP in that window would describe
 * a transport nothing is using.
 */
if (config.smtpHost && !smtpReady()) {
  console.log('\n  SMTP is half configured, so mail is still going out over EmailJS.');
  console.log('\n    host   ' + `${config.smtpHost}:${config.smtpPort}`);
  console.log('    user   ' + (config.smtpUser || '(not set)'));
  console.log('    from   ' + (config.emailFrom || '(not set)'));
  console.log('    pass   ' + (config.smtpPass ? 'set' : 'NOT SET - this is what is missing'));
  if (!config.smtpPass && /gmail|google/i.test(config.smtpHost)) {
    console.log('\n  Gmail does not accept an account password over SMTP. Turn on 2-Step');
    console.log('  Verification, generate an App Password at');
    console.log('    https://myaccount.google.com/apppasswords');
    console.log('  and put those 16 letters in EMAIL_SMTP_PASS, in double quotes.');
  }
  console.log('\n  Nothing is broken in the meantime - the EmailJS transport below is');
  console.log('  what is sending today.');
  code = await checkEmailJs();
} else if (config.smtpHost) {
  code = await checkSmtp();
} else if (config.emailjs.serviceId || config.emailjs.publicKey) {
  code = await checkEmailJs();
} else {
  console.log('\n  No email transport is configured.');
  console.log('  Set either EMAIL_SMTP_HOST (with a user and password) or the');
  console.log('  EMAILJS_* values. Until then every send records `not_configured`,');
  console.log('  which is honest but silent.\n');
  code = 1;
}

// exitCode rather than process.exit(): an abrupt exit while fetch's
// keep-alive socket is still closing trips a libuv assertion on Windows.
process.exitCode = code;
