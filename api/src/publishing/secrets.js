/**
 * Integration secrets, encrypted at rest (0112).
 *
 * The key comes from INTEGRATION_SECRET_KEY in the server's environment
 * and nowhere else. Without it, secrets cannot be SAVED - the API refuses
 * and says so - and secrets already stored cannot be read, which makes the
 * integration report "Integration Required" rather than guess.
 *
 * AES-256-GCM: a fresh 12-byte IV per write and an authentication tag, so
 * a tampered or wrong-key ciphertext fails loudly instead of decrypting
 * to rubbish. The 32-byte key is SHA-256 of the env value, so any
 * sufficiently long passphrase works.
 *
 * NOTHING HERE LOGS. A value only ever leaves this module decrypted into
 * the connector that sends it to the platform it was issued by.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

/** The secret fields an integration may hold. Anything else is refused. */
export const SECRET_FIELDS = ['apiKey', 'clientSecret', 'feedToken', 'callbackSecret'];

const MIN_KEY_CHARS = 16;

export function secretKeyConfigured() {
  return String(process.env.INTEGRATION_SECRET_KEY || '').length >= MIN_KEY_CHARS;
}

function key() {
  const raw = String(process.env.INTEGRATION_SECRET_KEY || '');
  if (raw.length < MIN_KEY_CHARS) return null;
  return createHash('sha256').update(raw, 'utf8').digest();
}

export class SecretKeyMissing extends Error {
  constructor() {
    super('INTEGRATION_SECRET_KEY is not set on the server (at least 16 characters), so credentials cannot be stored. '
      + 'Set it in the server environment and restart, then save again.');
    this.code = 'INTEGRATION_SECRET_KEY_MISSING';
  }
}

/** Encrypts a { field: value } map. Throws SecretKeyMissing without a key. */
export function sealSecrets(map) {
  const k = key();
  if (!k) throw new SecretKeyMissing();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(map || {}), 'utf8'), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') });
}

/**
 * Decrypts what sealSecrets wrote. Returns null when there is nothing,
 * no key, or the ciphertext does not authenticate (wrong key, tampered).
 */
export function openSecrets(sealed) {
  if (!sealed) return null;
  const k = key();
  if (!k) return null;
  try {
    const o = JSON.parse(sealed);
    const d = createDecipheriv('aes-256-gcm', k, Buffer.from(o.iv, 'base64'));
    d.setAuthTag(Buffer.from(o.tag, 'base64'));
    const pt = Buffer.concat([d.update(Buffer.from(o.ct, 'base64')), d.final()]).toString('utf8');
    const map = JSON.parse(pt);
    return map && typeof map === 'object' ? map : null;
  } catch {
    return null;
  }
}

/**
 * What the browser may see of a secret: that it is saved, and at most its
 * last 4 characters - none at all for a short one, where 4 characters
 * would be most of it.
 */
export function hintFor(value) {
  const v = String(value || '');
  if (!v) return null;
  return v.length >= 12 ? v.slice(-4) : '';
}

/** Constant-time string comparison (feed tokens, callback signatures). */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (!x.length || x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export function hmacHex(secret, body) {
  return createHmac('sha256', String(secret)).update(body).digest('hex');
}

/**
 * Removes every configured secret value from a piece of text before it is
 * stored as an error or shown to anybody. A platform that echoes the key
 * back in its error body must not get it into our database through us.
 */
export function scrub(text, secrets) {
  let out = String(text == null ? '' : text);
  for (const v of Object.values(secrets || {})) {
    const s = String(v || '');
    if (s.length >= 4) out = out.split(s).join('••••');
  }
  return out.length > 500 ? out.slice(0, 500) + '…' : out;
}
