import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { imprestLedgerModel } from '../models/Imprest.model.js';
import { normalizeCashType } from '../utils/paymentMode.js';

/**
 * Unified approval controller for all financial modules.
 * Handles approving/rejecting entries across:
 *   farmer_payments, plot_commissions, cash_flow_entries,
 *   firm_transactions, plot_payments, expenses, day_book
 */

const ALLOWED_TABLES = {
  farmer_payment: 'farmer_payments',
  plot_commission: 'plot_commissions', // Legacy
  plot_commission_payment: 'plot_commission_payments', // New v2
  cash_flow_entry: 'cash_flow_entries',
  firm_transaction: 'firm_transactions',
  plot_payment: 'plot_payments',
  expense: 'expenses',
  daybook: 'day_book',
  daybook_farmer: 'day_book',
  daybook_commission: 'day_book',
  daybook_expense: 'day_book',
  daybook_general: 'day_book',
};

function getTableName(source) {
  const table = ALLOWED_TABLES[source];
  if (!table) throw new Error(`Invalid source: ${source}`);
  return table;
}

const directSiteSources = new Set([
  'plot_commission', 'plot_commission_payment', 'cash_flow_entry',
  'firm_transaction', 'plot_payment', 'expense', 'daybook',
  'daybook_farmer', 'daybook_commission', 'daybook_expense',
  'daybook_general', 'vendor_payment',
]);

async function resolveApprovalSite(source, entryId, db = pool) {
  if (source === 'farmer_payment') {
    const { rows } = await db.query(
      `SELECT f.site_id FROM farmer_payments fp
        JOIN farmers f ON f.id=fp.farmer_id WHERE fp.id=$1 LIMIT 1`,
      [entryId]
    );
    return rows[0]?.site_id || null;
  }
  if (!directSiteSources.has(source)) return null;
  const table = ALLOWED_TABLES[source] || CHEQUE_TABLES[source];
  const { rows } = await db.query(`SELECT site_id FROM ${table} WHERE id=$1 LIMIT 1`, [entryId]);
  return rows[0]?.site_id || null;
}

async function assertApprovalSiteAccess(req, res, source, entryId, db = pool) {
  const siteId = Number(await resolveApprovalSite(source, entryId, db));
  if (!Number.isInteger(siteId) || siteId <= 0) {
    res.status(404).json({ message: 'Entry not found' });
    return null;
  }
  if (req.siteContextId && Number(req.siteContextId) !== siteId) {
    res.status(409).json({ code: 'SITE_CONTEXT_MISMATCH', message: 'Selected site does not match the requested record' });
    return null;
  }
  const { rows } = await db.query(
    `SELECT s.id FROM sites s
      WHERE s.id=$1 AND s.organization_id=$2
        AND ($3::boolean = FALSE OR EXISTS (
          SELECT 1 FROM user_sites us WHERE us.site_id=s.id AND us.user_id=$4
        ))
      LIMIT 1`,
    [siteId, req.user.organization_id, req.user.role === 'sub_admin', req.user.id]
  );
  if (!rows[0]) {
    res.status(404).json({ message: 'Entry not found' });
    return null;
  }
  req.siteContextId = siteId;
  return siteId;
}

const imprestSourceModule = (source) => ({
  expense: 'expenses', farmer_payment: 'farmer_payments',
  plot_commission: 'plot_commissions', plot_commission_payment: 'plot_commission_payments',
  vendor_payment: 'vendor_payments',
}[source] || (String(source).startsWith('daybook') ? 'day_book' : source));

async function postApprovalImprest({ entry, source, actorId, reverse = false, db }) {
  const eligible = new Set(['expense', 'farmer_payment', 'plot_commission_payment', 'vendor_payment', 'daybook', 'daybook_farmer', 'daybook_commission', 'daybook_expense', 'daybook_general']);
  if (!eligible.has(source)) return;
  const amount = Number(entry.debit || entry.amount) || 0;
  if (amount <= 0 || !entry.created_by) return;
  const user = await db.query('SELECT role FROM users WHERE id=$1 LIMIT 1', [entry.created_by]);
  if (user.rows[0]?.role !== 'sub_admin') return;
  const siteId = entry.site_id || await resolveApprovalSite(source, entry.id, db);
  const sourceModule = imprestSourceModule(source);
  if (reverse) {
    const deduction = await db.query(
      `SELECT 1 FROM imprest_ledger
        WHERE user_id=$1 AND COALESCE(site_id,0)=COALESCE($2::int,0)
          AND source_module=$3 AND reference_id=$4 AND type='EXPENSE' AND amount<0 LIMIT 1`,
      [entry.created_by, siteId, sourceModule, entry.id]
    );
    if (!deduction.rows[0]) return;
  }
  await imprestLedgerModel.createEntry({
    user_id: entry.created_by,
    site_id: siteId,
    type: reverse ? 'ADJUSTMENT' : 'EXPENSE',
    source_module: sourceModule,
    reference_id: entry.id,
    amount: reverse ? amount : -amount,
    remarks: `${reverse ? 'REVERSED (REJECTED): ' : ''}${source.toUpperCase()} #${entry.id}`,
    created_by: actorId,
  }, db);
}

function requireApprovalSite(req, res) {
  const siteId = Number.parseInt(req.query.site_id, 10);
  if (!Number.isInteger(siteId) || siteId <= 0 || Number(req.siteContextId) !== siteId) {
    res.status(400).json({ message: 'A valid selected site_id is required' });
    return null;
  }
  return siteId;
}

async function ensureInboundFirmTransferForApproval(entry, approverId, db = pool) {
  if (!entry) return;
  if ((entry.transfer_direction || '').toUpperCase() !== 'OUT') return;
  if (!entry.transfer_group_id || !entry.transfer_to_site_id || !entry.transfer_to_firm_id) {
    throw new Error('Firm transfer is missing its target or transfer-group identity');
  }

  const alreadyCreated = await db.query(
    `SELECT id FROM firm_transactions WHERE transfer_group_id = $1 AND transfer_direction = 'IN' LIMIT 1`,
    [entry.transfer_group_id]
  );

  const sourceFirmRes = await db.query(`SELECT id, name FROM firms WHERE id = $1`, [entry.firm_id]);
  const targetFirmRes = await db.query(`SELECT id, name, site_id FROM firms WHERE id = $1`, [entry.transfer_to_firm_id]);

  const sourceFirm = sourceFirmRes.rows[0];
  const targetFirm = targetFirmRes.rows[0];
  if (!sourceFirm || !targetFirm) throw new Error('Firm transfer source or target no longer exists');
  if (parseInt(targetFirm.site_id) !== parseInt(entry.transfer_to_site_id)) {
    throw new Error('Firm transfer target does not belong to the recorded site');
  }

  const transferAmount = Math.max(parseFloat(entry.debit) || 0, parseFloat(entry.credit) || 0);
  if (transferAmount <= 0) throw new Error('Firm transfer amount must be greater than zero');

  const paymentMode = normalizeCashType(entry.payment_mode);
  const chequeStatus = paymentMode === 'cheque' ? (entry.cheque_status || 'PENDING') : null;

  if (alreadyCreated.rows[0]) {
    await db.query(
      `UPDATE firm_transactions
          SET firm_id = $1,
              site_id = $2,
              date = $3,
              description = $4,
              payment_mode = $5,
              debit = 0,
              credit = $6,
              name = $7,
              purpose = $8,
              remark = $9,
              cheque_no = $10,
              cheque_status = $11,
              voucher_url = $12,
              assigned_admin_id = $13,
              status = 'approved',
              approved_by = $14,
              approved_at = NOW(),
              updated_at = NOW()
        WHERE id = $15`,
      [
        targetFirm.id,
        targetFirm.site_id,
        entry.date,
        `TRANSFER FROM ${sourceFirm.name}${entry.description ? ` - ${entry.description}` : ''}`,
        paymentMode,
        transferAmount,
        sourceFirm.name,
        entry.purpose || 'FIRM TO FIRM TRANSFER',
        entry.remark || 'FIRM TO FIRM TRANSFER',
        paymentMode === 'cheque' ? entry.cheque_no || null : null,
        chequeStatus,
        entry.voucher_url || null,
        entry.assigned_admin_id || null,
        approverId,
        alreadyCreated.rows[0].id,
      ]
    );
    return;
  }

  await db.query(
    `INSERT INTO firm_transactions (
      firm_id,
      site_id,
      date,
      description,
      payment_mode,
      debit,
      credit,
      name,
      purpose,
      remark,
      cheque_no,
      cheque_status,
      created_by,
      voucher_url,
      assigned_admin_id,
      status,
      approved_by,
      approved_at,
      is_firm_to_firm_transfer,
      transfer_to_site_id,
      transfer_to_firm_id,
      transfer_group_id,
      transfer_direction
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'approved',$16,NOW(),true,$17,$18,$19,'IN'
    )
    ON CONFLICT (transfer_group_id, transfer_direction)
      WHERE transfer_group_id IS NOT NULL AND transfer_direction IN ('OUT', 'IN')
    DO UPDATE SET
      firm_id = EXCLUDED.firm_id,
      site_id = EXCLUDED.site_id,
      date = EXCLUDED.date,
      description = EXCLUDED.description,
      payment_mode = EXCLUDED.payment_mode,
      debit = EXCLUDED.debit,
      credit = EXCLUDED.credit,
      name = EXCLUDED.name,
      purpose = EXCLUDED.purpose,
      remark = EXCLUDED.remark,
      cheque_no = EXCLUDED.cheque_no,
      cheque_status = EXCLUDED.cheque_status,
      voucher_url = EXCLUDED.voucher_url,
      assigned_admin_id = EXCLUDED.assigned_admin_id,
      status = EXCLUDED.status,
      approved_by = EXCLUDED.approved_by,
      approved_at = EXCLUDED.approved_at,
      transfer_to_site_id = EXCLUDED.transfer_to_site_id,
      transfer_to_firm_id = EXCLUDED.transfer_to_firm_id,
      updated_at = NOW()`,
    [
      targetFirm.id,
      targetFirm.site_id,
      entry.date,
      `TRANSFER FROM ${sourceFirm.name}${entry.description ? ` - ${entry.description}` : ''}`,
      paymentMode,
      0,
      transferAmount,
      sourceFirm.name,
      entry.purpose || 'FIRM TO FIRM TRANSFER',
      entry.remark || 'FIRM TO FIRM TRANSFER',
      paymentMode === 'cheque' ? entry.cheque_no || null : null,
      chequeStatus,
      entry.created_by || null,
      entry.voucher_url || null,
      entry.assigned_admin_id || null,
      approverId,
      entry.site_id,
      entry.firm_id,
      entry.transfer_group_id,
    ]
  );
}

