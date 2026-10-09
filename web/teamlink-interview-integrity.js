/* =====================================================================
   TEAMLINK — AI interview: another person, another voice, two strikes

   WHAT WAS ALREADY THERE. The interview page proctors three things and
   ends the session on any of them: leaving the tab, continuous
   background noise, and a camera that is off or covered. Its own panel
   said, correctly, that "whether anyone else is in the room" is NOT
   checked, because that needs a face model the page does not load.

   WHAT THIS ADDS. That check, plus a second-voice check, under a
   different rule from the three above:

       violation 1  ->  warn, keep going
       violation 2  ->  suspend, a recruiter decides

   and one counter shared between them, so a person then a voice is two
   strikes rather than one each.

   THE COUNTER IS NOT HERE. It is in the database. This file reports what
   it saw; the server answers with the strike number, the words to show
   and whether the interview may continue. A counter in this file would
   be a counter a reload clears.

   WHAT IS HONEST ABOUT THE DETECTION
   ----------------------------------
   Face counting is real: a face detector runs on the video and counts
   faces. When no detector can be loaded the check is reported as
   UNAVAILABLE and raises nothing - a feature that cannot run must not
   pretend it ran.

   Second-voice detection in a browser is APPROXIMATE and is treated as
   such. It has no speaker model; it learns the pitch of whoever is
   answering and flags sustained voiced audio well outside that range, or
   voiced audio while the candidate should be silent AND at a pitch the
   candidate has never produced. Both need a long confirmation window and
   several agreeing samples. It is evidence for a recruiter to look at,
   which is exactly what the brief asks a flag to be - not a verdict.

   NOTHING EXISTING IS REPLACED. proctorSample, proctorStop and the noise
   and camera rules are untouched; this runs beside them.
   ===================================================================== */
