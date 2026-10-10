/* =====================================================================
   TEAMLINK - the Admin panel: seven modules, and Admin posts jobs

   THE SIDEBAR. Exactly these, in this order:
     1 Users              Users · Candidates · Clients · Shared candidates · Privacy requests
     2 Recruiters & Teams Recruiters · Teams
     3 Jobs               Jobs · Applications · Interviews · Quick Filters
     4 Reports & Audit Log Reports · Analytics · Audit Log
     5 Availability
     6 Job Sources
     7 Integrations       Integrations · Naukri & Shine Email Import · AI Settings · Notification Settings
   with the Admin profile and Exit at the bottom, as before.

   NOTHING IS REMOVED. Every page that had its own sidebar entry is still
   there, at the same address, reached by a tab inside its module - the
   other modules keep adding their entries to NAV_CONFIG.admin as they always
   did (so their titles and pages work); this script only decides what the
   SIDEBAR shows, at the moment it is drawn.

   ADMIN POSTS JOBS. The Jobs tab gets "Post a job" and, per job, "Manage":
   create (draft or published), edit, duplicate, publish / unpublish, close /
   reopen, archive / restore, the last date, and the job sources to publish to
   - all through the existing job and publishing APIs, so an Admin's job is an
   ordinary job record, validated and published like a recruiter's, with no
   recruiter needed. A source is offered only when its integration is set up;
   each source's status is the publishing service's own (never "published"
   until the integration confirms it), with its error and a Retry.
   ===================================================================== */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__tlAdminConsole) return;
  window.__tlAdminConsole = true;

  var GROUPS = [
    { key: 'users', label: 'Users', icon: '👥', tabs: [['users', 'Users'], ['candidates', 'Candidates'], ['clients', 'Clients'], ['shared-candidates', 'Shared candidates'], ['privacy-requests', 'Privacy requests']] },
    { key: 'recruiters', label: 'Recruiters & Teams', icon: '🧑‍💼', tabs: [['recruiters', 'Recruiters'], ['teams', 'Teams']] },
    { key: 'jobs', label: 'Jobs', icon: '💼', tabs: [['jobs', 'Jobs'], ['applications', 'Applications'], ['interviews', 'Interviews'], ['quick-filters', 'Quick Filters']] },
    { key: 'reports', label: 'Reports & Audit Log', icon: '📊', tabs: [['reports', 'Reports'], ['analytics', 'Analytics'], ['audit-log', 'Audit Log']] },
    { key: 'availability', label: 'Availability', icon: '🟢', tabs: [['availability', 'Availability']] },
    { key: 'job-sources', label: 'Job Sources', icon: '🌐', tabs: [['job-sources', 'Job Sources']] },
    { key: 'integrations', label: 'Integrations', icon: '🔌', tabs: [['integrations', 'Integrations'], ['email-import', 'Naukri & Shine Email Import'], ['ai-settings', 'AI Settings'], ['notification-settings', 'Notification Settings']] },
  ];
  var GROUP_OF = {};
  GROUPS.forEach(function (g) { g.tabs.forEach(function (t) { GROUP_OF[t[0]] = g; }); });

  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api() { return window.TL && window.TL.api; }
  function say(m, i) { if (typeof window.toast === 'function') window.toast(m, i || 'ℹ️'); }
  function $(id) { return document.getElementById(id); }
  function isAdmin() { return !!(window.STATE && STATE.session && STATE.session.role === 'admin'); }

  /* ------------------------------------------------------------------ *
   * the sidebar and the module tabs
   * ------------------------------------------------------------------ */
  function tabsHtml(section) {
    var g = GROUP_OF[section];
    if (!g || g.tabs.length < 2) return '';
    return '<nav class="tlac-tabs" role="tablist" aria-label="' + h(g.label) + '">'
      + g.tabs.map(function (t) {
        var on = t[0] === section;
        return '<a href="#/admin/' + t[0] + '" role="tab" aria-selected="' + on + '" class="tlac-tab' + (on ? ' on' : '') + '">' + h(t[1]) + '</a>';
      }).join('') + '</nav>';
  }

  var depth = 0;
  function wrapShell() {
    var prev = window.dashShell;
    if (typeof prev !== 'function' || prev.__tlac) return false;
    var next = function (role, section, titleHtml, crumb, contentHtml) {
      /* once per page: a second layer of this wrapper (re-wrapped outermost) passes straight through */
      if (role !== 'admin' || depth > 0) return prev.apply(this, arguments);
      depth += 1;
      try { return draw.call(this, role, section, titleHtml, crumb, contentHtml); } finally { depth -= 1; }
    };
    var draw = function (role, section, titleHtml, crumb, contentHtml) {
      var full = NAV_CONFIG.admin;
      var seven = GROUPS.map(function (g) { return [g.key, g.label, g.icon]; });
      var g = GROUP_OF[section];
      var extra = tabsHtml(section) + (section === 'jobs' ? jobsToolbar() : '');
      var out;
      NAV_CONFIG.admin = seven;
      try {
        out = prev.call(this, role, section, titleHtml, crumb, extra + (contentHtml || ''));
      } finally {
        NAV_CONFIG.admin = full;
      }
      /* only the seven: the shared "Public Site" link is not one of the Admin modules */
      if (typeof out === 'string') {
        out = out.replace(/<a href="#\/" style="[^"]*"><span class="ic">[^<]*<\/span><span class="lbl">Public Site<\/span><\/a>/, '');
      }
      /* the module stays lit on every one of its tabs */
      if (g && g.key !== section && typeof out === 'string') {
        out = out.replace('<a href="#/admin/' + g.key + '" class="">', '<a href="#/admin/' + g.key + '" class="active">');
      }
      return out;
    };
    next.__tlac = true;
    window.dashShell = next;
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Jobs: Post a job, Manage
   * ------------------------------------------------------------------ */
  function jobsToolbar() {
    return '<div class="tlac-jobbar"><div><b>Job postings</b><span>Post and manage jobs yourself - no recruiter needed. Jobs you post show "Posted by: you (Admin)".</span></div>'
      + '<button type="button" class="btn btn-primary" onclick="tlacOpenJob()">+ Post a job</button></div>';
  }

  var M = { open: false, mode: 'new', job: null, dests: null, pubs: null, busy: false, err: '', fieldErr: {}, result: null };

  function companies() { return (window.DATA && DATA.companies) || []; }
  function jobById(id) { try { return DATA.jobById(id); } catch (e) { return null; } }
  function ymd(iso) { if (!iso) return ''; var d = new Date(iso); if (isNaN(d)) return ''; return new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10); }

  function blankJob() {
    var co = companies();
    var tl = co.find(function (c) { return /teamlink/i.test(c.name || ''); }) || co[0] || {};
    return { title: '', companyId: tl.id || '', location: '', mode: 'Onsite', type: 'Full-time', exp: '', salaryMin: '', salaryMax: '',
      openings: 1, skills: [], desc: '', lastDate: '', department: '', education: '' };
  }
  function fromJob(j, copy) {
    return { id: copy ? null : j.id, title: (j.title || '') + (copy ? ' (copy)' : ''), companyId: j.companyId || '', location: j.location || '',
      mode: j.mode || 'Onsite', type: j.type || 'Full-time', exp: j.exp || '', salaryMin: j.salaryMin == null ? '' : j.salaryMin,
      salaryMax: j.salaryMax == null ? '' : j.salaryMax, openings: j.openings || 1, skills: (j.skills || []).slice(), desc: j.desc || '',
      lastDate: copy ? '' : ymd(j.expiresAt), department: j.department || '', education: j.education || '',
      status: copy ? 'draft' : j.status, archived: copy ? false : !!j.archived };
  }

  function loadDests() {
    if (!api()) return Promise.resolve([]);
    return api().get('/publishing/destinations').then(function (r) { M.dests = r.destinations || []; return M.dests; }, function () { M.dests = []; return []; });
  }
  function loadPubs(id) {
    if (!api() || !id) return Promise.resolve([]);
    return api().get('/jobs/' + encodeURIComponent(id) + '/publications').then(function (r) { M.pubs = r.publications || []; paintModal(); }, function () { M.pubs = []; paintModal(); });
  }

  window.tlacOpenJob = function (id, copy) {
    if (!isAdmin()) return;
    var j = id ? jobById(id) : null;
    M.open = true; M.mode = !j ? 'new' : copy ? 'copy' : 'edit';
    M.job = j ? fromJob(j, !!copy) : blankJob();
    M.err = ''; M.fieldErr = {}; M.result = null; M.pubs = null;
    M.selected = null;
    paintModal();
    loadDests().then(function () {
      if (M.selected == null) {
        M.selected = (M.dests || []).filter(function (d) { return d.locked || (d.defaultSelected && d.ready); }).map(function (d) { return d.key; });
      }
      paintModal();
    });
    if (M.mode === 'edit') loadPubs(j.id);
  };
  window.tlacClose = function () { M.open = false; paintModal(); if (typeof window.render === 'function') window.render(); };

  function keepForm() {
    var f = M.job; if (!f) return;
    var v = function (id) { var el = $(id); return el ? String(el.value || '').trim() : undefined; };
    ['title', 'location', 'exp', 'desc', 'department', 'education'].forEach(function (k) { var x = v('tlacF_' + k); if (x !== undefined) f[k] = x; });
    var co = v('tlacF_companyId'); if (co !== undefined) f.companyId = co;
    var mode = v('tlacF_mode'); if (mode !== undefined) f.mode = mode;
    var type = v('tlacF_type'); if (type !== undefined) f.type = type;
    var mn = v('tlacF_salaryMin'); if (mn !== undefined) f.salaryMin = mn;
    var mx = v('tlacF_salaryMax'); if (mx !== undefined) f.salaryMax = mx;
    var op = v('tlacF_openings'); if (op !== undefined) f.openings = op;
    var sk = v('tlacF_skills'); if (sk !== undefined) f.skills = sk.split(',').map(function (x) { return x.trim(); }).filter(Boolean)
      .filter(function (x, i, a) { return a.findIndex(function (y) { return y.toLowerCase() === x.toLowerCase(); }) === i; });
    var ld = v('tlacF_lastDate'); if (ld !== undefined) f.lastDate = ld;
    var boxes = document.querySelectorAll('#tlacModal input[data-dest]');
    if (boxes.length) M.selected = [].slice.call(boxes).filter(function (b) { return b.checked; }).map(function (b) { return b.getAttribute('data-dest'); });
  }

  function problems(f, publish) {
    var e = {};
    if (!f.title || f.title.length < 2) e.title = 'Job title is required.';
    if (!f.companyId) e.companyId = 'Choose the company.';
    if (!f.location) e.location = 'Location is required.';
    if (publish) {
      if (!f.desc || f.desc.length < 30) e.desc = 'Add a job description (at least a few lines) before publishing.';
      if (!f.skills.length) e.skills = 'Add at least one skill.';
    }
    var mn = f.salaryMin === '' ? null : Number(f.salaryMin), mx = f.salaryMax === '' ? null : Number(f.salaryMax);
    if (mn != null && !(mn >= 0)) e.salaryMin = 'Enter a number.';
    if (mx != null && !(mx >= 0)) e.salaryMax = 'Enter a number.';
    if (mn != null && mx != null && mx < mn) e.salaryMax = 'Maximum cannot be less than the minimum.';
    if (f.lastDate && f.lastDate < ymd(new Date().toISOString())) e.lastDate = 'The last date cannot be in the past.';
    return e;
  }

  function bodyOf(f, status) {
    var mn = f.salaryMin === '' ? null : Number(f.salaryMin), mx = f.salaryMax === '' ? null : Number(f.salaryMax);
    var pay = mn != null && mx != null ? '₹' + mn + '-' + mx + ' LPA' : mn != null ? '₹' + mn + '+ LPA' : '';
    var b = { title: f.title, companyId: f.companyId, location: f.location, mode: f.mode, type: f.type, exp: f.exp || undefined,
      salaryMin: mn, salaryMax: mx, pay: pay || undefined, skills: f.skills, desc: f.desc || undefined,
      openings: Number(f.openings) > 0 ? Math.floor(Number(f.openings)) : undefined,
      department: f.department || undefined, education: f.education || undefined };
    if (status) b.status = status;
    return b;
  }

  /* save: create or update, then the last date, then the sources */
  window.tlacSave = function (publish) {
    if (M.busy) return;
    keepForm();
    var f = M.job;
    M.fieldErr = problems(f, publish);
    if (Object.keys(M.fieldErr).length) { M.err = 'Please check the highlighted fields.'; paintModal(); return; }
    M.busy = true; M.err = ''; paintModal();
    var a = api();
    var editing = M.mode === 'edit' && f.id;
    var status = publish ? 'open' : (editing ? undefined : 'draft');
    var p = editing
      ? a.put('/jobs/' + encodeURIComponent(f.id), bodyOf(f, status || f.status))
      : a.post('/jobs', bodyOf(f, status));
    var jobId = null;
    p.then(function (r) {
      jobId = (r.job && r.job.id) || f.id;
      return a.put('/jobs/' + encodeURIComponent(jobId) + '/deadline', { lastDate: f.lastDate || null }).catch(function () { return null; });
    }).then(function () {
      var dests = (M.selected || []).filter(function (k) { var d = (M.dests || []).find(function (x) { return x.key === k; }); return d && d.ready; });
      if (!publish || !dests.length) return null;
      return a.put('/jobs/' + encodeURIComponent(jobId) + '/publications', { destinations: dests });
    }).then(function (r) {
      M.busy = false;
      M.pubs = r ? r.publications || [] : M.pubs;
      M.mode = 'edit'; f.id = jobId; f.status = publish ? 'open' : (f.status || 'draft');
      M.result = publish ? 'Saved and published.' : 'Saved as a draft.';
      say(M.result, '✅');
      var after = window.TL && typeof TL.refresh === 'function' ? TL.refresh() : Promise.resolve();
      return Promise.resolve(after).catch(function () {}).then(function () { if (jobId) loadPubs(jobId); paintModal(); });
    }).catch(function (er) {
      M.busy = false;
      var d = (er && (er.details || er.fields)) || {};
      Object.keys(d).forEach(function (k) { M.fieldErr[k] = d[k]; });
      M.err = (er && er.message) || 'That could not be saved.';
      paintModal();
    });
  };

  function act(path, body, okMsg) {
    var f = M.job; if (!f || !f.id || M.busy) return;
    M.busy = true; M.err = ''; paintModal();
    api().post('/jobs/' + encodeURIComponent(f.id) + path, body).then(function () {
      M.busy = false; say(okMsg, '✅');
      return Promise.resolve(window.TL && TL.refresh ? TL.refresh() : null).catch(function () {}).then(function () {
        var j = jobById(f.id); if (j) M.job = fromJob(j, false);
        loadPubs(f.id); paintModal();
      });
    }, function (er) { M.busy = false; M.err = (er && er.message) || 'That did not work.'; paintModal(); });
  }
  window.tlacPublish = function (on) { act('/publish', { publish: !!on }, on ? 'Published.' : 'Unpublished (back to draft).'); };
  window.tlacArchive = function (on) { act('/archive', { archived: !!on }, on ? 'Archived.' : 'Restored.'); };
  window.tlacCloseJob = function (close) {
    var f = M.job; if (!f || !f.id || M.busy) return;
    keepForm();
    M.busy = true; M.err = ''; paintModal();
    api().put('/jobs/' + encodeURIComponent(f.id), bodyOf(f, close ? 'closed' : 'open')).then(function () {
      M.busy = false; say(close ? 'Job closed.' : 'Job reopened.', '✅');
      return Promise.resolve(window.TL && TL.refresh ? TL.refresh() : null).catch(function () {}).then(function () {
        var j = jobById(f.id); if (j) M.job = fromJob(j, false); loadPubs(f.id); paintModal();
      });
    }, function (er) { M.busy = false; M.err = (er && er.message) || 'That did not work.'; paintModal(); });
  };
  window.tlacRetry = function (dest) {
    var f = M.job; if (!f || !f.id) return;
    api().post('/jobs/' + encodeURIComponent(f.id) + '/publications/publish-now', { destination: dest })
      .then(function () { say('Trying again…', '🔁'); loadPubs(f.id); }, function (er) { say((er && er.message) || 'That did not work.', '⚠️'); });
  };

  function fld(id, label, inner, req) {
    var e = M.fieldErr[id.replace('tlacF_', '')];
    return '<div class="tlac-f' + (e ? ' bad' : '') + '"><label for="' + id + '">' + h(label) + (req ? ' *' : '') + '</label>' + inner
      + (e ? '<span class="tlac-err" role="alert">' + h(e) + '</span>' : '') + '</div>';
  }
  function sel(id, val, opts) {
    return '<select id="' + id + '">' + opts.map(function (o) {
      var v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o;
      return '<option value="' + h(v) + '"' + (String(val) === String(v) ? ' selected' : '') + '>' + h(l) + '</option>';
    }).join('') + '</select>';
  }

  function sourcesHtml() {
    if (M.dests == null) return '<p class="tlac-note">Loading job sources…</p>';
    if (!M.dests.length) return '<p class="tlac-note">No job sources are set up. Configure them under Job Sources / Integrations.</p>';
    return '<div class="tlac-dests">' + M.dests.map(function (d) {
      var on = (M.selected || []).indexOf(d.key) >= 0;
      var dis = d.locked || !d.ready;
      return '<label class="tlac-dest' + (dis && !d.locked ? ' off' : '') + '"><input type="checkbox" data-dest="' + h(d.key) + '"' + (on ? ' checked' : '') + (dis ? ' disabled' : '') + '>'
        + '<span><b>' + h(d.label) + '</b><em>' + h(d.locked ? 'Always - follows the job\'s status' : d.stateLabel) + '</em></span></label>';
    }).join('') + '</div><p class="tlac-note">A source marked "Integration Required" is not connected yet, so it cannot be chosen - set it up under Integrations.</p>';
  }

  function pubsHtml() {
    if (M.mode !== 'edit') return '';
    if (M.pubs == null) return '<p class="tlac-note">Loading publishing status…</p>';
    if (!M.pubs.length) return '<p class="tlac-note">Not published to any source yet.</p>';
    return '<table class="tlac-pubs"><thead><tr><th>Source</th><th>Status</th><th></th></tr></thead><tbody>' + M.pubs.map(function (p) {
      var bad = p.status === 'failed';
      return '<tr><td>' + h(p.label) + '</td><td><span class="tlac-ps ' + h(p.status) + '">' + h(p.statusLabel || p.status) + '</span>'
        + (p.externalUrl ? ' · <a href="' + h(p.externalUrl) + '" target="_blank" rel="noopener">View</a>' : '')
        + (p.lastError ? '<div class="tlac-err">' + h(p.lastError) + '</div>' : '') + '</td>'
        + '<td>' + (bad ? '<button type="button" class="btn btn-ghost btn-sm" onclick="tlacRetry(\'' + h(p.destination) + '\')">Retry</button>' : '') + '</td></tr>';
    }).join('') + '</tbody></table>';
  }

  function modalHtml() {
    var f = M.job;
    var editing = M.mode === 'edit';
    var title = M.mode === 'new' ? 'Post a job' : M.mode === 'copy' ? 'Duplicate job' : 'Manage job';
    var stateTag = editing ? '<span class="tlac-state">' + h(f.archived ? 'Archived' : f.status === 'open' ? 'Published' : f.status === 'closed' ? 'Closed' : 'Draft') + '</span>' : '';
    var j = editing ? jobById(f.id) : null;
    var meta = j ? '<p class="tlac-note">Posted by <b>' + h(j.createdByName || '—') + (j.createdByRole === 'admin' ? ' (Admin)' : j.createdByRole === 'recruiter' ? ' (Recruiter)' : '') + '</b>'
      + (j.createdAt ? ' · ' + h(new Date(j.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })) : '')
      + (j.publishedAt ? ' · published ' + h(new Date(j.publishedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })) : '')
      + (j.lastEditedAt ? ' · last updated ' + h(new Date(j.lastEditedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })) + (j.lastEditedByName ? ' by ' + h(j.lastEditedByName) : '') : '')
      + '</p>' : '';
    var acts = editing
      ? '<div class="tlac-acts">'
        + (f.status === 'open' ? '<button type="button" class="btn btn-ghost btn-sm" onclick="tlacPublish(false)">Unpublish</button>'
          : f.status !== 'closed' ? '<button type="button" class="btn btn-ghost btn-sm" onclick="tlacPublish(true)">Publish</button>' : '')
        + (f.status === 'closed' ? '<button type="button" class="btn btn-ghost btn-sm" onclick="tlacCloseJob(false)">Reopen</button>'
          : '<button type="button" class="btn btn-ghost btn-sm" onclick="tlacCloseJob(true)">Close</button>')
        + '<button type="button" class="btn btn-ghost btn-sm" onclick="tlacOpenJob(\'' + h(f.id) + '\', true)">Duplicate</button>'
        + (f.archived ? '<button type="button" class="btn btn-ghost btn-sm" onclick="tlacArchive(false)">Restore</button>'
          : '<button type="button" class="btn btn-ghost btn-sm" onclick="tlacArchive(true)">Archive</button>')
        + '<button type="button" class="btn btn-ghost btn-sm" onclick="navigate(\'/job/' + h(f.id) + '\')">View posting</button>'
        + '</div>' : '';
    return '<div class="tlac-ov" onclick="if(event.target===this)tlacClose()"><div class="tlac-card" role="dialog" aria-modal="true" aria-labelledby="tlacTitle">'
      + '<div class="tlac-hd"><h2 id="tlacTitle">' + h(title) + '</h2>' + stateTag + '<button type="button" class="tlac-x" onclick="tlacClose()" aria-label="Close">✕</button></div>'
      + '<div class="tlac-body">' + meta + acts
      + (M.err ? '<div class="tlac-msg bad" role="alert">' + h(M.err) + '</div>' : '')
      + (M.result ? '<div class="tlac-msg ok" role="status">' + h(M.result) + '</div>' : '')
      + '<div class="tlac-grid">'
      + fld('tlacF_title', 'Job title', '<input id="tlacF_title" value="' + h(f.title) + '" placeholder="e.g. Staff Nurse">', true)
      + fld('tlacF_companyId', 'Company', sel('tlacF_companyId', f.companyId, [['', 'Select…']].concat(companies().map(function (c) { return [c.id, c.name]; }))), true)
      + fld('tlacF_location', 'Location', '<input id="tlacF_location" value="' + h(f.location) + '" placeholder="e.g. Hyderabad">', true)
      + fld('tlacF_mode', 'Work mode', sel('tlacF_mode', f.mode, ['Onsite', 'Hybrid', 'Remote']))
      + fld('tlacF_type', 'Employment type', sel('tlacF_type', f.type, ['Full-time', 'Part-time', 'Contract', 'Internship', 'Temporary']))
      + fld('tlacF_exp', 'Experience', '<input id="tlacF_exp" value="' + h(f.exp) + '" placeholder="e.g. 1-3 yrs">')
      + fld('tlacF_salaryMin', 'Salary from (₹ LPA)', '<input id="tlacF_salaryMin" type="number" min="0" step="0.5" value="' + h(f.salaryMin) + '">')
      + fld('tlacF_salaryMax', 'Salary to (₹ LPA)', '<input id="tlacF_salaryMax" type="number" min="0" step="0.5" value="' + h(f.salaryMax) + '">')
      + fld('tlacF_openings', 'Openings', '<input id="tlacF_openings" type="number" min="1" step="1" value="' + h(f.openings) + '">')
      + fld('tlacF_lastDate', 'Last date to apply', '<input id="tlacF_lastDate" type="date" value="' + h(f.lastDate) + '">')
      + fld('tlacF_department', 'Department', '<input id="tlacF_department" value="' + h(f.department) + '">')
      + fld('tlacF_education', 'Education', '<input id="tlacF_education" value="' + h(f.education) + '">')
      + '</div>'
      + fld('tlacF_skills', 'Skills', '<input id="tlacF_skills" value="' + h(f.skills.join(', ')) + '" placeholder="Comma-separated, e.g. Patient care, ICU, BLS">')
      + fld('tlacF_desc', 'Job description', '<textarea id="tlacF_desc" rows="6" placeholder="What the role is, what the person will do, what they need.">' + h(f.desc) + '</textarea>')
      + '<h3 class="tlac-h">Publish to</h3>' + sourcesHtml()
      + (editing ? '<h3 class="tlac-h">Publishing status</h3>' + pubsHtml() : '')
      + '</div>'
      + '<div class="tlac-ft"><button type="button" class="btn btn-ghost" onclick="tlacClose()">Close</button>'
      + '<button type="button" class="btn btn-ghost" onclick="tlacSave(false)"' + (M.busy ? ' disabled' : '') + '>' + (editing ? 'Save changes' : 'Save as draft') + '</button>'
      + '<button type="button" class="btn btn-primary" onclick="tlacSave(true)"' + (M.busy ? ' disabled' : '') + '>' + (M.busy ? 'Saving…' : editing && f.status === 'open' ? 'Save & publish updates' : 'Publish') + '</button></div>'
      + '</div></div>';
  }

  function paintModal() {
    var host = $('tlacHost');
    if (!host) { host = document.createElement('div'); host.id = 'tlacHost'; document.body.appendChild(host); }
    if (M.open && M.job) {
      var scroll = host.querySelector('.tlac-body'); var top = scroll ? scroll.scrollTop : 0;
      host.innerHTML = modalHtml();
      var b = host.querySelector('.tlac-body'); if (b && top) b.scrollTop = top;
    } else host.innerHTML = '';
  }

  /* ---- the Jobs table: "Posted By" and a Manage button per row ---- */
  function decorateJobsTable() {
    if (!isAdmin() || !/^#\/admin\/jobs\b/.test(location.hash || '')) return;
    var table = document.querySelector('.dash-admin table.data');
    if (!table || table.getAttribute('data-tlac')) return;
    table.setAttribute('data-tlac', '1');
    var head = table.querySelector('thead tr');
    if (head) {
      [].forEach.call(head.children, function (th) { if (/^Created By$/i.test(th.textContent.trim())) th.textContent = 'Posted By'; });
      var th = document.createElement('th'); th.textContent = 'Actions'; head.appendChild(th);
    }
    [].forEach.call(table.querySelectorAll('tbody tr'), function (tr) {
      var m = /\/job\/([^'"]+)/.exec(tr.getAttribute('onclick') || '');
      if (!m) return;
      var j = jobById(m[1]);
      if (j && j.createdByRole) {
        [].forEach.call(tr.children, function (td) {
          if (j.createdByName && td.textContent.trim() === j.createdByName && !td.querySelector('.tlac-role')) {
            td.insertAdjacentHTML('beforeend', ' <span class="tlac-role ' + (j.createdByRole === 'admin' ? 'admin' : '') + '">' + h(j.createdByRole === 'admin' ? 'Admin' : 'Recruiter') + '</span>');
          }
        });
      }
      var td = document.createElement('td');
      td.innerHTML = '<button type="button" class="btn btn-ghost btn-sm" onclick="event.stopPropagation();tlacOpenJob(\'' + h(m[1]) + '\')">Manage</button>';
      tr.appendChild(td);
    });
  }

  /* ------------------------------------------------------------------ *
   * styles, install
   * ------------------------------------------------------------------ */
  function css() {
    if ($('tlac-css')) return;
    var s = document.createElement('style');
    s.id = 'tlac-css';
    s.textContent = ''
      + '.tlac-tabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--line,#e3e8ef);margin:0 0 16px}'
      + '.tlac-tab{padding:9px 14px;font-size:13.5px;font-weight:600;color:var(--text-soft,#5b6b7d);border-bottom:2px solid transparent;text-decoration:none;margin-bottom:-1px}'
      + '.tlac-tab:hover{color:var(--text,#16202c)}'
      + '.tlac-tab.on{color:var(--brand-600,#4f46e5);border-bottom-color:var(--brand-500,#6366f1)}'
      + '.tlac-jobbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:var(--card,#fff);border:1px solid var(--line,#e3e8ef);border-radius:12px;padding:12px 16px;margin:0 0 14px}'
      + '.tlac-jobbar b{display:block;font-size:14px}.tlac-jobbar span{font-size:12.5px;color:var(--text-soft,#5b6b7d)}'
      + '.tlac-role{display:inline-block;margin-left:4px;font-size:10.5px;font-weight:700;border-radius:99px;padding:1px 7px;background:#eef2f7;color:#4b5b6e}'
      + '.tlac-role.admin{background:#ede9fe;color:#5b21b6}'
      + '.tlac-ov{position:fixed;inset:0;background:rgba(18,32,48,.38);z-index:9100;display:flex;align-items:center;justify-content:center;padding:20px}'
      + '.tlac-card{background:#fff;border-radius:16px;width:100%;max-width:760px;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(16,32,52,.22)}'
      + '.tlac-hd{display:flex;align-items:center;gap:10px;padding:18px 22px 10px}.tlac-hd h2{margin:0;font-size:18px;flex:1}'
      + '.tlac-state{font-size:11.5px;font-weight:700;background:#eef2f7;border-radius:99px;padding:2px 10px}'
      + '.tlac-x{background:none;border:0;font-size:15px;cursor:pointer;color:#8a97a6}'
      + '.tlac-body{padding:6px 22px 14px;overflow:auto}'
      + '.tlac-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px 12px}'
      + '.tlac-f{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}.tlac-f label{font-size:12px;font-weight:700;color:#41506a}'
      + '.tlac-f input,.tlac-f select,.tlac-f textarea{border:1px solid #d7dfea;border-radius:8px;padding:8px 10px;font:inherit;font-size:13.5px}'
      + '.tlac-f.bad input,.tlac-f.bad select,.tlac-f.bad textarea{border-color:#d4342c}'
      + '.tlac-err{font-size:11.5px;color:#b42318;font-weight:600}'
      + '.tlac-h{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#5f7183;margin:14px 0 8px}'
      + '.tlac-dests{display:grid;grid-template-columns:1fr 1fr;gap:8px}'
      + '.tlac-dest{display:flex;gap:9px;align-items:flex-start;border:1px solid #e3e8ef;border-radius:10px;padding:9px 11px;cursor:pointer}'
      + '.tlac-dest span{display:flex;flex-direction:column}.tlac-dest em{font-style:normal;font-size:11.5px;color:#5f7183}'
      + '.tlac-dest.off{opacity:.6;cursor:not-allowed}'
      + '.tlac-note{font-size:12px;color:#5f7183;margin:6px 0}'
      + '.tlac-msg{border-radius:9px;padding:9px 12px;font-size:13px;margin:6px 0 10px}.tlac-msg.bad{background:#fef3f2;color:#b42318}.tlac-msg.ok{background:#ecfdf3;color:#067647}'
      + '.tlac-acts{display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 10px}'
      + '.tlac-pubs{width:100%;border-collapse:collapse;font-size:13px}.tlac-pubs td,.tlac-pubs th{border-bottom:1px solid #eef2f7;padding:6px 4px;text-align:left}'
      + '.tlac-ps{font-weight:600}.tlac-ps.failed{color:#b42318}.tlac-ps.posted{color:#067647}'
      + '.tlac-ft{display:flex;justify-content:flex-end;gap:8px;padding:12px 22px;border-top:1px solid #eef2f7;background:#fbfcfe;border-radius:0 0 16px 16px;flex-wrap:wrap}'
      + '@media (max-width:720px){.tlac-grid,.tlac-dests{grid-template-columns:1fr}.tlac-ov{padding:0}.tlac-card{max-height:100%;height:100%;border-radius:0}}';
    document.head.appendChild(s);
  }

  function install() {
    css();
    wrapShell();
    var prevRender = window.render;
    if (typeof prevRender === 'function' && !prevRender.__tlac) {
      var r = function () {
        /* a module that wraps dashShell AFTER this one does not hide the seven: wrap again, outermost */
        if (window.dashShell && !window.dashShell.__tlac) wrapShell();
        var out = prevRender.apply(this, arguments);
        setTimeout(function () { try { decorateJobsTable(); } catch (e) { /* cosmetic */ } }, 0);
        return out;
      };
      r.__tlac = true;
      window.render = r;
    }
    try { if (/^#\/admin\//.test(location.hash || '') && typeof window.render === 'function') window.render(); } catch (e) { /* next navigation */ }
  }

  if (document.readyState === 'complete') setTimeout(install, 0);
  else window.addEventListener('load', function () { setTimeout(install, 0); });

  window.TLAdminConsole = { groups: GROUPS, groupOf: function (k) { return GROUP_OF[k] || null; } };
})();
