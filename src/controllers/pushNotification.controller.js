import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { firebaseEnabled } from '../config/firebaseAdmin.js';

const cleanToken = (value) => {
  const token = String(value || '').trim();
  return token.length >= 32 && token.length <= 4096 && !/[\r\n]/.test(token) ? token : null;
};

export const registerWebPushToken = asyncHandler(async (req, res) => {
  if (!firebaseEnabled()) return res.status(503).json({ message: 'Firebase messaging is not configured' });
  const token = cleanToken(req.body.token);
  if (!token) return res.status(400).json({ message: 'A valid Firebase messaging token is required' });
  const userAgent = String(req.body.user_agent || req.get('user-agent') || '').trim().slice(0, 1000) || null;
  const deviceLabel = String(req.body.device_label || '').trim().slice(0, 160) || null;
  const { rows } = await pool.query(
    `INSERT INTO firebase_web_push_tokens
       (organization_id,user_id,token,user_agent,device_label,is_active,last_seen_at)
     VALUES ($1,$2,$3,$4,$5,TRUE,NOW())
     ON CONFLICT (token) DO UPDATE SET
       organization_id=EXCLUDED.organization_id,
       user_id=EXCLUDED.user_id,
       user_agent=EXCLUDED.user_agent,
       device_label=EXCLUDED.device_label,
       is_active=TRUE,
       last_seen_at=NOW(),
       last_error=NULL,
       updated_at=NOW()
     RETURNING id,last_seen_at`,
    [req.user.organization_id, req.user.id, token, userAgent, deviceLabel],
  );
  res.json({ registered: true, subscription: rows[0] });
});

export const unregisterWebPushToken = asyncHandler(async (req, res) => {
  const token = cleanToken(req.body.token);
  if (!token) return res.status(400).json({ message: 'A valid Firebase messaging token is required' });
  await pool.query(
    `UPDATE firebase_web_push_tokens
        SET is_active=FALSE,updated_at=NOW()
      WHERE organization_id=$1 AND user_id=$2 AND token=$3`,
    [req.user.organization_id, req.user.id, token],
  );
  res.json({ registered: false });
});

export const webPushStatus = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS active_devices
       FROM firebase_web_push_tokens
      WHERE organization_id=$1 AND user_id=$2 AND is_active=TRUE`,
    [req.user.organization_id, req.user.id],
  );
  res.json({ configured: firebaseEnabled(), active_devices: rows[0]?.active_devices || 0 });
});