/**
 * For sub-admins, fetch allowed approval modules from user_approval_modules.
 * Admins get null (meaning all modules allowed).
 */
async function getAllowedModules(user) {
  if (user.role === 'admin' || user.role === 'super_admin') return null; // all allowed
  try {
    const result = await pool.query(
      'SELECT module FROM user_approval_modules WHERE user_id = $1',
      [user.id]
    );
    return new Set(result.rows.map(r => r.module));
  } catch {
    // Table may not exist yet — deny all
    return new Set();
  }
}

/** Check if a module key is allowed (handles daybook sub-types too) */
function isModuleAllowed(allowed, moduleKey) {
  if (!allowed) return true; // admin — all allowed
  // daybook sub-types → check the 'daybook' module
  if (moduleKey === 'daybook_farmer' || moduleKey === 'daybook_commission' || moduleKey === 'daybook_expense' || moduleKey === 'daybook_general') {
    return allowed.has('daybook');
  }
  return allowed.has(moduleKey);
}

/**
 * Decide whether a sub-admin's pending-list query should include a module at all,
 * and whether it should be scoped to "assigned to me" rows only.
 *   - admin / super_admin → { include: true, scoped: false } (always full access)
 *   - sub-admin with module grant → { include: true, scoped: false }
 *   - sub-admin WITHOUT module grant → { include: true, scoped: true }
 *     (they still see entries delegated specifically to them)
 * `scoped: true` means the caller should add `AND <alias>.assigned_admin_id = user.id`.
 */
function moduleVisibility(user, allowed, moduleKey) {
  if (!allowed) return { include: true, scoped: false };
  if (isModuleAllowed(allowed, moduleKey)) return { include: true, scoped: false };
  return { include: true, scoped: true };
}

/**
 * GET /approvals/pending
 * List all pending entries across all modules.
 * Sub-admins only see modules they've been granted.
 */
