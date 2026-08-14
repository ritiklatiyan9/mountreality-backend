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

/** Resolve the published operating model and pinned Site ruleset, then evaluate
 * a proposed receipt. Unreviewed ruleset JSON cannot create an extra block. */
export async function resolveCollectionGuard({
  organizationId,
  siteId,
  bookingId,
  proposedAmount,
  excludePlotPaymentId = null,
  excludeInstallmentPaymentId = null,
  db = pool,
}) {
  const orgId = positiveId(organizationId, 'organization_id');
  const resolvedSiteId = positiveId(siteId, 'site_id');
  const amount = money(proposedAmount, 'Amount', { required: true, allowZero: false });
  if (!bookingId) {
    const { rows: profileRows } = await db.query(
      `SELECT p.operating_model
         FROM site_operating_profile_revisions p
        WHERE p.organization_id=$1 AND p.site_id=$2
          AND p.lifecycle_status='PUBLISHED' AND p.effective_to IS NULL
          AND p.deleted_at IS NULL
        ORDER BY p.revision_number DESC,p.id DESC
        LIMIT 1`,
      [orgId, resolvedSiteId],
    );
    const operatingModel = profileRows[0]?.operating_model || null;
    if (['RERA_PROJECT_PROMOTER', 'RERA_ONGOING_PROJECT_REGULARISATION'].includes(String(operatingModel || '').toUpperCase())) {
      return {
        ...evaluateCollectionPolicy({ operatingModel, proposedAmount: amount }),
        decision: 'BLOCKED',
        code: 'RERA_BOOKING_REQUIRED_FOR_COLLECTION',
        message: 'Select a confirmed booking before recording a RERA customer collection',
        rule: 'RERA_2016_SECTION_13',
      };
    }
    return evaluateCollectionPolicy({ operatingModel, proposedAmount: amount });
  }
  const resolvedBookingId = positiveId(bookingId, 'booking_id');
  const excludedPaymentId = positiveId(excludePlotPaymentId, 'exclude_plot_payment_id', { optional: true });
  const excludedInstallmentPaymentId = positiveId(
    excludeInstallmentPaymentId,
    'exclude_installment_payment_id',
    { optional: true },
  );
  const { rows } = await db.query(
    `SELECT b.id,b.site_id,COALESCE(active_agreement.status,b.agreement_status) AS agreement_status,
            active_agreement.registration_status AS agreement_registration_status,
            active_agreement.registration_number AS agreement_registration_number,
            active_agreement.registration_date AS agreement_registration_date,
            b.final_consideration,
            rv.id AS ruleset_version_id,rv.version,rv.version_label,
            rv.source_review_status,rv.workflow_policy,r.code,
            COALESCE(current_profile.operating_model,pinned_profile.operating_model) AS operating_model,
            COALESCE(pinned_profile.workflow_policy_overrides,current_profile.workflow_policy_overrides,'{}'::jsonb) AS workflow_policy_overrides,
            COALESCE(receipts.received,0) AS current_received
       FROM bookings b
       JOIN sites s ON s.id=b.site_id AND s.organization_id=$1
       LEFT JOIN site_operating_profile_revisions pinned_profile
         ON pinned_profile.id=b.operating_profile_revision_id
        AND pinned_profile.organization_id=b.organization_id AND pinned_profile.site_id=b.site_id
        AND pinned_profile.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT p.ruleset_version_id,p.workflow_policy_overrides,p.operating_model
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
         SELECT ba.status,ba.registration_status,ba.registration_number,ba.registration_date
           FROM booking_agreements ba
          WHERE ba.booking_id=b.id AND ba.site_id=b.site_id
            AND ba.status NOT IN ('SUPERSEDED','CANCELLED')
          ORDER BY ba.version_number DESC,ba.id DESC LIMIT 1
       ) active_agreement ON TRUE
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(receipt.amount),0) AS received
           FROM (
             SELECT pp.amount
               FROM plot_payments pp
              WHERE pp.booking_id=b.id
                AND ($4::int IS NULL OR pp.id<>$4)
                AND LOWER(COALESCE(pp.status,'approved')) NOT IN ('rejected','cancelled','void')
                AND UPPER(COALESCE(pp.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
                AND pp.reversal_of_payment_id IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM plot_payments reversal
                   WHERE reversal.reversal_of_payment_id=pp.id
                     AND LOWER(COALESCE(reversal.status,'approved')) NOT IN ('rejected','cancelled','void')
                )
             UNION ALL
             SELECT pip.amount
              FROM plot_installment_payments pip
               JOIN plot_installments pi ON pi.id=pip.installment_id
              WHERE pi.booking_id=b.id
                AND ($5::int IS NULL OR pip.id<>$5)
                AND UPPER(COALESCE(pip.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
           ) receipt
       ) receipts ON TRUE
      WHERE b.id=$2 AND b.site_id=$3 AND b.organization_id=$1
      LIMIT 1`,
    [orgId, resolvedBookingId, resolvedSiteId, excludedPaymentId, excludedInstallmentPaymentId],
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
    operatingModel: booking.operating_model,
    agreementStatus: booking.agreement_status,
    agreementRegistrationStatus: booking.agreement_registration_status,
    agreementRegistrationNumber: booking.agreement_registration_number,
    agreementRegistrationDate: booking.agreement_registration_date,
    currentQualifyingCollection: booking.current_received,
    proposedAmount: amount,
    finalConsideration: booking.final_consideration,
  });
}
