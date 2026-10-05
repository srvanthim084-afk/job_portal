/*
 * Screening questions (0097) - every screen that touches them.
 *
 *   Candidate   "A few quick questions" before an application is sent:
 *               one screen, pre-filled, "3 of 5 answered". Apply Now shows
 *               it; one-click apply (another module) calls
 *               window.TLScreening.beforeApply(jobId) itself.
 *               The no-password answer page: #/screening-answers/<token>.
 *   Recruiter   badges and filters on the Applications list (Notice, Exp.
 *               CTC, Relocate, "Must-have not met", "Answers pending"), an
 *               answers panel per application (re-open, answered on call),
 *               bulk "Send screening questions", and the question editor on
 *               every job (button beside Edit, and in AI Job Creation).
 *   Client      the shared answers on a shortlisted candidate.
 *   Admin       the standard questions and the answers weight, on AI Settings.
 *
 * The browser decides nothing: the server validates every answer, every
 * rule and every permission. A failed must-have is never shown to the
 * candidate - their screen says "Application submitted" either way.
 *
 * The current-location answer (stdKey current_location, or options.places)
 * offers place suggestions from the places index as the person types -
 * GET /api/places/search when signed in, POST /api/screening/link/places
 * (by the link token) on the no-password page. Free text is still allowed.
 *
 * window.TLScreening.beforeApply(jobId) -> Promise<
 *     null                    the job asks nothing (or it is not a TeamLink job)
 *   | {answers:[...], saveDefaults}   answered; the next POST /api/applications
 *                                     for this job carries them automatically
 *   | {cancelled:true}        the candidate closed the questions >
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__tlScreening) return;
  window.__tlScreening = true;

  var PENDING_TTL = 10 * 60 * 1000;
  var pending = Object.create(null);           // jobId -> {answers, saveDefaults, at}

  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api() { return window.TL && TL.api; }
  function say(msg, icon) { if (typeof window.toast === 'function') window.toast(msg, icon); }
  function session() { return (typeof STATE !== 'undefined' && STATE.session) || null; }
  function role() { var s = session(); return s ? s.role : null; }
  function isExternal(id) { return /^xjob_/.test(String(id || '')); }

  /* ------------------------------------------------------------------ *
   * styles
   * ------------------------------------------------------------------ */
  function css() {
    if (document.getElementById('tlsqCss')) return;
    var s = document.createElement('style');
    s.id = 'tlsqCss';
    s.textContent = [
      '.tlsq-ov{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9000;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:24px 12px}',
      '.tlsq-box{background:#fff;border-radius:14px;max-width:620px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.25);font-size:14px;color:#1d2733}',
      '.tlsq-box.wide{max-width:860px}',
      '.tlsq-hd{padding:18px 20px 10px;border-bottom:1px solid #e8edf3;display:flex;gap:10px;align-items:flex-start}',
      '.tlsq-hd h3{margin:0;font-size:17px;font-weight:800;flex:1}',
      '.tlsq-hd .sub{font-size:12.5px;color:#6b7a90;margin-top:3px;font-weight:400}',
      '.tlsq-x{border:0;background:none;font-size:20px;cursor:pointer;color:#6b7a90;line-height:1}',
      '.tlsq-bd{padding:14px 20px;max-height:calc(100vh - 220px);overflow:auto}',
      '.tlsq-ft{padding:12px 20px 16px;border-top:1px solid #e8edf3;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;align-items:center;position:sticky;bottom:0;background:#fff;border-radius:0 0 14px 14px}',
      '.tlsq-prog{height:6px;background:#eef2f7;border-radius:99px;overflow:hidden;margin:8px 0 2px}',
      '.tlsq-prog>i{display:block;height:100%;background:var(--brand-500,#1d6ff2);transition:width .2s}',
      '.tlsq-q{padding:12px 0;border-bottom:1px solid #f0f3f7}',
      '.tlsq-q:last-child{border-bottom:0}',
      '.tlsq-q label.t{display:block;font-weight:700;margin-bottom:7px}',
      '.tlsq-q input[type=text],.tlsq-q input[type=number],.tlsq-q input[type=date],.tlsq-q select,.tlsq-in{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d5dce6;border-radius:9px;font-size:14px}',
      '.tlsq-chips{display:flex;flex-wrap:wrap;gap:8px}',
      '.tlsq-chip{border:1px solid #d5dce6;border-radius:99px;padding:8px 14px;background:#fff;cursor:pointer;font-size:13.5px}',
      '.tlsq-chip.on{background:var(--brand-500,#1d6ff2);color:#fff;border-color:var(--brand-500,#1d6ff2)}',
      '.tlsq-err{color:#c62828;font-size:12.5px;margin-top:5px}',
      '.tlsq-unit{font-size:12px;color:#6b7a90;margin-top:4px}',
      '.tlsq-badges{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}',
      '.tlsq-b{display:inline-block;font-size:11px;font-weight:700;border-radius:99px;padding:2px 8px;white-space:nowrap}',
      '.tlsq-b.red{background:#fde8e8;color:#b42318}.tlsq-b.grey{background:#eef1f5;color:#5b6678}',
      '.tlsq-b.ok{background:#e6f6ec;color:#1e7a3c}.tlsq-b.info{background:#eaf2ff;color:#1b4f9e}',
      '.tlsq-bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 14px;margin:10px 0;background:#f7f9fc;border:1px solid #e4eaf2;border-radius:10px;font-size:12.5px}',
      '.tlsq-bar label{display:inline-flex;gap:6px;align-items:center}',
      '.tlsq-bar select,.tlsq-bar input{padding:6px 8px;border:1px solid #d5dce6;border-radius:7px;font-size:12.5px}',
      '.tlsq-row{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:start;padding:10px;border:1px solid #e4eaf2;border-radius:10px;margin-bottom:8px}',
      '.tlsq-row .meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;font-size:12px;color:#5b6678;align-items:center}',
      '.tlsq-row .tools button{border:1px solid #d5dce6;background:#fff;border-radius:6px;padding:3px 7px;cursor:pointer;margin-left:2px}',
      '.tlsq-ans{display:grid;grid-template-columns:1fr auto;gap:4px 12px;padding:9px 0;border-bottom:1px solid #f0f3f7}',
      '.tlsq-ans .a{font-weight:700}.tlsq-ans .w{font-size:11.5px;color:#6b7a90;grid-column:1/3}',
      '.tlsq-warn{background:#fff7e6;border:1px solid #ffd591;color:#874d00;border-radius:8px;padding:8px 10px;font-size:12.5px;margin:8px 0}',
      '.tlsq-page{max-width:640px;margin:24px auto;padding:0 16px}',
      '.tlsq-place{position:relative}',
      '.tlsq-sug{position:absolute;left:0;right:0;top:100%;margin-top:4px;z-index:5;background:#fff;border:1px solid #d5dce6;border-radius:9px;box-shadow:0 10px 30px rgba(15,23,42,.14);max-height:240px;overflow:auto}',
      '.tlsq-sug[hidden]{display:none}',
      '.tlsq-sugi{display:block;width:100%;text-align:left;padding:9px 12px;border:0;border-bottom:1px solid #f0f3f7;background:#fff;cursor:pointer;font-size:13.5px;color:#1d2733}',
      '.tlsq-sugi:last-child{border-bottom:0}',
      '.tlsq-sugi small{display:block;color:#6b7a90;font-size:11.5px;margin-top:1px}',
      '.tlsq-sugi.on,.tlsq-sugi:hover{background:#eef4ff}',
      '@media (max-width:600px){.tlsq-ov{padding:0}.tlsq-box{border-radius:0;min-height:100%}.tlsq-bd{max-height:none}}',
    ].join('\n');
    document.head.appendChild(s);
  }

  function overlay(id, inner, wide) {
    css();
    close(id);
    var el = document.createElement('div');
    el.className = 'tlsq-ov';
    el.id = id;
    el.innerHTML = '<div class="tlsq-box' + (wide ? ' wide' : '') + '" role="dialog" aria-modal="true">' + inner + '</div>';
    document.body.appendChild(el);
    return el;
  }
  function close(id) { var el = document.getElementById(id); if (el) el.remove(); }

  /* ------------------------------------------------------------------ *
   * the answer form (candidate apply step, the link page, "on call")
   * ------------------------------------------------------------------ */

  function isAnswered(q, a) {
    if (!a) return false;
    var v = a.value;
    if (q.type === 'multi_choice') return Array.isArray(v) && v.length > 0;
    if (v === undefined || v === null || String(v).trim() === '') return false;
    var f = q.options && q.options.followUp;
    if (f && f.type === 'date' && String(v).toLowerCase() === String(f.when).toLowerCase() && !a.detail) return false;
    return true;
  }

  /* The current-location question: answered with the places search. */
  function isPlaceQ(q) {
    return q.type === 'short_text' && (q.stdKey === 'current_location' || !!(q.options && q.options.places));
  }

  /* "Denduluru, Andhra Pradesh" - the name and its state, so two places of
     one name can be told apart; a state on its own is just its name. */
  function placeValue(n) {
    var path = (n && n.path) || [];
    var st = path.length ? path[path.length - 1] : '';
    return n.type === 'state' || !st || st === n.name ? n.name : n.name + ', ' + st;
  }

  function signedInPlaces(q) {
    if (!api()) return Promise.resolve([]);
    return api().get('/places/search?limit=8&q=' + encodeURIComponent(q)).then(function (r) {
      return (r && r.results) || [];
    });
  }

  function fieldHtml(q, a, err) {
    var o = q.options || {};
    var v = a ? a.value : undefined;
    var id = 'tlsqA_' + q.id;
    var html = '<div class="tlsq-q" data-q="' + h(q.id) + '"><label class="t" for="' + id + '">' + h(q.text) + '</label>';
    if (q.type === 'yes_no') {
      html += '<div class="tlsq-chips">' + ['yes', 'no'].map(function (x) {
        return '<button type="button" class="tlsq-chip' + (v === x ? ' on' : '') + '" data-set="' + x + '">' + (x === 'yes' ? 'Yes' : 'No') + '</button>';
      }).join('') + '</div>';
    } else if (q.type === 'single_choice') {
      html += '<div class="tlsq-chips">' + (o.choices || []).map(function (c) {
        return '<button type="button" class="tlsq-chip' + (v === c ? ' on' : '') + '" data-set="' + h(c) + '">' + h(c) + '</button>';
      }).join('') + '</div>';
    } else if (q.type === 'multi_choice') {
      var arr = Array.isArray(v) ? v : [];
      html += '<div class="tlsq-chips">' + (o.choices || []).map(function (c) {
        return '<button type="button" class="tlsq-chip' + (arr.indexOf(c) >= 0 ? ' on' : '') + '" data-toggle="' + h(c) + '">' + h(c) + '</button>';
      }).join('') + '</div>';
    } else if (q.type === 'number') {
      html += '<input id="' + id + '" type="number" inputmode="decimal" step="any"' + (o.min != null ? ' min="' + o.min + '"' : '')
        + (o.max != null ? ' max="' + o.max + '"' : '') + ' value="' + h(v == null ? '' : v) + '" data-num="1">'
        + (o.unit ? '<div class="tlsq-unit">In ' + h(o.unit) + '</div>' : '');
    } else if (q.type === 'date') {
      html += '<input id="' + id + '" type="date" value="' + h(v || '') + '" data-text="1">';
    } else if (isPlaceQ(q)) {
      html += '<div class="tlsq-place"><input id="' + id + '" type="text" maxlength="200" value="' + h(v || '') + '" data-text="1"'
        + ' data-place="1" placeholder="City, e.g. Hyderabad" autocomplete="off" role="combobox" aria-autocomplete="list"'
        + ' aria-expanded="false" aria-controls="' + id + '_sug">'
        + '<div class="tlsq-sug" id="' + id + '_sug" role="listbox" hidden></div></div>'
        + '<div class="tlsq-unit">Pick a suggestion or type your own</div>';
    } else {
      html += '<input id="' + id + '" type="text" maxlength="200" value="' + h(v || '') + '" data-text="1">';
    }
    var f = o.followUp;
    if (f && v != null && String(v).toLowerCase() === String(f.when).toLowerCase()) {
      html += '<div style="margin-top:8px"><label class="t" style="font-weight:600;font-size:13px">' + h(f.label || 'Details')
        + (f.type === 'date' ? '' : ' <span style="font-weight:400;color:#6b7a90">(optional)</span>') + '</label>'
        + '<input type="' + (f.type === 'date' ? 'date' : 'text') + '" maxlength="120" value="' + h((a && a.detail) || '') + '" data-detail="1"></div>';
    }
    if (err) html += '<div class="tlsq-err">' + h(err) + '</div>';
    return html + '</div>';
  }

  /**
   * Mount an answer form into `host`. Returns { values(), errors(map) }.
   * `state` = { questions, answers:{qid:{value,detail}} }
   */
  function mountForm(host, state, onChange, opts) {
    var errs = {};
    var searchPlaces = (opts && opts.searchPlaces) || signedInPlaces;
    var sug = { timer: null, seq: 0, items: [], active: -1, input: null };

    function sugBox(input) { return input && document.getElementById(input.id + '_sug'); }
    function hideSug(input) {
      var box = sugBox(input || sug.input);
      if (box) { box.hidden = true; box.innerHTML = ''; }
      if (input || sug.input) (input || sug.input).setAttribute('aria-expanded', 'false');
      sug.items = []; sug.active = -1;
    }
    function paintSug(input) {
      var box = sugBox(input);
      if (!box) return;
      if (!sug.items.length) { hideSug(input); return; }
      box.innerHTML = sug.items.map(function (n, i) {
        var rest = (n.label || '').split(' · ').slice(1).join(' · ');
        return '<button type="button" class="tlsq-sugi' + (i === sug.active ? ' on' : '') + '" role="option" id="' + input.id + '_o' + i + '"'
          + ' aria-selected="' + (i === sug.active ? 'true' : 'false') + '" data-place-pick="' + i + '">'
          + h(n.name) + (rest ? '<small>' + h(rest) + '</small>' : '') + '</button>';
      }).join('');
      var opening = box.hidden;
      box.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      /* At the bottom of a scrolling panel the list would open out of sight. */
      if (opening && box.scrollIntoView) { try { box.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
      if (sug.active >= 0) input.setAttribute('aria-activedescendant', input.id + '_o' + sug.active);
      else input.removeAttribute('aria-activedescendant');
    }
    function lookUp(input) {
      clearTimeout(sug.timer);
      var q = String(input.value || '').trim();
      sug.input = input;
      if (q.length < 2) { hideSug(input); return; }
      var mine = ++sug.seq;
      sug.timer = setTimeout(function () {
        Promise.resolve().then(function () { return searchPlaces(q); }).then(function (list) {
          if (mine !== sug.seq || document.activeElement !== input) return;
          sug.items = (list || []).slice(0, 8); sug.active = -1;
          paintSug(input);
        }, function () { if (mine === sug.seq) hideSug(input); });
      }, 200);
    }
    function pick(input, i) {
      var n = sug.items[i];
      if (!n || !input) return;
      var qid = input.closest('[data-q]').getAttribute('data-q');
      var cur = state.answers[qid] || {};
      cur.value = placeValue(n);
      state.answers[qid] = cur;
      input.value = cur.value;
      sug.seq++;
      hideSug(input);
      progress();
    }
    host.addEventListener('mousedown', function (e) {
      if (e.target.closest && e.target.closest('[data-place-pick]')) e.preventDefault();   // keep the focus
    });
    host.addEventListener('keydown', function (e) {
      var input = e.target;
      if (!input.hasAttribute || !input.hasAttribute('data-place') || !sug.items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var n = sug.items.length;
        sug.active = e.key === 'ArrowDown' ? (sug.active + 1) % n : (sug.active <= 0 ? n - 1 : sug.active - 1);
        paintSug(input);
      } else if (e.key === 'Enter' && sug.active >= 0) {
        e.preventDefault(); pick(input, sug.active);
      } else if (e.key === 'Escape') {
        sug.seq++; hideSug(input);
      }
    });
    host.addEventListener('focusout', function (e) {
      if (e.target.hasAttribute && e.target.hasAttribute('data-place')) {
        var input = e.target;
        setTimeout(function () { if (document.activeElement !== input) { sug.seq++; hideSug(input); } }, 150);
      }
    });
    function progress() {
      var n = state.questions.filter(function (q) { return isAnswered(q, state.answers[q.id]); }).length;
      var t = state.questions.length;
      var p = host.querySelector('.tlsq-progtext');
      if (p) p.textContent = n + ' of ' + t + ' answered';
      var bar = host.querySelector('.tlsq-prog>i');
      if (bar) bar.style.width = (t ? Math.round(n / t * 100) : 0) + '%';
      if (onChange) onChange(n, t);
    }
    function draw() {
      host.innerHTML = '<div class="tlsq-progtext" style="font-size:12.5px;color:#5b6678;font-weight:700"></div>'
        + '<div class="tlsq-prog"><i style="width:0"></i></div>'
        + state.questions.map(function (q) { return fieldHtml(q, state.answers[q.id], errs[q.id]); }).join('');
      progress();
    }
    host.addEventListener('click', function (e) {
      var pk = e.target.closest('[data-place-pick]');
      if (pk) {
        var inp = pk.closest('.tlsq-place').querySelector('input[data-place]');
        pick(inp, Number(pk.getAttribute('data-place-pick')));
        return;
      }
      var b = e.target.closest('[data-set],[data-toggle]');
      if (!b) return;
      var qid = b.closest('[data-q]').getAttribute('data-q');
      var q = state.questions.filter(function (x) { return x.id === qid; })[0];
      var cur = state.answers[qid] || {};
      if (b.hasAttribute('data-set')) {
        var val = b.getAttribute('data-set');
        state.answers[qid] = { value: val, detail: cur.value === val ? cur.detail : undefined };
      } else {
        var arr = Array.isArray(cur.value) ? cur.value.slice() : [];
        var t = b.getAttribute('data-toggle');
        var i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1); else arr.push(t);
        state.answers[qid] = { value: arr };
      }
      delete errs[qid];
      draw();
      if (q && q.options && q.options.followUp) {
        var d = host.querySelector('[data-q="' + qid + '"] [data-detail]');
        if (d) d.focus();
      }
    });
    host.addEventListener('input', function (e) {
      var wrap = e.target.closest('[data-q]');
      if (!wrap) return;
      var qid = wrap.getAttribute('data-q');
      var cur = state.answers[qid] || {};
      if (e.target.hasAttribute('data-detail')) cur.detail = e.target.value;
      else if (e.target.hasAttribute('data-num')) cur.value = e.target.value === '' ? '' : Number(e.target.value);
      else cur.value = e.target.value;
      state.answers[qid] = cur;
      progress();
      if (e.target.hasAttribute('data-place')) lookUp(e.target);
    });
    draw();
    return {
      check: function () {
        errs = {};
        state.questions.forEach(function (q) {
          if (!isAnswered(q, state.answers[q.id])) errs[q.id] = 'Please answer this question.';
        });
        draw();
        return Object.keys(errs).length === 0;
      },
      showServerErrors: function (details) {
        errs = {};
        Object.keys(details || {}).forEach(function (k) {
          var m = /^answers\.(.+)$/.exec(k);
          if (m) errs[m[1]] = details[k];
        });
        draw();
      },
      payload: function () {
        return state.questions.map(function (q) {
          var a = state.answers[q.id] || {};
          var out = { value: a.value };
          if (a.detail) out.detail = a.detail;
          return { questionId: q.id, answer: out };
        });
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * candidate: before applying
   * ------------------------------------------------------------------ */

  var lastState = Object.create(null);         // jobId -> form state, so Back keeps answers

  function askQuestions(jobId, data, serverDetails) {
    return new Promise(function (resolve) {
      var job = null;
      try { job = DATA.jobById(jobId); } catch (e) {}
      var state = lastState[jobId] || { questions: data.questions, answers: {} };
      state.questions = data.questions;
      Object.keys(data.prefill || {}).forEach(function (k) { if (!state.answers[k]) state.answers[k] = data.prefill[k]; });
      lastState[jobId] = state;
      var el = overlay('tlsqApply',
        '<div class="tlsq-hd"><div style="flex:1"><h3>A few quick questions</h3>'
        + '<div class="sub">' + (job ? 'For ' + h(job.title) + ' · ' : '') + 'about a minute, then your application is sent</div></div>'
        + '<button class="tlsq-x" type="button" aria-label="Close" data-close>✕</button></div>'
        + '<div class="tlsq-bd" id="tlsqApplyForm"></div>'
        + '<div class="tlsq-ft"><label style="flex:1;min-width:220px;font-size:12.5px;color:#4b5565;display:flex;gap:7px;align-items:center">'
        + '<input type="checkbox" id="tlsqSave"' + (state.saveDefaults ? ' checked' : '') + '> Use these answers for my next applications</label>'
        + '<button class="btn btn-ghost" type="button" data-close>Back</button>'
        + '<button class="btn btn-primary" type="button" id="tlsqSubmit">Submit application</button></div>');
      var form = mountForm(el.querySelector('#tlsqApplyForm'), state);
      if (serverDetails) form.showServerErrors(serverDetails);
      el.addEventListener('click', function (e) {
        if (e.target.closest('[data-close]')) {
          state.saveDefaults = !!(document.getElementById('tlsqSave') || {}).checked;
          close('tlsqApply');
          resolve({ cancelled: true });
        }
      });
      el.querySelector('#tlsqSubmit').addEventListener('click', function () {
        if (!form.check()) { say('Please answer every question', '⚠️'); return; }
        state.saveDefaults = !!(document.getElementById('tlsqSave') || {}).checked;
        close('tlsqApply');
        resolve({ answers: form.payload(), saveDefaults: state.saveDefaults });
      });
    });
  }

  function beforeApply(jobId, serverDetails) {
    if (!jobId || isExternal(jobId) || role() !== 'candidate' || !api()) return Promise.resolve(null);
    return api().get('/jobs/' + encodeURIComponent(jobId) + '/screening-questions').then(function (data) {
      if (!data || !data.questions || !data.questions.length) return null;
      return askQuestions(jobId, data, serverDetails).then(function (out) {
        if (out && out.answers) pending[jobId] = { answers: out.answers, saveDefaults: out.saveDefaults, at: Date.now() };
        return out;
      });
    }, function () { return null; });   // questions could not be read: the server decides (pending + link)
  }

  function pendingFor(jobId) {
    var p = pending[jobId];
    if (p && Date.now() - p.at < PENDING_TTL) return p;
    delete pending[jobId];
    return null;
  }

  window.TLScreening = {
    /* Answers given a moment ago for this job (the Apply Now wrapper below
       asked first) are the answers: one-click apply calls this too, and
       must not put the same questions on screen a second time. */
    beforeApply: function (jobId) {
      var id = String(jobId || '');
      var p = pendingFor(id);
      if (p) return Promise.resolve({ answers: p.answers, saveDefaults: p.saveDefaults });
      return beforeApply(id);
    },
    pendingFor: pendingFor,
    open: openDetail,
    /* 0106: the application form (teamlink-walkin-jobs.js) asks the
       job's questions as a section of itself, with this same form and
       its same checks, instead of a second pop-up. */
    questionsFor: function (jobId) {
      if (!jobId || isExternal(jobId) || role() !== 'candidate' || !api()) return Promise.resolve(null);
      return api().get('/jobs/' + encodeURIComponent(jobId) + '/screening-questions').then(function (data) {
        return data && data.questions && data.questions.length ? data : null;
      }, function () { return null; });
    },
    mountForm: function (host, data, onChange) {
      css();
      var state = { questions: data.questions, answers: {} };
      Object.keys(data.prefill || {}).forEach(function (k) { state.answers[k] = data.prefill[k]; });
      return mountForm(host, state, onChange);
    },
  };

  /* Apply Now (and Easy Apply, which goes through it) asks first. */
  function wrapApply() {
    var prev = window.applyToJob;
    if (typeof prev !== 'function' || prev.__tlsq) return;
    var next = function (jobId) {
      var self = this; var args = arguments;
      if (role() !== 'candidate' || !jobId || isExternal(jobId)) return prev.apply(self, args);
      try {
        if (DATA.hasApplication && DATA.hasApplication(STATE.session.id, jobId)) return prev.apply(self, args);
      } catch (e) {}
      if (pendingFor(jobId)) return prev.apply(self, args);
      return beforeApply(jobId).then(function (out) {
        if (out && out.cancelled) { say('Application not sent - you can apply again at any time'); return undefined; }
        return prev.apply(self, args);
      });
    };
    next.__tlsq = true;
    window.applyToJob = next;
  }

  /* The answers ride on the application itself, so both are created in
     one transaction - whoever made the POST. */
  function wrapPost() {
    var a = api();
    if (!a || a.post.__tlsq) return;
    var prevPost = a.post;
    var post = function (path, body, opts) {
      var jobId = body && body.jobId;
      if (path === '/applications' && jobId && !body.answers && pendingFor(jobId)) {
        var p = pendingFor(jobId);
        body = Object.assign({}, body, { answers: p.answers, saveScreeningDefaults: !!p.saveDefaults });
        return prevPost.call(a, path, body, opts).then(function (res) {
          delete pending[jobId]; delete lastState[jobId];
          return res;
        }, function (err) {
          if (err && err.code === 'VALIDATION_FAILED' && err.details
              && Object.keys(err.details).some(function (k) { return k.indexOf('answers.') === 0; })) {
            delete pending[jobId];
            // Back on the questions, answers kept, the server's reasons shown.
            beforeApply(jobId, err.details).then(function (out) {
              if (out && out.answers && typeof window.applyToJob === 'function') window.applyToJob(jobId);
            });
            // The apply handler shows this message in its usual toast.
            var again = new Error('Please check your answers to the screening questions.');
            again.code = 'SCREENING_RETRY';
            throw again;
          }
          throw err;
        });
      }
      return prevPost.apply(a, arguments);
    };
    post.__tlsq = true;
    a.post = post;
  }

  /* ------------------------------------------------------------------ *
   * the no-password page: #/screening-answers/<token>
   * ------------------------------------------------------------------ */

  function linkToken() {
    var m = /^#\/screening-answers\/([A-Za-z0-9_.-]+)/.exec(location.hash || '');
    return m ? m[1] : null;
  }

  var linkState = null;
  function renderLinkPage() {
    var token = linkToken();
    var app = document.getElementById('app');
    if (!token || !app) return;
    css();
    if (!linkState || linkState.token !== token) {
      linkState = { token: token, loading: true };
      api().post('/screening/link/view', { token: token }).then(function (d) {
        linkState = { token: token, data: d, state: { questions: d.questions, answers: d.prefill || {} } };
        renderLinkPage();
      }, function (err) {
        linkState = { token: token, error: (err && err.message) || 'This link is not valid.' };
        renderLinkPage();
      });
    }
    var body;
    if (linkState.loading) body = '<div class="cp-card" style="padding:24px">Loading your questions…</div>';
    else if (linkState.error) {
      body = '<div class="cp-card" style="padding:24px;text-align:center"><div style="font-size:32px">🔗</div>'
        + '<h2 style="margin:8px 0">' + h(linkState.error) + '</h2>'
        + '<p style="color:#6b7a90">You can close this page.</p></div>';
    } else if (linkState.done) {
      body = '<div class="cp-card" style="padding:24px;text-align:center"><div style="font-size:34px">✅</div>'
        + '<h2 style="margin:8px 0">Thank you!</h2><p style="color:#4b5565">' + h(linkState.done) + '</p>'
        + '<p style="color:#6b7a90;font-size:13px">You can close this page.</p></div>';
    } else {
      var d = linkState.data;
      body = '<div class="cp-card" style="padding:0;overflow:hidden">'
        + '<div style="padding:18px 20px;border-bottom:1px solid #e8edf3"><h1 style="margin:0;font-size:20px">A few quick questions</h1>'
        + '<div style="color:#6b7a90;font-size:13px;margin-top:4px">' + (d.firstName ? 'Hi ' + h(d.firstName) + ' - ' : '')
        + 'about your application for <b>' + h(d.jobTitle) + '</b>' + (d.location ? ' · ' + h(d.location) : '') + '. No sign-in needed.</div></div>'
        + '<div style="padding:6px 20px" id="tlsqLinkForm"></div>'
        + '<div style="padding:12px 20px 18px;border-top:1px solid #e8edf3;display:flex;gap:10px;flex-wrap:wrap;align-items:center">'
        + '<label style="flex:1;min-width:200px;font-size:12.5px;color:#4b5565;display:flex;gap:7px;align-items:center"><input type="checkbox" id="tlsqLinkSave"> Use these answers for my next applications</label>'
        + '<button class="btn btn-primary" id="tlsqLinkSubmit">Send my answers</button></div></div>';
    }
    app.innerHTML = '<div class="tlsq-page"><div style="font-weight:800;color:#0f2540;font-size:18px;margin-bottom:12px">TeamLink</div>' + body + '</div>';
    if (linkState.data && !linkState.done && !linkState.error) {
      var form = mountForm(document.getElementById('tlsqLinkForm'), linkState.state, null, {
        /* No session here: the link token is what lets this page search places. */
        searchPlaces: function (q) {
          return api().post('/screening/link/places', { token: token, q: q, limit: 8 }).then(function (r) {
            return (r && r.results) || [];
          });
        },
      });
      document.getElementById('tlsqLinkSubmit').addEventListener('click', function () {
        if (!form.check()) { say('Please answer every question', '⚠️'); return; }
        var btn = this; btn.disabled = true;
        api().post('/screening/link/submit', { token: token, answers: form.payload(),
          saveDefaults: !!document.getElementById('tlsqLinkSave').checked }).then(function (r) {
          linkState.done = (r && r.message) || 'Your answers have been sent.';
          renderLinkPage();
        }, function (err) {
          btn.disabled = false;
          if (err && err.details) form.showServerErrors(err.details);
          say((err && err.message) || 'Could not send your answers', '⚠️');
        });
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * recruiter: the applications list
   * ------------------------------------------------------------------ */

  var summaries = Object.create(null);        // appId -> summary
  var fetchedAt = Object.create(null);
  var filters = { status: '', notice: '', ctc: '' };

  function appIdsIn(row) {
    var out = [];
    var html = row.innerHTML;
    var re = /'(app_[A-Za-z0-9_-]+)'/g; var m;
    while ((m = re.exec(html))) if (out.indexOf(m[1]) < 0) out.push(m[1]);
    if (!out.length && typeof DATA !== 'undefined' && DATA.applications) {
      var cand = /candidate-profile\?id=([A-Za-z0-9_-]+)/.exec(html);
      if (cand) {
        var apps = DATA.applications.filter(function (a) { return a.candidateId === cand[1]; });
        var cells = row.querySelectorAll('td');
        apps.forEach(function (a) {
          var j = DATA.jobById ? DATA.jobById(a.jobId) : null;
          if (j && Array.prototype.some.call(cells, function (td) { return td.textContent.indexOf(j.title) >= 0; })) out.push(a.id);
        });
      }
    }
    return out;
  }

  function onApplicationsScreen() {
    return /^#\/(recruiter|admin)\/applications\b/.test(location.hash || '');
  }

  function badgesFor(s) {
    if (!s) return '';
    var b = [];
    if (s.status === 'knocked_out') b.push('<span class="tlsq-b red" title="' + h((s.mustHaveFailed || []).join(' · ')) + '">⚠ Must-have not met</span>');
    else if (s.status === 'pending') b.push('<span class="tlsq-b grey" title="' + (s.linkSentAt ? 'Link sent ' + h(String(s.linkSentAt).slice(0, 10)) : 'Link not sent yet') + '">Answers pending</span>');
    else if (s.status === 'answered') b.push('<span class="tlsq-b ok">✓ Answers in</span>');
    if (s.combinedScore != null) b.push('<span class="tlsq-b info" title="Resume ' + h(s.aiScore) + '% · answers ' + h(s.answerScore == null ? '—' : s.answerScore + '%') + '">Combined ' + h(s.combinedScore) + '%</span>');
    var facts = [];
    if (s.notice) facts.push('Notice: ' + s.notice);
    if (s.expectedCtc != null) facts.push('Exp. CTC: ' + s.expectedCtc + ' LPA');
    if (s.relocate) facts.push('Relocate: ' + (s.relocate === 'yes' ? 'Yes' : 'No'));
    return '<div class="tlsq-badges" data-tlsq="1">' + b.join('') + '</div>'
      + (facts.length ? '<div data-tlsq="1" style="font-size:11px;color:#5b6678;margin-top:3px;white-space:nowrap">' + h(facts.join(' · ')) + '</div>' : '');
  }

  function passes(s) {
    if (!s) return !filters.status && !filters.notice && !filters.ctc;
    if (filters.status === 'knocked_out' && s.status !== 'knocked_out') return false;
    if (filters.status === 'met' && s.status !== 'answered') return false;
    if (filters.status === 'pending' && s.status !== 'pending') return false;
    if (filters.notice !== '' && !(s.noticeDays != null && s.noticeDays <= Number(filters.notice))) return false;
    if (filters.ctc !== '' && !(s.expectedCtc != null && s.expectedCtc <= Number(filters.ctc))) return false;
    return true;
  }

  function filterBar(table) {
    var host = table.closest('.panel') || table.parentNode;
    if (!host || host.querySelector('.tlsq-bar')) return;
    var bar = document.createElement('div');
    bar.className = 'tlsq-bar';
    bar.innerHTML = '<b>Screening</b>'
      + '<select data-f="status" aria-label="Screening answers"><option value="">All answers</option><option value="knocked_out">⚠ Must-have not met</option>'
      + '<option value="met">Must-haves met</option><option value="pending">Answers pending</option></select>'
      + '<label>Notice ≤ <select data-f="notice"><option value="">any</option><option value="0">Immediate</option><option value="15">15 days</option>'
      + '<option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option></select></label>'
      + '<label>Exp. CTC ≤ <input data-f="ctc" type="number" min="0" step="0.5" style="width:70px" placeholder="LPA"></label>'
      + '<span class="tlsq-hidden" style="color:#6b7a90"></span><span style="flex:1"></span>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-bulk="1">✉ Send screening questions</button>';
    var target = host.querySelector('.panel-body') || host;
    target.insertBefore(bar, target.firstChild);
    bar.addEventListener('change', function (e) {
      var k = e.target.getAttribute('data-f');
      if (k) { filters[k] = e.target.value; applyFilters(); }
    });
    bar.addEventListener('input', function (e) {
      if (e.target.getAttribute('data-f') === 'ctc') { filters.ctc = e.target.value; applyFilters(); }
    });
    bar.querySelector('[data-bulk]').addEventListener('click', bulkSend);
  }

  function applyFilters() {
    var hidden = 0;
    document.querySelectorAll('tr[data-tlsq-app]').forEach(function (tr) {
      var ids = tr.getAttribute('data-tlsq-app').split(',');
      var ok = ids.some(function (id) { return passes(summaries[id]); });
      tr.style.display = ok ? '' : 'none';
      if (!ok) hidden += 1;
    });
    document.querySelectorAll('.tlsq-bar .tlsq-hidden').forEach(function (s) {
      s.textContent = hidden ? hidden + ' hidden by these filters' : '';
    });
  }

  function bulkSend() {
    var ids = [];
    document.querySelectorAll('tr[data-tlsq-app]').forEach(function (tr) {
      var cb = tr.querySelector('input[type=checkbox]');
      if (cb && cb.checked && tr.style.display !== 'none') ids = ids.concat(tr.getAttribute('data-tlsq-app').split(','));
    });
    if (!ids.length) { say('Tick the candidates to send the questions to', '☑️'); return; }
    api().post('/screening/send', { applicationIds: ids }).then(function (r) {
      var skipped = r.results.filter(function (x) { return x.skipped; }).length;
      say('Screening questions sent to ' + r.sent + ' candidate' + (r.sent === 1 ? '' : 's')
        + (skipped ? ' · ' + skipped + ' skipped (already answered)' : ''), '✉️');
      refreshSummaries(ids, true);
    }, function (err) { say((err && err.message) || 'Could not send', '⚠️'); });
  }

  function refreshSummaries(ids, force) {
    var need = ids.filter(function (id) { return force || !fetchedAt[id] || Date.now() - fetchedAt[id] > 30000; });
    if (!need.length || !api()) return Promise.resolve();
    need.forEach(function (id) { fetchedAt[id] = Date.now(); });
    var chunks = [];
    for (var i = 0; i < need.length; i += 150) chunks.push(need.slice(i, i + 150));
    return Promise.all(chunks.map(function (c) {
      return api().get('/screening/applications?ids=' + encodeURIComponent(c.join(','))).then(function (r) {
        (r.applications || []).forEach(function (s) { summaries[s.applicationId] = s; });
      }, function () {});
    })).then(paintRows);
  }

  function paintRows() {
    document.querySelectorAll('tr[data-tlsq-app]').forEach(function (tr) {
      var ids = tr.getAttribute('data-tlsq-app').split(',');
      var s = summaries[ids[0]];
      var cell = tr.querySelector('td[data-l^="AI Match"]') || tr.querySelector('td:nth-child(5)');
      if (!cell) return;
      cell.querySelectorAll('[data-tlsq]').forEach(function (x) { x.remove(); });
      if (s) cell.insertAdjacentHTML('beforeend', badgesFor(s));
      var actions = tr.querySelector('td.row-actions');
      if (actions && !actions.querySelector('[data-tlsq-open]') && s && s.status !== 'not_required') {
        actions.insertAdjacentHTML('beforeend', '<button class="btn btn-ghost btn-sm" data-tlsq-open="' + h(ids[0]) + '" type="button">📋 Answers</button>');
      }
    });
    applyFilters();
  }

  function decorateApplications() {
    if (!onApplicationsScreen() || !api()) return;
    var tables = document.querySelectorAll('#app table.data');
    var all = [];
    tables.forEach(function (table) {
      var head = table.querySelector('thead');
      if (!head || !/AI Match/i.test(head.textContent) || !/Stage/i.test(head.textContent)) return;
      filterBar(table);
      table.querySelectorAll('tbody tr').forEach(function (tr) {
        if (tr.hasAttribute('data-tlsq-app')) { all = all.concat(tr.getAttribute('data-tlsq-app').split(',')); return; }
        var ids = appIdsIn(tr);
        if (!ids.length) return;
        tr.setAttribute('data-tlsq-app', ids.join(','));
        all = all.concat(ids);
      });
    });
    if (all.length) { paintRows(); refreshSummaries(all, false); }
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-tlsq-open]');
    if (b) { e.preventDefault(); e.stopPropagation(); openDetail(b.getAttribute('data-tlsq-open')); }
  }, true);

  /* ------------------------------------------------------------------ *
   * the answers panel
   * ------------------------------------------------------------------ */

  function answerText(a, type) {
    if (!a) return '—';
    var v = a.value;
    var s = Array.isArray(v) ? v.join(', ') : v === 'yes' ? 'Yes' : v === 'no' ? 'No' : String(v == null ? '' : v);
    if (a.unit && type === 'number') s += ' ' + a.unit;
    if (a.detail) s += ' (' + a.detail + ')';
    return s;
  }
  function when(t) { try { return new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

  function openDetail(appId) {
    if (!api()) return;
    var r = role();
    api().get('/screening/applications/' + encodeURIComponent(appId)).then(function (d) {
      var s = d.summary;
      var staff = !!s;
      var list = (d.answers || []).map(function (a) {
        return '<div class="tlsq-ans"><div>' + h(a.question) + '</div><div class="a">' + h(answerText(a.answer, a.type))
          + (staff && a.mustHaveNotMet ? ' <span class="tlsq-b red">⚠ Must-have not met</span>' : '') + '</div>'
          + (staff ? '<div class="w">' + h(a.answeredBy || (a.source === 'link' ? 'Answered by the candidate (link)' : a.source === 'ai_call' ? 'Answered on an AI call' : 'Answered by the candidate'))
            + ' · ' + h(when(a.answeredAt)) + '</div>' : '') + '</div>';
      }).join('');
      var scores = staff ? '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">'
        + '<span class="tlsq-b info">AI resume score ' + h(s.aiScore == null ? '—' : s.aiScore + '%') + '</span>'
        + '<span class="tlsq-b info">Answers ' + h(s.answerScore == null ? '—' : s.answerScore + '%') + '</span>'
        + '<span class="tlsq-b ' + (s.combinedScore == null ? 'grey' : 'ok') + '">' + (s.combinedScore == null ? 'Combined: answers pending' : 'Combined ' + h(s.combinedScore) + '%') + '</span>'
        + (s.status === 'knocked_out' ? '<span class="tlsq-b red">⚠ Must-have not met</span>' : '')
        + (s.status === 'pending' ? '<span class="tlsq-b grey">Answers pending' + (s.linkSentAt ? ' · link sent ' + h(when(s.linkSentAt)) : '') + (s.reminderSentAt ? ' · reminded' : '') + '</span>' : '')
        + '</div>' : '';
      var canWrite = r === 'recruiter' || r === 'admin';
      var el = overlay('tlsqDetail',
        '<div class="tlsq-hd"><div style="flex:1"><h3>Screening answers</h3><div class="sub">'
        + (staff ? 'Knock-outs never reject anybody automatically - you decide.' : 'As shared by TeamLink') + '</div></div>'
        + '<button class="tlsq-x" type="button" data-close>✕</button></div>'
        + '<div class="tlsq-bd">' + scores + (list || '<p style="color:#6b7a90">No answers yet.</p>') + '<div id="tlsqCall"></div></div>'
        + '<div class="tlsq-ft">' + (staff && canWrite
          ? '<button class="btn btn-ghost btn-sm" type="button" data-act="reopen">↺ Re-open answers (send a new link)</button>'
            + '<button class="btn btn-ghost btn-sm" type="button" data-act="call">📞 Answered on call</button>' : '')
        + '<button class="btn btn-primary btn-sm" type="button" data-close>Close</button></div>', true);
      el.addEventListener('click', function (e) {
        if (e.target.closest('[data-close]')) { close('tlsqDetail'); return; }
        var act = e.target.closest('[data-act]');
        if (!act) return;
        var a = act.getAttribute('data-act');
        if (a === 'reopen') {
          api().post('/screening/applications/' + encodeURIComponent(appId) + '/reopen', {}).then(function () {
            say('A new link was sent to the candidate', '✉️'); close('tlsqDetail'); refreshSummaries([appId], true);
          }, function (err) { say((err && err.message) || 'Could not send', '⚠️'); });
        }
        if (a === 'call') {
          var existing = {};
          (d.answers || []).forEach(function (x) { existing[x.questionId] = x.answer; });
          var state = { questions: d.questions || [], answers: existing };
          var host = document.getElementById('tlsqCall');
          host.innerHTML = '<div class="tlsq-warn">Type what the candidate told you on the phone. Saved as "Answered on call by you".</div><div id="tlsqCallForm"></div>'
            + '<div style="text-align:right;margin-top:8px"><button class="btn btn-primary btn-sm" type="button" id="tlsqCallSave">Save answers</button></div>';
          var form = mountForm(document.getElementById('tlsqCallForm'), state);
          document.getElementById('tlsqCallSave').addEventListener('click', function () {
            if (!form.check()) return;
            api().post('/screening/applications/' + encodeURIComponent(appId) + '/answers', { answers: form.payload() }).then(function () {
              say('Answers saved', '✅'); close('tlsqDetail'); refreshSummaries([appId], true);
            }, function (err) { if (err && err.details) form.showServerErrors(err.details); say((err && err.message) || 'Could not save', '⚠️'); });
          });
        }
      });
    }, function (err) { say((err && err.message) || 'Could not load the answers', '⚠️'); });
  }

  /* ------------------------------------------------------------------ *
   * recruiter: the question editor
   * ------------------------------------------------------------------ */

  var TYPE_LABEL = { yes_no: 'Yes / No', number: 'Number', single_choice: 'One choice', multi_choice: 'Several choices', short_text: 'Short text', date: 'Date' };
  var draft = null;          // AI Job Creation: questions for a job not saved yet

  function ruleText(q) {
    var r = q.knockoutRule || {};
    if (q.type === 'yes_no') return 'must be ' + (r.equals === 'no' ? 'No' : 'Yes');
    if (q.stdKey === 'notice_period' && (r.maxDays != null || r.max != null)) return 'notice ≤ ' + (r.maxDays != null ? r.maxDays : r.max) + ' days';
    if (q.type === 'number') return [r.min != null ? '≥ ' + r.min : '', r.max != null ? '≤ ' + r.max : ''].filter(Boolean).join(' and ') + (q.options && q.options.unit ? ' ' + q.options.unit : '');
    if (r.in) return 'one of: ' + r.in.join(', ');
    return 'rule set';
  }

  function ruleEditor(q, i) {
    var r = q.knockoutRule || {};
    if (q.type === 'yes_no') {
      return 'Must be <select data-rule="equals" data-i="' + i + '"><option value="yes"' + (r.equals !== 'no' ? ' selected' : '') + '>Yes</option><option value="no"' + (r.equals === 'no' ? ' selected' : '') + '>No</option></select>';
    }
    if (q.stdKey === 'notice_period') {
      var d = r.maxDays != null ? r.maxDays : (r.max != null ? r.max : 30);
      return 'Notice period ≤ <select data-rule="maxDays" data-i="' + i + '">' + [0, 15, 30, 60, 90].map(function (n) {
        return '<option value="' + n + '"' + (Number(d) === n ? ' selected' : '') + '>' + (n ? n + ' days' : 'Immediate') + '</option>'; }).join('') + '</select>';
    }
    if (q.type === 'number') {
      return '≥ <input data-rule="min" data-i="' + i + '" type="number" step="any" style="width:70px" value="' + h(r.min == null ? '' : r.min) + '"> '
        + '≤ <input data-rule="max" data-i="' + i + '" type="number" step="any" style="width:70px" value="' + h(r.max == null ? '' : r.max) + '"> ' + h((q.options && q.options.unit) || '');
    }
    if (q.type === 'single_choice' || q.type === 'multi_choice') {
      var allowed = r.in || [];
      return 'Allowed: ' + ((q.options && q.options.choices) || []).map(function (c) {
        return '<label style="margin-right:6px"><input type="checkbox" data-rule="in" data-i="' + i + '" value="' + h(c) + '"' + (allowed.indexOf(c) >= 0 ? ' checked' : '') + '> ' + h(c) + '</label>';
      }).join('');
    }
    return '<span style="color:#6b7a90">Text and date answers cannot be a must-have.</span>';
  }

  function openEditor(opts) {
    // opts: { jobId } for a saved job, or { draft: {title, skills, location} }
    css();
    var st = { questions: [], standard: [], suggestions: [], autoReject: false, editable: true, jobId: opts.jobId || null };
    var loads = [api().get('/screening/settings').then(function (s) { st.standard = s.standard || []; }, function () {})];
    if (opts.jobId) {
      loads.push(api().get('/jobs/' + encodeURIComponent(opts.jobId) + '/screening-questions').then(function (r) {
        st.questions = r.questions || []; st.editable = r.editable !== false; st.autoReject = !!r.autoRejectKnockouts;
      }));
      loads.push(api().post('/screening/suggestions', { jobId: opts.jobId }).then(function (r) { st.suggestions = r.suggestions || []; }, function () {}));
    } else {
      var d = opts.draft || {};
      loads.push(api().post('/screening/suggestions', { title: d.title, skills: d.skills, location: d.location }).then(function (r) { st.suggestions = r.suggestions || []; }, function () {}));
    }
    Promise.all(loads).then(function () {
      if (!opts.jobId) {
        st.questions = draft && draft.questions ? draft.questions : st.standard.filter(function (q) { return q.enabled; }).map(function (q) {
          var loc = (opts.draft && opts.draft.location) || 'the job location';
          return { stdKey: q.key, text: String(q.text).replace('{location}', loc).replace(' ({mode})', ''), type: q.type,
            options: q.options || {}, weight: q.weight, source: 'standard', shareWithClient: q.shareWithClient !== false };
        });
      }
      drawEditor(st, opts);
    }, function (err) { say((err && err.message) || 'Could not load the questions', '⚠️'); });
  }

  function drawEditor(st, opts) {
    var qs = st.questions;
    var ko = qs.filter(function (q) { return q.isKnockout; }).length;
    var warn = [];
    if (qs.length >= 6) warn.push('This job has ' + qs.length + ' of 6 questions. Too many questions lowers applications.');
    if (ko > 2) warn.push(ko + ' must-have questions: more than 2 knock-outs lowers applications.');
    var used = qs.map(function (q) { return q.stdKey; });
    var stdMissing = st.standard.filter(function (s) { return used.indexOf(s.key) < 0; });
    var sugg = st.suggestions.filter(function (s) { return !qs.some(function (q) { return q.text === s.text; }); });

    var rows = qs.map(function (q, i) {
      return '<div class="tlsq-row"><div>'
        + '<input class="tlsq-in" data-text="' + i + '" maxlength="200" value="' + h(q.text) + '"' + (st.editable ? '' : ' disabled') + '>'
        + '<div class="meta"><span class="tlsq-b grey">' + h(TYPE_LABEL[q.type] || q.type) + '</span>'
        + (q.stdKey ? '<span class="tlsq-b info">Standard</span>' : q.source === 'ai' ? '<span class="tlsq-b info">AI suggestion</span>' : '')
        + ((q.type === 'single_choice' || q.type === 'multi_choice') ? '<span>Choices: <input data-choices="' + i + '" value="' + h(((q.options || {}).choices || []).join(', ')) + '" style="width:220px"></span>' : '')
        + '<label>Weight <select data-weight="' + i + '">' + [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (n) { return '<option' + (Number(q.weight == null ? 5 : q.weight) === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label>'
        + (q.type !== 'short_text' && q.type !== 'date' ? '<label><input type="checkbox" data-ko="' + i + '"' + (q.isKnockout ? ' checked' : '') + '> Must-have</label>' : '')
        + (q.stdKey === 'other_consultancy' ? '<label><input type="checkbox" data-share="' + i + '"' + (q.shareWithClient ? ' checked' : '') + '> Share answer with client</label>' : '')
        + '</div>'
        + (q.isKnockout ? '<div class="meta" style="color:#b42318">' + ruleEditor(q, i) + '</div>' : '')
        + '</div><div class="tools">'
        + '<button type="button" data-up="' + i + '" title="Move up">↑</button><button type="button" data-down="' + i + '" title="Move down">↓</button>'
        + '<button type="button" data-del="' + i + '" title="Remove">✕</button></div></div>';
    }).join('');

    var addPanel = '<div style="margin-top:12px"><div style="font-weight:700;margin-bottom:6px">Add a question</div>'
      + (stdMissing.length ? '<div class="meta" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">' + stdMissing.map(function (s) {
        return '<button type="button" class="btn btn-ghost btn-sm" data-addstd="' + h(s.key) + '">+ ' + h(String(s.text).replace('{location}', 'job location').replace(' ({mode})', '')) + '</button>'; }).join('') + '</div>' : '')
      + (sugg.length ? '<div style="font-size:12px;color:#6b7a90;margin:6px 0 4px">✨ From the AI JD Generator</div><div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">' + sugg.map(function (s, k) {
        return '<button type="button" class="btn btn-ghost btn-sm" data-addsugg="' + k + '">+ ' + h(s.text) + '</button>'; }).join('') + '</div>' : '')
      + '<div style="display:flex;gap:6px;flex-wrap:wrap"><input class="tlsq-in" id="tlsqNewText" maxlength="200" placeholder="Your own question, e.g. AWS certified?" style="flex:1;min-width:200px">'
      + '<select id="tlsqNewType" class="tlsq-in" style="width:auto">' + Object.keys(TYPE_LABEL).map(function (t) { return '<option value="' + t + '">' + TYPE_LABEL[t] + '</option>'; }).join('') + '</select>'
      + '<button type="button" class="btn btn-ghost btn-sm" id="tlsqAddCustom">+ Add</button></div></div>';

    var el = overlay('tlsqEditor',
      '<div class="tlsq-hd"><div style="flex:1"><h3>Screening questions</h3><div class="sub">'
      + (opts.jobId ? 'Changes apply to new applications; answers already given keep their question.' : 'These are saved with the job when you publish it.')
      + ' Candidates never see a must-have rule, a weight or the company name.</div></div>'
      + '<button class="tlsq-x" type="button" data-close>✕</button></div>'
      + '<div class="tlsq-bd">' + (st.editable ? '' : '<div class="tlsq-warn">Only the recruiter who owns this job can change its questions.</div>')
      + warn.map(function (w) { return '<div class="tlsq-warn">⚠ ' + h(w) + '</div>'; }).join('')
      + (rows || '<p style="color:#6b7a90">No questions - candidates apply straight away.</p>')
      + (qs.length < 6 && st.editable ? addPanel : '<div style="font-size:12.5px;color:#6b7a90;margin-top:8px">Remove a question to add another (6 at most).</div>')
      + (opts.jobId ? '<label style="display:flex;gap:7px;align-items:center;margin-top:12px;font-size:12.5px"><input type="checkbox" id="tlsqAutoReject"' + (st.autoReject ? ' checked' : '') + '> Auto-reject must-have failures (the polite rejection goes after 24 hours; off by default)</label>' : '')
      + '<div class="tlsq-err" id="tlsqEdErr"></div></div>'
      + '<div class="tlsq-ft"><button class="btn btn-ghost" type="button" data-close>Cancel</button>'
      + (st.editable ? '<button class="btn btn-primary" type="button" id="tlsqEdSave">' + (opts.jobId ? 'Save questions' : 'Keep for this job') + '</button>' : '') + '</div>', true);

    function sync() {
      el.querySelectorAll('[data-text]').forEach(function (inp) { qs[+inp.getAttribute('data-text')].text = inp.value; });
      el.querySelectorAll('[data-weight]').forEach(function (s) { qs[+s.getAttribute('data-weight')].weight = Number(s.value); });
      el.querySelectorAll('[data-choices]').forEach(function (s) {
        var q = qs[+s.getAttribute('data-choices')];
        q.options = Object.assign({}, q.options, { choices: s.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean) });
      });
      el.querySelectorAll('[data-share]').forEach(function (s) { qs[+s.getAttribute('data-share')].shareWithClient = s.checked; });
      var rules = {};
      el.querySelectorAll('[data-rule]').forEach(function (r) {
        var i = +r.getAttribute('data-i'); var k = r.getAttribute('data-rule');
        rules[i] = rules[i] || {};
        if (k === 'in') { rules[i].in = rules[i].in || []; if (r.checked) rules[i].in.push(r.value); }
        else if (r.value !== '') rules[i][k] = k === 'equals' ? r.value : Number(r.value);
      });
      Object.keys(rules).forEach(function (i) { qs[i].knockoutRule = rules[i]; });
    }
    el.addEventListener('change', function (e) {
      var t = e.target;
      if (t.hasAttribute('data-ko')) {
        sync();
        var q = qs[+t.getAttribute('data-ko')];
        q.isKnockout = t.checked;
        if (t.checked && !q.knockoutRule) {
          q.knockoutRule = q.type === 'yes_no' ? { equals: 'yes' } : q.stdKey === 'notice_period' ? { maxDays: 30 }
            : q.type === 'number' ? (q.stdKey === 'expected_ctc' ? { max: 12 } : { min: 1 }) : { in: ((q.options || {}).choices || []).slice(0, 1) };
        }
        drawEditor(st, opts);
      }
    });
    el.addEventListener('click', function (e) {
      var t = e.target.closest('button, [data-close]');
      if (!t) return;
      if (t.hasAttribute('data-close')) { close('tlsqEditor'); return; }
      sync();
      var i;
      if (t.hasAttribute('data-up')) { i = +t.getAttribute('data-up'); if (i > 0) { var a = qs[i - 1]; qs[i - 1] = qs[i]; qs[i] = a; } return drawEditor(st, opts); }
      if (t.hasAttribute('data-down')) { i = +t.getAttribute('data-down'); if (i < qs.length - 1) { var b = qs[i + 1]; qs[i + 1] = qs[i]; qs[i] = b; } return drawEditor(st, opts); }
      if (t.hasAttribute('data-del')) { qs.splice(+t.getAttribute('data-del'), 1); return drawEditor(st, opts); }
      if (t.hasAttribute('data-addstd')) {
        var s = st.standard.filter(function (x) { return x.key === t.getAttribute('data-addstd'); })[0];
        if (s) qs.push({ stdKey: s.key, text: String(s.text).replace('{location}', 'the job location').replace(' ({mode})', ''), type: s.type, options: s.options || {}, weight: s.weight, source: 'standard', shareWithClient: s.shareWithClient !== false });
        return drawEditor(st, opts);
      }
      if (t.hasAttribute('data-addsugg')) {
        var g = sugg[+t.getAttribute('data-addsugg')];
        if (g) qs.push(Object.assign({}, g));
        return drawEditor(st, opts);
      }
      if (t.id === 'tlsqAddCustom') {
        var text = (document.getElementById('tlsqNewText') || {}).value || '';
        var type = (document.getElementById('tlsqNewType') || {}).value || 'yes_no';
        if (!text.trim()) return;
        var q2 = { text: text.trim(), type: type, options: {}, weight: 5, source: 'recruiter' };
        if (type === 'single_choice' || type === 'multi_choice') q2.options = { choices: ['Option 1', 'Option 2'] };
        if (type === 'number') q2.options = { min: 0, unit: 'years' };
        qs.push(q2);
        return drawEditor(st, opts);
      }
      if (t.id === 'tlsqEdSave') {
        if (!opts.jobId) {
          draft = { title: (opts.draft || {}).title || '', questions: qs, at: Date.now() };
          say('Screening questions kept - they are saved when the job is published', '✅');
          close('tlsqEditor');
          return;
        }
        var ar = document.getElementById('tlsqAutoReject');
        api().put('/jobs/' + encodeURIComponent(opts.jobId) + '/screening-questions', { questions: qs, autoRejectKnockouts: !!(ar && ar.checked) }).then(function (r) {
          say('Screening questions saved' + (r.warnings && r.warnings.length ? ' - ' + r.warnings[0] : ''), '✅');
          close('tlsqEditor');
          decorateJobButtons(true);
        }, function (err) {
          var box = document.getElementById('tlsqEdErr');
          var det = err && err.details ? Object.keys(err.details).map(function (k) {
            var m = /questions\.(\d+)/.exec(k); return (m ? 'Question ' + (Number(m[1]) + 1) + ': ' : '') + err.details[k];
          }).join(' · ') : '';
          if (box) box.textContent = ((err && err.message) || 'Could not save') + (det ? ' ' + det : '');
        });
      }
    });
  }

  /* A "Screening (n)" button beside every Edit on a job list. */
  var counts = Object.create(null);
  function decorateJobButtons(force) {
    var r = role();
    if (r !== 'recruiter' && r !== 'admin') return;
    var ids = [];
    document.querySelectorAll('button[onclick*="startEditJob("]').forEach(function (b) {
      var m = /startEditJob\('([^']+)'\)/.exec(b.getAttribute('onclick') || '');
      if (!m) return;
      var id = m[1];
      var next = b.nextElementSibling;
      if (next && next.hasAttribute('data-tlsq-job')) { ids.push(id); return; }
      b.insertAdjacentHTML('afterend', ' <button class="btn btn-ghost btn-sm" type="button" data-tlsq-job="' + h(id) + '">❓ Screening</button>');
      ids.push(id);
    });
    ids.forEach(function (id) {
      if (counts[id] != null && !force) return paintCount(id);
      counts[id] = counts[id] == null ? '…' : counts[id];
      api().get('/jobs/' + encodeURIComponent(id) + '/screening-questions').then(function (r) {
        counts[id] = (r.questions || []).length; paintCount(id);
      }, function () {});
    });
  }
  function paintCount(id) {
    document.querySelectorAll('[data-tlsq-job="' + id + '"]').forEach(function (b) {
      b.textContent = '❓ Screening' + (counts[id] !== '…' && counts[id] != null ? ' (' + counts[id] + ')' : '');
    });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-tlsq-job]');
    if (b) { e.preventDefault(); e.stopPropagation(); openEditor({ jobId: b.getAttribute('data-tlsq-job') }); }
    var d = e.target.closest && e.target.closest('[data-tlsq-draft]');
    if (d) {
      e.preventDefault();
      var v = function (id) { return ((document.getElementById(id) || {}).value || '').trim(); };
      openEditor({ draft: { title: v('njTitle'), location: v('njLoc'), skills: v('njReqs').split(/,|\n/).map(function (s) { return s.trim(); }).filter(Boolean) } });
    }
  }, true);

  /* AI Job Creation: questions chosen before the job exists. */
  function decorateJobForm() {
    var reqs = document.getElementById('njReqs');
    if (!reqs || document.getElementById('tlsqDraftBtn')) return;
    var holder = reqs.closest('.fgroup') || reqs.parentNode;
    holder.insertAdjacentHTML('afterend', '<div class="fgroup" id="tlsqDraftBtn"><label>Screening questions</label>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-tlsq-draft="1">❓ Choose screening questions</button>'
      + '<div style="font-size:11.5px;color:var(--text-soft,#6b7a90);margin-top:4px">' + (draft ? h(draft.questions.length + ' chosen - saved with the job') : 'Notice period, CTC, location and relocation are added by default; add AI suggestions or your own.') + '</div></div>');
  }

  /* A job created through the API picks up the draft, matched on its title. */
  function wrapJobPost() {
    var a = api();
    if (!a || a.post.__tlsqJobs) return;
    var prev = a.post;
    var post = function (path, body) {
      var out = prev.apply(a, arguments);
      if (path === '/jobs' && draft && body && draft.title && String(body.title || '').trim() === draft.title
          && Date.now() - draft.at < 30 * 60 * 1000) {
        var mine = draft;
        out.then(function (res) {
          var id = res && res.job && res.job.id;
          if (!id || draft !== mine) return;
          draft = null;
          a.put('/jobs/' + encodeURIComponent(id) + '/screening-questions', { questions: mine.questions }).then(function () {
            say('Screening questions saved with the job', '✅');
          }, function (err) { say('The job was published, but its screening questions were not saved: ' + ((err && err.message) || ''), '⚠️'); });
        }, function () {});
      }
      return out;
    };
    post.__tlsqJobs = true; post.__tlsq = a.post.__tlsq;
    a.post = post;
  }

  /* ------------------------------------------------------------------ *
   * client: answers on a shortlisted candidate
   * ------------------------------------------------------------------ */
  function decorateClient() {
    if (role() !== 'client' || typeof DATA === 'undefined') return;
    document.querySelectorAll('button[onclick*="clientDecision("]').forEach(function (b) {
      var m = /clientDecision\('([^']+)'/.exec(b.getAttribute('onclick') || '');
      if (!m) return;
      var wrap = b.parentNode;
      if (!wrap || wrap.querySelector('[data-tlsq-open]')) return;
      var apps = (DATA.applications || []).filter(function (a) { return a.candidateId === m[1]; });
      if (!apps.length) return;
      wrap.insertAdjacentHTML('beforeend', '<button class="btn btn-ghost btn-sm" type="button" data-tlsq-open="' + h(apps[apps.length - 1].id) + '">📋 Screening answers</button>');
    });
  }

  /* ------------------------------------------------------------------ *
   * admin: AI Settings
   * ------------------------------------------------------------------ */
  function decorateAdmin() {
    if (role() !== 'admin' || !/^#\/admin\/ai-settings/.test(location.hash || '')) return;
    var app = document.getElementById('app');
    if (!app || document.getElementById('tlsqAdmin')) return;
    var host = app.querySelector('.two-col');
    if (!host) return;
    var panel = document.createElement('div');
    panel.className = 'panel';
    panel.id = 'tlsqAdmin';
    panel.style.marginTop = '16px';
    panel.innerHTML = '<div class="panel-head"><div><h2>Screening questions</h2><div class="desc">The standard questions every new job gets, and how much the answers count in the AI score.</div></div></div><div class="panel-body">Loading…</div>';
    host.parentNode.insertBefore(panel, host.nextSibling);
    api().get('/screening/settings').then(function (s) {
      var body = panel.querySelector('.panel-body');
      body.innerHTML = '<div class="fgroup"><label>Screening answers weight: <span class="mono" id="tlsqW">' + h(s.answerWeight) + '%</span></label>'
        + '<input type="range" min="0" max="60" value="' + h(s.answerWeight) + '" id="tlsqWeight" oninput="document.getElementById(\'tlsqW\').textContent=this.value+\'%\'">'
        + '<div style="font-size:11.5px;color:var(--text-soft)">The resume weights (skills, experience, education, location) scale to fill the rest.</div></div>'
        + (s.standard || []).map(function (q, i) {
          return '<div style="display:flex;gap:8px;align-items:center;border:1px solid var(--line,#e4eaf2);border-radius:8px;padding:8px 10px;margin-bottom:6px">'
            + '<input type="checkbox" data-std-on="' + i + '"' + (q.enabled ? ' checked' : '') + ' title="Added to new jobs">'
            + '<input class="tlsq-in" data-std-text="' + i + '" value="' + h(q.text) + '" maxlength="200" style="flex:1">'
            + '<label style="font-size:12px;white-space:nowrap">Weight <select data-std-w="' + i + '">' + [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (n) { return '<option' + (q.weight === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label></div>';
        }).join('')
        + '<div style="font-size:11.5px;color:var(--text-soft);margin:4px 0 10px">{location} and {mode} are filled in from each job. Never name a client: candidates see these.</div>'
        + '<label style="display:flex;gap:8px;align-items:flex-start;border:1px solid var(--line,#e4eaf2);border-radius:8px;padding:10px;margin:0 0 12px;font-size:13px">'
        + '<input type="checkbox" id="tlsqAiCalls"' + (s.askOnAiCalls ? ' checked' : '') + ' style="margin-top:2px">'
        + '<span><b>AI calls ask the pending screening questions</b><br><span style="font-size:11.5px;color:var(--text-soft)">'
        + 'Only when AI calling is set up. When the AI calling agent is already calling a candidate about a job, it also asks that application\'s unanswered questions; '
        + 'answers are saved as "Answered on an AI call" with the same checks as the form. It never changes who is called or when.</span></span></label>'
        + '<button class="btn btn-primary btn-sm" type="button" id="tlsqAdminSave">Save screening settings</button>';
      body.querySelector('#tlsqAdminSave').addEventListener('click', function () {
        var std = (s.standard || []).map(function (q, i) {
          return Object.assign({}, q, {
            enabled: body.querySelector('[data-std-on="' + i + '"]').checked,
            text: body.querySelector('[data-std-text="' + i + '"]').value.trim(),
            weight: Number(body.querySelector('[data-std-w="' + i + '"]').value),
          });
        });
        api().put('/screening/settings', { standard: std, answerWeight: Number(body.querySelector('#tlsqWeight').value),
          askOnAiCalls: !!body.querySelector('#tlsqAiCalls').checked }).then(function () {
          say('Screening settings saved', '✅');
        }, function (err) { say((err && err.message) || 'Could not save', '⚠️'); });
      });
    }, function () { panel.querySelector('.panel-body').textContent = 'Could not load the screening settings.'; });
  }

  /* ------------------------------------------------------------------ *
   * keeping up with the page
   * ------------------------------------------------------------------ */
  function sweep() {
    if (linkToken()) return;
    css();
    decorateApplications();
    decorateJobButtons(false);
    decorateJobForm();
    decorateClient();
    decorateAdmin();
  }
  var queued = false;
  function queue() {
    if (queued) return;
    queued = true;
    setTimeout(function () { queued = false; try { sweep(); } catch (e) { if (window.console) console.warn('[screening]', e && e.message); } }, 120);
  }

  function install() {
    wrapApply(); wrapPost(); wrapJobPost();
    var prev = window.render;
    if (typeof prev === 'function' && !prev.__tlsq) {
      var next = function () {
        var out = prev.apply(this, arguments);
        try { if (linkToken()) renderLinkPage(); else queue(); } catch (e) {}
        return out;
      };
      next.__tlsq = true;
      window.render = next;
    }
    try { new MutationObserver(queue).observe(document.getElementById('app') || document.body, { childList: true, subtree: true }); } catch (e) {}
    window.addEventListener('hashchange', function () { if (linkToken()) renderLinkPage(); });
    if (linkToken()) {
      var tries = 0;
      (function wait() {
        if ((window.TL && TL.api) || ++tries > 80) { if (window.TL && TL.api) renderLinkPage(); return; }
        setTimeout(wait, 150);
      })();
    }
    queue();
  }
  if (document.readyState === 'complete') install();
  else window.addEventListener('load', install);
})();
