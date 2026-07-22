import asyncHandler from '../utils/asyncHandler.js';
import { plotModel, plotPaymentModel } from '../models/Plot.model.js';
import pool from '../config/db.js';
import { buildVerifyUrl, ReceiptType } from '../utils/receiptToken.js';
import { notifyPlotPaymentRecorded } from '../utils/notify.js';
import { normalizeCashType } from '../utils/paymentMode.js';

const normalizePlotPaymentType = (paymentType) => {
  // payment_type is the accounting settlement field. payment_from describes
  // the collection context (BOOKING, REFUND, etc.) and must never move a row
  // between Cash and Bank. Blank/unknown types safely fall into Bank.
  const bucket = normalizeCashType(paymentType);
  return bucket === 'cash' ? 'CASH' : bucket === 'cheque' ? 'CHEQUE' : 'BANK';
};

const resolveChequeStatus = ({ currentType, currentStatus, nextType, requestedStatus }) => {
  if (nextType !== 'CHEQUE') return null;
  if (requestedStatus !== undefined) {
    return requestedStatus ? String(requestedStatus).trim().toUpperCase() : 'PENDING';
  }
  return normalizePlotPaymentType(currentType) === 'CHEQUE'
    ? (currentStatus || 'PENDING')
    : 'PENDING';
};

const todayInIndia = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

/**
 * Auto-check BOOKED plots with free_to_sale_days set.
 * If any installment is overdue beyond grace_period + free_to_sale_days,
 * move the plot to UNDER CANCELLATION.
 *
 * Previously: information_schema lookup on every call + N candidate plots,
 * each running 2 serial queries (installments + total_received). With 50
 * eligible plots this was 100+ serial round-trips on every /plots GET.
 *
 * Now:
 *   1. Schema check is memoized at module load.
 *   2. Candidates + their installments + total_received fetched in 2
 *      parallel batched queries (no per-plot round-trip).
 *   3. Cancellation UPDATEs run in a single bulk statement.
 */
let _hasGracePeriodCol = null;
const _resolveGracePeriodCol = async () => {
  if (_hasGracePeriodCol !== null) return _hasGracePeriodCol;
  try {
    const { rows } = await pool.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'plots' AND column_name = 'grace_period_days'
      ) AS has_col`
    );
    _hasGracePeriodCol = !!rows[0]?.has_col;
  } catch {
    _hasGracePeriodCol = false;
  }
  return _hasGracePeriodCol;
};

const checkFreeToSaleStatus = async (siteId) => {
  try {
    const hasGracePeriod = await _resolveGracePeriodCol();

    // Step 1: candidates + their installments + total_received in TWO
    // queries running in parallel — replaces the per-plot N+1 loop.
    const selectCols = hasGracePeriod
      ? `p.id, p.status, p.grace_period_days, p.free_to_sale_days`
      : `p.id, p.status, p.free_to_sale_days`;

    const candidatesPromise = pool.query(`
      SELECT ${selectCols}
        FROM plots p
       WHERE p.site_id = $1
         AND p.installments_enabled = TRUE
         AND p.free_to_sale_days > 0
         AND p.status NOT IN ('UNDER CANCELLATION', 'CANCELLED', 'RESALE', 'TRANSFERRED', 'COMPANY')
    `, [siteId]);

    const installmentsAggPromise = pool.query(`
      SELECT plot_id,
             json_agg(json_build_object('amount', amount, 'due_date', due_date)
                      ORDER BY sort_order ASC, due_date ASC) AS installments
        FROM plot_installments
       WHERE plot_id IN (
         SELECT id FROM plots
          WHERE site_id = $1
            AND installments_enabled = TRUE
            AND free_to_sale_days > 0
            AND status NOT IN ('UNDER CANCELLATION', 'CANCELLED', 'RESALE', 'TRANSFERRED', 'COMPANY')
       )
       GROUP BY plot_id
    `, [siteId]);

    const totalsAggPromise = pool.query(`
      SELECT plot_id,
             COALESCE(SUM(amount), 0) AS total_received
        FROM plot_payments
       WHERE plot_id IN (
         SELECT id FROM plots
          WHERE site_id = $1
            AND installments_enabled = TRUE
            AND free_to_sale_days > 0
            AND status NOT IN ('UNDER CANCELLATION', 'CANCELLED', 'RESALE', 'TRANSFERRED', 'COMPANY')
       )
         AND LOWER(COALESCE(status, 'approved')) = 'approved'
         AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
       GROUP BY plot_id
    `, [siteId]);

    const [candRes, instRes, totRes] = await Promise.all([
      candidatesPromise, installmentsAggPromise, totalsAggPromise,
    ]);

    if (candRes.rows.length === 0) return;

    const installmentsByPlot = new Map(instRes.rows.map((r) => [r.plot_id, r.installments]));
    const totalsByPlot = new Map(totRes.rows.map((r) => [r.plot_id, parseFloat(r.total_received) || 0]));

    const today = new Date();
    const toCancel = [];
    for (const plot of candRes.rows) {
      const installments = installmentsByPlot.get(plot.id);
      if (!installments || installments.length === 0) continue;

      const graceDays = parseInt(plot.grace_period_days) || 15;
      const ftsThreshold = graceDays + (parseInt(plot.free_to_sale_days) || 0);
      let remainingPool = totalsByPlot.get(plot.id) || 0;

      for (const inst of installments) {
        const instAmt = parseFloat(inst.amount) || 0;
        const canApply = Math.min(remainingPool, instAmt);
        remainingPool -= canApply;
        const remaining = instAmt - canApply;
        if (remaining <= 0) continue;

        const dueDt = new Date(inst.due_date);
        const daysOverdue = dueDt < today ? Math.floor((today - dueDt) / (1000 * 60 * 60 * 24)) : 0;
        if (daysOverdue > ftsThreshold) { toCancel.push(plot.id); break; }
      }
    }

    // Step 2: bulk UPDATE all cancellations in ONE statement.
    if (toCancel.length > 0) {
      await pool.query(
        `UPDATE plots SET status = 'UNDER CANCELLATION', updated_at = NOW() WHERE id = ANY($1::int[])`,
        [toCancel]
      );
    }
  } catch (err) {
    // Non-critical — log and continue
    console.error('checkFreeToSaleStatus error:', err.message);
  }
};

let plotCommissionColumnsCache = null;
const getPlotCommissionColumns = async () => {
  if (plotCommissionColumnsCache) return plotCommissionColumnsCache;
  const { rows } = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'plots'
       AND column_name IN ('commission_enabled', 'commission_type', 'commission_value')`
  );
  plotCommissionColumnsCache = new Set(rows.map((r) => r.column_name));
  return plotCommissionColumnsCache;
};

