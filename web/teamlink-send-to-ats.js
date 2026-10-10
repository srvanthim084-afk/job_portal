/* =====================================================================
   TEAMLINK - Talent Pool: "Send to ATS"

   Puts candidates into a job's hiring pipeline at Shortlisted - one
   candidate from their row, or everyone ticked from the selection bar.
   The box asks for the job (open TeamLink regular jobs only) and whether
   to tell the candidates; the server does the rest
   (POST /api/ats/send-to-pipeline, api/src/routes/send-to-ats.js) and
   says, per candidate, what happened: added, moved up, already further
   along, or refused - and why.

   Messages are off unless "Let the candidates know" is ticked: then each
   candidate moved gets one "your application is now Shortlisted".
   ===================================================================== */
(function () {
  'use strict';
  if (window.tlSendAts) return;

  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function say(m, i) { if (typeof window.toast === 'function') window.toast(m, i || 'ℹ️'); }
  function jobs() {
    var all = (window.DATA && DATA.jobs) || [];
    return all.filter(function (j) {
      return j && j.status === 'open' && !j.paused && !j.archived && j.sourceType !== 'EXTERNAL'
        && j.postingKind !== 'walkin' && j.type !== 'Walk-in';
    }).sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
  }
  var IDS = [];

  window.tlSendAts = function (ids) {
    IDS = (ids || []).filter(Boolean);
    if (!IDS.length) { say('Select at least one candidate first', '⚠️'); return; }
    if (typeof window.fcrModal !== 'function') return;
    var list = jobs();
    var n = IDS.length;
    window.fcrModal('<div class="fcr-jd-head"><h3>Send to ATS</h3>'
      + '<button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
      + '<div class="fcr-jd-body" id="tlsaBody">'
      + '<p style="font-size:12.5px;color:var(--text-soft);margin:0 0 12px">'
      +   (n === 1 ? 'This candidate' : n + ' candidates') + ' will be put into the job\'s hiring pipeline at <b>Shortlisted</b>. '
      +   'Anyone already further along for this job is left where they are; nobody is duplicated.</p>'
      + (list.length
        ? '<label style="display:block;font-size:12px;font-weight:700;margin:0 0 4px" for="tlsaJob">Job</label>'
          + '<select id="tlsaJob" style="width:100%;border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit">'
          + '<option value="">Select a job…</option>'
          + list.map(function (j) { return '<option value="' + h(j.id) + '">' + h(j.title) + (j.location ? ' — ' + h(j.location) : '') + '</option>'; }).join('')
          + '</select>'
          + '<label style="display:flex;gap:8px;align-items:flex-start;margin:12px 0 0;font-size:13px">'
          + '<input type="checkbox" id="tlsaNotify" style="margin-top:3px"> <span>Let the candidates know <span style="color:var(--text-soft)">'
          + '(one “your application is now Shortlisted” message each, on their email / SMS / WhatsApp)</span></span></label>'
          + '<div id="tlsaErr" style="color:var(--bad-600);font-size:12.5px;margin-top:10px"></div>'
          + '<div class="iw-bar"><button class="btn btn-ghost" onclick="fcrCloseModal()">Cancel</button>'
          + '<div class="sp"><button class="btn btn-primary" id="tlsaGo" onclick="tlSendAtsGo()">Send to ATS</button></div></div>'
        : '<div class="empty-note">There is no open regular job to send candidates to. Post a job first (walk-ins and external jobs cannot take candidates from here).</div>'
          + '<div class="iw-bar"><div class="sp"><button class="btn btn-ghost" onclick="fcrCloseModal()">Close</button></div></div>')
      + '</div>');
  };

  window.tlSendAtsGo = function () {
    var sel = document.getElementById('tlsaJob');
    var err = document.getElementById('tlsaErr');
    var btn = document.getElementById('tlsaGo');
    if (!sel || !sel.value) { if (err) err.textContent = 'Choose the job first.'; return; }
    var notify = !!(document.getElementById('tlsaNotify') || {}).checked;
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    if (err) err.textContent = '';
    window.TL.api.post('/ats/send-to-pipeline', { jobId: sel.value, candidateIds: IDS, notify: notify }).then(function (r) {
      var rows = (r.results || []).map(function (x) {
        var what = x.outcome === 'added' ? '<span class="badge badge-ok">Added · Shortlisted</span>'
          : x.outcome === 'moved' ? '<span class="badge badge-ok">Moved up · Shortlisted</span>'
          : x.outcome === 'already' ? '<span class="badge badge-neutral">Already in the pipeline</span>'
          : '<span class="badge badge-bad">Not added</span>';
        return '<tr><td>' + h(x.name || x.candidateId) + '</td><td>' + what
          + (x.reason ? ' <span style="color:var(--text-soft);font-size:12px">' + h(x.reason) + '</span>' : '')
          + '</td><td style="font-size:12px">' + h(x.reference || '') + '</td></tr>';
      }).join('');
      var body = document.getElementById('tlsaBody');
      if (body) body.innerHTML = '<p style="margin:0 0 10px"><b>' + h(r.job && r.job.title) + '</b>: '
        + (r.added || 0) + ' added, ' + (r.moved || 0) + ' moved up, ' + (r.already || 0) + ' already in the pipeline'
        + (r.refused ? ', ' + r.refused + ' not added' : '') + '.'
        + (notify ? ' ' + (r.notified || 0) + ' told.' : ' Nobody was messaged.') + '</p>'
        + '<div class="tbl-wrap"><table class="data"><thead><tr><th>Candidate</th><th>Result</th><th>Application ID</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        + '<div class="iw-bar"><button class="btn btn-ghost" onclick="fcrCloseModal()">Close</button>'
        + '<div class="sp"><button class="btn btn-primary" onclick="fcrCloseModal();navigate(\'/recruiter/applications\')">Open Applications</button></div></div>';
      say(((r.added || 0) + (r.moved || 0)) + ' sent to ATS', '✅');
      try { if (typeof window.tpUnpick === 'function') window.tpUnpick(); } catch (e) { /* */ }
      try { if (typeof window.tpLoad === 'function') window.tpLoad(); } catch (e) { /* */ }
      try { if (window.TL && typeof TL.refresh === 'function') TL.refresh(); } catch (e) { /* */ }
    }, function (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Send to ATS'; }
      if (err) err.textContent = (e && e.message) || 'Could not send - please try again.';
    });
  };
})();
