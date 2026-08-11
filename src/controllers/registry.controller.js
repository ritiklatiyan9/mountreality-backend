import asyncHandler from '../utils/asyncHandler.js';
import { plotRegistryModel, plotRegistryPaymentModel } from '../models/PlotRegistry.model.js';
import { buildVerifyUrl, ReceiptType } from '../utils/receiptToken.js';
import pool from '../config/db.js';
import applicationSettingModel, { FEATURE_KEYS } from '../models/ApplicationSetting.model.js';
import { classifyPaymentMode } from '../utils/paymentMode.js';
import { resolveBankAccountSelection } from '../services/bankAccount.service.js';

// ══════════════════════════════════════════════════
//  REGISTRY ENDPOINTS
// ══════════════════════════════════════════════════

const isAdminRole = (role) => role === 'admin' || role === 'super_admin';
const isRegistryWorkflowUnlocked = (siteId) => applicationSettingModel.isFeatureEnabled(
  siteId,
  FEATURE_KEYS.PLOT_REGISTRY_WORKFLOW_UNLOCKED
);
const readRegistryWorkflowUnlocked = async (db, siteId) => {
  const { rows } = await db.query(
    `SELECT setting_value
       FROM application_settings
      WHERE site_id = $1 AND setting_key = $2
      LIMIT 1`,
    [siteId, FEATURE_KEYS.PLOT_REGISTRY_WORKFLOW_UNLOCKED]
  );
  const value = rows[0]?.setting_value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  if (value && typeof value === 'object' && 'enabled' in value) return Boolean(value.enabled);
  return false;
};

// Used only for registry/NOC eligibility. Registry mappings remain
// informational and are deliberately excluded from financial-ledger sync.
const REGISTRY_PAYMENT_ELIGIBILITY_SQL = `(
  (
    prp.source_plot_payment_id IS NULL
    AND UPPER(COALESCE(prp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
  )
  OR (
    prp.source_plot_payment_id IS NOT NULL
    AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
    AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
  )
)`;
const REGISTRY_PAYMENT_AMOUNT_SQL = `CASE
  WHEN prp.source_plot_payment_id IS NULL THEN COALESCE(prp.amount, 0)
  ELSE COALESCE(pp.amount, 0)
END`;

/** Bank-clearance snapshot for a plot: what the plot expects in bank
 *  (plots.to_receive_bank) vs what has actually landed — bank/cheque plot
 *  payments + bank-mode installment payments, bounced/returned excluded.
 *  Same maths as plotPayments.service getPlotsWithTotals. */
