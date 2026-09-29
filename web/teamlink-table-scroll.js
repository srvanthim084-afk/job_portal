/* =====================================================================
   TeamLink — wide tables: a fixed first column and a scrollbar you can
   reach without scrolling to the end of the list
   =====================================================================

   THE TWO PROBLEMS THIS SOLVES

   1. Scrolling a candidate table sideways took the candidate's name with
      it. Four columns in, every row is a set of values belonging to
      nobody, and the recruiter has to scroll back to find out who they
      are reading about.

   2. The horizontal scrollbar sits at the BOTTOM of the table. On a list
      of a hundred and twenty candidates that is two thousand pixels below
      the fold, so reaching the other columns meant scrolling to the end
      of the list first, dragging, then scrolling back up.

   HOW IT WORKS. Nothing in the markup changes. The enhancer finds the
   wrappers the prototype already uses - `.tbl-wrap` around `table.data` -
   and, only where the table is actually wider than its wrapper:

     - pins the first cell of every row with position:sticky, with a
       shadow that appears only once the table has been scrolled
     - inserts a slim horizontal scrollbar ABOVE the table which sticks
       below the page header while the page is scrolled, and keeps it and
       the table in step in both directions
     - hides the table's own scrollbar, so there is one control and not
       two that disagree

   IT IS AT THE FOOT OF THE WINDOW. This was above the table, on the
   reasoning that a bar beside the column headings is where somebody
   looking for a column is already looking - and on a table of sixty rows
   that turned out to be true only for the first screenful. Below that,
   the bar was off the top of the window and the last columns were
   unreachable without scrolling back up, which is the complaint the
   bottom placement was meant to fix in the first place. It is sticky to
   the bottom of the viewport now, in reach from any row, on every
   screen.

   It is a component rather than a change to each table because there are
   eight candidate and ATS tables in this file and they will not stay at
   eight. A table opts out with data-tl-no-sticky.

   WHAT IT DELIBERATELY DOES NOT DO

   It does not make the header ROW stick to the top of the page, and
   this has now been tried twice and measured both times.

   `.tbl-wrap` has overflow-x:auto, and CSS makes an element with one
   axis set to `auto` a scroll container in BOTH - so `position:sticky`
   on a `th` anchors to the wrapper's own scrollport rather than to the
   page, and the wrapper has no height limit, so it never scrolls
   vertically and the header never sticks.

   `overflow-y:clip` LOOKS like the answer - it clips without
   establishing a scrollport - and it is not, because of a rule in the
   spec: when one axis is `auto` and the other is `clip`, the `clip`
   COMPUTES TO `hidden`, which is a scrollport again. Measured in
   Chrome: the property is supported, the computed value came back
   `hidden`, and the header scrolled away at -337px and -1937px.

   The two remaining ways both cost more than they give:
     - a height on the wrapper, which puts the second vertical
       scrollbar back inside the page (and is the thing this file was
       last asked to remove);
     - letting the PAGE scroll sideways instead of the wrapper, which
       drags the filters and the page header off-screen with it.

   So the header does not stick, on purpose, and the horizontal bar at
   the foot of the window is what makes the far columns reachable.
   ===================================================================== */
