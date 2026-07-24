import 'dotenv/config';
import jwt from 'jsonwebtoken';
import pool from './src/config/db.js';

// 1. Direct DB query
console.log('=== DIRECT DB ===');
const { rows: dbKpi } = await pool.query(`
  SELECT 'farmer_payments' as src, COALESCE(SUM(fp.amount),0)::numeric as total
  FROM farmer_payments fp JOIN farmers f ON f.id = fp.farmer_id
  WHERE f.site_id = 5
    AND (fp.cheque_status IS NULL OR fp.cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT 'expenses', COALESCE(SUM(debit),0)::numeric
  FROM expenses WHERE site_id = 5
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT 'commission_payments', COALESCE(SUM(amount),0)::numeric
  FROM plot_commission_payments WHERE site_id = 5
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT 'vendor_payments', COALESCE(SUM(amount),0)::numeric
  FROM vendor_payments WHERE site_id = 5
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT 'personal_ledger_debit', COALESCE(SUM(cfe.debit),0)::numeric
  FROM cash_flow_entries cfe
  JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
  WHERE cfe.site_id = 5 AND LOWER(cfm.ledger_type) = 'person' AND cfe.debit > 0
    AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT 'plot_payments', COALESCE(SUM(amount),0)::numeric
  FROM plot_payments WHERE site_id = 5
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT 'outstanding_given', COALESCE(SUM(cfe.debit),0)::numeric
  FROM cash_flow_entries cfe
  JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
  WHERE cfe.site_id = 5 AND LOWER(cfm.ledger_type) = 'person'
    AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT 'outstanding_returned', COALESCE(SUM(cfe.credit),0)::numeric
  FROM cash_flow_entries cfe
  JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
  WHERE cfe.site_id = 5 AND LOWER(cfm.ledger_type) = 'person'
    AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
`);
for (const r of dbKpi) console.log(`  ${r.src}: ${r.total}`);

// 2. Test via GraphQL endpoint
console.log('\n=== GRAPHQL API ===');
const token = jwt.sign({ id: 1, role: 'admin', site_id: 5 }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
const query = JSON.stringify({
  query: `{
    kpiCards(siteId: "5", range: { start: "2000-01-01", end: "2027-01-01" }) {
      totalRevenue totalExpense netProfit outstanding
      breakdown { module debit credit count }
      outstandingDetail { given returned pending }
    }
  }`
});

try {
  const resp = await fetch('http://localhost:80000/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: query,
  });
  const data = await resp.json();
  if (data.errors) {
    console.log('ERRORS:', JSON.stringify(data.errors, null, 2));
  } else {
    const k = data.data.kpiCards;
    console.log('  totalRevenue:', k.totalRevenue);
    console.log('  totalExpense:', k.totalExpense);
    console.log('  netProfit:', k.netProfit);
    console.log('  outstanding:', k.outstanding);
    console.log('  breakdown:');
    for (const b of k.breakdown) console.log(`    ${b.module}: debit=${b.debit} credit=${b.credit} count=${b.count}`);
    console.log('  outstandingDetail:', k.outstandingDetail);
  }
} catch (e) {
  console.log('FETCH ERROR:', e.message);
}

pool.end();
process.exit(0);
