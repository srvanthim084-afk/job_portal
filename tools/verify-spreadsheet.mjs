/**
 * Excel in, Excel out, and calling the whole filtered list.
 *
 * Three things a recruiter asked for, and each one fails in its own way:
 *
 *  - importing a real .xlsx, because the screen took only CSV and
 *    "save as CSV first" is how an import feature stops being used;
 *  - getting the call results as a real workbook, because a CSV written
 *    in the browser turns +91 90000 11111 into 9.19E+11;
 *  - calling everybody a filter matched without ticking 200 checkboxes.
 *
 * The workbook is written by our own code, so this reads it back with a
 * DIFFERENT reader (Node's zlib and a plain XML scan) rather than the one
 * that wrote it - a round trip through the same bug proves nothing.
 *
 *   node tools/verify-spreadsheet.mjs      (needs npm run dev on :4323)
 */
import { chromium } from 'playwright';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { writeSheet, readSheet, readCsv } from '../api/src/xlsx.js';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

mkdirSync('var/spreadsheets', { recursive: true });

/* ------------------------------------------------------------------ *
 * an independent reader, so the writer is not marking its own homework
 * ------------------------------------------------------------------ */
function independentRead(buf) {
  // Walk the zip's central directory and inflate the sheet, then pull the
  // text out of the XML without touching api/src/xlsx.js.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip - Excel would refuse this file');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const members = {};

  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + compSize);
    members[name] = method === 8 ? inflateRawSync(raw) : raw;
    p += 46 + nameLen + extraLen + commentLen;
  }

  const xml = String(members['xl/worksheets/sheet1.xml'] || '');
  const rows = (xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || []).map((r) =>
    [...r.matchAll(/<c[^>]*>([\s\S]*?)<\/c>/g)].map((m) => {
      const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(m[1]);
      if (t) return t[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&quot;/g, '"');
      const v = /<v>([\s\S]*?)<\/v>/.exec(m[1]);
      return v ? v[1] : '';
    }));
  return { members: Object.keys(members), rows };
}

/* ------------------------------------------------------------------ *
 * 1. the workbook itself
 * ------------------------------------------------------------------ */
console.log('\nthe workbook');

await check('a written workbook is a valid Open XML package', () => {
  const buf = writeSheet(['Name', 'Phone'], [['Rahul', '+919000011111']], 'Test');
  const out = independentRead(buf);
  for (const required of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']) {
    must(out.members.includes(required), `the package is missing ${required}`);
  }
});

await check('text, numbers and awkward characters survive the round trip', () => {
  const rows = [
    ['Rahul "Rocky" Kumar', '+91 90000 11111', 1200000],
    ['A & B <script>', 'x', 0.5],
    ['Ravi\tTab', 'y', null],
  ];
  const buf = writeSheet(['Name', 'Phone', 'CTC'], rows, 'Test');
  const back = readSheet(buf);
  must(back[1][0] === 'Rahul "Rocky" Kumar', `quotes were mangled: ${back[1][0]}`);
  must(back[2][0] === 'A & B <script>', `escaping was mangled: ${back[2][0]}`);
  must(back[1][2] === '1200000', `the number came back as ${back[1][2]}`);
  must(back[1][1] === '+91 90000 11111', `the phone number came back as ${back[1][1]}`);
});

await check('a long phone number is never turned into scientific notation', () => {
  const buf = writeSheet(['Phone'], [['919000011111']], 'Test');
  const xml = String(independentRead(buf).rows);
  must(!/E\+/i.test(xml), 'a phone number was written as a float');
  // Written as text, which is what stops Excel reformatting it.
  must(readSheet(buf)[1][0] === '919000011111', 'the phone number changed');
});

await check('a legacy .xls file is named, not guessed at', () => {
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  let msg = '';
  try { readSheet(ole); } catch (e) { msg = e.message; }
  must(/97-2003|\.xls\b/i.test(msg), `unhelpful message: ${msg}`);
  must(/xlsx|CSV/i.test(msg), 'the message does not say what to do instead');
});

