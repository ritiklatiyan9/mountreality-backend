import NodeCache from 'node-cache';

// ── In-process cache (node-cache) — replaced Redis, same async API ──
const stdTTL = parseInt(process.env.CACHE_STD_TTL_SECONDS || '45', 10);

// ponytail: single-process cache; if the API ever runs multiple instances, swap back to a shared store
const cache = new NodeCache({ stdTTL, checkperiod: 60, useClones: false });

export const initCache = () => {
  console.log(`[Cache] node-cache ready (ttl ${stdTTL}s)`);
  return cache;
};

export const cacheEnabled = () =>
  String(process.env.CACHE_ENABLED || 'true').toLowerCase() === 'true';

export const getDefaultTTL = () => stdTTL;

/**
 * Get a cached value by key.
 * @returns {Promise<object|null>}
 */
export const cacheGet = async (key) => cache.get(key) ?? null;

/**
 * Set a cached value with TTL (seconds).
 */
export const cacheSet = async (key, value, ttlSeconds = stdTTL) => {
  cache.set(key, value, ttlSeconds);
};

/**
 * Clear all cache keys matching any of the given prefixes/namespaces.
 * Mirrors the old Redis `SCAN MATCH *prefix*` semantics: unanchored match,
 * with `*` inside a prefix acting as a wildcard (e.g. `dashboard:*:5:`).
 */
export const clearCacheByPrefixes = async (prefixes = []) => {
  if (!prefixes?.length) return 0;
  const regexes = prefixes.map((p) => new RegExp(
    p.replace(/^\/+/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  ));
  const keys = cache.keys().filter((k) => regexes.some((r) => r.test(k)));
  return cache.del(keys);
};

/**
 * Get basic cache stats.
 */
export const getCacheStats = async () => ({ keys: cache.keys().length, connected: true });
