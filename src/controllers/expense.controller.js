import asyncHandler from '../utils/asyncHandler.js';
import { expenseModel } from '../models/Expense.model.js';
import { dayBookModel } from '../models/DayBook.model.js';
import { imprestLedgerModel } from '../models/Imprest.model.js';
import pool from '../config/db.js';
import { buildVerifyUrl, ReceiptType } from '../utils/receiptToken.js';
import { classifyPaymentMode } from '../utils/paymentMode.js';

const resolveChequeStatus = ({ currentMode, currentStatus, nextMode, requestedStatus }) => {
  if (classifyPaymentMode(nextMode) !== 'cheque') return null;
  if (requestedStatus !== undefined) {
    return requestedStatus ? String(requestedStatus).trim().toUpperCase() : 'PENDING';
  }
  return classifyPaymentMode(currentMode) === 'cheque'
    ? (currentStatus || 'PENDING')
    : 'PENDING';
};

// ══════════════════════════════════════════════════
//  EXPENSE ENDPOINTS
// ══════════════════════════════════════════════════

/**
 * Helper: Deduct from sub-admin's imprest balance when an expense/daybook
 * entry is APPROVED. Looks up the creator's role and only deducts if
 * the creator is a sub_admin and the debit amount is > 0.
 */
async function deductImprestOnApproval(createdByUserId, debitAmount, referenceId, remarks, approvedByUserId) {
  if (!debitAmount || debitAmount <= 0) return;

  try {
    // Check if the creator is a sub_admin
    const userResult = await pool.query('SELECT role FROM users WHERE id = $1', [createdByUserId]);
    const user = userResult.rows[0];
    if (!user || user.role !== 'sub_admin') return;

    await imprestLedgerModel.createEntry({
      user_id: createdByUserId,
      type: 'EXPENSE',
      reference_id: referenceId,
      amount: -debitAmount,
      remarks: remarks.toUpperCase(),
      created_by: approvedByUserId,
    }, pool);
  } catch (err) {
    console.error('[Imprest] Failed to deduct on approval for ref', referenceId, err.message);
  }
}

/**
 * Helper: Reverse the imprest deduction when a previously-approved expense
 * is REJECTED/DECLINED. Adds back the deducted amount to restore balance.
 */
async function reverseImprestOnRejection(createdByUserId, debitAmount, referenceId, remarks, rejectedByUserId) {
  if (!debitAmount || debitAmount <= 0) return;

  try {
    // Only reverse for sub_admin users
    const userResult = await pool.query('SELECT role FROM users WHERE id = $1', [createdByUserId]);
    const user = userResult.rows[0];
    if (!user || user.role !== 'sub_admin') return;

    // Check that an EXPENSE deduction actually exists for this reference
    const existing = await pool.query(
      `SELECT id FROM imprest_ledger WHERE user_id = $1 AND reference_id = $2 AND type = 'EXPENSE' AND amount < 0 LIMIT 1`,
      [createdByUserId, referenceId]
    );
    if (existing.rows.length === 0) return; // No deduction was made, nothing to reverse

    await imprestLedgerModel.createEntry({
      user_id: createdByUserId,
      type: 'ADJUSTMENT',
      reference_id: referenceId,
      amount: debitAmount, // positive = restore balance
      remarks: `REVERSED (REJECTED): ${remarks}`.toUpperCase(),
      created_by: rejectedByUserId,
    }, pool);
  } catch (err) {
    console.error('[Imprest] Failed to reverse on rejection for ref', referenceId, err.message);
  }
}

/**
 * POST /expenses
 * Create a new expense entry (status defaults to 'pending')
 */
