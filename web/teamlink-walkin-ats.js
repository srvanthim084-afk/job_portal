/*
 * TeamLink — the recruiter ATS for a job, and the walk-in lifecycle (0107).
 *
 * Inside the EXISTING recruiter job view - no new module, no nav item:
 *   Manage Jobs -> "View Applicants"   #/recruiter/manage-jobs?applicants=<jobId>
 *        tabs: Applicants | Check-in (walk-in only) | Update history
 *        an applicant                   #/recruiter/manage-jobs?applicants=<jobId>&app=<appId>
 *   Admin -> All jobs -> applicants     #/admin/jobs?applicants=<jobId>[&app=<appId>]
 *
 * Candidate side, kept minimal and in the existing My Applications screen:
 * a walk-in application's rail reads Registered -> Attended -> Under review
 * -> Selected (Not selected / Missed as neutral banners), and an upcoming
 * walk-in shows its date, time, venue, address, Application ID and a QR
 * code of that ID (qrcode-generator 1.4.4 from cdn.jsdelivr.net, the one
 * CDN the CSP already allows; without it the ID is shown as text).
 *
 * Every rule is the server's (routes/walkin-ats.js, migration 0107). The
 * screens never decide a transition, a window or an access question; they
 * ask and show the answer. Filters are a per-viewer convenience in
 * sessionStorage (try/catch), so returning from an applicant keeps them.
 *
 * Wrappers installed (once): mjApplicantsModal, pageRecruiterDash,
 * pageAdminDash, render (admin jobs link), DATA.stageMeta (walk-in-only ids),
 * tlStageTrack (walk-in applications).
 */
