/*
 * Candidate Home: "⚡ Action Required" — from the server's own data, and
 * directly under Search Jobs.
 *
 * The strip existed (index.html, window.__actionStrip), but it read its AI
 * interviews from the browser's lifecycle store (localStorage) and was
 * inserted at the very top of the page, above Search Jobs. Now:
 *
 *   ORDER     Search Jobs  ->  Action Required  ->  profile completion and
 *             statistics (the "Profile NN% complete / Search appearances /
 *             Recruiter actions" strip, profile views, "Complete your
 *             profile")  ->  everything else, in its existing order.
 *
 *   DATA      A pending AI interview is an application of this candidate
 *             that the server gave a deadline (ai_interview_due_at, 0015),
 *             still at Applied or AI Screening, with no completed AI
 *             interview - exactly the rule ai_interview_due_queue() uses
 *             for reminders, so the strip and the reminders never disagree.
 *             Scheduled interviews come from DATA.interviews (server).
 *             Completed ones drop out on the next paint.
 *
 *   DATES     "Due in N days" / "Due today" / "Due tomorrow" / "Overdue",
 *             counted in calendar days in India time from the deadline the
 *             server stored and the device's current time.
 *
 *   BUTTON    "Attend AI Interview" opens the existing AI interview page
 *             (#/ai-interview/<application>) for THAT application; nothing
 *             new is created.
 *
 * No items -> no section. The count reads "1 item needs your attention" /
 * "N items need your attention".
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__tlActionRequired) return;
  window.__tlActionRequired = true;

  var PENDING_STAGES = ['applied', 'ai_screening'];
  var CLOSED_MSG = 'You applied for this job, but the date is over, so you cannot attend the interview now.';
  var DAY = 86400000;
  var IST_OFFSET = 330 * 60000;

  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function jobOf(id) { try { return (window.DATA && DATA.jobById) ? DATA.jobById(id) : null; } catch (e) { return null; } }

  /* the calendar day number of an instant, in India time */
  function istDay(t) { return Math.floor((t + IST_OFFSET) / DAY); }
  function fmtDate(t) {
    try {
      return new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    } catch (e) { return new Date(t).toDateString(); }
  }
  /** {text, tone} for a deadline, against now. */
  function dueState(dueMs, nowMs) {
    if (!(dueMs > 0)) return null;
    if (dueMs < nowMs) return { text: 'Overdue', tone: 'bad' };
    var d = istDay(dueMs) - istDay(nowMs);
    if (d <= 0) return { text: 'Due today', tone: 'warn' };
    if (d === 1) return { text: 'Due tomorrow', tone: 'warn' };
    return { text: 'Due in ' + d + ' days', tone: 'ai' };
  }

  function completedApps() {
    var done = Object.create(null);
    (window.TL && TL.aiInterviews || []).forEach(function (x) {
      if (x && x.applicationId && String(x.status || '').toLowerCase() === 'completed') done[x.applicationId] = true;
    });
    return done;
  }

  /** The server's pending AI interviews and scheduled interviews for this candidate, soonest first. */
  function items(c) {
    var out = [];
    if (!c || !window.DATA) return out;
    var now = Date.now();
    var done = completedApps();
    (DATA.applications || []).forEach(function (a) {
      if (!a || a.candidateId !== c.id) return;
      if (PENDING_STAGES.indexOf(a.stage) < 0) return;
      if (done[a.id]) return;
      var due = Date.parse(a.aiInterviewDueAt || '');
      var j = jobOf(a.jobId);
      var title = (j && j.title) || 'your application';
      /* 0133: closed when the job is (closed, last date passed, walk-in over) or the interview's own date
         passed - the server says which. Shown, not counted: there is nothing left to do. */
      if (a.aiInterviewOpen === false) {
        if (a.aiInterviewClosedReason === 'not_required') return;     // 0138: this walk-in has no AI interview
        out.push({ kind: 'ai_closed', appId: a.id, jobId: a.jobId, title: title, due: Infinity });
        return;
      }
      /* a job with no date: no deadline - attend any time while the job is open */
      out.push({ kind: 'ai', appId: a.id, jobId: a.jobId, candidateId: c.id, title: title,
        due: due > 0 ? due : Infinity, hasDue: due > 0,
        state: due > 0 ? dueState(due, now) : { text: 'Attend any time', tone: 'ai' } });
    });
    (DATA.interviews || []).forEach(function (iv) {
      if (!iv || iv.candidateId !== c.id) return;
      var st = String(iv.status || '');
      if (/completed|cancel|no.?show/i.test(st)) return;
      var j = jobOf(iv.jobId);
      var at = Date.parse((iv.date || '') + (iv.time && /^\d{1,2}:\d{2}/.test(iv.time) ? 'T' + iv.time : ''));
      /* 0133: an interview whose date has passed is not upcoming */
      var dayOf = Date.parse(iv.date || '');
      if (dayOf > 0 && istDay(dayOf) < istDay(now)) return;
      out.push({ kind: 'interview', jobId: iv.jobId, title: (j && j.title) || 'Interview', round: iv.type || 'Interview',
        when: [iv.date, iv.time].filter(Boolean).join(' · '), due: at > 0 ? at : Infinity });
    });
    out.sort(function (x, y) { return x.due - y.due; });
    return out;
  }

  function row(it) {
    if (it.kind === 'ai_closed') {
      return '<div class="tlar-item tlar-closed">'
        + '<div class="tlar-info"><b>🔒 AI Interview Closed</b>'
        + '<div class="tlar-sub">' + h(it.title) + ' · ' + h(CLOSED_MSG) + '</div></div></div>';
    }
    if (it.kind === 'ai') {
      var st = it.state || { text: '', tone: '' };
      return '<div class="tlar-item">'
        + '<div class="tlar-info"><b>🎙️ AI Interview Pending</b>'
        + '<div class="tlar-sub">' + h(it.title) + (it.hasDue ? ' · Complete by ' + h(fmtDate(it.due)) : ' · No deadline')
        + (st.text ? ' · <span class="tlar-' + st.tone + '">' + h(st.text) + '</span>' : '') + '</div></div>'
        + '<button type="button" class="tlar-btn" onclick="tlarAttend(\'' + h(it.appId) + '\')"'
        + ' aria-label="Attend AI Interview for ' + h(it.title) + '">Attend AI Interview</button></div>';
    }
    return '<div class="tlar-item tlar-iv">'
      + '<div class="tlar-info"><b>📅 ' + h(it.round) + ' Scheduled</b>'
      + '<div class="tlar-sub">' + h(it.title) + (it.when ? ' · ' + h(it.when) : '') + '</div></div>'
      + '<button type="button" class="tlar-btn ghost" onclick="navigate(\'/candidate/interviews\')">View interview</button></div>';
  }

  function stripHtml(c) {
    var list = items(c);
    if (!list.length) return '';
    /* the count is what still needs doing; a closed interview is shown, not counted */
    var n = list.filter(function (x) { return x.kind !== 'ai_closed'; }).length;
    if (!n) return '<section class="tlar" id="tlActionRequired" aria-labelledby="tlarH">'
      + '<div class="tlar-hd"><h2 id="tlarH">⚡ Action Required</h2><span class="tlar-count">Nothing needs your attention</span></div>'
      + '<div class="tlar-list">' + list.map(row).join('') + '</div></section>';
    return '<section class="tlar" id="tlActionRequired" aria-labelledby="tlarH">'
      + '<div class="tlar-hd"><h2 id="tlarH">⚡ Action Required</h2><span class="tlar-count">'
      + n + ' item' + (n === 1 ? ' needs' : 's need') + ' your attention</span></div>'
      + '<div class="tlar-list">' + list.map(row).join('') + '</div></section>';
  }

  /* The old injector (index.html, ACTION-REQUIRED STRIP INJECTOR) puts
     whatever __actionStrip returns at the top of the page. From here on it
     is fed the server-data strip, which is then MOVED under Search Jobs. */
  window.__actionStrip = function (c, section) {
    if (!c || ['home', 'profile', 'applications'].indexOf(section) < 0) return '';
    return stripHtml(c);
  };

  /** Attend: the existing AI interview page for this application. */
  window.tlarAttend = function (appId) {
    var a = (DATA.applications || []).filter(function (x) { return x.id === appId; })[0];
    if (!a) return;
    var rec = typeof window.__lcRecFor === 'function' ? window.__lcRecFor(a.candidateId, a.jobId) : null;
    if (!rec && window.TL && typeof TL.ensureLocalRecords === 'function') {
      try { TL.ensureLocalRecords(); } catch (e) { /* the page below says so */ }
      rec = typeof window.__lcRecFor === 'function' ? window.__lcRecFor(a.candidateId, a.jobId) : null;
    }
    var ref = (rec && rec.applicationId) || a.applicationId || a.reference || a.id;
    window.navigate('/ai-interview/' + encodeURIComponent(ref));
  };

  /* ---- order on the candidate Home ---- */
  function arrange() {
    if (!/^#\/candidate\/home\b/.test(location.hash || '') && !/^#\/candidate\/?$/.test(location.hash || '')) return;
    var wrap = document.querySelector('.cp-wrap');
    if (!wrap) return;
    var hero = wrap.querySelector(':scope > .cp-hero');
    if (!hero) return;
    var strips = wrap.querySelectorAll('#tlActionRequired');
    for (var i = 1; i < strips.length; i++) strips[i].remove();         // never two
    var action = strips[0] || null;
    var stats = wrap.querySelector(':scope > .pstrip');
    var views = wrap.querySelector(':scope > .tlpv-home');
    var banner = null;
    Array.prototype.forEach.call(wrap.children, function (el) {
      if (!banner && el.classList.contains('cp-card') && /Complete your profile to get better matches/.test(el.textContent || '')) banner = el;
    });
    var after = hero;
    [action, stats, views, banner].forEach(function (el) {
      if (!el) return;
      if (after.nextElementSibling !== el) after.insertAdjacentElement('afterend', el);
      after = el;
    });
  }

  var queued = false;
  function soon() {
    if (queued) return;
    queued = true;
    setTimeout(function () { queued = false; try { arrange(); } catch (e) { /* cosmetic */ } }, 0);
  }
  function install() {
    if (typeof window.render !== 'function') return setTimeout(install, 50);
    var prev = window.render;
    if (!prev.__tlar) {
      var next = function () { var r = prev.apply(this, arguments); soon(); return r; };
      next.__tlar = true;
      window.render = next;
    }
    try {
      /* subtree: other modules repaint parts of the Home inside .cp-wrap
         without a full render. arrange() only moves what is out of order,
         so it settles at once and never loops. */
      new MutationObserver(function () { soon(); }).observe(document.getElementById('app') || document.body, { childList: true, subtree: true });
    } catch (e) { /* render() covers it */ }
    soon();
  }

  var css = ''
    + '.tlar{background:#fff;border:1.5px solid var(--ai-500,#7c3aed);border-radius:14px;margin:14px 0 16px;overflow:hidden}'
    + '.tlar-hd{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding:14px 18px;border-bottom:1px solid #eceff4}'
    + '.tlar-hd h2{margin:0;font-size:15px;font-weight:800;color:#16202c}'
    + '.tlar-count{font-size:12.5px;color:#6b7a8d}'
    + '.tlar-list{display:flex;flex-direction:column;gap:10px;padding:14px 18px 16px}'
    + '.tlar-item{display:flex;align-items:center;justify-content:space-between;gap:14px;border:1px solid #e6e9f0;'
      + 'border-left:3px solid var(--ai-500,#7c3aed);border-radius:10px;padding:12px 14px;background:#fff}'
    + '.tlar-item.tlar-iv{border-left-color:var(--brand-500,#1d6ff2)}'
    + '.tlar-info{min-width:0}'
    + '.tlar-info b{font-size:13.5px;color:#16202c}'
    + '.tlar-sub{font-size:12.5px;color:#5b6878;margin-top:3px;overflow-wrap:anywhere}'
    + '.tlar-ai{color:var(--ai-600,#6d28d9);font-weight:700}'
    + '.tlar-warn{color:#b45309;font-weight:700}'
    + '.tlar-bad{color:#dc2626;font-weight:700}'
    + '.tlar-btn{flex:0 0 auto;border:0;border-radius:8px;padding:8px 14px;font:inherit;font-size:13px;font-weight:700;'
      + 'cursor:pointer;background:var(--ai-500,#7c3aed);color:#fff;white-space:nowrap}'
    + '.tlar-btn:hover{filter:brightness(.95)}'
    + '.tlar-btn:focus-visible{outline:3px solid #c4b5fd;outline-offset:2px}'
    + '.tlar-btn.ghost{background:#eef3fb;color:#1d4ed8}'
    + '.tlar-closed{background:#f7f8fa;border-left-color:#b8c0cc}.tlar-closed b{color:#5f6b7a}'
    + '@media (max-width:640px){.tlar-item{flex-direction:column;align-items:stretch}.tlar-btn{width:100%;white-space:normal}}';
  try {
    var st = document.createElement('style');
    st.id = 'tlarStyle';
    st.textContent = css;
    document.head.appendChild(st);
  } catch (e) { /* no styles, still works */ }

  install();
  window.TLActionRequired = { items: items, dueState: dueState };
})();
