/* =====================================================================
   TEAMLINK — Job Sources (admin)

   Where the external jobs come from, and whether each source can
   actually run. Until now sources could only be created through the API:
   there was no screen, so "add Adzuna" meant a curl command and finding
   out it was misconfigured meant reading a server log.

   WHAT IT SHOWS, per source: the name, whether it is switched on,
   whether its credentials are present, when it last synced, how many
   jobs that sync returned, the last error in the provider's own words,
   and a Sync now button.

   0108 ADDS, on the same screen: the provider each source is and how it
   is authorized; its licence record (with an editor) and whether it may
   be switched on; its configuration (allowed domains, sync interval,
   rate limit, close grace period, quota); its health; the providers that
   need an authorized feed or licence; postings in quarantine and why;
   stored-link changes; the audit trail; the four analytics counts; and
   every external job with the fields an administrator needs, with
   confirmed, counted, audited bulk actions.

   NO KEY IS EVER SHOWN OR SENT. The screen asks the server which
   environment variables each connector needs and whether each NAME has
   something behind it. The values never leave the server, and there is
   nowhere on this page to type one - which is deliberate: a key pasted
   into a web form ends up in a database, a log and a backup.

   THE SERVER DECIDES. Buttons are hidden from people who may not use
   them; every action is checked again by the API and the database.

   ADDITIVE. One nav entry, one screen, one script tag. Nothing existing
   is replaced; pageAdminDash is wrapped the same way Notification
   Settings wraps it.
   ===================================================================== */
