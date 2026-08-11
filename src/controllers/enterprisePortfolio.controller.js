import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { writePortalAudit } from '../services/portalAccess.service.js';

const id = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
const code = (value) => String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 80);
const text = (value, max = 300) => String(value || '').trim().slice(0, max);
const ENTITY_TYPES = new Set(['PROPRIETORSHIP', 'PARTNERSHIP', 'LLP', 'COMPANY', 'TRUST', 'SOCIETY', 'OTHER']);
const RELATIONSHIPS = new Set(['PROJECT_OWNER', 'PROMOTER', 'DEVELOPER', 'LANDOWNER', 'OPERATING_ENTITY', 'OTHER']);

export const listEnterpriseStructure = asyncHandler(async (req, res) => {
  const [groups, entities, assignments] = await Promise.all([
    pool.query(
      `SELECT dg.*,COALESCE(members.organizations,'[]') AS organizations
         FROM developer_groups dg
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object('organization_id',dgo.organization_id,
                    'name',o.name,'relationship_status',dgo.relationship_status)
                    ORDER BY o.name) AS organizations
             FROM developer_group_organizations dgo JOIN organizations o ON o.id=dgo.organization_id
            WHERE dgo.group_id=dg.id
         ) members ON TRUE
        WHERE dg.owner_organization_id=$1 OR EXISTS (
          SELECT 1 FROM developer_group_organizations self
           WHERE self.group_id=dg.id AND self.organization_id=$1
        ) ORDER BY dg.legal_name`,
      [req.user.organization_id],
    ),
    pool.query(
      `SELECT le.*,dg.legal_name AS group_name FROM legal_entities le
       LEFT JOIN developer_groups dg ON dg.id=le.developer_group_id
       WHERE le.organization_id=$1 ORDER BY le.legal_name`,
      [req.user.organization_id],
    ),
    pool.query(
      `SELECT a.*,s.name AS site_name,le.legal_name AS entity_name
         FROM site_legal_entity_assignments a JOIN sites s ON s.id=a.site_id
         JOIN legal_entities le ON le.id=a.legal_entity_id
        WHERE a.organization_id=$1 ORDER BY s.name,a.relationship_type,a.effective_from DESC`,
      [req.user.organization_id],
    ),
  ]);
  res.json({ groups: groups.rows, legal_entities: entities.rows, site_assignments: assignments.rows });
});

