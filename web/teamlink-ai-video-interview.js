/* =====================================================================
   TEAMLINK — the AI video interview screen

   WHAT THIS IS. The look and the plumbing of the EXISTING AI interview at
   #/ai-interview/<ref> (the AIIV module in index.html). That module still
   owns the interview: its phases, its questions (planned by the server),
   its speech, its proctoring and every call that records an answer. This
   file gives it the owner's screen (docs/AI-VIDEO-INTERVIEW.md) and the
   parts a video interview needs that it never had:

     markup       device check, briefing, the interview (header with the
                  round, "Question N of M" and a timer pill; camera | AI
                  panel 50/50; live transcript; control bar), the closing
                  screen - DM Sans, the owner's colours, SVG icons
     transcript   AI / You lines, the candidate's words live as a caption,
                  auto-scroll, aria-live="polite"
     recorder     one MediaRecorder per question (and per follow-up)
     uploads      each recording through the API's upload route, retried
                  with backoff, and the candidate told if one cannot be
                  saved
     network      "Reconnecting…" with backoff, and the interview resumes
                  on the same question
     store        the transcript and position in sessionStorage - per
                  viewer, for resilience only; the server is the record

   WHAT IT NEVER DOES. Show a score, a ranking or a decision; hold a key;
   fake a caption. Scores are computed on the server after the interview.
   ===================================================================== */
