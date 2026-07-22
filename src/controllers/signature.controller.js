import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';

// One endpoint signs any receipt row. Strict allowlist: target → table +
// permission module. Only the two signature columns are writable here, so
// module-specific validation rules (e.g. vendor's required amount/date)
// stay untouched.
export const SIGN_TARGETS = {
  expense: {
    table: 'expenses',
    perm: 'expenses',
    siteQuery: 'SELECT site_id FROM expenses WHERE id = $1 LIMIT 1',
  },
  farmer_payment: {
    table: 'farmer_payments',
    perm: 'farmers',
    siteQuery: `SELECT f.site_id
                  FROM farmer_payments fp
                  JOIN farmers f ON f.id = fp.farmer_id
                 WHERE fp.id = $1
                 LIMIT 1`,
  },
  daybook: {
    table: 'day_book',
    perm: 'daybook',
    siteQuery: 'SELECT site_id FROM day_book WHERE id = $1 LIMIT 1',
  },
  vendor_payment: {
    table: 'vendor_payments',
    perm: 'vendors',
    siteQuery: 'SELECT site_id FROM vendor_payments WHERE id = $1 LIMIT 1',
  },
  plot_payment: {
    table: 'plot_payments',
    perm: 'plot_payments',
    siteQuery: 'SELECT site_id FROM plot_payments WHERE id = $1 LIMIT 1',
  },
  registry_payment: {
    table: 'plot_registry_payments',
    perm: 'plot_registry',
    siteQuery: 'SELECT site_id FROM plot_registry_payments WHERE id = $1 LIMIT 1',
  },
  commission_payment: {
    table: 'plot_commission_payments',
    perm: 'commissions',
    siteQuery: 'SELECT site_id FROM plot_commission_payments WHERE id = $1 LIMIT 1',
  },
  cashflow_entry: {
    table: 'cash_flow_entries',
    perm: 'cashflow',
    siteQuery: 'SELECT site_id FROM cash_flow_entries WHERE id = $1 LIMIT 1',
  },
};

const ADMIN_ROLES = new Set(['admin', 'super_admin']);

const requireTargetSiteAccess = async (req, res, target, id) => {
  const { rows } = await pool.query(target.siteQuery, [id]);
  if (!rows[0]) {
    res.status(404).json({ message: 'Record not found' });
    return false;
  }

  if (ADMIN_ROLES.has(req.user.role)) return true;

  const siteId = Number(rows[0].site_id);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    res.status(403).json({ message: 'Record is not linked to an accessible site' });
    return false;
  }

  const access = await pool.query(
    'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
    [req.user.id, siteId]
  );
  if (!access.rows[0]) {
    res.status(403).json({ message: 'Access denied to this site' });
    return false;
  }

  return true;
};

/**
 * PUT /signatures/:target/:id
 * Body: { customer_signature_url?, authority_signature_url? }
 */
export const saveSignatures = asyncHandler(async (req, res) => {
  const target = SIGN_TARGETS[req.params.target];
  if (!target) return res.status(400).json({ message: 'Unknown signature target' });
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid id' });

  if (!await requireTargetSiteAccess(req, res, target, id)) return;

  const { customer_signature_url, authority_signature_url } = req.body;
  const sets = [];
  const params = [];
  if (customer_signature_url !== undefined) {
    params.push(customer_signature_url || null);
    sets.push(`customer_signature_url = $${params.length}`);
  }
  if (authority_signature_url !== undefined) {
    params.push(authority_signature_url || null);
    sets.push(`authority_signature_url = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ message: 'Nothing to update' });
  params.push(id);

  const result = await pool.query(
    `UPDATE ${target.table} SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
    params
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Record not found' });
  res.json({ message: 'Signatures saved', id: result.rows[0].id });
});
