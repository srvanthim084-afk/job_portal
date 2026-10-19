/*
 * "How was this score worked out?" - click a candidate's "NN% match" and see the working.
 *
 *   tlWhyScore(candidateId, scoreOnCard [, applicationId])
 *
 * Reads GET /api/candidates/:id/match-breakdown, which re-runs the screening scorer on the candidate and the job they applied to and
 * returns points per part, the job's skills found / not found, and the skills ceiling. Read-only: nothing here changes a score.
 */
(function () {
  'use strict';
  var W = null, seq = 0;
  var api = function () { return window.TL && window.TL.api; };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var $ = function (id) { return document.getElementById(id); };

  function style() {
    if ($('sw-style')) return;
    var css = '.sw-ov{position:fixed;inset:0;z-index:9500;background:rgba(11,18,32,.55);display:flex;align-items:center;justify-content:center;padding:18px}'
      + '.sw-m{background:var(--surface,#fff);color:var(--ink-900,#0b1220);width:min(640px,100%);max-height:calc(100vh - 36px);display:flex;flex-direction:column;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.3);overflow:hidden}'
      + '.sw-h{display:flex;gap:10px;align-items:flex-start;padding:14px 18px;border-bottom:1px solid var(--border,#dde2ea)}.sw-h h3{margin:0;font-size:16px}.sw-h p{margin:2px 0 0;font-size:12.5px;color:var(--ink-500,#5b6678)}'
      + '.sw-x{margin-left:auto;border:0;background:transparent;font-size:20px;cursor:pointer;color:var(--ink-500,#5b6678);padding:2px 8px;border-radius:8px}.sw-x:hover{background:var(--paper-50,#eef1f5)}'
      + '.sw-b{overflow:auto;padding:16px 18px}'
      + '.sw-big{display:flex;align-items:baseline;gap:10px;margin-bottom:6px}.sw-big b{font-size:34px}.sw-big span{color:var(--ink-500,#5b6678);font-size:13px}.sw-big span b{font-size:inherit}'
      + '.sw-note{border-radius:10px;padding:10px 13px;font-size:13px;line-height:1.5;margin:8px 0}.sw-warn{background:var(--warn-100,#fbeed8);color:var(--warn-600,#8a5410)}.sw-info{background:#e8f1fb;color:#1c4f87}'
      + '.sw-row{display:grid;grid-template-columns:96px 1fr 58px;gap:10px;align-items:center;margin-top:11px}.sw-row .l{font-weight:700;font-size:13px}'
      + '.sw-bar{height:9px;background:var(--paper-50,#eef1f5);border-radius:99px;overflow:hidden}.sw-bar i{display:block;height:100%;background:#2f7de1;border-radius:99px}'
      + '.sw-row .n{text-align:right;font-size:12.5px;font-weight:700}.sw-why{grid-column:2 / 4;font-size:12.5px;color:var(--ink-500,#5b6678);margin-top:-5px}'
      + '.sw-off{opacity:.55}'
      + '.sw-h4{font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-500,#5b6678);margin:16px 0 6px;font-weight:800}'
      + '.sw-chip{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:650;margin:0 5px 5px 0}.sw-ok{background:var(--ok-100,#e2f5ec);color:var(--ok-600,#1e8e5a)}.sw-half{background:#e8f1fb;color:#1c4f87}.sw-no{background:var(--warn-100,#fbeed8);color:var(--warn-600,#a5670f)}'
      + '.sw-f{padding:11px 18px;border-top:1px solid var(--border,#dde2ea);display:flex;gap:10px;align-items:center;background:var(--paper-50,#f6f8fb)}.sw-f span{flex:1;font-size:12px;color:var(--ink-500,#5b6678)}'
      + '.sw-btn{border:1px solid var(--border,#dde2ea);background:var(--surface,#fff);border-radius:8px;padding:6px 12px;font:inherit;font-size:13px;font-weight:650;cursor:pointer}'
      + '.sw-sel{border:1px solid var(--border,#dde2ea);border-radius:8px;padding:5px 8px;font:inherit;font-size:12.5px;margin-top:6px;max-width:100%}'
      + '@media (max-width:560px){.sw-ov{padding:0}.sw-m{max-height:100vh;height:100vh;border-radius:0}.sw-row{grid-template-columns:80px 1fr 52px}}';
    var st = document.createElement('style'); st.id = 'sw-style'; st.textContent = css; document.head.appendChild(st);
  }

  function close() {
    var r = $('swRoot'); if (r && r.parentNode) r.parentNode.removeChild(r);
    document.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', close);
    W = null;
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  window.tlWhyClose = close;

  window.tlWhyScore = function (candidateId, score, applicationId) {
    if (!api() || W) return;
    style();
    var mine = W = { id: candidateId, score: score, data: null, error: '', pick: applicationId || null };
    var root = document.createElement('div'); root.id = 'swRoot'; document.body.appendChild(root);
    root.addEventListener('mousedown', function (e) { if (e.target === root.firstChild) close(); });
    document.addEventListener('keydown', onKey); window.addEventListener('hashchange', close);
    paint();
    api().get('/candidates/' + encodeURIComponent(candidateId) + '/match-breakdown?'
      + (applicationId ? 'applicationId=' + encodeURIComponent(applicationId) + '&' : '') + (Number.isFinite(Number(score)) ? 'score=' + encodeURIComponent(score) : '')).then(function (r) {
      if (W !== mine) return; W.data = r; W.pick = W.pick || r.preferred; paint();
    }, function (e) { if (W !== mine) return; W.error = (e && e.message) || 'Could not load the working.'; paint(); });
  };
  window.tlWhyPick = function (id) { if (W) { W.pick = id; paint(); } };

  function chips(list, cls) { return (list || []).map(function (s) { return '<span class="sw-chip ' + cls + '">' + esc(s) + '</span>'; }).join(''); }

  function paint() {
    var root = $('swRoot'); if (!W || !root) return;
    var d = W.data, a = d && d.applications.filter(function (x) { return x.applicationId === W.pick; })[0] || (d && d.applications[0]);
    var body;
    if (W.error) body = '<div class="sw-note sw-warn">' + esc(W.error) + '</div>';
    else if (!d) body = '<div style="padding:24px;text-align:center;color:#5b6678">Loading…</div>';
    else if (!a) body = '<div class="sw-note sw-info">' + esc(d.note || 'There is no score to explain.') + '</div>';
    else {
      var shown = a.storedScore != null ? a.storedScore : a.liveScore;
      var sel = d.applications.length > 1 ? '<select class="sw-sel" onchange="tlWhyPick(this.value)" aria-label="Application">' + d.applications.map(function (x) {
        return '<option value="' + esc(x.applicationId) + '"' + (x.applicationId === a.applicationId ? ' selected' : '') + '>' + esc(x.jobTitle) + ' - ' + esc(x.stageLabel) + (x.storedScore != null ? ' (' + x.storedScore + '%)' : '') + '</option>'; }).join('') + '</select>' : '';
      var cap = '';
      var nSk = a.skills.matched.length + a.skills.implied.length + a.skills.missing.length;
      if (!a.cappedBySkills && a.skills.stated && a.ceiling != null && a.ceiling < 100) {
        cap = '<div class="sw-note sw-info"><b>Skills limit.</b> Only ' + a.skills.matched.length + (a.skills.implied.length ? ' (plus ' + a.skills.implied.length + ' from the resume)' : '')
          + ' of the job\'s ' + nSk + ' required skills were found, so this job cannot show more than ' + a.ceiling + '% for this candidate, however well the rest fits. (None found: 20% at most. All found: no limit.)</div>';
      }
      if (a.cappedBySkills) {
        var n = a.skills.matched.length + a.skills.implied.length + a.skills.missing.length;
        cap = '<div class="sw-note sw-warn"><b>Held down by skills.</b> The parts below would give ' + a.weightedScore + '%, but only '
          + a.skills.matched.length + (a.skills.implied.length ? ' (plus ' + a.skills.implied.length + ' from the resume)' : '') + ' of the job\'s ' + n
          + ' required skills were found, and a score cannot go above ' + a.ceiling + '% then. (None of them found: 20% at most. All of them: no limit.)</div>';
      }
      var diff = a.differs ? '<div class="sw-note sw-info">This score was worked out when ' + (a.screenedAt ? 'the application was screened' : 'they applied')
        + '. The same check run now gives <b>' + a.liveScore + '%</b> (the resume or the job has changed since). Re-screening the application updates the card.</div>' : '';
      var rows = a.parts.map(function (p) {
        var pct = p.of ? Math.round(p.scored / p.of * 100) : 0;
        return '<div class="sw-row ' + (p.counted ? '' : 'sw-off') + '"><span class="l">' + esc(p.label) + '</span><span class="sw-bar"><i style="width:' + pct + '%"></i></span>'
          + '<span class="n">' + (p.counted ? p.scored + ' / ' + p.of : 'not counted') + '</span><span class="sw-why">' + esc(p.note) + '</span></div>';
      }).join('');
      var sk = '';
      if (a.skills.stated) {
        sk = '<div class="sw-h4">Skills the job asks for</div>'
          + (a.skills.matched.length ? '<div>' + chips(a.skills.matched, 'sw-ok') + ' <span style="font-size:12px;color:#5b6678">on the profile</span></div>' : '')
          + (a.skills.implied.length ? '<div>' + chips(a.skills.implied, 'sw-half') + ' <span style="font-size:12px;color:#5b6678">only mentioned in the resume (half credit)</span></div>' : '')
          + (a.skills.missing.length ? '<div>' + chips(a.skills.missing, 'sw-no') + ' <span style="font-size:12px;color:#5b6678">not found</span></div>' : '')
          + (a.resumeRead ? '' : '<div class="sw-note sw-info">No resume text is on file for this candidate, so only the profile\'s own skills could be checked.</div>');
      }
      body = '<div class="sw-big"><b>' + shown + '%</b><span>match for <b>' + esc(a.jobTitle) + '</b> · ' + esc(a.stageLabel) + '</span></div>' + sel
        + diff + cap + rows + sk
        + '<div class="sw-h4">What the score is</div><div style="font-size:12.5px;color:#5b6678;line-height:1.55">Each part is scored against what this job asks for and weighted by the admin\'s AI settings'
        + (d.weights ? ' (skills ' + d.weights.skills + ', experience ' + d.weights.experience + ', education ' + d.weights.education + ', location ' + d.weights.location + ')' : '')
        + '. The screening threshold is ' + a.threshold + '%. A low score never rejects anyone - it is a guide for the recruiter.</div>';
    }
    root.innerHTML = '<div class="sw-ov"><div class="sw-m" role="dialog" aria-modal="true" aria-label="How this score was worked out"><div class="sw-h"><div><h3>How was this score worked out?</h3><p>'
      + esc(d && d.candidate ? d.candidate.name : '') + '</p></div><button class="sw-x" onclick="tlWhyClose()" aria-label="Close">✕</button></div>'
      + '<div class="sw-b">' + body + '</div><div class="sw-f"><span>Nothing here changes the score.</span><button class="sw-btn" onclick="tlWhyClose()">Close</button></div></div></div>';
  }
}());
