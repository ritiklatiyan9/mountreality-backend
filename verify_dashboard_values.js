import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_HOST?.includes('neon') ? { rejectUnauthorized: false } : false,
});

const SITE_ID = 2;
const fmt = (n) => new Intl.NumberFormat('en-IN').format(n);

async function main() {
  console.log('=== VERIFYING DASHBOARD VALUES vs MODULE PAGES ===\n');

  // ─── 1. Personal Ledger: What the module page shows ───
  console.log('━━━ PERSONAL LEDGER (Module Page Query) ━━━');
  const personModulePage = await pool.query(`
    SELECT cfm.ledger_name,
      COALESCE(SUM(cfe.debit), 0) AS given,
      COALESCE(SUM(cfe.credit), 0) AS returned
    FROM cash_flow_months cfm
    JOIN cash_flow_entries cfe ON cfe.cash_flow_month_id = cfm.id
    WHERE cfm.site_id = $1 AND cfm.ledger_type = 'person'
      AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    GROUP BY cfm.ledger_name
    ORDER BY cfm.ledger_name
  `, [SITE_ID]);
  
  let pgGiven = 0, pgReturned = 0;
  for (const r of personModulePage.rows) {
    const g = parseFloat(r.given);
    const ret = parseFloat(r.returned);
    pgGiven += g;
    pgReturned += ret;
    console.log(`  ${r.ledger_name}: Given=₹${fmt(g)}  Returned=₹${fmt(ret)}  Pending=₹${fmt(g - ret)}`);
  }
  console.log(`  TOTAL: Given=₹${fmt(pgGiven)}  Returned=₹${fmt(pgReturned)}  Pending=₹${fmt(pgGiven - pgReturned)}\n`);

  // ─── 2. Personal Ledger: What the dashboard computes ───
  console.log('━━━ PERSONAL LEDGER (Dashboard Query) ━━━');
  const profitModules = ['plot_payments', 'farmer_payments', 'expenses', 'plot_commissions', 'plot_commission_payments', 'vendor_payments'];
  const dashPersonResult = await pool.query(`
    SELECT
      COALESCE(SUM(cfe.debit), 0) AS person_given,
      COALESCE(SUM(cfe.credit), 0) AS person_returned
    FROM cash_flow_entries cfe
    JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
    WHERE cfe.site_id = $1
      AND cfm.ledger_type = 'person'
      AND (cfe.source_module IS NULL OR cfe.source_module NOT IN ($2,$3,$4,$5,$6,$7))
      AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
  `, [SITE_ID, ...profitModules]);
  const dpg = parseFloat(dashPersonResult.rows[0].person_given);
  const dpr = parseFloat(dashPersonResult.rows[0].person_returned);
  console.log(`  Given=₹${fmt(dpg)}  Returned=₹${fmt(dpr)}  Pending=₹${fmt(dpg - dpr)}`);
  console.log(`  MATCH: ${pgGiven === dpg && pgReturned === dpr ? '✅ YES' : '❌ NO'}\n`);

  // Check: are there person-ledger entries WITH profit source_modules being excluded?
  const personExcluded = await pool.query(`
    SELECT cfe.source_module, COUNT(*) as cnt, 
      COALESCE(SUM(cfe.debit),0) AS debit, COALESCE(SUM(cfe.credit),0) AS credit
    FROM cash_flow_entries cfe
    JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
    WHERE cfe.site_id = $1 AND cfm.ledger_type = 'person'
      AND cfe.source_module IN ($2,$3,$4,$5,$6,$7)
      AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    GROUP BY cfe.source_module
  `, [SITE_ID, ...profitModules]);
  if (personExcluded.rows.length > 0) {
    console.log('  ⚠️  Person-ledger entries EXCLUDED by dashboard (profit modules):');
    for (const r of personExcluded.rows) {
      console.log(`    source_module=${r.source_module}: count=${r.cnt}, debit=₹${fmt(parseFloat(r.debit))}, credit=₹${fmt(parseFloat(r.credit))}`);
    }
    console.log();
  }

  // ─── 3. Firm Transactions: What the module page shows ───
  console.log('━━━ FIRM TRANSACTIONS (Module Page Query) ━━━');
  const firmModulePage = await pool.query(`
    SELECT f.name,
      COALESCE((SELECT SUM(ft.debit) FROM firm_transactions ft WHERE ft.firm_id = f.id AND (ft.cheque_status IS NULL OR ft.cheque_status NOT IN ('BOUNCED','RETURNED'))), 0)
        + COALESCE((SELECT SUM(COALESCE(cfe.debit,0) + COALESCE(cfe.credit,0)) FROM cash_flow_entries cfe WHERE cfe.from_firm_id = f.id AND cfe.is_firm_transaction = true AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))), 0)
        AS total_debit,
      COALESCE((SELECT SUM(ft.credit) FROM firm_transactions ft WHERE ft.firm_id = f.id AND (ft.cheque_status IS NULL OR ft.cheque_status NOT IN ('BOUNCED','RETURNED'))), 0)
        + COALESCE((SELECT SUM(COALESCE(cfe.debit,0) + COALESCE(cfe.credit,0)) FROM cash_flow_entries cfe WHERE cfe.to_firm_id = f.id AND cfe.is_firm_transaction = true AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))), 0)
        AS total_credit
    FROM firms f WHERE f.site_id = $1 ORDER BY f.name
  `, [SITE_ID]);

  let fmDebit = 0, fmCredit = 0;
  for (const r of firmModulePage.rows) {
    const d = parseFloat(r.total_debit);
    const c = parseFloat(r.total_credit);
    fmDebit += d;
    fmCredit += c;
    console.log(`  ${r.name}: Debit(Given)=₹${fmt(d)}  Credit(Taken)=₹${fmt(c)}  Net=₹${fmt(c - d)}`);
  }
  console.log(`  TOTAL: Debit=₹${fmt(fmDebit)}  Credit=₹${fmt(fmCredit)}  Net=₹${fmt(fmCredit - fmDebit)}\n`);

  // ─── 4. Firm Transactions: What the dashboard computes ───
  console.log('━━━ FIRM TRANSACTIONS (Dashboard Query) ━━━');
  const dashFirmResult = await pool.query(`
    SELECT
      COALESCE(SUM(cfe.credit), 0) AS firm_credit,
      COALESCE(SUM(cfe.debit), 0) AS firm_debit
    FROM cash_flow_entries cfe
    JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
    WHERE cfe.site_id = $1
      AND COALESCE(cfe.source_module, 'direct') = 'firm_transactions'
      AND (cfe.source_module IS NULL OR cfe.source_module NOT IN ($2,$3,$4,$5,$6,$7))
      AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
  `, [SITE_ID, ...profitModules]);
  const dfc = parseFloat(dashFirmResult.rows[0].firm_credit);
  const dfd = parseFloat(dashFirmResult.rows[0].firm_debit);
  console.log(`  Credit(MoneyIn)=₹${fmt(dfc)}  Debit(MoneyOut)=₹${fmt(dfd)}  Net=₹${fmt(dfc - dfd)}`);
  console.log(`  MATCH Module Page: ${fmCredit === dfc && fmDebit === dfd ? '✅ YES' : '❌ NO'}`);
  if (fmCredit !== dfc || fmDebit !== dfd) {
    console.log(`    Module shows: Credit=₹${fmt(fmCredit)} Debit=₹${fmt(fmDebit)}`);
    console.log(`    Dashboard shows: Credit=₹${fmt(dfc)} Debit=₹${fmt(dfd)}`);
  }
  console.log();

  // Check: firm_transactions table entries NOT mirrored in cash_flow_entries
  const firmDirect = await pool.query(`
    SELECT f.name, ft.id, ft.debit, ft.credit
    FROM firm_transactions ft
    JOIN firms f ON f.id = ft.firm_id
    WHERE f.site_id = $1
      AND (ft.cheque_status IS NULL OR ft.cheque_status NOT IN ('BOUNCED','RETURNED'))
    ORDER BY f.name, ft.id
  `, [SITE_ID]);
  let ftDebit = 0, ftCredit = 0;
  for (const r of firmDirect.rows) {
    ftDebit += parseFloat(r.debit) || 0;
    ftCredit += parseFloat(r.credit) || 0;
  }
  console.log(`  firm_transactions table direct: Debit=₹${fmt(ftDebit)}  Credit=₹${fmt(ftCredit)}`);

  // Cash flow entries with is_firm_transaction=true
  const cfeFirm = await pool.query(`
    SELECT cfe.id, cfe.from_firm_id, cfe.to_firm_id, cfe.debit, cfe.credit, cfe.source_module, cfe.is_firm_transaction, cfm.ledger_type
    FROM cash_flow_entries cfe
    JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
    WHERE cfe.site_id = $1 AND (cfe.is_firm_transaction = true OR cfe.source_module = 'firm_transactions')
      AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
  `, [SITE_ID]);
  console.log(`  cash_flow_entries with is_firm_transaction=true or source_module='firm_transactions': ${cfeFirm.rows.length} rows`);
  for (const r of cfeFirm.rows) {
    console.log(`    cfe.id=${r.id} from_firm=${r.from_firm_id} to_firm=${r.to_firm_id} debit=₹${fmt(parseFloat(r.debit)||0)} credit=₹${fmt(parseFloat(r.credit)||0)} source=${r.source_module} is_firm=${r.is_firm_transaction} ledger_type=${r.ledger_type}`);
  }
  console.log();

  // ─── 5. Site Ledger (Ledger Money Flow): What module page shows ───
  console.log('━━━ SITE LEDGER / MONEY FLOW (Module Page Query) ━━━');
  const siteModulePage = await pool.query(`
    SELECT cfm.ledger_name,
      COALESCE(SUM(cfe.debit), 0) AS debit,
      COALESCE(SUM(cfe.credit), 0) AS credit,
      COUNT(*) as cnt
    FROM cash_flow_months cfm
    JOIN cash_flow_entries cfe ON cfe.cash_flow_month_id = cfm.id
    WHERE cfm.site_id = $1 AND cfm.ledger_type = 'site'
      AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    GROUP BY cfm.ledger_name
    ORDER BY cfm.ledger_name
  `, [SITE_ID]);

  let slDebit = 0, slCredit = 0;
  for (const r of siteModulePage.rows) {
    const d = parseFloat(r.debit);
    const c = parseFloat(r.credit);
    slDebit += d;
    slCredit += c;
    console.log(`  ${r.ledger_name}: Credit(In)=₹${fmt(c)}  Debit(Out)=₹${fmt(d)}  entries=${r.cnt}`);
  }
  console.log(`  TOTAL: Credit(In)=₹${fmt(slCredit)}  Debit(Out)=₹${fmt(slDebit)}  Net=₹${fmt(slCredit - slDebit)}\n`);

  // ─── 6. Site Ledger: What dashboard computes ───
  console.log('━━━ SITE LEDGER (Dashboard Query - by source) ━━━');
  const dashSiteResult = await pool.query(`
    SELECT COALESCE(cfe.source_module, 'direct') AS ledger_source,
      COALESCE(SUM(cfe.credit), 0) AS credit,
      COALESCE(SUM(cfe.debit), 0) AS debit
    FROM cash_flow_entries cfe
    JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
    WHERE cfe.site_id = $1
      AND cfm.ledger_type != 'person'
      AND COALESCE(cfe.source_module, 'direct') != 'firm_transactions'
      AND (cfe.source_module IS NULL OR cfe.source_module NOT IN ($2,$3,$4,$5,$6,$7))
      AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    GROUP BY COALESCE(cfe.source_module, 'direct')
  `, [SITE_ID, ...profitModules]);

  let dsCredit = 0, dsDebit = 0;
  for (const r of dashSiteResult.rows) {
    const c = parseFloat(r.credit);
    const d = parseFloat(r.debit);
    dsCredit += c;
    dsDebit += d;
    console.log(`  ${r.ledger_source}: Credit(In)=₹${fmt(c)}  Debit(Out)=₹${fmt(d)}`);
  }
  console.log(`  TOTAL: Credit(In)=₹${fmt(dsCredit)}  Debit(Out)=₹${fmt(dsDebit)}  Net=₹${fmt(dsCredit - dsDebit)}`);
  console.log(`  MATCH Site Module: ${slCredit === dsCredit && slDebit === dsDebit ? '✅ YES' : '❌ NO'}`);
  if (slCredit !== dsCredit || slDebit !== dsDebit) {
    console.log(`    Module shows: Credit=₹${fmt(slCredit)} Debit=₹${fmt(slDebit)}`);
    console.log(`    Dashboard shows: Credit=₹${fmt(dsCredit)} Debit=₹${fmt(dsDebit)}`);
    console.log(`    Diff: Credit=${fmt(slCredit - dsCredit)} Debit=${fmt(slDebit - dsDebit)}`);
  }
  console.log();

  // ─── 7. Check for entries that might be falling through cracks ───
  console.log('━━━ EDGE CASES ━━━');
  
  // Entries in site ledger with source_module that's a profit module
  const siteProfitEntries = await pool.query(`
    SELECT cfe.source_module, COUNT(*) as cnt,
      COALESCE(SUM(cfe.debit),0) AS debit, COALESCE(SUM(cfe.credit),0) AS credit
    FROM cash_flow_entries cfe
    JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
    WHERE cfe.site_id = $1 AND cfm.ledger_type = 'site'
      AND cfe.source_module IN ($2,$3,$4,$5,$6,$7)
      AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
    GROUP BY cfe.source_module
  `, [SITE_ID, ...profitModules]);
  if (siteProfitEntries.rows.length > 0) {
    console.log('  ⚠️  Site-ledger entries with profit source_modules (excluded from dashboard site & person):');
    for (const r of siteProfitEntries.rows) {
      console.log(`    ${r.source_module}: count=${r.cnt} debit=₹${fmt(parseFloat(r.debit))} credit=₹${fmt(parseFloat(r.credit))}`);
    }
  } else {
    console.log('  No site-ledger entries with profit source_modules');
  }

  // Entries with is_firm_transaction=true but source_module != 'firm_transactions'
  const firmMislabeled = await pool.query(`
    SELECT cfe.id, cfe.source_module, cfe.is_firm_transaction, cfe.from_firm_id, cfe.to_firm_id, cfe.debit, cfe.credit, cfm.ledger_type
    FROM cash_flow_entries cfe
    JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
    WHERE cfe.site_id = $1 AND cfe.is_firm_transaction = true AND COALESCE(cfe.source_module,'') != 'firm_transactions'
  `, [SITE_ID]);
  if (firmMislabeled.rows.length > 0) {
    console.log('  ⚠️  Entries with is_firm_transaction=true but source_module != firm_transactions:');
    for (const r of firmMislabeled.rows) {
      console.log(`    cfe.id=${r.id} source=${r.source_module || 'NULL'} debit=₹${fmt(parseFloat(r.debit)||0)} credit=₹${fmt(parseFloat(r.credit)||0)} ledger_type=${r.ledger_type}`);
    }
  } else {
    console.log('  No mismatched is_firm_transaction entries');
  }

  console.log('\n=== DONE ===');
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
