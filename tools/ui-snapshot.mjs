/**
 * UI fidelity harness.
 *
 * The requirement is that the frontend stays visually identical while the
 * data layer is replaced. This records, for every major screen at desktop
 * AND mobile width:
 *
 *   1. a PNG screenshot
 *   2. a STRUCTURAL FINGERPRINT — the DOM skeleton with all text and data
 *      values stripped, leaving tag names, classes and layout attributes
 *   3. the computed styles that constitute the design (colours, fonts,
 *      spacing, borders, shadows, radii) plus the :root design tokens
 *   4. navigation order, captured explicitly
 *
 * Why a fingerprint rather than pixels alone: once the app is backed by a
 * real database the VALUES on screen legitimately change (a real applied
 * date instead of "2 days ago"), and pixel diffs would flag every one of
 * those, burying any real regression. The fingerprint ignores values and
 * catches exactly what must not move.
 *
 * Two sources of harmless variance are handled deliberately, because the
 * prototype exhibits both between two runs of itself:
 *   - sibling ORDER (candidate-home shuffles recommended job cards)
 *   - sub-pixel width/height jitter from font metrics
 * Ignoring them is what makes a failure mean something.
 *
 *   node tools/ui-snapshot.mjs capture <label>
 *   node tools/ui-snapshot.mjs compare <a> <b>
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const MODE  = process.argv[2] || 'capture';
const LABEL = process.argv[3] || 'baseline';
const BASE  = process.env.TL_URL || 'http://127.0.0.1:4321/prototype.html';
const OUT   = join('ui-snapshots', LABEL);

const PUBLIC_ROUTES = [
  ['home',            '/'],
  ['jobs-search',     '/jobs'],
  ['job-detail',      '/job/j1'],
  ['company',         '/company/technova'],
  ['login-candidate', '/login/candidate'],
  ['login-recruiter', '/login/recruiter'],
  ['login-client',    '/login/client'],
  ['login-admin',     '/login/admin'],
  ['register',        '/register/candidate'],
  ['ai-pipeline',     '/ai-pipeline'],
  ['whatsapp-demo',   '/whatsapp-demo'],
];

const ROLE_ROUTES = [
  ['candidate', 'cand1', ['home','profile','applications','saved','alerts','interviews','messages','settings']],
  ['recruiter', 'r1',    ['home','copilot','jobs','candidates','pipeline','interviews','find-candidates','comm','settings']],
  ['client',    'c1',    ['jobs','candidates','interviews','offers']],
  ['admin',     'a1',    ['users','jobs','candidates','applications','interviews','recruiters','notifications','settings']],
];

// Emails of the seeded profiles, for the backend-backed build. The
// prototype signed in by calling loginAs() directly; the integrated build
// cannot (the server decides who you are), so the harness authenticates
// for real against the same API a person would.
const LOGIN = {
  candidate: 'ananya.rao@example.com',
  recruiter: 'recruiter@teamlink.com',
  client:    'client@teamlink.com',
  admin:     'admin@teamlink.com',
};
const DEV_PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';

/**
 * Signs in whichever way the page supports.
 *
 * The baseline prototype has no backend, so loginAs() is the only option.
 * The integrated build has window.TL and requires a real credential. Both
 * must reach the same screens or the comparison is meaningless.
 */
async function signIn(page, role, profileId) {
  const integrated = await page.evaluate(() => !!window.TL);
  if (!integrated) {
    await page.evaluate(([r, i]) => window.loginAs(r, i), [role, profileId]);
    return true;
  }
  const res = await page.evaluate(async ([email, password, r]) => {
    try {
      await window.TL.api.post('/auth/login', { email, password, role: r });
      await window.TL.refresh();
      // STATE is a top-level `const`, so it is a global LEXICAL binding:
      // reachable by bare name, but not a property of window.
      return { ok: true, session: STATE.session };
    } catch (e) {
      return { ok: false, error: e && (e.code || e.message) };
    }
  }, [LOGIN[role], DEV_PASSWORD, role]);
  if (!res.ok) throw new Error(`sign-in as ${role} failed: ${res.error}`);
  return true;
}