export const createExpense = asyncHandler(async (req, res) => {
  const {
    site_id, date, from_entity, to_entity, payment_mode,
    debit, credit, remark, account_no, branch, category,
    assigned_user_id, assigned_admin_id, voucher_url, bill_url,
    mapped_member_id, mapped_user_id,
  } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  if (mapped_member_id && mapped_user_id) {
    return res.status(400).json({ message: 'Map this entry to either a client or a user, not both' });
  }

  const data = {
    site_id: parseInt(site_id),
    date: date || new Date().toISOString().split('T')[0],
    from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
    to_entity: to_entity ? to_entity.trim().toUpperCase() : null,
    payment_mode: payment_mode ? payment_mode.trim().toUpperCase() : 'BANK',
    debit: parseFloat(debit) || 0,
    credit: parseFloat(credit) || 0,
    remark: remark ? remark.trim().toUpperCase() : null,
    account_no: account_no ? account_no.trim().toUpperCase() : null,
    branch: branch ? branch.trim().toUpperCase() : null,
    category: category ? category.trim().toUpperCase() : null,
    assigned_user_id: assigned_user_id ? parseInt(assigned_user_id) : null,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    voucher_url: voucher_url || null,
    bill_url: bill_url || null,
    status: 'pending', // New expenses are pending by default
    created_by: req.user.id,
    cheque_no: classifyPaymentMode(payment_mode) === 'cheque' && req.body.cheque_no
      ? String(req.body.cheque_no).trim()
      : null,
    cheque_status: classifyPaymentMode(payment_mode) === 'cheque' ? 'PENDING' : null,
    mapped_member_id: mapped_member_id ? parseInt(mapped_member_id) : null,
    mapped_user_id: mapped_user_id ? parseInt(mapped_user_id) : null,
  };

  const expense = await expenseModel.create(data, pool);
  res.status(201).json({ expense });
});

/**
 * GET /expenses?site_id=X
 * List expenses for a site (Paginated, Unified expenses + day_book)
 * Includes server-side filters, search, and running balances
 */
export const listExpenses = asyncHandler(async (req, res) => {
  const {
    site_id, page = 1, limit = 20,
    search, mode, category, to_entity,
    dateFrom, dateTo, export: isExport, missing_bill, order, only_site
  } = req.query;

  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const filters = { search, mode, category, to_entity, dateFrom, dateTo, missing_bill, order, only_site };

  // If exporting, fetch all filtered records by bypassing the limit
  const fetchLimit = isExport === 'true' ? 0 : parseInt(limit);
  const fetchPage = parseInt(page);

  // Run the heavy unified query, the breakdowns query AND the site lookup
  // ALL in parallel. Was: 2 parallel + 1 serial after.
  const [paginatedData, breakdowns, siteRowRes] = await Promise.all([
    expenseModel.findPaginatedUnified(parseInt(site_id), filters, fetchPage, fetchLimit, pool),
    expenseModel.getUnifiedBreakdowns(parseInt(site_id), filters, pool),
    pool.query('SELECT name, city, state FROM sites WHERE id = $1', [parseInt(site_id)]),
  ]);
  const siteRow = siteRowRes.rows[0] || null;

  const expensesWithVerify = paginatedData.items.map((e) => ({
    ...e,
    verifyUrl: buildVerifyUrl({
      t: ReceiptType.EXPENSE,
      i: e.id,
      a: parseFloat(e.debit) || parseFloat(e.credit) || 0,
      dr: (parseFloat(e.debit) || 0) > 0 ? 'OUT' : 'IN',
      d: e.date,
      pm: e.payment_mode || null,
      pn: e.to_entity || e.from_entity || null,
      pl: e.category || null,
      sn: siteRow?.name || null,
      sy: siteRow?.city || null,
      ss: siteRow?.state || null,
    }),
  }));

  res.json({
    expenses: expensesWithVerify,
    summary: paginatedData.summary,
    pagination: {
      totalItems: paginatedData.totalItems,
      totalPages: fetchLimit > 0 ? Math.ceil(paginatedData.totalItems / fetchLimit) : 1,
      currentPage: fetchPage,
      itemsPerPage: fetchLimit > 0 ? fetchLimit : paginatedData.totalItems
    },
    modeBreakdown: breakdowns.modeBreakdown,
    categoryBreakdown: breakdowns.categoryBreakdown,
  });
});

/**
 * GET /expenses/autocomplete?site_id=X
 */
export const getAutocomplete = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const data = await expenseModel.getAutocomplete(parseInt(site_id), pool);
  res.json(data);
});

/**
 * GET /expenses/:id
 */
export const getExpense = asyncHandler(async (req, res) => {
  const expense = await expenseModel.findById(parseInt(req.params.id), pool);
  if (!expense) return res.status(404).json({ message: 'Expense not found' });
  res.json({ expense });
});

/**
 * PUT /expenses/:id
 *
 * Atomic — only updates the columns the caller actually sends. Saves a
 * SELECT round-trip vs the previous SELECT-then-UPDATE pattern.
 */
