/*
 * TeamLink — "New job like one you saved" (0110), the browser side.
 *
 * The star on a job card only ever changed STATE.savedJobs in memory: the
 * server's saved_jobs table (and its /api/saved-jobs routes) existed, but
 * nothing wrote to it, so a saved job was gone on the next visit and the
 * server could not know what anybody had saved. This file:
 *
 *   - sends every save / unsave to POST|DELETE /api/saved-jobs/:id, and
 *     loads the saved list from GET /api/saved-jobs when a candidate signs
 *     in (the server is the record; the Set is a mirror);
 *   - removes a job from the saved list on the server when it is hidden
 *     ("Not interested");
 *   - puts the "Tell me about similar new jobs" switch on the Saved Jobs
 *     page (GET/PUT /api/saved-job-alerts/settings, ON unless turned off);
 *   - shows the server's "New job like one you saved" entries (and the
 *     evening digest) in the candidate's bell.
 *
 * Wraps, keeping the previous function and calling it first:
 *   toggleSaveJob, hideJob, cpSaved, candidateBellHtml, cpNotifications,
 *   cpMark, cpMarkAll, render.
 */
(function () {
  'use strict';
  if (window.__tlsja) return;
  window.__tlsja = true;

  var S = { session: null, settings: null, loadingSettings: false, saving: {} };

  var api = function () { return window.TL && TL.api; };
  var isCand = function () { return !!(window.STATE && STATE.session && STATE.session.role === 'candidate'); };
  var h = function (v) {
    return typeof window.esc === 'function' ? esc(v) : String(v == null ? '' : v).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  };
  var js = function (v) { return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); };
  var say = function (msg, icon) { if (typeof window.toast === 'function') toast(msg, icon || '⭐'); };
  var rerender = function () { if (typeof window.render === 'function') render(); };
  /* Only jobs the server has: an external listing has its own save path. */
  var serverJob = function (id) { return !!(window.TL && TL.knownJobIds && TL.knownJobIds[id]); };

  /* ------------------------------------------------------------------ *
   * saving, kept by the server
   * ------------------------------------------------------------------ */

  function sync(jobId, on) {
    if (!isCand() || !api() || !serverJob(jobId)) return;
    var path = '/saved-jobs/' + encodeURIComponent(jobId);
    S.saving[jobId] = true;
    (on ? api().post(path, {}) : api().del(path)).then(function () {
      delete S.saving[jobId];
    }, function (err) {
      delete S.saving[jobId];
      /* Put the star back the way the server has it, and say so. */
      if (on) STATE.savedJobs.delete(jobId); else STATE.savedJobs.add(jobId);
      say(on ? 'Could not save this job — please try again' : 'Could not remove this job — please try again', '⚠️');
      if (err && window.console) console.warn('[saved-jobs]', err.message || err);
      rerender();
    });
  }

  function wrapSave() {
    var prev = window.toggleSaveJob;
    if (typeof prev !== 'function' || prev.__tlsja) return;
    var next = function (jobId) {
      var was = !!(window.STATE && STATE.savedJobs && STATE.savedJobs.has(jobId));
      var out = prev.apply(this, arguments);
      var now = !!(STATE.savedJobs && STATE.savedJobs.has(jobId));
      if (now !== was) sync(jobId, now);
      return out;
    };
    next.__tlsja = true;
    window.toggleSaveJob = next;
  }

  function wrapHide() {
    var prev = window.hideJob;
    if (typeof prev !== 'function' || prev.__tlsja) return;
    var next = function (jobId) {
      var was = !!(window.STATE && STATE.savedJobs && STATE.savedJobs.has(jobId));
      var out = prev.apply(this, arguments);
      if (was && !STATE.savedJobs.has(jobId)) sync(jobId, false);
      return out;
    };
    next.__tlsja = true;
    window.hideJob = next;
  }

  function loadSaved() {
    if (!isCand() || !api()) return;
    api().get('/saved-jobs').then(function (out) {
      if (!isCand() || STATE.session.id !== S.session) return;
      var list = (out && out.saved) || [];
      /* Writes still on their way keep the state the candidate just chose. */
      var keep = Object.keys(S.saving);
      var next = new Set(list);
      keep.forEach(function (id) { if (STATE.savedJobs.has(id)) next.add(id); else next.delete(id); });
      var before = Array.from(STATE.savedJobs || []).sort().join('|');
      STATE.savedJobs = next;
      if (Array.from(next).sort().join('|') !== before) rerender();
    }).catch(function () { /* the in-memory list stays as it is */ });
  }

  /* ------------------------------------------------------------------ *
   * the switch on the Saved Jobs page
   * ------------------------------------------------------------------ */

  function loadSettings() {
    if (!isCand() || !api() || S.loadingSettings) return;
    S.loadingSettings = true;
    api().get('/saved-job-alerts/settings').then(function (out) {
      S.loadingSettings = false;
      S.settings = (out && out.settings) || { enabled: true, dailyCap: 3 };
      if (/^#\/candidate\/saved/.test(location.hash || '')) rerender();
    }, function () { S.loadingSettings = false; });
  }

  window.tlsjaSet = function (on) {
    if (!api()) return;
    var prev = S.settings ? S.settings.enabled : true;
    S.settings = Object.assign({}, S.settings || {}, { enabled: !!on });
    api().put('/saved-job-alerts/settings', { enabled: !!on }).then(function (out) {
      S.settings = (out && out.settings) || S.settings;
      say(on ? 'We’ll tell you about new jobs like the ones you saved' : 'Similar-job alerts are off', on ? '🔔' : '🔕');
      rerender();
    }, function (err) {
      S.settings.enabled = prev;
      if (api().say) api().say(err); else say('Could not change this — please try again', '⚠️');
      rerender();
    });
  };

  function panelHtml() {
    var s = S.settings;
    var on = s ? s.enabled !== false : true;
    var cap = s && s.dailyCap != null ? s.dailyCap : 3;
    return '<div class="cp-card tlsja-pref" id="tlsjaPref" style="margin-bottom:14px;display:flex;gap:12px;align-items:flex-start">'
      + '<label class="tlsja-switch" title="Tell me about similar new jobs">'
      + '<input type="checkbox" id="tlsjaToggle" ' + (on ? 'checked ' : '') + (s ? '' : 'disabled ')
      + 'onchange="tlsjaSet(this.checked)" aria-label="Tell me about similar new jobs"><span></span></label>'
      + '<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:800;color:#16202c">Tell me about similar new jobs</div>'
      + '<div style="font-size:12.5px;color:#5b6676;margin-top:3px;line-height:1.5">'
      + (on
        ? 'When a new job like one you saved is posted, we’ll tell you here and by email — up to ' + h(cap)
          + ' a day, and any more together in one evening summary.'
        : 'Off. You won’t hear about new jobs like the ones you saved. Switch it on any time.')
      + '</div></div></div>';
  }

  function wrapSavedPage() {
    var prev = window.cpSaved;
    if (typeof prev !== 'function' || prev.__tlsja) return;
    var next = function () {
      var html = prev.apply(this, arguments);
      if (typeof html !== 'string' || html.indexOf('tlsjaPref') >= 0) return html;
      if (!S.settings) loadSettings();
      var m = /(>Saved Jobs<\/h1>\s*<div[^>]*>[^<]*<\/div>)/.exec(html);
      if (!m) return html;
      var at = m.index + m[0].length;
      return html.slice(0, at) + panelHtml() + html.slice(at);
    };
    next.__tlsja = true;
    window.cpSaved = next;
  }

  /* ------------------------------------------------------------------ *
   * the bell
   * ------------------------------------------------------------------ */

  var MINE = { SAVED_JOB_SIMILAR: 1, SAVED_JOB_DIGEST: 1 };
  function myAlerts() {
    if (!isCand() || !window.TL || !Array.isArray(TL.notifications)) return [];
    return TL.notifications.filter(function (n) {
      return n && MINE[n.type] && String(n.recipientId) === String(STATE.session.id);
    }).slice(0, 10);
  }

  function rowHtml(n) {
    var md = n.metadata || {};
    var when = '<span>' + h(String(n.createdAt || '').slice(0, 10)) + '</span>';
    if (n.type === 'SAVED_JOB_DIGEST') {
      var jobs = (md.jobs || []).slice(0, 5).map(function (j) {
        return '<div style="margin-top:3px">• <a class="ss-link" style="cursor:pointer" onclick="tlsjaOpen(\'' + h(js(n.id)) + '\',\'' + h(js(j.id)) + '\')">'
          + h(j.title) + '</a>' + (j.location ? ' · ' + h(j.location) : '') + '</div>';
      }).join('');
      return '<div class="notif-row tlsja-n ' + (n.read ? '' : 'unread') + '"><div class="notif-msg"><b>' + h(n.title) + '</b>' + jobs + '</div>'
        + '<div class="notif-meta">' + when + '<button class="ss-link" onclick="tlsjaOpen(\'' + h(js(n.id)) + '\')">Saved jobs</button></div></div>';
    }
    return '<div class="notif-row tlsja-n ' + (n.read ? '' : 'unread') + '"><div class="notif-msg"><b>' + h(n.title) + '</b><br>'
      + h(md.jobTitle || '') + (md.company ? ' · ' + h(md.company) : '') + (md.location ? ' · ' + h(md.location) : '')
      + (md.savedJobTitle ? '<br><span style="color:#5b6676">Like “' + h(md.savedJobTitle) + '”, which you saved</span>' : '')
      + (typeof window.tlpuOpportunityHtml === 'function' ? window.tlpuOpportunityHtml(n) : '')
      + '</div><div class="notif-meta">' + when
      + '<button class="ss-link" onclick="tlsjaOpen(\'' + h(js(n.id)) + '\')">View job</button></div></div>';
  }

  function wrapBell() {
    var prev = window.candidateBellHtml;
    if (typeof prev !== 'function' || prev.__tlsja) return;
    var next = function () {
      var out = prev.apply(this, arguments);
      var list = myAlerts();
      if (!list.length || typeof out !== 'string') return out;
      var unread = list.filter(function (n) { return !n.read; }).length;
      var rows = list.map(rowHtml).join('');
      out = out.replace(/(<div class="pm-head">)([^<]*)(<\/div>)/, function (all, a, b, c) { return a + b + c + rows; });
      /* "No notifications yet" is no longer true. */
      out = out.replace(/<div class="notif-empty">[\s\S]*?<\/div>/, '');
      if (unread) {
        if (/<span class="notif-badge">(\d+|9\+)<\/span>/.test(out)) {
          out = out.replace(/<span class="notif-badge">(\d+|9\+)<\/span>/, function (all, k) {
            var t = (k === '9+' ? 10 : Number(k)) + unread;
            return '<span class="notif-badge">' + (t > 9 ? '9+' : t) + '</span>';
          });
        } else {
          out = out.replace('🔔</button>', '🔔<span class="notif-badge">' + (unread > 9 ? '9+' : unread) + '</span></button>');
        }
      }
      return out;
    };
    next.__tlsja = true;
    window.candidateBellHtml = next;
  }

  /* The candidate portal's own bell (cpShell) reads cpNotifications(). */
  function wrapPortalBell() {
    var prev = window.cpNotifications;
    if (typeof prev !== 'function' || prev.__tlsja) return;
    var next = function () {
      var out = prev.apply(this, arguments) || [];
      myAlerts().forEach(function (n) {
        if (out.some(function (x) { return x.id === n.id; })) return;
        var md = n.metadata || {};
        var text = n.type === 'SAVED_JOB_DIGEST'
          ? (n.title || 'More new jobs like ones you saved') + (n.message ? ' — ' + n.message : '')
          /* The full job-opportunity message is too long for a menu line:
             the owner's one-line summary is shown here instead. */
          : (md.summary || (md.format === 'job_opportunity' ? '' : n.message) || n.title)
            + (md.savedJobTitle ? ' (like “' + md.savedJobTitle + '”, which you saved)' : '');
        out.push({ id: n.id, text: text, ts: n.createdAt, read: !!n.read,
          go: n.type === 'SAVED_JOB_SIMILAR' && n.jobId ? '#/job/' + n.jobId : '#/candidate/saved' });
      });
      return out.sort(function (x, y) { return (Date.parse(y.ts || 0) || 0) - (Date.parse(x.ts || 0) || 0); }).slice(0, 25);
    };
    next.__tlsja = true;
    window.cpNotifications = next;
    var prevMark = window.cpMark;
    if (typeof prevMark === 'function' && !prevMark.__tlsja) {
      var m = function (kind, id) {
        if (kind === 'n' && myAlerts().some(function (n) { return n.id === id; })) {
          var n = TL.notifications.filter(function (x) { return x.id === id; })[0];
          if (n && !n.read && TL.markNotificationRead) TL.markNotificationRead(id);
          if (n) n.read = true;
        }
        return prevMark.apply(this, arguments);
      };
      m.__tlsja = true;
      window.cpMark = m;
    }
    var prevAll = window.cpMarkAll;
    if (typeof prevAll === 'function' && !prevAll.__tlsja) {
      var a = function (kind) {
        if (kind === 'n') {
          myAlerts().forEach(function (n) {
            if (!n.read && TL.markNotificationRead) TL.markNotificationRead(n.id);
            n.read = true;
          });
        }
        return prevAll.apply(this, arguments);
      };
      a.__tlsja = true;
      window.cpMarkAll = a;
    }
  }

  window.tlsjaOpen = function (id, jobId) {
    var n = ((window.TL && TL.notifications) || []).filter(function (x) { return x.id === id; })[0];
    if (!n) return;
    if (!n.read && TL.markNotificationRead) TL.markNotificationRead(id);
    n.read = true;
    var target = jobId || (n.type === 'SAVED_JOB_SIMILAR' ? n.jobId : null);
    if (target && typeof window.navigate === 'function') window.navigate('/job/' + target);
    else location.hash = '#/candidate/saved';
  };

  /* ------------------------------------------------------------------ *
   * wiring
   * ------------------------------------------------------------------ */

  function onRender() {
    var sid = isCand() ? STATE.session.id : null;
    if (sid !== S.session) {
      S.session = sid;
      S.settings = null;
      if (sid) { loadSaved(); loadSettings(); }
    }
  }

  function install() {
    wrapSave(); wrapHide(); wrapSavedPage(); wrapBell(); wrapPortalBell();
    var prev = window.render;
    if (typeof prev === 'function' && !prev.__tlsja) {
      var next = function () {
        var out = prev.apply(this, arguments);
        try { onRender(); } catch (e) { /* never let this break a page */ }
        return out;
      };
      next.__tlsja = true;
      /* keep the flags the other modules put on render */
      Object.keys(prev).forEach(function (k) { try { next[k] = prev[k]; } catch (e) {} });
      window.render = next;
    }
    try { onRender(); } catch (e) {}
  }

  var css = document.createElement('style');
  css.textContent = '.tlsja-switch{position:relative;display:inline-block;width:42px;height:24px;flex:0 0 auto;margin-top:2px}'
    + '.tlsja-switch input{opacity:0;width:0;height:0}'
    + '.tlsja-switch span{position:absolute;inset:0;background:#c9d2de;border-radius:12px;transition:background .15s;cursor:pointer}'
    + '.tlsja-switch span:before{content:"";position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.2)}'
    + '.tlsja-switch input:checked+span{background:#1d6ff2}'
    + '.tlsja-switch input:checked+span:before{transform:translateX(18px)}'
    + '.tlsja-switch input:focus-visible+span{outline:2px solid #1d6ff2;outline-offset:2px}'
    + '.tlsja-switch input:disabled+span{opacity:.6;cursor:default}';
  document.head.appendChild(css);

  // After every other module has wrapped what it wraps.
  if (document.readyState === 'complete') install();
  else window.addEventListener('load', install);

  window.TLSavedJobAlerts = { reload: function () { S.session = null; onRender(); }, settings: function () { return S.settings; } };
})();
