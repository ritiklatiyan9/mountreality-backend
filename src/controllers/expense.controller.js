import asyncHandler from '../utils/asyncHandler.js';
import { expenseModel } from '../models/Expense.model.js';
import { dayBookModel } from '../models/DayBook.model.js';
import { imprestLedgerModel } from '../models/Imprest.model.js';
import pool from '../config/db.js';
import { buildVerifyUrl, ReceiptType } from '../utils/receiptToken.js';
import { classifyPaymentMode } from '../utils/paymentMode.js';
import { resolveBankAccountSelection } from '../services/bankAccount.service.js';

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
async function deductImprestOnApproval(createdByUserId, debitAmount, referenceId, remarks, approvedByUserId, {
  db = pool, siteId = null, sourceModule = 'expenses',
} = {}) {
  if (!debitAmount || debitAmount <= 0) return;
  const userResult = await db.query('SELECT role FROM users WHERE id = $1', [createdByUserId]);
  const user = userResult.rows[0];
  if (!user || user.role !== 'sub_admin') return;
  await imprestLedgerModel.createEntry({
    user_id: createdByUserId, site_id: siteId, type: 'EXPENSE', source_module: sourceModule,
    reference_id: referenceId, amount: -debitAmount,
    remarks: remarks.toUpperCase(), created_by: approvedByUserId,
  }, db);
}

/**
 * Helper: Reverse the imprest deduction when a previously-approved expense
 * is REJECTED/DECLINED. Adds back the deducted amount to restore balance.
 */
async function reverseImprestOnRejection(createdByUserId, debitAmount, referenceId, remarks, rejectedByUserId, {
  db = pool, siteId = null, sourceModule = 'expenses',
} = {}) {
  if (!debitAmount || debitAmount <= 0) return;

  const userResult = await db.query('SELECT role FROM users WHERE id = $1', [createdByUserId]);
  const user = userResult.rows[0];
  if (!user || user.role !== 'sub_admin') return;
  const existing = await db.query(
    `SELECT id FROM imprest_ledger
      WHERE user_id=$1 AND reference_id=$2 AND type='EXPENSE' AND amount<0
        AND source_module=$3 AND COALESCE(site_id,0)=COALESCE($4::int,0) LIMIT 1`,
    [createdByUserId, referenceId, sourceModule, siteId]
  );
  if (existing.rows.length === 0) return;
  await imprestLedgerModel.createEntry({
    user_id: createdByUserId, site_id: siteId, type: 'ADJUSTMENT', source_module: sourceModule,
    reference_id: referenceId, amount: debitAmount,
    remarks: `REVERSED (REJECTED): ${remarks}`.toUpperCase(), created_by: rejectedByUserId,
  }, db);
}

