import pool from '../config/db.js';
import { writeComplianceAudit } from '../utils/complianceAccess.js';
import { resolveSitePolicy } from '../services/sitePolicy.service.js';
import {
  CERTIFICATION_TRANSITIONS,
  CHANGE_TRANSITIONS,
  EXTENSION_TRANSITIONS,
  FILING_TRANSITIONS,
  assertTransition,
  calculateCostPosition,
  deriveOperationalProgress,
  evaluateFilingReadiness,
  filingRequirementStatus,
  normalizeDate,
  normalizePercent,
  normalizeText,
} from '../services/constructionPhase3.service.js';

const phaseHandler = (handler) => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (error) {
    if (error.statusCode || error.status) {
      res.status(error.statusCode || error.status).json({
        message: error.message,
        code: error.code,
        details: error.details,
      });
      return;
    }
    if (error.code === '23505') {
      res.status(409).json({ message: 'A record with this scope or idempotency key already exists', code: 'DUPLICATE_RECORD' });
      return;
    }
    if (['23503', '23514', '22P02'].includes(error.code)) {
      res.status(400).json({ message: 'The request contains an invalid or out-of-scope reference', code: 'INVALID_REFERENCE' });
      return;
    }
    next(error);
  }
};

const businessError = (message, code, statusCode = 409, details = undefined) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
};

const positiveId = (value, field = 'id', { optional = false } = {}) => {
  if ((value === null || value === undefined || value === '') && optional) return null;
  const id = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(id) || id <= 0) throw businessError(`${field} must be a positive integer`, 'INVALID_ID', 400);
  return id;
};

const jsonObject = (value, fallback = {}) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value : fallback
);
const jsonArray = (value) => (Array.isArray(value) ? value : []);
const siteIdFrom = (req) => positiveId(req.constructionSiteId ?? req.siteContextId, 'site_id');

async function inTransaction(work) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

async function requireCapability(req, capability, db = pool) {
  const siteId = siteIdFrom(req);
  const policy = await resolveSitePolicy({ organizationId: req.user.organization_id, siteId, db });
  if (policy.capabilities?.[capability] !== true) {
    throw businessError('This capability is not enabled by the published Site policy', 'CAPABILITY_DISABLED', 403, { capability });
  }
  return policy;
}

async function projectContext(db, req, rawProjectId, { lock = false, requireRera = false } = {}) {
  const projectId = positiveId(rawProjectId, 'construction_project_id');
  const suffix = lock ? ' FOR UPDATE OF p' : '';
  const { rows } = await db.query(
    `SELECT p.*,rp.ruleset_version_id,rp.name AS rera_project_name,rpp.name AS rera_phase_name
       FROM construction_projects p
       JOIN sites s ON s.id=p.site_id AND s.organization_id=p.organization_id
       LEFT JOIN rera_projects rp ON rp.id=p.rera_project_id AND rp.organization_id=p.organization_id
        AND rp.site_id=p.site_id AND rp.deleted_at IS NULL
       LEFT JOIN rera_project_phases rpp ON rpp.id=p.rera_project_phase_id
        AND rpp.organization_id=p.organization_id AND rpp.site_id=p.site_id AND rpp.deleted_at IS NULL
      WHERE p.id=$1 AND p.site_id=$2 AND p.organization_id=$3${suffix}`,
    [projectId, siteIdFrom(req), req.user.organization_id],
  );
  if (!rows[0]) throw businessError('Construction project not found for the selected Site', 'PROJECT_NOT_FOUND', 404);
  if (requireRera && !rows[0].rera_project_id) {
    throw businessError('Map this Construction project to a RERA Project before using this workflow', 'RERA_MAPPING_REQUIRED', 409);
  }
  return rows[0];
}

async function packageContext(db, req, rawId, { lock = false } = {}) {
  const id = positiveId(rawId, 'work_package_id');
  const suffix = lock ? ' FOR UPDATE OF wp' : '';
  const { rows } = await db.query(
    `SELECT wp.*,p.name AS construction_project_name
       FROM construction_work_packages wp
       JOIN construction_projects p ON p.id=wp.construction_project_id
        AND p.organization_id=wp.organization_id AND p.site_id=wp.site_id
      WHERE wp.id=$1 AND wp.site_id=$2 AND wp.organization_id=$3 AND wp.deleted_at IS NULL${suffix}`,
    [id, siteIdFrom(req), req.user.organization_id],
  );
  if (!rows[0]) throw businessError('Work package not found for the selected Site', 'WORK_PACKAGE_NOT_FOUND', 404);
  return rows[0];
}

async function loadCostPosition(db, project, workPackageId = null) {
  const params = [project.site_id, project.id, workPackageId];
  const [material, commitment, allocation, forecast] = await Promise.all([
    db.query(
      `SELECT COALESCE(SUM(qty*rate),0) AS value,COALESCE(jsonb_agg(id ORDER BY id) FILTER (WHERE id IS NOT NULL),'[]') AS ids
         FROM inventory_movements
        WHERE site_id=$1 AND project_id=$2 AND movement_type='CONSUMPTION'
          AND ($3::bigint IS NULL OR work_package_id=$3)`,
      params,
    ),
    db.query(
      `SELECT COALESCE(SUM(COALESCE(link.allocation_amount,vc.contract_amount)),0) AS committed,
              COALESCE(SUM(COALESCE(paid.amount,0)),0) AS paid,
              COALESCE(jsonb_agg(DISTINCT vc.id) FILTER (WHERE vc.id IS NOT NULL),'[]') AS commitment_ids,
              COALESCE(jsonb_agg(DISTINCT paid.ids) FILTER (WHERE paid.ids IS NOT NULL),'[]') AS payment_id_groups
         FROM construction_work_package_commitments link
         JOIN vendor_commitments vc ON vc.id=link.vendor_commitment_id AND vc.site_id=link.site_id
         LEFT JOIN LATERAL (
           SELECT SUM(vp.amount) AS amount,jsonb_agg(vp.id ORDER BY vp.id) AS ids
             FROM vendor_payments vp WHERE vp.commitment_id=vc.id AND vp.site_id=vc.site_id
              AND LOWER(COALESCE(vp.status,'pending'))='approved'
         ) paid ON TRUE
        WHERE link.site_id=$1 AND link.construction_project_id=$2
          AND ($3::bigint IS NULL OR link.work_package_id=$3)`,
      params,
    ),
    db.query(
      `SELECT COALESCE(SUM(amount),0) AS value,
              COALESCE(jsonb_agg(id ORDER BY id) FILTER (WHERE id IS NOT NULL),'[]') AS ids
         FROM project_transaction_allocations
        WHERE site_id=$1 AND construction_project_id=$2
          AND ($3::bigint IS NULL OR construction_work_package_id=$3)`,
      params,
    ),
    db.query(
      `SELECT id,estimated_additional_cost,methodology,as_of_date,source_references
         FROM construction_cost_forecasts
        WHERE site_id=$1 AND construction_project_id=$2
          AND work_package_id IS NOT DISTINCT FROM $3::bigint AND approval_status='APPROVED'
        ORDER BY as_of_date DESC,id DESC LIMIT 1`,
      params,
    ),
  ]);
  const budget = workPackageId
    ? (await db.query('SELECT approved_budget FROM construction_work_packages WHERE id=$1', [workPackageId])).rows[0]?.approved_budget
    : project.budget;
  return {
    ...calculateCostPosition({
      budget,
      committed: commitment.rows[0].committed,
      paid: commitment.rows[0].paid,
      materialConsumed: material.rows[0].value,
      allocatedActual: allocation.rows[0].value,
      estimatedAdditionalCost: forecast.rows[0]?.estimated_additional_cost,
    }),
    latestForecast: forecast.rows[0] || null,
    sourceReferences: {
      inventoryMovementIds: material.rows[0].ids,
      vendorCommitmentIds: commitment.rows[0].commitment_ids,
      vendorPaymentIdGroups: commitment.rows[0].payment_id_groups,
      projectAllocationIds: allocation.rows[0].ids,
      forecastId: forecast.rows[0]?.id || null,
    },
  };
}

async function latestReconciliation(db, filingPeriodId) {
  const { rows: runRows } = await db.query(
    `SELECT run_key,MAX(created_at) AS created_at FROM rera_filing_reconciliation_results
      WHERE filing_period_id=$1 GROUP BY run_key ORDER BY created_at DESC LIMIT 1`,
    [filingPeriodId],
  );
  if (!runRows[0]) return { runKey: null, results: [] };
  const { rows } = await db.query(
    `SELECT * FROM rera_filing_reconciliation_results WHERE filing_period_id=$1 AND run_key=$2 ORDER BY section,check_code`,
    [filingPeriodId, runRows[0].run_key],
  );
  return { runKey: runRows[0].run_key, results: rows };
}

