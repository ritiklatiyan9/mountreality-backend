import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';

/**
 * GET /activity/today
 * Fetch paginated sessions for today (logins today OR currently active)
 */
export const getTodayActivity = asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const offset = (page - 1) * limit;

    // We want sessions where login_time is today OR logout_time is null (active)
    // Let's keep it simple: any session that started today OR is still ongoing.
    const query = `
    SELECT 
      us.id AS session_id,
      us.login_time,
      us.logout_time,
      us.ip_address,
      u.id AS user_id,
      u.name,
      u.role,
      u.photo
    FROM user_sessions us
    JOIN users u ON us.user_id = u.id
    WHERE (us.login_time >= current_date OR us.logout_time IS NULL)
      AND u.organization_id = $1
      AND u.role != 'super_admin'
    ORDER BY us.login_time DESC
    LIMIT $2 OFFSET $3
  `;

    const countQuery = `
    SELECT COUNT(*) 
    FROM user_sessions us
    JOIN users u ON us.user_id = u.id
    WHERE (us.login_time >= current_date OR us.logout_time IS NULL)
      AND u.organization_id = $1
      AND u.role != 'super_admin'
  `;

    const [dataResult, countResult] = await Promise.all([
        pool.query(query, [req.user.organization_id, limit, offset]),
        pool.query(countQuery, [req.user.organization_id])
    ]);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    res.json({
        activities: dataResult.rows,
        pagination: {
            total,
            page,
            limit,
            totalPages
        }
    });
});

  /**
   * POST /activity/logout-session
   * Admin can force logout any active session.
   */
  export const forceLogoutSession = asyncHandler(async (req, res) => {
    const sessionId = parseInt(req.body?.sessionId, 10);

    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res.status(400).json({ message: 'Valid sessionId is required' });
    }

    const sessionResult = await pool.query(
      `SELECT us.id, us.user_id, us.logout_time, u.role
         FROM user_sessions us
         JOIN users u ON u.id = us.user_id
        WHERE us.id = $1 AND u.organization_id = $2`,
      [sessionId, req.user.organization_id]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ message: 'Session not found' });
    }

    const targetSession = sessionResult.rows[0];
    if (targetSession.user_id !== req.user.id && targetSession.role !== 'sub_admin') {
      return res.status(403).json({ message: 'You can force logout only users you manage' });
    }
    if (targetSession.logout_time) {
      return res.json({ message: 'Session already logged out' });
    }

    await pool.query(
      `UPDATE user_sessions
       SET logout_time = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2`,
      [sessionId, targetSession.user_id]
    );

    // Only invalidate tokens if force-logging out a DIFFERENT user's session.
    // If admin is logging out one of their own other sessions, don't bump token_version
    // because that would invalidate ALL of admin's sessions including the current one.
    if (targetSession.user_id !== req.user.id) {
      await pool.query(
        `UPDATE users
         SET refresh_token = NULL,
           token_version = token_version + 1
         WHERE id = $1 AND organization_id = $2`,
        [targetSession.user_id, req.user.organization_id]
      );
    }

    res.json({ message: 'Session logged out successfully', sessionId });
  });
