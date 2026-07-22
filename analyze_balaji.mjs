import { createRequire } from 'module';
import pkg from 'pg';

const { Pool } = pkg;
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

// ─── Config ────────────────────────────────────────────────────────────────
const EXCEL_PATH = 'A:\\MY_CLIENTS\\RiverGreen\\Account\\RGAccount\\Frontend\\three.xlsx';
const SITE_ID = 6; // BALAJI ASSOCIATES
const SITE_NAME = 'BALAJI ASSOCIATES';

const pool = new Pool({
  connectionString:
    'postgresql://neondb_owner:npg_r5zpVtZnxRu1@ep-dark-boat-aijjdnhi-pooler.c-4.us-east-1.aws.neon.tech/rgaccount?sslmode=require',
  ssl: { rejectUnauthorized: false },
});

// ─── Helpers ───────────────────────────────────────────────────────────────
function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

function fmt(n) {
  const rounded = Math.round(Number(n));
  return rounded.toLocaleString('en-IN');
}

function normalizePN(s) {
  return String(s ?? '').trim().toUpperCase();
}

// ─── Parse Excel ───────────────────────────────────────────────────────────
// The Excel has MULTIPLE rows per plot (payment entry rows share the same PLOT NO.)
// We need to pick the FIRST non-empty sale-price row per plot for TOTAL SALE VALUE
// and also sum received amounts per plot.
function parseExcel() {
  const wb = XLSX.readFile(EXCEL_PATH);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  // Column keys (with spaces as in Excel)
  const PLOT_NO_COL    = 'PLOT NO.';
  const SALE_PRICE_COL = ' TOTAL SALE VALUE ';
  const BANK_REC_COL   = ' BANK RECEIVED ';
  const CASH_REC_COL   = ' CASH RECEIVED ';
  const TOTAL_REC_COL  = ' TOTAL RECEIVED ';

  // Build per-plot data
  // The first row for each plot_no that has TOTAL SALE VALUE is the "header" row
  // Subsequent rows have payment info
  const plotMap = new Map(); // plot_no -> { sale_price, bank_received, cash_received, total_received, rows[] }

  for (const row of rows) {
    const pn = normalizePN(row[PLOT_NO_COL]);
    if (!pn) continue;

    if (!plotMap.has(pn)) {
      plotMap.set(pn, {
        plot_no: pn,
        sale_price: 0,
        bank_received: 0,
        cash_received: 0,
        total_received: 0,
        raw_rows: [],
      });
    }

    const entry = plotMap.get(pn);
    entry.raw_rows.push(row);

    const sp = num(row[SALE_PRICE_COL]);
    if (sp > 0 && entry.sale_price === 0) {
      entry.sale_price = sp;
    }

    // Total received is in the dedicated column - take last non-zero value
    const tr = num(row[TOTAL_REC_COL]);
    if (tr !== 0) entry.total_received = tr;

    // Also accumulate bank/cash received
    const br = num(row[BANK_REC_COL]);
    const cr = num(row[CASH_REC_COL]);
    if (br !== 0) entry.bank_received += br;
    if (cr !== 0) entry.cash_received += cr;
  }

  return plotMap;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const client = await pool.connect();

  try {
    // 1. Parse Excel
    console.log('Parsing Excel...');
    const excelMap = parseExcel();
    console.log(`Excel: ${excelMap.size} unique plots found\n`);

    // 2. Query DB with corrected column names
    // payment_type (not type), status = 'approved' means valid (no bounced/returned)
    const dbQuery = `
      SELECT
        p.id,
        p.plot_no,
        p.sale_price,
        p.plot_tag,
        p.plot_size,
        p.plot_rate,
        COALESCE(pp_agg.received_bank, 0) AS received_bank,
        COALESCE(pp_agg.received_cash, 0) AS received_cash,
        COALESCE(pp_agg.received_bank, 0) + COALESCE(pp_agg.received_cash, 0) AS total_received
      FROM plots p
      LEFT JOIN LATERAL (
        SELECT
          SUM(CASE WHEN payment_type IN ('BANK','CHEQUE') AND status = 'approved' THEN amount ELSE 0 END) AS received_bank,
          SUM(CASE WHEN payment_type = 'CASH' AND status = 'approved' THEN amount ELSE 0 END) AS received_cash
        FROM plot_payments WHERE plot_id = p.id
      ) pp_agg ON true
      WHERE p.site_id = $1
      ORDER BY p.plot_no
    `;

    const { rows: dbRows } = await client.query(dbQuery, [SITE_ID]);
    console.log(`DB: ${dbRows.length} plots for ${SITE_NAME} (site_id=${SITE_ID})\n`);

    // Build DB map
    const dbMap = new Map();
    for (const row of dbRows) {
      const pn = normalizePN(row.plot_no);
      dbMap.set(pn, {
        plot_no: pn,
        sale_price: num(row.sale_price),
        plot_tag: String(row.plot_tag ?? '').trim(),
        plot_size: row.plot_size,
        plot_rate: row.plot_rate,
        received_bank: num(row.received_bank),
        received_cash: num(row.received_cash),
        total_received: num(row.total_received),
        id: row.id,
      });
    }

    // ─── Analysis ────────────────────────────────────────────────────────
    const allPlotNos = new Set([...excelMap.keys(), ...dbMap.keys()]);

    const inExcelNotDB   = [];
    const inDBNotExcel   = [];
    const salePriceDiff  = [];
    const oldTaggedDB    = [];
    const newTaggedDB    = [];
    const receivedExceedsSale = [];

    let excelTotal       = 0;
    let dbTotalAll       = 0;
    let dbTotalNonOld    = 0;
    let dbTotalReceived  = 0;

    // Excel totals
    for (const [, ex] of excelMap) {
      excelTotal += ex.sale_price;
    }

    // DB totals
    for (const [pn, db] of dbMap) {
      dbTotalAll += db.sale_price;
      dbTotalReceived += db.total_received;
      const tag = db.plot_tag.toUpperCase();
      if (tag !== 'OLD' && tag !== '"OLD"') {
        dbTotalNonOld += db.sale_price;
      }
      if (tag === 'OLD') {
        oldTaggedDB.push({ pn, ...db });
      }
      if (tag === 'NEW') {
        newTaggedDB.push({ pn, ...db });
      }
      if (db.total_received > db.sale_price + 0.5) {
        receivedExceedsSale.push({ pn, ...db });
      }
    }

    // Plots in Excel but not DB
    for (const pn of excelMap.keys()) {
      if (!dbMap.has(pn)) inExcelNotDB.push(pn);
    }

    // Plots in DB but not Excel
    for (const pn of dbMap.keys()) {
      if (!excelMap.has(pn)) inDBNotExcel.push({ pn, ...dbMap.get(pn) });
    }

    // Sale price diffs
    for (const pn of allPlotNos) {
      const ex = excelMap.get(pn);
      const db = dbMap.get(pn);
      if (ex && db && Math.abs(ex.sale_price - db.sale_price) > 0.5) {
        salePriceDiff.push({
          plot_no: pn,
          excel_sale: ex.sale_price,
          db_sale: db.sale_price,
          diff: db.sale_price - ex.sale_price,
          db_tag: db.plot_tag,
        });
      }
    }

    // S1 and S2 plots
    const s1s2Plots = [...allPlotNos].filter(pn => {
      const up = pn.toUpperCase();
      return up === 'S1' || up === 'S2' ||
             up.startsWith('S1') || up.startsWith('S2') ||
             up.includes('-S1') || up.includes('-S2') || up.includes('/S1') || up.includes('/S2');
    });

    // ─── PRINT REPORT ────────────────────────────────────────────────────

    const SEP  = '─'.repeat(90);
    const SEP2 = '═'.repeat(90);

    console.log('\n' + SEP2);
    console.log('   BALAJI ASSOCIATES — PLOT DATA ANALYSIS REPORT');
    console.log(SEP2 + '\n');

    // ── ALL DB PLOTS ──
    console.log('┌─ ALL DB PLOTS (' + dbRows.length + ') ──────────────────────────────────────────────────────────');
    console.log(`│ ${'PLOT_NO'.padEnd(12)} ${'SALE_PRICE'.padStart(14)} ${'TAG'.padEnd(12)} ${'RECV_BANK'.padStart(12)} ${'RECV_CASH'.padStart(12)} ${'TOTAL_RECV'.padStart(12)}`);
    console.log('│ ' + '─'.repeat(78));
    for (const [, r] of dbMap) {
      console.log(
        `│ ${r.plot_no.padEnd(12)} ${fmt(r.sale_price).padStart(14)} ${(r.plot_tag || 'null').padEnd(12)} ${fmt(r.received_bank).padStart(12)} ${fmt(r.received_cash).padStart(12)} ${fmt(r.total_received).padStart(12)}`
      );
    }
    console.log('└' + '─'.repeat(89) + '\n');

    // ── ALL EXCEL PLOTS ──
    console.log('┌─ ALL EXCEL PLOTS (' + excelMap.size + ') ────────────────────────────────────────────────────────');
    console.log(`│ ${'PLOT_NO'.padEnd(12)} ${'SALE_PRICE'.padStart(14)} ${'BANK_RECV'.padStart(12)} ${'CASH_RECV'.padStart(12)} ${'TOTAL_RECV'.padStart(12)}`);
    console.log('│ ' + '─'.repeat(70));
    for (const [, r] of excelMap) {
      console.log(
        `│ ${r.plot_no.padEnd(12)} ${fmt(r.sale_price).padStart(14)} ${fmt(r.bank_received).padStart(12)} ${fmt(r.cash_received).padStart(12)} ${fmt(r.total_received).padStart(12)}`
      );
    }
    console.log('└' + '─'.repeat(89) + '\n');

    // ── TOTALS ──
    console.log(SEP);
    console.log('TOTALS SUMMARY');
    console.log(SEP);
    console.log(`  Excel total sale price            : ₹${fmt(excelTotal).padStart(16)}`);
    console.log(`  DB total sale price (ALL)         : ₹${fmt(dbTotalAll).padStart(16)}`);
    console.log(`  DB total sale price (non-OLD)     : ₹${fmt(dbTotalNonOld).padStart(16)}`);
    console.log(`  DB total received (approved)      : ₹${fmt(dbTotalReceived).padStart(16)}`);
    console.log(`  Gap: DB(non-OLD) - Excel          : ₹${fmt(dbTotalNonOld - excelTotal).padStart(16)}`);
    console.log(`  Gap: DB(all)     - Excel          : ₹${fmt(dbTotalAll - excelTotal).padStart(16)}`);
    console.log('');

    // ── S1 / S2 ──
    console.log(SEP);
    console.log('S1 AND S2 PLOT DETAILS');
    console.log(SEP);
    if (s1s2Plots.length === 0) {
      console.log('  No S1/S2 plots found in either Excel or DB.');
      // Show all plots starting with 'S'
      const sPlots = [...allPlotNos].filter(p => p.startsWith('S'));
      if (sPlots.length > 0) {
        console.log('  Plots starting with S found:', sPlots.join(', '));
      }
    } else {
      for (const pn of s1s2Plots) {
        const ex = excelMap.get(pn);
        const db = dbMap.get(pn);
        console.log(`\n  Plot: ${pn}`);
        if (ex) {
          console.log(`    Excel  → sale_price: ₹${fmt(ex.sale_price)}`);
          console.log(`             bank_recv:  ₹${fmt(ex.bank_received)}`);
          console.log(`             cash_recv:  ₹${fmt(ex.cash_received)}`);
          console.log(`             total_recv: ₹${fmt(ex.total_received)}`);
        } else {
          console.log(`    Excel  → NOT FOUND`);
        }
        if (db) {
          console.log(`    DB     → sale_price: ₹${fmt(db.sale_price)}, tag: ${db.plot_tag}`);
          console.log(`             bank_recv:  ₹${fmt(db.received_bank)}`);
          console.log(`             cash_recv:  ₹${fmt(db.received_cash)}`);
          console.log(`             total_recv: ₹${fmt(db.total_received)}`);
          if (ex) {
            const diff = db.sale_price - ex.sale_price;
            console.log(`    Diff   → sale_price DB - Excel: ₹${fmt(diff)}`);
          }
        } else {
          console.log(`    DB     → NOT FOUND`);
        }
      }
    }
    console.log('');

    // ── PLOTS IN DB BUT NOT EXCEL ──
    console.log(SEP);
    console.log(`PLOTS IN DB BUT NOT IN EXCEL (${inDBNotExcel.length})`);
    console.log(SEP);
    if (inDBNotExcel.length === 0) {
      console.log('  None');
    } else {
      console.log(`  ${'PLOT_NO'.padEnd(12)} ${'SALE_PRICE'.padStart(14)} ${'TAG'.padEnd(12)} ${'TOTAL_RECV'.padStart(12)}`);
      for (const r of inDBNotExcel) {
        console.log(`  ${r.pn.padEnd(12)} ${fmt(r.sale_price).padStart(14)} ${(r.plot_tag || 'null').padEnd(12)} ${fmt(r.total_received).padStart(12)}`);
      }
    }
    console.log('');

    // ── PLOTS IN EXCEL BUT NOT DB ──
    console.log(SEP);
    console.log(`PLOTS IN EXCEL BUT NOT IN DB (${inExcelNotDB.length})`);
    console.log(SEP);
    if (inExcelNotDB.length === 0) {
      console.log('  None');
    } else {
      console.log(`  ${'PLOT_NO'.padEnd(12)} ${'SALE_PRICE'.padStart(14)}`);
      for (const pn of inExcelNotDB) {
        const ex = excelMap.get(pn);
        console.log(`  ${pn.padEnd(12)} ${fmt(ex.sale_price).padStart(14)}`);
      }
    }
    console.log('');

    // ── SALE PRICE DIFFERENCES ──
    console.log(SEP);
    console.log(`SALE PRICE DIFFERENCES — Excel vs DB (${salePriceDiff.length} plots)`);
    console.log(SEP);
    if (salePriceDiff.length === 0) {
      console.log('  No differences found — all matching plots have same sale_price.');
    } else {
      console.log(`  ${'PLOT_NO'.padEnd(12)} ${'EXCEL_SALE'.padStart(14)} ${'DB_SALE'.padStart(14)} ${'DIFF(DB-EX)'.padStart(14)} ${'DB_TAG'.padEnd(12)}`);
      for (const r of salePriceDiff.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))) {
        console.log(`  ${r.plot_no.padEnd(12)} ${fmt(r.excel_sale).padStart(14)} ${fmt(r.db_sale).padStart(14)} ${fmt(r.diff).padStart(14)} ${(r.db_tag || 'null').padEnd(12)}`);
      }
    }
    console.log('');

    // ── OLD-TAGGED PLOTS ──
    console.log(SEP);
    console.log(`ALL OLD-TAGGED PLOTS IN DB (${oldTaggedDB.length})`);
    console.log(SEP);
    if (oldTaggedDB.length === 0) {
      console.log('  None');
    } else {
      let oldTotal = 0;
      console.log(`  ${'PLOT_NO'.padEnd(12)} ${'SALE_PRICE'.padStart(14)} ${'TAG'.padEnd(12)} ${'TOTAL_RECV'.padStart(12)}`);
      for (const r of oldTaggedDB) {
        console.log(`  ${r.pn.padEnd(12)} ${fmt(r.sale_price).padStart(14)} ${(r.plot_tag || 'null').padEnd(12)} ${fmt(r.total_received).padStart(12)}`);
        oldTotal += r.sale_price;
      }
      console.log(`  ${'─'.repeat(58)}`);
      console.log(`  ${'TOTAL OLD sale_price:'.padEnd(28)} ${fmt(oldTotal).padStart(14)}`);
    }
    console.log('');

    // ── NEW-TAGGED PLOTS ──
    console.log(SEP);
    console.log(`ALL NEW-TAGGED PLOTS IN DB (${newTaggedDB.length})`);
    console.log(SEP);
    if (newTaggedDB.length === 0) {
      console.log('  None');
    } else {
      let newTotal = 0;
      console.log(`  ${'PLOT_NO'.padEnd(12)} ${'SALE_PRICE'.padStart(14)} ${'TAG'.padEnd(12)} ${'TOTAL_RECV'.padStart(12)}`);
      for (const r of newTaggedDB) {
        console.log(`  ${r.pn.padEnd(12)} ${fmt(r.sale_price).padStart(14)} ${(r.plot_tag || 'null').padEnd(12)} ${fmt(r.total_received).padStart(12)}`);
        newTotal += r.sale_price;
      }
      console.log(`  ${'─'.repeat(58)}`);
      console.log(`  ${'TOTAL NEW sale_price:'.padEnd(28)} ${fmt(newTotal).padStart(14)}`);
    }
    console.log('');

    // ── RECEIVED > SALE PRICE ──
    console.log(SEP);
    console.log(`PLOTS WHERE RECEIVED > SALE_PRICE IN DB (${receivedExceedsSale.length})`);
    console.log(SEP);
    if (receivedExceedsSale.length === 0) {
      console.log('  None');
    } else {
      console.log(`  ${'PLOT_NO'.padEnd(12)} ${'SALE_PRICE'.padStart(14)} ${'TOTAL_RECV'.padStart(14)} ${'EXCESS'.padStart(12)}`);
      for (const r of receivedExceedsSale) {
        console.log(`  ${r.pn.padEnd(12)} ${fmt(r.sale_price).padStart(14)} ${fmt(r.total_received).padStart(14)} ${fmt(r.total_received - r.sale_price).padStart(12)}`);
      }
    }
    console.log('');

    // ── GAP BREAKDOWN ──
    console.log(SEP);
    console.log('TOTAL SALE GAP BREAKDOWN');
    console.log(SEP);
    const gapNonOld = dbTotalNonOld - excelTotal;
    console.log(`  Excel total        : ₹${fmt(excelTotal)}`);
    console.log(`  DB non-OLD total   : ₹${fmt(dbTotalNonOld)}`);
    console.log(`  Net Gap            : ₹${fmt(gapNonOld)}`);
    console.log('');

    // Contribution from DB-only (non-OLD) plots
    let gapFromDBOnly = 0;
    const dbOnlyNonOld = inDBNotExcel.filter(r => r.plot_tag.toUpperCase() !== 'OLD');
    if (dbOnlyNonOld.length > 0) {
      console.log(`  [+] Plots in DB (non-OLD) but NOT in Excel → add to DB total:`);
      for (const r of dbOnlyNonOld) {
        console.log(`       ${r.pn.padEnd(12)}: ₹${fmt(r.sale_price)} (tag: ${r.plot_tag || 'null'})`);
        gapFromDBOnly += r.sale_price;
      }
      console.log(`       Subtotal: ₹${fmt(gapFromDBOnly)}\n`);
    } else {
      console.log(`  [+] Plots in DB only (non-OLD): None\n`);
    }

    // Contribution from price diffs where DB > Excel
    let gapFromDBHigher = 0;
    const diffDBHigher = salePriceDiff.filter(r => r.diff > 0 && r.db_tag.toUpperCase() !== 'OLD');
    if (diffDBHigher.length > 0) {
      console.log(`  [+] Plots where DB sale_price > Excel sale_price (non-OLD):`);
      for (const r of diffDBHigher) {
        console.log(`       ${r.plot_no.padEnd(12)}: DB higher by ₹${fmt(r.diff)}  (Excel: ₹${fmt(r.excel_sale)}, DB: ₹${fmt(r.db_sale)}) tag: ${r.db_tag}`);
        gapFromDBHigher += r.diff;
      }
      console.log(`       Subtotal: ₹${fmt(gapFromDBHigher)}\n`);
    } else {
      console.log(`  [+] Plots where DB > Excel price: None\n`);
    }

    // Plots where Excel > DB (negative contributors to gap)
    let gapFromExcelHigher = 0;
    const diffExcelHigher = salePriceDiff.filter(r => r.diff < 0);
    if (diffExcelHigher.length > 0) {
      console.log(`  [-] Plots where Excel sale_price > DB sale_price (reduce gap):`);
      for (const r of diffExcelHigher) {
        console.log(`       ${r.plot_no.padEnd(12)}: Excel higher by ₹${fmt(-r.diff)} (Excel: ₹${fmt(r.excel_sale)}, DB: ₹${fmt(r.db_sale)}) tag: ${r.db_tag}`);
        gapFromExcelHigher += r.diff;
      }
      console.log(`       Subtotal: ₹${fmt(gapFromExcelHigher)}\n`);
    } else {
      console.log(`  [-] Plots where Excel > DB price: None\n`);
    }

    // Plots in Excel but not DB (reduce Excel-only baseline)
    let excelOnlyTotal = 0;
    if (inExcelNotDB.length > 0) {
      console.log(`  [-] Plots in Excel but NOT in DB (reduce Excel total):`);
      for (const pn of inExcelNotDB) {
        const ex = excelMap.get(pn);
        console.log(`       ${pn.padEnd(12)}: ₹${fmt(ex.sale_price)}`);
        excelOnlyTotal += ex.sale_price;
      }
      console.log(`       Subtotal: ₹${fmt(excelOnlyTotal)}\n`);
    } else {
      console.log(`  [-] Plots in Excel only: None\n`);
    }

    const explainedGap = gapFromDBOnly + gapFromDBHigher + gapFromExcelHigher - excelOnlyTotal;
    console.log(`  Explained gap sum  : ₹${fmt(explainedGap)}`);
    console.log(`  Actual gap         : ₹${fmt(gapNonOld)}`);
    console.log(`  Unexplained residual: ₹${fmt(gapNonOld - explainedGap)}`);
    console.log('');

    console.log(SEP2);
    console.log('  ANALYSIS COMPLETE');
    console.log(SEP2 + '\n');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('FATAL ERROR:', err.message);
  process.exit(1);
});
