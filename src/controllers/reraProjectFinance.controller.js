import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { writeComplianceAudit } from '../utils/complianceAccess.js';
import {
  cleanText, isoDate, money, positiveId,
} from '../services/propertyLifecycle.service.js';
import {
  isEligibleReraBankEntry,
  projectPhaseRequired,
  reraFinanceRequestFingerprint,
} from '../services/reraProjectFinancePolicy.service.js';

const RERA_OPERATING_MODELS = new Set([
  'RERA_PROJECT_PROMOTER',
  'RERA_ONGOING_PROJECT_REGULARISATION',
]);
const DESIGNATED_ACCOUNT_PURPOSES = new Set([
  'RERA_SEPARATE_ACCOUNT',
  'SEPARATE_ACCOUNT',
  'DESIGNATED_COLLECTION_ACCOUNT',
]);

const businessError = (message, code, statusCode = 409, details = null) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
};

const requireAdmin = (req) => {
  if (!['admin', 'super_admin'].includes(req.user?.role)) {
    throw businessError('Administrator review is required for this action', 'ADMIN_REVIEW_REQUIRED', 403);
  }
};

const siteIdFrom = (req) => positiveId(
  req.propertyLifecycleSiteId || req.siteContextId || req.body?.site_id || req.query?.site_id,
  'site_id',
);

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    if (!error.statusCode && error.code === '23505') {
      error.statusCode = 409;
      error.code = 'RERA_FINANCE_DUPLICATE';
      error.message = 'This evidence or bank transaction is already linked. Refresh the project view.';
    } else if (!error.statusCode && error.code === '23514') {
      const safeMessage = /RERA|separate.account|withdrawal|deposit|designated project account/i.test(error.message || '')
        ? error.message
        : 'The RERA finance control no longer passes its project or evidence checks. Refresh and try again.';
      error.statusCode = 409;
      error.code = 'RERA_FINANCE_INVARIANT';
      error.message = safeMessage;
    } else if (!error.statusCode && error.code === '23503') {
      error.statusCode = 409;
      error.code = 'RERA_FINANCE_REFERENCE_CONFLICT';
      error.message = 'A linked project, account, receipt, transaction, or document is no longer available.';
    }
    throw error;
  } finally {
    client.release();
  }
}

const jsonValue = (value) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
);

const atPath = (value, path) => path.reduce(
  (current, key) => (current && typeof current === 'object' ? current[key] : undefined),
  value,
);

const percentageFromPolicy = (profile) => {
  const override = jsonValue(profile?.workflow_policy_overrides);
  const ruleset = jsonValue(profile?.workflow_policy);
  const paths = [
    ['rera_finance', 'minimum_separate_account_percentage'],
    ['rera_finance', 'separate_account_percentage'],
    ['fund_controls', 'minimum_separate_account_percentage'],
    ['fund_controls', 'separate_account_percentage'],
    ['collections', 'separate_account_percentage'],
  ];
  for (const [policy, source] of [[override, 'OPERATING_PROFILE_OVERRIDE'], [ruleset, 'RULESET']]) {
    for (const path of paths) {
      const configured = Number(atPath(policy, path));
      // Central RERA provides the baseline. A reviewed ruleset/profile may
      // raise it for the applicable State; it cannot silently lower it.
      if (Number.isFinite(configured) && configured >= 70 && configured <= 100) {
        return { percentage: configured, source };
      }
    }
  }
  return { percentage: 70, source: 'CENTRAL_RERA_BASELINE' };
};

async function getReraPolicy(db, req, siteId, { required = false } = {}) {
  const { rows } = await db.query(
    `SELECT p.id,p.operating_model,p.finance_payment_mode,p.workflow_policy_overrides,
            p.ruleset_version_id,rv.workflow_policy,rv.source_review_status,
            rv.version_label,r.code AS ruleset_code
       FROM site_operating_profile_revisions p
       LEFT JOIN rera_ruleset_versions rv
         ON rv.id=p.ruleset_version_id AND rv.deleted_at IS NULL
       LEFT JOIN rera_rulesets r
         ON r.id=rv.ruleset_id AND r.deleted_at IS NULL AND r.is_active=TRUE
      WHERE p.organization_id=$1 AND p.site_id=$2
        AND p.lifecycle_status='PUBLISHED' AND p.effective_to IS NULL AND p.deleted_at IS NULL
      ORDER BY p.revision_number DESC,p.id DESC LIMIT 1`,
    [req.user.organization_id, siteId],
  );
  const profile = rows[0] || null;
  const applicable = RERA_OPERATING_MODELS.has(String(profile?.operating_model || '').toUpperCase());
  if (required && !applicable) {
    throw businessError(
      'RERA fund controls are available only when this Site has a published RERA operating profile',
      'RERA_FINANCE_NOT_APPLICABLE',
      409,
    );
  }
  const threshold = applicable ? percentageFromPolicy(profile) : { percentage: null, source: null };
  return {
    applicable,
    operating_model: profile?.operating_model || null,
    finance_payment_mode: profile?.finance_payment_mode || 'ALL_MODES',
    minimum_separate_account_percentage: threshold.percentage,
    percentage_source: threshold.source,
    ruleset_version_id: profile?.ruleset_version_id || null,
    ruleset_code: profile?.ruleset_code || null,
    ruleset_version: profile?.version_label || null,
    ruleset_review_status: profile?.source_review_status || null,
  };
}

async function assertProjectScope(db, req, siteId, projectId, phaseId) {
  const { rows } = await db.query(
    `SELECT rp.id,rp.name,rp.registration_number,rp.regulatory_status,
            ph.id AS phase_id,ph.name AS phase_name,
            EXISTS (
              SELECT 1 FROM rera_project_phases project_phase
               WHERE project_phase.rera_project_id=rp.id
                 AND project_phase.organization_id=rp.organization_id
                 AND project_phase.site_id=rp.site_id
                 AND project_phase.deleted_at IS NULL
            ) AS has_phases
       FROM rera_projects rp
       LEFT JOIN rera_project_phases ph
         ON ph.id=$4 AND ph.rera_project_id=rp.id AND ph.organization_id=rp.organization_id
        AND ph.site_id=rp.site_id AND ph.deleted_at IS NULL
      WHERE rp.id=$1 AND rp.site_id=$2 AND rp.organization_id=$3 AND rp.deleted_at IS NULL
        AND ($4::bigint IS NULL OR ph.id IS NOT NULL)
      LIMIT 1`,
    [projectId, siteId, req.user.organization_id, phaseId],
  );
  if (!rows[0]) {
    throw businessError('Project or phase is outside the selected Site', 'RERA_PROJECT_SCOPE_MISMATCH', 404);
  }
  return rows[0];
}