let plotCommissionMasterColumnsCache = null;
const getPlotCommissionMasterColumns = async () => {
  if (plotCommissionMasterColumnsCache) return plotCommissionMasterColumnsCache;
  const { rows } = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'plot_commissions_v2'`
  );
  plotCommissionMasterColumnsCache = new Set(rows.map((r) => r.column_name));
  return plotCommissionMasterColumnsCache;
};

const maybeAutoCreatePlotCommission = async ({ plot, createdBy, fallbackAssignedAdminId = null }) => {
  if (!plot) return null;
  const bookingBy = String(plot.booking_by || '').trim();
  if (!bookingBy) return null;

  // Use plot_commission (Size × Commission Rate) if available, else fall back to old commission_enabled logic
  let totalCommission = parseFloat(plot.plot_commission) || 0;

  if (totalCommission <= 0) {
    // Fallback to old commission_enabled / commission_type / commission_value
    const commissionEnabled = !!plot.commission_enabled;
    if (!commissionEnabled) return null;
    const salePrice = parseFloat(plot.sale_price) || 0;
    const commissionType = String(plot.commission_type || 'PERCENTAGE').toUpperCase();
    const commissionValue = parseFloat(plot.commission_value) || 0;
    totalCommission = commissionType === 'FIXED'
      ? commissionValue
      : Math.round((salePrice * commissionValue / 100) * 100) / 100;
  }

  if (totalCommission <= 0) return null;

  // Resolve selected booking member as commission receiver (agent).
  const memberResult = await pool.query(
    `SELECT id, full_name
     FROM members
     WHERE site_id = $1
       AND UPPER(full_name) = UPPER($2)
     ORDER BY id ASC
     LIMIT 1`,
    [parseInt(plot.site_id), bookingBy]
  );
  const member = memberResult.rows[0];
  if (!member) return null;

  // Skip if commission already exists for this plot-agent pair.
  const existingResult = await pool.query(
    `SELECT id FROM plot_commissions_v2 WHERE plot_id = $1 AND agent_id = $2 LIMIT 1`,
    [parseInt(plot.id), parseInt(member.id)]
  );
  if (existingResult.rows[0]) return existingResult.rows[0];

  const assignedAdmin = plot.assigned_admin_id || fallbackAssignedAdminId || null;
  const masterCols = await getPlotCommissionMasterColumns();
  const hasAssignedAdminColumn = masterCols.has('assigned_admin_id');

  const insertColumns = [
    'site_id',
    'plot_id',
    'agent_id',
    'total_commission',
    'remarks',
    'status',
    ...(hasAssignedAdminColumn ? ['assigned_admin_id'] : []),
    'created_by',
  ];

  const insertValues = [
    parseInt(plot.site_id),
    parseInt(plot.id),
    parseInt(member.id),
    totalCommission,
    'Auto-created from Plot Payments booking',
    'Pending',
    ...(hasAssignedAdminColumn ? [assignedAdmin ? parseInt(assignedAdmin) : null] : []),
    createdBy ? parseInt(createdBy) : null,
  ];

  const placeholders = insertColumns.map((_, i) => `$${i + 1}`).join(', ');
  const insertResult = await pool.query(
    `INSERT INTO plot_commissions_v2 (${insertColumns.join(', ')})
     VALUES (${placeholders})
     RETURNING id`,
    insertValues
  );

  return insertResult.rows[0] || null;
};

// ══════════════════════════════════════════════════
//  PLOT ENDPOINTS
// ══════════════════════════════════════════════════

/** POST /plots — Create a new plot */
export const createPlot = asyncHandler(async (req, res) => {
  const { site_id, plot_no, block, buyer_name, plot_size, plot_size_mtr, plot_rate, sale_price, registry_area, circle_rate, to_receive_bank, first_installment, booking_by, booking_date, status, notes, plc_charges, team, assigned_admin_id, commission_enabled, commission_type, commission_value, commission_rate, plot_commission, force_duplicate } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  if (!plot_no || !plot_no.trim()) return res.status(400).json({ message: 'Plot number is required' });
  if (!plot_size && plot_size !== 0) return res.status(400).json({ message: 'Plot size is required' });

  const normalizedStatus = String(status || 'BOOKED').trim().toUpperCase();
  if (normalizedStatus === 'REGISTRY') {
    return res.status(409).json({
      code: 'PLOT_REGISTRY_WORKFLOW_REQUIRED',
      message: 'A plot can reach Registry status only after NOC approval in the Plot Registry module',
    });
  }

  const trimmedPlotNo = plot_no.trim().toUpperCase();

  // Duplicate check — returns all existing plots with same plot_no
  const existingPlots = await plotModel.findAllByPlotNo(parseInt(site_id), trimmedPlotNo, pool);

  var newPlotTag = undefined;
  if (existingPlots.length > 0) {
    const nonResale = existingPlots.filter(p => p.status !== 'RESALE');
    const allResale = nonResale.length === 0;
    const dupInfo = existingPlots.map(p => ({ id: p.id, status: p.status, plot_tag: p.plot_tag, buyer_name: p.buyer_name }));

    if (!allResale) {
      // Active plot exists — hard block
      return res.status(409).json({
        message: `Plot "${trimmedPlotNo}" already exists for this site`,
        duplicates: dupInfo,
        canOverride: false,
      });
    }

    if (!force_duplicate) {
      // All are RESALE but user hasn't confirmed yet — soft block with override option
      return res.status(409).json({
        message: `Plot "${trimmedPlotNo}" exists but is marked RESALE. You can create a new one.`,
        duplicates: dupInfo,
        canOverride: true,
      });
    }

    // force_duplicate is true and all existing are RESALE — compute new tag, defer DB writes to transaction below
    const totalExisting = existingPlots.length;
    newPlotTag = totalExisting === 1 ? 'NEW' : `NEW ${totalExisting}`;
  }

  const data = {
    site_id: parseInt(site_id),
    plot_no: trimmedPlotNo,
    block: block ? block.trim().toUpperCase() : null,
    buyer_name: buyer_name ? buyer_name.trim().toUpperCase() : null,
    plot_size: parseFloat(plot_size) || null,
    plot_size_mtr: parseFloat(plot_size_mtr) || null,
    plot_rate: parseFloat(plot_rate) || null,
    sale_price: parseFloat(sale_price) || 0,
    registry_area: parseFloat(registry_area) || 0,
    circle_rate: parseFloat(circle_rate) || 0,
    to_receive_bank: parseFloat(to_receive_bank) || 0,
    first_installment: parseFloat(first_installment) || 0,
    booking_by: booking_by ? booking_by.trim().toUpperCase() : null,
    booking_date: booking_date || null,
    status: normalizedStatus,
    notes: notes ? notes.trim() : null,
    plc_charges: parseFloat(plc_charges) || 0,
    commission_rate: parseFloat(commission_rate) || 0,
    plot_commission: parseFloat(plot_commission) || 0,
    team: team ? team.trim().toUpperCase() : null,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    created_by: req.user.id,
  };

  // Set plot_tag if this is a RESALE duplicate
  if (typeof newPlotTag !== 'undefined') {
    data.plot_tag = newPlotTag;
  }

  const columns = await getPlotCommissionColumns();
  if (columns.has('commission_enabled')) data.commission_enabled = !!commission_enabled;
  if (columns.has('commission_type')) {
    const validTypes = ['PERCENTAGE', 'FIXED'];
    const normalizedType = String(commission_type || 'PERCENTAGE').toUpperCase();
    data.commission_type = validTypes.includes(normalizedType) ? normalizedType : 'PERCENTAGE';
  }
  if (columns.has('commission_value')) data.commission_value = parseFloat(commission_value) || 0;

  // When this is a resale duplicate, tag existing plots AND create the new one inside a
  // single transaction. Without this, a failed creation would leave existing plots stuck
  // with stale OLD tags and no corresponding new entry (data corruption like A34/C7).
  let plot;
  if (typeof newPlotTag !== 'undefined') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < existingPlots.length; i++) {
        const tag = i === 0 ? 'OLD' : `NEW ${i}`;
        if (existingPlots[i].plot_tag !== tag) {
          await client.query(`UPDATE plots SET plot_tag = $1 WHERE id = $2`, [tag, existingPlots[i].id]);
        }
      }
      plot = await plotModel.create(data, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } else {
    plot = await plotModel.create(data, pool);
  }

  let autoCommission = null;
  try {
    autoCommission = await maybeAutoCreatePlotCommission({
      plot,
      createdBy: req.user?.id,
      fallbackAssignedAdminId: data.assigned_admin_id,
    });
  } catch (err) {
    // Ignore if commission tables are not present yet.
    if (err?.code !== '42P01') throw err;
  }

  res.status(201).json({ plot, auto_commission: autoCommission, auto_registry: null });
});

/** GET /plots?site_id=X — List all plots for a site */
export const listPlots = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  // Run the free-to-sale auto-cancel sweep IN BACKGROUND (fire-and-forget) —
  // the worst case is a one-tick stale row, which the very next list call
  // will pick up. The sweep was previously blocking the response.
  checkFreeToSaleStatus(parseInt(site_id)).catch(() => {});

  const plots = await plotModel.findBySiteId(parseInt(site_id), pool);
  res.json({ plots });
});

/** GET /plots/search?site_id=X&q=A67 — lightweight plot-number lookup for the
 *  dashboard quick-search. Returns minimal rows (id, plot_no, buyer_name, …)
 *  so the client can jump straight to /plot-payments/:id. */
export const searchPlots = asyncHandler(async (req, res) => {
  const { site_id, q } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const plots = await plotModel.searchByPlotNo(parseInt(site_id), q || '', pool);
  res.json({ plots });
});

/** GET /plots/:id — Get single plot with totals */
export const getPlot = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const plot = await plotModel.findByIdWithTotals(parseInt(id), pool);
  if (!plot) return res.status(404).json({ message: 'Plot not found' });
  res.json({ plot });
});

/** PUT /plots/:id — Update plot details */
export const updatePlot = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { plot_no, block, buyer_name, plot_size, plot_size_mtr, plot_rate, sale_price, registry_area, circle_rate, to_receive_bank, first_installment, booking_by, booking_date, status, notes, plc_charges, team, assigned_admin_id, commission_enabled, commission_type, commission_value, commission_rate, plot_commission, original_plot_rate, discount_rate } = req.body;

  const existing = await plotModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Plot not found' });

  const updateData = {};
  if (plot_no !== undefined) {
    const trimmed = String(plot_no || '').trim().toUpperCase();
    if (!trimmed) return res.status(400).json({ message: 'Plot number is required' });
    if (trimmed !== existing.plot_no) {
      const { rows } = await pool.query(
        `SELECT id FROM plots
          WHERE site_id = $1 AND UPPER(plot_no) = $2 AND id <> $3
          LIMIT 1`,
        [existing.site_id, trimmed, parseInt(id)]
      );
      if (rows[0]) return res.status(409).json({ message: `Plot "${trimmed}" already exists` });
    }
    updateData.plot_no = trimmed;
  }
  if (block !== undefined) updateData.block = block ? block.trim().toUpperCase() : null;
  if (buyer_name !== undefined) updateData.buyer_name = buyer_name ? buyer_name.trim().toUpperCase() : null;
  if (plot_size !== undefined) updateData.plot_size = parseFloat(plot_size) || null;
  if (plot_size_mtr !== undefined) updateData.plot_size_mtr = parseFloat(plot_size_mtr) || null;
  if (plot_rate !== undefined) updateData.plot_rate = parseFloat(plot_rate) || null;
  if (sale_price !== undefined) updateData.sale_price = parseFloat(sale_price) || 0;
  if (registry_area !== undefined) updateData.registry_area = parseFloat(registry_area) || 0;
  if (circle_rate !== undefined) updateData.circle_rate = parseFloat(circle_rate) || 0;
  if (to_receive_bank !== undefined) updateData.to_receive_bank = parseFloat(to_receive_bank) || 0;
  if (first_installment !== undefined) updateData.first_installment = parseFloat(first_installment) || 0;
  if (booking_by !== undefined) updateData.booking_by = booking_by ? booking_by.trim().toUpperCase() : null;
  if (booking_date !== undefined) {
    if (!booking_date) {
      updateData.booking_date = null;
    } else {
      // Handle Unix timestamp in milliseconds sent from frontend
      const ts = Number(booking_date);
      if (!isNaN(ts) && String(booking_date).length >= 10 && !/^\d{4}-\d{2}-\d{2}/.test(String(booking_date))) {
        const d = new Date(ts > 9999999999 ? ts : ts * 1000);
        updateData.booking_date = d.toISOString().slice(0, 10);
      } else {
        updateData.booking_date = booking_date;
      }
    }
  }
  if (status !== undefined) {
    const currentStatus = String(existing.status || '').trim().toUpperCase();
    const nextStatus = String(status || '').trim().toUpperCase();
    if (!nextStatus) return res.status(400).json({ message: 'Plot status is required' });
    if (nextStatus !== currentStatus && (nextStatus === 'REGISTRY' || currentStatus === 'REGISTRY')) {
      return res.status(409).json({
        code: 'PLOT_REGISTRY_WORKFLOW_REQUIRED',
        message: 'Registry status can only be changed through the Plot Registry NOC workflow',
      });
    }
    updateData.status = nextStatus;
  }
  if (notes !== undefined) updateData.notes = notes ? notes.trim() : null;
  if (plc_charges !== undefined) updateData.plc_charges = parseFloat(plc_charges) || 0;
  if (commission_rate !== undefined) updateData.commission_rate = parseFloat(commission_rate) || 0;
  if (plot_commission !== undefined) updateData.plot_commission = parseFloat(plot_commission) || 0;
  if (original_plot_rate !== undefined) updateData.original_plot_rate = parseFloat(original_plot_rate) || 0;
  if (discount_rate !== undefined) updateData.discount_rate = parseFloat(discount_rate) || 0;
  if (team !== undefined) updateData.team = team ? team.trim().toUpperCase() : null;
  if (assigned_admin_id !== undefined) updateData.assigned_admin_id = assigned_admin_id ? parseInt(assigned_admin_id) : null;

  const columns = await getPlotCommissionColumns();
  if (columns.has('commission_enabled') && commission_enabled !== undefined) updateData.commission_enabled = !!commission_enabled;
  if (columns.has('commission_type') && commission_type !== undefined) {
    const validTypes = ['PERCENTAGE', 'FIXED'];
    const normalizedType = String(commission_type || 'PERCENTAGE').toUpperCase();
    updateData.commission_type = validTypes.includes(normalizedType) ? normalizedType : 'PERCENTAGE';
  }
  if (columns.has('commission_value') && commission_value !== undefined) updateData.commission_value = parseFloat(commission_value) || 0;

  if (Object.keys(updateData).length === 0) return res.status(400).json({ message: 'Nothing to update' });

  const updated = await plotModel.update(parseInt(id), updateData, pool);

  // ── Retire the previous agent's orphaned commission when booking_by changes ──
  // Auto-create only ever ADDS a (plot_id, agent_id) commission, so re-assigning
  // the booking agent used to leave the old agent stranded on the plot forever
  // (the "current agent still shows on the previous booking" bug). When the
  // booking agent changes we delete the PREVIOUS agent's AUTO-created commission
  // — but only if NO payments were recorded against it, so money is never lost.
  if (
    updateData.booking_by !== undefined &&
    String(existing.booking_by || '').trim() &&
    String(updateData.booking_by || '').trim().toUpperCase() !== String(existing.booking_by || '').trim().toUpperCase()
  ) {
    try {
      await pool.query(
        `DELETE FROM plot_commissions_v2 pc
           USING members m
          WHERE pc.plot_id = $1
            AND pc.agent_id = m.id
            AND UPPER(m.full_name) = UPPER($2)
            AND pc.remarks = 'Auto-created from Plot Payments booking'
            AND NOT EXISTS (
              SELECT 1 FROM plot_commission_payments p WHERE p.plot_commission_id = pc.id
            )`,
        [parseInt(id), String(existing.booking_by).trim()]
      );
    } catch (err) {
      if (err?.code !== '42P01') throw err;
    }
  }

  // Persist circle rate change history (backward-compatible if table does not exist yet).
  if (circle_rate !== undefined) {
    const prevRate = parseFloat(existing.circle_rate) || 0;
    const nextRate = parseFloat(updateData.circle_rate) || 0;
    if (prevRate !== nextRate) {
      try {
        await pool.query(
          `INSERT INTO plot_circle_rate_history (plot_id, previous_circle_rate, new_circle_rate, changed_by)
           VALUES ($1, $2, $3, $4)`,
          [parseInt(id), prevRate, nextRate, req.user?.id || null]
        );
      } catch (err) {
        // Ignore if migration table is not present yet.
        if (err?.code !== '42P01') throw err;
      }
    }
  }

  let autoCommission = null;
  try {
    autoCommission = await maybeAutoCreatePlotCommission({
      plot: updated,
      createdBy: req.user?.id,
      fallbackAssignedAdminId: updateData.assigned_admin_id,
    });
  } catch (err) {
    // Ignore if commission tables are not present yet.
    if (err?.code !== '42P01') throw err;
  }

  res.json({ plot: updated, auto_commission: autoCommission, auto_registry: null });
});

/** DELETE /plots/:id — Delete a plot and all its commissions + payments */
export const deletePlot = asyncHandler(async (req, res) => {
  const plotId = parseInt(req.params.id);

  const { rows: registryRows } = await pool.query(
    `SELECT pr.id
       FROM plots p
       JOIN plot_registries pr
         ON pr.plot_id = p.id
         OR (pr.plot_id IS NULL
             AND pr.site_id = p.site_id
             AND UPPER(pr.plot_no) = UPPER(p.plot_no))
      WHERE p.id = $1
      LIMIT 1`,
    [plotId]
  );
  if (registryRows[0]) {
    return res.status(409).json({
      message: 'This plot has a registry record and cannot be deleted. Remove an unapproved registry draft first.',
    });
  }

  // Single CTE atomic delete — replaces the previous 4-RTT pattern
  // (existence SELECT + BEGIN + 3 DELETEs + COMMIT).
  const result = await pool.query(
    `WITH del_commission_payments AS (
       DELETE FROM plot_commission_payments
        WHERE plot_commission_id IN (SELECT id FROM plot_commissions_v2 WHERE plot_id = $1)
     ),
     del_commissions AS (
       DELETE FROM plot_commissions_v2 WHERE plot_id = $1
     )
     DELETE FROM plots WHERE id = $1 RETURNING id`,
    [plotId]
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Plot not found' });
  res.json({ message: 'Plot deleted' });
});

// ══════════════════════════════════════════════════
//  PLOT PAYMENT ENDPOINTS
// ══════════════════════════════════════════════════

/** POST /plots/payments — Create a payment */
export const createPayment = asyncHandler(async (req, res) => {
  const { plot_id, date, payment_from, payment_type, bank_details, bank_name, branch, narration, amount, voucher_url, assigned_admin_id, buyer_name, booked_by, mapped_member_id, mapped_user_id } = req.body;

  if (!plot_id) return res.status(400).json({ message: 'Plot is required' });
  if (mapped_member_id && mapped_user_id) {
    return res.status(400).json({ message: 'Map this payment to either a client or a user, not both' });
  }

  const plotIdInt = parseInt(plot_id);
  const normalizedPaymentType = normalizePlotPaymentType(payment_type);
  const isBankish = ['BANK', 'CHEQUE'].includes(normalizedPaymentType);

  // Single CTE: lookup plot.site_id + INSERT in ONE round-trip.
  // Was: SELECT plot + INSERT = 2 RTTs.
  const result = await pool.query(
    `WITH plot AS (SELECT id, site_id FROM plots WHERE id = $1)
     INSERT INTO plot_payments (
       plot_id, site_id, date, payment_from, payment_type, bank_details, bank_name,
       branch, narration, amount, created_by, voucher_url, assigned_admin_id, status,
       cheque_no, cheque_status, buyer_name, booked_by, mapped_member_id, mapped_user_id
     )
     SELECT $1, plot.site_id, $2::date, $3, $4, $5, $6, $7, $8, $9::numeric,
            $10, $11, $12, 'pending', $13, $14, $15, $16, $17, $18
       FROM plot
     RETURNING *`,
    [
      plotIdInt,                                                          // $1
      date || todayInIndia(),                                             // $2
      payment_from ? payment_from.trim().toUpperCase() : null,            // $3
      normalizedPaymentType,                                              // $4
      bank_details ? bank_details.trim().toUpperCase() : null,            // $5
      isBankish ? (bank_name ? bank_name.trim().toUpperCase() : null) : null, // $6
      isBankish ? (branch ? branch.trim().toUpperCase() : null) : null,   // $7
      narration ? narration.trim().toUpperCase() : null,                  // $8
      parseFloat(amount) || 0,                                            // $9
      req.user.id,                                                        // $10
      voucher_url || null,                                                // $11
      assigned_admin_id ? parseInt(assigned_admin_id) : null,             // $12
      normalizedPaymentType === 'CHEQUE' && req.body.cheque_no
        ? String(req.body.cheque_no).trim()
        : null,                                                          // $13
      normalizedPaymentType === 'CHEQUE' ? 'PENDING' : null,              // $14
      buyer_name ? buyer_name.trim().toUpperCase() : null,                // $15
      booked_by ? booked_by.trim().toUpperCase() : null,                  // $16
      mapped_member_id ? parseInt(mapped_member_id) : null,               // $17
      mapped_user_id ? parseInt(mapped_user_id) : null,                   // $18
    ]
  );
  const payment = result.rows[0];
  if (!payment) return res.status(404).json({ message: 'Plot not found' });
  res.status(201).json({ payment });

  // Fire-and-forget: WhatsApp the plot owner with the payment details.
  // Deliberately not awaited — a notification failure must never affect the
  // recorded payment or the API response.
  notifyPlotPaymentRecorded(payment).catch((e) => console.error('[notify] error', e?.message || e));
});

/** GET /plots/payments/list?plot_id=X — List payments for a plot */
export const listPayments = asyncHandler(async (req, res) => {
  const { plot_id } = req.query;
  if (!plot_id) return res.status(400).json({ message: 'plot_id is required' });

  const plotIdInt = parseInt(plot_id);

  // 4-way parallel reads (was already parallel — keep). Site lookup needs
  // plot.site_id, but in practice that comes from the plot row itself —
  // we can fold it into a single LATERAL JOIN to avoid the extra round-trip.
  const plotPromise = pool.query(
    `SELECT p.*,
            COALESCE(agg.total_received, 0) AS total_received,
            COALESCE(agg.received_bank,  0) AS received_bank,
            COALESCE(agg.received_cash,  0) AS received_cash,
            COALESCE(agg.payment_count,  0) AS payment_count,
            s.name  AS _site_name,
            s.city  AS _site_city,
            s.state AS _site_state
       FROM plots p
       LEFT JOIN sites s ON s.id = p.site_id
       LEFT JOIN LATERAL (
         SELECT
           SUM(pp.amount) FILTER (
             WHERE LOWER(COALESCE(pp.status, 'approved')) = 'approved'
               AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
           ) AS total_received,
           SUM(pp.amount) FILTER (
             WHERE ledger_bucket(pp.payment_type) <> 'cash'
               AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
               AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
           ) AS received_bank,
           SUM(pp.amount) FILTER (
             WHERE ledger_bucket(pp.payment_type) = 'cash'
               AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
               AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
           ) AS received_cash,
           COUNT(*) FILTER (
             WHERE LOWER(COALESCE(pp.status, 'approved')) = 'approved'
               AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
           )::int AS payment_count
         FROM (
           SELECT amount, payment_type, status, cheque_status
           FROM plot_payments
           WHERE plot_id = p.id
           UNION ALL
           SELECT amount, payment_mode AS payment_type, 'approved'::varchar AS status, cheque_status
           FROM plot_installment_payments
           WHERE plot_id = p.id
         ) pp
       ) agg ON TRUE
      WHERE p.id = $1`,
    [plotIdInt]
  );

  const [paymentsRes, plotRes, fromBreakdown, receivedByBreakdown] = await Promise.all([
    pool.query(
      `SELECT pp.*, 'payment' AS source, u.name AS created_by_name
         FROM plot_payments pp
         LEFT JOIN users u ON u.id = pp.created_by
        WHERE pp.plot_id = $1
        ORDER BY pp.date ASC, pp.created_at ASC`,
      [plotIdInt]
    ),
    plotPromise,
    plotPaymentModel.getFromBreakdown(plotIdInt, pool),
    plotPaymentModel.getReceivedByBreakdown(plotIdInt, pool),
  ]);
  const payments = paymentsRes.rows;
  const plot = plotRes.rows[0] || null;

  const siteRow = plot
    ? { name: plot._site_name, city: plot._site_city, state: plot._site_state }
    : null;
  if (plot) {
    delete plot._site_name;
    delete plot._site_city;
    delete plot._site_state;
  }

  const paymentsWithVerify = payments.map((p) => ({
    ...p,
    verifyUrl: buildVerifyUrl({
      t: ReceiptType.PLOT,
      i: p.id,
      pn: p.buyer_name || plot?.buyer_name || null,
      pl: plot?.plot_no || null,
      a: p.amount,
      d: p.date,
      pm: p.payment_from || p.payment_type || null,
      sn: siteRow?.name || null,
      sy: siteRow?.city || null,
      ss: siteRow?.state || null,
    }),
  }));

  res.json({ payments: paymentsWithVerify, plot, fromBreakdown, receivedByBreakdown });
});

/** GET /plots/payments/:id — Get a single payment */
export const getPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const payment = await plotPaymentModel.findById(parseInt(id), pool);
  if (!payment) return res.status(404).json({ message: 'Payment not found' });
  res.json({ payment });
});

/** PUT /plots/payments/:id — Update a payment */
export const updatePayment = asyncHandler(async (req, res) => {
  const paymentId = parseInt(req.params.id);
  const { date, payment_from, payment_type, bank_details, bank_name, branch, narration, amount, voucher_url, assigned_admin_id, buyer_name, booked_by, cheque_no, cheque_status, received_by } = req.body;

  const existing = await plotPaymentModel.findById(paymentId, pool);
  if (!existing) return res.status(404).json({ message: 'Payment not found' });

  const updateData = {};
  const normalizedPaymentType = payment_type !== undefined
    ? normalizePlotPaymentType(payment_type)
    : undefined;
  const effectivePaymentType = normalizedPaymentType ?? normalizePlotPaymentType(existing.payment_type);
  if (date !== undefined) updateData.date = date;
  if (payment_from !== undefined) updateData.payment_from = payment_from ? payment_from.trim().toUpperCase() : null;
  if (normalizedPaymentType !== undefined) {
    updateData.payment_type = normalizedPaymentType;
    updateData.cheque_status = resolveChequeStatus({
      currentType: existing.payment_type,
      currentStatus: existing.cheque_status,
      nextType: normalizedPaymentType,
      requestedStatus: cheque_status,
    });
    if (normalizedPaymentType !== 'CHEQUE') updateData.cheque_no = null;
  }
  if (bank_details !== undefined) updateData.bank_details = bank_details ? bank_details.trim().toUpperCase() : null;
  if (bank_name !== undefined) updateData.bank_name = bank_name ? bank_name.trim().toUpperCase() : null;
  if (branch !== undefined) updateData.branch = branch ? branch.trim().toUpperCase() : null;
  if (narration !== undefined) updateData.narration = narration ? narration.trim().toUpperCase() : null;
  if (amount !== undefined) updateData.amount = parseFloat(amount) || 0;
  if (voucher_url !== undefined) updateData.voucher_url = voucher_url || null;
  if (assigned_admin_id !== undefined) updateData.assigned_admin_id = assigned_admin_id ? parseInt(assigned_admin_id) : null;
  if (buyer_name !== undefined) updateData.buyer_name = buyer_name ? buyer_name.trim().toUpperCase() : null;
  if (booked_by !== undefined) updateData.booked_by = booked_by ? booked_by.trim().toUpperCase() : null;
  if (cheque_no !== undefined) {
    updateData.cheque_no = effectivePaymentType === 'CHEQUE' && cheque_no
      ? String(cheque_no).trim()
      : null;
  }
  if (cheque_status !== undefined && normalizedPaymentType === undefined) {
    const currentType = normalizePlotPaymentType(existing.payment_type);
    updateData.cheque_status = resolveChequeStatus({
      currentType,
      currentStatus: existing.cheque_status,
      nextType: currentType,
      requestedStatus: cheque_status,
    });
  }
  if (received_by !== undefined) updateData.received_by = received_by ? received_by.trim().toUpperCase() : null;

  if (normalizedPaymentType === 'CASH') {
    updateData.bank_name = null;
    updateData.branch = null;
  }

  if (Object.keys(updateData).length === 0) return res.status(400).json({ message: 'Nothing to update' });

  const updated = await plotPaymentModel.update(paymentId, updateData, pool);
  res.json({ payment: updated });
});

/** DELETE /plots/payments/:id — Delete a payment */
export const deletePayment = asyncHandler(async (req, res) => {
  const paymentId = parseInt(req.params.id);
  const { rows: registryLinks } = await pool.query(
    `SELECT id FROM plot_registry_payments
      WHERE source_plot_payment_id = $1
      LIMIT 1`,
    [paymentId]
  );
  if (registryLinks[0]) {
    return res.status(409).json({
      message: 'This payment is linked to a Plot Registry record. Remove the registry link before deleting it.',
    });
  }

  // Atomic DELETE — saves a SELECT round-trip.
  const result = await pool.query(
    `DELETE FROM plot_payments WHERE id = $1 RETURNING id`,
    [paymentId]
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Payment not found' });
  res.json({ message: 'Payment deleted' });
});

/** GET /plots/autocomplete?site_id=X — Autocomplete values */
export const getAutocomplete = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const [data, membersResult] = await Promise.all([
    plotPaymentModel.getAutocomplete(parseInt(site_id), pool),
    pool.query(
      `SELECT full_name, phone, team, member_type FROM members WHERE site_id = $1 AND full_name IS NOT NULL AND full_name != '' ORDER BY full_name ASC`,
      [parseInt(site_id)]
    ),
  ]);
  data.members = membersResult.rows.map(r => ({ name: r.full_name, phone: r.phone || '', team: r.team || '', member_type: r.member_type || '' }));
  res.json(data);
});
