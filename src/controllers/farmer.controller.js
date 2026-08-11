import asyncHandler from '../utils/asyncHandler.js';
import { farmerModel, farmerPaymentModel } from '../models/Farmer.model.js';
import { dayBookModel } from '../models/DayBook.model.js';
import pool from '../config/db.js';
import { buildVerifyUrl, verifyReceiptToken, ReceiptType } from '../utils/receiptToken.js';
import { classifyPaymentMode } from '../utils/paymentMode.js';
import { resolveBankAccountSelection } from '../services/bankAccount.service.js';

const SPLIT_EPSILON = 1e-9;

const farmerScope = (req) => ({
  siteId: Number.parseInt(req.farmerSiteId ?? req.siteContextId, 10),
  organizationId: Number.parseInt(req.user?.organization_id, 10),
});

const memberBelongsToSite = async (memberId, siteId, organizationId, db = pool) => {
  const { rows } = await db.query(
    `SELECT 1
       FROM members m
       JOIN sites s ON s.id = m.site_id AND s.organization_id = $3
      WHERE m.id = $1 AND m.site_id = $2
      LIMIT 1`,
    [memberId, siteId, organizationId],
  );
  return Boolean(rows[0]);
};

const userAvailableForSite = async (userId, siteId, organizationId, db = pool) => {
  const { rows } = await db.query(
    `SELECT 1
       FROM users u
      WHERE u.id = $1
        AND u.organization_id = $3
        AND u.is_active = true
        AND (
          u.role IN ('admin', 'super_admin')
          OR EXISTS (
            SELECT 1 FROM user_sites us
             WHERE us.user_id = u.id AND us.site_id = $2
          )
        )
      LIMIT 1`,
    [userId, siteId, organizationId],
  );
  return Boolean(rows[0]);
};

/**
 * Normalise the farmer allocation while retaining SPLIT as the only special
 * mode. Physical cash must be explicit; blank and every other non-cheque mode
 * settle through Bank. New/edited SPLIT rows cannot create or destroy money.
 */
const normalizeFarmerAllocation = ({ paymentMode, totalAmount, cashAmount, bankAmount }) => {
  const total = Number(totalAmount ?? 0);
  if (!Number.isFinite(total)) return { error: 'Amount must be a valid number' };

  const rawMode = String(paymentMode ?? '').trim().toUpperCase();
  if (rawMode === 'SPLIT') {
    const cash = Number(cashAmount ?? 0);
    const bank = Number(bankAmount ?? 0);
    if (!Number.isFinite(cash) || !Number.isFinite(bank)) {
      return { error: 'Split cash and bank amounts must be valid numbers' };
    }
    if (cash < 0 || bank < 0) {
      return { error: 'Split cash and bank amounts cannot be negative' };
    }
    if (Math.abs((cash + bank) - total) > SPLIT_EPSILON) {
      return { error: 'Split cash and bank amounts must equal the total amount' };
    }
    return { mode: 'SPLIT', total, cash, bank };
  }

  const bucket = classifyPaymentMode(rawMode);
  const mode = bucket === 'cash' ? 'CASH' : bucket === 'cheque' ? 'CHEQUE' : 'BANK';
  return {
    mode,
    total,
    cash: bucket === 'cash' ? total : 0,
    bank: bucket === 'cash' ? 0 : total,
  };
};

const isPostedPayment = (payment) => (
  String(payment?.status ?? '').trim().toLowerCase() === 'approved'
  && !['BOUNCED', 'RETURNED'].includes(String(payment?.cheque_status ?? '').trim().toUpperCase())
);

const getFarmerPaymentLegs = (payment) => {
  if (String(payment?.payment_mode || '').trim().toUpperCase() === 'SPLIT') {
    return {
      cash: parseFloat(payment.cash_amount) || 0,
      bank: parseFloat(payment.bank_amount) || 0,
    };
  }
  const amount = parseFloat(payment?.amount) || 0;
  return classifyPaymentMode(payment?.payment_mode) === 'cash'
    ? { cash: amount, bank: 0 }
    : { cash: 0, bank: amount };
};

// ──────────────────────────────────────────────────────────────
// FARMER CRUD
// ──────────────────────────────────────────────────────────────

/**
 * POST /farmers
 * Create a new farmer (admin only)
 */
