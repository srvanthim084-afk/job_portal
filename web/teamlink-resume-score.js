/*
 * TeamLink — Resume score + improvement tips.
 *
 * The score is worked out on the server (api/src/resume/score.js) from the
 * saved profile and the resume text; this file only shows it.
 *
 * Candidate
 *   - #/candidate/resume-score: a 0-100 ring with its label, the eight
 *     sections as bars, up to five tips (each with the points it adds and
 *     a "Fix now" button that opens that exact field), AI tips labelled
 *     as AI when they exist, "Re-score", "+12 since last week" /
 *     "Score improved from 62 to 78", and the history
 *   - a compact card on Profile (beside Profile completion, which is the
 *     same record measured differently) and on Resume
 *   - after a resume upload: "Your resume scored 68/100. Here is how to
 *     improve it" - optional, Continue / Later, never in the way
 *   - before applying with a score under 60: "Improve your profile to get
 *     more calls" [Improve] [Apply anyway] - never blocks
 *
 * Recruiter
 *   - a score badge beside candidate names (profile, Talent Pool, Find
 *     Candidates, Applications)
 *   - a "Resume score 70+" filter on Talent Pool and Find Candidates,
 *     applied by the server (resumeScoreMin)
 *
 * window.TLResumeScore.get() returns the latest score object (or null
 * until it has loaded); .load() returns a promise of it.
 */