export const getConstructionCommandCentre = phaseHandler(async (req, res) => {
  const siteId = siteIdFrom(req);
  const organizationId = req.user.organization_id;
  const policy = await resolveSitePolicy({ organizationId, siteId });
  const requestedProjectId = req.query.project_id ? positiveId(req.query.project_id, 'project_id') : null;
  const projectParams = [siteId, organizationId];
  const projectFilter = requestedProjectId ? ' AND p.id=$3' : '';
  if (requestedProjectId) projectParams.push(requestedProjectId);
  const [projects, packages, certifications, filings, risks, options] = await Promise.all([
    pool.query(
      `SELECT p.*,rp.name AS rera_project_name,rpp.name AS rera_phase_name,
              COALESCE(wp.total,0)::int AS work_package_count,COALESCE(wp.attention,0)::int AS work_packages_needing_attention,
              COALESCE(tasks.total,0)::int AS task_count,COALESCE(tasks.done,0)::int AS done_task_count,
              COALESCE(material.value,0) AS material_consumed_cost,
              COALESCE(finance.value,0) AS finance_allocated_actual,
              COALESCE(commitment.committed,0) AS committed_cost,COALESCE(commitment.paid,0) AS paid_cost,
              COALESCE(material.value,0)+COALESCE(finance.value,0) AS actual_cost,
              COALESCE(forecast.estimated_additional_cost,0) AS cost_to_complete,
              COALESCE(material.value,0)+COALESCE(finance.value,0)+COALESCE(forecast.estimated_additional_cost,0) AS estimate_at_completion,
              latest_cert.certified_progress_pct AS latest_certified_progress_pct,
              latest_cert.certification_period_end AS latest_certification_period_end
         FROM construction_projects p
         LEFT JOIN rera_projects rp ON rp.id=p.rera_project_id AND rp.organization_id=p.organization_id AND rp.deleted_at IS NULL
         LEFT JOIN rera_project_phases rpp ON rpp.id=p.rera_project_phase_id AND rpp.organization_id=p.organization_id AND rpp.deleted_at IS NULL
         LEFT JOIN LATERAL (SELECT COUNT(*) AS total,COUNT(*) FILTER (WHERE status IN ('AT_RISK','DELAYED','BLOCKED')) AS attention FROM construction_work_packages x WHERE x.construction_project_id=p.id AND x.deleted_at IS NULL) wp ON TRUE
         LEFT JOIN LATERAL (SELECT COUNT(*) AS total,COUNT(*) FILTER (WHERE status='DONE') AS done FROM construction_tasks t WHERE t.project_id=p.id) tasks ON TRUE
         LEFT JOIN LATERAL (SELECT SUM(qty*rate) AS value FROM inventory_movements im WHERE im.site_id=p.site_id AND im.project_id=p.id AND im.movement_type='CONSUMPTION') material ON TRUE
         LEFT JOIN LATERAL (SELECT SUM(amount) AS value FROM project_transaction_allocations a WHERE a.site_id=p.site_id AND a.construction_project_id=p.id) finance ON TRUE
         LEFT JOIN LATERAL (
           SELECT SUM(COALESCE(link.allocation_amount,vc.contract_amount)) AS committed,SUM(COALESCE(paid.amount,0)) AS paid
             FROM construction_work_package_commitments link JOIN vendor_commitments vc ON vc.id=link.vendor_commitment_id
             LEFT JOIN LATERAL (SELECT SUM(vp.amount) AS amount FROM vendor_payments vp WHERE vp.commitment_id=vc.id AND LOWER(COALESCE(vp.status,'pending'))='approved') paid ON TRUE
            WHERE link.construction_project_id=p.id AND link.site_id=p.site_id
         ) commitment ON TRUE
         LEFT JOIN LATERAL (SELECT estimated_additional_cost FROM construction_cost_forecasts x WHERE x.construction_project_id=p.id AND x.work_package_id IS NULL AND x.approval_status='APPROVED' ORDER BY x.as_of_date DESC,x.id DESC LIMIT 1) forecast ON TRUE
         LEFT JOIN LATERAL (SELECT certified_progress_pct,certification_period_end FROM construction_certifications c WHERE c.construction_project_id=p.id AND c.status IN ('CERTIFIED','APPROVED') ORDER BY c.certification_period_end DESC,c.id DESC LIMIT 1) latest_cert ON TRUE
        WHERE p.site_id=$1 AND p.organization_id=$2${projectFilter}
        ORDER BY p.updated_at DESC,p.id DESC`,
      projectParams,
    ),
    pool.query(
      `SELECT wp.*,p.name AS project_name,u.name AS owner_name,next_owner.name AS next_action_owner_name,
              COALESCE(t.total,0)::int AS task_count,COALESCE(t.done,0)::int AS done_task_count,
              COALESCE(material.value,0) AS material_consumed_cost,COALESCE(finance.value,0) AS finance_allocated_actual,
              COALESCE(material.value,0)+COALESCE(finance.value,0) AS actual_cost,
              COALESCE(forecast.estimated_additional_cost,0) AS cost_to_complete,
              COALESCE(material.value,0)+COALESCE(finance.value,0)+COALESCE(forecast.estimated_additional_cost,0) AS estimate_at_completion,
              latest_cert.certified_progress_pct AS certified_progress_pct,
              latest_cert.certification_period_end AS certified_through
         FROM construction_work_packages wp
         JOIN construction_projects p ON p.id=wp.construction_project_id AND p.organization_id=wp.organization_id
         LEFT JOIN users u ON u.id=wp.owner_user_id AND u.organization_id=wp.organization_id
         LEFT JOIN users next_owner ON next_owner.id=wp.next_action_owner_id AND next_owner.organization_id=wp.organization_id
         LEFT JOIN LATERAL (SELECT COUNT(*) AS total,COUNT(*) FILTER (WHERE status='DONE') AS done FROM construction_tasks t WHERE t.work_package_id=wp.id) t ON TRUE
         LEFT JOIN LATERAL (SELECT SUM(qty*rate) AS value FROM inventory_movements im WHERE im.work_package_id=wp.id AND im.movement_type='CONSUMPTION') material ON TRUE
         LEFT JOIN LATERAL (SELECT SUM(amount) AS value FROM project_transaction_allocations a WHERE a.construction_work_package_id=wp.id) finance ON TRUE
         LEFT JOIN LATERAL (SELECT estimated_additional_cost FROM construction_cost_forecasts x WHERE x.work_package_id=wp.id AND x.approval_status='APPROVED' ORDER BY x.as_of_date DESC,x.id DESC LIMIT 1) forecast ON TRUE
         LEFT JOIN LATERAL (SELECT certified_progress_pct,certification_period_end FROM construction_certifications c WHERE c.work_package_id=wp.id AND c.status IN ('CERTIFIED','APPROVED') ORDER BY c.certification_period_end DESC,c.id DESC LIMIT 1) latest_cert ON TRUE
        WHERE wp.site_id=$1 AND wp.organization_id=$2 AND wp.deleted_at IS NULL
          AND ($3::integer IS NULL OR wp.construction_project_id=$3)
        ORDER BY COALESCE(wp.next_action_due_date,wp.forecast_end_date) NULLS LAST,wp.id`,
      [siteId, organizationId, requestedProjectId],
    ),
    pool.query(
      `SELECT c.*,p.name AS project_name,wp.name AS work_package_name,stakeholder.legal_name AS professional_name
         FROM construction_certifications c JOIN construction_projects p ON p.id=c.construction_project_id
         LEFT JOIN construction_work_packages wp ON wp.id=c.work_package_id
         LEFT JOIN rera_stakeholders stakeholder ON stakeholder.id=c.professional_stakeholder_id
        WHERE c.site_id=$1 AND c.organization_id=$2 AND ($3::integer IS NULL OR c.construction_project_id=$3)
        ORDER BY c.certification_period_end DESC,c.id DESC LIMIT 50`,
      [siteId, organizationId, requestedProjectId],
    ),
    pool.query(
      `SELECT f.*,rp.name AS project_name,rpp.name AS phase_name,rv.version AS ruleset_version,rv.version_label,
              COALESCE(req.open_count,0)::int AS open_requirement_count,
              COALESCE(rec.blockers,0)::int AS reconciliation_blocker_count
         FROM rera_filing_periods f JOIN rera_projects rp ON rp.id=f.rera_project_id
         LEFT JOIN rera_project_phases rpp ON rpp.id=f.rera_project_phase_id
         JOIN rera_ruleset_versions rv ON rv.id=f.ruleset_version_id
         LEFT JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE status NOT IN ('COMPLETE','NOT_APPLICABLE')) AS open_count FROM rera_filing_requirements x WHERE x.filing_period_id=f.id) req ON TRUE
         LEFT JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE status IN ('ERROR','REVIEW_REQUIRED')) AS blockers FROM rera_filing_reconciliation_results x WHERE x.filing_period_id=f.id AND x.run_key=(SELECT run_key FROM rera_filing_reconciliation_results y WHERE y.filing_period_id=f.id ORDER BY created_at DESC LIMIT 1)) rec ON TRUE
        WHERE f.site_id=$1 AND f.organization_id=$2
          AND ($3::bigint IS NULL OR f.rera_project_id=(SELECT rera_project_id FROM construction_projects WHERE id=$3))
        ORDER BY COALESCE(f.due_date,f.period_end),f.id DESC LIMIT 50`,
      [siteId, organizationId, requestedProjectId],
    ),
    pool.query(
      `SELECT r.*,p.name AS project_name,wp.name AS work_package_name,u.name AS owner_name
         FROM construction_risks r JOIN construction_projects p ON p.id=r.construction_project_id
         LEFT JOIN construction_work_packages wp ON wp.id=r.work_package_id
         LEFT JOIN users u ON u.id=r.owner_user_id
        WHERE r.site_id=$1 AND r.organization_id=$2 AND r.status IN ('OPEN','IN_PROGRESS')
          AND ($3::integer IS NULL OR r.construction_project_id=$3)
        ORDER BY CASE r.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,r.due_date NULLS LAST,r.id DESC`,
      [siteId, organizationId, requestedProjectId],
    ),
    Promise.all([
      pool.query(`SELECT id,name,project_code,ruleset_version_id FROM rera_projects WHERE site_id=$1 AND organization_id=$2 AND deleted_at IS NULL ORDER BY name`, [siteId, organizationId]),
      pool.query(`SELECT id,name FROM users WHERE organization_id=$1 AND is_active=TRUE AND (role IN ('admin','super_admin') OR EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id=users.id AND us.site_id=$2)) ORDER BY name`, [organizationId, siteId]),
      pool.query(`SELECT id,legal_name,stakeholder_type FROM rera_stakeholders WHERE organization_id=$1 AND deleted_at IS NULL AND status='ACTIVE' ORDER BY legal_name`, [organizationId]),
    ]),
  ]);

  const attention = [
    ...packages.rows.filter((row) => ['AT_RISK', 'DELAYED', 'BLOCKED'].includes(row.status) || (row.next_action_due_date && new Date(row.next_action_due_date) < new Date())).map((row) => ({ type: 'WORK_PACKAGE', id: row.id, severity: row.status === 'BLOCKED' ? 'HIGH' : 'MEDIUM', title: row.name, reason: row.blocker || row.next_action || row.status, owner: row.next_action_owner_name || row.owner_name })),
    ...risks.rows.map((row) => ({ type: 'RISK', id: row.id, severity: row.severity, title: row.description, reason: row.impact, owner: row.owner_name })),
    ...filings.rows.filter((row) => row.reconciliation_blocker_count > 0 || row.open_requirement_count > 0).map((row) => ({ type: 'FILING', id: row.id, severity: row.reconciliation_blocker_count > 0 ? 'HIGH' : 'MEDIUM', title: `${row.filing_type} · ${row.project_name}`, reason: `${row.reconciliation_blocker_count} reconciliation blockers; ${row.open_requirement_count} requirements open` })),
  ].slice(0, 30);

  res.json({
    policy: { mode: policy.mode, capabilities: policy.capabilities, terminology: policy.terminology, reasons: policy.reasons },
    projects: projects.rows,
    work_packages: packages.rows,
    certifications: certifications.rows,
    filing_periods: filings.rows,
    risks: risks.rows,
    attention,
    options: { rera_projects: options[0].rows, users: options[1].rows, stakeholders: options[2].rows },
  });
});