export const createFarmer = asyncHandler(async (req, res) => {
  const {
    name, phone, address, total_amount, interest_rate, site_id, notes, status, member_id,
    payment_mode, cash_amount, bank_amount, bank_name, bank_account_no, bank_reference, bank_ifsc,
    land_size_bigha, land_size_unit, land_rate, commission_percentage, commission_amount, commission_paid_to_broker,
  } = req.body;

  if (!name) {
    return res.status(400).json({ message: 'Farmer name is required' });
  }
  if (!site_id) {
    return res.status(400).json({ message: 'Site is required' });
  }
  const { siteId, organizationId } = farmerScope(req);
  if (!siteId || Number.parseInt(site_id, 10) !== siteId) {
    return res.status(409).json({ message: 'Selected site does not match the requested site' });
  }
  const parsedMemberId = member_id ? Number.parseInt(member_id, 10) : null;
  if (parsedMemberId && !await memberBelongsToSite(parsedMemberId, siteId, organizationId)) {
    return res.status(400).json({ message: 'Selected farmer member is not available for this Site' });
  }

  const allocation = normalizeFarmerAllocation({
    paymentMode: payment_mode,
    totalAmount: total_amount,
    cashAmount: cash_amount,
    bankAmount: bank_amount,
  });
  if (allocation.error) return res.status(400).json({ message: allocation.error });

  const farmerData = {
    name,
    phone: phone || null,
    address: address || null,
    total_amount: allocation.total,
    interest_rate: interest_rate || 0,
    site_id: siteId,
    created_by: req.user.id,
    notes: notes || null,
    status: status || 'active',
    member_id: parsedMemberId,
    payment_mode: allocation.mode,
    cash_amount: allocation.cash,
    bank_amount: allocation.bank,
    bank_name: bank_name || null,
    bank_account_no: bank_account_no || null,
    bank_reference: bank_reference || null,
    bank_ifsc: bank_ifsc || null,
    land_size_bigha: land_size_bigha != null && land_size_bigha !== '' ? parseFloat(land_size_bigha) : null,
    land_size_unit: ['BIGHA', 'YARD', 'SQMT'].includes(land_size_unit) ? land_size_unit : 'BIGHA',
    land_rate: land_rate != null && land_rate !== '' ? parseFloat(land_rate) : null,
    commission_percentage: commission_percentage != null && commission_percentage !== '' ? parseFloat(commission_percentage) : null,
    commission_amount: commission_amount != null && commission_amount !== '' ? parseFloat(commission_amount) : null,
    commission_paid_to_broker: commission_paid_to_broker != null && commission_paid_to_broker !== '' ? parseFloat(commission_paid_to_broker) : null,
  };

  const farmer = await farmerModel.create(farmerData, pool);
  res.status(201).json({ farmer });
});

/**
 * GET /farmers?site_id=X
 * List farmers for a site
 */
export const listFarmers = asyncHandler(async (req, res) => {
  const { site_id } = req.query;

  if (!site_id) {
    return res.status(400).json({ message: 'site_id query param is required' });
  }

  const { siteId, organizationId } = farmerScope(req);
  const farmers = await farmerModel.findBySiteIdScoped(siteId, organizationId, pool);
  res.json({ farmers });
});

/**
 * GET /farmers/:id
 * Get single farmer with summary
 */
export const getFarmer = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { siteId, organizationId } = farmerScope(req);
  const farmer = await farmerModel.findByIdWithSummaryScoped(
    parseInt(id),
    siteId,
    organizationId,
    pool,
  );

  if (!farmer) {
    return res.status(404).json({ message: 'Farmer not found' });
  }

  res.json({ farmer });
});

/**
 * PUT /farmers/:id
 * Update a farmer
 */
export const updateFarmer = asyncHandler(async (req, res) => {
  const farmerId = parseInt(req.params.id);
  const { siteId, organizationId } = farmerScope(req);
  const {
    name, phone, address, total_amount, interest_rate, notes, status, member_id,
    payment_mode, cash_amount, bank_amount, bank_name, bank_account_no, bank_reference, bank_ifsc,
    land_size_bigha, land_size_unit, land_rate, commission_percentage, commission_amount, commission_paid_to_broker,
  } = req.body;

  // Build the update set without an extra existence-check round-trip — the
  // UPDATE itself returns 0 rows if the id doesn't exist.
  const updateData = {};
  if (name !== undefined) updateData.name = name;
  if (phone !== undefined) updateData.phone = phone;
  if (address !== undefined) updateData.address = address;
  if (total_amount !== undefined) updateData.total_amount = total_amount;
  if (interest_rate !== undefined) updateData.interest_rate = interest_rate;
  if (notes !== undefined) updateData.notes = notes;
  if (status !== undefined) updateData.status = status;
  if (member_id !== undefined) {
    const parsedMemberId = member_id ? parseInt(member_id) : null;
    if (parsedMemberId && !await memberBelongsToSite(parsedMemberId, siteId, organizationId)) {
      return res.status(400).json({ message: 'Selected farmer member is not available for this Site' });
    }
    updateData.member_id = parsedMemberId;
  }
  const allocationChanged = [payment_mode, total_amount, cash_amount, bank_amount].some((value) => value !== undefined);
  if (allocationChanged) {
    const currentResult = await pool.query(
      `SELECT f.payment_mode, f.total_amount, f.cash_amount, f.bank_amount
         FROM farmers f
         JOIN sites s ON s.id = f.site_id AND s.organization_id = $3
        WHERE f.id = $1 AND f.site_id = $2`,
      [farmerId, siteId, organizationId]
    );
    const current = currentResult.rows[0];
    if (!current) return res.status(404).json({ message: 'Farmer not found' });

    const allocation = normalizeFarmerAllocation({
      paymentMode: payment_mode !== undefined ? payment_mode : current.payment_mode,
      totalAmount: total_amount !== undefined ? total_amount : current.total_amount,
      cashAmount: cash_amount !== undefined ? cash_amount : current.cash_amount,
      bankAmount: bank_amount !== undefined ? bank_amount : current.bank_amount,
    });
    if (allocation.error) return res.status(400).json({ message: allocation.error });
    updateData.payment_mode = allocation.mode;
    updateData.total_amount = allocation.total;
    updateData.cash_amount = allocation.cash;
    updateData.bank_amount = allocation.bank;
  }
  if (bank_name !== undefined) updateData.bank_name = bank_name;
  if (bank_account_no !== undefined) updateData.bank_account_no = bank_account_no;
  if (bank_reference !== undefined) updateData.bank_reference = bank_reference;
  if (bank_ifsc !== undefined) updateData.bank_ifsc = bank_ifsc;
  if (land_size_bigha !== undefined) updateData.land_size_bigha = land_size_bigha != null && land_size_bigha !== '' ? parseFloat(land_size_bigha) : null;
  if (land_size_unit !== undefined) updateData.land_size_unit = ['BIGHA', 'YARD', 'SQMT'].includes(land_size_unit) ? land_size_unit : 'BIGHA';
  if (land_rate !== undefined) updateData.land_rate = land_rate != null && land_rate !== '' ? parseFloat(land_rate) : null;
  if (commission_percentage !== undefined) updateData.commission_percentage = commission_percentage != null && commission_percentage !== '' ? parseFloat(commission_percentage) : null;
  if (commission_amount !== undefined) updateData.commission_amount = commission_amount != null && commission_amount !== '' ? parseFloat(commission_amount) : null;
  if (commission_paid_to_broker !== undefined) updateData.commission_paid_to_broker = commission_paid_to_broker != null && commission_paid_to_broker !== '' ? parseFloat(commission_paid_to_broker) : null;

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ message: 'Nothing to update' });
  }

  const updated = await farmerModel.updateScoped(
    farmerId,
    updateData,
    siteId,
    organizationId,
    pool,
  );
  if (!updated) {
    return res.status(404).json({ message: 'Farmer not found' });
  }
  res.json({ farmer: updated });
});