export const createDeveloperGroup = asyncHandler(async (req, res) => {
  const groupCode = code(req.body.group_code);
  const legalName = text(req.body.legal_name);
  if (!groupCode || !legalName) return res.status(400).json({ message: 'group_code and legal_name are required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO developer_groups (owner_organization_id,group_code,legal_name,status,created_by)
       VALUES ($1,$2,$3,'ACTIVE',$4) RETURNING *`,
      [req.user.organization_id, groupCode, legalName, req.user.id],
    );
    await client.query(
      `INSERT INTO developer_group_organizations
        (group_id,organization_id,relationship_status,invited_by,accepted_by,accepted_at)
       VALUES ($1,$2,'ACTIVE',$3,$3,NOW())`,
      [rows[0].id, req.user.organization_id, req.user.id],
    );
    await writePortalAudit({ organizationId: req.user.organization_id, userId: req.user.id, action: 'DEVELOPER_GROUP_CREATED', entityType: 'DEVELOPER_GROUP', entityId: rows[0].id, newValue: rows[0], ipAddress: req.ip }, client);
    await client.query('COMMIT');
    res.status(201).json({ group: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ message: 'That group code already exists' });
    throw error;
  } finally {
    client.release();
  }
});

export const inviteOrganizationToGroup = asyncHandler(async (req, res) => {
  const groupId = id(req.params.groupId);
  const organizationId = id(req.body.organization_id);
  if (!groupId || !organizationId || organizationId === req.user.organization_id) return res.status(400).json({ message: 'A different valid organization_id is required' });
  const { rows } = await pool.query(
    `INSERT INTO developer_group_organizations (group_id,organization_id,relationship_status,invited_by)
     SELECT dg.id,$2,'PENDING',$3 FROM developer_groups dg JOIN organizations o ON o.id=$2 AND o.is_active=TRUE
      WHERE dg.id=$1 AND dg.owner_organization_id=$4 AND dg.status='ACTIVE'
     ON CONFLICT (group_id,organization_id) DO NOTHING
     RETURNING group_id,organization_id,relationship_status,created_at`,
    [groupId, organizationId, req.user.id, req.user.organization_id],
  );
  if (!rows[0]) return res.status(404).json({ message: 'Group/organization not found or invitation already exists' });
  res.status(201).json({ group_organization: rows[0] });
});

export const acceptGroupInvitation = asyncHandler(async (req, res) => {
  const groupId = id(req.params.groupId);
  const { rows } = await pool.query(
    `UPDATE developer_group_organizations SET relationship_status='ACTIVE',accepted_by=$1,accepted_at=NOW()
      WHERE group_id=$2 AND organization_id=$3 AND relationship_status='PENDING'
      RETURNING group_id,organization_id,relationship_status,accepted_at`,
    [req.user.id, groupId, req.user.organization_id],
  );
  if (!rows[0]) return res.status(404).json({ message: 'Pending group invitation not found' });
  res.json({ group_organization: rows[0] });
});

export const createLegalEntity = asyncHandler(async (req, res) => {
  const entityCode = code(req.body.entity_code);
  const legalName = text(req.body.legal_name);
  const entityType = String(req.body.entity_type || '').toUpperCase();
  const groupId = req.body.developer_group_id ? id(req.body.developer_group_id) : null;
  if (!entityCode || !legalName || !ENTITY_TYPES.has(entityType)) return res.status(400).json({ message: 'entity_code, legal_name and a valid entity_type are required' });
  if (groupId) {
    const group = await pool.query('SELECT 1 FROM developer_groups WHERE id=$1 AND owner_organization_id=$2 AND status=\'ACTIVE\'', [groupId, req.user.organization_id]);
    if (!group.rows[0]) return res.status(400).json({ message: 'Developer group is outside your organization' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO legal_entities
        (organization_id,developer_group_id,entity_code,legal_name,entity_type,pan,gstin,cin_or_llpin,registered_address,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE',$10) RETURNING *`,
      [req.user.organization_id, groupId, entityCode, legalName, entityType,
        text(req.body.pan, 20) || null, text(req.body.gstin, 20) || null,
        text(req.body.cin_or_llpin, 40) || null,
        req.body.registered_address && typeof req.body.registered_address === 'object' && !Array.isArray(req.body.registered_address) ? req.body.registered_address : {}, req.user.id],
    );
    await writePortalAudit({ organizationId: req.user.organization_id, userId: req.user.id, action: 'LEGAL_ENTITY_CREATED', entityType: 'LEGAL_ENTITY', entityId: rows[0].id, newValue: rows[0], ipAddress: req.ip });
    res.status(201).json({ legal_entity: rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ message: 'That legal entity code already exists' });
    throw error;
  }
});

