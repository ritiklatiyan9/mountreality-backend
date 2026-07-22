import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT||'5432'), database: process.env.DB_NAME, user: process.env.DB_USER, password: String(process.env.DB_PASSWORD||''), ssl:{rejectUnauthorized:false} });

const client = await pool.connect();
try {
  await client.query('BEGIN');

  // 1. Add site_id to imprest_allocations if not exists
  const hasAllocSite = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'imprest_allocations' AND column_name = 'site_id'
  `);
  if (hasAllocSite.rows.length === 0) {
    await client.query(`ALTER TABLE imprest_allocations ADD COLUMN site_id INTEGER REFERENCES sites(id)`);
    console.log('✅ Added site_id to imprest_allocations');
  } else {
    console.log('⏭️ imprest_allocations already has site_id');
  }

  // 2. Add site_id to imprest_ledger if not exists
  const hasLedgerSite = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'imprest_ledger' AND column_name = 'site_id'
  `);
  if (hasLedgerSite.rows.length === 0) {
    await client.query(`ALTER TABLE imprest_ledger ADD COLUMN site_id INTEGER REFERENCES sites(id)`);
    console.log('✅ Added site_id to imprest_ledger');
  } else {
    console.log('⏭️ imprest_ledger already has site_id');
  }

  // 3. Backfill: try to set site_id from linked day_book entries for allocations
  const backfillAlloc = await client.query(`
    UPDATE imprest_allocations ia
    SET site_id = db.site_id
    FROM day_book db
    WHERE db.imprest_allocation_id = ia.id AND ia.site_id IS NULL AND db.site_id IS NOT NULL
  `);
  console.log(`Backfilled ${backfillAlloc.rowCount} allocation site_ids from day_book`);

  // 4. Backfill ledger from allocations (ALLOCATION type)
  const backfillLedgerAlloc = await client.query(`
    UPDATE imprest_ledger il
    SET site_id = ia.site_id
    FROM imprest_allocations ia
    WHERE il.type = 'ALLOCATION' AND il.reference_id = ia.id AND il.site_id IS NULL AND ia.site_id IS NOT NULL
  `);
  console.log(`Backfilled ${backfillLedgerAlloc.rowCount} ledger ALLOCATION site_ids`);

  // 5. Backfill ledger from expenses (EXPENSE type)
  const backfillLedgerExp = await client.query(`
    UPDATE imprest_ledger il
    SET site_id = e.site_id
    FROM expenses e
    WHERE il.type = 'EXPENSE' AND il.reference_id = e.id AND il.site_id IS NULL AND e.site_id IS NOT NULL
  `);
  console.log(`Backfilled ${backfillLedgerExp.rowCount} ledger EXPENSE site_ids`);

  // 6. Backfill ledger from imprest_returns (REFUND type)
  const backfillLedgerReturn = await client.query(`
    UPDATE imprest_ledger il
    SET site_id = ir.site_id
    FROM imprest_returns ir
    WHERE il.type = 'REFUND' AND il.reference_id = ir.id AND il.site_id IS NULL AND ir.site_id IS NOT NULL
  `);
  console.log(`Backfilled ${backfillLedgerReturn.rowCount} ledger REFUND site_ids`);

  // 7. Report remaining NULLs
  const nullAlloc = await client.query(`SELECT COUNT(*) as cnt FROM imprest_allocations WHERE site_id IS NULL`);
  const nullLedger = await client.query(`SELECT COUNT(*) as cnt FROM imprest_ledger WHERE site_id IS NULL`);
  console.log(`\nRemaining NULLs: allocations=${nullAlloc.rows[0].cnt}, ledger=${nullLedger.rows[0].cnt}`);

  // 8. Show summary
  const summary = await client.query(`
    SELECT 'allocations' as tbl, site_id, COUNT(*) as cnt FROM imprest_allocations GROUP BY site_id
    UNION ALL
    SELECT 'ledger', site_id, COUNT(*) FROM imprest_ledger GROUP BY site_id
    UNION ALL
    SELECT 'expense_requests', site_id, COUNT(*) FROM imprest_expense_requests GROUP BY site_id
    UNION ALL
    SELECT 'returns', site_id, COUNT(*) FROM imprest_returns GROUP BY site_id
    ORDER BY tbl, site_id
  `);
  console.log('\nSite distribution:');
  summary.rows.forEach(r => console.log(`  ${r.tbl}: site_id=${r.site_id} → ${r.cnt} rows`));

  await client.query('COMMIT');
  console.log('\n✅ Migration complete');
} catch(e) {
  await client.query('ROLLBACK');
  console.error('ROLLBACK:', e.message);
} finally {
  client.release();
  await pool.end();
}