export const getWorkPackage = phaseHandler(async (req, res) => {
  const workPackage = await packageContext(pool, req, req.params.workPackageId);
  const [tasks, daily, materials, commitments, documents] = await Promise.all([
    pool.query(`SELECT t.*,u.name AS assignee_name FROM construction_tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.work_package_id=$1 ORDER BY t.sequence,t.id`, [workPackage.id]),
    pool.query(`SELECT d.*,u.name AS engineer_name,reviewer.name AS reviewer_name FROM construction_daily_updates d LEFT JOIN users u ON u.id=d.responsible_engineer_id LEFT JOIN users reviewer ON reviewer.id=d.reviewer_id WHERE d.work_package_id=$1 ORDER BY d.update_date DESC,d.id DESC LIMIT 100`, [workPackage.id]),
    pool.query(`SELECT im.*,m.name AS material_name,m.unit FROM inventory_movements im JOIN inventory_materials m ON m.id=im.material_id WHERE im.work_package_id=$1 ORDER BY im.created_at DESC,im.id DESC LIMIT 100`, [workPackage.id]),
    pool.query(`SELECT link.*,vc.vendor_name,vc.work_title,vc.contract_amount,vc.status,COALESCE(paid.amount,0) AS paid_amount FROM construction_work_package_commitments link JOIN vendor_commitments vc ON vc.id=link.vendor_commitment_id LEFT JOIN LATERAL (SELECT SUM(amount) AS amount FROM vendor_payments WHERE commitment_id=vc.id AND LOWER(COALESCE(status,'pending'))='approved') paid ON TRUE WHERE link.work_package_id=$1 ORDER BY link.id DESC`, [workPackage.id]),
    pool.query(`SELECT * FROM compliance_documents WHERE organization_id=$1 AND site_id=$2 AND entity_type IN ('CONSTRUCTION_WORK_PACKAGE','CONSTRUCTION_DAILY_UPDATE') AND (entity_id=$3 OR entity_id IN (SELECT id FROM construction_daily_updates WHERE work_package_id=$3)) AND deleted_at IS NULL ORDER BY created_at DESC`, [req.user.organization_id, siteIdFrom(req), workPackage.id]),
  ]);
  const project = await projectContext(pool, req, workPackage.construction_project_id);
  const cost = await loadCostPosition(pool, project, workPackage.id);
  res.json({ work_package: workPackage, tasks: tasks.rows, daily_updates: daily.rows, material_movements: materials.rows, commitments: commitments.rows, evidence: documents.rows, cost });
});

export const linkWorkPackageCommitment = phaseHandler(async (req, res) => {
  const link = await inTransaction(async (db) => {
    const workPackage = await packageContext(db, req, req.params.workPackageId, { lock: true });
    const commitmentId = positiveId(req.body.vendor_commitment_id, 'vendor_commitment_id');
    const commitment = await db.query(
      `SELECT * FROM vendor_commitments WHERE id=$1 AND site_id=$2 AND status<>'cancelled' FOR UPDATE`,
      [commitmentId, workPackage.site_id],
    );
    if (!commitment.rows[0]) throw businessError('Vendor commitment is outside this Site or cancelled', 'COMMITMENT_SCOPE_MISMATCH', 409);
    const allocationAmount = req.body.allocation_amount === undefined || req.body.allocation_amount === ''
      ? null : Number(req.body.allocation_amount);
    if (allocationAmount !== null && (!Number.isFinite(allocationAmount) || allocationAmount < 0 || allocationAmount > Number(commitment.rows[0].contract_amount))) {
      throw businessError('Allocation must be between zero and the commitment amount', 'INVALID_ALLOCATION', 400);
    }
    const { rows } = await db.query(
      `INSERT INTO construction_work_package_commitments (organization_id,site_id,construction_project_id,work_package_id,vendor_commitment_id,allocation_amount,notes,linked_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (work_package_id,vendor_commitment_id) DO UPDATE SET allocation_amount=EXCLUDED.allocation_amount,notes=EXCLUDED.notes
       RETURNING *`,
      [workPackage.organization_id, workPackage.site_id, workPackage.construction_project_id, workPackage.id, commitmentId, allocationAmount, normalizeText(req.body.notes, 'notes'), req.user.id],
    );
    await writeComplianceAudit(db, req, { action: 'CONSTRUCTION_VENDOR_COMMITMENT_LINKED', entityType: 'CONSTRUCTION_WORK_PACKAGE', entityId: workPackage.id, siteId: workPackage.site_id, newValue: rows[0] });
    return rows[0];
  });
  res.status(201).json({ commitment_link: link });
});

export const createWorkPackage = phaseHandler(async (req, res) => {
  const workPackage = await inTransaction(async (db) => {
    const project = await projectContext(db, req, req.params.id, { lock: true });
    const parentId = positiveId(req.body.parent_work_package_id, 'parent_work_package_id', { optional: true });
    if (parentId) {
      const parent = await packageContext(db, req, parentId);
      if (parent.construction_project_id !== project.id) throw businessError('Parent work package belongs to another Construction project', 'PARENT_SCOPE_MISMATCH', 409);
    }
    const ownerId = positiveId(req.body.owner_user_id, 'owner_user_id', { optional: true });
    const nextOwnerId = positiveId(req.body.next_action_owner_id, 'next_action_owner_id', { optional: true });
    const contractorId = positiveId(req.body.contractor_stakeholder_id, 'contractor_stakeholder_id', { optional: true });
    const progress = normalizePercent(req.body.operational_progress_pct ?? 0, 'operational_progress_pct');
    const { rows } = await db.query(
      `INSERT INTO construction_work_packages (
        organization_id,site_id,construction_project_id,rera_project_id,rera_project_phase_id,parent_work_package_id,
        code,name,category,scope_type,scope_label,building_or_block,infrastructure_package,plan_version,cost_centre_code,
        approved_budget,baseline_start_date,baseline_end_date,revised_start_date,revised_end_date,forecast_end_date,
        owner_user_id,contractor_stakeholder_id,status,progress_method,operational_progress_pct,weight,
        next_action,next_action_owner_id,next_action_due_date,notes,created_by,updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$32)
      RETURNING *`,
      [project.organization_id, project.site_id, project.id, project.rera_project_id, project.rera_project_phase_id, parentId,
        normalizeText(req.body.code, 'code', { required: true, max: 80 }), normalizeText(req.body.name, 'name', { required: true, max: 300 }),
        normalizeText(req.body.category, 'category', { max: 100 }), String(req.body.scope_type || 'GENERAL').toUpperCase(),
        normalizeText(req.body.scope_label, 'scope_label', { max: 200 }), normalizeText(req.body.building_or_block, 'building_or_block', { max: 160 }),
        normalizeText(req.body.infrastructure_package, 'infrastructure_package', { max: 160 }), normalizeText(req.body.plan_version, 'plan_version', { max: 120 }),
        normalizeText(req.body.cost_centre_code, 'cost_centre_code', { max: 80 }), Number(req.body.approved_budget || 0),
        normalizeDate(req.body.baseline_start_date, 'baseline_start_date'), normalizeDate(req.body.baseline_end_date, 'baseline_end_date'),
        normalizeDate(req.body.revised_start_date, 'revised_start_date'), normalizeDate(req.body.revised_end_date, 'revised_end_date'),
        normalizeDate(req.body.forecast_end_date, 'forecast_end_date'), ownerId, contractorId, String(req.body.status || 'PLANNING').toUpperCase(),
        String(req.body.progress_method || 'MANUAL').toUpperCase(), progress, req.body.weight || null,
        normalizeText(req.body.next_action, 'next_action'), nextOwnerId, normalizeDate(req.body.next_action_due_date, 'next_action_due_date'),
        normalizeText(req.body.notes, 'notes'), req.user.id],
    );
    await writeComplianceAudit(db, req, { action: 'CONSTRUCTION_WORK_PACKAGE_CREATED', entityType: 'CONSTRUCTION_WORK_PACKAGE', entityId: rows[0].id, siteId: project.site_id, newValue: rows[0] });
    return rows[0];
  });
  res.status(201).json({ work_package: workPackage });
});

export const updateWorkPackage = phaseHandler(async (req, res) => {
  const workPackage = await inTransaction(async (db) => {
    const current = await packageContext(db, req, req.params.workPackageId, { lock: true });
    const expectedVersion = positiveId(req.body.workflow_version, 'workflow_version');
    if (current.workflow_version !== expectedVersion) throw businessError('This work package changed after it was opened. Refresh and try again.', 'STALE_WORK_PACKAGE', 409, { currentVersion: current.workflow_version });
    const mutable = ['name', 'category', 'scope_type', 'scope_label', 'building_or_block', 'infrastructure_package', 'plan_version', 'cost_centre_code', 'approved_budget', 'forecast_end_date', 'owner_user_id', 'contractor_stakeholder_id', 'status', 'progress_method', 'weight', 'next_action', 'next_action_owner_id', 'next_action_due_date', 'notes'];
    const sets = [];
    const params = [];
    for (const field of mutable) {
      if (req.body[field] === undefined) continue;
      let value = req.body[field];
      if (['owner_user_id', 'contractor_stakeholder_id', 'next_action_owner_id'].includes(field)) value = positiveId(value, field, { optional: true });
      else if (['forecast_end_date', 'next_action_due_date'].includes(field)) value = normalizeDate(value, field);
      else if (['scope_type', 'status', 'progress_method'].includes(field)) value = String(value).toUpperCase();
      else if (['approved_budget', 'weight'].includes(field)) value = value === '' || value === null ? null : Number(value);
      else value = normalizeText(value, field, { required: field === 'name', max: field === 'name' ? 300 : 2000 });
      params.push(value); sets.push(`${field}=$${params.length}`);
    }
    if (req.body.operational_progress_pct !== undefined) {
      const nextProgress = normalizePercent(req.body.operational_progress_pct, 'operational_progress_pct');
      const reason = normalizeText(req.body.progress_reason, 'progress_reason', { required: true });
      params.push(nextProgress); sets.push(`operational_progress_pct=$${params.length}`);
      await db.query(
        `INSERT INTO construction_progress_updates (organization_id,site_id,construction_project_id,work_package_id,source_type,previous_progress_pct,new_progress_pct,reason,created_by)
         VALUES ($1,$2,$3,$4,'MANUAL_OVERRIDE',$5,$6,$7,$8)`,
        [current.organization_id, current.site_id, current.construction_project_id, current.id, current.operational_progress_pct, nextProgress, reason, req.user.id],
      );
    }
    if (!sets.length) throw businessError('Nothing to update', 'NO_CHANGES', 400);
    params.push(current.id, expectedVersion);
    const { rows } = await db.query(
      `UPDATE construction_work_packages SET ${sets.join(',')},workflow_version=workflow_version+1,updated_by=$${params.length + 1},updated_at=NOW()
        WHERE id=$${params.length - 1} AND workflow_version=$${params.length} RETURNING *`,
      [...params, req.user.id],
    );
    if (!rows[0]) throw businessError('This work package changed after it was opened', 'STALE_WORK_PACKAGE', 409);
    await writeComplianceAudit(db, req, { action: 'CONSTRUCTION_WORK_PACKAGE_UPDATED', entityType: 'CONSTRUCTION_WORK_PACKAGE', entityId: current.id, siteId: current.site_id, previousValue: current, newValue: rows[0], reason: req.body.change_reason });
    return rows[0];
  });
  res.json({ work_package: workPackage });
});

