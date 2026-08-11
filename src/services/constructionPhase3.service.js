export class ConstructionPhase3ValidationError extends Error {
  constructor(message, code = 'VALIDATION_ERROR', details = undefined) {
    super(message);
    this.name = 'ConstructionPhase3ValidationError';
    this.code = code;
    this.details = details;
    this.status = 400;
    this.statusCode = 400;
  }
}

export const CERTIFICATION_TRANSITIONS = Object.freeze({
  DRAFT: ['EVIDENCE_PREPARATION'],
  EVIDENCE_PREPARATION: ['PROFESSIONAL_REVIEW', 'DRAFT'],
  PROFESSIONAL_REVIEW: ['INTERNAL_REVIEW', 'REVISION_REQUIRED'],
  INTERNAL_REVIEW: ['CERTIFIED', 'REJECTED', 'REVISION_REQUIRED'],
  REVISION_REQUIRED: ['EVIDENCE_PREPARATION'],
  CERTIFIED: ['APPROVED', 'SUPERSEDED'],
  APPROVED: ['SUPERSEDED'],
  REJECTED: [],
  SUPERSEDED: [],
});

export const FILING_TRANSITIONS = Object.freeze({
  DRAFT: ['DATA_RECONCILIATION'],
  DATA_RECONCILIATION: ['EVIDENCE_PENDING', 'REVIEW'],
  EVIDENCE_PENDING: ['DATA_RECONCILIATION', 'REVIEW'],
  REVIEW: ['READY', 'DATA_RECONCILIATION', 'EVIDENCE_PENDING'],
  READY: ['SUBMITTED', 'REVIEW'],
  SUBMITTED: ['ACCEPTED', 'REJECTED', 'RESUBMISSION_REQUIRED'],
  RESUBMISSION_REQUIRED: ['DATA_RECONCILIATION'],
  REJECTED: ['SUPERSEDED'],
  ACCEPTED: ['SUPERSEDED'],
  SUPERSEDED: [],
});

export const CHANGE_TRANSITIONS = Object.freeze({
  DRAFT: ['EVIDENCE_PENDING', 'UNDER_REVIEW'],
  EVIDENCE_PENDING: ['UNDER_REVIEW', 'DRAFT'],
  UNDER_REVIEW: ['READY', 'REVISION_REQUIRED', 'REJECTED'],
  READY: ['SUBMITTED', 'UNDER_REVIEW'],
  SUBMITTED: ['APPROVED', 'REJECTED', 'REVISION_REQUIRED'],
  REVISION_REQUIRED: ['EVIDENCE_PENDING', 'UNDER_REVIEW'],
  APPROVED: ['SUPERSEDED'],
  REJECTED: ['SUPERSEDED'],
  SUPERSEDED: [],
});

export const EXTENSION_TRANSITIONS = Object.freeze({
  DRAFT: ['EVIDENCE_PENDING', 'UNDER_REVIEW'],
  EVIDENCE_PENDING: ['UNDER_REVIEW', 'DRAFT'],
  UNDER_REVIEW: ['READY', 'REJECTED'],
  READY: ['SUBMITTED', 'UNDER_REVIEW'],
  SUBMITTED: ['APPROVED', 'REJECTED', 'RESUBMISSION_REQUIRED'],
  RESUBMISSION_REQUIRED: ['EVIDENCE_PENDING', 'UNDER_REVIEW'],
  APPROVED: ['SUPERSEDED'],
  REJECTED: ['SUPERSEDED'],
  SUPERSEDED: [],
});

export const assertTransition = (map, current, next) => {
  const from = String(current || '').toUpperCase();
  const to = String(next || '').toUpperCase();
  if (!map[from]?.includes(to)) {
    throw new ConstructionPhase3ValidationError(
      `Transition from ${from || 'UNKNOWN'} to ${to || 'UNKNOWN'} is not allowed`,
      'INVALID_TRANSITION',
      { current: from, requested: to, allowed: map[from] || [] },
    );
  }
  return to;
};

export const normalizePercent = (value, field = 'progress') => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new ConstructionPhase3ValidationError(`${field} must be between 0 and 100`, 'INVALID_PERCENT');
  }
  return Math.round(parsed * 10000) / 10000;
};

export const normalizeDate = (value, field, { required = false } = {}) => {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ConstructionPhase3ValidationError(`${field} is required`, 'REQUIRED_FIELD');
    return null;
  }
  const normalized = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || Number.isNaN(Date.parse(`${normalized}T00:00:00Z`))) {
    throw new ConstructionPhase3ValidationError(`${field} must be a valid date`, 'INVALID_DATE');
  }
  return normalized;
};

export const normalizeText = (value, field, { required = false, max = 2000 } = {}) => {
  const normalized = value === undefined || value === null ? '' : String(value).trim();
  if (required && !normalized) {
    throw new ConstructionPhase3ValidationError(`${field} is required`, 'REQUIRED_FIELD');
  }
  if (normalized.length > max) {
    throw new ConstructionPhase3ValidationError(`${field} cannot exceed ${max} characters`, 'INVALID_TEXT');
  }
  return normalized || null;
};