export const updateExpense = asyncHandler(async (req, res) => {
  const expenseId = parseInt(req.params.id);
  const {
    date, from_entity, to_entity, payment_mode,
    debit, credit, remark, account_no, branch, category,
    assigned_user_id, assigned_admin_id, voucher_url, bill_url,
    customer_signature_url, authority_signature_url, cheque_no, cheque_status,
  } = req.body;

  const existing = await expenseModel.findById(expenseId, pool);
  if (!existing) return res.status(404).json({ message: 'Expense not found' });

  const data = {};
  if (date !== undefined) data.date = date;
  if (from_entity !== undefined) data.from_entity = from_entity ? from_entity.trim().toUpperCase() : null;
  if (to_entity !== undefined) data.to_entity = to_entity ? to_entity.trim().toUpperCase() : null;
  const nextMode = payment_mode !== undefined
    ? (payment_mode ? payment_mode.trim().toUpperCase() : 'BANK')
    : existing.payment_mode;
  if (payment_mode !== undefined) {
    data.payment_mode = nextMode;
    data.cheque_status = resolveChequeStatus({
      currentMode: existing.payment_mode,
      currentStatus: existing.cheque_status,
      nextMode,
      requestedStatus: cheque_status,
    });
    data.cheque_no = classifyPaymentMode(nextMode) === 'cheque'
      ? (cheque_no !== undefined ? (cheque_no ? String(cheque_no).trim() : null) : existing.cheque_no)
      : null;
  }
  if (debit !== undefined) data.debit = parseFloat(debit) || 0;
  if (credit !== undefined) data.credit = parseFloat(credit) || 0;
  if (remark !== undefined) data.remark = remark ? remark.trim().toUpperCase() : null;
  if (account_no !== undefined) data.account_no = account_no ? account_no.trim().toUpperCase() : null;
  if (branch !== undefined) data.branch = branch ? branch.trim().toUpperCase() : null;
  if (category !== undefined) data.category = category ? category.trim().toUpperCase() : null;
  if (assigned_user_id !== undefined) data.assigned_user_id = assigned_user_id ? parseInt(assigned_user_id) : null;
  if (assigned_admin_id !== undefined) data.assigned_admin_id = assigned_admin_id ? parseInt(assigned_admin_id) : null;
  if (voucher_url !== undefined) data.voucher_url = voucher_url || null;
  if (bill_url !== undefined) data.bill_url = bill_url || null;
  if (customer_signature_url !== undefined) data.customer_signature_url = customer_signature_url || null;
  if (authority_signature_url !== undefined) data.authority_signature_url = authority_signature_url || null;
  if (payment_mode === undefined && cheque_no !== undefined) {
    data.cheque_no = classifyPaymentMode(nextMode) === 'cheque' && cheque_no
      ? String(cheque_no).trim()
      : null;
  }
  if (payment_mode === undefined && cheque_status !== undefined) {
    data.cheque_status = resolveChequeStatus({
      currentMode: existing.payment_mode,
      currentStatus: existing.cheque_status,
      nextMode,
      requestedStatus: cheque_status,
    });
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: 'Nothing to update' });
  }

  const updated = await expenseModel.update(expenseId, data, pool);
  res.json({ expense: updated });
});

/**
 * DELETE /expenses/:id
 */
export const deleteExpense = asyncHandler(async (req, res) => {
  // Atomic DELETE — saves a SELECT round-trip.
  const result = await pool.query(
    `DELETE FROM expenses WHERE id = $1 RETURNING id`,
    [parseInt(req.params.id)]
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Expense not found' });
  res.json({ message: 'Expense deleted' });
});

/**
 * POST /expenses/bulk-delete
 * Body: { ids: number[] }. Only deletes native `expenses` rows — rows the
 * page aggregates in from other tables (farmer_payment/commission/daybook/
 * vendor_payment/personal_ledger) never reach here since they have no id
 * in this table; the frontend already excludes them from selection.
 */
export const bulkDeleteExpenses = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((id) => parseInt(id)).filter(Number.isInteger) : [];
  if (ids.length === 0) return res.status(400).json({ message: 'ids array is required' });

  const result = await pool.query(`DELETE FROM expenses WHERE id = ANY($1::int[]) RETURNING id`, [ids]);
  res.json({ message: `${result.rows.length} expense(s) deleted`, deleted: result.rows.map((r) => r.id) });
});

// ══════════════════════════════════════════════════
//  EXPENSE APPROVAL ENDPOINTS (Admin only)
// ══════════════════════════════════════════════════

