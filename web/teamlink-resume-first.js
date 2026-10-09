/* =====================================================================
   TEAMLINK — resume-first registration (0117)

     UPLOAD RESUME  ->  read on the server, kept as a draft
       ->  (only if needed) confirm what the reading was unsure of
       ->  the candidate types ONLY: current location, preferred
           location, work mode, expected salary, password
       ->  verify the email (6-digit code)
       ->  Create Account  ->  "Your profile has been created from your
           resume" + only the fields that are still missing

   THE RESUME IS THE SOURCE. Nothing the resume already said is asked
   again. Name, email or mobile are asked only when the resume did not
   give them, or gave them in a way the reading was not sure of.

   THE SERVER HOLDS EVERYTHING. The file, its text, what was read from
   it and how sure each field is live in a registration draft
   (/api/registration/drafts). This page keeps only the draft's id and
   token in sessionStorage, so a refresh picks up where it was; a closed
   tab loses nothing that matters, because nothing that matters is here.

   THE SEVEN-STEP FORM IS STILL HERE (teamlink-registration.js), hidden,
   untouched: "Enter my details manually" shows it, for a candidate with
   no resume or one that cannot be read. Its own submit, its own rules.

   Same page, same classes, same look: panels, review fields, option
   rows, consent rows - nothing restyled.
   ===================================================================== */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__tlResumeFirst) return;
  window.__tlResumeFirst = true;

  var KEY = 'tl_reg_resume_draft_v1';
  /* "Enter my details manually", remembered for this tab: a refresh keeps
     the seven-step form the candidate chose. */
  var MANUAL_KEY = 'tl_reg_manual_v1';
  var ACCEPT = ['pdf', 'doc', 'docx', 'txt'];
  var MAX = 5 * 1024 * 1024;
  var EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var NOTICE = ['Immediate', '7 days', '15 days', '30 days', '45 days', '60 days', '90 days', 'Other'];
  /* The stored values the matcher already reads (Office / Hybrid / Remote);
     "Any" is all three. */
  var MODES = [['Office', 'Work From Office'], ['Hybrid', 'Hybrid'], ['Remote', 'Work From Home'], ['Any', 'Any']];
  var CITIES = ['Hyderabad', 'Bengaluru', 'Chennai', 'Mumbai', 'Delhi', 'Pune', 'Kolkata', 'Noida', 'Gurugram',
    'Ahmedabad', 'Visakhapatnam', 'Vijayawada', 'Coimbatore', 'Kochi', 'Remote'];
  var LABEL = {
    name: 'Full name', email: 'Email', phone: 'Mobile number', altPhone: 'Alternate mobile',
    title: 'Current designation', currentCompany: 'Current company', expYears: 'Total experience (years)',
    relevantExpYears: 'Relevant experience (years)', qualification: 'Highest qualification',
    dob: 'Date of birth', currentSalary: 'Current salary',
  };

  var S = {
    manual: (function () { try { return sessionStorage.getItem(MANUAL_KEY) === '1'; } catch (e) { return false; } })(), phase: 'upload', draft: null, token: null, file: null, busy: false,
    err: {}, msg: '', codeSent: false, devCode: null, done: null,
    input: { prefLocs: [], modes: [] },
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
  function fieldVal(k) {
    var d = S.draft || {};
    var c = d.corrections || {};
    if (Object.prototype.hasOwnProperty.call(c, k)) return c[k];
    return (d.fields || {})[k];
  }
  function val(id) { var el = $(id); return el ? String(el.value || '').trim() : ''; }
  function apiMessage(er) { return (er && er.message) || 'Something went wrong. Please try again.'; }
  function details(er) { return (er && (er.details || er.fields)) || {}; }

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
      + '#tlrfHost .tlrf-bar{height:8px;background:var(--bg-alt,#eef2f6);border-radius:99px;overflow:hidden;margin:6px 0 2px}'
      + '#tlrfHost .tlrf-bar i{display:block;height:100%;background:var(--brand-500,#1490b3)}'
      + '#tlrfHost .tlrf-dev{background:#fff7e6;border:1px solid #f3d38a;border-radius:8px;padding:8px 10px;font-size:12.5px;margin-top:6px}'
      + '#tlrfHost .tlrf-warn{background:#fff4f2;border:1px solid #f1c3bb;border-radius:8px;padding:10px 12px;font-size:13px;margin:0 0 12px}'
      + '#tlrfHost .tlrf-link{background:none;border:0;padding:0;color:var(--brand-600,#0f7c9c);text-decoration:underline;cursor:pointer;font:inherit}'
      + '#tlrfHost [hidden]{display:none!important}'
      + '#tlrfModes{display:grid;grid-template-columns:1fr 1fr;gap:8px}'
      + '#tlrfModes .opt-row{margin:0;justify-content:flex-start;text-align:left}'
      + '@media (max-width:720px){#tlrfHost .review-grid{grid-template-columns:1fr}}';
    document.head.appendChild(s);
  }

  function uploadPanel() {
    var reading = S.phase === 'reading';
    return '<div class="panel ai-panel"><div class="panel-head"><h2><span class="reg-section-num">1</span>Upload your resume</h2></div>'
      + '<div class="panel-body"><div class="resume-upload-box">'
      + '<div style="font-size:28px">📄</div>'
      + '<b>' + (reading ? 'Reading your resume…' : 'Start with your resume') + '</b>'
      + '<p>' + (reading ? 'This takes a few seconds. Your resume is already saved.'
        : 'We read it and build your profile from it, so you do not type what it already says. PDF, DOC, DOCX or TXT, up to 5 MB.') + '</p>'
      + (reading ? '' : '<button type="button" class="btn btn-primary" data-tlrf="pick" style="margin-top:10px">Choose resume</button>')
      + '<input type="file" id="tlrfFile" accept=".pdf,.doc,.docx,.txt" hidden aria-label="Resume file">'
      + (S.err.file ? '<div class="tlrf-err" role="alert">' + h(S.err.file) + '</div>' : '')
      + '</div>'
      + '<p class="tlrf-note">No resume? <button type="button" class="tlrf-link" data-tlrf="manual">Enter my details manually</button></p>'
      + '</div></div>';
  }

  function failedPanel() {
    var e = (S.draft && S.draft.error) || {};
    return '<div class="panel"><div class="panel-head"><h2><span class="reg-section-num">1</span>Your resume</h2></div><div class="panel-body">'
      + '<div class="tlrf-warn" role="alert"><b>' + h(e.message || "We couldn't extract your resume automatically. Please review or enter the missing information manually.") + '</b>'
      + (S.draft && S.draft.resume ? '<div class="tlrf-note">Your resume <b>' + h(S.draft.resume.fileName) + '</b> is saved - nothing is lost.</div>' : '')
      + '</div>'
      + '<div class="tlrf-row">'
      + '<button type="button" class="btn btn-primary" data-tlrf="retry"' + (S.busy ? ' disabled' : '') + '>Try reading it again</button>'
      + '<button type="button" class="btn btn-ghost" data-tlrf="pick">Upload a different file</button>'
      + '<button type="button" class="btn btn-ghost" data-tlrf="manual">Enter my details manually</button>'
      + '</div><input type="file" id="tlrfFile" accept=".pdf,.doc,.docx,.txt" hidden aria-label="Resume file"></div></div>';
  }

  function foundSummary(d) {
    var f = d.fields || {};
    var bits = [];
    if (f.name) bits.push(f.name);
    if (f.email) bits.push('Email');
    if (f.phone) bits.push('Mobile');
    if (f.title) bits.push(f.title);
    if (f.currentCompany) bits.push(f.currentCompany);
    if (f.expYears !== undefined) bits.push(f.expYears + ' yrs experience');
    if (f.skills && f.skills.length) bits.push(f.skills.length + ' skills');
    var edu = (f.educationRecords && f.educationRecords.length) || (f.education ? 1 : 0);
    if (edu) bits.push(edu + ' education record' + (edu === 1 ? '' : 's'));
    if (f.employmentHistory && f.employmentHistory.length) bits.push(f.employmentHistory.length + ' companies');
    if (f.projects && f.projects.length) bits.push(f.projects.length + ' projects');
    if (f.certifications && f.certifications.length) bits.push(f.certifications.length + ' certifications');
    return bits.map(function (b) { return '<span>✓ ' + h(b) + '</span>'; }).join('');
  }

  /* Only what the reading was unsure of, or did not find for name / mobile. */
  function confirmKeys(d) {
    var keys = (d.needsVerification || []).slice();
    if (d.ask && d.ask.name && keys.indexOf('name') < 0) keys.unshift('name');
    if (d.ask && d.ask.phone && keys.indexOf('phone') < 0) keys.push('phone');
    return keys.filter(function (k) { return k !== 'email'; });
  }

  function readPanel(d) {
    var keys = confirmKeys(d);
    var out = '<div class="panel ai-panel"><div class="panel-head"><h2><span class="reg-section-num">1</span>Your resume</h2>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-tlrf="pick">Replace</button></div><div class="panel-body">'
      + '<div class="tlrf-ok">✓ ' + h((d.resume && d.resume.fileName) || 'Resume') + ' - we read your resume and filled your profile from it.</div>'
      + '<div class="tlrf-found">' + foundSummary(d) + '</div>'
      + '<input type="file" id="tlrfFile" accept=".pdf,.doc,.docx,.txt" hidden aria-label="Resume file">'
      + '</div></div>';
    if (keys.length) {
      out += '<div class="panel"><div class="panel-head"><h2><span class="reg-section-num">2</span>Please check</h2></div><div class="panel-body">'
        + '<p class="tlrf-note" style="margin:0 0 10px">We found the following information from your resume, but we are not sure it is right. Correct anything that is wrong.</p>'
        + '<div class="review-grid">' + keys.map(function (k) {
          var v = fieldVal(k);
          if (k === 'name' && (v === undefined || v === null || v === '') && d.nameSuggestion) v = d.nameSuggestion;
          var id = 'tlrfC_' + k;
          var req = (k === 'name' || k === 'phone') ? ' *' : '';
          return '<div class="review-field"><label for="' + id + '">' + h(LABEL[k] || k) + req + '</label>'
            + '<input id="' + id + '" data-tlrf-c="' + h(k) + '" value="' + h(v === undefined || v === null ? '' : v) + '"'
            + (k === 'phone' ? ' inputmode="numeric" maxlength="15"' : '') + '>'
            + (S.err['c_' + k] ? '<div class="tlrf-err">' + h(S.err['c_' + k]) + '</div>' : '') + '</div>';
        }).join('') + '</div></div></div>';
    }
    return out;
  }

  function locOptions() {
    var pool = [];
    try { if (typeof window.locationPool === 'function') pool = window.locationPool(); } catch (e) { pool = []; }
    var all = CITIES.concat(pool).filter(function (x, i, a) { return x && a.indexOf(x) === i; });
    return '<datalist id="tlrfLocList">' + all.map(function (l) { return '<option value="' + h(l) + '">'; }).join('') + '</datalist>';
  }

  function detailsPanel(d) {
    var n = confirmKeys(d).length ? 3 : 2;
    var I = S.input;
    var email = I.email !== undefined ? I.email : (d.email || '');
    var verified = !!d.emailVerified && String(d.email || '').toLowerCase() === String(email || '').toLowerCase();
    var e = S.err;
    var exists = d.existing || {};
    var warn = (exists.email || exists.phone)
      ? '<div class="tlrf-warn" role="alert">An account with this ' + (exists.email ? 'email' : 'mobile number')
        + ' already exists. <a href="#/login/candidate">Please Login</a> instead of registering again.</div>' : '';
    return '<div class="panel"><div class="panel-head"><h2><span class="reg-section-num">' + n + '</span>A few details your resume cannot tell us</h2></div><div class="panel-body">'
      + warn + locOptions()
      + '<div class="review-grid"><div>'
      + '<div class="review-field"><label for="tlrfLoc">Current Location *</label>'
      + '<input id="tlrfLoc" list="tlrfLocList" autocomplete="off" placeholder="e.g. Hyderabad" value="' + h(I.loc !== undefined ? I.loc : (fieldVal('location') || '')) + '">'
      + (e.loc ? '<div class="tlrf-err">' + h(e.loc) + '</div>' : '') + '</div>'
      + '<div class="review-field"><label for="tlrfPrefIn">Preferred Location *</label>'
      + '<div class="tlrf-row"><input id="tlrfPrefIn" list="tlrfLocList" autocomplete="off" placeholder="Type a city and press Enter">'
      + '<button type="button" class="btn btn-ghost btn-sm" data-tlrf="addpref">Add</button></div>'
      + '<div class="tlrf-chips">' + I.prefLocs.map(function (l, i) {
        return '<span class="filter-chip">' + h(l) + '<button type="button" data-tlrf="rmpref" data-i="' + i + '" aria-label="Remove ' + h(l) + '">✕</button></span>';
      }).join('') + '</div>'
      + (e.pref ? '<div class="tlrf-err">' + h(e.pref) + '</div>' : '') + '</div>'
      + '<div class="review-field"><label for="tlrfSal">Expected Salary (₹ LPA) *</label>'
      + '<input id="tlrfSal" type="number" min="0" step="0.5" placeholder="e.g. 8" value="' + h(I.sal || '') + '">'
      + (e.sal ? '<div class="tlrf-err">' + h(e.sal) + '</div>' : '') + '</div>'
      + '</div><div>'
      + '<div class="review-field"><label>Work Mode *</label><div class="opt-row-group" id="tlrfModes">'
      + MODES.map(function (m) {
        var on = I.modes.indexOf(m[0]) >= 0;
        return '<label class="opt-row' + (on ? ' active' : '') + '"><input type="checkbox" value="' + m[0] + '"' + (on ? ' checked' : '') + ' data-tlrf-mode="1"><span>' + h(m[1]) + '</span></label>';
      }).join('') + '</div>'
      + (e.modes ? '<div class="tlrf-err">' + h(e.modes) + '</div>' : '') + '</div>'
      + '</div></div>'

      + '<div class="review-grid"><div>'
      + '<div class="review-field"><label for="tlrfEmail">Email *' + (d.fields && d.fields.email ? ' <span class="ai-extracted-tag">from your resume</span>' : '') + '</label>'
      + '<div class="tlrf-row"><input id="tlrfEmail" type="email" autocomplete="email" value="' + h(email) + '"' + (verified ? ' readonly' : '') + '>'
      + (verified ? '<span class="tlrf-ok">✓ Verified</span>'
        : '<button type="button" class="btn btn-ghost btn-sm" data-tlrf="sendcode"' + (S.busy ? ' disabled' : '') + '>' + (S.codeSent ? 'Send again' : 'Send code') + '</button>') + '</div>'
      + (verified ? '' : '<p class="tlrf-note">We send a 6-digit code to confirm the address. You sign in with it.</p>')
      + (S.codeSent && !verified ? '<div class="tlrf-row" style="margin-top:6px"><input id="tlrfCode" inputmode="numeric" maxlength="6" placeholder="6-digit code" autocomplete="one-time-code">'
        + '<button type="button" class="btn btn-primary btn-sm" data-tlrf="verify"' + (S.busy ? ' disabled' : '') + '>Verify</button></div>' : '')
      + (S.devCode && !verified ? '<div class="tlrf-dev">Development server: email is not being sent. Your code is <b>' + h(S.devCode) + '</b>.</div>' : '')
      + (e.email ? '<div class="tlrf-err" role="alert">' + h(e.email) + '</div>' : '')
      + (e.code ? '<div class="tlrf-err" role="alert">' + h(e.code) + '</div>' : '')
      + '</div></div>'
      + '<div>'
      + '<div class="review-field"><label for="tlrfPw">Password *</label><input id="tlrfPw" type="password" autocomplete="new-password" placeholder="At least 8 characters, a letter and a number">'
      + (e.pw ? '<div class="tlrf-err">' + h(e.pw) + '</div>' : '') + '</div>'
      + '<div class="review-field"><label for="tlrfPw2">Confirm Password *</label><input id="tlrfPw2" type="password" autocomplete="new-password">'
      + (e.pw2 ? '<div class="tlrf-err">' + h(e.pw2) + '</div>' : '') + '</div>'
      + '</div></div>'

      + '<label class="consent-row"><input type="checkbox" id="tlrfTerms"' + (I.terms ? ' checked' : '') + '><span>I agree to the TeamLink Terms &amp; Conditions and Privacy Policy *</span></label>'
      + '<label class="consent-row"><input type="checkbox" id="tlrfComm"' + (I.comm ? ' checked' : '') + '><span>I agree to receive recruitment communication from TeamLink *</span></label>'
      + '<label class="consent-row" style="margin-bottom:0"><input type="checkbox" id="tlrfResume"' + (I.resume !== false ? ' checked' : '') + '><span>I consent to my resume being processed for recruitment</span></label>'
      + (e.consent ? '<div class="tlrf-err">' + h(e.consent) + '</div>' : '')
      + (S.msg ? '<div class="tlrf-err" role="alert" style="margin-top:10px">' + h(S.msg) + '</div>' : '')
      + '</div></div>'
      + '<button type="button" class="btn btn-primary btn-block" data-tlrf="create" style="padding:13px"' + (S.busy || exists.email || exists.phone ? ' disabled' : '') + '>'
      + (S.busy ? 'Creating your account…' : 'Create account') + '</button>'
      + '<div class="switch-role">Already have an account? <a href="#/login/candidate">Log in</a></div>';
  }

  function donePanel() {
    var r = S.done || {};
    var c = r.completeness;
    var applying = false;
    try { applying = !!sessionStorage.getItem('tl_apply_intent_v1') || !!sessionStorage.getItem('teamlink_pending_job'); } catch (e) { applying = false; }
    var body = '<div class="panel ai-panel"><div class="panel-body" style="padding:22px" role="status" aria-live="polite">'
      + '<div style="font-size:30px">🎉</div><h2 style="margin:6px 0">Registration Successful</h2>'
      + '<p style="margin:0">Welcome to TeamLink!' + (r.candidateCode ? ' Your Candidate ID: <b>' + h(r.candidateCode) + '</b>' : '') + '</p>'
      + (r.profileWarning ? '<div class="tlrf-warn" style="margin-top:10px">' + h(r.profileWarning) + '</div>' : '')
      + '<hr style="border:0;border-top:1px solid var(--line);margin:16px 0">'
      + '<b>Your profile has been created from your resume.</b>';
    if (c) {
      body += '<div style="margin-top:8px">Profile Completeness: <b>' + c.percent + '%</b></div>'
        + '<div class="tlrf-bar" aria-hidden="true"><i style="width:' + Math.max(0, Math.min(100, c.percent)) + '%"></i></div>';
      if (c.missing && c.missing.length) {
        body += '<p class="tlrf-note">We extracted your information automatically. Please complete the remaining details to improve your profile and job matching.</p>'
          + '<div class="tlrf-chips">' + c.missing.map(function (m) {
            var sub = (m.fields || []).map(function (f) { return f.label; }).join(', ');
            return '<span class="filter-chip" style="padding-right:10px">' + h(m.label) + (sub ? ': ' + h(sub) : '') + '</span>';
          }).join('') + '</div>';
      } else {
        body += '<p class="tlrf-ok" style="margin-top:8px">Your profile is complete.</p>';
      }
    }
    body += '<div class="tlrf-row" style="margin-top:16px">'
      + (applying ? '<button type="button" class="btn btn-primary" data-tlrf="go" data-to="/candidate/home">Continue my application</button>' : '')
      + (c && c.missing && c.missing.length ? '<button type="button" class="btn ' + (applying ? 'btn-ghost' : 'btn-primary') + '" data-tlrf="go" data-to="/candidate/profile">Complete Profile</button>' : '')
      + '<button type="button" class="btn btn-ghost" data-tlrf="go" data-to="/candidate/search">Search Jobs</button>'
      + '</div></div></div>';
    return body;
  }

  function paint() {
    var host = $('tlrfHost');
    if (!host) return;
    var form = $('registerForm');
    if (S.manual) {
      host.innerHTML = '<p class="tlrf-note" style="margin:0 0 12px">Have a resume? <button type="button" class="tlrf-link" data-tlrf="auto">Upload it and skip the typing</button></p>';
      if (form) form.hidden = false;
      return;
    }
    if (form) form.hidden = true;
    var d = S.draft;
    var html;
    if (S.phase === 'done') html = donePanel();
    else if (!d || S.phase === 'reading') html = uploadPanel();
    else if (d.status === 'failed') html = failedPanel();
    else html = readPanel(d) + detailsPanel(d);
    host.innerHTML = html;
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
   * talking to the server
   * ------------------------------------------------------------------ */
  function restore() {
    var r = remembered();
    if (!r || !r.id || !r.token || !api()) return;
    S.token = r.token;
    api().get('/registration/drafts/' + encodeURIComponent(r.id), hdr()).then(function (d) {
      S.draft = d; S.phase = 'read'; seedInputs(d); paint();
    }, function () { S.token = null; remember(); });
  }

  function seedInputs(d) {
    var I = S.input;
    if (I.loc === undefined && d.fields && d.fields.location) I.loc = d.fields.location;
    if (I.email === undefined) {
      var typed = '';
      try { typed = sessionStorage.getItem('tl_apply_contact_v1') || ''; } catch (e) { typed = ''; }
      I.email = d.email || typed || '';
    }
  }

  function upload(file) {
    S.err = {}; S.msg = '';
    var ext = String(file.name || '').split('.').pop().toLowerCase();
    if (ACCEPT.indexOf(ext) < 0) { S.err.file = 'Please upload a PDF, DOC, DOCX or TXT file.'; paint(); return; }
    if (file.size > MAX) { S.err.file = 'That file is too large. The limit is 5 MB.'; paint(); return; }
    S.file = file;
    S.phase = 'reading'; S.draft = null; S.token = null; S.codeSent = false; S.devCode = null;
    S.input = { prefLocs: [], modes: [] };
    paint();
    var fd = new FormData();
    fd.append('resume', file, file.name);
    api().post('/registration/drafts', fd, { timeout: 120000 }).then(function (d) {
      S.token = d.draftToken; delete d.draftToken;
      S.draft = d; S.phase = 'read';
      seedInputs(d);
      remember();
      paint();
    }, function (er) {
      S.phase = 'upload'; S.err.file = apiMessage(er); paint();
    });
  }

  function retry() {
    S.busy = true; S.phase = 'reading'; paint();
    api().post('/registration/drafts/' + encodeURIComponent(S.draft.draftId) + '/retry', {}, hdr()).then(function (d) {
      S.busy = false; S.draft = d; S.phase = 'read'; seedInputs(d); paint();
    }, function (er) {
      S.busy = false; S.phase = 'read'; say(apiMessage(er), '⚠️'); paint();
    });
  }

  function keepInputs() {
    var I = S.input;
    if ($('tlrfLoc')) I.loc = val('tlrfLoc');
    if ($('tlrfSal')) I.sal = val('tlrfSal');
    if ($('tlrfNotice')) I.notice = val('tlrfNotice');
    if ($('tlrfNoticeOther')) I.noticeOther = val('tlrfNoticeOther');
    if ($('tlrfEmail')) I.email = val('tlrfEmail');
    if ($('tlrfTerms')) I.terms = $('tlrfTerms').checked;
    if ($('tlrfComm')) I.comm = $('tlrfComm').checked;
    if ($('tlrfResume')) I.resume = $('tlrfResume').checked;
    var pw = $('tlrfPw'), pw2 = $('tlrfPw2');
    S.pw = pw ? pw.value : S.pw; S.pw2 = pw2 ? pw2.value : S.pw2;
    Array.prototype.forEach.call(document.querySelectorAll('#tlrfHost [data-tlrf-c]'), function (x) {
      S.corr = S.corr || {};
      S.corr[x.getAttribute('data-tlrf-c')] = String(x.value || '').trim();
    });
  }
  function repaint() {
    keepInputs(); paint();
    if (S.pw && $('tlrfPw')) $('tlrfPw').value = S.pw;
    if (S.pw2 && $('tlrfPw2')) $('tlrfPw2').value = S.pw2;
    Object.keys(S.corr || {}).forEach(function (k) { var el = $('tlrfC_' + k); if (el) el.value = S.corr[k]; });
  }

  function sendCode() {
    keepInputs();
    S.err.email = ''; S.err.code = '';
    var email = S.input.email;
    if (!EMAIL_RX.test(email)) { S.err.email = 'Please enter a valid email address.'; repaint(); return; }
    S.busy = true; repaint();
    api().post('/registration/drafts/' + encodeURIComponent(S.draft.draftId) + '/email-code', { email: email }, hdr()).then(function (r) {
      S.busy = false; S.codeSent = true; S.devCode = r.devCode || null;
      if (r.sent) say('We sent a 6-digit code to ' + email, '✉️');
      repaint();
      var c = $('tlrfCode'); if (c) c.focus();
    }, function (er) {
      S.busy = false; S.err.email = (details(er).email) || apiMessage(er); repaint();
    });
  }

  function verify() {
    keepInputs();
    var code = val('tlrfCode').replace(/\D/g, '');
    if (code.length !== 6) { S.err.code = 'Enter the 6-digit code from the email.'; repaint(); return; }
    S.busy = true; repaint();
    api().post('/registration/drafts/' + encodeURIComponent(S.draft.draftId) + '/verify-email',
      { email: S.input.email, code: code }, hdr()).then(function (d) {
      S.busy = false; S.err.code = ''; S.draft = d; S.devCode = null; repaint();
      say('Email verified', '✓');
    }, function (er) {
      S.busy = false; S.err.code = (details(er).code) || apiMessage(er); repaint();
    });
  }

  function problems() {
    var I = S.input, e = {};
    if (!I.loc) e.loc = 'Current Location is required';
    if (!I.prefLocs.length) e.pref = 'Preferred Job Location is required';
    var sal = Number(String(I.sal || '').replace(/[^\d.]/g, ''));
    if (!(sal > 0)) e.sal = 'Expected Salary is required';
    else if (sal > 1000) e.sal = 'Please enter the salary in lakh per annum';
    if (!I.modes.length) e.modes = 'Select at least one work mode';
    var pw = S.pw || '';
    if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) e.pw = 'Password must be at least 8 characters, with a letter and a number.';
    if ((S.pw2 || '') !== pw) e.pw2 = 'Passwords do not match.';
    if (!I.terms || !I.comm) e.consent = 'Please accept the Terms & Conditions and agree to recruitment communication.';
    var d = S.draft || {};
    var verified = !!d.emailVerified && String(d.email || '').toLowerCase() === String(I.email || '').toLowerCase();
    if (!verified) e.email = 'Please verify your email address first.';
    confirmKeys(d).forEach(function (k) {
      var v = (S.corr || {})[k];
      if (k === 'name' && (!v || v.length < 2)) e['c_name'] = 'Please enter your name.';
      if (k === 'phone' && !/^(?:\+?91[\s-]?|0)?[6-9]\d{9}$/.test(String(v || '').replace(/[\s-]/g, ''))) e['c_phone'] = 'Please enter a valid 10-digit mobile number.';
    });
    return e;
  }

  function create() {
    keepInputs();
    S.err = problems(); S.msg = '';
    if (Object.keys(S.err).length) {
      S.msg = 'Please check the highlighted fields and try again.';
      repaint();
      var first = document.querySelector('#tlrfHost .tlrf-err');
      if (first && first.scrollIntoView) first.scrollIntoView({ block: 'center' });
      return;
    }
    var d = S.draft, I = S.input;
    var corr = {};
    confirmKeys(d).forEach(function (k) { if (S.corr && S.corr[k] !== undefined) corr[k] = S.corr[k]; });
    S.busy = true; repaint();
    var patch = Object.keys(corr).length
      ? api().patch('/registration/drafts/' + encodeURIComponent(d.draftId), { corrections: corr }, hdr())
      : Promise.resolve(d);
    var modes = I.modes.indexOf('Any') >= 0 ? ['Office', 'Hybrid', 'Remote'] : I.modes.slice();
    patch.then(function (fresh) {
      S.draft = fresh;
      var name = corr.name || fieldVal('name') || fresh.nameSuggestion || '';
      var phone = corr.phone || fieldVal('phone') || '';
      return api().post('/auth/register', {
        name: name, email: I.email, phone: phone,
        password: S.pw, confirmPassword: S.pw2,
        currentLocation: I.loc,
        preferredLocation: I.prefLocs.join(', '),
        expectedCtc: Number(String(I.sal).replace(/[^\d.]/g, '')),
        preferredWorkModes: modes,
        consent: { terms: !!I.terms, communication: !!I.comm, resumeProcessing: I.resume !== false },
        draftId: d.draftId, draftToken: S.token,
      }, { timeout: 120000 });
    }).then(function (res) {
      S.busy = false; S.phase = 'done'; S.done = res; S.pw = S.pw2 = null;
      S.draft = null; S.token = null; remember();
      var after = (window.TL && typeof TL.refresh === 'function') ? TL.refresh() : Promise.resolve();
      return Promise.resolve(after).catch(function () {}).then(function () {
        /* 0118: they came from Apply Now - the application is submitted now,
           without another click (teamlink-apply-auth.js resumes it on the
           way to the dashboard; Apply Now is one-click). */
        var pendingJob = null;
        try { pendingJob = JSON.parse(sessionStorage.getItem('tl_apply_intent_v1') || 'null'); } catch (e) { pendingJob = null; }
        try { sessionStorage.removeItem('tl_apply_contact_v1'); } catch (e) { /* nothing */ }
        if (pendingJob && pendingJob.jobId && typeof window.navigate === 'function') {
          S.phase = 'upload'; S.done = null;
          window.navigate('/candidate/home');
          return;
        }
        paint();
      });
    }).catch(function (er) {
      S.busy = false;
      var dt = details(er);
      if (dt.email) S.err.email = dt.email;
      if (dt.phone) S.err.c_phone = dt.phone;
      if (dt.confirmPassword) S.err.pw2 = dt.confirmPassword;
      if (dt.password) S.err.pw = dt.password;
      if (dt.preferredLocation) S.err.pref = dt.preferredLocation;
      if (dt.expectedCtc) S.err.sal = dt.expectedCtc;
      if (dt.noticePeriod) S.err.notice = dt.noticePeriod;
      if (dt.preferredWorkModes) S.err.modes = dt.preferredWorkModes;
      if (dt['consent.terms'] || dt['consent.communication']) S.err.consent = dt['consent.terms'] || dt['consent.communication'];
      S.msg = apiMessage(er);
      repaint();
    });
  }

  /* ------------------------------------------------------------------ *
   * the controls
   * ------------------------------------------------------------------ */
  function addPref() {
    keepInputs();
    var v = val('tlrfPrefIn');
    if (!v) return;
    v.split(',').map(function (x) { return x.trim(); }).filter(Boolean).forEach(function (x) {
      if (S.input.prefLocs.indexOf(x) < 0 && S.input.prefLocs.length < 10) S.input.prefLocs.push(x);
    });
    S.err.pref = '';
    repaint();
    var el = $('tlrfPrefIn'); if (el) el.focus();
  }

  document.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest && ev.target.closest('#tlrfHost [data-tlrf]');
    if (!b) return;
    var act = b.getAttribute('data-tlrf');
    if (act === 'pick') { var f = $('tlrfFile'); if (f) f.click(); return; }
    if (act === 'manual') {
      setManual(true);
      /* The legacy form uploads the resume itself after the account exists. */
      if (S.file && window.TL) TL.pendingResume = S.file;
      paint();
      return;
    }
    if (act === 'auto') { setManual(false); paint(); return; }
    if (act === 'retry') { retry(); return; }
    if (act === 'sendcode') { sendCode(); return; }
    if (act === 'verify') { verify(); return; }
    if (act === 'addpref') { addPref(); return; }
    if (act === 'rmpref') { keepInputs(); S.input.prefLocs.splice(Number(b.getAttribute('data-i')), 1); repaint(); return; }
    if (act === 'create') { create(); return; }
    if (act === 'go') {
      S.phase = 'upload'; S.done = null;
      if (typeof window.navigate === 'function') window.navigate(b.getAttribute('data-to'));
    }
  });

  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (!t || !t.closest || !t.closest('#tlrfHost')) return;
    if (t.id === 'tlrfFile' && t.files && t.files[0]) { upload(t.files[0]); return; }
    if (t.getAttribute('data-tlrf-mode')) {
      keepInputs();
      var on = [].slice.call(document.querySelectorAll('#tlrfModes input:checked')).map(function (x) { return x.value; });
      if (t.value === 'Any' && t.checked) on = ['Any'];
      else if (t.value !== 'Any') on = on.filter(function (x) { return x !== 'Any'; });
      S.input.modes = on; S.err.modes = '';
      repaint();
      return;
    }
    if (t.id === 'tlrfNotice') { keepInputs(); repaint(); }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'tlrfPrefIn') { ev.preventDefault(); addPref(); }
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'tlrfCode') { ev.preventDefault(); verify(); }
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

  /* For verify scripts: the seven-step form, or back. */
  window.TLResumeFirst = {
    manual: function () { setManual(true); paint(); },
    auto: function () { setManual(false); paint(); },
    state: function () { return { phase: S.phase, manual: S.manual, draft: S.draft }; },
  };
})();
