/*
 * Interview prep kit (0098).
 *
 *   Candidate   Interviews page: "📘 Prep Kit" on every interview, in place of
 *               the old "Prepare with AI" (whose interviewPrepFor() put the
 *               company's name into a question). The kit page,
 *               #/candidate/interview-prep/<id>: role (never the company),
 *               date, time, duration, round, mode, venue or meeting link once
 *               released (Google Maps link; Join active 15 minutes before),
 *               contact, likely questions with "why they ask", tips, the
 *               bring-list as a checklist, Add to calendar (.ics) and
 *               "Practice with AI Assistant".
 *   Recruiter   Schedule Interview gets round, venue / meeting link,
 *               duration, contact, instructions, "release to candidate" and
 *               "send prep kit"; the Applications list shows kit sent /
 *               viewed / checklist n of m; a Prep kit panel previews exactly
 *               what the candidate sees and edits, regenerates and sends it.
 *
 * The server builds the candidate's view from a database view that has no
 * company column; nothing here adds one.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__tlPrepKit) return;
  window.__tlPrepKit = true;

  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api() { return window.TL && TL.api; }
  function say(msg, icon) { if (typeof window.toast === 'function') window.toast(msg, icon); }
  function role() { return (typeof STATE !== 'undefined' && STATE.session && STATE.session.role) || null; }
  function me() { return (typeof STATE !== 'undefined' && STATE.session) || null; }

  function css() {
    if (document.getElementById('tlpkCss')) return;
    var s = document.createElement('style');
    s.id = 'tlpkCss';
    s.textContent = [
      '.tlpk{max-width:760px;margin:0 auto}',
      '.tlpk .card{background:#fff;border:1px solid #e6ebf2;border-radius:14px;padding:16px 18px;margin-bottom:12px}',
      '.tlpk h1{margin:0;font-size:21px;font-weight:800;color:#16202c}',
      '.tlpk h2{margin:0 0 10px;font-size:15px;font-weight:800;color:#16202c}',
      '.tlpk .soft{color:#6b7a90;font-size:12.5px}',
      '.tlpk .facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:12px}',
      '.tlpk .fact{background:#f6f8fb;border-radius:10px;padding:9px 11px}.tlpk .fact b{display:block;font-size:13.5px;color:#16202c}',
      '.tlpk .fact span{font-size:11px;color:#6b7a90;text-transform:uppercase;letter-spacing:.04em}',
      '.tlpk .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}',
      '.tlpk .b{border:1px solid #d5dce6;background:#fff;border-radius:9px;padding:9px 14px;font-size:13px;font-weight:700;cursor:pointer;color:#1d2733;text-decoration:none;display:inline-flex;gap:6px;align-items:center}',
      '.tlpk .b.pri{background:var(--cap-blue,#1d6ff2);border-color:var(--cap-blue,#1d6ff2);color:#fff}',
      '.tlpk .b[disabled]{opacity:.5;cursor:not-allowed}',
      '.tlpk details{border-bottom:1px solid #f0f3f7;padding:10px 0}.tlpk details:last-child{border-bottom:0}',
      '.tlpk summary{cursor:pointer;font-weight:700;font-size:14px;list-style-position:outside}',
      '.tlpk .why{margin-top:6px;font-size:13px;color:#4b5565;background:#f6f8fb;border-radius:8px;padding:8px 10px}',
      '.tlpk .topic{display:inline-block;font-size:10.5px;font-weight:800;color:#1b4f9e;background:#e7f0ff;border-radius:99px;padding:1px 7px;margin-left:6px;vertical-align:middle}',
      '.tlpk ul.tips{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px;font-size:13.5px}',
      '.tlpk .chk{display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid #f0f3f7;font-size:14px;cursor:pointer}',
      '.tlpk .chk input{width:20px;height:20px}',
      '.tlpk .chk.done span{text-decoration:line-through;color:#8a94a6}',
      '.tlpk .note{background:#fff7e6;border:1px solid #ffd591;color:#874d00;border-radius:10px;padding:10px 12px;font-size:13px}',
      '.tlpk .pill{display:inline-block;font-size:11px;font-weight:800;border-radius:99px;padding:3px 9px;background:#e7f0ff;color:#1b4f9e}',
      '.tlpk-chip{display:inline-block;font-size:11px;font-weight:700;border-radius:99px;padding:2px 8px;background:#eef1f5;color:#5b6678;margin-top:4px;white-space:nowrap}',
      '.tlpk-chip.ok{background:#e6f6ec;color:#1e7a3c}',
      '.tlpk-ov{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9000;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:20px 12px}',
      '.tlpk-box{background:#f4f6f9;border-radius:14px;max-width:980px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.25)}',
      '.tlpk-hd{background:#fff;border-radius:14px 14px 0 0;padding:14px 18px;border-bottom:1px solid #e6ebf2;display:flex;gap:10px;align-items:center}',
      '.tlpk-hd h3{margin:0;font-size:17px;flex:1}',
      '.tlpk-cols{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:14px}',
      '.tlpk-cols .card{background:#fff;border:1px solid #e6ebf2;border-radius:12px;padding:14px}',
      '.tlpk-f label{display:block;font-size:12px;font-weight:700;margin:8px 0 4px}',
      '.tlpk-f input,.tlpk-f select,.tlpk-f textarea{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5dce6;border-radius:8px;font-size:13px;font-family:inherit}',
      '.tlpk-warn{background:#fff7e6;border:1px solid #ffd591;color:#874d00;border-radius:8px;padding:8px 10px;font-size:12.5px;margin-top:6px}',
      '.tlpk-err{color:#b42318;font-size:12.5px;margin-top:6px}',
      '@media (max-width:760px){.tlpk-cols{grid-template-columns:1fr}.tlpk-ov{padding:0}.tlpk-box{border-radius:0}}',
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------------------ *
   * the kit, as the candidate sees it (also the recruiter's preview)
   * ------------------------------------------------------------------ */

  /* The page's fixed words come from the server (labels, in the
     candidate's preferred language - api/src/interview/prep-kit-i18n.js);
     these English ones are only the fallback for an older server. */
  var EN = {
    back: '← Interviews', date: 'Date', duration: 'Duration', round: 'Round', toBeConfirmed: 'To be confirmed',
    addToCalendar: '📅 Add to calendar', practice: '💬 Practice with AI Assistant', where: 'Where', venue: 'Venue',
    openInMaps: '📍 Open in Google Maps', venuePending: 'The venue address will be shared here once it is confirmed.',
    phoneCall: 'The interviewer will call you on your registered phone number.',
    aiInterview: 'This is a TeamLink AI interview, taken in your browser.', meetingLink: 'Meeting link',
    join: '🎥 Join interview', linkOpen: 'The link is open.', joinOpens: 'Join opens 15 minutes before the start.',
    linkPending: 'The meeting link will be shared here once it is confirmed.', contact: 'Contact',
    fromRecruiter: 'From your recruiter', questions: 'Likely questions',
    questionsHint: 'Tap a question to see why interviewers ask it.', tips: 'Tips', bring: 'What to bring',
    ready: '{done} of {total} ready', hour: '{n} hour', hours: '{n} hours', minutes: '{n} min',
    preparing: 'Your recruiter is preparing your prep kit. It will appear here, and we will send you the link.',
  };
  function L(k) {
    var x = (k && k.labels) || {};
    return function (key, vars) {
      var s = x[key] != null ? String(x[key]) : EN[key];
      if (vars) Object.keys(vars).forEach(function (v) { s = s.split('{' + v + '}').join(vars[v]); });
      return s;
    };
  }
  window.TLPrepKitLabels = L;

  function fmtDuration(m, t) {
    t = t || L(null); m = Number(m || 60);
    if (m >= 60 && m % 60 === 0) return t(m === 60 ? 'hour' : 'hours', { n: m / 60 });
    return t('minutes', { n: m });
  }

  function kitHtml(k, opts) {
    opts = opts || {};
    var t = L(k);
    var lang = k.language && k.language !== 'en' ? k.language : '';
    var now = Date.now();
    var open = k.joinOpensAt && Date.parse(k.joinOpensAt) <= now;
    var where = '';
    if (k.locationType === 'in_person') {
      where = k.venue
        ? '<div><b>' + h(t('venue')) + '</b><div style="margin-top:4px">' + h(k.venue) + '</div>'
          + (k.mapsUrl ? '<div class="btns"><a class="b" href="' + h(k.mapsUrl) + '" target="_blank" rel="noopener noreferrer">' + h(t('openInMaps')) + '</a></div>' : '') + '</div>'
        : '<div class="note">' + h(t('venuePending')) + '</div>';
    } else if (k.locationType === 'phone') {
      where = '<div>' + h(t('phoneCall')) + '</div>';
    } else if (k.locationType === 'teamlink_ai') {
      where = '<div>' + h(t('aiInterview')) + '</div>';
    } else {
      where = k.meetingLink
        ? '<div><b>' + h(t('meetingLink')) + '</b><div class="btns"><a class="b pri" data-join="1" href="' + (open ? h(k.meetingLink) : '#') + '"'
          + (open ? ' target="_blank" rel="noopener noreferrer"' : ' aria-disabled="true" style="opacity:.5;pointer-events:none"')
          + '>' + h(t('join')) + '</a></div><div class="soft" style="margin-top:6px">'
          + h(open ? t('linkOpen') : t('joinOpens')) + '</div></div>'
        : '<div class="note">' + h(t('linkPending')) + '</div>';
    }
    var contact = k.contact ? '<div style="margin-top:10px"><b>' + h(t('contact')) + '</b>: ' + h([k.contact.name, k.contact.phone].filter(Boolean).join(' · ')) + '</div>' : '';
    var bring = (k.bringList || []).map(function (b) {
      return '<label class="chk' + (b.done ? ' done' : '') + '"><input type="checkbox" data-tick="' + h(b.key) + '"' + (b.done ? ' checked' : '')
        + (opts.preview ? ' disabled' : '') + '><span>' + h(b.text) + '</span></label>';
    }).join('');
    var ready = h(t('ready', { done: Number((k.checklist || {}).done || 0), total: Number((k.checklist || {}).total || 0) }));
    return '<div class="tlpk"' + (lang ? ' lang="' + h(lang) + '"' : '') + '>'
      + (opts.preview ? '' : '<div style="margin-bottom:10px"><a class="soft" href="#/candidate/interviews" style="font-weight:700">' + h(t('back')) + '</a></div>')
      + '<div class="card"><span class="pill">' + h(k.status || 'Scheduled') + '</span>'
      + '<h1 style="margin-top:8px" lang="en">' + h(k.role) + '</h1><div class="soft" style="margin-top:3px">' + h(k.round) + (k.mode ? ' · ' + h(k.mode) : '') + '</div>'
      + '<div class="facts"><div class="fact"><span>' + h(t('date')) + '</span><b>' + h(k.when || k.date || t('toBeConfirmed')) + '</b></div>'
      + '<div class="fact"><span>' + h(t('duration')) + '</span><b>' + h(fmtDuration(k.durationMinutes, t)) + '</b></div>'
      + '<div class="fact"><span>' + h(t('round')) + '</span><b>' + h(k.round) + '</b></div></div>'
      + '<div class="btns">'
      + (opts.preview ? '<span class="b">' + h(t('addToCalendar')) + '</span><span class="b">' + h(t('practice')) + '</span>'
        : '<a class="b" href="/api/candidate/interviews/' + encodeURIComponent(k.interviewId) + '/prep-kit.ics" download="teamlink-interview.ics">' + h(t('addToCalendar')) + '</a>'
          + '<button class="b" type="button" data-practice="' + h(k.interviewId) + '">' + h(t('practice')) + '</button>')
      + '</div></div>'
      + '<div class="card"><h2>' + h(t('where')) + '</h2>' + where + contact + '</div>'
      + (k.instructions ? '<div class="card"><h2>' + h(t('fromRecruiter')) + '</h2><div style="white-space:pre-wrap;font-size:13.5px">' + h(k.instructions) + '</div></div>' : '')
      + '<div class="card"><h2>' + h(t('questions')) + '</h2><div class="soft" style="margin-bottom:6px">' + h(t('questionsHint')) + '</div>'
      + '<div lang="en">' + (k.questions || []).map(function (q) {
        return '<details><summary>' + h(q.q) + (q.topic ? '<span class="topic">' + h(q.topic) + '</span>' : '') + '</summary>'
          + (q.why ? '<div class="why">' + h(q.why) + '</div>' : '') + '</details>';
      }).join('') + '</div></div>'
      + '<div class="card"><h2>' + h(t('tips')) + '</h2><ul class="tips">' + (k.tips || []).map(function (x) { return '<li>' + h(x) + '</li>'; }).join('') + '</ul></div>'
      + '<div class="card"><h2>' + h(t('bring')) + ' <span class="soft" id="tlpkCount">' + ready + '</span></h2>' + bring + '</div>'
      + '<div style="height:18px"></div>'
      + '</div>';
  }

  /* ------------------------------------------------------------------ *
   * candidate: the kit page
   * ------------------------------------------------------------------ */

  var kits = Object.create(null);          // interviewId -> candidate view (for interviewPrepFor)

  function kitIdFromHash() {
    var m = /^#\/candidate\/interview-prep\/([^/?#]+)/.exec(location.hash || '');
    return m ? decodeURIComponent(m[1]) : null;
  }

  function wrapCandidatePage() {
    var prev = window.pageCandidateDash;
    if (typeof prev !== 'function' || prev.__tlpk) return;
    var next = function (section) {
      if (section === 'interview-prep' && role() === 'candidate') {
        css();
        var shell = prev.call(this, 'interviews');
        /* A repaint of the page (any render()) shows the kit already loaded
           for this interview while it is fetched again, instead of
           flashing "Loading" and losing the ticks on screen. */
        var cid = kitIdFromHash();
        var cached = cid && kits[cid] && kits[cid].kitReady ? kits[cid] : null;
        var me0 = null;
        try { me0 = DATA.candidateById(STATE.session.id); } catch (e) { /* no profile yet */ }
        var loading = { te: 'మీ ప్రిపరేషన్ కిట్ లోడ్ అవుతోంది…', hi: 'आपकी तैयारी किट लोड हो रही है…' }[(me0 || {}).preferredLanguage] || 'Loading your prep kit…';
        var root = '<div id="tlpkRoot">' + (cached ? kitHtml(cached)
          : '<div class="tlpk"><div class="card">' + h(loading) + '</div></div>') + '</div>';
        var at = typeof shell === 'string' ? shell.indexOf('<div class="cp-wrap">') : -1;
        var end = at >= 0 ? shell.indexOf('<button class="cp-fab"', at) : -1;
        if (at >= 0 && end > at) {
          var head = shell.slice(0, at + '<div class="cp-wrap">'.length);
          var tail = shell.slice(shell.lastIndexOf('</div>', end), shell.length);
          return head + root + tail;
        }
        return '<div style="padding:20px 16px">' + root + '</div>';
      }
      return prev.apply(this, arguments);
    };
    next.__tlpk = true;
    window.pageCandidateDash = next;
  }

  var shownFor = null;
  function fillKitPage() {
    var id = kitIdFromHash();
    var root = document.getElementById('tlpkRoot');
    if (!id || !root || !api()) return;
    if (root.getAttribute('data-for') === id && root.getAttribute('data-done') === '1') return;
    root.setAttribute('data-for', id);
    api().get('/candidate/interviews/' + encodeURIComponent(id) + '/prep-kit').then(function (r) {
      var k = r.kit;
      kits[id] = k;
      var el = document.getElementById('tlpkRoot');
      if (!el) return;
      if (!k.kitReady) {
        var t = L(k);
        el.innerHTML = '<div class="tlpk"><div style="margin-bottom:10px"><a class="soft" href="#/candidate/interviews" style="font-weight:700">' + h(t('back')) + '</a></div>'
          + '<div class="card"><h1>' + h(k.role) + '</h1><div class="soft">' + h(k.round) + ' · ' + h(k.when) + '</div>'
          + '<p>' + h(t('preparing')) + '</p></div></div>';
        el.setAttribute('data-done', '1');
        return;
      }
      el.innerHTML = kitHtml(k);
      el.setAttribute('data-done', '1');
      if (shownFor !== id) {
        shownFor = id;
        api().post('/candidate/interviews/' + encodeURIComponent(id) + '/prep-kit/viewed', {}).catch(function () {});
      }
      scheduleJoin(k);
    }, function (err) {
      var el = document.getElementById('tlpkRoot');
      if (el) el.innerHTML = '<div class="tlpk"><div class="card">' + h((err && err.message) || 'This prep kit could not be loaded.') + '</div></div>';
    });
  }

  var joinTimer = null;
  function scheduleJoin(k) {
    if (joinTimer) clearTimeout(joinTimer);
    if (!k.joinOpensAt || !k.meetingLink) return;
    var wait = Date.parse(k.joinOpensAt) - Date.now();
    if (wait > 0 && wait < 24 * 3600 * 1000) {
      joinTimer = setTimeout(function () {
        var el = document.getElementById('tlpkRoot');
        if (el && kitIdFromHash() === k.interviewId) el.innerHTML = kitHtml(k);
      }, wait + 500);
    }
  }

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.hasAttribute || !t.hasAttribute('data-tick') || t.disabled) return;
    var id = kitIdFromHash();
    if (!id) return;
    var key = t.getAttribute('data-tick');
    var lab = t.closest('.chk');
    if (lab) lab.classList.toggle('done', t.checked);
    api().put('/candidate/interviews/' + encodeURIComponent(id) + '/prep-kit/checklist', { itemKey: key, done: t.checked }).then(function (r) {
      kits[id] = r.kit;
      var c = document.getElementById('tlpkCount');
      if (c) c.textContent = L(r.kit)('ready', { done: r.kit.checklist.done, total: r.kit.checklist.total });
    }, function (err) { t.checked = !t.checked; say((err && err.message) || 'Could not save', '⚠️'); });
  });

  document.addEventListener('click', function (e) {
    var p = e.target.closest && e.target.closest('[data-practice]');
    if (!p) return;
    e.preventDefault();
    var id = p.getAttribute('data-practice');
    if (window.TLCareerAssistant && typeof TLCareerAssistant.openWith === 'function') {
      TLCareerAssistant.openWith({ interviewId: id });
    } else if (typeof window.navigate === 'function') {
      window.navigate('/candidate/assistant');
    }
  });

  /* The Interviews page: "Prep Kit" in place of "Prepare with AI". */
  function wrapInterviewsPage() {
    var prev = window.cpInterviews;
    if (typeof prev !== 'function' || prev.__tlpk) return;
    var next = function () {
      var out = prev.apply(this, arguments);
      try {
        var c = (STATE.session && DATA.candidateById) ? DATA.candidateById(STATE.session.id) : null;
        if (!c || typeof out !== 'string') return out;
        var t = STATE.cpIv;
        var list = (DATA.interviews || []).filter(function (i) { return i.candidateId === c.id; }).filter(function (i) {
          return t === 'upcoming' ? ['Completed', 'Cancelled'].indexOf(i.status) < 0 : (t === 'completed' ? i.status === 'Completed' : i.status === 'Cancelled');
        });
        var n = 0;
        var marker = '<button class="cp-btn" onclick="cpAsk(\'Prepare me for an interview\')">🤖 Prepare with AI</button>';
        out = out.split(marker).map(function (part, idx, arr) {
          if (idx === arr.length - 1) return part;
          var iv = list[n++];
          return part + (iv ? '<button class="cp-btn pri" onclick="navigate(\'/candidate/interview-prep/' + encodeURIComponent(iv.id) + '\')">📘 Prep Kit</button>' : '');
        }).join('');
      } catch (e) { /* the page still renders without the button */ }
      return out;
    };
    next.__tlpk = true;
    window.cpInterviews = next;
  }

  /*
   * The old interviewPrepFor() built "Why ... at <company>?" for the AI
   * Career Assistant. The candidate side uses the kit now: its questions
   * when it is loaded, a company-free generic set until then.
   */
  function replacePrepFor() {
    window.interviewPrepFor = function (iv) {
      var k = iv && kits[iv.id];
      if (k && k.questions && k.questions.length) {
        return { questions: k.questions.map(function (q) { return q.q; }), tips: (k.tips || []).slice() };
      }
      var job = null;
      try { job = DATA.jobById(iv.jobId); } catch (e) {}
      var skills = (job && job.skills) || [];
      var questions = skills.slice(0, 4).map(function (s) { return 'Walk me through a project where you used ' + s + ' to solve a real problem.'; });
      questions.push('Why are you interested in this ' + ((job && job.title) || '') + ' role?');
      var tips = ['Review the job description and prepare 2–3 concrete examples that map to it.',
        'Prepare 2–3 thoughtful questions to ask your interviewer.', 'Open your Prep Kit on the Interviews page for the full list.'];
      return { questions: questions, tips: tips };
    };
  }

  /* ------------------------------------------------------------------ *
   * recruiter: scheduling
   * ------------------------------------------------------------------ */

  function myName() {
    try {
      var s = me();
      if (typeof window.whoLabel === 'function') { var w = window.whoLabel(s.role); if (w && w.name) return w.name; }
      if (s && s.role === 'recruiter' && DATA.recruiterById) { var r = DATA.recruiterById(s.id); if (r) return r.name; }
    } catch (e) {}
    return '';
  }

  function prepFieldsHtml(v) {
    v = v || {};
    var lt = v.locationType || 'video';
    return '<div class="tlpk-f" id="tlpkFields">'
      + '<label>Round</label><select id="tlpkType">' + ['Technical (Human)', 'Client Round', 'HR Round', 'AI Interview'].map(function (t) {
        return '<option' + (v.type === t ? ' selected' : '') + '>' + t + '</option>'; }).join('') + '</select>'
      + '<label>Where</label><select id="tlpkLoc">' + [['video', 'Video call'], ['in_person', 'In person'], ['phone', 'Phone'], ['teamlink_ai', 'TeamLink AI']].map(function (o) {
        return '<option value="' + o[0] + '"' + (lt === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>'
      + '<div data-for="in_person"' + (lt === 'in_person' ? '' : ' hidden') + '><label>Venue address</label><textarea id="tlpkVenue" rows="2" maxlength="500">' + h(v.venueAddress || '') + '</textarea></div>'
      + '<div data-for="video"' + (lt === 'video' ? '' : ' hidden') + '><label>Meeting link</label><input id="tlpkLink" maxlength="500" placeholder="https://" value="' + h(v.meetingLink || '') + '"></div>'
      + '<label>Duration (minutes)</label><input id="tlpkDur" type="number" min="5" max="600" value="' + h(v.durationMinutes || 60) + '">'
      + '<label>Contact person</label><input id="tlpkCPerson" maxlength="120" value="' + h(v.contactPerson != null ? v.contactPerson : myName()) + '">'
      + '<label>Contact phone</label><input id="tlpkCPhone" maxlength="30" value="' + h(v.contactPhone || '') + '">'
      + '<label>Instructions for the candidate</label><textarea id="tlpkInstr" rows="3" maxlength="1000" placeholder="e.g. Ask for the TeamLink desk at reception">' + h(v.candidateInstructions || '') + '</textarea>'
      + '<label style="display:flex;gap:7px;align-items:center;font-weight:600"><input type="checkbox" id="tlpkRelease" style="width:auto"' + (v.detailsReleasedAt ? ' checked' : '') + '> Release venue / meeting link to candidate</label>'
      + '<div class="tlpk-warn">The address may reveal the company. Release only when confirmed with the client.</div>'
      + (v.forSchedule ? '<label style="display:flex;gap:7px;align-items:center;font-weight:600"><input type="checkbox" id="tlpkSendKit" style="width:auto" checked> Send the prep kit with the invitation</label>' : '')
      + '</div>';
  }

  function readFields() {
    var g = function (id) { var el = document.getElementById(id); return el ? el.value : undefined; };
    var lt = g('tlpkLoc');
    var out = {
      type: g('tlpkType'), locationType: lt,
      venueAddress: lt === 'in_person' ? (g('tlpkVenue') || '').trim() : undefined,
      meetingLink: lt === 'video' ? (g('tlpkLink') || '').trim() : undefined,
      durationMinutes: g('tlpkDur') ? Number(g('tlpkDur')) : undefined,
      contactPerson: (g('tlpkCPerson') || '').trim(), contactPhone: (g('tlpkCPhone') || '').trim(),
      candidateInstructions: (g('tlpkInstr') || '').trim(),
      releaseDetails: !!(document.getElementById('tlpkRelease') || {}).checked,
    };
    var sk = document.getElementById('tlpkSendKit');
    if (sk) out.sendKit = sk.checked;
    Object.keys(out).forEach(function (k) { if (out[k] === undefined) delete out[k]; });
    return out;
  }

  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'tlpkLoc') {
      var v = e.target.value;
      document.querySelectorAll('#tlpkFields [data-for]').forEach(function (d) { d.hidden = d.getAttribute('data-for') !== v; });
    }
  });

  function wrapSchedule() {
    var prevModal = window.mjInterviewModal;
    if (typeof prevModal === 'function' && !prevModal.__tlpk) {
      var m = function () {
        var out = prevModal.apply(this, arguments);
        try {
          css();
          var body = document.querySelector('#fcrModalHost .fcr-jd-body') || document.querySelector('.fcr-jd-body');
          var mode = document.getElementById('mjIvMode');
          if (body && !document.getElementById('tlpkFields')) {
            body.insertAdjacentHTML('beforeend', prepFieldsHtml({ forSchedule: true }));
            if (mode) mode.addEventListener('change', function () {
              var map = { 'Video Call': 'video', 'In Person': 'in_person', 'Phone': 'phone', 'TeamLink AI': 'teamlink_ai' };
              var sel = document.getElementById('tlpkLoc');
              if (sel && map[mode.value]) { sel.value = map[mode.value]; sel.dispatchEvent(new Event('change', { bubbles: true })); }
            });
          }
        } catch (e) {}
        return out;
      };
      m.__tlpk = true;
      window.mjInterviewModal = m;
    }
    if (window.TL && typeof TL.scheduleInterview === 'function' && !TL.scheduleInterview.__tlpk) {
      var prev = TL.scheduleInterview;
      var s = function (opts) {
        if (document.getElementById('tlpkFields')) {
          var f = readFields();
          opts = Object.assign({}, opts, f);
          if (f.type) opts.type = f.type;
          // The integration builds the POST body from a fixed list; send
          // ours with it by posting directly when there is more to say.
          return api().post('/interviews', Object.assign({
            candidateId: opts.candidateId, jobId: opts.jobId, type: opts.type || 'Technical (Human)',
            date: opts.date, time: opts.time, mode: opts.mode || 'Video Call', interviewer: opts.interviewer,
          }, f)).then(function (res) {
            DATA.interviews.push(res.interview);
            if (res.notify && res.notify.prepKit === 'sent') say('Prep kit sent to the candidate', '📘');
            setTimeout(refreshStatuses, 400);
            return res.interview;
          });
        }
        return prev.apply(this, arguments);
      };
      s.__tlpk = true;
      TL.scheduleInterview = s;
    }
  }

  /* ------------------------------------------------------------------ *
   * recruiter: kit status on the Applications list, and the kit panel
   * ------------------------------------------------------------------ */

  var statuses = Object.create(null);
  var statusAt = 0;

  function interviewFor(appIds, row) {
    var list = (typeof DATA !== 'undefined' && DATA.interviews) || [];
    var hit = null;
    appIds.forEach(function (a) { list.forEach(function (iv) { if (iv.applicationId === a && iv.status !== 'Cancelled') hit = iv; }); });
    if (hit) return hit;
    var app = (DATA.applications || []).filter(function (a) { return appIds.indexOf(a.id) >= 0; })[0];
    if (!app) return null;
    list.forEach(function (iv) { if (iv.candidateId === app.candidateId && iv.jobId === app.jobId && iv.status !== 'Cancelled') hit = iv; });
    return hit;
  }

  function chipFor(st) {
    if (!st || !st.hasKit) return '<span class="tlpk-chip" data-tlpk="1">Prep kit: not made</span>';
    var parts = [st.sent ? 'Kit sent ✓' : 'Kit not sent', st.viewed ? 'Viewed ✓' : 'Not viewed', 'Checklist ' + st.done + ' of ' + st.total];
    return '<span class="tlpk-chip' + (st.viewed ? ' ok' : '') + '" data-tlpk="1">' + h(parts.join(' · ')) + '</span>';
  }

  function decorateRows() {
    var r = role();
    if (r !== 'recruiter' && r !== 'admin' && r !== 'bde') return;
    if (!/^#\/(recruiter|admin)\/applications\b/.test(location.hash || '')) return;
    var need = [];
    document.querySelectorAll('#app table.data tbody tr').forEach(function (tr) {
      var ids = (tr.getAttribute('data-tlsq-app') || '').split(',').filter(Boolean);
      if (!ids.length) {
        var re = /'(app_[A-Za-z0-9_-]+)'/g; var m;
        while ((m = re.exec(tr.innerHTML))) if (ids.indexOf(m[1]) < 0) ids.push(m[1]);
      }
      if (!ids.length) return;
      var iv = interviewFor(ids, tr);
      if (!iv) return;
      tr.setAttribute('data-tlpk-iv', iv.id);
      need.push(iv.id);
      var stage = tr.querySelector('td[data-l="Stage"]');
      if (stage) {
        stage.querySelectorAll('[data-tlpk]').forEach(function (x) { x.remove(); });
        stage.insertAdjacentHTML('beforeend', '<div data-tlpk="1">' + chipFor(statuses[iv.id]) + '</div>');
      }
      var actions = tr.querySelector('td.row-actions');
      if (actions && !actions.querySelector('[data-tlpk-open]')) {
        actions.insertAdjacentHTML('beforeend', '<button class="btn btn-ghost btn-sm" type="button" data-tlpk-open="' + h(iv.id) + '">📘 Prep kit</button>');
      }
    });
    if (need.length && Date.now() - statusAt > 15000) {
      statusAt = Date.now();
      api().get('/interviews/prep-status?ids=' + encodeURIComponent(need.join(','))).then(function (r2) {
        (r2.statuses || []).forEach(function (s) { statuses[s.interviewId] = s; });
        repaintChips();
      }, function () {});
    }
  }
  function repaintChips() {
    document.querySelectorAll('tr[data-tlpk-iv]').forEach(function (tr) {
      var stage = tr.querySelector('td[data-l="Stage"]');
      if (!stage) return;
      stage.querySelectorAll('[data-tlpk]').forEach(function (x) { x.remove(); });
      stage.insertAdjacentHTML('beforeend', '<div data-tlpk="1">' + chipFor(statuses[tr.getAttribute('data-tlpk-iv')]) + '</div>');
    });
  }
  function refreshStatuses() { statusAt = 0; decorateRows(); }

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-tlpk-open]');
    if (b) { e.preventDefault(); e.stopPropagation(); openPanel(b.getAttribute('data-tlpk-open')); }
  }, true);

  function closePanel() { var el = document.getElementById('tlpkPanel'); if (el) el.remove(); }

  function openPanel(interviewId) {
    css();
    api().get('/interviews/' + encodeURIComponent(interviewId) + '/prep-kit').then(function (d) { drawPanel(interviewId, d); },
      function (err) { say((err && err.message) || 'Could not load the prep kit', '⚠️'); });
  }

  function drawPanel(interviewId, d) {
    closePanel();
    var k = d.kit || { questions: [], tips: [], bringList: [] };
    var st = d.status || {};
    var canWrite = role() === 'recruiter' || role() === 'admin';
    var el = document.createElement('div');
    el.className = 'tlpk-ov';
    el.id = 'tlpkPanel';
    el.innerHTML = '<div class="tlpk-box" role="dialog" aria-modal="true"><div class="tlpk-hd"><h3>Prep kit</h3>'
      + chipFor(st) + '<button type="button" class="btn btn-ghost btn-sm" data-close>✕</button></div>'
      + '<div class="tlpk-cols"><div>'
      + '<div class="card"><b>Interview details</b>' + prepFieldsHtml(Object.assign({}, d.interview))
      + (canWrite ? '<div style="text-align:right;margin-top:8px"><button class="btn btn-primary btn-sm" type="button" data-act="details">Save details</button></div>' : '') + '</div>'
      + '<div class="card" style="margin-top:12px"><b>Kit content</b> <span class="tlpk-chip">' + h(k.generatedBy === 'ai' ? 'AI engine' : 'Rules engine') + '</span>'
      + (k.recruiterEdited ? ' <span class="tlpk-chip">Edited by ' + h(k.editedBy || 'recruiter') + '</span>' : '')
      + (k.engineNote ? '<div class="soft" style="font-size:11.5px;color:#6b7a90;margin-top:4px">' + h(k.engineNote) + '</div>' : '')
      + '<div class="tlpk-f"><label>Questions (one per line: question | why they ask it)</label>'
      + '<textarea id="tlpkQs" rows="9">' + h((k.questions || []).map(function (q) { return q.q + (q.why ? ' | ' + q.why : ''); }).join('\n')) + '</textarea>'
      + '<label>Tips (one per line)</label><textarea id="tlpkTips" rows="5">' + h((k.tips || []).join('\n')) + '</textarea>'
      + '<label>What to bring (one per line)</label><textarea id="tlpkBring" rows="5">' + h((k.bringList || []).map(function (b) { return b.text; }).join('\n')) + '</textarea></div>'
      + '<div class="tlpk-err" id="tlpkErr"></div>'
      + (canWrite ? '<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;margin-top:8px">'
        + '<button class="btn btn-ghost btn-sm" type="button" data-act="regen">↻ Regenerate</button>'
        + '<button class="btn btn-ghost btn-sm" type="button" data-act="save">Save edits</button>'
        + '<button class="btn btn-primary btn-sm" type="button" data-act="send">✉ ' + (k.sentAt ? 'Send again' : 'Send now') + '</button></div>' : '')
      + '</div></div>'
      + '<div><div class="card"><b>What the candidate sees</b><div class="soft" style="font-size:11.5px;color:#6b7a90">Exactly this - no company name. Venue and link appear only after release.'
      + (d.preview && d.preview.language && d.preview.language !== 'en'
        ? ' Shown in ' + ({ te: 'Telugu', hi: 'Hindi' }[d.preview.language] || d.preview.language) + ', the candidate\'s preferred language: tips, checklist and headings are translated where they are the standard text; questions stay English.'
        : '') + '</div>'
      + '<div style="margin-top:10px;background:#f4f6f9;border-radius:10px;padding:10px">' + kitHtml(d.preview || {}, { preview: true }) + '</div></div>'
      + '<div class="card" style="margin-top:12px"><b>Messages</b>' + ((d.messages || []).length ? '<div style="font-size:12px;margin-top:6px">'
        + d.messages.slice(0, 12).map(function (m) { return '<div>' + h(m.kind) + ' · ' + h(m.channel) + ': <b>' + h(m.status) + '</b>' + (m.error ? ' <span style="color:#8a94a6">(' + h(m.error) + ')</span>' : '') + '</div>'; }).join('') + '</div>'
        : '<div class="soft">Nothing sent yet.</div>') + '</div></div></div></div>';
    document.body.appendChild(el);

    function err(m) { var e2 = document.getElementById('tlpkErr'); if (e2) e2.textContent = m || ''; }
    el.addEventListener('click', function (e) {
      if (e.target.closest('[data-close]') || e.target === el) { closePanel(); return; }
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var act = b.getAttribute('data-act');
      var base = '/interviews/' + encodeURIComponent(interviewId);
      var done = function (r, msg) { if (msg) say(msg, '📘'); drawPanel(interviewId, r); refreshStatuses(); };
      var fail = function (e2) { err((e2 && e2.message) || 'Could not save'); };
      if (act === 'details') {
        var f = readFields(); delete f.type;
        api().put(base + '/prep', f).then(function (r) { done(r, f.releaseDetails ? 'Details saved and released to the candidate' : 'Details saved'); }, fail);
      } else if (act === 'regen') {
        api().post(base + '/prep-kit/regenerate', {}).then(function (r) { done(r, 'Prep kit regenerated'); }, fail);
      } else if (act === 'save') {
        var qs = (document.getElementById('tlpkQs').value || '').split('\n').map(function (l) {
          var p = l.split('|'); return { q: (p[0] || '').trim(), why: p.slice(1).join('|').trim() };
        }).filter(function (q) { return q.q; });
        var tips = (document.getElementById('tlpkTips').value || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
        var bring = (document.getElementById('tlpkBring').value || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean).map(function (t, i) {
          var old = (k.bringList || []).filter(function (b2) { return b2.text === t; })[0];
          return { key: old ? old.key : 'item_' + (i + 1), text: t };
        });
        api().put(base + '/prep-kit', { questions: qs, tips: tips, bringList: bring }).then(function (r) { done(r, 'Prep kit saved'); }, fail);
      } else if (act === 'send') {
        api().post(base + '/prep-kit/send', {}).then(function (r) { done(r, 'Prep kit sent to the candidate'); }, fail);
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * keeping up with the page
   * ------------------------------------------------------------------ */
  function sweep() {
    if (kitIdFromHash() && role() === 'candidate') fillKitPage();
    decorateRows();
  }
  var queued = false;
  function queue() {
    if (queued) return;
    queued = true;
    setTimeout(function () { queued = false; try { sweep(); } catch (e) { if (window.console) console.warn('[prep-kit]', e && e.message); } }, 150);
  }

  function install() {
    wrapCandidatePage(); wrapInterviewsPage(); replacePrepFor(); wrapSchedule();
    var prev = window.render;
    if (typeof prev === 'function' && !prev.__tlpk) {
      var next = function () { var out = prev.apply(this, arguments); queue(); return out; };
      next.__tlpk = true;
      window.render = next;
    }
    try { new MutationObserver(queue).observe(document.getElementById('app') || document.body, { childList: true, subtree: true }); } catch (e) {}
    queue();
  }
  if (document.readyState === 'complete') install();
  else window.addEventListener('load', install);

  window.TLPrepKit = { open: openPanel, kitFor: function (id) { return kits[id] || null; } };
})();
