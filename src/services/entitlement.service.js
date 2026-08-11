import pool from '../config/db.js';

export const PORTAL_FEATURE = Object.freeze({
  BUYER: 'buyer_portal',
  BROKER: 'broker_portal',
  PROFESSIONAL: 'professional_portal',
});

export async function resolveEntitlement(organizationId, featureKey, db = pool) {
  if (!organizationId || !featureKey) return { enabled: false, limit_value: null, source: 'NONE' };
  const { rows } = await db.query(
    `WITH active_plan AS (
       SELECT p.id
         FROM subscriptions s
         JOIN plans p ON p.id=s.plan_id
        WHERE s.organization_id=$1 AND s.status='active' AND s.current_period_end>NOW()
        ORDER BY s.current_period_end DESC,s.id DESC LIMIT 1
     ), base AS (
       SELECT pe.enabled,pe.limit_value,pe.configuration
         FROM active_plan ap
         JOIN plan_entitlements pe ON pe.plan_id=ap.id AND pe.feature_key=$2
     ), override AS (
       SELECT enabled,limit_value,configuration
         FROM organization_entitlement_overrides
        WHERE organization_id=$1 AND feature_key=$2
          AND effective_from<=NOW() AND (effective_to IS NULL OR effective_to>NOW())
     )
     SELECT COALESCE(o.enabled,b.enabled,FALSE) AS enabled,
            CASE WHEN o.enabled IS NOT NULL THEN o.limit_value ELSE b.limit_value END AS limit_value,
            COALESCE(o.configuration,b.configuration,'{}'::jsonb) AS configuration,
            CASE WHEN o.enabled IS NOT NULL THEN 'OVERRIDE' WHEN b.enabled IS NOT NULL THEN 'PLAN' ELSE 'NONE' END AS source
       FROM (SELECT 1) seed LEFT JOIN base b ON TRUE LEFT JOIN override o ON TRUE`,
    [organizationId, featureKey],
  );
  return rows[0] || { enabled: false, limit_value: null, configuration: {}, source: 'NONE' };
}

export const requireEntitlement = (featureKey) => async (req, res, next) => {
  try {
    const entitlement = await resolveEntitlement(req.user?.organization_id, featureKey);
    if (!entitlement.enabled) {
      return res.status(403).json({
        code: 'FEATURE_NOT_ENTITLED',
        feature: featureKey,
        message: 'This capability is not enabled for the organization plan',
      });
    }
    req.entitlement = entitlement;
    return next();
  } catch (error) {
    return next(error);
  }
};

export async function assertPortalSeatAvailable({ organizationId, portalType, db = pool }) {
  const featureKey = PORTAL_FEATURE[portalType];
  const entitlement = await resolveEntitlement(organizationId, featureKey, db);
  if (!entitlement.enabled) {
    const error = new Error('Portal capability is not enabled for the organization plan');
    error.status = 403;
    error.code = 'FEATURE_NOT_ENTITLED';
    throw error;
  }
  if (entitlement.limit_value === null) return entitlement;
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS used
       FROM portal_memberships
      WHERE organization_id=$1 AND portal_type=$2
        AND status IN ('PENDING','ACTIVE','SUSPENDED')
        AND effective_from<=NOW() AND (effective_to IS NULL OR effective_to>NOW())`,
    [organizationId, portalType],
  );
  if (rows[0].used >= entitlement.limit_value) {
    const error = new Error(`The ${portalType.toLowerCase()} portal seat limit has been reached`);
    error.status = 409;
    error.code = 'ENTITLEMENT_LIMIT_REACHED';
    throw error;
  }
  return { ...entitlement, used: rows[0].used };
}

