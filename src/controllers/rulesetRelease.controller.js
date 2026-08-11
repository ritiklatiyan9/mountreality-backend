import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { writePortalAudit } from '../services/portalAccess.service.js';

const id = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const STATUS = Object.freeze({
  DRAFT: ['SOURCE_REVIEW'],
  SOURCE_REVIEW: ['LEGAL_REVIEW', 'REJECTED'],
  LEGAL_REVIEW: ['IMPACT_REVIEW', 'REJECTED'],
  IMPACT_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: ['RELEASED'],
  RELEASED: ['RETIRED'],
  REJECTED: ['DRAFT'],
  RETIRED: [],
});

async function tenantRulesetVersion(versionId, organizationId, db = pool, lock = false) {
  const { rows } = await db.query(
    `SELECT rv.*,r.organization_id,r.code AS ruleset_code,r.name AS ruleset_name,r.source_review_status AS ruleset_source_review_status
       FROM rera_ruleset_versions rv JOIN rera_rulesets r ON r.id=rv.ruleset_id
      WHERE rv.id=$1 AND r.organization_id=$2 AND rv.deleted_at IS NULL AND r.deleted_at IS NULL
      ${lock ? 'FOR UPDATE OF rv,r' : ''}`,
    [versionId, organizationId],
  );
  return rows[0] || null;
}

export const listRulesetReleaseWorkflows = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT rw.*,rv.version,rv.version_label,rv.lifecycle_status,rv.source_review_status,
            r.code AS ruleset_code,r.name AS ruleset_name,
            impact.impacted_site_count,impact.impacted_project_count,impact.impacted_profile_count,
            impact.computed_at AS impact_computed_at
       FROM rera_ruleset_release_workflows rw
       JOIN rera_ruleset_versions rv ON rv.id=rw.ruleset_version_id
       JOIN rera_rulesets r ON r.id=rv.ruleset_id
       LEFT JOIN LATERAL (
         SELECT * FROM rera_ruleset_impact_snapshots i WHERE i.workflow_id=rw.id
          ORDER BY i.computed_at DESC,i.id DESC LIMIT 1
       ) impact ON TRUE
      WHERE r.organization_id=$1 AND r.deleted_at IS NULL AND rv.deleted_at IS NULL
      ORDER BY rw.updated_at DESC,rw.id DESC`,
    [req.user.organization_id],
  );
  res.json({ workflows: rows });
});

export const createRulesetReleaseWorkflow = asyncHandler(async (req, res) => {
  const versionId = id(req.body.ruleset_version_id);
  if (!versionId) return res.status(400).json({ message: 'A valid ruleset_version_id is required' });
  const version = await tenantRulesetVersion(versionId, req.user.organization_id);
  if (!version) return res.status(404).json({ message: 'Tenant ruleset version not found' });
  if (version.lifecycle_status !== 'DRAFT') return res.status(409).json({ message: 'Only a draft ruleset version can enter release review' });
  const sourceRecord = object(req.body.source_record);
  if (Buffer.byteLength(JSON.stringify(sourceRecord), 'utf8') > 64 * 1024) return res.status(413).json({ message: 'Source record is too large' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO rera_ruleset_release_workflows
        (ruleset_version_id,source_record,review_notes,created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [versionId, sourceRecord, String(req.body.review_notes || '').trim() || null, req.user.id],
    );
    await writePortalAudit({ organizationId: req.user.organization_id, userId: req.user.id, action: 'RULESET_RELEASE_WORKFLOW_CREATED', entityType: 'RERA_RULESET_RELEASE', entityId: rows[0].id, newValue: { ruleset_version_id: versionId }, ipAddress: req.ip });
    res.status(201).json({ workflow: rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ message: 'This ruleset version already has a release workflow' });
    throw error;
  }
});

async function computeImpact(workflow, version, userId, organizationId, db) {
  const { rows } = await db.query(
    `SELECT
       COUNT(DISTINCT profile.site_id)::int AS impacted_site_count,
       COUNT(DISTINCT project.id)::int AS impacted_project_count,
       COUNT(DISTINCT profile.id)::int AS impacted_profile_count,
       COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
         'site_id',profile.site_id,'profile_revision_id',profile.id,
         'current_ruleset_version_id',profile.ruleset_version_id
       )) FILTER (WHERE profile.id IS NOT NULL),'[]') AS profiles
       FROM rera_ruleset_versions sibling
       LEFT JOIN site_operating_profile_revisions profile
         ON profile.ruleset_version_id=sibling.id AND profile.organization_id=$2
        AND profile.lifecycle_status='PUBLISHED' AND profile.deleted_at IS NULL
       LEFT JOIN rera_projects project
         ON project.operating_profile_revision_id=profile.id AND project.organization_id=$2
        AND project.deleted_at IS NULL
      WHERE sibling.ruleset_id=$1 AND sibling.id<>$3 AND sibling.deleted_at IS NULL`,
    [version.ruleset_id, organizationId, version.id],
  );
  const impact = rows[0];
  const inserted = await db.query(
    `INSERT INTO rera_ruleset_impact_snapshots
      (workflow_id,organization_id,impacted_site_count,impacted_project_count,
       impacted_profile_count,impact_details,computed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [workflow.id, organizationId, impact.impacted_site_count, impact.impacted_project_count,
      impact.impacted_profile_count, { profiles: impact.profiles, retroactive_rewrite: false }, userId],
  );
  return inserted.rows[0];
}