/**
 * DELETE /farmers/:id
 * Delete a farmer and all payments
 */
export const deleteFarmer = asyncHandler(async (req, res) => {
  const { siteId, organizationId } = farmerScope(req);
  // Atomic DELETE — if no row was deleted, return 404. Saves a SELECT round-trip.
  const result = await pool.query(
    `DELETE FROM farmers f
      USING sites s
      WHERE f.id = $1
        AND f.site_id = $2
        AND s.id = f.site_id
        AND s.organization_id = $3
      RETURNING f.id`,
    [parseInt(req.params.id), siteId, organizationId]
  );
  if (!result.rows[0]) {
    return res.status(404).json({ message: 'Farmer not found' });
  }
  res.json({ message: 'Farmer deleted' });
});

/**
 * POST /farmers/bulk-delete
 * Body: { ids: number[] }. Same as deleteFarmer — a farmer with existing
 * payments fails on the DB's FK constraint exactly as the single-delete
 * route already does; no new validation is invented here.
 */
export const bulkDeleteFarmers = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((id) => parseInt(id)).filter(Number.isInteger) : [];
  if (ids.length === 0) return res.status(400).json({ message: 'ids array is required' });

  const { siteId, organizationId } = farmerScope(req);
  const result = await pool.query(
    `DELETE FROM farmers f
      USING sites s
      WHERE f.id = ANY($1::int[])
        AND f.site_id = $2
        AND s.id = f.site_id
        AND s.organization_id = $3
      RETURNING f.id`,
    [ids, siteId, organizationId],
  );
  res.json({ message: `${result.rows.length} farmer(s) deleted`, deleted: result.rows.map((r) => r.id) });
});


// ──────────────────────────────────────────────────────────────
// FARMER PAYMENTS (INSTALLMENTS) CRUD
// ──────────────────────────────────────────────────────────────

/**
 * POST /farmers/:farmerId/payments
 * Add a payment/installment to a farmer with cash/bank split + DayBook integration
 */
