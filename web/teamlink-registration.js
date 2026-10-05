/* =====================================================================
   TEAMLINK — the candidate registration, in seven steps (0109)

     1 Basic   2 Education   3 Experience   4 Preferences
     5 Resume  6 Account     7 Review  ->  Create Account

   THE SAME FORM, NOT A SECOND ONE. pageRegisterCandidate() still builds
   the registration page it always built - every input keeps its id, its
   inline handlers and its wiring - and this module re-arranges that markup
   into steps before it reaches the screen, then adds the fields the owner
   asked for that had nowhere to go. So everything already attached to the
   form keeps working untouched:

     - the resume upload, the server parser, the "AI found..." tags that
       never overwrite what the candidate typed (index.html,
       teamlink-integration.js) - still FIRST, at the top of step 1;
     - submitCandidateRegistration (integration.js): POST /auth/register,
       PUT the profile, upload the resume, go to the dashboard;
     - Apply Now while signed out (teamlink-apply-auth.js): its banner on
       this page, and the application continuing after registration;
     - availability (0092) and preferred language (0102) beside Notice.

   WHAT IS ADDED here, and only here:
     - steps with progress, Back / Continue, a Review step;
     - inline validation in the owner's words, announced to screen readers,
       focus moved to the first problem;
     - the inline "already an account" check for email and mobile;
     - password strength, show / hide, confirm password;
     - a draft per device (text only - never a password, never a file) so
       a refresh, a re-render or a closed tab loses nothing; cleared the
       moment the account exists. A draft never creates an account;
     - consent, sent with the registration (stored with its version);
     - the extra profile fields, the photo and the documents, saved onto
       the new account straight after it is created;
     - "Registration Successful / Welcome to TeamLink! / Candidate ID".

   And on the profile: the Candidate ID, Documents (upload / replace /
   download / delete) and "Your data" (Download My Data, Request Account
   Deletion). Recruiters see the Candidate ID beside the internal id. An
   admin page lists deletion requests.

   The server enforces every rule; nothing here is the authority.
   ===================================================================== */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__tlRegistration) return;
  window.__tlRegistration = true;

  var DRAFT_KEY = 'tl_reg_draft_v1';
  var DRAFT_TTL = 14 * 864e5;
  var RESUME_EXT = ['pdf', 'doc', 'docx'];
  var RESUME_MAX = 5 * 1024 * 1024;
  var DOC_MAX = 5 * 1024 * 1024;
  var PHOTO_MAX = 2 * 1024 * 1024;
  var EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  var DOC_KINDS = [
    { kind: 'cover_letter', label: 'Cover Letter', ext: ['pdf', 'doc', 'docx'], max: 1 },
    { kind: 'certificate', label: 'Certificates', ext: ['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx'], max: 20 },
    { kind: 'marksheet', label: 'Marksheets', ext: ['pdf', 'jpg', 'jpeg', 'png'], max: 20 },
    { kind: 'experience_letter', label: 'Experience Letters', ext: ['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx'], max: 20 },
  ];
  var KIND_LABEL = { cover_letter: 'Cover Letter', certificate: 'Certificate', marksheet: 'Marksheet',
    experience_letter: 'Experience Letter', photo: 'Profile Photo', other: 'Other document' };

  var STEPS = [
    { n: 1, title: 'Basic Details', short: 'Basic', intro: 'Who you are and how to reach you.' },
    { n: 2, title: 'Education', short: 'Education', intro: 'Your highest qualification and your scores.' },
    { n: 3, title: 'Experience & Skills', short: 'Experience', intro: 'Your work so far, your skills and your links.' },
    { n: 4, title: 'Job Preferences', short: 'Preferences', intro: 'The roles you want and how we may contact you.' },
    { n: 5, title: 'Resume & Documents', short: 'Resume', intro: 'Your resume, and any documents you want on your profile.' },
    { n: 6, title: 'Account', short: 'Account', intro: 'The password you will sign in with.' },
    { n: 7, title: 'Review & Create Account', short: 'Review', intro: 'Check everything, agree to the terms, and create your account.' },
  ];

  var BANDS = [
    ['fresher', 'Fresher', 0], ['0-1', '0–1 years', 0], ['1-2', '1–2 years', 1], ['2-3', '2–3 years', 2],
    ['3-5', '3–5 years', 3], ['5-8', '5–8 years', 5], ['8+', '8+ years', 8],
  ];
  var QUALS = ['10th', '12th', 'Diploma', 'ITI', 'B.Tech', 'B.E', 'M.Tech', 'M.E', 'MBA', 'MCA', 'BCA', 'B.Sc', 'M.Sc', 'Ph.D'];
  var MORE_QUALS = ['B.A', 'B.Com', 'B.B.A / B.M.S', 'B.Ed', 'B.Pharma', 'BDS', 'MBBS', 'MD', 'LLB', 'CA',
    'M.A', 'M.Com', 'M.Ed', 'M.Pharma', 'M.Phil', 'MS', 'LLM'];
  /* What the parser and the old list call these, mapped onto the owner's. */
  var QUAL_ALIAS = {
    'b.tech/b.e': 'B.Tech', 'b.tech': 'B.Tech', 'btech': 'B.Tech', 'b.e': 'B.E', 'be': 'B.E',
    'm.tech/m.e': 'M.Tech', 'm.tech': 'M.Tech', 'mtech': 'M.Tech', 'm.e': 'M.E',
    'm.b.a / pgdm': 'MBA', 'm.b.a': 'MBA', 'mba': 'MBA', 'pgdm': 'MBA', 'm.c.a': 'MCA', 'mca': 'MCA',
    'b.c.a': 'BCA', 'bca': 'BCA', 'b.sc': 'B.Sc', 'bsc': 'B.Sc', 'm.sc': 'M.Sc', 'msc': 'M.Sc',
    'ph.d': 'Ph.D', 'phd': 'Ph.D', '10+2 or below': '12th', '12th': '12th', 'intermediate': '12th',
    '10 or below': '10th', '10th': '10th', 'ssc': '10th', 'diploma': 'Diploma', 'iti': 'ITI',
  };
  var CITIES = ['Hyderabad', 'Bengaluru', 'Chennai', 'Pune', 'Mumbai'];
  var ANY_LOCATION = 'Any Location';
  var EMP_TYPES = ['Full Time', 'Part Time', 'Contract', 'Internship', 'Remote', 'Hybrid'];
  var CHANNELS = [['email', 'Email'], ['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['call', 'Phone Call']];

  /* ---- module state (memory only: nothing here outlives the tab) ---- */
  var S = {
    step: 1, maxStep: 1, touched: {}, attempted: {}, submitTried: false, submitting: false,
    dup: { email: {}, phone: {} }, server: {}, settings: null, restored: null, done: false,
  };
  var MEM = {
    pw: '', pw2: '', resume: null, resumeErr: '', photo: null, photoErr: '',
    docs: { cover_letter: [], certificate: [], marksheet: [], experience_letter: [] }, docErr: {},
  };
  var REG = null;      // the registration that has just succeeded

  /* ------------------------------------------------------------------ *
   * small helpers
   * ------------------------------------------------------------------ */
  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }
  function val(id) { var el = $(id); return el ? String(el.value || '').trim() : ''; }
  function api() { return (window.TL && window.TL.api) || null; }
  function say(m, i) { if (typeof window.toast === 'function') window.toast(m, i || 'ℹ️'); }
  function onRegisterPage() { return /^#\/register\/candidate/.test(location.hash || ''); }
  function session() { return (typeof STATE !== 'undefined' && STATE.session) || null; }
  function isCandidate() { var s = session(); return !!(s && s.role === 'candidate'); }
  function me() {
    var s = session();
    if (!s || s.role !== 'candidate') return null;
    try { return DATA.candidateById(s.id) || null; } catch (e) { return null; }
  }
  function mobileDigits(v) {
    var d = String(v || '').replace(/^\s*\+\s*91/, '').replace(/\D/g, '');
    if (d.length > 10 && d.indexOf('91') === 0) d = d.slice(2);
    if (d.length > 10 && d.charAt(0) === '0') d = d.slice(1);
    if (d.length === 11 && d.charAt(0) === '0') d = d.slice(1);
    return d.slice(-10);
  }
  function list(v) {
    var seen = {};
    return String(v || '').split(/[,;\n]/).map(function (x) { return x.trim(); })
      .filter(function (x) { var k = x.toLowerCase(); if (!x || seen[k]) return false; seen[k] = 1; return true; });
  }
  function extOf(name) { var m = /\.([a-z0-9]+)$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }
  function sizeText(n) {
    n = Number(n || 0);
    return n >= 1048576 ? (Math.round(n / 104857.6) / 10) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  }
  function announce(msg) {
    var el = $('tlrLive');
    if (!el) return;
    el.textContent = '';
    setTimeout(function () { el.textContent = msg; }, 30);
  }
  function settings() {
    if (S.settings || !api()) return;
    S.settings = {};
    api().get('/registration/settings').then(function (s) {
      S.settings = s || {};
      if (s && s.resumeMaxBytes) RESUME_MAX = Math.min(RESUME_MAX, Number(s.resumeMaxBytes)) || RESUME_MAX;
      if (s && s.documentMaxBytes) DOC_MAX = Number(s.documentMaxBytes) || DOC_MAX;
      if (s && s.photoMaxBytes) PHOTO_MAX = Number(s.photoMaxBytes) || PHOTO_MAX;
      paintTermsLinks();
    }, function () { S.settings = {}; });
  }

  /* ------------------------------------------------------------------ *
   * 1. the markup: the existing form, re-arranged into steps
   * ------------------------------------------------------------------ */
  function aiTag(id) { return ' <span id="' + id + 'AiTag" class="ai-extracted-tag" style="display:none"></span>'; }
  function fld(o) {
    var describedBy = o.id + 'Err' + (o.hint ? ' ' + o.id + 'Hint' : '');
    var lab = '<label for="' + o.id + '">' + h(o.label)
      + (o.req ? ' <span class="tlr-req" aria-hidden="true">*</span>' : '')
      + (o.ai ? aiTag(o.id) : '') + '</label>';
    var common = ' id="' + o.id + '" name="' + o.id + '"' + (o.req ? ' aria-required="true"' : '')
      + ' aria-describedby="' + describedBy + '"' + (o.attrs || '');
    var ctl;
    if (o.select) ctl = '<select' + common + '>' + o.select + '</select>';
    else if (o.textarea) ctl = '<textarea' + common + ' rows="' + (o.rows || 4) + '" placeholder="' + h(o.ph || '') + '"></textarea>';
    else ctl = '<input' + common + ' type="' + (o.type || 'text') + '" placeholder="' + h(o.ph || '') + '">';
    return '<div class="review-field' + (o.wide ? ' tlr-wide' : '') + '" data-tlr-field="' + o.id + '">' + lab + ctl
      + (o.after || '') + (o.hint ? '<div class="tlr-hint" id="' + o.id + 'Hint">' + o.hint + '</div>' : '')
      + '<div class="field-err" id="' + o.id + 'Err"></div></div>';
  }
  function slot(name) { return '<div data-tlr-slot="' + name + '"></div>'; }
  function grid(inner) { return '<div class="review-grid tlr-grid">' + inner + '</div>'; }
  function panel(title, inner, extraClass) {
    return '<div class="panel tlr-panel' + (extraClass ? ' ' + extraClass : '') + '"><div class="panel-head"><h3>' + h(title)
      + '</h3></div><div class="panel-body">' + inner + '</div></div>';
  }
  function opts(values, placeholder) {
    return (placeholder ? '<option value="">' + h(placeholder) + '</option>' : '')
      + values.map(function (v) {
        var value = Array.isArray(v) ? v[0] : v, label = Array.isArray(v) ? v[1] : v;
        return '<option value="' + h(value) + '">' + h(label) + '</option>';
      }).join('');
  }
  function yearOptions() {
    var y = new Date().getFullYear(), out = [];
    for (var i = y + 5; i >= 1960; i--) out.push(String(i));
    return opts(out, 'Select year…');
  }
  function checkGroup(name, items, legend, req) {
    return '<fieldset class="tlr-fieldset" id="' + name + 'Group" aria-describedby="' + name + 'Err">'
      + '<legend>' + h(legend) + (req ? ' <span class="tlr-req" aria-hidden="true">*</span>' : '') + '</legend>'
      + '<div class="opt-row-group">' + items.map(function (it) {
        return '<label class="opt-row"><input type="checkbox" name="' + name + '" value="' + h(it[0]) + '"'
          + (it[2] ? ' checked' : '') + '><span>' + h(it[1]) + '</span></label>';
      }).join('') + '</div><div class="field-err" id="' + name + 'Err"></div></fieldset>';
  }

  function stepSection(n, inner) {
    var st = STEPS[n - 1];
    return '<section class="tlr-step" data-step="' + n + '" id="tlrStep' + n + '" aria-labelledby="tlrStepH' + n + '"' + (n === 1 ? '' : ' hidden') + '>'
      + '<div class="tlr-step-head"><h2 id="tlrStepH' + n + '" tabindex="-1"><span class="reg-section-num">' + n + '</span>' + h(st.title) + '</h2>'
      + '<p>' + h(st.intro) + '</p></div>'
      + '<div class="tlr-summary" id="tlrSummary' + n + '" role="alert" hidden></div>'
      + inner + '</section>';
  }

  function skeleton() {
    var stepper = '<ol class="tlr-stepper">' + STEPS.map(function (s) {
      return '<li><button type="button" class="tlr-dot" data-goto-step="' + s.n + '" aria-label="Step ' + s.n + ': ' + h(s.title) + '">'
        + '<span class="tlr-dot-n" aria-hidden="true">' + s.n + '</span><span class="tlr-dot-t">' + h(s.short) + '</span></button></li>';
    }).join('') + '</ol>';
    var progress = '<div class="tlr-progress">' + stepper
      + '<div class="tlr-bar" role="progressbar" aria-valuemin="1" aria-valuemax="7" aria-valuenow="1" id="tlrBar" aria-label="Registration progress">'
      + '<i id="tlrBarFill"></i></div><div class="tlr-where" id="tlrWhere">Step 1 of 7 · Basic Details</div></div>'
      + '<div class="tlr-sr" aria-live="polite" id="tlrLive"></div>'
      + '<div class="tlr-restored" id="tlrRestored" hidden></div>';

    var s1 = slot('resume')
      + panel('Personal Information',
        slot('regName')
        + grid(fld({ id: 'regFirstName', label: 'First Name', attrs: ' autocomplete="given-name" maxlength="80"' })
          + fld({ id: 'regMiddleName', label: 'Middle Name', attrs: ' autocomplete="additional-name" maxlength="80"' }))
        + grid(fld({ id: 'regLastName', label: 'Last Name', attrs: ' autocomplete="family-name" maxlength="80"' })
          + fld({ id: 'regDob', label: 'Date of Birth', type: 'date', ai: true, attrs: ' autocomplete="bday"' }))
        + grid(fld({ id: 'regGender', label: 'Gender', select: opts(['Male', 'Female', 'Other', 'Prefer not to say'], 'Select…') })
          + fld({ id: 'regPhotoPick', label: 'Profile Photo', type: 'file', attrs: ' accept=".jpg,.jpeg,.png,image/jpeg,image/png"',
            hint: 'JPG or PNG, up to 2 MB. Optional.', after: '<div class="tlr-photo" id="tlrPhoto"></div>' })))
      + panel('Contact',
        grid(slot('regMobile') + fld({ id: 'regWhatsapp', label: 'WhatsApp Number', type: 'tel',
          ph: '+91 90000 00000', attrs: ' autocomplete="tel" inputmode="tel"',
          after: '<label class="tlr-inline-check"><input type="checkbox" id="regWaSame"> Same as mobile number</label>' }))
        + grid(slot('regEmail') + fld({ id: 'regAltEmail', label: 'Alternate Email', type: 'email', ph: 'another@example.com', attrs: ' autocomplete="off"' })))
      + panel('Location',
        grid(slot('regLocation') + fld({ id: 'regCity', label: 'City', ph: 'e.g. Hyderabad', attrs: ' autocomplete="address-level2"' }))
        + grid(fld({ id: 'regState', label: 'State', ph: 'e.g. Telangana', attrs: ' autocomplete="address-level1"' })
          + fld({ id: 'regCountry', label: 'Country', ph: 'India', attrs: ' autocomplete="country-name" value="India"' })));

    var s2 = panel('Highest Qualification',
      grid(slot('regQualification') + fld({ id: 'regDegree', label: 'Degree / Qualification', ph: 'e.g. B.Tech in Computer Science' }))
      + grid(fld({ id: 'regSpecialization', label: 'Specialization / Branch', req: true, ai: true, ph: 'e.g. Computer Science' })
        + fld({ id: 'regCollege', label: 'College / University', ai: true, ph: 'e.g. JNTU Hyderabad' }))
      + grid(fld({ id: 'regGradYear', label: 'Graduation Year', ai: true, select: yearOptions() })
        + fld({ id: 'regCgpa', label: 'CGPA / Percentage', ph: 'e.g. 8.2 or 78%', attrs: ' inputmode="decimal" maxlength="12"' })))
      + panel('Scores',
        grid(fld({ id: 'regPct10', label: '10th %', ph: 'e.g. 88', attrs: ' inputmode="decimal" maxlength="6"' })
          + fld({ id: 'regPct12', label: '12th %', ph: 'e.g. 82', attrs: ' inputmode="decimal" maxlength="6"' }))
        + grid(fld({ id: 'regPctGrad', label: 'Graduation %', ph: 'e.g. 75', attrs: ' inputmode="decimal" maxlength="6"' })
          + fld({ id: 'regPctPg', label: 'Post Graduation %', ph: 'e.g. 70', attrs: ' inputmode="decimal" maxlength="6"' })));

    var relOpts = [];
    for (var i = 0; i <= 30; i++) relOpts.push([String(i), i === 30 ? '30+ years' : i + (i === 1 ? ' year' : ' years')]);
    var s3 = panel('Experience',
      fld({ id: 'regExpBand', label: 'Total Experience', req: true, ai: true,
        select: opts(BANDS.map(function (b) { return [b[0], b[1]]; }), 'Select…') })
      + grid(slot('regDesignation') + slot('regCompany'))
      + grid(fld({ id: 'regPrevCompany', label: 'Previous Company', ai: true, ph: 'e.g. Wipro' })
        + fld({ id: 'regRelevantExp', label: 'Relevant Experience', ai: true, select: opts(relOpts, 'Select…') }))
      + slot('regSkills') + slot('hidden'))
      + panel('Additional Information',
        grid(fld({ id: 'regLinkedin', label: 'LinkedIn', type: 'url', ai: true, ph: 'https://linkedin.com/in/you', attrs: ' inputmode="url"' })
          + fld({ id: 'regGithub', label: 'GitHub', type: 'url', ai: true, ph: 'https://github.com/you', attrs: ' inputmode="url"' }))
        + grid(fld({ id: 'regPortfolio', label: 'Portfolio Website', type: 'url', ai: true, ph: 'https://…', attrs: ' inputmode="url"' })
          + fld({ id: 'regLanguages', label: 'Languages Known', ai: true, ph: 'e.g. English, Telugu, Hindi' }))
        + fld({ id: 'regCertifications', label: 'Certifications', ai: true, ph: 'e.g. AWS Cloud Practitioner, Tally ERP 9',
          hint: 'Separate them with commas.' })
        + fld({ id: 'regSummary', label: 'Professional Summary', ai: true, textarea: true, rows: 4,
          ph: 'Two or three lines about your experience and what you are looking for.', attrs: ' maxlength="2000"' }));

    var s4 = panel('Job Preferences',
      fld({ id: 'regPrefRole', label: 'Preferred Job Role', req: true, ph: 'e.g. Java Developer, Staff Nurse, Accountant' })
      + slot('regPrefLocation')
      + checkGroup('regEmpType', EMP_TYPES.map(function (t) { return [t, t]; }), 'Preferred Employment Type')
      + slot('regWorkMode')
      + grid(slot('regExpSalary') + fld({ id: 'regCurSalary', label: 'Current Salary (₹ LPA)', type: 'number', ph: 'e.g. 4.5',
        attrs: ' min="0" step="any" inputmode="decimal"' }))
      + grid(slot('regNotice') + '<div class="review-field" data-tlr-field="regRelocate"><fieldset class="tlr-fieldset" id="regRelocateGroup">'
        + '<legend>Willing to Relocate?</legend><div class="opt-row-group">'
        + '<label class="opt-row"><input type="radio" name="regRelocate" value="yes"><span>Yes</span></label>'
        + '<label class="opt-row"><input type="radio" name="regRelocate" value="no"><span>No</span></label>'
        + '</div></fieldset></div>'))
      + panel('Communication',
        checkGroup('regComm', CHANNELS.map(function (c) { return [c[0], c[1], c[0] === 'email']; }), 'Preferred Communication')
        + '<p class="tlr-hint">We only use the channels you tick. You can change this later on your profile.</p>');

    var s5 = panel('Resume / CV',
      '<div id="tlrResumeCard" class="tlr-file-card"></div><div class="field-err" id="regResumeErr" role="status"></div>')
      + panel('Other Documents (optional)',
        '<p class="tlr-hint" style="margin-top:0">Saved to your profile when your account is created. PDF, DOC, DOCX, JPG or PNG, up to 5 MB each.</p>'
        + DOC_KINDS.map(function (d) {
          return '<div class="tlr-doc" data-doc-kind="' + d.kind + '"><div class="tlr-doc-head"><b>' + h(d.label) + '</b>'
            + '<button type="button" class="btn btn-ghost btn-sm" data-doc-add="' + d.kind + '">+ Add ' + (d.max === 1 ? 'file' : 'files') + '</button>'
            + '<input type="file" class="tlr-hidden-input" data-doc-input="' + d.kind + '"' + (d.max > 1 ? ' multiple' : '')
            + ' accept="' + d.ext.map(function (e) { return '.' + e; }).join(',') + '" aria-label="Choose ' + h(d.label) + '"></div>'
            + '<ul class="tlr-doc-list" id="tlrDocs_' + d.kind + '"></ul><div class="field-err" id="tlrDocErr_' + d.kind + '" role="status"></div></div>';
        }).join(''));

    var s6 = panel('Sign-in details',
      '<div class="review-field"><label>Email Address</label><div class="tlr-readonly" id="tlrAcctEmail">—</div>'
      + '<button type="button" class="tlr-link" data-goto-field="regEmail">Change email</button></div>'
      + grid(slot('regPassword') + fld({ id: 'regConfirmPassword', label: 'Confirm Password', req: true, type: 'password',
        ph: 'Type the password again', attrs: ' autocomplete="new-password" maxlength="200"',
        after: '<button type="button" class="tlr-eye" data-eye="regConfirmPassword" aria-label="Show password" aria-pressed="false">Show</button>' }))
      + '<div class="tlr-strength" id="tlrStrength" aria-live="polite"><div class="tlr-meter"><i id="tlrMeter"></i></div><span id="tlrStrengthText">Password strength: —</span></div>'
      + '<ul class="tlr-rules" id="tlrRules">'
      + '<li data-rule="len">At least 8 characters</li><li data-rule="mix">A letter and a number</li>'
      + '<li data-rule="case">Upper and lower case (recommended)</li><li data-rule="sym">A symbol (recommended)</li></ul>');

    var s7 = '<div id="tlrReview" class="tlr-review"></div>'
      + panel('Consent',
        '<label class="consent-row"><input type="checkbox" id="regConsentComms" aria-describedby="regConsentCommsErr"><span>I agree to receive job opportunities and recruitment communication from TeamLink Consultancy. <span class="tlr-req" aria-hidden="true">*</span></span></label>'
        + '<div class="field-err" id="regConsentCommsErr"></div>'
        + slot('cTerms') + '<div class="field-err" id="regConsentTermsErr"></div>'
        + slot('cResume') + '<div class="field-err" id="regConsentResumeErr"></div>'
        + '<p class="tlr-hint" id="tlrConsentNote"></p>')
      + '<div class="tlr-missing" id="tlrMissing" hidden></div>';

    var hp = '<div class="tlr-hp" aria-hidden="true"><label>Website <input id="regWebsite" name="website" tabindex="-1" autocomplete="off"></label></div>';
    var nav = '<div class="tlr-nav"><button type="button" class="btn btn-ghost" id="tlrBack">← Back</button>'
      + '<span class="tlr-nav-sp"></span><button type="button" class="btn btn-primary" id="tlrNext">Continue →</button>'
      + slot('submit') + '</div>';

    return progress + stepSection(1, s1) + stepSection(2, s2) + stepSection(3, s3) + stepSection(4, s4)
      + stepSection(5, s5) + stepSection(6, s6) + stepSection(7, s7) + hp + nav + slot('switch');
  }

  /** Re-arranges the page string. Anything unexpected: the old form, as it was. */
  function restructure(html) {
    if (typeof html !== 'string' || html.indexOf('id="registerForm"') < 0) return html;
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    var root = tpl.content;
    var form = root.querySelector('#registerForm');
    if (!form) return html;
    var byId = function (id) { return root.querySelector('#' + id); };
    var fieldOf = function (id) { var el = byId(id); return el ? (el.closest('.review-field') || null) : null; };

    var take = {};
    ['regName', 'regMobile', 'regLocation', 'regEmail', 'regPassword', 'regQualification', 'regSkills',
      'regCompany', 'regDesignation', 'regTotalExp', 'regPrefLocation', 'regExpSalary', 'regNotice']
      .forEach(function (id) { take[id] = fieldOf(id); });
    take.regWorkMode = fieldOf('regWorkModeGroup');
    var typeRadio = root.querySelector('input[name="regCandidateType"]');
    take.type = typeRadio ? typeRadio.closest('.review-field') : null;
    take.resume = form.querySelector('.ai-panel');
    var row = function (id) { var el = byId(id); return el ? el.closest('.consent-row') : null; };
    take.cTerms = row('regConsentTerms');
    take.cResume = row('regConsentResume');
    take.cWhatsapp = row('regConsentWhatsapp');
    take.submit = byId('regSubmitBtn');
    take.switch = form.querySelector('.switch-role');
    for (var k in take) if (!take[k]) return html;      // not the form this was written for

    form.innerHTML = skeleton();
    form.setAttribute('novalidate', '');
    form.setAttribute('data-tlr', '1');

    /* The hidden helpers: candidate type and exact years are now set from
       Total Experience; the WhatsApp opt-in from Preferred Communication. */
    var hidden = document.createElement('div');
    hidden.className = 'tlr-hidden';
    hidden.setAttribute('aria-hidden', 'true');
    hidden.appendChild(take.type);
    hidden.appendChild(take.regTotalExp);
    hidden.appendChild(take.cWhatsapp);
    take.hidden = hidden;

    Array.prototype.forEach.call(form.querySelectorAll('[data-tlr-slot]'), function (s) {
      var node = take[s.getAttribute('data-tlr-slot')];
      if (node) s.parentNode.replaceChild(node, s); else s.parentNode.removeChild(s);
    });

    /* ---- the existing fields, tidied for the steps ---- */
    var rp = take.resume;
    var rh = rp.querySelector('.panel-head h2');
    if (rh) rh.innerHTML = 'Quick start: upload your resume';
    var btn = rp.querySelector('[onclick*="triggerRegisterResumeUpload"]');
    if (btn) btn.textContent = 'Upload Resume (PDF / DOC / DOCX)';
    var paste = byId('regResumeText');
    if (paste) paste.setAttribute('aria-label', 'Paste your resume text (optional)');
    var stat = byId('regResumeStatus');
    if (stat) { stat.setAttribute('role', 'status'); stat.setAttribute('aria-live', 'polite'); }

    var labels = {
      regName: 'Full Name', regMobile: 'Mobile Number', regLocation: 'Current Location', regEmail: 'Email Address',
      regPassword: 'Password', regQualification: 'Highest Qualification', regSkills: 'Key Skills',
      regCompany: 'Current Company', regDesignation: 'Current Job Title', regPrefLocation: 'Preferred Job Location',
      regExpSalary: 'Expected Salary (₹ LPA)', regNotice: 'Notice Period',
    };
    var required = { regName: 1, regMobile: 1, regLocation: 1, regEmail: 1, regPassword: 1, regQualification: 1,
      regSkills: 1, regPrefLocation: 1, regExpSalary: 1, regNotice: 1 };
    Object.keys(labels).forEach(function (id) {
      var el = byId(id), f = take[id];
      if (!el || !f) return;
      f.style.marginBottom = '';
      f.setAttribute('data-tlr-field', id);
      var lab = f.querySelector('label');
      if (lab) {
        lab.setAttribute('for', id);
        /* The label's own text, keeping the AI tag span inside it. */
        var tag = lab.querySelector('.ai-extracted-tag');
        lab.textContent = labels[id];
        if (required[id]) {
          var star = document.createElement('span');
          star.className = 'tlr-req'; star.setAttribute('aria-hidden', 'true'); star.textContent = ' *';
          lab.appendChild(star);
        }
        if (tag) { lab.appendChild(document.createTextNode(' ')); lab.appendChild(tag); }
      }
      if (required[id]) el.setAttribute('aria-required', 'true');
      el.removeAttribute('required');
      var err = f.querySelector('.field-err');
      if (!err) { err = document.createElement('div'); err.className = 'field-err'; err.id = id + 'Err'; f.appendChild(err); }
      el.setAttribute('aria-describedby', err.id);
    });
    byId('regName').setAttribute('autocomplete', 'name');
    byId('regEmail').setAttribute('autocomplete', 'email');
    byId('regMobile').setAttribute('autocomplete', 'tel');
    byId('regMobile').setAttribute('inputmode', 'tel');
    byId('regMobile').setAttribute('type', 'tel');
    byId('regPassword').setAttribute('autocomplete', 'new-password');
    byId('regPassword').setAttribute('placeholder', 'At least 8 characters, with a letter and a number');
    byId('regPassword').setAttribute('maxlength', '200');
    byId('regExpSalary').removeAttribute('step');

    /* Show / hide on the password. */
    var pw = byId('regPassword');
    var eye = document.createElement('button');
    eye.type = 'button'; eye.className = 'tlr-eye'; eye.setAttribute('data-eye', 'regPassword');
    eye.setAttribute('aria-label', 'Show password'); eye.setAttribute('aria-pressed', 'false'); eye.textContent = 'Show';
    pw.parentNode.insertBefore(eye, pw.nextSibling);

    /* Skills and preferred locations: the text box stays the record; the
       chips show it as tags. */
    var sk = take.regSkills;
    sk.insertAdjacentHTML('beforeend', '<div class="tlr-hint" id="regSkillsHint">Separate skills with commas, or press Enter after each one.</div>'
      + '<div class="tlr-chips" id="regSkillsChips" aria-label="Key skills added"></div>');
    byId('regSkills').setAttribute('aria-describedby', 'regSkillsErr regSkillsHint');
    var pl = take.regPrefLocation;
    pl.insertAdjacentHTML('beforeend', '<div class="tlr-hint" id="regPrefLocationHint">Choose one or more, or type others separated by commas.</div>'
      + '<div class="tlr-picks" role="group" aria-label="Quick picks">' + CITIES.concat([ANY_LOCATION]).map(function (c) {
        return '<button type="button" class="tlr-pick" data-pick-loc="' + h(c) + '" aria-pressed="false">' + h(c) + '</button>';
      }).join('') + '</div><div class="tlr-chips" id="regPrefLocationChips" aria-label="Preferred locations added"></div>');
    byId('regPrefLocation').setAttribute('aria-describedby', 'regPrefLocationErr regPrefLocationHint');

    /* The owner's qualification list first; the older, longer list kept
       under it so nothing a candidate could pick before has gone. */
    var q = byId('regQualification');
    q.innerHTML = opts(QUALS, 'Select…') + '<optgroup label="More qualifications">' + opts(MORE_QUALS) + '</optgroup>' + opts(['Other']);

    /* Notice: 45 days and Other, as asked. */
    var nt = byId('regNotice');
    nt.innerHTML = opts(['Immediate', '15 days', '30 days', '45 days', '60 days', '90 days', 'Other'], 'Select…');
    take.regNotice.insertAdjacentHTML('beforeend', '<div id="regNoticeOtherWrap" hidden><label for="regNoticeOther" class="tlr-sub">Your notice period</label>'
      + '<input id="regNoticeOther" maxlength="40" placeholder="e.g. 4 months" aria-describedby="regNoticeOtherErr"><div class="field-err" id="regNoticeOtherErr"></div></div>');

    /* The work-mode group: a fieldset name for screen readers. */
    var wm = byId('regWorkModeGroup');
    if (wm) { wm.setAttribute('role', 'group'); wm.setAttribute('aria-label', 'Preferred Work Mode'); wm.setAttribute('aria-describedby', 'regWorkModeErr'); }
    var wl = take.regWorkMode.querySelector('label');
    if (wl && !wl.querySelector('input')) wl.textContent = 'Preferred Work Mode *';

    /* The terms line: the owner's words. Links are added once settings load. */
    var terms = take.cTerms.querySelector('span');
    if (terms) terms.innerHTML = 'I agree to the <span id="tlrTermsLink">Terms &amp; Conditions</span> and <span id="tlrPrivacyLink">Privacy Policy</span>. <span class="tlr-req" aria-hidden="true">*</span>';
    byId('regConsentTerms').setAttribute('aria-describedby', 'regConsentTermsErr');
    var rs = take.cResume.querySelector('span');
    if (rs) rs.innerHTML = 'I consent to my resume being processed for recruitment. <span class="tlr-req" aria-hidden="true">*</span>';
    byId('regConsentResume').setAttribute('aria-describedby', 'regConsentResumeErr');

    take.submit.textContent = 'Create Account';
    take.submit.classList.remove('btn-block');
    take.submit.removeAttribute('style');
    take.submit.hidden = true;

    var out = '';
    Array.prototype.forEach.call(root.childNodes, function (n) {
      out += n.nodeType === 1 ? n.outerHTML : n.nodeType === 3 ? h(n.textContent) : '';
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 2. the rules, in the owner's words
   * ------------------------------------------------------------------ */
  function passwordProblem(p) {
    p = String(p || '');
    if (!p) return 'Please create a password.';
    if (p.length < 8) return 'Password must be at least 8 characters.';
    if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'Password must contain at least one letter and one number.';
    return null;
  }
  function pctProblem(id) {
    var t = val(id).replace('%', '');
    if (!t) return null;
    var n = Number(t);
    return isFinite(n) && n >= 0 && n <= 100 ? null : 'Please enter a percentage between 0 and 100.';
  }
  function urlProblem(id) {
    var t = val(id);
    if (!t) return null;
    return /^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(t) ? null : 'Please enter a valid link, e.g. https://linkedin.com/in/you';
  }
  function checked(sel) { return [].slice.call(document.querySelectorAll(sel)).filter(function (x) { return x.checked; }); }
  function emailTakenHint(em) {
    try { return typeof window.candidateEmailTaken === 'function' && window.candidateEmailTaken(em); } catch (e) { return false; }
  }
  function serverSays(id) {
    var s = S.server[id];
    if (!s) return null;
    var now = id === 'regResume' ? (MEM.resume ? MEM.resume.name : '') : val(id);
    if (s.value === now) return s.msg;
    delete S.server[id];
    return null;
  }

  /** Every problem on the form: [{id, step, msg}] */
  function problems() {
    var out = [];
    var add = function (id, step, msg) { if (msg) out.push({ id: id, step: step, msg: msg }); };
    /* 1 */
    add('regName', 1, val('regName').length < 2 ? 'Please enter your full name.' : serverSays('regName'));
    var mob = mobileDigits(val('regMobile'));
    add('regMobile', 1, !mob ? 'Please enter your mobile number.'
      : !/^[6-9]\d{9}$/.test(mob) ? 'Please enter a valid 10-digit mobile number.'
      : S.dup.phone[mob] ? 'An account with this mobile number already exists.' : serverSays('regMobile'));
    var em = val('regEmail').toLowerCase();
    add('regEmail', 1, !em ? 'Please enter your email address.'
      : !EMAIL_RX.test(em) ? 'Please enter a valid email address.'
      : (S.dup.email[em] || emailTakenHint(em)) ? 'An account with this email already exists. Please Login.'
      : serverSays('regEmail'));
    var wa = val('regWhatsapp');
    add('regWhatsapp', 1, wa && !/^[6-9]\d{9}$/.test(mobileDigits(wa)) ? 'Please enter a valid 10-digit WhatsApp number.' : null);
    var alt = val('regAltEmail').toLowerCase();
    add('regAltEmail', 1, alt && !EMAIL_RX.test(alt) ? 'Please enter a valid email address.'
      : alt && alt === em ? 'Your alternate email must be different from your email address.' : null);
    var dob = val('regDob');
    if (dob) {
      var d = new Date(dob + 'T00:00:00'), age = (Date.now() - d.getTime()) / 31557600000;
      add('regDob', 1, !/^\d{4}-\d{2}-\d{2}$/.test(dob) || isNaN(age) || age < 14 || age > 80 ? 'Please enter a valid date of birth.' : null);
    }
    add('regLocation', 1, !val('regLocation') ? 'Please enter your current location.' : null);
    add('regPhotoPick', 1, MEM.photoErr || null);
    /* 2 */
    add('regQualification', 2, !val('regQualification') ? 'Please select your highest qualification.' : null);
    add('regSpecialization', 2, !val('regSpecialization') ? 'Please enter your specialization / branch.' : null);
    var cg = val('regCgpa').replace('%', '');
    if (cg) {
      var n = Number(cg);
      add('regCgpa', 2, !isFinite(n) || n < 0 || n > 100 ? 'Please enter a CGPA (out of 10) or a percentage.' : null);
    }
    ['regPct10', 'regPct12', 'regPctGrad', 'regPctPg'].forEach(function (id) { add(id, 2, pctProblem(id)); });
    /* 3 */
    add('regExpBand', 3, !val('regExpBand') ? 'Please select your total experience.' : null);
    add('regSkills', 3, !list(val('regSkills')).length ? 'Please add at least one key skill.' : null);
    var rel = val('regRelevantExp'), band = BANDS.filter(function (b) { return b[0] === val('regExpBand'); })[0];
    if (rel && band && band[0] === 'fresher' && Number(rel) > 0) {
      add('regRelevantExp', 3, 'A fresher has no relevant experience - choose 0 or change Total Experience.');
    }
    ['regLinkedin', 'regGithub', 'regPortfolio'].forEach(function (id) { add(id, 3, urlProblem(id)); });
    /* 4 */
    add('regPrefRole', 4, !val('regPrefRole') ? 'Please enter your preferred job role.' : null);
    add('regPrefLocation', 4, !list(val('regPrefLocation')).length ? 'Please choose at least one preferred job location.'
      : val('regPrefLocation').length > 160 ? 'Please choose fewer locations.' : serverSays('regPrefLocation'));
    var sal = val('regExpSalary'), sn = Number(sal);
    add('regExpSalary', 4, !sal ? 'Please enter your expected salary.'
      : !isFinite(sn) || sn <= 0 ? 'Expected Salary must be more than 0.'
      : sn > 1000 ? 'Please enter the salary in lakh per annum (e.g. 6.5).' : serverSays('regExpSalary'));
    var cur = val('regCurSalary');
    add('regCurSalary', 4, cur && (!isFinite(Number(cur)) || Number(cur) < 0 || Number(cur) > 1000)
      ? 'Please enter the salary in lakh per annum (e.g. 4.5).' : null);
    add('regNotice', 4, !val('regNotice') ? 'Please select a notice period.' : null);
    add('regNoticeOther', 4, val('regNotice') === 'Other' && !val('regNoticeOther') ? 'Please tell us your notice period.' : null);
    add('regWorkMode', 4, !checked('#regWorkModeGroup input[type="checkbox"]').length ? 'Select at least one work mode.' : null);
    /* 5 */
    add('regResume', 5, MEM.resumeErr || (!MEM.resume ? 'Please upload your resume.' : null));
    /* 6 */
    add('regPassword', 6, passwordProblem($('regPassword') ? $('regPassword').value : '') || serverSays('regPassword'));
    var p1 = $('regPassword') ? $('regPassword').value : '', p2 = $('regConfirmPassword') ? $('regConfirmPassword').value : '';
    add('regConfirmPassword', 6, !p2 ? 'Please confirm your password.' : p1 !== p2 ? 'Passwords do not match.' : null);
    /* 7 */
    add('regConsentComms', 7, !($('regConsentComms') || {}).checked ? 'Please agree to receive recruitment communication from TeamLink.' : null);
    add('regConsentTerms', 7, !($('regConsentTerms') || {}).checked ? 'Please accept the Terms & Conditions and Privacy Policy.' : null);
    add('regConsentResume', 7, !($('regConsentResume') || {}).checked ? 'Please consent to your resume being processed for recruitment.' : null);
    return out;
  }

  var FIELD_LABEL = {
    regName: 'Full Name', regMobile: 'Mobile Number', regEmail: 'Email Address', regWhatsapp: 'WhatsApp Number',
    regAltEmail: 'Alternate Email', regDob: 'Date of Birth', regLocation: 'Current Location', regPhotoPick: 'Profile Photo',
    regQualification: 'Highest Qualification', regSpecialization: 'Specialization / Branch', regCgpa: 'CGPA / Percentage',
    regPct10: '10th %', regPct12: '12th %', regPctGrad: 'Graduation %', regPctPg: 'Post Graduation %',
    regExpBand: 'Total Experience', regSkills: 'Key Skills', regRelevantExp: 'Relevant Experience',
    regLinkedin: 'LinkedIn', regGithub: 'GitHub', regPortfolio: 'Portfolio Website',
    regPrefRole: 'Preferred Job Role', regPrefLocation: 'Preferred Job Location', regExpSalary: 'Expected Salary',
    regCurSalary: 'Current Salary', regNotice: 'Notice Period', regNoticeOther: 'Notice period', regWorkMode: 'Preferred Work Mode',
    regResume: 'Resume', regPassword: 'Password', regConfirmPassword: 'Confirm Password',
    regConsentComms: 'Communication consent', regConsentTerms: 'Terms & Privacy Policy', regConsentResume: 'Resume processing consent',
  };
  var FIELD_STEP = {};
  /* where an error is shown, and which element is "the field" */
  function errEl(id) { return $(id + 'Err'); }
  function ctlOf(id) {
    if (id === 'regWorkMode') return $('regWorkModeGroup');
    if (id === 'regResume') return $('tlrResumeCard');
    return $(id);
  }
  function focusTarget(id) {
    if (id === 'regWorkMode') return document.querySelector('#regWorkModeGroup input');
    if (id === 'regResume') return document.querySelector('#tlrResumeCard button');
    return $(id);
  }
  function shown(p) { return S.submitTried || S.attempted[p.step] || S.touched[p.id]; }

  /** Paint every field's state; returns the problem list. */
  function paint() {
    if (!$('tlrStep1')) return [];
    var probs = problems();
    var bad = {};
    probs.forEach(function (p) { bad[p.id] = p; FIELD_STEP[p.id] = p.step; });
    Object.keys(FIELD_LABEL).forEach(function (id) {
      var e = errEl(id), c = ctlOf(id), p = bad[id];
      var show = !!(p && shown(p));
      if (e) { e.textContent = show ? p.msg : ''; e.classList.toggle('show', show); }
      if (c) {
        c.classList.toggle('reg-bad', show);
        if (c.tagName === 'INPUT' || c.tagName === 'SELECT' || c.tagName === 'TEXTAREA') {
          if (show) c.setAttribute('aria-invalid', 'true'); else c.removeAttribute('aria-invalid');
        }
      }
    });
    /* the stepper */
    STEPS.forEach(function (s) {
      var b = document.querySelector('[data-goto-step="' + s.n + '"]');
      if (!b) return;
      var errs = probs.filter(function (p) { return p.step === s.n; }).length;
      var li = b.parentNode;
      li.classList.toggle('on', s.n === S.step);
      li.classList.toggle('done', s.n < S.maxStep && !errs);
      li.classList.toggle('warn', !!(errs && (S.attempted[s.n] || S.submitTried) && s.n !== S.step));
      if (s.n === S.step) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      b.setAttribute('aria-label', 'Step ' + s.n + ': ' + s.title + (s.n < S.maxStep && !errs ? ', complete' : errs && S.attempted[s.n] ? ', needs attention' : ''));
    });
    var btn = $('regSubmitBtn');
    if (btn) {
      var dis = probs.length > 0 || S.submitting;
      btn.disabled = dis;
      btn.setAttribute('aria-disabled', String(dis));
      btn.textContent = S.submitting ? 'Creating account…' : 'Create Account';
      if (S.submitting) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy');
    }
    if (S.step === 7) paintMissing(probs);
    return probs;
  }

  function paintMissing(probs) {
    var box = $('tlrMissing');
    if (!box) return;
    if (!probs.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '<b>Still needed before you can create your account:</b><ul>' + probs.map(function (p) {
      return '<li><button type="button" class="tlr-link" data-goto-field="' + p.id + '">' + h(FIELD_LABEL[p.id] || p.id)
        + '</button> <span>(' + h(STEPS[p.step - 1].short) + ') - ' + h(p.msg) + '</span></li>';
    }).join('') + '</ul>';
  }

  /* ------------------------------------------------------------------ *
   * 3. moving between steps
   * ------------------------------------------------------------------ */
  function showStep(n, focus) {
    n = Math.max(1, Math.min(7, n));
    S.step = n;
    if (n > S.maxStep) S.maxStep = n;
    for (var i = 1; i <= 7; i++) { var sec = $('tlrStep' + i); if (sec) sec.hidden = i !== n; }
    var st = STEPS[n - 1];
    var bar = $('tlrBar');
    if (bar) { bar.setAttribute('aria-valuenow', String(n)); bar.setAttribute('aria-valuetext', 'Step ' + n + ' of 7: ' + st.title); }
    var fill = $('tlrBarFill');
    if (fill) fill.style.width = Math.round((n - 1) / 6 * 100) + '%';
    var where = $('tlrWhere');
    if (where) where.textContent = 'Step ' + n + ' of 7 · ' + st.title;
    var back = $('tlrBack'), next = $('tlrNext'), sub = $('regSubmitBtn');
    if (back) back.hidden = n === 1;
    if (next) next.hidden = n === 7;
    if (sub) sub.hidden = n !== 7;
    if (n === 6) { var ae = $('tlrAcctEmail'); if (ae) ae.textContent = val('regEmail') || '—'; }
    if (n === 7) paintReview();
    if (n === 5) paintResumeCard();
    var sum = $('tlrSummary' + n);
    if (sum && !S.attempted[n]) sum.hidden = true;
    paint();
    saveDraftSoon();
    if (focus !== false) {
      var head = $('tlrStepH' + n);
      if (head) {
        try { head.focus({ preventScroll: true }); } catch (e) { head.focus(); }
        try { ($('tlrStep' + n) || head).scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) {}
      }
      announce('Step ' + n + ' of 7: ' + st.title);
    }
  }

  function stepProblems(n) { return problems().filter(function (p) { return p.step === n; }); }

  function showSummary(n, probs) {
    var sum = $('tlrSummary' + n);
    if (!sum) return;
    if (!probs.length) { sum.hidden = true; sum.innerHTML = ''; return; }
    sum.hidden = false;
    sum.innerHTML = '<b>' + (probs.length === 1 ? 'Please fix 1 field' : 'Please fix ' + probs.length + ' fields')
      + ' before continuing:</b><ul>' + probs.map(function (p) {
        return '<li><button type="button" class="tlr-link" data-goto-field="' + p.id + '">' + h(FIELD_LABEL[p.id] || p.id)
          + '</button>: ' + h(p.msg) + '</li>';
      }).join('') + '</ul>';
  }

  function focusField(id) {
    var step = FIELD_STEP[id] || (problems().filter(function (p) { return p.id === id; })[0] || {}).step || stepOfField(id);
    if (step && step !== S.step) showStep(step, false);
    var t = focusTarget(id);
    if (t) {
      try { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
      try { t.focus({ preventScroll: true }); } catch (e) { try { t.focus(); } catch (e2) {} }
    }
  }
  function stepOfField(id) {
    var el = $(id) || ctlOf(id);
    var sec = el && el.closest ? el.closest('.tlr-step') : null;
    return sec ? Number(sec.getAttribute('data-step')) : 0;
  }

  function goNext() {
    var n = S.step;
    S.attempted[n] = true;
    var probs = stepProblems(n);
    paint();
    if (probs.length) {
      showSummary(n, probs);
      focusField(probs[0].id);
      return false;
    }
    showSummary(n, []);
    showStep(n + 1);
    return true;
  }

  function goTo(n) {
    n = Number(n);
    if (!n || n === S.step) return;
    if (n < S.step || n <= S.maxStep) { showStep(n); return; }
    /* Forward past where they have been: only through valid steps. */
    for (var i = S.step; i < n; i++) {
      if (stepProblems(i).length) {
        if (i !== S.step) showStep(i, false);
        S.attempted[i] = true;
        var probs = stepProblems(i);
        paint(); showSummary(i, probs); focusField(probs[0].id);
        return;
      }
    }
    showStep(n);
  }

  /* ------------------------------------------------------------------ *
   * 4. the parts with behaviour
   * ------------------------------------------------------------------ */
  function renderChips(id) {
    var box = $(id + 'Chips');
    if (!box) return;
    var items = list(val(id));
    /* Rebuilt only when the list really changed: replacing a chip under
       the pointer between mousedown and mouseup loses the click. */
    var sig = items.join('|');
    if (box.getAttribute('data-sig') === sig && box.childNodes.length === items.length) return paintPicks(id, items);
    box.setAttribute('data-sig', sig);
    box.innerHTML = items.map(function (x) {
      return '<span class="tlr-chip">' + h(x) + '<button type="button" data-chip-remove="' + id + '" data-chip-value="' + h(x)
        + '" aria-label="Remove ' + h(x) + '">×</button></span>';
    }).join('');
    paintPicks(id, items);
  }
  function paintPicks(id, items) {
    if (id === 'regPrefLocation') {
      Array.prototype.forEach.call(document.querySelectorAll('[data-pick-loc]'), function (b) {
        var on = items.some(function (x) { return x.toLowerCase() === b.getAttribute('data-pick-loc').toLowerCase(); });
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('on', on);
      });
    }
  }
  function setListValue(id, items) {
    var el = $(id);
    if (!el) return;
    el.value = items.join(', ');
    el.dataset.userSet = '1';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function pickLocation(name) {
    var items = list(val('regPrefLocation'));
    var has = items.some(function (x) { return x.toLowerCase() === name.toLowerCase(); });
    if (has) items = items.filter(function (x) { return x.toLowerCase() !== name.toLowerCase(); });
    else if (name === ANY_LOCATION) items = [ANY_LOCATION];
    else items = items.filter(function (x) { return x !== ANY_LOCATION; }).concat([name]);
    S.touched.regPrefLocation = true;
    setListValue('regPrefLocation', items);
    if (typeof window.regTouch === 'function') { try { window.regTouch('regPrefLocation'); } catch (e) {} }
  }

  function syncBandToType() {
    var b = val('regExpBand');
    if (!b) return;
    var band = BANDS.filter(function (x) { return x[0] === b; })[0];
    var type = b === 'fresher' ? 'fresher' : 'experienced';
    var radio = document.querySelector('input[name="regCandidateType"][value="' + type + '"]');
    if (radio && !radio.checked) {
      radio.checked = true;
      radio.dataset.userSet = '1';
      if (typeof window.onCandidateTypeChange === 'function') window.onCandidateTypeChange(type);
    }
    var te = $('regTotalExp');
    if (te && band) {
      var cur = Number(te.value || 0);
      var lo = band[2], hiN = { '0-1': 1, '1-2': 2, '2-3': 3, '3-5': 5, '5-8': 8, '8+': 99, fresher: 0 }[b];
      /* An exact figure from the resume that sits inside the band is kept. */
      if (!(cur >= lo && cur <= hiN)) te.value = String(Math.min(10, lo));
    }
  }
  function bandForYears(y) {
    y = Number(y);
    if (!isFinite(y)) return '';
    if (y <= 0) return '0-1';
    if (y < 1) return '0-1';
    if (y < 2) return '1-2';
    if (y < 3) return '2-3';
    if (y < 5) return '3-5';
    if (y < 8) return '5-8';
    return '8+';
  }

  function strength() {
    var p = $('regPassword') ? $('regPassword').value : '';
    var rules = {
      len: p.length >= 8, mix: /[A-Za-z]/.test(p) && /\d/.test(p),
      case: /[a-z]/.test(p) && /[A-Z]/.test(p), sym: /[^A-Za-z0-9]/.test(p),
    };
    Array.prototype.forEach.call(document.querySelectorAll('#tlrRules [data-rule]'), function (li) {
      li.classList.toggle('ok', !!rules[li.getAttribute('data-rule')]);
    });
    var score = !p ? 0 : (rules.len && rules.mix ? 2 : 1) + (rules.case ? 1 : 0) + (rules.sym ? 1 : 0) + (p.length >= 12 ? 1 : 0);
    var label = !p ? '—' : score <= 1 ? 'Weak' : score === 2 ? 'Fair' : score === 3 ? 'Good' : 'Strong';
    var m = $('tlrMeter');
    if (m) { m.style.width = (score * 20) + '%'; m.className = 'tlr-m' + score; }
    var t = $('tlrStrengthText');
    if (t) t.textContent = 'Password strength: ' + label;
  }

  /* ---- the resume (step 5) ---- */
  function paintResumeCard() {
    var card = $('tlrResumeCard');
    if (!card) return;
    var f = MEM.resume;
    if (f) {
      card.innerHTML = '<div class="tlr-file-ok"><span class="tlr-file-ic" aria-hidden="true">📄</span><div class="tlr-file-t"><b>'
        + h(f.name) + ' <span class="tlr-tick" aria-label="uploaded">✓</span></b><span>' + h(sizeText(f.size))
        + ' · uploaded to your profile when your account is created</span></div></div>'
        + '<div class="tlr-file-acts"><button type="button" class="btn btn-ghost btn-sm" data-resume="replace">Replace</button>'
        + '<button type="button" class="btn btn-ghost btn-sm" data-resume="download">Download</button>'
        + '<button type="button" class="btn btn-ghost btn-sm tlr-danger" data-resume="remove">Remove</button></div>';
    } else {
      card.innerHTML = '<div class="tlr-file-empty"><span class="tlr-file-ic" aria-hidden="true">📄</span><div class="tlr-file-t"><b>No resume yet</b>'
        + '<span>PDF, DOC or DOCX, up to ' + h(sizeText(RESUME_MAX)) + '. TeamLink reads it and fills your profile.</span></div></div>'
        + '<div class="tlr-file-acts"><button type="button" class="btn btn-primary btn-sm" data-resume="replace">Upload Resume</button></div>';
    }
  }

  /* ---- documents and photo (kept in memory, uploaded after creation) ---- */
  function paintDocs() {
    DOC_KINDS.forEach(function (d) {
      var ul = $('tlrDocs_' + d.kind);
      if (!ul) return;
      ul.innerHTML = MEM.docs[d.kind].map(function (f, i) {
        return '<li><span>' + h(f.name) + ' <small>' + h(sizeText(f.size)) + '</small></span>'
          + '<button type="button" class="tlr-link tlr-danger" data-doc-remove="' + d.kind + '" data-doc-index="' + i + '" aria-label="Remove ' + h(f.name) + '">Remove</button></li>';
      }).join('');
      var e = $('tlrDocErr_' + d.kind);
      if (e) { e.textContent = MEM.docErr[d.kind] || ''; e.classList.toggle('show', !!MEM.docErr[d.kind]); }
    });
  }
  function addDocs(kind, files) {
    var d = DOC_KINDS.filter(function (x) { return x.kind === kind; })[0];
    if (!d) return;
    var errs = [];
    [].slice.call(files || []).forEach(function (f) {
      var ext = extOf(f.name);
      if (d.ext.indexOf(ext) < 0) { errs.push('"' + f.name + '": please upload ' + d.ext.filter(function (e) { return e !== 'jpeg'; }).map(function (e) { return e.toUpperCase(); }).join(', ') + '.'); return; }
      if (f.size > DOC_MAX) { errs.push('"' + f.name + '" is larger than ' + sizeText(DOC_MAX) + '.'); return; }
      if (MEM.docs[kind].length >= d.max) { errs.push(d.max === 1 ? 'Only one ' + d.label.toLowerCase() + ' - remove it first to choose another.' : 'You can add up to ' + d.max + ' files here.'); return; }
      MEM.docs[kind].push(f);
    });
    MEM.docErr[kind] = errs.join(' ');
    paintDocs();
    if (errs.length) announce(errs.join(' '));
  }
  function setPhoto(f) {
    MEM.photoErr = '';
    if (f) {
      var ext = extOf(f.name);
      if (['jpg', 'jpeg', 'png'].indexOf(ext) < 0) { MEM.photoErr = 'Please choose a JPG or PNG photo.'; f = null; }
      else if (f.size > PHOTO_MAX) { MEM.photoErr = 'Your photo must be ' + sizeText(PHOTO_MAX) + ' or smaller.'; f = null; }
    }
    MEM.photo = f || null;
    S.touched.regPhotoPick = true;
    paintPhoto();
    paint();
  }
  function paintPhoto() {
    var box = $('tlrPhoto');
    if (!box) return;
    if (!MEM.photo) { box.innerHTML = ''; return; }
    var url = '';
    try { url = URL.createObjectURL(MEM.photo); } catch (e) {}
    box.innerHTML = (url ? '<img src="' + url + '" alt="Your profile photo preview">' : '')
      + '<span>' + h(MEM.photo.name) + '</span><button type="button" class="tlr-link tlr-danger" data-photo-remove="1">Remove</button>';
  }

  /* ---- review (step 7) ---- */
  function shownValue(id) {
    var el = $(id);
    if (!el) return '';
    if (el.tagName === 'SELECT') { var o = el.options[el.selectedIndex]; return o && o.value ? o.text : ''; }
    return String(el.value || '').trim();
  }
  function paintReview() {
    var box = $('tlrReview');
    if (!box) return;
    var groupVals = function (name) { return checked('input[name="' + name + '"]').map(function (x) { return x.value; }).join(', '); };
    var comm = checked('input[name="regComm"]').map(function (x) {
      return (CHANNELS.filter(function (c) { return c[0] === x.value; })[0] || [0, x.value])[1];
    }).join(', ');
    var reloc = (document.querySelector('input[name="regRelocate"]:checked') || {}).value;
    var docsCount = DOC_KINDS.reduce(function (n, d) { return n + MEM.docs[d.kind].length; }, 0);
    var rows = [
      [1, [['Full Name', shownValue('regName')], ['Date of Birth', shownValue('regDob')], ['Gender', shownValue('regGender')],
        ['Mobile', shownValue('regMobile')], ['WhatsApp', shownValue('regWhatsapp')], ['Email', shownValue('regEmail')],
        ['Alternate Email', shownValue('regAltEmail')], ['Current Location', shownValue('regLocation')],
        ['City / State / Country', [shownValue('regCity'), shownValue('regState'), shownValue('regCountry')].filter(Boolean).join(', ')],
        ['Profile Photo', MEM.photo ? MEM.photo.name : '']]],
      [2, [['Highest Qualification', shownValue('regQualification')], ['Degree', shownValue('regDegree')],
        ['Specialization / Branch', shownValue('regSpecialization')], ['College / University', shownValue('regCollege')],
        ['Graduation Year', shownValue('regGradYear')], ['CGPA / Percentage', shownValue('regCgpa')],
        ['10th / 12th %', [shownValue('regPct10'), shownValue('regPct12')].filter(Boolean).join(' / ')],
        ['Graduation / PG %', [shownValue('regPctGrad'), shownValue('regPctPg')].filter(Boolean).join(' / ')]]],
      [3, [['Total Experience', shownValue('regExpBand')], ['Current Job Title', shownValue('regDesignation')],
        ['Current Company', shownValue('regCompany')], ['Previous Company', shownValue('regPrevCompany')],
        ['Relevant Experience', shownValue('regRelevantExp')], ['Key Skills', list(val('regSkills')).join(', ')],
        ['LinkedIn', shownValue('regLinkedin')], ['GitHub', shownValue('regGithub')], ['Portfolio', shownValue('regPortfolio')],
        ['Certifications', shownValue('regCertifications')], ['Languages', shownValue('regLanguages')],
        ['Summary', shownValue('regSummary')]]],
      [4, [['Preferred Job Role', shownValue('regPrefRole')], ['Preferred Job Location', list(val('regPrefLocation')).join(', ')],
        ['Employment Type', groupVals('regEmpType')],
        ['Work Mode', checked('#regWorkModeGroup input[type="checkbox"]').map(function (x) { return x.value; }).join(', ')],
        ['Expected Salary', val('regExpSalary') ? '₹' + val('regExpSalary') + ' LPA' : ''],
        ['Current Salary', val('regCurSalary') ? '₹' + val('regCurSalary') + ' LPA' : ''],
        ['Notice Period', val('regNotice') === 'Other' ? val('regNoticeOther') : shownValue('regNotice')],
        ['Willing to Relocate', reloc === 'yes' ? 'Yes' : reloc === 'no' ? 'No' : ''],
        ['Looking for a job', shownValue('regAvailability')], ['Message language', shownValue('regPrefLang')],
        ['Preferred Communication', comm]]],
      [5, [['Resume', MEM.resume ? MEM.resume.name + ' ✓' : ''], ['Other documents', docsCount ? docsCount + ' file' + (docsCount === 1 ? '' : 's') : '']]],
      [6, [['Sign-in email', shownValue('regEmail')], ['Password', ($('regPassword') || {}).value ? '•••••••• (set)' : '']]],
    ];
    box.innerHTML = rows.map(function (r) {
      var st = STEPS[r[0] - 1];
      var items = r[1].filter(function (x) { return x[1]; });
      return '<div class="panel tlr-panel tlr-rev"><div class="panel-head"><h3>' + h(st.title) + '</h3>'
        + '<button type="button" class="btn btn-ghost btn-sm" data-goto-step="' + st.n + '" aria-label="Edit ' + h(st.title) + '">Edit</button></div>'
        + '<div class="panel-body"><dl class="tlr-dl">' + (items.length ? items.map(function (x) {
          return '<dt>' + h(x[0]) + '</dt><dd>' + h(x[1]) + '</dd>';
        }).join('') : '<dt>—</dt><dd>Nothing entered</dd>') + '</dl></div></div>';
    }).join('');
  }

  function paintTermsLinks() {
    var s = S.settings || {};
    var t = $('tlrTermsLink'), p = $('tlrPrivacyLink'), note = $('tlrConsentNote');
    if (t && s.termsUrl && !t.querySelector('a')) t.innerHTML = '<a href="' + h(s.termsUrl) + '" target="_blank" rel="noopener">Terms &amp; Conditions</a>';
    if (p && s.privacyPolicyUrl && !p.querySelector('a')) p.innerHTML = '<a href="' + h(s.privacyPolicyUrl) + '" target="_blank" rel="noopener">Privacy Policy</a>';
    if (note) note.textContent = s.consentVersion ? 'Terms and Privacy Policy version ' + (s.privacyPolicyVersion || s.consentVersion)
      + '. What you agree to is recorded with its date and this version.' : '';
  }

  /* ------------------------------------------------------------------ *
   * 5. the draft (this device only; text only; never the password)
   * ------------------------------------------------------------------ */
  var NEVER = { regPassword: 1, regConfirmPassword: 1, regWebsite: 1, regPhotoPick: 1, regResumeFileInput: 1 };
  function collectDraft() {
    var form = $('registerForm');
    if (!form) return null;
    var fields = {};
    Array.prototype.forEach.call(form.querySelectorAll('input, select, textarea'), function (el) {
      if (el.type === 'file' || el.type === 'password' || NEVER[el.id]) return;
      if (el.type === 'checkbox' || el.type === 'radio') {
        var grp = el.closest('[id]');
        var key = el.id || ((el.name || (grp && grp.id) || '') + '=' + el.value);
        if (key) fields['c:' + key] = !!el.checked;
        return;
      }
      if (el.id) fields['v:' + el.id] = String(el.value || '').slice(0, 4000);
    });
    return { v: 1, at: Date.now(), step: S.step, maxStep: S.maxStep, fields: fields,
      resumeName: MEM.resume ? MEM.resume.name : '' };
  }
  var draftTimer = null;
  function saveDraftSoon() {
    if (S.done) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 250);
  }
  function saveDraft() {
    if (S.done || !onRegisterPage()) return;
    var d = collectDraft();
    if (!d) return;
    var any = Object.keys(d.fields).some(function (k) {
      return k.charAt(0) === 'v' && d.fields[k] && k !== 'v:regCountry' && k !== 'v:regResumeText';
    });
    if (!any) return;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch (e) { /* storage off: nothing to keep */ }
  }
  function readDraft() {
    try {
      var d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (!d || d.v !== 1 || !d.fields || !(Date.now() - Number(d.at) < DRAFT_TTL)) return null;
      return d;
    } catch (e) { return null; }
  }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) {} }

  function applyDraft(d) {
    var form = $('registerForm');
    if (!form || !d) return false;
    Object.keys(d.fields).forEach(function (k) {
      var kind = k.charAt(0), key = k.slice(2), v = d.fields[k];
      if (kind === 'v') {
        var el = $(key);
        if (!el || NEVER[key] || el.type === 'file' || el.type === 'password') return;
        el.value = v;
        if (v) el.dataset.userSet = '1';
      } else if (kind === 'c') {
        var cb = $(key);
        if (!cb && key.indexOf('=') > 0) {
          var nm = key.split('=')[0], vv = key.slice(nm.length + 1);
          var q = '[value="' + (window.CSS && CSS.escape ? CSS.escape(vv) : vv) + '"]';
          cb = form.querySelector('input[name="' + nm + '"]' + q) || form.querySelector('#' + nm + ' input' + q);
        }
        if (cb) {
          cb.checked = !!v;
          var row = cb.closest('.opt-row');
          if (row) row.classList.toggle('active', !!v);
        }
      }
    });
    var type = (form.querySelector('input[name="regCandidateType"]:checked') || {}).value;
    if (type && typeof window.onCandidateTypeChange === 'function') { try { window.onCandidateTypeChange(type); } catch (e) {} }
    return true;
  }

  /* What a re-render of this page would otherwise throw away. */
  var carry = null;
  function snapshotBeforeRender() {
    if (!$('tlrStep1') || S.done) return;
    carry = collectDraft();
    MEM.pw = ($('regPassword') || {}).value || '';
    MEM.pw2 = ($('regConfirmPassword') || {}).value || '';
    carry.statusHtml = ($('regResumeStatus') || {}).outerHTML || '';
    carry.fileName = ($('regFileName') || {}).textContent || '';
    carry.extras = window.STATE ? STATE.regResumeExtras : null;
    carry.edu = window.STATE ? STATE.regEdu : null;
    carry.tags = {};
    Array.prototype.forEach.call(document.querySelectorAll('#registerForm .ai-extracted-tag'), function (t) {
      if (t.id && t.style.display !== 'none' && !t.classList.contains('pending')) carry.tags[t.id] = t.textContent;
    });
  }

  /* ------------------------------------------------------------------ *
   * 6. after the page is on screen
   * ------------------------------------------------------------------ */
  function afterRender() {
    if (!onRegisterPage() || !$('tlrStep1') || $('registerForm').getAttribute('data-tlr-live')) return;
    $('registerForm').setAttribute('data-tlr-live', '1');
    settings();
    css();

    if (S.done) {
      clearDraft();
      var f = $('registerForm');
      if (f) f.innerHTML = '<div class="panel"><div class="panel-body" role="status" aria-live="polite" style="text-align:center;padding:28px">'
        + '<b>Creating your account…</b><p class="tlr-hint">Saving your profile, resume and documents. This takes a few seconds.</p></div></div>';
      return;
    }

    var restoredFrom = null;
    if (carry) {
      applyDraft(carry);
      if (MEM.pw && $('regPassword')) $('regPassword').value = MEM.pw;
      if (MEM.pw2 && $('regConfirmPassword')) $('regConfirmPassword').value = MEM.pw2;
      if (carry.fileName && $('regFileName')) $('regFileName').textContent = carry.fileName;
      if (carry.statusHtml && $('regResumeStatus')) $('regResumeStatus').outerHTML = carry.statusHtml;
      Object.keys(carry.tags || {}).forEach(function (id) { var t = $(id); if (t) { t.textContent = carry.tags[id]; t.style.display = ''; } });
      if (window.STATE) {
        if (carry.extras && !STATE.regResumeExtras) STATE.regResumeExtras = carry.extras;
        if (carry.edu && !STATE.regEdu) STATE.regEdu = carry.edu;
      }
      S.step = carry.step || S.step;
      lateFields(carry);
      carry = null;
    } else {
      var d = readDraft();
      if (d) {
        applyDraft(d);
        lateFields(d);
        S.step = Math.min(d.step || 1, 7);
        S.maxStep = Math.max(S.maxStep, Math.min(d.maxStep || 1, 7));
        restoredFrom = d;
      } else {
        S.step = 1; S.maxStep = 1;
      }
    }
    if (MEM.resume && $('regFileName') && !$('regFileName').textContent) $('regFileName').textContent = '📎 ' + MEM.resume.name;

    if (restoredFrom) S.restored = restoredFrom;
    restoredFrom = S.restored;
    var r = $('tlrRestored');
    if (r && restoredFrom) {
      var when = new Date(restoredFrom.at);
      r.hidden = false;
      r.innerHTML = '<span>We kept what you had entered on this device on ' + h(when.toLocaleString()) + '.'
        + (restoredFrom.resumeName && !MEM.resume ? ' Please upload your resume again - files are not kept.' : '')
        + ' Passwords are never saved.</span>'
        + '<button type="button" class="tlr-link" data-tlr-startover="1">Start over</button>';
    }
    Array.prototype.forEach.call(document.querySelectorAll('#registerForm .opt-row input'), function (x) {
      x.closest('.opt-row').classList.toggle('active', !!x.checked);
    });
    if ($('regWaSame') && $('regWaSame').checked) syncWhatsapp();
    var nt = $('regNotice');
    if (nt && $('regNoticeOtherWrap')) $('regNoticeOtherWrap').hidden = nt.value !== 'Other';
    renderChips('regSkills');
    renderChips('regPrefLocation');
    paintDocs();
    paintPhoto();
    paintResumeCard();
    strength();
    paintTermsLinks();
    showStep(S.step, false);
  }

  /* Availability (0092) and language (0102) add their selects a moment
     after the page paints; their saved answers are put back once they exist. */
  function lateFields(d) {
    var want = {};
    ['regAvailability', 'regPrefLang'].forEach(function (id) {
      if (d && d.fields && d.fields['v:' + id] !== undefined) want[id] = d.fields['v:' + id];
    });
    if (!Object.keys(want).length) return;
    var tries = 0;
    (function again() {
      var left = 0;
      Object.keys(want).forEach(function (id) {
        var el = $(id);
        if (el) { if (want[id]) el.value = want[id]; delete want[id]; } else left++;
      });
      if (left && ++tries < 20) setTimeout(again, 100);
    })();
  }

  function syncWhatsapp() {
    var same = $('regWaSame'), wa = $('regWhatsapp');
    if (!same || !wa) return;
    if (same.checked) { wa.value = val('regMobile'); wa.readOnly = true; wa.setAttribute('aria-readonly', 'true'); }
    else { wa.readOnly = false; wa.removeAttribute('aria-readonly'); }
  }

  /* First / middle / last from the full name, while they have not typed them. */
  function splitName() {
    var parts = val('regName').split(/\s+/).filter(Boolean);
    var set = function (id, v) { var el = $(id); if (el && el.dataset.userSet !== '1') el.value = v; };
    if (!parts.length) return;
    set('regFirstName', parts[0]);
    set('regLastName', parts.length > 1 ? parts[parts.length - 1] : '');
    set('regMiddleName', parts.length > 2 ? parts.slice(1, -1).join(' ') : '');
  }

  /* The inline "already an account?" check. */
  var dupTimer = null, dupAsked = {};
  function checkDuplicate(which) {
    var a = api();
    if (!a) return;
    var em = val('regEmail').toLowerCase(), mob = mobileDigits(val('regMobile'));
    var body = {};
    if (which === 'email' && EMAIL_RX.test(em)) body.email = em;
    if (which === 'phone' && /^[6-9]\d{9}$/.test(mob)) body.phone = mob;
    var key = which + ':' + (body.email || body.phone || '');
    if (!body.email && !body.phone || dupAsked[key]) return;
    dupAsked[key] = true;
    clearTimeout(dupTimer);
    dupTimer = setTimeout(function () {
      a.post('/auth/register/check', body).then(function (r) {
        if (body.email) S.dup.email[body.email] = !!(r && r.emailTaken);
        if (body.phone) S.dup.phone[body.phone] = !!(r && r.phoneTaken);
        if ((r && r.emailTaken) || (r && r.phoneTaken)) {
          S.touched[body.email ? 'regEmail' : 'regMobile'] = true;
          announce(body.email ? 'An account with this email already exists. Please Login.' : 'An account with this mobile number already exists.');
        }
        paint();
      }, function () { dupAsked[key] = false; /* the server will say so at Create Account */ });
    }, 150);
  }

  /* ------------------------------------------------------------------ *
   * 7. events (delegated once, so a re-render needs nothing re-bound)
   * ------------------------------------------------------------------ */
  function inForm(t) { return t && t.closest && t.closest('#registerForm[data-tlr]'); }

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!inForm(t)) return;
    if (t.id && e.isTrusted !== false) t.dataset.userSet = '1';
    if (t.id === 'regName') splitName();
    if (t.id === 'regMobile' && $('regWaSame') && $('regWaSame').checked) syncWhatsapp();
    if (t.id === 'regSkills' || t.id === 'regPrefLocation') renderChips(t.id);
    if (t.id === 'regPassword' || t.id === 'regConfirmPassword') strength();
    if (t.id === 'regEmail') { var ae = $('tlrAcctEmail'); if (ae) ae.textContent = val('regEmail') || '—'; }
    paint();
    saveDraftSoon();
  }, true);

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!inForm(t)) return;
    if (t.id) { t.dataset.userSet = '1'; S.touched[t.id] = true; }
    if (t.id === 'regExpBand') syncBandToType();
    if (t.id === 'regNotice' && $('regNoticeOtherWrap')) $('regNoticeOtherWrap').hidden = t.value !== 'Other';
    if (t.id === 'regWaSame') syncWhatsapp();
    if (t.id === 'regPhotoPick') { setPhoto(t.files && t.files[0]); t.value = ''; }
    if (t.getAttribute('data-doc-input')) { addDocs(t.getAttribute('data-doc-input'), t.files); t.value = ''; }
    if (t.name === 'regWorkModeGroup' || (t.closest && t.closest('#regWorkModeGroup'))) S.touched.regWorkMode = true;
    if (t.type === 'checkbox' && t.closest('.opt-row')) t.closest('.opt-row').classList.toggle('active', t.checked);
    if (t.name === 'regRelocate') {
      Array.prototype.forEach.call(document.querySelectorAll('input[name="regRelocate"]'), function (r) {
        r.closest('.opt-row').classList.toggle('active', r.checked);
      });
    }
    if (t.name === 'regComm') {
      var wa = $('regConsentWhatsapp');
      if (wa) wa.checked = !!document.querySelector('input[name="regComm"][value="whatsapp"]:checked');
    }
    /* A text box's change fires as it loses focus - the same moment as a
       click elsewhere - so its message waits (see focusout). */
    if (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !/^(checkbox|radio|file)$/.test(t.type))) {
      clearTimeout(blurPaint);
      blurPaint = setTimeout(paint, 180);
    } else paint();
    saveDraftSoon();
  }, true);

  document.addEventListener('focusout', function (e) {
    var t = e.target;
    if (!inForm(t) || !t.id) return;
    if (String(t.value || '').trim() || t.dataset.userSet === '1') S.touched[t.id] = true;
    if (t.id === 'regEmail') checkDuplicate('email');
    if (t.id === 'regMobile') checkDuplicate('phone');
    if (t.id === 'regSkills' || t.id === 'regPrefLocation') {
      var items = list(t.value);
      if (items.join(', ') !== String(t.value || '').trim()) { t.value = items.join(', '); renderChips(t.id); }
    }
    /* Painted a moment later, not now: a message appearing as the field
       loses focus pushes the buttons below it down between mousedown and
       mouseup, and the click on Continue lands on nothing. */
    clearTimeout(blurPaint);
    blurPaint = setTimeout(paint, 180);
  }, true);
  var blurPaint = null;

  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (!inForm(t) || e.key !== 'Enter' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.tagName === 'A') return;
    if (t.id === 'regSkills' || t.id === 'regPrefLocation') {
      e.preventDefault();
      var items = list(t.value);
      t.value = items.length ? items.join(', ') + ', ' : '';
      renderChips(t.id);
      return;
    }
    if (S.step < 7) { e.preventDefault(); goNext(); }
  }, true);

  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('button, a') : null;
    if (!t) return;
    if (t.getAttribute('data-tlr-ok')) { successAction(t.getAttribute('data-tlr-ok')); return; }
    if (!inForm(t)) return;
    if (t.closest('#regMissingKeys')) {
      var mk = /getElementById\('(\w+)'\)/.exec(t.getAttribute('onclick') || '');
      if (mk) { var sn = stepOfField(mk[1]); if (sn && sn !== S.step) showStep(sn, false); }
      return;
    }
    if (t.id === 'tlrNext') { e.preventDefault(); goNext(); return; }
    if (t.id === 'tlrBack') { e.preventDefault(); showStep(S.step - 1); return; }
    if (t.getAttribute('data-goto-step')) { e.preventDefault(); goTo(t.getAttribute('data-goto-step')); return; }
    if (t.getAttribute('data-goto-field')) { e.preventDefault(); focusField(t.getAttribute('data-goto-field')); return; }
    if (t.getAttribute('data-chip-remove')) {
      var id = t.getAttribute('data-chip-remove'), v = t.getAttribute('data-chip-value');
      S.touched[id] = true;
      setListValue(id, list(val(id)).filter(function (x) { return x !== v; }));
      var el = $(id); if (el) el.focus();
      return;
    }
    if (t.getAttribute('data-pick-loc')) { pickLocation(t.getAttribute('data-pick-loc')); return; }
    if (t.getAttribute('data-eye')) {
      var f = $(t.getAttribute('data-eye'));
      if (!f) return;
      var show = f.type === 'password';
      f.type = show ? 'text' : 'password';
      t.textContent = show ? 'Hide' : 'Show';
      t.setAttribute('aria-pressed', String(show));
      t.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      return;
    }
    if (t.getAttribute('data-doc-add')) {
      var inp = document.querySelector('[data-doc-input="' + t.getAttribute('data-doc-add') + '"]');
      if (inp) inp.click();
      return;
    }
    if (t.getAttribute('data-doc-remove')) {
      var k = t.getAttribute('data-doc-remove');
      MEM.docs[k].splice(Number(t.getAttribute('data-doc-index')), 1);
      MEM.docErr[k] = '';
      paintDocs();
      announce('File removed.');
      return;
    }
    if (t.getAttribute('data-photo-remove')) { setPhoto(null); return; }
    if (t.getAttribute('data-resume')) {
      var what = t.getAttribute('data-resume');
      if (what === 'replace' && typeof window.triggerRegisterResumeUpload === 'function') window.triggerRegisterResumeUpload();
      if (what === 'download' && MEM.resume) {
        try {
          var url = URL.createObjectURL(MEM.resume), a = document.createElement('a');
          a.href = url; a.download = MEM.resume.name; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        } catch (er) { /* nothing to download */ }
      }
      if (what === 'remove') removeResume();
      return;
    }
    if (t.getAttribute('data-tlr-startover')) { startOver(); }
  }, true);

  /* Steps 1-6: Enter or a stray submit moves on instead of submitting.
     Step 7: the real submit, once, and only when the form is complete. */
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || f.id !== 'registerForm' || !f.getAttribute('data-tlr')) return;
    if (S.step < 7) { e.preventDefault(); e.stopPropagation(); goNext(); return; }
    if (S.submitting) { e.preventDefault(); e.stopPropagation(); return; }
    S.submitTried = true;
    var probs = paint();
    if (probs.length) {
      e.preventDefault(); e.stopPropagation();
      paintMissing(probs);
      showSummary(probs[0].step, probs.filter(function (p) { return p.step === probs[0].step; }));
      focusField(probs[0].id);
      announce('Please fix ' + probs.length + (probs.length === 1 ? ' field' : ' fields') + ' before creating your account.');
    }
  }, true);

  function removeResume() {
    MEM.resume = null; MEM.resumeErr = '';
    if (window.TL) TL.pendingResume = null;
    if (window.STATE) { STATE.regResumeFile = null; }
    var fn = $('regFileName'); if (fn) fn.textContent = '';
    var st = $('regResumeStatus'); if (st) { st.style.display = 'none'; st.textContent = ''; }
    S.touched.regResume = true;
    paintResumeCard();
    paint();
    announce('Resume removed.');
  }

  function startOver() {
    clearDraft();
    MEM.pw = MEM.pw2 = ''; MEM.resume = null; MEM.resumeErr = ''; MEM.photo = null; MEM.photoErr = '';
    MEM.docs = { cover_letter: [], certificate: [], marksheet: [], experience_letter: [] }; MEM.docErr = {};
    if (window.TL) TL.pendingResume = null;
    S.step = 1; S.maxStep = 1; S.touched = {}; S.attempted = {}; S.submitTried = false; S.server = {};
    carry = null;
    if (typeof window.render === 'function') window.render();
    setTimeout(function () { var x = $('regName'); if (x) x.focus(); }, 80);
  }

  /* ------------------------------------------------------------------ *
   * 8. the resume upload: type and size first, then the existing parser
   * ------------------------------------------------------------------ */
  function wrapResume() {
    var prev = window.handleRegisterResumeFile;
    if (typeof prev !== 'function' || prev.__tlr) return;
    var next = function (file) {
      if (!file) return prev.apply(this, arguments);
      var setStatus = window.setResumeStatus || function () {};
      S.touched.regResume = true;
      if (RESUME_EXT.indexOf(extOf(file.name)) < 0) {
        MEM.resumeErr = 'Please upload your resume as a PDF, DOC or DOCX file.';
        setStatus('error', '"' + file.name + '" is not a PDF, DOC or DOCX file. Please upload your resume in one of those formats.');
        paintResumeCard(); paint(); announce(MEM.resumeErr);
        return undefined;
      }
      if (file.size > RESUME_MAX) {
        MEM.resumeErr = 'Your resume must be ' + sizeText(RESUME_MAX) + ' or smaller.';
        setStatus('error', '"' + file.name + '" is ' + sizeText(file.size) + '. ' + MEM.resumeErr);
        paintResumeCard(); paint(); announce(MEM.resumeErr);
        return undefined;
      }
      MEM.resumeErr = '';
      MEM.resume = file;
      paintResumeCard();
      paint();
      var out = prev.apply(this, arguments);
      Promise.resolve(out).then(afterExtraction, afterExtraction);
      return out;
    };
    next.__tlr = true;
    window.handleRegisterResumeFile = next;

    var prevA = window.analyzeRegisterResumeText;
    if (typeof prevA === 'function' && !prevA.__tlr) {
      var na = function () {
        var out = prevA.apply(this, arguments);
        Promise.resolve(out).then(afterExtraction, afterExtraction);
        return out;
      };
      na.__tlr = true;
      window.analyzeRegisterResumeText = na;
    }

    /* The qualification the parser names, in the owner's list. */
    var prevF = window.applyExtractedField;
    if (typeof prevF === 'function' && !prevF.__tlr) {
      var nf = function (fieldId, tagId, raw) {
        var args = [].slice.call(arguments);
        if (fieldId === 'regQualification' && raw) {
          var k = String(raw).trim().toLowerCase();
          var sel = $('regQualification');
          var direct = sel && [].some.call(sel.options, function (o) { return o.value.toLowerCase() === k; });
          if (!direct && QUAL_ALIAS[k]) args[2] = QUAL_ALIAS[k];
        }
        if (fieldId === 'regTotalExp') {
          var r = prevF.apply(this, args);
          var band = $('regExpBand');
          if (band && band.dataset.userSet !== '1' && raw !== '' && raw != null) {
            prevF.call(this, 'regExpBand', 'regExpBandAiTag', bandForYears(raw));
            syncBandToType();
          }
          return r;
        }
        return prevF.apply(this, args);
      };
      nf.__tlr = true;
      window.applyExtractedField = nf;
    }
  }

  /** What the resume said that has a box on these steps now. */
  function afterExtraction() {
    if (!$('tlrStep1')) return;
    var put = function (id, v) {
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
      if (typeof window.applyExtractedField === 'function') {
        window.applyExtractedField(id, id + 'AiTag', Array.isArray(v) ? v.join(', ') : String(v));
      }
    };
    var x = (window.STATE && STATE.regResumeExtras) || {};
    var edu = (window.STATE && STATE.regEdu) || {};
    put('regLinkedin', x.linkedin);
    put('regGithub', x.github);
    put('regPortfolio', x.portfolio);
    put('regCertifications', x.certifications);
    put('regLanguages', x.languages);
    put('regSummary', x.summary);
    put('regPrevCompany', (x.previousCompanies || [])[0]);
    if (x.relevantExpYears != null && x.relevantExpYears !== '') put('regRelevantExp', String(Math.min(30, Math.round(Number(x.relevantExpYears)))));
    if (x.currentSalary && isFinite(Number(String(x.currentSalary).replace(/[^\d.]/g, '')))) {
      put('regCurSalary', String(x.currentSalary).replace(/[^\d.]/g, ''));
    }
    var dob = String(x.dob || '');
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob) || null;
    var m2 = !m && /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(dob);
    if (m) put('regDob', m[0]);
    else if (m2) put('regDob', m2[3] + '-' + ('0' + m2[2]).slice(-2) + '-' + ('0' + m2[1]).slice(-2));
    put('regSpecialization', edu.spec);
    put('regCollege', edu.institute);
    if (edu.year) put('regGradYear', String(edu.year));
    splitName();
    renderChips('regSkills');
    renderChips('regPrefLocation');
    if (typeof window.validateRegisterForm === 'function') window.validateRegisterForm();
    saveDraftSoon();
  }

  /* ------------------------------------------------------------------ *
   * 9. validateRegisterForm: the base rules still run (they paint and
   *    keep their own state); the answer is this form's complete rule set.
   * ------------------------------------------------------------------ */
  function wrapValidate() {
    var prev = window.validateRegisterForm;
    if (typeof prev !== 'function' || prev.__tlr) return;
    var next = function () {
      var base;
      try { base = prev.apply(this, arguments); } catch (e) { base = false; }
      if (!$('tlrStep1')) return base;
      return paint().length === 0;
    };
    next.__tlr = true;
    window.validateRegisterForm = next;
  }

  /* ------------------------------------------------------------------ *
   * 10. what goes to the server with, and straight after, the registration
   * ------------------------------------------------------------------ */
  function num(v) { var n = Number(String(v || '').replace(/[^\d.]/g, '')); return isFinite(n) && String(v || '').trim() !== '' ? n : undefined; }

  function collectExtras() {
    var out = {};
    var put = function (k, v) { if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) out[k] = v; };
    put('firstName', val('regFirstName').slice(0, 80));
    put('middleName', val('regMiddleName').slice(0, 80));
    put('lastName', val('regLastName').slice(0, 80));
    if (/^\d{4}-\d{2}-\d{2}$/.test(val('regDob'))) put('dateOfBirth', val('regDob'));
    put('gender', val('regGender'));
    put('whatsappNumber', val('regWhatsapp') ? mobileDigits(val('regWhatsapp')) : '');
    if (EMAIL_RX.test(val('regAltEmail'))) put('altEmail', val('regAltEmail').toLowerCase());
    put('city', val('regCity').slice(0, 120));
    put('state', val('regState').slice(0, 120));
    put('country', val('regCountry').slice(0, 80));

    var bandId = val('regExpBand');
    var band = BANDS.filter(function (b) { return b[0] === bandId; })[0];
    if (band) {
      put('candidateType', bandId === 'fresher' ? 'fresher' : 'experienced');
      put('exp', bandId === 'fresher' ? 'Fresher' : band[1].replace('years', 'yrs'));
      var exact = Number(val('regTotalExp'));
      out.expYears = bandId === 'fresher' ? 0 : (isFinite(exact) && exact >= band[2] ? exact : band[2]);
    }
    if (val('regRelevantExp') !== '') out.relevantExpYears = Number(val('regRelevantExp'));
    var prevCo = val('regPrevCompany');
    var extras = (window.STATE && STATE.regResumeExtras) || {};
    var prevList = (extras.previousCompanies || []).slice(0, 39);
    if (prevCo) prevList = [prevCo].concat(prevList.filter(function (x) { return String(x).toLowerCase() !== prevCo.toLowerCase(); }));
    put('previousCompanies', prevList.map(function (x) { return String(x).slice(0, 160); }).slice(0, 40));
    put('skills', list(val('regSkills')).map(function (x) { return x.slice(0, 120); }).slice(0, 100));
    put('certifications', list(val('regCertifications')).map(function (x) { return x.slice(0, 200); }).slice(0, 60));
    put('languages', list(val('regLanguages')).map(function (x) { return x.slice(0, 60); }).slice(0, 30));
    put('linkedin', val('regLinkedin').slice(0, 300));
    put('github', val('regGithub').slice(0, 300));
    put('portfolio', val('regPortfolio').slice(0, 300));
    put('summary', val('regSummary').slice(0, 2000));

    put('preferredRole', val('regPrefRole').slice(0, 160));
    put('preferredEmploymentTypes', checked('input[name="regEmpType"]').map(function (x) { return x.value; }));
    var cur = num(val('regCurSalary'));
    if (cur !== undefined) put('ctc', String(cur) + ' LPA');
    if (val('regNotice') === 'Other' && val('regNoticeOther')) put('noticePeriod', val('regNoticeOther').slice(0, 40));
    var reloc = (document.querySelector('input[name="regRelocate"]:checked') || {}).value;
    if (reloc) out.willingToRelocate = reloc === 'yes';

    var ch = checked('input[name="regComm"]').map(function (x) { return x.value; });
    out.emailOptIn = ch.indexOf('email') >= 0;
    out.smsOptIn = ch.indexOf('sms') >= 0;
    out.whatsappOptIn = ch.indexOf('whatsapp') >= 0;
    out.preferredContactMethod = ch.join(',');

    /* Education: the highest qualification as one row, the school scores as
       rows of their own - the shape candidate_education already holds. */
    var qual = val('regQualification');
    var rows = [];
    if (qual) {
      rows.push({
        qualification: (val('regDegree') || shownValue('regQualification')).slice(0, 160),
        specialization: val('regSpecialization').slice(0, 160),
        institution: val('regCollege').slice(0, 200),
        passingYear: val('regGradYear') ? Number(val('regGradYear')) : null,
        score: val('regCgpa').slice(0, 40),
        educationType: '',
      });
    }
    var scoreRow = function (label, id) {
      var s = val(id).replace('%', '');
      if (s) rows.push({ qualification: label, specialization: '', institution: '', passingYear: null, score: s + '%', educationType: '' });
    };
    scoreRow('Post Graduation', 'regPctPg');
    scoreRow('Graduation', 'regPctGrad');
    scoreRow('12th', 'regPct12');
    scoreRow('10th', 'regPct10');
    if (rows.length) out.educationRecords = rows;
    if (qual) {
      var deg = val('regDegree') || shownValue('regQualification');
      var spec = val('regSpecialization');
      if (spec && deg.toLowerCase().indexOf(spec.toLowerCase()) >= 0) spec = '';
      var line = [deg, spec, val('regCollege'), val('regGradYear')].filter(Boolean).join(', ');
      put('education', line.slice(0, 400));
    }
    var lang = val('regPrefLang');
    if (lang === 'te' || lang === 'hi' || lang === 'en') out.preferredLanguage = lang;
    return out;
  }

  /** The server's answer, against the field it is about. */
  var SERVER_FIELD = {
    name: 'regName', email: 'regEmail', phone: 'regMobile', password: 'regPassword', confirmPassword: 'regConfirmPassword',
    preferredLocation: 'regPrefLocation', expectedCtc: 'regExpSalary', noticePeriod: 'regNotice',
    preferredWorkModes: 'regWorkMode', 'consent.terms': 'regConsentTerms', 'consent.communication': 'regConsentComms',
  };
  function noteServerErrors(err) {
    if (!err) return;
    var first = null;
    if (err.code === 'EMAIL_TAKEN') { S.dup.email[val('regEmail').toLowerCase()] = true; first = 'regEmail'; }
    if (err.code === 'PHONE_TAKEN') { S.dup.phone[mobileDigits(val('regMobile'))] = true; first = first || 'regMobile'; }
    var d = err.details || {};
    Object.keys(d).forEach(function (k) {
      var id = SERVER_FIELD[k];
      if (!id) return;
      /* A duplicate is already explained by the flags above. */
      if ((k === 'email' && err.code === 'EMAIL_TAKEN') || (k === 'phone' && err.code === 'PHONE_TAKEN')) return;
      S.server[id] = { msg: d[k], value: id === 'regWorkMode' ? '' : val(id) };
      first = first || id;
    });
    S.submitTried = true;
    if (first) {
      setTimeout(function () {
        var probs = paint();
        var p = probs.filter(function (x) { return x.id === first; })[0] || probs[0];
        if (p) {
          showSummary(p.step, probs.filter(function (x) { return x.step === p.step; }));
          focusField(p.id);
          announce(p.msg);
        }
      }, 60);
    } else {
      setTimeout(paint, 60);
    }
  }

  function uploadQueued(candidateId) {
    var a = api();
    var jobs = [];
    if (MEM.photo) jobs.push({ kind: 'photo', file: MEM.photo });
    DOC_KINDS.forEach(function (d) { MEM.docs[d.kind].forEach(function (f) { jobs.push({ kind: d.kind, file: f }); }); });
    var result = { saved: 0, failed: [] };
    if (!a || !jobs.length) return Promise.resolve(result);
    var path = '/candidates/' + encodeURIComponent(candidateId) + '/documents';
    return jobs.reduce(function (p, j) {
      return p.then(function () {
        var fd = new FormData();
        fd.append('kind', j.kind);
        fd.append('document', j.file, j.file.name);
        return a.post(path, fd, { timeout: 60000 }).then(function () { result.saved++; },
          function (err) { result.failed.push({ name: j.file.name, message: (err && err.message) || 'could not be saved' }); });
      });
    }, Promise.resolve()).then(function () {
      MEM.photo = null;
      MEM.docs = { cover_letter: [], certificate: [], marksheet: [], experience_letter: [] };
      return result;
    });
  }

  function wrapApi() {
    var a = api();
    if (!a || a.__tlr) return;
    var post = a.post, put = a.put;
    a.post = function (path, body, o) {
      /* Only the form's own submission: the email and password it carries
         are the ones on screen. A script posting its own account is left alone. */
      if (path === '/auth/register' && body && typeof body === 'object' && !(body instanceof FormData) && $('regConfirmPassword')
          && String(body.email || '').toLowerCase() === val('regEmail').toLowerCase()
          && body.password === ($('regPassword') || {}).value) {
        body = Object.assign({}, body, {
          confirmPassword: ($('regConfirmPassword') || {}).value || '',
          consent: {
            terms: !!($('regConsentTerms') || {}).checked,
            communication: !!($('regConsentComms') || {}).checked,
            resumeProcessing: !!($('regConsentResume') || {}).checked,
          },
          website: val('regWebsite'),
        });
        if (val('regNotice') === 'Other' && val('regNoticeOther')) body.noticePeriod = val('regNoticeOther').slice(0, 40);
        var extras = collectExtras();
        S.submitting = true;
        paint();
        return post.call(this, path, body, o).then(function (res) {
          S.submitting = false;
          S.done = true;
          clearDraft();
          MEM.pw = MEM.pw2 = '';
          REG = { candidateId: res.candidateId, code: res.candidateCode || '', extras: extras, shown: false };
          REG.uploads = uploadQueued(res.candidateId);
          /* If the rest of the chain stalls, the account still exists: take
             them to it rather than leaving "Creating your account…". */
          var mine = REG;
          setTimeout(function () {
            if (REG === mine && !mine.shown && isCandidate()) window.navigate('/candidate/home');
          }, 30000);
          return res;
        }, function (err) {
          S.submitting = false;
          noteServerErrors(err);
          throw err;
        });
      }
      return post.apply(this, arguments);
    };
    a.put = function (path, body, o) {
      if (REG && REG.extras && path === '/candidates/' + encodeURIComponent(REG.candidateId)) {
        var extras = REG.extras, self = this;
        REG.extras = null;
        var merged = Object.assign({}, body || {}, extras);
        return put.call(self, path, merged, o).catch(function (err) {
          if (!err || Number(err.status) !== 400) throw err;
          /* Never lose the whole profile over one field: what the form
             always sent, then ours without whatever was refused. */
          var refused = Object.keys(err.details || {}).map(function (k) { return k.split('.')[0]; });
          var rest = {};
          Object.keys(extras).forEach(function (k) { if (refused.indexOf(k) < 0) rest[k] = extras[k]; });
          return put.call(self, path, body || {}, o).then(function (r) {
            if (!Object.keys(rest).length) return r;
            return put.call(self, path, rest, o).catch(function () { return r; });
          });
        });
      }
      return put.apply(this, arguments);
    };
    a.__tlr = true;
  }

  /* ------------------------------------------------------------------ *
   * 11. "Registration Successful"
   * ------------------------------------------------------------------ */
  function wrapNavigate() {
    var prev = window.navigate;
    if (typeof prev !== 'function' || prev.__tlr) return;
    var next = function (path) {
      if (REG && !REG.shown && isCandidate() && /^\/?candidate(\/|$)/.test(String(path || ''))) {
        REG.shown = true;
        var applying = !!(window.TLApplyAuth && typeof TLApplyAuth.intent === 'function' && TLApplyAuth.intent());
        var out = prev.apply(this, arguments);
        showSuccess(applying);
        resetForm();
        return out;
      }
      return prev.apply(this, arguments);
    };
    next.__tlr = true;
    window.navigate = next;
  }

  /** A fresh form for whoever registers next in this tab. */
  function resetForm() {
    var settingsKept = S.settings;
    S = { step: 1, maxStep: 1, touched: {}, attempted: {}, submitTried: false, submitting: false,
      dup: { email: {}, phone: {} }, server: {}, settings: settingsKept, restored: null, done: false };
    MEM = { pw: '', pw2: '', resume: null, resumeErr: '', photo: null, photoErr: '',
      docs: { cover_letter: [], certificate: [], marksheet: [], experience_letter: [] }, docErr: {} };
    carry = null;
  }

  var lastFocus = null;
  function showSuccess(applying) {
    css();
    var old = $('tlrOk');
    if (old) old.remove();
    var code = (REG && REG.code) || ((me() || {}).candidateCode) || '';
    var wrap = document.createElement('div');
    wrap.id = 'tlrOk';
    if (applying) {
      /* An application is continuing: say it, and stay out of its way. */
      wrap.className = 'tlr-ok-toast';
      wrap.setAttribute('role', 'status');
      wrap.innerHTML = '<div class="tlr-ok-ic" aria-hidden="true">✓</div><div class="tlr-ok-tt"><b>Registration Successful</b>'
        + '<span>Welcome to TeamLink! Candidate ID: <b>' + h(code) + '</b>. Your profile has been created successfully - your application continues now.</span>'
        + '<span class="tlr-ok-docs" id="tlrOkDocs"></span></div>'
        + '<button type="button" class="tlr-x" data-tlr-ok="close" aria-label="Close">✕</button>';
      document.body.appendChild(wrap);
      setTimeout(function () { var w = $('tlrOk'); if (w && w.className === 'tlr-ok-toast') w.remove(); }, 15000);
    } else {
      wrap.className = 'tlr-ok-ov';
      wrap.innerHTML = '<div class="tlr-ok-card" role="dialog" aria-modal="true" aria-labelledby="tlrOkH" aria-describedby="tlrOkD">'
        + '<div class="tlr-ok-ic big" aria-hidden="true">✓</div>'
        + '<h2 id="tlrOkH" tabindex="-1">Registration Successful</h2>'
        + '<p class="tlr-ok-welcome">Welcome to TeamLink!</p>'
        + '<div class="tlr-ok-id">Candidate ID: <b id="tlrOkCode">' + h(code) + '</b>'
        + '<button type="button" class="tlr-link" data-tlr-ok="copy" aria-label="Copy Candidate ID">Copy</button></div>'
        + '<p id="tlrOkD">Your profile has been created successfully.</p>'
        + '<p class="tlr-ok-docs" id="tlrOkDocs" aria-live="polite"></p>'
        + '<div class="tlr-ok-acts"><button type="button" class="btn btn-primary" data-tlr-ok="profile">Complete Profile</button>'
        + '<button type="button" class="btn btn-ghost" data-tlr-ok="jobs">Search Jobs</button></div></div>';
      document.body.appendChild(wrap);
      lastFocus = document.activeElement;
      setTimeout(function () { var hd = $('tlrOkH'); if (hd) hd.focus(); }, 30);
      wrap.addEventListener('keydown', trapFocus);
    }
    if (REG && REG.uploads) {
      var docs = $('tlrOkDocs');
      if (docs) docs.textContent = '';
      REG.uploads.then(function (r) {
        var el = $('tlrOkDocs');
        if (!el) return;
        var bits = [];
        if (r.saved) bits.push(r.saved + (r.saved === 1 ? ' file' : ' files') + ' saved to your profile.');
        if (r.failed.length) bits.push(r.failed.length + ' could not be saved (' + r.failed.map(function (f) { return f.name; }).join(', ') + ') - add them again from your profile.');
        el.textContent = bits.join(' ');
      });
    }
  }
  function trapFocus(e) {
    if (e.key === 'Escape') { successAction('close'); return; }
    if (e.key !== 'Tab') return;
    var card = document.querySelector('#tlrOk .tlr-ok-card');
    if (!card) return;
    var f = [].slice.call(card.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])')).filter(function (x) { return !x.disabled; });
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }
  function successAction(what) {
    if (what === 'copy') {
      var c = ($('tlrOkCode') || {}).textContent || '';
      try { navigator.clipboard.writeText(c).then(function () { say('Candidate ID copied', '✓'); }); } catch (e) { /* copy unsupported */ }
      return;
    }
    var w = $('tlrOk');
    if (w) w.remove();
    if (what === 'profile') window.navigate('/candidate/profile');
    else if (what === 'jobs') window.navigate('/candidate/search');
    else if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    lastFocus = null;
  }

  /* ------------------------------------------------------------------ *
   * 12. the profile: Candidate ID, Documents, Your data
   * ------------------------------------------------------------------ */
  var P = { docs: null, loading: false, err: '', busy: '', privacy: null, confirm: '', delOpen: false, msg: '' };

  function loadDocs(force) {
    var c = me();
    if (!c || !api() || (P.loading && !force)) return;
    P.loading = true;
    api().get('/candidates/' + encodeURIComponent(c.id) + '/documents').then(function (r) {
      P.docs = (r && r.documents) || []; P.err = '';
    }, function (e) { P.err = (e && e.message) || 'Your documents could not be loaded.'; P.docs = P.docs || []; })
      .then(function () { P.loading = false; paintProfileDocs(); });
  }
  function loadPrivacy() {
    if (!api() || !isCandidate()) return;
    api().get('/me/privacy').then(function (r) { P.privacy = r || {}; paintPrivacy(); }, function () { P.privacy = { error: true }; paintPrivacy(); });
  }

  function profileCards() {
    return '<div class="cap-card cap-block cap-prof-full" id="tlrDocsCard"><div class="cap-bh"><h4>Documents</h4></div><div id="tlrDocsBody">Loading…</div></div>'
      + '<div class="cap-card cap-block cap-prof-full" id="tlrPrivCard"><div class="cap-bh"><h4>Your data &amp; privacy</h4></div><div id="tlrPrivBody">Loading…</div></div>';
  }

  function wrapProfile() {
    var prev = window.capProfile;
    if (typeof prev !== 'function' || prev.__tlr) return;
    var next = function () {
      var html = prev.apply(this, arguments);
      try {
        if (!me() || typeof html !== 'string' || (window.STATE && STATE.cap && STATE.cap.tab && STATE.cap.tab !== 'view')) return html;
        var cards = profileCards();
        var at = html.indexOf('<h4>Resume</h4>');
        if (at > 0) {
          var start = html.lastIndexOf('<div class="cap-card', at);
          if (start > 0) return html.slice(0, start) + cards + html.slice(start);
        }
        var end = html.lastIndexOf('</div>');
        return end > 0 ? html.slice(0, end) + cards + html.slice(end) : html + cards;
      } catch (e) { return html; }
    };
    next.__tlr = true;
    window.capProfile = next;
  }

  function paintCandidateId() {
    var c = me();
    if (!c || !c.candidateCode) return;
    var head = document.querySelector('.cap-phead');
    if (!head || head.querySelector('.tlr-cid')) return;
    var at = head.children[1] || head;
    var div = document.createElement('div');
    div.className = 'tlr-cid';
    div.innerHTML = 'Candidate ID: <b>' + h(c.candidateCode) + '</b>';
    at.appendChild(div);
  }

  function docRow(d, c) {
    var dl = (window.TL && TL.apiBase || '/api') + '/candidates/' + encodeURIComponent(c.id) + '/documents/' + d.id + '/download';
    var confirming = P.confirm === 'doc:' + d.id;
    return '<li><span class="tlr-dn"><b>' + h(d.fileName) + '</b><small>' + h(KIND_LABEL[d.kind] || d.kind) + ' · ' + h(sizeText(d.size))
      + (d.uploadedAt ? ' · ' + h(String(d.updatedAt || d.uploadedAt).slice(0, 10)) : '') + '</small></span><span class="tlr-da">'
      + '<a class="btn btn-ghost btn-sm" href="' + h(dl) + '" download>Download</a>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-pdoc-replace="' + d.id + '" data-pdoc-kind="' + h(d.kind) + '">Replace</button>'
      + (confirming
        ? '<button type="button" class="btn btn-sm tlr-danger-btn" data-pdoc-delete="' + d.id + '" data-confirmed="1">Confirm delete</button>'
          + '<button type="button" class="btn btn-ghost btn-sm" data-pdoc-cancel="1">Cancel</button>'
        : '<button type="button" class="btn btn-ghost btn-sm tlr-danger" data-pdoc-delete="' + d.id + '">Delete</button>')
      + '</span></li>';
  }

  function paintProfileDocs() {
    var body = $('tlrDocsBody');
    var c = me();
    if (!body || !c) return;
    if (P.docs === null) { body.textContent = 'Loading…'; loadDocs(); return; }
    var docs = P.docs.filter(function (d) { return d.kind !== 'photo'; });
    var resume = c.resumeFile
      ? '<li><span class="tlr-dn"><b>' + h(c.resumeFile) + ' ✓</b><small>Resume / CV</small></span><span class="tlr-da">'
        + '<button type="button" class="btn btn-ghost btn-sm" data-presume="download">Download</button>'
        + '<button type="button" class="btn btn-ghost btn-sm" data-presume="replace">Replace</button>'
        + (P.confirm === 'resume'
          ? '<button type="button" class="btn btn-sm tlr-danger-btn" data-presume="delete" data-confirmed="1">Confirm delete</button><button type="button" class="btn btn-ghost btn-sm" data-pdoc-cancel="1">Cancel</button>'
          : '<button type="button" class="btn btn-ghost btn-sm tlr-danger" data-presume="delete">Delete</button>')
        + '</span></li>'
      : '<li><span class="tlr-dn"><b>No resume on your profile</b><small>Resume / CV · PDF, DOC or DOCX</small></span><span class="tlr-da">'
        + '<button type="button" class="btn btn-primary btn-sm" data-presume="replace">Upload Resume</button></span></li>';
    body.innerHTML = '<ul class="tlr-plist">' + resume + docs.map(function (d) { return docRow(d, c); }).join('') + '</ul>'
      + '<div class="tlr-padd"><label for="tlrPdocKind">Add a document</label><select id="tlrPdocKind">'
      + DOC_KINDS.map(function (d) { return '<option value="' + d.kind + '">' + h(d.label) + '</option>'; }).join('')
      + '</select><button type="button" class="btn btn-ghost btn-sm" data-pdoc-add="1">Choose file…</button>'
      + '<input type="file" id="tlrPdocInput" class="tlr-hidden-input" aria-label="Choose a document">'
      + '<input type="file" id="tlrPresumeInput" class="tlr-hidden-input" accept=".pdf,.doc,.docx" aria-label="Choose a resume"></div>'
      + '<p class="tlr-hint">PDF, DOC, DOCX, JPG or PNG (marksheets: PDF, JPG or PNG), up to 5 MB. Only you, TeamLink recruiters who may see your profile, and administrators can open these.</p>'
      + '<div class="tlr-pmsg" id="tlrPdocMsg" role="status" aria-live="polite">' + h(P.err || P.msg || '') + '</div>';
  }

  function paintPrivacy() {
    var body = $('tlrPrivBody');
    if (!body) return;
    var p = P.privacy;
    if (!p) { body.textContent = 'Loading…'; loadPrivacy(); return; }
    if (p.error) { body.textContent = 'Your privacy settings could not be loaded. Please try again later.'; return; }
    var base = (window.TL && TL.apiBase) || '/api';
    var cons = (p.consents || []).map(function (x) {
      var name = { terms: 'Terms & Privacy Policy', communication: 'Recruitment communication', resume_processing: 'Resume processing' }[x.kind] || x.kind;
      return '<li>' + h(name) + ': <b>' + h(x.status === 'granted' ? 'Agreed' : 'Withdrawn') + '</b> <small>(version ' + h(x.version)
        + ', ' + h(String(x.at || '').slice(0, 10)) + ')</small></li>';
    }).join('');
    var comm = (p.consents || []).filter(function (x) { return x.kind === 'communication'; })[0];
    var open = (p.deletionRequests || []).filter(function (r) { return r.status === 'pending' || r.status === 'in_review'; })[0];
    var last = (p.deletionRequests || [])[0];
    body.innerHTML = '<div class="tlr-priv">'
      + (cons ? '<p><b>What you agreed to</b></p><ul class="tlr-cons">' + cons + '</ul>' : '<p>No consent is recorded on this account yet.</p>')
      + (comm ? '<button type="button" class="btn btn-ghost btn-sm" data-pconsent="' + (comm.status === 'granted' ? 'withdrawn' : 'granted') + '">'
        + (comm.status === 'granted' ? 'Stop recruitment communication' : 'Allow recruitment communication again') + '</button>' : '')
      + (p.policy && p.policy.url ? '<p><a href="' + h(p.policy.url) + '" target="_blank" rel="noopener">Privacy Policy</a> (version ' + h(p.policy.version || '') + ')</p>' : '')
      + '<div class="tlr-pacts"><a class="btn btn-ghost btn-sm" href="' + h(base) + '/me/data-export" download>Download My Data</a>'
      + (open ? '' : '<button type="button" class="btn btn-ghost btn-sm tlr-danger" data-pdel="open">Request Account Deletion</button>') + '</div>'
      + '<p class="tlr-hint">Download My Data gives you a JSON file of the information on your account. It does not include TeamLink staff notes or internal scores.</p>'
      + (open ? '<div class="tlr-pnote">Your deletion request from ' + h(String(open.requestedAt).slice(0, 10)) + ' is <b>' + h(open.status === 'pending' ? 'waiting for review' : 'being reviewed') + '</b>. '
          + 'An administrator will handle it; your account stays as it is until then.'
          + (open.status === 'pending' ? ' <button type="button" class="tlr-link" data-pdel="cancel">Cancel request</button>' : '') + '</div>'
        : last && (last.status === 'completed' || last.status === 'rejected') ? '<div class="tlr-pnote">Your last request was <b>' + h(last.status) + '</b>' + (last.note ? ': ' + h(last.note) : '') + '.</div>' : '')
      + (P.delOpen && !open ? '<div class="tlr-pdel"><label for="tlrDelReason">Why would you like your account deleted? (optional)</label>'
        + '<textarea id="tlrDelReason" rows="3" maxlength="1000"></textarea>'
        + '<p class="tlr-hint">Your request is recorded and reviewed by a TeamLink administrator. Nothing is deleted automatically.</p>'
        + '<button type="button" class="btn btn-sm tlr-danger-btn" data-pdel="send">Send request</button> '
        + '<button type="button" class="btn btn-ghost btn-sm" data-pdel="close">Cancel</button></div>' : '')
      + '<div class="tlr-pmsg" role="status" aria-live="polite" id="tlrPrivMsg"></div></div>';
  }

  function profileMsg(t, which) {
    var el = $(which || 'tlrPdocMsg');
    P.msg = which ? P.msg : t;
    if (el) el.textContent = t;
  }

  function pdocUpload(kind, file, replaceId) {
    var c = me();
    if (!c || !file) return;
    var spec = DOC_KINDS.filter(function (d) { return d.kind === kind; })[0];
    var ext = extOf(file.name);
    if (spec && spec.ext.indexOf(ext) < 0) { profileMsg(spec.label + ': please upload ' + spec.ext.filter(function (e) { return e !== 'jpeg'; }).map(function (e) { return e.toUpperCase(); }).join(', ') + '.'); return; }
    if (file.size > DOC_MAX) { profileMsg('"' + file.name + '" is larger than ' + sizeText(DOC_MAX) + '.'); return; }
    var fd = new FormData();
    if (!replaceId) fd.append('kind', kind);
    fd.append('document', file, file.name);
    var path = '/candidates/' + encodeURIComponent(c.id) + '/documents' + (replaceId ? '/' + replaceId : '');
    profileMsg('Uploading ' + file.name + '…');
    (replaceId ? api().put(path, fd, { timeout: 60000 }) : api().post(path, fd, { timeout: 60000 })).then(function () {
      profileMsg((replaceId ? 'Replaced with ' : 'Saved ') + file.name + '.');
      loadDocs(true);
    }, function (e) { profileMsg((e && e.message) || 'That file could not be saved.'); });
  }

  var pdocTarget = null;
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!t || !t.closest('#tlrDocsCard, #tlrPrivCard')) return;
    var c = me();
    if (!c) return;
    if (t.getAttribute('data-pdoc-cancel')) { P.confirm = ''; paintProfileDocs(); return; }
    if (t.getAttribute('data-pdoc-add')) {
      pdocTarget = { kind: val('tlrPdocKind') || 'certificate' };
      var spec = DOC_KINDS.filter(function (d) { return d.kind === pdocTarget.kind; })[0];
      var inp = $('tlrPdocInput');
      if (inp) { inp.accept = spec ? spec.ext.map(function (x) { return '.' + x; }).join(',') : ''; inp.click(); }
      return;
    }
    if (t.getAttribute('data-pdoc-replace')) {
      pdocTarget = { kind: t.getAttribute('data-pdoc-kind'), id: t.getAttribute('data-pdoc-replace') };
      var inp2 = $('tlrPdocInput');
      if (inp2) inp2.click();
      return;
    }
    if (t.getAttribute('data-pdoc-delete')) {
      var id = t.getAttribute('data-pdoc-delete');
      if (!t.getAttribute('data-confirmed')) { P.confirm = 'doc:' + id; paintProfileDocs(); return; }
      P.confirm = '';
      api().del('/candidates/' + encodeURIComponent(c.id) + '/documents/' + id).then(function () {
        profileMsg('Document deleted.'); loadDocs(true);
      }, function (er) { profileMsg((er && er.message) || 'That document could not be deleted.'); paintProfileDocs(); });
      return;
    }
    if (t.getAttribute('data-presume')) {
      var w = t.getAttribute('data-presume');
      if (w === 'replace') { var ri = $('tlrPresumeInput'); if (ri) ri.click(); return; }
      if (w === 'download') {
        api().get('/candidates/' + encodeURIComponent(c.id) + '/resume').then(function (r) {
          if (!r || !r.url) return;
          var a = document.createElement('a');
          a.href = /^https?:/.test(r.url) ? r.url : r.url.replace(/^\/api/, (window.TL && TL.apiBase) || '/api');
          a.download = r.fileName || 'resume'; document.body.appendChild(a); a.click(); a.remove();
        }, function (er) { profileMsg((er && er.message) || 'Your resume could not be opened.'); });
        return;
      }
      if (w === 'delete') {
        if (!t.getAttribute('data-confirmed')) { P.confirm = 'resume'; paintProfileDocs(); return; }
        P.confirm = '';
        api().del('/candidates/' + encodeURIComponent(c.id) + '/resume').then(function () {
          var local = me(); if (local) local.resumeFile = '';
          profileMsg('Resume removed from your profile.');
          if (window.TL && typeof TL.refresh === 'function') TL.refresh(); else paintProfileDocs();
        }, function (er) { profileMsg((er && er.message) || 'Your resume could not be removed.'); paintProfileDocs(); });
        return;
      }
    }
    if (t.getAttribute('data-pconsent')) {
      api().post('/me/consents', { kind: 'communication', status: t.getAttribute('data-pconsent') }).then(function () {
        P.privacy = null; paintPrivacy();
      }, function (er) { profileMsg((er && er.message) || 'That could not be saved.', 'tlrPrivMsg'); });
      return;
    }
    if (t.getAttribute('data-pdel')) {
      var act = t.getAttribute('data-pdel');
      if (act === 'open') { P.delOpen = true; paintPrivacy(); var ta = $('tlrDelReason'); if (ta) ta.focus(); return; }
      if (act === 'close') { P.delOpen = false; paintPrivacy(); return; }
      if (act === 'send') {
        api().post('/me/deletion-request', { reason: val('tlrDelReason') }).then(function (r) {
          P.delOpen = false; P.privacy = null; paintPrivacy();
          setTimeout(function () { profileMsg((r && r.message) || 'Your request has been recorded.', 'tlrPrivMsg'); }, 400);
        }, function (er) { profileMsg((er && er.message) || 'Your request could not be sent.', 'tlrPrivMsg'); });
        return;
      }
      if (act === 'cancel') {
        api().post('/me/deletion-request/cancel', {}).then(function () { P.privacy = null; paintPrivacy(); },
          function (er) { profileMsg((er && er.message) || 'That could not be cancelled.', 'tlrPrivMsg'); });
      }
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.closest || !t.closest('#tlrDocsCard')) return;
    if (t.id === 'tlrPdocInput' && t.files && t.files[0] && pdocTarget) {
      pdocUpload(pdocTarget.kind, t.files[0], pdocTarget.id);
      pdocTarget = null; t.value = '';
    }
    if (t.id === 'tlrPresumeInput' && t.files && t.files[0]) {
      var f = t.files[0];
      t.value = '';
      if (RESUME_EXT.indexOf(extOf(f.name)) < 0) { profileMsg('Please upload your resume as a PDF, DOC or DOCX file.'); return; }
      if (f.size > RESUME_MAX) { profileMsg('Your resume must be ' + sizeText(RESUME_MAX) + ' or smaller.'); return; }
      if (!window.TL || typeof TL.uploadResume !== 'function') return;
      profileMsg('Uploading ' + f.name + '…');
      TL.uploadResume(f).then(function () {
        profileMsg('Resume saved: ' + f.name + '.');
        if (typeof TL.refresh === 'function') TL.refresh();
      }, function (er) { profileMsg((er && er.message) || 'Your resume could not be saved.'); });
    }
  });

  /* ------------------------------------------------------------------ *
   * 13. recruiters: the Candidate ID beside the internal id, and documents
   * ------------------------------------------------------------------ */
  var R = { id: null, docs: null };
  function paintRecruiter() {
    var m = /^#\/(recruiter|admin|bde)\/candidate-profile\?(?:.*&)?id=([^&]+)/.exec(location.hash || '');
    if (!m) return;
    var id = decodeURIComponent(m[2]);
    var c = null;
    try { c = DATA.candidateById(id); } catch (e) {}
    var h2 = document.querySelector('#app .panel .panel-body h2');
    if (!h2 || !c) return;
    if (!h2.parentNode.querySelector('.tlr-cid')) {
      var div = document.createElement('div');
      div.className = 'tlr-cid';
      div.innerHTML = 'Candidate ID: <b>' + h(c.candidateCode || '—') + '</b> <span class="tlr-iid">· Internal ID: ' + h(c.id) + '</span>';
      h2.parentNode.insertBefore(div, h2.nextSibling);
    }
    if (R.id !== id) { R.id = id; R.docs = null; }
    var host = $('tlrRecDocs');
    if (!host) {
      var panelEl = h2.closest('.panel');
      if (!panelEl) return;
      host = document.createElement('div');
      host.className = 'panel';
      host.id = 'tlrRecDocs';
      host.style.marginBottom = '16px';
      panelEl.parentNode.insertBefore(host, panelEl.nextSibling);
    }
    if (R.docs === null) {
      R.docs = [];
      host.innerHTML = '<div class="panel-head"><h2>Documents</h2></div><div class="panel-body">Loading…</div>';
      api() && api().get('/candidates/' + encodeURIComponent(id) + '/documents').then(function (r) {
        R.docs = (r && r.documents) || [];
        paintRecDocs(host, id);
      }, function () { host.querySelector('.panel-body').textContent = 'Documents could not be loaded.'; });
    } else paintRecDocs(host, id);
  }
  function paintRecDocs(host, id) {
    var base = (window.TL && TL.apiBase) || '/api';
    host.innerHTML = '<div class="panel-head"><h2>Documents</h2></div><div class="panel-body">'
      + (R.docs.length ? '<ul class="tlr-plist">' + R.docs.map(function (d) {
        return '<li><span class="tlr-dn"><b>' + h(d.fileName) + '</b><small>' + h(KIND_LABEL[d.kind] || d.kind) + ' · ' + h(sizeText(d.size)) + '</small></span>'
          + '<span class="tlr-da"><a class="btn btn-ghost btn-sm" href="' + h(base + '/candidates/' + encodeURIComponent(id) + '/documents/' + d.id + '/download') + '" download>Download</a></span></li>';
      }).join('') + '</ul>' : '<p class="tlr-hint" style="margin:0">No documents besides the resume.</p>') + '</div>';
  }

  /* ------------------------------------------------------------------ *
   * 14. admin: account deletion requests
   * ------------------------------------------------------------------ */
  var A = { rows: null, err: '', open: null };
  function adminPage() {
    return '<div class="panel"><div class="panel-head"><h2>Account deletion requests</h2></div><div class="panel-body">'
      + '<p class="tlr-hint" style="margin-top:0">Candidates ask here to have their account deleted. Nothing is deleted automatically. '
      + 'Mark a request in review, then complete or reject it. Completing can also switch the login off and stop all contact; '
      + 'erasing the record itself is a separate, deliberate step.</p><div id="tlrAdminDel">Loading…</div></div></div>';
  }
  function installAdmin() {
    try {
      var nav = (typeof NAV_CONFIG !== 'undefined' && NAV_CONFIG.admin) || null;
      if (nav && !nav.some(function (n) { return n[0] === 'privacy-requests'; })) nav.push(['privacy-requests', 'Privacy Requests', '🛡️']);
    } catch (e) { /* reachable by URL */ }
    var prev = window.pageAdminDash;
    if (typeof prev !== 'function' || prev.__tlr) return;
    var next = function (section) {
      if (section !== 'privacy-requests') return prev.apply(this, arguments);
      return typeof window.dashShell === 'function'
        ? window.dashShell('admin', 'privacy-requests', 'Privacy requests', 'Admin · TeamLink Platform', adminPage())
        : adminPage();
    };
    next.__tlr = true;
    window.pageAdminDash = next;
  }
  function loadAdmin() {
    api().get('/admin/deletion-requests').then(function (r) { A.rows = (r && r.requests) || []; A.err = ''; paintAdmin(); },
      function (e) { A.err = (e && e.message) || 'Could not load the requests.'; A.rows = []; paintAdmin(); });
  }
  function paintAdmin() {
    var host = $('tlrAdminDel');
    if (!host) return;
    if (A.rows === null) { loadAdmin(); return; }
    if (A.err) { host.innerHTML = '<p class="empty-note">' + h(A.err) + '</p>'; return; }
    if (!A.rows.length) { host.innerHTML = '<p class="empty-note">No deletion requests.</p>'; return; }
    host.innerHTML = '<div class="tlr-table-wrap"><table class="tlr-table"><thead><tr><th>Candidate</th><th>Requested</th><th>Reason</th><th>Status</th><th>Action</th></tr></thead><tbody>'
      + A.rows.map(function (r) {
        var openForm = A.open === r.id;
        var actions = (r.status === 'pending' || r.status === 'in_review')
          ? (r.status === 'pending' ? '<button type="button" class="btn btn-ghost btn-sm" data-adel="in_review" data-id="' + r.id + '">Mark in review</button>' : '')
            + '<button type="button" class="btn btn-ghost btn-sm" data-adel="form" data-id="' + r.id + '">Complete / reject…</button>'
          : (r.deactivated ? 'Login switched off' : '—');
        return '<tr><td><b>' + h(r.name) + '</b><br><small>' + h(r.candidateCode || '') + ' · ' + h(r.email || '') + '</small></td>'
          + '<td>' + h(String(r.requestedAt).slice(0, 10)) + '</td><td>' + h(r.reason || '—') + '</td>'
          + '<td>' + h(r.status.replace('_', ' ')) + (r.note ? '<br><small>' + h(r.note) + '</small>' : '') + '</td><td>' + actions + '</td></tr>'
          + (openForm ? '<tr><td colspan="5"><div class="tlr-adel"><label for="tlrAdelNote">Note to record</label><input id="tlrAdelNote" maxlength="1000">'
            + '<label class="tlr-inline-check"><input type="checkbox" id="tlrAdelDeact"> Also switch the login off and stop all contact</label>'
            + '<button type="button" class="btn btn-primary btn-sm" data-adel="completed" data-id="' + r.id + '">Complete</button> '
            + '<button type="button" class="btn btn-ghost btn-sm" data-adel="rejected" data-id="' + r.id + '">Reject</button> '
            + '<button type="button" class="btn btn-ghost btn-sm" data-adel="close" data-id="' + r.id + '">Cancel</button></div></td></tr>' : '');
      }).join('') + '</tbody></table></div>';
  }
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-adel]') : null;
    if (!t || !t.closest('#tlrAdminDel')) return;
    var id = Number(t.getAttribute('data-id')), act = t.getAttribute('data-adel');
    if (act === 'form') { A.open = id; paintAdmin(); var n = $('tlrAdelNote'); if (n) n.focus(); return; }
    if (act === 'close') { A.open = null; paintAdmin(); return; }
    var body = { status: act };
    if (act !== 'in_review') { body.note = val('tlrAdelNote') || undefined; body.deactivate = !!($('tlrAdelDeact') || {}).checked; }
    api().post('/admin/deletion-requests/' + id, body).then(function () {
      A.open = null; A.rows = null; paintAdmin(); say('Request updated', '✓');
    }, function (er) { say((er && er.message) || 'That could not be saved.', '⚠️'); });
  });

  /* ------------------------------------------------------------------ *
   * 15. installing
   * ------------------------------------------------------------------ */
  function wrapPage() {
    var prev = window.pageRegisterCandidate;
    if (typeof prev !== 'function' || prev.__tlr) return;
    var next = function () {
      var out = prev.apply(this, arguments);
      try { return restructure(out); } catch (e) { return out; }
    };
    next.__tlr = true;
    window.pageRegisterCandidate = next;
  }

  function afterPaint() {
    try {
      wrapApi();
      if (onRegisterPage()) afterRender();
      if (isCandidate() && /^#\/candidate\/profile/.test(location.hash || '')) {
        paintCandidateId();
        if ($('tlrDocsBody') && !$('tlrDocsBody').getAttribute('data-p')) { $('tlrDocsBody').setAttribute('data-p', '1'); paintProfileDocs(); }
        if ($('tlrPrivBody') && !$('tlrPrivBody').getAttribute('data-p')) { $('tlrPrivBody').setAttribute('data-p', '1'); paintPrivacy(); }
      }
      if (/^#\/(recruiter|admin|bde)\/candidate-profile/.test(location.hash || '')) paintRecruiter();
      if (/^#\/admin\/privacy-requests/.test(location.hash || '')) {
        var host = $('tlrAdminDel');
        if (host && !host.getAttribute('data-loaded')) { host.setAttribute('data-loaded', '1'); A.rows = null; paintAdmin(); }
      }
    } catch (e) { if (window.TL && TL.debug) console.error('[registration]', e); }
  }

  function install() {
    wrapPage();
    wrapValidate();
    wrapResume();
    wrapApi();
    wrapNavigate();
    wrapProfile();
    installAdmin();
    var prev = window.render;
    if (typeof prev === 'function' && !prev.__tlr) {
      var r = function () {
        try { if (onRegisterPage()) snapshotBeforeRender(); } catch (e) {}
        var out = prev.apply(this, arguments);
        afterPaint();
        return out;
      };
      r.__tlr = true;
      window.render = r;
    }
    window.addEventListener('hashchange', function () { setTimeout(afterPaint, 0); });
    window.addEventListener('beforeunload', function () { try { if (onRegisterPage()) saveDraft(); } catch (e) {} });
    if (onRegisterPage() && typeof window.render === 'function') window.render();
    else afterPaint();
  }

  /* ------------------------------------------------------------------ *
   * 16. styles - the form's own classes, spacing and colours; only what
   *     the steps add is defined here
   * ------------------------------------------------------------------ */
  function css() {
    if ($('tlr-css')) return;
    var s = document.createElement('style');
    s.id = 'tlr-css';
    s.textContent = ''
      + '#registerForm[data-tlr] [hidden]{display:none!important}'
      + '#registerForm[data-tlr] .tlr-step-head{margin:6px 0 14px}'
      + '#registerForm[data-tlr] .tlr-step-head h2{display:flex;align-items:center;font-size:20px;margin:0;outline:none}'
      + '#registerForm[data-tlr] .tlr-step-head p{margin:6px 0 0;color:var(--text-soft);font-size:13.5px}'
      + '#registerForm[data-tlr] .tlr-panel{margin-bottom:14px}'
      + '#registerForm[data-tlr] .tlr-panel .panel-head h3{font-size:15px;margin:0}'
      + '#registerForm[data-tlr] .tlr-progress{padding:4px 0 10px;margin-bottom:6px}'
      + '.tlr-stepper{list-style:none;display:flex;gap:4px;margin:0 0 8px;padding:0;justify-content:space-between}'
      + '.tlr-stepper li{flex:1;min-width:0}'
      + '.tlr-dot{width:100%;display:flex;flex-direction:column;align-items:center;gap:4px;background:none;border:0;cursor:pointer;font:inherit;color:var(--text-soft);padding:2px}'
      + '.tlr-dot-n{width:26px;height:26px;border-radius:99px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;'
        + 'background:var(--card,#fff);border:2px solid var(--line,#d7dfea);color:var(--text-soft)}'
      + '.tlr-dot-t{font-size:11.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}'
      + '.tlr-stepper li.on .tlr-dot-n{background:var(--brand-500);border-color:var(--brand-500);color:#fff}'
      + '.tlr-stepper li.on .tlr-dot-t{color:var(--text)}'
      + '.tlr-stepper li.done .tlr-dot-n{background:var(--ok-100,#e8f6ee);border-color:var(--ok-600,#11794d);color:var(--ok-600,#11794d)}'
      + '.tlr-stepper li.warn .tlr-dot-n{border-color:var(--bad-600,#c0392b);color:var(--bad-600,#c0392b)}'
      + '.tlr-dot:focus-visible{outline:2px solid var(--brand-500);outline-offset:2px;border-radius:8px}'
      + '.tlr-bar{height:6px;background:var(--line,#e4ecf4);border-radius:99px;overflow:hidden}'
      + '.tlr-bar i{display:block;height:6px;width:0;background:var(--brand-500);transition:width .25s}'
      + '.tlr-where{font-size:12.5px;font-weight:700;color:var(--text-soft);margin-top:6px}'
      + '.tlr-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}'
      + '.tlr-hidden{display:none!important}'
      + '.tlr-hidden-input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}'
      + '.tlr-hp{position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden}'
      + '.tlr-req{color:var(--bad-600,#c0392b)}'
      + '.tlr-hint{font-size:11.5px;color:var(--text-soft);margin-top:5px;line-height:1.45}'
      + '.tlr-sub{display:block;margin-top:8px}'
      + '#registerForm[data-tlr] .review-field input[type=file]{padding:6px 0;border:0;background:none}'
      + '.tlr-summary{background:var(--bad-100,#fdecea);border:1px solid #f3c1bb;color:var(--bad-600,#b42318);border-radius:10px;padding:10px 14px;margin:0 0 14px;font-size:13px}'
      + '.tlr-summary ul,.tlr-missing ul{margin:6px 0 0;padding-left:18px}'
      + '.tlr-missing{background:#fff7e8;border:1px solid #f0d9a8;color:#7a4d0b;border-radius:10px;padding:10px 14px;margin:0 0 14px;font-size:13px}'
      + '.tlr-link{background:none;border:0;padding:0;font:inherit;color:var(--brand-600);font-weight:700;text-decoration:underline;cursor:pointer}'
      + '.tlr-danger{color:var(--bad-600,#b42318)!important}'
      + '.tlr-danger-btn{background:var(--bad-600,#b42318);color:#fff;border:0}'
      + '.tlr-nav{display:flex;align-items:center;gap:10px;margin:18px 0 8px;flex-wrap:wrap}'
      + '.tlr-nav-sp{flex:1}'
      + '.tlr-nav .btn{min-width:130px;padding:12px 18px}'
      + '.tlr-restored{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#eef8fb;border:1px solid #bfe3ee;border-radius:10px;padding:9px 12px;font-size:12.5px;margin-bottom:12px}'
      + '.tlr-restored span{flex:1;min-width:200px}'
      + '.tlr-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}'
      + '.tlr-chip{display:inline-flex;align-items:center;gap:4px;background:var(--brand-50,#eaf5f9);color:var(--brand-700,#0e5a70);border-radius:99px;padding:3px 4px 3px 10px;font-size:12.5px;font-weight:600}'
      + '.tlr-chip button{border:0;background:none;cursor:pointer;color:inherit;font-size:13px;line-height:1;padding:2px 6px;border-radius:99px}'
      + '.tlr-chip button:hover,.tlr-chip button:focus-visible{background:rgba(0,0,0,.08)}'
      + '.tlr-picks{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}'
      + '.tlr-pick{border:1px solid var(--line);background:var(--card,#fff);border-radius:99px;padding:5px 11px;font:inherit;font-size:12.5px;cursor:pointer}'
      + '.tlr-pick.on{background:var(--brand-500);border-color:var(--brand-500);color:#fff}'
      + '.tlr-fieldset{border:0;margin:0 0 14px;padding:0;min-width:0}'
      + '.tlr-fieldset legend{font-size:12.5px;font-weight:700;margin-bottom:6px;padding:0}'
      + '.tlr-fieldset.reg-bad,#regWorkModeGroup.reg-bad{border:1px solid var(--bad-600);border-radius:8px;padding:4px}'
      + '#registerForm .tlr-inline-check,.tlr-inline-check{display:flex!important;align-items:center;justify-content:flex-start;gap:8px;font-size:12.5px;font-weight:600;margin-top:8px;cursor:pointer;width:auto}'
      + '#registerForm .tlr-inline-check input,.tlr-inline-check input{width:auto!important;height:auto;margin:0;padding:0;flex:0 0 auto}'
      + '.tlr-photo{display:flex;align-items:center;gap:10px;margin-top:6px;font-size:12.5px;flex-wrap:wrap}'
      + '.tlr-photo img{width:44px;height:44px;border-radius:50%;object-fit:cover;border:1px solid var(--line)}'
      + '.tlr-file-card{display:flex;align-items:center;gap:12px;flex-wrap:wrap;border:1px dashed var(--line);border-radius:12px;padding:14px;background:var(--card,#fff)}'
      + '.tlr-file-card.reg-bad{border-color:var(--bad-600)}'
      + '.tlr-file-ok,.tlr-file-empty{display:flex;align-items:center;gap:10px;flex:1;min-width:200px}'
      + '.tlr-file-ic{font-size:24px}'
      + '.tlr-file-t{display:flex;flex-direction:column;gap:2px;min-width:0}'
      + '.tlr-file-t b{word-break:break-word}'
      + '.tlr-file-t span{font-size:12px;color:var(--text-soft)}'
      + '.tlr-tick{color:var(--ok-600,#11794d)}'
      + '.tlr-file-acts{display:flex;gap:6px;flex-wrap:wrap}'
      + '.tlr-doc{border-top:1px solid var(--line);padding:10px 0}'
      + '.tlr-doc:first-of-type{border-top:0}'
      + '.tlr-doc-head{display:flex;align-items:center;justify-content:space-between;gap:10px}'
      + '.tlr-doc-list{list-style:none;margin:6px 0 0;padding:0;font-size:12.5px}'
      + '.tlr-doc-list li{display:flex;justify-content:space-between;gap:10px;padding:4px 0;word-break:break-word}'
      + '.tlr-readonly{padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:var(--bg,#f6f8fb);font-size:13.5px;word-break:break-all}'
      + '.tlr-eye{margin-top:6px;background:none;border:1px solid var(--line);border-radius:7px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer}'
      + '.tlr-strength{display:flex;align-items:center;gap:10px;font-size:12.5px;margin:2px 0 8px}'
      + '.tlr-meter{flex:0 0 140px;height:6px;border-radius:99px;background:var(--line,#e4ecf4);overflow:hidden}'
      + '.tlr-meter i{display:block;height:6px;width:0}'
      + '.tlr-m1{background:#d64545}.tlr-m2{background:#e3a008}.tlr-m3{background:#3b82c4}.tlr-m4,.tlr-m5{background:#11794d}'
      + '.tlr-rules{margin:0;padding-left:18px;font-size:12px;color:var(--text-soft)}'
      + '.tlr-rules li.ok{color:var(--ok-600,#11794d)}'
      + '.tlr-rules li.ok::marker{content:"✓ "}'
      + '.tlr-rev .panel-head{display:flex;justify-content:space-between;align-items:center}'
      + '.tlr-dl{display:grid;grid-template-columns:minmax(120px,38%) 1fr;gap:6px 14px;margin:0;font-size:13px}'
      + '.tlr-dl dt{color:var(--text-soft)}.tlr-dl dd{margin:0;word-break:break-word}'
      + '.tlr-cid{font-size:12px;color:var(--text-soft);margin-top:4px}'
      + '.tlr-cid b{color:var(--text);letter-spacing:.02em}'
      + '.tlr-iid{opacity:.8}'
      + '.tlr-plist{list-style:none;margin:0;padding:0}'
      + '.tlr-plist li{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line,#eef1f6);flex-wrap:wrap}'
      + '.tlr-dn{display:flex;flex-direction:column;min-width:0;flex:1}'
      + '.tlr-dn b{font-size:13px;word-break:break-word}.tlr-dn small{font-size:11.5px;color:#7b8794}'
      + '.tlr-da{display:flex;gap:6px;flex-wrap:wrap}'
      + '.tlr-padd{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;font-size:12.5px}'
      + '.tlr-padd select{padding:6px 8px;border:1px solid var(--line);border-radius:8px;font:inherit}'
      + '.tlr-pmsg{font-size:12.5px;font-weight:600;color:#0e7490;margin-top:6px}'
      + '.tlr-priv p{font-size:12.5px;margin:6px 0}.tlr-cons{margin:0 0 8px;padding-left:18px;font-size:12.5px}'
      + '.tlr-pacts{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}'
      + '.tlr-pnote{background:#fff7e8;border:1px solid #f0d9a8;border-radius:8px;padding:8px 10px;font-size:12.5px;margin-top:8px}'
      + '.tlr-pdel,.tlr-adel{display:flex;flex-direction:column;gap:6px;margin-top:8px;font-size:12.5px}'
      + '.tlr-pdel textarea,.tlr-adel input{border:1px solid var(--line);border-radius:8px;padding:8px;font:inherit}'
      + '.tlr-table-wrap{overflow-x:auto}.tlr-table{width:100%;border-collapse:collapse;font-size:12.5px}'
      + '.tlr-table th,.tlr-table td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}'
      + '.tlr-ok-ov{position:fixed;inset:0;background:rgba(18,32,48,.45);z-index:9500;display:flex;align-items:center;justify-content:center;padding:16px}'
      + '.tlr-ok-card{background:#fff;border-radius:16px;max-width:440px;width:100%;padding:28px 24px 22px;text-align:center;box-shadow:0 18px 50px rgba(16,32,52,.25)}'
      + '.tlr-ok-card h2{margin:10px 0 4px;font-size:21px;outline:none}'
      + '.tlr-ok-welcome{font-size:15px;font-weight:700;color:var(--brand-600);margin:0 0 12px}'
      + '.tlr-ok-id{display:inline-flex;gap:10px;align-items:center;background:#f2f8fb;border:1px solid #d7e7ef;border-radius:10px;padding:9px 14px;font-size:14px;margin-bottom:10px;flex-wrap:wrap;justify-content:center}'
      + '.tlr-ok-id b{font-size:16px;letter-spacing:.03em}'
      + '.tlr-ok-card p{font-size:13.5px;color:var(--text-soft);margin:4px 0}'
      + '.tlr-ok-docs{font-size:12.5px!important}'
      + '.tlr-ok-acts{display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap}'
      + '.tlr-ok-acts .btn{min-width:150px}'
      + '.tlr-ok-ic{width:34px;height:34px;border-radius:50%;background:var(--ok-100,#e8f6ee);color:var(--ok-600,#11794d);display:inline-flex;align-items:center;justify-content:center;font-weight:800;flex:0 0 auto}'
      + '.tlr-ok-ic.big{width:56px;height:56px;font-size:26px}'
      + '.tlr-ok-toast{position:fixed;right:16px;bottom:16px;z-index:9500;max-width:420px;background:#fff;border:1px solid #cde8d8;border-left:4px solid var(--ok-600,#11794d);'
        + 'border-radius:12px;box-shadow:0 10px 30px rgba(16,32,52,.18);padding:12px 14px;display:flex;gap:10px;align-items:flex-start;font-size:13px}'
      + '.tlr-ok-tt{display:flex;flex-direction:column;gap:3px;flex:1}'
      + '.tlr-x{background:none;border:0;cursor:pointer;color:#8a97a6;font-size:14px;padding:4px}'
      + '@media (max-width:640px){'
        + '.tlr-dot-t{display:none}'
        + '.tlr-stepper li.on .tlr-dot-t{display:block;position:absolute;left:-9999px}'
        + '.tlr-dot-n{width:24px;height:24px;font-size:11px}'
        + '.tlr-nav{position:sticky;bottom:0;background:var(--bg,#f6f8fb);padding:10px 0;margin:10px 0 0;z-index:4}'
        + '.tlr-nav .btn{min-width:0;flex:1}'
        + '.tlr-nav-sp{display:none}'
        + '.tlr-dl{grid-template-columns:1fr}.tlr-dl dt{margin-top:6px}'
        + '.tlr-meter{flex-basis:90px}'
        + '.tlr-ok-toast{left:12px;right:12px;bottom:12px;max-width:none}'
        + '.tlr-ok-acts .btn{flex:1;min-width:0}'
        + '.tlr-file-acts{width:100%}.tlr-file-acts .btn{flex:1}'
      + '}';
    document.head.appendChild(s);
  }

  if (document.readyState === 'complete') install();
  else window.addEventListener('load', install);

  /* For the verify scripts and for other modules: where a field lives. */
  window.TLRegistration = {
    step: function () { return S.step; },
    go: function (n) { showStep(Number(n)); },
    reveal: function (id) { var n = stepOfField(String(id).replace(/^#/, '')); if (n && n !== S.step) showStep(n, false); return n; },
    problems: function () { return problems(); },
    draftKey: DRAFT_KEY,
  };
})();