async function getDesignatedMapping(
  db,
  req,
  siteId,
  mappingId,
  projectId,
  phaseId,
  effectiveDate,
  { lock = false } = {},
) {
  const { rows } = await db.query(
    `SELECT pam.*,f.name AS firm_name,f.bank_name,f.account_number
       FROM project_account_mappings pam
       JOIN firms f ON f.id=pam.firm_id AND f.site_id=pam.site_id
      WHERE pam.id=$1 AND pam.site_id=$2 AND pam.organization_id=$3
        AND pam.rera_project_id=$4
        AND (pam.rera_project_phase_id IS NULL OR pam.rera_project_phase_id IS NOT DISTINCT FROM $5::bigint)
        AND pam.review_status='REVIEWED'
        AND pam.effective_from<=$6::date
        AND (pam.effective_to IS NULL OR pam.effective_to>=$6::date)
      ${lock ? 'FOR UPDATE OF pam' : ''}`,
    [mappingId, siteId, req.user.organization_id, projectId, phaseId, effectiveDate],
  );
  const mapping = rows[0];
  if (!mapping || !DESIGNATED_ACCOUNT_PURPOSES.has(String(mapping.purpose || '').toUpperCase())) {
    throw businessError(
      'Select a reviewed RERA separate-account mapping for this project and phase',
      'RERA_DESIGNATED_ACCOUNT_REQUIRED',
    );
  }
  if (!mapping.bank_name || !mapping.account_number || !mapping.evidence_document_id) {
    throw businessError(
      'The RERA separate account needs bank details and reviewed account evidence',
      'RERA_DESIGNATED_ACCOUNT_EVIDENCE_REQUIRED',
    );
  }
  return mapping;
}

const sameMoney = (left, right) => (
  Math.round(Number(left || 0) * 100) === Math.round(Number(right || 0) * 100)
);

const replayMatchesLegacyDeposit = (row, request) => (
  Number(row.rera_project_id) === Number(request.projectId)
  && Number(row.plot_payment_id) === Number(request.paymentId)
  && Number(row.project_account_mapping_id) === Number(request.mappingId)
  && Number(row.firm_transaction_id || 0) === Number(request.bankTransactionId || 0)
  && Number(row.evidence_document_id || 0) === Number(request.evidenceDocumentId || 0)
  && sameMoney(row.amount, request.amount)
  && String(row.deposit_date).slice(0, 10) === request.depositDate
  && String(row.deposit_reference || '') === String(request.reference || '')
);

const replayMatchesLegacyWithdrawal = (row, request) => (
  Number(row.rera_project_id) === Number(request.projectId)
  && Number(row.rera_project_phase_id || 0) === Number(request.phaseId || 0)
  && Number(row.project_account_mapping_id) === Number(request.mappingId)
  && Number(row.firm_transaction_id || 0) === Number(request.bankTransactionId || 0)
  && sameMoney(row.amount, request.amount)
  && sameMoney(row.certified_eligible_amount, request.certifiedAmount)
  && Number(row.completion_percentage) === Number(request.completionPercentage)
  && String(row.requested_date).slice(0, 10) === request.requestedDate
  && String(row.purpose) === request.purpose
  && Number(row.engineer_document_id) === Number(request.engineerDocumentId)
  && Number(row.architect_document_id) === Number(request.architectDocumentId)
  && Number(row.ca_document_id) === Number(request.caDocumentId)
);

async function findIdempotentReplay(db, {
  table, req, siteId, key, fingerprint, legacyMatches,
}) {
  if (!key) return null;
  const { rows } = await db.query(
    `SELECT * FROM ${table}
      WHERE organization_id=$1 AND site_id=$2 AND idempotency_key=$3`,
    [req.user.organization_id, siteId, key],
  );
  const existing = rows[0];
  if (!existing) return null;
  const matches = existing.request_fingerprint
    ? existing.request_fingerprint === fingerprint
    : legacyMatches(existing);
  if (!matches) {
    throw businessError(
      'This idempotency key was already used for a different RERA finance request',
      'IDEMPOTENCY_KEY_REUSED',
      409,
    );
  }
  return existing;
}

async function assertDocuments(db, req, siteId, documentIds) {
  const ids = documentIds.map((value, index) => positiveId(value, `document_${index + 1}`));
  if (new Set(ids).size !== ids.length) {
    throw businessError('Engineer, architect and CA certificates must be separate documents', 'DISTINCT_CERTIFICATES_REQUIRED', 400);
  }
  const { rows } = await db.query(
    `SELECT id FROM documents
      WHERE id=ANY($1::int[]) AND site_id=$2 AND organization_id=$3`,
    [ids, siteId, req.user.organization_id],
  );
  if (rows.length !== ids.length) {
    throw businessError('One or more certificate documents are outside the selected Site', 'CERTIFICATE_SCOPE_MISMATCH');
  }
  return ids;
}

const idempotencyKey = (req) => {
  const value = String(req.get('Idempotency-Key') || req.body?.idempotency_key || '').trim();
  if (!value) return null;
  if (value.length > 120) throw businessError('Idempotency key is too long', 'INVALID_IDEMPOTENCY_KEY', 400);
  return value;
};

const lockReraProjectFinance = (db, req, siteId, projectId) => db.query(
  'SELECT pg_advisory_xact_lock(120120,hashtext($1))',
  [`${req.user.organization_id}:${siteId}:${projectId}`],
);

const validCollectionSql = `
  LOWER(COALESCE(pp.status,'approved'))='approved'
  AND UPPER(COALESCE(pp.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
  AND pp.reversal_of_payment_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM plot_payments reversal
     WHERE reversal.reversal_of_payment_id=pp.id
       AND LOWER(COALESCE(reversal.status,'approved'))='approved'
       AND UPPER(COALESCE(reversal.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
  )
`;

const validBankTransactionSql = `
  LOWER(COALESCE(ft.status,''))='approved'
  AND ledger_bucket(ft.payment_mode)<>'cash'
  AND UPPER(COALESCE(ft.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
`;