async function signOut(page) {
  const integrated = await page.evaluate(() => !!window.TL);
  await page.evaluate(async (isIntegrated) => {
    if (isIntegrated) { try { await window.TL.api.post('/auth/logout', {}); } catch (e) {} 
      try { await window.TL.refresh(); } catch (e) {} }
    else if (window.doLogout) window.doLogout();
  }, integrated);
}

const VIEWPORTS = [['desktop', 1440, 900], ['mobile', 390, 844]];

/* ------------------------------------------------------------------ *
 * Runs inside the page. Must be self-contained.
 * ------------------------------------------------------------------ */
function FINGERPRINT() {
  const KEEP_ATTR = ['class','type','role','aria-label','placeholder',
                     'colspan','rowspan','disabled','checked'];

  const norm = (s) => String(s)
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '#')
    .replace(/\d+/g, '#');

  // `sorted` makes sibling order irrelevant — see the header note.
  // mode: 'exact' keeps order | 'sorted' ignores order
  //       'layout' ignores order AND repetition, so N rows of the same
  //       markup hash identically to M rows. That separates "the design
  //       moved" from "there are fewer records" — the latter being the
  //       expected consequence of scoping data per role.
  const walk = (el, depth, mode) => {
    if (depth > 40) return '';
    const parts = [el.tagName.toLowerCase()];
    for (const a of KEEP_ATTR) {
      if (el.hasAttribute && el.hasAttribute(a)) {
        parts.push(a + '=' + norm(el.getAttribute(a)));
      }
    }
    let kids = Array.from(el.children).map(c => walk(c, depth + 1, mode));
    if (mode !== 'exact') kids.sort();
    if (mode === 'layout') kids = Array.from(new Set(kids));
    return '<' + parts.join(' ') + '>' + kids.join('');
  };

  // Deliberately NOT width/height: those are content-derived, and real data
  // legitimately changes them. Everything below is design.
  const STYLE_PROPS = ['color','background-color','background-image','font-family',
    'font-size','font-weight','line-height','letter-spacing','padding','margin',
    'border','border-radius','box-shadow','display','flex-direction',
    'justify-content','align-items','gap','grid-template-columns',
    'text-transform','opacity'];

  // fractional px from font metrics is jitter, not a restyle
  const roundPx = (v) => String(v).replace(/(\d+\.\d+)px/g,
    (_, n) => (Math.round(parseFloat(n) * 2) / 2) + 'px');

  const sampleStyles = () => {
    const out = {};
    const seen = new Set();
    for (const el of Array.from(document.querySelectorAll('#app *'))) {
      if (typeof el.className !== 'string') continue;
      const key = el.tagName + '.' + el.className;
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > 400) break;
      const cs = getComputedStyle(el);
      const rec = {};
      for (const p of STYLE_PROPS) rec[p] = roundPx(cs.getPropertyValue(p));
      out[key] = rec;
    }
    return out;
  };

  // the :root palette and type scale
  const rootTokens = () => {
    const cs = getComputedStyle(document.documentElement);
    const names = new Set();
    for (const sheet of Array.from(document.styleSheets)) {
      let rules = [];
      try { rules = Array.from(sheet.cssRules); } catch (e) { continue; }
      for (const r of rules) {
        if (!r.style) continue;
        for (const n of Array.from(r.style)) if (n.indexOf('--') === 0) names.add(n);
      }
    }
    const out = {};
    for (const n of names) out[n] = cs.getPropertyValue(n).trim();
    return out;
  };

  // Navigation order is called out explicitly in the requirements, so it
  // gets a deterministic check of its own.
  const navOrder = () => {
    const pick = (sel) => Array.from(document.querySelectorAll(sel))
      .map(a => (a.textContent || '').trim().replace(/\s+/g, ' '))
      .filter(Boolean).slice(0, 40);
    return {
      header:  pick('header nav a, .site-nav a, .topbar a'),
      sidebar: pick('.dash-side a, .side-nav a, aside nav a'),
      tabs:    pick('.tabs a, .tabs button, .seg a, .seg button'),
    };
  };

  const app = document.getElementById('app');
  return {
    nav: navOrder(),
    skeletonLayout: app ? walk(app, 0, 'layout') : '',
    skeletonSorted: app ? walk(app, 0, 'sorted') : '',
    skeleton:       app ? walk(app, 0, 'exact')  : '',
    nodeCount: app ? app.querySelectorAll('*').length : 0,
    styles: sampleStyles(),
    tokens: rootTokens(),
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  };
}

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/* ------------------------------------------------------------------ */
async function capture() {
  const browser = await chromium.launch();
  const record = { label: LABEL, url: BASE, at: new Date().toISOString(), screens: {}, errors: [] };

  for (const [vpName, width, height] of VIEWPORTS) {
    const ctx  = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('console',   m => { if (m.type() === 'error') record.errors.push(`${vpName}: ${m.text()}`); });
    page.on('pageerror', e => record.errors.push(`${vpName} pageerror: ${e.message}`));

    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForTimeout(700);
    // the integrated build holds the first paint until /api/bootstrap lands
    await page.waitForFunction(() => !window.TL || window.TL.ready === true,
      { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(300);

    const shots = PUBLIC_ROUTES.map(([n, r]) => [n, r, null, null]);
    for (const [role, id, subs] of ROLE_ROUTES)
      for (const sub of subs) shots.push([`${role}-${sub}`, `/${role}/${sub}`, role, id]);

    let signedInAs = null;
    for (const [name, route, role, id] of shots) {
      if (role && signedInAs !== role) {
        await signIn(page, role, id);
        await page.waitForTimeout(320);
        signedInAs = role;
      } else if (!role && signedInAs) {
        await signOut(page);
        await page.waitForTimeout(280);
        signedInAs = null;
      }

      await page.evaluate((r) => { location.hash = '#' + r; }, route);
      await page.waitForTimeout(400);

      const fp = await page.evaluate(FINGERPRINT);
      const dir = join(OUT, vpName);
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: join(dir, `${name}.png`) });

      record.screens[`${vpName}/${name}`] = {
        layoutHash:    sha(fp.skeletonLayout),
        structureHash: sha(fp.skeletonSorted),
        orderHash:     sha(fp.skeleton),
        nav: fp.nav,
        nodeCount: fp.nodeCount,
        styles: fp.styles,
        tokens: fp.tokens,
        overflow: fp.scrollW > fp.clientW ? fp.scrollW - fp.clientW : 0,
      };
    }
    await ctx.close();
  }

  await browser.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'fingerprint.json'), JSON.stringify(record, null, 1));

  const n  = Object.keys(record.screens).length;
  const ov = Object.entries(record.screens).filter(([, s]) => s.overflow > 0);

  // A route that renders nothing compares as "identical" to another route
  // that renders nothing, so a typo in the route list silently removes a
  // screen from the suite. This is what caught `recruiter/find` being
  // captured blank in BOTH builds while the comparison reported no change.
  // Low enough not to flag genuinely compact screens (a login page is ~74
  // nodes) but high enough to catch a route that rendered nothing at all.
  const THIN = 40;
  const thin = Object.entries(record.screens)
    .filter(([, s]) => s.nodeCount < THIN)
    .map(([k, s]) => `${k}(${s.nodeCount} nodes)`);

  console.log(`captured ${n} screens -> ${OUT}`);
  if (thin.length) {
    console.log(`WARNING — these screens rendered almost nothing, so they prove nothing.`);
    console.log(`          Check the route actually exists: ${thin.join(', ')}`);
  }
  console.log(`console errors: ${record.errors.length}`);
  console.log(ov.length
    ? `horizontal overflow: ${ov.map(([k, s]) => `${k}(+${s.overflow}px)`).join(', ')}`
    : 'horizontal overflow: none');
}