export const listAllPending = asyncHandler(async (req, res) => {
  const { site_id, date_from, date_to, module, assigned_admin_id } = req.query;
  if (!requireApprovalSite(req, res)) return;
  const allowedModules = await getAllowedModules(req.user);

  const results = [];

  // Helper to build WHERE clause.
  //   scopedAssigneeId: when set, forces assigned_admin_id = that user (used for sub-admins who
  //   don't hold a module grant but still need to see entries explicitly delegated to them).
  const buildWhere = (tableAlias, siteAlias, extraConditions = [], scopedAssigneeId = null) => {
    const sAlias = siteAlias || tableAlias;
    const conditions = [`${tableAlias}.status = 'pending'`, ...extraConditions];
    const params = [];
    let idx = 1;
    if (site_id) {
      conditions.push(`${sAlias}.site_id = $${idx++}`);
      params.push(parseInt(site_id));
    }
    if (date_from) {
      conditions.push(`${tableAlias}.date >= $${idx++}`);
      params.push(date_from);
    }
    if (date_to) {
      conditions.push(`${tableAlias}.date <= $${idx++}`);
      params.push(date_to);
    }
    if (scopedAssigneeId) {
      conditions.push(`${tableAlias}.assigned_admin_id = $${idx++}`);
      params.push(parseInt(scopedAssigneeId));
    } else if (assigned_admin_id) {
      if (assigned_admin_id === 'unassigned') {
        conditions.push(`${tableAlias}.assigned_admin_id IS NULL`);
      } else {
        conditions.push(`${tableAlias}.assigned_admin_id = $${idx++}`);
        params.push(parseInt(assigned_admin_id));
      }
    }
    return { where: conditions.join(' AND '), params };
  };

  // 1. Farmer Payments (from farmer_payments table)
  const visFp = moduleVisibility(req.user, allowedModules, 'farmer_payment');
  if ((!module || module === 'farmer_payment') && visFp.include) {
    const { where, params } = buildWhere('fp', 'f', [], visFp.scoped ? req.user.id : null);
    const q = `
                  SELECT fp.*, f.name AS farmer_name, f.site_id,
                    f.name AS entity_name, 'Farmer / land owner'::text AS entity_type,
                    f.phone AS entity_phone, f.address AS entity_address,
                    NULL::text AS entity_plot_no,
                    s.name AS site_name, COALESCE(u.name, u.email) AS created_by_name,
                    COALESCE(aa.name, aa.email) AS assigned_admin_name,
             'farmer_payment' AS source
      FROM farmer_payments fp
      JOIN farmers f ON fp.farmer_id = f.id
      JOIN sites s ON f.site_id = s.id
      LEFT JOIN users u ON fp.created_by = u.id
            LEFT JOIN users aa ON fp.assigned_admin_id = aa.id
      WHERE ${where}
      ORDER BY fp.date DESC, fp.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map(row => ({
      ...row,
      entry_label: `${row.farmer_name} - ₹${row.amount}`,
      module_label: 'Farmer Payment',
    })));
  }

  // 2. Plot Commissions (Legacy)
  const visPc = moduleVisibility(req.user, allowedModules, 'plot_commission');
  if ((!module || module === 'plot_commission') && visPc.include) {
    const { where, params } = buildWhere('pc', 'pc', [], visPc.scoped ? req.user.id : null);
    const q = `
                  SELECT pc.*, pc.particular AS entity_name,
                    'Commission recipient'::text AS entity_type,
                    pc.plot_no AS entity_plot_no, pc.father_name AS entity_secondary,
                    s.name AS site_name, COALESCE(u.name, u.email) AS created_by_name,
                    COALESCE(aa.name, aa.email) AS assigned_admin_name,
             'plot_commission' AS source
      FROM plot_commissions pc
      JOIN sites s ON pc.site_id = s.id
      LEFT JOIN users u ON pc.created_by = u.id
            LEFT JOIN users aa ON pc.assigned_admin_id = aa.id
      WHERE ${where}
      ORDER BY pc.date DESC, pc.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map(row => ({
      ...row,
      entry_label: `${row.particular} - ₹${row.amount}`,
      module_label: 'Plot Commission (Legacy)',
    })));
  }

  // 2.5 Plot Commission Payments (V2)
  const visPcp = moduleVisibility(req.user, allowedModules, 'plot_commission_payment');
  if ((!module || module === 'plot_commission_payment') && visPcp.include) {
    const { where, params } = buildWhere('pcp', 'pcp', [], visPcp.scoped ? req.user.id : null);
    const q = `
                  SELECT pcp.*, s.name AS site_name, COALESCE(u.name, u.email) AS created_by_name,
                    COALESCE(aa.name, aa.email) AS assigned_admin_name,
             p.plot_no, p.buyer_name, ag.full_name AS agent_name,
             ag.full_name AS entity_name, 'Commission agent'::text AS entity_type,
             p.plot_no AS entity_plot_no, p.buyer_name AS entity_secondary,
             'plot_commission_payment' AS source
      FROM plot_commission_payments pcp
      JOIN sites s ON pcp.site_id = s.id
      JOIN plot_commissions_v2 pcm ON pcp.plot_commission_id = pcm.id
      JOIN plots p ON pcm.plot_id = p.id
      JOIN members ag ON pcm.agent_id = ag.id
      LEFT JOIN users u ON pcp.created_by = u.id
            LEFT JOIN users aa ON pcp.assigned_admin_id = aa.id
      WHERE ${where}
      ORDER BY pcp.date DESC, pcp.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map(row => ({
      ...row,
      entry_label: `${row.agent_name} (Plot ${row.plot_no}) - ₹${row.amount}`,
      module_label: 'Plot Commission payment',
    })));
  }

  // 3. Cash Flow Entries (exclude trigger-synced duplicates from other modules)
  const visCfe = moduleVisibility(req.user, allowedModules, 'cash_flow_entry');
  if ((!module || module === 'cash_flow_entry') && visCfe.include) {
    const { where, params } = buildWhere('cfe', 'cfe', [], visCfe.scoped ? req.user.id : null);
    const q = `
                  SELECT cfe.*, cfe.site_id, s.name AS site_name, COALESCE(u.name, u.email) AS created_by_name,
                    COALESCE(aa.name, aa.email) AS assigned_admin_name,
             cfm.ledger_name, cfm.month, cfm.year, cfm.linked_user_id,
             lu.name AS linked_user_name, lu.email AS linked_user_email,
             COALESCE(lu.name, tf.name, cfe.to_name, ff.name, NULLIF(TRIM(cfm.ledger_name), ''), u.name, u.email, cfe.particular) AS entity_name,
             CASE
               WHEN lu.id IS NOT NULL THEN 'Mapped ledger user'
               WHEN tf.id IS NOT NULL OR ff.id IS NOT NULL THEN 'Firm / account'
               WHEN cfe.to_name IS NOT NULL THEN 'Ledger party'
               ELSE 'Personal ledger'
             END AS entity_type,
             COALESCE(lu.email, cfe.to_name, tf.name, ff.name) AS entity_secondary,
             NULL::text AS entity_plot_no,
             'cash_flow_entry' AS source
      FROM cash_flow_entries cfe
      JOIN sites s ON cfe.site_id = s.id
      JOIN cash_flow_months cfm ON cfe.cash_flow_month_id = cfm.id
      LEFT JOIN users lu ON lu.id = cfm.linked_user_id
      LEFT JOIN firms ff ON ff.id = cfe.from_firm_id
      LEFT JOIN firms tf ON tf.id = cfe.to_firm_id
      LEFT JOIN users u ON cfe.created_by = u.id
            LEFT JOIN users aa ON cfe.assigned_admin_id = aa.id
      WHERE ${where}
        AND NULLIF(TRIM(COALESCE(cfe.source_module, '')), '') IS NULL
      ORDER BY cfe.date DESC, cfe.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map(row => ({
      ...row,
      entry_label: `${row.particular} - Dr:₹${row.debit} Cr:₹${row.credit}`,
      module_label: 'Cash Flow',
    })));
  }

  // 4. Firm Transactions
  const visFt = moduleVisibility(req.user, allowedModules, 'firm_transaction');
  if ((!module || module === 'firm_transaction') && visFt.include) {
    const { where, params } = buildWhere('ft', 'ft', [], visFt.scoped ? req.user.id : null);
    const q = `
                  SELECT ft.*, s.name AS site_name, COALESCE(u.name, u.email) AS created_by_name,
                    COALESCE(aa.name, aa.email) AS assigned_admin_name,
             fi.name AS firm_name,
             ts.name AS transfer_to_site_name,
             tf.name AS transfer_to_firm_name,
             COALESCE(ft.name, tf.name, fi.name) AS entity_name,
             CASE WHEN ft.is_firm_to_firm_transfer THEN 'Firm transfer' ELSE 'Firm transaction party' END AS entity_type,
             fi.name AS entity_secondary, NULL::text AS entity_plot_no,
             'firm_transaction' AS source
      FROM firm_transactions ft
      JOIN sites s ON ft.site_id = s.id
      JOIN firms fi ON ft.firm_id = fi.id
      LEFT JOIN sites ts ON ts.id = ft.transfer_to_site_id
      LEFT JOIN firms tf ON tf.id = ft.transfer_to_firm_id
      LEFT JOIN users u ON ft.created_by = u.id
            LEFT JOIN users aa ON ft.assigned_admin_id = aa.id
      WHERE ${where}
      ORDER BY ft.date DESC, ft.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map(row => ({
      ...row,
      entry_label: row.is_firm_to_firm_transfer
        ? `${row.firm_name} -> ${row.transfer_to_firm_name || row.name || 'Target'} (${row.transfer_to_site_name || 'Site'}) - ₹${parseFloat(row.debit) || parseFloat(row.credit) || 0}`
        : `${row.firm_name}: ${row.description} - Dr:₹${row.debit} Cr:₹${row.credit}`,
      module_label: 'Firm Transaction',
    })));
  }

  // 5. Plot Payments
  const visPp = moduleVisibility(req.user, allowedModules, 'plot_payment');
  if ((!module || module === 'plot_payment') && visPp.include) {
    const { where, params } = buildWhere('pp', 'pp', [], visPp.scoped ? req.user.id : null);
    const q = `
                  SELECT pp.*, pp.payment_type AS payment_mode, s.name AS site_name, COALESCE(u.name, u.email) AS created_by_name,
                    COALESCE(aa.name, aa.email) AS assigned_admin_name,
             p.plot_no, COALESCE(pp.buyer_name, p.buyer_name) AS buyer_name,
             COALESCE(pp.buyer_name, p.buyer_name, pp.payment_from, u.name, u.email, 'Plot ' || p.plot_no) AS entity_name,
             'Plot buyer / payer'::text AS entity_type,
             p.plot_no AS entity_plot_no, pp.payment_from AS entity_secondary,
             'plot_payment' AS source
      FROM plot_payments pp
      JOIN sites s ON pp.site_id = s.id
      JOIN plots p ON pp.plot_id = p.id
      LEFT JOIN users u ON pp.created_by = u.id
            LEFT JOIN users aa ON pp.assigned_admin_id = aa.id
      WHERE ${where}
      ORDER BY pp.date DESC, pp.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map(row => ({
      ...row,
      entry_label: `Plot ${row.plot_no} (${row.buyer_name || 'N/A'}) - ₹${row.amount}`,
      module_label: 'Plot Payment',
    })));
  }

  // 6. Expenses
  const visEx = moduleVisibility(req.user, allowedModules, 'expense');
  if ((!module || module === 'expense') && visEx.include) {
    const { where, params } = buildWhere('e', 'e', [], visEx.scoped ? req.user.id : null);
    const q = `
                  SELECT e.*, s.name AS site_name, COALESCE(u.name, u.email) AS created_by_name,
                    COALESCE(aa.name, aa.email) AS assigned_admin_name,
             COALESCE(em.full_name, e.to_entity, e.from_entity, u.name, u.email) AS entity_name,
             CASE
               WHEN em.id IS NOT NULL THEN COALESCE(em.member_type, 'Member')
               WHEN e.to_entity IS NOT NULL OR e.from_entity IS NOT NULL THEN 'Expense party'
               ELSE 'Request creator (party not recorded)'
             END AS entity_type,
             COALESCE(e.category, e.from_entity) AS entity_secondary,
             NULL::text AS entity_plot_no,
             'expense' AS source
      FROM expenses e
      JOIN sites s ON e.site_id = s.id
      LEFT JOIN users u ON e.created_by = u.id
      LEFT JOIN members em ON em.id = e.assigned_user_id
            LEFT JOIN users aa ON e.assigned_admin_id = aa.id
      WHERE ${where}
      ORDER BY e.date DESC, e.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map(row => ({
      ...row,
      entry_label: `${row.to_entity || row.remark || 'Expense'} - Dr:₹${row.debit} Cr:₹${row.credit}`,
      module_label: 'Expense',
    })));
  }

  // 7. Day Book entries (farmer payments, commissions, expenses auto-created in day_book)
  const visDb = moduleVisibility(req.user, allowedModules, 'daybook');
  if (visDb.include) {
    const DAYBOOK_TYPE_MAP = {
      'FARMER PAYMENT': 'daybook_farmer',
      'PLOT COMMISSION': 'daybook_commission',
      'EXPENSE': 'daybook_expense',
      'GENERAL': 'daybook_general',
    };
    const DAYBOOK_LABEL_MAP = {
      'FARMER PAYMENT': 'Farmer Payment (DayBook)',
      'PLOT COMMISSION': 'Plot Commission (DayBook)',
      'EXPENSE': 'Expense (DayBook)',
      'GENERAL': 'General Entry (DayBook)',
    };

    // Map module filter to entry_type
    let entryTypeFilter = `d.entry_type NOT IN ('CASH FLOW', 'FIRM TRANSACTION', 'PLOT PAYMENT', 'VENDOR PAYMENT')`;
    if (module === 'farmer_payment') entryTypeFilter = `d.entry_type = 'FARMER PAYMENT'`;
    else if (module === 'plot_commission') entryTypeFilter = `d.entry_type = 'PLOT COMMISSION'`;
    else if (module === 'expense') entryTypeFilter = `d.entry_type = 'EXPENSE'`;
    else if (module && !['farmer_payment', 'plot_commission', 'expense'].includes(module)) entryTypeFilter = null;

    if (entryTypeFilter) {
      const { where, params } = buildWhere('d', 'd', [], visDb.scoped ? req.user.id : null);
      const q = `
            SELECT d.*, s.name AS site_name, COALESCE(u.name, u.email) AS created_by_name,
              COALESCE(aa.name, aa.email) AS assigned_admin_name,
              COALESCE(
                dm.full_name, df.name, dpc.particular, dlu.name,
                dpp.buyer_name, dp.buyer_name, dft.name, dfi.name,
                d.to_entity, d.from_entity, dcfm.ledger_name,
                u.name, u.email, d.particular
              ) AS entity_name,
              CASE
                WHEN dm.id IS NOT NULL THEN COALESCE(dm.member_type, 'Member')
                WHEN df.id IS NOT NULL THEN 'Farmer / land owner'
                WHEN dpc.id IS NOT NULL THEN 'Commission recipient'
                WHEN dlu.id IS NOT NULL THEN 'Mapped ledger user'
                WHEN dpp.id IS NOT NULL THEN 'Plot buyer / payer'
                WHEN dft.id IS NOT NULL THEN 'Firm transaction party'
                WHEN d.cash_flow_entry_id IS NOT NULL THEN 'Personal ledger'
                ELSE 'Day Book entity'
              END AS entity_type,
              COALESCE(dlu.email, dcfm.ledger_name, d.category) AS entity_secondary,
              COALESCE(dpc.plot_no, dp.plot_no)::text AS entity_plot_no,
               'daybook' AS source
        FROM day_book d
        JOIN sites s ON d.site_id = s.id
        LEFT JOIN users u ON d.created_by = u.id
        LEFT JOIN users aa ON d.assigned_admin_id = aa.id
        LEFT JOIN members dm ON dm.id = d.assigned_user_id
        LEFT JOIN farmer_payments dfp ON dfp.id = d.farmer_payment_id
        LEFT JOIN farmers df ON df.id = dfp.farmer_id
        LEFT JOIN plot_commissions dpc ON dpc.id = d.commission_id
        LEFT JOIN cash_flow_entries dcfe ON dcfe.id = d.cash_flow_entry_id
        LEFT JOIN cash_flow_months dcfm ON dcfm.id = dcfe.cash_flow_month_id
        LEFT JOIN users dlu ON dlu.id = dcfm.linked_user_id
        LEFT JOIN firm_transactions dft ON dft.id = d.firm_transaction_id
        LEFT JOIN firms dfi ON dfi.id = dft.firm_id
        LEFT JOIN plot_payments dpp ON dpp.id = d.plot_payment_id
        LEFT JOIN plots dp ON dp.id = dpp.plot_id
        -- Farmer Payments create matching Day Book entries for accounting.  The
        -- farmer payment itself is the approval request, so do not show that
        -- linked accounting mirror as a second request.
        WHERE ${where} AND ${entryTypeFilter}
          AND (d.entry_type <> 'FARMER PAYMENT' OR d.farmer_payment_id IS NULL)
        ORDER BY d.date DESC, d.id DESC
      `;
      const r = await pool.query(q, params);
      results.push(...r.rows.map(row => {
        const src = DAYBOOK_TYPE_MAP[row.entry_type] || 'daybook';
        return {
          ...row,
          source: src,
          entry_label: `${row.to_entity || row.particular || 'Entry'} - Dr:₹${row.debit || 0} Cr:₹${row.credit || 0}`,
          module_label: DAYBOOK_LABEL_MAP[row.entry_type] || 'Day Book',
        };
      }));
    }
  }

  // Sort combined results by date DESC
  results.sort((a, b) => {
    const dA = new Date(a.date), dB = new Date(b.date);
    return dB - dA || b.id - a.id;
  });

  const total = results.length;
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 200);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
  const totals = results.reduce((sum, entry) => ({
    debit: sum.debit + (Number(entry.debit) || 0),
    credit: sum.credit + (Number(entry.credit) || 0),
  }), { debit: 0, credit: 0 });
  res.json({ entries: results.slice(offset, offset + limit), total, totals, limit, offset });
});

/**
 * GET /approvals/counts
 * Get pending counts per module.
 * Sub-admins only see counts for their allowed modules.
 */
export const getPendingCounts = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!requireApprovalSite(req, res)) return;
  const allowedModules = await getAllowedModules(req.user);

  // Build an "assigned to me" clause for sub-admins lacking module grants —
  // they still need counts for entries delegated directly to them.
  const isSubAdmin = req.user.role === 'sub_admin';
  const scopeClauseFor = (alias, moduleKey) => {
    if (!isSubAdmin) return '';
    if (isModuleAllowed(allowedModules, moduleKey)) return '';
    return ` AND ${alias}.assigned_admin_id = ${parseInt(req.user.id)}`;
  };

  const siteFilter = site_id ? 'AND site_id = $1' : '';
  const fSiteFilter = site_id ? 'AND f.site_id = $1' : '';
  const params = site_id ? [parseInt(site_id)] : [];

  const queries = [
    pool.query(`SELECT COUNT(*)::int AS count FROM farmer_payments fp JOIN farmers f ON fp.farmer_id = f.id WHERE fp.status = 'pending' ${fSiteFilter}${scopeClauseFor('fp', 'farmer_payment')}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM plot_commissions pc WHERE pc.status = 'pending' ${site_id ? 'AND pc.site_id = $1' : ''}${scopeClauseFor('pc', 'plot_commission')}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM plot_commission_payments pcp WHERE pcp.status = 'pending' ${site_id ? 'AND pcp.site_id = $1' : ''}${scopeClauseFor('pcp', 'plot_commission_payment')}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM cash_flow_entries cfe WHERE cfe.status = 'pending' AND cfe.source_module IS NULL ${site_id ? 'AND cfe.site_id = $1' : ''}${scopeClauseFor('cfe', 'cash_flow_entry')}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM firm_transactions ft WHERE ft.status = 'pending' ${site_id ? 'AND ft.site_id = $1' : ''}${scopeClauseFor('ft', 'firm_transaction')}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM plot_payments pp WHERE pp.status = 'pending' ${site_id ? 'AND pp.site_id = $1' : ''}${scopeClauseFor('pp', 'plot_payment')}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM expenses e WHERE e.status = 'pending' ${site_id ? 'AND e.site_id = $1' : ''}${scopeClauseFor('e', 'expense')}`, params),
    // Linked farmer-payment Day Book rows are accounting mirrors, not separate
    // approval requests. Keep the count consistent with /approvals/pending.
    pool.query(`SELECT entry_type, COUNT(*)::int AS count FROM day_book d WHERE d.status = 'pending' AND d.entry_type NOT IN ('CASH FLOW', 'FIRM TRANSACTION', 'PLOT PAYMENT', 'VENDOR PAYMENT') AND (d.entry_type <> 'FARMER PAYMENT' OR d.farmer_payment_id IS NULL) ${site_id ? 'AND d.site_id = $1' : ''}${scopeClauseFor('d', 'daybook')} GROUP BY entry_type`, params),
  ];

  const [fp, pc, pcp, cf, ft, pp, ex, db] = await Promise.all(queries);

  // Day book counts by entry_type
  const dbMap = {};
  for (const row of db.rows) dbMap[row.entry_type] = row.count;

  // "Visible" check — admin / granted module / scoped sub-admin all count as visible.
  // Scoped queries above already restricted to assigned-to-me rows, so their raw count is safe.
  const a = (mod) => !allowedModules || isModuleAllowed(allowedModules, mod) || isSubAdmin;

  const fpCount = a('farmer_payment') ? fp.rows[0].count + (a('daybook') ? (dbMap['FARMER PAYMENT'] || 0) : 0) : 0;
  const pcCount = a('plot_commission') || a('plot_commission_payment')
    ? (a('plot_commission') ? pc.rows[0].count : 0) + (a('plot_commission_payment') ? pcp.rows[0].count : 0) + (a('daybook') ? (dbMap['PLOT COMMISSION'] || 0) : 0)
    : 0;
  const exCount = a('expense') ? ex.rows[0].count + (a('daybook') ? (dbMap['EXPENSE'] || 0) : 0) : 0;
  const cfCount = a('cash_flow_entry') ? cf.rows[0].count + (a('daybook') ? Object.entries(dbMap)
    .filter(([et]) => !['FARMER PAYMENT', 'PLOT COMMISSION', 'EXPENSE'].includes(et))
    .reduce((sum, [, count]) => sum + count, 0) : 0) : 0;
  const ftCount = a('firm_transaction') ? ft.rows[0].count : 0;
  const ppCount = a('plot_payment') ? pp.rows[0].count : 0;

  const counts = {
    farmer_payment: fpCount,
    plot_commission: pcCount,
    cash_flow_entry: cfCount,
    firm_transaction: ftCount,
    plot_payment: ppCount,
    expense: exCount,
    total: fpCount + pcCount + cfCount + ftCount + ppCount + exCount,
  };

  res.json({ ...counts, allowed_modules: allowedModules ? Array.from(allowedModules) : null });
});

/**
 * PUT /approvals/:id/approve
 * Approve a single entry. source query param specifies the module.
 */
export const approveEntry = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { source } = req.query;

  if (!source || !ALLOWED_TABLES[source]) {
    return res.status(400).json({ message: 'source query param is required (farmer_payment, plot_commission, cash_flow_entry, firm_transaction, plot_payment, expense, daybook)' });
  }

  const table = getTableName(source);
  const entryId = parseInt(id);
  if (!Number.isInteger(entryId) || !await assertApprovalSiteAccess(req, res, source, entryId)) return;

  // Check current status + assignment up-front — assignment overrides module-level permission,
  // so a sub-admin can approve an entry that was explicitly delegated to them even without a
  // blanket module grant.
  const checkColumns = source === 'firm_transaction'
    ? 'status, assigned_admin_id, transfer_group_id, transfer_direction'
    : 'status, assigned_admin_id';
  const check = await pool.query(`SELECT ${checkColumns} FROM ${table} WHERE id = $1`, [entryId]);
  if (!check.rows[0]) return res.status(404).json({ message: 'Entry not found' });
  if (check.rows[0].status === 'approved') return res.status(400).json({ message: 'Entry is already approved' });

  if (
    source === 'firm_transaction'
    && check.rows[0].transfer_group_id
    && (check.rows[0].transfer_direction || '').toUpperCase() === 'IN'
  ) {
    return res.status(400).json({
      message: 'Approve the outbound side of this firm transfer; its inbound side is synchronized automatically',
    });
  }

  const assignedTo = check.rows[0].assigned_admin_id ? parseInt(check.rows[0].assigned_admin_id) : null;
  const isAssignedToCaller = assignedTo === parseInt(req.user.id);

  let assignmentPredicate;
  let assignmentParams;
  if (isAssignedToCaller) {
    assignmentPredicate = 'assigned_admin_id = $3';
    assignmentParams = [entryId, req.user.id, req.user.id];
  } else {
    if (assignedTo) {
      return res.status(403).json({ message: 'This entry is assigned to another user for approval' });
    }
    const allowedModules = await getAllowedModules(req.user);
    if (!isModuleAllowed(allowedModules, source)) {
      return res.status(403).json({ message: 'You do not have permission to approve this module' });
    }
    assignmentPredicate = 'assigned_admin_id IS NULL';
    assignmentParams = [entryId, req.user.id];
  }

  // Approval and the inbound side of a firm transfer are one accounting
  // event. Commit them together so a transient insert failure cannot leave an
  // approved OUT row without its matching IN row.
  const client = await pool.connect();
  let entry;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE ${table}
          SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
        WHERE id = $1
          AND status <> 'approved'
          AND ${assignmentPredicate}
        RETURNING *`,
      assignmentParams
    );
    if (result.rowCount !== 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Entry changed while it was being approved; refresh and try again' });
    }
    entry = result.rows[0];
    if (source === 'firm_transaction') {
      if (
        entry.transfer_group_id
        && (entry.transfer_direction || '').toUpperCase() === 'IN'
      ) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          message: 'Firm transfer changed while it was being approved; approve its outbound side instead',
        });
      }
      await ensureInboundFirmTransferForApproval(entry, req.user.id, client);
    }
    await postApprovalImprest({ entry, source, actorId: req.user.id, db: client });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  // Update overall commission status if full amount paid
  if (source === 'plot_commission_payment') {
      try {
          // get the total paid vs total commission
          const sumQuery = `
             SELECT 
                pcm.id, pcm.total_commission, 
                COALESCE(SUM(pcp.amount), 0) as total_paid
             FROM plot_commissions_v2 pcm
             LEFT JOIN plot_commission_payments pcp ON pcm.id = pcp.plot_commission_id AND pcp.status = 'approved' AND (pcp.cheque_status IS NULL OR pcp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
             WHERE pcm.id = $1
             GROUP BY pcm.id
          `;
          const sumRes = await pool.query(sumQuery, [entry.plot_commission_id]);
          if (sumRes.rows.length > 0) {
              const { id, total_commission, total_paid } = sumRes.rows[0];
              let newStatus = 'Pending';
              if (Number(total_paid) > 0) {
                  newStatus = Number(total_paid) >= Number(total_commission) ? 'Completed' : 'Partial';
              }
              await pool.query(`UPDATE plot_commissions_v2 SET status = $1 WHERE id = $2`, [newStatus, id]);
          }
      } catch (err) {
         console.error('[Approval] Failed to calculate commission master status:', err.message);
      }
  }

  res.json({ entry, message: `${source} approved successfully` });
});