export const createPayment = asyncHandler(async (req, res) => {
  const { farmerId } = req.params;
  const { siteId, organizationId } = farmerScope(req);
  const {
    date, particular, amount, by_note, remarks,
    payment_mode, cash_amount, bank_amount, bank_name, bank_account_no, bank_reference, bank_ifsc,
    voucher_url, assigned_admin_id, mapped_member_id, mapped_user_id,
    idempotency_key, schedule_item_id, bank_account_id,
  } = req.body;

  if (!particular) {
    return res.status(400).json({ message: 'Particular (payment method) is required' });
  }
  if (mapped_member_id && mapped_user_id) {
    return res.status(400).json({ message: 'Map this payment to either a client or a user, not both' });
  }

  const parsedMappedMemberId = mapped_member_id ? parseInt(mapped_member_id) : null;
  const parsedMappedUserId = mapped_user_id ? parseInt(mapped_user_id) : null;
  const parsedAdminId = assigned_admin_id ? parseInt(assigned_admin_id) : null;
  if (parsedMappedMemberId
      && !await memberBelongsToSite(parsedMappedMemberId, siteId, organizationId)) {
    return res.status(400).json({ message: 'Mapped client is not available for this Site' });
  }
  if (parsedMappedUserId
      && !await userAvailableForSite(parsedMappedUserId, siteId, organizationId)) {
    return res.status(400).json({ message: 'Mapped user is not available for this Site' });
  }
  if (parsedAdminId && !await userAvailableForSite(parsedAdminId, siteId, organizationId)) {
    return res.status(400).json({ message: 'Assigned admin is not available for this Site' });
  }

  const farmerIdInt = parseInt(farmerId);
  const allocation = normalizeFarmerAllocation({
    paymentMode: payment_mode,
    totalAmount: amount,
    cashAmount: cash_amount,
    bankAmount: bank_amount,
  });
  if (allocation.error) return res.status(400).json({ message: allocation.error });
  const totalAmount = allocation.total;
  if (req.landAcquisitionId && totalAmount <= 0) {
    return res.status(400).json({ message: 'Use the audited reversal action to correct an acquisition payment' });
  }
  const mode = allocation.mode;
  const selectedBankAccountId = await resolveBankAccountSelection({
    siteId,
    paymentMode: mode,
    bankAccountId: bank_account_id,
  });
  const cashAmt = allocation.cash;
  const bankAmt = allocation.bank;
  const canSetCustomDate = req.user.role === 'admin' || req.user.role === 'super_admin';
  const paymentDate = (canSetCustomDate && date) ? date : new Date().toISOString().split('T')[0];
  const adminId = parsedAdminId;
  const chequeNo = mode === 'CHEQUE' && req.body.cheque_no
    ? String(req.body.cheque_no).trim()
    : null;
  const chequeStatus = mode === 'CHEQUE' ? 'PENDING' : null;
  const userId = req.user.id;
  const trimmedRemarks = remarks ? remarks.trim() : null;
  const bankNameUpper = bank_name ? String(bank_name).toUpperCase() : null;
  const bankRemarks = [remarks, bank_reference ? `Ref: ${bank_reference}` : null, bank_name ? `Bank: ${bank_name}` : null].filter(Boolean).join(' | ') || null;
  const idempotencyKey = idempotency_key ? String(idempotency_key).trim().slice(0, 120) : null;
  const scheduleItemId = schedule_item_id ? Number.parseInt(schedule_item_id, 10) : null;
  if (schedule_item_id && (!Number.isSafeInteger(scheduleItemId) || scheduleItemId <= 0)) {
    return res.status(400).json({ message: 'Selected payment schedule item is invalid' });
  }

  // ─────────────────────────────────────────────────────────────
  // SINGLE-ROUND-TRIP create: farmer lookup + payment INSERT + 0/1/2
  // day_book INSERTs in one CTE. Previously this was 3 serial round-trips
  // (SELECT farmer → INSERT payment → INSERT day_book ×N).
  // ─────────────────────────────────────────────────────────────
  const result = await pool.query(
    `WITH f AS (
       SELECT f.id, f.site_id, f.name, f.member_id, f.acquisition_reference,
              f.financial_terms_status, f.completed_at, f.total_amount,
              COALESCE((
                SELECT SUM(GREATEST(existing.amount,0))
                  FROM farmer_payments existing
                 WHERE existing.farmer_id=f.id
                   AND LOWER(COALESCE(existing.status,'pending')) IN ('pending','approved')
                   AND UPPER(COALESCE(existing.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
              ),0)::numeric AS committed_paid,
              ($30::bigint IS NULL OR EXISTS (
                SELECT 1 FROM land_acquisition_payment_schedules ps
                 WHERE ps.id=$30 AND ps.acquisition_id=f.id AND ps.site_id=f.site_id
                   AND ps.superseded_at IS NULL AND ps.schedule_status <> 'CANCELLED'
                   AND COALESCE((
                     SELECT SUM(GREATEST(pa.allocated_amount,0))
                       FROM land_acquisition_payment_allocations pa
                       JOIN farmer_payments allocated ON allocated.id=pa.farmer_payment_id
                      WHERE pa.schedule_item_id=ps.id
                        AND LOWER(COALESCE(allocated.status,'pending')) IN ('pending','approved')
                        AND UPPER(COALESCE(allocated.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
                   ),0) + GREATEST($4::numeric,0) <= ps.expected_amount + 0.009
              )) AS schedule_valid
         FROM farmers f
         JOIN sites s ON s.id = f.site_id AND s.organization_id = $28
        WHERE f.id = $1 AND f.site_id = $27
     ),
     existing_payment AS (
       SELECT fp.* FROM farmer_payments fp JOIN f ON f.id=fp.farmer_id
        WHERE $29::text IS NOT NULL AND fp.idempotency_key=$29
        LIMIT 1
     ),
     new_payment AS (
       INSERT INTO farmer_payments (
         farmer_id, date, particular, amount, by_note, remarks,
         payment_mode, cash_amount, bank_amount, bank_name, bank_account_no,
         bank_reference, bank_ifsc, voucher_url, assigned_admin_id, status,
         cheque_no, cheque_status, created_by, mapped_member_id, mapped_user_id,idempotency_key,bank_account_id
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending', $16, $17, $18, $25, $26,$29,$31
       FROM f
       WHERE f.completed_at IS NULL
         AND (f.acquisition_reference IS NULL OR f.financial_terms_status='CONFIRMED')
         AND (f.acquisition_reference IS NULL OR f.committed_paid + GREATEST($4::numeric,0) <= f.total_amount + 0.009)
         AND f.schedule_valid
         AND NOT EXISTS (SELECT 1 FROM existing_payment)
       ON CONFLICT (farmer_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING *
     ),
     payment_row AS (
       SELECT np.*,FALSE AS replayed FROM new_payment np
       UNION ALL
       SELECT ep.*,TRUE AS replayed FROM existing_payment ep
       LIMIT 1
     ),
     schedule_allocation AS (
       INSERT INTO land_acquisition_payment_allocations
         (acquisition_id,schedule_item_id,farmer_payment_id,allocated_amount,created_by)
       SELECT f.id,$30,np.id,$4,$18 FROM f,new_payment np
       WHERE $30::bigint IS NOT NULL
       ON CONFLICT (schedule_item_id,farmer_payment_id) DO NOTHING
       RETURNING id
     ),
     db_cash AS (
       INSERT INTO day_book (
         site_id, date, particular, entry_type, debit, credit, remarks,
         payment_mode, category, from_entity, to_entity,
         created_by, assigned_admin_id, farmer_payment_id
       )
       SELECT
         f.site_id,
         $2::date,
         (UPPER(f.name) || ' - FARMER PAYMENT (CASH)'),
         'FARMER PAYMENT',
         $19::numeric, 0, $20::text,
         'CASH', 'FARMER PAYMENT', NULL, UPPER(f.name),
         $18::int, $15::int, np.id
       FROM f, new_payment np
       WHERE $19::numeric > 0
       RETURNING *
     ),
     db_bank AS (
       INSERT INTO day_book (
         site_id, date, particular, entry_type, debit, credit, remarks,
         payment_mode, category, from_entity, to_entity,
         account_no, branch, created_by, assigned_admin_id, farmer_payment_id, bank_account_id
       )
       SELECT
         f.site_id,
         $2::date,
         (UPPER(f.name) || ' - FARMER PAYMENT (BANK)'),
         'FARMER PAYMENT',
         $21::numeric, 0, $22::text,
         $23::text, 'FARMER PAYMENT', $24::text, UPPER(f.name),
         $11::text, $13::text, $18::int, $15::int, np.id, $31::int
       FROM f, new_payment np
       WHERE $21::numeric > 0
       RETURNING *
     )
     SELECT
       (SELECT row_to_json(pr) FROM payment_row pr) AS payment,
       COALESCE(
         (SELECT json_agg(row_to_json(d)) FROM (SELECT * FROM db_cash UNION ALL SELECT * FROM db_bank) d),
         '[]'::json
       ) AS daybook_entries,
       (SELECT id FROM f) AS farmer_id,
       (SELECT completed_at IS NOT NULL FROM f) AS acquisition_completed,
       (SELECT acquisition_reference IS NOT NULL AND financial_terms_status <> 'CONFIRMED' FROM f) AS terms_unconfirmed,
       (SELECT acquisition_reference IS NOT NULL AND committed_paid + GREATEST($4::numeric,0) > total_amount + 0.009 FROM f) AS exceeds_agreed_value,
       (SELECT NOT schedule_valid FROM f) AS invalid_schedule`,
    [
      farmerIdInt,                  // $1
      paymentDate,                  // $2
      particular,                   // $3
      totalAmount,                  // $4
      by_note || null,              // $5
      remarks || null,              // $6
      mode,                         // $7
      cashAmt,                      // $8
      bankAmt,                      // $9
      bank_name || null,            // $10
      bank_account_no || null,      // $11
      bank_reference || null,       // $12
      bank_ifsc || null,            // $13
      voucher_url || null,          // $14
      adminId,                      // $15
      chequeNo,                     // $16
      chequeStatus,                 // $17
      userId,                       // $18
      cashAmt,                      // $19 (cash debit / WHERE > 0)
      trimmedRemarks,               // $20 (cash remarks)
      bankAmt,                      // $21 (bank debit / WHERE > 0)
      bankRemarks,                  // $22 (bank remarks)
      mode,                         // $23 (canonical non-cash payment_mode)
      bankNameUpper,                // $24 (bank from_entity)
      parsedMappedMemberId,           // $25
      parsedMappedUserId,             // $26
      siteId,                       // $27 (canonical Site context)
      organizationId,               // $28 (tenant boundary)
      idempotencyKey,               // $29 (duplicate-submit protection)
      scheduleItemId,               // $30 (optional acquisition schedule allocation)
      selectedBankAccountId,        // $31 (canonical Site bank account)
    ]
  );

  const row = result.rows[0];
  if (!row?.farmer_id) {
    return res.status(404).json({ message: 'Farmer not found' });
  }
  if (!row.payment) {
    if (row.acquisition_completed) return res.status(409).json({ message: 'This acquisition is already completed' });
    if (row.terms_unconfirmed) return res.status(409).json({ message: 'Confirm financial terms before recording acquisition payments' });
    if (row.exceeds_agreed_value) return res.status(409).json({ message: 'This payment would exceed the confirmed agreed value' });
    if (row.invalid_schedule) return res.status(400).json({ message: 'Selected payment schedule item is not active for this acquisition' });
    return res.status(409).json({ message: 'The payment could not be recorded because the acquisition changed' });
  }

  res.status(row.payment.replayed ? 200 : 201).json({
    payment: row.payment,
    daybook_entries: row.daybook_entries || [],
    replayed: Boolean(row.payment.replayed),
  });
});

