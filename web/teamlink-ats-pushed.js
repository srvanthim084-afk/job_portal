/* =====================================================================
   TEAMLINK - "Pushed to ATS"

   An application that was moved INTO the ATS (Shortlisted) by a rule or
   by the "Send to ATS" button says so, and says how:

     ✓ Pushed to ATS
       Automatically · screening score 72% · 14 Oct, 10:09 am     the 65% rule
       Automatically · AI interview 71% · 14 Oct, 11:30 am        the AI interview's pass mark
       By a recruiter · Send to ATS · 14 Oct, 2:05 pm             the button

   The facts come from the application itself (atsPushedAt / atsPushedVia /
   atsPushedScore, remembered by the server at the moment of the move,
   migration 0145). A recruiter who just moves an application to
   Shortlisted by hand is not "pushed" and gets no badge. Used by the
   recruiter's Applications table, the candidate record's application
   list and the job's applicants window: tlAtsPushBadge(app) -> html.
   ===================================================================== */
(function () {
  'use strict';
  if (window.tlAtsPushBadge) return;

  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    try {
      return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(d).replace(/\s?(am|pm)/i, function (m) { return m.toLowerCase(); });
    } catch (e) { return ''; }
  }
  function how(a) {
    var sc = a.atsPushedScore != null && isFinite(a.atsPushedScore) ? ' ' + Math.round(a.atsPushedScore) + '%' : '';
    if (a.atsPushedVia === 'auto_screening') return 'Automatically · screening score' + sc;
    if (a.atsPushedVia === 'auto_ai_interview') return 'Automatically · AI interview' + sc;
    if (a.atsPushedVia === 'send_to_ats') return 'By a recruiter · Send to ATS';
    return '';
  }

  window.tlAtsPushBadge = function (a) {
    if (!a || !a.atsPushedAt || !a.atsPushedVia) return '';
    var why = how(a);
    if (!why) return '';
    var at = when(a.atsPushedAt);
    var full = why + (at ? ' · ' + at + ' IST' : '');
    return '<div class="tlap" data-tlap="' + h(a.atsPushedVia) + '">'
      + '<span class="tlap-b" title="' + h(full) + '">✓ Pushed to ATS</span>'
      + '<span class="tlap-s">' + h(why) + (at ? ' · ' + h(at) : '') + '</span></div>';
  };

  var css = document.createElement('style');
  css.textContent = [
    '.tlap{margin-top:5px;line-height:1.3}',
    '.tlap-b{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.01em;color:#16703d;background:#e3f6ea;border-radius:999px;padding:2px 9px;white-space:nowrap}',
    '.tlap-s{display:block;margin-top:3px;font-size:11px;color:#6a7a8c;max-width:210px;white-space:normal}',
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .tlap-b{background:rgba(22,163,74,.2);color:#7ee0a3}:root:not([data-theme="light"]) .tlap-s{color:#9aa8ba}}',
    ':root[data-theme="dark"] .tlap-b{background:rgba(22,163,74,.2);color:#7ee0a3}:root[data-theme="dark"] .tlap-s{color:#9aa8ba}',
  ].join('\n');
  document.head.appendChild(css);
})();
