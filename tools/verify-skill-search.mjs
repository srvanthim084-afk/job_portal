/**
 * Searching by skill finds the people who have that skill.
 *
 *     node tools/verify-skill-search.mjs      (dev server on :4323)
 *
 * THREE SEPARATE FAULTS MADE THIS SCREEN ALWAYS EMPTY, and each one was
 * enough on its own:
 *
 *   1  The API matched skills with a PostgreSQL array overlap, which is
 *      exact and case-SENSITIVE. Twenty-one candidates have "Python";
 *      a recruiter typing "python" matched none of them.
 *
 *   2  The same overlap was exact, so "Advanced Excel" and "Excel Sheet"
 *      were not "Excel" - a fraction of the people with a skill came back.
 *
 *   3  `profile_active_days_ago` was only ever written by the demo seed.
 *      Every real candidate has it NULL, the screen reads a missing value
 *      as 999 days, and its default filter is "active in the last 6
 *      months" - so the result was ZERO whatever was typed.
 *
 * All three are asserted below against the real database, through the
 * real API and the real screen, and the word-boundary case is asserted
 * in both directions: "excel" must find "Advanced Excel" and must NOT
 * find "Excellent Communication in English".
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const api = async (m, p, b) => {
  const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
    .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })), [m, p, b]);
  if (r.ok) return r.v;
  throw new Error(`${r.c || 'FAILED'}: ${r.m || ''}`);
};

/*
 * As the RECRUITER, not as an admin. Find Candidates is a recruiter
 * screen - an admin session renders no results panel at all, and the
 * count this suite reads comes back as "not found" rather than as a
 * number, which reads like a passing test that checked nothing.
 */
await api('post', '/auth/login', {
  email: process.env.TL_RECRUITER || 'teamlinkmed001@tmlink.in',
  password: process.env.TL_RECRUITER_PASSWORD || 'Teamlink@2026',
  role: 'recruiter',
});

/* ---- what the data actually holds, counted here ------------------- */
const all = await api('get', '/candidates?limit=500');
const items = all.candidates || all.items || [];
check(items.length > 0, `there are candidates to find (${all.total})`);

const skillsOf = (c) => [...(c.skills || []), ...(c.technicalSkills || [])];
const wordRx = (t) => new RegExp(`(^|[^a-z0-9])${t}($|[^a-z0-9])`, 'i');

/** Everyone whose skills contain the term as a whole word. */
const expected = (term) => items
  .filter((c) => skillsOf(c).some((s) => wordRx(term).test(String(s))))
  .map((c) => c.id);

/* ---- the API finds them ------------------------------------------- */
console.log('\nthe API');
for (const term of ['python', 'excel', 'sql']) {
  const want = expected(term);
  const got = await api('get', `/candidates?skills=${encodeURIComponent(term)}&limit=500`);
  const gotIds = (got.candidates || got.items || []).map((c) => c.id);
  check(want.length > 0, `  "${term}" is a skill somebody on file has (${want.length} of them)`);
  check(got.total === want.length,
    `  searching "${term}" returns all ${want.length} of them (got ${got.total})`);
  const missing = want.filter((id) => !gotIds.includes(id));
  check(missing.length === 0, `  and none is missed (${missing.length} missed)`);
}

/* ---- case does not matter ----------------------------------------- */
const lower = await api('get', '/candidates?skills=python&limit=1');
const upper = await api('get', '/candidates?skills=PYTHON&limit=1');
const mixed = await api('get', '/candidates?skills=Python&limit=1');
check(lower.total === upper.total && upper.total === mixed.total && lower.total > 0,
  `case does not change the answer (python ${lower.total}, PYTHON ${upper.total}, Python ${mixed.total})`);

/* ---- whole word, both directions ---------------------------------- */
console.log('\nwhole words, not fragments');
const excel = await api('get', '/candidates?skills=excel&limit=500');
const excelIds = (excel.candidates || excel.items || []).map((c) => c.id);

