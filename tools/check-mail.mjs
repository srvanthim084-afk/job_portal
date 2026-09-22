/**
 * Does the mailbox in .env actually accept us?
 *
 * Connects and authenticates exactly as the application will, and says so
 * in one line. Nothing is sent, and the password is never printed.
 *
 * Run this BEFORE assuming mail works: a wrong credential does not fail
 * loudly anywhere else — every send simply records `failed` in the
 * delivery log, which looks like a network problem rather than a
 * password problem.
 *
 *   npm run check:mail
 *
 * Gmail note: an account password is always rejected here with
 * `535-5.7.8 Username and Password not accepted`. Gmail requires a
 * 16-character App Password (Google Account → Security → 2-Step
 * Verification → App passwords), which is what belongs in
 * EMAIL_SMTP_PASS.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const envFile = resolve(process.cwd(), process.env.ENV_FILE || '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const { config } = await import('../api/src/config.js');
const { verifySmtp } = await import('../api/src/notify/providers.js');

if (!config.smtpHost) {
  console.log('\n  no SMTP host configured — EMAIL_SMTP_HOST is empty.');
  console.log('  Every send will record `not_configured`, which is honest but silent.\n');
  process.exit(1);
}

console.log(`\n  host   ${config.smtpHost}:${config.smtpPort} ` +
            `(${config.smtpSecure ? 'TLS' : 'STARTTLS'})`);
console.log(`  user   ${config.smtpUser || '(none)'}`);
console.log(`  from   ${config.emailFrom || config.smtpUser || '(none)'}`);
console.log(`  pass   ${config.smtpPass ? `${config.smtpPass.length} characters` : 'NOT SET'}`);

const r = await verifySmtp();

if (r.ok) {
  console.log('\n  MAILBOX ACCEPTED — the application can send mail as this user.\n');
  process.exit(0);
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
process.exit(1);
