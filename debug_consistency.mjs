import pool from './src/config/db.js';

const siteId = 5; // OM ASSOCIATES

// ═══ 1. FARMER PAYMENTS: compare all sources ═══
const fp = await pool.query(`
  SELECT COUNT(*) as cnt, COALESCE(SUM(fp.amount), 0)::numeric as total
  FROM farmer_payments fp
  JOIN farmers f ON f.id = fp.farmer_id
  WHERE f.site_id = $1
    AND (fp.cheque_status IS NULL OR fp.cheque_status NOT IN ('BOUNCED','RETURNED'))
`, [siteId]);
console.log(`farmer_payments table: ₹${parseFloat(fp.rows[0].total).toLocaleString('en-IN')} (${fp.rows[0].cnt} rows)`);

const dbFp = await pool.query(`
  SELECT COUNT(*) as cnt, COALESCE(SUM(debit), 0)::numeric as total
  FROM day_book
  WHERE site_id = $1 AND entry_type = 'FARMER PAYMENT'
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
`, [siteId]);
console.log(`day_book FARMER PAYMENT: ₹${parseFloat(dbFp.rows[0].total).toLocaleString('en-IN')} (${dbFp.rows[0].cnt} rows)`);

const cfeFp = await pool.query(`
  SELECT COUNT(*) as cnt, COALESCE(SUM(debit), 0)::numeric as total
  FROM cash_flow_entries
  WHERE site_id = $1 AND source_module = 'farmer_payments'
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
`, [siteId]);
console.log(`cash_flow_entries source=farmer_payments: ₹${parseFloat(cfeFp.rows[0].total).toLocaleString('en-IN')} (${cfeFp.rows[0].cnt} rows)`);

// ═══ 2. PLOT COMMISSIONS: compare all sources ═══
console.log('\n--- Plot Commissions ---');
const pc = await pool.query(`
  SELECT COUNT(*) as cnt, COALESCE(SUM(pc.amount), 0)::numeric as total
  FROM plot_commissions pc
  WHERE pc.site_id = $1
    AND (pc.cheque_status IS NULL OR pc.cheque_status NOT IN ('BOUNCED','RETURNED'))
`, [siteId]);
console.log(`plot_commissions table: ₹${parseFloat(pc.rows[0].total).toLocaleString('en-IN')} (${pc.rows[0].cnt} rows)`);

const pcp = await pool.query(`
  SELECT COUNT(*) as cnt, COALESCE(SUM(pcp.amount), 0)::numeric as total
  FROM plot_commission_payments pcp
  WHERE pcp.site_id = $1
    AND (pcp.cheque_status IS NULL OR pcp.cheque_status NOT IN ('BOUNCED','RETURNED'))
`, [siteId]);
console.log(`plot_commission_payments table: ₹${parseFloat(pcp.rows[0].total).toLocaleString('en-IN')} (${pcp.rows[0].cnt} rows)`);

const dbPc = await pool.query(`
  SELECT COUNT(*) as cnt, COALESCE(SUM(debit), 0)::numeric as total
  FROM day_book
  WHERE site_id = $1 AND entry_type = 'PLOT COMMISSION'
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
`, [siteId]);
console.log(`day_book PLOT COMMISSION: ₹${parseFloat(dbPc.rows[0].total).toLocaleString('en-IN')} (${dbPc.rows[0].cnt} rows)`);

// ═══ 3. EXPENSES: compare all sources ═══
console.log('\n--- Expenses ---');
const exp = await pool.query(`
  SELECT COUNT(*) as cnt, COALESCE(SUM(debit), 0)::numeric as total
  FROM expenses
  WHERE site_id = $1
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
`, [siteId]);
console.log(`expenses table: ₹${parseFloat(exp.rows[0].total).toLocaleString('en-IN')} (${exp.rows[0].cnt} rows)`);

const dbExp = await pool.query(`
  SELECT COUNT(*) as cnt, COALESCE(SUM(debit), 0)::numeric as total
  FROM day_book
  WHERE site_id = $1 AND entry_type = 'EXPENSE'
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
`, [siteId]);
console.log(`day_book EXPENSE: ₹${parseFloat(dbExp.rows[0].total).toLocaleString('en-IN')} (${dbExp.rows[0].cnt} rows)`);

// ═══ 4. VENDOR PAYMENTS: compare all sources ═══
console.log('\n--- Vendor Payments ---');
const vp = await pool.query(`
  SELECT COUNT(*) as cnt, COALESCE(SUM(amount), 0)::numeric as total
  FROM vendor_payments
  WHERE site_id = $1
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
`, [siteId]);
console.log(`vendor_payments table: ₹${parseFloat(vp.rows[0].total).toLocaleString('en-IN')} (${vp.rows[0].cnt} rows)`);

const dbVp = await pool.query(`
  SELECT COUNT(*) as cnt, COALESCE(SUM(debit), 0)::numeric as total
  FROM day_book
  WHERE site_id = $1 AND entry_type = 'VENDOR PAYMENT'
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
`, [siteId]);
console.log(`day_book VENDOR PAYMENT: ₹${parseFloat(dbVp.rows[0].total).toLocaleString('en-IN')} (${dbVp.rows[0].cnt} rows)`);

// ═══ 5. PLOT REGISTRY PAYMENTS ═══
console.log('\n--- Plot Registry Payments ---');
const prp = await pool.query(`
  SELECT COUNT(*) as cnt, COALESCE(SUM(amount), 0)::numeric as total
  FROM plot_registry_payments
  WHERE site_id = $1
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
`, [siteId]);
console.log(`plot_registry_payments table: ₹${parseFloat(prp.rows[0].total).toLocaleString('en-IN')} (${prp.rows[0].cnt} rows)`);

