/**
 * The server's saved-search matcher must give the SAME answer as the
 * Jobs screen, or an alert announces a job that Run search does not show.
 *
 * Nothing here re-describes the browser's rules. `passes()` and
 * `daysAgoOf()` are lifted out of web/index.html as they are today and
 * run in a sandbox, over the demo jobs from 0003_seed.sql, against a few
 * hundred filter combinations - each one also sent through the server's
 * normaliser, so "the stored form means the same as what was on screen"
 * is tested as well. If someone changes the page's filter, this fails
 * until the server is changed to match.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { toJob } from '../src/shapes.js';
import {
  normalizeFilters, jobMatchesFilters, makeLocationTier, nameOnlyTier,
  EXP_BANDS, WORK_MODES, JOB_TYPES, EDUCATION, POSTED,
} from '../src/search/saved-match.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

/** The text of `function name(...){...}` starting at `from`, braces balanced. */
function lift(src, signature, from = 0) {
  const at = src.indexOf(signature, from);
  assert.ok(at >= 0, `${signature} not found in web/index.html`);
  let depth = 0;
  for (let k = src.indexOf('{', at); k < src.length; k += 1) {
    if (src[k] === '{') depth += 1;
    else if (src[k] === '}') { depth -= 1; if (depth === 0) return src.slice(at, k + 1); }
  }
  throw new Error(`unbalanced ${signature}`);
}

let jobs = [];
let browserPasses;

test('load the demo jobs and the page\'s own filter', async () => {
  const db = await new PGlite();
  for (const f of ['0001_schema.sql', '0002_rls.sql', '0003_seed.sql']) {
    await db.exec(readFileSync(resolve(ROOT, 'supabase/migrations', f), 'utf8'));
  }
  const { rows } = await db.query(
    `select j.*, co.name as company_name from jobs j left join companies co on co.id = j.company_id`);
  await db.close();
  jobs = rows.map((r) => ({ ...toJob(r), companyName: r.company_name || '',
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : undefined }));
  assert.ok(jobs.length >= 10, `expected the demo jobs, got ${jobs.length}`);

  const html = readFileSync(resolve(ROOT, 'web/index.html'), 'utf8');
  const passesAt = html.indexOf('  function passes(r){');
  assert.ok(passesAt > 0, 'the Jobs screen filter (passes) was not found');
  const passesSrc = lift(html, 'function passes(r){', passesAt);
  const daysSrc = lift(html, 'function daysAgoOf(j){', html.lastIndexOf('function daysAgoOf(j){', passesAt));

  const sandbox = { STATE: { rj: { q: '', loc: '', f: {} } }, Date, Number, String, Math, isNaN };
  vm.createContext(sandbox);
  vm.runInContext(`
    const norm=v=>String(v||'').trim().toLowerCase();
    const f=()=>STATE.rj.f;
    ${daysSrc}
    ${passesSrc}
    this.passes = passes;`, sandbox);
  browserPasses = (job, screen) => {
    sandbox.STATE.rj = screen;
    return sandbox.passes({ job, company: { name: job.companyName }, matchPercentage: 0 });
  };
});

/* A small seeded generator, so a failure reproduces exactly. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

test('the server matcher agrees with the Jobs screen on every job, for 400 searches', () => {
  const r = rng(20261003);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const some = (a) => a.filter(() => r() < 0.3);
  const words = [...new Set(jobs.flatMap((j) => [
    ...String(j.title).toLowerCase().split(/\s+/), ...(j.skills || []).map((s) => s.toLowerCase()),
  ]))].filter((w) => w.length > 2);
  const companies = [...new Set(jobs.map((j) => j.companyName))];
  const places = [...new Set(jobs.map((j) => j.location).filter(Boolean))];

  let compared = 0; let matched = 0;
  for (let n = 0; n < 400; n += 1) {
    const combo = {};
    if (r() < 0.5) combo.q = r() < 0.3 ? `${pick(words)}, ${pick(words)}` : pick(words);
    if (r() < 0.2) combo.loc = pick([...places, 'Remote', 'Any Location']);
    if (r() < 0.2) combo.locations = some([...places.slice(0, 4), 'Remote', 'Any Location']);
    if (r() < 0.3) combo.exp = some(EXP_BANDS);
    if (r() < 0.25) combo.ctcMin = pick([0, 5, 10, 15, 25]);
    if (r() < 0.2) combo.ctcMax = pick([4, 8, 12, 20]);
    if (r() < 0.3) combo.modes = some(WORK_MODES);
    if (r() < 0.3) combo.types = some(JOB_TYPES);
    if (r() < 0.2) combo.skills = r() < 0.5 ? pick(words) : `${pick(words)}, ${pick(words)}`;
    if (r() < 0.2) combo.edu = pick(EDUCATION);
    if (r() < 0.2) combo.posted = pick(POSTED);
    if (r() < 0.15) combo.company = pick(companies).slice(0, 5);

    const screen = {
      q: combo.q || '', loc: combo.loc || '',
      f: {
        locations: combo.locations || [], exp: combo.exp || [],
        ctcMin: combo.ctcMin != null ? String(combo.ctcMin) : '',
        ctcMax: combo.ctcMax != null ? String(combo.ctcMax) : '',
        modes: combo.modes || [], types: combo.types || [], skills: combo.skills || '',
        edu: combo.edu || '', posted: combo.posted || '', company: combo.company || '', match: '',
      },
    };
    const norm = normalizeFilters(combo);
    assert.ok(norm.ok, `generated filters were refused: ${JSON.stringify(combo)} ${JSON.stringify(norm.details)}`);

    for (const job of jobs) {
      const page = !!browserPasses(job, screen);
      const server = jobMatchesFilters(job, norm.filters, { now: Date.now() });
      if (page) matched += 1;
      compared += 1;
      assert.equal(server, page,
        `disagreement on job ${job.id} "${job.title}" for ${JSON.stringify(combo)}: page=${page} server=${server}`);
    }
  }
  assert.ok(matched > 0 && matched < compared, 'the combinations must exercise both outcomes');
});

/* ------------------------------------------------------------------ *
 * location bands, with a small hand-made place tree
 * ------------------------------------------------------------------ */

