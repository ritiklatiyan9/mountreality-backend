import crypto from 'crypto';

/**
 * Public-facing verify page URL. QR on the printed receipt links here so a
 * scanner lands on a human-friendly page (not raw API JSON).
 * Override via env: PUBLIC_VERIFY_URL=https://www.your-site.com/verify-receipt
 */
const PUBLIC_VERIFY_URL =
  process.env.PUBLIC_VERIFY_URL || 'http://localhost:5173/verify-receipt';

/**
 * Receipt-type codes. Short strings keep the QR payload small.
 *   FRM  Farmer Payment
 *   VND  Vendor Payment
 *   PLT  Plot Payment (Registry / Plot Payments)
 *   CMN  Plot Commission
 *   EXP  Expense / Voucher
 *   DBK  DayBook Entry (Personal Ledger)
 *   IMP  Imprest Ledger
 */
export const ReceiptType = {
  FARMER: 'FRM',
  VENDOR: 'VND',
  PLOT: 'PLT',
  COMMISSION: 'CMN',
  EXPENSE: 'EXP',
  DAYBOOK: 'DBK',
  IMPREST: 'IMP',
  NOC: 'NOC',
};

/**
 * Sign a receipt payload with HMAC-SHA256 and wrap it in a base64url envelope.
 * Caller should pass only fields needed for display on the verify page — the
 * smaller the payload, the fewer QR modules, the easier the scan.
 */
export function signReceiptToken(payload) {
  const sig = crypto
    .createHmac('sha256', process.env.RECEIPT_VERIFY_SECRET || '')
    .update(JSON.stringify(payload))
    .digest('hex');
  return Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url');
}

/**
 * Build a full verify URL for a given payload.
 */
export function buildVerifyUrl(payload) {
  return `${PUBLIC_VERIFY_URL}?token=${signReceiptToken(payload)}`;
}

/**
 * Verify a signed token. Returns { valid, payload } or { valid: false, reason }.
 */
export function verifyReceiptToken(token) {
  try {
    if (!token) return { valid: false, reason: 'Missing token' };
    const decoded = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
    const payload = decoded?.p;
    const sig = decoded?.s;
    if (!payload || !sig) return { valid: false, reason: 'Malformed token' };

    const expectedSig = crypto
      .createHmac('sha256', process.env.RECEIPT_VERIFY_SECRET || '')
      .update(JSON.stringify(payload))
      .digest('hex');

    const sigBuf = Buffer.from(String(sig), 'hex');
    const expBuf = Buffer.from(expectedSig, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { valid: false, reason: 'Invalid or tampered receipt' };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false, reason: 'Malformed token' };
  }
}
