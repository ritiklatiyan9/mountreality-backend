import asyncHandler from '../utils/asyncHandler.js';
import plotCommissionModel from '../models/PlotCommission.model.js';
import { dayBookModel } from '../models/DayBook.model.js';
import pool from '../config/db.js';
import { classifyPaymentMode } from '../utils/paymentMode.js';

const normalizePaymentMode = (raw) => String(raw || 'BANK').trim().toUpperCase() || 'BANK';

const resolveChequeStatus = ({ currentMode, currentStatus, nextMode, requestedStatus }) => {
  if (classifyPaymentMode(nextMode) !== 'cheque') return null;

  // Entering the cheque lifecycle always starts at PENDING. A stale status
  // from a former non-cheque mode must never make a new cheque look cleared.
  if (classifyPaymentMode(currentMode) !== 'cheque') return 'PENDING';

  if (requestedStatus !== undefined) {
    return requestedStatus ? String(requestedStatus).trim().toUpperCase() : 'PENDING';
  }
  return currentStatus ? String(currentStatus).trim().toUpperCase() : 'PENDING';
};

/**
 * POST /commissions
 * Create a new commission entry
 */
export const createCommission = asyncHandler(async (req, res) => {
  const { site_id, date, particular, father_name, plot_no, plot_size, plot_rate, amount, by_note, payment_mode, remarks, voucher_url, assigned_admin_id, cheque_no } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  if (!particular) return res.status(400).json({ message: 'Particular (person name) is required' });

  const commissionPaymentMode = normalizePaymentMode(payment_mode || by_note);
  const isCheque = classifyPaymentMode(commissionPaymentMode) === 'cheque';
  const data = {
    site_id: parseInt(site_id),
    date: date || new Date().toISOString().split('T')[0],
    particular: particular.trim().toUpperCase(),
    father_name: father_name ? father_name.trim().toUpperCase() : null,
    plot_no: plot_no ? plot_no.trim().toUpperCase() : null,
    plot_size: plot_size ? plot_size.trim().toUpperCase() : null,
    plot_rate: plot_rate ? plot_rate.trim().toUpperCase() : null,
    amount: parseFloat(amount) || 0,
    by_note: by_note ? by_note.trim() : null,
    payment_mode: commissionPaymentMode,
    cheque_no: isCheque && cheque_no ? String(cheque_no).trim() : null,
    cheque_status: isCheque ? 'PENDING' : null,
    remarks: remarks ? remarks.trim() : null,
    created_by: req.user.id,
    voucher_url: voucher_url || null,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    status: 'pending',
  };

  const commission = await plotCommissionModel.create(data, pool);

  // ── Auto-create DayBook entry for expense integration ──
  const commissionAmount = parseFloat(amount) || 0;
  if (commissionAmount > 0) {
    const plotInfo = plot_no ? ` (Plot: ${plot_no.trim().toUpperCase()})` : '';
    await dayBookModel.create({
      site_id: parseInt(site_id),
      date: data.date,
      particular: `${data.particular}${plotInfo} - COMMISSION`.toUpperCase(),
      entry_type: 'PLOT COMMISSION',
      debit: commissionAmount,
      credit: 0,
      remarks: remarks ? remarks.trim() : null,
      payment_mode: commissionPaymentMode,
      cheque_no: data.cheque_no,
      cheque_status: data.cheque_status,
      category: 'COMMISSION',
      from_entity: null,
      to_entity: data.particular,
      created_by: req.user.id,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
      commission_id: commission.id,
      status: data.status,
    }, pool);
  }

  res.status(201).json({ commission });
});

/**
 * GET /commissions?site_id=X
 * List all commission entries for a site + summary
 */
export const listCommissions = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id query param is required' });

  const siteId = parseInt(site_id);
  const [commissions, summary, persons] = await Promise.all([
    plotCommissionModel.findBySiteId(siteId, pool),
    plotCommissionModel.getSummary(siteId, pool),
    plotCommissionModel.getPersonSummary(siteId, pool),
  ]);

  res.json({ commissions, summary, persons });
});

/**
 * GET /commissions/autocomplete?site_id=X
 * Get unique particulars and plots for autocomplete
 */
export const getAutocomplete = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const siteId = parseInt(site_id);
  const [particulars, plots] = await Promise.all([
    plotCommissionModel.getUniqueParticulars(siteId, pool),
    plotCommissionModel.getUniquePlots(siteId, pool),
  ]);

  res.json({ particulars, plots });
});

/**
 * GET /commissions/:id
 * Get single commission
 */