const PLACES = {
  'andhra pradesh': { id: 'ap', name: 'Andhra Pradesh', type: 'state', lat: 15.9, lon: 79.7, state: 'Andhra Pradesh', ancestors: new Set() },
  nellore: { id: 'nel', name: 'Nellore', type: 'district', lat: 14.44, lon: 79.98, state: 'Andhra Pradesh', ancestors: new Set(['ap']) },
  kavali: { id: 'kav', name: 'Kavali', type: 'place', lat: 14.91, lon: 79.99, state: 'Andhra Pradesh', ancestors: new Set(['nel', 'ap']) },
  ongole: { id: 'ong', name: 'Ongole', type: 'district', lat: 15.5, lon: 80.04, state: 'Andhra Pradesh', ancestors: new Set(['ap']) },
  chennai: { id: 'che', name: 'Chennai', type: 'district', lat: 13.08, lon: 80.27, state: 'Tamil Nadu', ancestors: new Set(['tn']) },
  hyderabad: { id: 'hyd', name: 'Hyderabad', type: 'district', lat: 17.38, lon: 78.48, state: 'Telangana', ancestors: new Set(['tg']) },
};
for (const p of Object.values(PLACES)) p.sameName = new Set([p.id]);
const resolve2 = (n) => PLACES[String(n || '').split(',')[0].trim().toLowerCase()] || null;
const km = (a, b) => {
  const R = 6371; const rad = (d) => d * Math.PI / 180;
  const s = Math.sin(rad(b.lat - a.lat) / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

test('a location tag keeps the place, the places inside it, nearby ones and remote jobs', () => {
  const tier = makeLocationTier(resolve2, km);
  assert.equal(tier('Nellore', 'Onsite', ['Nellore'], 0), 'exact');
  assert.equal(tier('Kavali', 'Onsite', ['Nellore'], 0), 'exact', 'a town inside the district');
  assert.equal(tier('Ongole', 'Onsite', ['Nellore'], 0), 'other', '118 km is beyond the 80 km band');
  assert.equal(tier('Ongole', 'Onsite', ['Nellore'], 150), 'nearby', 'unless the candidate widened the radius');
  assert.equal(tier('Chennai', 'Onsite', ['Nellore'], 0), 'other');
  assert.equal(tier('Bengaluru', 'Remote', ['Nellore'], 0), 'remote');
  assert.equal(tier('Kavali', 'Onsite', ['Andhra Pradesh'], 0), 'exact', 'a state holds its towns');
  assert.equal(tier('Chennai', 'Onsite', ['Andhra Pradesh'], 500), 'other', 'a state has no "nearby"');
  assert.equal(tier('Hyderabad', 'Onsite', ['Chennai', 'Hyderabad'], 0), 'exact', 'any of several tags');

  const job = { title: 'Driver', location: 'Ongole', mode: 'Onsite', skills: [] };
  assert.equal(jobMatchesFilters(job, { q: 'driver', locTags: ['Nellore'] }, { locationTier: tier }), false);
  assert.equal(jobMatchesFilters(job, { q: 'driver', locTags: ['Nellore'], locKm: 150 }, { locationTier: tier }), true);
});

test('without the place tree, a tag matches its own name (and its other spelling) only', () => {
  assert.equal(nameOnlyTier('Bengaluru', 'Onsite', ['Bangalore']), 'exact');
  assert.equal(nameOnlyTier('Nellore, Andhra Pradesh', 'Onsite', ['Nellore']), 'exact');
  assert.equal(nameOnlyTier('Kavali', 'Onsite', ['Nellore']), 'other');
  assert.equal(nameOnlyTier('Anywhere', 'Remote', ['Nellore']), 'remote');
});