/** GET /property-lifecycle/project-finance/rera-compliance */
export const getReraProjectFinanceCompliance = asyncHandler(async (req, res) => {
  const siteId = siteIdFrom(req);
  const projectId = positiveId(req.query.project_id, 'project_id');
  const phaseId = positiveId(req.query.phase_id, 'phase_id', { optional: true });
  const policy = await getReraPolicy(pool, req, siteId);
  const project = await assertProjectScope(pool, req, siteId, projectId, phaseId);
  if (!policy.applicable) {
    return res.json({
      policy,
      project,
      reserve: null,
      withdrawals: null,
      designated_accounts: [],
      evidence_documents: [],
      eligible_collections: [],
      eligible_bank_credits: [],
      eligible_bank_debits: [],
      deposit_allocations: [],
      withdrawal_requests: [],
    });
  }

  const scope = [req.user.organization_id, siteId, projectId, phaseId];
  const [
    summaryResult,
    accountResult,
    evidenceResult,
    eligibleCollectionResult,
    eligibleCreditResult,
    eligibleDebitResult,
    depositResult,
    withdrawalResult,
  ] = await Promise.all([
    pool.query(
      `WITH collections AS (
         SELECT COALESCE(SUM(pp.amount),0)::numeric AS amount,COUNT(*)::int AS count
           FROM plot_payments pp
          WHERE pp.site_id=$2 AND pp.rera_project_id=$3
            AND ($4::bigint IS NULL OR pp.rera_project_phase_id=$4)
            AND ${validCollectionSql}
       ), deposits AS (
         SELECT COALESCE(SUM(deposit.amount) FILTER (WHERE deposit.status='VERIFIED'),0)::numeric AS verified,
                COALESCE(SUM(deposit.amount) FILTER (WHERE deposit.status='RECORDED'),0)::numeric AS pending,
                COUNT(*) FILTER (WHERE deposit.status='RECORDED')::int AS pending_count
           FROM rera_collection_deposit_allocations deposit
           JOIN plot_payments pp ON pp.id=deposit.plot_payment_id
           LEFT JOIN firm_transactions ft ON ft.id=deposit.firm_transaction_id
          WHERE deposit.organization_id=$1 AND deposit.site_id=$2 AND deposit.rera_project_id=$3
            AND ($4::bigint IS NULL OR deposit.rera_project_phase_id=$4)
            AND ${validCollectionSql}
            AND (deposit.firm_transaction_id IS NULL OR (${validBankTransactionSql}))
       ), withdrawals AS (
         SELECT COALESCE(SUM(amount) FILTER (WHERE status='POSTED'),0)::numeric AS posted,
                COALESCE(SUM(amount) FILTER (WHERE status='APPROVED'),0)::numeric AS approved_not_posted,
                COALESCE(SUM(amount) FILTER (WHERE status='PENDING'),0)::numeric AS pending,
                COUNT(*) FILTER (WHERE status='PENDING')::int AS pending_count
           FROM rera_fund_withdrawals
          WHERE organization_id=$1 AND site_id=$2 AND rera_project_id=$3
            AND ($4::bigint IS NULL OR rera_project_phase_id IS NULL OR rera_project_phase_id=$4)
       )
       SELECT collections.amount AS collected,collections.count AS collection_count,
              deposits.verified AS verified_deposits,deposits.pending AS deposits_awaiting_review,
              deposits.pending_count AS deposit_review_count,withdrawals.posted AS posted_withdrawals,
              withdrawals.approved_not_posted,withdrawals.pending AS withdrawals_awaiting_review,
              withdrawals.pending_count AS withdrawal_review_count
         FROM collections CROSS JOIN deposits CROSS JOIN withdrawals`,
      scope,
    ),
    pool.query(
      `SELECT pam.id,pam.firm_id,pam.rera_project_phase_id,pam.purpose,pam.review_status,
              pam.evidence_document_id,
              pam.effective_from,pam.effective_to,f.name AS firm_name,f.bank_name,f.account_number
         FROM project_account_mappings pam
         JOIN firms f ON f.id=pam.firm_id AND f.site_id=pam.site_id
         JOIN documents evidence ON evidence.id=pam.evidence_document_id
          AND evidence.organization_id=pam.organization_id AND evidence.site_id=pam.site_id
        WHERE pam.organization_id=$1 AND pam.site_id=$2 AND pam.rera_project_id=$3
          AND ($4::bigint IS NULL OR pam.rera_project_phase_id IS NULL OR pam.rera_project_phase_id=$4)
          AND pam.review_status='REVIEWED' AND UPPER(pam.purpose)=ANY($5::text[])
          AND NULLIF(BTRIM(f.bank_name),'') IS NOT NULL
          AND NULLIF(BTRIM(f.account_number),'') IS NOT NULL
          AND pam.effective_from<=CURRENT_DATE AND (pam.effective_to IS NULL OR pam.effective_to>=CURRENT_DATE)
        ORDER BY pam.rera_project_phase_id NULLS FIRST,pam.effective_from DESC`,
      [...scope, [...DESIGNATED_ACCOUNT_PURPOSES]],
    ),
    // Reuse the Site's DMS rows so finance users choose readable evidence
    // instead of copying opaque database IDs between modules.
    pool.query(
      `SELECT id,title,original_name,category,doc_date,mime_type,created_at
         FROM documents
        WHERE organization_id=$1 AND site_id=$2 AND uploaded_source='DMS'
        ORDER BY created_at DESC,id DESC LIMIT 200`,
      [req.user.organization_id, siteId],
    ),
    pool.query(
      `SELECT pp.*,b.booking_no,p.plot_no,m.full_name AS customer_name,
              COALESCE(allocated.amount,0)::numeric AS allocated_for_deposit,
              GREATEST(pp.amount-COALESCE(allocated.amount,0),0)::numeric AS remaining_for_deposit
         FROM plot_payments pp
         JOIN bookings b ON b.id=pp.booking_id AND b.site_id=pp.site_id
         JOIN plots p ON p.id=pp.plot_id AND p.site_id=pp.site_id
         LEFT JOIN members m ON m.id=b.client_member_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(deposit.amount),0)::numeric AS amount
             FROM rera_collection_deposit_allocations deposit
            WHERE deposit.plot_payment_id=pp.id AND deposit.status<>'REJECTED'
         ) allocated ON TRUE
        WHERE pp.site_id=$2 AND pp.rera_project_id=$3
          AND ($4::bigint IS NULL OR pp.rera_project_phase_id=$4)
          AND ${validCollectionSql}
          AND pp.amount-COALESCE(allocated.amount,0)>0
        ORDER BY pp.date DESC,pp.id DESC LIMIT 200`,
      scope,
    ),
    pool.query(
      `SELECT ft.id,ft.firm_id,ft.date,ft.description,ft.transaction_no,ft.cheque_no,
              COALESCE(
                NULLIF(BTRIM(ft.transaction_no),''),
                NULLIF(BTRIM(ft.cheque_no),''),
                NULLIF(BTRIM(ft.remark),''),
                NULLIF(BTRIM(ft.description),'')
              ) AS reference,
              ft.credit,ft.payment_mode,ft.cheque_status,
              COALESCE(allocated.amount,0)::numeric AS allocated_credit,
              GREATEST(ft.credit-COALESCE(allocated.amount,0),0)::numeric AS remaining_credit
         FROM firm_transactions ft
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(deposit.amount),0)::numeric AS amount
             FROM rera_collection_deposit_allocations deposit
            WHERE deposit.firm_transaction_id=ft.id AND deposit.status<>'REJECTED'
         ) allocated ON TRUE
        WHERE ft.site_id=$2 AND ft.credit>0
          AND ${validBankTransactionSql}
          AND ft.credit-COALESCE(allocated.amount,0)>0
          AND EXISTS (
            SELECT 1
              FROM project_account_mappings pam
              JOIN documents evidence ON evidence.id=pam.evidence_document_id
               AND evidence.organization_id=pam.organization_id AND evidence.site_id=pam.site_id
              JOIN firms account ON account.id=pam.firm_id AND account.site_id=pam.site_id
             WHERE pam.organization_id=$1 AND pam.site_id=$2 AND pam.rera_project_id=$3
               AND pam.firm_id=ft.firm_id
               AND ($4::bigint IS NULL OR pam.rera_project_phase_id IS NULL OR pam.rera_project_phase_id=$4)
               AND pam.review_status='REVIEWED' AND UPPER(pam.purpose)=ANY($5::text[])
               AND pam.effective_from<=CURRENT_DATE
               AND (pam.effective_to IS NULL OR pam.effective_to>=CURRENT_DATE)
               AND NULLIF(BTRIM(account.bank_name),'') IS NOT NULL
               AND NULLIF(BTRIM(account.account_number),'') IS NOT NULL
          )
        ORDER BY ft.date DESC,ft.id DESC LIMIT 200`,
      [...scope, [...DESIGNATED_ACCOUNT_PURPOSES]],
    ),
    pool.query(
      `SELECT ft.id,ft.firm_id,ft.date,ft.description,ft.transaction_no,ft.cheque_no,
              COALESCE(
                NULLIF(BTRIM(ft.transaction_no),''),
                NULLIF(BTRIM(ft.cheque_no),''),
                NULLIF(BTRIM(ft.remark),''),
                NULLIF(BTRIM(ft.description),'')
              ) AS reference,
              ft.debit,ft.payment_mode,ft.cheque_status,
              ft.debit::numeric AS remaining_debit
         FROM firm_transactions ft
        WHERE ft.site_id=$2 AND ft.debit>0
          AND ${validBankTransactionSql}
          AND NOT EXISTS (
            SELECT 1 FROM rera_fund_withdrawals withdrawal
             WHERE withdrawal.firm_transaction_id=ft.id AND withdrawal.status<>'REJECTED'
          )
          AND EXISTS (
            SELECT 1
              FROM project_account_mappings pam
              JOIN documents evidence ON evidence.id=pam.evidence_document_id
               AND evidence.organization_id=pam.organization_id AND evidence.site_id=pam.site_id
              JOIN firms account ON account.id=pam.firm_id AND account.site_id=pam.site_id
             WHERE pam.organization_id=$1 AND pam.site_id=$2 AND pam.rera_project_id=$3
               AND pam.firm_id=ft.firm_id
               AND ($4::bigint IS NULL OR pam.rera_project_phase_id IS NULL OR pam.rera_project_phase_id=$4)
               AND pam.review_status='REVIEWED' AND UPPER(pam.purpose)=ANY($5::text[])
               AND pam.effective_from<=CURRENT_DATE
               AND (pam.effective_to IS NULL OR pam.effective_to>=CURRENT_DATE)
               AND NULLIF(BTRIM(account.bank_name),'') IS NOT NULL
               AND NULLIF(BTRIM(account.account_number),'') IS NOT NULL
          )
        ORDER BY ft.date DESC,ft.id DESC LIMIT 200`,
      [...scope, [...DESIGNATED_ACCOUNT_PURPOSES]],
    ),
    pool.query(
      `SELECT deposit.*,pp.receipt_no,pp.amount AS collection_amount,pp.date AS collection_date,
              p.plot_no,b.booking_no,f.name AS account_name,ft.credit AS bank_credit
         FROM rera_collection_deposit_allocations deposit
         JOIN plot_payments pp ON pp.id=deposit.plot_payment_id
         LEFT JOIN bookings b ON b.id=pp.booking_id
         JOIN plots p ON p.id=pp.plot_id
         JOIN project_account_mappings pam ON pam.id=deposit.project_account_mapping_id
         JOIN firms f ON f.id=pam.firm_id
         LEFT JOIN firm_transactions ft ON ft.id=deposit.firm_transaction_id
        WHERE deposit.organization_id=$1 AND deposit.site_id=$2 AND deposit.rera_project_id=$3
          AND ($4::bigint IS NULL OR deposit.rera_project_phase_id=$4)
        ORDER BY deposit.deposit_date DESC,deposit.id DESC LIMIT 100`,
      scope,
    ),
    pool.query(
      `SELECT withdrawal.*,f.name AS account_name,f.bank_name,f.account_number
         FROM rera_fund_withdrawals withdrawal
         JOIN project_account_mappings pam ON pam.id=withdrawal.project_account_mapping_id
         JOIN firms f ON f.id=pam.firm_id
        WHERE withdrawal.organization_id=$1 AND withdrawal.site_id=$2 AND withdrawal.rera_project_id=$3
          AND ($4::bigint IS NULL OR withdrawal.rera_project_phase_id=$4)
        ORDER BY withdrawal.requested_date DESC,withdrawal.id DESC LIMIT 100`,
      scope,
    ),
  ]);

  const row = summaryResult.rows[0] || {};
  const collected = Number(row.collected || 0);
  const requiredDeposit = Math.round(collected * Number(policy.minimum_separate_account_percentage) ) / 100;
  const verified = Number(row.verified_deposits || 0);
  const posted = Number(row.posted_withdrawals || 0);
  const approvedNotPosted = Number(row.approved_not_posted || 0);
  const pendingWithdrawals = Number(row.withdrawals_awaiting_review || 0);
  const reserve = {
    collected,
    collection_count: Number(row.collection_count || 0),
    minimum_percentage: policy.minimum_separate_account_percentage,
    required_deposit: requiredDeposit,
    verified_deposits: verified,
    deposits_awaiting_review: Number(row.deposits_awaiting_review || 0),
    deposit_review_count: Number(row.deposit_review_count || 0),
    shortfall: Math.max(0, requiredDeposit - verified),
    coverage_percentage: requiredDeposit > 0 ? Math.round((verified / requiredDeposit) * 10000) / 100 : 100,
  };
  const withdrawals = {
    posted,
    approved_not_posted: approvedNotPosted,
    awaiting_review: pendingWithdrawals,
    review_count: Number(row.withdrawal_review_count || 0),
    // Requests reserve funds as soon as they enter PENDING, matching the
    // create-time and database invariant used to prevent over-commitment.
    available_verified_reserve: Math.max(0, verified - posted - approvedNotPosted - pendingWithdrawals),
  };
  res.json({
    policy,
    project,
    reserve,
    withdrawals,
    designated_accounts: accountResult.rows,
    evidence_documents: evidenceResult.rows,
    eligible_collections: eligibleCollectionResult.rows,
    eligible_bank_credits: eligibleCreditResult.rows,
    eligible_bank_debits: eligibleDebitResult.rows,
    deposit_allocations: depositResult.rows,
    withdrawal_requests: withdrawalResult.rows,
  });
});

