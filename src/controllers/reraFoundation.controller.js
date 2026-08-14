import pool from '../config/db.js';
import permissionModel from '../models/Permission.model.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  isOrgAdmin, parsePositiveId, writeComplianceAudit,
} from '../utils/complianceAccess.js';
import {
  getReraApproval, getReraPhase, getReraProject, getReraSite,
} from '../utils/reraAccess.js';
import {
  resolveSitePolicy, validateFieldPayload,
} from '../services/sitePolicy.service.js';
import {
  buildReraFieldPolicyPayload,
  deriveApprovalExpiry,
  normalizeReraApprovalInput,
  normalizeReraParticipantInput,
  normalizeReraPhaseInput,
  normalizeReraProjectInput,
  normalizeReraStakeholderInput,
  RERA_FIELD_POLICY_INPUTS,
  ReraFoundationValidationError,
} from '../services/reraFoundation.service.js';

const PROJECT_COLUMNS = Object.freeze([
  'site_id', 'operating_profile_revision_id', 'ruleset_version_id', 'authority_id',
  'authority_code', 'authority_name', 'project_code', 'name', 'project_shape',
  'development_basis', 'regulatory_status', 'status_reason', 'registration_number',
  'registration_date', 'registration_expiry_date', 'proposed_start_date',
  'proposed_completion_date', 'actual_completion_date', 'address', 'district',
  'state', 'pincode', 'latitude', 'longitude', 'total_land_area', 'project_area',
  'area_unit', 'source_review_status', 'source_reference', 'source_url',
  'source_reviewed_by', 'source_reviewed_at', 'source_review_notes', 'notes', 'metadata',
]);

const PHASE_COLUMNS = Object.freeze([
  'site_id', 'rera_project_id', 'authority_id', 'authority_code', 'authority_name',
  'phase_code', 'name', 'regulatory_status', 'status_reason', 'registration_number',
  'registration_date', 'registration_expiry_date', 'proposed_start_date',
  'proposed_completion_date', 'actual_completion_date', 'phase_area', 'area_unit',
  'notes', 'metadata',
]);

const STAKEHOLDER_COLUMNS = Object.freeze([
  'stakeholder_code', 'stakeholder_type', 'entity_type', 'legal_name', 'trade_name',
  'pan', 'gstin', 'cin_or_llpin', 'registration_number', 'email', 'phone', 'address',
  'authorized_signatory_name', 'record_review_status', 'review_notes', 'reviewed_by',
  'reviewed_at', 'status', 'metadata',
]);

const PARTICIPANT_COLUMNS = Object.freeze([
  'site_id', 'rera_project_id', 'rera_project_phase_id', 'stakeholder_id',
  'participant_role', 'is_primary', 'ownership_percentage', 'effective_from',
  'effective_to', 'basis_reference', 'notes',
]);

const APPROVAL_COLUMNS = Object.freeze([
  'site_id', 'authority_id', 'compliance_item_id', 'name', 'licence_type',
  'licence_number', 'issue_date', 'effective_date', 'expiry_date',
  'renewal_application_date', 'renewal_status', 'renewal_cost', 'security_deposit',
  'conditions', 'responsible_person_id', 'verification_status', 'reminder_days',
  'notes', 'metadata', 'rera_record_kind', 'rera_status', 'rera_authority_label',
  'rera_owner_label', 'rera_project_id', 'rera_project_phase_id',
  'rera_ruleset_requirement_id', 'rera_source_type', 'rera_source_reference',
  'rera_source_url', 'rera_source_checked_at', 'rera_evidence_review_status',
  'rera_reviewed_by', 'rera_reviewed_at', 'rera_review_notes',
]);

const REGULATORY_TRANSITIONS = Object.freeze({
  DRAFT: new Set(['APPLICABILITY_UNDER_REVIEW', 'EXEMPTION_UNDER_REVIEW', 'APPLICATION_IN_PREPARATION', 'FILED']),
  APPLICABILITY_UNDER_REVIEW: new Set(['DRAFT', 'EXEMPTION_UNDER_REVIEW', 'APPLICATION_IN_PREPARATION']),
  EXEMPTION_UNDER_REVIEW: new Set(['DRAFT', 'APPLICABILITY_UNDER_REVIEW', 'APPLICATION_IN_PREPARATION']),
  APPLICATION_IN_PREPARATION: new Set(['DRAFT', 'APPLICABILITY_UNDER_REVIEW', 'FILED']),
  FILED: new Set(['APPLICATION_IN_PREPARATION', 'REGISTERED', 'LAPSED']),
  REGISTERED: new Set(['AMENDMENT_PENDING', 'EXTENSION_PENDING', 'EXPIRED', 'LAPSED', 'REVOKED', 'COMPLETED']),
  AMENDMENT_PENDING: new Set(['REGISTERED', 'EXTENSION_PENDING', 'EXPIRED', 'LAPSED', 'REVOKED']),
  EXTENSION_PENDING: new Set(['REGISTERED', 'AMENDMENT_PENDING', 'EXPIRED', 'LAPSED', 'REVOKED']),
  EXPIRED: new Set(['EXTENSION_PENDING', 'LAPSED', 'REVOKED', 'COMPLETED']),
  LAPSED: new Set(['APPLICATION_IN_PREPARATION', 'EXTENSION_PENDING', 'REVOKED']),
  REVOKED: new Set([]),
  COMPLETED: new Set([]),
});

class ReraHttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const upper = (value) => String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
const dateOnly = (value) => (value ? String(value).slice(0, 10) : null);

const endpoint = (handler) => asyncHandler(async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    if (error instanceof ReraFoundationValidationError || error instanceof ReraHttpError) {
      res.status(error.statusCode || 400).json({
        message: error.message,
        code: error.code || 'RERA_VALIDATION_FAILED',
        field: error.field || null,
        ...(Array.isArray(error.errors) ? { errors: error.errors } : {}),
      });
      return;
    }
    if (error?.code === '23505') {
      res.status(409).json({ message: 'A conflicting RERA record already exists', code: 'RERA_RECORD_CONFLICT' });
      return;
    }
    if (['23503', '23514', '22P02', '22007'].includes(error?.code)) {
      res.status(400).json({ message: 'The RERA record contains an invalid or unavailable reference', code: 'RERA_RECORD_INVALID' });
      return;
    }
    throw error;
  }
});

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function assertTransition(previousStatus, nextStatus, entityLabel) {
  const previous = upper(previousStatus);
  const next = upper(nextStatus);
  if (!previous || !next || previous === next) return;
  if (!REGULATORY_TRANSITIONS[previous]?.has(next)) {
    throw new ReraHttpError(
      409,
      'INVALID_REGULATORY_STATUS_TRANSITION',
      `${entityLabel} regulatory status cannot move directly from ${previous} to ${next}`,
    );
  }
}

function requiredPolicyPayload(sectionPolicy, raw, normalized, fallback, aliases) {
  const candidate = { ...(fallback || {}), ...(raw || {}), ...(normalized || {}) };
  const value = {};
  for (const [field, specification] of Object.entries(sectionPolicy || {})) {
    if (!specification || specification.required !== true) continue;
    if (candidate[field] !== undefined) {
      value[field] = candidate[field];
      continue;
    }
    const alias = (aliases?.[field] || []).find((key) => candidate[key] !== undefined);
    if (alias) value[field] = candidate[alias];
  }
  return value;
}

async function enforceFieldPolicy(req, siteId, section, raw, normalized, fallback = {}, db = pool) {
  const policy = await resolveSitePolicy({
    organizationId: req.user.organization_id,
    siteId,
    db,
  });
  const sectionPolicy = policy?.fields?.[section];
  if (!sectionPolicy || typeof sectionPolicy !== 'object' || Array.isArray(sectionPolicy)) return policy;
  const aliases = RERA_FIELD_POLICY_INPUTS[section] || {};
  const submitted = validateFieldPayload({
    policy,
    section,
    partial: true,
    payload: buildReraFieldPolicyPayload(section, raw, normalized),
  });
  const required = validateFieldPayload({
    policy,
    section,
    partial: false,
    payload: requiredPolicyPayload(sectionPolicy, raw, normalized, fallback, aliases),
  });
  const errors = [...new Set([...(submitted.errors || []), ...(required.errors || [])])];
  if (errors.length) {
    const error = new ReraHttpError(422, 'FIELD_POLICY_VALIDATION_FAILED', errors.join('; '));
    error.errors = errors;
    throw error;
  }
  return policy;
}

async function assertAuthority(organizationId, authorityId, db) {
  if (!authorityId) return null;
  const { rows } = await db.query(
    `SELECT id,name FROM compliance_authorities
      WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL AND is_active=TRUE LIMIT 1`,
    [authorityId, organizationId],
  );
  if (!rows[0]) throw new ReraHttpError(400, 'INVALID_AUTHORITY', 'Selected authority is not available to this organization');
  return rows[0];
}

async function assertTenantUser(organizationId, userId, db, field = 'responsible_person_id') {
  if (!userId) return null;
  const { rows } = await db.query(
    'SELECT id,name,email FROM users WHERE id=$1 AND organization_id=$2 AND is_active=TRUE LIMIT 1',
    [userId, organizationId],
  );
  if (!rows[0]) throw new ReraHttpError(400, 'INVALID_TENANT_USER', `${field} is not an active user in this organization`);
  return rows[0];
}

