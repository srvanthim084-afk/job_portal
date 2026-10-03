/*
 * TeamLink — the Location selector, every level deep.
 *
 * The selector (tlLocField / tlTreeHtml in index.html) browses
 * States -> Districts out of window.INDIA_GEO, a hand-written two-level
 * map, and stopped there: below a district there was nothing to open, and
 * typing found states, districts and a few hundred cities. The data for
 * the rest - 6,891 mandals and 549,026 towns and villages, each with its
 * parent and its coordinates - is held in memory by the API
 * (api/src/place-tree.js, built by tools/build-place-tree.mjs).
 *
 * This EXTENDS the selector in place. Nothing here draws a new panel or
 * restyles one; it adds to the rows the selector already rendered, using
 * the selector's own classes (tl-drow, tl-dcar, tl-row2, tl-areas):
 *
 *   tree       every district gets the expand arrow and a child count;
 *              opening it lists its mandals and towns, opening a mandal
 *              lists its villages. Children are fetched once per node
 *              from the in-memory index and kept; long lists use
 *              content-visibility so only the rows on screen are laid out.
 *   checkboxes every level has one. A ticked parent shows its children as
 *              covered; a partial selection shows the parent
 *              indeterminate; ticking a parent drops the children it now
 *              covers, so nothing is counted twice.
 *   tags       a mandal or village tag names its state, like the cities do.
 *   typing     an "All places" group: every level, ranked exact -> prefix
 *              -> contains, higher levels first, each with its type and
 *              full path so two Dendulurus can be told apart.
 *   near by    measures from ANY picked place, village included.
 *   matching   a picked state / district / mandal matches everyone in any
 *              place under it (TL_LOC.matches, and placeIds for the
 *              server-filtered Talent Pool).
 *
 * Applications ("Place") and Talent Pool ("Location") now use this
 * selector instead of a plain text box.
 */
