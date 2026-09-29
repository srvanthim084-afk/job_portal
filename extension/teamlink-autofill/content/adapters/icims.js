/* =====================================================================
   iCIMS — *.icims.com

   iCIMS renders the application inside an iframe on the employer's own
   domain as often as not, and names its fields with a numeric suffix
   (field_1234). Neither is matchable in general, so this adapter is
   thin: it recognises the iCIMS field wrapper and otherwise defers
   entirely to the label matcher.

   COVERAGE IS POOR AND IS REPORTED AS POOR. What would improve it is a
   per-tenant map, which means visiting a tenant to build one - that is
   a real piece of work, not a line of code, and it is not pretended to
   be done here.
   ===================================================================== */
/* global window, document */
(function () {
  'use strict';

  window.TLAF_ADAPTERS = window.TLAF_ADAPTERS || {};
  window.TLAF_ADAPTERS.icims = {
    key: 'icims',
    name: 'iCIMS',
    matches: function () { return /icims\.com$/i.test(location.hostname); },
    root: function () {
      return document.querySelector('#icims_content_iframe')
        || document.querySelector('form') || document;
    },
    detect: function (root) { return window.TLAF_ADAPTERS.generic.detect(root); },
    fields: function (root) { return window.TLAF_ADAPTERS.generic.fields(root); },
    caveat: 'iCIMS names its fields differently for every employer, so '
      + 'fewer of them are matched. Check every box before you submit.',
  };
}());