async function activeProfile(req, siteId, db) {
  const { rows } = await db.query(
    `SELECT p.*,rv.version AS ruleset_version,r.code AS ruleset_code,r.name AS ruleset_name,
            rv.lifecycle_status AS ruleset_lifecycle_status,
            rv.source_review_status AS ruleset_source_review_status
       FROM site_operating_profile_revisions p
       JOIN rera_ruleset_versions rv ON rv.id=p.ruleset_version_id AND rv.deleted_at IS NULL
         AND rv.lifecycle_status IN ('PUBLISHED','SUPERSEDED')
       JOIN rera_rulesets r ON r.id=rv.ruleset_id AND r.deleted_at IS NULL AND r.is_active=TRUE
      WHERE p.organization_id=$1 AND p.site_id=$2 AND p.lifecycle_status='PUBLISHED'
        AND p.effective_to IS NULL AND p.deleted_at IS NULL
        AND (r.organization_id IS NULL OR r.organization_id=$1)
      ORDER BY p.revision_number DESC LIMIT 1`,
    [req.user.organization_id, siteId],
  );
  if (!rows[0]) {
    throw new ReraHttpError(
      409,
      'PUBLISHED_OPERATING_PROFILE_REQUIRED',
      'Publish a Site operating profile with an active ruleset before creating RERA project records',
    );
  }
  return rows[0];
}

async function insertRow(db, table, columns, value, organizationId, userId, { updated = true } = {}) {
  const allColumns = ['organization_id', ...columns, 'created_by', ...(updated ? ['updated_by'] : [])];
  const params = [organizationId, ...columns.map((column) => value[column] ?? null), userId, ...(updated ? [userId] : [])];
  const placeholders = params.map((_, index) => `$${index + 1}`).join(',');
  const { rows } = await db.query(
    `INSERT INTO ${table} (${allColumns.join(',')}) VALUES (${placeholders}) RETURNING *`,
    params,
  );
  return rows[0];
}

async function updateRow(db, table, columns, value, id, organizationId, userId, extraWhere = '') {
  const params = columns.map((column) => value[column] ?? null);
  const assignments = columns.map((column, index) => `${column}=$${index + 1}`).join(',');
  params.push(userId, id, organizationId);
  const userPosition = columns.length + 1;
  const idPosition = columns.length + 2;
  const orgPosition = columns.length + 3;
  const { rows } = await db.query(
    `UPDATE ${table}
        SET ${assignments},updated_by=$${userPosition},updated_at=NOW()
      WHERE id=$${idPosition} AND organization_id=$${orgPosition}
        AND deleted_at IS NULL ${extraWhere}
      RETURNING *`,
    params,
  );
  return rows[0] || null;
}

async function assertStoredSite(req, res, siteId, db = pool) {
  if (req.siteContextId && Number(req.siteContextId) !== Number(siteId)) {
    res.status(409).json({ code: 'SITE_CONTEXT_MISMATCH', message: 'Selected Site does not match the RERA record' });
    return null;
  }
  return getReraSite(req, res, siteId, { db });
}

const CONTEXT_QUERIES = Object.freeze({
  project: {
    param: 'projectId',
    sql: `SELECT p.id,p.site_id FROM rera_projects p
           WHERE p.id=$1 AND p.organization_id=$2 AND p.deleted_at IS NULL`,
  },
  phase: {
    param: 'phaseId',
    sql: `SELECT ph.id,ph.site_id,ph.rera_project_id FROM rera_project_phases ph
           JOIN rera_projects p ON p.id=ph.rera_project_id AND p.organization_id=ph.organization_id
          WHERE ph.id=$1 AND ph.organization_id=$2 AND ph.deleted_at IS NULL AND p.deleted_at IS NULL`,
  },
  participant: {
    param: 'participantId',
    sql: `SELECT pp.id,pp.site_id,pp.rera_project_id FROM rera_project_participants pp
           JOIN rera_projects p ON p.id=pp.rera_project_id AND p.organization_id=pp.organization_id
          WHERE pp.id=$1 AND pp.organization_id=$2 AND pp.deleted_at IS NULL AND p.deleted_at IS NULL`,
  },
  approval: {
    param: 'approvalId',
    sql: `SELECT a.id,a.site_id,a.rera_project_id FROM compliance_licences a
           WHERE a.id=$1 AND a.organization_id=$2 AND a.rera_record_kind IS NOT NULL
             AND a.deleted_at IS NULL`,
  },
  bodyProject: {
    body: true,
    sql: `SELECT p.id,p.site_id FROM rera_projects p
           WHERE p.id=$1 AND p.organization_id=$2 AND p.deleted_at IS NULL`,
  },
});

/** Resolve a path/body entity to its stored Site before permission middleware runs. */
export const deriveReraSiteContext = (kind) => async (req, res, next) => {
  try {
    const config = CONTEXT_QUERIES[kind];
    if (!config) return res.status(500).json({ message: 'Invalid RERA route context' });
    const rawId = config.body
      ? (req.body?.rera_project_id ?? req.body?.project_id)
      : req.params?.[config.param];
    const id = parsePositiveId(rawId);
    if (!id) return res.status(400).json({ code: 'INVALID_RERA_REFERENCE', message: 'A valid RERA record id is required' });
    const params = [id, req.user.organization_id];
    let assignment = '';
    if (!isOrgAdmin(req.user)) {
      params.push(req.user.id);
      assignment = ` AND EXISTS (
        SELECT 1 FROM user_sites us WHERE us.site_id=scoped.site_id AND us.user_id=$3
      )`;
    }
    const { rows } = await pool.query(
      `SELECT scoped.* FROM (${config.sql}) scoped WHERE TRUE ${assignment} LIMIT 1`,
      params,
    );
    const record = rows[0];
    if (!record) return res.status(404).json({ message: 'RERA record not found' });
    if (req.siteContextId && Number(req.siteContextId) !== Number(record.site_id)) {
      return res.status(409).json({ code: 'SITE_CONTEXT_MISMATCH', message: 'Selected Site does not match the RERA record' });
    }
    req.siteContextId = Number(record.site_id);
    req.reraContextRecord = record;
    return next();
  } catch (error) {
    return next(error);
  }
};

function publicProject(row) {
  if (!row) return null;
  return {
    ...row,
    project_id: row.id,
    project_name: row.name,
    authority: row.authority_name || row.authority_record_name || row.authority_code || null,
    active_ruleset_name: row.ruleset_name || null,
  };
}

function publicPhase(row) {
  if (!row) return null;
  return {
    ...row,
    phase_id: row.id,
    project_id: row.rera_project_id,
    phase_name: row.name,
    authority: row.authority_name || row.authority_record_name || row.authority_code || null,
  };
}

function publicStakeholder(row) {
  if (!row) return null;
  return { ...row, stakeholder_id: row.id, rera_stakeholder_id: row.id, name: row.legal_name };
}

function publicParticipant(row) {
  if (!row) return null;
  const stakeholder = row.stakeholder || (row.legal_name ? publicStakeholder({
    id: row.stakeholder_id,
    stakeholder_code: row.stakeholder_code,
    stakeholder_type: row.stakeholder_type,
    entity_type: row.entity_type,
    legal_name: row.legal_name,
    trade_name: row.trade_name,
    pan: row.pan,
    gstin: row.gstin,
    cin_or_llpin: row.cin_or_llpin,
    registration_number: row.stakeholder_registration_number,
    email: row.email,
    phone: row.phone,
    address: row.address,
    authorized_signatory_name: row.authorized_signatory_name,
    record_review_status: row.record_review_status,
    status: row.stakeholder_status,
  }) : null);
  return {
    ...row,
    participant_id: row.id,
    relationship_id: row.id,
    project_id: row.rera_project_id,
    phase_id: row.rera_project_phase_id,
    rera_stakeholder_id: row.stakeholder_id,
    role: row.participant_role,
    stakeholder,
  };
}

const reviewStatusToUi = (status) => ({
  PENDING: 'NOT_REVIEWED', ACCEPTED: 'REVIEWED', REJECTED: 'RETURNED', NOT_REQUIRED: 'NOT_REQUIRED',
}[status] || status || 'NOT_REVIEWED');

const approvalExpiryThreshold = (row) => {
  const metadataThreshold = Number(row?.metadata?.expiry_threshold_days);
  if (Number.isSafeInteger(metadataThreshold) && metadataThreshold >= 0 && metadataThreshold <= 3_650) {
    return metadataThreshold;
  }
  const configuredReminders = Array.isArray(row?.reminder_days)
    ? row.reminder_days.map(Number).filter((value) => Number.isSafeInteger(value) && value >= 0 && value <= 3_650)
    : [];
  return configuredReminders.length ? Math.max(...configuredReminders) : 0;
};

