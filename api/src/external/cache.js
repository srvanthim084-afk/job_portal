/**
 * A small cache for the portal's external-job reads (master prompt §38).
 *
 * WHAT IT CACHES: the listing (per filter set) and the details page (per
 * id), which every visitor to the public job board asks for again and
 * again, and the provider catalogue.
 *
 * HOW IT IS INVALIDATED: every entry carries the "version" of the external
 * tables at the time it was built - external_portal_version(), which moves
 * whenever ANY posting or source row changes, however it changed (a sync,
 * a bulk action, a source switched off, a direct UPDATE: both tables stamp
 * updated_at in a trigger since 0108). A read asks for the version (one
 * indexed max() and a count) and uses the entry only if it matches. So a
 * closed job is gone from the next request, not from the next minute.
 * `bump()` empties it outright after a write made through the API.
 *
 * Bounded (LRU-ish, oldest first out) and per process. EXTERNAL_PORTAL_CACHE_SECONDS=0
 * switches it off.
 */
import { config } from '../config.js';

const MAX = 500;
const entries = new Map();
let generation = 0;

export function bump() {
  generation += 1;
  entries.clear();
}

export function stats() {
  return { size: entries.size, generation };
}

/**
 * @param key      what is being cached
 * @param version  the current data version (a string), or null to skip the check
 * @param load     async () => value
 */
export async function cached(key, version, load) {
  const ttl = Math.max(0, Number(config.externalJobs.portalCacheSeconds) || 0) * 1000;
  if (!ttl) return { value: await load(), hit: false };
  const now = Date.now();
  const e = entries.get(key);
  if (e && e.gen === generation && e.version === version && now - e.at < ttl) {
    entries.delete(key); entries.set(key, e);          // most recently used last
    return { value: e.value, hit: true };
  }
  const value = await load();
  entries.set(key, { value, version, gen: generation, at: now });
  while (entries.size > MAX) entries.delete(entries.keys().next().value);
  return { value, hit: false };
}