/**
 * GET /expenses/pending
 * List expenses for approval (from both expenses and day_book tables)
 * Supports status query param: 'pending' (default), 'approved', 'rejected', 'all'
 */
export const listPendingExpenses = asyncHandler(async (req, res) => {
  const { site_id, date_from, date_to, status = 'pending' } = req.query;

  let expensesList = [];
  let daybookList = [];
  let vendorPayments = [];

  // Use the new findByStatus method for flexibility
  [expensesList, daybookList] = await Promise.all([
    expenseModel.findByStatus(
      status,
      site_id ? parseInt(site_id) : null,
      date_from || null,
      date_to || null,
      pool
    ),
    dayBookModel.findByStatus(
      status,
      site_id ? parseInt(site_id) : null,
      date_from || null,
      date_to || null,
      pool
    ),
    pool
      .query(
        `SELECT
          vp.id,
          vp.site_id,
          s.name AS site_name,
          vp.payment_date AS date,
          'COMPANY'::varchar AS from_entity,
          COALESCE(vc.vendor_name, 'VENDOR')::varchar AS to_entity,
          UPPER(COALESCE(vp.payment_mode, 'BANK'))::varchar AS payment_mode,
          vp.amount AS debit,
          0::numeric AS credit,
          COALESCE(vp.note, 'VENDOR PAYMENT')::text AS remark,
          NULL::varchar AS account_no,
          NULL::varchar AS branch,
          'VENDOR'::varchar AS category,
          vp.status,
          vp.approved_by,
          vp.approved_at,
          vp.created_by,
          u.name AS created_by_name,
          vp.created_at,
          vp.voucher_url
         FROM vendor_payments vp
         JOIN vendor_commitments vc ON vc.id = vp.commitment_id
         JOIN sites s ON s.id = vp.site_id
         LEFT JOIN users u ON u.id = vp.created_by
         WHERE ($1::text = 'all' OR vp.status = $1)
           AND ($2::int IS NULL OR vp.site_id = $2)
           AND ($3::date IS NULL OR vp.payment_date >= $3)
           AND ($4::date IS NULL OR vp.payment_date <= $4)
         ORDER BY vp.payment_date DESC, vp.id DESC`,
        [status, site_id ? parseInt(site_id) : null, date_from || null, date_to || null]
      )
      .then((r) => r.rows),
  ]);

  // Transform day_book entries to expense format and mark source
  const transformedDaybook = daybookList.map(entry => ({
    id: entry.id,
    site_id: entry.site_id,
    site_name: entry.site_name,
    date: entry.date,
    from_entity: entry.from_entity,
    to_entity: entry.to_entity,
    payment_mode: entry.payment_mode,
    debit: entry.debit,
    credit: entry.credit,
    remark: entry.particular + (entry.remarks ? ' - ' + entry.remarks : ''),
    account_no: entry.account_no,
    branch: entry.branch,
    category: entry.category,
    status: entry.status,
    approved_by: entry.approved_by,
    approved_at: entry.approved_at,
    created_by: entry.created_by,
    created_by_name: entry.created_by_name,
    booked_by: entry.booked_by || null,
    created_at: entry.created_at,
    source: entry.entry_type === 'FARMER PAYMENT' ? 'farmer_payment' : entry.entry_type === 'PLOT COMMISSION' ? 'commission' : 'daybook',
    entry_type: entry.entry_type, // Preserve entry type for UI labeling
  }));

  // Mark expenses table entries
  const markedExpenses = expensesList.map(e => ({
    ...e,
    source: 'expenses',
  }));

  const markedVendorPayments = vendorPayments.map((vp) => ({
    ...vp,
    source: 'vendor_payment',
  }));

  // Combine both sources and sort by date DESC
  const allExpenses = [...markedExpenses, ...transformedDaybook, ...markedVendorPayments].sort((a, b) => {
    const dateA = new Date(a.date);
    const dateB = new Date(b.date);
    if (dateB.getTime() !== dateA.getTime()) {
      return dateB.getTime() - dateA.getTime(); // DESC by date
    }
    return b.id - a.id; // DESC by id
  });

  res.json({ expenses: allExpenses });
});

/**
 * GET /expenses/status-counts
 * Get counts by status (from both tables)
 */