(function () {
  'use strict';

  var S = { score: null, sinceLastWeek: null, ai: null, loading: null, at: 0, err: '', busy: false,
    improvement: null, history: null, engineNote: '' };
  var LOW = 60;

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
  var say = function (m, i) { if (typeof window.toast === 'function') toast(m, i || '📈'); };
  var me = function () { return isCand() && window.DATA && DATA.candidateById ? DATA.candidateById(STATE.session.id) : null; };
  var COLOR = { 'Needs Work': '#d1435b', Good: '#e08a1e', Strong: '#12a15b', Excellent: '#0f7a44' };

  /* ------------------------------------------------------------------ *
   * styles
   * ------------------------------------------------------------------ */
  var css = ''
    + '.tlrs-card{background:#fff;border:1px solid #e6ebf2;border-radius:14px;box-shadow:0 2px 10px rgba(16,30,54,.05);padding:16px;margin-bottom:14px}'
    + '.tlrs-top{display:flex;gap:18px;align-items:center;flex-wrap:wrap}'
    + '.tlrs-ring{position:relative;flex:0 0 auto}.tlrs-ring .n{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}'
    + '.tlrs-ring .n b{font-size:26px;font-weight:800;color:#16202c;line-height:1}.tlrs-ring .n span{font-size:11px;color:#8a94a6}'
    + '.tlrs-lbl{display:inline-block;font-size:12px;font-weight:800;border-radius:999px;padding:3px 10px;color:#fff}'
    + '.tlrs-sec{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px 22px;font-size:12.5px;color:#26313f;margin-top:14px}'
    + '.tlrs-srow .t{display:flex;justify-content:space-between;gap:8px;margin-bottom:4px}'
    + '.tlrs-sec .bar{height:8px;border-radius:6px;background:#eef1f5;overflow:hidden}.tlrs-sec .bar i{display:block;height:100%;border-radius:6px;background:#1d6ff2}'
    + '.tlrs-sec .v{font-weight:800;font-size:12px;color:#42505f;white-space:nowrap}'
    + '.tlrs-tips{display:grid;gap:10px;margin-top:6px}'
    + '.tlrs-tip{border:1px solid #e6ebf2;border-radius:12px;padding:12px 14px;display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;background:#fff}'
    + '.tlrs-tip .body{flex:1;min-width:200px}.tlrs-tip .iss{font-size:13px;font-weight:800;color:#16202c}'
    + '.tlrs-tip .fix{font-size:12.5px;color:#42505f;margin-top:3px;line-height:1.5}'
    + '.tlrs-pri{font-size:10.5px;font-weight:800;border-radius:6px;padding:2px 7px;margin-right:6px;text-transform:uppercase;letter-spacing:.03em}'
    + '.tlrs-pri.High{background:#fdecee;color:#b4292b}.tlrs-pri.Medium{background:#fff4e5;color:#b5620a}.tlrs-pri.Low{background:#eef4fb;color:#2b5f9e}'
    + '.tlrs-ai{font-size:10.5px;font-weight:800;border-radius:6px;padding:2px 7px;background:#f1ecff;color:#5b3fc4;margin-right:6px}'
    + '.tlrs-gain{font-size:11.5px;font-weight:800;color:#0f7a44;white-space:nowrap}'
    + '.tlrs-msg{border-radius:12px;padding:11px 14px;font-size:13px;margin:10px 0}'
    + '.tlrs-msg.good{background:#e8f6ee;color:#0f5f37}.tlrs-msg.warn{background:#fff4e5;color:#8a4b06}'
    + '.tlrs-mini{display:flex;gap:14px;align-items:center;flex-wrap:wrap}'
    + '.tlrs-badge{display:inline-flex;align-self:flex-start;width:max-content;align-items:center;gap:4px;font-size:10.5px;font-weight:800;border-radius:999px;padding:2px 8px;margin-left:6px;vertical-align:middle;white-space:nowrap;border:1px solid transparent}'
    + '.tlrs-badge.hi{background:#e8f6ee;color:#0f7a44;border-color:#c9ead6}.tlrs-badge.mid{background:#fff4e5;color:#a35a07;border-color:#f6dfbd}'
    + '.tlrs-badge.lo{background:#fdecee;color:#b4292b;border-color:#f5cfd3}.tlrs-badge.na{background:#f1f3f6;color:#6b7a90}'
    + '.tlrs-float{position:fixed;right:16px;bottom:16px;z-index:9000;max-width:360px;width:calc(100% - 32px);background:#fff;border:1px solid #dbe7fb;border-radius:14px;box-shadow:0 12px 40px rgba(16,30,54,.18);padding:14px 16px}'
    + '.tlrs-hist{display:flex;align-items:flex-end;gap:4px;height:46px;margin-top:8px}.tlrs-hist i{flex:1;background:#cfe0fb;border-radius:3px 3px 0 0;min-height:2px;max-width:22px}'
    + '.tlrs-hist i:last-child{background:#1d6ff2}'
    + '.tlrs-flt{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:700;color:#26313f;cursor:pointer;white-space:nowrap}'
    + '.tlrs-flt input{width:15px;height:15px;accent-color:#1d6ff2}'
    + '';
  function addCss() {
    if (document.getElementById('tlrsCss')) return;
    var st = document.createElement('style'); st.id = 'tlrsCss'; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ------------------------------------------------------------------ *
   * data
   * ------------------------------------------------------------------ */
  function take(out) {
    S.score = out.score || null;
    if (out.sinceLastWeek !== undefined) S.sinceLastWeek = out.sinceLastWeek;
    if (out.ai) S.ai = out.ai;
    S.at = Date.now(); S.err = '';
  }
  function load(force) {
    if (!isCand() || !api()) return Promise.resolve(null);
    if (S.loading) return S.loading;
    if (!force && S.score && Date.now() - S.at < 30000) return Promise.resolve(S.score);
    S.loading = api().get('/candidate/resume/score').then(function (out) {
      take(out); S.loading = null; rerender(); return S.score;
    }).catch(function (e) {
      S.loading = null; S.at = Date.now(); S.err = (e && e.message) || 'Your score could not be worked out just now.'; rerender(); return null;
    });
    return S.loading;
  }
  function loadHistory() {
    if (!isCand() || !api()) return;
    api().get('/candidate/resume/score/history').then(function (out) {
      S.history = out.history || []; rerender();
    }).catch(function () { S.history = []; });
  }

  window.tlrsRescore = function () {
    if (S.busy || !api()) return;
    S.busy = true; S.improvement = null; rerender();
    var lang = 'en';
    try { var l = (navigator.language || '').toLowerCase(); if (l.indexOf('te') === 0) lang = 'te'; else if (l.indexOf('hi') === 0) lang = 'hi'; } catch (e) { /* en */ }
    api().post('/candidate/resume/score', { lang: lang }).then(function (out) {
      S.busy = false; take(out);
      S.improvement = out.improvement || null;
      S.engineNote = out.engine === 'ai' ? '' : (out.aiReason && S.ai && S.ai.configured ? 'AI tips are not available right now, so these tips come from our rules.' : '');
      S.history = null;
      if (out.improvement && out.improvement.to > out.improvement.from) say('Score improved from ' + out.improvement.from + ' to ' + out.improvement.to + ' — great work!', '🎉');
      else say('Your score is up to date', '📈');
      rerender();
    }).catch(function (e) {
      S.busy = false; say((e && e.message) || 'The score could not be worked out. Please try again.', '⚠️'); rerender();
    });
  };

  /* ------------------------------------------------------------------ *
   * "Fix now": the exact field
   * ------------------------------------------------------------------ */
  var CAP = { basic: 1, summary: 1, education: 1, skills: 1, languages: 1, certifications: 1, employment: 1 };
  var TLPS = { projects: 1, internships: 1, achievements: 1, links: 1, availability: 1, additional: 1 };
  window.tlrsFix = function (field) {
    if (typeof window.fcrCloseModal === 'function') try { fcrCloseModal(); } catch (e) { /* none open */ }
    closeFloat();
    if (field === 'resume') { location.hash = '#/candidate/resume'; return; }
    if (field === 'career') {
      if (typeof window.tlGoCareerPrefs === 'function') tlGoCareerPrefs(); else location.hash = '#/candidate/profile';
      return;
    }
    if (location.hash.indexOf('#/candidate/profile') !== 0) location.hash = '#/candidate/profile';
    setTimeout(function () {
      if (TLPS[field] && typeof window.tlpsEdit === 'function') {
        if (!(STATE.tlps && STATE.tlps.open === field)) tlpsEdit(field);
      } else if (CAP[field] && typeof window.capEditOpen === 'function') capEditOpen(field);
      setTimeout(function () {
        var el = document.querySelector('[data-tlps="' + field + '"]') || document.querySelector('.cap-card .cpe-form');
        if (el) {
          var card = el.closest ? (el.closest('.cap-card') || el) : el;
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          var first = card.querySelector('input,textarea,select'); if (first) try { first.focus({ preventScroll: true }); } catch (e) { /* */ }
        }
      }, 150);
    }, 220);
  };

  /* ------------------------------------------------------------------ *
   * pieces
   * ------------------------------------------------------------------ */
  function ring(total, label, size) {
    size = size || 120;
    var r = size / 2 - 8, c = 2 * Math.PI * r, col = COLOR[label] || '#1d6ff2';
    return '<div class="tlrs-ring" style="width:' + size + 'px;height:' + size + 'px" role="img" aria-label="Resume score ' + total + ' out of 100, ' + h(label) + '">'
      + '<svg width="' + size + '" height="' + size + '"><circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="#eef1f5" stroke-width="9"></circle>'
      + '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="9" stroke-linecap="round" '
      + 'stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + (c * (1 - total / 100)).toFixed(1) + '" transform="rotate(-90 ' + size / 2 + ' ' + size / 2 + ')"></circle></svg>'
      + '<div class="n"><b>' + total + '</b><span>/ 100</span></div></div>';
  }
  function labelPill(label) {
    return '<span class="tlrs-lbl" style="background:' + (COLOR[label] || '#1d6ff2') + '">' + h(label) + '</span>';
  }
  function tipHtml(t, compact) {
    var btnLabel = t.field === 'resume' ? 'Upload resume' : 'Fix now';
    return '<div class="tlrs-tip">'
      + '<div class="body"><div class="iss">' + (t.source === 'ai' ? '<span class="tlrs-ai" title="Suggested by AI from your resume text">AI</span>' : '')
      + '<span class="tlrs-pri ' + h(t.priority) + '">' + h(t.priority) + '</span>' + h(t.issue) + '</div>'
      + '<div class="fix">' + h(t.fix) + '</div></div>'
      + '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px"><span class="tlrs-gain">+' + h(t.gain) + ' points</span>'
      + (t.field ? '<button class="cp-btn pri" style="padding:6px 12px" onclick="tlrsFix(\'' + h(t.field) + '\')">' + btnLabel + '</button>' : '')
      + '</div></div>';
  }
  function progressLine() {
    if (S.improvement && S.improvement.to > S.improvement.from) {
      return '<div class="tlrs-msg good">🎉 Score improved from <b>' + S.improvement.from + '</b> to <b>' + S.improvement.to + '</b>. Every change you make shows recruiters a stronger profile.</div>';
    }
    if (S.sinceLastWeek > 0) return '<div class="tlrs-msg good">📈 <b>+' + S.sinceLastWeek + '</b> since last week — nice progress.</div>';
    var p = S.score && S.score.previous;
    if (p && S.score.total > p.total) return '<div class="tlrs-msg good">📈 Up from ' + p.total + ' to ' + S.score.total + '.</div>';
    return '';
  }
  function completionLine() {
    var c = me();
    if (!c || typeof window.capCompletion !== 'function') return '';
    return '<div style="font-size:12px;color:#7b8794;margin-top:6px">Profile completion <b>' + capCompletion(c) + '%</b> counts the sections you have filled in; '
      + 'the resume score also checks how well they are written.</div>';
  }

  function fullHtml() {
    addCss();
    var head = '<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:14px">'
      + '<div><h1 style="margin:0;font-size:21px;font-weight:800;color:#16202c">📈 Resume score</h1>'
      + '<p style="margin:3px 0 0;font-size:12.5px;color:#7b8794">How strong your resume and profile look to a recruiter, and what to improve first. It never stops you applying.</p></div>'
      + '<button class="cp-btn pri" ' + (S.busy ? 'disabled' : 'onclick="tlrsRescore()"') + '>' + (S.busy ? 'Scoring…' : '↻ Re-score') + '</button></div>';
    var s = S.score;
    if (!s) {
      if (!S.loading && !S.err) load(true);
      return head + '<div class="tlrs-card" style="text-align:center;color:#7b8794;padding:30px">'
        + (S.err ? '⚠️ ' + h(S.err) + ' <button class="cp-btn" onclick="tlrsRetry()">Try again</button>' : '⏳ Reading your resume and profile…') + '</div>';
    }
    if (s.status === 'unreadable') {
      return head + '<div class="tlrs-card"><div class="tlrs-msg warn" style="margin:0 0 10px">📄 <b>' + h(s.message) + '</b></div>'
        + '<p style="font-size:13px;color:#42505f;margin:0 0 12px">A scanned photo or an image-only PDF has no text we can read. Upload a PDF or Word file saved from your computer, and your score appears here.</p>'
        + '<button class="cp-btn pri" onclick="location.hash=\'#/candidate/resume\'">Upload a PDF or DOCX</button></div>';
    }
    if (!S.history) loadHistory();
    var top = '<div class="tlrs-card"><div class="tlrs-top">' + ring(s.total, s.label, 128)
      + '<div style="flex:1;min-width:200px"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' + labelPill(s.label)
      + '<span style="font-size:12px;color:#8a94a6">Updated ' + h(s.scoredAt ? new Date(s.scoredAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '') + '</span></div>'
      + progressLine()
      + '<div style="font-size:12.5px;color:#42505f;margin-top:6px">' + encouragement(s) + '</div>'
      + completionLine() + '</div></div>'
      + '<div class="tlrs-sec">' + s.sections.map(function (x) {
        var pct = x.max ? Math.round((x.score / x.max) * 100) : 0;
        return '<div class="tlrs-srow"><div class="t"><span>' + h(x.label) + '</span><b class="v">' + x.score + ' / ' + x.max + '</b></div>'
          + '<div class="bar" role="img" aria-label="' + h(x.label) + ' ' + x.score + ' of ' + x.max + '"><i style="width:' + pct + '%;background:'
          + (pct >= 75 ? '#12a15b' : pct >= 50 ? '#e08a1e' : '#d1435b') + '"></i></div></div>';
      }).join('') + '</div></div>';
    var tips = s.tips || [];
    var ai = s.aiTips || [];
    var tipsHtml = '<div class="cp-h2" style="margin:6px 0 8px"><h2 style="font-size:16px">Improvement tips</h2>'
      + '<span style="font-size:11.5px;color:#8a94a6">' + (tips.length ? 'Highest priority first' : '') + '</span></div>'
      + (S.engineNote ? '<div class="tlrs-msg warn" style="margin-top:0">' + h(S.engineNote) + '</div>' : '')
      + (tips.length ? '<div class="tlrs-tips">' + tips.map(function (t) { return tipHtml(t); }).join('') + '</div>'
        : '<div class="tlrs-card" style="text-align:center;color:#0f7a44">✨ Nothing to fix right now — your resume covers everything we check.</div>')
      + (s.moreTips ? '<div style="font-size:12px;color:#8a94a6;margin-top:6px">' + s.moreTips + ' more tip' + (s.moreTips === 1 ? '' : 's') + ' will show once you have done these.</div>' : '')
      + (ai.length ? '<div class="cp-h2" style="margin:16px 0 8px"><h2 style="font-size:16px">From AI, reading your resume</h2></div>'
        + '<div class="tlrs-tips">' + ai.map(function (t) { return tipHtml(t); }).join('') + '</div>' : '');
    var hist = (S.history || []).filter(function (x) { return x.status === 'scored'; }).slice(0, 12).reverse();
    var histHtml = hist.length > 1 ? '<div class="tlrs-card" style="margin-top:14px"><b style="font-size:13.5px">Your score over time</b>'
      + '<div class="tlrs-hist" role="img" aria-label="Score history: ' + hist.map(function (x) { return x.total; }).join(', ') + '">'
      + hist.map(function (x) { return '<i title="' + x.total + ' on ' + h(new Date(x.scoredAt).toLocaleDateString('en-IN')) + '" style="height:' + Math.max(4, x.total) + '%"></i>'; }).join('')
      + '</div><div style="font-size:11.5px;color:#8a94a6;margin-top:4px">From ' + hist[0].total + ' to ' + hist[hist.length - 1].total + ' over ' + hist.length + ' scorings</div></div>' : '';
    return head + top + tipsHtml + histHtml;
  }
  window.tlrsRetry = function () { S.err = ''; load(true); };

  function encouragement(s) {
    if (s.label === 'Excellent') return 'Excellent — your resume is in great shape. Keep it current as you gain experience.';
    if (s.label === 'Strong') return 'Strong resume. A couple of small changes below can make it excellent.';
    if (s.label === 'Good') return 'A good start. The tips below are the quickest way to more recruiter calls.';
    return 'Every resume starts somewhere — the tips below add the most points first.';
  }

  /** The compact card for Profile and Resume. */
  function miniHtml() {
    addCss();
    var s = S.score;
    if (!s) {
      if (!S.loading && !S.err) load();
      return '<div class="tlrs-card" id="tlrsMini" style="color:#7b8794;font-size:13px">' + (S.err ? '⚠️ Your resume score could not be loaded.' : '⏳ Working out your resume score…') + '</div>';
    }
    if (s.status === 'unreadable') {
      return '<div class="tlrs-card" id="tlrsMini"><div class="tlrs-mini"><span style="font-size:24px">📄</span><div style="flex:1;min-width:200px">'
        + '<b style="font-size:14px">' + h(s.message) + '</b><div style="font-size:12px;color:#7b8794">Your score appears once we can read it.</div></div>'
        + '<button class="cp-btn pri" onclick="location.hash=\'#/candidate/resume\'">Upload again</button></div></div>';
    }
    var t = (s.tips || []).slice(0, 2);
    return '<div class="tlrs-card" id="tlrsMini"><div class="tlrs-mini">' + ring(s.total, s.label, 84)
      + '<div style="flex:1;min-width:200px"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b style="font-size:15px">Resume score</b>' + labelPill(s.label)
      + (S.sinceLastWeek > 0 ? '<span class="tlrs-gain">+' + S.sinceLastWeek + ' since last week</span>' : '') + '</div>'
      + (t.length ? '<div style="font-size:12.5px;color:#42505f;margin-top:5px">Next: ' + h(t[0].fix) + ' <b class="tlrs-gain">+' + t[0].gain + '</b></div>' : '')
      + completionLine() + '</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap">' + (t.length ? '<button class="cp-btn pri" onclick="tlrsFix(\'' + h(t[0].field) + '\')">' + (t[0].field === 'resume' ? 'Upload resume' : 'Fix now') + '</button>' : '')
      + '<button class="cp-btn" onclick="location.hash=\'#/candidate/resume-score\'">See all tips</button></div></div></div>';
  }

  /* ------------------------------------------------------------------ *
   * placing it
   * ------------------------------------------------------------------ */
  function wrapPage() {
    var prev = window.pageCandidateDash;
    if (typeof prev !== 'function' || prev.__tlrs) return;
    var next = function (section) {
      if (section === 'resume-score' && isCand()) {
        var html = fullHtml();
        return typeof window.cpShell === 'function' ? cpShell('resume-score', html) : html;
      }
      return prev.apply(this, arguments);
    };
    next.__tlrs = true;
    window.pageCandidateDash = next;
  }

  function placeMini() {
    if (!isCand()) return;
    var hash = location.hash || '';
    var onProfile = hash.indexOf('#/candidate/profile') === 0;
    var onResume = /^#\/candidate\/resume(\?|$)/.test(hash);
    if (!onProfile && !onResume) return;
    if (document.getElementById('tlrsMini')) return;
    var html = miniHtml();
    if (onProfile) {
      var tabs = document.querySelector('.cap-tabsline');
      var card = tabs && tabs.closest ? tabs.closest('.cap-card') : null;
      if (card && card.parentNode) { card.insertAdjacentHTML('afterend', html); return; }
    }
    var wrap = document.querySelector('.cp-wrap');
    if (wrap) wrap.insertAdjacentHTML('afterbegin', html);
  }

  /* ------------------------------------------------------------------ *
   * the old browser-only score on the Resume page, answered by the
   * server's - so a candidate never sees two different numbers
   * ------------------------------------------------------------------ */
  var ICON = { contact: '📇', summary: '✍️', experience: '💼', skills: '🧩', education: '🎓', projects: '🏅', formatting: '📄', keywords: '🔑' };
  function mine(cand) { return isCand() && cand && STATE.session && String(cand.id) === String(STATE.session.id); }
  function wrapLegacy() {
    var prevQ = window.resumeQualityScore;
    if (typeof prevQ === 'function' && !prevQ.__tlrs) {
      var q = function (cand) {
        var s = S.score;
        if (mine(cand) && s && s.status === 'scored') {
          var sec = {}; s.sections.forEach(function (x) { sec[x.key] = x; });
          var pct = function (keys) {
            var got = 0, max = 0;
            keys.forEach(function (k) { if (sec[k]) { got += sec[k].score; max += sec[k].max; } });
            return max ? Math.round((100 * got) / max) : 0;
          };
          return { overall: s.total, completeness: pct(['contact', 'summary', 'education', 'projects']),
            skillsCoverage: pct(['skills']), experienceDetail: pct(['experience', 'formatting']), keywordOptimization: pct(['keywords']) };
        }
        return prevQ.apply(this, arguments);
      };
      q.__tlrs = true;
      window.resumeQualityScore = q;
    }
    var prevT = window.profileImprovementSuggestions;
    if (typeof prevT === 'function' && !prevT.__tlrs) {
      var t = function (cand) {
        var s = S.score;
        if (mine(cand) && s && s.status === 'scored' && (s.tips || []).length) {
          return s.tips.slice(0, 4).map(function (x) { return { icon: ICON[x.section] || '💡', text: x.fix }; });
        }
        return prevT.apply(this, arguments);
      };
      t.__tlrs = true;
      window.profileImprovementSuggestions = t;
    }
  }

  /* ------------------------------------------------------------------ *
   * after an upload: optional, never in the way
   * ------------------------------------------------------------------ */
  function closeFloat() { var f = document.getElementById('tlrsFloat'); if (f) f.remove(); }
  window.tlrsLater = closeFloat;
  function showFloat(s) {
    closeFloat(); addCss();
    var body;
    if (s.status === 'unreadable') {
      body = '<b style="font-size:14px">📄 ' + h(s.message) + '</b><div style="font-size:12.5px;color:#42505f;margin:5px 0 10px">Your file is saved; we just could not read the text in it.</div>';
    } else {
      var t = (s.tips || [])[0];
      body = '<div style="display:flex;gap:12px;align-items:center">' + ring(s.total, s.label, 64)
        + '<div><b style="font-size:14px">Your resume scored ' + s.total + '/100</b><div style="margin-top:3px">' + labelPill(s.label) + '</div></div></div>'
        + '<div style="font-size:12.5px;color:#42505f;margin:9px 0 10px">' + (t ? 'Here is how to improve it: ' + h(t.fix) : 'It covers everything we check — well done.') + '</div>';
    }
    var el = document.createElement('div');
    el.id = 'tlrsFloat'; el.className = 'tlrs-float'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Resume score');
    el.innerHTML = body + '<div style="display:flex;gap:8px;justify-content:flex-end">'
      + '<button class="cp-btn" onclick="tlrsLater()">Later</button>'
      + '<button class="cp-btn pri" onclick="tlrsLater();location.hash=\'#/candidate/resume-score\'">' + (s.status === 'unreadable' ? 'Continue' : 'See tips') + '</button></div>';
    document.body.appendChild(el);
  }
  function wrapUpload() {
    if (!window.TL || typeof TL.uploadResume !== 'function' || TL.uploadResume.__tlrs) return;
    var prev = TL.uploadResume;
    var next = function () {
      var mine = isCand();
      return prev.apply(this, arguments).then(function (res) {
        if (mine && api()) {
          /* After the profile-sections review has had its moment. */
          setTimeout(function () {
            api().post('/candidate/resume/score', {}).then(function (out) {
              take(out); S.improvement = out.improvement || null; rerender();
              if (out.score) showFloat(out.score);
            }).catch(function () { /* the upload itself succeeded */ });
          }, 1500);
        }
        return res;
      });
    };
    next.__tlrs = true;
    TL.uploadResume = next;
  }

  /* ------------------------------------------------------------------ *
   * before applying: a gentle hint, never a block
   * ------------------------------------------------------------------ */
  var hinted = {};
  function wrapApply(name) {
    var prev = window[name];
    if (typeof prev !== 'function' || prev.__tlrs) return;
    var next = function (jobId) {
      var self = this, args = arguments;
      var s = S.score;
      if (isCand() && s && s.status === 'scored' && s.total < LOW && !hinted[jobId] && typeof window.fcrModal === 'function') {
        hinted[jobId] = true;
        window.__tlrsGo = function () { try { fcrCloseModal(); } catch (e) { /* */ } return prev.apply(self, args); };
        var t = (s.tips || [])[0];
        fcrModal('<div class="fcr-jd-head"><h3>Improve your profile to get more calls</h3>'
          + '<p>Your resume score is ' + s.total + '/100. A few quick changes help recruiters say yes.</p>'
          + '<button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
          + '<div class="fcr-jd-body">' + (t ? '<div style="font-size:13px;color:#26313f"><b>Quickest win:</b> ' + h(t.fix) + ' <span class="tlrs-gain">+' + t.gain + ' points</span></div>' : '')
          + '<div style="font-size:12px;color:#7b8794;margin-top:8px">This is only a suggestion — you can apply now either way.</div></div>'
          + '<div class="fcr-jd-actions"><button class="btn btn-ghost" id="tlrsImprove" onclick="fcrCloseModal();location.hash=\'#/candidate/resume-score\'">Improve</button>'
          + '<button class="btn btn-primary" id="tlrsApplyAnyway" onclick="__tlrsGo()">Apply anyway</button></div>');
        return undefined;
      }
      return prev.apply(this, arguments);
    };
    next.__tlrs = true;
    window[name] = next;
  }

  /* ------------------------------------------------------------------ *
   * recruiter: badges and the 70+ filter
   * ------------------------------------------------------------------ */
  var badges = {};          // id -> {status,total,label} | 'none'
  var asked = {};
  var pendingIds = {};
  var fetchTimer = null;
  var rsMin = '';
  try { rsMin = sessionStorage.getItem('tlrs_min_v1') || ''; } catch (e) { rsMin = ''; }

  function badgeHtml(id) {
    var b = badges[id];
    if (!b || b === 'none') return '';
    if (b.status === 'unreadable') return '<span class="tlrs-badge na" data-tlrs-b="' + h(id) + '" title="The resume could not be read">Resume ?</span>';
    var cls = b.total >= 75 ? 'hi' : b.total >= 50 ? 'mid' : 'lo';
    return '<span class="tlrs-badge ' + cls + '" data-tlrs-b="' + h(id) + '" title="Resume score ' + b.total + '/100 · ' + h(b.label) + '">📄 ' + b.total + '</span>';
  }
  function fetchBadges() {
    var ids = Object.keys(pendingIds); pendingIds = {};
    if (!ids.length || !api()) return;
    for (var i = 0; i < ids.length; i += 100) {
      (function (chunk) {
        api().get('/resume-scores?ids=' + chunk.map(encodeURIComponent).join(',')).then(function (out) {
          chunk.forEach(function (id) { badges[id] = (out.scores && out.scores[id]) || 'none'; });
          decorate();
        }).catch(function () { /* badges are a convenience */ });
      })(ids.slice(i, i + 100));
    }
  }
  var RX = /(?:candidate-profile\?id=|fcrOpenProfile\(\s*['"]|tlViewResume\(\s*['"])([A-Za-z0-9_\-]+)/;
  function decorate() {
    if (!isStaff()) return;
    var hash = location.hash || '';
    if (!/^#\/(recruiter|admin|client)\//.test(hash)) return;
    addCss();
    var want = {};
    /* the profile page: beside the name */
    var pm = /candidate-profile\?id=([^&]+)/.exec(hash);
    if (pm) {
      var pid = decodeURIComponent(pm[1]);
      want[pid] = true;
      var c = window.DATA && DATA.candidateById ? DATA.candidateById(pid) : null;
      var h2 = c ? Array.prototype.filter.call(document.querySelectorAll('.panel h2'), function (x) { return x.textContent.trim() === String(c.name).trim(); })[0] : null;
      if (h2 && !h2.querySelector('[data-tlrs-b]') && badges[pid] && badges[pid] !== 'none') h2.insertAdjacentHTML('beforeend', badgeHtml(pid));
    }
    /* lists: the first non-button element per candidate */
    var done = {};
    Array.prototype.forEach.call(document.querySelectorAll('[onclick]'), function (el) {
      var m = RX.exec(el.getAttribute('onclick') || '');
      if (!m) return;
      var id = m[1];
      want[id] = true;
      if (done[id]) return;
      var row = el.closest ? el.closest('tr, .fcr-card, .fcr-row, .tp-row, .kcard') : null;
      var scope = row || el.parentNode;
      if (!scope || scope.querySelector('[data-tlrs-b="' + id + '"]')) { done[id] = true; return; }
      if (!badges[id] || badges[id] === 'none') return;
      /* Beside the name: the bold name in the row, else the clicked element. */
      var nameEl = (row && row.querySelector('.pc-name, .pname, .name, td b, td strong'))
        || (el.tagName !== 'BUTTON' ? (el.querySelector && (el.querySelector('b, strong') || el)) : null);
      if (!nameEl) return;
      nameEl.insertAdjacentHTML('beforeend', badgeHtml(id));
      done[id] = true;
    });
    Object.keys(want).forEach(function (id) {
      if (badges[id] === undefined && !asked[id]) { asked[id] = true; pendingIds[id] = true; }
    });
    if (Object.keys(pendingIds).length && !fetchTimer) {
      fetchTimer = setTimeout(function () { fetchTimer = null; fetchBadges(); }, 250);
    }
    placeFilter();
  }

  /* the filter, on Talent Pool and Find Candidates */
  window.tlrsSetMin = function (on) {
    rsMin = on ? '70' : '';
    try { sessionStorage.setItem('tlrs_min_v1', rsMin); } catch (e) { /* per-tab convenience */ }
    var hash = location.hash || '';
    if (/talent-pool|\/candidates\b/.test(hash) && typeof window.tpLoad === 'function') {
      try { if (STATE.talentPool) STATE.talentPool.offset = 0; } catch (e) { /* */ }
      tpLoad();
    } else if (/find-candidates/.test(hash) && window.TL && typeof TL.fcrFetch === 'function') {
      TL.fcrFetch(true).then(function () { if (typeof window.fcrRepaint === 'function') fcrRepaint(); else rerender(); });
    } else rerender();
  };
  function filterHtml() {
    return '<label class="tlrs-flt" id="tlrsFilter" title="Only candidates whose latest resume score is 70 or more">'
      + '<input type="checkbox" ' + (rsMin ? 'checked ' : '') + 'onchange="tlrsSetMin(this.checked)"> Resume score 70+</label>';
  }
  function placeFilter() {
    if (!['recruiter', 'admin', 'bde'].includes(role())) return;
    if (document.getElementById('tlrsFilter')) return;
    var tpRow = document.querySelector('#tpHost .tp-bar .row') || document.querySelector('.tp-bar .row');
    if (tpRow) {
      tpRow.insertAdjacentHTML('beforeend', '<div class="tp-f' + (rsMin ? ' on' : '') + '"><i>Resume score</i>' + filterHtml() + '</div>');
      return;
    }
    var side = document.querySelector('.fcr-side');
    if (side && /find-candidates/.test(location.hash || '')) {
      side.insertAdjacentHTML('afterbegin', '<div style="padding:10px 12px;border-bottom:1px solid #eef1f5">' + filterHtml() + '</div>');
    }
  }

  function wrapApi() {
    if (!window.TL || !TL.api || TL.api.__tlrs) return;
    var get = TL.api.get;
    TL.api.get = function (path) {
      var args = Array.prototype.slice.call(arguments);
      if (rsMin && typeof path === 'string' && path.indexOf('/candidates?') === 0
          && /talent-pool|find-candidates|\/recruiter\/candidates\b/.test(location.hash || '')
          && path.indexOf('resumeScoreMin=') < 0) {
        args[0] = path + '&resumeScoreMin=' + encodeURIComponent(rsMin);
      }
      return get.apply(this, args);
    };
    TL.api.__tlrs = true;
  }

  /* ------------------------------------------------------------------ */
  var lastSession = null;
  var obs = null;
  var obsTimer = null;
  function onRender() {
    var sid = window.STATE && STATE.session ? STATE.session.role + ':' + STATE.session.id : null;
    if (sid !== lastSession) {
      lastSession = sid; S.score = null; S.at = 0; S.history = null; S.improvement = null; S.err = '';
      badges = {}; asked = {}; hinted = {};
      if (isCand()) load(true);
    }
    if (isCand()) {
      if (/^#\/candidate\/(profile|resume)/.test(location.hash || '') && Date.now() - S.at > 30000 && !S.loading) load(true);
      placeMini();
    }
    if (isStaff()) decorate();
  }
  function install() {
    wrapPage(); wrapUpload(); wrapApply('applyToJob'); wrapApply('easyApply'); wrapApi(); wrapLegacy();
    var prev = window.render;
    if (typeof prev === 'function' && !prev.__tlrsR) {
      var r = function () {
        var out = prev.apply(this, arguments);
        try { onRender(); } catch (e) { /* never break a page */ }
        return out;
      };
      r.__tlrsR = true;
      window.render = r;
    }
    /* Talent Pool repaints itself without render(); watch for it. */
    if (window.MutationObserver && !obs) {
      obs = new MutationObserver(function () {
        if (!isStaff() || obsTimer) return;
        /* Throttled, not debounced: some screens change the DOM
           continuously, and a debounce would then never fire. */
        obsTimer = setTimeout(function () { obsTimer = null; try { decorate(); } catch (e) { /* */ } }, 150);
      });
      var app = document.getElementById('app') || document.body;
      obs.observe(app, { childList: true, subtree: true });
    }
    rerender();
  }
  if (document.readyState === 'complete') install();
  else window.addEventListener('load', install);

  window.TLResumeScore = {
    get: function () { if (!S.score && isCand()) load(); return S.score; },
    load: function (force) { return load(force).then(function () { return S.score; }); },
    rescore: function () { window.tlrsRescore(); },
    decorate: function () { decorate(); },
    LOW: LOW,
  };
})();
