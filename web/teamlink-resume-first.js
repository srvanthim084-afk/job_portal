/* =====================================================================
   TEAMLINK - candidate registration (0117, simplified)

     ONE SCREEN, always the same seven profile fields:
       Full Name, Phone, Email, Highest Education, Most Recent Job Role,
       Most Recent Company ("Fresher / No experience"), Skills (tags)
     + the account: email verification code, password + confirm,
       Terms & Privacy (required), recruitment communication (optional).

   THE RESUME IS OPTIONAL. Uploading one fills the seven fields; the
   candidate reads them, corrects them and creates the account. Without
   one, they type the same seven fields. Nothing is hidden behind the
   upload, and nothing is invented when a resume does not say it: an
   empty field stays empty, and a value the reader was unsure of is
   marked "Please check".

   THE SERVER HOLDS THE DRAFT. The file, its text, what was read and how
   sure each field is live in a registration draft (/api/registration/
   drafts) - created when a resume is chosen or when the email first needs
   its code, whichever comes first. This page keeps the draft id and token
   in sessionStorage, so a refresh picks up where it was.

   AFTER "Create account" the candidate is signed in and taken to the
   existing candidate landing page (#/candidate/home) automatically.
   The seven-step form (teamlink-registration.js) is still in the page,
   hidden and untouched.
   ===================================================================== */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__tlResumeFirst) return;
  window.__tlResumeFirst = true;

  var KEY = 'tl_reg_resume_draft_v1';
  var MANUAL_KEY = 'tl_reg_manual_v1';
  var ACCEPT = ['pdf', 'doc', 'docx', 'txt'];
  var MAX = 5 * 1024 * 1024;
  var EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var PHONE_RX = /^(?:\+?91[\s-]?|0)?[6-9]\d{9}$/;
  var EDUCATION = ['10th', 'Intermediate', 'Diploma', "Bachelor's Degree", "Master's Degree", 'PhD', 'Other'];
  var LANDING = '/candidate/home';
  /* The fields a resume can fill, and the draft key that says it was unsure. */
  var FILLED = ['name', 'phone', 'email', 'highestEducation', 'title', 'currentCompany', 'skills'];

  var S = {
    manual: (function () { try { return sessionStorage.getItem(MANUAL_KEY) === '1'; } catch (e) { return false; } })(),
    phase: 'form', draft: null, token: null, file: null, busy: false, reading: false, creating: false,
    err: {}, msg: '', codeSent: false, devCode: null, done: null,
    v: { name: '', phone: '', email: '', highestEducation: '', title: '', currentCompany: '', fresher: false, skills: [] },
    edited: {}, filled: {}, review: {},
    pw: '', pw2: '', terms: false, comm: false, resumeErr: '',
  };

  /* ------------------------------------------------------------------ */
  function $(id) { return document.getElementById(id); }
  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api() { return window.TL && window.TL.api; }
  function hdr() { return { headers: { 'x-draft-token': S.token }, timeout: 120000 }; }
  function say(m, i) { if (typeof window.toast === 'function') window.toast(m, i || 'ℹ️'); }
  function onRegisterPage() { return /^#\/register\/candidate/.test(location.hash || ''); }
  function signedIn() { return !!(window.STATE && STATE.session); }
  function remember() {
    try {
      if (S.draft && S.token) sessionStorage.setItem(KEY, JSON.stringify({ id: S.draft.draftId, token: S.token }));
      else sessionStorage.removeItem(KEY);
    } catch (e) { /* private mode: a refresh starts again, nothing is lost on the server */ }
  }
  function setManual(on) {
    S.manual = !!on;
    try { if (on) sessionStorage.setItem(MANUAL_KEY, '1'); else sessionStorage.removeItem(MANUAL_KEY); } catch (e) { /* this tab only */ }
  }
  function remembered() {
    try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function apiMessage(er) { return (er && er.message) || 'Something went wrong. Please try again.'; }
  function details(er) { return (er && (er.details || er.fields)) || {}; }
  function val(id) { var el = $(id); return el ? String(el.value || '').trim() : ''; }
  function dedupe(list) {
    var seen = {};
    return (list || []).map(function (x) { return String(x == null ? '' : x).trim(); }).filter(function (x) {
      var k = x.toLowerCase();
      if (!x || seen[k]) return false;
      seen[k] = 1; return true;
    });
  }

  /* ------------------------------------------------------------------ *
   * the page
   * ------------------------------------------------------------------ */
  function css() {
    if ($('tlrf-css')) return;
    var s = document.createElement('style');
    s.id = 'tlrf-css';
    s.textContent = ''
      + '#tlrfHost{margin:0 0 16px}'
      + '#tlrfHost .tlrf-found{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0}'
      + '#tlrfHost .tlrf-found span{background:var(--ok-100,#e8f6ee);color:var(--ok-700,#1d6b3f);border-radius:99px;padding:3px 10px;font-size:12px}'
      + '#tlrfHost .tlrf-err{color:var(--bad-600,#c0392b);font-size:12px;margin-top:4px}'
      + '#tlrfHost .tlrf-note{font-size:12.5px;color:var(--text-soft);margin:6px 0 0}'
      + '#tlrfHost .tlrf-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}'
      + '#tlrfHost .tlrf-row input{flex:1;min-width:160px}'
      + '#tlrfHost .tlrf-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}'
      + '#tlrfHost .tlrf-ok{color:var(--ok-700,#1d6b3f);font-weight:600;font-size:13px}'
      + '#tlrfHost .tlrf-dev{background:#fff7e6;border:1px solid #f3d38a;border-radius:8px;padding:8px 10px;font-size:12.5px;margin-top:6px}'
      + '#tlrfHost .tlrf-warn{background:#fff4f2;border:1px solid #f1c3bb;border-radius:8px;padding:10px 12px;font-size:13px;margin:0 0 12px}'
      + '#tlrfHost .tlrf-link{background:none;border:0;padding:0;color:var(--brand-600,#0f7c9c);text-decoration:underline;cursor:pointer;font:inherit}'
      + '#tlrfHost .tlrf-check{display:inline-block;margin-left:6px;background:#fff4dc;color:#8a5a00;border:1px solid #f1d28a;border-radius:99px;padding:0 8px;font-size:11px;font-weight:600}'
      + '#tlrfHost .tlrf-review input,#tlrfHost .tlrf-review select,#tlrfHost .tlrf-review .tlrf-tags{border-color:#e0a030!important;background:#fffaf0}'
      + '#tlrfHost .tlrf-tags{display:flex;flex-wrap:wrap;gap:6px;border:1px solid var(--line,#d5dde5);border-radius:8px;padding:6px;min-height:42px}'
      + '#tlrfHost .tlrf-tags input{flex:1;min-width:120px;border:0!important;outline:0;background:transparent;padding:4px}'
      + '#tlrfHost [hidden]{display:none!important}'
      + '@media (max-width:720px){#tlrfHost .review-grid{grid-template-columns:1fr}}';
    document.head.appendChild(s);
  }

  /* what the resume box says, in each of its states */
  function resumePanel() {
    var d = S.draft;
    var hasFile = d && d.resume;
    var body = '';
    if (S.reading) {
      body = '<div class="resume-upload-box"><div style="font-size:28px">📄</div><b>Reading your resume…</b>'
        + '<p>This takes a few seconds. Your resume is already saved.</p></div>';
    } else if (hasFile && d.status === 'failed') {
      var e = d.error || {};
      body = '<div class="tlrf-warn" role="alert"><b>' + h(e.message || "We couldn't extract your resume automatically. Please review or enter the missing information manually.") + '</b>'
        + '<div class="tlrf-note">Your resume <b>' + h(d.resume.fileName) + '</b> is saved - nothing is lost.</div></div>'
        + '<div class="tlrf-row"><button type="button" class="btn btn-ghost btn-sm" data-tlrf="retry"' + (S.busy ? ' disabled' : '') + '>Try reading it again</button>'
        + '<button type="button" class="btn btn-ghost btn-sm" data-tlrf="pick">Replace resume</button></div>';
    } else if (hasFile) {
      body = '<div class="tlrf-row"><div class="tlrf-ok">✓ ' + h(d.resume.fileName) + '</div>'
        + '<button type="button" class="btn btn-ghost btn-sm" data-tlrf="pick">Replace</button></div>'
        + '<div class="tlrf-found">' + foundSummary(d) + '</div>'
        + '<p class="tlrf-note">We filled the fields below from your resume. Please check them - and fix anything that is wrong.</p>';
    } else {
      body = '<div class="resume-upload-box"><div style="font-size:28px">📄</div><b>Upload your resume (optional)</b>'
        + '<p>We read it and fill the details below, so you type less. PDF, DOC, DOCX or TXT, up to 5 MB. No resume? Just fill in the details below.</p>'
        + '<button type="button" class="btn btn-primary" data-tlrf="pick" style="margin-top:10px">Choose resume</button></div>';
    }
    return '<div class="panel ai-panel"><div class="panel-head"><h2><span class="reg-section-num">1</span>Resume <span class="tlrf-note" style="font-weight:400">(optional)</span></h2></div>'
      + '<div class="panel-body">' + body
      + '<input type="file" id="tlrfFile" accept=".pdf,.doc,.docx,.txt" hidden aria-label="Resume file">'
      + (S.resumeErr ? '<div class="tlrf-err" role="alert">' + h(S.resumeErr) + '</div>' : '')
      + '</div></div>';
  }

  function foundSummary(d) {
    var f = d.fields || {};
    var bits = [];
    if (f.name) bits.push('Name');
    if (f.email) bits.push('Email');
    if (f.phone) bits.push('Mobile');
    if (f.highestEducation) bits.push(f.highestEducation);
    if (f.title) bits.push('Job role');
    if (f.currentCompany) bits.push('Company');
    if (f.skills && f.skills.length) bits.push(f.skills.length + ' skill' + (f.skills.length === 1 ? '' : 's'));
    if (f.projects && f.projects.length) bits.push(f.projects.length + ' project' + (f.projects.length === 1 ? '' : 's'));
    return bits.map(function (b) { return '<span>✓ ' + h(b) + '</span>'; }).join('');
  }

  function tag(k) {
    return S.review[k] && !S.edited[k] ? ' <span class="tlrf-check">Please check</span>' : '';
  }
  function cls(k) { return S.review[k] && !S.edited[k] ? ' tlrf-review' : ''; }
  function err(k) { return S.err[k] ? '<div class="tlrf-err" role="alert">' + h(S.err[k]) + '</div>' : ''; }

  function profilePanel() {
    var v = S.v, d = S.draft || {};
    var verified = isVerified();
    var exists = d.existing || {};
    var dup = S.err.dupEmail || exists.email;
    var warn = dup
      ? '<div class="tlrf-warn" role="alert">An account with this email already exists. '
        + '<a href="#/login/candidate">Login</a> or <a href="#/forgot-password">Forgot Password</a>.</div>'
      : (exists.phone ? '<div class="tlrf-warn" role="alert">An account with this mobile number already exists. <a href="#/login/candidate">Login</a> instead of registering again.</div>' : '');
    return '<div class="panel"><div class="panel-head"><h2><span class="reg-section-num">2</span>Your details</h2></div><div class="panel-body">'
      + warn
      + '<div class="review-grid"><div>'
      + '<div class="review-field' + cls('name') + '"><label for="tlrfName">Full Name *' + tag('name') + '</label>'
      + '<input id="tlrfName" data-f="name" autocomplete="name" value="' + h(v.name) + '">' + err('name') + '</div>'
      + '<div class="review-field' + cls('phone') + '"><label for="tlrfPhone">Phone Number *' + tag('phone') + '</label>'
      + '<input id="tlrfPhone" data-f="phone" type="tel" inputmode="numeric" autocomplete="tel" maxlength="15" placeholder="10-digit mobile number" value="' + h(v.phone) + '">' + err('phone') + '</div>'
      + '<div class="review-field' + cls('email') + '"><label for="tlrfEmail">Email *' + tag('email') + '</label>'
      + '<div class="tlrf-row"><input id="tlrfEmail" data-f="email" type="email" autocomplete="email" value="' + h(v.email) + '"' + (verified ? ' readonly' : '') + '>'
      + (verified ? '<span class="tlrf-ok">✓ Verified</span> <button type="button" class="tlrf-link" data-tlrf="changeemail">Change</button>'
        : '<button type="button" class="btn btn-ghost btn-sm" data-tlrf="sendcode"' + (S.busy ? ' disabled' : '') + '>' + (S.codeSent ? 'Send again' : 'Send code') + '</button>') + '</div>'
      + (verified ? '' : '<p class="tlrf-note">We email a 6-digit code to confirm the address.</p>')
      + (S.codeSent && !verified ? '<div class="tlrf-row" style="margin-top:6px"><input id="tlrfCode" inputmode="numeric" maxlength="6" placeholder="6-digit code" autocomplete="one-time-code">'
        + '<button type="button" class="btn btn-primary btn-sm" data-tlrf="verify"' + (S.busy ? ' disabled' : '') + '>Verify</button></div>' : '')
      + (S.devCode && !verified ? '<div class="tlrf-dev">Development server: email is not being sent. Your code is <b>' + h(S.devCode) + '</b>.</div>' : '')
      + err('email') + err('code') + '</div>'
      + '</div><div>'
      + '<div class="review-field' + cls('highestEducation') + '"><label for="tlrfEdu">Highest Education' + tag('highestEducation') + '</label>'
      + '<select id="tlrfEdu" data-f="highestEducation"><option value="">Select</option>'
      + EDUCATION.map(function (o) { return '<option' + (v.highestEducation === o ? ' selected' : '') + '>' + h(o) + '</option>'; }).join('')
      + '</select>' + err('highestEducation') + '</div>'
      + '<div class="review-field' + cls('title') + '"><label for="tlrfRole">Most Recent Job Role' + tag('title') + '</label>'
      + '<input id="tlrfRole" data-f="title" value="' + h(v.fresher ? '' : v.title) + '"' + (v.fresher ? ' disabled placeholder="Not applicable"' : ' placeholder="e.g. Software Engineer"') + '></div>'
      + '<div class="review-field' + cls('currentCompany') + '"><label for="tlrfCompany">Most Recent Company' + tag('currentCompany') + '</label>'
      + '<input id="tlrfCompany" data-f="currentCompany" value="' + h(v.fresher ? '' : v.currentCompany) + '"' + (v.fresher ? ' disabled placeholder="Fresher / No experience"' : ' placeholder="e.g. Infosys"') + '>'
      + '<label class="consent-row" style="margin:6px 0 0"><input type="checkbox" id="tlrfFresher"' + (v.fresher ? ' checked' : '') + '><span>Fresher / No experience</span></label></div>'
      + '</div></div>'
      + '<div class="review-field' + cls('skills') + '"><label for="tlrfSkillIn">Skills' + tag('skills') + '</label>'
      + '<div class="tlrf-tags">' + v.skills.map(function (s, i) {
        return '<span class="filter-chip">' + h(s) + '<button type="button" data-tlrf="rmskill" data-i="' + i + '" aria-label="Remove ' + h(s) + '">✕</button></span>';
      }).join('')
      + '<input id="tlrfSkillIn" placeholder="' + (v.skills.length ? 'Add a skill' : 'Type a skill and press Enter') + '" autocomplete="off"></div>'
      + '<p class="tlrf-note">Press Enter or comma to add. Click ✕ to remove.</p></div>'
      + '</div></div>';
  }

  function accountPanel() {
    return '<div class="panel"><div class="panel-head"><h2><span class="reg-section-num">3</span>Create your account</h2></div><div class="panel-body">'
      + '<div class="review-grid"><div class="review-field"><label for="tlrfPw">Password *</label>'
      + '<input id="tlrfPw" type="password" autocomplete="new-password" placeholder="At least 8 characters, a letter and a number">' + err('pw') + '</div>'
      + '<div class="review-field"><label for="tlrfPw2">Confirm Password *</label>'
      + '<input id="tlrfPw2" type="password" autocomplete="new-password">' + err('pw2') + '</div></div>'
      + '<label class="consent-row"><input type="checkbox" id="tlrfTerms"' + (S.terms ? ' checked' : '') + '><span>I agree to the TeamLink Terms &amp; Conditions and Privacy Policy *</span></label>'
      + '<label class="consent-row" style="margin-bottom:0"><input type="checkbox" id="tlrfComm"' + (S.comm ? ' checked' : '') + '><span>I would like to receive job recommendations and recruitment updates from TeamLink (optional)</span></label>'
      + err('consent')
      + (S.msg ? '<div class="tlrf-err" role="alert" style="margin-top:10px">' + h(S.msg) + '</div>' : '')
      + '</div></div>'
      + '<button type="button" class="btn btn-primary btn-block" data-tlrf="create" style="padding:13px"' + (S.creating || S.reading ? ' disabled' : '') + '>'
      + (S.creating ? 'Creating your account…' : 'Create account') + '</button>'
      + '<div class="switch-role">Already have an account? <a href="#/login/candidate">Log in</a></div>';
  }

  function donePanel() {
    var r = S.done || {};
    return '<div class="panel ai-panel"><div class="panel-body" style="padding:22px" role="status" aria-live="polite">'
      + '<div style="font-size:30px">🎉</div><h2 style="margin:6px 0">Registration Successful</h2>'
      + '<p style="margin:0">Welcome to TeamLink!' + (r.candidateCode ? ' Your Candidate ID: <b>' + h(r.candidateCode) + '</b>' : '') + '</p>'
      + (r.profileWarning ? '<div class="tlrf-warn" style="margin-top:10px">' + h(r.profileWarning) + '</div>' : '')
      + '<p class="tlrf-note">Taking you to your dashboard…</p>'
      + '<div class="tlrf-row" style="margin-top:12px"><button type="button" class="btn btn-primary" data-tlrf="go" data-to="' + LANDING + '">Go to my dashboard</button></div>'
      + '</div></div>';
  }

  function paint() {
    var host = $('tlrfHost');
    if (!host) return;
    var form = $('registerForm');
    if (S.manual) {
      host.innerHTML = '<p class="tlrf-note" style="margin:0 0 12px"><button type="button" class="tlrf-link" data-tlrf="auto">Back to the simple registration</button></p>';
      if (form) form.hidden = false;
      return;
    }
    if (form) form.hidden = true;
    host.innerHTML = S.phase === 'done' ? donePanel() : resumePanel() + profilePanel() + accountPanel();
    restoreSecrets();
  }

  function restoreSecrets() {
    if (S.pw && $('tlrfPw')) $('tlrfPw').value = S.pw;
    if (S.pw2 && $('tlrfPw2')) $('tlrfPw2').value = S.pw2;
  }

  function mount() {
    if (!onRegisterPage()) return;
    var form = $('registerForm');
    if (!form) return;
    css();
    var host = $('tlrfHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'tlrfHost';
      form.parentNode.insertBefore(host, form);
      if (!S.draft && !S.manual && S.phase !== 'done') restore();
    }
    paint();
  }

  /* ------------------------------------------------------------------ *
   * what is typed
   * ------------------------------------------------------------------ */
  function isVerified() {
    var d = S.draft;
    return !!(d && d.emailVerified && String(d.email || '').toLowerCase() === String(S.v.email || '').toLowerCase());
  }

  /* Keep what is on screen. Called before every repaint, so nothing typed is lost. */
  function keep() {
    Array.prototype.forEach.call(document.querySelectorAll('#tlrfHost [data-f]'), function (el) {
      var k = el.getAttribute('data-f');
      if (el.disabled) return;
      var nv = String(el.value || '').trim();
      if (k === 'email') nv = nv.replace(/\s+/g, '');
      if (nv !== S.v[k]) { S.v[k] = nv; S.edited[k] = true; }
    });
    var fr = $('tlrfFresher'); if (fr) S.v.fresher = fr.checked;
    var pw = $('tlrfPw'), pw2 = $('tlrfPw2');
    if (pw) S.pw = pw.value;
    if (pw2) S.pw2 = pw2.value;
    var t = $('tlrfTerms'); if (t) S.terms = t.checked;
    var c = $('tlrfComm'); if (c) S.comm = c.checked;
  }
  function repaint() { keep(); paint(); }

  function addSkills(text) {
    var add = String(text || '').split(/[,\n;]/).map(function (x) { return x.trim().slice(0, 80); }).filter(Boolean);
    if (!add.length) return;
    S.v.skills = dedupe(S.v.skills.concat(add)).slice(0, 60);
    S.edited.skills = true;
  }

  /* From the draft into the fields: only what the candidate has not typed themselves. */
  function applyDraft(d) {
    var f = d.fields || {}, c = d.corrections || {};
    function pick(k) { return Object.prototype.hasOwnProperty.call(c, k) ? c[k] : f[k]; }
    S.review = {};
    var needs = (d.needsVerification || []).slice();
    if (d.ask && d.ask.name) needs.push('name');
    if (d.ask && d.ask.phone) needs.push('phone');
    needs.forEach(function (k) { S.review[k] = true; });
    FILLED.forEach(function (k) {
      if (S.edited[k]) return;
      var x = pick(k);
      if (k === 'name' && !x && d.nameSuggestion) { x = d.nameSuggestion; S.review.name = true; }
      if (k === 'skills') { S.v.skills = Array.isArray(x) ? dedupe(x) : []; return; }
      if (k === 'email') { S.v.email = d.email || x || S.v.email || ''; return; }
      if (x === undefined || x === null) x = '';
      S.v[k] = String(x);
    });
    if (!S.edited.fresher && S.v.title === '' && S.v.currentCompany === '' && d.resume && d.status === 'extracted' && d.fields
        && d.fields.expYears === 0) {
      S.v.fresher = true;
    }
  }

  /* ------------------------------------------------------------------ *
   * talking to the server
   * ------------------------------------------------------------------ */
  function restore() {
    var r = remembered();
    if (!r || !r.id || !r.token || !api()) return;
    S.token = r.token;
    api().get('/registration/drafts/' + encodeURIComponent(r.id), hdr()).then(function (d) {
      S.draft = d; applyDraft(d); paint();
    }, function () { S.token = null; remember(); });
  }

  /* A draft exists before the email needs its code, with or without a resume. */
  function ensureDraft() {
    if (S.draft && S.token) return Promise.resolve(S.draft);
    return api().post('/registration/drafts', { noResume: true }, { timeout: 30000 }).then(function (d) {
      S.token = d.draftToken; delete d.draftToken;
      S.draft = d; remember();
      return d;
    });
  }

  function upload(file) {
    S.err = {}; S.msg = ''; S.resumeErr = '';
    var ext = String(file.name || '').split('.').pop().toLowerCase();
    if (ACCEPT.indexOf(ext) < 0) { S.resumeErr = 'Please upload a PDF, DOC, DOCX or TXT file.'; repaint(); return; }
    if (file.size > MAX) { S.resumeErr = 'That file is too large. The limit is 5 MB.'; repaint(); return; }
    if (S.reading) return;
    keep();
    S.file = file; S.reading = true; repaint();
    var fd = new FormData();
    fd.append('resume', file, file.name);
    var had = S.draft && S.token;
    var call = had
      ? api().post('/registration/drafts/' + encodeURIComponent(S.draft.draftId) + '/resume', fd, hdr())
      : api().post('/registration/drafts', fd, { timeout: 120000 });
    call.then(function (d) {
      if (!had) { S.token = d.draftToken; delete d.draftToken; }
      S.reading = false; S.draft = d; remember();
      applyDraft(d); paint();
    }, function (er) {
      S.reading = false; S.resumeErr = apiMessage(er); paint();
    });
  }

  function retry() {
    if (!S.draft || S.busy) return;
    keep(); S.busy = true; S.reading = true; paint();
    api().post('/registration/drafts/' + encodeURIComponent(S.draft.draftId) + '/retry', {}, hdr()).then(function (d) {
      S.busy = false; S.reading = false; S.draft = d; applyDraft(d); paint();
    }, function (er) {
      S.busy = false; S.reading = false; say(apiMessage(er), '⚠️'); paint();
    });
  }

  function sendCode() {
    keep();
    S.err.email = ''; S.err.code = ''; S.err.dupEmail = false;
    if (!EMAIL_RX.test(S.v.email)) { S.err.email = 'Please enter a valid email address.'; paint(); return; }
    if (S.busy) return;
    S.busy = true; paint();
    ensureDraft().then(function (d) {
      return api().post('/registration/drafts/' + encodeURIComponent(d.draftId) + '/email-code', { email: S.v.email }, hdr());
    }).then(function (r) {
      S.busy = false; S.codeSent = true; S.devCode = r.devCode || null;
      if (r.sent) say('We sent a 6-digit code to ' + S.v.email, '✉️');
      paint();
      var c = $('tlrfCode'); if (c) c.focus();
    }, function (er) {
      S.busy = false;
      if (er && (er.code === 'EMAIL_TAKEN' || /already exists/i.test(apiMessage(er)))) S.err.dupEmail = true;
      S.err.email = (details(er).email) || apiMessage(er);
      paint();
    });
  }

  function verify() {
    keep();
    var code = val('tlrfCode').replace(/\D/g, '');
    if (code.length !== 6) { S.err.code = 'Enter the 6-digit code from the email.'; paint(); return; }
    if (S.busy) return;
    S.busy = true; paint();
    api().post('/registration/drafts/' + encodeURIComponent(S.draft.draftId) + '/verify-email',
      { email: S.v.email, code: code }, hdr()).then(function (d) {
      S.busy = false; S.err.code = ''; S.draft = d; S.devCode = null; paint();
      say('Email verified', '✓');
    }, function (er) {
      S.busy = false; S.err.code = (details(er).code) || apiMessage(er); paint();
    });
  }

  function problems() {
    var v = S.v, e = {};
    if (!v.name || v.name.length < 2) e.name = 'Please enter your name.';
    if (!PHONE_RX.test(String(v.phone || '').replace(/[\s-]/g, ''))) e.phone = 'Please enter a valid 10-digit mobile number.';
    if (!EMAIL_RX.test(v.email)) e.email = 'Please enter a valid email address.';
    else if (!isVerified()) e.email = 'Please verify your email address first.';
    var pw = S.pw || '';
    if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) e.pw = 'Password must be at least 8 characters, with a letter and a number.';
    if ((S.pw2 || '') !== pw) e.pw2 = 'Passwords do not match.';
    if (!S.terms) e.consent = 'Please accept the Terms & Conditions and Privacy Policy.';
    return e;
  }

  function create() {
    if (S.creating || S.reading) return;          /* one submission at a time */
    keep();
    S.err = problems(); S.msg = '';
    if (Object.keys(S.err).length) {
      S.msg = 'Please check the highlighted fields and try again.';
      paint();
      var first = document.querySelector('#tlrfHost .tlrf-err');
      if (first && first.scrollIntoView) first.scrollIntoView({ block: 'center' });
      return;
    }
    S.creating = true; paint();
    var v = S.v;
    var corr = {
      name: v.name, phone: v.phone,
      highestEducation: v.highestEducation || null,
      title: v.fresher ? null : (v.title || null),
      currentCompany: v.fresher ? null : (v.currentCompany || null),
      skills: dedupe(v.skills),
    };
    var d = S.draft;
    api().patch('/registration/drafts/' + encodeURIComponent(d.draftId), { corrections: corr }, hdr()).then(function (fresh) {
      S.draft = fresh;
      return api().post('/auth/register', {
        name: v.name, email: v.email, phone: v.phone,
        password: S.pw, confirmPassword: S.pw2,
        fresher: !!v.fresher,
        consent: { terms: !!S.terms, communication: !!S.comm, resumeProcessing: !!(d.resume) },
        draftId: d.draftId, draftToken: S.token,
      }, { timeout: 120000 });
    }).then(function (res) {
      S.phase = 'done'; S.done = res; S.pw = S.pw2 = '';
      S.draft = null; S.token = null; remember();
      paint();
      var after = (window.TL && typeof TL.refresh === 'function') ? TL.refresh() : Promise.resolve();
      return Promise.resolve(after).catch(function () {}).then(function () {
        try { sessionStorage.removeItem('tl_apply_contact_v1'); } catch (e) { /* nothing */ }
        /* The existing candidate landing page. If they came from Apply Now, the pending application is
           submitted on the way (teamlink-apply-auth.js). */
        S.creating = false;
        var go = function () {
          S.phase = 'form'; S.done = null; resetForm();
          if (typeof window.navigate === 'function') window.navigate(LANDING);
          else location.hash = '#' + LANDING;
        };
        setTimeout(go, 600);
      });
    }).catch(function (er) {
      S.creating = false;
      var dt = details(er);
      if (er && (er.code === 'EMAIL_TAKEN' || dt.email)) {
        S.err.email = dt.email || apiMessage(er);
        if (/already exists/i.test(S.err.email)) S.err.dupEmail = true;
      }
      if (dt.phone) S.err.phone = dt.phone;
      if (dt.confirmPassword) S.err.pw2 = dt.confirmPassword;
      if (dt.password) S.err.pw = dt.password;
      if (dt['consent.terms']) S.err.consent = dt['consent.terms'];
      if (dt.name) S.err.name = dt.name;
      S.msg = apiMessage(er);
      paint();
    });
  }

  function resetForm() {
    S.v = { name: '', phone: '', email: '', highestEducation: '', title: '', currentCompany: '', fresher: false, skills: [] };
    S.edited = {}; S.review = {}; S.err = {}; S.msg = ''; S.codeSent = false; S.devCode = null;
    S.pw = S.pw2 = ''; S.terms = false; S.comm = false; S.resumeErr = ''; S.file = null;
  }

  /* ------------------------------------------------------------------ *
   * the controls
   * ------------------------------------------------------------------ */
  document.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest && ev.target.closest('#tlrfHost [data-tlrf]');
    if (!b) return;
    var act = b.getAttribute('data-tlrf');
    if (act === 'pick') { var f = $('tlrfFile'); if (f) f.click(); return; }
    if (act === 'auto') { setManual(false); paint(); return; }
    if (act === 'retry') { retry(); return; }
    if (act === 'sendcode') { sendCode(); return; }
    if (act === 'verify') { verify(); return; }
    if (act === 'changeemail') {
      keep();
      if (S.draft) S.draft = Object.assign({}, S.draft, { emailVerified: false });
      S.codeSent = false; S.devCode = null; paint();
      var em = $('tlrfEmail'); if (em) em.focus();
      return;
    }
    if (act === 'rmskill') { keep(); S.v.skills.splice(Number(b.getAttribute('data-i')), 1); S.edited.skills = true; paint(); return; }
    if (act === 'create') { create(); return; }
    if (act === 'go') {
      S.phase = 'form'; S.done = null; resetForm();
      if (typeof window.navigate === 'function') window.navigate(b.getAttribute('data-to'));
    }
  });

  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (!t || !t.closest || !t.closest('#tlrfHost')) return;
    if (t.id === 'tlrfFile' && t.files && t.files[0]) { upload(t.files[0]); return; }
    if (t.id === 'tlrfFresher') {
      keep();
      S.edited.fresher = true;
      if (S.v.fresher) { S.v.title = ''; S.v.currentCompany = ''; }
      paint(); return;
    }
    if (t.id === 'tlrfEdu') { keep(); S.edited.highestEducation = true; paint(); return; }
    if (t.id === 'tlrfEmail') {
      keep();
      S.err.email = ''; S.err.dupEmail = false;
      /* a different address has to answer its own code */
      if (S.draft && S.draft.emailVerified && String(S.draft.email || '').toLowerCase() !== S.v.email.toLowerCase()) {
        S.draft = Object.assign({}, S.draft, { emailVerified: false });
      }
      S.codeSent = false; S.devCode = null;
      paint();
    }
  });

  /* Typing never repaints (the caret would jump); the value is read on the next keep(). */
  document.addEventListener('input', function (ev) {
    var t = ev.target;
    if (!t || !t.closest || !t.closest('#tlrfHost')) return;
    if (t.getAttribute('data-f')) { S.edited[t.getAttribute('data-f')] = true; S.v[t.getAttribute('data-f')] = String(t.value || ''); }
    if (t.id === 'tlrfSkillIn' && /[,;]$/.test(t.value)) { keep(); addSkills(t.value); paint(); var si = $('tlrfSkillIn'); if (si) si.focus(); }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'tlrfSkillIn') {
      ev.preventDefault(); keep(); addSkills(ev.target.value); paint();
      var si = $('tlrfSkillIn'); if (si) si.focus();
    }
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'tlrfCode') { ev.preventDefault(); verify(); }
  });

  /* A skill typed but not yet entered is still a skill: taken on the way out of the box. */
  document.addEventListener('focusout', function (ev) {
    var t = ev.target;
    if (t && t.id === 'tlrfSkillIn' && t.value.trim()) { keep(); addSkills(t.value); paint(); }
  });

  /* ------------------------------------------------------------------ *
   * installing: after every render, on the registration page only
   * ------------------------------------------------------------------ */
  function install() {
    var prev = window.render;
    if (typeof prev === 'function' && !prev.__tlrf) {
      var next = function () {
        var out = prev.apply(this, arguments);
        try { if (onRegisterPage() && !signedIn()) mount(); else if (onRegisterPage() && S.phase === 'done') mount(); } catch (e) {
          if (window.TL && TL.debug) console.error('[resume-first]', e);
        }
        return out;
      };
      next.__tlrf = true;
      window.render = next;
    }
    try { if (onRegisterPage()) mount(); } catch (e) { /* the form below still works */ }
  }

  if (document.readyState === 'complete') setTimeout(install, 0);
  else window.addEventListener('load', function () { setTimeout(install, 0); });

  /* For verify scripts: the older seven-step form, or back. */
  window.TLResumeFirst = {
    manual: function () { setManual(true); paint(); },
    auto: function () { setManual(false); paint(); },
    state: function () { return { phase: S.phase, manual: S.manual, draft: S.draft, values: S.v }; },
  };
})();