/**
 * PUT /approvals/:id/reject
 * Reject a single entry. source query param specifies the module.
 */
export const rejectEntry = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { source } = req.query;

  if (!source || !ALLOWED_TABLES[source]) {
    return res.status(400).json({ message: 'source query param is required' });
  }

  const table = getTableName(source);
  const entryId = parseInt(id);
  if (!Number.isInteger(entryId) || !await assertApprovalSiteAccess(req, res, source, entryId)) return;

  const check = await pool.query(`SELECT status, assigned_admin_id, created_by FROM ${table} WHERE id = $1`, [entryId]);
  if (!check.rows[0]) return res.status(404).json({ message: 'Entry not found' });
  if (check.rows[0].status === 'rejected') return res.status(400).json({ message: 'Entry is already rejected' });

  const assignedTo = check.rows[0].assigned_admin_id ? parseInt(check.rows[0].assigned_admin_id) : null;
  const isAssignedToCaller = assignedTo === parseInt(req.user.id);

  let assignmentPredicate;
  let assignmentParams;
  if (isAssignedToCaller) {
    assignmentPredicate = 'assigned_admin_id = $3';
    assignmentParams = [entryId, req.user.id, req.user.id];
  } else {
    if (assignedTo) {
      return res.status(403).json({ message: 'This entry is assigned to another user for approval' });
    }
    const allowedModules = await getAllowedModules(req.user);
    if (!isModuleAllowed(allowedModules, source)) {
      return res.status(403).json({ message: 'You do not have permission to reject this module' });
    }
    assignmentPredicate = 'assigned_admin_id IS NULL';
    assignmentParams = [entryId, req.user.id];
  }

  const wasApproved = check.rows[0].status === 'approved';

  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await client.query(
      `UPDATE ${table}
          SET status = 'rejected', approved_by = $2, approved_at = NOW(), updated_at = NOW()
        WHERE id = $1
          AND status <> 'rejected'
          AND ${assignmentPredicate}
        RETURNING *`,
      assignmentParams
    );
    if (result.rowCount !== 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Entry changed while it was being rejected; refresh and try again' });
    }

    if (source === 'firm_transaction') {
      const rejectedTransfer = result.rows[0];
      if (
        rejectedTransfer?.transfer_group_id
        && ['OUT', 'IN'].includes((rejectedTransfer.transfer_direction || '').toUpperCase())
      ) {
        await client.query(
          `UPDATE firm_transactions
              SET status = 'rejected', approved_by = $2, approved_at = NOW(), updated_at = NOW()
            WHERE transfer_group_id = $1 AND id <> $3`,
          [rejectedTransfer.transfer_group_id, req.user.id, rejectedTransfer.id]
        );
      }
    }
    if (wasApproved) {
      await postApprovalImprest({ entry: result.rows[0], source, actorId: req.user.id, reverse: true, db: client });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  // Update overall commission status if plot_commission_payment was rejected
  if (source === 'plot_commission_payment') {
    const entry = result.rows[0];
    if (entry.plot_commission_id) {
      try {
        const sumQuery = `
          SELECT 
            pcm.id, pcm.total_commission, 
            COALESCE(SUM(pcp.amount), 0) as total_paid
          FROM plot_commissions_v2 pcm
          LEFT JOIN plot_commission_payments pcp ON pcm.id = pcp.plot_commission_id AND pcp.status = 'approved' AND (pcp.cheque_status IS NULL OR pcp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
          WHERE pcm.id = $1
          GROUP BY pcm.id
        `;
        const sumRes = await pool.query(sumQuery, [entry.plot_commission_id]);
        if (sumRes.rows.length > 0) {
          const { id, total_commission, total_paid } = sumRes.rows[0];
          let newStatus = 'Pending';
          if (Number(total_paid) > 0) {
            newStatus = Number(total_paid) >= Number(total_commission) ? 'Completed' : 'Partial';
          }
          await pool.query(`UPDATE plot_commissions_v2 SET status = $1 WHERE id = $2`, [newStatus, id]);
        }
      } catch (err) {
        console.error('[Approval] Failed to update commission status after rejection:', err.message);
      }
    }
  }

  res.json({ entry: result.rows[0], message: `${source} rejected` });
});