function publicApproval(row) {
  if (!row) return null;
  const expiry = deriveApprovalExpiry({
    expiry_date: row.expiry_date,
    threshold_days: approvalExpiryThreshold(row),
  });
  return {
    ...row,
    approval_id: row.id,
    project_id: row.rera_project_id,
    phase_id: row.rera_project_phase_id,
    approval_type: row.licence_type || row.name,
    type: row.licence_type || row.name,
    authority: row.rera_authority_label || row.authority_name || null,
    issuer: row.rera_authority_label || row.authority_name || null,
    reference_number: row.licence_number,
    reference: row.licence_number,
    valid_from: row.effective_date,
    valid_until: row.expiry_date,
    status: row.rera_status,
    source_reference: row.rera_source_reference || row.rera_source_url,
    source_url: row.rera_source_url,
    owner_name: row.rera_owner_label || row.responsible_user_name || null,
    review_status: reviewStatusToUi(row.rera_evidence_review_status),
    expiry_state: expiry.state,
    days_remaining: expiry.days_remaining,
  };
}

async function canReadModule(req, policy, module) {
  if (policy?.modules?.[module] !== true) return false;
  if (isOrgAdmin(req.user)) return true;
  const permission = await permissionModel.getPermission(req.user.id, module);
  return permission?.can_read === true;
}

