import asyncHandler from '../utils/asyncHandler.js';
import { dayBookModel } from '../models/DayBook.model.js';
import { expenseModel } from '../models/Expense.model.js';
import { farmerModel, farmerPaymentModel } from '../models/Farmer.model.js';
import { plotCommissionModel } from '../models/PlotCommission.model.js';
import { memberModel } from '../models/Member.model.js';
import { cashFlowMonthModel, cashFlowEntryModel } from '../models/CashFlow.model.js';
import { firmModel, firmTransactionModel } from '../models/Firm.model.js';
import { plotModel, plotPaymentModel } from '../models/Plot.model.js';
import pool from '../config/db.js';
import { buildVerifyUrl, ReceiptType } from '../utils/receiptToken.js';
import { classifyPaymentMode, normalizeCashType, emptyBucketMap, BUCKETS } from '../utils/paymentMode.js';
import { getRevenue, getExpenseBreakdown, getProfit } from '../graphql/services/kpi.service.js';

// All-time bounds for endpoints that report a running total rather than a
// date-windowed one (matches the wide bounds already used by getSiteCashflow).
const ALL_TIME_START = '1900-01-01';
const ALL_TIME_END = '2100-12-31';

// plot_payments keeps a three-value settlement type.  payment_from is a
// business/narration field (BOOKING, REFUND, etc.) and must never decide which
// accounting book receives the money.
const normalizePlotPaymentType = (raw) => {
  const bucket = normalizeCashType(raw);
  return bucket === 'cash' ? 'CASH' : bucket === 'cheque' ? 'CHEQUE' : 'BANK';
};

const resolveChequeStatus = ({ currentMode, currentStatus, nextMode }) => {
  if (classifyPaymentMode(nextMode) !== 'cheque') return null;
  return classifyPaymentMode(currentMode) === 'cheque'
    ? (currentStatus || 'PENDING')
    : 'PENDING';
};

const dateInIndia = () => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${value.year}-${value.month}-${value.day}`;
};

const addIsoDays = (isoDate, days) => {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

// ══════════════════════════════════════════════════
//  CANONICAL OPENING BALANCE
//  Reads the same posted ledger used by Dashboard and Balance Sheet. Historical
//  values are calculated live, so editing an old transaction cannot leave a
//  stale daily snapshot behind.
// ══════════════════════════════════════════════════

async function siteBalanceAsOf(siteId, cutoffDate, pool) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(COALESCE(cfe.credit, 0) - COALESCE(cfe.debit, 0)), 0)::numeric AS balance
     FROM cash_flow_entries cfe
     LEFT JOIN day_book db
       ON cfe.source_module = 'day_book' AND db.id = cfe.source_id
     WHERE cfe.site_id = $1
       AND cfe.date::date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
       AND cfe.date::date < $2::date
       AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'
       AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
       AND COALESCE(cfe.source_module, '') NOT IN (
         'imprest', 'imprest_requests', 'document_imprest', 'document_imprest_requests',
         'plot_registry_payments'
       )
       AND COALESCE(cfe.source_module, '') NOT LIKE '%\\_person'
       AND NOT (
         cfe.source_module = 'day_book'
         AND UPPER(COALESCE(db.entry_type, '')) = 'IMPREST'
       )`,
    [siteId, cutoffDate]
  );
  return parseFloat(rows[0]?.balance) || 0;
}

async function getCanonicalDailyBalance(siteId, date, pool) {
  const [openingBalance, closingBalance] = await Promise.all([
    siteBalanceAsOf(siteId, date, pool),
    siteBalanceAsOf(siteId, addIsoDays(date, 1), pool),
  ]);
  return {
    opening_balance: openingBalance,
    closing_balance: closingBalance,
  };
}

// ══════════════════════════════════════════════════
//  DAY BOOK ENDPOINTS
// ══════════════════════════════════════════════════

/**
 * POST /daybook
 * Create a new day book entry.
 * EXPENSE entries are pulled into the Expenses page automatically
 * via the expense controller (no duplicate creation needed).
 * FARMER PAYMENT entries also create a record in farmer_payments table.
 */
export const createDayBookEntry = asyncHandler(async (req, res) => {
  const {
    site_id, date, particular, entry_type, debit, credit, remarks,
    payment_mode, category, from_entity, to_entity, account_no, branch,
    // Farmer payment fields
    farmer_id, interest_rate, interest_amount, by_note,
    assigned_admin_id, voucher_url,
    mapped_member_id, mapped_user_id,
  } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  if (!particular) return res.status(400).json({ message: 'Particular is required' });
  if (mapped_member_id && mapped_user_id) {
    return res.status(400).json({ message: 'Map this entry to either a client or a user, not both' });
  }

  const normalizedType = entry_type ? entry_type.trim().toUpperCase() : 'GENERAL';

  // ── FARMER PAYMENT: dual-write to day_book + farmer_payments ──
  if (normalizedType === 'FARMER PAYMENT') {
    if (!farmer_id) return res.status(400).json({ message: 'Farmer is required for farmer payment' });

    // Validate farmer exists and belongs to this site
    const farmer = await farmerModel.findById(parseInt(farmer_id), pool);
    if (!farmer) return res.status(404).json({ message: 'Farmer not found' });
    if (farmer.site_id !== parseInt(site_id)) {
      return res.status(400).json({ message: 'Farmer does not belong to this site' });
    }

    const paymentDate = date || dateInIndia();
    const paymentAmount = parseFloat(debit) || 0;
    const farmerPaymentMode = payment_mode ? payment_mode.trim().toUpperCase() : 'BANK';
    const farmerBucket = classifyPaymentMode(farmerPaymentMode);
    const farmerChequeNo = farmerBucket === 'cheque' && req.body.cheque_no
      ? String(req.body.cheque_no).trim()
      : null;

    // Create the farmer payment record
    const fpData = {
      farmer_id: parseInt(farmer_id),
      date: paymentDate,
      particular: farmerPaymentMode,
      payment_mode: farmerPaymentMode,
      amount: paymentAmount,
      cash_amount: farmerBucket === 'cash' ? paymentAmount : 0,
      bank_amount: farmerBucket === 'cash' ? 0 : paymentAmount,
      by_note: by_note ? by_note.trim() : null,
      interest_rate: parseFloat(interest_rate) || 0,
      interest_amount: parseFloat(interest_amount) || 0,
      remarks: remarks ? remarks.trim() : null,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
      cheque_no: farmerChequeNo,
      cheque_status: farmerBucket === 'cheque' ? 'PENDING' : null,
    };

    const farmerPayment = await farmerPaymentModel.create(fpData, pool);

    // Also create the day book entry (linked via farmer_payment_id)
    const dbData = {
      site_id: parseInt(site_id),
      date: paymentDate,
      particular: particular.trim().toUpperCase(),
      entry_type: 'FARMER PAYMENT',
      debit: paymentAmount,
      credit: parseFloat(credit) || 0,
      remarks: remarks ? remarks.trim() : null,
      payment_mode: farmerPaymentMode,
      category: category ? category.trim().toUpperCase() : null,
      from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
      to_entity: to_entity ? to_entity.trim().toUpperCase() : null,
      account_no: account_no ? account_no.trim().toUpperCase() : null,
      branch: branch ? branch.trim().toUpperCase() : null,
      cheque_no: farmerChequeNo,
      cheque_status: farmerBucket === 'cheque' ? 'PENDING' : null,
      created_by: req.user.id,
      voucher_url: voucher_url || null,
      farmer_payment_id: farmerPayment.id,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    };

    const dayBookEntry = await dayBookModel.create(dbData, pool);
    return res.status(201).json({
      entry: dayBookEntry,
      farmer_payment: farmerPayment,
      message: 'Farmer payment recorded in Day Book and Farmer Payments',
    });
  }

  // ── Standard day book entry ──
  // ── PLOT COMMISSION: dual-write to day_book + plot_commissions ──
  if (normalizedType === 'PLOT COMMISSION') {
    if (!particular) return res.status(400).json({ message: 'Particular (person name) is required' });

    const cDate = date || dateInIndia();
    const cAmount = parseFloat(debit) || 0;
    const commissionPaymentMode = payment_mode ? payment_mode.trim().toUpperCase() : 'BANK';
    const commissionBucket = classifyPaymentMode(commissionPaymentMode);
    const commissionChequeNo = commissionBucket === 'cheque' && req.body.cheque_no
      ? String(req.body.cheque_no).trim()
      : null;

    // Create the plot commission record
    const pcData = {
      site_id: parseInt(site_id),
      date: cDate,
      particular: particular.trim().toUpperCase(),
      father_name: req.body.father_name ? req.body.father_name.trim().toUpperCase() : null,
      plot_no: req.body.plot_no ? req.body.plot_no.trim().toUpperCase() : null,
      plot_size: req.body.plot_size ? req.body.plot_size.trim().toUpperCase() : null,
      plot_rate: req.body.plot_rate ? req.body.plot_rate.trim().toUpperCase() : null,
      amount: cAmount,
      by_note: by_note ? by_note.trim() : null,
      payment_mode: commissionPaymentMode,
      cheque_no: commissionChequeNo,
      cheque_status: commissionBucket === 'cheque' ? 'PENDING' : null,
      remarks: remarks ? remarks.trim() : null,
      created_by: req.user.id,
      voucher_url: voucher_url || null,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    };

    const commission = await plotCommissionModel.create(pcData, pool);

    // Also create the day book entry (linked via commission_id)
    const dbData = {
      site_id: parseInt(site_id),
      date: cDate,
      particular: particular.trim().toUpperCase(),
      entry_type: 'PLOT COMMISSION',
      debit: cAmount,
      credit: parseFloat(credit) || 0,
      remarks: remarks ? remarks.trim() : null,
      payment_mode: commissionPaymentMode,
      category: category ? category.trim().toUpperCase() : 'COMMISSION',
      from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
      to_entity: to_entity ? to_entity.trim().toUpperCase() : particular.trim().toUpperCase(),
      account_no: account_no ? account_no.trim().toUpperCase() : null,
      branch: branch ? branch.trim().toUpperCase() : null,
      cheque_no: commissionChequeNo,
      cheque_status: commissionBucket === 'cheque' ? 'PENDING' : null,
      created_by: req.user.id,
      voucher_url: voucher_url || null,
      commission_id: commission.id,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    };

    const dayBookEntry = await dayBookModel.create(dbData, pool);
    return res.status(201).json({
      entry: dayBookEntry,
      commission,
      message: 'Plot commission recorded in Day Book and Commissions',
    });
  }

  // ── CASH FLOW: dual-write to day_book + cash_flow_entries ──
  if (normalizedType === 'CASH FLOW') {
    if (!particular) return res.status(400).json({ message: 'Particular is required' });
    const ledger_name = req.body.ledger_name ? req.body.ledger_name.trim().toUpperCase() : null;
    const cash_flow_month_id = req.body.cash_flow_month_id ? parseInt(req.body.cash_flow_month_id) : null;

    // Must provide either an existing month ID or a ledger name to create/find
    if (!cash_flow_month_id && !ledger_name) {
      return res.status(400).json({ message: 'Select a cash flow ledger or type a new ledger name' });
    }

    const cfDate = date || dateInIndia();
    const cfDebit = parseFloat(debit) || 0;
    const cfCredit = parseFloat(credit) || 0;
    const cfCashType = normalizeCashType(payment_mode);
    const cashFlowChequeNo = cfCashType === 'cheque' && req.body.cheque_no
      ? String(req.body.cheque_no).trim()
      : null;

    // Resolve month/year from the entry date
    const d = new Date(cfDate + 'T00:00:00');
    const cfMonth = d.getMonth() + 1;
    const cfYear = d.getFullYear();
    const ledger_type = req.body.ledger_type || 'site';

    // Find the cash_flow_months record — by ID first, then by period+name, or auto-create
    let monthRecord = null;
    if (cash_flow_month_id) {
      monthRecord = await cashFlowMonthModel.findById(cash_flow_month_id, pool);
      if (!monthRecord) return res.status(404).json({ message: 'Selected cash flow month not found' });
    }
    if (!monthRecord && ledger_name) {
      monthRecord = await cashFlowMonthModel.findByPeriod(parseInt(site_id), cfMonth, cfYear, ledger_name, pool);
    }
    if (!monthRecord) {
      // Auto-calculate opening balance from previous month
      let openingBal = 0;
      const prev = await cashFlowMonthModel.getPreviousMonth(parseInt(site_id), cfMonth, cfYear, ledger_name || '', pool);
      if (prev) {
        const closing = await cashFlowMonthModel.getClosingBalance(prev.id, pool);
        if (closing) openingBal = parseFloat(closing.closing_balance) || 0;
      }
      monthRecord = await cashFlowMonthModel.create({
        site_id: parseInt(site_id),
        month: cfMonth,
        year: cfYear,
        opening_balance: openingBal,
        ledger_name: ledger_name || null,
        ledger_type,
        created_by: req.user.id,
      }, pool);
    }

    // Check if month is locked
    if (monthRecord.is_locked) {
      return res.status(403).json({ message: `Cash flow month for "${monthRecord.ledger_name || 'Ledger'}" (${cfMonth}/${cfYear}) is locked` });
    }

    // Create the cash_flow_entries record
    const cfData = {
      cash_flow_month_id: monthRecord.id,
      site_id: parseInt(site_id),
      date: cfDate,
      particular: particular.trim().toUpperCase(),
      debit: cfDebit,
      credit: cfCredit,
      cash_type: cfCashType,
      cheque_no: cashFlowChequeNo,
      cheque_status: cfCashType === 'cheque' ? 'PENDING' : null,
      remarks: remarks ? remarks.trim() : null,
      created_by: req.user.id,
      voucher_url: voucher_url || null,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    };
    const cfEntry = await cashFlowEntryModel.create(cfData, pool);

    // Create the day book entry (linked via cash_flow_entry_id)
    const dbData = {
      site_id: parseInt(site_id),
      date: cfDate,
      particular: particular.trim().toUpperCase(),
      entry_type: 'CASH FLOW',
      debit: cfDebit,
      credit: cfCredit,
      remarks: remarks ? remarks.trim() : null,
      payment_mode: cfCashType.toUpperCase(),
      category: category ? category.trim().toUpperCase() : 'CASH FLOW',
      from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
      to_entity: to_entity ? to_entity.trim().toUpperCase() : null,
      account_no: account_no ? account_no.trim().toUpperCase() : null,
      branch: branch ? branch.trim().toUpperCase() : null,
      cheque_no: cashFlowChequeNo,
      cheque_status: cfCashType === 'cheque' ? 'PENDING' : null,
      created_by: req.user.id,
      voucher_url: voucher_url || null,
      cash_flow_entry_id: cfEntry.id,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    };
    const dayBookEntry = await dayBookModel.create(dbData, pool);

    return res.status(201).json({
      entry: dayBookEntry,
      cash_flow_entry: cfEntry,
      message: `Cash flow entry recorded in Day Book and "${ledger_name}" ledger`,
    });
  }

  // ── FIRM TRANSACTION: dual-write to day_book + firm_transactions ──
  if (normalizedType === 'FIRM TRANSACTION') {
    const firm_id = req.body.firm_id ? parseInt(req.body.firm_id) : null;
    if (!firm_id) return res.status(400).json({ message: 'Firm is required for firm transaction' });

    // Validate firm exists and belongs to this site
    const firm = await firmModel.findById(firm_id, pool);
    if (!firm) return res.status(404).json({ message: 'Firm not found' });
    if (firm.site_id !== parseInt(site_id)) {
      return res.status(400).json({ message: 'Firm does not belong to this site' });
    }

    const ftDate = date || dateInIndia();
    const ftDebit = parseFloat(debit) || 0;
    const ftCredit = parseFloat(credit) || 0;

    // Create the firm_transactions record
    const normMode = normalizeCashType(payment_mode);
    const ftData = {
      firm_id,
      site_id: parseInt(site_id),
      date: ftDate,
      description: particular.trim().toUpperCase(),
      debit: ftDebit,
      credit: ftCredit,
      name: req.body.firm_name ? req.body.firm_name.trim().toUpperCase() : null,
      purpose: req.body.firm_purpose ? req.body.firm_purpose.trim().toUpperCase() : null,
      remark: req.body.firm_remark ? req.body.firm_remark.trim().toUpperCase() : null,
      cheque_no: normMode === 'cheque' && req.body.firm_cheque_no
        ? req.body.firm_cheque_no.trim().toUpperCase()
        : null,
      payment_mode: normMode,
      cheque_status: normMode === 'cheque' ? 'PENDING' : null,
      created_by: req.user.id,
      voucher_url: voucher_url || null,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    };

    const firmTxn = await firmTransactionModel.create(ftData, pool);

    // Also create the day book entry (linked via firm_transaction_id)
    const upperMode = normMode.toUpperCase();
    const dbData = {
      site_id: parseInt(site_id),
      date: ftDate,
      particular: particular.trim().toUpperCase(),
      entry_type: 'FIRM TRANSACTION',
      debit: ftDebit,
      credit: ftCredit,
      remarks: remarks ? remarks.trim() : null,
      payment_mode: upperMode,
      category: category ? category.trim().toUpperCase() : 'FIRM',
      from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
      to_entity: to_entity ? to_entity.trim().toUpperCase() : firm.name,
      account_no: account_no ? account_no.trim().toUpperCase() : null,
      branch: branch ? branch.trim().toUpperCase() : null,
      cheque_no: normMode === 'cheque' && req.body.firm_cheque_no
        ? req.body.firm_cheque_no.trim().toUpperCase()
        : null,
      cheque_status: normMode === 'cheque' ? 'PENDING' : null,
      created_by: req.user.id,
      voucher_url: voucher_url || null,
      firm_transaction_id: firmTxn.id,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    };

    const dayBookEntry = await dayBookModel.create(dbData, pool);
    return res.status(201).json({
      entry: dayBookEntry,
      firm_transaction: firmTxn,
      message: `Firm transaction recorded in Day Book and "${firm.name}" transactions`,
    });
  }

  // ── PLOT PAYMENT: dual-write to day_book + plot_payments ──
  if (normalizedType === 'PLOT PAYMENT') {
    const pp_plot_id = req.body.pp_plot_id ? parseInt(req.body.pp_plot_id) : null;
    if (!pp_plot_id) return res.status(400).json({ message: 'Plot is required for plot payment' });

    const plot = await plotModel.findById(pp_plot_id, pool);
    if (!plot) return res.status(404).json({ message: 'Plot not found' });
    if (plot.site_id !== parseInt(site_id)) {
      return res.status(400).json({ message: 'Plot does not belong to this site' });
    }

    const ppDate = date || dateInIndia();
    const ppAmount = parseFloat(credit) || parseFloat(debit) || 0;
    const ppPaymentFrom = req.body.pp_payment_from ? req.body.pp_payment_from.trim().toUpperCase() : null;
    const ppPaymentType = normalizePlotPaymentType(req.body.pp_payment_type ?? payment_mode);
    const ppBankDetails = req.body.pp_bank_details ? req.body.pp_bank_details.trim().toUpperCase() : null;
    const ppNarration = req.body.pp_narration ? req.body.pp_narration.trim().toUpperCase() : null;
    const ppReceivedBy = req.body.pp_received_by ? req.body.pp_received_by.trim().toUpperCase() : null;

    // Create the plot_payments record
    const ppData = {
      plot_id: pp_plot_id,
      site_id: parseInt(site_id),
      date: ppDate,
      payment_from: ppPaymentFrom,
      payment_type: ppPaymentType,
      bank_details: ppBankDetails,
      narration: ppNarration,
      received_by: ppReceivedBy,
      amount: ppAmount,
      cheque_no: ppPaymentType === 'CHEQUE' && req.body.pp_cheque_no
        ? req.body.pp_cheque_no.trim().toUpperCase()
        : null,
      cheque_status: ppPaymentType === 'CHEQUE' ? 'PENDING' : null,
      created_by: req.user.id,
      voucher_url: voucher_url || null,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    };

    const plotPayment = await plotPaymentModel.create(ppData, pool);

    // Also create the day book entry (linked via plot_payment_id)
    const dbData = {
      site_id: parseInt(site_id),
      date: ppDate,
      particular: particular.trim().toUpperCase(),
      entry_type: 'PLOT PAYMENT',
      debit: parseFloat(debit) || 0,
      credit: parseFloat(credit) || 0,
      remarks: remarks ? remarks.trim() : null,
      payment_mode: ppPaymentType,
      category: category ? category.trim().toUpperCase() : 'PLOT PAYMENT',
      from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
      to_entity: to_entity ? to_entity.trim().toUpperCase() : `${plot.plot_no} - ${plot.buyer_name || ''}`.trim(),
      account_no: account_no ? account_no.trim().toUpperCase() : null,
      branch: branch ? branch.trim().toUpperCase() : null,
      cheque_no: ppPaymentType === 'CHEQUE' && req.body.pp_cheque_no
        ? req.body.pp_cheque_no.trim().toUpperCase()
        : null,
      cheque_status: ppPaymentType === 'CHEQUE' ? 'PENDING' : null,
      created_by: req.user.id,
      voucher_url: voucher_url || null,
      plot_payment_id: plotPayment.id,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    };

    const dayBookEntry = await dayBookModel.create(dbData, pool);
    return res.status(201).json({
      entry: dayBookEntry,
      plot_payment: plotPayment,
      message: `Plot payment recorded in Day Book and Plot Payments for "${plot.plot_no}"`,
    });
  }

  // ── Standard day book entry (non-special type) ──
  const stdMode = payment_mode ? payment_mode.trim().toUpperCase() : 'BANK';
  const data = {
    site_id: site_id,
    date: date || dateInIndia(),
    particular: particular.trim().toUpperCase(),
    entry_type: normalizedType,
    debit: parseFloat(debit) || 0,
    credit: parseFloat(credit) || 0,
    remarks: remarks ? remarks.trim() : null,
    payment_mode: stdMode,
    category: category ? category.trim().toUpperCase() : null,
    from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
    to_entity: to_entity ? to_entity.trim().toUpperCase() : null,
    account_no: account_no ? account_no.trim().toUpperCase() : null,
    branch: branch ? branch.trim().toUpperCase() : null,
    cheque_no: classifyPaymentMode(stdMode) === 'cheque' && req.body.cheque_no
      ? req.body.cheque_no.trim().toUpperCase()
      : null,
    cheque_status: classifyPaymentMode(stdMode) === 'cheque' ? 'PENDING' : null,
    created_by: req.user.id,
    voucher_url: voucher_url || null,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    mapped_member_id: mapped_member_id ? parseInt(mapped_member_id) : null,
    mapped_user_id: mapped_user_id ? parseInt(mapped_user_id) : null,
  };

  const dayBookEntry = await dayBookModel.create(data, pool);
  res.status(201).json({ entry: dayBookEntry });
});

