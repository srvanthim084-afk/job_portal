/*
 * TeamLink — Walk-in Drives (0099), candidate and recruiter screens.
 *
 * Candidate  #/candidate/walkins                    drives near you: filters, cards, "X days left"
 *            #/candidate/walkins?tab=mine           My Registrations, upcoming and past
 *            #/candidate/walkins?id=<drive>         details: documents, map, contact, register/cancel
 *            #/candidate/walkins?id=<drive>&done=1  the confirmation, with Add to Calendar
 * Recruiter  #/recruiter/walkins                    my drives, create / edit / cancel
 *            #/recruiter/walkins?id=<drive>         registrations: search, status, attendance, export
 *
 * Everything is read from and written to /api (walkin-drives routes);
 * nothing about a drive or a registration is kept in the browser. The
 * server enforces every rule (seats, dates, ownership) - the buttons here
 * are a convenience and the server's message is what the person is shown.
 *
 * Wiring, appended and never reordering anything:
 *   - "Walk-in Drives" in the candidate header nav, the profile menu and
 *     the mobile drawer; a recruiter sidebar item
 *   - pageCandidateDash('walkins') and pageRecruiterDash('walkins')
 *   - walk-in notifications in the candidate bell open the drive
 */
(function () {
  'use strict';

  var C = { list: null, cities: [], myCity: '', loading: false, f: { city: '', role: '', date: '', q: '' }, cityTouched: false,
            mine: null, detail: {}, busy: false, at: 0 };
  var R = { list: null, jobs: [], companies: [], loading: false, form: null, errors: {}, regs: {}, q: '', status: '', busy: false };

  var api = function () { return window.TL && TL.api; };
  var role = function () { return window.STATE && STATE.session ? STATE.session.role : null; };
  var h = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  };
  var js = function (v) { return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); };
  var say = function (m, i) { if (typeof window.toast === 'function') toast(m, i || '🚶'); };
  var rerender = function () { if (typeof window.render === 'function') render(); };
  var params = function () { try { return currentRoute().params || {}; } catch (e) { return {}; } };
  var go = function (hash) { if (location.hash === hash) rerender(); else location.hash = hash; };

  function daysBadge(d) {
    if (d.status === 'ONGOING') return '<span class="wk-badge live">Happening now</span>';
    if (d.status === 'CANCELLED') return '<span class="wk-badge off">Cancelled</span>';
    if (d.status === 'COMPLETED') return '<span class="wk-badge off">Completed</span>';
    var n = d.daysLeft;
    var t = n <= 0 ? 'Today' : n === 1 ? '1 day left' : n + ' days left';
    return '<span class="wk-badge ' + (n <= 2 ? 'soon' : '') + '">' + t + '</span>';
  }
  function matchBadge(m) {
    if (!m) return '';
    var tier = m.score >= 80 ? 'hi' : m.score >= 60 ? 'mid' : 'lo';
    return '<span class="wk-match ' + tier + '" title="AI match: your profile against this drive\'s role'
      + (m.matchedSkills && m.matchedSkills.length ? ' · matched ' + h(m.matchedSkills.join(', ')) : '') + '">🎯 ' + m.score + '% match</span>';
  }
  function seatsText(d) {
    if (d.maxSeats == null) return '';
    return d.seatsLeft > 0 ? d.seatsLeft + ' of ' + d.maxSeats + ' seats left' : 'All seats taken';
  }
  function regBadge(r) {
    if (!r) return '';
    var map = { REGISTERED: ['good', '✓ Registered'], ATTENDED: ['good', '✓ Attended'], NO_SHOW: ['off', 'Marked absent'], CANCELLED: ['off', 'Registration cancelled'] };
    var x = map[r.status] || ['', r.status];
    return '<span class="wk-badge ' + x[0] + '">' + x[1] + '</span>';
  }
  var mapsUrl = function (d) {
    return d.mapLink || ('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([d.venueName, d.fullAddress, d.city].join(', ')));
  };
  var icsUrl = function (d) { return '/api/walkin-drives/' + encodeURIComponent(d.id) + '/calendar.ics'; };
  function errText(err) {
    if (!err) return 'Something went wrong.';
    return err.message || 'Something went wrong.';
  }

  /* ================================================================== *
   * CANDIDATE
   * ================================================================== */

  function loadDrives(force) {
    if (!api() || role() !== 'candidate') return;
    if (C.loading || (!force && C.list && Date.now() - C.at < 20000)) return;
    C.loading = true;
    var q = [];
    ['city', 'role', 'date', 'q'].forEach(function (k) { if (C.f[k]) q.push(k + '=' + encodeURIComponent(C.f[k])); });
    api().get('/walkin-drives' + (q.length ? '?' + q.join('&') : '')).then(function (out) {
      C.list = out.drives || []; C.cities = out.cities || []; C.at = Date.now(); C.loading = false;
      // First visit: start with the candidate's own city when drives exist there.
      if (!C.cityTouched && !C.f.city && out.myCity) {
        var mine = (out.cities || []).filter(function (c) { return c.toLowerCase() === String(out.myCity).toLowerCase(); })[0];
        C.myCity = out.myCity;
        if (mine) { C.cityTouched = true; C.f.city = mine; C.loading = false; loadDrives(true); return; }
      }
      C.cityTouched = true;
      rerender();
    }).catch(function (err) { C.loading = false; C.list = C.list || []; C.err = errText(err); rerender(); });
  }

  function loadMine(force) {
    if (!api() || role() !== 'candidate' || (C.mine && !force)) return;
    api().get('/my-walkin-registrations').then(function (out) { C.mine = out; rerender(); })
      .catch(function (err) { C.mine = { upcoming: [], past: [], error: errText(err) }; rerender(); });
  }

  function loadDetail(id, force) {
    if (!api() || (C.detail[id] && !force)) return;
    C.detail[id] = C.detail[id] || { loading: true };
    api().get('/walkin-drives/' + encodeURIComponent(id)).then(function (out) {
      C.detail[id] = { drive: out.drive }; rerender();
    }).catch(function (err) { C.detail[id] = { error: errText(err) }; rerender(); });
  }

  function card(d) {
    var reg = d.myRegistration;
    // registered, attended or marked absent: nothing to register for
    var active = reg && reg.status !== 'CANCELLED';
    var full = d.maxSeats != null && d.seatsLeft <= 0;
    var open = d.status === 'UPCOMING' || d.status === 'ONGOING';
    return '<div class="wk-card" onclick="location.hash=\'#/candidate/walkins?id=' + encodeURIComponent(d.id) + '\'">'
      + '<div class="wk-top"><div style="min-width:0;flex:1">'
      + '<h3>' + h(d.title) + '</h3>'
      + '<div class="wk-sub">' + (d.companyName ? h(d.companyName) + ' · ' : '') + h(d.jobRole) + '</div></div>'
      + '<div class="wk-badges">' + daysBadge(d) + matchBadge(d.match) + '</div></div>'
      + '<div class="wk-meta">'
      + '<span>📅 ' + h(d.dateLabel) + '</span><span>🕒 ' + h(d.timeLabel) + '</span>'
      + '<span>📍 ' + h(d.venueName) + ', ' + h(d.city) + '</span>'
      + (d.salaryRange ? '<span>💰 ' + h(d.salaryRange) + '</span>' : '')
      + (d.experienceRequired ? '<span>💼 ' + h(d.experienceRequired) + '</span>' : '')
      + '</div>'
      + '<div class="wk-foot" onclick="event.stopPropagation()">'
      + '<span class="wk-seats">' + h(seatsText(d)) + '</span>'
      + (reg ? regBadge(reg) : '')
      + '<span style="flex:1"></span>'
      + '<button class="cp-btn" onclick="location.hash=\'#/candidate/walkins?id=' + encodeURIComponent(d.id) + '\'">Details</button>'
      + (active ? '' : open && !full
        ? '<button class="cp-btn pri" ' + (C.busy ? 'disabled' : '') + ' onclick="tlwkRegister(\'' + js(d.id) + '\')">Register</button>'
        : full ? '<button class="cp-btn" disabled>Full</button>' : '')
      + '</div></div>';
  }

  function filtersHtml() {
    var opt = function (v, label, sel) { return '<option value="' + h(v) + '"' + (sel ? ' selected' : '') + '>' + h(label) + '</option>'; };
    return '<div class="wk-filters">'
      + '<div class="wk-f"><label for="wkCity">City</label><select id="wkCity" onchange="tlwkFilter(\'city\',this.value)">'
      + opt('', 'All cities', !C.f.city) + C.cities.map(function (c) { return opt(c, c, C.f.city === c); }).join('')
      + (C.f.city && C.cities.indexOf(C.f.city) < 0 ? opt(C.f.city, C.f.city, true) : '')
      + '</select></div>'
      + '<div class="wk-f"><label for="wkRole">Role</label><input id="wkRole" placeholder="e.g. Sales, Nurse" value="' + h(C.f.role) + '" onchange="tlwkFilter(\'role\',this.value)"></div>'
      + '<div class="wk-f"><label for="wkDate">Date</label><input id="wkDate" type="date" value="' + h(C.f.date) + '" onchange="tlwkFilter(\'date\',this.value)"></div>'
      + '<div class="wk-f grow"><label for="wkQ">Keyword</label><input id="wkQ" placeholder="Search drives, venues, skills" value="' + h(C.f.q) + '" onkeydown="if(event.key===\'Enter\')tlwkFilter(\'q\',this.value)" onchange="tlwkFilter(\'q\',this.value)"></div>'
      + ((C.f.city || C.f.role || C.f.date || C.f.q) ? '<button class="cp-btn" onclick="tlwkClear()">Clear</button>' : '')
      + '</div>';
  }

  function tabs(on) {
    var n = C.mine ? C.mine.upcoming.length : null;
    return '<div class="wk-tabs" role="tablist">'
      + '<button role="tab" class="' + (on === 'drives' ? 'on' : '') + '" onclick="location.hash=\'#/candidate/walkins\'">Drives</button>'
      + '<button role="tab" class="' + (on === 'mine' ? 'on' : '') + '" onclick="location.hash=\'#/candidate/walkins?tab=mine\'">My Registrations' + (n ? ' <span class="wk-count">' + n + '</span>' : '') + '</button>'
      + '</div>';
  }

  function header(sub) {
    return '<div class="wk-h"><div><h1>🚶 Walk-in Drives</h1><p>' + sub + '</p></div></div>';
  }

  function pageList() {
    loadDrives(false);
    loadMine(false);
    var body;
    if (!C.list) body = '<div class="cp-card cp-empty"><p>Loading drives…</p></div>';
    else if (!C.list.length) {
      body = '<div class="cp-card cp-empty"><div style="font-size:30px">📍</div>'
        + '<h3>' + (C.f.city ? 'No upcoming drives in ' + h(C.f.city) : 'No upcoming drives' + (C.f.role || C.f.date || C.f.q ? ' match these filters' : ' in your city')) + '</h3>'
        + '<p>New walk-in drives appear here as soon as recruiters announce them.</p>'
        + ((C.f.city || C.f.role || C.f.date || C.f.q) ? '<button class="cp-btn pri" onclick="tlwkClear()">Show all drives</button>' : '')
        + '</div>';
    } else body = '<div class="wk-list">' + C.list.map(card).join('') + '</div>';
    return header('Walk in, meet the recruiter, get interviewed the same day. Register so they expect you.')
      + tabs('drives') + filtersHtml()
      + (C.err ? '<div class="wk-err">' + h(C.err) + '</div>' : '')
      + body;
  }

  function pageMine() {
    loadMine(false);
    var m = C.mine;
    var sec = function (title, list, empty) {
      return '<h2 class="wk-h2">' + title + '</h2>'
        + (list.length ? '<div class="wk-list">' + list.map(card).join('') + '</div>'
          : '<div class="cp-card cp-empty" style="padding:18px"><p>' + empty + '</p></div>');
    };
    return header('The drives you registered for.') + tabs('mine')
      + (!m ? '<div class="cp-card cp-empty"><p>Loading…</p></div>'
        : (m.error ? '<div class="wk-err">' + h(m.error) + '</div>' : '')
          + sec('Upcoming', m.upcoming || [], 'You have not registered for an upcoming drive. <a onclick="location.hash=\'#/candidate/walkins\'">Browse drives</a>')
          + sec('Past and cancelled', m.past || [], 'Nothing here yet.'));
  }

  function pageDetail(id, done) {
    loadDetail(id, false);
    var st = C.detail[id] || {};
    if (st.loading) return '<div class="cp-card cp-empty"><p>Loading…</p></div>';
    if (st.error || !st.drive) {
      return '<div class="cp-card cp-empty"><div style="font-size:30px">🔎</div><h3>Drive not available</h3><p>'
        + h(st.error || 'This drive could not be found.') + '</p><button class="cp-btn pri" onclick="location.hash=\'#/candidate/walkins\'">See all drives</button></div>';
    }
    var d = st.drive;
    var reg = d.myRegistration;
    var active = reg && reg.status === 'REGISTERED';
    var open = d.status === 'UPCOMING' || d.status === 'ONGOING';
    var full = d.maxSeats != null && d.seatsLeft <= 0;
    var conf = done && active
      ? '<div class="wk-confirm" role="status"><div style="font-size:28px">✅</div><div><h2>You are registered!</h2>'
        + '<p>We have sent the venue, time and the documents to carry to you. You will get a reminder the day before and on the morning of the drive.</p>'
        + '<div class="wk-actions"><a class="cp-btn pri" href="' + icsUrl(d) + '" download>📅 Add to Calendar</a>'
        + '<button class="cp-btn" onclick="location.hash=\'#/candidate/walkins?tab=mine\'">My Registrations</button></div></div></div>'
      : '';
    var docs = d.documentsToCarry || [];
    var action;
    if (active) {
      action = '<a class="cp-btn" href="' + icsUrl(d) + '" download>📅 Add to Calendar</a>'
        + (d.status === 'UPCOMING' || d.status === 'ONGOING' ? '<button class="cp-btn" ' + (C.busy ? 'disabled' : '') + ' onclick="tlwkCancel(\'' + js(d.id) + '\')">Cancel registration</button>' : '');
    } else if (reg && reg.status !== 'CANCELLED') {
      action = '';                     // attended, or marked absent: done
    } else if (open && !full) {
      action = '<button class="cp-btn pri" ' + (C.busy ? 'disabled' : '') + ' onclick="tlwkRegister(\'' + js(d.id) + '\')">Register for this drive</button>';
    } else if (open && full) {
      action = '<button class="cp-btn" disabled>All seats are taken</button>';
    } else action = '';
    return '<div class="wk-back"><a onclick="history.length>1?history.back():(location.hash=\'#/candidate/walkins\')">← Back to drives</a></div>'
      + conf
      + '<div class="wk-detail">'
      + '<div class="cp-card">'
      + '<div class="wk-top"><div style="min-width:0;flex:1"><h1 class="wk-title">' + h(d.title) + '</h1>'
      + '<div class="wk-sub">' + (d.companyName ? h(d.companyName) + ' · ' : '') + h(d.jobRole) + '</div></div>'
      + '<div class="wk-badges">' + daysBadge(d) + matchBadge(d.match) + regBadge(reg) + '</div></div>'
      + (d.status === 'CANCELLED' ? '<div class="wk-err">This drive has been cancelled' + (d.cancelReason ? ': ' + h(d.cancelReason) : '') + '. Please do not go to the venue.</div>' : '')
      + '<div class="wk-grid">'
      + item('📅 Date', d.dateLabel) + item('🕒 Time', d.timeLabel)
      + item('💰 Salary', d.salaryRange) + item('💼 Experience', d.experienceRequired)
      + item('🎓 Qualification', d.qualification) + item('🪑 Seats', seatsText(d) || 'Open to all')
      + '</div>'
      + (d.description ? '<h3 class="wk-h3">About this drive</h3><p class="wk-p">' + h(d.description).replace(/\n/g, '<br>') + '</p>' : '')
      + (d.skills && d.skills.length ? '<h3 class="wk-h3">Skills</h3><div>' + d.skills.map(function (s) { return '<span class="wk-chip">' + h(s) + '</span>'; }).join('') + '</div>' : '')
      + '<div class="wk-actions">' + action + '</div>'
      + '</div>'
      + '<div class="wk-side">'
      + '<div class="cp-card"><h3 class="wk-h3" style="margin-top:0">📍 Venue</h3>'
      + '<p class="wk-p"><b>' + h(d.venueName) + '</b><br>' + h(d.fullAddress) + '<br>' + h(d.city) + '</p>'
      + '<a class="cp-btn" href="' + h(mapsUrl(d)) + '" target="_blank" rel="noopener noreferrer">Open in Google Maps</a></div>'
      + '<div class="cp-card"><h3 class="wk-h3" style="margin-top:0">📄 Documents to carry</h3>'
      + (docs.length ? '<ul class="wk-docs">' + docs.map(function (x) { return '<li>' + h(x) + '</li>'; }).join('') + '</ul>' : '<p class="wk-p">No documents listed - carry your resume.</p>')
      + '</div>'
      + ((d.contactPersonName || d.contactPhone) ? '<div class="cp-card"><h3 class="wk-h3" style="margin-top:0">☎️ Contact</h3><p class="wk-p">'
        + h(d.contactPersonName || '') + (d.contactPhone ? '<br><a href="tel:' + h(d.contactPhone.replace(/[^0-9+]/g, '')) + '">' + h(d.contactPhone) + '</a>' : '') + '</p></div>' : '')
      + '</div></div>';
  }
  function item(k, v) { return v ? '<div class="wk-item"><div class="k">' + k + '</div><div class="v">' + h(v) + '</div></div>' : ''; }

  window.tlwkFilter = function (k, v) {
    C.f[k] = String(v || '').trim(); C.cityTouched = true; C.list = null; loadDrives(true); rerender();
  };
  window.tlwkClear = function () { C.f = { city: '', role: '', date: '', q: '' }; C.cityTouched = true; C.list = null; loadDrives(true); rerender(); };

  window.tlwkRegister = function (id) {
    if (C.busy || !api()) return;
    C.busy = true; rerender();
    api().post('/walkin-drives/' + encodeURIComponent(id) + '/register', {}).then(function (out) {
      C.busy = false;
      C.detail[id] = { drive: out.drive };
      C.list = null; C.mine = null; loadDrives(true); loadMine(true);
      go('#/candidate/walkins?id=' + encodeURIComponent(id) + '&done=1');
    }).catch(function (err) {
      C.busy = false; say(errText(err), '⚠️');
      C.detail[id] = null; C.list = null; loadDetail(id, true); loadDrives(true); rerender();
    });
  };

  window.tlwkCancel = function (id) {
    if (C.busy || !api()) return;
    if (typeof window.confirm === 'function' && !window.confirm('Cancel your registration for this drive?')) return;
    C.busy = true; rerender();
    api().del('/walkin-drives/' + encodeURIComponent(id) + '/register').then(function () {
      C.busy = false; say('Your registration is cancelled', '✓');
      C.list = null; C.mine = null; loadDrives(true); loadMine(true); loadDetail(id, true);
      if (/done=1/.test(location.hash)) go('#/candidate/walkins?id=' + encodeURIComponent(id));
    }).catch(function (err) { C.busy = false; say(errText(err), '⚠️'); rerender(); });
  };

  function candidatePage() {
    var p = params();
    var html = p.id ? pageDetail(p.id, p.done === '1') : p.tab === 'mine' ? pageMine() : pageList();
    return '<div class="wk-wrap">' + html + '</div>';
  }

  /* ================================================================== *
   * RECRUITER
   * ================================================================== */

  function loadRecruiter(force) {
    if (!api() || R.loading || (R.list && !force)) return;
    R.loading = true;
    api().get('/recruiter/walkin-drives').then(function (out) {
      R.list = out.drives || []; R.jobs = out.jobs || []; R.companies = out.companies || []; R.loading = false; rerender();
    }).catch(function (err) { R.loading = false; R.list = []; R.err = errText(err); rerender(); });
  }

  function loadRegs(id, force) {
    if (!api() || (R.regs[id] && !force)) return;
    R.regs[id] = R.regs[id] || { loading: true };
    var q = [];
    if (R.q) q.push('q=' + encodeURIComponent(R.q));
    if (R.status) q.push('status=' + encodeURIComponent(R.status));
    api().get('/recruiter/walkin-drives/' + encodeURIComponent(id) + '/registrations' + (q.length ? '?' + q.join('&') : ''))
      .then(function (out) { R.regs[id] = out; rerender(); })
      .catch(function (err) { R.regs[id] = { error: errText(err) }; rerender(); });
  }

  var STATUS_LABEL = { UPCOMING: 'Upcoming', ONGOING: 'Happening now', COMPLETED: 'Completed', CANCELLED: 'Cancelled' };
  var REG_LABEL = { REGISTERED: 'Registered', ATTENDED: 'Attended', NO_SHOW: 'No-show', CANCELLED: 'Cancelled by candidate' };

  function blankForm() {
    var d = new Date(Date.now() + 330 * 60000 + 2 * 86400000).toISOString().slice(0, 10);
    return { title: '', companyId: '', jobId: '', jobRole: '', description: '', driveDate: d, startTime: '10:00', endTime: '16:00',
             venueName: '', fullAddress: '', city: '', mapLink: '', salaryRange: '', experienceRequired: '', qualification: '',
             skills: '', documentsToCarry: 'Resume, ID proof (Aadhaar / PAN), Passport-size photo', contactPersonName: '', contactPhone: '', maxSeats: '' };
  }

  function field(k, label, opts) {
    opts = opts || {};
    var v = R.form[k] == null ? '' : R.form[k];
    var err = R.errors[k] ? '<div class="wk-ferr">' + h(R.errors[k]) + '</div>' : '';
    var id = 'wkF_' + k;
    var input = opts.textarea
      ? '<textarea id="' + id + '" rows="3" maxlength="' + (opts.max || 5000) + '">' + h(v) + '</textarea>'
      : opts.select
        ? '<select id="' + id + '">' + opts.select.map(function (o) { return '<option value="' + h(o[0]) + '"' + (String(v) === String(o[0]) ? ' selected' : '') + '>' + h(o[1]) + '</option>'; }).join('') + '</select>'
        : '<input id="' + id + '" type="' + (opts.type || 'text') + '" value="' + h(v) + '"' + (opts.placeholder ? ' placeholder="' + h(opts.placeholder) + '"' : '') + (opts.max ? ' maxlength="' + opts.max + '"' : '') + (opts.min != null ? ' min="' + opts.min + '"' : '') + '>';
    return '<div class="fgroup wk-fg' + (opts.wide ? ' wide' : '') + (R.errors[k] ? ' bad' : '') + '"><label for="' + id + '">' + label + (opts.req ? ' *' : '') + '</label>' + input + err + '</div>';
  }

  function formHtml() {
    var f = R.form;
    var editing = !!f.id;
    var jobs = [['', '— Not linked to a job posting —']].concat(R.jobs.map(function (j) { return [j.id, (j.walkin ? '🚶 ' : '') + j.title]; }));
    var cos = [['', '— None —']].concat(R.companies.map(function (c) { return [c.id, c.name]; }));
    return '<div class="panel" id="wkForm"><div class="panel-head"><h2>' + (editing ? 'Edit drive' : 'Create a walk-in drive') + '</h2>'
      + '<button class="btn btn-ghost btn-sm" onclick="tlwkrClose()">Close</button></div><div class="panel-body">'
      + (R.errors.form ? '<div class="wk-err">' + h(R.errors.form) + '</div>' : '')
      + (editing ? '<div class="req-note" style="margin-bottom:12px">Changing the date, time, venue, documents or contact tells every registered candidate.</div>' : '')
      + '<div class="wk-fgrid">'
      + (editing ? '' : field('jobId', 'Walk-in job posting (optional - fills in what you leave blank)', { select: jobs, wide: true }))
      + field('title', 'Drive title', { req: true, max: 120, placeholder: 'e.g. Customer Support Mega Walk-in', wide: true })
      + field('jobRole', 'Job role', { req: true, max: 120, placeholder: 'e.g. Customer Support Executive' })
      + field('companyId', 'Company', { select: cos })
      + field('driveDate', 'Date', { req: true, type: 'date' })
      + field('startTime', 'Start time', { req: true, type: 'time' })
      + field('endTime', 'End time', { req: true, type: 'time' })
      + field('maxSeats', 'Max seats (optional)', { type: 'number', min: 1, placeholder: 'No limit' })
      + field('venueName', 'Venue name', { req: true, max: 160 })
      + field('city', 'City', { req: true, max: 80 })
      + field('fullAddress', 'Full address', { req: true, max: 500, wide: true })
      + field('mapLink', 'Google Maps link (https://…)', { max: 500, wide: true })
      + field('salaryRange', 'Salary range', { max: 80, placeholder: 'e.g. ₹2–3 LPA' })
      + field('experienceRequired', 'Experience required', { max: 80, placeholder: 'e.g. 0–2 yrs' })
      + field('qualification', 'Qualification', { max: 160, placeholder: 'e.g. Any degree' })
      + field('skills', 'Skills (comma separated)', { max: 600 })
      + field('documentsToCarry', 'Documents to carry (comma separated)', { max: 1200, wide: true })
      + field('contactPersonName', 'Contact person', { max: 80 })
      + field('contactPhone', 'Contact phone', { max: 20 })
      + field('description', 'Description', { textarea: true, wide: true })
      + '</div>'
      + '<div style="display:flex;gap:8px;margin-top:6px"><button class="btn btn-primary" ' + (R.busy ? 'disabled' : '') + ' onclick="tlwkrSave()">' + (editing ? 'Save changes' : 'Create drive') + '</button>'
      + '<button class="btn btn-ghost" onclick="tlwkrClose()">Cancel</button></div>'
      + '</div></div>';
  }

  function readForm() {
    var f = {};
    Object.keys(R.form).forEach(function (k) {
      var el = document.getElementById('wkF_' + k);
      f[k] = el ? el.value : R.form[k];
    });
    f.id = R.form.id;
    return f;
  }
  var splitList = function (s) { return String(s || '').split(/[,\n]/).map(function (x) { return x.trim(); }).filter(Boolean); };

  window.tlwkrNew = function () { R.form = blankForm(); R.errors = {}; rerender(); setTimeout(function () { var e = document.getElementById('wkForm'); if (e) e.scrollIntoView({ block: 'start' }); }, 30); };
  window.tlwkrEdit = function (id) {
    var d = (R.list || []).filter(function (x) { return x.id === id; })[0];
    if (!d) return;
    R.form = { id: d.id, title: d.title, companyId: d.companyId || '', jobId: d.jobId || '', jobRole: d.jobRole, description: d.description,
      driveDate: d.driveDate, startTime: d.startTime, endTime: d.endTime, venueName: d.venueName, fullAddress: d.fullAddress, city: d.city,
      mapLink: d.mapLink || '', salaryRange: d.salaryRange, experienceRequired: d.experienceRequired, qualification: d.qualification,
      skills: (d.skills || []).join(', '), documentsToCarry: (d.documentsToCarry || []).join(', '), contactPersonName: d.contactPersonName,
      contactPhone: d.contactPhone, maxSeats: d.maxSeats == null ? '' : String(d.maxSeats) };
    R.errors = {};
    go('#/recruiter/walkins');
    rerender();
    setTimeout(function () { var e = document.getElementById('wkForm'); if (e) e.scrollIntoView({ block: 'start' }); }, 30);
  };
  window.tlwkrClose = function () { R.form = null; R.errors = {}; rerender(); };

  window.tlwkrSave = function () {
    if (R.busy) return;
    var f = readForm();
    R.form = f;
    var body = {
      title: f.title.trim(), jobRole: f.jobRole.trim(), companyId: f.companyId || null, jobId: f.jobId || null,
      description: f.description.trim() || null, driveDate: f.driveDate, startTime: f.startTime, endTime: f.endTime,
      venueName: f.venueName.trim(), fullAddress: f.fullAddress.trim(), city: f.city.trim(), mapLink: f.mapLink.trim() || null,
      salaryRange: f.salaryRange.trim() || null, experienceRequired: f.experienceRequired.trim() || null,
      qualification: f.qualification.trim() || null, skills: splitList(f.skills), documentsToCarry: splitList(f.documentsToCarry),
      contactPersonName: f.contactPersonName.trim() || null, contactPhone: f.contactPhone.trim() || null,
      maxSeats: f.maxSeats === '' || f.maxSeats == null ? null : Number(f.maxSeats),
    };
    if (!f.id && body.jobId) {
      // a linked posting fills in what was left blank, on the server
      ['title', 'jobRole'].forEach(function (k) { if (!body[k]) delete body[k]; });
    }
    R.busy = true; R.errors = {}; rerender();
    var req = f.id ? api().put('/recruiter/walkin-drives/' + encodeURIComponent(f.id), body) : api().post('/recruiter/walkin-drives', body);
    req.then(function (out) {
      R.busy = false; R.form = null;
      say(f.id ? (out.notified ? 'Drive updated - registered candidates are being told' : 'Drive updated') : 'Walk-in drive created', '✓');
      loadRecruiter(true);
    }).catch(function (err) {
      R.busy = false;
      R.errors = {};
      var d = err && err.details;
      if (d && typeof d === 'object') Object.keys(d).forEach(function (k) { R.errors[k] = d[k]; });
      R.errors.form = errText(err);
      rerender();
    });
  };

  window.tlwkrCancelDrive = function (id) {
    var d = (R.list || []).filter(function (x) { return x.id === id; })[0];
    if (!d) return;
    var reason = typeof window.prompt === 'function'
      ? window.prompt('Cancel "' + d.title + '"? Everyone registered will be told. Reason (optional):', '') : '';
    if (reason === null) return;
    api().del('/recruiter/walkin-drives/' + encodeURIComponent(id) + (reason ? '?reason=' + encodeURIComponent(reason.slice(0, 500)) : ''))
      .then(function () { say('Drive cancelled - registered candidates are being told', '✓'); loadRecruiter(true); })
      .catch(function (err) { say(errText(err), '⚠️'); });
  };

  function recruiterList() {
    loadRecruiter(false);
    var rows = R.list;
    var table = !rows ? '<div class="empty-note">Loading…</div>'
      : !rows.length ? '<div class="empty-note">No walk-in drives yet. Create one to start taking registrations.</div>'
        : '<div class="wk-tblwrap"><table class="data wk-table"><thead><tr><th>Drive</th><th>When</th><th>Where</th><th>Status</th><th>Registered</th><th>Attended</th><th></th></tr></thead><tbody>'
          + rows.map(function (d) {
            var n = d.counts || {};
            var live = d.status === 'UPCOMING' || d.status === 'ONGOING';
            return '<tr><td><b>' + h(d.title) + '</b><div class="wk-dim">' + h(d.jobRole) + (d.companyName ? ' · ' + h(d.companyName) : '') + '</div></td>'
              + '<td>' + h(d.dateLabel) + '<div class="wk-dim">' + h(d.timeLabel) + '</div></td>'
              + '<td>' + h(d.venueName) + '<div class="wk-dim">' + h(d.city) + '</div></td>'
              + '<td><span class="wk-st ' + d.status.toLowerCase() + '">' + h(STATUS_LABEL[d.status] || d.status) + '</span></td>'
              + '<td>' + (n.REGISTERED || 0) + (d.maxSeats != null ? ' / ' + d.maxSeats : '') + '</td>'
              + '<td>' + (n.ATTENDED || 0) + '</td>'
              + '<td class="wk-act"><button class="btn btn-sm" onclick="location.hash=\'#/recruiter/walkins?id=' + encodeURIComponent(d.id) + '\'">Registrations</button>'
              + (live ? '<button class="btn btn-ghost btn-sm" onclick="tlwkrEdit(\'' + js(d.id) + '\')">Edit</button>'
                + '<button class="btn btn-ghost btn-sm" onclick="tlwkrCancelDrive(\'' + js(d.id) + '\')">Cancel</button>' : '')
              + '</td></tr>';
          }).join('') + '</tbody></table></div>';
    return (R.form ? formHtml() : '')
      + '<div class="panel"><div class="panel-head"><div><h2>Your walk-in drives</h2><div class="desc">Candidates register from the portal; you see who is coming, mark attendance on the day and export the list.</div></div>'
      + (R.form ? '' : '<button class="btn btn-primary btn-sm" onclick="tlwkrNew()">+ Create drive</button>') + '</div>'
      + '<div class="panel-body pad0">' + (R.err ? '<div class="wk-err">' + h(R.err) + '</div>' : '') + table + '</div></div>';
  }

  window.tlwkrSearch = function (id) {
    var q = document.getElementById('wkrQ'); var s = document.getElementById('wkrS');
    R.q = q ? q.value.trim() : ''; R.status = s ? s.value : '';
    loadRegs(id, true);
  };
  window.tlwkrMark = function (driveId, regId, status) {
    api().patch('/recruiter/walkin-drives/' + encodeURIComponent(driveId) + '/registrations/' + encodeURIComponent(regId), { status: status })
      .then(function () { loadRegs(driveId, true); R.list = null; })
      .catch(function (err) { say(errText(err), '⚠️'); });
  };
  window.tlwkrExport = function (driveId, format) {
    var q = ['format=' + format];
    if (R.q) q.push('q=' + encodeURIComponent(R.q));
    if (R.status) q.push('status=' + encodeURIComponent(R.status));
    var a = document.createElement('a');
    a.href = '/api/recruiter/walkin-drives/' + encodeURIComponent(driveId) + '/registrations/export?' + q.join('&');
    a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
  };

  function recruiterRegs(id) {
    loadRegs(id, false);
    var st = R.regs[id] || {};
    var back = '<div class="wk-back"><a onclick="location.hash=\'#/recruiter/walkins\'">← All drives</a></div>';
    if (st.loading) return back + '<div class="empty-note">Loading…</div>';
    if (st.error) return back + '<div class="wk-err">' + h(st.error) + '</div>';
    var d = st.drive; var t = st.totals || {};
    var canMark = d.status === 'ONGOING' || d.status === 'COMPLETED';
    var regs = st.registrations || [];
    var opt = function (v, l) { return '<option value="' + v + '"' + (R.status === v ? ' selected' : '') + '>' + l + '</option>'; };
    return back
      + '<div class="panel"><div class="panel-head"><div><h2>' + h(d.title) + '</h2><div class="desc">' + h(d.dateLabel) + ' · ' + h(d.timeLabel) + ' · ' + h(d.venueName) + ', ' + h(d.city)
      + ' · <span class="wk-st ' + d.status.toLowerCase() + '">' + h(STATUS_LABEL[d.status] || d.status) + '</span></div></div>'
      + '<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-sm" onclick="tlwkrExport(\'' + js(id) + '\',\'csv\')">Export CSV</button>'
      + '<button class="btn btn-sm" onclick="tlwkrExport(\'' + js(id) + '\',\'xlsx\')">Export Excel</button></div></div>'
      + '<div class="panel-body">'
      + '<div class="wk-totals">' + ['REGISTERED', 'ATTENDED', 'NO_SHOW', 'CANCELLED'].map(function (k) {
        return '<div><b>' + (t[k] || 0) + '</b><span>' + REG_LABEL[k] + '</span></div>'; }).join('') + '</div>'
      + '<div class="wk-filters" style="margin-top:12px">'
      + '<div class="wk-f grow"><label for="wkrQ">Search</label><input id="wkrQ" placeholder="Name, phone, email, skill" value="' + h(R.q) + '" onkeydown="if(event.key===\'Enter\')tlwkrSearch(\'' + js(id) + '\')"></div>'
      + '<div class="wk-f"><label for="wkrS">Status</label><select id="wkrS" onchange="tlwkrSearch(\'' + js(id) + '\')">' + opt('', 'All') + opt('REGISTERED', 'Registered') + opt('ATTENDED', 'Attended') + opt('NO_SHOW', 'No-show') + opt('CANCELLED', 'Cancelled') + '</select></div>'
      + '<button class="btn btn-sm" style="align-self:flex-end" onclick="tlwkrSearch(\'' + js(id) + '\')">Search</button></div>'
      + (canMark ? '' : '<div class="req-note" style="margin-top:10px">Attendance can be marked once the drive starts.</div>')
      + '</div>'
      + '<div class="panel-body pad0"><div class="wk-tblwrap"><table class="data wk-table"><thead><tr><th>Candidate</th><th>Contact</th><th>Profile</th><th>Status</th><th>Registered</th><th>Attendance</th></tr></thead><tbody>'
      + (regs.length ? regs.map(function (x) {
        var live = x.status !== 'CANCELLED';
        return '<tr><td><b>' + h(x.name) + '</b><div class="wk-dim">' + h(x.location) + '</div></td>'
          + '<td>' + h(x.phone) + '<div class="wk-dim">' + h(x.email) + '</div></td>'
          + '<td>' + h(x.title || '') + '<div class="wk-dim">' + h((x.skills || []).slice(0, 4).join(', ')) + (x.hasResume ? ' · 📄 resume' : '') + '</div></td>'
          + '<td><span class="wk-rs ' + x.status.toLowerCase() + '">' + h(REG_LABEL[x.status] || x.status) + '</span></td>'
          + '<td>' + h(x.registeredAt ? new Date(x.registeredAt).toLocaleString() : '') + '</td>'
          + '<td class="wk-act">' + (live && canMark
            ? (x.status !== 'ATTENDED' ? '<button class="btn btn-sm" onclick="tlwkrMark(\'' + js(id) + '\',\'' + js(x.id) + '\',\'ATTENDED\')">Attended</button>' : '')
              + (x.status !== 'NO_SHOW' ? '<button class="btn btn-ghost btn-sm" onclick="tlwkrMark(\'' + js(id) + '\',\'' + js(x.id) + '\',\'NO_SHOW\')">No-show</button>' : '')
              + (x.status !== 'REGISTERED' ? '<button class="btn btn-ghost btn-sm" onclick="tlwkrMark(\'' + js(id) + '\',\'' + js(x.id) + '\',\'REGISTERED\')">Undo</button>' : '')
            : '—') + '</td></tr>';
      }).join('') : '<tr><td class="empty-note" colspan="6">' + (R.q || R.status ? 'No registrations match.' : 'No registrations yet.') + '</td></tr>')
      + '</tbody></table></div></div></div>';
  }

  function recruiterPage() {
    var p = params();
    return p.id ? recruiterRegs(p.id) : recruiterList();
  }

  /* ================================================================== *
   * wiring
   * ================================================================== */

  function wrapCandidate() {
    var prev = window.pageCandidateDash;
    if (typeof prev !== 'function' || prev.__tlwk) return;
    var next = function (section) {
      if (section === 'walkins' && role() === 'candidate') {
        var html = candidatePage();
        return typeof window.cpShell === 'function' ? cpShell('walkins', html) : html;
      }
      return prev.apply(this, arguments);
    };
    next.__tlwk = true;
    window.pageCandidateDash = next;
  }

  function wrapShell() {
    var prev = window.cpShell;
    if (typeof prev !== 'function' || prev.__tlwk) return;
    var next = function (section) {
      var html = prev.apply(this, arguments);
      if (typeof html !== 'string') return html;
      var link = '<a class="' + (section === 'walkins' ? 'on' : '') + '" onclick="location.hash=\'#/candidate/walkins\'">Walk-in Drives</a>';
      html = html.replace(/(<nav class="cp-nav">[\s\S]*?)(<\/nav>)/, function (_m, a, b) { return a + link + b; });
      html = html.replace('<div class="cp-mscroll">', '<div class="cp-mscroll"><button onclick="location.hash=\'#/candidate/walkins\';cpOpen(\'\')">🚶 Walk-in Drives</button>');
      return html;
    };
    next.__tlwk = true;
    window.cpShell = next;
  }

  function wrapDrawer() {
    var prev = window.nkDrawerHtml;
    if (typeof prev !== 'function' || prev.__tlwk) return;
    var next = function () {
      var html = prev.apply(this, arguments);
      if (typeof html !== 'string' || html.indexOf('#/candidate/walkins') >= 0) return html;
      var row = '<button class="nk-row ' + (/^#\/candidate\/walkins/.test(location.hash) ? 'on' : '') + '" onclick="nkGo(\'#/candidate/walkins\')"><span class="ic">🚶</span>Walk-in Drives</button>';
      var at = html.indexOf('<div style="height:1px;background:#eef1f6;margin:8px 14px"></div>');
      if (at < 0) at = html.indexOf('</nav>');
      return at < 0 ? html : html.slice(0, at) + row + html.slice(at);
    };
    next.__tlwk = true;
    window.nkDrawerHtml = next;
  }

  function wrapRecruiter() {
    try {
      if (typeof NAV_CONFIG === 'object' && Array.isArray(NAV_CONFIG.recruiter)
          && !NAV_CONFIG.recruiter.some(function (x) { return x && x[0] === 'walkins'; })) {
        NAV_CONFIG.recruiter.push(['walkins', 'Walk-in Drives', '🚶']);
      }
    } catch (e) { /* the nav is cosmetic */ }
    var prev = window.pageRecruiterDash;
    if (typeof prev !== 'function' || prev.__tlwk) return;
    var next = function (section) {
      if (section === 'walkins' && role() === 'recruiter') {
        var who = '';
        try { var r = DATA.recruiterById ? DATA.recruiterById(STATE.session.id) : null; who = r ? 'Recruiter · ' + h(r.name) : 'Recruiter'; } catch (e) { who = 'Recruiter'; }
        return dashShell('recruiter', 'walkins', 'Walk-in Drives', who, '<div class="wk-wrap wk-rec">' + recruiterPage() + '</div>');
      }
      return prev.apply(this, arguments);
    };
    next.__tlwk = true;
    window.pageRecruiterDash = next;
  }

  /* Walk-in messages in the candidate's bell open the drive. */
  function wrapBell() {
    var prev = window.cpNotifications;
    if (typeof prev !== 'function' || prev.__tlwk) return;
    var next = function () {
      var out = prev.apply(this, arguments) || [];
      try {
        var have = {}; out.forEach(function (r) { have[r.id] = 1; });
        var READ = 'teamlink_cand_notif_read_v1';
        var read = []; try { read = JSON.parse(localStorage.getItem(READ)) || []; } catch (e) { read = []; }
        ((window.TL && TL.notifications) || []).forEach(function (n) {
          if (!n || !/^WALKIN_/.test(n.type || '') || have[n.id]) return;
          var drive = n.metadata && n.metadata.driveId;
          out.push({ id: n.id, text: (n.title ? n.title + ' · ' : '') + (n.message || ''), ts: n.createdAt,
                     read: !!n.read || read.indexOf(n.id) >= 0, go: drive ? '#/candidate/walkins?id=' + encodeURIComponent(drive) : '#/candidate/walkins?tab=mine' });
        });
        out.sort(function (x, y) { return (Date.parse(y.ts || 0) || 0) - (Date.parse(x.ts || 0) || 0); });
      } catch (e) { /* never break the bell */ }
      return out.slice(0, 25);
    };
    next.__tlwk = true;
    window.cpNotifications = next;
  }

  /* Arriving on a walk-in page asks the server again. */
  var lastHash = null; var lastWho = null;
  function onRender() {
    var who = window.STATE && STATE.session ? STATE.session.role + ':' + STATE.session.id : null;
    if (who !== lastWho) {
      lastWho = who;
      C.list = null; C.mine = null; C.detail = {}; C.cityTouched = false; C.f = { city: '', role: '', date: '', q: '' };
      R.list = null; R.regs = {}; R.form = null;
    }
    var hash = location.hash || '';
    if (hash !== lastHash) {
      var was = lastHash; lastHash = hash;
      if (/^#\/candidate\/walkins/.test(hash) && was !== null && !/^#\/candidate\/walkins/.test(was)) {
        C.at = 0; C.mine = null; loadDrives(true); loadMine(true);
      }
      var m = /^#\/candidate\/walkins\?(?:.*&)?id=([^&]+)/.exec(hash);
      if (m && was !== null) loadDetail(decodeURIComponent(m[1]), true);
      var r = /^#\/recruiter\/walkins\?(?:.*&)?id=([^&]+)/.exec(hash);
      if (r) loadRegs(decodeURIComponent(r[1]), true);
      else if (/^#\/recruiter\/walkins/.test(hash) && was !== null) loadRecruiter(true);
    }
  }

  function addStyle() {
    if (document.getElementById('wkStyle')) return;
    var s = document.createElement('style');
    s.id = 'wkStyle';
    s.textContent = [
      '.wk-wrap{max-width:1100px}',
      '.wk-h{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px}',
      '.wk-h h1{margin:0;font-size:21px;font-weight:800;color:#16202c}.wk-h p{margin:4px 0 0;font-size:12.5px;color:#7b8794}',
      '.wk-tabs{display:flex;gap:6px;border-bottom:1px solid #e6ebf2;margin-bottom:14px;overflow-x:auto}',
      '.wk-tabs button{border:0;background:none;padding:9px 14px;font:inherit;font-size:13px;font-weight:700;color:#7a8595;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}',
      '.wk-tabs button.on{color:#1d6ff2;border-bottom-color:#1d6ff2}',
      '.wk-count{display:inline-block;background:#1d6ff2;color:#fff;border-radius:9px;font-size:10.5px;padding:0 6px;margin-left:4px}',
      '.wk-filters{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}',
      '.wk-f{display:flex;flex-direction:column;gap:4px;min-width:150px}.wk-f.grow{flex:1;min-width:200px}',
      '.wk-f label{font-size:11.5px;font-weight:700;color:#5b6e84}',
      '.wk-f input,.wk-f select{border:1px solid #dde4ec;border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;background:#fff;color:#26313f}',
      '.wk-list{display:flex;flex-direction:column;gap:12px}',
      '.wk-card{background:#fff;border:1px solid #e6ebf2;border-radius:14px;padding:14px 16px;cursor:pointer;box-shadow:0 1px 3px rgba(16,30,54,.04);transition:border-color .15s}',
      '.wk-card:hover{border-color:#bcd3f5}',
      '.wk-top{display:flex;gap:8px 12px;align-items:flex-start;flex-wrap:wrap}.wk-top>div:first-child{flex:1 1 240px !important}',
      '.wk-card h3,.wk-title{margin:0;font-size:16px;font-weight:800;color:#16202c}.wk-title{font-size:20px}',
      '.wk-sub{font-size:12.5px;color:#5b6e84;margin-top:3px}',
      '.wk-badges{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
      '.wk-badge{display:inline-block;font-size:11px;font-weight:800;border-radius:999px;padding:3px 9px;background:#e7f0ff;color:#1b4f9e}',
      '.wk-badge.soon{background:#fff1e6;color:#a4510b}.wk-badge.live{background:#e8f6ee;color:#0f7a44}',
      '.wk-badge.off{background:#eef1f6;color:#5a6a7d}.wk-badge.good{background:#e8f6ee;color:#0f7a44}',
      '.wk-match{display:inline-block;font-size:11px;font-weight:800;border-radius:999px;padding:3px 9px;border:1px solid #dfe5ec;background:#eef1f6;color:#5a6a7d}',
      '.wk-match.hi{background:#e8f6ee;color:#1d7a45;border-color:#bfe3cd}.wk-match.mid{background:#fdf1dc;color:#8a5a12;border-color:#f0d9a8}',
      '.wk-meta{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px;font-size:12.5px;color:#33404f}',
      '.wk-foot{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:11px;border-top:1px solid #f0f3f7;padding-top:10px;cursor:default}',
      '.wk-seats{font-size:11.5px;color:#7b8794;font-weight:700}',
      '.wk-detail{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:14px;align-items:start}',
      '.wk-side{display:flex;flex-direction:column;gap:14px}',
      '.wk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin:14px 0}',
      '.wk-item{background:#f7f9fc;border-radius:10px;padding:9px 11px}.wk-item .k{font-size:11px;color:#7b8794;font-weight:700}.wk-item .v{font-size:13.5px;font-weight:700;color:#16202c;margin-top:2px}',
      '.wk-h2{font-size:15px;font-weight:800;margin:16px 0 10px;color:#16202c}.wk-h3{font-size:14px;font-weight:800;margin:14px 0 6px;color:#16202c}',
      '.wk-p{font-size:13px;color:#33404f;line-height:1.6;margin:0 0 10px}',
      '.wk-docs{margin:0;padding-left:18px;font-size:13px;color:#33404f;line-height:1.8}',
      '.wk-chip{display:inline-block;font-size:11.5px;font-weight:700;color:#42505f;background:#f1f4f8;border-radius:12px;padding:3px 9px;margin:0 6px 6px 0}',
      '.wk-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.wk-actions a.cp-btn{text-decoration:none;display:inline-flex;align-items:center}',
      '.wk-side a.cp-btn{text-decoration:none;display:inline-block}',
      '.wk-confirm{display:flex;gap:14px;align-items:flex-start;background:#e8f6ee;border:1px solid #bfe3cd;border-radius:14px;padding:16px 18px;margin-bottom:14px}',
      '.wk-confirm h2{margin:0 0 4px;font-size:17px;color:#0f5a33}.wk-confirm p{margin:0;font-size:13px;color:#245c3c}',
      '.wk-back{margin-bottom:10px;font-size:13px}.wk-back a{color:#1d6ff2;font-weight:700;cursor:pointer}',
      '.wk-err{background:#fdecec;color:#9b1c1c;border:1px solid #f5c2c2;border-radius:10px;padding:9px 12px;font-size:12.5px;margin:10px 0}',
      '.wk-dim{font-size:11.5px;color:#7b8794;margin-top:2px}',
      '.wk-st,.wk-rs{display:inline-block;font-size:11px;font-weight:800;border-radius:999px;padding:2px 9px;background:#e7f0ff;color:#1b4f9e;white-space:nowrap}',
      '.wk-st.ongoing,.wk-rs.attended{background:#e8f6ee;color:#0f7a44}.wk-st.completed,.wk-st.cancelled,.wk-rs.cancelled{background:#eef1f6;color:#5a6a7d}.wk-rs.no_show{background:#fdecec;color:#9b1c1c}',
      '.wk-tblwrap{overflow-x:auto;-webkit-overflow-scrolling:touch}.wk-table{width:100%}',
      '.wk-act{white-space:nowrap}.wk-act .btn{margin:2px 4px 2px 0}',
      '.wk-totals{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}',
      '.wk-totals div{background:#f7f9fc;border-radius:10px;padding:10px 12px}.wk-totals b{display:block;font-size:20px}.wk-totals span{font-size:11.5px;color:#7b8794;font-weight:700}',
      '.wk-fgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 14px}.wk-fg.wide{grid-column:1/-1}',
      '.wk-fg input,.wk-fg select,.wk-fg textarea{width:100%;box-sizing:border-box}',
      '.wk-fg.bad input,.wk-fg.bad select,.wk-fg.bad textarea{border-color:#d93025}',
      '.wk-ferr{font-size:11.5px;color:#b3261e;margin-top:3px}',
      '@media (max-width:760px){.wk-detail{grid-template-columns:1fr}.wk-fgrid{grid-template-columns:1fr}.wk-totals{grid-template-columns:repeat(2,1fr)}',
      '  .wk-f{min-width:0;flex:1 1 45%}.wk-f.grow{flex-basis:100%}.wk-title{font-size:18px}}',
    ].join('\n');
    document.head.appendChild(s);
  }

  function install() {
    if (window.__tlwkInstalled) return;
    window.__tlwkInstalled = true;
    addStyle();
    wrapCandidate(); wrapShell(); wrapDrawer(); wrapRecruiter(); wrapBell();
    var prev = window.render;
    if (typeof prev === 'function' && !prev.__tlwk) {
      var next = function () {
        var out = prev.apply(this, arguments);
        try { onRender(); } catch (e) { /* never let this break a page */ }
        return out;
      };
      next.__tlwk = true;
      window.render = next;
    }
    /* Draw this page now only if the session is already known: a render
       before that is sent to the login screen. Otherwise the render that
       follows the session finds these wrappers in place. */
    if (window.TL && TL.ready === true && window.STATE && STATE.session
        && /^#\/(candidate|recruiter)\/walkins/.test(location.hash)) rerender();
  }

  if (document.readyState === 'complete') install();
  else window.addEventListener('load', install);

  window.TLWalkins = { reload: function () { C.list = null; C.mine = null; R.list = null; loadDrives(true); loadMine(true); loadRecruiter(true); } };
})();
