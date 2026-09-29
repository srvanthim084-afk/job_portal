/* =====================================================================
   Lever — jobs.lever.co

   Lever names its inputs by the value it wants: name="name",
   name="email", name="phone", name="org", name="urls[LinkedIn]". The
   single "name" field is the reason `fullName` exists in the synonym
   list at all - splitting a profile into first and last is easy, joining
   two that were never split is not.
   ===================================================================== */
/* global window, document */
(function () {
  'use strict';

  var DIRECT = {
    'name': 'fullName',
    'email': 'email',
    'phone': 'phone',
    'org': 'currentCompany',
    'urls[LinkedIn]': 'linkedinUrl',
    'urls[GitHub]': 'portfolioUrl',
    'urls[Portfolio]': 'portfolioUrl',
    'location': 'city',
  };

  window.TLAF_ADAPTERS = window.TLAF_ADAPTERS || {};
  window.TLAF_ADAPTERS.lever = {
    key: 'lever',
    name: 'Lever',
    matches: function () { return /lever\.co$/i.test(location.hostname); },
    root: function () {
      return document.querySelector('form.application-form')
        || document.querySelector('form[action*="apply"]')
        || document.querySelector('form') || document;
    },
    detect: function (root) {
      return !!document.querySelector('form.application-form')
        || window.TLAF_ADAPTERS.generic.detect(root);
    },
    fields: function (root) {
      var g = window.TLAF_ADAPTERS.generic;
      return g.inputs(root).map(function (el) {
        var n = String(el.getAttribute('name') || '');
        var direct = DIRECT[n];
        if (direct && !window.TLAF_FIELDS.neverFill(el, window.TLAF_FIELDS.labelText(el))) {
          return { el: el, key: direct };
        }
        return { el: el, key: window.TLAF_FIELDS.matchField(el) };
      });
    },
  };
}());
