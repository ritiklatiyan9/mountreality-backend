/* ── Allowed browser origins ──────────────────────────────────────────
   One list, read by both the HTTP app and the socket server, so a new
   front-end origin can never be allowed on one and refused on the other
   — which is the failure that makes "the app loads but nothing updates
   live" so hard to diagnose.

   CORS_ORIGINS is a comma-separated allowlist, e.g.

     CORS_ORIGINS=https://mountreality.com,https://console.mountreality.com

   Unset, this stays permissive. That is deliberate: it is what the API
   already did, and silently locking out a live front end is a worse
   failure than staying where we were. It warns once on boot instead, so
   an unconfigured production is visible rather than assumed.

   Note this is a browser-enforced boundary, not an authorisation one. It
   stops another site's JavaScript reading your responses; it does not
   stop curl. Authorisation still has to hold on its own. ── */

const configured = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

export const ALLOWED_ORIGINS = configured;
export const isRestricted = configured.length > 0;

export function isOriginAllowed(origin) {
  // No Origin header at all: same-origin navigation, curl, server-to-server,
  // health checks. Not a cross-origin request, so there is nothing to refuse.
  if (!origin) return true;
  if (!isRestricted) return true;
  return configured.includes(origin);
}

/* Rejection resolves false rather than throwing: an Error here would land
   in the express error handler and answer a disallowed origin with a 500,
   which reads like an outage. Omitting the headers is the correct answer —
   the browser blocks the read, and the log line says why. */
export const corsOptions = {
  origin(origin, callback) {
    if (isOriginAllowed(origin)) return callback(null, true);
    console.warn(`[cors] refused origin: ${origin}`);
    return callback(null, false);
  },
  credentials: true,
};

export const socketCorsOptions = {
  origin(origin, callback) {
    if (isOriginAllowed(origin)) return callback(null, true);
    console.warn(`[cors] refused socket origin: ${origin}`);
    return callback(null, false);
  },
  methods: ['GET', 'POST'],
  credentials: true,
};

export function logCorsPolicy() {
  if (isRestricted) {
    console.log(`[cors] restricted to: ${configured.join(', ')}`);
  } else {
    console.warn('[cors] CORS_ORIGINS is not set — every origin is allowed. Set it in production.');
  }
}