async function loadProjectWorkspace(req, siteId, selectedProject, policy) {
  if (!selectedProject) {
    return {
      phases: [], requirements: [], approvals: [], stakeholders: [], stakeholder_catalog: [],
      evidence: [], upcoming: [], attention: [], activity: [],
      summary: {
        requirements_total: 0, requirements_documented: 0,
        approvals_total: 0, approvals_recorded: 0,
        evidence_total: 0, evidence_reviewed: 0, stakeholders_linked: 0,
        profile_revision: policy?.policy_revision || null,
        ruleset_name: policy?.ruleset?.name || null,
      },
    };
  }

  const organizationId = req.user.organization_id;
  const projectId = selectedProject.id;

  // Development-authorised builders use the same canonical project records,
  // but do not need the regulatory workspace's requirements, evidence,
  // stakeholder or audit queries. Keep that initial request intentionally
  // lean so the project planner opens without loading RERA-only data.
  if (policy?.capabilities?.rera_workspace !== true) {
    const { rows: phases } = await pool.query(
      `SELECT ph.*,ca.name AS authority_record_name
         FROM rera_project_phases ph
         LEFT JOIN compliance_authorities ca
           ON ca.id=ph.authority_id AND ca.organization_id=ph.organization_id AND ca.deleted_at IS NULL
        WHERE ph.organization_id=$1 AND ph.site_id=$2 AND ph.rera_project_id=$3
          AND ph.deleted_at IS NULL ORDER BY ph.phase_code,ph.id`,
      [organizationId, siteId, projectId],
    );
    return {
      phases,
      requirements: [],
      approvals: [],
      stakeholders: [],
      stakeholder_catalog: [],
      evidence: [],
      upcoming: [],
      attention: [],
      activity: [],
      summary: {
        requirements_total: 0,
        requirements_documented: null,
        approvals_total: null,
        approvals_recorded: null,
        evidence_total: null,
        evidence_reviewed: null,
        stakeholders_linked: 0,
        profile_revision: policy?.policy_revision || null,
        ruleset_name: null,
      },
    };
  }

  const [canApprovals, canEvidence] = await Promise.all([
    canReadModule(req, policy, 'rera_approvals'),
    canReadModule(req, policy, 'rera_evidence'),
  ]);

  const phasesPromise = pool.query(
    `SELECT ph.*,ca.name AS authority_record_name
       FROM rera_project_phases ph
       LEFT JOIN compliance_authorities ca
         ON ca.id=ph.authority_id AND ca.organization_id=ph.organization_id AND ca.deleted_at IS NULL
      WHERE ph.organization_id=$1 AND ph.site_id=$2 AND ph.rera_project_id=$3
        AND ph.deleted_at IS NULL ORDER BY ph.phase_code,ph.id`,
    [organizationId, siteId, projectId],
  );
  const requirementsPromise = pool.query(
    `SELECT rr.*,
            ci.id AS compliance_item_id,ci.status AS compliance_status,
            ci.current_due_date,ci.next_due_date,ci.completion_percentage,
            COALESCE(ev.evidence_count,0)::int AS evidence_count
       FROM rera_ruleset_requirements rr
       LEFT JOIN LATERAL (
         SELECT item.id,item.status,item.current_due_date,item.next_due_date,item.completion_percentage
           FROM compliance_items item
          WHERE item.organization_id=$1 AND item.site_id=$2 AND item.rera_project_id=$3
            AND item.rera_ruleset_requirement_id=rr.id AND item.deleted_at IS NULL
          ORDER BY item.updated_at DESC,item.id DESC LIMIT 1
       ) ci ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS evidence_count
           FROM compliance_documents d
          WHERE $5::boolean=TRUE
            AND d.organization_id=$1 AND d.site_id=$2 AND d.rera_project_id=$3
            AND d.rera_ruleset_requirement_id=rr.id AND d.deleted_at IS NULL
            AND ($6::boolean=TRUE OR d.confidentiality <> 'RESTRICTED')
       ) ev ON TRUE
      WHERE rr.ruleset_version_id=$4 AND rr.is_active=TRUE
      ORDER BY rr.sequence,rr.id`,
    [
      organizationId, siteId, projectId, selectedProject.ruleset_version_id,
      canEvidence, isOrgAdmin(req.user),
    ],
  );
  const stakeholdersPromise = pool.query(
    `SELECT pp.*,
            st.stakeholder_code,st.stakeholder_type,st.entity_type,st.legal_name,st.trade_name,
            st.pan,st.gstin,st.cin_or_llpin,st.registration_number AS stakeholder_registration_number,
            st.email,st.phone,st.address,st.authorized_signatory_name,
            st.record_review_status,st.status AS stakeholder_status
       FROM rera_project_participants pp
       JOIN rera_stakeholders st
         ON st.id=pp.stakeholder_id AND st.organization_id=pp.organization_id AND st.deleted_at IS NULL
      WHERE pp.organization_id=$1 AND pp.site_id=$2 AND pp.rera_project_id=$3
        AND pp.deleted_at IS NULL AND (pp.effective_to IS NULL OR pp.effective_to >= CURRENT_DATE)
      ORDER BY pp.is_primary DESC,st.legal_name,pp.id`,
    [organizationId, siteId, projectId],
  );
  // The catalog query is organization-scoped for an admin. Keep the Site and
  // user parameters conditional, because PostgreSQL rejects surplus bound
  // values when the sub-admin-only scope (and its $2/$3 placeholders) is not
  // present.
  const catalogParams = [organizationId];
  let catalogScope = '';
  if (!isOrgAdmin(req.user)) {
    catalogParams.push(siteId, req.user.id);
    catalogScope = `AND (
      st.created_by=$3 OR EXISTS (
        SELECT 1 FROM rera_project_participants linked
        JOIN rera_projects linked_project
          ON linked_project.id=linked.rera_project_id
         AND linked_project.organization_id=linked.organization_id
        WHERE linked.stakeholder_id=st.id AND linked.organization_id=st.organization_id
          AND linked_project.site_id=$2 AND linked.deleted_at IS NULL
          AND linked_project.deleted_at IS NULL
      )
    )`;
  }
  const catalogPromise = pool.query(
    `SELECT st.* FROM rera_stakeholders st
      WHERE st.organization_id=$1 AND st.deleted_at IS NULL ${catalogScope}
      ORDER BY st.legal_name,st.id LIMIT 500`,
    catalogParams,
  );
  const approvalsPromise = canApprovals ? pool.query(
    `SELECT a.*,ca.name AS authority_name,u.name AS responsible_user_name,
            CASE WHEN $4::boolean THEN COALESCE(docs.evidence_count,0)::int ELSE NULL END AS evidence_count
       FROM compliance_licences a
       LEFT JOIN compliance_authorities ca
         ON ca.id=a.authority_id AND ca.organization_id=a.organization_id AND ca.deleted_at IS NULL
       LEFT JOIN users u
         ON u.id=a.responsible_person_id AND u.organization_id=a.organization_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS evidence_count FROM compliance_documents d
          WHERE $4::boolean=TRUE
            AND d.organization_id=a.organization_id AND d.entity_type='RERA_APPROVAL'
            AND d.entity_id=a.id AND d.deleted_at IS NULL
            AND ($5::boolean=TRUE OR d.confidentiality <> 'RESTRICTED')
       ) docs ON TRUE
      WHERE a.organization_id=$1 AND a.site_id=$2 AND a.rera_project_id=$3
        AND a.rera_record_kind IS NOT NULL AND a.deleted_at IS NULL
      ORDER BY a.updated_at DESC,a.id DESC`,
    [organizationId, siteId, projectId, canEvidence, isOrgAdmin(req.user)],
  ) : Promise.resolve({ rows: [] });
  const evidenceParams = [organizationId, siteId, projectId];
  const confidentiality = isOrgAdmin(req.user) ? '' : `AND d.confidentiality <> 'RESTRICTED'`;
  const evidencePromise = canEvidence ? pool.query(
    `SELECT d.id,d.site_id,d.entity_type,d.entity_id,d.category,d.title,d.original_name,
            d.mime_type,d.file_size,d.version_no,d.tags,d.verification_status,d.approval_status,
            d.confidentiality,d.issue_date,d.effective_date,d.expiry_date,d.issuing_authority,
            d.document_type,d.document_number,d.source_type,d.source_reference,d.source_url,
            d.source_retrieved_at,d.review_status,d.reviewed_by,d.reviewed_at,d.review_notes,
            d.supersedes_document_id,d.superseded_at,d.rera_project_id,
            d.rera_project_phase_id,d.rera_ruleset_requirement_id,d.uploaded_by,d.created_at,
            uploader.name AS uploaded_by_name,reviewer.name AS reviewed_by_name
       FROM compliance_documents d
       LEFT JOIN users uploader
         ON uploader.id=d.uploaded_by AND uploader.organization_id=d.organization_id
       LEFT JOIN users reviewer
         ON reviewer.id=d.reviewed_by AND reviewer.organization_id=d.organization_id
      WHERE d.organization_id=$1 AND d.site_id=$2 AND d.rera_project_id=$3
        AND d.deleted_at IS NULL ${confidentiality}
      ORDER BY d.created_at DESC,d.id DESC LIMIT 500`,
    evidenceParams,
  ) : Promise.resolve({ rows: [] });

  const [phaseResult, requirementResult, stakeholderResult, catalogResult, approvalResult, evidenceResult] = await Promise.all([
    phasesPromise, requirementsPromise, stakeholdersPromise, catalogPromise, approvalsPromise, evidencePromise,
  ]);
  const phases = phaseResult.rows.map(publicPhase);
  const requirements = requirementResult.rows.map((row) => {
    const result = {
      ...row,
      requirement_id: row.id,
      reference: row.source_reference,
      status: row.compliance_status || 'NOT_RECORDED',
    };
    if (!canEvidence) delete result.evidence_count;
    return result;
  });
  const stakeholders = stakeholderResult.rows.map(publicParticipant);
  const stakeholderCatalog = catalogResult.rows.map(publicStakeholder);
  const approvals = approvalResult.rows.map(publicApproval);
  const evidence = evidenceResult.rows;

  const today = new Date().toISOString().slice(0, 10);
  const attention = [];
  for (const approval of approvals) {
    if (approval.rera_status === 'MISSING') {
      attention.push({
        type: 'APPROVAL', entity_type: 'RERA_APPROVAL', entity_id: approval.id,
        target_tab: 'approvals-evidence', title: `${approval.approval_type} is recorded as missing`,
        status: 'MISSING',
      });
    }
    if (['EXPIRED', 'EXPIRES_TODAY', 'EXPIRING_SOON'].includes(approval.expiry_state)) {
      attention.push({
        type: 'APPROVAL_EXPIRY', entity_type: 'RERA_APPROVAL', entity_id: approval.id,
        target_tab: 'approvals-evidence', title: `${approval.approval_type} ${approval.expiry_state === 'EXPIRED' ? 'has expired' : 'is nearing its recorded expiry'}`,
        due_date: dateOnly(approval.expiry_date), status: approval.expiry_state,
      });
    }
    if (approval.rera_evidence_review_status === 'REJECTED') {
      attention.push({
        type: 'APPROVAL_REVIEW', entity_type: 'RERA_APPROVAL', entity_id: approval.id,
        target_tab: 'approvals-evidence', title: `${approval.approval_type} evidence was returned`, status: 'REJECTED',
      });
    }
  }
  for (const document of evidence) {
    const expiryDate = dateOnly(document.expiry_date);
    if (expiryDate && expiryDate < today) {
      attention.push({
        type: 'DOCUMENT_EXPIRY', entity_type: 'RERA_EVIDENCE', entity_id: document.id,
        target_tab: 'approvals-evidence', title: `${document.title} has passed its recorded expiry date`,
        due_date: expiryDate, status: 'EXPIRED',
      });
    }
    if (document.review_status === 'REJECTED') {
      attention.push({
        type: 'DOCUMENT_REVIEW', entity_type: 'RERA_EVIDENCE', entity_id: document.id,
        target_tab: 'approvals-evidence', title: `${document.title} evidence was rejected`, status: 'REJECTED',
      });
    }
  }
  for (const requirement of requirements) {
    const dueDate = dateOnly(requirement.current_due_date || requirement.next_due_date);
    if (dueDate && dueDate < today && !['COMPLETED', 'CANCELLED', 'NOT_APPLICABLE'].includes(requirement.compliance_status)) {
      attention.push({
        type: 'RECORDED_DUE_DATE', entity_type: 'RERA_REQUIREMENT', entity_id: requirement.id,
        target_tab: 'overview', title: `${requirement.title} has passed its recorded due date`,
        due_date: dueDate, status: 'OVERDUE',
      });
    }
  }

  const upcoming = [];
  for (const requirement of requirements) {
    const dueDate = dateOnly(requirement.current_due_date || requirement.next_due_date);
    if (dueDate && dueDate >= today) upcoming.push({
      type: 'RECORDED_DUE_DATE', entity_type: 'RERA_REQUIREMENT', entity_id: requirement.id,
      title: requirement.title, due_date: dueDate, status: requirement.compliance_status || 'RECORDED',
    });
  }
  for (const approval of approvals) {
    const dueDate = dateOnly(approval.expiry_date);
    if (dueDate && dueDate >= today) upcoming.push({
      type: 'APPROVAL_EXPIRY', entity_type: 'RERA_APPROVAL', entity_id: approval.id,
      title: approval.approval_type, due_date: dueDate, status: approval.expiry_state,
    });
  }
  for (const document of evidence) {
    const dueDate = dateOnly(document.expiry_date);
    if (dueDate && dueDate >= today) upcoming.push({
      type: 'DOCUMENT_EXPIRY', entity_type: 'RERA_EVIDENCE', entity_id: document.id,
      title: document.title, due_date: dueDate, status: document.review_status || 'RECORDED',
    });
  }
  upcoming.sort((left, right) => String(left.due_date).localeCompare(String(right.due_date)));

  const activityTypes = ['RERA_PROJECT', 'RERA_PHASE', 'RERA_PARTICIPANT', 'RERA_STAKEHOLDER'];
  if (canApprovals) activityTypes.push('RERA_APPROVAL');
  const { rows: activityRows } = await pool.query(
    `SELECT a.id,a.action,a.entity_type,a.entity_id,a.reason,a.created_at,u.name AS actor_name,
            COALESCE(a.previous_value->>'regulatory_status',a.previous_value->>'rera_status',
                     a.previous_value->>'status') AS previous_status,
            COALESCE(a.new_value->>'regulatory_status',a.new_value->>'rera_status',
                     a.new_value->>'status') AS new_status
       FROM compliance_audit_log a
       LEFT JOIN users u ON u.id=a.user_id AND u.organization_id=a.organization_id
      WHERE a.organization_id=$1 AND a.site_id=$2 AND a.entity_type=ANY($3::text[])
        AND (
          (a.entity_type='RERA_PROJECT' AND a.entity_id=$4)
          OR (a.entity_type='RERA_PHASE' AND EXISTS (
            SELECT 1 FROM rera_project_phases activity_phase
             WHERE activity_phase.organization_id=a.organization_id
               AND activity_phase.rera_project_id=$4 AND activity_phase.id=a.entity_id
          ))
          OR (a.entity_type='RERA_PARTICIPANT' AND EXISTS (
            SELECT 1 FROM rera_project_participants activity_link
             WHERE activity_link.organization_id=a.organization_id
               AND activity_link.rera_project_id=$4 AND activity_link.id=a.entity_id
          ))
          OR (a.entity_type='RERA_APPROVAL' AND EXISTS (
            SELECT 1 FROM compliance_licences activity_approval
             WHERE activity_approval.organization_id=a.organization_id
               AND activity_approval.rera_project_id=$4 AND activity_approval.id=a.entity_id
          ))
          OR (a.entity_type='RERA_STAKEHOLDER' AND EXISTS (
            SELECT 1 FROM rera_project_participants activity_participant
             WHERE activity_participant.organization_id=a.organization_id
               AND activity_participant.rera_project_id=$4
               AND activity_participant.stakeholder_id=a.entity_id
               AND activity_participant.deleted_at IS NULL
          ))
        )
        AND ($5::boolean=TRUE OR a.action NOT LIKE 'DOCUMENT_%')
      ORDER BY a.created_at DESC,a.id DESC LIMIT 100`,
    [organizationId, siteId, activityTypes, projectId, canEvidence],
  );
  const activity = activityRows.map((row) => ({
    ...row,
    title: row.action.split('_').map((part) => part.toLowerCase()).join(' '),
    changed_at: row.created_at,
    comment: row.reason,
  }));

  return {
    phases,
    requirements,
    approvals,
    stakeholders,
    stakeholder_catalog: stakeholderCatalog,
    evidence,
    attention: attention.slice(0, 100),
    upcoming: upcoming.slice(0, 100),
    activity,
    summary: {
      requirements_total: requirements.length,
      requirements_documented: canEvidence
        ? requirements.filter((row) => row.evidence_count > 0).length
        : null,
      approvals_total: canApprovals ? approvals.length : null,
      approvals_recorded: canApprovals
        ? approvals.filter((row) => row.rera_status && row.rera_status !== 'MISSING').length
        : null,
      evidence_total: canEvidence ? evidence.length : null,
      evidence_reviewed: canEvidence
        ? evidence.filter((row) => row.review_status === 'ACCEPTED').length
        : null,
      stakeholders_linked: stakeholders.length,
      profile_revision: policy?.policy_revision || null,
      ruleset_name: selectedProject.ruleset_name || null,
      ruleset_version: selectedProject.ruleset_version || null,
    },
  };
}

