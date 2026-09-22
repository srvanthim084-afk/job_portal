/**
 * Resume storage (requirements 8 and 19).
 *
 * The prototype read resumes with FileReader.readAsDataURL (prototype.html
 * :2658) and kept the base64 in memory / localStorage — which is why every
 * seeded candidate has only a FILENAME, not a file. localStorage caps out
 * around 5MB for everything combined.
 *
 * Here the bytes go to object storage, the database keeps a reference, and
 * the file is served back only through a short-lived signed URL issued
 * after a permission check. The browser never gets a storage credential.
 *
 * Two drivers:
 *   local    — disk, for development and single-box deployments
 *   supabase — Supabase Storage, using the service key SERVER-SIDE ONLY
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { config } from './config.js';
import { ApiError, CODES } from './errors.js';

/* ------------------------------------------------------------------ *
 * Validation — content, not the client's word for it
 * ------------------------------------------------------------------ */

/**
 * A browser-supplied filename and Content-Type are attacker-controlled, so
 * the file is identified by its magic bytes instead. This is what stops a
 * .pdf-named executable or an HTML file (stored XSS) getting through.
 */
const SIGNATURES = [
  { ext: 'pdf',  mime: 'application/pdf',
    test: (b) => b.length > 4 && b.toString('latin1', 0, 5) === '%PDF-' },

  // DOCX (and any OOXML) is a zip
  { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    test: (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b &&
                 (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) },

  // Legacy .doc is an OLE2 compound file
  { ext: 'doc',  mime: 'application/msword',
    test: (b) => b.length > 8 && b.toString('hex', 0, 8) === 'd0cf11e0a1b11ae1' },

  // Plain text has no signature, so it is identified by exclusion: no NUL
  // bytes and almost no control characters. Listed LAST so a real binary
  // format always wins. The upload button has always offered TXT; the
  // validator did not accept it, so a text resume failed with a type error.
  { ext: 'txt',  mime: 'text/plain', test: looksLikeText },
];

function looksLikeText(b) {
  const sample = b.subarray(0, Math.min(b.length, 4096));
  if (!sample.length) return false;
  if (sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) return true;
  if ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff)) return true;
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control++;
  }
  return control / sample.length < 0.02;
}

export const ALLOWED_EXT = ['pdf', 'doc', 'docx', 'txt'];

export function validateResume(buffer, originalName) {
  if (!buffer || !buffer.length) {
    throw new ApiError(400, CODES.UPLOAD_FAILED, 'That file appears to be empty.');
  }
  if (buffer.length > config.maxUploadBytes) {
    const mb = Math.round(config.maxUploadBytes / 1024 / 1024);
    throw new ApiError(413, CODES.FILE_TOO_LARGE, `That file is too large. The limit is ${mb}MB.`);
  }

  const claimed = extname(originalName || '').replace('.', '').toLowerCase();
  const match = SIGNATURES.find((s) => s.test(buffer));

  if (!match) {
    throw new ApiError(415, CODES.UNSUPPORTED_FILE,
      'Please upload a PDF, DOC or DOCX file.');
  }
  // A .docx and a .zip share a signature, so accept the claimed extension
  // when it is consistent with the detected family; reject outright lies.
  if (claimed && claimed !== match.ext) {
    const ooxml = match.ext === 'docx' && ['docx'].includes(claimed);
    if (!ooxml) {
      throw new ApiError(415, CODES.UNSUPPORTED_FILE,
        `That file is named .${claimed} but its contents are ${match.ext.toUpperCase()}. Please upload a valid PDF, DOC or DOCX.`);
    }
  }
  return { ext: match.ext, mime: match.mime, size: buffer.length };
}

/** Strips directory components and anything not filename-safe. */
export function safeName(name, ext) {
  const base = String(name || 'resume')
    .replace(/[\\/]/g, ' ')
    .replace(/\.[^.]*$/, '')
    .replace(/[^\w .\-()]+/g, '')
    .trim()
    .slice(0, 80) || 'resume';
  return `${base}.${ext}`;
}