export const getCommission = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const commission = await plotCommissionModel.findById(parseInt(id), pool);
  if (!commission) return res.status(404).json({ message: 'Commission entry not found' });
  res.json({ commission });
});

/**
 * PUT /commissions/:id
 * Update a commission entry
 */
export const updateCommission = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { date, particular, father_name, plot_no, plot_size, plot_rate, amount, by_note, payment_mode, remarks, voucher_url, cheque_no, cheque_status } = req.body;

  const existing = await plotCommissionModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Commission entry not found' });

  const updateData = {};
  if (date !== undefined) updateData.date = date;
  if (particular !== undefined) updateData.particular = particular.trim().toUpperCase();
  if (father_name !== undefined) updateData.father_name = father_name ? father_name.trim().toUpperCase() : null;
  if (plot_no !== undefined) updateData.plot_no = plot_no ? plot_no.trim().toUpperCase() : null;
  if (plot_size !== undefined) updateData.plot_size = plot_size ? plot_size.trim().toUpperCase() : null;
  if (plot_rate !== undefined) updateData.plot_rate = plot_rate ? plot_rate.trim().toUpperCase() : null;
  if (amount !== undefined) updateData.amount = parseFloat(amount) || 0;
  if (by_note !== undefined) updateData.by_note = by_note ? by_note.trim() : null;
  if (remarks !== undefined) updateData.remarks = remarks ? remarks.trim() : null;
  if (voucher_url !== undefined) updateData.voucher_url = voucher_url || null;

  const currentPaymentMode = normalizePaymentMode(existing.payment_mode || existing.by_note);
  const nextPaymentMode = payment_mode !== undefined
    ? normalizePaymentMode(payment_mode)
    : currentPaymentMode;
  const currentIsCheque = classifyPaymentMode(currentPaymentMode) === 'cheque';
  const nextIsCheque = classifyPaymentMode(nextPaymentMode) === 'cheque';

  if (payment_mode !== undefined) {
    updateData.payment_mode = nextPaymentMode;
    updateData.cheque_status = resolveChequeStatus({
      currentMode: currentPaymentMode,
      currentStatus: existing.cheque_status,
      nextMode: nextPaymentMode,
      requestedStatus: cheque_status,
    });
    updateData.cheque_no = nextIsCheque
      ? (cheque_no !== undefined
          ? (cheque_no ? String(cheque_no).trim() : null)
          : (currentIsCheque ? existing.cheque_no || null : null))
      : null;
  } else {
    if (cheque_no !== undefined) {
      updateData.cheque_no = nextIsCheque && cheque_no ? String(cheque_no).trim() : null;
    }
    if (cheque_status !== undefined) {
      updateData.cheque_status = resolveChequeStatus({
        currentMode: currentPaymentMode,
        currentStatus: existing.cheque_status,
        nextMode: nextPaymentMode,
        requestedStatus: cheque_status,
      });
    }
  }

  const updated = await plotCommissionModel.update(parseInt(id), updateData, pool);

  // ── Sync DayBook entry ──
  try {
    const dayBookResult = await pool.query(
      `SELECT id FROM day_book WHERE commission_id = $1 LIMIT 1`,
      [parseInt(id)]
    );
    if (dayBookResult.rows.length > 0) {
      const dbId = dayBookResult.rows[0].id;
      const plotInfo = updated.plot_no ? ` (Plot: ${updated.plot_no})` : '';
      await dayBookModel.update(dbId, {
        date: updated.date,
        particular: `${updated.particular}${plotInfo} - COMMISSION`.toUpperCase(),
        debit: parseFloat(updated.amount) || 0,
        remarks: updated.remarks || null,
        payment_mode: updated.payment_mode || 'BANK',
        cheque_no: updated.cheque_no || null,
        cheque_status: updated.cheque_status || null,
        status: updated.status || 'pending',
        to_entity: updated.particular,
      }, pool);
    }
  } catch (err) {
    console.error('[Commission] Failed to sync DayBook entry:', err.message);
  }

  res.json({ commission: updated });
});

/**
 * DELETE /commissions/:id
 * Delete a commission entry
 */
export const deleteCommission = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await plotCommissionModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Commission entry not found' });

  // ── Delete linked DayBook entry first ──
  try {
    await pool.query(`DELETE FROM day_book WHERE commission_id = $1`, [parseInt(id)]);
  } catch (err) {
    console.error('[Commission] Failed to delete DayBook entry:', err.message);
  }

  await plotCommissionModel.delete(parseInt(id), pool);
  res.json({ message: 'Commission entry deleted' });
});
