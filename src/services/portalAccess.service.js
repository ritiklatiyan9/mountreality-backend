import pool from '../config/db.js';
import { PORTAL_FEATURE, resolveEntitlement } from './entitlement.service.js';
import {
  assertClientPortalAvailable,
  CLIENT_PORTAL_SETTING_KEY,
  normalizeClientPortalConfiguration,
} from './portalConfiguration.service.js';

const PORTAL_TYPES = new Set(['BUYER', 'BROKER', 'PROFESSIONAL']);
const positiveId = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

export async function listPortalMemberships(userId, organizationId, db = pool) {
  const { rows } = await db.query(
    `SELECT pm.id,pm.portal_type,pm.organization_id,pm.site_id,pm.rera_project_id,
            pm.rera_project_phase_id,pm.domain_entity_type,pm.domain_entity_id,
            pm.permission_policy,pm.status,pm.effective_from,pm.effective_to,
            s.name AS site_name,rp.name AS project_name,rpp.name AS phase_name,
            aps.setting_value AS portal_configuration,
            CASE WHEN pm.domain_entity_type='MEMBER' THEN m.full_name ELSE rs.legal_name END AS identity_name
       FROM portal_memberships pm
       LEFT JOIN sites s ON s.id=pm.site_id
       LEFT JOIN application_settings aps ON aps.site_id=pm.site_id AND aps.setting_key=$3
       LEFT JOIN rera_projects rp ON rp.id=pm.rera_project_id AND rp.organization_id=pm.organization_id
       LEFT JOIN rera_project_phases rpp ON rpp.id=pm.rera_project_phase_id AND rpp.organization_id=pm.organization_id
       LEFT JOIN members m ON pm.domain_entity_type='MEMBER' AND m.id=pm.domain_entity_id AND m.site_id=pm.site_id
       LEFT JOIN rera_stakeholders rs ON pm.domain_entity_type='RERA_STAKEHOLDER' AND rs.id=pm.domain_entity_id AND rs.organization_id=pm.organization_id
      WHERE pm.user_id=$1 AND pm.organization_id=$2
        AND pm.status='ACTIVE' AND pm.effective_from<=NOW()
        AND (pm.effective_to IS NULL OR pm.effective_to>NOW())
      ORDER BY pm.portal_type,pm.created_at,pm.id`,
    [userId, organizationId, CLIENT_PORTAL_SETTING_KEY],
  );
  return rows.map((row) => ({
    ...row,
    portal_configuration: row.portal_type === 'BUYER'
      ? normalizeClientPortalConfiguration(row.portal_configuration)
      : null,
  }));
}

export const requirePortalMembership = (expectedType = null) => async (req, res, next) => {
  try {
    const requestedType = expectedType ? String(expectedType).toUpperCase() : null;
    if (requestedType && !PORTAL_TYPES.has(requestedType)) {
      return res.status(500).json({ message: 'Portal route is misconfigured' });
    }
    const rawMembershipId = req.header('X-Portal-Membership-ID') || req.params.membershipId || req.query.membership_id;
    const membershipId = positiveId(rawMembershipId);
    if (!membershipId) {
      return res.status(400).json({ code: 'PORTAL_MEMBERSHIP_REQUIRED', message: 'Select a portal membership' });
    }
    const { rows } = await pool.query(
      `SELECT pm.*,aps.setting_value AS portal_configuration
         FROM portal_memberships pm
         LEFT JOIN application_settings aps ON aps.site_id=pm.site_id AND aps.setting_key=$5
        WHERE pm.id=$1 AND pm.user_id=$2 AND pm.organization_id=$3
          AND pm.status='ACTIVE' AND pm.effective_from<=NOW()
          AND (pm.effective_to IS NULL OR pm.effective_to>NOW())
          AND ($4::text IS NULL OR pm.portal_type=$4)
        LIMIT 1`,
      [membershipId, req.user.id, req.user.organization_id, requestedType, CLIENT_PORTAL_SETTING_KEY],
    );
    if (!rows[0]) return res.status(403).json({ code: 'PORTAL_SCOPE_DENIED', message: 'Portal membership is unavailable' });

    if (req.siteContextId && Number(rows[0].site_id) !== Number(req.siteContextId)) {
      return res.status(403).json({ code: 'PORTAL_SITE_CONTEXT_MISMATCH', message: 'Portal membership does not match the selected Site' });
    }

    const portalConfiguration = normalizeClientPortalConfiguration(rows[0].portal_configuration);
    try {
      assertClientPortalAvailable(rows[0], portalConfiguration);
    } catch (error) {
      return res.status(error.status || 403).json({ code: error.code, message: error.message });
    }

    const entitlement = await resolveEntitlement(req.user.organization_id, PORTAL_FEATURE[rows[0].portal_type]);
    if (!entitlement.enabled) {
      return res.status(403).json({
        code: 'FEATURE_NOT_ENTITLED',
        feature: PORTAL_FEATURE[rows[0].portal_type],
        message: 'This portal is not enabled for the organization plan',
      });
    }
    req.portalMembership = { ...rows[0], portal_configuration: portalConfiguration };
    req.portalConfiguration = portalConfiguration;
    req.entitlement = entitlement;
    return next();
  } catch (error) {
    return next(error);
  }
};

