/* =====================================================================
   TeamLink — external jobs, in the interface
   =====================================================================

   A second additive layer, built the same way as teamlink-integration.js
   and for the same reason: the prototype must not be edited.

   WHAT THIS FILE IS ALLOWED TO DO

     - read NAV_CONFIG and append one entry to two of its lists
     - wrap window.pageCandidateDash and window.pageRecruiterDash, so a
       section name that did not previously exist renders something, and
       every section that did exist is handed straight to the original
     - inject one <style> block whose every selector begins .xj-
     - define window.xj* functions for its own onclick handlers

   WHAT IT NEVER DOES

     - edit or replace an existing render function
     - change an existing CSS rule, colour, class or layout
     - touch DATA, STATE, or any existing screen
     - show anything at all unless the server says the feature is on

   IF THE FEATURE IS OFF - which is the default - this file asks the
   server once, is told no, and stops. No nav entry, no style block, no
   wrapper behaviour. The API returns 404 for /external/config when the
   router is not mounted, and a 404 is treated as "off" rather than as an
   error worth reporting, because that is exactly what it means.

   HONESTY ABOUT WHAT "APPLIED" MEANS. Most external sources are applied
   to by sending the candidate to the advertiser's own page. TeamLink
   cannot see whether they finished, so those read "Applied - Not
   Confirmed" and say so in words. Nothing here ever displays an external
   status as though it were a TeamLink pipeline stage.
   ===================================================================== */