/**
 * GET /daybook?site_id=X&date=YYYY-MM-DD
 * List day book entries + expenses for a SPECIFIC DATE (fast, indexed).
 * If no date given, falls back to today.
 * Expenses appear as EXPENSE-type entries with source:'expense'
 */
export const listDayBookEntries = asyncHandler(async (req, res) => {
  const { site_id, date } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const siteId = site_id;
  // Default to today if no date provided
  const queryDate = date || dateInIndia();

  console.log(`[daybook] listEntries site_id=${siteId} date=${queryDate}`);

  // Fetch ONLY the requested date from all tables — fast indexed queries
  const [dayBookEntriesRaw, expenseEntries, farmerPaymentEntries, commissionEntries, cashFlowEntries, firmTxnEntries, plotPaymentEntries, vendorPaymentEntries, commissionPaymentEntries, installmentPaymentEntries] = await Promise.all([
    dayBookModel.findBySiteAndDate(siteId, queryDate, pool),
    expenseModel.findBySiteAndDate(siteId, queryDate, pool).catch(err => { console.error('[daybook] expense query error:', err.message); return []; }),
    farmerPaymentModel.findBySiteAndDate(siteId, queryDate, pool).catch(err => { console.error('[daybook] farmer_payment query error:', err.message); return []; }),
    plotCommissionModel.findBySiteAndDate(siteId, queryDate, pool).catch(err => { console.error('[daybook] commission query error:', err.message); return []; }),
    cashFlowEntryModel.findBySiteAndDate(siteId, queryDate, pool).catch(err => { console.error('[daybook] cashflow query error:', err.message); return []; }),
    firmTransactionModel.findBySiteAndDate(siteId, queryDate, pool).catch(err => { console.error('[daybook] firm_transaction query error:', err.message); return []; }),
    plotPaymentModel.findBySiteAndDate(siteId, queryDate, pool).catch(err => { console.error('[daybook] plot_payment query error:', err.message); return []; }),
    // The three module tables below sync into the Balance Sheet but were
    // missing from the Day Book day view — including them keeps both reports
    // showing the same transactions.
    pool.query(
      `SELECT vp.*, vc.vendor_name, u.name AS assigned_admin_name
       FROM vendor_payments vp
       LEFT JOIN vendor_commitments vc ON vc.id = vp.commitment_id
       LEFT JOIN users u ON u.id = vp.assigned_admin_id
       WHERE vp.site_id = $1 AND vp.payment_date = $2
       ORDER BY vp.created_at ASC`,
      [siteId, queryDate]
    ).then(r => r.rows).catch(err => { console.error('[daybook] vendor_payment query error:', err.message); return []; }),
    pool.query(
      `SELECT pcp.*, COALESCE(m.full_name, 'AGENT') AS agent_name, u.name AS assigned_admin_name
       FROM plot_commission_payments pcp
       LEFT JOIN plot_commissions_v2 pcm ON pcm.id = pcp.plot_commission_id
       LEFT JOIN members m ON m.id = pcm.agent_id
       LEFT JOIN users u ON u.id = pcp.assigned_admin_id
       WHERE pcp.site_id = $1 AND pcp.date = $2
       ORDER BY pcp.created_at ASC`,
      [siteId, queryDate]
    ).then(r => r.rows).catch(err => { console.error('[daybook] commission_payment query error:', err.message); return []; }),
    pool.query(
      `SELECT pip.*, p.plot_no, p.block, p.buyer_name
       FROM plot_installment_payments pip
       JOIN plots p ON p.id = pip.plot_id
       WHERE p.site_id = $1 AND pip.payment_date = $2
       ORDER BY pip.created_at ASC`,
      [siteId, queryDate]
    ).then(r => r.rows).catch(err => { console.error('[daybook] installment_payment query error:', err.message); return []; }),
  ]);

  // These maps contain only authoritative rows that belong to queryDate. A
  // linked day_book row is a presentation mirror, so its source map is also the
  // generic date-authority check: if the source moved to another date, a stale
  // mirror fetched on the old date must not remain visible there.
  const farmerPaymentById = new Map(farmerPaymentEntries.map((row) => [Number(row.id), row]));
  const commissionById = new Map(commissionEntries.map((row) => [Number(row.id), row]));
  const cashFlowById = new Map(cashFlowEntries.map((row) => [Number(row.id), row]));
  const firmTxnById = new Map(firmTxnEntries.map((row) => [Number(row.id), row]));
  const plotPaymentById = new Map(plotPaymentEntries.map((row) => [Number(row.id), row]));
  const vendorPaymentById = new Map(vendorPaymentEntries.map((row) => [Number(row.id), row]));
  const authoritativeSourceByMirrorField = new Map([
    ['farmer_payment_id', farmerPaymentById],
    ['commission_id', commissionById],
    ['cash_flow_entry_id', cashFlowById],
    ['firm_transaction_id', firmTxnById],
    ['plot_payment_id', plotPaymentById],
    ['vendor_payment_id', vendorPaymentById],
  ]);

  // Exclude IMPREST entries and collapse specialized mirror rows to one row per
  // authoritative source record. SPLIT farmer payments deliberately create a
  // Cash mirror and a Bank mirror; enriching both with the full source amount
  // doubled the daily DayBook while Balance Sheet correctly counted it once.
  const linkedMirrorFields = [
    'farmer_payment_id', 'commission_id', 'cash_flow_entry_id',
    'firm_transaction_id', 'plot_payment_id', 'vendor_payment_id',
  ];
  // Specialized DayBook rows are presentation mirrors. The authoritative
  // source tables are fetched alongside them above, and migration 081 likewise
  // excludes these mirror types from the canonical ledger. Ignore orphaned
  // legacy mirrors (notably the old single-approval V2 commission copy), or a
  // day view can show a transaction that Main/Bank/Cash balances do not post.
  const requiredMirrorLink = {
    'FARMER PAYMENT': 'farmer_payment_id',
    'PLOT COMMISSION': 'commission_id',
    'CASH FLOW': 'cash_flow_entry_id',
    'FIRM TRANSACTION': 'firm_transaction_id',
    'PLOT PAYMENT': 'plot_payment_id',
    'VENDOR PAYMENT': 'vendor_payment_id',
  };
  const seenLinkedMirrors = new Set();
  const dayBookEntries = dayBookEntriesRaw.filter((entry) => {
    if (entry.entry_type === 'IMPREST') return false;
    const requiredLink = requiredMirrorLink[String(entry.entry_type || '').toUpperCase()];
    if (requiredLink && !entry[requiredLink]) return false;
    const field = linkedMirrorFields.find((key) => entry[key]);
    if (!field) return true;
    const authoritativeSource = authoritativeSourceByMirrorField.get(field);
    if (!authoritativeSource?.has(Number(entry[field]))) return false;
    const mirrorKey = `${field}:${entry[field]}`;
    if (seenLinkedMirrors.has(mirrorKey)) return false;
    seenLinkedMirrors.add(mirrorKey);
    return true;
  });

  // Transform expenses to day_book format
  const transformedExpenses = expenseEntries.map(exp => ({
    id: `expense_${exp.id}`,
    expense_id: exp.id,
    site_id: exp.site_id,
    date: exp.date,
    particular: exp.remark || '—',
    entry_type: 'EXPENSE',
    debit: exp.debit,
    credit: exp.credit,
    remarks: null,
    payment_mode: exp.payment_mode,
    category: exp.category,
    from_entity: exp.from_entity,
    to_entity: exp.to_entity,
    account_no: exp.account_no,
    branch: exp.branch,
    cheque_status: exp.cheque_status,
    cheque_no: exp.cheque_no,
    created_by: exp.created_by,
    created_at: exp.created_at,
    updated_at: exp.updated_at,
    assigned_admin_id: exp.assigned_admin_id,
    assigned_admin_name: exp.assigned_admin_name,
    status: exp.status,
    approved_by_name: exp.approved_by_name,
    source: 'expense',
  }));

  // Collect farmer_payment IDs that are already linked to daybook entries (avoid duplicates)
  const linkedFpIds = new Set(
    dayBookEntries
      .filter(e => e.farmer_payment_id)
      .map(e => e.farmer_payment_id)
  );

  // Transform farmer payments that are NOT already linked to a daybook entry
  const transformedFarmerPayments = farmerPaymentEntries
    .filter(fp => !linkedFpIds.has(fp.id))
    .map(fp => ({
      id: `fp_${fp.id}`,
      farmer_payment_id: fp.id,
      farmer_id: fp.farmer_id,
      farmer_name: fp.farmer_name,
      site_id: fp.site_id,
      date: fp.date,
      particular: `FARMER PAYMENT - ${fp.farmer_name}`,
      entry_type: 'FARMER PAYMENT',
      debit: fp.amount,
      credit: 0,
      remarks: fp.remarks,
      // farmer_payments.payment_mode is the source of truth ('CASH' / 'BANK' /
      // 'SPLIT'). The old code read fp.particular here which is the narration,
      // not the mode — that's why Cash Day Book totals disagreed with Main.
      payment_mode: (fp.payment_mode || 'BANK').toUpperCase(),
      cash_amount: parseFloat(fp.cash_amount) || 0,
      bank_amount: parseFloat(fp.bank_amount) || 0,
      category: null,
      from_entity: null,
      to_entity: fp.farmer_name,
      account_no: null,
      branch: null,
      by_note: fp.by_note,
      interest_rate: fp.interest_rate,
      interest_amount: fp.interest_amount,
      cheque_status: fp.cheque_status,
      cheque_no: fp.cheque_no,
      created_at: fp.created_at,
      updated_at: fp.updated_at,
      assigned_admin_id: fp.assigned_admin_id,
      assigned_admin_name: fp.assigned_admin_name,
      status: fp.status,
      source: 'farmer_payment',
    }));

  // Enrich daybook entries that ARE linked to farmer payments, commissions, etc.
  const enrichedDayBookEntries = dayBookEntries.map(e => {
    if (e.farmer_payment_id) {
      const fp = farmerPaymentById.get(Number(e.farmer_payment_id));
      if (fp) {
        return {
          ...e,
          date: fp.date,
          debit: fp.amount,
          credit: 0,
          remarks: fp.remarks,
          farmer_id: fp.farmer_id,
          farmer_name: fp.farmer_name,
          by_note: fp.by_note,
          interest_rate: fp.interest_rate,
          interest_amount: fp.interest_amount,
          // Passing split amounts through lets the client-side bucket
          // classifier handle SPLIT rows the same way the backend
          // mode-balance SQL does (cash_amount → cash, bank_amount → bank).
          cash_amount: parseFloat(fp.cash_amount) || 0,
          bank_amount: parseFloat(fp.bank_amount) || 0,
          payment_mode: (fp.payment_mode || e.payment_mode || 'BANK').toUpperCase(),
          cheque_status: fp.cheque_status,
          cheque_no: fp.cheque_no,
          voucher_url: fp.voucher_url || e.voucher_url,
          status: fp.status ?? e.status,
          source: 'daybook_farmer_payment',
        };
      }
    }
    if (e.commission_id) {
      const pc = commissionById.get(Number(e.commission_id));
      if (pc) {
        return {
          ...e,
          date: pc.date,
          debit: pc.amount,
          credit: 0,
          remarks: pc.remarks,
          plot_no: pc.plot_no,
          plot_size: pc.plot_size,
          plot_rate: pc.plot_rate,
          father_name: pc.father_name_resolved || pc.father_name,
          commission_amount: pc.amount,
          commission_by_note: pc.by_note,
          payment_mode: pc.payment_mode || e.payment_mode || 'BANK',
          cheque_status: pc.cheque_status,
          cheque_no: pc.cheque_no,
          voucher_url: pc.voucher_url || e.voucher_url,
          status: pc.status ?? e.status,
          source: 'daybook_commission',
        };
      }
    }
    if (e.cash_flow_entry_id) {
      const cf = cashFlowById.get(Number(e.cash_flow_entry_id));
      if (cf) {
        return {
          ...e,
          date: cf.date,
          debit: cf.debit,
          credit: cf.credit,
          remarks: cf.remarks,
          ledger_name: cf.ledger_name,
          ledger_type: cf.ledger_type,
          cf_month: cf.cf_month,
          cf_year: cf.cf_year,
          cash_flow_month_id: cf.cash_flow_month_id,
          payment_mode: cf.cash_type,
          cheque_status: cf.cheque_status,
          cheque_no: cf.cheque_no,
          voucher_url: cf.voucher_url || e.voucher_url,
          status: cf.status ?? e.status,
          source: 'daybook_cashflow',
        };
      }
    }
    if (e.firm_transaction_id) {
      const ft = firmTxnById.get(Number(e.firm_transaction_id));
      if (ft) {
        return {
          ...e,
          date: ft.date,
          particular: ft.description || e.particular,
          debit: ft.debit,
          credit: ft.credit,
          remarks: ft.remark,
          firm_id: ft.firm_id,
          firm_name: ft.firm_name,
          firm_description: ft.description,
          firm_txn_name: ft.name,
          firm_purpose: ft.purpose,
          firm_remark: ft.remark,
          firm_cheque_no: ft.cheque_no,
          payment_mode: ft.payment_mode ? ft.payment_mode.toUpperCase() : e.payment_mode,
          cheque_status: ft.cheque_status,
          cheque_no: ft.cheque_no,
          voucher_url: ft.voucher_url || e.voucher_url,
          status: ft.status ?? e.status,
          source: 'daybook_firm_transaction',
        };
      }
    }
    if (e.plot_payment_id) {
      const pp = plotPaymentById.get(Number(e.plot_payment_id));
      if (pp) {
        return {
          ...e,
          date: pp.date,
          debit: 0,
          credit: pp.amount,
          remarks: pp.narration,
          pp_plot_id: pp.plot_id,
          pp_plot_no: pp.plot_no,
          pp_block: pp.block,
          pp_buyer_name: pp.buyer_name,
          pp_sale_price: pp.sale_price,
          pp_amount: pp.amount,
          pp_payment_from: pp.payment_from,
          pp_payment_type: pp.payment_type,
          // payment_type is the accounting settlement mode. payment_from is
          // descriptive only and can contain values such as BOOKING/REFUND.
          payment_mode: pp.payment_type,
          pp_bank_details: pp.bank_details,
          pp_narration: pp.narration,
          pp_received_by: pp.received_by,
          cheque_status: pp.cheque_status,
          cheque_no: pp.cheque_no,
          voucher_url: pp.voucher_url || e.voucher_url,
          status: pp.status ?? e.status,
          source: 'daybook_plot_payment',
        };
      }
    }
    if (e.vendor_payment_id) {
      const vp = vendorPaymentById.get(Number(e.vendor_payment_id));
      if (vp) {
        return {
          ...e,
          date: vp.payment_date,
          debit: vp.amount,
          credit: 0,
          remarks: vp.note,
          payment_mode: vp.payment_mode ? String(vp.payment_mode).toUpperCase() : e.payment_mode,
          to_entity: vp.vendor_name || e.to_entity,
          cheque_status: vp.cheque_status,
          cheque_no: vp.cheque_no,
          voucher_url: vp.voucher_url || e.voucher_url,
          status: vp.status ?? e.status,
          source: 'daybook_vendor_payment',
        };
      }
    }
    return e;
  });

  // Collect commission IDs already linked to daybook entries (avoid duplicates)
  const linkedCommIds = new Set(
    dayBookEntries
      .filter(e => e.commission_id)
      .map(e => e.commission_id)
  );

  // Transform commissions that are NOT already linked to a daybook entry
  const transformedCommissions = commissionEntries
    .filter(c => !linkedCommIds.has(c.id))
    .map(c => ({
      id: `comm_${c.id}`,
      commission_id: c.id,
      site_id: c.site_id,
      date: c.date,
      particular: c.particular,
      father_name: c.father_name_resolved || c.father_name,
      entry_type: 'PLOT COMMISSION',
      debit: c.amount,
      credit: 0,
      remarks: c.remarks,
      payment_mode: c.payment_mode || 'BANK',
      category: 'COMMISSION',
      from_entity: null,
      to_entity: c.particular,
      account_no: null,
      branch: null,
      plot_no: c.plot_no,
      plot_size: c.plot_size,
      plot_rate: c.plot_rate,
      commission_amount: c.amount,
      commission_by_note: c.by_note,
      created_by: c.created_by,
      created_at: c.created_at,
      updated_at: c.updated_at,
      assigned_admin_id: c.assigned_admin_id,
      assigned_admin_name: c.assigned_admin_name,
      status: c.status,
      source: 'commission',
    }));

  // Collect cash_flow_entry IDs already linked to daybook entries (avoid duplicates)
  const linkedCfIds = new Set(
    dayBookEntries
      .filter(e => e.cash_flow_entry_id)
      .map(e => e.cash_flow_entry_id)
  );

  // Transform cash flow entries that are NOT already linked to a daybook entry
  const transformedCashFlow = cashFlowEntries
    .filter(cf => !linkedCfIds.has(cf.id))
    .map(cf => ({
      id: `cf_${cf.id}`,
      cash_flow_entry_id: cf.id,
      cash_flow_month_id: cf.cash_flow_month_id,
      site_id: cf.site_id,
      date: cf.date,
      particular: cf.particular,
      entry_type: 'CASH FLOW',
      debit: cf.debit,
      credit: cf.credit,
      remarks: cf.remarks,
      payment_mode: cf.cash_type,
      category: 'CASH FLOW',
      from_entity: null,
      to_entity: null,
      account_no: null,
      branch: null,
      ledger_name: cf.ledger_name,
      ledger_type: cf.ledger_type,
      cf_month: cf.cf_month,
      cf_year: cf.cf_year,
      cheque_status: cf.cheque_status,
      cheque_no: cf.cheque_no,
      created_by: cf.created_by,
      created_at: cf.created_at,
      updated_at: cf.updated_at,
      assigned_admin_id: cf.assigned_admin_id,
      assigned_admin_name: cf.assigned_admin_name,
      status: cf.status,
      source: 'cashflow',
    }));

  // Collect firm_transaction IDs already linked to daybook entries (avoid duplicates)
  const linkedFtIds = new Set(
    dayBookEntries
      .filter(e => e.firm_transaction_id)
      .map(e => e.firm_transaction_id)
  );

  // Transform firm transactions that are NOT already linked to a daybook entry
  const transformedFirmTxns = firmTxnEntries
    .filter(ft => !linkedFtIds.has(ft.id))
    .map(ft => ({
      id: `ft_${ft.id}`,
      firm_transaction_id: ft.id,
      firm_id: ft.firm_id,
      firm_name: ft.firm_name,
      site_id: ft.site_id,
      date: ft.date,
      particular: ft.description,
      entry_type: 'FIRM TRANSACTION',
      debit: ft.debit,
      credit: ft.credit,
      remarks: ft.remark,
      payment_mode: ft.payment_mode ? ft.payment_mode.toUpperCase() : null,
      category: 'FIRM',
      from_entity: null,
      to_entity: ft.firm_name,
      account_no: null,
      branch: null,
      firm_description: ft.description,
      firm_txn_name: ft.name,
      firm_purpose: ft.purpose,
      firm_remark: ft.remark,
      firm_cheque_no: ft.cheque_no,
      cheque_status: ft.cheque_status,
      cheque_no: ft.cheque_no,
      created_by: ft.created_by,
      created_at: ft.created_at,
      updated_at: ft.updated_at,
      assigned_admin_id: ft.assigned_admin_id,
      assigned_admin_name: ft.assigned_admin_name,
      status: ft.status,
      source: 'firm_transaction',
    }));

  // Collect plot_payment IDs already linked to daybook entries (avoid duplicates)
  const linkedPpIds = new Set(
    dayBookEntries
      .filter(e => e.plot_payment_id)
      .map(e => e.plot_payment_id)
  );

  // Transform plot payments that are NOT already linked to a daybook entry
  const transformedPlotPayments = plotPaymentEntries
    .filter(pp => !linkedPpIds.has(pp.id))
    .map(pp => ({
      id: `pp_${pp.id}`,
      plot_payment_id: pp.id,
      pp_plot_id: pp.plot_id,
      pp_plot_no: pp.plot_no,
      pp_block: pp.block,
      pp_buyer_name: pp.buyer_name,
      pp_sale_price: pp.sale_price,
      pp_amount: pp.amount,
      pp_payment_from: pp.payment_from,
      pp_payment_type: pp.payment_type,
      pp_bank_details: pp.bank_details,
      pp_narration: pp.narration,
      pp_received_by: pp.received_by,
      pp_cheque_no: pp.cheque_no,
      site_id: pp.site_id,
      date: pp.date,
      particular: `PLOT PAYMENT - ${pp.plot_no}${pp.buyer_name ? ' (' + pp.buyer_name + ')' : ''}`,
      entry_type: 'PLOT PAYMENT',
      debit: 0,
      credit: pp.amount,
      remarks: pp.narration,
      payment_mode: pp.payment_type,
      category: 'PLOT PAYMENT',
      from_entity: pp.buyer_name,
      to_entity: pp.plot_no,
      account_no: null,
      branch: null,
      cheque_status: pp.cheque_status,
      cheque_no: pp.cheque_no,
      created_by: pp.created_by,
      created_at: pp.created_at,
      updated_at: pp.updated_at,
      assigned_admin_id: pp.assigned_admin_id,
      assigned_admin_name: pp.assigned_admin_name,
      status: pp.status,
      source: 'plot_payment',
    }));

  // Vendor payments are mirrored into day_book by migration 019. Keep the
  // linked mirror as the editable row and add only genuinely unlinked records;
  // otherwise every vendor payment appears (and posts) twice in the day view.
  const linkedVendorIds = new Set(
    dayBookEntries.filter((entry) => entry.vendor_payment_id).map((entry) => Number(entry.vendor_payment_id))
  );
  const transformedVendorPayments = vendorPaymentEntries
    .filter((vp) => !linkedVendorIds.has(Number(vp.id)))
    .map(vp => ({
    id: `vp_${vp.id}`,
    vendor_payment_id: vp.id,
    site_id: vp.site_id,
    date: vp.payment_date,
    particular: `VENDOR PAYMENT - ${vp.vendor_name || 'VENDOR'}`,
    entry_type: 'VENDOR PAYMENT',
    debit: vp.amount,
    credit: 0,
    remarks: vp.note,
    payment_mode: vp.payment_mode ? String(vp.payment_mode).toUpperCase() : null,
    category: 'VENDOR PAYMENT',
    from_entity: null,
    to_entity: vp.vendor_name,
    account_no: null,
    branch: null,
    voucher_url: vp.voucher_url,
    cheque_status: vp.cheque_status,
    cheque_no: vp.cheque_no,
    created_by: vp.created_by,
    created_at: vp.created_at,
    assigned_admin_id: vp.assigned_admin_id,
    assigned_admin_name: vp.assigned_admin_name,
    status: vp.status,
    source: 'vendor_payment',
    }));

  // Plot commission payouts (V2 module — agent commissions)
  const transformedCommissionPayments = commissionPaymentEntries.map(pcp => ({
    id: `pcp_${pcp.id}`,
    commission_payment_id: pcp.id,
    site_id: pcp.site_id,
    date: pcp.date,
    particular: `COMMISSION PAYMENT - ${pcp.agent_name || 'AGENT'}`,
    entry_type: 'COMMISSION PAYMENT',
    debit: pcp.amount,
    credit: 0,
    remarks: pcp.remarks,
    payment_mode: pcp.payment_mode ? String(pcp.payment_mode).toUpperCase() : null,
    category: 'COMMISSION',
    from_entity: null,
    to_entity: pcp.agent_name,
    account_no: null,
    branch: null,
    voucher_url: pcp.voucher_url,
    cheque_status: pcp.cheque_status,
    cheque_no: pcp.cheque_no,
    created_by: pcp.created_by,
    created_at: pcp.created_at,
    assigned_admin_id: pcp.assigned_admin_id,
    assigned_admin_name: pcp.assigned_admin_name,
    status: pcp.status,
    source: 'commission_payment',
  }));

  // Plot installment payments (money in from buyers)
  const transformedInstallmentPayments = installmentPaymentEntries.map(pip => ({
    id: `pip_${pip.id}`,
    installment_payment_id: pip.id,
    site_id: siteId,
    date: pip.payment_date,
    particular: `INST. PAYMENT - ${pip.plot_no || 'PLOT'}${pip.buyer_name ? ' (' + pip.buyer_name + ')' : ''}`,
    entry_type: 'INSTALLMENT PAYMENT',
    debit: 0,
    credit: pip.amount,
    remarks: pip.notes,
    payment_mode: pip.payment_mode ? String(pip.payment_mode).toUpperCase() : null,
    category: 'PLOT PAYMENT',
    from_entity: pip.buyer_name,
    to_entity: pip.plot_no,
    account_no: null,
    branch: null,
    cheque_status: pip.cheque_status,
    cheque_no: pip.cheque_no,
      created_by: pip.created_by,
      created_at: pip.created_at,
      // Installment payments have no separate approval workflow; their source
      // rows are posted immediately (the CFE sync uses the same policy).
      status: 'approved',
      source: 'installment_payment',
  }));

  // Merge and sort ASC by id (prefixed sources are offset so ordering is stable per source)
  console.log(`[daybook] counts: daybook=${enrichedDayBookEntries.length} expenses=${transformedExpenses.length} fp=${transformedFarmerPayments.length} comm=${transformedCommissions.length} cf=${transformedCashFlow.length} ft=${transformedFirmTxns.length} pp=${transformedPlotPayments.length} vp=${transformedVendorPayments.length} pcp=${transformedCommissionPayments.length} pip=${transformedInstallmentPayments.length}`);
  const PREFIX_OFFSET = { expense: 100000, fp: 200000, comm: 300000, cf: 400000, ft: 500000, pp: 600000, vp: 700000, pcp: 800000, pip: 900000 };
  const sortKey = (x) => {
    if (typeof x.id === 'string') {
      const [prefix, num] = x.id.split('_');
      return (PREFIX_OFFSET[prefix] || 1100000) + (parseInt(num) || 0);
    }
    return x.id;
  };
  const rawEntries = [
    ...enrichedDayBookEntries, ...transformedExpenses, ...transformedFarmerPayments,
    ...transformedCommissions, ...transformedCashFlow, ...transformedFirmTxns, ...transformedPlotPayments,
    ...transformedVendorPayments, ...transformedCommissionPayments, ...transformedInstallmentPayments,
  ];
  // Store reversals on the opposite positive side for display and gross-flow
  // cards. Preserve original values so edit forms still receive the source
  // record exactly as it was stored. Net movement is unchanged.
  const allEntries = rawEntries.map((entry) => {
    const sourceDebit = parseFloat(entry.debit) || 0;
    const sourceCredit = parseFloat(entry.credit) || 0;
    return {
      ...entry,
      source_debit: entry.source_debit ?? sourceDebit,
      source_credit: entry.source_credit ?? sourceCredit,
      debit: Math.max(sourceDebit, 0) + Math.max(-sourceCredit, 0),
      credit: Math.max(sourceCredit, 0) + Math.max(-sourceDebit, 0),
    };
  }).sort((a, b) => sortKey(a) - sortKey(b));

  // Compute summary
  let total_debit = 0, total_credit = 0;
  const typeMap = {}, modeMap = {}, catMap = {};

  for (const e of allEntries) {
    // Financial totals use the same posted-only policy as Balance Sheet.
    const cs = e.cheque_status ? String(e.cheque_status).toUpperCase() : null;
    if (cs === 'BOUNCED' || cs === 'RETURNED') continue;
    if (String(e.status ?? 'approved').toLowerCase() !== 'approved') continue;

    const dr = parseFloat(e.debit) || 0;
    const cr = parseFloat(e.credit) || 0;
    total_debit += dr;
    total_credit += cr;

    const t = e.entry_type || 'GENERAL';
    if (!typeMap[t]) typeMap[t] = { entry_type: t, total_debit: 0, total_credit: 0, entries: 0 };
    typeMap[t].total_debit += dr; typeMap[t].total_credit += cr; typeMap[t].entries += 1;

    const m = e.payment_mode || 'UNSPECIFIED';
    if (!modeMap[m]) modeMap[m] = { payment_mode: m, total_debit: 0, total_credit: 0, entries: 0 };
    modeMap[m].total_debit += dr; modeMap[m].total_credit += cr; modeMap[m].entries += 1;

    const c = e.category || 'UNCATEGORIZED';
    if (!catMap[c]) catMap[c] = { category: c, total_debit: 0, total_credit: 0, entries: 0 };
    catMap[c].total_debit += dr; catMap[c].total_credit += cr; catMap[c].entries += 1;
  }

  // ── Daily balance (opening + closing) ──
  // Always derived from the canonical posted ledger. No stored snapshot is
  // trusted, so back-dated approvals, edits and bounced cheques reconcile on
  // the next read.
  let balance = null;
  try {
    const todayIso = dateInIndia();
    const row = await getCanonicalDailyBalance(siteId, queryDate, pool);
    balance = {
      opening_balance: row.opening_balance,
      closing_balance: row.closing_balance,
      running_balance: row.closing_balance,
      is_live: queryDate >= todayIso,
      tracked: true,
    };
  } catch (err) {
    console.error('[daybook] balance compute error:', err.message);
    balance = { opening_balance: null, closing_balance: null, running_balance: null, is_live: false, tracked: false };
  }

  // Attach a signed verifyUrl to each entry so the DayBook receipt can embed
  // a QR. Payload fields are minimal — display info only. The `i` field uses
  // the entry's full id (including prefix like "expense_123") so each QR is
  // uniquely identifiable.
  const siteRow = (await pool.query(
    'SELECT name, city, state FROM sites WHERE id = $1',
    [parseInt(siteId)]
  )).rows[0] || null;

  const amount = (e) => parseFloat(e.debit) || parseFloat(e.credit) || 0;
  const partyName = (e) =>
    e.to_entity || e.from_entity || e.farmer_name || e.agent_name ||
    e.particular || null;

  const entriesWithVerify = allEntries.map((e) => ({
    ...e,
    verifyUrl: buildVerifyUrl({
      t: ReceiptType.DAYBOOK,
      i: String(e.id),
      a: amount(e),
      d: e.date,
      pm: e.payment_mode || null,
      pn: partyName(e),
      pl: e.entry_type || null,
      sn: siteRow?.name || null,
      sy: siteRow?.city || null,
      ss: siteRow?.state || null,
    }),
  }));

  res.json({
    entries: entriesWithVerify,
    date: queryDate,
    summary: { total_debit, total_credit, total_count: entriesWithVerify.length },
    balance,
    typeBreakdown: Object.values(typeMap).sort((a, b) => b.total_debit - a.total_debit),
    modeBreakdown: Object.values(modeMap).sort((a, b) => b.total_debit - a.total_debit),
    categoryBreakdown: Object.values(catMap).sort((a, b) => b.total_debit - a.total_debit),
  });
});

