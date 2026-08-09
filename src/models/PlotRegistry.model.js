import MasterModel from './MasterModel.js';

// Registry payments are informational mappings, not ledger movements. For
// registry/NOC totals, an inline mapping is eligible unless its own cheque was
// bounced/returned; a linked mapping must follow the authoritative plot receipt
// and is eligible only after approval and cheque clearance.
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

// Memoized existence check for the handover table (migration 068) so the list
// endpoint keeps working on databases where the migration hasn't run yet —
// same pattern as the source_plot_payment_id column check below.
let _hasHandoverTable = null;
const _resolveHandoverTableOnce = async (pool) => {
  if (_hasHandoverTable !== null) return _hasHandoverTable;
  try {
    const r = await pool.query(`SELECT to_regclass('registry_document_handovers') IS NOT NULL AS exists`);
    _hasHandoverTable = !!r.rows?.[0]?.exists;
  } catch {
    _hasHandoverTable = false;
  }
  return _hasHandoverTable;
};

// ── Plot Registry Model ──
class PlotRegistryModel extends MasterModel {
  constructor() {
    super('plot_registries');
  }

  /** Has the registry_document_handovers table? Cached after first check. */
  async hasHandoverTable(pool) {
    return _resolveHandoverTableOnce(pool);
  }

  /** All registries for a site with payment aggregates.
   *  Previously: 2 scalar subqueries PER ROW (sum + count). Now: a single
   *  LATERAL aggregation that scans plot_registry_payments once per registry
   *  and computes both numbers in one go. */
  async findBySiteId(siteId, pool) {
    const hasHandovers = await _resolveHandoverTableOnce(pool);
    const handoverSelect = hasHandovers
      ? `COALESCE(ho.handover_count, 0) AS handover_count,
        ho.last_handover_at,`
      : `0 AS handover_count,
        NULL::timestamp AS last_handover_at,`;
    const handoverJoin = hasHandovers
      ? `LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS handover_count, MAX(h.given_at) AS last_handover_at
        FROM registry_document_handovers h
        WHERE h.registry_id = pr.id
      ) ho ON TRUE`
      : '';
    const query = `
      SELECT pr.*,
        COALESCE(agg.total_paid,    0) AS total_paid,
        COALESCE(agg.payment_count, 0) AS payment_count,
        COALESCE(docs.registry_doc_count, 0) AS registry_doc_count,
        ${handoverSelect}
        p.team AS plot_team,
        p.booking_by AS agent_name,
        COALESCE(m.full_name,pr.customer_name) AS lifecycle_customer_name,
        m.phone AS customer_phone,m.photo AS customer_photo,
        rp.name AS project_name,rpp.name AS phase_name,
        ba.status AS agreement_lifecycle_status,ba.execution_date AS agreement_execution_date,
        pos.id AS possession_id,pos.status AS possession_lifecycle_status,
        pos.scheduled_at AS possession_scheduled_at
      FROM plot_registries pr
      LEFT JOIN plots p ON pr.plot_id = p.id
      LEFT JOIN bookings b ON b.id=pr.booking_id AND b.site_id=pr.site_id
      LEFT JOIN members m ON m.id=COALESCE(pr.allottee_member_id,b.client_member_id) AND m.site_id=pr.site_id
      LEFT JOIN rera_projects rp ON rp.id=pr.rera_project_id AND rp.site_id=pr.site_id AND rp.deleted_at IS NULL
      LEFT JOIN rera_project_phases rpp ON rpp.id=pr.rera_project_phase_id AND rpp.site_id=pr.site_id AND rpp.deleted_at IS NULL
      LEFT JOIN booking_agreements ba ON ba.id=pr.agreement_id
      LEFT JOIN plot_possessions pos ON pos.registry_id=pr.id
      LEFT JOIN LATERAL (
        SELECT
          SUM(${REGISTRY_PAYMENT_AMOUNT_SQL})::numeric AS total_paid,
          COUNT(*)::int            AS payment_count
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
      ) agg ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS registry_doc_count
        FROM documents d
        WHERE d.plot_id = pr.plot_id
          AND UPPER(COALESCE(d.category, '')) = 'REGISTRY'
          AND COALESCE(d.uploaded_source, 'BOOKING') <> 'DMS'
      ) docs ON TRUE
      ${handoverJoin}
      WHERE pr.site_id = $1
      ORDER BY pr.plot_no ASC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /** Check for duplicate plot_no within a site */
  async findByPlotNo(siteId, plotNo, pool) {
    const query = `SELECT * FROM plot_registries WHERE site_id = $1 AND UPPER(plot_no) = UPPER($2)`;
    const result = await pool.query(query, [siteId, plotNo]);
    return result.rows[0];
  }

  /** Get single registry with aggregates (same LATERAL pattern) */
  async findByIdWithTotals(id, pool) {
    const query = `
      SELECT pr.*,
        COALESCE(agg.total_paid,    0) AS total_paid,
        COALESCE(agg.payment_count, 0) AS payment_count,
        COALESCE(m.full_name,pr.customer_name) AS lifecycle_customer_name,
        m.phone AS customer_phone,m.photo AS customer_photo,
        rp.name AS project_name,rpp.name AS phase_name,
        ba.status AS agreement_lifecycle_status,ba.execution_date AS agreement_execution_date,
        pos.id AS possession_id,pos.status AS possession_lifecycle_status,
        pos.scheduled_at AS possession_scheduled_at,pos.possession_date
      FROM plot_registries pr
      LEFT JOIN bookings b ON b.id=pr.booking_id AND b.site_id=pr.site_id
      LEFT JOIN members m ON m.id=COALESCE(pr.allottee_member_id,b.client_member_id) AND m.site_id=pr.site_id
      LEFT JOIN rera_projects rp ON rp.id=pr.rera_project_id AND rp.site_id=pr.site_id AND rp.deleted_at IS NULL
      LEFT JOIN rera_project_phases rpp ON rpp.id=pr.rera_project_phase_id AND rpp.site_id=pr.site_id AND rpp.deleted_at IS NULL
      LEFT JOIN booking_agreements ba ON ba.id=pr.agreement_id
      LEFT JOIN plot_possessions pos ON pos.registry_id=pr.id
      LEFT JOIN LATERAL (
        SELECT
          SUM(${REGISTRY_PAYMENT_AMOUNT_SQL})::numeric AS total_paid,
          COUNT(*)::int            AS payment_count
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
      ) agg ON TRUE
      WHERE pr.id = $1
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }
}

