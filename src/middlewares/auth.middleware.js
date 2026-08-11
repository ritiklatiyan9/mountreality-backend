import { verifyToken } from '../config/jwt.js';
import pool from '../config/db.js';

// Paths reachable while an organization has no active subscription (login + payment).
const SUBSCRIPTION_EXEMPT = /^\/(auth|billing)(\/|$)/;
const PORTAL_USER_ALLOWED = /^\/(auth|phase4\/portal)(\/|$)/;

const authMiddleware = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'No token provided' });

  let decoded;
  try {
    decoded = verifyToken(token);
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }

  const sessionId = Number(decoded.sid);
  const sessionIdHeader = req.header('X-Session-ID');
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return res.status(401).json({ message: 'Session expired. Please login again.' });
  }
  if (sessionIdHeader && Number(sessionIdHeader) !== sessionId) {
    return res.status(401).json({ message: 'Invalid session context' });
  }

  try {

    const userResult = await pool.query(
      `SELECT u.id, u.role, u.token_version, u.is_active, u.organization_id,
              o.is_active AS org_active,
              EXISTS (
                SELECT 1 FROM subscriptions s
                WHERE s.organization_id = u.organization_id
                  AND s.status = 'active'
                  AND s.current_period_end > NOW()
              ) AS subscription_active,
              EXISTS (
                SELECT 1 FROM user_sessions us
                 WHERE us.id=$2 AND us.user_id=u.id AND us.logout_time IS NULL
              ) AS session_active
       FROM users u
       LEFT JOIN organizations o ON o.id = u.organization_id
       WHERE u.id = $1 LIMIT 1`,
      [decoded.id, sessionId]
    );

    const dbUser = userResult.rows[0];
    if (!dbUser || !dbUser.is_active) {
      return res.status(401).json({ message: 'Session expired. Please login again.' });
    }

    if (decoded.version !== dbUser.token_version) {
      return res.status(401).json({ message: 'Session expired. Please login again.' });
    }

    if (!dbUser.session_active) {
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

    // A portal-only base identity never inherits broad authenticated routes.
    // Staff users may also hold portal memberships and retain normal RBAC.
    if (dbUser.role === 'portal_user' && !PORTAL_USER_ALLOWED.test(req.originalUrl)) {
      return res.status(403).json({ code: 'PORTAL_ONLY_IDENTITY', message: 'This identity can access only its assigned portal resources' });
    }

    req.sessionId = sessionId;

    // Tenant boundary: the selected Site is carried explicitly so RBAC can be
    // intersected with its published operating policy. Reject mismatched site
    // contexts instead of allowing a caller to authorize against Site A while
    // reading or mutating Site B.
    const suppliedSiteIds = [
      req.query?.site_id,
      req.body?.site_id,
      req.header('X-Site-ID'),
    ]
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0);
    const distinctSiteIds = [...new Set(suppliedSiteIds)];
    if (distinctSiteIds.length > 1) {
      return res.status(409).json({ message: 'Selected site does not match the requested site' });
    }
    const requestedSiteId = distinctSiteIds[0];
    if (Number.isInteger(requestedSiteId) && requestedSiteId > 0 && dbUser.role !== 'owner') {
      const siteCheck = await pool.query(
        'SELECT 1 FROM sites WHERE id = $1 AND organization_id = $2 LIMIT 1',
        [requestedSiteId, dbUser.organization_id]
      );
      if (!siteCheck.rows[0]) {
        return res.status(403).json({ message: 'Access denied to this site' });
      }
      if (dbUser.role === 'sub_admin') {
        const assignment = await pool.query(
          'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
          [dbUser.id, requestedSiteId]
        );
        if (!assignment.rows[0]) {
          return res.status(403).json({ message: 'Access denied to this site' });
        }
      }
    }

    // decoded contains: id, email, version — role + org always come fresh from the DB
    req.user = { ...decoded, role: dbUser.role, organization_id: dbUser.organization_id };
    req.siteContextId = requestedSiteId || null;
    req.subscriptionActive = dbUser.subscription_active;
    next();
  } catch (err) {
    next(err);
  }
};

export default authMiddleware;
