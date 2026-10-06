/*
 * TeamLink — the on-screen keyboard.
 *
 * A small keyboard icon beside a text field opens a QWERTY keyboard:
 * letters, Shift (tap = one capital, double-tap = caps lock), Backspace
 * (hold to repeat), Space, Enter, a 123/ABC page of digits and symbols
 * (₹ @ . , - _ / ? ! ' " ( ) : ; & + # %), and Close.
 *
 *   - Characters go in at the caret of the field, replacing a selection,
 *     through the native value setter, and the field gets the same
 *     `input` events a real keyboard gives it (`inputType` set, bubbling).
 *     `change` fires when the edit is committed: on Enter, on Close, and
 *     when the keyboard moves to another field - as a real keyboard does.
 *     `maxlength` is respected. The field keeps the focus and the caret.
 *   - Enter: a new line in a textarea; in a one-line field it sends the
 *     same keydown / keypress Enter the page already listens for (the
 *     TeamLink AI chat sends on that), then submits the field's form the
 *     way the browser's own Enter does (the AI Career Assistant page form).
 *   - While it is open the field has inputmode="none", so a phone does not
 *     raise its own keyboard as well. The previous inputmode comes back on
 *     close.
 *   - Phones and tablets (<= 768 px wide, or a touch-first pointer): docked
 *     at the bottom, full width, above the safe area; the page gets room
 *     underneath so the field stays in view above the keyboard. Desktop:
 *     directly below the field, kept on screen, never over the field.
 *   - Escape, a tap outside, or Close closes it.
 *   - Keys are at least 44 x 44 px at every width from 360 px up: below
 *     ~490 px of keyboard width the rows are split so they still fit.
 *
 * Where it is used (see the bottom of this file): every text field on the
 * AI Career Hub (#/candidate/career) and the TeamLink AI chat input,
 * wherever that chat renders (the floating chat and the AI Career
 * Assistant page). The AI Career Hub's "Target role" dropdown becomes a
 * type-to-filter combobox over the same <select>, which stays in the page
 * (hidden) as the source of truth.
 *
 * API (the only global):
 *   TLKeyboard.attach(rootOrSelector, { filter?, onScan? }) -> { detach(), refresh() }
 *       Puts the icon on every text field in the root (or on the root,
 *       if it is a field) and keeps doing so as the root re-renders.
 *   TLKeyboard.detach(rootOrSelector?)   remove the icons (all, with no argument)
 *   TLKeyboard.open(field) / .close() / .isOpen() / .field()
 *   TLKeyboard.combobox(select)          make a <select> searchable by typing
 */
