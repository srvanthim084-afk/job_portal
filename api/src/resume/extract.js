/**
 * Resume text extraction — server side.
 *
 * WHY THIS MOVED OFF THE BROWSER
 * ------------------------------
 * The prototype extracted text in the page, lazy-loading mammoth and pdf.js
 * from cdnjs. That worked until the API started serving the app with a
 * Content-Security-Policy whose script-src allowed 'self', 'unsafe-inline'
 * and cdn.jsdelivr.net — but not cdnjs.cloudflare.com. Both libraries were
 * refused, ensureMammoth() rejected, and the catch showed one message for
 * everything:
 *
 *     "Something went wrong reading this file"
 *
 * The browser console said `Refused to load ... violates the following
 * Content Security Policy directive`, but nothing surfaced that, so every
 * DOCX and every PDF looked like a corrupt file.
 *
 * Widening the CSP would have fixed the symptom. Extraction belongs here
 * anyway:
 *
 *   - .doc cannot be parsed properly in a browser at all
 *   - the AI key must never be in the page, and the parsed text is what
 *     gets sent to it
 *   - a filename and a Content-Type are attacker-controlled; the bytes are
 *     checked here regardless
 *   - it works with no network access and under any CSP
 *
 * NOTHING HERE INVENTS DATA. If a file yields no text, that is reported as
 * its own condition, not dressed up as a parse failure or a success.
 */
import mammoth from 'mammoth';
import { inflateRawSync } from 'node:zlib';
import { ApiError, CODES } from '../errors.js';

/** Distinct enough that the UI can say what actually went wrong. */
export const RESUME_CODES = {
  UNSUPPORTED:  'RESUME_UNSUPPORTED_TYPE',
  DOCX_FAILED:  'RESUME_DOCX_FAILED',
  PDF_FAILED:   'RESUME_PDF_FAILED',
  DOC_FAILED:   'RESUME_DOC_FAILED',
  NO_TEXT:      'RESUME_NO_TEXT',
};

/* A resume with fewer than this many characters of text is not a resume
   anyone can parse — it is a scan, an image-only PDF, or an empty file.
   Saying so is more useful than returning two words and calling it done. */
const MIN_USEFUL_CHARS = 40;

/* ------------------------------------------------------------------ *
 * identifying the file by its bytes
 * ------------------------------------------------------------------ */
export function sniff(buffer, originalName = '') {
  const claimed = String(originalName).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';

  if (buffer.length > 4 && buffer.toString('latin1', 0, 5) === '%PDF-') return 'pdf';
  if (buffer.length > 8 && buffer.toString('hex', 0, 8) === 'd0cf11e0a1b11ae1') return 'doc';
  if (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b &&
      (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)) {
    // A DOCX is a zip. So is a .zip, .xlsx and a .jar — the parts inside
    // are what distinguish them, and readZipEntry looks for word/document.xml.
    return 'docx';
  }

  // Text has no signature, so it is identified by exclusion: if it decodes
  // as UTF-8 without control characters, it is text.
  if (claimed === 'txt' || looksLikeText(buffer)) return 'txt';

  return null;
}

function looksLikeText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (!sample.length) return false;
  // BOM
  if (sample[0] === 0xff && sample[1] === 0xfe) return true;
  if (sample[0] === 0xfe && sample[1] === 0xff) return true;
  if (sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) return true;
  let control = 0;
  for (const b of sample) {
    if (b === 0) return false;                       // a NUL means binary
    if (b < 0x09 || (b > 0x0d && b < 0x20)) control++;
  }
  return control / sample.length < 0.02;
}

/* ------------------------------------------------------------------ *
 * per-format extraction
 * ------------------------------------------------------------------ */

/**
 * DOCX. mammoth first, because it understands the document model —
 * headings, lists and TABLE CELLS all come out as readable lines, and a
 * resume's dates, notice period and salary are very often in a table.
 *
 * mammoth throws on documents it considers malformed (a w:tblStyle
 * pointing at a styles.xml that isn't there, for one). Those files are
 * still readable: document.xml is in the zip and its <w:t> runs are the
 * text. So a failure falls back to reading the XML directly rather than
 * rejecting a file the user can plainly open in Word.
 */
async function fromDocx(buffer) {
  try {
    const out = await mammoth.extractRawText({ buffer });
    const text = (out?.value || '').trim();
    if (text.length >= MIN_USEFUL_CHARS) return { text, parser: 'mammoth' };
    // fall through — an empty result is worth a second opinion
  } catch (err) {
    // deliberately swallowed; the fallback below is the second attempt and
    // reports its own failure if it cannot do better
  }

  try {
    const xml = readZipEntry(buffer, 'word/document.xml');
    if (xml) {
      const text = ooxmlToText(xml.toString('utf8'));
      if (text.trim().length) return { text: text.trim(), parser: 'ooxml-fallback' };
    }
  } catch (err) { /* reported below */ }

  throw new ApiError(422, RESUME_CODES.DOCX_FAILED,
    'This DOCX file could not be read. If it opens in Word, try re-saving it as ' +
    'DOCX or PDF and uploading again.');
}

