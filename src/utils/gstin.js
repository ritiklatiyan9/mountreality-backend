/* ── GSTIN ────────────────────────────────────────────────────────────
   15 characters: 2-digit state code, 10-character PAN, 1 entity code,
   a literal 'Z', then a checksum character.

   The checksum is worth computing rather than only matching the shape:
   a transposed pair inside a 15-character code passes any regex, and a
   wrong GSTIN on an invoice is found by an accountant months later. This
   is the same mod-36 algorithm the GST portal uses. ── */

const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Normalised form: GSTINs are uppercase and carry no spaces. */
export const normaliseGstin = (value) => String(value ?? '').replace(/\s+/g, '').toUpperCase();

export function gstinChecksum(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = CHARSET.indexOf(first14[i]) * (i % 2 ? 2 : 1);
    // Both digits of the product count, base 36.
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36];
}

/** True for a structurally valid GSTIN with a correct check character. */
export function isValidGstin(value) {
  const gstin = normaliseGstin(value);
  if (!SHAPE.test(gstin)) return false;
  // State codes run 01–38 (plus 97 for other territory); 00 is never valid.
  const state = Number(gstin.slice(0, 2));
  if (!((state >= 1 && state <= 38) || state === 97)) return false;
  return gstinChecksum(gstin) === gstin[14];
}
