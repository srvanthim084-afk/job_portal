/* =====================================================================
   TeamLink — wide tables: one scroll container, aligned columns, the
   candidate always in view
   =====================================================================

   Applies to the wrappers the prototype already uses - `.tbl-wrap`
   around `table.data` (Applications and the other recruiter / candidate
   tables) and Talent Pool's `.tp-tbl` - and only when the table is wider
   than the space it is given. Nothing in the table's markup changes; no
   column is added, removed or reordered.

   THE MODEL

   - THE TABLE SCROLLS INSIDE ITS OWN CONTAINER. The wrapper (Talent
     Pool: its `.tp-scroll`) is `overflow-x:auto` at 100% of its parent,
     so the table can be as wide as its columns need and only that area
     scrolls sideways - the page never does.

   - THE TABLE IS NEVER SQUASHED. `width:100%; min-width:max-content`:
     it fills the space when everything fits and grows past it when it
     does not, instead of crushing columns until the text is unreadable.

   - COLUMNS HAVE SENSIBLE MINIMUMS, set on the header cell so the body
     cells of the same column follow - one column structure, measured
     once, no margins or absolute positioning. Checkbox 48px, Candidate
     and Applied for 260px, dates 150px, Source 120px, and so on.

   - THE SELECTION AND THE CANDIDATE STAY IN VIEW. The checkbox column
     and the candidate column are pinned (position:sticky; left) so a
     recruiter scrolled to the far columns still knows whose row it is.
     This used to pin "the first column" at 190px - which, once Export
     put a checkbox column first, meant a 190px-wide checkbox and a name
     that scrolled away.

   - THE BAR AT THE FOOT OF THE WINDOW stays, for long lists whose own
     scrollbar is a screenful below - but only while that native
     scrollbar is out of sight, so the two are never on screen together.

   WHAT WAS REMOVED, and why: the table used to be clipped and slid with
   a CSS transform, driven only by proxy bars. It kept a header row
   sticky under the navbar, at the price of a table whose right-hand
   columns looked cut off and could not be reached by the ordinary means.
   A header row that sticks inside a horizontally scrolling container
   would need that container to scroll vertically too - a second
   vertical scrollbar inside the page - so the header row scrolls with
   the page, and the columns are reachable directly instead.
   ===================================================================== */