export const getStatusCounts = asyncHandler(async (req, res) => {
  const { site_id } = req.query;

  const [expenseCounts, daybookCounts, vendorCounts] = await Promise.all([
    expenseModel.getStatusCounts(site_id ? parseInt(site_id) : null, pool),
    dayBookModel.getStatusCounts(site_id ? parseInt(site_id) : null, pool),
    pool
      .query(
        `SELECT status, COUNT(*)::int AS count
         FROM vendor_payments
         WHERE ($1::int IS NULL OR site_id = $1)
         GROUP BY status`,
        [site_id ? parseInt(site_id) : null]
      )
      .then((r) => r.rows),
  ]);

  // Combine counts
  const result = { pending: 0, approved: 0, rejected: 0 };

  expenseCounts.forEach(row => {
    result[row.status] = (result[row.status] || 0) + row.count;
  });

  daybookCounts.forEach(row => {
    result[row.status] = (result[row.status] || 0) + row.count;
  });

  vendorCounts.forEach(row => {
    result[row.status] = (result[row.status] || 0) + row.count;
  });

  res.json(result);
});

/**
 * PUT /expenses/:id/approve
 * Approve a single expense (supports both tables via source query param)
 */
export const approveExpense = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { source } = req.query; // 'daybook' or 'expenses'

  // ── Vendor payment branch ──
  if (source === 'vendor_payment') {
    // Atomic: only flip status when not already 'approved'. Saves the
    // SELECT round-trip and rejects the dup in a single query.
    const result = await pool.query(
      `UPDATE vendor_payments
          SET status = 'approved', approved_by = $2, approved_at = NOW()
        WHERE id = $1 AND status != 'approved'
        RETURNING *`,
      [parseInt(id), req.user.id]
    );
    if (!result.rows[0]) {
      // Either not found or already approved — distinguish via a tiny lookup.
      const check = await pool.query('SELECT status FROM vendor_payments WHERE id = $1', [parseInt(id)]);
      if (check.rows.length === 0) return res.status(404).json({ message: 'Vendor payment not found' });
      return res.status(400).json({ message: 'Vendor payment is already approved' });
    }
    const approvedPayment = result.rows[0];

    // Imprest deduction in BACKGROUND — caller doesn't need to wait.
    deductImprestOnApproval(
      approvedPayment.created_by,
      parseFloat(approvedPayment.amount) || 0,
      approvedPayment.id,
      `VENDOR PAYMENT #${approvedPayment.id}`,
      req.user.id
    ).catch(() => {});

    return res.json({ expense: approvedPayment, message: 'Vendor payment approved successfully' });
  }

  // ── DayBook branch ──
  if (source === 'daybook') {
    const existing = await dayBookModel.findById(parseInt(id), pool);
    if (!existing) {
      return res.status(404).json({ message: 'Day Book entry not found' });
    }
    if (existing.status === 'approved') {
      return res.status(400).json({ message: 'Entry is already approved' });
    }
    const entry = await dayBookModel.approveEntry(parseInt(id), req.user.id, pool);

    // Imprest deduction in BACKGROUND.
    deductImprestOnApproval(
      entry.created_by,
      parseFloat(entry.debit) || 0,
      entry.id,
      `DAYBOOK #${entry.id}: ${entry.entry_type || 'EXPENSE'}`,
      req.user.id
    ).catch(() => {});

    return res.json({ expense: entry, message: 'Day Book expense approved successfully' });
  }

  // ── Default: expenses table — atomic flip ──
  const result = await pool.query(
    `UPDATE expenses
        SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status != 'approved'
      RETURNING *`,
    [parseInt(id), req.user.id]
  );
  if (!result.rows[0]) {
    const check = await pool.query('SELECT status FROM expenses WHERE id = $1', [parseInt(id)]);
    if (check.rows.length === 0) return res.status(404).json({ message: 'Expense not found' });
    return res.status(400).json({ message: 'Expense is already approved' });
  }
  const expense = result.rows[0];

  // Imprest deduction in BACKGROUND — response can return immediately.
  deductImprestOnApproval(
    expense.created_by,
    parseFloat(expense.debit) || 0,
    expense.id,
    `EXPENSE #${expense.id}: ${expense.remark || 'EXPENSE'}`,
    req.user.id
  ).catch(() => {});

  res.json({ expense, message: 'Expense approved successfully' });
});

/**
 * PUT /expenses/:id/reject
 * Reject a single expense (supports both tables via source query param)
 */
