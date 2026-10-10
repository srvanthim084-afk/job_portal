/* =====================================================================
   TEAMLINK — candidate availability status (migration 0092)

   The candidate says whether they are looking; recruiters search and
   rank by it; it is re-confirmed so it never goes stale.

   CANDIDATE
   - Registration: "Are you looking for a job?" (default Actively looking),
     sent with the registration itself.
   - Profile: a status bar under the header - Actively looking / Open to
     offers / Not looking in one tap, plus "can join in", preferred roles
     and cities. Saved to /api/candidate/availability.

   RECRUITER / ADMIN
   - A pill on every Talent Pool row, Find Candidates card and the
     candidate profile: green Actively looking, yellow Open to offers,
     grey Not looking / Not confirmed, blue Placed - with "can join in"
     and "updated N days ago".
   - An "Availability" filter on both screens (multi-select). By default
     the server hides Not looking and Placed; "Show all" shows them. The
     filter and the ranking run in SQL; this only adds the parameters.
   - Admin -> Availability: four cards - Total Candidates, Attended
     Interviews, Moved to ATS, Not Looking - each opening its candidate
     list (search, filters, pages) and the candidate's record. Real counts
     from the server; the "Still looking?" figures are no longer shown.

   Clients never see any of it - the server does not send it to them.
   The status cannot be changed by a recruiter: the server refuses it.
   ===================================================================== */