/**
 * GET /daybook/daily-balance?site_id=X&date=YYYY-MM-DD
 * Returns the opening + closing balance for a site+date.
 * Calculated live from the posted ledger for any historical or current date.
 */
export const getDailyBalance = asyncHandler(async (req, res) => {
  const { site_id, date } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const queryDate = date || dateInIndia();

  const row = await getCanonicalDailyBalance(parseInt(site_id), queryDate, pool);
  res.json({
    date: queryDate,
    opening_balance: parseFloat(row.opening_balance) || 0,
    closing_balance: parseFloat(row.closing_balance) || 0,
    tracked: true,
  });
});

/**
 * GET /daybook/mode-balance?site_id=X&date=YYYY-MM-DD
 * Returns the posted ledger balance at the start of the selected day plus that
 * day's movement. This deliberately uses the same canonical cash_flow_entries
 * source, exclusions and split-payment expansion as BalanceSheet.model.js.
 */
export const getModeBalance = asyncHandler(async (req, res) => {
  const { site_id, date } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const queryDate = date || dateInIndia();
  const siteId = parseInt(site_id);

  const sql = `
    WITH source_rows AS (
      SELECT
        cfe.id,
        cfe.date::date AS date,
        COALESCE(NULLIF(TRIM(cfe.source_module), ''), 'personal_ledger') AS src,
        ledger_bucket(cfe.cash_type) AS pm,
        COALESCE(cfe.debit, 0)::numeric AS debit,
        COALESCE(cfe.credit, 0)::numeric AS credit,
        (cfe.source_module = 'farmer_payments'
          AND UPPER(COALESCE(fp.payment_mode, '')) = 'SPLIT'
          AND (COALESCE(fp.cash_amount, 0) + COALESCE(fp.bank_amount, 0)) > 0) AS is_split,
        COALESCE(fp.cash_amount, 0)::numeric AS split_cash,
        COALESCE(fp.bank_amount, 0)::numeric AS split_bank
      FROM cash_flow_entries cfe
      LEFT JOIN farmer_payments fp
        ON cfe.source_module = 'farmer_payments' AND fp.id = cfe.source_id
      LEFT JOIN day_book db
        ON cfe.source_module = 'day_book' AND db.id = cfe.source_id
      WHERE cfe.site_id = $1
        AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'
        AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
        AND COALESCE(cfe.source_module, '') NOT IN (
          'imprest', 'imprest_requests', 'document_imprest', 'document_imprest_requests',
          'plot_registry_payments'
        )
        AND COALESCE(cfe.source_module, '') NOT LIKE '%\\_person'
        AND NOT (cfe.source_module = 'day_book' AND UPPER(COALESCE(db.entry_type, '')) = 'IMPREST')
    ), normalized_rows AS (
      SELECT id::text AS id, date, src, pm, debit, credit
      FROM source_rows
      WHERE NOT is_split

      UNION ALL

      SELECT CONCAT(id, ':cash'), date, src, 'cash', split_cash, 0::numeric
      FROM source_rows
      WHERE is_split AND split_cash > 0

      UNION ALL

      SELECT CONCAT(id, ':bank'), date, src, 'bank', split_bank, 0::numeric
      FROM source_rows
      WHERE is_split AND split_bank > 0
    )
    SELECT date, src, pm, debit, credit
    FROM normalized_rows
    WHERE date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
      AND date <= $2::date
  `;

  const accum = { before: emptyBucketMap(), on: emptyBucketMap() };
  const bySrc = {};
  for (const b of BUCKETS) bySrc[b] = {};

  try {
    const { rows } = await pool.query(sql, [siteId, queryDate]);
    const toIso = (d) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d).slice(0, 10));
    for (const r of rows) {
      const bucket = classifyPaymentMode(r.pm);
      const period = toIso(r.date) < queryDate ? 'before' : 'on';
      const slot = accum[period][bucket];
      // Negative credits (refund/reversal rows) count as outflows and
      // symmetrically negative debits count as inflows, so the In/Out cards
      // show real gross flow magnitudes instead of a negative "Cash In".
      // Net (credit − debit) is unchanged either way.
      const cr = parseFloat(r.credit) || 0;
      const dr = parseFloat(r.debit)  || 0;
      if (cr >= 0) slot.credit += cr; else slot.debit += -cr;
      if (dr >= 0) slot.debit  += dr; else slot.credit += -dr;

      // Historical source totals stop at the opening cutoff. The UI adds the
      // selected day's route-scoped rows once, avoiding the old double-count.
      if (period === 'before') {
        const src = r.src || 'unknown';
        if (!bySrc[bucket][src]) bySrc[bucket][src] = { in: 0, out: 0 };
        if (cr >= 0) bySrc[bucket][src].in += cr; else bySrc[bucket][src].out += -cr;
        if (dr >= 0) bySrc[bucket][src].out += dr; else bySrc[bucket][src].in += -dr;
      }
    }
  } catch (err) {
    console.error('[daybook] mode-balance error:', err.message);
    return res.status(500).json({ message: 'Failed to compute mode balance' });
  }

  const SRC_LABEL = {
    plot_payments:            'Plot Sales (Direct)',
    plot_installment_payments:'Plot Installments',
    farmer_payments:          'Farmer Payments',
    expenses:                 'Expenses',
    plot_commission_payments: 'Plot Commissions',
    vendor_payments:          'Vendor Payments',
    day_book:                 'Direct Day Book',
    firm_transactions:       'Firm Transactions',
    plot_commissions:         'Plot Commissions',
    personal_ledger:          'Personal Ledger',
  };
  const buildSlice = (bucket) => {
    const before = accum.before[bucket];
    const on     = accum.on[bucket];
    const opening = before.credit - before.debit;
    const srcMap = bySrc[bucket] || {};
    const by_src = {};
    for (const [s, e] of Object.entries(srcMap)) {
      if (e.in > 0.001 || e.out > 0.001) {
        by_src[s] = { in: e.in, out: e.out, label: SRC_LABEL[s] || s };
      }
    }
    return {
      opening_balance: opening,
      opening_credit: before.credit,
      opening_debit:  before.debit,
      day_credit: on.credit,
      day_debit:  on.debit,
      current_balance: opening + on.credit - on.debit,
      by_src,
    };
  };

  const payload = { date: queryDate };
  for (const b of BUCKETS) payload[b] = buildSlice(b);

  // Main is always exactly Cash + Bank (where Bank includes every non-cash
  // detail bucket, including cheque).
  const total = {
    opening_balance: 0,
    opening_credit: 0,
    opening_debit: 0,
    day_credit: 0,
    day_debit: 0,
    current_balance: 0,
  };
  for (const b of BUCKETS) {
    total.opening_balance += payload[b].opening_balance;
    total.opening_credit  += payload[b].opening_credit;
    total.opening_debit   += payload[b].opening_debit;
    total.day_credit      += payload[b].day_credit;
    total.day_debit       += payload[b].day_debit;
    total.current_balance += payload[b].current_balance;
  }
  payload.total = total;
  payload.site = { ...total };

  res.json(payload);
});

