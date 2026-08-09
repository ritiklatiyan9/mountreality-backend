import pool from '../config/db.js';
import { isOrgAdmin, parsePositiveId } from './complianceAccess.js';

const deny = (res, status, message) => {
  res.status(status).json({ message });
  return null;
};

/** Resolve an explicitly selected Site inside the caller's tenant boundary. */
export async function getReraSite(req, res, rawSiteId, { db = pool } = {}) {
  const siteId = parsePositiveId(rawSiteId);
  if (!siteId) return deny(res, 400, 'A valid site_id is required');
  const params = [siteId, req.user.organization_id];
  let assignment = '';
  if (!isOrgAdmin(req.user)) {
    params.push(req.user.id);
    assignment = `AND EXISTS (
      SELECT 1 FROM user_sites us WHERE us.site_id=s.id AND us.user_id=$3
    )`;
  }
  const { rows } = await db.query(
    `SELECT s.*
       FROM sites s
      WHERE s.id=$1 AND s.organization_id=$2 ${assignment}
      LIMIT 1`,
    params
  );
  const site = rows[0];
  if (!site) return deny(res, 403, 'Access denied to this site');
  if (req.siteContextId && Number(req.siteContextId) !== Number(site.id)) {
    return deny(res, 409, 'Selected site does not match the requested site');
  }
  return site;
}

/** Project access is always derived from the stored project -> Site relation. */
export async function getReraProject(req, res, rawProjectId, { db = pool, includeDeleted = false } = {}) {
  const projectId = parsePositiveId(rawProjectId);
  if (!projectId) return deny(res, 400, 'A valid RERA project id is required');
  const params = [projectId, req.user.organization_id];
  let assignment = '';
  if (!isOrgAdmin(req.user)) {
    params.push(req.user.id);
    assignment = `AND EXISTS (
      SELECT 1 FROM user_sites us WHERE us.site_id=p.site_id AND us.user_id=$3
    )`;
  }
  const { rows } = await db.query(
    `SELECT p.*,s.name AS site_name
       FROM rera_projects p
       JOIN sites s ON s.id=p.site_id AND s.organization_id=p.organization_id
      WHERE p.id=$1 AND p.organization_id=$2
        ${includeDeleted ? '' : 'AND p.deleted_at IS NULL'}
        ${assignment}
      LIMIT 1`,
    params
  );
  const project = rows[0];
  if (!project) return deny(res, 404, 'RERA project not found');
  if (req.siteContextId && Number(req.siteContextId) !== Number(project.site_id)) {
    return deny(res, 409, 'Selected site does not match the RERA project');
  }
  return project;
}

/** Phase access is derived through its parent project; caller-supplied site IDs are ignored. */
export async function getReraPhase(req, res, rawPhaseId, { db = pool, includeDeleted = false } = {}) {
  const phaseId = parsePositiveId(rawPhaseId);
  if (!phaseId) return deny(res, 400, 'A valid RERA phase id is required');
  const params = [phaseId, req.user.organization_id];
  let assignment = '';
  if (!isOrgAdmin(req.user)) {
    params.push(req.user.id);
    assignment = `AND EXISTS (
      SELECT 1 FROM user_sites us WHERE us.site_id=p.site_id AND us.user_id=$3
    )`;
  }
  const { rows } = await db.query(
    `SELECT ph.*,p.site_id,p.name AS project_name
       FROM rera_project_phases ph
       JOIN rera_projects p
         ON p.id=ph.rera_project_id AND p.organization_id=ph.organization_id
      WHERE ph.id=$1 AND ph.organization_id=$2
        ${includeDeleted ? '' : 'AND ph.deleted_at IS NULL AND p.deleted_at IS NULL'}
        ${assignment}
      LIMIT 1`,
    params
  );
  const phase = rows[0];
  if (!phase) return deny(res, 404, 'RERA phase not found');
  if (req.siteContextId && Number(req.siteContextId) !== Number(phase.site_id)) {
    return deny(res, 409, 'Selected site does not match the RERA phase');
  }
  return phase;
}

/** Stakeholders are reusable at tenant level; sub-admins may use only parties linked to an assigned project. */
export async function getReraStakeholder(req, res, rawStakeholderId, { db = pool, includeDeleted = false } = {}) {
  const stakeholderId = parsePositiveId(rawStakeholderId);
  if (!stakeholderId) return deny(res, 400, 'A valid stakeholder id is required');
  const params = [stakeholderId, req.user.organization_id];
  let assignment = '';
  if (!isOrgAdmin(req.user)) {
    params.push(req.user.id);
    assignment = `AND EXISTS (
      SELECT 1
        FROM rera_project_participants pp
        JOIN rera_projects p
          ON p.id=pp.rera_project_id AND p.organization_id=pp.organization_id
        JOIN user_sites us ON us.site_id=p.site_id
       WHERE pp.stakeholder_id=st.id AND us.user_id=$3
         AND pp.deleted_at IS NULL AND p.deleted_at IS NULL
    )`;
  }
  const { rows } = await db.query(
    `SELECT st.* FROM rera_stakeholders st
      WHERE st.id=$1 AND st.organization_id=$2
        ${includeDeleted ? '' : 'AND st.deleted_at IS NULL'}
        ${assignment}
      LIMIT 1`,
    params
  );
  return rows[0] || deny(res, 404, 'Stakeholder not found');
}

/** Approval records reuse compliance_licences and remain Site/tenant scoped. */
export async function getReraApproval(req, res, rawApprovalId, { db = pool, includeDeleted = false } = {}) {
  const approvalId = parsePositiveId(rawApprovalId);
  if (!approvalId) return deny(res, 400, 'A valid approval id is required');
  const params = [approvalId, req.user.organization_id];
  let assignment = '';
  if (!isOrgAdmin(req.user)) {
    params.push(req.user.id);
    assignment = `AND a.site_id IN (SELECT site_id FROM user_sites WHERE user_id=$3)`;
  }
  const { rows } = await db.query(
    `SELECT a.*
       FROM compliance_licences a
      WHERE a.id=$1 AND a.organization_id=$2 AND a.rera_record_kind IS NOT NULL
        ${includeDeleted ? '' : 'AND a.deleted_at IS NULL'}
        ${assignment}
      LIMIT 1`,
    params
  );
  const approval = rows[0];
  if (!approval) return deny(res, 404, 'Approval record not found');
  if (req.siteContextId && Number(req.siteContextId) !== Number(approval.site_id)) {
    return deny(res, 409, 'Selected site does not match the approval record');
  }
  return approval;
}

export async function assertTenantUser(req, res, rawUserId, { required = false, db = pool } = {}) {
  if (rawUserId === null || rawUserId === undefined || rawUserId === '') {
    return required ? deny(res, 400, 'A responsible user is required') : null;
  }
  const userId = parsePositiveId(rawUserId);
  if (!userId) return deny(res, 400, 'Invalid user');
  const { rows } = await db.query(
    `SELECT id,name,email FROM users
      WHERE id=$1 AND organization_id=$2 AND is_active=TRUE LIMIT 1`,
    [userId, req.user.organization_id]
  );
  return rows[0] || deny(res, 400, 'Selected user does not belong to this organization');
}
