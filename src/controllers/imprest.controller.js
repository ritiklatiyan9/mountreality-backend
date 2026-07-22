import asyncHandler from '../utils/asyncHandler.js';
import {
  imprestAllocationModel,
  imprestLedgerModel,
  imprestExpenseRequestModel,
  imprestReturnModel,
} from '../models/Imprest.model.js';
import { dayBookModel } from '../models/DayBook.model.js';
import { expenseModel } from '../models/Expense.model.js';
import { findEligibleImprestParticipant } from '../middlewares/imprestSiteAccess.middleware.js';
import pool from '../config/db.js';

// ══════════════════════════════════════════════════
//  IMPREST ALLOCATION (Admin)
// ══════════════════════════════════════════════════

/**
 * POST /imprest/allocations
 * Allocate imprest to another user.
 *  - Admin → Sub-admin: creates allocation + day-book credit (admin funds entering site imprest pool).
 *  - Sub-admin → Sub-admin (peer transfer): deducts from giver's ledger immediately so the funds are
 *    locked. Recipient confirms receipt to credit their ledger. No day-book entry is created —
 *    the money never leaves the sub-admin pool, so site-level debit/credit is unaffected.
 */
export const createAllocation = asyncHandler(async (req, res) => {
  const { sub_admin_id, amount, remark, date, site_id, assigned_admin_id } = req.body;

  if (!sub_admin_id) return res.status(400).json({ message: 'Recipient is required' });
  if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ message: 'Amount must be positive' });
  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  if (parseInt(sub_admin_id) === req.user.id) return res.status(400).json({ message: 'Cannot send imprest to yourself' });

  const giverIsAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  const parsedSiteId = req.imprestSiteId || parseInt(site_id);
  const allocationAmount = parseFloat(amount);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Peer transfers lock funds up-front so the giver can't double-spend while the request is pending.
    if (!giverIsAdmin) {
      const giverBalance = await imprestLedgerModel.getBalance(req.user.id, parsedSiteId, client);
      if (giverBalance < allocationAmount) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          message: `Insufficient imprest balance. Available ₹${giverBalance}, needed ₹${allocationAmount}`,
          balance: giverBalance,
        });
      }
    }

    const allocationDate = date || new Date().toISOString().split('T')[0];

    const allocation = await imprestAllocationModel.create({
      admin_id: req.user.id,
      sub_admin_id: parseInt(sub_admin_id),
      amount: allocationAmount,
      remark: remark ? remark.trim() : null,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
      site_id: parsedSiteId,
      status: 'PENDING_RECEIPT',
    }, client);

    if (!giverIsAdmin) {
      // Lock giver's funds — refunded on cancel, released on receipt confirmation.
      await imprestLedgerModel.createEntry({
        user_id: req.user.id,
        type: 'TRANSFER_OUT',
        reference_id: allocation.id,
        amount: -allocationAmount,
        remarks: `Peer transfer pending receipt by recipient. ${remark || ''}`.trim(),
        created_by: req.user.id,
        site_id: parsedSiteId,
      }, client);
    } else {
      // Admin → sub-admin: record the admin-to-site fund movement in Day Book.
      const subAdminResult = await client.query('SELECT name FROM users WHERE id = $1', [parseInt(sub_admin_id)]);
      const subAdminName = subAdminResult.rows[0]?.name || 'Sub-Admin';

      await dayBookModel.create({
        site_id: parsedSiteId,
        date: allocationDate,
        particular: `IMPREST ALLOCATION TO ${subAdminName.toUpperCase()}`,
        entry_type: 'IMPREST',
        debit: 0,
        credit: allocationAmount,
        remarks: remark ? remark.trim().toUpperCase() : 'IMPREST FUND ALLOCATION',
        payment_mode: 'CASH',
        category: 'IMPREST',
        from_entity: 'ADMIN',
        to_entity: subAdminName.toUpperCase(),
        status: 'approved',
        created_by: req.user.id,
        imprest_allocation_id: allocation.id,
      }, client);
    }

    await client.query('COMMIT');

    res.status(201).json({
      allocation,
      message: giverIsAdmin
        ? 'Imprest allocated successfully. Pending receipt confirmation.'
        : 'Peer imprest transfer created. Waiting for recipient confirmation.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

/**
 * GET /imprest/allocations
 * Admin: list all allocations. Sub-admin: list allocations where they are giver or receiver.
 */
export const listAllocations = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  const parsedSiteId = req.imprestSiteId || (site_id ? parseInt(site_id) : null);
  const callerIsAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';

  if (callerIsAdmin) {
    const allocations = await imprestAllocationModel.findAllWithDetails(parsedSiteId, pool);
    return res.json({ allocations });
  }

  // Sub-admin: surface both directions so the Imprest page shows the peer-transfer history.
  const params = [req.user.id];
  let query = `
    SELECT ia.*,
           sa.name as sub_admin_name, sa.email as sub_admin_email,
           ad.name as admin_name, ad.role as admin_role,
           asa.name as assigned_admin_name,
           s.name as site_name
    FROM imprest_allocations ia
    LEFT JOIN users sa ON ia.sub_admin_id = sa.id
    LEFT JOIN users ad ON ia.admin_id = ad.id
    LEFT JOIN users asa ON ia.assigned_admin_id = asa.id
    LEFT JOIN sites s ON ia.site_id = s.id
    WHERE (ia.admin_id = $1 OR ia.sub_admin_id = $1)
  `;
  if (parsedSiteId) {
    query += ` AND ia.site_id = $2`;
    params.push(parsedSiteId);
  }
  query += ` ORDER BY ia.created_at DESC`;

  const { rows } = await pool.query(query, params);
  res.json({ allocations: rows });
});