export const assignSiteLegalEntity = asyncHandler(async (req, res) => {
  const siteId = id(req.body.site_id);
  const legalEntityId = id(req.body.legal_entity_id);
  const relationship = String(req.body.relationship_type || 'PROJECT_OWNER').toUpperCase();
  const effectiveFrom = String(req.body.effective_from || new Date().toISOString().slice(0, 10));
  if (!siteId || !legalEntityId || !RELATIONSHIPS.has(relationship) || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) return res.status(400).json({ message: 'A valid Site, legal entity, relationship and effective date are required' });
  const scoped = await pool.query(
    `SELECT 1 FROM sites s JOIN legal_entities le ON le.organization_id=s.organization_id
      WHERE s.id=$1 AND le.id=$2 AND s.organization_id=$3`,
    [siteId, legalEntityId, req.user.organization_id],
  );
  if (!scoped.rows[0]) return res.status(404).json({ message: 'Site or legal entity not found in your organization' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE site_legal_entity_assignments SET effective_to=($1::date-INTERVAL '1 day')::date
        WHERE site_id=$2 AND relationship_type=$3 AND effective_to IS NULL AND effective_from<$1`,
      [effectiveFrom, siteId, relationship],
    );
    const { rows } = await client.query(
      `INSERT INTO site_legal_entity_assignments
        (organization_id,site_id,legal_entity_id,relationship_type,effective_from,basis_reference,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.organization_id, siteId, legalEntityId, relationship, effectiveFrom,
        text(req.body.basis_reference, 2000) || null, req.user.id],
    );
    await writePortalAudit({ organizationId: req.user.organization_id, siteId, userId: req.user.id, action: 'SITE_LEGAL_ENTITY_ASSIGNED', entityType: 'SITE_LEGAL_ENTITY_ASSIGNMENT', entityId: rows[0].id, newValue: rows[0], ipAddress: req.ip }, client);
    await client.query('COMMIT');
    res.status(201).json({ assignment: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ message: 'That relationship already has an active legal entity' });
    throw error;
  } finally {
    client.release();
  }
});

