import asyncHandler from '../utils/asyncHandler.js';
import { signAccessToken, signRefreshToken, verifyToken, hashPassword, comparePassword, hashRefreshToken } from '../config/jwt.js';
import { uploadSingle } from '../utils/upload.js';
import { firebaseEnabled, firebaseStatus, verifyFirebaseIdToken } from '../config/firebaseAdmin.js';
import userModel from '../models/User.model.js';
import siteModel from '../models/Site.model.js';
import permissionModel from '../models/Permission.model.js';
import pool from '../config/db.js';
import { generateUniqueSubdomain } from '../utils/subdomain.js';
import { loadKyc, presentKyc } from './orgKyc.controller.js';
import { sendRegistrationEmail, sendOwnerNotificationEmail } from '../utils/mailer.js';

// Valid bcrypt hash used only to keep unknown-email and wrong-password checks
// on comparable work factors. It prevents a timing shortcut from becoming an
// account-enumeration signal without creating a fresh expensive hash per call.
const DUMMY_PASSWORD_HASH = '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.';

/**
 * Everything a successful sign-in returns (tokens + sites + permissions + session).
 * Shared by password and Google login so both produce the exact same payload.
 */
const buildLoginPayload = async (user, req) => {
  const version = user.token_version;
  const ipAddress = req.ip || req.connection?.remoteAddress;
  const sessionResult = await pool.query(
    `INSERT INTO user_sessions (user_id, ip_address, user_agent, last_seen_at)
     VALUES ($1, $2, $3, NOW()) RETURNING id`,
    [user.id, ipAddress, String(req.get?.('user-agent') || '').slice(0, 1000) || null]
  );
  const sessionId = sessionResult.rows[0].id;
  const accessToken = signAccessToken({ id: user.id, email: user.email, role: user.role, version, sid: sessionId });
  const refreshToken = signRefreshToken({ id: user.id, version, sid: sessionId });
  const refreshClaims = verifyToken(refreshToken, process.env.JWT_REFRESH_SECRET);
  const hashedRefresh = await hashRefreshToken(refreshToken);
  await pool.query(
    `UPDATE user_sessions
        SET refresh_token_hash=$1, refresh_expires_at=TO_TIMESTAMP($2)
      WHERE id=$3 AND user_id=$4`,
    [hashedRefresh, refreshClaims.exp, sessionId, user.id]
  );

  let sites;
  if (user.role === 'admin' || user.role === 'super_admin') {
    sites = await siteModel.findAllByOrg(user.organization_id, pool);
  } else if (user.role === 'owner') {
    sites = [];
  } else {
    sites = await siteModel.findByUserId(user.id, pool);
  }

  let permissions = null;
  if (user.role === 'sub_admin') {
    permissions = await permissionModel.getByUserId(user.id);
  }

  const organization = await fetchOrganization(user.organization_id);

  const portalMemberships = user.organization_id
    ? (await pool.query(
      `SELECT id,portal_type,site_id,rera_project_id,rera_project_phase_id,status
         FROM portal_memberships
        WHERE user_id=$1 AND organization_id=$2 AND status='ACTIVE'
          AND effective_from<=NOW() AND (effective_to IS NULL OR effective_to>NOW())
        ORDER BY portal_type,id`,
      [user.id, user.organization_id],
    )).rows
    : [];

  return { user: userModel.sanitize(user), organization, accessToken, refreshToken, sites, permissions, portalMemberships, sessionId };
};

const fetchOrganization = async (organizationId) => {
  if (!organizationId) return null;
  const { rows } = await pool.query(
    'SELECT id, name, subdomain FROM organizations WHERE id = $1',
    [organizationId]
  );
  if (!rows[0]) return null;
  // Only the two flags the shell needs; the full record comes from
  // GET /org/kyc when the timeline or the wizard actually opens.
  const kyc = presentKyc(await loadKyc(organizationId));
  return { ...rows[0], kyc_status: kyc.status, kyc_complete: kyc.is_complete };
};

/**
 * POST /auth/register
 * First-ever admin registration via Postman (no auth required).
 * If an admin already exists, this endpoint is LOCKED.
 */