/**
 * GET /daybook/autocomplete?site_id=X
 */
export const getAutocomplete = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const data = await dayBookModel.getAutocomplete(site_id, pool);
  res.json(data);
});

/**
 * GET /daybook/:id
 */
export const getDayBookEntry = asyncHandler(async (req, res) => {
  const entry = await dayBookModel.findById(parseInt(req.params.id), pool);
  if (!entry) return res.status(404).json({ message: 'Day book entry not found' });
  res.json({ entry });
});

/**
 * PUT /daybook/:id
 * Update a day book entry
 * Note: If entry_type changes to/from EXPENSE, manually handle expense table sync
 */
export const updateDayBookEntry = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await dayBookModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Day book entry not found' });

  const {
    date, particular, entry_type, debit, credit, remarks,
    payment_mode, category, from_entity, to_entity, account_no, branch, voucher_url,
    cheque_no, cheque_status,
  } = req.body;

  const nextPaymentMode = payment_mode !== undefined
    ? (payment_mode ? payment_mode.trim().toUpperCase() : 'BANK')
    : existing.payment_mode;

  const data = {
    date: date || existing.date,
    particular: particular !== undefined ? particular.trim().toUpperCase() : existing.particular,
    entry_type: entry_type !== undefined ? entry_type.trim().toUpperCase() : existing.entry_type,
    debit: debit !== undefined ? (parseFloat(debit) || 0) : existing.debit,
    credit: credit !== undefined ? (parseFloat(credit) || 0) : existing.credit,
    remarks: remarks !== undefined ? (remarks ? remarks.trim() : null) : existing.remarks,
    payment_mode: nextPaymentMode,
    category: category !== undefined ? (category ? category.trim().toUpperCase() : null) : existing.category,
    from_entity: from_entity !== undefined ? (from_entity ? from_entity.trim().toUpperCase() : null) : existing.from_entity,
    to_entity: to_entity !== undefined ? (to_entity ? to_entity.trim().toUpperCase() : null) : existing.to_entity,
    account_no: account_no !== undefined ? (account_no ? account_no.trim().toUpperCase() : null) : existing.account_no,
    branch: branch !== undefined ? (branch ? branch.trim().toUpperCase() : null) : existing.branch,
    voucher_url: voucher_url !== undefined ? (voucher_url || null) : existing.voucher_url,
  };
  if (payment_mode !== undefined) {
    data.cheque_status = classifyPaymentMode(nextPaymentMode) === 'cheque' && cheque_status !== undefined
      ? (cheque_status ? String(cheque_status).trim().toUpperCase() : 'PENDING')
      : resolveChequeStatus({
        currentMode: existing.payment_mode,
        currentStatus: existing.cheque_status,
        nextMode: nextPaymentMode,
      });
    data.cheque_no = classifyPaymentMode(nextPaymentMode) === 'cheque'
      ? (cheque_no !== undefined ? (cheque_no ? String(cheque_no).trim() : null) : existing.cheque_no)
      : null;
  } else {
    if (cheque_no !== undefined) {
      data.cheque_no = classifyPaymentMode(nextPaymentMode) === 'cheque' && cheque_no
        ? String(cheque_no).trim()
        : null;
    }
    if (cheque_status !== undefined) {
      data.cheque_status = classifyPaymentMode(nextPaymentMode) === 'cheque'
        ? (cheque_status ? String(cheque_status).trim().toUpperCase() : 'PENDING')
        : null;
    }
  }

  const updated = await dayBookModel.update(parseInt(id), data, pool);
  res.json({ entry: updated });
});

