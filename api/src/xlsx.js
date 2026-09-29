/**
 * Excel files, read and written without a dependency.
 *
 * A .xlsx is a ZIP of XML: `xl/worksheets/sheet1.xml` holds the cells and
 * `xl/sharedStrings.xml` holds the text they point at. The resume
 * extractor already reads DOCX the same way (both are Open XML in a zip),
 * so the machinery is proven here rather than new.
 *
 * Why not a library: the two candidates are `xlsx`, whose free build
 * carries a known prototype-pollution advisory and is no longer published
 * to npm, and `exceljs`, which pulls in a large tree for what amounts to
 * reading a grid of strings. This file is a few hundred lines, does
 * exactly what the two features need, and cannot be the source of a
 * supply-chain surprise.
 *
 * What it handles: one sheet of text and numbers, shared strings, inline
 * strings, dates as numbers, and a header row. What it does not: formulas
 * (the cached VALUE is read, which is what an import wants anyway),
 * styles, merged cells, and the legacy binary .xls format - that last one
 * is reported clearly rather than guessed at.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

/* ------------------------------------------------------------------ *
 * zip
 * ------------------------------------------------------------------ */

/** Read one member out of a zip by name. */
/**
 * Every entry name in the archive.
 *
 * Needed because a workbook does not have to contain
 * `xl/worksheets/sheet1.xml`. Delete the first sheet in Excel and the
 * one that remains is still called sheet2.xml; some exporters number
 * from 0; Google Sheets and a few Indian job boards emit names of their
 * own. Guessing three fixed names and giving up is how a perfectly good
 * workbook came back as "has no readable worksheet".
 */
function zipNames(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.slice(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function readZipEntry(buf, wanted) {
  // Walk the central directory backwards from the end-of-central-directory
  // record; scanning local headers forwards breaks on data descriptors.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    if (name === wanted) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(start, start + compSize);
      // 8 = deflate, 0 = stored. Anything else is not something a
      // spreadsheet tool produces.
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Build a zip from {name, data} members. Deflate, no directories. */
export function makeZip(files) {
  const CRC = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return (buf) => {
      let c = -1;
      for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
      return (c ^ -1) >>> 0;
    };
  })();

  const locals = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = deflateRawSync(data, { level: 6 });
    const name = Buffer.from(f.name, 'utf8');
    const crc = CRC(data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(8, 8);             // deflate
    local.writeUInt16LE(0, 10);            // time
    local.writeUInt16LE(0x2821, 12);       // date (1 Jan 2000)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    locals.push(local, comp);

    const cen = Buffer.alloc(46 + name.length);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x2821, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(0, 38);              // external attrs
    cen.writeUInt32LE(offset, 42);
    name.copy(cen, 46);
    central.push(cen);

    offset += local.length + comp.length;
  }

  const cenBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, cenBuf, eocd]);
}

/* ------------------------------------------------------------------ *
 * writing
 * ------------------------------------------------------------------ */

const xmlEscape = (v) => String(v === undefined || v === null ? '' : v)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
  // Control characters are illegal in XML and make Excel refuse the file
  // outright with "unreadable content", which looks like corruption.
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

/** A1, B1 ... Z1, AA1 ... */
function cellRef(col, row) {
  let s = '';
  let n = col;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s + row;
}

/**
 * Write one sheet.
 *
 * @param {string[]} columns  the header row
 * @param {Array<Array<string|number|null>>} rows
 * @param {string} [sheetName]
 * @returns {Buffer} a real .xlsx
 */