/** POST /property-lifecycle/project-finance/rera/deposits */
export const createReraCollectionDeposit = asyncHandler(async (req, res) => {
  const outcome = await inTransaction(async (db) => {
    const siteId = siteIdFrom(req);
    await getReraPolicy(db, req, siteId, { required: true });
    const projectId = positiveId(req.body.rera_project_id, 'rera_project_id');
    const requestedPhaseId = positiveId(req.body.rera_project_phase_id, 'rera_project_phase_id', { optional: true });
    const project = await assertProjectScope(db, req, siteId, projectId, requestedPhaseId);
    if (projectPhaseRequired(project, requestedPhaseId)) {
      throw businessError(
        'Select the project phase that owns this collection deposit',
        'RERA_PROJECT_PHASE_REQUIRED',
        400,
      );
    }
    await lockReraProjectFinance(db, req, siteId, projectId);
    const paymentId = positiveId(req.body.plot_payment_id, 'plot_payment_id');
    const mappingId = positiveId(req.body.project_account_mapping_id, 'project_account_mapping_id');
    const amount = money(req.body.amount, 'Deposit amount', { required: true, allowZero: false });
    const depositDate = isoDate(req.body.deposit_date, 'Deposit date', { required: true });
    const bankTransactionId = positiveId(req.body.firm_transaction_id, 'firm_transaction_id', { optional: true });
    const evidenceDocumentId = positiveId(req.body.evidence_document_id, 'evidence_document_id', { optional: true });
    const reference = cleanText(req.body.deposit_reference, 'Deposit reference', 160);
    if (!bankTransactionId && !evidenceDocumentId && !reference) {
      throw businessError('Link a bank entry, evidence document, or deposit reference', 'DEPOSIT_EVIDENCE_REQUIRED', 400);
    }
    const key = idempotencyKey(req);
    const fingerprint = reraFinanceRequestFingerprint('RERA_DEPOSIT', [
      projectId, requestedPhaseId, paymentId, mappingId, amount, depositDate,
      bankTransactionId, evidenceDocumentId, reference,
    ]);
    const request = {
      projectId, paymentId, mappingId, amount, depositDate,
      bankTransactionId, evidenceDocumentId, reference,
    };
    const replay = await findIdempotentReplay(db, {
      table: 'rera_collection_deposit_allocations', req, siteId, key, fingerprint,
      legacyMatches: (row) => replayMatchesLegacyDeposit(row, request),
    });
    if (replay) return { allocation: replay, created: false };
    const { rows: paymentRows } = await db.query(
      `SELECT pp.* FROM plot_payments pp
        WHERE pp.id=$1 AND pp.site_id=$2 AND pp.rera_project_id=$3
          AND ($4::bigint IS NULL OR pp.rera_project_phase_id=$4)
          AND ${validCollectionSql}
        FOR UPDATE OF pp`,
      [paymentId, siteId, projectId, requestedPhaseId],
    );
    const payment = paymentRows[0];
    if (!payment) throw businessError('Select an approved, unreversed collection from this project and phase', 'RERA_COLLECTION_NOT_ELIGIBLE');
    const phaseId = positiveId(payment.rera_project_phase_id, 'rera_project_phase_id', { optional: true });
    const mapping = await getDesignatedMapping(
      db, req, siteId, mappingId, projectId, phaseId, depositDate, { lock: true },
    );
    const { rows: usedRows } = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS used FROM rera_collection_deposit_allocations
        WHERE plot_payment_id=$1 AND status<>'REJECTED'`,
      [paymentId],
    );
    if (Math.round((Number(usedRows[0].used) + Number(amount)) * 100) > Math.round(Number(payment.amount) * 100)) {
      throw businessError('Separate-account allocations exceed the original collection', 'DEPOSIT_EXCEEDS_COLLECTION');
    }
    if (evidenceDocumentId) {
      const evidence = await db.query(
        `SELECT 1 FROM documents WHERE id=$1 AND site_id=$2 AND organization_id=$3`,
        [evidenceDocumentId, siteId, req.user.organization_id],
      );
      if (!evidence.rows[0]) throw businessError('Deposit evidence is outside the selected Site', 'DEPOSIT_EVIDENCE_SCOPE_MISMATCH');
    }
    let status = 'RECORDED';
    let reviewNotes = null;
    if (bankTransactionId) {
      const transaction = await db.query(
        `SELECT ft.id,ft.credit,ft.firm_id,ft.site_id,ft.status,ft.payment_mode,ft.cheque_status
           FROM firm_transactions ft
          WHERE ft.id=$1 AND ft.site_id=$2 AND ft.firm_id=$3
            AND ${validBankTransactionSql}
          FOR UPDATE`,
        [bankTransactionId, siteId, mapping.firm_id],
      );
      if (!transaction.rows[0] || !isEligibleReraBankEntry(transaction.rows[0])
          || Number(transaction.rows[0].credit || 0) <= 0) {
        throw businessError('Select an approved, non-cash and unbounced credit from the designated project account', 'INVALID_DEPOSIT_BANK_ENTRY');
      }
      const allocated = await db.query(
        `SELECT COALESCE(SUM(amount),0) AS used FROM rera_collection_deposit_allocations
          WHERE firm_transaction_id=$1 AND status<>'REJECTED'`,
        [bankTransactionId],
      );
      if (Math.round((Number(allocated.rows[0].used) + Number(amount)) * 100) > Math.round(Number(transaction.rows[0].credit) * 100)) {
        throw businessError('Deposit allocations exceed the linked bank credit', 'DEPOSIT_EXCEEDS_BANK_CREDIT');
      }
      status = 'VERIFIED';
      reviewNotes = 'System-verified against an existing credit in the reviewed separate account.';
    }
    const { rows } = await db.query(
      `INSERT INTO rera_collection_deposit_allocations (
         organization_id,site_id,rera_project_id,rera_project_phase_id,plot_payment_id,
         project_account_mapping_id,firm_transaction_id,amount,deposit_date,deposit_reference,
         evidence_document_id,status,review_notes,reviewed_by,reviewed_at,idempotency_key,
         request_fingerprint,created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                 CASE WHEN $12='VERIFIED' THEN $14 ELSE NULL END,
                 CASE WHEN $12='VERIFIED' THEN NOW() ELSE NULL END,$15,$16,$14)
       ON CONFLICT (organization_id,site_id,idempotency_key)
         WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [req.user.organization_id, siteId, projectId, phaseId, paymentId, mappingId,
        bankTransactionId, amount, depositDate, reference, evidenceDocumentId, status,
        reviewNotes, req.user.id, key, fingerprint],
    );
    if (!rows[0]) {
      const concurrentReplay = await findIdempotentReplay(db, {
        table: 'rera_collection_deposit_allocations', req, siteId, key, fingerprint,
        legacyMatches: (row) => replayMatchesLegacyDeposit(row, request),
      });
      if (concurrentReplay) return { allocation: concurrentReplay, created: false };
      throw businessError('The deposit could not be recorded safely', 'RERA_FINANCE_DUPLICATE');
    }
    await writeComplianceAudit(db, req, {
      action: status === 'VERIFIED' ? 'RERA_COLLECTION_DEPOSIT_AUTO_VERIFIED' : 'RERA_COLLECTION_DEPOSIT_RECORDED',
      entityType: 'RERA_COLLECTION_DEPOSIT', entityId: rows[0].id, siteId, newValue: rows[0],
    });
    return { allocation: rows[0], created: true };
  });
  res.status(outcome.created ? 201 : 200).json(outcome);
});

