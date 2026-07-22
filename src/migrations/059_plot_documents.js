import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 059 — Plot Documents (Account ⇄ Booking integration).
 *
 * SAFETY: 100% additive + idempotent. It only ADDS nullable columns + an index to the
 * shared `documents` table (created by the booking module's migration 001) and relaxes
 * `kyc_case_id` to allow plot-level documents that aren't tied to a booking. It NEVER
 * drops/rewrites accounting data. New FKs use ON DELETE SET NULL so deleting a plot/user
 * can never cascade-delete a document row. Re-runnable.
 *
 * Why: the Account app gains a plot-centric document store. Because `documents` + the S3
 * bucket are shared with the booking module, adding `plot_id` (and backfilling it from the
 * existing kyc_cases → bookings → plot chain) makes a plot's documents a single source of
 * truth across both apps. See migrations/001_booking_core.js (booking-api) for the table.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fail loud if the shared documents table isn't present (booking migration not run).
    const { rows: ref } = await client.query(
      `SELECT to_regclass('public.documents') IS NOT NULL AS has_documents`
    );
    if (!ref[0].has_documents) {
      throw new Error('Shared `documents` table missing — run the booking-module migration 001 first (no changes made).');
    }

    // Plot link — the core of the integration. A document can belong to a plot directly.
    await client.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS plot_id INTEGER REFERENCES plots(id) ON DELETE SET NULL`);

    // Allow plot-level documents that aren't attached to a booking/kyc case.
    // (booking-api always supplies kyc_case_id, so relaxing the NOT NULL is safe for it.)
    await client.query(`ALTER TABLE documents ALTER COLUMN kyc_case_id DROP NOT NULL`);

    // Friendly metadata for the Account UI (original filename, free-text title, category,
    // provenance, and who uploaded it). All optional.
    await client.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS original_name   TEXT`);
    await client.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS title           TEXT`);
    await client.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS category        VARCHAR(40)`);
    await client.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS uploaded_source VARCHAR(20) DEFAULT 'BOOKING'`);
    await client.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS uploaded_by     INTEGER REFERENCES users(id) ON DELETE SET NULL`);

    // Backfill plot_id for existing booking documents from kyc_cases → bookings.
    await client.query(`
      UPDATE documents d
         SET plot_id = b.plot_id
        FROM kyc_cases k
        JOIN bookings b ON b.id = k.booking_id
       WHERE d.kyc_case_id = k.id
         AND d.plot_id IS NULL
         AND b.plot_id IS NOT NULL
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_documents_plot ON documents(plot_id)`);

    await client.query('COMMIT');
    console.log('Migration 059_plot_documents complete (documents.plot_id + metadata, kyc_case_id nullable, backfilled)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 059_plot_documents failed (rolled back, no changes):', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