/**
 * POST /approvals/bulk-approve
 * Approve multiple entries across modules at once.
 * Body: { items: [{ id, source }, ...] }
 */
export const bulkApprove = asyncHandler(async (req, res) => {
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    return res.status(400).json({ message: 'items array is required' });
  }

  const allowedModules = await getAllowedModules(req.user);

  // Group by source table while retaining the permission key. Duplicate or
  // malformed ids must not inflate counts or create ambiguous bulk outcomes.
  const grouped = {};
  for (const item of items) {
    if (!ALLOWED_TABLES[item.source]) continue;
    const itemId = Number.parseInt(item.id);
    if (!Number.isInteger(itemId)) continue;
    if (!await assertApprovalSiteAccess(req, res, item.source, itemId)) return;
    const table = getTableName(item.source);
    if (!grouped[table]) grouped[table] = { source: item.source, ids: new Set() };
    grouped[table].ids.add(itemId);
  }

  let totalApproved = 0;
  let skippedAssignedToOthers = 0;
  const affectedCommissions = new Set();

  for (const [table, group] of Object.entries(grouped)) {
    const ids = Array.from(group.ids);
    if (ids.length === 0) continue;
    const assignmentCondition = isModuleAllowed(allowedModules, group.source)
      ? '(assigned_admin_id IS NULL OR assigned_admin_id = $3)'
      : 'assigned_admin_id = $3';
    const firmInboundCondition = table === 'firm_transactions'
      ? `AND NOT (
           transfer_group_id IS NOT NULL
           AND UPPER(COALESCE(transfer_direction, '')) = 'IN'
         )`
      : '';
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await client.query(
        `UPDATE ${table} SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
         WHERE id = ANY($1::int[]) AND status = 'pending'
           AND ${assignmentCondition}
           ${firmInboundCondition}
         RETURNING *`,
        [ids, req.user.id, req.user.id]
      );

      if (table === 'firm_transactions') {
        for (const row of result.rows) {
          await ensureInboundFirmTransferForApproval(row, req.user.id, client);
        }
      }
      for (const row of result.rows) {
        await postApprovalImprest({ entry: row, source: group.source, actorId: req.user.id, db: client });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // Track plot commission payments for status update
    if (table === 'plot_commission_payments') {
      for (const row of result.rows) {
        if (row.plot_commission_id) {
          affectedCommissions.add(row.plot_commission_id);
        }
      }
    }

    totalApproved += result.rowCount;
    skippedAssignedToOthers += (ids.length - result.rowCount);
  }

  // Update commission statuses for all affected commissions
  if (affectedCommissions.size > 0) {
    try {
      for (const commissionId of affectedCommissions) {
        const sumQuery = `
          SELECT 
            pcm.id, pcm.total_commission, 
            COALESCE(SUM(pcp.amount), 0) as total_paid
          FROM plot_commissions_v2 pcm
          LEFT JOIN plot_commission_payments pcp ON pcm.id = pcp.plot_commission_id AND pcp.status = 'approved' AND (pcp.cheque_status IS NULL OR pcp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
          WHERE pcm.id = $1
          GROUP BY pcm.id
        `;
        const sumRes = await pool.query(sumQuery, [commissionId]);
        if (sumRes.rows.length > 0) {
          const { id, total_commission, total_paid } = sumRes.rows[0];
          let newStatus = 'Pending';
          if (Number(total_paid) > 0) {
            newStatus = Number(total_paid) >= Number(total_commission) ? 'Completed' : 'Partial';
          }
          await pool.query(`UPDATE plot_commissions_v2 SET status = $1 WHERE id = $2`, [newStatus, id]);
        }
      }
    } catch (err) {
      console.error('[Approval] Failed to update commission statuses in bulk approve:', err.message);
    }
  }

  const msg = skippedAssignedToOthers > 0
    ? `${totalApproved} entries approved, ${skippedAssignedToOthers} skipped (not assigned or permitted)`
    : `${totalApproved} entries approved successfully`;
  res.json({ message: msg, count: totalApproved, skippedAssignedToOthers });
});

