// Quick diagnostic: verify site vs person ledger split
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD != null ? String(process.env.DB_PASSWORD) : '',
  ssl: (process.env.DB_SSL === 'true' || (process.env.DB_HOST && process.env.DB_HOST.includes('neon')))
    ? { rejectUnauthorized: false } : false,
});

const siteId = 2; // Defence Garden

const profitModules = [
  'plot_payments', 'farmer_payments', 'expenses',
  'plot_commissions', 'plot_commission_payments', 'vendor_payments',
];

try {
  // New query: separated by ledger_type
  const result = await pool.query(
    `SELECT
       COALESCE(cfe.source_module, 'direct') AS ledger_source,
       cfm.ledger_type,
       COALESCE(SUM(cfe.credit), 0)::numeric AS total_credit,
       COALESCE(SUM(cfe.debit),  0)::numeric AS total_debit
     FROM cash_flow_entries cfe
     JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
     WHERE cfe.site_id = $1
       AND (cfe.source_module IS NULL OR cfe.source_module NOT IN ($2, $3, $4, $5, $6, $7))
       AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
     GROUP BY COALESCE(cfe.source_module, 'direct'), cfm.ledger_type
     ORDER BY cfm.ledger_type, ledger_source`,
    [siteId, ...profitModules]
  );

  console.log('\n=== LEDGER ENTRIES BY TYPE ===');
  let siteTotalCredit = 0, siteTotalDebit = 0;
  let personTotalCredit = 0, personTotalDebit = 0;

  for (const row of result.rows) {
    const credit = parseFloat(row.total_credit) || 0;
    const debit = parseFloat(row.total_debit) || 0;
    console.log(`  [${row.ledger_type}] ${row.ledger_source}: credit=${credit}, debit=${debit}, net=${credit - debit}`);

    if (row.ledger_type === 'person') {
      personTotalCredit += credit;
      personTotalDebit += debit;
    } else {
      siteTotalCredit += credit;
      siteTotalDebit += debit;
    }
  }

  console.log('\n=== SITE LEDGER (for Dashboard "Ledger Money Flow") ===');
  console.log(`  Money In (credit): ₹${(siteTotalCredit / 100).toFixed(0).replace(/\B(?=(\d{2})+(?!\d))/g, ',')} (raw: ${siteTotalCredit})`);
  console.log(`  Money Out (debit):  ₹${(siteTotalDebit / 100).toFixed(0).replace(/\B(?=(\d{2})+(?!\d))/g, ',')} (raw: ${siteTotalDebit})`);
  console.log(`  Net:                ₹${((siteTotalCredit - siteTotalDebit) / 100).toFixed(0)} (raw: ${siteTotalCredit - siteTotalDebit})`);

  console.log('\n=== PERSON LEDGER (should match Personal Ledger page) ===');
  console.log(`  Given (debit):    ₹${personTotalDebit} (should be 2201100 = ₹22,01,100)`);
  console.log(`  Returned (credit): ₹${personTotalCredit} (should be 1655554 = ₹16,55,554)`);
  console.log(`  Pending:           ₹${personTotalDebit - personTotalCredit} (should be 545546 = ₹5,45,546)`);

  // Also check person ledger via findBySiteId approach
  const personCheck = await pool.query(
    `SELECT
       cfm.ledger_name,
       COALESCE(SUM(CASE WHEN cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED') THEN cfe.debit ELSE 0 END), 0)::numeric AS given,
       COALESCE(SUM(CASE WHEN cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED') THEN cfe.credit ELSE 0 END), 0)::numeric AS returned
     FROM cash_flow_months cfm
     LEFT JOIN cash_flow_entries cfe ON cfe.cash_flow_month_id = cfm.id
     WHERE cfm.site_id = $1 AND cfm.ledger_type = 'person'
     GROUP BY cfm.id, cfm.ledger_name
     ORDER BY cfm.ledger_name`,
    [siteId]
  );

  console.log('\n=== PERSON LEDGER DETAIL (from cash_flow_months) ===');
  let checkGiven = 0, checkReturned = 0;
  for (const row of personCheck.rows) {
    const given = parseFloat(row.given) || 0;
    const returned = parseFloat(row.returned) || 0;
    console.log(`  ${row.ledger_name}: Given=${given}, Returned=${returned}, Pending=${given - returned}`);
    checkGiven += given;
    checkReturned += returned;
  }
  console.log(`  TOTAL: Given=${checkGiven}, Returned=${checkReturned}, Pending=${checkGiven - checkReturned}`);

  console.log('\n=== MATCH CHECK ===');
  console.log(`  Person Given match:    ${personTotalDebit === checkGiven ? '✅ MATCH' : '❌ MISMATCH'} (${personTotalDebit} vs ${checkGiven})`);
  console.log(`  Person Returned match: ${personTotalCredit === checkReturned ? '✅ MATCH' : '❌ MISMATCH'} (${personTotalCredit} vs ${checkReturned})`);

} catch (err) {
  console.error('Error:', err.message);
} finally {
  await pool.end();
}