(function () {
  'use strict';

  var TL = window.TL;
  if (!TL) return;                      // no integration layer, nothing to hang off

  var esc = window.esc || function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  };

  /*
   * EXTERNAL JOBS AS ITS OWN HEADER, WITHOUT EDITING THE PORTAL.
   *
   * cpShell draws the candidate portal's top navigation and is a global,
   * and this file loads last — so the shell is wrapped rather than
   * changed: call the original, then append one <a> before the closing
   * </nav>. Jobs, Internships, Companies and Career Resources are never
   * parsed, moved or rewritten; a link is added after them.
   *
   * With the feature off the original HTML is returned untouched, so the
   * portal is byte-for-byte what it was before this file existed.
   */
  var prevCpShell = window.cpShell;
  if (typeof prevCpShell === 'function') {
    window.cpShell = function (section) {
      var html = prevCpShell.apply(this, arguments);
      if (!X.enabled || typeof html !== 'string') return html;
      return html.replace(/(<nav class="cp-nav">[\s\S]*?)<\/nav>/,
        function (whole, inner) {
          if (inner.indexOf('external-jobs') >= 0) return whole;   // already there
          return inner
            + '<a class="' + (section === 'external-jobs' ? 'on' : '') + '"'
            + ' onclick="location.hash=\'#/candidate/external-jobs\'">External Jobs</a>'
            + '</nav>';
        });
    };
  }

  var X = (window.TLX = window.TLX || {});
  X.enabled = false;
  X.config = null;
  X.probed = false;
  X.cache = { matches: null, applications: null };
  /* §12 — these apply to External Jobs and to nothing else. */
  X.filters = { min: 0, location: '', source: '', posted: '', skill: '', exp: '', pay: '' };

  /* ------------------------------------------------------------------ *
   * is the feature on?
   * ------------------------------------------------------------------ */

  function probe() {
    if (X.probed) return Promise.resolve(X.enabled);
    if (!TL.session) return Promise.resolve(false);   // the config route needs a session
    return TL.api.get('/external/config').then(function (cfg) {
      X.probed = true;
      X.enabled = true;
      X.config = cfg;
      addNav();
      addStyle();
      return true;
    }, function () {
      /* A 404 means the router is not mounted: the feature is off. Any
         other failure is treated the same way, because the alternative is
         an error message about a feature nobody asked for. */
      X.probed = true;
      X.enabled = false;
      return false;
    });
  }

  /* One extra item per portal, appended - never inserted, never
     reordered, never replacing anything. */
  function addNav() {
    try {
      if (typeof NAV_CONFIG === 'undefined') return;
      /*
       * THE CANDIDATE PORTAL ONLY.
       *
       * The recruiter portal had an External Applications screen and it
       * has been taken out: external vacancies are the candidate's own
       * business, and putting them in front of a recruiter beside the
       * TeamLink pipeline invited exactly the confusion the separation
       * was built to prevent. The endpoints are untouched - a source is
       * configured by an administrator, not from a nav item.
       */
      addOnce(NAV_CONFIG.candidate, ['external-jobs', 'External Jobs', '🌐']);
    } catch (e) { /* the nav is cosmetic; never break the app over it */ }
  }

  function addOnce(list, entry) {
    if (!Array.isArray(list)) return;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i][0] === entry[0]) return;
    list.push(entry);
  }

  /* Every selector prefixed .xj- so it cannot collide with a rule the
     prototype already has. */
  function addStyle() {
    if (document.getElementById('xjStyle')) return;
    var s = document.createElement('style');
    s.id = 'xjStyle';
    s.textContent = [
      '.xj-note{font-size:12.5px;color:var(--text-soft);line-height:1.5}',
      '.xj-note-prompt{border-left:4px solid #4f46e5; background:#eef2ff; color:#243449}',
      '.xj-grid{display:grid;gap:12px}',
      '.xj-card{border:1px solid var(--line,rgba(0,0,0,.1));border-radius:12px;padding:14px 16px}',
      '.xj-row{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}',
      '.xj-title{font-weight:650;font-size:15px}',
      '.xj-meta{font-size:12.5px;color:var(--text-soft);margin-top:3px}',
      '.xj-pct{font-weight:700;font-size:15px;white-space:nowrap}',

      /*
       * THE BADGE BESIDE THE TITLE, COLOURED BY STRENGTH.
       *
       * The number was already on the card, on the right, in the
       * body text colour - so a 91% and a 34% looked identical until
       * you read them. Colour carries the judgement the number is
       * making, and the three steps are the app's existing good /
       * warning / muted tokens rather than three new ones.
       */
      '.xj-m{display:inline-flex;align-items:center;gap:5px;vertical-align:middle;',
      '  margin-left:8px;border-radius:999px;padding:2px 9px;font-size:11.5px;',
      '  font-weight:800;letter-spacing:.01em;white-space:nowrap}',
      '.xj-m.hi{background:#e8f6ee;color:#1d7a45;border:1px solid #bfe3cd}',
      '.xj-m.mid{background:#fdf1dc;color:#8a5a12;border:1px solid #f0d9a8}',
      '.xj-m.lo{background:#eef1f6;color:#5a6a7d;border:1px solid #dfe5ec}',
      '.xj-m.none{background:transparent;color:#6b7a90;border:1px dashed #cfd6e0;',
      '  font-weight:600}',
      '.xj-m[title]{cursor:help}',

      /* One line above the list saying how it is ordered. */
      '.xj-sorted{font-size:12px;color:#6b7a90;margin:0 0 8px}',
      '.xj-why{font-size:12px;color:var(--text-soft);margin-top:8px}',
      '.xj-chip{display:inline-block;font-size:11.5px;padding:2px 8px;border-radius:999px;',
      '  border:1px solid var(--line,rgba(0,0,0,.12));margin:3px 4px 0 0}',
      '.xj-chip.miss{opacity:.6;text-decoration:line-through}',
      '.xj-status{display:inline-block;font-size:11.5px;font-weight:650;padding:3px 9px;',
      '  border-radius:999px;background:rgba(20,144,179,.14)}',
      '.xj-empty{padding:26px 4px;text-align:center;color:var(--text-soft);font-size:13.5px}',
      '.xj-empty b{display:block;color:var(--text,#16202c);font-size:15px;margin-bottom:4px}',
      /* the source and job-type badges on a card */
      '.xj-badges{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap}',
      '.xj-badge{font-size:10.5px;font-weight:800;letter-spacing:.02em;padding:2px 8px;',
      '  border-radius:999px;background:#eef2ff;color:#4338ca}',
      '.xj-badge.alt{background:#f1f5f9;color:#475569}',
      '.xj-actions{display:flex;flex-direction:column;gap:6px;align-items:flex-end;margin-top:8px}',
      '.xj-dismiss{font-size:11.5px;padding:4px 10px;color:#64748b}',
      /* pagination */
      '.xj-pager{display:flex;align-items:center;justify-content:center;gap:14px;',
      '  padding:14px 0 2px;font-size:12.5px;color:var(--text-soft)}',
      '.xj-pager button[disabled]{opacity:.45;cursor:default}',
      /* the skeleton shown while a page is loading */
      '.xj-skel{display:flex;flex-direction:column;gap:10px;padding:4px 0}',
      '.xj-skel-card{height:92px;border-radius:12px;border:1px solid var(--line,#e6ebf2);',
      '  background:linear-gradient(90deg,#f6f8fb 25%,#eef2f7 37%,#f6f8fb 63%);',
      '  background-size:400% 100%;animation:xjshimmer 1.3s ease-in-out infinite}',
      '@keyframes xjshimmer{0%{background-position:100% 0}100%{background-position:0 0}}',
      /* "Did you apply?" */
      /* ---- the tracking flow (0076) ------------------------------- */
      '.xj-note-bar{background:#f2f8fb;border:1px solid #d7e7ef;border-radius:10px;',
      '  padding:10px 13px;font-size:12.5px;color:#3d5563;line-height:1.5;margin-bottom:12px}',
      '.xj-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}',
      '.xj-tab{border:1px solid #dde4ee;background:#fff;color:#3a4a5e;border-radius:999px;',
      '  padding:5px 13px;font:inherit;font-size:12.5px;cursor:pointer}',
      '.xj-tab b{font-weight:800;color:#16202c;margin-left:3px}',
      '.xj-tab.on{background:#1490b3;border-color:#1490b3;color:#fff}',
      '.xj-tab.on b{color:#fff}',
      /* Never "Verified", never "Submitted by TeamLink" - this is the
         candidate quoting themselves, and it is styled as a quiet note
         rather than a badge of authority. */
      '.xj-byyou{font-size:11px;color:#5f7183;margin-top:4px;font-style:italic}',
      '.xj-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}',
      '.xj-nl{display:block;font-size:11.5px;font-weight:700;color:#5f7183;margin-bottom:4px}',
      '.xj-nt{width:100%;border:1px solid #dde4ee;border-radius:8px;padding:7px 9px;',
      '  font:inherit;font-size:12.5px;resize:vertical;box-sizing:border-box}',
      '.xj-ns{margin-top:6px}',
      '.xj-resp{color:#7a8798;font-size:12px}',
      '.xj-ask-v{font-size:12px;color:#7a8798;margin-top:2px}',
      '.xj-ask-later{margin-left:auto}',
      /* The list that survives closing the tab. */
      '.xj-pending{border:1px solid #f0d9a8;background:#fffaf0;border-radius:12px;',
      '  padding:12px 14px;margin-bottom:16px}',
      '.xj-pending h4{margin:0 0 3px;font-size:13.5px;color:#7a5a12}',
      '.xj-pending p{margin:0 0 10px;font-size:12px;color:#8a7350;line-height:1.5}',
      '.xj-prow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;',
      '  padding:8px 0;border-top:1px solid #f2e6cc}',
      '.xj-prow:first-of-type{border-top:0}',
      '.xj-pt{flex:1;min-width:180px;font-size:12.5px}',
      '.xj-pt b{display:block;font-size:13px;color:#16202c}',
      '.xj-pt span{color:#8a7350}',
      '.xj-ask{position:fixed;inset:0;z-index:9000;background:rgba(15,20,30,.5);',
      '  display:flex;align-items:center;justify-content:center;padding:20px}',
      '.xj-ask-box{background:#fff;border-radius:14px;padding:24px 26px;max-width:420px;',
      '  box-shadow:0 20px 60px rgba(10,20,40,.3)}',
      '.xj-ask-q{font-size:17px;font-weight:800;color:#16202c;margin-bottom:6px}',
      '.xj-ask-n{font-size:13px;line-height:1.55;color:#5b6b82;margin-bottom:16px}',
      '.xj-ask-b{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}',
      '@media (max-width:600px){.xj-filters{flex-direction:column;align-items:stretch}',
      '  .xj-actions{align-items:stretch}}',
      '.xj-filters{display:flex;flex-wrap:wrap;gap:9px;align-items:flex-end;margin-bottom:10px;',
      '  padding:11px 12px;border:1px solid var(--line,rgba(0,0,0,.1));border-radius:10px}',
      '.xj-f{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--text-soft)}',
      '.xj-f select,.xj-f input{border:1px solid var(--line,#cfd6e0);border-radius:7px;height:29px;',
      '  padding:2px 8px;font-size:12.5px;font-family:inherit;min-width:110px;background:#fff}',
      '.xj-clear{align-self:flex-end;height:29px;border:0;background:none;cursor:pointer;',
      '  font-size:12px;font-weight:700;color:var(--brand-500,#1d6ff2);text-decoration:underline}',
      '.xj-count{font-size:11.5px;color:var(--text-soft);margin:0 0 8px 2px}',
      '.xj-also{font-size:11px;font-weight:700;color:var(--brand-500,#1d6ff2)}',
      '.xj-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.xj-table th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;',
      '  color:var(--text-soft);padding:8px 10px;border-bottom:1px solid var(--line,rgba(0,0,0,.1))}',
      '.xj-table td{padding:9px 10px;border-bottom:1px solid var(--line,rgba(0,0,0,.06));vertical-align:top}',
      '.xj-sep{margin-top:6px;font-size:12px;color:var(--text-soft)}',
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------------------ *
   * the two wrappers
   *
   * Anything that is not our section goes to the original function,
   * unchanged and unexamined.
   * ------------------------------------------------------------------ */

  var prevCandidate = window.pageCandidateDash;
  if (typeof prevCandidate === 'function') {
    window.pageCandidateDash = function (section) {
      if (X.enabled && section === 'external-jobs') return candidatePage();
      return prevCandidate.apply(this, arguments);
    };
  }

  /*
   * The probe has to happen after a session exists, and the nav is read
   * during a render - so render is wrapped to ask once, and to repaint a
   * single time when the answer turns out to be yes. The one-shot flag is
   * what stops that repaint from recursing.
   */
  var prevRender = window.render;
  if (typeof prevRender === 'function') {
    var repainted = false;
    window.render = function () {
      var out = prevRender.apply(this, arguments);
      if (!X.probed && TL.session) {
        probe().then(function (on) {
          if (on && !repainted) { repainted = true; window.render(); }
        });
      }
      return out;
    };
  }

  /* A signed-out session must not keep a previous user's answer. */
  var prevLogout = window.doLogout;
  if (typeof prevLogout === 'function') {
    window.doLogout = function () {
      X.probed = false; X.enabled = false; X.autoScored = false; X.vocab = null;
      X.cache = { matches: null, applications: null };
      return prevLogout.apply(this, arguments);
    };
  }

  /* ------------------------------------------------------------------ *
   * shared bits
   * ------------------------------------------------------------------ */

  function shell(title, desc, bodyId, toolbar) {
    return '<div class="panel">'
      + '<div class="panel-head"><div><h2>' + esc(title) + '</h2>'
      + '<div class="desc">' + esc(desc) + '</div></div>'
      + (toolbar || '') + '</div>'
      + '<div class="panel-body"><div id="' + bodyId + '">'
      + '<div class="xj-empty">Loading…</div></div></div></div>';
  }

  function fill(id, html) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  function failed(id, err) {
    fill(id, '<div class="xj-empty">Could not load this: '
      + esc((err && err.message) || 'the server did not answer') + '</div>');
  }

  function when(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  /*
   * What a status means, in words, for a candidate who has never heard of
   * it. "Applied - Not Confirmed" is the one that matters: it is the
   * honest state of a redirect, and left unexplained it reads like a
   * failure.
   */
  var STATUS_NOTE = {
    ready: 'Ready to send.',
    applying: 'Being sent now.',
    applied: 'Sent, and the source confirmed it.',
    applied_unconfirmed: 'You were taken to the employer’s own form. '
      + 'TeamLink cannot see whether you finished it, so this stays unconfirmed '
      + 'until the employer says otherwise.',
    application_received: 'The employer has acknowledged it.',
    under_review: 'The employer is reading it.',
    shortlisted: 'The employer shortlisted you. This is their decision, not a TeamLink stage.',
    interview: 'The employer wants to interview you.',
    rejected: 'The employer said no to this one.',
    withdrawn: 'Withdrawn.',
    failed: 'It could not be sent.',
    unknown: 'The employer has not said.',
  };

  /* ------------------------------------------------------------------ *
   * candidate — Recommended External Jobs, and External Applications
   * ------------------------------------------------------------------ */

  function candidatePage() {
    setTimeout(loadCandidate, 0);
    var content = ''
      + '<div class="panel"><div class="panel-body">'
      + '<div class="xj-note"><b>These jobs are not TeamLink vacancies.</b> '
      + 'They are openings advertised elsewhere, collected so you can see what '
      + 'suits your profile. Applying here does not change anything about your '
      + 'TeamLink applications, and your TeamLink recruiter still handles those '
      + 'separately.</div></div></div>'
      + shell('Recommended External Jobs',
        'Scored against the profile you already have — nothing here changes it',
        'xjMatches',
        '<button class="btn" onclick="xjRematch()">Refresh matches</button>')
      /* The unanswered ones sit above everything: they are the only
         thing on this page that needs the candidate to do something. */
      + '<div id="xjPending"></div>'
      + shell('External Applications',
        'What you opened, what you told us, and nothing we could not see',
        'xjApps', '');

    /*
     * THE PORTAL'S OWN SHELL, not the old sidebar.
     *
     * The candidate portal was re-skinned: every page a candidate sees
     * goes through cpShell, which draws the white top-nav layout. Using
     * dashShell here rendered External Jobs inside the old dark sidebar,
     * so the one new page looked like it belonged to a different product.
     * dashShell stays as the fallback for anything that has not been
     * re-skinned.
     */
    if (typeof window.cpShell === 'function') {
      return window.cpShell('external-jobs',
        '<h1 style="margin:0 0 4px;font-size:21px;font-weight:800;color:#16202c">External Jobs</h1>'
        + '<div style="font-size:12.5px;color:#7b8794;margin-bottom:14px">'
        + 'Openings advertised elsewhere, matched to your profile</div>'
        + content);
    }
    return typeof window.dashShell === 'function'
      ? window.dashShell('candidate', 'external-jobs', 'External Jobs',
        'Candidate · External Jobs', content)
      : content;
  }

  /* ------------------------------------------------------------------ *
   * the candidate's list
   *
   * SERVER-SIDE NOW, and that is the point. This used to pull fifty
   * matches and filter them in the browser, so "3 of 50 shown" depended
   * entirely on which fifty happened to come back. The endpoint it reads
   * caps at the configured maximum FIRST, then filters, sorts and cuts
   * the page - so the count on screen is the true number of matches, and
   * page 3 means the same thing whichever page was opened first.
   * ------------------------------------------------------------------ */
  X.page = { page: 1, pageSize: 20, total: 0, state: 'ok', cap: 100, minMatch: 60 };

  function query() {
    var f = X.filters;
    var p = ['page=' + X.page.page, 'pageSize=' + X.page.pageSize];
    if (f.source) p.push('source=' + encodeURIComponent(f.source));
    if (f.location) p.push('location=' + encodeURIComponent(f.location));
    if (f.jobType) p.push('jobType=' + encodeURIComponent(f.jobType));
    if (f.skill) p.push('q=' + encodeURIComponent(f.skill));
    /* SENT EVEN WHEN IT IS ZERO. Omitting it let the server fall back to
       its own 60% default, so choosing "Any" in the dropdown quietly did
       nothing - the list stayed empty and the filter looked broken. */
    if (f.min !== '' && f.min !== undefined && f.min !== null) {
      p.push('minMatch=' + Number(f.min));
    }
    if (f.sort) p.push('sort=' + encodeURIComponent(f.sort));
    return p.join('&');
  }

  function loadCandidate() {
    skeleton();
    TL.api.get('/external/recommended?' + query()).then(function (out) {
      X.page.total = Number(out.total || 0);
      X.page.state = out.state || 'ok';
      X.page.cap = Number(out.cap || 100);
      X.page.minMatch = Number(out.minMatch || 60);
      X.cache.matches = out.jobs || [];

      /* The option vocabulary follows the DATA. When this response was
         itself unfiltered it already is the whole list, so nothing extra
         is fetched; otherwise it is read once in the background. */
      if (!X.vocab) {
        if (!anyFilterSet()) X.vocab = vocabFrom(X.cache.matches);
        else loadVocab().then(function () { paintMatches(); });
      }

      /*
       * SCORE THEM ON THE FIRST VISIT, once.
       *
       * Nothing scores a candidate against the external jobs until
       * somebody asks, so a person who had just registered opened this
       * page and was told to press Refresh - which reads as a dead end
       * on the one screen meant to show them something. Only when jobs
       * exist and none has been matched: an empty board is not something
       * re-scoring can fix.
       */
      if (X.page.state === 'no_matches' && !X.autoScored) {
        X.autoScored = true;
        fill('xjMatches', '<div class="xj-empty">Scoring your profile against the '
          + 'external jobs…</div>');
        X.vocab = null;
        TL.api.post('/external/match', {}).then(function () {
          return TL.api.get('/external/recommended?' + query());
        }).then(function (again) {
          X.page.total = Number(again.total || 0);
          X.page.state = again.state || 'ok';
          X.cache.matches = again.jobs || [];
          paintMatches();
        }, function (e) { failed('xjMatches', e); });
        return;
      }
      paintMatches();
    }, function (e) { failed('xjMatches', e); });

    TL.api.get('/external/applications').then(function (out) {
      X.cache.applications = out.applications || [];
      paintCandidateApps();
      /* Asked for on every arrival, which is what makes the question
         survive a closed tab or a different device. */
      loadPending();
    }, function (e) { failed('xjApps', e); });
  }

  /* Something on screen while the request is out, rather than the last
     answer sitting there looking current. */
  function skeleton() {
    var card = '<div class="xj-skel-card"></div>';
    fill('xjMatches', '<div class="xj-skel">' + card + card + card + '</div>');
  }

  /* The values a filter can offer are whatever the matches actually
     contain - an empty dropdown of every city in India helps nobody. */
  function choices(rows, pick) {
    var seen = {};
    rows.forEach(function (m) {
      var v = pick(m);
      if (v) seen[v] = 1;
    });
    return Object.keys(seen).sort();
  }

  /*
   * THE OPTIONS COME FROM EVERY JOB, NOT FROM THE ONES LEFT AFTER
   * FILTERING.
   *
   * They were built from `X.cache.matches`, which is the CURRENT result
   * set - so picking Location = "Remote - India" reduced the list to the
   * Remote - India jobs, and the Location dropdown was then rebuilt from
   * those and offered exactly two things: "Any" and "Remote - India".
   * Every other city had vanished, and the only way back was to select
   * "Any" first. The same held for Source and Job type.
   *
   * So the vocabulary is read once from the unfiltered list and kept
   * beside the results. It is refreshed when the DATA changes - a sync,
   * a re-match, a page load - and never when a filter moves, which is
   * also why the options stop reordering after every selection.
   */
  var VOCAB_KEYS = ['source', 'location', 'jobType'];

  function anyFilterSet() {
    var f = X.filters || {};
    return !!(f.source || f.location || f.jobType || f.skill || Number(f.min) > 0);
  }

  function vocabFrom(rows) {
    var job = function (m) { return m.job || {}; };
    return {
      source: choices(rows, function (m) { return job(m).sourceName; }),
      location: choices(rows, function (m) { return job(m).location; }),
      jobType: choices(rows, function (m) { return job(m).employmentType; }),
    };
  }

  /** The full set, asked for once, with no filters on it. */
  function loadVocab() {
    if (X.vocabLoading) return X.vocabLoading;
    if (!(window.TL && TL.api)) return Promise.resolve(null);
    var q = 'pageSize=100&page=1';
    if (X.candidateId) q += '&candidateId=' + encodeURIComponent(X.candidateId);
    X.vocabLoading = TL.api.get('/external/recommended?' + q)
      .then(function (out) {
        X.vocab = vocabFrom(out.jobs || []);
        X.vocabLoading = null;
        return X.vocab;
      })
      .catch(function () { X.vocabLoading = null; return null; });
    return X.vocabLoading;
  }

  /**
   * What a dropdown offers: the whole vocabulary, plus whatever is
   * currently selected even if the vocabulary has not arrived yet - so
   * a selection is never silently dropped from its own list.
   */
  function optionsFor(key, rows, pick, current) {
    var list = (X.vocab && X.vocab[key]) || choices(rows, pick);
    if (current && list.indexOf(current) < 0) list = list.concat([current]).sort();
    return list;
  }

  function filterBar(rows) {
    var f = X.filters;
    var dd = function (key, label, list, cur) {
      return '<label class="xj-f"><span>' + esc(label) + '</span>'
        + '<select onchange="xjFilter(&quot;' + key + '&quot;, this.value)">'
        + '<option value="">Any</option>'
        + list.map(function (v) {
          return '<option value="' + esc(v) + '"'
            + (String(cur) === String(v) ? ' selected' : '') + '>' + esc(v) + '</option>';
        }).join('') + '</select></label>';
    };
    var job = function (m) { return m.job || {}; };
    var any = f.source || f.location || f.jobType || f.skill || Number(f.min) > 0;

    return '<div class="xj-filters">'
      + '<label class="xj-f"><span>Search</span>'
      + '<input value="' + esc(f.skill || '') + '" placeholder="Title or company" '
      + 'oninput="xjFilter(&quot;skill&quot;, this.value)"></label>'
      + dd('source', 'Source',
          optionsFor('source', rows, function (m) { return job(m).sourceName; }, f.source), f.source)
      + dd('location', 'Location',
          optionsFor('location', rows, function (m) { return job(m).location; }, f.location), f.location)
      + dd('jobType', 'Job type',
          optionsFor('jobType', rows, function (m) { return job(m).employmentType; }, f.jobType), f.jobType)
      + '<label class="xj-f"><span>Minimum match</span>'
      + '<select onchange="xjFilter(&quot;min&quot;, this.value)">'
      + [0, 60, 70, 80, 90].map(function (v) {
        return '<option value="' + v + '"' + (Number(f.min) === v ? ' selected' : '') + '>'
          + (v ? v + '%' : 'Any') + '</option>';
      }).join('') + '</select></label>'
      + '<label class="xj-f"><span>Sort by</span>'
      + '<select onchange="xjFilter(&quot;sort&quot;, this.value)">'
      + '<option value="match"' + (f.sort !== 'posted' ? ' selected' : '') + '>Best match</option>'
      + '<option value="posted"' + (f.sort === 'posted' ? ' selected' : '') + '>Newest first</option>'
      + '</select></label>'
      + (any ? '<button class="xj-clear" onclick="xjFilterClear()">Clear</button>' : '')
      + '</div>';
  }

  /*
   * FOUR REASONS THERE IS NOTHING HERE, and they are different problems.
   *
   * One sentence covered all of them, so a candidate with a blank
   * profile, an administrator who had not added a source, and a
   * candidate for whom nothing scored above the bar were all told the
   * same unhelpful thing. Each now says what is actually wrong and who
   * can do something about it.
   */
  function emptyState() {
    var s = X.page.state;
    if (s === 'profile_incomplete') {
      return '<div class="xj-empty"><b>Complete your profile first</b><br>'
        + 'Add your skills and the role you are looking for, and these jobs '
        + 'will be matched against them.</div>';
    }
    if (s === 'no_sources') {
      return '<div class="xj-empty"><b>No job sources are configured yet</b><br>'
        + 'TeamLink has not connected any external job boards. There is nothing '
        + 'for you to do — this page fills in once one is added.</div>';
    }
    if (s === 'no_jobs_synced') {
      return '<div class="xj-empty"><b>No jobs have been collected yet</b><br>'
        + 'A job source is connected but has not returned any openings. '
        + 'Check back shortly.</div>';
    }
    return '<div class="xj-empty"><b>Nothing matches your profile yet</b><br>'
      + 'Jobs are on file, but none reaches the ' + X.page.minMatch + '% match mark. '
      + 'Adding more skills to your profile widens what can be matched.</div>';
  }

  function paintMatches() {
    var rows = X.cache.matches || [];
    var p = X.page;

    /*
     * A PROMPT ABOVE THE JOBS, NOT A WALL IN FRONT OF THEM.
     *
     * A candidate with no skills and no title used to be shown this
     * sentence INSTEAD of the list, while a hundred real jobs sat
     * unshown. They are shown the newest jobs now, unscored and said to
     * be unscored, with this above them.
     */
    var banner = p.profileIncomplete
      ? '<div class="xj-note xj-note-prompt">'
        + '<b>Latest jobs in India &mdash; not matched to your profile.</b><br>'
        + 'Add your skills and the role you are looking for and these become '
        + 'matches, ranked for you. '
        + '<a href="#/candidate/resume">Add them now</a>'
        + '</div>'
      : '';

    if (!p.total) { fill('xjMatches', filterBar(rows) + banner + emptyState()); return; }

    var from = (p.page - 1) * p.pageSize + 1;
    var to = Math.min(p.total, from + rows.length - 1);
    var pages = Math.max(1, Math.ceil(p.total / p.pageSize));

    /* Said once, above the list, when there is an order worth naming.
       The count line below keeps its existing wording. */
    var sorted = rows.some(function (m) { return m.matchPercentage != null; })
      ? '<div class="xj-sorted">Sorted by best match first.</div>' : '';

    fill('xjMatches', filterBar(rows) + banner + sorted
      + '<div class="xj-count">Showing ' + from + '–' + to + ' of ' + p.total + ' job'
      + (p.total === 1 ? '' : 's')
      + (p.total >= p.cap ? ' (your best ' + p.cap + ')' : '') + '</div>'
      + '<div class="xj-grid">' + rows.map(matchCard).join('') + '</div>'
      + (pages > 1
        ? '<div class="xj-pager">'
          + '<button class="btn" onclick="xjPage(' + (p.page - 1) + ')"'
          + (p.page <= 1 ? ' disabled' : '') + '>Previous</button>'
          + '<span>Page ' + p.page + ' of ' + pages + '</span>'
          + '<button class="btn" onclick="xjPage(' + (p.page + 1) + ')"'
          + (p.page >= pages ? ' disabled' : '') + '>Next</button></div>'
        : ''));
  }

  window.xjPage = function (n) {
    var pages = Math.max(1, Math.ceil(X.page.total / X.page.pageSize));
    X.page.page = Math.max(1, Math.min(Number(n) || 1, pages));
    loadCandidate();
  };

  window.xjFilter = function (key, value) {
    X.filters[key] = String(value || '');
    X.page.page = 1;                      /* a new question starts at page one */
    loadCandidate();
  };
  window.xjFilterClear = function () {
    Object.keys(X.filters).forEach(function (k) { X.filters[k] = ''; });
    X.filters.min = 0;
    X.page.page = 1;
    loadCandidate();
  };

  /** "Not interested." The job leaves this candidate's list for good. */
  window.xjDismiss = function (externalJobId) {
    TL.api.post('/external/matches/' + encodeURIComponent(externalJobId) + '/dismiss', {})
      .then(function () {
        toast('Hidden — you will not see this one again', '👍');
        loadCandidate();
      }, function (e) {
        toast((e && e.message) || 'Could not hide that job', '⚠️');
      });
  };

  function matchCard(m) {
    var j = m.job || {};
    var pct = m.matchPercentage == null ? null : Math.round(m.matchPercentage);
    var applied = m.application;

    var action;
    if (applied) {
      action = '<span class="xj-status">' + esc(labelFor(applied.status)) + '</span>';
    } else if (j.applicationMethod === 'none') {
      action = '<span class="xj-note">Apply on the employer’s site</span>';
    } else {
      action = '<button class="btn primary" onclick="xjApply(&quot;' + esc(m.externalJobId)
        + '&quot;)">Apply</button>'
        + '<button class="btn xj-dismiss" onclick="xjDismiss(&quot;' + esc(m.externalJobId)
        + '&quot;)">Not interested</button>';
    }

    /* The three that earned the most, in the matcher's own words. Four
       lines of explanation is a wall; three is a reason. */
    var why = (m.matchReasons || [])
      .filter(function (r) { return r && r.detail; })
      .slice(0, 3)
      .map(function (r) { return esc(r.detail); }).join(' · ');

    var badges = (j.sourceName ? '<span class="xj-badge">' + esc(j.sourceName) + '</span>' : '')
      + (j.employmentType ? '<span class="xj-badge alt">' + esc(j.employmentType) + '</span>' : '');

    /*
     * A number only where one was computed. Tier "latest" is the newest
     * India jobs shown to somebody the matcher could not score, so it
     * carries no percentage and SAYS so - an empty space there reads as
     * a missing number rather than an absent one.
     */
    var band = pct == null ? 'none' : pct >= 70 ? 'hi' : pct >= 40 ? 'mid' : 'lo';
    var matchBadge = pct == null
      ? '<span class="xj-m none">Not matched to your profile</span>'
      : '<span class="xj-m ' + band + '"'
        + (why ? ' title="' + esc(why) + '"' : '') + '>' + pct + '% match</span>';

    return '<div class="xj-card"><div class="xj-row">'
      + '<div><div class="xj-title">' + esc(j.title || '—') + matchBadge + '</div>'
      + '<div class="xj-meta">' + esc(j.company || 'Company not stated')
      + (j.location ? ' · ' + esc(j.location) : '')
      + (j.salary ? ' · ' + esc(j.salary) : '')
      + (j.postedAt ? ' · posted ' + esc(when(j.postedAt)) : '')
      + (j.alsoOn ? ' <span class="xj-also">+' + j.alsoOn + ' more board'
          + (j.alsoOn === 1 ? '' : 's') + '</span>' : '')
      + '</div>' + (badges ? '<div class="xj-badges">' + badges + '</div>' : '') + '</div>'
      + '<div style="text-align:right">'
      + '<div class="xj-actions">' + action + '</div></div></div>'
      + (why ? '<div class="xj-why">' + why + '</div>' : '')
      + (m.matchingSkills || []).slice(0, 8).map(function (s) {
        return '<span class="xj-chip">' + esc(s) + '</span>';
      }).join('')
      + (m.missingSkills || []).slice(0, 5).map(function (s) {
        return '<span class="xj-chip miss">' + esc(s) + '</span>';
      }).join('')
      + '</div>';
  }

  /* ------------------------------------------------------------------ *
   * the candidate's own list of external applications
   *
   * EVERY STATUS ON THIS PAGE CAME FROM THE CANDIDATE. TeamLink handed
   * over a link to somebody else's website and cannot see what happened
   * after that - not whether the form was finished, not whether the
   * employer received it, not whether they replied. The page says so at
   * the top, and every confirmed row carries "Confirmed by you" so the
   * claim can never be read as ours.
   * ------------------------------------------------------------------ */
  var APP_TABS = [
    ['all', 'All'],
    ['clicked', 'Applied (External)'],
    ['applied_unconfirmed', 'Confirmed by you'],
    ['not_applied', 'Not Applied'],
  ];

  function appTabOf(a) {
    if (a.status === 'clicked') return 'clicked';
    if (a.status === 'not_applied') return 'not_applied';
    /* Everything the candidate has confirmed as applied, including the
       older 'applied' rows from before this flow existed. */
    if (a.status === 'applied_unconfirmed' || a.status === 'applied') return 'applied_unconfirmed';
    return 'other';
  }

  window.xjAppTab = function (tab) {
    X.appTab = tab;
    paintCandidateApps();
  };

  window.xjMark = function (id, status) {
    TL.api.patch('/external/applications/' + encodeURIComponent(id), { status: status })
      .then(function () {
        toast(status === 'applied_unconfirmed'
          ? 'Recorded — you said you applied'
          : status === 'not_applied' ? 'Marked as not applied' : 'Updated', '✅');
        loadCandidate();
      }, function (e) {
        toast((e && e.message) || 'Could not record that', '⚠️');
      });
  };

  window.xjNote = function (id) {
    var box = document.getElementById('xjn_' + id);
    if (!box) return;
    TL.api.patch('/external/applications/' + encodeURIComponent(id),
      { notes: String(box.value || '').slice(0, 500) })
      .then(function () { toast('Note saved', '✅'); },
            function (e) { toast((e && e.message) || 'Could not save that', '⚠️'); });
  };

  /* ------------------------------------------------------------------ *
   * the ones still waiting for an answer
   *
   * INDEPENDENT OF THE TAB THEY CLICKED IN. The dialog only works in
   * that tab and only while it is open: close it, sign out, or pick the
   * phone up instead, and the question is gone while the record still
   * says "Clicked" for ever. This asks the server, on every arrival,
   * from any device.
   *
   * "Later" hides a row for this visit only. It changes no status,
   * because not answering is not an answer.
   * ------------------------------------------------------------------ */
  var laterThisVisit = {};

  window.xjPendingLater = function (id) {
    laterThisVisit[id] = true;
    paintPending();
  };

  window.xjPendingMark = function (id, status) {
    laterThisVisit[id] = true;          /* off the strip either way */
    TL.api.patch('/external/applications/' + encodeURIComponent(id), { status: status })
      .then(function () {
        toast(status === 'applied_unconfirmed'
          ? 'Recorded — you said you applied'
          : 'Marked as not applied', '✅');
        loadCandidate();
      }, function (e) {
        toast((e && e.message) || 'Could not record that', '⚠️');
        paintPending();
      });
  };

  window.xjPendingNoneApplied = function () {
    var ids = (X.cache.pending || [])
      .filter(function (a) { return !laterThisVisit[a.id]; })
      .map(function (a) { return a.id; });
    if (!ids.length) return;
    Promise.all(ids.map(function (id) {
      laterThisVisit[id] = true;
      return TL.api.patch('/external/applications/' + encodeURIComponent(id),
        { status: 'not_applied' }).then(null, function () { return null; });
    })).then(function () {
      toast('Marked ' + ids.length + ' as not applied', '✅');
      loadCandidate();
    });
  };

  function paintPending() {
    var host = document.getElementById('xjPending');
    if (!host) return;
    var rows = (X.cache.pending || []).filter(function (a) { return !laterThisVisit[a.id]; });
    if (!rows.length) { host.innerHTML = ''; return; }

    host.innerHTML = '<div class="xj-pending">'
      + '<h4>Did you apply?</h4>'
      + '<p>You opened these and we have not heard back. Only you can say what '
      + 'happened — we cannot see an employer’s site.</p>'
      + rows.map(function (a) {
          return '<div class="xj-prow">'
            + '<div class="xj-pt"><b>' + esc(a.jobTitle || '—') + '</b>'
            +   '<span>' + esc(a.company || '—')
            +   (a.originalPublisher ? ' · via ' + esc(a.originalPublisher) : '')
            +   ' · opened ' + esc(when(a.lastOpenedAt || a.createdAt)) + '</span></div>'
            + '<button class="btn primary" onclick="xjPendingMark(\'' + esc(a.id)
            +   '\',\'applied_unconfirmed\')">Applied</button>'
            + '<button class="btn" onclick="xjPendingMark(\'' + esc(a.id)
            +   '\',\'not_applied\')">Not applied</button>'
            + '<button class="btn" onclick="xjPendingLater(\'' + esc(a.id)
            +   '\')">Later</button>'
            + '</div>';
        }).join('')
      + (rows.length > 1
          ? '<div style="margin-top:10px"><button class="btn" '
            + 'onclick="xjPendingNoneApplied()">Mark all as not applied</button></div>'
          : '')
      + '</div>';
  }

  function loadPending() {
    if (!TL.session || TL.session.role !== 'candidate') return;
    TL.api.get('/external/applications/pending?minutes=5').then(function (r) {
      X.cache.pending = r.pending || [];
      paintPending();
    }, function () { /* the page still works without it */ });
  }

  function paintCandidateApps() {
    var rows = X.cache.applications || [];
    var tab = X.appTab || 'all';

    var counts = { all: rows.length, clicked: 0, applied_unconfirmed: 0, not_applied: 0 };
    rows.forEach(function (a) {
      var t = appTabOf(a);
      if (counts[t] != null) counts[t] += 1;
    });

    var head = '<div class="xj-note-bar">TeamLink can’t see what happens on external '
      + 'sites. Statuses marked “Confirmed by you” come from you.</div>'
      + '<div class="xj-tabs">' + APP_TABS.map(function (t) {
          return '<button class="xj-tab' + (tab === t[0] ? ' on' : '') + '" '
            + 'onclick="xjAppTab(\'' + t[0] + '\')">' + esc(t[1])
            + ' <b>' + (counts[t[0]] || 0) + '</b></button>';
        }).join('') + '</div>';

    var shown = tab === 'all' ? rows : rows.filter(function (a) { return appTabOf(a) === tab; });

    if (!shown.length) {
      fill('xjApps', head + '<div class="xj-empty">'
        + (rows.length ? 'Nothing under this tab.'
                       : 'You have not opened any external jobs yet.') + '</div>');
      return;
    }

    fill('xjApps', head + '<div class="xj-grid">' + shown.map(function (a) {
      var t = appTabOf(a);
      var confirmed = a.confirmedBy === 'candidate';

      return '<div class="xj-card"><div class="xj-row">'
        + '<div><div class="xj-title">' + esc(a.jobTitle || '—') + '</div>'
        + '<div class="xj-meta">' + esc(a.company || '—')
        +   (a.originalPublisher ? ' · via ' + esc(a.originalPublisher)
                                 : (a.sourceName ? ' · via ' + esc(a.sourceName) : ''))
        +   ' · Opened ' + esc(when(a.lastOpenedAt || a.createdAt))
        +   (a.openCount > 1 ? ' · ' + a.openCount + ' times' : '')
        + '</div></div>'
        + '<div style="text-align:right">'
        +   '<span class="xj-status">' + esc(a.statusLabel || a.status) + '</span>'
        /*
         * WHOSE STATEMENT THIS IS, beside the status every time it is
         * one of theirs. Never "Verified", never "Submitted by
         * TeamLink" - neither is true and neither could be.
         */
        +   (confirmed ? '<div class="xj-byyou">Confirmed by you</div>' : '')
        + '</div></div>'

        + '<div class="xj-acts">'
        +   (t !== 'applied_unconfirmed'
              ? '<button class="btn primary" onclick="xjMark(\'' + esc(a.id)
                + '\',\'applied_unconfirmed\')">Mark as Applied</button>' : '')
        +   (t === 'clicked'
              ? '<button class="btn" onclick="xjMark(\'' + esc(a.id)
                + '\',\'not_applied\')">Mark as Not Applied</button>' : '')
        +   (a.externalJobId
              ? '<button class="btn" onclick="xjApply(\'' + esc(a.externalJobId)
                + '\')">Open job again</button>' : '')
        + '</div>'

        + '<div class="xj-sep">'
        +   '<label class="xj-nl" for="xjn_' + esc(a.id) + '">Your note</label>'
        +   '<textarea id="xjn_' + esc(a.id) + '" class="xj-nt" maxlength="500" rows="2" '
        +     'placeholder="Anything you want to remember about this one">'
        +     esc(a.notes || '') + '</textarea>'
        +   '<button class="btn xj-ns" onclick="xjNote(\'' + esc(a.id) + '\')">Save note</button>'
        + '</div>'

        /*
         * ONLY WHAT AN EMPLOYER ACTUALLY SAID. For a redirect that is
         * nothing at all, and the page says nothing rather than
         * inferring a reply from silence.
         */
        + '<div class="xj-sep xj-resp">'
        +   (a.employerResponse
              ? 'The employer’s own wording: “' + esc(a.employerResponse) + '”'
              : 'No response recorded')
        + '</div>'
        + (a.failureReason
            ? '<div class="xj-sep">Why it failed: ' + esc(a.failureReason) + '</div>' : '')
        + '</div>';
    }).join('') + '</div>');
  }

  function labelFor(status) {
    var map = {
      ready: 'Ready', applying: 'Applying', applied: 'Applied',
      clicked: 'Applied (External)', dismissed: 'Dismissed', not_applied: 'Not Applied',
      /* Says where it was applied, on its face. A bare "Applied" reads as
         something this system established, and it is not. */
      applied_unconfirmed: 'Applied on External Site (your own report)',
      application_received: 'Application Received', under_review: 'Under Review',
      shortlisted: 'Shortlisted', interview: 'Interview', rejected: 'Rejected',
      withdrawn: 'Withdrawn', failed: 'Failed', unknown: 'Unknown',
    };
    return map[status] || status;
  }

  /* ------------------------------------------------------------------ *
   * recruiter — read only (§10)
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ *
   * actions
   * ------------------------------------------------------------------ */

  var toast = function (m, i) {
    if (typeof window.toast === 'function') window.toast(m, i);
  };

  window.xjRematch = function () {
    fill('xjMatches', '<div class="xj-empty">Scoring your profile against the '
      + 'external jobs…</div>');
    /* A re-match changes which jobs this candidate has, so the option
       vocabulary is no longer current and is rebuilt on the next paint. */
    X.vocab = null;
    TL.api.post('/external/match', {}).then(function (out) {
      toast(out.stored + ' external job(s) scored', '🌐');
      return TL.api.get('/external/matches?limit=50');
    }).then(function (out) {
      X.cache.matches = out.matches || [];
      paintMatches();
    }, function (e) { failed('xjMatches', e); });
  };

  /**
   * Apply.
   *
   * For a redirect source the application is NOT finished when this
   * returns - the candidate still has to complete the employer's own
   * form, so the tab is opened and the message says so plainly rather
   * than congratulating them on an application they have not made.
   */
  /**
   * "Did you apply?" - asked once, when the candidate returns.
   *
   * A redirect application is finished on somebody else's website. This
   * portal records that the candidate was sent there and nothing more,
   * because claiming an application was submitted when all that happened
   * was a link opening is exactly the kind of thing that leaves a
   * recruiter telling a client about a candidate who never applied.
   *
   * The prompt fires on the first focus AFTER the new tab was opened, so
   * it appears when they come back rather than over the top of the tab
   * they are still reading.
   */
  /* ------------------------------------------------------------------ *
   * "Did you apply?"
   *
   * The application finishes on somebody else's website. TeamLink handed
   * over the link and cannot see what happened next, so the record says
   * "Clicked" until the candidate says otherwise. This is the asking.
   *
   * FOUR THINGS IT HAS TO GET RIGHT:
   *
   *   - ONE DIALOG PER CLICK. `focus` and `visibilitychange` both fire
   *     when a tab comes back, and a browser may fire them twice; a
   *     short debounce collapses the burst.
   *   - NOT TOO SOON. Coming back within three seconds means they never
   *     reached the employer's page - alt-tabbed by mistake, or the
   *     popup was blocked - and asking then is asking before the answer
   *     could possibly exist.
   *   - ONLY ONCE, EVER. The server records that the question was put,
   *     so a second tab, a refresh or tomorrow's visit does not ask
   *     again about the same click.
   *   - ONE AT A TIME. Three pending jobs produce three questions in
   *     sequence, not three dialogs on top of each other.
   * ------------------------------------------------------------------ */
  var HIDDEN_MIN_MS = 3000;
  var MAX_IN_A_ROW = 3;

  var askQueue = [];
  var asking = false;
  var armed = false;
  var hiddenAt = 0;
  var debounceTimer = null;

  function rememberPending(id) {
    try {
      var raw = sessionStorage.getItem('tl_xj_pending');
      var list = raw ? JSON.parse(raw) : [];
      if (list.indexOf(id) < 0) list.push(id);
      sessionStorage.setItem('tl_xj_pending', JSON.stringify(list.slice(-10)));
    } catch (e) { /* private mode, blocked storage - the server still knows */ }
  }
  function forgetPending(id) {
    try {
      var raw = sessionStorage.getItem('tl_xj_pending');
      var list = raw ? JSON.parse(raw) : [];
      sessionStorage.setItem('tl_xj_pending',
        JSON.stringify(list.filter(function (x) { return x !== id; })));
    } catch (e) {}
  }

  /** The dialog itself. Resolves when it has been answered or waved away. */
  function askOne(app) {
    return new Promise(function (done) {
      var title = app.jobTitle || 'that job';
      var company = app.company || 'the employer';
      var via = app.originalPublisher || app.sourceName || '';

      var host = document.createElement('div');
      host.className = 'xj-ask';
      host.innerHTML = '<div class="xj-ask-box" role="dialog" aria-modal="true">'
        + '<div class="xj-ask-q">Did you apply to ' + esc(title) + ' at '
        +   esc(company) + '?</div>'
        + (via ? '<div class="xj-ask-v">via ' + esc(via) + '</div>' : '')
        + '<div class="xj-ask-n">We cannot see what happens on an employer’s '
        + 'site. Whatever you tell us is what your list will say.</div>'
        + '<div class="xj-ask-b">'
        + '<button class="btn primary" data-a="yes">Yes, I applied</button>'
        + '<button class="btn" data-a="no">No, I did not</button>'
        + '<button class="btn xj-ask-later" data-a="later">Ask me later</button>'
        + '</div></div>';

      var close = function () { if (host.parentNode) host.parentNode.removeChild(host); };

      host.addEventListener('click', function (ev) {
        var a = ev.target && ev.target.getAttribute('data-a');
        if (!a) return;              /* the backdrop does NOT dismiss a question */
        close();

        if (a === 'later') { done(); return; }   /* stays Clicked, on purpose */

        forgetPending(app.id);
        TL.api.post('/external/applications/' + encodeURIComponent(app.id) + '/confirm',
          { applied: a === 'yes' })
          .then(function () {
            toast(a === 'yes'
              ? 'Recorded — you said you applied'
              : 'Put back in your list', a === 'yes' ? '✅' : '↩️');
            loadCandidate();
          }, function (e) {
            toast((e && e.message) || 'Could not record that', '⚠️');
          })
          .then(done, done);
      });

      document.body.appendChild(host);
    });
  }

  function drainQueue() {
    if (asking) return;
    var next = askQueue.shift();
    if (!next) return;
    asking = true;

    /* The server decides whether this one has been asked already, so two
       tabs cannot both ask and a reload cannot ask twice. */
    TL.api.post('/external/applications/' + encodeURIComponent(next.id) + '/prompt-shown', {})
      .then(function (r) {
        if (!r || r.first !== true) { asking = false; drainQueue(); return null; }
        return askOne(next).then(function () { asking = false; drainQueue(); });
      }, function () { asking = false; drainQueue(); });
  }

  function queueAsk(app) {
    if (!app || !app.id) return;
    if (askQueue.length >= MAX_IN_A_ROW) return;
    for (var i = 0; i < askQueue.length; i += 1) {
      if (askQueue[i].id === app.id) return;
    }
    askQueue.push(app);
  }

  /** Whatever is still unanswered, from the server rather than this tab. */
  function askPending(minutes) {
    if (!TL.session || TL.session.role !== 'candidate') return Promise.resolve([]);
    return TL.api.get('/external/applications/pending?minutes='
        + (minutes == null ? 5 : minutes))
      .then(function (r) {
        (r.pending || []).slice(0, MAX_IN_A_ROW).forEach(queueAsk);
        return r.pending || [];
      }, function () { return []; });
  }

  function onReturn() {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    /* Back too quickly to have done anything. */
    if (hiddenAt && Date.now() - hiddenAt < HIDDEN_MIN_MS) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      askPending(0).then(drainQueue);
    }, 250);
  }

  function armReturnListeners() {
    if (armed) return;
    armed = true;
    /*
     * BOTH EVENTS, AND PAGE SHOW.
     *
     * Mobile browsers are unreliable about visibilitychange when the
     * user switches apps, and some fire focus without it. Listening to
     * each and coalescing them is cheaper than being wrong on a phone,
     * which is where most of these candidates are.
     */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      onReturn();
    });
    window.addEventListener('focus', onReturn);
    window.addEventListener('pageshow', onReturn);
  }

  /* Kept for anything that still calls it by name. */
  function askOnReturn(applicationId) {
    rememberPending(applicationId);
    armReturnListeners();
  }

  function showBlockedFallback(url, app) {
    var host = document.createElement('div');
    host.className = 'xj-ask';
    host.innerHTML = '<div class="xj-ask-box">'
      + '<div class="xj-ask-q">Your browser blocked the new tab</div>'
      + '<div class="xj-ask-n">Open the employer’s page yourself — '
      + 'your click is already recorded, and we will ask how it went when '
      + 'you come back.</div>'
      + '<div class="xj-ask-b">'
      + '<a class="btn primary" href="' + esc(url) + '" target="_blank" '
      +   'rel="noopener noreferrer">Open job</a>'
      + '<button class="btn" data-a="close">Close</button>'
      + '</div></div>';
    host.addEventListener('click', function (ev) {
      var t = ev.target;
      if ((t && t.getAttribute('data-a') === 'close') || t === host
          || (t && t.tagName === 'A')) {
        if (host.parentNode) host.parentNode.removeChild(host);
      }
    });
    document.body.appendChild(host);
    if (app) queueAsk(app);
  }

  window.xjApply = function (externalJobId) {
    TL.api.post('/external/apply', { externalJobId: externalJobId }).then(function (out) {
      var url = out.applyUrl || out.redirectUrl;

      if (out.status === 'sample_posting') {
        /* No tab is opened: the link cannot resolve by design, and a
           browser error page reads as a broken product. */
        toast(out.note || 'This is a sample posting — there is no real advert to open',
          'ℹ️');
      } else if (url) {
        var win = null;
        try { win = window.open(url, '_blank', 'noopener,noreferrer'); } catch (e) { win = null; }

        if (win) {
          toast('Opening the employer’s page — finish your application there',
            '↗️');
        } else {
          /*
           * THE POPUP WAS BLOCKED.
           *
           * A real anchor, which the candidate taps themselves. Mobile
           * Safari in particular only opens a new tab for a direct tap
           * on a link, never for one a script clicks - so this has to be
           * something they press, not something we fire.
           */
          showBlockedFallback(url, out.application);
        }
        if (out.applicationId) rememberPending(out.applicationId);
        armReturnListeners();
        if (out.application) queueAsk(out.application);
      } else if (out.status === 'already_applied') {
        toast('You have already told us about this one', 'ℹ️');
      } else if (out.ok) {
        toast('Application sent', '✅');
      } else {
        toast('Could not apply: ' + ((out.note || out.error) || 'the source refused'),
          '⚠️');
      }

      /* The list is reloaded from the server, not patched locally: the
         job has to LEAVE the recommended list and APPEAR under External
         Applications, and both of those are decided by the server. */
      loadCandidate();
      return null;
    }).then(null, function (e) {
      toast('Could not apply: ' + ((e && e.message) || 'the server did not answer'),
        '⚠️');
    });
  };

  /* Whatever is still unanswered, asked for on arrival - so closing the
     tab, signing out or moving to another device does not lose it. */
  window.xjAskPending = function (minutes) {
    armReturnListeners();
    return askPending(minutes == null ? 5 : minutes).then(drainQueue);
  };

  /* If a session is already live when this file loads - a reload on a
     signed-in page - ask straight away rather than waiting for a render. */
  if (TL.ready && TL.session) {
    probe().then(function (on) { if (on) window.render(); });
  }
})();