(function () {
  'use strict';

  var S = {
    sources: [], connectors: [], providers: [], loading: false, error: '', busy: {},
    runs: [], jobs: [], jobsTotal: 0, jobFilter: { status: 'open', sourceId: '', q: '', offset: 0, limit: 25 },
    picked: {}, quarantine: [], urlChanges: [], audit: [], analytics: null, editing: null, bulkBusy: false,
    lastBulk: null,
  };

  function api() { return (window.TL && window.TL.api) || null; }
  function esc(s) {
    return (typeof window.esc === 'function') ? window.esc(s)
      : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
  }
  function toast(m, i) { if (typeof window.toast === 'function') window.toast(m, i || 'i'); }
  function isAdmin() { return !!(window.STATE && STATE.session && STATE.session.role === 'admin'); }
  var q = function (v) { return encodeURIComponent(v); };

  function day(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
    catch (e) { return String(iso); }
  }

  function when(iso) {
    if (!iso) return 'never';
    try {
      var d = new Date(iso);
      var mins = Math.round((Date.now() - d.getTime()) / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + ' min ago';
      if (mins < 1440) return Math.round(mins / 60) + ' h ago';
      return d.toLocaleDateString();
    } catch (e) { return String(iso); }
  }

  /* ------------------------------------------------------------------ *
   * loading
   * ------------------------------------------------------------------ */
  function load() {
    var a = api();
    if (!a) return;
    S.loading = true; S.error = '';
    paint();
    var none = function (k) { return function () { var o = {}; o[k] = []; return o; }; };
    Promise.all([a.get('/external/sources'), a.get('/external/connectors'),
      a.get('/external/sync-runs').catch(none('runs')),
      a.get('/external/providers').catch(none('providers')),
      a.get('/external/quarantine?limit=50').catch(none('items')),
      a.get('/external/url-changes?limit=30').catch(none('changes')),
      isAdmin() ? a.get('/external/audit?limit=40').catch(none('entries')) : Promise.resolve({ entries: [] }),
      a.get('/external/analytics?days=30').catch(function () { return null; })])
      .then(function (out) {
        S.sources = out[0].sources || [];
        S.connectors = out[1].connectors || [];
        S.runs = (out[2] && out[2].runs) || [];
        S.providers = (out[3] && out[3].providers) || [];
        S.quarantine = (out[4] && out[4].items) || [];
        S.urlChanges = (out[5] && out[5].changes) || [];
        S.audit = (out[6] && out[6].entries) || [];
        S.analytics = out[7];
        S.loading = false;
        paint();
        loadJobs();
      }, function (e) {
        S.loading = false;
        S.error = (e && e.message) || 'The job sources could not be loaded.';
        paint();
      });
  }

  function loadJobs() {
    var a = api();
    if (!a) return;
    var f = S.jobFilter;
    a.get('/external/admin/jobs?status=' + q(f.status) + '&limit=' + f.limit + '&offset=' + f.offset
      + (f.sourceId ? '&sourceId=' + q(f.sourceId) : '') + (f.q ? '&q=' + q(f.q) : ''))
      .then(function (out) { S.jobs = out.jobs || []; S.jobsTotal = out.total || 0; paintJobs(); },
        function (e) { var h = document.getElementById('jsJobsHost'); if (h) h.innerHTML = '<div class="js-err">' + esc((e && e.message) || 'Could not load the jobs.') + '</div>'; });
  }

  /* ------------------------------------------------------------------ *
   * the screen
   * ------------------------------------------------------------------ */
  function panel(id, title, desc) {
    return '<section class="panel" style="margin-top:14px" aria-labelledby="' + id + 'H"><div class="panel-head"><div>'
      + '<h2 id="' + id + 'H">' + title + '</h2>'
      + '<div class="desc">' + desc + '</div>'
      + '</div></div><div class="panel-body"><div id="' + id + '"></div></div></section>';
  }

  function page() {
    setTimeout(load, 0);
    return '<section class="panel" aria-labelledby="jsHostH"><div class="panel-head"><div>'
      + '<h2 id="jsHostH">Job Sources</h2>'
      + '<div class="desc">Where external jobs are collected from. A source with no '
      + 'credentials is skipped and says so — it never returns anything made up. A source that needs a licence '
      + 'cannot be switched on until its licence is recorded.</div>'
      + '</div></div><div class="panel-body"><div id="jsHost"></div><div id="jsEditHost"></div></div></section>'
      + panel('jsProvHost', 'Providers and how they are authorized',
        'Every provider TeamLink knows, how its data is collected, and what it still needs. '
        + 'Naukri, Indeed, Shine and LinkedIn have no public API; they need a licensed partner or employer feed.')
      + panel('jsConnHost', 'Available connectors', 'Each board TeamLink can collect from, and what it needs. '
        + 'Keys are read from the server environment and are never shown here.')
      + panel('jsRunsHost', 'Recent syncs', 'One line per run: fetched, new, updated, closed as stale, '
        + 'duplicates folded together, quarantined, and any error. A failed run keeps the jobs it already had.')
      + panel('jsJobsHost', 'External jobs', 'Every external job with its source, original link and sync state. '
        + 'Candidates applying are sent to the original URL; nothing becomes a TeamLink application.')
      + panel('jsQuarHost', 'Quarantine', 'Postings a sync did not accept, and why. They are not shown to candidates.')
      + panel('jsUrlHost', 'Link changes', 'Every time a stored application link changed. A new link that fails '
        + 'validation is not used — the posting keeps its old one.')
      + panel('jsStatsHost', 'Analytics (30 days)', 'External job views, Apply clicks and redirects. Counts only — '
        + 'no candidate is identified, and no click is ever counted as a TeamLink application.')
      + (isAdmin() ? panel('jsAuditHost', 'Audit trail', 'Who changed a source, a licence or a job, and when. It cannot be edited.') : '');
  }

  function paint() {
    var host = document.getElementById('jsHost');
    var conn = document.getElementById('jsConnHost');
    if (!host) return;

    if (S.loading) {
      host.innerHTML = '<div class="js-empty" role="status">Loading…</div>';
      if (conn) conn.innerHTML = '';
      return;
    }
    if (S.error) {
      host.innerHTML = '<div class="js-err" role="alert">' + esc(S.error) + '</div>';
      return;
    }

    host.innerHTML = S.sources.length ? sourceTable() : '<div class="js-empty">'
      + '<b>No job sources yet</b>'
      + 'Add one from the list below and external jobs start arriving on the next sync.'
      + '</div>';

    if (conn) conn.innerHTML = connectorTable();
    var prov = document.getElementById('jsProvHost');
    if (prov) prov.innerHTML = providerTable();
    paintEditor();

    var runs = document.getElementById('jsRunsHost');
    if (runs) {
      runs.innerHTML = (S.runs || []).length ? '<div class="js-scroll"><table class="js-tbl"><caption class="js-sr">Recent syncs</caption><thead><tr>'
        + '<th scope="col">When</th><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Fetched</th><th scope="col">New</th><th scope="col">Updated</th>'
        + '<th scope="col">Closed</th><th scope="col">Duplicates</th><th scope="col">Quarantined</th><th scope="col">Error</th></tr></thead><tbody>'
        + S.runs.map(function (r) {
          return '<tr><td>' + esc(when(r.startedAt)) + '</td><td>' + esc(r.sourceName || r.source || '—')
            + (r.kind === 'expire' ? '<div class="js-sub">stale postings closed</div>' : '') + '</td>'
            + '<td>' + statusPill({ lastSyncStatus: r.status }) + '</td>'
            + ['fetched', 'created', 'updated', 'closed', 'duplicates', 'skipped'].map(function (k) {
              return '<td class="js-num">' + Number(r[k] || 0) + '</td>';
            }).join('')
            + '<td class="js-errcell">' + esc(r.error || '') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<div class="js-empty">No syncs recorded yet.</div>';
    }

    var quar = document.getElementById('jsQuarHost');
    if (quar) {
      quar.innerHTML = S.quarantine.length ? '<div class="js-scroll"><table class="js-tbl"><caption class="js-sr">Quarantined postings</caption><thead><tr>'
        + '<th scope="col">Source</th><th scope="col">Posting</th><th scope="col">Why</th><th scope="col">Seen</th><th scope="col">State</th></tr></thead><tbody>'
        + S.quarantine.map(function (x) {
          return '<tr><td>' + esc(x.sourceName) + '</td><td><b>' + esc(x.title || '(no title)') + '</b><div class="js-sub">'
            + esc(x.company || '') + (x.sourceJobId ? ' · <span class="js-code">' + esc(x.sourceJobId) + '</span>' : '') + '</div></td>'
            + '<td>' + (x.reasons || []).map(function (r) { return '<span class="js-pill warn">' + esc(r.replace(/_/g, ' ')) + '</span>'; }).join(' ') + '</td>'
            + '<td>' + esc(when(x.lastSeenAt)) + '<div class="js-sub">' + Number(x.timesSeen || 1) + '×</div></td>'
            + '<td>' + (x.action === 'kept'
              ? '<span class="js-pill wait" title="Recorded only - this source\'s behaviour is preserved unchanged">kept — recorded only</span>'
              : '<span class="js-pill bad">job skipped</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<div class="js-empty">Nothing in quarantine.</div>';
    }

    var urls = document.getElementById('jsUrlHost');
    if (urls) {
      urls.innerHTML = S.urlChanges.length ? '<div class="js-scroll"><table class="js-tbl"><caption class="js-sr">Link changes</caption><thead><tr>'
        + '<th scope="col">When</th><th scope="col">Job</th><th scope="col">Old link</th><th scope="col">New link</th><th scope="col">Result</th></tr></thead><tbody>'
        + S.urlChanges.map(function (u) {
          return '<tr><td>' + esc(when(u.detectedAt)) + '</td><td>' + esc(u.title) + '<div class="js-sub">' + esc(u.sourceName) + '</div></td>'
            + '<td class="js-url">' + esc(u.oldUrl || '—') + '</td><td class="js-url">' + esc(u.newUrl || '—') + '</td>'
            + '<td>' + (u.applied ? '<span class="js-pill ok">in use</span>' : '<span class="js-pill bad">refused — old link kept</span>')
            + (u.newUrlValid === false ? '<div class="js-sub">' + esc(u.validationReason || 'failed validation') + '</div>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<div class="js-empty">No link has changed.</div>';
    }

    var stats = document.getElementById('jsStatsHost');
    if (stats) {
      var t = (S.analytics && S.analytics.totals) || null;
      stats.innerHTML = t ? '<div class="js-kpis">'
        + [['external_job_view', 'Job views'], ['external_apply_click', 'Apply clicks'],
          ['external_redirect_success', 'Sent to the original site'], ['external_redirect_failure', 'Redirects refused']]
          .map(function (k) { return '<div class="js-kpi"><b>' + Number(t[k[0]] || 0) + '</b><span>' + k[1] + '</span></div>'; }).join('')
        + '</div>' : '<div class="js-empty">No analytics yet.</div>';
    }

    var audit = document.getElementById('jsAuditHost');
    if (audit) {
      audit.innerHTML = S.audit.length ? '<div class="js-scroll"><table class="js-tbl"><caption class="js-sr">Audit trail</caption><thead><tr>'
        + '<th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">What</th><th scope="col">Detail</th></tr></thead><tbody>'
        + S.audit.map(function (e) {
          return '<tr><td>' + esc(when(e.at)) + '</td><td>' + esc(e.actorRole || 'system') + '</td>'
            + '<td><span class="js-code">' + esc(e.action) + '</span></td><td>' + esc(e.entity) + ' ' + esc(e.entityId || '') + '</td>'
            + '<td class="js-sub">' + esc(auditDetail(e)) + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<div class="js-empty">No changes recorded yet.</div>';
    }
  }

  function auditDetail(e) {
    var n = e.newValue || {};
    if (/^bulk\./.test(e.action)) return n.succeeded + ' of ' + n.requested + ' done' + (n.failed ? ', ' + n.failed + ' failed' : '') + (e.reason ? ' — ' + e.reason : '');
    if (e.action === 'job.url_change' || e.action === 'job.url_change_refused') return ((e.oldValue || {}).url || '') + ' → ' + (n.url || '');
    if (e.action === 'job.update') return (n.fields || []).join(', ');
    if (/^job\.(close|reopen|status_change)$/.test(e.action)) return ((e.oldValue || {}).status || '') + ' → ' + (n.status || '');
    if (/^licence\./.test(e.action)) return (n.licence_status || '') + (n.effective_until ? ' until ' + String(n.effective_until).slice(0, 10) : '');
    if (/^alert\./.test(e.action)) return n.title || '';
    return e.reason || n.title || n.name || '';
  }

  function statusPill(s) {
    var st = String(s.lastSyncStatus || '');
    if (!st) return '<span class="js-pill wait">never synced</span>';
    if (st === 'ok') return '<span class="js-pill ok">ok</span>';
    if (st === 'manual') return '<span class="js-pill wait">manual</span>';
    if (st === 'not_configured') return '<span class="js-pill warn">not configured</span>';
    if (st === 'licence_required') return '<span class="js-pill warn">licence required</span>';
    return '<span class="js-pill bad">' + esc(st.replace(/_/g, ' ')) + '</span>';
  }

  function healthPill(h) {
    var st = (h && h.status) || 'unknown';
    var cls = st === 'healthy' ? 'ok' : st === 'unhealthy' ? 'bad' : st === 'degraded' ? 'warn' : 'wait';
    return '<span class="js-pill ' + cls + '">' + esc(st) + '</span>'
      + (h && h.consecutiveFailures ? '<div class="js-sub">' + h.consecutiveFailures + ' failed in a row</div>' : '')
      + (h && h.nextSyncAfter ? '<div class="js-sub">retry after ' + esc(new Date(h.nextSyncAfter).toLocaleString()) + '</div>' : '')
      + (h && h.lastSuccessfulSync ? '<div class="js-sub">last success ' + esc(when(h.lastSuccessfulSync)) + '</div>' : '');
  }

  function licencePill(s) {
    if (s.licenceGap) return '<span class="js-pill bad">licence required</span><div class="js-sub">' + esc(String(s.licenceGap).slice(0, 140)) + '</div>';
    if (s.licence) return '<span class="js-pill ok">' + esc(s.licence.licenceStatus) + '</span>'
      + (s.licence.effectiveUntil ? '<div class="js-sub">until ' + esc(s.licence.effectiveUntil) + '</div>' : '');
    return '<span class="js-pill wait">not required</span>';
  }

  function sourceTable() {
    return '<div class="js-scroll"><table class="js-tbl"><caption class="js-sr">Job sources</caption><thead><tr>'
      + '<th scope="col">Source</th><th scope="col">Collects via</th><th scope="col">Enabled</th><th scope="col">Configured</th>'
      + '<th scope="col">Licence</th><th scope="col">Health</th>'
      + '<th scope="col">Last sync</th><th scope="col">Jobs</th><th scope="col">Last error</th><th scope="col"><span class="js-sr">Actions</span></th>'
      + '</tr></thead><tbody>'
      + S.sources.map(function (s) {
        var busy = S.busy[s.id];
        /* A connector source's credentials are the connector's business,
           so the row asks the registry rather than guessing from the
           source row. */
        var c = S.connectors.filter(function (x) { return x.id === s.connector; })[0];
        var configured = s.collectionMethod === 'connector'
          ? (c ? c.configured : false)
          : (s.credentialConfigured !== false);
        var p = s.policy || {};

        return '<tr>'
          + '<td><b>' + esc(s.name) + '</b>'
            + '<div class="js-sub">' + esc(p.label || s.provider || '') + (s.connector ? ' · ' + esc(s.connector) : '') + '</div>'
            + (p.preserveBehaviour ? '<div class="js-sub">behaviour preserved unchanged</div>' : '')
            + '</td>'
          + '<td>' + esc(s.collectionMethod || 'manual') + '</td>'
          + '<td>' + (s.active
              ? '<span class="js-pill ok">on</span>'
              : '<span class="js-pill wait">off</span>'
                + (s.disabledReason ? '<div class="js-sub">' + esc(s.disabledReason) + '</div>' : '')) + '</td>'
          + '<td>' + (configured
              ? '<span class="js-pill ok">yes</span>'
              : '<span class="js-pill warn">no</span>'
                + (c && c.missing && c.missing.length
                    ? '<div class="js-sub">' + esc(c.missing.join(', ')) + '</div>' : ''))
            + '</td>'
          + '<td>' + licencePill(s) + '</td>'
          + '<td>' + healthPill(s.health) + '</td>'
          + '<td>' + esc(when(s.lastSyncAt)) + '<div class="js-sub">'
            + statusPill(s) + '</div></td>'
          + '<td class="js-num">' + (s.lastSyncJobCount == null ? '—' : s.lastSyncJobCount)
            + '</td>'
          /* The provider's own words, not a category. A recruiter who is
             told "failed" and nothing else cannot fix anything. */
          + '<td class="js-errcell">' + (s.lastSyncError
              ? '<span title="' + esc(s.lastSyncError) + '">'
                + esc(String(s.lastSyncError).slice(0, 90)) + '</span>'
              : '—') + '</td>'
          + '<td class="js-actions">'
            + '<button type="button" class="btn btn-sm" onclick="jsSync(&quot;' + esc(s.id) + '&quot;)"'
            + (busy ? ' disabled' : '') + '>' + (busy ? 'Syncing…' : 'Sync now') + '</button>'
            + (isAdmin() ? '<button type="button" class="btn btn-sm" onclick="jsToggle(&quot;' + esc(s.id) + '&quot;)">'
            + (s.active ? 'Disable' : 'Enable') + '</button>'
            + '<button type="button" class="btn btn-sm" aria-expanded="' + (S.editing === s.id ? 'true' : 'false') + '" onclick="jsEdit(&quot;' + esc(s.id) + '&quot;)">Licence &amp; settings</button>' : '')
            + '</td>'
          + '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function providerTable() {
    if (!S.providers.length) return '<div class="js-empty">—</div>';
    var label = {
      available: ['ok', 'available'], needs_credentials: ['warn', 'needs its API key'],
      needs_licence_record: ['warn', 'needs a licence record'],
      needs_authorized_feed_and_licence: ['bad', 'needs an authorized API/feed + licence'],
    };
    return '<div class="js-scroll"><table class="js-tbl"><caption class="js-sr">Providers</caption><thead><tr>'
      + '<th scope="col">Provider</th><th scope="col">How the data is collected</th><th scope="col">Apply links go to</th><th scope="col">Status</th></tr></thead><tbody>'
      + S.providers.map(function (p) {
        var l = label[p.status] || ['wait', p.status];
        return '<tr><td><b>' + esc(p.label) + '</b><div class="js-sub">' + esc(p.kind.replace(/_/g, ' ')) + '</div></td>'
          + '<td>' + esc(p.mechanism) + (p.termsUrl ? '<div class="js-sub"><a href="' + esc(p.termsUrl) + '" target="_blank" rel="noopener noreferrer">terms / documentation<span class="js-sr"> (opens in a new tab)</span></a></div>' : '') + '</td>'
          + '<td>' + (p.allowedDomains && p.allowedDomains.length ? esc(p.allowedDomains.join(', ')) : '<span class="js-sub">the employer\'s own site</span>') + '</td>'
          + '<td><span class="js-pill ' + l[0] + '">' + esc(l[1]) + '</span>'
          + (p.credentialsMissing && p.credentialsMissing.length ? '<div class="js-sub">missing: ' + esc(p.credentialsMissing.join(', ')) + '</div>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function connectorTable() {
    var have = {};
    S.sources.forEach(function (s) { if (s.connector) have[s.connector] = s; });

    return '<div class="js-scroll"><table class="js-tbl"><caption class="js-sr">Connectors</caption><thead><tr>'
      + '<th scope="col">Connector</th><th scope="col">Needs</th><th scope="col">Status</th><th scope="col"><span class="js-sr">Actions</span></th>'
      + '</tr></thead><tbody>'
      + S.connectors.map(function (c) {
        var added = have[c.id];
        return '<tr>'
          + '<td><b>' + esc(c.label) + '</b><div class="js-sub">' + esc(c.id) + '</div></td>'
          + '<td>' + (c.envKeys && c.envKeys.length
              ? '<code class="js-code">'
                + c.envKeys.map(esc).join('</code> <code class="js-code">') + '</code>'
              : '<span class="js-sub">nothing — public</span>') + '</td>'
          + '<td>' + (c.configured
              ? '<span class="js-pill ok">ready</span>'
              : '<span class="js-pill warn">not configured</span>')
            + (c.missing && c.missing.length
                ? '<div class="js-sub">missing: ' + esc(c.missing.join(', ')) + '</div>' : '')
            + (c.note ? '<div class="js-sub">' + esc(c.note) + '</div>' : '')
            + '</td>'
          + '<td class="js-actions">' + (added
              ? '<span class="js-sub">added as “' + esc(added.name) + '”</span>'
              : (c.configured && isAdmin()
                  ? '<button type="button" class="btn btn-sm" onclick="jsAdd(&quot;' + esc(c.id)
                    + '&quot;,&quot;' + esc(c.label) + '&quot;)">Add source</button>'
                  /* Not offered rather than offered-and-refused: adding a
                     source that cannot run just creates a red row. */
                  : '<span class="js-sub">' + (c.configured ? 'administrators add sources' : 'set its keys first') + '</span>'))
            + '</td>'
          + '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* ---- the licence & settings editor (admin) ---- */
  function paintEditor() {
    var host = document.getElementById('jsEditHost');
    if (!host) return;
    var s = S.sources.filter(function (x) { return x.id === S.editing; })[0];
    if (!s || !isAdmin()) { host.innerHTML = ''; return; }
    var l = s.licence || {};
    var p = s.policy || {};
    var opt = function (name, list, cur) {
      return '<select id="jsL_' + name + '" name="' + name + '">' + list.map(function (v) {
        return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(v.replace(/_/g, ' ')) + '</option>';
      }).join('') + '</select>';
    };
    var field = function (id, lab, input, hint) {
      return '<div class="js-f"><label for="' + id + '">' + lab + '</label>' + input + (hint ? '<div class="js-sub" id="' + id + 'Hint">' + hint + '</div>' : '') + '</div>';
    };
    host.innerHTML = '<form class="js-edit" onsubmit="return false" aria-labelledby="jsEditH">'
      + '<h3 id="jsEditH">' + esc(s.name) + ' — licence and settings</h3>'
      + '<p class="js-sub">' + esc(s.licenceRequired || '') + '. ' + esc(p.mechanism || '') + '</p>'
      + (s.licenceGap ? '<p class="js-err" role="alert">' + esc(s.licenceGap) + '</p>' : '')
      + '<fieldset><legend>Licence and consent</legend><div class="js-grid">'
      + field('jsL_collectionMethod', 'Collection method', opt('collectionMethod', ['public_api', 'licensed_api', 'partner_feed', 'employer_feed', 'manual_entry'], l.collectionMethod || (p.kind === 'partner_feed' ? 'partner_feed' : p.kind === 'keyed_api' ? 'licensed_api' : 'public_api')))
      + field('jsL_licenceStatus', 'Licence status', opt('licenceStatus', ['not_required', 'pending', 'active', 'expired', 'revoked'], l.licenceStatus || 'pending'))
      + field('jsL_consentStatus', 'Consent status', opt('consentStatus', ['not_required', 'pending', 'granted', 'withdrawn'], l.consentStatus || 'pending'))
      + field('jsL_termsUrl', 'Terms URL', '<input id="jsL_termsUrl" type="url" inputmode="url" value="' + esc(l.termsUrl || p.termsUrl || '') + '" placeholder="https://…">')
      + field('jsL_owner', 'Owner', '<input id="jsL_owner" type="text" maxlength="120" value="' + esc(l.owner || '') + '">', 'Who at TeamLink is responsible for this agreement.')
      + field('jsL_effectiveFrom', 'Effective from', '<input id="jsL_effectiveFrom" type="date" value="' + esc(l.effectiveFrom || '') + '">')
      + field('jsL_effectiveUntil', 'Effective until', '<input id="jsL_effectiveUntil" type="date" value="' + esc(l.effectiveUntil || '') + '">')
      + '<div class="js-f js-checks"><label><input id="jsL_dataUsageAllowed" type="checkbox"' + (l.dataUsageAllowed ? ' checked' : '') + '> Data usage allowed</label>'
      + '<label><input id="jsL_applicationRedirectAllowed" type="checkbox"' + (l.applicationRedirectAllowed ? ' checked' : '') + '> Application redirect allowed</label></div>'
      + field('jsL_notes', 'Notes', '<textarea id="jsL_notes" rows="2" maxlength="1000">' + esc(l.notes || '') + '</textarea>')
      + '</div><button type="button" class="btn btn-primary btn-sm" onclick="jsSaveLicence(&quot;' + esc(s.id) + '&quot;)">Save licence</button></fieldset>'
      + '<fieldset><legend>Source settings</legend><div class="js-grid">'
      + field('jsC_allowedDomains', 'Allowed apply domains', '<input id="jsC_allowedDomains" type="text" value="' + esc((s.allowedDomains || []).join(', ')) + '" placeholder="' + esc((p.allowedDomains || []).join(', ') || 'any public site') + '">', 'Comma separated. Empty = the provider default (' + esc(p.allowedDomainsSource || '') + ').')
      + field('jsC_syncIntervalHours', 'Sync every (hours)', '<input id="jsC_syncIntervalHours" type="number" min="1" max="720" value="' + esc(s.syncIntervalHours || '') + '" placeholder="' + esc(p.syncIntervalHours || '') + '">')
      + field('jsC_rateLimitPerMinute', 'Calls per minute', '<input id="jsC_rateLimitPerMinute" type="number" min="1" max="600" value="' + esc(s.rateLimitPerMinute || '') + '" placeholder="' + esc(p.rateLimitPerMinute || 'no limit') + '">')
      + field('jsC_closeGraceDays', 'Close unseen jobs after (days)', '<input id="jsC_closeGraceDays" type="number" min="1" max="365" value="' + esc(s.closeGraceDays || '') + '" placeholder="' + esc(p.closeGraceDays || '') + '">')
      + field('jsC_monthlyQuota', 'Monthly call quota', '<input id="jsC_monthlyQuota" type="number" min="1" value="' + esc(s.monthlyQuota || '') + '" placeholder="none">')
      + '</div><button type="button" class="btn btn-primary btn-sm" onclick="jsSaveConfig(&quot;' + esc(s.id) + '&quot;)">Save settings</button>'
      + ' <button type="button" class="btn btn-sm" onclick="jsEdit(null)">Close</button></fieldset></form>';
  }

  /* ---- every external job, and bulk actions ---- */
  function paintJobs() {
    var host = document.getElementById('jsJobsHost');
    if (!host) return;
    var f = S.jobFilter;
    var picked = Object.keys(S.picked).filter(function (k) { return S.picked[k]; });
    var bar = '<div class="js-filters" role="search">'
      + '<label>Status <select onchange="jsJobFilter(\'status\', this.value)">'
      + ['open', 'closed', 'removed', 'archived', 'expired', 'all'].map(function (v) {
        return '<option value="' + v + '"' + (f.status === v ? ' selected' : '') + '>' + v + '</option>';
      }).join('') + '</select></label>'
      + '<label>Source <select onchange="jsJobFilter(\'sourceId\', this.value)"><option value="">All</option>'
      + S.sources.map(function (s) { return '<option value="' + esc(s.id) + '"' + (f.sourceId === s.id ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('')
      + '</select></label>'
      + '<label>Find <input type="search" value="' + esc(f.q) + '" placeholder="title, company, id" onchange="jsJobFilter(\'q\', this.value)"></label>'
      + '<span class="js-sub" aria-live="polite">' + S.jobsTotal + ' job' + (S.jobsTotal === 1 ? '' : 's') + '</span></div>';
    var bulk = isAdmin() ? '<div class="js-bulk" role="group" aria-label="Bulk actions on the selected jobs">'
      + '<span>' + picked.length + ' selected</span>'
      + [['activate', 'Activate'], ['deactivate', 'Deactivate'], ['close', 'Close'], ['refresh', 'Refresh'], ['archive', 'Archive']]
        .map(function (a) {
          return '<button type="button" class="btn btn-sm" ' + (picked.length && !S.bulkBusy ? '' : 'disabled ')
            + 'onclick="jsBulk(\'' + a[0] + '\')">' + a[1] + '</button>';
        }).join('')
      + (S.lastBulk ? '<span role="status" class="js-sub">' + esc(S.lastBulk) + '</span>' : '')
      + '</div>' : '';
    var table = S.jobs.length ? '<div class="js-scroll"><table class="js-tbl"><caption class="js-sr">External jobs</caption><thead><tr>'
      + (isAdmin() ? '<th scope="col"><input type="checkbox" aria-label="Select all jobs on this page" onchange="jsPickAll(this.checked)"></th>' : '')
      + '<th scope="col">Title</th><th scope="col">Company</th><th scope="col">Source</th><th scope="col">Original URL</th>'
      + '<th scope="col">Status</th><th scope="col">Date collected</th><th scope="col">Last updated</th>'
      + (isAdmin() ? '<th scope="col">Job ID</th><th scope="col">Source job ID</th><th scope="col">Source company URL</th>'
        + '<th scope="col">Last synced</th><th scope="col">Last seen</th><th scope="col">Sync status</th>' : '')
      + '</tr></thead><tbody>'
      + S.jobs.map(function (j) {
        var link = function (u) {
          return u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u) + '<span class="js-sr"> (opens in a new tab)</span></a>' : '—';
        };
        return '<tr>'
          + (isAdmin() ? '<td><input type="checkbox" aria-label="Select ' + esc(j.title) + '"' + (S.picked[j.id] ? ' checked' : '')
            + ' onchange="jsPick(&quot;' + esc(j.id) + '&quot;, this.checked)"></td>' : '')
          + '<td>' + esc(j.title) + '</td><td>' + esc(j.company || '—') + '</td>'
          + '<td>' + esc(j.sourceName) + '<div class="js-sub">' + esc(j.source) + '</div></td>'
          + '<td class="js-url">' + link(j.originalJobUrl) + '</td>'
          + '<td>' + (j.active ? '<span class="js-pill ok">Active</span>' : '<span class="js-pill wait">'
            + esc(j.status === 'closed' || j.status === 'expired' ? 'Expired' : 'Unavailable') + '</span>')
          + (j.heldBy ? '<div class="js-sub">set by an administrator</div>' : '') + '</td>'
          + '<td>' + esc(day(j.createdAt)) + '</td><td>' + esc(day(j.updatedAt)) + '</td>'
          + (isAdmin() ? '<td><span class="js-code">' + esc(j.id) + '</span></td>'
            + '<td><span class="js-code">' + esc(j.sourceJobId || '') + '</span></td>'
            + '<td class="js-url">' + link(j.sourceCompanyUrl) + '</td>'
            + '<td>' + esc(when(j.lastSyncedAt)) + '</td><td>' + esc(when(j.lastSeenAt)) + '</td>'
            + '<td>' + statusPill({ lastSyncStatus: j.syncStatus }) + '</td>' : '')
          + '</tr>';
      }).join('') + '</tbody></table></div>'
      : '<div class="js-empty">No external jobs match.</div>';
    var pages = S.jobsTotal > f.limit ? '<div class="js-pager">'
      + '<button type="button" class="btn btn-sm" ' + (f.offset ? '' : 'disabled ') + 'onclick="jsJobPage(-1)">Previous</button>'
      + '<span class="js-sub">' + (f.offset + 1) + '–' + Math.min(f.offset + f.limit, S.jobsTotal) + ' of ' + S.jobsTotal + '</span>'
      + '<button type="button" class="btn btn-sm" ' + (f.offset + f.limit < S.jobsTotal ? '' : 'disabled ') + 'onclick="jsJobPage(1)">Next</button></div>' : '';
    host.innerHTML = bar + bulk + table + pages;
  }

  /* ------------------------------------------------------------------ *
   * actions
   * ------------------------------------------------------------------ */
  window.jsSync = function (id) {
    var a = api();
    if (!a) return;
    S.busy[id] = true; paint();
    a.post('/external/sources/' + encodeURIComponent(id) + '/sync', {}).then(function (out) {
      S.busy[id] = false;
      /* What it actually did, not "done". A sync that saved nothing
         because the source is not configured is a different outcome from
         one that saved nothing because there was nothing new. */
      if (out.status === 'ok' || out.status === 'partial') {
        toast(out.saved + ' job(s) collected'
          + (out.skipped ? ', ' + out.skipped + ' skipped' : '')
          + (out.quarantined ? ' (in quarantine)' : ''), '✅');
      } else if (out.status === 'not_configured') {
        toast('Not configured: ' + (out.error || 'credentials are missing'), '⚠️');
      } else if (out.status === 'licence_required') {
        toast('Sync refused — licence required: ' + (out.error || ''), '⚠️');
      } else if (out.status === 'manual') {
        toast('This source is entered by hand — there is nothing to sync', 'i');
      } else if (out.status === 'empty') {
        toast('Source unavailable: it returned no jobs. The jobs already held are kept.', '⚠️');
      } else {
        toast('Sync failed: ' + (out.error || out.status), '⚠️');
      }
      load();
    }, function (e) {
      S.busy[id] = false;
      toast((e && e.message) || 'The sync could not be started', '⚠️');
      paint();
    });
  };

  window.jsToggle = function (id) {
    var a = api();
    var s = S.sources.filter(function (x) { return x.id === id; })[0];
    if (!a || !s) return;
    if (s.active) {
      var reason = window.prompt('Why is ' + s.name + ' being switched off? (kept with its history)', 'Paused by an administrator');
      if (reason == null) return;
      a.post('/external/sources/' + encodeURIComponent(id) + '/disable', { reason: reason || 'Paused by an administrator' })
        .then(function () { toast('Disabled — it will not sync again. Its jobs and history are kept.', '✅'); load(); },
          function (e) { toast((e && e.message) || 'Could not change that', '⚠️'); });
      return;
    }
    a.post('/external/sources', {
      id: s.id, name: s.name, sourceType: s.sourceType,
      collectionMethod: s.collectionMethod, connector: s.connector || undefined,
      applicationMethod: s.applicationMethod,
      feedUrl: s.feedUrl || undefined,
      active: true,
    }).then(function () {
      toast('Enabled', '✅');
      load();
    }, function (e) {
      /* The licence guard's own words: what is missing, exactly. */
      toast((e && e.message) || 'Could not change that', '⚠️');
      if (e && e.code === 'LICENCE_REQUIRED') { S.editing = id; paint(); }
    });
  };

  window.jsAdd = function (connector, label) {
    var a = api();
    if (!a) return;
    a.post('/external/sources', {
      name: label, sourceType: 'job_board', collectionMethod: 'connector',
      connector: connector, applicationMethod: 'redirect', active: true,
    }).then(function () {
      toast(label + ' added — press Sync now to collect', '✅');
      load();
    }, function (e) {
      if (e && e.code === 'LICENCE_REQUIRED') {
        /* Added switched off, so its licence can be recorded first. */
        a.post('/external/sources', { name: label, sourceType: 'job_board', collectionMethod: 'connector',
          connector: connector, applicationMethod: 'redirect', active: false }).then(function (out) {
          toast(label + ' added, switched off: record its licence to enable it', 'i');
          S.editing = out && out.source && out.source.id; load();
        }, function (e2) { toast((e2 && e2.message) || 'Could not add that source', '⚠️'); });
        return;
      }
      toast((e && e.message) || 'Could not add that source', '⚠️');
    });
  };

  window.jsEdit = function (id) { S.editing = id || null; paint(); var f = document.getElementById('jsL_collectionMethod'); if (f) f.focus(); };

  var val = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
  var checked = function (id) { var el = document.getElementById(id); return !!(el && el.checked); };
  var intOrNull = function (id) { var v = val(id).trim(); return v ? parseInt(v, 10) : null; };

  window.jsSaveLicence = function (id) {
    var a = api();
    if (!a) return;
    a.put('/external/sources/' + encodeURIComponent(id) + '/licence', {
      collectionMethod: val('jsL_collectionMethod'), licenceStatus: val('jsL_licenceStatus'),
      consentStatus: val('jsL_consentStatus'), termsUrl: val('jsL_termsUrl').trim() || null,
      owner: val('jsL_owner').trim() || null, effectiveFrom: val('jsL_effectiveFrom') || null,
      effectiveUntil: val('jsL_effectiveUntil') || null, notes: val('jsL_notes').trim() || null,
      dataUsageAllowed: checked('jsL_dataUsageAllowed'), applicationRedirectAllowed: checked('jsL_applicationRedirectAllowed'),
    }).then(function (out) {
      toast(out.licenceGap ? 'Licence saved — still missing: ' + out.licenceGap : 'Licence saved — this source can be switched on', out.licenceGap ? '⚠️' : '✅');
      load();
    }, function (e) { toast((e && e.message) || 'Could not save the licence', '⚠️'); });
  };

  window.jsSaveConfig = function (id) {
    var a = api();
    if (!a) return;
    a.put('/external/sources/' + encodeURIComponent(id) + '/config', {
      allowedDomains: val('jsC_allowedDomains'), syncIntervalHours: intOrNull('jsC_syncIntervalHours'),
      rateLimitPerMinute: intOrNull('jsC_rateLimitPerMinute'), closeGraceDays: intOrNull('jsC_closeGraceDays'),
      monthlyQuota: intOrNull('jsC_monthlyQuota'),
    }).then(function () { toast('Settings saved', '✅'); load(); },
      function (e) { toast((e && e.message) || 'Could not save the settings', '⚠️'); });
  };

  window.jsJobFilter = function (k, v) { S.jobFilter[k] = v; S.jobFilter.offset = 0; S.picked = {}; loadJobs(); };
  window.jsJobPage = function (d) {
    var f = S.jobFilter;
    f.offset = Math.max(0, f.offset + d * f.limit);
    S.picked = {};
    loadJobs();
  };
  window.jsPick = function (id, on) { S.picked[id] = !!on; paintJobs(); };
  window.jsPickAll = function (on) { S.jobs.forEach(function (j) { S.picked[j.id] = !!on; }); paintJobs(); };

  window.jsBulk = function (action) {
    var a = api();
    var ids = Object.keys(S.picked).filter(function (k) { return S.picked[k]; });
    if (!a || !ids.length) return;
    var words = { activate: 'reopen', deactivate: 'hide', close: 'close', refresh: 're-sync the sources of', archive: 'archive' };
    /* Confirmed by a person, then confirmed again by the server. */
    var reason = window.prompt('This will ' + words[action] + ' ' + ids.length + ' external job(s). '
      + 'Give a reason to continue (it goes into the audit trail):', '');
    if (reason == null) return;
    S.bulkBusy = true; paintJobs();
    a.post('/external/admin/jobs/bulk', { action: action, ids: ids, reason: reason || undefined, confirm: true })
      .then(function (out) {
        S.bulkBusy = false;
        S.picked = {};
        var failed = (out.results || []).filter(function (r) { return !r.ok; });
        S.lastBulk = out.succeeded + ' succeeded, ' + out.failed + ' failed'
          + (failed.length ? ' — ' + failed.slice(0, 3).map(function (r) { return r.reason; }).join('; ') : '');
        toast(S.lastBulk, out.failed ? '⚠️' : '✅');
        load();
      }, function (e) {
        S.bulkBusy = false;
        toast((e && e.message) || 'The bulk action was refused', '⚠️');
        paintJobs();
      });
  };

  /* ------------------------------------------------------------------ *
   * slotting it in
   * ------------------------------------------------------------------ */
  (function hook() {
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (tries > 60) { clearInterval(timer); return; }
      if (typeof window.pageAdminDash !== 'function') return;
      clearInterval(timer);

      /*
       * One nav entry, appended. Nothing is reordered.
       *
       * NAV_CONFIG is declared with a top-level `const`, which lives in
       * the global LEXICAL scope rather than on `window` - so it is
       * reachable by name from this file and invisible to
       * `window.NAV_CONFIG`. Guarded either way: a missing nav costs the
       * menu entry, not the screen, which stays reachable by URL.
       */
      try {
        var nav = (typeof NAV_CONFIG !== 'undefined' && NAV_CONFIG.admin) || null;
        if (nav && !nav.some(function (n) { return n[0] === 'job-sources'; })) {
          nav.push(['job-sources', 'Job Sources', '🌐']);
        }
      } catch (e) { /* the screen is still reachable by URL */ }

      /* Recruiters: the list of external jobs only - no sources, no
         licences, no configuration (all of that is the admin screen). */
      try {
        var rnav = (typeof NAV_CONFIG !== 'undefined' && NAV_CONFIG.recruiter) || null;
        if (rnav && !rnav.some(function (n) { return n[0] === 'external-jobs'; })) {
          rnav.push(['external-jobs', 'External Jobs', '🌐']);
        }
      } catch (e) { /* reachable by URL */ }
      var prevR = window.pageRecruiterDash;
      if (typeof prevR === 'function' && !prevR.__js) {
        var r2 = function (section) {
          if (section !== 'external-jobs') return prevR.apply(this, arguments);
          setTimeout(function () { S.jobFilter.status = 'open'; loadJobs(); }, 0);
          var body = '<section class="panel" aria-labelledby="jsJobsHostH"><div class="panel-head"><div>'
            + '<h2 id="jsJobsHostH">External jobs</h2><div class="desc">Jobs collected from other job sites and shown in '
            + 'the portal. Candidates apply on the original website; nothing here is a TeamLink application.</div>'
            + '</div></div><div class="panel-body"><div id="jsJobsHost"><div class="js-empty" role="status">Loading…</div></div></div></section>';
          return (typeof window.dashShell === 'function')
            ? window.dashShell('recruiter', 'external-jobs', 'External Jobs', 'Recruiter · External jobs', body) : body;
        };
        r2.__js = true;
        window.pageRecruiterDash = r2;
      }

      var prev = window.pageAdminDash;
      window.pageAdminDash = function (section) {
        if (section !== 'job-sources') return prev.apply(this, arguments);
        return (typeof window.dashShell === 'function')
          ? window.dashShell('admin', 'job-sources', 'Job Sources',
              'Admin · TeamLink Platform', page())
          : page();
      };
    }, 400);
  })();

  /* ------------------------------------------------------------------ *
   * styles
   * ------------------------------------------------------------------ */
  var css = ''
    + '.js-tbl{width:100%;border-collapse:collapse;font-size:12.5px}'
    + '.js-tbl th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;'
      + 'color:var(--text-soft,#5f6b7c);padding:7px 8px;border-bottom:1px solid var(--line,#e6ebf2)}'
    + '.js-tbl td{padding:10px 8px;border-bottom:1px solid var(--line-soft,#f1f4f8);'
      + 'vertical-align:top}'
    + '.js-scroll{overflow-x:auto}'
    + '.js-sub{font-size:11px;color:var(--text-soft,#5f6b7c);margin-top:3px}'
    + '.js-num{font-variant-numeric:tabular-nums}'
    + '.js-errcell{max-width:230px;color:#a3201a;font-size:11.5px}'
    + '.js-url{max-width:240px;word-break:break-all}'
    + '.js-actions{white-space:nowrap;display:flex;gap:6px;flex-wrap:wrap}'
    + '.js-pill{display:inline-block;border-radius:999px;padding:2px 9px;font-size:10.5px;'
      + 'font-weight:800}'
    + '.js-pill.ok{background:#e8f6ee;color:#17663a}'
    + '.js-pill.warn{background:#fdf3dc;color:#7a4d0d}'
    + '.js-pill.bad{background:#fdeaea;color:#a3201a}'
    + '.js-pill.wait{background:#eef2f7;color:#4b5a70}'
    + '.js-code{background:#f1f5f9;border-radius:5px;padding:1px 6px;font-size:11px;'
      + 'color:#334155}'
    + '.js-empty{padding:30px 6px;text-align:center;color:var(--text-soft,#5f6b7c);'
      + 'font-size:13.5px}'
    + '.js-empty b{display:block;color:var(--text,#16202c);font-size:15px;margin-bottom:4px}'
    + '.js-err{padding:14px;border:1px solid #f0c27a;background:#fff9ee;border-radius:9px;'
      + 'color:#7a4d0d;font-size:12.5px}'
    + '.js-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}'
    + '.js-filters,.js-bulk,.js-pager{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 10px;font-size:12.5px}'
    + '.js-filters label{display:flex;gap:6px;align-items:center}'
    + '.js-bulk{background:#f6f8fb;border-radius:9px;padding:8px 10px}'
    + '.js-kpis{display:flex;gap:12px;flex-wrap:wrap}.js-kpi{background:#f6f8fb;border-radius:10px;padding:10px 14px;min-width:150px}'
    + '.js-kpi b{display:block;font-size:20px}.js-kpi span{font-size:12px;color:#4b5a70}'
    + '.js-edit{margin-top:14px;border-top:1px solid var(--line,#e6ebf2);padding-top:12px}'
    + '.js-edit h3{font-size:15px;margin:0 0 4px}.js-edit fieldset{border:1px solid var(--line,#e6ebf2);border-radius:10px;padding:10px 12px;margin:10px 0}'
    + '.js-edit legend{font-weight:800;font-size:12.5px;padding:0 4px}'
    + '.js-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-bottom:10px}'
    + '.js-f label{display:block;font-size:11.5px;font-weight:700;margin-bottom:3px}.js-f input,.js-f select,.js-f textarea{width:100%;box-sizing:border-box}'
    + '.js-checks label{font-weight:600;display:flex;gap:6px;align-items:center;margin-top:4px}'
    + '#jsHost button:focus-visible,#jsJobsHost button:focus-visible,#jsJobsHost input:focus-visible,.js-edit :focus-visible{outline:3px solid #1d6ff2;outline-offset:2px}'
    + '@media (max-width:760px){.js-tbl,.js-tbl tbody,.js-tbl tr,.js-tbl td{display:block}'
      + '.js-tbl thead{display:none}.js-tbl td{border:0;padding:4px 8px}'
      + '.js-tbl tr{border-bottom:1px solid var(--line,#e6ebf2);padding:10px 0}}';

  var tag = document.createElement('style');
  tag.id = 'js-sources-css';
  tag.textContent = css;
  (document.head || document.documentElement).appendChild(tag);
})();
