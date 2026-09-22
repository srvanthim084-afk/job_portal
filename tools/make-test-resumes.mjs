/**
 * Builds real resume files to test extraction against.
 *
 * Not fixtures of extracted text - actual .docx, .pdf and .txt files, made
 * the way the real ones are, so the parsers have to do real work. A test
 * that feeds the extractor a string it already knows proves nothing.
 *
 * The DOCX is a genuine OOXML package (zip + document.xml) containing
 * headings, ordinary paragraphs, bullets and a TABLE, because a table is
 * where naive "read the file as text" approaches fall over. The PDF is a
 * real two-page PDF with a text layer.
 *
 *   node tools/make-test-resumes.mjs [outDir]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';

const OUT = process.argv[2] || join('var', 'test-resumes');
mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ *
 * a minimal zip writer (a .docx is a zip - no dependency needed)
 * ------------------------------------------------------------------ */
function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(0, 10);          // time
    local.writeUInt16LE(0, 12);          // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, comp);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(0, 42);            // local header offset
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuf, end]);
}

/* ------------------------------------------------------------------ *
 * the resume content — one person, stated once, so a test can assert
 * that the extractor found exactly these values
 * ------------------------------------------------------------------ */
export const EXPECTED = {
  name: 'Sravanthi Reddy',
  email: 'sravanthi.reddy@example.com',
  phone: '9876543210',
  location: 'Hyderabad',
  title: 'Senior Software Engineer',
  company: 'TechNova Solutions',
  skills: ['Java', 'Spring Boot', 'PostgreSQL', 'React', 'AWS'],
  linkedin: 'https://linkedin.com/in/sravanthi-reddy',
  github: 'https://github.com/sravanthi-r',
};

const p = (text, style) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}` +
  `<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const row = (a, b) =>
  `<w:tr><w:tc><w:p><w:r><w:t xml:space="preserve">${a}</w:t></w:r></w:p></w:tc>` +
  `<w:tc><w:p><w:r><w:t xml:space="preserve">${b}</w:t></w:r></w:p></w:tc></w:tr>`;

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${p(EXPECTED.name, 'Heading1')}
    ${p(`${EXPECTED.title} | ${EXPECTED.location}, India`)}
    ${p(`Email: ${EXPECTED.email} | Mobile: ${EXPECTED.phone}`)}
    ${p(`LinkedIn: ${EXPECTED.linkedin}`)}
    ${p(`GitHub: ${EXPECTED.github}`)}

    ${p('Professional Summary', 'Heading2')}
    ${p('Senior Software Engineer with 7 years of experience building and ' +
        'operating backend services for staffing and recruitment products. ' +
        'Comfortable owning a service from schema to production.')}

    ${p('Key Skills', 'Heading2')}
    ${EXPECTED.skills.map((s) => p(`• ${s}`, 'ListParagraph')).join('\n    ')}

    ${p('Experience', 'Heading2')}
    ${p(`${EXPECTED.company} — ${EXPECTED.title} (2021 - Present)`)}
    ${p('• Led the migration of the applicant pipeline to PostgreSQL ' +
        'with row-level security.', 'ListParagraph')}
    ${p('• Cut resume screening time by automating extraction.', 'ListParagraph')}
    ${p('InnovateSoft — Software Engineer (2018 - 2021)')}
    ${p('• Built the candidate search service in Java and Spring Boot.', 'ListParagraph')}

    ${p('Education', 'Heading2')}
    <w:tbl>
      <w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>
      ${row('Qualification', 'Institution')}
      ${row('B.Tech, Computer Science', 'JNTU Hyderabad, 2018')}
      ${row('Intermediate (MPC)', 'Narayana Junior College, 2014')}
    </w:tbl>

    ${p('Other Details', 'Heading2')}
    <w:tbl>
      ${row('Total Experience', '7 years')}
      ${row('Current Company', EXPECTED.company)}
      ${row('Notice Period', '30 days')}
      ${row('Current Location', EXPECTED.location)}
      ${row('Preferred Location', 'Hyderabad, Bengaluru')}
      ${row('Expected Salary', '28 LPA')}
      ${row('Current Salary', '22 LPA')}
      ${row('Languages', 'English, Telugu, Hindi')}
    </w:tbl>

    ${p('Certifications', 'Heading2')}
    ${p('• AWS Certified Solutions Architect – Associate (2023)', 'ListParagraph')}
  </w:body>
