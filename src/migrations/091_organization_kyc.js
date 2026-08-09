import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Company (tenant) KYC.
 *
 * A separate 1:1 table rather than more columns on `organizations`:
 * organizations is read on every login and every owner listing, and this
 * is ten mostly-null fields plus audit timestamps that almost nothing
 * else queries. It also keeps a clean boundary from `kyc_cases`, which is
 * the unrelated member/plot-buyer KYC.
 *
 * Coordinates are stored beside the typed address, not instead of it: a
 * pin proves where, the text is what goes on paperwork, and either can be
 * wrong on its own.
 *
 * Idempotent — safe under start:with-migrations.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS organization_kyc (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,

        company_name          VARCHAR(200),
        registered_address    TEXT,
        registered_lat        NUMERIC(9,6),
        registered_lng        NUMERIC(9,6),
        communication_address TEXT,
        same_as_registered    BOOLEAN NOT NULL DEFAULT false,
        director_name         VARCHAR(200),
        director_phone        VARCHAR(20),

        -- pending → submitted → verified | rejected
        status       VARCHAR(20) NOT NULL DEFAULT 'pending',
        review_note  TEXT,
        submitted_at TIMESTAMP,
        verified_at  TIMESTAMP,
        created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    // Guard the state machine in the database, not only in the controller —
    // a typo'd status is the kind of thing that silently disables the
    // reminder modal for a whole tenant.
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE organization_kyc ADD CONSTRAINT organization_kyc_status_chk
          CHECK (status IN ('pending','submitted','verified','rejected'));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    // Optional — a business under the registration threshold has no GSTIN,
    // so this must never count toward completeness.
    await client.query(`ALTER TABLE organization_kyc ADD COLUMN IF NOT EXISTS gst_number VARCHAR(15)`);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_org_kyc_status ON organization_kyc (status)`);

    // Every existing tenant starts with a pending row seeded from the name
    // they signed up with, so the timeline has something to show on step 1
    // instead of an empty form.
    await client.query(`
      INSERT INTO organization_kyc (organization_id, company_name)
      SELECT o.id, o.name FROM organizations o
      ON CONFLICT (organization_id) DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('091_organization_kyc: done');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('091_organization_kyc failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
  await pool.end();
};

migrate();