/** GET /rera/control-centre?site_id=&project_id= */
export const getReraControlCentre = endpoint(async (req, res) => {
  const site = await getReraSite(req, res, req.query.site_id ?? req.siteContextId);
  if (!site) return;
  const projectsOnly = ['1', 'true'].includes(String(req.query.projects_only));
  const policy = projectsOnly ? null : await resolveSitePolicy({
    organizationId: req.user.organization_id,
    siteId: site.id,
    db: pool,
  });
  const { rows } = await pool.query(
    `SELECT p.*,ca.name AS authority_record_name,r.name AS ruleset_name,r.code AS ruleset_code,
            rv.version AS ruleset_version,op.revision_number AS operating_profile_revision,
            COALESCE(phase_list.phases,'[]'::jsonb) AS phases
       FROM rera_projects p
       JOIN site_operating_profile_revisions op
         ON op.id=p.operating_profile_revision_id AND op.organization_id=p.organization_id
        AND op.site_id=p.site_id
       JOIN rera_ruleset_versions rv ON rv.id=p.ruleset_version_id
       JOIN rera_rulesets r ON r.id=rv.ruleset_id
       LEFT JOIN compliance_authorities ca
         ON ca.id=p.authority_id AND ca.organization_id=p.organization_id AND ca.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'id',ph.id,'project_id',ph.rera_project_id,'name',ph.name,
           'phase_code',ph.phase_code,'regulatory_status',ph.regulatory_status
         ) ORDER BY ph.phase_code,ph.id) AS phases
           FROM rera_project_phases ph
          WHERE ph.organization_id=p.organization_id AND ph.site_id=p.site_id
            AND ph.rera_project_id=p.id AND ph.deleted_at IS NULL
       ) phase_list ON TRUE
      WHERE p.organization_id=$1 AND p.site_id=$2 AND p.deleted_at IS NULL
      ORDER BY p.updated_at DESC,p.id DESC`,
    [req.user.organization_id, site.id],
  );
  const projects = rows.map(publicProject);
  // Callers that only fill a project picker (Project Finance) skip the selected
  // project's workspace, which is ~8 further queries they never read.
  if (projectsOnly) {
    res.set('Cache-Control', 'private, no-store');
    res.json({ site: { id: site.id, name: site.name }, projects });
    return;
  }
  const suppliedProject = req.query.project_id;
  const requestedProjectId = suppliedProject ? parsePositiveId(suppliedProject) : null;
  if (suppliedProject && !requestedProjectId) {
    throw new ReraHttpError(400, 'INVALID_RERA_PROJECT', 'project_id must be a positive integer');
  }
  const selectedProject = requestedProjectId
    ? projects.find((project) => Number(project.id) === requestedProjectId)
    : (projects[0] || null);
  if (requestedProjectId && !selectedProject) {
    throw new ReraHttpError(404, 'RERA_PROJECT_NOT_FOUND', 'RERA project was not found in the selected Site');
  }
  const workspace = await loadProjectWorkspace(req, site.id, selectedProject, policy);
  res.set('Cache-Control', 'private, no-store');
  res.json({
    site: { id: site.id, name: site.name },
    projects,
    selected_project: selectedProject,
    ...workspace,
  });
});

/** GET /rera/rulesets?site_id= */
export const listReraRulesets = endpoint(async (req, res) => {
  const site = await getReraSite(req, res, req.query.site_id ?? req.siteContextId);
  if (!site) return;
  const { rows: profileRows } = await pool.query(
    `SELECT id,ruleset_version_id,revision_number,lifecycle_status,effective_from
       FROM site_operating_profile_revisions
      WHERE organization_id=$1 AND site_id=$2 AND lifecycle_status='PUBLISHED'
        AND effective_to IS NULL AND deleted_at IS NULL
      ORDER BY revision_number DESC LIMIT 1`,
    [req.user.organization_id, site.id],
  );
  const { rows } = await pool.query(
    `SELECT r.id AS ruleset_id,r.code,r.name,r.scope,r.jurisdiction_country_code,
            r.jurisdiction_state_code,r.authority_label,r.description,r.source_kind,
            r.source_reference,r.source_url,r.source_review_status,r.source_review_notes,
            r.disclaimer,rv.id AS version_id,rv.version,rv.version_label,
            rv.lifecycle_status,rv.content_classification,rv.contains_legal_requirements,
            rv.effective_from,rv.effective_to,rv.source_title,
            rv.source_review_status AS version_source_review_status,rv.legal_disclaimer
       FROM rera_rulesets r
       JOIN rera_ruleset_versions rv ON rv.ruleset_id=r.id AND rv.deleted_at IS NULL
      WHERE r.deleted_at IS NULL AND r.is_active=TRUE
        AND (r.organization_id IS NULL OR r.organization_id=$1)
        AND rv.lifecycle_status='PUBLISHED'
      ORDER BY r.name,rv.version DESC`,
    [req.user.organization_id],
  );
  res.json({
    site: { id: site.id, name: site.name },
    active_profile: profileRows[0] || null,
    active_ruleset_version_id: profileRows[0]?.ruleset_version_id || null,
    rulesets: rows,
  });
});

function reviewedProjectSourcePayload(req, fallback = {}) {
  const payload = { ...req.body };
  const previous = upper(fallback.source_review_status);
  const hasDecision = own(payload, 'source_review_status');
  const touchesReviewNotes = own(payload, 'source_review_notes');

  // Reviewer identity and time are always server-owned, even when a client
  // attempts to submit similarly named fields.
  payload.source_reviewed_by = fallback.source_reviewed_by ?? null;
  payload.source_reviewed_at = fallback.source_reviewed_at ?? null;
  if (!touchesReviewNotes) payload.source_review_notes = fallback.source_review_notes ?? null;

  if (!hasDecision) {
    if (touchesReviewNotes && ['REVIEWED', 'REJECTED'].includes(previous) && !isOrgAdmin(req.user)) {
      throw new ReraHttpError(403, 'RERA_REVIEW_ADMIN_REQUIRED', 'Only an administrator can change project source-review notes');
    }
    return payload;
  }

  const status = upper(payload.source_review_status);
  const reviewSensitive = ['REVIEWED', 'REJECTED'].includes(status)
    || (['REVIEWED', 'REJECTED'].includes(previous) && status !== previous);
  if (reviewSensitive && !isOrgAdmin(req.user)) {
    throw new ReraHttpError(403, 'RERA_REVIEW_ADMIN_REQUIRED', 'Only an administrator can record or change a project source-review decision');
  }
  payload.source_review_status = status;
  if (['REVIEWED', 'REJECTED'].includes(status)) {
    payload.source_reviewed_by = req.user.id;
    payload.source_reviewed_at = new Date();
    if (status === 'REJECTED' && !String(payload.source_review_notes || '').trim()) {
      throw new ReraHttpError(422, 'RERA_REVIEW_NOTES_REQUIRED', 'Rejected project source review requires notes');
    }
  } else if (status !== previous) {
    payload.source_reviewed_by = null;
    payload.source_reviewed_at = null;
    payload.source_review_notes = null;
  }
  return payload;
}

/** POST /rera/projects */
export const createReraProject = endpoint(async (req, res) => {
  const site = await getReraSite(req, res, req.body.site_id ?? req.siteContextId);
  if (!site) return;
  if (own(req.body, 'operating_profile_revision_id') || own(req.body, 'profile_revision_id')
      || own(req.body, 'ruleset_version_id')) {
    throw new ReraHttpError(
      400,
      'SERVER_MANAGED_PROJECT_POLICY',
      'Operating profile and ruleset versions are derived from the published Site profile',
    );
  }
  const saved = await inTransaction(async (client) => {
    await client.query(
      'SELECT id FROM sites WHERE id=$1 AND organization_id=$2 FOR UPDATE',
      [site.id, req.user.organization_id],
    );
    const profile = await activeProfile(req, site.id, client);
    const raw = reviewedProjectSourcePayload(req);
    const authoritative = {
      ...raw,
      site_id: site.id,
      operating_profile_revision_id: profile.id,
      ruleset_version_id: profile.ruleset_version_id,
    };
    const input = normalizeReraProjectInput(authoritative);
    input.source_reviewed_by = raw.source_reviewed_by ?? null;
    input.source_reviewed_at = raw.source_reviewed_at ?? null;
    await enforceFieldPolicy(req, site.id, 'rera_projects', req.body, input, {}, client);
    await assertAuthority(req.user.organization_id, input.authority_id, client);
    await assertTenantUser(req.user.organization_id, input.source_reviewed_by, client, 'source_reviewed_by');
    const row = await insertRow(
      client, 'rera_projects', PROJECT_COLUMNS, input,
      req.user.organization_id, req.user.id,
    );
    await writeComplianceAudit(client, req, {
      action: 'RERA_PROJECT_CREATED', entityType: 'RERA_PROJECT', entityId: row.id,
      siteId: site.id, newValue: row,
      reason: input.source_review_notes || input.status_reason || null,
    });
    return row;
  });
  res.status(201).json({ project: publicProject(saved) });
});

