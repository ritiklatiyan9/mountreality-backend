import asyncHandler from '../utils/asyncHandler.js';
import { cashFlowMonthModel, cashFlowEntryModel } from '../models/CashFlow.model.js';
import { firmModel } from '../models/Firm.model.js';
import pool from '../config/db.js';
import { clearCacheByPrefixes } from '../config/cache.js';
import { buildVerifyUrl, ReceiptType } from '../utils/receiptToken.js';
import { classifyPaymentMode, normalizeCashType } from '../utils/paymentMode.js';
import { resolveBankAccountSelection } from '../services/bankAccount.service.js';

// ══════════════════════════════════════════════════
//  CASH FLOW MONTH ENDPOINTS
// ══════════════════════════════════════════════════

/**
 * POST /cashflow/months
 * Create a new cash-flow month for a site
 */
export const createMonth = asyncHandler(async (req, res) => {
  const { site_id, month, year, opening_balance, notes, ledger_name, ledger_type } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  if (!month || !year) return res.status(400).json({ message: 'Month and year are required' });
  if (month < 1 || month > 12) return res.status(400).json({ message: 'Month must be 1-12' });

  const siteIdInt = parseInt(site_id);
  const type = ledger_type || 'site';
  const name = type === 'person'
    ? (ledger_name ? ledger_name.trim().toUpperCase() : '')
    : (ledger_name ? ledger_name.trim().toUpperCase() : 'SITE');

  if (type === 'person' && !name) return res.status(400).json({ message: 'Ledger display name is required' });

  const mInt = parseInt(month);
  const yInt = parseInt(year);
  const prevMonth = mInt === 1 ? 12 : mInt - 1;
  const prevYear  = mInt === 1 ? yInt - 1 : yInt;
  const explicitOpening = (opening_balance === 0 || opening_balance === '0' || opening_balance) ? parseFloat(opening_balance) || 0 : null;

  // ── Single CTE round-trip ──
  // 1) `dup` flags whether this period already exists.
  // 2) `prev_close` computes the previous month's closing if the caller
  //    didn't pass an explicit opening_balance.
  // 3) `ins` inserts the new month, picking the explicit opening if given,
  //    otherwise the previous closing, otherwise 0.
  // Previously: 1 dup-check + 1 prev-month lookup + 1 closing aggregation
  //           + 1 INSERT = 4 round-trips.
  const result = await pool.query(
    `WITH dup AS (
       SELECT 1 FROM cash_flow_months
        WHERE site_id = $1 AND month = $2 AND year = $3
          AND ledger_name = $4
        LIMIT 1
     ),
     prev_close AS (
       SELECT cfm.id,
              cfm.opening_balance
                + COALESCE(SUM(cfe.credit), 0)
                - COALESCE(SUM(cfe.debit),  0) AS closing_balance
         FROM cash_flow_months cfm
         LEFT JOIN cash_flow_entries cfe ON cfe.cash_flow_month_id = cfm.id
          AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'
        WHERE cfm.site_id = $1 AND cfm.month = $9 AND cfm.year = $10 AND cfm.ledger_name = $4
        GROUP BY cfm.id, cfm.opening_balance
     ),
     ins AS (
       INSERT INTO cash_flow_months (
         site_id, month, year, opening_balance, ledger_name, ledger_type, notes, created_by
       )
       SELECT $1, $2, $3,
              COALESCE($5::numeric, (SELECT closing_balance FROM prev_close), 0),
              $4, $6, $7, $8
       WHERE NOT EXISTS (SELECT 1 FROM dup)
       RETURNING *
     )
     SELECT
       (SELECT row_to_json(ins) FROM ins) AS month,
       EXISTS (SELECT 1 FROM dup) AS is_dup`,
    [
      siteIdInt,                       // $1
      mInt,                            // $2
      yInt,                            // $3
      name,                            // $4
      explicitOpening,                 // $5 (may be NULL)
      type,                            // $6
      notes ? notes.trim() : null,     // $7
      req.user.id,                     // $8
      prevMonth,                       // $9
      prevYear,                        // $10
    ]
  );

  const row = result.rows[0];
  if (row.is_dup) {
    return res.status(409).json({ message: `Cash flow for "${name}" in this month already exists` });
  }
  res.status(201).json({ month: row.month });
});

/**
 * GET /cashflow/months?site_id=X
 * List all months for a site
 */