/* ------------------------------------------------------------------ *
 * Drivers
 * ------------------------------------------------------------------ */

const localDriver = {
  name: 'local',
  async put(key, buffer) {
    const full = resolve(config.storageLocalDir, key);
    // never let a crafted key escape the upload directory
    const root = resolve(config.storageLocalDir);
    if (!full.startsWith(root + (process.platform === 'win32' ? '\\' : '/'))) {
      throw new ApiError(400, CODES.UPLOAD_FAILED, 'Invalid storage path.');
    }
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, buffer);
    return key;
  },
  async get(key) {
    const full = resolve(config.storageLocalDir, key);
    const root = resolve(config.storageLocalDir);
    if (!full.startsWith(root)) throw new ApiError(400, CODES.UPLOAD_FAILED, 'Invalid storage path.');
    if (!existsSync(full)) throw new ApiError(404, CODES.NOT_FOUND, 'That file is no longer available.');
    return readFile(full);
  },
  async remove(key) {
    try { await unlink(resolve(config.storageLocalDir, key)); } catch { /* already gone */ }
  },
  /**
   * No CDN in front of local disk, so the "signed URL" is a route on this
   * API that re-checks permissions. Same guarantee, different mechanism.
   */
  async signedUrl(key) { return `/api/files/${encodeURIComponent(key)}`; },
};

const supabaseDriver = {
  name: 'supabase',
  base() { return `${config.storageUrl.replace(/\/$/, '')}/storage/v1`; },
  headers(extra = {}) {
    return {
      authorization: `Bearer ${config.storageKey}`,
      apikey: config.storageKey,
      ...extra,
    };
  },
  async put(key, buffer, mime) {
    const url = `${this.base()}/object/${config.storageBucket}/${encodeURI(key)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers({ 'content-type': mime, 'x-upsert': 'true' }),
      body: buffer,
    });
    if (!res.ok) {
      throw new ApiError(502, CODES.UPLOAD_FAILED,
        'We could not store that file. Please try again.',
        undefined, await res.text().catch(() => ''));
    }
    return key;
  },
  async get(key) {
    const url = `${this.base()}/object/${config.storageBucket}/${encodeURI(key)}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new ApiError(404, CODES.NOT_FOUND, 'That file is no longer available.');
    return Buffer.from(await res.arrayBuffer());
  },
  async remove(key) {
    const url = `${this.base()}/object/${config.storageBucket}/${encodeURI(key)}`;
    await fetch(url, { method: 'DELETE', headers: this.headers() }).catch(() => {});
  },
  /** Short-lived URL so a link cannot be forwarded and reused indefinitely. */
  async signedUrl(key, seconds = 120) {
    const url = `${this.base()}/object/sign/${config.storageBucket}/${encodeURI(key)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ expiresIn: seconds }),
    });
    if (!res.ok) throw new ApiError(502, CODES.UPLOAD_FAILED, 'Could not produce a download link.');
    const { signedURL } = await res.json();
    return `${config.storageUrl.replace(/\/$/, '')}/storage/v1${signedURL}`;
  },
};

export function getStorage() {
  return config.storageDriver === 'supabase' ? supabaseDriver : localDriver;
}

/**
 * Stores a validated resume and returns the metadata the database keeps.
 * The key is content-addressed by a random uuid rather than the user's
 * filename, so two people uploading "resume.pdf" never collide and the
 * original name never becomes a path.
 */
export async function storeResume({ candidateId, buffer, originalName }) {
  const { ext, mime, size } = validateResume(buffer, originalName);
  const display = safeName(originalName, ext);
  const key = `candidates/${candidateId}/${randomUUID()}.${ext}`;
  const digest = createHash('sha256').update(buffer).digest('hex');
  await getStorage().put(key, buffer, mime);
  return { path: key, displayName: display, mime, size, sha256: digest };
}