await check('CSV with commas inside quoted fields is read correctly', () => {
  const rows = readCsv('Name,Location\n"Kumar, Rahul","Bengaluru, Karnataka"\n');
  must(rows[1][0] === 'Kumar, Rahul', `got ${JSON.stringify(rows[1])}`);
  must(rows[1][1] === 'Bengaluru, Karnataka', `got ${JSON.stringify(rows[1])}`);
});

/* ------------------------------------------------------------------ *
 * 2. through the API
 * ------------------------------------------------------------------ */
console.log('\nimport and export, through the API');

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const api = async (m, p, b) => {
  const r = await page.evaluate(([mm, pp, bb]) =>
    window.TL.api[mm](pp, bb).then((ok) => ({ ok: true, value: ok }),
      (e) => ({ ok: false, code: e.code, message: e.message })), [m, p, b]);
  if (r.ok) return r.value;
  throw Object.assign(new Error(`${r.code}: ${r.message}`), { code: r.code });
};

const stamp = Date.now();
await api('post', '/auth/login',
  { email: 'recruiter@teamlink.com', password: PASSWORD, role: 'recruiter' });
await page.evaluate(() => window.TL.refresh());
await page.waitForTimeout(700);

const XLSX_PATH = 'var/spreadsheets/import-test.xlsx';

await check('an .xlsx of candidates imports, columns matched by heading', async () => {
  // Deliberately NOT in the documented order, with extra columns, to
  // prove the headings are what is used.
  const buf = writeSheet(
    ['Email', 'Candidate Name', 'Key Skills', 'Mobile Number', 'Current Location',
     'Total Experience', 'Expected CTC', 'Notice Period', 'Designation'],
    [
      [`xl.a.${stamp}@example.test`, 'Ximport Alpha', 'Java; Spring Boot; SQL',
       `+91 90000 ${String(stamp).slice(-5)}`, 'Hyderabad', '5', '14 LPA', '30 days', 'Java Developer'],
      [`xl.b.${stamp}@example.test`, 'Ximport Beta', 'React; TypeScript',
       `+91 90001 ${String(stamp).slice(-5)}`, 'Bengaluru, Karnataka', '3', '9 LPA', 'Immediate', 'UI Developer'],
      ['', 'No Contact Person', 'Python', '', 'Pune', '2', '', '', ''],
    ], 'Candidates');
  writeFileSync(XLSX_PATH, buf);

  // Uploaded through the app's own api wrapper, exactly as the screen
  // does - a raw fetch would miss the CSRF token and prove nothing about
  // the path a recruiter actually takes.
  const result = await page.evaluate(async ([b64, name]) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const fd = new FormData();
    fd.append('file', new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }), name);
    return window.TL.api.post('/candidates/import', fd)
      .then((body) => ({ status: 201, body }),
            (e) => ({ status: e.status || 400, body: { error: { code: e.code, message: e.message } } }));
  }, [buf.toString('base64'), 'candidates.xlsx']);

  must(result.status === 201, `the import answered ${result.status}: ${JSON.stringify(result.body).slice(0, 200)}`);
  must(result.body.format === 'xlsx', `the file was read as ${result.body.format}`);
  must(result.body.imported === 2, `${result.body.imported} imported, expected 2`);
  must(result.body.skipped === 1, `${result.body.skipped} skipped, expected 1 (no contact details)`);
  must(/no email and no phone/i.test(result.body.detail.skipped[0].reason),
    `unhelpful skip reason: ${result.body.detail.skipped[0].reason}`);
});

await check('the imported candidate carries the fields from the file', async () => {
  await page.evaluate(() => window.TL.refresh());
  await page.waitForTimeout(700);
  const c = await page.evaluate((s) =>
    (DATA.candidates || []).find((x) => x.email === `xl.a.${s}@example.test`), stamp);
  must(c, 'the imported candidate is not in the database');
  must(c.title === 'Java Developer', `designation is "${c.title}"`);
  must(c.location === 'Hyderabad', `location is "${c.location}"`);
  must((c.skills || []).length === 3, `skills came in as ${JSON.stringify(c.skills)}`);
  must(String(c.phone || '').includes(String(stamp).slice(-5)), `phone is "${c.phone}"`);
  must(Number(c.expectedCtc) === 1400000, `expected CTC is ${c.expectedCtc}`);
});