/**
 * DELETE /daybook/:id
 * Delete a day book entry
 */
export const deleteDayBookEntry = asyncHandler(async (req, res) => {
  const existing = await dayBookModel.findById(parseInt(req.params.id), pool);
  if (!existing) return res.status(404).json({ message: 'Day book entry not found' });
  await dayBookModel.delete(parseInt(req.params.id), pool);
  res.json({ message: 'Day book entry deleted' });
});

/**
 * PUT /daybook/expense/:id
 * Update an expense entry FROM the Day Book module
 * Maps day_book field names to expense field names
 */
export const updateExpenseFromDayBook = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await expenseModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Expense not found' });

  const {
    date, particular, debit, credit,
    payment_mode, category, from_entity, to_entity, account_no, branch,
    cheque_no, cheque_status,
  } = req.body;

  const nextExpenseMode = payment_mode !== undefined
    ? (payment_mode ? payment_mode.trim().toUpperCase() : 'BANK')
    : existing.payment_mode;

  const data = {
    date: date || existing.date,
    from_entity: from_entity !== undefined ? (from_entity ? from_entity.trim().toUpperCase() : null) : existing.from_entity,
    to_entity: to_entity !== undefined ? (to_entity ? to_entity.trim().toUpperCase() : null) : existing.to_entity,
    payment_mode: nextExpenseMode,
    debit: debit !== undefined ? (parseFloat(debit) || 0) : existing.debit,
    credit: credit !== undefined ? (parseFloat(credit) || 0) : existing.credit,
    remark: particular !== undefined ? (particular ? particular.trim().toUpperCase() : null) : existing.remark,
    account_no: account_no !== undefined ? (account_no ? account_no.trim().toUpperCase() : null) : existing.account_no,
    branch: branch !== undefined ? (branch ? branch.trim().toUpperCase() : null) : existing.branch,
    category: category !== undefined ? (category ? category.trim().toUpperCase() : null) : existing.category,
  };
  if (payment_mode !== undefined) {
    data.cheque_status = classifyPaymentMode(nextExpenseMode) === 'cheque' && cheque_status !== undefined
      ? (cheque_status ? String(cheque_status).trim().toUpperCase() : 'PENDING')
      : resolveChequeStatus({
        currentMode: existing.payment_mode,
        currentStatus: existing.cheque_status,
        nextMode: nextExpenseMode,
      });
    data.cheque_no = classifyPaymentMode(nextExpenseMode) === 'cheque'
      ? (cheque_no !== undefined ? (cheque_no ? String(cheque_no).trim() : null) : existing.cheque_no)
      : null;
  } else {
    if (cheque_no !== undefined) {
      data.cheque_no = classifyPaymentMode(nextExpenseMode) === 'cheque' && cheque_no
        ? String(cheque_no).trim()
        : null;
    }
    if (cheque_status !== undefined) {
      data.cheque_status = classifyPaymentMode(nextExpenseMode) === 'cheque'
        ? (cheque_status ? String(cheque_status).trim().toUpperCase() : 'PENDING')
        : null;
    }
  }

  const updated = await expenseModel.update(parseInt(id), data, pool);
  res.json({ entry: updated });
});

/**
 * DELETE /daybook/expense/:id
 * Delete an expense entry FROM the Day Book module
 */
export const deleteExpenseFromDayBook = asyncHandler(async (req, res) => {
  const existing = await expenseModel.findById(parseInt(req.params.id), pool);
  if (!existing) return res.status(404).json({ message: 'Expense not found' });
  await expenseModel.delete(parseInt(req.params.id), pool);
  res.json({ message: 'Expense deleted' });
});

// ══════════════════════════════════════════════════
//  FARMER PAYMENT ENDPOINTS (from Day Book)
// ══════════════════════════════════════════════════

/**
 * GET /daybook/farmers?site_id=X
 * List farmers for the dropdown in Day Book
 */
export const listFarmersForDayBook = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const farmers = await farmerModel.findBySiteId(site_id, pool);
  res.json({ farmers });
});

/**
 * PUT /daybook/farmer-payment/:id
 * Update a farmer payment FROM the Day Book module
 * Updates both the farmer_payment record and any linked day_book entry
 */
export const updateFarmerPaymentFromDayBook = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await farmerPaymentModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Farmer payment not found' });

  const {
    date, particular, debit, payment_mode, remarks,
    farmer_id, interest_rate, interest_amount, by_note,
    from_entity, to_entity, account_no, branch, category, cheque_no,
  } = req.body;

  const farmerPaymentMode = payment_mode !== undefined
    ? (payment_mode ? payment_mode.trim().toUpperCase() : 'BANK')
    : String(existing.payment_mode || existing.particular || 'BANK').trim().toUpperCase();

  const nextAmount = debit !== undefined ? (parseFloat(debit) || 0) : (parseFloat(existing.amount) || 0);
  const allocationChanged = payment_mode !== undefined || debit !== undefined;

  // Update farmer_payment record. Keep payment_mode populated even for legacy
  // rows where the mode was written only into particular, and keep SPLIT as an
  // exact partition if the amount is edited from Day Book.
  const fpUpdate = {
    date: date || existing.date,
    particular: farmerPaymentMode,
    payment_mode: farmerPaymentMode,
    amount: nextAmount,
    by_note: by_note !== undefined ? (by_note ? by_note.trim() : null) : existing.by_note,
    interest_rate: interest_rate !== undefined ? (parseFloat(interest_rate) || 0) : existing.interest_rate,
    interest_amount: interest_amount !== undefined ? (parseFloat(interest_amount) || 0) : existing.interest_amount,
    remarks: remarks !== undefined ? (remarks ? remarks.trim() : null) : existing.remarks,
  };
  if (allocationChanged) {
    if (farmerPaymentMode === 'SPLIT') {
      if (nextAmount < 0) return res.status(400).json({ message: 'A split farmer payment cannot be negative' });
      const oldCash = Math.max(parseFloat(existing.cash_amount) || 0, 0);
      const oldBank = Math.max(parseFloat(existing.bank_amount) || 0, 0);
      const oldParts = oldCash + oldBank;
      const nextCash = oldParts > 0 ? nextAmount * oldCash / oldParts : 0;
      fpUpdate.cash_amount = nextCash;
      fpUpdate.bank_amount = nextAmount - nextCash;
      fpUpdate.cheque_status = null;
      fpUpdate.cheque_no = null;
    } else {
      const bucket = classifyPaymentMode(farmerPaymentMode);
      fpUpdate.cash_amount = bucket === 'cash' ? nextAmount : 0;
      fpUpdate.bank_amount = bucket === 'cash' ? 0 : nextAmount;
      fpUpdate.cheque_status = resolveChequeStatus({
        currentMode: existing.payment_mode,
        currentStatus: existing.cheque_status,
        nextMode: farmerPaymentMode,
      });
      fpUpdate.cheque_no = bucket === 'cheque'
        ? (cheque_no !== undefined ? (cheque_no ? String(cheque_no).trim() : null) : existing.cheque_no)
        : null;
    }
  } else if (cheque_no !== undefined) {
    fpUpdate.cheque_no = classifyPaymentMode(farmerPaymentMode) === 'cheque' && cheque_no
      ? String(cheque_no).trim()
      : null;
  }

  const updatedFp = await farmerPaymentModel.update(parseInt(id), fpUpdate, pool);

  // Also update any linked day_book entry
  const linkedDbQuery = await pool.query(
    'SELECT id FROM day_book WHERE farmer_payment_id = $1',
    [parseInt(id)]
  );
  if (linkedDbQuery.rows.length > 0) {
    const dbId = linkedDbQuery.rows[0].id;
    const dbUpdate = {
      date: date || existing.date,
      particular: particular !== undefined ? particular.trim().toUpperCase() : undefined,
      entry_type: 'FARMER PAYMENT',
      debit: debit !== undefined ? (parseFloat(debit) || 0) : existing.amount,
      remarks: remarks !== undefined ? (remarks ? remarks.trim() : null) : existing.remarks,
      payment_mode: payment_mode !== undefined ? farmerPaymentMode : undefined,
      from_entity: from_entity !== undefined ? (from_entity ? from_entity.trim().toUpperCase() : null) : undefined,
      to_entity: to_entity !== undefined ? (to_entity ? to_entity.trim().toUpperCase() : null) : undefined,
      account_no: account_no !== undefined ? (account_no ? account_no.trim().toUpperCase() : null) : undefined,
      branch: branch !== undefined ? (branch ? branch.trim().toUpperCase() : null) : undefined,
      category: category !== undefined ? (category ? category.trim().toUpperCase() : null) : undefined,
      cheque_no: allocationChanged || cheque_no !== undefined ? fpUpdate.cheque_no : undefined,
      cheque_status: allocationChanged ? fpUpdate.cheque_status : undefined,
    };
    // Remove undefined keys
    Object.keys(dbUpdate).forEach(k => dbUpdate[k] === undefined && delete dbUpdate[k]);
    await dayBookModel.update(dbId, dbUpdate, pool);
  }

  res.json({ entry: updatedFp, message: 'Farmer payment updated' });
});

/**
 * DELETE /daybook/farmer-payment/:id
 * Delete a farmer payment FROM the Day Book module
 * Deletes both the farmer_payment record and any linked day_book entry
 */
export const deleteFarmerPaymentFromDayBook = asyncHandler(async (req, res) => {
  const fpId = parseInt(req.params.id);
  const existing = await farmerPaymentModel.findById(fpId, pool);
  if (!existing) return res.status(404).json({ message: 'Farmer payment not found' });

  // Delete linked day_book entry first (if any)
  await pool.query('DELETE FROM day_book WHERE farmer_payment_id = $1', [fpId]);

  // Delete the farmer payment
  await farmerPaymentModel.delete(fpId, pool);
  res.json({ message: 'Farmer payment deleted from Day Book and Farmer Payments' });
});

// ══════════════════════════════════════════════════
//  PLOT COMMISSION ENDPOINTS (from Day Book)
// ══════════════════════════════════════════════════

/**
 * GET /daybook/members?site_id=X&q=search
 * List members for the dropdown in Day Book (with optional search)
 */
export const listMembersForDayBook = asyncHandler(async (req, res) => {
  const { site_id, q } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  let members;
  if (q && q.trim()) {
    members = await memberModel.search(site_id, q.trim(), pool);
  } else {
    members = await memberModel.findBySiteId(site_id, pool);
  }
  res.json({ members });
});

/**
 * PUT /daybook/commission/:id
 * Update a commission FROM the Day Book module
 * Updates both the plot_commissions record and any linked day_book entry
 */
export const updateCommissionFromDayBook = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await plotCommissionModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Commission not found' });

  const {
    date, particular, debit, payment_mode, remarks,
    plot_no, by_note,
    from_entity, to_entity, account_no, branch, category, cheque_no,
  } = req.body;

  const commissionPaymentMode = payment_mode !== undefined
    ? (payment_mode ? payment_mode.trim().toUpperCase() : 'BANK')
    : String(existing.payment_mode || 'BANK').trim().toUpperCase();

  // Update plot_commissions record
  const pcUpdate = {
    date: date || existing.date,
    particular: particular !== undefined ? particular.trim() : existing.particular,
    father_name: req.body.father_name !== undefined ? (req.body.father_name ? req.body.father_name.trim().toUpperCase() : null) : existing.father_name,
    plot_no: plot_no !== undefined ? (plot_no ? plot_no.trim() : null) : existing.plot_no,
    plot_size: req.body.plot_size !== undefined ? (req.body.plot_size ? req.body.plot_size.trim().toUpperCase() : null) : existing.plot_size,
    plot_rate: req.body.plot_rate !== undefined ? (req.body.plot_rate ? req.body.plot_rate.trim().toUpperCase() : null) : existing.plot_rate,
    amount: debit !== undefined ? (parseFloat(debit) || 0) : existing.amount,
    by_note: by_note !== undefined ? (by_note ? by_note.trim() : null) : existing.by_note,
    payment_mode: commissionPaymentMode,
    remarks: remarks !== undefined ? (remarks ? remarks.trim() : null) : existing.remarks,
  };
  if (payment_mode !== undefined) {
    pcUpdate.cheque_status = resolveChequeStatus({
      currentMode: existing.payment_mode,
      currentStatus: existing.cheque_status,
      nextMode: commissionPaymentMode,
    });
    pcUpdate.cheque_no = classifyPaymentMode(commissionPaymentMode) === 'cheque'
      ? (cheque_no !== undefined ? (cheque_no ? String(cheque_no).trim() : null) : existing.cheque_no)
      : null;
  } else if (cheque_no !== undefined) {
    pcUpdate.cheque_no = classifyPaymentMode(commissionPaymentMode) === 'cheque' && cheque_no
      ? String(cheque_no).trim()
      : null;
  }

  const updatedPc = await plotCommissionModel.update(parseInt(id), pcUpdate, pool);

  // Also update any linked day_book entry
  const linkedDbQuery = await pool.query(
    'SELECT id FROM day_book WHERE commission_id = $1',
    [parseInt(id)]
  );
  if (linkedDbQuery.rows.length > 0) {
    const dbId = linkedDbQuery.rows[0].id;
    const dbUpdate = {
      date: date || existing.date,
      particular: particular !== undefined ? particular.trim().toUpperCase() : undefined,
      entry_type: 'PLOT COMMISSION',
      debit: debit !== undefined ? (parseFloat(debit) || 0) : existing.amount,
      remarks: remarks !== undefined ? (remarks ? remarks.trim() : null) : existing.remarks,
      payment_mode: commissionPaymentMode,
      from_entity: from_entity !== undefined ? (from_entity ? from_entity.trim().toUpperCase() : null) : undefined,
      to_entity: to_entity !== undefined ? (to_entity ? to_entity.trim().toUpperCase() : null) : undefined,
      account_no: account_no !== undefined ? (account_no ? account_no.trim().toUpperCase() : null) : undefined,
      branch: branch !== undefined ? (branch ? branch.trim().toUpperCase() : null) : undefined,
      category: category !== undefined ? (category ? category.trim().toUpperCase() : null) : undefined,
      cheque_no: payment_mode !== undefined || cheque_no !== undefined ? pcUpdate.cheque_no : undefined,
      cheque_status: payment_mode !== undefined ? pcUpdate.cheque_status : undefined,
    };
    Object.keys(dbUpdate).forEach(k => dbUpdate[k] === undefined && delete dbUpdate[k]);
    await dayBookModel.update(dbId, dbUpdate, pool);
  }

  res.json({ entry: updatedPc, message: 'Commission updated' });
});

