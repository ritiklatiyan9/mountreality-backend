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

// ── Wildcard: the whole domain, and nothing that merely looks like it. ──
{
  const mod = await load('https://mountreality.com,https://*.mountreality.com');

  assert.equal(await allows(mod, 'https://mountreality.com'), true, 'apex');
  assert.equal(await allows(mod, 'https://www.mountreality.com'), true);
  assert.equal(await allows(mod, 'https://console.mountreality.com'), true);
  assert.equal(await allows(mod, 'https://api.staging.mountreality.com'), true, 'nested subdomain');
  assert.equal(await allows(mod, 'https://MountReality.com'), true, 'origins are case-insensitive');

  // The substring traps. Each of these contains "mountreality.com" and each
  // is a domain an attacker can register.
  assert.equal(await allows(mod, 'https://evilmountreality.com'), false, 'suffix without the dot');
  assert.equal(await allows(mod, 'https://mountreality.com.evil.com'), false, 'apex as a prefix');
  assert.equal(await allows(mod, 'https://evil.com/.mountreality.com'), false, 'path cannot supply the match');
  assert.equal(await allows(mod, 'https://evil.com#.mountreality.com'), false, 'fragment cannot either');
  assert.equal(await allows(mod, 'https://user@evil.mountreality.com.attacker.io'), false, 'userinfo trick');

  // Scheme and port are part of an origin and are matched literally.
  assert.equal(await allows(mod, 'http://console.mountreality.com'), false, 'http is a different origin');
  assert.equal(await allows(mod, 'https://console.mountreality.com:8443'), false, 'port is part of the origin');

  // A wildcard does not cover its own apex — hence the explicit entry above.
  const bare = await load('https://*.mountreality.com');
  assert.equal(await allows(bare, 'https://mountreality.com'), false, 'wildcard must not imply the apex');
  assert.equal(await allows(bare, 'https://console.mountreality.com'), true);
}

// ── A wildcard stays confined to the pattern it was written in. ──
{
  const mod = await load('https://mountreality-frontend.vercel.app');
  assert.equal(await allows(mod, 'https://mountreality-frontend.vercel.app'), true);
  assert.equal(await allows(mod, 'https://mountreality-frontend-evil.vercel.app'), false);
  assert.equal(await allows(mod, 'https://anything.vercel.app'), false);
}

console.log('cors ok — unset permissive; set matches exact origins and *.domain, and rejects look-alikes');
