/* =====================================================================
   TeamLink - a scrollbar for the LIST, beside the list

   THE PROBLEM. Talent Pool and Applications are long. Fifty-eight rows
   is a two-thousand pixel table inside a six-thousand pixel page, and
   the only vertical control is the browser's own scrollbar at the edge
   of the window. That bar measures the whole PAGE - header, filters,
   facets, footer - so dragging it to "about halfway" lands somewhere
   that has nothing to do with being halfway down the list, and there is
   nothing anywhere that says which row you are near.

   WHAT THIS ADDS. A slim vertical bar pinned to the right-hand edge of
   the table itself. Its thumb measures the TABLE, not the page: full
   height means the whole list is on screen, a third of the way down
   means you are a third of the way through the candidates. Dragging it
   scrolls the page so the matching rows come into view, and while you
   drag it says which row you are at - "Row 34 of 58" - so a long list
   can be crossed in one movement instead of a dozen wheel turns.

   IT IS BESIDE THE TABLE, NOT AT THE WINDOW EDGE. A bar at the window
   edge is the browser's, already there, and already measuring the wrong
   thing. This one sits in a gutter reserved next to the rows it
   controls, which is where somebody looking for row 34 is looking.

   THIS IS THE VERTICAL COMPANION TO teamlink-table-scroll.js, which put
   the horizontal scrollbar above the table for the same reason: the
   control belongs next to the thing it moves. The two do not overlap -
   that one scrolls the table sideways inside its wrapper, this one
   scrolls the PAGE so that a part of the table comes into view.

   WHAT IT DELIBERATELY DOES NOT DO
   --------------------------------
   It does not give the table its own vertical scroll box. A nested
   scroll container would trap the wheel, break the sticky page header,
   and give the window two vertical bars that disagree. The page keeps
   scrolling the way it always did; this is a second, better-aimed way
   to drive it.

   It does nothing on a phone. Below the card breakpoint the tables are
   already one card per row, and a 10px drag target beside them would be
   a worse way to move than the thumb that is already under your finger.

   A container opts out with data-tl-no-side.
   ===================================================================== */
