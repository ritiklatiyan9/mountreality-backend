/* Run: node src/checks/cors-allowlist.mjs
   The allowlist decides whether a second front-end origin can talk to the
   API at all, and a mistake here fails in the browser rather than in a
   log — so the branches are asserted directly.

   Each case re-imports the module with a cache-busting query, because the
   allowlist is read from the environment once at module load. */
import assert from 'node:assert/strict';

const load = async (value) => {
  if (value === undefined) delete process.env.CORS_ORIGINS;
  else process.env.CORS_ORIGINS = value;
  return import(`../config/cors.js?case=${encodeURIComponent(String(value))}`);
};

const allows = (mod, origin) => new Promise((resolve) => {
  mod.corsOptions.origin(origin, (_err, ok) => resolve(ok));
});

// ── Unset: permissive, exactly as the API behaved before. ──
{
  const mod = await load(undefined);
  assert.equal(mod.isRestricted, false);
  assert.equal(await allows(mod, 'https://anything.example'), true, 'unset must not lock anyone out');
  assert.equal(await allows(mod, undefined), true, 'no Origin header is not a cross-origin request');
}

// ── Set: only the listed origins, and the split is the point. ──
{
  const mod = await load('https://mountreality.com,https://console.mountreality.com');
  assert.equal(mod.isRestricted, true);
  assert.deepEqual(mod.ALLOWED_ORIGINS, ['https://mountreality.com', 'https://console.mountreality.com']);
  assert.equal(await allows(mod, 'https://mountreality.com'), true);
  assert.equal(await allows(mod, 'https://console.mountreality.com'), true);
  assert.equal(await allows(mod, undefined), true, 'curl and health checks still pass');

  assert.equal(await allows(mod, 'https://evil.example'), false);
  // A look-alike host must not pass on a prefix or suffix match.
  assert.equal(await allows(mod, 'https://mountreality.com.evil.example'), false);
  assert.equal(await allows(mod, 'https://notmountreality.com'), false);
  // Scheme and port are part of an origin: http is not https.
  assert.equal(await allows(mod, 'http://mountreality.com'), false);
  // A sibling subdomain is a different origin and is not implied by the apex.
  assert.equal(await allows(mod, 'https://staging.mountreality.com'), false);
}

// ── Whitespace and trailing commas in the env value are tolerated. ──
{
  const mod = await load(' https://a.example , https://b.example ,');
  assert.deepEqual(mod.ALLOWED_ORIGINS, ['https://a.example', 'https://b.example']);
  assert.equal(await allows(mod, 'https://b.example'), true);
}

console.log('cors ok — unset stays permissive, set is an exact-origin allowlist');