export const createDailyUpdate = phaseHandler(async (req, res) => {
  const update = await inTransaction(async (db) => {
    const workPackage = await packageContext(db, req, req.body.work_package_id, { lock: true });
    const project = await projectContext(db, req, workPackage.construction_project_id, { lock: true });
    const taskId = positiveId(req.body.task_id, 'task_id', { optional: true });
    let task = null;
    if (taskId) {
      const { rows } = await db.query('SELECT * FROM construction_tasks WHERE id=$1 AND project_id=$2 AND work_package_id=$3 FOR UPDATE', [taskId, project.id, workPackage.id]);
      task = rows[0];
      if (!task) throw businessError('Task does not belong to this work package', 'TASK_SCOPE_MISMATCH', 409);
    }
    const newProgress = req.body.new_progress_pct === undefined ? null : normalizePercent(req.body.new_progress_pct, 'new_progress_pct');
    const previousProgress = Number(task?.progress_pct ?? workPackage.operational_progress_pct);
    const { rows } = await db.query(
      `INSERT INTO construction_daily_updates (organization_id,site_id,construction_project_id,rera_project_id,rera_project_phase_id,work_package_id,task_id,update_date,previous_progress_pct,new_progress_pct,manpower,work_completed,work_planned,blocker,weather,remarks,responsible_engineer_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [project.organization_id, project.site_id, project.id, project.rera_project_id, project.rera_project_phase_id, workPackage.id, taskId,
        normalizeDate(req.body.update_date, 'update_date', { required: true }), previousProgress, newProgress,
        jsonObject(req.body.manpower), normalizeText(req.body.work_completed, 'work_completed', { required: true, max: 8000 }),
        normalizeText(req.body.work_planned, 'work_planned', { max: 8000 }), normalizeText(req.body.blocker, 'blocker', { max: 4000 }),
        jsonObject(req.body.weather), normalizeText(req.body.remarks, 'remarks', { max: 8000 }),
        positiveId(req.body.responsible_engineer_id, 'responsible_engineer_id', { optional: true }) || req.user.id, req.user.id],
    );
    if (newProgress !== null && newProgress !== previousProgress) {
      const reason = normalizeText(req.body.progress_reason || req.body.work_completed, 'progress_reason', { required: true, max: 4000 });
      await db.query(
        `INSERT INTO construction_progress_updates (organization_id,site_id,construction_project_id,work_package_id,task_id,source_type,previous_progress_pct,new_progress_pct,reason,evidence_required,created_by)
         VALUES ($1,$2,$3,$4,$5,'DAILY_UPDATE',$6,$7,$8,TRUE,$9)`,
        [project.organization_id, project.site_id, project.id, workPackage.id, taskId, previousProgress, newProgress, reason, req.user.id],
      );
      if (task) {
        await db.query(`UPDATE construction_tasks SET progress_pct=$1,status=CASE WHEN $1>=100 THEN 'DONE' WHEN $1>0 AND status='PENDING' THEN 'IN_PROGRESS' ELSE status END,completed_at=CASE WHEN $1>=100 THEN COALESCE(completed_at,NOW()) ELSE completed_at END,workflow_version=workflow_version+1,updated_at=NOW() WHERE id=$2`, [Math.round(newProgress), task.id]);
      } else {
        await db.query(`UPDATE construction_work_packages SET operational_progress_pct=$1,workflow_version=workflow_version+1,updated_by=$2,updated_at=NOW() WHERE id=$3`, [newProgress, req.user.id, workPackage.id]);
      }
    }
    for (const movementId of jsonArray(req.body.inventory_movement_ids).map((id) => positiveId(id, 'inventory_movement_id'))) {
      const linked = await db.query(`INSERT INTO construction_daily_update_materials (daily_update_id,inventory_movement_id) SELECT $1,im.id FROM inventory_movements im WHERE im.id=$2 AND im.site_id=$3 AND im.project_id=$4 AND (im.work_package_id IS NULL OR im.work_package_id=$5) ON CONFLICT DO NOTHING RETURNING inventory_movement_id`, [rows[0].id, movementId, project.site_id, project.id, workPackage.id]);
      if (!linked.rows[0]) throw businessError('A material movement is outside this work package', 'MATERIAL_SCOPE_MISMATCH', 409);
      await db.query('UPDATE inventory_movements SET work_package_id=COALESCE(work_package_id,$1) WHERE id=$2', [workPackage.id, movementId]);
    }
    await writeComplianceAudit(db, req, { action: 'CONSTRUCTION_DAILY_UPDATE_CREATED', entityType: 'CONSTRUCTION_DAILY_UPDATE', entityId: rows[0].id, siteId: project.site_id, newValue: { ...rows[0], inventory_movement_ids: req.body.inventory_movement_ids || [] } });
    return rows[0];
  });
  res.status(201).json({ daily_update: update });
});

export const reviseSchedule = phaseHandler(async (req, res) => {
  const revision = await inTransaction(async (db) => {
    const project = await projectContext(db, req, req.params.id, { lock: true });
    const entityType = String(req.body.entity_type || 'PROJECT').toUpperCase();
    const workPackageId = positiveId(req.body.work_package_id, 'work_package_id', { optional: true });
    const taskId = positiveId(req.body.task_id, 'task_id', { optional: true });
    let current;
    let updateSql;
    let updateId;
    if (entityType === 'PROJECT') {
      current = project; updateSql = `UPDATE construction_projects SET revised_start_date=$1,revised_end_date=$2,forecast_end_date=COALESCE($3,forecast_end_date),workflow_version=workflow_version+1,updated_at=NOW() WHERE id=$4`; updateId = project.id;
    } else if (entityType === 'WORK_PACKAGE' && workPackageId) {
      current = await packageContext(db, req, workPackageId, { lock: true });
      if (current.construction_project_id !== project.id) throw businessError('Work package belongs to another project', 'SCHEDULE_SCOPE_MISMATCH', 409);
      updateSql = `UPDATE construction_work_packages SET revised_start_date=$1,revised_end_date=$2,forecast_end_date=COALESCE($3,forecast_end_date),workflow_version=workflow_version+1,updated_by=$5,updated_at=NOW() WHERE id=$4`; updateId = workPackageId;
    } else if (entityType === 'TASK' && taskId) {
      const { rows } = await db.query('SELECT * FROM construction_tasks WHERE id=$1 AND project_id=$2 FOR UPDATE', [taskId, project.id]); current = rows[0];
      if (!current) throw businessError('Task belongs to another project', 'SCHEDULE_SCOPE_MISMATCH', 409);
      updateSql = `UPDATE construction_tasks SET revised_start_date=$1,revised_end_date=$2,forecast_end_date=COALESCE($3,forecast_end_date),workflow_version=workflow_version+1,updated_at=NOW() WHERE id=$4`; updateId = taskId;
    } else throw businessError('entity_type must be PROJECT, WORK_PACKAGE, or TASK with its matching ID', 'INVALID_SCHEDULE_ENTITY', 400);
    const newStart = normalizeDate(req.body.new_start_date, 'new_start_date');
    const newEnd = normalizeDate(req.body.new_end_date, 'new_end_date', { required: true });
    const forecastEnd = normalizeDate(req.body.forecast_end_date, 'forecast_end_date');
    const reason = normalizeText(req.body.reason, 'reason', { required: true, max: 4000 });
    const { rows } = await db.query(
      `INSERT INTO construction_schedule_revisions (organization_id,site_id,construction_project_id,work_package_id,task_id,entity_type,previous_start_date,previous_end_date,new_start_date,new_end_date,revision_kind,reason,delay_cause,requested_by,approval_status,effective_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'APPROVED',$15) RETURNING *`,
      [project.organization_id, project.site_id, project.id, workPackageId, taskId, entityType,
        current.revised_start_date || current.start_date, current.revised_end_date || current.due_date || current.target_end_date,
        newStart, newEnd, String(req.body.revision_kind || 'REVISED').toUpperCase(), reason,
        normalizeText(req.body.delay_cause, 'delay_cause', { max: 160 }), req.user.id,
        normalizeDate(req.body.effective_date, 'effective_date') || new Date().toISOString().slice(0, 10)],
    );
    await db.query(updateSql, entityType === 'WORK_PACKAGE' ? [newStart, newEnd, forecastEnd, updateId, req.user.id] : [newStart, newEnd, forecastEnd, updateId]);
    await writeComplianceAudit(db, req, { action: 'CONSTRUCTION_SCHEDULE_REVISED', entityType: `CONSTRUCTION_${entityType}`, entityId: updateId, siteId: project.site_id, previousValue: { start: rows[0].previous_start_date, end: rows[0].previous_end_date }, newValue: { start: newStart, end: newEnd, forecast_end: forecastEnd }, reason });
    return rows[0];
  });
  res.status(201).json({ schedule_revision: revision });
});

export const listCertifications = phaseHandler(async (req, res) => {
  await requireCapability(req, 'construction_certification');
  const projectId = req.query.project_id ? positiveId(req.query.project_id, 'project_id') : null;
  const { rows } = await pool.query(
    `SELECT c.*,p.name AS project_name,wp.name AS work_package_name,s.legal_name AS professional_name,
            COALESCE(ev.evidence,'[]') AS evidence
       FROM construction_certifications c JOIN construction_projects p ON p.id=c.construction_project_id
       LEFT JOIN construction_work_packages wp ON wp.id=c.work_package_id
       JOIN rera_stakeholders s ON s.id=c.professional_stakeholder_id
       LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id',d.id,'title',d.title,'verification_status',d.verification_status,'approval_status',d.approval_status,'version_no',d.version_no) ORDER BY d.created_at DESC) AS evidence FROM construction_certification_evidence link JOIN compliance_documents d ON d.id=link.compliance_document_id AND d.deleted_at IS NULL WHERE link.certification_id=c.id) ev ON TRUE
      WHERE c.site_id=$1 AND c.organization_id=$2 AND ($3::integer IS NULL OR c.construction_project_id=$3)
      ORDER BY c.certification_period_end DESC,c.id DESC`,
    [siteIdFrom(req), req.user.organization_id, projectId],
  );
  res.json({ certifications: rows });
});

export const createCertification = phaseHandler(async (req, res) => {
  await requireCapability(req, 'construction_certification');
  const certification = await inTransaction(async (db) => {
    const project = await projectContext(db, req, req.body.construction_project_id, { lock: true, requireRera: true });
    const workPackageId = positiveId(req.body.work_package_id, 'work_package_id', { optional: true });
    let operationalProgress = project.progress_pct;
    let operationalSnapshot;
    if (workPackageId) {
      const workPackage = await packageContext(db, req, workPackageId);
      if (workPackage.construction_project_id !== project.id) throw businessError('Work package belongs to another project', 'CERTIFICATION_SCOPE_MISMATCH', 409);
      operationalProgress = workPackage.operational_progress_pct;
      operationalSnapshot = { entityType: 'WORK_PACKAGE', workPackageId, progressMethod: workPackage.progress_method, workflowVersion: workPackage.workflow_version, operationalProgressPct: Number(operationalProgress) };
    } else {
      operationalSnapshot = { entityType: 'PROJECT', constructionProjectId: project.id, progressMethod: project.progress_method, workflowVersion: project.workflow_version, operationalProgressPct: Number(operationalProgress) };
    }
    const cost = await loadCostPosition(db, project, workPackageId);
    const proposed = normalizePercent(req.body.proposed_certified_progress_pct, 'proposed_certified_progress_pct');
    const professionalId = positiveId(req.body.professional_stakeholder_id, 'professional_stakeholder_id');
    const stakeholder = await db.query('SELECT id FROM rera_stakeholders WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL AND status=\'ACTIVE\'', [professionalId, project.organization_id]);
    if (!stakeholder.rows[0]) throw businessError('Certifying professional is outside the organization or inactive', 'CERTIFIER_INVALID', 400);
    const { rows } = await db.query(
      `INSERT INTO construction_certifications (organization_id,site_id,construction_project_id,rera_project_id,rera_project_phase_id,work_package_id,certification_period_start,certification_period_end,operational_progress_snapshot,operational_progress_pct,proposed_certified_progress_pct,cost_snapshot,input_data_references,professional_stakeholder_id,professional_type,exceptions,review_notes,idempotency_key,supersedes_certification_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [project.organization_id, project.site_id, project.id, project.rera_project_id, project.rera_project_phase_id, workPackageId,
        normalizeDate(req.body.certification_period_start, 'certification_period_start', { required: true }), normalizeDate(req.body.certification_period_end, 'certification_period_end', { required: true }),
        operationalSnapshot, operationalProgress, proposed, cost, cost.sourceReferences, professionalId,
        String(req.body.professional_type || 'ENGINEER').toUpperCase(), jsonArray(req.body.exceptions), normalizeText(req.body.review_notes, 'review_notes', { max: 8000 }),
        normalizeText(req.body.idempotency_key, 'idempotency_key', { max: 120 }), positiveId(req.body.supersedes_certification_id, 'supersedes_certification_id', { optional: true }), req.user.id],
    );
    for (const documentId of jsonArray(req.body.evidence_ids).map((id) => positiveId(id, 'evidence_id'))) {
      const linked = await db.query(
        `INSERT INTO construction_certification_evidence (certification_id,compliance_document_id,evidence_role,linked_by)
         SELECT $1,d.id,$2,$3 FROM compliance_documents d WHERE d.id=$4 AND d.organization_id=$5 AND d.site_id=$6 AND d.deleted_at IS NULL
         ON CONFLICT DO NOTHING RETURNING compliance_document_id`,
        [rows[0].id, normalizeText(req.body.evidence_role, 'evidence_role', { max: 80 }), req.user.id, documentId, project.organization_id, project.site_id],
      );
      if (!linked.rows[0]) throw businessError('Evidence is outside the certification Site or organization', 'EVIDENCE_SCOPE_MISMATCH', 409);
    }
    await writeComplianceAudit(db, req, { action: 'CONSTRUCTION_CERTIFICATION_CREATED', entityType: 'CONSTRUCTION_CERTIFICATION', entityId: rows[0].id, siteId: project.site_id, newValue: rows[0] });
    return rows[0];
  });
  res.status(201).json({ certification });
});

export const transitionCertification = phaseHandler(async (req, res) => {
  await requireCapability(req, 'construction_certification');
  const certification = await inTransaction(async (db) => {
    const id = positiveId(req.params.certificationId, 'certification_id');
    const { rows } = await db.query(`SELECT c.* FROM construction_certifications c WHERE c.id=$1 AND c.site_id=$2 AND c.organization_id=$3 FOR UPDATE`, [id, siteIdFrom(req), req.user.organization_id]);
    const current = rows[0];
    if (!current) throw businessError('Certification not found', 'CERTIFICATION_NOT_FOUND', 404);
    const nextStatus = assertTransition(CERTIFICATION_TRANSITIONS, current.status, req.body.status);
    const finalizing = ['CERTIFIED', 'APPROVED'].includes(nextStatus);
    if (finalizing) {
      if (current.created_by === req.user.id) throw businessError('The creator cannot finalize their own certification', 'SEGREGATION_OF_DUTIES', 403);
      const evidence = await db.query(
        `SELECT d.id,d.verification_status,d.approval_status FROM construction_certification_evidence link JOIN compliance_documents d ON d.id=link.compliance_document_id WHERE link.certification_id=$1 AND d.deleted_at IS NULL`,
        [id],
      );
      if (!evidence.rows.length) throw businessError('At least one evidence document is required before certification', 'EVIDENCE_REQUIRED', 409);
      const unacceptable = evidence.rows.filter((item) => item.verification_status !== 'VERIFIED' || !['APPROVED', 'NOT_REQUIRED'].includes(item.approval_status));
      if (unacceptable.length) throw businessError('All certification evidence must be verified and approved or not require approval', 'EVIDENCE_NOT_READY', 409, { evidenceIds: unacceptable.map((item) => item.id) });
    }
    const certifiedPct = finalizing ? normalizePercent(req.body.certified_progress_pct ?? current.proposed_certified_progress_pct, 'certified_progress_pct') : current.certified_progress_pct;
    const certificationDate = finalizing ? normalizeDate(req.body.certification_date, 'certification_date', { required: true }) : current.certification_date;
    const { rows: changed } = await db.query(
      `UPDATE construction_certifications SET status=$1,certified_progress_pct=$2,certification_date=$3,review_notes=COALESCE($4,review_notes),reviewed_by=$5,finalized_by=CASE WHEN $6 THEN $5 ELSE finalized_by END,finalized_at=CASE WHEN $6 THEN NOW() ELSE finalized_at END,updated_at=NOW() WHERE id=$7 RETURNING *`,
      [nextStatus, certifiedPct, certificationDate, normalizeText(req.body.review_notes, 'review_notes', { max: 8000 }), req.user.id, finalizing, id],
    );
    await writeComplianceAudit(db, req, { action: `CONSTRUCTION_CERTIFICATION_${nextStatus}`, entityType: 'CONSTRUCTION_CERTIFICATION', entityId: id, siteId: current.site_id, previousValue: current, newValue: changed[0], reason: req.body.review_notes });
    return changed[0];
  });
  res.json({ certification });
});

export const createCostForecast = phaseHandler(async (req, res) => {
  const forecast = await inTransaction(async (db) => {
    const project = await projectContext(db, req, req.params.id, { lock: true });
    const workPackageId = positiveId(req.body.work_package_id, 'work_package_id', { optional: true });
    if (workPackageId) {
      const wp = await packageContext(db, req, workPackageId);
      if (wp.construction_project_id !== project.id) throw businessError('Work package belongs to another project', 'FORECAST_SCOPE_MISMATCH', 409);
    }
    const supersedesId = positiveId(req.body.supersedes_forecast_id, 'supersedes_forecast_id', { optional: true });
    if (supersedesId) await db.query(`UPDATE construction_cost_forecasts SET approval_status='SUPERSEDED' WHERE id=$1 AND construction_project_id=$2 AND approval_status='APPROVED'`, [supersedesId, project.id]);
    const { rows } = await db.query(
      `INSERT INTO construction_cost_forecasts (organization_id,site_id,construction_project_id,work_package_id,as_of_date,estimated_additional_cost,methodology,reason,source_references,supersedes_forecast_id,approval_status,approved_by,approved_at,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $11='APPROVED' THEN NOW() END,$12) RETURNING *`,
      [project.organization_id, project.site_id, project.id, workPackageId, normalizeDate(req.body.as_of_date, 'as_of_date', { required: true }), Number(req.body.estimated_additional_cost || 0), String(req.body.methodology || 'MANUAL_ESTIMATE').toUpperCase(), normalizeText(req.body.reason, 'reason', { required: true }), jsonArray(req.body.source_references), supersedesId, req.body.approve === true ? 'APPROVED' : 'PENDING', req.user.id],
    );
    await writeComplianceAudit(db, req, { action: 'CONSTRUCTION_COST_FORECAST_CREATED', entityType: 'CONSTRUCTION_COST_FORECAST', entityId: rows[0].id, siteId: project.site_id, newValue: rows[0] });
    return rows[0];
  });
  res.status(201).json({ cost_forecast: forecast });
});

export const listFilingPeriods = phaseHandler(async (req, res) => {
  await requireCapability(req, 'filing_preparation');
  const { rows } = await pool.query(
    `SELECT f.*,rp.name AS project_name,rpp.name AS phase_name,rv.version AS ruleset_version,rv.version_label,rv.source_review_status,
            COALESCE(req.requirements,'[]') AS requirements,COALESCE(snap.snapshots,'[]') AS snapshots,COALESCE(sub.submissions,'[]') AS submissions
       FROM rera_filing_periods f JOIN rera_projects rp ON rp.id=f.rera_project_id
       LEFT JOIN rera_project_phases rpp ON rpp.id=f.rera_project_phase_id JOIN rera_ruleset_versions rv ON rv.id=f.ruleset_version_id
       LEFT JOIN LATERAL (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) AS requirements FROM rera_filing_requirements x WHERE x.filing_period_id=f.id) req ON TRUE
       LEFT JOIN LATERAL (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) AS snapshots FROM rera_filing_snapshots x WHERE x.filing_period_id=f.id) snap ON TRUE
       LEFT JOIN LATERAL (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) AS submissions FROM rera_filing_submissions x WHERE x.filing_period_id=f.id) sub ON TRUE
      WHERE f.site_id=$1 AND f.organization_id=$2 ORDER BY COALESCE(f.due_date,f.period_end),f.id DESC`,
    [siteIdFrom(req), req.user.organization_id],
  );
  res.json({ filing_periods: rows });
});

export const createFilingPeriod = phaseHandler(async (req, res) => {
  await requireCapability(req, 'filing_preparation');
  const filing = await inTransaction(async (db) => {
    const project = await projectContext(db, req, req.body.construction_project_id, { requireRera: true });
    const rulesetId = project.ruleset_version_id;
    const { rows: rulesetRows } = await db.query(`SELECT rv.* FROM rera_ruleset_versions rv JOIN rera_rulesets r ON r.id=rv.ruleset_id WHERE rv.id=$1 AND rv.deleted_at IS NULL AND r.deleted_at IS NULL AND r.is_active=TRUE AND (r.organization_id IS NULL OR r.organization_id=$2)`, [rulesetId, project.organization_id]);
    const ruleset = rulesetRows[0];
    if (!ruleset) throw businessError('The project does not have an available pinned ruleset version', 'RULESET_NOT_AVAILABLE', 409);
    const reviewed = ruleset.source_review_status === 'REVIEWED' || (!ruleset.contains_legal_requirements && ruleset.source_review_status === 'NOT_APPLICABLE');
    const { rows } = await db.query(
      `INSERT INTO rera_filing_periods (organization_id,site_id,rera_project_id,rera_project_phase_id,ruleset_version_id,filing_type,period_start,period_end,due_date,requirements_resolution_status,prepared_by,idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [project.organization_id, project.site_id, project.rera_project_id, project.rera_project_phase_id, rulesetId,
        normalizeText(req.body.filing_type, 'filing_type', { required: true, max: 100 }).toUpperCase(), normalizeDate(req.body.period_start, 'period_start', { required: true }),
        normalizeDate(req.body.period_end, 'period_end', { required: true }), normalizeDate(req.body.due_date, 'due_date'), reviewed ? 'INCOMPLETE' : 'UNREVIEWED', req.user.id,
        normalizeText(req.body.idempotency_key, 'idempotency_key', { max: 120 })],
    );
    const requirements = await db.query(
      `SELECT * FROM rera_ruleset_requirements WHERE ruleset_version_id=$1 AND is_active=TRUE
        AND (requirement_kind='FILING' OR module_key IN ('rera_filing','filing','rera_projects','construction')) ORDER BY sequence,id`,
      [rulesetId],
    );
    for (const requirement of requirements.rows) {
      const isBlocking = requirement.is_mandatory === true || requirement.evidence_policy?.blocking === true || requirement.deadline_policy?.blocking === true;
      await db.query(
        `INSERT INTO rera_filing_requirements (filing_period_id,ruleset_requirement_id,requirement_code,requirement_kind,title,is_mandatory,is_blocking,source_review_status,requirement_policy,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [rows[0].id, requirement.id, requirement.requirement_code, requirement.requirement_kind, requirement.title, requirement.is_mandatory, isBlocking, requirement.source_review_status,
          { applicability: requirement.applicability_policy, fields: requirement.field_requirements, deadline: requirement.deadline_policy, evidence: requirement.evidence_policy, source_reference: requirement.source_reference, source_url: requirement.source_url },
          filingRequirementStatus(requirement, ruleset)],
      );
    }
    await writeComplianceAudit(db, req, { action: 'RERA_FILING_PERIOD_CREATED', entityType: 'RERA_FILING_PERIOD', entityId: rows[0].id, siteId: project.site_id, newValue: { ...rows[0], requirement_ids: requirements.rows.map((item) => item.id) } });
    return rows[0];
  });
  res.status(201).json({ filing_period: filing });
});

export const updateFilingRequirement = phaseHandler(async (req, res) => {
  await requireCapability(req, 'filing_preparation');
  const requirement = await inTransaction(async (db) => {
    const filing = await filingContext(db, req, req.params.filingId, { lock: true });
    if (['READY', 'SUBMITTED', 'ACCEPTED', 'SUPERSEDED'].includes(filing.status)) {
      throw businessError('Requirements on a ready or submitted filing are snapshot-locked', 'FILING_REQUIREMENTS_LOCKED', 409);
    }
    const requirementId = positiveId(req.params.requirementId, 'requirement_id');
    const { rows } = await db.query('SELECT * FROM rera_filing_requirements WHERE id=$1 AND filing_period_id=$2 FOR UPDATE', [requirementId, filing.id]);
    const current = rows[0];
    if (!current) throw businessError('Filing requirement not found', 'FILING_REQUIREMENT_NOT_FOUND', 404);
    const status = String(req.body.status || '').toUpperCase();
    if (!['PENDING', 'COMPLETE', 'ATTENTION', 'MISSING', 'NOT_APPLICABLE', 'REVIEW_REQUIRED'].includes(status)) throw businessError('Invalid filing requirement status', 'INVALID_REQUIREMENT_STATUS', 400);
    if (status === 'NOT_APPLICABLE' && !normalizeText(req.body.resolution_notes, 'resolution_notes')) throw businessError('A reason is required when a requirement is not applicable', 'RESOLUTION_REASON_REQUIRED', 400);
    const { rows: changed } = await db.query(`UPDATE rera_filing_requirements SET status=$1,owner_user_id=$2,resolution_notes=$3,updated_at=NOW() WHERE id=$4 RETURNING *`, [status, positiveId(req.body.owner_user_id, 'owner_user_id', { optional: true }), normalizeText(req.body.resolution_notes, 'resolution_notes', { max: 8000 }), requirementId]);
    await db.query(`UPDATE rera_filing_periods SET requirements_resolution_status=CASE WHEN EXISTS (SELECT 1 FROM rera_filing_requirements WHERE filing_period_id=$1 AND (is_mandatory OR is_blocking) AND status NOT IN ('COMPLETE','NOT_APPLICABLE')) THEN requirements_resolution_status ELSE 'RESOLVED' END,workflow_version=workflow_version+1,updated_at=NOW() WHERE id=$1`, [filing.id]);
    await writeComplianceAudit(db, req, { action: 'RERA_FILING_REQUIREMENT_UPDATED', entityType: 'RERA_FILING_PERIOD', entityId: filing.id, siteId: filing.site_id, previousValue: current, newValue: changed[0], reason: req.body.resolution_notes });
    return changed[0];
  });
  res.json({ requirement });
});

async function filingContext(db, req, rawId, { lock = false } = {}) {
  const id = positiveId(rawId, 'filing_period_id');
  const suffix = lock ? ' FOR UPDATE OF f' : '';
  const { rows } = await db.query(
    `SELECT f.*,rv.source_review_status,rv.contains_legal_requirements,rv.lifecycle_status AS ruleset_lifecycle_status,rv.version AS ruleset_version
       FROM rera_filing_periods f JOIN rera_ruleset_versions rv ON rv.id=f.ruleset_version_id
      WHERE f.id=$1 AND f.site_id=$2 AND f.organization_id=$3${suffix}`,
    [id, siteIdFrom(req), req.user.organization_id],
  );
  if (!rows[0]) throw businessError('Filing period not found', 'FILING_PERIOD_NOT_FOUND', 404);
  return rows[0];
}

export const runFilingReconciliation = phaseHandler(async (req, res) => {
  await requireCapability(req, 'filing_preparation');
  const payload = await inTransaction(async (db) => {
    const filing = await filingContext(db, req, req.params.filingId, { lock: true });
    const runKey = normalizeText(req.body.run_key, 'run_key', { max: 120 }) || `RUN-${Date.now()}-${req.user.id}`;
    const scope = [filing.site_id, filing.rera_project_id, filing.rera_project_phase_id];
    const [property, bookings, payments, accounts, construction, approvals] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE project_mapping_status<>'MAPPED')::int AS mapping_issues,COALESCE(jsonb_agg(id ORDER BY id) FILTER (WHERE id IS NOT NULL),'[]') AS ids FROM plots WHERE site_id=$1 AND rera_project_id=$2 AND ($3::bigint IS NULL OR rera_project_phase_id=$3)`, scope),
      db.query(`SELECT COUNT(*)::int AS total,COALESCE(SUM(final_consideration),0) AS consideration,COALESCE(jsonb_agg(id ORDER BY id) FILTER (WHERE id IS NOT NULL),'[]') AS ids FROM bookings WHERE site_id=$1 AND rera_project_id=$2 AND ($3::bigint IS NULL OR rera_project_phase_id=$3) AND COALESCE(lifecycle_status,'DRAFT') NOT IN ('CANCELLED','TRANSFERRED','CLOSED')`, scope),
      db.query(`SELECT COUNT(*)::int AS total,COALESCE(SUM(pp.amount),0) AS collected,COUNT(*) FILTER (WHERE pp.reconciliation_status<>'MATCHED')::int AS unreconciled,COALESCE(jsonb_agg(pp.id ORDER BY pp.id) FILTER (WHERE pp.id IS NOT NULL),'[]') AS ids FROM plot_payments pp JOIN plots p ON p.id=pp.plot_id AND p.site_id=pp.site_id WHERE pp.site_id=$1 AND p.rera_project_id=$2 AND ($3::bigint IS NULL OR p.rera_project_phase_id=$3) AND LOWER(COALESCE(pp.status,'approved'))='approved' AND UPPER(COALESCE(pp.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')`, scope),
      db.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE review_status<>'REVIEWED')::int AS unreviewed,COALESCE(jsonb_agg(id ORDER BY id) FILTER (WHERE id IS NOT NULL),'[]') AS ids FROM project_account_mappings WHERE site_id=$1 AND rera_project_id=$2 AND ($3::bigint IS NULL OR rera_project_phase_id=$3) AND effective_to IS NULL`, scope),
      db.query(`SELECT COUNT(DISTINCT p.id)::int AS project_count,COUNT(DISTINCT wp.id)::int AS package_count,COALESCE(AVG(wp.operational_progress_pct),AVG(p.progress_pct),0) AS operational_progress,COUNT(DISTINCT cert.id) FILTER (WHERE cert.status IN ('CERTIFIED','APPROVED'))::int AS certified_count,COALESCE(jsonb_agg(DISTINCT p.id) FILTER (WHERE p.id IS NOT NULL),'[]') AS project_ids,COALESCE(jsonb_agg(DISTINCT wp.id) FILTER (WHERE wp.id IS NOT NULL),'[]') AS package_ids,COALESCE(jsonb_agg(DISTINCT cert.id) FILTER (WHERE cert.id IS NOT NULL),'[]') AS certification_ids FROM construction_projects p LEFT JOIN construction_work_packages wp ON wp.construction_project_id=p.id AND wp.deleted_at IS NULL LEFT JOIN construction_certifications cert ON cert.construction_project_id=p.id AND cert.certification_period_end BETWEEN $4 AND $5 WHERE p.site_id=$1 AND p.rera_project_id=$2 AND ($3::bigint IS NULL OR p.rera_project_phase_id=$3)`, [...scope, filing.period_start, filing.period_end]),
      db.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE rera_status IN ('MISSING','EXPIRED','REJECTED'))::int AS blockers,COALESCE(jsonb_agg(id ORDER BY id) FILTER (WHERE id IS NOT NULL),'[]') AS ids FROM compliance_licences WHERE site_id=$1 AND rera_project_id=$2 AND ($3::bigint IS NULL OR rera_project_phase_id=$3) AND deleted_at IS NULL`, scope),
    ]);
    const checks = [
      { code: 'PROPERTY_INVENTORY_MAPPING', section: 'INVENTORY', status: property.rows[0].mapping_issues > 0 ? 'ERROR' : 'PASS', reason: property.rows[0].mapping_issues > 0 ? `${property.rows[0].mapping_issues} properties need mapping review` : `${property.rows[0].total} mapped properties found`, actual: property.rows[0], records: { table: 'plots', ids: property.rows[0].ids } },
      { code: 'ACTIVE_BOOKINGS', section: 'SALES', status: 'PASS', reason: `${bookings.rows[0].total} active bookings total ${bookings.rows[0].consideration}`, actual: bookings.rows[0], records: { table: 'bookings', ids: bookings.rows[0].ids } },
      { code: 'CUSTOMER_COLLECTIONS', section: 'COLLECTIONS', status: payments.rows[0].unreconciled > 0 ? 'ERROR' : 'PASS', reason: payments.rows[0].unreconciled > 0 ? `${payments.rows[0].unreconciled} approved receipts are not matched` : `${payments.rows[0].total} approved receipts reconcile`, actual: payments.rows[0], records: { table: 'plot_payments', ids: payments.rows[0].ids } },
      { code: 'PROJECT_ACCOUNTS', section: 'FINANCE', status: accounts.rows[0].total === 0 || accounts.rows[0].unreviewed > 0 ? 'REVIEW_REQUIRED' : 'PASS', reason: accounts.rows[0].total === 0 ? 'No active project account mapping exists' : accounts.rows[0].unreviewed > 0 ? `${accounts.rows[0].unreviewed} project account mappings are not reviewed` : 'Active project account mappings are reviewed', actual: accounts.rows[0], records: { table: 'project_account_mappings', ids: accounts.rows[0].ids } },
      { code: 'CONSTRUCTION_PROGRESS', section: 'CONSTRUCTION', status: construction.rows[0].project_count === 0 ? 'ERROR' : construction.rows[0].certified_count === 0 ? 'REVIEW_REQUIRED' : 'PASS', reason: construction.rows[0].project_count === 0 ? 'No Construction project is mapped to this filing scope' : construction.rows[0].certified_count === 0 ? 'Operational progress exists but no finalized certification covers this period' : `${construction.rows[0].certified_count} finalized certifications cover this period`, actual: construction.rows[0], records: { construction_projects: construction.rows[0].project_ids, work_packages: construction.rows[0].package_ids, certifications: construction.rows[0].certification_ids } },
      { code: 'APPROVAL_REGISTER', section: 'APPROVALS', status: approvals.rows[0].blockers > 0 ? 'ERROR' : approvals.rows[0].total === 0 ? 'REVIEW_REQUIRED' : 'PASS', reason: approvals.rows[0].blockers > 0 ? `${approvals.rows[0].blockers} approvals are missing, expired, or rejected` : approvals.rows[0].total === 0 ? 'No project approval records were found' : `${approvals.rows[0].total} approval records found without a blocking state`, actual: approvals.rows[0], records: { table: 'compliance_licences', ids: approvals.rows[0].ids } },
    ];
    for (const check of checks) {
      await db.query(`INSERT INTO rera_filing_reconciliation_results (filing_period_id,run_key,check_code,section,status,reason,actual_value,source_records,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [filing.id, runKey, check.code, check.section, check.status, check.reason, check.actual, check.records, req.user.id]);
    }
    const nextStatus = checks.some((check) => check.status === 'ERROR') ? 'DATA_RECONCILIATION' : checks.some((check) => check.status === 'REVIEW_REQUIRED') ? 'EVIDENCE_PENDING' : 'REVIEW';
    await db.query(`UPDATE rera_filing_periods SET status=$1,workflow_version=workflow_version+1,updated_at=NOW() WHERE id=$2`, [nextStatus, filing.id]);
    await writeComplianceAudit(db, req, { action: 'RERA_FILING_RECONCILED', entityType: 'RERA_FILING_PERIOD', entityId: filing.id, siteId: filing.site_id, newValue: { run_key: runKey, results: checks } });
    return { run_key: runKey, results: checks, filing_status: nextStatus };
  });
  res.json(payload);
});

export const createFilingSnapshot = phaseHandler(async (req, res) => {
  await requireCapability(req, 'filing_preparation');
  const snapshot = await inTransaction(async (db) => {
    const filing = await filingContext(db, req, req.params.filingId, { lock: true });
    const kind = String(req.body.snapshot_kind || 'REVIEW').toUpperCase();
    if (!['REVIEW', 'READY'].includes(kind)) throw businessError('snapshot_kind must be REVIEW or READY', 'INVALID_SNAPSHOT_KIND', 400);
    const [requirements, ruleset, reconciliation, projectSources, evidence, certifications] = await Promise.all([
      db.query('SELECT * FROM rera_filing_requirements WHERE filing_period_id=$1 ORDER BY id', [filing.id]),
      db.query('SELECT * FROM rera_ruleset_versions WHERE id=$1', [filing.ruleset_version_id]),
      latestReconciliation(db, filing.id),
      db.query(`SELECT p.id,p.lifecycle_status,p.final_consideration FROM bookings p WHERE p.site_id=$1 AND p.rera_project_id=$2 AND ($3::bigint IS NULL OR p.rera_project_phase_id=$3)`, [filing.site_id, filing.rera_project_id, filing.rera_project_phase_id]),
      db.query(`SELECT id FROM compliance_documents WHERE organization_id=$1 AND site_id=$2 AND deleted_at IS NULL AND ((entity_type='RERA_PROJECT' AND entity_id=$3) OR (entity_type='RERA_PHASE' AND entity_id=$4) OR (entity_type='RERA_FILING_PERIOD' AND entity_id=$5))`, [filing.organization_id, filing.site_id, filing.rera_project_id, filing.rera_project_phase_id || -1, filing.id]),
      db.query(`SELECT id,certified_progress_pct,certification_period_end FROM construction_certifications WHERE organization_id=$1 AND site_id=$2 AND rera_project_id=$3 AND rera_project_phase_id IS NOT DISTINCT FROM $4::bigint AND status IN ('CERTIFIED','APPROVED') AND certification_period_end<=$5 ORDER BY certification_period_end DESC,id DESC`, [filing.organization_id, filing.site_id, filing.rera_project_id, filing.rera_project_phase_id, filing.period_end]),
    ]);
    const readiness = evaluateFilingReadiness({ ruleset: ruleset.rows[0], requirements: requirements.rows, reconciliation: reconciliation.results });
    if (kind === 'READY' && !readiness.ready) throw businessError('The filing cannot be marked ready while blocking issues remain', 'FILING_NOT_READY', 409, readiness);
    const generatedValues = {
      filing: { type: filing.filing_type, periodStart: filing.period_start, periodEnd: filing.period_end, dueDate: filing.due_date },
      propertyAndSales: { activeBookingCount: projectSources.rowCount, bookedConsideration: projectSources.rows.reduce((sum, row) => sum + Number(row.final_consideration || 0), 0) },
      certifiedProgress: certifications.rows[0] || null,
      readiness,
    };
    const sourceReferences = {
      rulesetVersionId: filing.ruleset_version_id,
      requirementIds: requirements.rows.map((row) => row.id),
      reconciliationRunKey: reconciliation.runKey,
      reconciliationResultIds: reconciliation.results.map((row) => row.id),
      bookingIds: projectSources.rows.map((row) => row.id),
    };
    const { rows } = await db.query(
      `INSERT INTO rera_filing_snapshots (filing_period_id,organization_id,site_id,ruleset_version_id,snapshot_kind,generated_values,source_record_references,evidence_ids,certification_ids,reconciliation_run_key,blocking_issue_count,idempotency_key,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [filing.id, filing.organization_id, filing.site_id, filing.ruleset_version_id, kind, generatedValues, sourceReferences,
        evidence.rows.map((row) => row.id), certifications.rows.map((row) => row.id), reconciliation.runKey, readiness.blockingIssueCount,
        normalizeText(req.body.idempotency_key, 'idempotency_key', { max: 120 }), req.user.id],
    );
    if (kind === 'READY') await db.query(`UPDATE rera_filing_periods SET status='READY',requirements_resolution_status='RESOLVED',workflow_version=workflow_version+1,reviewed_by=$1,updated_at=NOW() WHERE id=$2`, [req.user.id, filing.id]);
    await writeComplianceAudit(db, req, { action: `RERA_FILING_${kind}_SNAPSHOT_CREATED`, entityType: 'RERA_FILING_SNAPSHOT', entityId: rows[0].id, siteId: filing.site_id, newValue: rows[0] });
    return rows[0];
  });
  res.status(201).json({ filing_snapshot: snapshot });
});

