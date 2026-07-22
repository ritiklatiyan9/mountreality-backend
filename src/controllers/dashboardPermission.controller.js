/**
 * Dashboard Component Permissions Controller
 *
 * Manages which dashboard components each user (admin / sub-admin) can see.
 *
 * ALL_COMPONENTS — canonical list of dashboard component keys.
 * When a user has NO row for a component the default is allowed = true (open by default).
 * Admin / super_admin always see everything regardless of this table.
 */

import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';

export const ALL_COMPONENTS = [
  'financial_overview',
  'revenue_charts',
  'kpi_totalIncoming',
  'kpi_plotPayments',
  'kpi_registryPayments',
  'kpi_personalLedger',
  'kpi_totalExpense',
  'kpi_profit',
  'kpi_siteBalance',
  'cashflow_forecast',
  'expense_radar',
  'recent_transactions',
  'module_breakdown',
  'site_cashflow',
  'approvals',
  'member_search',
  'activity_card',
  'verify_panel',
];

// GET /dashboard-permissions/:userId
// Returns the component permissions for any user (admin / sub-admin).
export const getDashboardPermissions = asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId);
  if (!userId) return res.status(400).json({ message: 'Invalid userId' });

  const { rows } = await pool.query(
    `SELECT component, allowed
     FROM dashboard_component_permissions
     WHERE user_id = $1`,
    [userId]
  );

  // Build a full map; components not in DB default to allowed = true
  const map = {};
  for (const comp of ALL_COMPONENTS) map[comp] = true;
  for (const row of rows) map[row.component] = row.allowed;

  res.json({ userId, permissions: map });
});

// GET /dashboard-permissions/me — used by the logged-in user themselves
export const getMyDashboardPermissions = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const { rows } = await pool.query(
    `SELECT component, allowed
     FROM dashboard_component_permissions
     WHERE user_id = $1`,
    [userId]
  );

  const map = {};
  for (const comp of ALL_COMPONENTS) map[comp] = true;
  for (const row of rows) map[row.component] = row.allowed;

  res.json({ userId, permissions: map });
});

// PUT /dashboard-permissions/:userId
// Body: { permissions: { kpi_profit: true, revenue_charts: false, ... } }
export const updateDashboardPermissions = asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId);
  if (!userId) return res.status(400).json({ message: 'Invalid userId' });

  const { permissions } = req.body;
  if (!permissions || typeof permissions !== 'object') {
    return res.status(400).json({ message: 'permissions object is required' });
  }

  // Validate keys
  const invalid = Object.keys(permissions).filter(k => !ALL_COMPONENTS.includes(k));
  if (invalid.length > 0) {
    return res.status(400).json({ message: `Unknown component(s): ${invalid.join(', ')}` });
  }

  // Upsert each entry
  const entries = Object.entries(permissions);
  if (entries.length === 0) {
    return res.json({ message: 'No changes' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [component, allowed] of entries) {
      await client.query(
        `INSERT INTO dashboard_component_permissions (user_id, component, allowed, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, component) DO UPDATE
           SET allowed = EXCLUDED.allowed, updated_at = NOW()`,
        [userId, component, Boolean(allowed)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Return updated full map
  const { rows } = await pool.query(
    `SELECT component, allowed FROM dashboard_component_permissions WHERE user_id = $1`,
    [userId]
  );
  const map = {};
  for (const comp of ALL_COMPONENTS) map[comp] = true;
  for (const row of rows) map[row.component] = row.allowed;

  res.json({ userId, permissions: map, message: 'Dashboard permissions updated' });
});

// GET /dashboard-permissions/users — list all users (admin + sub-admin) with their component counts
export const listUsersWithDashboardPermissions = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       u.id, u.name, u.email, u.role,
       COUNT(dcp.component) FILTER (WHERE dcp.allowed = false) AS restricted_count
     FROM users u
     LEFT JOIN dashboard_component_permissions dcp ON dcp.user_id = u.id
     WHERE u.role IN ('admin', 'sub_admin') AND u.is_active = true
     GROUP BY u.id, u.name, u.email, u.role
     ORDER BY u.role, u.name`
  );
  res.json({ users: rows });
});