/**
 * DELETE /daybook/commission/:id
 * Delete a commission FROM the Day Book module
 * Deletes both the plot_commissions record and any linked day_book entry
 */
export const deleteCommissionFromDayBook = asyncHandler(async (req, res) => {
  const pcId = parseInt(req.params.id);
  const existing = await plotCommissionModel.findById(pcId, pool);
  if (!existing) return res.status(404).json({ message: 'Commission not found' });

  // Delete linked day_book entry first (if any)
  await pool.query('DELETE FROM day_book WHERE commission_id = $1', [pcId]);

  // Delete the commission
  await plotCommissionModel.delete(pcId, pool);
  res.json({ message: 'Commission deleted from Day Book and Commissions' });
});

// ══════════════════════════════════════════════════
//  CASH FLOW ENDPOINTS (from Day Book)
// ══════════════════════════════════════════════════

/**
 * GET /daybook/cashflow-ledgers?site_id=X
 * List ALL cash_flow_months records for the Cash Flow dropdown in Day Book
 * Returns every month+ledger combination (not just unique names)
 */
export const listCashFlowLedgersForDayBook = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const months = await cashFlowMonthModel.findBySiteId(parseInt(site_id), pool);
  res.json({ ledgers: months });
});

/**
 * PUT /daybook/cashflow-entry/:id
 * Update a cash flow entry FROM the Day Book module
 * Updates both the cash_flow_entries record and any linked day_book entry
 */
export const updateCashFlowEntryFromDayBook = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await cashFlowEntryModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Cash flow entry not found' });

  // Check if month is locked
  const cfMonth = await cashFlowMonthModel.findById(existing.cash_flow_month_id, pool);
  if (cfMonth && cfMonth.is_locked) {
    return res.status(403).json({ message: 'This cash flow month is locked.' });
  }

  const {
    date, particular, debit, credit, remarks,
    payment_mode, from_entity, to_entity, account_no, branch, category, cheque_no,
  } = req.body;
  const ledger_name = req.body.ledger_name ? req.body.ledger_name.trim().toUpperCase() : null;

  // If the date changed, we may need to re-resolve the month
  let targetMonthId = existing.cash_flow_month_id;
  const newDate = date || existing.date;

  if (date && ledger_name) {
    const d = new Date(date + 'T00:00:00');
    const newMonth = d.getMonth() + 1;
    const newYear = d.getFullYear();
    const ledger_type = req.body.ledger_type || cfMonth?.ledger_type || 'site';

    if (newMonth !== cfMonth?.month || newYear !== cfMonth?.year || ledger_name !== cfMonth?.ledger_name) {
      let newMonthRecord = await cashFlowMonthModel.findByPeriod(parseInt(existing.site_id), newMonth, newYear, ledger_name, pool);
      if (!newMonthRecord) {
        let openingBal = 0;
        const prev = await cashFlowMonthModel.getPreviousMonth(parseInt(existing.site_id), newMonth, newYear, ledger_name, pool);
        if (prev) {
          const closing = await cashFlowMonthModel.getClosingBalance(prev.id, pool);
          if (closing) openingBal = parseFloat(closing.closing_balance) || 0;
        }
        newMonthRecord = await cashFlowMonthModel.create({
          site_id: parseInt(existing.site_id),
          month: newMonth,
          year: newYear,
          opening_balance: openingBal,
          ledger_name,
          ledger_type,
          created_by: req.user.id,
        }, pool);
      }
      if (newMonthRecord.is_locked) {
        return res.status(403).json({ message: `Target month for "${ledger_name}" (${newMonth}/${newYear}) is locked` });
      }
      targetMonthId = newMonthRecord.id;
    }
  }

  // Update cash_flow_entries record
  const nextCashType = payment_mode !== undefined ? normalizeCashType(payment_mode) : undefined;
  const cfUpdate = {
    cash_flow_month_id: targetMonthId,
    date: newDate,
    particular: particular !== undefined ? particular.trim().toUpperCase() : existing.particular,
    debit: debit !== undefined ? (parseFloat(debit) || 0) : existing.debit,
    credit: credit !== undefined ? (parseFloat(credit) || 0) : existing.credit,
    remarks: remarks !== undefined ? (remarks ? remarks.trim() : null) : existing.remarks,
    ...(nextCashType !== undefined && {
      cash_type: nextCashType,
      cheque_status: resolveChequeStatus({
        currentMode: existing.cash_type,
        currentStatus: existing.cheque_status,
        nextMode: nextCashType,
      }),
      cheque_no: nextCashType === 'cheque'
        ? (cheque_no !== undefined ? (cheque_no ? String(cheque_no).trim() : null) : existing.cheque_no)
        : null,
    }),
  };
  if (nextCashType === undefined && cheque_no !== undefined) {
    cfUpdate.cheque_no = classifyPaymentMode(existing.cash_type) === 'cheque' && cheque_no
      ? String(cheque_no).trim()
      : null;
  }

  const updatedCf = await cashFlowEntryModel.update(parseInt(id), cfUpdate, pool);

  // Also update any linked day_book entry
  const linkedDbQuery = await pool.query(
    'SELECT id FROM day_book WHERE cash_flow_entry_id = $1',
    [parseInt(id)]
  );
  if (linkedDbQuery.rows.length > 0) {
    const dbId = linkedDbQuery.rows[0].id;
    const dbUpdate = {
      date: newDate,
      particular: particular !== undefined ? particular.trim().toUpperCase() : undefined,
      entry_type: 'CASH FLOW',
      debit: debit !== undefined ? (parseFloat(debit) || 0) : undefined,
      credit: credit !== undefined ? (parseFloat(credit) || 0) : undefined,
      remarks: remarks !== undefined ? (remarks ? remarks.trim() : null) : undefined,
      payment_mode: nextCashType !== undefined ? nextCashType.toUpperCase() : undefined,
      from_entity: from_entity !== undefined ? (from_entity ? from_entity.trim().toUpperCase() : null) : undefined,
      to_entity: to_entity !== undefined ? (to_entity ? to_entity.trim().toUpperCase() : null) : undefined,
      account_no: account_no !== undefined ? (account_no ? account_no.trim().toUpperCase() : null) : undefined,
      branch: branch !== undefined ? (branch ? branch.trim().toUpperCase() : null) : undefined,
      category: category !== undefined ? (category ? category.trim().toUpperCase() : null) : undefined,
      cheque_no: nextCashType !== undefined || cheque_no !== undefined ? cfUpdate.cheque_no : undefined,
      cheque_status: nextCashType !== undefined ? cfUpdate.cheque_status : undefined,
    };
    Object.keys(dbUpdate).forEach(k => dbUpdate[k] === undefined && delete dbUpdate[k]);
    await dayBookModel.update(dbId, dbUpdate, pool);
  }

  res.json({ entry: updatedCf, message: 'Cash flow entry updated' });
});

/**
 * DELETE /daybook/cashflow-entry/:id
 * Delete a cash flow entry FROM the Day Book module
 * Deletes both the cash_flow_entries record and any linked day_book entry
 */
export const deleteCashFlowEntryFromDayBook = asyncHandler(async (req, res) => {
  const cfId = parseInt(req.params.id);
  const existing = await cashFlowEntryModel.findById(cfId, pool);
  if (!existing) return res.status(404).json({ message: 'Cash flow entry not found' });

  // Check if month is locked
  const cfMonth = await cashFlowMonthModel.findById(existing.cash_flow_month_id, pool);
  if (cfMonth && cfMonth.is_locked) {
    return res.status(403).json({ message: 'This cash flow month is locked.' });
  }

  // Delete linked day_book entry first (if any)
  await pool.query('DELETE FROM day_book WHERE cash_flow_entry_id = $1', [cfId]);

  // Delete the cash flow entry
  await cashFlowEntryModel.delete(cfId, pool);
  res.json({ message: 'Cash flow entry deleted from Day Book and Cash Flow' });
});

// ══════════════════════════════════════════════════
//  FIRM TRANSACTION ENDPOINTS (from Day Book)
// ══════════════════════════════════════════════════

/**
 * GET /daybook/firms?site_id=X
 * List firms for the dropdown in Day Book
 */
export const listFirmsForDayBook = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const firms = await firmModel.findBySiteId(parseInt(site_id), pool);
  res.json({ firms });
});

/**
 * PUT /daybook/firm-transaction/:id
 * Update a firm transaction FROM the Day Book module
 * Updates both the firm_transactions record and any linked day_book entry
 */
export const updateFirmTransactionFromDayBook = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await firmTransactionModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Firm transaction not found' });

  const {
    date, particular, debit, credit, remarks,
    payment_mode, from_entity, to_entity, account_no, branch, category,
  } = req.body;

  // Update firm_transactions record
  const updNormMode = payment_mode !== undefined ? normalizeCashType(payment_mode) : undefined;
  const requestedFirmChequeNo = req.body.firm_cheque_no;
  const ftUpdate = {
    date: date || existing.date,
    description: particular !== undefined ? particular.trim().toUpperCase() : existing.description,
    debit: debit !== undefined ? (parseFloat(debit) || 0) : existing.debit,
    credit: credit !== undefined ? (parseFloat(credit) || 0) : existing.credit,
    name: req.body.firm_name !== undefined ? (req.body.firm_name ? req.body.firm_name.trim().toUpperCase() : null) : existing.name,
    purpose: req.body.firm_purpose !== undefined ? (req.body.firm_purpose ? req.body.firm_purpose.trim().toUpperCase() : null) : existing.purpose,
    remark: req.body.firm_remark !== undefined ? (req.body.firm_remark ? req.body.firm_remark.trim().toUpperCase() : null) : existing.remark,
    cheque_no: requestedFirmChequeNo !== undefined
      ? (classifyPaymentMode(updNormMode ?? existing.payment_mode) === 'cheque' && requestedFirmChequeNo
        ? requestedFirmChequeNo.trim().toUpperCase()
        : null)
      : (updNormMode !== undefined && updNormMode !== 'cheque' ? null : existing.cheque_no),
    ...(updNormMode !== undefined && {
      payment_mode: updNormMode,
      cheque_status: resolveChequeStatus({
        currentMode: existing.payment_mode,
        currentStatus: existing.cheque_status,
        nextMode: updNormMode,
      }),
    }),
  };

  const updatedFt = await firmTransactionModel.update(parseInt(id), ftUpdate, pool);

  // Also update any linked day_book entry
  const linkedDbQuery = await pool.query(
    'SELECT id FROM day_book WHERE firm_transaction_id = $1',
    [parseInt(id)]
  );
  if (linkedDbQuery.rows.length > 0) {
    const dbId = linkedDbQuery.rows[0].id;
    const dbUpdate = {
      date: date || existing.date,
      particular: particular !== undefined ? particular.trim().toUpperCase() : undefined,
      entry_type: 'FIRM TRANSACTION',
      debit: debit !== undefined ? (parseFloat(debit) || 0) : undefined,
      credit: credit !== undefined ? (parseFloat(credit) || 0) : undefined,
      remarks: remarks !== undefined ? (remarks ? remarks.trim() : null) : undefined,
      payment_mode: updNormMode !== undefined ? updNormMode.toUpperCase() : undefined,
      from_entity: from_entity !== undefined ? (from_entity ? from_entity.trim().toUpperCase() : null) : undefined,
      to_entity: to_entity !== undefined ? (to_entity ? to_entity.trim().toUpperCase() : null) : undefined,
      account_no: account_no !== undefined ? (account_no ? account_no.trim().toUpperCase() : null) : undefined,
      branch: branch !== undefined ? (branch ? branch.trim().toUpperCase() : null) : undefined,
      category: category !== undefined ? (category ? category.trim().toUpperCase() : null) : undefined,
      cheque_no: requestedFirmChequeNo !== undefined || updNormMode !== undefined ? ftUpdate.cheque_no : undefined,
      cheque_status: updNormMode !== undefined
        ? ftUpdate.cheque_status
        : undefined,
    };
    Object.keys(dbUpdate).forEach(k => dbUpdate[k] === undefined && delete dbUpdate[k]);
    await dayBookModel.update(dbId, dbUpdate, pool);
  }

  res.json({ entry: updatedFt, message: 'Firm transaction updated' });
});

/**
 * DELETE /daybook/firm-transaction/:id
 * Delete a firm transaction FROM the Day Book module
 * Deletes both the firm_transactions record and any linked day_book entry
 */
export const deleteFirmTransactionFromDayBook = asyncHandler(async (req, res) => {
  const ftId = parseInt(req.params.id);
  const existing = await firmTransactionModel.findById(ftId, pool);
  if (!existing) return res.status(404).json({ message: 'Firm transaction not found' });

  // Delete linked day_book entry first (if any)
  await pool.query('DELETE FROM day_book WHERE firm_transaction_id = $1', [ftId]);

  // Delete the firm transaction
  await firmTransactionModel.delete(ftId, pool);
  res.json({ message: 'Firm transaction deleted from Day Book and Firm Transactions' });
});

// ══════════════════════════════════════════════════
//  PLOT PAYMENT ENDPOINTS (from Day Book)
// ══════════════════════════════════════════════════

/**
 * GET /daybook/plots?site_id=X
 * List plots for the dropdown in Day Book (with payment totals)
 */
export const listPlotsForDayBook = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const plots = await plotModel.findBySiteId(parseInt(site_id), pool);
  res.json({ plots });
});

/**
 * PUT /daybook/plot-payment/:id
 * Update a plot payment FROM the Day Book module
 * Updates both the plot_payments record and any linked day_book entry
 */
