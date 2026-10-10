/* =====================================================================
   TEAMLINK JOBS - for the company website (tmlink.in)

   Paste on any page of the website, where the jobs should appear:

     <div id="teamlink-jobs"></div>
     <script src="https://jobs.tmlink.in/teamlink-jobs-embed.js" async></script>

   (jobs.tmlink.in = wherever the job portal is hosted - see docs/WEBSITE-JOBS.md.)

   Every job posted in the portal with "TeamLink Website" ticked (the default)
   appears here as soon as it is published, and disappears when it is closed,
   unpublished, unticked, or a walk-in's dates are over. Apply Now opens that
   exact job in the portal, so the application lands in the portal and the ATS.

   Options, as attributes on the <script> tag (all optional):
     data-target=".my-box"   where to draw (default #teamlink-jobs)
     data-limit="12"         at most this many jobs (default: all)
     data-type="walk-in"     only walk-ins ("walk-in"), or only jobs ("regular")
     data-accent="#4f46e5"   button colour
     data-new-tab="false"    open Apply Now in the same tab

   Drawn inside its own shadow root: the website's styles cannot break it and
   it cannot break the website's. It reads only the public jobs feed
   (/feeds/jobs.json) - nothing about any candidate.
   ===================================================================== */
(function () {
  'use strict';
  var me = document.currentScript;
  if (!me) return;
  var BASE = (function () { try { return new URL(me.src).origin; } catch (e) { return ''; } })();
  var opt = function (k, d) { var v = me.getAttribute('data-' + k); return v == null || v === '' ? d : v; };
  var SEL = opt('target', '#teamlink-jobs');
  var LIMIT = parseInt(opt('limit', '0'), 10) || 0;
  var ONLY = opt('type', '');
  var ACCENT = /^#[0-9a-f]{3,8}$/i.test(opt('accent', '')) ? opt('accent', '') : '#4f46e5';
  var NEW_TAB = opt('new-tab', 'true') !== 'false';
  var REFRESH_MS = 5 * 60 * 1000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeUrl(u) {
    try { var x = new URL(u, BASE); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : ''; } catch (e) { return ''; }
  }
  function ago(iso) {
    if (!iso) return '';
    var d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (!(d >= 0)) return '';
    return d === 0 ? 'Posted today' : d === 1 ? 'Posted yesterday' : 'Posted ' + d + ' days ago';
  }
  function niceDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return s || '';
    var d = new Date(s + 'T00:00:00+05:30');
    return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  }

  var CSS = ''
    + ':host{all:initial;display:block;font-family:inherit;color:#1b2536}'
    + '*{box-sizing:border-box}'
    + '.bar{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}'
    + '.bar input,.bar select{font:inherit;font-size:14px;padding:9px 12px;border:1px solid #d9e0ea;border-radius:8px;background:#fff;color:inherit;min-width:0}'
    + '.bar input{flex:1 1 220px}.bar select{flex:0 1 200px}'
    + '.seg{display:inline-flex;border:1px solid #d9e0ea;border-radius:8px;overflow:hidden}'
    + '.seg button{font:inherit;font-size:13px;border:0;background:#fff;padding:9px 12px;cursor:pointer;color:#42505f}'
    + '.seg button+button{border-left:1px solid #d9e0ea}.seg button.on{background:' + ACCENT + ';color:#fff}'
    + '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}'
    + '.card{border:1px solid #e6ebf2;border-radius:12px;background:#fff;padding:16px;display:flex;flex-direction:column;gap:8px}'
    + '.title{font-size:16px;font-weight:700;margin:0;line-height:1.3}'
    + '.co{font-size:13px;color:#5b6b82}'
    + '.meta{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:13px;color:#42505f}'
    + '.badge{display:inline-block;font-size:11.5px;font-weight:700;border-radius:999px;padding:3px 9px;background:#efeafe;color:#5b3fd1;align-self:flex-start}'
    + '.walk{font-size:12.5px;background:#f6f8fb;border-radius:8px;padding:8px 10px;color:#42505f;line-height:1.45}'
    + '.skills{display:flex;flex-wrap:wrap;gap:5px}.skills span{font-size:11.5px;background:#f1f4f8;border-radius:6px;padding:3px 7px;color:#42505f}'
    + '.foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:auto;padding-top:6px}'
    + '.ago{font-size:12px;color:#8a94a6}'
    + '.apply{font:inherit;font-size:14px;font-weight:700;text-decoration:none;color:#fff;background:' + ACCENT + ';border-radius:8px;padding:9px 16px;white-space:nowrap}'
    + '.apply:hover{filter:brightness(.92)}'
    + '.note{font-size:14px;color:#5b6b82;text-align:center;padding:28px 10px;border:1px dashed #d9e0ea;border-radius:12px}'
    + '.note button{font:inherit;margin-top:10px;border:1px solid #d9e0ea;background:#fff;border-radius:8px;padding:7px 14px;cursor:pointer}'
    + '.count{font-size:13px;color:#5b6b82;margin:0 0 10px}';

  function mount(host) {
    if (host.__tlJobs) return;
    host.__tlJobs = true;
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var S = { jobs: null, err: '', q: '', loc: '', type: ONLY || '' };

    function filtered() {
      var q = S.q.trim().toLowerCase();
      var out = (S.jobs || []).filter(function (j) {
        if (S.type && j.jobType !== S.type) return false;
        if (S.loc && (j.city || j.location) !== S.loc) return false;
        if (!q) return true;
        return [j.title, j.company, j.location, (j.skills || []).join(' '), j.experience].join(' ').toLowerCase().indexOf(q) >= 0;
      });
      return LIMIT ? out.slice(0, LIMIT) : out;
    }
    function card(j) {
      var url = safeUrl(j.applyUrl || j.url);
      var w = j.walkin;
      return '<article class="card">'
        + (j.jobType === 'walk-in' ? '<span class="badge">Walk-in interview</span>' : j.jobType === 'internship' ? '<span class="badge">Internship</span>' : '')
        + '<h3 class="title">' + esc(j.title) + '</h3>'
        + '<div class="co">' + esc(j.company) + '</div>'
        + '<div class="meta">' + [j.location && '📍 ' + esc(j.location), j.experience && '💼 ' + esc(j.experience),
            j.salary && '💰 ' + esc(j.salary), j.workMode && esc(j.workMode)].filter(Boolean).map(function (x) { return '<span>' + x + '</span>'; }).join('') + '</div>'
        + (w ? '<div class="walk"><b>' + esc(niceDate(w.date)) + '</b>' + (w.from ? ' · ' + esc(w.from) + (w.to ? ' – ' + esc(w.to) : '') : '')
            + (w.venue ? '<br>' + esc(w.venue) : '') + (w.address ? '<br>' + esc(w.address) : '') + '</div>' : '')
        + ((j.skills || []).length ? '<div class="skills">' + j.skills.slice(0, 5).map(function (s) { return '<span>' + esc(s) + '</span>'; }).join('') + '</div>' : '')
        + '<div class="foot"><span class="ago">' + esc(ago(j.publishedAt)) + '</span>'
        + (url ? '<a class="apply" href="' + esc(url) + '"' + (NEW_TAB ? ' target="_blank" rel="noopener"' : '') + '>Apply Now</a>' : '')
        + '</div></article>';
    }
    function draw() {
      var html = '<style>' + CSS + '</style>';
      if (S.err && !S.jobs) {
        root.innerHTML = html + '<div class="note">The jobs could not be loaded just now.<br><button type="button" data-retry>Try again</button></div>';
        root.querySelector('[data-retry]').onclick = load;
        return;
      }
      if (!S.jobs) { root.innerHTML = html + '<div class="note">Loading jobs…</div>'; return; }
      var locs = {};
      S.jobs.forEach(function (j) { var l = j.city || j.location; if (l) locs[l] = 1; });
      var list = filtered();
      var focus = root.activeElement && root.activeElement.getAttribute && root.activeElement.getAttribute('data-q') != null;
      root.innerHTML = html
        + '<div class="bar"><input type="search" data-q placeholder="Search jobs, skills or locations" aria-label="Search jobs" value="' + esc(S.q) + '">'
        + '<select data-loc aria-label="Location"><option value="">All locations</option>' + Object.keys(locs).sort().map(function (l) {
            return '<option' + (S.loc === l ? ' selected' : '') + ' value="' + esc(l) + '">' + esc(l) + '</option>'; }).join('') + '</select>'
        + (ONLY ? '' : '<div class="seg" role="group" aria-label="Job type">' + [['', 'All'], ['walk-in', 'Walk-in'], ['regular', 'Jobs']].map(function (t) {
            return '<button type="button" data-type="' + t[0] + '" class="' + (S.type === t[0] ? 'on' : '') + '">' + t[1] + '</button>'; }).join('') + '</div>')
        + '</div>'
        + '<p class="count">' + list.length + ' open position' + (list.length === 1 ? '' : 's') + '</p>'
        + (list.length ? '<div class="grid">' + list.map(card).join('') + '</div>'
          : '<div class="note">' + (S.jobs.length ? 'No jobs match your search.' : 'There are no open positions right now - please check back soon.') + '</div>');
      var q = root.querySelector('[data-q]');
      q.oninput = function () { S.q = q.value; draw(); };
      if (focus) { q.focus(); try { q.setSelectionRange(q.value.length, q.value.length); } catch (e) { /* */ } }
      root.querySelector('[data-loc]').onchange = function (e) { S.loc = e.target.value; draw(); };
      [].forEach.call(root.querySelectorAll('[data-type]'), function (b) { b.onclick = function () { S.type = b.getAttribute('data-type'); draw(); }; });
    }
    function load() {
      S.err = '';
      if (!S.jobs) draw();
      fetch(BASE + '/feeds/jobs.json', { cache: 'no-store', credentials: 'omit' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (f) { S.jobs = (f && f.jobs) || []; draw(); },
              function (e) { S.err = (e && e.message) || 'failed'; draw(); });
    }
    load();
    setInterval(function () { if (!document.hidden) load(); }, REFRESH_MS);
  }

  function start() {
    var host = document.querySelector(SEL);
    if (!host) { host = document.createElement('div'); me.parentNode.insertBefore(host, me); }
    mount(host);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
