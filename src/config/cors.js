/* ── Allowed browser origins ──────────────────────────────────────────
   One list, read by both the HTTP app and the socket server, so a new
   front-end origin can never be allowed on one and refused on the other
   — which is the failure that makes "the app loads but nothing updates
   live" so hard to diagnose.

   CORS_ORIGINS is a comma-separated allowlist. Entries are exact origins,
   and `*` may stand in for one or more host labels:

     CORS_ORIGINS=https://mountreality.com,https://*.mountreality.com

   That pair is the whole domain: the apex plus every subdomain under it.
   The apex needs its own entry — `*.mountreality.com` deliberately does
   NOT match `mountreality.com`, the same way a wildcard TLS certificate
   does not cover its own apex.

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

/* One or more host labels — letters, digits and hyphens, dot-separated.
   Deliberately excludes `/`, `:` and `@`, so a wildcard can never eat a
   path, a port or credentials and let `https://evil.com/x.mountreality.com`
   through. */
const LABELS = '[a-z0-9-]+(?:\\.[a-z0-9-]+)*';

/* Substring matching is the trap here: `endsWith('mountreality.com')`
   also accepts `evilmountreality.com`, and `includes()` accepts
   `mountreality.com.evil.com`. Each pattern is compiled to an ANCHORED
   regex with every literal escaped, so a match has to span the entire
   origin and the wildcard can only ever stand where a `*` was written. */
const toMatcher = (pattern) => {
  const lower = pattern.toLowerCase();
  if (!lower.includes('*')) return (origin) => origin === lower;

  const source = lower
    .split('*')
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join(LABELS);
  const re = new RegExp(`^${source}$`);
  return (origin) => re.test(origin);
};

const matchers = configured.map(toMatcher);

export const ALLOWED_ORIGINS = configured;
export const isRestricted = configured.length > 0;

export function isOriginAllowed(origin) {
  // No Origin header at all: same-origin navigation, curl, server-to-server,
  // health checks. Not a cross-origin request, so there is nothing to refuse.
  if (!origin) return true;
  if (!isRestricted) return true;
  const candidate = origin.toLowerCase();
  return matchers.some((match) => match(candidate));
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