/**
 * GET /farmers/:farmerId/payments
 * List all payments for a farmer
 */
export const listPayments = asyncHandler(async (req, res) => {
  const farmerId = parseInt(req.params.farmerId);
  const { siteId, organizationId } = farmerScope(req);

  // The previous implementation ran 4–5 SERIAL queries:
  //   findByIdWithSummary → findByFarmerId → getTotalPaid → getTotalInterest → site
  // findByIdWithSummary already returns total_paid + total_interest, so two of
  // those queries were duplicated work. Now: 2 parallel reads (farmer+site,
  // payments) and totals are derived from the data we already have.
  const farmerWithSitePromise = pool.query(
    `SELECT
       f.*,
       COALESCE(SUM(fp.amount), 0) AS total_paid,
       COALESCE(SUM(fp.interest_amount), 0) AS total_interest,
       COUNT(fp.id) AS payment_count,
       s.name  AS site_name,
       s.code  AS site_code,
       s.address AS site_address,
       s.city  AS site_city,
       s.state AS site_state
     FROM farmers f
     LEFT JOIN farmer_payments fp ON fp.farmer_id = f.id
       AND LOWER(COALESCE(fp.status, '')) = 'approved'
       AND UPPER(COALESCE(fp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
     JOIN sites s ON s.id = f.site_id AND s.organization_id = $3
     WHERE f.id = $1 AND f.site_id = $2
     GROUP BY f.id, s.id`,
    [farmerId, siteId, organizationId]
  );
  const paymentsPromise = farmerPaymentModel.findByFarmerIdScoped(
    farmerId,
    siteId,
    organizationId,
    pool,
  );

  const [farmerRes, payments] = await Promise.all([farmerWithSitePromise, paymentsPromise]);
  const farmer = farmerRes.rows[0];
  if (!farmer) {
    return res.status(404).json({ message: 'Farmer not found' });
  }

  // Cash / bank paid totals derived from the already-fetched payments — no
  // extra DB round-trip required.
  let cashPaid = 0, bankPaid = 0;
  for (const p of payments) {
    if (!isPostedPayment(p)) continue;
    const legs = getFarmerPaymentLegs(p);
    cashPaid += legs.cash;
    bankPaid += legs.bank;
  }

  const totalPaid = parseFloat(farmer.total_paid) || 0;
  const totalInterest = parseFloat(farmer.total_interest) || 0;

  const paymentsWithVerify = payments.map((p) => {
    const legs = getFarmerPaymentLegs(p);
    return {
      ...p,
      cash_amount: legs.cash,
      bank_amount: legs.bank,
      verifyUrl: buildVerifyUrl({
        t: ReceiptType.FARMER,
        i: p.id,
        fn: farmer.name || null,
        a: p.amount,
        d: p.date,
        pm: p.payment_mode || null,
        sn: farmer.site_name || null,
        sy: farmer.site_city || null,
        ss: farmer.site_state || null,
      }),
    };
  });

  res.json({
    farmer,
    payments: paymentsWithVerify,
    summary: {
      total_amount: parseFloat(farmer.total_amount),
      total_paid: totalPaid,
      total_interest: totalInterest,
      remaining: parseFloat(farmer.total_amount) - totalPaid,
      cash_to_pay: parseFloat(farmer.cash_amount) || 0,
      bank_to_pay: parseFloat(farmer.bank_amount) || 0,
      cash_paid: cashPaid,
      bank_paid: bankPaid,
      cash_remaining: (parseFloat(farmer.cash_amount) || 0) - cashPaid,
      bank_remaining: (parseFloat(farmer.bank_amount) || 0) - bankPaid,
    },
  });
});