/**
 * POST /approvals/bulk-reject
 * Reject multiple entries across modules at once.
 * Body: { items: [{ id, source }, ...] }
 */
export const bulkReject = asyncHandler(async (req, res) => {
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    return res.status(400).json({ message: 'items array is required' });
  }

  const allowedModules = await getAllowedModules(req.user);
  const grouped = {};
  for (const item of items) {
    if (!ALLOWED_TABLES[item.source]) continue;
    const itemId = Number.parseInt(item.id);
    if (!Number.isInteger(itemId)) continue;
    if (!await assertApprovalSiteAccess(req, res, item.source, itemId)) return;
    const table = getTableName(item.source);
    if (!grouped[table]) grouped[table] = { source: item.source, ids: new Set() };
    grouped[table].ids.add(itemId);
  }

  let totalRejected = 0;
  let skippedAssignedToOthers = 0;
  const affectedCommissions = new Set();

  for (const [table, group] of Object.entries(grouped)) {
    const ids = Array.from(group.ids);
    if (ids.length === 0) continue;
    const assignmentCondition = isModuleAllowed(allowedModules, group.source)
      ? '(assigned_admin_id IS NULL OR assigned_admin_id = $3)'
      : 'assigned_admin_id = $3';
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await client.query(
        `UPDATE ${table} SET status = 'rejected', approved_by = $2, approved_at = NOW(), updated_at = NOW()
         WHERE id = ANY($1::int[]) AND status = 'pending'
           AND ${assignmentCondition}
         RETURNING *`,
        [ids, req.user.id, req.user.id]
      );

      if (table === 'firm_transactions') {
        const groups = result.rows
          .filter((row) => (
            row.transfer_group_id
            && ['OUT', 'IN'].includes((row.transfer_direction || '').toUpperCase())
          ))
          .map((row) => row.transfer_group_id);
        if (groups.length > 0) {
          await client.query(
            `UPDATE firm_transactions
                SET status = 'rejected', approved_by = $2, approved_at = NOW(), updated_at = NOW()
              WHERE transfer_group_id = ANY($1::varchar[])`,
            [groups, req.user.id]
          );
        }
      }
      for (const row of result.rows) {
        await postApprovalImprest({ entry: row, source: group.source, actorId: req.user.id, reverse: true, db: client });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // Track plot commission payments for status update
    if (table === 'plot_commission_payments') {
      for (const row of result.rows) {
        if (row.plot_commission_id) {
          affectedCommissions.add(row.plot_commission_id);
        }
      }
    }

    totalRejected += result.rowCount;
    skippedAssignedToOthers += (ids.length - result.rowCount);
  }

  // Update commission statuses for all affected commissions
  if (affectedCommissions.size > 0) {
    try {
      for (const commissionId of affectedCommissions) {
        const sumQuery = `
          SELECT 
            pcm.id, pcm.total_commission, 
            COALESCE(SUM(pcp.amount), 0) as total_paid
          FROM plot_commissions_v2 pcm
          LEFT JOIN plot_commission_payments pcp ON pcm.id = pcp.plot_commission_id AND pcp.status = 'approved' AND (pcp.cheque_status IS NULL OR pcp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
          WHERE pcm.id = $1
          GROUP BY pcm.id
        `;
        const sumRes = await pool.query(sumQuery, [commissionId]);
        if (sumRes.rows.length > 0) {
          const { id, total_commission, total_paid } = sumRes.rows[0];
          let newStatus = 'Pending';
          if (Number(total_paid) > 0) {
            newStatus = Number(total_paid) >= Number(total_commission) ? 'Completed' : 'Partial';
          }
          await pool.query(`UPDATE plot_commissions_v2 SET status = $1 WHERE id = $2`, [newStatus, id]);
        }
      }
    } catch (err) {
      console.error('[Approval] Failed to update commission statuses in bulk reject:', err.message);
    }
  }

  const msg = skippedAssignedToOthers > 0
    ? `${totalRejected} entries rejected, ${skippedAssignedToOthers} skipped (not assigned or permitted)`
    : `${totalRejected} entries rejected`;
  res.json({ message: msg, count: totalRejected, skippedAssignedToOthers });
});