(function () {
  'use strict';

  /* Below this width the prototype turns every table into one card per
     row - thead hidden, cells stacked - so there is nothing to scroll. */
  var CARD_WIDTH = 700;
  var STYLE_ID = 'tltsStyle';

  /* Minimum width per column, by its heading. */
  var MIN_BY_HEADING = [
    [/^candidate/i, 260],
    [/^applied\s*for|^job|^role|^position/i, 260],
    [/applied\s*(on|date)|^date|^added|^last\s*contacted|^created/i, 150],
    [/^source/i, 120],
    [/ai\s*match|^match|^score/i, 110],
    [/^stage|^status/i, 140],
    [/^recruiter|^department|^location|^company/i, 150],
    [/^email/i, 220],
    [/^phone|^mobile/i, 140],
    [/^skills/i, 200],
    [/^experience|^notice/i, 120],
  ];

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = [
      /* the one scroll container */
      '.tbl-wrap.tlts-w, .tp-tbl.tlts-w > .tp-scroll{',
      '  overflow-x:auto; overflow-y:hidden; width:100%; max-width:100%;',
      '  -webkit-overflow-scrolling:touch}',
      /* the table: fills the space, never squashed below its content */
      '.tlts-w table.tlts{width:100%; min-width:max-content}',
      /* the checkbox column stays compact */
      '.tlts-w table.tlts .tlx-tick{width:48px; min-width:48px; max-width:48px;',
      '  padding-left:8px; padding-right:8px; text-align:center}',
      /* a cell's own content keeps to one line per line, so it widens its
         column rather than spilling into the next one */
      '.tlts-w table.tlts > tbody > tr > td{white-space:nowrap}',
      '.tlts-w table.tlts > tbody > tr > td > *{max-width:none}',
      /* the job and its company badge sit together */
      '.tlts-w table.tlts .tlts-flex{display:flex; align-items:center; gap:6px; flex-wrap:nowrap}',
      /* pinned columns */
      '.tlts-w table.tlts .tlts-pin{position:sticky; z-index:5; background:var(--card,#fff)}',
      '.tlts-w table.tlts > thead > tr > th.tlts-pin{z-index:15; background:var(--bg-alt,#f7fafd)}',
      '.tlts-w table.tlts > tbody > tr.clickable:hover > td.tlts-pin{background:var(--brand-100,#eef4ff)}',
      '.tlts-w.tlts-x table.tlts .tlts-pin-last{box-shadow:8px 0 10px -8px rgba(16,32,58,.28)}',
      /* the header row: sticky within its container, opaque */
      '.tlts-w table.tlts > thead > tr > th{position:sticky; top:0; z-index:10;',
      '  background:var(--bg-alt,#f7fafd); box-shadow:inset 0 -1px 0 var(--line,#e6ebf2)}',
      '.tlts-w table.tlts > thead > tr > th.tlts-pin{z-index:15}',

      /* the bar at the foot of the window */
      '.tlts-bar{position:sticky; bottom:0; z-index:30; height:14px; margin:6px 0 2px;',
      '  overflow-x:auto; overflow-y:hidden; display:none;',
      '  background:var(--bg-alt,#f4f7fb); border:1px solid var(--line,#e6ebf2); border-radius:7px;',
      '  scrollbar-width:thin; scrollbar-color:#9fb0c4 transparent}',
      '.tlts-bar.on{display:block}',
      /* A panel that clips for its rounded corners (overflow:hidden) is a
         scroll container, and a sticky bar inside one sticks to the panel
         rather than to the window. `clip` cuts the corners the same way
         and is not a scroll container. */
      '.tlts-clipper{overflow:clip}',
      '.tlts-bar > div{height:1px}',
      '.tlts-bar::-webkit-scrollbar{height:12px}',
      '.tlts-bar::-webkit-scrollbar-thumb{background:#9fb0c4; border-radius:7px;',
      '  border:3px solid transparent; background-clip:content-box}',
      '.tlts-bar::-webkit-scrollbar-track{background:transparent}',

      '@media print{ .tlts-bar{display:none!important}',
      '  .tlts-w table.tlts .tlts-pin, .tlts-w table.tlts > thead > tr > th{position:static} }',
    ].join('\n');
    document.head.appendChild(el);
  }

  /* ------------------------------------------------------------------ */

  function scrollerOf(wrap) {
    return wrap.querySelector(':scope > .tp-scroll') || wrap;
  }

  var state = new WeakMap();     // wrap -> { bar, ro, listening }
  function stateFor(wrap) {
    var st = state.get(wrap);
    if (!st) { st = {}; state.set(wrap, st); }
    return st;
  }

  /* where each table was scrolled to, across a repaint */
  var positions = Object.create(null);
  function keyFor(table) {
    var head = table.querySelector('thead tr');
    if (!head) return '';
    return [].slice.call(head.children).map(function (c) {
      return (c.textContent || '').trim().slice(0, 12);
    }).join('|');
  }

  function wideTables() {
    var out = [];
    var list = document.querySelectorAll('.tbl-wrap, .tp-tbl');
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (w.hasAttribute('data-tl-no-sticky')) continue;
      if (!w.querySelector('table')) continue;
      out.push(w);
    }
    return out;
  }

  /** Column minimums, set on the header cells. */
  function sizeColumns(table) {
    var head = table.querySelector('thead tr');
    if (!head) return;
    [].forEach.call(head.children, function (th) {
      if (th.classList.contains('tlx-tick') || th.__tltsSized) return;
      var label = (th.textContent || '').trim();
      for (var i = 0; i < MIN_BY_HEADING.length; i++) {
        if (MIN_BY_HEADING[i][0].test(label)) { th.style.minWidth = MIN_BY_HEADING[i][1] + 'px'; break; }
      }
      th.__tltsSized = true;
    });
    /* A cell holding a job title and its company badge keeps them on one
       line together. */
    [].forEach.call(table.querySelectorAll('tbody > tr > td'), function (td) {
      if (td.__tltsFlex) return;
      td.__tltsFlex = true;
      if (td.children.length >= 2 && td.querySelector('.badge, [class*="badge"], .pill, [class*="chip"]')
          && !td.querySelector('button, select, input')) {
        var kids = [].filter.call(td.children, function (k) { return getComputedStyle(k).display !== 'block'; });
        if (kids.length === td.children.length) td.classList.add('tlts-flex');
      }
    });
  }

  /** Pin the checkbox column and the candidate column. */
  function pinColumns(table) {
    var head = table.querySelector('thead tr');
    if (!head || !head.children.length) return;
    var first = head.children[0];
    var tick = first.classList.contains('tlx-tick') || !!first.querySelector('input[type=checkbox]');
    var count = tick && head.children.length > 2 ? 2 : 1;
    var offsets = [];
    var left = 0;
    for (var i = 0; i < count; i++) {
      offsets.push(left);
      left += head.children[i].getBoundingClientRect().width;
    }
    [].forEach.call(table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr'), function (tr) {
      for (var i = 0; i < count; i++) {
        var cell = tr.children[i];
        if (!cell || (cell.colSpan || 1) > 1) return;     // a full-width message row
        cell.classList.add('tlts-pin');
        cell.classList.toggle('tlts-pin-last', i === count - 1);
        cell.style.left = Math.round(offsets[i]) + 'px';
      }
    });
  }

  function unpin(table) {
    [].forEach.call(table.querySelectorAll('.tlts-pin'), function (c) {
      c.classList.remove('tlts-pin', 'tlts-pin-last');
      c.style.left = '';
    });
  }

  /* Ancestors that clip with overflow:hidden switch to overflow:clip. */
  function unclipAncestors(wrap) {
    var n = wrap.parentElement;
    for (var i = 0; n && n !== document.body && i < 8; i += 1) {
      var cs = getComputedStyle(n);
      if ((cs.overflowX === 'hidden' || cs.overflowY === 'hidden') && !n.classList.contains('tlts-clipper')) {
        n.classList.add('tlts-clipper');
      }
      n = n.parentElement;
    }
  }

  /* ---- the bar at the foot of the window ---- */

  function barFor(wrap) {
    var st = stateFor(wrap);
    if (st.bar && st.bar.isConnected) return st.bar;
    var bar = document.createElement('div');
    bar.className = 'tlts-bar tlts-bottom';
    bar.setAttribute('aria-hidden', 'true');
    bar.appendChild(document.createElement('div'));
    wrap.parentNode.insertBefore(bar, wrap.nextSibling);
    var scroller = scrollerOf(wrap);
    var lock = false;
    bar.addEventListener('scroll', function () {
      if (lock) return;
      lock = true;
      scroller.scrollLeft = bar.scrollLeft;
      setTimeout(function () { lock = false; }, 50);
    }, { passive: true });
    st.bar = bar;
    st.barLock = function (v) { lock = v; };
    return bar;
  }

  function listen(wrap) {
    var st = stateFor(wrap);
    var scroller = scrollerOf(wrap);
    if (st.listening === scroller) return;
    st.listening = scroller;
    scroller.addEventListener('scroll', function () {
      wrap.classList.toggle('tlts-x', scroller.scrollLeft > 0);
      var table = scroller.querySelector('table');
      if (table) { var k = keyFor(table); if (k) positions[k] = scroller.scrollLeft; }
      if (st.bar && st.bar.scrollLeft !== scroller.scrollLeft) {
        if (st.barLock) st.barLock(true);
        st.bar.scrollLeft = scroller.scrollLeft;
        setTimeout(function () { if (st.barLock) st.barLock(false); }, 50);
      }
    }, { passive: true });
  }

  /** The window bar shows only while the table's own scrollbar is out of sight. */
  function showBar(wrap, overflowing) {
    var st = stateFor(wrap);
    var scroller = scrollerOf(wrap);
    if (!overflowing) { if (st.bar) st.bar.classList.remove('on'); return; }
    var r = scroller.getBoundingClientRect();
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var nativeOffscreen = r.bottom > vh - 4 && r.top < vh - 60;
    unclipAncestors(wrap);
    var bar = barFor(wrap);
    bar.firstChild.style.width = scroller.scrollWidth + 'px';
    bar.style.width = scroller.clientWidth + 'px';
    bar.classList.toggle('on', nativeOffscreen);
    if (nativeOffscreen) bar.scrollLeft = scroller.scrollLeft;
  }

  /* ------------------------------------------------------------------ */

  function place() {
    var narrow = window.innerWidth <= CARD_WIDTH;
    var wraps = wideTables();
    for (var i = 0; i < wraps.length; i++) {
      var wrap = wraps[i];
      var table = wrap.querySelector('table');
      if (!table) continue;
      var scroller = scrollerOf(wrap);

      if (narrow) {
        table.classList.remove('tlts');
        wrap.classList.remove('tlts-w', 'tlts-x');
        unpin(table);
        showBar(wrap, false);
        continue;
      }

      /* Measured WITH the minimums on, so the decision is about the table
         as it will be drawn. */
      table.classList.add('tlts');
      wrap.classList.add('tlts-w');
      sizeColumns(table);

      var overflowing = scroller.scrollWidth > scroller.clientWidth + 1;
      if (overflowing) pinColumns(table); else unpin(table);
      listen(wrap);

      var k = keyFor(table);
      if (k && positions[k] > 0 && scroller.scrollLeft === 0) scroller.scrollLeft = positions[k];
      wrap.classList.toggle('tlts-x', scroller.scrollLeft > 0);
      showBar(wrap, overflowing);
    }
    /* bars whose table has gone */
    [].forEach.call(document.querySelectorAll('.tlts-bar'), function (bar) {
      var prev = bar.previousElementSibling;
      if (!prev || !prev.classList || !prev.classList.contains('tlts-w')) bar.remove();
    });
  }

  /*
   * One placement however many events arrive - and it must actually run:
   * a frame is never served to a tab that is not painting, so a timer runs
   * alongside requestAnimationFrame and whichever arrives first does it.
   */
  var queued = false;
  var warned = false;
  function run() {
    if (!queued) return;
    queued = false;
    try { place(); } catch (e) {
      if (!warned) { warned = true; console.warn('TeamLink table scroll:', e); }
    }
  }
  function refresh() {
    if (queued) return;
    queued = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    setTimeout(run, 120);
  }

  injectCss();
  window.addEventListener('scroll', refresh, { passive: true });
  window.addEventListener('resize', refresh);

  /* The prototype repaints #app on every navigation; watching it catches
     every repaint without knowing which render function did it. */
  function watch() {
    var app = document.getElementById('app');
    if (!app) { setTimeout(watch, 300); return; }
    new MutationObserver(refresh).observe(app, { childList: true, subtree: true });
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
  else watch();

  window.TLTableScroll = { refresh: refresh };
}());
