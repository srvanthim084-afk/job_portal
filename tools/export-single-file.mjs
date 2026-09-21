/**
 * Builds ONE self-contained HTML file.
 *
 * The normal build (web/build.mjs) appends a 7-line <script src=...> tag and
 * serves web/teamlink-integration.js alongside it. That is the right shape
 * for a deployment. It is the wrong shape for "send me the file", because
 * the file alone would load and then fail to find its own integration
 * script.
 *
 * So this inlines the integration layer instead of linking it, and adds one
 * line telling the page which port the API answers on. Everything else is
 * identical, and the prototype's 1,587,110 bytes are asserted byte-for-byte
 * before anything is written - the same gate build.mjs uses.
 *
 * WHAT THIS FILE CANNOT CONTAIN
 * -----------------------------
 * The backend. It is an Express API and a PostgreSQL database holding the
 * jobs, candidates, applications and sessions; no HTML file can be either of
 * those. The page calls the API over http, so the API has to be running.
 * Opened with no API reachable the page says so plainly and loads empty -
 * it does not invent data to look healthy.
 *
 *   node tools/export-single-file.mjs [outfile] [--api-port 4323]
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const PROTOTYPE = join(ROOT, 'baseline', 'prototype.html');
const INTEGRATION = join(ROOT, 'web', 'teamlink-integration.js');

// The untouched prototype, as supplied. Asserted, never assumed.
const SHA = '8cc4b430d496694618d72a51ce0a7cd11fe567701d3544ac852d38186efc0862';
const BYTES = 1587110;

const args = process.argv.slice(2);
const portArg = args.indexOf('--api-port');
const API_PORT = portArg >= 0 ? args[portArg + 1] : '4323';
const OUT = resolve(ROOT, args.find((a) => !a.startsWith('--') && a !== API_PORT)
  || 'TeamLink_JobPortal_Backend_Integrated.html');

/* -------------------------------------------------------------- guards -- */
const proto = readFileSync(PROTOTYPE);
const sha = createHash('sha256').update(proto).digest('hex');
if (sha !== SHA || proto.length !== BYTES) {
  console.error('The baseline prototype has changed. Refusing to export.');
  console.error(`  expected ${BYTES} bytes / ${SHA}`);
  console.error(`  found    ${proto.length} bytes / ${sha}`);
  process.exit(1);
}

const integration = readFileSync(INTEGRATION, 'utf8');

// A </script> inside the inlined JS would end the block early. There is none
// today; check rather than trust, because the failure would be silent and
// total.
if (/<\/script/i.test(integration)) {
  console.error('teamlink-integration.js contains "</script" - it cannot be inlined as-is.');
  process.exit(1);
}

/* -------------------------------------------------------------- append -- */
const tail = `
<!-- =====================================================================
     TeamLink - backend integration layer, inlined.

     Everything above this line is the original prototype, byte for byte
     (${BYTES} bytes, sha256 ${SHA.slice(0, 16)}...).
     Nothing below it touches the DOM, the CSS or any render function; it
     changes only where the data comes from.

     THE API MUST BE RUNNING. This page holds the interface, not the
     database. Start it with:

         npm run dev          (serves the API on port ${API_PORT})

     then open this file from any local server on the SAME hostname, e.g.
     http://localhost:5183/. Different port is fine; different hostname is
     not - session cookies are SameSite=Lax, so localhost and 127.0.0.1
     count as different sites and the session would be dropped.

     To point it somewhere else, either edit TL_API_PORT below, or add
     ?api=<base> to the URL, e.g.
         http://localhost:5183/?api=https://jobs.example.com/api
     ===================================================================== -->
<script>
  /* The API answers on this port, on whatever hostname served this page. */
  window.TL_API_PORT = ${JSON.stringify(String(API_PORT))};
</script>
<script>
${integration}
</script>
`;

const out = Buffer.concat([proto, Buffer.from(tail, 'utf8')]);
writeFileSync(OUT, out);

/* -------------------------------------------------------------- verify -- */
const written = readFileSync(OUT);
if (!written.subarray(0, BYTES).equals(proto)) {
  console.error('The written file does not start with the prototype. Aborting.');
  process.exit(1);
}

console.log(`wrote ${OUT}`);
console.log(`  prototype bytes preserved : ${BYTES} (sha256 verified)`);
console.log(`  integration inlined       : ${integration.length} bytes`);
console.log(`  total                     : ${statSync(OUT).size} bytes`);
console.log(`  API expected on port      : ${API_PORT} (same hostname as the page)`);
console.log(`\n  ${basename(OUT)} needs the API running - it is the UI, not the database.`);
