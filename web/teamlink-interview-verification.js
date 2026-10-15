/*
 * The photo verification before an AI interview (0149).
 *
 * When a candidate opens an interview this takes over BEFORE anything else happens: the interview is not
 * planned, no session is created and no timer starts until the server has a ready verification.
 *
 *   1 Prepare   the job, the length, what the camera is for, the camera requirements; asks for the camera
 *   2 Photo     live preview, "Capture photo"
 *   3 Review    "Retake photo" or "Confirm photo"
 *   4 Instructions & consent    the instructions, the privacy notice, two required checkboxes
 *   5 Start     the one button that goes on to the interview
 *
 * The page cannot skip it - POST /api/ai-interviews/session refuses without a ready verification - and
 * this module only makes it pleasant: it picks up where the candidate left off after a refresh, explains
 * errors and lets them try again. A candidate who cannot use a camera can ask for help (the recruiter is
 * told and may waive the photo).
 *
 * It wraps window.aiivStart, defined by the interview module and wrapped by teamlink-integration.js, and
 * is loaded after both, so it is the outermost: the wizard first, the original start once verified.
 */
(function () {
  'use strict';

  var prevStart = window.aiivStart;
  if (typeof prevStart !== 'function') return;

  var S = null;            // the wizard being shown, or null
  var STEPS = ['Prepare', 'Photo', 'Review', 'Instructions', 'Start'];

  function api() { return window.TL && window.TL.api; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function errText(e, fallback) {
    var m = e && (e.message || (e.body && e.body.message));
    if (e && e.code === 'NETWORK_ERROR') return 'We could not reach the server. Check your internet connection and try again.';
    return m ? String(m) : (fallback || 'Something went wrong. Please try again.');
  }
  function serverAppId(appId) {
    try { var f = window.TL && window.TL.aiivRec && window.TL.aiivRec(appId); return f && f.applicationId || null; }
    catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ *
   * styles (the portal's own tokens and button classes)
   * ------------------------------------------------------------------ */
  var css = ''
    + '.tlv-ov{position:fixed;inset:0;z-index:9500;background:rgba(11,18,32,.72);display:flex;align-items:flex-start;'
      + 'justify-content:center;padding:20px 14px;overflow:auto}'
    + '.tlv-card{background:var(--surface,#fff);color:var(--ink-900,#0b1220);width:100%;max-width:760px;border-radius:14px;'
      + 'box-shadow:0 24px 60px rgba(0,0,0,.3);padding:22px 26px 24px;margin:auto}'
    + '.tlv-prog{display:flex;gap:6px;margin:0 0 18px;padding:0;list-style:none}'
    + '.tlv-prog li{flex:1;text-align:center;font-size:11.5px;font-weight:700;color:var(--ink-300,#a2acbd);'
      + 'border-top:4px solid var(--paper-100,#e2e7ee);padding-top:6px}'
    + '.tlv-prog li.done{color:var(--ok-600,#1e8e5a);border-color:var(--ok-600,#1e8e5a)}'
    + '.tlv-prog li.cur{color:var(--brand-600,#0b6e8f);border-color:var(--brand-600,#0b6e8f)}'
    + '.tlv-card h2{margin:0 0 6px;font-size:21px}'
    + '.tlv-sub{margin:0 0 14px;color:var(--ink-500,#5b6678);font-size:14px;line-height:1.5}'
    + '.tlv-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:0 0 16px}'
    + '.tlv-fact{background:var(--paper-50,#eef1f5);border-radius:10px;padding:10px 12px}'
    + '.tlv-fact b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-500,#5b6678)}'
    + '.tlv-fact span{font-size:15px;font-weight:700}'
    + '.tlv-card ul{margin:0 0 14px 18px;padding:0;font-size:14px;line-height:1.55}'
    + '.tlv-note{background:var(--brand-100,#e1f3f8);border-radius:10px;padding:11px 14px;font-size:13.5px;line-height:1.5;margin:0 0 14px}'
    + '.tlv-notice{border:1px solid var(--border,#dde2ea);border-radius:10px;padding:10px 14px;margin:0 0 14px;font-size:13.5px}'
    + '.tlv-notice summary{cursor:pointer;font-weight:700;color:var(--brand-600,#0b6e8f)}'
    + '.tlv-err{background:var(--bad-100,#fbe4e1);color:var(--bad-600,#c0392b);border-radius:10px;padding:10px 14px;'
      + 'font-size:13.5px;line-height:1.5;margin:0 0 14px}'
    + '.tlv-warn{background:var(--warn-100,#fbeed8);color:var(--warn-600,#a5670f);border-radius:10px;padding:10px 14px;'
      + 'font-size:13.5px;line-height:1.5;margin:0 0 14px}'
    + '.tlv-cam{position:relative;background:#000;border-radius:12px;overflow:hidden;aspect-ratio:4/3;max-height:52vh;margin:0 auto 12px}'
    + '.tlv-cam video,.tlv-cam img{width:100%;height:100%;object-fit:cover;display:block}'
    + '.tlv-cam video{transform:scaleX(-1)}'
    + '.tlv-oval{position:absolute;left:50%;top:50%;width:46%;height:74%;transform:translate(-50%,-50%);'
      + 'border:3px dashed rgba(255,255,255,.85);border-radius:50%;pointer-events:none;box-shadow:0 0 0 999px rgba(0,0,0,.28)}'
    + '.tlv-face{text-align:center;font-size:13.5px;font-weight:700;min-height:20px;margin:0 0 10px}'
    + '.tlv-face.ok{color:var(--ok-600,#1e8e5a)}.tlv-face.no{color:var(--warn-600,#a5670f)}'
    + '.tlv-row{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;align-items:center;margin-top:6px}'
    + '.tlv-row .tlv-grow{flex:1}'
    + '.tlv-chk{display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.45;margin:0 0 10px;cursor:pointer}'
    + '.tlv-chk input{margin-top:3px;width:18px;height:18px;flex:none}'
    + '.tlv-link{background:none;border:0;padding:0;color:var(--brand-600,#0b6e8f);font-weight:700;font-size:13.5px;cursor:pointer;text-decoration:underline}'
    + '.tlv-help{border:1px solid var(--border,#dde2ea);border-radius:10px;padding:12px 14px;margin:0 0 14px}'
    + '.tlv-help textarea{width:100%;min-height:64px;border:1px solid var(--border,#dde2ea);border-radius:8px;padding:8px;font:inherit;box-sizing:border-box}'
    + '.tlv-card .btn[disabled]{opacity:.5;cursor:not-allowed}'
    + '@media (max-width:600px){.tlv-card{padding:16px 14px 18px}.tlv-prog li{font-size:10px}.tlv-row{justify-content:stretch}'
      + '.tlv-row .btn{flex:1}.tlv-cam{max-height:46vh}}';
  function addStyle() {
    if (document.getElementById('tlv-style')) return;
    var st = document.createElement('style'); st.id = 'tlv-style'; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ------------------------------------------------------------------ *
   * the camera
   * ------------------------------------------------------------------ */
  function stopCamera() {
    if (!S) return;
    if (S.faceTimer) { clearInterval(S.faceTimer); S.faceTimer = null; }
    if (S.stream) { try { S.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} S.stream = null; }
  }
  function cameraProblem(e) {
    var n = e && e.name;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return 'This browser cannot open the camera. Please use the latest Chrome, Edge, Safari or Firefox, on a secure (https) page.';
    }
    if (n === 'NotAllowedError' || n === 'SecurityError') {
      return 'Camera permission was denied. Allow camera access for this site (the camera icon in the address bar), then press Try again.';
    }
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No camera was found on this device. Connect a camera and press Try again.';
    if (n === 'NotReadableError' || n === 'AbortError') return 'The camera is being used by another app or tab. Close it and press Try again.';
    return 'The camera could not be started. Press Try again, or ask for help below.';
  }
  function startCamera() {
    S.error = null; S.step = 'capture'; render();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      S.error = cameraProblem(null); S.step = 'prepare'; S.helpOpen = true; render(); return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false })
      .then(function (stream) {
        if (!S) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        S.stream = stream;
        var v = document.getElementById('tlvVideo');
        if (v) { v.srcObject = stream; v.play().catch(function () {}); }
        var cap = document.querySelector('[data-act="capture"]');
        if (cap) cap.disabled = false;
        stream.getVideoTracks().forEach(function (t) {
          t.addEventListener('ended', function () {
            if (S && S.step === 'capture') { S.error = 'The camera was disconnected. Reconnect it and press Try again.'; S.stream = null; render(); }
          });
        });
        watchFace();
      })
      .catch(function (e) { if (!S) return; S.error = cameraProblem(e); S.step = 'prepare'; render(); });
  }
  /* A hint only: "we can see one face". It never blocks anything - an uncertain detection is not a reason
     to stop a candidate. */
  function watchFace() {
    if (typeof window.tlFaceAnalyzer !== 'function') return;
    window.tlFaceAnalyzer().then(function (det) {
      if (!det || !det.analyze || !S || !S.stream) return;
      S.faceTimer = setInterval(function () {
        var v = document.getElementById('tlvVideo');
        var out = document.getElementById('tlvFace');
        if (!v || !out || !v.videoWidth) return;
        Promise.resolve(det.analyze(v)).then(function (r) {
          S.faces = r.faces;
          if (r.faces === 1) { out.className = 'tlv-face ok'; out.textContent = 'Face detected - you can capture the photo.'; }
          else if (r.faces > 1) { out.className = 'tlv-face no'; out.textContent = 'More than one face is in view. Only you should be in the picture.'; }
          else { out.className = 'tlv-face no'; out.textContent = 'We cannot see your face yet. Move into the oval and face the camera.'; }
        }).catch(function () {});
      }, 500);
    }).catch(function () {});
  }

  function takePhoto() {
    var v = document.getElementById('tlvVideo');
    if (!v || !v.videoWidth) { S.error = 'The camera picture is not ready yet. Wait a moment and try again.'; render(); return; }
    var maxW = 960, w = Math.min(v.videoWidth, maxW), h = Math.round(v.videoHeight * (w / v.videoWidth));
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(v, 0, 0, w, h);
    S.facesAtCapture = S.faces;
    var limit = (S.data && S.data.photo && S.data.photo.maxBytes) || 2 * 1024 * 1024;
    var quality = 0.88;
    function attempt() {
      cv.toBlob(function (blob) {
        if (!blob) { S.error = 'The photo could not be taken. Please try again.'; render(); return; }
        if (blob.size > limit && quality > 0.5) { quality -= 0.15; attempt(); return; }
        S.blob = blob;
        if (S.blobUrl) { try { URL.revokeObjectURL(S.blobUrl); } catch (e) {} }
        S.blobUrl = URL.createObjectURL(blob);
        stopCamera();
        S.step = 'review'; S.error = null; S.uploaded = false;
        render();
        uploadPhoto();
      }, 'image/jpeg', quality);
    }
    attempt();
  }

  function uploadPhoto() {
    if (!S.blob || S.uploading) return;
    if (navigator.onLine === false) { S.error = 'You are offline. Reconnect to the internet, then press Try again.'; render(); return; }
    S.uploading = true; S.error = null; render();
    var fd = new FormData();
    fd.append('verificationId', S.v.id);
    fd.append('photo', S.blob, 'photo.jpg');
    api().post('/ai-interviews/verification/photo', fd, { timeout: 60000 }).then(function (r) {
      if (!S) return;
      S.uploading = false; S.uploaded = true; S.v = r.verification; render();
    }, function (e) {
      if (!S) return;
      S.uploading = false; S.uploaded = false;
      S.error = (e && e.status === 413) ? 'That photo is too large. Please retake it.' : errText(e, 'The photo could not be uploaded.');
      render();
    });
  }

  /* ------------------------------------------------------------------ *
   * the screens
   * ------------------------------------------------------------------ */
  function progress() {
    var idx = { prepare: 0, capture: 1, review: 2, instructions: 3, start: 4 }[S.step];
    return '<ol class="tlv-prog" aria-label="Progress">' + STEPS.map(function (n, i) {
      return '<li class="' + (i < idx ? 'done' : i === idx ? 'cur' : '') + '"' + (i === idx ? ' aria-current="step"' : '') + '>'
        + (i + 1) + '. ' + n + '</li>';
    }).join('') + '</ol>';
  }
  function noticeHtml(open) {
    var n = S.data.notice;
    return '<details class="tlv-notice"' + (open ? ' open' : '') + '><summary>' + esc(n.title) + '</summary>'
      + '<p>' + esc(n.purpose) + '</p><ul>' + n.points.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>'
      + '<p>' + esc(n.contact) + '</p></details>';
  }
  function helpHtml() {
    var n = S.data.notice;
    if (S.helpSent) {
      return '<div class="tlv-help"><b>We have told the recruiter.</b><p class="tlv-sub">They may switch the photo step off for you. '
        + esc(n.contact) + ' You can come back to this page afterwards.</p></div>';
    }
    return '<div class="tlv-help"><b>Cannot use a camera?</b>'
      + '<p class="tlv-sub">Tell us what is wrong and we will tell the recruiter. ' + esc(n.contact) + '</p>'
      + '<textarea id="tlvHelpNote" maxlength="300" placeholder="For example: my laptop camera is not working"></textarea>'
      + '<div class="tlv-row"><button type="button" class="btn btn-ghost" data-act="sendhelp"' + (S.busy ? ' disabled' : '') + '>Ask for help</button></div></div>';
  }
  function errHtml() { return S.error ? '<div class="tlv-err" role="alert">' + esc(S.error) + '</div>' : ''; }

  function viewPrepare() {
    var d = S.data, waived = S.v.method === 'staff_waiver';
    return '<h2>Before your AI interview</h2>'
      + '<p class="tlv-sub">' + (waived
        ? 'The recruiter has switched the photo step off for you. You only need to read and accept the instructions.'
        : 'We need to take a photo of you first. Your camera is required for identity verification and interview safety.') + '</p>'
      + '<div class="tlv-facts">'
      +   '<div class="tlv-fact"><b>Job</b><span>' + esc(d.job.title) + '</span></div>'
      +   '<div class="tlv-fact"><b>Candidate</b><span>' + esc(d.candidate.name) + '</span></div>'
      +   '<div class="tlv-fact"><b>Interview length</b><span>About ' + d.interview.approxMinutes + ' minutes, ' + d.interview.questions + ' questions</span></div>'
      + '</div>'
      + (waived ? '' : '<b>What you need</b><ul>' + d.cameraRequirements.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'
        + '<div class="tlv-note">' + esc(d.notice.purpose) + '</div>' + noticeHtml())
      + errHtml()
      + (S.helpOpen ? helpHtml() : '')
      + '<div class="tlv-row">'
      +   (waived ? '' : '<button type="button" class="tlv-link tlv-grow" data-act="help" style="text-align:left">I cannot use a camera</button>')
      +   '<button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button>'
      +   '<button type="button" class="btn btn-primary" data-act="' + (waived ? 'toInstructions' : 'allow') + '">'
      +     (waived ? 'Continue' : (S.error ? 'Try again' : 'Allow camera and continue')) + '</button>'
      + '</div>';
  }
  function viewCapture() {
    return '<h2>Take your photo</h2>'
      + '<p class="tlv-sub">Put your face inside the oval, look at the camera, and make sure you are in good light. Only you should be in the picture.</p>'
      + errHtml()
      + '<div class="tlv-cam"><video id="tlvVideo" playsinline muted autoplay></video><div class="tlv-oval"></div></div>'
      + '<div id="tlvFace" class="tlv-face" aria-live="polite"></div>'
      + '<div class="tlv-row"><button type="button" class="btn btn-ghost" data-act="back">Back</button>'
      + '<button type="button" class="btn btn-primary" data-act="capture"' + (S.stream ? '' : ' disabled') + '>Capture photo</button></div>';
  }
  function viewReview() {
    var src = S.blobUrl || (S.v.photoUrl || '');
    var multi = S.facesAtCapture > 1, none = S.facesAtCapture === 0;
    return '<h2>Is this photo clear?</h2>'
      + '<p class="tlv-sub">Check that your face is clear and you are the only person in the picture. If not, retake it.</p>'
      + errHtml()
      + (multi ? '<div class="tlv-warn">We could see more than one face in this photo. Please retake it with only you in view.</div>' : '')
      + (none ? '<div class="tlv-warn">We could not clearly see a face in this photo. Please retake it, or confirm it if it is fine.</div>' : '')
      + '<div class="tlv-cam">' + (src ? '<img src="' + esc(src) + '" alt="Your photo for the interview">' : '') + '</div>'
      + (S.uploading ? '<p class="tlv-sub" aria-live="polite">Saving your photo…</p>' : '')
      + '<div class="tlv-row">'
      +   '<button type="button" class="btn btn-ghost" data-act="retake"' + (S.busy || S.uploading ? ' disabled' : '') + '>Retake photo</button>'
      +   (S.uploaded || (!S.blob && S.v.hasPhoto)
            ? '<button type="button" class="btn btn-primary" data-act="confirm"' + (S.busy ? ' disabled' : '') + '>Confirm photo</button>'
            : '<button type="button" class="btn btn-primary" data-act="retryUpload"' + (S.uploading ? ' disabled' : '') + '>' + (S.error ? 'Try again' : 'Saving…') + '</button>')
      + '</div>';
  }
  function viewInstructions() {
    var d = S.data, waived = S.v.method === 'staff_waiver';
    return '<h2>Interview instructions</h2>'
      + '<p class="tlv-sub">Please read these carefully. The interview is recorded and checked as described below.</p>'
      + '<ul>' + d.instructions.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'
      + noticeHtml(true)
      + errHtml()
      + '<label class="tlv-chk"><input type="checkbox" id="tlvAck"' + (S.ack ? ' checked' : '') + '><span>I have read and understood the interview instructions.</span></label>'
      + (waived ? '<p class="tlv-sub">No photo is being taken for you, so there is no photo consent to give.</p>'
        : '<label class="tlv-chk"><input type="checkbox" id="tlvConsent"' + (S.consent ? ' checked' : '') + '><span>I consent to the stated processing of my image for interview verification.</span></label>')
      + '<div class="tlv-row">'
      +   (waived ? '' : '<button type="button" class="tlv-link tlv-grow" data-act="help" style="text-align:left">Problem with the camera or my photo?</button>')
      +   '<button type="button" class="btn btn-ghost" data-act="' + (waived ? 'cancel' : 'back2') + '">' + (waived ? 'Cancel' : 'Back') + '</button>'
      +   '<button type="button" class="btn btn-primary" id="tlvContinue" data-act="consent" disabled>Continue to interview</button>'
      + '</div>' + (S.helpOpen ? helpHtml() : '');
  }
  function viewStart() {
    return '<h2>You are ready</h2>'
      + '<p class="tlv-sub">Your photo is confirmed and you have accepted the instructions. The interview starts when you press the button. '
      + 'Make sure you are somewhere quiet, with your camera and microphone working.</p>'
      + errHtml()
      + '<div class="tlv-row"><button type="button" class="btn btn-ghost" data-act="cancel">Not now</button>'
      + '<button type="button" class="btn btn-primary" data-act="begin"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Starting…' : 'Start interview') + '</button></div>';
  }

  function render() {
    if (!S) return;
    var root = S.root;
    var body = { prepare: viewPrepare, capture: viewCapture, review: viewReview, instructions: viewInstructions, start: viewStart }[S.step]();
    root.innerHTML = '<div class="tlv-card" role="dialog" aria-modal="true" aria-label="Interview verification">' + progress() + body + '</div>';
    if (S.step === 'capture' && S.stream) {
      var v = document.getElementById('tlvVideo');
      if (v) { v.srcObject = S.stream; v.play().catch(function () {}); }
    }
    if (S.step === 'instructions') syncContinue();
    try { root.scrollTop = 0; } catch (e) {}
  }
  function syncContinue() {
    var a = document.getElementById('tlvAck'), c = document.getElementById('tlvConsent'), b = document.getElementById('tlvContinue');
    if (!b) return;
    S.ack = !!(a && a.checked);
    S.consent = !!(c && c.checked);
    var waived = S.v.method === 'staff_waiver';
    b.disabled = S.busy || !(S.ack && (waived || S.consent));
    b.textContent = S.busy ? 'Saving…' : 'Continue to interview';
  }

  /* ------------------------------------------------------------------ *
   * actions
   * ------------------------------------------------------------------ */
  function close() {
    if (!S) return;
    stopCamera();
    if (S.blobUrl) { try { URL.revokeObjectURL(S.blobUrl); } catch (e) {} }
    if (S.root && S.root.parentNode) S.root.parentNode.removeChild(S.root);
    document.body.style.overflow = S.prevOverflow || '';
    S = null;
  }
  function leave() {
    var appId = S && S.appId;
    close();
    try { if (appId) location.hash = '#/candidate-app/' + appId; } catch (e) {}
  }
  function guard(fn) { if (!S || S.busy) return; fn(); }

  function onClick(ev) {
    var t = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!t || !S) return;
    var act = t.getAttribute('data-act');
    if (act === 'allow') return startCamera();
    if (act === 'capture') return takePhoto();
    if (act === 'retake') return guard(function () { S.blob = null; S.uploaded = false; S.v.photoUrl = null; S.v.hasPhoto = false; startCamera(); });
    if (act === 'retryUpload') return uploadPhoto();
    if (act === 'back') { stopCamera(); S.step = 'prepare'; S.error = null; return render(); }
    if (act === 'back2') { S.step = 'review'; S.error = null; return render(); }
    if (act === 'cancel') return leave();
    if (act === 'help') { S.helpOpen = !S.helpOpen; return render(); }
    if (act === 'sendhelp') return sendHelp();
    if (act === 'toInstructions') { S.step = 'instructions'; S.error = null; return render(); }
    if (act === 'confirm') return confirmPhoto();
    if (act === 'consent') return sendConsent();
    if (act === 'begin') return begin();
  }
  function onChange(ev) { if (ev.target && (ev.target.id === 'tlvAck' || ev.target.id === 'tlvConsent')) syncContinue(); }

  function confirmPhoto() {
    guard(function () {
      S.busy = true; S.error = null; render();
      api().post('/ai-interviews/verification/' + encodeURIComponent(S.v.id) + '/confirm', {}).then(function (r) {
        if (!S) return;
        S.busy = false; S.v = r.verification; S.step = 'instructions'; render();
      }, function (e) { if (!S) return; S.busy = false; S.error = errText(e, 'The photo could not be confirmed.'); render(); });
    });
  }
  function sendConsent() {
    guard(function () {
      var waived = S.v.method === 'staff_waiver';
      if (!S.ack || (!waived && !S.consent)) return;
      S.busy = true; S.error = null; syncContinue();
      api().post('/ai-interviews/verification/' + encodeURIComponent(S.v.id) + '/consent', {
        instructionsAcknowledged: true, consent: !waived, noticeVersion: S.data.notice.version,
      }).then(function (r) {
        if (!S) return;
        S.busy = false; S.v = r.verification; S.step = 'start'; render();
      }, function (e) {
        if (!S) return;
        S.busy = false;
        if (e && e.code === 'NOTICE_CHANGED') {
          /* the notice was updated while this was open: fetch the new one and ask again */
          S.ack = false; S.consent = false;
          load(S.appId, S.serverAppId, S.proceed, errText(e));
          return;
        }
        S.error = errText(e, 'Your answer could not be saved.'); render();
      });
    });
  }
  function sendHelp() {
    guard(function () {
      var note = (document.getElementById('tlvHelpNote') || {}).value || '';
      S.busy = true; render();
      api().post('/ai-interviews/verification/' + encodeURIComponent(S.v.id) + '/camera-help', { note: note }).then(function () {
        if (!S) return; S.busy = false; S.helpSent = true; render();
      }, function (e) { if (!S) return; S.busy = false; S.error = errText(e, 'We could not send that. Please write to the support address.'); render(); });
    });
  }
  /* the only way on: close the wizard and run the original start, which now plans the session on the server */
  function begin() {
    guard(function () {
      S.busy = true; render();
      var proceed = S.proceed, appId = S.appId;
      close();
      VERIFIED_AT[appId] = Date.now();
      try { proceed(); } catch (e) { console.error('TeamLink: the interview could not be started.', e); }
    });
  }

  /* ------------------------------------------------------------------ *
   * entry points
   * ------------------------------------------------------------------ */
  var VERIFIED_AT = {};          // appId -> when this page last handed over after a verification

  function stepFromServer(v) {
    if (v.step === 'ready') return 'start';
    if (v.step === 'instructions') return 'instructions';
    if (v.step === 'review') return 'review';
    return 'prepare';
  }

  function open(appId, serverApp, proceed) {
    addStyle();
    if (S) return;
    var root = document.createElement('div');
    root.className = 'tlv-ov'; root.id = 'tlvOverlay';
    root.innerHTML = '<div class="tlv-card"><p class="tlv-sub">Getting your interview ready…</p></div>';
    document.body.appendChild(root);
    var prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    S = { appId: appId, serverAppId: serverApp, proceed: proceed, root: root, prevOverflow: prevOverflow, step: 'prepare',
          data: null, v: null, error: null, busy: false };
  }

  function load(appId, serverApp, proceed, message) {
    if (!S) open(appId, serverApp, proceed);
    api().post('/ai-interviews/verification/start', { applicationId: serverApp }).then(function (r) {
      if (!S) return;
      if (!r || r.required === false) { var p = S.proceed; close(); p(); return; }   // nothing to verify (resumed / not required)
      S.data = r; S.v = r.verification; S.step = stepFromServer(r.verification); S.error = message || null; S.busy = false;
      S.helpSent = !!r.verification.cameraHelpRequestedAt;
      render();
    }, function (e) {
      if (!S) return;
      /* the interview itself will not start (finished, too soon after a suspension, closed): hand over so the
         existing screens say so in their own words */
      if (e && /^INTERVIEW_/.test(String(e.code || ''))) { var p2 = S.proceed; close(); p2(); return; }
      S.root.innerHTML = '<div class="tlv-card"><h2>We could not get your interview ready</h2><div class="tlv-err">' + esc(errText(e)) + '</div>'
        + '<div class="tlv-row"><button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button>'
        + '<button type="button" class="btn btn-primary" data-act="reload">Try again</button></div></div>';
      S.root.addEventListener('click', function once(ev) {
        var t = ev.target.closest && ev.target.closest('[data-act="reload"]');
        if (!t) return;
        S.root.removeEventListener('click', once);
        load(S.appId, S.serverAppId, S.proceed);
      });
    });
  }

  window.aiivStart = function (appId) {
    var self = this, args = arguments;
    var serverApp = serverAppId(appId);
    var go = function () { return prevStart.apply(self, args); };
    if (!api() || !serverApp) return go();           // no server application: nothing to verify against
    /* the wizard hands over to the original start once; do not open it again for that very call */
    if (S) return undefined;
    var out = undefined;
    load(appId, serverApp, function () { out = go(); });
    return out;
  };

  /* The server said "verification required" when the session was requested (it was cleared, expired or used):
     show the wizard again with the reason. Called from teamlink-integration.js. */
  window.tlInterviewVerifyReopen = function (appId, err) {
    var serverApp = serverAppId(appId);
    if (!serverApp || S) return;
    var args = [appId];
    load(appId, serverApp, function () { prevStart.apply(null, args); }, errText(err));
  };
})();