export const transitionRulesetReleaseWorkflow = asyncHandler(async (req, res) => {
  const workflowId = id(req.params.workflowId);
  const nextStatus = String(req.body.status || '').trim().toUpperCase();
  if (!workflowId) return res.status(400).json({ message: 'Invalid workflow ID' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT rw.* FROM rera_ruleset_release_workflows rw
       JOIN rera_ruleset_versions rv ON rv.id=rw.ruleset_version_id
       JOIN rera_rulesets r ON r.id=rv.ruleset_id AND r.organization_id=$2
       WHERE rw.id=$1 FOR UPDATE OF rw`,
      [workflowId, req.user.organization_id],
    );
    const workflow = rows[0];
    if (!workflow) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Ruleset release workflow not found' });
    }
    if (!STATUS[workflow.workflow_status]?.includes(nextStatus)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'INVALID_TRANSITION', message: `Cannot move ${workflow.workflow_status} to ${nextStatus}`, allowed: STATUS[workflow.workflow_status] || [] });
    }
    const version = await tenantRulesetVersion(workflow.ruleset_version_id, req.user.organization_id, client, true);
    if (!version) throw new Error('Ruleset version disappeared during release review');
    const notes = String(req.body.review_notes || '').trim() || null;
    const rejection = String(req.body.rejection_reason || '').trim() || null;
    if (nextStatus === 'REJECTED' && !rejection) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'A rejection reason is required' });
    }
    if (nextStatus === 'SOURCE_REVIEW') {
      const sourceReady = version.source_review_status === 'REVIEWED'
        && Boolean(String(version.source_reference || '').trim())
        && Boolean(version.reviewed_at);
      const configurationReady = !version.contains_legal_requirements
        && version.source_review_status === 'NOT_APPLICABLE';
      if (!sourceReady && !configurationReady) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'SOURCE_REVIEW_REQUIRED',
          message: 'Review the source and reference on the version before entering source review',
        });
      }
    }
    if (nextStatus === 'LEGAL_REVIEW' && version.contains_legal_requirements) {
      const unresolved = await client.query(
        `SELECT COUNT(*)::int AS count FROM rera_ruleset_requirements
          WHERE ruleset_version_id=$1 AND is_active=TRUE AND is_legal_requirement=TRUE
            AND (source_review_status<>'REVIEWED' OR NULLIF(BTRIM(source_reference),'') IS NULL)`,
        [version.id],
      );
      if (unresolved.rows[0].count > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ code: 'LEGAL_SOURCE_GAPS', message: 'Every legal requirement must have a reviewed source before legal review' });
      }
    }
    let impact = null;
    if (nextStatus === 'IMPACT_REVIEW') impact = await computeImpact(workflow, version, req.user.id, req.user.organization_id, client);

    const fields = {
      SOURCE_REVIEW: `source_reviewed_by=$3,source_reviewed_at=NOW()`,
      LEGAL_REVIEW: `legal_reviewed_by=$3,legal_reviewed_at=NOW()`,
      APPROVED: `approved_by=$3,approved_at=NOW()`,
      RELEASED: `released_by=$3,released_at=NOW()`,
    }[nextStatus] || '';
    if (nextStatus === 'RELEASED') {
      // Existing projects/profiles retain their pinned version. Only future
      // profile revisions can elect the new published version.
      await client.query(
        `UPDATE rera_ruleset_versions SET lifecycle_status='SUPERSEDED',
          effective_to=CASE WHEN effective_from IS NOT NULL THEN COALESCE(effective_to,CURRENT_DATE) ELSE effective_to END
          WHERE ruleset_id=$1 AND lifecycle_status='PUBLISHED' AND id<>$2 AND deleted_at IS NULL`,
        [version.ruleset_id, version.id],
      );
      await client.query(
        `UPDATE rera_ruleset_versions SET lifecycle_status='PUBLISHED',published_by=$1,published_at=NOW(),
          effective_from=COALESCE(effective_from,CURRENT_DATE) WHERE id=$2`,
        [req.user.id, version.id],
      );
    }
    if (nextStatus === 'RETIRED') {
      await client.query(
        `UPDATE rera_ruleset_versions SET lifecycle_status='WITHDRAWN',
          effective_to=CASE WHEN effective_from IS NOT NULL THEN COALESCE(effective_to,CURRENT_DATE) ELSE effective_to END
          WHERE id=$1`,
        [version.id],
      );
    }
    const setExtra = fields ? `,${fields}` : '';
    const changed = await client.query(
      `UPDATE rera_ruleset_release_workflows SET workflow_status=$1,
        review_notes=COALESCE($2,review_notes),rejection_reason=CASE WHEN $1='REJECTED' THEN $4 ELSE rejection_reason END,
        updated_at=NOW() ${setExtra} WHERE id=$5 RETURNING *`,
      [nextStatus, notes, req.user.id, rejection, workflow.id],
    );
    await writePortalAudit({ organizationId: req.user.organization_id, userId: req.user.id, action: `RULESET_RELEASE_${nextStatus}`, entityType: 'RERA_RULESET_RELEASE', entityId: workflow.id, previousValue: { status: workflow.workflow_status }, newValue: { status: nextStatus, impact_snapshot_id: impact?.id || null }, reason: notes || rejection, ipAddress: req.ip }, client);
    await client.query('COMMIT');
    res.json({ workflow: changed.rows[0], impact_snapshot: impact, retroactive_rewrite: false });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});
