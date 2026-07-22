import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 069 — Document Management System (DMS) search layer.
 *
 * SAFETY: additive + idempotent. Adds nullable columns/indexes to the shared
 * `documents` table. Legacy DMS rows without a site remain quarantined until
 * an administrator explicitly reviews and assigns them. Never drops data.
 * Re-runnable.
 *
 * What it adds:
 *   - metadata     JSONB  — flexible tag store (khatauni: village/khata/khasra/owner;
 *                           agreement/registry: buyer/seller/plot_no/project/…). One column
 *                           instead of a dozen sparse ones — different doc types, different keys.
 *   - ocr_text     TEXT   — full extracted text (Hindi + English) written by the OCR pipeline.
 *   - doc_date     DATE   — the document's own date (agreement/registry date), for range filters.
 *   - expiry_date  DATE   — validity/expiry, for "expiring soon" filters.
 *   - search_tsv   tsvector GENERATED — title + filename + category + ocr_text + metadata values,
 *                           'simple' config (no stemmer, so Devanagari + English + digits all index).
 *   - pg_trgm extension + GIN indexes → Google-like full-text + fuzzy/substring, no Elasticsearch.
 *
 * ponytail: PostgreSQL FTS over Elasticsearch — the DB is already here, 'simple' + prefix tsquery
 * covers mixed Hindi/English keyword search. Add ES only if cross-corpus relevance tuning is needed.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: ref } = await client.query(
      `SELECT to_regclass('public.documents') IS NOT NULL AS has_documents`
    );
    if (!ref[0].has_documents) {
      throw new Error('Shared `documents` table missing — run booking migration 001 + account 059 first.');
    }

    await client.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS metadata    JSONB`);
    await client.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS ocr_text    TEXT`);
    await client.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_date    DATE`);
    await client.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS expiry_date DATE`);

    // Do not infer ownership for legacy DMS rows. A user or installation can
    // gain another site after this migration runs, making a once-single-site
    // heuristic timing-dependent and impossible to audit. NULL is an explicit
    // quarantine state handled by the admin review endpoints.

    // Trigram accelerates the ILIKE fallback, but managed PostgreSQL roles do
    // not always have CREATE EXTENSION privileges. Search remains correct
    // without it, so keep startup usable and skip only the optional index.
    let hasPgTrgm = false;
    await client.query('SAVEPOINT dms_pg_trgm');
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      const { rows } = await client.query(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS installed"
      );
      hasPgTrgm = rows[0]?.installed === true;
      await client.query('RELEASE SAVEPOINT dms_pg_trgm');
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT dms_pg_trgm');
      await client.query('RELEASE SAVEPOINT dms_pg_trgm');
      console.warn(`pg_trgm unavailable; continuing without trigram index: ${error.message}`);
    }

    // Generated, always-in-sync search vector. jsonb_to_tsvector pulls the metadata VALUES
    // (not the {"key":…} punctuation) so a search for "412" or a village name hits the tag too.
    // Both to_tsvector('simple', …) and jsonb_to_tsvector('simple', …, …) are IMMUTABLE, so this
    // is a valid STORED generated column.
    // ponytail: STORED col rewrites `documents` once on add (brief lock) — fine at office scale;
    // switch to a trigger-maintained column only if the table grows into the millions.
    await client.query(`
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS search_tsv tsvector
      GENERATED ALWAYS AS (
        to_tsvector('simple',
          coalesce(title,'')         || ' ' ||
          coalesce(original_name,'') || ' ' ||
          coalesce(category,'')      || ' ' ||
          coalesce(ocr_text,''))
        || jsonb_to_tsvector('simple', coalesce(metadata, '{}'::jsonb), '["string", "numeric"]')
      ) STORED
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_documents_search_tsv ON documents USING gin (search_tsv)`);
    if (hasPgTrgm) {
      await client.query(`CREATE INDEX IF NOT EXISTS idx_documents_ocr_trgm ON documents USING gin (ocr_text gin_trgm_ops)`);
    }
    await client.query(`CREATE INDEX IF NOT EXISTS idx_documents_category   ON documents (category)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_documents_doc_date   ON documents (doc_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_documents_expiry     ON documents (expiry_date)`);
    // DMS-scoped listing (uploaded_source='DMS') stays cheap.
    await client.query(`CREATE INDEX IF NOT EXISTS idx_documents_source     ON documents (uploaded_source)`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_dms_site_created
      ON documents (site_id, created_at DESC)
      WHERE uploaded_source = 'DMS'
    `);

    await client.query('COMMIT');
    console.log('Migration 069_dms_documents complete (metadata/ocr_text/dates + FTS tsvector + trigram indexes)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 069_dms_documents failed (rolled back, no changes):', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
