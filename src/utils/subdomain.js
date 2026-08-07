/* ── Tenant subdomains ────────────────────────────────────────────────
   Every organization gets a slug that becomes {slug}.mountreality.com.
   DNS needs nothing per tenant — *.mountreality.com already points at the
   front end — so "creating" a domain is only ever a row in this table.

   One DNS label, nothing else: 63 chars max, lowercase alphanumerics and
   inner hyphens. The reserved list keeps a tenant from ever occupying a
   name the platform itself needs (or will plausibly need — reserving is
   free, un-reserving a squatted name is not). ── */

export const RESERVED_SUBDOMAINS = new Set([
  'www', 'console', 'api', 'app', 'admin', 'owner', 'mail', 'smtp', 'ftp',
  'staging', 'dev', 'test', 'demo', 'preview', 'docs', 'blog', 'help',
  'support', 'status', 'cdn', 'assets', 'static', 'billing', 'pay',
  'mountreality', 'vercel', 'ns1', 'ns2',
]);

/** Company name → candidate slug. Returns '' when nothing usable survives. */
export function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')                 // strip accents: Café → Cafe
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)                      // leave room for a -N suffix under 63
    .replace(/-+$/g, '');
}

/** Valid single DNS label that is not reserved. */
export function isValidSubdomain(value) {
  if (typeof value !== 'string') return false;
  const v = value.toLowerCase();
  if (v.length < 2 || v.length > 63) return false;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(v)) return false;
  return !RESERVED_SUBDOMAINS.has(v);
}

/* One trip instead of probe-per-candidate: read every taken slug on this
   stem, then pick the first free of base, base-2, base-3… The unique
   index is the backstop for the tiny window between read and write. */
export async function generateUniqueSubdomain(client, companyName) {
  let base = slugify(companyName);
  if (!base || base.length < 2 || RESERVED_SUBDOMAINS.has(base)) base = `org-${Date.now().toString(36)}`;

  const { rows } = await client.query(
    `SELECT subdomain FROM organizations WHERE subdomain = $1 OR subdomain LIKE $2`,
    [base, `${base}-%`]
  );
  const taken = new Set(rows.map((r) => r.subdomain));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
