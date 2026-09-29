/* =====================================================================
   Generic adapter — the fallback, and the one that does most of the work

   It knows nothing about any platform. It walks the visible inputs of
   whatever looks like an application form and asks the matcher what each
   one is. Every named adapter below falls back to this for the fields it
   does not recognise, so improving this improves all of them.
   ===================================================================== */
/* global window, document */
(function () {
  'use strict';

  /* A form with one search box is not an application form. */
  var MIN_FIELDS = 3;

  function visible(el) {
    if (el.disabled || el.readOnly) return false;
    if (el.type === 'hidden') return false;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  /** Every input this page would let a person type into. */
  function inputs(root) {
    return [].slice.call((root || document)
      .querySelectorAll('input, select, textarea'))
      .filter(visible);
  }

  /**
   * Is this an application form at all?
   *
   * The extension must do nothing on a jobs LIST, a company page or a
   * marketing page that happens to be on an ATS domain. Three or more
   * matched fields, or a form whose words say what it is.
   */
  function looksLikeApplication(root) {
    var els = inputs(root);
    if (els.length < MIN_FIELDS) return false;
    var matched = 0;
    for (var i = 0; i < els.length && matched < MIN_FIELDS; i++) {
      if (window.TLAF_FIELDS.matchField(els[i])) matched += 1;
    }
    return matched >= MIN_FIELDS;
  }

  window.TLAF_ADAPTERS = window.TLAF_ADAPTERS || {};
  window.TLAF_ADAPTERS.generic = {
    key: 'generic',
    name: 'Generic ATS form',
    matches: function () { return true; },
    root: function () {
      /* The form with the most inputs, or the page. */
      var forms = [].slice.call(document.querySelectorAll('form'));
      if (!forms.length) return document;
      return forms.sort(function (a, b) {
        return inputs(b).length - inputs(a).length;
      })[0];
    },
    detect: looksLikeApplication,
    /* One entry per field: { el, key }. `key` may be null, and a null
       is reported as unfilled rather than guessed at. */
    fields: function (root) {
      return inputs(root).map(function (el) {
        return { el: el, key: window.TLAF_FIELDS.matchField(el) };
      });
    },
    inputs: inputs,
    visible: visible,
  };
}());