const hasPhrase = items.filter((c) => skillsOf(c).some((s) => /^Advanced Excel$|^Excel Sheet$/i.test(String(s))));
check(hasPhrase.length > 0, `  somebody's skill is a PHRASE containing Excel (${hasPhrase.length})`);
check(hasPhrase.every((c) => excelIds.includes(c.id)),
  '  "excel" finds them, so an exact match is not required');

const onlyExcellent = items.filter((c) => {
  const sk = skillsOf(c).map(String);
  return sk.some((s) => /excellent/i.test(s)) && !sk.some((s) => wordRx('excel').test(s));
});
check(onlyExcellent.every((c) => !excelIds.includes(c.id)),
  `  and "Excellent Communication" is NOT an Excel skill (${onlyExcellent.length} such candidate(s), none returned)`);

/* A term made of regex metacharacters must be searched for literally. */
let ok = true;
try { await api('get', '/candidates?skills=' + encodeURIComponent('C++')); } catch { ok = false; }
check(ok, '  a skill like "C++" is searched literally instead of failing to compile');

/* ---- the profile is not 999 days stale ---------------------------- */
console.log('\nhow recently the profile was active');
const stale = items.filter((c) => c.profileActiveDaysAgo === undefined || c.profileActiveDaysAgo === null);
check(stale.length === 0,
  `every candidate has a real "active N days ago" (${stale.length} still have none)`);
const within6m = items.filter((c) => Number(c.profileActiveDaysAgo) <= 180);
check(within6m.length > 0,
  `and ${within6m.length} of ${items.length} fall inside the screen's default 6-month filter`);

/* ---- the screen itself -------------------------------------------- */
console.log('\nthe Find Candidates screen');
await page.evaluate(() => window.TL.refresh());
await page.waitForTimeout(1500);
await page.evaluate(() => { location.hash = '#/recruiter/find-candidates'; });
await page.waitForTimeout(2500);

const onScreen = await page.evaluate(() => {
  if (!window.STATE || !window.STATE.fcr) return { error: 'no search state' };
  // Through the screen's own pipeline, with its own default filters.
  const before = typeof window.getFilteredCandidates === 'function'
    ? window.getFilteredCandidates((window.DATA.candidates || []).filter(Boolean)).length : -1;
  return { pool: (window.DATA.candidates || []).length, afterBase: before,
           duration: window.STATE.fcr.duration };
});
check(!onScreen.error, `the search screen is loaded (${JSON.stringify(onScreen)})`);
check(onScreen.pool > 0, `  it has candidates to search (${onScreen.pool})`);
check(onScreen.afterBase > 0,
  `  and they survive the screen's default filters (${onScreen.afterBase} of ${onScreen.pool})`);

/*
 * Driven the way a recruiter drives it: type in the keyword box, press
 * Search, read the heading. This is the number in the screenshot that
 * said "0 Candidates", and it comes from the SERVER's count - which is
 * why it has to be read from the screen and not recomputed here.
 */
const searchFor = async (kw) => {
  await page.evaluate((k) => {
    window.STATE.candidateSearch.basic.keyword = k;
    window.runCandidateSearch();
  }, kw);
  await page.waitForTimeout(2000);
  return page.evaluate(() => {
    const n = document.querySelector('.fcr-count-num');
    const m = n && String(n.textContent).match(/([\d,]+)\s+Candidate/i);
    return m ? Number(m[1].replace(/,/g, '')) : -1;
  });
};

const blank = await searchFor('');
check(blank === items.length,
  `Search with no keyword shows every candidate (${blank} of ${items.length})`);

for (const term of ['python', 'excel']) {
  const n = await searchFor(term);
  check(n > 0, `searching "${term}" on the screen returns candidates (${n})`);
  check(n <= items.length, `  and not more than exist (${n} <= ${items.length})`);
}

/*
 * A term nobody has must still return nothing. Without this the suite
 * would pass just as well on a screen that ignored the keyword box.
 */
const none = await searchFor('zzznotaskillanybodyhas');
check(none === 0, `a skill nobody has returns nothing (${none})`);

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
await browser.close();
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