export async function getPlotBankClearance(plotId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.plot_no, COALESCE(p.to_receive_bank, 0)::numeric AS to_receive_bank,
            COALESCE((
              SELECT SUM(pp.amount) FROM plot_payments pp
               WHERE pp.plot_id = p.id
                 AND ledger_bucket(pp.payment_type) <> 'cash'
                 AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
                 AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
            ), 0)::numeric
          + COALESCE((
              SELECT SUM(pip.amount) FROM plot_installment_payments pip
               WHERE pip.plot_id = p.id
                 AND ledger_bucket(pip.payment_mode) <> 'cash'
                 AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
            ), 0)::numeric AS received_bank
       FROM plots p WHERE p.id = $1`,
    [plotId]
  );
  const row = rows[0];
  if (!row) return null;
  const toReceive = parseFloat(row.to_receive_bank) || 0;
  const received = parseFloat(row.received_bank) || 0;
  return {
    plot_id: row.id,
    plot_no: row.plot_no,
    to_receive_bank: toReceive,
    received_bank: received,
    pending_bank: Math.max(0, toReceive - received),
    clear: toReceive - received <= 0.005,
  };
}

/** GET /registries/plot-clearance?plot_id= — payments-clear check used by the
 *  create-registry form to decide direct-create vs admin-approval path. */
export const getRegistryPlotClearance = asyncHandler(async (req, res) => {
  const plotId = parseInt(req.query.plot_id);
  if (!Number.isFinite(plotId)) return res.status(400).json({ message: 'plot_id is required' });
  const clearance = await getPlotBankClearance(plotId);
  if (!clearance) return res.status(404).json({ message: 'Plot not found' });
  res.json({ clearance });
});

/** POST /registries — Create a new registry.
 *  Business rules:
 *  1. Money-mapped: the payload must carry `payments` totalling > 0 (see
 *     createRegistryRecord).
 *  2. Payments-clear: the linked plot's bank money must be fully received
 *     (up to plots.to_receive_bank). Admins may create anyway; sub-admins
 *     are routed to the admin-approval flow (POST /edit-requests, module
 *     'plot_registry_create') and blocked here. */
export const createRegistry = asyncHandler(async (req, res) => {
  const requestedSiteId = parseInt(req.body.site_id);
  const requestedPlotId = parseInt(req.body.plot_id);
  if (Number.isFinite(requestedPlotId)) {
    const { rows } = await pool.query('SELECT site_id FROM plots WHERE id = $1 LIMIT 1', [requestedPlotId]);
    if (!rows[0]) return res.status(404).json({ message: 'Plot not found' });
    if (Number.isFinite(requestedSiteId) && parseInt(rows[0].site_id) !== requestedSiteId) {
      return res.status(400).json({ message: 'Selected plot does not belong to the registry site' });
    }
  }

  if (!isAdminRole(req.user.role)) {
    // Resolve the gate plot by FK or (site, plot_no) fallback — omitting
    // plot_id must not skip the clearance check.
    let gatePlotId = parseInt(req.body.plot_id);
    if (!Number.isFinite(gatePlotId) && req.body.site_id && req.body.plot_no) {
      const { rows } = await pool.query(
        `SELECT id FROM plots WHERE site_id = $1 AND UPPER(plot_no) = UPPER($2) ORDER BY id DESC LIMIT 1`,
        [parseInt(req.body.site_id), String(req.body.plot_no).trim()]
      );
      gatePlotId = rows[0]?.id;
    }
    if (gatePlotId) {
      const clearance = await getPlotBankClearance(gatePlotId);
      if (clearance && !clearance.clear) {
        return res.status(403).json({
          code: 'PAYMENTS_NOT_CLEAR',
          clearance,
          message: `Payments are not clear — ₹${clearance.pending_bank.toLocaleString('en-IN')} is still to be received in bank. Submit the registry for admin approval.`,
        });
      }
    }
  }
  const out = await createRegistryRecord(req.body, req.user.id);
  res.status(out.status).json(out.body);
});

/** Core create logic, callable outside the HTTP handler (admin-approval flow
 *  applies an approved 'plot_registry_create' edit request through this).
 *  A registry can only be created with money mapped to it — `payments` is an
 *  array of either
 *    { source_plot_payment_id }                              (link a bank/cheque plot payment)
 *    { payment_date, amount, payment_mode, tally_date, tally_amount, notes, cheque_no }  (manual)
 *  totalling > 0. Registry + payments are created in ONE transaction, so a
 *  registry can never exist without its money. An optional transaction client
 *  lets the edit-request approval commit the registry and approval state as one
 *  unit. Returns { status, body }. */
export async function createRegistryRecord(body, userId, transactionClient = null) {
  const {
    site_id, plot_no, customer_name, size_meter, size_sqyard, registry_date, farmer_name,
    registry_payment, notes, plot_id, circle_rate, firm_name, seller_name, created_entry_date, bank_amount,
    payments,
  } = body;

  if (!site_id) return { status: 400, body: { message: 'Site is required' } };
  if (!plot_id) return { status: 400, body: { message: 'A valid plot is required' } };
  if (!String(plot_no || '').trim()) {
    return { status: 400, body: { message: 'Plot number is required' } };
  }

  const trimmed = String(plot_no).trim().toUpperCase();
  const siteIdInt = parseInt(site_id);
  const plotIdInt = parseInt(plot_id);
  const db = transactionClient || pool;
  if (!Number.isInteger(siteIdInt) || siteIdInt <= 0) {
    return { status: 400, body: { message: 'A valid site is required' } };
  }
  if (!Number.isInteger(plotIdInt) || plotIdInt <= 0) {
    return { status: 400, body: { message: 'A valid plot is required' } };
  }
  const { rows: plotRows } = await db.query(
    `SELECT p.site_id,p.plot_no,p.current_booking_id,p.rera_project_id,p.rera_project_phase_id,
            b.client_member_id,b.buyer_name AS booking_buyer_name,
            a.id AS agreement_id
       FROM plots p
       LEFT JOIN bookings b ON b.id=p.current_booking_id AND b.site_id=p.site_id
       LEFT JOIN LATERAL (
         SELECT ba.id FROM booking_agreements ba
          WHERE ba.booking_id=b.id AND ba.status NOT IN ('SUPERSEDED','CANCELLED')
          ORDER BY ba.version_number DESC,ba.id DESC LIMIT 1
       ) a ON TRUE
      WHERE p.id=$1 LIMIT 1`,
    [plotIdInt]
  );
  if (!plotRows[0]) return { status: 404, body: { message: 'Plot not found' } };
  if (parseInt(plotRows[0].site_id) !== siteIdInt) {
    return { status: 400, body: { message: 'Selected plot does not belong to the registry site' } };
  }
  if (String(plotRows[0].plot_no || '').trim().toUpperCase() !== trimmed) {
    return { status: 400, body: { message: 'Registry plot number does not match the selected plot' } };
  }
  let plotContext = plotRows[0];

  // ── Money-mapped gate ──
  const paymentRows = Array.isArray(payments) ? payments : [];
  const linkedIds = [...new Set(paymentRows
    .filter((p) => p && p.source_plot_payment_id)
    .map((p) => parseInt(p.source_plot_payment_id))
    .filter(Number.isFinite))];
  const manualRows = paymentRows.filter((p) => p && !p.source_plot_payment_id && (parseFloat(p.amount) || 0) > 0);

  let linkedTotal = 0;
  let linkable = [];
  if (linkedIds.length) {
    // A source payment belongs to one exact plot. Site equality alone is not
    // sufficient: otherwise receipts from another plot could satisfy this
    // registry's NOC payment gate.
    const { rows } = await db.query(
      `SELECT pp.id, pp.site_id, pp.date, pp.amount, pp.payment_from, pp.payment_type,
              pp.bank_details, pp.narration, pp.cheque_no, pp.cheque_status, pp.bank_account_id
         FROM plot_payments pp
        WHERE pp.id = ANY($1::int[])
          AND pp.site_id = $2
          AND pp.plot_id = $3
          AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
          AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          AND NOT EXISTS (SELECT 1 FROM plot_registry_payments x WHERE x.source_plot_payment_id = pp.id)`,
      [linkedIds, siteIdInt, plotIdInt]
    );
    linkable = rows;
    if (linkable.length !== linkedIds.length) {
      return { status: 400, body: {
        message: 'Every linked Plot Payment must belong to this plot, be approved, non-bounced, and not already mapped',
      } };
    }
    linkedTotal = rows.reduce((n, r) => n + (parseFloat(r.amount) || 0), 0);
  }
  const manualTotal = manualRows.reduce((n, r) => n + (parseFloat(r.amount) || 0), 0);
  if (linkable.length + manualRows.length === 0 || linkedTotal + manualTotal <= 0) {
    return { status: 400, body: {
      message: 'Map at least one payment before creating a registry — a registry cannot be created without money mapped to it',
    } };
  }

  const today = new Date().toISOString().split('T')[0];
  const ownsTransaction = !transactionClient;
  const client = transactionClient || await pool.connect();
  let row;
  try {
    if (ownsTransaction) await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(96096,$1)`, [plotIdInt]);
    const { rows: lockedPlots } = await client.query(
      `SELECT p.site_id,p.plot_no,p.current_booking_id,p.rera_project_id,p.rera_project_phase_id,
              b.client_member_id,b.buyer_name AS booking_buyer_name,a.id AS agreement_id
         FROM plots p
         LEFT JOIN bookings b ON b.id=p.current_booking_id AND b.site_id=p.site_id
         LEFT JOIN LATERAL (
           SELECT ba.id FROM booking_agreements ba
            WHERE ba.booking_id=b.id AND ba.status NOT IN ('SUPERSEDED','CANCELLED')
            ORDER BY ba.version_number DESC,ba.id DESC LIMIT 1
         ) a ON TRUE
        WHERE p.id=$1 AND p.site_id=$2 FOR UPDATE OF p`,
      [plotIdInt, siteIdInt],
    );
    if (!lockedPlots[0] || String(lockedPlots[0].plot_no || '').trim().toUpperCase() !== trimmed) {
      if (ownsTransaction) await client.query('ROLLBACK');
      return { status: 409, body: { message: 'Plot context changed while the registry form was open' } };
    }
    plotContext = lockedPlots[0];
    if (linkedIds.length) {
      const { rows: currentLinkable } = await client.query(
        `SELECT pp.id,pp.site_id,pp.date,pp.amount,pp.payment_from,pp.payment_type,
                pp.bank_details,pp.narration,pp.cheque_no,pp.cheque_status,pp.bank_account_id
           FROM plot_payments pp
          WHERE pp.id=ANY($1::int[]) AND pp.site_id=$2 AND pp.plot_id=$3
            AND LOWER(COALESCE(pp.status,'approved'))='approved'
            AND UPPER(COALESCE(pp.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
            AND NOT EXISTS (SELECT 1 FROM plot_registry_payments x WHERE x.source_plot_payment_id=pp.id)
          FOR UPDATE OF pp`,
        [linkedIds, siteIdInt, plotIdInt],
      );
      if (currentLinkable.length !== linkedIds.length) {
        if (ownsTransaction) await client.query('ROLLBACK');
        return { status: 409, body: { message: 'A linked receipt changed or was used while this registry form was open' } };
      }
      linkable = currentLinkable;
    }

    // Single CTE: dup-check + INSERT + plot-status auto-bump in ONE round-trip.
    const result = await client.query(
      `WITH dup AS (
         SELECT 1 FROM plot_registries
          WHERE site_id = $1 AND UPPER(plot_no) = $2
          LIMIT 1
       ),
       ins AS (
         INSERT INTO plot_registries (
           site_id, plot_no, customer_name, size_meter, size_sqyard, registry_date,
           farmer_name, plot_id, circle_rate, firm_name, seller_name, created_entry_date,
           bank_amount, registry_payment, notes, assigned_admin_id, created_by,
           booking_id,allottee_member_id,rera_project_id,rera_project_phase_id,agreement_id,
           lifecycle_status,possession_status
         )
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                $18,$19,$20,$21,$22,'NOT_READY','PENDING'
         WHERE NOT EXISTS (SELECT 1 FROM dup)
         RETURNING *
       ),
       plot_bump AS (
         UPDATE plots
            SET status = 'PENDING NOC', lifecycle_status=COALESCE(lifecycle_status,'REGISTRY_PENDING'),
                registry_status='NOT_READY',lifecycle_version=COALESCE(lifecycle_version,1)+1,updated_at = NOW()
          WHERE id = $8
            AND UPPER(COALESCE(status, '')) = 'BOOKED'
            AND EXISTS (SELECT 1 FROM ins)
          RETURNING id
       )
       SELECT
         (SELECT row_to_json(ins) FROM ins) AS registry,
         EXISTS (SELECT 1 FROM dup) AS is_dup,
         EXISTS (SELECT 1 FROM plot_bump) AS plot_status_updated`,
      [
        siteIdInt,                                                              // $1
        trimmed,                                                                // $2
        customer_name ? customer_name.trim().toUpperCase() : null,              // $3
        parseFloat(size_meter) || null,                                         // $4
        parseFloat(size_sqyard) || null,                                        // $5
        registry_date || null,                                                  // $6
        farmer_name ? farmer_name.trim().toUpperCase() : null,                  // $7
        plotIdInt,                                                              // $8
        circle_rate !== undefined && circle_rate !== '' ? (parseFloat(circle_rate) || 0) : null, // $9
        firm_name ? firm_name.trim().toUpperCase() : null,                      // $10
        seller_name ? seller_name.trim().toUpperCase() : null,                  // $11
        created_entry_date || today,                                            // $12
        bank_amount !== undefined && bank_amount !== '' ? (parseFloat(bank_amount) || 0) : null, // $13
        parseFloat(registry_payment) || 0,                                      // $14
        notes ? notes.trim() : null,                                            // $15
        body.assigned_admin_id ? parseInt(body.assigned_admin_id) : null,       // $16
        userId,                                                                 // $17
        plotContext.current_booking_id || null,                                 // $18
        plotContext.client_member_id || null,                                   // $19
        plotContext.rera_project_id || null,                                    // $20
        plotContext.rera_project_phase_id || null,                              // $21
        plotContext.agreement_id || null,                                       // $22
      ]
    );

    row = result.rows[0];
    if (row.is_dup) {
      if (ownsTransaction) await client.query('ROLLBACK');
      return { status: 409, body: { message: `Registry for plot "${trimmed}" already exists` } };
    }
    const registryId = row.registry.id;

    // ── Linked bank/cheque plot payments (same shape saveRegistryNoc uses) ──
    for (const pp of linkable) {
      await client.query(
        `INSERT INTO plot_registry_payments (
           registry_id, site_id, payment_date, amount, payment_mode, tally_date, tally_amount,
           notes, source_plot_payment_id, cheque_no, cheque_status, created_by, bank_account_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          registryId, siteIdInt, pp.date || today, parseFloat(pp.amount) || 0,
          (pp.payment_type || '').trim().toUpperCase() || null,
          pp.date || null, parseFloat(pp.amount) || 0,
          (pp.narration || pp.bank_details || 'LINKED FROM PLOT PAYMENT').trim().toUpperCase(),
          pp.id, pp.cheque_no || null, pp.cheque_status || null, userId, pp.bank_account_id || null,
        ]
      );
    }

    // ── Manual payments ──
    for (const m of manualRows) {
      const mode = m.payment_mode ? String(m.payment_mode).trim().toUpperCase() : null;
      const isCheque = classifyPaymentMode(mode) === 'cheque';
      const selectedBankAccountId = await resolveBankAccountSelection({
        siteId: siteIdInt,
        paymentMode: mode,
        bankAccountId: m.bank_account_id,
        db: client,
      });
      await client.query(
        `INSERT INTO plot_registry_payments (
           registry_id, site_id, payment_date, amount, payment_mode, tally_date, tally_amount,
           notes, cheque_no, cheque_status, created_by, bank_account_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          registryId, siteIdInt, m.payment_date || today, parseFloat(m.amount) || 0, mode,
          m.tally_date || null,
          m.tally_amount !== undefined && m.tally_amount !== '' ? parseFloat(m.tally_amount) : null,
          m.notes ? String(m.notes).trim().toUpperCase() : null,
          isCheque && m.cheque_no ? String(m.cheque_no).trim() : null,
          isCheque ? 'PENDING' : null,
          userId,
          selectedBankAccountId,
        ]
      );
    }

    if (ownsTransaction) await client.query('COMMIT');
  } catch (err) {
    if (ownsTransaction) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (ownsTransaction) client.release();
  }

  return { status: 201, body: {
    registry: row.registry,
    plot_status_updated: row.plot_status_updated,
    payments_created: linkable.length + manualRows.length,
    payments_skipped: linkedIds.length - linkable.length,
  } };
}