export const register = asyncHandler(async (req, res) => {
  const { name, email, password, phone } = req.body;

  // Only allow if NO admin exists yet
  const hasAdmin = await userModel.adminExists(pool);
  if (hasAdmin) {
    return res.status(403).json({ message: 'Admin already exists. Use admin panel to create sub-admins.' });
  }

  const existing = await userModel.findByEmail(email, pool);
  if (existing) return res.status(400).json({ message: 'User with this email already exists' });

  const hashedPassword = await hashPassword(password);
  let photoUrl = null;
  if (req.file) {
    photoUrl = await uploadSingle(req.file, 'cloudinary');
  }

  const userData = {
    name,
    email,
    password: hashedPassword,
    phone: phone || null,
    photo: photoUrl,
    role: 'admin',
    is_active: true,
    token_version: 1,
  };

  const user = await userModel.create(userData, pool);
  res.status(201).json(await buildLoginPayload(user, req));
});

/**
 * POST /auth/signup — SaaS self-signup.
 * Creates an organization + its super_admin in one transaction and signs them in
 * immediately so the signup page can proceed straight to plan selection +
 * Razorpay payment. All non-billing APIs stay
 * blocked (402) until a subscription is activated.
 */
export const signup = asyncHandler(async (req, res) => {
  const { company_name, name, email, password, phone } = req.body;

  if (!company_name || !name || !email || !password) {
    return res.status(400).json({ message: 'Company name, your name, email and password are required' });
  }
  if (String(password).length < 10) {
    return res.status(400).json({ message: 'Password must be at least 10 characters long' });
  }

  const existing = await userModel.findByEmail(email, pool);
  if (existing) return res.status(400).json({ message: 'User with this email already exists' });

  const hashedPassword = await hashPassword(password);

  const client = await pool.connect();
  let user;
  let subdomain;
  let orgId;
  try {
    await client.query('BEGIN');
    subdomain = await generateUniqueSubdomain(client, company_name);
    const orgResult = await client.query(
      'INSERT INTO organizations (name, subdomain) VALUES ($1, $2) RETURNING *',
      [String(company_name).trim(), subdomain]
    );
    orgId = orgResult.rows[0].id;
    const userResult = await client.query(
      `INSERT INTO users (name, email, password, phone, role, organization_id, is_active, token_version)
       VALUES ($1, $2, $3, $4, 'super_admin', $5, true, 1) RETURNING *`,
      [name, email, hashedPassword, phone || null, orgId]
    );
    user = userResult.rows[0];
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  sendRegistrationEmail({ to: email, name, companyName: company_name, orgSubdomain: subdomain })
    .catch((err) => console.error('[mailer] registration email failed:', err.message));
  sendOwnerNotificationEmail({
    kind: 'registration', companyName: company_name, contactName: name, contactEmail: email, contactPhone: phone, orgId,
  }).catch((err) => console.error('[mailer] owner notify failed:', err.message));

  res.status(201).json(await buildLoginPayload(user, req));
});

/**
 * POST /auth/login
 */
export const login = asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!email || email.length > 320 || !password || password.length > 256) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }
  const user = await userModel.findByEmail(email, pool);

  const passwordMatches = await comparePassword(password, user?.password || DUMMY_PASSWORD_HASH);
  if (!user || !passwordMatches) {
    if (user) {
      await pool.query(
        `UPDATE users SET failed_login_count=failed_login_count+1,
          locked_until=CASE WHEN failed_login_count+1>=5 THEN NOW()+INTERVAL '15 minutes' ELSE NULL END
          WHERE id=$1`,
        [user.id],
      );
    }
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  if (!user.is_active) {
    return res.status(403).json({ message: 'Account is deactivated. Contact your admin.' });
  }

  await pool.query('UPDATE users SET failed_login_count=0,locked_until=NULL,last_login_at=NOW() WHERE id=$1', [user.id]);
  res.json(await buildLoginPayload({ ...user, failed_login_count: 0, locked_until: null }, req));
});

/** GET /auth/google/status — non-secret diagnostics for deploy debugging. */
export const googleStatus = asyncHandler(async (req, res) => {
  res.json(firebaseStatus());
});