export const updatePlotPaymentFromDayBook = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await plotPaymentModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Plot payment not found' });

  const {
    date, particular, debit, credit, remarks,
    payment_mode, from_entity, to_entity, account_no, branch, category,
  } = req.body;

  const ppAmount = parseFloat(credit) || parseFloat(debit) || 0;
  const ppPaymentFrom = req.body.pp_payment_from !== undefined ? (req.body.pp_payment_from ? req.body.pp_payment_from.trim().toUpperCase() : null) : existing.payment_from;
  const requestedPaymentType = req.body.pp_payment_type !== undefined
    ? req.body.pp_payment_type
    : payment_mode !== undefined
      ? payment_mode
      : existing.payment_type;
  const ppPaymentType = normalizePlotPaymentType(requestedPaymentType);
  const ppBankDetails = req.body.pp_bank_details !== undefined ? (req.body.pp_bank_details ? req.body.pp_bank_details.trim().toUpperCase() : null) : existing.bank_details;
  const ppNarration = req.body.pp_narration !== undefined ? (req.body.pp_narration ? req.body.pp_narration.trim().toUpperCase() : null) : existing.narration;
  const ppReceivedBy = req.body.pp_received_by !== undefined ? (req.body.pp_received_by ? req.body.pp_received_by.trim().toUpperCase() : null) : existing.received_by;
  const ppChequeNo = req.body.pp_cheque_no !== undefined
    ? (req.body.pp_cheque_no ? req.body.pp_cheque_no.trim().toUpperCase() : null)
    : existing.cheque_no;
  const existingWasCheque = normalizePlotPaymentType(existing.payment_type) === 'CHEQUE';
  const ppChequeStatus = ppPaymentType === 'CHEQUE'
    ? (existingWasCheque && existing.cheque_status ? existing.cheque_status : 'PENDING')
    : null;

  // Update plot_payments record
  const ppUpdate = {
    date: date || existing.date,
    payment_from: ppPaymentFrom,
    payment_type: ppPaymentType,
    bank_details: ppBankDetails,
    narration: ppNarration,
    received_by: ppReceivedBy,
    amount: ppAmount || existing.amount,
    cheque_no: ppPaymentType === 'CHEQUE' ? ppChequeNo : null,
    cheque_status: ppChequeStatus,
  };

  const updatedPp = await plotPaymentModel.update(parseInt(id), ppUpdate, pool);

  // Also update any linked day_book entry
  const linkedDbQuery = await pool.query(
    'SELECT id FROM day_book WHERE plot_payment_id = $1',
    [parseInt(id)]
  );
  if (linkedDbQuery.rows.length > 0) {
    const dbId = linkedDbQuery.rows[0].id;
    const dbUpdate = {
      date: date || existing.date,
      particular: particular !== undefined ? particular.trim().toUpperCase() : undefined,
      entry_type: 'PLOT PAYMENT',
      debit: debit !== undefined ? (parseFloat(debit) || 0) : undefined,
      credit: credit !== undefined ? (parseFloat(credit) || 0) : undefined,
      remarks: remarks !== undefined ? (remarks ? remarks.trim() : null) : undefined,
      payment_mode: ppPaymentType,
      from_entity: from_entity !== undefined ? (from_entity ? from_entity.trim().toUpperCase() : null) : undefined,
      to_entity: to_entity !== undefined ? (to_entity ? to_entity.trim().toUpperCase() : null) : undefined,
      account_no: account_no !== undefined ? (account_no ? account_no.trim().toUpperCase() : null) : undefined,
      branch: branch !== undefined ? (branch ? branch.trim().toUpperCase() : null) : undefined,
      category: category !== undefined ? (category ? category.trim().toUpperCase() : null) : undefined,
      cheque_no: ppPaymentType === 'CHEQUE' ? ppChequeNo : null,
      cheque_status: ppChequeStatus,
    };
    Object.keys(dbUpdate).forEach(k => dbUpdate[k] === undefined && delete dbUpdate[k]);
    await dayBookModel.update(dbId, dbUpdate, pool);
  }

  res.json({ entry: updatedPp, message: 'Plot payment updated' });
});

/**
 * DELETE /daybook/plot-payment/:id
 * Delete a plot payment FROM the Day Book module
 * Deletes both the plot_payments record and any linked day_book entry
 */
export const deletePlotPaymentFromDayBook = asyncHandler(async (req, res) => {
  const ppId = parseInt(req.params.id);
  const existing = await plotPaymentModel.findById(ppId, pool);
  if (!existing) return res.status(404).json({ message: 'Plot payment not found' });

  // Delete linked day_book entry first (if any)
  await pool.query('DELETE FROM day_book WHERE plot_payment_id = $1', [ppId]);

  // Delete the plot payment
  await plotPaymentModel.delete(ppId, pool);
  res.json({ message: 'Plot payment deleted from Day Book and Plot Payments' });
});

// ══════════════════════════════════════════════════
//  RECENT TRANSACTIONS (Dashboard)
// ══════════════════════════════════════════════════

/**
 * GET /daybook/recent?site_id=X&page=1&limit=10
 * Returns recent transactions across ALL modules via cash_flow_entries.
 */
export const listRecentTransactions = asyncHandler(async (req, res) => {
  const { site_id, limit = 10, page = 1 } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const lim = Math.min(parseInt(limit) || 10, 50);
  const pg = Math.max(parseInt(page) || 1, 1);
  const offset = (pg - 1) * lim;
  const siteId = parseInt(site_id);

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM cash_flow_entries
     WHERE site_id = $1
       AND COALESCE(source_module, '') <> 'plot_registry_payments'
       AND COALESCE(source_module, '') NOT LIKE '%\\_person'`,
    [siteId]
  );
  const total = countResult.rows[0].total;

  const result = await pool.query(
    `SELECT cfe.id, cfe.date, cfe.particular, cfe.debit, cfe.credit, cfe.cash_type,
            cfe.remarks, cfe.status, cfe.source_module, cfe.source_id,
            cfe.voucher_url, cfe.created_at, cfe.cheque_status, cfe.cheque_no,
            COALESCE(u.name, u.email) AS created_by_name,
            CASE
              WHEN cfe.source_module = 'plot_payments' THEN pl.plot_no
              WHEN cfe.source_module = 'plot_installment_payments' THEN pli.plot_no
              ELSE NULL
            END AS plot_no,
            CASE
              WHEN cfe.source_module = 'plot_payments' THEN COALESCE(pp.buyer_name, pl.buyer_name)
              WHEN cfe.source_module = 'plot_installment_payments' THEN pli.buyer_name
              ELSE NULL
            END AS buyer_name,
            CASE
              WHEN cfe.source_module = 'plot_payments' THEN pp.booked_by
              ELSE NULL
            END AS booked_by
     FROM cash_flow_entries cfe
     LEFT JOIN users u ON cfe.created_by = u.id
     LEFT JOIN plot_payments pp ON cfe.source_module = 'plot_payments' AND cfe.source_id = pp.id
     LEFT JOIN plots pl ON pp.plot_id = pl.id
     LEFT JOIN plot_installment_payments pip ON cfe.source_module = 'plot_installment_payments' AND cfe.source_id = pip.id
     LEFT JOIN plots pli ON pip.plot_id = pli.id
     WHERE cfe.site_id = $1
       AND COALESCE(cfe.source_module, '') <> 'plot_registry_payments'
       AND COALESCE(cfe.source_module, '') NOT LIKE '%\\_person'
     ORDER BY cfe.date DESC, cfe.created_at DESC
     LIMIT $2 OFFSET $3`,
    [siteId, lim, offset]
  );

  res.json({
    transactions: result.rows,
    pagination: {
      totalItems: total,
      totalPages: Math.ceil(total / lim),
      currentPage: pg,
    },
  });
});

// ══════════════════════════════════════════════════
//  DATA VERIFY — cross-checks source tables vs cash_flow_entries
// ══════════════════════════════════════════════════

/**
 * GET /daybook/verify-data?site_id=X
 * Compares each module's source table against cash_flow_entries to surface mismatches.
 */
export const verifyData = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const siteId = parseInt(site_id);

  const cf = "UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED') AND LOWER(COALESCE(status, 'approved')) = 'approved'";

  const modules = [];

  // Plot Payments (earn)
  const pp = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount),0)::numeric AS total FROM plot_payments WHERE site_id = $1 AND ${cf}`, [siteId]);
  const ppI = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(pip.amount),0)::numeric AS total FROM plot_installment_payments pip JOIN plots p ON p.id = pip.plot_id WHERE p.site_id = $1 AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')`, [siteId]);
  const ppC = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(credit),0)::numeric AS total FROM cash_flow_entries WHERE site_id = $1 AND source_module = 'plot_payments' AND ${cf}`, [siteId]);
  const ppIC = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(credit),0)::numeric AS total FROM cash_flow_entries WHERE site_id = $1 AND source_module = 'plot_installment_payments' AND ${cf}`, [siteId]);
  modules.push({ module: 'Plot Payments', sourceTotal: parseFloat(pp.rows[0].total) + parseFloat(ppI.rows[0].total), sourceCount: parseInt(pp.rows[0].cnt) + parseInt(ppI.rows[0].cnt), cfeTotal: parseFloat(ppC.rows[0].total) + parseFloat(ppIC.rows[0].total), cfeCount: parseInt(ppC.rows[0].cnt) + parseInt(ppIC.rows[0].cnt), type: 'earn' });

  // Farmer Payments
  const fp = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(fp.amount),0)::numeric AS total FROM farmer_payments fp JOIN farmers f ON f.id = fp.farmer_id WHERE f.site_id = $1 AND UPPER(COALESCE(fp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED') AND LOWER(COALESCE(fp.status, 'approved')) = 'approved'`, [siteId]);
  const fpC = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(debit),0)::numeric AS total FROM cash_flow_entries WHERE site_id = $1 AND source_module = 'farmer_payments' AND ${cf}`, [siteId]);
  const fpD = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(debit),0)::numeric AS total FROM day_book WHERE site_id = $1 AND entry_type = 'FARMER PAYMENT' AND ${cf}`, [siteId]);
  modules.push({ module: 'Farmer Payments', sourceTotal: parseFloat(fp.rows[0].total), sourceCount: parseInt(fp.rows[0].cnt), cfeTotal: parseFloat(fpC.rows[0].total), cfeCount: parseInt(fpC.rows[0].cnt), daybookTotal: parseFloat(fpD.rows[0].total), daybookCount: parseInt(fpD.rows[0].cnt), type: 'expense' });

  // Expenses
  const ex = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(debit),0)::numeric AS total FROM expenses WHERE site_id = $1 AND ${cf}`, [siteId]);
  const exC = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(debit),0)::numeric AS total FROM cash_flow_entries WHERE site_id = $1 AND source_module = 'expenses' AND ${cf}`, [siteId]);
  modules.push({ module: 'Expenses', sourceTotal: parseFloat(ex.rows[0].total), sourceCount: parseInt(ex.rows[0].cnt), cfeTotal: parseFloat(exC.rows[0].total), cfeCount: parseInt(exC.rows[0].cnt), type: 'expense' });

  // Plot Commissions
  const pc = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount),0)::numeric AS total FROM plot_commissions WHERE site_id = $1 AND ${cf}`, [siteId]);
  const pcC = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(debit),0)::numeric AS total FROM cash_flow_entries WHERE site_id = $1 AND source_module = 'plot_commissions' AND ${cf}`, [siteId]);
  modules.push({ module: 'Plot Commissions', sourceTotal: parseFloat(pc.rows[0].total), sourceCount: parseInt(pc.rows[0].cnt), cfeTotal: parseFloat(pcC.rows[0].total), cfeCount: parseInt(pcC.rows[0].cnt), type: 'expense' });

  // Commission Payments
  const pcp = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount),0)::numeric AS total FROM plot_commission_payments WHERE site_id = $1 AND ${cf}`, [siteId]);
  const pcpC = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(debit),0)::numeric AS total FROM cash_flow_entries WHERE site_id = $1 AND source_module = 'plot_commission_payments' AND ${cf}`, [siteId]);
  modules.push({ module: 'Commission Payments', sourceTotal: parseFloat(pcp.rows[0].total), sourceCount: parseInt(pcp.rows[0].cnt), cfeTotal: parseFloat(pcpC.rows[0].total), cfeCount: parseInt(pcpC.rows[0].cnt), type: 'expense' });

  // Vendor Payments
  const vp = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount),0)::numeric AS total FROM vendor_payments WHERE site_id = $1 AND ${cf}`, [siteId]);
  const vpC = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(debit),0)::numeric AS total FROM cash_flow_entries WHERE site_id = $1 AND source_module = 'vendor_payments' AND ${cf}`, [siteId]);
  modules.push({ module: 'Vendor Payments', sourceTotal: parseFloat(vp.rows[0].total), sourceCount: parseInt(vp.rows[0].cnt), cfeTotal: parseFloat(vpC.rows[0].total), cfeCount: parseInt(vpC.rows[0].cnt), type: 'expense' });

  // Registry mappings must never create financial ledger rows. Keep this as a
  // zero-invariant check rather than comparing their mapped record amounts.
  const prpC = await pool.query(
    `SELECT COUNT(*)::int AS cnt,
            COALESCE(SUM(ABS(COALESCE(debit, 0)) + ABS(COALESCE(credit, 0))), 0)::numeric AS total
     FROM cash_flow_entries
     WHERE site_id = $1 AND source_module LIKE 'plot_registry_payments%'`,
    [siteId]
  );
  modules.push({ module: 'Registry financial rows (must be zero)', sourceTotal: 0, sourceCount: 0, cfeTotal: parseFloat(prpC.rows[0].total), cfeCount: parseInt(prpC.rows[0].cnt), type: 'invariant' });

  // Firm Transactions
  const ft = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(debit),0)::numeric AS td, COALESCE(SUM(credit),0)::numeric AS tc FROM firm_transactions ft JOIN firms f ON f.id = ft.firm_id WHERE f.site_id = $1 AND UPPER(COALESCE(ft.cheque_status, '')) NOT IN ('BOUNCED','RETURNED') AND LOWER(COALESCE(ft.status, 'approved')) = 'approved'`, [siteId]);
  const ftC = await pool.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(debit),0)::numeric AS td, COALESCE(SUM(credit),0)::numeric AS tc FROM cash_flow_entries WHERE site_id = $1 AND source_module = 'firm_transactions' AND ${cf}`, [siteId]);
  modules.push({ module: 'Firm Transactions', sourceTotal: parseFloat(ft.rows[0].td) + parseFloat(ft.rows[0].tc), sourceCount: parseInt(ft.rows[0].cnt), cfeTotal: parseFloat(ftC.rows[0].td) + parseFloat(ftC.rows[0].tc), cfeCount: parseInt(ftC.rows[0].cnt), type: 'ledger' });

  for (const m of modules) {
    m.match = Math.abs(m.sourceTotal - m.cfeTotal) < 1 && m.sourceCount === m.cfeCount;
    m.diff = m.sourceTotal - m.cfeTotal;
    m.countDiff = m.sourceCount - m.cfeCount;
  }

  res.json({ modules });
});

// ══════════════════════════════════════════════════
//  PROFIT SUMMARY — queries source tables directly
// ══════════════════════════════════════════════════

/**
 * GET /daybook/profit-summary?site_id=X
 * Returns profit breakdown:
 *   Earn   = plot_payments credit (money received from buyers)
 *   Expenses = farmer_payments + expenses + plot_commissions + plot_commission_payments + vendor_payments
 * Excludes: firm_transactions, day_book (personal ledger / cashflow), imprest
 *
 * Also returns ledger flow (non-profit entries: day_book, firm_transactions, direct cashflow)
 * and currentBalance = profit + ledgerCredit - ledgerDebit
 *
 * Queries source tables directly (not cash_flow_entries) so numbers always match module pages.
 */
