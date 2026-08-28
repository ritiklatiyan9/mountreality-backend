import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { writeComplianceAudit } from '../utils/complianceAccess.js';
import { resolveCollectionGuard } from '../services/collectionGuard.service.js';
import { resolveBankAccountSelection } from '../services/bankAccount.service.js';
import { assertFinancePaymentModeAllowed } from '../services/sitePolicy.service.js';
import {
  isRegistryProjectContextComplete,
  resolveRegistryOperatingPolicy,
} from '../services/registryPolicy.service.js';
import {
  AGREEMENT_TRANSITIONS,
  POSSESSION_TRANSITIONS,
  REGISTRY_TRANSITIONS,
  assertTransition,
  cleanText,
  isoDate,
  money,
  normalizeBookingPayload,
  positiveId,
} from '../services/propertyLifecycle.service.js';

const isAdmin = (req) => ['admin', 'super_admin'].includes(req.user?.role);
// Registry lifecycle actions are exposed from both the property workspace and
// the registry resource. Both routes resolve the same Site, but their access
// middleware stores it under a route-specific key.
const siteIdFrom = (req) => positiveId(
  req.propertyLifecycleSiteId || req.registrySiteId || req.siteContextId,
  'site_id',
);

const businessError = (message, code, statusCode = 409, details = null) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
};

const RERA_REGISTRY_EXECUTION_CONSTRAINTS = new Set([
  'rera_registry_context_required',
  'rera_registry_registered_agreement_required',
  'rera_registry_canonical_receipt_required',
  'rera_registry_professional_metadata_required',
  'rera_registry_controlled_deed_required',
]);

const normalizeRegistryLifecycleConstraint = (error) => {
  if (error?.constraint === 'executed_rera_registry_lifecycle_immutable') {
    return businessError(
      'An executed RERA registry cannot be reopened or downgraded without a controlled reopen workflow',
      'RERA_EXECUTED_REGISTRY_IMMUTABLE',
      409,
    );
  }
  if (!RERA_REGISTRY_EXECUTION_CONSTRAINTS.has(error?.constraint)) return error;
  return businessError(
    'Registry readiness changed while the action was being completed. Refresh the RERA checklist and try again.',
    'RERA_REGISTRY_EXECUTION_NOT_READY',
    409,
    { constraint: error.constraint },
  );
};

const normalizeExecutedAgreementConstraint = (error) => {
  if (error?.constraint !== 'executed_rera_registry_agreement_immutable') return error;
  return businessError(
    'Agreement execution and registration details are immutable after the linked RERA registry is executed',
    'RERA_EXECUTED_AGREEMENT_IMMUTABLE',
    409,
  );
};

const requireAdmin = (req) => {
  if (!isAdmin(req)) throw businessError('Administrator approval is required for this action', 'ADMIN_APPROVAL_REQUIRED', 403);
};

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function lockBooking(db, req, rawId) {
  const bookingId = positiveId(rawId, 'booking_id');
  const siteId = siteIdFrom(req);
  const { rows: contextRows } = await db.query(
    `SELECT b.plot_id FROM bookings b JOIN sites s ON s.id=b.site_id
      WHERE b.id=$1 AND b.site_id=$2 AND b.organization_id=$3 AND s.organization_id=$3`,
    [bookingId, siteId, req.user.organization_id],
  );
  if (!contextRows[0]) throw businessError('Booking not found for the selected Site', 'BOOKING_NOT_FOUND', 404);
  await db.query(`SELECT pg_advisory_xact_lock(96096,$1)`, [contextRows[0].plot_id]);
  const { rows } = await db.query(
    `SELECT b.*,p.plot_no,p.block,p.status AS plot_legacy_status,p.lifecycle_status AS plot_lifecycle_status,
            m.full_name AS primary_allottee_name,m.phone AS primary_allottee_phone
       FROM bookings b
       JOIN plots p ON p.id=b.plot_id AND p.site_id=b.site_id
       LEFT JOIN members m ON m.id=b.client_member_id AND m.site_id=b.site_id
      WHERE b.id=$1 AND b.site_id=$2 AND b.organization_id=$3
      FOR UPDATE OF b,p`,
    [bookingId, siteId, req.user.organization_id],
  );
  if (!rows[0]) throw businessError('Booking not found for the selected Site', 'BOOKING_NOT_FOUND', 404);
  return rows[0];
}

async function loadWorkflowPolicy(db, req, siteId, bookingId = null) {
  if (bookingId) {
    const { rows: pinnedRows } = await db.query(
      `SELECT rv.workflow_policy,p.workflow_policy_overrides,rv.source_review_status,
              rv.id AS ruleset_version_id,rv.version,rv.version_label,r.code AS ruleset_code
         FROM bookings b
         LEFT JOIN site_operating_profile_revisions p
           ON p.id=b.operating_profile_revision_id AND p.organization_id=b.organization_id
          AND p.site_id=b.site_id AND p.deleted_at IS NULL
         LEFT JOIN rera_ruleset_versions rv
           ON rv.id=COALESCE(b.ruleset_version_id,p.ruleset_version_id) AND rv.deleted_at IS NULL
         LEFT JOIN rera_rulesets r
           ON r.id=rv.ruleset_id AND r.deleted_at IS NULL AND r.is_active=TRUE
          AND (r.organization_id IS NULL OR r.organization_id=b.organization_id)
        WHERE b.id=$1 AND b.organization_id=$2 AND b.site_id=$3 LIMIT 1`,
      [bookingId, req.user.organization_id, siteId],
    );
    if (pinnedRows[0]?.ruleset_version_id) return pinnedRows[0];
  }
  const { rows } = await db.query(
    `SELECT rv.workflow_policy,p.workflow_policy_overrides,rv.source_review_status,
            rv.id AS ruleset_version_id,rv.version,rv.version_label,r.code AS ruleset_code
       FROM site_operating_profile_revisions p
       LEFT JOIN rera_ruleset_versions rv ON rv.id=p.ruleset_version_id AND rv.deleted_at IS NULL
       LEFT JOIN rera_rulesets r ON r.id=rv.ruleset_id AND r.deleted_at IS NULL AND r.is_active=TRUE
      WHERE p.organization_id=$1 AND p.site_id=$2 AND p.lifecycle_status='PUBLISHED'
        AND p.effective_to IS NULL AND p.deleted_at IS NULL
      ORDER BY p.revision_number DESC,p.id DESC LIMIT 1`,
    [req.user.organization_id, siteId],
  );
  return rows[0] || null;
}

const deepMerge = (base, override) => {
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const result = object(base) ? structuredClone(base) : {};
  if (!object(override)) return result;
  for (const [key, value] of Object.entries(override)) {
    result[key] = object(value) ? deepMerge(result[key], value) : structuredClone(value);
  }
  return result;
};

const workspaceBaseSql = `
  SELECT p.id AS plot_id,p.plot_no,p.block,p.plot_size,p.plot_size_mtr,p.plot_rate,p.sale_price,
         p.circle_rate,p.to_receive_bank,
         p.status AS legacy_plot_status,p.lifecycle_status,p.project_mapping_status,p.current_booking_id,
         p.rera_project_id,p.rera_project_phase_id,p.agreement_status AS property_agreement_status,
         p.registry_status AS property_registry_status,p.possession_status AS property_possession_status,
         COALESCE(legacy_booking.active_booking_count,0)::int AS legacy_booking_count,
         rp.name AS project_name,rpp.name AS phase_name,
         b.id AS booking_id,b.booking_no,b.booking_date,b.lifecycle_status AS booking_status,
         b.final_consideration,b.agreement_status,b.client_member_id,
         m.full_name AS customer_name,m.phone AS customer_phone,m.photo AS customer_photo,
         COALESCE(pay.received,0) AS received,COALESCE(pay.received_bank,0) AS received_bank,
         COALESCE(pay.received_cash,0) AS received_cash,COALESCE(ref.refunded,0) AS refunded,
         COALESCE(sch.scheduled,0) AS scheduled,COALESCE(sch.overdue,0) AS overdue,
         GREATEST(COALESCE(b.final_consideration,p.sale_price,0)-COALESCE(pay.received,0)+COALESCE(ref.refunded,0),0) AS outstanding,
         a.id AS agreement_id,a.status AS latest_agreement_status,a.execution_date,
         pr.id AS registry_id,pr.lifecycle_status AS registry_lifecycle_status,pr.registry_date,
         pr.readiness_result,pr.possession_status AS registry_possession_status,
         pos.id AS possession_id,pos.status AS possession_lifecycle_status,pos.scheduled_at AS possession_scheduled_at
    FROM plots p
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS active_booking_count FROM bookings legacy
       WHERE legacy.plot_id=p.id AND legacy.site_id=p.site_id
         AND COALESCE(legacy.lifecycle_status,'DRAFT') NOT IN ('CANCELLED','TRANSFERRED','CLOSED')
         AND legacy.id<>COALESCE(p.current_booking_id,-1)
    ) legacy_booking ON TRUE
    LEFT JOIN bookings b ON b.id=p.current_booking_id AND b.site_id=p.site_id
    LEFT JOIN members m ON m.id=b.client_member_id AND m.site_id=b.site_id
    LEFT JOIN rera_projects rp ON rp.id=p.rera_project_id AND rp.site_id=p.site_id AND rp.deleted_at IS NULL
    LEFT JOIN rera_project_phases rpp ON rpp.id=p.rera_project_phase_id AND rpp.site_id=p.site_id AND rpp.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(x.amount),0) AS received,
             COALESCE(SUM(x.amount) FILTER (WHERE x.bucket<>'cash'),0) AS received_bank,
             COALESCE(SUM(x.amount) FILTER (WHERE x.bucket='cash'),0) AS received_cash
        FROM (
        SELECT pp.amount,ledger_bucket(pp.payment_type) AS bucket FROM plot_payments pp
         WHERE pp.plot_id=p.id AND LOWER(COALESCE(pp.status,'approved'))='approved'
           AND UPPER(COALESCE(pp.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
           AND pp.reversal_of_payment_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM plot_payments reversal
              WHERE reversal.reversal_of_payment_id=pp.id
                AND LOWER(COALESCE(reversal.status,'approved'))='approved'
                AND UPPER(COALESCE(reversal.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
           )
           AND ((b.id IS NOT NULL AND pp.booking_id=b.id) OR (b.id IS NULL AND pp.booking_id IS NULL))
        UNION ALL
        SELECT pip.amount,ledger_bucket(pip.payment_mode) AS bucket FROM plot_installment_payments pip
         WHERE pip.plot_id=p.id AND UPPER(COALESCE(pip.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
           AND b.id IS NULL
      ) x
    ) pay ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(br.amount),0) AS refunded FROM booking_refunds br
       WHERE br.booking_id=b.id AND br.status='POSTED'
    ) ref ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(pi.amount),0) AS scheduled,
             COALESCE(SUM(GREATEST(pi.amount-COALESCE(pa.allocated,0),0)) FILTER (WHERE pi.due_date<CURRENT_DATE),0) AS overdue
        FROM plot_installments pi
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(ppa.allocated_amount),0) AS allocated
            FROM plot_payment_allocations ppa
            JOIN plot_payments allocated_payment ON allocated_payment.id=ppa.plot_payment_id
           WHERE ppa.installment_id=pi.id
             AND LOWER(COALESCE(allocated_payment.status,'approved'))='approved'
             AND UPPER(COALESCE(allocated_payment.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
        ) pa ON TRUE
       WHERE pi.plot_id=p.id AND pi.superseded_at IS NULL
         AND ((b.id IS NOT NULL AND pi.booking_id=b.id) OR (b.id IS NULL AND pi.booking_id IS NULL))
    ) sch ON TRUE
    LEFT JOIN LATERAL (
      SELECT ba.* FROM booking_agreements ba WHERE ba.booking_id=b.id
       ORDER BY ba.version_number DESC,ba.id DESC LIMIT 1
    ) a ON TRUE
    LEFT JOIN LATERAL (
      SELECT x.* FROM plot_registries x WHERE x.plot_id=p.id
        AND ((b.id IS NOT NULL AND x.booking_id=b.id) OR (b.id IS NULL AND x.booking_id IS NULL))
       ORDER BY x.id DESC LIMIT 1
    ) pr ON TRUE
    LEFT JOIN plot_possessions pos ON pos.registry_id=pr.id
`;