// ══════════════════════════════════════════════════
//  CHEQUE STATUS UPDATE (Admin)
// ══════════════════════════════════════════════════

const CHEQUE_TABLES = {
  farmer_payment: 'farmer_payments',
  plot_commission_payment: 'plot_commission_payments',
  cash_flow_entry: 'cash_flow_entries',
  firm_transaction: 'firm_transactions',
  plot_payment: 'plot_payments',
  expense: 'expenses',
  vendor_payment: 'vendor_payments',
  daybook: 'day_book',
};

/**
 * GET /approvals/cheques
 * List all cheque entries across modules (for admin cheque management tab).
 * Query: ?site_id=X&status=PENDING|CLEARED|BOUNCED|RETURNED|all
 */
export const listChequeEntries = asyncHandler(async (req, res) => {
  const { site_id, status } = req.query;
  if (!requireApprovalSite(req, res)) return;

  const statusFilter = status && status !== 'all' ? status.toUpperCase() : null;

  // Build UNION ALL query across all relevant tables
  const queries = [];
  const params = [];
  let paramIdx = 0;

  const addQuery = (table, source, labelExpr, siteCol = 'site_id') => {
    paramIdx++;
    const siteParam = site_id ? `AND t.${siteCol} = $${paramIdx}` : '';
    const statusParam = statusFilter ? `AND t.cheque_status = $${paramIdx + (site_id ? 0 : 0)}` : '';

    // Build WHERE parts dynamically
    const whereParts = ['t.cheque_status IS NOT NULL'];
    if (site_id) { params.push(parseInt(site_id)); whereParts.push(`t.${siteCol} = $${params.length}`); }
    if (statusFilter) { params.push(statusFilter); whereParts.push(`t.cheque_status = $${params.length}`); }

    const debitCol = table === 'firm_transactions' ? 'debit' : table === 'plot_commission_payments' ? 'amount' : table === 'plot_payments' ? 'amount' : 'debit';
    const creditCol = table === 'firm_transactions' ? 'credit' : table === 'plot_commission_payments' ? '0' : table === 'plot_payments' ? '0' : 'credit';

    queries.push(`
      SELECT t.id, '${source}' AS source, ${labelExpr} AS entry_label,
        COALESCE(t.${debitCol}, 0)::numeric AS debit, COALESCE(t.${creditCol}, 0)::numeric AS credit,
        t.cheque_no, t.cheque_status, t.date,
        t.${siteCol} AS site_id, s.name AS site_name,
        t.created_at, t.updated_at
      FROM ${table} t
      LEFT JOIN sites s ON s.id = t.${siteCol}
      WHERE ${whereParts.join(' AND ')}
    `);
  };

  // Reset params for each call — we'll use a simpler approach
  params.length = 0;

  // Build all sub-queries with shared param indices
  const whereParts = (siteCol = 'site_id') => {
    const parts = ['t.cheque_status IS NOT NULL'];
    if (site_id) parts.push(`t.${siteCol} = $1`);
    if (statusFilter) parts.push(`t.cheque_status = $${site_id ? 2 : 1}`);
    return parts.join(' AND ');
  };

  const allParams = [];
  if (site_id) allParams.push(parseInt(site_id));
  if (statusFilter) allParams.push(statusFilter);

  const unionParts = [
    `SELECT t.id, 'farmer_payment' AS source, COALESCE(t.particular, '') || ' - ' || COALESCE(f.name, '') AS entry_label,
      COALESCE(t.amount, 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.date,
      f.site_id, s.name AS site_name, t.created_at,
      NULL::text AS plot_no, NULL::text AS booked_by
    FROM farmer_payments t
    LEFT JOIN farmers f ON f.id = t.farmer_id
    LEFT JOIN sites s ON s.id = f.site_id
    WHERE t.cheque_status IS NOT NULL${site_id ? ` AND f.site_id = $1` : ''}${statusFilter ? ` AND t.cheque_status = $${site_id ? 2 : 1}` : ''}`,

    `SELECT t.id, 'plot_commission_payment' AS source, 'Commission Payment #' || t.id AS entry_label,
      COALESCE(t.amount, 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.date,
      pc.site_id, s.name AS site_name, t.created_at,
      NULL::text AS plot_no, NULL::text AS booked_by
    FROM plot_commission_payments t
    LEFT JOIN plot_commissions_v2 pc ON pc.id = t.plot_commission_id
    LEFT JOIN sites s ON s.id = pc.site_id
    WHERE t.cheque_status IS NOT NULL${site_id ? ` AND pc.site_id = $1` : ''}${statusFilter ? ` AND t.cheque_status = $${site_id ? 2 : 1}` : ''}`,

    `SELECT t.id, 'firm_transaction' AS source, COALESCE(t.description, '') || CASE WHEN t.name IS NOT NULL THEN ' - ' || t.name ELSE '' END AS entry_label,
      COALESCE(GREATEST(t.debit, t.credit), 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.date,
      t.site_id, s.name AS site_name, t.created_at,
      NULL::text AS plot_no, NULL::text AS booked_by
    FROM firm_transactions t
    LEFT JOIN sites s ON s.id = t.site_id
    WHERE ${whereParts()}`,

    `SELECT t.id, 'plot_payment' AS source, 'Plot Payment - ' || COALESCE(p.plot_no, '') || ' ' || COALESCE(p.buyer_name, '') AS entry_label,
      COALESCE(t.amount, 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.date,
      t.site_id, s.name AS site_name, t.created_at,
      p.plot_no, t.booked_by
    FROM plot_payments t
    LEFT JOIN sites s ON s.id = t.site_id
    LEFT JOIN plots p ON p.id = t.plot_id
    WHERE ${whereParts()}`,

    `SELECT t.id, 'expense' AS source, COALESCE(t.remark, t.category, '') AS entry_label,
      COALESCE(GREATEST(t.debit, t.credit), 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.date,
      t.site_id, s.name AS site_name, t.created_at,
      NULL::text AS plot_no, NULL::text AS booked_by
    FROM expenses t
    LEFT JOIN sites s ON s.id = t.site_id
    WHERE ${whereParts()}`,

    `SELECT t.id, 'vendor_payment' AS source, 'Vendor - ' || COALESCE(vc.vendor_name, '') AS entry_label,
      COALESCE(t.amount, 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.payment_date AS date,
      t.site_id, s.name AS site_name, t.created_at,
      NULL::text AS plot_no, NULL::text AS booked_by
    FROM vendor_payments t
    LEFT JOIN sites s ON s.id = t.site_id
    LEFT JOIN vendor_commitments vc ON vc.id = t.commitment_id
    WHERE ${whereParts()}`,

    `SELECT t.id, 'cash_flow_entry' AS source, COALESCE(t.particular, '') AS entry_label,
      COALESCE(GREATEST(t.debit, t.credit), 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.date,
      t.site_id, s.name AS site_name, t.created_at,
      NULL::text AS plot_no, NULL::text AS booked_by
    FROM cash_flow_entries t
    LEFT JOIN sites s ON s.id = t.site_id
    WHERE ${whereParts()} AND t.source_module IS NULL`,

    `SELECT t.id, 'daybook' AS source, COALESCE(t.particular, '') AS entry_label,
      COALESCE(GREATEST(t.debit, t.credit), 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.date,
      t.site_id, s.name AS site_name, t.created_at,
      NULL::text AS plot_no, NULL::text AS booked_by
    FROM day_book t
    LEFT JOIN sites s ON s.id = t.site_id
    WHERE ${whereParts()} AND t.farmer_payment_id IS NULL AND t.commission_id IS NULL AND t.cash_flow_entry_id IS NULL AND t.firm_transaction_id IS NULL AND t.plot_payment_id IS NULL AND t.vendor_payment_id IS NULL`,
  ];

  const fullQuery = unionParts.join('\nUNION ALL\n') + '\nORDER BY created_at DESC';

  const result = await pool.query(fullQuery, allParams);

  // Count by status
  const statusCounts = { PENDING: 0, CLEARED: 0, BOUNCED: 0, RETURNED: 0 };
  result.rows.forEach(r => {
    if (statusCounts[r.cheque_status] !== undefined) statusCounts[r.cheque_status]++;
  });

  res.json({ entries: result.rows, counts: statusCounts, total: result.rows.length });
});