(function () {
  'use strict';
  if (window.TLAvailability) return;

  var api = function () { return window.TL && window.TL.api; };
  var h = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  };
  var say = function (m, i) { if (typeof window.toast === 'function') window.toast(m, i || '✓'); };
  var session = function () { return (window.STATE && window.STATE.session) || null; };
  var role = function () { var s = session(); return s ? s.role : null; };
  var isStaff = function () { return ['recruiter', 'admin', 'bde'].indexOf(role()) >= 0; };

  var STATUS = [
    ['actively_looking', 'Actively looking', 'Ready for a new job now'],
    ['open_to_offers', 'Open to offers', 'Have a job; would move for a good offer'],
    ['not_looking', 'Not looking', 'Not interested right now'],
  ];
  var JOIN = ['Immediate', '15 days', '30 days', '60 days', '90 days'];
  var FILTERS = [
    ['actively_looking', 'Actively looking'], ['open_to_offers', 'Open to offers'], ['unknown', 'Unknown'],
    ['not_confirmed', 'Not confirmed'], ['not_looking', 'Not looking'], ['placed', 'Placed'],
  ];

  function ago(iso) {
    if (!iso) return '';
    var d = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
    return d === 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago';
  }

  /** The recruiter-side pill. `full` adds the joining time and the age. */
  function pill(av, full) {
    if (!av || !av.status) return '';
    if (!full && av.status === 'unknown') return '';
    var cls = av.notConfirmed ? 'grey' : { actively_looking: 'green', open_to_offers: 'yellow', not_looking: 'grey',
      placed: 'blue', unknown: 'grey' }[av.status] || 'grey';
    var label = av.notConfirmed ? 'Not confirmed' : av.label || av.status;
    var extra = [];
    if (av.canJoinIn && av.status !== 'placed' && av.status !== 'not_looking') {
      extra.push(av.canJoinIn === 'Immediate' ? 'can join immediately' : 'can join in ' + av.canJoinIn);
    }
    if (av.updatedAt) extra.push('updated ' + ago(av.confirmedAt || av.updatedAt));
    var title = (av.notConfirmed ? 'Said "' + (av.label || '') + '" but did not answer the re-confirmation. ' : '')
      + extra.join(' · ');
    return '<span class="tlav-pill tlav-' + cls + '" title="' + h(title) + '">' + h(label) + '</span>'
      + (full && extra.length ? '<span class="tlav-sub">' + h(extra.join(' · ')) + '</span>' : '');
  }

  /* ------------------------------------------------------------------ *
   * 1. registration
   * ------------------------------------------------------------------ */
  function decorateRegister() {
    var notice = document.getElementById('regNotice');
    if (!notice || document.getElementById('regAvailability')) return;
    var field = notice.closest('.review-field');
    if (!field) return;
    var div = document.createElement('div');
    div.className = 'review-field';
    div.innerHTML = '<label for="regAvailability">Are you looking for a job? *</label>'
      + '<select id="regAvailability">' + STATUS.map(function (s, i) {
        return '<option value="' + s[0] + '"' + (i === 0 ? ' selected' : '') + '>' + h(s[1]) + ' — ' + h(s[2]) + '</option>';
      }).join('') + '</select>';
    field.parentNode.insertBefore(div, field.nextSibling);
  }

  /** The answer travels with the registration request itself. */
  function wrapApi() {
    var a = api();
    if (!a || a.__tlav) return !!a;
    var post = a.post, get = a.get;
    a.post = function (path, body, opts) {
      if (path === '/auth/register' && body && typeof body === 'object' && !body.availability) {
        var el = document.getElementById('regAvailability');
        if (el && el.value) body = Object.assign({}, body, { availability: el.value });
      }
      return post.call(this, path, body, opts);
    };
    /* The search screens build their own query strings; the availability
       filter is added to theirs rather than rebuilding them. */
    a.get = function (path, opts) {
      var search = typeof path === 'string' && path.indexOf('/candidates?') === 0 && isStaff();
      if (search && onSearchScreen()) {
        path += availabilityQuery();
      }
      var out = get.call(this, path, opts);
      /* Every staff search answer carries each row's status: it replaces
         whatever was cached, so an application or a reply since the last
         search shows on the next one. (Talent Pool rows are not in DATA,
         so this is the only fresh source for them.) */
      if (search && out && typeof out.then === 'function') {
        out.then(function (res) {
          ((res && res.candidates) || []).forEach(function (c) {
            if (c && c.id && c.availabilityStatus && typeof c.availabilityStatus === 'object') KNOWN[c.id] = c.availabilityStatus;
          });
        }, function () { /* the caller handles it */ });
      }
      return out;
    };
    a.__tlav = true;
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 2. the candidate's own status
   * ------------------------------------------------------------------ */
  var MINE = { data: null, at: 0, loading: false, open: false, saving: false, err: '' };

  function loadMine(force) {
    if (MINE.loading || (!force && MINE.data && Date.now() - MINE.at < 60000)) return;
    MINE.loading = true;
    api().get('/candidate/availability').then(function (r) {
      MINE.data = r.availability; MINE.at = Date.now();
    }).catch(function () { /* the bar shows an error state */ })
      .then(function () { MINE.loading = false; paintMine(); });
  }

  function mineHtml() {
    var av = MINE.data;
    if (!av) return '<div class="tlav-me" id="tlavMe"><span class="tlav-me-h">Job search status</span><span class="tlav-sub">Loading…</span></div>';
    var current = av.status;
    var buttons = STATUS.map(function (s) {
      return '<button type="button" class="tlav-opt' + (current === s[0] ? ' on tlav-on-' + s[0] : '') + '"'
        + (MINE.saving ? ' disabled' : '') + ' onclick="TLAvailability.set(\'' + s[0] + '\')" title="' + h(s[2]) + '">'
        + h(s[1]) + '</button>';
    }).join('');
    var note = current === 'placed'
      ? 'You joined a job through TeamLink. Recruiters will not contact you about other roles for now.'
      : av.notConfirmed ? 'Please confirm - recruiters see your status as "Not confirmed".'
      : av.updatedAt ? 'Updated ' + ago(av.confirmedAt || av.updatedAt) + '. Recruiters see this; employers do not.'
      : 'Recruiters see this; employers do not.';
    var more = MINE.open ? '<div class="tlav-more">'
      + '<label>Can join in<select id="tlavJoin"><option value="">—</option>' + JOIN.map(function (j) {
        return '<option' + (av.canJoinIn === j ? ' selected' : '') + '>' + h(j) + '</option>';
      }).join('') + '</select></label>'
      + '<label>Preferred roles<input id="tlavRoles" maxlength="400" placeholder="e.g. Medical Coder, Data Entry" value="' + h((av.preferredRoles || []).join(', ')) + '"></label>'
      + '<label>Preferred cities<input id="tlavCities" maxlength="400" placeholder="e.g. Nellore, Chennai" value="' + h((av.preferredCities || []).join(', ')) + '"></label>'
      + '<button type="button" class="tlav-save" onclick="TLAvailability.saveMore()"' + (MINE.saving ? ' disabled' : '') + '>Save</button>'
      + '</div>' : '';
    return '<div class="tlav-me" id="tlavMe"><div class="tlav-me-row"><span class="tlav-me-h">Job search status</span>'
      + '<div class="tlav-opts">' + buttons + '</div>'
      + '<button type="button" class="tlav-link" onclick="TLAvailability.toggleMore()">' + (MINE.open ? 'Less' : 'Joining time & preferences') + '</button></div>'
      + '<div class="tlav-sub">' + h(note) + (av.canJoinIn ? ' · Can join: ' + h(av.canJoinIn) : '') + '</div>'
      + (MINE.err ? '<div class="tlav-err">' + h(MINE.err) + '</div>' : '') + more + '</div>';
  }

  function paintMine() {
    if (role() !== 'candidate' || (location.hash || '').indexOf('#/candidate/profile') !== 0) return;
    var old = document.getElementById('tlavMe');
    var html = mineHtml();
    if (old) { old.outerHTML = html; return; }
    var head = document.querySelector('.cap-phead');
    var host = head ? head.parentNode : null;
    if (!host) return;
    var div = document.createElement('div');
    div.innerHTML = html;
    host.insertBefore(div.firstChild, head.nextSibling);
  }

  function save(body, msg) {
    MINE.saving = true; MINE.err = ''; paintMine();
    return api().put('/candidate/availability', body).then(function (r) {
      MINE.data = r.availability; MINE.at = Date.now();
      /* The profile page reads the notice period from the bootstrap copy. */
      try {
        var c = window.DATA && DATA.candidateById && DATA.candidateById(session().id);
        if (c && r.noticePeriod) c.noticePeriod = r.noticePeriod;
      } catch (e) { /* cosmetic */ }
      say(msg || 'Status updated', '✓');
    }).catch(function (e) {
      MINE.err = (e && e.message) || 'That could not be saved.';
    }).then(function () { MINE.saving = false; paintMine(); });
  }

  function splitList(v) {
    return String(v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 10);
  }

  /* ------------------------------------------------------------------ *
   * 3. recruiter: pills on rows, cards and the profile
   * ------------------------------------------------------------------ */
  function rowsOnScreen() {
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll('#tpHost tbody tr'), function (tr) {
      var cb = tr.querySelector('input[type="checkbox"]');
      var m = cb && /tpPick\('([^']+)'/.exec(cb.getAttribute('onchange') || '');
      var cell = tr.querySelector('td.who');
      if (m && cell) out.push({ id: m[1], host: cell });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.fcr-card'), function (card) {
      var cb = card.querySelector('.fcr-card-check input');
      var m = cb && /fcrToggleSelect\('([^']+)'/.exec(cb.getAttribute('onchange') || '');
      var top = card.querySelector('.fcr-card-top');
      if (m && top) out.push({ id: m[1], host: top });
    });
    return out;
  }

  /** Straight from the search response when it carried the field. */
  function fromData(id) {
    var c = window.DATA && DATA.candidateById ? DATA.candidateById(id) : null;
    return (c && c.availabilityStatus && typeof c.availabilityStatus === 'object') ? c.availabilityStatus : null;
  }

  var KNOWN = {};
  function paintRows() {
    if (!isStaff()) return;
    var rows = rowsOnScreen();
    var missing = [];
    rows.forEach(function (r) {
      /* The search response is the fresher of the two: a status cached
         earlier must not hide a change (an application, a reply). */
      var fresh = fromData(r.id);
      if (fresh) KNOWN[r.id] = fresh;
      var av = fresh || KNOWN[r.id];
      if (!av) { missing.push(r.id); return; }
      var key = av.status + (av.notConfirmed ? '!' : '');
      if (r.host.getAttribute('data-tlav') === key) return;
      r.host.setAttribute('data-tlav', key);
      var old = r.host.querySelector('.tlav-slot');
      if (old) old.remove();
      var html = pill(av, false);
      if (!html) return;
      var span = document.createElement('span');
      span.className = 'tlav-slot';
      span.innerHTML = html;
      r.host.appendChild(span);
    });
    if (missing.length && window.TLEngagement) {
      window.TLEngagement.badges(missing, null).then(function (map) {
        Object.keys(map).forEach(function (id) { if (map[id] && map[id].availability) KNOWN[id] = map[id].availability; });
        paintRows();
      });
    }
  }

  document.addEventListener('tl:badges', function (e) {
    var map = (e && e.detail && e.detail.badges) || {};
    Object.keys(map).forEach(function (id) { if (map[id] && map[id].availability) KNOWN[id] = map[id].availability; });
  });

  /* The profile: next to the name, from the activity panel's data. */
  document.addEventListener('tl:engagement', function (e) {
    var d = e && e.detail;
    if (!d || !d.data || !d.data.availability) return;
    KNOWN[d.candidateId] = d.data.availability;
    paintProfile(d.candidateId, d.data.availability);
  });
  function paintProfile(id, av) {
    var h2 = document.querySelector('.dash-body .panel .panel-body h2');
    if (!h2) return;
    var old = document.getElementById('tlavProfile');
    if (old && old.getAttribute('data-for') === id + '|' + av.status + '|' + av.updatedAt) return;
    if (old) old.remove();
    var div = document.createElement('div');
    div.id = 'tlavProfile';
    div.className = 'tlav-prof';
    div.setAttribute('data-for', id + '|' + av.status + '|' + av.updatedAt);
    div.innerHTML = pill(av, true)
      + (av.preferredRoles && av.preferredRoles.length ? '<span class="tlav-sub">Wants: ' + h(av.preferredRoles.join(', ')) + '</span>' : '')
      + (av.preferredCities && av.preferredCities.length ? '<span class="tlav-sub">In: ' + h(av.preferredCities.join(', ')) + '</span>' : '');
    h2.parentNode.insertBefore(div, h2.nextSibling);
  }

  /* ------------------------------------------------------------------ *
   * 4. the filter
   * ------------------------------------------------------------------ */
  var FILTER = (function () {
    try { var s = JSON.parse(sessionStorage.getItem('tlav_filter') || 'null'); if (s && Array.isArray(s.statuses)) return s; }
    catch (e) { /* private window */ }
    return { statuses: [], showAll: false };
  })();
  function keepFilter() { try { sessionStorage.setItem('tlav_filter', JSON.stringify(FILTER)); } catch (e) { /* */ } }

  function onSearchScreen() {
    var hsh = location.hash || '';
    return hsh.indexOf('#/recruiter/find-candidates') === 0 || hsh.indexOf('#/recruiter/talent-pool') === 0
      || hsh.indexOf('#/recruiter/candidates') === 0;
  }
  function availabilityQuery() {
    if (FILTER.statuses.length) return '&availability=' + encodeURIComponent(FILTER.statuses.join(','));
    if (FILTER.showAll) return '&availabilityAll=true';
    return '';
  }

  function filterHtml() {
    return '<div class="tlav-bar" id="tlavBar"><span class="tlav-bar-h">Availability</span>'
      + FILTERS.map(function (f) {
        var on = FILTER.statuses.indexOf(f[0]) >= 0;
        return '<button type="button" class="tlav-chip' + (on ? ' on' : '') + '" onclick="TLAvailability.toggle(\'' + f[0] + '\')">' + h(f[1]) + '</button>';
      }).join('')
      + '<label class="tlav-all"><input type="checkbox" id="tlavShowAll"' + (FILTER.showAll && !FILTER.statuses.length ? ' checked' : '')
      + (FILTER.statuses.length ? ' disabled' : '') + ' onchange="TLAvailability.showAll(this.checked)"> Show all</label>'
      + '<span class="tlav-sub">' + (FILTER.statuses.length ? 'Showing only the statuses picked.'
        : FILTER.showAll ? 'Showing everybody.' : 'Not looking and Placed are hidden.') + '</span></div>';
  }

  function paintFilter() {
    if (!isStaff() || !onSearchScreen()) return;
    var bar = document.getElementById('tlavBar');
    var anchor = document.querySelector('.fcr-toolbar') || document.getElementById('tpHost');
    if (!anchor) return;
    /* Rebuilt only when the filter changed: a repaint here is itself a
       DOM change, and the observer would otherwise answer it forever. */
    var key = JSON.stringify(FILTER);
    if (bar && bar.nextElementSibling === anchor && bar.getAttribute('data-key') === key) return;
    if (bar) bar.remove();
    var div = document.createElement('div');
    div.innerHTML = filterHtml();
    div.firstChild.setAttribute('data-key', key);
    anchor.parentNode.insertBefore(div.firstChild, anchor);
  }

  function refetch() {
    keepFilter();
    paintFilter();
    var hsh = location.hash || '';
    if (hsh.indexOf('#/recruiter/find-candidates') === 0 && window.TL && TL.fcr) {
      TL.fcr.rows = null; TL.fcr.key = '';
      if (typeof window.render === 'function') window.render();
    } else if (typeof window.tpLoad === 'function') {
      if (window.STATE && STATE.talentPool) STATE.talentPool.offset = 0;
      window.tpLoad();
    }
  }

  /* ------------------------------------------------------------------ *
   * 5. Admin -> Availability: four cards, and the candidates behind each
   *
   *   Total Candidates · Attended Interviews · Moved to ATS · Not Looking
   *
   * Every number and every row comes from the server
   * (GET /api/admin/availability/summary and /candidates - admin only);
   * a card opens its list on this same page, with search, filters and
   * pages; a name opens the candidate's record (GET /api/ats/candidates/:id/record).
   * ------------------------------------------------------------------ */
  var CARDS = [
    ['total', 'Total Candidates', 'totalCandidates', 'Every candidate record, counted once'],
    ['attended', 'Attended Interviews', 'attendedInterviews', 'Attendance recorded - scheduled interviews are not counted'],
    ['ats', 'Moved to ATS', 'movedToAts', 'A recorded move into the hiring pipeline'],
    ['not_looking', 'Not Looking', 'notLooking', 'The candidate said they are not looking'],
  ];
  var AV = { summary: null, sumErr: '', view: null, q: '', recruiterId: '', availability: '', stage: '', page: 1, pageSize: 20,
    data: null, loading: false, err: '', seq: 0, filters: null };

  function istDay(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  }
  function cardOf(k) { return CARDS.filter(function (c) { return c[0] === k; })[0] || null; }

  function adminPage() {
    return '<div class="stat-row tlav-cards" id="tlavCards">' + cardsHtml() + '</div>'
      + '<div id="tlavAdmin">' + listShellHtml() + '</div>';
  }
  function cardsHtml() {
    return CARDS.map(function (c) {
      var v = AV.summary ? AV.summary[c[2]] : null;
      var on = AV.view === c[0];
      return '<button type="button" class="stat-tile tlav-card' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-card="' + c[0] + '"'
        + ' onclick="TLAvailability.open(\'' + c[0] + '\')">'
        + '<div class="lbl">' + h(c[1]) + '</div>'
        + '<div class="val tabular">' + (AV.summary ? h(v == null ? 0 : v) : AV.sumErr ? '—' : '…') + '</div>'
        + '<div class="unit">' + h(c[3]) + '</div></button>';
    }).join('');
  }
  function paintCards() {
    var host = document.getElementById('tlavCards');
    if (host) host.innerHTML = cardsHtml();
    var err = document.getElementById('tlavSumErr');
    if (err) err.remove();
    if (AV.sumErr && host) {
      var p = document.createElement('div');
      p.id = 'tlavSumErr';
      p.className = 'tlav-err';
      p.innerHTML = 'The counts could not be loaded: ' + h(AV.sumErr) + ' <button type="button" class="btn btn-ghost btn-sm" onclick="TLAvailability.reload()">Retry</button>';
      host.parentNode.insertBefore(p, host.nextSibling);
    }
  }
  function loadSummary() {
    AV.sumErr = '';
    return api().get('/admin/availability/summary').then(function (r) { AV.summary = r.summary || {}; paintCards(); },
      function (e) { AV.sumErr = (e && e.message) || 'Could not load'; paintCards(); });
  }

  /* the list: the toolbar is drawn once per card (typing keeps its focus); the rows are redrawn */
  function listShellHtml() {
    if (!AV.view) {
      return '<div class="panel"><div class="panel-body"><p class="empty-note">Choose a card above to see those candidates.</p></div></div>';
    }
    var c = cardOf(AV.view);
    var f = AV.filters || { recruiters: [], availability: [], stages: [] };
    var opt = function (list, sel, all) {
      return '<option value="">' + h(all) + '</option>' + list.map(function (x) {
        return '<option value="' + h(x.id) + '"' + (x.id === sel ? ' selected' : '') + '>' + h(x.label || x.name) + '</option>';
      }).join('');
    };
    return '<div class="panel tlav-list"><div class="panel-head"><div><h2>' + h(c[1]) + '</h2><div class="desc">' + h(c[3]) + '</div></div>'
      + '<button type="button" class="btn btn-ghost btn-sm" onclick="TLAvailability.back()">← Back to summary</button></div>'
      + '<div class="panel-body tlav-tools">'
      + '<input type="search" id="tlavQ" placeholder="Search name, email, phone, candidate ID, job" value="' + h(AV.q) + '" oninput="TLAvailability.search(this.value)">'
      + '<select id="tlavRec" onchange="TLAvailability.filter(\'recruiterId\', this.value)" aria-label="Recruiter">'
      + opt(f.recruiters.map(function (r) { return { id: r.id, label: r.name }; }).concat([{ id: 'none', label: 'No recruiter assigned' }]), AV.recruiterId, 'All recruiters') + '</select>'
      + '<select id="tlavAv" onchange="TLAvailability.filter(\'availability\', this.value)" aria-label="Availability">'
      + opt(f.availability, AV.availability, 'Any availability') + '</select>'
      + '<select id="tlavSt" onchange="TLAvailability.filter(\'stage\', this.value)" aria-label="ATS stage">'
      + opt(f.stages, AV.stage, 'Any stage') + '</select>'
      + '<button type="button" class="btn btn-ghost btn-sm" id="tlavClear" onclick="TLAvailability.clear()"' + (filtered() ? '' : ' hidden') + '>Clear filters</button>'
      + '</div><div id="tlavRows">' + rowsHtml() + '</div></div>';
  }
  function rowsHtml() {
    if (AV.err) {
      return '<div class="panel-body"><p class="empty-note">' + h(AV.err)
        + ' <button type="button" class="btn btn-ghost btn-sm" onclick="TLAvailability.retry()">Retry</button></p></div>';
    }
    if (!AV.data) return '<div class="panel-body"><p class="empty-note">Loading candidates…</p></div>';
    var d = AV.data;
    var body = (d.rows || []).map(function (x) {
      var iv = x.interview;
      var ivCell = iv ? '<span class="badge ' + (iv.attended ? 'badge-ok' : iv.status === 'Scheduled' ? 'badge-brand' : 'badge-neutral') + '">' + h(iv.status) + '</span>'
        + (iv.date ? '<div class="tlav-sm">' + h(istDay(iv.date)) + '</div>' : '') : '<span class="tlav-sm">—</span>';
      var atsCell = x.ats ? '<span class="badge badge-ai">' + h(x.ats.status || 'In ATS') + '</span><div class="tlav-sm">Moved ' + h(istDay(x.ats.movedAt)) + '</div>'
        : x.stageLabel ? '<span class="tlav-sm">Not moved · ' + h(x.stageLabel) + '</span>' : '<span class="tlav-sm">—</span>';
      var a = x.availability || {};
      var avCls = a.status === 'actively_looking' && a.label !== 'Not confirmed' ? 'tlav-green' : a.status === 'open_to_offers' && a.label !== 'Not confirmed' ? 'tlav-yellow'
        : a.status === 'placed' ? 'tlav-blue' : 'tlav-grey';
      return '<tr class="tlav-row" data-id="' + h(x.id) + '">'
        + '<td><button type="button" class="tlav-name" onclick="TLAvailability.profile(\'' + h(x.id) + '\')">' + h(x.name || 'Unnamed') + '</button>'
        + (x.candidateCode ? '<div class="tlav-sm">' + h(x.candidateCode) + '</div>' : '') + '</td>'
        + '<td>' + (x.phone ? '<div>' + h(x.phone) + '</div>' : '') + (x.email ? '<div class="tlav-sm">' + h(x.email) + '</div>' : '') + (!x.phone && !x.email ? '—' : '') + '</td>'
        + '<td>' + (x.job ? h(x.job) : x.preferredRole ? '<span class="tlav-sm">Prefers: </span>' + h(x.preferredRole) : '—') + '</td>'
        + '<td>' + (x.recruiterName ? h(x.recruiterName) : '<span class="tlav-sm">Not assigned</span>') + '</td>'
        + '<td>' + ivCell + '</td>'
        + '<td>' + atsCell + '</td>'
        + '<td><span class="tlav-pill ' + avCls + '">' + h(a.label || 'Status unknown') + '</span></td></tr>';
    }).join('');
    var from = d.total ? (d.page - 1) * d.pageSize + 1 : 0;
    var to = Math.min(d.page * d.pageSize, d.total);
    var pages = Math.max(1, Math.ceil(d.total / d.pageSize));
    return '<div class="tbl-wrap' + (AV.loading ? ' tlav-busy' : '') + '"><table class="data"><thead><tr><th>Candidate</th><th>Phone / Email</th><th>Applied job / Preferred role</th>'
      + '<th>Recruiter</th><th>Interview</th><th>ATS</th><th>Availability</th></tr></thead><tbody>'
      + (body || '<tr><td colspan="7"><div class="empty-note">' + (filtered()
        ? 'No candidates match these filters.' : 'No candidates here yet.') + '</div></td></tr>')
      + '</tbody></table></div>'
      + '<div class="tlav-pg"><span class="tlav-sm">' + (d.total ? 'Showing ' + from + '–' + to + ' of ' + d.total + ' candidate' + (d.total === 1 ? '' : 's') : '0 candidates') + '</span>'
      + '<span><button type="button" class="btn btn-ghost btn-sm" ' + (d.page <= 1 ? 'disabled' : '') + ' onclick="TLAvailability.page(' + (d.page - 1) + ')">← Previous</button>'
      + ' <span class="tlav-sm">Page ' + d.page + ' of ' + pages + '</span> '
      + '<button type="button" class="btn btn-ghost btn-sm" ' + (d.page >= pages ? 'disabled' : '') + ' onclick="TLAvailability.page(' + (d.page + 1) + ')">Next →</button></span></div>';
  }
  function filtered() { return !!(AV.q || AV.recruiterId || AV.availability || AV.stage); }
  function paintRowsOnly() {
    var host = document.getElementById('tlavRows');
    if (host) host.innerHTML = rowsHtml();
    var clr = document.getElementById('tlavClear');
    if (clr) clr.hidden = !filtered();
  }
  function paintList() {
    var host = document.getElementById('tlavAdmin');
    if (host) host.innerHTML = listShellHtml();
  }
  function loadList() {
    if (!AV.view) return Promise.resolve();
    var seq = ++AV.seq;
    AV.loading = true; AV.err = '';
    paintRowsOnly();
    var qs = 'metric=' + encodeURIComponent(AV.view) + '&page=' + AV.page + '&pageSize=' + AV.pageSize
      + (AV.q ? '&q=' + encodeURIComponent(AV.q) : '') + (AV.recruiterId ? '&recruiterId=' + encodeURIComponent(AV.recruiterId) : '')
      + (AV.availability ? '&availability=' + encodeURIComponent(AV.availability) : '') + (AV.stage ? '&stage=' + encodeURIComponent(AV.stage) : '');
    return api().get('/admin/availability/candidates?' + qs).then(function (r) {
      if (seq !== AV.seq) return;
      AV.loading = false; AV.data = r;
      var first = !AV.filters;
      AV.filters = r.filters || AV.filters;
      if (first) paintList(); else paintRowsOnly();
    }, function (e) {
      if (seq !== AV.seq) return;
      AV.loading = false; AV.err = (e && e.message) || 'The candidates could not be loaded.';
      paintRowsOnly();
    });
  }

  /* the candidate's record, in the existing modal */
  function profileHtml(rec) {
    var r = rec || {};
    var row = function (k, v) { return v ? '<div><span class="tlav-sm">' + h(k) + '</span><div>' + v + '</div></div>' : ''; };
    var apps = (r.applications || []).map(function (a) {
      return '<tr><td>' + h(a.jobTitle || '') + (a.company ? '<div class="tlav-sm">' + h(a.company) + '</div>' : '') + '</td><td>' + h(a.stageLabel || a.stage || '') + '</td><td>' + h(istDay(a.appliedAt)) + '</td></tr>';
    }).join('');
    var ivs = (r.interviews || []).map(function (i) {
      return '<tr><td>' + h(i.jobTitle || '') + '</td><td>' + h(i.round || '') + '</td><td>' + h(i.date || '') + (i.time ? ' ' + h(i.time) : '') + '</td><td>' + h(i.state || '') + '</td></tr>';
    }).join('');
    var tl = (r.timeline || []).slice(0, 12).map(function (e) {
      return '<li><b>' + h(e.text || e.label) + '</b>' + (e.job && !e.text ? ' · ' + h(e.job) : '') + (e.detail ? ' · ' + h(e.detail) : '') + ' <span class="tlav-sm">' + h(istDay(e.at)) + '</span></li>';
    }).join('');
    return '<div class="fcr-jd-head"><h3>' + h(r.name || 'Candidate') + '</h3><p>' + h([r.candidateCode, r.experience && r.experience.title].filter(Boolean).join(' · ')) + '</p>'
      + '<button class="fcr-jd-x" onclick="fcrCloseModal()" aria-label="Close">✕</button></div>'
      + '<div class="fcr-jd-body"><div class="tlav-kv">'
      + row('Email', h(r.email || '')) + row('Phone', h(r.mobile || ''))
      + row('Current stage', r.currentStage ? h(r.currentStage.label) + (r.currentStage.job ? ' · ' + h(r.currentStage.job) : '') : '')
      + row('Experience', h((r.experience && r.experience.label) || '')) + row('Current company', h((r.experience && r.experience.currentCompany) || ''))
      + row('Profile score', r.profileScore == null ? '' : h(r.profileScore + '%'))
      + row('Skills', h((r.skills || []).slice(0, 12).join(', ')))
      + '</div>'
      + '<h4 class="tlav-h4">Applications</h4>' + (apps ? '<div class="tbl-wrap"><table class="data"><thead><tr><th>Job</th><th>Stage</th><th>Applied</th></tr></thead><tbody>' + apps + '</tbody></table></div>' : '<p class="tlav-sm">No applications.</p>')
      + '<h4 class="tlav-h4">Interviews</h4>' + (ivs ? '<div class="tbl-wrap"><table class="data"><thead><tr><th>Job</th><th>Round</th><th>Date</th><th>Status</th></tr></thead><tbody>' + ivs + '</tbody></table></div>' : '<p class="tlav-sm">No interviews.</p>')
      + '<h4 class="tlav-h4">Timeline</h4>' + (tl ? '<ul class="tlav-tl">' + tl + '</ul>' : '<p class="tlav-sm">Nothing recorded yet.</p>')
      + '</div><div class="fcr-jd-actions"><button class="btn btn-ghost" onclick="fcrCloseModal()">Close</button></div>';
  }
  function openProfile(id) {
    if (typeof window.fcrModal !== 'function') return;
    window.fcrModal('<div class="fcr-jd-head"><h3>Candidate</h3><button class="fcr-jd-x" onclick="fcrCloseModal()" aria-label="Close">✕</button></div>'
      + '<div class="fcr-jd-body"><p class="empty-note">Loading the candidate…</p></div>');
    var host = document.getElementById('fcrModalHost');
    if (host) host.classList.add('tlav-modal');
    api().get('/ats/candidates/' + encodeURIComponent(id) + '/record').then(function (r) {
      var m = document.querySelector('#fcrModalHost .fcr-modal');
      if (m) m.innerHTML = profileHtml(r.record);
    }, function (e) {
      var m = document.querySelector('#fcrModalHost .fcr-modal');
      if (m) m.innerHTML = '<div class="fcr-jd-head"><h3>Candidate</h3><button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
        + '<div class="fcr-jd-body"><p class="empty-note">' + h((e && e.message) || 'This candidate could not be loaded.') + '</p></div>';
    });
  }

  function loadReport() { loadSummary(); if (AV.view) loadList(); }

  function installAdmin() {
    try {
      var nav = (typeof NAV_CONFIG !== 'undefined' && NAV_CONFIG.admin) || null;
      if (nav && !nav.some(function (n) { return n[0] === 'availability'; })) nav.push(['availability', 'Availability', '🟢']);
    } catch (e) { /* reachable by URL */ }
    var prev = window.pageAdminDash;
    if (typeof prev !== 'function' || prev.__tlav) return;
    var next = function (section) {
      if (section !== 'availability') return prev.apply(this, arguments);
      return typeof window.dashShell === 'function'
        ? window.dashShell('admin', 'availability', 'Candidate Availability', 'Admin · TeamLink Platform', adminPage())
        : adminPage();
    };
    next.__tlav = true;
    window.pageAdminDash = next;
  }

  /* ------------------------------------------------------------------ *
   * after every paint
   * ------------------------------------------------------------------ */
  var scheduled = false;
  function afterPaint() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      wrapApi();
      var hsh = location.hash || '';
      try {
        if (hsh.indexOf('#/register/candidate') === 0) decorateRegister();
        if (role() === 'candidate' && hsh.indexOf('#/candidate/profile') === 0) {
          if (!MINE.data) loadMine(false);
          if (!document.getElementById('tlavMe')) paintMine();
        }
        if (isStaff()) { paintFilter(); paintRows(); }
        if (hsh.indexOf('#/admin/availability') === 0) {
          var host = document.getElementById('tlavAdmin');
          if (host && !host.getAttribute('data-loaded')) { host.setAttribute('data-loaded', '1'); loadReport(); }
        }
      } catch (e) { /* cosmetic; the server enforces */ }
    }, 40);
  }

  function install() {
    if (typeof window.render !== 'function' || !api()) return false;
    wrapApi();
    installAdmin();
    var prevRender = window.render;
    if (!prevRender.__tlav) {
      var next = function () { var r = prevRender.apply(this, arguments); afterPaint(); return r; };
      next.__tlav = true;
      window.render = next;
    }
    try {
      new MutationObserver(function () { afterPaint(); })
        .observe(document.getElementById('app') || document.body, { childList: true, subtree: true });
    } catch (e) { /* render() covers it */ }
    afterPaint();
    return true;
  }

  window.TLAvailability = {
    pill: pill,
    set: function (status) {
      var label = (STATUS.filter(function (s) { return s[0] === status; })[0] || [])[1];
      save({ status: status }, 'Status: ' + (label || status));
    },
    toggleMore: function () { MINE.open = !MINE.open; paintMine(); },
    saveMore: function () {
      var body = {
        canJoinIn: ((document.getElementById('tlavJoin') || {}).value) || undefined,
        preferredRoles: splitList((document.getElementById('tlavRoles') || {}).value),
        preferredCities: splitList((document.getElementById('tlavCities') || {}).value),
      };
      save(body, 'Preferences saved').then(function () { MINE.open = false; paintMine(); });
    },
    toggle: function (s) {
      var i = FILTER.statuses.indexOf(s);
      if (i >= 0) FILTER.statuses.splice(i, 1); else FILTER.statuses.push(s);
      refetch();
    },
    showAll: function (on) { FILTER.showAll = !!on; refetch(); },
    /* Admin -> Availability */
    open: function (k) {
      if (!cardOf(k)) return;
      if (AV.view !== k) { AV.view = k; AV.page = 1; AV.data = null; AV.err = ''; }
      paintCards(); paintList(); loadList();
      var list = document.getElementById('tlavAdmin');
      if (list && list.scrollIntoView) { try { list.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* old browsers */ } }
    },
    back: function () { AV.view = null; AV.data = null; AV.err = ''; paintCards(); paintList(); loadSummary(); },
    search: function (v) {
      clearTimeout(AV.t);
      AV.t = setTimeout(function () { AV.q = String(v || '').trim(); AV.page = 1; loadList(); }, 300);
    },
    filter: function (k, v) { AV[k] = v || ''; AV.page = 1; paintList(); loadList(); },
    clear: function () { AV.q = ''; AV.recruiterId = ''; AV.availability = ''; AV.stage = ''; AV.page = 1; paintList(); loadList(); },
    page: function (n) { AV.page = Math.max(1, n | 0); loadList(); },
    retry: function () { loadList(); },
    reload: function () { loadSummary(); },
    profile: function (id) { openProfile(id); },
  };

  var tries = 0;
  (function wait() { if (install()) return; if (++tries < 80) setTimeout(wait, 250); })();

  var css = ''
    + '.tlav-slot{display:inline-flex;margin-left:6px;vertical-align:middle}'
    + 'td.who .tlav-slot{display:flex;margin:4px 0 0}'
    + '.tlav-pill{display:inline-block;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:800;line-height:1.5;white-space:nowrap}'
    + '.tlav-green{background:#e3f6ea;color:#16703d}'
    + '.tlav-yellow{background:#fff6d6;color:#8a6400}'
    + '.tlav-grey{background:#eef1f5;color:#5b6b82}'
    + '.tlav-blue{background:#e6f0ff;color:#1d4fa8}'
    + '.tlav-sub{font-size:11.5px;color:#7a8798;margin-left:6px}'
    + '.tlav-prof{display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin:4px 0 2px}'
    + '.tlav-me{border-top:1px solid #eef1f5;margin-top:12px;padding-top:12px}'
    + '.tlav-me-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}'
    + '.tlav-me-h{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#7a8798}'
    + '.tlav-me .tlav-sub{display:block;margin:6px 0 0}'
    + '.tlav-opts{display:inline-flex;border:1px solid #d9e0ea;border-radius:999px;overflow:hidden;flex-wrap:wrap}'
    + '.tlav-opt{border:0;background:#fff;padding:6px 13px;font:inherit;font-size:12.5px;font-weight:700;color:#42505f;cursor:pointer}'
    + '.tlav-opt+.tlav-opt{border-left:1px solid #d9e0ea}'
    + '.tlav-opt.on.tlav-on-actively_looking{background:#16a34a;color:#fff}'
    + '.tlav-opt.on.tlav-on-open_to_offers{background:#eab308;color:#1f1a00}'
    + '.tlav-opt.on.tlav-on-not_looking{background:#64748b;color:#fff}'
    + '.tlav-opt:disabled{opacity:.6;cursor:wait}'
    + '.tlav-link{border:0;background:none;color:#1d6ff2;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;padding:0}'
    + '.tlav-more{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-top:10px}'
    + '.tlav-more label{display:flex;flex-direction:column;gap:4px;font-size:11px;font-weight:800;color:#7a8798;text-transform:uppercase;letter-spacing:.04em}'
    + '.tlav-more select,.tlav-more input{border:1px solid #d9e0ea;border-radius:8px;padding:7px 9px;font:inherit;font-size:13px;text-transform:none;letter-spacing:0;font-weight:400;color:#1b2536;min-width:160px}'
    + '.tlav-save{border:0;background:#1490b3;color:#fff;border-radius:8px;padding:8px 14px;font:inherit;font-weight:800;cursor:pointer}'
    + '.tlav-err{color:#b3261e;font-size:12px;margin-top:6px}'
    + '.tlav-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 10px;padding:8px 11px;background:var(--bg-alt,#f6f9fc);border:1px solid var(--line,#e6ebf2);border-radius:10px}'
    + '.tlav-bar-h{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#7a8798;margin-right:2px}'
    + '.tlav-chip{border:1px solid #dde4ee;background:#fff;color:#3a4a5e;border-radius:999px;padding:4px 11px;font:inherit;font-size:12px;cursor:pointer}'
    + '.tlav-chip.on{background:#1490b3;border-color:#1490b3;color:#fff}'
    + '.tlav-all{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;color:#3a4a5e;margin-left:4px}'
    + '.tlav-tiles{display:flex;gap:10px;flex-wrap:wrap}'
    + '.tlav-tile{border:1px solid #e6ebf2;border-radius:10px;padding:10px 14px;min-width:120px}'
    + '.tlav-tile .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#8895a7}'
    + '.tlav-tile .v{font-size:22px;font-weight:800;color:#1b2536}'
    + '.tlav-tile.g .v{color:#16703d}.tlav-tile.y .v{color:#8a6400}.tlav-tile.b .v{color:#1d4fa8}.tlav-tile.n .v{color:#5b6b82}'
    + '.tlav-h3{font-size:13px;margin:16px 0 8px;color:#2b3a4f}'
    + '.tlav-cards .tlav-card{font:inherit;text-align:left;color:inherit;cursor:pointer;width:100%;transition:border-color .15s,box-shadow .15s}'
    + '.tlav-cards .tlav-card:hover{border-color:var(--brand-500,#4f46e5)}'
    + '.tlav-cards .tlav-card:focus-visible{outline:2px solid var(--brand-500,#4f46e5);outline-offset:2px}'
    + '.tlav-cards .tlav-card.on{border-color:var(--brand-600,#4338ca);box-shadow:0 0 0 1px var(--brand-600,#4338ca) inset}'
    + '.tlav-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-bottom:1px solid var(--line,#e6ebf2)}'
    + '.tlav-tools input,.tlav-tools select{border:1px solid var(--line,#d9e0ea);border-radius:8px;padding:7px 10px;font:inherit;font-size:13px;background:var(--card,#fff);color:inherit;min-width:150px}'
    + '.tlav-tools input{flex:1 1 260px}'
    + '.tlav-name{border:0;background:none;padding:0;font:inherit;font-weight:700;color:var(--brand-700,#3730a3);cursor:pointer;text-align:left}'
    + '.tlav-name:hover{text-decoration:underline}'
    + '.tlav-sm{font-size:11.5px;color:var(--text-soft,#7a8798)}'
    + '.tlav-pg{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px}'
    + '.tlav-busy{opacity:.55;pointer-events:none}'
    + '.tlav-kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px 16px;margin-bottom:6px}'
    + '.tlav-h4{font-size:13px;margin:16px 0 6px}'
    + '.tlav-tl{margin:0;padding-left:18px;font-size:13px;line-height:1.7}'
    + '@media (max-width:640px){.tlav-opts{width:100%}.tlav-opt{flex:1}.tlav-more label,.tlav-more select,.tlav-more input{width:100%}}';
  var tag = document.createElement('style');
  tag.id = 'tlav-css';
  tag.textContent = css;
  (document.head || document.documentElement).appendChild(tag);
})();