/**
 * DELETE /imprest/allocations/:id
 * Cancel a pending allocation.
 *  - Admin: can cancel any pending allocation.
 *  - Sub-admin: can cancel only their own pending-out peer transfers.
 *  - If the giver was a sub-admin, their locked funds are refunded.
 */
export const cancelAllocation = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const callerIsAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await imprestAllocationModel.findById(parseInt(id), client);
    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Allocation not found' });
    }
    if (existing.status !== 'PENDING_RECEIPT') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Allocation already confirmed or cancelled' });
    }

    if (!callerIsAdmin && existing.admin_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'You can only cancel your own pending transfers' });
    }

    const allocation = await imprestAllocationModel.cancelAllocation(parseInt(id), client);
    if (!allocation) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Allocation could not be cancelled' });
    }

    // Peer-transfer refund: return the locked funds to the giver's ledger.
    const giverResult = await client.query('SELECT role FROM users WHERE id = $1', [existing.admin_id]);
    const giverRole = giverResult.rows[0]?.role;
    if (giverRole === 'sub_admin') {
      await imprestLedgerModel.createEntry({
        user_id: existing.admin_id,
        type: 'TRANSFER_REFUND',
        reference_id: allocation.id,
        amount: parseFloat(existing.amount),
        remarks: `Peer transfer cancelled — funds returned to giver.`,
        created_by: req.user.id,
        site_id: existing.site_id,
      }, client);
    }

    await client.query('COMMIT');
    res.json({ allocation, message: 'Allocation cancelled' });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════
//  IMPREST RECEIPT (Sub-Admin)
// ══════════════════════════════════════════════════

/**
 * GET /imprest/pending-receipts
 * Sub-admin: get pending allocations to confirm
 */
export const getPendingReceipts = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  const parsedSiteId = req.imprestSiteId || (site_id ? parseInt(site_id) : null);
  const allocations = await imprestAllocationModel.findPendingBySubAdminId(req.user.id, parsedSiteId, pool);
  res.json({ allocations });
});

/**
 * PUT /imprest/allocations/:id/confirm
 * Sub-admin confirms receipt of imprest
 */
