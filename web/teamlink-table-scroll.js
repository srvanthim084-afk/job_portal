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
      '.tlts-bar.tlts-bottom{top:auto; bottom:0; margin:6px 0 2px}',
      /* The top one sits under the navbar, above the header row. */
      '.tlts-bar.tlts-top{z-index:20; background:var(--card,#fff)}',
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
      /*
       * THE WRAPPER NO LONGER SCROLLS. THIS IS THE WHOLE TRICK.
       *
       * `overflow-x:auto` makes an element a scroll container in BOTH
       * axes, and a `position:sticky` header inside one anchors to THAT
       * container rather than to the page - so it never moved. Measured
       * twice: `overflow-y:clip` does not rescue it either, because the
       * spec says a `clip` paired with an `auto` computes to `hidden`,
       * and Chrome returns exactly that.
       *
       * So nothing here scrolls. The wide table is CLIPPED by the host -
       * `overflow-x:clip` with `overflow-y:visible`, which was measured
       * to stay clip/visible and therefore establishes no scrollport -
       * and it is moved sideways by a transform that the two scrollbars
       * drive. The nearest scrollport for a sticky header is then the
       * page, which is what makes it stick under the navbar.
       */
      '.tbl-wrap.tlts-w, .tp-tbl.tlts-w{overflow:visible;',
      '  width:100%; max-width:100%; height:auto; max-height:none}',
      /* Talent Pool puts its own `.tp-scroll{overflow-x:auto}` between
         the wrapper and the table. Left alone it drew a second, native
         scrollbar inside the card and, being a scroll container, kept the
         header row from sticking. While this module drives the table
         that box only has to hold it. */
      '.tp-tbl.tlts-w .tp-scroll{overflow:visible}',
      '.tlts-clip{overflow-x:clip; overflow-y:visible; width:100%; max-width:100%}',
      '.tlts-slide{will-change:transform}',

      /*
       * AND NO ANCESTOR MAY CLIP EITHER. `.panel` carries
       * `overflow:hidden` to keep the table's corners inside its radius,
       * and a sticky element cannot escape an ancestor that clips: the
       * bar and the header were being cut off at the panel's edge. The
       * panel holding a wide table is opened up, and the radius is kept
       * by clipping the host inside it instead.
       */
      '.tlts-openpanel{overflow:visible!important}',
      '.tlts-openpanel > .panel-body{border-radius:inherit}',

      /* The header row, just under the top bar. Its offset is measured
         per table and set as --tlts-head, because the recruiter chrome,
         the candidate portal and the admin screens do not share a
         header height. */
      '.tbl-wrap table.data.tlts > thead > tr > th,',
      '.tp-tbl table.tlts > thead > tr > th{',
      '  position:sticky; top:var(--tlts-head,0px); z-index:15;',
      '  background:var(--bg-alt,#f7fafd);',
      '  box-shadow:inset 0 -1px 0 var(--line,#e6ebf2)}',
      /* The first cell is sticky on both axes, so it sits above the
         rest of the header as well as above the rows. */
      '.tbl-wrap table.data.tlts > thead > tr > th:first-child{z-index:16}',

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
  /*
   * THE SCROLL MODEL
   * ---------------------------------------------------------------
   * Nothing here is a native scroll container. The wide table is
   * clipped by a host (`overflow-x:clip; overflow-y:visible`, which
   * establishes no scrollport) and moved by `transform: translateX`.
   * Two slim proxy scrollbars drive that transform - one sticky under
   * the navbar, one sticky at the foot of the window - and each follows
   * the other.
   *
   * This is what makes the header row stick. A `position:sticky` header
   * inside an `overflow-x:auto` wrapper anchors to the WRAPPER, which
   * never scrolls vertically, so it never moves. With no scrollport
   * between the header and the page, the page is what it sticks to.
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
  function fabClearance(barHeight) {
    var fab = document.querySelector('.fab');
    if (!fab) return 0;
    var cs = getComputedStyle(fab);
    if (cs.position !== 'fixed' || cs.display === 'none') return 0;
    var r = fab.getBoundingClientRect();
    if (r.bottom < window.innerHeight - barHeight) return 0;   // clears it
    return Math.max(0, Math.round(window.innerWidth - r.left + 8));
  }

  var state = new WeakMap();      // wrap -> { pos, max, top, bottom, clip }

  function stateFor(wrap) {
    var st = state.get(wrap);
    if (!st) { st = { pos: 0, max: 0, top: null, bottom: null, clip: null }; state.set(wrap, st); }
    return st;
  }

  /** The host that clips the table, created once around the wrapper. */
  function clipFor(wrap) {
    var st = stateFor(wrap);
    if (st.clip && st.clip.isConnected && st.clip.contains(wrap)) return st.clip;
    if (wrap.parentElement && wrap.parentElement.classList.contains('tlts-clip')) {
      st.clip = wrap.parentElement;
      return st.clip;
    }
    var clip = document.createElement('div');
    clip.className = 'tlts-clip';
    wrap.parentNode.insertBefore(clip, wrap);
    clip.appendChild(wrap);
    st.clip = clip;
    return clip;
  }

  /**
   * Open every ancestor that clips.
   *
   * `.panel` carries `overflow:hidden` for its rounded corners, and a
   * sticky bar or header cannot escape an ancestor that clips - both
   * were being cut off at the panel's edge. Only panels holding a wide
   * table are opened, and only up to the page.
   */
  function openAncestors(wrap) {
    var n = wrap.parentElement;
    for (var i = 0; n && n !== document.body && i < 6; i++) {
      var cs = getComputedStyle(n);
      if ((cs.overflowX !== 'visible' || cs.overflowY !== 'visible')
          && !n.classList.contains('tlts-clip')) {
        n.classList.add('tlts-openpanel');
      }
      n = n.parentElement;
    }
  }

  /** Move the table, and bring both bars with it. */
  function setPos(wrap, pos, from) {
    var st = stateFor(wrap);
    var table = wrap.querySelector('table');
    if (!table) return;
    st.pos = Math.max(0, Math.min(Math.round(pos), st.max));
    table.style.transform = st.pos ? 'translateX(' + (-st.pos) + 'px)' : '';
    table.classList.toggle('tlts-x', st.pos > 0);

    if (st.top && from !== 'top' && st.top.scrollLeft !== st.pos) st.top.scrollLeft = st.pos;
    if (st.bottom && from !== 'bottom' && st.bottom.scrollLeft !== st.pos) st.bottom.scrollLeft = st.pos;
    remember(wrap);
  }

  /** One proxy bar. `where` is 'top' or 'bottom'. */
  function barFor(wrap, where) {
    var st = stateFor(wrap);
    if (st[where] && st[where].isConnected) return st[where];

    var bar = document.createElement('div');
    bar.className = 'tlts-bar tlts-' + where;
    bar.setAttribute('aria-hidden', 'true');
    bar.appendChild(document.createElement('div'));

    /* Setting scrollLeft on the other bar fires its own scroll event, so
       a note of who started it stops the two pushing each other back and
       forth. Cleared on a timer rather than on the echo, because
       assigning a value that is already current fires nothing and the
       lock would never clear. */
    var lock = false;
    bar.addEventListener('scroll', function () {
      if (lock) return;
      lock = true;
      setPos(wrap, bar.scrollLeft, where);
      setTimeout(function () { lock = false; }, 60);
    }, { passive: true });

    var clip = clipFor(wrap);
    if (where === 'top') clip.parentNode.insertBefore(bar, clip);
    else clip.parentNode.insertBefore(bar, clip.nextSibling);

    st[where] = bar;

    if (typeof ResizeObserver === 'function' && !bar.__tltsRo) {
      var ro = new ResizeObserver(refresh);
      ro.observe(wrap);
      var t = wrap.querySelector('table');
      if (t) ro.observe(t);
      bar.__tltsRo = ro;
    }
    return bar;
  }

  /*
   * The wheel, because the table is no longer a scroll container and the
   * browser will not do it for us. Shift+wheel and a trackpad's sideways
   * swipe both arrive here as deltaX or a shifted deltaY.
   */
  function wheelFor(wrap) {
    var st = stateFor(wrap);
    if (st.wheel) return;
    st.wheel = true;
    wrap.addEventListener('wheel', function (e) {
      if (!st.max) return;
      var dx = e.shiftKey ? (e.deltaY || e.deltaX) : e.deltaX;
      if (!dx) return;
      var next = st.pos + dx;
      /* Only swallow the event while there is somewhere to go, so the
         page still scrolls when the table is already at its end. */
      if ((dx < 0 && st.pos > 0) || (dx > 0 && st.pos < st.max)) e.preventDefault();
      setPos(wrap, next);
    }, { passive: false });
  }

  /* ------------------------------------------------------------------ *
   * where the table was scrolled to, across a repaint
   * ------------------------------------------------------------------ */
  var positions = Object.create(null);

  function keyFor(wrap) {
    var t = wrap.querySelector('table');
    if (!t) return '';
    var head = t.querySelector('thead tr');
    if (!head) return '';
    return [].slice.call(head.children).map(function (c) {
      return (c.textContent || '').trim().slice(0, 12);
    }).join('|');
  }

  function remember(wrap) {
    var k = keyFor(wrap);
    if (k) positions[k] = stateFor(wrap).pos;
  }

  function restore(wrap) {
    var k = keyFor(wrap);
    if (!k) return;
    var was = positions[k];
    if (typeof was !== 'number' || was <= 0) return;
    setPos(wrap, was);
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

  /** Bars whose table has gone, on a page that kept the bars. */
  function sweep() {
    var all = document.querySelectorAll('.tlts-bar');
    for (var i = 0; i < all.length; i++) {
      var bar = all[i];
      var clip = bar.parentElement
        && bar.parentElement.querySelector(':scope > .tlts-clip');
      if (!clip || !clip.querySelector('table')) {
        if (bar.__tltsRo) { try { bar.__tltsRo.disconnect(); } catch (e) {} }
        bar.remove();
      }
    }
  }

  function place() {
    sweep();
    var narrow = window.innerWidth <= CARD_WIDTH;
    var wraps = wideTables();

    for (var i = 0; i < wraps.length; i++) {
      var wrap = wraps[i];
      var table = wrap.querySelector('table');
      if (!table) continue;

      var st = stateFor(wrap);

      /*
       * MEASURE WITH THE CLASS ON, NOT BEFORE IT.
       *
       * `min-width:max-content` is what lets the table take its natural
       * width, and it hangs off `.tlts` - so measuring first and adding
       * the class afterwards asks how wide a table is while it is still
       * being squeezed, gets "it fits", and never adds the class. The
       * class goes on, the width is read, and it comes off again if the
       * table genuinely fits.
       */
      table.classList.add('tlts');
      var avail = wrap.clientWidth || wrap.getBoundingClientRect().width;
      var full = table.scrollWidth;
      var over = Math.max(0, Math.round(full - avail));

      if (narrow || over <= 1) {
        table.classList.remove('tlts', 'tlts-x');
        table.style.transform = '';
        wrap.classList.remove('tlts-w');
        st.max = 0; st.pos = 0;
        if (st.top) st.top.classList.remove('on');
        if (st.bottom) st.bottom.classList.remove('on');
        continue;
      }

      wrap.classList.add('tlts-w');
      st.max = over;

      clipFor(wrap);
      openAncestors(wrap);
      wheelFor(wrap);

      /*
       * WHERE THE PAGE'S OWN CHROME STOPS.
       *
       * The header row parks just below the navbar - measured, because
       * the three shells in this app do not share a header height.
       *
       * There is NO bar above the header any more. The slim proxy that
       * sat between the navbar and the column headings read as a stray
       * scrollbar inside the table and was asked to go; the one at the
       * foot of the window, the wheel and the trackpad still move the
       * table. The header takes the bar's place, so no strip is left
       * where it was.
       */
      var navH = stickyTopFor(wrap);
      if (st.top) { st.top.remove(); st.top = null; }
      var bottom = barFor(wrap, 'bottom');
      var barH = Math.round(bottom.getBoundingClientRect().height) || 14;

      bottom.style.marginRight = fabClearance(barH) + 'px';
      wrap.style.setProperty('--tlts-head', navH + 'px');

      bottom.firstChild.style.width = full + 'px';
      bottom.classList.add('on');

      restore(wrap);
      setPos(wrap, st.pos);
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
