/* =====================================================================
   TEAMLINK — shared candidates and "already contacted" (migration 0091)

   Every recruiter now sees every candidate; the pipeline stays with the
   job's recruiter. This file is what a recruiter SEES of that:

   - a badge on every row of the Talent Pool and Find Candidates:
       red     "In process · Medical Coder · Priya"
       orange  "Contacted 5 days ago · Medical Coder · Ravi"
       grey    "Worked before · other roles" (tap for the list)
   - a "TeamLink activity" panel on the candidate profile: who worked
     with them, for which role, how far, who holds them and until when;
     Call / WhatsApp / Log call; "Read-only" when the record is somebody
     else's
   - the warning before a contact ("Ravi contacted this candidate for
     Medical Coder 5 days ago (Interested). Contact anyway?") and the
     block ("Priya is processing this candidate for Medical Coder
     (Interview Scheduled). Hold ends ...") with Message <holder> and
     Request admin override
   - Admin -> Shared candidates: override requests (approve / deny with a
     reason) and conflicts

   THE SERVER DECIDES. Every check here asks /api/engagement/check, and
   the server refuses the action itself (409) whatever this page does -
   these screens only say so earlier and more kindly.

   Exposes window.TLEngagement:
     gate({candidateId, jobId, action, record}) -> Promise<boolean>
     badges(ids, jobId) -> Promise<{id: badge}>   (also carries availability)
     invalidate(candidateId)
   ===================================================================== */
