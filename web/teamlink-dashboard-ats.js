/*
 * TeamLink — the candidate's application tracker and dashboard counts, and
 * the recruiter's ATS candidate record (0111).
 *
 * ADDITIVE, in the existing screens and their own classes (cp-card, cp-two,
 * cp-step, pstrip, panel, table.data). No page, nav item or module is
 * added; nothing is redesigned. Every number comes from the server
 * (api/src/routes/ats-record.js); nothing is kept in localStorage.
 *
 *   Candidate Home         Applications / Shortlisted / Interviews / Saved
 *                          Jobs / Profile Strength; "Application status"
 *                          becomes the Application tracker (Applied ->
 *                          HR Review -> Shortlisted -> Interview -> Offer ->
 *                          Hired, plus Rejected / On Hold) from real stages;
 *                          Upcoming interviews with mode, venue and state;
 *                          Saved jobs and Notifications widgets; an
 *                          optional "Refer a friend" card.
 *   My Applications        Application ID, job type, status, last updated,
 *                          next interview on every card; search (debounced)
 *                          and pages, answered by the server.
 *   Interviews             state (Scheduled / Rescheduled / Completed /
 *                          Cancelled), mode (Walk-in / Online / Phone /
 *                          Hybrid) and venue; walk-in interviews listed.
 *   Recruiter candidate    the ATS record: Candidate ID, contact, Profile
 *   profile                and Resume score, current stage, source, last
 *                          updated, skills, experience, applications with
 *                          matching (Resume / Profile score, Eligibility,
 *                          Match score), interview history, the timeline,
 *                          assessments (extension point) and the referral.
 *   Admin Reports          the audit log and the employee hand-off queue.
 *   Admin Analytics        portal analytics by job type (no personal data).
 *   Job pages              one anonymous view count per job per tab.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__tlY2) return;
  window.__tlY2 = true;

  var api = function () { return window.TL && TL.api; };
  var h = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var role = function () { return (window.STATE && STATE.session && STATE.session.role) || null; };
  var hash = function () { return String(location.hash || ''); };
  var say = function (m, i) { if (typeof window.toast === 'function') toast(m, i || '✓'); };
  var fmtDate = function (iso) {
    if (!iso) return '';
    var d = new Date(String(iso).length === 10 ? iso + 'T00:00:00+05:30' : iso);
    if (isNaN(d)) return String(iso);
    try { return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }); }
    catch (e) { return d.toDateString(); }
  };
  var fmtWhen = function (iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    try {
      return fmtDate(iso) + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
    } catch (e) { return d.toLocaleString(); }
  };
  var debounce = function (fn, ms) {
    var t = null;
    return function () { var a = arguments, s = this; clearTimeout(t); t = setTimeout(function () { fn.apply(s, a); }, ms); };
  };

  /* ------------------------------------------------------------------ *
   * cache: one in-flight request per key, refreshed when older than TTL
   * ------------------------------------------------------------------ */
  var C = {};
  var TTL = 15000;
  function load(key, path, cb, force) {
    var e = C[key] || (C[key] = { data: null, at: 0, busy: false, err: null, path: path });
    if (e.path !== path) { e.path = path; e.at = 0; e.data = null; }
    if (e.busy || (!force && e.data && Date.now() - e.at < TTL)) return e;
    if (!api()) return e;
    e.busy = true;
    api().get(path).then(function (r) {
      e.busy = false; e.data = r; e.at = Date.now(); e.err = null;
      if (e.path === path) { try { cb(r); } catch (x) { /* cosmetic */ } }
    }, function (err) {
      e.busy = false; e.at = Date.now(); e.err = (err && err.message) || 'Could not load.';
      try { cb(null); } catch (x) { /* cosmetic */ }
    });
    return e;
  }
  window.TLDashboardAts = { refresh: function () { C = {}; paintSoon(); }, cache: function () { return C; } };

  /* ================================================================== *
   * CANDIDATE HOME
   * ================================================================== */
  function trackHtml(app) {
    var steps = (app.steps || []).map(function (s) {
      var cls = s.state === 'current' ? 'on' : (s.state === 'done' ? 'done' : '');
      return '<span class="cp-step ' + cls + '"' + (s.at ? ' title="' + h(fmtDate(s.at)) + '"' : '') + '>' + h(s.label) + '</span>';
    }).join('<span class="cp-arrow">›</span>');
    if (app.offLine) {
      steps += '<span class="cp-arrow">›</span><span class="cp-step bad">' + h(app.offLine.label) + '</span>';
    }
    return '<div class="cp-track tly2-track" data-phase="' + h(app.phase) + '">' + steps + '</div>';
  }

  function countsHtml(d) {
    var c = d.counts;
    var tile = function (k, n, label, href) {
      return '<div class="c" data-count="' + k + '" role="link" tabindex="0" onclick="location.hash=\'' + href + '\'">'
        + '<div><b>' + h(n) + '</b><span>' + h(label) + '</span></div></div>';
    };
    return '<div class="pstrip tly2-counts" id="tlY2Counts" aria-label="Your dashboard">'
      + tile('applications', c.applications, 'Applications', '#/candidate/applications')
      + tile('shortlisted', c.shortlisted, 'Shortlisted', '#/candidate/applications')
      + tile('interviews', c.interviews, 'Upcoming interviews', '#/candidate/interviews')
      + tile('savedJobs', c.savedJobs, 'Saved jobs', '#/candidate/saved')
      + tile('profileStrength', c.profileStrength + '%', 'Profile strength · ' + strengthWord(c.profileStrength), '#/candidate/profile')
      + '</div>';
  }
  function strengthWord(p) { return p >= 90 ? 'Excellent' : p >= 70 ? 'Good' : p >= 40 ? 'Fair' : 'Incomplete'; }

  function trackerBody(d) {
    var chips = d.tracker.phases.map(function (p) {
      return '<span class="tly2-chip' + (p.count ? ' on' : '') + '" data-phase="' + h(p.id) + '">' + h(p.label)
        + ' <b>' + h(p.count) + '</b></span>';
    }).join('');
    var apps = d.recentApplications || [];
    return '<div class="tly2-chips" aria-label="Applications by status">' + chips + '</div>'
      + (apps.length ? apps.map(function (a) {
        return '<div class="tly2-app" data-app="' + h(a.applicationId) + '">'
          + '<div class="tly2-row"><b style="font-size:13px">' + h(a.jobTitle) + '</b>'
          + '<span class="tly2-status s-' + h(a.phase) + '">' + h(a.status) + '</span></div>'
          + '<div style="font-size:11.5px;color:#8a94a6">' + h([a.company, a.reference, a.jobType].filter(Boolean).join(' · ')) + '</div>'
          + trackHtml(a) + '</div>';
      }).join('')
        : '<div class="cp-empty" style="padding:18px"><p>No applications yet.</p><button class="cp-btn pri" onclick="location.hash=\'#/candidate/search\'">Browse Jobs</button></div>');
  }

  function ivLine(i) {
    return '<div class="tly2-iv" data-iv="' + h(i.id) + '">'
      + '<div class="tly2-row"><b style="font-size:13px">' + h(fmtDate(i.date) || 'Date to be confirmed') + (i.time ? ' · ' + h(i.time) : '') + '</b>'
      + '<span class="tly2-status s-' + h(String(i.state).toLowerCase()) + '">' + h(i.state) + '</span></div>'
      + '<div style="font-size:11.5px;color:#8a94a6">' + h([i.round, i.jobTitle, i.company].filter(Boolean).join(' · ')) + '</div>'
      + '<div class="tly2-meta"><span class="tly2-mode">' + h(i.mode) + '</span>' + (i.venue ? ' ' + h(i.venue) : '') + '</div></div>';
  }

  function moreWidgets(d) {
    var saved = [];
    try { saved = (STATE.savedJobs ? Array.from(STATE.savedJobs) : []).map(function (id) { return DATA.jobById(id); }).filter(Boolean); }
    catch (e) { saved = []; }
    var n = d.notifications || { unread: 0, latest: [] };
    return '<div class="cp-two" id="tlY2More" style="margin-top:16px">'
      + '<div class="cp-card"><div class="cp-h2" style="margin:0 0 8px"><h2 style="font-size:15px">Saved jobs</h2><a onclick="location.hash=\'#/candidate/saved\'">View all (' + h(d.counts.savedJobs) + ')</a></div>'
      + (saved.length ? saved.slice(0, 3).map(function (j) {
        var co = (DATA.companyById && DATA.companyById(j.companyId)) || {};
        return '<div style="padding:8px 0;border-bottom:1px solid #f4f6fa;cursor:pointer" onclick="navigate(\'/job/' + h(j.id) + '\')"><b style="font-size:13px">' + h(j.title) + '</b>'
          + '<div style="font-size:11.5px;color:#8a94a6">' + h([co.name, j.location].filter(Boolean).join(' · ')) + '</div></div>';
      }).join('') : '<div class="cp-empty" style="padding:18px"><p>' + (d.counts.savedJobs ? h(d.counts.savedJobs) + ' saved' : 'No saved jobs yet — tap Save on a job to keep it here.') + '</p></div>')
      + '</div>'
      + '<div class="cp-card"><div class="cp-h2" style="margin:0 0 8px"><h2 style="font-size:15px">Notifications</h2><span style="font-size:12px;color:#7b8794">' + h(n.unread) + ' unread</span></div>'
      + (n.latest.length ? n.latest.slice(0, 3).map(function (x) {
        return '<div style="padding:8px 0;border-bottom:1px solid #f4f6fa"><b style="font-size:12.5px;' + (x.read ? 'font-weight:600' : '') + '">' + h(x.title || 'Update') + '</b>'
          + '<div style="font-size:11.5px;color:#7b8794;overflow-wrap:anywhere">' + h(String(x.message || '').slice(0, 140)) + '</div>'
          + '<div style="font-size:10.5px;color:#a0aab8">' + h(fmtWhen(x.at)) + '</div></div>';
      }).join('') : '<div class="cp-empty" style="padding:18px"><p>No notifications yet.</p></div>')
      + '</div></div>';
  }

  var REF = { open: false, data: null, err: null };
  function referralCard() {
    var body;
    if (!REF.open) {
      body = '<p style="font-size:12.5px;color:#42505f;margin:0 0 10px">Know someone looking for a job? Share your personal link. Entirely optional — nobody has to use it.</p>'
        + '<button class="cp-btn" onclick="tlY2Referral()">Get my referral link</button>';
    } else if (!REF.data) {
      body = '<p style="font-size:12.5px;color:#7b8794">' + h(REF.err || 'Loading…') + '</p>';
    } else {
      var link = location.origin + location.pathname + '?ref=' + encodeURIComponent(REF.data.code) + '#/register/candidate';
      var made = REF.data.referrals || [];
      body = '<div style="font-size:12.5px;color:#42505f">Your code <b id="tlY2RefCode">' + h(REF.data.code) + '</b></div>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center"><input readonly id="tlY2RefLink" value="' + h(link) + '" aria-label="Your referral link" style="flex:1;min-width:0;border:1px solid #dde4ec;border-radius:8px;padding:8px 10px;font-size:12px">'
        + '<button class="cp-btn" onclick="tlY2CopyRef()">Copy link</button></div>'
        + '<div style="font-size:12px;color:#7b8794;margin-top:8px" id="tlY2RefList">' + (made.length
          ? made.length + ' referral' + (made.length === 1 ? '' : 's') + ': ' + made.map(function (r) { return h(fmtDate(r.referredAt)) + ' — ' + h(r.status.replace('_', ' ')); }).join(' · ')
          : 'No referrals yet.') + '</div>';
    }
    var sig = String(REF.open) + '|' + (REF.data ? REF.data.code + ':' + (REF.data.referrals || []).length : '') + '|' + (REF.err ? 'e' : '');
    return '<div class="cp-card" id="tlY2Ref" data-sig="' + h(sig) + '" style="margin-top:16px"><h2 style="margin:0 0 8px;font-size:15px">Refer a friend <span style="font-size:11.5px;font-weight:600;color:#8a94a6">(optional)</span></h2>' + body + '</div>';
  }
  window.tlY2Referral = function () {
    REF.open = true; REF.err = null; paintHome();
    api().get('/candidate/referral').then(function (r) { REF.data = r; paintHome(); },
      function (e) { REF.err = (e && e.message) || 'Could not load your link.'; paintHome(); });
  };
  window.tlY2CopyRef = function () {
    var el = document.getElementById('tlY2RefLink');
    if (!el) return;
    try { navigator.clipboard.writeText(el.value).then(function () { say('Link copied', '🔗'); }, function () { el.select(); }); }
    catch (e) { el.select(); }
  };

  function findCard(wrap, title) {
    var out = null;
    Array.prototype.forEach.call(wrap.querySelectorAll('.cp-card'), function (el) {
      var t = el.querySelector('h2');
      if (!out && t && t.textContent.trim() === title) out = el;
    });
    return out;
  }
  function setBody(card, html, newTitle) {
    var head = card.querySelector('.cp-h2');
    if (!head) return;
    if (newTitle) head.querySelector('h2').textContent = newTitle;
    while (head.nextSibling) card.removeChild(head.nextSibling);
    head.insertAdjacentHTML('afterend', '<div data-y2="1">' + html + '</div>');
  }

  function paintHome() {
    var wrap = document.querySelector('.cp-wrap');
    if (!wrap || !/^#\/candidate\/home/.test(hash())) return;
    var e = load('dash', '/candidate/dashboard', paintHome);
    var d = e.data;
    if (!d) return;
    var stamp = String(e.at);

    var counts = document.getElementById('tlY2Counts');
    if (!counts || counts.getAttribute('data-at') !== stamp) {
      if (counts) counts.remove();
      var anchor = wrap.querySelector(':scope > .pstrip:not(.tly2-counts)');
      var after = anchor;
      Array.prototype.forEach.call(wrap.children, function (el) {
        if (el.classList.contains('tlpv-home') || (el.classList.contains('cp-card') && /Complete your profile to get better matches/.test(el.textContent || ''))) after = el;
      });
      var html = countsHtml(d);
      if (after) after.insertAdjacentHTML('afterend', html); else wrap.insertAdjacentHTML('afterbegin', html);
      counts = document.getElementById('tlY2Counts');
      if (counts) counts.setAttribute('data-at', stamp);
    }

    var tracker = findCard(wrap, 'Application status') || findCard(wrap, 'Application tracker');
    if (tracker && tracker.getAttribute('data-at') !== stamp) {
      setBody(tracker, trackerBody(d), 'Application tracker');
      tracker.id = 'tlY2Tracker';
      tracker.setAttribute('data-at', stamp);
    }
    var ivCard = findCard(wrap, 'Upcoming interviews');
    if (ivCard && ivCard.getAttribute('data-at') !== stamp) {
      var ivs = d.upcomingInterviews || [];
      setBody(ivCard, ivs.length ? ivs.map(ivLine).join('')
        : '<div class="cp-empty" style="padding:18px"><p>No interviews scheduled yet.</p></div>');
      ivCard.id = 'tlY2Interviews';
      ivCard.setAttribute('data-at', stamp);
    }
    var row = tracker && tracker.parentElement && tracker.parentElement.classList.contains('cp-two') ? tracker.parentElement : null;
    var more = document.getElementById('tlY2More');
    if (row && (!more || more.getAttribute('data-at') !== stamp)) {
      if (more) more.remove();
      row.insertAdjacentHTML('afterend', moreWidgets(d));
      more = document.getElementById('tlY2More');
      if (more) more.setAttribute('data-at', stamp);
    }
    var ref = document.getElementById('tlY2Ref');
    var refHtml = referralCard();
    if (!ref) {
      var fab = wrap.querySelector(':scope > .cp-fab');
      if (fab) fab.insertAdjacentHTML('beforebegin', refHtml); else wrap.insertAdjacentHTML('beforeend', refHtml);
    } else if (ref.getAttribute('data-sig') !== (/data-sig="([^"]*)"/.exec(refHtml) || [])[1]) {
      ref.outerHTML = refHtml;
    }
  }

  /* ================================================================== *
   * MY APPLICATIONS: history (search + pages) on the existing cards
   * ================================================================== */
  /* 0130: from / to (the "Applied Date" calendar, India days) and the
     order - latest applied first unless the candidate asks for the oldest. */
  var HIST = { q: '', phase: '', page: 1, pageSize: 10, from: '', to: '', preset: '', sort: 'latest' };
  function histPath() {
    return '/candidate/applications/history?page=' + HIST.page + '&pageSize=' + HIST.pageSize
      + (HIST.q ? '&q=' + encodeURIComponent(HIST.q) : '') + (HIST.phase ? '&phase=' + encodeURIComponent(HIST.phase) : '')
      + (HIST.from ? '&from=' + HIST.from : '') + (HIST.to ? '&to=' + HIST.to : '')
      + (HIST.sort === 'oldest' ? '&sort=oldest' : '');
  }
  var histSearch = debounce(function (v) { HIST.q = String(v || '').trim(); HIST.page = 1; paintApplications(); }, 300);
  window.tlY2HistQ = function (v) { histSearch(v); };
  window.tlY2HistPhase = function (v) { HIST.phase = v; HIST.page = 1; paintApplications(); };
  window.tlY2HistPage = function (d) { HIST.page = Math.max(1, HIST.page + d); paintApplications(); };
  window.tlY2HistSort = function (v) { HIST.sort = v === 'oldest' ? 'oldest' : 'latest'; HIST.page = 1; paintApplications(); };
  window.tlY2HistDate = function (sel) {
    sel = sel || {};
    HIST.from = sel.from || ''; HIST.to = HIST.from ? (sel.to || sel.from) : ''; HIST.preset = HIST.from ? (sel.preset || '') : '';
    HIST.page = 1;
    var old = document.getElementById('tlY2AppTools'); if (old) old.remove();   // redrawn with the new field
    paintApplications();
  };
  /* One chip off, or all of them. */
  window.tlY2HistClear = function (k) {
    if (!k || k === 'q') HIST.q = '';
    if (!k || k === 'phase') HIST.phase = '';
    if (!k || k === 'date') { HIST.from = ''; HIST.to = ''; HIST.preset = ''; }
    HIST.page = 1;
    var old = document.getElementById('tlY2AppTools'); if (old) old.remove();
    paintApplications();
  };
  var PHASES = [['applied', 'Applied'], ['under_review', 'Under Review'], ['shortlisted', 'Shortlisted'], ['interview', 'Interview'], ['offer', 'Offer'],
    ['hired', 'Hired'], ['rejected', 'Rejected'], ['hold', 'On Hold']];
  function histChips() {
    var chips = [];
    var chip = function (text, k) {
      chips.push('<span class="tlao-chip" role="listitem">' + h(text) + '<button type="button" aria-label="Remove ' + h(text) + '" onclick="tlY2HistClear(\'' + k + '\')">✕</button></span>');
    };
    if (HIST.q) chip('Search: ' + HIST.q, 'q');
    if (HIST.phase) chip('Status: ' + ((PHASES.filter(function (p) { return p[0] === HIST.phase; })[0] || [])[1] || HIST.phase), 'phase');
    if (HIST.from && window.TLDateRange) chip('Applied Date: ' + TLDateRange.label({ from: HIST.from, to: HIST.to }), 'date');
    return chips.length ? '<div class="tlao-chips" id="tlY2AppChips" role="list" aria-label="Filters in use">' + chips.join('')
      + '<button type="button" class="tlao-clearall" onclick="tlY2HistClear(\'\')">Clear all</button></div>' : '';
  }

  function paintApplications() {
    var wrap = document.querySelector('.cp-wrap');
    if (!wrap || !/^#\/candidate\/applications/.test(hash())) return;
    var e = load('hist', histPath(), paintApplications);
    var d = e.data;
    var cards = Array.prototype.filter.call(wrap.querySelectorAll(':scope > .cp-card'), function (el) {
      return /navigate\('\/job\//.test(el.innerHTML) && !el.classList.contains('cp-empty');
    });
    var tools = document.getElementById('tlY2AppTools');
    if (!tools) {
      var sub = Array.prototype.filter.call(wrap.children, function (el) { return /applications? · (newest|oldest) first/.test(el.textContent || ''); })[0];
      var html = '<div id="tlY2AppTools" class="tly2-tools">'
        + '<input type="search" id="tlY2HistQ" placeholder="Search by job, company or Application ID" aria-label="Search your applications" value="' + h(HIST.q) + '" oninput="tlY2HistQ(this.value)">'
        + '<select id="tlY2HistPhase" aria-label="Filter by status" onchange="tlY2HistPhase(this.value)">'
        + '<option value="">All statuses</option>'
        + PHASES.map(function (p) {
          return '<option value="' + p[0] + '"' + (HIST.phase === p[0] ? ' selected' : '') + '>' + p[1] + '</option>';
        }).join('')
        + '</select>'
        + (window.TLDateRange ? '<span class="tly2-date" id="tlY2HistDate"><span class="tly2-dl">Applied Date</span>'
          + TLDateRange.field('candAppDate', { from: HIST.from, to: HIST.to, preset: HIST.preset, title: 'Applied Date', placeholder: 'Any date', onChange: window.tlY2HistDate }) + '</span>' : '')
        + '<select id="tlY2HistSort" aria-label="Sort applications" onchange="tlY2HistSort(this.value)">'
        + '<option value="latest"' + (HIST.sort !== 'oldest' ? ' selected' : '') + '>Latest applied first</option>'
        + '<option value="oldest"' + (HIST.sort === 'oldest' ? ' selected' : '') + '>Oldest first</option></select>'
        + '<span id="tlY2HistInfo" class="tly2-info" aria-live="polite"></span>'
        + '<span class="tly2-pager"><button class="cp-btn" id="tlY2Prev" onclick="tlY2HistPage(-1)">‹ Prev</button><button class="cp-btn" id="tlY2Next" onclick="tlY2HistPage(1)">Next ›</button></span></div>';
      if (sub) sub.insertAdjacentHTML('afterend', html);
      else if (cards[0]) cards[0].insertAdjacentHTML('beforebegin', html);
      else return;
      tools = document.getElementById('tlY2AppTools');
    }
    /* the chips follow the filters, typing included */
    var chipsHtml = histChips();
    var chipsEl = document.getElementById('tlY2AppChips');
    if (!chipsHtml) { if (chipsEl) chipsEl.remove(); }
    else if (!chipsEl) tools.insertAdjacentHTML('afterend', chipsHtml);
    else if (chipsEl.outerHTML !== chipsHtml) chipsEl.outerHTML = chipsHtml;
    var sub2 = Array.prototype.filter.call(wrap.children, function (el) { return /applications? · (newest|oldest) first/.test(el.textContent || ''); })[0];
    if (sub2) {
      var want = HIST.sort === 'oldest' ? 'oldest first' : 'newest first';
      if (sub2.textContent.indexOf(want) < 0) sub2.textContent = sub2.textContent.replace(/(newest|oldest) first/, want);
    }
    if (!d) return;
    var byJob = {};
    (d.rows || []).forEach(function (r) { byJob[r.jobId] = r; });
    cards.forEach(function (card) {
      var m = /navigate\('\/job\/([^']+)'\)/.exec(card.innerHTML);
      var row = m ? byJob[m[1]] : null;
      card.style.display = row ? '' : 'none';
      var meta = card.querySelector('.tly2-hist');
      if (row && (!meta || meta.getAttribute('data-at') !== String(e.at))) {
        if (meta) meta.remove();
        var iv = row.interview;
        var html = '<div class="tly2-hist" data-at="' + e.at + '" data-app="' + h(row.applicationId) + '">'
          + '<span><span class="k">Application ID</span> ' + h(row.reference || row.applicationId) + '</span>'
          + '<span><span class="k">Job type</span> ' + h(row.jobType) + '</span>'
          + '<span><span class="k">Status</span> <b class="tly2-status s-' + h(row.phase) + '">' + h(row.status) + '</b></span>'
          + '<span><span class="k">Last updated</span> ' + h(fmtDate(row.lastUpdated)) + '</span>'
          + (iv ? '<span><span class="k">Interview</span> ' + h([fmtDate(iv.date), iv.time, iv.mode, iv.state].filter(Boolean).join(' · ')) + '</span>' : '')
          + '<a class="tly2-open" onclick="navigate(\'/candidate-app/' + h(row.applicationId) + '\')">Open details ›</a></div>';
        var title = card.querySelector('div[style*="font-size:15.5px"]');
        var host = title ? title.parentElement : card;
        host.insertAdjacentHTML('beforeend', html);
      }
    });
    /* 0130: the cards in the order asked for (latest or oldest applied first). */
    var order = (d.rows || []).map(function (r) { return r.jobId; });
    var shown = cards.filter(function (c) { return c.style.display !== 'none'; });
    var jobOfCard = function (c) { var m = /navigate\('\/job\/([^']+)'\)/.exec(c.innerHTML); return m ? m[1] : ''; };
    var now = shown.map(jobOfCard);
    var want = order.filter(function (j) { return now.indexOf(j) >= 0; });
    if (want.join('|') !== now.join('|') && shown.length) {
      var at = shown[0].previousElementSibling;
      want.forEach(function (j) {
        var card = shown.filter(function (c) { return jobOfCard(c) === j; })[0];
        if (!card) return;
        if (at) at.insertAdjacentElement('afterend', card); else wrap.insertAdjacentElement('afterbegin', card);
        at = card;
      });
    }
    var info = document.getElementById('tlY2HistInfo');
    var pages = Math.max(1, Math.ceil((d.total || 0) / d.pageSize));
    if (info) info.textContent = d.total ? (d.total + ' application' + (d.total === 1 ? '' : 's')
      + ' · showing ' + ((d.page - 1) * d.pageSize + 1) + '–' + Math.min(d.total, d.page * d.pageSize) + ' of ' + d.total) : 'No applications match.';
    var prev = document.getElementById('tlY2Prev'), next = document.getElementById('tlY2Next');
    if (prev) prev.disabled = d.page <= 1;
    if (next) next.disabled = d.page >= pages;
    var pager = tools && tools.querySelector('.tly2-pager');
    if (pager) pager.style.display = pages > 1 ? '' : 'none';
  }

  /* ================================================================== *
   * INTERVIEWS: state, mode, venue; walk-in interviews
   * ================================================================== */
  function paintInterviews() {
    var wrap = document.querySelector('.cp-wrap');
    if (!wrap || !/^#\/candidate\/interviews/.test(hash())) return;
    var e = load('sched', '/candidate/interviews/schedule', paintInterviews);
    var d = e.data;
    if (!d) return;
    var byId = {};
    d.interviews.forEach(function (i) { byId[i.id] = i; });
    var tab = (window.STATE && STATE.cpIv) || 'upcoming';
    Array.prototype.forEach.call(wrap.querySelectorAll(':scope > .cp-card'), function (card) {
      if (card.querySelector('.tly2-ivmeta') || card.classList.contains('tly2-walk')) return;
      var m = /interview-prep\/([^')]+)'\)/.exec(card.innerHTML);
      var iv = m ? byId[decodeURIComponent(m[1])] : null;
      if (!iv) return;
      var chip = card.firstElementChild;
      if (chip && /display:inline-block/.test(chip.getAttribute('style') || '')) chip.textContent = iv.state;
      var date = Array.prototype.filter.call(card.children, function (x) { return /Interviewer:/.test(x.textContent || ''); })[0];
      var html = '<div class="tly2-ivmeta tly2-meta"><span class="tly2-mode">' + h(iv.mode) + '</span>' + (iv.venue ? ' ' + h(iv.venue) : '') + (iv.company ? ' · ' + h(iv.company) : '') + '</div>';
      if (date) date.insertAdjacentHTML('afterend', html); else card.insertAdjacentHTML('beforeend', html);
    });
    if (tab !== 'upcoming') return;
    var walk = d.interviews.filter(function (i) { return i.kind === 'walkin' && i.upcoming; });
    if (!walk.length || document.getElementById('tlY2Walkins')) return;
    var empty = Array.prototype.filter.call(wrap.querySelectorAll(':scope > .cp-card.cp-empty'), function (x) { return /No upcoming interviews/.test(x.textContent); })[0];
    if (empty) empty.style.display = 'none';
    var html = '<div id="tlY2Walkins">' + walk.map(function (i) {
      return '<div class="cp-card tly2-walk" style="margin-bottom:12px" data-iv="' + h(i.id) + '">'
        + '<div style="font-size:11px;font-weight:800;color:#1b4f9e;background:#e7f0ff;border-radius:10px;padding:3px 9px;display:inline-block">' + h(i.state) + '</div>'
        + '<div style="font-size:16px;font-weight:800;color:#16202c;margin-top:8px">' + h(i.round) + '</div>'
        + '<div style="font-size:12.5px;color:#7b8794;margin-top:2px">' + h([i.jobTitle, i.company].filter(Boolean).join(' · ')) + '</div>'
        + '<div style="font-size:13px;color:#26313f;margin-top:8px"><b>' + h(fmtDate(i.date)) + '</b>' + (i.time ? ' · ' + h(i.time) : '') + '</div>'
        + '<div class="tly2-meta"><span class="tly2-mode">' + h(i.mode) + '</span>' + (i.venue ? ' ' + h(i.venue) : '') + '</div>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;border-top:1px solid #f0f3f7;padding-top:11px">'
        + '<button class="cp-btn" onclick="navigate(\'/job/' + h(i.jobId) + '\')">View Details</button></div></div>';
    }).join('') + '</div>';
    var tabsLine = Array.prototype.filter.call(wrap.children, function (x) { return /Upcoming \(\d+\)/.test(x.textContent || '') && x.querySelector('button'); })[0];
    if (tabsLine) {
      tabsLine.insertAdjacentHTML('afterend', html);
      var b = tabsLine.querySelector('button');
      if (b) b.textContent = b.textContent.replace(/\((\d+)\)/, function (_, n) { return '(' + (Number(n) + walk.length) + ')'; });
    }
  }

  /* ================================================================== *
   * RECRUITER: the ATS candidate record
   * ================================================================== */
  var REC = { tl: 15 };
  function qid() {
    var m = /[?&]id=([^&]+)/.exec(hash());
    return m ? decodeURIComponent(m[1]) : null;
  }
  var PHASE_LABEL = { applied: 'Applied', under_review: 'Under Review', shortlisted: 'Shortlisted', interview: 'Interview', offer: 'Offer', hired: 'Hired', rejected: 'Rejected', hold: 'On Hold' };

  function recordHtml(x) {
    var kv = function (k, v, attr) { return '<div class="item"' + (attr ? ' data-f="' + attr + '"' : '') + '><div class="k">' + h(k) + '</div><div class="v" style="font-size:13px">' + v + '</div></div>'; };
    var rs = x.resumeScore ? h(x.resumeScore.total) + '/100 <span style="color:var(--text-soft);font-size:11.5px">' + h(x.resumeScore.label || '') + '</span>' : '—';
    var cur = x.currentStage ? h(x.currentStage.label) + (x.currentStage.job ? ' <span style="color:var(--text-soft);font-size:11.5px">· ' + h(x.currentStage.job) + '</span>' : '') : 'Not applied yet';
    var src = h(x.source.candidate || 'Unknown') + (x.source.detail ? ' <span style="color:var(--text-soft);font-size:11.5px">— ' + h(x.source.detail) + '</span>' : '');
    var exp = h([x.experience.label, x.experience.title, x.experience.currentCompany].filter(Boolean).join(' · ') || '—');
    var head = '<div class="panel" id="tlY2Record" style="margin-bottom:16px"><div class="panel-head"><div><h2>ATS record</h2><div class="desc">From the candidate record, the applications and the interviews — updated as they change.</div></div></div>'
      + '<div class="panel-body"><div class="kv tly2-kv">'
      + kv('Candidate ID', h(x.candidateCode || x.candidateId), 'code')
      + kv('Name', h(x.name), 'name')
      + kv('Email', h(x.email || '—'), 'email')
      + kv('Mobile', h(x.mobile || '—'), 'mobile')
      + kv('Profile score', (x.profileScore == null ? '—' : h(x.profileScore) + '%'), 'profile')
      + kv('Resume score', rs, 'resume')
      + kv('Current stage', cur, 'stage')
      + kv('Source', src, 'source')
      + kv('Last updated', h(fmtWhen(x.lastUpdated) || '—'), 'updated')
      + kv('Experience', exp, 'experience')
      + kv('Applications', h(x.applications.length), 'apps')
      + kv('Interviews', h(x.interviews.length), 'ivs')
      + '</div>'
      + '<div style="margin-top:10px" data-f="skills">' + (x.skills.length ? x.skills.map(function (s) { return '<span class="skill-tag">' + h(s) + '</span>'; }).join('') : '<span style="font-size:12.5px;color:var(--text-soft)">No skills on file.</span>') + '</div>'
      + '</div></div>';

    var match = '<div class="panel" id="tlY2Matching" style="margin-bottom:16px"><div class="panel-head"><div><h2>Matching</h2><div class="desc">Scores inform the recruiter; they never reject anybody on their own.</div></div></div>'
      + '<div class="panel-body pad0"><div class="tbl-wrap"><table class="data"><thead><tr><th>Application</th><th>Job type</th><th>Status</th><th>Source</th><th>Resume score</th><th>Profile score</th><th>Eligibility</th><th>Match score</th></tr></thead><tbody>'
      + (x.applications.length ? x.applications.map(function (a) {
        var m = a.matching;
        return '<tr data-app="' + h(a.applicationId) + '"><td><b>' + h(a.jobTitle) + '</b><div style="font-size:11.5px;color:var(--text-soft)">' + h(a.reference || a.applicationId) + ' · applied ' + h(fmtDate(a.appliedAt)) + '</div></td>'
          + '<td>' + h(a.jobType) + '</td><td>' + h(a.stageLabel) + '<div style="font-size:11px;color:var(--text-soft)">' + h(PHASE_LABEL[a.phase] || '') + '</div></td>'
          + '<td>' + h(a.source || '—') + '</td>'
          + '<td>' + (m.resumeScore == null ? '—' : h(m.resumeScore)) + '</td>'
          + '<td>' + (m.profileScore == null ? '—' : h(m.profileScore) + '%') + '</td>'
          + '<td><span class="badge ' + (m.eligibility.status === 'Eligible' ? 'badge-ok' : m.eligibility.status === 'Check' ? 'badge-warn' : 'badge-danger') + '">' + h(m.eligibility.status) + '</span>'
          + (m.eligibility.reason ? '<div style="font-size:11px;color:var(--text-soft)">' + h(m.eligibility.reason) + '</div>' : '') + '</td>'
          + '<td>' + (m.matchScore == null ? '—' : '<b>' + h(m.matchScore) + '</b>') + '</td></tr>';
      }).join('') : '<tr><td colspan="8"><div class="empty-note">No applications you can see.</div></td></tr>')
      + '</tbody></table></div></div></div>';

    var ivs = '<div class="panel" id="tlY2IvHistory" style="margin-bottom:16px"><div class="panel-head"><h2>Interview history</h2></div><div class="panel-body pad0"><div class="tbl-wrap"><table class="data"><thead><tr><th>Date</th><th>Round</th><th>Job</th><th>Mode</th><th>State</th><th>Interviewer</th><th>Score</th></tr></thead><tbody>'
      + (x.interviews.length ? x.interviews.map(function (i) {
        return '<tr><td style="white-space:nowrap">' + h(fmtDate(i.date) || '—') + (i.time ? ' · ' + h(i.time) : '') + '</td><td>' + h(i.round) + '</td><td>' + h(i.jobTitle) + '</td><td>' + h(i.mode) + (i.venue ? '<div style="font-size:11px;color:var(--text-soft)">' + h(i.venue) + '</div>' : '') + '</td>'
          + '<td>' + h(i.state) + (i.reschedules ? ' <span style="font-size:11px;color:var(--text-soft)">(' + h(i.reschedules) + '×)</span>' : '') + '</td><td>' + h(i.interviewer || '—') + '</td><td>' + (i.score == null ? '—' : h(i.score)) + '</td></tr>';
      }).join('') : '<tr><td colspan="7"><div class="empty-note">No interviews yet.</div></td></tr>')
      + '</tbody></table></div></div></div>';

    var tl = x.timeline || [];
    var shown = tl.slice(0, REC.tl);
    var timeline = '<div class="panel" id="tlY2Timeline" style="margin-bottom:16px"><div class="panel-head"><div><h2>Candidate timeline</h2><div class="desc">Registered → profile and resume → applications → interviews → offer → hired, from what actually happened.</div></div></div>'
      + '<div class="panel-body"><ol class="tly2-tl">' + (shown.length ? shown.map(function (ev) {
        /* 0130: "Applied for <job> on <date>" says it whole. */
        if (ev.text) return '<li class="k-' + h(ev.kind) + '"><span class="t">' + h(fmtWhen(ev.at)) + '</span><b>' + h(ev.text) + '</b>'
          + (ev.detail ? '<div class="d">' + h(ev.detail) + '</div>' : '') + '</li>';
        return '<li class="k-' + h(ev.kind) + '"><span class="t">' + h(fmtWhen(ev.at)) + '</span><b>' + h(ev.label) + '</b>'
          + (ev.job ? ' <span class="j">· ' + h(ev.job) + '</span>' : '') + (ev.detail ? '<div class="d">' + h(ev.detail) + '</div>' : '') + '</li>';
      }).join('') : '<li>Nothing recorded yet.</li>') + '</ol>'
      + (tl.length > shown.length ? '<button class="btn btn-ghost btn-sm" onclick="tlY2MoreTimeline()">Show ' + Math.min(30, tl.length - shown.length) + ' more</button>' : '')
      + '</div></div>';

    var asm = '<div class="panel" id="tlY2Assessments" style="margin-bottom:16px"><div class="panel-head"><div><h2>Assessments</h2><div class="desc">Results from tests taken elsewhere (no tests run in TeamLink). Recruiters can filter the Talent Pool by them.</div></div></div>'
      + '<div class="panel-body">' + (x.assessments.length ? '<div class="tbl-wrap"><table class="data"><thead><tr><th>Assessment</th><th>Category</th><th>Score</th><th>Date</th><th>Status</th></tr></thead><tbody>'
        + x.assessments.map(function (a) { return '<tr><td>' + h(a.name) + '</td><td>' + h(a.category) + '</td><td>' + (a.score == null ? '—' : h(a.score) + ' / ' + h(a.maxScore) + ' (' + h(a.percent) + '%)') + '</td><td>' + h(fmtDate(a.assessedOn) || '—') + '</td><td>' + h(a.status) + '</td></tr>'; }).join('')
        + '</tbody></table></div>' : '<div class="empty-note">No assessment results recorded.</div>')
      + (role() === 'recruiter' || role() === 'admin' ? '<details class="tly2-form"><summary>Record a result</summary><div class="tly2-grid">'
        + '<label>Name<input id="tlY2AsName" maxlength="120" placeholder="e.g. Java"></label>'
        + '<label>Category<select id="tlY2AsCat">' + ['Technical', 'Java', 'Python', 'Aptitude', 'Communication', 'Other'].map(function (c) { return '<option>' + c + '</option>'; }).join('') + '</select></label>'
        + '<label>Score<input id="tlY2AsScore" type="number" min="0" step="0.5"></label>'
        + '<label>Out of<input id="tlY2AsMax" type="number" min="1" value="100"></label>'
        + '<label>Date<input id="tlY2AsDate" type="date"></label>'
        + '<label>Provider<input id="tlY2AsProv" maxlength="120" placeholder="Where it was taken"></label>'
        + '</div><button class="btn btn-primary btn-sm" onclick="tlY2SaveAssessment()">Save result</button> <span id="tlY2AsMsg" role="status" style="font-size:12px"></span></details>' : '')
      + '</div></div>';

    var r = x.referral;
    var refp = '<div class="panel" id="tlY2Referral" style="margin-bottom:16px"><div class="panel-head"><div><h2>Referral</h2><div class="desc">Optional. ' + h(x.referredOthers) + ' candidate' + (x.referredOthers === 1 ? '' : 's') + ' referred by this person.</div></div></div><div class="panel-body">'
      + (r ? '<div class="kv tly2-kv">' + kv('Referred by', h(r.referrerName || '') + ' <span style="color:var(--text-soft)">' + h(r.referrerCode || r.referrerCandidateId) + '</span>')
          + kv('Referral date', h(fmtDate(r.referredAt))) + kv('Status', h(r.status.replace('_', ' ')), 'refstatus') + kv('How', r.via === 'link' ? 'Referral link' : 'Recorded by staff')
          + kv('Reward', (r.rewardAmount == null ? 'None' : '₹' + h(r.rewardAmount)) + ' · ' + h(r.rewardStatus)) + '</div>'
          + (role() !== 'bde' ? '<div class="tly2-grid" style="margin-top:10px"><label>Reward (₹, optional)<input id="tlY2RefAmt" type="number" min="0" value="' + h(r.rewardAmount == null ? '' : r.rewardAmount) + '"></label>'
            + '<label>Reward status<select id="tlY2RefRs">' + ['none', 'pending', 'approved', 'paid', 'declined'].map(function (s) { return '<option' + (s === r.rewardStatus ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></label></div>'
            + '<button class="btn btn-ghost btn-sm" onclick="tlY2SaveReward(\'' + h(r.id) + '\')">Save reward</button>' : '')
        : '<div class="empty-note" style="margin-bottom:8px">No referral recorded.</div>'
          + (role() !== 'bde' ? '<details class="tly2-form"><summary>Record who referred them</summary><div class="tly2-grid"><label>Referrer Candidate ID<input id="tlY2RefWho" placeholder="TL-CAN-000123"></label></div>'
            + '<button class="btn btn-ghost btn-sm" onclick="tlY2SaveReferral()">Save referral</button> <span id="tlY2RefMsg" role="status" style="font-size:12px"></span></details>' : ''))
      + '</div></div>';
    return '<div id="tlY2Rec" data-cand="' + h(x.candidateId) + '">' + head + match + ivs + timeline + asm + refp + '</div>';
  }

  function paintRecord(force) {
    if (!/^#\/recruiter\/candidate-profile/.test(hash()) || !qid()) return;
    var body = document.querySelector('.dash-body');
    if (!body) return;
    var id = qid();
    var e = load('rec:' + id, '/ats/candidates/' + encodeURIComponent(id) + '/record', function () { paintRecord(true); }, force === 'reload');
    var host = document.getElementById('tlY2Rec');
    if (!e.data) {
      if (!host && e.err) {
        var first = body.querySelector(':scope > .panel');
        if (first) first.insertAdjacentHTML('afterend', '<div id="tlY2Rec" class="empty-note">' + h(e.err) + '</div>');
      }
      return;
    }
    if (host && host.getAttribute('data-at') === String(e.at) && host.getAttribute('data-tl') === String(REC.tl)) return;
    var html = recordHtml(e.data.record);
    if (host) host.outerHTML = html;
    else {
      var head = body.querySelector(':scope > .panel');
      if (!head) return;
      head.insertAdjacentHTML('afterend', html);
    }
    host = document.getElementById('tlY2Rec');
    if (host) { host.setAttribute('data-at', String(e.at)); host.setAttribute('data-tl', String(REC.tl)); }
  }
  window.tlY2MoreTimeline = function () { REC.tl += 30; paintRecord(); };
  var val = function (id) { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
  window.tlY2SaveAssessment = function () {
    var id = qid(); var msg = document.getElementById('tlY2AsMsg');
    var score = val('tlY2AsScore'), max = val('tlY2AsMax');
    var body = { name: val('tlY2AsName'), category: val('tlY2AsCat') || 'Technical', score: score === '' ? null : Number(score), maxScore: Number(max || 100) };
    if (val('tlY2AsDate')) body.assessedOn = val('tlY2AsDate');
    if (val('tlY2AsProv')) body.provider = val('tlY2AsProv');
    if (!body.name) { if (msg) msg.textContent = 'Give the assessment a name.'; return; }
    api().post('/ats/candidates/' + encodeURIComponent(id) + '/assessments', body).then(function () {
      say('Assessment result saved', '📝'); paintRecord('reload');
    }, function (err) { if (msg) msg.textContent = (err && err.message) || 'Could not save.'; });
  };
  window.tlY2SaveReferral = function () {
    var id = qid(); var msg = document.getElementById('tlY2RefMsg');
    var who = val('tlY2RefWho');
    var c = null;
    try { c = (DATA.candidates || []).find(function (x) { return x.id === who || (x.candidateCode && x.candidateCode.toUpperCase() === who.toUpperCase()); }); } catch (e) { c = null; }
    if (!c) { if (msg) msg.textContent = 'No candidate with that ID in your talent pool.'; return; }
    api().post('/ats/candidates/' + encodeURIComponent(id) + '/referral', { referrerCandidateId: c.id }).then(function () {
      say('Referral recorded', '🤝'); paintRecord('reload');
    }, function (err) { if (msg) msg.textContent = (err && err.message) || 'Could not save.'; });
  };
  window.tlY2SaveReward = function (rid) {
    var amt = val('tlY2RefAmt');
    api().put('/ats/referrals/' + encodeURIComponent(rid), { rewardAmount: amt === '' ? null : Number(amt), rewardStatus: val('tlY2RefRs') || 'none' })
      .then(function () { say('Referral updated', '🤝'); paintRecord('reload'); }, function (err) { say((err && err.message) || 'Could not save', '⚠️'); });
  };

  /* ================================================================== *
   * ADMIN: audit log + hand-off queue (Reports), analytics (Analytics)
   * ================================================================== */
  var AUD = { page: 1, action: '', q: '' };
  var audQ = debounce(function (v) { AUD.q = String(v || '').trim(); AUD.page = 1; paintAdmin(); }, 300);
  window.tlY2AudQ = function (v) { audQ(v); };
  window.tlY2AudAction = function (v) { AUD.action = v; AUD.page = 1; paintAdmin(); };
  window.tlY2AudPage = function (d) { AUD.page = Math.max(1, AUD.page + d); paintAdmin(); };
  var ANA = { days: 30 };
  window.tlY2Days = function (v) { ANA.days = Number(v) || 30; paintAdmin(); };

  function auditPanel(d) {
    var pages = Math.max(1, Math.ceil(d.total / d.pageSize));
    return '<div class="panel-head"><div><h2>Audit log</h2><div class="desc">Who did what, when, to which record. Field names only — never the values.</div></div></div>'
      + '<div class="panel-body" style="padding-bottom:6px"><div class="tly2-tools">'
      + '<select aria-label="Action" onchange="tlY2AudAction(this.value)"><option value="">All actions</option>'
      + d.actions.map(function (a) { return '<option value="' + h(a.id) + '"' + (AUD.action === a.id ? ' selected' : '') + '>' + h(a.label) + '</option>'; }).join('') + '</select>'
      + '<input type="search" id="tlY2AudQ" aria-label="Search by record id or user" placeholder="Record ID or user email" value="' + h(AUD.q) + '" oninput="tlY2AudQ(this.value)">'
      + '<span class="tly2-info">' + h(d.total) + ' event' + (d.total === 1 ? '' : 's') + ' · page ' + d.page + ' of ' + pages + '</span>'
      + '<span class="tly2-pager"><button class="btn btn-ghost btn-sm" ' + (d.page <= 1 ? 'disabled' : '') + ' onclick="tlY2AudPage(-1)">‹ Prev</button><button class="btn btn-ghost btn-sm" ' + (d.page >= pages ? 'disabled' : '') + ' onclick="tlY2AudPage(1)">Next ›</button></span></div></div>'
      + '<div class="panel-body pad0"><div class="tbl-wrap"><table class="data" id="tlY2AuditTable"><thead><tr><th>Date / time</th><th>User</th><th>Action</th><th>Entity</th><th>Entity ID</th><th>Detail</th></tr></thead><tbody>'
      + (d.rows.length ? d.rows.map(function (x) {
        var det = x.detail || {};
        var txt = det.fields ? det.fields.join(', ') : (det.from || det.to) ? [det.from, det.to].filter(Boolean).join(' → ') : '';
        return '<tr data-action="' + h(x.action) + '"><td style="white-space:nowrap">' + h(fmtWhen(x.at)) + '</td><td style="font-size:12.5px">' + h(x.user) + '</td><td><b>' + h(x.actionLabel) + '</b></td><td>' + h(x.entity) + '</td><td class="mono" style="font-size:12px">' + h(x.entityId) + '</td><td style="font-size:12px;color:var(--text-soft);max-width:260px;overflow-wrap:anywhere">' + h(txt) + '</td></tr>';
      }).join('') : '<tr><td colspan="6"><div class="empty-note">Nothing recorded for this filter.</div></td></tr>')
      + '</tbody></table></div></div>';
  }
  function handoffPanel(d) {
    return '<div class="panel-head"><div><h2>Selected → employee hand-off</h2><div class="desc">' + h(d.note) + '</div></div></div>'
      + '<div class="panel-body pad0"><div class="tbl-wrap"><table class="data"><thead><tr><th>Queued</th><th>Candidate</th><th>Job</th><th>Stage</th><th>Joining</th><th>Status</th></tr></thead><tbody>'
      + (d.handoffs.length ? d.handoffs.map(function (x) {
        return '<tr><td style="white-space:nowrap">' + h(fmtDate(x.queuedAt)) + '</td><td>' + h(x.name) + '<div style="font-size:11.5px;color:var(--text-soft)">' + h(x.candidateCode || x.candidateId) + '</div></td><td>' + h(x.jobTitle) + '<div style="font-size:11.5px;color:var(--text-soft)">' + h(x.company || '') + '</div></td><td>' + h(x.stage) + '</td><td>' + h(fmtDate(x.joiningDate) || '—') + '</td><td>' + h(x.status) + '</td></tr>';
      }).join('') : '<tr><td colspan="6"><div class="empty-note">Nobody has been selected yet.</div></td></tr>')
      + '</tbody></table></div></div>';
  }
  function tile(label, v, sub) {
    return '<div class="tly2-tile"><b>' + h(v == null ? '—' : v) + '</b><span>' + h(label) + '</span>' + (sub ? '<i>' + h(sub) + '</i>' : '') + '</div>';
  }
  function pct(v) { return v == null ? '—' : v + '%'; }
  function analyticsPanel(a) {
    var c = a.candidates, j = a.jobs, r = j.byType.regular, w = j.byType.walkin;
    var b = c.profileCompletion.buckets;
    var row = function (name, x) {
      return '<tr><td><b>' + name + '</b></td><td>' + x.jobs + '</td><td>' + x.views + '</td><td>' + x.applications + '</td><td>' + pct(x.conversionRate) + '</td><td>' + x.attended + '</td><td>' + x.selections + '</td><td>' + pct(x.selectionRate) + '</td></tr>';
    };
    return '<div class="panel-head"><div><h2>Portal analytics</h2><div class="desc">Counts only — no candidate is named. Walk-in is a job type, so walk-in numbers are its row.</div></div>'
      + '<select aria-label="Period" onchange="tlY2Days(this.value)">' + [7, 30, 90, 365].map(function (d) { return '<option value="' + d + '"' + (ANA.days === d ? ' selected' : '') + '>Last ' + d + ' days</option>'; }).join('') + '</select></div>'
      + '<div class="panel-body">'
      + '<div class="tly2-h">Candidates</div><div class="tly2-tiles" id="tlY2AnaCand">'
      + tile('Registrations', c.registrations) + tile('Added by staff', c.addedByStaff) + tile('Resume uploads', c.resumeUploads)
      + tile('Applications', c.applications) + tile('Average profile completion', pct(c.profileCompletion.average),
        'Incomplete ' + b.incomplete + ' · Fair ' + b.fair + ' · Good ' + b.good + ' · Excellent ' + b.excellent) + '</div>'
      + '<div class="tly2-h">Jobs</div><div class="tly2-tiles" id="tlY2AnaJobs">' + tile('Job views', j.views) + tile('Applications', j.applications) + tile('View → apply conversion', pct(j.conversionRate)) + '</div>'
      + '<div class="tbl-wrap" style="margin-top:10px"><table class="data" id="tlY2AnaType"><thead><tr><th>Job type</th><th>Jobs</th><th>Views</th><th>Applications</th><th>Conversion</th><th>Attended</th><th>Selected</th><th>Selection rate</th></tr></thead><tbody>'
      + row('Regular', r) + row('Walk-in', w) + '</tbody></table></div>'
      + '<div class="tly2-h">Walk-in jobs</div><div class="tly2-tiles" id="tlY2AnaWalk">' + tile('Views', a.walkin.views) + tile('Interview registrations', a.walkin.interviewRegistrations)
      + tile('Attendance', a.walkin.attendance) + tile('No-shows', a.walkin.noShows) + tile('Selections', a.walkin.selections) + tile('Selection rate', pct(a.walkin.selectionRate)) + '</div>'
      + '<div class="tly2-two"><div><div class="tly2-h">Applications by source</div><table class="data"><tbody>' + (a.sources.applications.map(function (s) { return '<tr><td>' + h(s.source) + '</td><td style="text-align:right">' + s.count + '</td></tr>'; }).join('') || '<tr><td>—</td></tr>') + '</tbody></table></div>'
      + '<div><div class="tly2-h">Top jobs</div><table class="data"><thead><tr><th>Job</th><th>Type</th><th>Views</th><th>Applied</th></tr></thead><tbody>' + (j.top.map(function (t) { return '<tr><td>' + h(t.title) + '</td><td>' + h(t.jobType) + '</td><td>' + t.views + '</td><td>' + t.applications + '</td></tr>'; }).join('') || '<tr><td colspan="4">—</td></tr>') + '</tbody></table></div></div>'
      + '</div>';
  }
  function mountPanel(id, html, stamp) {
    var body = document.querySelector('.dash-body');
    if (!body) return;
    var el = document.getElementById(id);
    if (el && el.getAttribute('data-at') === stamp) return;
    var out = '<div class="panel tly2-panel" id="' + id + '" data-at="' + h(stamp) + '" style="margin-top:16px">' + html + '</div>';
    if (el) el.outerHTML = out; else body.insertAdjacentHTML('beforeend', out);
  }
  function paintAdmin() {
    if (role() !== 'admin') return;
    if (/^#\/admin\/reports/.test(hash())) {
      var p = '/admin/audit-log?page=' + AUD.page + '&pageSize=25' + (AUD.action ? '&action=' + encodeURIComponent(AUD.action) : '') + (AUD.q ? '&q=' + encodeURIComponent(AUD.q) : '');
      var e = load('audit', p, paintAdmin);
      if (e.data) {
        var focus = document.activeElement && document.activeElement.id === 'tlY2AudQ';
        mountPanel('tlY2Audit', auditPanel(e.data), String(e.at) + p);
        if (focus) { var q = document.getElementById('tlY2AudQ'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
      }
      var hq = load('handoffs', '/admin/employee-handoffs', paintAdmin);
      if (hq.data) mountPanel('tlY2Handoffs', handoffPanel(hq.data), String(hq.at));
    } else if (/^#\/admin\/analytics/.test(hash())) {
      var pa = '/admin/portal-analytics?days=' + ANA.days;
      var ea = load('analytics', pa, paintAdmin);
      if (ea.data) mountPanel('tlY2Analytics', analyticsPanel(ea.data), String(ea.at) + pa);
    }
  }

  /* ================================================================== *
   * job views + the optional referral code from a shared link
   * ================================================================== */
  var viewed = {};
  function countView() {
    var m = /^#\/job\/([^/?#]+)/.exec(hash());
    if (!m || !api()) return;
    var id = decodeURIComponent(m[1]);
    if (viewed[id]) return;
    viewed[id] = true;
    var key = 'tl_viewed_' + id;
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch (e) { /* counted once per page load */ }
    api().post('/jobs/' + encodeURIComponent(id) + '/view', {}).catch(function () {});
  }
  (function captureRef() {
    var m = /[?&]ref=([A-Za-z0-9]{3,20})/.exec(location.search) || /[?&]ref=([A-Za-z0-9]{3,20})/.exec(location.hash);
    if (m) { try { sessionStorage.setItem('tl_ref_code', m[1].toUpperCase()); } catch (e) { /* optional */ } }
  })();
  var claimed = false;
  function claimRef() {
    if (claimed || role() !== 'candidate' || !api()) return;
    var code = null;
    try { code = sessionStorage.getItem('tl_ref_code'); } catch (e) { code = null; }
    if (!code) return;
    claimed = true;
    api().post('/candidate/referral/claim', { code: code }).then(function () {
      try { sessionStorage.removeItem('tl_ref_code'); } catch (e) { /* fine */ }
    }, function () { /* optional: says nothing */ });
  }

  /* ================================================================== *
   * after every paint
   * ================================================================== */
  function paint() {
    var r = role();
    countView();
    if (r === 'candidate') { claimRef(); paintHome(); paintApplications(); paintInterviews(); }
    else if (r === 'recruiter' || r === 'bde' || r === 'admin') { paintRecord(); paintAdmin(); }
  }
  var queued = false;
  function paintSoon() {
    if (queued) return;
    queued = true;
    setTimeout(function () { queued = false; try { paint(); } catch (e) { /* cosmetic */ } }, 30);
  }
  function install() {
    if (typeof window.render !== 'function') return setTimeout(install, 50);
    var prev = window.render;
    if (!prev.__tly2) {
      var next = function () {
        var out = prev.apply(this, arguments);
        /* A repaint after an action (a stage move, a save) should not show
           numbers from before it: drop what the screen is showing. */
        Object.keys(C).forEach(function (k) { if (C[k].at && Date.now() - C[k].at > 3000) C[k].at = 0; });
        paintSoon();
        return out;
      };
      next.__tly2 = true;
      window.render = next;
    }
    try { new MutationObserver(function () { paintSoon(); }).observe(document.getElementById('app') || document.body, { childList: true, subtree: true }); }
    catch (e) { /* render() covers it */ }
    window.addEventListener('hashchange', paintSoon);
    paintSoon();
  }

  var css = ''
    + '.pstrip.tly2-counts{grid-template-columns:repeat(5,minmax(0,1fr))}'
    + '.tly2-counts .c:focus-visible{outline:3px solid #9cc0ff;outline-offset:2px}'
    + '@media (max-width:900px){.pstrip.tly2-counts{grid-template-columns:repeat(2,minmax(0,1fr))}.tly2-counts .c[data-count="profileStrength"]{grid-column:1/-1}}'
    + '.tly2-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}'
    + '.tly2-chip{font-size:11px;font-weight:700;border-radius:12px;padding:3px 9px;background:#f1f4f8;color:#8a94a6;white-space:nowrap}'
    + '.tly2-chip.on{background:#e7f0ff;color:#1b4f9e}.tly2-chip b{font-weight:800}'
    + '.tly2-app,.tly2-iv{padding:9px 0;border-bottom:1px solid #f4f6fa}'
    + '.tly2-row{display:flex;justify-content:space-between;gap:8px;align-items:baseline;flex-wrap:wrap}'
    + '.tly2-status{font-size:10.5px;font-weight:800;border-radius:10px;padding:2px 8px;background:#e7f0ff;color:#1b4f9e;white-space:nowrap}'
    + '.tly2-status.s-hired,.tly2-status.s-offer,.tly2-status.s-completed{background:#e8f6ee;color:#0f7a44}'
    + '.tly2-status.s-rejected,.tly2-status.s-cancelled,.tly2-status.s-missed{background:#fdeceb;color:#a3282c}'
    + '.tly2-status.s-hold,.tly2-status.s-rescheduled{background:#fff4e0;color:#9a5b00}'
    + '.tly2-meta{font-size:12px;color:#42505f;margin-top:5px;overflow-wrap:anywhere}'
    + '.tly2-mode{display:inline-block;font-size:10.5px;font-weight:800;border-radius:10px;padding:2px 8px;background:#f1f4f8;color:#42505f;margin-right:4px}'
    + '.tly2-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px}'
    + '.tly2-tools input,.tly2-tools select{border:1px solid #dde4ec;border-radius:8px;padding:8px 10px;font:inherit;font-size:12.5px;background:#fff;min-width:0}'
    + '.tly2-tools input{flex:1 1 220px}'
    + '.tly2-info{font-size:12px;color:#7b8794}.tly2-pager{display:flex;gap:6px;margin-left:auto}'
    /* 0130: the Applied Date field and the sort */
    + '.tly2-date{display:inline-flex;align-items:center;gap:6px;min-width:0}.tly2-dl{font-size:12px;font-weight:700;color:#42505f;white-space:nowrap}'
    + '.tly2-tools .tldr-btn{font-size:12.5px;min-height:35px}#tlY2AppChips{margin:-4px 0 12px}'
    + '.tly2-info{font-weight:700;color:#42505f}'
    + '@media (max-width:640px){.tly2-date{flex:1 1 100%}.tly2-date .tldr-field{flex:1}.tly2-tools select{flex:1 1 45%}}'
    + '.tly2-hist{display:flex;gap:6px 14px;flex-wrap:wrap;font-size:12px;color:#26313f;margin-top:9px;padding-top:8px;border-top:1px dashed #e6ebf2}'
    + '.tly2-hist .k{color:#8a94a6;font-weight:700}.tly2-open{color:var(--cap-blue,#1d6ff2);font-weight:700;cursor:pointer}'
    + '.tly2-kv{grid-template-columns:repeat(4,minmax(0,1fr))}'
    + '@media (max-width:1000px){.tly2-kv{grid-template-columns:repeat(2,minmax(0,1fr))}}'
    + '.tly2-tl{list-style:none;margin:0 0 10px;padding:0 0 0 14px;border-left:2px solid var(--line,#e5e9f0)}'
    + '.tly2-tl li{position:relative;padding:0 0 11px 10px;font-size:13px}'
    + '.tly2-tl li:before{content:"";position:absolute;left:-20px;top:5px;width:9px;height:9px;border-radius:50%;background:var(--brand-500,#1490b3)}'
    + '.tly2-tl li.k-rejected:before{background:#d1435b}.tly2-tl li.k-hold:before{background:#e8a33d}'
    + '.tly2-tl .t{display:block;font-size:11.5px;color:var(--text-soft,#7b8794)}.tly2-tl .j{color:var(--text-soft,#7b8794)}.tly2-tl .d{font-size:12px;color:var(--text-soft,#7b8794)}'
    + '.tly2-form{margin-top:12px}.tly2-form summary{cursor:pointer;font-weight:700;font-size:13px;color:var(--brand-600,#0f7391)}'
    + '.tly2-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 12px;margin:10px 0}'
    + '.tly2-grid label{display:flex;flex-direction:column;gap:4px;font-size:11.5px;font-weight:700;color:var(--text-soft,#6b7a90)}'
    + '.tly2-grid input,.tly2-grid select{border:1px solid var(--line,#dde4ec);border-radius:8px;padding:7px 9px;font:inherit;font-size:13px;min-width:0}'
    + '@media (max-width:700px){.tly2-grid{grid-template-columns:1fr}}'
    + '.tly2-panel .panel-head{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start}'
    + '.tly2-h{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--text-soft,#7b8794);margin:14px 0 8px}'
    + '.tly2-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}'
    + '.tly2-tile{border:1px solid var(--line,#e5e9f0);border-radius:10px;padding:11px 13px;background:#fff}'
    + '.tly2-tile b{display:block;font-size:20px;color:var(--text,#16202c)}.tly2-tile span{font-size:12px;color:var(--text-soft,#7b8794)}.tly2-tile i{display:block;font-style:normal;font-size:11px;color:var(--text-soft,#7b8794);margin-top:4px}'
    + '.tly2-two{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media (max-width:800px){.tly2-two{grid-template-columns:1fr}}';
  try {
    var st = document.createElement('style');
    st.id = 'tly2Style';
    st.textContent = css;
    document.head.appendChild(st);
  } catch (e) { /* unstyled, still works */ }

  install();
})();