(function () {
  'use strict';

  var TLVI = window.TLVI = window.TLVI || {};
  TLVI.ownsSubmission = true;     // the integration layer leaves submission to the interview module

  function api() { return (window.TL && window.TL.api) || null; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function byId(id) { return document.getElementById(id); }
  var reduced = function () {
    try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  };

  /* ------------------------------------------------------------------ *
   * test-only configuration
   *
   * window.__TLVI_TEST__ = { answerSecs: 12 } is set by a test with
   * Playwright's addInitScript before the page loads. There is no query
   * parameter or setting that changes the timer in production.
   * ------------------------------------------------------------------ */
  TLVI.answerSecs = function (dflt) {
    var t = window.__TLVI_TEST__;
    var n = t && Number(t.answerSecs);
    return n && n >= 3 && n <= 600 ? Math.round(n) : dflt;
  };

  /* ------------------------------------------------------------------ *
   * styles and the font
   *
   * The portal's CSP already allows Google Fonts (helmet: style-src
   * fonts.googleapis.com, font-src fonts.gstatic.com), so DM Sans is
   * loaded from there - only when an interview screen is first drawn.
   * The stack falls back to the portal's own fonts if it cannot load.
   * ------------------------------------------------------------------ */
  var styled = false;
  TLVI.ensureStyles = function () {
    if (styled) return;
    styled = true;
    try {
      if (!document.querySelector('link[data-tlvi-font]')) {
        var l = document.createElement('link');
        l.rel = 'stylesheet';
        l.setAttribute('data-tlvi-font', '1');
        l.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap';
        document.head.appendChild(l);
      }
    } catch (e) { /* the stack below still renders */ }
    var css = document.createElement('style');
    css.id = 'tlviStyles';
    css.textContent = CSS;
    document.head.appendChild(css);
  };

  var CSS = [
    '.tlvi{--vi-accent:#5B2FC9;--vi-accent-ink:#ffffff;--vi-bg:#F3F4F8;--vi-text:#15192B;--vi-soft:#4A5068;',
    '--vi-bad:#B3261E;--vi-line:#D9DCE6;--vi-card:#ffffff;--vi-cam:#101524;--vi-ok:#1B7F4B;--vi-warn-bg:#FFF4DE;--vi-warn-ink:#7A4A00;--vi-warn-line:#E9A23B;',
    'font-family:"DM Sans",Inter,"Public Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--vi-text);',
    'background:var(--vi-bg);border-radius:20px;padding:20px;max-width:1280px;margin:0 auto;box-sizing:border-box;position:relative}',
    '.tlvi *,.tlvi *::before,.tlvi *::after{box-sizing:border-box}',
    '.tlvi-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap}',
    '.tlvi-round{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-variant:small-caps;color:var(--vi-accent)}',
    '.tlvi-qn{font-size:18px;font-weight:700;margin-top:2px}',
    '.tlvi-sub{font-size:13px;color:var(--vi-soft);margin-top:2px}',
    '.tlvi-timer{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:8px 16px;border-radius:999px;background:var(--vi-card);',
    'border:1px solid var(--vi-line);font-weight:700;font-size:18px;font-variant-numeric:tabular-nums;color:var(--vi-text);transition:background-color .3s,color .3s,border-color .3s}',
    '.tlvi-timer svg{width:20px;height:20px;flex:none}',
    '.tlvi-timer.is-warn{background:var(--vi-warn-bg);color:var(--vi-warn-ink);border-color:var(--vi-warn-line)}',
    '.tlvi-timer.is-idle{color:var(--vi-soft)}',
    '.tlvi-main{display:grid;grid-template-columns:1fr 1fr;gap:16px;min-height:400px}',
    '.tlvi-cam{position:relative;background:var(--vi-cam);border-radius:16px;overflow:hidden;min-height:400px;display:flex;align-items:center;justify-content:center}',
    '.tlvi-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1);background:var(--vi-cam)}',
    '.tlvi-cam-off{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#C9CEDD;font-size:14px;text-align:center;padding:16px}',
    '.tlvi-cam-off svg{width:84px;height:84px}',
    '.tlvi-cam-on{position:absolute;top:14px;left:14px;display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;background:rgba(16,21,36,.72);color:#fff;font-size:13px;font-weight:500}',
    '.tlvi-dot{width:9px;height:9px;border-radius:50%;background:#3DDC84;flex:none}',
    '.tlvi-cam-on.is-off .tlvi-dot{background:#9AA1B5}',
    '.tlvi-name{position:absolute;left:14px;bottom:14px;padding:6px 12px;border-radius:10px;background:rgba(16,21,36,.72);color:#fff;font-size:14px;font-weight:500}',
    '.tlvi-camwarn{position:absolute;left:14px;right:14px;top:56px;padding:10px 12px;border-radius:10px;background:var(--vi-warn-bg);color:var(--vi-warn-ink);font-size:13px;font-weight:500}',
    '.tlvi-ai{background:var(--vi-card);border:1px solid var(--vi-line);border-radius:16px;padding:20px;display:flex;flex-direction:column;min-height:400px}',
    '.tlvi-ai-top{display:flex;align-items:center;gap:12px}',
    '.tlvi-avatar{width:48px;height:48px;border-radius:50%;background:#EEE8FB;color:var(--vi-accent);display:flex;align-items:center;justify-content:center;flex:none}',
    '.tlvi-avatar svg{width:28px;height:28px}',
    '.tlvi-ai-name{font-weight:700;font-size:16px}',
    '.tlvi-ai-sub{font-size:13px;color:var(--vi-soft)}',
    '.tlvi-q{flex:1;display:flex;align-items:center;font-size:30px;line-height:1.3;font-weight:700;margin:16px 0;overflow-wrap:anywhere}',
    '.tlvi-q.is-long{font-size:24px}',
    '.tlvi-fu{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--vi-accent);margin-bottom:6px}',
    '.tlvi-ai-bottom{border-top:1px solid var(--vi-line);padding-top:12px}',
    '.tlvi-status{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500;color:var(--vi-soft);margin-bottom:10px}',
    '.tlvi-status svg{width:18px;height:18px;flex:none;color:var(--vi-accent)}',
    '.tlvi-meter{height:10px;border-radius:999px;background:#E7E9F1;overflow:hidden}',
    '.tlvi-meter>div{height:100%;width:100%;background:var(--vi-accent);transform-origin:left center;transform:scaleX(0);transition:transform .08s linear}',
    '.tlvi-tr{background:var(--vi-card);border:1px solid var(--vi-line);border-radius:16px;padding:14px 16px;margin-top:16px}',
    '.tlvi-tr-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px}',
    '.tlvi-tr-head h2{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin:0;color:var(--vi-text)}',
    '.tlvi-tr-head span{font-size:13px;color:var(--vi-soft)}',
    '.tlvi-lines{list-style:none;margin:0;padding:0;max-height:150px;overflow-y:auto;scroll-behavior:smooth}',
    '.tlvi-line{display:flex;gap:10px;padding:5px 0;font-size:15px;line-height:1.45}',
    '.tlvi-who{flex:none;min-width:34px;font-weight:700;font-size:12px;letter-spacing:.04em;padding-top:2px}',
    '.tlvi-line.ai .tlvi-who{color:var(--vi-accent)}',
    '.tlvi-line.you .tlvi-who{color:var(--vi-text)}',
    '.tlvi-line.you .tlvi-txt{color:var(--vi-text)}',
    '.tlvi-line.is-live .tlvi-txt{font-style:italic}',
    '.tlvi-livetag{flex:none;align-self:center;font-size:11px;font-weight:700;color:var(--vi-soft);border:1px solid var(--vi-line);border-radius:999px;padding:1px 8px}',
    '.tlvi-note{font-size:13px;color:var(--vi-soft);background:#F7F7FB;border:1px solid var(--vi-line);border-radius:10px;padding:8px 10px;margin-bottom:8px}',
    '.tlvi-controls{display:flex;justify-content:center;flex-wrap:wrap;gap:12px;margin-top:16px;padding:12px;background:var(--vi-bg);border-radius:16px}',
    '.tlvi-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;min-width:44px;padding:10px 18px;',
    'border-radius:12px;border:1px solid var(--vi-line);background:var(--vi-card);color:var(--vi-text);font:inherit;font-size:15px;font-weight:500;cursor:pointer}',
    '.tlvi-btn svg{width:20px;height:20px;flex:none}',
    '.tlvi-btn:hover{border-color:#B9BED0}',
    '.tlvi-btn:focus-visible{outline:3px solid var(--vi-accent);outline-offset:2px}',
    '.tlvi-btn[aria-pressed="true"]{background:#EEE8FB;border-color:var(--vi-accent);color:#3F1F94}',
    '.tlvi-btn.primary{background:var(--vi-accent);border-color:var(--vi-accent);color:var(--vi-accent-ink);font-weight:700}',
    '.tlvi-btn.primary:hover{background:#4C25AE}',
    '.tlvi-btn.danger{background:var(--vi-card);border-color:var(--vi-bad);color:var(--vi-bad);font-weight:700}',
    '.tlvi-btn.danger.solid{background:var(--vi-bad);color:#fff}',
    '.tlvi-btn[disabled]{opacity:.55;cursor:not-allowed}',
    '.tlvi-banner{position:sticky;top:8px;z-index:30;display:flex;align-items:center;gap:10px;padding:12px 16px;border-radius:12px;margin-bottom:12px;',
    'background:var(--vi-warn-bg);color:var(--vi-warn-ink);border:1px solid var(--vi-warn-line);font-weight:500}',
    '.tlvi-banner svg{width:20px;height:20px;flex:none}',
    '.tlvi-spin{animation:tlvi-spin 1.2s linear infinite}',
    '@keyframes tlvi-spin{to{transform:rotate(360deg)}}',
    '.tlvi-uploads{font-size:13px;color:var(--vi-soft);text-align:center;margin-top:10px;min-height:18px}',
    '.tlvi-uploads.is-bad{color:var(--vi-bad);font-weight:500}',
    '.tlvi-integrity{margin-top:12px;font-size:13px;color:var(--vi-soft)}',
    '.tlvi-integrity summary{cursor:pointer;min-height:44px;display:flex;align-items:center;font-weight:500}',
    '.tlvi-integrity summary:focus-visible{outline:3px solid var(--vi-accent);outline-offset:2px;border-radius:6px}',
    '.tlvi-integrity .panel{margin-top:4px !important}',
    /* device check */
    '.tlvi-checks h2{font-size:22px;margin:0 0 4px}',
    '.tlvi-checklist{list-style:none;margin:14px 0;padding:0;display:flex;flex-direction:column;gap:10px}',
    '.tlvi-check{display:flex;gap:12px;align-items:flex-start;padding:12px;border:1px solid var(--vi-line);border-radius:12px}',
    '.tlvi-check svg{width:22px;height:22px;flex:none;margin-top:1px}',
    '.tlvi-check b{display:block;font-size:15px}',
    '.tlvi-check span{font-size:13px;color:var(--vi-soft)}',
    '.tlvi-check[data-state="ok"] svg{color:var(--vi-ok)}',
    '.tlvi-check[data-state="fail"] svg{color:var(--vi-bad)}',
    '.tlvi-check[data-state="wait"] svg{color:var(--vi-soft)}',
    '.tlvi-check .tlvi-meter{margin-top:8px;max-width:260px}',
    '.tlvi-help{border:1px solid var(--vi-bad);border-radius:12px;padding:14px 16px;margin:4px 0 14px;background:#FFF6F5}',
    '.tlvi-help h3{margin:0 0 6px;font-size:16px;color:var(--vi-bad)}',
    '.tlvi-help ol{margin:6px 0 0;padding-left:20px;font-size:14px;line-height:1.55}',
    '.tlvi-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:auto;padding-top:8px}',
    '.tlvi-rules{font-size:13px;color:var(--vi-soft);margin:14px 0 0;padding-left:18px;line-height:1.55}',
    '.tlvi-done{background:var(--vi-card);border:1px solid var(--vi-line);border-radius:16px;padding:32px 24px;text-align:center;max-width:680px;margin:0 auto}',
    '.tlvi-done h2{font-size:24px;margin:12px 0 8px}',
    '.tlvi-done p{color:var(--vi-soft);font-size:15px;line-height:1.55;margin:0 auto 10px;max-width:520px}',
    '.tlvi-done .tlvi-actions{justify-content:center;margin-top:18px}',
    '.tlvi-tick{width:64px;height:64px;border-radius:50%;background:#E6F4EC;color:var(--vi-ok);display:flex;align-items:center;justify-content:center;margin:0 auto}',
    '.tlvi-tick svg{width:34px;height:34px}',
    /* the confirmation dialog */
    '.tlvi-modal{position:fixed;inset:0;z-index:9500;background:rgba(16,21,36,.55);display:flex;align-items:center;justify-content:center;padding:16px}',
    '.tlvi-dialog{font-family:"DM Sans",Inter,system-ui,sans-serif;background:#fff;color:#15192B;border-radius:16px;max-width:440px;width:100%;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.25)}',
    '.tlvi-dialog h2{margin:0 0 8px;font-size:20px}',
    '.tlvi-dialog p{margin:0 0 18px;color:#4A5068;font-size:15px;line-height:1.5}',
    '.tlvi-dialog .tlvi-actions{justify-content:flex-end}',
    /* small screens: stacked, controls sticky at the bottom */
    '@media (max-width:767px){',
    '.tlvi{padding:12px;border-radius:14px}',
    '.tlvi-main{grid-template-columns:1fr;min-height:0}',
    '.tlvi-cam{min-height:240px;aspect-ratio:4/3}',
    '.tlvi-ai{min-height:0}',
    '.tlvi-q{font-size:22px;margin:12px 0}',
    '.tlvi-q.is-long{font-size:19px}',
    '.tlvi-controls{position:sticky;bottom:0;z-index:20;margin:12px -12px -12px;border-radius:0 0 14px 14px;',
    'background:rgba(243,244,248,.97);box-shadow:0 -6px 18px rgba(16,21,36,.08);padding:10px 12px calc(10px + env(safe-area-inset-bottom))}',
    '.tlvi-controls .tlvi-btn{flex:1 1 calc(50% - 12px)}',
    '}',
    '@media (prefers-reduced-motion:reduce){',
    '.tlvi *,.tlvi-modal *{transition:none !important;animation:none !important;scroll-behavior:auto !important}',
    '}',
  ].join('');

  /* ------------------------------------------------------------------ *
   * icons (inline SVG, currentColor)
   * ------------------------------------------------------------------ */
  var I = {
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2" stroke-linecap="round"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke-linecap="round"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.6 5.3M19 11a7 7 0 0 1-.5 2.6M12 18v3M3 3l18 18" stroke-linecap="round"/></svg>',
    cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z" stroke-linejoin="round"/></svg>',
    camOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M16 16v1a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1M10 6h5a1 1 0 0 1 1 1v3l5-3v10M3 3l18 18" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12l5 5L20 7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    end: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 15.5c5-4.7 13-4.7 18 0l-2.3 2.3a1 1 0 0 1-1.3.1l-2.5-1.8a1 1 0 0 1-.4-.8v-1.6a11 11 0 0 0-5 0v1.6a1 1 0 0 1-.4.8l-2.5 1.8a1 1 0 0 1-1.3-.1z" stroke-linejoin="round"/></svg>',
    ai: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="4" y="7" width="16" height="12" rx="4"/><path d="M12 3v4M9 12h.01M15 12h.01M9.5 15.5c1.4 1 3.6 1 5 0" stroke-linecap="round"/></svg>',
    person: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="32" cy="32" r="29"/><circle cx="32" cy="26" r="10"/><path d="M14 52c3.5-8 10-12 18-12s14.5 4 18 12" stroke-linecap="round"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    fail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6" stroke-linecap="round"/></svg>',
    wait: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/></svg>',
    wifi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 8.5a15 15 0 0 1 20 0M5 12a10.5 10.5 0 0 1 14 0M8.5 15.5a5.5 5.5 0 0 1 7 0" stroke-linecap="round"/><circle cx="12" cy="19" r="1.3" fill="currentColor"/></svg>',
    sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 12a8 8 0 0 1-13.7 5.7M4 12a8 8 0 0 1 13.7-5.7M18 3v4h-4M6 21v-4h4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    speak: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 10v4h4l5 4V6L8 10z" stroke-linejoin="round"/><path d="M16.5 9a4 4 0 0 1 0 6" stroke-linecap="round"/></svg>',
  };
  TLVI.icons = I;

  /* ------------------------------------------------------------------ *
   * the round label
   * ------------------------------------------------------------------ */
  TLVI.roundLabel = function (q) {
    var s = (q && (q.section || q.cat)) || '';
    return { intro: 'Introduction', jd: 'Technical round', technical: 'Technical round',
      resume: 'Experience round', behavioral: 'Behavioral round' }[s] || 'Interview';
  };
  TLVI.firstName = function (name) {
    return String(name || '').trim().split(/\s+/)[0] || '';
  };
  TLVI.mmss = function (secs) {
    var s = Math.max(0, Math.round(secs || 0));
    var m = Math.floor(s / 60);
    return (m < 10 ? '0' : '') + m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  };

  /* ------------------------------------------------------------------ *
   * markup
   * ------------------------------------------------------------------ */

  function camPanel(ctx) {
    var live = !!ctx.live;
    var off = !live || ctx.camOff;
    return '<section class="tlvi-cam" aria-label="Your camera">'
      + (live ? '<video id="aiivVideo" class="tlvi-video" autoplay playsinline muted' + (ctx.camOff ? ' hidden' : '') + '></video>' : '')
      + '<div class="tlvi-cam-off"' + (off ? '' : ' hidden') + ' id="tlviCamOff">' + I.person
      + '<div>' + esc(ctx.offText || 'Camera off') + '</div></div>'
      + '<div class="tlvi-cam-on' + (off ? ' is-off' : '') + '" id="tlviCamBadge"><span class="tlvi-dot" aria-hidden="true"></span>'
      + '<span>' + (off ? 'Camera off' : (ctx.onText || 'Camera on')) + '</span></div>'
      + (ctx.camOff ? '<div class="tlvi-camwarn" role="alert">Your camera is off. Please turn it back on now — '
        + 'the interview ends if the camera stays off for 5 seconds.</div>' : '')
      + (ctx.name ? '<div class="tlvi-name">' + esc(ctx.name) + '</div>' : '')
      + '</section>';
  }

  function head(round, line, sub, timerHtml) {
    return '<header class="tlvi-head"><div><div class="tlvi-round">' + esc(round) + '</div>'
      + '<div class="tlvi-qn" id="tlviQn">' + esc(line) + '</div>'
      + (sub ? '<div class="tlvi-sub">' + esc(sub) + '</div>' : '') + '</div>'
      + (timerHtml || '') + '</header>';
  }

  function check(state, title, text, extra) {
    var icon = state === 'ok' ? I.ok : state === 'fail' ? I.fail : I.wait;
    var word = state === 'ok' ? 'passed' : state === 'fail' ? 'failed' : 'checking';
    return '<li class="tlvi-check" data-state="' + state + '">' + icon
      + '<div><b>' + esc(title) + ' <span class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">(' + word + ')</span></b>'
      + '<span>' + esc(text) + '</span>' + (extra || '') + '</div></li>';
  }

  /** Step-by-step help for a refused camera or microphone. */
  function permissionHelp(err) {
    var what = {
      denied: { h: 'Camera and microphone are blocked',
        p: 'The interview needs both. You can allow them in a few steps:' },
      notfound: { h: 'No camera or microphone was found',
        p: 'Connect a camera and a microphone (or a headset), then:' },
      busy: { h: 'Your camera or microphone is in use',
        p: 'Another app may be using it. Close it, then:' },
      unsupported: { h: 'This browser cannot open the camera here',
        p: 'The interview needs a secure (https) page in a current browser such as Chrome, Edge, Firefox or Safari.' },
    }[err] || { h: 'The camera could not be started', p: 'Please try the steps below:' };
    var steps = err === 'unsupported'
      ? '<li>Open this page in an up-to-date Chrome, Edge, Firefox or Safari.</li><li>Make sure the address starts with https://.</li><li>Press <b>Retry</b>.</li>'
      : '<li>Click the camera or padlock icon at the left of the address bar (on a phone, tap the address bar, then <b>Permissions</b> or <b>Site settings</b>).</li>'
        + '<li>Set <b>Camera</b> and <b>Microphone</b> to <b>Allow</b>.</li>'
        + '<li>Close other apps that may be using the camera, such as Zoom, Teams or WhatsApp.</li>'
        + '<li>Press <b>Retry</b>. If nothing changes, reload the page.</li>';
    return '<div class="tlvi-help" role="alert"><h3>' + esc(what.h) + '</h3><div style="font-size:14px">' + esc(what.p) + '</div>'
      + '<ol>' + steps + '</ol></div>';
  }

  /**
   * The device check: camera, microphone, internet, captions.
   * ctx: { job, company, name, camState, camErr, micHeard, net:{state,ms}, sttOk, ttsOk }
   */
  TLVI.deviceCheckHtml = function (ctx) {
    TLVI.ensureStyles();
    var on = ctx.camState === 'on';
    var failed = ctx.camState === 'denied' || ctx.camState === 'unsupported' || ctx.camState === 'error';
    var net = ctx.net || { state: 'wait' };
    var netText = net.state === 'ok' ? 'Connected' + (net.ms != null ? ' (' + net.ms + ' ms)' : '')
      : net.state === 'fail' ? 'Offline — check your connection' : 'Checking…';
    var ready = on && net.state === 'ok';
    return '<div class="tlvi" data-phase="check">'
      + head('Device check', 'Before your interview', ctx.job + (ctx.company ? ' · ' + ctx.company : ''))
      + '<div class="tlvi-main">'
      + camPanel({ live: on, name: ctx.name, onText: 'You are on camera',
          offText: failed ? 'Camera unavailable' : 'Your camera preview will appear here' })
      + '<section class="tlvi-ai tlvi-checks" aria-labelledby="tlviCheckH">'
      + '<h2 id="tlviCheckH">Let’s check your setup</h2>'
      + '<div class="tlvi-sub">It takes a few seconds. Nothing is recorded yet.</div>'
      + (failed ? permissionHelp(ctx.camErr || ctx.camState) : '')
      + '<ul class="tlvi-checklist">'
      + check(on ? 'ok' : failed ? 'fail' : 'wait', 'Camera', on ? 'Working — you can see yourself on the left.' : failed ? 'Not available yet.' : 'Waiting for permission.')
      + check(on ? (ctx.micHeard ? 'ok' : 'wait') : failed ? 'fail' : 'wait', 'Microphone',
          on ? (ctx.micHeard ? 'We can hear you.' : 'Say a few words to test it.') : failed ? 'Not available yet.' : 'Waiting for permission.',
          on ? '<div class="tlvi-meter" aria-hidden="true"><div id="aiivLevel"></div></div>' : '')
      + check(net.state, 'Internet', netText)
      + check(ctx.sttOk ? 'ok' : 'wait', 'Live captions', ctx.sttOk
          ? 'Your words will appear as you speak.'
          : 'Live captions aren’t available in this browser — your spoken answer is still recorded.')
      + '</ul>'
      + '<div class="tlvi-actions">'
      + (on
        ? '<button type="button" class="tlvi-btn primary" onclick="aiivBeginBriefing()"' + (ready ? '' : ' disabled aria-disabled="true"')
          + ' aria-label="Continue to the briefing">Continue — hear briefing</button>'
        : '<button type="button" class="tlvi-btn primary" onclick="aiivEnableCamera()" aria-label="'
          + (failed ? 'Retry camera and microphone' : 'Turn on camera and microphone') + '">'
          + I.cam + (failed ? 'Retry' : 'Turn on camera &amp; microphone') + '</button>')
      + (on && net.state === 'fail' ? '<button type="button" class="tlvi-btn" onclick="aiivRecheckNetwork()">Check connection again</button>' : '')
      + '<button type="button" class="tlvi-btn" onclick="navigate(\'/candidate-app/' + esc(ctx.ref) + '\')">Cancel</button>'
      + '</div>'
      + '</section></div>'
      + '<ul class="tlvi-rules"><li>Use a quiet, private room and keep your camera on for the whole interview.</li>'
      + '<li>Leaving this tab or window suspends the interview.</li>'
      + '<li>Each answer has a time limit; you can submit early when you are done.</li></ul>'
      + (ctx.integrity ? '<details class="tlvi-integrity"><summary>Interview rules and monitoring</summary>' + ctx.integrity + '</details>' : '')
      + '</div>';
  };

  /** The briefing: greeted by name, the round and the duration, then the conditions. */
  TLVI.briefingHtml = function (ctx) {
    TLVI.ensureStyles();
    return '<div class="tlvi" data-phase="briefing">'
      + head('Opening briefing', 'Your AI interview', ctx.job + (ctx.company ? ' · ' + ctx.company : ''))
      + '<div class="tlvi-main">'
      + camPanel({ live: ctx.live, name: ctx.name })
      + '<section class="tlvi-ai" aria-label="AI interviewer">'
      + '<div class="tlvi-ai-top"><div class="tlvi-avatar">' + I.ai + '</div><div><div class="tlvi-ai-name">AI Interviewer</div>'
      + '<div class="tlvi-ai-sub">Speaking the briefing</div></div></div>'
      + '<div class="tlvi-q is-long" id="aiivCaption">' + esc(ctx.greeting) + '</div>'
      + '<ul class="tlvi-rules" style="margin-top:0">' + (ctx.brief || []).map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>'
      + '<div class="tlvi-actions"><button type="button" class="tlvi-btn primary" onclick="aiivBeginQuestions()" aria-label="Start the questions">'
      + 'I am ready — start the questions</button></div>'
      + '</section></div></div>';
  };

  /**
   * The interview.
   * ctx: { round, n, total, question, followUp, name, live, camOff, micOff,
   *        secs, sttOk, integrity }
   */
  TLVI.interviewHtml = function (ctx) {
    TLVI.ensureStyles();
    var long = String(ctx.question || '').length > 120;
    var timer = '<div class="tlvi-timer is-idle" id="aiivTimer" role="timer" aria-label="Time left to answer">'
      + I.clock + '<span id="tlviTime">' + TLVI.mmss(ctx.secs) + '</span></div>';
    return '<div class="tlvi" data-phase="interview">'
      + '<div id="tlviBannerHost"></div>'
      + head(ctx.round, 'Question ' + ctx.n + ' of ' + ctx.total, '', timer)
      + '<div class="tlvi-main">'
      + camPanel({ live: ctx.live, camOff: ctx.camOff, name: ctx.name })
      + '<section class="tlvi-ai" aria-label="AI interviewer">'
      + '<div class="tlvi-ai-top"><div class="tlvi-avatar">' + I.ai + '</div><div><div class="tlvi-ai-name">AI Interviewer</div>'
      + '<div class="tlvi-ai-sub" id="tlviAsking">' + (ctx.followUp ? 'Follow-up to question ' + ctx.n : 'Asking question ' + ctx.n) + '</div></div></div>'
      + '<div class="tlvi-q' + (long ? ' is-long' : '') + '"><div>'
      + (ctx.followUp ? '<span class="tlvi-fu">Follow-up</span><br>' : '')
      + '<span id="aiivCaption">' + esc(ctx.question) + '</span></div></div>'
      + '<div class="tlvi-ai-bottom"><div class="tlvi-status" id="tlviStatusRow">' + I.speak + '<span id="aiivStatus">Preparing…</span></div>'
      + '<div class="tlvi-meter" aria-hidden="true"><div id="aiivLevel"></div></div></div>'
      + '</section></div>'
      + '<section class="tlvi-tr" aria-labelledby="tlviTrH">'
      + '<div class="tlvi-tr-head"><h2 id="tlviTrH">Live transcript</h2><span>Updates as you speak</span></div>'
      + (ctx.sttOk ? '' : '<div class="tlvi-note">Live captions aren’t available in this browser — your spoken answer is still recorded.</div>')
      + '<ol class="tlvi-lines" id="aiivTranscript" aria-live="polite" aria-relevant="additions" tabindex="0" aria-label="Interview transcript"></ol>'
      + '</section>'
      + '<div class="tlvi-controls" role="group" aria-label="Interview controls">'
      + '<button type="button" class="tlvi-btn" id="tlviMute" onclick="aiivToggleMic()" aria-pressed="' + (ctx.micOff ? 'true' : 'false') + '" aria-label="'
      + (ctx.micOff ? 'Unmute microphone' : 'Mute microphone') + '">' + (ctx.micOff ? I.micOff : I.mic) + '<span>' + (ctx.micOff ? 'Unmute' : 'Mute mic') + '</span></button>'
      + '<button type="button" class="tlvi-btn" id="tlviCam" onclick="aiivToggleCam()" aria-pressed="' + (ctx.camOff ? 'true' : 'false') + '" aria-label="'
      + (ctx.camOff ? 'Turn on camera' : 'Turn off camera') + '">' + (ctx.camOff ? I.camOff : I.cam) + '<span>' + (ctx.camOff ? 'Turn on camera' : 'Turn off camera') + '</span></button>'
      + '<button type="button" class="tlvi-btn primary" id="tlviSubmit" onclick="aiivSubmitAnswer()" aria-label="Submit answer">' + I.send + '<span>Submit answer</span></button>'
      + '<button type="button" class="tlvi-btn danger" id="tlviEnd" onclick="aiivEndInterview()" aria-label="End interview">' + I.end + '<span>End interview</span></button>'
      + '</div>'
      + '<div class="tlvi-uploads" id="tlviUploads" role="status" aria-live="polite"></div>'
      + (ctx.integrity ? '<details class="tlvi-integrity"><summary>Interview rules and monitoring</summary>' + ctx.integrity + '</details>' : '')
      + '</div>';
  };

  /** Submitting, failed to submit, or failed to plan. */
  TLVI.messageHtml = function (ctx) {
    TLVI.ensureStyles();
    return '<div class="tlvi" data-phase="' + esc(ctx.phase || 'message') + '"><div class="tlvi-done" role="' + (ctx.bad ? 'alert' : 'status') + '">'
      + '<div class="tlvi-tick" style="' + (ctx.bad ? 'background:#FDECEA;color:#B3261E' : 'background:#EEE8FB;color:#5B2FC9') + '">'
      + (ctx.bad ? I.fail : '<span class="tlvi-spin" style="display:inline-flex">' + I.sync + '</span>') + '</div>'
      + '<h2>' + esc(ctx.title) + '</h2><p>' + esc(ctx.text) + '</p>'
      + '<div class="tlvi-uploads" id="tlviUploads" role="status" aria-live="polite"></div>'
      + (ctx.actions ? '<div class="tlvi-actions">' + ctx.actions + '</div>' : '')
      + '</div></div>';
  };

  /** The close. Thanks, what happens next - and no score. */
  TLVI.completeHtml = function (ctx) {
    TLVI.ensureStyles();
    return '<div class="tlvi" data-phase="done"><div class="tlvi-done" role="status">'
      + '<div class="tlvi-tick">' + I.ok + '</div>'
      + '<h2>Thank you' + (ctx.first ? ', ' + esc(ctx.first) : '') + '. Your interview is complete.</h2>'
      + '<p>Your answers for <b>' + esc(ctx.job) + '</b> have been submitted to the TeamLink recruitment team.</p>'
      + '<p><b>What happens next:</b> the team reviews your interview and will contact you about the next step. '
      + 'You can follow your application under My Applications.</p>'
      + '<div class="tlvi-uploads" id="tlviUploads" role="status" aria-live="polite"></div>'
      + '<div class="tlvi-actions">'
      + '<button type="button" class="tlvi-btn" onclick="navigate(\'/candidate-app/' + esc(ctx.ref) + '\')">View Application</button>'
      + '<button type="button" class="tlvi-btn primary" onclick="navigate(\'/candidate/applications\')">My Applications</button>'
      + '</div></div></div>';
  };

  /* ------------------------------------------------------------------ *
   * in-place updates (no re-render while the candidate is answering)
   * ------------------------------------------------------------------ */

  TLVI.timer = function (secs, running) {
    var pill = byId('aiivTimer');
    var t = byId('tlviTime');
    if (t) t.textContent = TLVI.mmss(secs);
    if (pill) {
      pill.classList.toggle('is-warn', !!running && secs <= 10);
      pill.classList.toggle('is-idle', !running);
      pill.setAttribute('aria-label', 'Time left to answer: ' + Math.max(0, Math.round(secs)) + ' seconds');
    }
  };

  TLVI.meter = function (rms) {
    var el = byId('aiivLevel');
    if (!el) return;
    var v = Math.max(0, Math.min(1, (rms || 0) * 3.2));
    el.style.transform = 'scaleX(' + v.toFixed(3) + ')';
  };

  /** The device check heard the microphone: tick it in place, so the live camera is not re-created. */
  TLVI.micHeardNow = function () {
    var item = document.querySelectorAll('.tlvi-check')[1];
    if (!item) return;
    item.setAttribute('data-state', 'ok');
    var svg = item.querySelector('svg');
    if (svg) svg.outerHTML = I.ok;
    var sp = item.querySelector('div > span:last-of-type');
    if (sp) sp.textContent = 'We can hear you.';
    var b = item.querySelector('b span');
    if (b) b.textContent = '(passed)';
  };

  TLVI.status = function (text, icon) {
    var s = byId('aiivStatus');
    if (s) s.textContent = text;
    var row = byId('tlviStatusRow');
    if (row && icon && I[icon]) {
      var svg = row.querySelector('svg');
      if (svg) svg.outerHTML = I[icon];
    }
  };

  /* ------------------------------------------------------------------ *
   * the transcript
   * ------------------------------------------------------------------ */
  var lines = [];         // [{ who: 'AI'|'You', text, live }]
  TLVI.transcript = {
    reset: function (from) { lines = (from || []).slice(-200); },
    all: function () { return lines.slice(); },
    add: function (who, text) {
      // finalise any open caption first; an empty one is dropped
      lines = lines.filter(function (l) { return !(l.live && !l.text); });
      lines.forEach(function (l) { l.live = false; });
      lines.push({ who: who, text: String(text || ''), live: false });
      if (lines.length > 200) lines = lines.slice(-200);
      TLVI.transcript.paint();
    },
    live: function (text) {
      var last = lines[lines.length - 1];
      if (!last || !last.live) { last = { who: 'You', text: '', live: true }; lines.push(last); }
      last.text = String(text || '');
      TLVI.transcript.paint(true);
    },
    finish: function (text) {
      var last = lines[lines.length - 1];
      if (last && last.live) {
        if (text) { last.text = text; last.live = false; }
        else lines.pop();
      } else if (text) {
        lines.push({ who: 'You', text: text, live: false });
      }
      TLVI.transcript.paint();
    },
    paint: function (liveOnly) {
      var box = byId('aiivTranscript');
      if (!box) return;
      var nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
      if (liveOnly && box.lastElementChild && box.lastElementChild.classList.contains('is-live')) {
        var t = box.lastElementChild.querySelector('.tlvi-txt');
        var lastLine = lines[lines.length - 1];
        if (t && lastLine) t.textContent = lastLine.text;
      } else {
        box.innerHTML = lines.map(function (l) {
          return '<li class="tlvi-line ' + (l.who === 'AI' ? 'ai' : 'you') + (l.live ? ' is-live' : '') + '">'
            + '<span class="tlvi-who">' + (l.who === 'AI' ? 'AI' : 'You') + '</span>'
            + '<span class="tlvi-txt">' + esc(l.text) + '</span>'
            + (l.live ? '<span class="tlvi-livetag">Live caption</span>' : '') + '</li>';
        }).join('');
      }
      if (nearEnd || !liveOnly) box.scrollTop = box.scrollHeight;
    },
  };

  /* ------------------------------------------------------------------ *
   * sessionStorage: per viewer, for resilience only
   * ------------------------------------------------------------------ */
  var KEY = function (ref) { return 'tlvi:' + ref; };
  TLVI.store = {
    get: function (ref) {
      try { return JSON.parse(window.sessionStorage.getItem(KEY(ref)) || 'null'); } catch (e) { return null; }
    },
    save: function (ref, patch) {
      try {
        var cur = TLVI.store.get(ref) || {};
        for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) cur[k] = patch[k];
        cur.at = Date.now();
        window.sessionStorage.setItem(KEY(ref), JSON.stringify(cur));
      } catch (e) { /* storage blocked or full: the server still has everything */ }
    },
    clear: function (ref) { try { window.sessionStorage.removeItem(KEY(ref)); } catch (e) {} },
  };

  /* ------------------------------------------------------------------ *
   * the network: retries, the "Reconnecting…" banner, coming back
   * ------------------------------------------------------------------ */
  var listeners = [];
  var offline = false;
  TLVI.net = {
    online: function () { return !offline && navigator.onLine !== false; },
    onChange: function (fn) { listeners.push(fn); },
    emit: function (isOnline) {
      offline = !isOnline;
      TLVI.banner(!isOnline);
      listeners.forEach(function (fn) { try { fn(isOnline); } catch (e) { console.error('TeamLink: interview network listener failed.', e); } });
    },
    /** Is the API reachable? Resolves true/false, never rejects. */
    ping: function () {
      var a = api();
      if (!a) return Promise.resolve(false);
      var t0 = Date.now();
      return a.get('/health', { timeout: 6000 }).then(function () { TLVI.net.lastMs = Date.now() - t0; return true; },
        function () { return false; });
    },
  };
  window.addEventListener('offline', function () { TLVI.net.emit(false); });
  window.addEventListener('online', function () {
    // The browser says so; the API decides. Back off until it answers.
    var tries = 0;
    (function again() {
      TLVI.net.ping().then(function (ok) {
        if (ok) return TLVI.net.emit(true);
        tries += 1;
        setTimeout(again, Math.min(15000, 1000 * Math.pow(2, Math.min(tries, 4))));
      });
    })();
  });

  var bannerOn = false;
  TLVI.banner = function (show, text) {
    bannerOn = !!show;
    var host = byId('tlviBannerHost');
    if (!host) return;
    host.innerHTML = show
      ? '<div class="tlvi-banner" role="status" aria-live="assertive"><span class="tlvi-spin" style="display:inline-flex">' + I.sync + '</span>'
        + '<span>' + esc(text || 'Reconnecting… Your transcript is safe, and the interview will carry on from this question.') + '</span></div>'
      : '';
  };
  TLVI.bannerShown = function () { return bannerOn; };

  function retryable(err) {
    var s = err && err.status;
    if (!s) return true;                         // no response at all
    return s === 408 || s === 429 || s >= 500;
  }

  /**
   * Run `fn` (returning a promise) until it succeeds or fails for a reason
   * that retrying cannot fix. While it is retrying, "Reconnecting…" is on
   * screen. An answer is never dropped because the network blinked.
   */
  TLVI.persist = function (fn) {
    var attempt = 0;
    return new Promise(function (resolve, reject) {
      (function go() {
        fn().then(function (v) {
          if (attempt > 0 && TLVI.net.online()) TLVI.banner(false);
          resolve(v);
        }, function (err) {
          if (!retryable(err)) { if (attempt > 0) TLVI.banner(false); return reject(err); }
          attempt += 1;
          TLVI.banner(true);
          var wait = Math.min(15000, 800 * Math.pow(2, Math.min(attempt, 5)));
          if (navigator.onLine === false) {
            // wait for the browser to come back, then keep backing off
            var once = function () { window.removeEventListener('online', once); setTimeout(go, 600); };
            window.addEventListener('online', once);
          } else {
            setTimeout(go, wait);
          }
        });
      })();
    });
  };

  /* ------------------------------------------------------------------ *
   * the recorder: one MediaRecorder per answer
   * ------------------------------------------------------------------ */
  function pickType() {
    var MR = window.MediaRecorder;
    if (!MR || typeof MR.isTypeSupported !== 'function') return '';
    var types = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4'];
    for (var i = 0; i < types.length; i++) if (MR.isTypeSupported(types[i])) return types[i];
    return '';
  }
  var R = null;
  TLVI.recorder = {
    supported: function () { return typeof window.MediaRecorder === 'function'; },
    active: function () { return !!(R && R.rec && R.rec.state !== 'inactive'); },
    start: function (stream) {
      if (!stream || !TLVI.recorder.supported()) return false;
      if (R && R.rec && R.rec.state === 'paused') { try { R.rec.resume(); R.resumedAt = Date.now(); } catch (e) {} return true; }
      if (TLVI.recorder.active()) return true;
      try {
        var type = pickType();
        var opts = { videoBitsPerSecond: 350000, audioBitsPerSecond: 48000 };
        if (type) opts.mimeType = type;
        var rec = new window.MediaRecorder(stream, opts);
        /* The chunks belong to THIS recorder, not to whichever one is current:
           the last chunk arrives after the next question may already have
           started its own recorder. */
        var mine = { rec: rec, chunks: [], started: Date.now() };
        R = mine;
        rec.ondataavailable = function (e) { if (e.data && e.data.size) mine.chunks.push(e.data); };
        rec.start(1000);
        return true;
      } catch (e) {
        console.error('TeamLink: the answer could not be recorded on this device.', e);
        R = null;
        return false;
      }
    },
    pause: function () {
      if (R && R.rec && R.rec.state === 'recording') { try { R.rec.pause(); R.pausedAt = Date.now(); } catch (e) {} }
    },
    /** @returns Promise<{ blob, durationMs } | null> */
    stop: function () {
      var cur = R;
      R = null;
      if (!cur || !cur.rec) return Promise.resolve(null);
      return new Promise(function (resolve) {
        var done = false;
        var finish = function () {
          if (done) return; done = true;
          var type = (cur.rec.mimeType || 'video/webm').split(';')[0];
          var blob = cur.chunks.length ? new Blob(cur.chunks, { type: type }) : null;
          resolve(blob && blob.size ? { blob: blob, durationMs: Date.now() - cur.started } : null);
        };
        cur.rec.onstop = finish;
        try { if (cur.rec.state !== 'inactive') cur.rec.stop(); else finish(); } catch (e) { finish(); }
        setTimeout(finish, 3000);
      });
    },
  };

  /* ------------------------------------------------------------------ *
   * uploads: through the API's own upload route, retried, and reported
   * ------------------------------------------------------------------ */
  var queue = [];
  var busy = false;
  var failedHard = [];
  TLVI.uploads = {
    pending: function () { return queue.length + (busy ? 1 : 0); },
    failed: function () { return failedHard.slice(); },
    add: function (job) { queue.push(job); TLVI.uploads.paint(); pump(); },
    /** Resolves when every queued upload has either landed or failed for good. */
    drained: function () {
      return new Promise(function (resolve) {
        (function wait() { if (!busy && !queue.length) return resolve(); setTimeout(wait, 300); })();
      });
    },
    paint: function () {
      var el = byId('tlviUploads');
      if (!el) return;
      var n = TLVI.uploads.pending();
      el.classList.toggle('is-bad', failedHard.length > 0);
      el.textContent = failedHard.length
        ? failedHard.length + ' answer recording' + (failedHard.length > 1 ? 's' : '') + ' could not be saved ('
          + failedHard[0].why + '). Your spoken answers were still saved as text.'
        : n ? 'Saving ' + n + ' answer recording' + (n > 1 ? 's' : '') + '… please keep this page open.'
        : '';
    },
  };
  function pump() {
    if (busy || !queue.length) return;
    var job = queue[0];
    busy = true;
    TLVI.uploads.paint();
    var send = function () {
      var a = api();
      if (!a) return Promise.reject({ status: 0 });
      var fd = new FormData();
      fd.append('seq', String(job.seq));
      fd.append('part', job.part || 'main');
      fd.append('durationMs', String(Math.round(job.durationMs || 0)));
      var ext = /mp4/.test(job.blob.type) ? 'mp4' : 'webm';
      fd.append('recording', job.blob, 'answer-' + job.seq + '-' + (job.part || 'main') + '.' + ext);
      return a.post('/ai-interviews/' + encodeURIComponent(job.interviewId) + '/recordings', fd, { timeout: 120000 });
    };
    var attempt = 0;
    (function go() {
      send().then(function () {
        queue.shift(); busy = false; TLVI.uploads.paint(); pump();
      }, function (err) {
        if (retryable(err) && attempt < 12) {
          attempt += 1;
          var el = byId('tlviUploads');
          if (el) el.textContent = 'Saving your answer recording is taking longer than usual — retrying…';
          var wait = Math.min(20000, 1000 * Math.pow(2, Math.min(attempt, 5)));
          if (navigator.onLine === false) {
            var once = function () { window.removeEventListener('online', once); setTimeout(go, 800); };
            window.addEventListener('online', once);
          } else setTimeout(go, wait);
          return;
        }
        // A refusal that will not change on retry: say so, keep the rest going.
        failedHard.push({ seq: job.seq, part: job.part, why: (err && err.message) || 'the server refused it' });
        console.error('TeamLink: an answer recording could not be saved.', err);
        queue.shift(); busy = false; TLVI.uploads.paint(); pump();
      });
    })();
  }

  /* ------------------------------------------------------------------ *
   * the confirmation dialog - keyboard-first
   * ------------------------------------------------------------------ */
  TLVI.confirm = function (o) {
    TLVI.ensureStyles();
    return new Promise(function (resolve) {
      var back = document.activeElement;
      var wrap = document.createElement('div');
      wrap.className = 'tlvi-modal';
      wrap.innerHTML = '<div class="tlvi-dialog" role="alertdialog" aria-modal="true" aria-labelledby="tlviDlgH" aria-describedby="tlviDlgP">'
        + '<h2 id="tlviDlgH">' + esc(o.title) + '</h2><p id="tlviDlgP">' + esc(o.text) + '</p>'
        + '<div class="tlvi-actions"><button type="button" class="tlvi-btn" data-x="no">' + esc(o.cancel || 'Cancel') + '</button>'
        + '<button type="button" class="tlvi-btn danger solid" data-x="yes">' + esc(o.ok || 'OK') + '</button></div></div>';
      var close = function (v) {
        document.removeEventListener('keydown', onKey, true);
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        try { if (back && back.focus) back.focus(); } catch (e) {}
        resolve(v);
      };
      var onKey = function (e) {
        if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
        if (e.key === 'Tab') {
          var f = wrap.querySelectorAll('button');
          var first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      };
      wrap.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('button[data-x]');
        if (b) close(b.getAttribute('data-x') === 'yes');
        else if (e.target === wrap) close(false);
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(wrap);
      // the safe choice has the focus
      setTimeout(function () { var c = wrap.querySelector('[data-x="no"]'); if (c) c.focus(); }, 0);
    });
  };

  TLVI.reducedMotion = reduced;
})();
