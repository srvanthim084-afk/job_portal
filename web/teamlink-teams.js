/* =====================================================================
   TEAMLINK - Teams (0118)

   ADMIN  #/admin/teams
     Team Leads, each expandable to the recruiters assigned to them. The
     recruiter's login email, department and Team Lead are editable here;
     so is the status. Search (TL, recruiter, email, phone) and filters
     (department, TL, status). The Candidate Contact Cooldown (days) is
     the one setting at the top.

   TEAM LEAD  #/recruiter/team   ("My Team", shown only to a TL)
     Team cards (recruiters, jobs, applied, candidates contacted) with a
     Today / 7 Days / 30 Days / Custom filter, and each recruiter's
     figures. A recruiter expands to their jobs (with the applicants on
     each) and their contact activity.

   EVERY FIGURE COMES FROM THE SERVER (api/src/routes/teams.js). This file
   renders what it is given and sends what the person typed; it decides
   nothing about who may see what.

   ADDITIVE. One new admin page, one new recruiter page, one wrapped
   render() to show "My Team" to a TL. No existing screen is replaced.
   ===================================================================== */
(function () {
  'use strict';
  if (window.TLTeams) return;

  var S = {
    admin: { data: null, q: '', dept: '', tl: '', status: '', open: {}, loading: false },
    team: { range: '7d', from: '', to: '', data: null, open: {}, detail: {}, jobs: {}, loading: false },
  };

  function api() { return window.TL && window.TL.api; }
  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function say(m, i) { if (typeof window.toast === 'function') window.toast(m, i || 'ℹ️'); }
  function fail(err) {
    var m = (err && err.message) || 'That did not work.';
    if (err && err.details && typeof err.details === 'object') {
      var d = Object.keys(err.details).map(function (k) { return err.details[k]; }).filter(Boolean)[0];
      if (d && typeof d === 'string') m = d;
    }
    say(m, '⚠️');
  }
  function when(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
      + ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  }
  function day(v) {
    if (!v) return '—';
    var d = new Date(v);
    return isNaN(d) ? '—' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  }
  var CH = { phone: 'Call', whatsapp: 'WhatsApp', email: 'Email', sms: 'SMS', ai_call: 'AI Call' };
  function badge(status) {
    return status === 'active' ? '<span class="badge badge-ok">Active</span>' : '<span class="badge badge-neutral">Inactive</span>';
  }
  function mail(e) { return e ? '<a href="mailto:' + h(e) + '">' + h(e) + '</a>' : '—'; }
  function tel(p) { return p ? '<a href="tel:' + h(String(p).replace(/[^\d+]/g, '')) + '">' + h(p) + '</a>' : '—'; }
  function qs(o) {
    return Object.keys(o).filter(function (k) { return o[k] !== '' && o[k] != null; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&');
  }

  function css() {
    if (document.getElementById('tltCss')) return;
    var s = document.createElement('style');
    s.id = 'tltCss';
    s.textContent = ''
      + '.tlt-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 12px}'
      + '.tlt-bar input,.tlt-bar select,.tlt-in{border:1px solid #cfd6e0;border-radius:6px;height:34px;padding:0 10px;font-size:13px;background:#fff;color:#33465c;box-sizing:border-box}'
      + '.tlt-bar input[type=search],.tlt-bar input.q{min-width:220px}'
      + '.tlt-in{width:100%;min-width:90px;height:30px;font-size:12.5px;flex:1 1 130px;max-width:230px}'
      + '.tlt-inline{display:flex;gap:6px;align-items:center;flex-wrap:wrap}'
      + '.tlt-tl td{background:#f5f8fb;font-weight:600}'
      + '.tlt-mem td:first-child{padding-left:30px}'
      + '.tlt-x{border:0;background:none;cursor:pointer;font-size:13px;padding:0 6px 0 0;color:#42546b}'
      + '.tlt-sub{padding:10px 14px 14px 30px;background:#fbfcfd}'
      + '.tlt-sub h4{margin:12px 0 6px;font-size:13px}'
      + '.tlt-sub table{width:100%}'
      + '.tlt-sub table.data td:first-child,.tlt-sub table.data th:first-child{position:static!important}'
      + '.tlt-cell{display:flex;flex-direction:column;gap:3px;font-size:12.5px;line-height:1.35}'
      + '.tlt-act{display:flex;flex-direction:column;gap:5px;align-items:stretch;min-width:170px}'
      + '.tlt-t th,.tlt-t td{padding:9px 10px;vertical-align:middle}'
      + '.tlt-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:0 0 12px}'
      + '.tlt-chip{border:1px solid #cfd6e0;background:#fff;border-radius:999px;padding:5px 13px;font-size:12.5px;cursor:pointer;color:#33465c}'
      + '.tlt-chip.on{background:var(--brand-500,#1490b3);border-color:var(--brand-500,#1490b3);color:#fff}'
      + '.tlt-muted{color:#6a7a8c;font-size:12.5px}'
      + '.tlt-days{width:80px;border:1px solid #cfd6e0;border-radius:6px;height:34px;padding:0 8px}'
      + '.tlt-over{font-size:11px;color:#9a5b00;margin-left:6px}';
    document.head.appendChild(s);
  }

  /* ================================================================ *
   * admin: Teams
   * ================================================================ */
  function adminLoad() {
    var a = S.admin;
    if (!api()) return;
    a.loading = true;
    api().get('/admin/teams?' + qs({ q: a.q, department: a.dept, tlId: a.tl, status: a.status })).then(function (d) {
      a.data = d; a.loading = false; adminPaintBody();
    }, function (err) { a.loading = false; fail(err); });
  }

  function adminShell() {
    css();
    return '<div class="panel"><div class="panel-head"><div><h2>Candidate Contact Cooldown</h2>'
      + '<div class="desc">A candidate one recruiter has contacted is not contacted by another recruiter for this many days, on any channel. '
      + 'The same recruiter may follow up. An admin or a team lead may override, with a reason.</div></div></div>'
      + '<div class="panel-body"><div class="tlt-inline"><input type="number" class="tlt-days" id="tltDays" min="1" max="90" step="1"> days '
      + '<button class="btn btn-primary btn-sm" onclick="TLTeams.saveDays()">Save</button>'
      + '<span class="tlt-muted">Between 1 and 90. Changing it affects future checks only.</span></div></div></div>'
      + '<div class="panel"><div class="panel-head"><div><h2>Team Leads and recruiters</h2>'
      + '<div class="desc">Each recruiter has one team lead and one department at a time. Moving them keeps their jobs, applications and contact history.</div></div></div>'
      + '<div class="panel-body"><div id="tltFilters"></div><div id="tltBody"><div class="empty-note">Loading…</div></div></div></div>';
  }

  function opts(list, cur, blank) {
    return '<option value="">' + h(blank) + '</option>' + list.map(function (x) {
      var v = typeof x === 'string' ? x : x.id; var l = typeof x === 'string' ? x : x.name;
      return '<option value="' + h(v) + '"' + (v === cur ? ' selected' : '') + '>' + h(l) + '</option>';
    }).join('');
  }

  function adminFilters() {
    var a = S.admin; var d = a.data || { allTeamLeads: [], departments: [] };
    return '<div class="tlt-bar">'
      + '<input class="q" id="tltQ" type="search" placeholder="Search TL, recruiter, email or phone" value="' + h(a.q) + '" oninput="TLTeams.filter(\'q\',this.value)">'
      + '<select onchange="TLTeams.filter(\'dept\',this.value)">' + opts(d.departments, a.dept, 'All departments') + '</select>'
      + '<select onchange="TLTeams.filter(\'tl\',this.value)">' + opts(d.allTeamLeads, a.tl, 'All team leads') + '</select>'
      + '<select onchange="TLTeams.filter(\'status\',this.value)">'
      + '<option value="">Any status</option><option value="active"' + (a.status === 'active' ? ' selected' : '') + '>Active</option>'
      + '<option value="inactive"' + (a.status === 'inactive' ? ' selected' : '') + '>Inactive</option></select></div>';
  }

  function recruiterRow(m, tls, cls, assignedTl) {
    var tlOpts = tls.filter(function (t) { return t.status === 'active' || t.id === assignedTl; });
    var id = h(m.id);
    return '<tr class="' + cls + '"><td>' + h(m.name) + '</td>'
      + '<td><div class="tlt-inline"><input class="tlt-in" id="tltE_' + id + '" type="email" value="' + h(m.email) + '" aria-label="Login email">'
      + '<button class="btn btn-ghost btn-sm" onclick="TLTeams.saveEmail(\'' + id + '\')">Save</button></div></td>'
      + '<td>' + tel(m.phone) + '</td>'
      + '<td><div class="tlt-inline"><input class="tlt-in" id="tltD_' + id + '" value="' + h(m.department || '') + '" aria-label="Department">'
      + '<button class="btn btn-ghost btn-sm" onclick="TLTeams.saveDept(\'' + id + '\')">Save</button></div></td>'
      + '<td>' + badge(m.status) + '<div style="margin-top:4px"><button class="btn btn-ghost btn-sm" onclick="TLTeams.setStatus(\'' + id + '\',' + (m.status === 'active' ? 'false' : 'true') + ')">'
      + (m.status === 'active' ? 'Deactivate' : 'Activate') + '</button></div></td>'
      + '<td><div class="tlt-act"><select class="tlt-in" aria-label="Team lead" onchange="TLTeams.assign(\'' + id + '\',this.value)">'
      + opts(tlOpts, assignedTl || '', assignedTl ? 'Change team lead…' : 'Assign to a team lead…') + '</select>'
      + (assignedTl ? '<button class="btn btn-ghost btn-sm" onclick="TLTeams.unassign(\'' + id + '\')">Remove from team</button>' : '<button class="btn btn-ghost btn-sm" onclick="TLTeams.makeTl(\'' + id + '\',true)">Make team lead</button>')
      + '<button class="btn btn-ghost btn-sm" onclick="TLTeams.history(\'' + id + '\')">Assignment history</button></div></td></tr>';
  }

  function adminPaintBody() {
    var f = document.getElementById('tltFilters'); var b = document.getElementById('tltBody');
    var a = S.admin; var d = a.data;
    var days = document.getElementById('tltDays');
    if (d && days && document.activeElement !== days) days.value = d.cooldownDays;
    if (!b) return;
    /* The search box keeps focus: only the filters' first paint writes it. */
    if (f && !a._fd) { f.innerHTML = adminFilters(); a._fd = true; }
    if (!d) { b.innerHTML = '<div class="empty-note">Loading…</div>'; return; }

    var rows = '';
    d.teamLeads.forEach(function (t) {
      var open = a.open[t.id] !== false;       // open unless closed
      rows += '<tr class="tlt-tl"><td><button class="tlt-x" aria-expanded="' + open + '" onclick="TLTeams.toggle(\'' + h(t.id) + '\')">' + (open ? '▼' : '▶') + '</button>'
        + h(t.name) + ' <span class="badge badge-brand">TL</span></td>'
        + '<td>' + mail(t.email) + '</td><td>' + tel(t.phone) + '</td><td>' + h(t.department || '—') + '</td>'
        + '<td>' + badge(t.status) + '</td>'
        + '<td><div class="tlt-act"><span>' + t.recruiterCount + ' recruiter' + (t.recruiterCount === 1 ? '' : 's') + '</span>'
        + '<button class="btn btn-ghost btn-sm" onclick="TLTeams.makeTl(\'' + h(t.id) + '\',false)">Stop being team lead</button></div></td></tr>';
      if (open) {
        if (!t.recruiters.length) rows += '<tr class="tlt-mem"><td colspan="6" class="tlt-muted">No recruiters assigned yet.</td></tr>';
        t.recruiters.forEach(function (m) { rows += recruiterRow(m, d.allTeamLeads, 'tlt-mem', t.id); });
      }
    });
    if (!d.teamLeads.length) rows += '<tr><td colspan="6" class="empty-note">No team leads match. Make a recruiter a team lead from the list below.</td></tr>';

    var un = '';
    d.unassigned.forEach(function (m) { un += recruiterRow(m, d.allTeamLeads, 'tlt-un', ''); });

    var head = '<thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Department</th><th>Status</th><th>Team lead / actions</th></tr></thead>';
    b.innerHTML = '<div class="tbl-wrap"><table class="data tlt-t">' + head + '<tbody>' + rows + '</tbody></table></div>'
      + '<h3 style="margin:18px 0 8px;font-size:14px">Recruiters not on a team (' + d.unassigned.length + ')</h3>'
      + (d.unassigned.length ? '<div class="tbl-wrap"><table class="data tlt-t">' + head + '<tbody>' + un + '</tbody></table></div>'
        : '<div class="tlt-muted">Every recruiter shown is on a team.</div>');
  }

  function reload(msg) { if (msg) say(msg, '✅'); adminLoad(); }

  /* ================================================================ *
   * team lead: My Team
   * ================================================================ */
  function teamLoad() {
    var t = S.team;
    if (!api()) return;
    t.loading = true;
    api().get('/team/summary?' + qs({ range: t.range, from: t.from, to: t.to })).then(function (d) {
      t.data = d; t.loading = false; t.detail = {}; teamPaintBody();
    }, function (err) { t.loading = false; fail(err); var b = document.getElementById('tltTeamBody'); if (b) b.innerHTML = '<div class="empty-note">' + h(err.message || 'Could not load.') + '</div>'; });
  }

  function teamShell() {
    css();
    return '<div id="tltTeamHost"><div class="empty-note">Loading…</div></div>';
  }

  function chips() {
    var t = S.team;
    function c(k, l) { return '<button class="tlt-chip' + (t.range === k ? ' on' : '') + '" onclick="TLTeams.range(\'' + k + '\')">' + l + '</button>'; }
    var custom = t.range === 'custom'
      ? '<input type="date" class="tlt-in" style="width:150px" id="tltFrom" value="' + h(t.from) + '"> to '
        + '<input type="date" class="tlt-in" style="width:150px" id="tltTo" value="' + h(t.to) + '">'
        + '<button class="btn btn-primary btn-sm" onclick="TLTeams.applyCustom()">Apply</button>' : '';
    return '<div class="tlt-chips">' + c('today', 'Today') + c('7d', '7 Days') + c('30d', '30 Days') + c('custom', 'Custom') + custom + '</div>';
  }

  function card(label, val) {
    return '<div class="stat-tile"><div class="lbl">' + h(label) + '</div><div class="val tabular">' + h(val) + '</div></div>';
  }

  function teamPaintBody() {
    var host = document.getElementById('tltTeamHost'); var d = S.team.data;
    if (!host) return;
    if (!d) { host.innerHTML = '<div class="empty-note">Loading…</div>'; return; }
    var rows = '';
    d.recruiters.forEach(function (r) {
      var open = !!S.team.open[r.id];
      rows += '<tr><td><button class="tlt-x" aria-expanded="' + open + '" onclick="TLTeams.openRec(\'' + h(r.id) + '\')">' + (open ? '▼' : '▶') + '</button><b>' + h(r.name) + '</b></td>'
        + '<td><div class="tlt-cell">' + mail(r.email) + tel(r.phone) + '</div></td><td>' + h(r.department || '—') + '</td><td>' + badge(r.status) + '</td>'
        + '<td>' + r.jobsPosted + '</td><td>' + r.candidatesContacted + '</td><td>' + r.totalApplied + '</td><td>' + h(when(r.lastContacted)) + '</td></tr>';
      if (open) rows += '<tr><td colspan="8" class="tlt-sub" id="tltRec_' + h(r.id) + '">Loading…</td></tr>';
    });
    if (!d.recruiters.length) rows = '<tr><td colspan="8" class="empty-note">No recruiters are assigned to you yet. An administrator assigns recruiters to a team lead.</td></tr>';
    host.innerHTML = chips()
      + '<div class="stat-row">' + card('Total Recruiters', d.cards.totalRecruiters) + card('Total Jobs', d.cards.totalJobs)
      + card('Total Applied', d.cards.totalApplied) + card('Candidates Contacted', d.cards.totalCandidatesContacted) + '</div>'
      + '<div class="panel"><div class="panel-head"><div><h2>My Recruiters</h2><div class="desc">Jobs, applied and contacted are for the period chosen above.</div></div></div>'
      + '<div class="panel-body pad0"><div class="tbl-wrap"><table class="data tlt-t"><thead><tr><th>Recruiter</th><th>Email / Phone</th><th>Department</th><th>Status</th>'
      + '<th>Jobs Posted</th><th>Candidates Contacted</th><th>Total Applied</th><th>Last Contacted</th></tr></thead><tbody>' + rows + '</tbody></table></div></div></div>';
    Object.keys(S.team.open).forEach(function (id) { if (S.team.open[id]) paintRec(id); });
  }

  function paintRec(id) {
    var el = document.getElementById('tltRec_' + id); var det = S.team.detail[id];
    if (!el) return;
    if (!det) {
      api().get('/team/recruiters/' + encodeURIComponent(id) + '?' + qs({ range: S.team.range, from: S.team.from, to: S.team.to })).then(function (d) {
        S.team.detail[id] = d; paintRec(id);
      }, function (err) { el.innerHTML = h(err.message || 'Could not load.'); });
      return;
    }
    var jobs = det.jobs.map(function (j) {
      var ap = S.team.jobs[id + '|' + j.id];
      return '<tr><td>' + h(j.id) + '</td><td><a href="#/job/' + h(j.id) + '">' + h(j.title) + '</a></td><td>' + h(j.status) + '</td><td>' + day(j.postedAt) + '</td>'
        + '<td><button class="ss-link" onclick="TLTeams.applicants(\'' + h(id) + '\',\'' + h(j.id) + '\')">' + j.applications + ' application' + (j.applications === 1 ? '' : 's') + '</button></td></tr>'
        + (ap ? '<tr><td colspan="5">' + (ap === 'loading' ? 'Loading…' : applicantTable(ap)) + '</td></tr>' : '');
    }).join('') || '<tr><td colspan="5" class="tlt-muted">No jobs posted.</td></tr>';
    var acts = det.contactActivity.map(function (x) {
      return '<tr><td>' + h(when(x.at)) + '</td><td>' + h(x.candidateName || x.candidateId) + '</td><td>' + h(CH[x.channel] || x.channel) + '</td><td>' + h(x.outcome || '—')
        + (x.overridden ? '<span class="tlt-over" title="' + h(x.overrideReason || '') + '">override</span>' : '') + '</td></tr>';
    }).join('') || '<tr><td colspan="4" class="tlt-muted">No contact activity.</td></tr>';
    el.innerHTML = '<h4>Jobs (' + det.jobs.length + ')</h4><div class="tbl-wrap"><table class="data"><thead><tr><th>Job ID</th><th>Job Title</th><th>Status</th><th>Posted</th><th>Applications</th></tr></thead><tbody>' + jobs + '</tbody></table></div>'
      + '<h4>Contact activity</h4><div class="tbl-wrap"><table class="data"><thead><tr><th>When</th><th>Candidate</th><th>Channel</th><th>Outcome</th></tr></thead><tbody>' + acts + '</tbody></table></div>';
  }

  function applicantTable(ap) {
    if (!ap.applicants.length) return '<span class="tlt-muted">No applicants yet.</span>';
    return '<table class="data"><thead><tr><th>Applicant</th><th>Applied</th><th>Stage</th><th>Application ID</th></tr></thead><tbody>'
      + ap.applicants.map(function (a) {
        return '<tr><td>' + h(a.name) + ' <span class="tlt-muted">' + h(a.email || a.phone || '') + '</span></td><td>' + day(a.appliedAt) + '</td><td>' + h(a.stage) + '</td><td>' + h(a.reference || a.applicationId) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  /* ================================================================ *
   * handlers
   * ================================================================ */
  var timer = null;
  window.TLTeams = {
    state: S,
    filter: function (k, v) {
      S.admin[k] = v;
      clearTimeout(timer);
      timer = setTimeout(adminLoad, k === 'q' ? 300 : 0);
    },
    toggle: function (id) { S.admin.open[id] = S.admin.open[id] === false; adminPaintBody(); },
    saveDays: function () {
      var v = Number((document.getElementById('tltDays') || {}).value);
      if (!(v >= 1 && v <= 90) || Math.floor(v) !== v) { say('Enter a whole number of days from 1 to 90.', '⚠️'); return; }
      api().put('/admin/contact-cooldown', { days: v }).then(function () { say('Cooldown set to ' + v + ' day' + (v === 1 ? '' : 's'), '✅'); }, fail);
    },
    saveEmail: function (id) {
      var el = document.getElementById('tltE_' + id); var v = el ? el.value.trim() : '';
      if (!v) { say('Enter an email address.', '⚠️'); return; }
      if (!window.confirm('Change this recruiter\'s login email to ' + v + '?\n\nThe old address will stop working at once and they will be signed out.')) return;
      api().patch('/admin/recruiters/' + encodeURIComponent(id), { email: v }).then(function (r) {
        reload(r && r.email && r.email.changed === false ? 'That is already their email.' : 'Email changed. The old address no longer signs in.');
      }, fail);
    },
    saveDept: function (id) {
      var el = document.getElementById('tltD_' + id); var v = el ? el.value.trim() : '';
      api().patch('/admin/recruiters/' + encodeURIComponent(id), { department: v }).then(function () { reload('Department saved.'); }, fail);
    },
    assign: function (id, tlId) {
      if (!tlId) return;
      var dept = (document.getElementById('tltD_' + id) || {}).value || '';
      api().post('/admin/teams/assign', { recruiterId: id, tlId: tlId, department: dept.trim() || undefined }).then(function () { reload('Assigned.'); }, function (err) { fail(err); adminLoad(); });
    },
    unassign: function (id) {
      if (!window.confirm('Remove this recruiter from their team? Their jobs, applications and contact history stay as they are.')) return;
      api().post('/admin/teams/unassign', { recruiterId: id }).then(function () { reload('Removed from the team.'); }, fail);
    },
    makeTl: function (id, on) {
      if (!on && !window.confirm('Stop this person being a team lead? Reassign their recruiters first.')) return;
      api().post('/admin/recruiters/' + encodeURIComponent(id) + '/team-lead', { on: on }).then(function () { reload(on ? 'Now a team lead.' : 'No longer a team lead.'); }, fail);
    },
    setStatus: function (id, active) {
      api().post('/staff/recruiters/' + encodeURIComponent(id) + '/status', { active: active }).then(function () { reload(active ? 'Activated.' : 'Deactivated. Their work is kept.'); }, fail);
    },
    history: function (id) {
      api().get('/admin/recruiters/' + encodeURIComponent(id) + '/assignments').then(function (d) {
        var rows = d.assignments.map(function (a) {
          return '<tr><td>' + h(a.tlName) + '</td><td>' + h(a.department || '—') + '</td><td>' + h(when(a.startedAt)) + '</td><td>' + (a.current ? '<span class="badge badge-ok">Current</span>' : h(when(a.endedAt)) + ' · ' + h(a.endReason || '')) + '</td></tr>';
        }).join('') || '<tr><td colspan="4" class="tlt-muted">Never assigned.</td></tr>';
        if (typeof window.fcrModal === 'function') {
          window.fcrModal('<div class="fcr-modal-head"><h3>Assignment history</h3><button class="btn btn-ghost btn-sm" onclick="fcrCloseModal()">✕</button></div>'
            + '<div class="fcr-modal-body"><div class="tbl-wrap"><table class="data"><thead><tr><th>Team lead</th><th>Department</th><th>From</th><th>Until</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>');
        }
      }, fail);
    },
    range: function (k) { S.team.range = k; if (k !== 'custom') { S.team.from = ''; S.team.to = ''; teamLoad(); } else teamPaintBody(); },
    applyCustom: function () {
      S.team.from = (document.getElementById('tltFrom') || {}).value || '';
      S.team.to = (document.getElementById('tltTo') || {}).value || '';
      if (!S.team.from || !S.team.to) { say('Choose both dates.', '⚠️'); return; }
      teamLoad();
    },
    openRec: function (id) { S.team.open[id] = !S.team.open[id]; teamPaintBody(); },
    applicants: function (rid, jobId) {
      var k = rid + '|' + jobId;
      if (S.team.jobs[k]) { delete S.team.jobs[k]; paintRec(rid); return; }
      S.team.jobs[k] = 'loading'; paintRec(rid);
      api().get('/team/recruiters/' + encodeURIComponent(rid) + '/jobs/' + encodeURIComponent(jobId) + '/applicants').then(function (d) {
        S.team.jobs[k] = d; paintRec(rid);
      }, function (err) { delete S.team.jobs[k]; fail(err); paintRec(rid); });
    },
  };

  /* ================================================================ *
   * wiring: the admin page, the TL page, the TL's menu item
   * ================================================================ */
  function nav(role) { try { return typeof NAV_CONFIG !== 'undefined' ? NAV_CONFIG[role] : null; } catch (e) { return null; } }

  function install() {
    if (typeof window.pageAdminDash !== 'function' || typeof window.pageRecruiterDash !== 'function' || typeof window.dashShell !== 'function') return false;
    var an = nav('admin');
    if (an && !an.some(function (n) { return n[0] === 'teams'; })) {
      var i = an.findIndex(function (n) { return n[0] === 'recruiters'; });
      an.splice(i >= 0 ? i + 1 : an.length, 0, ['teams', 'Teams', '👥']);
    }
    if (!window.pageAdminDash.__tlt) {
      var pa = window.pageAdminDash;
      var wa = function (section) {
        if (section !== 'teams') return pa.apply(this, arguments);
        setTimeout(function () { S.admin.data = null; S.admin._fd = false; adminLoad(); }, 0);
        return window.dashShell('admin', 'teams', 'Teams', 'Admin · TeamLink Platform', adminShell());
      };
      wa.__tlt = true; window.pageAdminDash = wa;
    }
    if (!window.pageRecruiterDash.__tlt) {
      var pr = window.pageRecruiterDash;
      var wr = function (section) {
        if (section !== 'team') return pr.apply(this, arguments);
        var ok = window.STATE && STATE.session && STATE.session.isTeamLead;
        if (!ok) return window.dashShell('recruiter', 'team', 'My Team', 'Recruiter · Team',
          '<div class="panel"><div class="panel-body"><div class="empty-note">My Team is for team leads.</div></div></div>');
        setTimeout(function () { S.team.data = null; teamLoad(); }, 0);
        return window.dashShell('recruiter', 'team', 'My Team', 'Recruiter · Team', teamShell());
      };
      wr.__tlt = true; window.pageRecruiterDash = wr;
    }
    if (!window.render.__tlt) {
      var pRender = window.render;
      var wRender = function () {
        /* My Team is in the menu of a team lead and nobody else. */
        var rn = nav('recruiter');
        if (rn) {
          var isTl = !!(window.STATE && STATE.session && STATE.session.role === 'recruiter' && STATE.session.isTeamLead);
          var at = rn.findIndex(function (n) { return n[0] === 'team'; });
          if (isTl && at < 0) rn.push(['team', 'My Team', '👥']);
          if (!isTl && at >= 0) rn.splice(at, 1);
        }
        return pRender.apply(this, arguments);
      };
      wRender.__tlt = true; window.render = wRender;
    }
    /* A page opened by URL is drawn before these wrappers exist; draw it
       again once, so a bookmarked #/admin/teams or #/recruiter/team shows. */
    if (!install.drawn && /^#\/(admin\/teams|recruiter\/team)/.test(location.hash || '')
        && window.STATE && STATE.session && typeof window.render === 'function') {
      install.drawn = true;
      window.render();
    }
    return true;
  }

  /* Other modules wrap these same page functions and rebuild the menu as
     they load, in no fixed order, so a wrapper installed once can end up
     underneath one that does not know about it. Check again for the first
     half-minute (install is idempotent: it only acts when ours is not on top). */
  var tries = 0;
  var t = setInterval(function () { install(); if (++tries > 60) clearInterval(t); }, 500);
})();