(function () {
  'use strict';
  if (window.TLEngagement) return;

  var api = function () { return window.TL && window.TL.api; };
  var h = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  };
  var js = function (v) { return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); };
  var say = function (m, i) { if (typeof window.toast === 'function') window.toast(m, i || 'ℹ️'); };
  var session = function () { return (window.STATE && window.STATE.session) || null; };
  var isStaff = function () { var s = session(); return !!(s && ['recruiter', 'admin', 'bde'].indexOf(s.role) >= 0); };
  var isRecruiter = function () { var s = session(); return !!(s && s.role === 'recruiter'); };
  var modal = function (html) { if (typeof window.fcrModal === 'function') window.fcrModal(html); };
  var closeModal = function () { if (typeof window.fcrCloseModal === 'function') window.fcrCloseModal(); };

  function roleText(x) {
    if (!x) return 'this role';
    var t = x.jobTitle || x.role || x.roleKey || '';
    return t ? String(t).replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : 'this role';
  }
  function ago(iso) {
    if (!iso) return '';
    var d = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
    return d === 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago';
  }
  function dateText(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch (e) { return String(iso).slice(0, 10); }
  }
  var OUTCOME = { interested: 'Interested', not_interested: 'Not interested', no_answer: 'No answer',
    call_back: 'Call back', wrong_number: 'Wrong number', sent: 'Sent', queued: 'Queued', opened: 'Opened' };
  var CHANNEL = { phone: 'Call', whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', ai_call: 'AI call',
    bulk_message: 'Message', invite: 'Invite' };

  /* ------------------------------------------------------------------ *
   * badges: one request per screenful, cached for a minute
   * ------------------------------------------------------------------ */
  var CACHE = {};
  var TTL = 60000;
  var key = function (id, jobId) { return (jobId || '') + '|' + id; };

  function badges(ids, jobId) {
    var a = api();
    var want = [], out = {};
    (ids || []).forEach(function (id) {
      var c = CACHE[key(id, jobId)];
      if (c && Date.now() - c.at < TTL) out[id] = c.data;
      else if (want.indexOf(id) < 0) want.push(id);
    });
    if (!want.length || !a) return Promise.resolve(out);
    var chunks = [];
    for (var i = 0; i < want.length; i += 200) chunks.push(want.slice(i, i + 200));
    return Promise.all(chunks.map(function (chunk) {
      return a.post('/engagement/badges', { candidateIds: chunk, jobId: jobId || undefined })
        .then(function (r) {
          var b = (r && r.badges) || {};
          chunk.forEach(function (id) {
            CACHE[key(id, jobId)] = { at: Date.now(), data: b[id] || null };
            out[id] = b[id] || null;
          });
        }).catch(function () { /* a badge is a courtesy; the server still enforces */ });
    })).then(function () {
      try { document.dispatchEvent(new CustomEvent('tl:badges', { detail: { jobId: jobId || null, badges: out } })); }
      catch (e) { /* old browser */ }
      return out;
    });
  }

  function invalidate(id) {
    Object.keys(CACHE).forEach(function (k) { if (!id || k.split('|')[1] === id) delete CACHE[k]; });
    if (id) delete PROFILE[id];
    else Object.keys(PROFILE).forEach(function (k) { delete PROFILE[k]; });
  }

  function badgeHtml(id, b) {
    if (!b || !b.kind) return '';
    var who = b.recruiterName ? ' · ' + h(b.recruiterName) : '';
    var role = ' · ' + h(roleText(b));
    if (b.kind === 'joined') {
      return '<span class="tlsc-b tlsc-red" title="Joined through TeamLink - held for every role until '
        + h(dateText(b.holdExpiresAt)) + ' (replacement period)">Placed' + role + who + '</span>';
    }
    if (b.kind === 'in_process') {
      return '<span class="tlsc-b tlsc-red" title="' + h((b.statusLabel || 'In process') + ' - hold ends '
        + dateText(b.holdExpiresAt) + ' if no activity') + '">In process' + role + who + '</span>';
    }
    if (b.kind === 'contacted') {
      return '<span class="tlsc-b tlsc-orange" title="Hold ends ' + h(dateText(b.holdExpiresAt))
        + ' if no activity">Contacted ' + h(ago(b.lastAt)) + role + who + '</span>';
    }
    return '<button type="button" class="tlsc-b tlsc-grey" onclick="event.stopPropagation();TLEngagement.others(\''
      + js(id) + '\', this)">Worked before · other roles</button>';
  }

  /* The grey badge opens the list. */
  var LAST_OTHERS = {};
  function others(id, el) {
    var list = LAST_OTHERS[id] || [];
    var old = document.getElementById('tlscPop');
    if (old) { old.remove(); if (old.getAttribute('data-for') === id) return; }
    var pop = document.createElement('div');
    pop.id = 'tlscPop';
    pop.className = 'tlsc-pop';
    pop.setAttribute('data-for', id);
    pop.innerHTML = '<div class="tlsc-pop-h">Worked with at TeamLink</div>' + (list.length
      ? list.map(function (o) {
        return '<div class="tlsc-pop-r"><b>' + h(roleText(o)) + '</b> · ' + h(o.recruiter || 'A recruiter')
          + ' <span>' + h(ago(o.at)) + (o.level ? ' · ' + h(o.level.replace('_', ' ')) : '') + '</span></div>';
      }).join('') : '<div class="tlsc-pop-r">Nothing recorded.</div>');
    document.body.appendChild(pop);
    var r = el.getBoundingClientRect();
    pop.style.top = (window.scrollY + r.bottom + 6) + 'px';
    pop.style.left = Math.max(8, Math.min(window.scrollX + r.left, window.scrollX + window.innerWidth - 300)) + 'px';
    setTimeout(function () {
      document.addEventListener('click', function close(ev) {
        if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('click', close); }
      });
    }, 0);
  }

  /* ------------------------------------------------------------------ *
   * the lists: Talent Pool rows, Find Candidates cards
   * ------------------------------------------------------------------ */
  function listJob() {
    try {
      if ((location.hash || '').indexOf('#/recruiter/talent-pool') === 0 || (location.hash || '').indexOf('#/recruiter/candidates') === 0) {
        return (window.STATE && STATE.talentPool && STATE.talentPool.jobId) || null;
      }
      var m = /[?&]jobId=([^&]+)/.exec(location.hash || '');
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }

  function rowsOnScreen() {
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll('#tpHost tbody tr'), function (tr) {
      var cb = tr.querySelector('input[type="checkbox"]');
      var m = cb && /tpPick\('([^']+)'/.exec(cb.getAttribute('onchange') || '');
      var cell = tr.querySelector('td.who');
      if (m && cell) out.push({ id: m[1], host: cell });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.fcr-card'), function (card) {
      var cb = card.querySelector('.fcr-card-check input');
      var m = cb && /fcrToggleSelect\('([^']+)'/.exec(cb.getAttribute('onchange') || '');
      var top = card.querySelector('.fcr-card-top');
      if (m && top) out.push({ id: m[1], host: top });
    });
    return out;
  }

  var painting = false;
  function decorateLists() {
    if (!isStaff() || painting) return;
    var rows = rowsOnScreen();
    if (!rows.length) return;
    var jobId = listJob();
    var stamp = jobId || '';
    var todo = rows.filter(function (r) { return r.host.getAttribute('data-tlsc') !== stamp; });
    if (!todo.length) return;
    todo.forEach(function (r) { r.host.setAttribute('data-tlsc', stamp); });
    painting = true;
    badges(todo.map(function (r) { return r.id; }), jobId).then(function (map) {
      todo.forEach(function (r) {
        if (!document.body.contains(r.host)) return;
        var old = r.host.querySelector('.tlsc-slot');
        if (old) old.remove();
        var b = map[r.id];
        if (b && b.others) LAST_OTHERS[r.id] = b.others;
        var html = badgeHtml(r.id, b);
        if (!html) return;
        var span = document.createElement('span');
        span.className = 'tlsc-slot';
        span.innerHTML = html;
        r.host.appendChild(span);
      });
    }).then(function () { painting = false; afterPaint(); }, function () { painting = false; afterPaint(); });
    /* afterPaint() again: rows drawn while this request was out were
       skipped (painting), and nothing else would come back for them. */
  }

  /* ------------------------------------------------------------------ *
   * the gate in front of every contact
   * ------------------------------------------------------------------ */
  function holderName(v) { return (v && v.holder && v.holder.name) || 'the other recruiter'; }

  function showBlocked(v, ctx) {
    var hold = v.holder || {};
    modal('<div class="fcr-jd-head"><h3>Held by another recruiter</h3>'
      + '<button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
      + '<div class="fcr-jd-body"><div class="tlsc-banner tlsc-banner-red">' + h(v.message || 'Another recruiter holds this candidate.') + '</div>'
      + '<p class="tlsc-small">Calls, WhatsApp, SMS, email, adding to a job and submission for this role are blocked. '
      + 'You can message ' + h(holderName(v)) + ' or ask an administrator to override.</p></div>'
      + '<div class="fcr-jd-actions">'
      + (hold.recruiterId ? '<button class="btn btn-primary" onclick="TLEngagement.messageHolder(\'' + js(ctx.candidateId) + '\',\'' + js(hold.recruiterId) + '\',\'' + js(hold.name || '') + '\',\'' + js(ctx.jobId || '') + '\')">Message ' + h(hold.name || 'holder') + '</button>' : '')
      + (isRecruiter() ? '<button class="btn btn-ghost" onclick="TLEngagement.requestOverride(\'' + js(ctx.candidateId) + '\',\'' + js(ctx.jobId || '') + '\',\'' + js(v.roleKey || '') + '\',\'' + js(v.reason === 'joined' || v.reason === 'placed_other_role' ? 'placed' : 'hold') + '\')">Request admin override</button>' : '')
      + '<button class="btn btn-ghost" onclick="fcrCloseModal()">Close</button></div>');
  }

  var PENDING = null;   // the continuation of the action the warning interrupted

  function showWarn(v, ctx, proceed) {
    PENDING = proceed;
    var hold = v.holder || {};
    modal('<div class="fcr-jd-head"><h3>Already contacted</h3>'
      + '<button class="fcr-jd-x" onclick="TLEngagement._cancel()">✕</button></div>'
      + '<div class="fcr-jd-body"><div class="tlsc-banner tlsc-banner-orange">' + h(v.message || 'Another recruiter contacted this candidate recently. Contact anyway?') + '</div>'
      + '<p class="tlsc-small">You can go ahead. Choosing "Contact anyway" is recorded so the team can see it.</p></div>'
      + '<div class="fcr-jd-actions">'
      + '<button class="btn btn-primary" id="tlscAnyway" onclick="TLEngagement._anyway()">Contact anyway</button>'
      + (hold.recruiterId ? '<button class="btn btn-ghost" onclick="TLEngagement._cancel();TLEngagement.messageHolder(\'' + js(ctx.candidateId) + '\',\'' + js(hold.recruiterId) + '\',\'' + js(hold.name || '') + '\',\'' + js(ctx.jobId || '') + '\')">Message ' + h(hold.name || 'them') + '</button>' : '')
      + '<button class="btn btn-ghost" onclick="TLEngagement._cancel()">Cancel</button></div>');
  }

  function showNotLooking(av, proceed) {
    PENDING = proceed;
    modal('<div class="fcr-jd-head"><h3>Not looking for a job</h3>'
      + '<button class="fcr-jd-x" onclick="TLEngagement._cancel()">✕</button></div>'
      + '<div class="fcr-jd-body"><div class="tlsc-banner tlsc-banner-grey">This candidate said they are not looking'
      + (av.updatedAt ? ' (' + h(dateText(av.updatedAt)) + ')' : '') + '.</div>'
      + '<p class="tlsc-small">You may still contact them. The status is theirs - if they tell you something else, write it in Log call.</p></div>'
      + '<div class="fcr-jd-actions"><button class="btn btn-primary" onclick="TLEngagement._anyway()">Continue</button>'
      + '<button class="btn btn-ghost" onclick="TLEngagement._cancel()">Cancel</button></div>');
  }

  /**
   * Resolves true when the action may go ahead (and has been recorded
   * when `record` is set), false when it must not.
   */
  function gate(ctx) {
    var a = api();
    if (!a || !isStaff()) return Promise.resolve(true);
    var body = { candidateId: ctx.candidateId, jobId: ctx.jobId || undefined, action: ctx.action || 'contact' };
    return a.post('/engagement/check', Object.assign({ dryRun: true }, body)).then(function (r) {
      var v = r.verdict || { decision: 'allowed' };
      var av = r.availability || null;
      if (r.doNotContact && ctx.action !== 'add_to_job') {
        say('This candidate has asked not to be contacted.', '⛔');
        return false;
      }
      if (v.decision === 'blocked') { showBlocked(v, ctx); return false; }

      var commit = function (ack) {
        if (!ack && !ctx.record) return Promise.resolve(true);
        return a.post('/engagement/check', Object.assign({ acknowledge: !!ack, record: !!ctx.record }, body))
          .then(function () { invalidate(ctx.candidateId); return true; })
          .catch(function (e) {
            if (e && e.code === 'ENGAGEMENT_BLOCKED') {
              showBlocked((e.details && e.details.engagement) || { message: e.message }, ctx);
            } else say((e && e.message) || 'That could not be checked', '⚠️');
            return false;
          });
      };
      var afterAvailability = function (ack) {
        if (av && av.status === 'not_looking' && ctx.action !== 'add_to_job') {
          return new Promise(function (resolve) {
            showNotLooking(av, function (go) { if (!go) return resolve(false); closeModal(); resolve(commit(ack)); });
          });
        }
        return commit(ack);
      };
      if (v.decision === 'warn') {
        return new Promise(function (resolve) {
          showWarn(v, ctx, function (go) { if (!go) return resolve(false); closeModal(); resolve(afterAvailability(true)); });
        });
      }
      return afterAvailability(false);
    }).catch(function (e) {
      say((e && e.message) || 'Could not check who is working with this candidate', '⚠️');
      return false;
    });
  }

  /* ------------------------------------------------------------------ *
   * Message <holder>, Request admin override, Log call
   * ------------------------------------------------------------------ */
  function messageHolder(candidateId, recruiterId, name, jobId) {
    modal('<div class="fcr-jd-head"><h3>Message ' + h(name || 'the recruiter') + '</h3>'
      + '<p>An internal message in TeamLink. The candidate does not see it.</p>'
      + '<button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
      + '<div class="fcr-jd-body"><div class="tlsc-f"><label for="tlscMsg">Message</label>'
      + '<textarea id="tlscMsg" rows="5" maxlength="1000" placeholder="e.g. She called me directly about this role - can we agree who takes it?"></textarea></div>'
      + '<div id="tlscErr" class="tlsc-err"></div></div>'
      + '<div class="fcr-jd-actions"><button class="btn btn-primary" id="tlscSend" onclick="TLEngagement._sendMessage(\''
      + js(candidateId) + '\',\'' + js(recruiterId) + '\',\'' + js(jobId || '') + '\')">Send</button>'
      + '<button class="btn btn-ghost" onclick="fcrCloseModal()">Cancel</button></div>');
  }
  function sendMessage(candidateId, recruiterId, jobId) {
    var text = ((document.getElementById('tlscMsg') || {}).value || '').trim();
    var err = document.getElementById('tlscErr');
    if (text.length < 2) { if (err) err.textContent = 'Write a short message.'; return; }
    var btn = document.getElementById('tlscSend'); if (btn) btn.disabled = true;
    api().post('/engagement/message-holder', { candidateId: candidateId, recruiterId: recruiterId,
      jobId: jobId || undefined, message: text }).then(function (r) {
      closeModal();
      say('Message sent to ' + (r.to || 'the recruiter'), '✉️');
    }).catch(function (e) {
      if (btn) btn.disabled = false;
      if (err) err.textContent = (e && e.message) || 'The message could not be sent.';
    });
  }

  function requestOverride(candidateId, jobId, roleKey, kind) {
    modal('<div class="fcr-jd-head"><h3>Request admin override</h3>'
      + '<p>An administrator approves or denies this with a reason. Both are recorded.</p>'
      + '<button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
      + '<div class="fcr-jd-body"><div class="tlsc-f"><label for="tlscReason">Why should you work with this candidate?</label>'
      + '<textarea id="tlscReason" rows="4" maxlength="1000" placeholder="e.g. The candidate asked for me by name; the other recruiter agreed."></textarea></div>'
      + '<div id="tlscErr" class="tlsc-err"></div></div>'
      + '<div class="fcr-jd-actions"><button class="btn btn-primary" id="tlscSend" onclick="TLEngagement._sendOverride(\''
      + js(candidateId) + '\',\'' + js(jobId || '') + '\',\'' + js(roleKey || '') + '\',\'' + js(kind || 'hold') + '\')">Send request</button>'
      + '<button class="btn btn-ghost" onclick="fcrCloseModal()">Cancel</button></div>');
  }
  function sendOverride(candidateId, jobId, roleKey, kind) {
    var reason = ((document.getElementById('tlscReason') || {}).value || '').trim();
    var err = document.getElementById('tlscErr');
    if (reason.length < 3) { if (err) err.textContent = 'Say why - the administrator decides on this.'; return; }
    var btn = document.getElementById('tlscSend'); if (btn) btn.disabled = true;
    api().post('/engagement/overrides', { candidateId: candidateId, jobId: jobId || undefined,
      roleKey: roleKey || undefined, kind: kind || 'hold', reason: reason }).then(function () {
      closeModal();
      say('Override requested. You will be notified when an administrator decides.', '📨');
      invalidate(candidateId);
      repaintProfile(true);
    }).catch(function (e) {
      if (btn) btn.disabled = false;
      if (err) err.textContent = (e && e.message) || 'The request could not be sent.';
    });
  }

  function myJobs() {
    var s = session();
    var jobs = (window.DATA && DATA.jobs) || [];
    return jobs.filter(function (j) {
      return j && j.status !== 'draft' && !j.archived && (!s || s.role !== 'recruiter' || j.recruiterId === s.id);
    });
  }
  function jobOptions(selected) {
    return '<option value="">No specific job</option>' + myJobs().map(function (j) {
      return '<option value="' + h(j.id) + '"' + (j.id === selected ? ' selected' : '') + '>' + h(j.title) + '</option>';
    }).join('');
  }

  function logCall(candidateId, jobId) {
    var outcomes = (PROFILE[candidateId] && PROFILE[candidateId].data && PROFILE[candidateId].data.callOutcomes) || OUTCOME;
    modal('<div class="fcr-jd-head"><h3>Log call</h3><p>What happened on the call. The note is saved as a comment on the profile.</p>'
      + '<button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
      + '<div class="fcr-jd-body">'
      + '<div class="tlsc-f"><label>Outcome</label><div class="tlsc-outcomes">'
      + ['interested', 'not_interested', 'no_answer', 'call_back', 'wrong_number'].map(function (k, i) {
        return '<label class="tlsc-radio"><input type="radio" name="tlscOutcome" value="' + k + '"' + (i === 0 ? ' checked' : '') + '>'
          + h(outcomes[k] || OUTCOME[k]) + '</label>';
      }).join('') + '</div></div>'
      + '<div class="tlsc-f"><label for="tlscJob">Job (optional)</label><select id="tlscJob">' + jobOptions(jobId) + '</select></div>'
      + '<div class="tlsc-f"><label for="tlscNote">Note (optional)</label><textarea id="tlscNote" rows="3" maxlength="4000" placeholder="e.g. Can join in 15 days, expects 3.5 LPA"></textarea>'
      + '<label class="tlsc-check"><input type="checkbox" id="tlscTeam"> Share this note with the team</label></div>'
      + '<div id="tlscErr" class="tlsc-err"></div></div>'
      + '<div class="fcr-jd-actions"><button class="btn btn-primary" id="tlscSend" onclick="TLEngagement._sendCall(\'' + js(candidateId) + '\', false)">Save</button>'
      + '<button class="btn btn-ghost" onclick="fcrCloseModal()">Cancel</button></div>');
  }

  var CALL_DRAFT = null;
  function sendCall(candidateId, acknowledge) {
    var draft = acknowledge && CALL_DRAFT ? CALL_DRAFT : {
      outcome: ((document.querySelector('input[name="tlscOutcome"]:checked') || {}).value) || 'interested',
      jobId: ((document.getElementById('tlscJob') || {}).value) || '',
      note: (((document.getElementById('tlscNote') || {}).value) || '').trim(),
      team: !!((document.getElementById('tlscTeam') || {}).checked),
    };
    CALL_DRAFT = draft;
    var btn = document.getElementById('tlscSend'); if (btn) btn.disabled = true;
    api().post('/candidates/' + encodeURIComponent(candidateId) + '/call-log', {
      outcome: draft.outcome, jobId: draft.jobId || undefined, note: draft.note || undefined,
      noteVisibility: draft.team ? 'team' : 'private', acknowledge: !!acknowledge,
    }).then(function () {
      CALL_DRAFT = null;
      closeModal();
      say('Call logged', '📞');
      invalidate(candidateId);
      repaintProfile(true);
    }).catch(function (e) {
      if (btn) btn.disabled = false;
      var v = (e && e.details && e.details.engagement) || null;
      var ctx = { candidateId: candidateId, jobId: draft.jobId || null, action: 'call' };
      if (e && e.code === 'ENGAGEMENT_WARN' && v) {
        showWarn(v, ctx, function (go) { if (go) sendCall(candidateId, true); else closeModal(); });
      } else if (e && e.code === 'ENGAGEMENT_BLOCKED' && v) {
        showBlocked(v, ctx);
      } else {
        var err = document.getElementById('tlscErr');
        if (err) err.textContent = (e && e.message) || 'The call could not be logged.';
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * the candidate profile: TeamLink activity
   * ------------------------------------------------------------------ */
  var PROFILE = {};   // id -> { at, jobId, data }

  function profileId() {
    var m = /#\/(recruiter|admin)\/candidate-profile\?id=([^&]+)/.exec(location.hash || '');
    return m ? decodeURIComponent(m[2]) : null;
  }

  function loadProfile(id, jobId, force) {
    var c = PROFILE[id];
    if (!force && c && c.jobId === (jobId || '') && Date.now() - c.at < 20000) return Promise.resolve(c.data);
    return api().get('/candidates/' + encodeURIComponent(id) + '/engagements' + (jobId ? '?jobId=' + encodeURIComponent(jobId) : ''))
      .then(function (d) { PROFILE[id] = { at: Date.now(), jobId: jobId || '', data: d }; return d; });
  }

  function levelText(e) {
    if (e.level === 'in_process') return e.statusLabel || 'In process';
    if (e.level === 'joined') return 'Joined';
    if (e.level === 'contacted') return 'Contacted';
    return e.statusLabel ? e.statusLabel : 'Closed';
  }

  function panelHtml(id, d, jobId) {
    var v = d.verdict || {};
    var blocked = v.decision === 'blocked';
    var phone = (window.DATA && DATA.candidateById && (DATA.candidateById(id) || {}).phone) || '';
    var dis = function (why) { return ' disabled title="' + h(why) + '"'; };
    var banner = '';
    if (v.decision === 'blocked') {
      banner = '<div class="tlsc-banner tlsc-banner-red">' + h(v.message) + '<div class="tlsc-banner-act">'
        + (v.holder && v.holder.recruiterId ? '<button class="btn btn-sm btn-primary" onclick="TLEngagement.messageHolder(\'' + js(id) + '\',\'' + js(v.holder.recruiterId) + '\',\'' + js(v.holder.name) + '\',\'' + js(jobId || '') + '\')">Message ' + h(v.holder.name) + '</button>' : '')
        + (isRecruiter() ? '<button class="btn btn-sm btn-ghost" onclick="TLEngagement.requestOverride(\'' + js(id) + '\',\'' + js(jobId || '') + '\',\'' + js(v.roleKey || '') + '\',\'' + (v.reason === 'joined' || v.reason === 'placed_other_role' ? 'placed' : 'hold') + '\')">Request admin override</button>' : '')
        + '</div></div>';
    } else if (v.decision === 'warn') {
      banner = '<div class="tlsc-banner tlsc-banner-orange">' + h(String(v.message || '').replace(/ Contact anyway\?$/, ''))
        + '. You can still contact them; it will be recorded.</div>';
    } else if (v.reason === 'override') {
      banner = '<div class="tlsc-banner tlsc-banner-grey">An administrator approved your override for this candidate.</div>';
    }
    var why = blocked ? (v.message || 'Held by another recruiter') : '';
    var rows = (d.engagements || []);
    return '<div class="panel-head"><div><h2>TeamLink activity</h2>'
      + '<div class="desc">Who at TeamLink has worked with this candidate, for which role. Notes and message text stay with the recruiter who wrote them.</div></div>'
      + '<div class="tlsc-actions">'
      + '<select id="tlscRole" title="Check against one of your jobs" onchange="TLEngagement._role(\'' + js(id) + '\', this.value)">' + jobOptions(jobId).replace('No specific job', 'Any role') + '</select>'
      + '<button class="btn btn-ghost btn-sm" id="tlscCall"' + (blocked ? dis(why) : phone ? '' : dis('No phone number on file')) + ' onclick="TLEngagement._call(\'' + js(id) + '\')">📞 Call</button>'
      + '<button class="btn btn-ghost btn-sm" id="tlscWa"' + (blocked ? dis(why) : phone ? '' : dis('No phone number on file')) + ' onclick="TLEngagement._wa(\'' + js(id) + '\')">WhatsApp</button>'
      + (isRecruiter() || (session() && session().role === 'admin') ? '<button class="btn btn-primary btn-sm" id="tlscLog"' + (blocked ? dis(why) : '') + ' onclick="TLEngagement.logCall(\'' + js(id) + '\',\'' + js(jobId || '') + '\')">Log call</button>' : '')
      + '</div></div>'
      + '<div class="panel-body">' + banner
      + (d.canEdit === false ? '<div class="tlsc-ro">Read-only: only the recruiter who added this candidate, the recruiter whose job they applied to, or an admin can edit this profile.</div>' : '')
      + (rows.length ? '<div class="tbl-wrap"><table class="data tlsc-tbl"><thead><tr><th>Recruiter</th><th>Role</th><th>Last contact</th><th>Channel</th><th>Outcome</th><th>Status</th><th>Hold</th></tr></thead><tbody>'
        + rows.map(function (e) {
          return '<tr' + (e.isActive ? '' : ' class="tlsc-old"') + '><td><b>' + h(e.isMe ? 'You' : e.recruiterName) + '</b>'
            + (e.isHolder && e.isActive ? ' <span class="tlsc-b tlsc-' + (e.level === 'contacted' ? 'orange' : 'red') + '">Holds</span>' : '') + '</td>'
            + '<td>' + h(roleText(e)) + (e.sameRole ? ' <span class="tlsc-same">same role</span>' : '') + '</td>'
            + '<td>' + h(dateText(e.lastContactAt)) + '<div class="tlsc-sub">' + h(ago(e.lastContactAt)) + '</div></td>'
            + '<td>' + h(CHANNEL[e.lastChannel] || e.lastChannel || '—') + '</td>'
            + '<td>' + h(OUTCOME[e.lastOutcome] || (e.lastOutcome ? String(e.lastOutcome).replace(/_/g, ' ') : '—')) + '</td>'
            + '<td>' + h(levelText(e)) + '</td>'
            + '<td>' + (e.isActive && e.holdExpiresAt ? 'until ' + h(dateText(e.holdExpiresAt)) : '<span class="tlsc-sub">ended</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<p class="empty-note" style="padding:6px 0">Nobody at TeamLink has contacted this candidate yet.</p>')
      + '</div>';
  }

  var PROFILE_JOB = {};
  function repaintProfile(force) {
    var id = profileId();
    if (!id || !isStaff()) return;
    var body = document.querySelector('.dash-body');
    if (!body) return;
    var host = document.getElementById('tlscPanel');
    var jobId = PROFILE_JOB[id] || '';
    if (!host || host.getAttribute('data-for') !== id) {
      var anchor = body.querySelector('.panel');
      if (!anchor) return;
      host = document.createElement('div');
      host.className = 'panel';
      host.id = 'tlscPanel';
      host.style.marginBottom = '16px';
      host.setAttribute('data-for', id);
      host.innerHTML = '<div class="panel-body"><p class="empty-note">Loading TeamLink activity…</p></div>';
      anchor.parentNode.insertBefore(host, anchor.nextSibling);
    } else if (!force && host.getAttribute('data-painted') === id + '|' + jobId) {
      return;
    }
    /* A fresh panel after a page re-render uses the minute-old answer;
       an action that changed something asks again (force). */
    loadProfile(id, jobId, force).then(function (d) {
      var now = document.getElementById('tlscPanel');
      if (!now || now.getAttribute('data-for') !== id) return;
      now.innerHTML = panelHtml(id, d, jobId);
      now.setAttribute('data-painted', id + '|' + jobId);
      try { document.dispatchEvent(new CustomEvent('tl:engagement', { detail: { candidateId: id, data: d } })); } catch (e) { /* */ }
      /* Somebody else's record: the edit controls go. The server refuses
         the edit anyway; this saves the recruiter finding out that way. */
      if (d.canEdit === false) {
        Array.prototype.forEach.call(document.querySelectorAll('.dash-body button[onclick^="tlSourceEdit"]'),
          function (b) { b.style.display = 'none'; });
      }
    }).catch(function () {
      var now = document.getElementById('tlscPanel');
      if (now) now.innerHTML = '<div class="panel-body"><p class="empty-note">TeamLink activity could not be loaded.</p></div>';
    });
  }

  function digits(p) { return String(p || '').replace(/\D/g, ''); }
  function callFromProfile(id) {
    var c = window.DATA && DATA.candidateById ? DATA.candidateById(id) : null;
    var phone = c && c.phone;
    if (!phone) { say('No phone number on file', '⚠️'); return; }
    gate({ candidateId: id, jobId: PROFILE_JOB[id] || null, action: 'call' }).then(function (ok) {
      if (!ok) return;
      location.href = 'tel:' + digits(phone);
      /* The call happens on the phone; the record of it is the Log call. */
      setTimeout(function () { logCall(id, PROFILE_JOB[id] || ''); }, 800);
    });
  }
  function waFromProfile(id) {
    window.__tlscJob = PROFILE_JOB[id] || null;
    window.openWhatsAppForCandidate(id, '');
  }

  /* ------------------------------------------------------------------ *
   * wrapping the existing contact actions
   * ------------------------------------------------------------------ */
  /* Once per name, ever: a module that wraps the same function after this
     one must not cause a second gate around it. */
  var WRAPPED = {};
  function wrapOnce(name, make) {
    var prev = window[name];
    if (WRAPPED[name] || typeof prev !== 'function' || prev.__tlsc) return false;
    var next = make(prev);
    next.__tlsc = true;
    window[name] = next;
    WRAPPED[name] = true;
    return true;
  }

  function installWrappers() {
    /* WhatsApp (wa.me), from anywhere. The application's own job, when
       the button belongs to an application, is the role checked. */
    wrapOnce('openStatusWhatsApp', function (prev) {
      return function (appId) {
        try {
          var a = (window.DATA && DATA.applications || []).filter(function (x) { return x.id === appId; })[0];
          window.__tlscJob = a ? a.jobId : null;
          if (!a && window.DATA && DATA.candidates) {
            var c = DATA.candidates.filter(function (x) { return 'primary__' + x.id === appId; })[0];
            if (c) window.__tlscJob = c.appliedJobId || null;
          }
        } catch (e) { window.__tlscJob = null; }
        return prev.apply(this, arguments);
      };
    });
    wrapOnce('openWhatsAppForCandidate', function (prev) {
      return function (candId, message) {
        var self = this, args = arguments;
        var jobId = window.__tlscJob || null;
        window.__tlscJob = null;
        gate({ candidateId: candId, jobId: jobId, action: 'whatsapp', record: true }).then(function (ok) {
          if (ok) prev.apply(self, args);
        });
      };
    });

    /* AI call from the Talent Pool. The server refuses a held candidate
       too (a trigger on ai_call_sessions); this says so first. */
    wrapOnce('tpCallGo', function (prev) {
      return function (id) {
        var jobId = (document.getElementById('tpCallJob') || {}).value || '';
        if (!jobId) return prev.apply(this, arguments);
        var self = this, args = arguments;
        return gate({ candidateId: id, jobId: jobId, action: 'ai_call' }).then(function (ok) {
          if (!ok) return;
          if (document.getElementById('tpCallJob')) return prev.apply(self, args);
          /* The warning replaced the dialog the original reads its job
             from, so the same request is made here. */
          return api().post('/ai-calling/call', { candidateId: id, jobId: jobId }).then(function () {
            closeModal();
            say('AI call queued', '📞');
            if (typeof window.tpLoad === 'function') window.tpLoad();
          }, function (e) { say('The call could not be started: ' + ((e && e.message) || 'unknown error'), '⚠️'); });
        });
      };
    });

    /* Find Candidates' own Email / WhatsApp / SMS buttons send from the
       BROWSER (EmailJS, a configured endpoint, wa.me), so no server sees
       those messages. The rules are applied to the selection before the
       compose box opens, and every message that went is recorded. */
    [['fcrEmailModal', 'email'], ['fcrWhatsappModal', 'whatsapp'], ['fcrSmsModal', 'sms']].forEach(function (p) {
      wrapOnce(p[0], function (prev) {
        return function () { return guardSelection(p[1], prev, this, arguments); };
      });
    });
    [['fcrSendEmails', 'email', 'fcrEmailSt_'], ['fcrSendWhatsapp', 'whatsapp', 'fcrWaSt_'],
     ['fcrSendSms', 'sms', 'fcrSmsSt_'], ['fcrOpenWhatsappAll', 'whatsapp', 'fcrWaSt_']].forEach(function (p) {
      wrapOnce(p[0], function (prev) {
        return function () {
          var out = prev.apply(this, arguments);
          Promise.resolve(out).then(function () { setTimeout(function () { recordSent(p[1], p[2]); }, 2000); });
          return out;
        };
      });
    });

    /* Assign to job: held candidates are left out, contacted ones need a
       decision, and the server enforces both anyway. */
    wrapOnce('tpAssignGo', function (prev) {
      return function () {
        var jobId = (document.getElementById('tpAssignJob') || {}).value || '';
        var s = window.STATE && STATE.talentPool;
        if (!jobId || !s) return prev.apply(this, arguments);
        var ids = (s.rows || []).filter(function (c) { return s.picked[c.id]; }).map(function (c) { return c.id; });
        var self = this, args = arguments;
        return Promise.all(ids.map(function (id) {
          return api().post('/engagement/check', { candidateId: id, jobId: jobId, action: 'add_to_job', dryRun: true })
            .then(function (r) { return { id: id, v: r.verdict || { decision: 'allowed' } }; },
                  function () { return { id: id, v: { decision: 'allowed' } }; });
        })).then(function (list) {
          var held = list.filter(function (x) { return x.v.decision === 'blocked'; });
          var warned = list.filter(function (x) { return x.v.decision === 'warn'; });
          if (!held.length && !warned.length) return prev.apply(self, args);
          var name = function (id) { var c = (s.rows || []).filter(function (r) { return r.id === id; })[0]; return (c && c.name) || id; };
          ASSIGN = { jobId: jobId, ok: list.filter(function (x) { return x.v.decision === 'allowed'; }).map(function (x) { return x.id; }),
                     warned: warned.map(function (x) { return x.id; }) };
          modal('<div class="fcr-jd-head"><h3>Assign to job</h3><button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
            + '<div class="fcr-jd-body">'
            + (held.length ? '<div class="tlsc-banner tlsc-banner-red">' + held.length + ' held by another recruiter for this role and will be skipped: '
              + held.map(function (x) { return h(name(x.id)) + ' (' + h(holderName(x.v)) + ')'; }).join(', ') + '</div>' : '')
            + (warned.length ? '<div class="tlsc-banner tlsc-banner-orange">' + warned.length + ' contacted by another recruiter recently: '
              + warned.map(function (x) { return h(name(x.id)) + ' (' + h(holderName(x.v)) + ')'; }).join(', ')
              + '<label class="tlsc-check"><input type="checkbox" id="tlscAssignWarn"> Include them anyway (recorded)</label></div>' : '')
            + '<p class="tlsc-small">' + ASSIGN.ok.length + ' candidate' + (ASSIGN.ok.length === 1 ? '' : 's') + ' can be assigned.</p></div>'
            + '<div class="fcr-jd-actions"><button class="btn btn-primary" onclick="TLEngagement._assign()">Assign</button>'
            + '<button class="btn btn-ghost" onclick="fcrCloseModal()">Cancel</button></div>');
        });
      };
    });
  }

  /* ---- Find Candidates' browser-side bulk sends ---- */
  var SEL = null;
  function fcrSelected() {
    var s = (window.STATE && STATE.fcr && STATE.fcr.selection) || {};
    return Object.keys(s).filter(function (k) { return s[k]; });
  }
  function guardSelection(channel, prev, self, args) {
    var ids = fcrSelected();
    if (!ids.length || !isStaff()) return prev.apply(self, args);
    return badges(ids, null).then(function (map) {
      var held = [], placed = [], warned = [], nl = [];
      ids.forEach(function (id) {
        var b = map[id] || {};
        var av = b.availability || {};
        if (av.status === 'placed') placed.push(id);
        else if (b.kind === 'in_process' || b.kind === 'joined') held.push(id);
        else if (av.status === 'not_looking') nl.push(id);
        else if (b.kind === 'contacted') warned.push(id);
      });
      if (!held.length && !placed.length && !warned.length && !nl.length) return prev.apply(self, args);
      var name = function (id) { var c = window.DATA && DATA.candidateById ? DATA.candidateById(id) : null; return (c && c.name) || id; };
      var list = function (a) { return a.slice(0, 5).map(function (id) { return h(name(id)); }).join(', ') + (a.length > 5 ? ' and ' + (a.length - 5) + ' more' : ''); };
      SEL = { channel: channel, prev: prev, self: self, args: args, held: held, placed: placed, warned: warned, nl: nl };
      modal('<div class="fcr-jd-head"><h3>Before you message ' + ids.length + ' candidate' + (ids.length === 1 ? '' : 's') + '</h3>'
        + '<button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div><div class="fcr-jd-body">'
        + (held.length ? '<div class="tlsc-banner tlsc-banner-red">' + held.length + ' being processed by another recruiter - left out: ' + list(held) + '</div>' : '')
        + (placed.length ? '<div class="tlsc-banner tlsc-banner-red">' + placed.length + ' placed through TeamLink (replacement period) - left out: ' + list(placed) + '</div>' : '')
        + (warned.length ? '<div class="tlsc-banner tlsc-banner-orange">' + warned.length + ' contacted recently by another recruiter: ' + list(warned)
          + '<label class="tlsc-check"><input type="checkbox" id="tlscSelWarn"> Include them (recorded as "Contact anyway")</label></div>' : '')
        + (nl.length ? '<div class="tlsc-banner tlsc-banner-grey">' + nl.length + ' said they are not looking: ' + list(nl)
          + '<label class="tlsc-check"><input type="checkbox" id="tlscSelNL"> Include them</label></div>' : '')
        + '</div><div class="fcr-jd-actions"><button class="btn btn-primary" onclick="TLEngagement._selGo()">Continue</button>'
        + '<button class="btn btn-ghost" onclick="fcrCloseModal()">Cancel</button></div>');
    });
  }
  function selGo() {
    var s = SEL; SEL = null;
    if (!s) return;
    var incW = !!((document.getElementById('tlscSelWarn') || {}).checked);
    var incN = !!((document.getElementById('tlscSelNL') || {}).checked);
    var drop = s.held.concat(s.placed, incW ? [] : s.warned, incN ? [] : s.nl);
    drop.forEach(function (id) { if (STATE.fcr && STATE.fcr.selection) delete STATE.fcr.selection[id]; });
    var acks = incW ? s.warned : [];
    closeModal();
    Promise.all(acks.map(function (id) {
      return api().post('/engagement/check', { candidateId: id, action: s.channel, acknowledge: true })
        .catch(function () { if (STATE.fcr && STATE.fcr.selection) delete STATE.fcr.selection[id]; });
    })).then(function () {
      if (drop.length) say(drop.length + ' left out of this message', 'ℹ️');
      if (!fcrSelected().length) { say('Nobody left to message', 'ℹ️'); return; }
      s.prev.apply(s.self, s.args);
    });
  }
  var RECORDED = {};
  function recordSent(channel, prefix) {
    fcrSelected().forEach(function (id) {
      var st = document.getElementById(prefix + id);
      var t = st ? String(st.textContent || '').trim() : '';
      var outcome = t === 'Sent' ? 'sent' : t === 'Opened' ? 'opened' : null;
      var k = channel + '|' + id + '|' + outcome;
      if (!outcome || RECORDED[k]) return;
      RECORDED[k] = 1;
      api().post('/engagement/record', { candidateId: id, channel: channel, outcome: outcome })
        .then(function () { invalidate(id); }, function () { /* the server refused a held one */ });
    });
  }

  var ASSIGN = null;
  function assignGo() {
    if (!ASSIGN) return;
    var a = ASSIGN; ASSIGN = null;
    var withWarned = !!((document.getElementById('tlscAssignWarn') || {}).checked);
    var ids = a.ok.slice();
    var acks = withWarned ? a.warned.slice() : [];
    closeModal();
    var done = 0, failed = 0;
    var ack = function (i) {
      if (i >= acks.length) return Promise.resolve();
      return api().post('/engagement/check', { candidateId: acks[i], jobId: a.jobId, action: 'add_to_job', acknowledge: true })
        .then(function () { ids.push(acks[i]); }, function () { failed++; })
        .then(function () { return ack(i + 1); });
    };
    var next = function (i) {
      if (i >= ids.length) {
        say(done + ' assigned' + (failed ? ', ' + failed + ' already linked or refused' : ''), '🔗');
        if (window.STATE && STATE.talentPool) STATE.talentPool.picked = {};
        ids.forEach(invalidate);
        if (typeof window.tpLoad === 'function') window.tpLoad();
        return;
      }
      api().post('/applications', { jobId: a.jobId, candidateId: ids[i] })
        .then(function () { done++; }, function () { failed++; })
        .then(function () { next(i + 1); });
    };
    ack(0).then(function () { next(0); });
  }

  /* ------------------------------------------------------------------ *
   * Admin -> Shared candidates
   * ------------------------------------------------------------------ */
  var ADMIN = { tab: 'overrides', overrides: null, conflicts: null, err: '' };

  function adminPage() {
    return '<div class="panel"><div class="panel-head"><div><h2>Shared candidates</h2>'
      + '<div class="desc">Every recruiter sees every candidate; two recruiters must not work the same person for the same role. '
      + 'Override requests and conflicts land here.</div></div></div>'
      + '<div class="panel-body"><div class="tlsc-tabs">'
      + '<button class="' + (ADMIN.tab === 'overrides' ? 'on' : '') + '" onclick="TLEngagement._adminTab(\'overrides\')">Override requests</button>'
      + '<button class="' + (ADMIN.tab === 'conflicts' ? 'on' : '') + '" onclick="TLEngagement._adminTab(\'conflicts\')">Conflicts</button></div>'
      + '<div id="tlscAdmin"><p class="empty-note">Loading…</p></div></div></div>';
  }

  function adminLoad() {
    var host = document.getElementById('tlscAdmin');
    if (!host) return;
    var path = ADMIN.tab === 'overrides' ? '/engagement/overrides' : '/engagement/conflicts';
    api().get(path).then(function (r) {
      if (ADMIN.tab === 'overrides') ADMIN.overrides = r.overrides || []; else ADMIN.conflicts = r.conflicts || [];
      adminPaint();
    }).catch(function (e) {
      host.innerHTML = '<p class="empty-note">' + h((e && e.message) || 'Could not load') + '</p>';
    });
  }

  function adminPaint() {
    var host = document.getElementById('tlscAdmin');
    if (!host) return;
    if (ADMIN.tab === 'overrides') {
      var list = ADMIN.overrides || [];
      host.innerHTML = list.length ? '<div class="tbl-wrap"><table class="data tlsc-tbl"><thead><tr><th>Candidate</th><th>Role / job</th><th>Kind</th><th>Requested by</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>'
        + list.map(function (o) {
          return '<tr><td><b>' + h(o.candidateName || o.candidateId) + '</b></td>'
            + '<td>' + h(o.jobTitle || roleText({ roleKey: o.roleKey })) + '</td>'
            + '<td>' + h(o.kind === 'duplicate_submission' ? 'Second submission' : o.kind === 'placed' ? 'Replacement period' : 'Hold') + '</td>'
            + '<td>' + h(o.requesterName || (o.requesterRecruiterId ? o.requesterRecruiterId : 'Admin')) + '<div class="tlsc-sub">' + h(dateText(o.createdAt)) + '</div></td>'
            + '<td style="max-width:280px">' + h(o.reason) + '</td>'
            + '<td><span class="tlsc-b ' + (o.status === 'approved' ? 'tlsc-green' : o.status === 'denied' ? 'tlsc-red' : 'tlsc-orange') + '">' + h(o.status) + '</span>'
            + (o.decisionReason ? '<div class="tlsc-sub">' + h(o.decisionReason) + '</div>' : '') + '</td>'
            + '<td style="white-space:nowrap">' + (o.status === 'pending'
              ? '<button class="btn btn-primary btn-sm" onclick="TLEngagement._decide(' + o.id + ', true)">Approve</button> '
                + '<button class="btn btn-ghost btn-sm" onclick="TLEngagement._decide(' + o.id + ', false)">Deny</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="empty-note">No override requests.</p>';
    } else {
      var rows = ADMIN.conflicts || [];
      host.innerHTML = rows.length ? '<div class="tbl-wrap"><table class="data tlsc-tbl"><thead><tr><th>Candidate</th><th>Role</th><th>Recruiters</th><th>Last activity</th><th>Contact anyway</th><th>Overrides</th></tr></thead><tbody>'
        + rows.map(function (c) {
          return '<tr><td>' + h(c.candidateName) + '</td><td>' + h((c.jobTitles && c.jobTitles[0]) || roleText({ roleKey: c.roleKey })) + '</td>'
            + '<td>' + h((c.recruiters || []).join(', ')) + (c.recruiterCount >= 2 ? ' <span class="tlsc-b tlsc-red">' + c.recruiterCount + ' recruiters</span>' : '') + '</td>'
            + '<td>' + h(dateText(c.lastAt)) + '</td><td>' + (c.contactAnyway || 0) + '</td><td>' + (c.overrides || 0) + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="empty-note">No conflicts in the last 90 days.</p>';
    }
  }

  function decide(id, approve) {
    modal('<div class="fcr-jd-head"><h3>' + (approve ? 'Approve' : 'Deny') + ' override</h3><button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
      + '<div class="fcr-jd-body"><div class="tlsc-f"><label for="tlscReason">Reason (recorded)</label>'
      + '<textarea id="tlscReason" rows="3" maxlength="1000"></textarea></div><div id="tlscErr" class="tlsc-err"></div></div>'
      + '<div class="fcr-jd-actions"><button class="btn btn-primary" id="tlscSend" onclick="TLEngagement._decideGo(' + Number(id) + ',' + (approve ? 'true' : 'false') + ')">' + (approve ? 'Approve' : 'Deny') + '</button>'
      + '<button class="btn btn-ghost" onclick="fcrCloseModal()">Cancel</button></div>');
  }
  function decideGo(id, approve) {
    var reason = ((document.getElementById('tlscReason') || {}).value || '').trim();
    var err = document.getElementById('tlscErr');
    if (reason.length < 3) { if (err) err.textContent = 'A decision needs a reason.'; return; }
    var btn = document.getElementById('tlscSend'); if (btn) btn.disabled = true;
    api().post('/engagement/overrides/' + id + '/decide', { approve: approve, reason: reason }).then(function () {
      closeModal();
      say(approve ? 'Override approved' : 'Override denied', approve ? '✅' : '⛔');
      adminLoad();
    }).catch(function (e) {
      if (btn) btn.disabled = false;
      if (err) err.textContent = (e && e.message) || 'That could not be saved.';
    });
  }

  function installAdmin() {
    try {
      var nav = (typeof NAV_CONFIG !== 'undefined' && NAV_CONFIG.admin) || null;
      if (nav && !nav.some(function (n) { return n[0] === 'shared-candidates'; })) {
        nav.push(['shared-candidates', 'Shared candidates', '🤝']);
      }
    } catch (e) { /* the page is still reachable by URL */ }
    wrapOnce('pageAdminDash', function (prev) {
      return function (section) {
        if (section !== 'shared-candidates') return prev.apply(this, arguments);
        return typeof window.dashShell === 'function'
          ? window.dashShell('admin', 'shared-candidates', 'Shared candidates', 'Admin · TeamLink Platform', adminPage())
          : adminPage();
      };
    });
  }

  /* ------------------------------------------------------------------ *
   * after every paint
   * ------------------------------------------------------------------ */
  var scheduled = false;
  function afterPaint() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      try { installWrappers(); } catch (e) { /* retried next paint */ }
      if (!isStaff()) return;
      try { decorateLists(); } catch (e) { /* cosmetic */ }
      try { repaintProfile(false); } catch (e) { /* cosmetic */ }
      if ((location.hash || '').indexOf('#/admin/shared-candidates') === 0) {
        var host = document.getElementById('tlscAdmin');
        if (host && !host.getAttribute('data-loaded')) { host.setAttribute('data-loaded', '1'); adminLoad(); }
      }
    }, 30);
  }

  function install() {
    if (typeof window.render !== 'function' || typeof window.navigate !== 'function') return false;
    installAdmin();
    installWrappers();
    var prevRender = window.render;
    if (!prevRender.__tlsc) {
      var next = function () { var r = prevRender.apply(this, arguments); afterPaint(); return r; };
      next.__tlsc = true;
      window.render = next;
    }
    /* The Talent Pool and Find Candidates repaint parts of the page
       without a full render. */
    try {
      var root = document.getElementById('app') || document.body;
      new MutationObserver(function () { afterPaint(); }).observe(root, { childList: true, subtree: true });
    } catch (e) { /* render() still covers it */ }
    afterPaint();
    return true;
  }

  window.TLEngagement = {
    gate: gate,
    badges: badges,
    invalidate: invalidate,
    others: others,
    messageHolder: messageHolder,
    requestOverride: requestOverride,
    logCall: logCall,
    _sendMessage: sendMessage,
    _sendOverride: sendOverride,
    _sendCall: sendCall,
    _anyway: function () { var p = PENDING; PENDING = null; if (p) p(true); },
    _cancel: function () { var p = PENDING; PENDING = null; closeModal(); if (p) p(false); },
    _call: callFromProfile,
    _wa: waFromProfile,
    _role: function (id, jobId) { PROFILE_JOB[id] = jobId || ''; repaintProfile(true); },
    _assign: assignGo,
    _selGo: selGo,
    _adminTab: function (t) { ADMIN.tab = t; if (typeof window.render === 'function') window.render(); },
    _decide: decide,
    _decideGo: decideGo,
  };

  var tries = 0;
  (function wait() {
    if (install()) return;
    if (++tries < 80) setTimeout(wait, 250);
  })();

  /* ------------------------------------------------------------------ *
   * styles
   * ------------------------------------------------------------------ */
  var css = ''
    + '.tlsc-slot{display:inline-flex;gap:5px;margin-left:6px;vertical-align:middle;flex-wrap:wrap}'
    + 'td.who .tlsc-slot{display:flex;margin:4px 0 0}'
    + '.tlsc-b{display:inline-block;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:800;line-height:1.5;border:0;font-family:inherit;white-space:nowrap}'
    + '.tlsc-red{background:#fdeaea;color:#b3261e}'
    + '.tlsc-orange{background:#fff1df;color:#a35a00}'
    + '.tlsc-grey{background:#eef1f5;color:#4a5b76;cursor:pointer}'
    + '.tlsc-green{background:#e8f6ee;color:#1d7a45}'
    + '.tlsc-pop{position:absolute;z-index:9999;background:#fff;border:1px solid #dfe5ee;border-radius:10px;box-shadow:0 12px 30px rgba(20,30,50,.18);padding:10px 12px;width:280px;font-size:12.5px}'
    + '.tlsc-pop-h{font-size:10.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#7a8798;margin-bottom:6px}'
    + '.tlsc-pop-r{padding:4px 0;border-top:1px solid #f1f4f8}.tlsc-pop-r span{color:#7a8798}'
    + '.tlsc-banner{border-radius:9px;padding:10px 12px;font-size:13px;line-height:1.5;margin-bottom:12px}'
    + '.tlsc-banner-red{background:#fdeaea;border:1px solid #f3b8b4;color:#8c1d16}'
    + '.tlsc-banner-orange{background:#fff6e8;border:1px solid #f0c27a;color:#7a4a05}'
    + '.tlsc-banner-grey{background:#f3f5f8;border:1px solid #dfe5ee;color:#42505f}'
    + '.tlsc-banner-act{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}'
    + '.tlsc-small{font-size:12.5px;color:#5b6b82;margin:0}'
    + '.tlsc-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}'
    + '.tlsc-actions select{border:1px solid #d9e0ea;border-radius:8px;padding:5px 8px;font:inherit;font-size:12.5px;max-width:200px;background:#fff}'
    + '.tlsc-actions button[disabled]{opacity:.5;cursor:not-allowed}'
    + '.tlsc-ro{background:#f3f5f8;border:1px dashed #cfd7e3;border-radius:8px;padding:8px 12px;font-size:12.5px;color:#42505f;margin-bottom:12px}'
    + '.tlsc-tbl td{vertical-align:top}.tlsc-old td{color:#8895a7}'
    + '.tlsc-sub{font-size:11px;color:#8895a7}'
    + '.tlsc-same{font-size:10.5px;font-weight:800;color:#a35a00;background:#fff1df;border-radius:6px;padding:1px 6px}'
    + '.tlsc-f{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}'
    + '.tlsc-f>label{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#7a8798}'
    + '.tlsc-f select,.tlsc-f textarea{width:100%;border:1px solid #d9e0ea;border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;box-sizing:border-box;background:#fff}'
    + '.tlsc-outcomes{display:flex;flex-wrap:wrap;gap:6px}'
    + '.tlsc-radio{display:inline-flex;align-items:center;gap:6px;border:1px solid #d9e0ea;border-radius:999px;padding:5px 11px;font-size:12.5px;cursor:pointer}'
    + '.tlsc-check{display:flex;align-items:center;gap:7px;font-size:12.5px;color:#42505f;margin-top:6px;text-transform:none;letter-spacing:0;font-weight:600}'
    + '.tlsc-err{color:#b3261e;font-size:12.5px;min-height:1em}'
    + '.tlsc-tabs{display:flex;gap:6px;margin-bottom:12px}.tlsc-tabs button{border:1px solid #d9e0ea;background:#fff;border-radius:999px;padding:5px 13px;font:inherit;font-size:12.5px;cursor:pointer}'
    + '.tlsc-tabs button.on{background:#1490b3;border-color:#1490b3;color:#fff}'
    + '@media (max-width:700px){.tlsc-actions{width:100%}.tlsc-actions select{max-width:100%;flex:1}}';
  var tag = document.createElement('style');
  tag.id = 'tlsc-css';
  tag.textContent = css;
  (document.head || document.documentElement).appendChild(tag);
})();
