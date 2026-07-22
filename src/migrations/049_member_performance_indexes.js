import pool from '../config/db.js';

// Adds composite + partial indexes that speed up the User Management module:
//   - Phone duplicate-check now uses a partial index on (site_id, phone)
//     so duplicate-phone validation is O(log N) and free of full table scans.
//     A non-unique index is used because legacy data may already contain
//     duplicate (site_id, phone) rows (e.g. internal placeholder values
//     like 'A-5'). Application code in member.controller.js already
//     enforces uniqueness for new writes.
//   - (site_id, member_type, status) accelerates filter-driven listing.
//   - Expression indexes on UPPER(...) cover the case-insensitive name lookups
//     done by member-financial-info / member-transactions.
//
// All indexes are CREATE INDEX IF NOT EXISTS so the migration is idempotent.
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Partial (non-unique) index for fast phone-duplicate lookup within a site.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_members_site_phone_lookup
        ON members(site_id, phone)
        WHERE phone IS NOT NULL
    `);

    // 2. Filter-friendly composite for the table view.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_members_site_type_status
        ON members(site_id, member_type, status)
    `);

    // 3. Status filter on its own (used for summary card counts).
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_members_site_status
        ON members(site_id, status)
    `);

    // 4. Recency ordering helper.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_members_site_created_at
        ON members(site_id, created_at DESC)
    `);

    // 5. Case-insensitive name lookups used by getMemberFinancialInfo /
    //    getMemberTransactions (UPPER(to_entity) = UPPER(name) etc).
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_members_site_full_name_upper
        ON members(site_id, UPPER(full_name))
    `);

    // 6. member_categories.slug is already UNIQUE (PK in migration 003) but
    //    the lookup-by-slug path is the only access pattern, so make sure it's
    //    a covering index.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_member_categories_slug
        ON member_categories(slug)
    `);

    await client.query('COMMIT');
    console.log('Migration 049_member_performance_indexes complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 049_member_performance_indexes failed:', err);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
