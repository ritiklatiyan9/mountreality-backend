import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 061 — Document Imprest (physical-document handover register).
 *
 * SAFETY: 100% additive + idempotent. Creates ONE brand-new table; touches nothing
 * shared. FKs use ON DELETE SET NULL so deleting a user can never cascade into the
 * register — the history stays intact. Re-runnable.
 *
 * Each row is one handover: who gave which physical document to whom, with a
 * camera photo taken at the moment of handover as proof (photo_key → S3), an
 * optional expected-return deadline (NULL = open-ended), and — once the document
 * comes back — the return timestamp, receiver and an optional return-proof photo.
 * The table itself is the history; rows are never deleted.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS document_imprest (
        id                 SERIAL PRIMARY KEY,
        document_name      TEXT NOT NULL,
        description        TEXT,
        receiver_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        receiver_name      TEXT,                                    -- free text when the receiver has no account
        issued_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
        photo_key          TEXT NOT NULL,                           -- camera proof at handover (S3 key / local::)
        expected_return_at TIMESTAMPTZ,                             -- NULL = open-ended (return-time toggle off)
        status             VARCHAR(12) NOT NULL DEFAULT 'ISSUED',   -- ISSUED | RETURNED
        remarks            TEXT,
        returned_at        TIMESTAMPTZ,
        return_photo_key   TEXT,                                    -- optional camera proof at return
        return_received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        return_remarks     TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_document_imprest_status  ON document_imprest(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_document_imprest_created ON document_imprest(created_at DESC)`);

    await client.query('COMMIT');
    console.log('Migration 061_document_imprest complete (document_imprest table + indexes)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 061_document_imprest failed (rolled back, no changes):', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
