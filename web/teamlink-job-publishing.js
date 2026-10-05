/* =====================================================================
   TEAMLINK — Save & Post: multi-destination job publishing (0112)

   ON THE RECRUITER'S JOB FORMS (AI Job Creation, Edit, Post A Walk-in
   Job, Post An Internship): a "Post to" block with one tick per
   destination, and the primary button reads "Save & Post".

     TeamLink Job Portal   ticked, and follows the job's own Status
     TeamLink Website      ticked by default (the public jobs feed)
     Naukri / Shine /      unticked by default, each with its REAL state:
     Indeed                "Connected" or "Integration Required" (with a
                           link to Administration -> Integrations for an
                           administrator). A tick on one that is not
                           connected is remembered: the job goes out by
                           itself once an administrator connects it.

   Save & Post saves the job exactly as before, then hands the ticked
   destinations to the server (PUT /api/jobs/:id/publications). The server
   publishes, records the external id and URL, and answers with each
   destination's status - "Posted" only after a real confirmation.

   ON MANAGE JOBS, the recruiter's Jobs table and the job's own page:
   one badge per destination, linking to the external URL once Posted,
   with Publish now / Retry where something is waiting.

   ADMINISTRATION -> INTEGRATIONS (admins only; one nav entry appended to
   the admin sidebar, the same way Job Sources is): per platform, switch
   on/off, connection type, endpoint, credentials, Test Connection,
   Publish waiting jobs, last sync and errors. Credentials are typed here
   and sent to the server once; the server never sends them back - an
   administrator sees "•••• saved" and at most the last 4 characters.

   ADDITIVE. Every existing function keeps doing what it did; this file
   wraps publishGeneratedJob, saveEditJob, tnavWalkinSubmit,
   tnavInternshipSubmit, fcrRegisterPosting and pageAdminDash.
   ===================================================================== */
