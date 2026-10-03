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
   - Admin -> Availability: counts per status, "Still looking?" messages
     sent vs answered, and a button to run the re-confirm now.

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
   * 5. admin report
   * ------------------------------------------------------------------ */
  var REPORT = null;
  function adminPage() {
    return '<div class="panel"><div class="panel-head"><div><h2>Candidate availability</h2>'
      + '<div class="desc">What candidates say about their job search, and how the "Still looking?" re-confirmations are doing (last 30 days).</div></div>'
      + '<button class="btn btn-ghost btn-sm" onclick="TLAvailability.runNow(this)">Run re-confirmation now</button></div>'
      + '<div class="panel-body" id="tlavAdmin"><p class="empty-note">Loading…</p></div></div>';
  }
  function paintReport() {
    var host = document.getElementById('tlavAdmin');
    if (!host || !REPORT) return;
    var by = REPORT.byStatus || {};
    var ch = REPORT.checks || {};
    var tile = function (k, v, cls) {
      return '<div class="tlav-tile ' + (cls || '') + '"><div class="k">' + h(k) + '</div><div class="v">' + (v || 0) + '</div></div>';
    };
    host.innerHTML = '<div class="tlav-tiles">'
      + tile('Actively looking', by.actively_looking, 'g') + tile('Open to offers', by.open_to_offers, 'y')
      + tile('Not confirmed', by.not_confirmed, 'n') + tile('Unknown', by.unknown, 'n')
      + tile('Not looking', by.not_looking, 'n') + tile('Placed', by.placed, 'b') + '</div>'
      + '<h3 class="tlav-h3">"Still looking?" messages</h3><div class="tlav-tiles">'
      + tile('Sent', ch.sent) + tile('Answered', ch.answered, 'g') + tile('No answer (14 days)', ch.lapsed, 'n') + tile('Waiting', ch.open) + '</div>'
      + '<div class="tlav-sub" style="margin-top:8px">By channel: ' + h(Object.keys(ch.byChannel || {}).map(function (k) { return k + ' ' + ch.byChannel[k]; }).join(' · ') || '—')
      + ' &middot; Answers: ' + h(Object.keys(ch.byAnswer || {}).map(function (k) { return k.replace(/_/g, ' ') + ' ' + ch.byAnswer[k]; }).join(' · ') || '—') + '</div>';
  }
  function loadReport() {
    api().get('/admin/availability/report').then(function (r) { REPORT = r.report || {}; paintReport(); })
      .catch(function (e) { var host = document.getElementById('tlavAdmin'); if (host) host.innerHTML = '<p class="empty-note">' + h((e && e.message) || 'Could not load') + '</p>'; });
  }

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
        ? window.dashShell('admin', 'availability', 'Candidate availability', 'Admin · TeamLink Platform', adminPage())
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
          if (host && !host.getAttribute('data-loaded')) { host.setAttribute('data-loaded', '1'); REPORT ? paintReport() : null; loadReport(); }
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
    runNow: function (btn) {
      if (btn) btn.disabled = true;
      api().post('/admin/availability/run', {}).then(function (r) {
        var x = r.run || {};
        say(x.skipped ? 'Not sent: ' + x.skipped : 'Asked ' + (x.asked || 0) + ' candidate(s), ' + (x.sent || 0) + ' delivered', '🟢');
        loadReport();
      }).catch(function (e) { say((e && e.message) || 'Could not run', '⚠️'); })
        .then(function () { if (btn) btn.disabled = false; });
    },
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
    + '@media (max-width:640px){.tlav-opts{width:100%}.tlav-opt{flex:1}.tlav-more label,.tlav-more select,.tlav-more input{width:100%}}';
  var tag = document.createElement('style');
  tag.id = 'tlav-css';
  tag.textContent = css;
  (document.head || document.documentElement).appendChild(tag);
})();