(function () {
  'use strict';
  if (window.TLKeyboard) return;

  var DOCK_MAX = 768;          // at or below this width the keyboard docks
  var KEY = 44;                // smallest key, both ways
  var GAP = 4;
  var FULL_MIN = 10 * KEY + 9 * GAP;   // the widest row, at the smallest key

  /* ------------------------------------------------------------------ *
   * icons: inline SVG, drawn on a 24 grid, stroked in currentColor
   * ------------------------------------------------------------------ */
  var A = ' xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" shape-rendering="geometricPrecision" aria-hidden="true" focusable="false"';
  var ICON = {
    keyboard: '<svg' + A + '><rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M6.5 9.5h.01M9.5 9.5h.01M12.5 9.5h.01M15.5 9.5h.01M17.5 9.5h.01M6.5 12.5h.01M9.5 12.5h.01M12.5 12.5h.01M15.5 12.5h.01M17.5 12.5h.01M8 15.5h8" stroke-width="2"/></svg>',
    shift: '<svg' + A + '><path class="tlvk-shift-a" d="M12 4.5 4.5 12H9v6h6v-6h4.5z"/><path class="tlvk-shift-b" d="M9 21h6"/></svg>',
    bksp: '<svg' + A + '><path d="M21 5.5H9.2a1.5 1.5 0 0 0-1.1.5L2.8 12l5.3 6a1.5 1.5 0 0 0 1.1.5H21a1 1 0 0 0 1-1v-11a1 1 0 0 0-1-1z"/><path d="m12 9.5 5 5m0-5-5 5"/></svg>',
    enter: '<svg' + A + '><path d="M19.5 5.5v6a3 3 0 0 1-3 3h-12"/><path d="m8.5 10.5-4 4 4 4"/></svg>',
    close: '<svg' + A + '><rect x="3" y="3.5" width="18" height="11" rx="2"/><path d="M6.5 7h.01M9.5 7h.01M12.5 7h.01M15.5 7h.01M17.5 7h.01M8 11h8" stroke-width="2"/><path d="m8.5 18 3.5 3 3.5-3"/></svg>',
    space: '<svg' + A + '><path d="M4 10v4h16v-4"/></svg>',
    chevron: '<svg' + A + '><path d="m6 9 6 6 6-6"/></svg>',
    check: '<svg' + A + '><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  };

  var NAMES = {
    '₹': 'Rupee sign', '@': 'At sign', '.': 'Period', ',': 'Comma', '-': 'Hyphen', '_': 'Underscore',
    '/': 'Slash', '?': 'Question mark', '!': 'Exclamation mark', "'": 'Apostrophe', '"': 'Quotation mark',
    '(': 'Left parenthesis', ')': 'Right parenthesis', ':': 'Colon', ';': 'Semicolon', '&': 'Ampersand',
    '+': 'Plus sign', '#': 'Number sign', '%': 'Percent sign',
  };

  /* layouts: a string is a character key, {k} a function key, {sp} a spacer; w = width weight */
  var F = function (k, w) { return { k: k, w: w || 1 }; };
  var SP = function (w) { return { sp: w }; };
  var LAYOUTS = {
    abc: {
      full: [
        'qwertyuiop'.split(''),
        [SP(0.5)].concat('asdfghjkl'.split(''), [SP(0.5)]),
        [F('shift', 1.5)].concat('zxcvbnm'.split(''), [F('bksp', 1.5)]),
        [F('mode', 1.5), ',', F('space', 5), '.', F('enter', 1.5), F('close', 1.25)],
      ],
      compact: [
        'qwert'.split(''), 'yuiop'.split(''), 'asdfg'.split(''),
        'hjkl'.split('').concat([F('bksp')]),
        'zxcvbnm'.split(''),
        [F('shift'), F('mode', 1.2), F('space', 2.6), F('enter', 1.2), F('close')],
      ],
    },
    num: {
      full: [
        '1234567890'.split(''),
        [SP(0.5), '@', '#', '₹', '%', '&', '-', '+', '(', ')', SP(0.5)],
        ['_', '/', ':', ';', "'", '"', '!', '?', F('bksp', 2)],
        [F('mode', 1.5), ',', F('space', 5), '.', F('enter', 1.5), F('close', 1.25)],
      ],
      compact: [
        '12345'.split(''), '67890'.split(''),
        ['@', '#', '₹', '%', '&', '-', '+'],
        ['(', ')', '_', '/', ':', ';', F('bksp')],
        ["'", '"', '!', '?', ',', '.'],
        [F('mode', 1.2), F('space', 3), F('enter', 1.2), F('close')],
      ],
    },
  };

  /* ------------------------------------------------------------------ *
   * styles, injected once
   * ------------------------------------------------------------------ */
  var FONT = "Inter,'Public Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";
  var CSS = [
    /* the icon beside a field: absolutely placed, so nothing around it moves */
    '.tlvk-icon{position:absolute!important;z-index:3;display:inline-flex!important;align-items:center;justify-content:center;',
    '  width:30px;height:30px;min-width:0!important;min-height:0!important;padding:0!important;margin:0!important;border:0!important;',
    '  border-radius:8px!important;background:transparent!important;color:#6b7385!important;box-shadow:none!important;',
    '  cursor:pointer;line-height:0!important;font-size:0!important;flex:none!important;-webkit-tap-highlight-color:transparent;transition:background .12s,color .12s}',
    '.tlvk-icon::before{content:"";position:absolute;inset:-7px}',
    '.tlvk-icon:hover{color:var(--ai-600,#6d28d9)!important;background:var(--ai-100,#f2ecfe)!important}',
    '.tlvk-icon:focus-visible{outline:2px solid var(--ai-500,#7c3aed)!important;outline-offset:1px}',
    '.tlvk-icon[aria-expanded="true"]{color:#fff!important;background:var(--ai-500,#7c3aed)!important}',
    '.tlvk-icon svg{width:20px;height:20px;display:block;pointer-events:none}',

    /* the keyboard */
    '.tlvk{position:fixed;z-index:9300;box-sizing:border-box;left:0;top:0;padding:6px;background:#f4f1fb;',
    '  border:1px solid #e2dbf4;border-radius:16px;box-shadow:0 22px 48px -16px rgba(46,22,110,.38),0 2px 8px rgba(15,20,40,.08);',
    '  font-family:' + FONT + ';color:#191c2b;user-select:none;-webkit-user-select:none;touch-action:manipulation;',
    '  -webkit-tap-highlight-color:transparent;max-width:100vw}',
    '.tlvk[hidden]{display:none!important}',
    '.tlvk *,.tlvk *::before,.tlvk *::after{box-sizing:border-box}',
    '.tlvk.tlvk--dock{left:0!important;right:0!important;top:auto!important;bottom:0!important;width:auto!important;',
    '  border-radius:16px 16px 0 0;border-width:1px 0 0;',
    '  padding:6px max(6px,env(safe-area-inset-right)) calc(6px + env(safe-area-inset-bottom)) max(6px,env(safe-area-inset-left))}',
    '.tlvk-row{display:flex;gap:' + GAP + 'px}',
    '.tlvk-row+.tlvk-row{margin-top:' + GAP + 'px}',
    '.tlvk-sp{flex:0.5 1 0;min-width:0}',
    '.tlvk-k{flex:1 1 0;min-width:' + KEY + 'px;height:46px;min-height:' + KEY + 'px;margin:0;padding:0 2px;border:0;border-radius:10px;',
    '  background:#fff;color:#191c2b;font:inherit;font-size:19px;font-weight:500;line-height:1;cursor:pointer;',
    '  display:flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;overflow:hidden;',
    '  box-shadow:0 1px 0 rgba(40,24,96,.20),0 0 0 1px rgba(40,24,96,.05);transition:background .08s,transform .08s,box-shadow .08s}',
    '.tlvk-k.fn{background:#e6e0f7;color:#3a2a72;font-size:14px;font-weight:600}',
    '.tlvk-k.go{background:var(--ai-500,#7c3aed);color:#fff}',
    '.tlvk-k.sp-key{font-size:13px;font-weight:500;color:#5b5f73}',
    '.tlvk-k svg{width:22px;height:22px;flex:none;display:block;pointer-events:none}',
    '.tlvk-k:focus-visible{outline:2px solid var(--ai-600,#6d28d9);outline-offset:1px}',
    '.tlvk-k.is-down{background:var(--ai-100,#ede5fd);transform:translateY(1px);box-shadow:inset 0 0 0 2px var(--ai-500,#7c3aed)}',
    '.tlvk-k.go.is-down{background:var(--ai-600,#6d28d9);box-shadow:inset 0 0 0 2px rgba(255,255,255,.35)}',
    '.tlvk-k[aria-pressed="true"]{background:var(--ai-500,#7c3aed);color:#fff}',
    '.tlvk-k .tlvk-shift-b{opacity:0}',
    '.tlvk-k[data-shift="1"] .tlvk-shift-a,.tlvk-k[data-shift="2"] .tlvk-shift-a{fill:currentColor}',
    '.tlvk-k[data-shift="2"] .tlvk-shift-b{opacity:1}',
    '@media (hover:hover){.tlvk-k:hover{background:#faf8ff}.tlvk-k.fn:hover{background:#ddd5f3}.tlvk-k.go:hover{background:var(--ai-600,#6d28d9)}',
    '  .tlvk-k[aria-pressed="true"]:hover{background:var(--ai-600,#6d28d9)}}',
    '@media (max-width:420px){.tlvk-k{font-size:18px}.tlvk-k.fn{font-size:13px}.tlvk-k .tlvk-lbl{display:none}}',

    /* the combobox over a <select> */
    '.tlvk-cb{position:relative;display:block;min-width:0}',
    '.tlvk-cb .tlvk-cb-input{width:100%;min-width:0;padding-right:34px;text-overflow:ellipsis;',
    '  background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%235b6678\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Cpath d=\'m6 9 6 6 6-6\'/%3E%3C/svg%3E");',
    '  background-repeat:no-repeat;background-position:right 11px center;background-size:14px 14px}',
    '.tlvk-cb-list{position:fixed;z-index:9250;margin:0;padding:4px;list-style:none;overflow-y:auto;overscroll-behavior:contain;',
    '  background:#fff;border:1px solid var(--line,#e6e8ef);border-radius:12px;box-shadow:0 18px 40px -14px rgba(15,20,40,.30),0 2px 6px rgba(15,20,40,.06);',
    '  font-family:' + FONT + ';font-size:14px;color:var(--text,#0f1526)}',
    '.tlvk-cb-list[hidden]{display:none!important}',
    '.tlvk-cb-opt{display:flex;align-items:center;gap:8px;min-height:44px;padding:8px 10px;border-radius:8px;cursor:pointer;line-height:1.35}',
    '.tlvk-cb-opt .t{flex:1;min-width:0;overflow-wrap:anywhere}',
    '.tlvk-cb-opt .t b{font-weight:700;color:var(--ai-600,#6d28d9)}',
    '.tlvk-cb-opt svg{width:18px;height:18px;flex:none;color:var(--ai-500,#7c3aed);visibility:hidden}',
    '.tlvk-cb-opt[aria-selected="true"] svg{visibility:visible}',
    '.tlvk-cb-opt.is-active{background:var(--ai-100,#f2ecfe)}',
    '@media (hover:hover){.tlvk-cb-opt:hover{background:#f7f4fe}.tlvk-cb-opt.is-active:hover{background:var(--ai-100,#f2ecfe)}}',
    '.tlvk-cb-empty{padding:12px 10px;color:var(--text-soft,#616b82);font-size:13px}',
    '.tlvk-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
  ].join('\n');

  function addStyle() {
    if (document.getElementById('tlvk-css')) return;
    var s = document.createElement('style');
    s.id = 'tlvk-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ------------------------------------------------------------------ *
   * small helpers
   * ------------------------------------------------------------------ */
  var TYPES = { '': 1, text: 1, search: 1, email: 1, tel: 1, url: 1 };
  function isTextField(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.__tlkb || el.getAttribute('data-tlvk') === 'off') return false;   // the salary keypad has its own
    if (el.closest && el.closest('.tlvk')) return false;
    if (el.tagName === 'TEXTAREA') return !el.disabled && !el.readOnly;
    if (el.tagName === 'INPUT') return TYPES[(el.getAttribute('type') || '').toLowerCase()] === 1 && !el.disabled && !el.readOnly;
    var ce = el.getAttribute('contenteditable');
    return ce !== null && ce !== 'false' && el.isContentEditable;
  }
  var FIELD_SEL = 'input,textarea,[contenteditable]';
  var isCE = function (f) { return !!f && f.tagName !== 'INPUT' && f.tagName !== 'TEXTAREA'; };
  var valueOf = function (f) { return isCE(f) ? f.textContent : f.value; };
  var visible = function (el) { return !!(el && el.isConnected && el.getClientRects().length); };
  var coarse = function () { try { return matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches; } catch (e) { return false; } };
  var docked = function () { return document.documentElement.clientWidth <= DOCK_MAX || coarse(); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  };
  function selOf(f) {
    try {
      var a = f.selectionStart, b = f.selectionEnd;
      if (a == null || b == null) throw 0;
      return { start: Math.min(a, b), end: Math.max(a, b) };
    } catch (e) { var n = f.value.length; return { start: n, end: n }; }   // email and the like have no caret API
  }
  function setNative(f, v) {
    var proto = f.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(f, v); else f.value = v;
  }
  function setCaret(f, p) { try { f.setSelectionRange(p, p); } catch (e) { /* no caret API */ } }
  function inputEvent(type, inputType, data) {
    try { return new InputEvent(type, { bubbles: true, cancelable: type === 'beforeinput', composed: true, inputType: inputType, data: data == null ? null : data }); }
    catch (e) { var ev = document.createEvent('Event'); ev.initEvent(type, true, type === 'beforeinput'); return ev; }
  }
  function enterEvent(type) {
    var e = new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: type === 'keypress' ? 13 : 0, bubbles: true, cancelable: true, composed: true });
    if (e.keyCode !== 13) {
      try {
        Object.defineProperty(e, 'keyCode', { get: function () { return 13; } });
        Object.defineProperty(e, 'which', { get: function () { return 13; } });
      } catch (x) { /* old engine */ }
    }
    return e;
  }
  function fixedAncestor(el) {
    for (var x = el && el.parentElement; x && x !== document.body && x !== document.documentElement; x = x.parentElement) {
      if (getComputedStyle(x).position === 'fixed') return x;
    }
    return null;
  }
  function frame(fn) { var queued = false; return function () { if (queued) return; queued = true; requestAnimationFrame(function () { queued = false; fn(); }); }; }

  /* ------------------------------------------------------------------ *
   * the keyboard (one, shared by every field)
   * ------------------------------------------------------------------ */
  var S = {
    root: null, group: null, open: false, field: null, fieldId: '', prevIM: null, committed: '',
    swallowUntil: 0, mode: 'abc', compact: null, built: '', shift: 0, lastShift: 0,
    repeatT: null, repeatI: null, pad: null, lift: null, bodyMO: null,
  };

  function ensureRoot() {
    if (S.root) return S.root;
    addStyle();
    var r = document.createElement('div');
    r.className = 'tlvk';
    r.id = 'tlvk-keyboard';
    r.hidden = true;
    r.setAttribute('role', 'dialog');
    r.setAttribute('aria-modal', 'false');
    r.setAttribute('aria-label', 'On-screen keyboard');
    r.innerHTML = '<div class="tlvk-keys" role="group" aria-label="Letters"></div>';
    S.group = r.firstChild;
    r.addEventListener('pointerdown', onKeyPointerDown);
    r.addEventListener('mousedown', function (e) { e.preventDefault(); });        // the field keeps the focus
    r.addEventListener('click', onKeyClick);
    /* A key acts on pointerdown. When that closes the keyboard, the click that follows a touch lands
       on whatever was underneath it (the page's bottom bar, say): swallow it. */
    document.addEventListener('click', function (e) {
      if (Date.now() < S.swallowUntil) {
        S.swallowUntil = 0;                       // that one click only
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      }
    }, true);
    r.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.body.appendChild(r);
    S.root = r;
    return r;
  }

  function keyLabel(ch) {
    if (/[a-z]/.test(ch)) return S.shift ? 'Capital ' + ch.toUpperCase() : ch;
    return NAMES[ch] || ch;
  }
  function charOut(ch) { return /[a-z]/.test(ch) && S.shift ? ch.toUpperCase() : ch; }

  function fnKeyHtml(k, w) {
    var style = w && w !== 1 ? ' style="flex-grow:' + w + '"' : '';
    switch (k) {
      case 'shift':
        return '<button type="button" class="tlvk-k fn" data-k="shift" aria-label="Shift" aria-pressed="false" data-shift="0"' + style + '>' + ICON.shift + '</button>';
      case 'bksp':
        return '<button type="button" class="tlvk-k fn" data-k="bksp" aria-label="Backspace"' + style + '>' + ICON.bksp + '</button>';
      case 'space':
        return '<button type="button" class="tlvk-k sp-key" data-k="space" aria-label="Space"' + style + '>' + ICON.space + '<span class="tlvk-lbl">space</span></button>';
      case 'enter':
        return '<button type="button" class="tlvk-k go" data-k="enter" aria-label="Enter"' + style + '>' + ICON.enter + '</button>';
      case 'close':
        return '<button type="button" class="tlvk-k fn" data-k="close" aria-label="Close keyboard"' + style + '>' + ICON.close + '</button>';
      case 'mode':
        return S.mode === 'abc'
          ? '<button type="button" class="tlvk-k fn" data-k="mode" aria-label="Numbers and symbols"' + style + '>123</button>'
          : '<button type="button" class="tlvk-k fn" data-k="mode" aria-label="Letters"' + style + '>ABC</button>';
    }
    return '';
  }

  function build() {
    var sig = S.mode + (S.compact ? ':c' : ':f');
    if (S.built === sig) return;
    S.built = sig;
    var rows = LAYOUTS[S.mode][S.compact ? 'compact' : 'full'];
    S.group.setAttribute('aria-label', S.mode === 'abc' ? 'Letters' : 'Numbers and symbols');
    S.group.innerHTML = rows.map(function (row) {
      return '<div class="tlvk-row">' + row.map(function (k) {
        if (typeof k === 'string') {
          return '<button type="button" class="tlvk-k" data-k="char" data-c="' + esc(k) + '" aria-label="' + esc(keyLabel(k)) + '">' + esc(charOut(k)) + '</button>';
        }
        if (k.sp) return '<span class="tlvk-sp" aria-hidden="true" style="flex-grow:' + k.sp + '"></span>';
        return fnKeyHtml(k.k, k.w);
      }).join('') + '</div>';
    }).join('');
    paintShift();
  }

  function paintShift() {
    if (!S.group) return;
    var b = S.group.querySelector('[data-k="shift"]');
    if (b) {
      b.setAttribute('aria-pressed', S.shift ? 'true' : 'false');
      b.setAttribute('data-shift', String(S.shift));
      b.setAttribute('aria-label', S.shift === 2 ? 'Shift, caps lock on' : 'Shift');
    }
    Array.prototype.forEach.call(S.group.querySelectorAll('[data-k="char"]'), function (k) {
      var c = k.getAttribute('data-c');
      if (!/[a-z]/.test(c)) return;
      k.textContent = charOut(c);
      k.setAttribute('aria-label', keyLabel(c));
    });
  }

  function layout() {
    var r = S.root;
    var cs = getComputedStyle(r);
    var inner = r.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    var compact = inner < FULL_MIN;
    if (compact !== S.compact) { S.compact = compact; S.built = ''; }
    build();
  }

  /* ---------- editing ---------- */

  function ensureFocus() {
    var f = S.field;
    if (f && document.activeElement !== f) { try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); } }
  }

  function insert(text, inputType) {
    var f = S.field;
    if (!f || !f.isConnected) return false;
    ensureFocus();
    if (isCE(f)) {
      if (!document.execCommand(inputType === 'insertLineBreak' ? 'insertLineBreak' : 'insertText', false, text)) {
        var s = window.getSelection();
        if (s && s.rangeCount) {
          var rg = s.getRangeAt(0); rg.deleteContents(); rg.insertNode(document.createTextNode(text)); rg.collapse(false);
          f.dispatchEvent(inputEvent('input', inputType, text));
        }
      }
      return true;
    }
    var v = f.value, sel = selOf(f);
    var max = f.maxLength;
    if (max != null && max >= 0) {
      var room = max - (v.length - (sel.end - sel.start));
      if (room <= 0) return false;
      if (text.length > room) text = Array.from(text).reduce(function (acc, ch) { return acc.length + ch.length <= room ? acc + ch : acc; }, '');
      if (!text) return false;
    }
    if (!f.dispatchEvent(inputEvent('beforeinput', inputType, text))) return false;
    setNative(f, v.slice(0, sel.start) + text + v.slice(sel.end));
    setCaret(f, sel.start + text.length);
    f.dispatchEvent(inputEvent('input', inputType, text));
    return true;
  }

  function backspace() {
    var f = S.field;
    if (!f || !f.isConnected) return;
    ensureFocus();
    if (isCE(f)) { document.execCommand('delete', false); return; }
    var v = f.value, sel = selOf(f), from = sel.start, to = sel.end;
    if (from === to) {
      if (from === 0) return;
      var c = v.charCodeAt(from - 1);
      from -= (c >= 0xDC00 && c <= 0xDFFF && from > 1) ? 2 : 1;      // a whole surrogate pair
    }
    if (!f.dispatchEvent(inputEvent('beforeinput', 'deleteContentBackward', null))) return;
    setNative(f, v.slice(0, from) + v.slice(to));
    setCaret(f, from);
    f.dispatchEvent(inputEvent('input', 'deleteContentBackward', null));
  }

  function commitChange() {
    var f = S.field;
    if (!f || !f.isConnected || isCE(f)) return;
    if (f.value !== S.committed) {
      S.committed = f.value;
      f.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function enter() {
    var f = S.field;
    if (!f || !f.isConnected) return;
    if (f.tagName === 'TEXTAREA') { insert('\n', 'insertLineBreak'); return; }
    ensureFocus();
    var ok = f.dispatchEvent(enterEvent('keydown'));
    if (ok && f.isConnected) ok = f.dispatchEvent(enterEvent('keypress'));
    if (ok && f.isConnected) {
      if (isCE(f)) { insert('\n', 'insertLineBreak'); }
      else {
        commitChange();
        var form = f.form;
        if (form && form.isConnected) {
          // the browser's own Enter: implicit submission through the default button, unless it is disabled
          var btn = form.querySelector('button[type="submit"],input[type="submit"],button:not([type])');
          if (!(btn && btn.disabled)) {
            if (typeof form.requestSubmit === 'function') { if (btn) form.requestSubmit(btn); else form.requestSubmit(); }
            else if (btn) btn.click();
          }
        }
      }
    }
    if (f.isConnected) f.dispatchEvent(enterEvent('keyup'));
  }

  function act(k, el) {
    if (!S.open) return;
    switch (k) {
      case 'char': {
        var c = el.getAttribute('data-c');
        insert(charOut(c), 'insertText');
        if (S.shift === 1 && /[a-z]/.test(c)) { S.shift = 0; paintShift(); }
        break;
      }
      case 'space': insert(' ', 'insertText'); break;
      case 'bksp': backspace(); break;
      case 'enter': enter(); break;
      case 'close': close('button'); return;
      case 'mode': S.mode = S.mode === 'abc' ? 'num' : 'abc'; S.built = ''; build(); place(false); break;
      case 'shift': {
        var now = Date.now();
        if (S.shift === 2) S.shift = 0;
        else if (S.shift === 1) S.shift = now - S.lastShift < 450 ? 2 : 0;
        else S.shift = 1;
        S.lastShift = now;
        paintShift();
        break;
      }
    }
  }

  /* ---------- pointer and keyboard activation of keys ---------- */

  function stopRepeat() {
    clearTimeout(S.repeatT); clearInterval(S.repeatI); S.repeatT = S.repeatI = null;
    if (S.down) { S.down.classList.remove('is-down'); S.down = null; }
    window.removeEventListener('pointerup', stopRepeat, true);
    window.removeEventListener('pointercancel', stopRepeat, true);
  }

  function onKeyPointerDown(e) {
    e.preventDefault();                       // never take the focus from the field
    var k = e.target.closest && e.target.closest('.tlvk-k');
    if (!k || (e.pointerType === 'mouse' && e.button !== 0)) return;
    stopRepeat();
    k.classList.add('is-down');
    S.down = k;
    window.addEventListener('pointerup', stopRepeat, true);
    window.addEventListener('pointercancel', stopRepeat, true);
    var name = k.getAttribute('data-k');
    if (name === 'close') S.swallowUntil = Date.now() + 700;
    act(name, k);
    if (name === 'bksp') {
      S.repeatT = setTimeout(function () {
        S.repeatI = setInterval(function () { if (S.open) backspace(); else stopRepeat(); }, 60);
      }, 420);
    }
  }

  function onKeyClick(e) {
    var k = e.target.closest && e.target.closest('.tlvk-k');
    if (!k) return;
    if (e.detail !== 0) return;               // a pointer press: done on pointerdown
    k.classList.add('is-down');
    setTimeout(function () { k.classList.remove('is-down'); }, 110);
    act(k.getAttribute('data-k'), k);        // Enter / Space on a focused key
  }

  /* ---------- placement ---------- */

  function padBody(h) {
    var b = document.body;
    if (!S.pad) S.pad = { inline: b.style.paddingBottom, base: parseFloat(getComputedStyle(b).paddingBottom) || 0 };
    b.style.paddingBottom = (S.pad.base + h) + 'px';
  }
  function unpadBody() {
    if (!S.pad) return;
    document.body.style.paddingBottom = S.pad.inline;
    S.pad = null;
  }
  function lift(el, amt) {
    if (S.lift && S.lift.el !== el) unlift();
    if (!S.lift) S.lift = { el: el, prev: el.style.translate };
    el.style.translate = '0px ' + (-Math.round(amt)) + 'px';
  }
  function unlift() {
    if (!S.lift) return;
    S.lift.el.style.translate = S.lift.prev;
    S.lift = null;
  }
  function fieldBox(f) {
    var r = f.getBoundingClientRect();
    var reserve = parseFloat(f.getAttribute('data-tlvk-reserve')) || 0;   // room a field wants below it (a combobox list)
    return { top: r.top, bottom: r.bottom, below: r.bottom + reserve, left: r.left, right: r.right };
  }

  /* adjust: may scroll the page / lift a fixed panel so the field is in view */
  function place(adjust) {
    if (!S.open) return;
    var f = S.field, R = S.root;
    var vw = document.documentElement.clientWidth, vh = window.innerHeight;
    var dock = docked();
    R.classList.toggle('tlvk--dock', dock);
    if (dock) { R.style.left = ''; R.style.top = ''; R.style.width = ''; }
    else R.style.width = Math.min(640, vw - 16) + 'px';
    layout();
    var kh = R.offsetHeight;
    var anc = fixedAncestor(f);
    if (adjust) unlift();
    if (dock) {
      if (!anc) padBody(kh);
      if (adjust) {
        var b = fieldBox(f), top = vh - kh;
        var need = b.below + 8 - top;
        if (need > 0) {
          var amt = Math.min(need, Math.max(0, b.top - 8));        // the field itself never leaves the top
          if (amt > 0) { if (anc) lift(anc, amt); else window.scrollBy(0, amt); }
        } else if (b.top < 8 && !anc) window.scrollBy(0, b.top - 8);
      }
    } else {
      if (adjust) {
        var b1 = fieldBox(f);
        var need1 = b1.below + 8 + kh + 8 - vh;
        if (need1 > 0) {
          var amt1 = Math.min(need1, Math.max(0, b1.top - 8));
          if (amt1 > 0) { if (anc) lift(anc, amt1); else { padBody(kh + 16); window.scrollBy(0, amt1); } }
        }
      }
      var bx = fieldBox(f), w = R.offsetWidth;
      var left = Math.min(Math.max(8, bx.left), vw - w - 8);
      var top1 = bx.below + 8;
      if (top1 + kh > vh - 8 && bx.top - 8 - kh >= 8) top1 = bx.top - 8 - kh;       // no room below: just above it
      R.style.left = Math.max(0, Math.round(left)) + 'px';
      R.style.top = Math.round(top1) + 'px';
    }
    try { f.dispatchEvent(new CustomEvent('tlvk:placed')); } catch (e) { /* old engine */ }
  }
  var placeSoon = frame(function () { place(true); });
  var followSoon = frame(function () { if (S.open && !docked()) place(false); });

  /* ---------- open / close ---------- */

  function onDocPointerDown(e) {
    if (!S.open) return;
    var t = e.target;
    if (inside(t)) return;
    close('outside');
  }
  function inside(t) {
    if (!t || !t.nodeType) return false;
    var f = S.field, ic = iconFor(f);
    if (S.root.contains(t) || (f && (t === f || f.contains(t))) || (ic && ic.contains(t))) return true;
    var ctl = f && f.getAttribute('aria-controls');
    var ce = ctl && document.getElementById(ctl);
    return !!(ce && ce.contains(t));
  }
  function onDocKeyDown(e) {
    if (!S.open || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();     // the top layer closes first; a second Escape reaches the page
    close('escape');
  }
  function onDocFocusIn(e) {
    if (!S.open || inside(e.target)) return;
    close('outside');
  }
  function onBodyMutate() {
    if (!S.open || S.field.isConnected) return;
    // the page re-drew the field (the chat does after each message): follow it by id, or close
    queueMicrotask(function () {
      if (!S.open || S.field.isConnected) return;
      var nf = S.fieldId && document.getElementById(S.fieldId);
      if (nf && isTextField(nf) && visible(nf)) retarget(nf);
      else close('gone');
    });
  }

  function takeField(f) {
    S.field = f;
    S.fieldId = f.id || '';
    S.prevIM = f.getAttribute('inputmode');
    f.setAttribute('inputmode', 'none');
    S.committed = valueOf(f);
    var ic = iconFor(f);
    if (ic) ic.setAttribute('aria-expanded', 'true');
  }
  function releaseField(f) {
    if (!f) return;
    if (S.prevIM == null) f.removeAttribute('inputmode'); else f.setAttribute('inputmode', S.prevIM);
    var ic = iconFor(f);
    if (ic) ic.setAttribute('aria-expanded', 'false');
  }
  function retarget(nf) {
    var old = S.field;
    releaseField(old);
    takeField(nf);
    try { nf.focus({ preventScroll: true }); } catch (e) { nf.focus(); }
    place(true);
  }

  function open(f) {
    if (!isTextField(f) || !f.isConnected) return false;
    if (S.open && S.field === f) return true;
    if (S.open) close('switch');
    ensureRoot();
    var wasFocused = document.activeElement === f;
    S.mode = 'abc'; S.shift = 0; S.built = ''; S.compact = null;
    takeField(f);
    S.open = true;
    S.root.hidden = false;
    place(true);
    if (wasFocused && coarse()) { f.blur(); }        // so a phone drops its own keyboard for inputmode=none
    try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); }
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onDocKeyDown, true);
    document.addEventListener('focusin', onDocFocusIn, true);
    window.addEventListener('resize', placeSoon);
    window.addEventListener('scroll', followSoon, true);
    if (window.visualViewport) visualViewport.addEventListener('resize', placeSoon);
    S.bodyMO = new MutationObserver(onBodyMutate);
    S.bodyMO.observe(document.body, { childList: true, subtree: true });
    return true;
  }

  /* how: 'button' | 'escape' -> focus back to the field (else its icon); 'outside' | 'switch' | 'gone' | 'pick' -> leave focus alone */
  function close(how) {
    if (!S.open) return;
    stopRepeat();
    commitChange();
    var f = S.field, ic = iconFor(f);
    releaseField(f);
    unlift();
    unpadBody();
    S.open = false;
    S.root.hidden = true;
    S.field = null;
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    document.removeEventListener('focusin', onDocFocusIn, true);
    window.removeEventListener('resize', placeSoon);
    window.removeEventListener('scroll', followSoon, true);
    if (window.visualViewport) visualViewport.removeEventListener('resize', placeSoon);
    if (S.bodyMO) { S.bodyMO.disconnect(); S.bodyMO = null; }
    if (f && f.isConnected) { try { f.dispatchEvent(new CustomEvent('tlvk:placed')); } catch (e) { /* old engine */ } }
    if (how === 'button' || how === 'escape') {
      // On a touch-first phone the field would raise the phone keyboard again, so the icon takes the focus there.
      if (f && visible(f) && !coarse()) { try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); } }
      else if (ic && visible(ic)) ic.focus();
      else if (f && visible(f)) f.focus();
    }
  }

  /* ------------------------------------------------------------------ *
   * the icon beside each field
   * ------------------------------------------------------------------ */
  var REG = new Map();     // field -> { icon, wrap, handle, ro, prevPad, prevPos }
  var WRAPS = new Map();   // wrapper -> { count, prev }
  function iconFor(f) { var r = f && REG.get(f); return r ? r.icon : null; }

  function posIcon(rec) {
    var f = rec.field, ic = rec.icon, op = ic.offsetParent;
    if (!op || !f.getClientRects().length) return;
    var fr = f.getBoundingClientRect(), or = op.getBoundingClientRect();
    var size = Math.max(24, Math.min(30, fr.height - 6));
    var inset = parseFloat(f.getAttribute('data-tlvk-inset')) || 0;
    ic.style.width = ic.style.height = size + 'px';
    var x = fr.right - or.left - op.clientLeft + op.scrollLeft - size - 5 - inset;
    var multi = f.tagName === 'TEXTAREA' || isCE(f);
    var y = (fr.top - or.top - op.clientTop + op.scrollTop) + (multi ? 5 : (fr.height - size) / 2);
    ic.style.left = Math.round(x) + 'px';
    ic.style.top = Math.round(y) + 'px';
  }

  function enhance(f, handle) {
    if (REG.has(f)) return;
    var wrap = f.parentElement;
    if (!wrap) return;
    addStyle();
    var w = WRAPS.get(wrap);
    if (!w) {
      w = { count: 0, prev: wrap.style.position };
      if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
      WRAPS.set(wrap, w);
    }
    w.count += 1;
    var ic = document.createElement('button');
    ic.type = 'button';
    ic.className = 'tlvk-icon';
    ic.tabIndex = 0;
    ic.setAttribute('aria-label', 'Open on-screen keyboard');
    ic.setAttribute('aria-haspopup', 'dialog');
    ic.setAttribute('aria-expanded', S.open && S.field === f ? 'true' : 'false');
    ic.setAttribute('aria-controls', 'tlvk-keyboard');
    ic.title = 'On-screen keyboard';
    ic.innerHTML = ICON.keyboard;
    ic.addEventListener('pointerdown', function (e) { e.preventDefault(); });   // the field keeps focus and caret
    ic.addEventListener('mousedown', function (e) { e.preventDefault(); });
    ic.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (S.open && S.field === f) close('button'); else open(f);
    });
    f.insertAdjacentElement('afterend', ic);
    var rec = { field: f, icon: ic, wrap: wrap, handle: handle, prevPad: f.style.paddingRight };
    var basePad = parseFloat(getComputedStyle(f).paddingRight) || 0;
    f.style.paddingRight = (basePad + 36) + 'px';     // text never runs under the icon; the box keeps its size
    REG.set(f, rec);
    posIcon(rec);
    if (window.ResizeObserver) {
      rec.ro = new ResizeObserver(function () { posIcon(rec); });
      rec.ro.observe(f); rec.ro.observe(wrap);
    }
  }

  function unenhance(f) {
    var rec = REG.get(f);
    if (!rec) return;
    if (S.open && S.field === f && f.isConnected) close('gone');   // a re-drawn field is followed by onBodyMutate
    REG.delete(f);
    if (rec.ro) rec.ro.disconnect();
    if (rec.icon.parentNode) rec.icon.parentNode.removeChild(rec.icon);
    if (f.isConnected) f.style.paddingRight = rec.prevPad;
    var w = WRAPS.get(rec.wrap);
    if (w && --w.count <= 0) { rec.wrap.style.position = w.prev; WRAPS.delete(rec.wrap); }
  }

  var HANDLES = [];
  function resolve(t) { return typeof t === 'string' ? document.querySelector(t) : t; }

  function scan(h) {
    if (h.dead) return;
    if (h.onScan) { try { h.onScan(h.root); } catch (e) { /* never break a page */ } }
    REG.forEach(function (rec, f) {
      if (rec.handle !== h) return;
      if (!f.isConnected || !isTextField(f) || (h.filter && !h.filter(f))) unenhance(f);
    });
    if (!h.root.isConnected) return;
    var list = isTextField(h.root) ? [h.root] : h.root.querySelectorAll(FIELD_SEL);
    Array.prototype.forEach.call(list, function (f) {
      if (isTextField(f) && (!h.filter || h.filter(f))) enhance(f, h);
    });
    REG.forEach(function (rec) { if (rec.handle === h) posIcon(rec); });
  }

  function attach(target, opts) {
    var root = resolve(target);
    if (!root || root.nodeType !== 1) return null;
    opts = opts || {};
    var h = { root: root, filter: typeof opts.filter === 'function' ? opts.filter : null, onScan: typeof opts.onScan === 'function' ? opts.onScan : null };
    HANDLES.push(h);
    scan(h);
    if (!isTextField(root)) {
      h.mo = new MutationObserver(function (muts) {
        // only our own icon going in: nothing new to look at
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.target.closest && m.target.closest('.tlvk-cb-list, .tlvk-sr')) continue;   // a combobox list redrawing
          var nodes = Array.prototype.slice.call(m.addedNodes).concat(Array.prototype.slice.call(m.removedNodes));
          if (nodes.some(function (n) { return !(n.nodeType === 1 && n.classList.contains('tlvk-icon')); })) { scan(h); return; }
        }
      });
      h.mo.observe(root, { childList: true, subtree: true });
    }
    return { detach: function () { detachHandle(h); }, refresh: function () { scan(h); } };
  }

  function detachHandle(h) {
    if (h.dead) return;
    h.dead = true;
    if (h.mo) h.mo.disconnect();
    REG.forEach(function (rec, f) { if (rec.handle === h) unenhance(f); });
    HANDLES = HANDLES.filter(function (x) { return x !== h; });
  }

  function detach(target) {
    if (target == null) { close('gone'); HANDLES.slice().forEach(detachHandle); return; }
    var el = resolve(target);
    if (!el) return;
    HANDLES.slice().forEach(function (h) { if (h.root === el) detachHandle(h); });
    if (REG.has(el)) unenhance(el);
  }

  window.addEventListener('resize', frame(function () { REG.forEach(posIcon); }));

  /* ------------------------------------------------------------------ *
   * combobox: a <select> you can search by typing
   *
   * The <select> stays in the page, hidden, and is still what the page
   * reads: picking an option sets its value and fires its own change
   * event, exactly as choosing it in the dropdown does.
   * ------------------------------------------------------------------ */
  var CB = new WeakMap();
  var pendingFocus = null;     // after a keyboard pick the page re-renders; focus the new box
  /* The page re-renders from time to time (render() redraws #app). What is being typed in a
     box, and whether it had the focus, carry over to the box drawn for the same <select>. */
  var DRAFT = {};
  var FOCUSED = null;

  function selectKey(sel) { return sel.id || sel.name || sel.getAttribute('onchange') || ''; }
  function stableId(sel) {
    var base = 'tlvk-cb-' + (selectKey(sel).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'select');
    var id = base, n = 1;
    while (document.getElementById(id)) id = base + '-' + (++n);
    return id;
  }
  function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

  function combobox(sel) {
    if (!sel || sel.tagName !== 'SELECT' || sel.multiple) return null;
    var got = CB.get(sel);
    if (got) return got.input;
    addStyle();
    var key = selectKey(sel);
    var group = sel.closest('.fgroup');
    var lab = (sel.id && document.querySelector('label[for="' + sel.id + '"]')) || (group && group.querySelector('label')) || null;
    var name = lab ? lab.textContent.trim() : (sel.getAttribute('aria-label') || 'Choose');

    var wrap = document.createElement('div');
    wrap.className = 'tlvk-cb';
    var input = document.createElement('input');
    input.type = 'text';
    input.id = stableId(sel);
    input.className = 'tlvk-cb-input';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', input.id + '-list');
    input.setAttribute('aria-label', name);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('data-tlvk-reserve', '252');
    input.setAttribute('data-tlvk-inset', '24');
    input.placeholder = 'Type to search';
    var list = document.createElement('ul');
    list.id = input.id + '-list';
    list.className = 'tlvk-cb-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', name);
    list.hidden = true;
    var live = document.createElement('div');
    live.className = 'tlvk-sr';
    live.setAttribute('aria-live', 'polite');
    wrap.appendChild(input); wrap.appendChild(list); wrap.appendChild(live);

    var st = { sel: sel, input: input, list: list, open: false, items: [], active: -1 };
    CB.set(sel, st);

    var prevDisplay = sel.style.display;
    sel.style.display = 'none';
    sel.setAttribute('aria-hidden', 'true');
    sel.tabIndex = -1;
    sel.insertAdjacentElement('afterend', wrap);

    function current() { return sel.options[sel.selectedIndex] || null; }
    function shownText() { var o = current(); return o ? o.text : ''; }
    input.value = shownText();
    var draft = DRAFT[key];
    if (draft && Date.now() - draft.at < 120000) input.value = draft.value;

    function options() { return Array.prototype.filter.call(sel.options, function (o) { return !o.disabled && !o.hidden; }); }

    function paint(q) {
      var all = options();
      var query = norm(q);
      if (query === norm(shownText())) query = '';          // the box still shows the choice: list everything
      var words = query ? query.split(' ') : [];
      st.items = words.length ? all.filter(function (o) { var t = norm(o.text); return words.every(function (w) { return t.indexOf(w) >= 0; }); }) : all;
      if (st.active >= st.items.length) st.active = st.items.length - 1;
      list.innerHTML = st.items.length ? st.items.map(function (o, i) {
        var t = esc(o.text);
        if (words[0]) {
          var at = norm(o.text).indexOf(words[0]);
          if (at >= 0 && o.text.length === norm(o.text).length) t = esc(o.text.slice(0, at)) + '<b>' + esc(o.text.slice(at, at + words[0].length)) + '</b>' + esc(o.text.slice(at + words[0].length));
        }
        return '<li class="tlvk-cb-opt' + (i === st.active ? ' is-active' : '') + '" role="option" id="' + list.id + '-' + i + '" data-i="' + i + '" aria-selected="' + (o.value === sel.value ? 'true' : 'false') + '">'
          + ICON.check + '<span class="t">' + t + '</span></li>';
      }).join('') : '<li class="tlvk-cb-empty" role="presentation">No matching options</li>';
      if (st.active >= 0) input.setAttribute('aria-activedescendant', list.id + '-' + st.active);
      else input.removeAttribute('aria-activedescendant');
      live.textContent = st.items.length ? st.items.length + (st.items.length === 1 ? ' option' : ' options') : 'No matching options';
    }

    function posList() {
      if (!st.open) return;
      var r = input.getBoundingClientRect(), vh = window.innerHeight;
      var limit = vh - 8, ceiling = 8;
      if (S.open && S.root && !S.root.hidden) {
        var kr = S.root.getBoundingClientRect();
        if (kr.top >= r.bottom) limit = Math.min(limit, kr.top - 6);
        else if (kr.bottom <= r.top) ceiling = kr.bottom + 6;
      }
      var below = limit - (r.bottom + 4), above = r.top - 4 - ceiling;
      list.style.left = Math.round(r.left) + 'px';
      list.style.width = Math.round(r.width) + 'px';
      if (below >= 132 || below >= above) {
        list.style.top = Math.round(r.bottom + 4) + 'px'; list.style.bottom = 'auto';
        list.style.maxHeight = Math.max(88, Math.min(240, below)) + 'px';
      } else {
        list.style.top = 'auto'; list.style.bottom = Math.round(vh - r.top + 4) + 'px';
        list.style.maxHeight = Math.max(88, Math.min(240, above)) + 'px';
      }
    }
    var posSoon = frame(posList);

    function showActive() {
      Array.prototype.forEach.call(list.querySelectorAll('.tlvk-cb-opt'), function (li) {
        li.classList.toggle('is-active', +li.getAttribute('data-i') === st.active);
      });
      if (st.active >= 0) {
        input.setAttribute('aria-activedescendant', list.id + '-' + st.active);
        var li = document.getElementById(list.id + '-' + st.active);
        if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
      } else input.removeAttribute('aria-activedescendant');
    }

    function openList() {
      if (!st.open) {
        st.open = true;
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        window.addEventListener('scroll', posSoon, true);
        window.addEventListener('resize', posSoon);
      }
      posList();
    }
    function closeList(restore) {
      if (st.open) {
        st.open = false;
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        window.removeEventListener('scroll', posSoon, true);
        window.removeEventListener('resize', posSoon);
      }
      if (restore) { input.value = shownText(); if (input.isConnected) delete DRAFT[key]; }
    }

    function pick(i, byKey) {
      var o = st.items[i];
      if (!o) return;
      closeList(false);
      delete DRAFT[key];
      FOCUSED = null;                 // a tap leaves the focus alone (a phone would raise its keyboard); Enter refocuses
      input.value = o.text;
      if (S.open && S.field === input) close('pick');
      if (o.value !== sel.value) {
        if (byKey) pendingFocus = { key: selectKey(sel), at: Date.now() };
        sel.value = o.value;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));    // the page's own onchange runs, as with the dropdown
      }
    }

    input.addEventListener('focus', function () {
      FOCUSED = key;
      st.active = -1;
      paint(input.value);
      var o = current();
      if (o) { st.active = st.items.indexOf(o); showActive(); }
      openList();
      requestAnimationFrame(function () { if (document.activeElement === input && input.value === shownText()) { try { input.select(); } catch (e) { /* fine */ } } });
    });
    input.addEventListener('input', function () {
      DRAFT[key] = { value: input.value, at: Date.now() };
      st.active = 0;
      paint(input.value);
      if (!st.items.length) st.active = -1;
      showActive();
      openList();
    });
    input.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        e.preventDefault();
        if (!st.open) { paint(input.value); openList(); }
        if (!st.items.length) return;
        if (k === 'ArrowDown') st.active = st.active < st.items.length - 1 ? st.active + 1 : 0;
        else st.active = st.active > 0 ? st.active - 1 : st.items.length - 1;
        showActive();
      } else if (k === 'Enter') {
        if (st.open && st.active >= 0) { e.preventDefault(); pick(st.active, e.isTrusted); }
        else if (st.open) e.preventDefault();
      } else if (k === 'Escape') {
        if (st.open) { e.preventDefault(); e.stopPropagation(); closeList(true); }
      } else if (k === 'Tab') {
        closeList(true);
      }
    });
    input.addEventListener('blur', function () {
      setTimeout(function () {
        if (!input.isConnected) return;               // re-drawn, not left: the new box carries on
        if (document.activeElement !== input) { closeList(true); if (FOCUSED === key) FOCUSED = null; }
      }, 0);
    });
    input.addEventListener('tlvk:placed', posSoon);
    list.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    list.addEventListener('mousedown', function (e) { e.preventDefault(); });
    list.addEventListener('click', function (e) {
      var li = e.target.closest && e.target.closest('.tlvk-cb-opt');
      if (li) pick(+li.getAttribute('data-i'), false);
    });

    st.undo = function () {
      closeList(false);
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      sel.style.display = prevDisplay; sel.removeAttribute('aria-hidden'); sel.removeAttribute('tabindex');
      CB.delete(sel);
    };
    var refocus = false;
    if (pendingFocus && pendingFocus.key === key && Date.now() - pendingFocus.at < 2000) { pendingFocus = null; refocus = true; }
    else if (FOCUSED === key) refocus = true;           // it had the focus when the page re-drew
    if (refocus) {
      setTimeout(function () {
        var a = document.activeElement;
        if (input.isConnected && (!a || a === document.body || a === input)) input.focus({ preventScroll: true });
      }, 0);
    }
    return input;
  }

  /* ------------------------------------------------------------------ *
   * the API
   * ------------------------------------------------------------------ */
  window.TLKeyboard = {
    attach: attach,
    detach: detach,
    open: function (f) { return open(resolve(f)); },
    close: function () { close('button'); },
    isOpen: function () { return S.open; },
    field: function () { return S.open ? S.field : null; },
    combobox: function (sel) { return combobox(resolve(sel)); },
  };

  /* ------------------------------------------------------------------ *
   * where it is used: the AI Career Hub, and the TeamLink AI chat
   * wherever it renders. One observer on #app, which render() redraws.
   * ------------------------------------------------------------------ */
  var onCareerHub = function () { return /^#\/candidate\/career(?:[/?]|$)/.test(location.hash || ''); };
  var isChatInput = function (f) {
    return f.id === 'cpChatIn' || f.id === 'assistantInput' || !!(f.closest && f.closest('.cp-chat, .tlca-panel'));
  };

  function wire() {
    var app = document.getElementById('app');
    if (!app) return;
    var handle = attach(app, {
      filter: function (f) { return isChatInput(f) || onCareerHub(); },
      onScan: function (root) {
        if (!onCareerHub()) return;
        // "Target role", and any other long dropdown on the page, becomes searchable by typing
        Array.prototype.forEach.call(root.querySelectorAll('select'), function (sel) {
          if (CB.has(sel) || sel.multiple || !sel.options.length) return;
          var target = /setSkillGapTarget/.test(sel.getAttribute('onchange') || '');
          if (target || sel.options.length >= 12) combobox(sel);
        });
      },
    });
    window.addEventListener('hashchange', function () { if (handle) handle.refresh(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