// ── Plot Registry Payment Model ──
// Cache the one-time schema check at module load. The column was added by
// migration 025 and never removed; checking it on every autocomplete call
// burned an extra round-trip for no reason.
let _hasSourcePlotPaymentCol = null;
const _resolveSchemaOnce = async (pool) => {
  if (_hasSourcePlotPaymentCol !== null) return _hasSourcePlotPaymentCol;
  try {
    const r = await pool.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'plot_registry_payments'
          AND column_name = 'source_plot_payment_id'
      ) AS exists
    `);
    _hasSourcePlotPaymentCol = !!r.rows?.[0]?.exists;
  } catch {
    _hasSourcePlotPaymentCol = false;
  }
  return _hasSourcePlotPaymentCol;
};

class PlotRegistryPaymentModel extends MasterModel {
  constructor() {
    super('plot_registry_payments');
  }

  /** Has the source_plot_payment_id column? Cached after first check. */
  async hasSourcePlotPaymentCol(pool) {
    return _resolveSchemaOnce(pool);
  }

  /** All payments for a registry, ordered by date ASC */
  async findByRegistryId(registryId, pool) {
    const query = `
      SELECT prp.*,
             CASE WHEN prp.source_plot_payment_id IS NULL THEN prp.payment_date ELSE pp.date END AS payment_date,
             CASE WHEN prp.source_plot_payment_id IS NULL THEN prp.amount ELSE pp.amount END AS amount,
             CASE WHEN prp.source_plot_payment_id IS NULL THEN prp.payment_mode ELSE pp.payment_type END AS payment_mode,
             CASE WHEN prp.source_plot_payment_id IS NULL THEN prp.tally_date ELSE pp.date END AS tally_date,
             CASE WHEN prp.source_plot_payment_id IS NULL THEN prp.tally_amount ELSE pp.amount END AS tally_amount,
             CASE WHEN prp.source_plot_payment_id IS NULL THEN prp.cheque_no ELSE pp.cheque_no END AS cheque_no,
             CASE WHEN prp.source_plot_payment_id IS NULL THEN prp.cheque_status ELSE pp.cheque_status END AS cheque_status,
             CASE
               WHEN prp.source_plot_payment_id IS NULL THEN prp.notes
               ELSE COALESCE(pp.narration, pp.bank_details, prp.notes)
             END AS notes,
             u.name AS created_by_name,
             CASE
               WHEN prp.source_plot_payment_id IS NULL THEN TRUE
               WHEN pr.plot_id IS NOT NULL THEN pp.plot_id = pr.plot_id
               ELSE EXISTS (
                 SELECT 1 FROM plots target
                  WHERE target.id = pp.plot_id
                    AND target.site_id = pr.site_id
                    AND UPPER(target.plot_no) = UPPER(pr.plot_no)
               )
             END AS plot_matches_registry
      FROM plot_registry_payments prp
      JOIN plot_registries pr ON pr.id = prp.registry_id
      LEFT JOIN plot_payments pp ON pp.id = prp.source_plot_payment_id
      LEFT JOIN users u ON u.id = prp.created_by
      WHERE prp.registry_id = $1
      ORDER BY prp.payment_date ASC, prp.created_at ASC
    `;
    const result = await pool.query(query, [registryId]);
    return result.rows;
  }

  /** Unique autocomplete values for UI.
   *  Previously: 9 round-trips (8 parallel + 1 leading information_schema
   *  check). Two of those queries (clientNames / clientUsers) returned
   *  basically the same data (DISTINCT m.full_name FROM members) — now
   *  derived from the shared `clientUsers` result. */
  async getAutocomplete(siteId, pool) {
    const hasSourcePlotPaymentCol = await _resolveSchemaOnce(pool);

    const recentBankPlotPaymentsQuery = hasSourcePlotPaymentCol
      ? `
        SELECT
          pp.id,
          pp.plot_id,
          p.plot_no,
          p.buyer_name AS customer_name,
          m.phone AS customer_phone,
          pp.date,
          pp.amount,
          pp.payment_type,
          pp.payment_from,
          pp.narration,
          pp.bank_details,
          prp.id AS mapped_registry_payment_id
        FROM plot_payments pp
        LEFT JOIN plots p ON p.id = pp.plot_id
        LEFT JOIN members m ON m.site_id = pp.site_id AND UPPER(m.full_name) = UPPER(COALESCE(p.buyer_name, ''))
        LEFT JOIN plot_registry_payments prp ON prp.source_plot_payment_id = pp.id
        WHERE pp.site_id = $1
          AND (pp.amount IS NOT NULL AND pp.amount > 0)
          AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
          AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
        ORDER BY pp.date DESC, pp.created_at DESC
      `
      : `
        SELECT
          pp.id,
          pp.plot_id,
          p.plot_no,
          p.buyer_name AS customer_name,
          m.phone AS customer_phone,
          pp.date,
          pp.amount,
          pp.payment_type,
          pp.payment_from,
          pp.narration,
          pp.bank_details,
          NULL::INTEGER AS mapped_registry_payment_id
        FROM plot_payments pp
        LEFT JOIN plots p ON p.id = pp.plot_id
        LEFT JOIN members m ON m.site_id = pp.site_id AND UPPER(m.full_name) = UPPER(COALESCE(p.buyer_name, ''))
        WHERE pp.site_id = $1
          AND (pp.amount IS NOT NULL AND pp.amount > 0)
          AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
          AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
        ORDER BY pp.date DESC, pp.created_at DESC
      `;

    // 7 parallel reads (was 8). `clientNames` is derived from the
    // `clientUsers` result on the JS side — they're DISTINCT on the same
    // member rows.
    const [customerNames, farmerNames, paymentModes, plotOptions, clientUsers, firmNames, recentBankPlotPayments] = await Promise.all([
      pool.query(`SELECT DISTINCT customer_name AS val FROM plot_registries WHERE site_id = $1 AND customer_name IS NOT NULL AND customer_name != '' ORDER BY val ASC`, [siteId]),
      pool.query(`SELECT DISTINCT farmer_name AS val FROM plot_registries WHERE site_id = $1 AND farmer_name IS NOT NULL AND farmer_name != '' ORDER BY val ASC`, [siteId]),
      pool.query(`SELECT DISTINCT payment_mode AS val FROM plot_registry_payments WHERE site_id = $1 AND payment_mode IS NOT NULL AND payment_mode != '' ORDER BY val ASC`, [siteId]),
      pool.query(`
        SELECT
          p.id, p.plot_no, p.buyer_name, p.plot_size,
          p.circle_rate, p.to_receive_bank, p.registry_area
        FROM plots p
        WHERE p.site_id = $1
        ORDER BY p.plot_no ASC
      `, [siteId]),
      pool.query(`
        SELECT DISTINCT m.full_name AS name, COALESCE(m.phone, '') AS phone
        FROM members m
        WHERE m.site_id = $1
          AND m.full_name IS NOT NULL AND m.full_name != ''
        ORDER BY name ASC
      `, [siteId]),
      pool.query(`
        SELECT DISTINCT f.name AS val
        FROM firms f
        WHERE f.site_id = $1 AND f.name IS NOT NULL AND f.name != ''
        ORDER BY val ASC
      `, [siteId]),
      pool.query(recentBankPlotPaymentsQuery, [siteId]),
    ]);
    return {
      customerNames: customerNames.rows.map(r => r.val),
      farmerNames: farmerNames.rows.map(r => r.val),
      paymentModes: paymentModes.rows.map(r => r.val),
      plotOptions: plotOptions.rows,
      // Derived locally from clientUsers — saves one full DISTINCT scan
      // of the members table.
      clientNames: clientUsers.rows.map(r => r.name),
      clientUsers: clientUsers.rows,
      firmNames: firmNames.rows.map(r => r.val),
      recentBankPlotPayments: recentBankPlotPayments.rows,
    };
  }
}

export const plotRegistryModel = new PlotRegistryModel();
export const plotRegistryPaymentModel = new PlotRegistryPaymentModel();
