/**
 * Produces web/index.html from the untouched prototype.
 *
 * The ONLY change made to the prototype is one appended <script> tag.
 * Nothing is rewritten, reformatted, templated or removed — the first
 * 1,587,110 bytes of the output are byte-identical to the input, which
 * this script asserts before writing.
 *
 * That is what makes "the UI is unchanged" checkable rather than a claim.
 *
 *   node web/build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = join(HERE, '..', 'baseline', 'prototype.html');
const OUT  = join(HERE, 'index.html');

// the exact bytes supplied by the user
const EXPECTED_SHA = '8cc4b430d496694618d72a51ce0a7cd11fe567701d3544ac852d38186efc0862';

const src = readFileSync(SRC);
const sha = createHash('sha256').update(src).digest('hex');

if (sha !== EXPECTED_SHA) {
  console.error(`\nbaseline/prototype.html has changed.\n  expected ${EXPECTED_SHA}\n  found    ${sha}\n`);
  console.error('The baseline is the visual source of truth and must not be edited.');
  console.error('If this change is intentional, re-capture the UI baseline and update EXPECTED_SHA.\n');
  process.exit(1);
}

const html = src.toString('utf8');

// Appended at the very end. The prototype ends with </style> and has no
// trailing </body>, so this is a pure append — no anchor to get wrong, and
// nothing above it shifts by a single byte.
const TAG = `
<!-- =====================================================================
     TeamLink — backend integration.
     The ONLY line added to the prototype. Everything above is the file
     exactly as supplied. This script replaces the data source; it does
     not touch the DOM, the CSS or any render function.
     ===================================================================== -->
<script src="teamlink-integration.js"></script>
`;

const out = html + TAG;

// prove the prototype survived intact
if (!out.startsWith(html)) throw new Error('output is not a pure append');
const prefix = Buffer.from(out, 'utf8').subarray(0, src.length);
if (!prefix.equals(src)) throw new Error('the first bytes of the output differ from the prototype');

mkdirSync(HERE, { recursive: true });
writeFileSync(OUT, out, 'utf8');

const added = Buffer.byteLength(TAG, 'utf8');
console.log(`wrote ${OUT}`);
console.log(`  prototype bytes preserved : ${src.length} (sha256 verified)`);
console.log(`  bytes appended            : ${added}`);
console.log(`  lines appended            : ${TAG.trim().split('\n').length}`);