export function writeSheet(columns, rows, sheetName = 'Sheet1') {
  const all = [columns, ...rows];

  const body = all.map((row, r) => {
    const cells = row.map((v, c) => {
      const ref = cellRef(c, r + 1);
      if (v === null || v === undefined || v === '') return '';
      if (typeof v === 'number' && Number.isFinite(v)) {
        return `<c r="${ref}"><v>${v}</v></c>`;
      }
      // inlineStr avoids a shared-string table: simpler, and a few
      // kilobytes larger on files of this size.
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');

  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<sheetData>${body}</sheetData></worksheet>`;

  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets><sheet name="${xmlEscape(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '</Relationships>';

  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>';

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '</Types>';

  return makeZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

/* ------------------------------------------------------------------ *
 * reading
 * ------------------------------------------------------------------ */

function sharedStrings(buf) {
  const xml = readZipEntry(buf, 'xl/sharedStrings.xml');
  if (!xml) return [];
  const text = xml.toString('utf8');
  const out = [];
  // Each <si> may hold one <t> or several inside <r> runs; the runs have
  // to be joined or "Rahul Kumar" arrives as "Rahul" when Excel has split
  // it for formatting.
  const si = text.match(/<si>[\s\S]*?<\/si>/g) || [];
  for (const one of si) {
    const parts = [...one.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]);
    out.push(unescapeXml(parts.join('')));
  }
  return out;
}

const unescapeXml = (v) => String(v)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&amp;/g, '&');

const colOf = (ref) => {
  const m = /^([A-Z]+)/.exec(String(ref || ''));
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/**
 * Read the first worksheet as a grid of strings.
 *
 * @param {Buffer} buf  the .xlsx file
 * @returns {string[][]} rows, ragged edges filled with ''
 */
export function readSheet(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) throw new Error('That file is empty.');

  // The legacy binary format is not a zip and cannot be read here. Say so
  // precisely rather than failing with "corrupt".
  if (buf[0] === 0xd0 && buf[1] === 0xcf) {
    /*
     * A PASSWORD-PROTECTED .xlsx IS ALSO A CFB FILE, and telling
     * somebody to "save it as .xlsx" when it already is one, and is
     * merely encrypted, sends them round in a circle. Excel writes
     * "EncryptedPackage" into the container, so the two are
     * distinguishable and are worth distinguishing.
     */
    const head = buf.slice(0, Math.min(buf.length, 8192)).toString('latin1');
    if (head.replace(/\u0000/g, '').indexOf('EncryptedPackage') >= 0) {
      const err = new Error(
        'That workbook is password-protected, so it cannot be read. Open it in '
        + 'Excel, remove the password under File -> Info -> Protect Workbook, '
        + 'and save it again.');
      err.code = 'ENCRYPTED_FILE';
      throw err;
    }
    const err = new Error(
      'That is a legacy Excel 97-2003 file (.xls). Open it in Excel and use '
      + 'Save As -> Excel Workbook (.xlsx), or Save As -> CSV.');
    err.code = 'LEGACY_XLS';
    throw err;
  }
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    const err = new Error('That file is not an Excel workbook.');
    err.code = 'NOT_XLSX';
    throw err;
  }

  const strings = sharedStrings(buf);

  /*
   * THE FIRST SHEET WITH SOMETHING IN IT, not the one called "sheet1".
   *
   * Three fixed names were tried and the workbook was declared
   * unreadable if none of them existed. A workbook whose first sheet was
   * deleted has no sheet1.xml at all, and a workbook whose first tab is
   * a cover page has one that is empty - both are ordinary files that a
   * recruiter would expect to import.
   *
   * The archive is listed instead, the worksheets are taken in their
   * natural order, and the first one that actually contains rows wins.
   */
  const sheetNames = zipNames(buf)
    .filter((n) => /^xl\/worksheets\/[^/]+\.xml$/i.test(n))
    .sort((a, b) => {
      const num = (x) => Number((/(\d+)\.xml$/i.exec(x) || [])[1] || 1e9);
      return num(a) - num(b) || a.localeCompare(b);
    });

  if (!sheetNames.length) {
    const err = new Error('That workbook has no worksheet in it.');
    err.code = 'NO_WORKSHEET';
    throw err;
  }

  let sheetXml = null;
  let xml = '';
  for (const name of sheetNames) {
    const data = readZipEntry(buf, name);
    if (!data) continue;
    const candidate = data.toString('utf8');
    /* A sheet with no <row> is a cover page or a leftover tab. Keep
       looking; fall back to the first readable one if every sheet is
       empty, so the "no rows" message below is what the caller sees. */
    if (!sheetXml) { sheetXml = data; xml = candidate; }
    if (/<row[\s>]/.test(candidate)) { sheetXml = data; xml = candidate; break; }
  }
  if (!sheetXml) {
    const err = new Error('That workbook has no readable worksheet.');
    err.code = 'NO_WORKSHEET';
    throw err;
  }
  const rows = [];

  for (const rowXml of xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || []) {
    const row = [];
    for (const m of rowXml.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = m[1];
      const inner = m[2];
      const ref = (/r="([A-Z]+\d+)"/.exec(attrs) || [])[1];
      const type = (/t="([^"]+)"/.exec(attrs) || [])[1] || 'n';
      const col = ref ? colOf(ref) : row.length;

      let value = '';
      if (type === 's') {
        const idx = Number((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1]);
        value = strings[idx] !== undefined ? strings[idx] : '';
      } else if (type === 'inlineStr') {
        value = unescapeXml(
          [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
      } else if (type === 'str') {
        // A formula: the cached result is what an import wants.
        value = unescapeXml((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1] || '');
      } else {
        value = unescapeXml((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1] || '');
      }

      while (row.length < col) row.push('');
      row[col] = String(value).trim();
    }
    rows.push(row);
  }

  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return rows.map((r) => {
    const out = r.slice();
    while (out.length < width) out.push('');
    return out.map((v) => (v === undefined || v === null ? '' : String(v)));
  });
}

/**
 * Read a CSV into the same grid shape, so both formats meet in one place.
 * Handles quoted fields, embedded commas, doubled quotes and CRLF.
 */
export function readCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field.trim()); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field.trim()); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field.trim()); rows.push(row); }
  return rows.filter((r) => r.some((v) => v !== ''));
}

/**
 * Whichever the file is.
 * @returns {{rows: string[][], format: 'xlsx'|'csv'}}
 */
export function readSpreadsheet(buf, filename = '') {
  const isZip = buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b;
  const looksXlsx = isZip || /\.xlsx$/i.test(filename);
  if (looksXlsx || (buf[0] === 0xd0 && buf[1] === 0xcf)) {
    return { rows: readSheet(buf), format: 'xlsx' };
  }
  return { rows: readCsv(buf.toString('utf8')), format: 'csv' };
}
