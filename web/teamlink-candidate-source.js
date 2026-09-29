/* =====================================================================
   TEAMLINK — where a candidate came from, on their own record

   The Talent Pool column and its filter answer "how many came from
   Naukri". This answers the other half: on one candidate's profile, what
   is their source, when were they added, who changed it, and when.

   THE ORIGINAL SOURCE IS NOT OVERWRITTEN BY ACCIDENT. The dialog offers
   two different things, and says which is which:

     "Correct the source"  — this was recorded wrongly; fix it.
     "Also seen from"      — they turned up again through another door;
                             keep the first one and note the second.

   Reporting depends entirely on that distinction. A candidate who
   applied through Naukri and later walked in did not stop coming from
   Naukri, and a screen that quietly replaces the first answer makes
   every source report unaccountable.

   ADDITIVE. Two dialogs and one CSV column. Nothing existing is
   replaced.
   ===================================================================== */
(function () {
  'use strict';

  function api() { return (window.TL && window.TL.api) || null; }
  function esc(s) {
    return (typeof window.esc === 'function') ? window.esc(s)
      : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
  }
  function toast(m, i) { if (typeof window.toast === 'function') window.toast(m, i || 'ℹ️'); }

  var SOURCES = [
    'Career Site', 'Job Board', 'Employee Referral', 'Agency/Vendor',
    'Campus/Event', 'Social Media', 'Talent Community Signup',
    'Manual Entry', 'Bulk Import', 'Other',
  ];

  function candidate(id) {
    try { return DATA.candidateById(id) || null; } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ *
   * correcting it
   * ------------------------------------------------------------------ */
  window.tlSourceEdit = function (id) {
    var c = candidate(id);
    if (!c || typeof window.fcrModal !== 'function') return;

    window.fcrModal(
      '<div class="fcr-jd-head"><h3>Source &mdash; ' + esc(c.name) + '</h3>'
      + '<p>Where this candidate came from. Used for reporting on which of '
      + 'our channels actually works.</p>'
      + '<button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
      + '<div class="fcr-jd-body">'
      +   '<div class="fcr-jd-row"><label>Current</label><span class="v">'
      +     '<b>' + esc(c.source || 'Unknown') + '</b>'
      +     (c.sourceDetails ? ' &mdash; ' + esc(c.sourceDetails) : '') + '</span></div>'

      +   '<div class="fcr-jd-row"><label>Source</label>'
      +     '<select id="tlsrcSel" style="width:100%">'
      +       SOURCES.map(function (x) {
            return '<option value="' + esc(x) + '"' + (c.source === x ? ' selected' : '') + '>'
              + esc(x) + '</option>';
          }).join('')
      +     '</select></div>'

      +   '<div class="fcr-jd-row"><label>Detail</label>'
      +     '<input id="tlsrcDetail" style="width:100%" maxlength="200" '
      +       'value="' + esc(c.sourceDetails || '') + '" '
      +       'placeholder="Which board, who referred them, which campus…"></div>'

      /* The distinction the whole thing turns on, stated on the form
         rather than left for somebody to infer from a checkbox label. */
      +   '<label class="tlsrc-also"><input type="checkbox" id="tlsrcAlso"> '
      +     'They came through this door <b>as well</b> &mdash; keep '
      +     '<b>' + esc(c.source || 'the original') + '</b> as the original source '
      +     'and record this one in their history</label>'

      +   '<div id="tlsrcErr" class="tlsrc-err"></div>'
      + '</div>'
      + '<div class="fcr-jd-actions">'
      +   '<button class="btn btn-primary" id="tlsrcSave" onclick="tlSourceSave(\''
      +     esc(id) + '\')">Save</button>'
      +   '<button class="btn btn-ghost" onclick="fcrCloseModal()">Cancel</button>'
      + '</div>');
  };

  window.tlSourceSave = function (id) {
    var a = api();
    if (!a) return;
    var sel = document.getElementById('tlsrcSel');
    var det = document.getElementById('tlsrcDetail');
    var also = document.getElementById('tlsrcAlso');
    var btn = document.getElementById('tlsrcSave');
    var err = document.getElementById('tlsrcErr');
    if (!sel) return;

    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    if (err) err.textContent = '';

    a.post('/candidates/' + encodeURIComponent(id) + '/source', {
      source: sel.value,
      sourceDetails: det ? det.value.trim() : '',
      alsoSeen: !!(also && also.checked),
    }).then(function (res) {
      /* The server's version back into the record the screens read, so
         the header and the pool agree with what was just saved. */
      try {
        var i = DATA.candidates.findIndex(function (x) { return x.id === id; });
        if (i >= 0) Object.assign(DATA.candidates[i], res.candidate);
      } catch (e) {}
      if (typeof window.fcrCloseModal === 'function') window.fcrCloseModal();
      toast(also && also.checked
        ? 'Noted — the original source was kept.'
        : 'Source updated.', '✅');
      if (typeof window.render === 'function') window.render();
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
      if (err) err.textContent = (e && e.message) || 'That did not save.';
    });
  };

  /* ------------------------------------------------------------------ *
   * what has been done to it
   * ------------------------------------------------------------------ */
  window.tlSourceHistory = function (id) {
    var a = api();
    var c = candidate(id);
    if (!a || !c || typeof window.fcrModal !== 'function') return;

    window.fcrModal(
      '<div class="fcr-jd-head"><h3>Source history &mdash; ' + esc(c.name) + '</h3>'
      + '<p>Every change, and who made it.</p>'
      + '<button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
      + '<div class="fcr-jd-body" id="tlsrcHist">Loading…</div>');

    a.get('/candidates/' + encodeURIComponent(id) + '/activity').then(function (res) {
      var host = document.getElementById('tlsrcHist');
      if (!host) return;
      var rows = res.activity || [];
      if (!rows.length) {
        host.innerHTML = '<div class="empty-note">Nothing has been changed. '
          + 'The source is as it was recorded when this candidate was added'
          + (c.addedOn ? ', on ' + esc(String(c.addedOn).slice(0, 10)) : '') + '.</div>';
        return;
      }
      host.innerHTML = '<div class="tlsrc-hist">' + rows.map(function (x) {
        return '<div class="tlsrc-hrow">'
          + '<div class="tlsrc-hsum">' + esc(x.summary) + '</div>'
          + '<div class="tlsrc-hmeta">' + esc(String(x.at).slice(0, 16).replace('T', ' '))
          + (x.actor ? ' · ' + esc(x.actor) : '') + '</div></div>';
      }).join('') + '</div>';
    }).catch(function () {
      var host = document.getElementById('tlsrcHist');
      if (host) host.innerHTML = '<div class="empty-note">The history could not be loaded.</div>';
    });
  };

  /* ------------------------------------------------------------------ *
   * styles
   * ------------------------------------------------------------------ */
  var css = ''
    + '.tlsrc-also{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;'
      + 'color:#41506a;line-height:1.5;margin-top:10px;padding:10px 12px;'
      + 'background:#f6f9fc;border:1px solid #e6ebf2;border-radius:9px;cursor:pointer}'
    + '.tlsrc-also input{margin-top:2px;flex:0 0 auto}'
    + '.tlsrc-err{color:#b42318;font-size:12.5px;margin-top:8px}'
    + '.tlsrc-err:empty{display:none}'
    + '.tlsrc-hist{display:flex;flex-direction:column;gap:2px}'
    + '.tlsrc-hrow{padding:9px 0;border-top:1px solid #eef2f7}'
    + '.tlsrc-hrow:first-child{border-top:0}'
    + '.tlsrc-hsum{font-size:13px;color:#16202c}'
    + '.tlsrc-hmeta{font-size:11.5px;color:#8a97a6;margin-top:2px}';

  var tag = document.createElement('style');
  tag.id = 'tl-source-css';
  tag.textContent = css;
  (document.head || document.documentElement).appendChild(tag);
}());