const transitionExpenseStatus = async ({ table, id, status, amountField, sourceModule, label, actorId }) => {
  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error('Invalid entry ID'); error.status = 400; throw error;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
    const existing = locked.rows[0];
    if (!existing) {
      const error = new Error('Entry not found'); error.status = 404; throw error;
    }
    if (existing.status === status) {
      const error = new Error(`Entry is already ${status}`); error.status = 409; throw error;
    }
    const { rows } = await client.query(
      `UPDATE ${table} SET status=$1,approved_by=$2,approved_at=NOW(),updated_at=NOW()
        WHERE id=$3 RETURNING *`,
      [status, actorId, id]
    );
    const entry = rows[0];
    const amount = Number(entry[amountField]) || 0;
    const options = { db: client, siteId: entry.site_id, sourceModule };
    if (status === 'approved') {
      await deductImprestOnApproval(entry.created_by, amount, entry.id, label(entry), actorId, options);
    } else if (existing.status === 'approved') {
      await reverseImprestOnRejection(entry.created_by, amount, entry.id, label(entry), actorId, options);
    }
    await client.query('COMMIT');
    return entry;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

/**
 * POST /expenses
 * Create a new expense entry (status defaults to 'pending')
 */
export const createExpense = asyncHandler(async (req, res) => {
  const {
    site_id, date, from_entity, to_entity, payment_mode,
    debit, credit, remark, account_no, branch, category,
    assigned_user_id, assigned_admin_id, voucher_url, bill_url,
    mapped_member_id, mapped_user_id, bank_account_id,
  } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  if (mapped_member_id && mapped_user_id) {
    return res.status(400).json({ message: 'Map this entry to either a client or a user, not both' });
  }

  const normalizedPaymentMode = payment_mode ? payment_mode.trim().toUpperCase() : 'BANK';
  const selectedBankAccountId = await resolveBankAccountSelection({
    siteId: site_id,
    paymentMode: normalizedPaymentMode,
    bankAccountId: bank_account_id,
  });
  const data = {
    site_id: parseInt(site_id),
    date: date || new Date().toISOString().split('T')[0],
    from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
    to_entity: to_entity ? to_entity.trim().toUpperCase() : null,
    payment_mode: normalizedPaymentMode,
    bank_account_id: selectedBankAccountId,
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
    customer_signature_url, authority_signature_url, cheque_no, cheque_status, bank_account_id,
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
  if (bank_account_id !== undefined || payment_mode !== undefined) {
    data.bank_account_id = await resolveBankAccountSelection({
      siteId: existing.site_id,
      paymentMode: nextMode,
      bankAccountId: bank_account_id !== undefined ? bank_account_id : existing.bank_account_id,
    });
  }
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
  const siteId = Number.parseInt(site_id, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return res.status(400).json({ message: 'A valid site_id is required' });
  }

  let expensesList = [];
  let daybookList = [];
  let vendorPayments = [];

  // Use the new findByStatus method for flexibility
  [expensesList, daybookList] = await Promise.all([
    expenseModel.findByStatus(
      status,
      siteId,
      date_from || null,
      date_to || null,
      pool
    ),
    dayBookModel.findByStatus(
      status,
      siteId,
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
           AND vp.site_id = $2
           AND ($3::date IS NULL OR vp.payment_date >= $3)
           AND ($4::date IS NULL OR vp.payment_date <= $4)
         ORDER BY vp.payment_date DESC, vp.id DESC`,
        [status, siteId, date_from || null, date_to || null]
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
  const siteId = Number.parseInt(site_id, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return res.status(400).json({ message: 'A valid site_id is required' });
  }

  const [expenseCounts, daybookCounts, vendorCounts] = await Promise.all([
    expenseModel.getStatusCounts(siteId, pool),
    dayBookModel.getStatusCounts(siteId, pool),
    pool
      .query(
        `SELECT status, COUNT(*)::int AS count
         FROM vendor_payments
         WHERE site_id = $1
         GROUP BY status`,
        [siteId]
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
    const approvedPayment = await transitionExpenseStatus({
      table: 'vendor_payments', id: Number.parseInt(id, 10), status: 'approved',
      amountField: 'amount', sourceModule: 'vendor_payments',
      label: (entry) => `VENDOR PAYMENT #${entry.id}`, actorId: req.user.id,
    });
    return res.json({ expense: approvedPayment, message: 'Vendor payment approved successfully' });
  }

  // ── DayBook branch ──
  if (source === 'daybook') {
    const entry = await transitionExpenseStatus({
      table: 'day_book', id: Number.parseInt(id, 10), status: 'approved',
      amountField: 'debit', sourceModule: 'day_book',
      label: (row) => `DAYBOOK #${row.id}: ${row.entry_type || 'EXPENSE'}`, actorId: req.user.id,
    });
    return res.json({ expense: entry, message: 'Day Book expense approved successfully' });
  }

  const expense = await transitionExpenseStatus({
    table: 'expenses', id: Number.parseInt(id, 10), status: 'approved',
    amountField: 'debit', sourceModule: 'expenses',
    label: (row) => `EXPENSE #${row.id}: ${row.remark || 'EXPENSE'}`, actorId: req.user.id,
  });

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
    const rejectedPayment = await transitionExpenseStatus({
      table: 'vendor_payments', id: Number.parseInt(id, 10), status: 'rejected',
      amountField: 'amount', sourceModule: 'vendor_payments',
      label: (entry) => `VENDOR PAYMENT #${entry.id}`, actorId: req.user.id,
    });
    return res.json({ expense: rejectedPayment, message: 'Vendor payment rejected' });
  }

  // ── DayBook branch ──
  if (source === 'daybook') {
    const entry = await transitionExpenseStatus({
      table: 'day_book', id: Number.parseInt(id, 10), status: 'rejected',
      amountField: 'debit', sourceModule: 'day_book',
      label: (row) => `DAYBOOK #${row.id}: ${row.entry_type || 'EXPENSE'}`, actorId: req.user.id,
    });
    return res.json({ expense: entry, message: 'Day Book expense rejected' });
  }

  const expense = await transitionExpenseStatus({
    table: 'expenses', id: Number.parseInt(id, 10), status: 'rejected',
    amountField: 'debit', sourceModule: 'expenses',
    label: (row) => `EXPENSE #${row.id}: ${row.remark || 'EXPENSE'}`, actorId: req.user.id,
  });

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
  const bulkImprestDeduct = async (allItems, db) => {
    if (!allItems || allItems.length === 0) return;
    const creatorIds = [...new Set(allItems.map((i) => i.creator).filter(Boolean))];
    if (creatorIds.length === 0) return;
    const userRes = await db.query('SELECT id,role FROM users WHERE id=ANY($1::int[])', [creatorIds]);
    const subAdminIds = new Set(userRes.rows.filter((u) => u.role === 'sub_admin').map((u) => u.id));
    for (const row of allItems.filter((item) => subAdminIds.has(item.creator) && item.amount > 0)) {
      await imprestLedgerModel.createEntry({
        user_id: row.creator, site_id: row.siteId, type: 'EXPENSE', source_module: row.sourceModule,
        reference_id: row.referenceId, amount: -row.amount,
        remarks: row.remarks.toUpperCase(), created_by: req.user.id,
      }, db);
    }
  };

  // Support legacy format (expense_ids array)
  if (req.body.expense_ids) {
    const expense_ids = req.body.expense_ids;
    if (!Array.isArray(expense_ids) || expense_ids.length === 0) {
      return res.status(400).json({ message: 'expense_ids array is required' });
    }
    const client = await pool.connect();
    let expenses;
    try {
      await client.query('BEGIN');
      expenses = await expenseModel.bulkApprove(expense_ids.map((id) => parseInt(id)), req.user.id, client);
      await bulkImprestDeduct(expenses.map((exp) => ({
        creator: exp.created_by, siteId: exp.site_id, sourceModule: 'expenses', referenceId: exp.id,
        amount: parseFloat(exp.debit) || 0, remarks: `EXPENSE #${exp.id}: ${exp.remark || 'EXPENSE'}`,
      })), client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

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

  const client = await pool.connect();
  let results;
  try {
    await client.query('BEGIN');
    results = [
      pureExpenseIds.length > 0 ? await expenseModel.bulkApprove(pureExpenseIds, req.user.id, client) : [],
      daybookIds.length > 0 ? await dayBookModel.bulkApprove(daybookIds, req.user.id, client) : [],
      vendorPaymentIds.length > 0
        ? (await client.query(
            `UPDATE vendor_payments SET status='approved',approved_by=$2,approved_at=NOW(),updated_at=NOW()
              WHERE id=ANY($1::int[]) AND status<>'approved' RETURNING *`,
            [vendorPaymentIds, req.user.id]
          )).rows
        : [],
    ];

  // Build a single batched imprest payload (was 3 nested for loops × N
  // serial round-trips). Run in BACKGROUND.
  const ledgerPayload = [
    ...results[0].map((exp) => ({
      creator: exp.created_by,
      siteId: exp.site_id,
      sourceModule: 'expenses',
      referenceId: exp.id,
      amount: parseFloat(exp.debit) || 0,
      remarks: `EXPENSE #${exp.id}: ${exp.remark || 'EXPENSE'}`,
    })),
    ...results[1].map((entry) => ({
      creator: entry.created_by,
      siteId: entry.site_id,
      sourceModule: 'day_book',
      referenceId: entry.id,
      amount: parseFloat(entry.debit) || 0,
      remarks: `DAYBOOK #${entry.id}: ${entry.entry_type || 'EXPENSE'}`,
    })),
    ...results[2].map((vp) => ({
      creator: vp.created_by,
      siteId: vp.site_id,
      sourceModule: 'vendor_payments',
      referenceId: vp.id,
      amount: parseFloat(vp.amount) || 0,
      remarks: `VENDOR PAYMENT #${vp.id}`,
    })),
  ];
    await bulkImprestDeduct(ledgerPayload, client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const totalApproved = results[0].length + results[1].length + results[2].length;

  res.json({
    expenses: [...results[0], ...results[1], ...results[2]],
    message: `${totalApproved} item(s) approved successfully`,
  });
});
