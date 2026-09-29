/* =====================================================================
   Greenhouse — boards.greenhouse.io and job-boards.greenhouse.io

   The most regular of the four. The application form is #application_form
   (or [data-ui="application-form"] on the newer boards) and every input
   carries a real id: job_application_first_name, ...last_name, ...email,
   ...phone. Those are matched by name here rather than by label, which
   makes it the adapter least likely to be wrong.
   ===================================================================== */
/* global window, document */
(function () {
  'use strict';

  var DIRECT = {
    'job_application_first_name': 'firstName',
    'job_application_last_name': 'lastName',
    'job_application_email': 'email',
    'job_application_phone': 'phone',
    'job_application_location': 'city',
    'first_name': 'firstName',
    'last_name': 'lastName',
    'email': 'email',
    'phone': 'phone',
    'location': 'city',
  };

  window.TLAF_ADAPTERS = window.TLAF_ADAPTERS || {};
  window.TLAF_ADAPTERS.greenhouse = {
    key: 'greenhouse',
    name: 'Greenhouse',
    matches: function () { return /greenhouse\.io$/i.test(location.hostname); },
    root: function () {
      return document.querySelector('#application_form')
        || document.querySelector('[data-ui="application-form"]')
        || document.querySelector('form')
        || document;
    },
    detect: function (root) {
      return !!(root && root !== document)
        || window.TLAF_ADAPTERS.generic.detect(root);
    },
    fields: function (root) {
      var g = window.TLAF_ADAPTERS.generic;
      return g.inputs(root).map(function (el) {
        var id = String(el.getAttribute('id') || el.getAttribute('name') || '');
        var direct = DIRECT[id] || DIRECT[id.replace(/^job_application\[|\]$/g, '')];
        /* The never-fill rule still runs: a direct id match does not
           bypass it. */
        if (direct && !window.TLAF_FIELDS.neverFill(el, window.TLAF_FIELDS.labelText(el))) {
          return { el: el, key: direct };
        }
        return { el: el, key: window.TLAF_FIELDS.matchField(el) };
      });
    },
  };
}());
