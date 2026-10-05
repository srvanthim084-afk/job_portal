/*
 * TeamLink — "Save this search", and the Job Alerts page that lists them.
 *
 * A saved search IS a job alert. Both used to live in the browser: the
 * Job Alerts page kept {q, loc, freq} under teamlink_job_alerts_v1 and
 * the public search's "Alert me" pushed into a list that vanished on
 * reload. Nothing on the server read either, so nothing was ever sent.
 * They are now one list, stored by the API (/api/saved-searches), and
 * the server sends the alerts.
 *
 * What this file adds, and nothing else:
 *   - a "🔔 Save this search" button beside the result count on the
 *     candidate Jobs screen (and on the public search, where a signed-out
 *     visitor is asked to sign in and the search is saved straight after)
 *   - the panel: name, Instant / Daily / Weekly / Off, channels
 *   - the Job Alerts page, rebuilt on the saved list: chips, "N new",
 *     Run search / Edit / Delete, plus the existing create form and the
 *     suggestion from the profile
 *   - a "Your saved searches" row on Home
 *   - "Not interested" stored on the server, so an alert never brings
 *     back a job the candidate hid
 *
 * The filter object is the Jobs screen's own (STATE.rj), so a saved
 * search goes back into the screen exactly as it came out.
 */
(function () {
  'use strict';

  var EXP = ['Fresher', '0–2 Years', '2–5 Years', '5–8 Years', '8+ Years'];
  var MODES = ['Work From Office', 'Hybrid', 'Remote'];
  var TYPES = ['Full-time', 'Part-time', 'Contract', 'Internship'];
  var EDUS = ['B.Tech', 'M.Tech', 'MCA', 'MBA'];
  var POSTED = { '1': 'Last 24 hours', '3': 'Last 3 days', '7': 'Last 7 days', '15': 'Last 15 days', '30': 'Last 30 days' };
  var FREQ = [['instant', 'Instant'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['off', 'Off']];
  var PENDING = 'tlss_pending_v1';

  var S = { list: null, loading: null, at: 0, limit: 20 };

  var api = function () { return window.TL && TL.api; };
  var isCand = function () { return !!(window.STATE && STATE.session && STATE.session.role === 'candidate'); };
  var me = function () { return isCand() && window.DATA && DATA.candidateById ? DATA.candidateById(STATE.session.id) : null; };
  var h = function (v) { return typeof window.esc === 'function' ? esc(v) : String(v == null ? '' : v).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); };
  var js = function (v) { return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); };
  var say = function (msg, icon) { if (typeof window.toast === 'function') toast(msg, icon || '🔔'); };
  var rerender = function () { if (typeof window.render === 'function') render(); };
  var store = function () { try { return window.sessionStorage; } catch (e) { return null; } };

  /* ------------------------------------------------------------------ *
   * filters: the screen's state <-> the stored form
   * ------------------------------------------------------------------ */

  /** The same canonical form the server writes, so "already saved" is a string compare. */
  function canonical(f) {
    var out = {};
    var s = function (v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); };
    ['q', 'loc', 'skills', 'company', 'edu', 'posted'].forEach(function (k) { if (s(f[k])) out[k] = s(f[k]); });
    if (out.loc && /^any location$/i.test(out.loc)) delete out.loc;
    if (out.edu === 'Any') delete out.edu;
    ['locations', 'locTags', 'exp', 'modes', 'types'].forEach(function (k) {
      if (!Array.isArray(f[k])) return;
      var seen = {}; var vals = [];
      f[k].forEach(function (v) { var t = s(v); if (t && !seen[t.toLowerCase()]) { seen[t.toLowerCase()] = 1; vals.push(t); } });
      if (vals.length) out[k] = vals.sort(function (a, b) { return a.localeCompare(b); });
    });
    ['ctcMin', 'ctcMax'].forEach(function (k) {
      if (f[k] !== '' && f[k] != null && isFinite(Number(f[k]))) out[k] = Number(f[k]);
    });
    if (out.locTags && Number(f.locKm) > 0) out.locKm = Number(f.locKm);
    /* a voice search's normalized criteria (teamlink-voice-search.js), matched by meaning */
    if (f.voice && typeof f.voice === 'object') out.voice = f.voice;
    return out;
  }
  /** The voice search on screen, if one is: q becomes its English name, and the criteria ride along. */
  function withVoice(f, surface) {
    var v = window.TLVoiceSearch && TLVoiceSearch.criteria ? TLVoiceSearch.criteria(surface) : null;
    if (!v) return f;
    var o = Object.assign({}, f, { voice: v });
    var label = (v.role || []).length || (v.technologies || []).length || (v.skills || []).length || (v.industry || []).length
      ? [].concat(v.industry || [], v.technologies || [], v.skills || [], v.role || []).join(' ') : (v.keywords || []).join(' ');
    if (label) o.q = label.toLowerCase();
    if ((v.location || []).length && !(o.locTags || []).length) o.locTags = v.location.slice();
    return canonical(o);
  }
  function key(f) {
    var c = canonical(f || {});
    return JSON.stringify(Object.keys(c).sort().reduce(function (o, k) { o[k] = c[k]; return o; }, {}));
  }

  /** What the Jobs screen is showing right now. */
  function fromScreen() {
    var rj = (window.STATE && STATE.rj) || {};
    var F = rj.f || {};
    var tags = (F.locTags && F.locTags.length) ? F.locTags
      : (typeof window.tlLocState === 'function' ? (tlLocState('rjSide').tags || []) : []);
    return withVoice(canonical({
      q: rj.q, loc: rj.loc, locations: F.locations, locTags: tags, locKm: F.locKm,
      exp: F.exp, ctcMin: F.ctcMin, ctcMax: F.ctcMax, modes: F.modes, types: F.types,
      skills: F.skills, edu: F.edu, posted: F.posted, company: F.company,
    }), 'candidate');
  }

  /** The public search's state, said in the Jobs screen's terms. */
  function fromPublic() {
    var f = (window.STATE && STATE.search) || {};
    var band = function (e) {
      var n = String(e || '').match(/\d+/); if (!n) return null;
      var lo = Number(n[0]);
      return lo === 0 ? '0–2 Years' : lo < 2 ? '0–2 Years' : lo < 5 ? '2–5 Years' : lo < 8 ? '5–8 Years' : '8+ Years';
    };
    var modeMap = { onsite: 'Work From Office', office: 'Work From Office', hybrid: 'Hybrid', remote: 'Remote' };
    var q = f.q || f.category || '';
    var tags = [].concat(f.loc ? [f.loc] : [], f.locations || []);
    return withVoice(canonical({
      q: q,
      locTags: tags,
      exp: f.exp && band(f.exp) ? [band(f.exp)] : [],
      ctcMin: f.salaryMin,
      modes: (f.mode || []).map(function (m) { return modeMap[String(m).toLowerCase()]; }).filter(Boolean),
      types: (f.jobType || []).filter(function (t) { return TYPES.indexOf(t) >= 0; }),
      skills: (f.skills || []).join(', '),
      edu: EDUS.indexOf(f.education) >= 0 ? f.education : '',
      company: f.company,
      posted: POSTED[String(f.posted)] ? String(f.posted) : '',
    }), 'public');
  }

  /** Put a saved search back on the Jobs screen. */
  function toScreen(f) {
    f = f || {};
    STATE.rj = STATE.rj || {};
    STATE.rj.q = f.q || '';
    STATE.rj.loc = f.loc || '';
    STATE.rj.mode = '';
    STATE.rj.page = 1;
    STATE.rj.f = {
      locations: (f.locations || []).slice(), exp: (f.exp || []).slice(),
      ctcMin: f.ctcMin != null ? String(f.ctcMin) : '', ctcMax: f.ctcMax != null ? String(f.ctcMax) : '',
      modes: (f.modes || []).slice(), types: (f.types || []).slice(), skills: f.skills || '',
      edu: f.edu || '', posted: f.posted || '', company: f.company || '', match: '',
      locTags: (f.locTags || []).slice(), locKm: f.locKm ? String(f.locKm) : '',
    };
    if (typeof window.tlLocState === 'function') {
      ['rjSide', 'rjTop', 'candHome'].forEach(function (k) {
        var st = tlLocState(k); st.tags = (f.locTags || []).slice(); st.km = f.locKm ? String(f.locKm) : '';
      });
    }
    /* a saved VOICE search is run by meaning again, not as a typed word */
    if (f.voice && window.TLVoiceSearch && TLVoiceSearch.replay) {
      STATE.rj.q = '';
      TLVoiceSearch.replay(f.voice, 'candidate');
    }
  }

  function labelFor(f) {
    var parts = [];
    var cap = function (v) { return String(v).replace(/\b\w/g, function (m) { return m.toUpperCase(); }); };
    parts.push(f.q ? cap(String(f.q).split(',')[0].trim()) : 'All jobs');
    var places = [].concat(f.locTags || [], f.locations || [], f.loc ? [f.loc] : []);
    if (places.length) parts.push(places[0] + (places.length > 1 ? ' +' + (places.length - 1) : ''));
    if (f.ctcMin != null) parts.push('₹' + f.ctcMin + 'L+');
    if (f.types && f.types.length) parts.push(f.types[0]);
    else if (f.modes && f.modes.length) parts.push(f.modes[0]);
    else if (f.exp && f.exp.length) parts.push(f.exp[0]);
    else if (f.company) parts.push(f.company);
    return parts.join(' · ').slice(0, 80);
  }

  function chips(f) {
    var out = [];
    if (f.q) out.push('🔎 ' + f.q);
    [].concat(f.locTags || [], f.locations || [], f.loc ? [f.loc] : []).forEach(function (p) { out.push('📍 ' + p); });
    if (f.locKm) out.push('within ' + f.locKm + ' km');
    (f.exp || []).forEach(function (v) { out.push(v); });
    if (f.ctcMin != null) out.push('₹' + f.ctcMin + ' LPA+');
    if (f.ctcMax != null) out.push('up to ₹' + f.ctcMax + ' LPA');
    (f.modes || []).forEach(function (v) { out.push(v); });
    (f.types || []).forEach(function (v) { out.push(v); });
    if (f.skills) out.push('Skills: ' + f.skills);
    if (f.edu) out.push('Edu: ' + f.edu);
    if (f.posted) out.push(POSTED[f.posted] || ('Last ' + f.posted + ' days'));
    if (f.company) out.push('Company: ' + f.company);
    return out;
  }
  var chipHtml = function (f) {
    return chips(f).map(function (c) {
      return '<span style="display:inline-block;font-size:11.5px;font-weight:700;color:#42505f;background:#f1f4f8;border-radius:12px;padding:3px 9px;margin:0 6px 6px 0">' + h(c) + '</span>';
    }).join('');
  };
  var isEmpty = function (f) { return !Object.keys(canonical(f || {})).length; };

  /* ------------------------------------------------------------------ *
   * the list, from the server
   * ------------------------------------------------------------------ */

  function load(force) {
    if (!isCand() || !api()) return Promise.resolve([]);
    if (S.loading) return S.loading;
    if (!force && S.list && Date.now() - S.at < 30000) return Promise.resolve(S.list);
    S.at = Date.now();
    S.loading = api().get('/saved-searches')
      .then(function (out) {
        S.list = out.savedSearches || []; S.limit = out.limit || 20; S.at = Date.now(); S.loading = null;
        rerender();
        return S.list;
      })
      .catch(function () { S.loading = null; return S.list || []; });
    return S.loading;
  }
  var findByFilters = function (f) {
    var k = key(f);
    return (S.list || []).filter(function (s) { return key(s.filters) === k; })[0] || null;
  };
  var byId = function (id) { return (S.list || []).filter(function (s) { return s.id === id; })[0] || null; };

  /* ------------------------------------------------------------------ *
   * the panel
   * ------------------------------------------------------------------ */

  function channelsAvailable() {
    var c = me() || {};
    return { email: !!c.email, sms: !!c.phone, whatsapp: !!c.phone,
      push: !!(window.TLPush && TLPush.available && TLPush.available()) };
  }

  function panel(opts) {
    var s = opts.search;
    var f = s ? s.filters : opts.filters;
    var freq = s ? s.alertFrequency : 'daily';
    var have = channelsAvailable();
    var chosen = s ? s.channels : ['email'].concat(have.sms ? ['sms'] : []);
    var lostMatch = !s && window.STATE && STATE.rj && STATE.rj.f && STATE.rj.f.match;
    var body =
      '<div class="fcr-jd-head"><h3>' + (s ? 'Edit saved search' : 'Save this search') + '</h3>'
      + '<p>' + (s ? 'Change its name, how often we tell you, or where.' : 'We will tell you when new jobs match it.') + '</p>'
      + '<button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
      + '<div class="fcr-jd-body">'
      + '<div style="margin-bottom:10px">' + chipHtml(f) + '</div>'
      + (lostMatch ? '<div style="font-size:11.5px;color:#8a94a6;margin:-4px 0 10px">The Job Match % filter depends on your profile at the time, so alerts use the other filters.</div>' : '')
      + '<div class="fgroup"><label>Name</label><input id="tlssName" maxlength="80" value="' + h(s ? s.label : labelFor(f)) + '"></div>'
      + '<div class="fgroup"><label>Tell me about new jobs</label><div id="tlssFreq" style="display:flex;gap:6px;flex-wrap:wrap">'
      + FREQ.map(function (x) {
        var on = x[0] === freq;
        return '<button type="button" data-v="' + x[0] + '" onclick="tlssPickFreq(this)" class="cp-btn' + (on ? ' pri' : '') + '" style="padding:6px 14px;font-size:12.5px">' + x[1] + '</button>';
      }).join('')
      + '</div><div style="font-size:11.5px;color:#8a94a6;margin-top:5px">Daily and weekly come at 8 AM. Texts are never sent between 9 PM and 8 AM.</div></div>'
      + '<div class="fgroup"><label>Send to</label><div style="display:flex;gap:16px;flex-wrap:wrap;font-size:13px">'
      + [['email', 'Email'], ['sms', 'SMS'], ['whatsapp', 'WhatsApp'], ['push', 'Phone notifications']].map(function (c) {
        var dis = !have[c[0]];
        var why = c[0] === 'push' ? 'This browser cannot show phone notifications'
          : 'Add your ' + (c[0] === 'email' ? 'email' : 'mobile number') + ' to your profile first';
        return '<label style="display:flex;gap:6px;align-items:center;' + (dis ? 'color:#a3adba' : '') + '" title="' + (dis ? why : '') + '">'
          + '<input type="checkbox" name="tlssCh" value="' + c[0] + '"' + (chosen.indexOf(c[0]) >= 0 && !dis ? ' checked' : '') + (dis ? ' disabled' : '') + '> ' + c[1] + '</label>';
      }).join('')
      + '</div>' + (window.TLPush && TLPush.panelHtml ? TLPush.panelHtml() : '') + '</div>'
      + '</div>'
      + '<div class="fcr-jd-actions"><button class="btn btn-primary" id="tlssSave" onclick="tlssSubmit(\'' + (s ? js(s.id) : '') + '\')">' + (s ? 'Save changes' : 'Save search') + '</button>'
      + '<button class="btn btn-ghost" onclick="fcrCloseModal()">Cancel</button></div>';
    S.draft = f;
    if (typeof window.fcrModal === 'function') fcrModal(body);
  }

  window.tlssPickFreq = function (el) {
    var box = document.getElementById('tlssFreq'); if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('button'), function (b) { b.classList.toggle('pri', b === el); });
  };

  window.tlssSubmit = function (id) {
    var name = (document.getElementById('tlssName') || {}).value || '';
    var on = document.querySelector('#tlssFreq .pri');
    var freq = on ? on.getAttribute('data-v') : 'daily';
    var ch = Array.prototype.map.call(document.querySelectorAll('input[name="tlssCh"]:checked'), function (x) { return x.value; });
    if (freq !== 'off' && !ch.length) { say('Pick at least one way to be told, or choose Off', '⚠️'); return; }
    /* Phone notifications: on Android and computers the permission is
       asked right here, inside the tap. On iPhone it is not - see
       teamlink-push.js - and the search is saved either way. */
    var wantsPush = ch.indexOf('push') >= 0 && window.TLPush;
    if (wantsPush && TLPush.onPushChosen) TLPush.onPushChosen();
    var btn = document.getElementById('tlssSave'); if (btn) btn.disabled = true;
    var body = { label: name.trim() || undefined, alert_frequency: freq, channels: ch.length ? ch : ['email'] };
    /* The server's answer goes into the list at once, so the button says
       "✓ Saved" now rather than after the list has been fetched again. */
    var done = function (msg, saved) {
      if (saved && saved.id) {
        S.list = (S.list || []).filter(function (x) { return x.id !== saved.id; });
        S.list.unshift(saved);
        rerender();
      }
      if (typeof window.fcrCloseModal === 'function') fcrCloseModal();
      say(msg, '🔔');
      load(true);
      if (wantsPush && TLPush.afterSave) setTimeout(function () { TLPush.afterSave(); }, 50);
    };
    var fail = function (err) {
      if (btn) btn.disabled = false;
      say((err && err.message) || 'That could not be saved. Please try again.', '⚠️');
    };
    if (id) {
      api().put('/saved-searches/' + encodeURIComponent(id), body)
        .then(function (out) { done('Saved search updated', out && out.savedSearch); }).catch(fail);
      return;
    }
    body.filters = S.draft;
    api().post('/saved-searches', body)
      .then(function (out) { done(freq === 'off' ? 'Search saved.' : 'Search saved. We’ll tell you about new jobs.', out && out.savedSearch); })
      .catch(function (err) {
        if (err && err.code === 'DUPLICATE_SEARCH') { done('You had already saved this search.'); return; }
        fail(err);
      });
  };

  /** The button on the Jobs screen. */
  window.tlssSaveCurrent = function () {
    var f = fromScreen();
    if (isEmpty(f)) { say('Search for something or pick a filter first, then save it', '🔎'); return; }
    var had = findByFilters(f);
    if (had) { panel({ search: had }); return; }
    if ((S.list || []).length >= S.limit) {
      say('You have ' + S.limit + ' saved searches. Delete one on Job Alerts to save another.', '⚠️'); return;
    }
    panel({ filters: f });
  };

  /** The public search's "Alert me" / Save, signed in or not. */
  window.createAlertFromSearch = function () {
    var f = fromPublic();
    if (isEmpty(f)) { say('Search for something or pick a filter first, then save it', '🔎'); return; }
    if (isCand()) {
      toScreen(f);
      location.hash = '#/candidate/search';
      setTimeout(function () { window.tlssSaveCurrent(); }, 400);
      return;
    }
    var st = store();
    try { if (st) st.setItem(PENDING, JSON.stringify({ filters: f, at: Date.now() })); } catch (e) {}
    say('Sign in or register as a candidate, and we will save this search for you', '🔐');
    if (typeof window.navigate === 'function') navigate('/login/candidate'); else location.hash = '#/login/candidate';
  };

  /** After sign-in, save the search the visitor asked for before it. */
  function savePending() {
    var st = store(); if (!st || !isCand()) return;
    var raw = null;
    try { raw = st.getItem(PENDING); } catch (e) {}
    if (!raw) return;
    try { st.removeItem(PENDING); } catch (e) {}
    var p = null; try { p = JSON.parse(raw); } catch (e) {}
    if (!p || !p.filters || Date.now() - (p.at || 0) > 3600000) return;
    api().post('/saved-searches', { filters: p.filters, alert_frequency: 'daily' })
      .then(function () { say('Search saved. We’ll tell you about new jobs.', '🔔'); })
      .catch(function (err) {
        if (err && err.code === 'DUPLICATE_SEARCH') say('That search was already saved.', '🔔');
        else say((err && err.message) || 'Your search could not be saved.', '⚠️');
      })
      .then(function () {
        toScreen(p.filters);
        load(true);
        location.hash = '#/candidate/search';
      });
  }

  /* ------------------------------------------------------------------ *
   * running, editing, deleting
   * ------------------------------------------------------------------ */

  window.tlssRun = function (id, fresh) {
    var s = byId(id);
    if (!s) { load(true).then(function () { if (byId(id)) window.tlssRun(id); }); return; }
    /* 0113: a search keeps its page. One saved on External Jobs never runs
       on the Jobs page (and the server never gives it TeamLink jobs). */
    if (s.sourceType === 'EXTERNAL') { location.hash = '#/candidate/external-jobs'; return; }
    /* "3 new" are jobs published after this page loaded its job list, so
       they are not in it yet. Fetch the board again first, or Run search
       would open on results that do not include the jobs it promised. */
    if (!fresh && s.newCount > 0 && window.TL && typeof TL.refresh === 'function') {
      TL.refresh().then(function () { window.tlssRun(id, true); }, function () { window.tlssRun(id, true); });
      return;
    }
    toScreen(s.filters);
    window.__scrollTopNext = true;
    s.newCount = 0;
    api().post('/saved-searches/' + encodeURIComponent(id) + '/viewed').catch(function () {});
    if (location.hash === '#/candidate/search') rerender(); else location.hash = '#/candidate/search';
  };
  window.tlssEdit = function (id) { var s = byId(id); if (s) panel({ search: s }); };
  window.tlssDelete = function (id) {
    var s = byId(id); if (!s) return;
    if (!window.confirm('Delete the saved search "' + s.label + '"? Its alerts stop too.')) return;
    api().del('/saved-searches/' + encodeURIComponent(id))
      .then(function () { say('Saved search deleted', '🗑️'); load(true); })
      .catch(function (err) { say((err && err.message) || 'It could not be deleted.', '⚠️'); });
  };
  window.tlssCreate = function () {
    var q = String((document.getElementById('tlssNewQ') || {}).value || '').trim();
    var loc = String((document.getElementById('tlssNewL') || {}).value || '').trim();
    var freq = String((document.getElementById('tlssNewF') || {}).value || 'daily');
    if (!q && !loc) { say('Add a keyword or a location', '⚠️'); return; }
    var f = canonical({ q: q, locTags: loc && loc !== 'Remote' ? [loc] : [], modes: loc === 'Remote' ? ['Remote'] : [] });
    api().post('/saved-searches', { filters: f, alert_frequency: freq })
      .then(function () { say('Job alert created', '🔔'); load(true); })
      .catch(function (err) {
        say(err && err.code === 'DUPLICATE_SEARCH' ? 'You already have that alert.' : ((err && err.message) || 'It could not be created.'), '⚠️');
      });
  };
  window.tlssSuggest = function (role, loc) {
    var f = canonical({ q: role, locTags: loc ? [loc] : [] });
    api().post('/saved-searches', { filters: f, alert_frequency: 'daily' })
      .then(function () { say('Alert added from your profile', '🔔'); load(true); })
      .catch(function (err) {
        say(err && err.code === 'DUPLICATE_SEARCH' ? 'You already have that alert.' : ((err && err.message) || 'It could not be added.'), '⚠️');
      });
  };

  /* ------------------------------------------------------------------ *
   * the Job Alerts page
   * ------------------------------------------------------------------ */

  var freqText = { instant: 'Instant', daily: 'Daily at 8 AM', weekly: 'Weekly, Monday 8 AM', off: 'Alerts off' };
  var chText = function (ch) {
    return (ch || []).map(function (c) { return c === 'sms' ? 'SMS' : c === 'whatsapp' ? 'WhatsApp' : 'Email'; }).join(', ');
  };

  function suggestion() {
    var c = me(); if (!c) return null;
    var role = '';
    try { if (typeof window.careerPathFor === 'function') role = (careerPathFor(c) || {}).current || ''; } catch (e) {}
    role = role || c.preferredRole || c.title || '';
    if (!role) return null;
    var loc = c.preferredLocation || c.location || '';
    var f = canonical({ q: role, locTags: loc ? [loc] : [] });
    if (findByFilters(f)) return null;
    return { role: role, loc: loc };
  }

  window.cpAlerts = function () {
    var c = me(); if (!c) return '';
    if (!S.list) load();
    var list = S.list || [];
    var sug = suggestion();
    var row = function (s) {
      var n = s.newCount || 0;
      return '<div class="cp-card" style="margin-bottom:12px">'
        + '<div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">'
        + '<div style="flex:1;min-width:220px">'
        + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><b style="font-size:15px">' + h(s.label) + '</b>'
        + (n ? '<span style="font-size:11px;font-weight:800;color:#0f7a44;background:#e8f6ee;border-radius:12px;padding:3px 9px">' + n + ' new</span>' : '')
        + '</div>'
        + '<div style="margin-top:8px">' + chipHtml(s.filters) + '</div>'
        + '<div style="font-size:11.5px;color:#8a94a6">' + h(freqText[s.alertFrequency] || s.alertFrequency)
        + (s.alertFrequency !== 'off' ? ' · ' + h(chText(s.channels)) : '') + '</div>'
        + '</div></div>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:11px;border-top:1px solid #f0f3f7;padding-top:11px">'
        + '<button class="cp-btn pri" onclick="tlssRun(\'' + js(s.id) + '\')">Run search</button>'
        + '<button class="cp-btn" onclick="tlssEdit(\'' + js(s.id) + '\')">Edit</button>'
        + '<button class="cp-btn" onclick="tlssDelete(\'' + js(s.id) + '\')">Delete</button>'
        + '</div></div>';
    };
    var html =
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:14px">'
      + '<div><h1 style="margin:0;font-size:21px;font-weight:800;color:#16202c">🔔 Saved searches &amp; job alerts</h1>'
      + '<div style="font-size:12.5px;color:#7b8794">' + (S.list ? list.length + ' of ' + S.limit + ' saved' : 'Loading…') + '</div></div>'
      + '<button class="cp-btn pri" onclick="location.hash=\'#/candidate/search\'">🔎 Search jobs</button></div>'
      + '<div class="cp-two" style="align-items:flex-start">'
      + '<div>'
      + (list.length ? list.map(row).join('')
        : (S.list ? '<div class="cp-card cp-empty"><div style="font-size:30px">🔔</div><h3>No saved searches yet</h3><p>Search for jobs and press “Save this search”, or create an alert here.</p></div>' : ''))
      + '</div>'
      + '<div>'
      + '<div class="cp-card" style="margin-bottom:12px"><div class="cp-h2" style="margin:0 0 8px"><h2 style="font-size:15px">Create a new alert</h2></div>'
      + '<div class="fgroup"><label>Keyword / role</label><input id="tlssNewQ" placeholder="e.g. Driver, React Developer"></div>'
      + '<div class="fgroup"><label>Location (optional)</label><input id="tlssNewL" placeholder="e.g. Nellore, or Remote"></div>'
      + '<div class="fgroup"><label>Frequency</label><select id="tlssNewF"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="instant">Instant</option></select></div>'
      + '<button class="cp-btn pri" onclick="tlssCreate()">Create alert</button></div>'
      + (sug ? '<div class="cp-card"><div class="cp-h2" style="margin:0 0 8px"><h2 style="font-size:15px">🤖 AI-suggested alert</h2></div>'
        + '<p style="font-size:12.5px;color:#7b8794;margin:0 0 6px">Based on your profile:</p>'
        + '<div style="font-weight:700;font-size:14px;margin:0 0 10px">' + h(sug.role) + (sug.loc ? ' · ' + h(sug.loc) : '') + '</div>'
        + '<button class="cp-btn" onclick="tlssSuggest(\'' + js(sug.role) + '\',\'' + js(sug.loc) + '\')">+ Add this alert</button></div>' : '')
      + '</div></div>';
    return typeof window.cpShell === 'function' ? cpShell('alerts', html) : html;
  };

  /* ------------------------------------------------------------------ *
   * the Jobs screen: the button beside the count
   * ------------------------------------------------------------------ */

  function wrapJobs() {
    var prev = window.rjPage;
    if (typeof prev !== 'function' || prev.__tlss) return;
    var next = function () {
      var html = prev.apply(this, arguments);
      if (!isCand()) return html;
      if (!S.list) load();
      var at = html.indexOf('<div class="rj-count">');
      if (at < 0) return html;
      var end = html.indexOf('</div>', at);
      if (end < 0) return html;
      var f = fromScreen();
      var had = isEmpty(f) ? null : findByFilters(f);
      var btn = '<button class="cp-btn' + (had ? '' : ' pri') + '" onclick="tlssSaveCurrent()" '
        + 'style="margin-left:10px;padding:5px 12px;font-size:12px;vertical-align:middle" '
        + 'title="' + (had ? 'Saved as “' + h(had.label) + '” — edit it' : 'Save this search and get alerts') + '">'
        + (had ? '✓ Saved' : '🔔 Save this search') + '</button>';
      return html.slice(0, end) + btn + html.slice(end);
    };
    next.__tlss = true;
    window.rjPage = next;
  }

  function wrapPublic() {
    var prev = window.pageJobs;
    if (typeof prev !== 'function' || prev.__tlss) return;
    var next = function () {
      var html = prev.apply(this, arguments);
      return typeof html === 'string'
        ? html.replace('🔔 Alert me for this search', '🔔 Save this search')
        : html;
    };
    next.__tlss = true;
    window.pageJobs = next;
  }

  /* ------------------------------------------------------------------ *
   * Home: "Your saved searches"
   * ------------------------------------------------------------------ */

  function wrapHome() {
    var prev = window.cpHome;
    if (typeof prev !== 'function' || prev.__tlss) return;
    var next = function () {
      var html = prev.apply(this, arguments);
      if (!isCand() || typeof html !== 'string') return html;
      if (!S.list) { load(); return html; }
      if (!S.list.length) return html;
      var marker = '<div class="cp-h2"><h2>Recommended jobs for you</h2>';
      var at = html.indexOf(marker);
      if (at < 0) return html;
      var row = '<div class="cp-h2"><h2>Your saved searches</h2><a onclick="location.hash=\'#/candidate/alerts\'">Manage</a></div>'
        + '<div style="display:flex;gap:10px;overflow-x:auto;padding:2px 2px 12px;margin-bottom:6px">'
        + S.list.slice(0, 8).map(function (s) {
          var n = s.newCount || 0;
          return '<button class="cp-card" onclick="tlssRun(\'' + js(s.id) + '\')" style="flex:0 0 auto;max-width:260px;text-align:left;cursor:pointer;border:1px solid #e6ebf2;padding:11px 14px;font:inherit">'
            + '<div style="font-size:13px;font-weight:800;color:#16202c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + h(s.label) + '</div>'
            + '<div style="font-size:11.5px;margin-top:4px;color:' + (n ? '#0f7a44' : '#8a94a6') + ';font-weight:700">'
            + (n ? n + ' new job' + (n === 1 ? '' : 's') : 'No new jobs') + '</div></button>';
        }).join('')
        + '</div>';
      return html.slice(0, at) + row + html.slice(at);
    };
    next.__tlss = true;
    window.cpHome = next;
  }

  /* ------------------------------------------------------------------ *
   * "Not interested", kept by the server
   * ------------------------------------------------------------------ */

  function wrapHide() {
    if (window.hideJob && window.hideJob.__tlss) return;
    var sync = function (id, on) {
      if (!isCand() || !api()) return;
      (on ? api().post('/hidden-jobs/' + encodeURIComponent(id)) : api().del('/hidden-jobs/' + encodeURIComponent(id)))
        .catch(function () {});
    };
    var hide = function (jobId) {
      STATE.hiddenJobs.add(jobId);
      STATE.savedJobs.delete(jobId);
      sync(jobId, true);
      if (typeof window.toast === 'function') {
        toast('Hidden — you won’t see this posting again', '🙈', 'Undo', function () {
          STATE.hiddenJobs.delete(jobId); sync(jobId, false); rerender();
        });
      }
      rerender();
    };
    hide.__tlss = true;
    window.hideJob = hide;
    window.unhideJob = function (jobId) { STATE.hiddenJobs.delete(jobId); sync(jobId, false); rerender(); };
  }

  var hiddenLoadedFor = null;
  function loadHidden() {
    if (!isCand() || !api() || hiddenLoadedFor === STATE.session.id) return;
    hiddenLoadedFor = STATE.session.id;
    api().get('/saved-jobs').then(function (out) {
      var before = STATE.hiddenJobs.size;
      (out.hidden || []).forEach(function (id) { STATE.hiddenJobs.add(id); });
      if (STATE.hiddenJobs.size !== before) rerender();
    }).catch(function () { hiddenLoadedFor = null; });
  }

  /* ------------------------------------------------------------------ *
   * wiring
   * ------------------------------------------------------------------ */

  var lastSession = null;
  var lastHash = null;
  function onRender() {
    var sid = isCand() ? STATE.session.id : null;
    if (sid !== lastSession) {
      lastSession = sid;
      S.list = null; S.at = 0;
      if (sid) { load(true); savePending(); loadHidden(); }
    }
    // Arriving on a page that shows the counts asks again, so "N new" is
    // never the number from before a job was published.
    var hash = location.hash || '';
    if (sid && hash !== lastHash) {
      lastHash = hash;
      if (/^#\/candidate\/(home|alerts|search)\b/.test(hash) && Date.now() - S.at > 5000) load(true);
    }
    // The email's "See all results" link: #/candidate/alerts?run=<id>
    var m = /^#\/candidate\/alerts\?run=([^&]+)/.exec(location.hash || '');
    if (m && sid) {
      var id = decodeURIComponent(m[1]);
      history.replaceState(null, '', '#/candidate/alerts');
      load(true).then(function () { window.tlssRun(id); });
    }
  }

  function install() {
    wrapJobs(); wrapPublic(); wrapHome(); wrapHide();
    var prev = window.render;
    if (typeof prev === 'function' && !prev.__tlss) {
      var next = function () {
        var out = prev.apply(this, arguments);
        try { onRender(); } catch (e) { /* never let this break a page */ }
        return out;
      };
      next.__tlss = true;
      window.render = next;
    }
  }

  // After every other module has wrapped what it wraps.
  if (document.readyState === 'complete') install();
  else window.addEventListener('load', install);

  window.TLSavedSearches = { load: load, fromScreen: fromScreen, canonical: canonical, toScreen: toScreen };
})();