(function () {
  'use strict';

  var P = {
    states: null, statesLoading: null,   // fold(state) -> node
    kids: {}, kidsLoading: {},           // node id -> [node]
    node: {},                            // node id -> node
    open: {},                            // field key -> { node id: true }
    tag: {},                             // lower(tag) -> node id
    desc: {}, descLoading: {},           // lower(tag) -> Set(folded names)
    search: {}, searchTimer: null,
  };

  var api = function () { return window.TL && TL.api; };
  var low = function (v) { return String(v == null ? '' : v).trim().toLowerCase(); };
  var fold = function (v) {
    return String(v == null ? '' : v).split(',')[0].normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/^(state of|nct of|union territory of)\s+/, '')
      .replace(/[^a-z0-9]+/g, ' ').trim();
  };
  var jq = function (v) { return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); };
  var h = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  var TYPE_LABEL = { state: 'State', district: 'District', mandal: 'Mandal', place: 'Place' };

  /* ------------------------------------------------------------------ *
   * the index, a node at a time
   * ------------------------------------------------------------------ */

  function remember(n, parent) {
    var anc = n.ancestorIds ? n.ancestorIds.slice()
      : parent ? [parent.id].concat(parent.anc || []) : [];
    var state = n.type === 'state' ? n.name
      : (n.path && n.path.length ? n.path[n.path.length - 1] : (parent ? (parent.state || parent.name) : ''));
    var node = P.node[n.id] || {};
    node.id = n.id; node.name = n.name; node.type = n.type;
    node.childCount = n.childCount != null ? n.childCount : node.childCount;
    node.lat = n.lat; node.lng = n.lng; node.parentId = n.parentId;
    node.anc = anc; node.state = state;
    node.path = n.path || node.path;
    P.node[n.id] = node;
    return node;
  }

  function loadStates() {
    if (P.states) return Promise.resolve(P.states);
    if (P.statesLoading || !api()) return P.statesLoading || Promise.resolve(null);
    P.statesLoading = api().get('/places/tree').then(function (out) {
      var map = {};
      (out.children || []).forEach(function (n) { map[fold(n.name)] = remember(n, null); });
      P.states = map;
      return map;
    }).catch(function () { P.statesLoading = null; return null; });
    return P.statesLoading;
  }

  function loadKids(id) {
    if (P.kids[id]) return Promise.resolve(P.kids[id]);
    if (P.kidsLoading[id]) return P.kidsLoading[id];
    P.kidsLoading[id] = api().get('/places/tree?parent=' + encodeURIComponent(id)).then(function (out) {
      var parent = P.node[id] || (out.parent ? remember(out.parent, null) : null);
      if (parent && out.ancestorIds) parent.anc = out.ancestorIds.slice();
      P.kids[id] = (out.children || []).map(function (n) { return remember(n, parent); });
      delete P.kidsLoading[id];
      return P.kids[id];
    }).catch(function () { delete P.kidsLoading[id]; return []; });
    return P.kidsLoading[id];
  }

  /** Every place name under a picked place, for matching people to it. */
  function loadDesc(tagName, id) {
    var k = low(tagName);
    if (!id || P.desc[k] || P.descLoading[k] || !api()) return;
    P.descLoading[k] = true;
    api().get('/places/descendants?ids=' + encodeURIComponent(id)).then(function (out) {
      var names = (out.names && out.names[id]) || [];
      var set = new Set(); names.forEach(function (n) { set.add(fold(n)); });
      P.desc[k] = set;
      delete P.descLoading[k];
      // The filters re-run with the wider meaning.
      Object.keys(P.watch).forEach(function (key) {
        if (tlLocState(key).tags.some(function (t) { return low(t) === k; })) changed(key);
      });
    }).catch(function () { delete P.descLoading[k]; });
  }
  P.watch = {};

  /** The district node the page's own district label refers to. */
  function districtFor(stateNode, label) {
    var list = stateNode && P.kids[stateNode.id];
    if (!list) return null;
    var f = fold(label);
    var hit = null;
    list.forEach(function (n) { if (!hit && n.type === 'district' && fold(n.name) === f) hit = n; });
    if (hit) return hit;
    // "Sri Potti Sriramulu Nellore" on the page, "Nellore" in the index.
    list.forEach(function (n) {
      var g = fold(n.name);
      if (!hit && n.type === 'district' && g.length > 4 && f.length > 4 && (f.indexOf(g) >= 0 || g.indexOf(f) >= 0)) hit = n;
    });
    return hit;
  }

  /** The node a tag stands for, if it is one we can place. */
  function idOfTag(t) {
    var k = low(t);
    if (P.tag[k]) return P.tag[k];
    var f = fold(t);
    if (P.states && P.states[f]) return P.states[f].id;
    var found = null;
    Object.keys(P.node).forEach(function (id) {
      var n = P.node[id];
      if (!found && n.type === 'district' && fold(n.name) === f) found = id;
    });
    return found;
  }

  function selectedIds(key) {
    var ids = {};
    (tlLocState(key).tags || []).forEach(function (t) { var id = idOfTag(t); if (id) ids[id] = t; });
    return ids;
  }

  /* ------------------------------------------------------------------ *
   * picking
   * ------------------------------------------------------------------ */

  /* One repaint per field however many loads land: each full repaint of
     the panel costs about two seconds in the layers wrapped around it, and
     thirty-six states arriving one by one froze the page for a minute. */
  var repaintTimer = {};
  function repaintSoon(key) {
    if (repaintTimer[key]) return;
    repaintTimer[key] = setTimeout(function () {
      repaintTimer[key] = null;
      if (typeof tlLocRefresh === 'function') tlLocRefresh(key);
    }, 60);
  }

  function changed(key) {
    if (typeof window.tlLocRefresh === 'function') tlLocRefresh(key);
    if (typeof window.tlLocOnChange === 'function') tlLocOnChange(key);
  }

  /** Tags that sit inside `id` - covered once `id` is picked. */
  function dropCovered(key, id) {
    var st = tlLocState(key);
    st.tags = st.tags.filter(function (t) {
      var tid = idOfTag(t);
      var n = tid && P.node[tid];
      return !(n && n.anc && n.anc.indexOf(id) >= 0);
    });
  }

  window.tlPtPick = function (key, id, on) {
    var n = P.node[id];
    if (!n) return;
    var st = tlLocState(key);
    var sel = selectedIds(key);
    var coveredBy = null;
    (n.anc || []).forEach(function (a) { if (!coveredBy && sel[a]) coveredBy = a; });

    if (on) {
      if (coveredBy) { changed(key); return; }     // already inside a ticked place
      dropCovered(key, id);
      P.tag[low(n.name)] = id;
      if (!st.tags.some(function (t) { return low(t) === low(n.name); })) st.tags.push(n.name);
      st.tags = st.tags.filter(function (t) { return low(t) !== 'all india'; });
      st.open = true;
      loadDesc(n.name, id);
      changed(key);
      return;
    }

    if (sel[id]) {
      st.tags = st.tags.filter(function (t) { return low(t) !== low(sel[id]); });
      changed(key);
      return;
    }
    if (coveredBy) {
      /* Unticking one village of a ticked mandal: the mandal becomes its
         other villages, so everything else stays selected. Level by
         level up to the ticked ancestor. */
      st.tags = st.tags.filter(function (t) { return low(t) !== low(sel[coveredBy]); });
      var cur = n;
      while (cur && cur.id !== coveredBy) {
        var sibs = P.kids[cur.parentId] || [];
        sibs.forEach(function (s) {
          if (s.id === cur.id) return;
          P.tag[low(s.name)] = s.id;
          if (!st.tags.some(function (t) { return low(t) === low(s.name); })) st.tags.push(s.name);
          loadDesc(s.name, s.id);
        });
        cur = P.node[cur.parentId];
      }
      changed(key);
    }
  };

  window.tlPtToggle = function (key, id) {
    P.open[key] = P.open[key] || {};
    P.open[key][id] = !P.open[key][id];
    if (P.open[key][id] && !P.kids[id]) {
      loadKids(id).then(function () { repaintSoon(key); });
    }
    if (typeof tlLocRefresh === 'function') tlLocRefresh(key);
  };

  /** The ids for a field's tags, for the server-filtered Talent Pool. */
  window.tlPlaceIdsFor = function (key) {
    var ids = [];
    (tlLocState(key).tags || []).forEach(function (t) { var id = idOfTag(t); if (id) ids.push(id); });
    return ids;
  };

  /* ------------------------------------------------------------------ *
   * drawing - added into the rows the selector already rendered
   * ------------------------------------------------------------------ */

  function boxState(key, n, sel) {
    if (sel[n.id]) return 'on';
    if ((n.anc || []).some(function (a) { return !!sel[a]; })) return 'on';
    var inside = Object.keys(sel).some(function (id) {
      var m = P.node[id]; return m && m.anc && m.anc.indexOf(n.id) >= 0;
    });
    return inside ? 'part' : '';
  }

  function nodeRows(key, list, sel) {
    var open = P.open[key] || {};
    return list.map(function (n) {
      var b = boxState(key, n, sel);
      var hasKids = n.childCount > 0;
      var isOpen = !!open[n.id];
      var row = '<label class="tl-row2 tlpt-row" onmousedown="event.preventDefault()">'
        + '<input type="checkbox"' + (b === 'on' ? ' checked' : '') + (b === 'part' ? ' data-tlpt-part="1"' : '')
        + ' onchange="tlPtPick(\'' + jq(key) + '\',\'' + jq(n.id) + '\',this.checked)">'
        + '<span class="nm">' + h(n.name) + '</span>'
        + (n.type === 'mandal' ? '<span class="tlpt-kind">Mandal</span>' : '')
        + (hasKids ? '<span class="tlpt-n">' + n.childCount + '</span>' : '')
        + '</label>';
      if (!hasKids) return '<div class="tlpt-leaf">' + row + '</div>';
      var kids = isOpen ? (P.kids[n.id]
        ? '<div class="tl-areas tlpt-kids">' + nodeRows(key, P.kids[n.id], sel) + '</div>'
        : '<div class="tl-areas tlpt-kids"><div class="tlpt-wait">Loading…</div></div>') : '';
      return '<div class="tl-drow tlpt-drow">'
        + '<button type="button" class="tl-dcar" onmousedown="event.preventDefault()" '
        + 'onclick="event.stopPropagation();tlPtToggle(\'' + jq(key) + '\',\'' + jq(n.id) + '\')" '
        + 'title="' + n.childCount + ' place' + (n.childCount === 1 ? '' : 's') + ' in ' + h(n.name) + '">'
        + (isOpen ? '▾' : '▸') + '</button>' + row + '</div>' + kids;
    }).join('');
  }

  function decorateTree(key, tr, sel) {
    if (!P.states) {
      loadStates().then(function (m) { if (m) repaintSoon(key); });
      return;
    }
    var open = P.open[key] = P.open[key] || {};
    var missing = [];
    Array.prototype.forEach.call(tr.querySelectorAll('.tl-sthead'), function (head) {
      var nm = head.querySelector('span:nth-child(2)');
      var sNode = nm && P.states[fold(nm.textContent)];
      var dists = head.nextElementSibling;
      if (!sNode || !dists || !dists.classList.contains('tl-dists')) return;
      if (!P.kids[sNode.id]) { missing.push(sNode.id); return; }
      Array.prototype.forEach.call(dists.querySelectorAll('label.tl-row2'), function (lab) {
        if (lab.closest('.tlpt-kids')) return;
        var nmEl = lab.querySelector('.nm');
        var text = nmEl ? nmEl.textContent.trim() : '';
        var input = lab.querySelector('input[type=checkbox]');
        if (/^All - /.test(text)) {
          if (input && boxState(key, sNode, sel) === 'part') input.indeterminate = true;
          return;
        }
        if (lab.parentNode && lab.parentNode.classList.contains('tl-areas')) return;   // an in-page locality
        var d = districtFor(sNode, text);
        if (!d) return;
        var b = boxState(key, d, sel);
        if (input) {
          if (b === 'on' && !input.checked) input.checked = true;
          if (b === 'part') input.indeterminate = true;
        }
        if (!(d.childCount > 0)) return;

        /* Its own arrow, its count, and - when open - its children. A
           district that already had an arrow for its localities keeps
           them, listed first. */
        var wrap = lab.parentNode && lab.parentNode.classList.contains('tl-drow') ? lab.parentNode : null;
        var localities = '';
        if (wrap) {
          var oldCar = wrap.querySelector(':scope > .tl-dcar');
          if (oldCar) oldCar.remove();
          var oldAreas = wrap.nextElementSibling;
          if (oldAreas && oldAreas.classList.contains('tl-areas') && !oldAreas.classList.contains('tlpt-kids')) oldAreas.remove();
        } else {
          wrap = document.createElement('div');
          wrap.className = 'tl-drow';
          lab.parentNode.insertBefore(wrap, lab);
          wrap.appendChild(lab);
        }
        if (open[d.id] && typeof window.tlAreasOfDistrict === 'function') {
          var areas = window.tlAreasOfDistrict(nm.textContent.trim(), text) || [];
          localities = areas.map(function (a) {
            var on = (tlLocState(key).tags || []).some(function (t) { return low(t) === low(a.name); }) || b === 'on';
            return '<div class="tlpt-leaf"><label class="tl-row2 tlpt-row" onmousedown="event.preventDefault()">'
              + '<input type="checkbox"' + (on ? ' checked' : '')
              + ' onchange="tlTreePick(\'' + jq(key) + '\',\'' + jq(a.name) + '\',this.checked)">'
              + '<span class="nm">' + h(a.name) + '</span><span class="tlpt-kind">Locality</span></label></div>';
          }).join('');
        }
        var car = document.createElement('button');
        car.type = 'button';
        car.className = 'tl-dcar';
        car.setAttribute('onmousedown', 'event.preventDefault()');
        car.setAttribute('onclick', "event.stopPropagation();tlPtToggle('" + jq(key) + "','" + jq(d.id) + "')");
        car.title = d.childCount + ' places in ' + d.name;
        car.textContent = open[d.id] ? '▾' : '▸';
        wrap.insertBefore(car, wrap.firstChild);
        if (!lab.querySelector('.tlpt-n')) {
          var cnt = document.createElement('span');
          cnt.className = 'tlpt-n';
          cnt.textContent = d.childCount;
          lab.appendChild(cnt);
        }
        var old = wrap.nextElementSibling;
        if (old && old.classList.contains('tlpt-kids')) old.remove();
        if (open[d.id]) {
          var box = document.createElement('div');
          box.className = 'tl-areas tlpt-kids';
          box.innerHTML = localities + (P.kids[d.id] ? nodeRows(key, P.kids[d.id], sel)
            : '<div class="tlpt-wait">Loading…</div>');
          wrap.parentNode.insertBefore(box, wrap.nextSibling);
          if (!P.kids[d.id]) missing.push(d.id);
        }
      });
    });
    if (missing.length) {
      Promise.all(missing.map(loadKids)).then(function () { repaintSoon(key); });
    }
    Array.prototype.forEach.call(tr.querySelectorAll('input[data-tlpt-part]'), function (i) { i.indeterminate = true; });
  }

  /* typing: every level, with its path */
  function decorateSearch(key, tr, sel, q) {
    var main = tr.querySelector('.tl-main') || tr;
    var old = main.querySelector('.tlpt-search'); if (old) old.remove();
    var k = low(q);
    if (k.length < 2) return;
    var res = P.search[k];
    if (!res) {
      clearTimeout(P.searchTimer);
      P.searchTimer = setTimeout(function () {
        if (!api()) return;
        api().get('/places/search?limit=30&q=' + encodeURIComponent(q)).then(function (out) {
          P.search[k] = (out.results || []).map(function (n) { return remember(n, null); });
          var st = tlLocState(key);
          if (low(st.q) === k) repaintSoon(key);
        }).catch(function () {});
      }, 160);
      return;
    }
    if (!res.length) return;
    var g = document.createElement('div');
    g.className = 'grp tlpt-search';
    g.innerHTML = '<b>All places</b>' + res.map(function (n) {
      var b = boxState(key, n, sel);
      var path = [TYPE_LABEL[n.type] || n.type].concat(n.path || []).join(' · ');
      return '<label class="tl-row2 tlpt-row" onmousedown="event.preventDefault()">'
        + '<input type="checkbox"' + (b === 'on' ? ' checked' : '') + (b === 'part' ? ' data-tlpt-part="1"' : '')
        + ' onchange="tlPtPick(\'' + jq(key) + '\',\'' + jq(n.id) + '\',this.checked)">'
        + '<span class="nm">' + h(n.name) + '</span>'
        + '<span class="tlpt-path">' + h(path) + '</span></label>';
    }).join('');
    var anchor = main.querySelector('.tl-cityhit') || main.querySelector('.tl-fhint');
    if (anchor && anchor.nextSibling) main.insertBefore(g, anchor.classList.contains('tl-fhint') ? anchor.nextSibling : anchor);
    else main.insertBefore(g, main.firstChild);
    var none = main.querySelector('.tl-fnone'); if (none) none.remove();
    var hint = main.querySelector('.tl-fhint .m');
    if (hint && /No place matches/.test(hint.textContent)) {
      hint.innerHTML = '🔎 <b>' + res.length + '</b> place' + (res.length === 1 ? '' : 's') + ' matching “<b>' + h(q) + '</b>”';
    }
  }

  /* "Denduluru · Andhra Pradesh" - the same marker the page already puts
     on the cities it knows, for the mandals and villages it does not. */
  function decorateTags(key) {
    var box = document.getElementById('tlTags_' + key);
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('.tl-tag'), function (tag) {
      if (tag.querySelector('.tl-tst')) return;
      var text = tag.firstChild;
      if (!text || text.nodeType !== 3) return;
      var id = P.tag[low(text.nodeValue)];
      var n = id && P.node[id];
      if (!n || n.type === 'state' || !n.state) return;
      var i = document.createElement('i');
      i.className = 'tl-tst';
      i.textContent = '· ' + n.state;
      tag.insertBefore(i, text.nextSibling);
    });
  }

  function decorate(key) {
    var st = tlLocState(key);
    decorateTags(key);
    var tr = document.getElementById('tlTree_' + key);
    if (!tr || !tr.classList.contains('on')) return;
    var sel = selectedIds(key);
    var q = String(st.q || '').trim();
    if (q) decorateSearch(key, tr, sel, q);
    decorateTree(key, tr, sel);
  }

  /* ------------------------------------------------------------------ *
   * the two filters that now use the selector
   * ------------------------------------------------------------------ */

  function applicationsField() {
    var prev = window.tlAppFilterHtml;
    if (typeof prev !== 'function' || prev.__tlpt) return;
    var next = function () {
      var html = prev.apply(this, arguments);
      if (typeof html !== 'string' || typeof window.tlLocField !== 'function') return html;
      var at = html.indexOf('<div class="fld"><i>Place</i><input');
      if (at < 0) return html;
      var end = html.indexOf('></div>', at);
      if (end < 0) return html;
      var m = /value="([^"]*)"/.exec(html.slice(at, end));
      var st = tlLocState('appLoc');
      if (m && m[1] && !st.tags.length) {
        st.tags = m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').split(/\s*,\s*/).filter(Boolean);
      }
      P.watch.appLoc = true;
      return html.slice(0, at) + '<div class="fld"><i>Place</i>'
        + tlLocField('appLoc', { placeholder: 'e.g. Hyderabad' }) + '</div>' + html.slice(end + 7);
    };
    next.__tlpt = true;
    window.tlAppFilterHtml = next;

    var clear = window.tlAppFilterClear;
    if (typeof clear === 'function' && !clear.__tlpt) {
      var c2 = function () { tlLocState('appLoc').tags = []; tlLocState('appLoc').km = ''; return clear.apply(this, arguments); };
      c2.__tlpt = true;
      window.tlAppFilterClear = c2;
    }
  }

  function onChangeHook() {
    var prev = window.tlLocOnChange;
    if (prev && prev.__tlpt) return;
    var next = function (key) {
      if (key === 'appLoc') {
        var t = tlLocState('appLoc').tags || [];
        t.forEach(function (x) { var id = idOfTag(x); if (id) loadDesc(x, id); });
        if (typeof window.tlAppFilterSet === 'function') tlAppFilterSet('loc', t.join(', '));
        return;
      }
      if (key === 'tpLoc') {
        var t2 = tlLocState('tpLoc').tags || [];
        if (typeof window.tpSet === 'function') tpSet('location', t2.join(','));
        return;
      }
      if (typeof prev === 'function') return prev.apply(this, arguments);
    };
    next.__tlpt = true;
    window.tlLocOnChange = next;
  }

  /* ------------------------------------------------------------------ *
   * meaning: a picked place covers what is inside it; any level has a centre
   * ------------------------------------------------------------------ */

  function matchingHook() {
    if (!window.TL_LOC || !TL_LOC.matches || TL_LOC.matches.__tlpt) return;
    var prev = TL_LOC.matches;
    var m = function (recordLoc, selected) {
      var d = P.desc[low(selected)];
      if (d && d.has(fold(recordLoc))) return true;
      return prev.apply(this, arguments);
    };
    m.__tlpt = true;
    TL_LOC.matches = m;
  }

  function coordsHook() {
    var prev = window.tlNearbyCoords;
    if (prev && prev.__tlpt) return;
    var next = function (t) {
      var c = typeof prev === 'function' ? prev.apply(this, arguments) : null;
      if (c) return c;
      var id = P.tag[low(t)];
      var n = id && P.node[id];
      return n && isFinite(n.lat) && isFinite(n.lng) ? [Number(n.lat), Number(n.lng)] : null;
    };
    next.__tlpt = true;
    window.tlNearbyCoords = next;
  }

  /* A state or district ticked through the page's own rows covers its
     children too: drop the ones it now covers, learn what is under it. */
  function pickHook() {
    var prev = window.tlTreePick;
    if (typeof prev !== 'function' || prev.__tlpt) return;
    var next = function (key, v, on) {
      if (on) {
        var id = idOfTag(v);
        if (id) { dropCovered(key, id); loadDesc(v, id); }
      }
      return prev.apply(this, arguments);
    };
    next.__tlpt = true;
    window.tlTreePick = next;
  }

  function refreshHook() {
    var prev = window.tlLocRefresh;
    if (typeof prev !== 'function' || prev.__tlpt) return;
    var next = function (key) {
      var r = prev.apply(this, arguments);
      try { decorate(key); } catch (e) { /* never break the picker */ }
      return r;
    };
    next.__tlpt = true;
    window.tlLocRefresh = next;
  }

  /*
   * KEEP THE PANEL OPEN ACROSS A REPAINT OF ITS FILTER BAR.
   *
   * Talent Pool repaints its own bar after every load (tpPaint, not the
   * app's render), which rebuilds the field the panel belongs to. The
   * panel lives on <body> and survived, but nothing told it to draw
   * again, so ticking one place closed it - and multi-select is the
   * point of the panel. When an open field is rebuilt, it is redrawn.
   */
  function keepOpen() {
    var seen = {};
    var obs = new MutationObserver(function () {
      ['tpLoc', 'appLoc'].forEach(function (key) {
        var el = document.getElementById('tlLoc_' + key);
        if (!el || el === seen[key]) return;
        seen[key] = el;
        try { decorateTags(key); } catch (e) {}
        if (tlLocState(key).open) repaintSoon(key);
      });
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function install() {
    if (typeof window.tlLocState !== 'function') return;
    keepOpen();
    applicationsField();
    onChangeHook();
    matchingHook();
    coordsHook();
    pickHook();
    refreshHook();
    var css = document.createElement('style');
    css.textContent =
      '.tlpt-row{content-visibility:auto;contain-intrinsic-size:auto 30px}'
      + '.tlpt-kids .tlpt-kids{margin-left:14px}'
      + '.tlpt-n,.tlpt-kind,.tlpt-path{margin-left:auto;font-size:11px;color:#8a94a6;white-space:nowrap}'
      + '.tlpt-kind+.tlpt-n{margin-left:8px}'
      + '.tlpt-path{max-width:62%;overflow:hidden;text-overflow:ellipsis}'
      + '.tlpt-wait{font-size:12px;color:#8a94a6;padding:4px 8px}';
    document.head.appendChild(css);
  }

  if (document.readyState === 'complete') install();
  else window.addEventListener('load', install);

  window.TLPlaceTree = P;
})();
