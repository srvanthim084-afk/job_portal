/*
 * TeamLink — job source separation, the browser's side (owner, 2026-10-05).
 *
 *   JOBS PAGE          = TEAMLINK jobs only
 *   EXTERNAL JOBS PAGE = EXTERNAL jobs only
 *
 * THE SERVER IS THE ENFORCEMENT (migration 0113, api/src/jobs/source-scope.js):
 * every Jobs-page endpoint reads TeamLink's jobs only and refuses any other
 * sourceType; every External Jobs endpoint reads external_jobs only. This
 * file is the SECONDARY guard the owner asked for, and changes nothing on
 * screen:
 *
 *   1. the Jobs page's requests say what they are for - sourceType=TEAMLINK
 *      on the chips (/jobs?quick=), match reasons, voice / natural-language
 *      search and saved searches - so the scope is explicit both ends;
 *   2. the Jobs page's dataset (DATA.openJobs, which the list, the AI
 *      recommendations, the counts and every filter read) never contains a
 *      job whose sourceType is EXTERNAL or whose id is an external one;
 *   3. the External Jobs page's lists never contain a TeamLink job;
 *   4. the prototype's simulated "Recommended by TeamLink" block of external
 *      listings is never drawn on the Jobs page.
 */
(function () {
  'use strict';

  var isExternalId = function (id) { return /^xjob_/.test(String(id || '')); };
  var staff = function () {
    var r = window.STATE && STATE.session && STATE.session.role;
    return r === 'recruiter' || r === 'admin' || r === 'bde' || r === 'client';
  };
  /* A job that may be on the Jobs page. */
  function teamlinkJob(j) {
    if (!j || isExternalId(j.id)) return false;
    return !j.sourceType || j.sourceType === 'TEAMLINK';
  }
  /* A job that may be on the External Jobs page (a match row carries it in .job). */
  function externalRow(x) {
    if (!x) return false;
    var j = x.job || x;
    if (j.sourceType === 'TEAMLINK') return false;
    var id = j.id || x.externalJobId;
    return !id || isExternalId(id);
  }
  window.TLJobSource = { teamlinkJob: teamlinkJob, externalRow: externalRow };

  /* ---- 1 + 3: the requests ------------------------------------------- */
  var JOBS_PAGE_GET = /^\/(jobs\?|job-matches\/explain\?)/;
  var JOBS_PAGE_POST = /^\/(search\/voice-parse|search\/semantic|saved-searches)$/;
  var EXTERNAL_GET = /^\/external\/(recommended|matches)(\?|$)/;
  function wrapApi() {
    var api = window.TL && TL.api;
    if (!api || api.__tlsrc) return !!api;
    var get = api.get, post = api.post;
    api.get = function (p, o) {
      var path = String(p || '');
      if (JOBS_PAGE_GET.test(path) && !/[?&]sourceType=/.test(path)) path += '&sourceType=TEAMLINK';
      var out = get.call(this, path, o);
      if (EXTERNAL_GET.test(path) && out && typeof out.then === 'function') {
        out = out.then(function (r) {
          if (r && Array.isArray(r.jobs)) r.jobs = r.jobs.filter(externalRow);
          if (r && Array.isArray(r.matches)) r.matches = r.matches.filter(externalRow);
          return r;
        });
      }
      return out;
    };
    api.post = function (p, b, o) {
      var path = String(p || '');
      if (JOBS_PAGE_POST.test(path) && b && typeof b === 'object' && !Array.isArray(b) && !b.sourceType) {
        b = Object.assign({}, b, { sourceType: 'TEAMLINK' });
      }
      return post.call(this, path, b, o);
    };
    api.__tlsrc = true;
    return true;
  }

  /* ---- 2: the Jobs page's dataset ------------------------------------- */
  function wrapData() {
    if (typeof window.DATA === 'undefined' || typeof DATA.openJobs !== 'function') return false;
    if (DATA.openJobs.__tlsrc) return true;
    var prev = DATA.openJobs;
    var next = function () {
      var list = prev.apply(this, arguments);
      /* Staff screens are the ATS, which keeps every row it may read. */
      return Array.isArray(list) && !staff() ? list.filter(teamlinkJob) : list;
    };
    next.__tlsrc = true;
    DATA.openJobs = next;
    return true;
  }

  /* ---- 4: the prototype's simulated external block -------------------- */
  function quietMock() {
    if (typeof window.extRecommendedHtml === 'function' && !window.extRecommendedHtml.__tlsrc) {
      var none = function () { return ''; };
      none.__tlsrc = true;
      window.extRecommendedHtml = none;
    }
  }

  /* Re-applied on every render: a module loaded later may wrap
     DATA.openJobs again (each wrapper calls the one before it, so the
     filter stays in the chain either way). */
  function install() {
    wrapApi(); wrapData(); quietMock();
    var r = window.render;
    if (typeof r === 'function' && !r.__tlsrc) {
      var r2 = function () { wrapApi(); wrapData(); quietMock(); return r.apply(this, arguments); };
      r2.__tlsrc = true;
      /* keep flags other wrappers set on render */
      for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) r2[k] = r[k];
      window.render = r2;
    }
  }
  install();
  if (document.readyState !== 'complete') window.addEventListener('load', install);
})();
