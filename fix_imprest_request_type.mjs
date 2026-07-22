/**
 * Fix Imprest Request Type Migration
 *
 * 1. Adds `request_type` column to imprest_expense_requests (IMPREST or EXPENSE)
 * 2. Classifies existing requests: no expense fields → IMPREST, else EXPENSE
 * 3. Fixes bad data: IMPREST-type requests that were approved with the old code
 *    - Deletes the wrongly created expense records
 *    - Deletes the wrongly created daybook entries (OVERDRAFT EXPENSE type)
 *    - Flips the imprest_ledger entry from negative EXPENSE to positive ALLOCATION
 */

import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const sslOption = process.env.DB_SSL === 'true' || (process.env.DB_HOST && process.env.DB_HOST.includes('neon'))
  ? { rejectUnauthorized: false }
  : false;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD != null ? String(process.env.DB_PASSWORD) : '',
  ssl: sslOption,
});

async function run() {
  const client = await pool.connect();
  try {
    // ═══════════════════════════════════════════
    // STEP 1: Add request_type column
    // ═══════════════════════════════════════════
    console.log('--- Step 1: Adding request_type column ---');
    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'imprest_expense_requests' AND column_name = 'request_type'
    `);
    if (colCheck.rows.length === 0) {
      await client.query(`
        ALTER TABLE imprest_expense_requests
        ADD COLUMN request_type VARCHAR(20) NOT NULL DEFAULT 'EXPENSE'
          CHECK (request_type IN ('IMPREST', 'EXPENSE'))
      `);
      console.log('  ✓ Column request_type added');
    } else {
      console.log('  ✓ Column request_type already exists');
    }

    // ═══════════════════════════════════════════
    // STEP 2: Classify existing requests
    // ═══════════════════════════════════════════
    console.log('\n--- Step 2: Classifying existing requests ---');
    const allReqs = await client.query(`SELECT id, expense_data, request_type FROM imprest_expense_requests`);
    let reclassified = 0;
    for (const req of allReqs.rows) {
      const data = typeof req.expense_data === 'string' ? JSON.parse(req.expense_data) : req.expense_data;
      // A simple imprest request has no meaningful expense-specific fields
      const hasExpenseFields = data &&
        (data.from_entity || data.to_entity || data.payment_mode ||
         data.account_no || data.branch || data.category || data.remark);
      const correctType = hasExpenseFields ? 'EXPENSE' : 'IMPREST';
      if (req.request_type !== correctType) {
        await client.query(`UPDATE imprest_expense_requests SET request_type = $1 WHERE id = $2`, [correctType, req.id]);
        reclassified++;
        console.log(`  → Request #${req.id}: ${req.request_type} → ${correctType}`);
      }
    }
    console.log(`  ✓ ${reclassified} request(s) reclassified, ${allReqs.rows.length - reclassified} already correct`);

    // ═══════════════════════════════════════════
    // STEP 3: Fix bad data for APPROVED IMPREST requests
    // ═══════════════════════════════════════════
    console.log('\n--- Step 3: Fixing bad data for approved IMPREST requests ---');
    const badReqs = await client.query(`
      SELECT ier.id, ier.sub_admin_id, ier.site_id, ier.amount, ier.reason
      FROM imprest_expense_requests ier
      WHERE ier.request_type = 'IMPREST' AND ier.status = 'APPROVED'
    `);

    console.log(`  Found ${badReqs.rows.length} approved IMPREST request(s) to fix`);

    for (const req of badReqs.rows) {
      console.log(`\n  ── Fixing request #${req.id} (₹${req.amount}) ──`);

      await client.query('BEGIN');
      try {
        // Find the bad imprest_ledger entry (negative EXPENSE entry for this request's reference)
        // The old code created: type='EXPENSE', amount=-X, remarks LIKE 'OVERDRAFT EXPENSE%'
        const badLedger = await client.query(`
          SELECT id, reference_id, amount, type, remarks
          FROM imprest_ledger
          WHERE user_id = $1
            AND site_id = $2
            AND type = 'EXPENSE'
            AND amount < 0
            AND ABS(amount) = $3
            AND remarks ILIKE '%OVERDRAFT EXPENSE%Admin approved%'
          ORDER BY created_at DESC
          LIMIT 1
        `, [req.sub_admin_id, req.site_id, parseFloat(req.amount)]);

        if (badLedger.rows.length > 0) {
          const ledgerEntry = badLedger.rows[0];
          const expenseId = ledgerEntry.reference_id;
          console.log(`    Found bad ledger entry #${ledgerEntry.id} (ref expense #${expenseId})`);

          // Delete the wrongly created expense record
          if (expenseId) {
            const delExp = await client.query(`DELETE FROM expenses WHERE id = $1 RETURNING id`, [expenseId]);
            if (delExp.rows.length > 0) {
              console.log(`    ✓ Deleted bad expense #${expenseId}`);
            }

            // Delete the wrongly created daybook entry
            const delDaybook = await client.query(`
              DELETE FROM day_book
              WHERE site_id = $1
                AND entry_type = 'EXPENSE'
                AND particular ILIKE '%OVERDRAFT EXPENSE%'
                AND debit = $2
              RETURNING id
            `, [req.site_id, parseFloat(req.amount)]);
            if (delDaybook.rows.length > 0) {
              console.log(`    ✓ Deleted ${delDaybook.rows.length} bad daybook entry/entries`);
            }
          }

          // Flip the ledger entry: negative EXPENSE → positive ALLOCATION
          await client.query(`
            UPDATE imprest_ledger
            SET type = 'ALLOCATION',
                amount = ABS(amount),
                balance_after = balance_after + 2 * ABS(amount),
                remarks = $1
            WHERE id = $2
          `, [
            `Imprest allocated (request #${req.id} approved): ${req.reason || ''}`.trim(),
            ledgerEntry.id,
          ]);
          console.log(`    ✓ Flipped ledger #${ledgerEntry.id}: EXPENSE -${req.amount} → ALLOCATION +${req.amount}`);

          // Recalculate balance_after for all subsequent entries
          const allEntries = await client.query(`
            SELECT id, amount FROM imprest_ledger
            WHERE user_id = $1 AND site_id = $2
            ORDER BY created_at ASC, id ASC
          `, [req.sub_admin_id, req.site_id]);

          let runningBalance = 0;
          for (const entry of allEntries.rows) {
            runningBalance += parseFloat(entry.amount);
            await client.query(`UPDATE imprest_ledger SET balance_after = $1 WHERE id = $2`, [runningBalance, entry.id]);
          }
          console.log(`    ✓ Recalculated running balances for ${allEntries.rows.length} ledger entries`);
        } else {
          console.log(`    ⚠ No matching bad ledger entry found — may have been fixed already`);
        }

        // Create an allocation record if not exists
        const existingAlloc = await client.query(`
          SELECT id FROM imprest_allocations
          WHERE sub_admin_id = $1 AND site_id = $2 AND amount = $3
            AND remark ILIKE $4
        `, [req.sub_admin_id, req.site_id, parseFloat(req.amount), `%request #${req.id}%`]);

        if (existingAlloc.rows.length === 0) {
          await client.query(`
            INSERT INTO imprest_allocations (admin_id, sub_admin_id, amount, remark, site_id, status, confirmed_at, confirmation_remark)
            VALUES (
              (SELECT reviewed_by FROM imprest_expense_requests WHERE id = $1),
              $2, $3, $4, $5, 'RECEIVED', NOW(), 'Auto-confirmed (request fix migration)'
            )
          `, [req.id, req.sub_admin_id, parseFloat(req.amount),
              `Imprest request #${req.id} approved: ${req.reason || ''}`.trim(),
              req.site_id]);
          console.log(`    ✓ Created allocation record`);
        }

        await client.query('COMMIT');
        console.log(`    ✓ Request #${req.id} fixed successfully`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`    ✗ Failed to fix request #${req.id}:`, err.message);
      }
    }

    console.log('\n═══════════════════════════════════════════');
    console.log('Migration complete!');
    console.log('═══════════════════════════════════════════');

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
