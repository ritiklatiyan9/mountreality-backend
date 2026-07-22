import asyncHandler from '../utils/asyncHandler.js';
import { firmModel, firmTransactionModel } from '../models/Firm.model.js';
import { cashFlowMonthModel, cashFlowEntryModel } from '../models/CashFlow.model.js';
import pool from '../config/db.js';
import { normalizeCashType } from '../utils/paymentMode.js';

const normalizeTxnText = (value) => (value || '').toString().trim().replace(/\s+/g, ' ').toUpperCase();

const normalizeTxnDate = (value) => {
  if (!value) return '';

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const raw = value.toString().trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw.slice(0, 10);

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  return raw;
};

// Cheque-aware signature. Cheque no is part of the dedup key so two real
// transactions with the same date/description/amount but different cheque
// numbers (common with batched cheque clearings) are NOT collapsed. A blank
// cheque ('-' or '') normalizes to empty so prior-imported cash entries still
// dedup against fresh cash entries with the same fields.
const normalizeChequeNo = (value) => {
  const s = (value || '').toString().trim();
  if (!s || s === '-') return '';
  return s.toUpperCase();
};

const txnSignature = ({ date, description, debit, credit, cheque_no }) => {
  const amtDebit = Number.parseFloat(debit || 0).toFixed(2);
  const amtCredit = Number.parseFloat(credit || 0).toFixed(2);
  return [
    normalizeTxnDate(date),
    normalizeTxnText(description),
    amtDebit,
    amtCredit,
    normalizeChequeNo(cheque_no),
  ].join('|');
};

