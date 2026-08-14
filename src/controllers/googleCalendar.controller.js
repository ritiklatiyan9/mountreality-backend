import crypto from 'crypto';
import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { encrypt, decrypt } from '../utils/tokenCrypto.js';
import { buildOAuthClient, backfillOrgEvents } from '../services/googleCalendarSync.service.js';
import { isOriginAllowed } from '../config/cors.js';

const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
const settingsPage = (origin) => `${origin}/settings?tab=google-calendar`;

/* Each organisation reaches the app on its own tenant subdomain, so the
   callback has to send the admin back to the host they started on rather
   than a single configured front end. The origin is validated against the
   CORS allowlist when the flow starts and then travels inside the signed
   state, so the callback can never be talked into redirecting elsewhere. */
const originFor = (req) => {
  const referer = (() => {
    try { return req.headers.referer ? new URL(req.headers.referer).origin : null; } catch { return null; }
  })();
  for (const candidate of [req.headers.origin, referer]) {
    if (candidate && isOriginAllowed(candidate)) return candidate.replace(/\/$/, '');
  }
  return FRONTEND_URL;
};
// openid+email are only used to learn which Google account was connected;
// calendar.events is the least-privilege calendar scope (no calendar list/settings access).
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'];
const STATE_TTL_MS = 10 * 60 * 1000;

const isConfigured = () =>
  Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    && process.env.GOOGLE_REDIRECT_URI && process.env.CALENDAR_TOKEN_ENC_KEY);

// The OAuth callback arrives as a bare browser redirect from Google (no auth
// header), so the state param is the whole proof of who initiated the flow:
// an HMAC-signed orgId+userId+expiry minted by the authenticated /connect call.
const stateSecret = () => String(process.env.CALENDAR_TOKEN_ENC_KEY || '');
const signState = (orgId, userId, origin) => {
  const payload = Buffer.from(JSON.stringify({ o: orgId, u: userId, r: origin, e: Date.now() + STATE_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
};
const verifyState = (state) => {
  const [payload, sig] = String(state || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.o || !data.e || Date.now() > data.e) return null;
    return { orgId: data.o, userId: data.u, origin: data.r || FRONTEND_URL };
  } catch {
    return null;
  }
};

// Google's id_token is received directly from Google over the TLS token
// exchange, so decoding its payload without signature verification is safe here.
const emailFromIdToken = (idToken) => {
  try {
    return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')).email || null;
  } catch {
    return null;
  }
};

export const getConnectUrl = asyncHandler(async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ message: 'Google Calendar integration is not configured on this server' });
  }
  const url = buildOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // guarantees a refresh_token even on reconnect
    scope: SCOPES,
    state: signState(req.user.organization_id, req.user.id, originFor(req)),
  });
  res.json({ url });
});

export const oauthCallback = asyncHandler(async (req, res) => {
  // Until the state is verified the tenant host is unknown, so early failures
  // land on the configured front end rather than a caller-supplied one.
  let origin = FRONTEND_URL;
  const fail = (reason) => res.redirect(`${settingsPage(origin)}&google=error&reason=${encodeURIComponent(reason)}`);
  if (!isConfigured()) return fail('not_configured');
  if (req.query.error) return fail(String(req.query.error));
  const state = verifyState(req.query.state);
  if (!state) return fail('invalid_state');
  origin = state.origin;
  if (!req.query.code) return fail('missing_code');

  let tokens;
  try {
    ({ tokens } = await buildOAuthClient().getToken(String(req.query.code)));
  } catch (err) {
    console.error('[gcal] token exchange failed:', err.message);
    return fail('token_exchange_failed');
  }
  if (!tokens.refresh_token) return fail('no_refresh_token');
  const email = emailFromIdToken(tokens.id_token);
  if (!email) return fail('no_account_email');

  try {
    await pool.query(
      `INSERT INTO google_calendar_connections
         (organization_id, google_account_email, access_token_enc, refresh_token_enc, token_expiry, scope, connected_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active')
       ON CONFLICT (organization_id) DO UPDATE SET
         google_account_email=EXCLUDED.google_account_email,
         access_token_enc=EXCLUDED.access_token_enc,
         refresh_token_enc=EXCLUDED.refresh_token_enc,
         token_expiry=EXCLUDED.token_expiry,
         scope=EXCLUDED.scope,
         connected_by=EXCLUDED.connected_by,
         status='active',
         updated_at=NOW()`,
      [state.orgId, email, encrypt(tokens.access_token), encrypt(tokens.refresh_token),
        tokens.expiry_date ? new Date(tokens.expiry_date) : null, tokens.scope || SCOPES.join(' '), state.userId],
    );
  } catch (err) {
    // A user on Google's redirect should land back in Settings with a toast,
    // not on a raw JSON error page (e.g. a malformed CALENDAR_TOKEN_ENC_KEY).
    console.error('[gcal] failed to store connection:', err.message);
    return fail('server_error');
  }
  // Existing future-dated events appear on the calendar without waiting to be
  // edited. Fire-and-forget: the admin's redirect must not wait on N API calls.
  backfillOrgEvents(state.orgId).catch((err) => {
    console.error(`[gcal] backfill (org ${state.orgId}) failed:`, err.message);
  });
  res.redirect(`${settingsPage(origin)}&google=connected`);
});

