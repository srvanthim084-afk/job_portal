/*
 * Apply Now while signed out: register (or log in), then the application
 * continues by itself, for the same job.
 *
 *   Apply Now, signed out  -> the registration form, headed
 *                             "You're applying for: <job>", with Log in
 *                             and Cancel beside it
 *   register or log in     -> taken to that job and applied, once
 *   already signed in      -> applies directly, as before
 *
 * The job is remembered as an ID in sessionStorage (this tab only, gone
 * when the tab closes), never as a copy of the job. So it survives a
 * failed sign-in, a validation error, a refresh and the hop between the
 * register and login pages, and the job is read again when it is used.
 *
 * The browser does not decide anything. POST /api/applications still
 * requires a candidate session, refuses a job that is missing, closed,
 * paused or archived, and refuses a second application to the same role.
 *
 * TeamLink jobs only. External jobs (xjob_ ids) keep their own flow, which
 * sends the candidate to the original site and records nothing here.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__tlApplyAuth) return;
  window.__tlApplyAuth = true;

  var KEY = 'tl_apply_intent_v1';
  /* The website deep link's breadcrumb (index.html, "WEBSITE -> JOB
     PORTAL"). Cleared together, so the two never send the candidate to
     the job twice. */
  var LEGACY = 'teamlink_pending_job';
  var TTL = 60 * 60 * 1000;

  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function say(msg, icon) { if (typeof window.toast === 'function') window.toast(msg, icon); }

  function intent() {
    try {
      var v = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      if (!v || !v.jobId) return null;
      if (!(Date.now() - Number(v.at) < TTL)) { clearIntent(); return null; }
      return v;
    } catch (e) { return null; }
  }
  function remember(jobId) {
    try { sessionStorage.setItem(KEY, JSON.stringify({ jobId: String(jobId), at: Date.now() })); } catch (e) {}
  }
  function clearIntent() {
    try { sessionStorage.removeItem(KEY); sessionStorage.removeItem(LEGACY); } catch (e) {}
  }

  function session() { return (typeof STATE !== 'undefined' && STATE.session) || null; }
  function isCandidate() { var s = session(); return !!(s && s.role === 'candidate'); }
  function jobOf(id) {
    try { return (typeof DATA !== 'undefined' && DATA.jobById) ? DATA.jobById(id) : null; } catch (e) { return null; }
  }
  function isExternal(id) { return /^xjob_/.test(String(id || '')); }
  function closedJob(job) { return !!job && (job.status === 'closed' || job.paused === true || job.archived === true); }

  /* ---- 0. A job link that survives a refresh ----
     The deep-link layer looks the job up the moment the page loads, before
     the portal has loaded its jobs, so every refresh of #/job/<id> (and
     every link to one) answered "That job is no longer available" and went
     to the job list. It now waits until the portal is ready, and asks the
     portal's own API for a job it has not loaded. */
  function whenReady() {
    return new Promise(function (resolve) {
      var n = 0;
      (function poll() {
        if ((window.TL && TL.ready === true) || ++n > 80) return resolve();
        setTimeout(poll, 150);
      })();
    });
  }
  if (window.TL_API && typeof TL_API.getJob === 'function' && !TL_API.getJob.__waits) {
    var prevGetJob = TL_API.getJob;
    TL_API.getJob = function (id) {
      return whenReady().then(function () { return prevGetJob.call(TL_API, id); }).then(function (job) {
        if (job || !id || !(window.TL && TL.api)) return job;
        return TL.api.get('/jobs/' + encodeURIComponent(id))
          .then(function (r) { return (r && r.job) || null; }, function () { return null; });
      });
    };
    TL_API.getJob.__waits = true;
  }

  /* ---- 1. Apply Now while signed out ---- */
  ['applyToJob', 'easyApply'].forEach(function (fn) {
    var prev = window[fn];
    if (typeof prev !== 'function') return;
    window[fn] = function (jobId) {
      if (!jobId || isExternal(jobId) || session()) return prev.apply(this, arguments);
      /* Signed out. A staff session is not "signed out" and keeps the
         original message. */
      var job = jobOf(jobId);
      if (closedJob(job)) { say('This role is no longer accepting applications'); return; }
      remember(jobId);
      window.navigate('/register/candidate');
    };
  });

  /* ---- 2. The banner on the register and login pages ---- */
  function banner(where) {
    var it = intent();
    if (!it || isCandidate()) return '';
    var job = jobOf(it.jobId);
    var co = null;
    try { co = job && DATA.companyById ? DATA.companyById(job.companyId) : null; } catch (e) {}
    var what = job
      ? '<b>' + h(job.title) + '</b>' + (co && co.name ? ' · ' + h(co.name) : '') + (job.location ? ' · ' + h(job.location) : '')
      : '<b>the job you selected</b>';
    var other = where === 'register'
      ? 'Already have an account? <a href="#/login/candidate" style="font-weight:800;color:var(--brand-600)">Log in to apply</a>'
      : 'New to TeamLink? <a href="#/register/candidate" style="font-weight:800;color:var(--brand-600)">Create your profile</a>';
    var after = where === 'register'
      ? 'Create your profile and your application is submitted straight after.'
      : 'Sign in and your application is submitted straight after.';
    return '<div class="tl-apply-intent" role="status" style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;'
      + 'background:#eef8fb;border:1px solid #bfe3ee;border-radius:12px;padding:12px 14px;margin:0 0 16px;font-size:13.5px;color:#16323d;text-align:left">'
      + '<div style="font-size:20px;line-height:1">📝</div>'
      + '<div style="flex:1;min-width:200px"><div>You\'re applying for: ' + what + '</div>'
      + '<div style="font-size:12.5px;color:#4b6470;margin-top:3px">' + after + '</div>'
      + '<div style="font-size:12.5px;margin-top:6px">' + other + '</div></div>'
      + '<button type="button" class="btn btn-ghost btn-sm" onclick="tlApplyCancel()">Cancel</button>'
      + '</div>';
  }

  var prevRegister = window.pageRegisterCandidate;
  if (typeof prevRegister === 'function') {
    window.pageRegisterCandidate = function () {
      var out = prevRegister.apply(this, arguments);
      var b = banner('register');
      if (!b || typeof out !== 'string') return out;
      var at = out.indexOf('<div class="reg-wrap">');
      if (at < 0) return out;
      at += '<div class="reg-wrap">'.length;
      return out.slice(0, at) + b + out.slice(at);
    };
  }

  var prevLogin = window.pageLogin;
  if (typeof prevLogin === 'function') {
    window.pageLogin = function (role) {
      var out = prevLogin.apply(this, arguments);
      if (role !== 'candidate' || typeof out !== 'string') return out;
      var b = banner('login');
      if (!b) return out;
      var m = out.match(/<form class="auth-form"[^>]*>/);
      if (!m) return out;
      var at = out.indexOf(m[0]) + m[0].length;
      return out.slice(0, at) + b + out.slice(at);
    };
  }

  /** Cancel: back to the job, and the errand is over. */
  window.tlApplyCancel = function () {
    var it = intent();
    clearIntent();
    window.navigate(it ? '/job/' + it.jobId : '/jobs');
  };

  /* ---- 3. Signed in: continue the application ---- */
  var resuming = false;
  function resume(it) {
    if (resuming) return;
    resuming = true;
    clearIntent();
    var id = it.jobId;
    prevNavigate('/job/' + id);
    var go = function () {
      resuming = false;
      var job = jobOf(id);
      if (!job) { say('That job is no longer available on TeamLink', '⚠️'); return; }
      if (closedJob(job)) { say('This role is no longer accepting applications'); return; }
      var s = session();
      if (s && DATA.hasApplication && DATA.hasApplication(s.id, id)) {
        say('You have already applied to this role');
        if (typeof window.render === 'function') window.render();
        return;
      }
      /* The ordinary Apply Now, with the candidate's session: the server
         checks everything again. */
      window.applyToJob(id);
    };
    /* A job that lives only in the database is fetched first, by the
       deep-link layer that already knows how. */
    if (!jobOf(id) && typeof window.tlOpenJobById === 'function') {
      window.tlOpenJobById(id).then(go, go);
    } else {
      setTimeout(go, 0);
    }
  }

  /* Login and registration both finish by taking the candidate to their
     dashboard. That is the moment: the account exists, the profile and
     resume are saved, and the session is the candidate's. */
  var prevNavigate = window.navigate;
  window.navigate = function (path) {
    var it = intent();
    if (it && !resuming && isCandidate() && /^\/?candidate(\/|$)/.test(String(path || ''))) {
      resume(it);
      return;
    }
    return prevNavigate.apply(this, arguments);
  };

  /* Wandering off to something unrelated while signed out ends it, so a
     sign-in much later does not apply to a job the candidate moved on
     from. The pages that are part of signing in keep it. */
  function onRoute() {
    var it = intent();
    if (!it) return;
    if (isCandidate()) {
      /* Signed in by a path that never reached the dashboard (a refresh
         at the wrong moment). Still the same errand. */
      if (window.TL && TL.ready === true && !/^#\/(register|login)\b/.test(location.hash)) resume(it);
      return;
    }
    var head = String(location.hash || '').replace(/^#\/?/, '').split('?')[0].split('/');
    var keep = head[0] === 'register' || head[0] === 'login' || head[0] === 'forgot-password'
      || head[0] === 'reset-password' || (head[0] === 'job' && head[1] === it.jobId)
      || location.pathname === '/reset-password';
    if (!keep) clearIntent();
  }
  window.addEventListener('hashchange', onRoute);

  /* After a refresh: the session is known only once TL is ready. */
  var tries = 0;
  (function waitReady() {
    if (window.TL && TL.ready === true) { onRoute(); return; }
    if (++tries < 120) setTimeout(waitReady, 250);
  })();

  window.TLApplyAuth = { intent: intent, clear: clearIntent };
})();