/** PATCH /rera/projects/:projectId */
export const updateReraProject = endpoint(async (req, res) => {
  if (own(req.body, 'operating_profile_revision_id') || own(req.body, 'profile_revision_id')
      || own(req.body, 'ruleset_version_id')) {
    throw new ReraHttpError(
      400,
      'SERVER_MANAGED_PROJECT_POLICY',
      'A project keeps its recorded operating profile and ruleset version',
    );
  }
  const saved = await inTransaction(async (client) => {
    const project = await getReraProject(req, res, req.params.projectId, { db: client });
    if (!project) return null;
    if (!await assertStoredSite(req, res, project.site_id, client)) return null;
    const { rows: lockedRows } = await client.query(
      `SELECT * FROM rera_projects
        WHERE id=$1 AND organization_id=$2 AND site_id=$3 AND deleted_at IS NULL
        LIMIT 1 FOR UPDATE`,
      [project.id, req.user.organization_id, project.site_id],
    );
    const locked = lockedRows[0];
    if (!locked) throw new ReraHttpError(404, 'RERA_PROJECT_NOT_FOUND', 'RERA project not found');
    const raw = reviewedProjectSourcePayload(req, locked);
    const authoritative = {
      ...raw,
      site_id: locked.site_id,
      operating_profile_revision_id: locked.operating_profile_revision_id,
      ruleset_version_id: locked.ruleset_version_id,
    };
    const input = normalizeReraProjectInput(authoritative, locked);
    input.source_reviewed_by = raw.source_reviewed_by ?? null;
    input.source_reviewed_at = raw.source_reviewed_at ?? null;
    assertTransition(locked.regulatory_status, input.regulatory_status, 'Project');
    await enforceFieldPolicy(req, locked.site_id, 'rera_projects', req.body, input, locked, client);
    await assertAuthority(req.user.organization_id, input.authority_id, client);
    await assertTenantUser(req.user.organization_id, input.source_reviewed_by, client, 'source_reviewed_by');
    const row = await updateRow(
      client, 'rera_projects', PROJECT_COLUMNS, input,
      locked.id, req.user.organization_id, req.user.id,
    );
    if (!row) throw new ReraHttpError(409, 'RERA_PROJECT_CHANGED', 'RERA project changed while it was being updated');
    await writeComplianceAudit(client, req, {
      action: locked.regulatory_status !== row.regulatory_status
        ? 'RERA_PROJECT_STATUS_CHANGED'
        : (locked.source_review_status !== row.source_review_status
            || locked.source_review_notes !== row.source_review_notes
          ? 'RERA_PROJECT_SOURCE_REVIEW_CHANGED'
          : 'RERA_PROJECT_UPDATED'),
      entityType: 'RERA_PROJECT', entityId: row.id, siteId: row.site_id,
      previousValue: locked, newValue: row,
      reason: input.source_review_notes || input.status_reason || null,
    });
    return row;
  });
  if (!saved || res.headersSent) return;
  res.json({ project: publicProject(saved) });
});

/** POST /rera/projects/:projectId/phases */
export const createReraProjectPhase = endpoint(async (req, res) => {
  const saved = await inTransaction(async (client) => {
    const project = await getReraProject(req, res, req.params.projectId, { db: client });
    if (!project) return null;
    if (!await assertStoredSite(req, res, project.site_id, client)) return null;
    const suppliedProjectId = req.body.rera_project_id ?? req.body.project_id;
    if (suppliedProjectId && parsePositiveId(suppliedProjectId) !== Number(project.id)) {
      throw new ReraHttpError(409, 'PROJECT_CONTEXT_MISMATCH', 'Request project does not match the route project');
    }
    const authoritative = {
      ...req.body,
      site_id: project.site_id,
      rera_project_id: project.id,
      authority_id: req.body.authority_id ?? project.authority_id,
      authority_code: req.body.authority_code ?? project.authority_code,
      authority_name: req.body.authority_name ?? project.authority_name,
    };
    const input = normalizeReraPhaseInput(authoritative);
    await enforceFieldPolicy(req, project.site_id, 'rera_phases', req.body, input, {}, client);
    await assertAuthority(req.user.organization_id, input.authority_id, client);
    const row = await insertRow(
      client, 'rera_project_phases', PHASE_COLUMNS, input,
      req.user.organization_id, req.user.id,
    );
    await writeComplianceAudit(client, req, {
      action: 'RERA_PHASE_CREATED', entityType: 'RERA_PHASE', entityId: row.id,
      siteId: project.site_id, newValue: row, reason: input.status_reason || null,
    });
    return row;
  });
  if (!saved || res.headersSent) return;
  res.status(201).json({ phase: publicPhase(saved) });
});

/** PATCH /rera/phases/:phaseId */
export const updateReraProjectPhase = endpoint(async (req, res) => {
  const saved = await inTransaction(async (client) => {
    const phase = await getReraPhase(req, res, req.params.phaseId, { db: client });
    if (!phase) return null;
    if (!await assertStoredSite(req, res, phase.site_id, client)) return null;
    const { rows: lockedRows } = await client.query(
      `SELECT * FROM rera_project_phases
        WHERE id=$1 AND organization_id=$2 AND site_id=$3 AND deleted_at IS NULL
        LIMIT 1 FOR UPDATE`,
      [phase.id, req.user.organization_id, phase.site_id],
    );
    const locked = lockedRows[0];
    if (!locked) throw new ReraHttpError(404, 'RERA_PHASE_NOT_FOUND', 'RERA phase not found');
    const suppliedProjectId = req.body.rera_project_id ?? req.body.project_id;
    if (suppliedProjectId && parsePositiveId(suppliedProjectId) !== Number(locked.rera_project_id)) {
      throw new ReraHttpError(409, 'PROJECT_CONTEXT_MISMATCH', 'A phase cannot be moved to another RERA project');
    }
    const authoritative = {
      ...req.body,
      site_id: locked.site_id,
      rera_project_id: locked.rera_project_id,
    };
    const input = normalizeReraPhaseInput(authoritative, locked);
    assertTransition(locked.regulatory_status, input.regulatory_status, 'Phase');
    await enforceFieldPolicy(req, locked.site_id, 'rera_phases', req.body, input, locked, client);
    await assertAuthority(req.user.organization_id, input.authority_id, client);
    const row = await updateRow(
      client, 'rera_project_phases', PHASE_COLUMNS, input,
      locked.id, req.user.organization_id, req.user.id,
    );
    if (!row) throw new ReraHttpError(409, 'RERA_PHASE_CHANGED', 'RERA phase changed while it was being updated');
    await writeComplianceAudit(client, req, {
      action: locked.regulatory_status === row.regulatory_status
        ? 'RERA_PHASE_UPDATED' : 'RERA_PHASE_STATUS_CHANGED',
      entityType: 'RERA_PHASE', entityId: row.id, siteId: row.site_id,
      previousValue: locked, newValue: row, reason: input.status_reason || null,
    });
    return row;
  });
  if (!saved || res.headersSent) return;
  res.json({ phase: publicPhase(saved) });
});

function reviewedStakeholderPayload(req, fallback = {}) {
  const payload = { ...req.body };
  const previous = upper(fallback.record_review_status);
  const hasDecision = own(payload, 'record_review_status') || own(payload, 'review_status');
  const touchesNotes = own(payload, 'review_notes');
  // Actor and timestamp are always derived from the authenticated reviewer.
  payload.reviewed_by = fallback.reviewed_by ?? null;
  payload.reviewed_at = fallback.reviewed_at ?? null;
  if (!touchesNotes) payload.review_notes = fallback.review_notes ?? null;
  if (!hasDecision) {
    if (touchesNotes && ['REVIEWED', 'REJECTED'].includes(previous) && !isOrgAdmin(req.user)) {
      throw new ReraHttpError(403, 'RERA_REVIEW_ADMIN_REQUIRED', 'Only an administrator can change stakeholder review notes');
    }
    return payload;
  }
  const rawStatus = upper(payload.record_review_status ?? payload.review_status);
  const status = rawStatus === 'RETURNED' ? 'REJECTED' : rawStatus;
  const reviewSensitive = ['REVIEWED', 'REJECTED'].includes(status)
    || (['REVIEWED', 'REJECTED'].includes(previous) && status !== previous);
  if (reviewSensitive && !isOrgAdmin(req.user)) {
    throw new ReraHttpError(403, 'RERA_REVIEW_ADMIN_REQUIRED', 'Only an administrator can record or change a stakeholder review decision');
  }
  payload.record_review_status = status;
  if (['REVIEWED', 'REJECTED'].includes(status)) {
    payload.reviewed_by = req.user.id;
    payload.reviewed_at = new Date();
  } else if (status !== previous) {
    payload.reviewed_by = null;
    payload.reviewed_at = null;
  }
  return payload;
}

