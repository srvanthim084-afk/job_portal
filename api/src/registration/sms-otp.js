/**
 * Sending a mobile OTP - one place, used by registration (0123) and by changing a mobile number (0132).
 *
 * REAL SMS ONLY. The code goes through the configured SMS provider (Administration -> Integrations, or the
 * SMS_* environment). When no provider is configured, or the provider refuses the message, the candidate is
 * told plainly and nothing claims success. There is no code on the screen and no simulated "sent".
 *
 * The one exception is an isolated test instance that asks for it in so many words: SMS_DEV_OTP=true on a
 * server that is not production returns the code to the page, labelled as a development code, so automated
 * browser checks can run without a phone. The live server never sets it.
 */
import { providers } from '../notify/providers.js';
import { ApiError } from '../errors.js';

/** How long an OTP is valid, in minutes. */
export const OTP_MINUTES = 5;

const isProd = () => process.env.NODE_ENV === 'production';

/** The test-only on-screen code: never in production, and only when explicitly switched on. */
export function devOtpAllowed() {
  return !isProd() && /^(1|true|yes|on)$/i.test(String(process.env.SMS_DEV_OTP || '').trim());
}

/**
 * Send `code` to `phone`. Resolves { sent: true } when the provider accepted it, or - test instances only -
 * { sent: false, devCode }. Throws an ApiError the page can show in every other case.
 */
export async function sendOtpSms(phone, code) {
  const text = `${code} is your TeamLink verification code. It is valid for ${OTP_MINUTES} minutes. Do not share it with anyone.`;
  const out = await providers.sms.send({ to: phone, text, purpose: 'otp', vars: [code, String(OTP_MINUTES)] })
    .catch((err) => ({ status: 'failed', error: err.message }));
  if (out.status === 'sent') return { sent: true };
  if (devOtpAllowed()) {
    return { sent: false, devCode: code, note: 'Test server: SMS is switched off (SMS_DEV_OTP). Use this code.' };
  }
  if (out.status === 'not_configured') {
    throw new ApiError(503, 'SMS_UNAVAILABLE', 'We cannot send an OTP right now: SMS is not set up on this server. Please try again later.',
      { phone: 'We cannot send an OTP right now: SMS is not set up on this server. Please contact TeamLink.' });
  }
  throw new ApiError(502, 'SMS_FAILED', 'We could not send the OTP to this number. Please check it and try again.',
    { phone: 'We could not send the OTP to this number. Please check it and try again.' });
}
