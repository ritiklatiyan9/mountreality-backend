import pool from './src/config/db.js';

const siteId = 5;

// ALL registry CFE entries
const r1 = await pool.query(`
  SELECT COUNT(*) AS cnt, COALESCE(SUM(debit),0)::numeric AS total_debit
  FROM cash_flow_entries
  WHERE site_id = $1 AND source_module = 'plot_registry_payments'
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
`, [siteId]);
console.log('ALL registry CFE entries:', r1.rows[0]);

// LINKED (source_plot_payment_id IS NOT NULL)
const r2 = await pool.query(`
  SELECT COUNT(*) AS cnt, COALESCE(SUM(cfe.debit),0)::numeric AS total_debit
  FROM cash_flow_entries cfe
  JOIN plot_registry_payments prp ON prp.id = cfe.source_id
  WHERE cfe.site_id = $1 AND cfe.source_module = 'plot_registry_payments'
    AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
    AND prp.source_plot_payment_id IS NOT NULL
`, [siteId]);
console.log('LINKED registry CFE (should be excluded):', r2.rows[0]);

// MANUAL only
const r3 = await pool.query(`
  SELECT COUNT(*) AS cnt, COALESCE(SUM(cfe.debit),0)::numeric AS total_debit
  FROM cash_flow_entries cfe
  JOIN plot_registry_payments prp ON prp.id = cfe.source_id
  WHERE cfe.site_id = $1 AND cfe.source_module = 'plot_registry_payments'
    AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
    AND prp.source_plot_payment_id IS NULL
`, [siteId]);
console.log('MANUAL registry CFE (should be included):', r3.rows[0]);

// Current Run A expense total
const rA = await pool.query(`
  SELECT COALESCE(SUM(debit), 0)::numeric AS total
  FROM (
    SELECT fp.amount AS debit FROM farmer_payments fp
    JOIN farmers f ON f.id = fp.farmer_id
    WHERE f.site_id = $1 AND (fp.cheque_status IS NULL OR fp.cheque_status NOT IN ('BOUNCED','RETURNED'))
    UNION ALL
    SELECT debit FROM expenses WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
    UNION ALL
    SELECT amount AS debit FROM plot_registry_payments WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED')) AND source_plot_payment_id IS NULL
    UNION ALL
    SELECT amount AS debit FROM plot_commissions WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
    UNION ALL
    SELECT amount AS debit FROM plot_commission_payments WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
    UNION ALL
    SELECT amount AS debit FROM vendor_payments WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  ) u
`, [siteId]);
console.log('Run A total expense (source):', rA.rows[0]);

// Current Run B expense total
const profitModules = [
  'plot_payments', 'plot_installment_payments',
  'farmer_payments', 'expenses',
  'plot_commissions', 'plot_commission_payments',
  'vendor_payments', 'plot_registry_payments',
];
const placeholders = profitModules.map((_, i) => `$${i + 2}`).join(', ');
const rB = await pool.query(`
  SELECT COALESCE(SUM(debit), 0)::numeric AS total_debit
  FROM cash_flow_entries
  WHERE site_id = $1
    AND source_module IN (${placeholders})
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
`, [siteId, ...profitModules]);
console.log('Run B total expense (CFE, all modules):', rB.rows[0]);

// Run B expense excluding linked registry
const rBFixed = await pool.query(`
  SELECT COALESCE(SUM(cfe.debit), 0)::numeric AS total_debit
  FROM cash_flow_entries cfe
  WHERE cfe.site_id = $1
    AND cfe.source_module IN (${placeholders})
    AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
    AND NOT (cfe.source_module = 'plot_registry_payments' AND EXISTS (
      SELECT 1 FROM plot_registry_payments prp
      WHERE prp.id = cfe.source_id AND prp.source_plot_payment_id IS NOT NULL
    ))
`, [siteId, ...profitModules]);
console.log('Run B total expense (CFE, FIXED excl linked):', rBFixed.rows[0]);

console.log('\nDelta (linked CFE):', (parseFloat(r2.rows[0].total_debit)).toLocaleString('en-IN'));

await pool.end();
