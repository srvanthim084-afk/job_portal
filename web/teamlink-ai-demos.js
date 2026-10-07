/*
 * TeamLink — "AI Hiring Demo" and "AI WhatsApp Agent", on the real backend.
 *
 * Both pages used to be simulations built on the prototype's seeded demo
 * candidates (fixed scores, a fixed interview slot, "report exported
 * (simulated)"). Real data hides candidates from visitors, so for anyone
 * signed out they crashed. They are now thin screens over two endpoints
 * that use the product's own functions:
 *
 *   POST /api/ai-pipeline/run         resume parsing -> AI Match -> screening -> ranking
 *                                     -> recommendation -> interview questions -> report
 *   POST /api/whatsapp-agent/chat     the WhatsApp agent's engine (the same one the
 *                                     WhatsApp webhook uses)
 *   GET  /api/whatsapp-agent/status   is the WhatsApp channel configured?
 *
 * The routes (#/ai-pipeline, #/whatsapp-demo), the navbar, the page chrome and
 * the look (hero, panels, stepper, phone chat) are the existing ones: this
 * file only replaces the two page functions, the way the other modules wrap
 * existing globals. No secret is read or held here.
 */
(function () {
  'use strict';

  var STEPS = [
    { key: 'parse', label: 'Resume Parsing', icon: '📄' },
    { key: 'match', label: 'Job Matching', icon: '🧩' },
    { key: 'screen', label: 'AI Screening', icon: '🛡️' },
    { key: 'rank', label: 'Candidate Ranking', icon: '🏆' },
    { key: 'reco', label: 'Recommendations', icon: '💡' },
    { key: 'interview', label: 'AI Interview', icon: '🎙️' },
    { key: 'report', label: 'Score & Report', icon: '📊' },
  ];

  function E(s) {
    if (typeof window.esc === 'function') return window.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api() { return window.TL && window.TL.api; }
  function session() { return (window.STATE && window.STATE.session) || null; }
  function role() { var s = session(); return s ? s.role : ''; }
  function chrome(active, body) { return typeof window.withChrome === 'function' ? window.withChrome(active, body) : body; }
  function rerender() { if (typeof window.render === 'function') window.render(); }
  function msg(e, fallback) { return (e && e.message) ? e.message : fallback; }
  function time() { try { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

  /* ====================================================================
   *  AI HIRING DEMO
   * ==================================================================== */
  function P() {
    var st = window.STATE;
    if (!st.aiPipe) st.aiPipe = { source: '', jobId: '', text: '', appId: '', apps: null, appsLoading: false, appsError: '', busy: false, step: -1, result: null, error: '' };
    return st.aiPipe;
  }

  function openJobs() {
    var jobs = (window.DATA && window.DATA.jobs) || [];
    return jobs.filter(function (j) { return j && !/^xjob_/.test(String(j.id)) && (!j.status || j.status === 'open'); });
  }
  function companyName(j) {
    try { var c = window.DATA.companyById(j.companyId); return (c && c.name) || ''; } catch (e) { return ''; }
  }

  function sourcesFor() {
    var r = role();
    var list = [{ key: 'resume', label: '📋 Paste a resume' }];
    if (r === 'candidate') list.push({ key: 'profile', label: '👤 My saved profile' });
    if (r === 'candidate' || r === 'recruiter' || r === 'admin') list.push({ key: 'application', label: r === 'candidate' ? '📨 One of my applications' : '📨 A real application' });
    return list;
  }

  function loadApps() {
    var S = P();
    if (S.apps || S.appsLoading || !api()) return;
    S.appsLoading = true;
    api().get('/ai-pipeline/applications').then(function (r) {
      S.apps = (r && r.applications) || []; S.appsLoading = false; rerender();
    }, function (e) {
      S.apps = []; S.appsLoading = false; S.appsError = msg(e, 'Your applications could not be loaded.'); rerender();
    });
  }

  window.tlapSource = function (k) { var S = P(); S.source = k; S.error = ''; S.result = null; S.step = -1; if (k === 'application') loadApps(); rerender(); };
  window.tlapJob = function (v) { var S = P(); S.jobId = v; S.error = ''; };
  window.tlapText = function (v) { P().text = v; var c = document.getElementById('tlapCount'); if (c) c.textContent = v.length + ' / 12000'; };
  window.tlapApp = function (v) {
    var S = P(); S.appId = v;
    var a = (S.apps || []).filter(function (x) { return x.id === v; })[0];
    if (a) S.jobId = a.jobId;
    rerender();
  };
  window.tlapReset = function () { var S = P(); S.step = -1; S.result = null; S.error = ''; S.busy = false; rerender(); };

  function reveal() {
    var S = P();
    setTimeout(function () {
      if (!/^#\/ai-pipeline/.test(location.hash) || !S.result) return;
      if (S.step < STEPS.length - 1) { S.step++; rerender(); reveal(); }
    }, 750);
  }

  window.tlapRun = function () {
    var S = P();
    if (S.busy) return;
    var src = S.source || sourcesFor()[0].key;
    var body = { jobId: S.jobId };
    if (!S.jobId) { S.error = 'Choose a job first.'; rerender(); return; }
    if (src === 'resume') {
      if ((S.text || '').trim().length < 40) { S.error = 'Paste your resume text (at least a few lines) so the pipeline has something to read.'; rerender(); return; }
      body.text = S.text;
    } else if (src === 'application') {
      if (!S.appId) { S.error = 'Choose an application first.'; rerender(); return; }
      body.applicationId = S.appId;
    }
    S.busy = true; S.error = ''; S.result = null; S.step = -1; rerender();
    api().post('/ai-pipeline/run', body).then(function (r) {
      S.result = r; S.busy = false; S.step = 0; rerender(); reveal();
    }, function (e) {
      S.busy = false;
      S.error = msg(e, 'The AI service is temporarily unavailable. Please try again.');
      rerender();
    });
  };

  window.tlapDownload = function () {
    var R = P().result; if (!R) return;
    var L = [];
    L.push('TeamLink AI hiring report', '==========================', '');
    L.push('Role: ' + R.job.title + (R.job.company ? ' @ ' + R.job.company : ''), 'Source: ' + (R.parse.source || ''), '');
    L.push('Candidate: ' + (R.parse.name || 'not detected'), 'Experience: ' + (R.parse.experience || 'not detected'), 'Education: ' + (R.parse.education || 'not detected'),
      'Skills read: ' + ((R.parse.skills || []).join(', ') || 'none'), '');
    L.push('AI Match (JD skills matched / required): ' + (R.match.score == null ? 'not available - the job lists no skills' : R.match.score + '%'));
    if (R.match.matched.length) L.push('Matched: ' + R.match.matched.join(', '));
    if (R.match.missing.length) L.push('Missing: ' + R.match.missing.join(', '));
    if (R.screening) {
      L.push('', 'Screening score: ' + R.screening.score + ' (shortlist line ' + R.screening.threshold + ') - ' + R.screening.verdict);
      (R.screening.reasons || []).forEach(function (x) { L.push(' - ' + x); });
    }
    if (R.ranking && R.ranking.available) L.push('', 'Ranking: #' + R.ranking.rank + ' of ' + R.ranking.of + ' applicants');
    L.push('', 'Recommendation: ' + R.recommendation.text);
    if (R.interview && R.interview.existing) L.push('AI interview: ' + R.interview.existing.status + (R.interview.existing.score != null ? ' (score ' + R.interview.existing.score + ')' : ''));
    L.push('', R.notice);
    var blob = new Blob([L.join('\n')], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'teamlink-ai-report.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  };

  var tags = function (arr, style) {
    return (arr || []).map(function (s) { return '<span class="skill-tag"' + (style ? ' style="' + style + '"' : '') + '>' + E(s) + '</span>'; }).join('') || '—';
  };
  var VERDICT = { shortlist: ['Would be shortlisted', 'badge-ok'], review: ['Needs review', 'badge-warn'], hold: ['On hold for a recruiter', 'badge-warn'] };

  function stepPanel(R, step) {
    if (step === 0) {
      var p = R.parse;
      return '<div class="ai-card"><h3>📄 Resume Parsing <span class="badge badge-ai tagai">read from ' + E(p.source) + (p.found != null ? ' · ' + p.found + ' fields' : '') + '</span></h3>'
        + '<div class="kv">'
        + '<div class="item"><div class="k">Name detected</div><div class="v" style="font-size:14px">' + E(p.name || 'not detected') + '</div></div>'
        + '<div class="item"><div class="k">Experience detected</div><div class="v" style="font-size:14px">' + E(p.experience || 'not detected') + '</div></div>'
        + '<div class="item"><div class="k">Contact</div><div class="v" style="font-size:12.5px">' + (p.contact ? '✓ found' : 'not found') + '</div></div>'
        + '<div class="item"><div class="k">Education</div><div class="v" style="font-size:12.5px">' + E((p.education || 'not detected').split(',')[0]) + '</div></div></div>'
        + '<div style="margin-top:12px"><span style="font-size:11px;font-weight:700;color:var(--text-soft);text-transform:uppercase">Skills extracted</span><br>' + tags(p.skills) + '</div></div>';
    }
    if (step === 1) {
      var m = R.match;
      return '<div class="ai-card"><h3>🧩 Job Matching — ' + E(R.job.title) + (R.job.company ? ' @ ' + E(R.job.company) : '') + '</h3>'
        + '<div style="display:flex;align-items:center;gap:12px;margin:10px 0"><span style="font-size:12.5px;color:var(--text-soft)">🎯 AI Match</span>'
        + (m.score == null ? '<b>Not available</b>' : '<span class="score ' + (m.score >= 70 ? 'hi' : m.score >= 40 ? 'mid' : 'lo') + '" style="font-size:18px">' + m.score + '%</span>'
          + '<span style="font-size:12.5px;color:var(--text-soft)">' + m.matchedCount + ' of ' + m.required + ' required skills</span>') + '</div>'
        + '<p style="font-size:12.5px;color:var(--text-soft);margin:0 0 8px">' + E(m.basis) + '</p>'
        + '<div><span style="font-size:11px;font-weight:700;color:var(--text-soft);text-transform:uppercase">Matched</span><br>' + tags(m.matched, 'background:var(--ok-100);color:var(--ok-600)') + '</div>'
        + (m.missing.length ? '<div style="margin-top:8px"><span style="font-size:11px;font-weight:700;color:var(--text-soft);text-transform:uppercase">Missing</span><br>' + tags(m.missing, 'background:var(--bad-100);color:var(--bad-600)') + '</div>' : '')
        + '</div>';
    }
    if (step === 2) {
      var s = R.screening;
      if (!s) return '<div class="ai-card"><h3>🛡️ AI Screening</h3><p style="font-size:13px;color:var(--text-soft);margin-top:8px">Screening is done for your recruiter, who reviews every application. Its verdict is not shown to candidates.</p></div>';
      var v = VERDICT[s.verdict] || [s.verdict, 'badge-warn'];
      var dims = Object.keys(s.dimensions || {}).map(function (k) {
        var d = s.dimensions[k];
        return '<div class="item"><div class="k">' + E(k[0].toUpperCase() + k.slice(1)) + '</div><div class="v">' + d.percent + '%</div><div style="font-size:11px;color:var(--text-soft)">' + d.scored + ' of ' + d.of + ' points</div></div>';
      }).join('');
      return '<div class="ai-card"><h3>🛡️ AI Screening <span class="badge ' + v[1] + ' tagai">' + E(v[0]) + '</span></h3>'
        + '<p style="font-size:13px;color:var(--text-soft);margin:8px 0">Screening score <b style="color:var(--text)">' + s.score + '</b> against the shortlist line of ' + s.threshold + ' set in AI Settings.</p>'
        + '<div class="kv">' + dims + '</div>'
        + ((s.reasons || []).length ? '<ul style="margin:12px 0 0 18px;font-size:13px;line-height:1.6">' + s.reasons.map(function (x) { return '<li>' + E(x) + '</li>'; }).join('') + '</ul>' : '')
        + '</div>';
    }
    if (step === 3) {
      var rk = R.ranking;
      return '<div class="ai-card"><h3>🏆 Candidate Ranking</h3><p style="font-size:13px;color:var(--text-soft);margin-top:8px">'
        + (rk.available ? 'This application ranks <b style="color:var(--text)">#' + rk.rank + ' of ' + rk.of + '</b> applicants for ' + E(R.job.title) + ', by the AI screening score.' : E(rk.reason)) + '</p></div>';
    }
    if (step === 4) {
      return '<div class="ai-card"><h3>💡 Recommendation</h3><p style="font-size:13.5px;margin-top:8px">' + E(R.recommendation.text) + '</p>'
        + '<div class="req-note" style="margin-top:12px">🤖 ' + E(R.notice) + '</div></div>';
    }
    if (step === 5) {
      var iv = R.interview, ex = iv.existing;
      return '<div class="ai-card"><h3>🎙️ AI Interview' + (ex ? ' <span class="badge badge-ai tagai">' + E(ex.status.replace('_', ' ')) + (ex.score != null ? ' · ' + ex.score + '/100' : '') + '</span>' : '') + '</h3>'
        + (ex ? '<p style="font-size:13px;color:var(--text-soft);margin-top:8px">An AI interview exists for this application' + (ex.completedOn ? ' (completed ' + E(ex.completedOn) + ')' : '') + '.</p>' : '')
        + '<p style="font-size:12.5px;color:var(--text-soft);margin:10px 0 6px">' + (iv.questions.length
          ? 'The AI interviewer\'s first questions for this role (' + (iv.engine === 'ai' ? 'written by the AI model' : 'built from the job description') + '):'
          : 'Questions could not be prepared right now.') + '</p>'
        + (iv.questions.length ? '<div class="transcript">' + iv.questions.map(function (q) { return '<div class="tline q"><b>AI Interviewer</b>' + E(q) + '</div>'; }).join('') + '</div>' : '')
        + '</div>';
    }
    var sc = R.screening;
    var rows = [['Role', R.job.title + (R.job.company ? ' @ ' + R.job.company : '')], ['AI Match', R.match.score == null ? 'not available' : R.match.score + '%']];
    if (sc) rows.push(['Screening', sc.score + ' · ' + ((VERDICT[sc.verdict] || [sc.verdict])[0])]);
    if (R.ranking && R.ranking.available) rows.push(['Rank', '#' + R.ranking.rank + ' of ' + R.ranking.of]);
    if (R.interview && R.interview.existing) rows.push(['AI interview', R.interview.existing.status.replace('_', ' ') + (R.interview.existing.score != null ? ' · ' + R.interview.existing.score + '/100' : '')]);
    return '<div class="ai-card"><h3>📊 Score &amp; Report</h3><div class="kv">'
      + rows.map(function (r) { return '<div class="item"><div class="k">' + E(r[0]) + '</div><div class="v" style="font-size:13px">' + E(r[1]) + '</div></div>'; }).join('') + '</div>'
      + '<div style="margin-top:14px;display:flex;gap:8px"><button class="btn btn-ghost btn-sm" onclick="tlapDownload()">⬇ Download report</button></div></div>';
  }

  window.pageAIPipeline = function () {
    var S = P();
    var srcs = sourcesFor();
    if (!S.source || !srcs.some(function (x) { return x.key === S.source; })) S.source = srcs[0].key;
    var jobs = openJobs();
    if (!S.jobId && jobs.length) S.jobId = jobs[0].id;
    if (S.source === 'application') loadApps();
    var R = S.result; var step = S.step;

    var srcTabs = srcs.length > 1 ? '<div class="wa-tabs" style="margin:0">' + srcs.map(function (x) {
      return '<button class="' + (S.source === x.key ? 'active' : '') + '" onclick="tlapSource(\'' + x.key + '\')">' + E(x.label) + '</button>';
    }).join('') + '</div>' : '';

    var jobSel = '<label style="font-size:12.5px;font-weight:700">Job:</label><select onchange="tlapJob(this.value)" ' + (S.source === 'application' ? 'disabled' : '')
      + ' style="padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);max-width:100%">'
      + (jobs.length ? jobs.map(function (j) {
        return '<option value="' + E(j.id) + '" ' + (j.id === S.jobId ? 'selected' : '') + '>' + E(j.title) + (companyName(j) ? ' — ' + E(companyName(j)) : '') + '</option>';
      }).join('') : '<option value="">No open jobs right now</option>') + '</select>';

    var input = '';
    if (S.source === 'resume') {
      input = '<div style="flex:1 1 100%"><label style="font-size:12.5px;font-weight:700;display:block;margin-bottom:6px">Your resume text</label>'
        + '<textarea id="tlapText" oninput="tlapText(this.value)" maxlength="12000" rows="8" placeholder="Paste your resume here — name, contact, summary, skills, experience, education. It is read on our server for this run only and is not stored."'
        + ' style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit;resize:vertical">' + E(S.text) + '</textarea>'
        + '<div id="tlapCount" style="font-size:11.5px;color:var(--text-soft);text-align:right">' + (S.text || '').length + ' / 12000</div></div>';
    } else if (S.source === 'profile') {
      input = '<div style="flex:1 1 100%;font-size:13px;color:var(--text-soft)">The pipeline will read your saved TeamLink profile — no text needed.</div>';
    } else {
      var apps = S.apps;
      input = '<div style="flex:1 1 100%"><label style="font-size:12.5px;font-weight:700;margin-right:8px">Application:</label>'
        + (S.appsLoading || !apps ? '<span style="font-size:13px;color:var(--text-soft)">Loading your applications…</span>'
          : !apps.length ? '<span style="font-size:13px;color:var(--text-soft)">' + E(S.appsError || 'There are no applications to run the pipeline on yet.') + '</span>'
            : '<select onchange="tlapApp(this.value)" style="padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);max-width:100%"><option value="">Choose…</option>'
              + apps.map(function (a) { return '<option value="' + E(a.id) + '" ' + (a.id === S.appId ? 'selected' : '') + '>' + E((a.candidateName ? a.candidateName + ' — ' : '') + a.jobTitle + (a.reference ? ' (' + a.reference + ')' : '')) + '</option>'; }).join('') + '</select>') + '</div>';
    }

    var body = ''
      + '<section class="lp-hero"><div class="wrap"><h1>See TeamLink AI screen a candidate, end to end</h1><p>Resume Parsing → Job Matching → AI Screening → Candidate Ranking → Recommendations → AI Interview → Score &amp; Report — the same functions every application runs through, on real data.</p></div></section>'
      + '<section class="block"><div class="wrap">'
      + '<div class="panel" style="margin-bottom:22px"><div class="panel-body" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">'
      + srcTabs + jobSel + input
      + '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn btn-ai" onclick="tlapRun()" ' + (S.busy ? 'disabled' : '') + '>' + (S.busy ? 'AI is analyzing…' : '▶ Run AI Pipeline') + '</button>'
      + '<button class="btn btn-ghost" onclick="tlapReset()">Reset</button></div>'
      + (S.error ? '<div role="alert" style="flex:1 1 100%;color:var(--bad-600);font-size:13px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">⚠️ ' + E(S.error) + ' <button class="btn btn-ghost btn-sm" onclick="tlapRun()">Retry</button></div>' : '')
      + '</div></div>'
      + (typeof window.pipelineStepperHtml === 'function' ? window.pipelineStepperHtml(step) : '')
      + (S.busy ? '<div class="empty-note" role="status">🤖 AI is analyzing — reading the resume, matching it to the job and screening it…</div>'
        : !R || step < 0 ? '<div class="empty-note">Choose a job' + (S.source === 'resume' ? ', paste a resume' : S.source === 'application' ? ' and an application' : '') + ' and click <b>Run AI Pipeline</b> to watch TeamLink AI process it step by step.</div>'
          : stepPanel(R, step))
      + '</div></section>';
    return chrome('ai-pipeline', body);
  };
  window.mountAIPipeline = function () { /* the controls are inline; nothing to bind after a render */ };

  /* ====================================================================
   *  AI WHATSAPP AGENT
   * ==================================================================== */
  function W() {
    var st = window.STATE;
    if (!st.waAgent) {
      st.waAgent = { messages: [], busy: false, error: '', retry: '', lastJobIds: [], status: null, statusLoading: false, identity: '', engine: '', draft: '' };
      st.waAgent.messages.push({ from: 'ai', time: time(), welcome: true,
        text: 'Hi! 👋 I\'m the TeamLink AI Assistant. Ask me for jobs — for example "jobs for React developer" or "any jobs in Hyderabad?". Sign in as a candidate and I can also tell you your application status and interviews.' });
    }
    return st.waAgent;
  }

  function loadStatus() {
    var S = W();
    if (S.status || S.statusLoading || !api()) return;
    S.statusLoading = true;
    api().get('/whatsapp-agent/status').then(function (r) { S.status = r; S.statusLoading = false; rerender(); },
      function () { S.status = { configured: false, unknown: true }; S.statusLoading = false; rerender(); });
  }

  function waHtml(t) {
    var h = E(t);
    h = h.replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
    h = h.replace(/(https?:\/\/[^\s<]+)/g, '<a class="lnk" href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    return h.replace(/\n/g, '<br>');
  }

  function remember() { var i = document.getElementById('waChatInput'); if (i) W().draft = i.value; }

  window.tlwaSend = function (textArg, isRetry) {
    var S = W();
    var inp = document.getElementById('waChatInput');
    var text = String(textArg != null ? textArg : (inp ? inp.value : '')).trim();
    if (!text || S.busy) return;
    if (!isRetry) S.messages.push({ from: 'me', text: text, time: time() });
    S.busy = true; S.error = ''; S.retry = ''; S.draft = ''; rerender();
    api().post('/whatsapp-agent/chat', { text: text.slice(0, 500), jobIds: S.lastJobIds }).then(function (r) {
      S.busy = false;
      S.messages.push({ from: 'ai', text: r.reply, time: time(), jobs: r.jobs || [] });
      if (r.jobs && r.jobs.length) S.lastJobIds = r.jobs.map(function (j) { return j.id; });
      S.identity = r.identity; S.engine = r.engine;
      rerender();
    }, function (e) {
      S.busy = false; S.retry = text;
      S.error = msg(e, 'The AI agent is temporarily unavailable. Please try again.');
      rerender();
    });
  };
  window.tlwaRetry = function () { var S = W(); if (S.retry) window.tlwaSend(S.retry, true); };
  window.tlwaReset = function () { delete window.STATE.waAgent; rerender(); };
  window.tlwaKey = remember;

  function statusPanel(S) {
    var st = S.status; var admin = role() === 'admin';
    if (!st) return '<div class="panel"><div class="panel-body" style="font-size:13px;color:var(--text-soft)">Checking the WhatsApp channel…</div></div>';
    if (st.configured) {
      return '<div class="panel"><div class="panel-head"><h2>WhatsApp channel</h2></div><div class="panel-body" style="font-size:13px">'
        + '✅ Connected — people can message the TeamLink WhatsApp number and this same agent answers them. Replies are sent through the WhatsApp Business Cloud API.'
        + '<div style="margin-top:8px;color:var(--text-soft)">Answering with: <b>' + (st.engine === 'ai' ? 'the AI model' : 'built-in rules (no AI key set)') + '</b></div></div></div>';
    }
    return '<div class="panel"><div class="panel-head"><h2>WhatsApp channel</h2></div><div class="panel-body" style="font-size:13px" role="status">'
      + '⚠️ WhatsApp Agent is not configured. Please configure the WhatsApp integration in the server environment.'
      + '<div style="margin-top:8px;color:var(--text-soft)">The chat on this page already works with real jobs; only the real WhatsApp number is waiting for credentials.</div>'
      + (admin && st.missing && st.missing.length ? '<div style="margin-top:10px"><b>Missing on the server:</b> ' + st.missing.map(function (m) { return '<code>' + E(m) + '</code>'; }).join(', ')
        + '<div style="margin-top:6px;color:var(--text-soft)">Meta webhook callback URL: <code>' + E(location.origin + (st.webhookPath || '/api/whatsapp-agent/webhook')) + '</code></div></div>' : '')
      + '</div></div>';
  }

  window.pageWhatsAppDemo = function () {
    var S = W();
    loadStatus();
    var r = role();
    var who = r === 'candidate'
      ? '🔒 Chatting as yourself — I can answer about <b>your</b> applications and interviews.'
      : '👤 You are chatting as a guest — I can search open jobs. <a href="#/login" onclick="navigate(\'/login\');return false">Sign in as a candidate</a> to ask about your own applications.';

    var msgs = S.messages.map(function (m) {
      var jobs = (m.jobs || []).map(function (j) {
        return '<a class="wa-chip" style="text-decoration:none;display:inline-block" href="' + E(j.link) + '" target="_blank" rel="noopener noreferrer">🔗 ' + E(j.title) + '</a>';
      }).join('');
      return '<div class="wa-msg ' + (m.from === 'me' ? 'out' : '') + '"><div>' + waHtml(m.text) + '</div><span class="time">' + E(m.time) + (m.from === 'me' ? ' ✓✓' : '') + '</span></div>'
        + (jobs ? '<div class="wa-chips">' + jobs + '</div>' : '');
    }).join('');
    var quick = ['Jobs in Hyderabad', 'Jobs for React Developer', 'What is my application status?', 'Schedule an interview'];
    var chips = '<div class="wa-chips">' + quick.map(function (q) {
      return '<button class="wa-chip" onclick="tlwaSend(' + E(JSON.stringify(q)).replace(/"/g, '&quot;') + ')">' + E(q) + '</button>';
    }).join('') + '</div>';

    var phone = '<div class="wa-phone"><div class="wa-screen">'
      + '<div class="wa-head"><div class="av">🤖</div><div><b>TeamLink AI Assistant</b><span>' + (S.busy ? 'typing…' : (S.status && S.status.configured ? 'Online' : 'Web chat')) + '</span></div></div>'
      + '<div class="wa-body" id="waChatBody" aria-live="polite">' + msgs + (S.messages.length <= 1 ? chips : '')
      + (S.busy ? '<div class="wa-typing"><span></span><span></span><span></span></div>' : '')
      + (S.error ? '<div class="wa-msg" role="alert"><div>⚠️ ' + E(S.error) + '</div>' + (S.retry ? '<div class="wa-chips"><button class="wa-chip" onclick="tlwaRetry()">Retry</button></div>' : '') + '</div>' : '')
      + '</div>'
      + '<form class="wa-foot" onsubmit="event.preventDefault(); tlwaSend();">'
      + '<input id="waChatInput" maxlength="500" aria-label="Message the TeamLink AI Assistant" placeholder="Ask for jobs, your status, an interview…" autocomplete="off" oninput="tlwaKey()" value="' + E(S.draft) + '">'
      + '<button type="submit" aria-label="Send" ' + (S.busy ? 'disabled' : '') + '>➤</button></form>'
      + '</div></div>';

    var side = statusPanel(S)
      + '<div class="panel"><div class="panel-head"><h2>Who is asking</h2></div><div class="panel-body" style="font-size:13px">' + who + '</div></div>'
      + '<div class="panel"><div class="panel-head"><h2>What you can ask</h2></div><div class="panel-body" style="font-size:13px;line-height:1.7">'
      + '• <b>Jobs</b> — "jobs for React developer", "any jobs in Hyderabad?"<br>• <b>Details</b> — "details 2" for a job in the list<br>'
      + '• <b>Apply</b> — "apply 2" sends the apply link; the TeamLink form does the applying<br>'
      + '• <b>Your applications</b> — "what is my application status?"<br>• <b>Interviews</b> — "schedule an interview"<br>'
      + '<div style="margin-top:8px;color:var(--text-soft)">Answers come from the live job board and your own TeamLink records — nothing is made up.</div></div></div>'
      + '<div style="margin-top:6px"><button class="btn btn-ghost btn-sm" onclick="tlwaReset()">Reset conversation</button></div>';

    var body = '<section class="lp-hero"><div class="wrap"><h1>AI WhatsApp Agent</h1><p>A two-way WhatsApp assistant: it searches open jobs, sends apply links, and — for a signed-in candidate — answers about their own applications and interviews.</p></div></section>'
      + '<section class="block"><div class="wrap"><div class="two-col">' + phone + '<div>' + side + '</div></div></div></section>';
    return chrome('whatsapp-demo', body);
  };

  window.mountWhatsAppDemo = function () {
    var el = document.getElementById('waChatBody');
    if (el) el.scrollTop = el.scrollHeight;
    var input = document.getElementById('waChatInput');
    if (input && !W().busy) { try { input.focus({ preventScroll: true }); var v = input.value; input.setSelectionRange(v.length, v.length); } catch (e) { /* ignore */ } }
  };
})();