/** GET /registries?site_id=X — List all registries for a site */
export const listRegistries = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const registries = await plotRegistryModel.findBySiteId(parseInt(site_id), pool);
  res.json({ registries });
});

/** GET /registries/:id — Get single registry with totals */
export const getRegistry = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const registry = await plotRegistryModel.findByIdWithTotals(parseInt(id), pool);
  if (!registry) return res.status(404).json({ message: 'Registry not found' });
  res.json({ registry });
});

/** PUT /registries/:id — Update registry details */
export const updateRegistry = asyncHandler(async (req, res) => {
  const registryId = parseInt(req.params.id);
  const {
    plot_no, customer_name, size_meter, size_sqyard, registry_date, farmer_name,
    registry_payment, notes, plot_id, circle_rate, firm_name, seller_name, created_entry_date, bank_amount,
  } = req.body;

  const existing = await plotRegistryModel.findById(registryId, pool);
  if (!existing) return res.status(404).json({ message: 'Registry not found' });

  const updateData = {};
  if (plot_no !== undefined) {
    const trimmed = String(plot_no || '').trim().toUpperCase();
    if (!trimmed) return res.status(400).json({ message: 'Plot number is required' });
    if (trimmed !== existing.plot_no) {
      const dup = await plotRegistryModel.findByPlotNo(existing.site_id, trimmed, pool);
      if (dup) return res.status(409).json({ message: `Registry for plot "${trimmed}" already exists` });
    }
    updateData.plot_no = trimmed;
  }
  if (customer_name !== undefined) updateData.customer_name = customer_name ? customer_name.trim().toUpperCase() : null;
  if (size_meter !== undefined) updateData.size_meter = parseFloat(size_meter) || null;
  if (size_sqyard !== undefined) updateData.size_sqyard = parseFloat(size_sqyard) || null;
  if (registry_date !== undefined) updateData.registry_date = registry_date || null;
  if (farmer_name !== undefined) updateData.farmer_name = farmer_name ? farmer_name.trim().toUpperCase() : null;
  if (plot_id !== undefined) {
    const parsedPlotId = parseInt(plot_id);
    if (!Number.isInteger(parsedPlotId) || parsedPlotId <= 0) {
      return res.status(400).json({ message: 'A valid plot is required' });
    }
    updateData.plot_id = parsedPlotId;
  }
  if (circle_rate !== undefined) updateData.circle_rate = circle_rate === '' ? null : (parseFloat(circle_rate) || 0);
  if (firm_name !== undefined) updateData.firm_name = firm_name ? firm_name.trim().toUpperCase() : null;
  if (seller_name !== undefined) updateData.seller_name = seller_name ? seller_name.trim().toUpperCase() : null;
  if (created_entry_date !== undefined) updateData.created_entry_date = created_entry_date || null;
  if (bank_amount !== undefined) updateData.bank_amount = bank_amount === '' ? null : (parseFloat(bank_amount) || 0);
  if (registry_payment !== undefined) updateData.registry_payment = parseFloat(registry_payment) || 0;
  if (notes !== undefined) updateData.notes = notes ? notes.trim() : null;
  if (req.body.assigned_admin_id !== undefined) updateData.assigned_admin_id = req.body.assigned_admin_id ? parseInt(req.body.assigned_admin_id) : null;

  if (Object.keys(updateData).length === 0) return res.status(400).json({ message: 'Nothing to update' });

  const prospectivePlotId = updateData.plot_id !== undefined ? updateData.plot_id : existing.plot_id;
  const prospectivePlotNo = updateData.plot_no !== undefined ? updateData.plot_no : existing.plot_no;
  const normalizedProspectivePlotId = Number.isInteger(parseInt(prospectivePlotId)) ? parseInt(prospectivePlotId) : null;
  const normalizedExistingPlotId = Number.isInteger(parseInt(existing.plot_id)) ? parseInt(existing.plot_id) : null;
  const plotIdentityChanging = normalizedProspectivePlotId !== normalizedExistingPlotId
    || String(prospectivePlotNo || '').trim().toUpperCase()
       !== String(existing.plot_no || '').trim().toUpperCase();
  if (plotIdentityChanging && (existing.noc_generated_at || existing.noc_approved_at)) {
    return res.status(409).json({
      message: 'The registry plot cannot be changed after its NOC has been generated.',
    });
  }
  if (prospectivePlotId) {
    const { rows } = await pool.query('SELECT site_id, plot_no FROM plots WHERE id = $1 LIMIT 1', [prospectivePlotId]);
    if (!rows[0]) return res.status(404).json({ message: 'Plot not found' });
    if (parseInt(rows[0].site_id) !== parseInt(existing.site_id)) {
      return res.status(400).json({ message: 'Selected plot does not belong to the registry site' });
    }
    if (String(rows[0].plot_no || '').trim().toUpperCase() !== String(prospectivePlotNo || '').trim().toUpperCase()) {
      return res.status(400).json({ message: 'Registry plot number does not match the selected plot' });
    }
  }

  if (updateData.plot_id !== undefined && parseInt(existing.plot_id) !== prospectivePlotId) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM plot_registry_payments
        WHERE registry_id = $1 AND source_plot_payment_id IS NOT NULL`,
      [registryId]
    );
    if ((rows[0]?.count || 0) > 0) {
      return res.status(409).json({
        message: 'Remove linked plot payments before changing the registry plot',
      });
    }
  }

  // Keep the registry edit and its plot status transition atomic. Running
  // these against separate pool connections could leave a plot in PENDING NOC
  // even when the registry update failed a constraint or concurrency check.
  const resolvedPlotId = updateData.plot_id !== undefined ? updateData.plot_id : existing.plot_id;
  const client = await pool.connect();
  let updated;
  let plotBumpRes = { rows: [] };
  try {
    await client.query('BEGIN');
    updated = await plotRegistryModel.update(registryId, updateData, client);
    // Plot becomes 'REGISTRY' only via NOC approval (approveRegistryNoc); here
    // we only move a fresh BOOKED plot into the pending stage.
    if (resolvedPlotId) {
      plotBumpRes = await client.query(
        `UPDATE plots SET status = 'PENDING NOC', updated_at = NOW()
          WHERE id = $1 AND UPPER(COALESCE(status, '')) = 'BOOKED'
          RETURNING id`,
        [resolvedPlotId]
      );
    }
    if (plotIdentityChanging && existing.plot_id) {
      await client.query(
        `UPDATE plots p
            SET status = 'BOOKED', updated_at = NOW()
          WHERE p.id = $1
            AND UPPER(COALESCE(p.status, '')) = 'PENDING NOC'
            AND NOT EXISTS (
              SELECT 1 FROM plot_registries pr WHERE pr.plot_id = p.id
            )`,
        [existing.plot_id]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  res.json({ registry: updated, plot_status_updated: (plotBumpRes.rows?.length || 0) > 0 });
});

/** DELETE /registries/:id */
export const deleteRegistry = asyncHandler(async (req, res) => {
  const registryId = parseInt(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, plot_id, site_id, plot_no, noc_approved_at
         FROM plot_registries
        WHERE id = $1
        FOR UPDATE`,
      [registryId]
    );
    const registry = rows[0];
    if (!registry) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Registry not found' });
    }
    if (registry.noc_approved_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: 'An approved registry cannot be deleted. Keep the audit record and use the relevant cancellation workflow.',
      });
    }

    await client.query('DELETE FROM plot_registries WHERE id = $1', [registryId]);
    // A deleted draft must not leave its plot stranded in PENDING NOC. Legacy
    // registries without plot_id use the same site + plot-number resolution as
    // the rest of this module.
    await client.query(
      `UPDATE plots p
          SET status = 'BOOKED', updated_at = NOW()
        WHERE (
          ($1::integer IS NOT NULL AND p.id = $1)
          OR ($1::integer IS NULL AND p.site_id = $2 AND UPPER(p.plot_no) = UPPER($3))
        )
          AND UPPER(COALESCE(p.status, '')) = 'PENDING NOC'
          AND NOT EXISTS (
            SELECT 1
              FROM plot_registries remaining
             WHERE remaining.plot_id = p.id
                OR (remaining.plot_id IS NULL
                    AND remaining.site_id = p.site_id
                    AND UPPER(remaining.plot_no) = UPPER(p.plot_no))
          )`,
      [registry.plot_id, registry.site_id, registry.plot_no]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  res.json({ message: 'Registry deleted' });
});

