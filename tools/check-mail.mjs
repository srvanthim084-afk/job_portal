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
const { verifySmtp, emailjsReady } = await import('../api/src/notify/providers.js');

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
  const probe = await fetch(e.apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
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
    console.log(`\n  EMAILJS ACCEPTED — a message was sent to ${config.emailFrom}.\n`);
    return 0;
  }

  if (/template id not found/i.test(probe.text)) {
    console.log('\n  The service and public key are ACCEPTED, and non-browser API calls');
    console.log('  are allowed — only the template is missing.');
    console.log('  Find it at https://dashboard.emailjs.com/admin/templates');
    console.log('  (it looks like template_xxxxxxx) and set EMAILJS_TEMPLATE_ID.\n');
    return 1;
  }

  if (/non-browser|strict/i.test(probe.text)) {
    console.log('\n  EmailJS is refusing calls from a server.');
    console.log('  Either enable "Allow EmailJS API for non-browser applications" in');
    console.log('  Account → Security, or set EMAILJS_PRIVATE_KEY.\n');
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
if (config.smtpHost) {
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
