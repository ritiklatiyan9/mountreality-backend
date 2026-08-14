import pool from '../config/db.js';

export const RERA_REGISTRY_OPERATING_MODELS = Object.freeze([
  'RERA_PROJECT_PROMOTER',
  'RERA_ONGOING_PROJECT_REGULARISATION',
]);

const RERA_MODEL_SET = new Set(RERA_REGISTRY_OPERATING_MODELS);

export const isReraRegistryOperatingModel = (value) => (
  RERA_MODEL_SET.has(String(value || '').trim().toUpperCase())
);

export const isRegistryProjectContextComplete = ({
  projectStructure,
  projectId,
  phaseId,
} = {}) => Boolean(
  projectId
  && (
    String(projectStructure || '').trim().toUpperCase() !== 'PHASE_WISE'
    || phaseId
  )
);

/**
 * Resolve the active registry operating mode from the published Site profile.
 *
 * This intentionally does not infer RERA from a postal address, project name,
 * or an unfinished profile. Legacy Sites and non-RERA profiles therefore keep
 * their existing registry behavior. The query follows the existing
 * (organization_id, site_id, lifecycle_status, revision_number) index.
 */
export async function resolveRegistryOperatingPolicy({
  siteId,
  organizationId = null,
  db = pool,
} = {}) {
  const resolvedSiteId = Number.parseInt(siteId, 10);
  const resolvedOrganizationId = organizationId == null
    ? null
    : Number.parseInt(organizationId, 10);
  if (!Number.isSafeInteger(resolvedSiteId) || resolvedSiteId <= 0) {
    const error = new Error('A valid siteId is required');
    error.statusCode = 400;
    error.code = 'INVALID_SITE_ID';
    throw error;
  }
  if (organizationId != null && (!Number.isSafeInteger(resolvedOrganizationId) || resolvedOrganizationId <= 0)) {
    const error = new Error('A valid organizationId is required');
    error.statusCode = 400;
    error.code = 'INVALID_ORGANIZATION_ID';
    throw error;
  }

  const { rows } = await db.query(
    `SELECT s.organization_id,
            profile.id AS profile_revision_id,
            profile.revision_number,
            profile.operating_model,
            profile.project_structure
       FROM sites s
       LEFT JOIN LATERAL (
         SELECT p.id,p.revision_number,p.operating_model,p.project_structure
           FROM site_operating_profile_revisions p
          WHERE p.organization_id=s.organization_id
            AND p.site_id=s.id
            AND p.lifecycle_status='PUBLISHED'
            AND p.effective_to IS NULL
            AND p.deleted_at IS NULL
          ORDER BY p.revision_number DESC,p.id DESC
          LIMIT 1
       ) profile ON TRUE
      WHERE s.id=$1
        AND ($2::integer IS NULL OR s.organization_id=$2)
      LIMIT 1`,
    [resolvedSiteId, resolvedOrganizationId],
  );
  const row = rows[0];
  if (!row) {
    const error = new Error('Site not found or outside the organization');
    error.statusCode = 404;
    error.code = 'SITE_NOT_FOUND';
    throw error;
  }

  return {
    organization_id: Number(row.organization_id),
    profile_revision_id: row.profile_revision_id ? Number(row.profile_revision_id) : null,
    revision_number: row.revision_number ? Number(row.revision_number) : null,
    operating_model: row.operating_model || null,
    project_structure: row.project_structure
      ? String(row.project_structure).trim().toUpperCase()
      : null,
    rera_enforced: isReraRegistryOperatingModel(row.operating_model),
  };
}