await check('a comma inside a quoted CSV field does not split the column', async () => {
  const text = `Name,Phone,Email,Skills,Location
"Csv, Tester","+91 90002 ${String(stamp).slice(-5)}","csv.${stamp}@example.test","Go; Kubernetes","Bengaluru, Karnataka"`;
  const r = await api('post', '/candidates/import', { text });
  must(r.imported === 1, `${r.imported} imported`);

  await page.evaluate(() => window.TL.refresh());
  await page.waitForTimeout(700);
  const c = await page.evaluate((s) =>
    (DATA.candidates || []).find((x) => x.email === `csv.${s}@example.test`), stamp);
  must(c, 'the CSV candidate was not created');
  must(c.name === 'Csv, Tester', `the name split: "${c.name}"`);
  must(c.location === 'Bengaluru, Karnataka', `the location split: "${c.location}"`);
});

await check('importing the same file again updates rather than duplicating', async () => {
  const before = await page.evaluate((s) =>
    (DATA.candidates || []).filter((x) => x.email === `xl.a.${s}@example.test`).length, stamp);

  const buf = readFileSync(XLSX_PATH);
  const result = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const fd = new FormData();
    fd.append('file', new Blob([bytes]), 'again.xlsx');
    return window.TL.api.post('/candidates/import', fd);
  }, buf.toString('base64'));

  must(result.imported === 0, `${result.imported} duplicates were created`);
  must(result.updated === 2, `${result.updated} updated, expected 2`);

  await page.evaluate(() => window.TL.refresh());
  await page.waitForTimeout(700);
  const after = await page.evaluate((s) =>
    (DATA.candidates || []).filter((x) => x.email === `xl.a.${s}@example.test`).length, stamp);
  must(after === before, `the candidate now appears ${after} times`);
});

