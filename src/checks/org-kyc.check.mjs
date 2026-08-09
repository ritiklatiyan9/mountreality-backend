/* Run: node src/checks/org-kyc.check.mjs
   `is_complete` is what silences the every-5-minutes reminder, so it is
   computed on the server and asserted here. A field that counts as
   "filled" when it holds only spaces would let a tenant dismiss KYC
   forever with whitespace. */
import assert from 'node:assert/strict';
import { isKycComplete, presentKyc } from '../controllers/orgKyc.controller.js';

const full = {
  company_name: 'Diwan City Developers',
  registered_address: '12 MG Road, Ghaziabad',
  communication_address: '12 MG Road, Ghaziabad',
  director_name: 'R. Latiyan',
  director_phone: '+91 98765 43210',
  status: 'pending',
  registered_lat: '28.6692',
  registered_lng: '77.4538',
};

assert.equal(isKycComplete(full), true);
assert.equal(isKycComplete(null), false, 'no row is not complete');
assert.equal(isKycComplete({}), false);

// Every required field is genuinely required.
for (const field of ['company_name', 'registered_address', 'communication_address', 'director_name', 'director_phone']) {
  assert.equal(isKycComplete({ ...full, [field]: '' }), false, `${field} empty must block`);
  assert.equal(isKycComplete({ ...full, [field]: '   ' }), false, `${field} whitespace must block`);
  assert.equal(isKycComplete({ ...full, [field]: null }), false, `${field} null must block`);
}

// Coordinates are optional — a typed address is what the paperwork needs.
assert.equal(isKycComplete({ ...full, registered_lat: null, registered_lng: null }), true);

// presentKyc: numbers come back as numbers, not pg's numeric strings, or
// the map would receive "28.6692" and Leaflet would place the pin at 0,0.
const shown = presentKyc(full);
assert.equal(typeof shown.registered_lat, 'number');
assert.equal(shown.registered_lat, 28.6692);
assert.equal(shown.is_complete, true);
assert.equal(shown.steps_done, 5);
assert.equal(shown.steps_total, 5);

const partial = presentKyc({ ...full, director_name: '', director_phone: '' });
assert.equal(partial.is_complete, false);
assert.equal(partial.steps_done, 3, 'progress counts filled fields, not steps attempted');

const empty = presentKyc(null);
assert.equal(empty.status, 'pending');
assert.equal(empty.is_complete, false);
assert.equal(empty.steps_done, 0);

console.log('org-kyc ok — completeness ignores whitespace and coordinates are numbers');

// ── GSTIN is optional, but a supplied one must be real ──
const { isValidGstin, normaliseGstin, gstinChecksum } = await import('../utils/gstin.js');

// Verified against the published mod-36 algorithm.
for (const good of ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4', '09AAACH7409R1ZZ']) {
  assert.equal(isValidGstin(good), true, `${good} should be valid`);
  assert.equal(gstinChecksum(good.slice(0, 14)), good[14]);
}

// Normalisation: people paste with spaces and in lower case.
assert.equal(normaliseGstin(' 27aapfu0939f1zv '), '27AAPFU0939F1ZV');
assert.equal(isValidGstin(' 27aapfu0939f1zv '), true);

// A wrong check character is the whole point of computing one — this is a
// single-character edit that every shape-only regex accepts.
assert.equal(isValidGstin('27AAPFU0939F1ZX'), false, 'bad checksum must fail');
// Transposition inside the PAN — same length, same shape, different entity.
assert.equal(isValidGstin('27AAPUF0939F1ZV'), false, 'transposed pair must fail');

assert.equal(isValidGstin('27AAPFU0939F1Z'), false, '14 chars');
assert.equal(isValidGstin('27AAPFU0939F1ZVX'), false, '16 chars');
assert.equal(isValidGstin('27AAPFU0939F1YV'), false, "position 13 must be 'Z'");
assert.equal(isValidGstin('00AAPFU0939F1ZV'), false, 'state code 00 does not exist');
assert.equal(isValidGstin('99AAPFU0939F1ZV'), false, 'state code 99 does not exist');
assert.equal(isValidGstin(''), false);
assert.equal(isValidGstin(null), false);

// And it must NOT affect completeness — plenty of firms are unregistered.
assert.equal(isKycComplete({ ...full, gst_number: null }), true, 'GSTIN is optional');
assert.equal(presentKyc({ ...full, gst_number: null }).steps_done, 5);

console.log('gstin ok — optional, normalised, and checksum-verified');
