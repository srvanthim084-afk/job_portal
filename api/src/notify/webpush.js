/**
 * Web Push, with nothing but node:crypto.
 *
 *   VAPID (RFC 8292)        an ES256-signed JWT that tells the push
 *                           service who is sending; Apple refuses a push
 *                           whose subject is not a mailto: or https: URL
 *   aes128gcm (RFC 8291)    the message is encrypted for the browser's own
 *                           keys; the push service carries bytes it
 *                           cannot read
 *
 * Works for every push service a browser can hand us - Google (Chrome,
 * Android), Mozilla, Microsoft, and Apple (web.push.apple.com, used by a
 * Home Screen app on iPhone/iPad and by Safari on a Mac).
 *
 * ONLY TO PUSH SERVICES. The endpoint is a URL the browser gave us, and
 * the server POSTs to it - so it must be a push service, or this becomes
 * a way to make the server call anywhere. The known services are listed;
 * PUSH_EXTRA_HOSTS adds more (the tests point it at a local mock).
 *
 * Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (base64url, raw P-256) and
 * VAPID_SUBJECT, from the environment. Never logged, never sent to the
 * browser except the public key, which is public by design.
 */
import { createECDH, createHmac, createCipheriv, randomBytes, createPrivateKey, sign } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s || '').trim().replace(/=+$/, ''), 'base64url');

const PUSH_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/i, /(^|\.)android\.googleapis\.com$/i,
  /(^|\.)push\.services\.mozilla\.com$/i,
  /(^|\.)push\.apple\.com$/i,
  /(^|\.)notify\.windows\.com$/i,
];

function extraHosts() {
  return String(process.env.PUSH_EXTRA_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
}

/** Is this an endpoint the server may POST to? */
export function endpointAllowed(endpoint) {
  let u;
  try { u = new URL(String(endpoint || '')); } catch { return false; }
  const extra = extraHosts();
  if (extra.includes(u.host.toLowerCase())) return u.protocol === 'https:' || u.protocol === 'http:';
  if (u.protocol !== 'https:') return false;
  return PUSH_HOSTS.some((re) => re.test(u.hostname));
}

/** What the server needs, and a plain sentence when something is wrong. */
export function vapidConfig() {
  const publicKey = String(process.env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = String(process.env.VAPID_PRIVATE_KEY || '').trim();
  const subject = String(process.env.VAPID_SUBJECT || '').trim();
  if (!publicKey || !privateKey) {
    return { ok: false, error: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set' };
  }
  const pub = unb64u(publicKey);
  const priv = unb64u(privateKey);
  if (pub.length !== 65 || pub[0] !== 4) return { ok: false, error: 'VAPID_PUBLIC_KEY is not a P-256 public key' };
  if (priv.length !== 32) return { ok: false, error: 'VAPID_PRIVATE_KEY is not a P-256 private key' };
  if (!/^mailto:[^@\s]+@[^@\s]+\.[^@\s]+$/i.test(subject) && !/^https:\/\/[^\s/]+\.[^\s]+$/i.test(subject)) {
    return { ok: false, error: 'VAPID_SUBJECT must be a mailto: or https: URL (Apple rejects pushes without one)' };
  }
  return { ok: true, publicKey, pub, priv, subject };
}

/** A fresh key pair, for setting the environment up. */
export function generateVapidKeys() {
  const e = createECDH('prime256v1');
  e.generateKeys();
  const priv = e.getPrivateKey();
  const padded = Buffer.concat([Buffer.alloc(32 - priv.length), priv]);
  return { publicKey: b64u(e.getPublicKey()), privateKey: b64u(padded) };
}

function hkdfExtract(salt, ikm) { return createHmac('sha256', salt).update(ikm).digest(); }
function hkdfExpand(prk, info, len) {
  return createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);
}

/**
 * RFC 8291: the payload encrypted for one subscription, as the request
 * body (aes128gcm header + one record).
 */
export function encryptPayload(payload, p256dh, auth, opts = {}) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('the subscription keys are not valid');
  const salt = opts.salt || randomBytes(16);
  const ecdh = opts.ecdh || createECDH('prime256v1');
  if (!opts.ecdh) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const ikm = hkdfExpand(hkdfExtract(authSecret, shared),
    Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])),
    cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

function vapidAuthorization(endpoint, cfg) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: cfg.subject }));
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(cfg.pub.subarray(1, 33)), y: b64u(cfg.pub.subarray(33, 65)), d: b64u(cfg.priv) },
    format: 'jwk',
  });
  const sig = sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${cfg.publicKey}`;
}

/**
 * Send one notification to one subscription.
 *
 * @param sub      { endpoint, p256dh, auth }
 * @param message  { title, body, url, tag?, badge? } - kept small, and
 *                 always with a title and a body (iOS revokes a
 *                 subscription whose push shows nothing)
 * @returns { status: 'sent'|'gone'|'failed'|'not_configured', error?, ref? }
 */
export async function sendPush(sub, message, { ttl = 86400 } = {}) {
  const cfg = vapidConfig();
  if (!cfg.ok) return { status: 'not_configured', provider: 'push', error: cfg.error };
  if (!endpointAllowed(sub.endpoint)) {
    return { status: 'failed', provider: 'push', error: 'not a known push service' };
  }
  const payload = JSON.stringify({
    title: String(message.title || 'TeamLink').slice(0, 120),
    body: String(message.body || 'You have an update on TeamLink.').slice(0, 300),
    url: String(message.url || '/').slice(0, 500),
    tag: message.tag ? String(message.tag).slice(0, 80) : undefined,
    badge: Number.isFinite(message.badge) ? message.badge : undefined,
  });
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttl),
        Urgency: 'normal',
        Authorization: vapidAuthorization(sub.endpoint, cfg),
      },
      body: encryptPayload(payload, sub.p256dh, sub.auth),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status >= 200 && res.status < 300) {
      return { status: 'sent', provider: 'push', ref: res.headers.get('location') || null };
    }
    const text = (await res.text().catch(() => '')).slice(0, 200);
    /* 404 / 410: the browser unsubscribed or the app was removed. */
    if (res.status === 404 || res.status === 410) return { status: 'gone', provider: 'push', error: `HTTP ${res.status}` };
    return { status: 'failed', provider: 'push', error: `HTTP ${res.status}${text ? `: ${text}` : ''}` };
  } catch (err) {
    return { status: 'failed', provider: 'push', error: err.message };
  }
}

/** 'ios' | 'android' | 'desktop', from the user agent (and the page's
    own reading, for an iPad that reports itself as a Mac). */
export function platformFrom(userAgent, hint) {
  const ua = String(userAgent || '');
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Macintosh/i.test(ua) && hint === 'ios') return 'ios';
  return 'desktop';
}

/** "iPhone", "Android phone", "Chrome on Windows" - for the device list. */
export function deviceLabel(userAgent, platform) {
  const ua = String(userAgent || '');
  if (platform === 'ios') return /iPad/i.test(ua) || /Macintosh/i.test(ua) ? 'iPad' : 'iPhone';
  if (platform === 'android') return 'Android phone';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'computer';
  return `${browser} on ${os}`;
}