export const listMonths = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const [months, ledgerNames] = await Promise.all([
    cashFlowMonthModel.findBySiteId(parseInt(site_id), pool),
    cashFlowMonthModel.getUniqueLedgerNames(parseInt(site_id), pool),
  ]);
  res.json({ months, ledgerNames });
});

/**
 * GET /cashflow/months/:id
 * Get one month with totals
 */
export const getMonth = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const month = await cashFlowMonthModel.findByIdWithTotals(parseInt(id), pool);
  if (!month) return res.status(404).json({ message: 'Cash flow month not found' });
  res.json({ month });
});

/**
 * PUT /cashflow/months/:id
 * Update month (opening balance, notes, lock)
 */
export const updateMonth = asyncHandler(async (req, res) => {
  const monthId = parseInt(req.params.id);
  const { opening_balance, notes, is_locked, ledger_name } = req.body;

  const updateData = {};
  if (opening_balance !== undefined) updateData.opening_balance = parseFloat(opening_balance) || 0;
  if (notes !== undefined) updateData.notes = notes ? notes.trim() : null;
  if (is_locked !== undefined) updateData.is_locked = Boolean(is_locked);
  // Rename a person ledger. Never blank the name — ignore empty values.
  if (ledger_name !== undefined && ledger_name.trim()) updateData.ledger_name = ledger_name.trim().toUpperCase();
  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ message: 'Nothing to update' });
  }

  // Atomic UPDATE — saves a SELECT round-trip.
  const updated = await cashFlowMonthModel.update(monthId, updateData, pool);
  if (!updated) return res.status(404).json({ message: 'Cash flow month not found' });
  const enriched = await cashFlowMonthModel.findByIdWithTotals(monthId, pool);
  res.json({ month: enriched || updated });
});

/**
 * DELETE /cashflow/months/:id
 * Delete a month and all its entries (CASCADE)
 */
