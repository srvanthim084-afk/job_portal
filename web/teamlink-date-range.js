/* =====================================================================
   TEAMLINK - "Applied Date": one calendar range picker (0130)

   ONE COMPONENT, three places: the recruiter Applications filters, the
   Talent Pool (Added on / Applied on) and the candidate's Applications
   page. Each place asks for a field by id and is told the selection.

     TLDateRange.field(id, { from, to, preset, placeholder, onChange })
         -> the field's HTML ("📅 01 Oct 2026 - 09 Oct 2026  ✕").
            Safe to call on every render: the latest options win.
     onChange({ from, to, preset })   from/to 'YYYY-MM-DD' (IST) or ''.

   THE POPUP. Presets on the left (Today, Yesterday, Last 7 days, Last 30
   days, This month, Last month, Custom range); a month calendar on the
   right where a click picks the start, a second click the end (a single
   day is allowed - Apply after one click), the range highlighted as the
   mouse moves. Apply and Clear; the small ✕ in the field clears too.
   Future days cannot be picked. Days are India days (IST) and shown as
   DD MMM YYYY. On a phone (≤ 640px) it is a bottom sheet with the same
   presets.

   Helpers for the places that use it: todayIst(), istDay(iso),
   fmt(ymd), label(sel), inRange(iso, from, to), range(presetKey).
   ===================================================================== */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.TLDateRange) return;

  var IST_MS = 330 * 60000;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var PRESETS = [
    ['today', 'Today'], ['yesterday', 'Yesterday'], ['last7', 'Last 7 days'], ['last30', 'Last 30 days'],
    ['thisMonth', 'This month'], ['lastMonth', 'Last month'], ['custom', 'Custom range'],
  ];

  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var isYmd = function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); };
  /* Dates are handled as 'YYYY-MM-DD' strings and UTC arithmetic, so the
     browser's own time zone never shifts a day. */
  function toUtc(ymd) { var p = ymd.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function ymdOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function addDays(ymd, n) { return ymdOf(toUtc(ymd) + n * 86400000); }

  /** The India day of a moment (ISO string, ms or Date), 'YYYY-MM-DD'. */
  function istDay(v) {
    if (v == null || v === '') return '';
    if (isYmd(v)) return String(v);
    var t = v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : Date.parse(v));
    return Number.isFinite(t) ? ymdOf(t + IST_MS) : '';
  }
  function todayIst() { return istDay(Date.now()); }
  /** "09 Oct 2026". */
  function fmt(ymd) {
    if (!isYmd(ymd)) return '';
    var p = ymd.split('-');
    return p[2] + ' ' + MONTHS[+p[1] - 1] + ' ' + p[0];
  }
  function label(sel) {
    if (!sel || !isYmd(sel.from)) return '';
    var to = isYmd(sel.to) ? sel.to : sel.from;
    return to === sel.from ? fmt(sel.from) : fmt(sel.from) + ' - ' + fmt(to);
  }
  function inRange(at, from, to) {
    if (!from && !to) return true;
    var d = istDay(at);
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  }
  function range(key) {
    var t = todayIst();
    var y = +t.slice(0, 4), m = +t.slice(5, 7);
    switch (key) {
      case 'today': return { from: t, to: t };
      case 'yesterday': return { from: addDays(t, -1), to: addDays(t, -1) };
      case 'last7': return { from: addDays(t, -6), to: t };
      case 'last30': return { from: addDays(t, -29), to: t };
      case 'thisMonth': return { from: t.slice(0, 8) + '01', to: t };
      case 'lastMonth': {
        var py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
        var first = py + '-' + String(pm).padStart(2, '0') + '-01';
        return { from: first, to: addDays(t.slice(0, 8) + '01', -1) };
      }
      default: return { from: '', to: '' };
    }
  }
  function presetLabel(key) { var p = PRESETS.filter(function (x) { return x[0] === key; })[0]; return p ? p[1] : ''; }

  /* ------------------------------------------------------------------ *
   * styles
   * ------------------------------------------------------------------ */
  function css() {
    if (document.getElementById('tldrCss')) return;
    var s = document.createElement('style');
    s.id = 'tldrCss';
    s.textContent = ''
      + '.tldr-field{position:relative;display:inline-flex;align-items:center;min-width:0;max-width:100%}'
      + '.tldr-btn{display:inline-flex;align-items:center;gap:7px;min-height:36px;width:100%;padding:0 30px 0 10px;border:1px solid var(--line,#d9e2ec);border-radius:8px;background:var(--card,#fff);color:var(--text,#16202c);font:inherit;font-size:13px;cursor:pointer;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '.tldr-btn.on{border-color:var(--brand-500,#1f7a6d);background:var(--brand-100,#e6f4f1);font-weight:700}'
      + '.tldr-btn .ic{flex:0 0 auto}.tldr-btn .tx{overflow:hidden;text-overflow:ellipsis}'
      + '.tldr-btn .ph{color:var(--text-soft,#5b6e84);font-weight:400}'
      + '.tldr-x{position:absolute;right:4px;top:50%;transform:translateY(-50%);width:24px;height:24px;border:0;border-radius:50%;background:transparent;color:var(--text-soft,#5b6e84);cursor:pointer;font-size:13px;line-height:24px}'
      + '.tldr-x:hover{background:var(--line,#e3eaf2)}'
      + '.tldr-ov{position:fixed;inset:0;z-index:10060;background:transparent}'
      + '.tldr-pop{position:fixed;z-index:10061;display:flex;background:var(--card,#fff);color:var(--text,#16202c);border:1px solid var(--line,#d9e2ec);border-radius:12px;box-shadow:0 18px 48px rgba(8,20,30,.22);overflow:hidden;font-size:13px}'
      + '.tldr-pre{display:flex;flex-direction:column;gap:2px;padding:10px;border-right:1px solid var(--line,#e3eaf2);background:var(--bg-alt,#f6f9fb);min-width:132px}'
      + '.tldr-pre button{border:0;background:transparent;text-align:left;padding:8px 10px;border-radius:7px;font:inherit;cursor:pointer;color:inherit;white-space:nowrap}'
      + '.tldr-pre button:hover{background:var(--line,#e3eaf2)}'
      + '.tldr-pre button.on{background:var(--brand-600,#17695e);color:#fff;font-weight:700}'
      + '.tldr-cal{padding:12px 14px;width:272px}'
      + '.tldr-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}'
      + '.tldr-head b{font-size:14px}'
      + '.tldr-head button{width:32px;height:32px;border:1px solid var(--line,#e3eaf2);border-radius:8px;background:transparent;cursor:pointer;font-size:16px;color:inherit}'
      + '.tldr-head button:disabled{opacity:.35;cursor:default}'
      + '.tldr-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}'
      + '.tldr-grid .wd{font-size:11px;color:var(--text-soft,#5b6e84);text-align:center;padding:4px 0;font-weight:700}'
      + '.tldr-grid button{height:34px;border:0;border-radius:7px;background:transparent;font:inherit;cursor:pointer;color:inherit}'
      + '.tldr-grid button:hover:not(:disabled){background:var(--line,#e3eaf2)}'
      + '.tldr-grid button.in{background:var(--brand-100,#e1f2ee);border-radius:0}'
      + '.tldr-grid button.end{background:var(--brand-600,#17695e);color:#fff;font-weight:800;border-radius:7px}'
      + '.tldr-grid button.today{box-shadow:inset 0 0 0 1px var(--brand-500,#1f7a6d)}'
      + '.tldr-grid button:disabled{color:var(--line,#c5d0db);cursor:not-allowed}'
      + '.tldr-sel{margin:10px 0 0;min-height:18px;font-weight:700;font-size:12.5px}'
      + '.tldr-sel small{display:block;font-weight:400;color:var(--text-soft,#5b6e84)}'
      + '.tldr-act{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}'
      + '.tldr-act button{min-height:36px;padding:0 16px;border-radius:8px;font:inherit;font-weight:700;cursor:pointer;border:1px solid var(--line,#d9e2ec);background:transparent;color:inherit}'
      + '.tldr-act .ok{background:var(--brand-600,#17695e);border-color:var(--brand-600,#17695e);color:#fff}'
      /* a bottom sheet on a phone: same presets, as a row of chips */
      + '@media (max-width:640px){'
      + '.tldr-ov{background:rgba(8,20,30,.45)}'
      + '.tldr-pop{left:0!important;right:0!important;top:auto!important;bottom:0!important;flex-direction:column;border-radius:16px 16px 0 0;max-height:92vh;overflow:auto;padding-bottom:env(safe-area-inset-bottom,0px)}'
      + '.tldr-pop:before{content:"";display:block;width:40px;height:4px;border-radius:2px;background:var(--line,#d0d9e2);margin:8px auto 0}'
      + '.tldr-pre{flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid var(--line,#e3eaf2);min-width:0;gap:6px}'
      + '.tldr-pre button{border:1px solid var(--line,#d9e2ec);border-radius:999px;padding:7px 12px;background:var(--card,#fff)}'
      + '.tldr-cal{width:auto}.tldr-grid button{height:40px}'
      + '.tldr-act button{flex:1;min-height:44px}}';
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------------------ *
   * the field
   * ------------------------------------------------------------------ */
  var REG = Object.create(null);         // id -> latest options
  function field(id, opts) {
    css();
    opts = opts || {};
    REG[id] = opts;
    var sel = { from: opts.from || '', to: opts.to || '' };
    var text = label(sel);
    var name = opts.title || 'Applied Date';
    return '<span class="tldr-field" data-tldr="' + h(id) + '">'
      + '<button type="button" class="tldr-btn' + (text ? ' on' : '') + '" id="tldr_' + h(id) + '" aria-haspopup="dialog" '
      + 'aria-label="' + h(name) + (text ? ': ' + h(text) : '') + '" title="' + h(name) + '" '
      + 'onclick="TLDateRange.open(\'' + h(id) + '\', this)">'
      + '<span class="ic" aria-hidden="true">📅</span><span class="tx">' + (text ? h(text) : '<span class="ph">' + h(opts.placeholder || 'Any date') + '</span>') + '</span></button>'
      + (text ? '<button type="button" class="tldr-x" aria-label="Clear ' + h(name) + '" title="Clear" onclick="TLDateRange.clear(\'' + h(id) + '\')">✕</button>' : '')
      + '</span>';
  }

  function emit(id, sel) {
    var o = REG[id];
    if (o && typeof o.onChange === 'function') {
      try { o.onChange({ from: sel.from || '', to: sel.to || '', preset: sel.preset || '' }); } catch (e) { /* the caller's own problem */ }
    }
  }
  function clear(id) { close(); emit(id, { from: '', to: '', preset: '' }); }

  /* ------------------------------------------------------------------ *
   * the popup
   * ------------------------------------------------------------------ */
  var P = null;        // { id, from, to, preset, y, m, hover, anchor }
  function close() {
    var ov = document.getElementById('tldrOv'); if (ov) ov.remove();
    var pop = document.getElementById('tldrPop'); if (pop) pop.remove();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    var back = P && P.anchor && document.contains(P.anchor) ? P.anchor : null;
    P = null;
    if (back) try { back.focus(); } catch (e) { /* gone */ }
  }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }

  function open(id, anchor) {
    css();
    close();
    var o = REG[id] || {};
    var from = isYmd(o.from) ? o.from : '', to = isYmd(o.to) ? o.to : '';
    var view = to || from || todayIst();
    P = { id: id, from: from, to: to, preset: o.preset || (from ? 'custom' : ''), y: +view.slice(0, 4), m: +view.slice(5, 7), hover: '', anchor: anchor || null };
    var ov = document.createElement('div');
    ov.className = 'tldr-ov'; ov.id = 'tldrOv';
    ov.addEventListener('click', close);
    var pop = document.createElement('div');
    pop.className = 'tldr-pop'; pop.id = 'tldrPop';
    pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-modal', 'true');
    pop.setAttribute('aria-label', o.title || 'Applied Date');
    pop.addEventListener('click', onClick);
    pop.addEventListener('mouseover', onHover);
    document.body.appendChild(ov);
    document.body.appendChild(pop);
    draw();
    place();
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    var first = pop.querySelector('.tldr-pre button.on') || pop.querySelector('.tldr-pre button');
    if (first) try { first.focus(); } catch (e) { /* fine */ }
  }

  function place() {
    var pop = document.getElementById('tldrPop');
    if (!pop || !P) return;
    if (window.innerWidth <= 640) { pop.style.left = pop.style.top = ''; return; }
    var r = P.anchor && document.contains(P.anchor) ? P.anchor.getBoundingClientRect() : { left: 20, bottom: 80, top: 80 };
    var w = pop.offsetWidth, hgt = pop.offsetHeight;
    var left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    var top = r.bottom + 6;
    if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 6);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  }

  function draw() {
    var pop = document.getElementById('tldrPop');
    if (!pop || !P) return;
    var t = todayIst();
    var first = P.y + '-' + String(P.m).padStart(2, '0') + '-01';
    var startDow = new Date(toUtc(first)).getUTCDay();
    var days = new Date(Date.UTC(P.y, P.m, 0)).getUTCDate();
    var end = P.to || (P.from && P.hover && P.hover >= P.from ? P.hover : '');
    var cells = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(function (d) { return '<span class="wd">' + d + '</span>'; }).join('');
    for (var i = 0; i < startDow; i++) cells += '<span></span>';
    for (var d = 1; d <= days; d++) {
      var ymd = first.slice(0, 8) + String(d).padStart(2, '0');
      var cls = [];
      if (ymd === P.from || ymd === end) cls.push('end');
      else if (P.from && end && ymd > P.from && ymd < end) cls.push('in');
      if (ymd === t) cls.push('today');
      var future = ymd > t;
      cells += '<button type="button" data-day="' + ymd + '" class="' + cls.join(' ') + '"' + (future ? ' disabled aria-disabled="true"' : '')
        + ' aria-label="' + fmt(ymd) + (future ? ' (future dates cannot be chosen)' : '') + '"'
        + (ymd === P.from || ymd === end ? ' aria-pressed="true"' : '') + '>' + d + '</button>';
    }
    var atLatest = P.y > +t.slice(0, 4) || (P.y === +t.slice(0, 4) && P.m >= +t.slice(5, 7));
    var sel = P.from ? label({ from: P.from, to: P.to || P.from }) : '';
    var hint = !P.from ? 'Pick a start date' : (!P.to ? 'Pick an end date, or Apply for this one day' : '');
    pop.innerHTML = '<div class="tldr-pre" role="group" aria-label="Quick ranges">'
      + PRESETS.map(function (p) {
        return '<button type="button" data-preset="' + p[0] + '" class="' + (P.preset === p[0] ? 'on' : '') + '">' + p[1] + '</button>';
      }).join('') + '</div>'
      + '<div class="tldr-cal"><div class="tldr-head">'
      + '<button type="button" data-nav="-1" aria-label="Previous month">‹</button><b>' + LONG[P.m - 1] + ' ' + P.y + '</b>'
      + '<button type="button" data-nav="1" aria-label="Next month"' + (atLatest ? ' disabled' : '') + '>›</button></div>'
      + '<div class="tldr-grid">' + cells + '</div>'
      + '<div class="tldr-sel" id="tldrSel" aria-live="polite">' + h(sel || '') + (hint ? '<small>' + h(hint) + '</small>' : '') + '</div>'
      + '<div class="tldr-act"><button type="button" data-act="clear">Clear</button>'
      + '<button type="button" class="ok" data-act="apply"' + (P.from ? '' : ' disabled') + '>Apply</button></div></div>';
  }

  function onHover(e) {
    if (!P || !P.from || P.to) return;
    var b = e.target.closest && e.target.closest('button[data-day]');
    var v = b && !b.disabled ? b.getAttribute('data-day') : '';
    if (v !== P.hover) { P.hover = v; draw(); }
  }

  function onClick(e) {
    e.stopPropagation();
    if (!P) return;
    var b = e.target.closest && e.target.closest('button');
    if (!b || b.disabled) return;
    var pre = b.getAttribute('data-preset');
    if (pre) {
      P.preset = pre;
      if (pre === 'custom') { P.from = ''; P.to = ''; }
      else {
        var r = range(pre); P.from = r.from; P.to = r.to;
        P.y = +r.to.slice(0, 4); P.m = +r.to.slice(5, 7);
      }
      P.hover = ''; draw(); return;
    }
    var nav = b.getAttribute('data-nav');
    if (nav) {
      P.m += +nav;
      if (P.m < 1) { P.m = 12; P.y--; } else if (P.m > 12) { P.m = 1; P.y++; }
      draw(); return;
    }
    var day = b.getAttribute('data-day');
    if (day) {
      P.preset = 'custom';
      if (!P.from || P.to) { P.from = day; P.to = ''; }
      else if (day < P.from) { P.to = P.from; P.from = day; }
      else P.to = day;
      P.hover = ''; draw();
      var again = document.querySelector('#tldrPop button[data-day="' + day + '"]');
      if (again) try { again.focus(); } catch (x) { /* fine */ }
      return;
    }
    var act = b.getAttribute('data-act');
    if (act === 'clear') { var id = P.id; close(); emit(id, { from: '', to: '', preset: '' }); return; }
    if (act === 'apply' && P.from) {
      var out = { from: P.from, to: P.to || P.from, preset: P.preset === 'custom' || !P.preset ? 'custom' : P.preset };
      var id2 = P.id; close(); emit(id2, out);
    }
  }

  window.TLDateRange = {
    version: '0130', field: field, open: open, close: close, clear: clear,
    todayIst: todayIst, istDay: istDay, fmt: fmt, label: label, inRange: inRange, range: range,
    presets: PRESETS.slice(), presetLabel: presetLabel,
  };
})();
