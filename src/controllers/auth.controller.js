import asyncHandler from '../utils/asyncHandler.js';
import { signAccessToken, signRefreshToken, verifyToken, hashPassword, comparePassword, hashRefreshToken } from '../config/jwt.js';
import { uploadSingle } from '../utils/upload.js';
import { firebaseEnabled, firebaseStatus, verifyFirebaseIdToken } from '../config/firebaseAdmin.js';
import userModel from '../models/User.model.js';
import siteModel from '../models/Site.model.js';
import permissionModel from '../models/Permission.model.js';
import pool from '../config/db.js';
import { generateUniqueSubdomain } from '../utils/subdomain.js';

/**
 * Everything a successful sign-in returns (tokens + sites + permissions + session).
 * Shared by password and Google login so both produce the exact same payload.
 */
const buildLoginPayload = async (user, req) => {
  const version = user.token_version;
  const accessToken = signAccessToken({ id: user.id, email: user.email, role: user.role, version });
  const refreshToken = signRefreshToken({ id: user.id, version });
  const hashedRefresh = await hashRefreshToken(refreshToken);
  await userModel.update(user.id, { refresh_token: hashedRefresh }, pool);

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

  // Record login session (skip for super_admin/owner to hide from activity)
  let sessionId = null;
  if (user.role !== 'super_admin' && user.role !== 'owner') {
    const ipAddress = req.ip || req.connection?.remoteAddress;
    const sessionResult = await pool.query(
      'INSERT INTO user_sessions (user_id, ip_address) VALUES ($1, $2) RETURNING id',
      [user.id, ipAddress]
    );
    sessionId = sessionResult.rows[0].id;
  }

  const organization = await fetchOrganization(user.organization_id);

  return { user: userModel.sanitize(user), organization, accessToken, refreshToken, sites, permissions, sessionId };
};

const fetchOrganization = async (organizationId) => {
  if (!organizationId) return null;
  const { rows } = await pool.query(
    'SELECT id, name, subdomain FROM organizations WHERE id = $1',
    [organizationId]
  );
  return rows[0] || null;
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
  const accessToken = signAccessToken({ id: user.id, email: user.email, role: user.role, version: 1 });
  const refreshToken = signRefreshToken({ id: user.id, version: 1 });
  const hashedRefresh = await hashRefreshToken(refreshToken);
  await userModel.update(user.id, { refresh_token: hashedRefresh }, pool);

  res.status(201).json({ user: userModel.sanitize(user), accessToken, refreshToken });
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
  if (String(password).length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters long' });
  }

  const existing = await userModel.findByEmail(email, pool);
  if (existing) return res.status(400).json({ message: 'User with this email already exists' });

  const hashedPassword = await hashPassword(password);

  const client = await pool.connect();
  let user;
  try {
    await client.query('BEGIN');
    const subdomain = await generateUniqueSubdomain(client, company_name);
    const orgResult = await client.query(
      'INSERT INTO organizations (name, subdomain) VALUES ($1, $2) RETURNING *',
      [String(company_name).trim(), subdomain]
    );
    const userResult = await client.query(
      `INSERT INTO users (name, email, password, phone, role, organization_id, is_active, token_version)
       VALUES ($1, $2, $3, $4, 'super_admin', $5, true, 1) RETURNING *`,
      [name, email, hashedPassword, phone || null, orgResult.rows[0].id]
    );
    user = userResult.rows[0];
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.status(201).json(await buildLoginPayload(user, req));
});

/**
 * POST /auth/login
 */
export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await userModel.findByEmail(email, pool);

  if (!user || !(await comparePassword(password, user.password))) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  if (!user.is_active) {
    return res.status(403).json({ message: 'Account is deactivated. Contact your admin.' });
  }

  res.json(await buildLoginPayload(user, req));
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
 * POST /auth/refresh — MULTI-SESSION SAFE (kept in sync with the booking backend).
 *
 * Any validly-signed, unexpired refresh token with the current token_version works.
 * Deliberately NO single-slot hash comparison and NO rotation: both apps share one
 * users row, so the old one-hash-per-user scheme made a second session's refresh
 * look like token theft — the handler then bumped token_version and logged the user
 * out of BOTH apps mid-click. Revocation still works: bump users.token_version to
 * kill every session at once; tokens self-expire in 49d / 7 weeks (config/jwt.js).
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

  const user = await userModel.findById(decoded.id, pool);
  if (!user || user.is_active === false || user.token_version !== decoded.version) {
    return res.status(401).json({ message: 'Invalid refresh token' });
  }

  const version = user.token_version;
  const accessToken = signAccessToken({ id: user.id, email: user.email, role: user.role, version });
  const newRefreshToken = signRefreshToken({ id: user.id, version });

  res.json({ accessToken, refreshToken: newRefreshToken });
});

/**
 * POST /auth/logout
 */
export const logout = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { sessionId } = req.body; // Expect frontend to send the session ID

  await userModel.update(userId, { refresh_token: null }, pool);

  if (sessionId) {
    await pool.query(
      'UPDATE user_sessions SET logout_time = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2',
      [sessionId, userId]
    );
  }

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

  res.json({ user: userModel.sanitize(user), organization, sites, permissions });
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
  const { name, email, password, phone } = req.body;
  const userId = req.user.id;
  let updateData = {};

  if (name) updateData.name = name;
  if (email) updateData.email = email;
  if (phone !== undefined) updateData.phone = phone;
  if (password) updateData.password = await hashPassword(password);
  if (req.file) {
    const photoUrl = await uploadSingle(req.file, 'cloudinary');
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
  if (newPassword.length < 6) {
    return res.status(400).json({ message: 'New password must be at least 6 characters long' });
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

  // Hash and update
  const hashedPassword = await hashPassword(newPassword);
  await userModel.update(userId, { password: hashedPassword }, pool);

  res.json({ message: 'Password updated successfully' });
});