/** <w:p> becomes a line, <w:tab> a space, <w:t> the text. */
function ooxmlToText(xml) {
  return xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Reads one file out of a zip without a zip library.
 *
 * Only the local file headers are walked, which is enough for the one
 * entry we want and avoids adding a dependency for a fallback path.
 */
function readZipEntry(buffer, wanted) {
  let i = 0;
  while (i + 30 <= buffer.length) {
    if (buffer.readUInt32LE(i) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(i + 8);
    const compSize = buffer.readUInt32LE(i + 18);
    const nameLen = buffer.readUInt16LE(i + 26);
    const extraLen = buffer.readUInt16LE(i + 28);
    const name = buffer.toString('utf8', i + 30, i + 30 + nameLen);
    const dataAt = i + 30 + nameLen + extraLen;

    if (name === wanted) {
      const data = buffer.subarray(dataAt, dataAt + compSize);
      if (method === 0) return data;                       // stored
      // Zip entries are RAW deflate - no zlib header - so inflateRawSync is
      // the one that reads them. unzipSync expects a header and fails on
      // every entry, which silently disabled this whole fallback.
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    if (!compSize) return null;         // streamed entry: sizes live in the
                                        // data descriptor, so stop walking
    i = dataAt + compSize;
  }
  return null;
}

/**
 * PDF. Every page, not the first.
 *
 * The browser version capped at 15 pages; here the whole document is read,
 * because a two-page resume with the education on page two was coming back
 * with half its fields missing.
 */
async function fromPdf(buffer) {
  try {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const out = await parser.getText();
    const text = (out?.text || '').trim();
    const pages = out?.pages?.length ?? out?.total ?? null;
    if (!text) {
      throw new ApiError(422, RESUME_CODES.NO_TEXT,
        'This PDF has no text in it — it looks like a scan or an image. ' +
        'Please upload a text-based PDF or DOCX, or paste your resume text below.');
    }
    return { text, parser: 'pdf-parse', pages };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(422, RESUME_CODES.PDF_FAILED,
      'This PDF could not be read. If it is password-protected, remove the ' +
      'password and try again, or upload a DOCX instead.');
  }
}

/**
 * Legacy .doc — an OLE2 compound file, with the text stored as UTF-16LE
 * runs inside a WordDocument stream.
 *
 * There is no dependency-free parser that handles the format properly, so
 * this recovers the text runs: decode as UTF-16LE, then keep sequences of
 * printable characters. It works on ordinary Word-generated .doc files and
 * is honest when it does not — this is the one format where a clean
 * failure is a real possibility, and the message says what to do about it
 * rather than blaming the file.
 */
function fromDoc(buffer) {
  const utf16 = buffer.toString('utf16le');
  const runs = utf16.match(/[\x20-\x7E -ɏ][\x20-\x7E -ɏ\s]{6,}/g) || [];
  let text = runs.join('\n');

  if (text.trim().length < MIN_USEFUL_CHARS) {
    // Some .doc files store 8-bit text instead
    const latin = buffer.toString('latin1').replace(/\x00/g, '');
    text = (latin.match(/[\x20-\x7E]{6,}/g) || []).join('\n');
  }

  text = text
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (text.length < MIN_USEFUL_CHARS) {
    throw new ApiError(422, RESUME_CODES.DOC_FAILED,
      'This is an older .doc file and its text could not be recovered. ' +
      'Please open it in Word and save it as .docx or PDF, then upload again.');
  }
  return { text, parser: 'doc-ole2' };
}

/** TXT, honouring a BOM if there is one. */
function fromTxt(buffer) {
  let text;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) text = buffer.subarray(2).toString('utf16le');
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    text = swapped.toString('utf16le');
  } else if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    text = buffer.subarray(3).toString('utf8');
  } else {
    text = buffer.toString('utf8');
  }
  return { text: text.trim(), parser: 'text' };
}

/* ------------------------------------------------------------------ *
 * the entry point
 * ------------------------------------------------------------------ */

/**
 * Turns an uploaded file into text, or explains precisely why it could not.
 *
 * @returns {{ text, kind, parser, chars, pages }}
 */
export async function extractResumeText(buffer, originalName = '') {
  if (!buffer || !buffer.length) {
    throw new ApiError(400, CODES.UPLOAD_FAILED, 'That file is empty.');
  }

  const kind = sniff(buffer, originalName);
  if (!kind) {
    throw new ApiError(415, RESUME_CODES.UNSUPPORTED,
      'Please upload a PDF, DOC, DOCX or TXT resume.');
  }

  const out = kind === 'pdf'  ? await fromPdf(buffer)
            : kind === 'docx' ? await fromDocx(buffer)
            : kind === 'doc'  ? fromDoc(buffer)
            :                   fromTxt(buffer);

  // Control characters and zero-width joiners come out of some PDFs and
  // would end up in the database and on screen.
  const text = sanitize(out.text);

  if (text.length < MIN_USEFUL_CHARS) {
    throw new ApiError(422, RESUME_CODES.NO_TEXT,
      'Your resume uploaded, but no readable text was found in it. ' +
      'Please upload a text-based PDF or DOCX, or paste your resume text below.');
  }

  return { text, kind, parser: out.parser, chars: text.length, pages: out.pages ?? null };
}

/**
 * Requirement 11: sanitize extracted content.
 *
 * This text is put into form fields and stored, so it is stripped of
 * control characters and capped. It is never treated as markup anywhere —
 * the prototype writes it with textContent and value — but a 10MB text
 * file should not become a 10MB database row either.
 */
const MAX_TEXT_CHARS = 200_000;

/* Page furniture. A PDF extractor emits these between pages, and they end
   up inside whatever section happens to span the page break - "1 of 2"
   became one of the candidate's skills. */
const PAGE_MARKER = /^\s*(?:-{1,3}\s*)?(?:page\s*)?\d{1,3}\s*(?:of|\/)\s*\d{1,3}\s*(?:-{1,3})?\s*$/gim;

export function sanitize(raw) {
  return String(raw || '')
    .replace(PAGE_MARKER, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[ --]/g, ' ')
    .replace(/ /g, ' ')
    .replace(/[​-‍﻿]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, MAX_TEXT_CHARS)
    .trim();
}