export const confirmReceipt = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { confirmation_remark } = req.body;

  if (!confirmation_remark || !confirmation_remark.trim()) {
    return res.status(400).json({ message: 'Confirmation remark is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Verify allocation belongs to this sub-admin
    const existing = await imprestAllocationModel.findById(parseInt(id), client);
    if (!existing) return res.status(404).json({ message: 'Allocation not found' });
    if (existing.sub_admin_id !== req.user.id) {
      return res.status(403).json({ message: 'This allocation is not assigned to you' });
    }
    if (existing.status !== 'PENDING_RECEIPT') {
      return res.status(400).json({ message: 'Allocation already confirmed or cancelled' });
    }

    // 2. Confirm the allocation
    const allocation = await imprestAllocationModel.confirmReceipt(
      parseInt(id),
      confirmation_remark.trim(),
      client
    );

    // 3. Add to imprest ledger (positive amount = credit)
    const giverResult = await client.query('SELECT name, role FROM users WHERE id = $1', [existing.admin_id]);
    const giverName = giverResult.rows[0]?.name || 'Giver';
    const giverIsSubAdmin = giverResult.rows[0]?.role === 'sub_admin';

    await imprestLedgerModel.createEntry({
      user_id: req.user.id,
      type: giverIsSubAdmin ? 'TRANSFER_IN' : 'ALLOCATION',
      reference_id: allocation.id,
      amount: parseFloat(allocation.amount),
      remarks: `Imprest received from ${giverIsSubAdmin ? 'peer ' : ''}${giverName}. ${confirmation_remark.trim()}`,
      created_by: req.user.id,
      site_id: existing.site_id,
    }, client);

    await client.query('COMMIT');

    // Get updated balance
    const balance = await imprestLedgerModel.getBalance(req.user.id, existing.site_id, pool);

    res.json({
      allocation,
      balance,
      message: 'Imprest receipt confirmed successfully',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════
//  IMPREST BALANCE & LEDGER
// ══════════════════════════════════════════════════

/**
 * GET /imprest/balance
 * Get current imprest balance for the logged-in user
 */
export const getBalance = asyncHandler(async (req, res) => {
  const userId = req.query.user_id ? parseInt(req.query.user_id) : req.user.id;

  // Admin can check any user's balance; sub-admin only their own
  if (req.user.role !== 'admin' && req.user.role !== 'super_admin' && userId !== req.user.id) {
    return res.status(403).json({ message: 'Insufficient permissions' });
  }

  const siteId = req.imprestSiteId || (req.query.site_id ? parseInt(req.query.site_id) : null);
  const balance = await imprestLedgerModel.getBalance(userId, siteId, pool);
  res.json({ balance, user_id: userId });
});

/**
 * GET /imprest/ledger
 * Get imprest ledger for the logged-in user (or specified user for admin)
 */
export const getLedger = asyncHandler(async (req, res) => {
  const userId = req.query.user_id ? parseInt(req.query.user_id) : req.user.id;
  const { date_from, date_to, page = 1, limit = 20, site_id } = req.query;
  const parsedSiteId = req.imprestSiteId || (site_id ? parseInt(site_id) : null);

  if (req.user.role !== 'admin' && req.user.role !== 'super_admin' && userId !== req.user.id) {
    return res.status(403).json({ message: 'Insufficient permissions' });
  }

  const offset = (parseInt(page) - 1) * parseInt(limit);
  const parsedLimit = parseInt(limit);

  let entries;
  if (date_from || date_to) {
    entries = await imprestLedgerModel.findByUserIdAndDateRange(userId, parsedSiteId, date_from, date_to, parsedLimit, offset, pool);
  } else {
    entries = await imprestLedgerModel.findByUserId(userId, parsedSiteId, parsedLimit, offset, pool);
  }

  const totalItems = await imprestLedgerModel.countByUserIdAndDateRange(userId, parsedSiteId, date_from, date_to, pool);
  const totalPages = Math.ceil(totalItems / parsedLimit);

  const balance = await imprestLedgerModel.getBalance(userId, parsedSiteId, pool);
  const monthly = await imprestLedgerModel.getMonthlySummary(userId, parsedSiteId, pool);

  res.json({
    entries,
    balance,
    monthly,
    pagination: {
      totalItems,
      totalPages,
      currentPage: parseInt(page),
      itemsPerPage: parsedLimit
    }
  });
});

/**
 * GET /imprest/peers
 * List potential imprest transfer recipients (active sub-admins + admins) excluding the caller.
 * Allows a sub-admin to pick another user for a peer transfer.
 */
export const listTransferPeers = asyncHandler(async (req, res) => {
  const siteId = req.imprestSiteId || null;
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.role
       FROM users u
      WHERE u.is_active = true
        AND u.id != $1
        AND (
          u.role IN ('admin', 'super_admin')
          OR (
            $2::integer IS NOT NULL
            AND u.role = 'sub_admin'
            AND EXISTS (
              SELECT 1
                FROM user_sites us
               WHERE us.user_id = u.id
                 AND us.site_id = $2
            )
          )
        )
      ORDER BY CASE u.role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
               u.name ASC,
               u.email ASC`,
    [req.user.id, siteId]
  );
  res.json({ peers: rows });
});

/**
 * GET /imprest/all-balances
 * Admin: get all sub-admin balances
 */
export const getAllBalances = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  const parsedSiteId = req.imprestSiteId || (site_id ? parseInt(site_id) : null);
  const balances = await imprestLedgerModel.getAllBalances(parsedSiteId, pool);
  res.json({ balances });
});

// ══════════════════════════════════════════════════
//  IMPREST EXPENSE INTEGRATION
// ══════════════════════════════════════════════════

/**
 * POST /imprest/expense
 * Sub-admin creates an expense deducted from imprest
 */
export const createExpenseFromImprest = asyncHandler(async (req, res) => {
  const {
    site_id, date, from_entity, to_entity, payment_mode,
    debit, credit, remark, account_no, branch, category, assigned_admin_id,
  } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });

  const expenseAmount = parseFloat(debit) || 0;
  if (expenseAmount <= 0) return res.status(400).json({ message: 'Expense amount must be positive' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Check imprest balance
    const parsedSiteId = req.imprestSiteId || parseInt(site_id);
    const currentBalance = await imprestLedgerModel.getBalance(req.user.id, parsedSiteId, client);

    if (currentBalance <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: 'Insufficient imprest balance',
        balance: currentBalance,
        requires_approval: true,
      });
    }

    if (currentBalance < expenseAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `Insufficient imprest balance. Available: ₹${currentBalance}, Required: ₹${expenseAmount}`,
        balance: currentBalance,
        requires_approval: true,
      });
    }

    const expenseDate = date || new Date().toISOString().split('T')[0];

    // 2. Create expense record
    const expenseData = {
      site_id: parsedSiteId,
      date: expenseDate,
      from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
      to_entity: to_entity ? to_entity.trim().toUpperCase() : null,
      payment_mode: payment_mode ? payment_mode.trim().toUpperCase() : null,
      debit: expenseAmount,
      credit: parseFloat(credit) || 0,
      remark: remark ? remark.trim().toUpperCase() : null,
      account_no: account_no ? account_no.trim().toUpperCase() : null,
      branch: branch ? branch.trim().toUpperCase() : null,
      category: category ? category.trim().toUpperCase() : null,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
      status: 'pending',
      created_by: req.user.id,
    };

    const expense = await expenseModel.create(expenseData, client);

    // 3. Deduct from imprest ledger
    await imprestLedgerModel.createEntry({
      user_id: req.user.id,
      type: 'EXPENSE',
      reference_id: expense.id,
      amount: -expenseAmount, // negative = deduction
      remarks: `Expense #${expense.id}: ${remark || 'Expense from imprest'}`.toUpperCase(),
      created_by: req.user.id,
      site_id: parsedSiteId,
    }, client);

    // 4. Create Day Book entry (DEBIT from imprest)
    const dayBookData = {
      site_id: parsedSiteId,
      date: expenseDate,
      particular: `EXPENSE FROM IMPREST: ${remark || to_entity || 'GENERAL'}`.toUpperCase(),
      entry_type: 'EXPENSE',
      debit: expenseAmount,
      credit: parseFloat(credit) || 0,
      remarks: remark ? remark.trim().toUpperCase() : null,
      payment_mode: payment_mode ? payment_mode.trim().toUpperCase() : null,
      category: category ? category.trim().toUpperCase() : null,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
      from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
      to_entity: to_entity ? to_entity.trim().toUpperCase() : null,
      account_no: account_no ? account_no.trim().toUpperCase() : null,
      branch: branch ? branch.trim().toUpperCase() : null,
      status: 'pending',
      created_by: req.user.id,
    };

    await dayBookModel.create(dayBookData, client);

    await client.query('COMMIT');

    const newBalance = await imprestLedgerModel.getBalance(req.user.id, parsedSiteId, pool);

    res.status(201).json({
      expense,
      balance: newBalance,
      message: 'Expense created and imprest deducted',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════
//  OVERDRAFT / EXPENSE REQUEST (Sub-Admin → Admin)
// ══════════════════════════════════════════════════

/**
 * POST /imprest/expense-requests
 * Sub-admin requests money (IMPREST type) or approval for an expense (EXPENSE type)
 */
export const createExpenseRequest = asyncHandler(async (req, res) => {
  const {
    site_id, amount, reason,
    date, from_entity, to_entity, payment_mode,
    debit, credit, remark, account_no, branch, category, assigned_admin_id,
    request_type: explicitType,
  } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  const parsedSiteId = req.imprestSiteId || parseInt(site_id);
  const requestAmount = parseFloat(amount || debit) || 0;
  if (requestAmount <= 0) return res.status(400).json({ message: 'Amount must be positive' });

  // Determine request_type: if no expense-specific fields → IMPREST (cash flow), else EXPENSE (overdraft)
  const hasExpenseFields = from_entity || to_entity || payment_mode || account_no || branch || category || remark;
  const requestType = explicitType === 'IMPREST' || explicitType === 'EXPENSE'
    ? explicitType
    : hasExpenseFields ? 'EXPENSE' : 'IMPREST';

  const expenseData = {
    site_id: parsedSiteId,
    date: date || new Date().toISOString().split('T')[0],
    from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
    to_entity: to_entity ? to_entity.trim().toUpperCase() : null,
    payment_mode: payment_mode ? payment_mode.trim().toUpperCase() : null,
    debit: requestAmount,
    credit: parseFloat(credit) || 0,
    remark: remark ? remark.trim().toUpperCase() : null,
    account_no: account_no ? account_no.trim().toUpperCase() : null,
    branch: branch ? branch.trim().toUpperCase() : null,
    category: category ? category.trim().toUpperCase() : null,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
  };

  const request = await imprestExpenseRequestModel.create({
    sub_admin_id: req.user.id,
    site_id: parsedSiteId,
    amount: requestAmount,
    expense_data: JSON.stringify(expenseData),
    reason: reason ? reason.trim() : null,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    request_type: requestType,
    status: 'PENDING',
  }, pool);

  res.status(201).json({
    request,
    message: requestType === 'IMPREST'
      ? 'Imprest request submitted for admin approval'
      : 'Expense request submitted for admin approval',
  });
});

/**
 * GET /imprest/expense-requests
 * Admin: list all pending requests; Sub-admin: list own requests
 */
export const listExpenseRequests = asyncHandler(async (req, res) => {
  const { site_id, status } = req.query;

  const parsedSiteId = req.imprestSiteId || (site_id ? parseInt(site_id) : null);

  let requests;
  if (req.user.role === 'admin' || req.user.role === 'super_admin') {
    if (status === 'PENDING') {
      requests = await imprestExpenseRequestModel.findPending(parsedSiteId, pool);
    } else {
      requests = await imprestExpenseRequestModel.findAllWithDetails(parsedSiteId, pool);
    }
  } else {
    requests = await imprestExpenseRequestModel.findBySubAdminId(req.user.id, parsedSiteId, pool);
  }

  res.json({ requests });
});

/**
 * PUT /imprest/expense-requests/:id/approve
 * Admin approves: IMPREST type → allocation (positive cash flow), EXPENSE type → overdraft expense
 */
export const approveExpenseRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { review_remark } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Approve the request
    const request = await imprestExpenseRequestModel.approveRequest(
      parseInt(id),
      req.user.id,
      review_remark ? review_remark.trim() : null,
      client
    );

    if (!request) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Request not found or already processed' });
    }

    // Re-check at approval time: a requester may have been deactivated or
    // removed from the site after submitting the request. Do not create a new
    // allocation/expense ledger entry for an ineligible site participant.
    const eligibleRequester = await findEligibleImprestParticipant(
      request.sub_admin_id,
      request.site_id,
      client
    );
    if (!eligibleRequester) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'The requester is no longer active or assigned to this site' });
    }

    const requestType = request.request_type || 'EXPENSE';
    const requestAmount = parseFloat(request.amount);

    // ── IMPREST type: just allocate cash to sub-admin (no expense, no daybook expense) ──
    if (requestType === 'IMPREST') {
      // 2a. Create allocation record
      const allocation = await imprestAllocationModel.create({
        admin_id: req.user.id,
        sub_admin_id: request.sub_admin_id,
        amount: requestAmount,
        remark: request.reason || 'Imprest request approved',
        assigned_admin_id: request.assigned_admin_id || null,
        site_id: request.site_id,
        status: 'RECEIVED', // auto-confirmed since sub-admin requested it
        confirmed_at: new Date(),
        confirmation_remark: 'Auto-confirmed (requested by sub-admin)',
      }, client);

      // 3a. Add positive balance to imprest ledger
      await imprestLedgerModel.createEntry({
        user_id: request.sub_admin_id,
        type: 'ALLOCATION',
        reference_id: allocation.id,
        amount: requestAmount,
        remarks: `Imprest allocated (request #${request.id} approved): ${request.reason || ''}`.trim(),
        created_by: req.user.id,
        site_id: request.site_id,
      }, client);

      await client.query('COMMIT');

      return res.json({
        request,
        allocation,
        message: 'Imprest request approved — funds allocated to sub-admin',
      });
    }

    // ── EXPENSE type: overdraft expense flow (original behavior) ──
    const storedExpenseData = typeof request.expense_data === 'string'
      ? JSON.parse(request.expense_data)
      : request.expense_data;
    // The request row owns the authoritative site. Never trust a stale or
    // legacy JSON payload to direct the approved expense into another site.
    const expenseData = { ...storedExpenseData, site_id: request.site_id };
    const expenseAmount = parseFloat(expenseData.debit) || requestAmount;

    // 2b. Create the expense
    const expense = await expenseModel.create({
      ...expenseData,
      status: 'approved',
      approved_by: req.user.id,
      created_by: request.sub_admin_id,
    }, client);

    // 3b. Record in imprest ledger (negative balance = overdraft)
    await imprestLedgerModel.createEntry({
      user_id: request.sub_admin_id,
      type: 'EXPENSE',
      reference_id: expense.id,
      amount: -expenseAmount,
      remarks: `OVERDRAFT EXPENSE #${expense.id} (Admin approved): ${expenseData.remark || ''}`.trim(),
      created_by: req.user.id,
      site_id: parseInt(request.site_id),
    }, client);

    // 4b. Create Day Book entry
    const dayBookData = {
      site_id: parseInt(request.site_id),
      date: expenseData.date || new Date().toISOString().split('T')[0],
      particular: `OVERDRAFT EXPENSE: ${expenseData.remark || expenseData.to_entity || 'ADMIN APPROVED'}`.toUpperCase(),
      entry_type: 'EXPENSE',
      debit: expenseAmount,
      credit: parseFloat(expenseData.credit) || 0,
      remarks: `Overdraft approved by admin. ${review_remark || ''}`.trim().toUpperCase(),
      payment_mode: expenseData.payment_mode || null,
      category: expenseData.category || null,
      from_entity: expenseData.from_entity || null,
      to_entity: expenseData.to_entity || null,
      account_no: expenseData.account_no || null,
      branch: expenseData.branch || null,
      status: 'approved',
      approved_by: req.user.id,
      approved_at: new Date(),
      created_by: request.sub_admin_id,
    };

    await dayBookModel.create(dayBookData, client);

    await client.query('COMMIT');

    res.json({
      request,
      expense,
      message: 'Expense request approved and expense created',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

/**
 * PUT /imprest/expense-requests/:id/reject
 * Admin rejects an expense request
 */
export const rejectExpenseRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { review_remark } = req.body;

  const request = await imprestExpenseRequestModel.rejectRequest(
    parseInt(id),
    req.user.id,
    review_remark ? review_remark.trim() : null,
    pool
  );

  if (!request) return res.status(404).json({ message: 'Request not found or already processed' });

  res.json({ request, message: 'Expense request rejected' });
});

// ══════════════════════════════════════════════════
//  IMPREST ADJUSTMENT (Admin)
// ══════════════════════════════════════════════════

/**
 * POST /imprest/adjust
 * Admin manually adjusts a sub-admin's imprest balance
 */
export const adjustBalance = asyncHandler(async (req, res) => {
  const { user_id, amount, remarks, site_id } = req.body;

  if (!user_id) return res.status(400).json({ message: 'User ID is required' });
  if (amount === undefined || amount === null) return res.status(400).json({ message: 'Amount is required' });
  const parsedSiteId = req.imprestSiteId || parseInt(site_id);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create ledger adjustment
    const entry = await imprestLedgerModel.createEntry({
      user_id: parseInt(user_id),
      type: 'ADJUSTMENT',
      reference_id: null,
      amount: parseFloat(amount),
      remarks: remarks ? remarks.trim().toUpperCase() : 'ADMIN ADJUSTMENT',
      created_by: req.user.id,
      site_id: parsedSiteId,
    }, client);

    // Day Book entry for audit trail
    const userResult = await client.query('SELECT name FROM users WHERE id = $1', [parseInt(user_id)]);
    const userName = userResult.rows[0]?.name || 'Sub-Admin';

    const dayBookData = {
      site_id: parsedSiteId,
      date: new Date().toISOString().split('T')[0],
      particular: `IMPREST ADJUSTMENT FOR ${userName.toUpperCase()}`,
      entry_type: 'IMPREST',
      debit: parseFloat(amount) < 0 ? Math.abs(parseFloat(amount)) : 0,
      credit: parseFloat(amount) > 0 ? parseFloat(amount) : 0,
      remarks: remarks ? remarks.trim().toUpperCase() : 'MANUAL IMPREST ADJUSTMENT',
      category: 'IMPREST',
      status: 'approved',
      created_by: req.user.id,
    };

    await dayBookModel.create(dayBookData, client);

    await client.query('COMMIT');

    const balance = await imprestLedgerModel.getBalance(parseInt(user_id), parsedSiteId, pool);

    res.json({ entry, balance, message: 'Balance adjusted successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════
//  IMPREST RETURN (Sub-Admin → Admin)
// ══════════════════════════════════════════════════

/**
 * POST /imprest/returns
 * Sub-admin initiates returning money back to admin
 */
export const createReturn = asyncHandler(async (req, res) => {
  const { amount, reason, payment_mode, site_id, assigned_admin_id } = req.body;

  const returnAmount = parseFloat(amount);
  if (!returnAmount || returnAmount <= 0) {
    return res.status(400).json({ message: 'Amount must be positive' });
  }

  // Validate balance — can't return more than available
  const parsedSiteId = req.imprestSiteId || parseInt(site_id);
  const currentBalance = await imprestLedgerModel.getBalance(req.user.id, parsedSiteId, pool);
  if (currentBalance < returnAmount) {
    return res.status(400).json({
      message: `Insufficient balance. You have ${currentBalance} but tried to return ${returnAmount}`,
      balance: currentBalance,
    });
  }

  const returnRecord = await imprestReturnModel.create({
    sub_admin_id: req.user.id,
    amount: returnAmount,
    reason: reason ? reason.trim() : null,
    payment_mode: payment_mode ? payment_mode.trim().toUpperCase() : 'CASH',
    site_id: parsedSiteId,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    status: 'PENDING',
  }, pool);

  res.status(201).json({
    return: returnRecord,
    message: 'Return request submitted. Waiting for admin acceptance.',
  });
});

/**
 * GET /imprest/returns
 * Admin: all returns; Sub-admin: own returns
 */
export const listReturns = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  const parsedSiteId = req.imprestSiteId || (site_id ? parseInt(site_id) : null);

  let returns;
  if (req.user.role === 'admin' || req.user.role === 'super_admin') {
    returns = await imprestReturnModel.findAllWithDetails(parsedSiteId, pool);
  } else {
    returns = await imprestReturnModel.findBySubAdminId(req.user.id, parsedSiteId, pool);
  }
  res.json({ returns });
});

/**
 * GET /imprest/pending-returns
 * Admin: pending returns needing review
 */
export const getPendingReturns = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  const parsedSiteId = req.imprestSiteId || (site_id ? parseInt(site_id) : null);
  const returns = await imprestReturnModel.findPending(parsedSiteId, pool);
  res.json({ returns });
});

/**
 * PUT /imprest/returns/:id/accept
 * Admin accepts a return — deducts from sub-admin's imprest ledger + day book
 */
export const acceptReturn = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { review_remark } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Accept the return record
    const returnRecord = await imprestReturnModel.acceptReturn(
      parseInt(id),
      req.user.id,
      review_remark ? review_remark.trim() : null,
      client
    );

    if (!returnRecord) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Return not found or already processed' });
    }

    const returnAmount = parseFloat(returnRecord.amount);

    // 2. Verify sub-admin still has sufficient balance
    const returnSiteId = returnRecord.site_id ? parseInt(returnRecord.site_id) : null;
    const currentBalance = await imprestLedgerModel.getBalance(returnRecord.sub_admin_id, returnSiteId, client);
    if (currentBalance < returnAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `Sub-admin balance (${currentBalance}) is now less than return amount (${returnAmount}). Cannot accept.`,
      });
    }

    // 3. Deduct from sub-admin's imprest ledger (negative = deduction)
    await imprestLedgerModel.createEntry({
      user_id: returnRecord.sub_admin_id,
      type: 'REFUND',
      reference_id: returnRecord.id,
      amount: -returnAmount,
      remarks: `IMPREST RETURN #${returnRecord.id} ACCEPTED BY ADMIN. ${returnRecord.reason || ''}`.trim(),
      created_by: req.user.id,
      site_id: returnSiteId,
    }, client);

    // 4. Create Day Book entry (DEBIT from sub-admin back to admin)
    const subAdminResult = await client.query('SELECT name FROM users WHERE id = $1', [returnRecord.sub_admin_id]);
    const subAdminName = subAdminResult.rows[0]?.name || 'Sub-Admin';

    const dayBookData = {
      site_id: returnRecord.site_id || 1,
      date: new Date().toISOString().split('T')[0],
      particular: `IMPREST RETURN FROM ${subAdminName.toUpperCase()}`,
      entry_type: 'IMPREST',
      debit: returnAmount,
      credit: 0,
      remarks: `IMPREST RETURN: ${returnRecord.reason || 'UNUSED FUNDS RETURNED'}`.toUpperCase(),
      payment_mode: returnRecord.payment_mode || 'CASH',
      category: 'IMPREST',
      from_entity: subAdminName.toUpperCase(),
      to_entity: 'ADMIN',
      status: 'approved',
      created_by: req.user.id,
    };

    await dayBookModel.create(dayBookData, client);

    await client.query('COMMIT');

    const newBalance = await imprestLedgerModel.getBalance(returnRecord.sub_admin_id, returnSiteId, pool);

    res.json({
      return: returnRecord,
      balance: newBalance,
      message: 'Return accepted. Imprest balance updated.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

/**
 * PUT /imprest/returns/:id/reject
 * Admin rejects a return — no balance change
 */
export const rejectReturn = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { review_remark } = req.body;

  const returnRecord = await imprestReturnModel.rejectReturn(
    parseInt(id),
    req.user.id,
    review_remark ? review_remark.trim() : null,
    pool
  );

  if (!returnRecord) {
    return res.status(404).json({ message: 'Return not found or already processed' });
  }

  res.json({ return: returnRecord, message: 'Return request rejected' });
});
