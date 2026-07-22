import { verifyToken } from '../config/jwt.js';
import pool from '../config/db.js';

// Paths reachable while an organization has no active subscription (login + payment).
const SUBSCRIPTION_EXEMPT = /^\/(auth|billing)(\/|$)/;

const authMiddleware = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'No token provided' });

  try {
    const decoded = verifyToken(token);
    const sessionIdHeader = req.header('X-Session-ID');

    const userResult = await pool.query(
      `SELECT u.id, u.role, u.token_version, u.is_active, u.organization_id,
              o.is_active AS org_active,
              EXISTS (
                SELECT 1 FROM subscriptions s
                WHERE s.organization_id = u.organization_id
                  AND s.status = 'active'
                  AND s.current_period_end > NOW()
              ) AS subscription_active
       FROM users u
       LEFT JOIN organizations o ON o.id = u.organization_id
       WHERE u.id = $1 LIMIT 1`,
      [decoded.id]
    );

    const dbUser = userResult.rows[0];
    if (!dbUser || !dbUser.is_active) {
      return res.status(401).json({ message: 'Session expired. Please login again.' });
    }

    if (decoded.version !== dbUser.token_version) {
      return res.status(401).json({ message: 'Session expired. Please login again.' });
    }

    // Platform owner can disable a whole organization from the Owner Panel.
    if (dbUser.role !== 'owner' && dbUser.organization_id && dbUser.org_active === false) {
      return res.status(403).json({ message: 'Your organization has been disabled. Contact support.' });
    }

    // Subscription gate: everything except auth + billing requires an active plan.
    if (dbUser.role !== 'owner' && !dbUser.subscription_active && !SUBSCRIPTION_EXEMPT.test(req.originalUrl)) {
      return res.status(402).json({
        code: 'SUBSCRIPTION_REQUIRED',
        message: 'No active subscription. Choose a plan to continue.',
      });
    }

    if (sessionIdHeader && dbUser.role !== 'super_admin' && dbUser.role !== 'owner') {
      const sessionId = parseInt(sessionIdHeader, 10);
      if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return res.status(401).json({ message: 'Invalid session context' });
      }

      const sessionResult = await pool.query(
        `SELECT id, logout_time
         FROM user_sessions
         WHERE id = $1 AND user_id = $2
         LIMIT 1`,
        [sessionId, decoded.id]
      );

      if (!sessionResult.rows[0] || sessionResult.rows[0].logout_time) {
        return res.status(401).json({ message: 'Session expired. Please login again.' });
      }

      req.sessionId = sessionId;
    }

    // Tenant boundary: any site_id sent in query/body must belong to the caller's org.
    const requestedSiteId = parseInt(req.query?.site_id ?? req.body?.site_id, 10);
    if (Number.isInteger(requestedSiteId) && requestedSiteId > 0 && dbUser.role !== 'owner') {
      const siteCheck = await pool.query(
        'SELECT 1 FROM sites WHERE id = $1 AND organization_id = $2 LIMIT 1',
        [requestedSiteId, dbUser.organization_id]
      );
      if (!siteCheck.rows[0]) {
        return res.status(403).json({ message: 'Access denied to this site' });
      }
    }

    // decoded contains: id, email, version — role + org always come fresh from the DB
    req.user = { ...decoded, role: dbUser.role, organization_id: dbUser.organization_id };
    req.subscriptionActive = dbUser.subscription_active;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid or expired token' });
  }
};

export default authMiddleware;