/* ------------------------------------------------------------------ */
function compare(aLabel, bLabel) {
  const load = (l) => {
    const p = join('ui-snapshots', l, 'fingerprint.json');
    if (!existsSync(p)) { console.log(`missing recording: ${p}`); process.exit(1); }
    return JSON.parse(readFileSync(p, 'utf8'));
  };
  const A = load(aLabel), B = load(bLabel);
  const keys = [...new Set([...Object.keys(A.screens), ...Object.keys(B.screens)])].sort();

  let structural = 0, styling = 0, missing = 0, ok = 0, dataOnly = 0;
  const report = [], notes = [];

  for (const k of keys) {
    const a = A.screens[k], b = B.screens[k];
    if (!a || !b) { missing++; report.push(`  MISSING  ${k} (only in ${a ? aLabel : bLabel})`); continue; }

    const issues = [], soft = [];

    if (a.structureHash !== b.structureHash) {
      if (a.layoutHash === b.layoutHash) {
        // Same markup, different number of repeated rows: what per-role
        // data scoping looks like. The DESIGN is unchanged.
        dataOnly++;
        soft.push(`same layout, ${a.nodeCount} -> ${b.nodeCount} nodes ` +
                  `(fewer rows — expected where the backend scopes data by role)`);
      } else {
        structural++;
        issues.push(`LAYOUT changed (nodes ${a.nodeCount} -> ${b.nodeCount})`);
      }
    } else if (a.orderHash !== b.orderHash) {
      soft.push('sibling order differs (the prototype also varies this between its own runs)');
    }

    for (const region of ['header', 'sidebar', 'tabs']) {
      const na = JSON.stringify((a.nav || {})[region] || []);
      const nb = JSON.stringify((b.nav || {})[region] || []);
      if (na !== nb) {
        structural++;
        issues.push(`NAV ORDER (${region}) changed:\n               ${na}\n            -> ${nb}`);
      }
    }

    for (const t of Object.keys(a.tokens || {})) {
      if (a.tokens[t] !== b.tokens[t]) {
        issues.push(`design token ${t}: ${a.tokens[t]} -> ${b.tokens[t]}`);
      }
    }

    let styleDiffs = 0;
    for (const sel of Object.keys(a.styles)) {
      const sa = a.styles[sel], sb = b.styles[sel];
      if (!sb) continue;
      for (const p of Object.keys(sa)) {
        if (sa[p] !== sb[p]) {
          styleDiffs++;
          if (styleDiffs <= 3) issues.push(`${sel} { ${p}: ${sa[p]} -> ${sb[p]} }`);
        }
      }
    }
    if (styleDiffs) {
      styling++;
      if (styleDiffs > 3) issues.push(`...and ${styleDiffs - 3} more style differences`);
    }

    if (b.overflow > (a.overflow || 0)) {
      issues.push(`NEW horizontal overflow +${b.overflow}px`);
    }

    if (issues.length) report.push(`  CHANGED  ${k}\n${issues.map(i => '             ' + i).join('\n')}`);
    else { ok++; if (soft.length) notes.push(`  note     ${k}: ${soft.join('; ')}`); }
  }

  console.log(`UI comparison: ${aLabel} -> ${bLabel}\n`);
  if (report.length) console.log(report.join('\n'));
  if (notes.length)  console.log(notes.join('\n'));
  console.log(`\n  identical: ${ok}/${keys.length}   layout: ${structural}` +
              `   styling: ${styling}   data-only: ${dataOnly}   missing: ${missing}`);
  console.log(report.length ? '\nUI CHANGED — investigate every line above' : '\nUI UNCHANGED');
  process.exitCode = report.length ? 1 : 0;
}

if (MODE === 'capture') await capture();
else compare(process.argv[3], process.argv[4]);