/**
 * PUT /farmers/:farmerId/payments/:paymentId
 * Update a payment
 */
export const updatePayment = asyncHandler(async (req, res) => {
  const farmerId = parseInt(req.params.farmerId);
  const paymentId = parseInt(req.params.paymentId);
  const { siteId, organizationId } = farmerScope(req);
  const {
    date, particular, amount, by_note, remarks,
    payment_mode, cash_amount, bank_amount, bank_name, bank_account_no, bank_reference, bank_ifsc,
    voucher_url, cheque_no, bank_account_id,
  } = req.body;

  const existingResult = await pool.query(
    `SELECT fp.*, f.acquisition_reference,
            EXISTS (
              SELECT 1 FROM land_acquisition_payment_allocations pa
               WHERE pa.farmer_payment_id = fp.id
            ) AS has_acquisition_allocation
       FROM farmer_payments fp
       JOIN farmers f ON f.id = fp.farmer_id AND f.site_id = $3
       JOIN sites s ON s.id = f.site_id AND s.organization_id = $4
      WHERE fp.id = $1 AND fp.farmer_id = $2`,
    [paymentId, farmerId, siteId, organizationId]
  );
  const existing = existingResult.rows[0];
  if (!existing) return res.status(404).json({ message: 'Payment not found' });
  if (existing.acquisition_reference || existing.has_acquisition_allocation) {
    return res.status(409).json({ message: 'Acquisition payments are immutable here. Use the audited land-acquisition reversal workflow.' });
  }

  const canSetCustomDate = req.user.role === 'admin' || req.user.role === 'super_admin';
  const updateData = {};
  if (date !== undefined && canSetCustomDate) updateData.date = date;
  if (particular !== undefined) updateData.particular = particular;
  if (amount !== undefined) updateData.amount = amount;
  if (by_note !== undefined) updateData.by_note = by_note;
  if (remarks !== undefined) updateData.remarks = remarks;
  const allocationChanged = [payment_mode, amount, cash_amount, bank_amount].some((value) => value !== undefined);
  if (allocationChanged) {
    const allocation = normalizeFarmerAllocation({
      paymentMode: payment_mode !== undefined ? payment_mode : existing.payment_mode,
      totalAmount: amount !== undefined ? amount : existing.amount,
      cashAmount: cash_amount !== undefined ? cash_amount : existing.cash_amount,
      bankAmount: bank_amount !== undefined ? bank_amount : existing.bank_amount,
    });
    if (allocation.error) return res.status(400).json({ message: allocation.error });
    updateData.payment_mode = allocation.mode;
    updateData.amount = allocation.total;
    updateData.cash_amount = allocation.cash;
    updateData.bank_amount = allocation.bank;
    if (allocation.mode === 'CHEQUE') {
      updateData.cheque_status = classifyPaymentMode(existing.payment_mode) === 'cheque'
        ? (existing.cheque_status || 'PENDING')
        : 'PENDING';
      updateData.cheque_no = cheque_no !== undefined
        ? (cheque_no ? String(cheque_no).trim() : null)
        : (classifyPaymentMode(existing.payment_mode) === 'cheque' ? existing.cheque_no || null : null);
    } else {
      updateData.cheque_status = null;
      updateData.cheque_no = null;
    }
  }
  if (allocationChanged || bank_account_id !== undefined) {
    updateData.bank_account_id = await resolveBankAccountSelection({
      siteId,
      paymentMode: updateData.payment_mode || existing.payment_mode,
      bankAccountId: bank_account_id !== undefined ? bank_account_id : existing.bank_account_id,
    });
  }
  if (bank_name !== undefined) updateData.bank_name = bank_name;
  if (bank_account_no !== undefined) updateData.bank_account_no = bank_account_no;
  if (bank_reference !== undefined) updateData.bank_reference = bank_reference;
  if (bank_ifsc !== undefined) updateData.bank_ifsc = bank_ifsc;
  if (voucher_url !== undefined) updateData.voucher_url = voucher_url || null;
  if (!allocationChanged && cheque_no !== undefined) {
    updateData.cheque_no = classifyPaymentMode(existing.payment_mode) === 'cheque' && cheque_no
      ? String(cheque_no).trim()
      : null;
  }

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ message: 'Nothing to update' });
  }

  // Atomic UPDATE scoped by both id AND farmer_id so we don't need a separate
  // SELECT round-trip to verify ownership.
  const keys = Object.keys(updateData);
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = [...Object.values(updateData), paymentId, farmerId, siteId, organizationId];
  const result = await pool.query(
    `UPDATE farmer_payments fp
        SET ${setClause}
       FROM farmers f, sites s
      WHERE fp.id = $${keys.length + 1}
        AND fp.farmer_id = $${keys.length + 2}
        AND f.id = fp.farmer_id
        AND f.site_id = $${keys.length + 3}
        AND s.id = f.site_id
        AND s.organization_id = $${keys.length + 4}
      RETURNING fp.*`,
    values
  );
  if (!result.rows[0]) {
    return res.status(404).json({ message: 'Payment not found' });
  }
  res.json({ payment: result.rows[0] });
});

