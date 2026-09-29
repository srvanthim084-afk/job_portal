/* =====================================================================
   TeamLink AutoFill — what a field is, and what must never be touched
   =====================================================================

   Two lists live here and nothing else does.

   THE FIRST IS THE ONE THAT MATTERS. `NEVER_FILL` is checked before any
   matching happens and it is checked by more than one signal: the input
   type, its name and id, its autocomplete attribute, and the words
   around it. A password, a card number, a national identity number or a
   bank account is never filled by this extension under any circumstance,
   including when a synonym below would otherwise have matched. The
   check is deliberately broad and deliberately first: a false positive
   costs one field the candidate types themselves, a false negative
   costs them a credential.

   THE SECOND IS THE SYNONYM DICTIONARY. Real forms name the same field
   a dozen ways - "Legal First Name", "Given Name", "fname" - and the
   matcher scores label, aria-label, placeholder, name and id against it.
   ANYTHING IT CANNOT MATCH CONFIDENTLY IS LEFT BLANK. A wrong value in
   a job application is worse than an empty box, because the candidate
   will not read back a field they believe was filled correctly.
   ===================================================================== */
/* global window */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- *
   * 1. never, under any circumstances
   * ---------------------------------------------------------------- */

  var NEVER_TYPES = ['password', 'hidden', 'file', 'image', 'submit', 'button', 'reset'];

  /* Matched against name, id, autocomplete, label and placeholder. */
  var NEVER_WORDS = new RegExp([
    /* credentials */
    'password', 'passwd', 'pwd', 'passcode', 'pin\\b', 'otp', 'security\\s*code',
    'secret', 'token', 'api[\\s_-]*key',
    /* payment */
    'card\\s*number', 'cardnum', 'credit\\s*card', 'debit\\s*card', 'cvv', 'cvc',
    'expiry', 'exp[\\s_-]*date', 'iban', 'swift', 'sort\\s*code',
    'account\\s*number', 'routing', 'bank',
    /* government identity */
    'ssn', 'social\\s*security', 'national\\s*(id|insurance)', 'nino',
    'aadhaar', 'aadhar', '\\bpan\\b', 'passport', 'driver.?s?\\s*licen[cs]e',
    'tax\\s*id', 'tin\\b', 'visa\\s*number', 'permit\\s*number',
    /* dates of birth are identity too, and are often a verification answer */
    'date\\s*of\\s*birth', '\\bdob\\b',
  ].join('|'), 'i');

  var NEVER_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)/i;

  /**
   * True when this field must not be written to, whatever else matched.
   *
   * @param {Element} el
   * @param {string}  text  every label/aria/placeholder word around it
   */
  function neverFill(el, text) {
    var type = String(el.getAttribute('type') || el.type || '').toLowerCase();
    if (NEVER_TYPES.indexOf(type) >= 0) return true;

    var ac = String(el.getAttribute('autocomplete') || '');
    if (NEVER_AUTOCOMPLETE.test(ac)) return true;

    var hay = [
      el.getAttribute('name') || '',
      el.getAttribute('id') || '',
      ac,
      text || '',
    ].join(' ');

    return NEVER_WORDS.test(hay);
  }

  /* ---------------------------------------------------------------- *
   * 2. the synonyms
   *
   * Ordered: the first profile key whose pattern matches wins, so the
   * more specific patterns are listed above the looser ones.
   * ---------------------------------------------------------------- */
  var SYNONYMS = [
    ['preferredFirstName', /(preferred|known\s*as|nick)\s*(first\s*)?name/i],
    ['firstName',   /^(first|given|legal\s*first|fore)\s*name|^f(irst)?[\s_-]*n(ame)?$|\bfname\b/i],
    ['lastName',    /^(last|family|legal\s*last|sur)\s*name|^l(ast)?[\s_-]*n(ame)?$|\blname\b|surname/i],
    ['fullName',    /^(full|your|candidate|applicant)?\s*name$/i],
    ['email',       /e[\s_-]*mail(\s*address)?|^email$/i],
    ['phone',       /(mobile|phone|contact)\s*(number|no\.?)?|^tel(ephone)?$|\bphone\b/i],
    ['countryCode', /country\s*(calling|dial(ling)?)\s*code|phone\s*code/i],
    ['country',     /^country$|country\s*of\s*residence|country\/region/i],
    ['state',       /^(state|province|region)$|state\s*\/\s*province/i],
    ['city',        /^(city|town)$|city\s*\/\s*town|^location|current\s*city|location\s*\(city/i],
    ['currentTitle',/(current|present|most\s*recent)\s*(job\s*)?title|^job\s*title$|^title$|designation/i],
    ['currentCompany', /(current|present|most\s*recent)\s*(employer|company)|^company$|^employer$/i],
    ['experienceYears', /(years?|yrs?)\s*(of\s*)?experience|total\s*experience|^experience$/i],
    ['linkedinUrl', /linked\s*-?\s*in/i],
    ['portfolioUrl', /portfolio|personal\s*(web)?site|^website$|github/i],
    ['noticePeriod', /notice\s*period|availability\s*to\s*(start|join)|when\s*can\s*you\s*start/i],
    ['workAuthorization', /work\s*(authoriz|authoris|permit|eligib)|right\s*to\s*work|visa\s*status/i],
    ['skills',      /^(key\s*)?skills$|core\s*competenc/i],
    ['education',   /^(highest\s*)?(education|qualification|degree)$/i],
  ];

  /* ---------------------------------------------------------------- *
   * 3. reading a field's words
   * ---------------------------------------------------------------- */

  /** Every bit of text a human would use to understand this input. */
  function labelText(el) {
    var bits = [];
    var push = function (v) { if (v) bits.push(String(v)); };

    push(el.getAttribute('aria-label'));
    push(el.getAttribute('placeholder'));

    var id = el.getAttribute('id');
    if (id) {
      try {
        var lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (lab) push(lab.textContent);
      } catch (e) { /* an id that is not a valid selector */ }
    }

    var wrap = el.closest('label');
    if (wrap) push(wrap.textContent);

    /* aria-labelledby, which Workday leans on heavily. */
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      by.split(/\s+/).forEach(function (rid) {
        var n = document.getElementById(rid);
        if (n) push(n.textContent);
      });
    }

    /* The nearest preceding text in the same group - the pattern most
       hand-rolled forms use instead of a real <label>. */
    var group = el.closest('div,fieldset,li,td');
    if (group && bits.length < 2) {
      var own = group.textContent || '';
      push(own.slice(0, 160));
    }

    return bits.join(' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Which profile field this input is, or null.
   *
   * NULL IS A NORMAL ANSWER. It means "not confident", and the caller
   * leaves the field alone and counts it as unfilled so the summary can
   * tell the candidate to look at it.
   */
  function matchField(el) {
    var text = labelText(el);
    if (neverFill(el, text)) return null;

    /* The attributes are worth more than the surrounding prose, which
       can contain a whole paragraph of instructions. */
    var strong = [
      el.getAttribute('name') || '',
      el.getAttribute('id') || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('placeholder') || '',
    ].join(' ');

    for (var i = 0; i < SYNONYMS.length; i++) {
      if (SYNONYMS[i][1].test(strong)) return SYNONYMS[i][0];
    }
    for (var j = 0; j < SYNONYMS.length; j++) {
      if (SYNONYMS[j][1].test(text)) return SYNONYMS[j][0];
    }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * 4. writing, so a framework notices
   * ---------------------------------------------------------------- */

  /**
   * React and Angular track the value on their own; assigning `.value`
   * updates the DOM and leaves their state stale, so the field reverts
   * on the next render or the form submits empty. Setting through the
   * native prototype setter and then dispatching the events they listen
   * for is what makes the change stick.
   */
  function setValue(el, value) {
    var v = String(value == null ? '' : value);
    if (!v) return false;

    try {
      var proto = el instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : el instanceof window.HTMLSelectElement
          ? window.HTMLSelectElement.prototype
          : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, v);
      else el.value = v;
    } catch (e) { el.value = v; }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  /** A <select>: pick the option that matches, or leave it alone. */
  function setSelect(el, value) {
    var want = String(value == null ? '' : value).trim().toLowerCase();
    if (!want) return false;
    var opts = [].slice.call(el.options || []);
    var hit = opts.find(function (o) {
      return String(o.value).trim().toLowerCase() === want
        || String(o.textContent).trim().toLowerCase() === want;
    });
    /* A partial match only when it is unambiguous - "India" against
       "India" and nothing else. Two candidates means we do not know. */
    if (!hit) {
      var near = opts.filter(function (o) {
        return String(o.textContent).trim().toLowerCase().indexOf(want) >= 0;
      });
      if (near.length === 1) hit = near[0];
    }
    if (!hit) return false;
    el.value = hit.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  window.TLAF_FIELDS = {
    neverFill: neverFill,
    labelText: labelText,
    matchField: matchField,
    setValue: setValue,
    setSelect: setSelect,
    SYNONYMS: SYNONYMS,
  };
}());
