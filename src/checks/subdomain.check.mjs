/* Run: node src/checks/subdomain.check.mjs
   The slug becomes a live hostname the moment it is written — there is no
   review step between signup and {slug}.mountreality.com resolving — so
   the rules are asserted here rather than discovered in DNS. */
import assert from 'node:assert/strict';
import { RESERVED_SUBDOMAINS, isValidSubdomain, slugify } from '../utils/subdomain.js';

// ── slugify: company names as people actually type them ──
assert.equal(slugify('Diwan City'), 'diwan-city');
assert.equal(slugify('  Diwan   City  Developers  '), 'diwan-city-developers');
assert.equal(slugify('R.G. Estates & Sons Pvt. Ltd.'), 'r-g-estates-sons-pvt-ltd');
assert.equal(slugify('Café Real Estate'), 'cafe-real-estate');
assert.equal(slugify('मेरा शहर'), '', 'non-latin yields empty — caller falls back');
assert.equal(slugify('!!!'), '');
assert.equal(slugify(null), '');
// 40-char cap never leaves a trailing hyphen behind
const long = slugify('a'.repeat(39) + ' b c d');
assert.ok(long.length <= 40 && !long.endsWith('-'), `bad truncation: ${long}`);

// ── validation: exactly one DNS label ──
assert.equal(isValidSubdomain('diwancity'), true);
assert.equal(isValidSubdomain('diwan-city-2'), true);
assert.equal(isValidSubdomain('a'), false, 'single char is too easy to typo-squat');
assert.equal(isValidSubdomain('-diwan'), false, 'no leading hyphen');
assert.equal(isValidSubdomain('diwan-'), false, 'no trailing hyphen');
assert.equal(isValidSubdomain('diwan.city'), false, 'one label only — a dot would mint a deeper zone');
assert.equal(isValidSubdomain('Diwan City'), false);
assert.equal(isValidSubdomain('a'.repeat(64)), false, 'DNS label limit is 63');
assert.equal(isValidSubdomain(42), false);

// ── reserved names are invalid regardless of shape ──
for (const name of ['www', 'console', 'api', 'owner', 'mountreality']) {
  assert.ok(RESERVED_SUBDOMAINS.has(name), `${name} must be reserved`);
  assert.equal(isValidSubdomain(name), false, `${name} must not validate`);
}
// slugify can produce a reserved word — the generator must catch it, so the
// word itself has to be flagged, not silently allowed through validation.
assert.equal(slugify('Console'), 'console');
assert.equal(isValidSubdomain(slugify('Console')), false);

console.log('subdomain ok — slugs are single DNS labels and reserved names stay reserved');