export const getProfitSummary = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const siteId = parseInt(site_id);

  // ── Earn / Expense — sourced from the canonical kpi.service.js formula
  // (same one the Dashboard's live KPI cards use) instead of re-deriving the
  // revenue/expense SQL here. This endpoint reports an all-time running total,
  // so it calls the canonical functions with wide date bounds. ──
  const [totalEarn, expData] = await Promise.all([
    getRevenue(siteId, ALL_TIME_START, ALL_TIME_END),
    getExpenseBreakdown(siteId, ALL_TIME_START, ALL_TIME_END),
  ]);
  const totalExpense = expData.total;

  // Reshape the canonical breakdown into this endpoint's existing byModule
  // keys — 'commissions' (not 'plot_commissions') and 'daybook_expense' rows
  // folded into 'expenses', matching the shape this endpoint returned before.
  const byModule = { plot_payments: { credit: totalEarn, debit: 0 } };
  const moduleKeyMap = { plot_commissions: 'commissions', daybook_expense: 'expenses' };
  for (const [sourceType, { debit }] of Object.entries(expData.breakdown)) {
    const key = moduleKeyMap[sourceType] || sourceType;
    if (!byModule[key]) byModule[key] = { credit: 0, debit: 0 };
    byModule[key].debit += debit;
  }

  const profit = getProfit(totalEarn, totalExpense);

  // ── Ledger flow: non-profit entries, separated by site vs person ledger_type ──
  const profitModules = [
    'plot_payments', 'farmer_payments', 'expenses',
    'plot_commissions', 'plot_commission_payments', 'vendor_payments',
    'plot_installment_payments',
  ];

  const ledgerResult = await pool.query(
    `SELECT
       COALESCE(cfe.source_module, 'direct') AS ledger_source,
       cfm.ledger_type,
       COALESCE(SUM(cfe.credit), 0)::numeric AS total_credit,
       COALESCE(SUM(cfe.debit),  0)::numeric AS total_debit
     FROM cash_flow_entries cfe
     JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
     WHERE cfe.site_id = $1
       AND (cfe.source_module IS NULL OR cfe.source_module NOT IN (${profitModules.map((_, i) => `$${i + 2}`).join(', ')}))
       AND COALESCE(cfe.source_module, '') NOT LIKE '%\\_person'
       AND COALESCE(cfe.source_module, '') <> 'plot_registry_payments'
       AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
       AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'
     GROUP BY COALESCE(cfe.source_module, 'direct'), cfm.ledger_type`,
    [siteId, ...profitModules]
  );

  let ledgerCredit = 0;
  let ledgerDebit = 0;
  const ledgerBreakdown = {};

  // Person ledger totals (separate from site ledger flow)
  let personGiven = 0;   // debit = money given to person
  let personReturned = 0; // credit = money returned by person

  for (const row of ledgerResult.rows) {
    const credit = parseFloat(row.total_credit) || 0;
    const debit  = parseFloat(row.total_debit)  || 0;

    if (row.ledger_type === 'person') {
      personGiven += debit;
      personReturned += credit;
    } else if (row.ledger_source === 'firm_transactions') {
      // Skip — firm totals handled by separate query below
    } else {
      // Site ledger entries — include in main ledger flow & balance
      ledgerCredit += credit;
      ledgerDebit  += debit;
      const key = row.ledger_source;
      if (!ledgerBreakdown[key]) ledgerBreakdown[key] = { credit: 0, debit: 0 };
      ledgerBreakdown[key].credit += credit;
      ledgerBreakdown[key].debit  += debit;
    }
  }

  // ── Firm transactions: match the Firm Transactions module page logic ──
  // Sums from firm_transactions table + cash_flow_entries with is_firm_transaction=true
  const firmResult = await pool.query(
    `SELECT
       COALESCE((SELECT SUM(ft.debit) FROM firm_transactions ft JOIN firms f ON f.id = ft.firm_id
                 WHERE f.site_id = $1
                   AND UPPER(COALESCE(ft.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
                   AND LOWER(COALESCE(ft.status, 'approved')) = 'approved'), 0)
       + COALESCE((SELECT SUM(COALESCE(cfe.debit,0) + COALESCE(cfe.credit,0))
                   FROM cash_flow_entries cfe JOIN firms f ON f.id = cfe.from_firm_id
                   WHERE f.site_id = $1 AND cfe.is_firm_transaction = true
                   AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
                   AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'), 0)
       AS total_debit,
       COALESCE((SELECT SUM(ft.credit) FROM firm_transactions ft JOIN firms f ON f.id = ft.firm_id
                 WHERE f.site_id = $1
                   AND UPPER(COALESCE(ft.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
                   AND LOWER(COALESCE(ft.status, 'approved')) = 'approved'), 0)
       + COALESCE((SELECT SUM(COALESCE(cfe.debit,0) + COALESCE(cfe.credit,0))
                   FROM cash_flow_entries cfe JOIN firms f ON f.id = cfe.to_firm_id
                   WHERE f.site_id = $1 AND cfe.is_firm_transaction = true
                   AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
                   AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'), 0)
       AS total_credit`,
    [siteId]
  );
  const firmDebit  = parseFloat(firmResult.rows[0].total_debit)  || 0;
  const firmCredit = parseFloat(firmResult.rows[0].total_credit) || 0;

  const personPending = personGiven - personReturned;
  const canonicalBalance = await siteBalanceAsOf(siteId, addIsoDays(dateInIndia(), 1), pool);

  res.json({
    earn: totalEarn,
    expense: totalExpense,
    profit,
    breakdown: byModule,
    ledgerCredit,
    ledgerDebit,
    ledgerNet: ledgerCredit - ledgerDebit,
    ledgerBreakdown,
    firmCredit,
    firmDebit,
    firmNet: firmCredit - firmDebit,
    personGiven,
    personReturned,
    personPending,
    // Keep the legacy profit fields for API compatibility, but the balance is
    // the same posted-ledger balance used everywhere else.
    currentBalance: canonicalBalance,
  });
});

/**
 * GET /daybook/profit-monthly?site_id=X
 * Returns last 12 months of earning (plot payments) and expense totals.
 */
export const getProfitMonthly = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const siteId = parseInt(site_id);

  const result = await pool.query(
    `WITH first_date AS (
       SELECT COALESCE(MIN(d), CURRENT_DATE)::date AS d
       FROM (
         SELECT MIN(pp.date)::date AS d FROM plot_payments pp WHERE pp.site_id = $1
         UNION ALL
         SELECT MIN(pip.payment_date)::date FROM plot_installment_payments pip
           JOIN plots p ON p.id = pip.plot_id WHERE p.site_id = $1
         UNION ALL
         SELECT MIN(fp.date)::date FROM farmer_payments fp
           JOIN farmers f ON f.id = fp.farmer_id WHERE f.site_id = $1
         UNION ALL
         SELECT MIN(e.date)::date FROM expenses e WHERE e.site_id = $1
         UNION ALL
         SELECT MIN(pc.date)::date FROM plot_commissions pc WHERE pc.site_id = $1
         UNION ALL
         SELECT MIN(pcp.date)::date FROM plot_commission_payments pcp WHERE pcp.site_id = $1
         UNION ALL
         SELECT MIN(vp.payment_date)::date FROM vendor_payments vp WHERE vp.site_id = $1
         UNION ALL
         SELECT MIN(db.date)::date FROM day_book db
          WHERE db.site_id = $1
            AND UPPER(COALESCE(db.entry_type, '')) = 'EXPENSE'
            AND db.farmer_payment_id IS NULL
            AND db.commission_id IS NULL
            AND db.vendor_payment_id IS NULL
       ) source_dates
     ),
     months AS (
       SELECT to_char(g, 'YYYY-MM') AS m, to_char(g, 'Mon YY') AS label
       FROM first_date,
            generate_series(
              date_trunc('month', first_date.d),
              date_trunc('month', now()),
              '1 month'
            ) g
     ),
     earn AS (
       SELECT to_char(date, 'YYYY-MM') AS m, COALESCE(SUM(amount), 0)::numeric AS total
       FROM (
         SELECT date, amount FROM plot_payments
         WHERE site_id = $1
           AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
           AND LOWER(COALESCE(status, 'approved')) = 'approved'
         UNION ALL
         SELECT pip.payment_date AS date, pip.amount FROM plot_installment_payments pip
         JOIN plots p ON p.id = pip.plot_id
         WHERE p.site_id = $1
           AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
       ) u
       GROUP BY 1
     ),
     exp AS (
       SELECT to_char(date, 'YYYY-MM') AS m, COALESCE(SUM(debit), 0)::numeric AS total
       FROM (
         SELECT fp.date, fp.amount AS debit FROM farmer_payments fp
         JOIN farmers f ON f.id = fp.farmer_id
         WHERE f.site_id = $1
           AND UPPER(COALESCE(fp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
           AND LOWER(COALESCE(fp.status, 'approved')) = 'approved'
         UNION ALL
         SELECT date, COALESCE(debit, 0) - COALESCE(credit, 0) AS debit
         FROM expenses
         WHERE site_id = $1
           AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
           AND LOWER(COALESCE(status, 'approved')) = 'approved'
         UNION ALL
         SELECT date, amount AS debit FROM plot_commissions
         WHERE site_id = $1
           AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
           AND LOWER(COALESCE(status, 'approved')) = 'approved'
         UNION ALL
         SELECT date, amount AS debit FROM plot_commission_payments
         WHERE site_id = $1
           AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
           AND LOWER(COALESCE(status, 'approved')) = 'approved'
         UNION ALL
         SELECT payment_date AS date, amount AS debit FROM vendor_payments
         WHERE site_id = $1
           AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
           AND LOWER(COALESCE(status, 'approved')) = 'approved'
         UNION ALL
         SELECT date, COALESCE(debit, 0) - COALESCE(credit, 0) AS debit
         FROM day_book
         WHERE site_id = $1
           AND UPPER(COALESCE(entry_type, '')) = 'EXPENSE'
           AND farmer_payment_id IS NULL
           AND commission_id IS NULL
           AND vendor_payment_id IS NULL
           AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
           AND LOWER(COALESCE(status, 'approved')) = 'approved'
       ) u
       GROUP BY 1
     )
     SELECT months.m, months.label,
            COALESCE(earn.total, 0) AS earning,
            COALESCE(exp.total, 0)  AS expense
     FROM months
     LEFT JOIN earn ON earn.m = months.m
     LEFT JOIN exp  ON exp.m  = months.m
     ORDER BY months.m`,
    [siteId]
  );

  res.json({ months: result.rows });
});

/* ── Latest date with data (for auto-jump on site change) ── */
export const getLatestDate = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const siteId = parseInt(site_id);

  const result = await pool.query(
    `SELECT MAX(d)::text AS latest_date FROM (
       SELECT MAX(date::date) AS d FROM day_book WHERE site_id = $1
       UNION ALL
       SELECT MAX(date::date) FROM expenses WHERE site_id = $1
       UNION ALL
       SELECT MAX(fp.date::date) FROM farmer_payments fp JOIN farmers f ON fp.farmer_id = f.id WHERE f.site_id = $1
       UNION ALL
       SELECT MAX(date::date) FROM plot_commissions WHERE site_id = $1
       UNION ALL
       SELECT MAX(date::date) FROM cash_flow_entries
       WHERE site_id = $1
         AND COALESCE(source_module, '') <> 'plot_registry_payments'
         AND COALESCE(source_module, '') NOT LIKE '%\\_person'
       UNION ALL
       SELECT MAX(date::date) FROM firm_transactions WHERE site_id = $1
       UNION ALL
       SELECT MAX(date::date) FROM plot_payments WHERE site_id = $1
       UNION ALL
       SELECT MAX(payment_date::date) FROM vendor_payments WHERE site_id = $1
       UNION ALL
       SELECT MAX(date::date) FROM plot_commission_payments WHERE site_id = $1
       UNION ALL
       SELECT MAX(pip.payment_date::date) FROM plot_installment_payments pip JOIN plots p ON p.id = pip.plot_id WHERE p.site_id = $1
     ) sub`,
    [siteId]
  );

  const latestDate = result.rows[0]?.latest_date || null;
  res.json({ latest_date: latestDate || null });
});

// ══════════════════════════════════════════════════
//  GENERIC MODULE PAYMENT ENDPOINTS (from Day Book)
//  vendor_payments / plot_commission_payments /
//  plot_installment_payments
//  Whitelisted columns only; cash_flow_entries stays in
//  sync via the module triggers.
// ══════════════════════════════════════════════════
const DAYBOOK_MODULE_TABLES = {
  'vendor-payment':      { table: 'vendor_payments',           dateCol: 'payment_date', modeCol: 'payment_mode', remarksCol: 'note',    lowerMode: true },
  'commission-payment':  { table: 'plot_commission_payments',  dateCol: 'date',         modeCol: 'payment_mode', remarksCol: 'remarks' },
  'installment-payment': { table: 'plot_installment_payments', dateCol: 'payment_date', modeCol: 'payment_mode', remarksCol: 'notes' },
};

export const updateModulePaymentFromDayBook = asyncHandler(async (req, res) => {
  const cfg = DAYBOOK_MODULE_TABLES[req.params.module];
  if (!cfg) return res.status(400).json({ message: `Unknown module: ${req.params.module}` });
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid id' });

  const { date, debit, credit, payment_mode, remarks, cheque_no } = req.body;
  const amount = (parseFloat(debit) || 0) || (parseFloat(credit) || 0);

  const currentResult = await pool.query(
    `SELECT ${cfg.modeCol} AS payment_mode, cheque_status, cheque_no
       FROM ${cfg.table}
      WHERE id = $1`,
    [id]
  );
  const current = currentResult.rows[0];
  if (!current) return res.status(404).json({ message: 'Entry not found' });

  const sets = [];
  const params = [];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (date) add(cfg.dateCol, date);
  if (amount > 0) add('amount', amount);
  let nextModeBucket;
  if (payment_mode !== undefined) {
    const rawMode = String(payment_mode ?? '').trim() || 'BANK';
    nextModeBucket = classifyPaymentMode(rawMode);
    add(cfg.modeCol, cfg.lowerMode ? rawMode.toLowerCase() : rawMode.toUpperCase());
    add('cheque_status', resolveChequeStatus({
      currentMode: current.payment_mode,
      currentStatus: current.cheque_status,
      nextMode: rawMode,
    }));
  }
  if (remarks !== undefined) add(cfg.remarksCol, remarks ? String(remarks).trim() : null);
  if (cheque_no !== undefined || (nextModeBucket !== undefined && nextModeBucket !== 'cheque')) {
    const effectiveBucket = nextModeBucket ?? classifyPaymentMode(current.payment_mode);
    add('cheque_no', effectiveBucket === 'cheque' && cheque_no
      ? String(cheque_no).trim()
      : null);
  } else if (nextModeBucket === 'cheque' && classifyPaymentMode(current.payment_mode) !== 'cheque') {
    add('cheque_no', null);
  }
  if (sets.length === 0) return res.status(400).json({ message: 'Nothing to update' });

  params.push(id);
  const result = await pool.query(
    `UPDATE ${cfg.table} SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  res.json({ entry: result.rows[0] });
});

export const deleteModulePaymentFromDayBook = asyncHandler(async (req, res) => {
  const cfg = DAYBOOK_MODULE_TABLES[req.params.module];
  if (!cfg) return res.status(400).json({ message: `Unknown module: ${req.params.module}` });
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid id' });

  const result = await pool.query(`DELETE FROM ${cfg.table} WHERE id = $1 RETURNING id`, [id]);
  if (!result.rows[0]) return res.status(404).json({ message: 'Entry not found' });
  res.json({ message: 'Entry deleted' });
});
