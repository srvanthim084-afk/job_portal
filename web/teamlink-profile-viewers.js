/*
 * TeamLink — "Who viewed my profile".
 *
 * Candidate side
 *   - a page, #/candidate/viewers: profile views, search appearances and
 *     times shortlisted for the last 30 days against the 30 before, a bar
 *     per week for eight weeks, and the list - "Priya (TeamLink Recruiter)
 *     viewed your profile for Medical Coder · 2 hours ago", "A hiring team
 *     reviewed your profile ..." - 20 at a time
 *   - a row in the menu, and a card on Home ("18 profile views this month")
 *   - the "Profile viewed" line on Profile Performance, which was read out
 *     of the browser, now comes from the server; so does the search
 *     appearances count
 *   - the 7 PM digest shows in the bell
 *
 * Staff side (no screen of its own)
 *   - opening a candidate profile, a resume, or a client's shortlist
 *     records a view (POST /api/candidates/:id/viewed). The server decides
 *     who viewed and in what role; this only says which candidate.
 *   - a page of search results reports which of the server's own results
 *     were on screen, with the token the search returned
 *   - the old RECRUITER_VIEWED notification no longer carries a company
 *     name (0051)
 *
 * Administrator: two switches on Notification Settings.
 *
 * Nothing about a viewer is stored in the browser.
 */