// ══════════════════════════════════════════════════
//  REGISTRY PAYMENT ENDPOINTS
// ══════════════════════════════════════════════════

/** POST /registries/payments — Create a payment */
export const createRegistryPayment = asyncHandler(async (req, res) => {
  const { registry_id, payment_date, amount, payment_mode, tally_date, tally_amount, notes, source_plot_payment_id } = req.body;

  if (!registry_id) return res.status(400).json({ message: 'Registry is required' });

  const registryIdInt = parseInt(registry_id);
  // Schema check is now memoized at module load — no per-request RTT.
  const hasSourcePlotPaymentCol = await plotRegistryPaymentModel.hasSourcePlotPaymentCol(pool);

  if (source_plot_payment_id && hasSourcePlotPaymentCol) {
    const sourceId = parseInt(source_plot_payment_id);
    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      return res.status(400).json({ message: 'A valid source plot payment is required' });
    }

    // Run all 3 lookups (registry, dup mapping, source payment) IN PARALLEL.
    // Was 4 serial RTTs (registry SELECT + col check + dup SELECT + source SELECT).
    const [registryRes, dupRes, sourceRes] = await Promise.all([
      pool.query(
        `SELECT id, site_id, plot_id, plot_no FROM plot_registries WHERE id = $1`,
        [registryIdInt]
      ),
      pool.query(`SELECT id FROM plot_registry_payments WHERE source_plot_payment_id = $1 LIMIT 1`, [sourceId]),
      pool.query(
        `SELECT pp.id, pp.site_id, pp.plot_id, p.plot_no, pp.date, pp.amount,
                pp.payment_from, pp.payment_type, pp.bank_details, pp.narration,
                pp.cheque_no, pp.cheque_status, pp.bank_account_id
           FROM plot_payments pp
           LEFT JOIN plots p ON p.id = pp.plot_id
          WHERE pp.id = $1
            AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
            AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          LIMIT 1`,
        [sourceId]
      ),
    ]);

    const registry = registryRes.rows[0];
    if (!registry) return res.status(404).json({ message: 'Registry not found' });
    if (dupRes.rows.length > 0) {
      return res.status(200).json({ skipped: true, message: 'Plot payment is already linked in registry', payment: null });
    }
    const sourcePayment = sourceRes.rows[0];
    if (!sourcePayment) {
      return res.status(400).json({
        message: 'Selected plot payment is not found, approved, or cheque-cleared',
      });
    }
    if (parseInt(sourcePayment.site_id) !== parseInt(registry.site_id)) {
      return res.status(400).json({ message: 'Selected plot payment does not belong to same site' });
    }
    const sourceMatchesPlot = registry.plot_id
      ? parseInt(sourcePayment.plot_id) === parseInt(registry.plot_id)
      : String(sourcePayment.plot_no || '').trim().toUpperCase()
        === String(registry.plot_no || '').trim().toUpperCase();
    if (!sourceMatchesPlot) {
      return res.status(400).json({ message: 'Selected payment belongs to a different plot' });
    }

    const linkedData = {
      registry_id: registryIdInt,
      site_id: registry.site_id,
      payment_date: sourcePayment.date || null,
      amount: parseFloat(sourcePayment.amount) || 0,
      payment_mode: sourcePayment.payment_type ? sourcePayment.payment_type.trim().toUpperCase() : null,
      tally_date: sourcePayment.date || null,
      tally_amount: parseFloat(sourcePayment.amount) || 0,
      notes: sourcePayment.narration ? sourcePayment.narration.trim().toUpperCase() : (sourcePayment.bank_details ? sourcePayment.bank_details.trim().toUpperCase() : 'LINKED FROM PLOT PAYMENT'),
      source_plot_payment_id: sourceId,
      cheque_no: sourcePayment.cheque_no || null,
      cheque_status: sourcePayment.cheque_status || null,
      bank_account_id: sourcePayment.bank_account_id || null,
      created_by: req.user.id,
      assigned_admin_id: req.body.assigned_admin_id ? parseInt(req.body.assigned_admin_id) : null,
    };
    const linkedPayment = await plotRegistryPaymentModel.create(linkedData, pool);
    return res.status(201).json({ payment: linkedPayment, linked: true });
  }

  // ── Non-linked payment: registry lookup + INSERT in parallel(ish). ──
  const registryRes = await pool.query(
    `SELECT id, site_id FROM plot_registries WHERE id = $1`,
    [registryIdInt]
  );
  const registry = registryRes.rows[0];
  if (!registry) return res.status(404).json({ message: 'Registry not found' });

  const normalizedMode = payment_mode ? payment_mode.trim().toUpperCase() : null;
  const isCheque = classifyPaymentMode(normalizedMode) === 'cheque';
  const selectedBankAccountId = await resolveBankAccountSelection({
    siteId: registry.site_id,
    paymentMode: normalizedMode,
    bankAccountId: req.body.bank_account_id,
  });
  const data = {
    registry_id: registryIdInt,
    site_id: registry.site_id,
    payment_date: payment_date || null,
    amount: parseFloat(amount) || 0,
    payment_mode: normalizedMode,
    tally_date: tally_date || null,
    tally_amount: tally_amount !== undefined && tally_amount !== '' ? parseFloat(tally_amount) : null,
    notes: notes ? notes.trim().toUpperCase() : null,
    assigned_admin_id: req.body.assigned_admin_id ? parseInt(req.body.assigned_admin_id) : null,
    created_by: req.user.id,
    cheque_no: isCheque && req.body.cheque_no ? String(req.body.cheque_no).trim() : null,
    cheque_status: isCheque ? 'PENDING' : null,
    bank_account_id: selectedBankAccountId,
  };
  if (hasSourcePlotPaymentCol) data.source_plot_payment_id = null;

  const payment = await plotRegistryPaymentModel.create(data, pool);
  res.status(201).json({ payment });
});