/** POST /rera/stakeholders */
export const createReraStakeholder = endpoint(async (req, res) => {
  const site = await getReraSite(req, res, req.body.site_id ?? req.siteContextId);
  if (!site) return;
  const raw = reviewedStakeholderPayload(req);
  const input = normalizeReraStakeholderInput(raw);
  await enforceFieldPolicy(req, site.id, 'rera_stakeholders', req.body, input);
  await assertTenantUser(req.user.organization_id, input.reviewed_by, pool, 'reviewed_by');
  const saved = await inTransaction(async (client) => {
    const row = await insertRow(
      client, 'rera_stakeholders', STAKEHOLDER_COLUMNS, input,
      req.user.organization_id, req.user.id,
    );
    await writeComplianceAudit(client, req, {
      action: 'RERA_STAKEHOLDER_CREATED', entityType: 'RERA_STAKEHOLDER', entityId: row.id,
      siteId: site.id, newValue: row, reason: input.review_notes || null,
    });
    return row;
  });
  res.status(201).json({ stakeholder: publicStakeholder(saved) });
});

async function scopedStakeholderForUpdate(req, res, db, lock = false) {
  const stakeholderId = parsePositiveId(req.params.stakeholderId);
  if (!stakeholderId) {
    res.status(400).json({ message: 'A valid stakeholder id is required' });
    return null;
  }
  const siteId = parsePositiveId(req.siteContextId);
  if (!siteId) {
    res.status(400).json({ code: 'SITE_CONTEXT_REQUIRED', message: 'Select a Site before updating a stakeholder' });
    return null;
  }
  const params = [stakeholderId, req.user.organization_id, siteId];
  let scope = '';
  if (!isOrgAdmin(req.user)) {
    params.push(req.user.id);
    scope = `AND (st.created_by=$4 OR EXISTS (
      SELECT 1 FROM rera_project_participants pp
      JOIN rera_projects p ON p.id=pp.rera_project_id AND p.organization_id=pp.organization_id
      WHERE pp.stakeholder_id=st.id AND pp.organization_id=st.organization_id
        AND p.site_id=$3 AND pp.deleted_at IS NULL AND p.deleted_at IS NULL
    ))`;
  }
  const { rows } = await db.query(
    `SELECT st.* FROM rera_stakeholders st
      WHERE st.id=$1 AND st.organization_id=$2 AND st.deleted_at IS NULL ${scope}
      LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
    params,
  );
  if (!rows[0]) res.status(404).json({ message: 'Stakeholder not found for the selected Site' });
  return rows[0] || null;
}

/** PATCH /rera/stakeholders/:stakeholderId */
export const updateReraStakeholder = endpoint(async (req, res) => {
  const site = await getReraSite(req, res, req.siteContextId ?? req.body.site_id);
  if (!site) return;
  const saved = await inTransaction(async (client) => {
    const stakeholder = await scopedStakeholderForUpdate(req, res, client, true);
    if (!stakeholder) return null;
    const raw = reviewedStakeholderPayload(req, stakeholder);
    const input = normalizeReraStakeholderInput(raw, stakeholder);
    await enforceFieldPolicy(req, site.id, 'rera_stakeholders', req.body, input, stakeholder, client);
    await assertTenantUser(req.user.organization_id, input.reviewed_by, client, 'reviewed_by');
    const row = await updateRow(
      client, 'rera_stakeholders', STAKEHOLDER_COLUMNS, input,
      stakeholder.id, req.user.organization_id, req.user.id,
    );
    await writeComplianceAudit(client, req, {
      action: stakeholder.record_review_status === row.record_review_status
          && stakeholder.review_notes === row.review_notes
        ? 'RERA_STAKEHOLDER_UPDATED' : 'RERA_STAKEHOLDER_REVIEW_CHANGED',
      entityType: 'RERA_STAKEHOLDER', entityId: row.id, siteId: site.id,
      previousValue: stakeholder, newValue: row, reason: input.review_notes || null,
    });
    return row;
  });
  if (!saved || res.headersSent) return;
  res.json({ stakeholder: publicStakeholder(saved) });
});

async function assertParticipantStakeholder(req, siteId, stakeholderId, db) {
  const params = [stakeholderId, req.user.organization_id, siteId];
  let scope = '';
  if (!isOrgAdmin(req.user)) {
    params.push(req.user.id);
    scope = `AND (st.created_by=$4 OR EXISTS (
      SELECT 1 FROM rera_project_participants linked
      JOIN rera_projects linked_project
        ON linked_project.id=linked.rera_project_id
       AND linked_project.organization_id=linked.organization_id
      WHERE linked.stakeholder_id=st.id AND linked.organization_id=st.organization_id
        AND linked_project.site_id=$3 AND linked.deleted_at IS NULL
        AND linked_project.deleted_at IS NULL
    ))`;
  }
  const { rows } = await db.query(
    `SELECT st.* FROM rera_stakeholders st
      WHERE st.id=$1 AND st.organization_id=$2 AND st.deleted_at IS NULL ${scope} LIMIT 1`,
    params,
  );
  if (!rows[0]) throw new ReraHttpError(400, 'STAKEHOLDER_NOT_AVAILABLE', 'Stakeholder is not available for the selected Site');
  return rows[0];
}

async function assertProjectPhase(organizationId, siteId, projectId, phaseId, db) {
  if (!phaseId) return null;
  const { rows } = await db.query(
    `SELECT * FROM rera_project_phases
      WHERE id=$1 AND organization_id=$2 AND site_id=$3 AND rera_project_id=$4
        AND deleted_at IS NULL LIMIT 1`,
    [phaseId, organizationId, siteId, projectId],
  );
  if (!rows[0]) throw new ReraHttpError(400, 'PHASE_PROJECT_MISMATCH', 'Selected phase does not belong to this RERA project');
  return rows[0];
}

/** POST /rera/projects/:projectId/participants */
export const createReraProjectParticipant = endpoint(async (req, res) => {
  const saved = await inTransaction(async (client) => {
    const project = await getReraProject(req, res, req.params.projectId, { db: client });
    if (!project) return null;
    if (!await assertStoredSite(req, res, project.site_id, client)) return null;
    const authoritative = { ...req.body, site_id: project.site_id, rera_project_id: project.id };
    const input = normalizeReraParticipantInput(authoritative);
    await enforceFieldPolicy(req, project.site_id, 'rera_participants', req.body, input, {}, client);
    await assertProjectPhase(
      req.user.organization_id, project.site_id, project.id,
      input.rera_project_phase_id, client,
    );
    await assertParticipantStakeholder(req, project.site_id, input.stakeholder_id, client);
    const row = await insertRow(
      client, 'rera_project_participants', PARTICIPANT_COLUMNS, input,
      req.user.organization_id, req.user.id, { updated: false },
    );
    await writeComplianceAudit(client, req, {
      action: 'RERA_PARTICIPANT_LINKED', entityType: 'RERA_PARTICIPANT', entityId: row.id,
      siteId: project.site_id, newValue: row, reason: input.basis_reference || null,
    });
    return row;
  });
  if (!saved || res.headersSent) return;
  const { rows } = await pool.query(
    `SELECT pp.*,st.*,
            pp.id AS id,pp.stakeholder_id AS stakeholder_id,
            st.registration_number AS stakeholder_registration_number,
            st.status AS stakeholder_status
       FROM rera_project_participants pp
       JOIN rera_stakeholders st
         ON st.id=pp.stakeholder_id AND st.organization_id=pp.organization_id
      WHERE pp.id=$1 AND pp.organization_id=$2 LIMIT 1`,
    [saved.id, req.user.organization_id],
  );
  res.status(201).json({ participant: publicParticipant(rows[0] || saved) });
});

/** DELETE /rera/participants/:participantId (recoverable unlink). */
export const deleteReraProjectParticipant = endpoint(async (req, res) => {
  const removed = await inTransaction(async (client) => {
    const participantId = parsePositiveId(req.params.participantId);
    if (!participantId) throw new ReraHttpError(400, 'INVALID_PARTICIPANT', 'A valid participant id is required');
    const params = [participantId, req.user.organization_id, req.siteContextId];
    let assignment = '';
    if (!isOrgAdmin(req.user)) {
      params.push(req.user.id);
      assignment = `AND EXISTS (
        SELECT 1 FROM user_sites us WHERE us.site_id=pp.site_id AND us.user_id=$4
      )`;
    }
    const { rows } = await client.query(
      `SELECT pp.* FROM rera_project_participants pp
        WHERE pp.id=$1 AND pp.organization_id=$2 AND pp.site_id=$3
          AND pp.deleted_at IS NULL ${assignment}
        LIMIT 1 FOR UPDATE`,
      params,
    );
    const previous = rows[0];
    if (!previous) throw new ReraHttpError(404, 'RERA_PARTICIPANT_NOT_FOUND', 'Project participant was not found');
    const { rows: updatedRows } = await client.query(
      `UPDATE rera_project_participants
          SET deleted_at=NOW(),effective_to=COALESCE(effective_to,CURRENT_DATE)
        WHERE id=$1 AND organization_id=$2 AND site_id=$3 AND deleted_at IS NULL
        RETURNING *`,
      [previous.id, req.user.organization_id, previous.site_id],
    );
    await writeComplianceAudit(client, req, {
      action: 'RERA_PARTICIPANT_UNLINKED', entityType: 'RERA_PARTICIPANT', entityId: previous.id,
      siteId: previous.site_id, previousValue: previous, newValue: updatedRows[0],
      reason: req.body?.reason || null,
    });
    return updatedRows[0];
  });
  res.json({ participant: publicParticipant(removed), unlinked: true });
});

const approvalReviewAlias = (value) => ({
  NOT_REVIEWED: 'PENDING', UNDER_REVIEW: 'PENDING', REVIEWED: 'ACCEPTED',
  VERIFIED: 'ACCEPTED', RETURNED: 'REJECTED',
}[upper(value)] || upper(value));

function reviewedApprovalPayload(req, fallback = {}) {
  const payload = { ...req.body };
  const previous = upper(fallback.rera_evidence_review_status);
  const decidedReviewStatuses = ['ACCEPTED', 'REJECTED', 'NOT_REQUIRED'];
  const touchesReviewNotes = own(payload, 'rera_review_notes') || own(payload, 'review_notes');
  // Ignore client-supplied actor/timestamp aliases. They are either inherited
  // from the locked row or replaced with the authenticated administrator.
  payload.rera_reviewed_by = fallback.rera_reviewed_by ?? null;
  payload.rera_reviewed_at = fallback.rera_reviewed_at ?? null;
  if (!touchesReviewNotes) payload.rera_review_notes = fallback.rera_review_notes ?? null;
  const hasReview = own(payload, 'review_status') || own(payload, 'rera_evidence_review_status');
  if (hasReview) {
    const status = approvalReviewAlias(payload.rera_evidence_review_status ?? payload.review_status);
    const reviewSensitive = decidedReviewStatuses.includes(status)
      || (decidedReviewStatuses.includes(previous) && status !== previous);
    if (reviewSensitive && !isOrgAdmin(req.user)) {
      throw new ReraHttpError(403, 'RERA_REVIEW_ADMIN_REQUIRED', 'Only an administrator can record or change an approval evidence review decision');
    }
    payload.rera_evidence_review_status = status;
    if (decidedReviewStatuses.includes(status)) {
      payload.rera_reviewed_by = req.user.id;
      payload.rera_reviewed_at = new Date();
    } else if (status !== previous) {
      payload.rera_reviewed_by = null;
      payload.rera_reviewed_at = null;
      payload.rera_review_notes = null;
    }
  } else if (touchesReviewNotes
      && (decidedReviewStatuses.includes(previous) || upper(fallback.rera_status) === 'NOT_APPLICABLE')
      && !isOrgAdmin(req.user)) {
    throw new ReraHttpError(403, 'RERA_REVIEW_ADMIN_REQUIRED', 'Only an administrator can change approval review notes');
  }
  const requestedStatus = upper(payload.rera_status ?? payload.status);
  if (requestedStatus === 'NOT_APPLICABLE') {
    if (!isOrgAdmin(req.user)) {
      throw new ReraHttpError(403, 'RERA_REVIEW_ADMIN_REQUIRED', 'Only an administrator can record an approval as not applicable');
    }
    payload.rera_reviewed_by = req.user.id;
    payload.rera_reviewed_at = new Date();
    payload.rera_review_notes = payload.rera_review_notes
      ?? payload.review_notes
      ?? payload.notes;
  }
  return payload;
}

async function validateApprovalReferences(req, input, project, db) {
  await assertAuthority(req.user.organization_id, input.authority_id, db);
  await assertTenantUser(req.user.organization_id, input.responsible_person_id, db, 'responsible_person_id');
  await assertTenantUser(req.user.organization_id, input.rera_reviewed_by, db, 'rera_reviewed_by');
  await assertProjectPhase(
    req.user.organization_id, project.site_id, project.id,
    input.rera_project_phase_id, db,
  );
  if (input.rera_ruleset_requirement_id) {
    const { rows } = await db.query(
      `SELECT rr.id FROM rera_ruleset_requirements rr
        WHERE rr.id=$1 AND rr.ruleset_version_id=$2 AND rr.is_active=TRUE LIMIT 1`,
      [input.rera_ruleset_requirement_id, project.ruleset_version_id],
    );
    if (!rows[0]) throw new ReraHttpError(400, 'REQUIREMENT_PROJECT_MISMATCH', 'Ruleset requirement does not belong to this project ruleset version');
  }
  if (input.compliance_item_id) {
    const { rows } = await db.query(
      `SELECT id FROM compliance_items
        WHERE id=$1 AND organization_id=$2 AND site_id=$3 AND rera_project_id=$4
          AND deleted_at IS NULL LIMIT 1`,
      [input.compliance_item_id, req.user.organization_id, project.site_id, project.id],
    );
    if (!rows[0]) throw new ReraHttpError(400, 'COMPLIANCE_ITEM_PROJECT_MISMATCH', 'Compliance item does not belong to this RERA project');
  }
}

/** POST /rera/approvals */
export const createReraApproval = endpoint(async (req, res) => {
  const saved = await inTransaction(async (client) => {
    const projectId = req.body.rera_project_id ?? req.body.project_id;
    const project = await getReraProject(req, res, projectId, { db: client });
    if (!project) return null;
    if (!await assertStoredSite(req, res, project.site_id, client)) return null;
    const raw = reviewedApprovalPayload(req);
    const authoritative = { ...raw, site_id: project.site_id, rera_project_id: project.id };
    const input = normalizeReraApprovalInput(authoritative);
    await enforceFieldPolicy(req, project.site_id, 'rera_approvals', req.body, input, {}, client);
    await validateApprovalReferences(req, input, project, client);
    const row = await insertRow(
      client, 'compliance_licences', APPROVAL_COLUMNS, input,
      req.user.organization_id, req.user.id,
    );
    await writeComplianceAudit(client, req, {
      action: 'RERA_APPROVAL_CREATED', entityType: 'RERA_APPROVAL', entityId: row.id,
      siteId: project.site_id, newValue: row, reason: input.rera_review_notes || input.notes || null,
    });
    return row;
  });
  if (!saved || res.headersSent) return;
  res.status(201).json({ approval: publicApproval(saved) });
});

/** PATCH /rera/approvals/:approvalId */
export const updateReraApproval = endpoint(async (req, res) => {
  const saved = await inTransaction(async (client) => {
    const approval = await getReraApproval(req, res, req.params.approvalId, { db: client });
    if (!approval) return null;
    if (!await assertStoredSite(req, res, approval.site_id, client)) return null;
    const { rows: lockedRows } = await client.query(
      `SELECT * FROM compliance_licences
        WHERE id=$1 AND organization_id=$2 AND site_id=$3
          AND rera_record_kind IS NOT NULL AND deleted_at IS NULL
        LIMIT 1 FOR UPDATE`,
      [approval.id, req.user.organization_id, approval.site_id],
    );
    const locked = lockedRows[0];
    if (!locked) throw new ReraHttpError(404, 'RERA_APPROVAL_NOT_FOUND', 'Approval record not found');
    const suppliedProjectId = req.body.rera_project_id ?? req.body.project_id;
    if (suppliedProjectId && parsePositiveId(suppliedProjectId) !== Number(locked.rera_project_id)) {
      throw new ReraHttpError(409, 'PROJECT_CONTEXT_MISMATCH', 'An approval cannot be moved to another RERA project');
    }
    const project = await getReraProject(req, res, locked.rera_project_id, { db: client });
    if (!project) return null;
    const raw = reviewedApprovalPayload(req, locked);
    const authoritative = {
      ...raw,
      site_id: locked.site_id,
      rera_project_id: locked.rera_project_id,
    };
    const input = normalizeReraApprovalInput(authoritative, locked);
    await enforceFieldPolicy(req, locked.site_id, 'rera_approvals', req.body, input, locked, client);
    await validateApprovalReferences(req, input, project, client);
    const row = await updateRow(
      client, 'compliance_licences', APPROVAL_COLUMNS, input,
      locked.id, req.user.organization_id, req.user.id,
      'AND rera_record_kind IS NOT NULL',
    );
    if (!row) throw new ReraHttpError(409, 'RERA_APPROVAL_CHANGED', 'Approval record changed while it was being updated');
    await writeComplianceAudit(client, req, {
      action: locked.rera_status !== row.rera_status
        ? 'RERA_APPROVAL_STATUS_CHANGED'
        : (locked.rera_evidence_review_status !== row.rera_evidence_review_status
            || locked.rera_review_notes !== row.rera_review_notes
          ? 'RERA_APPROVAL_EVIDENCE_REVIEW_CHANGED'
          : 'RERA_APPROVAL_UPDATED'),
      entityType: 'RERA_APPROVAL', entityId: row.id, siteId: row.site_id,
      previousValue: locked, newValue: row,
      reason: input.rera_review_notes || input.notes || null,
    });
    return row;
  });
  if (!saved || res.headersSent) return;
  res.json({ approval: publicApproval(saved) });
});
