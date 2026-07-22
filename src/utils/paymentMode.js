// Canonical payment-mode bucketing.
//
// MUST stay in lockstep with two other copies of this rule:
//   - SQL  ledger_bucket()                    (migration 081)
//   - UI   rgaccount/src/utils/paymentMode.js (identical file)
// Three implementations drifting apart is what put 'CASH IN HAND' in the bank
// book and classified 'GPAY' as cash. Change one, change all three, then run
// `npm run check:ledger`.
//
// POLICY (owner, 2026-07-22). There are two accounting books: Cash and Bank.
// Cheque remains a detail bucket for cheque lifecycle/reporting, but belongs to
// the Bank book. Only an explicit CASH-prefixed mode is physical cash; every
// other value (including blank/unrecognised modes) is non-cash and therefore
// belongs to Bank. This makes Cash + Bank exhaustive for every ledger row.

const BUCKETS = ['cash', 'bank', 'cheque'];

// Matches CASH, CASH IN HAND, CASH-PAYMENT and CASH_PAYMENT without treating
// unrelated values such as CASHBACK or NON CASH as physical cash.
const CASH_PATTERN = /^CASH(?:[\s_-]|$)/;

// Returns one of: 'cash' | 'bank' | 'cheque'. Check order matches the SQL
// ledger_bucket() exactly: cheque detail wins first, explicit cash is next, and
// the exhaustive fallback is bank.
export function classifyPaymentMode(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  if (s.includes('CHEQUE') || s.includes('CHQ')) return 'cheque';
  if (CASH_PATTERN.test(s)) return 'cash';
  return 'bank';
}

// What the write path stores in cash_flow_entries.cash_type. Deliberately the
// same function reads use, so a value cannot mean one thing when written and
// another when read. Create and update previously held two different
// allow-lists — create accepted 'cheque', update did not — so editing a cheque
// entry silently rewrote it to 'bank' and lost the cheque.
export const normalizeCashType = classifyPaymentMode;

export function emptyBucketMap() {
  const m = {};
  for (const k of BUCKETS) m[k] = { credit: 0, debit: 0 };
  return m;
}

export { BUCKETS };