(function () {
  'use strict';
  if (window.__tlWalkinAts) return;
  window.__tlWalkinAts = true;

  var api = function () { return window.TL && TL.api; };
  var role = function () { return window.STATE && STATE.session ? STATE.session.role : null; };
  var h = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  };
  var js = function (v) { return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '\\x3c'); };
  var say = function (m, i) { if (typeof window.toast === 'function') toast(m, i || '✅'); };
  var rerender = function () { if (typeof window.render === 'function') render(); };
  var params = function () { try { return currentRoute().params || {}; } catch (e) { return {}; } };
  var errText = function (e) { return (e && e.message) || 'Something went wrong.'; };
  var base = function () { return role() === 'admin' ? '/admin/jobs' : '/recruiter/manage-jobs'; };
  var fmtDT = function (iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  };
  var fmtD = function (iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  };
  var t12 = function (t) {
    var m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
    if (!m) return '';
    var hh = Number(m[1]);
    return (hh % 12 || 12) + ':' + m[2] + ' ' + (hh >= 12 ? 'PM' : 'AM');
  };
  var ss = {
    get: function (k) { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  function csrf() { var m = document.cookie.match(/tl_csrf=([^;]+)/); return m ? m[1] : ''; }

  /* ================================================================== *
   * stages: walk-in-only ids resolve everywhere a stage label is drawn
   * ================================================================== */
  var WALKIN_ORDER = ['registered', 'attended', 'interviewed', 'selected', 'rejected', 'no_show'];
  /* Shown until the server's own list arrives (a few hundred ms); the
     server (GET /api/ats/stages) is the authority and replaces it. */
  var WST = {
    registered: { label: 'Registered', candidateLabel: 'Registered' },
    attended: { label: 'Attended', candidateLabel: 'Attended' },
    interviewed: { label: 'Interviewed', candidateLabel: 'Under review' },
    no_show: { label: 'No Show', candidateLabel: 'Missed' },
  };
  var TRANS = [];          // [{from,to,override}]
  var REGULAR = null;      // [{id,label}]
  var STAGE_LABEL = function (id) {
    if (WST[id]) return WST[id].label;
    try { var m = DATA.stageMeta(id); return (m && m.label) || id; } catch (e) { return id; }
  };

  function loadStages() {
    if (!api() || !STATE.session || loadStages.done) return;
    loadStages.done = true;
    api().get('/ats/stages').then(function (o) {
      (o.walkin || []).forEach(function (s) {
        if (s.id === 'selected' || s.id === 'rejected') return;
        WST[s.id] = { label: s.label, candidateLabel: s.candidateLabel || s.label };
      });
      TRANS = o.transitions || [];
      REGULAR = o.regular || [];
    }).catch(function () { loadStages.done = false; });
  }

  if (window.DATA && typeof DATA.stageMeta === 'function' && !DATA.__tlWalkinMeta) {
    var prevMeta = DATA.stageMeta;
    DATA.stageMeta = function (id) {
      if (WST[id]) return { id: id, label: WST[id].label, candidateLabel: WST[id].candidateLabel, kanban: false };
      return prevMeta.apply(this, arguments);
    };
    DATA.__tlWalkinMeta = true;
  }

  var isWalkinJob = function (j) { return !!j && (j.postingKind === 'walkin' || j.jobType === 'walk-in'); };
  function isWalkinApp(a) {
    if (!a) return false;
    if (a.postingType === 'walkin') return true;
    try { return isWalkinJob(DATA.jobById(a.jobId)); } catch (e) { return false; }
  }

  /* ================================================================== *
   * the candidate's rail for a walk-in application (My Applications)
   * ================================================================== */
  var CAND = { list: null, loading: false, at: 0 };
  function loadCandidateStatus(force) {
    if (!api() || role() !== 'candidate' || CAND.loading) return;
    if (!force && CAND.list && Date.now() - CAND.at < 30000) return;
    CAND.loading = true;
    api().get('/my/applications-status').then(function (o) {
      CAND.list = o.applications || []; CAND.at = Date.now(); CAND.loading = false; rerender();
    }).catch(function () { CAND.loading = false; CAND.list = CAND.list || []; });
  }
  var candInfo = function (appId) {
    return (CAND.list || []).filter(function (x) { return x.applicationId === appId; })[0] || null;
  };

  function walkinRail(app, audience) {
    var cand = audience === 'candidate';
    var line = ['registered', 'attended', 'interviewed', 'selected'];
    var stage = app.stage;
    var lbl = function (s) {
      if (s === 'selected') return 'Selected';
      return cand ? (WST[s] ? WST[s].candidateLabel : s) : STAGE_LABEL(s);
    };
    var here = line.indexOf(stage);
    var att = app.attendedAt || ['attended', 'interviewed', 'selected'].indexOf(stage) >= 0;
    if (stage === 'rejected') here = att ? (app.interviewedAt ? 2 : 1) : 0;
    if (stage === 'no_show') here = 0;
    var off = stage === 'rejected' || stage === 'no_show';
    var steps = line.map(function (s, i) {
      var cls = (!off && s === stage) ? 'now' : (i < here || (off && i <= here)) ? 'done' : 'todo';
      return '<div class="st ' + cls + '"><span class="dot"></span><span class="lbl">' + h(lbl(s)) + '</span></div>';
    }).join('');
    var banner = '';
    if (stage === 'rejected') {
      banner = '<div class="off stop"><b>' + (cand ? 'Not selected.' : 'Rejected.') + '</b> '
        + (cand ? 'Thank you for your time - keep applying for other roles.' : 'This application is closed.') + '</div>';
    } else if (stage === 'no_show') {
      banner = cand
        ? '<div class="off pause"><b>Missed.</b> Attendance was not recorded for this walk-in.</div>'
        : '<div class="off pause"><b>No Show.</b> Not checked in by the end of the drive (+ grace). An override back to Attended needs a reason.</div>';
    }
    var extra = '';
    if (cand) {
      var info = candInfo(app.id);
      if (info) {
        extra += '<div class="tlwa-cand"><span>Application ID: <b>' + h(info.reference) + '</b></span>'
          + '<span class="tlwa-cstatus">' + h(info.status) + '</span></div>';
        if (info.walkin) {
          var w = info.walkin;
          extra += '<div class="tlwa-cwalk"><div class="tlwa-cwalk-body"><b>Walk-in Interview</b>'
            + (w.when ? '<div>📅 ' + h(w.when) + '</div>' : '')
            + (w.venue ? '<div>📍 ' + h(w.venue) + (w.address ? ', ' + h(w.address) : '') + '</div>' : '')
            + (w.contactPerson || w.contactNumber ? '<div>☎ ' + h([w.contactPerson, w.contactNumber].filter(Boolean).join(', ')) + '</div>' : '')
            + (w.documents && w.documents.length ? '<div>📄 Bring: ' + h(w.documents.join(', ')) + '</div>' : '')
            + (w.mapLink && /^https:\/\//.test(w.mapLink) ? '<div><a href="' + h(w.mapLink) + '" target="_blank" rel="noopener">View on Map</a></div>' : '')
            + '<div class="tlwa-small">Show this Application ID (or the QR code) at the venue for a quick check-in.</div></div>'
            + '<div class="tlwa-qr" data-tlwa-qr="' + h(info.reference) + '"></div></div>';
        }
      } else {
        loadCandidateStatus();
      }
    }
    return '<div class="tlpipe"><div class="track">' + steps + '</div>' + banner + extra + '</div>';
  }

  if (typeof window.tlStageTrack === 'function' && !window.tlStageTrack.__tlwa) {
    var prevTrack = window.tlStageTrack;
    window.tlStageTrack = function (app, opts) {
      opts = opts || {};
      if (app && isWalkinApp(app) && (WST[app.stage] || app.stage === 'selected' || app.stage === 'rejected')) {
        return walkinRail(app, opts.audience);
      }
      return prevTrack.apply(this, arguments);
    };
    window.tlStageTrack.__tlwa = true;
  }
  /* The candidate's own rail shows walk-in stages as they are: the
     regular "last stage you were told about" mapping does not apply. */
  if (typeof window.tlCandidateStage === 'function') {
    var prevCandStage = window.tlCandidateStage;
    window.tlCandidateStage = function (app) {
      if (app && isWalkinApp(app) && WST[app.stage]) return app.stage;
      return prevCandStage.apply(this, arguments);
    };
  }

  /* ---- QR code of the Application ID (lazy; optional) ---- */
  var QR_SRC = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
  var qrLib = null;
  function loadQr() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    if (qrLib) return qrLib;
    qrLib = new Promise(function (ok, bad) {
      var s = document.createElement('script');
      s.src = QR_SRC; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = function () { window.qrcode ? ok(window.qrcode) : bad(new Error('no qrcode')); };
      s.onerror = function () { qrLib = null; bad(new Error('QR library unavailable')); };
      document.head.appendChild(s);
    });
    return qrLib;
  }
  /** A data: URL of a QR code that encodes `text`. Rejects when the library cannot load. */
  function qrDataUrl(text) {
    return loadQr().then(function (qrcode) {
      var q = qrcode(0, 'M'); q.addData(String(text)); q.make();
      return q.createDataURL(4, 2);
    });
  }
  function paintQr() {
    var els = document.querySelectorAll('[data-tlwa-qr]:not([data-done])');
    Array.prototype.forEach.call(els, function (el) {
      el.setAttribute('data-done', '1');
      qrDataUrl(el.getAttribute('data-tlwa-qr')).then(function (url) {
        el.innerHTML = '<img alt="QR code of your Application ID" src="' + url + '">';
      }, function () { el.remove(); });
    });
  }

  /* ================================================================== *
   * the recruiter / admin ATS page for one job
   * ================================================================== */
  var S = { jobId: null, data: null, loading: false, err: null, key: '', f: null, sel: {}, tab: 'applicants',
    detail: {}, check: { q: '', results: null, busy: false, msg: '' }, hist: null, histErr: null, alerts: null };

  var DEFAULT_F = function () { return { q: '', stage: '', status: '', jobType: '', from: '', to: '', page: 1 }; };
  var fKey = function (jobId) { return 'tl_ats_filters_' + jobId; };

  function ensureJob(jobId) {
    if (S.jobId === jobId) return;
    S.jobId = jobId; S.data = null; S.key = ''; S.sel = {}; S.hist = null; S.alerts = null;
    S.check = { q: '', results: null, busy: false, msg: '' };
    var saved = ss.get(fKey(jobId));
    S.f = Object.assign(DEFAULT_F(), saved || {});
    S.tab = (saved && saved.tab) || 'applicants';
  }
  function saveF() { ss.set(fKey(S.jobId), Object.assign({}, S.f, { tab: S.tab })); }

  function qs() {
    var f = S.f, q = ['page=' + f.page, 'pageSize=25'];
    ['q', 'stage', 'status', 'jobType', 'from', 'to'].forEach(function (k) { if (f[k]) q.push(k + '=' + encodeURIComponent(f[k])); });
    return q.join('&');
  }
  function load(force) {
    if (!api() || !S.jobId) return;
    var key = S.jobId + '?' + qs();
    if (!force && (S.loading || S.key === key)) return;
    S.loading = true; S.key = key; S.err = null;
    api().get('/jobs/' + encodeURIComponent(S.jobId) + '/applicants?' + qs()).then(function (o) {
      S.data = o; S.loading = false; rerender();
    }).catch(function (e) { S.loading = false; S.err = errText(e); S.data = S.data || null; rerender(); });
  }

  /* ---- shared bits ---- */
  var STAGE_CLASS = { registered: 'badge-neutral', attended: 'badge-brand', interviewed: 'badge-ai', selected: 'badge-good',
    rejected: 'badge-bad', no_show: 'badge-warn' };
  function stageChip(id, label) {
    if (!WST[id] && typeof window.stageBadge === 'function' && id !== 'registered') return stageBadge(id);
    return '<span class="badge ' + (STAGE_CLASS[id] || 'badge-neutral') + '">' + h(label || STAGE_LABEL(id)) + '</span>';
  }
  function stars(n) {
    if (n == null) return '<span class="tlwa-soft">—</span>';
    var full = Math.round(n);
    return '<span class="tlwa-stars" title="' + n + ' / 5">' + '★★★★★'.slice(0, full) + '<span class="off">' + '★★★★★'.slice(full) + '</span></span> <span class="tlwa-soft">' + n + '</span>';
  }
  function nextStages(stage, walkin) {
    if (!walkin) return null;
    return TRANS.filter(function (t) { return t.from === stage; });
  }

  function tile(label, val, sub) {
    return '<div class="stat-tile"><div class="lbl">' + h(label) + '</div><div class="val tabular">' + h(val) + '</div>'
      + (sub ? '<div class="unit">' + h(sub) + '</div>' : '') + '</div>';
  }
  function tilesHtml(job) {
    if (!job) return '';
    if (job.tiles) {
      var t = job.tiles;
      var row = [tile('Total Registrations', t.totalRegistrations), tile('Registered', t.registered, 'not yet attended'),
        tile('Attended', t.attended), tile('Interviewed', t.interviewed), tile('Selected', t.selected),
        tile('Rejected', t.rejected), tile('No Show', t.noShow)];
      if (t.other) row.push(tile('Other stages', t.other, 'from before walk-in stages'));
      row.push(tile('Slot Capacity', t.capacity == null ? 'No limit' : t.capacity));
      if (t.capacity != null) row.push(tile('Remaining Capacity', t.remainingCapacity));
      return '<div class="tlwa-tiles">' + row.join('') + '</div>';
    }
    var r = job.regularTiles;
    return '<div class="tlwa-tiles">' + [tile('Total Applications', r.total), tile('New Applications', r.new),
      tile('Shortlisted', r.shortlisted), tile('In Process', r.inProcess, 'interviews & reviews'),
      tile('Selected', r.selected), tile('Rejected', r.rejected)].join('') + '</div>';
  }

  function header(job) {
    var w = job && job.walkin;
    return '<div class="tlwa-head"><button class="btn btn-ghost btn-sm" onclick="navigate(\'' + base() + '\')">← Jobs</button>'
      + '<div><h2>' + h(job ? job.title : 'Applicants') + '</h2>'
      + '<div class="mj-sub">Job ID ' + h(S.jobId) + ' · ' + h(job ? job.jobType : '') + ' job'
      + (w ? ' · ' + h([w.date, [t12(w.startTime), t12(w.endTime)].filter(Boolean).join(' – ')].filter(Boolean).join(', '))
        + (w.venue ? ' · ' + h(w.venue) : '') + ' · <span class="badge ' + (w.status === 'open' ? 'badge-good' : 'badge-neutral') + '">'
        + (w.status === 'open' ? 'Open' : 'Closed') + '</span>' : '') + '</div></div></div>';
  }

  function tabs(job) {
    var t = [['applicants', 'Applicants']];
    if (job && job.walkin) t.push(['checkin', 'Check-in']);
    t.push(['history', 'Update history']);
    return '<div class="mj-tabs">' + t.map(function (x) {
      return '<button class="mj-tab ' + (S.tab === x[0] ? 'on' : '') + '" onclick="TLWalkinAts.tab(\'' + x[0] + '\')">' + x[1] + '</button>';
    }).join('') + '</div>';
  }

  /* ---- Applicants tab ---- */
  function stageOptions(job) {
    var list = job && job.walkin
      ? WALKIN_ORDER.map(function (id) { return { id: id, label: id === 'selected' ? 'Selected' : id === 'rejected' ? 'Rejected' : STAGE_LABEL(id) }; })
      : (REGULAR || (DATA.stages || []).map(function (s) { return { id: s.id, label: s.label }; }));
    return list;
  }

  function applicantsTab(job) {
    var f = S.f, d = S.data;
    var rows = d ? d.applicants : [];
    var walkin = !!(job && job.walkin);
    var selIds = Object.keys(S.sel).filter(function (k) { return S.sel[k]; });
    var opts = stageOptions(job);
    var toolbar = '<div class="mj-toolbar">'
      + '<input type="text" id="tlwaQ" placeholder="Name, email, mobile, Candidate ID, Application ID" value="' + h(f.q) + '" onkeydown="if(event.key===\'Enter\')TLWalkinAts.search()">'
      + '<select onchange="TLWalkinAts.setF(\'jobType\',this.value)"><option value="">Job Type: All</option>'
      + '<option value="regular"' + (f.jobType === 'regular' ? ' selected' : '') + '>Regular</option>'
      + '<option value="walkin"' + (f.jobType === 'walkin' ? ' selected' : '') + '>Walk-in</option></select>'
      + '<select onchange="TLWalkinAts.setF(\'stage\',this.value)"><option value="">Stage: All</option>'
      + opts.map(function (s) { return '<option value="' + h(s.id) + '"' + (f.stage === s.id ? ' selected' : '') + '>' + h(s.label) + '</option>'; }).join('')
      + '</select>'
      + '<select onchange="TLWalkinAts.setF(\'status\',this.value)"><option value="">Status: All</option>'
      + ['Active', 'On hold', 'Closed'].map(function (s) { return '<option' + (f.status === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>'
      + '<input type="date" title="Applied from" value="' + h(f.from) + '" onchange="TLWalkinAts.setF(\'from\',this.value)">'
      + '<input type="date" title="Applied to" value="' + h(f.to) + '" onchange="TLWalkinAts.setF(\'to\',this.value)">'
      + '<button class="btn btn-primary btn-sm" onclick="TLWalkinAts.search()">🔍 Search</button>'
      + (f.q || f.stage || f.status || f.jobType || f.from || f.to ? '<button class="btn btn-ghost btn-sm" onclick="TLWalkinAts.clear()">Clear</button>' : '')
      + '<span style="flex:1"></span>'
      + '<label class="tlwa-soft" style="font-size:12px"><input type="checkbox" id="tlwaNotes"> include my team\'s notes</label>'
      + '<button class="btn btn-ghost btn-sm" onclick="TLWalkinAts.exportList(\'csv\')">⬇ CSV</button>'
      + '<button class="btn btn-ghost btn-sm" onclick="TLWalkinAts.exportList(\'xlsx\')">⬇ Excel</button>'
      + '</div>';

    var bulk = '';
    if (selIds.length) {
      var targets = walkin
        ? [['attended', 'Mark Attended'], ['interviewed', 'Mark Interviewed'], ['selected', 'Mark Selected'], ['rejected', 'Mark Rejected'], ['no_show', 'Mark No Show']]
        : opts.map(function (s) { return [s.id, s.label]; });
      bulk = '<div class="mj-bulkbar"><b>' + selIds.length + ' selected</b>'
        + (walkin
          ? targets.map(function (t) { return '<button class="btn btn-ghost btn-sm" onclick="TLWalkinAts.bulkAsk(\'' + t[0] + '\')">' + h(t[1]) + '</button>'; }).join('')
          : '<select id="tlwaBulkStage">' + targets.map(function (t) { return '<option value="' + h(t[0]) + '">' + h(t[1]) + '</option>'; }).join('') + '</select>'
            + '<button class="btn btn-ghost btn-sm" onclick="TLWalkinAts.bulkAsk(document.getElementById(\'tlwaBulkStage\').value)">Move</button>')
        + '<button class="btn btn-ghost btn-sm" onclick="TLWalkinAts.clearSel()">Clear selection</button>'
        + '<span class="tlwa-soft">Each applicant is checked on its own; invalid moves are skipped and listed.</span></div>';
    }

    var allOn = rows.length && rows.every(function (a) { return S.sel[a.applicationId]; });
    var table = '<div class="panel"><div class="panel-body pad0"><div class="tlwa-scroll"><table class="data tlwa-table"><thead><tr>'
      + '<th style="width:30px"><input type="checkbox" ' + (allOn ? 'checked' : '') + ' onchange="TLWalkinAts.selAll(this.checked)" title="Select this page"></th>'
      + '<th>Application ID</th><th>Candidate</th><th>Mobile / Email</th><th>Location</th><th>Qualification</th>'
      + '<th>Experience</th><th>Salary (current / expected)</th><th>Notice</th><th>Resume</th><th>Job</th><th>Applied</th>'
      + '<th>Stage</th><th>Status</th><th>Rating</th><th></th></tr></thead><tbody>'
      + (rows.length ? rows.map(function (a) {
        return '<tr>'
          + '<td><input type="checkbox" ' + (S.sel[a.applicationId] ? 'checked' : '') + ' onchange="TLWalkinAts.sel(\'' + js(a.applicationId) + '\',this.checked)"></td>'
          + '<td class="tlwa-mono">' + h(a.reference) + '</td>'
          + '<td><b class="mj-title tlwa-link" onclick="TLWalkinAts.open(\'' + js(a.applicationId) + '\')">' + h(a.candidateName) + '</b><div class="mj-sub">' + h(a.candidateId) + '</div></td>'
          + '<td>' + h(a.mobile || '—') + '<div class="mj-sub">' + h(a.email || '') + '</div></td>'
          + '<td>' + h(a.currentLocation || '—') + '<div class="mj-sub">' + (a.preferredLocation ? 'Prefers ' + h(a.preferredLocation) : '') + '</div></td>'
          + '<td>' + h(a.qualification || '—') + '<div class="mj-sub">' + h(a.specialization || '') + '</div></td>'
          + '<td>' + h(a.experience || '—') + '</td>'
          + '<td>' + h(a.currentSalary || '—') + ' / ' + h(a.expectedSalary || '—') + '</td>'
          + '<td>' + h(a.noticePeriod || '—') + '</td>'
          + '<td>' + (a.hasResume ? '<button class="ss-link" onclick="TLWalkinAts.resume(\'' + js(a.applicationId) + '\',false)">View</button> · <button class="ss-link" onclick="TLWalkinAts.resume(\'' + js(a.applicationId) + '\',true)">Download</button>' : '<span class="tlwa-soft">None</span>') + '</td>'
          + '<td>' + h(a.jobId) + '<div class="mj-sub">' + h(a.jobType) + '</div></td>'
          + '<td style="white-space:nowrap">' + h(fmtD(a.applicationDate)) + '</td>'
          + '<td>' + stageChip(a.stage, a.stageLabel) + (a.checkedInAt && a.stage === 'registered' ? '<div class="mj-sub">Checked in</div>' : '') + '</td>'
          + '<td>' + h(a.status) + '</td>'
          + '<td style="white-space:nowrap">' + stars(a.rating) + '</td>'
          + '<td><button class="btn btn-ghost btn-sm" onclick="TLWalkinAts.open(\'' + js(a.applicationId) + '\')">Open</button></td>'
          + '</tr>';
      }).join('') : '<tr><td colspan="16"><div class="empty-note">' + (S.loading ? 'Loading applicants…' : (f.q || f.stage || f.status || f.from || f.to || f.jobType)
        ? 'No applicants match these filters.' : 'No candidates have applied to this job yet.') + '</div></td></tr>')
      + '</tbody></table></div></div></div>';

    var pager = '';
    if (d && d.pages > 1) {
      pager = '<div class="mj-pager">Page ' + d.page + ' of ' + d.pages + ' · ' + d.total + ' applicants'
        + '<button class="btn btn-ghost btn-sm" ' + (d.page <= 1 ? 'disabled' : '') + ' onclick="TLWalkinAts.page(' + (d.page - 1) + ')">‹ Prev</button>'
        + '<button class="btn btn-ghost btn-sm" ' + (d.page >= d.pages ? 'disabled' : '') + ' onclick="TLWalkinAts.page(' + (d.page + 1) + ')">Next ›</button></div>';
    } else if (d) {
      pager = '<div class="mj-pager">' + d.total + ' applicant' + (d.total === 1 ? '' : 's') + '</div>';
    }
    return toolbar + bulk + table + pager;
  }

  /* ---- Check-in tab ---- */
  function checkinTab(job) {
    var w = job.walkin || {};
    var c = S.check;
    var opens = w.checkInOpensAt ? fmtDT(w.checkInOpensAt) : '';
    var now = Date.now();
    var inWin = w.checkInOpensAt && w.endsAt && now >= new Date(w.checkInOpensAt).getTime() && now <= new Date(w.endsAt).getTime();
    return '<div class="panel"><div class="panel-body">'
      + '<div class="tlwa-window ' + (inWin ? 'on' : '') + '">' + (inWin ? '🟢 Check-in is open' : '⏸ Outside the drive window')
      + ' — from ' + h(opens || '1 hour before the start') + ' until ' + h(w.endsAt ? fmtDT(w.endsAt) : 'the end time')
      + (inWin ? '' : '. You can still check somebody in with a reason (it is logged).') + '</div>'
      + '<div class="mj-toolbar" style="margin-top:10px">'
      + '<input type="text" id="tlwaCheckQ" placeholder="Name, mobile, Candidate ID or Application ID" value="' + h(c.q) + '" onkeydown="if(event.key===\'Enter\')TLWalkinAts.checkSearch()">'
      + '<button class="btn btn-primary btn-sm" onclick="TLWalkinAts.checkSearch()">Find</button>'
      + '<span style="flex:1"></span>'
      + '<input type="text" id="tlwaQuick" placeholder="Scan / type Application ID (TL-APP-…)" onkeydown="if(event.key===\'Enter\')TLWalkinAts.quick()">'
      + '<button class="btn btn-ghost btn-sm" onclick="TLWalkinAts.quick()">Quick Check In &amp; Attend</button></div>'
      + (c.msg ? '<div class="tlwa-note">' + h(c.msg) + '</div>' : '')
      + (c.results == null ? '<div class="empty-note">Search for the person at the desk.</div>'
        : !c.results.length ? '<div class="empty-note">Nobody on this walk-in matches.</div>'
          : '<div class="tlwa-scroll"><table class="data"><thead><tr><th>Candidate</th><th>Mobile</th><th>Application ID</th><th>Stage</th><th>Checked in</th><th>Attended</th><th></th></tr></thead><tbody>'
            + c.results.map(function (a) {
              var attended = ['attended', 'interviewed', 'selected'].indexOf(a.stage) >= 0;
              var done = a.checkedInAt && attended;
              return '<tr><td><b>' + h(a.candidateName) + '</b><div class="mj-sub">' + h(a.candidateId) + '</div></td>'
                + '<td>' + h(a.mobile) + '</td><td class="tlwa-mono">' + h(a.reference) + '</td><td>' + stageChip(a.stage, a.stageLabel) + '</td>'
                + '<td>' + (a.checkedInAt ? '<span class="badge badge-good">Already checked in</span><div class="mj-sub">' + h(fmtDT(a.checkedInAt)) + '</div>' : '—') + '</td>'
                + '<td>' + (a.attendedAt ? h(fmtDT(a.attendedAt)) : '—') + '</td>'
                + '<td style="white-space:nowrap">' + (done ? '<span class="tlwa-soft">Done</span>'
                  : (!a.checkedInAt ? '<button class="btn btn-ghost btn-sm" onclick="TLWalkinAts.checkIn(\'' + js(a.applicationId) + '\',\'check_in\')">Check In</button>' : '')
                  + (!attended ? '<button class="btn btn-ghost btn-sm" onclick="TLWalkinAts.checkIn(\'' + js(a.applicationId) + '\',\'attend\')">Mark Attended</button>' : '')
                  + (!a.checkedInAt && !attended ? '<button class="btn btn-primary btn-sm" onclick="TLWalkinAts.checkIn(\'' + js(a.applicationId) + '\',\'both\')">Check In &amp; Mark Attended</button>' : ''))
                + '</td></tr>';
            }).join('') + '</tbody></table></div>')
      + '</div></div>';
  }

  /* ---- Update history tab ---- */
  function historyTab() {
    if (!S.hist && !S.histErr) {
      if (api() && !S.histLoading) {
        S.histLoading = true;
        Promise.all([
          api().get('/jobs/' + encodeURIComponent(S.jobId) + '/update-history'),
          api().get('/jobs/' + encodeURIComponent(S.jobId) + '/ats-settings').catch(function () { return { newApplicationAlerts: 'auto' }; }),
        ]).then(function (o) { S.hist = o[0]; S.alerts = o[1].newApplicationAlerts; S.histLoading = false; rerender(); })
          .catch(function (e) { S.histErr = errText(e); S.histLoading = false; rerender(); });
      }
      return '<div class="empty-note">Loading the update history…</div>';
    }
    if (S.histErr) return '<div class="empty-note">' + h(S.histErr) + '</div>';
    var hh = S.hist;
    var RS = { pending: ['badge-warn', 'Waiting to send'], sending: ['badge-brand', 'Sending'], sent: ['badge-good', 'Sent'],
      partial: ['badge-warn', 'Partly failed'], failed: ['badge-bad', 'Sending failed'], cancelled: ['badge-neutral', 'Not needed'],
      no_recipients: ['badge-neutral', 'Nobody registered'] };
    var res = (hh.reschedules || []).map(function (r) {
      var b = RS[r.status] || ['badge-neutral', r.status];
      return '<tr><td>' + h(fmtDT(r.firstChangeAt)) + '</td><td>' + h((r.changedFields || []).map(function (x) { return x.replace('walkin_', '').replace('from', 'start time').replace(/^to$/, 'end time'); }).join(', ')) + '</td>'
        + '<td><span class="badge ' + b[0] + '">' + b[1] + '</span>' + (r.status === 'pending' ? '<div class="mj-sub">Edits within ' + Math.round(r.mergeWindowSeconds / 60) + ' min are merged into one message</div>' : '') + '</td>'
        + '<td>' + (r.sentAt ? h(r.recipients + ' registered · ' + r.delivered + ' delivered' + (r.failed ? ' · ' + r.failed + ' failed' : '')) : '—') + '</td>'
        + '<td>' + (r.status === 'pending' ? '<button class="btn btn-ghost btn-sm" onclick="TLWalkinAts.resched(' + r.id + ',\'send-now\')">Send now</button>' : '')
        + (r.status === 'failed' || r.status === 'partial' ? '<button class="btn btn-primary btn-sm" onclick="TLWalkinAts.resched(' + r.id + ',\'retry\')">Retry</button>' : '') + '</td></tr>';
    }).join('');
    var rows = (hh.history || []).map(function (x) {
      return '<tr><td style="white-space:nowrap">' + h(fmtDT(x.updatedAt)) + '</td><td>' + h(x.label) + '</td><td>' + h(x.oldValue == null ? '—' : x.oldValue) + '</td>'
        + '<td>' + h(x.newValue == null ? '—' : x.newValue) + '</td><td>' + h(x.updatedBy) + '</td></tr>';
    }).join('');
    return '<div class="panel"><div class="panel-head"><div><h2>New-application alerts</h2><div class="desc">How you hear about new applicants to this job (in the bell and by email).</div></div>'
      + '<select onchange="TLWalkinAts.alerts(this.value)">' + [['auto', 'Automatic (instant; daily digest when busy)'], ['instant', 'Every application'], ['digest', 'Daily digest'], ['off', 'Off']]
        .map(function (o) { return '<option value="' + o[0] + '"' + (S.alerts === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div></div>'
      + (res ? '<div class="panel"><div class="panel-head"><h2>Applicants notified of changes</h2></div><div class="panel-body pad0"><div class="tlwa-scroll"><table class="data"><thead><tr><th>Changed</th><th>What</th><th>Status</th><th>Result</th><th></th></tr></thead><tbody>' + res + '</tbody></table></div></div></div>' : '')
      + '<div class="panel"><div class="panel-head"><h2>Job update history</h2></div><div class="panel-body pad0"><div class="tlwa-scroll"><table class="data"><thead><tr><th>When</th><th>Field</th><th>Old value</th><th>New value</th><th>By</th></tr></thead><tbody>'
      + (rows || '<tr><td colspan="5"><div class="empty-note">No changes recorded since this job was created.</div></td></tr>') + '</tbody></table></div></div></div>';
  }

  /* ---- the candidate details page (23.9) ---- */
  function loadDetail(appId, force) {
    if (!api()) return;
    var d = S.detail[appId];
    if (d && !force && (d.loading || d.data)) return;
    S.detail[appId] = { loading: true, data: d && d.data };
    api().get('/ats/applications/' + encodeURIComponent(appId)).then(function (o) {
      S.detail[appId] = { data: o }; rerender();
    }).catch(function (e) { S.detail[appId] = { err: errText(e) }; rerender(); });
  }

  function detailPage(appId) {
    var d = S.detail[appId];
    if (!d || (!d.data && !d.err)) { loadDetail(appId); }
    var back = '<button class="btn btn-ghost btn-sm" onclick="TLWalkinAts.back()">← Back to applicants</button>';
    if (!d || (!d.data && !d.err)) return back + '<div class="empty-note">Loading…</div>';
    if (d.err) return back + '<div class="empty-note">' + h(d.err) + '</div>';
    var o = d.data, c = o.candidate, j = o.job, a = o.application, w = o.walkin;
    var walkin = !!w;
    var row = function (k, v) { return '<div class="tlwa-kv"><span>' + h(k) + '</span><b>' + (v == null || v === '' ? '—' : v) + '</b></div>'; };
    var acts = '';
    if (walkin) {
      var next = nextStages(a.stage, true) || [];
      acts = next.length ? next.map(function (t) {
        return '<button class="btn ' + (t.override ? 'btn-ghost' : 'btn-primary') + ' btn-sm" onclick="TLWalkinAts.move(\'' + js(a.applicationId) + '\',\'' + t.to + '\',' + (t.override ? 'true' : 'false') + ')">'
          + (t.override ? '↩ ' : '') + 'Mark ' + h(t.to === 'selected' ? 'Selected' : t.to === 'rejected' ? 'Rejected' : STAGE_LABEL(t.to)) + (t.override ? ' (override)' : '') + '</button>';
      }).join('') : '<span class="tlwa-soft">No further stage from ' + h(a.stageLabel) + '.</span>';
    } else {
      acts = '<select id="tlwaStageSel">' + stageOptions(null).map(function (s) { return '<option value="' + h(s.id) + '"' + (s.id === a.stage ? ' selected' : '') + '>' + h(s.label) + '</option>'; }).join('')
        + '</select><button class="btn btn-primary btn-sm" onclick="TLWalkinAts.moveRegular(\'' + js(a.applicationId) + '\',document.getElementById(\'tlwaStageSel\').value)">Move</button>';
    }
    if (a.stage === 'selected' || a.stage === 'rejected') {
      acts += '<button class="btn btn-ghost btn-sm" onclick="TLWalkinAts.decision(\'' + js(a.applicationId) + '\',\'' + a.stage + '\')">✉ Send ' + (a.stage === 'selected' ? 'Selected' : 'Not selected') + ' message</button>';
    }
    var my = a.rating.mine || 0;
    var rate = [1, 2, 3, 4, 5].map(function (n) {
      return '<button class="tlwa-star ' + (n <= my ? 'on' : '') + '" title="' + n + ' star' + (n === 1 ? '' : 's') + '" onclick="TLWalkinAts.rate(\'' + js(a.applicationId) + '\',' + n + ')">★</button>';
    }).join('');
    var notes = o.notes.map(function (n) {
      return '<div class="tlwa-noteitem"><div class="mj-sub"><b>' + h(n.createdBy) + '</b> · ' + h(fmtDT(n.createdAt)) + (n.updatedAt && n.updatedAt !== n.createdAt ? ' · edited' : '')
        + (n.canEdit ? ' · <button class="ss-link" onclick="TLWalkinAts.editNote(' + n.noteId + ')">Edit</button>' : '')
        + (n.canDelete ? ' · <button class="ss-link" onclick="TLWalkinAts.delNote(' + n.noteId + ')">Delete</button>' : '') + '</div>'
        + '<div class="tlwa-notetext" id="tlwaNote_' + n.noteId + '">' + h(n.note) + '</div></div>';
    }).join('');
    var tl = o.timeline.map(function (x) {
      return '<div class="tlwa-tl"><span class="dot ' + (x.source === 'System' ? 'sys' : '') + '"></span><div><b>' + h(x.action) + '</b>'
        + (x.override ? ' <span class="badge badge-warn">override</span>' : '')
        + '<div class="mj-sub">' + h(fmtDT(x.at)) + ' · ' + h(x.actor) + (x.reason ? ' · ' + h(x.reason) : '') + (x.note ? ' · ' + h(x.note) : '') + '</div></div></div>';
    }).join('');
    var others = o.otherApplications.length ? o.otherApplications.map(function (x) {
      return '<tr><td class="tlwa-mono">' + h(x.reference) + '</td><td>' + h(x.jobId) + '</td><td>' + h(x.jobTitle) + '</td><td>' + h(x.jobType) + '</td><td>' + stageChip(x.stage, x.stageLabel) + '</td><td>' + h(fmtD(x.applicationDate)) + '</td></tr>';
    }).join('') : '';
    return back
      + '<div class="tlwa-grid">'
      + '<div class="panel"><div class="panel-head"><h2>' + h(c.name) + '</h2>'
      + (c.hasResume ? '<div><button class="btn btn-ghost btn-sm" onclick="TLWalkinAts.resume(\'' + js(a.applicationId) + '\',false)">📄 View Resume</button> <button class="btn btn-ghost btn-sm" onclick="TLWalkinAts.resume(\'' + js(a.applicationId) + '\',true)">Download Resume</button></div>' : '<span class="tlwa-soft">No resume on file</span>')
      + '</div><div class="panel-body">'
      + row('Candidate ID', h(c.candidateId)) + row('Mobile', h(c.mobile)) + row('Email', h(c.email)) + row('Location', h(c.location))
      + row('Preferred location', h(c.preferredLocation)) + row('Qualification', h([c.qualification, c.specialization].filter(Boolean).join(' · ')))
      + row('Experience', h(c.experience)) + row('Current / expected salary', h((c.currentSalary || '—') + ' / ' + (c.expectedSalary || '—'))) + row('Notice period', h(c.noticePeriod))
      + '</div></div>'
      + '<div class="panel"><div class="panel-head"><h2>Application</h2>' + stageChip(a.stage, a.stageLabel) + '</div><div class="panel-body">'
      + row('Application ID', '<span class="tlwa-mono">' + h(a.reference) + '</span>') + row('Job ID', h(j.jobId)) + row('Job Title', h(j.title)) + row('Job Type', h(j.jobType))
      + row('Application Date', h(fmtDT(a.applicationDate))) + row('Current Stage', h(a.stageLabel)) + row('Status', h(a.status))
      + row('Rating', stars(a.rating.average) + (a.rating.count > 1 ? ' <span class="tlwa-soft">(' + a.rating.count + ' recruiters)</span>' : ''))
      + row('Last updated', h(fmtDT(a.updatedAt) + (a.updatedBy ? ' by ' + a.updatedBy : '')))
      + '<div class="tlwa-acts">' + acts + '</div>'
      + '<div class="tlwa-rate"><span class="tlwa-soft">Your rating</span> ' + rate + '</div>'
      + '</div></div>'
      + (walkin ? '<div class="panel"><div class="panel-head"><h2>Walk-in information</h2>'
        + '<span class="badge ' + (w.status === 'open' ? 'badge-good' : 'badge-neutral') + '">' + (w.status === 'open' ? 'Open' : 'Closed') + '</span></div><div class="panel-body">'
        + row('Date', h(w.date)) + row('Time', h([t12(w.startTime), t12(w.endTime)].filter(Boolean).join(' – '))) + row('Venue', h(w.venue)) + row('Address', h(w.address))
        + row('Contact person', h(w.contactPerson)) + row('Contact number', h(w.contactNumber))
        + row('Check-in time', h(w.checkedInAt ? fmtDT(w.checkedInAt) + (w.checkedInBy ? ' · ' + w.checkedInBy : '') : ''))
        + row('Attended time', h(w.attendedAt ? fmtDT(w.attendedAt) + (w.attendedBy ? ' · ' + w.attendedBy : '') : ''))
        + '<div class="tlwa-acts">'
        + (!w.checkedInAt ? '<button class="btn btn-ghost btn-sm" onclick="TLWalkinAts.checkIn(\'' + js(a.applicationId) + '\',\'check_in\')">Check In</button>' : '<span class="badge badge-good">Already checked in</span>')
        + '</div></div></div>' : '')
      + '<div class="panel"><div class="panel-head"><div><h2>Recruiter notes</h2><div class="desc">Only you, the recruiters on this job and admins see these. Never the candidate.</div></div></div><div class="panel-body">'
      + (notes || '<div class="empty-note">No notes yet.</div>')
      + '<textarea id="tlwaNewNote" rows="3" maxlength="4000" placeholder="Add a note" style="width:100%;margin-top:8px"></textarea>'
      + '<button class="btn btn-primary btn-sm" onclick="TLWalkinAts.addNote(\'' + js(a.applicationId) + '\')">Add note</button></div></div>'
      + '<div class="panel"><div class="panel-head"><h2>Timeline</h2></div><div class="panel-body">' + (tl || '<div class="empty-note">Nothing recorded yet.</div>') + '</div></div>'
      + '<div class="panel tlwa-wide"><div class="panel-head"><div><h2>Every application by this candidate</h2><div class="desc">One candidate (' + h(c.candidateId) + '), every application you can see.</div></div></div><div class="panel-body pad0"><div class="tlwa-scroll"><table class="data"><thead><tr><th>Application ID</th><th>Job ID</th><th>Job</th><th>Type</th><th>Stage</th><th>Applied</th></tr></thead><tbody>'
      + '<tr class="tlwa-cur"><td class="tlwa-mono">' + h(a.reference) + '</td><td>' + h(j.jobId) + '</td><td>' + h(j.title) + ' <span class="tlwa-soft">(this one)</span></td><td>' + h(j.jobType) + '</td><td>' + stageChip(a.stage, a.stageLabel) + '</td><td>' + h(fmtD(a.applicationDate)) + '</td></tr>'
      + others + '</tbody></table></div></div></div>'
      + '</div>';
  }

  function atsPage(p) {
    loadStages();
    ensureJob(p.applicants);
    if (p.app) return '<div class="tlwa">' + detailPage(p.app) + '</div>';
    load(false);
    var job = S.data && S.data.job;
    if (!S.data && S.err) {
      return '<div class="tlwa"><button class="btn btn-ghost btn-sm" onclick="navigate(\'' + base() + '\')">← Jobs</button><div class="empty-note">' + h(S.err) + '</div></div>';
    }
    if (!job) return '<div class="tlwa"><div class="empty-note">Loading applicants…</div></div>';
    if (S.tab === 'checkin' && !job.walkin) S.tab = 'applicants';
    var body = S.tab === 'checkin' ? checkinTab(job) : S.tab === 'history' ? historyTab() : applicantsTab(job);
    return '<div class="tlwa">' + header(job) + tilesHtml(job) + tabs(job) + body + '</div>';
  }

  /* ================================================================== *
   * actions
   * ================================================================== */
  function patchCache(appId, stage, version) {
    try {
      (DATA.applications || []).forEach(function (a) { if (a.id === appId) { a.stage = stage; if (version) a.version = version; } });
      if (window.TL && TL.primaryAppId) {
        Object.keys(TL.primaryAppId).forEach(function (cid) {
          if (TL.primaryAppId[cid] === appId) { var c = DATA.candidateById(cid); if (c) c.stage = stage; }
        });
      }
    } catch (e) { /* the cache is a convenience */ }
  }
  function refresh(appId) {
    S.key = ''; load(true);
    if (appId) loadDetail(appId, true);
    S.hist = null;
  }
  function failed(e, retryWithReason) {
    var code = e && e.code;
    if (code === 'STALE_VERSION') { say(e.message, '⚠️'); refresh(); return; }
    if ((code === 'REASON_REQUIRED' || code === 'OUTSIDE_DRIVE_WINDOW') && retryWithReason) {
      askReason(e.message, retryWithReason); return;
    }
    say(errText(e), '⚠️');
  }

  function askReason(message, then) {
    fcrModal('<div class="fcr-jd-head"><h3>A reason is needed</h3><p>' + h(message) + '</p><button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
      + '<div class="fcr-jd-body"><div class="fcr-jd-row"><label>Reason<span class="req">*</span></label><textarea id="tlwaReason" rows="3" maxlength="500" placeholder="Stored in the audit trail"></textarea></div></div>'
      + '<div class="fcr-jd-actions"><button class="btn btn-primary" id="tlwaReasonGo">Confirm</button><button class="btn btn-ghost" onclick="fcrCloseModal()">Cancel</button></div>');
    var go = document.getElementById('tlwaReasonGo');
    if (go) go.onclick = function () {
      var r = String((document.getElementById('tlwaReason') || {}).value || '').trim();
      if (!r) { say('Write the reason first', '⚠️'); return; }
      fcrCloseModal(); then(r);
    };
  }

  function currentVersion(appId) {
    var d = S.detail[appId] && S.detail[appId].data;
    if (d) return d.application.version;
    var row = S.data && S.data.applicants.filter(function (a) { return a.applicationId === appId; })[0];
    return row ? row.version : undefined;
  }

  var A = window.TLWalkinAts = {
    qrDataUrl: qrDataUrl,
    tab: function (t) { S.tab = t; saveF(); if (t === 'history') S.hist = null; rerender(); },
    setF: function (k, v) { S.f[k] = v; S.f.page = 1; S.sel = {}; saveF(); load(); rerender(); },
    search: function () { var el = document.getElementById('tlwaQ'); S.f.q = el ? el.value.trim() : ''; S.f.page = 1; S.sel = {}; saveF(); load(); rerender(); },
    clear: function () { S.f = DEFAULT_F(); S.sel = {}; saveF(); load(); rerender(); },
    page: function (n) { S.f.page = n; saveF(); load(); rerender(); },
    sel: function (id, on) { S.sel[id] = !!on; rerender(); },
    selAll: function (on) { (S.data ? S.data.applicants : []).forEach(function (a) { S.sel[a.applicationId] = !!on; }); rerender(); },
    clearSel: function () { S.sel = {}; rerender(); },
    open: function (appId) { navigate(base() + '?applicants=' + encodeURIComponent(S.jobId) + '&app=' + encodeURIComponent(appId)); },
    back: function () { navigate(base() + '?applicants=' + encodeURIComponent(S.jobId)); },

    move: function (appId, stage, override, reason) {
      if (override && !reason) {
        askReason('Moving to ' + (stage === 'rejected' ? 'Rejected' : STAGE_LABEL(stage)) + ' is an override. Why?', function (r) { A.move(appId, stage, true, r); });
        return;
      }
      api().post('/ats/applications/' + encodeURIComponent(appId) + '/stage', { stage: stage, reason: reason || undefined, expectedVersion: currentVersion(appId) })
        .then(function (o) { patchCache(appId, o.result.stage, o.result.version); say('Moved to ' + STAGE_LABEL(o.result.stage)); refresh(appId); })
        .catch(function (e) { failed(e, function (r) { A.move(appId, stage, override, r); }); });
    },
    moveRegular: function (appId, stage) {
      /* Regular jobs: the existing route, so the candidate is told exactly as before. */
      api().put('/applications/' + encodeURIComponent(appId) + '/status', { stage: stage, expectedVersion: currentVersion(appId) })
        .then(function (o) { patchCache(appId, o.application.stage, o.application.version); say('Moved to ' + STAGE_LABEL(stage)); refresh(appId); })
        .catch(function (e) { failed(e); });
    },
    bulkAsk: function (stage) {
      var ids = Object.keys(S.sel).filter(function (k) { return S.sel[k]; });
      if (!ids.length) return;
      var label = stage === 'selected' ? 'Selected' : stage === 'rejected' ? 'Rejected' : STAGE_LABEL(stage);
      fcrModal('<div class="fcr-jd-head"><h3>Move ' + ids.length + ' applicant' + (ids.length === 1 ? '' : 's') + ' to ' + h(label) + '?</h3>'
        + '<p>Each one is checked against the allowed stage moves. Valid ones are saved, the rest are skipped and listed. One audit entry per applicant.</p><button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
        + '<div class="fcr-jd-body"><div class="fcr-jd-row"><label>Reason (needed for overrides)</label><textarea id="tlwaBulkReason" rows="2" maxlength="500"></textarea></div></div>'
        + '<div class="fcr-jd-actions"><button class="btn btn-primary" onclick="TLWalkinAts.bulkGo(\'' + js(stage) + '\')">Move ' + ids.length + '</button><button class="btn btn-ghost" onclick="fcrCloseModal()">Cancel</button></div>');
    },
    bulkGo: function (stage) {
      var ids = Object.keys(S.sel).filter(function (k) { return S.sel[k]; });
      var reason = String((document.getElementById('tlwaBulkReason') || {}).value || '').trim();
      var vers = {};
      (S.data ? S.data.applicants : []).forEach(function (a) { vers[a.applicationId] = a.version; });
      var items = ids.map(function (id) { return vers[id] ? { id: id, version: vers[id] } : { id: id }; });
      fcrCloseModal();
      var walkin = !!(S.data && S.data.job && S.data.job.walkin);
      var call = walkin
        ? api().post('/ats/applications/bulk-stage', { items: items, stage: stage, reason: reason || undefined })
        : api().post('/ats/applications/bulk-stage', { items: items, stage: stage, reason: reason || undefined });
      call.then(function (o) {
        o.updated.forEach(function (u) { patchCache(u.id, u.stage, u.version); });
        S.sel = {};
        fcrModal('<div class="fcr-jd-head"><h3>' + h(o.summary) + '</h3><button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
          + '<div class="fcr-jd-body">' + (o.skipped.length ? '<div class="mj-sub" style="margin-bottom:6px">Skipped:</div>' + o.skipped.map(function (s) {
            return '<div class="fcr-modal-row"><span><b>' + h(s.name || s.id) + '</b> <span class="tlwa-soft">' + h(s.reference || '') + '</span></span><span class="tlwa-soft">' + h(s.reason) + '</span></div>';
          }).join('') : '<div class="empty-note">Every selected applicant was updated.</div>') + '</div>'
          + '<div class="fcr-jd-actions"><button class="btn btn-primary" onclick="fcrCloseModal()">Done</button></div>');
        refresh();
      }).catch(function (e) { failed(e); });
    },

    checkSearch: function () {
      var el = document.getElementById('tlwaCheckQ');
      S.check.q = el ? el.value.trim() : '';
      if (!S.check.q) return;
      S.check.msg = '';
      api().get('/jobs/' + encodeURIComponent(S.jobId) + '/check-in?q=' + encodeURIComponent(S.check.q))
        .then(function (o) { S.check.results = o.results; rerender(); })
        .catch(function (e) { failed(e); });
    },
    checkIn: function (appId, action, reason) {
      api().post('/ats/applications/' + encodeURIComponent(appId) + '/check-in', { action: action, reason: reason || undefined })
        .then(function (o) { A.afterCheck(o.result, appId); })
        .catch(function (e) { failed(e, function (r) { A.checkIn(appId, action, r); }); });
    },
    quick: function (reason) {
      var el = document.getElementById('tlwaQuick');
      var code = reason && A._lastCode ? A._lastCode : (el ? el.value.trim() : '');
      if (!code) return;
      A._lastCode = code;
      api().post('/jobs/' + encodeURIComponent(S.jobId) + '/check-in/quick', { code: code, action: 'both', reason: reason || undefined })
        .then(function (o) { A.afterCheck(o.result, o.applicationId); })
        .catch(function (e) { failed(e, function (r) { A.quick(r); }); });
    },
    afterCheck: function (r, appId) {
      S.check.msg = r.already ? 'Already checked in - nothing was changed.'
        : (r.checkedIn && r.attended ? 'Checked in and marked attended.' : r.checkedIn ? 'Checked in.' : 'Marked attended.')
          + (r.outsideWindow ? ' (outside the drive window - the reason is logged)' : '');
      say(S.check.msg, r.already ? 'ℹ️' : '✅');
      if (!r.already) patchCache(appId, r.stage, r.version);
      if (S.check.q) A.checkSearch();
      refresh(appId);
      rerender();
    },

    addNote: function (appId) {
      var el = document.getElementById('tlwaNewNote');
      var note = el ? el.value.trim() : '';
      if (!note) { say('Write a note first', '⚠️'); return; }
      api().post('/ats/applications/' + encodeURIComponent(appId) + '/notes', { note: note })
        .then(function () { say('Note added'); loadDetail(appId, true); })
        .catch(function (e) { failed(e); });
    },
    editNote: function (id) {
      var el = document.getElementById('tlwaNote_' + id);
      var cur = el ? el.textContent : '';
      fcrModal('<div class="fcr-jd-head"><h3>Edit note</h3><button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
        + '<div class="fcr-jd-body"><textarea id="tlwaEditNote" rows="4" maxlength="4000" style="width:100%"></textarea></div>'
        + '<div class="fcr-jd-actions"><button class="btn btn-primary" id="tlwaEditGo">Save</button><button class="btn btn-ghost" onclick="fcrCloseModal()">Cancel</button></div>');
      var ta = document.getElementById('tlwaEditNote'); if (ta) ta.value = cur;
      document.getElementById('tlwaEditGo').onclick = function () {
        var v = String(ta.value || '').trim();
        api().put('/ats/notes/' + id, { note: v }).then(function () {
          fcrCloseModal(); say('Note saved'); var p = params(); if (p.app) loadDetail(p.app, true);
        }).catch(function (e) { failed(e); });
      };
    },
    delNote: function (id) {
      if (!window.confirm('Delete this note? This cannot be undone.')) return;
      api().del('/ats/notes/' + id).then(function () { say('Note deleted'); var p = params(); if (p.app) loadDetail(p.app, true); })
        .catch(function (e) { failed(e); });
    },
    rate: function (appId, n) {
      api().put('/ats/applications/' + encodeURIComponent(appId) + '/rating', { rating: n })
        .then(function () { say('Rated ' + n + ' / 5', '⭐'); refresh(appId); })
        .catch(function (e) { failed(e); });
    },

    resume: function (appId, download) {
      var url = '/api/ats/applications/' + encodeURIComponent(appId) + '/resume' + (download ? '?download=1' : '');
      fetch(url, { credentials: 'same-origin' }).then(function (res) {
        if (!res.ok) return res.json().catch(function () { return null; }).then(function (j) { throw new Error((j && j.error && j.error.message) || 'That resume is not available.'); });
        var cd = res.headers.get('content-disposition') || '';
        var name = (cd.match(/filename="([^"]+)"/) || [, 'resume'])[1];
        return res.blob().then(function (b) { return { b: b, name: name }; });
      }).then(function (o) {
        var href = URL.createObjectURL(o.b);
        if (download) {
          var a = document.createElement('a'); a.href = href; a.download = o.name;
          document.body.appendChild(a); a.click(); a.remove();
        } else {
          var w = window.open(href, '_blank', 'noopener');
          if (!w) { var a2 = document.createElement('a'); a2.href = href; a2.target = '_blank'; a2.rel = 'noopener'; document.body.appendChild(a2); a2.click(); a2.remove(); }
        }
        setTimeout(function () { URL.revokeObjectURL(href); }, 60000);
      }).catch(function (e) { say(errText(e), '⚠️'); });
    },

    exportList: function (format) {
      var inc = !!(document.getElementById('tlwaNotes') || {}).checked;
      var f = S.f;
      fetch('/api/jobs/' + encodeURIComponent(S.jobId) + '/applicants/export', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() },
        body: JSON.stringify({ format: format, includeNotes: inc, filters: { q: f.q || undefined, stage: f.stage || undefined, status: f.status || undefined, from: f.from || undefined, to: f.to || undefined } }),
      }).then(function (res) {
        if (!res.ok) return res.json().catch(function () { return null; }).then(function (j) { throw new Error((j && j.error && j.error.message) || 'Export failed'); });
        var cd = res.headers.get('content-disposition') || '';
        var name = (cd.match(/filename="([^"]+)"/) || [, 'applicants.' + format])[1];
        return res.blob().then(function (b) {
          var href = URL.createObjectURL(b), a = document.createElement('a');
          a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(href); }, 4000);
          say('Exported ' + (S.data ? S.data.total : '') + ' applicants as ' + format.toUpperCase());
        });
      }).catch(function (e) { say(errText(e), '⚠️'); });
    },

    resched: function (id, action) {
      api().post('/jobs/' + encodeURIComponent(S.jobId) + '/reschedules/' + id + '/' + action, {})
        .then(function (o) {
          var r = o.result;
          say(r ? (r.status === 'sent' ? 'Applicants notified (' + r.recipients + ')' : r.status === 'no_recipients' ? 'Nobody registered to notify' : 'Sending failed for ' + r.failed + ' - you can retry') : 'Nothing to send', r && r.failed ? '⚠️' : '✅');
          S.hist = null; rerender();
        }).catch(function (e) { failed(e); });
    },
    alerts: function (v) {
      api().put('/jobs/' + encodeURIComponent(S.jobId) + '/ats-settings', { newApplicationAlerts: v })
        .then(function () { S.alerts = v; say('Alert setting saved'); }).catch(function (e) { failed(e); });
    },

    decision: function (appId, stage) {
      var kind = stage === 'selected' ? 'selected' : 'rejected';
      api().get('/ats/applications/' + encodeURIComponent(appId) + '/decision-template?kind=' + kind).then(function (t) {
        fcrModal('<div class="fcr-jd-head"><h3>' + (kind === 'selected' ? 'Selected' : 'Not selected') + ' message</h3><p>Edit before sending. It goes to the candidate in the portal, by email and SMS (and WhatsApp where set up), and is logged in the timeline.</p><button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
          + '<div class="fcr-jd-body"><div class="fcr-jd-row"><label>Subject</label><input id="tlwaDecSub" maxlength="200"></div>'
          + '<div class="fcr-jd-row"><label>Message</label><textarea id="tlwaDecBody" rows="8" maxlength="4000"></textarea></div></div>'
          + '<div class="fcr-jd-actions"><button class="btn btn-primary" id="tlwaDecGo">Send</button><button class="btn btn-ghost" onclick="fcrCloseModal()">Cancel</button></div>');
        document.getElementById('tlwaDecSub').value = t.subject;
        document.getElementById('tlwaDecBody').value = t.body;
        var go = document.getElementById('tlwaDecGo');
        go.onclick = function () {
          go.disabled = true;
          api().post('/ats/applications/' + encodeURIComponent(appId) + '/decision-message', {
            kind: kind, subject: document.getElementById('tlwaDecSub').value, body: document.getElementById('tlwaDecBody').value,
          }).then(function (o) {
            fcrCloseModal();
            var ch = o.channels || {};
            say('Message sent - ' + Object.keys(ch).map(function (k) { return k + ': ' + ch[k]; }).join(', '), '✉️');
            loadDetail(appId, true);
          }).catch(function (e) { go.disabled = false; failed(e); });
        };
      }).catch(function (e) { failed(e); });
    },
  };

  /* ================================================================== *
   * wiring into the existing pages
   * ================================================================== */

  /* "View Applicants" in Manage Jobs opens the ATS page for that job. */
  window.mjApplicantsModal = function (jobId) {
    if (window.fcrCloseModal) fcrCloseModal();
    navigate(base() + '?applicants=' + encodeURIComponent(jobId));
  };

  if (typeof window.pageRecruiterDash === 'function' && !window.pageRecruiterDash.__tlwa) {
    var prevRec = window.pageRecruiterDash;
    window.pageRecruiterDash = function (section, p) {
      p = p || params();
      if (section === 'manage-jobs' && p && p.applicants) {
        var rec = DATA.recruiterById(STATE.session.id);
        var co = rec ? DATA.companyById(rec.companyId) : null;
        return dashShell('recruiter', 'manage-jobs', 'Applicants', 'Recruiter · ' + h(co ? co.name : ''), atsPage(p));
      }
      return prevRec.apply(this, arguments);
    };
    window.pageRecruiterDash.__tlwa = true;
  }
  if (typeof window.pageAdminDash === 'function' && !window.pageAdminDash.__tlwa) {
    var prevAdm = window.pageAdminDash;
    window.pageAdminDash = function (section, p) {
      p = p || params();
      if (section === 'jobs' && p && p.applicants) {
        return dashShell('admin', 'jobs', 'Applicants', 'Admin · TeamLink Platform', atsPage(p));
      }
      return prevAdm.apply(this, arguments);
    };
    window.pageAdminDash.__tlwa = true;
  }

  /* After every render: the admin job list's applicant counts become links,
     QR codes are painted, and the stage list is fetched once signed in. */
  var prevRender = window.render;
  window.render = function () {
    var out = prevRender.apply(this, arguments);
    try {
      loadStages();
      var r = currentRoute();
      if (role() === 'admin' && r.parts[0] === 'admin' && r.parts[1] === 'jobs' && !r.params.applicants) {
        Array.prototype.forEach.call(document.querySelectorAll('#app tr.clickable[onclick*="/job/"]'), function (tr) {
          var m = (tr.getAttribute('onclick') || '').match(/\/job\/([^'"]+)/);
          /* 0125: the Jobs list marks its Applicants cell; the old list had it 4th. */
          var td = tr.querySelector('td[data-tl-applicants]') || (tr.querySelector('.tljs-when') ? null : tr.children[3]);
          if (!m || !td || td.querySelector('.tlwa-applink')) return;
          var n = td.textContent;
          td.innerHTML = '<button class="ss-link tlwa-applink" title="Open the applicants">' + h(n) + ' · View</button>';
          td.firstChild.addEventListener('click', function (ev) { ev.stopPropagation(); navigate('/admin/jobs?applicants=' + encodeURIComponent(m[1])); });
        });
      }
      if (role() === 'candidate') paintQr();
    } catch (e) { /* decoration only */ }
    return out;
  };

  /* The walk-in success screen (teamlink-walkin-jobs.js, W1) gets a QR code of
     the Application ID under the ID, for a quick check-in at the venue. */
  try {
    new MutationObserver(function () {
      var ref = document.getElementById('tlafRef');
      var done = document.getElementById('tlafDone');
      if (!ref || !done || ref.getAttribute('data-tlwa') || !/Walk-in Interview/.test(done.textContent)) return;
      ref.setAttribute('data-tlwa', '1');
      var code = ref.textContent.trim();
      qrDataUrl(code).then(function (u) {
        var d = document.createElement('div');
        d.className = 'tlwa-qr';
        d.style.cssText = 'margin:8px auto 0;text-align:center';
        d.innerHTML = '<img alt="QR code of your Application ID" src="' + u + '"><div class="tlwa-small">Show this at the venue for a quick check-in.</div>';
        ref.parentNode.insertBefore(d, ref.nextSibling);
      }, function () { /* the ID text is enough */ });
    }).observe(document.body, { childList: true, subtree: true });
  } catch (e) { /* no observer, no QR */ }

  var css = document.createElement('style');
  css.textContent = [
    '.tlwa-head{display:flex;gap:12px;align-items:flex-start;margin-bottom:12px}.tlwa-head h2{margin:0;font-size:18px}',
    '.tlwa-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:14px}',
    '.tlwa-tiles .stat-tile{padding:12px}.tlwa-tiles .val{font-size:22px}',
    '.tlwa-scroll{overflow-x:auto}.tlwa-table td{vertical-align:top;font-size:12.5px}.tlwa-mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:nowrap}',
    '.tlwa-link{cursor:pointer}.tlwa-soft{color:var(--text-soft,#7b8a9c);font-size:12px}',
    '.tlwa-stars{color:#f5a623;letter-spacing:1px}.tlwa-stars .off{color:#d5dbe3}',
    '.tlwa-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;margin-top:12px}.tlwa-grid .panel{margin:0}.tlwa-wide{grid-column:1/-1}',
    '.tlwa-kv{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--line,#eef1f5);font-size:13px}.tlwa-kv span{color:var(--text-soft,#7b8a9c)}.tlwa-kv b{text-align:right;font-weight:600}',
    '.tlwa-acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}.tlwa-rate{margin-top:10px}',
    '.tlwa-star{border:0;background:none;font-size:20px;color:#d5dbe3;cursor:pointer;padding:0 1px}.tlwa-star.on{color:#f5a623}',
    '.tlwa-noteitem{padding:8px 0;border-bottom:1px solid var(--line,#eef1f5)}.tlwa-notetext{white-space:pre-wrap;font-size:13px;margin-top:3px}',
    '.tlwa-tl{display:flex;gap:10px;padding:7px 0}.tlwa-tl .dot{width:10px;height:10px;border-radius:50%;background:var(--brand-500,#1a8fb5);margin-top:4px;flex:0 0 auto}.tlwa-tl .dot.sys{background:#9aa5b4}',
    '.tlwa-window{padding:10px 12px;border-radius:8px;background:var(--bg-alt,#f1f4f8);font-size:13px}.tlwa-window.on{background:#e8f7ee}',
    '.tlwa-note{margin:8px 0;padding:8px 12px;border-radius:8px;background:#eef6ff;font-size:13px}',
    '.tlwa-cur td{background:var(--bg-alt,#f6f8fb)}',
    '.tlwa-cand{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px;margin-top:8px;color:#42505f}',
    '.tlwa-cstatus{background:#e7f0ff;color:#1b4f9e;border-radius:10px;padding:2px 9px;font-weight:700;font-size:11px}',
    '.tlwa-cwalk{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;margin-top:8px;background:#f7fafd;border-radius:8px;padding:9px 11px;font-size:12.5px;color:#26313f}',
    '.tlwa-cwalk-body div{margin-top:2px}.tlwa-small{font-size:11px;color:#7b8794;margin-top:4px}.tlwa-qr img{width:96px;height:96px;image-rendering:pixelated}',
    '@media(max-width:600px){.tlwa-grid{grid-template-columns:1fr}.tlwa-cwalk{flex-direction:column}}',
  ].join('\n');
  document.head.appendChild(css);
})();