(function () {
  'use strict';

  /* Below this width the prototype already turns every table into one
     card per row - thead hidden, cells stacked - so there is no column to
     pin and no sideways scrolling to rescue. */
  var CARD_WIDTH = 700;

  /* A name, an avatar, a location and a source id need room. Narrower
     than this and the thing being kept visible is not worth keeping. */
  var MIN_FIRST = 190;

  /* Fallback when nothing sticky is found above the table. */
  var DEFAULT_TOP = 0;

  var STYLE_ID = 'tltsStyle';

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = [
      /* The pinned column. Background is explicit because the cell has to
         hide the columns sliding underneath it. */
      '@media (min-width:701px){',
      '  .tbl-wrap table.data.tlts > thead > tr > th:first-child,',
      '  .tbl-wrap table.data.tlts > tbody > tr > td:first-child{',
      '    position:sticky; left:0; z-index:2;',
      '    background:var(--card,#fff);',
      '    min-width:' + MIN_FIRST + 'px;',
      '  }',
      '  .tbl-wrap table.data.tlts > thead > tr > th:first-child{',
      '    z-index:3; background:var(--bg-alt,#f7fafd);',
      '  }',
      /* A row that highlights on hover must highlight under the pinned
         cell too, or the name sits in a pale box while its row is blue. */
      '  .tbl-wrap table.data.tlts > tbody > tr.clickable:hover > td:first-child{',
      '    background:var(--brand-100,#eef4ff);',
      '  }',
      /* The separation only appears once there is something behind it. */
      '  .tbl-wrap table.data.tlts.tlts-x > thead > tr > th:first-child,',
      '  .tbl-wrap table.data.tlts.tlts-x > tbody > tr > td:first-child{',
      '    box-shadow:8px 0 10px -8px rgba(16,32,58,.28);',
      '  }',
      '}',

      /* ONE SCROLLBAR, NOT TWO. The table's own is hidden while ours is
         showing; two that can disagree is worse than the problem. */
      '.tbl-wrap.tlts-w{scrollbar-width:none; -ms-overflow-style:none}',
      '.tbl-wrap.tlts-w::-webkit-scrollbar{height:0; width:0}',

      /* The strip above the table. Sticky rather than fixed so it moves
         with the page's own horizontal scroll and needs no measuring of
         left edges. `top` is set per table from whatever is pinned above
         it. */
      '.tlts-bar{position:sticky; z-index:30; height:14px;',
      '  overflow-x:auto; overflow-y:hidden; display:none;',
      '  background:var(--bg-alt,#f4f7fb);',
      '  border:1px solid var(--line,#e6ebf2); border-radius:7px;',
      '  margin:0 0 6px}',
      '.tlts-bar.on{display:block}',

      /*
       * THE CANDIDATE PORTAL PINS IT TO THE BOTTOM INSTEAD.
       *
       * Above the table is right for a recruiter reading columns beside
       * the headings. A candidate reads DOWN their applications, and
       * asked for the bar to stay at the foot of the window wherever
       * they are in the list - so on those screens it sticks to the
       * bottom and sits after the table rather than before it.
       */
      '.tlts-bar.tlts-bottom{top:auto; bottom:0; margin:0 0 2px}',
      /* Columns are never squashed to fit; the bar is there to reach
         them. Only on this surface, so the recruiter tables keep the
         widths they have. */
      /* No column is squashed to fit. The bar exists to reach them, so
         the table is allowed to be as wide as its content needs - this
         is what stops "Notice Period" being clipped rather than
         scrolled to. */
      '.tbl-wrap table.data.tlts, .tp-tbl table.tlts{min-width:max-content}',

      /* The wrapper scrolls SIDEWAYS ONLY. `overflow-y:clip` does not
         make a scroll container the way `auto` or `hidden` do, so no
         second vertical scrollbar appears inside the page and a
         sticky table header can still anchor to the page itself. */
      /* Sideways only, and no height of its own: the PAGE does all the
         vertical scrolling, so there is never a second vertical bar
         inside the page. `overflow-y` is deliberately not set - see
         the note at the top of the file about why `clip` does not
         survive here. */
      '.tbl-wrap.tlts-w, .tp-tbl.tlts-w{overflow-x:auto;',
      '  width:100%; max-width:100%; height:auto; max-height:none}',

      '.tlts-bar > div{height:1px}',

      /* ALWAYS DRAWN. An overlay scrollbar that fades out when idle
         defeats the whole point of putting one where it can be seen. */
      '.tlts-bar{scrollbar-width:thin; scrollbar-color:#9fb0c4 transparent}',
      '.tlts-bar::-webkit-scrollbar{height:12px}',
      '.tlts-bar::-webkit-scrollbar-thumb{background:#9fb0c4;border-radius:7px;',
      '  border:3px solid transparent; background-clip:content-box}',
      '.tlts-bar::-webkit-scrollbar-thumb:hover{background:#7d8ea6;',
      '  border:3px solid transparent; background-clip:content-box}',
      '.tlts-bar::-webkit-scrollbar-track{background:transparent}',

      '@media print{',
      '  .tlts-bar{display:none!important}',
      '  .tbl-wrap table.data.tlts > thead > tr > th:first-child,',
      '  .tbl-wrap table.data.tlts > tbody > tr > td:first-child{position:static}',
      '}',
    ].join('\n');
    document.head.appendChild(el);
  }

  /* wrapper element -> its bar */
  var bars = new WeakMap();

  /*
   * WHERE THE PAGE STOPS AND THE TABLE BEGINS.
   *
   * Measured rather than hard-coded: the recruiter chrome, the candidate
   * portal and the admin screens do not share a header height, and a
   * number written here would be wrong on two of the three the first time
   * anybody changed a padding.
   */
  function stickyTopFor(wrap) {
    var top = DEFAULT_TOP;
    var seen = 0;
    var node = wrap.parentElement;
    /* Anything pinned above this table contributes its height, walking
       out through the ancestors the way the stacking actually works. */
    while (node && node !== document.body && seen < 12) {
      var kids = node.children;
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k === wrap || k.contains(wrap)) break;
        var pos = getComputedStyle(k).position;
        if (pos === 'sticky' || pos === 'fixed') {
          var h = k.getBoundingClientRect().height;
          if (h > 0 && h < 220) top = Math.max(top, h);
        }
      }
      node = node.parentElement;
      seen += 1;
    }
    /* The application's own top bar, which sits outside #app. */
    var chrome = document.querySelector('.topbar');
    if (chrome) {
      var cs = getComputedStyle(chrome);
      if (cs.position === 'fixed' || cs.position === 'sticky') {
        top += chrome.getBoundingClientRect().height;
      }
    }
    return Math.round(top);
  }

  /**
   * Is this the candidate portal?
   *
   * Asked of the route rather than of a class on the page, because the
   * same .tbl-wrap markup is used by every role and only the route says
   * whose screen it is.
   */
  function isBottomSurface() {
    /*
     * EVERY SCREEN, NOW.
     *
     * This was the candidate portal only, on the reasoning that a
     * recruiter reading columns wants the bar beside the headings. The
     * recruiter screens then reported the same complaint the candidate
     * screens had: wide table, last column off the right, and no
     * horizontal scrollbar anywhere until you scroll past the last row.
     *
     * A bar at the foot of the window is in reach from any row, which is
     * the whole point, so both surfaces get it and the top placement is
     * retired. The function stays so there is one place to change if a
     * screen ever wants the other behaviour.
     */
    return true;
  }

  /**
   * How much of the right-hand end the floating chat button covers.
   *
   * Nothing, usually - the button sits 26px up and the bar is 14px tall,
   * so they miss each other. Measured anyway, because both numbers are
   * in stylesheets that will change, and a thumb scrolled fully right
   * and hidden under a button is unreachable.
   */
  function fabClearance(barHeight) {
    var fab = document.querySelector('.fab');
    if (!fab) return 0;
    var cs = getComputedStyle(fab);
    if (cs.position !== 'fixed' || cs.display === 'none') return 0;
    var r = fab.getBoundingClientRect();
    if (r.bottom < window.innerHeight - barHeight) return 0;   // clears it
    return Math.max(0, Math.round(window.innerWidth - r.left + 8));
  }

  function barFor(wrap) {
    var bar = bars.get(wrap);
    if (bar && bar.isConnected && bar.parentNode === wrap.parentNode) return bar;

    bar = document.createElement('div');
    bar.className = 'tlts-bar';
    bar.setAttribute('aria-hidden', 'true');
    bar.appendChild(document.createElement('div'));

    /*
     * WHICHEVER ONE YOU MOVE, THE OTHER FOLLOWS.
     *
     * Setting scrollLeft fires a scroll event of its own, so without a
     * note of who started it the two would push each other back and
     * forth.
     *
     * THE LOCK IS CLEARED BY A TIMER, NOT BY THE ECHO. Clearing it when
     * the echo arrives assumes an echo always does, and it does not:
     * assigning a scrollLeft that is already the current value changes
     * nothing and fires no event, so the lock would stay set and swallow
     * the next real scroll in the other direction. A short timer clears
     * it whether the echo came or not.
     */
    var lock = null;
    var lockTimer = null;
    function hold(who) {
      lock = who;
      clearTimeout(lockTimer);
      lockTimer = setTimeout(function () { lock = null; }, 80);
    }

    bar.addEventListener('scroll', function () {
      if (lock === 'wrap') return;
      hold('bar');
      if (wrap.scrollLeft !== bar.scrollLeft) wrap.scrollLeft = bar.scrollLeft;
      shadow(wrap);
      remember(wrap);
    }, { passive: true });

    /* The table still scrolls by trackpad, shift+wheel and touch even
       with its own scrollbar hidden, so the bar follows those too. */
    wrap.addEventListener('scroll', function () {
      shadow(wrap);
      remember(wrap);
      if (lock === 'bar') return;
      hold('wrap');
      if (bar.scrollLeft !== wrap.scrollLeft) bar.scrollLeft = wrap.scrollLeft;
    }, { passive: true });

    /* Inserted immediately before the table it belongs to: sticky needs
       to be in the flow, and being a sibling means it is thrown away with
       the table when the page repaints. */
    wrap.parentNode.insertBefore(bar, wrap);
    bars.set(wrap, bar);

    /*
     * RECALCULATED WHEN ANYTHING MOVES.
     *
     * Columns appear, filters change the rows, the sidebar opens, the
     * window resizes - each changes the table's scrollWidth, and a strip
     * whose inner width is stale either scrolls too far or stops short.
     */
    if (typeof ResizeObserver === 'function') {
      var ro = new ResizeObserver(refresh);
      ro.observe(wrap);
      var t = wrap.querySelector('table.data');
      if (t) ro.observe(t);
      bar.__tltsRo = ro;
    }
    return bar;
  }

  /*
   * WHERE THE TABLE WAS SCROLLED TO.
   *
   * Filtering, sorting and paging all repaint the table from scratch, so
   * a recruiter who had scrolled out to the Source and Last Active
   * columns was thrown back to the left edge on every keystroke in the
   * search box. Keyed on the table's column signature so the position is
   * restored to the same table and not to a different one that happens to
   * be drawn next.
   */
  var positions = Object.create(null);

  function keyFor(wrap) {
    var t = wrap.querySelector('table.data');
    if (!t) return null;
    var heads = t.querySelectorAll('thead th');
    var parts = [];
    for (var i = 0; i < heads.length && i < 12; i++) {
      parts.push((heads[i].textContent || '').trim().slice(0, 14));
    }
    return parts.join('|');
  }

  function remember(wrap) {
    var k = keyFor(wrap);
    if (k) positions[k] = wrap.scrollLeft;
  }

  function restore(wrap) {
    var k = keyFor(wrap);
    if (!k) return;
    var was = positions[k];
    if (typeof was !== 'number' || was <= 0) return;
    var max = wrap.scrollWidth - wrap.clientWidth;
    var to = Math.min(was, Math.max(0, max));
    if (to > 0 && Math.abs(wrap.scrollLeft - to) > 1) wrap.scrollLeft = to;
  }

  function shadow(wrap) {
    var t = wrap.querySelector('table.data.tlts');
    if (t) t.classList.toggle('tlts-x', wrap.scrollLeft > 0);
  }

  function wideTables() {
    var out = [];
    var list = document.querySelectorAll('.tbl-wrap');
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (w.hasAttribute('data-tl-no-sticky')) continue;
      if (!w.querySelector('table.data')) continue;
      out.push(w);
    }
    return out;
  }

  /* A bar whose table has gone, on a page that kept the bar. */
  function sweep() {
    var all = document.querySelectorAll('.tlts-bar');
    for (var i = 0; i < all.length; i++) {
      var next = all[i].nextElementSibling;
      if (!next || !next.classList || !next.classList.contains('tbl-wrap')) {
        if (all[i].__tltsRo) { try { all[i].__tltsRo.disconnect(); } catch (e) {} }
        all[i].remove();
      }
    }
  }

  function place() {
    sweep();
    var narrow = window.innerWidth <= CARD_WIDTH;
    var wraps = wideTables();

    for (var i = 0; i < wraps.length; i++) {
      var wrap = wraps[i];
      var table = wrap.querySelector('table.data');
      var overflows = wrap.scrollWidth - wrap.clientWidth > 1;

      /* EVERYTHING FITS: no pinned column, no strip, and the table keeps
         its own scrollbar because it is not using one. */
      if (narrow || !overflows) {
        if (table) table.classList.remove('tlts', 'tlts-x');
        wrap.classList.remove('tlts-w');
        var existing = bars.get(wrap);
        if (existing) existing.classList.remove('on');
        continue;
      }

      table.classList.add('tlts');
      wrap.classList.add('tlts-w');
      shadow(wrap);

      var bar = barFor(wrap);
      var bottom = isBottomSurface();

      /* The bar is a sibling of the table either way; which side of it
         decides whether `bottom:0` has anything to stick to. */
      if (bottom) {
        if (bar.nextSibling === wrap) wrap.parentNode.insertBefore(bar, wrap.nextSibling);
        bar.classList.add('tlts-bottom');
        wrap.parentNode.classList.add('tlts-bottom-host');
        bar.style.top = '';
        bar.style.marginRight = fabClearance(bar.getBoundingClientRect().height || 14) + 'px';
      } else {
        if (bar.previousSibling === wrap) wrap.parentNode.insertBefore(bar, wrap);
        bar.classList.remove('tlts-bottom');
        wrap.parentNode.classList.remove('tlts-bottom-host');
        bar.style.marginRight = '';
        bar.style.top = stickyTopFor(wrap) + 'px';
      }

      bar.firstChild.style.width = wrap.scrollWidth + 'px';
      if (bar.scrollLeft !== wrap.scrollLeft) bar.scrollLeft = wrap.scrollLeft;
      bar.classList.add('on');

      restore(wrap);
    }
  }

  /*
   * One placement however many events arrive — and it must actually run.
   *
   * requestAnimationFrame alone looked right and was not: a frame is
   * never served to a tab that is not painting, so in a background tab
   * the callback never fired, `queued` stayed true, and every later
   * refresh returned early. A timer runs alongside it and whichever
   * arrives first does the work.
   */
  var queued = false;
  var warned = false;
  function run() {
    if (!queued) return;
    queued = false;
    try {
      place();
    } catch (e) {
      /* A scrollbar is never worth breaking a page for, but a failure
         that says nothing is how this went unnoticed the first time. */
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

  /*
   * The prototype repaints #app wholly on every navigation, so the
   * wrappers this measured are thrown away and replaced. Watching the
   * container catches every repaint without needing to know which of the
   * many render functions did it.
   */
  function watch() {
    var app = document.getElementById('app');
    if (!app) { setTimeout(watch, 300); return; }
    new MutationObserver(refresh).observe(app, { childList: true, subtree: true });
    refresh();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watch);
  } else {
    watch();
  }

  /* Reusable by hand as well, for a table drawn outside #app. */
  window.TLTableScroll = { refresh: refresh };
}());
