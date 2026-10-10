/*
 * Walk-in is a JOB TYPE (0106) - every screen that shows it.
 *
 *   Jobs        the same cards and the same job page, with a small
 *               "Walk-in Interview" badge, the date and the venue; a
 *               walk-in whose date and end time have passed (IST) shows
 *               Closed, its Apply button is disabled, and it leaves the
 *               candidates' default listing (staff still see it); a full
 *               one says "Registrations full".
 *   Apply Now   ONE application form for every TeamLink job, in the
 *               portal's own modal (fcrModal): prefilled from the profile,
 *               editable, the resume on file with Replace, the job's
 *               title / ID / type read-only, the walk-in details for a
 *               walk-in, the job's screening questions as a section of the
 *               same form (TLScreening), the resume-score tip as one line,
 *               a draft kept on this device per candidate and job, full
 *               checks, one submission, and an honest result: the
 *               Application ID, or the reason it was not saved. External
 *               jobs keep their own flow; a signed-out candidate goes
 *               through registration / login (teamlink-apply-auth.js) and
 *               comes back to this form for the same job.
 *   Recruiter   Job Type (Regular / Walk-in) on AI Job Creation and Edit,
 *               the walk-in fields with their checks, the Post A Walk-in
 *               Job form brought up to the same fields, and Clone Job.
 *
 * The browser decides nothing for good: POST /api/applications/form and
 * /api/jobs check everything again (api/src/routes/apply-form.js,
 * api/src/portal/walkin-jobs.js).
 *
 * Wrappers, installed once, each calling the function it replaces:
 *   DATA.openJobs, applyToJob, easyApply, cpEasyApply, fcrRegisterPosting,
 *   publishGeneratedJob, saveEditJob, tnavWalkinModal, tnavWalkinSubmit.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__tlWalkinJobs) return;
  window.__tlWalkinJobs = true;

  /* ================================================================ *
   * small things
   * ================================================================ */
  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function say(msg, icon) { if (typeof window.toast === 'function') window.toast(msg, icon); }
  function api() { return window.TL && TL.api; }
  function ready() { return !!(window.TL && TL.ready === true && TL.api); }
  function session() { return (typeof STATE !== 'undefined' && STATE.session) || null; }
  function role() { var s = session(); return s ? s.role : null; }
  function isCandidate() { return role() === 'candidate'; }
  function isStaff() { var r = role(); return r === 'recruiter' || r === 'admin' || r === 'bde' || r === 'client'; }
  function jobOf(id) { try { return DATA.jobById ? DATA.jobById(id) : null; } catch (e) { return null; } }
  function me() { try { return isCandidate() ? DATA.candidateById(STATE.session.id) : null; } catch (e) { return null; } }
  function isExternal(id) { return /^xjob_/.test(String(id || '')); }
  function rerender() { if (typeof window.render === 'function') window.render(); }
  function val(id) { var el = document.getElementById(id); return el ? String(el.value == null ? '' : el.value).trim() : ''; }

  /* ---- dates, in India ---- */
  var IST = 330 * 60 * 1000;
  function istToday() { return new Date(Date.now() + IST).toISOString().slice(0, 10); }
  function isoDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim()); }
  function hhmm(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || '').trim()); }
  function instant(date, t, dflt) {
    if (!isoDate(date)) return null;
    var tt = /^\d{1,2}:\d{2}/.test(String(t || '').trim()) ? String(t).trim().slice(0, 5) : dflt;
    if (tt.length === 4) tt = '0' + tt;
    var at = Date.parse(String(date).trim() + 'T' + tt + ':00+05:30');
    return isFinite(at) ? at : null;
  }
  function time12(t) {
    var m = /^(\d{1,2}):(\d{2})/.exec(String(t || '').trim());
    if (!m) return String(t || '').trim();
    var hr = Number(m[1]);
    return (hr % 12 || 12) + ':' + m[2] + ' ' + (hr >= 12 ? 'PM' : 'AM');
  }
  function dateLabel(d) {
    var s = String(d || '').trim();
    if (!isoDate(s)) return s;
    var p = s.split('-').map(Number);
    var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    if (isNaN(dt.getTime())) return s;
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getUTCDay()] + ', ' + p[2] + ' '
      + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][p[1] - 1] + ' ' + p[0];
  }
  function timeRange(a, b) { return [time12(a), time12(b)].filter(Boolean).join(' – '); }

  /* ---- what a walk-in is, read from the job's own record ---- */
  function isWalkin(job) {
    return !!job && (job.jobType === 'walk-in' || job.postingKind === 'walkin');
  }
  function wk(job) {
    job = job || {};
    var docs = job.walkinDocumentsToCarry != null ? job.walkinDocumentsToCarry : job.walkinDocuments;
    return {
      date: job.walkinDate || '',
      from: job.walkinStartTime || job.walkinFrom || '',
      to: job.walkinEndTime || job.walkinTo || '',
      venue: job.walkinVenue || '',
      address: job.walkinAddress || '',
      map: job.walkinMapLink || '',
      contact: job.walkinContactPerson || job.walkinContact || '',
      phone: job.walkinContactNumber || job.walkinPhone || '',
      docs: String(docs || '').split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean),
      instructions: job.walkinInstructions || '',
      capacity: job.walkinSlotCapacity != null && job.walkinSlotCapacity !== '' ? Number(job.walkinSlotCapacity) : null,
      designation: job.walkinContactDesignation || '',
      /* 0139: whether the AI interview is part of this walk-in, and the final score that makes an applicant eligible */
      aiRequired: job.walkinAiRequired !== false,
      threshold: job.walkinAiThreshold != null && job.walkinAiThreshold !== '' ? Number(job.walkinAiThreshold) : 50,
    };
  }
  function endsAt(job) { var w = wk(job); return instant(w.date, w.to, '23:59'); }
  function walkinClosed(job) {
    if (!isWalkin(job)) return false;
    if (job.status === 'closed' || job.status === 'draft' || job.paused || job.archived) return true;
    if (job.walkinStatus === 'closed') return true;
    var e = endsAt(job);
    return e != null && Date.now() > e;
  }
  /* 0137: closed BECAUSE ITS DATES ARE OVER (the server's walkinStatus reads typed dates too), as
     opposed to a recruiter closing or pausing it - the candidate is told which. */
  function walkinDatesOver(job) {
    if (!isWalkin(job)) return false;
    if (job.status === 'closed' || job.status === 'draft' || job.paused || job.archived) return false;
    return walkinClosed(job);
  }
  function datesOverText(job) {
    var d = dateLabel(wk(job).date);
    return 'The dates for this walk-in' + (d ? ' (' + d + ')' : '') + ' are completed, so applications are closed.';
  }
  function walkinFull(job) {
    return isWalkin(job) && (job.walkinFull === true || job.walkinSlotsLeft === 0);
  }
  function safeUrl(u) { return /^https:\/\/\S+$/i.test(String(u || '').trim()) ? String(u).trim() : ''; }
  /* 0139: the same rule as the server (api/src/portal/walkin-jobs.js isGoogleMapsUrl) - the venue QR opens this link */
  function isGoogleMaps(u) {
    var url;
    try { url = new URL(String(u || '').trim()); } catch (e) { return false; }
    if (url.protocol !== 'https:') return false;
    var host = url.hostname.toLowerCase(), path = url.pathname.toLowerCase();
    if (host === 'maps.app.goo.gl') return path.length > 1;
    if (host === 'goo.gl') return path.indexOf('/maps') === 0;
    if (/^maps\.google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(host)) return true;
    if (/^(?:www\.)?google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(host)) return path.indexOf('/maps') === 0 || url.searchParams.has('cid');
    return false;
  }

  /* 0139: THE VENUE QR CODE - it encodes the saved Google Maps link itself (scanning opens that venue in
     Google Maps), drawn with the same library the walk-in ATS uses for the Application ID QR. A missing or
     non-Google link gets a sentence, never a QR code that would open somewhere else. */
  var QR_SRC = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
  var qrLib = null;
  function loadQr() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    if (qrLib) return qrLib;
    qrLib = new Promise(function (ok, bad) {
      var sc = document.createElement('script');
      sc.src = QR_SRC; sc.async = true; sc.crossOrigin = 'anonymous';
      sc.onload = function () { window.qrcode ? ok(window.qrcode) : bad(new Error('no qrcode')); };
      sc.onerror = function () { qrLib = null; bad(new Error('QR library unavailable')); };
      document.head.appendChild(sc);
    });
    return qrLib;
  }
  function paintMapQrs() {
    var els = document.querySelectorAll('[data-tlwk-qr]:not([data-done])');
    Array.prototype.forEach.call(els, function (el) {
      el.setAttribute('data-done', '1');
      var url = el.getAttribute('data-tlwk-qr');
      if (!isGoogleMaps(url)) { el.remove(); return; }
      loadQr().then(function (qrcode) {
        var q = qrcode(0, 'M'); q.addData(url); q.make();
        el.innerHTML = '<img alt="QR code: the venue in Google Maps" src="' + q.createDataURL(4, 2) + '">'
          + '<span>Scan to open the venue in Google Maps</span>';
      }, function () { el.innerHTML = '<span>QR code unavailable - use View on Map</span>'; });
    });
  }
  function mapQrHtml(job) {
    var m = String(wk(job).map || '').trim();
    if (!m) return '<div class="tlwk-qrnote">No Google Maps link was given for this venue.</div>';
    if (!isGoogleMaps(m)) return '<div class="tlwk-qrnote">The map link for this venue is not a Google Maps link, so no QR code is shown.</div>';
    return '<div class="tlwk-qr" data-tlwk-qr="' + h(m) + '"></div>';
  }

  /* The walk-in block, in the job page, the form and the success screen. */
  function walkinLines(job) {
    var w = wk(job);
    var rows = [
      ['Date', dateLabel(w.date)],
      ['Time', timeRange(w.from, w.to)],
      ['Venue', w.venue],
      ['Address', w.address],
      ['Contact', [w.contact + (w.contact && w.designation ? ', ' + w.designation : ''), w.phone ? '(' + w.phone + ')' : ''].filter(Boolean).join(' ')],
      ['Documents to carry', w.docs.join(', ')],
      ['Instructions', w.instructions],
    ];
    return rows.filter(function (r) { return r[1] && String(r[1]).trim(); });
  }
  function walkinBlockHtml(job, opts) {
    opts = opts || {};
    var lines = walkinLines(job);
    var keep = opts.only ? lines.filter(function (r) { return opts.only.indexOf(r[0]) >= 0; }) : lines;
    var map = safeUrl(wk(job).map);
    return '<div class="tlwk-box">'
      + (opts.title === '' ? '' : '<div class="tlwk-box-h">🚶 ' + h(opts.title || 'Walk-in Interview') + '</div>')
      + keep.map(function (r) { return '<div class="tlwk-kv"><span class="k">' + h(r[0]) + '</span><span class="v">' + h(r[1]) + '</span></div>'; }).join('')
      + ((map || opts.calendar) ? '<div class="tlwk-acts">'
        + (map ? '<a class="btn btn-ghost btn-sm" href="' + h(map) + '" target="_blank" rel="noopener noreferrer">📍 View on Map</a>' : '')
        + (opts.calendar || '') + '</div>' : '')
      + (opts.qr === false ? '' : mapQrHtml(job))
      + '</div>';
  }

  /* ================================================================ *
   * styles
   * ================================================================ */
  (function css() {
    if (document.getElementById('tlwkCss')) return;
    var s = document.createElement('style');
    s.id = 'tlwkCss';
    s.textContent = [
      '.tlwk-b{white-space:nowrap}',
      '.tlwk-lines{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px;font-size:12.5px;color:#33404f}',
      '.tlwk-lines b{font-weight:700;color:#42505f}',
      '.tlwk-cardline{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:7px;font-size:12px;color:#42505f}',
      '.tlwk-box{background:#eef8fb;border:1px solid #bfe3ee;border-radius:10px;padding:12px 14px;margin:0 0 14px}',
      '.tlwk-box-h{font-weight:800;font-size:14px;color:#0f5f78;margin-bottom:6px}',
      '.tlwk-qr{display:flex;align-items:center;gap:10px;margin-top:10px;font-size:12px;color:#42505f}',
      '.tlwk-qr img{width:112px;height:112px;border:1px solid #bfe3ee;border-radius:8px;background:#fff;padding:4px}',
      '.tlwk-qrnote{margin-top:8px;font-size:12px;color:#7a8798}',
      '.tlaf-facts{text-align:left;margin:12px auto 4px;max-width:440px;border:1px solid #e6ebf2;border-radius:10px;padding:8px 12px}',
      '.tlaf-facts div{display:flex;justify-content:space-between;gap:12px;padding:4px 0;font-size:13px;border-bottom:1px dashed #eef1f5}',
      '.tlaf-facts div:last-child{border-bottom:0}',
      '.tlaf-facts span{color:#7a8798}',
      '.tlaf-facts b{color:#16202c;text-align:right}',
      '.tlwk-kv{display:flex;gap:10px;font-size:13px;line-height:1.5;padding:2px 0}',
      '.tlwk-kv .k{flex:0 0 132px;color:#4b6470;font-weight:600}',
      '.tlwk-kv .v{color:#16323d;white-space:pre-line;word-break:break-word}',
      '.tlwk-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:9px}',
      '.tlwk-acts .btn{text-decoration:none}',
      '.tlaf .fcr-jd-row{margin:12px 0}',
      '.tlaf .fcr-jd-row>div{min-width:0}',
      '.tlaf input[type=tel],.tlaf input[type=email],.tlaf input[type=number],.tlaf input[type=file]{width:100%;box-sizing:border-box;border:1px solid #cfd6e0;border-radius:6px;height:40px;padding:4px 12px;font-size:13.5px;color:#33465c;background:#fff;outline:none}',
      '.tlaf input[type=file]{height:auto;padding:8px}',
      '.tlaf input[readonly]{background:#f2f4f7;color:#42546b}',
      '.tlaf input:focus{border-color:var(--brand-500,#1490b3)}',
      '.tlaf-err{color:#c62828;font-size:12px;margin-top:4px;min-height:0}',
      '.tlaf-err:empty{display:none}',
      '.tlaf-sec{font-size:11.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#5b6e84;margin:18px 0 2px;border-top:1px solid #e8edf3;padding-top:12px}',
      '.tlaf-sec:first-child{border-top:0;padding-top:0;margin-top:0}',
      '.tlaf-resume{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13.5px;color:#243852}',
      '.tlaf-hint{background:#fff7e6;border:1px solid #f3d9a4;color:#6b4d0f;border-radius:8px;padding:9px 12px;font-size:12.5px;margin:0 0 12px}',
      '.tlaf-hint a{color:#6941c6;font-weight:700;cursor:pointer}',
      '.tlaf-msg{font-size:13px;border-radius:8px;margin:12px 0 0}',
      '.tlaf-msg:not(:empty){padding:10px 12px;background:#fdecec;color:#9b1c1c;border:1px solid #f5c2c2}',
      '.tlaf-hp{position:absolute!important;left:-10000px!important;top:auto!important;width:1px!important;height:1px!important;overflow:hidden!important}',
      '.tlaf-done{text-align:center;padding:26px 24px 8px}',
      '.tlaf-done .tick{width:60px;height:60px;border-radius:50%;background:var(--ok-100,#e3f6ea);color:var(--ok-600,#1d7a45);display:flex;align-items:center;justify-content:center;font-size:28px;margin:0 auto 12px}',
      '.tlaf-done .tick.info{background:#e7f0ff;color:#1b4f9e}',
      '.tlaf-done h3{font-size:19px;margin:0 0 6px;color:#16202c}',
      '.tlaf-done p{margin:4px 0;color:#5b6678;font-size:13.5px}',
      '.tlaf-done .ref{display:inline-block;font-family:var(--font-mono,monospace);font-weight:800;font-size:17px;color:#16202c;background:#f2f4f7;border-radius:8px;padding:6px 12px;margin:6px 0 10px}',
      '.tlaf-done .tlwk-box{text-align:left;margin:14px 0 4px}',
      '.tlaf-qs{margin-top:4px}',
      '.tlwk-form .tlwk-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 14px}',
      '.tlwk-form .fgroup{min-width:0}',
      '.tlwk-form .fgroup input,.tlwk-form .fgroup textarea{width:100%;box-sizing:border-box;min-width:0}',
      '.tlwk-form .tlwk-grid .full{grid-column:1/-1}',
      '.tlwk-form textarea{padding:10px 12px;border-radius:8px;border:1px solid var(--line,#cfd6e0);background:var(--card,#fff);color:var(--text,#33465c);font-size:13px;font-family:var(--font-body,inherit);resize:vertical;width:100%;box-sizing:border-box}',
      '.tlwk-type{display:flex;gap:16px;flex-wrap:wrap;font-size:13.5px;font-weight:600;color:var(--text,#243852)}',
      '.tlwk-type label{display:flex;gap:6px;align-items:center;cursor:pointer;font-weight:600}',
      '.tlwk-ferr{color:var(--bad-600,#d4342c);font-size:11.5px;min-height:0}',
      '.tlwk-ferr:empty{display:none}',
      '.tlwk-tw input[type=date],.tlwk-tw input[type=time],.tlwk-tw input[type=url],.tlwk-tw input[type=number],.tlwk-tw input[type=tel]{width:100%;border:1px solid #cfd6e0;border-radius:6px;height:40px;padding:4px 12px;font-size:13.5px;color:#33465c;background:#fff;outline:none;box-sizing:border-box}',
      '.tlwk-tw textarea{width:100%;border:1px solid #cfd6e0;border-radius:6px;padding:8px 12px;font-size:13.5px;color:#33465c;background:#fff;outline:none;box-sizing:border-box;font-family:inherit;resize:vertical}',
      '@media (max-width:640px){.tlwk-kv{flex-direction:column;gap:0}.tlwk-kv .k{flex:none}.tlwk-form .tlwk-grid{grid-template-columns:1fr}}',
    ].join('\n');
    document.head.appendChild(s);
  })();

  /* ================================================================ *
   * 1. the default listing: a finished walk-in is not offered
   *    (staff screens keep seeing it - they read DATA.jobs / jobsFor)
   * ================================================================ */
  (function wrapOpenJobs() {
    if (typeof DATA === 'undefined' || typeof DATA.openJobs !== 'function' || DATA.openJobs.__tlwk) return;
    var prev = DATA.openJobs;
    var next = function () {
      var list = prev.apply(this, arguments);
      if (isStaff()) return list;
      return list.filter(function (j) { return !(isWalkin(j) && walkinClosed(j)); });
    };
    next.__tlwk = true;
    DATA.openJobs = next;
  })();

  /* ================================================================ *
   * 2. cards, the job page, the recruiter's tables
   * ================================================================ */
  var ID_RE = /(?:navigate\('\/job\/|capApply\('|rjApplyJob\('|cpEasyApply\('|easyApply\('|applyToJob\('|toggleSaveJob\(')([A-Za-z0-9_\-]+)'/;
  var CARDS = '.job-card,.job-row,.rj-card,.cap-jobc,.cp-card';
  var BADGE = '<span class="badge badge-brand tlwk-b" title="Walk-in interview: meet the recruiter in person">🚶 Walk-in Interview</span>';

  function whenShort(job) {
    var w = wk(job);
    var d = dateLabel(w.date);
    var t = timeRange(w.from, w.to);
    return [d, t].filter(Boolean).join(' · ');
  }
  function disableApply(root, label) {
    Array.prototype.forEach.call(root.querySelectorAll('button'), function (b) {
      var t = String(b.textContent || '');
      if (/apply/i.test(t) && !/applied|filters?/i.test(t) && !b.closest('.tlpu-strip')) {
        b.disabled = true;
        b.textContent = label;
        b.removeAttribute('onclick');
        b.setAttribute('data-tlwk-off', '1');
      }
    });
  }
  function decorateCard(el) {
    if (el.getAttribute('data-tlwk')) return;
    var m = ID_RE.exec(el.innerHTML);
    if (!m) return;
    var id = m[1];
    el.setAttribute('data-tlwk', id);
    if (isExternal(id)) return;
    var job = jobOf(id);
    if (!isWalkin(job)) return;
    var closed = walkinClosed(job);
    var full = !closed && walkinFull(job);
    var over = closed && walkinDatesOver(job);
    var flag = closed ? '<span class="badge badge-bad">' + (over ? 'Walk-in completed' : 'Closed') + '</span>' : full ? '<span class="badge badge-warn">Registrations full</span>' : '';
    /* The badge, then Date / Time / Venue - from the job's own record. */
    var w = wk(job);
    var lines = [['📅', 'Date', dateLabel(w.date)], ['🕒', 'Time', timeRange(w.from, w.to)], ['📍', 'Venue', w.venue]]
      .filter(function (x) { return x[2]; })
      .map(function (x) { return '<span>' + x[0] + ' <b>' + x[1] + ':</b> ' + h(x[2]) + '</span>'; }).join('');
    var linesHtml = lines ? '<div class="tlwk-lines">' + lines + '</div>' : '';
    var badges = el.querySelector('.jc-badges');
    if (badges) {
      badges.insertAdjacentHTML('afterbegin', BADGE + flag);
      if (linesHtml) badges.insertAdjacentHTML('afterend', linesHtml);
    } else {
      var line = '<div class="tlwk-cardline">' + BADGE + flag + '</div>' + linesHtml;
      var anchor = el.querySelector('.rj-c') || el.querySelector('.co-name');
      if (!anchor) {
        var t = el.querySelector('h3, .rj-t, [style*="font-weight:800"]');
        anchor = t && t.nextElementSibling ? t.nextElementSibling : t;
      }
      if (anchor) anchor.insertAdjacentHTML('afterend', line); else el.insertAdjacentHTML('afterbegin', line);
    }
    if (closed) disableApply(el, over ? 'Walk-in completed' : 'Closed');
    else if (full) disableApply(el, 'Registrations full');
  }

  function jobPageId() {
    var m = /^#\/job\/([^/?]+)/.exec(String(location.hash || ''));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function decorateJobPage() {
    var id = jobPageId();
    if (!id || isExternal(id)) return;
    var app = document.getElementById('app');
    if (!app || app.querySelector('.tlwk-jp')) return;
    var job = jobOf(id);
    if (!isWalkin(job)) return;
    var closed = walkinClosed(job);
    var over = closed && walkinDatesOver(job);
    var full = !closed && walkinFull(job);
    var host = app.querySelector('.two-col > div') || app.querySelector('main') || app;
    var first = null;
    for (var k = 0; k < host.children.length; k++) {
      if (host.children[k].classList && host.children[k].classList.contains('panel')) { first = host.children[k]; break; }
    }
    var hb = first && first.querySelector('.jc-badges');
    if (hb) hb.insertAdjacentHTML('afterbegin', BADGE + (closed ? '<span class="badge badge-bad">' + (over ? 'Walk-in completed' : 'Closed') + '</span>' : full ? '<span class="badge badge-warn">Registrations full</span>' : ''));
    var w = wk(job);
    var seats = w.capacity != null && job.walkinSlotsLeft != null && !closed
      ? '<div class="tlwk-kv"><span class="k">Seats</span><span class="v">' + (full ? 'Registrations full' : h(job.walkinSlotsLeft) + ' of ' + h(w.capacity) + ' left') + '</span></div>' : '';
    var panel = document.createElement('div');
    panel.className = 'panel tlwk-jp';
    panel.innerHTML = '<div class="panel-head"><h2>🚶 Walk-in Interview</h2>'
      + (closed ? '<span class="badge badge-bad">' + (over ? 'Walk-in completed' : 'Closed') + '</span>' : '') + '</div>'
      + '<div class="panel-body">' + (over ? '<p class="tlwk-over" style="margin:0 0 10px;color:var(--bad-600);font-weight:700">' + h(datesOverText(job)) + '</p>' : '')
      + walkinBlockHtml(job, { title: closed ? (over ? 'This walk-in is completed' : 'This walk-in has closed') : '' }).replace('<div class="tlwk-box">', '<div class="tlwk-box" style="margin:0">').replace(/(<\/div>)$/, seats + '$1') + '</div>';
    if (first) host.insertBefore(panel, first.nextSibling); else host.insertBefore(panel, host.firstChild);
    if (closed) {
      Array.prototype.forEach.call(app.querySelectorAll('.btn-block'), function (b) {
        if (/apply/i.test(b.textContent || '') && !/applied|submitted/i.test(b.textContent || '')) {
          b.disabled = true; b.removeAttribute('onclick'); b.className = 'btn btn-block';
          b.style.background = 'var(--bad-100)'; b.style.color = 'var(--bad-600)';
          b.textContent = over ? 'Walk-in completed — applications closed' : 'Closed — this walk-in date has passed';
        }
      });
    } else if (full) {
      Array.prototype.forEach.call(app.querySelectorAll('.btn-block'), function (b) {
        if (/apply/i.test(b.textContent || '') && !/applied|submitted/i.test(b.textContent || '')) {
          b.disabled = true; b.removeAttribute('onclick'); b.className = 'btn btn-block';
          b.style.background = 'var(--warn-100)'; b.style.color = 'var(--warn-600)';
          b.textContent = 'Registrations full';
        }
      });
    }
  }

  /* The recruiter's Jobs table: a Walk-in tag on the role, and Clone. */
  function decorateStaffTables() {
    if (!isStaff()) return;
    var app = document.getElementById('app');
    if (!app) return;
    Array.prototype.forEach.call(app.querySelectorAll('table.data tbody tr'), function (tr) {
      if (tr.getAttribute('data-tlwk')) return;
      var html = tr.innerHTML;
      var edit = /startEditJob\('([^']+)'\)/.exec(html);
      var any = edit || /navigate\('\/job\/([^']+)'\)/.exec(html) || /mjCopy\('([^']+)'\)/.exec(html);
      if (!any) return;
      tr.setAttribute('data-tlwk', any[1]);
      var job = jobOf(any[1]);
      if (isWalkin(job)) {
        var t = tr.querySelector('td.clickable b, .mj-title, td b');
        if (t) t.insertAdjacentHTML('afterend', ' <span class="badge badge-brand tlwk-b">🚶 Walk-in</span>'
          + (walkinClosed(job) && job.status === 'open' ? ' <span class="badge badge-bad">Date passed</span>' : ''));
      }
      if (edit && role() === 'recruiter') {
        var cell = tr.querySelector('td.row-actions');
        if (cell && !cell.querySelector('[data-tlwk-clone]')) {
          cell.insertAdjacentHTML('beforeend', ' <button class="btn btn-ghost btn-sm" data-tlwk-clone="1" title="Copy this job into a new draft - change the date or venue and publish" onclick="tlwkClone(\'' + h(edit[1]) + '\')">Clone</button>');
        }
      }
      var copy = tr.querySelector('button[title="Copy"]');
      if (copy) copy.title = 'Clone Job (new draft)';
    });
  }

  var decorating = false;
  function decorate() {
    if (decorating) return;
    decorating = true;
    try {
      var app = document.getElementById('app');
      if (!app) return;
      Array.prototype.forEach.call(app.querySelectorAll(CARDS), decorateCard);
      decorateJobPage();
      decorateStaffTables();
      injectJobTypeFields();
    } catch (e) {
      /* decoration is cosmetic; the server still decides */
    } finally { decorating = false; }
  }
  var pending = null;
  function schedule() {
    if (pending) return;
    pending = setTimeout(function () { pending = null; decorate(); paintMapQrs(); }, 40);
  }

  /* ================================================================ *
   * 3. Apply Now -> the application form
   * ================================================================ */
  var EXP_STEP = 0.5;
  var NOTICE = ['Immediate', '15 days', '30 days', '60 days', '90 days'];
  var QUALS = ['10th', '12th / Intermediate', 'ITI', 'Diploma', 'B.A', 'B.Com', 'B.Sc', 'B.Sc Nursing', 'B.Tech/B.E', 'BBA', 'BCA',
    'B.Pharma', 'MBBS', 'GNM', 'ANM', 'M.A', 'M.Com', 'M.Sc', 'M.Tech/M.E', 'M.B.A / PGDM', 'M.C.A', 'M.Pharma', 'Ph.D', 'Other'];
  var MAX_BYTES = 5 * 1024 * 1024;
  var RESUME_OK = /\.(pdf|docx?)$/i;

  function draftKey(cid, jobId) { return 'tl_apply_draft_v1:' + cid + ':' + jobId; }
  function readDraft(cid, jobId) {
    try { var v = JSON.parse(localStorage.getItem(draftKey(cid, jobId)) || 'null'); return v && typeof v === 'object' ? v : null; }
    catch (e) { return null; }
  }
  function writeDraft(cid, jobId, data) {
    try { localStorage.setItem(draftKey(cid, jobId), JSON.stringify(data)); } catch (e) { /* private mode: no draft */ }
  }
  function clearDraft(cid, jobId) {
    try { localStorage.removeItem(draftKey(cid, jobId)); } catch (e) { /* nothing kept */ }
  }

  function existingApp(cid, jobId) {
    var list = (typeof DATA !== 'undefined' && DATA.applications) || [];
    for (var i = list.length - 1; i >= 0; i--) {
      var a = list[i];
      if (a && a.candidateId === cid && a.jobId === jobId) return a;
    }
    return null;
  }
  function refOf(a) { return a ? (a.reference || a.applicationId || a.id || '') : ''; }

  var FIELDS = [
    ['name', 'tlafName'], ['mobile', 'tlafMobile'], ['email', 'tlafEmail'], ['currentLocation', 'tlafLoc'],
    ['preferredLocation', 'tlafPref'], ['qualification', 'tlafQual'], ['specialization', 'tlafSpec'],
    ['experienceYears', 'tlafExp'], ['currentSalary', 'tlafCtc'], ['expectedSalary', 'tlafEctc'], ['noticePeriod', 'tlafNotice'],
  ];

  function prefillFrom(c) {
    c = c || {};
    var edu = Array.isArray(c.educationRecords) && c.educationRecords[0] ? c.educationRecords[0] : {};
    var years = c.expYears != null ? c.expYears : (/fresher/i.test(String(c.exp || '')) ? 0 : (parseFloat(c.exp) >= 0 ? parseFloat(c.exp) : ''));
    return {
      name: c.name || '', mobile: c.phone || '', email: c.email || '', currentLocation: c.location || '',
      preferredLocation: c.preferredLocation || '', qualification: edu.qualification || c.education || '',
      specialization: edu.specialization || '', experienceYears: years === undefined || years === null ? '' : String(years),
      currentSalary: c.ctc || '', expectedSalary: c.expectedCtc != null ? String(c.expectedCtc) : '',
      noticePeriod: c.noticePeriod || '',
    };
  }

  var FORM = null;     // the open form: { jobId, job, cid, busy, qs, screening, file }

  function row(label, id, input, req) {
    return '<div class="fcr-jd-row" data-row="' + id + '"><label for="' + id + '">' + h(label) + (req ? '<span class="req">*</span>' : '') + '</label>'
      + '<div>' + input + '<div class="tlaf-err" id="' + id + '_err"></div></div></div>';
  }
  function textIn(id, v, attrs) { return '<input type="text" id="' + id + '" value="' + h(v) + '" ' + (attrs || '') + '>'; }
  function opts(list, v, ph) {
    var have = list.indexOf(v) >= 0;
    return '<option value="">' + h(ph || 'Select…') + '</option>'
      + (!have && v ? '<option selected>' + h(v) + '</option>' : '')
      + list.map(function (o) { return '<option' + (o === v ? ' selected' : '') + '>' + h(o) + '</option>'; }).join('');
  }

  function resumeHint() {
    try {
      var s = window.TLResumeScore && TLResumeScore.get && TLResumeScore.get();
      var low = (window.TLResumeScore && TLResumeScore.LOW) || 60;
      if (!s || s.status !== 'scored' || !(s.total < low)) return '';
      var t = (s.tips || [])[0];
      return '<div class="tlaf-hint">💡 Your resume score is <b>' + h(s.total) + '/100</b>.'
        + (t ? ' Quickest win: ' + h(t.fix) + '.' : '')
        + ' <a onclick="fcrCloseModal();location.hash=\'#/candidate/resume-score\'">Improve it</a> — or apply now, either way.</div>';
    } catch (e) { return ''; }
  }

  /* The company the candidate already sees on this job's card - the same
     DATA.companyById(job.companyId).name - and nothing more. */
  function companyName(job) {
    try { var co = DATA.companyById(job.companyId); return (co && co.name) || ''; } catch (e) { return ''; }
  }

  function formHtml(job, v, c) {
    var walkin = isWalkin(job);
    var resume = c && c.resumeFile
      ? '<div class="tlaf-resume" id="tlafResumeOnFile">📄 <b>' + h(c.resumeFile) + '</b>'
        + '<button type="button" class="btn btn-ghost btn-sm" id="tlafReplace">Replace</button></div>'
        + '<input type="file" id="tlafResume" accept=".pdf,.doc,.docx" style="display:none;margin-top:8px">'
      : '<input type="file" id="tlafResume" accept=".pdf,.doc,.docx">';
    return '<div class="fcr-jd-head"><h3>Apply — ' + h(job.title) + '</h3>'
      + '<p>' + (walkin ? 'Walk-in interview · ' : '') + 'Check your details and submit. Fields marked <span style="color:#e5484d">*</span> are required.</p>'
      + '<button type="button" class="fcr-jd-x" data-tlaf-close aria-label="Close">✕</button></div>'
      + '<form id="tlafForm" novalidate autocomplete="on">'
      + '<div class="fcr-jd-body tlaf">'
      + (walkin ? walkinBlockHtml(job) : '')
      + resumeHint()
      + '<div class="tlaf-sec">The job</div>'
      + row('Job Title', 'tlafJobTitle', textIn('tlafJobTitle', job.title, 'readonly tabindex="-1"'))
      + row('Company', 'tlafCompany', textIn('tlafCompany', companyName(job), 'readonly tabindex="-1"'))
      + row('Job ID', 'tlafJobId', textIn('tlafJobId', job.id, 'readonly tabindex="-1"'))
      + row('Job Type', 'tlafJobType', textIn('tlafJobType', walkin ? 'Walk-in' : 'Regular', 'readonly tabindex="-1"'))
      + '<div class="tlaf-sec" id="tlafDetailsHead">Your details</div>'
      + row('Candidate Name', 'tlafName', textIn('tlafName', v.name, 'maxlength="120" autocomplete="name"'), true)
      + row('Mobile Number', 'tlafMobile', '<input type="tel" id="tlafMobile" value="' + h(v.mobile) + '" maxlength="16" inputmode="numeric" autocomplete="tel" placeholder="10-digit mobile number">', true)
      + row('Email Address', 'tlafEmail', '<input type="email" id="tlafEmail" value="' + h(v.email) + '" maxlength="160" autocomplete="email">', true)
      + row('Current Location', 'tlafLoc', textIn('tlafLoc', v.currentLocation, 'maxlength="160" placeholder="e.g. Hyderabad"'), true)
      + row('Preferred Location', 'tlafPref', textIn('tlafPref', v.preferredLocation, 'maxlength="160" placeholder="e.g. Hyderabad"'))
      + row('Highest Qualification', 'tlafQual', '<select id="tlafQual">' + opts(QUALS, v.qualification) + '</select>', true)
      + row('Branch / Specialization', 'tlafSpec', textIn('tlafSpec', v.specialization, 'maxlength="160" placeholder="e.g. Computer Science"'))
      + row('Years of Experience', 'tlafExp', '<input type="number" id="tlafExp" min="0" max="60" step="' + EXP_STEP + '" value="' + h(v.experienceYears) + '" placeholder="0 for a fresher">', true)
      + row('Current Salary', 'tlafCtc', textIn('tlafCtc', v.currentSalary, 'maxlength="40" placeholder="e.g. 3.5 LPA"'))
      + row('Expected Salary (₹ LPA)', 'tlafEctc', '<input type="number" id="tlafEctc" min="0" max="1000" step="0.5" value="' + h(v.expectedSalary) + '" placeholder="e.g. 5">')
      + row('Notice Period', 'tlafNotice', '<select id="tlafNotice">' + opts(NOTICE, v.noticePeriod) + '</select>', true)
      + row('Resume', 'tlafResume', resume + '<div style="font-size:11.5px;color:#7b8a9c;margin-top:4px">PDF, DOC or DOCX, up to 5 MB.</div>', true)
      + '<div class="tlaf-hp" aria-hidden="true"><label for="tlafWebsite">Website</label><input type="text" id="tlafWebsite" name="website" tabindex="-1" autocomplete="off"></div>'
      + '<div id="tlafQsWrap" style="display:none"><div class="tlaf-sec">A few quick questions</div><div class="tlaf-qs" id="tlafQs"></div></div>'
      + '<div class="tlaf-msg" id="tlafMsg" role="alert"></div>'
      + '</div>'
      + '<div class="fcr-jd-actions"><button type="submit" class="btn btn-primary" id="tlafSubmit">Submit Application</button>'
      + '<button type="button" class="btn btn-ghost" data-tlaf-close>Cancel</button></div>'
      + '</form>';
  }

  function readForm() {
    var out = {};
    FIELDS.forEach(function (f) { out[f[0]] = val(f[1]); });
    return out;
  }
  function setErr(id, msg) {
    var el = document.getElementById(id);
    var e = document.getElementById(id + '_err');
    if (e) e.textContent = msg || '';
    if (el) { if (msg) el.classList.add('fcr-jd-bad'); else el.classList.remove('fcr-jd-bad'); }
  }
  function clearErrs() {
    FIELDS.concat([['resume', 'tlafResume']]).forEach(function (f) { setErr(f[1], ''); });
    var m = document.getElementById('tlafMsg');
    if (m) m.innerHTML = '';
  }
  function tenDigits(v) {
    var d = String(v || '').replace(/\D/g, '');
    if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2);
    if (d.length === 11 && d.charAt(0) === '0') d = d.slice(1);
    return d.length === 10 ? d : null;
  }
  function chosenFile() {
    var el = document.getElementById('tlafResume');
    return el && el.files && el.files[0] ? el.files[0] : null;
  }
  function checkFile(file) {
    if (!file) return '';
    if (!RESUME_OK.test(file.name || '')) return 'Please choose a PDF, DOC or DOCX file.';
    if (file.size > MAX_BYTES) return 'That file is larger than 5 MB. Please choose a smaller file.';
    if (!file.size) return 'That file is empty.';
    return '';
  }
  /** Every rule the server applies, here first: field id -> message. */
  function problems(v, c, file) {
    var bad = {};
    if (v.name.length < 2) bad.tlafName = 'Please enter your full name.';
    var d = tenDigits(v.mobile);
    if (!d || !/^[6-9]/.test(d)) bad.tlafMobile = 'Enter a valid 10-digit mobile number.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) bad.tlafEmail = 'Enter a valid email address.';
    if (v.currentLocation.length < 2) bad.tlafLoc = 'Please enter your current location.';
    if (!v.qualification) bad.tlafQual = 'Please choose your highest qualification.';
    if (v.experienceYears === '' || !(Number(v.experienceYears) >= 0) || Number(v.experienceYears) > 60) bad.tlafExp = 'Enter your years of experience (0 for a fresher).';
    if (v.expectedSalary !== '' && !(Number(v.expectedSalary) >= 0)) bad.tlafEctc = 'Enter the expected salary in lakhs a year, e.g. 5.';
    if (!v.noticePeriod) bad.tlafNotice = 'Please choose your notice period.';
    var fe = checkFile(file);
    if (fe) bad.tlafResume = fe;
    else if (!file && !(c && c.resumeFile)) bad.tlafResume = 'Please upload your resume.';
    return bad;
  }
  function validate(v, c) {
    var bad = problems(v, c, chosenFile());
    if (Object.keys(bad).some(function (k) { var r = document.querySelector('[data-row="' + k + '"]'); return r && r.style.display === 'none'; })) showAll();
    Object.keys(bad).forEach(function (k) { setErr(k, bad[k]); });
    var first = Object.keys(bad)[0];
    if (first) { var el = document.getElementById(first); if (el) { try { el.focus(); } catch (e) {} } }
    return !first;
  }

  function busy(on, label) {
    if (!FORM) return;
    FORM.busy = !!on;
    var b = document.getElementById('tlafSubmit');
    if (b) { b.disabled = !!on; b.textContent = on ? (label || 'Submitting…') : 'Submit Application'; }
  }
  function showMsg(html) {
    var m = document.getElementById('tlafMsg');
    if (m) { m.innerHTML = html; try { m.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
  }

  var DETAIL_ROWS = ['tlafName', 'tlafMobile', 'tlafEmail', 'tlafLoc', 'tlafPref', 'tlafQual', 'tlafSpec', 'tlafExp', 'tlafCtc', 'tlafEctc', 'tlafNotice', 'tlafResume'];
  function compact(v, c) {
    var missing = problems(v, c, null);
    var shown = Object.keys(missing);
    var hidden = DETAIL_ROWS.filter(function (id) { return shown.indexOf(id) < 0; });
    hidden.forEach(function (id) { var r = document.querySelector('[data-row="' + id + '"]'); if (r) r.style.display = 'none'; });
    var facts = [['Name', v.name], ['Mobile', v.mobile], ['Email', v.email], ['Location', v.currentLocation],
      ['Qualification', [v.qualification, v.specialization].filter(Boolean).join(' · ')],
      ['Experience', v.experienceYears === '' ? '' : (Number(v.experienceYears) === 0 ? 'Fresher' : v.experienceYears + ' years')],
      ['Notice period', v.noticePeriod], ['Resume', c && c.resumeFile ? '📄 ' + c.resumeFile : '']]
      .filter(function (f) { return f[1] && String(f[1]).trim() && !missing[{ Name: 'tlafName', Mobile: 'tlafMobile', Email: 'tlafEmail', Location: 'tlafLoc', Qualification: 'tlafQual', Experience: 'tlafExp', 'Notice period': 'tlafNotice', Resume: 'tlafResume' }[f[0]]]; });
    var head = document.getElementById('tlafDetailsHead');
    if (!head) return;
    head.insertAdjacentHTML('afterend', '<div class="tlwk-box tlaf-summary" id="tlafSummary" style="background:#f6f8fb;border-color:#e2e7ee">'
      + '<div class="tlwk-box-h" style="color:#243852">' + (shown.length ? 'From your profile' : '✓ Your profile has everything this application needs') + '</div>'
      + facts.map(function (f) { return '<div class="tlwk-kv"><span class="k">' + h(f[0]) + '</span><span class="v">' + h(f[1]) + '</span></div>'; }).join('')
      + '<div class="tlwk-acts"><button type="button" class="btn btn-ghost btn-sm" id="tlafEditAll">Edit my details</button></div></div>'
      + (shown.length ? '<div class="tlaf-hint" style="background:#eef8fb;border-color:#bfe3ee;color:#16323d">Just ' + shown.length + ' thing' + (shown.length === 1 ? '' : 's') + ' to add before you apply:</div>' : ''));
    var b = document.getElementById('tlafEditAll');
    if (b) b.addEventListener('click', showAll);
  }
  function showAll() {
    DETAIL_ROWS.forEach(function (id) { var r = document.querySelector('[data-row="' + id + '"]'); if (r) r.style.display = ''; });
    var sm = document.getElementById('tlafSummary');
    if (sm) { var nx = sm.nextElementSibling; if (nx && nx.classList.contains('tlaf-hint')) nx.remove(); sm.remove(); }
  }

  function closeForm() {
    FORM = null;
    if (typeof window.fcrCloseModal === 'function') window.fcrCloseModal();
  }

  /** Apply Now, for a signed-in candidate and a TeamLink job. */
  function openForm(jobId) {
    var c = me();
    var job = jobOf(jobId);
    if (!c) return;
    if (!job) { say('That job is no longer available on TeamLink', '⚠️'); return; }
    var had = existingApp(c.id, jobId);
    if (had) { showDuplicate(job, refOf(had)); return; }
    if (isWalkin(job) && walkinClosed(job)) {
      say(walkinDatesOver(job) ? datesOverText(job) : 'This walk-in is closed - its date has passed', '📪');
      return;
    }
    if (job.status === 'closed' || job.status === 'draft' || job.paused || job.archived) { say('This role is no longer accepting applications'); return; }
    if (walkinFull(job)) { say('Registrations full for this walk-in', '📪'); return; }
    if (typeof window.fcrModal !== 'function') { say('The application form could not open. Please reload the page.', '⚠️'); return; }

    var draft = readDraft(c.id, jobId);
    var v = prefillFrom(c);
    if (draft && draft.fields) Object.keys(v).forEach(function (k) { if (typeof draft.fields[k] === 'string') v[k] = draft.fields[k]; });
    FORM = { jobId: jobId, job: job, cid: c.id, busy: false, screening: null, restored: !!(draft && draft.fields) };
    window.fcrModal(formHtml(job, v, c));
    var host = document.getElementById('fcrModalHost');
    var form = document.getElementById('tlafForm');
    if (!host || !form) return;
    /* One-click apply: a profile that already answers everything shows a
       summary and only what is missing (nothing, when nothing is). A
       restored draft opens in full - the candidate was editing it. */
    if (!FORM.restored) compact(v, c);
    host.addEventListener('click', function (e) {
      if (e.target.closest('[data-tlaf-close]')) { e.preventDefault(); closeForm(); }
    });
    var rep = document.getElementById('tlafReplace');
    if (rep) rep.addEventListener('click', function () {
      var f = document.getElementById('tlafResume');
      if (f) { f.style.display = 'block'; f.click(); }
    });
    var timer = null;
    var save = function () {
      if (!FORM) return;
      writeDraft(FORM.cid, FORM.jobId, { at: Date.now(), fields: readForm() });
    };
    form.addEventListener('input', function (e) {
      if (e.target && e.target.id && e.target.id !== 'tlafWebsite') setErr(e.target.id, '');
      clearTimeout(timer); timer = setTimeout(save, 300);
    });
    form.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'tlafResume') {
        var fe = checkFile(chosenFile());
        setErr('tlafResume', fe);
        return;
      }
      clearTimeout(timer); timer = setTimeout(save, 100);
    });
    form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });

    /* The job's screening questions, as a section of this form. */
    var S = window.TLScreening;
    if (S && typeof S.questionsFor === 'function' && typeof S.mountForm === 'function') {
      var forJob = jobId;
      S.questionsFor(jobId).then(function (data) {
        if (!data || !FORM || FORM.jobId !== forJob) return;
        var wrap = document.getElementById('tlafQsWrap');
        var qs = document.getElementById('tlafQs');
        if (!wrap || !qs) return;
        wrap.style.display = '';
        FORM.screening = S.mountForm(qs, data);
      }, function () { /* the server asks later (link) */ });
    }
  }

  function uploadResume(file) {
    var fd = new FormData();
    fd.append('purpose', 'apply');
    fd.append('resume', file);
    return api().post('/uploads/resume', fd, { timeout: 120000 }).then(function (res) {
      try {
        var local = res && res.candidate && DATA.candidateById(res.candidate.id);
        if (local) Object.assign(local, res.candidate);
      } catch (e) { /* the server has it */ }
      return res;
    });
  }

  function submit() {
    if (!FORM || FORM.busy) return;          // one submission at a time: double clicks and Enter
    var c = me();
    if (!c) return;
    clearErrs();
    var v = readForm();
    if (!validate(v, c)) { showMsg('Please correct the highlighted fields.'); return; }
    if (FORM.screening && !FORM.screening.check()) { showMsg('Please answer every question in “A few quick questions”.'); return; }
    var job = FORM.job, jobId = FORM.jobId, cid = FORM.cid;
    busy(true);
    var file = chosenFile();
    var step = file ? (busy(true, 'Uploading resume…'), uploadResume(file)) : Promise.resolve(null);
    step.then(function () {
      if (!FORM) return null;
      busy(true, 'Submitting…');
      var body = {
        jobId: jobId, name: v.name, mobile: v.mobile, email: v.email, currentLocation: v.currentLocation,
        preferredLocation: v.preferredLocation, qualification: v.qualification, specialization: v.specialization,
        experienceYears: v.experienceYears === '' ? '' : Number(v.experienceYears),
        currentSalary: v.currentSalary, expectedSalary: v.expectedSalary === '' ? null : Number(v.expectedSalary),
        noticePeriod: v.noticePeriod, website: val('tlafWebsite'),
      };
      try { if (TL.applicationSource) body.source = TL.applicationSource(); } catch (e) {}
      if (FORM.screening) { body.answers = FORM.screening.payload(); }
      return api().post('/applications/form', body);
    }).then(function (res) {
      if (!res || !res.application) return;
      done(res, job, cid);
    }, function (err) {
      busy(false);
      failed(err, job, cid, !!file);
    });
  }

  /* The application exists: record it here the way the rest of the portal expects. */
  function done(res, job, cid) {
    var a = res.application;
    a.fromServer = true;
    if (a.reference) a.applicationId = a.reference;
    var list = DATA.applications || [];
    if (!list.some(function (x) { return x.id === a.id; })) list.push(a);
    if (typeof res.applicants === 'number') job.applicants = res.applicants;
    if (res.notification && window.TL && TL.notifications) TL.notifications.unshift(res.notification);
    try {
      var local = DATA.candidateById(cid);
      if (local && res.candidate) Object.assign(local, res.candidate);
    } catch (e) {}
    if (isWalkin(job) && job.walkinSlotsLeft != null) {
      job.walkinSlotsLeft = Math.max(0, job.walkinSlotsLeft - 1);
      if (job.walkinSlotsLeft === 0) job.walkinFull = true;
    }
    clearDraft(cid, job.id);
    /* The post-apply record the AI interview flow hangs off (index.html
       __afterApply) - without its page change and its toast: this form
       shows the result itself. */
    var rec = null;
    if (typeof window.__afterApply === 'function') {
      var nav = window.navigate, t = window.toast;
      try {
        window.navigate = function () {};
        window.toast = function () {};
        window.__afterApply(a.id, job.id, cid, DATA.candidateById(cid), job, false);
      } catch (e) { /* the application stands either way */ }
      finally { window.navigate = nav; window.toast = t; }
      try { if (TL.syncInterviewDeadlines) TL.syncInterviewDeadlines(); } catch (e) {}
      try { rec = window.__lcRecFor ? window.__lcRecFor(cid, job.id) : null; } catch (e) { rec = null; }
    }
    showSuccess(job, a.reference || a.id, rec, a);
    rerender();
  }

  function failed(err, job, cid, uploaded) {
    var code = err && err.code;
    var d = (err && err.details) || {};
    if (code === 'DUPLICATE_APPLICATION') {
      clearDraft(cid, job.id);
      var ref = d.applicationId || '';
      showDuplicate(job, ref);
      if (window.TL && TL.refresh) Promise.resolve(TL.refresh()).then(rerender, function () {});
      return;
    }
    if (code === 'IDENTITY_OTHER_ACCOUNT') {
      showAll();
      if (d.mobile) setErr('tlafMobile', 'This mobile number belongs to another TeamLink account.');
      if (d.email) setErr('tlafEmail', 'This email belongs to another TeamLink account.');
      showMsg(h(err.message) + '<div style="margin-top:8px"><button type="button" class="btn btn-primary btn-sm" onclick="tlwkLoginOther()">Log in with that account</button></div>');
      return;
    }
    if (code === 'WALKIN_FULL') {
      job.walkinFull = true; job.walkinSlotsLeft = 0;
      showMsg('<b>Registrations full.</b> Every seat for this walk-in has been taken, so your application was not saved.');
      var b = document.getElementById('tlafSubmit');
      if (b) { b.disabled = true; b.textContent = 'Registrations full'; }
      FORM && (FORM.busy = true);
      rerender();
      return;
    }
    if (code === 'WALKIN_COMPLETED') {
      /* 0137: the server read the walk-in's date and it is over - said with the date */
      job.walkinStatus = 'closed';
      showMsg('<b>Walk-in completed.</b> ' + h(err.message || datesOverText(job)) + ' Your application was not saved.');
      var b3 = document.getElementById('tlafSubmit');
      if (b3) { b3.disabled = true; b3.textContent = 'Walk-in completed'; }
      FORM && (FORM.busy = true);
      rerender();
      return;
    }
    if (code === 'JOB_UNAVAILABLE') {
      showMsg(h(err.message || 'This role is no longer accepting applications.') + ' Your application was not saved.');
      var b2 = document.getElementById('tlafSubmit');
      if (b2) { b2.disabled = true; b2.textContent = 'Closed'; }
      FORM && (FORM.busy = true);
      return;
    }
    if (code === 'VALIDATION_FAILED') {
      var map = { name: 'tlafName', mobile: 'tlafMobile', email: 'tlafEmail', currentLocation: 'tlafLoc', preferredLocation: 'tlafPref',
        qualification: 'tlafQual', specialization: 'tlafSpec', experienceYears: 'tlafExp', currentSalary: 'tlafCtc',
        expectedSalary: 'tlafEctc', noticePeriod: 'tlafNotice', resume: 'tlafResume' };
      var any = false;
      if (Object.keys(d).some(function (k) { return map[k]; })) showAll();
      Object.keys(d).forEach(function (k) {
        if (map[k]) { setErr(map[k], d[k]); any = true; }
      });
      if (FORM && FORM.screening && Object.keys(d).some(function (k) { return k.indexOf('answers.') === 0; })) {
        FORM.screening.showServerErrors(d); any = true;
      }
      showMsg(h(err.message || 'Please correct the highlighted fields.') + (any ? '' : ''));
      return;
    }
    if (code === 'FILE_TOO_LARGE' || code === 'UNSUPPORTED_FILE' || code === 'UPLOAD_FAILED') {
      showAll();
      setErr('tlafResume', err.message || 'That file could not be uploaded.');
      showMsg('Your resume could not be uploaded, so nothing was submitted. ' + h(err.message || ''));
      return;
    }
    if (code === 'RATE_LIMITED') { showMsg(h(err.message || 'Too many attempts. Please wait a little and try again.')); return; }
    /* Anything else - the network, a timeout, the server: nothing is
       claimed. The form keeps every field. */
    showMsg('Your application was <b>not</b> submitted' + (uploaded ? ' (your resume was saved to your profile)' : '') + ': '
      + h((err && err.message) || 'TeamLink could not be reached.') + ' Your details are kept — please try again.');
  }

  window.tlwkLoginOther = function () {
    var jobId = FORM && FORM.jobId;
    closeForm();
    /* The same errand teamlink-apply-auth.js keeps: after signing in with
       the other account, this job's form opens again. */
    try { if (jobId) sessionStorage.setItem('tl_apply_intent_v1', JSON.stringify({ jobId: String(jobId), at: Date.now() })); } catch (e) {}
    var out = typeof window.doLogout === 'function' ? window.doLogout() : null;
    Promise.resolve(out).then(function () { window.navigate('/login/candidate'); }, function () { window.navigate('/login/candidate'); });
  };

  /* ---- Add to Calendar ---- */
  function icsStamp(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
  function icsEsc(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1'); }
  function calendarFor(job, ref) {
    var w = wk(job);
    var start = instant(w.date, w.from, '09:00');
    if (start == null) return null;
    var end = instant(w.date, w.to, '');
    if (end == null || end <= start) end = start + 2 * 3600 * 1000;
    var where = [w.venue, w.address].filter(Boolean).join(', ');
    var desc = ['Walk-in interview: ' + job.title, ref ? 'Application ID: ' + ref : '', w.contact ? 'Contact: ' + w.contact + (w.phone ? ' (' + w.phone + ')' : '') : '',
      w.docs.length ? 'Documents to carry: ' + w.docs.join(', ') : '', w.instructions ? 'Instructions: ' + w.instructions : '',
      safeUrl(w.map) ? 'Map: ' + safeUrl(w.map) : ''].filter(Boolean).join('\n');
    var ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TeamLink//Walk-in interview//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT', 'UID:' + icsEsc((ref || job.id) + '-' + w.date) + '@teamlink', 'DTSTAMP:' + icsStamp(Date.now()),
      'DTSTART:' + icsStamp(start), 'DTEND:' + icsStamp(end), 'SUMMARY:' + icsEsc('Walk-in interview: ' + job.title),
      'LOCATION:' + icsEsc(where), 'DESCRIPTION:' + icsEsc(desc),
      'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEsc('Walk-in interview: ' + job.title), 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    var google = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
      + '&text=' + encodeURIComponent('Walk-in interview: ' + job.title)
      + '&dates=' + icsStamp(start) + '/' + icsStamp(end)
      + '&details=' + encodeURIComponent(desc) + '&location=' + encodeURIComponent(where);
    return { ics: ics, google: google };
  }
  window.tlwkDownloadIcs = function (jobId, ref) {
    var job = jobOf(jobId);
    var cal = job && calendarFor(job, ref);
    if (!cal) { say('This walk-in has no date to add', '⚠️'); return; }
    try {
      var blob = new Blob([cal.ics], { type: 'text/calendar;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'walk-in-' + String(job.title || 'interview').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40) + '.ics';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    } catch (e) { say('Could not create the calendar file', '⚠️'); }
  };
  function calendarButtons(job, ref) {
    var cal = calendarFor(job, ref);
    if (!cal) return '';
    return '<button type="button" class="btn btn-ghost btn-sm" data-tlwk-ics onclick="tlwkDownloadIcs(\'' + h(job.id) + '\',\'' + h(ref || '') + '\')">📅 Add to Calendar (.ics)</button>'
      + '<a class="btn btn-ghost btn-sm" data-tlwk-gcal href="' + h(cal.google) + '" target="_blank" rel="noopener noreferrer">Google Calendar</a>';
  }

  function resultShell(inner) {
    if (typeof window.fcrModal !== 'function') return;
    window.fcrModal(inner);
    var host = document.getElementById('fcrModalHost');
    if (host) host.addEventListener('click', function (e) {
      if (e.target.closest('[data-tlaf-close]')) { e.preventDefault(); closeForm(); }
    });
  }

  /* 0139: what the success screen states - every value from the application the server saved */
  var SOURCE_LABEL = { teamlink: 'TeamLink Job Portal', portal: 'TeamLink Job Portal', website: 'TeamLink Website', walkin: 'Walk-in' };
  function savedFacts(job, app) {
    app = app || {};
    var co = null; try { co = DATA.companyById(job.companyId); } catch (e) {}
    var at = app.appliedAt ? new Date(app.appliedAt) : null;
    var when = at && !isNaN(at) ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true }).format(at) + ' IST' : '';
    var w = wk(job);
    var ai = isWalkin(job) && !w.aiRequired ? 'Not required for this walk-in'
      : 'Pending - attend your AI interview' + (isWalkin(job) ? ' (' + w.threshold + '% or more makes you eligible for the walk-in)' : '');
    var rows = [
      ['Candidate', (function () { try { var c = me(); return c && c.name; } catch (e) { return ''; } })()],
      ['Job title', job.title],
      ['Company / Client', (co && co.name) || job.company || job.companyName || ''],
      ['Job location', job.location || ''],
      ['Submitted', when],
      ['Application source', app.sourceChannel || SOURCE_LABEL[String(app.source || '').toLowerCase()] || 'TeamLink Job Portal'],
      ['Application status', 'Applied' + (isWalkin(job) ? ' - registered for the walk-in' : '')],
      ['AI interview', ai],
    ];
    return '<div class="tlaf-facts">' + rows.filter(function (r) { return r[1]; })
      .map(function (r) { return '<div><span>' + h(r[0]) + '</span><b>' + h(r[1]) + '</b></div>'; }).join('') + '</div>';
  }
  function showSuccess(job, ref, rec, app, opts) {
    opts = opts || {};
    var walkin = isWalkin(job);
    FORM = null;
    var detailId = (rec && rec.applicationId) || (app && app.id) || '';
    resultShell('<div class="fcr-jd-body tlaf"><div class="tlaf-done" id="tlafDone">'
      + '<div class="tick">✓</div>'
      + '<h3>Application Submitted Successfully!</h3>'
      + '<p>Your application has been submitted successfully. Please keep your Application ID for future reference.</p>'
      + '<p style="margin-top:12px">Application ID:</p><div class="ref" id="tlafRef">' + h(ref) + '</div>'
      + savedFacts(job, app)
      + (walkin ? walkinBlockHtml(job, { title: 'Walk-in Interview Details', only: ['Date', 'Time', 'Venue', 'Address', 'Documents to carry', 'Contact', 'Instructions'], calendar: calendarButtons(job, ref) }) : '')
      + '<p style="font-size:12px;margin-top:10px">Keep this Application ID for any question about this application - it is also under My Applications.</p>'
      + '</div></div>'
      + '<div class="fcr-jd-actions" style="justify-content:center;flex-wrap:wrap">'
      + (rec && rec.applicationId && !(walkin && !wk(job).aiRequired) ? '<button type="button" class="btn btn-ai" onclick="fcrCloseModal();navigate(\'/ai-interview/' + h(rec.applicationId) + '\')">Attend AI Interview</button>' : '')
      + (detailId ? '<button type="button" class="btn btn-ghost" onclick="fcrCloseModal();navigate(\'/candidate-app/' + h(detailId) + '\')">View Application Details</button>' : '')
      + '<button type="button" class="btn btn-primary" onclick="fcrCloseModal();navigate(\'/candidate/applications\')">Go to My Applications</button>'
      + (detailId ? '<button type="button" class="btn btn-ghost" onclick="fcrCloseModal();navigate(\'/candidate-app/' + h(detailId) + '\')">Track Application Status</button>' : '')
      + (opts.undo ? '<button type="button" class="btn btn-ghost" id="tlafUndo">Undo</button>' : '')
      + '<button type="button" class="btn btn-ghost" data-tlaf-close>Close</button></div>');
    paintMapQrs();
    /* One-click: Undo stays for its few seconds, as it did on the old confirmation toast */
    if (opts.undo) {
      var u = document.getElementById('tlafUndo');
      if (u) u.addEventListener('click', function () { if (typeof window.fcrCloseModal === 'function') window.fcrCloseModal(); opts.undo(); });
      setTimeout(function () { var x = document.getElementById('tlafUndo'); if (x) x.remove(); }, opts.undoMs || 5000);
    }
  }

  function showDuplicate(job, ref) {
    FORM = null;
    var walkin = isWalkin(job);
    resultShell('<div class="fcr-jd-body tlaf"><div class="tlaf-done" id="tlafDup">'
      + '<div class="tick info">ℹ</div>'
      + '<h3>You have already applied for this position.</h3>'
      + '<p>' + h(job.title) + '</p>'
      + (ref ? '<p style="margin-top:12px">Application ID:</p><div class="ref">' + h(ref) + '</div>' : '')
      + (walkin ? walkinBlockHtml(job, { title: 'Your walk-in interview', calendar: walkinClosed(job) ? '' : calendarButtons(job, ref) }) : '')
      + '</div></div>'
      + '<div class="fcr-jd-actions" style="justify-content:center;flex-wrap:wrap">'
      + '<button type="button" class="btn btn-primary" onclick="fcrCloseModal();navigate(\'/candidate/applications\')">Go to My Applications</button>'
      + '<button type="button" class="btn btn-ghost" data-tlaf-close>Close</button></div>');
  }

  /* The wrappers. Installed at window load, after the screening questions,
     one-click apply and the resume-score hint (their scripts load first and
     install first), so this one is outermost: a candidate's Apply Now on a
     TeamLink job opens the form, and the form is the whole apply step. */
  /* 0118: Apply Now is one click (teamlink-one-click-apply.js). Whichever of
     the two wrappers ends up outermost, a candidate's Apply Now applies; the
     form below is opened only when this module is asked for it directly
     (TLWalkinJobs.open) or when the one-click module is not there. */
  function applyOrForm(jobId) {
    if (window.TLOneClickApply && typeof window.TLOneClickApply.apply === 'function') return window.TLOneClickApply.apply(String(jobId));
    return openForm(String(jobId));
  }
  function installApply() {
    var prev = window.applyToJob;
    if (typeof prev !== 'function' || prev.__tlwk) return;
    var next = function (jobId) {
      if (!jobId || isExternal(jobId) || !isCandidate()) return prev.apply(this, arguments);
      applyOrForm(jobId);
      return undefined;
    };
    next.__tlwk = true;
    window.applyToJob = next;
    ['easyApply', 'cpEasyApply', 'capApply'].forEach(function (fn) {
      var p = window[fn];
      if (typeof p !== 'function' || p.__tlwk) return;
      var w = function (jobId) {
        if (!jobId || isExternal(jobId) || !isCandidate()) return p.apply(this, arguments);
        applyOrForm(jobId);
        return undefined;
      };
      w.__tlwk = true;
      window[fn] = w;
    });
  }

  /* ================================================================ *
   * 4. the recruiter's job forms
   * ================================================================ */
  var PENDING = null;          // walk-in fields waiting for the job they belong to

  /* THE ADDRESS ARRIVED AFTER THE JOB WAS SAVED, SO THE SAVE WAS REFUSED.
     A new job is pushed onto DATA.jobs, and that push is what writes it to the server (the page
     mirrors DATA.jobs into storage, and the storage layer sends it). fcrRegisterPosting - where the
     walk-in details used to be attached - runs only AFTER the push. The server requires a full address
     for a walk-in, so the first save always went without one and was refused ("Full address is required
     for a walk-in job"), while the page still said "Walk-in job published". The walk-in details are now
     attached on the push itself, before anything is saved or sent. */
  function takePending(job) {
    if (PENDING && job && job.id && !job.__tlwkDone && (!PENDING.title || PENDING.title === job.title)) {
      Object.assign(job, PENDING.fields);
      job.__tlwkDone = true;
      PENDING = null;
    }
  }
  function ensureJobsPush() {
    try {
      var list = window.DATA && DATA.jobs;
      if (!list || list.push.__tlwk) return;
      var prev = list.push;
      var next = function () {
        for (var i = 0; i < arguments.length; i++) takePending(arguments[i]);
        return prev.apply(this, arguments);
      };
      next.__tlwk = true;
      list.push = next;
    } catch (e) { /* the later attachment in fcrRegisterPosting still runs */ }
  }

  function wkFieldsHtml(prefix, w, isEdit) {
    w = w || {};
    var g = function (label, id, input, req, full) {
      return '<div class="fgroup' + (full ? ' full' : '') + '"><label for="' + id + '">' + h(label)
        + (req ? ' <span style="color:var(--bad-600,#d4342c)">*</span>' : '') + '</label>' + input
        + '<span class="tlwk-ferr" id="' + id + '_err"></span></div>';
    };
    var minDate = isEdit ? '' : ' min="' + istToday() + '"';
    return '<div class="tlwk-grid">'
      + g('Walk-in Date', prefix + 'Date', '<input type="date" id="' + prefix + 'Date"' + minDate + ' value="' + h(isoDate(w.date) ? w.date : '') + '">', true)
      + g('Contact Person', prefix + 'Contact', '<input type="text" id="' + prefix + 'Contact" maxlength="120" value="' + h(w.contact || '') + '" placeholder="Who to ask for on arrival">', true)
      + g('Walk-in Start Time', prefix + 'From', '<input type="time" id="' + prefix + 'From" value="' + h(hhmm(w.from) ? w.from : '') + '">', true)
      + g('Walk-in End Time', prefix + 'To', '<input type="time" id="' + prefix + 'To" value="' + h(hhmm(w.to) ? w.to : '') + '">', true)
      + g('Venue', prefix + 'Venue', '<input type="text" id="' + prefix + 'Venue" maxlength="400" value="' + h(w.venue || '') + '" placeholder="e.g. TeamLink Office, 3rd floor">', true)
      + g('Contact Number', prefix + 'Phone', '<input type="tel" id="' + prefix + 'Phone" maxlength="16" value="' + h(w.phone || '') + '" placeholder="10-digit number">', true)
      + g('Contact Person Designation (optional)', prefix + 'Desig', '<input type="text" id="' + prefix + 'Desig" maxlength="120" value="' + h(w.designation || '') + '" placeholder="e.g. HR Manager">', false)
      + g('AI Interview Required', prefix + 'AiReq', '<select id="' + prefix + 'AiReq"><option value="yes"' + (w.aiRequired !== false ? ' selected' : '') + '>Yes</option><option value="no"' + (w.aiRequired === false ? ' selected' : '') + '>No</option></select>', false)
      + g('AI Interview Eligibility Threshold (%)', prefix + 'Thr', '<input type="number" id="' + prefix + 'Thr" min="0" max="100" step="1" value="' + h(w.threshold == null ? 50 : w.threshold) + '" placeholder="50">', false)
      + g('Full Address', prefix + 'Address', '<textarea id="' + prefix + 'Address" rows="2" maxlength="600" placeholder="Building, street, area, city, PIN">' + h(w.address || '') + '</textarea>', true, true)
      + g('Google Maps Link (optional - its QR code is shown to candidates)', prefix + 'Map', '<input type="url" id="' + prefix + 'Map" maxlength="600" value="' + h(w.map || '') + '" placeholder="https://maps.app.goo.gl/…">', false)
      + g('Slot Capacity (optional)', prefix + 'Cap', '<input type="number" id="' + prefix + 'Cap" min="1" max="100000" step="1" value="' + h(w.capacity == null ? '' : w.capacity) + '" placeholder="No limit">', false)
      + g('Documents to Carry (optional, one per line)', prefix + 'Docs', '<textarea id="' + prefix + 'Docs" rows="3" maxlength="2000" placeholder="Updated resume (2 copies)&#10;Photo ID&#10;Certificates">' + h((w.docs || []).join('\n')) + '</textarea>', false, true)
      + g('Instructions (optional)', prefix + 'Instr', '<textarea id="' + prefix + 'Instr" rows="2" maxlength="2000" placeholder="e.g. Report 15 minutes early and ask at reception">' + h(w.instructions || '') + '</textarea>', false, true)
      + '</div>';
  }

  function readWk(prefix) {
    var docs = val(prefix + 'Docs').split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean).join('\n');
    return {
      date: val(prefix + 'Date'), from: val(prefix + 'From'), to: val(prefix + 'To'), venue: val(prefix + 'Venue'),
      address: val(prefix + 'Address'), map: val(prefix + 'Map'), contact: val(prefix + 'Contact'), phone: val(prefix + 'Phone'),
      docs: docs, instructions: val(prefix + 'Instr'), capacity: val(prefix + 'Cap'),
      designation: val(prefix + 'Desig'), aiRequired: val(prefix + 'AiReq') !== 'no', threshold: val(prefix + 'Thr'),
    };
  }
  function wkErr(prefix, key, msg) {
    var el = document.getElementById(prefix + key);
    var e = document.getElementById(prefix + key + '_err');
    if (e) e.textContent = msg || '';
    if (el) { if (msg) el.classList.add('fcr-jd-bad'); else el.classList.remove('fcr-jd-bad'); el.style.borderColor = msg ? '#e5484d' : ''; }
  }
  /**
   * The same rules as the server (api/src/portal/walkin-jobs.js). `before`
   * is the job being edited, or null for a new one: a date only has to be
   * today or later when it is new or changed.
   */
  function checkWk(prefix, f, before, publishing) {
    var bad = {};
    ['Date', 'From', 'To', 'Venue', 'Address', 'Map', 'Contact', 'Phone', 'Docs', 'Instr', 'Cap', 'Desig', 'Thr'].forEach(function (k) { wkErr(prefix, k, ''); });
    if (publishing) {
      if (!f.date) bad.Date = 'Walk-in date is required.';
      if (!f.from) bad.From = 'Start time is required.';
      if (!f.to) bad.To = 'End time is required.';
      if (!f.venue) bad.Venue = 'Venue is required.';
      if (!f.address) bad.Address = 'Full address is required.';
      if (!f.contact) bad.Contact = 'Contact person is required.';
      if (!f.phone) bad.Phone = 'Contact number is required.';
    }
    if (f.date && !isoDate(f.date)) bad.Date = 'Choose a date.';
    if (f.from && !hhmm(f.from)) bad.From = 'Choose a start time.';
    if (f.to && !hhmm(f.to)) bad.To = 'Choose an end time.';
    if (!bad.From && !bad.To && f.from && f.to && f.to <= f.from) bad.To = 'End time must be after the start time.';
    var moved = !before || f.date !== (wk(before).date || '') || f.to !== (wk(before).to || '');
    if (publishing && moved && !bad.Date && isoDate(f.date)) {
      if (f.date < istToday()) bad.Date = 'The walk-in date cannot be in the past.';
      else {
        var e = instant(f.date, f.to, '23:59');
        if (e != null && e <= Date.now() && !bad.To) bad.To = 'This time has already passed today.';
      }
    }
    if (f.phone && !tenDigits(f.phone)) bad.Phone = 'Enter a valid 10-digit contact number.';
    if (f.map && !safeUrl(f.map)) bad.Map = 'The map link must start with https://';
    else if (f.map && !isGoogleMaps(f.map)) bad.Map = 'Please paste the Google Maps link of the venue (google.com/maps, maps.app.goo.gl or goo.gl/maps).';
    if (f.threshold !== '' && f.threshold != null && !(/^\d+(\.\d+)?$/.test(String(f.threshold)) && Number(f.threshold) <= 100)) bad.Thr = 'The threshold is a percentage from 0 to 100.';
    if (f.capacity !== '' && !(/^\d+$/.test(f.capacity) && Number(f.capacity) >= 1)) bad.Cap = 'Capacity must be a whole number of 1 or more.';
    Object.keys(bad).forEach(function (k) { wkErr(prefix, k, bad[k]); });
    return Object.keys(bad);
  }
  function asJobFields(f) {
    return {
      postingKind: 'walkin', type: 'Walk-in', jobType: 'walk-in',
      walkinDate: f.date, walkinFrom: f.from, walkinTo: f.to, walkinStartTime: f.from, walkinEndTime: f.to,
      walkinTime: f.from && f.to ? f.from + ' – ' + f.to : (f.from || f.to || ''),
      walkinVenue: f.venue, walkinAddress: f.address, walkinMapLink: f.map,
      walkinContact: f.contact, walkinContactPerson: f.contact, walkinPhone: f.phone, walkinContactNumber: f.phone,
      walkinDocumentsToCarry: f.docs, walkinInstructions: f.instructions,
      walkinSlotCapacity: f.capacity === '' ? null : Number(f.capacity),
      walkinContactDesignation: f.designation || '',
      walkinAiRequired: f.aiRequired !== false,
      walkinAiThreshold: f.threshold === '' || f.threshold == null ? 50 : Number(f.threshold),
    };
  }

  /* AI Job Creation (njStatus) and Edit job (ejStatus): Job Type + walk-in fields. */
  function injectJobTypeFields() {
    if (!(role() === 'recruiter' || role() === 'admin')) return;
    [['njStatus', 'tlwkN'], ['ejStatus', 'tlwkE']].forEach(function (pair) {
      var anchor = document.getElementById(pair[0]);
      var prefix = pair[1];
      if (!anchor || document.getElementById(prefix + 'Box')) return;
      var isEdit = pair[0] === 'ejStatus';
      var job = isEdit && STATE.editJobId ? jobOf(STATE.editJobId) : null;
      var walkin = isEdit ? isWalkin(job) : !!(STATE.jobDraft && STATE.jobDraft.__walkin);
      var w = job && walkin ? wk(job) : (STATE.jobDraft && STATE.jobDraft.__wk) || {};
      var grid = anchor.closest('.kv') || anchor.closest('.fgroup').parentNode;
      var box = document.createElement('div');
      box.id = prefix + 'Box';
      box.className = 'tlwk-form';
      box.style.gridColumn = '1 / -1';
      box.innerHTML = '<div class="fgroup"><label>Job Type</label><div class="tlwk-type" role="radiogroup" aria-label="Job Type">'
        + '<label><input type="radio" name="' + prefix + 'Type" value="regular"' + (walkin ? '' : ' checked') + '> Regular Job</label>'
        + '<label><input type="radio" name="' + prefix + 'Type" value="walkin"' + (walkin ? ' checked' : '') + '> Walk-in</label>'
        + '</div></div>'
        + '<div id="' + prefix + 'Fields" style="' + (walkin ? '' : 'display:none') + '">' + wkFieldsHtml(prefix, w, isEdit) + '</div>';
      grid.parentNode.insertBefore(box, grid.nextSibling);
      box.addEventListener('change', function (e) {
        if (e.target && e.target.name === prefix + 'Type') {
          var on = e.target.value === 'walkin';
          var f = document.getElementById(prefix + 'Fields');
          if (f) f.style.display = on ? '' : 'none';
          if (!isEdit && STATE.jobDraft) STATE.jobDraft.__walkin = on;
        }
        if (!isEdit && STATE.jobDraft) STATE.jobDraft.__wk = Object.assign(readWk(prefix), { docs: readWk(prefix).docs.split('\n').filter(Boolean) });
      });
      box.addEventListener('input', function () {
        if (!isEdit && STATE.jobDraft) STATE.jobDraft.__wk = Object.assign(readWk(prefix), { docs: readWk(prefix).docs.split('\n').filter(Boolean) });
      });
    });
  }
  function typeOf(prefix) {
    var r = document.querySelector('input[name="' + prefix + 'Type"]:checked');
    return r ? r.value : null;
  }

  /* Every creation path ends in fcrRegisterPosting(job): the walk-in fields
     waiting for this job go onto it there, before it is saved and synced. */
  (function wrapRegister() {
    var prev = window.fcrRegisterPosting;
    if (typeof prev !== 'function' || prev.__tlwk) return;
    var next = function (job) {
      takePending(job);
      return prev.apply(this, arguments);
    };
    next.__tlwk = true;
    window.fcrRegisterPosting = next;
  })();

  (function wrapPublishGenerated() {
    var prev = window.publishGeneratedJob;
    if (typeof prev !== 'function' || prev.__tlwk) return;
    var next = function () {
      if (typeOf('tlwkN') === 'walkin') {
        var f = readWk('tlwkN');
        var status = val('njStatus') === 'closed' ? 'closed' : 'open';
        var bad = checkWk('tlwkN', f, null, status === 'open');
        if (bad.length) { say('Please complete the walk-in details', '⚠️'); return; }
        PENDING = { title: STATE.jobDraft && STATE.jobDraft.title, fields: asJobFields(f) };
        ensureJobsPush();
        try { return prev.apply(this, arguments); }
        finally {
          PENDING = null;
          if (STATE.jobDraft) { delete STATE.jobDraft.__walkin; delete STATE.jobDraft.__wk; }
        }
      }
      return prev.apply(this, arguments);
    };
    next.__tlwk = true;
    window.publishGeneratedJob = next;
  })();

  (function wrapSaveEdit() {
    var prev = window.saveEditJob;
    if (typeof prev !== 'function' || prev.__tlwk) return;
    var next = function (jobId) {
      var job = jobOf(jobId);
      var t = typeOf('tlwkE');
      if (job && t === 'walkin') {
        var f = readWk('tlwkE');
        var status = val('ejStatus') === 'closed' ? 'closed' : 'open';
        var publishing = status === 'open' && (job.status !== 'open' || !isWalkin(job)
          || ['date', 'from', 'to', 'venue', 'address', 'contact', 'phone'].some(function (k) {
            var cur = wk(job)[k] || '';
            return String(f[k] || '') !== String(cur);
          }));
        var bad = checkWk('tlwkE', f, isWalkin(job) ? job : null, publishing);
        if (bad.length) { say('Please complete the walk-in details', '⚠️'); return; }
        if (!val('ejTitle')) return prev.apply(this, arguments);   // its own message
        Object.assign(job, asJobFields(f));
      } else if (job && t === 'regular' && isWalkin(job)) {
        job.postingKind = 'job'; job.jobType = 'regular';
        if (/^walk/i.test(job.type || '')) job.type = 'Full-time';
      }
      return prev.apply(this, arguments);
    };
    next.__tlwk = true;
    window.saveEditJob = next;
  })();

  /* Post A Walk-in Job (the recruiter's Jobs menu): the same fields and
     the same rules - a calendar date and real times, the full address,
     the map, documents, instructions and capacity. */
  (function wrapWalkinModal() {
    var prevModal = window.tnavWalkinModal;
    if (typeof prevModal === 'function' && !prevModal.__tlwk) {
      var m = function () {
        var out = prevModal.apply(this, arguments);
        try { upgradeTw(); } catch (e) { /* the form still works as it was */ }
        return out;
      };
      m.__tlwk = true;
      window.tnavWalkinModal = m;
    }
    var prevSubmit = window.tnavWalkinSubmit;
    if (typeof prevSubmit === 'function' && !prevSubmit.__tlwk) {
      var s = function () {
        if (document.getElementById('tlwkTAddress')) {
          var f = {
            date: val('twDate'), from: val('twFrom'), to: val('twTo'), venue: val('twVenue'),
            address: val('tlwkTAddress'), map: val('tlwkTMap'), contact: val('twContact'), phone: val('twPhone'),
            docs: val('tlwkTDocs').split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean).join('\n'),
            instructions: val('tlwkTInstr'), capacity: val('tlwkTCap'),
          };
          var bad = twCheck(f, val('twStatus') !== 'closed');
          if (bad.length) { say('Still needed: ' + bad.join(', '), '⚠️'); return; }
          PENDING = { title: val('twTitle'), fields: asJobFields(f) };
          ensureJobsPush();
          setTimeout(function () { if (PENDING && PENDING.title === f.title) PENDING = null; }, 60000);
        }
        return prevSubmit.apply(this, arguments);
      };
      s.__tlwk = true;
      window.tnavWalkinSubmit = s;
    }
  })();
  function twRow(label, id, input, req) {
    return '<div class="fcr-jd-row tlwk-tw"><label for="' + id + '">' + h(label) + (req ? '<span class="req">*</span>' : '') + '</label><div>' + input
      + '<div class="tlwk-ferr" id="' + id + '_err"></div></div></div>';
  }
  function upgradeTw() {
    var d = document.getElementById('twDate');
    if (!d || document.getElementById('tlwkTAddress')) return;
    d.type = 'date'; d.min = istToday(); d.placeholder = '';
    var f = document.getElementById('twFrom'), t = document.getElementById('twTo');
    if (f) { f.type = 'time'; f.placeholder = ''; f.setAttribute('aria-label', 'Start time'); }
    if (t) { t.type = 'time'; t.placeholder = ''; t.setAttribute('aria-label', 'End time'); }
    var v = document.getElementById('twVenue');
    if (v) {
      v.placeholder = 'e.g. TeamLink Office, 3rd floor';
      var lab = v.closest('.fcr-jd-row') && v.closest('.fcr-jd-row').querySelector('label');
      if (lab && lab.firstChild) lab.firstChild.nodeValue = 'Venue';
      var rowEl = v.closest('.fcr-jd-row');
      rowEl.insertAdjacentHTML('afterend',
        twRow('Full Address', 'tlwkTAddress', '<textarea id="tlwkTAddress" rows="2" maxlength="600" placeholder="Building, street, area, city, PIN"></textarea>', true)
        + twRow('Google Maps Link', 'tlwkTMap', '<input type="url" id="tlwkTMap" maxlength="600" placeholder="https://maps.google.com/… (optional)">')
        + twRow('Documents to Carry', 'tlwkTDocs', '<textarea id="tlwkTDocs" rows="3" maxlength="2000" placeholder="One per line (optional) - e.g. Updated resume, Photo ID"></textarea>')
        + twRow('Instructions', 'tlwkTInstr', '<textarea id="tlwkTInstr" rows="2" maxlength="2000" placeholder="Anything else to know (optional)"></textarea>')
        + twRow('Slot Capacity', 'tlwkTCap', '<input type="number" id="tlwkTCap" min="1" max="100000" step="1" placeholder="No limit (optional)">'));
    }
    var ph = document.getElementById('twPhone');
    if (ph) ph.maxLength = 16;
  }
  function twCheck(f, publishing) {
    var bad = [];
    var mark = function (id, msg) {
      var e = document.getElementById(id + '_err'); if (e) e.textContent = msg || '';
      var el = document.getElementById(id); if (el) { if (msg) el.classList.add('fcr-jd-bad'); else el.classList.remove('fcr-jd-bad'); }
    };
    ['tlwkTAddress', 'tlwkTMap', 'tlwkTCap'].forEach(function (id) { mark(id, ''); });
    if (publishing && !f.address) { bad.push('Full Address'); mark('tlwkTAddress', 'Full address is required.'); }
    if (f.date && !isoDate(f.date)) bad.push('Walk-in Date');
    else if (publishing && f.date && f.date < istToday()) { bad.push('Walk-in Date (cannot be in the past)'); var dd = document.getElementById('twDate'); if (dd) dd.classList.add('fcr-jd-bad'); }
    if (f.from && f.to && hhmm(f.from) && hhmm(f.to) && f.to <= f.from) { bad.push('End Time (must be after the start)'); var tt = document.getElementById('twTo'); if (tt) tt.classList.add('fcr-jd-bad'); }
    if (publishing && isoDate(f.date) && f.date === istToday()) {
      var e = instant(f.date, f.to, '23:59');
      if (e != null && e <= Date.now()) bad.push('End Time (already passed today)');
    }
    if (f.phone && !tenDigits(f.phone)) bad.push('Contact Phone (10 digits)');
    if (f.map && !safeUrl(f.map)) { bad.push('Google Maps Link (https://)'); mark('tlwkTMap', 'The map link must start with https://'); }
    if (f.capacity !== '' && !(/^\d+$/.test(f.capacity) && Number(f.capacity) >= 1)) { bad.push('Slot Capacity'); mark('tlwkTCap', 'A whole number of 1 or more.'); }
    return bad;
  }

  /* Clone Job: the existing Copy (a new Job ID, a draft), then its editor. */
  window.tlwkClone = function (jobId) {
    var src = jobOf(jobId);
    if (!src || typeof window.mjCopy !== 'function') { say('This job cannot be cloned here', '⚠️'); return; }
    var before = (DATA.jobs || []).length;
    window.mjCopy(jobId);
    var copy = (DATA.jobs || []).length > before ? DATA.jobs[DATA.jobs.length - 1] : null;
    if (!copy) return;
    say('Cloned as a draft (new Job ID ' + copy.id + ') - change the date or venue and save', '📋');
    STATE.editJobId = copy.id;
    if (typeof window.navigate === 'function') window.navigate('/recruiter/jobs');
    rerender();
    setTimeout(function () { var t = document.getElementById('ejTitle'); if (t) { try { t.scrollIntoView({ block: 'center' }); t.focus(); } catch (e) {} } }, 300);
  };


  /* ================================================================ *
   * boot
   * ================================================================ */
  function observe() {
    var app = document.getElementById('app');
    if (!app || app.__tlwkObserved) return;
    app.__tlwkObserved = true;
    new MutationObserver(schedule).observe(app, { childList: true, subtree: true });
    schedule();
  }
  if (document.readyState === 'complete') installApply();
  else window.addEventListener('load', installApply);
  (function waitReady(n) {
    if (ready() || n > 240) { observe(); return; }
    setTimeout(function () { waitReady(n + 1); }, 250);
  })(0);
  window.addEventListener('hashchange', schedule);

  /* ================================================================ *
   * "Walk-in Jobs" beside Internships in the candidate header (owner,
   * 2026-10-05). Not a separate module: it is the Jobs list with the
   * Walk-in quick filter on, so walk-in stays a job type.
   * ================================================================ */
  var walkinFilterOn = function () { return /[?&]qf=[^&]*\bwalkin\b/.test(String(location.hash || '')); };
  window.tlNavWalkins = function () {
    try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
    if (typeof STATE !== 'undefined') {
      STATE.rj = STATE.rj || {}; STATE.rj.f = STATE.rj.f || {};
      STATE.rj.mode = ''; STATE.rj.q = ''; STATE.rj.f.types = [];
    }
    var next = '#/candidate/search?qf=walkin';
    if (location.hash === next) { if (typeof render === 'function') render(); } else location.hash = next;
  };
  /* Jobs and Internships switch the walk-in filter off again. */
  ['tlNavJobs', 'tlNavInternships'].forEach(function (fn) {
    var prev = window[fn];
    if (typeof prev !== 'function' || prev.__tlwkNav) return;
    var next = function () {
      if (walkinFilterOn() && typeof window.tlpuChip === 'function') window.tlpuChip('walkin');
      return prev.apply(this, arguments);
    };
    next.__tlwkNav = true;
    window[fn] = next;
  });
  (function wrapHeader() {
    var prev = window.cpShell;
    if (typeof prev !== 'function' || prev.__tlwkNav) return;
    var next = function (section) {
      var html = prev.apply(this, arguments);
      if (typeof html !== 'string' || html.indexOf('tlNavWalkins()') >= 0) return html;
      var on = section === 'search' && walkinFilterOn();
      return html.replace(/(<nav class="cp-nav">[\s\S]*?)(<a\b[^>]*>Internships<\/a>)([\s\S]*?<\/nav>)/, function (_m, a, intern, rest) {
        if (on) {
          /* the walk-in list is showing: Walk-in Jobs is the current tab, not Jobs */
          a = a.replace(/<a class="on"( onclick="tlNavJobs\(\)">Jobs<\/a>)/, '<a class=""$1');
        }
        return a + intern + '<a class="' + (on ? 'on' : '') + '" onclick="tlNavWalkins()">Walk-in Jobs</a>' + rest;
      });
    };
    next.__tlwkNav = true;
    window.cpShell = next;
  })();

  window.TLWalkinJobs = {
    open: openForm,
    isWalkin: isWalkin,
    closed: walkinClosed,
    /* 0139: "Application Submitted Successfully!" with the saved application's details - the one
       screen every Apply ends on (the form, and one-click, which passes its Undo) */
    success: function (job, app, opts) {
      if (!job || !app) return false;
      var rec = null;
      try { rec = window.__lcRecFor ? window.__lcRecFor(app.candidateId, job.id) : null; } catch (e) { rec = null; }
      showSuccess(job, app.reference || app.id, rec, app, opts);
      return true;
    },
    /* 0137: the sentence for a walk-in whose DATES are over ('' when they are not) - asked first by
       every Apply path, so nobody is told to complete a profile for a drive that has happened */
    overMessage: function (job) { return job && walkinDatesOver(job) ? datesOverText(job) : ''; },
    full: walkinFull,
    details: walkinLines,
    calendar: calendarFor,
    /* The walk-in details a confirmation shows (date, venue, map,
       calendar) - for the one-click confirmation too (0118). */
    resultHtml: function (job, ref, already) {
      if (!job || !isWalkin(job)) return '';
      return already
        ? walkinBlockHtml(job, { title: 'Your walk-in interview', calendar: walkinClosed(job) ? '' : calendarButtons(job, ref) })
        : walkinBlockHtml(job, { title: 'Walk-in Interview Details', only: ['Date', 'Time', 'Venue', 'Address', 'Documents to carry', 'Contact', 'Instructions'], calendar: calendarButtons(job, ref) });
    },
  };
})();