export const deleteMonth = asyncHandler(async (req, res) => {
  // Atomic DELETE — saves a SELECT round-trip.
  const result = await pool.query(
    `DELETE FROM cash_flow_months WHERE id = $1 RETURNING id`,
    [parseInt(req.params.id)]
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Cash flow month not found' });
  res.json({ message: 'Cash flow month deleted' });
});

// ══════════════════════════════════════════════════
//  CASH FLOW ENTRY ENDPOINTS
// ══════════════════════════════════════════════════

/**
 * POST /cashflow/entries
 * Add a new entry to a month
 */
export const createEntry = asyncHandler(async (req, res) => {
  const {
    cash_flow_month_id,
    date,
    particular,
    debit,
    credit,
    remarks,
    cash_type,
    voucher_url,
    is_firm_transaction,
    from_firm_id,
    to_firm_id,
    to_name,
    assigned_admin_id,
    bank_account_id,
  } = req.body;

  if (!cash_flow_month_id) return res.status(400).json({ message: 'Cash flow month is required' });
  if (!particular) return res.status(400).json({ message: 'Particular is required' });

  const monthIdInt = parseInt(cash_flow_month_id);
  const isFirmTxn = Boolean(is_firm_transaction);

  // Up-front input validation that doesn't need the DB.
  if (isFirmTxn) {
    if (!from_firm_id) return res.status(400).json({ message: 'From firm is required for firm-linked entries' });
    if (to_firm_id && to_name) {
      return res.status(400).json({ message: 'Choose either To Firm or To Name, not both' });
    }
    if (!to_firm_id && !(to_name && String(to_name).trim())) {
      return res.status(400).json({ message: 'To Firm or To Name is required for firm-linked entries' });
    }
  }

  // ── Single round-trip lookup: month + (optional) firms in one query ──
  // Previously this was 1 month lookup + 1-2 firm lookups SERIALLY.
  const lookupPromises = [
    pool.query(
      `SELECT id, site_id, is_locked FROM cash_flow_months WHERE id = $1`,
      [monthIdInt]
    ),
  ];
  if (isFirmTxn) {
    const firmIds = [parseInt(from_firm_id)];
    if (to_firm_id) firmIds.push(parseInt(to_firm_id));
    lookupPromises.push(pool.query(
      `SELECT id, site_id FROM firms WHERE id = ANY($1::int[])`,
      [firmIds]
    ));
  }
  const [monthRes, firmsRes] = await Promise.all(lookupPromises);
  const cfMonth = monthRes.rows[0];
  if (!cfMonth) return res.status(404).json({ message: 'Cash flow month not found' });
  if (cfMonth.is_locked) return res.status(403).json({ message: 'This month is locked. Unlock it to add entries.' });

  let fromFirmId = null;
  let toFirmId = null;
  let toName = null;

  if (isFirmTxn) {
    const firmsBySite = new Map((firmsRes?.rows || []).map((f) => [f.id, f.site_id]));
    const fromFirmInt = parseInt(from_firm_id);
    if (firmsBySite.get(fromFirmInt) !== cfMonth.site_id) {
      return res.status(400).json({ message: 'Invalid from firm for this site' });
    }
    fromFirmId = fromFirmInt;

    if (to_firm_id) {
      const toFirmInt = parseInt(to_firm_id);
      if (firmsBySite.get(toFirmInt) !== cfMonth.site_id) {
        return res.status(400).json({ message: 'Invalid to firm for this site' });
      }
      toFirmId = toFirmInt;
    } else {
      toName = String(to_name).trim().toUpperCase();
    }
  }

  const normalizedCashType = normalizeCashType(cash_type);
  const selectedBankAccountId = await resolveBankAccountSelection({
    siteId: cfMonth.site_id,
    paymentMode: normalizedCashType,
    bankAccountId: bank_account_id,
  });
  const data = {
    cash_flow_month_id: monthIdInt,
    site_id: cfMonth.site_id,
    date: date || new Date().toISOString().split('T')[0],
    particular: particular.trim().toUpperCase(),
    debit: parseFloat(debit) || 0,
    credit: parseFloat(credit) || 0,
    cash_type: normalizedCashType,
    remarks: remarks ? remarks.trim() : null,
    created_by: req.user.id,
    voucher_url: voucher_url || null,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    status: 'pending',
    cheque_status: normalizedCashType === 'cheque' ? 'PENDING' : null,
    cheque_no: normalizedCashType === 'cheque' && req.body.cheque_no
      ? String(req.body.cheque_no).trim()
      : null,
    is_firm_transaction: isFirmTxn,
    from_firm_id: fromFirmId,
    to_firm_id: toFirmId,
    to_name: toName,
    bank_account_id: selectedBankAccountId,
  };

  const entry = await cashFlowEntryModel.create(data, pool);
  clearCacheByPrefixes(['dashboard:']).catch(() => {});
  res.status(201).json({ entry });
});

/**
 * GET /cashflow/entries?month_id=X
 * List all entries for a month + summary
 */
export const listEntries = asyncHandler(async (req, res) => {
  const { month_id } = req.query;
  if (!month_id) return res.status(400).json({ message: 'month_id is required' });

  const monthId = parseInt(month_id);
  // Step 1: 4 reads in parallel (was already parallel — keep).
  const [entries, summary, categories, monthData] = await Promise.all([
    cashFlowEntryModel.findByMonthId(monthId, pool),
    cashFlowEntryModel.getMonthSummary(monthId, pool),
    cashFlowEntryModel.getCategoryBreakdown(monthId, pool),
    cashFlowMonthModel.findByIdWithTotals(monthId, pool),
  ]);

  // Step 2: site row needs the site_id from monthData. Previously serial
  // AFTER the 4 reads. Skip the DB call entirely if we have no site_id.
  // (Could be folded into Step 1 with a JOIN, but findByIdWithTotals returns
  // a single row already; this is just one extra round-trip.)
  const siteRow = monthData?.site_id
    ? (await pool.query('SELECT name, city, state FROM sites WHERE id = $1', [monthData.site_id])).rows[0] || null
    : null;

  const entriesWithVerify = entries.map((e) => {
    const debit = parseFloat(e.debit) || 0;
    const credit = parseFloat(e.credit) || 0;
    const amount = credit > 0 ? credit : debit;
    return {
      ...e,
      verifyUrl: buildVerifyUrl({
        t: ReceiptType.DAYBOOK,
        i: `cf_${e.id}`,
        a: amount,
        dr: credit > 0 ? 'IN' : 'OUT',
        d: e.date,
        pm: e.cash_type || null,
        pn: e.to_firm_name || e.from_firm_name || e.to_name || e.particular || null,
        pl: 'Cash Flow',
        sn: siteRow?.name || null,
        sy: siteRow?.city || null,
        ss: siteRow?.state || null,
      }),
    };
  });

  res.json({ entries: entriesWithVerify, summary, categories, month: monthData });
});

/**
 * GET /cashflow/autocomplete?site_id=X
 * Get unique particulars for autocomplete
 */
export const getAutocomplete = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const particulars = await cashFlowEntryModel.getUniqueParticulars(parseInt(site_id), pool);
  res.json({ particulars });
});