await check('the call results download as a real workbook', async () => {
  const out = await page.evaluate(async (base) => {
    const res = await fetch(base + '/ai-calling/export', { credentials: 'same-origin' });
    const buf = await res.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return {
      status: res.status,
      type: res.headers.get('content-type'),
      disposition: res.headers.get('content-disposition'),
      b64: btoa(bin),
    };
  }, await page.evaluate(() => window.TL.apiBase));

  must(out.status === 200, `the export answered ${out.status}`);
  must(/spreadsheetml\.sheet/.test(out.type || ''), `content type is ${out.type}`);
  must(/\.xlsx"/.test(out.disposition || ''), `filename is ${out.disposition}`);

  const buf = Buffer.from(out.b64, 'base64');
  writeFileSync('var/spreadsheets/ai-calls.xlsx', buf);
  const back = independentRead(buf);
  must(back.rows.length >= 2, `the workbook has ${back.rows.length} rows`);
  must(back.rows[0].includes('Candidate'), `header: ${JSON.stringify(back.rows[0])}`);
  must(back.rows[0].includes('Summary'), 'the export has no summary column');
  must(back.rows[0].includes('Outcome'), 'the export has no outcome column');
});

await check('the candidate export carries the call outcome with it', async () => {
  const ids = await page.evaluate(() => (DATA.candidates || []).slice(0, 5).map((c) => c.id));
  const out = await page.evaluate(async ([base, idList]) => {
    const res = await fetch(base + '/candidates/export?ids=' + encodeURIComponent(idList.join(',')),
      { credentials: 'same-origin' });
    const buf = await res.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return { status: res.status, b64: btoa(bin) };
  }, [await page.evaluate(() => window.TL.apiBase), ids]);

  must(out.status === 200, `the export answered ${out.status}`);
  const back = independentRead(Buffer.from(out.b64, 'base64'));
  must(back.rows[0].includes('AI calls'), `header: ${JSON.stringify(back.rows[0])}`);
  must(back.rows[0].includes('Last call outcome'), 'no call outcome column');
  must(back.rows.length === ids.length + 1, `${back.rows.length - 1} rows for ${ids.length} candidates`);
});

await check('a candidate cannot export the candidate database', async () => {
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await p2.goto(`${BASE}/`, { waitUntil: 'load' });
  await p2.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
  try {
    await p2.evaluate((s) => window.TL.api.post('/auth/register',
      { name: 'Nosy Candidate', email: `nosy.${s}@example.test`, password: 'Nosy@2026' }), stamp);
    const status = await p2.evaluate(async (base) => {
      const res = await fetch(base + '/candidates/export?ids=cand1', { credentials: 'same-origin' });
      return res.status;
    }, await p2.evaluate(() => window.TL.apiBase));
    must(status === 403, `a candidate got ${status} from the export endpoint`);
  } finally { await other.close(); }
});

/* ------------------------------------------------------------------ *
 * 3. calling the filtered list
 * ------------------------------------------------------------------ */
console.log('\ncalling what the filter matched');

await check('with nothing ticked, the modal targets the filtered set', async () => {
  await page.evaluate(() => { location.hash = '#/recruiter/find-candidates'; });
  await page.waitForTimeout(1000);

  const counts = await page.evaluate(() => {
    STATE.fcr = STATE.fcr || {};
    STATE.fcr.active = true;
    STATE.fcr.selection = {};               // nothing ticked
    STATE.fcr.skills = [];
    STATE.fcr.locs = [];
    window.render();
    const all = window.TL.callingTargets();
    // now apply a filter
    STATE.fcr.locs = ['Hyderabad'];
    const filtered = window.TL.callingTargets();
    return {
      all: all.list.length, allFrom: all.from,
      filtered: filtered.list.length, filteredFrom: filtered.from,
      everyoneIsHyderabad: filtered.list.every((c) =>
        ((c.location || '') + ' ' + (c.preferredLocation || '')).toLowerCase().includes('hyderabad')),
    };
  });

  must(counts.allFrom === 'filter', 'with nothing ticked it did not fall back to the filter');
  must(counts.filtered <= counts.all, 'the filter did not narrow anything');
  must(counts.filtered > 0, 'the location filter matched nobody at all');
  must(counts.everyoneIsHyderabad, 'the filtered set includes candidates from other cities');
});

await check('ticking rows overrides the filter', async () => {
  const out = await page.evaluate(() => {
    const first = (DATA.candidates || [])[0];
    STATE.fcr.selection = {};
    STATE.fcr.selection[first.id] = true;
    const t = window.TL.callingTargets();
    return { n: t.list.length, from: t.from, id: t.list[0] && t.list[0].id, expected: first.id };
  });
  must(out.from === 'selection', `targets came from ${out.from}`);
  must(out.n === 1 && out.id === out.expected, 'the ticked candidate was not the target');
});

await check('the modal offers to call the whole filtered list in one action', async () => {
  await page.evaluate(() => { STATE.fcr.selection = {}; STATE.fcr.locs = ['Hyderabad']; });
  await page.evaluate(() => window.fcrIvrModal());
  await page.waitForTimeout(1600);

  const text = await page.evaluate(() => document.body.innerText);
  must(/matched by your filters/i.test(text), 'the modal does not say it is using the filters');
  must(/Call all \d+ filtered/i.test(text), 'there is no one-click call-all button');
  must(/Export calls to Excel/i.test(text), 'the Excel export is not offered');
});

await check('no console errors through any of that', async () => {
  const real = consoleErrors.filter((e) => !/favicon|manifest/i.test(e));
  must(real.length === 0, `console errors: ${real.slice(0, 2).join(' | ')}`);
});

await browser.close();
console.log(failed === 0
  ? '\n  SPREADSHEETS VERIFIED — .xlsx in, .xlsx out, and one click to call the filtered list\n'
  : `\n  ${failed} check(s) FAILED\n`);
process.exit(failed ? 1 : 0);
