import { cacheGet, cacheSet } from '../config/cache.js';

/**
 * Per-user rate limiter backed by the existing node-cache instance (not a
 * raw Map) so stale counters expire via TTL instead of leaking memory.
 * Single-process only — matches this backend's existing cache convention.
 */
const createRateLimiter = ({ windowMs, max, keyPrefix }) => {
  return async (req, res, next) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: 'Authentication required' });

      const key = `${keyPrefix}${userId}`;
      const now = Date.now();
      const existing = await cacheGet(key);

      const entry = existing && existing.resetAt > now
        ? { count: existing.count + 1, resetAt: existing.resetAt }
        : { count: 1, resetAt: now + windowMs };

      const ttlSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      await cacheSet(key, entry, ttlSeconds);

      if (entry.count > max) {
        res.set('Retry-After', String(ttlSeconds));
        return res.status(429).json({ message: 'Too many requests. Please slow down and try again shortly.' });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};

export default createRateLimiter;