export const disconnect = asyncHandler(async (req, res) => {
  const orgId = req.user.organization_id;
  const { rows } = await pool.query(
    `SELECT id, refresh_token_enc FROM google_calendar_connections
      WHERE organization_id=$1 AND status='active' LIMIT 1`,
    [orgId],
  );
  if (!rows[0]) return res.status(404).json({ message: 'No Google Calendar connection to disconnect' });
  try {
    await buildOAuthClient().revokeToken(decrypt(rows[0].refresh_token_enc));
  } catch (err) {
    console.error('[gcal] token revoke failed (continuing):', err.message);
  }
  await pool.query(
    `UPDATE google_calendar_connections SET status='revoked', updated_at=NOW() WHERE id=$1`,
    [rows[0].id],
  );
  // Stale without the account — future connections start with a clean slate.
  await pool.query('DELETE FROM google_calendar_event_links WHERE organization_id=$1', [orgId]);
  res.json({ success: true });
});

// Rewrites linked future events in place. This lets admins apply presentation
// changes such as an updated summary without disconnecting their account.
export const syncFutureEvents = asyncHandler(async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ message: 'Google Calendar integration is not configured on this server' });
  const { rowCount } = await pool.query(
    `SELECT 1 FROM google_calendar_connections
      WHERE organization_id=$1 AND status='active' LIMIT 1`,
    [req.user.organization_id],
  );
  if (!rowCount) return res.status(404).json({ message: 'No active Google Calendar connection found' });
  const synced = await backfillOrgEvents(req.user.organization_id);
  res.json({ success: true, synced });
});

export const getStatus = asyncHandler(async (req, res) => {
  const orgId = req.user.organization_id;
  const [connection, emails] = await Promise.all([
    pool.query(
      `SELECT google_account_email, created_at, updated_at FROM google_calendar_connections
        WHERE organization_id=$1 AND status='active' LIMIT 1`,
      [orgId],
    ),
    pool.query(
      'SELECT id, email FROM google_calendar_notify_emails WHERE organization_id=$1 ORDER BY email',
      [orgId],
    ),
  ]);
  res.json({
    configured: isConfigured(),
    connection: connection.rows[0] || null,
    emails: emails.rows,
  });
});

export const addNotifyEmail = asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 255) {
    return res.status(400).json({ message: 'A valid email address is required' });
  }
  const { rows } = await pool.query(
    `INSERT INTO google_calendar_notify_emails (organization_id, email, added_by)
     VALUES ($1,$2,$3) ON CONFLICT (organization_id, email) DO NOTHING RETURNING id, email`,
    [req.user.organization_id, email, req.user.id],
  );
  if (!rows[0]) return res.status(409).json({ message: 'This email is already on the list' });
  res.status(201).json({ email: rows[0] });
});

export const removeNotifyEmail = asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM google_calendar_notify_emails WHERE id=$1 AND organization_id=$2',
    [Number(req.params.id) || 0, req.user.organization_id],
  );
  if (!rowCount) return res.status(404).json({ message: 'Email not found' });
  res.json({ success: true });
});
