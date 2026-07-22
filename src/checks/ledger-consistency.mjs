// Ledger consistency invariants. Run: node src/checks/ledger-consistency.mjs
// Exits non-zero on drift. Read-only.
import 'dotenv/config';
import { existsSync } from 'node:fs';
import pool from '../config/db.js';

const SYNCED_TABLES = [
  'farmer_payments', 'plot_commissions', 'plot_commission_payments', 'day_book',
  'firm_transactions', 'plot_payments', 'expenses', 'vendor_payments',
  'plot_installment_payments',
];
const REGISTRY_TABLE = 'plot_registry_payments';
const REGISTRY_SOURCE_MODULES = ['plot_registry_payments', 'plot_registry_payments_person'];

// raw mode -> expected bucket. Rows marked (*) are ones the pre-081 per-module
// CASE blocks disagreed on. Cash is physical cash only; cheque is retained as
// detail, and every other value belongs to the Bank book.
const TRUTH = [
  ['CASH', 'cash'],
  ['cash', 'cash'],
  ['  Cash  ', 'cash'],
  ['CASH IN HAND', 'cash'],      // (*) 7 modules used to call this 'bank'
  ['CHEQUE', 'cheque'],
  ['CHQ', 'cheque'],
  ['Cheque No 4471', 'cheque'],  // (*) 8 modules used to call this 'bank'
  ['BANK', 'bank'],
  ['Bank Transfer', 'bank'],
  ['UPI', 'bank'],
  ['upi - gpay', 'bank'],
  ['GPAY', 'bank'],              // (*) SQL had no UPI-app patterns -> was 'cash'
  ['PhonePe', 'bank'],
  ['NEFT', 'bank'],
  ['RTGS', 'bank'],
  ['IMPS', 'bank'],
  ['ONLINE', 'bank'],
  ['TRANSFER', 'bank'],
  ['', 'bank'],                  // (*) blank split cash/bank by module
  [null, 'bank'],
  ['Other', 'bank'],             // (*) unfamiliar values must remain non-cash
  ['Adjustment', 'bank'],
  ['NON CASH', 'bank'],          // CASH must be an explicit prefix
  ['CASHBACK', 'bank'],
  ['CASH-PAYMENT', 'cash'],
  ['CASH_PAYMENT', 'cash'],
  // Ordering rules, asserted so nobody reorders the CASE arms by accident.
  ['BANK CHEQUE', 'cheque'],     // cheque wins over bank
  ['CASH TO BANK', 'cash'],      // explicit CASH prefix wins over fallback
];

// Storing a bucket and re-classifying it must be a no-op, otherwise a resync
// would walk money between books on every run.
const IDEMPOTENT = ['cash', 'bank', 'cheque'];

const fails = [];
const fail = (msg) => { fails.push(msg); console.error('  FAIL ' + msg); };

// 1. The classifier behaves as documented.
console.log('\n[1] ledger_bucket truth table');
for (const [raw, expected] of TRUTH) {
  const { rows } = await pool.query('SELECT ledger_bucket($1) AS b', [raw]);
  const got = rows[0].b;
  if (got !== expected) fail(`ledger_bucket(${JSON.stringify(raw)}) = ${got}, expected ${expected}`);
}
for (const b of IDEMPOTENT) {
  const { rows } = await pool.query('SELECT ledger_bucket($1) AS b', [b]);
  if (rows[0].b !== b) fail(`ledger_bucket(${b}) = ${rows[0].b} — not idempotent`);
}
console.log(`  ${TRUTH.length} cases + ${IDEMPOTENT.length} idempotency cases checked`);

// The JS copies must agree with SQL or the Day Book and the Balance Sheet
// disagree again. This is the drift that caused the original bug.
console.log('\n[1b] JS classifier agrees with SQL ledger_bucket()');
const { classifyPaymentMode } = await import('../utils/paymentMode.js');
for (const [raw] of TRUTH) {
  const { rows } = await pool.query('SELECT ledger_bucket($1) AS b', [raw]);
  const js = classifyPaymentMode(raw);
  if (js !== rows[0].b) fail(`${JSON.stringify(raw)}: JS=${js} SQL=${rows[0].b}`);
}
console.log(`  ${TRUTH.length} cases agree`);

// The UI keeps its own copy of this rule (separate package, no shared build).
// Skipped when the frontend isn't checked out beside the backend.
console.log('\n[1c] frontend classifier agrees with SQL');
const uiPath = new URL('../../../rgaccount/src/utils/paymentMode.js', import.meta.url);
if (existsSync(uiPath)) {
  const ui = await import(uiPath.href);
  for (const [raw] of TRUTH) {
    const { rows } = await pool.query('SELECT ledger_bucket($1) AS b', [raw]);
    const got = ui.classifyPaymentMode(raw);
    if (got !== rows[0].b) fail(`${JSON.stringify(raw)}: frontend=${got} SQL=${rows[0].b}`);
  }
  const uiBuckets = [...ui.BUCKETS].sort().join(',');
  if (uiBuckets !== [...IDEMPOTENT].sort().join(',')) {
    fail(`frontend BUCKETS [${uiBuckets}] != backend [${IDEMPOTENT.join(',')}]`);
  }
  console.log(`  ${TRUTH.length} cases agree, BUCKETS match`);
} else {
  console.log('  skipped — frontend not present');
}

