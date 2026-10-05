/*
 * TeamLink — voice search for jobs.
 *
 * A 🎤 button in the job search bar (public Home / Find jobs, the
 * candidate's Home search and Search Jobs). Tap, say
 *   "Nellore lo driver job kavali, salary 15000 paina"
 *   "Hyderabad mein work from home telecaller"
 *   "fresher data entry jobs near Guntur"
 * and the job list is filtered exactly as if the filters had been typed
 * and ticked.
 *
 *   - shown only where the browser can do it (SpeechRecognition /
 *     webkitSpeechRecognition) and the page is HTTPS or localhost
 *   - the browser turns speech into text; only that text is sent, to
 *     POST /api/search/voice-parse, which answers with filter values the
 *     screens already accept and says which engine understood it
 *   - "You said: ..." with the chips it understood; remove a chip, or
 *     Edit to put the words into the ordinary search box
 *   - English / తెలుగు / हिन्दी, remembered on this device
 *   - stops after ~2 s of silence or 15 s in all
 *   - no results: "No jobs for ..." with one tap to drop each chip, and
 *     Nearby places
 */
(function () {
  'use strict';

  var LANGS = [['en-IN', 'English'], ['te-IN', 'తెలుగు'], ['hi-IN', 'हिन्दी']];
  var LKEY = 'tlvs_lang_v1';
  var V = { open: false, phase: 'idle', text: '', interim: '', error: '', result: null, rec: null,
    lang: null, timer: null, started: 0, lastHeard: 0, applied: null, surface: '' };

  var SR = function () { return window.SpeechRecognition || window.webkitSpeechRecognition || null; };
  var secure = function () {
    return location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].indexOf(location.hostname) >= 0
      || /\.localhost$/.test(location.hostname);
  };
  var supported = function () { return !!SR() && secure(); };
  var api = function () { return window.TL && TL.api; };
  var h = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  };
  var isCand = function () { return !!(window.STATE && STATE.session && STATE.session.role === 'candidate'); };

  function defaultLang() {
    try { var saved = localStorage.getItem(LKEY); if (saved && LANGS.some(function (l) { return l[0] === saved; })) return saved; } catch (e) { /* none */ }
    var n = String(navigator.language || '').toLowerCase();
    return n.indexOf('te') === 0 ? 'te-IN' : n.indexOf('hi') === 0 ? 'hi-IN' : 'en-IN';
  }

  /* ------------------------------------------------------------------ *
   * styles
   * ------------------------------------------------------------------ */
  var css = ''
    + '.tlvs-mic{display:inline-flex;align-items:center;justify-content:center;width:42px;height:42px;flex:0 0 42px;border-radius:50%;border:1px solid #d5e2f5;background:#fff;color:#1d6ff2;font-size:19px;cursor:pointer;margin-right:8px;vertical-align:bottom;box-shadow:0 1px 3px rgba(16,30,54,.08)}'
    + '.tlvs-mic:hover,.tlvs-mic:focus-visible{border-color:#1d6ff2;outline:none;box-shadow:0 0 0 3px rgba(29,111,242,.18)}'
    + '.cd-hero .tlvs-mic{margin:0 8px 0 0}'
    + '.tlvs-ov{position:fixed;inset:0;z-index:9500;background:rgba(15,25,40,.45);display:flex;align-items:flex-end;justify-content:center}'
    + '@media(min-width:640px){.tlvs-ov{align-items:center}}'
    + '.tlvs-pn{background:#fff;width:100%;max-width:460px;border-radius:18px 18px 0 0;padding:18px 18px 16px;box-shadow:0 20px 60px rgba(0,0,0,.25);max-height:92vh;overflow:auto}'
    + '@media(min-width:640px){.tlvs-pn{border-radius:18px}}'
    + '.tlvs-hd{display:flex;align-items:center;justify-content:space-between;gap:10px}.tlvs-hd b{font-size:16px;color:#16202c}'
    + '.tlvs-x{border:0;background:none;font-size:18px;cursor:pointer;color:#6b7a90}'
    + '.tlvs-langs{display:flex;gap:6px;margin:12px 0 4px;flex-wrap:wrap}'
    + '.tlvs-lang{border:1px solid #dde4ec;background:#fff;border-radius:999px;padding:6px 13px;font:inherit;font-size:13px;font-weight:700;color:#42505f;cursor:pointer}'
    + '.tlvs-lang.on{background:#eaf2ff;border-color:#1d6ff2;color:#1d6ff2}'
    + '.tlvs-big{display:flex;flex-direction:column;align-items:center;gap:10px;margin:16px 0 8px}'
    + '.tlvs-dot{width:76px;height:76px;border-radius:50%;background:#1d6ff2;color:#fff;font-size:32px;display:flex;align-items:center;justify-content:center;border:0;cursor:pointer}'
    + '.tlvs-dot.live{animation:tlvsPulse 1.2s ease-in-out infinite}'
    + '@keyframes tlvsPulse{0%{box-shadow:0 0 0 0 rgba(29,111,242,.45)}70%{box-shadow:0 0 0 18px rgba(29,111,242,0)}100%{box-shadow:0 0 0 0 rgba(29,111,242,0)}}'
    + '@media (prefers-reduced-motion: reduce){.tlvs-dot.live{animation:none;outline:4px solid rgba(29,111,242,.35)}}'
    + '.tlvs-tr{min-height:44px;text-align:center;font-size:15px;color:#16202c;line-height:1.45}.tlvs-tr i{color:#8a94a6}'
    + '.tlvs-err{background:#fdecee;color:#9b1c1f;border-radius:10px;padding:9px 12px;font-size:13px;margin:8px 0}'
    + '.tlvs-chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}'
    + '.tlvs-chip{display:inline-flex;align-items:center;gap:6px;background:#eaf2ff;color:#1d4fb8;border:1px solid #cfe0fb;border-radius:999px;padding:5px 6px 5px 11px;font-size:13px;font-weight:700}'
    + '.tlvs-chip button{border:0;background:#cfe0fb;color:#1d4fb8;border-radius:50%;width:20px;height:20px;cursor:pointer;font-size:11px;line-height:1}'
    + '.tlvs-note{font-size:12px;color:#8a4b06;background:#fff4e5;border-radius:8px;padding:7px 10px;margin:6px 0}'
    + '.tlvs-acts{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:12px}'
    + '.tlvs-btn{border-radius:10px;padding:10px 16px;font:inherit;font-size:13px;font-weight:800;cursor:pointer;border:1px solid #dde4ec;background:#fff;color:#42505f}'
    + '.tlvs-btn.pri{background:#1d6ff2;border-color:#1d6ff2;color:#fff}'
    + '.tlvs-priv{font-size:11.5px;color:#8a94a6;text-align:center;margin-top:10px}'
    + '.tlvs-none{background:#fff8ec;border:1px solid #f6dfbd;border-radius:12px;padding:12px 14px;margin:0 0 12px;font-size:13px;color:#5c3b06}'
    + '.tlvs-none .row{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}';
  function addCss() {
    if (document.getElementById('tlvsCss')) return;
    var st = document.createElement('style'); st.id = 'tlvsCss'; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ------------------------------------------------------------------ *
   * the mic buttons
   * ------------------------------------------------------------------ */
  var MIC = function (surface) {
    return '<button type="button" class="tlvs-mic" data-tlvs="' + surface + '" aria-label="Search by voice" title="Search by voice" onclick="tlvsOpen(\'' + surface + '\')">🎤</button>';
  };
  function placeMics() {
    if (!supported()) return;
    addCss();
    /* public Home / Find jobs */
    var form = document.querySelector('.search-card.smart-search form');
    if (form && !form.querySelector('.tlvs-mic')) {
      var sub = form.querySelector('button[type="submit"]');
      if (sub) sub.insertAdjacentHTML('beforebegin', MIC('public'));
    }
    /* the candidate's Home hero */
    var heroGo = document.querySelector('.cd-hero .go');
    if (heroGo && !heroGo.parentNode.querySelector('.tlvs-mic')) {
      heroGo.parentNode.style.display = 'flex'; heroGo.parentNode.style.alignItems = 'flex-end';
      heroGo.insertAdjacentHTML('beforebegin', MIC('candidate'));
    }
    /* the candidate's Search Jobs */
    var rjGo = document.querySelector('.rj-search .go');
    if (rjGo && !rjGo.parentNode.querySelector('.tlvs-mic')) rjGo.insertAdjacentHTML('beforebegin', MIC('candidate'));
  }

  /* ------------------------------------------------------------------ *
   * the panel
   * ------------------------------------------------------------------ */
  function panelHtml() {
    var listening = V.phase === 'listening';
    var langs = '<div class="tlvs-langs" role="radiogroup" aria-label="Language">' + LANGS.map(function (l) {
      return '<button type="button" role="radio" aria-checked="' + (V.lang === l[0]) + '" class="tlvs-lang' + (V.lang === l[0] ? ' on' : '') + '" onclick="tlvsLang(\'' + l[0] + '\')">' + h(l[1]) + '</button>';
    }).join('') + '</div>';
    var body = '';
    if (V.phase === 'result' && V.result) {
      var r = V.result;
      body = '<div style="font-size:12.5px;color:#7b8794;margin-top:12px">You said:</div>'
        + '<div class="tlvs-tr" style="text-align:left;font-weight:700">“' + h(V.text) + '”</div>'
        + (r.chips.length
          ? '<div class="tlvs-chips">' + r.chips.map(function (c) {
            return '<span class="tlvs-chip">' + h(c.label) + '<button type="button" aria-label="Remove ' + h(c.label) + '" onclick="tlvsDrop(\'' + h(c.id) + '\')">✕</button></span>';
          }).join('') + '</div>'
          : '<div class="tlvs-note">We could not pick out a job, place or salary from that. Try again, or Edit the words.</div>')
        + (r.notes || []).map(function (n) { return '<div class="tlvs-note">' + h(n) + '</div>'; }).join('')
        + '<div class="tlvs-acts"><button type="button" class="tlvs-btn" onclick="tlvsEdit()">Edit</button>'
        + '<button type="button" class="tlvs-btn" onclick="tlvsStart()">🎤 Again</button>'
        + '<button type="button" class="tlvs-btn pri" id="tlvsGo" onclick="tlvsApply()"' + (r.chips.length ? '' : ' disabled') + '>Search</button></div>';
    } else {
      body = langs
        + '<div class="tlvs-big"><button type="button" class="tlvs-dot' + (listening ? ' live' : '') + '" aria-label="' + (listening ? 'Stop listening' : 'Start listening') + '" onclick="' + (listening ? 'tlvsStop()' : 'tlvsStart()') + '">🎤</button>'
        + '<div class="tlvs-tr" aria-live="polite">' + (V.phase === 'working' ? '<i>Understanding…</i>'
          : (V.text || V.interim) ? h(V.text) + ' <i>' + h(V.interim) + '</i>'
          : listening ? '<i>Listening… say the job, the place and the salary</i>' : '<i>Tap the mic and speak</i>') + '</div></div>'
        + (V.error ? '<div class="tlvs-err" role="alert">' + h(V.error) + '</div>' : '')
        + '<div class="tlvs-acts">' + (listening ? '<button type="button" class="tlvs-btn pri" onclick="tlvsStop()">Stop</button>' : '')
        + '<button type="button" class="tlvs-btn" onclick="tlvsClose()">Cancel</button></div>';
    }
    return '<div class="tlvs-ov" id="tlvsOv" onclick="if(event.target===this)tlvsClose()"><div class="tlvs-pn" role="dialog" aria-modal="true" aria-label="Voice search">'
      + '<div class="tlvs-hd"><b>🎤 Search by voice</b><button type="button" class="tlvs-x" aria-label="Close" onclick="tlvsClose()">✕</button></div>'
      + body
      + '<div class="tlvs-priv">Your voice is turned into text by your browser. We only receive the text.</div></div></div>';
  }
  function paint() {
    addCss();
    var old = document.getElementById('tlvsOv');
    if (!V.open) { if (old) old.remove(); return; }
    var wrap = document.createElement('div'); wrap.innerHTML = panelHtml();
    var el = wrap.firstChild;
    if (old) old.replaceWith(el); else document.body.appendChild(el);
  }

  window.tlvsOpen = function (surface) {
    if (!supported()) return;
    V.open = true; V.surface = surface || 'public'; V.text = ''; V.interim = ''; V.error = ''; V.result = null;
    V.lang = V.lang || defaultLang(); V.phase = 'idle';
    paint();
    window.tlvsStart();
  };
  window.tlvsClose = function () { abort(); V.open = false; V.phase = 'idle'; paint(); };
  window.tlvsLang = function (l) {
    V.lang = l; try { localStorage.setItem(LKEY, l); } catch (e) { /* this device only */ }
    if (V.phase === 'listening') { abort(); window.tlvsStart(); } else paint();
  };

  function abort() {
    clearInterval(V.timer); V.timer = null;
    var r = V.rec; V.rec = null;
    if (r) { try { r.onresult = r.onerror = r.onend = null; r.abort(); } catch (e) { /* already stopped */ } }
  }

  var ERR = {
    'not-allowed': 'Microphone permission was denied. Allow the microphone for this site in your browser settings, then try again.',
    'service-not-allowed': 'Microphone permission was denied. Allow the microphone for this site in your browser settings, then try again.',
    'no-speech': 'We did not hear anything. Tap the mic and speak again.',
    'audio-capture': 'No microphone was found on this device.',
    network: 'Voice search needs an internet connection. Check your connection and try again.',
  };

  window.tlvsStart = function () {
    var Ctor = SR();
    if (!Ctor) { V.error = 'This browser cannot do voice search. Please type your search instead.'; paint(); return; }
    abort();
    V.text = ''; V.interim = ''; V.error = ''; V.result = null; V.phase = 'listening';
    var rec;
    try { rec = new Ctor(); } catch (e) { V.phase = 'idle'; V.error = 'Voice search could not start in this browser.'; paint(); return; }
    V.rec = rec;
    rec.lang = V.lang || 'en-IN';
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    V.started = Date.now(); V.lastHeard = Date.now();
    var finals = [];
    rec.onresult = function (ev) {
      var interim = '';
      for (var i = ev.resultIndex || 0; i < ev.results.length; i++) {
        var res = ev.results[i];
        var t = res[0] && res[0].transcript ? res[0].transcript : '';
        if (res.isFinal) finals[i] = t; else interim += t;
      }
      V.text = finals.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      V.interim = interim.trim();
      V.lastHeard = Date.now();
      paint();
    };
    rec.onerror = function (ev) {
      var code = ev && ev.error;
      if (code === 'aborted') return;
      V.error = ERR[code] || 'Voice search stopped unexpectedly. Please try again.';
      V.phase = 'idle'; abort(); paint();
    };
    rec.onend = function () {
      if (V.rec !== rec) return;
      V.rec = null; clearInterval(V.timer); V.timer = null;
      finish();
    };
    try { rec.start(); } catch (e) { V.phase = 'idle'; V.error = 'Voice search could not start. Please try again.'; paint(); return; }
    /* ~2 s of silence after something was said, or 15 s in all */
    V.timer = setInterval(function () {
      var now = Date.now();
      var said = V.text || V.interim;
      if ((said && now - V.lastHeard > 2000) || now - V.started > 15000) window.tlvsStop();
    }, 250);
    paint();
  };

  window.tlvsStop = function () {
    clearInterval(V.timer); V.timer = null;
    var r = V.rec;
    if (r) { try { r.stop(); } catch (e) { V.rec = null; finish(); } }
    else finish();
  };

  function finish() {
    if (V.phase !== 'listening') return;
    var text = (V.text + ' ' + V.interim).replace(/\s+/g, ' ').trim();
    V.text = text; V.interim = '';
    if (!text) {
      V.phase = 'idle';
      if (!V.error) V.error = ERR['no-speech'];
      paint(); return;
    }
    V.phase = 'working'; paint();
    var send = api() ? api().post('/search/voice-parse', { text: text.slice(0, 300), lang: V.lang })
      : Promise.reject(new Error('Not connected'));
    send.then(function (r) {
      V.result = r; V.phase = 'result'; paint();
    }).catch(function (e) {
      V.phase = 'idle';
      V.error = (e && e.message) || 'Your words could not be understood just now. Please try again.';
      paint();
    });
  }

  /* ------------------------------------------------------------------ *
   * chips -> the screen's own filters
   * ------------------------------------------------------------------ */
  function dropFrom(r, id) {
    r.chips = r.chips.filter(function (c) { return c.id !== id; });
    var f = r.filters, p = r.portal, s = r.search;
    if (id === 'q') { f.q = ''; p.q = ''; if (s) { s.concepts = []; s.keywords = []; } }
    else if (id === 'loc') { f.loc = ''; p.locTags = []; if (s) s.location = []; }
    else if (id === 'salary') { f.salaryMin = ''; p.ctcMin = ''; }
    else if (id === 'exp') { f.exp = ''; p.exp = []; if (s) { s.years = null; s.fresher = false; } }
    else if (id === 'posted') { f.posted = ''; p.posted = ''; }
    else if (id.indexOf('mode:') === 0) {
      var m = id.slice(5);
      f.mode = f.mode.filter(function (x) { return x !== m; });
      var pm = { Onsite: 'Work From Office', Remote: 'Remote', Hybrid: 'Hybrid' }[m];
      p.modes = p.modes.filter(function (x) { return x !== pm; });
    } else if (id.indexOf('type:') === 0) {
      var t = id.slice(5);
      f.jobType = f.jobType.filter(function (x) { return x !== t; });
      p.types = p.types.filter(function (x) { return x !== t; });
    }
    /* the ranking has to be asked again for what is left */
    if (s && (id === 'q' || id === 'loc' || id === 'exp')) r.__dirty = true;
  }
  window.tlvsDrop = function (id) { if (V.result) { dropFrom(V.result, id); paint(); } };

  function setTags(keys, tags) {
    if (typeof window.tlLocState !== 'function') return;
    keys.forEach(function (k) { var st = tlLocState(k); st.tags = tags.slice(); });
  }

  /* ------------------------------------------------------------------ *
   * the meaning: the server's normalized search and its ranked jobs.
   * While a voice search is on screen the list is THOSE jobs (in that
   * order), with the screen's other filters still applying on top. The
   * words that were said are never the search key.
   * ------------------------------------------------------------------ */
  var token = 0;
  function rankOf(r) {
    var m = Object.create(null);
    ((r.semantic && r.semantic.results) || []).forEach(function (x, i) { m[x.jobId] = { i: i, score: x.score, label: x.label }; });
    return m;
  }
  /* The place is a filter only while the ranking kept it (levels 1-3, or a place on its own). */
  function keepsPlace(r) {
    var s = r.semantic;
    if (!s || !r.filters.loc) return !!r.filters.loc;
    return s.level >= 1 && s.level <= 3 || !(r.search && ((r.search.concepts || []).length || (r.search.keywords || []).length));
  }
  function voiceOn(surface, f) {
    var a = V.applied;
    if (!a || !a.semantic || a.surface !== surface) return false;
    if (surface === 'public') { f = f || (window.STATE && STATE.search) || {}; return f.__voice === a.token && String(f.q || '') === a.q; }
    var rj = (window.STATE && STATE.rj) || {};
    return rj.__voice === a.token && !rj.q;
  }

  function applyPublic(r) {
    var f = r.filters;
    var sort = (STATE.search && STATE.search.sort) || 'relevance';
    var base = typeof window.freshSearchState === 'function' ? freshSearchState() : {};
    var place = keepsPlace(r) ? (f.loc || '') : '';
    STATE.search = Object.assign(base, {
      q: f.q || '', loc: place, exp: f.exp || '', salaryMin: f.salaryMin || '',
      mode: (f.mode || []).slice(), jobType: (f.jobType || []).slice(), skills: (f.skills || []).slice(),
      education: f.education || '', posted: f.posted || '', sort: sort,
    });
    if (V.applied && V.applied.semantic) { STATE.search.__voice = V.applied.token; V.applied.q = STATE.search.q; }
    setTags(['pubJobs'], place ? [place] : []);
    if (typeof window.tlLocState === 'function') { var st = tlLocState('pubJobs'); st.__seeded = true; }
    var onSearch = /^#\/(jobs)?(\?|$)/.test(location.hash || '#/') || (location.hash || '') === '';
    if (!onSearch) location.hash = '#/jobs';
    if (typeof window.applySearch === 'function') applySearch(); else if (typeof window.render === 'function') render();
  }

  function applyCandidate(r) {
    var p = r.portal;
    var voice = !!(V.applied && V.applied.semantic);
    var tags = keepsPlace(r) ? (p.locTags || []).slice() : [];
    STATE.rj = STATE.rj || {};
    /* the search box's own rule is a substring of title / skills / company;
       a voice search is matched by meaning instead, so the box rule is off */
    STATE.rj.q = voice ? '' : (p.q || '');
    STATE.rj.loc = '';
    STATE.rj.page = 1;
    STATE.rj.f = {
      locations: [], exp: (p.exp || []).slice(), ctcMin: p.ctcMin || '', ctcMax: '',
      modes: (p.modes || []).slice(), types: (p.types || []).slice(), skills: '', edu: '', posted: p.posted || '',
      company: '', match: '', locTags: tags, locKm: '',
    };
    if (voice) STATE.rj.__voice = V.applied.token; else delete STATE.rj.__voice;
    setTags(['rjSide', 'rjTop', 'candHome'], tags);
    if (location.hash !== '#/candidate/search') location.hash = '#/candidate/search';
    else if (typeof window.render === 'function') render();
  }

  function applyNow(r) {
    token += 1;
    V.applied = {
      result: JSON.parse(JSON.stringify(r)), surface: V.surface === 'candidate' && isCand() ? 'candidate' : 'public',
      token: token, semantic: r.semantic || null, rank: rankOf(r), q: '', banner: false,
    };
    if (V.applied.surface === 'candidate') applyCandidate(r); else applyPublic(r);
  }
  /* A changed search (a chip removed, a saved voice search) is ranked again on the server. */
  function rerank(r) {
    if (!r.search || !api()) return Promise.resolve(r);
    return api().post('/search/semantic', { search: r.search }).then(function (o) {
      r.search = o.search; r.semantic = o.semantic; r.__dirty = false; return r;
    });
  }

  window.tlvsApply = function () {
    var r = V.result; if (!r) return;
    V.open = false; V.phase = 'idle'; abort(); paint();
    if (r.__dirty) rerank(r).then(applyNow, function () { r.semantic = null; applyNow(r); });
    else applyNow(r);
  };

  window.tlvsEdit = function () {
    /* the words in the box are the ENGLISH search we understood, never
       the other-script sentence (which would match nothing) */
    var r = V.result;
    var text = r && r.filters && r.filters.q ? r.filters.q : (/[ऀ-ॿఀ-౿]/.test(V.text) ? '' : V.text);
    V.open = false; V.phase = 'idle'; abort(); paint();
    if (V.surface === 'candidate' && isCand()) {
      STATE.rj = STATE.rj || {}; STATE.rj.q = text;
      if (location.hash !== '#/candidate/search') location.hash = '#/candidate/search';
      if (typeof window.render === 'function') render();
      setTimeout(function () { var el = document.getElementById('rjQ'); if (el) { el.value = text; el.focus(); } }, 120);
    } else {
      STATE.search = STATE.search || {}; STATE.search.q = text;
      if (typeof window.render === 'function') render();
      setTimeout(function () {
        var el = document.querySelector('.search-card.smart-search input[name="q"]');
        if (el) { el.value = text; el.focus(); }
      }, 120);
    }
  };

  /** The applied voice search's criteria, in the form saved searches store (api saved-match compactVoice). */
  function criteria(surface) {
    if (!voiceOn(surface)) return null;
    var s = V.applied.result.search || {};
    if (!((s.concepts || []).length || (s.keywords || []).length)) return null;
    var out = {
      language: s.language, originalQuery: s.originalQuery, normalizedQuery: s.normalizedQuery,
      concepts: (s.concepts || []).slice(), keywords: (s.keywords || []).slice(), location: (s.location || []).slice(),
      role: (s.role || []).slice(), skills: (s.skills || []).slice(), technologies: (s.technologies || []).slice(),
      industry: (s.industry || []).slice(), qualification: (s.qualification || []).slice(),
    };
    if (s.years != null) out.years = s.years;
    if (s.fresher) out.fresher = true;
    return out;
  }
  /** Run a saved voice search again: the stored criteria, ranked now. */
  function replay(saved, surface) {
    if (!saved || !api()) return;
    api().post('/search/semantic', { search: saved }).then(function (o) {
      var place = (o.search.location || [])[0] || '';
      var r = {
        filters: { q: o.search.label ? o.search.label.toLowerCase() : '', loc: place, salaryMin: '', mode: [], jobType: [], exp: '', skills: [], education: '', posted: '', sort: '' },
        portal: { q: o.search.label ? o.search.label.toLowerCase() : '', locTags: place ? [place] : [], ctcMin: '', exp: [], modes: [], types: [], posted: '' },
        chips: [].concat(o.search.label ? [{ id: 'q', label: o.search.label }] : [], place ? [{ id: 'loc', label: place }] : []),
        search: o.search, semantic: o.semantic,
      };
      V.surface = surface || 'candidate';
      var keep = surface === 'candidate' && window.STATE && STATE.rj ? STATE.rj.f : null;
      applyNow(r);
      /* the saved search's other filters stay as the saved search set them */
      if (keep && STATE.rj) { var tags = STATE.rj.f.locTags; STATE.rj.f = keep; STATE.rj.f.locTags = tags; if (typeof window.render === 'function') render(); }
    }).catch(function () { /* the saved filters are already on screen */ });
  }

  /* ------------------------------------------------------------------ *
   * the list: the ranked jobs, in their order
   * ------------------------------------------------------------------ */
  function installList() {
    var prevF = window.filterJobsAdvanced;
    if (typeof prevF === 'function' && !prevF.__tlvs) {
      var f1 = function (f) {
        var on = voiceOn('public', f || (window.STATE && STATE.search));
        if (!on) return prevF.apply(this, arguments);
        var ff = Object.assign({}, f || STATE.search, { q: '', loc: '' });
        var list = prevF.call(this, ff);
        var rank = V.applied.rank;
        return Array.isArray(list) ? list.filter(function (j) { return j && rank[j.id]; }) : list;
      };
      f1.__tlvs = true;
      window.filterJobsAdvanced = f1;
    }
    var prevS = window.sortJobs;
    if (typeof prevS === 'function' && !prevS.__tlvs) {
      var s1 = function (list, sort) {
        var out = prevS.apply(this, arguments);
        if ((sort || 'relevance') !== 'relevance' || !voiceOn('public') || !Array.isArray(out)) return out;
        var rank = V.applied.rank;
        return out.slice().sort(function (a, b) { return (rank[a.id] ? rank[a.id].i : 1e6) - (rank[b.id] ? rank[b.id].i : 1e6); });
      };
      s1.__tlvs = true;
      window.sortJobs = s1;
    }
    var prevR = window.recAll;
    if (typeof prevR === 'function' && !prevR.__tlvs) {
      var r1 = function () {
        var list = prevR.apply(this, arguments);
        if (!Array.isArray(list) || !/^#\/candidate\/search/.test(location.hash) || !voiceOn('candidate')) return list;
        var rank = V.applied.rank;
        return list.filter(function (x) { return x && x.job && rank[x.job.id]; })
          .sort(function (a, b) { return rank[a.job.id].i - rank[b.job.id].i; });
      };
      r1.__tlvs = true;
      window.recAll = r1;
    }
  }

  /* ------------------------------------------------------------------ *
   * nothing found / only related jobs: a message built from the
   * normalized search, never the words said
   * ------------------------------------------------------------------ */
  function resultCount() {
    if (!V.applied) return null;
    if (V.applied.surface === 'candidate') {
      var rc = document.querySelector('.rj-count');
      var m = rc ? /(\d+)/.exec(rc.textContent) : null;
      return m ? Number(m[1]) : null;
    }
    var b = document.querySelector('.result-count b');
    return b ? Number(b.textContent) : null;
  }
  function emptyText(a) {
    var s = a.semantic;
    if (s && s.empty && s.message) return s.message;
    var srch = a.result.search;
    var what = srch && srch.label ? srch.label : (a.result.chips.filter(function (c) { return c.id === 'q'; })[0] || {}).label || '';
    var loc = a.result.filters.loc;
    return 'No matching ' + (what ? what + ' ' : '') + 'jobs found' + (loc ? ' in ' + loc : '') + '.';
  }
  function placeNone() {
    var old = document.getElementById('tlvsNone');
    if (!V.applied) { if (old) old.remove(); return; }
    var onIt = V.applied.surface === 'candidate' ? /^#\/candidate\/search/.test(location.hash) : /^#\/(jobs)?(\?|$)/.test(location.hash || '#/') || !location.hash;
    if (!onIt) { V.applied = null; if (old) old.remove(); return; }
    if (V.applied.surface === 'candidate' && voiceOn('candidate')) {
      var box = document.getElementById('rjQ');
      if (box && !box.value) box.value = V.applied.result.portal.q || '';
    }
    var n = resultCount();
    if (old) return;
    var chips = V.applied.result.chips;
    var sem = V.applied.semantic;
    var html = '';
    if (n === 0 && chips.length) {
      var loc = V.applied.result.filters.loc;
      html = '<div class="tlvs-none" id="tlvsNone" role="status"><b>' + h(emptyText(V.applied)) + '</b>'
        + '<div class="row">' + chips.map(function (c) {
          return '<button type="button" class="tlvs-btn" style="padding:6px 11px" onclick="tlvsRelax(\'' + h(c.id) + '\')">Remove ' + h(c.label) + '</button>';
        }).join('')
        + (loc ? '<button type="button" class="tlvs-btn pri" style="padding:6px 11px" onclick="tlvsNearby()">📍 Nearby places</button>' : '')
        + '</div></div>';
    } else if (n > 0 && sem && sem.message && voiceOn(V.applied.surface)) {
      html = '<div class="tlvs-none" id="tlvsNone" role="status"><b>' + h(sem.message) + '</b></div>';
    }
    if (!html) return;
    var list = V.applied.surface === 'candidate'
      ? (document.querySelector('.rj-results') || document.querySelector('.rj-body > div:last-child') || document.querySelector('.rj-bar'))
      : document.querySelector('.job-list');
    if (list) list.insertAdjacentHTML('beforebegin', html);
  }
  window.tlvsRelax = function (id) {
    if (!V.applied) return;
    var r = V.applied.result;
    dropFrom(r, id);
    var old = document.getElementById('tlvsNone'); if (old) old.remove();
    V.surface = V.applied.surface;
    if (r.__dirty) rerank(r).then(applyNow, function () { r.semantic = null; applyNow(r); });
    else applyNow(r);
  };
  window.tlvsNearby = function () {
    if (!V.applied || typeof window.tlLocState !== 'function') return;
    var keys = V.applied.surface === 'candidate' ? ['rjSide', 'rjTop', 'candHome'] : ['pubJobs'];
    keys.forEach(function (k) { tlLocState(k).km = '50'; });
    if (V.applied.surface === 'candidate' && STATE.rj && STATE.rj.f) STATE.rj.f.locKm = '50';
    if (V.applied.surface === 'public' && STATE.search) STATE.search.distKm = '50';
    var old = document.getElementById('tlvsNone'); if (old) old.remove();
    if (typeof window.render === 'function') render();
  };

  /* ------------------------------------------------------------------ */
  function install() {
    installList();
    var prev = window.render;
    if (typeof prev === 'function' && !prev.__tlvs) {
      var r = function () {
        var out = prev.apply(this, arguments);
        try { placeMics(); placeNone(); } catch (e) { /* never break a page */ }
        return out;
      };
      r.__tlvs = true;
      window.render = r;
    }
    try { placeMics(); } catch (e) { /* */ }
  }
  if (document.readyState === 'complete') install();
  else window.addEventListener('load', install);

  window.TLVoiceSearch = {
    supported: supported,
    open: function (s) { window.tlvsOpen(s); },
    /* for saved searches (teamlink-saved-searches.js) */
    criteria: criteria,
    replay: replay,
    active: function (s) { return voiceOn(s || 'public'); },
  };
})();