// ═══ 6. PLOT PAYMENTS (earn) ═══
console.log('\n--- Plot Payments (Earn) ---');
const pp = await pool.query(`
  SELECT COALESCE(SUM(amount), 0)::numeric AS total_earn
  FROM (
    SELECT amount FROM plot_payments WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    UNION ALL
    SELECT amount FROM plot_installment_payments WHERE plot_id IN (SELECT id FROM plots WHERE site_id = $1) AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
  ) u
`, [siteId]);
console.log(`plot_payments+installments: ₹${parseFloat(pp.rows[0].total_earn).toLocaleString('en-IN')}`);

// ═══ 7. What profit-summary CURRENTLY returns ═══
console.log('\n=== CURRENT profit-summary query result (day_book based) ===');
const profitResult = await pool.query(`
  SELECT source_type, COALESCE(SUM(debit), 0)::numeric AS total_debit
  FROM (
    SELECT debit, 'expenses' AS source_type FROM expenses
    WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    UNION ALL
    SELECT amount AS debit, 'plot_registry_payments' AS source_type FROM plot_registry_payments
    WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    UNION ALL
    SELECT debit,
      CASE entry_type
        WHEN 'EXPENSE' THEN 'expenses'
        WHEN 'FARMER PAYMENT' THEN 'farmer_payments'
        WHEN 'PLOT COMMISSION' THEN 'commissions'
        WHEN 'VENDOR PAYMENT' THEN 'vendor_payments'
      END AS source_type
    FROM day_book
    WHERE site_id = $1
      AND entry_type IN ('EXPENSE', 'FARMER PAYMENT', 'PLOT COMMISSION', 'VENDOR PAYMENT')
      AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
  ) u
  GROUP BY source_type
`, [siteId]);
let totalExp = 0;
for (const r of profitResult.rows) {
  const v = parseFloat(r.total_debit);
  totalExp += v;
  console.log(`  ${r.source_type}: ₹${v.toLocaleString('en-IN')}`);
}
console.log(`  TOTAL EXPENSE: ₹${totalExp.toLocaleString('en-IN')}`);

// ═══ 8. What it SHOULD return (source tables) ═══
console.log('\n=== CORRECT profit-summary (source tables) ===');
const correctResult = await pool.query(`
  SELECT source_type, COALESCE(SUM(debit), 0)::numeric AS total_debit
  FROM (
    SELECT fp.amount AS debit, 'farmer_payments' AS source_type
    FROM farmer_payments fp
    JOIN farmers f ON f.id = fp.farmer_id
    WHERE f.site_id = $1
      AND (fp.cheque_status IS NULL OR fp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    UNION ALL
    SELECT debit, 'expenses' AS source_type FROM expenses
    WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    UNION ALL
    SELECT amount AS debit, 'plot_registry_payments' AS source_type FROM plot_registry_payments
    WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    UNION ALL
    SELECT amount AS debit, 'commissions' AS source_type FROM plot_commissions
    WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    UNION ALL
    SELECT amount AS debit, 'commission_payments' AS source_type FROM plot_commission_payments
    WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    UNION ALL
    SELECT amount AS debit, 'vendor_payments' AS source_type FROM vendor_payments
    WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    UNION ALL
    SELECT debit, 'daybook_expense' AS source_type
    FROM day_book
    WHERE site_id = $1 AND entry_type = 'EXPENSE'
      AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
  ) u
  GROUP BY source_type
`, [siteId]);
let correctTotal = 0;
for (const r of correctResult.rows) {
  const v = parseFloat(r.total_debit);
  correctTotal += v;
  console.log(`  ${r.source_type}: ₹${v.toLocaleString('en-IN')}`);
}
console.log(`  TOTAL EXPENSE: ₹${correctTotal.toLocaleString('en-IN')}`);

// ═══ 9. Check day_book EXPENSE duplicate with expenses table ═══
console.log('\n=== day_book EXPENSE overlap check ===');
const dbExpOverlap = await pool.query(`
  SELECT COUNT(*) as total_db_exp,
    COUNT(*) FILTER (WHERE cash_flow_entry_id IS NOT NULL) AS linked_to_cfe,
    COUNT(*) FILTER (WHERE cash_flow_entry_id IS NULL) AS standalone
  FROM day_book
  WHERE site_id = $1 AND entry_type = 'EXPENSE'
`, [siteId]);
console.log(`day_book EXPENSE entries: total=${dbExpOverlap.rows[0].total_db_exp} linked_to_cfe=${dbExpOverlap.rows[0].linked_to_cfe} standalone=${dbExpOverlap.rows[0].standalone}`);

// Check day_book entries that are GENERAL or other standalone types
console.log('\n=== day_book entry_type distribution ===');
const dist = await pool.query(`
  SELECT entry_type, COUNT(*) as cnt, COALESCE(SUM(debit),0)::numeric as total_debit, COALESCE(SUM(credit),0)::numeric as total_credit
  FROM day_book WHERE site_id = $1
  GROUP BY entry_type ORDER BY total_debit DESC
`, [siteId]);
for (const r of dist.rows) {
  console.log(`  ${(r.entry_type || 'NULL').padEnd(25)} ${r.cnt} rows  debit=₹${parseFloat(r.total_debit).toLocaleString('en-IN')}  credit=₹${parseFloat(r.total_credit).toLocaleString('en-IN')}`);
}

pool.end();
