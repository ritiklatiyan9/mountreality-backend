const DECISIONS = new Set(['ALLOWED', 'WARNING', 'REQUIRES_APPROVAL', 'BLOCKED']);
const RERA_OPERATING_MODELS = new Set([
  'RERA_PROJECT_PROMOTER',
  'RERA_ONGOING_PROJECT_REGULARISATION',
]);

export const COLLECTION_DECISIONS = Object.freeze([...DECISIONS]);

export const PROPERTY_TRANSITIONS = Object.freeze({
  AVAILABLE: ['HOLD', 'BOOKED'],
  HOLD: ['AVAILABLE', 'BOOKED'],
  BOOKED: ['ALLOTTED', 'CANCELLATION_REQUESTED'],
  ALLOTTED: ['AGREEMENT_EXECUTED', 'CANCELLATION_REQUESTED'],
  AGREEMENT_EXECUTED: ['REGISTRY_PENDING', 'CANCELLATION_REQUESTED'],
  REGISTRY_PENDING: ['REGISTRY_COMPLETE', 'CANCELLATION_REQUESTED'],
  REGISTRY_COMPLETE: ['POSSESSION_PENDING'],
  POSSESSION_PENDING: ['POSSESSED'],
  CANCELLATION_REQUESTED: ['CANCELLATION_APPROVED'],
  CANCELLATION_APPROVED: ['REFUND_PENDING', 'CANCELLED'],
  REFUND_PENDING: ['CANCELLED'],
  CANCELLED: ['AVAILABLE'],
  POSSESSED: [],
});

export const BOOKING_TRANSITIONS = Object.freeze({
  DRAFT: ['HOLD', 'BOOKED', 'CANCELLED'],
  HOLD: ['BOOKED', 'CANCELLED'],
  BOOKED: ['ALLOTTED', 'CANCELLATION_REQUESTED'],
  ALLOTTED: ['AGREEMENT_EXECUTED', 'CANCELLATION_REQUESTED'],
  AGREEMENT_EXECUTED: ['REGISTRY_PENDING', 'CANCELLATION_REQUESTED'],
  REGISTRY_PENDING: ['REGISTRY_COMPLETE', 'CANCELLATION_REQUESTED'],
  REGISTRY_COMPLETE: ['POSSESSION_PENDING'],
  POSSESSION_PENDING: ['POSSESSED'],
  CANCELLATION_REQUESTED: ['CANCELLATION_APPROVED'],
  CANCELLATION_APPROVED: ['REFUND_PENDING', 'CANCELLED'],
  REFUND_PENDING: ['CANCELLED'],
  CANCELLED: ['CLOSED'],
  TRANSFERRED: ['CLOSED'],
  POSSESSED: ['CLOSED'],
  CLOSED: [],
});

export const AGREEMENT_TRANSITIONS = Object.freeze({
  DRAFT: ['PREPARED', 'CANCELLED'],
  PREPARED: ['UNDER_REVIEW', 'DRAFT', 'CANCELLED'],
  UNDER_REVIEW: ['APPROVED_FOR_EXECUTION', 'PREPARED', 'CANCELLED'],
  APPROVED_FOR_EXECUTION: ['EXECUTED', 'UNDER_REVIEW', 'CANCELLED'],
  EXECUTED: ['SUPERSEDED'],
  SUPERSEDED: [],
  CANCELLED: [],
});

export const REGISTRY_TRANSITIONS = Object.freeze({
  NOT_READY: ['READY', 'CANCELLED'],
  READY: ['SCHEDULED', 'NOT_READY', 'CANCELLED'],
  SCHEDULED: ['DOCUMENTS_READY', 'READY', 'CANCELLED'],
  DOCUMENTS_READY: ['EXECUTED', 'SCHEDULED', 'CANCELLED'],
  EXECUTED: ['COMPLETE'],
  COMPLETE: [],
  CANCELLED: [],
});

export const POSSESSION_TRANSITIONS = Object.freeze({
  PENDING: ['READY', 'CANCELLED'],
  READY: ['HANDOVER_SCHEDULED', 'PENDING', 'CANCELLED'],
  HANDOVER_SCHEDULED: ['DOCUMENTS_DELIVERED', 'READY', 'CANCELLED'],
  DOCUMENTS_DELIVERED: ['ACKNOWLEDGED', 'HANDOVER_SCHEDULED', 'CANCELLED'],
  ACKNOWLEDGED: ['POSSESSED'],
  POSSESSED: [],
  CANCELLED: [],
});

const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

export function positiveId(value, field = 'id', { optional = false } = {}) {
  if ((value === null || value === undefined || value === '') && optional) return null;
  const id = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(id) || id <= 0) {
    const error = new Error(`${field} must be a positive integer`);
    error.statusCode = 400;
    error.code = 'INVALID_ID';
    throw error;
  }
  return id;
}

