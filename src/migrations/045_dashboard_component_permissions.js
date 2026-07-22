/**
 * Migration 045 — Dashboard Component Permissions
 *
 * Creates a table to store per-user access to individual dashboard components.
 * Each row = one user + one component + allowed flag.
 *
 * Components tracked:
 *   financial_overview      – KPI cards row (Total Incoming, Expenses, Profit, Site Balance)
 *   revenue_charts          – Revenue vs Expense & Profit Trend charts
 *   kpi_totalIncoming       – Total Incoming card
 *   kpi_plotPayments        – Plot Payments card
 *   kpi_personalLedger      – Personal Ledger card
 *   kpi_totalExpense        – Total Expenses card
 *   kpi_profit              – Profit card
 *   kpi_siteBalance         – Site Balance card
 *   expense_radar           – Expense by Category Radar chart
 *   recent_transactions     – Recent Transactions table
 *   module_breakdown        – Module Breakdown sidebar widget
 *   site_cashflow           – Site Cash Flow summary widget
 *   approvals               – Approvals / Edit-requests widget
 *   member_search           – Global member search bar
 *   activity_card           – Activity Card widget
 *   verify_panel            – Data Consistency Verification panel
 */

import pool from '../config/db.js';

export async function up() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dashboard_component_permissions (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      component   VARCHAR(60) NOT NULL,
      allowed     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, component)
    );

    CREATE INDEX IF NOT EXISTS idx_dcp_user_id ON dashboard_component_permissions(user_id);
  `);
  console.log('Migration 045: dashboard_component_permissions table created.');
}

export async function down() {
  await pool.query(`DROP TABLE IF EXISTS dashboard_component_permissions;`);
  console.log('Migration 045: dashboard_component_permissions table dropped.');
}
