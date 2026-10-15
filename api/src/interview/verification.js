/**
 * The photo verification that comes before an AI interview (0149).
 *
 *   INTERVIEW_PHOTO_VERIFICATION      'off' switches the requirement off (development only). Anything else = on.
 *   INTERVIEW_PHOTO_MAX_BYTES         largest photo accepted                              (default 2 MB)
 *   INTERVIEW_IMAGE_RETENTION_DAYS    how long a photo is kept before it is deleted       (default 90)
 *   INTERVIEW_VERIFICATION_MINUTES    how long a finished verification may wait for the
 *                                     interview to start                                   (default 180)
 *   INTERVIEW_IMAGE_KEY               passphrase that encrypts photos before they are stored. Falls back to
 *                                     INTEGRATION_SECRET_KEY, then AUTH_SECRET. Changing it makes photos
 *                                     stored under the old one unreadable - they simply age out.
 *   SUPPORT_EMAIL                     where a candidate is pointed for camera or privacy questions
 *
 * The notice text lives HERE, with a version. A consent is recorded against that version, so what a
 * candidate agreed to can always be read back.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { supportEmail } from './policy.js';
import { getStorage } from '../storage.js';
import { ApiError, CODES } from '../errors.js';

export const verificationEnabled = () => String(process.env.INTERVIEW_PHOTO_VERIFICATION || 'on').toLowerCase() !== 'off';
export const photoMaxBytes = () => Math.max(50 * 1024, Number(process.env.INTERVIEW_PHOTO_MAX_BYTES || 2 * 1024 * 1024));
export const imageRetentionDays = () => Math.max(1, Math.round(Number(process.env.INTERVIEW_IMAGE_RETENTION_DAYS || 90)));
export const verificationMinutes = () => Math.max(5, Math.round(Number(process.env.INTERVIEW_VERIFICATION_MINUTES || 180)));

export const NOTICE_VERSION = '2026-10-15';

/** What the candidate must be able to read before the photo is taken and before they consent. */
export function verificationNotice() {
  const days = imageRetentionDays();
  const support = supportEmail();
  return {
    version: NOTICE_VERSION,
    title: 'Why we ask for a photo, and what happens to it',
    purpose: 'Your camera is required for identity verification and interview safety. Before the interview starts we take one '
      + 'photo of your face so the recruitment team can see who attended the interview you were invited to.',
    points: [
      'We collect ONE photo, taken now, before the interview. No further photos are taken during the interview.',
      'During the interview your camera and microphone are used live in your browser for safety checks (for example whether the '
        + 'camera is covered or more than one person is in view). Those checks run on your device and the pictures from them are not uploaded or kept.',
      'Your spoken answers are recorded as part of the interview, as described in the interview instructions. Recordings are kept with the interview.',
      'The photo is sent over an encrypted connection, encrypted again before it is stored, and kept in private storage. It has no public link.',
      'Only the recruiter and the hiring team for this job, and administrators handling interview or compliance matters, can open it. Every time staff open it, it is logged.',
      `The photo is deleted automatically ${days} days after it is taken, unless the law or a dispute requires it to be kept longer.`,
      'The photo is used only to confirm who attended the interview. It is not used for facial recognition, biometric identification or to train any model.',
      'A photo shows that a picture was submitted. It does not prove who you are, and no candidate is rejected only because a photo or camera check was uncertain.',
    ],
    contact: support
      ? `For camera problems or privacy requests (to see, correct or delete your photo), write to ${support}.`
      : 'For camera problems or privacy requests, contact the recruiter who invited you.',
    retentionDays: days,
    supportEmail: support || null,
  };
}

/** The conditions, as the candidate is asked to accept them. */
export function verificationInstructions() {
  return [
    'Sit in a quiet, well-lit place.',
    'Keep your face visible to the camera for the whole interview.',
    'Make sure you are the person attending the interview.',
    'Do not let another person answer for you, or help you.',
    'Do not leave the interview window unnecessarily.',
    'Make sure your internet connection and microphone are working.',
    'Answer every question honestly and on your own.',
  ];
}

export const CAMERA_REQUIREMENTS = [
  'A working camera and microphone, and permission for this site to use them.',
  'A quiet, well-lit place, with your face clearly visible and nobody else in the picture.',
  'A modern browser (Chrome, Edge, Safari or Firefox) over a secure (HTTPS) connection.',
];

/* ------------------------------------------------------------------ *
 * photo bytes: what is accepted, and how it is encrypted at rest
 * ------------------------------------------------------------------ */
const PHOTO_SIGNATURES = [
  { ext: 'jpg',  mime: 'image/jpeg', test: (b) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png',  mime: 'image/png',
    test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: 'webp', mime: 'image/webp',
    test: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];

/** The type is read from the bytes, not from what the browser called it. Returns null when it is not a photo type. */
export function sniffPhoto(buffer) {
  if (!buffer || !buffer.length) return null;
  const m = PHOTO_SIGNATURES.find((s) => s.test(buffer));
  return m ? { ext: m.ext, mime: m.mime } : null;
}

const MAGIC = Buffer.from('TLP1');
function key() {
  const raw = process.env.INTERVIEW_IMAGE_KEY || process.env.INTEGRATION_SECRET_KEY || process.env.AUTH_SECRET || '';
  return createHash('sha256').update(`interview-photo:${raw}`, 'utf8').digest();
}

/** AES-256-GCM, a fresh IV per photo: magic | iv(12) | tag(16) | ciphertext. */
export function sealPhoto(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}

/** Returns the photo bytes, or null when the file is not ours / was tampered with / the key changed. */
export function openPhoto(sealed) {
  try {
    if (!sealed || sealed.length < MAGIC.length + 28 || !sealed.subarray(0, 4).equals(MAGIC)) return null;
    const iv = sealed.subarray(4, 16), tag = sealed.subarray(16, 32), ct = sealed.subarray(32);
    const d = createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  } catch { return null; }
}

/* ------------------------------------------------------------------ *
 * storing and reading a photo (private storage, encrypted)
 * ------------------------------------------------------------------ */

/** Checks the bytes, encrypts them, stores them under a random key. Returns what the database keeps. */
export async function storeVerificationPhoto({ candidateId, verificationId, buffer }) {
  if (!buffer || !buffer.length) throw new ApiError(400, CODES.UPLOAD_FAILED, 'That photo appears to be empty.');
  const max = photoMaxBytes();
  if (buffer.length > max) {
    throw new ApiError(413, CODES.FILE_TOO_LARGE, `That photo is too large. The limit is ${Math.round(max / 1024 / 1024 * 10) / 10}MB.`);
  }
  const kind = sniffPhoto(buffer);
  if (!kind) throw new ApiError(415, CODES.UNSUPPORTED_FILE, 'That file is not a photo (JPEG, PNG or WebP).');
  const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '');
  const path = `interview-verification/${safe(candidateId)}/${safe(verificationId)}/${randomUUID()}.bin`;
  await getStorage().put(path, sealPhoto(buffer), 'application/octet-stream');
  return { path, mime: kind.mime, size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
}

/** The photo bytes, decrypted. Null when the file is missing or cannot be opened. */
export async function readVerificationPhoto(path) {
  try {
    const sealed = await getStorage().get(path);
    return openPhoto(Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed));
  } catch { return null; }
}