/** GET /registries/payments/list?registry_id=X */
export const listRegistryPayments = asyncHandler(async (req, res) => {
  const { registry_id } = req.query;
  if (!registry_id) return res.status(400).json({ message: 'registry_id is required' });

  const [payments, registry] = await Promise.all([
    plotRegistryPaymentModel.findByRegistryId(parseInt(registry_id), pool),
    plotRegistryModel.findByIdWithTotals(parseInt(registry_id), pool),
  ]);

  res.json({ payments, registry });
});

/** GET /registries/payments/:id */
export const getRegistryPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const payment = await plotRegistryPaymentModel.findById(parseInt(id), pool);
  if (!payment) return res.status(404).json({ message: 'Payment not found' });
  res.json({ payment });
});

/** PUT /registries/payments/:id */
export const updateRegistryPayment = asyncHandler(async (req, res) => {
  const paymentId = parseInt(req.params.id);
  const { payment_date, amount, payment_mode, tally_date, tally_amount, notes, cheque_no, bank_account_id } = req.body;

  const existing = await plotRegistryPaymentModel.findById(paymentId, pool);
  if (!existing) return res.status(404).json({ message: 'Payment not found' });
  if (existing.source_plot_payment_id) {
    return res.status(409).json({
      message: 'Linked registry rows mirror their source Plot Payment and cannot be edited independently',
    });
  }

  const updateData = {};
  if (payment_date !== undefined) updateData.payment_date = payment_date;
  if (amount !== undefined) updateData.amount = parseFloat(amount) || 0;
  const currentMode = existing.payment_mode || null;
  const nextMode = payment_mode !== undefined
    ? (payment_mode ? payment_mode.trim().toUpperCase() : null)
    : currentMode;
  const currentIsCheque = classifyPaymentMode(currentMode) === 'cheque';
  const nextIsCheque = classifyPaymentMode(nextMode) === 'cheque';
  if (payment_mode !== undefined || bank_account_id !== undefined) {
    updateData.bank_account_id = await resolveBankAccountSelection({
      siteId: existing.site_id,
      paymentMode: nextMode,
      bankAccountId: bank_account_id !== undefined ? bank_account_id : existing.bank_account_id,
    });
  }
  if (payment_mode !== undefined) {
    updateData.payment_mode = nextMode;
    updateData.cheque_status = nextIsCheque
      ? (currentIsCheque ? existing.cheque_status || 'PENDING' : 'PENDING')
      : null;
    updateData.cheque_no = nextIsCheque
      ? (cheque_no !== undefined
          ? (cheque_no ? String(cheque_no).trim() : null)
          : (currentIsCheque ? existing.cheque_no || null : null))
      : null;
  } else if (cheque_no !== undefined) {
    updateData.cheque_no = currentIsCheque && cheque_no ? String(cheque_no).trim() : null;
  }
  if (tally_date !== undefined) updateData.tally_date = tally_date || null;
  if (tally_amount !== undefined) updateData.tally_amount = tally_amount !== '' ? parseFloat(tally_amount) : null;
  if (notes !== undefined) updateData.notes = notes ? notes.trim().toUpperCase() : null;
  if (req.body.assigned_admin_id !== undefined) updateData.assigned_admin_id = req.body.assigned_admin_id ? parseInt(req.body.assigned_admin_id) : null;

  if (Object.keys(updateData).length === 0) return res.status(400).json({ message: 'Nothing to update' });

  const updated = await plotRegistryPaymentModel.update(paymentId, updateData, pool);
  res.json({ payment: updated });
});

