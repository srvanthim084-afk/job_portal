/* =====================================================================
   TEAMLINK — candidate registration on ONE screen (0117, 0123)

   Everything is on the page from the start, in this order, whether or not a resume has been
   uploaded yet:

     1  Resume upload            mandatory, PDF or DOCX, 5 MB
     2  Personal details         full name, email
     3  Education                highest qualification, institute, year of passing
     4  Experience               total experience, current company, current role, notice period
        Account & preferences    password, locations, expected salary, work mode, consents
     5  Mobile number            Send OTP -> enter the 6-digit OTP -> Verify
     6  Create Account           hidden until the mobile number is verified

   THE RESUME FILLS THE BLANKS. When a resume is read on the server (a registration draft), every
   field that is EMPTY is filled from it - name, email, education, experience, mobile, notice period
   where the resume says one of the offered options. A value the candidate has typed is never
   replaced, and every filled value stays editable. If the reading fails or misses something, those
   fields simply stay empty for typing: nothing blocks.

   THE SERVER HOLDS THE PROOF. The file, its reading and the verified mobile number live in the
   draft (/api/registration/drafts). The Create Account button is only a convenience: the server
   refuses to create the account unless the draft has a resume and its mobile number answered an
   OTP, and refuses a missing or unknown notice period. Calling the API directly skips nothing.

   The seven-step form (teamlink-registration.js) is still in the page, hidden and untouched, for
   the scripts that drive it (TLResumeFirst.manual()).
   ===================================================================== */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__tlResumeFirst) return;
  window.__tlResumeFirst = true;

  var KEY = 'tl_reg_resume_draft_v1';
  var MANUAL_KEY = 'tl_reg_manual_v1';
  var ACCEPT = ['pdf', 'docx'];
  var MAX = 5 * 1024 * 1024;
  var EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var MOBILE_RX = /^(?:\+?91[\s-]?|0)?[6-9]\d{9}$/;
  var NOTICE = ['Immediate', '15 days', '30 days', '60 days', '90 days', 'Currently serving notice'];
  var MODES = [['Office', 'Work From Office'], ['Hybrid', 'Hybrid'], ['Remote', 'Work From Home'], ['Any', 'Any']];
  var CITIES = ['Hyderabad', 'Bengaluru', 'Chennai', 'Mumbai', 'Delhi', 'Pune', 'Kolkata', 'Noida', 'Gurugram',
    'Ahmedabad', 'Visakhapatnam', 'Vijayawada', 'Coimbatore', 'Kochi', 'Remote'];
  var QUALS = ['10th', '12th / Intermediate', 'Diploma', 'B.Tech / B.E', 'B.Sc', 'B.Com', 'BBA', 'BCA', 'B.A', 'M.Tech / M.E',
    'M.Sc', 'M.Com', 'MBA', 'MCA', 'M.A', 'PhD'];
  var REQ = '<span class="tlrf-req" aria-hidden="true"> *</span>';

  var S = {
    manual: (function () { try { return sessionStorage.getItem(MANUAL_KEY) === '1'; } catch (e) { return false; } })(),
    phase: 'upload', draft: null, token: null, file: null, busy: false, reading: false,
    err: {}, msg: '', otpSent: false, otpBusy: false, devCode: null, otpNote: '', done: null,
    auto: {},                                         // which fields were filled from the resume
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
  function remembered() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function val(id) { var el = $(id); return el ? String(el.value || '').trim() : ''; }
  function apiMessage(er) { return (er && er.message) || 'Something went wrong. Please try again.'; }
  function details(er) { return (er && (er.details || er.fields)) || {}; }
  function last10(v) { return String(v || '').replace(/\D/g, '').slice(-10); }
  function empty(v) { return v === undefined || v === null || String(v).trim() === ''; }
  function phoneVerified() {
    return !!(S.draft && S.draft.phoneVerified && S.draft.phone && last10(S.draft.phone) === last10(S.input.phone));
  }

  /* ------------------------------------------------------------------ */
  function css() {
    if ($('tlrf-css')) return;
    var s = document.createElement('style');
    s.id = 'tlrf-css';
    s.textContent = ''
      + '#tlrfHost{margin:0 0 16px}'
      + '#tlrfHost .tlrf-found{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0}'
      + '#tlrfHost .tlrf-found span{background:var(--ok-100,#e8f6ee);color:var(--ok-700,#1d6b3f);border-radius:99px;padding:3px 10px;font-size:12px}'
      + '#tlrfHost .tlrf-err{color:var(--bad-600,#c0392b);font-size:12px;margin-top:4px}'
      + '#tlrfHost .tlrf-req{color:#d92d20;font-weight:700}'
      + '#tlrfHost .tlrf-bad input,#tlrfHost .tlrf-bad select{border-color:var(--bad-600,#c0392b)}'
      + '#tlrfHost .tlrf-note{font-size:12.5px;color:var(--text-soft);margin:6px 0 0}'
      + '#tlrfHost .tlrf-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}'
      + '#tlrfHost .tlrf-row input{flex:1;min-width:160px}'
      + '#tlrfHost .tlrf-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}'
      + '#tlrfHost .tlrf-ok{color:var(--ok-700,#1d6b3f);font-weight:600;font-size:13px}'
      + '#tlrfHost .tlrf-tick{color:#1a8a4a;font-weight:700;font-size:14px}'
      + '#tlrfHost .tlrf-bar{height:8px;background:var(--bg-alt,#eef2f6);border-radius:99px;overflow:hidden;margin:6px 0 2px}'
      + '#tlrfHost .tlrf-bar i{display:block;height:100%;background:var(--brand-500,#1490b3)}'
      + '#tlrfHost .tlrf-dev{background:#fff7e6;border:1px solid #f3d38a;border-radius:8px;padding:8px 10px;font-size:12.5px;margin-top:6px}'
      + '#tlrfHost .tlrf-warn{background:#fff4f2;border:1px solid #f1c3bb;border-radius:8px;padding:10px 12px;font-size:13px;margin:0 0 12px}'
      + '#tlrfHost .tlrf-link{background:none;border:0;padding:0;color:var(--brand-600,#0f7c9c);text-decoration:underline;cursor:pointer;font:inherit}'
      + '#tlrfHost .tlrf-auto{font-size:10.5px;font-weight:700;color:var(--ok-700,#1d6b3f);background:var(--ok-100,#e8f6ee);border-radius:99px;padding:1px 7px;margin-left:6px;text-transform:none;letter-spacing:0}'
      + '#tlrfHost [hidden]{display:none!important}'
      + '#tlrfModes{display:grid;grid-template-columns:1fr 1fr;gap:8px}'
      + '#tlrfModes .opt-row{margin:0;justify-content:flex-start;text-align:left}'
      + '@media (max-width:720px){#tlrfHost .review-grid{grid-template-columns:1fr}}';
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------------------ *
   * the sections
   * ------------------------------------------------------------------ */
  function fieldHtml(id, label, inputHtml, errKey, opts) {
    opts = opts || {};
    var bad = !!S.err[errKey];
    return '<div class="review-field' + (bad ? ' tlrf-bad' : '') + '"><label for="' + id + '">' + h(label) + (opts.optional ? '' : REQ)
      + (opts.autoKey && S.auto[opts.autoKey] ? '<span class="tlrf-auto">from your resume</span>' : '') + '</label>'
      + inputHtml + (bad ? '<div class="tlrf-err" role="alert">' + h(S.err[errKey]) + '</div>' : '') + '</div>';
  }
  function txt(id, key, ph, extra) {
    var v = S.input[key];
    return '<input id="' + id + '" value="' + h(v === undefined || v === null ? '' : v) + '" placeholder="' + h(ph || '') + '" autocomplete="off"' + (extra || '') + '>';
  }

  function resumeSection() {
    var d = S.draft;
    var failed = d && d.status === 'failed';
    var body;
    if (S.reading) {
      body = '<div class="resume-upload-box"><div style="font-size:28px">📄</div><b>Reading your resume…</b>'
        + '<p>This takes a few seconds. Your resume is already saved.</p></div>';
    } else if (d && d.resume) {
      body = '<div class="tlrf-ok" role="status">✓ Uploaded: ' + h(d.resume.fileName) + '</div>'
        + (failed
          ? '<div class="tlrf-warn" role="alert" style="margin-top:8px"><b>' + h((d.error && d.error.message) || "We couldn't extract your resume automatically. Please review or enter the missing information manually.")
            + '</b><div class="tlrf-note">Your resume is saved. Fill in the details below.</div>'
            + '<div class="tlrf-row" style="margin-top:8px"><button type="button" class="btn btn-ghost btn-sm" data-tlrf="retry"' + (S.busy ? ' disabled' : '') + '>Try reading it again</button></div></div>'
          : '<div class="tlrf-found">' + foundSummary(d) + '</div>')
        + '<div class="tlrf-row" style="margin-top:10px"><button type="button" class="btn btn-ghost btn-sm" data-tlrf="pick">Replace resume</button></div>';
    } else {
      body = '<div class="resume-upload-box"><div style="font-size:28px">📄</div><b>Upload your resume</b>'
        + '<p>We read it and fill in your details for you. PDF or DOCX, up to 5 MB. You can still type everything yourself.</p>'
        + '<button type="button" class="btn btn-primary" data-tlrf="pick" style="margin-top:10px">Choose resume</button></div>';
    }
    return '<div class="panel ai-panel' + (S.err.resume ? ' tlrf-bad' : '') + '"><div class="panel-head"><h2><span class="reg-section-num">1</span>Upload your resume' + REQ + '</h2></div>'
      + '<div class="panel-body">' + body
      + '<input type="file" id="tlrfFile" accept=".pdf,.docx" hidden aria-label="Resume file">'
      + (S.err.resume ? '<div class="tlrf-err" role="alert">' + h(S.err.resume) + '</div>' : '')
      + '</div></div>';
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
    return bits.map(function (b) { return '<span>✓ ' + h(b) + '</span>'; }).join('');
  }

  function personalSection() {
    return '<div class="panel"><div class="panel-head"><h2><span class="reg-section-num">2</span>Personal details</h2></div><div class="panel-body">'
      + '<div class="review-grid">'
      + fieldHtml('tlrfName', 'Full name', txt('tlrfName', 'name', 'As on your resume', ' autocomplete="name"'), 'name', { autoKey: 'name' })
      + fieldHtml('tlrfEmail', 'Email', txt('tlrfEmail', 'email', 'you@example.com', ' type="email" autocomplete="email"'), 'email', { autoKey: 'email' })
      + '</div></div></div>';
  }

  function educationSection() {
    return '<div class="panel"><div class="panel-head"><h2><span class="reg-section-num">3</span>Education</h2></div><div class="panel-body">'
      + '<datalist id="tlrfQualList">' + QUALS.map(function (q) { return '<option value="' + h(q) + '">'; }).join('') + '</datalist>'
      + '<div class="review-grid">'
      + fieldHtml('tlrfQual', 'Highest qualification', txt('tlrfQual', 'qualification', 'e.g. B.Tech', ' list="tlrfQualList"'), 'qualification', { autoKey: 'qualification' })
      + fieldHtml('tlrfInst', 'Institute', txt('tlrfInst', 'institution', 'College / university'), 'institution', { autoKey: 'institution' })
      + fieldHtml('tlrfYear', 'Year of passing', txt('tlrfYear', 'passingYear', 'e.g. 2021', ' inputmode="numeric" maxlength="4"'), 'passingYear', { autoKey: 'passingYear' })
      + '</div></div></div>';
  }

  function experienceSection() {
    var cur = S.input.notice || '';
    var needsJob = Number(S.input.expYears) > 0;
    return '<div class="panel"><div class="panel-head"><h2><span class="reg-section-num">4</span>Experience</h2></div><div class="panel-body">'
      + '<div class="review-grid">'
      + fieldHtml('tlrfExp', 'Total experience (years)', txt('tlrfExp', 'expYears', '0 if you are a fresher', ' inputmode="decimal"'), 'expYears', { autoKey: 'expYears' })
      + fieldHtml('tlrfCompany', 'Current company', txt('tlrfCompany', 'company', needsJob ? 'Where you work now' : 'Optional for freshers'), 'company', { autoKey: 'company', optional: !needsJob })
      + fieldHtml('tlrfRole', 'Current role', txt('tlrfRole', 'role', needsJob ? 'Your designation' : 'Optional for freshers'), 'role', { autoKey: 'role', optional: !needsJob })
      + fieldHtml('tlrfNotice', 'Notice period',
        '<select id="tlrfNotice"><option value="">Select</option>' + NOTICE.map(function (o) {
          return '<option' + (cur === o ? ' selected' : '') + '>' + h(o) + '</option>';
        }).join('') + '</select>', 'notice', { autoKey: 'notice' })
      + '</div></div></div>';
  }

  function locOptions() {
    var pool = [];
    try { if (typeof window.locationPool === 'function') pool = window.locationPool(); } catch (e) { pool = []; }
    var all = CITIES.concat(pool).filter(function (x, i, a) { return x && a.indexOf(x) === i; });
    return '<datalist id="tlrfLocList">' + all.map(function (l) { return '<option value="' + h(l) + '">'; }).join('') + '</datalist>';
  }

  function accountSection() {
    var I = S.input, e = S.err;
    return '<div class="panel"><div class="panel-head"><h2>Account &amp; preferences</h2></div><div class="panel-body">'
      + locOptions()
      + '<div class="review-grid"><div>'
      + fieldHtml('tlrfLoc', 'Current location', txt('tlrfLoc', 'loc', 'e.g. Hyderabad', ' list="tlrfLocList"'), 'loc', { autoKey: 'loc' })
      + '<div class="review-field' + (e.pref ? ' tlrf-bad' : '') + '"><label for="tlrfPrefIn">Preferred location' + REQ + '</label>'
      + '<div class="tlrf-row"><input id="tlrfPrefIn" list="tlrfLocList" autocomplete="off" placeholder="Type a city and press Enter">'
      + '<button type="button" class="btn btn-ghost btn-sm" data-tlrf="addpref">Add</button></div>'
      + '<div class="tlrf-chips">' + I.prefLocs.map(function (l, i) {
        return '<span class="filter-chip">' + h(l) + '<button type="button" data-tlrf="rmpref" data-i="' + i + '" aria-label="Remove ' + h(l) + '">✕</button></span>';
      }).join('') + '</div>' + (e.pref ? '<div class="tlrf-err" role="alert">' + h(e.pref) + '</div>' : '') + '</div>'
      + fieldHtml('tlrfSal', 'Expected salary (₹ LPA)', '<input id="tlrfSal" type="number" min="0" step="0.5" placeholder="e.g. 8" value="' + h(I.sal || '') + '">', 'sal')
      + '</div><div>'
      + '<div class="review-field' + (e.modes ? ' tlrf-bad' : '') + '"><label>Work mode' + REQ + '</label><div class="opt-row-group" id="tlrfModes">'
      + MODES.map(function (m) {
        var on = I.modes.indexOf(m[0]) >= 0;
        return '<label class="opt-row' + (on ? ' active' : '') + '"><input type="checkbox" value="' + m[0] + '"' + (on ? ' checked' : '') + ' data-tlrf-mode="1"><span>' + h(m[1]) + '</span></label>';
      }).join('') + '</div>' + (e.modes ? '<div class="tlrf-err" role="alert">' + h(e.modes) + '</div>' : '') + '</div>'
      + fieldHtml('tlrfPw', 'Password', '<input id="tlrfPw" type="password" autocomplete="new-password" placeholder="At least 8 characters, a letter and a number">', 'pw')
      + fieldHtml('tlrfPw2', 'Confirm password', '<input id="tlrfPw2" type="password" autocomplete="new-password">', 'pw2')
      + '</div></div>'
      + '<label class="consent-row"><input type="checkbox" id="tlrfTerms"' + (I.terms ? ' checked' : '') + '><span>I agree to the TeamLink Terms &amp; Conditions and Privacy Policy' + REQ + '</span></label>'
      + '<label class="consent-row"><input type="checkbox" id="tlrfComm"' + (I.comm ? ' checked' : '') + '><span>I agree to receive recruitment communication from TeamLink' + REQ + '</span></label>'
      + '<label class="consent-row" style="margin-bottom:0"><input type="checkbox" id="tlrfResume"' + (I.resume !== false ? ' checked' : '') + '><span>I consent to my resume being processed for recruitment</span></label>'
      + (e.consent ? '<div class="tlrf-err" role="alert">' + h(e.consent) + '</div>' : '')
      + '</div></div>';
  }

  function mobileSection() {
    var e = S.err, ok = phoneVerified();
    return '<div class="panel"><div class="panel-head"><h2><span class="reg-section-num">5</span>Verify your mobile number</h2></div><div class="panel-body">'
      + '<div class="review-field' + (e.phone ? ' tlrf-bad' : '') + '"><label for="tlrfPhone">Mobile number' + REQ
      + (S.auto.phone ? '<span class="tlrf-auto">from your resume</span>' : '') + '</label>'
      + '<div class="tlrf-row"><input id="tlrfPhone" type="tel" inputmode="numeric" maxlength="15" autocomplete="tel" placeholder="10-digit mobile number" value="' + h(S.input.phone || '') + '">'
      + '<button type="button" class="btn btn-ghost btn-sm" id="tlrfSendOtp" data-tlrf="sendotp"' + (S.otpBusy ? ' disabled' : '') + (ok ? ' hidden' : '') + '>'
      + (S.otpBusy ? 'Sending…' : (S.otpSent ? 'Resend OTP' : 'Send OTP')) + '</button>'
      + '<span class="tlrf-tick" id="tlrfTick" role="status"' + (ok ? '' : ' hidden') + '>✓ Mobile number verified</span></div>'
      + (e.phone ? '<div class="tlrf-err" role="alert">' + h(e.phone) + '</div>' : '')
      + '</div>'
      + '<div id="tlrfOtpBox"' + (S.otpSent && !ok ? '' : ' hidden') + '>'
      + '<div class="tlrf-row"><input id="tlrfOtp" inputmode="numeric" maxlength="6" placeholder="6-digit OTP" autocomplete="one-time-code" aria-label="OTP">'
      + '<button type="button" class="btn btn-primary btn-sm" data-tlrf="verifyotp">Verify</button></div>'
      + (S.otpNote ? '<p class="tlrf-note">' + h(S.otpNote) + '</p>' : '')
      + (S.devCode ? '<div class="tlrf-dev">Development server: SMS is not being sent. Your OTP is <b>' + h(S.devCode) + '</b>.</div>' : '')
      + (e.otp ? '<div class="tlrf-err" role="alert">' + h(e.otp) + '</div>' : '')
      + '</div></div></div>';
  }

  function createSection() {
    var ok = phoneVerified();
    return (S.msg ? '<div class="tlrf-err" role="alert" style="margin:0 0 10px;font-size:13px;font-weight:600">' + h(S.msg) + '</div>' : '')
      + '<button type="button" class="btn btn-primary btn-block" id="tlrfCreate" data-tlrf="create" style="padding:13px"' + (S.busy ? ' disabled' : '') + (ok ? '' : ' hidden') + '>'
      + (S.busy ? 'Creating your account…' : 'Create Account') + '</button>'
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
      host.innerHTML = '<p class="tlrf-note" style="margin:0 0 12px">Back to <button type="button" class="tlrf-link" data-tlrf="auto">registration with my resume</button></p>';
      if (form) form.hidden = false;
      return;
    }
    if (form) form.hidden = true;
    if (S.phase === 'done') { host.innerHTML = donePanel(); return; }
    host.innerHTML = resumeSection() + personalSection() + educationSection() + experienceSection()
      + accountSection() + mobileSection() + createSection();
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
   * what the page holds, and what the resume fills in
   * ------------------------------------------------------------------ */
  function keepInputs() {
    var I = S.input;
    var map = { tlrfName: 'name', tlrfEmail: 'email', tlrfQual: 'qualification', tlrfInst: 'institution', tlrfYear: 'passingYear',
      tlrfExp: 'expYears', tlrfCompany: 'company', tlrfRole: 'role', tlrfNotice: 'notice', tlrfLoc: 'loc', tlrfSal: 'sal', tlrfPhone: 'phone' };
    Object.keys(map).forEach(function (id) { if ($(id)) I[map[id]] = val(id); });
    if ($('tlrfTerms')) I.terms = $('tlrfTerms').checked;
    if ($('tlrfComm')) I.comm = $('tlrfComm').checked;
    if ($('tlrfResume')) I.resume = $('tlrfResume').checked;
    var pw = $('tlrfPw'), pw2 = $('tlrfPw2');
    S.pw = pw ? pw.value : S.pw; S.pw2 = pw2 ? pw2.value : S.pw2;
  }
  function repaint() {
    keepInputs(); paint();
    if (S.pw && $('tlrfPw')) $('tlrfPw').value = S.pw;
    if (S.pw2 && $('tlrfPw2')) $('tlrfPw2').value = S.pw2;
  }

  /* Fill ONLY what is empty, from the reading. Never replaces a typed value. */
  function autofill(d) {
    keepInputs();
    var f = (d && d.fields) || {};
    var I = S.input;
    var edu = (f.educationRecords && f.educationRecords[0]) || {};
    var set = function (key, value, flag) {
      if (!empty(I[key]) || empty(value)) return;
      I[key] = String(value).trim(); S.auto[flag || key] = true;
    };
    set('name', f.name || d.nameSuggestion, 'name');
    set('email', d.email || f.email, 'email');
    set('phone', f.phone, 'phone');
    set('qualification', edu.qualification || edu.level || f.qualification || f.education, 'qualification');
    set('institution', edu.institution, 'institution');
    set('passingYear', edu.passingYear, 'passingYear');
    if (empty(I.expYears) && f.expYears !== undefined && f.expYears !== null) { I.expYears = String(f.expYears); S.auto.expYears = true; }
    set('company', f.currentCompany, 'company');
    set('role', f.title, 'role');
    set('loc', f.location, 'loc');
    if (empty(I.notice) && f.noticePeriod) {
      var match = NOTICE.filter(function (o) { return o.toLowerCase() === String(f.noticePeriod).trim().toLowerCase(); })[0];
      if (match) { I.notice = match; S.auto.notice = true; }
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
      S.draft = d; S.phase = 'read'; autofill(d); paint();
    }, function () { S.token = null; remember(); });
  }

  function upload(file) {
    keepInputs();
    S.err.resume = ''; S.msg = '';
    var ext = String(file.name || '').split('.').pop().toLowerCase();
    if (ACCEPT.indexOf(ext) < 0) { S.err.resume = 'Please upload a PDF or DOCX file.'; paint(); return; }
    if (file.size > MAX) { S.err.resume = 'That file is too large. The limit is 5 MB.'; paint(); return; }
    S.file = file; S.reading = true;
    paint();
    var fd = new FormData();
    fd.append('resume', file, file.name);
    api().post('/registration/drafts', fd, { timeout: 120000 }).then(function (d) {
      S.reading = false;
      /* a different file is a different draft: the number verified on the old one is not carried over */
      S.token = d.draftToken; delete d.draftToken;
      S.draft = d; S.phase = 'read'; S.otpSent = false; S.devCode = null; S.otpNote = '';
      autofill(d);
      remember();
      paint();
    }, function (er) {
      S.reading = false; S.err.resume = apiMessage(er); paint();
    });
  }

  function retry() {
    S.busy = true; S.reading = true; paint();
    api().post('/registration/drafts/' + encodeURIComponent(S.draft.draftId) + '/retry', {}, hdr()).then(function (d) {
      S.busy = false; S.reading = false; S.draft = d; autofill(d); paint();
    }, function (er) {
      S.busy = false; S.reading = false; say(apiMessage(er), '⚠️'); paint();
    });
  }

  function sendOtp() {
    keepInputs();
    S.err.phone = ''; S.err.otp = '';
    var phone = S.input.phone || '';
    if (!MOBILE_RX.test(phone.replace(/[\s-]/g, ''))) { S.err.phone = 'Enter a valid 10-digit mobile number'; repaint(); return; }
    if (!S.draft) { S.err.phone = 'Upload your resume first, then verify your mobile number.'; S.err.resume = S.err.resume || 'Upload your resume (PDF or DOCX).'; repaint(); return; }
    S.otpBusy = true; repaint();
    api().post('/registration/drafts/' + encodeURIComponent(S.draft.draftId) + '/phone-otp', { phone: phone }, hdr()).then(function (r) {
      S.otpBusy = false; S.otpSent = true; S.devCode = r.devCode || null;
      S.otpNote = r.sent ? 'We sent a 6-digit OTP to ' + last10(phone) + '.' : '';
      repaint();
      var c = $('tlrfOtp'); if (c) c.focus();
    }, function (er) {
      S.otpBusy = false; S.err.phone = (details(er).phone) || apiMessage(er); repaint();
    });
  }

  function verifyOtp() {
    keepInputs();
    var code = val('tlrfOtp').replace(/\D/g, '');
    S.err.otp = '';
    if (code.length !== 6) { S.err.otp = 'Enter the 6-digit OTP'; repaint(); return; }
    api().post('/registration/drafts/' + encodeURIComponent(S.draft.draftId) + '/verify-phone', { phone: S.input.phone, code: code }, hdr()).then(function (d) {
      S.err.otp = ''; S.err.phone = ''; S.draft = d; S.devCode = null; S.otpSent = false; S.otpNote = '';
      repaint();
    }, function (er) {
      S.err.otp = (details(er).code) || apiMessage(er) || 'Invalid OTP';
      repaint();
      var c = $('tlrfOtp'); if (c) c.focus();
    });
  }

  function problems() {
    var I = S.input, e = {};
    if (!S.draft || !S.draft.resume) e.resume = 'Upload your resume (PDF or DOCX)';
    if (empty(I.name) || I.name.length < 2) e.name = 'Full name is required';
    if (empty(I.email)) e.email = 'Email is required';
    else if (!EMAIL_RX.test(I.email)) e.email = 'Enter a valid email address';
    if (empty(I.qualification)) e.qualification = 'Highest qualification is required';
    if (empty(I.institution)) e.institution = 'Institute is required';
    var yr = Number(I.passingYear), thisYear = new Date().getFullYear();
    if (empty(I.passingYear)) e.passingYear = 'Year of passing is required';
    else if (!/^\d{4}$/.test(String(I.passingYear).trim()) || yr < 1960 || yr > thisYear + 6) e.passingYear = 'Enter a valid year';
    var exp = Number(String(I.expYears || '').replace(/[^\d.]/g, ''));
    if (empty(I.expYears)) e.expYears = 'Total experience is required (0 if you are a fresher)';
    else if (!Number.isFinite(Number(I.expYears)) || Number(I.expYears) < 0 || Number(I.expYears) > 60) e.expYears = 'Enter the years as a number';
    else if (exp > 0) {
      if (empty(I.company)) e.company = 'Current company is required';
      if (empty(I.role)) e.role = 'Current role is required';
    }
    /* "Select" is not a value */
    if (empty(I.notice) || NOTICE.indexOf(I.notice) < 0) e.notice = 'Notice period is required';
    if (empty(I.loc)) e.loc = 'Current location is required';
    if (!I.prefLocs.length) e.pref = 'Preferred location is required';
    var sal = Number(String(I.sal || '').replace(/[^\d.]/g, ''));
    if (!(sal > 0)) e.sal = 'Expected salary is required';
    else if (sal > 1000) e.sal = 'Please enter the salary in lakh per annum';
    if (!I.modes.length) e.modes = 'Select at least one work mode';
    var pw = S.pw || '';
    if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) e.pw = 'Password must be at least 8 characters, with a letter and a number';
    if ((S.pw2 || '') !== pw) e.pw2 = 'Passwords do not match';
    if (!I.terms || !I.comm) e.consent = 'Please accept the Terms & Conditions and agree to recruitment communication';
    if (!MOBILE_RX.test(String(I.phone || '').replace(/[\s-]/g, ''))) e.phone = 'Enter a valid 10-digit mobile number';
    else if (!phoneVerified()) e.phone = 'Verify your mobile number with the OTP';
    return e;
  }

  function create() {
    keepInputs();
    if (!phoneVerified()) { repaint(); return; }
    S.err = problems(); S.msg = '';
    if (Object.keys(S.err).length) {
      S.msg = 'Complete the required fields to continue';
      repaint();
      var first = document.querySelector('#tlrfHost .tlrf-err:not(#tlrfHost > .tlrf-err)');
      var bad = document.querySelector('#tlrfHost .tlrf-bad');
      var target = bad || first;
      if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center' });
      return;
    }
    var d = S.draft, I = S.input;
    var corr = { name: I.name, phone: I.phone, qualification: I.qualification, institution: I.institution,
      passingYear: String(I.passingYear).trim(), expYears: Number(I.expYears) };
    if (!empty(I.company)) corr.currentCompany = I.company;
    if (!empty(I.role)) corr.title = I.role;
    S.busy = true; repaint();
    var modes = I.modes.indexOf('Any') >= 0 ? ['Office', 'Hybrid', 'Remote'] : I.modes.slice();
    api().patch('/registration/drafts/' + encodeURIComponent(d.draftId), { corrections: corr }, hdr()).then(function (fresh) {
      S.draft = fresh;
      return api().post('/auth/register', {
        name: I.name, email: I.email, phone: I.phone,
        password: S.pw, confirmPassword: S.pw2,
        currentLocation: I.loc,
        preferredLocation: I.prefLocs.join(', '),
        expectedCtc: Number(String(I.sal).replace(/[^\d.]/g, '')),
        noticePeriod: I.notice,
        preferredWorkModes: modes,
        consent: { terms: !!I.terms, communication: !!I.comm, resumeProcessing: I.resume !== false },
        draftId: d.draftId, draftToken: S.token,
      }, { timeout: 120000 });
    }).then(function (res) {
      S.busy = false; S.phase = 'done'; S.done = res; S.pw = S.pw2 = null;
      S.draft = null; S.token = null; remember();
      var after = (window.TL && typeof TL.refresh === 'function') ? TL.refresh() : Promise.resolve();
      return Promise.resolve(after).catch(function () {}).then(function () {
        /* they came from Apply Now: the application is submitted now, without another click */
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
      if (dt.phone) S.err.phone = dt.phone;
      if (dt.resume) S.err.resume = dt.resume;
      if (dt.confirmPassword) S.err.pw2 = dt.confirmPassword;
      if (dt.password) S.err.pw = dt.password;
      if (dt.preferredLocation) S.err.pref = dt.preferredLocation;
      if (dt.expectedCtc) S.err.sal = dt.expectedCtc;
      if (dt.noticePeriod) S.err.notice = dt.noticePeriod;
      if (dt.preferredWorkModes) S.err.modes = dt.preferredWorkModes;
      if (dt.name) S.err.name = dt.name;
      if (dt['consent.terms'] || dt['consent.communication']) S.err.consent = dt['consent.terms'] || dt['consent.communication'];
      S.msg = Object.keys(dt).length ? 'Complete the required fields to continue' : apiMessage(er);
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

  /* Changing the mobile number after it was verified un-verifies it: the tick goes, the Create
     Account button goes, Send OTP comes back - without repainting the field being typed in. */
  function syncPhoneUi() {
    var ok = phoneVerified();
    var tick = $('tlrfTick'), send = $('tlrfSendOtp'), box = $('tlrfOtpBox'), create = $('tlrfCreate');
    if (tick) tick.hidden = !ok;
    if (send) send.hidden = ok;
    if (create) create.hidden = !ok;
    if (box && ok) box.hidden = true;
    if (!ok && S.draft && S.draft.phoneVerified) { S.otpSent = false; S.devCode = null; S.otpNote = ''; if (box) box.hidden = true; if (send) send.textContent = 'Send OTP'; }
  }

  document.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest && ev.target.closest('#tlrfHost [data-tlrf]');
    if (!b) return;
    var act = b.getAttribute('data-tlrf');
    if (act === 'pick') { var f = $('tlrfFile'); if (f) f.click(); return; }
    if (act === 'auto') { setManual(false); paint(); return; }
    if (act === 'retry') { retry(); return; }
    if (act === 'sendotp') { sendOtp(); return; }
    if (act === 'verifyotp') { verifyOtp(); return; }
    if (act === 'addpref') { addPref(); return; }
    if (act === 'rmpref') { keepInputs(); S.input.prefLocs.splice(Number(b.getAttribute('data-i')), 1); repaint(); return; }
    if (act === 'create') { create(); return; }
    if (act === 'go') {
      S.phase = 'upload'; S.done = null;
      if (typeof window.navigate === 'function') window.navigate(b.getAttribute('data-to'));
    }
  });

  document.addEventListener('input', function (ev) {
    var t = ev.target;
    if (!t || !t.closest || !t.closest('#tlrfHost')) return;
    if (t.id === 'tlrfPhone') {
      S.input.phone = String(t.value || '').trim(); S.err.phone = '';
      /* ANY edit of a verified number un-verifies it - typing the old digits back does not restore it. */
      if (S.draft && S.draft.phoneVerified && last10(S.input.phone) !== last10(S.draft.phone)) S.draft.phoneVerified = false;
      else if (S.draft && !S.draft.phoneVerified) { /* already unverified */ }
      syncPhoneUi();
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
    if (t.id === 'tlrfExp') { keepInputs(); repaint(); var ne = $('tlrfExp'); if (ne) ne.focus(); }
    if (t.id === 'tlrfNotice') { keepInputs(); S.err.notice = ''; }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'tlrfPrefIn') { ev.preventDefault(); addPref(); }
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'tlrfOtp') { ev.preventDefault(); verifyOtp(); }
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