export const rejectExpense = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { source } = req.query; // 'daybook' or 'expenses'

  // ── Vendor payment branch ── single SELECT + atomic UPDATE
  if (source === 'vendor_payment') {
    const result = await pool.query(
      `UPDATE vendor_payments
          SET status = 'rejected', approved_by = $2, approved_at = NOW()
        WHERE id = $1 AND status != 'rejected'
        RETURNING *, (
          SELECT status FROM vendor_payments WHERE id = $1
        ) AS prev_status`,
      [parseInt(id), req.user.id]
    );
    if (!result.rows[0]) {
      const check = await pool.query('SELECT status FROM vendor_payments WHERE id = $1', [parseInt(id)]);
      if (check.rows.length === 0) return res.status(404).json({ message: 'Vendor payment not found' });
      return res.status(400).json({ message: 'Vendor payment is already rejected' });
    }
    const rejectedPayment = result.rows[0];

    // Reverse imprest deduction in BACKGROUND if previously approved.
    // (`reverseImprestOnRejection` already filters via a row check, so it's
    // safe to fire even when there was no prior deduction.)
    reverseImprestOnRejection(
      rejectedPayment.created_by,
      parseFloat(rejectedPayment.amount) || 0,
      rejectedPayment.id,
      `VENDOR PAYMENT #${rejectedPayment.id}`,
      req.user.id
    ).catch(() => {});

    return res.json({ expense: rejectedPayment, message: 'Vendor payment rejected' });
  }

  // ── DayBook branch ──
  if (source === 'daybook') {
    const existing = await dayBookModel.findById(parseInt(id), pool);
    if (!existing) {
      return res.status(404).json({ message: 'Day Book entry not found' });
    }
    if (existing.status === 'rejected') {
      return res.status(400).json({ message: 'Entry is already rejected' });
    }
    const entry = await dayBookModel.rejectEntry(parseInt(id), req.user.id, pool);

    if (existing.status === 'approved') {
      reverseImprestOnRejection(
        existing.created_by,
        parseFloat(existing.debit) || 0,
        existing.id,
        `DAYBOOK #${existing.id}: ${existing.entry_type || 'EXPENSE'}`,
        req.user.id
      ).catch(() => {});
    }

    return res.json({ expense: entry, message: 'Day Book expense rejected' });
  }

  // ── Default: expenses table — atomic flip with prev_status detection ──
  const result = await pool.query(
    `WITH prev AS (
       SELECT status AS prev_status FROM expenses WHERE id = $1
     )
     UPDATE expenses
        SET status = 'rejected', approved_by = $2, approved_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status != 'rejected'
      RETURNING *, (SELECT prev_status FROM prev) AS prev_status`,
    [parseInt(id), req.user.id]
  );
  if (!result.rows[0]) {
    const check = await pool.query('SELECT status FROM expenses WHERE id = $1', [parseInt(id)]);
    if (check.rows.length === 0) return res.status(404).json({ message: 'Expense not found' });
    return res.status(400).json({ message: 'Expense is already rejected' });
  }
  const expense = result.rows[0];

  if (expense.prev_status === 'approved') {
    reverseImprestOnRejection(
      expense.created_by,
      parseFloat(expense.debit) || 0,
      expense.id,
      `EXPENSE #${expense.id}: ${expense.remark || 'EXPENSE'}`,
      req.user.id
    ).catch(() => {});
  }

  res.json({ expense, message: 'Expense rejected' });
});

/**
 * POST /expenses/bulk-approve
 * Approve multiple expenses at once (supports both tables)
 */