/** PATCH /property-lifecycle/project-finance/rera/deposits/:depositId/review */
export const reviewReraCollectionDeposit = asyncHandler(async (req, res) => {
  requireAdmin(req);
  const allocation = await inTransaction(async (db) => {
    const siteId = siteIdFrom(req);
    await getReraPolicy(db, req, siteId, { required: true });
    const depositId = positiveId(req.params.depositId, 'deposit_id');
    const decision = String(req.body.decision || '').toUpperCase();
    if (!['VERIFIED', 'REJECTED'].includes(decision)) {
      throw businessError('decision must be VERIFIED or REJECTED', 'INVALID_DEPOSIT_REVIEW', 400);
    }
    const { rows: contextRows } = await db.query(
      `SELECT rera_project_id FROM rera_collection_deposit_allocations
        WHERE id=$1 AND organization_id=$2 AND site_id=$3`,
      [depositId, req.user.organization_id, siteId],
    );
    if (!contextRows[0]) throw businessError('Deposit allocation not found', 'RERA_DEPOSIT_NOT_FOUND', 404);
    await lockReraProjectFinance(db, req, siteId, contextRows[0].rera_project_id);
    const { rows } = await db.query(
      `SELECT deposit.*,pam.review_status AS account_review_status,pam.purpose AS account_purpose
         FROM rera_collection_deposit_allocations deposit
         JOIN project_account_mappings pam ON pam.id=deposit.project_account_mapping_id
        WHERE deposit.id=$1 AND deposit.organization_id=$2 AND deposit.site_id=$3
        FOR UPDATE OF deposit`,
      [depositId, req.user.organization_id, siteId],
    );
    const current = rows[0];
    if (!current) throw businessError('Deposit allocation not found', 'RERA_DEPOSIT_NOT_FOUND', 404);
    if (current.status !== 'RECORDED') {
      if (current.status === decision) return current;
      throw businessError('Only a recorded deposit can be reviewed', 'RERA_DEPOSIT_ALREADY_REVIEWED');
    }
    if (decision === 'VERIFIED' && current.account_review_status !== 'REVIEWED') {
      throw businessError('The separate-account mapping must be reviewed first', 'RERA_DESIGNATED_ACCOUNT_REQUIRED');
    }
    if (decision === 'VERIFIED') {
      await getDesignatedMapping(
        db,
        req,
        siteId,
        current.project_account_mapping_id,
        current.rera_project_id,
        current.rera_project_phase_id,
        current.deposit_date,
        { lock: true },
      );
    }
    const notes = cleanText(req.body.review_notes || req.body.reason, 'Review notes', 4000, { required: true });
    const changed = await db.query(
      `UPDATE rera_collection_deposit_allocations
          SET status=$1,review_notes=$2,reviewed_by=$3,reviewed_at=NOW(),updated_at=NOW()
        WHERE id=$4 RETURNING *`,
      [decision, notes, req.user.id, depositId],
    );
    await writeComplianceAudit(db, req, {
      action: `RERA_COLLECTION_DEPOSIT_${decision}`,
      entityType: 'RERA_COLLECTION_DEPOSIT', entityId: depositId, siteId,
      previousValue: current, newValue: changed.rows[0], reason: notes,
    });
    return changed.rows[0];
  });
  res.json({ allocation });
});