/**
 * DELETE /farmers/:farmerId/payments/:paymentId
 * Delete a payment
 */
export const deletePayment = asyncHandler(async (req, res) => {
  const farmerId = parseInt(req.params.farmerId);
  const paymentId = parseInt(req.params.paymentId);
  const { siteId, organizationId } = farmerScope(req);
  const linked = await pool.query(
    `SELECT 1
       FROM farmer_payments fp
       JOIN farmers f ON f.id = fp.farmer_id
      WHERE fp.id = $1 AND fp.farmer_id = $2 AND f.site_id = $3
        AND (f.acquisition_reference IS NOT NULL OR EXISTS (
          SELECT 1 FROM land_acquisition_payment_allocations pa WHERE pa.farmer_payment_id = fp.id
        ))`,
    [paymentId, farmerId, siteId],
  );
  if (linked.rows[0]) {
    return res.status(409).json({ message: 'Acquisition payments must be reversed through the audited land-acquisition workflow.' });
  }

  // Single round-trip: cascade-delete the linked DayBook rows AND the payment
  // in one atomic statement (CTE). Previously: SELECT + DELETE day_book +
  // DELETE payment = 3 serial round-trips.
  const result = await pool.query(
    `WITH target AS (
       SELECT fp.id
         FROM farmer_payments fp
         JOIN farmers f ON f.id = fp.farmer_id AND f.site_id = $3
         JOIN sites s ON s.id = f.site_id AND s.organization_id = $4
        WHERE fp.id = $1 AND fp.farmer_id = $2
     ),
     del_daybook AS (
       DELETE FROM day_book d
        USING target t
        WHERE d.farmer_payment_id = t.id
     ),
     deleted AS (
       DELETE FROM farmer_payments fp
        USING target t
        WHERE fp.id = t.id
        RETURNING fp.id
     )
     SELECT id FROM deleted`,
    [paymentId, farmerId, siteId, organizationId]
  );
  if (!result.rows[0]) {
    return res.status(404).json({ message: 'Payment not found' });
  }
  res.json({ message: 'Payment deleted' });
});