export const recordFilingSubmission = phaseHandler(async (req, res) => {
  await requireCapability(req, 'filing_preparation');
  const submission = await inTransaction(async (db) => {
    const filing = await filingContext(db, req, req.params.filingId, { lock: true });
    if (filing.status !== 'READY') throw businessError('Only a ready filing can be recorded as submitted', 'FILING_NOT_READY', 409);
    const readySnapshotId = positiveId(req.body.filing_snapshot_id, 'filing_snapshot_id');
    const ready = await db.query(`SELECT * FROM rera_filing_snapshots WHERE id=$1 AND filing_period_id=$2 AND snapshot_kind='READY'`, [readySnapshotId, filing.id]);
    if (!ready.rows[0] || ready.rows[0].blocking_issue_count > 0) throw businessError('A clean READY snapshot is required', 'READY_SNAPSHOT_REQUIRED', 409);
    const acknowledgementDocumentId = positiveId(req.body.acknowledgement_document_id, 'acknowledgement_document_id', { optional: true });
    if (acknowledgementDocumentId) {
      const doc = await db.query('SELECT id FROM compliance_documents WHERE id=$1 AND organization_id=$2 AND site_id=$3 AND deleted_at IS NULL', [acknowledgementDocumentId, filing.organization_id, filing.site_id]);
      if (!doc.rows[0]) throw businessError('Acknowledgement evidence is outside the filing Site', 'EVIDENCE_SCOPE_MISMATCH', 409);
    }
    const submittedSnapshot = await db.query(
      `INSERT INTO rera_filing_snapshots (filing_period_id,organization_id,site_id,ruleset_version_id,snapshot_kind,generated_values,source_record_references,evidence_ids,certification_ids,reconciliation_run_key,blocking_issue_count,idempotency_key,created_by)
       SELECT filing_period_id,organization_id,site_id,ruleset_version_id,'SUBMITTED',generated_values,source_record_references,evidence_ids,certification_ids,reconciliation_run_key,blocking_issue_count,$1,$2 FROM rera_filing_snapshots WHERE id=$3 RETURNING *`,
      [`SUBMITTED-${normalizeText(req.body.idempotency_key, 'idempotency_key', { max: 100 }) || Date.now()}`, req.user.id, readySnapshotId],
    );
    const { rows } = await db.query(
      `INSERT INTO rera_filing_submissions (filing_period_id,filing_snapshot_id,submission_reference,submission_date,portal_or_authority,acknowledgement_number,acknowledgement_document_id,remarks,idempotency_key,submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [filing.id, submittedSnapshot.rows[0].id, normalizeText(req.body.submission_reference, 'submission_reference', { required: true, max: 240 }),
        normalizeDate(req.body.submission_date, 'submission_date', { required: true }), normalizeText(req.body.portal_or_authority, 'portal_or_authority', { required: true, max: 300 }),
        normalizeText(req.body.acknowledgement_number, 'acknowledgement_number', { max: 240 }), acknowledgementDocumentId,
        normalizeText(req.body.remarks, 'remarks', { max: 8000 }), normalizeText(req.body.idempotency_key, 'idempotency_key', { max: 120 }), req.user.id],
    );
    await db.query(`UPDATE rera_filing_periods SET status='SUBMITTED',submitted_by=$1,submission_date=$2,acknowledgement_number=$3,workflow_version=workflow_version+1,updated_at=NOW() WHERE id=$4`, [req.user.id, rows[0].submission_date, rows[0].acknowledgement_number, filing.id]);
    await writeComplianceAudit(db, req, { action: 'RERA_FILING_SUBMISSION_RECORDED', entityType: 'RERA_FILING_SUBMISSION', entityId: rows[0].id, siteId: filing.site_id, newValue: { submission: rows[0], snapshot_id: submittedSnapshot.rows[0].id } });
    return rows[0];
  });
  res.status(201).json({ filing_submission: submission });
});

export const transitionFilingPeriod = phaseHandler(async (req, res) => {
  await requireCapability(req, 'filing_preparation');
  const filing = await inTransaction(async (db) => {
    const current = await filingContext(db, req, req.params.filingId, { lock: true });
    const status = assertTransition(FILING_TRANSITIONS, current.status, req.body.status);
    if (['READY', 'SUBMITTED'].includes(status)) throw businessError('Use the reviewed snapshot and submission actions for this transition', 'DEDICATED_ACTION_REQUIRED', 409);
    const { rows } = await db.query(`UPDATE rera_filing_periods SET status=$1,workflow_version=workflow_version+1,reviewed_by=$2,updated_at=NOW() WHERE id=$3 RETURNING *`, [status, req.user.id, current.id]);
    await writeComplianceAudit(db, req, { action: `RERA_FILING_${status}`, entityType: 'RERA_FILING_PERIOD', entityId: current.id, siteId: current.site_id, previousValue: current, newValue: rows[0], reason: req.body.reason });
    return rows[0];
  });
  res.json({ filing_period: filing });
});

const CONTROL_TABLES = Object.freeze({
  change: { table: 'rera_project_change_requests', entity: 'RERA_PROJECT_CHANGE', transitions: CHANGE_TRANSITIONS },
  extension: { table: 'rera_project_extensions', entity: 'RERA_PROJECT_EXTENSION', transitions: EXTENSION_TRANSITIONS },
});

export const listProjectControls = phaseHandler(async (req, res) => {
  await requireCapability(req, 'project_change_control');
  const [changes, extensions] = await Promise.all([
    pool.query(`SELECT c.*,rp.name AS project_name FROM rera_project_change_requests c JOIN rera_projects rp ON rp.id=c.rera_project_id WHERE c.site_id=$1 AND c.organization_id=$2 ORDER BY c.created_at DESC`, [siteIdFrom(req), req.user.organization_id]),
    pool.query(`SELECT e.*,rp.name AS project_name FROM rera_project_extensions e JOIN rera_projects rp ON rp.id=e.rera_project_id WHERE e.site_id=$1 AND e.organization_id=$2 ORDER BY e.created_at DESC`, [siteIdFrom(req), req.user.organization_id]),
  ]);
  res.json({ change_requests: changes.rows, extensions: extensions.rows });
});

export const createProjectControl = phaseHandler(async (req, res) => {
  await requireCapability(req, 'project_change_control');
  const kind = req.params.controlType;
  if (!CONTROL_TABLES[kind]) throw businessError('controlType must be change or extension', 'INVALID_CONTROL_TYPE', 400);
  const record = await inTransaction(async (db) => {
    const project = await projectContext(db, req, req.body.construction_project_id, { requireRera: true });
    let result;
    if (kind === 'change') {
      result = await db.query(`INSERT INTO rera_project_change_requests (organization_id,site_id,rera_project_id,rera_project_phase_id,ruleset_version_id,change_type,old_value,proposed_value,reason,impact_summary,affected_record_references,required_evidence_policy,required_approval_policy,ruleset_impact,requested_by,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`, [project.organization_id, project.site_id, project.rera_project_id, project.rera_project_phase_id, project.ruleset_version_id, normalizeText(req.body.change_type, 'change_type', { required: true, max: 60 }), jsonObject(req.body.old_value), jsonObject(req.body.proposed_value), normalizeText(req.body.reason, 'reason', { required: true, max: 8000 }), jsonObject(req.body.impact_summary), jsonArray(req.body.affected_record_references), jsonObject(req.body.required_evidence_policy), jsonObject(req.body.required_approval_policy), jsonObject(req.body.ruleset_impact), req.user.id, normalizeText(req.body.idempotency_key, 'idempotency_key', { max: 120 })]);
    } else {
      const currentDate = normalizeDate(req.body.current_completion_date, 'current_completion_date', { required: true });
      const proposedDate = normalizeDate(req.body.proposed_completion_date, 'proposed_completion_date', { required: true });
      result = await db.query(`INSERT INTO rera_project_extensions (organization_id,site_id,rera_project_id,rera_project_phase_id,ruleset_version_id,current_completion_date,proposed_completion_date,reason,delay_causes,progress_snapshot,cost_forecast_snapshot,requested_by,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [project.organization_id, project.site_id, project.rera_project_id, project.rera_project_phase_id, project.ruleset_version_id, currentDate, proposedDate, normalizeText(req.body.reason, 'reason', { required: true, max: 8000 }), jsonArray(req.body.delay_causes), jsonObject(req.body.progress_snapshot), jsonObject(req.body.cost_forecast_snapshot), req.user.id, normalizeText(req.body.idempotency_key, 'idempotency_key', { max: 120 })]);
    }
    await writeComplianceAudit(db, req, { action: `${CONTROL_TABLES[kind].entity}_CREATED`, entityType: CONTROL_TABLES[kind].entity, entityId: result.rows[0].id, siteId: project.site_id, newValue: result.rows[0] });
    return result.rows[0];
  });
  res.status(201).json({ [kind]: record });
});

export const transitionProjectControl = phaseHandler(async (req, res) => {
  await requireCapability(req, 'project_change_control');
  const config = CONTROL_TABLES[req.params.controlType];
  if (!config) throw businessError('controlType must be change or extension', 'INVALID_CONTROL_TYPE', 400);
  const record = await inTransaction(async (db) => {
    const id = positiveId(req.params.controlId, 'control_id');
    const { rows } = await db.query(`SELECT * FROM ${config.table} WHERE id=$1 AND site_id=$2 AND organization_id=$3 FOR UPDATE`, [id, siteIdFrom(req), req.user.organization_id]);
    const current = rows[0];
    if (!current) throw businessError('Control record not found', 'CONTROL_NOT_FOUND', 404);
    const status = assertTransition(config.transitions, current.status, req.body.status);
    if (status === 'APPROVED' && req.params.controlType === 'extension' && !positiveId(req.body.authority_decision_evidence_id, 'authority_decision_evidence_id', { optional: true })) throw businessError('Authority decision evidence is required before an extension can be approved', 'AUTHORITY_EVIDENCE_REQUIRED', 409);
    const { rows: changed } = await db.query(`UPDATE ${config.table} SET status=$1,reviewed_by=$2,updated_at=NOW(),submission_reference=COALESCE($3,submission_reference)${req.params.controlType === 'extension' ? ',authority_decision_evidence_id=COALESCE($4,authority_decision_evidence_id),authority_decision_date=COALESCE($5,authority_decision_date),authority_decision=COALESCE($6,authority_decision)' : ',reviewed_at=NOW()'} WHERE id=$7 RETURNING *`, req.params.controlType === 'extension' ? [status, req.user.id, normalizeText(req.body.submission_reference, 'submission_reference', { max: 240 }), positiveId(req.body.authority_decision_evidence_id, 'authority_decision_evidence_id', { optional: true }), normalizeDate(req.body.authority_decision_date, 'authority_decision_date'), normalizeText(req.body.authority_decision, 'authority_decision', { max: 40 }), id] : [status, req.user.id, normalizeText(req.body.submission_reference, 'submission_reference', { max: 240 }), null, null, null, id]);
    await writeComplianceAudit(db, req, { action: `${config.entity}_${status}`, entityType: config.entity, entityId: id, siteId: current.site_id, previousValue: current, newValue: changed[0], reason: req.body.reason });
    return changed[0];
  });
  res.json({ [req.params.controlType]: record });
});

export const createRisk = phaseHandler(async (req, res) => {
  const risk = await inTransaction(async (db) => {
    const project = await projectContext(db, req, req.body.construction_project_id);
    const workPackageId = positiveId(req.body.work_package_id, 'work_package_id', { optional: true });
    const { rows } = await db.query(`INSERT INTO construction_risks (organization_id,site_id,construction_project_id,work_package_id,risk_type,description,impact,severity,owner_user_id,due_date,source_references,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [project.organization_id, project.site_id, project.id, workPackageId, normalizeText(req.body.risk_type, 'risk_type', { required: true, max: 40 }), normalizeText(req.body.description, 'description', { required: true, max: 8000 }), normalizeText(req.body.impact, 'impact', { max: 8000 }), String(req.body.severity || 'MEDIUM').toUpperCase(), positiveId(req.body.owner_user_id, 'owner_user_id', { optional: true }), normalizeDate(req.body.due_date, 'due_date'), jsonArray(req.body.source_references), req.user.id]);
    await writeComplianceAudit(db, req, { action: 'CONSTRUCTION_RISK_CREATED', entityType: 'CONSTRUCTION_RISK', entityId: rows[0].id, siteId: project.site_id, newValue: rows[0] });
    return rows[0];
  });
  res.status(201).json({ risk });
});

export { deriveOperationalProgress };