const progressForItem = (item, method) => {
  if (method === 'QUANTITY_WEIGHTED' || item.progress_method === 'QUANTITY') {
    const planned = Number(item.planned_quantity);
    const completed = Number(item.completed_quantity);
    if (!(planned > 0) || !Number.isFinite(completed)) return null;
    return Math.min(100, Math.max(0, (completed / planned) * 100));
  }
  const progress = Number(item.progress_pct ?? item.operational_progress_pct);
  return Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : null;
};

/**
 * Calculates operational progress without inventing missing weights.
 * A deterministic method returns null and blockers when inputs are incomplete.
 */
export const deriveOperationalProgress = ({ method = 'MANUAL', manualProgress, items = [] } = {}) => {
  const normalizedMethod = String(method).toUpperCase();
  if (normalizedMethod === 'MANUAL') {
    return { progress: normalizePercent(manualProgress ?? 0), method: normalizedMethod, blockers: [] };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { progress: null, method: normalizedMethod, blockers: ['No scoped tasks or work packages exist'] };
  }

  const missingWeights = items.filter((item) => !(Number(item.weight) > 0)).map((item) => item.id);
  const missingProgress = items.filter((item) => progressForItem(item, normalizedMethod) === null).map((item) => item.id);
  const blockers = [];
  if (missingWeights.length) blockers.push(`Missing weights for records: ${missingWeights.join(', ')}`);
  if (missingProgress.length) blockers.push(`Missing progress inputs for records: ${missingProgress.join(', ')}`);
  if (blockers.length) return { progress: null, method: normalizedMethod, blockers };

  const totalWeight = items.reduce((sum, item) => sum + Number(item.weight), 0);
  if (!(totalWeight > 0)) return { progress: null, method: normalizedMethod, blockers: ['Total weight must be greater than zero'] };
  const weighted = items.reduce(
    (sum, item) => sum + (progressForItem(item, normalizedMethod) * Number(item.weight)),
    0,
  ) / totalWeight;
  return {
    progress: Math.round(weighted * 10000) / 10000,
    method: normalizedMethod,
    totalWeight: Math.round(totalWeight * 1_000_000) / 1_000_000,
    blockers: [],
  };
};

export const calculateCostPosition = ({
  budget = 0,
  committed = 0,
  paid = 0,
  materialConsumed = 0,
  allocatedActual = 0,
  estimatedAdditionalCost = 0,
} = {}) => {
  const money = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const approvedBudget = money(budget);
  const committedCost = money(committed);
  const paidCost = money(paid);
  const materialConsumedCost = money(materialConsumed);
  const financeAllocatedActual = money(allocatedActual);
  const actualCost = materialConsumedCost + financeAllocatedActual;
  const costToComplete = money(estimatedAdditionalCost);
  const estimateAtCompletion = actualCost + costToComplete;
  return {
    approvedBudget,
    committedCost,
    paidCost,
    materialConsumedCost,
    financeAllocatedActual,
    actualCost,
    costToComplete,
    estimateAtCompletion,
    budgetVariance: approvedBudget - estimateAtCompletion,
    outstandingCommitment: Math.max(0, committedCost - paidCost),
  };
};

export const evaluateFilingReadiness = ({ ruleset, requirements = [], reconciliation = [] } = {}) => {
  const issues = [];
  const sourceReviewed = ruleset?.source_review_status === 'REVIEWED'
    || (ruleset?.contains_legal_requirements === false && ruleset?.source_review_status === 'NOT_APPLICABLE');
  if (!ruleset) issues.push({ code: 'RULESET_MISSING', reason: 'No pinned ruleset version is available' });
  else if (!sourceReviewed) issues.push({ code: 'RULESET_UNREVIEWED', reason: 'Pinned ruleset source has not been reviewed' });

  for (const requirement of requirements) {
    if ((requirement.is_blocking || requirement.is_mandatory)
      && !['COMPLETE', 'NOT_APPLICABLE'].includes(requirement.status)) {
      issues.push({
        code: 'REQUIREMENT_UNRESOLVED',
        requirementId: requirement.id,
        requirementCode: requirement.requirement_code,
        reason: `${requirement.title || requirement.requirement_code} is ${requirement.status}`,
      });
    }
    if (requirement.source_review_status === 'PENDING' || requirement.source_review_status === 'REJECTED') {
      issues.push({
        code: 'REQUIREMENT_SOURCE_UNREVIEWED',
        requirementId: requirement.id,
        requirementCode: requirement.requirement_code,
        reason: `${requirement.title || requirement.requirement_code} does not have a reviewed source`,
      });
    }
  }
  for (const result of reconciliation) {
    if (['ERROR', 'REVIEW_REQUIRED'].includes(result.status)) {
      issues.push({
        code: 'RECONCILIATION_BLOCKER',
        checkCode: result.check_code,
        reason: result.reason,
      });
    }
  }
  return { ready: issues.length === 0, blockingIssueCount: issues.length, issues };
};

export const filingRequirementStatus = (requirement, ruleset) => {
  const reviewed = requirement.source_review_status === 'REVIEWED'
    || (!requirement.is_legal_requirement && requirement.source_review_status === 'NOT_APPLICABLE');
  const rulesetReviewed = ruleset.source_review_status === 'REVIEWED'
    || (!ruleset.contains_legal_requirements && ruleset.source_review_status === 'NOT_APPLICABLE');
  return reviewed && rulesetReviewed ? 'PENDING' : 'REVIEW_REQUIRED';
};