/**
 * GET /cashflow/entries/:id
 */
export const getEntry = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const entry = await cashFlowEntryModel.findById(parseInt(id), pool);
  if (!entry) return res.status(404).json({ message: 'Entry not found' });
  res.json({ entry });
});

/**
 * PUT /cashflow/entries/:id
 */
export const updateEntry = asyncHandler(async (req, res) => {
  const entryId = parseInt(req.params.id);
  const {
    date,
    particular,
    debit,
    credit,
    remarks,
    cash_type,
    voucher_url,
    is_firm_transaction,
    from_firm_id,
    to_firm_id,
    to_name,
    assigned_admin_id,
    cheque_no,
    bank_account_id,
  } = req.body;

  // ── Single round-trip lookup: existing entry + its month's lock state in
  //    one query (was 2 serial queries: findById + cfMonth lookup). ──
  const lookupRes = await pool.query(
    `SELECT cfe.id, cfe.cash_flow_month_id, cfe.site_id, cfe.is_firm_transaction,
            cfe.from_firm_id, cfe.to_firm_id, cfe.to_name,
            cfe.cash_type, cfe.cheque_status, cfe.cheque_no,cfe.bank_account_id,
            cfm.is_locked
       FROM cash_flow_entries cfe
       JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
      WHERE cfe.id = $1`,
    [entryId]
  );
  const existing = lookupRes.rows[0];
  if (!existing) return res.status(404).json({ message: 'Entry not found' });
  if (existing.is_locked) return res.status(403).json({ message: 'This month is locked.' });

  const updateData = {};
  if (date !== undefined) updateData.date = date;
  if (particular !== undefined) updateData.particular = particular.trim().toUpperCase();
  if (debit !== undefined) updateData.debit = parseFloat(debit) || 0;
  if (credit !== undefined) updateData.credit = parseFloat(credit) || 0;
  if (cash_type !== undefined) {
    const nextCashType = normalizeCashType(cash_type);
    const wasCheque = classifyPaymentMode(existing.cash_type) === 'cheque';
    updateData.cash_type = nextCashType;
    updateData.cheque_status = nextCashType === 'cheque'
      ? (wasCheque ? (existing.cheque_status || 'PENDING') : 'PENDING')
      : null;
    updateData.cheque_no = nextCashType === 'cheque'
      ? (cheque_no !== undefined
          ? (cheque_no ? String(cheque_no).trim() : null)
          : (wasCheque ? existing.cheque_no || null : null))
      : null;
  } else if (cheque_no !== undefined) {
    const existingIsCheque = classifyPaymentMode(existing.cash_type) === 'cheque';
    updateData.cheque_no = existingIsCheque && cheque_no ? String(cheque_no).trim() : null;
    if (existingIsCheque) updateData.cheque_status = existing.cheque_status || 'PENDING';
  }
  if (cash_type !== undefined || bank_account_id !== undefined) {
    updateData.bank_account_id = await resolveBankAccountSelection({
      siteId: existing.site_id,
      paymentMode: cash_type !== undefined ? normalizeCashType(cash_type) : existing.cash_type,
      bankAccountId: bank_account_id !== undefined ? bank_account_id : existing.bank_account_id,
    });
  }
  if (remarks !== undefined) updateData.remarks = remarks ? remarks.trim() : null;
  if (voucher_url !== undefined) updateData.voucher_url = voucher_url || null;
  if (assigned_admin_id !== undefined) updateData.assigned_admin_id = assigned_admin_id ? parseInt(assigned_admin_id) : null;

  const shouldBeFirmTxn = (is_firm_transaction !== undefined)
    ? Boolean(is_firm_transaction)
    : Boolean(existing.is_firm_transaction);

  if (is_firm_transaction !== undefined) {
    updateData.is_firm_transaction = shouldBeFirmTxn;
  }

  if (shouldBeFirmTxn) {
    const resolvedFromFirmId = from_firm_id !== undefined ? from_firm_id : existing.from_firm_id;
    const resolvedToFirmId = to_firm_id !== undefined ? to_firm_id : existing.to_firm_id;
    const resolvedToName = to_name !== undefined ? to_name : existing.to_name;

    if (!resolvedFromFirmId) {
      return res.status(400).json({ message: 'From firm is required for firm-linked entries' });
    }
    if (resolvedToFirmId && resolvedToName && String(resolvedToName).trim()) {
      return res.status(400).json({ message: 'Choose either To Firm or To Name, not both' });
    }
    if (!resolvedToFirmId && !(resolvedToName && String(resolvedToName).trim())) {
      return res.status(400).json({ message: 'To Firm or To Name is required for firm-linked entries' });
    }

    // Validate referenced firms in one query (was up to 2 serial queries).
    const firmIds = [parseInt(resolvedFromFirmId)];
    if (resolvedToFirmId) firmIds.push(parseInt(resolvedToFirmId));
    const firmsRes = await pool.query(
      `SELECT id, site_id FROM firms WHERE id = ANY($1::int[])`,
      [firmIds]
    );
    const firmsBySite = new Map(firmsRes.rows.map((f) => [f.id, f.site_id]));
    const fromFirmInt = parseInt(resolvedFromFirmId);
    if (firmsBySite.get(fromFirmInt) !== existing.site_id) {
      return res.status(400).json({ message: 'Invalid from firm for this site' });
    }
    updateData.from_firm_id = fromFirmInt;

    if (resolvedToFirmId) {
      const toFirmInt = parseInt(resolvedToFirmId);
      if (firmsBySite.get(toFirmInt) !== existing.site_id) {
        return res.status(400).json({ message: 'Invalid to firm for this site' });
      }
      updateData.to_firm_id = toFirmInt;
      updateData.to_name = null;
    } else {
      updateData.to_firm_id = null;
      updateData.to_name = String(resolvedToName).trim().toUpperCase();
    }
  } else if (is_firm_transaction !== undefined && !shouldBeFirmTxn) {
    updateData.from_firm_id = null;
    updateData.to_firm_id = null;
    updateData.to_name = null;
  }

  const updated = await cashFlowEntryModel.update(entryId, updateData, pool);
  clearCacheByPrefixes(['dashboard:']).catch(() => {});
  res.json({ entry: updated });
});