(function () {
  'use strict';

  /* Below this the prototype stacks every table into cards. */
  var CARD_WIDTH = 700;

  /* Worth a bar only when there is materially more list than screen.
     At 1.25 a list that is a screen and a quarter long gets one; below
     that the wheel is already the shorter route. */
  var MIN_OVERFLOW = 1.25;

  /* And only when it is a list. Eight rows is a panel, not a list. */
  var MIN_ROWS = 10;

  var RAIL_W = 14;          /* the gutter reserved beside the table */
  var THUMB_MIN = 30;       /* a thumb smaller than this cannot be grabbed */

  var STYLE_ID = 'tlvsStyle';

  /* The containers these two modules actually use. Talent Pool has its
     own markup (.tp-tbl); Applications and the ATS tables share the
     prototype's .tbl-wrap. Both are listed rather than guessed at, so a
     third table has to be added here on purpose. */
  var SELECTOR = '.tp-tbl, .tbl-wrap';

  /*
   * OFF BY DEFAULT, AND THIS IS WHY.
   *
   * It was asked for and built, and then reported as a fault: beside
   * the browser's own vertical scrollbar it reads as a second, thicker
   * one, and the 18px gutter it reserved narrowed the table enough to
   * clip the last column - Notice Period disappeared off the right on
   * the recruiter tables. What those screens actually needed was
   * HORIZONTAL reach, which teamlink-table-scroll.js gives them.
   *
   * The code is kept rather than deleted because the underlying idea -
   * a scrollbar that measures the LIST rather than the page - is still
   * a good one for a long table, and turning it back on is one flag:
   *
   *   window.TL_SIDE_SCROLL = true;   (before the page renders)
   */
  function enabled() { return window.TL_SIDE_SCROLL === true; }

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.tlvs-host{position:relative; padding-right:' + (RAIL_W + 4) + 'px}',

      '.tlvs-rail{position:absolute; top:0; right:0; width:' + RAIL_W + 'px;',
      '  border-radius:8px; background:rgba(148,163,184,.13);',
      /* Visible without being asked for. A control that only appears on
         hover is one a touch user never finds and a mouse user has to
         go looking for - and the point of it is to be the thing you
         reach for instead of the window edge. */
      '  opacity:.62; transition:opacity .16s ease; touch-action:none;',
      /* Above the rows, below the app's own overlays and the sticky
         horizontal bar (z-index 30) that sits at the top of the table. */
      '  z-index:12}',
      '.tlvs-host:hover .tlvs-rail, .tlvs-rail.tlvs-live{opacity:1}',

      '.tlvs-thumb{position:absolute; left:3px; width:' + (RAIL_W - 6) + 'px;',
      '  border-radius:5px; background:#9fb0c4; cursor:grab;',
      '  transition:background .12s ease}',
      '.tlvs-thumb:hover{background:#7d8ea6}',
      '.tlvs-thumb:focus-visible{outline:2px solid #4f46e5; outline-offset:2px}',
      '.tlvs-rail.tlvs-drag .tlvs-thumb{background:#5b6b80; cursor:grabbing}',

      /* Where you are, said in rows, only while you are moving. */
      '.tlvs-tag{position:absolute; right:' + (RAIL_W + 8) + 'px; white-space:nowrap;',
      '  background:#243449; color:#fff; font-size:11.5px; font-weight:600;',
      '  padding:3px 8px; border-radius:6px; pointer-events:none; opacity:0;',
      '  transition:opacity .12s ease;',
      '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}',
      '.tlvs-rail.tlvs-drag .tlvs-tag{opacity:1}',

      '@media (max-width:' + CARD_WIDTH + 'px){',
      '  .tlvs-host{padding-right:0}',
      '  .tlvs-rail{display:none!important}',
      '}',
      /* Somebody who has asked for less movement gets no fades. */
      '@media (prefers-reduced-motion:reduce){',
      '  .tlvs-rail,.tlvs-thumb,.tlvs-tag{transition:none}',
      '}',
    ].join('\n');
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ------------------------------------------------------------------ *
   * geometry
   * ------------------------------------------------------------------ */

  function docTop(el) {
    var r = el.getBoundingClientRect();
    return r.top + (window.pageYOffset || document.documentElement.scrollTop || 0);
  }

  function rowsIn(host) {
    var t = host.querySelector('table');
    return t ? t.querySelectorAll('tbody > tr').length : 0;
  }

  /**
   * Should this container have a bar at all?
   *
   * Asked again on every sweep, because a filter that cuts the list to
   * four rows should take the bar away rather than leave a control for
   * a list that now fits on the screen.
   */
  function wants(el) {
    if (el.hasAttribute('data-tl-no-side')) return false;
    if (window.innerWidth <= CARD_WIDTH) return false;
    if (rowsIn(el) < MIN_ROWS) return false;
    var h = el.getBoundingClientRect().height;
    return h > window.innerHeight * MIN_OVERFLOW;
  }

  /* ------------------------------------------------------------------ *
   * the bar
   * ------------------------------------------------------------------ */

  function hostFor(el) {
    if (el.parentElement && el.parentElement.classList.contains('tlvs-host')) {
      return el.parentElement;
    }
    var host = document.createElement('div');
    host.className = 'tlvs-host';
    el.parentNode.insertBefore(host, el);
    host.appendChild(el);
    return host;
  }

  function unwrap(host) {
    var rail = host.querySelector(':scope > .tlvs-rail');
    if (rail) rail.remove();
    var inner = host.firstElementChild;
    if (inner) host.parentNode.insertBefore(inner, host);
    host.remove();
  }

  function build(host) {
    var rail = host.querySelector(':scope > .tlvs-rail');
    if (rail) return rail;

    rail = document.createElement('div');
    rail.className = 'tlvs-rail';
    rail.setAttribute('role', 'scrollbar');
    rail.setAttribute('aria-orientation', 'vertical');
    rail.setAttribute('aria-label', 'Scroll through the list');

    var thumb = document.createElement('div');
    thumb.className = 'tlvs-thumb';
    thumb.tabIndex = 0;

    var tag = document.createElement('div');
    tag.className = 'tlvs-tag';

    rail.appendChild(thumb);
    rail.appendChild(tag);
    host.appendChild(rail);

    wire(host, rail, thumb, tag);
    return rail;
  }

  /**
   * Put the thumb where the screen currently is.
   *
   * The rail spans the whole container, so the fraction of the rail the
   * thumb sits at IS the fraction of the list on screen - which means
   * the thumb is always within the viewport for as long as any part of
   * the container is, without any sticky positioning.
   */
  function paint(host, rail, thumb) {
    var h = host.getBoundingClientRect().height;
    if (!h) return;
    var top = docTop(host);
    var y = window.pageYOffset || document.documentElement.scrollTop || 0;
    var winH = window.innerHeight;

    var from = Math.max(0, Math.min(h, y - top));
    var to = Math.max(0, Math.min(h, y + winH - top));

    var railH = h;
    var thumbH = Math.max(THUMB_MIN, Math.round(((to - from) / h) * railH));
    var thumbTop = Math.round((from / h) * railH);
    if (thumbTop + thumbH > railH) thumbTop = Math.max(0, railH - thumbH);

    thumb.style.height = thumbH + 'px';
    thumb.style.top = thumbTop + 'px';
    rail.style.height = railH + 'px';
    rail.setAttribute('aria-valuenow', String(Math.round((from / h) * 100)));
  }

  /** Which row is beside a point on the rail. */
  function rowLabel(host, fraction) {
    var n = rowsIn(host);
    if (!n) return '';
    var i = Math.max(1, Math.min(n, Math.round(fraction * n) || 1));
    return 'Row ' + i + ' of ' + n;
  }

  function wire(host, rail, thumb, tag) {
    var dragging = false, grabOffset = 0;

    var scrollToRailY = function (railY, centre) {
      var h = host.getBoundingClientRect().height;
      var top = docTop(host);
      var f = Math.max(0, Math.min(1, railY / h));
      var target = top + f * h - (centre ? window.innerHeight / 2 : 0);
      window.scrollTo({ top: Math.max(0, target), behavior: 'auto' });
      tag.style.top = Math.max(0, Math.min(h - 20, railY - 10)) + 'px';
      tag.textContent = rowLabel(host, f);
    };

    thumb.addEventListener('pointerdown', function (e) {
      dragging = true;
      grabOffset = e.clientY - thumb.getBoundingClientRect().top;
      rail.classList.add('tlvs-drag', 'tlvs-live');
      try { thumb.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });

    thumb.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var railTop = rail.getBoundingClientRect().top;
      scrollToRailY(e.clientY - railTop - grabOffset, false);
    });

    var release = function (e) {
      if (!dragging) return;
      dragging = false;
      rail.classList.remove('tlvs-drag');
      setTimeout(function () { rail.classList.remove('tlvs-live'); }, 400);
      try { thumb.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    thumb.addEventListener('pointerup', release);
    thumb.addEventListener('pointercancel', release);

    /* A click on the track goes there, centred - the same thing the
       browser's own scrollbar does with a track click. */
    rail.addEventListener('pointerdown', function (e) {
      if (e.target === thumb) return;
      var railTop = rail.getBoundingClientRect().top;
      scrollToRailY(e.clientY - railTop, true);
    });

    /* Reachable without a mouse. The step is a screenful, which is what
       PageUp/PageDown do, and what the arrows do on a scrollbar. */
    thumb.addEventListener('keydown', function (e) {
      var step = e.key === 'PageUp' || e.key === 'PageDown'
        ? window.innerHeight * 0.9 : 80;
      var dir = (e.key === 'ArrowDown' || e.key === 'PageDown') ? 1
              : (e.key === 'ArrowUp' || e.key === 'PageUp') ? -1 : 0;
      if (e.key === 'Home') { window.scrollTo({ top: docTop(host) }); e.preventDefault(); return; }
      if (e.key === 'End') {
        window.scrollTo({ top: docTop(host) + host.getBoundingClientRect().height });
        e.preventDefault(); return;
      }
      if (!dir) return;
      window.scrollBy({ top: dir * step, behavior: 'auto' });
      e.preventDefault();
    });
  }

  /* ------------------------------------------------------------------ *
   * keeping up with the page
   * ------------------------------------------------------------------ */

  var tracked = [];

  function sweep() {
    /* Off: take down anything a previous run put up, then stop. */
    if (!enabled()) {
      var hosts = document.querySelectorAll('.tlvs-host');
      for (var h = 0; h < hosts.length; h++) unwrap(hosts[h]);
      tracked = [];
      return;
    }
    injectCss();
    var found = [];
    var all = document.querySelectorAll(SELECTOR);

    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      /* A .tbl-wrap nested inside a .tp-tbl (or the reverse) would get
         two bars for one list. The outermost one owns it. */
      if (el.parentElement && el.parentElement.closest(SELECTOR)) continue;

      if (!wants(el)) {
        if (el.parentElement && el.parentElement.classList.contains('tlvs-host')) {
          unwrap(el.parentElement);
        }
        continue;
      }
      var host = hostFor(el);
      var rail = build(host);
      paint(host, rail, rail.firstElementChild);
      found.push(host);
    }

    /* Anything that was on the previous page and is not on this one. */
    for (var j = 0; j < tracked.length; j++) {
      var old = tracked[j];
      if (found.indexOf(old) === -1 && old.isConnected
          && !old.querySelector(SELECTOR)) {
        unwrap(old);
      }
    }
    tracked = found;
  }

  var painting = false;
  function repaint() {
    if (painting) return;
    painting = true;
    requestAnimationFrame(function () {
      painting = false;
      for (var i = 0; i < tracked.length; i++) {
        var host = tracked[i];
        if (!host.isConnected) continue;
        var rail = host.querySelector(':scope > .tlvs-rail');
        if (rail) paint(host, rail, rail.firstElementChild);
      }
    });
  }

  var sweeping = false;
  function queueSweep() {
    if (sweeping) return;
    sweeping = true;
    setTimeout(function () {
      sweeping = false;
      try { sweep(); } catch (e) {
        /* A broken scrollbar must not take the page with it. */
        if (window.console) console.warn('[side-scroll]', e && e.message);
      }
    }, 60);
  }

  window.addEventListener('scroll', repaint, { passive: true });
  window.addEventListener('resize', function () { queueSweep(); repaint(); });

  /* The app re-renders whole screens into #app, so the bar is rebuilt
     from whatever is there afterwards rather than tracked through it. */
  function watch() {
    var root = document.getElementById('app') || document.body;
    try {
      new MutationObserver(queueSweep)
        .observe(root, { childList: true, subtree: true });
    } catch (e) {}
    window.addEventListener('hashchange', queueSweep);
    queueSweep();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watch);
  } else {
    watch();
  }

  /* For a screen that fills a table in after its own fetch. */
  window.tlSideScrollRefresh = queueSweep;
}());