export function cleanText(value, field, max = 500, { required = false } = {}) {
  const text = String(value ?? '').trim();
  if (!text && required) {
    const error = new Error(`${field} is required`);
    error.statusCode = 400;
    error.code = 'REQUIRED_FIELD';
    throw error;
  }
  if (text.length > max) {
    const error = new Error(`${field} must be ${max} characters or fewer`);
    error.statusCode = 400;
    error.code = 'FIELD_TOO_LONG';
    throw error;
  }
  return text || null;
}

/** Return a normalized decimal string so SQL, rather than binary floating point,
 * performs money arithmetic. */
export function money(value, field, { required = false, allowZero = true } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    if (!required) return null;
    const error = new Error(`${field} is required`);
    error.statusCode = 400;
    throw error;
  }
  if (!/^\d{1,13}(?:\.\d{1,2})?$/.test(raw)) {
    const error = new Error(`${field} must be a valid non-negative amount with at most two decimals`);
    error.statusCode = 400;
    error.code = 'INVALID_MONEY';
    throw error;
  }
  const normalized = Number(raw).toFixed(2);
  if (!allowZero && normalized === '0.00') {
    const error = new Error(`${field} must be greater than zero`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

export function isoDate(value, field, { required = false } = {}) {
  if (!value) {
    if (!required) return null;
    const error = new Error(`${field} is required`);
    error.statusCode = 400;
    throw error;
  }
  const raw = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    const error = new Error(`${field} must be a valid date`);
    error.statusCode = 400;
    throw error;
  }
  return raw;
}

export function assertTransition(map, from, to, entityLabel) {
  const current = String(from || '').toUpperCase();
  const next = String(to || '').toUpperCase();
  if (!next || !own(map, current) || !map[current].includes(next)) {
    const error = new Error(`${entityLabel} cannot move from ${current || 'UNKNOWN'} to ${next || 'UNKNOWN'}`);
    error.statusCode = 409;
    error.code = 'INVALID_STATE_TRANSITION';
    error.details = { current, requested: next, allowed: map[current] || [] };
    throw error;
  }
  return next;
}

export function normalizeSchedule(input = [], finalConsideration = null) {
  if (!Array.isArray(input)) {
    const error = new Error('payment_schedule must be an array');
    error.statusCode = 400;
    throw error;
  }
  const items = input.map((item, index) => ({
    installment_name: cleanText(item?.name ?? item?.installment_name, `Schedule item ${index + 1} name`, 255, { required: true }),
    milestone_code: cleanText(item?.milestone_code, `Schedule item ${index + 1} milestone`, 60),
    amount: money(item?.amount, `Schedule item ${index + 1} amount`, { required: true, allowZero: false }),
    due_date: isoDate(item?.due_date, `Schedule item ${index + 1} due date`, { required: true }),
    sort_order: index + 1,
  }));
  if (finalConsideration !== null && items.length) {
    const totalPaise = items.reduce((sum, item) => sum + Math.round(Number(item.amount) * 100), 0);
    const considerationPaise = Math.round(Number(finalConsideration) * 100);
    if (totalPaise !== considerationPaise) {
      const error = new Error('Payment schedule total must equal the final consideration');
      error.statusCode = 400;
      error.code = 'SCHEDULE_TOTAL_MISMATCH';
      error.details = { scheduled: (totalPaise / 100).toFixed(2), consideration: (considerationPaise / 100).toFixed(2) };
      throw error;
    }
  }
  return items;
}

export function normalizeBookingPayload(input = {}) {
  const basePrice = money(input.base_price ?? input.sale_price, 'Base price', { required: true });
  const charges = money(input.charges ?? 0, 'Charges', { required: true });
  const discount = money(input.discount_amount ?? input.discount ?? 0, 'Discount', { required: true });
  const expectedFinalPaise = Math.round((Number(basePrice) + Number(charges) - Number(discount)) * 100);
  const finalConsideration = input.final_consideration === undefined || input.final_consideration === null || input.final_consideration === ''
    ? (expectedFinalPaise / 100).toFixed(2)
    : money(input.final_consideration, 'Final consideration', { required: true });
  if (expectedFinalPaise !== Math.round(Number(finalConsideration) * 100)) {
    const error = new Error('Final consideration must equal base price plus charges minus discount');
    error.statusCode = 400;
    error.code = 'COMMERCIAL_SNAPSHOT_MISMATCH';
    throw error;
  }

  const primaryAllotteeId = positiveId(input.primary_allottee_id ?? input.client_member_id, 'primary_allottee_id');
  const jointAllotteeIds = [...new Set((Array.isArray(input.joint_allottee_ids) ? input.joint_allottee_ids : [])
    .map((id) => positiveId(id, 'joint_allottee_id')))]
    .filter((id) => id !== primaryAllotteeId);
  if (jointAllotteeIds.length > 10) {
    const error = new Error('A booking can have at most 10 joint allottees');
    error.statusCode = 400;
    throw error;
  }

  const snapshot = {
    base_price: basePrice,
    charges,
    discount_amount: discount,
    final_consideration: finalConsideration,
    price_version: cleanText(input.price_version, 'Price version', 80),
    effective_date: isoDate(input.price_effective_date ?? input.effective_date, 'Price effective date'),
    captured_at: new Date().toISOString(),
  };
  return {
    plot_id: positiveId(input.plot_id, 'plot_id'),
    primary_allottee_id: primaryAllotteeId,
    joint_allottee_ids: jointAllotteeIds,
    rera_project_id: positiveId(input.rera_project_id, 'rera_project_id', { optional: true }),
    rera_project_phase_id: positiveId(input.rera_project_phase_id, 'rera_project_phase_id', { optional: true }),
    booking_date: isoDate(input.booking_date ?? new Date().toISOString().slice(0, 10), 'Booking date', { required: true }),
    base_price: basePrice,
    charges,
    discount_amount: discount,
    final_consideration: finalConsideration,
    price_version: snapshot.price_version,
    price_effective_date: snapshot.effective_date,
    commercial_snapshot: snapshot,
    agreement_required: input.agreement_required === true,
    notes: cleanText(input.notes, 'Notes', 4000),
    idempotency_key: cleanText(input.idempotency_key, 'Idempotency key', 120),
    payment_schedule: normalizeSchedule(input.payment_schedule || [], finalConsideration),
  };
}

const normalizeDecision = (value, fallback = 'WARNING') => {
  const decision = String(value || fallback).toUpperCase();
  return DECISIONS.has(decision) ? decision : fallback;
};

const moneyNumber = (value) => Number.parseFloat(value) || 0;

/**
 * Evaluate the published operating-profile baseline plus reviewed, explicitly
 * configured collection controls. Unreviewed ruleset JSON can explain a
 * warning but cannot create an additional block.
 */
export function evaluateCollectionPolicy({
  workflowPolicy = {},
  ruleset = null,
  operatingModel = null,
  agreementStatus = 'NOT_STARTED',
  agreementRegistrationStatus = 'NOT_REGISTERED',
  agreementRegistrationNumber = null,
  agreementRegistrationDate = null,
  currentQualifyingCollection = 0,
  proposedAmount = 0,
  finalConsideration = 0,
} = {}) {
  const collectionPolicy = workflowPolicy?.collections;
  const after = moneyNumber(currentQualifyingCollection) + moneyNumber(proposedAmount);
  const reviewed = ruleset?.source_review_status === 'REVIEWED';
  const normalizedOperatingModel = String(operatingModel || '').trim().toUpperCase();
  const normalizedAgreementStatus = String(agreementStatus || '').trim().toUpperCase();
  const normalizedRegistrationStatus = String(agreementRegistrationStatus || '').trim().toUpperCase();
  const reraMode = RERA_OPERATING_MODELS.has(normalizedOperatingModel);
  let centralLimit = null;
  const registeredAgreement = normalizedAgreementStatus === 'EXECUTED'
    && normalizedRegistrationStatus === 'REGISTERED'
    && Boolean(String(agreementRegistrationNumber || '').trim())
    && Boolean(agreementRegistrationDate);
  const base = {
    decision: 'ALLOWED',
    code: 'NO_REVIEWED_COLLECTION_CONTROL',
    message: 'No reviewed collection control is configured for this Site',
    rule: null,
    ruleset: ruleset ? {
      id: ruleset.id,
      code: ruleset.code,
      version: ruleset.version,
      label: ruleset.version_label,
      source_review_status: ruleset.source_review_status,
    } : null,
    operating_model: normalizedOperatingModel || null,
    agreement_status: agreementStatus,
    agreement_registration_status: normalizedRegistrationStatus || 'NOT_REGISTERED',
    agreement_registered: registeredAgreement,
    current_qualifying_collection: moneyNumber(currentQualifyingCollection).toFixed(2),
    proposed_amount: moneyNumber(proposedAmount).toFixed(2),
    after_receipt: after.toFixed(2),
  };

  // Central RERA baseline: before a written agreement for sale is both
  // executed and registered, aggregate collections may not exceed ten per
  // cent of the immutable booking consideration. Reviewed state/tenant rules
  // are evaluated below as an additional layer, so they may impose a stricter
  // control without being able to weaken this baseline.
  if (reraMode && !registeredAgreement) {
    const consideration = moneyNumber(finalConsideration);
    if (consideration <= 0) {
      return {
        ...base,
        decision: 'BLOCKED',
        code: 'RERA_CONSIDERATION_REQUIRED',
        message: 'A confirmed booking consideration is required before recording a RERA customer collection',
        rule: 'RERA_2016_SECTION_13',
      };
    }
    const centralLimitPaise = Math.floor(Math.round(consideration * 100) / 10);
    centralLimit = centralLimitPaise / 100;
    if (Math.round(after * 100) > centralLimitPaise) {
      return {
        ...base,
        decision: 'BLOCKED',
        code: 'RERA_PRE_AGREEMENT_COLLECTION_LIMIT',
        message: 'This receipt would take pre-registration collections above 10% of the booking consideration',
        rule: 'RERA_2016_SECTION_13',
        configured_limit: centralLimit.toFixed(2),
      };
    }
  }

  if (!collectionPolicy || typeof collectionPolicy !== 'object') {
    return reraMode ? {
      ...base,
      code: registeredAgreement
        ? 'RERA_REGISTERED_AGREEMENT_COLLECTION_ALLOWED'
        : 'RERA_PRE_AGREEMENT_COLLECTION_LIMIT_PASSED',
      message: registeredAgreement
        ? 'The registered agreement unlocks the central pre-agreement collection limit'
        : 'The proposed collection remains within 10% of the booking consideration',
      rule: 'RERA_2016_SECTION_13',
      configured_limit: registeredAgreement ? null : centralLimit.toFixed(2),
    } : base;
  }

  if (!reviewed) {
    return {
      ...base,
      decision: 'WARNING',
      code: 'COLLECTION_POLICY_SOURCE_NOT_REVIEWED',
      message: 'Collection configuration exists, but its source review is not complete; no statutory block was applied',
    };
  }

  const agreementGuard = collectionPolicy.agreement_guard;
  if (agreementGuard?.enabled === true) {
    const accepted = Array.isArray(agreementGuard.accepted_statuses)
      ? agreementGuard.accepted_statuses.map((status) => String(status).toUpperCase())
      : ['EXECUTED'];
    if (!accepted.includes(normalizedAgreementStatus)
        && !accepted.includes(normalizedRegistrationStatus)) {
      return {
        ...base,
        decision: normalizeDecision(agreementGuard.decision, 'REQUIRES_APPROVAL'),
        code: 'AGREEMENT_COLLECTION_GUARD',
        message: cleanText(agreementGuard.message, 'Collection policy message', 500)
          || `Collection requires agreement review; agreement is ${agreementStatus || 'not started'}`,
        rule: cleanText(agreementGuard.rule_reference, 'Rule reference', 240),
      };
    }
  }

  const threshold = collectionPolicy.pre_agreement_threshold;
  const configuredThresholdSatisfied = reraMode
    ? registeredAgreement
    : normalizedAgreementStatus === 'EXECUTED';
  if (threshold?.enabled === true && !configuredThresholdSatisfied) {
    const configuredAmount = moneyNumber(threshold.amount);
    const configuredPercent = moneyNumber(threshold.percentage);
    const limit = configuredAmount > 0
      ? configuredAmount
      : (configuredPercent > 0 && moneyNumber(finalConsideration) > 0
        ? moneyNumber(finalConsideration) * configuredPercent / 100
        : null);
    if (limit !== null && after > limit) {
      return {
        ...base,
        decision: normalizeDecision(threshold.decision, 'REQUIRES_APPROVAL'),
        code: 'PRE_AGREEMENT_COLLECTION_THRESHOLD',
        message: cleanText(threshold.message, 'Collection policy message', 500)
          || 'Proposed collection exceeds the reviewed pre-agreement control',
        rule: cleanText(threshold.rule_reference, 'Rule reference', 240),
        configured_limit: limit.toFixed(2),
      };
    }
  }

  return {
    ...base,
    code: 'REVIEWED_COLLECTION_CONTROL_PASSED',
    message: 'The proposed collection passes the configured reviewed controls',
  };
}

export function collectionSummary({ consideration = 0, scheduled = 0, received = 0, refunded = 0, overdue = 0, future = 0 } = {}) {
  const effectiveReceived = Math.max(moneyNumber(received) - moneyNumber(refunded), 0);
  const value = moneyNumber(consideration);
  return {
    consideration: value.toFixed(2),
    scheduled: moneyNumber(scheduled).toFixed(2),
    received: moneyNumber(received).toFixed(2),
    refunded: moneyNumber(refunded).toFixed(2),
    net_received: effectiveReceived.toFixed(2),
    overdue: moneyNumber(overdue).toFixed(2),
    future: moneyNumber(future).toFixed(2),
    outstanding: Math.max(value - effectiveReceived, 0).toFixed(2),
    percentage: value > 0 ? Math.min(Math.round((effectiveReceived / value) * 10000) / 100, 100) : 0,
  };
}
