/* =====================================================================
   TEAMLINK - Apply Now is one click (0118)

     SIGNED IN     Apply Now -> the button says "Applying…" and is off ->
                   the application is created -> the button reads
                   "Applied ✓" wherever the job is shown, and a small toast
                   says "Applied successfully to <title> at <company>" with
                   Undo for five seconds. No form, window, drawer or page.
     FAILURE       an error toast with Retry; the button goes back to
                   Apply Now.
     ALREADY       "Applied ✓" from the start; never applied twice (the
                   server refuses a second one too).
     PROFILE       the only thing asked for is what a recruiter cannot do
                   without: name, email, mobile number, resume. If one is
                   missing, a small prompt "Please complete your profile to
                   apply" [Complete Profile] [Cancel]; Complete Profile goes
                   to the resume / profile, and when it is done the candidate
                   is back on the job and the application is sent.
     SIGNED OUT    Apply Now -> "Apply to <job>": Email / Mobile Number ->
                   Continue -> an existing account signs in with its
                   password, a new person registers (resume first) ->
                   the application is submitted automatically.
     EXTERNAL JOBS keep their own flow (they open the employer's site).

   The application form with CTC, notice period, locations, qualification
   and experience (teamlink-walkin-jobs.js) and the "A few quick questions"
   screening pop-up (teamlink-screening-questions.js) are not deleted - they
   are simply no longer between the candidate and the application. A job's
   screening questions stay "Answers pending" for the recruiter and the
   candidate can answer them from the link they are sent.

   ONE SERVER PATH. The application is made by POST
   /api/applications/one-click, which hands the request to the ordinary
   POST /api/applications: the same duplicate check, last-date guard,
   walk-in capacity, recruiter ownership, source, notifications and AI
   screening as every other application. This file only decides what the
   candidate is shown.

   Installed after every other Apply wrapper (window load, then checked
   again for a few seconds), so it is the outermost; the walk-in module
   also hands an Apply tap to this file, so either order gives one click.
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
  /* 0137: a walk-in whose dates are over - its own sentence, with the date (teamlink-walkin-jobs.js) */
  function walkinOver(job) {
    try { return window.TLWalkinJobs && TLWalkinJobs.overMessage ? TLWalkinJobs.overMessage(job) : ''; } catch (e) { return ''; }
  }
  function myApp(jobId) {
    var s = session(); if (!s) return null;
    return (DATA.applications || []).filter(function (a) { return a.candidateId === s.id && a.jobId === jobId; })[0] || null;
  }
  function refOf(a) { return a ? (a.reference || a.applicationId || a.id || '') : ''; }
  function modal(inner) {
    /* The "Build your profile" prompt (teamlink-profile-onboarding.js)
       may already be up from an earlier render; it would cover this.
       Only the prompt - never the builder itself, which holds typing. */
    if (document.querySelector('#tlpoHost .tlpo-modal') && typeof window.tlpoClose === 'function') window.tlpoClose();
    if (typeof window.fcrModal === 'function') { window.fcrModal(inner); return; }
    say('Please open My Applications');
  }
  function css() {
    if (document.getElementById('tl1cCss')) return;
    var s = document.createElement('style');
    s.id = 'tl1cCss';
    s.textContent = ''
      + '.tl1c-form{padding:18px 22px 4px;text-align:left}'
      + '.tl1c-form label{display:block;font-weight:700;font-size:13px;margin:10px 0 6px}'
      + '.tl1c-form input{width:100%;box-sizing:border-box}'
      + '.tl1c-form .err{color:var(--bad-600,#c0392b);font-size:12.5px;min-height:16px;margin-top:4px}'
      + '.tl1c-form .note{font-size:12.5px;color:var(--text-soft,#5b6e84);margin-top:8px}'
      /* the result of an apply: a small toast, never a window */
      + '#tl1cToastHost{position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:10050;width:min(94vw,460px);display:flex;flex-direction:column;gap:8px;pointer-events:none}'
      + '@media (max-width:820px){#tl1cToastHost{bottom:calc(env(safe-area-inset-bottom,0px) + 76px)}}'
      + '.tl1c-toast{pointer-events:auto;display:flex;align-items:flex-start;gap:10px;background:#0f2f2c;color:#fff;border-radius:12px;padding:12px 14px;box-shadow:0 12px 34px rgba(8,20,30,.3);font-size:13.5px;line-height:1.4}'
      + '.tl1c-toast.bad{background:#5a1a16}'
      + '.tl1c-toast .ic{flex:0 0 auto;width:22px;height:22px;border-radius:50%;background:#19b394;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800}'
      + '.tl1c-toast.bad .ic{background:#e0594f}'
      + '.tl1c-toast .tx{flex:1;min-width:0}.tl1c-toast .tx small{display:block;opacity:.72;font-size:11.5px;margin-top:2px}'
      + '.tl1c-toast .tx small#tl1cSoft{opacity:.92;margin-top:5px}.tl1c-toast .tl1c-soft-go{color:#7fe3cd;font-weight:800;text-decoration:underline;cursor:pointer}'
      + '.tl1c-toast button{flex:0 0 auto;min-height:34px;padding:0 12px;border-radius:8px;border:0;background:#fff;color:#0b1220;font-weight:800;cursor:pointer;font-family:inherit;font-size:12.5px}'
      + '.tl1c-toast button.x{background:transparent;color:#fff;opacity:.7;padding:0 6px;font-size:15px}'
      /* the buttons themselves */
      + '.tl1c-busy{opacity:.85;cursor:progress!important}'
      + '.tl1c-applied{background:var(--ok-100,#e0f5ef)!important;color:var(--ok-600,#0d7a63)!important;border-color:transparent!important}'
      /* the lightweight "complete your profile" prompt */
      + '.tl1c-pp{padding:20px 22px 6px}.tl1c-pp h3{margin:0 0 6px;font-size:17px}.tl1c-pp p{margin:4px 0;color:var(--text-soft,#5b6e84);font-size:13.5px}'
      + '.tl1c-ext-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--line,#e3eaf2)}'
      + '.tl1c-ext-row .m{font-size:12px;color:var(--text-soft,#5b6e84);margin-top:2px}'
      + '.tl1c-ext-badge{flex:0 0 auto;font-size:11.5px;font-weight:800;padding:4px 9px;border-radius:999px;background:var(--ok-100,#e0f5ef);color:var(--ok-600,#0d7a63)}'
      + '.tl1c-pp ul{margin:8px 0 2px;padding-left:18px;font-size:13px;color:#33465c}';
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------------------ *
   * the result: a small toast
   * ------------------------------------------------------------------ */
  var toastTimer = null;
  function toastHost() {
    css();
    var host = document.getElementById('tl1cToastHost');
    if (!host) { host = document.createElement('div'); host.id = 'tl1cToastHost'; document.body.appendChild(host); }
    return host;
  }
  function dismissToast() {
    clearTimeout(toastTimer);
    var host = document.getElementById('tl1cToastHost');
    if (host) host.innerHTML = '';
  }
  /* kind: 'ok' | 'bad' | 'info'. actions: [{label, id, fn}] */
  function showToast(id, kind, html, actions, ttl) {
    var host = toastHost();
    dismissToast();
    var el = document.createElement('div');
    el.className = 'tl1c-toast' + (kind === 'bad' ? ' bad' : '');
    el.id = id;
    el.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<span class="ic">' + (kind === 'bad' ? '!' : '✓') + '</span><div class="tx">' + html + '</div>';
    (actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = a.label; if (a.id) b.id = a.id;
      b.onclick = function () { try { a.fn(b); } catch (e) { /* the toast is only a courtesy */ } };
      el.appendChild(b);
    });
    var x = document.createElement('button');
    x.type = 'button'; x.className = 'x'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '✕';
    x.onclick = dismissToast;
    el.appendChild(x);
    host.appendChild(el);
    toastTimer = setTimeout(dismissToast, ttl || 6000);
    return el;
  }
  function companyName(job) {
    if (!job) return '';
    try {
      var c = DATA.companyById ? DATA.companyById(job.companyId) : null;
      if (c && c.name) return c.name;
    } catch (e) { /* fall through */ }
    return job.company || job.companyName || '';
  }
  function isWalkinJob(job) { try { return !!(job && window.TLWalkinJobs && TLWalkinJobs.isWalkin(job)); } catch (e) { return false; } }
  function walkinLine(job) {
    try {
      if (!(window.TLWalkinJobs && TLWalkinJobs.isWalkin(job))) return '';
      var parts = {};
      (TLWalkinJobs.details(job) || []).forEach(function (r) { parts[r[0]] = r[1]; });
      var when = [parts.Date, parts.Time].filter(Boolean).join(' ');
      return '<small>Walk-in: ' + h([when, parts.Venue].filter(Boolean).join(' · ')) + '</small>';
    } catch (e) { return ''; }
  }
  function appliedMessage(job) {
    var co = companyName(job);
    return 'Applied successfully to <b>' + h(job ? job.title : 'this job') + '</b>' + (co ? ' at <b>' + h(co) + '</b>' : '');
  }
  /* 0130: an incomplete profile never stops an application; it is
     mentioned afterwards, softly, with the way to finish it. */
  function softProfileLine() {
    try {
      var c = meRow();
      if (!c || typeof window.capCompletion !== 'function') return '';
      var pct = window.capCompletion(c);
      if (pct >= 100) return '';
      return '<small id="tl1cSoft">Complete your profile to improve your chances (' + h(pct) + '% done) · '
        + '<a href="#/candidate/profile" class="tl1c-soft-go" id="tl1cSoftGo">Complete profile</a></small>';
    } catch (e) { return ''; }
  }
  function wireSoftProfile() {
    var go1 = document.getElementById('tl1cSoftGo');
    if (go1) go1.onclick = function (e) {
      e.preventDefault();
      dismissToast();
      if (typeof window.tlpsCompleteNext === 'function') window.tlpsCompleteNext();
      else location.hash = '#/candidate/profile';
    };
  }
  function showSubmitted(job, app) {
    var UNDO_MS = 5000;
    var el = showToast('tl1cDone', 'ok',
      '<span id="tl1cMsg">' + appliedMessage(job) + '</span>'
      + (refOf(app) ? '<small>Application ID: <span id="tl1cRef">' + h(refOf(app)) + '</span></small>' : '') + walkinLine(job)
      + softProfileLine(),
      (isWalkinJob(job) ? [{ label: '📅 Add to Calendar', id: 'tl1cCal', fn: function () {
        if (typeof window.tlwkDownloadIcs === 'function') tlwkDownloadIcs(job.id, refOf(app));
      } }] : []).concat([{ label: 'Undo', id: 'tl1cUndo', fn: function () {
        if (window.TLPortalUpgrades && TLPortalUpgrades.undo) {
          dismissToast();
          TLPortalUpgrades.undo(app).then(function () { paintButtons(app.jobId); });
        }
      } }]), isWalkinJob(job) ? 10000 : 7000);
    wireSoftProfile();
    /* Undo is offered for five seconds, then goes (the server holds the
       application's messages for the same window and a little more). */
    setTimeout(function () { var u = document.getElementById('tl1cUndo'); if (u && el.contains(u)) u.remove(); }, UNDO_MS);
  }
  function showAlready(job, app) {
    showToast('tl1cAlready', 'ok',
      '<span id="tl1cMsg">You have already applied for this job.</span>'
      + (job ? '<small>' + h(job.title) + (refOf(app) ? ' · ' + h(refOf(app)) : '') + '</small>' : ''), [], 5000);
  }
  function showFailure(jobId, err) {
    var m = (err && err.message) || 'The application could not be sent.';
    showToast('tl1cFail', 'bad', '<span id="tl1cMsg">' + h(m) + '</span>', [{ label: 'Retry', id: 'tl1cRetry', fn: function () { dismissToast(); applyNow(jobId); } }], 9000);
  }

  /* ------------------------------------------------------------------ *
   * the buttons: "Applying…" -> "Applied ✓", wherever the job is shown
   * ------------------------------------------------------------------ */
  var FN_RX = /\b(applyToJob|easyApply|cpEasyApply|capApply|rjApplyJob)\s*\(/;
  function buttonsFor(jobId) {
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll('button[onclick], a[onclick]'), function (b) {
      var o = b.getAttribute('onclick') || '';
      if (FN_RX.test(o) && (o.indexOf("'" + jobId + "'") >= 0 || o.indexOf('"' + jobId + '"') >= 0)) out.push(b);
    });
    return out;
  }
  function setBusy(jobId, on) {
    buttonsFor(jobId).forEach(function (b) {
      if (on) {
        if (b.getAttribute('data-tl1c-label') == null) b.setAttribute('data-tl1c-label', b.textContent);
        b.disabled = true; b.setAttribute('aria-busy', 'true'); b.classList.add('tl1c-busy'); b.textContent = 'Applying…';
      } else {
        var l = b.getAttribute('data-tl1c-label');
        if (l != null) b.textContent = l;
        b.removeAttribute('data-tl1c-label'); b.removeAttribute('aria-busy'); b.classList.remove('tl1c-busy'); b.disabled = false;
      }
    });
  }
  /* Whatever was drawn says "✓ Applied" in the prototype; the product says "Applied ✓". */
  function paintButtons() {
    Array.prototype.forEach.call(document.querySelectorAll('button[disabled], .badge, .btn, .rj-btn, .cap-apply, .xj-apply'), function (b) {
      var t = (b.textContent || '').replace(/\s+/g, ' ').trim();
      if (t === '✓ Applied' || t === '✓ Application submitted') {
        if (b.children.length === 0) b.textContent = 'Applied ✓';
        if (b.tagName === 'BUTTON') b.classList.add('tl1c-applied');
      } else if (t === 'Applied ✓' && b.tagName === 'BUTTON') b.classList.add('tl1c-applied');
    });
  }

  /* ------------------------------------------------------------------ *
   * the profile: what must be there before an application can be sent
   * ------------------------------------------------------------------ */
  var AFTER_KEY = 'tl_apply_after_profile_v1';
  function meRow() { try { return DATA.candidateById ? DATA.candidateById(session().id) : null; } catch (e) { return null; } }
  /* What the recruiter needs to read an application at all. Everything
     else (notice period, expected pay, locations, ...) is optional. */
  function mandatoryMissing() {
    var c = meRow() || {};
    var out = [];
    if (!String(c.name || '').trim()) out.push({ key: 'name', label: 'your name' });
    if (!String(c.email || '').trim()) out.push({ key: 'email', label: 'your email' });
    if (!String(c.phone || '').trim()) out.push({ key: 'phone', label: 'your mobile number' });
    if (!String(c.resumeFile || '').trim()) out.push({ key: 'resume', label: 'your resume' });
    return out;
  }
  function profilePrompt(jobId, missing) {
    css();
    var job = jobOf(jobId);
    modal('<div class="tl1c-pp" id="tl1cProfile" data-job="' + h(jobId) + '">'
      + '<h3>Please complete your profile to apply</h3>'
      + '<p>' + (job ? 'To apply to <b>' + h(job.title) + '</b> we need:' : 'We need:') + '</p>'
      + '<ul>' + missing.map(function (m) { return '<li>' + h(m.label) + '</li>'; }).join('') + '</ul>'
      + '<p>It takes a minute, and your application is sent as soon as it is done.</p></div>'
      + '<div class="fcr-jd-actions" style="justify-content:flex-end">'
      + '<button type="button" class="btn btn-ghost" id="tl1cPpCancel">Cancel</button>'
      + '<button type="button" class="btn btn-primary" id="tl1cPpGo">Complete Profile</button></div>');
    var cancel = document.getElementById('tl1cPpCancel');
    var go1 = document.getElementById('tl1cPpGo');
    if (cancel) cancel.onclick = function () {
      try { sessionStorage.removeItem(AFTER_KEY); } catch (e) { /* nothing to clear */ }
      if (typeof window.fcrCloseModal === 'function') fcrCloseModal();
    };
    if (go1) go1.onclick = function () {
      try { sessionStorage.setItem(AFTER_KEY, JSON.stringify({ jobId: String(jobId), at: Date.now() })); } catch (e) { /* this tab only */ }
      var hasResume = !missing.some(function (m) { return m.key === 'resume'; });
      go(hasResume ? '/candidate/profile' : '/candidate/resume');
      if (hasResume) setTimeout(function () { if (typeof window.tlpsCompleteNext === 'function') window.tlpsCompleteNext(); }, 400);
    };
  }
  /* After the profile is done: back to the job, and the application is sent. */
  function afterProfile() {
    var raw = null;
    try { raw = sessionStorage.getItem(AFTER_KEY); } catch (e) { return; }
    if (!raw || !isCandidate() || applying.__after) return;
    var it; try { it = JSON.parse(raw); } catch (e) { it = null; }
    if (!it || !it.jobId || Date.now() - (it.at || 0) > 2 * 3600 * 1000) { try { sessionStorage.removeItem(AFTER_KEY); } catch (e) { /* ok */ } return; }
    if (mandatoryMissing().length) return;                 // still on it
    try { sessionStorage.removeItem(AFTER_KEY); } catch (e) { /* ok */ }
    applying.__after = true;
    go('/job/' + it.jobId);
    setTimeout(function () { delete applying.__after; applyNow(it.jobId); }, 700);
  }

  function applyNow(jobId) {
    var job = jobOf(jobId);
    if (!applying[jobId]) dismissToast();               // a new apply replaces the last answer
    var had = myApp(jobId);
    if (had) { showAlready(job, had); paintButtons(); return Promise.resolve(had); }
    var over = walkinOver(job);
    if (over) { say(over, '📪'); return Promise.resolve(null); }
    if (closed(job)) { say('This role is no longer accepting applications', '⏳'); return Promise.resolve(null); }
    if (applying[jobId]) return applying[jobId];
    var missing = mandatoryMissing();
    if (missing.length) { profilePrompt(jobId, missing); return Promise.resolve(null); }

    var body = { jobId: jobId };
    try { if (TL.applicationSource) body.source = TL.applicationSource(); } catch (e) { /* the server's default source */ }
    setBusy(jobId, true);
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
      /* The prototype's post-apply record (the AI-interview chip and its
         button hang off it), without its own page change or toast. */
      if (!res.existing && typeof window.__afterApply === 'function') {
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
      paintButtons();
      if (res.existing) showAlready(job, a); else showSubmitted(job, a);
      return a;
    }, function (err) {
      delete applying[jobId];
      setBusy(jobId, false);
      if (err && err.code === 'DUPLICATE_APPLICATION') { rerender(); showAlready(job, myApp(jobId)); return null; }
      showFailure(jobId, err);
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
    if (!s) {
      var job = jobOf(jobId);
      var over = walkinOver(job);
      if (over) { say(over, '📪'); return true; }
      if (closed(job)) { say('This role is no longer accepting applications'); return true; }
      signInBox(jobId); return true;
    }
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

  function start() {
    install();
    /* Other modules install their Apply wrappers at load too; stay outermost. */
    var n = 0;
    var t = setInterval(function () { install(); if (++n >= 10) clearInterval(t); }, 500);
  }
  if (document.readyState === 'complete') setTimeout(start, 0);
  else window.addEventListener('load', function () { setTimeout(start, 0); });

  /* ------------------------------------------------------------------ *
   * external jobs on the candidate's Applications page
   *
   * Apply Now on an external job opens the employer's page in a new tab
   * (teamlink-portal-external.js) and records the click against the
   * candidate. It is listed here as "Applied (External)": where it was
   * applied is in the words, and TeamLink makes no claim about what the
   * employer received. It is not an ATS application and has no stage.
   * ------------------------------------------------------------------ */
  var ext = { at: 0, rows: null, busy: false };
  function extWhen(v) {
    var d = v ? new Date(v) : null;
    if (!d || isNaN(d)) return '';
    var today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Today';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function paintExternal() {
    if (!isCandidate() || !/^#\/candidate\/applications/.test(location.hash)) return;
    var wrap = document.querySelector('.cp-wrap');
    if (!wrap) return;
    if (!ext.rows || Date.now() - ext.at > 5000) {
      if (ext.busy) return;
      ext.busy = true;
      api().get('/external/applications').then(function (r) {
        ext.rows = (r && r.applications) || []; ext.at = Date.now(); ext.busy = false; paintExternal();
      }, function () { ext.rows = ext.rows || []; ext.at = Date.now(); ext.busy = false; });
      if (!ext.rows) return;
    }
    var rows = (ext.rows || []).filter(function (a) { return a.status === 'clicked' || a.status === 'applied_unconfirmed' || a.status === 'applied'; });
    var old = document.getElementById('tl1cExt');
    var sig = rows.map(function (a) { return a.id + a.status; }).join('|');
    if (!rows.length) { if (old) old.remove(); return; }
    if (old && old.getAttribute('data-sig') === sig) return;
    if (old) old.remove();
    css();
    var html = '<div class="cp-card" id="tl1cExt" data-sig="' + h(sig) + '"><div class="cp-h2" style="margin:0 0 8px"><h2 style="font-size:15px">External applications</h2></div>'
      + '<div style="font-size:12.5px;color:var(--text-soft,#5b6e84);margin-bottom:8px">Applied on the employer’s own site. TeamLink can’t see what happens there.</div>'
      + rows.map(function (a) {
        return '<div class="tl1c-ext-row"><div><b>' + h(a.jobTitle || '—') + '</b><div class="m">' + h(a.company || '') + (a.originalPublisher || a.sourceName ? ' · via ' + h(a.originalPublisher || a.sourceName) : '') + ' · ' + h(extWhen(a.lastOpenedAt || a.createdAt)) + '</div></div>'
          + '<span class="tl1c-ext-badge">Applied (External)</span></div>';
      }).join('') + '</div>';
    var first = wrap.querySelector(':scope > .cp-card');
    if (first) first.insertAdjacentHTML('beforebegin', html); else wrap.insertAdjacentHTML('beforeend', html);
  }

  /* True while an apply is in flight, about to resume after sign-in, or
     its result is on screen. Prompts that open on render (the profile
     builder) wait for it, so nothing covers the confirmation. */
  function holding() {
    if (Object.keys(applying).length) return true;
    if (document.querySelector('#tl1cDone, #tl1cAlready, #tl1cFail, #tl1cForm, #tl1cProfile')) return true;
    try { return !!(sessionStorage.getItem(INTENT_KEY) || sessionStorage.getItem(AFTER_KEY)); } catch (e) { return false; }
  }

  /* Each repaint: the words on an applied button, and the return from the
     profile to the job. */
  (function wireRender() {
    var tries = 0;
    var t = setInterval(function () {
      var prev = window.render;
      if (typeof prev === 'function' && !prev.__tl1cr) {
        var next = function () { var r = prev.apply(this, arguments); setTimeout(function () { try { paintButtons(); afterProfile(); paintExternal(); } catch (e) { /* cosmetic */ } }, 0); return r; };
        next.__tl1cr = true; window.render = next;
      }
      if (++tries > 80) clearInterval(t);
    }, 500);
    var pending = false;
    try {
      new MutationObserver(function () {
        if (pending) return;
        pending = true;
        setTimeout(function () { pending = false; try { paintButtons(); paintExternal(); } catch (e) { /* cosmetic */ } }, 60);
      }).observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* render covers it */ }
  })();
  /* The resume is uploaded without a repaint of the page: look again when the data refreshes. */
  setInterval(function () { try { afterProfile(); } catch (e) { /* cosmetic */ } }, 1500);

  window.TLOneClickApply = { version: '0118', apply: applyNow, signIn: signInBox, prefillKey: PREFILL_KEY, holding: holding, missing: mandatoryMissing };
})();