/**
 * GET /cashflow/firms?site_id=X
 * List firms for cashflow modal firm tracking controls
 */
export const listFirmsForCashFlow = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const firms = await firmModel.findBySiteId(parseInt(site_id), pool);
  res.json({ firms: firms.map((f) => ({ id: f.id, name: f.name })) });
});

/**
 * DELETE /cashflow/entries/:id
 */
export const deleteEntry = asyncHandler(async (req, res) => {
  const entryId = parseInt(req.params.id);
  // Single atomic DELETE — only deletes if the parent month is NOT locked.
  // Was 3 round-trips (entry SELECT, month SELECT, DELETE); now 1.
  const result = await pool.query(
    `DELETE FROM cash_flow_entries cfe
       USING cash_flow_months cfm
      WHERE cfe.id = $1
        AND cfe.cash_flow_month_id = cfm.id
        AND cfm.is_locked = FALSE
      RETURNING cfe.id`,
    [entryId]
  );
  if (!result.rows[0]) {
    // Distinguish "not found" from "month locked" with a single follow-up.
    const check = await pool.query(
      `SELECT cfm.is_locked
         FROM cash_flow_entries cfe
         JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
        WHERE cfe.id = $1`,
      [entryId]
    );
    if (check.rows.length === 0) return res.status(404).json({ message: 'Entry not found' });
    return res.status(403).json({ message: 'This month is locked.' });
  }
  clearCacheByPrefixes(['dashboard:']).catch(() => {});
  res.json({ message: 'Entry deleted' });
});

/**
 * POST /cashflow/entries/bulk-delete
 * Body: { ids: number[] }. Same lock rule as deleteEntry — rows in a locked
 * month are silently skipped rather than failing the whole batch.
 */
export const bulkDeleteEntries = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((id) => parseInt(id)).filter(Number.isInteger) : [];
  if (ids.length === 0) return res.status(400).json({ message: 'ids array is required' });

  const result = await pool.query(
    `DELETE FROM cash_flow_entries cfe
       USING cash_flow_months cfm
      WHERE cfe.id = ANY($1::int[])
        AND cfe.cash_flow_month_id = cfm.id
        AND cfm.is_locked = FALSE
      RETURNING cfe.id`,
    [ids]
  );
  const deleted = result.rows.map((r) => r.id);
  const skipped = ids.filter((id) => !deleted.includes(id));
  clearCacheByPrefixes(['dashboard:']).catch(() => {});
  res.json({
    message: `${deleted.length} entr${deleted.length === 1 ? 'y' : 'ies'} deleted${skipped.length ? `, ${skipped.length} skipped (locked month or not found)` : ''}`,
    deleted,
    skipped,
  });
});
