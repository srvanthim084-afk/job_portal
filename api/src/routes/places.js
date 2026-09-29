/**
 * What is near a point.
 *
 * One request per place a recruiter ticks, not one per result: the client
 * asks for everything inside the widest radius the panel offers, keeps
 * it, and filters that array as the radius moves. Changing 25 KM to
 * 50 KM makes no request at all.
 *
 * Read-only and signed-in. Nothing here touches a candidate, a job or an
 * application; it is a gazetteer.
 */
import { Router } from 'express';
import { treeChildren, treeSearch, treeNear, treeDescendantNames }
  from '../place-tree.js';
import { wrap, badRequest } from '../errors.js';
import { requireAuth } from '../auth.js';
import { placesNear, placeByName, placesStatus } from '../places.js';

export default function placesRoutes() {
  const r = Router();

  /** GET /api/places/status — is the index on disk, and is it loaded? */
  r.get('/places/status', requireAuth(), wrap(async (req, res) => {
    res.json(placesStatus());
  }));

  /**
   * GET /api/places/near?lat=&lon=&km=&limit=
   * GET /api/places/near?name=Chittoor&state=Andhra%20Pradesh&km=100
   *
   * `name` is the convenience the location panel uses: it knows what the
   * recruiter ticked, not where it is.
   */
  r.get('/places/near', requireAuth(), wrap(async (req, res) => {
    const q = req.query || {};
    const km = Math.min(Math.max(Number(q.km) || 50, 1), 500);
    const limit = Math.min(Math.max(Number(q.limit) || 4000, 1), 20000);

    let lat = Number(q.lat);
    let lon = Number(q.lon);
    let anchor = null;

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      if (!q.name) throw badRequest('Give either lat and lon, or a place name.');
      anchor = await placeByName(q.name, q.state);
      if (!anchor) {
        /* Said plainly rather than returning an empty list, which the
           panel would otherwise report as "nothing nearby" - a very
           different statement from "we do not know where that is". */
        return res.json({ found: false, name: String(q.name), total: 0, places: [] });
      }
      lat = anchor.lat;
      lon = anchor.lon;
    }

    const out = await placesNear(lat, lon, km, { limit });
    res.json({
      found: true,
      anchor: anchor ? { name: anchor.name, state: anchor.state, lat, lon } : { lat, lon },
      km,
      ...out,
    });
  }));

  /* ------------------------------------------------------------------ *
   * the hierarchy
   *
   * State -> District -> Mandal/Taluk -> City/Town/Village, out of the
   * index built by tools/build-place-tree.mjs. Every one of these is
   * answered from memory: the browse tree expands, the typeahead types
   * and the radius moves without a request per node, per keystroke or
   * per nearby place.
   * ------------------------------------------------------------------ */

  /** The children of a node, or the 36 states when nothing is named. */
  r.get('/places/tree', requireAuth(), wrap(async (req, res) => {
    const parent = String(req.query.parent || '').trim() || null;
    const out = await treeChildren(parent);
    res.json(out);
  }));

  /**
   * The typeahead. Every level at once, ranked exact -> prefix ->
   * contains, and each result carries the whole chain above it so two
   * places of the same name can be told apart.
   */
  r.get('/places/search', requireAuth(), wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 60);
    if (q.length < 2) return res.json({ results: [] });
    res.json({ results: await treeSearch(q, { limit }) });
  }));

  /**
   * Everything within N km of a node, at every level, with its distance.
   *
   * Works from a state, a district, a mandal or a village - they all
   * carry coordinates. `nearest` is returned even when nothing is inside
   * the radius, so the panel can keep saying "the closest is X, Y KM
   * away" rather than going blank in a sparse district.
   */
  r.get('/places/near-node', requireAuth(), wrap(async (req, res) => {
    const id = String(req.query.id || '').trim();
    if (!id) throw badRequest('Say which place to measure from.');
    const km = Math.min(Math.max(parseInt(req.query.km, 10) || 25, 1), 500);
    const limit = Math.min(parseInt(req.query.limit, 10) || 2000, 4000);
    res.json(await treeNear(id, km, { limit }));
  }));

  /**
   * Every place name under a node.
   *
   * What the candidate search needs: the table stores a free-text
   * location, so ticking a district has to become the set of names its
   * people might have written.
   */
  r.get('/places/descendants', requireAuth(), wrap(async (req, res) => {
    const ids = String(req.query.ids || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!ids.length) throw badRequest('Say which places.');
    const out = {};
    for (const id of ids.slice(0, 40)) out[id] = await treeDescendantNames(id);
    res.json({ names: out });
  }));

  return r;
}