(function () {
  'use strict';

  var API = function () { return (window.TL && window.TL.api) || null; };

  /* ------------------------------------------------------------------ *
   * thresholds — every one of them configurable (§5)
   * ------------------------------------------------------------------ */
  var CFG = window.TL_INTEGRITY_CONFIG = window.TL_INTEGRITY_CONFIG || {};
  function n(key, dflt) { return Number(CFG[key] === undefined ? dflt : CFG[key]); }

  var T = {
    /* ---- another person ---- */
    faceEveryMs:      function () { return n('faceEveryMs', 700); },
    /* A single frame with two faces is a frame, not a person. Two faces
       must hold for this long AND across this many agreeing samples. */
    facePersistMs:    function () { return n('facePersistMs', 3000); },
    faceSamples:      function () { return n('faceSamples', 4); },
    faceMinScore:     function () { return n('faceMinScore', 0.6); },

    /* ---- another voice ---- */
    voicePersistMs:   function () { return n('voicePersistMs', 2500); },
    voiceSamples:     function () { return n('voiceSamples', 6); },
    /* How far from the candidate's own pitch counts as "not them",
       in semitones. Six semitones is half an octave - wide enough that
       the same person raising their voice does not trip it. */
    voiceSemitones:   function () { return n('voiceSemitones', 6); },
    /* Below this the pitch estimate is not trustworthy enough to accuse
       anybody with. */
    voiceClarity:     function () { return n('voiceClarity', 0.9); },
    voiceMinLevel:    function () { return n('voiceMinLevel', 0.055); },
    /* The candidate's own range has to be learnt before anything can be
       outside it. */
    baselineSamples:  function () { return n('baselineSamples', 25); },

    /* One report per this long, whatever fires. Two detectors both
       screaming must not spend both strikes in the same second. */
    cooldownMs:       function () { return n('cooldownMs', 12000); },
  };

  /* ------------------------------------------------------------------ *
   * state
   * ------------------------------------------------------------------ */
  var S = null;
  function reset() {
    S = {
      interviewId: null,
      running: false,
      strikes: 0,
      suspended: false,
      lastReportAt: 0,
      busy: false,

      face: { available: null, why: '', detector: null, timer: null,
              sustainedMs: 0, samples: 0, lastAt: 0, seen: 0 },
      voice: { baseline: [], baselineHz: 0, sustainedMs: 0, samples: 0,
               lastHz: 0, lastAt: 0 },

      banner: null,
    };
  }
  reset();

  /* ------------------------------------------------------------------ *
   * the face detector
   *
   * Native FaceDetector where the browser has it, MediaPipe from the CDN
   * the page's CSP already allows otherwise, and an honest "unavailable"
   * when neither can be had.
   * ------------------------------------------------------------------ */
  function loadFaceDetector() {
    if (S.face.detector || S.face.available === false) return Promise.resolve(S.face.detector);

    /* 1. the browser's own, when it is really there. Chrome ships the
          constructor behind a flag, so it is CALLED rather than tested
          for - a constructor that throws is not a detector. */
    try {
      if (typeof window.FaceDetector === 'function') {
        var native = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 5 });
        if (native && typeof native.detect === 'function') {
          S.face.detector = {
            kind: 'native',
            count: function (video) {
              return native.detect(video).then(function (fs) { return (fs || []).length; });
            },
          };
          S.face.available = true;
          return Promise.resolve(S.face.detector);
        }
      }
    } catch (e) { /* fall through to MediaPipe */ }

    /* 2. MediaPipe Tasks Vision, from cdn.jsdelivr.net - the origin the
          application's Content-Security-Policy already permits for
          scripts. Loaded once, when an interview starts, not on boot. */
    return import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14')
      .then(function (vision) {
        return vision.FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
        ).then(function (files) {
          return vision.FaceDetector.createFromOptions(files, {
            baseOptions: {
              modelAssetPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/'
                + 'models/blaze_face_short_range.tflite',
            },
            runningMode: 'VIDEO',
            minDetectionConfidence: T.faceMinScore(),
          });
        });
      })
      .then(function (fd) {
        S.face.detector = {
          kind: 'mediapipe',
          count: function (video) {
            var out = fd.detectForVideo(video, performance.now());
            var list = (out && out.detections) || [];
            var min = T.faceMinScore();
            return Promise.resolve(list.filter(function (d) {
              var c = d.categories && d.categories[0];
              return !c || c.score === undefined || c.score >= min;
            }).length);
          },
        };
        S.face.available = true;
        return S.face.detector;
      })
      .catch(function (err) {
        /* NO DETECTOR MEANS NO DETECTION, and the panel says so. It does
           not mean "assume one person" and it certainly does not mean
           raising a violation on some other signal instead. */
        S.face.available = false;
        S.face.why = (err && err.message) ? String(err.message).slice(0, 120) : 'could not be loaded';
        return null;
      });
  }

  /* ------------------------------------------------------------------ *
   * the face loop
   * ------------------------------------------------------------------ */
  function faceTick() {
    if (!S.running || S.suspended) return;
    var det = S.face.detector;
    var video = document.getElementById('aiivVideo');
    if (!det || !video || !video.videoWidth) return;

    var now = performance.now();
    var dt = S.face.lastAt ? (now - S.face.lastAt) : T.faceEveryMs();
    S.face.lastAt = now;

    Promise.resolve(det.count(video)).then(function (count) {
      S.face.seen = count;
      if (count >= 2) {
        S.face.sustainedMs += dt;
        S.face.samples += 1;
        if (S.face.sustainedMs >= T.facePersistMs() && S.face.samples >= T.faceSamples()) {
          var held = S.face.sustainedMs;
          var agreed = S.face.samples;
          S.face.sustainedMs = 0; S.face.samples = 0;
          report('additional_person',
            /* Confidence from how long it held and how many samples
               agreed, not from a number invented for the occasion. */
            Math.min(0.99, 0.6 + Math.min(0.3, (held - T.facePersistMs()) / 20000)
                              + Math.min(0.09, (agreed - T.faceSamples()) * 0.01)),
            { detector: det.kind, faces: count, sustainedMs: Math.round(held),
              samples: agreed, agreeing: agreed });
        }
      } else {
        /* Decays rather than resetting to zero: somebody stepping in and
           out of frame repeatedly should still accumulate, but a single
           stray frame must not. */
        S.face.sustainedMs = Math.max(0, S.face.sustainedMs - dt * 1.5);
        if (S.face.sustainedMs === 0) S.face.samples = 0;
      }
    }).catch(function () { /* one failed frame proves nothing */ });
  }

  /* ------------------------------------------------------------------ *
   * pitch, for the voice check
   *
   * Autocorrelation over the time-domain buffer the interview page's
   * analyser already produces. Returns { hz, clarity } or null.
   * ------------------------------------------------------------------ */
  function pitchOf(analyser) {
    try {
      if (!analyser) return null;
      var N = analyser.fftSize;
      var buf = new Float32Array(N);
      if (analyser.getFloatTimeDomainData) analyser.getFloatTimeDomainData(buf);
      else {
        var b8 = new Uint8Array(N);
        analyser.getByteTimeDomainData(b8);
        for (var k = 0; k < N; k++) buf[k] = (b8[k] - 128) / 128;
      }

      var rms = 0;
      for (var i = 0; i < N; i++) rms += buf[i] * buf[i];
      rms = Math.sqrt(rms / N);
      if (rms < T.voiceMinLevel()) return null;

      var rate = (analyser.context && analyser.context.sampleRate) || 48000;
      /* 70-350 Hz covers adult speech at both ends without straying into
         the range where a hum reads as a voice. */
      var minLag = Math.floor(rate / 350);
      var maxLag = Math.floor(rate / 70);
      if (maxLag >= N) maxLag = N - 1;

      var best = -1, bestLag = -1;
      for (var lag = minLag; lag <= maxLag; lag++) {
        var sum = 0;
        for (var j = 0; j < N - lag; j++) sum += buf[j] * buf[j + lag];
        sum /= (N - lag);
        if (sum > best) { best = sum; bestLag = lag; }
      }
      if (bestLag < 0) return null;

      var energy = 0;
      for (var m = 0; m < N; m++) energy += buf[m] * buf[m];
      energy /= N;
      var clarity = energy > 0 ? best / energy : 0;
      if (clarity < T.voiceClarity()) return null;      /* not periodic enough to be speech */

      return { hz: rate / bestLag, clarity: clarity, rms: rms };
    } catch (e) { return null; }
  }

  function semitones(a, b) {
    if (!a || !b) return 0;
    return Math.abs(12 * Math.log2(a / b));
  }

  function median(list) {
    if (!list.length) return 0;
    var s = list.slice().sort(function (x, y) { return x - y; });
    return s[Math.floor(s.length / 2)];
  }

  /**
   * One audio sample.
   *
   * Called from the interview page's own frame loop via the hook below,
   * so this adds no timer of its own.
   *
   * @param dt          ms since the last sample
   * @param answering   is the candidate supposed to be speaking right now?
   */
  function voiceTick(dt, answering) {
    if (!S.running || S.suspended) return;
    var analyser = window.AIIV && window.AIIV.analyser;
    var p = pitchOf(analyser);
    if (!p) {
      S.voice.sustainedMs = Math.max(0, S.voice.sustainedMs - dt * 1.5);
      if (S.voice.sustainedMs === 0) S.voice.samples = 0;
      return;
    }
    S.voice.lastHz = p.hz;

    /* ---- learning the candidate ------------------------------------
       Only while THEY are answering, because that is the only audio this
       page can attribute to them with any confidence at all. */
    if (answering) {
      if (S.voice.baseline.length < 400) S.voice.baseline.push(p.hz);
      S.voice.baselineHz = median(S.voice.baseline);
      /* Their own voice cannot be somebody else's. */
      S.voice.sustainedMs = Math.max(0, S.voice.sustainedMs - dt);
      return;
    }

    /* ---- not answering: who is talking? ---------------------------- */
    if (S.voice.baseline.length < T.baselineSamples()) return;   /* nothing to compare to yet */

    var away = semitones(p.hz, S.voice.baselineHz);
    if (away >= T.voiceSemitones()) {
      S.voice.sustainedMs += dt;
      S.voice.samples += 1;
      if (S.voice.sustainedMs >= T.voicePersistMs() && S.voice.samples >= T.voiceSamples()) {
        var held = S.voice.sustainedMs, agreed = S.voice.samples;
        S.voice.sustainedMs = 0; S.voice.samples = 0;
        report('additional_voice',
          Math.min(0.95, 0.6 + Math.min(0.25, (away - T.voiceSemitones()) * 0.03)
                            + Math.min(0.1, (agreed - T.voiceSamples()) * 0.01)),
          { detector: 'pitch-baseline', sustainedMs: Math.round(held), samples: agreed,
            agreeing: agreed, pitchHz: p.hz, baselineHz: S.voice.baselineHz,
            note: 'voiced speech ' + away.toFixed(1) + ' semitones from the candidate’s '
                + 'own pitch, while they were not answering' });
      }
    } else {
      S.voice.sustainedMs = Math.max(0, S.voice.sustainedMs - dt * 1.5);
      if (S.voice.sustainedMs === 0) S.voice.samples = 0;
    }
  }

  /* ------------------------------------------------------------------ *
   * reporting — the server decides
   * ------------------------------------------------------------------ */
  function report(type, confidence, evidence) {
    var api = API();
    if (!api || !S.interviewId || S.busy || S.suspended) return;
    var now = Date.now();
    if (now - S.lastReportAt < T.cooldownMs()) return;
    S.lastReportAt = now;
    S.busy = true;

    evidence = evidence || {};
    if (typeof window.tlCurrentQuestionNo === 'function') evidence.questionSeq = window.tlCurrentQuestionNo();
    api.post('/ai-interviews/' + encodeURIComponent(S.interviewId) + '/integrity', {
      type: type, confidence: Number(confidence.toFixed(3)), evidence: evidence,
    }).then(function (r) {
      S.busy = false;
      S.strikes = r.strike;
      if (r.action === 'warn') {
        showWarning(r.strike, r.message);
      } else {
        S.suspended = true;
        stop();
        suspend(r.message, r.retakeAvailableAt);
      }
    }).catch(function () {
      S.busy = false;
      /* A failed report must not invent a strike locally: the count only
         ever comes back from the server. The observation is dropped and
         the detectors carry on. */
    });
  }

  /* ------------------------------------------------------------------ *
   * what the candidate sees
   *
   * §6: the strike number and plain words. No confidence figures - the
   * candidate is not the audience for those.
   * ------------------------------------------------------------------ */
  function showWarning(strike, message) {
    dismissBanner();
    var el = document.createElement('div');
    el.className = 'tlig-warn';
    el.setAttribute('role', 'alert');
    el.innerHTML = '<div class="tlig-w-n">Warning ' + strike + '/2</div>'
      + '<div class="tlig-w-m"></div>'
      + '<button type="button" class="tlig-w-x" aria-label="Dismiss">✕</button>';
    el.querySelector('.tlig-w-m').textContent = message;
    el.querySelector('.tlig-w-x').onclick = dismissBanner;
    document.body.appendChild(el);
    S.banner = el;
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
    setTimeout(dismissBanner, 20000);
  }
  function dismissBanner() {
    if (S.banner && S.banner.parentNode) S.banner.parentNode.removeChild(S.banner);
    S.banner = null;
  }

  /**
   * Strike two.
   *
   * The page's own `proctorStop` already owns the "interview stopped"
   * screen, its wording and its rendering, so this hands the message to
   * it rather than building a second stopped screen beside it. The
   * SERVER has already set the status to suspended; this is the display.
   */
  function suspend(message, retakeAt) {
    dismissBanner();
    if (typeof window.tlProctorStop === 'function') {
      window.tlProctorStop('integrity_violation', message, retakeAt);
      return;
    }
    /* The hook is installed below, so this is only reached if the
       interview page changed shape. Saying it plainly beats silence. */
    var el = document.createElement('div');
    el.className = 'tlig-susp';
    el.innerHTML = '<div class="tlig-s-box"><h3>Interview Suspended</h3><p></p></div>';
    el.querySelector('p').textContent = message;
    document.body.appendChild(el);
  }

  /* ------------------------------------------------------------------ *
   * start / stop
   * ------------------------------------------------------------------ */
  window.tlIntegrityStart = function (interviewId) {
    reset();
    S.interviewId = interviewId || null;
    S.running = true;
    if (!S.interviewId) return;           /* nothing to report against */

    loadFaceDetector().then(function (det) {
      if (!det || !S.running) return;
      S.face.timer = setInterval(faceTick, T.faceEveryMs());
    });
  };

  window.tlIntegrityStop = stop;
  function stop() {
    S.running = false;
    if (S.face.timer) { clearInterval(S.face.timer); S.face.timer = null; }
    dismissBanner();
  }

  /** What the live panel shows about these two checks. */
  window.tlIntegrityState = function () {
    return {
      running: S.running,
      strikes: S.strikes,
      suspended: S.suspended,
      person: S.face.available === null ? 'starting'
            : S.face.available === false ? 'unavailable'
            : (S.face.seen >= 2 ? 'another person in view' : 'you are alone in view'),
      personWhy: S.face.why,
      personDetector: S.face.detector ? S.face.detector.kind : null,
      voice: S.voice.baseline.length < T.baselineSamples()
        ? 'learning your voice' : 'watching for another voice',
    };
  };

  /* ------------------------------------------------------------------ *
   * hooking into the interview page
   *
   * Three seams, all of them wrappers - the originals keep running
   * exactly as they did.
   * ------------------------------------------------------------------ */

  /* 1. proctorStop is a private function of the interview module, so the
        module exposes nothing to call. The session's own stop path is
        reached instead through AIIV's phase, which IS global. */
  window.tlProctorStop = function (kind, message, retakeAt) {
    try {
      var A = window.AIIV;
      if (!A || !A.started) return;
      if (!A.integrity) A.integrity = { events: [], noiseMs: 0, camLostMs: 0 };
      A.integrity.events.push({ kind: kind, detail: message, at: new Date().toISOString() });
      A.integrity.ended = { kind: kind, message: message, retakeAt: retakeAt || null, at: new Date().toISOString() };
      A.listening = false;
      A.phase = 'stopped';
      try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
      if (typeof window.render === 'function') window.render();
    } catch (e) { /* the banner above is still on screen either way */ }
  };

  /* 2. the answer loop, for audio samples. The interview page calls
        proctorSample() every frame whether or not the candidate is
        answering, which is exactly the cadence this needs. */
  (function hookSample() {
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (tries > 60) { clearInterval(timer); return; }
      /* proctorSample is module-private; the public seam is AIIV itself.
         A light frame loop of our own is used instead, started and
         stopped with the interview, so nothing inside that module has to
         change for this to work. */
      if (window.AIIV) {
        clearInterval(timer);
        var last = performance.now();
        setInterval(function () {
          var A = window.AIIV;
          if (!A || !A.started || !S.running) return;
          if (A.phase !== 'interview' && A.phase !== 'briefing') return;
          var now = performance.now();
          var dt = now - last; last = now;
          /* The interviewer's own voice, the gap after Submit and the tail of
             the candidate's last words are not "another voice". Judged only
             in a stretch the page itself says is quiet (or while the
             candidate is answering, which only teaches their baseline). */
          if (!A.listening && typeof window.tlRoomShouldBeQuiet === 'function' && !window.tlRoomShouldBeQuiet()) {
            S.voice.sustainedMs = 0; S.voice.samples = 0;
            return;
          }
          voiceTick(dt, !!A.listening);
        }, 120);
      }
    }, 500);
  })();

  /* 3. the session response carries the interview id; that is the moment
        to start watching. TL.api is wrapped rather than the interview
        page, so no existing call site changes. */
  (function hookSession() {
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (tries > 60) { clearInterval(timer); return; }
      var api = API();
      if (!api || api.__tligWrapped) return;
      clearInterval(timer);
      var post = api.post;
      api.post = function (path, body, opts) {
        var out = post.call(this, path, body, opts);
        if (path === '/ai-interviews/session') {
          out.then(function (r) {
            if (r && r.interviewId) window.tlIntegrityStart(r.interviewId);
          }).catch(function () {});
        } else if (/\/ai-interviews\/[^/]+\/finish$/.test(String(path))) {
          out.then(stop).catch(stop);
        }
        return out;
      };
      api.__tligWrapped = true;
    }, 400);
  })();

  /* ================================================================== *
   * THE RECRUITER'S SIDE (§7)
   *
   * Appended to the existing Interviews page as one more panel. The page
   * itself is not touched: pageRecruiterDash is wrapped, the original
   * runs and returns its html, and the panel is added after it.
   * ================================================================== */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function when(t) {
    if (!t) return '—';
    try { return new Date(t).toLocaleString(); } catch (e) { return String(t); }
  }

  function statusPill(s) {
    var cls = s === 'suspended' ? 'tlig-p-susp' : s === 'warning' ? 'tlig-p-warn' : 'tlig-p-none';
    var txt = s === 'suspended' ? 'Suspended' : s === 'warning' ? 'Warning Issued'
            : s === 'under_review' ? 'Under Recruiter Review'
            : s === 'cleared' ? 'Cleared' : 'No Violation';
    return '<span class="tlig-pill ' + cls + '">' + txt + '</span>';
  }

  /* The reason, where it happened, how often, and what the candidate can
     do next - the same sentence the candidate and the email carry. */
  function suspensionBlock(interviewId, r) {
    if (!r.suspensionMessage && !(r.attempts && r.attempts.length > 1)) return '';
    var id = esc(interviewId);
    var retake = r.retakeBlocked ? 'Blocked by a recruiter'
      : (r.retakeAvailableAt ? (r.retakeOpen ? 'Open now' : 'Opens ' + when(r.retakeAvailableAt))
        : (r.status === 'suspended' ? 'No retake scheduled — with the recruiter' : '—'));
    var attempts = (r.attempts || []).length > 1 || (r.attempts || []).some(function (a) { return a.status === 'suspended'; })
      ? '<table class="tlig-tbl" style="margin-top:8px"><thead><tr><th>Attempt</th><th>Status</th><th>Started</th>'
        + '<th>Reason</th><th>Score</th></tr></thead><tbody>'
        + r.attempts.map(function (a) {
          return '<tr><td>' + a.attemptNumber + '</td>'
            + '<td>' + (a.status === 'suspended' ? 'Suspended' : esc(a.status)) + '</td>'
            + '<td>' + when(a.startedAt) + '</td>'
            + '<td>' + esc(a.suspensionMessage || '—') + '</td>'
            + '<td>' + (a.score == null ? '—' : Math.round(a.score) + '%') + '</td></tr>';
        }).join('') + '</tbody></table>'
        + '<div class="tlig-ev" style="margin-top:4px">Current score: <b>'
        + (r.currentScore == null ? 'none yet' : Math.round(r.currentScore) + '%')
        + '</b> — the latest completed attempt. A suspended attempt has no score.</div>'
      : '';
    var controls = r.status === 'suspended'
      ? '<div style="margin-top:10px"><input class="tlig-note" id="tligRetakeWhy" placeholder="Reason (recorded)">'
        + '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">'
        + (r.retakeBlocked
          ? '<button class="btn btn-ghost btn-sm" onclick="tlRetakeControl(\'' + id + '\',\'unblock\')">Allow retake</button>'
          : '<button class="btn btn-ghost btn-sm" onclick="tlRetakeControl(\'' + id + '\',\'block\')">Block retake</button>')
        + '<button class="btn btn-ghost btn-sm" onclick="tlRetakeControl(\'' + id + '\',\'extra_attempt\')">Grant another attempt now</button>'
        + '</div></div>'
      : '';
    return '<div class="tlig-sec"><h4>' + (r.status === 'suspended' ? 'Suspended — under recruiter review' : 'Attempts') + '</h4>'
      + (r.suspensionMessage
        ? '<div style="font-size:13px;margin:4px 0 6px">' + esc(r.suspensionMessage) + '</div>'
          + '<div class="tlig-ev">' + (r.suspensionQuestionNo ? 'Question ' + r.suspensionQuestionNo + ' · ' : '')
          + (r.suspendedAt ? 'Suspended ' + when(r.suspendedAt) + ' · ' : '')
          + 'Detections: ' + (r.detectionCount || 0)
          + (r.lastDetectionAt ? ' · last ' + when(r.lastDetectionAt) : '')
          + ' · Attempt ' + (r.attemptNumber || 1)
          + (r.suspensionEmailSentAt ? ' · email sent ' + when(r.suspensionEmailSentAt) : '')
          + '</div>'
          + '<div class="tlig-st" style="margin-top:6px">Retake: <b>' + esc(retake) + '</b></div>'
        : '')
      + attempts + controls + '</div>';
  }

  window.tlRetakeControl = function (interviewId, action) {
    var api = API();
    var why = ((document.getElementById('tligRetakeWhy') || {}).value || '').trim();
    if (!api) return;
    if (why.length < 3) {
      if (typeof window.toast === 'function') window.toast('Please give a reason — it is recorded', '⚠️');
      return;
    }
    api.post('/ai-interviews/' + encodeURIComponent(interviewId) + '/retake', { action: action, reason: why })
      .then(function () {
        if (typeof window.toast === 'function') {
          window.toast(action === 'block' ? 'Retake blocked' : action === 'unblock' ? 'Retake allowed' : 'Another attempt granted', '✅');
        }
        window.tlIntegrityOpen(interviewId);
        paintList();
      })
      .catch(function (e) {
        if (typeof window.toast === 'function') window.toast((e && e.message) || 'That could not be saved', '⚠️');
      });
  };

  window.tlIntegrityOpen = function (interviewId) {
    var api = API();
    if (!api || typeof window.fcrModal !== 'function') return;
    api.get('/ai-interviews/' + encodeURIComponent(interviewId) + '/integrity')
      .then(function (r) {
        var rows = (r.violations || []).map(function (v) {
          return '<tr>'
            + '<td>' + v.no + '</td>'
            + '<td>' + esc(v.type) + '</td>'
            + '<td>' + when(v.at) + '</td>'
            + '<td>' + esc(v.confidence.charAt(0).toUpperCase() + v.confidence.slice(1))
              + ' <span class="tlig-ev">(' + (v.confidenceValue == null ? '—'
                  : v.confidenceValue.toFixed(2)) + ')</span></td>'
            + '<td>' + esc(v.outcome) + '</td>'
            + '<td>'
              + '<div class="tlig-ev">' + esc(v.warningShown || '') + '</div>'
              + (v.evidence ? '<div class="tlig-ev">detector: ' + esc(v.evidence.detector || '—')
                  + (v.evidence.faces ? ' · faces: ' + v.evidence.faces : '')
                  + (v.evidence.sustainedMs ? ' · held ' + Math.round(v.evidence.sustainedMs / 100) / 10 + 's' : '')
                  + (v.evidence.samples ? ' · ' + v.evidence.samples + ' samples' : '')
                  + (v.evidence.pitchHz ? ' · ' + v.evidence.pitchHz + 'Hz vs ' + v.evidence.baselineHz + 'Hz' : '')
                  + '</div>' : '')
              + '<textarea class="tlig-note" rows="2" id="tligNote' + v.id + '"'
                + ' placeholder="Recruiter notes">' + esc(v.recruiterNotes || '') + '</textarea>'
              + '<div style="margin-top:5px;display:flex;gap:6px;flex-wrap:wrap">'
              + '<button class="btn btn-ghost btn-sm" onclick="tlIntegrityReview(\''
                + esc(interviewId) + '\',' + v.id + ',\'upheld\')">Uphold</button>'
              + '<button class="btn btn-ghost btn-sm" onclick="tlIntegrityReview(\''
                + esc(interviewId) + '\',' + v.id + ',\'dismissed\')">Dismiss</button>'
              + '<span class="tlig-ev" id="tligSaved' + v.id + '">'
                + (v.reviewStatus === 'open' ? 'not reviewed' : esc(v.reviewStatus)) + '</span>'
              + '</div>'
            + '</td></tr>';
        }).join('');

        window.fcrModal(
          '<div class="fcr-jd-head"><h3>Interview Integrity</h3>'
          + '<button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
          + '<div class="fcr-jd-body" style="padding-bottom:20px">'
          + suspensionBlock(interviewId, r)
          + '<div class="tlig-st">Status: ' + statusPill(r.integrityStatus)
            + ' &nbsp;·&nbsp; Strikes: <b>' + r.strikes + ' of 2</b>'
            + (r.suspendedAt ? ' &nbsp;·&nbsp; Suspended ' + when(r.suspendedAt) : '')
            + (r.reopenedAt ? ' &nbsp;·&nbsp; Reopened ' + when(r.reopenedAt) : '')
            + '</div>'
          + (rows
            ? '<table class="tlig-tbl"><thead><tr><th>#</th><th>Type</th><th>Time</th>'
              + '<th>Confidence</th><th>Status</th><th>Evidence &amp; review</th></tr></thead>'
              + '<tbody>' + rows + '</tbody></table>'
            : '<p style="font-size:13px;color:#7a8798">No violations were recorded '
              + 'for this interview.</p>')
          + (r.integrityStatus === 'suspended'
            ? '<div style="margin-top:16px;border-top:1px solid #e6ebf2;padding-top:14px">'
              + '<div style="font-size:12px;font-weight:700;margin-bottom:6px">Reopen or reschedule</div>'
              + '<div style="font-size:11.5px;color:#7a8798;margin-bottom:8px">'
              + 'The candidate cannot restart this interview until you do. Reopening issues '
              + 'a new link, so the suspended session cannot be re-entered.</div>'
              + '<input class="tlig-note" id="tligReason" placeholder="Reason (recorded)">'
              + '<input class="tlig-note" id="tligWhen" type="datetime-local" '
                + 'placeholder="Reschedule for (optional)">'
              + '<div style="margin-top:8px"><button class="btn btn-primary btn-sm" '
                + 'onclick="tlIntegrityReopen(\'' + esc(interviewId) + '\')">Reopen interview</button></div>'
              + '</div>'
            : '')
          + '</div>');
      })
      .catch(function (e) {
        if (typeof window.toast === 'function') {
          window.toast((e && e.message) || 'The integrity record could not be loaded', '⚠️');
        }
      });
  };

  window.tlIntegrityReview = function (interviewId, flagId, verdict) {
    var api = API();
    var box = document.getElementById('tligNote' + flagId);
    var say = document.getElementById('tligSaved' + flagId);
    if (!api) return;
    api.post('/ai-interviews/' + encodeURIComponent(interviewId) + '/integrity/' + flagId + '/review',
      { reviewStatus: verdict, notes: box ? box.value : undefined })
      .then(function () { if (say) say.textContent = verdict + ' · saved'; })
      .catch(function (e) { if (say) say.textContent = 'not saved — ' + (e && e.message || 'error'); });
  };

  window.tlIntegrityReopen = function (interviewId) {
    var api = API();
    var reason = (document.getElementById('tligReason') || {}).value || '';
    var at = (document.getElementById('tligWhen') || {}).value || '';
    if (!api) return;
    if (!reason.trim()) {
      if (typeof window.toast === 'function') window.toast('Please give a reason — it is recorded', '⚠️');
      return;
    }
    api.post('/ai-interviews/' + encodeURIComponent(interviewId) + '/reopen',
      { reason: reason.trim(), rescheduleAt: at || undefined })
      .then(function (r) {
        if (typeof window.fcrCloseModal === 'function') window.fcrCloseModal();
        if (typeof window.toast === 'function') window.toast(r.note, '✅');
        paintList();
      })
      .catch(function (e) {
        if (typeof window.toast === 'function') {
          window.toast((e && e.message) || 'The interview could not be reopened', '⚠️');
        }
      });
  };

  function paintList() {
    var host = document.getElementById('tligListHost');
    var api = API();
    if (!host || !api) return;
    api.get('/ai-interviews/integrity').then(function (r) {
      var list = r.interviews || [];
      if (!list.length) {
        host.innerHTML = '<p class="empty-note" style="padding:10px 0">'
          + 'No interview has raised an integrity violation.</p>';
        return;
      }
      host.innerHTML = '<table class="tlig-tbl"><thead><tr><th>Candidate</th><th>Role</th>'
        + '<th>Status</th><th>Reason</th><th>Attempt</th><th>Retake</th><th>When</th><th></th></tr></thead><tbody>'
        + list.map(function (x) {
          return '<tr><td>' + esc(x.candidateName) + '</td>'
            + '<td>' + esc(x.jobTitle || '—') + '</td>'
            + '<td>' + statusPill(x.integrityStatus)
              + (x.openFlags ? ' <span class="tlig-ev">' + x.openFlags + ' to review</span>' : '')
              + '</td>'
            + '<td style="max-width:260px">' + esc(x.suspensionMessage || '—')
              + (x.suspensionQuestionNo ? ' <span class="tlig-ev">Q' + x.suspensionQuestionNo + ' · ' + (x.detectionCount || 0) + '×</span>' : '')
              + '</td>'
            + '<td>' + (x.attemptNumber || 1) + '</td>'
            + '<td>' + (x.retakeBlocked ? 'Blocked' : x.retakeAvailableAt ? when(x.retakeAvailableAt) : (x.status === 'suspended' ? 'With recruiter' : '—')) + '</td>'
            + '<td>' + when(x.suspendedAt) + '</td>'
            + '<td><button class="btn btn-ghost btn-sm" onclick="tlIntegrityOpen(\''
              + esc(x.id) + '\')">Review</button></td></tr>';
        }).join('') + '</tbody></table>';
    }).catch(function () {
      host.innerHTML = '<p class="empty-note" style="padding:10px 0">'
        + 'The integrity list could not be loaded.</p>';
    });
  }

  /** Put the panel at the end of the Interviews section, once. */
  function mountPanel() {
    var body = document.querySelector('.dash-body');
    if (!body || document.getElementById('tligPanel')) return;
    var panel = document.createElement('div');
    panel.className = 'panel';
    panel.id = 'tligPanel';
    panel.style.marginTop = '14px';
    panel.innerHTML = '<div class="panel-head"><div><h2>Interview Integrity</h2>'
      + '<div class="desc">AI interviews where another person or another voice was '
      + 'detected during the session. A flag is evidence, not a decision — nothing '
      + 'here rejects anybody.</div></div></div>'
      + '<div class="panel-body"><div id="tligListHost"></div></div>';
    body.appendChild(panel);
    paintList();
  }

  (function hookRecruiterPage() {
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (tries > 60) { clearInterval(timer); return; }
      if (typeof window.pageRecruiterDash !== 'function') return;
      clearInterval(timer);
      var prev = window.pageRecruiterDash;
      window.pageRecruiterDash = function (section) {
        var html = prev.apply(this, arguments);
        /*
         * THE PANEL IS PUT IN THE DOM, NOT INTO THE STRING.
         *
         * What comes back here is the whole dashboard shell - sidebar,
         * header, body - so appending to it would hang the panel off the
         * end of the page instead of inside the section. Inserting after
         * the render lands it in `.dash-body`, where the rest of the
         * section is, and needs no assumptions about the shell's markup.
         */
        /*
         * APPLICATIONS, NOT INTERVIEWS.
         *
         * The obvious home for this is the recruiter's Interviews
         * screen, and that screen was deliberately removed from this
         * portal - `REMOVED` in index.html sends /recruiter/interviews
         * to AI Copilot. A panel mounted there is a panel nobody can
         * reach. Applications is where a recruiter looks at who is
         * progressing, which is the question an integrity flag changes
         * the answer to.
         */
        if (section === 'applications') setTimeout(mountPanel, 0);
        return html;
      };
    }, 400);
  })();

  /* ------------------------------------------------------------------ *
   * styles
   * ------------------------------------------------------------------ */
  var css = ''
    + '.tlig-warn{position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:9000;'
      + 'max-width:min(620px,calc(100vw - 32px));display:flex;align-items:flex-start;gap:12px;'
      + 'background:#fff4e2;border:1px solid #e9b765;border-left:5px solid #d9860d;'
      + 'border-radius:10px;padding:13px 16px;box-shadow:0 12px 34px rgba(20,15,5,.22)}'
    + '.tlig-w-n{font-weight:800;font-size:12.5px;color:#8a5a12;white-space:nowrap;'
      + 'background:#f6dfb4;border-radius:6px;padding:3px 8px;margin-top:1px}'
    + '.tlig-w-m{font-size:13.5px;line-height:1.5;color:#5d4412;flex:1}'
    + '.tlig-w-x{border:0;background:transparent;cursor:pointer;color:#8a5a12;font-size:13px;'
      + 'line-height:1;padding:3px}'
    + '.tlig-susp{position:fixed;inset:0;z-index:9001;background:rgba(15,20,30,.72);'
      + 'display:flex;align-items:center;justify-content:center;padding:20px}'
    + '.tlig-s-box{background:#fff;border-radius:12px;padding:26px 28px;max-width:480px;'
      + 'text-align:center}'
    + '.tlig-s-box h3{margin:0 0 10px;font-size:18px;color:#b3261e}'
    + '.tlig-s-box p{margin:0;font-size:13.5px;line-height:1.55;color:#42506a}'
    /* the recruiter's Interview Integrity section */
    + '.tlig-sec{border:1px solid #e6ebf2;border-radius:12px;padding:16px 18px;margin:14px 0;'
      + 'background:#fff}'
    + '.tlig-sec h4{margin:0 0 4px;font-size:13px;font-weight:800;letter-spacing:.03em;'
      + 'text-transform:uppercase;color:#2b3a4f}'
    + '.tlig-sec .tlig-st{font-size:12.5px;margin-bottom:12px}'
    + '.tlig-pill{display:inline-block;border-radius:20px;padding:2px 10px;font-size:11.5px;'
      + 'font-weight:800}'
    + '.tlig-p-none{background:#e8f6ee;color:#1d7a45}'
    + '.tlig-p-warn{background:#fdf1dc;color:#8a5a12}'
    + '.tlig-p-susp{background:#fdeaea;color:#b3261e}'
    + '.tlig-tbl{width:100%;border-collapse:collapse;font-size:12.5px}'
    + '.tlig-tbl th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;'
      + 'color:#7a8798;padding:6px 8px;border-bottom:1px solid #e6ebf2}'
    + '.tlig-tbl td{padding:8px;border-bottom:1px solid #f1f4f8;vertical-align:top}'
    + '.tlig-ev{font-size:11px;color:#7a8798}'
    + '.tlig-note{width:100%;border:1px solid #d9e0ea;border-radius:8px;padding:6px 8px;'
      + 'font:inherit;font-size:12px;margin-top:4px}';

  var tag = document.createElement('style');
  tag.id = 'tlig-css';
  tag.textContent = css;
  (document.head || document.documentElement).appendChild(tag);
})();
