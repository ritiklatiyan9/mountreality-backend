import { incrementRateLimit } from '../config/cache.js';

/**
 * Per-user rate limiter backed by the existing node-cache instance (not a
 * raw Map) so stale counters expire via TTL instead of leaking memory.
 * Single-process only — matches this backend's existing cache convention.
 */
const createRateLimiter = ({ windowMs, max, keyPrefix, requireUser = true, keyGenerator = null }) => {
  return async (req, res, next) => {
    try {
      const userId = req.user?.id;
      if (requireUser && !userId) return res.status(401).json({ message: 'Authentication required' });

      const subject = keyGenerator ? keyGenerator(req) : (userId || req.ip || 'anonymous');
      const key = `${keyPrefix}${subject}`;
      const entry = incrementRateLimit(key, windowMs);

      if (entry.count > max) {
        res.set('Retry-After', String(entry.ttlSeconds));
        return res.status(429).json({ message: 'Too many requests. Please slow down and try again shortly.' });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};

export default createRateLimiter;
