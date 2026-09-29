/* =====================================================================
   Workday — *.myworkdayjobs.com

   THE HARDEST OF THE FOUR, AND THIS ADAPTER SAYS SO.

   Workday renders a React application with generated ids
   (input-42, gwt-uid-17) and no stable names. What it does have is
   `data-automation-id`, which its own test suite relies on and which is
   therefore the most stable thing on the page - so that is what is
   matched, and only where the value is one of the handful that is
   consistent across tenants.

   Everything else falls through to the label matcher, and a good deal
   of it will not match: Workday splits an application across five or six
   steps, uses custom listbox widgets instead of <select> for country and
   phone code, and asks tenant-specific questions that no dictionary can
   anticipate. Those are reported as unfilled. That is the honest
   outcome, and the summary tells the candidate which ones to complete.
   ===================================================================== */
/* global window, document */
(function () {
  'use strict';

  var AUTOMATION = {
    'legalNameSection_firstName': 'firstName',
    'legalNameSection_lastName': 'lastName',
    'email': 'email',
    'addressSection_addressLine1': 'city',
    'addressSection_city': 'city',
    'addressSection_countryRegion': 'state',
    'phone-number': 'phone',
    'phoneNumber': 'phone',
    'formField-phoneNumber': 'phone',
    'preferredNameSection_firstName': 'preferredFirstName',
  };

  /** Every data-automation-id on or above this input. */
  function automationIds(el) {
    var out = [], node = el;
    for (var i = 0; node && i < 4; i++) {
      var id = node.getAttribute && node.getAttribute('data-automation-id');
      if (id) out.push(id);
      node = node.parentElement;
    }
    return out;
  }

  function fromAutomation(el) {
    var ids = automationIds(el);
    for (var i = 0; i < ids.length; i++) if (AUTOMATION[ids[i]]) return AUTOMATION[ids[i]];
    return null;
  }

  window.TLAF_ADAPTERS = window.TLAF_ADAPTERS || {};
  window.TLAF_ADAPTERS.workday = {
    key: 'workday',
    name: 'Workday',
    matches: function () { return /myworkdayjobs\.com$/i.test(location.hostname); },
    root: function () {
      return document.querySelector('[data-automation-id="applyFlowPage"]')
        || document.querySelector('form') || document;
    },
    detect: function (root) {
      return !!document.querySelector('[data-automation-id="applyFlowPage"], '
        + '[data-automation-id="legalNameSection_firstName"]')
        || window.TLAF_ADAPTERS.generic.detect(root);
    },
    fields: function (root) {
      var g = window.TLAF_ADAPTERS.generic;
      return g.inputs(root).map(function (el) {
        /*
         * THE AUTOMATION ID IS PART OF THE NEVER-FILL CHECK.
         *
         * Workday puts data-automation-id="ssn" on the WRAPPER and
         * leaves the input itself anonymous - no name, no id, no label.
         * Measured: such a field was not filled, but only because
         * nothing matched it, not because anything refused it. Safe by
         * accident is not safe. The ids are fed to the same check as
         * every other word around the field.
         */
        var text = window.TLAF_FIELDS.labelText(el) + ' ' + automationIds(el).join(' ');
        if (window.TLAF_FIELDS.neverFill(el, text)) return { el: el, key: null, blocked: true };
        var a = fromAutomation(el);
        return { el: el, key: a || window.TLAF_FIELDS.matchField(el) };
      });
    },
    /* Said out loud in the popup, because a candidate who believes the
       form was filled will not re-read it. */
    caveat: 'Workday spreads an application over several steps and uses '
      + 'custom pickers for country and phone code. Expect to complete '
      + 'those yourself.',
  };
}());