/**
 * POST /auth/google — Sign in with Google.
 * The frontend runs the Firebase Google popup and sends the Firebase ID token here.
 * Sign-in works ONLY when the Google email already belongs to a users row (created
 * by an admin) — there is deliberately no self-signup.
 */
export const googleLogin = asyncHandler(async (req, res) => {
  const { credential } = req.body;
  if (!credential || typeof credential !== 'string') {
    return res.status(400).json({ message: 'Missing Google credential' });
  }
  if (!firebaseEnabled()) {
    return res.status(503).json({ message: 'Google Sign-In is not configured on this server' });
  }

  let decoded;
  try {
    decoded = await verifyFirebaseIdToken(credential);
  } catch {
    return res.status(401).json({ message: 'Invalid Google credential' });
  }
  if (decoded.firebase?.sign_in_provider !== 'google.com') {
    return res.status(401).json({ message: 'Only Google sign-in is accepted here' });
  }
  if (!decoded.email || decoded.email_verified !== true) {
    return res.status(401).json({ message: 'Your Google account has no verified email' });
  }

  const { rows } = await pool.query('SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1', [decoded.email]);
  const user = rows[0];
  if (!user) {
    return res.status(403).json({
      message: `No account is linked to ${decoded.email}. Ask your admin to create your account with this email, then try again.`,
    });
  }
  if (!user.is_active) {
    return res.status(403).json({ message: 'Account is deactivated. Contact your admin.' });
  }

  res.json({ ...(await buildLoginPayload(user, req)), via: 'google' });
});

/**
 * POST /auth/refresh — session-bound, rotating refresh token.
 * Each device has an independent session row. Rotation revokes only the token
 * that was just used and leaves the user's other signed-in devices untouched.
 */
