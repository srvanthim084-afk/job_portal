/* =====================================================================
   TEAMLINK — Apply Now is one click (0118)

     SIGNED IN     Apply Now -> the application is created -> "Application
                   Submitted Successfully", the Application ID, and
                   [View Application] [Complete Profile]. No questions.
     SIGNED OUT    Apply Now -> "Apply to <job>": Email / Mobile Number ->
                   Continue -> an existing account signs in with its
                   password, a new person registers (resume-first) ->
                   the application is submitted automatically.
     ALREADY       "You have already applied for this job." Never twice.

   NOTHING ON THE PROFILE IS REQUIRED TO APPLY. The application form with
   CTC, notice period, locations, qualification and experience
   (teamlink-walkin-jobs.js) and the "A few quick questions" screening
   pop-up (teamlink-screening-questions.js) are not deleted - they are
   simply no longer between the candidate and the application. The
   profile questions live on the profile ("Complete Profile"); a job's
   screening questions stay "Answers pending" for the recruiter and the
   candidate can still answer them from the link they are sent.

   ONE SERVER PATH. The application is made by POST
   /api/applications/one-click, which hands the request to the ordinary
   POST /api/applications: the same duplicate check, last-date guard,
   walk-in capacity, recruiter ownership, source, notifications and AI
   screening as every other application. This file only decides what the
   candidate is shown.

   Installed after every other Apply wrapper (window load, then checked
   again for a few seconds), so it is the outermost: an Apply tap on a
   TeamLink job reaches this first. External jobs keep their own flow.
   ===================================================================== */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__tlOneClickApply) return;
  window.__tlOneClickApply = true;

  var INTENT_KEY = 'tl_apply_intent_v1';          // teamlink-apply-auth.js resumes from this
  var PREFILL_KEY = 'tl_apply_contact_v1';        // the email typed here, offered at registration
  var EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var applying = Object.create(null);

  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api() { return window.TL && TL.api; }
  function say(m, i) { if (typeof window.toast === 'function') window.toast(m, i || 'ℹ️'); }
  function session() { return (typeof STATE !== 'undefined' && STATE.session) || null; }
  function isCandidate() { var s = session(); return !!(s && s.role === 'candidate'); }
  function isExternal(id) { return /^xjob_/.test(String(id || '')); }
  function jobOf(id) { try { return DATA.jobById ? DATA.jobById(id) : null; } catch (e) { return null; } }
  function rerender() { if (typeof window.render === 'function') window.render(); }
  function go(path) { if (typeof window.fcrCloseModal === 'function') fcrCloseModal(); if (typeof window.navigate === 'function') window.navigate(path); }
  function closed(job) { return !!job && (job.status === 'closed' || job.paused === true || job.archived === true); }
  function myApp(jobId) {
    var s = session(); if (!s) return null;
    return (DATA.applications || []).filter(function (a) { return a.candidateId === s.id && a.jobId === jobId; })[0] || null;
  }
  function refOf(a) { return a ? (a.reference || a.applicationId || a.id || '') : ''; }
  function modal(inner) {
    if (typeof window.fcrModal === 'function') { window.fcrModal(inner); return; }
    say('Application update: please open My Applications');
  }
  function css() {
    if (document.getElementById('tl1cCss')) return;
    var s = document.createElement('style');
    s.id = 'tl1cCss';
    s.textContent = ''
      + '.tl1c{padding:22px 22px 6px;text-align:center}'
      + '.tl1c .tick{width:52px;height:52px;border-radius:50%;margin:0 auto 10px;display:flex;align-items:center;justify-content:center;font-size:26px;background:var(--ok-100,#e8f6ee);color:var(--ok-600,#1d6b3f)}'
      + '.tl1c .tick.info{background:#eef4ff;color:#2f5bd3}'
      + '.tl1c h3{margin:0 0 6px;font-size:19px}'
      + '.tl1c p{margin:4px 0;color:var(--text-soft,#5b6e84);font-size:13.5px}'
      + '.tl1c .ref{display:inline-block;font-family:var(--font-mono,monospace);font-weight:800;font-size:17px;background:#f2f4f7;border-radius:8px;padding:6px 12px;margin:4px 0 8px;color:#16202c}'
      + '.tl1c-form{padding:18px 22px 4px;text-align:left}'
      + '.tl1c-form label{display:block;font-weight:700;font-size:13px;margin:10px 0 6px}'
      + '.tl1c-form input{width:100%;box-sizing:border-box}'
      + '.tl1c-form .err{color:var(--bad-600,#c0392b);font-size:12.5px;min-height:16px;margin-top:4px}'
      + '.tl1c-form .note{font-size:12.5px;color:var(--text-soft,#5b6e84);margin-top:8px}';
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------------------ *
   * signed in: apply now
   * ------------------------------------------------------------------ */
  function showSubmitted(job, app) {
    css();
    modal('<div class="tl1c" id="tl1cDone" role="status" aria-live="polite"><div class="tick">✓</div>'
      + '<h3>Application Submitted Successfully</h3>'
      + (job ? '<p><b style="color:#16202c">' + h(job.title) + '</b></p>' : '')
      + '<p style="margin-top:10px">Application ID:</p><div class="ref" id="tl1cRef">' + h(refOf(app)) + '</div>'
      + '<p>You can complete or update your profile anytime.</p></div>'
      + '<div class="fcr-jd-actions" style="justify-content:center;flex-wrap:wrap">'
      + '<button type="button" class="btn btn-primary" data-tl1c-go="/candidate/applications">View Application</button>'
      + '<button type="button" class="btn btn-ghost" data-tl1c-go="profile">Complete Profile</button></div>');
  }

  function showAlready(job, app) {
    css();
    modal('<div class="tl1c" id="tl1cAlready"><div class="tick info">✓</div>'
      + '<h3>Applied</h3><p>You have already applied for this job.</p>'
      + (job ? '<p><b style="color:#16202c">' + h(job.title) + '</b></p>' : '')
      + (app && refOf(app) ? '<p style="margin-top:10px">Application ID:</p><div class="ref">' + h(refOf(app)) + '</div>' : '')
      + '</div><div class="fcr-jd-actions" style="justify-content:center;flex-wrap:wrap">'
      + '<button type="button" class="btn btn-primary" data-tl1c-go="/candidate/applications">View Application</button>'
      + '<button type="button" class="btn btn-ghost" onclick="fcrCloseModal()">Close</button></div>');
  }

  function applyNow(jobId) {
    var job = jobOf(jobId);
    var had = myApp(jobId);
    if (had) { showAlready(job, had); return Promise.resolve(had); }
    if (closed(job)) { say('This role is no longer accepting applications', '⏳'); return Promise.resolve(null); }
    if (applying[jobId]) return applying[jobId];
    var body = { jobId: jobId };
    try { if (TL.applicationSource) body.source = TL.applicationSource(); } catch (e) { /* the server's default source */ }
    applying[jobId] = api().post('/applications/one-click', body).then(function (res) {
      delete applying[jobId];
      var a = res.application;
      a.fromServer = true;
      var have = (DATA.applications || []).some(function (x) {
        return x.id === a.id || (x.candidateId === a.candidateId && x.jobId === a.jobId);
      });
      if (!have) DATA.applications.push(a);
      if (job && typeof res.applicants === 'number') job.applicants = res.applicants;
      if (res.notification && window.TL && TL.notifications) TL.notifications.unshift(res.notification);
      if (res.existing) { rerender(); showAlready(job, a); return a; }
      /* The prototype's post-apply record (the AI-interview chip and its
         button hang off it), without its own page change or toast. */
      if (typeof window.__afterApply === 'function') {
        var nav = window.navigate, t = window.toast;
        try {
          window.navigate = function () {};
          window.toast = function () {};
          window.__afterApply(a.id, jobId, session().id, DATA.candidateById(session().id), job, true);
        } catch (e) { /* the application stands either way */ }
        finally { window.navigate = nav; window.toast = t; }
        try { if (TL.syncInterviewDeadlines) TL.syncInterviewDeadlines(); } catch (e) { /* optional */ }
      }
      rerender();
      showSubmitted(job, a);
      return a;
    }, function (err) {
      delete applying[jobId];
      if (err && err.code === 'DUPLICATE_APPLICATION') { showAlready(job, myApp(jobId)); return null; }
      if (api() && api().say) api().say(err); else say((err && err.message) || 'The application could not be sent.', '⚠️');
      return null;
    });
    return applying[jobId];
  }

  /* ------------------------------------------------------------------ *
   * signed out: Email / Mobile -> Continue
   * ------------------------------------------------------------------ */
  function remember(jobId) {
    try { sessionStorage.setItem(INTENT_KEY, JSON.stringify({ jobId: String(jobId), at: Date.now() })); } catch (e) { /* this tab only */ }
  }

  function signInBox(jobId) {
    css();
    var job = jobOf(jobId);
    modal('<div class="fcr-jd-head"><h3>Apply to ' + h(job ? job.title : 'this job') + '</h3>'
      + '<button class="fcr-jd-x" type="button" onclick="fcrCloseModal()" aria-label="Close">✕</button></div>'
      + '<form class="tl1c-form" id="tl1cForm" novalidate>'
      + '<label for="tl1cId">Email / Mobile Number</label>'
      + '<input id="tl1cId" autocomplete="username" inputmode="email" placeholder="you@example.com or 98765 43210">'
      + '<div id="tl1cPwWrap" hidden><label for="tl1cPw">Password</label>'
      + '<input id="tl1cPw" type="password" autocomplete="current-password">'
      + '<div class="note"><a href="#/forgot-password" onclick="fcrCloseModal()">Forgot password?</a></div></div>'
      + '<div class="err" id="tl1cErr" role="alert"></div>'
      + '<div class="note" id="tl1cNote">Your application is submitted as soon as you are signed in.</div>'
      + '</form>'
      + '<div class="fcr-jd-actions"><button type="button" class="btn btn-primary" id="tl1cGo">Continue</button></div>');
    var step = 'id';
    var form = document.getElementById('tl1cForm');
    var btn = document.getElementById('tl1cGo');
    var err = function (m) { document.getElementById('tl1cErr').textContent = m || ''; };
    var field = document.getElementById('tl1cId');
    if (field) field.focus();
    var next = function () {
      err('');
      var id = String(document.getElementById('tl1cId').value || '').trim();
      var isEmail = EMAIL_RX.test(id);
      var digits = id.replace(/\D/g, '');
      var isMobile = !isEmail && digits.length >= 10 && digits.length <= 13;
      if (!isEmail && !isMobile) { err('Enter your email address or 10-digit mobile number.'); return; }
      if (step === 'id') {
        btn.disabled = true;
        api().post('/auth/register/check', isEmail ? { email: id } : { phone: id }).then(function (r) {
          btn.disabled = false;
          if (r.emailTaken || r.phoneTaken) {
            step = 'password';
            document.getElementById('tl1cPwWrap').hidden = false;
            document.getElementById('tl1cNote').textContent = 'Welcome back. Sign in and your application is submitted.';
            btn.textContent = 'Sign in & apply';
            document.getElementById('tl1cPw').focus();
            return;
          }
          /* A new person: registration, resume first; the application is
             submitted the moment the account exists. */
          remember(jobId);
          try { if (isEmail) sessionStorage.setItem(PREFILL_KEY, id); } catch (e) { /* convenience only */ }
          go('/register/candidate');
          say('Create your account - your application is submitted right after.', '📝');
        }, function (e) { btn.disabled = false; err((e && e.message) || 'Please try again.'); });
        return;
      }
      var pw = document.getElementById('tl1cPw').value || '';
      if (!pw) { err('Please enter your password.'); return; }
      btn.disabled = true; btn.textContent = 'Signing in…';
      remember(jobId);
      api().post('/auth/login', { email: id, password: pw, role: 'candidate' }).then(function () {
        var after = (window.TL && typeof TL.refresh === 'function') ? TL.refresh() : Promise.resolve();
        return Promise.resolve(after);
      }).then(function () {
        if (typeof window.fcrCloseModal === 'function') fcrCloseModal();
        /* teamlink-apply-auth.js resumes the errand on the way to the
           dashboard: it opens the job and calls Apply Now, which is this
           file again - now signed in, so it applies. */
        if (typeof window.navigate === 'function') window.navigate('/candidate/home');
      }, function (e) {
        btn.disabled = false; btn.textContent = 'Sign in & apply';
        try { sessionStorage.removeItem(INTENT_KEY); } catch (x) { /* nothing to clear */ }
        err((e && e.message) || 'Incorrect email or password.');
      });
    };
    btn.addEventListener('click', next);
    form.addEventListener('submit', function (e) { e.preventDefault(); next(); });
  }

  /* ------------------------------------------------------------------ *
   * the wrappers
   * ------------------------------------------------------------------ */
  function handle(jobId) {
    var s = session();
    if (s && s.role !== 'candidate') return false;          // staff keep what they had
    if (!s) { var job = jobOf(jobId); if (closed(job)) { say('This role is no longer accepting applications'); return true; } signInBox(jobId); return true; }
    applyNow(jobId);
    return true;
  }

  var FNS = ['applyToJob', 'easyApply', 'cpEasyApply', 'capApply', 'rjApplyJob'];
  function install() {
    FNS.forEach(function (fn) {
      var prev = window[fn];
      if (typeof prev !== 'function' || prev.__tl1c) return;
      var w = function (jobId) {
        var id = jobId == null ? '' : String(jobId);
        if (!id || isExternal(id) || !(window.TL && TL.api)) return prev.apply(this, arguments);
        if (handle(id)) return undefined;
        return prev.apply(this, arguments);
      };
      w.__tl1c = true;
      window[fn] = w;
    });
  }

  document.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest && ev.target.closest('[data-tl1c-go]');
    if (!b) return;
    var to = b.getAttribute('data-tl1c-go');
    if (to === 'profile') {
      go('/candidate/profile');
      /* The profile's own "Complete profile": the first missing section,
         its editor open. */
      setTimeout(function () { if (typeof window.tlpsCompleteNext === 'function') window.tlpsCompleteNext(); }, 400);
      return;
    }
    go(to);
  });

  function start() {
    install();
    /* Other modules install their Apply wrappers at load too; stay outermost. */
    var n = 0;
    var t = setInterval(function () { install(); if (++n >= 10) clearInterval(t); }, 500);
  }
  if (document.readyState === 'complete') setTimeout(start, 0);
  else window.addEventListener('load', function () { setTimeout(start, 0); });

  window.TLOneClickApply = { apply: applyNow, signIn: signInBox, prefillKey: PREFILL_KEY };
})();
