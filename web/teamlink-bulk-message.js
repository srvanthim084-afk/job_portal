/* =====================================================================
   TEAMLINK — bulk WhatsApp / Email / SMS from the candidate selection

   WHAT WAS THERE. The selection bar had three buttons: Assign to Job,
   AI Call, Clear selection. A recruiter who had just filtered the pool
   down to forty nurses in Nellore could ring them one at a time and
   could not write to any of them.

   WHAT THIS ADDS. Three more buttons, outline like "Assign to Job" - AI
   Call stays the only solid one - each opening a compose box.

   NOTHING IS SENT FROM THE BUTTON. The button opens a form; the form
   posts to the queue; the queue sends. And the summary shown afterwards
   is what the PROVIDERS reported, polled from the server, not the fact
   that the request returned 200.

   NO KEYS ARE HERE. The page never sees a provider credential; it posts
   a message and candidate ids, and api/src/notify/bulk.js does the rest
   with the integrations this application already has.
   ===================================================================== */
(function () {
  'use strict';

  var API = function () { return (window.TL && window.TL.api) || null; };

  function esc(s) {
    return (typeof window.esc === 'function') ? window.esc(s)
      : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
  }
  function toast(m, i) { if (typeof window.toast === 'function') window.toast(m, i || 'ℹ️'); }

  var CHANNEL = {
    whatsapp: { label: 'WhatsApp', needs: 'mobile number', field: 'phone' },
    email:    { label: 'Email',    needs: 'email address', field: 'email' },
    sms:      { label: 'SMS',      needs: 'mobile number', field: 'phone' },
  };

  /* Inline SVG, sized to sit on a btn-sm without shifting the label. */
  window.tlBulkIcon = function (channel) {
    var d = {
      whatsapp: 'M12 2a10 10 0 0 0-8.6 15l-1.3 4.3 4.4-1.3A10 10 0 1 0 12 2Z'
        + 'M8.6 7.3c.2-.4.4-.4.6-.4h.5c.2 0 .4 0 .6.5l.8 2c.1.2 0 .4-.1.5l-.5.6c-.1.2-.2.3 0 .6'
        + 'a7 7 0 0 0 3.2 2.8c.3.1.4 0 .6-.1l.6-.7c.2-.2.3-.2.5-.1l1.9.9c.2.1.3.2.3.4'
        + 'a2 2 0 0 1-1.4 1.8c-.6.2-1.4.2-4-1.2a9 9 0 0 1-3.6-3.8c-.5-1-.4-2 0-2.6Z',
      email: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-15'
        + 'A1.5 1.5 0 0 1 3 17.5v-11Zm1.9.5 7.1 5 7.1-5H4.9Z',
      sms: 'M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-5 4V5a1 1 0 0 1 1-1Zm3 5h10v1.6H7V9Zm0 3.4h7V14H7v-1.6Z',
    }[channel];
    return '<svg class="tlbm-ic" viewBox="0 0 24 24" width="13" height="13" '
      + 'aria-hidden="true" focusable="false"><path d="' + d + '"/></svg>';
  };

  /* ------------------------------------------------------------------ *
   * state for one compose session
   * ------------------------------------------------------------------ */
  var M = null;

  function selected() {
    if (typeof window.tpSelection === 'function') {
      try { return window.tpSelection() || []; } catch (e) { return []; }
    }
    return [];
  }

  /* ------------------------------------------------------------------ *
   * open
   * ------------------------------------------------------------------ */
  window.tlBulkMessage = function (channel) {
    var api = API();
    var ch = CHANNEL[channel];
    if (!ch || !api || typeof window.fcrModal !== 'function') return;

    var rows = selected();
    if (!rows.length) { toast('Select at least one candidate first', '☑️'); return; }

    M = { channel: channel, rows: rows, templates: [], variables: [], batchId: null,
          poll: null, sending: false };

    api.get('/candidates/message-templates?channel=' + channel).then(function (r) {
      M.templates = r.templates || [];
      M.variables = r.variables || [];
      paint();
    }).catch(function () {
      /* Without the templates a recruiter can still write a message, so
         the box opens rather than refusing. */
      M.templates = [{ id: 'blank', name: 'Blank message', subject: '', body: '' }];
      M.variables = [];
      paint();
    });
  };

  function paint() {
    var ch = CHANNEL[M.channel];
    var rows = M.rows;
    var missing = rows.filter(function (c) { return !String(c[ch.field] || '').trim(); });
    var blocked = rows.filter(function (c) { return c.doNotContact; });
    var reachable = rows.length - missing.length - blocked.filter(function (c) {
      return String(c[ch.field] || '').trim();
    }).length;

    window.fcrModal(
      '<div class="fcr-jd-head"><h3>' + esc(ch.label) + ' — ' + rows.length
        + ' candidate' + (rows.length === 1 ? '' : 's') + ' selected</h3>'
      + '<button class="fcr-jd-x" onclick="tlBulkClose()">✕</button></div>'
      + '<div class="fcr-jd-body tlbm-body">'

      /* ---- who will and will not get it -------------------------- */
      + (missing.length
        ? '<div class="tlbm-warn">' + missing.length + ' candidate'
          + (missing.length === 1 ? ' has' : 's have') + ' no ' + esc(ch.needs)
          + ' and will be skipped: '
          + esc(missing.slice(0, 5).map(function (c) { return c.name; }).join(', '))
          + (missing.length > 5 ? ' and ' + (missing.length - 5) + ' more' : '')
          + '.</div>' : '')
      + (blocked.length
        ? '<div class="tlbm-warn">' + blocked.length + ' asked not to be contacted '
          + 'and will be skipped.</div>' : '')

      /* ---- shared candidates (0091) and availability (0092) --------
         Filled in once the server has said who other recruiters hold
         and who is not looking. The server applies the same rules when
         the batch is sent; this only says so before the recruiter
         presses Send. */
      + '<div id="tlbmHolds"></div>'

      /* ---- template ---------------------------------------------- */
      + '<div class="tlbm-f"><label for="tlbmTpl">Template</label>'
      + '<select id="tlbmTpl" onchange="tlBulkTemplate(this.value)">'
      + M.templates.map(function (t) {
        return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>';
      }).join('') + '</select></div>'

      + (M.channel === 'email'
        ? '<div class="tlbm-f"><label for="tlbmSubj">Subject</label>'
          + '<input id="tlbmSubj" oninput="tlBulkPreview()" '
          + 'placeholder="Subject line"></div>'
        : '')

      + '<div class="tlbm-f"><label for="tlbmBody">Message</label>'
      + '<textarea id="tlbmBody" rows="8" oninput="tlBulkPreview()"></textarea>'
      + (M.variables.length
        ? '<div class="tlbm-vars">'
          + M.variables.map(function (v) {
            return '<button type="button" class="tlbm-var" title="' + esc(v.label) + '" '
              + 'onclick="tlBulkInsert(\'' + esc(v.key) + '\')">{{' + esc(v.key) + '}}</button>';
          }).join('') + '</div>'
        : '')
      + '</div>'

      /* ---- preview ------------------------------------------------ */
      + '<div class="tlbm-prev"><div class="tlbm-prev-h">Preview — '
        + esc((rows[0] && rows[0].name) || 'first selected candidate') + '</div>'
      + '<div id="tlbmPrevSubj" class="tlbm-prev-s"></div>'
      + '<div id="tlbmPrev" class="tlbm-prev-b"></div></div>'

      + '<div id="tlbmResult"></div>'
      + '</div>'

      + '<div class="tlbm-foot">'
      + '<button class="btn btn-ghost" onclick="tlBulkClose()">Cancel</button>'
      + '<button class="btn btn-primary" id="tlbmSend" onclick="tlBulkSend()">'
      + 'Send to ' + Math.max(0, reachable) + ' candidate'
      + (Math.max(0, reachable) === 1 ? '' : 's') + '</button>'
      + '</div>');

    var box = document.querySelector('#fcrModalHost .fcr-modal');
    if (box) box.classList.add('tlbm-modal');

    tlBulkTemplate(M.templates[0] ? M.templates[0].id : 'blank');
    loadHolds();
  }

  /*
   * WHO THE SERVER WILL LEAVE OUT, before Send is pressed.
   *
   *   held by another recruiter (in process / placed)  always skipped
   *   contacted by another recruiter                   skipped unless ticked
   *   said they are not looking                         skipped unless ticked
   *   placed (replacement period)                       always skipped
   *
   * Without a job chosen, every role counts - a message that names no
   * role could be about theirs.
   */
  function loadHolds() {
    var host = document.getElementById('tlbmHolds');
    if (!host || !M || !window.TLEngagement) return;
    var ids = M.rows.map(function (c) { return c.id; });
    window.TLEngagement.badges(ids, null).then(function (map) {
      if (!M) return;
      var held = [], warned = [], notLooking = [], placed = [], cool = [];
      M.rows.forEach(function (c) {
        var b = map[c.id] || {};
        var av = b.availability || {};
        if (av.status === 'placed') { placed.push(c); return; }
        if (av.status === 'not_looking') { notLooking.push(c); return; }
        if (b.kind === 'in_process' || b.kind === 'joined') held.push(c);
        else if (b.cooldown) cool.push(c);
        else if (b.kind === 'contacted') warned.push(c);
      });
      M.holds = { held: held, warned: warned, notLooking: notLooking, placed: placed, cool: cool, map: map };
      var names = function (list) {
        return esc(list.slice(0, 4).map(function (c) { return c.name; }).join(', '))
          + (list.length > 4 ? ' and ' + (list.length - 4) + ' more' : '');
      };
      var host2 = document.getElementById('tlbmHolds');
      if (!host2) return;
      host2.innerHTML = ''
        + (held.length ? '<div class="tlbm-warn tlbm-hold">' + held.length + ' being processed by another recruiter'
          + ' - always skipped: ' + names(held) + '.</div>' : '')
        + (placed.length ? '<div class="tlbm-warn">' + placed.length + ' placed through TeamLink (replacement period)'
          + ' - always skipped: ' + names(placed) + '.</div>' : '')
        + (cool.length ? '<div class="tlbm-warn tlbm-hold"><b>' + cool.length + ' already contacted</b> by another recruiter'
          + ' - skipped:' + coolRows(cool, map)
          + (canOverride() ? '<label class="tlbm-inc"><input type="checkbox" id="tlbmIncOv" onchange="tlBulkCount()"> Override and include them</label>'
            + '<textarea id="tlbmOvWhy" rows="2" placeholder="Reason for overriding (required)" style="width:100%;box-sizing:border-box;margin-top:6px"></textarea>' : '')
          + '</div>' : '')
        + (warned.length ? '<div class="tlbm-warn">' + warned.length + ' contacted recently by another recruiter'
          + ' - skipped unless you include them: ' + names(warned) + '.'
          + '<label class="tlbm-inc"><input type="checkbox" id="tlbmIncWarn" onchange="tlBulkCount()"> Include them'
          + ' (recorded as "Contact anyway")</label></div>' : '')
        + (notLooking.length ? '<div class="tlbm-warn">' + notLooking.length + ' said they are not looking'
          + ' - skipped unless you include them: ' + names(notLooking) + '.'
          + '<label class="tlbm-inc"><input type="checkbox" id="tlbmIncNL" onchange="tlBulkCount()"> Include them</label></div>' : '');
      tlBulkCount();
    });
  }

  function canOverride() {
    var s = window.STATE && STATE.session;
    return !!(s && (s.role === 'admin' || s.isTeamLead === true));
  }
  function dmy(iso) {
    try { return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-'); } catch (e) { return ''; }
  }
  function hm(iso) {
    try { return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  var CH_NAME = { phone: 'Call', whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', ai_call: 'AI Call', bulk_message: 'Message' };
  /* Candidate / Contacted by / Date / Time / Channel */
  function coolRows(list, map) {
    return '<table class="data" style="width:100%;margin-top:6px;font-size:12px"><thead><tr><th>Candidate</th><th>Contacted by</th><th>Date</th><th>Time</th><th>Channel</th></tr></thead><tbody>'
      + list.slice(0, 50).map(function (c) {
        var k = (map[c.id] || {}).cooldown || {};
        return '<tr><td>' + esc(c.name) + '</td><td>' + esc(k.name) + '</td><td>' + esc(dmy(k.contactedAt)) + '</td><td>' + esc(hm(k.contactedAt))
          + '</td><td>' + esc(CH_NAME[k.channel] || k.channel) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  /** The Send button's count, after the skips above. */
  window.tlBulkCount = function () {
    if (!M) return;
    var btn = document.getElementById('tlbmSend');
    if (!btn || M.sending || M.batchId) return;
    var ch = CHANNEL[M.channel];
    var hold = M.holds || { held: [], warned: [], notLooking: [], placed: [], cool: [] };
    var incO = !!(document.getElementById('tlbmIncOv') || {}).checked;
    var incW = !!(document.getElementById('tlbmIncWarn') || {}).checked;
    var incN = !!(document.getElementById('tlbmIncNL') || {}).checked;
    var out = {};
    hold.held.concat(hold.placed).forEach(function (c) { out[c.id] = 1; });
    if (!incW) hold.warned.forEach(function (c) { out[c.id] = 1; });
    if (!incN) hold.notLooking.forEach(function (c) { out[c.id] = 1; });
    if (!incO) (hold.cool || []).forEach(function (c) { out[c.id] = 1; });
    var n = M.rows.filter(function (c) {
      return !out[c.id] && !c.doNotContact && String(c[ch.field] || '').trim();
    }).length;
    btn.textContent = 'Send to ' + n + ' candidate' + (n === 1 ? '' : 's');
  };

  window.tlBulkClose = function () {
    if (M && M.poll) clearInterval(M.poll);
    M = null;
    if (typeof window.fcrCloseModal === 'function') window.fcrCloseModal();
  };

  window.tlBulkTemplate = function (id) {
    if (!M) return;
    var t = M.templates.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var body = document.getElementById('tlbmBody');
    var subj = document.getElementById('tlbmSubj');
    /* A template REPLACES the box only while the recruiter has not
       started writing. Wiping somebody's half-typed message because they
       browsed the dropdown is the kind of thing that gets a feature
       switched off. */
    if (body && (!body.value.trim() || body.dataset.fromTemplate === '1')) {
      body.value = t.body || '';
      body.dataset.fromTemplate = '1';
    }
    if (subj && (!subj.value.trim() || subj.dataset.fromTemplate === '1')) {
      subj.value = t.subject || '';
      subj.dataset.fromTemplate = '1';
    }
    if (body) body.addEventListener('input', function () { body.dataset.fromTemplate = '0'; },
      { once: true });
    tlBulkPreview();
  };

  window.tlBulkInsert = function (key) {
    var body = document.getElementById('tlbmBody');
    if (!body) return;
    var at = body.selectionStart || body.value.length;
    body.value = body.value.slice(0, at) + '{{' + key + '}}' + body.value.slice(at);
    body.dataset.fromTemplate = '0';
    body.focus();
    body.selectionStart = body.selectionEnd = at + key.length + 4;
    tlBulkPreview();
  };

  /**
   * The preview, rendered against the FIRST selected candidate.
   *
   * The same rule the server uses: a variable it knows becomes the value
   * (empty when there is nothing on file), one it does not know is left
   * showing its braces, so a typo is visible here rather than in
   * somebody's inbox.
   */
  /** The signed-in recruiter, looked up the way the rest of the app does. */
  function recruiterName() {
    try {
      var s = window.STATE && STATE.session;
      if (!s || !window.DATA) return '';
      var rec = DATA.recruiterById ? DATA.recruiterById(s.id) : null;
      return (rec && rec.name) || '';
    } catch (e) { return ''; }
  }

  function fill(text, c) {
    var v = {
      candidate_name: c.name || '',
      first_name: String(c.name || '').split(/\s+/)[0] || '',
      job_title: c.preferredRole || c.title || '',
      company: 'TeamLink Consultants',
      /* STATE.session carries an id and a role, not a name, so reading
         `.name` off it showed an empty recruiter in the preview while the
         server - which looks the recruiter up - put the real one in the
         message that went out. A preview that differs from what is sent
         is worse than no preview. */
      recruiter_name: recruiterName(),
      location: c.location || '',
      current_company: c.currentCompany || '',
      notice_period: c.noticePeriod || '',
    };
    return String(text || '').replace(/\{\{\s*([a-z_]{1,40})\s*\}\}/gi, function (whole, k) {
      var key = String(k).toLowerCase();
      return Object.prototype.hasOwnProperty.call(v, key) ? String(v[key] || '') : whole;
    });
  }

  window.tlBulkPreview = function () {
    if (!M) return;
    var c = M.rows[0] || {};
    var body = (document.getElementById('tlbmBody') || {}).value || '';
    var subj = (document.getElementById('tlbmSubj') || {}).value || '';
    var pb = document.getElementById('tlbmPrev');
    var ps = document.getElementById('tlbmPrevSubj');
    if (pb) pb.textContent = fill(body, c) || '—';
    if (ps) ps.textContent = M.channel === 'email' ? (fill(subj, c) || '(no subject)') : '';
  };

  /* ------------------------------------------------------------------ *
   * send
   * ------------------------------------------------------------------ */
  window.tlBulkSend = function () {
    if (!M || M.sending) return;
    var api = API();
    var btn = document.getElementById('tlbmSend');
    var body = (document.getElementById('tlbmBody') || {}).value || '';
    var subj = (document.getElementById('tlbmSubj') || {}).value || '';

    if (!body.trim()) { toast('Write a message first', '⚠️'); return; }
    if (M.channel === 'email' && !subj.trim()) { toast('An email needs a subject', '⚠️'); return; }
    var over = !!(document.getElementById('tlbmIncOv') || {}).checked;
    var why = ((document.getElementById('tlbmOvWhy') || {}).value || '').trim();
    if (over && why.length < 5) { toast('Say why you are overriding the cooldown', '⚠️'); return; }

    M.sending = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Queueing…'; }

    api.post('/candidates/bulk-message', {
      channel: M.channel,
      candidateIds: M.rows.map(function (c) { return c.id; }),
      templateId: (document.getElementById('tlbmTpl') || {}).value || undefined,
      subject: M.channel === 'email' ? subj : undefined,
      body: body,
      includeWarned: !!(document.getElementById('tlbmIncWarn') || {}).checked,
      includeNotLooking: !!(document.getElementById('tlbmIncNL') || {}).checked,
      override: over || undefined,
      overrideReason: over ? why : undefined,
    }).then(function (r) {
      M.batchId = r.batchId;
      if (btn) btn.textContent = 'Sending…';
      showResult(r, null);
      watch();
    }).catch(function (e) {
      M.sending = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
      toast((e && e.message) || 'The messages could not be queued', '⚠️');
    });
  };

  /**
   * Poll the batch until nothing is pending.
   *
   * WHY POLL AT ALL. The response to the send says "queued" and that is
   * the truth at that moment. What a recruiter needs to see is what the
   * providers did, and that is known a few seconds later. Reporting
   * "sent to 40" from the 202 would be reporting something nobody has
   * checked.
   */
  function watch() {
    var api = API();
    if (!api || !M || !M.batchId) return;
    var id = M.batchId;
    var tries = 0;
    if (M.poll) clearInterval(M.poll);
    M.poll = setInterval(function () {
      tries += 1;
      if (!M || M.batchId !== id) { clearInterval(M.poll); return; }
      if (tries > 60) { clearInterval(M.poll); M.poll = null; return; }
      api.get('/candidates/bulk-message/' + encodeURIComponent(id)).then(function (s) {
        if (!M || M.batchId !== id) return;
        showResult(null, s);
        if (s.finished) {
          clearInterval(M.poll); M.poll = null;
          M.sending = false;
          var btn = document.getElementById('tlbmSend');
          if (btn) { btn.disabled = false; btn.textContent = 'Send again'; }
        }
      }).catch(function () { /* one missed poll changes nothing */ });
    }, 1500);
  }

  function showResult(queued, status) {
    var host = document.getElementById('tlbmResult');
    if (!host) return;
    var ch = CHANNEL[M.channel];

    if (queued) {
      host.innerHTML = '<div class="tlbm-res">'
        + '<div class="tlbm-res-h">Queued</div>'
        + '<div class="tlbm-res-g">'
        + tile('Queued', queued.queued, '')
        + tile('Skipped', queued.skipped, 'no ' + esc(queued.skippedFor))
        + tile('Not contacted', queued.blocked, 'opted out')
        + (queued.held ? tile('Held by others', queued.held, 'another recruiter') : '')
        + (queued.warned ? tile('Contacted by others', queued.warned, 'not included') : '')
        + (queued.notLooking ? tile('Not looking', queued.notLooking, 'not included') : '')
        + (queued.placed ? tile('Placed', queued.placed, 'replacement period') : '')
        + (queued.cooldownSkipped ? tile('Already contacted', queued.cooldownSkipped, 'skipped') : '')
        + '</div>'
        + (queued.cooldownSkipped
          ? '<div class="tlbm-res-n"><b>' + queued.queued + ' sent, ' + queued.cooldownSkipped + ' skipped (already contacted)</b>'
            + '<table class="data" style="width:100%;margin-top:6px;font-size:12px"><thead><tr><th>Candidate</th><th>Contacted by</th><th>Date</th><th>Time</th><th>Channel</th></tr></thead><tbody>'
            + queued.cooldownCandidates.slice(0, 100).map(function (c) {
              return '<tr><td>' + esc(c.name) + '</td><td>' + esc(c.heldBy) + '</td><td>' + esc(dmy(c.contactedAt)) + '</td><td>' + esc(hm(c.contactedAt))
                + '</td><td>' + esc(CH_NAME[c.channel] || c.channel) + '</td></tr>';
            }).join('') + '</tbody></table></div>' : '')
        + '<div class="tlbm-res-n">' + esc(queued.note) + '</div></div>';
      return;
    }

    var failures = (status.failures || []).map(function (f) {
      return '<div class="tlbm-fail"><b>' + esc(f.name) + '</b> — '
        + esc(f.status === 'not_configured'
            ? 'no ' + ch.label + ' provider is configured on this server'
            : (f.error || 'failed')) + '</div>';
    }).join('');

    host.innerHTML = '<div class="tlbm-res">'
      + '<div class="tlbm-res-h">' + (status.finished ? 'Finished' : 'Sending…') + '</div>'
      + '<div class="tlbm-res-g">'
      + tile('Sent', status.sent, '')
      + tile('Failed', status.failed + status.notConfigured, '')
      + tile('Skipped', status.skipped, 'no ' + esc(ch.needs))
      + (status.pending ? tile('Pending', status.pending, '') : '')
      + '</div>'
      + (failures ? '<div class="tlbm-fails">' + failures + '</div>' : '')
      + '<div class="tlbm-res-n">Your selection has been kept.</div></div>';
  }

  function tile(label, n, note) {
    return '<div class="tlbm-t"><div class="k">' + esc(label) + '</div>'
      + '<div class="v">' + (n || 0) + '</div>'
      + (note ? '<div class="n">' + note + '</div>' : '') + '</div>';
  }

  /* ------------------------------------------------------------------ *
   * the Communication section on a candidate profile
   * ------------------------------------------------------------------ */
  window.tlCommunicationHistory = function (candidateId, hostId) {
    var api = API();
    var host = document.getElementById(hostId);
    if (!api || !host) return;
    api.get('/candidates/' + encodeURIComponent(candidateId) + '/messages')
      .then(function (r) {
        var list = r.messages || [];
        if (!list.length) {
          host.innerHTML = '<p class="empty-note" style="padding:8px 0">'
            + 'Nothing has been sent to this candidate yet.</p>';
          return;
        }
        host.innerHTML = '<table class="tlbm-hist"><thead><tr><th>When</th><th>Channel</th>'
          + '<th>Message</th><th>Status</th></tr></thead><tbody>'
          + list.map(function (m) {
            var when = m.sentAt || m.queuedAt;
            var cls = m.status === 'sent' || m.status === 'delivered' ? 'ok'
                    : m.status === 'queued' || m.status === 'sending' ? 'wait' : 'bad';
            return '<tr><td>' + esc(new Date(when).toLocaleString()) + '</td>'
              + '<td>' + esc(CHANNEL[m.channel] ? CHANNEL[m.channel].label : m.channel) + '</td>'
              + '<td>' + (m.subject ? '<b>' + esc(m.subject) + '</b><br>' : '')
                + '<span class="tlbm-h-b">' + esc(String(m.body).slice(0, 180))
                + (String(m.body).length > 180 ? '…' : '') + '</span></td>'
              + '<td><span class="tlbm-s tlbm-s-' + cls + '">' + esc(m.status) + '</span>'
                + (m.error ? '<div class="tlbm-h-e">' + esc(m.error) + '</div>' : '')
                + '</td></tr>';
          }).join('') + '</tbody></table>';
      })
      .catch(function () {
        host.innerHTML = '<p class="empty-note" style="padding:8px 0">'
          + 'The message history could not be loaded.</p>';
      });
  };

  /* The section is mounted into the candidate profile after it renders,
     so the profile's own markup is not touched. */
  (function hookProfile() {
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (tries > 60) { clearInterval(timer); return; }
      if (typeof window.navigate !== 'function') return;
      clearInterval(timer);
      var mountedFor = null;
      setInterval(function () {
        var m = /#\/recruiter\/candidates\/([^/?]+)/.exec(location.hash || '');
        if (!m) { mountedFor = null; return; }
        var id = m[1];
        if (mountedFor === id && document.getElementById('tlbmHist')) return;
        var body = document.querySelector('.dash-body');
        if (!body) return;
        var old = document.getElementById('tlbmPanel');
        if (old) old.remove();
        var panel = document.createElement('div');
        panel.className = 'panel';
        panel.id = 'tlbmPanel';
        panel.style.marginTop = '14px';
        panel.innerHTML = '<div class="panel-head"><div><h2>Communication</h2>'
          + '<div class="desc">Every WhatsApp, email and SMS sent to this candidate '
          + 'from TeamLink, and what the provider said about it.</div></div></div>'
          + '<div class="panel-body"><div id="tlbmHist"></div></div>';
        body.appendChild(panel);
        mountedFor = id;
        window.tlCommunicationHistory(id, 'tlbmHist');
      }, 900);
    }, 400);
  })();

  /* ------------------------------------------------------------------ *
   * styles
   * ------------------------------------------------------------------ */
  var css = ''
    + '.tlbm-ic{vertical-align:-2px;margin-right:5px;fill:currentColor}'
    + '.tlbm-modal{max-width:760px}'
    + '.tlbm-body{padding-bottom:8px}'
    + '.tlbm-f{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}'
    + '.tlbm-f>label{font-size:11px;font-weight:800;letter-spacing:.05em;'
      + 'text-transform:uppercase;color:#7a8798}'
    + '.tlbm-f select,.tlbm-f input,.tlbm-f textarea{width:100%;border:1px solid #d9e0ea;'
      + 'border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;box-sizing:border-box;'
      + 'background:#fff;color:#1b2536}'
    + '.tlbm-f textarea{resize:vertical;line-height:1.55}'
    + '.tlbm-vars{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}'
    + '.tlbm-var{border:1px dashed #c3cede;background:#f7f9fc;border-radius:6px;'
      + 'font:inherit;font-size:11px;color:#4a5b76;padding:2px 7px;cursor:pointer}'
    + '.tlbm-var:hover{border-color:#5b5bd6;color:#5b5bd6}'
    + '.tlbm-warn{background:#fff8ea;border:1px solid #f0c27a;color:#7a5510;'
      + 'border-radius:8px;padding:9px 12px;font-size:12.5px;margin-bottom:12px}'
    + '.tlbm-prev{border:1px solid #e6ebf2;border-radius:10px;background:#fafbfd;'
      + 'padding:10px 12px;margin-bottom:12px}'
    + '.tlbm-prev-h{font-size:10.5px;font-weight:800;letter-spacing:.05em;'
      + 'text-transform:uppercase;color:#8895a7;margin-bottom:5px}'
    + '.tlbm-prev-s{font-size:13px;font-weight:700;color:#1b2536;margin-bottom:4px}'
    + '.tlbm-prev-b{font-size:13px;line-height:1.55;color:#2b3a4f;white-space:pre-wrap}'
    + '.tlbm-res{border:1px solid #e6ebf2;border-radius:10px;padding:12px;margin-top:4px}'
    + '.tlbm-res-h{font-size:12px;font-weight:800;margin-bottom:8px;color:#2b3a4f}'
    + '.tlbm-res-g{display:flex;gap:10px;flex-wrap:wrap}'
    + '.tlbm-t{border:1px solid #e6ebf2;border-radius:8px;padding:8px 12px;min-width:92px}'
    + '.tlbm-t .k{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8895a7}'
    + '.tlbm-t .v{font-size:19px;font-weight:800;color:#1b2536}'
    + '.tlbm-t .n{font-size:10.5px;color:#8895a7}'
    + '.tlbm-res-n{font-size:11.5px;color:#7a8798;margin-top:8px}'
    + '.tlbm-fails{margin-top:8px;border-top:1px solid #f1f4f8;padding-top:8px}'
    + '.tlbm-fail{font-size:12px;color:#b3261e;padding:2px 0}'
    + '.tlbm-foot{position:sticky;bottom:0;background:#fff;border-top:1px solid #e9edf3;'
      + 'padding:13px 26px;display:flex;justify-content:flex-end;gap:10px;'
      + 'border-radius:0 0 12px 12px}'
    + '.tlbm-hist{width:100%;border-collapse:collapse;font-size:12.5px}'
    + '.tlbm-hist th{text-align:left;font-size:10.5px;text-transform:uppercase;'
      + 'letter-spacing:.04em;color:#7a8798;padding:6px 8px;border-bottom:1px solid #e6ebf2}'
    + '.tlbm-hist td{padding:8px;border-bottom:1px solid #f1f4f8;vertical-align:top}'
    + '.tlbm-h-b{color:#4a5b76;white-space:pre-wrap}'
    + '.tlbm-h-e{font-size:11px;color:#b3261e;margin-top:3px}'
    + '.tlbm-s{border-radius:20px;padding:2px 9px;font-size:11px;font-weight:800}'
    + '.tlbm-s-ok{background:#e8f6ee;color:#1d7a45}'
    + '.tlbm-s-wait{background:#eef2fb;color:#3b4d78}'
    + '.tlbm-s-bad{background:#fdeaea;color:#b3261e}'
    + '.tlbm-hold{background:#fdeaea;border-color:#f3b8b4;color:#8c1d16}'
    + '.tlbm-inc{display:flex;align-items:center;gap:7px;margin-top:6px;font-weight:700;cursor:pointer}'
    + '@media (max-width:700px){.tlbm-res-g{flex-direction:column}}';

  var tag = document.createElement('style');
  tag.id = 'tlbm-css';
  tag.textContent = css;
  (document.head || document.documentElement).appendChild(tag);
})();