/**
 * PATCH /approvals/cheque-status
 * Update cheque_status for a payment entry (admin only).
 * Body: { id, source, cheque_status }
 * Valid cheque_status values: PENDING, CLEARED, BOUNCED, RETURNED
 */
export const updateChequeStatus = asyncHandler(async (req, res) => {
  const { id, source, cheque_status, cheque_no } = req.body;

  if (!id || !source || !cheque_status) {
    return res.status(400).json({ message: 'id, source, and cheque_status are required' });
  }

  const VALID_STATUSES = ['PENDING', 'CLEARED', 'BOUNCED', 'RETURNED'];
  const normalizedStatus = String(cheque_status).toUpperCase();
  if (!VALID_STATUSES.includes(normalizedStatus)) {
    return res.status(400).json({ message: `cheque_status must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  const table = CHEQUE_TABLES[source];
  if (!table) {
    return res.status(400).json({ message: `Invalid source: ${source}` });
  }
  const entryId = Number.parseInt(id, 10);
  if (!Number.isInteger(entryId) || !await assertApprovalSiteAccess(req, res, source, entryId)) return;

  const trimmedChequeNo = cheque_no !== undefined ? (cheque_no ? String(cheque_no).trim() : null) : undefined;

  const setClauses = ['cheque_status = $1', 'updated_at = NOW()'];
  const queryParams = [normalizedStatus];
  let paramIdx = 2;

  if (trimmedChequeNo !== undefined) {
    setClauses.push(`cheque_no = $${paramIdx}`);
    queryParams.push(trimmedChequeNo);
    paramIdx++;
  }

  queryParams.push(entryId);

  const result = await pool.query(
    `UPDATE ${table}
     SET ${setClauses.join(', ')}
     WHERE id = $${paramIdx}
     RETURNING *`,
    queryParams
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ message: 'Entry not found' });
  }

  if (source === 'firm_transaction') {
    const transfer = result.rows[0];
    if (
      transfer.transfer_group_id
      && ['OUT', 'IN'].includes((transfer.transfer_direction || '').toUpperCase())
    ) {
      const pairSets = ['cheque_status = $1', 'updated_at = NOW()'];
      const pairParams = [normalizedStatus];
      if (trimmedChequeNo !== undefined) {
        pairSets.push(`cheque_no = $${pairParams.length + 1}`);
        pairParams.push(trimmedChequeNo);
      }
      pairParams.push(transfer.transfer_group_id, transfer.id);
      await pool.query(
        `UPDATE firm_transactions
            SET ${pairSets.join(', ')}
          WHERE transfer_group_id = $${pairParams.length - 1}
            AND id <> $${pairParams.length}`,
        pairParams
      );
    }
  }

  // Sync cheque metadata to the canonical ledger without mutating the original
  // amount. Posted-ledger reads exclude BOUNCED/RETURNED rows; zeroing debit or
  // credit here destroyed the value of a direct cash-flow cheque and made a
  // later CLEARED transition impossible to reconcile.
  if (table !== 'cash_flow_entries') {
    const cfSetParts = ['cheque_status = $1', 'updated_at = NOW()'];
    const cfParams = [normalizedStatus];
    let cfIdx = 2;
    if (trimmedChequeNo !== undefined) {
      cfSetParts.push(`cheque_no = $${cfIdx}`);
      cfParams.push(trimmedChequeNo);
      cfIdx++;
    }
    cfParams.push(table, entryId);
    await pool.query(
      `UPDATE cash_flow_entries
       SET ${cfSetParts.join(', ')}
       WHERE source_module = $${cfIdx} AND source_id = $${cfIdx + 1}`,
      cfParams
    );
  }

  // If this is a plot commission payment, auto-update the commission status
  if (source === 'plot_commission_payment') {
    try {
      const paymentRes = await pool.query(
        `SELECT plot_commission_id FROM plot_commission_payments WHERE id = $1`,
        [parseInt(id)]
      );
      if (paymentRes.rows.length > 0) {
        const plotCommissionId = paymentRes.rows[0].plot_commission_id;
        const commRes = await pool.query(
          `SELECT pc.total_commission, 
                  COALESCE(SUM(pcp.amount) FILTER (WHERE pcp.status = 'approved' 
                  AND (pcp.cheque_status IS NULL OR pcp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))), 0) AS total_paid
           FROM plot_commissions_v2 pc
           LEFT JOIN plot_commission_payments pcp ON pc.id = pcp.plot_commission_id
           WHERE pc.id = $1
           GROUP BY pc.id`,
          [plotCommissionId]
        );
        
        if (commRes.rows.length > 0) {
          const { total_commission, total_paid } = commRes.rows[0];
          const numCommission = parseFloat(total_commission) || 0;
          const numPaid = parseFloat(total_paid) || 0;
          
          let newStatus = 'Pending';
          if (numPaid >= numCommission) newStatus = 'Completed';
          else if (numPaid > 0) newStatus = 'Partial';
          
          await pool.query(
            `UPDATE plot_commissions_v2 SET status = $1, updated_at = NOW() WHERE id = $2`,
            [newStatus, plotCommissionId]
          );
        }
      }
    } catch (err) {
      console.error('Error auto-updating commission status after cheque status change:', err);
    }
  }

  res.json({ entry: result.rows[0], message: `Cheque status updated to ${normalizedStatus}` });
});