</w:document>`;

const docx = zip({
  '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
  '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  // Real Word documents always ship styles.xml. Leaving it out made mammoth
  // throw on the table's w:tblStyle reference - a fixture bug, but a useful
  // one: it is exactly the shape of malformed DOCX the server must survive.
  'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>
  <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>
</w:styles>`,
  'word/document.xml': documentXml,
});
writeFileSync(join(OUT, 'Resume - Sravanthi.docx'), docx);

/* ------------------------------------------------------------------ *
 * plain text — the same person, so every parser can be held to the
 * same expected result
 * ------------------------------------------------------------------ */
const txt = [
  EXPECTED.name,
  `${EXPECTED.title} | ${EXPECTED.location}, India`,
  `Email: ${EXPECTED.email} | Mobile: ${EXPECTED.phone}`,
  `LinkedIn: ${EXPECTED.linkedin}`,
  `GitHub: ${EXPECTED.github}`,
  '',
  'PROFESSIONAL SUMMARY',
  'Senior Software Engineer with 7 years of experience building backend services.',
  '',
  'KEY SKILLS',
  EXPECTED.skills.join(', '),
  '',
  'EXPERIENCE',
  `${EXPECTED.company} - ${EXPECTED.title} (2021 - Present)`,
  'InnovateSoft - Software Engineer (2018 - 2021)',
  '',
  'EDUCATION',
  'B.Tech, Computer Science - JNTU Hyderabad, 2018',
  '',
  'Total Experience: 7 years',
  'Notice Period: 30 days',
  'Current Location: Hyderabad',
  'Preferred Location: Hyderabad, Bengaluru',
  'Expected Salary: 28 LPA',
  'Current Salary: 22 LPA',
  'Languages: English, Telugu, Hindi',
].join('\n');
writeFileSync(join(OUT, 'Resume - Sravanthi.txt'), txt, 'utf8');

/* ------------------------------------------------------------------ *
 * a real TWO-PAGE pdf with a text layer
 *
 * Written by hand rather than with a library, because the point is to
 * have a genuine PDF: two page objects, two content streams, so an
 * extractor that stops after page one is caught.
 * ------------------------------------------------------------------ */
function pdf(pages) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };

  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  const contentIds = [];

  for (const lines of pages) {
    const stream = 'BT /F1 11 Tf 56 760 Td 14 TL\n' +
      lines.map((l) => `(${String(l).replace(/([()\\])/g, '\\$1')}) Tj T*`).join('\n') +
      '\nET';
    contentIds.push(add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
  }

  const pagesId = objs.length + pages.length + 1;
  for (let i = 0; i < pages.length; i++) {
    pageIds.push(add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`));
  }
  add(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  const rootId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let out = '%PDF-1.4\n';
  const offsets = [0];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${rootId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

writeFileSync(join(OUT, 'Resume - Sravanthi.pdf'), pdf([
  [
    EXPECTED.name,
    `${EXPECTED.title} | ${EXPECTED.location}, India`,
    `Email: ${EXPECTED.email} | Mobile: ${EXPECTED.phone}`,
    `LinkedIn: ${EXPECTED.linkedin}`,
    '',
    'PROFESSIONAL SUMMARY',
    'Senior Software Engineer with 7 years of experience.',
    '',
    'KEY SKILLS',
    EXPECTED.skills.join(', '),
  ],
  [
    // page two — an extractor that stops at page one never sees these
    'EXPERIENCE',
    `${EXPECTED.company} - ${EXPECTED.title} (2021 - Present)`,
    'InnovateSoft - Software Engineer (2018 - 2021)',
    '',
    'EDUCATION',
    'B.Tech, Computer Science - JNTU Hyderabad, 2018',
    '',
    'Notice Period: 30 days',
    'Expected Salary: 28 LPA',
    `GitHub: ${EXPECTED.github}`,
  ],
]));

/* An empty-ish file, to prove "no readable text" is reported as its own
   case rather than as a parse failure. */
writeFileSync(join(OUT, 'Empty resume.txt'), '   \n\n  \n', 'utf8');

console.log(`wrote test resumes to ${OUT}`);
