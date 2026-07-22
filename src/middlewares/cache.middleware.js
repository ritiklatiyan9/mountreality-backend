import { cacheEnabled, cacheGet, cacheSet, clearCacheByPrefixes, getDefaultTTL } from '../config/cache.js';

const sortQueryEntries = (queryObj = {}) => (
  Object.entries(queryObj)
    .filter(([k]) => k !== 'nocache')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .join('&')
);

const buildKey = (req, namespace = 'api') => {
  const userPart = req.user?.id ? `u:${req.user.id}` : 'u:anon';
  const queryPart = sortQueryEntries(req.query || {});
  return `${namespace}|${userPart}|${req.path}|${queryPart}`;
};

export const cacheResponse = ({ ttlSeconds, namespace = 'api' } = {}) => {
  const ttl = ttlSeconds ?? getDefaultTTL();
  return async (req, res, next) => {
    if (!cacheEnabled() || req.method !== 'GET') return next();

    const noCacheRequested =
      String(req.query?.nocache || '').toLowerCase() === 'true' ||
      String(req.headers['cache-control'] || '').includes('no-cache');

    if (noCacheRequested) return next();

    const key = buildKey(req, namespace);

    try {
      const cached = await cacheGet(key);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.status(cached.statusCode).json(cached.payload);
      }
    } catch {
      // Redis read failure — proceed without cache
    }

    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // Fire-and-forget: don't await cache write
        cacheSet(key, { statusCode: res.statusCode, payload }, ttl).catch(() => {});
      }
      res.setHeader('X-Cache', 'MISS');
      return originalJson(payload);
    };

    return next();
  };
};

export const invalidateCacheOnSuccess = (prefixes = []) => {
  return (_req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 400) {
        // Mutations wired through this middleware may affect both the
        // consolidated statement and dashboard GraphQL aggregates. Clearing
        // both namespaces prevents an immediate refetch from returning the
        // old value for another 15–45 seconds.
        const effectivePrefixes = [...new Set([...prefixes, 'balance-sheet|', 'dashboard:'])];
        clearCacheByPrefixes(effectivePrefixes).catch(() => {});
      }
    });
    next();
  };
};