/** GET /property-lifecycle/workspace */
export const listPropertyWorkspace = asyncHandler(async (req, res) => {
  const siteId = siteIdFrom(req);
  const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 200, 1), 250);
  const search = String(req.query.q || '').trim();
  const status = String(req.query.status || '').trim().toUpperCase();
  const sortBy = String(req.query.sort_by || 'property').trim().toLowerCase();
  const sortDirection = String(req.query.sort_order || 'asc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const sortColumns = {
    updated_at: 'p.updated_at', property: 'p.plot_no', customer: 'm.full_name',
    consideration: 'COALESCE(b.final_consideration,p.sale_price,0)',
    agreement: 'COALESCE(a.status,b.agreement_status)', registry: 'pr.lifecycle_status',
  };
  const sortExpression = sortColumns[sortBy] || sortColumns.property;
  const orderExpression = sortBy === 'property'
    ? `REGEXP_REPLACE(UPPER(p.plot_no), '[0-9].*$', '') ${sortDirection},
       NULLIF(REGEXP_REPLACE(p.plot_no, '[^0-9]', '', 'g'), '')::bigint ${sortDirection},
       UPPER(p.plot_no) ${sortDirection}`
    : `${sortExpression} ${sortDirection} NULLS LAST`;
  const projectId = req.query.project_id ? positiveId(req.query.project_id, 'project_id') : null;
  const plotId = req.query.plot_id ? positiveId(req.query.plot_id, 'plot_id') : null;
  const params = [siteId, req.user.organization_id];
  let filters = ' WHERE p.site_id=$1 AND EXISTS (SELECT 1 FROM sites s WHERE s.id=p.site_id AND s.organization_id=$2)';
  if (search) {
    params.push(`%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
    filters += ` AND (p.plot_no ILIKE $${params.length} ESCAPE '\\' OR p.block ILIKE $${params.length} ESCAPE '\\' OR m.full_name ILIKE $${params.length} ESCAPE '\\' OR m.phone ILIKE $${params.length} ESCAPE '\\')`;
  }
  if (status) {
    params.push(status);
    filters += ` AND COALESCE(b.lifecycle_status,p.lifecycle_status,p.status)=$${params.length}`;
  }
  if (projectId) {
    params.push(projectId);
    filters += ` AND p.rera_project_id=$${params.length}`;
  }
  if (plotId) {
    params.push(plotId);
    filters += ` AND p.id=$${params.length}`;
  }
  const countParams = [...params];
  params.push(limit, (page - 1) * limit);
  const [rowsResult, countResult, attentionResult, metricsResult] = await Promise.all([
    pool.query(`${workspaceBaseSql} ${filters} ORDER BY ${orderExpression},p.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
    pool.query(`SELECT COUNT(*)::int AS total FROM (${workspaceBaseSql} ${filters}) workspace`, countParams),
    pool.query(
      `SELECT
         COUNT(DISTINCT b.id) FILTER (WHERE b.agreement_required=TRUE AND b.agreement_status NOT IN ('EXECUTED','CANCELLED'))::int AS agreements_pending,
         COUNT(DISTINCT b.id) FILTER (WHERE overdue.total>0)::int AS overdue_accounts,
         COUNT(DISTINCT c.id) FILTER (WHERE c.status IN ('APPROVED','REFUND_PENDING'))::int AS refunds_pending,
         COUNT(DISTINCT pr.id) FILTER (WHERE pr.lifecycle_status='READY')::int AS registries_ready,
         COUNT(DISTINCT pos.id) FILTER (WHERE pos.status IN ('READY','HANDOVER_SCHEDULED','DOCUMENTS_DELIVERED','ACKNOWLEDGED'))::int AS handovers_pending,
         COUNT(DISTINCT p.id) FILTER (WHERE unmatched.total>0)::int AS unmatched_receipts
       FROM plots p
       LEFT JOIN bookings b ON b.id=p.current_booking_id
       LEFT JOIN booking_cancellations c ON c.booking_id=b.id AND c.status NOT IN ('REJECTED','CLOSED','PROPERTY_RELEASED')
       LEFT JOIN plot_registries pr ON pr.plot_id=p.id
       LEFT JOIN plot_possessions pos ON pos.registry_id=pr.id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(GREATEST(pi.amount-COALESCE(pa.amount,0),0)),0) AS total
           FROM plot_installments pi LEFT JOIN LATERAL (
             SELECT SUM(ppa.allocated_amount) AS amount
               FROM plot_payment_allocations ppa
               JOIN plot_payments allocated_payment ON allocated_payment.id=ppa.plot_payment_id
              WHERE ppa.installment_id=pi.id
                AND LOWER(COALESCE(allocated_payment.status,'approved'))='approved'
                AND UPPER(COALESCE(allocated_payment.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
           ) pa ON TRUE WHERE pi.plot_id=p.id AND pi.due_date<CURRENT_DATE AND pi.superseded_at IS NULL
       ) overdue ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS total FROM plot_payments pp WHERE pp.plot_id=p.id AND pp.reconciliation_status='UNMATCHED'
           AND LOWER(COALESCE(pp.status,'approved'))='approved'
       ) unmatched ON TRUE
      WHERE p.site_id=$1`,
      [siteId],
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE booking_id IS NULL AND legacy_booking_count=0)::int AS available,
         COUNT(*) FILTER (WHERE booking_id IS NOT NULL)::int AS booked,
         COALESCE(SUM(outstanding),0) AS receivables,
         COALESCE(SUM(overdue),0) AS overdue,
         COUNT(*) FILTER (WHERE registry_id IS NOT NULL AND registry_lifecycle_status<>'COMPLETE')::int AS registry,
         COUNT(*) FILTER (WHERE possession_id IS NOT NULL AND possession_lifecycle_status<>'POSSESSED')::int AS possession
       FROM (${workspaceBaseSql}
         WHERE p.site_id=$1 AND EXISTS (
           SELECT 1 FROM sites metric_site WHERE metric_site.id=p.site_id AND metric_site.organization_id=$2
         )
       ) lifecycle_metrics`,
      [siteId, req.user.organization_id],
    ),
  ]);
  res.json({
    rows: rowsResult.rows,
    pagination: { page, limit, total: countResult.rows[0]?.total || 0 },
    needs_attention: attentionResult.rows[0] || {},
    metrics: metricsResult.rows[0] || {},
  });
});

/** GET /property-lifecycle/bookings/:bookingId */
export const getBookingLifecycle = asyncHandler(async (req, res) => {
  const siteId = siteIdFrom(req);
  const bookingId = positiveId(req.params.bookingId, 'booking_id');
  const [bookingResult, allottees, schedule, payments, agreements, registry, cancellations, refunds, transfers, audit] = await Promise.all([
    pool.query(`${workspaceBaseSql} WHERE p.site_id=$1 AND b.id=$2 AND EXISTS (SELECT 1 FROM sites s WHERE s.id=p.site_id AND s.organization_id=$3) LIMIT 1`, [siteId, bookingId, req.user.organization_id]),
    pool.query(`SELECT ba.*,m.full_name,m.phone,m.email,m.photo FROM booking_allottees ba JOIN members m ON m.id=ba.member_id WHERE ba.booking_id=$1 ORDER BY (ba.allottee_role='PRIMARY') DESC,ba.created_at`, [bookingId]),
    pool.query(`SELECT pi.*,COALESCE(pa.allocated,0) AS allocated_amount,GREATEST(pi.amount-COALESCE(pa.allocated,0),0) AS due_amount FROM plot_installments pi LEFT JOIN LATERAL (SELECT SUM(ppa.allocated_amount) AS allocated FROM plot_payment_allocations ppa JOIN plot_payments allocated_payment ON allocated_payment.id=ppa.plot_payment_id WHERE ppa.installment_id=pi.id AND LOWER(COALESCE(allocated_payment.status,'approved'))='approved' AND UPPER(COALESCE(allocated_payment.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')) pa ON TRUE WHERE pi.booking_id=$1 AND pi.superseded_at IS NULL ORDER BY pi.sort_order,pi.due_date,pi.id`, [bookingId]),
    pool.query(`SELECT pp.*,prp.id AS mapped_registry_payment_id,prp.registry_id AS mapped_registry_id,COALESCE(pa.allocations,'[]'::jsonb) AS allocations FROM plot_payments pp LEFT JOIN plot_registry_payments prp ON prp.source_plot_payment_id=pp.id LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id',x.id,'installment_id',x.installment_id,'amount',x.allocated_amount)) AS allocations FROM plot_payment_allocations x WHERE x.plot_payment_id=pp.id) pa ON TRUE WHERE pp.booking_id=$1 ORDER BY pp.date DESC,pp.id DESC`, [bookingId]),
    pool.query(`SELECT ba.*,COALESCE(d.documents,'[]'::jsonb) AS documents FROM booking_agreements ba LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id',x.id,'title',x.title,'category',x.category,'original_name',x.original_name)) AS documents FROM documents x WHERE x.agreement_id=ba.id) d ON TRUE WHERE ba.booking_id=$1 ORDER BY ba.version_number DESC`, [bookingId]),
    pool.query(`SELECT pr.*,pos.id AS possession_id,pos.status AS possession_lifecycle_status,pos.scheduled_at AS possession_scheduled_at,pos.possession_date,pos.checklist,pos.acknowledgement FROM plot_registries pr LEFT JOIN plot_possessions pos ON pos.registry_id=pr.id WHERE pr.booking_id=$1 ORDER BY pr.id DESC LIMIT 1`, [bookingId]),
    pool.query(`SELECT * FROM booking_cancellations WHERE booking_id=$1 ORDER BY created_at DESC`, [bookingId]),
    pool.query(`SELECT br.* FROM booking_refunds br WHERE br.booking_id=$1 ORDER BY br.created_at DESC,br.id DESC`, [bookingId]),
    pool.query(`SELECT bt.*,fm.full_name AS from_name,tm.full_name AS to_name FROM booking_transfers bt JOIN members fm ON fm.id=bt.from_member_id JOIN members tm ON tm.id=bt.to_member_id WHERE bt.booking_id=$1 ORDER BY bt.created_at DESC`, [bookingId]),
    pool.query(`SELECT cal.*,u.name AS user_name FROM compliance_audit_log cal LEFT JOIN users u ON u.id=cal.user_id WHERE cal.organization_id=$1 AND cal.entity_type IN ('PROPERTY_BOOKING','BOOKING_AGREEMENT','BOOKING_CANCELLATION','BOOKING_REFUND','BOOKING_TRANSFER','PLOT_POSSESSION') AND (cal.entity_id=$2 OR cal.new_value->>'booking_id'=$2::text) ORDER BY cal.created_at DESC LIMIT 100`, [req.user.organization_id, bookingId]),
  ]);
  if (!bookingResult.rows[0]) return res.status(404).json({ message: 'Booking not found' });
  res.json({
    booking: bookingResult.rows[0], allottees: allottees.rows, schedule: schedule.rows,
    payments: payments.rows, agreements: agreements.rows, registry: registry.rows[0] || null,
    cancellations: cancellations.rows, refunds: refunds.rows, transfers: transfers.rows, activity: audit.rows,
  });
});

/** PATCH /property-lifecycle/plots/:plotId/mapping */
export const mapPropertyProject = asyncHandler(async (req, res) => {
  const siteId = siteIdFrom(req);
  const plotId = positiveId(req.params.plotId, 'plot_id');
  const mappingStatus = String(req.body.mapping_status || '').toUpperCase();
  if (!['MAPPED', 'UNMAPPED', 'REVIEW_REQUIRED', 'NOT_APPLICABLE'].includes(mappingStatus)) {
    throw businessError('A valid mapping_status is required', 'INVALID_MAPPING_STATUS', 400);
  }
  const projectId = positiveId(req.body.rera_project_id, 'rera_project_id', { optional: true });
  const phaseId = positiveId(req.body.rera_project_phase_id, 'rera_project_phase_id', { optional: true });
  if (mappingStatus === 'MAPPED' && !projectId) throw businessError('A mapped property requires a project', 'PROJECT_REQUIRED', 400);
  if (mappingStatus !== 'MAPPED' && (projectId || phaseId)) throw businessError('Project and phase can only be set when mapping_status is MAPPED', 'MAPPING_STATE_CONFLICT', 400);
  const updated = await inTransaction(async (db) => {
    const { rows } = await db.query(`SELECT p.* FROM plots p JOIN sites s ON s.id=p.site_id WHERE p.id=$1 AND p.site_id=$2 AND s.organization_id=$3 FOR UPDATE OF p`, [plotId, siteId, req.user.organization_id]);
    const previous = rows[0];
    if (!previous) throw businessError('Property not found', 'PROPERTY_NOT_FOUND', 404);
    if (projectId) {
      const { rows: projects } = await db.query(`SELECT p.id,ph.id AS phase_id FROM rera_projects p LEFT JOIN rera_project_phases ph ON ph.id=$4 AND ph.rera_project_id=p.id AND ph.site_id=p.site_id AND ph.deleted_at IS NULL WHERE p.id=$1 AND p.site_id=$2 AND p.organization_id=$3 AND p.deleted_at IS NULL`, [projectId, siteId, req.user.organization_id, phaseId]);
      if (!projects[0] || (phaseId && !projects[0].phase_id)) throw businessError('Project/phase is outside the selected Site', 'PROJECT_SCOPE_MISMATCH', 409);
    }
    const { rows: changed } = await db.query(`UPDATE plots SET rera_project_id=$1,rera_project_phase_id=$2,project_mapping_status=$3,lifecycle_version=lifecycle_version+1,updated_at=NOW() WHERE id=$4 AND site_id=$5 RETURNING *`, [projectId, phaseId, mappingStatus, plotId, siteId]);
    await writeComplianceAudit(db, req, { action: 'PROPERTY_PROJECT_MAPPING_UPDATED', entityType: 'PROPERTY_BOOKING', entityId: plotId, siteId, previousValue: { rera_project_id: previous.rera_project_id, rera_project_phase_id: previous.rera_project_phase_id, mapping_status: previous.project_mapping_status }, newValue: { rera_project_id: projectId, rera_project_phase_id: phaseId, mapping_status: mappingStatus }, reason: req.body.reason });
    return changed[0];
  });
  res.json({ plot: updated });
});

/** POST /property-lifecycle/bookings */
export const createBooking = asyncHandler(async (req, res) => {
  const siteId = siteIdFrom(req);
  const input = normalizeBookingPayload(req.body);
  const booking = await inTransaction(async (db) => {
    if (input.idempotency_key) {
      const { rows: existing } = await db.query(`SELECT * FROM bookings WHERE organization_id=$1 AND site_id=$2 AND idempotency_key=$3 LIMIT 1`, [req.user.organization_id, siteId, input.idempotency_key]);
      if (existing[0]) return existing[0];
    }
    await db.query(`SELECT pg_advisory_xact_lock(96096,$1)`, [input.plot_id]);
    const { rows: plotRows } = await db.query(
      `SELECT p.*,s.organization_id FROM plots p JOIN sites s ON s.id=p.site_id
        WHERE p.id=$1 AND p.site_id=$2 AND s.organization_id=$3 FOR UPDATE OF p`,
      [input.plot_id, siteId, req.user.organization_id],
    );
    const plot = plotRows[0];
    if (!plot) throw businessError('Property not found for the selected Site', 'PROPERTY_NOT_FOUND', 404);
    if (plot.current_booking_id) throw businessError(`${plot.plot_no} was booked while this form was open`, 'PROPERTY_ALREADY_BOOKED');
    const blockedStates = new Set(['REGISTRY', 'POSSESSED', 'REGISTRY_COMPLETE', 'POSSESSION_PENDING']);
    if (blockedStates.has(String(plot.status).toUpperCase()) || blockedStates.has(String(plot.lifecycle_status).toUpperCase())) {
      throw businessError('This property is not available for a new booking', 'PROPERTY_NOT_AVAILABLE');
    }
    const memberIds = [input.primary_allottee_id, ...input.joint_allottee_ids];
    const { rows: members } = await db.query(`SELECT id,full_name FROM members WHERE site_id=$1 AND id=ANY($2::int[]) AND status<>'INACTIVE'`, [siteId, memberIds]);
    if (members.length !== memberIds.length) throw businessError('Every allottee must be an active member of the selected Site', 'ALLOTTEE_SCOPE_MISMATCH', 409);
    if (plot.project_mapping_status === 'MAPPED') {
      if (Number(plot.rera_project_id) !== Number(input.rera_project_id) || Number(plot.rera_project_phase_id || 0) !== Number(input.rera_project_phase_id || 0)) {
        throw businessError('Booking project/phase must match the property mapping', 'PROPERTY_PROJECT_MISMATCH');
      }
    }
    let operatingProfileRevisionId = null;
    let rulesetVersionId = null;
    if (input.rera_project_id) {
      const { rows: projectRows } = await db.query(
        `SELECT rp.operating_profile_revision_id,rp.ruleset_version_id
           FROM rera_projects rp
          WHERE rp.id=$1 AND rp.organization_id=$2 AND rp.site_id=$3 AND rp.deleted_at IS NULL
            AND ($4::bigint IS NULL OR EXISTS (
              SELECT 1 FROM rera_project_phases ph WHERE ph.id=$4 AND ph.rera_project_id=rp.id
                AND ph.organization_id=rp.organization_id AND ph.site_id=rp.site_id AND ph.deleted_at IS NULL
            ))`,
        [input.rera_project_id, req.user.organization_id, siteId, input.rera_project_phase_id],
      );
      if (!projectRows[0]) throw businessError('Booking project/phase is outside the selected Site', 'PROJECT_SCOPE_MISMATCH');
      operatingProfileRevisionId = projectRows[0].operating_profile_revision_id;
      rulesetVersionId = projectRows[0].ruleset_version_id;
    } else {
      const { rows: profileRows } = await db.query(
        `SELECT id,ruleset_version_id FROM site_operating_profile_revisions
          WHERE organization_id=$1 AND site_id=$2 AND lifecycle_status='PUBLISHED'
            AND effective_to IS NULL AND deleted_at IS NULL
          ORDER BY revision_number DESC,id DESC LIMIT 1`,
        [req.user.organization_id, siteId],
      );
      operatingProfileRevisionId = profileRows[0]?.id || null;
      rulesetVersionId = profileRows[0]?.ruleset_version_id || null;
    }
    const primary = members.find((member) => Number(member.id) === input.primary_allottee_id);
    const { rows: inserted } = await db.query(
      `INSERT INTO bookings (
         organization_id,site_id,plot_id,client_member_id,booking_date,sale_price,payment_plan,status,kyc_status,
         buyer_name,notes,created_by,rera_project_id,rera_project_phase_id,commercial_snapshot,base_price,charges,
         discount_amount,final_consideration,price_version,price_effective_date,agreement_required,agreement_status,
         lifecycle_status,idempotency_key,confirmed_by,confirmed_at,operating_profile_revision_id,ruleset_version_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'CONFIRMED','NOT_STARTED',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'NOT_STARTED','BOOKED',$21,$10,NOW(),$22,$23)
       RETURNING *`,
      [req.user.organization_id, siteId, input.plot_id, input.primary_allottee_id, input.booking_date,
        input.final_consideration, input.payment_schedule.length ? 'INSTALLMENT' : 'FULL', primary?.full_name || null,
        input.notes, req.user.id, input.rera_project_id, input.rera_project_phase_id, input.commercial_snapshot,
        input.base_price, input.charges, input.discount_amount, input.final_consideration, input.price_version,
        input.price_effective_date, input.agreement_required, input.idempotency_key,
        operatingProfileRevisionId, rulesetVersionId],
    );
    const created = inserted[0];
    const bookingNo = `BKG-${siteId}-${String(created.id).padStart(6, '0')}`;
    await db.query(`UPDATE bookings SET booking_no=$1 WHERE id=$2`, [bookingNo, created.id]);
    const allotteeValues = memberIds.map((memberId, index) => `($1,$2,$3,$${index + 6},'${index === 0 ? 'PRIMARY' : 'JOINT'}','ACTIVE',$4,$5)`).join(',');
    await db.query(`INSERT INTO booking_allottees (organization_id,site_id,booking_id,member_id,allottee_role,status,effective_from,created_by) VALUES ${allotteeValues}`, [req.user.organization_id, siteId, created.id, input.booking_date, req.user.id, ...memberIds]);
    for (const item of input.payment_schedule) {
      await db.query(
        `INSERT INTO plot_installments (plot_id,booking_id,installment_name,milestone_code,amount,due_date,status,sort_order,rera_project_id,rera_project_phase_id)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9)`,
        [input.plot_id, created.id, item.installment_name, item.milestone_code, item.amount, item.due_date, item.sort_order, input.rera_project_id, input.rera_project_phase_id],
      );
    }
    await db.query(
      `UPDATE plots SET current_booking_id=$1,buyer_name=$2,booking_date=$3,sale_price=$4,
         status='BOOKED',lifecycle_status='BOOKED',agreement_status='NOT_STARTED',financial_status='OUTSTANDING',
         installments_enabled=$5,rera_project_id=COALESCE($6,rera_project_id),
         rera_project_phase_id=CASE WHEN $6::bigint IS NOT NULL THEN $7 ELSE rera_project_phase_id END,
         project_mapping_status=CASE WHEN $6::bigint IS NOT NULL THEN 'MAPPED' ELSE project_mapping_status END,
         lifecycle_version=lifecycle_version+1,updated_at=NOW()
       WHERE id=$8 AND site_id=$9`,
      [created.id, primary?.full_name || null, input.booking_date, input.final_consideration,
        input.payment_schedule.length > 0, input.rera_project_id, input.rera_project_phase_id, input.plot_id, siteId],
    );
    await writeComplianceAudit(db, req, { action: 'PROPERTY_BOOKED', entityType: 'PROPERTY_BOOKING', entityId: created.id, siteId, newValue: { booking_id: created.id, booking_no: bookingNo, plot_id: input.plot_id, primary_allottee_id: input.primary_allottee_id, joint_allottee_ids: input.joint_allottee_ids, commercial_snapshot: input.commercial_snapshot, schedule_items: input.payment_schedule.length } });
    return { ...created, booking_no: bookingNo };
  });
  res.status(201).json({ booking });
});

/** POST /property-lifecycle/bookings/:bookingId/agreements */
export const createAgreementRevision = asyncHandler(async (req, res) => {
  const agreement = await inTransaction(async (db) => {
    const booking = await lockBooking(db, req, req.params.bookingId);
    const { rows: latestRows } = await db.query(`SELECT * FROM booking_agreements WHERE booking_id=$1 ORDER BY version_number DESC,id DESC LIMIT 1 FOR UPDATE`, [booking.id]);
    const previous = latestRows[0] || null;
    if (previous && !['EXECUTED', 'SUPERSEDED', 'CANCELLED'].includes(previous.status)) {
      throw businessError('The current agreement revision is still editable; transition it instead of creating a duplicate', 'ACTIVE_AGREEMENT_EXISTS');
    }
    const type = cleanText(req.body.agreement_type || 'ALLOTMENT_AGREEMENT', 'Agreement type', 80, { required: true });
    const status = String(req.body.status || 'DRAFT').toUpperCase();
    if (!['DRAFT', 'PREPARED'].includes(status)) throw businessError('A new agreement revision must start as DRAFT or PREPARED', 'INVALID_AGREEMENT_STATE', 400);
    const changeReason = cleanText(req.body.change_reason, 'Change reason', 4000, { required: Boolean(previous) });
    if (previous?.status === 'EXECUTED') await db.query(`UPDATE booking_agreements SET status='SUPERSEDED',updated_at=NOW() WHERE id=$1`, [previous.id]);
    const { rows } = await db.query(
      `INSERT INTO booking_agreements (organization_id,site_id,booking_id,plot_id,rera_project_id,rera_project_phase_id,
         version_number,agreement_number,agreement_type,template_version,commercial_snapshot,status,effective_date,
         supersedes_agreement_id,change_reason,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [req.user.organization_id, booking.site_id, booking.id, booking.plot_id, booking.rera_project_id,
        booking.rera_project_phase_id, Number(previous?.version_number || 0) + 1,
        cleanText(req.body.agreement_number, 'Agreement number', 120), type,
        cleanText(req.body.template_version, 'Template version', 80), booking.commercial_snapshot || {}, status,
        isoDate(req.body.effective_date, 'Effective date'), previous?.id || null, changeReason, req.user.id],
    );
    await db.query(`UPDATE bookings SET agreement_status=$1,workflow_version=workflow_version+1,updated_at=NOW() WHERE id=$2`, [status, booking.id]);
    await db.query(`UPDATE plots SET agreement_status=$1,lifecycle_version=lifecycle_version+1,updated_at=NOW() WHERE id=$2`, [status, booking.plot_id]);
    await writeComplianceAudit(db, req, { action: 'AGREEMENT_REVISION_CREATED', entityType: 'BOOKING_AGREEMENT', entityId: rows[0].id, siteId: booking.site_id, previousValue: previous, newValue: { ...rows[0], booking_id: booking.id }, reason: changeReason });
    return rows[0];
  }).catch((error) => {
    throw normalizeExecutedAgreementConstraint(error);
  });
  res.status(201).json({ agreement });
});

/** PATCH /property-lifecycle/agreements/:agreementId/status */
export const transitionAgreement = asyncHandler(async (req, res) => {
  const result = await inTransaction(async (db) => {
    const agreementId = positiveId(req.params.agreementId, 'agreement_id');
    const siteId = siteIdFrom(req);
    const { rows } = await db.query(`SELECT ba.*,b.agreement_required FROM booking_agreements ba JOIN bookings b ON b.id=ba.booking_id WHERE ba.id=$1 AND ba.site_id=$2 AND ba.organization_id=$3 FOR UPDATE OF ba,b`, [agreementId, siteId, req.user.organization_id]);
    const previous = rows[0];
    if (!previous) throw businessError('Agreement not found', 'AGREEMENT_NOT_FOUND', 404);
    const hasRegistrationPatch = [
      'registration_status', 'registration_number', 'registration_date', 'registration_office',
    ].some((field) => Object.prototype.hasOwnProperty.call(req.body || {}, field));
    const requestedStatus = String(
      req.body.status || (previous.status === 'EXECUTED' && hasRegistrationPatch ? 'EXECUTED' : ''),
    ).trim().toUpperCase();
    const registrationOnlyUpdate = previous.status === 'EXECUTED' && requestedStatus === 'EXECUTED';
    const next = registrationOnlyUpdate
      ? 'EXECUTED'
      : assertTransition(AGREEMENT_TRANSITIONS, previous.status, requestedStatus, 'Agreement');
    if (['APPROVED_FOR_EXECUTION', 'EXECUTED'].includes(next)) requireAdmin(req);
    if (next === 'SUPERSEDED') throw businessError('Create a new revision to supersede an executed agreement', 'AGREEMENT_REVISION_REQUIRED');
    const executionDate = next === 'EXECUTED'
      ? isoDate(req.body.execution_date || previous.execution_date, 'Execution date', { required: true })
      : previous.execution_date;
    const registrationStatus = String(
      req.body.registration_status || previous.registration_status || 'NOT_REGISTERED',
    ).trim().toUpperCase();
    if (!['NOT_REGISTERED', 'PENDING', 'REGISTERED'].includes(registrationStatus)) {
      throw businessError('Registration status must be NOT_REGISTERED, PENDING or REGISTERED', 'INVALID_AGREEMENT_REGISTRATION_STATUS', 400);
    }
    if (registrationStatus === 'REGISTERED' && next !== 'EXECUTED') {
      throw businessError('An agreement must be executed before it can be marked registered', 'AGREEMENT_EXECUTION_REQUIRED', 409);
    }
    const registrationNumber = cleanText(
      req.body.registration_number ?? previous.registration_number,
      'Agreement registration number',
      160,
      { required: registrationStatus === 'REGISTERED' },
    );
    const registrationDate = isoDate(
      req.body.registration_date ?? previous.registration_date,
      'Agreement registration date',
      { required: registrationStatus === 'REGISTERED' },
    );
    const registrationOffice = cleanText(
      req.body.registration_office ?? previous.registration_office,
      'Registration office',
      240,
    );
    const dateKey = (value) => value == null
      ? null
      : new Date(value).toISOString().slice(0, 10);
    const legalStateChanging = next !== previous.status
      || dateKey(executionDate) !== dateKey(previous.execution_date)
      || registrationStatus !== (previous.registration_status || 'NOT_REGISTERED')
      || registrationNumber !== (previous.registration_number || null)
      || dateKey(registrationDate) !== dateKey(previous.registration_date)
      || registrationOffice !== (previous.registration_office || null);
    if (legalStateChanging) {
      const { rows: protectedRegistries } = await db.query(
        `SELECT registry.id
           FROM plot_registries registry
           JOIN sites site ON site.id=registry.site_id
          WHERE registry.agreement_id=$1
            AND registry.site_id=$2
            AND registry.lifecycle_status IN ('EXECUTED','COMPLETE')
            AND EXISTS (
              SELECT 1 FROM site_operating_profile_revisions profile
               WHERE profile.organization_id=site.organization_id
                 AND profile.site_id=site.id
                 AND profile.lifecycle_status='PUBLISHED'
                 AND profile.effective_to IS NULL
                 AND profile.deleted_at IS NULL
                 AND profile.operating_model IN (
                   'RERA_PROJECT_PROMOTER','RERA_ONGOING_PROJECT_REGULARISATION'
                 )
            )
          LIMIT 1`,
        [agreementId, siteId],
      );
      if (protectedRegistries[0]) {
        throw businessError(
          'Agreement execution and registration details are immutable after the linked RERA registry is executed',
          'RERA_EXECUTED_AGREEMENT_IMMUTABLE',
          409,
          { registry_id: protectedRegistries[0].id },
        );
      }
    }
    const { rows: changed } = await db.query(
      `UPDATE booking_agreements SET status=$1,execution_date=$2,review_notes=COALESCE($3,review_notes),
         registration_status=$4,registration_number=$5,registration_date=$6,registration_office=$7,
         registration_recorded_by=CASE WHEN $4='REGISTERED' THEN $8 ELSE NULL END,
         registration_recorded_at=CASE WHEN $4='REGISTERED' THEN NOW() ELSE NULL END,
         reviewed_by=CASE WHEN $9 THEN $8 ELSE reviewed_by END,
         reviewed_at=CASE WHEN $9 THEN NOW() ELSE reviewed_at END,updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [next, executionDate, cleanText(req.body.review_notes, 'Review notes', 4000),
        registrationStatus, registrationNumber, registrationDate, registrationOffice, req.user.id,
        ['APPROVED_FOR_EXECUTION', 'EXECUTED'].includes(next), agreementId],
    );
    const isExecuted = next === 'EXECUTED';
    await db.query(
      `UPDATE bookings
          SET agreement_status=$1,
              lifecycle_status=CASE WHEN $3 THEN 'AGREEMENT_EXECUTED' ELSE lifecycle_status END,
              workflow_version=workflow_version+1,
              updated_at=NOW()
        WHERE id=$2`,
      [next, previous.booking_id, isExecuted],
    );
    await db.query(
      `UPDATE plots
          SET agreement_status=$1,
              lifecycle_status=CASE WHEN $3 THEN 'AGREEMENT_EXECUTED' ELSE lifecycle_status END,
              lifecycle_version=lifecycle_version+1,
              updated_at=NOW()
        WHERE id=$2`,
      [next, previous.plot_id, isExecuted],
    );
    await writeComplianceAudit(db, req, {
      action: registrationOnlyUpdate ? 'AGREEMENT_REGISTRATION_UPDATED' : 'AGREEMENT_STATUS_CHANGED',
      entityType: 'BOOKING_AGREEMENT',
      entityId: agreementId,
      siteId,
      previousValue: {
        status: previous.status,
        registration_status: previous.registration_status,
        registration_number: previous.registration_number,
        registration_date: previous.registration_date,
      },
      newValue: {
        status: next,
        execution_date: executionDate,
        registration_status: registrationStatus,
        registration_number: registrationNumber,
        registration_date: registrationDate,
        registration_office: registrationOffice,
        booking_id: previous.booking_id,
      },
      reason: req.body.reason || req.body.review_notes,
    });
    return changed[0];
  }).catch((error) => {
    throw normalizeExecutedAgreementConstraint(error);
  });
  res.json({ agreement: result });
});

/** POST /property-lifecycle/agreements/:agreementId/documents/:documentId */
export const attachAgreementDocument = asyncHandler(async (req, res) => {
  const document = await inTransaction(async (db) => {
    const agreementId = positiveId(req.params.agreementId, 'agreement_id');
    const documentId = positiveId(req.params.documentId, 'document_id');
    const siteId = siteIdFrom(req);
    const { rows: agreements } = await db.query(`SELECT * FROM booking_agreements WHERE id=$1 AND site_id=$2 AND organization_id=$3 FOR UPDATE`, [agreementId, siteId, req.user.organization_id]);
    const agreement = agreements[0];
    if (!agreement) throw businessError('Agreement not found', 'AGREEMENT_NOT_FOUND', 404);
    const { rows } = await db.query(`UPDATE documents SET agreement_id=$1,booking_id=$2 WHERE id=$3 AND site_id=$4 AND (plot_id IS NULL OR plot_id=$5) RETURNING id,title,category,original_name,agreement_id,booking_id`, [agreementId, agreement.booking_id, documentId, siteId, agreement.plot_id]);
    if (!rows[0]) throw businessError('Document is outside the agreement property/Site', 'DOCUMENT_SCOPE_MISMATCH', 409);
    await writeComplianceAudit(db, req, { action: 'AGREEMENT_DOCUMENT_LINKED', entityType: 'BOOKING_AGREEMENT', entityId: agreementId, siteId, newValue: { booking_id: agreement.booking_id, document_id: documentId } });
    return rows[0];
  });
  res.json({ document });
});

/** POST /property-lifecycle/collections/guard */
export const previewCollectionGuard = asyncHandler(async (req, res) => {
  const decision = await resolveCollectionGuard({ organizationId: req.user.organization_id, siteId: siteIdFrom(req), bookingId: req.body.booking_id, proposedAmount: req.body.amount });
  res.json({ decision });
});

/** POST /property-lifecycle/bookings/:bookingId/cancellations */
export const requestCancellation = asyncHandler(async (req, res) => {
  const cancellation = await inTransaction(async (db) => {
    const booking = await lockBooking(db, req, req.params.bookingId);
    if (['REGISTRY_COMPLETE', 'POSSESSION_PENDING', 'POSSESSED', 'CANCELLED', 'CLOSED'].includes(booking.lifecycle_status)) throw businessError('This booking cannot enter cancellation from its current stage', 'CANCELLATION_NOT_ALLOWED');
    const reason = cleanText(req.body.reason, 'Cancellation reason', 4000, { required: true });
    const idempotencyKey = cleanText(req.body.idempotency_key, 'Idempotency key', 120);
    if (idempotencyKey) {
      const { rows: existing } = await db.query(`SELECT * FROM booking_cancellations WHERE organization_id=$1 AND site_id=$2 AND idempotency_key=$3`, [req.user.organization_id, booking.site_id, idempotencyKey]);
      if (existing[0]) return existing[0];
    }
    const { rows: moneyRows } = await db.query(
      `SELECT COALESCE((SELECT SUM(amount) FROM plot_payments WHERE booking_id=$1 AND LOWER(COALESCE(status,'approved'))='approved' AND UPPER(COALESCE(cheque_status,'')) NOT IN ('BOUNCED','RETURNED')),0)
              +COALESCE((SELECT SUM(pip.amount) FROM plot_installment_payments pip WHERE pip.plot_id=$2 AND UPPER(COALESCE(pip.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')),0) AS collected,
              COALESCE((SELECT SUM(amount) FROM booking_refunds WHERE booking_id=$1 AND status='POSTED'),0) AS refunded`,
      [booking.id, booking.plot_id],
    );
    const collected = moneyRows[0].collected;
    const refunded = moneyRows[0].refunded;
    const deduction = money(req.body.proposed_deduction ?? 0, 'Proposed deduction', { required: true });
    const refundDue = Math.max(Math.round((Number(collected) - Number(refunded) - Number(deduction)) * 100), 0) / 100;
    const { rows } = await db.query(
      `INSERT INTO booking_cancellations (organization_id,site_id,booking_id,plot_id,status,reason,collected_amount,already_refunded,proposed_deduction,refund_due,commission_impact,financial_review,requested_by,idempotency_key)
       VALUES ($1,$2,$3,$4,'REQUESTED',$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [req.user.organization_id, booking.site_id, booking.id, booking.plot_id, reason, collected, refunded, deduction, refundDue.toFixed(2), money(req.body.commission_impact ?? 0, 'Commission impact', { required: true }), { previous_booking_lifecycle: booking.lifecycle_status, previous_plot_lifecycle: booking.plot_lifecycle_status }, req.user.id, idempotencyKey],
    );
    await db.query(`UPDATE bookings SET status='CANCELLATION_REQUESTED',lifecycle_status='CANCELLATION_REQUESTED',workflow_version=workflow_version+1,updated_at=NOW() WHERE id=$1`, [booking.id]);
    await db.query(`UPDATE plots SET lifecycle_status='CANCELLATION_REQUESTED',lifecycle_version=lifecycle_version+1,updated_at=NOW() WHERE id=$1`, [booking.plot_id]);
    await writeComplianceAudit(db, req, { action: 'CANCELLATION_REQUESTED', entityType: 'BOOKING_CANCELLATION', entityId: rows[0].id, siteId: booking.site_id, newValue: { ...rows[0], booking_id: booking.id }, reason });
    return rows[0];
  });
  res.status(201).json({ cancellation });
});

/** PATCH /property-lifecycle/cancellations/:cancellationId/decision */
export const decideCancellation = asyncHandler(async (req, res) => {
  requireAdmin(req);
  const cancellation = await inTransaction(async (db) => {
    const id = positiveId(req.params.cancellationId, 'cancellation_id');
    const siteId = siteIdFrom(req);
    const { rows: contextRows } = await db.query(`SELECT booking_id FROM booking_cancellations WHERE id=$1 AND site_id=$2 AND organization_id=$3`, [id, siteId, req.user.organization_id]);
    if (!contextRows[0]) throw businessError('Cancellation not found', 'CANCELLATION_NOT_FOUND', 404);
    await lockBooking(db, req, contextRows[0].booking_id);
    const { rows } = await db.query(`SELECT bc.* FROM booking_cancellations bc JOIN bookings b ON b.id=bc.booking_id JOIN plots p ON p.id=bc.plot_id AND p.site_id=bc.site_id WHERE bc.id=$1 AND bc.site_id=$2 AND bc.organization_id=$3 FOR UPDATE OF b,p,bc`, [id, siteId, req.user.organization_id]);
    const previous = rows[0];
    if (!previous) throw businessError('Cancellation not found', 'CANCELLATION_NOT_FOUND', 404);
    if (!['REQUESTED', 'FINANCIAL_REVIEW', 'AGREEMENT_REVIEW', 'APPROVAL_PENDING'].includes(previous.status)) throw businessError('Cancellation decision is already final', 'CANCELLATION_ALREADY_DECIDED');
    const approved = String(req.body.decision || '').toUpperCase() === 'APPROVE';
    if (!approved && String(req.body.decision || '').toUpperCase() !== 'REJECT') throw businessError('decision must be APPROVE or REJECT', 'INVALID_DECISION', 400);
    const reason = cleanText(req.body.reason, 'Decision reason', 4000, { required: true });
    const releaseWithoutRefund = approved && Number(previous.refund_due) <= 0;
    const next = approved ? (releaseWithoutRefund ? 'PROPERTY_RELEASED' : 'REFUND_PENDING') : 'REJECTED';
    const { rows: changed } = await db.query(`UPDATE booking_cancellations SET status=$1,approved_by=$2,approved_at=NOW(),agreement_review=jsonb_set(agreement_review,'{decision_reason}',to_jsonb($3::text),true),updated_at=NOW() WHERE id=$4 RETURNING *`, [next, req.user.id, reason, id]);
    if (releaseWithoutRefund) {
      await db.query(`UPDATE bookings SET status='CANCELLED',lifecycle_status='CANCELLED',cancelled_at=NOW(),workflow_version=workflow_version+1,updated_at=NOW() WHERE id=$1`, [previous.booking_id]);
      await db.query(`UPDATE plots SET current_booking_id=NULL,buyer_name=NULL,booking_date=NULL,status='AVAILABLE',lifecycle_status='AVAILABLE',agreement_status=NULL,financial_status=NULL,registry_status=NULL,possession_status=NULL,lifecycle_version=lifecycle_version+1,updated_at=NOW() WHERE id=$1 AND current_booking_id=$2`, [previous.plot_id, previous.booking_id]);
    } else if (approved) {
      await db.query(`UPDATE bookings SET status='REFUND_PENDING',lifecycle_status='REFUND_PENDING',workflow_version=workflow_version+1,updated_at=NOW() WHERE id=$1`, [previous.booking_id]);
      await db.query(`UPDATE plots SET lifecycle_status='REFUND_PENDING',lifecycle_version=lifecycle_version+1,updated_at=NOW() WHERE id=$1`, [previous.plot_id]);
    } else {
      const previousBookingState = previous.financial_review?.previous_booking_lifecycle || 'BOOKED';
      const previousPlotState = previous.financial_review?.previous_plot_lifecycle || 'BOOKED';
      await db.query(`UPDATE bookings SET status='CONFIRMED',lifecycle_status=$1,workflow_version=workflow_version+1,updated_at=NOW() WHERE id=$2`, [previousBookingState, previous.booking_id]);
      await db.query(`UPDATE plots SET lifecycle_status=$1,lifecycle_version=lifecycle_version+1,updated_at=NOW() WHERE id=$2`, [previousPlotState, previous.plot_id]);
    }
    await writeComplianceAudit(db, req, { action: approved ? 'CANCELLATION_APPROVED' : 'CANCELLATION_REJECTED', entityType: 'BOOKING_CANCELLATION', entityId: id, siteId, previousValue: { status: previous.status }, newValue: { status: next, booking_id: previous.booking_id }, reason });
    return changed[0];
  });
  res.json({ cancellation });
});

/** POST /property-lifecycle/cancellations/:cancellationId/refunds */
export const createRefund = asyncHandler(async (req, res) => {
  const refund = await inTransaction(async (db) => {
    const cancellationId = positiveId(req.params.cancellationId, 'cancellation_id');
    const siteId = siteIdFrom(req);
    const { rows: contextRows } = await db.query(`SELECT booking_id FROM booking_cancellations WHERE id=$1 AND site_id=$2 AND organization_id=$3`, [cancellationId, siteId, req.user.organization_id]);
    if (!contextRows[0]) throw businessError('Cancellation not found', 'CANCELLATION_NOT_FOUND', 404);
    await lockBooking(db, req, contextRows[0].booking_id);
    const { rows } = await db.query(`SELECT * FROM booking_cancellations WHERE id=$1 AND site_id=$2 AND organization_id=$3 FOR UPDATE`, [cancellationId, siteId, req.user.organization_id]);
    const cancellation = rows[0];
    if (!cancellation) throw businessError('Cancellation not found', 'CANCELLATION_NOT_FOUND', 404);
    if (!['APPROVED', 'REFUND_PENDING'].includes(cancellation.status)) throw businessError('Cancellation must be approved before a refund is prepared', 'CANCELLATION_APPROVAL_REQUIRED');
    const amount = money(req.body.amount, 'Refund amount', { required: true, allowZero: false });
    const { rows: totals } = await db.query(`SELECT COALESCE(SUM(amount),0) AS prepared FROM booking_refunds WHERE cancellation_id=$1 AND status NOT IN ('REJECTED','CANCELLED')`, [cancellationId]);
    if (Math.round((Number(totals[0].prepared) + Number(amount)) * 100) > Math.round(Number(cancellation.refund_due) * 100)) throw businessError('Refund total exceeds the approved refund due', 'REFUND_EXCEEDS_APPROVAL');
    const mode = String(req.body.payment_mode || '').toUpperCase();
    if (!['CASH', 'BANK', 'CHEQUE'].includes(mode)) throw businessError('A valid refund payment mode is required', 'INVALID_PAYMENT_MODE', 400);
    await assertFinancePaymentModeAllowed({
      organizationId: req.user.organization_id,
      siteId,
      paymentMode: mode,
      db,
    });
    const firmId = positiveId(req.body.firm_id, 'firm_id', { optional: true });
    const bankAccountId = await resolveBankAccountSelection({
      siteId,
      paymentMode: mode,
      bankAccountId: req.body.bank_account_id,
      db,
    });
    const originalPaymentId = positiveId(req.body.original_plot_payment_id, 'original_plot_payment_id', { optional: true });
    if (originalPaymentId) {
      const { rows: payment } = await db.query(`SELECT 1 FROM plot_payments WHERE id=$1 AND booking_id=$2 AND site_id=$3`, [originalPaymentId, cancellation.booking_id, siteId]);
      if (!payment[0]) throw businessError('Original receipt is outside this booking', 'ORIGINAL_PAYMENT_MISMATCH');
    }
    const idempotencyKey = cleanText(req.body.idempotency_key, 'Idempotency key', 120);
    if (idempotencyKey) {
      const { rows: existing } = await db.query(`SELECT * FROM booking_refunds WHERE booking_id=$1 AND idempotency_key=$2`, [cancellation.booking_id, idempotencyKey]);
      if (existing[0]) return existing[0];
    }
    const { rows: created } = await db.query(`INSERT INTO booking_refunds (cancellation_id,booking_id,original_plot_payment_id,amount,payment_mode,firm_id,bank_account_id,reference,status,created_by,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,$10) RETURNING *`, [cancellationId, cancellation.booking_id, originalPaymentId, amount, mode, firmId, bankAccountId, cleanText(req.body.reference, 'Reference', 255), req.user.id, idempotencyKey]);
    await writeComplianceAudit(db, req, { action: 'REFUND_PREPARED', entityType: 'BOOKING_REFUND', entityId: created[0].id, siteId, newValue: { ...created[0], booking_id: cancellation.booking_id } });
    return created[0];
  });
  res.status(201).json({ refund });
});

/** POST /property-lifecycle/refunds/:refundId/post */
export const postRefund = asyncHandler(async (req, res) => {
  requireAdmin(req);
  const result = await inTransaction(async (db) => {
    const refundId = positiveId(req.params.refundId, 'refund_id');
    const siteId = siteIdFrom(req);
    const { rows: contextRows } = await db.query(`SELECT br.booking_id FROM booking_refunds br JOIN booking_cancellations bc ON bc.id=br.cancellation_id WHERE br.id=$1 AND bc.site_id=$2 AND bc.organization_id=$3`, [refundId, siteId, req.user.organization_id]);
    if (!contextRows[0]) throw businessError('Refund not found', 'REFUND_NOT_FOUND', 404);
    await lockBooking(db, req, contextRows[0].booking_id);
    const { rows } = await db.query(`SELECT br.*,bc.plot_id,bc.organization_id,bc.refund_due,p.plot_no,m.full_name FROM booking_refunds br JOIN booking_cancellations bc ON bc.id=br.cancellation_id JOIN bookings b ON b.id=br.booking_id JOIN plots p ON p.id=bc.plot_id LEFT JOIN members m ON m.id=b.client_member_id WHERE br.id=$1 AND bc.site_id=$2 AND bc.organization_id=$3 FOR UPDATE OF br,bc,b,p`, [refundId, siteId, req.user.organization_id]);
    const refund = rows[0];
    if (!refund) throw businessError('Refund not found', 'REFUND_NOT_FOUND', 404);
    if (refund.status === 'POSTED') return refund;
    if (refund.status !== 'PENDING') throw businessError('Only a pending refund can be posted', 'REFUND_NOT_PENDING');
    let dayBookId = null;
    let firmTransactionId = null;
    const selectedBankAccountId = await resolveBankAccountSelection({
      siteId,
      paymentMode: refund.payment_mode,
      bankAccountId: refund.bank_account_id,
      db,
    });
    const { rows: dayRows } = await db.query(
      `INSERT INTO day_book (site_id,date,particular,entry_type,debit,credit,remarks,payment_mode,bank_account_id,category,from_entity,to_entity,created_by,status,approved_by,approved_at,booking_id,rera_project_id,rera_project_phase_id)
       SELECT b.site_id,CURRENT_DATE,$1,'PAYMENT',$2,0,$3,$4,$5,'CUSTOMER REFUND',$6,$7,$8,'approved',$8,NOW(),b.id,b.rera_project_id,b.rera_project_phase_id
         FROM bookings b WHERE b.id=$9 RETURNING id`,
      [`Refund · Plot ${refund.plot_no}`, refund.amount, refund.reference || `Cancellation ${refund.cancellation_id}`, refund.payment_mode, selectedBankAccountId, 'MountReality', refund.full_name || 'Customer', req.user.id, refund.booking_id],
    );
    dayBookId = dayRows[0]?.id || null;
    const { rows: postedRows } = await db.query(`UPDATE booking_refunds SET status='POSTED',day_book_id=$1,firm_transaction_id=$2,approved_by=$3,approved_at=NOW(),posted_at=NOW() WHERE id=$4 RETURNING *`, [dayBookId, firmTransactionId, req.user.id, refundId]);
    const { rows: totals } = await db.query(`SELECT COALESCE(SUM(amount),0) AS posted FROM booking_refunds WHERE cancellation_id=$1 AND status='POSTED'`, [refund.cancellation_id]);
    let released = false;
    if (Math.round(Number(totals[0].posted) * 100) >= Math.round(Number(refund.refund_due) * 100)) {
      await db.query(`UPDATE booking_cancellations SET status='PROPERTY_RELEASED',closed_at=NOW(),updated_at=NOW() WHERE id=$1`, [refund.cancellation_id]);
      await db.query(`UPDATE bookings SET status='CANCELLED',lifecycle_status='CANCELLED',cancelled_at=NOW(),workflow_version=workflow_version+1,updated_at=NOW() WHERE id=$1`, [refund.booking_id]);
      await db.query(`UPDATE plots SET current_booking_id=NULL,buyer_name=NULL,booking_date=NULL,status='AVAILABLE',lifecycle_status='AVAILABLE',agreement_status=NULL,financial_status=NULL,registry_status=NULL,possession_status=NULL,lifecycle_version=lifecycle_version+1,updated_at=NOW() WHERE id=$1 AND current_booking_id=$2`, [refund.plot_id, refund.booking_id]);
      released = true;
    }
    await writeComplianceAudit(db, req, { action: 'REFUND_POSTED', entityType: 'BOOKING_REFUND', entityId: refundId, siteId, previousValue: { status: refund.status }, newValue: { ...postedRows[0], booking_id: refund.booking_id, property_released: released } });
    return { refund: postedRows[0], property_released: released };
  });
  res.json(result);
});

/** POST /property-lifecycle/bookings/:bookingId/transfers */
export const requestTransfer = asyncHandler(async (req, res) => {
  const transfer = await inTransaction(async (db) => {
    const booking = await lockBooking(db, req, req.params.bookingId);
    if (['REGISTRY_PENDING', 'REGISTRY_COMPLETE', 'POSSESSION_PENDING', 'POSSESSED', 'CANCELLATION_REQUESTED', 'REFUND_PENDING', 'CANCELLED'].includes(booking.lifecycle_status)) throw businessError('Transfer is unavailable while registry, possession, or cancellation is in progress', 'TRANSFER_NOT_ALLOWED');
    const toMemberId = positiveId(req.body.to_member_id, 'to_member_id');
    if (toMemberId === Number(booking.client_member_id)) throw businessError('New allottee must be different from the current allottee', 'TRANSFER_SAME_ALLOTTEE', 400);
    const { rows: target } = await db.query(`SELECT id FROM members WHERE id=$1 AND site_id=$2 AND status<>'INACTIVE'`, [toMemberId, booking.site_id]);
    if (!target[0]) throw businessError('New allottee is outside the selected Site', 'ALLOTTEE_SCOPE_MISMATCH');
    const reason = cleanText(req.body.reason, 'Transfer reason', 4000, { required: true });
    const idempotencyKey = cleanText(req.body.idempotency_key, 'Idempotency key', 120);
    if (idempotencyKey) {
      const { rows: existing } = await db.query(`SELECT * FROM booking_transfers WHERE booking_id=$1 AND idempotency_key=$2`, [booking.id, idempotencyKey]);
      if (existing[0]) return existing[0];
    }
    const { rows } = await db.query(`INSERT INTO booking_transfers (organization_id,site_id,booking_id,plot_id,from_member_id,to_member_id,status,reason,effective_date,transfer_charge,requested_by,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,'REQUESTED',$7,$8,$9,$10,$11) RETURNING *`, [req.user.organization_id, booking.site_id, booking.id, booking.plot_id, booking.client_member_id, toMemberId, reason, isoDate(req.body.effective_date, 'Effective date'), money(req.body.transfer_charge ?? 0, 'Transfer charge', { required: true }), req.user.id, idempotencyKey]);
    await writeComplianceAudit(db, req, { action: 'TRANSFER_REQUESTED', entityType: 'BOOKING_TRANSFER', entityId: rows[0].id, siteId: booking.site_id, newValue: { ...rows[0], booking_id: booking.id }, reason });
    return rows[0];
  });
  res.status(201).json({ transfer });
});

/** POST /property-lifecycle/transfers/:transferId/execute */
export const executeTransfer = asyncHandler(async (req, res) => {
  requireAdmin(req);
  const transfer = await inTransaction(async (db) => {
    const id = positiveId(req.params.transferId, 'transfer_id');
    const siteId = siteIdFrom(req);
    const { rows: contextRows } = await db.query(`SELECT booking_id FROM booking_transfers WHERE id=$1 AND site_id=$2 AND organization_id=$3`, [id, siteId, req.user.organization_id]);
    if (!contextRows[0]) throw businessError('Transfer not found', 'TRANSFER_NOT_FOUND', 404);
    await lockBooking(db, req, contextRows[0].booking_id);
    const { rows } = await db.query(`SELECT bt.*,tm.full_name AS to_name,b.lifecycle_status FROM booking_transfers bt JOIN bookings b ON b.id=bt.booking_id JOIN plots p ON p.id=bt.plot_id AND p.site_id=bt.site_id JOIN members tm ON tm.id=bt.to_member_id WHERE bt.id=$1 AND bt.site_id=$2 AND bt.organization_id=$3 FOR UPDATE OF b,p,bt`, [id, siteId, req.user.organization_id]);
    const previous = rows[0];
    if (!previous) throw businessError('Transfer not found', 'TRANSFER_NOT_FOUND', 404);
    if (previous.status === 'EFFECTIVE') return previous;
    if (!['REQUESTED', 'DOCUMENT_REVIEW', 'FINANCIAL_REVIEW', 'APPROVAL_PENDING', 'APPROVED'].includes(previous.status)) throw businessError('Transfer cannot be executed from its current state', 'TRANSFER_STATE_CONFLICT');
    if (['REGISTRY_PENDING', 'REGISTRY_COMPLETE', 'POSSESSION_PENDING', 'POSSESSED', 'CANCELLATION_REQUESTED', 'REFUND_PENDING'].includes(previous.lifecycle_status)) throw businessError('Transfer cannot execute while another terminal workflow is in progress', 'TRANSFER_WORKFLOW_CONFLICT');
    const effectiveDate = isoDate(req.body.effective_date || previous.effective_date || new Date().toISOString().slice(0, 10), 'Effective date', { required: true });
    await db.query(`UPDATE booking_allottees SET status='FORMER',effective_to=$1,updated_at=NOW() WHERE booking_id=$2 AND allottee_role='PRIMARY' AND status='ACTIVE'`, [effectiveDate, previous.booking_id]);
    await db.query(`INSERT INTO booking_allottees (organization_id,site_id,booking_id,member_id,allottee_role,status,effective_from,relationship_notes,created_by) VALUES ($1,$2,$3,$4,'PRIMARY','ACTIVE',$5,$6,$7)`, [req.user.organization_id, siteId, previous.booking_id, previous.to_member_id, effectiveDate, `Transfer ${id}: ${previous.reason}`, req.user.id]);
    await db.query(`UPDATE bookings SET client_member_id=$1,buyer_name=$2,agreement_status=CASE WHEN agreement_status='EXECUTED' THEN 'UNDER_REVIEW' ELSE agreement_status END,workflow_version=workflow_version+1,updated_at=NOW() WHERE id=$3`, [previous.to_member_id, previous.to_name, previous.booking_id]);
    await db.query(`UPDATE plots SET buyer_name=$1,agreement_status=CASE WHEN agreement_status='EXECUTED' THEN 'UNDER_REVIEW' ELSE agreement_status END,lifecycle_version=lifecycle_version+1,updated_at=NOW() WHERE id=$2`, [previous.to_name, previous.plot_id]);
    await db.query(`UPDATE plot_registries SET allottee_member_id=$1,customer_name=$2,updated_at=NOW() WHERE booking_id=$3 AND lifecycle_status NOT IN ('EXECUTED','COMPLETE')`, [previous.to_member_id, previous.to_name, previous.booking_id]);
    const { rows: changed } = await db.query(`UPDATE booking_transfers SET status='EFFECTIVE',effective_date=$1,approved_by=$2,approved_at=NOW(),updated_at=NOW() WHERE id=$3 RETURNING *`, [effectiveDate, req.user.id, id]);
    await writeComplianceAudit(db, req, { action: 'TRANSFER_EFFECTIVE', entityType: 'BOOKING_TRANSFER', entityId: id, siteId, previousValue: { from_member_id: previous.from_member_id, status: previous.status }, newValue: { to_member_id: previous.to_member_id, status: 'EFFECTIVE', effective_date: effectiveDate, booking_id: previous.booking_id }, reason: previous.reason });
    return changed[0];
  });
  res.json({ transfer });
});

async function computeRegistryReadiness(db, req, registry) {
  const [policyRow, operatingPolicy] = await Promise.all([
    loadWorkflowPolicy(db, req, registry.site_id, registry.booking_id),
    resolveRegistryOperatingPolicy({
      db,
      siteId: registry.site_id,
      organizationId: req.user.organization_id,
    }),
  ]);
  const workflow = deepMerge(policyRow?.workflow_policy, policyRow?.workflow_policy_overrides);
  const configured = workflow?.registry_readiness?.checks;
  const { rows } = await db.query(
    `SELECT b.agreement_status,b.final_consideration,
            agreement.id AS registry_agreement_id,
            agreement.status AS registry_agreement_status,
            agreement.execution_date AS registry_agreement_execution_date,
            agreement.registration_status AS agreement_registration_status,
            agreement.registration_number AS agreement_registration_number,
            agreement.registration_date AS agreement_registration_date,
            COALESCE((
              SELECT SUM(receipt.amount)
                FROM plot_payments receipt
               WHERE receipt.booking_id=b.id
                 AND receipt.plot_id=b.plot_id
                 AND receipt.site_id=b.site_id
                 AND LOWER(COALESCE(receipt.status,'approved'))='approved'
                 AND UPPER(COALESCE(receipt.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
                 AND receipt.reversal_of_payment_id IS NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM plot_payments reversal
                    WHERE reversal.reversal_of_payment_id=receipt.id
                      AND LOWER(COALESCE(reversal.status,'approved'))='approved'
                      AND UPPER(COALESCE(reversal.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
                 )
            ),0) AS received,
            COALESCE((
              SELECT SUM(receipt.amount)
                FROM plot_registry_payments mapping
                JOIN plot_payments receipt ON receipt.id=mapping.source_plot_payment_id
               WHERE mapping.registry_id=$2
                 AND receipt.plot_id=b.plot_id
                 AND receipt.site_id=b.site_id
                 AND receipt.booking_id=b.id
                 AND receipt.amount>0
                 AND LOWER(COALESCE(receipt.status,'approved'))='approved'
                 AND UPPER(COALESCE(receipt.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
                 AND receipt.reversal_of_payment_id IS NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM plot_payments reversal
                    WHERE reversal.reversal_of_payment_id=receipt.id
                      AND LOWER(COALESCE(reversal.status,'approved'))='approved'
                      AND UPPER(COALESCE(reversal.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
                 )
            ),0) AS canonical_registry_received,
            (SELECT COUNT(*)::int
               FROM plot_registry_payments mapping
               JOIN plot_payments receipt ON receipt.id=mapping.source_plot_payment_id
              WHERE mapping.registry_id=$2
                AND receipt.plot_id=b.plot_id
                AND receipt.site_id=b.site_id
                AND receipt.booking_id=b.id
                AND receipt.amount>0
                AND LOWER(COALESCE(receipt.status,'approved'))='approved'
                AND UPPER(COALESCE(receipt.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
                AND receipt.reversal_of_payment_id IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM plot_payments reversal
                   WHERE reversal.reversal_of_payment_id=receipt.id
                     AND LOWER(COALESCE(reversal.status,'approved'))='approved'
                     AND UPPER(COALESCE(reversal.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
                )) AS canonical_receipt_count,
            (SELECT COUNT(*)::int
               FROM plot_registry_payments mapping
              WHERE mapping.registry_id=$2
                AND mapping.source_plot_payment_id IS NULL) AS historical_manual_payment_count,
            (SELECT COUNT(*)::int FROM documents customer_doc
              WHERE customer_doc.site_id=b.site_id
                AND (customer_doc.booking_id=b.id OR customer_doc.plot_id=b.plot_id)) AS customer_documents,
            (SELECT COUNT(*)::int FROM documents deed
              WHERE deed.site_id=b.site_id
                AND deed.plot_id=b.plot_id
                AND UPPER(COALESCE(deed.category,''))='REGISTRY'
                AND deed.uploaded_source='PLOT_REGISTRY'
                AND NULLIF(BTRIM(deed.file_path),'') IS NOT NULL
                AND NULLIF(BTRIM(deed.file_hash),'') IS NOT NULL
                AND deed.uploaded_by IS NOT NULL) AS controlled_registry_documents
       FROM bookings b
       LEFT JOIN booking_agreements agreement
         ON agreement.id=$3
        AND agreement.booking_id=b.id
        AND agreement.plot_id=b.plot_id
        AND agreement.site_id=b.site_id
      WHERE b.id=$1 AND b.site_id=$4 AND b.organization_id=$5`,
    [registry.booking_id, registry.id, registry.agreement_id, registry.site_id, req.user.organization_id],
  );
  const facts = rows[0] || {};
  const factChecks = {
    project_context: operatingPolicy.rera_enforced
      ? isRegistryProjectContextComplete({
          projectStructure: operatingPolicy.project_structure,
          projectId: registry.rera_project_id,
          phaseId: registry.rera_project_phase_id,
        })
      : Boolean(registry.rera_project_id && registry.rera_project_phase_id),
    agreement_context: Boolean(
      registry.booking_id
      && registry.agreement_id
      && Number(facts.registry_agreement_id) === Number(registry.agreement_id)
    ),
    agreement_executed: facts.registry_agreement_status === 'EXECUTED'
      && Boolean(facts.registry_agreement_execution_date),
    agreement_registered: facts.registry_agreement_status === 'EXECUTED'
      && facts.agreement_registration_status === 'REGISTERED'
      && Boolean(String(facts.agreement_registration_number || '').trim())
      && Boolean(facts.agreement_registration_date),
    full_collection: Number(facts.received) >= Number(facts.final_consideration || 0),
    customer_documents: Number(facts.customer_documents) > 0,
    canonical_receipt: Number(facts.canonical_receipt_count) > 0,
    registry_documents: Number(facts.controlled_registry_documents) > 0,
    controlled_registry_deed: Number(facts.controlled_registry_documents) > 0,
    professional_registration_metadata: Boolean(
      String(registry.deed_number || '').trim()
      && String(registry.registration_number || '').trim()
      && String(registry.sub_registrar_office || '').trim()
      && registry.deed_execution_date
      && registry.registration_date
    ),
  };
  const configuredChecks = Array.isArray(configured)
    ? configured.map((item) => ({ key: item.key, label: item.label || item.key, required: item.required !== false, passed: factChecks[item.key] === true }))
    : Object.entries(factChecks).map(([key, passed]) => ({ key, label: key.replaceAll('_', ' '), required: false, passed, informational: true }));
  const checksByKey = new Map(configuredChecks.map((check) => [check.key, check]));
  if (operatingPolicy.rera_enforced) {
    const mandatory = [
      [
        'project_context',
        operatingPolicy.project_structure === 'PHASE_WISE'
          ? 'RERA project and phase linked'
          : 'RERA project linked',
      ],
      ['agreement_context', 'Agreement linked to this booking'],
      ['agreement_executed', 'Agreement executed'],
      ['agreement_registered', 'Executed agreement registered'],
      ['canonical_receipt', 'Approved Project Payment receipt linked'],
      ['controlled_registry_deed', 'Controlled registry deed uploaded'],
      ['professional_registration_metadata', 'Registration number, deed number, dates and Sub-Registrar office completed'],
    ];
    for (const [key, label] of mandatory) {
      checksByKey.set(key, {
        ...(checksByKey.get(key) || {}),
        key,
        label,
        required: true,
        passed: factChecks[key] === true,
        source: 'RERA_OPERATING_PROFILE',
      });
    }
  }
  const checks = [...checksByKey.values()];
  const configuredRequired = configuredChecks.filter((check) => check.required);
  const required = checks.filter((check) => check.required);
  return {
    configured: Array.isArray(configured),
    configured_ready: Array.isArray(configured)
      ? configuredRequired.every((check) => check.passed)
      : null,
    ready: required.length ? required.every((check) => check.passed) : null,
    execution_ready: operatingPolicy.rera_enforced
      ? required.every((check) => check.passed)
      : null,
    checks,
    facts: {
      canonical_receipt_count: Number(facts.canonical_receipt_count || 0),
      canonical_registry_received: Number(facts.canonical_registry_received || 0),
      historical_manual_payment_count: Number(facts.historical_manual_payment_count || 0),
      controlled_deed_count: Number(facts.controlled_registry_documents || 0),
    },
    operating_policy: operatingPolicy,
    ruleset: policyRow ? { id: policyRow.ruleset_version_id, code: policyRow.ruleset_code, version: policyRow.version, source_review_status: policyRow.source_review_status } : null,
  };
}

/** GET /property-lifecycle/registries/:registryId/readiness */
export const getRegistryReadiness = asyncHandler(async (req, res) => {
  const registryId = positiveId(req.params.registryId, 'registry_id');
  const siteId = siteIdFrom(req);
  const { rows } = await pool.query(`SELECT * FROM plot_registries WHERE id=$1 AND site_id=$2 AND EXISTS (SELECT 1 FROM sites WHERE id=$2 AND organization_id=$3)`, [registryId, siteId, req.user.organization_id]);
  if (!rows[0]) return res.status(404).json({ message: 'Registry not found' });
  const readiness = await computeRegistryReadiness(pool, req, rows[0]);
  res.json({ readiness });
});

/** PATCH /property-lifecycle/registries/:registryId/status */
export const transitionRegistryLifecycle = asyncHandler(async (req, res) => {
  const result = await inTransaction(async (db) => {
    const registryId = positiveId(req.params.registryId ?? req.params.id, 'registry_id');
    const siteId = siteIdFrom(req);
    const { rows: contextRows } = await db.query(`SELECT booking_id FROM plot_registries WHERE id=$1 AND site_id=$2`, [registryId, siteId]);
    if (!contextRows[0]) throw businessError('Registry not found', 'REGISTRY_NOT_FOUND', 404);
    if (contextRows[0].booking_id) await lockBooking(db, req, contextRows[0].booking_id);
    const { rows } = await db.query(`SELECT * FROM plot_registries WHERE id=$1 AND site_id=$2 FOR UPDATE`, [registryId, siteId]);
    const previous = rows[0];
    if (!previous || Number(previous.booking_id || 0) !== Number(contextRows[0].booking_id || 0)) throw businessError('Registry context changed while this action was in progress', 'REGISTRY_CONTEXT_STALE');
    const requestedStatus = String(req.body.status || '').trim().toUpperCase();
    // Retried requests are safe. A slow response, refresh, or second browser
    // tab must not turn an already-completed action into a workflow failure.
    if (requestedStatus === previous.lifecycle_status) {
      return { registry: previous, idempotent: true };
    }
    const expectedVersion = req.body.expected_version == null
      ? null
      : positiveId(req.body.expected_version, 'expected_version');
    if (expectedVersion !== null && Number(previous.workflow_version) !== expectedVersion) {
      throw businessError(
        'Registry changed in another session. The latest status has been loaded; review it before continuing.',
        'REGISTRY_VERSION_CONFLICT',
        409,
        { registry: previous },
      );
    }
    const next = assertTransition(REGISTRY_TRANSITIONS, previous.lifecycle_status, requestedStatus, 'Registry');
    if (['EXECUTED', 'COMPLETE'].includes(next)) requireAdmin(req);
    const readiness = await computeRegistryReadiness(db, req, previous);
    if (next === 'READY' && readiness.configured && readiness.configured_ready !== true) {
      throw businessError('Configured registry readiness checks are incomplete', 'REGISTRY_NOT_READY', 409, readiness);
    }
    if (['EXECUTED', 'COMPLETE'].includes(next)
        && readiness.operating_policy?.rera_enforced
        && readiness.execution_ready !== true) {
      throw businessError(
        'Complete the RERA registry checklist before execution',
        'RERA_REGISTRY_EXECUTION_NOT_READY',
        409,
        readiness,
      );
    }
    const scheduledAt = next === 'SCHEDULED' ? cleanText(req.body.scheduled_at, 'Scheduled date/time', 40, { required: true }) : previous.scheduled_at;
    const markComplete = next === 'COMPLETE';
    // Keep status and completion condition in separate parameters. PostgreSQL
    // otherwise infers $1 as both VARCHAR and TEXT and rejects the statement.
    const { rows: changed } = await db.query(
      `UPDATE plot_registries
          SET lifecycle_status=$1,
              readiness_result=$2,
              scheduled_at=$3,
              completed_at=CASE WHEN $4 THEN NOW() ELSE completed_at END,
              completed_by=CASE WHEN $4 THEN $5 ELSE completed_by END,
              workflow_version=workflow_version+1,
              updated_at=NOW()
        WHERE id=$6 AND site_id=$7
        RETURNING *`,
      [next, readiness, scheduledAt, markComplete, req.user.id, registryId, siteId],
    );
    if (previous.booking_id) {
      const lifecycle = next === 'COMPLETE' ? 'REGISTRY_COMPLETE' : 'REGISTRY_PENDING';
      await db.query(`UPDATE bookings SET lifecycle_status=$1,workflow_version=workflow_version+1,updated_at=NOW() WHERE id=$2`, [lifecycle, previous.booking_id]);
      await db.query(
        `UPDATE plots
            SET lifecycle_status=$1,
                registry_status=$2,
                status=CASE WHEN $3 THEN 'REGISTRY' ELSE status END,
                lifecycle_version=lifecycle_version+1,
                updated_at=NOW()
          WHERE id=$4`,
        [lifecycle, next, markComplete, previous.plot_id],
      );
    }
    await writeComplianceAudit(db, req, { action: 'REGISTRY_LIFECYCLE_CHANGED', entityType: 'PROPERTY_BOOKING', entityId: previous.booking_id || registryId, siteId, previousValue: { status: previous.lifecycle_status }, newValue: { status: next, registry_id: registryId, booking_id: previous.booking_id, readiness }, reason: req.body.reason });
    return { registry: changed[0], idempotent: false };
  }).catch((error) => {
    throw normalizeRegistryLifecycleConstraint(error);
  });
  res.json(result);
});

/** POST /property-lifecycle/registries/:registryId/possession */
export const createPossession = asyncHandler(async (req, res) => {
  const possession = await inTransaction(async (db) => {
    const registryId = positiveId(req.params.registryId, 'registry_id');
    const siteId = siteIdFrom(req);
    const { rows: contextRows } = await db.query(`SELECT booking_id FROM plot_registries WHERE id=$1 AND site_id=$2`, [registryId, siteId]);
    if (!contextRows[0]?.booking_id) throw businessError('Registry with booking context not found', 'REGISTRY_NOT_FOUND', 404);
    await lockBooking(db, req, contextRows[0].booking_id);
    const { rows } = await db.query(`SELECT pr.*,b.client_member_id FROM plot_registries pr JOIN bookings b ON b.id=pr.booking_id WHERE pr.id=$1 AND pr.site_id=$2 AND EXISTS (SELECT 1 FROM sites WHERE id=$2 AND organization_id=$3) FOR UPDATE OF pr,b`, [registryId, siteId, req.user.organization_id]);
    const registry = rows[0];
    if (!registry) throw businessError('Registry with booking context not found', 'REGISTRY_NOT_FOUND', 404);
    if (registry.lifecycle_status !== 'COMPLETE') throw businessError('Registry must be complete before possession begins', 'REGISTRY_COMPLETION_REQUIRED');
    const idempotencyKey = cleanText(req.body.idempotency_key, 'Idempotency key', 120);
    const { rows: existing } = await db.query(`SELECT * FROM plot_possessions WHERE registry_id=$1`, [registryId]);
    if (existing[0]) return existing[0];
    const checklist = Array.isArray(req.body.checklist) ? req.body.checklist.slice(0, 50) : [];
    const { rows: created } = await db.query(`INSERT INTO plot_possessions (organization_id,site_id,plot_id,booking_id,registry_id,allottee_member_id,rera_project_id,rera_project_phase_id,status,checklist,handled_by,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'READY',$9,$10,$11) RETURNING *`, [req.user.organization_id, siteId, registry.plot_id, registry.booking_id, registryId, registry.client_member_id, registry.rera_project_id, registry.rera_project_phase_id, checklist, req.user.id, idempotencyKey]);
    await db.query(`UPDATE plot_registries SET possession_status='READY',updated_at=NOW() WHERE id=$1`, [registryId]);
    await db.query(`UPDATE bookings SET lifecycle_status='POSSESSION_PENDING',workflow_version=workflow_version+1,updated_at=NOW() WHERE id=$1`, [registry.booking_id]);
    await db.query(`UPDATE plots SET lifecycle_status='POSSESSION_PENDING',possession_status='READY',lifecycle_version=lifecycle_version+1,updated_at=NOW() WHERE id=$1`, [registry.plot_id]);
    await writeComplianceAudit(db, req, { action: 'POSSESSION_CREATED', entityType: 'PLOT_POSSESSION', entityId: created[0].id, siteId, newValue: { ...created[0], booking_id: registry.booking_id } });
    return created[0];
  });
  res.status(201).json({ possession });
});

/** PATCH /property-lifecycle/possessions/:possessionId/status */
export const transitionPossession = asyncHandler(async (req, res) => {
  const possession = await inTransaction(async (db) => {
    const possessionId = positiveId(req.params.possessionId, 'possession_id');
    const siteId = siteIdFrom(req);
    const { rows: contextRows } = await db.query(`SELECT booking_id FROM plot_possessions WHERE id=$1 AND site_id=$2 AND organization_id=$3`, [possessionId, siteId, req.user.organization_id]);
    if (!contextRows[0]) throw businessError('Possession record not found', 'POSSESSION_NOT_FOUND', 404);
    await lockBooking(db, req, contextRows[0].booking_id);
    const { rows } = await db.query(`SELECT * FROM plot_possessions WHERE id=$1 AND site_id=$2 AND organization_id=$3 FOR UPDATE`, [possessionId, siteId, req.user.organization_id]);
    const previous = rows[0];
    if (!previous) throw businessError('Possession record not found', 'POSSESSION_NOT_FOUND', 404);
    const next = assertTransition(POSSESSION_TRANSITIONS, previous.status, req.body.status, 'Possession');
    if (next === 'POSSESSED') requireAdmin(req);
    if (next === 'ACKNOWLEDGED' && (!req.body.acknowledgement || typeof req.body.acknowledgement !== 'object')) throw businessError('Customer acknowledgement is required', 'ACKNOWLEDGEMENT_REQUIRED', 400);
    const scheduledAt = next === 'HANDOVER_SCHEDULED' ? cleanText(req.body.scheduled_at, 'Scheduled date/time', 40, { required: true }) : previous.scheduled_at;
    const possessionDate = next === 'POSSESSED' ? isoDate(req.body.possession_date || new Date().toISOString().slice(0, 10), 'Possession date', { required: true }) : previous.possession_date;
    const acknowledgement = next === 'ACKNOWLEDGED' ? req.body.acknowledgement : previous.acknowledgement;
    const markPossessed = next === 'POSSESSED';
    const { rows: changed } = await db.query(
      `UPDATE plot_possessions
          SET status=$1,
              scheduled_at=$2,
              possession_date=$3,
              acknowledgement=$4,
              handled_by=COALESCE($5,handled_by),
              completed_by=CASE WHEN $6 THEN $5 ELSE completed_by END,
              completed_at=CASE WHEN $6 THEN NOW() ELSE completed_at END,
              updated_at=NOW()
        WHERE id=$7
        RETURNING *`,
      [next, scheduledAt, possessionDate, acknowledgement || {}, req.user.id, markPossessed, possessionId],
    );
    await db.query(`UPDATE plot_registries SET possession_status=$1,updated_at=NOW() WHERE id=$2`, [next, previous.registry_id]);
    if (next === 'POSSESSED') {
      await db.query(`UPDATE bookings SET lifecycle_status='POSSESSED',workflow_version=workflow_version+1,updated_at=NOW() WHERE id=$1`, [previous.booking_id]);
      await db.query(`UPDATE plots SET lifecycle_status='POSSESSED',possession_status='POSSESSED',status='POSSESSED',lifecycle_version=lifecycle_version+1,updated_at=NOW() WHERE id=$1`, [previous.plot_id]);
    }
    await writeComplianceAudit(db, req, { action: 'POSSESSION_STATUS_CHANGED', entityType: 'PLOT_POSSESSION', entityId: possessionId, siteId, previousValue: { status: previous.status }, newValue: { status: next, booking_id: previous.booking_id, acknowledgement: next === 'ACKNOWLEDGED' ? acknowledgement : undefined }, reason: req.body.reason });
    return changed[0];
  });
  res.json({ possession });
});

/** POST /property-lifecycle/payments/:paymentId/reconcile */
export const reconcilePayment = asyncHandler(async (req, res) => {
  const result = await inTransaction(async (db) => {
    const paymentId = positiveId(req.params.paymentId, 'payment_id');
    const firmTransactionId = positiveId(req.body.firm_transaction_id, 'firm_transaction_id');
    const siteId = siteIdFrom(req);
    const { rows } = await db.query(
      `SELECT pp.*,ft.credit AS bank_credit,ft.debit AS bank_debit,ft.rera_project_id AS bank_project_id,
              ft.rera_project_phase_id AS bank_phase_id
         FROM plot_payments pp JOIN firm_transactions ft ON ft.id=$2 AND ft.site_id=pp.site_id
        WHERE pp.id=$1 AND pp.site_id=$3 FOR UPDATE OF pp,ft`,
      [paymentId, firmTransactionId, siteId],
    );
    const payment = rows[0];
    if (!payment) throw businessError('Receipt and bank entry must belong to the same Site', 'RECONCILIATION_SCOPE_MISMATCH', 409);
    if (payment.reconciled_firm_transaction_id && Number(payment.reconciled_firm_transaction_id) !== firmTransactionId) throw businessError('Receipt is already matched to another bank entry', 'RECEIPT_ALREADY_MATCHED');
    const amountMatches = Math.round(Number(payment.amount) * 100) === Math.round(Number(payment.bank_credit) * 100);
    const projectMatches = !payment.rera_project_id || !payment.bank_project_id || Number(payment.rera_project_id) === Number(payment.bank_project_id);
    const status = !projectMatches ? 'WRONG_PROJECT' : amountMatches ? 'MATCHED' : 'AMOUNT_VARIANCE';
    const { rows: changed } = await db.query(`UPDATE plot_payments SET reconciliation_status=$1,reconciled_firm_transaction_id=$2,reconciled_at=NOW(),reconciled_by=$3,updated_at=NOW() WHERE id=$4 RETURNING *`, [status, firmTransactionId, req.user.id, paymentId]);
    await db.query(`UPDATE firm_transactions SET reconciliation_context=COALESCE(reconciliation_context,'{}'::jsonb)||$1::jsonb,updated_at=NOW() WHERE id=$2`, [JSON.stringify({ status, plot_payment_id: paymentId, booking_id: payment.booking_id, customer: payment.buyer_name, plot_id: payment.plot_id, project_id: payment.rera_project_id, phase_id: payment.rera_project_phase_id }), firmTransactionId]);
    await writeComplianceAudit(db, req, { action: 'PLOT_PAYMENT_RECONCILED', entityType: 'PROPERTY_BOOKING', entityId: payment.booking_id || payment.plot_id, siteId, previousValue: { reconciliation_status: payment.reconciliation_status }, newValue: { reconciliation_status: status, plot_payment_id: paymentId, firm_transaction_id: firmTransactionId, booking_id: payment.booking_id } });
    return { payment: changed[0], status };
  });
  res.json(result);
});

/** POST /property-lifecycle/project-finance/accounts */
export const createProjectAccountMapping = asyncHandler(async (req, res) => {
  const mapping = await inTransaction(async (db) => {
    const siteId = siteIdFrom(req);
    const firmId = positiveId(req.body.firm_id, 'firm_id');
    const projectId = positiveId(req.body.rera_project_id, 'rera_project_id');
    const phaseId = positiveId(req.body.rera_project_phase_id, 'rera_project_phase_id', { optional: true });
    const purpose = cleanText(req.body.purpose, 'Account purpose', 80, { required: true }).toUpperCase();
    const effectiveFrom = isoDate(req.body.effective_from, 'Effective date', { required: true });
    const effectiveTo = isoDate(req.body.effective_to, 'Effective-to date');
    const evidenceDocumentId = positiveId(req.body.evidence_document_id, 'evidence_document_id', { optional: true });
    if (effectiveTo && effectiveTo < effectiveFrom) throw businessError('Effective-to date cannot precede the start date', 'INVALID_EFFECTIVE_RANGE', 400);
    const { rows: context } = await db.query(
      `SELECT rp.id,f.bank_name,f.account_number,f.ifsc_code,
              EXISTS (
                SELECT 1 FROM site_operating_profile_revisions profile
                 WHERE profile.organization_id=rp.organization_id AND profile.site_id=rp.site_id
                   AND profile.lifecycle_status='PUBLISHED' AND profile.effective_to IS NULL
                   AND profile.deleted_at IS NULL
                   AND profile.operating_model IN ('RERA_PROJECT_PROMOTER','RERA_ONGOING_PROJECT_REGULARISATION')
              ) AS rera_mode
         FROM rera_projects rp
         JOIN sites s ON s.id=rp.site_id AND s.organization_id=rp.organization_id
         JOIN firms f ON f.id=$4 AND f.site_id=rp.site_id
        WHERE rp.id=$1 AND rp.site_id=$2 AND rp.organization_id=$3 AND rp.deleted_at IS NULL
          AND ($5::bigint IS NULL OR EXISTS (
            SELECT 1 FROM rera_project_phases ph WHERE ph.id=$5 AND ph.rera_project_id=rp.id
              AND ph.site_id=rp.site_id AND ph.organization_id=rp.organization_id AND ph.deleted_at IS NULL
          ))`,
      [projectId, siteId, req.user.organization_id, firmId, phaseId],
    );
    if (!context[0]) throw businessError('Account, project and phase must belong to the selected Site', 'PROJECT_ACCOUNT_SCOPE_MISMATCH');
    const designatedReraPurpose = ['RERA_SEPARATE_ACCOUNT', 'SEPARATE_ACCOUNT', 'DESIGNATED_COLLECTION_ACCOUNT'].includes(purpose);
    if (context[0].rera_mode && designatedReraPurpose) {
      if (!context[0].bank_name || !context[0].account_number) {
        throw businessError('A RERA separate account must have bank name and account number recorded', 'RERA_BANK_ACCOUNT_DETAILS_REQUIRED', 400);
      }
      if (!evidenceDocumentId) {
        throw businessError('Upload and link bank account evidence before mapping the RERA separate account', 'RERA_BANK_ACCOUNT_EVIDENCE_REQUIRED', 400);
      }
    }
    if (evidenceDocumentId) {
      const { rows: evidence } = await db.query(
        `SELECT 1 FROM documents WHERE id=$1 AND site_id=$2 AND organization_id=$3`,
        [evidenceDocumentId, siteId, req.user.organization_id],
      );
      if (!evidence[0]) throw businessError('Account evidence document is outside the selected Site', 'ACCOUNT_EVIDENCE_SCOPE_MISMATCH');
    }
    const { rows } = await db.query(
      `INSERT INTO project_account_mappings (
         organization_id,site_id,firm_id,rera_project_id,rera_project_phase_id,purpose,
         effective_from,effective_to,evidence_document_id,review_status,created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',$10) RETURNING *`,
      [req.user.organization_id, siteId, firmId, projectId, phaseId, purpose, effectiveFrom, effectiveTo,
        evidenceDocumentId, req.user.id],
    );
    await writeComplianceAudit(db, req, { action: 'PROJECT_ACCOUNT_MAPPED', entityType: 'PROJECT_ACCOUNT_MAPPING', entityId: rows[0].id, siteId, newValue: rows[0] });
    return rows[0];
  });
  res.status(201).json({ mapping });
});

/** PATCH /property-lifecycle/project-finance/accounts/:mappingId/review */
export const reviewProjectAccountMapping = asyncHandler(async (req, res) => {
  requireAdmin(req);
  const mapping = await inTransaction(async (db) => {
    const siteId = siteIdFrom(req);
    const mappingId = positiveId(req.params.mappingId, 'mapping_id');
    const decision = String(req.body.decision || '').toUpperCase();
    if (!['REVIEWED', 'REJECTED'].includes(decision)) throw businessError('decision must be REVIEWED or REJECTED', 'INVALID_REVIEW_DECISION', 400);
    const { rows } = await db.query(
      `SELECT pam.*,f.bank_name,f.account_number,
              EXISTS (
                SELECT 1 FROM site_operating_profile_revisions profile
                 WHERE profile.organization_id=pam.organization_id AND profile.site_id=pam.site_id
                   AND profile.lifecycle_status='PUBLISHED' AND profile.effective_to IS NULL
                   AND profile.deleted_at IS NULL
                   AND profile.operating_model IN ('RERA_PROJECT_PROMOTER','RERA_ONGOING_PROJECT_REGULARISATION')
              ) AS rera_mode
         FROM project_account_mappings pam
         JOIN firms f ON f.id=pam.firm_id AND f.site_id=pam.site_id
        WHERE pam.id=$1 AND pam.site_id=$2 AND pam.organization_id=$3 FOR UPDATE OF pam`,
      [mappingId, siteId, req.user.organization_id],
    );
    if (!rows[0]) throw businessError('Project account mapping not found', 'PROJECT_ACCOUNT_MAPPING_NOT_FOUND', 404);
    const designatedReraPurpose = ['RERA_SEPARATE_ACCOUNT', 'SEPARATE_ACCOUNT', 'DESIGNATED_COLLECTION_ACCOUNT']
      .includes(String(rows[0].purpose || '').toUpperCase());
    if (decision === 'REVIEWED' && rows[0].rera_mode && designatedReraPurpose
        && (!rows[0].bank_name || !rows[0].account_number || !rows[0].evidence_document_id)) {
      throw businessError('Bank details and account evidence are required before reviewing a RERA separate account', 'RERA_BANK_ACCOUNT_EVIDENCE_REQUIRED', 400);
    }
    const { rows: changed } = await db.query(`UPDATE project_account_mappings SET review_status=$1,reviewed_by=$2,reviewed_at=NOW(),effective_to=CASE WHEN $1='REJECTED' THEN COALESCE(effective_to,GREATEST(effective_from,CURRENT_DATE)) ELSE effective_to END WHERE id=$3 RETURNING *`, [decision, req.user.id, mappingId]);
    await writeComplianceAudit(db, req, { action: 'PROJECT_ACCOUNT_REVIEWED', entityType: 'PROJECT_ACCOUNT_MAPPING', entityId: mappingId, siteId, previousValue: { review_status: rows[0].review_status }, newValue: { review_status: decision }, reason: cleanText(req.body.reason, 'Review reason', 4000) });
    return changed[0];
  });
  res.json({ mapping });
});

const PROJECT_ALLOCATION_SOURCES = Object.freeze({
  EXPENSE: `SELECT e.id,e.site_id,GREATEST(COALESCE(e.debit,0),COALESCE(e.credit,0)) AS source_amount FROM expenses e WHERE e.id=$1 AND e.site_id=$2 FOR UPDATE`,
  VENDOR_PAYMENT: `SELECT vp.id,vp.site_id,vp.amount AS source_amount FROM vendor_payments vp WHERE vp.id=$1 AND vp.site_id=$2 FOR UPDATE`,
  FARMER_PAYMENT: `SELECT fp.id,f.site_id,fp.amount AS source_amount FROM farmer_payments fp JOIN farmers f ON f.id=fp.farmer_id WHERE fp.id=$1 AND f.site_id=$2 FOR UPDATE OF fp`,
  FIRM_TRANSACTION: `SELECT ft.id,ft.site_id,GREATEST(COALESCE(ft.debit,0),COALESCE(ft.credit,0)) AS source_amount FROM firm_transactions ft WHERE ft.id=$1 AND ft.site_id=$2 FOR UPDATE`,
  DAY_BOOK: `SELECT db.id,db.site_id,GREATEST(COALESCE(db.debit,0),COALESCE(db.credit,0)) AS source_amount FROM day_book db WHERE db.id=$1 AND db.site_id=$2 FOR UPDATE`,
});

/** POST /property-lifecycle/project-finance/allocations */
export const createProjectTransactionAllocation = asyncHandler(async (req, res) => {
  requireAdmin(req);
  const allocation = await inTransaction(async (db) => {
    const siteId = siteIdFrom(req);
    const sourceModule = String(req.body.source_module || '').toUpperCase();
    const sourceQuery = PROJECT_ALLOCATION_SOURCES[sourceModule];
    if (!sourceQuery) throw businessError('Unsupported project allocation source', 'INVALID_ALLOCATION_SOURCE', 400);
    const sourceId = positiveId(req.body.source_id, 'source_id');
    const projectId = positiveId(req.body.rera_project_id, 'rera_project_id');
    const phaseId = positiveId(req.body.rera_project_phase_id, 'rera_project_phase_id', { optional: true });
    const method = String(req.body.allocation_method || 'DIRECT').toUpperCase();
    if (!['DIRECT', 'AMOUNT', 'PERCENTAGE'].includes(method)) throw businessError('A valid allocation method is required', 'INVALID_ALLOCATION_METHOD', 400);
    const { rows: sourceRows } = await db.query(sourceQuery, [sourceId, siteId]);
    const source = sourceRows[0];
    if (!source) throw businessError('Source transaction is outside the selected Site', 'ALLOCATION_SOURCE_SCOPE_MISMATCH', 409);
    const percentage = method === 'PERCENTAGE' ? Number(req.body.percentage) : null;
    if (method === 'PERCENTAGE' && (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100)) throw businessError('Percentage must be greater than 0 and at most 100', 'INVALID_ALLOCATION_PERCENTAGE', 400);
    const computedAmount = method === 'PERCENTAGE'
      ? (Math.round(Number(source.source_amount) * percentage) / 100).toFixed(2)
      : money(req.body.amount ?? (method === 'DIRECT' ? source.source_amount : null), 'Allocation amount', { required: true, allowZero: false });
    const { rows: usedRows } = await db.query(`SELECT COALESCE(SUM(amount),0) AS used FROM project_transaction_allocations WHERE organization_id=$1 AND source_module=$2 AND source_id=$3`, [req.user.organization_id, sourceModule, sourceId]);
    if (Math.round((Number(usedRows[0].used) + Number(computedAmount)) * 100) > Math.round(Number(source.source_amount) * 100)) throw businessError('Project allocations exceed the original transaction amount', 'ALLOCATION_EXCEEDS_SOURCE');
    const { rows } = await db.query(
      `INSERT INTO project_transaction_allocations (
         organization_id,site_id,source_module,source_id,rera_project_id,rera_project_phase_id,
         allocation_method,amount,percentage,reason,approved_by,approved_at,created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$11) RETURNING *`,
      [req.user.organization_id, siteId, sourceModule, sourceId, projectId, phaseId, method,
        computedAmount, percentage, cleanText(req.body.reason, 'Allocation reason', 4000, { required: true }), req.user.id],
    );
    await writeComplianceAudit(db, req, { action: 'PROJECT_TRANSACTION_ALLOCATED', entityType: 'PROJECT_TRANSACTION_ALLOCATION', entityId: rows[0].id, siteId, newValue: rows[0], reason: rows[0].reason });
    return rows[0];
  });
  res.status(201).json({ allocation });
});

/** GET /property-lifecycle/project-finance */
export const getProjectFinance = asyncHandler(async (req, res) => {
  const siteId = siteIdFrom(req);
  const projectId = positiveId(req.query.project_id, 'project_id');
  const phaseId = positiveId(req.query.phase_id, 'phase_id', { optional: true });
  // These legacy property queries need Site, project and phase only. Leaving
  // an unused $2 between their placeholders makes PostgreSQL reject the
  // request because that parameter has no inferable type.
  const projectParams = [siteId, projectId, phaseId];
  const projectScope = `p.site_id=$1 AND p.rera_project_id=$2 AND ($3::bigint IS NULL OR p.rera_project_phase_id=$3)`;
  const organizationProjectParams = [siteId, req.user.organization_id, projectId, phaseId];
  const [metrics, collections, expenses, unassignedExpenses, projectCostSummary, accounts, allocations, evidenceDocuments] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(b.final_consideration),0) AS booked,COALESCE(SUM(received.total),0) AS collected,COALESCE(SUM(GREATEST(b.final_consideration-COALESCE(received.total,0),0)),0) AS receivable,COALESCE(SUM(overdue.total),0) AS overdue,COALESCE(SUM(unmatched.total),0) AS unreconciled FROM bookings b JOIN plots p ON p.id=b.plot_id LEFT JOIN LATERAL (SELECT SUM(amount) AS total FROM plot_payments WHERE booking_id=b.id AND LOWER(COALESCE(status,'approved'))='approved' AND UPPER(COALESCE(cheque_status,'')) NOT IN ('BOUNCED','RETURNED')) received ON TRUE LEFT JOIN LATERAL (SELECT SUM(GREATEST(pi.amount-COALESCE(pa.total,0),0)) AS total FROM plot_installments pi LEFT JOIN LATERAL (SELECT SUM(ppa.allocated_amount) AS total FROM plot_payment_allocations ppa JOIN plot_payments allocated_payment ON allocated_payment.id=ppa.plot_payment_id WHERE ppa.installment_id=pi.id AND LOWER(COALESCE(allocated_payment.status,'approved'))='approved' AND UPPER(COALESCE(allocated_payment.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')) pa ON TRUE WHERE pi.booking_id=b.id AND pi.due_date<CURRENT_DATE AND pi.superseded_at IS NULL) overdue ON TRUE LEFT JOIN LATERAL (SELECT SUM(amount) AS total FROM plot_payments WHERE booking_id=b.id AND reconciliation_status<>'MATCHED' AND LOWER(COALESCE(status,'approved'))='approved') unmatched ON TRUE WHERE ${projectScope}`, projectParams),
    pool.query(`SELECT pp.*,b.booking_no,p.plot_no,m.full_name AS customer_name FROM plot_payments pp JOIN bookings b ON b.id=pp.booking_id JOIN plots p ON p.id=pp.plot_id LEFT JOIN members m ON m.id=b.client_member_id WHERE ${projectScope} ORDER BY pp.date DESC,pp.id DESC LIMIT 200`, projectParams),
    pool.query(`SELECT e.id,e.date,COALESCE(e.remark,e.category) AS description,GREATEST(COALESCE(e.debit,0),COALESCE(e.credit,0)) AS amount,e.debit,e.credit,e.status,e.rera_project_id,e.rera_project_phase_id,'PROJECT' AS project_scope FROM expenses e WHERE e.site_id=$1 AND ((e.rera_project_id=$2 AND ($3::bigint IS NULL OR e.rera_project_phase_id=$3)) OR EXISTS (SELECT 1 FROM project_transaction_allocations a WHERE a.site_id=e.site_id AND a.source_module='EXPENSE' AND a.source_id=e.id AND a.rera_project_id=$2 AND ($3::bigint IS NULL OR a.rera_project_phase_id IS NULL OR a.rera_project_phase_id=$3))) ORDER BY e.date DESC,e.id DESC LIMIT 200`, projectParams),
    pool.query(`SELECT e.id,e.date,COALESCE(e.remark,e.category) AS description,GREATEST(COALESCE(e.debit,0),COALESCE(e.credit,0)) AS amount,e.debit,e.credit,e.status,e.rera_project_id,e.rera_project_phase_id,'UNASSIGNED' AS project_scope FROM expenses e WHERE e.site_id=$1 AND e.rera_project_id IS NULL AND NOT EXISTS (SELECT 1 FROM project_transaction_allocations a WHERE a.site_id=e.site_id AND a.source_module='EXPENSE' AND a.source_id=e.id) ORDER BY e.date DESC,e.id DESC LIMIT 200`, [siteId]),
    pool.query(`SELECT COALESCE(SUM(GREATEST(COALESCE(e.debit,0),COALESCE(e.credit,0))),0) AS project_cost FROM expenses e WHERE e.site_id=$1 AND ((e.rera_project_id=$2 AND ($3::bigint IS NULL OR e.rera_project_phase_id=$3)) OR EXISTS (SELECT 1 FROM project_transaction_allocations a WHERE a.site_id=e.site_id AND a.source_module='EXPENSE' AND a.source_id=e.id AND a.rera_project_id=$2 AND ($3::bigint IS NULL OR a.rera_project_phase_id IS NULL OR a.rera_project_phase_id=$3)))`, projectParams),
    pool.query(`SELECT pam.*,f.name AS firm_name,f.bank_name,f.account_number FROM project_account_mappings pam JOIN firms f ON f.id=pam.firm_id WHERE pam.organization_id=$2 AND pam.site_id=$1 AND pam.rera_project_id=$3 AND ($4::bigint IS NULL OR pam.rera_project_phase_id=$4) ORDER BY pam.effective_from DESC`, organizationProjectParams),
    pool.query(`SELECT * FROM project_transaction_allocations WHERE organization_id=$2 AND site_id=$1 AND rera_project_id=$3 AND ($4::bigint IS NULL OR rera_project_phase_id=$4) ORDER BY created_at DESC LIMIT 200`, organizationProjectParams),
    pool.query(
      `SELECT id,title,original_name,category,doc_date,mime_type,created_at
         FROM documents
        WHERE organization_id=$1 AND site_id=$2 AND uploaded_source='DMS'
        ORDER BY created_at DESC,id DESC LIMIT 200`,
      [req.user.organization_id, siteId],
    ),
  ]);
  res.json({
    metrics: {
      ...(metrics.rows[0] || {}),
      project_cost: projectCostSummary.rows[0]?.project_cost || 0,
      unassigned_cost: unassignedExpenses.rows.reduce((total, row) => total + Math.max(Number(row.amount || 0), Number(row.credit || 0)), 0),
    },
    collections: collections.rows,
    expenses: expenses.rows,
    unassigned_expenses: unassignedExpenses.rows,
    accounts: accounts.rows,
    allocations: allocations.rows,
    evidence_documents: evidenceDocuments.rows,
  });
});
