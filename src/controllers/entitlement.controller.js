import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';

export const listOrganizationEntitlements = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `WITH active_plan AS (
       SELECT p.id,p.code,p.name FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE s.organization_id=$1 AND s.status='active' AND s.current_period_end>NOW()
        ORDER BY s.current_period_end DESC,s.id DESC LIMIT 1
     )
     SELECT pf.feature_key,pf.category,pf.display_name,pf.description,
            COALESCE(override.enabled,base.enabled,FALSE) AS enabled,
            CASE WHEN override.enabled IS NOT NULL THEN override.limit_value ELSE base.limit_value END AS limit_value,
            COALESCE(override.configuration,base.configuration,'{}'::jsonb) AS configuration,
            CASE WHEN override.enabled IS NOT NULL THEN 'OVERRIDE' WHEN base.enabled IS NOT NULL THEN 'PLAN' ELSE 'NONE' END AS source,
            ap.code AS plan_code,ap.name AS plan_name
       FROM product_features pf CROSS JOIN active_plan ap
       LEFT JOIN plan_entitlements base ON base.plan_id=ap.id AND base.feature_key=pf.feature_key
       LEFT JOIN organization_entitlement_overrides override
         ON override.organization_id=$1 AND override.feature_key=pf.feature_key
        AND override.effective_from<=NOW() AND (override.effective_to IS NULL OR override.effective_to>NOW())
      ORDER BY pf.category,pf.display_name`,
    [req.user.organization_id],
  );
  res.json({ entitlements: rows });
});