// 2. Regression guard. 076 and 080 both reintroduced per-module inline CASE
// blocks; that is what let the buckets drift apart. Every module must classify
// through the one shared function.
console.log('\n[2] no per-module classifier has crept back');
const { rows: fn } = await pool.query(
  `SELECT pg_get_functiondef(oid) AS def FROM pg_proc WHERE proname = 'sync_cashflow_from_modules' LIMIT 1`
);
if (!fn.length) {
  fail('sync_cashflow_from_modules() is missing');
} else {
  const inlineCase = (fn[0].def.match(/v_cash_type\s*:=\s*CASE/g) || []).length;
  const viaFn = (fn[0].def.match(/v_cash_type\s*:=\s*ledger_bucket\(/g) || []).length;
  if (inlineCase > 0) fail(`${inlineCase} inline "v_cash_type := CASE" block(s) — must call ledger_bucket()`);
  if (viaFn !== SYNCED_TABLES.length) {
    fail(`${viaFn} ledger_bucket() call(s), expected ${SYNCED_TABLES.length} (one per module)`);
  }
  console.log(`  ${viaFn} modules classify via ledger_bucket(), ${inlineCase} inline`);
}

// 2b. There are exactly TWO books: Cash holds physical cash, Bank holds
// everything else (bank, UPI, IMPS, NEFT, cheque, blank/unrecognised). Asserted here
// because three separate places encode it — BalanceSheet's bucket CASE,
// CashFlow.model's `<> 'cash'` filters, and NON_CASH_BUCKETS in the UI.
console.log('\n[2b] two books: cash vs everything else');
for (const t of IDEMPOTENT) {
  const { rows } = await pool.query(
    `SELECT CASE WHEN ledger_bucket($1) = 'cash' THEN 'cash' ELSE 'bank' END AS book`,
    [t]
  );
  const expected = t === 'cash' ? 'cash' : 'bank';
  if (rows[0].book !== expected) fail(`${t} lands in the ${rows[0].book} book, expected ${expected}`);
}
if (existsSync(uiPath)) {
  const ui = await import(uiPath.href);
  const expected = IDEMPOTENT.filter((b) => b !== 'cash').sort().join(',');
  const got = [...ui.NON_CASH_BUCKETS].sort().join(',');
  if (got !== expected) fail(`UI NON_CASH_BUCKETS [${got}] != [${expected}]`);
}
console.log(`  cash -> Cash book; ${IDEMPOTENT.length - 1} other type(s) -> Bank book`);

// 3. Every financial module has its sync trigger. Registry mapping records must
// never have one because they do not represent a new cash movement.
console.log('\n[3] sync triggers present');
const { rows: trg } = await pool.query(
  `SELECT c.relname AS tbl FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_proc  p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal AND p.proname = 'sync_cashflow_from_modules'`
);
const haveTrg = new Set(trg.map((r) => r.tbl));
for (const t of SYNCED_TABLES) if (!haveTrg.has(t)) fail(`no sync trigger on ${t}`);
if (haveTrg.has(REGISTRY_TABLE)) fail(`forbidden sync trigger on ${REGISTRY_TABLE}`);
const expectedTriggerCount = SYNCED_TABLES.filter((t) => haveTrg.has(t)).length;
console.log(`  ${expectedTriggerCount}/${SYNCED_TABLES.length} financial triggers present; registry neutral`);

// 3b. Registry rows only map an existing plot payment to paperwork. Historical
// main/person CFE mirrors would double count that money and must be absent.
console.log('\n[3b] registry mappings have no cash-flow mirrors');
const { rows: registryCfe } = await pool.query(
  `SELECT COUNT(*)::int AS n,
          COALESCE(SUM(debit), 0) AS debit,
          COALESCE(SUM(credit), 0) AS credit
     FROM cash_flow_entries
    WHERE source_module = ANY($1::text[])`,
  [REGISTRY_SOURCE_MODULES]
);
if (registryCfe[0].n > 0) {
  fail(
    `${registryCfe[0].n} forbidden registry CFE row(s) ` +
    `(debit ${registryCfe[0].debit}, credit ${registryCfe[0].credit})`
  );
} else {
  console.log('  no registry cash-flow rows');
}

// 4. Scope partition — cash + bank + cheque must account for every entry.
console.log('\n[4] bucket partition covers every entry');
const { rows: part } = await pool.query(
  `SELECT COALESCE(cash_type, '<null>') AS bucket, COUNT(*)::int AS n,
          COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
     FROM cash_flow_entries GROUP BY 1 ORDER BY 1`
);
if (part.length) console.table(part);
const stray = part.filter((r) => !IDEMPOTENT.includes(r.bucket));
for (const s of stray) fail(`${s.n} entries in unrecognised bucket "${s.bucket}"`);
console.log(`  ${part.reduce((a, r) => a + r.n, 0)} entries, ${stray.length} stray`);

// 5. Quarantine — surfaced, never silently corrected. A typo'd year like 20222
// passes a bare ">= 1900-01-01" guard, so engines using one disagree with
// engines using BETWEEN.
console.log('\n[5] quarantine (out-of-range dates — needs a human)');
const { rows: bad } = await pool.query(
  `SELECT id, site_id, date, source_module, source_id, debit, credit
     FROM cash_flow_entries
    WHERE date < DATE '1900-01-01' OR date > DATE '2100-12-31'
    ORDER BY date LIMIT 50`
);
if (bad.length) { console.table(bad); console.log(`  ${bad.length} row(s) need fixing at source`); }
else console.log('  none');

await pool.end();

if (fails.length) {
  console.error(`\n${fails.length} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll ledger consistency checks passed');