export const bulkApproveExpenses = asyncHandler(async (req, res) => {
  const { items } = req.body; // Array of { id, source }

  // ── Bulk imprest helper: looks up sub_admin role status for all
  //     unique creators in ONE query (was N queries via the per-item
  //     deductImprestOnApproval helper) and inserts all deductions in a
  //     single multi-row INSERT. Runs fire-and-forget after the response.
  const bulkImprestDeduct = async (allItems) => {
    if (!allItems || allItems.length === 0) return;
    try {
      const creatorIds = [...new Set(allItems.map((i) => i.creator).filter(Boolean))];
      if (creatorIds.length === 0) return;
      const userRes = await pool.query(
        `SELECT id, role FROM users WHERE id = ANY($1::int[])`,
        [creatorIds]
      );
      const subAdminIds = new Set(
        userRes.rows.filter((u) => u.role === 'sub_admin').map((u) => u.id)
      );
      const ledgerRows = allItems.filter(
        (i) => subAdminIds.has(i.creator) && i.amount > 0
      );
      if (ledgerRows.length === 0) return;

      const COLS = 6;
      const placeholders = [];
      const values = [];
      ledgerRows.forEach((r, i) => {
        const b = i * COLS;
        placeholders.push(
          `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`
        );
        values.push(r.creator, r.type, r.referenceId, -r.amount, r.remarks.toUpperCase(), req.user.id);
      });
      await pool.query(
        `INSERT INTO imprest_ledger (user_id, type, reference_id, amount, remarks, created_by)
         VALUES ${placeholders.join(',')}`,
        values
      );
    } catch (err) {
      console.error('[Imprest] Bulk deduct failed:', err.message);
    }
  };

  // Support legacy format (expense_ids array)
  if (req.body.expense_ids) {
    const expense_ids = req.body.expense_ids;
    if (!Array.isArray(expense_ids) || expense_ids.length === 0) {
      return res.status(400).json({ message: 'expense_ids array is required' });
    }
    const expenses = await expenseModel.bulkApprove(
      expense_ids.map((id) => parseInt(id)),
      req.user.id,
      pool
    );

    // Build the imprest payload but DON'T await — caller gets the response
    // immediately, and the ledger writes happen after.
    bulkImprestDeduct(expenses.map((exp) => ({
      creator: exp.created_by,
      type: 'EXPENSE',
      referenceId: exp.id,
      amount: parseFloat(exp.debit) || 0,
      remarks: `EXPENSE #${exp.id}: ${exp.remark || 'EXPENSE'}`,
    })));

    return res.json({
      expenses,
      message: `${expenses.length} expense(s) approved successfully`,
    });
  }

  // New format with source support
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'items array is required' });
  }

  // Separate by source (farmer_payment and commission entries live in day_book table)
  const daybookSources = ['daybook', 'farmer_payment', 'commission'];
  const daybookIds = items.filter((i) => daybookSources.includes(i.source)).map((i) => parseInt(i.id));
  const vendorPaymentIds = items.filter((i) => i.source === 'vendor_payment').map((i) => parseInt(i.id));

  const pureExpenseIds = items
    .filter((i) => !daybookSources.includes(i.source) && i.source !== 'vendor_payment')
    .map((i) => parseInt(i.id));

  const results = await Promise.all([
    pureExpenseIds.length > 0 ? expenseModel.bulkApprove(pureExpenseIds, req.user.id, pool) : [],
    daybookIds.length > 0 ? dayBookModel.bulkApprove(daybookIds, req.user.id, pool) : [],
    vendorPaymentIds.length > 0
      ? pool
          .query(
            `UPDATE vendor_payments
             SET status = 'approved', approved_by = $2, approved_at = NOW()
             WHERE id = ANY($1::int[])
             RETURNING *`,
            [vendorPaymentIds, req.user.id]
          )
          .then((r) => r.rows)
      : [],
  ]);

  // Build a single batched imprest payload (was 3 nested for loops × N
  // serial round-trips). Run in BACKGROUND.
  const ledgerPayload = [
    ...results[0].map((exp) => ({
      creator: exp.created_by,
      type: 'EXPENSE',
      referenceId: exp.id,
      amount: parseFloat(exp.debit) || 0,
      remarks: `EXPENSE #${exp.id}: ${exp.remark || 'EXPENSE'}`,
    })),
    ...results[1].map((entry) => ({
      creator: entry.created_by,
      type: 'EXPENSE',
      referenceId: entry.id,
      amount: parseFloat(entry.debit) || 0,
      remarks: `DAYBOOK #${entry.id}: ${entry.entry_type || 'EXPENSE'}`,
    })),
    ...results[2].map((vp) => ({
      creator: vp.created_by,
      type: 'EXPENSE',
      referenceId: vp.id,
      amount: parseFloat(vp.amount) || 0,
      remarks: `VENDOR PAYMENT #${vp.id}`,
    })),
  ];
  bulkImprestDeduct(ledgerPayload);

  const totalApproved = results[0].length + results[1].length + results[2].length;

  res.json({
    expenses: [...results[0], ...results[1], ...results[2]],
    message: `${totalApproved} item(s) approved successfully`,
  });
});