(function () {
  'use strict';

  var S = {
    dests: null, destsAt: 0, destsLoading: null,
    choice: Object.create(null), pubs: Object.create(null), pubsAt: Object.create(null), fetching: Object.create(null),
    adm: { list: null, keyOk: true, loading: false, error: '', busy: {}, result: {}, events: {}, open: {} },
  };
  var PENDING = null;           // the selection waiting for the job a form is creating

  function api() { return (window.TL && window.TL.api) || null; }
  function ready() { return !!(window.TL && TL.ready && api()); }
  function role() { return (window.STATE && STATE.session && STATE.session.role) || ''; }
  function staff() { return role() === 'recruiter' || role() === 'admin'; }
  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function say(m, i) { if (typeof window.toast === 'function') window.toast(m, i || 'i'); }
  function errText(e, d) { return (e && e.message) || d; }
  function safeHref(u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : ''; }
  var SHORT = { TEAMLINK_PORTAL: 'TeamLink Portal', TEAMLINK_WEBSITE: 'TeamLink Website', NAUKRI: 'Naukri', SHINE: 'Shine', INDEED: 'Indeed' };
  function short(k, label) { return SHORT[k] || label || k; }
  function when(iso) {
    if (!iso) return 'never';
    try {
      var d = new Date(iso), m = Math.round((Date.now() - d.getTime()) / 60000);
      if (m < 1) return 'just now';
      if (m < 60) return m + ' min ago';
      if (m < 1440) return Math.round(m / 60) + ' h ago';
      return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return String(iso); }
  }

  /* ================================================================ *
   * destinations
   * ================================================================ */
  function loadDests(force) {
    var a = api();
    if (!a || !staff()) return Promise.resolve([]);
    if (!force && S.dests && Date.now() - S.destsAt < 30000) return Promise.resolve(S.dests);
    if (S.destsLoading) return S.destsLoading;
    S.destsLoading = a.get('/publishing/destinations').then(function (r) {
      S.dests = (r && r.destinations) || [];
      S.destsAt = Date.now();
      S.destsLoading = null;
      return S.dests;
    }, function () { S.destsLoading = null; return S.dests || []; });
    return S.destsLoading;
  }

  /* ================================================================ *
   * the "Post to" block on the job forms
   * ================================================================ */
  var FORMS = [
    { anchor: 'njStatus', kind: 'new' },
    { anchor: 'ejStatus', kind: 'edit' },
    { anchor: 'twStatus', kind: 'walkin' },
    { anchor: 'tiStatus', kind: 'internship' },
  ];
  var BUTTONS = [
    ['publishGeneratedJob(', 'Publish job'],
    ['saveEditJob(', 'Save changes'],
    ['tnavWalkinSubmit(', 'Publish Walk-in Job'],
    ['tnavInternshipSubmit(', null],
  ];

  function chip(status, label, title) {
    var cls = { posted: 'ok', awaiting_confirmation: 'wait', pending: 'wait', posting: 'wait', failed: 'bad',
      integration_required: 'warn', removed: 'off', ready: 'ok' }[status] || 'off';
    return '<span class="tljp-chip ' + cls + '"' + (title ? ' title="' + h(title) + '"' : '') + '>' + h(label) + '</span>';
  }
  function pubChip(p) {
    var label = p.status === 'awaiting_confirmation' ? 'Listed in feed — awaiting confirmation' : p.statusLabel;
    return chip(p.status, label, p.lastError || '');
  }
  function integrationsLink() {
    return role() === 'admin'
      ? ' <a class="tljp-link" href="#/admin/integrations" onclick="if(window.fcrCloseModal)fcrCloseModal()">Set up in Integrations</a>'
      : '';
  }

  function blockHtml(kind, jobId) {
    var dests = S.dests || [];
    var pubs = jobId ? (S.pubs[jobId] || null) : null;
    var byDest = {};
    (pubs || []).forEach(function (p) { byDest[p.destination] = p; });
    var chosen = S.choice[kind + ':' + (jobId || '')];
    var rows = dests.map(function (d) {
      var p = byDest[d.key];
      var on = chosen ? chosen.indexOf(d.key) >= 0 : p ? p.desired === 'published' : d.defaultSelected;
      if (d.locked) on = true;
      var state = '';
      if (p && p.desired === 'published') state = pubChip(p) + (p.status === 'posted' && safeHref(p.externalUrl)
        ? ' <a class="tljp-link" href="' + h(p.externalUrl) + '" target="_blank" rel="noopener">View</a>' : '');
      else if (!d.ready) state = chip('integration_required', 'Integration Required');
      else state = chip('ready', d.kind === 'own' ? 'Works now' : 'Connected');
      if (!d.ready && d.kind !== 'own') state += integrationsLink();
      var id = 'tljpD_' + d.key;
      return '<div class="tljp-row"><label for="' + id + '"><input type="checkbox" id="' + id + '" data-dest="' + h(d.key) + '"'
        + (on ? ' checked' : '') + (d.locked ? ' disabled title="An Active job is always on the TeamLink Job Portal; Status decides it."' : '')
        + '> <b>' + h(d.label) + '</b></label><span class="tljp-state">' + state + '</span></div>';
    }).join('');
    var waiting = dests.some(function (d) { return !d.ready; });
    return '<legend>Post to</legend>'
      + (rows || '<div class="tljp-note">Loading destinations…</div>')
      + (waiting && role() !== 'admin' ? '<div class="tljp-note">Integration Required: an administrator connects these under Administration → Integrations.</div>' : '')
      + '<div class="tljp-note">Save &amp; Post saves the job, then publishes it to every ticked destination. '
      + 'A destination that needs an integration publishes automatically once it is connected; nothing is sent to it before then.</div>';
  }

  function relabel() {
    BUTTONS.forEach(function (b) {
      var els = document.querySelectorAll('button[onclick*="' + b[0] + '"]');
      Array.prototype.forEach.call(els, function (el) {
        if (!el.classList.contains('btn-primary') || el.__tljp) return;
        el.__tljp = true;
        el.setAttribute('data-was', (el.textContent || '').trim());
        el.textContent = 'Save & Post';
      });
    });
  }

  function injectForms() {
    if (!staff()) return;
    FORMS.forEach(function (f) {
      var a = document.getElementById(f.anchor);
      if (!a) return;
      var existing = document.getElementById('tljpDest_' + f.kind);
      var jobId = f.kind === 'edit' ? (window.STATE && STATE.editJobId) : null;
      if (existing && existing.getAttribute('data-job') === String(jobId || '')) {
        if (existing.getAttribute('data-ready') !== '1' && S.dests) paintBlock(existing, f.kind, jobId);
        return;
      }
      if (existing) existing.remove();
      var row = a.closest('.fgroup, .fcr-jd-row') || a.parentNode;
      var after = document.getElementById('tlpuDeadline');
      if (!(after && after.getAttribute('data-for') === f.anchor)) after = row;
      var grid = after.parentNode;
      var box = document.createElement('fieldset');
      box.className = 'tljp-dest';
      box.id = 'tljpDest_' + f.kind;
      box.style.gridColumn = '1 / -1';
      box.setAttribute('data-for', f.kind);
      box.setAttribute('data-job', String(jobId || ''));
      if (after.nextSibling) grid.insertBefore(box, after.nextSibling); else grid.appendChild(box);
      /* What was ticked survives a re-render (Generate JD redraws the form). */
      box.addEventListener('change', function () { S.choice[f.kind + ':' + (jobId || '')] = readSelection(box); });
      paintBlock(box, f.kind, jobId);
      loadDests().then(function () {
        if (jobId && !S.pubs[jobId]) return fetchPubs([jobId]).then(function () { paintBlock(box, f.kind, jobId); });
        paintBlock(box, f.kind, jobId);
      });
    });
    relabel();
  }
  function paintBlock(box, kind, jobId) {
    if (!box || !box.isConnected) return;
    var keep = readSelection(box);
    box.innerHTML = blockHtml(kind, jobId);
    if (keep && box.getAttribute('data-ready') === '1') {
      Array.prototype.forEach.call(box.querySelectorAll('input[data-dest]'), function (el) {
        if (!el.disabled) el.checked = keep.indexOf(el.getAttribute('data-dest')) >= 0;
      });
    }
    if (S.dests) box.setAttribute('data-ready', '1');
  }
  function readSelection(box) {
    if (!box || box.getAttribute('data-ready') !== '1') return null;
    var out = [];
    Array.prototype.forEach.call(box.querySelectorAll('input[data-dest]'), function (el) {
      if (el.checked) out.push(el.getAttribute('data-dest'));
    });
    return out;
  }

  /* ================================================================ *
   * Save & Post -> the server
   * ================================================================ */
  function summary(pubs) {
    var parts = (pubs || []).filter(function (p) { return p.desired === 'published'; }).map(function (p) {
      return short(p.destination, p.label) + ': ' + (p.status === 'awaiting_confirmation' ? 'listed in feed, awaiting confirmation' : p.statusLabel);
    });
    return parts.join(' · ');
  }
  function busy(pubs) { return (pubs || []).some(function (p) { return p.desired === 'published' && (p.status === 'pending' || p.status === 'posting'); }); }

  function saveDestinations(jobId, sel, tries) {
    var a = api();
    if (!a || !jobId || !sel) return;
    tries = tries || 0;
    a.put('/jobs/' + encodeURIComponent(jobId) + '/publications', { destinations: sel }).then(function (r) {
      S.pubs[jobId] = r.publications || [];
      S.pubsAt[jobId] = Date.now();
      if (r.destinations) { S.dests = r.destinations; S.destsAt = Date.now(); }
      var failed = S.pubs[jobId].some(function (p) { return p.status === 'failed'; });
      say(summary(S.pubs[jobId]) || 'Saved', failed ? '⚠️' : '📢');
      decorate(true);
      if (busy(S.pubs[jobId])) poll(jobId, 0);
    }, function (err) {
      /* The job itself is still on its way to the server. */
      if (err && (err.status === 404 || err.status === 403) && tries < 15) {
        setTimeout(function () { saveDestinations(jobId, sel, tries + 1); }, 1500);
        return;
      }
      say(errText(err, 'The job was saved, but publishing could not start') + ' — use Publish now under Manage Jobs', '⚠️');
    });
  }
  function poll(jobId, n) {
    if (n > 12) return;
    setTimeout(function () {
      fetchPubs([jobId], true).then(function () {
        decorate(true);
        if (busy(S.pubs[jobId])) poll(jobId, n + 1);
      });
    }, 2500);
  }

  function fetchPubs(ids, force) {
    var a = api();
    if (!a || !staff()) return Promise.resolve();
    var want = ids.filter(function (id) {
      return id && !S.fetching[id] && (force || !S.pubsAt[id] || Date.now() - S.pubsAt[id] > 20000);
    });
    if (!want.length) return Promise.resolve();
    want.forEach(function (id) { S.fetching[id] = true; });
    var chunks = [];
    for (var i = 0; i < want.length; i += 100) chunks.push(want.slice(i, i + 100));
    return Promise.all(chunks.map(function (c) {
      return a.get('/job-publications?jobIds=' + c.map(encodeURIComponent).join(',')).then(function (r) {
        c.forEach(function (id) { S.pubs[id] = (r.publications && r.publications[id]) || []; S.pubsAt[id] = Date.now(); });
      }, function () {
        /* the badges stay as they were; asked again in a minute, not in a loop */
        c.forEach(function (id) { S.pubsAt[id] = Date.now() - 20000 + 60000; });
      });
    })).then(function () { want.forEach(function (id) { delete S.fetching[id]; }); });
  }

  window.tljpPublishNow = function (jobId, dest) {
    var a = api();
    if (!a) return;
    var b = document.querySelector('[data-tljp-now="' + jobId + '"]');
    if (b) { b.disabled = true; b.textContent = 'Publishing…'; }
    a.post('/jobs/' + encodeURIComponent(jobId) + '/publications/publish-now', dest ? { destination: dest } : {}).then(function (r) {
      S.pubs[jobId] = r.publications || [];
      S.pubsAt[jobId] = Date.now();
      say(summary(S.pubs[jobId]) || 'Nothing to publish', '📢');
      decorate(true);
    }, function (e) {
      say(errText(e, 'Could not publish now'), '⚠️');
      if (b) { b.disabled = false; b.textContent = 'Publish now'; }
    });
  };

  /* -------- wrapping the forms -------- */
  var CREATE_KIND = { publishGeneratedJob: 'new', tnavWalkinSubmit: 'walkin', tnavInternshipSubmit: 'internship' };
  function wrapCreate(name) {
    var prev = window[name];
    if (typeof prev !== 'function' || prev.__tljp) return;
    var next = function () {
      var sel = readSelection(document.getElementById('tljpDest_' + CREATE_KIND[name]));
      if (sel) {
        delete S.choice[CREATE_KIND[name] + ':'];
        var title = name === 'publishGeneratedJob' ? (window.STATE && STATE.jobDraft && STATE.jobDraft.title)
          : (document.getElementById(name === 'tnavWalkinSubmit' ? 'twTitle' : 'tiTitle') || {}).value;
        PENDING = { sel: sel, title: String(title || '').trim(), at: Date.now() };
      }
      return prev.apply(this, arguments);
    };
    next.__tljp = true;
    window[name] = next;
  }
  function wrapRegister() {
    var prev = window.fcrRegisterPosting;
    if (typeof prev !== 'function' || prev.__tljp) return;
    var next = function (job) {
      var p = PENDING;
      var r = prev.apply(this, arguments);
      if (p && job && job.id && Date.now() - p.at < 90000 && (!p.title || p.title === String(job.title || '').trim())) {
        PENDING = null;
        if (job.status === 'closed' || job.status === 'draft') {
          /* Inactive: recorded, and it goes out when the job is made Active. */
        }
        setTimeout(function () { saveDestinations(job.id, p.sel); }, 900);
      }
      return r;
    };
    next.__tljp = true;
    window.fcrRegisterPosting = next;
  }
  function wrapEdit() {
    var prev = window.saveEditJob;
    if (typeof prev !== 'function' || prev.__tljp) return;
    var next = function (jobId) {
      var box = document.getElementById('tljpDest_edit');
      var sel = box && box.getAttribute('data-job') === String(jobId) ? readSelection(box) : null;
      var r = prev.apply(this, arguments);
      if (sel && jobId && !(window.STATE && STATE.editJobId === jobId)) {
        delete S.choice['edit:' + jobId];
        setTimeout(function () { saveDestinations(jobId, sel); }, 900);
      }
      return r;
    };
    next.__tljp = true;
    window.saveEditJob = next;
  }

  /* ================================================================ *
   * badges: Manage Jobs, the Jobs table, the job's own page
   * ================================================================ */
  function badgesHtml(jobId) {
    var pubs = (S.pubs[jobId] || []).filter(function (p) { return p.desired === 'published' || p.status !== 'removed'; });
    if (!pubs.length) return '';
    var waiting = pubs.some(function (p) { return p.desired === 'published' && (p.status === 'failed' || p.status === 'integration_required' || p.status === 'pending'); });
    return '<div class="tljp-badges" data-tljp-job="' + h(jobId) + '">' + pubs.map(function (p) {
      var name = short(p.destination, p.label);
      var label = p.status === 'awaiting_confirmation' ? 'Listed in feed — awaiting confirmation' : p.statusLabel;
      var text = name + ': ' + label;
      var cls = { posted: 'ok', awaiting_confirmation: 'wait', pending: 'wait', posting: 'wait', failed: 'bad', integration_required: 'warn' }[p.status] || 'off';
      var tip = [p.lastError, p.externalJobId ? 'External ID: ' + p.externalJobId : '', p.externalUrl || ''].filter(Boolean).join(' · ');
      var href = p.status === 'posted' ? safeHref(p.externalUrl) : '';
      return href
        ? '<a class="tljp-chip ' + cls + '" href="' + h(href) + '" target="_blank" rel="noopener" title="' + h(tip) + '">' + h(text) + ' ↗</a>'
        : '<span class="tljp-chip ' + cls + '" title="' + h(tip) + '">' + h(text) + '</span>';
    }).join('')
      + (waiting ? '<button type="button" class="tljp-now" data-tljp-now="' + h(jobId) + '" onclick="tljpPublishNow(\'' + h(jobId).replace(/'/g, '') + '\')">Publish now</button>' : '')
      + '</div>';
  }

  function jobIdFrom(el) {
    var m = /\/job\/([^'"\\)]+)/.exec(el.getAttribute('onclick') || '');
    return m ? m[1] : null;
  }
  var decorating = false;
  function decorate(repaint) {
    if (!staff() || decorating) return;
    decorating = true;
    try {
      var targets = [];
      /* Manage Jobs */
      Array.prototype.forEach.call(document.querySelectorAll('#app .mj-details .mj-title[onclick*="/job/"]'), function (t) {
        var id = jobIdFrom(t);
        var sub = t.parentNode && t.parentNode.querySelector('.mj-sub');
        if (id && sub) targets.push({ id: id, host: sub.parentNode, after: sub });
      });
      /* the recruiter's Jobs table */
      Array.prototype.forEach.call(document.querySelectorAll('#app table.data td.clickable[onclick^="navigate(\'/job/"]'), function (td) {
        var id = jobIdFrom(td);
        if (id) targets.push({ id: id, host: td, after: null });
      });
      var ids = targets.map(function (t) { return t.id; });
      targets.forEach(function (t) {
        var old = t.host.querySelector(':scope > .tljp-badges');
        var html = badgesHtml(t.id);
        if (old && !repaint && old.getAttribute('data-sig') === html.length + '') return;
        if (old) old.remove();
        if (!html) return;
        var div = document.createElement('div');
        div.innerHTML = html;
        var el = div.firstChild;
        el.setAttribute('data-sig', html.length + '');
        if (t.after && t.after.nextSibling) t.host.insertBefore(el, t.after.nextSibling); else t.host.appendChild(el);
      });
      decorateJobPage();
      /* Only what is neither known nor already on its way - a resolved
         promise here would re-enter decorate in a microtask loop. */
      var missing = ids.filter(function (id) { return !S.pubsAt[id] && !S.fetching[id]; });
      if (missing.length) fetchPubs(missing).then(function () { setTimeout(function () { decorate(true); }, 0); });
    } finally { decorating = false; }
  }

  function decorateJobPage() {
    var m = /^#\/job\/([^/?#]+)/.exec(location.hash || '');
    if (!m) return;
    var id = decodeURIComponent(m[1]);
    var job = window.DATA && DATA.jobById && DATA.jobById(id);
    if (!job) return;
    if (role() === 'recruiter' && window.DATA.recruiterById) {
      var rec = DATA.recruiterById(STATE.session.id);
      if (job.recruiterId && rec && job.recruiterId !== rec.id) return;
    }
    var host = document.getElementById('tljpJobPanel');
    if (!S.pubsAt[id]) {
      if (!S.fetching[id]) fetchPubs([id]).then(function () { setTimeout(function () { decorate(true); }, 0); });
      return;
    }
    var pubs = S.pubs[id] || [];
    var html = '<div class="panel-head"><div><h2>Publishing</h2><div class="desc">Where this job is published, as each destination confirmed it.</div></div></div>'
      + '<div class="panel-body">' + (pubs.length ? badgesHtml(id) : '<div class="tljp-note">Not published through Save &amp; Post yet - edit the job and press Save &amp; Post.</div>') + '</div>';
    if (host && host.getAttribute('data-sig') === String(html.length) + id) return;
    if (!host) {
      var wrap = document.querySelector('#app .wrap .panel, #app main .panel, #app .panel');
      if (!wrap) return;
      host = document.createElement('section');
      host.id = 'tljpJobPanel';
      host.className = 'panel tljp-jobpanel';
      wrap.parentNode.insertBefore(host, wrap);
    }
    host.innerHTML = html;
    host.setAttribute('data-sig', String(html.length) + id);
  }

  /* ================================================================ *
   * Administration -> Integrations
   * ================================================================ */
  var CONN_LABEL = { api: 'Partner API (TeamLink calls the platform)', xml_feed: 'XML job feed (the platform pulls TeamLink\'s signed feed)',
    partner_feed: 'Partner feed (the platform pulls TeamLink\'s signed feed)' };
  var AUTH_LABEL = { bearer: 'API key as Bearer token', api_key_header: 'API key in a header', basic: 'Client ID + secret (Basic)',
    oauth2_client_credentials: 'OAuth 2.0 client credentials' };
  var NEEDS = {
    NAUKRI: 'Needs Naukri\'s authorized employer/partner API access (Naukri RMS or a Naukri partner agreement). Naukri issues the API endpoint and the credentials.',
    SHINE: 'Needs a Shine.com employer/partner API agreement. Shine issues the API endpoint and the credentials.',
    INDEED: 'Needs Indeed to accept TeamLink\'s XML job feed (Indeed\'s feed / partner programme) - or an Indeed partner API agreement. Indeed confirms listings; TeamLink never marks Indeed Posted on its own.',
  };

  function admLoad() {
    var a = api();
    if (!a || role() !== 'admin') return;
    S.adm.loading = true; S.adm.error = '';
    admPaint();
    a.get('/admin/integrations').then(function (r) {
      S.adm.list = r.integrations || [];
      S.adm.keyOk = !!r.secretKeyConfigured;
      S.adm.loading = false;
      admPaint();
    }, function (e) { S.adm.loading = false; S.adm.error = errText(e, 'Integrations could not be loaded.'); admPaint(); });
  }

  function field(id, label, input, help) {
    return '<div class="tljp-f"><label for="' + id + '">' + h(label) + '</label>' + input + (help ? '<small>' + help + '</small>' : '') + '</div>';
  }
  function text(id, v, ph, type) {
    return '<input type="' + (type || 'text') + '" id="' + id + '" value="' + h(v || '') + '" placeholder="' + h(ph || '') + '" autocomplete="off" spellcheck="false">';
  }
  function secretInput(d, k, label, s, gen) {
    var info = (s && s[k]) || { saved: false };
    var id = 'tljpS_' + d + '_' + k;
    var ph = info.saved ? '•••• saved' + (info.hint ? ' (…' + info.hint + ')' : '') + ' — type to replace' : 'Not set';
    return field(id, label, '<div class="tljp-secret"><input type="password" id="' + id + '" placeholder="' + h(ph) + '" autocomplete="new-password" spellcheck="false">'
      + (gen ? '<button type="button" class="btn btn-ghost btn-sm" onclick="tljpGen(\'' + id + '\')">Generate</button>' : '')
      + (info.saved ? '<label class="tljp-clear"><input type="checkbox" id="' + id + '_clear"> Clear</label>' : '') + '</div>',
    info.saved ? '<span class="tljp-saved">•••• saved' + (info.hint ? ' · ends …' + h(info.hint) : '') + '</span>' : '');
  }

  function counts(c) {
    c = c || {};
    var bits = [['posted', 'Posted'], ['awaiting_confirmation', 'Awaiting confirmation'], ['pending', 'Pending'], ['failed', 'Failed'], ['integration_required', 'Waiting for this integration']]
      .filter(function (x) { return c[x[0]]; }).map(function (x) { return x[1] + ': ' + c[x[0]]; });
    return bits.length ? bits.join(' · ') : 'No jobs ticked yet';
  }

  function ownCard(i) {
    return '<div class="tljp-own"><div><b>' + h(i.label) + '</b> ' + chip('ready', 'Works now') + '</div>'
      + '<div class="tljp-sub">' + h(counts(i.counts)) + '</div>'
      + (i.destination === 'TEAMLINK_PORTAL'
        ? '<div class="tljp-sub">Every Active job is on the portal at <code>/job/&lt;id&gt;</code>; Posted once that page answers publicly.</div>'
        : '<div class="tljp-sub">Public feed for the company website: <a href="' + h(i.feedUrl) + '" target="_blank" rel="noopener"><code>' + h(i.feedUrl) + '</code></a> (JSON) · '
          + '<a href="' + h(i.rssUrl) + '" target="_blank" rel="noopener"><code>' + h(i.rssUrl) + '</code></a> (RSS). Each job page also carries schema.org JobPosting.</div>')
      + '</div>';
  }

  function partnerCard(i) {
    var d = i.destination, t = i.connectionType || '', isApi = t === 'api', isFeed = t === 'xml_feed' || t === 'partner_feed';
    var opt = function (v, l, cur) { return '<option value="' + h(v) + '"' + (v === cur ? ' selected' : '') + '>' + h(l) + '</option>'; };
    var conn = '<select id="tljpC_' + d + '" onchange="tljpConnChanged(\'' + d + '\')">' + opt('', 'Choose…', t)
      + (i.connectionTypes || []).map(function (c) { return opt(c, CONN_LABEL[c] || c, t); }).join('') + '</select>';
    var auth = '<select id="tljpA_' + d + '" onchange="tljpConnChanged(\'' + d + '\')">' + opt('', 'Choose…', i.authType || '')
      + Object.keys(AUTH_LABEL).map(function (k) { return opt(k, AUTH_LABEL[k], i.authType || ''); }).join('') + '</select>';
    var paths = (i.options && i.options.paths) || {};
    var res = S.adm.result[d];
    var state = i.ready ? chip('posted', 'Connected') : chip('integration_required', 'Integration Required');
    var apiPart = '<div class="tljp-grid" data-part="api"' + (isApi ? '' : ' hidden') + '>'
      + field('tljpE_' + d, 'Authorized API endpoint (base URL)', text('tljpE_' + d, i.endpointUrl, 'https://… issued by ' + i.label, 'url'), 'TeamLink calls only this address.')
      + field('tljpA_' + d, 'Authentication', auth)
      + field('tljpAcc_' + d, 'Account / employer ID', text('tljpAcc_' + d, i.accountId, 'Issued by ' + i.label))
      + field('tljpCid_' + d, 'Client ID', text('tljpCid_' + d, i.clientId, 'For Basic or OAuth'))
      + field('tljpTok_' + d, 'OAuth token URL', text('tljpTok_' + d, i.tokenUrl, 'https://… (OAuth only)', 'url'))
      + field('tljpH_' + d, 'API key header name', text('tljpH_' + d, (i.options && i.options.apiKeyHeader) || '', 'X-Api-Key (header auth only)'))
      + secretInput(d, 'apiKey', 'API key', i.secrets)
      + secretInput(d, 'clientSecret', 'Client secret', i.secrets)
      + '<details class="tljp-adv"><summary>Advanced: API paths</summary><div class="tljp-grid">'
      + field('tljpPv_' + d, 'Credential check (GET)', text('tljpPv_' + d, paths.validate || '', '/account'))
      + field('tljpPp_' + d, 'Create job (POST)', text('tljpPp_' + d, paths.publish || '', '/jobs'))
      + field('tljpPj_' + d, 'One job (PUT / DELETE / GET)', text('tljpPj_' + d, paths.job || '', '/jobs/{id}'))
      + '</div></details></div>';
    var feedPart = '<div class="tljp-grid" data-part="feed"' + (isFeed ? '' : ' hidden') + '>'
      + secretInput(d, 'feedToken', 'Feed token (signs the feed URL)', i.secrets, true)
      + field('tljpAcc2_' + d, 'Publisher / account ID', text('tljpAcc2_' + d, i.accountId, 'Issued by ' + i.label))
      + field('tljpSt_' + d, 'Status check URL (optional)', text('tljpSt_' + d, i.statusUrl, 'https://… where ' + i.label + ' reports listing status', 'url'),
        'Polled for confirmation. Without it, confirmation arrives through the signed callback.')
      + secretInput(d, 'callbackSecret', 'Callback signing secret', i.secrets, true)
      + '<div class="tljp-f tljp-wide"><label>Give these to ' + h(i.label) + '</label>'
      + '<div class="tljp-sub">Feed URL: <code>' + h(i.feedUrl || ('…/feeds/' + d.toLowerCase() + '.xml?token=<feed token>')) + '</code> (the full token is the one you typed; it is never shown again)</div>'
      + '<div class="tljp-sub">Confirmation callback: <code>' + h(i.callbackUrl) + '</code> - POST, signed with <code>X-TeamLink-Signature: sha256=&lt;HMAC of the body&gt;</code></div></div>'
      + '</div>';
    var b = S.adm.busy[d];
    return '<section class="panel tljp-card" id="tljpCard_' + d + '" aria-labelledby="tljpH2_' + d + '"><div class="panel-head"><div>'
      + '<h2 id="tljpH2_' + d + '">' + h(i.label) + ' ' + state + '</h2>'
      + '<div class="desc">' + h(NEEDS[d] || 'Needs an authorized integration agreement with this platform.') + '</div></div></div>'
      + '<div class="panel-body">'
      + (i.blocker ? '<div class="tljp-why">Not publishing yet: ' + h(i.blocker) + '</div>' : '<div class="tljp-ok">Save &amp; Post publishes to ' + h(i.label) + ' automatically.</div>')
      + (!i.secretsReadable ? '<div class="tljp-why">The saved credentials cannot be read on this server (INTEGRATION_SECRET_KEY missing or changed). Enter them again.</div>' : '')
      + '<div class="tljp-grid">'
      + '<div class="tljp-f"><label class="tljp-switch"><input type="checkbox" id="tljpOn_' + d + '"' + (i.enabled ? ' checked' : '') + '> Enabled</label><small>Off: nothing is sent to ' + h(i.label) + '.</small></div>'
      + field('tljpC_' + d, 'Connection type', conn)
      + '</div>' + apiPart + feedPart
      + '<div class="tljp-actions">'
      + '<button type="button" class="btn btn-primary btn-sm" ' + (b ? 'disabled' : '') + ' onclick="tljpSave(\'' + d + '\')">' + (b === 'save' ? 'Saving…' : 'Save') + '</button>'
      + '<button type="button" class="btn btn-ghost btn-sm" ' + (b ? 'disabled' : '') + ' onclick="tljpTest(\'' + d + '\')">' + (b === 'test' ? 'Testing…' : 'Test Connection') + '</button>'
      + '<button type="button" class="btn btn-ghost btn-sm" ' + (b ? 'disabled' : '') + ' onclick="tljpPending(\'' + d + '\')">' + (b === 'pending' ? 'Publishing…' : 'Publish waiting jobs now') + '</button>'
      + '</div>'
      + (res ? '<div class="tljp-result ' + (res.ok ? 'ok' : 'bad') + '" role="status">' + h(res.message) + '</div>' : '')
      + '<dl class="tljp-facts">'
      + '<dt>Last test</dt><dd>' + (i.lastTestAt ? (i.lastTestOk ? '✅ ' : '❌ ') + h(when(i.lastTestAt)) + (i.lastTestMessage ? ' — ' + h(i.lastTestMessage) : '') : 'never') + '</dd>'
      + '<dt>Last sync</dt><dd>' + h(when(i.lastSyncAt)) + '</dd>'
      + '<dt>Last error</dt><dd>' + (i.lastError ? h(i.lastError) + ' <span class="tljp-sub">(' + h(when(i.lastErrorAt))
        + (i.lastSyncAt && i.lastErrorAt && new Date(i.lastSyncAt) > new Date(i.lastErrorAt) ? ' - a later sync succeeded' : '') + ')</span>' : 'none') + '</dd>'
      + '<dt>Jobs</dt><dd>' + h(counts(i.counts)) + '</dd>'
      + '</dl>'
      + '<details class="tljp-adv" ontoggle="if(this.open)tljpEvents(\'' + d + '\')"' + (S.adm.open[d] ? ' open' : '') + '><summary>Change history</summary><div id="tljpEv_' + d + '">'
      + (S.adm.events[d] ? S.adm.events[d].map(function (e) { return '<div class="tljp-sub">' + h(when(e.at)) + ' · ' + h(e.event) + (e.detail ? ' — ' + h(e.detail) : '') + '</div>'; }).join('') || '<div class="tljp-sub">No changes yet.</div>' : '<div class="tljp-sub">Loading…</div>')
      + '</div></details>'
      + '</div></section>';
  }

  function admPage() {
    setTimeout(admLoad, 0);
    return '<div id="tljpAdmHost"><div class="tljp-note" role="status">Loading integrations…</div></div>';
  }
  function admPaint() {
    var host = document.getElementById('tljpAdmHost');
    if (!host) return;
    if (S.adm.error) { host.innerHTML = '<div class="tljp-why">' + h(S.adm.error) + '</div>'; return; }
    if (!S.adm.list) { host.innerHTML = '<div class="tljp-note" role="status">Loading integrations…</div>'; return; }
    var own = S.adm.list.filter(function (i) { return i.kind === 'own'; });
    var partners = S.adm.list.filter(function (i) { return i.kind !== 'own'; });
    host.innerHTML = (S.adm.keyOk ? '' : '<div class="tljp-why" role="alert"><b>INTEGRATION_SECRET_KEY is not set on the server.</b> Credentials cannot be saved until it is set in the server environment (at least 16 characters) and the server is restarted.</div>')
      + '<section class="panel"><div class="panel-head"><div><h2>TeamLink systems</h2><div class="desc">Our own destinations. They work now and need no setup.</div></div></div>'
      + '<div class="panel-body">' + own.map(ownCard).join('') + '</div></section>'
      + '<section class="panel"><div class="panel-head"><div><h2>Job sites</h2><div class="desc">Each one needs an agreement with that platform and the API or feed credentials it issues. '
      + 'Without them a job ticked for it shows <b>Integration Required</b> and nothing is sent. There is no scraping and no browser automation: only the platform\'s authorized API or feed. '
      + 'Credentials are encrypted on the server and never shown again.</div></div></div></section>'
      + partners.map(partnerCard).join('');
  }

  var v = function (id) { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
  var ck = function (id) { var el = document.getElementById(id); return !!(el && el.checked); };

  window.tljpConnChanged = function (d) {
    var t = v('tljpC_' + d);
    var card = document.getElementById('tljpCard_' + d);
    if (!card) return;
    var api_ = card.querySelector('[data-part="api"]'), feed = card.querySelector('[data-part="feed"]');
    if (api_) api_.hidden = t !== 'api';
    if (feed) feed.hidden = !(t === 'xml_feed' || t === 'partner_feed');
  };
  window.tljpGen = function (id) {
    var el = document.getElementById(id);
    if (!el || !window.crypto || !crypto.getRandomValues) return;
    var b = new Uint8Array(24);
    crypto.getRandomValues(b);
    el.value = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    el.type = 'text';
    say('Generated. Copy it now: after Save it is never shown again.', '🔑');
  };

  function readCard(d) {
    var t = v('tljpC_' + d);
    var secrets = {}, clear = [];
    ['apiKey', 'clientSecret', 'feedToken', 'callbackSecret'].forEach(function (k) {
      var id = 'tljpS_' + d + '_' + k;
      var val = v(id);
      if (val) secrets[k] = val;
      if (ck(id + '_clear')) clear.push(k);
    });
    var paths = {};
    if (v('tljpPv_' + d)) paths.validate = v('tljpPv_' + d);
    if (v('tljpPp_' + d)) paths.publish = v('tljpPp_' + d);
    if (v('tljpPj_' + d)) paths.job = v('tljpPj_' + d);
    var isFeed = t === 'xml_feed' || t === 'partner_feed';
    return {
      enabled: ck('tljpOn_' + d), connectionType: t || null,
      endpointUrl: t === 'api' ? v('tljpE_' + d) : '', authType: t === 'api' ? (v('tljpA_' + d) || null) : null,
      tokenUrl: t === 'api' ? v('tljpTok_' + d) : '', statusUrl: isFeed ? v('tljpSt_' + d) : '',
      accountId: isFeed ? v('tljpAcc2_' + d) : v('tljpAcc_' + d), clientId: t === 'api' ? v('tljpCid_' + d) : '',
      options: { paths: paths, apiKeyHeader: v('tljpH_' + d) || undefined },
      secrets: secrets, clearSecrets: clear,
    };
  }
  function replace(i) {
    if (!i || !S.adm.list) return;
    S.adm.list = S.adm.list.map(function (x) { return x.destination === i.destination ? i : x; });
  }
  window.tljpSave = function (d) {
    var a = api();
    if (!a) return;
    var body = readCard(d);
    S.adm.busy[d] = 'save'; admPaint();
    a.put('/admin/integrations/' + encodeURIComponent(d), body).then(function (r) {
      S.adm.busy[d] = null;
      S.adm.keyOk = !!r.secretKeyConfigured;
      replace(r.integration);
      S.adm.result[d] = { ok: true, message: 'Saved.' + (r.integration && r.integration.ready ? ' Connected - waiting jobs are being published.' : (r.integration && r.integration.blocker ? ' Not publishing yet: ' + r.integration.blocker : '')) };
      S.dests = null;
      admPaint();
    }, function (e) {
      S.adm.busy[d] = null;
      S.adm.result[d] = { ok: false, message: errText(e, 'Could not save') };
      admPaint();
    });
  };
  window.tljpTest = function (d) {
    var a = api();
    if (!a) return;
    S.adm.busy[d] = 'test'; admPaint();
    a.post('/admin/integrations/' + encodeURIComponent(d) + '/test', {}).then(function (r) {
      S.adm.busy[d] = null;
      if (r.integration) replace(r.integration);
      S.adm.result[d] = { ok: !!r.ok, message: (r.ok ? 'Test Connection passed: ' : 'Test Connection failed: ') + r.message };
      admPaint();
    }, function (e) { S.adm.busy[d] = null; S.adm.result[d] = { ok: false, message: errText(e, 'The test could not run') }; admPaint(); });
  };
  window.tljpPending = function (d) {
    var a = api();
    if (!a) return;
    S.adm.busy[d] = 'pending'; admPaint();
    a.post('/admin/integrations/' + encodeURIComponent(d) + '/publish-pending', {}).then(function (r) {
      S.adm.busy[d] = null;
      if (r.integration) replace(r.integration);
      S.pubsAt = Object.create(null);
      S.adm.result[d] = { ok: true, message: r.queued + ' waiting job(s) sent through the publisher. ' + (r.integration ? counts(r.integration.counts) : '') };
      admPaint();
    }, function (e) { S.adm.busy[d] = null; S.adm.result[d] = { ok: false, message: errText(e, 'Could not publish') }; admPaint(); });
  };
  window.tljpEvents = function (d) {
    var a = api();
    if (!a) return;
    S.adm.open[d] = true;
    a.get('/admin/integrations/' + encodeURIComponent(d) + '/events').then(function (r) {
      S.adm.events[d] = r.events || [];
      var host = document.getElementById('tljpEv_' + d);
      if (host) host.innerHTML = S.adm.events[d].map(function (e) { return '<div class="tljp-sub">' + h(when(e.at)) + ' · ' + h(e.event) + (e.detail ? ' — ' + h(e.detail) : '') + '</div>'; }).join('') || '<div class="tljp-sub">No changes yet.</div>';
    }, function () {});
  };

  /* ================================================================ *
   * slotting it in
   * ================================================================ */
  (function hook() {
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (tries > 80) { clearInterval(timer); return; }
      if (typeof window.pageAdminDash !== 'function' || typeof window.fcrRegisterPosting !== 'function') return;
      clearInterval(timer);
      try {
        var nav = (typeof NAV_CONFIG !== 'undefined' && NAV_CONFIG.admin) || null;
        if (nav && !nav.some(function (n) { return n[0] === 'integrations'; })) nav.push(['integrations', 'Integrations', '🔌']);
      } catch (e) { /* reachable by URL */ }
      var prev = window.pageAdminDash;
      if (!prev.__tljp) {
        var next = function (section) {
          if (section !== 'integrations') return prev.apply(this, arguments);
          return (typeof window.dashShell === 'function')
            ? window.dashShell('admin', 'integrations', 'Integrations', 'Admin · Job publishing', admPage()) : admPage();
        };
        next.__tljp = true;
        window.pageAdminDash = next;
      }
      ['publishGeneratedJob', 'tnavWalkinSubmit', 'tnavInternshipSubmit'].forEach(wrapCreate);
      wrapRegister();
      wrapEdit();
      if (typeof window.render === 'function' && /#\/admin\/integrations/.test(location.hash)) { try { window.render(); } catch (e) { /* next navigation */ } }
    }, 250);
  })();

  var scheduled = null;
  function schedule() {
    if (scheduled) return;
    scheduled = setTimeout(function () {
      scheduled = null;
      if (!ready() || !staff()) return;
      injectForms();
      decorate(false);
      if (/#\/admin\/integrations/.test(location.hash) && S.adm.list) {
        var host = document.getElementById('tljpAdmHost');
        if (host && !host.querySelector('.tljp-card') && !S.adm.loading) admPaint();
      }
    }, 120);
  }
  (function observe(n) {
    var app = document.getElementById('app');
    if (!app || !ready()) { if (n < 240) setTimeout(function () { observe(n + 1); }, 250); return; }
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var t = muts[i].target;
        if (t && t.closest && t.closest('.tljp-badges, .tljp-dest, #tljpAdmHost, #tljpJobPanel')) continue;
        schedule(); return;
      }
    }).observe(document.body, { childList: true, subtree: true });
    schedule();
  })(0);
  window.addEventListener('hashchange', schedule);

  /* ================================================================ *
   * styles
   * ================================================================ */
  var css = ''
    + '.tljp-dest{border:1px solid var(--line,#e6ebf2);border-radius:10px;padding:10px 12px 8px;margin:10px 0;min-width:0}'
    + '.tljp-dest legend{font-weight:800;font-size:12.5px;padding:0 4px}'
    + '.tljp-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:4px 0;font-size:13px}'
    + '.tljp-row label{display:flex;gap:7px;align-items:center;min-width:170px;cursor:pointer}'
    + '.tljp-state{display:flex;flex-wrap:wrap;gap:6px;align-items:center}'
    + '.tljp-note{font-size:11.5px;color:var(--text-soft,#5f6b7c);margin-top:4px}'
    + '.tljp-link{font-size:11.5px;font-weight:700;color:var(--brand-600,#0f7c9c)}'
    + '.tljp-chip{display:inline-block;border-radius:999px;padding:2px 9px;font-size:10.5px;font-weight:800;line-height:1.5;text-decoration:none;white-space:normal;word-break:break-word}'
    + '.tljp-chip.ok{background:#e8f6ee;color:#17663a}.tljp-chip.wait{background:#eef2f7;color:#4b5a70}'
    + '.tljp-chip.bad{background:#fdeaea;color:#a3201a}.tljp-chip.warn{background:#fdf3dc;color:#7a4d0d}.tljp-chip.off{background:#f1f4f8;color:#7b8794}'
    + 'a.tljp-chip.ok:hover{text-decoration:underline}'
    + '.tljp-badges{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px;align-items:center}'
    + '.tljp-now{border:1px solid var(--line,#d7dee8);background:var(--card,#fff);border-radius:999px;font-size:10.5px;font-weight:800;padding:2px 9px;cursor:pointer;color:var(--brand-600,#0f7c9c)}'
    + '.tljp-jobpanel{margin-bottom:16px}'
    + '.tljp-card h2 .tljp-chip{vertical-align:middle;margin-left:6px}'
    + '.tljp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px 14px;margin:10px 0}'
    + '.tljp-grid[hidden]{display:none}'
    + '.tljp-f{min-width:0}.tljp-f label{display:block;font-size:11.5px;font-weight:700;margin-bottom:3px}'
    + '.tljp-f input[type=text],.tljp-f input[type=url],.tljp-f input[type=password],.tljp-f select{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid var(--line,#d7dee8);border-radius:8px;font-size:13px;background:var(--card,#fff);color:var(--text,#16202c)}'
    + '.tljp-f small{display:block;font-size:11px;color:var(--text-soft,#5f6b7c);margin-top:3px}'
    + '.tljp-wide{grid-column:1/-1}'
    + '.tljp-secret{display:flex;gap:6px;align-items:center}.tljp-secret input{flex:1;min-width:0}'
    + '.tljp-clear{display:flex!important;gap:4px;align-items:center;font-weight:600!important;margin:0!important;white-space:nowrap}'
    + '.tljp-saved{color:#17663a;font-weight:700}'
    + '.tljp-switch{display:flex!important;gap:7px;align-items:center;font-size:13px!important}'
    + '.tljp-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}'
    + '.tljp-result{margin-top:10px;padding:9px 12px;border-radius:9px;font-size:12.5px;word-break:break-word}'
    + '.tljp-result.ok{background:#e8f6ee;color:#17663a}.tljp-result.bad{background:#fdeaea;color:#a3201a}'
    + '.tljp-why{padding:10px 12px;border:1px solid #f0c27a;background:#fff9ee;border-radius:9px;color:#7a4d0d;font-size:12.5px;margin-bottom:10px;word-break:break-word}'
    + '.tljp-ok{padding:10px 12px;border:1px solid #b6e2c6;background:#f1fbf5;border-radius:9px;color:#17663a;font-size:12.5px;margin-bottom:10px}'
    + '.tljp-facts{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;font-size:12.5px;margin:12px 0 4px}'
    + '.tljp-facts dt{font-weight:700;color:var(--text-soft,#5f6b7c)}.tljp-facts dd{margin:0;word-break:break-word}'
    + '.tljp-sub{font-size:11.5px;color:var(--text-soft,#5f6b7c);margin-top:3px;word-break:break-word}'
    + '.tljp-sub code,.tljp-own code{background:#f1f5f9;border-radius:5px;padding:1px 5px;font-size:11px;color:#334155;word-break:break-all}'
    + '.tljp-own{padding:8px 0;border-bottom:1px solid var(--line-soft,#f1f4f8)}.tljp-own:last-child{border-bottom:0}'
    + '.tljp-adv{margin-top:8px;font-size:12.5px}.tljp-adv summary{cursor:pointer;font-weight:700}'
    + '#tljpAdmHost :focus-visible,.tljp-dest :focus-visible,.tljp-badges :focus-visible{outline:3px solid #1d6ff2;outline-offset:2px}'
    + '@media (max-width:600px){.tljp-row label{min-width:0;flex:1 1 100%}.tljp-facts{grid-template-columns:1fr}.tljp-grid{grid-template-columns:1fr}}';
  var tag = document.createElement('style');
  tag.id = 'tljp-css';
  tag.textContent = css;
  (document.head || document.documentElement).appendChild(tag);

  window.TLJobPublishing = { refresh: function () { S.dests = null; S.pubsAt = Object.create(null); schedule(); }, state: S };
})();