/**
 * POST /farmers/:farmerId/payments/bulk-delete
 * Body: { ids: number[] }
 */
export const bulkDeletePayments = asyncHandler(async (req, res) => {
  const farmerId = parseInt(req.params.farmerId);
  const { siteId, organizationId } = farmerScope(req);
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((id) => parseInt(id)).filter(Number.isInteger) : [];
  if (ids.length === 0) return res.status(400).json({ message: 'ids array is required' });
  if (ids.length > 100) return res.status(400).json({ message: 'Bulk requests are limited to 100 payments' });
  const linked = await pool.query(
    `SELECT 1
       FROM farmer_payments fp
       JOIN farmers f ON f.id = fp.farmer_id
      WHERE fp.id = ANY($1::int[]) AND fp.farmer_id = $2 AND f.site_id = $3
        AND (f.acquisition_reference IS NOT NULL OR EXISTS (
          SELECT 1 FROM land_acquisition_payment_allocations pa WHERE pa.farmer_payment_id = fp.id
        )) LIMIT 1`,
    [ids, farmerId, siteId],
  );
  if (linked.rows[0]) {
    return res.status(409).json({ message: 'Acquisition payments must be reversed through the audited land-acquisition workflow.' });
  }

  const result = await pool.query(
    `WITH target AS (
       SELECT fp.id
         FROM farmer_payments fp
         JOIN farmers f ON f.id = fp.farmer_id AND f.site_id = $3
         JOIN sites s ON s.id = f.site_id AND s.organization_id = $4
        WHERE fp.id = ANY($1::int[]) AND fp.farmer_id = $2
     ),
     del_daybook AS (
       DELETE FROM day_book d
        USING target t
        WHERE d.farmer_payment_id = t.id
     ),
     deleted AS (
       DELETE FROM farmer_payments fp
        USING target t
        WHERE fp.id = t.id
        RETURNING fp.id
     )
     SELECT id FROM deleted`,
    [ids, farmerId, siteId, organizationId]
  );
  res.json({ message: `${result.rows.length} payment(s) deleted`, deleted: result.rows.map((r) => r.id) });
});

// ──────────────────────────────────────────────────────────────
// FARMER MEMBERS (for Register Farmer dropdown)
// ──────────────────────────────────────────────────────────────

/**
 * GET /farmers/members?site_id=X
 * List all registered members for farmer registration dropdown
 */
export const listFarmerMembers = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const { siteId, organizationId } = farmerScope(req);
  const result = await pool.query(
    `SELECT m.id, m.full_name, m.phone, m.address, m.bank_name,
            m.branch AS bank_branch, m.account_no AS bank_account_no,
            m.ifsc_code AS bank_ifsc, m.member_type
       FROM members m
       JOIN sites s ON s.id = m.site_id AND s.organization_id = $2
      WHERE m.site_id = $1 AND m.member_type = 'FARMER'
      ORDER BY m.full_name ASC`,
    [siteId, organizationId]
  );

  res.json({ members: result.rows });
});

// ──────────────────────────────────────────────────────────────
// PUBLIC RECEIPT VERIFY
// ──────────────────────────────────────────────────────────────

/**
 * GET /farmers/verify-receipt?token=...
 * Public endpoint — verifies an HMAC-signed farmer payment receipt token.
 */
export const verifyFarmerReceipt = (req, res) => {
  const result = verifyReceiptToken(req.query?.token);
  if (!result.valid) {
    return res.status(400).json({ valid: false, message: result.reason });
  }
  return res.json({ valid: true, receipt: result.payload });
};