/** POST /property-lifecycle/project-finance/rera/withdrawals */
export const createReraFundWithdrawal = asyncHandler(async (req, res) => {
  const outcome = await inTransaction(async (db) => {
    const siteId = siteIdFrom(req);
    await getReraPolicy(db, req, siteId, { required: true });
    const projectId = positiveId(req.body.rera_project_id, 'rera_project_id');
    const phaseId = positiveId(req.body.rera_project_phase_id, 'rera_project_phase_id', { optional: true });
    const project = await assertProjectScope(db, req, siteId, projectId, phaseId);
    if (projectPhaseRequired(project, phaseId)) {
      throw businessError(
        'Select the project phase that owns this withdrawal request',
        'RERA_PROJECT_PHASE_REQUIRED',
        400,
      );
    }
    await lockReraProjectFinance(db, req, siteId, projectId);
    const mappingId = positiveId(req.body.project_account_mapping_id, 'project_account_mapping_id');
    const requestedDate = isoDate(req.body.requested_date, 'Requested date', { required: true });
    const mapping = await getDesignatedMapping(
      db, req, siteId, mappingId, projectId, phaseId, requestedDate, { lock: true },
    );
    const [engineerDocumentId, architectDocumentId, caDocumentId] = [
      req.body.engineer_document_id,
      req.body.architect_document_id,
      req.body.ca_document_id,
    ].map((value, index) => positiveId(value, `document_${index + 1}`));
    if (new Set([engineerDocumentId, architectDocumentId, caDocumentId]).size !== 3) {
      throw businessError('Engineer, architect and CA certificates must be separate documents', 'DISTINCT_CERTIFICATES_REQUIRED', 400);
    }
    const amount = money(req.body.amount, 'Withdrawal amount', { required: true, allowZero: false });
    const certifiedAmount = money(req.body.certified_eligible_amount, 'Certified eligible amount', { required: true, allowZero: false });
    const completionPercentage = Number(req.body.completion_percentage);
    const purpose = cleanText(req.body.purpose, 'Withdrawal purpose', 4000, { required: true });
    const bankTransactionId = positiveId(req.body.firm_transaction_id, 'firm_transaction_id', { optional: true });
    const key = idempotencyKey(req);
    const fingerprint = reraFinanceRequestFingerprint('RERA_WITHDRAWAL', [
      projectId, phaseId, mappingId, amount, certifiedAmount, completionPercentage,
      requestedDate, purpose, engineerDocumentId, architectDocumentId, caDocumentId,
      bankTransactionId,
    ]);
    const request = {
      projectId, phaseId, mappingId, amount, certifiedAmount, completionPercentage,
      requestedDate, purpose, engineerDocumentId, architectDocumentId, caDocumentId,
      bankTransactionId,
    };
    const replay = await findIdempotentReplay(db, {
      table: 'rera_fund_withdrawals', req, siteId, key, fingerprint,
      legacyMatches: (row) => replayMatchesLegacyWithdrawal(row, request),
    });
    if (replay) return { withdrawal: replay, created: false };
    await assertDocuments(db, req, siteId, [engineerDocumentId, architectDocumentId, caDocumentId]);
    if (Math.round(Number(amount) * 100) > Math.round(Number(certifiedAmount) * 100)) {
      throw businessError('Withdrawal amount exceeds the certified eligible amount', 'WITHDRAWAL_EXCEEDS_CERTIFICATION', 400);
    }
    if (!Number.isFinite(completionPercentage) || completionPercentage <= 0 || completionPercentage > 100) {
      throw businessError('Completion percentage must be greater than 0 and at most 100', 'INVALID_COMPLETION_PERCENTAGE', 400);
    }
    const available = await db.query(
      `WITH deposits AS (
         SELECT COALESCE(SUM(amount),0) AS total FROM rera_collection_deposit_allocations
          WHERE organization_id=$1 AND site_id=$2 AND rera_project_id=$3
            AND ($4::bigint IS NULL OR rera_project_phase_id=$4) AND status='VERIFIED'
       ), reserved AS (
         SELECT COALESCE(SUM(amount),0) AS total FROM rera_fund_withdrawals
          WHERE organization_id=$1 AND site_id=$2 AND rera_project_id=$3
            AND ($4::bigint IS NULL OR rera_project_phase_id IS NULL OR rera_project_phase_id=$4)
            AND status IN ('PENDING','APPROVED','POSTED')
       ) SELECT deposits.total-reserved.total AS available FROM deposits CROSS JOIN reserved`,
      [req.user.organization_id, siteId, projectId, phaseId],
    );
    if (Math.round(Number(amount) * 100) > Math.round(Number(available.rows[0].available || 0) * 100)) {
      throw businessError('Withdrawal exceeds the verified, unreserved separate-account balance', 'WITHDRAWAL_EXCEEDS_VERIFIED_RESERVE');
    }
    if (bankTransactionId) {
      const transaction = await db.query(
        `SELECT ft.id,ft.debit,ft.status,ft.payment_mode,ft.cheque_status
           FROM firm_transactions ft
          WHERE ft.id=$1 AND ft.site_id=$2 AND ft.firm_id=$3
            AND ${validBankTransactionSql}
          FOR UPDATE`,
        [bankTransactionId, siteId, mapping.firm_id],
      );
      if (!transaction.rows[0] || !isEligibleReraBankEntry(transaction.rows[0])
          || Math.round(Number(transaction.rows[0].debit || 0) * 100) < Math.round(Number(amount) * 100)) {
        throw businessError('Select a sufficient approved, non-cash and unbounced debit from the designated separate account', 'INVALID_WITHDRAWAL_BANK_ENTRY');
      }
      const duplicate = await db.query(
        `SELECT id FROM rera_fund_withdrawals
          WHERE firm_transaction_id=$1 AND status<>'REJECTED'`,
        [bankTransactionId],
      );
      if (duplicate.rows[0]) throw businessError('This bank debit is already linked to another withdrawal', 'WITHDRAWAL_BANK_ENTRY_ALREADY_LINKED');
    }
    const { rows } = await db.query(
      `INSERT INTO rera_fund_withdrawals (
         organization_id,site_id,rera_project_id,rera_project_phase_id,project_account_mapping_id,
         amount,certified_eligible_amount,completion_percentage,requested_date,purpose,
         engineer_document_id,architect_document_id,ca_document_id,firm_transaction_id,
         status,idempotency_key,request_fingerprint,created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'PENDING',$15,$16,$17)
       ON CONFLICT (organization_id,site_id,idempotency_key)
         WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [req.user.organization_id, siteId, projectId, phaseId, mappingId, amount,
        certifiedAmount, completionPercentage, requestedDate, purpose, engineerDocumentId,
        architectDocumentId, caDocumentId, bankTransactionId, key, fingerprint, req.user.id],
    );
    if (!rows[0]) {
      const concurrentReplay = await findIdempotentReplay(db, {
        table: 'rera_fund_withdrawals', req, siteId, key, fingerprint,
        legacyMatches: (row) => replayMatchesLegacyWithdrawal(row, request),
      });
      if (concurrentReplay) return { withdrawal: concurrentReplay, created: false };
      throw businessError('The withdrawal could not be recorded safely', 'RERA_FINANCE_DUPLICATE');
    }
    await writeComplianceAudit(db, req, {
      action: 'RERA_FUND_WITHDRAWAL_REQUESTED', entityType: 'RERA_FUND_WITHDRAWAL',
      entityId: rows[0].id, siteId, newValue: rows[0], reason: rows[0].purpose,
    });
    return { withdrawal: rows[0], created: true };
  });
  res.status(outcome.created ? 201 : 200).json(outcome);
});

/** PATCH /property-lifecycle/project-finance/rera/withdrawals/:withdrawalId/review */
export const reviewReraFundWithdrawal = asyncHandler(async (req, res) => {
  requireAdmin(req);
  const withdrawal = await inTransaction(async (db) => {
    const siteId = siteIdFrom(req);
    await getReraPolicy(db, req, siteId, { required: true });
    const withdrawalId = positiveId(req.params.withdrawalId, 'withdrawal_id');
    const decision = String(req.body.decision || '').toUpperCase();
    if (!['APPROVED', 'REJECTED'].includes(decision)) {
      throw businessError('decision must be APPROVED or REJECTED', 'INVALID_WITHDRAWAL_REVIEW', 400);
    }
    const { rows: contextRows } = await db.query(
      `SELECT rera_project_id FROM rera_fund_withdrawals
        WHERE id=$1 AND organization_id=$2 AND site_id=$3`,
      [withdrawalId, req.user.organization_id, siteId],
    );
    if (!contextRows[0]) throw businessError('Withdrawal request not found', 'RERA_WITHDRAWAL_NOT_FOUND', 404);
    await lockReraProjectFinance(db, req, siteId, contextRows[0].rera_project_id);
    const { rows } = await db.query(
      `SELECT withdrawal.*,pam.review_status AS account_review_status,pam.purpose AS account_purpose
         FROM rera_fund_withdrawals withdrawal
         JOIN project_account_mappings pam ON pam.id=withdrawal.project_account_mapping_id
        WHERE withdrawal.id=$1 AND withdrawal.organization_id=$2 AND withdrawal.site_id=$3
        FOR UPDATE OF withdrawal`,
      [withdrawalId, req.user.organization_id, siteId],
    );
    const current = rows[0];
    if (!current) throw businessError('Withdrawal request not found', 'RERA_WITHDRAWAL_NOT_FOUND', 404);
    if (current.status !== 'PENDING') {
      if (current.status === decision) return current;
      throw businessError('Only a pending withdrawal can be reviewed', 'RERA_WITHDRAWAL_ALREADY_REVIEWED');
    }
    if (decision === 'APPROVED') {
      if (current.account_review_status !== 'REVIEWED' || !DESIGNATED_ACCOUNT_PURPOSES.has(String(current.account_purpose).toUpperCase())) {
        throw businessError('The RERA separate-account mapping is no longer reviewed', 'RERA_DESIGNATED_ACCOUNT_REQUIRED');
      }
      await getDesignatedMapping(
        db,
        req,
        siteId,
        current.project_account_mapping_id,
        current.rera_project_id,
        current.rera_project_phase_id,
        current.requested_date,
        { lock: true },
      );
      const balance = await db.query(
        `WITH deposits AS (
           SELECT COALESCE(SUM(amount),0) AS total FROM rera_collection_deposit_allocations
            WHERE organization_id=$1 AND site_id=$2 AND rera_project_id=$3
              AND ($4::bigint IS NULL OR rera_project_phase_id=$4) AND status='VERIFIED'
         ), committed AS (
           SELECT COALESCE(SUM(amount),0) AS total FROM rera_fund_withdrawals
            WHERE organization_id=$1 AND site_id=$2 AND rera_project_id=$3
              AND ($4::bigint IS NULL OR rera_project_phase_id IS NULL OR rera_project_phase_id=$4)
              AND id<>$5 AND status IN ('PENDING','APPROVED','POSTED')
         ) SELECT deposits.total-committed.total AS available FROM deposits CROSS JOIN committed`,
        [req.user.organization_id, siteId, current.rera_project_id, current.rera_project_phase_id, withdrawalId],
      );
      if (Math.round(Number(current.amount) * 100) > Math.round(Number(balance.rows[0].available || 0) * 100)) {
        throw businessError('Verified separate-account balance is no longer sufficient', 'WITHDRAWAL_EXCEEDS_VERIFIED_RESERVE');
      }
    }
    const notes = cleanText(req.body.review_notes || req.body.reason, 'Review notes', 4000, { required: true });
    const changed = await db.query(
      `UPDATE rera_fund_withdrawals
          SET status=$1,review_notes=$2,reviewed_by=$3,reviewed_at=NOW(),updated_at=NOW()
        WHERE id=$4 RETURNING *`,
      [decision, notes, req.user.id, withdrawalId],
    );
    await writeComplianceAudit(db, req, {
      action: `RERA_FUND_WITHDRAWAL_${decision}`, entityType: 'RERA_FUND_WITHDRAWAL',
      entityId: withdrawalId, siteId, previousValue: current, newValue: changed.rows[0], reason: notes,
    });
    return changed.rows[0];
  });
  res.json({ withdrawal });
});

/** POST /property-lifecycle/project-finance/rera/withdrawals/:withdrawalId/post */
export const postReraFundWithdrawal = asyncHandler(async (req, res) => {
  requireAdmin(req);
  const withdrawal = await inTransaction(async (db) => {
    const siteId = siteIdFrom(req);
    await getReraPolicy(db, req, siteId, { required: true });
    const withdrawalId = positiveId(req.params.withdrawalId, 'withdrawal_id');
    const bankTransactionId = positiveId(req.body.firm_transaction_id, 'firm_transaction_id');
    const { rows: contextRows } = await db.query(
      `SELECT rera_project_id FROM rera_fund_withdrawals
        WHERE id=$1 AND organization_id=$2 AND site_id=$3`,
      [withdrawalId, req.user.organization_id, siteId],
    );
    if (!contextRows[0]) throw businessError('Withdrawal request not found', 'RERA_WITHDRAWAL_NOT_FOUND', 404);
    await lockReraProjectFinance(db, req, siteId, contextRows[0].rera_project_id);
    const { rows } = await db.query(
      `SELECT withdrawal.*
         FROM rera_fund_withdrawals withdrawal
        WHERE withdrawal.id=$1 AND withdrawal.organization_id=$2 AND withdrawal.site_id=$3
        FOR UPDATE OF withdrawal`,
      [withdrawalId, req.user.organization_id, siteId],
    );
    const current = rows[0];
    if (!current) throw businessError('Withdrawal request not found', 'RERA_WITHDRAWAL_NOT_FOUND', 404);
    if (current.status === 'POSTED' && Number(current.firm_transaction_id) === bankTransactionId) return current;
    if (current.status !== 'APPROVED') throw businessError('Approve the certified withdrawal before posting it', 'RERA_WITHDRAWAL_NOT_APPROVED');
    const mapping = await getDesignatedMapping(
      db,
      req,
      siteId,
      current.project_account_mapping_id,
      current.rera_project_id,
      current.rera_project_phase_id,
      current.requested_date,
      { lock: true },
    );
    const transaction = await db.query(
      `SELECT ft.id,ft.debit,ft.status,ft.payment_mode,ft.cheque_status
         FROM firm_transactions ft
        WHERE ft.id=$1 AND ft.site_id=$2 AND ft.firm_id=$3
          AND ${validBankTransactionSql}
        FOR UPDATE`,
      [bankTransactionId, siteId, mapping.firm_id],
    );
    if (!transaction.rows[0] || !isEligibleReraBankEntry(transaction.rows[0])
        || Math.round(Number(transaction.rows[0].debit || 0) * 100) < Math.round(Number(current.amount) * 100)) {
      throw businessError('Select a sufficient approved, non-cash and unbounced debit from the designated separate account', 'INVALID_WITHDRAWAL_BANK_ENTRY');
    }
    const duplicate = await db.query(
      `SELECT id FROM rera_fund_withdrawals
        WHERE firm_transaction_id=$1 AND status<>'REJECTED' AND id<>$2`,
      [bankTransactionId, withdrawalId],
    );
    if (duplicate.rows[0]) throw businessError('This bank debit is already linked to another withdrawal', 'WITHDRAWAL_BANK_ENTRY_ALREADY_LINKED');
    const changed = await db.query(
      `UPDATE rera_fund_withdrawals
          SET status='POSTED',firm_transaction_id=$1,posted_by=$2,posted_at=NOW(),updated_at=NOW()
        WHERE id=$3 RETURNING *`,
      [bankTransactionId, req.user.id, withdrawalId],
    );
    await writeComplianceAudit(db, req, {
      action: 'RERA_FUND_WITHDRAWAL_POSTED', entityType: 'RERA_FUND_WITHDRAWAL',
      entityId: withdrawalId, siteId, previousValue: current, newValue: changed.rows[0],
    });
    return changed.rows[0];
  });
  res.json({ withdrawal });
});