/** DELETE /registries/payments/:id */
export const deleteRegistryPayment = asyncHandler(async (req, res) => {
  // Atomic DELETE — saves a SELECT round-trip.
  const result = await pool.query(
    `DELETE FROM plot_registry_payments WHERE id = $1 RETURNING id`,
    [parseInt(req.params.id)]
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Payment not found' });
  res.json({ message: 'Payment deleted' });
});

/** GET /registries/autocomplete?site_id=X */
export const getRegistryAutocomplete = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const data = await plotRegistryPaymentModel.getAutocomplete(parseInt(site_id), pool);
  res.json(data);
});

// ══════════════════════════════════════════════════
//  NOC (NO OBJECTION CERTIFICATE) ENDPOINTS
// ══════════════════════════════════════════════════

/** Aggregate payload for the NOC workspace + print page in one round trip:
 *  registry, resolved plot, site, letterhead (booking module's shared
 *  project_settings, if present), every plot payment with its NOC link
 *  state, and the NOC-only inline payments. */
const buildNocPayload = async (registryId) => {
  const registry = await plotRegistryModel.findByIdWithTotals(registryId, pool);
  if (!registry) return null;

  const plotPromise = registry.plot_id
    ? pool.query(`SELECT * FROM plots WHERE id = $1`, [registry.plot_id])
    : pool.query(
        `SELECT * FROM plots WHERE site_id = $1 AND UPPER(plot_no) = UPPER($2) ORDER BY id DESC LIMIT 1`,
        [registry.site_id, registry.plot_no]
      );
  const sitePromise = pool.query(
    `SELECT id, name, code, address, city, state FROM sites WHERE id = $1`,
    [registry.site_id]
  );
  // Letterhead comes from the booking module's project_settings table (same
  // DB). Optional — swallow errors so a missing table never breaks the NOC.
  const letterheadPromise = pool
    .query(
      `SELECT company_legal_name, company_brand_name, company_address, company_city,
              company_phone, company_email, company_gstin, company_website, logo_url
         FROM project_settings WHERE site_id = $1 LIMIT 1`,
      [registry.site_id]
    )
    .catch(() => ({ rows: [] }));
  const inlinePromise = pool.query(
    `SELECT prp.*, u.name AS created_by_name
       FROM plot_registry_payments prp
       LEFT JOIN users u ON u.id = prp.created_by
      WHERE prp.registry_id = $1 AND prp.source_plot_payment_id IS NULL
        AND UPPER(COALESCE(prp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
      ORDER BY prp.payment_date ASC, prp.created_at ASC`,
    [registryId]
  );
  const workflowOverridePromise = isRegistryWorkflowUnlocked(registry.site_id);

  const [plotRes, siteRes, letterheadRes, inlineRes, workflowUnlocked] = await Promise.all([
    plotPromise, sitePromise, letterheadPromise, inlinePromise, workflowOverridePromise,
  ]);
  const plot = plotRes.rows[0] || null;
  const site = siteRes.rows[0] || null;

  let plotPayments = [];
  if (plot) {
    const payRes = await pool.query(
      `SELECT pp.id, pp.date, pp.amount, pp.payment_type, pp.payment_from, pp.bank_name,
              pp.branch, pp.bank_details, pp.narration, pp.received_by, pp.cheque_status,
              pp.cheque_no, pp.created_at,
              prp.id AS registry_payment_id,
              prp.registry_id AS linked_registry_id,
              (prp.registry_id = $2 AND COALESCE(prp.include_in_noc, FALSE)) AS included
         FROM plot_payments pp
         LEFT JOIN plot_registry_payments prp ON prp.source_plot_payment_id = pp.id
        WHERE pp.plot_id = $1
          AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
          AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
        ORDER BY pp.date ASC, pp.created_at ASC`,
      [plot.id, registryId]
    );
    plotPayments = payRes.rows;
  }
  const inlinePayments = inlineRes.rows;

  const includedPlot = plotPayments.filter((p) => p.included);
  const includedInline = inlinePayments.filter((p) => p.include_in_noc);
  const includedAmount =
    includedPlot.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0) +
    includedInline.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);

  const suggestedNocNo =
    registry.noc_no ||
    `NOC/${String(site?.code || 'RG').toUpperCase()}/${new Date().getFullYear()}/${String(registry.id).padStart(4, '0')}`;

  // Signed verify QR target — same HMAC scheme/secret as the payment
  // receipts, so it validates on the public Defence Garden verify page.
  const verifyUrl = buildVerifyUrl({
    t: ReceiptType.NOC,
    i: registry.id,
    pn: registry.customer_name || plot?.buyer_name || null,
    pl: registry.plot_no || null,
    a: includedAmount,
    d: registry.noc_date || registry.registry_date || new Date().toISOString().split('T')[0],
    pm: 'NOC',
    sn: site?.name || null,
    sy: site?.city || null,
    ss: site?.state || null,
    rf: registry.noc_no || suggestedNocNo,
  });

  return {
    registry,
    plot,
    site,
    letterhead: letterheadRes.rows[0] || null,
    plotPayments,
    inlinePayments,
    workflow_unlocked: workflowUnlocked,
    suggested_noc_no: suggestedNocNo,
    verifyUrl,
    totals: {
      included_count: includedPlot.length + includedInline.length,
      included_amount: includedAmount,
    },
  };
};

/** PUT /registries/:id/noc/approve — approve a generated NOC.
 *  This is the ONLY place a plot is promoted to 'REGISTRY' status:
 *  registry created -> plot 'PENDING NOC' -> NOC generated -> approved here -> 'REGISTRY'. */