(function () {
  'use strict';

  var S = { data: null, page: 1, loading: null, at: 0, err: '' };

  var api = function () { return window.TL && TL.api; };
  var role = function () { return window.STATE && STATE.session ? STATE.session.role : null; };
  var isCand = function () { return role() === 'candidate'; };
  var isStaff = function () { return ['recruiter', 'bde', 'client', 'admin'].indexOf(role()) >= 0; };
  var h = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  };
  var rerender = function () { if (typeof window.render === 'function') render(); };
  var say = function (m, i) { if (typeof window.toast === 'function') toast(m, i || '👀'); };

  function ago(ts) {
    var t = Date.parse(ts || ''); if (!t) return '';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) { var m = Math.round(s / 60); return m + ' minute' + (m === 1 ? '' : 's') + ' ago'; }
    if (s < 86400) { var hr = Math.round(s / 3600); return hr + ' hour' + (hr === 1 ? '' : 's') + ' ago'; }
    if (s < 2 * 86400) return 'yesterday';
    if (s < 7 * 86400) return Math.round(s / 86400) + ' days ago';
    try { return new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); } catch (e) { return ''; }
  }
  function change(now, prev) {
    var d = (now || 0) - (prev || 0);
    if (!now && !prev) return '<span class="tlpv-d">No change</span>';
    return '<span class="tlpv-d ' + (d > 0 ? 'up' : d < 0 ? 'down' : '') + '">'
      + (d > 0 ? '+' + d : d < 0 ? String(d) : 'Same') + ' vs previous 30 days</span>';
  }

  /* ------------------------------------------------------------------ *
   * styles
   * ------------------------------------------------------------------ */
  var css = ''
    + '.tlpv-h{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:14px}'
    + '.tlpv-h h1{margin:0;font-size:21px;font-weight:800;color:#16202c}'
    + '.tlpv-h p{margin:3px 0 0;font-size:12.5px;color:#7b8794}'
    + '.tlpv-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:12px}'
    + '.tlpv-stat b{display:block;font-size:28px;font-weight:800;color:#16202c;line-height:1.1}'
    + '.tlpv-stat .l{font-size:12.5px;font-weight:700;color:#42505f;margin:2px 0 6px}'
    + '.tlpv-d{font-size:11.5px;font-weight:700;color:#8a94a6}.tlpv-d.up{color:#0f7a44}.tlpv-d.down{color:#b4292b}'
    + '.tlpv-chart{display:flex;align-items:flex-end;gap:8px;height:130px;padding:8px 2px 0;border-bottom:1px solid #eef1f5}'
    + '.tlpv-bar{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;min-width:0}'
    + '.tlpv-bar i{display:block;width:100%;max-width:38px;background:linear-gradient(180deg,#3b82f6,#1d6ff2);border-radius:6px 6px 0 0;min-height:2px}'
    + '.tlpv-bar span{font-size:11px;font-weight:800;color:#26313f;margin-bottom:3px}'
    + '.tlpv-axis{display:flex;gap:8px;margin-top:5px}.tlpv-axis span{flex:1;text-align:center;font-size:10.5px;color:#8a94a6;min-width:0;overflow:hidden;white-space:nowrap}'
    + '.tlpv-row{display:flex;gap:11px;align-items:flex-start;padding:11px 0;border-top:1px solid #f0f3f7}'
    + '.tlpv-row:first-child{border-top:0}'
    + '.tlpv-av{flex:0 0 auto;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;background:#eaf2ff;color:#1d6ff2}'
    + '.tlpv-av.team{background:#e8f6ee;color:#0f7a44}'
    + '.tlpv-txt{font-size:13px;color:#26313f;line-height:1.45}.tlpv-txt b{color:#16202c}'
    + '.tlpv-when{font-size:11.5px;color:#8a94a6;margin-top:2px}'
    + '.tlpv-tip{display:flex;gap:12px;align-items:center;flex-wrap:wrap;background:linear-gradient(120deg,#f4f8ff,#fff);border:1px solid #dbe7fb;border-radius:14px;padding:13px 15px;margin-bottom:12px}'
    + '.tlpv-tip p{margin:0;flex:1;min-width:200px;font-size:13px;color:#26313f}'
    + '.tlpv-pager{display:flex;gap:8px;justify-content:center;align-items:center;margin-top:10px;font-size:12px;color:#7b8794}'
    + '.tlpv-two{display:grid;grid-template-columns:1.3fr 1fr;gap:12px;align-items:start}'
    + '@media(max-width:900px){.tlpv-two{grid-template-columns:1fr}}'
    + '.tlpv-home{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:#fff;border:1px solid #e6ebf2;border-radius:12px;padding:12px 15px;margin-bottom:14px;cursor:pointer}'
    + '.tlpv-home b{font-size:15px;color:#16202c}.tlpv-home span{font-size:12px;color:#7b8794}'
    + '.tlpv-sw{display:flex;align-items:center;gap:8px;font-size:13px;color:#26313f;padding:5px 0}'
    + '.tlpv-sw input{width:16px;height:16px;accent-color:#1d6ff2}';
  function addCss() {
    if (document.getElementById('tlpvCss')) return;
    var st = document.createElement('style'); st.id = 'tlpvCss'; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ------------------------------------------------------------------ *
   * data
   * ------------------------------------------------------------------ */
  function load(force, page) {
    if (!isCand() || !api()) return Promise.resolve(null);
    if (page) S.page = page;
    if (S.loading) return S.loading;
    if (!force && S.data && Date.now() - S.at < 30000) return Promise.resolve(S.data);
    S.at = Date.now();
    S.loading = api().get('/candidate/profile-viewers?page=' + S.page).then(function (d) {
      S.data = d; S.err = ''; S.loading = null; S.at = Date.now(); rerender(); return d;
    }).catch(function (e) {
      S.loading = null; S.err = (e && e.message) || 'This could not be loaded.'; rerender(); return null;
    });
    return S.loading;
  }
  window.tlpvPage = function (n) { S.page = Math.max(1, n); load(true); };

  /* ------------------------------------------------------------------ *
   * the page
   * ------------------------------------------------------------------ */
  function line(v) {
    var team = v.viewerKind === 'hiring_team';
    var verb = team ? 'reviewed your profile' : (v.source === 'resume' ? 'viewed your resume' : 'viewed your profile');
    return '<div class="tlpv-row">'
      + '<div class="tlpv-av' + (team ? ' team' : '') + '" aria-hidden="true">'
      + (team ? '👥' : h(/^A TeamLink/.test(v.displayName || '') ? 'T' : String(v.displayName || 'T').charAt(0))) + '</div>'
      + '<div style="min-width:0"><div class="tlpv-txt"><b>' + h(v.displayName) + '</b> ' + verb
      + (v.roleTitle ? ' for <b>' + h(v.roleTitle) + '</b>' : '') + '</div>'
      + '<div class="tlpv-when">' + h(ago(v.viewedAt)) + (v.viewCount > 1 ? ' · opened ' + v.viewCount + ' times that day' : '') + '</div></div></div>';
  }

  function chart(weeks) {
    weeks = (weeks || []).slice(-8);
    var max = Math.max(1, Math.max.apply(null, weeks.map(function (w) { return w.views || 0; })));
    var label = function (d) {
      try { return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); } catch (e) { return d; }
    };
    return '<div class="tlpv-chart" role="img" aria-label="Profile views per week, last 8 weeks: '
      + weeks.map(function (w) { return w.views || 0; }).join(', ') + '">'
      + weeks.map(function (w) {
        var pct = Math.round(((w.views || 0) / max) * 100);
        return '<div class="tlpv-bar" title="Week of ' + h(label(w.start)) + ': ' + (w.views || 0) + ' view' + (w.views === 1 ? '' : 's') + '">'
          + '<span>' + (w.views || 0) + '</span><i style="height:' + Math.max(pct, 2) + '%"></i></div>';
      }).join('') + '</div>'
      + '<div class="tlpv-axis">' + weeks.map(function (w, i) {
        return '<span>' + (i === weeks.length - 1 ? 'This week' : h(label(w.start))) + '</span>';
      }).join('') + '</div>';
  }

  function pageHtml() {
    addCss();
    var d = S.data;
    var head = '<div class="tlpv-h"><div><h1>👀 Who viewed my profile</h1>'
      + '<p>Last 30 days, compared with the 30 days before. Recruiters are shown by first name; hiring teams are never named.</p></div>'
      + '<button class="cp-btn" onclick="location.hash=\'#/candidate/performance\'">Profile Performance</button></div>';
    if (!d) {
      if (!S.loading) load(true);
      return head + '<div class="cp-card" style="text-align:center;color:#7b8794;padding:30px">'
        + (S.err ? '⚠️ ' + h(S.err) + ' <button class="cp-btn" onclick="tlpvPage(1)">Try again</button>' : 'Loading who viewed your profile…') + '</div>';
    }
    var s = d.summary;
    var stats = '<div class="tlpv-stats">'
      + '<div class="cp-card tlpv-stat"><b>' + s.views30 + '</b><div class="l">Profile views</div>' + change(s.views30, s.viewsPrev30) + '</div>'
      + '<div class="cp-card tlpv-stat"><b>' + s.appear30 + '</b><div class="l">Search appearances</div>' + change(s.appear30, s.appearPrev30) + '</div>'
      + '<div class="cp-card tlpv-stat"><b>' + s.shortlisted30 + '</b><div class="l">Times shortlisted</div>' + change(s.shortlisted30, s.shortlistedPrev30) + '</div>'
      + '</div>';
    var tip = d.tip ? '<div class="tlpv-tip"><span style="font-size:22px" aria-hidden="true">💡</span><p>' + h(d.tip.text) + '</p>'
      + '<button class="cp-btn pri" onclick="location.hash=\'' + h(d.tip.link || '#/candidate/resume-score') + '\'">See my resume score</button></div>' : '';
    var pages = Math.max(1, Math.ceil((d.total || 0) / (d.pageSize || 20)));
    var list = '<div class="cp-card"><div class="cp-h2" style="margin:0 0 6px"><h2 style="font-size:15px">Who viewed you</h2>'
      + '<span style="font-size:11.5px;color:#8a94a6">' + (d.total || 0) + ' in all</span></div>'
      + (d.viewers.length ? d.viewers.map(line).join('')
        : '<div class="cp-empty" style="padding:18px"><div style="font-size:28px">👀</div><h3 style="margin:6px 0">No profile views yet</h3>'
          + '<p style="font-size:12.5px;color:#7b8794">When a TeamLink recruiter or a hiring team opens your profile, it shows here.</p></div>')
      + (pages > 1 ? '<div class="tlpv-pager"><button class="cp-btn" ' + (d.page <= 1 ? 'disabled' : 'onclick="tlpvPage(' + (d.page - 1) + ')"') + '>‹ Newer</button>'
        + '<span>Page ' + d.page + ' of ' + pages + '</span><button class="cp-btn" ' + (d.page >= pages ? 'disabled' : 'onclick="tlpvPage(' + (d.page + 1) + ')"') + '>Older ›</button></div>' : '')
      + '</div>';
    var searches = (s.searches || []).filter(function (x) { return x.role || x.city; });
    var side = '<div class="cp-card" style="margin-bottom:12px"><div class="cp-h2" style="margin:0 0 4px"><h2 style="font-size:15px">Views per week</h2>'
      + '<span style="font-size:11.5px;color:#8a94a6">last 8 weeks</span></div>' + chart(s.weeks) + '</div>'
      + '<div class="cp-card" style="margin-bottom:12px"><div class="cp-h2" style="margin:0 0 4px"><h2 style="font-size:15px">Searches you appeared in</h2></div>'
      + (searches.length ? searches.slice(0, 6).map(function (x) {
        return '<div class="tlpv-row"><div class="tlpv-av" aria-hidden="true">🔎</div><div><div class="tlpv-txt">Your profile appeared in a search for <b>'
          + h([x.role, x.city].filter(Boolean).join(', ')) + '</b></div><div class="tlpv-when">'
          + h(ago(x.day + 'T12:00:00')) + (x.count > 1 ? ' · ' + x.count + ' searches that day' : '') + '</div></div></div>';
      }).join('') : '<div style="font-size:12.5px;color:#7b8794;padding:6px 0">' + (s.appear30
        ? 'You appeared in ' + s.appear30 + ' search' + (s.appear30 === 1 ? '' : 'es') + ' this month.'
        : 'No recruiter searches have shown your profile in the last 30 days.') + '</div>')
      + '</div>'
      + '<div class="cp-card"><div class="cp-h2" style="margin:0 0 4px"><h2 style="font-size:15px">Daily summary</h2></div>'
      + '<div style="font-size:12.5px;color:#7b8794;margin-bottom:6px">'
      + (d.dailyDigest ? 'On days someone views your profile, we tell you at 7 PM: "3 recruiters viewed your profile today". It is always in your notifications; you can also get it by:'
        : 'The daily summary is turned off for everyone at the moment.') + '</div>'
      + (d.dailyDigest
        ? '<label class="tlpv-sw"><input type="checkbox" ' + (d.prefs.digestEmail ? 'checked ' : '') + (d.prefs.canEmail ? '' : 'disabled ') + 'onchange="tlpvPref(\'digestEmail\',this.checked)"> Email</label>'
          + '<label class="tlpv-sw"><input type="checkbox" ' + (d.prefs.digestWhatsapp ? 'checked ' : '') + (d.prefs.canWhatsapp ? '' : 'disabled ') + 'onchange="tlpvPref(\'digestWhatsapp\',this.checked)"> WhatsApp</label>'
        : '')
      + '</div>';
    return head + stats + tip + '<div class="tlpv-two"><div>' + list + '</div><div>' + side + '</div></div>';
  }

  window.tlpvPref = function (k, on) {
    var body = {}; body[k] = !!on;
    api().put('/candidate/profile-viewers/prefs', body).then(function (r) {
      if (S.data && r && r.prefs) { S.data.prefs.digestEmail = r.prefs.digestEmail; S.data.prefs.digestWhatsapp = r.prefs.digestWhatsapp; }
      say(on ? 'Daily summary turned on' : 'Daily summary turned off', '🔔');
      rerender();
    }).catch(function (e) { say((e && e.message) || 'That could not be saved.', '⚠️'); rerender(); });
  };

  function wrapPage() {
    var prev = window.pageCandidateDash;
    if (typeof prev !== 'function' || prev.__tlpv) return;
    var next = function (section) {
      if (section === 'viewers' && isCand()) {
        var html = pageHtml();
        return typeof window.cpShell === 'function' ? cpShell('viewers', html) : html;
      }
      return prev.apply(this, arguments);
    };
    next.__tlpv = true;
    window.pageCandidateDash = next;
  }

  /* the menu: after Profile Performance */
  function wrapMenus() {
    try {
      if (typeof NAV_CONFIG !== 'undefined' && NAV_CONFIG.candidate
          && !NAV_CONFIG.candidate.some(function (x) { return x[0] === 'viewers'; })) {
        var at = NAV_CONFIG.candidate.findIndex(function (x) { return x[0] === 'performance'; });
        NAV_CONFIG.candidate.splice(at >= 0 ? at + 1 : NAV_CONFIG.candidate.length, 0, ['viewers', 'Who viewed my profile', '👀']);
      }
    } catch (e) { /* no sidebar config */ }
    var prevDrawer = window.nkDrawerHtml;
    if (typeof prevDrawer === 'function' && !prevDrawer.__tlpv) {
      var d = function () {
        var html = prevDrawer.apply(this, arguments);
        if (typeof html !== 'string' || html.indexOf('#/candidate/viewers') >= 0) return html;
        var at = html.indexOf("nkGo('#/candidate/performance')");
        if (at < 0) return html;
        var end = html.indexOf('</button>', at);
        if (end < 0) return html;
        var row = '<button class="nk-row ' + (location.hash === '#/candidate/viewers' ? 'on' : '') + '" onclick="nkGo(\'#/candidate/viewers\')"><span class="ic">👀</span>Who viewed my profile</button>';
        return html.slice(0, end + 9) + row + html.slice(end + 9);
      };
      d.__tlpv = true;
      window.nkDrawerHtml = d;
    }
    var prevShell = window.cpShell;
    if (typeof prevShell === 'function' && !prevShell.__tlpv) {
      var sh = function () {
        var html = prevShell.apply(this, arguments);
        if (typeof html !== 'string' || html.indexOf("location.hash='#/candidate/viewers';cpOpen('')") >= 0) return html;
        var at = html.indexOf("location.hash='#/candidate/performance';cpOpen('')");
        if (at < 0) return html;
        var end = html.indexOf('</button>', at);
        if (end < 0) return html;
        return html.slice(0, end + 9) + '<button onclick="location.hash=\'#/candidate/viewers\';cpOpen(\'\')">Who viewed my profile</button>' + html.slice(end + 9);
      };
      sh.__tlpv = true;
      window.cpShell = sh;
    }
  }

  /* Home: "18 profile views this month" */
  function wrapHome() {
    var prev = window.cpHome;
    if (typeof prev !== 'function' || prev.__tlpv) return;
    var next = function () {
      var html = prev.apply(this, arguments);
      if (!isCand() || typeof html !== 'string') return html;
      addCss();
      if (!S.data) { load(); return html; }
      var s = S.data.summary;
      var card = '<div class="tlpv-home" role="button" tabindex="0" onclick="location.hash=\'#/candidate/viewers\'" '
        + 'onkeydown="if(event.key===\'Enter\')location.hash=\'#/candidate/viewers\'">'
        + '<span style="font-size:24px" aria-hidden="true">👀</span><div style="flex:1;min-width:180px"><b>'
        + s.views30 + ' profile view' + (s.views30 === 1 ? '' : 's') + ' this month</b><br><span>'
        + (s.viewsToday ? s.viewsToday + ' today · ' : '') + s.appear30 + ' search appearance' + (s.appear30 === 1 ? '' : 's')
        + (s.views30 || s.viewsPrev30 ? ' · ' + (s.views30 - s.viewsPrev30 >= 0 ? '+' : '') + (s.views30 - s.viewsPrev30) + ' vs previous 30 days' : '')
        + '</span></div><button class="cp-btn">See who viewed</button></div>';
      var at = html.indexOf('<section class="cp-hero');
      if (at < 0) return card + html;
      return html.slice(0, at) + card + html.slice(at);
    };
    next.__tlpv = true;
    window.cpHome = next;
  }

  /* Profile Performance: real views and appearances, not the browser's */
  function wrapPerformance() {
    var prevActs = window.capActions;
    if (typeof prevActs === 'function' && !prevActs.__tlpv) {
      var a = function (c) {
        var out = (prevActs.apply(this, arguments) || []).filter(function (x) { return x.kind !== 'viewed'; });
        if (isCand() && S.data && c && STATE.session && String(c.id) === String(STATE.session.id)) {
          S.data.viewers.forEach(function (v) {
            out.push({ kind: 'viewed', label: v.viewerKind === 'hiring_team' ? 'Profile reviewed' : 'Profile viewed',
              by: v.displayName, ts: v.viewedAt, job: v.roleTitle || '' });
          });
          out.sort(function (x, y) { return (Date.parse(y.ts || 0) || 0) - (Date.parse(x.ts || 0) || 0); });
        } else if (isCand() && !S.data) load();
        return out;
      };
      a.__tlpv = true;
      window.capActions = a;
    }
    var prevAp = window.capAppearances;
    if (typeof prevAp === 'function' && !prevAp.__tlpv) {
      var ap = function (c) {
        if (isCand() && S.data && c && STATE.session && String(c.id) === String(STATE.session.id)) {
          return { total: S.data.summary.appear90, recent: S.data.summary.appear30, days: 90 };
        }
        return prevAp.apply(this, arguments);
      };
      ap.__tlpv = true;
      window.capAppearances = ap;
    }
  }

  /* The bell: the daily digest, from the server */
  function wrapBell() {
    var prev = window.cpNotifications;
    if (typeof prev !== 'function' || prev.__tlpv) return;
    var next = function () {
      var out = prev.apply(this, arguments) || [];
      var mine = (window.TL && TL.notifications || []).filter(function (n) { return n && n.type === 'PROFILE_VIEWS_DIGEST'; });
      mine.forEach(function (n) {
        if (out.some(function (x) { return x.id === n.id; })) return;
        out.push({ id: n.id, text: n.message || n.title || 'Someone viewed your profile', ts: n.createdAt || n.created_at,
          read: !!n.read, go: '#/candidate/viewers' });
      });
      return out.sort(function (x, y) { return (Date.parse(y.ts || 0) || 0) - (Date.parse(x.ts || 0) || 0); }).slice(0, 25);
    };
    next.__tlpv = true;
    window.cpNotifications = next;
    var prevMark = window.cpMark;
    if (typeof prevMark === 'function' && !prevMark.__tlpv) {
      var m = function (kind, id) {
        if (kind === 'n' && String(id).indexOf('pvd_') === 0 && window.TL && TL.markNotificationRead) {
          TL.markNotificationRead(id);
        }
        return prevMark.apply(this, arguments);
      };
      m.__tlpv = true;
      window.cpMark = m;
    }
  }

  /* ------------------------------------------------------------------ *
   * staff: recording views
   * ------------------------------------------------------------------ */
  var recorded = {};
  function recordView(candId, jobId, source) {
    if (!isStaff() || !api() || !candId) return;
    /* Once per candidate and source per page load: a re-render that
       knows the job a moment later must not become a second view. */
    var key = candId + '|' + source + '|' + new Date().toDateString();
    if (recorded[key]) return;
    recorded[key] = true;
    api().post('/candidates/' + encodeURIComponent(candId) + '/viewed', { jobId: jobId || null, source: source })
      .catch(function () { delete recorded[key]; });
  }
  window.tlpvRecordView = recordView;

  /** The job this viewer is looking at the candidate for, when the page knows it. */
  function jobFor(candId) {
    try {
      var c = DATA.candidateById(candId);
      var jobs = (DATA.applications || []).filter(function (a) { return a.candidateId === candId; })
        .map(function (a) { return a.jobId; });
      if (c && c.appliedJobId) jobs.unshift(c.appliedJobId);
      for (var i = 0; i < jobs.length; i++) if (jobs[i] && DATA.jobById(jobs[i])) return jobs[i];
    } catch (e) { /* none */ }
    return null;
  }

  var lastProfileHash = '';
  function onRender() {
    var hash = location.hash || '';
    if (isCand()) {
      if (/^#\/candidate\/(viewers|home|performance|profile)\b/.test(hash) && !S.loading && Date.now() - S.at > 30000) load(true);
      return;
    }
    if (!isStaff()) return;
    var m = /^#\/recruiter\/candidate-profile\?id=([^&]+)/.exec(hash);
    if (m && hash !== lastProfileHash) {
      lastProfileHash = hash;
      var id = decodeURIComponent(m[1]);
      recordView(id, jobFor(id), 'profile');
    }
    if (!m) lastProfileHash = '';
    /* A client reviewing their shortlist reads each candidate's profile card. */
    if (role() === 'client' && /^#\/client\/shortlisted\b/.test(hash)) {
      (DATA.candidates || []).forEach(function (c) {
        if (c && ['shortlisted', 'interview_scheduled', 'ai_interview_done', 'client_review', 'offer_extended'].indexOf(c.stage) >= 0) {
          var j = jobFor(c.id);
          if (j) recordView(c.id, j, 'application');      // only once the role is known
        }
      });
    }
    reportAppearances();
  }

  function wrapResume() {
    var prev = window.tlViewResume;
    if (typeof prev !== 'function' || prev.__tlpv) return;
    var next = function (id) {
      try { recordView(id, jobFor(id), 'resume'); } catch (e) { /* the viewer still opens */ }
      return prev.apply(this, arguments);
    };
    next.__tlpv = true;
    window.tlViewResume = next;
  }

  /* ------------------------------------------------------------------ *
   * staff: search appearances for the page shown
   * ------------------------------------------------------------------ */
  var lastSearch = null;      // { token, ids:{} }
  var reported = {};
  var reportTimer = null;
  function wrapApi() {
    if (!window.TL || !TL.api || TL.api.__tlpv) return;
    var get = TL.api.get;
    TL.api.get = function (path) {
      var p = get.apply(this, arguments);
      if (typeof path === 'string' && path.indexOf('/candidates?') === 0 && p && typeof p.then === 'function') {
        p.then(function (res) {
          if (res && res.appearanceToken) {
            var ids = {}; (res.candidates || []).forEach(function (c) { ids[c.id] = true; });
            lastSearch = { token: res.appearanceToken, ids: ids };
            /* Talent Pool paints itself without render(): report after it has. */
            setTimeout(reportAppearances, 600);
          } else if (res && res.candidates) lastSearch = null;
        }, function () {});
      }
      return p;
    };
    TL.api.__tlpv = true;
  }
  function reportAppearances() {
    if (!lastSearch || !/^#\/(recruiter|admin|client)\//.test(location.hash || '')) return;
    clearTimeout(reportTimer);
    reportTimer = setTimeout(function () {
      if (!lastSearch) return;
      var app = document.getElementById('app') || document.body;
      var html = app.innerHTML;
      var rx = /(?:fcrOpenProfile|tlViewResume|candidate-profile\?id=)\(?['"]?([A-Za-z0-9_\-]+)/g;
      var seen = {}; var ids = []; var mm;
      while ((mm = rx.exec(html))) {
        var id = mm[1];
        if (lastSearch.ids[id] && !seen[id]) { seen[id] = true; ids.push(id); }
      }
      if (!ids.length) return;
      var key = lastSearch.token.slice(-24) + ':' + ids.join(',');
      if (reported[key]) return;
      reported[key] = true;
      api().post('/candidates/search-appearances', { token: lastSearch.token, ids: ids.slice(0, 200) }).catch(function () {});
    }, 1200);
  }

  /* ------------------------------------------------------------------ *
   * RECRUITER_VIEWED: no company name in what a candidate is told (0051)
   * ------------------------------------------------------------------ */
  function fixRecruiterViewed() {
    var N = window.TL_NOTIFY;
    if (!N || N.__tlpv || typeof N.createNotification !== 'function') return;
    N.onApplicationViewed = function (app, recruiter) {
      if (!app) return null;
      var j = DATA.jobById(app.jobId); if (!j) return null;
      var first = recruiter && recruiter.name ? String(recruiter.name).trim().split(/\s+/)[0] : '';
      var who = first ? first + ' (TeamLink Recruiter)' : 'A TeamLink recruiter';
      return N.createNotification({
        type: N.TYPES.RECRUITER_VIEWED, recipientId: app.candidateId, recipientRole: 'candidate',
        jobId: j.id, applicationId: app.id, recruiterId: recruiter ? recruiter.id : null, system: true,
        title: 'Recruiter Viewed Your Application',
        message: who + ' viewed your application for ' + j.title + '.',
        metadata: { jobTitle: j.title, recruiter: who },
      });
    };
    /* the existing hook reached the old function through its closure; route it here */
    window.tlMarkApplicationsViewed = function (candidateId) {
      try {
        if (!STATE.session || STATE.session.role !== 'recruiter' || !candidateId) return 0;
        var rec = (DATA.recruiterById ? DATA.recruiterById(STATE.session.id) : null)
          || (DATA.recruiters || []).filter(function (r) { return String(r.id) === String(STATE.session.id); })[0] || null;
        if (!rec) return 0;
        var n = 0;
        (DATA.applications || []).forEach(function (a) {
          if (!a || String(a.candidateId) !== String(candidateId)) return;
          var j = DATA.jobById(a.jobId); if (!j || j.companyId !== rec.companyId) return;
          if (N.onApplicationViewed(a, rec)) n++;
        });
        return n;
      } catch (e) { return 0; }
    };
    N.__tlpv = true;
  }

  /* ------------------------------------------------------------------ *
   * administrator: two switches on Notification Settings
   * ------------------------------------------------------------------ */
  var adminSettings = null;
  window.tlpvAdminSet = function (k, on) {
    var body = {}; body[k] = !!on;
    api().put('/admin/profile-viewer-settings', body).then(function (r) {
      adminSettings = r.settings; say('Saved', '✅'); rerender();
    }).catch(function (e) { say((e && e.message) || 'That could not be saved.', '⚠️'); rerender(); });
  };
  function adminCard() {
    if (!adminSettings) {
      api().get('/admin/profile-viewer-settings').then(function (r) { adminSettings = r.settings; rerender(); }).catch(function () {});
      return '';
    }
    var row = function (k, title, desc) {
      return '<label style="display:flex;gap:12px;align-items:flex-start;padding:9px 0;border-top:1px solid #f0f3f7;cursor:pointer">'
        + '<input type="checkbox" style="margin-top:3px;width:16px;height:16px" ' + (adminSettings[k] ? 'checked ' : '')
        + 'onchange="tlpvAdminSet(\'' + k + '\',this.checked)"><span><b style="font-size:13.5px">' + title + '</b>'
        + '<span style="display:block;font-size:12px;color:#6b7a90">' + desc + '</span></span></label>';
    };
    return '<div class="panel" id="tlpvAdmin" style="margin-bottom:16px"><div class="panel-head"><div><h2>Who viewed my profile</h2>'
      + '<div class="desc">What candidates are told about who looked at them. Hiring teams are always shown as “A hiring team”.</div></div></div>'
      + '<div class="panel-body">'
      + row('showRecruiterNames', 'Show recruiter first names to candidates', 'On: “Priya (TeamLink Recruiter) viewed your profile”. Off: “A TeamLink recruiter”.')
      + row('dailyDigest', 'Daily profile-view digest', 'At 7 PM IST, candidates who were viewed that day get one summary: in-app, and by email or WhatsApp only if they chose it.')
      + '</div></div>';
  }
  function wrapAdmin() {
    var prev = window.renderNotificationSettingsPage;
    if (typeof prev !== 'function' || prev.__tlpv) return;
    var next = function (r) {
      var html = prev.apply(this, arguments);
      if (role() !== 'admin' || typeof html !== 'string') return html;
      var card = adminCard();
      if (!card) return html;
      return card + html;
    };
    next.__tlpv = true;
    window.renderNotificationSettingsPage = next;
  }

  /* ------------------------------------------------------------------ */
  var lastSession = null;
  function install() {
    wrapPage(); wrapMenus(); wrapHome(); wrapPerformance(); wrapBell(); wrapResume(); wrapApi();
    fixRecruiterViewed(); wrapAdmin();
    var prev = window.render;
    if (typeof prev === 'function' && !prev.__tlpvR) {
      var r = function () {
        var sid = window.STATE && STATE.session ? STATE.session.role + ':' + STATE.session.id : null;
        if (sid !== lastSession) { lastSession = sid; S.data = null; S.at = 0; S.page = 1; adminSettings = null; }
        var out = prev.apply(this, arguments);
        try { onRender(); } catch (e) { /* never break a page */ }
        return out;
      };
      r.__tlpvR = true;
      window.render = r;
    }
    rerender();
  }
  if (document.readyState === 'complete') install();
  else window.addEventListener('load', install);

  window.TLProfileViewers = { load: load, data: function () { return S.data; } };
})();
