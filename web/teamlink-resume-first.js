/* =====================================================================
   TEAMLINK - candidate registration (0117, the classic one-page form)

     1 Personal Information   Full Name, Email Address (+ 6-digit email
                              code), Mobile Number (+ 6-digit SMS OTP),
                              Password, Confirm Password, Current Location
     2 Professional Info      Candidate Type (Fresher / Experienced);
                              Experienced: Current Company, Current
                              Designation, Total Experience;
                              Highest Qualification, Key Skills (tags)
     3 Resume                 Upload Resume (PDF / DOC / DOCX / TXT) -
                              read at once, fills the form above; or paste
                              the text and "Analyze with AI". Optional.
     4 Preferences            Preferred Job Location, Expected Salary,
                              Notice Period, Preferred Work Mode
     5 Consent                Terms & Privacy *, resume processing *,
                              WhatsApp job notifications (optional, never
                              pre-ticked)

   THE AI NEVER OVERWRITES WHAT WAS TYPED. A field the reader finds is
   filled only when it is empty, and marked; a different value for a field
   already filled shows as a clickable "AI found…" tag beside it instead.
   A value the reader was unsure of is marked "Please check". Nothing is
   invented: what a resume does not say stays empty.

   THE SERVER HOLDS THE DRAFT (/api/registration/drafts): the file or the
   pasted text, what was read from it, and the email's verification. This
   page keeps only the draft's id and token in sessionStorage.

   BOTH CODES BEFORE THE ACCOUNT. The email answers a 6-digit email code
   and the mobile number a 6-digit SMS OTP; the server refuses an account
   whose address or number did not (draftForRegistration).

   ONE PAGE, ALWAYS. No steps. The older seven-step form
   (teamlink-registration.js) is still in the page, hidden; a choice of it
   remembered from an earlier visit is forgotten, so it never comes back
   on its own.

   AFTER "Create account" the candidate is signed in and taken to the
   existing Candidate Home (#/candidate/home).
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
  var LANDING = '/candidate/home';
  var NOTICE = ['Immediate', '15 days', '30 days', '60 days', '90 days'];
  var MODES = [['Office', '🏢', 'Office'], ['Hybrid', '🔀', 'Hybrid'], ['Remote', '🏠', 'Remote']];
  /* The qualification list the form has always offered, grouped; each option's level is what the profile's
     "highest education" records. */
  var QUALS = [
    ['Doctorate', 'PhD', ['Ph.D', 'M.Phil']],
    ["Master's / Post-graduate", "Master's Degree", ['M.A', 'M.B.A / PGDM', 'M.C.A', 'M.Com', 'M.Ed', 'M.Pharma', 'M.Sc', 'M.Tech/M.E', 'MS', 'LLM', 'CA', 'CS', 'ICWA (CMA)']],
    ["Bachelor's / Undergraduate", "Bachelor's Degree", ['B.A', 'B.B.A / B.M.S', 'B.C.A', 'B.Com', 'B.Ed', 'B.P.Ed', 'B.Pharma', 'B.Sc', 'B.Tech/B.E']],
    ['Medical / Healthcare', "Bachelor's Degree", ['MBBS', 'MD', 'MDS', 'BDS', 'BAMS', 'BHMS', 'BUMS', 'BPT', 'BVSc', 'BHM', 'LLB', 'CA (Intermediate)']],
    ['Diploma / Vocational', 'Diploma', ['Diploma', 'ITI']],
    ['School', '', ['10+2 or Below', '10 or Below']],
    ['', 'Other', ['Other']],
  ];
  var LEVEL_OF = (function () {
    var m = {};
    QUALS.forEach(function (g) { g[2].forEach(function (q) { m[q] = g[1]; }); });
    m.MD = "Master's Degree"; m.MDS = "Master's Degree";
    m['10+2 or Below'] = 'Intermediate'; m['10 or Below'] = '10th';
    return m;
  })();
  var ALL_QUALS = [].concat.apply([], QUALS.map(function (g) { return g[2]; }));
  var CITIES = ['Hyderabad', 'Bengaluru', 'Chennai', 'Mumbai', 'Delhi', 'Pune', 'Kolkata', 'Noida', 'Gurugram',
    'Ahmedabad', 'Visakhapatnam', 'Vijayawada', 'Coimbatore', 'Kochi', 'Remote'];
  /* the form's fields the reader can fill, and what they are called in a "detected" count */
  var AI_FIELDS = ['name', 'email', 'phone', 'location', 'company', 'designation', 'totalExp', 'qualification', 'skills', 'notice'];

  function blankValues() {
    return { name: '', email: '', phone: '', location: '', candType: 'fresher', company: '', designation: '',
      totalExp: '', qualification: '', skills: [], prefLoc: '', salary: '', notice: '', modes: [] };
  }

  /* A "manual" (seven-step) choice remembered by an older version of this page: forgotten. */
  try { sessionStorage.removeItem(MANUAL_KEY); } catch (e) { /* nothing stored */ }

  var S = {
    manual: false,
    phase: 'form', draft: null, token: null, busy: false, reading: false, creating: false,
    err: {}, msg: '', codeSent: false, devCode: null, done: null,
    otpSent: false, otpDev: null,
    v: blankValues(), edited: {}, ai: {}, sugg: {}, review: {},
    pw: '', pw2: '', terms: false, resumeConsent: false, whatsapp: false,
    resumeStatus: '', resumeOk: false, pasted: '',
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
  /* Verify scripts only (TLResumeFirst.manual): never remembered, never offered on the page. */
  function setManual(on) { S.manual = !!on; }
  function remembered() {
    try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function apiMessage(er) { return (er && er.message) || 'Something went wrong. Please try again.'; }
  function details(er) { return (er && (er.details || er.fields)) || {}; }
  function val(id) { var el = $(id); return el ? String(el.value || '').trim() : ''; }
  function blank(v) { return v === undefined || v === null || (Array.isArray(v) ? !v.length : String(v).trim() === ''); }
  function dedupe(list) {
    var seen = {};
    return (list || []).map(function (x) { return String(x == null ? '' : x).trim(); }).filter(function (x) {
      var k = x.toLowerCase();
      if (!x || seen[k]) return false;
      seen[k] = 1; return true;
    });
  }

  /* "B.Tech" on a resume is the form's "B.Tech/B.E"; "MBA" is "M.B.A / PGDM". Unrecognised: no guess. */
  function matchQual(q) {
    var norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9+]/g, ''); };
    var want = norm(q);
    if (!want) return '';
    var hit = '';
    ALL_QUALS.forEach(function (opt) {
      if (hit) return;
      var parts = opt.split('/').map(norm);
      if (norm(opt) === want || parts.indexOf(want) >= 0) hit = opt;
    });
    if (!hit && /^(ssc|10th|matric)/.test(want)) hit = '10 or Below';
    if (!hit && /^(hsc|12th|intermediate|inter|puc)/.test(want)) hit = '10+2 or Below';
    if (!hit && /^phd/.test(want)) hit = 'Ph.D';
    return hit;
  }
  /* the qualification of the highest record the resume lists (rank, not order of appearance) */
  function highestRecord(recs) {
    var rank = { Doctorate: 6, 'Post Graduation': 5, Graduation: 4, Diploma: 3, '12th': 2, '10th': 1 };
    var best = null;
    (recs || []).forEach(function (r) {
      if (r && r.qualification && (rank[r.level] || 0) > (best ? (rank[best.level] || 0) : -1)) best = r;
    });
    return best ? best.qualification : '';
  }
  function matchNotice(n) {
    var s = String(n || '').toLowerCase();
    if (!s) return '';
    if (/immediate/.test(s)) return 'Immediate';
    var m = /(\d+)\s*(day|week|month)/.exec(s);
    if (!m) return '';
    var days = Number(m[1]) * (m[2] === 'week' ? 7 : m[2] === 'month' ? 30 : 1);
    var opt = days + ' days';
    return NOTICE.indexOf(opt) >= 0 ? opt : '';
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
      + '#tlrfHost .tlrf-err{color:var(--bad-600,#c0392b);font-size:12px;margin-top:4px}'
      + '#tlrfHost .tlrf-note{font-size:12.5px;color:var(--text-soft);margin:6px 0 0}'
      + '#tlrfHost .tlrf-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}'
      + '#tlrfHost .tlrf-row input{flex:1;min-width:150px}'
      + '#tlrfHost .tlrf-ok{color:var(--ok-700,#1d6b3f);font-weight:600;font-size:13px}'
      + '#tlrfHost .tlrf-dev{background:#fff7e6;border:1px solid #f3d38a;border-radius:8px;padding:8px 10px;font-size:12.5px;margin-top:6px}'
      + '#tlrfHost .tlrf-warn{background:#fff4f2;border:1px solid #f1c3bb;border-radius:8px;padding:10px 12px;font-size:13px;margin:0 0 12px}'
      + '#tlrfHost .tlrf-check{display:inline-block;margin-left:6px;background:#fff4dc;color:#8a5a00;border:1px solid #f1d28a;border-radius:99px;padding:0 8px;font-size:11px;font-weight:600}'
      + '#tlrfHost .tlrf-sugg{display:inline-block;margin-left:6px;background:#eef6ff;color:#1b5fa8;border:1px dashed #8bb8e8;border-radius:99px;padding:0 8px;font-size:11px;font-weight:600;cursor:pointer}'
      + '#tlrfHost .tlrf-ai input,#tlrfHost .tlrf-ai select,#tlrfHost .tlrf-ai .tlrf-tags{border-color:#7cc7a0!important;background:#f3fbf6}'
      + '#tlrfHost .tlrf-review input,#tlrfHost .tlrf-review select{border-color:#e0a030!important;background:#fffaf0}'
      + '#tlrfHost .tlrf-tags{display:flex;flex-wrap:wrap;gap:6px;border:1px solid var(--line,#d5dde5);border-radius:8px;padding:6px;min-height:42px;background:#fff}'
      + '#tlrfHost .tlrf-tags input{flex:1;min-width:120px;border:0!important;outline:0;background:transparent;padding:4px}'
      + '#tlrfHost .tlrf-status{display:inline-block;margin-top:10px;padding:8px 12px;border-radius:8px;font-size:13px;font-weight:600}'
      + '#tlrfHost .tlrf-status.ok{background:#e8f6ee;color:#1d6b3f}'
      + '#tlrfHost .tlrf-status.bad{background:#fff4f2;color:#b42318}'
      + '#tlrfHost .opt-row{cursor:pointer}'
      + '#tlrfHost [hidden]{display:none!important}'
      + '@media (max-width:720px){#tlrfHost .review-grid{grid-template-columns:1fr}}';
    document.head.appendChild(s);
  }

  function err(k) { return S.err[k] ? '<div class="tlrf-err" role="alert">' + h(S.err[k]) + '</div>' : ''; }
  function tags(k) {
    var out = '';
    if (S.ai[k] && !S.edited[k]) out += ' <span class="ai-extracted-tag">AI extracted</span>';
    if (S.review[k] && !S.edited[k]) out += ' <span class="tlrf-check">Please check</span>';
    if (S.sugg[k] !== undefined) {
      var shown = Array.isArray(S.sugg[k]) ? S.sugg[k].join(', ') : S.sugg[k];
      out += ' <button type="button" class="tlrf-sugg" data-tlrf="usesugg" data-k="' + k + '" title="Use this value">AI found: ' + h(String(shown).slice(0, 40)) + '</button>';
    }
    return out;
  }
  function wrapCls(k) {
    return (S.ai[k] && !S.edited[k] ? ' tlrf-ai' : '') + (S.review[k] && !S.edited[k] ? ' tlrf-review' : '');
  }
  function input(id, k, label, attrs, extra) {
    return '<div class="review-field' + wrapCls(k) + '"><label for="' + id + '">' + label + tags(k) + '</label>'
      + '<input id="' + id + '" data-f="' + k + '" value="' + h(S.v[k]) + '" ' + (attrs || '') + '>'
      + (extra || '') + err(k) + '</div>';
  }

  function isVerified() {
    var d = S.draft;
    return !!(d && d.emailVerified && String(d.email || '').toLowerCase() === String(S.v.email || '').toLowerCase());
  }
  function last10(p) { return String(p || '').replace(/\D/g, '').slice(-10); }
  function isPhoneVerified() {
    var d = S.draft;
    return !!(d && d.phoneVerified && last10(d.phone) && last10(d.phone) === last10(S.v.phone));
  }

  function personalPanel() {
    var v = S.v, d = S.draft || {};
    var verified = isVerified();
    var exists = d.existing || {};
    var dup = S.err.dupEmail || exists.email;
    var warn = dup
      ? '<div class="tlrf-warn" role="alert">An account with this email already exists. '
        + '<a href="#/login/candidate">Login</a> or <a href="#/forgot-password">Forgot Password</a>.</div>'
      : ((exists.phone || S.err.dupPhone) ? '<div class="tlrf-warn" role="alert">An account with this mobile number already exists. <a href="#/login/candidate">Login</a> or <a href="#/forgot-password">Forgot Password</a>.</div>' : '');
    var emailBox = '<div class="review-field' + wrapCls('email') + '"><label for="tlrfEmail">Email Address *' + tags('email') + '</label>'
      + '<div class="tlrf-row"><input id="tlrfEmail" data-f="email" type="email" autocomplete="email" placeholder="you@example.com" value="' + h(v.email) + '"' + (verified ? ' readonly' : '') + '>'
      + (verified ? '<span class="tlrf-ok">✓ Verified</span> <button type="button" class="btn btn-ghost btn-sm" data-tlrf="changeemail">Change</button>'
        : '<button type="button" class="btn btn-ghost btn-sm" data-tlrf="sendcode"' + (S.busy ? ' disabled' : '') + '>' + (S.codeSent ? 'Send again' : 'Send code') + '</button>') + '</div>'
      + (verified ? '' : '<p class="tlrf-note">We email you a 6-digit code to confirm this address.</p>')
      + (S.codeSent && !verified ? '<div class="tlrf-row" style="margin-top:6px"><input id="tlrfCode" inputmode="numeric" maxlength="6" placeholder="6-digit code" autocomplete="one-time-code" aria-label="Verification code">'
        + '<button type="button" class="btn btn-primary btn-sm" data-tlrf="verify"' + (S.busy ? ' disabled' : '') + '>Verify</button></div>' : '')
      + (S.devCode && !verified ? '<div class="tlrf-dev">Development server: email is not being sent. Your code is <b>' + h(S.devCode) + '</b>.</div>' : '')
      + err('email') + err('code') + '</div>';
    return '<div class="panel"><div class="panel-head"><h2><span class="reg-section-num">1</span>Personal Information</h2></div><div class="panel-body">'
      + warn
      + '<div class="review-grid"><div>'
      + input('tlrfName', 'name', 'Full Name *', 'autocomplete="name" placeholder="e.g. Sneha Kulkarni"')
      + phoneBox()
      + input('tlrfLoc', 'location', 'Current Location *', 'list="tlrfLocList" autocomplete="off" placeholder="e.g. Hyderabad"')
      + '</div><div>'
      + emailBox
      + '<div class="review-field"><label for="tlrfPw">Password *</label><input id="tlrfPw" type="password" autocomplete="new-password" placeholder="At least 8 characters, with a letter and a number">' + err('pw') + '</div>'
      + '<div class="review-field"><label for="tlrfPw2">Confirm Password *</label><input id="tlrfPw2" type="password" autocomplete="new-password" placeholder="Type the password again">' + err('pw2') + '</div>'
      + '</div></div></div></div>';
  }

  function phoneBox() {
    var v = S.v;
    var ok = isPhoneVerified();
    return '<div class="review-field' + wrapCls('phone') + '"><label for="tlrfPhone">Mobile Number *' + tags('phone') + '</label>'
      + '<div class="tlrf-row"><input id="tlrfPhone" data-f="phone" type="tel" inputmode="numeric" autocomplete="tel" maxlength="15" placeholder="+91 90000 00000" value="' + h(v.phone) + '"' + (ok ? ' readonly' : '') + '>'
      + (ok ? '<span class="tlrf-ok">✓ Verified</span> <button type="button" class="btn btn-ghost btn-sm" data-tlrf="changephone">Change</button>'
        : '<button type="button" class="btn btn-ghost btn-sm" data-tlrf="sendotp"' + (S.busy ? ' disabled' : '') + '>' + (S.otpSent ? 'Resend OTP' : 'Send OTP') + '</button>') + '</div>'
      + (ok ? '' : '<p class="tlrf-note">We send a 6-digit OTP by SMS to confirm this number.</p>')
      + (S.otpSent && !ok ? '<div class="tlrf-row" style="margin-top:6px"><input id="tlrfOtp" inputmode="numeric" maxlength="6" placeholder="6-digit OTP" autocomplete="one-time-code" aria-label="Mobile OTP">'
        + '<button type="button" class="btn btn-primary btn-sm" data-tlrf="verifyotp"' + (S.busy ? ' disabled' : '') + '>Verify</button></div>' : '')
      + (S.otpDev && !ok ? '<div class="tlrf-dev">Development server: SMS is not being sent. Your OTP is <b>' + h(S.otpDev) + '</b>.</div>' : '')
      + err('phone') + err('otp') + '</div>';
  }

  function professionalPanel() {
    var v = S.v;
    var exp = v.candType === 'experienced';
    var yrs = '';
    for (var i = 0; i <= 10; i++) yrs += '<option value="' + i + '"' + (String(v.totalExp) === String(i) ? ' selected' : '') + '>' + (i >= 10 ? '10+' : i) + ' yr' + (i === 1 ? '' : 's') + '</option>';
    var quals = '<option value="">Select…</option>' + QUALS.map(function (g) {
      var o = g[2].map(function (q) { return '<option' + (v.qualification === q ? ' selected' : '') + '>' + h(q) + '</option>'; }).join('');
      return g[0] ? '<optgroup label="' + h(g[0]) + '">' + o + '</optgroup>' : o;
    }).join('');
    return '<div class="panel"><div class="panel-head"><h2><span class="reg-section-num">2</span>Professional Information</h2></div><div class="panel-body">'
      + '<div class="review-field"><label>Candidate Type *</label>'
      + '<div class="opt-row-group" role="radiogroup" aria-label="Candidate Type" style="display:flex;gap:10px;flex-wrap:wrap">'
      + '<label class="opt-row' + (exp ? '' : ' active') + '"><input type="radio" name="tlrfType" value="fresher"' + (exp ? '' : ' checked') + ' data-tlrf-type="1"><span>🎓 Fresher</span></label>'
      + '<label class="opt-row' + (exp ? ' active' : '') + '"><input type="radio" name="tlrfType" value="experienced"' + (exp ? ' checked' : '') + ' data-tlrf-type="1"><span>💼 Experienced</span></label>'
      + '</div></div>'
      + (exp ? '<div class="review-grid"><div>'
        + input('tlrfCompany', 'company', 'Current Company *', 'placeholder="e.g. Infosys"')
        + '<div class="review-field' + wrapCls('totalExp') + '"><label for="tlrfExp">Total Experience *' + tags('totalExp') + '</label>'
        + '<select id="tlrfExp" data-f="totalExp"><option value="">Select…</option>' + yrs + '</select>' + err('totalExp') + '</div>'
        + '</div><div>'
        + input('tlrfDesig', 'designation', 'Current Designation *', 'placeholder="e.g. Software Engineer"')
        + '</div></div>' : '')
      + '<div class="review-grid"><div>'
      + '<div class="review-field' + wrapCls('qualification') + '" style="margin-bottom:0"><label for="tlrfQual">Highest Qualification *' + tags('qualification') + '</label>'
      + '<select id="tlrfQual" data-f="qualification">' + quals + '</select>' + err('qualification') + '</div>'
      + '</div><div>'
      + '<div class="review-field' + wrapCls('skills') + '" style="margin-bottom:0"><label for="tlrfSkillIn">Key Skills *' + tags('skills') + '</label>'
      + '<div class="tlrf-tags">' + v.skills.map(function (s, i) {
        return '<span class="filter-chip">' + h(s) + '<button type="button" data-tlrf="rmskill" data-i="' + i + '" aria-label="Remove ' + h(s) + '">✕</button></span>';
      }).join('')
      + '<input id="tlrfSkillIn" placeholder="' + (v.skills.length ? 'Add a skill' : 'e.g. React, Node.js, SQL') + '" autocomplete="off"></div>'
      + err('skills') + '</div>'
      + '</div></div>'
      + '</div></div>';
  }

  function resumePanel() {
    var d = S.draft;
    var file = d && d.resume ? d.resume.fileName : '';
    return '<div class="panel ai-panel"><div class="panel-head"><h2><span class="reg-section-num">3</span>Resume</h2></div><div class="panel-body">'
      + '<div class="resume-upload-box">'
      + '<div style="font-size:26px">📄</div>'
      + '<button type="button" class="btn btn-primary" style="margin-top:10px" data-tlrf="pick"' + (S.reading ? ' disabled' : '') + '>'
      + (S.reading ? 'Reading your resume…' : (file ? 'Replace Resume (PDF / DOC / DOCX / TXT)' : 'Upload Resume (PDF / DOC / DOCX / TXT)')) + '</button>'
      + '<p>🤖 AI reads your resume the moment you upload it and fills the form above automatically — no extra step needed.</p>'
      + (file ? '<p style="font-weight:700;color:var(--text)">📎 ' + h(file) + '</p>' : '')
      + (S.resumeStatus ? '<p class="tlrf-status ' + (S.resumeOk ? 'ok' : 'bad') + '" role="status">' + h(S.resumeStatus) + '</p>' : '')
      + '<input type="file" id="tlrfFile" accept=".pdf,.doc,.docx,.txt" hidden aria-label="Resume file">'
      + '</div>'
      + '<div class="reg-divider">prefer to paste text instead? (optional)</div>'
      + '<div class="review-field" style="margin-bottom:8px"><textarea id="tlrfPaste" rows="5" aria-label="Paste your resume text" placeholder="Paste your resume text here — TeamLink AI will scan it for your name, contact details, skills, experience, education and more.">' + h(S.pasted) + '</textarea></div>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-tlrf="analyze"' + (S.reading ? ' disabled' : '') + '>🤖 Analyze with AI</button>'
      + '<p class="req-note">TeamLink AI only fills in fields it actually finds in your resume, and never overwrites something you\'ve already typed — if it finds a different value for a field you\'ve filled in, it\'ll show up as a clickable "AI found…" tag next to that field instead of replacing it. Everything stays editable before you submit.</p>'
      + '</div></div>';
  }

  function locOptions() {
    var pool = [];
    try { if (typeof window.locationPool === 'function') pool = window.locationPool(); } catch (e) { pool = []; }
    var all = CITIES.concat(pool).filter(function (x, i, a) { return x && a.indexOf(x) === i; });
    return '<datalist id="tlrfLocList">' + all.map(function (l) { return '<option value="' + h(l) + '">'; }).join('') + '</datalist>';
  }

  function preferencesPanel() {
    var v = S.v;
    return '<div class="panel"><div class="panel-head"><h2><span class="reg-section-num">4</span>Preferences</h2></div><div class="panel-body">'
      + '<div class="review-grid"><div>'
      + input('tlrfPref', 'prefLoc', 'Preferred Job Location *', 'list="tlrfLocList" autocomplete="off" placeholder="e.g. Bengaluru"')
      + input('tlrfSal', 'salary', 'Expected Salary (₹ LPA)', 'type="number" min="0" step="0.5" placeholder="e.g. 12"')
      + '</div><div>'
      + '<div class="review-field' + wrapCls('notice') + '"><label for="tlrfNotice">Notice Period' + tags('notice') + '</label>'
      + '<select id="tlrfNotice" data-f="notice"><option value="">Select…</option>' + NOTICE.map(function (n) {
        return '<option' + (v.notice === n ? ' selected' : '') + '>' + h(n) + '</option>';
      }).join('') + '</select>' + err('notice') + '</div>'
      + '<div class="review-field" style="margin-bottom:0"><label>Preferred Work Mode</label>'
      + '<div class="opt-row-group" role="group" aria-label="Preferred Work Mode" style="display:flex;gap:10px;flex-wrap:wrap">' + MODES.map(function (m) {
        var on = v.modes.indexOf(m[0]) >= 0;
        return '<label class="opt-row' + (on ? ' active' : '') + '"><input type="checkbox" value="' + m[0] + '"' + (on ? ' checked' : '') + ' data-tlrf-mode="1"><span>' + m[1] + ' ' + h(m[2]) + '</span></label>';
      }).join('') + '</div>' + err('modes') + '</div>'
      + '</div></div>'
      + '</div></div>';
  }

  function consentPanel() {
    return '<div class="panel"><div class="panel-head"><h2><span class="reg-section-num">5</span>Consent</h2></div><div class="panel-body">'
      + '<label class="consent-row"><input type="checkbox" id="tlrfTerms"' + (S.terms ? ' checked' : '') + '><span>I agree to TeamLink Terms &amp; Privacy Policy *</span></label>'
      + '<label class="consent-row"><input type="checkbox" id="tlrfResumeOk"' + (S.resumeConsent ? ' checked' : '') + '><span>I consent to resume processing for recruitment *</span></label>'
      + '<label class="consent-row" style="margin-bottom:0"><input type="checkbox" id="tlrfWa"' + (S.whatsapp ? ' checked' : '') + '><span>Send me relevant job notifications on WhatsApp</span></label>'
      + err('consent')
      + '</div></div>'
      + (S.msg ? '<div class="tlrf-err" role="alert" style="margin:0 0 10px">' + h(S.msg) + '</div>' : '')
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
      host.innerHTML = '';
      if (form) form.hidden = false;
      return;
    }
    if (form) form.hidden = true;
    host.innerHTML = S.phase === 'done' ? donePanel()
      : locOptions() + personalPanel() + professionalPanel() + resumePanel() + preferencesPanel() + consentPanel();
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
  function keep() {
    Array.prototype.forEach.call(document.querySelectorAll('#tlrfHost [data-f]'), function (el) {
      var k = el.getAttribute('data-f');
      var nv = String(el.value || '').trim();
      if (k === 'email') nv = nv.replace(/\s+/g, '');
      if (nv !== String(S.v[k])) { S.v[k] = nv; S.edited[k] = true; delete S.sugg[k]; }
    });
    var pw = $('tlrfPw'), pw2 = $('tlrfPw2');
    if (pw) S.pw = pw.value;
    if (pw2) S.pw2 = pw2.value;
    var t = $('tlrfTerms'); if (t) S.terms = t.checked;
    var r = $('tlrfResumeOk'); if (r) S.resumeConsent = r.checked;
    var w = $('tlrfWa'); if (w) S.whatsapp = w.checked;
    var p = $('tlrfPaste'); if (p) S.pasted = p.value;
  }

  function addSkills(text) {
    var add = String(text || '').split(/[,\n;]/).map(function (x) { return x.trim().slice(0, 80); }).filter(Boolean);
    if (!add.length) return;
    S.v.skills = dedupe(S.v.skills.concat(add)).slice(0, 60);
    S.edited.skills = true; delete S.err.skills;
  }

  /* From the reading into the form: empty fields are filled and marked; a different value for a field that
     already has one is offered as "AI found…", never written over it. Returns how many fields it filled. */
  function applyDraft(d) {
    var f = (d && d.fields) || {}, c = (d && d.corrections) || {};
    function pick(k) { return Object.prototype.hasOwnProperty.call(c, k) ? c[k] : f[k]; }
    var found = {
      name: pick('name') || '',
      email: f.email || '',
      phone: pick('phone') || '',
      location: f.location || '',
      company: f.currentCompany || '',
      designation: f.title || '',
      totalExp: (f.expYears === undefined || f.expYears === null || f.expYears === '') ? '' : String(Math.min(10, Math.floor(Number(f.expYears)))),
      qualification: matchQual(f.qualification || highestRecord(f.educationRecords)),
      notice: matchNotice(f.noticePeriod || ''),
      skills: Array.isArray(f.skills) ? dedupe(f.skills) : [],
    };
    if (!found.name && d && d.nameSuggestion) found.name = d.nameSuggestion;
    var filled = 0;
    S.review = {};
    var unsure = {};
    (d.needsVerification || []).forEach(function (k) { unsure[k] = true; });
    var unsureMap = { name: 'name', phone: 'phone', title: 'designation', currentCompany: 'company', expYears: 'totalExp', qualification: 'qualification', noticePeriod: 'notice', location: 'location' };
    Object.keys(unsureMap).forEach(function (k) { if (unsure[k]) S.review[unsureMap[k]] = true; });

    AI_FIELDS.forEach(function (k) {
      var x = found[k];
      if (k === 'skills') {
        if (!x.length) return;
        var before = S.v.skills.length;
        S.v.skills = dedupe(S.v.skills.concat(x)).slice(0, 60);
        if (S.v.skills.length > before) { S.ai.skills = !S.edited.skills; filled += 1; }
        return;
      }
      if (blank(x)) return;
      if (blank(S.v[k])) {
        S.v[k] = x; S.ai[k] = true; delete S.edited[k]; filled += 1;
      } else if (String(S.v[k]).toLowerCase() !== String(x).toLowerCase()) {
        S.sugg[k] = x;
      }
    });
    /* a resume with an employer or years of experience is an experienced candidate - unless they chose.
       A headline title alone ("Data Analyst") is not: freshers write the role they want there. */
    if (!S.edited.candType && (found.company || Number(found.totalExp) > 0)) S.v.candType = 'experienced';
    return filled;
  }

  /* ------------------------------------------------------------------ *
   * talking to the server
   * ------------------------------------------------------------------ */
  function restore() {
    var r = remembered();
    if (!r || !r.id || !r.token || !api()) return;
    S.token = r.token;
    api().get('/registration/drafts/' + encodeURIComponent(r.id), hdr()).then(function (d) {
      S.draft = d;
      if (d.status === 'extracted') applyDraft(d);
      paint();
    }, function () { S.token = null; remember(); });
  }

  function ensureDraft() {
    if (S.draft && S.token) return Promise.resolve(S.draft);
    return api().post('/registration/drafts', { noResume: true }, { timeout: 30000 }).then(function (d) {
      S.token = d.draftToken; delete d.draftToken;
      S.draft = d; remember();
      return d;
    });
  }

  function afterRead(d) {
    S.reading = false; S.draft = d; remember();
    if (d.status === 'failed' || !d.fields || !Object.keys(d.fields).length) {
      S.resumeOk = false;
      S.resumeStatus = "We couldn't read details from that resume. Please fill in the form yourself - your resume is still attached.";
    } else {
      var n = applyDraft(d);
      S.resumeOk = true;
      S.resumeStatus = '✅ Resume analyzed successfully — ' + n + ' field' + (n === 1 ? '' : 's') + ' detected. Review the highlighted fields above.';
    }
    paint();
  }

  function upload(file) {
    S.err = {}; S.msg = '';
    var ext = String(file.name || '').split('.').pop().toLowerCase();
    if (ACCEPT.indexOf(ext) < 0) { keep(); S.resumeOk = false; S.resumeStatus = 'Please upload a PDF, DOC, DOCX or TXT file.'; paint(); return; }
    if (file.size > MAX) { keep(); S.resumeOk = false; S.resumeStatus = 'That file is too large. The limit is 5 MB.'; paint(); return; }
    if (S.reading) return;
    keep();
    S.reading = true; S.resumeStatus = ''; paint();
    var fd = new FormData();
    fd.append('resume', file, file.name);
    var had = S.draft && S.token;
    var call = had
      ? api().post('/registration/drafts/' + encodeURIComponent(S.draft.draftId) + '/resume', fd, hdr())
      : api().post('/registration/drafts', fd, { timeout: 120000 });
    call.then(function (d) {
      if (!had) { S.token = d.draftToken; delete d.draftToken; }
      afterRead(d);
    }, function (er) {
      S.reading = false; S.resumeOk = false; S.resumeStatus = apiMessage(er); paint();
    });
  }

  function analyzeText() {
    keep();
    var text = String(S.pasted || '').trim();
    if (text.length < 30) { S.resumeOk = false; S.resumeStatus = 'Please paste your resume text first.'; paint(); return; }
    if (S.reading) return;
    S.reading = true; S.resumeStatus = ''; paint();
    var had = S.draft && S.token;
    var call = had
      ? api().post('/registration/drafts/' + encodeURIComponent(S.draft.draftId) + '/text', { resumeText: text }, hdr())
      : api().post('/registration/drafts', { resumeText: text }, { timeout: 120000 });
    call.then(function (d) {
      if (!had) { S.token = d.draftToken; delete d.draftToken; }
      afterRead(d);
    }, function (er) {
      S.reading = false; S.resumeOk = false; S.resumeStatus = apiMessage(er); paint();
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

  function sendOtp() {
    keep();
    S.err.phone = ''; S.err.otp = ''; S.err.dupPhone = false;
    if (!PHONE_RX.test(String(S.v.phone || '').replace(/[\s-]/g, ''))) { S.err.phone = 'Enter a valid 10-digit Indian mobile number.'; paint(); return; }
    if (S.busy) return;
    S.busy = true; paint();
    ensureDraft().then(function (d) {
      return api().post('/registration/drafts/' + encodeURIComponent(d.draftId) + '/phone-otp', { phone: S.v.phone }, hdr());
    }).then(function (r) {
      S.busy = false; S.otpSent = true; S.otpDev = r.devCode || null;
      if (r.sent) say('We sent a 6-digit OTP to ' + S.v.phone, '📱');
      paint();
      var c = $('tlrfOtp'); if (c) c.focus();
    }, function (er) {
      S.busy = false;
      if (er && (er.code === 'PHONE_TAKEN' || /already exists/i.test(apiMessage(er)))) S.err.dupPhone = true;
      S.err.phone = (details(er).phone) || apiMessage(er);
      paint();
    });
  }

  function verifyOtp() {
    keep();
    var code = val('tlrfOtp').replace(/\D/g, '');
    if (code.length !== 6) { S.err.otp = 'Enter the 6-digit OTP sent to your mobile.'; paint(); return; }
    if (S.busy) return;
    S.busy = true; paint();
    api().post('/registration/drafts/' + encodeURIComponent(S.draft.draftId) + '/verify-phone',
      { phone: S.v.phone, code: code }, hdr()).then(function (d) {
      S.busy = false; S.err.otp = ''; S.err.phone = ''; S.draft = d; S.otpDev = null; paint();
      say('Mobile number verified', '✓');
    }, function (er) {
      S.busy = false; S.err.otp = (details(er).code) || apiMessage(er); paint();
    });
  }

  function problems() {
    var v = S.v, e = {};
    if (!v.name || v.name.length < 2) e.name = 'Please enter your full name.';
    if (!EMAIL_RX.test(v.email)) e.email = 'Please enter a valid email address.';
    else if (!isVerified()) e.email = 'Please verify your email address - press Send code.';
    if (!PHONE_RX.test(String(v.phone || '').replace(/[\s-]/g, ''))) e.phone = 'Enter a valid 10-digit Indian mobile number.';
    else if (!isPhoneVerified()) e.phone = 'Please verify your mobile number - press Send OTP.';
    if (!v.location) e.location = 'Current Location is required.';
    var pw = S.pw || '';
    if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) e.pw = 'Password must be at least 8 characters, with a letter and a number.';
    if ((S.pw2 || '') !== pw) e.pw2 = 'Passwords do not match.';
    if (v.candType === 'experienced') {
      if (!v.company) e.company = 'Current Company is required.';
      if (!v.designation) e.designation = 'Current Designation is required.';
      if (v.totalExp === '') e.totalExp = 'Total Experience is required.';
    }
    if (!v.qualification) e.qualification = 'Highest Qualification is required.';
    if (!v.skills.length) e.skills = 'Add at least one key skill.';
    if (!v.prefLoc) e.prefLoc = 'Preferred Job Location is required.';
    var sal = String(v.salary || '').trim();
    if (sal && !(Number(sal) > 0)) e.salary = 'Expected Salary must be more than 0.';
    else if (sal && Number(sal) > 1000) e.salary = 'Please enter the salary in lakh per annum.';
    if (!S.terms || !S.resumeConsent) e.consent = 'Please accept the Terms & Privacy Policy and consent to resume processing.';
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
    var fresher = v.candType !== 'experienced';
    var corr = {
      name: v.name, phone: v.phone,
      qualification: v.qualification || null,
      highestEducation: LEVEL_OF[v.qualification] || null,
      title: fresher ? null : (v.designation || null),
      currentCompany: fresher ? null : (v.company || null),
      expYears: fresher ? 0 : Number(v.totalExp || 0),
      skills: dedupe(v.skills),
    };
    var d = S.draft;
    var body = {
      name: v.name, email: v.email, phone: v.phone,
      password: S.pw, confirmPassword: S.pw2,
      currentLocation: v.location,
      preferredLocation: v.prefLoc,
      fresher: fresher,
      whatsappOptIn: !!S.whatsapp,
      consent: { terms: !!S.terms, resumeProcessing: !!S.resumeConsent, communication: !!S.whatsapp },
      draftId: d.draftId, draftToken: S.token,
    };
    if (String(v.salary || '').trim()) body.expectedCtc = Number(v.salary);
    if (v.notice) body.noticePeriod = v.notice;
    if (v.modes.length) body.preferredWorkModes = v.modes.slice();
    api().patch('/registration/drafts/' + encodeURIComponent(d.draftId), { corrections: corr }, hdr()).then(function (fresh) {
      S.draft = fresh;
      return api().post('/auth/register', body, { timeout: 120000 });
    }).then(function (res) {
      S.phase = 'done'; S.done = res; S.pw = S.pw2 = '';
      S.draft = null; S.token = null; remember();
      paint();
      var after = (window.TL && typeof TL.refresh === 'function') ? TL.refresh() : Promise.resolve();
      return Promise.resolve(after).catch(function () {}).then(function () {
        try { sessionStorage.removeItem('tl_apply_contact_v1'); } catch (e) { /* nothing */ }
        S.creating = false;
        /* The existing candidate landing page. If they came from Apply Now, the pending application is
           submitted on the way (teamlink-apply-auth.js). */
        setTimeout(function () {
          S.phase = 'form'; S.done = null; resetForm();
          if (typeof window.navigate === 'function') window.navigate(LANDING);
          else location.hash = '#' + LANDING;
        }, 600);
      });
    }).catch(function (er) {
      S.creating = false;
      var dt = details(er);
      if (er && (er.code === 'EMAIL_TAKEN' || dt.email)) {
        S.err.email = dt.email || apiMessage(er);
        if (/already exists/i.test(S.err.email)) S.err.dupEmail = true;
      }
      if (dt.phone) { S.err.phone = dt.phone; if (/already exists/i.test(dt.phone)) S.err.dupPhone = true; }
      if (dt.confirmPassword) S.err.pw2 = dt.confirmPassword;
      if (dt.password) S.err.pw = dt.password;
      if (dt.preferredLocation) S.err.prefLoc = dt.preferredLocation;
      if (dt.expectedCtc) S.err.salary = dt.expectedCtc;
      if (dt['consent.terms']) S.err.consent = dt['consent.terms'];
      if (dt.name) S.err.name = dt.name;
      if (dt.highestEducation || dt.qualification) S.err.qualification = dt.highestEducation || dt.qualification;
      S.msg = apiMessage(er);
      paint();
    });
  }

  function resetForm() {
    S.v = blankValues();
    S.edited = {}; S.ai = {}; S.sugg = {}; S.review = {}; S.err = {}; S.msg = ''; S.codeSent = false; S.devCode = null;
    S.otpSent = false; S.otpDev = null;
    S.pw = S.pw2 = ''; S.terms = false; S.resumeConsent = false; S.whatsapp = false;
    S.resumeStatus = ''; S.resumeOk = false; S.pasted = '';
  }

  /* ------------------------------------------------------------------ *
   * the controls
   * ------------------------------------------------------------------ */
  document.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest && ev.target.closest('#tlrfHost [data-tlrf]');
    if (!b) return;
    var act = b.getAttribute('data-tlrf');
    if (act === 'pick') { var f = $('tlrfFile'); if (f) f.click(); return; }
    if (act === 'analyze') { analyzeText(); return; }
    if (act === 'auto') { setManual(false); paint(); return; }
    if (act === 'sendcode') { sendCode(); return; }
    if (act === 'verify') { verify(); return; }
    if (act === 'sendotp') { sendOtp(); return; }
    if (act === 'verifyotp') { verifyOtp(); return; }
    if (act === 'changephone') {
      keep();
      if (S.draft) S.draft = Object.assign({}, S.draft, { phoneVerified: false });
      S.otpSent = false; S.otpDev = null; paint();
      var ph = $('tlrfPhone'); if (ph) ph.focus();
      return;
    }
    if (act === 'changeemail') {
      keep();
      if (S.draft) S.draft = Object.assign({}, S.draft, { emailVerified: false });
      S.codeSent = false; S.devCode = null; paint();
      var em = $('tlrfEmail'); if (em) em.focus();
      return;
    }
    if (act === 'usesugg') {
      keep();
      var k = b.getAttribute('data-k');
      if (S.sugg[k] !== undefined) { S.v[k] = S.sugg[k]; delete S.sugg[k]; S.ai[k] = true; delete S.edited[k]; delete S.err[k]; }
      paint(); return;
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
    if (t.id === 'tlrfFile' && t.files && t.files[0]) { upload(t.files[0]); t.value = ''; return; }
    if (t.getAttribute('data-tlrf-type')) {
      keep(); S.v.candType = t.value; S.edited.candType = true;
      delete S.err.company; delete S.err.designation; delete S.err.totalExp;
      paint(); return;
    }
    if (t.getAttribute('data-tlrf-mode')) {
      keep();
      S.v.modes = [].slice.call(document.querySelectorAll('#tlrfHost input[data-tlrf-mode]:checked')).map(function (x) { return x.value; });
      paint(); return;
    }
    if (t.tagName === 'SELECT' && t.getAttribute('data-f')) { keep(); delete S.err[t.getAttribute('data-f')]; paint(); return; }
    if (t.id === 'tlrfPhone') {
      keep();
      S.err.phone = ''; S.err.dupPhone = false;
      /* a different number has to answer its own OTP */
      if (!isPhoneVerified()) { S.otpSent = false; S.otpDev = null; }
      paint();
      return;
    }
    if (t.id === 'tlrfEmail') {
      keep();
      S.err.email = ''; S.err.dupEmail = false;
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
    var k = t.getAttribute('data-f');
    if (k) { S.edited[k] = true; S.v[k] = String(t.value || ''); delete S.sugg[k]; }
    if (t.id === 'tlrfSkillIn' && /[,;]$/.test(t.value)) { keep(); addSkills(t.value); paint(); var si = $('tlrfSkillIn'); if (si) si.focus(); }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'tlrfSkillIn') {
      ev.preventDefault(); keep(); addSkills(ev.target.value); paint();
      var si = $('tlrfSkillIn'); if (si) si.focus();
    }
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'tlrfCode') { ev.preventDefault(); verify(); }
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'tlrfOtp') { ev.preventDefault(); verifyOtp(); }
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
          if (window.TL && TL.debug) console.error('[registration]', e);
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
