import pool from '../config/db.js';
import { evaluateCollectionPolicy, money, positiveId } from './propertyLifecycle.service.js';

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const merge = (base, override) => {
  const output = isObject(base) ? structuredClone(base) : {};
  if (!isObject(override)) return output;
  for (const [key, value] of Object.entries(override)) {
    output[key] = isObject(value) ? merge(output[key], value) : structuredClone(value);
  }
  return output;
};

/** Resolve the pinned Site ruleset and evaluate a proposed receipt. Empty or
 * unreviewed workflow JSON never creates a legal block. */
export async function resolveCollectionGuard({
  organizationId,
  siteId,
  bookingId,
  proposedAmount,
  db = pool,
}) {
  const orgId = positiveId(organizationId, 'organization_id');
  const resolvedSiteId = positiveId(siteId, 'site_id');
  const amount = money(proposedAmount, 'Amount', { required: true, allowZero: false });
  if (!bookingId) {
    return evaluateCollectionPolicy({ proposedAmount: amount });
  }
  const resolvedBookingId = positiveId(bookingId, 'booking_id');
  const { rows } = await db.query(
    `SELECT b.id,b.site_id,b.agreement_status,b.final_consideration,
            rv.id AS ruleset_version_id,rv.version,rv.version_label,
            rv.source_review_status,rv.workflow_policy,r.code,
            COALESCE(pinned_profile.workflow_policy_overrides,current_profile.workflow_policy_overrides,'{}'::jsonb) AS workflow_policy_overrides,
            COALESCE(receipts.received,0) AS current_received
       FROM bookings b
       JOIN sites s ON s.id=b.site_id AND s.organization_id=$1
       LEFT JOIN site_operating_profile_revisions pinned_profile
         ON pinned_profile.id=b.operating_profile_revision_id
        AND pinned_profile.organization_id=b.organization_id AND pinned_profile.site_id=b.site_id
        AND pinned_profile.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT p.ruleset_version_id,p.workflow_policy_overrides
           FROM site_operating_profile_revisions p
          WHERE p.organization_id=$1 AND p.site_id=b.site_id
            AND p.lifecycle_status='PUBLISHED' AND p.effective_to IS NULL AND p.deleted_at IS NULL
          ORDER BY p.revision_number DESC,p.id DESC LIMIT 1
       ) current_profile ON TRUE
       LEFT JOIN rera_ruleset_versions rv ON rv.id=COALESCE(
         b.ruleset_version_id,pinned_profile.ruleset_version_id,current_profile.ruleset_version_id
       )
         AND rv.lifecycle_status IN ('PUBLISHED','SUPERSEDED') AND rv.deleted_at IS NULL
       LEFT JOIN rera_rulesets r ON r.id=rv.ruleset_id AND r.is_active=TRUE AND r.deleted_at IS NULL
         AND (r.organization_id IS NULL OR r.organization_id=$1)
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(pp.amount),0) AS received
           FROM plot_payments pp
          WHERE pp.booking_id=b.id
            AND LOWER(COALESCE(pp.status,'approved'))='approved'
            AND UPPER(COALESCE(pp.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
            AND pp.reversal_of_payment_id IS NULL
       ) receipts ON TRUE
      WHERE b.id=$2 AND b.site_id=$3 AND b.organization_id=$1
      LIMIT 1`,
    [orgId, resolvedBookingId, resolvedSiteId],
  );
  const booking = rows[0];
  if (!booking) {
    const error = new Error('Booking not found for the selected Site');
    error.statusCode = 404;
    throw error;
  }
  const workflowPolicy = merge(booking.workflow_policy, booking.workflow_policy_overrides);
  return evaluateCollectionPolicy({
    workflowPolicy,
    ruleset: booking.ruleset_version_id ? {
      id: booking.ruleset_version_id,
      code: booking.code,
      version: booking.version,
      version_label: booking.version_label,
      source_review_status: booking.source_review_status,
    } : null,
    agreementStatus: booking.agreement_status,
    currentQualifyingCollection: booking.current_received,
    proposedAmount: amount,
    finalConsideration: booking.final_consideration,
  });
}
