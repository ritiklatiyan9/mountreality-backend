import pool from '../config/db.js';

export default async function migrateExpenseIndexes() {
    try {
        await pool.query(`
      -- Expenses indexes
      CREATE INDEX IF NOT EXISTS idx_expenses_site_date ON expenses (site_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_expenses_site_created ON expenses (site_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_expenses_site_mode ON expenses (site_id, payment_mode);
      CREATE INDEX IF NOT EXISTS idx_expenses_site_category ON expenses (site_id, category);
      CREATE INDEX IF NOT EXISTS idx_expenses_site_to ON expenses (site_id, to_entity);

      -- Day Book indexes
      CREATE INDEX IF NOT EXISTS idx_daybook_site_type ON day_book (site_id, entry_type);
      CREATE INDEX IF NOT EXISTS idx_daybook_site_date ON day_book (site_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_daybook_site_type_date ON day_book (site_id, entry_type, date DESC);
      CREATE INDEX IF NOT EXISTS idx_daybook_site_date_exact ON day_book (site_id, date);

      -- Farmer payments indexes
      CREATE INDEX IF NOT EXISTS idx_farmer_payments_site_date ON farmer_payments (farmer_id, date);

      -- Plot commissions indexes
      CREATE INDEX IF NOT EXISTS idx_plot_commissions_site_date ON plot_commissions (site_id, date);

      -- Cash flow entries indexes
      CREATE INDEX IF NOT EXISTS idx_cf_entries_site_date ON cash_flow_entries (site_id, date);

      -- Firm transactions indexes
      CREATE INDEX IF NOT EXISTS idx_firm_txn_site_date ON firm_transactions (site_id, date);

      -- Plot payments indexes
      CREATE INDEX IF NOT EXISTS idx_plot_payments_site_date ON plot_payments (site_id, date);
    `);
        console.log('✓ expense & daybook performance indexes ready');
    } catch (err) {
        console.error('✗ indexes migration failed:', err.message);
    }
}