export const permissionAllows = (membership, action, fallback = false) => {
  const policy = membership?.permission_policy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return fallback;
  const actions = Array.isArray(policy.actions) ? policy.actions : [];
  if (actions.includes('*') || actions.includes(action)) return true;
  return policy[action] === true;
};

export function assertPortalAction(membership, action, fallback = false) {
  if (permissionAllows(membership, action, fallback)) return;
  const error = new Error('This portal membership does not allow that action');
  error.status = 403;
  error.code = 'PORTAL_ACTION_DENIED';
  throw error;
}

export const serializeBuyerBooking = (row) => ({
  booking_id: row.booking_id,
  booking_reference: row.booking_reference,
  booking_status: row.booking_status,
  booked_at: row.booked_at,
  property: {
    id: row.plot_id,
    number: row.plot_no,
    size: row.plot_size,
    rate: row.plot_rate,
    status: row.plot_status,
  },
  project: row.rera_project_id ? {
    id: row.rera_project_id,
    name: row.project_name,
    registration_number: row.registration_number,
    phase_id: row.rera_project_phase_id,
    phase_name: row.phase_name,
  } : null,
  commercial: {
    agreed_value: row.agreed_value,
    amount_received: row.amount_received,
    amount_due: row.amount_due,
  },
  lifecycle: {
    agreement_status: row.agreement_status,
    registry_status: row.registry_status,
    possession_status: row.possession_status,
  },
});

const BROKER_RELEASE_FIELD = new Set([
  'plot_no', 'plot_size', 'plot_rate', 'status', 'plot_tag', 'commission_rate',
]);
export const serializeReleasedInventory = (row) => {
  const allowed = Array.isArray(row.released_fields)
    ? row.released_fields.filter((field) => BROKER_RELEASE_FIELD.has(field))
    : [];
  const source = {
    plot_no: row.plot_no,
    plot_size: row.plot_size,
    plot_rate: row.plot_rate,
    status: row.plot_status,
    plot_tag: row.plot_tag,
    commission_rate: row.commission_rate,
  };
  return {
    release_id: row.release_id,
    plot_id: row.plot_id,
    ...Object.fromEntries(allowed.map((field) => [field, source[field]])),
    released_at: row.released_at,
  };
};

export const serializeProfessionalCertification = (row, membership) => {
  const canViewFinance = permissionAllows(membership, 'view_finance', false);
  return {
    id: row.id,
    project_id: row.rera_project_id,
    phase_id: row.rera_project_phase_id,
    work_package_id: row.work_package_id,
    period_start: row.certification_period_start,
    period_end: row.certification_period_end,
    operational_progress_pct: row.operational_progress_pct,
    proposed_certified_progress_pct: row.proposed_certified_progress_pct,
    certified_progress_pct: row.certified_progress_pct,
    professional_type: row.professional_type,
    certification_date: row.certification_date,
    status: row.status,
    exceptions: row.exceptions,
    review_notes: row.review_notes,
    operational_progress_snapshot: row.operational_progress_snapshot,
    input_data_references: row.input_data_references,
    ...(canViewFinance ? { cost_snapshot: row.cost_snapshot } : {}),
  };
};

export async function writePortalAudit({ organizationId, siteId = null, userId, action, entityType, entityId = null, previousValue = null, newValue = null, reason = null, ipAddress = null }, db = pool) {
  await db.query(
    `INSERT INTO compliance_audit_log
      (organization_id,site_id,user_id,action,entity_type,entity_id,previous_value,new_value,reason,ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [organizationId, siteId, userId, action, entityType, entityId, previousValue, newValue, reason, ipAddress],
  );
}