export const getEnterprisePortfolio = asyncHandler(async (req, res) => {
  const groupId = req.query.group_id ? id(req.query.group_id) : null;
  const organizationIds = groupId
    ? (await pool.query(
      `SELECT dgo.organization_id FROM developer_group_organizations dgo
       JOIN developer_groups dg ON dg.id=dgo.group_id
       WHERE dgo.group_id=$1 AND dgo.relationship_status='ACTIVE'
         AND (dg.owner_organization_id=$2 OR EXISTS (
           SELECT 1 FROM developer_group_organizations self
            WHERE self.group_id=dg.id AND self.organization_id=$2 AND self.relationship_status='ACTIVE'
         ))`,
      [groupId, req.user.organization_id],
    )).rows.map((row) => row.organization_id)
    : [req.user.organization_id];
  if (!organizationIds.length) return res.status(404).json({ message: 'Active portfolio group not found' });

  const [projects, entities] = await Promise.all([
    pool.query(
      `SELECT rp.id,rp.organization_id,rp.site_id,rp.name,rp.project_code,rp.regulatory_status,
              rp.registration_number,rp.proposed_completion_date,rp.authority_name,s.name AS site_name,
              COALESCE(phase.phase_count,0)::int AS phase_count,
              COALESCE(inventory.inventory_count,0)::int AS inventory_count,
              COALESCE(inventory.available_count,0)::int AS available_inventory,
              COALESCE(booking.booking_count,0)::int AS booking_count,
              COALESCE(booking.booked_value,0) AS booked_value,
              COALESCE(collection.payment_records,0)::int AS payment_records,
              COALESCE(collection.collections,0) AS collections,
              GREATEST(COALESCE(booking.booked_value,0)-COALESCE(collection.collections,0)+COALESCE(refund.refunds,0),0) AS receivable,
              COALESCE(construction.project_count,0)::int AS construction_project_count,
              COALESCE(construction.operational_progress,0) AS construction_progress,
              certification.certified_progress,
              COALESCE(certification.certification_count,0)::int AS certification_count,
              COALESCE(actual.allocated_actual,0)+COALESCE(material.material_actual,0) AS actual_cost,
              COALESCE(commitment.committed_cost,0) AS committed_cost,
              COALESCE(forecast.cost_to_complete,0) AS cost_to_complete,
              COALESCE(actual.allocated_actual,0)+COALESCE(material.material_actual,0)+COALESCE(forecast.cost_to_complete,0) AS estimate_at_completion,
              COALESCE(filing.issue_count,0)::int AS filing_issue_count,
              COALESCE(approval.expiring_count,0)::int AS approval_expiring_count,
              COALESCE(lifecycle.registry_backlog,0)::int AS registry_backlog,
              COALESCE(lifecycle.possession_backlog,0)::int AS possession_backlog,
              ARRAY_REMOVE(ARRAY[
                CASE WHEN COALESCE(filing.issue_count,0)>0 THEN filing.issue_count||' filing period(s) need attention' END,
                CASE WHEN COALESCE(approval.expiring_count,0)>0 THEN approval.expiring_count||' approval(s) expire within 30 days' END,
                CASE WHEN COALESCE(lifecycle.registry_backlog,0)>0 THEN lifecycle.registry_backlog||' registry record(s) remain open' END,
                CASE WHEN COALESCE(lifecycle.possession_backlog,0)>0 THEN lifecycle.possession_backlog||' possession record(s) remain open' END,
                CASE WHEN COALESCE(forecast.cost_to_complete,0)>0 AND COALESCE(construction.operational_progress,0)>=100 THEN 'Cost remains forecast after operational completion' END
              ],NULL)::text[] AS health_reasons,
              CASE
                WHEN COALESCE(filing.issue_count,0)>0 THEN 'Review filing readiness'
                WHEN COALESCE(approval.expiring_count,0)>0 THEN 'Renew expiring approval'
                WHEN COALESCE(lifecycle.registry_backlog,0)>0 THEN 'Advance registry backlog'
                WHEN COALESCE(lifecycle.possession_backlog,0)>0 THEN 'Advance possession backlog'
                ELSE 'No critical source exception'
              END AS next_action
         FROM rera_projects rp JOIN sites s ON s.id=rp.site_id AND s.organization_id=rp.organization_id
         LEFT JOIN LATERAL (SELECT COUNT(*) AS phase_count FROM rera_project_phases x WHERE x.rera_project_id=rp.id AND x.deleted_at IS NULL) phase ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS inventory_count,COUNT(*) FILTER (WHERE UPPER(COALESCE(p.status,'AVAILABLE'))='AVAILABLE') AS available_count
             FROM plots p WHERE p.site_id=rp.site_id AND p.rera_project_id=rp.id
         ) inventory ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS booking_count,COALESCE(SUM(b.final_consideration),0) AS booked_value
             FROM bookings b WHERE b.organization_id=rp.organization_id AND b.site_id=rp.site_id AND b.rera_project_id=rp.id
              AND COALESCE(b.lifecycle_status,'DRAFT') NOT IN ('CANCELLED','TRANSFERRED','CLOSED')
         ) booking ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS payment_records,COALESCE(SUM(pp.amount),0) AS collections
             FROM plot_payments pp JOIN bookings b ON b.id=pp.booking_id AND b.site_id=pp.site_id
            WHERE b.organization_id=rp.organization_id AND b.site_id=rp.site_id AND b.rera_project_id=rp.id
              AND COALESCE(b.lifecycle_status,'DRAFT') NOT IN ('CANCELLED','TRANSFERRED','CLOSED')
              AND LOWER(COALESCE(pp.status,'approved'))='approved'
              AND UPPER(COALESCE(pp.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
         ) collection ON TRUE
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(br.amount),0) AS refunds FROM booking_refunds br
           JOIN bookings b ON b.id=br.booking_id WHERE b.organization_id=rp.organization_id AND b.site_id=rp.site_id
             AND b.rera_project_id=rp.id AND br.status='POSTED'
         ) refund ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS project_count,AVG(cp.progress_pct) AS operational_progress
             FROM construction_projects cp WHERE cp.organization_id=rp.organization_id AND cp.site_id=rp.site_id AND cp.rera_project_id=rp.id
         ) construction ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(latest.certified_progress_pct) AS certification_count,AVG(latest.certified_progress_pct) AS certified_progress
             FROM construction_projects cp
             LEFT JOIN LATERAL (
               SELECT c.certified_progress_pct FROM construction_certifications c
                WHERE c.construction_project_id=cp.id AND c.status IN ('CERTIFIED','APPROVED')
                ORDER BY c.certification_period_end DESC,c.id DESC LIMIT 1
             ) latest ON TRUE
            WHERE cp.organization_id=rp.organization_id AND cp.site_id=rp.site_id AND cp.rera_project_id=rp.id
         ) certification ON TRUE
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(a.amount),0) AS allocated_actual FROM project_transaction_allocations a
            WHERE a.organization_id=rp.organization_id AND a.site_id=rp.site_id AND a.rera_project_id=rp.id
         ) actual ON TRUE
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(im.qty*im.rate),0) AS material_actual
             FROM construction_projects cp JOIN inventory_movements im ON im.project_id=cp.id AND im.movement_type='CONSUMPTION'
            WHERE cp.organization_id=rp.organization_id AND cp.site_id=rp.site_id AND cp.rera_project_id=rp.id
         ) material ON TRUE
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(COALESCE(link.allocation_amount,vc.contract_amount)),0) AS committed_cost
             FROM construction_projects cp JOIN construction_work_package_commitments link ON link.construction_project_id=cp.id
             JOIN vendor_commitments vc ON vc.id=link.vendor_commitment_id AND vc.status<>'cancelled'
            WHERE cp.organization_id=rp.organization_id AND cp.site_id=rp.site_id AND cp.rera_project_id=rp.id
         ) commitment ON TRUE
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(latest.estimated_additional_cost),0) AS cost_to_complete
             FROM construction_projects cp
             LEFT JOIN LATERAL (
               SELECT cf.estimated_additional_cost FROM construction_cost_forecasts cf
                WHERE cf.construction_project_id=cp.id AND cf.work_package_id IS NULL AND cf.approval_status='APPROVED'
                ORDER BY cf.as_of_date DESC,cf.id DESC LIMIT 1
             ) latest ON TRUE
            WHERE cp.organization_id=rp.organization_id AND cp.site_id=rp.site_id AND cp.rera_project_id=rp.id
         ) forecast ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(DISTINCT f.id) FILTER (WHERE f.status NOT IN ('ACCEPTED','SUPERSEDED') AND (
             EXISTS (SELECT 1 FROM rera_filing_requirements fr WHERE fr.filing_period_id=f.id AND fr.is_blocking=TRUE AND fr.status NOT IN ('COMPLETE','NOT_APPLICABLE'))
             OR EXISTS (SELECT 1 FROM rera_filing_reconciliation_results rr WHERE rr.filing_period_id=f.id AND rr.status IN ('ERROR','REVIEW_REQUIRED'))
             OR f.status IN ('DATA_RECONCILIATION','EVIDENCE_PENDING','RESUBMISSION_REQUIRED','REJECTED')
           )) AS issue_count FROM rera_filing_periods f WHERE f.organization_id=rp.organization_id AND f.site_id=rp.site_id AND f.rera_project_id=rp.id
         ) filing ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS expiring_count FROM compliance_licences cl
            WHERE cl.organization_id=rp.organization_id AND cl.site_id=rp.site_id AND cl.rera_project_id=rp.id AND cl.deleted_at IS NULL
              AND cl.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE+30
         ) approval ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE pr.lifecycle_status NOT IN ('COMPLETE','CANCELLED')) AS registry_backlog,
                  COUNT(*) FILTER (WHERE pos.id IS NOT NULL AND pos.status<>'POSSESSED') AS possession_backlog
             FROM plot_registries pr LEFT JOIN plot_possessions pos ON pos.registry_id=pr.id
            WHERE pr.site_id=rp.site_id AND pr.rera_project_id=rp.id
         ) lifecycle ON TRUE
        WHERE rp.organization_id=ANY($1::int[]) AND rp.deleted_at IS NULL
        ORDER BY s.name,rp.name`,
      [organizationIds],
    ),
    pool.query(
      `SELECT le.id,le.organization_id,le.legal_name,le.entity_code,le.entity_type,
              COUNT(DISTINCT a.site_id)::int AS site_count,
              COALESCE(jsonb_agg(DISTINCT jsonb_build_object('assignment_id',a.id,'site_id',a.site_id,
                'relationship_type',a.relationship_type)) FILTER (WHERE a.id IS NOT NULL),'[]') AS source_assignments
         FROM legal_entities le LEFT JOIN site_legal_entity_assignments a
           ON a.legal_entity_id=le.id AND a.effective_to IS NULL
        WHERE le.organization_id=ANY($1::int[]) AND le.status='ACTIVE'
        GROUP BY le.id ORDER BY le.legal_name`,
      [organizationIds],
    ),
  ]);
  const numeric = (value) => Number(value || 0);
  const summary = projects.rows.reduce((total, project) => ({
    ...total,
    phases: total.phases + numeric(project.phase_count),
    bookings: total.bookings + numeric(project.booking_count),
    booked_value: total.booked_value + numeric(project.booked_value),
    payment_records: total.payment_records + numeric(project.payment_records),
    collections: total.collections + numeric(project.collections),
    receivable: total.receivable + numeric(project.receivable),
    committed_cost: total.committed_cost + numeric(project.committed_cost),
    actual_cost: total.actual_cost + numeric(project.actual_cost),
    estimate_at_completion: total.estimate_at_completion + numeric(project.estimate_at_completion),
    certifications: total.certifications + numeric(project.certification_count),
    filing_issues: total.filing_issues + numeric(project.filing_issue_count),
    registry_backlog: total.registry_backlog + numeric(project.registry_backlog),
    possession_backlog: total.possession_backlog + numeric(project.possession_backlog),
  }), {
    sites: new Set(projects.rows.map((project) => project.site_id)).size,
    projects: projects.rowCount, phases: 0, bookings: 0, booked_value: 0, payment_records: 0,
    collections: 0, receivable: 0, committed_cost: 0, actual_cost: 0,
    estimate_at_completion: 0, certifications: 0, filing_issues: 0,
    registry_backlog: 0, possession_backlog: 0,
  });
  const risks = projects.rows.filter((project) => project.health_reasons?.length).map((project) => ({
    project_id: project.id, project_name: project.name, site_id: project.site_id,
    site_name: project.site_name, reasons: project.health_reasons, next_action: project.next_action,
    severity: project.filing_issue_count > 0 || project.approval_expiring_count > 0 ? 'HIGH' : 'MEDIUM',
  }));
  res.json({
    as_of: new Date().toISOString(),
    organization_ids: organizationIds,
    summary,
    projects: projects.rows,
    risks,
    legal_entities: entities.rows,
    lineage: {
      booked_value: 'bookings.final_consideration (active lifecycle records)',
      collections: 'plot_payments.amount (approved, non-bounced records)',
      receivable: 'active booking consideration - approved non-bounced receipts + posted refunds',
      actual_cost: 'project_transaction_allocations.amount + consumed inventory quantity × rate',
      committed_cost: 'construction_work_package_commitments linked to canonical vendor commitments',
      estimate_at_completion: 'actual cost + latest approved project-level construction cost forecast',
      certified_progress: 'construction_certifications.certified_progress_pct (CERTIFIED/APPROVED)',
      filing_issues: 'rera_filing_periods with blocking requirements/reconciliation results',
      registry_possession: 'plot_registries and plot_possessions current lifecycle rows',
      legal_entity_sites: 'site_legal_entity_assignments (current effective links)',
    },
    drilldown: {
      project: '/rera?project_id=:project_id',
      collections: '/project-finance?project_id=:project_id',
      construction: '/construction/governance?project_id=:construction_project_id',
      filings: '/construction/governance?tab=filings&project_id=:construction_project_id',
    },
  });
});