const buildTransferGroupId = () => `FTF-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

const syncInboundTransferPair = async (outbound, db = pool) => {
  if (!outbound?.is_firm_to_firm_transfer) return;
  if (String(outbound.transfer_direction || '').toUpperCase() !== 'OUT') return;
  if (!outbound.transfer_group_id) return;

  const amount = Math.max(Math.abs(parseFloat(outbound.debit) || 0), Math.abs(parseFloat(outbound.credit) || 0));
  const mode = normalizeCashType(outbound.payment_mode);
  await db.query(
    `UPDATE firm_transactions inbound
        SET date = $2,
            payment_mode = $3,
            debit = 0,
            credit = $4,
            purpose = $5,
            remark = $6,
            cheque_no = $7,
            cheque_status = $8,
            voucher_url = $9,
            status = $10,
            approved_by = $11,
            approved_at = $12,
            updated_at = NOW()
      WHERE inbound.transfer_group_id = $1
        AND UPPER(COALESCE(inbound.transfer_direction, '')) = 'IN'`,
    [
      outbound.transfer_group_id,
      outbound.date,
      mode,
      amount,
      outbound.purpose,
      outbound.remark,
      mode === 'cheque' ? outbound.cheque_no || null : null,
      mode === 'cheque' ? outbound.cheque_status || 'PENDING' : null,
      outbound.voucher_url,
      outbound.status,
      outbound.approved_by,
      outbound.approved_at,
    ]
  );
};

// ══════════════════════════════════════════════════
//  FIRM (ACCOUNT) ENDPOINTS
// ══════════════════════════════════════════════════

/**
 * POST /firms
 * Create a new firm / bank account for a site
 */
export const createFirm = asyncHandler(async (req, res) => {
  const { site_id, name, account_number, bank_name, ifsc_code, opening_balance, notes } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  if (!name || !name.trim()) return res.status(400).json({ message: 'Firm name is required' });

  const trimmedName = name.trim().toUpperCase();

  // Single CTE round-trip: dup check + INSERT. Was 2 serial RTTs.
  const result = await pool.query(
    `WITH existing AS (
       SELECT 1 FROM firms
        WHERE site_id = $1 AND UPPER(name) = $2
        LIMIT 1
     ),
     ins AS (
       INSERT INTO firms (site_id, name, account_number, bank_name, ifsc_code, opening_balance, notes, created_by)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8
       WHERE NOT EXISTS (SELECT 1 FROM existing)
       RETURNING *
     )
     SELECT
       (SELECT row_to_json(ins) FROM ins) AS firm,
       EXISTS (SELECT 1 FROM existing) AS dup`,
    [
      parseInt(site_id),
      trimmedName,
      account_number ? account_number.trim() : null,
      bank_name ? bank_name.trim().toUpperCase() : null,
      ifsc_code ? ifsc_code.trim().toUpperCase() : null,
      parseFloat(opening_balance) || 0,
      notes ? notes.trim() : null,
      req.user.id,
    ]
  );
  const row = result.rows[0];
  if (row.dup) return res.status(409).json({ message: `Firm "${trimmedName}" already exists for this site` });
  res.status(201).json({ firm: row.firm });
});

/**
 * GET /firms?site_id=X
 * List all firms for a site with stats
 */
export const listFirms = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const firms = await firmModel.findBySiteId(parseInt(site_id), pool);
  res.json({ firms });
});

/**
 * GET /firms/:id
 * Get one firm with totals
 */
export const getFirm = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const firm = await firmModel.findByIdWithTotals(parseInt(id), pool);
  if (!firm) return res.status(404).json({ message: 'Firm not found' });
  res.json({ firm });
});

/**
 * PUT /firms/:id
 * Update firm details
 */
export const updateFirm = asyncHandler(async (req, res) => {
  const firmId = parseInt(req.params.id);
  const { name, account_number, bank_name, ifsc_code, opening_balance, notes } = req.body;

  const updateData = {};
  if (name !== undefined) updateData.name = name.trim().toUpperCase();
  if (account_number !== undefined) updateData.account_number = account_number ? account_number.trim() : null;
  if (bank_name !== undefined) updateData.bank_name = bank_name ? bank_name.trim().toUpperCase() : null;
  if (ifsc_code !== undefined) updateData.ifsc_code = ifsc_code ? ifsc_code.trim().toUpperCase() : null;
  if (opening_balance !== undefined) updateData.opening_balance = parseFloat(opening_balance) || 0;
  if (notes !== undefined) updateData.notes = notes ? notes.trim() : null;

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ message: 'Nothing to update' });
  }

  // Atomic UPDATE — saves a SELECT round-trip. Duplicate name handled by
  // the rare 23505 unique-violation case below if a real UNIQUE constraint
  // is in place; otherwise the application-level check is best-effort.
  try {
    const updated = await firmModel.update(firmId, updateData, pool);
    if (!updated) return res.status(404).json({ message: 'Firm not found' });
    res.json({ firm: updated });
  } catch (err) {
    if (err?.code === '23505') {
      return res.status(409).json({ message: `Firm "${updateData.name}" already exists` });
    }
    throw err;
  }
});

/**
 * DELETE /firms/:id
 * Delete a firm and all its transactions (CASCADE)
 */
export const deleteFirm = asyncHandler(async (req, res) => {
  // Atomic DELETE — saves a SELECT round-trip.
  const result = await pool.query(
    `DELETE FROM firms WHERE id = $1 RETURNING id`,
    [parseInt(req.params.id)]
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Firm not found' });
  res.json({ message: 'Firm deleted' });
});

// ══════════════════════════════════════════════════
//  FIRM TRANSACTION ENDPOINTS
// ══════════════════════════════════════════════════

/**
 * POST /firms/transactions
 * Add a new transaction to a firm. The unified-ledger trigger owns the single
 * canonical cash_flow_entries row; controllers must never dual-post it.
 */
export const createTransaction = asyncHandler(async (req, res) => {
  const { firm_id, date, description, debit, credit, name, purpose, remark, remark2, cheque_no, transaction_no,
          voucher_url, payment_mode, assigned_admin_id,
          mapped_member_id, mapped_user_id } = req.body;

  if (!firm_id) return res.status(400).json({ message: 'Firm is required' });
  if (!description || !description.trim()) return res.status(400).json({ message: 'Description is required' });
  if (mapped_member_id && mapped_user_id) {
    return res.status(400).json({ message: 'Map this entry to either a client or a user, not both' });
  }

  const firmIdInt = parseInt(firm_id);
  const firm = await firmModel.findById(firmIdInt, pool);
  if (!firm) return res.status(404).json({ message: 'Firm not found' });

  const txnDate = date || new Date().toISOString().split('T')[0];
  const txnDebit = parseFloat(debit) || 0;
  const txnCredit = parseFloat(credit) || 0;
  const txnPaymentMode = normalizeCashType(payment_mode);

  const data = {
    firm_id: firmIdInt,
    site_id: firm.site_id,
    date: txnDate,
    description: description.trim(),
    payment_mode: txnPaymentMode,
    debit: txnDebit,
    credit: txnCredit,
    name: name ? name.trim().toUpperCase() : null,
    purpose: purpose ? purpose.trim().toUpperCase() : null,
    remark: remark ? remark.trim().toUpperCase() : null,
    remark2: remark2 ? remark2.trim() : null,
    cheque_no: txnPaymentMode === 'cheque' && cheque_no ? cheque_no.trim() : null,
    transaction_no: transaction_no ? transaction_no.trim() : null,
    created_by: req.user.id,
    voucher_url: voucher_url || null,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    status: 'pending',
    cheque_status: txnPaymentMode === 'cheque' ? 'PENDING' : null,
    mapped_member_id: mapped_member_id ? parseInt(mapped_member_id) : null,
    mapped_user_id: mapped_user_id ? parseInt(mapped_user_id) : null,
  };

  const txn = await firmTransactionModel.create(data, pool);
  res.status(201).json({ transaction: txn, message: 'Transaction added' });
});

/**
 * POST /firms/transactions/firm-to-firm
 * Create a pending firm-to-firm transfer request (approved later by admin approvals flow)
 */
export const createFirmToFirmTransfer = asyncHandler(async (req, res) => {
  const {
    from_firm_id,
    to_site_id,
    to_firm_id,
    amount,
    date,
    payment_mode,
    description,
    purpose,
    remark,
    remark2,
    cheque_no,
    voucher_url,
    assigned_admin_id,
  } = req.body;

  if (!from_firm_id) return res.status(400).json({ message: 'Source firm is required' });
  if (!to_site_id) return res.status(400).json({ message: 'Target site is required' });
  if (!to_firm_id) return res.status(400).json({ message: 'Target firm is required' });

  const transferAmount = parseFloat(amount) || 0;
  if (transferAmount <= 0) return res.status(400).json({ message: 'Transfer amount must be greater than 0' });

  const fromFirmInt = parseInt(from_firm_id);
  const toFirmInt = parseInt(to_firm_id);
  const toSiteInt = parseInt(to_site_id);

  // Parallelize: 2 firm lookups + site lookup. Was 3 serial round-trips.
  const [firmsRes, targetSiteRes] = await Promise.all([
    pool.query(
      `SELECT id, site_id, name FROM firms WHERE id = ANY($1::int[])`,
      [[fromFirmInt, toFirmInt]]
    ),
    pool.query(
      `SELECT id, name FROM sites WHERE id = $1`,
      [toSiteInt]
    ),
  ]);
  const firmsById = new Map(firmsRes.rows.map((f) => [f.id, f]));
  const sourceFirm = firmsById.get(fromFirmInt);
  const targetFirm = firmsById.get(toFirmInt);
  if (!sourceFirm) return res.status(404).json({ message: 'Source firm not found' });
  if (!targetFirm) return res.status(404).json({ message: 'Target firm not found' });

  if (sourceFirm.id === targetFirm.id) {
    return res.status(400).json({ message: 'Source and target firm cannot be same' });
  }

  if (parseInt(targetFirm.site_id) !== toSiteInt) {
    return res.status(400).json({ message: 'Selected target firm does not belong to selected site' });
  }

  if (!targetSiteRes.rows[0]) return res.status(404).json({ message: 'Target site not found' });

  const transferDate = date || new Date().toISOString().split('T')[0];
  const mode = normalizeCashType(payment_mode);
  const transferGroupId = buildTransferGroupId();

  const sourceDescription = description && description.trim()
    ? description.trim()
    : `TRANSFER TO ${targetFirm.name} (${targetSiteRes.rows[0].name})`;

  const txn = await firmTransactionModel.create({
    firm_id: parseInt(sourceFirm.id),
    site_id: parseInt(sourceFirm.site_id),
    date: transferDate,
    description: sourceDescription,
    payment_mode: mode,
    debit: transferAmount,
    credit: 0,
    name: targetFirm.name,
    purpose: purpose ? purpose.trim().toUpperCase() : 'FIRM TO FIRM TRANSFER',
    remark: remark ? remark.trim().toUpperCase() : 'FIRM TO FIRM TRANSFER',
    remark2: remark2 ? remark2.trim() : null,
    cheque_no: mode === 'cheque' && cheque_no ? cheque_no.trim() : null,
    voucher_url: voucher_url || null,
    created_by: req.user.id,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    status: 'pending',
    cheque_status: mode === 'cheque' ? 'PENDING' : null,
    is_firm_to_firm_transfer: true,
    transfer_to_site_id: parseInt(targetSiteRes.rows[0].id),
    transfer_to_firm_id: parseInt(targetFirm.id),
    transfer_group_id: transferGroupId,
    transfer_direction: 'OUT',
  }, pool);

  res.status(201).json({
    transaction: txn,
    message: 'Firm-to-firm transfer submitted for admin approval',
  });
});

/**
 * POST /firms/transactions/bulk
 * Bulk import — three phases:
 *   1. validate + normalize all rows in memory (no I/O)
 *   2. resolve every referenced firm + every existing signature in TWO queries
 *   3. multi-row INSERT chunked at ~1000 rows inside a single transaction
 *
 *  Old path issued ~3N round-trips for N rows. This path issues 2 lookups +
 *  ceil(N/CHUNK) inserts (typically ~3 RTTs for any reasonable batch).
 */
const BULK_INSERT_COLUMNS = [
  'firm_id', 'site_id', 'date', 'description', 'payment_mode',
  'debit', 'credit', 'name', 'purpose', 'remark', 'remark2',
  'cheque_no', 'cheque_status', 'voucher_url', 'assigned_admin_id', 'status', 'created_by',
];
const BULK_INSERT_CHUNK = 1000; // 1000 * 17 = 17k params, safely under PG's 65535 cap
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const bulkCreateTransactions = asyncHandler(async (req, res) => {
  const { transactions } = req.body;

  if (!Array.isArray(transactions) || transactions.length === 0) {
    return res.status(400).json({ message: 'transactions array is required and must not be empty' });
  }

  const startTs = Date.now();
  const errors = [];
  const duplicates = [];
  const validRows = [];           // post-validation candidates
  const referencedFirmIds = new Set();

  // ── Phase 1: pure JS validation + normalization ──────────────────
  for (let i = 0; i < transactions.length; i++) {
    const txn = transactions[i] || {};
    const rowIdx = i + 1;
    const { firm_id, date, description, debit, credit, name, purpose,
            remark, remark2, cheque_no, payment_mode } = txn;

    if (!firm_id) { errors.push({ row: rowIdx, error: 'Firm ID is required' }); continue; }
    if (!description || !description.toString().trim()) {
      errors.push({ row: rowIdx, error: 'Description is required' }); continue;
    }
    const txnDebit  = parseFloat(debit)  || 0;
    const txnCredit = parseFloat(credit) || 0;
    if (txnDebit === 0 && txnCredit === 0) {
      errors.push({ row: rowIdx, error: 'Either debit or credit amount is required' }); continue;
    }
    const parsedFirmId = parseInt(firm_id);
    if (Number.isNaN(parsedFirmId)) {
      errors.push({ row: rowIdx, error: 'Invalid firm ID' }); continue;
    }
    const txnDate = normalizeTxnDate(date || new Date());
    if (!ISO_DATE_RE.test(txnDate)) {
      errors.push({ row: rowIdx, error: `Invalid date: ${date}` }); continue;
    }

    const normalizedDescription = description.toString().trim();
    const normalizedChequeNo = cheque_no ? cheque_no.toString().trim() : null;
    const txnPaymentMode = normalizeCashType(payment_mode);
    const signature = txnSignature({
      date: txnDate,
      description: normalizedDescription,
      debit: txnDebit,
      credit: txnCredit,
      cheque_no: normalizedChequeNo,
    });

    referencedFirmIds.add(parsedFirmId);
    validRows.push({
      rowIdx,
      firmId: parsedFirmId,
      signature,
      data: {
        firm_id: parsedFirmId,
        date: txnDate,
        description: normalizedDescription,
        payment_mode: txnPaymentMode,
        debit: txnDebit,
        credit: txnCredit,
        name:    name    ? name.toString().trim().toUpperCase()    : null,
        purpose: purpose ? purpose.toString().trim().toUpperCase() : null,
        remark:  remark  ? remark.toString().trim().toUpperCase()  : null,
        remark2: remark2 ? remark2.toString().trim()               : null,
        cheque_no: txnPaymentMode === 'cheque' && cheque_no ? cheque_no.toString().trim() : null,
        cheque_status: txnPaymentMode === 'cheque' ? 'PENDING' : null,
        voucher_url: null,
        assigned_admin_id: null,
        status: 'pending',
      },
    });
  }

  if (validRows.length === 0) {
    return res.status(201).json({
      count: 0,
      total: transactions.length,
      duplicateCount: 0,
      errors: errors.length > 0 ? errors : undefined,
      elapsedMs: Date.now() - startTs,
      message: `Imported 0/${transactions.length} transactions`,
    });
  }

  // ── Phase 2: resolve every firm + every existing signature in 2 queries ──
  const firmIdsArr = [...referencedFirmIds];
  const [firmsRes, existingRes] = await Promise.all([
    pool.query(`SELECT id, site_id FROM firms WHERE id = ANY($1::int[])`, [firmIdsArr]),
    pool.query(
      `SELECT firm_id, TO_CHAR(date, 'YYYY-MM-DD') AS date, description, debit, credit, cheque_no
         FROM firm_transactions
        WHERE firm_id = ANY($1::int[])`,
      [firmIdsArr],
    ),
  ]);

  const firmById = new Map(firmsRes.rows.map((f) => [f.id, f]));
  const existingKeys = new Set();
  for (const row of existingRes.rows) {
    const sig = txnSignature({
      date: row.date || '',
      description: row.description,
      debit: row.debit,
      credit: row.credit,
      cheque_no: row.cheque_no,
    });
    existingKeys.add(`${row.firm_id}|${sig}`);
  }

  // ── Phase 3: dedup against existing + within-batch, build insert tuples ──
  const insertable = [];
  const seenInBatch = new Set();
  for (const row of validRows) {
    const firm = firmById.get(row.firmId);
    if (!firm) {
      errors.push({ row: row.rowIdx, error: 'Firm not found' });
      continue;
    }
    const key = `${row.firmId}|${row.signature}`;
    if (seenInBatch.has(key)) {
      duplicates.push({ row: row.rowIdx, reason: 'Duplicate in uploaded file' });
      continue;
    }
    if (existingKeys.has(key)) {
      duplicates.push({ row: row.rowIdx, reason: 'Already exists in firm transactions' });
      continue;
    }
    seenInBatch.add(key);
    insertable.push({
      rowIdx: row.rowIdx,
      values: { ...row.data, site_id: firm.site_id, created_by: req.user.id },
    });
  }

  if (insertable.length === 0) {
    return res.status(201).json({
      count: 0,
      total: transactions.length,
      duplicateCount: duplicates.length,
      duplicates: duplicates.length > 0 ? duplicates : undefined,
      errors: errors.length > 0 ? errors : undefined,
      elapsedMs: Date.now() - startTs,
      message: `Imported 0/${transactions.length} transactions${duplicates.length ? ` (${duplicates.length} duplicates skipped)` : ''}`,
    });
  }

  // ── Phase 4: batched multi-row INSERT inside one transaction ──────
  const COLS = BULK_INSERT_COLUMNS;
  const COLS_PER_ROW = COLS.length;
  const insertedResults = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (let offset = 0; offset < insertable.length; offset += BULK_INSERT_CHUNK) {
      const chunk = insertable.slice(offset, offset + BULK_INSERT_CHUNK);
      const params = new Array(chunk.length * COLS_PER_ROW);
      const valueGroups = new Array(chunk.length);

      for (let i = 0; i < chunk.length; i++) {
        const v = chunk[i].values;
        const base = i * COLS_PER_ROW;
        params[base + 0]  = v.firm_id;
        params[base + 1]  = v.site_id;
        params[base + 2]  = v.date;
        params[base + 3]  = v.description;
        params[base + 4]  = v.payment_mode;
        params[base + 5]  = v.debit;
        params[base + 6]  = v.credit;
        params[base + 7]  = v.name;
        params[base + 8]  = v.purpose;
        params[base + 9]  = v.remark;
        params[base + 10] = v.remark2;
        params[base + 11] = v.cheque_no;
        params[base + 12] = v.cheque_status;
        params[base + 13] = v.voucher_url;
        params[base + 14] = v.assigned_admin_id;
        params[base + 15] = v.status;
        params[base + 16] = v.created_by;

        const placeholders = new Array(COLS_PER_ROW);
        for (let c = 0; c < COLS_PER_ROW; c++) placeholders[c] = `$${base + c + 1}`;
        valueGroups[i] = `(${placeholders.join(',')})`;
      }

      const sql = `INSERT INTO firm_transactions (${COLS.join(',')}) VALUES ${valueGroups.join(',')} RETURNING id`;
      const inserted = await client.query(sql, params);

      for (let i = 0; i < inserted.rows.length; i++) {
        insertedResults.push({ row: chunk[i].rowIdx, id: inserted.rows[i].id, status: 'success' });
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(500).json({
      message: 'Bulk insert failed',
      error: err.message,
      elapsedMs: Date.now() - startTs,
    });
  } finally {
    client.release();
  }

  const elapsedMs = Date.now() - startTs;
  res.status(201).json({
    count: insertedResults.length,
    total: transactions.length,
    duplicateCount: duplicates.length,
    results: insertedResults,
    duplicates: duplicates.length > 0 ? duplicates : undefined,
    errors: errors.length > 0 ? errors : undefined,
    elapsedMs,
    message: `Imported ${insertedResults.length}/${transactions.length} transactions${duplicates.length ? ` (${duplicates.length} duplicates skipped)` : ''} in ${elapsedMs}ms`,
  });
});

/**
 * GET /firms/transactions?firm_id=X
 * List all transactions for a firm + summary + breakdowns
 * Enriches linked cash flow entries with ledger info
 */
export const listTransactions = asyncHandler(async (req, res) => {
  const { firm_id } = req.query;
  if (!firm_id) return res.status(400).json({ message: 'firm_id is required' });

  const fId = parseInt(firm_id);

  // Step 1: load transactions + parallel breakdowns + firm + cf-firm-entries.
  // The cf-firm-entries query no longer depends on the transactions list,
  // so it can run in the same parallel batch (was a serial follow-up).
  const cfFirmPromise = pool.query(
    `SELECT
       cfe.id,
       cfe.date,
       cfe.particular AS description,
       CASE WHEN cfe.from_firm_id = $1 THEN COALESCE(cfe.debit, 0) + COALESCE(cfe.credit, 0) ELSE 0 END AS debit,
       CASE WHEN cfe.to_firm_id   = $1 THEN COALESCE(cfe.debit, 0) + COALESCE(cfe.credit, 0) ELSE 0 END AS credit,
       cfe.cash_type AS payment_mode,
       cfe.status,
       cfe.cheque_status,
       cfe.remarks AS remark,
       CASE
         WHEN cfe.from_firm_id = $1 AND cfe.to_name IS NOT NULL THEN cfe.to_name
         WHEN cfe.from_firm_id = $1 THEN tf.name
         ELSE ff.name
       END AS name,
       cfm.ledger_name AS cf_ledger_name,
       cfm.ledger_type AS cf_ledger_type,
       cfm.month AS cf_month,
       cfm.year AS cf_year
     FROM cash_flow_entries cfe
     JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
     LEFT JOIN firms ff ON ff.id = cfe.from_firm_id
     LEFT JOIN firms tf ON tf.id = cfe.to_firm_id
     WHERE cfe.is_firm_transaction = TRUE
       AND (cfe.from_firm_id = $1 OR cfe.to_firm_id = $1)
     ORDER BY cfe.date ASC, cfe.created_at ASC`,
    [fId]
  );

  const [transactions, summary, remarkBreakdown, nameBreakdown, firmData, cfFirmResult] = await Promise.all([
    firmTransactionModel.findByFirmId(fId, pool),
    firmTransactionModel.getFirmSummary(fId, pool),
    firmTransactionModel.getRemarkBreakdown(fId, pool),
    firmTransactionModel.getNameBreakdown(fId, pool),
    firmModel.findByIdWithTotals(fId, pool),
    cfFirmPromise,
  ]);

  // Step 2: enrich transactions that link to a cash_flow_entry. Only one
  // extra query when there are linked entries — most pages will skip this.
  const cfEntryIds = transactions.filter((t) => t.cash_flow_entry_id).map((t) => t.cash_flow_entry_id);
  let cfMap = {};
  if (cfEntryIds.length > 0) {
    const cfResult = await pool.query(
      `SELECT cfe.id, cfm.ledger_name, cfm.ledger_type, cfm.month AS cf_month, cfm.year AS cf_year
         FROM cash_flow_entries cfe
         JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
        WHERE cfe.id = ANY($1::int[])`,
      [cfEntryIds]
    );
    cfResult.rows.forEach((r) => { cfMap[r.id] = r; });
  }

  const enriched = transactions.map((t) => {
    if (t.cash_flow_entry_id && cfMap[t.cash_flow_entry_id]) {
      const cf = cfMap[t.cash_flow_entry_id];
      return { ...t, cf_ledger_name: cf.ledger_name, cf_ledger_type: cf.ledger_type, cf_month: cf.cf_month, cf_year: cf.cf_year };
    }
    return t;
  });

  const cfFirmEntries = cfFirmResult.rows.map(row => ({
    ...row,
    payment_mode: normalizeCashType(row.payment_mode),
    id: `cf_${row.id}`,
    is_cashflow_entry: true,
    balance: null,
  }));

  // Merge and sort by date
  const allTransactions = [...enriched, ...cfFirmEntries].sort((a, b) => {
    const da = new Date(a.date);
    const db = new Date(b.date);
    return da - db || 0;
  });

  // summary already includes cashflow entries (getFirmSummary was updated to include them)
  res.json({ transactions: allTransactions, summary, remarkBreakdown, nameBreakdown, firm: firmData });
});

/**
 * GET /firms/transactions/:id
 */
export const getTransaction = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const txn = await firmTransactionModel.findById(parseInt(id), pool);
  if (!txn) return res.status(404).json({ message: 'Transaction not found' });
  res.json({ transaction: txn });
});

/**
 * PUT /firms/transactions/:id
 * Syncs changes to linked cash_flow_entry if present
 */
export const updateTransaction = asyncHandler(async (req, res) => {
  const txnId = parseInt(req.params.id);
  const { date, description, debit, credit, name, purpose, remark, remark2, cheque_no, transaction_no, voucher_url, payment_mode, assigned_admin_id } = req.body;

  const existing = await firmTransactionModel.findById(txnId, pool);
  if (!existing) return res.status(404).json({ message: 'Transaction not found' });
  if (existing.is_firm_to_firm_transfer
      && String(existing.transfer_direction || '').toUpperCase() === 'IN') {
    return res.status(409).json({ message: 'Edit the outbound transfer; its inbound pair is synchronized automatically' });
  }

  const updateData = {};
  if (date !== undefined) updateData.date = date;
  if (description !== undefined) updateData.description = description.trim();
  if (debit !== undefined) updateData.debit = parseFloat(debit) || 0;
  if (credit !== undefined) updateData.credit = parseFloat(credit) || 0;
  if (payment_mode !== undefined) {
    updateData.payment_mode = normalizeCashType(payment_mode);
    updateData.cheque_status = updateData.payment_mode === 'cheque'
      ? (normalizeCashType(existing.payment_mode) === 'cheque' ? (existing.cheque_status || 'PENDING') : 'PENDING')
      : null;
    updateData.cheque_no = updateData.payment_mode === 'cheque'
      ? (cheque_no !== undefined ? (cheque_no ? cheque_no.trim() : null) : existing.cheque_no)
      : null;
  }
  if (name !== undefined) updateData.name = name ? name.trim().toUpperCase() : null;
  if (purpose !== undefined) updateData.purpose = purpose ? purpose.trim().toUpperCase() : null;
  if (remark !== undefined) updateData.remark = remark ? remark.trim().toUpperCase() : null;
  if (remark2 !== undefined) updateData.remark2 = remark2 ? remark2.trim() : null;
  if (payment_mode === undefined && cheque_no !== undefined) {
    updateData.cheque_no = normalizeCashType(existing.payment_mode) === 'cheque' && cheque_no
      ? cheque_no.trim()
      : null;
  }
  if (transaction_no !== undefined) updateData.transaction_no = transaction_no ? transaction_no.trim() : null;
  if (voucher_url !== undefined) updateData.voucher_url = voucher_url || null;
  if (assigned_admin_id !== undefined) updateData.assigned_admin_id = assigned_admin_id ? parseInt(assigned_admin_id) : null;

  // ── If a linked CF entry exists, fetch (cf_entry + cf_month + firm) in
  //    ONE query in parallel with the main UPDATE. Was up to 4 serial RTTs:
  //    UPDATE → cfEntry SELECT → cfMonth SELECT → firm SELECT → cfEntry UPDATE.
  const updatePromise = firmTransactionModel.update(txnId, updateData, pool);

  let cfContextPromise = null;
  if (existing.cash_flow_entry_id) {
    cfContextPromise = pool.query(
      `SELECT cfe.id AS cf_id,
              cfe.cash_flow_month_id,
              cfm.is_locked,
              f.name AS firm_name
         FROM cash_flow_entries cfe
         LEFT JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
         LEFT JOIN firms f ON f.id = $2
        WHERE cfe.id = $1`,
      [existing.cash_flow_entry_id, existing.firm_id]
    );
  }

  const [updated, cfContextRes] = await Promise.all([updatePromise, cfContextPromise || Promise.resolve(null)]);

  if (cfContextRes && cfContextRes.rows[0] && !cfContextRes.rows[0].is_locked) {
    const ctx = cfContextRes.rows[0];
    const cfUpdate = {};
    if (date !== undefined) cfUpdate.date = date;
    if (description !== undefined) cfUpdate.particular = description.trim().toUpperCase();
    // Was `=== 'bank' ? 'bank' : 'cash'`, which turned every cheque into cash —
    // a third coercion rule on top of the two in cashflow.controller.
    if (payment_mode !== undefined) {
      cfUpdate.cash_type = normalizeCashType(payment_mode);
      cfUpdate.cheque_status = updateData.cheque_status;
      cfUpdate.cheque_no = updateData.cheque_no;
    } else if (cheque_no !== undefined) {
      cfUpdate.cheque_no = updateData.cheque_no;
    }
    if (debit !== undefined) cfUpdate.debit = parseFloat(debit) || 0;
    if (credit !== undefined) cfUpdate.credit = parseFloat(credit) || 0;
    cfUpdate.remarks = [ctx.firm_name, remark ?? existing.remark, purpose ?? existing.purpose, name ?? existing.name].filter(Boolean).join(' | ');
    await cashFlowEntryModel.update(existing.cash_flow_entry_id, cfUpdate, pool);
  }

  await syncInboundTransferPair(updated, pool);

  res.json({ transaction: updated });
});

/**
 * DELETE /firms/transactions/:id
 * Also deletes linked cash_flow_entry if present
 */
export const deleteTransaction = asyncHandler(async (req, res) => {
  const txnId = parseInt(req.params.id);

  const primaryRes = await pool.query(
    `SELECT id, transfer_group_id, transfer_direction
       FROM firm_transactions
      WHERE id = $1`,
    [txnId]
  );
  const existing = primaryRes.rows[0];
  if (!existing) return res.status(404).json({ message: 'Transaction not found' });
  if (String(existing.transfer_direction || '').toUpperCase() === 'IN') {
    return res.status(409).json({ message: 'Delete the outbound transfer; its inbound pair is synchronized automatically' });
  }

  const ctxRes = await pool.query(
    `SELECT ft.id, ft.cash_flow_entry_id, cfm.is_locked AS cf_is_locked
       FROM firm_transactions ft
       LEFT JOIN cash_flow_entries cfe ON cfe.id = ft.cash_flow_entry_id
       LEFT JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
      WHERE ft.id = $1
         OR ($2::varchar IS NOT NULL AND ft.transfer_group_id = $2)`,
    [txnId, existing.transfer_group_id || null]
  );
  if (ctxRes.rows.some((row) => row.cash_flow_entry_id && row.cf_is_locked)) {
    return res.status(403).json({ message: 'Cannot delete — linked cash flow month is locked' });
  }

  const transactionIds = ctxRes.rows.map((row) => row.id);
  const linkedCashFlowIds = ctxRes.rows.map((row) => row.cash_flow_entry_id).filter(Boolean);
  await pool.query(
    `WITH del_cf AS (
       DELETE FROM cash_flow_entries WHERE id = ANY($2::int[])
     )
     DELETE FROM firm_transactions WHERE id = ANY($1::int[])`,
    [transactionIds, linkedCashFlowIds]
  );

  res.json({ message: existing.transfer_group_id ? 'Transfer and its paired entry deleted' : 'Transaction deleted' });
});

/**
 * POST /firms/transactions/bulk-delete
 * Body: { ids: number[] }. Same lock rule as deleteTransaction — rows whose
 * linked cash-flow month is locked are skipped, not fatal to the batch.
 */
export const bulkDeleteTransactions = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((id) => parseInt(id)).filter(Number.isInteger) : [];
  if (ids.length === 0) return res.status(400).json({ message: 'ids array is required' });

  const ctxRes = await pool.query(
    `WITH requested_groups AS (
       SELECT DISTINCT transfer_group_id
       FROM firm_transactions
       WHERE id = ANY($1::int[]) AND transfer_group_id IS NOT NULL
     )
     SELECT ft.id, ft.transfer_group_id, ft.cash_flow_entry_id,
            cfm.is_locked AS cf_is_locked
       FROM firm_transactions ft
       LEFT JOIN cash_flow_entries cfe ON cfe.id = ft.cash_flow_entry_id
       LEFT JOIN cash_flow_months cfm  ON cfm.id = cfe.cash_flow_month_id
      WHERE ft.id = ANY($1::int[])
         OR ft.transfer_group_id IN (SELECT transfer_group_id FROM requested_groups)`,
    [ids]
  );
  const lockedGroups = new Set(
    ctxRes.rows
      .filter((row) => row.transfer_group_id && row.cash_flow_entry_id && row.cf_is_locked)
      .map((row) => row.transfer_group_id)
  );
  const deletable = ctxRes.rows.filter((row) => (
    !(row.cash_flow_entry_id && row.cf_is_locked)
    && (!row.transfer_group_id || !lockedGroups.has(row.transfer_group_id))
  ));
  const deletableIds = deletable.map((r) => r.id);
  const skipped = ids.filter((id) => !deletableIds.includes(id));

  if (deletableIds.length > 0) {
    const cfEntryIds = deletable.map((r) => r.cash_flow_entry_id).filter(Boolean);
    await pool.query(
      `WITH del_cf AS (
         DELETE FROM cash_flow_entries WHERE id = ANY($2::int[])
       )
       DELETE FROM firm_transactions WHERE id = ANY($1::int[])`,
      [deletableIds, cfEntryIds]
    );
  }

  res.json({
    message: `${deletableIds.length} transaction(s) deleted${skipped.length ? `, ${skipped.length} skipped (locked month or not found)` : ''}`,
    deleted: deletableIds,
    skipped,
  });
});

/**
 * GET /firms/autocomplete?site_id=X
 * Get unique names, purposes, remarks for autocomplete
 */
export const getAutocomplete = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const autocomplete = await firmTransactionModel.getAutocomplete(parseInt(site_id), pool);
  res.json(autocomplete);
});

// ══════════════════════════════════════════════════
//  CASH FLOW INTEGRATION ENDPOINTS
// ══════════════════════════════════════════════════

/**
 * GET /firms/cashflow-ledgers?site_id=X
 * List ALL cash_flow_months records for the Cash Flow dropdown in Firm Transactions
 */
export const listCashFlowLedgersForFirm = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const months = await cashFlowMonthModel.findBySiteId(parseInt(site_id), pool);
  res.json({ ledgers: months });
});

/**
 * GET /firms/history/analytics?site_id=X
 * Site-wide firm transaction history + analytics (including firm-to-firm view)
 */
export const getFirmHistoryAnalytics = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const siteId = parseInt(site_id);

  const [transactionsResult, summaryResult, byFirmResult, firmToFirmResult] = await Promise.all([
    pool.query(
      `
      SELECT
        ft.*,
        f.name AS firm_name,
        f2.name AS matched_counterparty_firm_name
      FROM firm_transactions ft
      JOIN firms f ON f.id = ft.firm_id
      LEFT JOIN firms f2 ON f2.site_id = ft.site_id AND UPPER(f2.name) = UPPER(COALESCE(ft.name, ''))
      WHERE ft.site_id = $1
      ORDER BY ft.date DESC, ft.created_at DESC
      `,
      [siteId]
    ),
    pool.query(
      `
      SELECT
        COUNT(*)::int AS total_entries,
        COALESCE(SUM(debit), 0) AS total_debit,
        COALESCE(SUM(credit), 0) AS total_credit
      FROM firm_transactions
      WHERE site_id = $1
        AND LOWER(COALESCE(status, '')) = 'approved'
        AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
      `,
      [siteId]
    ),
    pool.query(
      `
      SELECT
        f.id AS firm_id,
        f.name AS firm_name,
        COUNT(ft.id)::int AS entries,
        COALESCE(SUM(ft.debit), 0) AS total_debit,
        COALESCE(SUM(ft.credit), 0) AS total_credit
      FROM firms f
      LEFT JOIN firm_transactions ft ON ft.firm_id = f.id
        AND LOWER(COALESCE(ft.status, '')) = 'approved'
        AND UPPER(COALESCE(ft.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
      WHERE f.site_id = $1
      GROUP BY f.id, f.name
      ORDER BY f.name ASC
      `,
      [siteId]
    ),
    pool.query(
      `
      SELECT
        f.name AS from_firm,
        f2.name AS to_firm,
        COUNT(ft.id)::int AS entries,
        COALESCE(SUM(ft.debit), 0) AS total_debit,
        COALESCE(SUM(ft.credit), 0) AS total_credit
      FROM firm_transactions ft
      JOIN firms f ON f.id = ft.firm_id
      JOIN firms f2 ON f2.site_id = ft.site_id AND UPPER(f2.name) = UPPER(COALESCE(ft.name, ''))
      WHERE ft.site_id = $1
        AND LOWER(COALESCE(ft.status, '')) = 'approved'
        AND UPPER(COALESCE(ft.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
      GROUP BY f.name, f2.name
      ORDER BY entries DESC, f.name ASC
      `,
      [siteId]
    ),
  ]);

  res.json({
    summary: summaryResult.rows[0] || { total_entries: 0, total_debit: 0, total_credit: 0 },
    byFirm: byFirmResult.rows,
    firmToFirm: firmToFirmResult.rows,
    transactions: transactionsResult.rows,
  });
});