export const approveRegistryNoc = asyncHandler(async (req, res) => {
  const registryId = parseInt(req.params.id);
  const client = await pool.connect();
  let updated;
  let plotStatusUpdated = false;
  let workflowUnlocked = false;

  try {
    await client.query('BEGIN');

    // Lock the registry row so two approval requests cannot both pass the
    // preconditions. Registry approval and plot promotion then commit or roll
    // back together.
    const { rows } = await client.query(
      `SELECT pr.*,
              COALESCE((
                SELECT SUM(${REGISTRY_PAYMENT_AMOUNT_SQL})
                  FROM plot_registry_payments prp
                  LEFT JOIN plot_payments pp ON pp.id = prp.source_plot_payment_id
                 WHERE prp.registry_id = pr.id
                   AND (
                     prp.source_plot_payment_id IS NULL
                     OR (pr.plot_id IS NOT NULL AND pp.plot_id = pr.plot_id)
                     OR (
                       pr.plot_id IS NULL
                       AND EXISTS (
                         SELECT 1 FROM plots target
                          WHERE target.id = pp.plot_id
                            AND target.site_id = pr.site_id
                            AND UPPER(target.plot_no) = UPPER(pr.plot_no)
                       )
                     )
                   )
                   AND ${REGISTRY_PAYMENT_ELIGIBILITY_SQL}
              ), 0)::numeric AS total_paid
         FROM plot_registries pr
        WHERE pr.id = $1
        FOR UPDATE OF pr`,
      [registryId]
    );
    const registry = rows[0];
    if (!registry) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Registry not found' });
    }
    if (!registry.noc_generated_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Generate the NOC first — approval comes after generation' });
    }
    if (registry.noc_approved_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'NOC is already approved' });
    }

    workflowUnlocked = await readRegistryWorkflowUnlocked(client, registry.site_id);
    // Payment-clear gate (defense in depth — generation is gated the same way).
    const approveDue = (parseFloat(registry.registry_payment) || 0) - (parseFloat(registry.total_paid) || 0);
    if (!workflowUnlocked && approveDue > 0.005) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `NOC can only be approved after full payment — ₹${approveDue.toLocaleString('en-IN')} is still due`,
      });
    }

    const approvalResult = await client.query(
      `UPDATE plot_registries
          SET noc_approved_at = NOW(), noc_approved_by = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [registryId, req.user.id]
    );
    updated = approvalResult.rows[0];

    // Older registries may not carry plot_id. Resolve those records by their
    // immutable site + plot number pair and promote only the newest match.
    const plotResult = await client.query(
      `WITH target_plot AS (
         SELECT id
           FROM plots
          WHERE ($1::integer IS NOT NULL AND id = $1)
             OR ($1::integer IS NULL AND site_id = $2 AND UPPER(plot_no) = UPPER($3))
          ORDER BY id DESC
          LIMIT 1
       )
       UPDATE plots p
          SET status = 'REGISTRY', updated_at = NOW()
         FROM target_plot target
        WHERE p.id = target.id
          AND UPPER(COALESCE(p.status, '')) != 'REGISTRY'
        RETURNING p.id`,
      [registry.plot_id, registry.site_id, registry.plot_no]
    );
    plotStatusUpdated = plotResult.rows.length > 0;

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  res.json({ registry: updated, plot_status_updated: plotStatusUpdated, workflow_unlocked: workflowUnlocked });
});

/** GET /registries/:id/noc — one-shot NOC payload */
export const getRegistryNoc = asyncHandler(async (req, res) => {
  const payload = await buildNocPayload(parseInt(req.params.id));
  if (!payload) return res.status(404).json({ message: 'Registry not found' });
  res.json(payload);
});

/** PUT /registries/:id/noc — batch-save NOC meta + payment selections.
 *  Body: { noc_no, noc_date, noc_place, noc_notes,
 *          included_plot_payment_ids: [plotPaymentId, ...],
 *          inline_payments: [{ id?, payment_date, amount, payment_mode, bank_account_id, notes, cheque_no, include_in_noc }] }
 *  Toggling a plot payment ON links it to the registry (reusing the
 *  payment-assign infra); toggling OFF keeps the link but flags it out of
 *  the NOC, so registry accounting is never silently deleted. */
export const saveRegistryNoc = asyncHandler(async (req, res) => {
  const registryId = parseInt(req.params.id);
  const { noc_no, noc_date, noc_place, noc_notes, included_plot_payment_ids, inline_payments } = req.body;

  const registry = await plotRegistryModel.findById(registryId, pool);
  if (!registry) return res.status(404).json({ message: 'Registry not found' });
  const workflowUnlocked = await isRegistryWorkflowUnlocked(registry.site_id);

  const includedIds = Array.isArray(included_plot_payment_ids)
    ? included_plot_payment_ids.map((n) => parseInt(n)).filter(Number.isFinite)
    : null;
  const today = new Date().toISOString().split('T')[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── NOC meta on the registry ──
    const sets = [];
    const vals = [];
    const push = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
    if (noc_no !== undefined) push('noc_no', noc_no ? String(noc_no).trim().toUpperCase() : null);
    if (noc_date !== undefined) push('noc_date', noc_date || null);
    if (noc_place !== undefined) push('noc_place', noc_place ? String(noc_place).trim().toUpperCase() : null);
    if (noc_notes !== undefined) push('noc_notes', noc_notes ? String(noc_notes).trim() : null);
    sets.push('noc_generated_at = NOW()', 'updated_at = NOW()');
    vals.push(registryId);
    await client.query(`UPDATE plot_registries SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);

    // ── Sync plot-payment selections ──
    if (includedIds) {
      // Reset source-linked selections first. Only receipts belonging to this
      // registry's plot are allowed to be switched back on below.
      await client.query(
        `UPDATE plot_registry_payments
            SET include_in_noc = FALSE, updated_at = NOW()
          WHERE registry_id = $1
            AND source_plot_payment_id IS NOT NULL
            AND include_in_noc = TRUE`,
        [registryId]
      );
      await client.query(
        `UPDATE plot_registry_payments prp
            SET include_in_noc = TRUE, updated_at = NOW()
           FROM plot_payments pp
          WHERE prp.registry_id = $1
            AND prp.source_plot_payment_id = pp.id
            AND prp.source_plot_payment_id = ANY($2::int[])
            AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
            AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
            AND (
              ($3::integer IS NOT NULL AND pp.plot_id = $3)
              OR (
                $3::integer IS NULL
                AND EXISTS (
                  SELECT 1 FROM plots target
                   WHERE target.id = pp.plot_id
                     AND target.site_id = $4
                     AND UPPER(target.plot_no) = UPPER($5)
                )
              )
            )`,
        [registryId, includedIds, registry.plot_id || null, registry.site_id, registry.plot_no]
      );
      // Link payments that aren't assigned to any registry yet.
      await client.query(
         `INSERT INTO plot_registry_payments (
           registry_id, site_id, payment_date, amount, payment_mode, tally_date, tally_amount,
           notes, source_plot_payment_id, include_in_noc, cheque_no, cheque_status, created_by, bank_account_id
         )
         SELECT $1, pp.site_id, COALESCE(pp.date, CURRENT_DATE), pp.amount,
                UPPER(COALESCE(NULLIF(TRIM(pp.payment_type), ''), 'BANK')),
                pp.date, pp.amount,
                COALESCE(NULLIF(UPPER(TRIM(pp.narration)), ''), NULLIF(UPPER(TRIM(pp.bank_details)), ''), 'LINKED FROM PLOT PAYMENT'),
                pp.id, TRUE, pp.cheque_no, pp.cheque_status, $3, pp.bank_account_id
           FROM plot_payments pp
          WHERE pp.id = ANY($2::int[])
            AND pp.site_id = $4
            AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
            AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
            AND (
              ($5::integer IS NOT NULL AND pp.plot_id = $5)
              OR (
                $5::integer IS NULL
                AND EXISTS (
                  SELECT 1 FROM plots target
                   WHERE target.id = pp.plot_id
                     AND target.site_id = $4
                     AND UPPER(target.plot_no) = UPPER($6)
                )
              )
            )
            AND NOT EXISTS (SELECT 1 FROM plot_registry_payments x WHERE x.source_plot_payment_id = pp.id)`,
        [
          registryId,
          includedIds,
          req.user.id,
          registry.site_id,
          registry.plot_id || null,
          registry.plot_no,
        ]
      );
    }

    // ── Inline (NOC-only) payments — upsert ──
    if (Array.isArray(inline_payments)) {
      for (const row of inline_payments) {
        const amount = parseFloat(row.amount) || 0;
        const include = row.include_in_noc === undefined ? true : !!row.include_in_noc;
        const mode = row.payment_mode ? String(row.payment_mode).trim().toUpperCase() : null;
        const isCheque = classifyPaymentMode(mode) === 'cheque';
        const selectedBankAccountId = await resolveBankAccountSelection({
          siteId: registry.site_id,
          paymentMode: mode,
          bankAccountId: row.bank_account_id,
          db: client,
        });
        if (row.id) {
          await client.query(
            `UPDATE plot_registry_payments
                SET payment_date = $2, amount = $3, payment_mode = $4, notes = $5,
                    bank_account_id = $9,
                    cheque_no = CASE
                      WHEN ledger_bucket($4::text) = 'cheque' THEN $8
                      ELSE NULL
                    END,
                    cheque_status = CASE
                      WHEN ledger_bucket($4::text) <> 'cheque' THEN NULL
                      WHEN ledger_bucket(payment_mode) = 'cheque'
                        THEN COALESCE(NULLIF(UPPER(TRIM(cheque_status)), ''), 'PENDING')
                      ELSE 'PENDING'
                    END,
                    include_in_noc = CASE
                      WHEN ledger_bucket($4::text) = 'cheque'
                           AND ledger_bucket(payment_mode) = 'cheque'
                           AND UPPER(COALESCE(cheque_status, '')) IN ('BOUNCED', 'RETURNED')
                        THEN FALSE
                      ELSE $6
                    END,
                    updated_at = NOW()
              WHERE id = $1 AND registry_id = $7 AND source_plot_payment_id IS NULL`,
            [
              parseInt(row.id), row.payment_date || today, amount, mode,
              row.notes ? String(row.notes).trim().toUpperCase() : null, include, registryId,
              isCheque && row.cheque_no ? String(row.cheque_no).trim() : null,
              selectedBankAccountId,
            ]
          );
        } else if (amount > 0) {
          await client.query(
            `INSERT INTO plot_registry_payments (
               registry_id, site_id, payment_date, amount, payment_mode, notes,
               include_in_noc, cheque_no, cheque_status, created_by, bank_account_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              registryId, registry.site_id, row.payment_date || today, amount, mode,
              row.notes ? String(row.notes).trim().toUpperCase() : null, include,
              isCheque && row.cheque_no ? String(row.cheque_no).trim() : null,
              isCheque ? 'PENDING' : null,
              req.user.id,
              selectedBankAccountId,
            ]
          );
        }
      }
    }

    // ── Payment-clear gate: the NOC may only be generated once the registry is
    // fully paid. Evaluated INSIDE the transaction, after the payment syncs
    // above, so payments added in this very save count toward the total. ──
    const totalRes = await client.query(
      `SELECT COALESCE(SUM(${REGISTRY_PAYMENT_AMOUNT_SQL}), 0)::numeric AS total_paid
         FROM plot_registry_payments prp
         LEFT JOIN plot_payments pp ON pp.id = prp.source_plot_payment_id
        WHERE prp.registry_id = $1
          AND (
            prp.source_plot_payment_id IS NULL
            OR ($2::integer IS NOT NULL AND pp.plot_id = $2)
            OR (
              $2::integer IS NULL
              AND EXISTS (
                SELECT 1 FROM plots target
                 WHERE target.id = pp.plot_id
                   AND target.site_id = $3
                   AND UPPER(target.plot_no) = UPPER($4)
              )
            )
          )
          AND ${REGISTRY_PAYMENT_ELIGIBILITY_SQL}`,
      [registryId, registry.plot_id || null, registry.site_id, registry.plot_no]
    );
    const totalPaid = parseFloat(totalRes.rows[0]?.total_paid) || 0;
    const due = (parseFloat(registry.registry_payment) || 0) - totalPaid;
    if (!workflowUnlocked && due > 0.005) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `NOC can only be generated after full payment — ₹${due.toLocaleString('en-IN')} is still due against this registry`,
        due,
      });
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const payload = await buildNocPayload(registryId);
  res.json(payload);
});

// ══════════════════════════════════════════════════
//  DOCUMENT HANDOVER ENDPOINTS
// ══════════════════════════════════════════════════

/** GET /registries/:id/handovers — handover timeline (newest first) */
export const listRegistryHandovers = asyncHandler(async (req, res) => {
  const registryId = parseInt(req.params.id);
  const { rows } = await pool.query(
    `SELECT h.*, COALESCE(u.name, u.email) AS given_by_name
       FROM registry_document_handovers h
       LEFT JOIN users u ON u.id = h.given_by
      WHERE h.registry_id = $1
      ORDER BY h.given_at DESC, h.id DESC`,
    [registryId]
  );
  res.json({ handovers: rows });
});

/** POST /registries/:id/handovers — record an (offline) handover of the
 *  registry documents to the customer. Gated: the registry document must be
 *  uploaded first. Body: { given_to, notes, photo_url, given_at } —
 *  photo_url comes from the client-side /upload/single?provider=s3 flow. */
export const createRegistryHandover = asyncHandler(async (req, res) => {
  const registryId = parseInt(req.params.id);
  const { given_to, notes, photo_url, given_at } = req.body;

  if (!given_to || !String(given_to).trim()) {
    return res.status(400).json({ message: 'Recipient name is required' });
  }

  const registry = await plotRegistryModel.findById(registryId, pool);
  if (!registry) return res.status(404).json({ message: 'Registry not found' });
  const workflowUnlocked = await isRegistryWorkflowUnlocked(registry.site_id);

  // Match by FK or (site, plot_no) fallback — same resolution as the
  // REGISTRY doc-upload gate, so null-plot_id registries aren't blocked.
  if (!workflowUnlocked) {
    const docRes = await pool.query(
      `SELECT 1 FROM documents d
         JOIN plots p ON p.id = d.plot_id
        WHERE UPPER(COALESCE(d.category, '')) = 'REGISTRY'
          AND COALESCE(d.uploaded_source, 'BOOKING') <> 'DMS'
          AND (p.id = $1 OR (p.site_id = $2 AND UPPER(p.plot_no) = UPPER($3)))
        LIMIT 1`,
      [registry.plot_id, registry.site_id, registry.plot_no]
    );
    if (!docRes.rows.length) {
      return res.status(409).json({
        code: 'REGISTRY_DOCUMENT_REQUIRED',
        message: 'Upload the registry deed before recording a handover, or enable the workflow override in Settings',
      });
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO registry_document_handovers (registry_id, site_id, given_to, notes, photo_url, given_by, given_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamp, NOW()))
     RETURNING *`,
    [
      registryId, registry.site_id,
      String(given_to).trim().toUpperCase(),
      notes ? String(notes).trim() : null,
      photo_url ? String(photo_url).trim() : null,
      req.user.id,
      given_at || null,
    ]
  );
  const handover = rows[0];
  handover.given_by_name = req.user.name || req.user.email || null;
  res.status(201).json({ handover, workflow_unlocked: workflowUnlocked });
});