export const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken || typeof refreshToken !== 'string') {
    return res.status(401).json({ message: 'Invalid refresh token' });
  }

  let decoded;
  try {
    decoded = verifyToken(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch {
    return res.status(401).json({ message: 'Invalid refresh token' });
  }

  const sessionId = Number(decoded.sid);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return res.status(401).json({ message: 'Invalid refresh token' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT us.id,us.logout_time,us.refresh_token_hash,us.refresh_expires_at,
              u.id AS user_id,u.email,u.role,u.token_version,u.is_active,
              o.is_active AS organization_active
         FROM user_sessions us
         JOIN users u ON u.id=us.user_id
         LEFT JOIN organizations o ON o.id=u.organization_id
        WHERE us.id=$1 AND us.user_id=$2
        FOR UPDATE OF us`,
      [sessionId, decoded.id]
    );
    const session = rows[0];
    const valid = session
      && session.is_active
      && !session.logout_time
      && session.refresh_expires_at
      && new Date(session.refresh_expires_at).getTime() > Date.now()
      && session.token_version === decoded.version
      && (session.role === 'owner' || session.organization_active !== false)
      && await comparePassword(refreshToken, session.refresh_token_hash);
    if (!valid) {
      await client.query('ROLLBACK');
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    const tokenPayload = {
      id: session.user_id,
      email: session.email,
      role: session.role,
      version: session.token_version,
      sid: sessionId,
    };
    const accessToken = signAccessToken(tokenPayload);
    const newRefreshToken = signRefreshToken(tokenPayload);
    const newClaims = verifyToken(newRefreshToken, process.env.JWT_REFRESH_SECRET);
    await client.query(
      `UPDATE user_sessions
          SET refresh_token_hash=$1,refresh_expires_at=TO_TIMESTAMP($2),last_seen_at=NOW()
        WHERE id=$3`,
      [await hashRefreshToken(newRefreshToken), newClaims.exp, sessionId]
    );
    await client.query('COMMIT');
    return res.json({ accessToken, refreshToken: newRefreshToken, sessionId });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

/**
 * POST /auth/logout
 */
export const logout = asyncHandler(async (req, res) => {
  await pool.query(
    `UPDATE user_sessions
        SET logout_time=CURRENT_TIMESTAMP,refresh_token_hash=NULL
      WHERE id=$1 AND user_id=$2 AND logout_time IS NULL`,
    [req.sessionId, req.user.id]
  );

  res.json({ message: 'Logged out' });
});

/**
 * GET /auth/me
 * Get current user profile + accessible sites
 */
export const getMe = asyncHandler(async (req, res) => {
  const user = await userModel.findById(req.user.id, pool);
  if (!user) return res.status(404).json({ message: 'User not found' });

  let sites;
  if (user.role === 'admin' || user.role === 'super_admin') {
    sites = await siteModel.findAllByOrg(user.organization_id, pool);
  } else if (user.role === 'owner') {
    sites = [];
  } else {
    sites = await siteModel.findByUserId(user.id, pool);
  }

  // Fetch permissions for sub_admin
  let permissions = null;
  if (user.role === 'sub_admin') {
    permissions = await permissionModel.getByUserId(user.id);
  }

  const organization = await fetchOrganization(user.organization_id);

  const portalMemberships = user.organization_id
    ? (await pool.query(
      `SELECT id,portal_type,site_id,rera_project_id,rera_project_phase_id,status
         FROM portal_memberships
        WHERE user_id=$1 AND organization_id=$2 AND status='ACTIVE'
          AND effective_from<=NOW() AND (effective_to IS NULL OR effective_to>NOW())
        ORDER BY portal_type,id`,
      [user.id, user.organization_id],
    )).rows
    : [];

  res.json({ user: userModel.sanitize(user), organization, sites, permissions, portalMemberships });
});

/**
 * POST /auth/domain-intro-seen — the signed-in user has dismissed the
 * first-login workspace-domain modal; never show it again on any device.
 * Idempotent, so the client can fire-and-forget it.
 */
export const markDomainIntroSeen = asyncHandler(async (req, res) => {
  await pool.query('UPDATE users SET domain_intro_seen = true WHERE id = $1', [req.user.id]);
  res.json({ ok: true });
});

/**
 * PUT /auth/profile
 */
export const updateProfile = asyncHandler(async (req, res) => {
  const { name, email, phone } = req.body;
  const userId = req.user.id;
  let updateData = {};

  if (name) updateData.name = name;
  if (email !== undefined) {
    const currentUser = await userModel.findById(userId, pool);
    const requestedEmail = String(email || '').trim().toLowerCase();
    const currentEmail = String(currentUser?.email || '').trim().toLowerCase();
    if (!currentUser) return res.status(404).json({ message: 'User not found' });
    if (requestedEmail !== currentEmail) {
      return res.status(400).json({
        code: 'EMAIL_CHANGE_REQUIRES_VERIFICATION',
        message: 'Email changes require re-authentication and email verification. Contact your administrator.',
      });
    }
  }
  if (phone !== undefined) updateData.phone = phone;
  if (req.file) {
    const photoUrl = await uploadSingle(req.file, 's3', { folder: 'profile-photos' });
    updateData.photo = photoUrl;
  }

  const updatedUser = await userModel.update(userId, updateData, pool);
  res.json({ user: userModel.sanitize(updatedUser) });
});

/**
 * PUT /auth/change-password
 * Securely change password (requires current password verification)
 */
export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const userId = req.user.id;

  // Validate required fields
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  // Validate new password length
  if (newPassword.length < 10) {
    return res.status(400).json({ message: 'New password must be at least 10 characters long' });
  }

  // Check passwords match
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ message: 'New password and confirm password do not match' });
  }

  // Fetch user with password hash
  const user = await userModel.findById(userId, pool);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  // Verify current password
  const isMatch = await comparePassword(currentPassword, user.password);
  if (!isMatch) {
    return res.status(401).json({ message: 'Current password is incorrect' });
  }

  // Don't allow same password
  if (currentPassword === newPassword) {
    return res.status(400).json({ message: 'New password must be different from current password' });
  }

  // Revoke every session after a credential change. This request's access
  // token also becomes invalid immediately through token_version.
  const hashedPassword = await hashPassword(newPassword);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE users SET password=$1,token_version=token_version+1,updated_at=NOW() WHERE id=$2`,
      [hashedPassword, userId]
    );
    await client.query(
      `UPDATE user_sessions SET logout_time=NOW(),refresh_token_hash=NULL
        WHERE user_id=$1 AND logout_time IS NULL`,
      [userId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  res.json({ message: 'Password updated successfully. Please sign in again.', reauthenticate: true });
});
