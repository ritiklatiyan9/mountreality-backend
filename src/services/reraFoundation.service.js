/**
 * Pure input boundary for the Phase 1 RERA foundation.
 *
 * These helpers normalize UI aliases into migration 094's canonical columns.
 * They intentionally contain no database access, legal deadlines, statutory
 * interpretations, or claims that a recorded status was authority-verified.
 */

export const RERA_PROJECT_SHAPES = Object.freeze([
  'PLOTTED_DEVELOPMENT', 'APARTMENT', 'COMMERCIAL', 'MIXED_USE',
]);

export const RERA_DEVELOPMENT_BASES = Object.freeze([
  'LANDOWNER',
  'DEVELOPMENT_AGREEMENT',
  'JOINT_DEVELOPMENT_AGREEMENT',
  'COLLABORATION_AGREEMENT',
  'CO_PROMOTER',
  'POWER_OF_ATTORNEY',
  'OTHER',
]);

export const RERA_REGULATORY_STATUSES = Object.freeze([
  'DRAFT',
  'APPLICABILITY_UNDER_REVIEW',
  'EXEMPTION_UNDER_REVIEW',
  'APPLICATION_IN_PREPARATION',
  'FILED',
  'REGISTERED',
  'AMENDMENT_PENDING',
  'EXTENSION_PENDING',
  'EXPIRED',
  'LAPSED',
  'REVOKED',
  'COMPLETED',
]);

export const RERA_AREA_UNITS = Object.freeze([
  'SQ_M', 'SQ_FT', 'SQ_YD', 'ACRE', 'HECTARE', 'BIGHA',
]);

export const RERA_STAKEHOLDER_TYPES = Object.freeze([
  'PROMOTER',
  'CO_PROMOTER',
  'LANDOWNER',
  'DEVELOPER',
  'COLLABORATOR',
  'AUTHORIZED_SIGNATORY',
  'CONSULTANT',
  'CONTRACTOR',
  'OTHER',
]);

export const RERA_ENTITY_TYPES = Object.freeze([
  'INDIVIDUAL',
  'PROPRIETORSHIP',
  'PARTNERSHIP',
  'LLP',
  'COMPANY',
  'TRUST',
  'SOCIETY',
  'GOVERNMENT_BODY',
  'OTHER',
]);

export const RERA_STAKEHOLDER_REVIEW_STATUSES = Object.freeze([
  'RECORD_ONLY', 'PENDING', 'REVIEWED', 'REJECTED',
]);

export const RERA_STAKEHOLDER_STATUSES = Object.freeze([
  'DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED',
]);

export const RERA_PARTICIPANT_ROLES = RERA_STAKEHOLDER_TYPES;

export const RERA_APPROVAL_RECORD_KINDS = Object.freeze([
  'PROJECT_REGISTRATION',
  'PHASE_REGISTRATION',
  'APPROVAL',
  'NOC',
  'PERMIT',
  'CERTIFICATE',
  'EXEMPTION',
  'EXTENSION',
  'OTHER',
]);

export const RERA_APPROVAL_SOURCE_TYPES = Object.freeze([
  'USER_RECORDED', 'OFFICIAL_PORTAL', 'AUTHORITY_DOCUMENT', 'IMPORTED', 'OTHER',
]);

export const RERA_APPROVAL_EVIDENCE_REVIEW_STATUSES = Object.freeze([
  'PENDING', 'ACCEPTED', 'REJECTED', 'NOT_REQUIRED',
]);

export const RERA_APPROVAL_STATUSES = Object.freeze([
  'MISSING',
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'RENEWAL_DUE',
  'EXPIRED',
  'REJECTED',
  'NOT_APPLICABLE',
]);

export const RERA_APPROVAL_WORKFLOW_STATUSES = RERA_APPROVAL_STATUSES;

export const APPROVAL_EXPIRY_STATES = Object.freeze({
  NO_EXPIRY: 'NO_EXPIRY',
  ACTIVE: 'ACTIVE',
  EXPIRING_SOON: 'EXPIRING_SOON',
  EXPIRES_TODAY: 'EXPIRES_TODAY',
  EXPIRED: 'EXPIRED',
});

export const DEFAULT_APPROVAL_EXPIRY_THRESHOLD_DAYS = 30;

export const RERA_FOUNDATION_ENUMS = Object.freeze({
  project_shapes: RERA_PROJECT_SHAPES,
  development_bases: RERA_DEVELOPMENT_BASES,
  regulatory_statuses: RERA_REGULATORY_STATUSES,
  area_units: RERA_AREA_UNITS,
  stakeholder_types: RERA_STAKEHOLDER_TYPES,
  entity_types: RERA_ENTITY_TYPES,
  participant_roles: RERA_PARTICIPANT_ROLES,
  approval_record_kinds: RERA_APPROVAL_RECORD_KINDS,
  approval_statuses: RERA_APPROVAL_STATUSES,
  approval_workflow_statuses: RERA_APPROVAL_STATUSES,
});

const DAY_MS = 86_400_000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BLOCKED_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_JSON_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 6;
const MAX_JSON_KEYS = 500;
const MAX_JSON_ARRAY = 500;
const MAX_JSON_STRING = 4_000;
const CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const asSet = (values) => new Set(values);
const PROJECT_SHAPE_SET = asSet(RERA_PROJECT_SHAPES);
const DEVELOPMENT_BASIS_SET = asSet(RERA_DEVELOPMENT_BASES);
const REGULATORY_STATUS_SET = asSet(RERA_REGULATORY_STATUSES);
const AREA_UNIT_SET = asSet(RERA_AREA_UNITS);
const STAKEHOLDER_TYPE_SET = asSet(RERA_STAKEHOLDER_TYPES);
const ENTITY_TYPE_SET = asSet(RERA_ENTITY_TYPES);
const STAKEHOLDER_REVIEW_SET = asSet(RERA_STAKEHOLDER_REVIEW_STATUSES);
const STAKEHOLDER_STATUS_SET = asSet(RERA_STAKEHOLDER_STATUSES);
const PARTICIPANT_ROLE_SET = asSet(RERA_PARTICIPANT_ROLES);
const APPROVAL_KIND_SET = asSet(RERA_APPROVAL_RECORD_KINDS);
const APPROVAL_SOURCE_SET = asSet(RERA_APPROVAL_SOURCE_TYPES);
const APPROVAL_REVIEW_SET = asSet(RERA_APPROVAL_EVIDENCE_REVIEW_STATUSES);
const APPROVAL_STATUS_SET = asSet(RERA_APPROVAL_STATUSES);

export class ReraFoundationValidationError extends Error {
  constructor(field, code, message) {
    super(message);
    this.name = 'ReraFoundationValidationError';
    this.field = field;
    this.code = code;
    this.statusCode = 400;
  }
}

const invalid = (field, code, message) => {
  throw new ReraFoundationValidationError(field, code, message);
};

const isPlainObject = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
);

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

/**
 * Every public request key that can cause a canonical persisted field to
 * change. Field-policy enforcement uses this map after normalization so a UI
 * alias or a derived value cannot bypass a hidden/read-only canonical field.
 */
export const RERA_FIELD_POLICY_INPUTS = Object.freeze({
  rera_projects: Object.freeze({
    site_id: [],
    operating_profile_revision_id: ['profile_revision_id'],
    ruleset_version_id: [],
    authority_id: ['authority'],
    authority_code: [],
    authority_name: ['authority'],
    project_code: ['code', 'internal_code'],
    name: ['project_name'],
    project_shape: ['project_type'],
    development_basis: [],
    regulatory_status: ['registration_status', 'status'],
    status_reason: [],
    registration_number: ['rera_number'],
    registration_date: [],
    registration_expiry_date: ['registration_valid_until', 'valid_until'],
    proposed_start_date: ['start_date'],
    proposed_completion_date: ['committed_completion_date', 'completion_date'],
    actual_completion_date: [],
    address: ['location', 'jurisdiction'],
    district: ['jurisdiction'],
    state: ['jurisdiction'],
    pincode: ['postal_code', 'jurisdiction'],
    latitude: ['lat'],
    longitude: ['lng', 'lon'],
    total_land_area: [],
    project_area: ['area'],
    area_unit: [],
    source_review_status: [],
    source_reference: ['portal_reference'],
    source_url: ['official_source_url', 'source_reference', 'portal_reference'],
    source_review_notes: [],
    notes: [],
    metadata: [],
  }),
  rera_phases: Object.freeze({
    site_id: [],
    rera_project_id: ['project_id'],
    authority_id: ['authority'],
    authority_code: [],
    authority_name: ['authority'],
    phase_code: ['code'],
    name: ['phase_name'],
    regulatory_status: ['status'],
    status_reason: [],
    registration_number: [],
    registration_date: [],
    registration_expiry_date: ['registration_valid_until', 'valid_until'],
    proposed_start_date: ['start_date'],
    proposed_completion_date: ['committed_completion_date', 'completion_date'],
    actual_completion_date: [],
    phase_area: ['area'],
    area_unit: [],
    notes: [],
    metadata: [],
  }),
  rera_stakeholders: Object.freeze({
    stakeholder_code: ['code'],
    stakeholder_type: ['role', 'type'],
    entity_type: ['legal_entity_type', 'role', 'type'],
    legal_name: ['name'],
    trade_name: [],
    pan: [],
    gstin: [],
    cin_or_llpin: ['cin_llpin', 'cin', 'llpin'],
    registration_number: [],
    email: ['contact_email'],
    phone: ['contact_phone'],
    address: ['registered_address'],
    authorized_signatory_name: ['authorised_signatory_name', 'contact_name'],
    record_review_status: ['review_status'],
    review_notes: [],
    status: [],
    metadata: [],
  }),
  rera_participants: Object.freeze({
    site_id: [],
    rera_project_id: ['project_id'],
    rera_project_phase_id: ['phase_id'],
    stakeholder_id: ['rera_stakeholder_id', 'entity_id'],
    participant_role: ['role', 'project_role'],
    is_primary: ['primary'],
    ownership_percentage: ['ownership_share', 'share_percentage'],
    effective_from: ['start_date', 'valid_from'],
    effective_to: ['end_date', 'valid_until'],
    basis_reference: ['basis'],
    notes: [],
  }),
  rera_approvals: Object.freeze({
    site_id: [],
    authority_id: ['authority', 'issuer'],
    compliance_item_id: [],
    name: ['approval_type', 'type'],
    licence_type: ['approval_type', 'type', 'name'],
    licence_number: ['reference_number', 'reference'],
    issue_date: ['issued_at'],
    effective_date: ['valid_from'],
    expiry_date: ['valid_until'],
    renewal_application_date: [],
    renewal_status: [],
    renewal_cost: [],
    security_deposit: [],
    conditions: [],
    responsible_person_id: ['owner_id', 'responsible_user_id'],
    verification_status: [],
    reminder_days: [],
    notes: [],
    metadata: [],
    rera_record_kind: ['record_kind', 'kind', 'approval_type', 'licence_type', 'type', 'name'],
    rera_status: ['status'],
    rera_authority_label: ['authority_label', 'authority', 'issuer'],
    rera_owner_label: ['owner_name', 'responsible_user_name', 'owner'],
    rera_project_id: ['project_id'],
    rera_project_phase_id: ['phase_id'],
    rera_ruleset_requirement_id: ['requirement_id'],
    rera_source_type: ['source_type'],
    rera_source_reference: ['source_reference'],
    rera_source_url: ['source_url', 'official_source_url', 'rera_source_reference', 'source_reference'],
    rera_source_checked_at: ['source_checked_at'],
    rera_evidence_review_status: ['review_status'],
    rera_reviewed_by: ['reviewed_by'],
    rera_reviewed_at: ['reviewed_at'],
    rera_review_notes: ['review_notes'],
  }),
});

export function buildReraFieldPolicyPayload(section, raw = {}, normalized = {}) {
  if (!isPlainObject(raw) || !isPlainObject(normalized)) {
    invalid('payload', 'INVALID_INPUT', 'Field-policy inputs must be objects');
  }
  const inputs = RERA_FIELD_POLICY_INPUTS[section];
  if (!inputs) invalid('section', 'INVALID_FIELD_POLICY_SECTION', 'Unknown RERA field-policy section');
  const payload = { ...raw };
  for (const [canonical, aliases] of Object.entries(inputs)) {
    if (own(raw, canonical) || aliases.some((alias) => own(raw, alias))) {
      payload[canonical] = normalized[canonical];
    }
  }
  return payload;
}

const read = (input, fallback, ...keys) => {
  for (const source of [input, fallback]) {
    if (!isPlainObject(source)) continue;
    for (const key of keys) {
      if (own(source, key)) return source[key];
    }
  }
  return undefined;
};

const upper = (value) => String(value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');

const text = (raw, field, max, { required = false, uppercase = false, lowercase = false } = {}) => {
  if (raw === undefined || raw === null || raw === '') {
    if (required) invalid(field, 'REQUIRED', `${field.replaceAll('_', ' ')} is required`);
    return null;
  }
  if (!['string', 'number'].includes(typeof raw)) {
    invalid(field, 'INVALID_TEXT', `${field.replaceAll('_', ' ')} must be text`);
  }
  let value = String(raw).trim();
  if (!value) {
    if (required) invalid(field, 'REQUIRED', `${field.replaceAll('_', ' ')} is required`);
    return null;
  }
  if (CONTROL_CHARACTER_RE.test(value)) {
    invalid(field, 'UNSAFE_TEXT', `${field.replaceAll('_', ' ')} contains unsupported control characters`);
  }
  if (value.length > max) {
    invalid(field, 'TEXT_TOO_LONG', `${field.replaceAll('_', ' ')} must not exceed ${max} characters`);
  }
  if (uppercase) value = value.toUpperCase();
  if (lowercase) value = value.toLowerCase();
  return value;
};

const enumValue = (raw, field, allowed, fallbackValue, aliases = {}) => {
  const candidate = raw === undefined || raw === null || raw === '' ? fallbackValue : raw;
  if (candidate === undefined || candidate === null || candidate === '') {
    invalid(field, 'REQUIRED', `${field.replaceAll('_', ' ')} is required`);
  }
  const normalized = upper(candidate);
  const mapped = aliases[normalized] || normalized;
  if (!allowed.has(mapped)) {
    invalid(field, 'UNSUPPORTED_VALUE', `Unsupported ${field.replaceAll('_', ' ')}`);
  }
  return mapped;
};

const positiveId = (raw, field, { required = false } = {}) => {
  if (raw === undefined || raw === null || raw === '') {
    if (required) invalid(field, 'REQUIRED', `${field.replaceAll('_', ' ')} is required`);
    return null;
  }
  if (!/^\d+$/.test(String(raw).trim())) invalid(field, 'INVALID_ID', `${field} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalid(field, 'INVALID_ID', `${field} must be a positive integer`);
  }
  return value;
};

const finiteNumber = (raw, field, { min = null, max = null, required = false } = {}) => {
  if (raw === undefined || raw === null || raw === '') {
    if (required) invalid(field, 'REQUIRED', `${field.replaceAll('_', ' ')} is required`);
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) invalid(field, 'INVALID_NUMBER', `${field} must be a finite number`);
  if (min !== null && value < min) invalid(field, 'OUT_OF_RANGE', `${field} must be at least ${min}`);
  if (max !== null && value > max) invalid(field, 'OUT_OF_RANGE', `${field} must not exceed ${max}`);
  return value;
};

const booleanValue = (raw, field, fallbackValue = false) => {
  if (raw === undefined || raw === null || raw === '') return fallbackValue;
  if (typeof raw === 'boolean') return raw;
  if (raw === 1 || raw === '1' || String(raw).toLowerCase() === 'true') return true;
  if (raw === 0 || raw === '0' || String(raw).toLowerCase() === 'false') return false;
  invalid(field, 'INVALID_BOOLEAN', `${field} must be boolean`);
};

const parseDate = (raw, field, { required = false } = {}) => {
  if (raw === undefined || raw === null || raw === '') {
    if (required) invalid(field, 'REQUIRED', `${field.replaceAll('_', ' ')} is required`);
    return null;
  }
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) invalid(field, 'INVALID_DATE', `${field} must be a valid date`);
    return raw.toISOString().slice(0, 10);
  }
  const value = String(raw).trim();
  if (!ISO_DATE_RE.test(value)) invalid(field, 'INVALID_DATE', `${field} must use YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    invalid(field, 'INVALID_DATE', `${field} must be a real calendar date`);
  }
  return value;
};

const parseTimestamp = (raw, field) => {
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(parsed.getTime())) invalid(field, 'INVALID_TIMESTAMP', `${field} must be a valid timestamp`);
  return parsed.toISOString();
};

const ensureOnOrAfter = (later, earlier, laterField, earlierField, { requireEarlier = false } = {}) => {
  if (!later) return;
  if (!earlier) {
    if (requireEarlier) {
      invalid(laterField, 'MISSING_START_DATE', `${earlierField} is required when ${laterField} is set`);
    }
    return;
  }
  if (later < earlier) invalid(laterField, 'DATE_ORDER', `${laterField} cannot be before ${earlierField}`);
};

const sanitizeJsonValue = (raw, field, depth, seen, counters) => {
  if (raw === null || typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) invalid(field, 'INVALID_JSON', `${field} contains a non-finite number`);
    return raw;
  }
  if (typeof raw === 'string') {
    if (CONTROL_CHARACTER_RE.test(raw)) invalid(field, 'UNSAFE_JSON', `${field} contains unsafe text`);
    if (raw.length > MAX_JSON_STRING) invalid(field, 'JSON_STRING_TOO_LONG', `${field} contains oversized text`);
    return raw;
  }
  if (depth >= MAX_JSON_DEPTH) invalid(field, 'JSON_TOO_DEEP', `${field} is too deeply nested`);
  if (typeof raw !== 'object' || raw === null) invalid(field, 'INVALID_JSON', `${field} contains unsupported data`);
  if (seen.has(raw)) invalid(field, 'CYCLIC_JSON', `${field} must not contain cycles`);
  seen.add(raw);

  let result;
  if (Array.isArray(raw)) {
    if (raw.length > MAX_JSON_ARRAY) invalid(field, 'JSON_ARRAY_TOO_LARGE', `${field} contains too many array items`);
    result = raw.map((entry) => sanitizeJsonValue(entry, field, depth + 1, seen, counters));
  } else {
    if (!isPlainObject(raw)) invalid(field, 'INVALID_JSON', `${field} must contain plain JSON objects`);
    result = {};
    for (const [key, entry] of Object.entries(raw)) {
      counters.keys += 1;
      if (counters.keys > MAX_JSON_KEYS) invalid(field, 'JSON_TOO_MANY_KEYS', `${field} contains too many keys`);
      if (BLOCKED_JSON_KEYS.has(key)) invalid(field, 'UNSAFE_JSON_KEY', `${field} contains an unsafe key`);
      if (!key || key.length > 100 || CONTROL_CHARACTER_RE.test(key)) {
        invalid(field, 'INVALID_JSON_KEY', `${field} contains an invalid key`);
      }
      result[key] = sanitizeJsonValue(entry, field, depth + 1, seen, counters);
    }
  }
  seen.delete(raw);
  return result;
};

export function sanitizeReraJsonObject(raw, field = 'metadata', fallbackValue = {}) {
  const candidate = raw === undefined || raw === null || raw === '' ? fallbackValue : raw;
  if (!isPlainObject(candidate)) invalid(field, 'INVALID_JSON_OBJECT', `${field} must be a JSON object`);
  const value = sanitizeJsonValue(candidate, field, 0, new WeakSet(), { keys: 0 });
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_JSON_BYTES) {
    invalid(field, 'JSON_TOO_LARGE', `${field} must not exceed ${MAX_JSON_BYTES} bytes`);
  }
  return value;
}

const urlValue = (raw, field) => {
  const value = text(raw, field, 2_000);
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    invalid(field, 'INVALID_URL', `${field} must be a valid HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    invalid(field, 'INVALID_URL', `${field} must be a valid HTTP(S) URL`);
  }
  return parsed.toString();
};

const isHttpUrl = (value) => {
  try {
    return ['http:', 'https:'].includes(new URL(String(value)).protocol);
  } catch {
    return false;
  }
};

const commonRegulatoryDates = (input, fallback) => {
  const registrationDate = parseDate(read(input, fallback, 'registration_date'), 'registration_date');
  const registrationExpiryDate = parseDate(
    read(input, fallback, 'registration_expiry_date', 'registration_valid_until', 'valid_until'),
    'registration_expiry_date',
  );
  const proposedStartDate = parseDate(read(input, fallback, 'proposed_start_date', 'start_date'), 'proposed_start_date');
  const proposedCompletionDate = parseDate(
    read(input, fallback, 'proposed_completion_date', 'committed_completion_date', 'completion_date'),
    'proposed_completion_date',
  );
  const actualCompletionDate = parseDate(
    read(input, fallback, 'actual_completion_date'),
    'actual_completion_date',
  );

  ensureOnOrAfter(registrationExpiryDate, registrationDate, 'registration_expiry_date', 'registration_date', {
    requireEarlier: true,
  });
  ensureOnOrAfter(proposedCompletionDate, proposedStartDate, 'proposed_completion_date', 'proposed_start_date', {
    requireEarlier: true,
  });
  ensureOnOrAfter(actualCompletionDate, proposedStartDate, 'actual_completion_date', 'proposed_start_date');

  return {
    registration_date: registrationDate,
    registration_expiry_date: registrationExpiryDate,
    proposed_start_date: proposedStartDate,
    proposed_completion_date: proposedCompletionDate,
    actual_completion_date: actualCompletionDate,
  };
};

const validateRegulatoryState = (value, { requireSourceUrl = false } = {}) => {
  const hasAuthority = Boolean(value.authority_id || value.authority_code || value.authority_name);
  if (value.regulatory_status === 'REGISTERED') {
    if (!hasAuthority) invalid('authority_id', 'REGISTERED_AUTHORITY_REQUIRED', 'Registered status requires a recorded authority');
    if (!value.registration_number) {
      invalid('registration_number', 'REGISTERED_NUMBER_REQUIRED', 'Registered status requires a registration number');
    }
    if (!value.registration_date) {
      invalid('registration_date', 'REGISTERED_DATE_REQUIRED', 'Registered status requires a registration date');
    }
    if (requireSourceUrl && !value.source_url) {
      invalid('source_url', 'REGISTERED_SOURCE_REQUIRED', 'Registered status requires an official/source URL');
    }
  }
  if (['EXEMPTION_UNDER_REVIEW', 'REVOKED'].includes(value.regulatory_status) && !value.status_reason) {
    invalid('status_reason', 'STATUS_REASON_REQUIRED', `${value.regulatory_status} requires a status reason`);
  }
  if (value.regulatory_status === 'EXPIRED' && !value.registration_expiry_date) {
    invalid('registration_expiry_date', 'EXPIRY_DATE_REQUIRED', 'Expired status requires a registration expiry date');
  }
  if (value.regulatory_status === 'COMPLETED' && !value.actual_completion_date) {
    invalid('actual_completion_date', 'COMPLETION_DATE_REQUIRED', 'Completed status requires an actual completion date');
  }
};

const jurisdictionParts = (raw) => {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'string') return { state: raw };
  if (!isPlainObject(raw)) invalid('jurisdiction', 'INVALID_JURISDICTION', 'jurisdiction must be text or an object');
  return raw;
};

export function normalizeReraProjectInput(input = {}, fallback = {}) {
  if (!isPlainObject(input) || !isPlainObject(fallback)) invalid('project', 'INVALID_INPUT', 'Project input must be an object');
  const jurisdiction = jurisdictionParts(read(input, fallback, 'jurisdiction'));
  const authorityAlias = read(input, fallback, 'authority');
  const authorityAliasIsId = authorityAlias !== undefined && authorityAlias !== null
    && /^\d+$/.test(String(authorityAlias).trim());
  const sourceReference = text(
    read(input, fallback, 'source_reference', 'portal_reference'),
    'source_reference',
    4_000,
  );
  const rawSourceUrl = read(input, fallback, 'source_url', 'official_source_url')
    ?? (sourceReference && isHttpUrl(sourceReference) ? sourceReference : null);
  const projectShape = enumValue(
    read(input, fallback, 'project_shape', 'project_type'),
    'project_shape',
    PROJECT_SHAPE_SET,
  );
  const developmentBasis = enumValue(
    read(input, fallback, 'development_basis'),
    'development_basis',
    DEVELOPMENT_BASIS_SET,
  );
  const dates = commonRegulatoryDates(input, fallback);

  const value = {
    site_id: positiveId(read(input, fallback, 'site_id'), 'site_id', { required: true }),
    operating_profile_revision_id: positiveId(
      read(input, fallback, 'operating_profile_revision_id', 'profile_revision_id'),
      'operating_profile_revision_id',
      { required: true },
    ),
    ruleset_version_id: positiveId(read(input, fallback, 'ruleset_version_id'), 'ruleset_version_id', { required: true }),
    authority_id: positiveId(
      read(input, fallback, 'authority_id') ?? (authorityAliasIsId ? authorityAlias : null),
      'authority_id',
    ),
    authority_code: text(read(input, fallback, 'authority_code'), 'authority_code', 100, { uppercase: true }),
    authority_name: text(
      read(input, fallback, 'authority_name') ?? (!authorityAliasIsId ? authorityAlias : null),
      'authority_name',
      300,
    ),
    project_code: text(read(input, fallback, 'project_code', 'code', 'internal_code'), 'project_code', 80, {
      required: true,
      uppercase: true,
    }),
    name: text(read(input, fallback, 'name', 'project_name'), 'name', 300, { required: true }),
    project_shape: projectShape,
    development_basis: developmentBasis,
    regulatory_status: enumValue(
      read(input, fallback, 'regulatory_status', 'registration_status', 'status'),
      'regulatory_status',
      REGULATORY_STATUS_SET,
      'DRAFT',
    ),
    status_reason: text(read(input, fallback, 'status_reason'), 'status_reason', 4_000),
    registration_number: text(
      read(input, fallback, 'registration_number', 'rera_number'),
      'registration_number',
      150,
    ),
    ...dates,
    address: text(
      read(input, fallback, 'address', 'location') ?? jurisdiction.address,
      'address',
      4_000,
    ),
    district: text(read(input, fallback, 'district') ?? jurisdiction.district, 'district', 100),
    state: text(
      read(input, fallback, 'state') ?? jurisdiction.state ?? jurisdiction.state_name ?? jurisdiction.state_code,
      'state',
      100,
    ),
    pincode: text(read(input, fallback, 'pincode', 'postal_code') ?? jurisdiction.pincode, 'pincode', 12),
    latitude: finiteNumber(read(input, fallback, 'latitude', 'lat'), 'latitude', { min: -90, max: 90 }),
    longitude: finiteNumber(read(input, fallback, 'longitude', 'lng', 'lon'), 'longitude', { min: -180, max: 180 }),
    total_land_area: finiteNumber(read(input, fallback, 'total_land_area'), 'total_land_area', { min: Number.EPSILON }),
    project_area: finiteNumber(read(input, fallback, 'project_area', 'area'), 'project_area', { min: Number.EPSILON }),
    area_unit: read(input, fallback, 'area_unit') === undefined || read(input, fallback, 'area_unit') === null
      || read(input, fallback, 'area_unit') === ''
      ? null
      : enumValue(read(input, fallback, 'area_unit'), 'area_unit', AREA_UNIT_SET),
    source_review_status: enumValue(
      read(input, fallback, 'source_review_status'),
      'source_review_status',
      STAKEHOLDER_REVIEW_SET,
      'RECORD_ONLY',
    ),
    source_reference: sourceReference,
    source_url: urlValue(rawSourceUrl, 'source_url'),
    source_review_notes: text(read(input, fallback, 'source_review_notes'), 'source_review_notes', 4_000),
    notes: text(read(input, fallback, 'notes'), 'notes', 10_000),
    metadata: sanitizeReraJsonObject(read(input, fallback, 'metadata'), 'metadata'),
  };

  if (value.project_area !== null && value.total_land_area !== null
      && value.project_area > value.total_land_area) {
    invalid('project_area', 'AREA_EXCEEDS_TOTAL', 'project_area cannot exceed total_land_area');
  }
  validateRegulatoryState(value, { requireSourceUrl: true });
  return value;
}

export function normalizeReraPhaseInput(input = {}, fallback = {}) {
  if (!isPlainObject(input) || !isPlainObject(fallback)) invalid('phase', 'INVALID_INPUT', 'Phase input must be an object');
  const authorityAlias = read(input, fallback, 'authority');
  const authorityAliasIsId = authorityAlias !== undefined && authorityAlias !== null
    && /^\d+$/.test(String(authorityAlias).trim());
  const dates = commonRegulatoryDates(input, fallback);
  const value = {
    site_id: positiveId(read(input, fallback, 'site_id'), 'site_id', { required: true }),
    rera_project_id: positiveId(
      read(input, fallback, 'rera_project_id', 'project_id'),
      'rera_project_id',
      { required: true },
    ),
    authority_id: positiveId(
      read(input, fallback, 'authority_id') ?? (authorityAliasIsId ? authorityAlias : null),
      'authority_id',
    ),
    authority_code: text(read(input, fallback, 'authority_code'), 'authority_code', 100, { uppercase: true }),
    authority_name: text(
      read(input, fallback, 'authority_name') ?? (!authorityAliasIsId ? authorityAlias : null),
      'authority_name',
      300,
    ),
    phase_code: text(read(input, fallback, 'phase_code', 'code'), 'phase_code', 80, {
      required: true,
      uppercase: true,
    }),
    name: text(read(input, fallback, 'name', 'phase_name'), 'name', 300, { required: true }),
    regulatory_status: enumValue(
      read(input, fallback, 'regulatory_status', 'status'),
      'regulatory_status',
      REGULATORY_STATUS_SET,
      'DRAFT',
    ),
    status_reason: text(read(input, fallback, 'status_reason'), 'status_reason', 4_000),
    registration_number: text(read(input, fallback, 'registration_number'), 'registration_number', 150),
    ...dates,
    phase_area: finiteNumber(read(input, fallback, 'phase_area', 'area'), 'phase_area', { min: Number.EPSILON }),
    area_unit: read(input, fallback, 'area_unit') === undefined || read(input, fallback, 'area_unit') === null
      || read(input, fallback, 'area_unit') === ''
      ? null
      : enumValue(read(input, fallback, 'area_unit'), 'area_unit', AREA_UNIT_SET),
    notes: text(read(input, fallback, 'notes'), 'notes', 10_000),
    metadata: sanitizeReraJsonObject(read(input, fallback, 'metadata'), 'metadata'),
  };
  validateRegulatoryState(value);
  return value;
}

const PARTICIPANT_ROLE_ALIASES = Object.freeze({
  AUTHORISED_SIGNATORY: 'AUTHORIZED_SIGNATORY',
  POA_HOLDER: 'AUTHORIZED_SIGNATORY',
  POWER_OF_ATTORNEY_HOLDER: 'AUTHORIZED_SIGNATORY',
  PROFESSIONAL: 'CONSULTANT',
  ADVISOR: 'CONSULTANT',
  BUILDER: 'DEVELOPER',
  JOINT_PROMOTER: 'CO_PROMOTER',
  OWNER: 'LANDOWNER',
});

export function normalizeReraStakeholderInput(input = {}, fallback = {}) {
  if (!isPlainObject(input) || !isPlainObject(fallback)) {
    invalid('stakeholder', 'INVALID_INPUT', 'Stakeholder input must be an object');
  }
  const rawType = read(input, fallback, 'stakeholder_type', 'role', 'type');
  const rawEntityType = read(input, fallback, 'entity_type', 'legal_entity_type')
    ?? (ENTITY_TYPE_SET.has(upper(rawType)) ? rawType : undefined);
  const stakeholderTypeRaw = ENTITY_TYPE_SET.has(upper(rawType)) ? 'OTHER' : rawType;
  const rawAddress = read(input, fallback, 'address', 'registered_address');
  const address = typeof rawAddress === 'string'
    ? { formatted: text(rawAddress, 'registered_address', 4_000) }
    : sanitizeReraJsonObject(rawAddress, 'address');
  const recordReviewStatus = enumValue(
    read(input, fallback, 'record_review_status', 'review_status'),
    'record_review_status',
    STAKEHOLDER_REVIEW_SET,
    'RECORD_ONLY',
  );
  const reviewedAt = parseTimestamp(read(input, fallback, 'reviewed_at'), 'reviewed_at');
  if (recordReviewStatus === 'REVIEWED' && !reviewedAt) {
    invalid('reviewed_at', 'REVIEW_TIMESTAMP_REQUIRED', 'Reviewed stakeholder records require reviewed_at');
  }

  return {
    stakeholder_code: text(read(input, fallback, 'stakeholder_code', 'code'), 'stakeholder_code', 80, {
      uppercase: true,
    }),
    stakeholder_type: enumValue(
      stakeholderTypeRaw,
      'stakeholder_type',
      STAKEHOLDER_TYPE_SET,
      'OTHER',
      PARTICIPANT_ROLE_ALIASES,
    ),
    entity_type: enumValue(rawEntityType, 'entity_type', ENTITY_TYPE_SET),
    legal_name: text(read(input, fallback, 'legal_name', 'name'), 'legal_name', 300, { required: true }),
    trade_name: text(read(input, fallback, 'trade_name'), 'trade_name', 300),
    pan: text(read(input, fallback, 'pan'), 'pan', 20, { uppercase: true }),
    gstin: text(read(input, fallback, 'gstin'), 'gstin', 20, { uppercase: true }),
    cin_or_llpin: text(
      read(input, fallback, 'cin_or_llpin', 'cin_llpin', 'cin', 'llpin'),
      'cin_or_llpin',
      40,
      { uppercase: true },
    ),
    registration_number: text(read(input, fallback, 'registration_number'), 'registration_number', 100),
    email: text(read(input, fallback, 'email', 'contact_email'), 'email', 255, { lowercase: true }),
    phone: text(read(input, fallback, 'phone', 'contact_phone'), 'phone', 30),
    address,
    authorized_signatory_name: text(
      read(input, fallback, 'authorized_signatory_name', 'authorised_signatory_name', 'contact_name'),
      'authorized_signatory_name',
      255,
    ),
    record_review_status: recordReviewStatus,
    review_notes: text(read(input, fallback, 'review_notes'), 'review_notes', 4_000),
    reviewed_by: positiveId(read(input, fallback, 'reviewed_by'), 'reviewed_by'),
    reviewed_at: reviewedAt,
    status: enumValue(
      read(input, fallback, 'status'),
      'status',
      STAKEHOLDER_STATUS_SET,
      'ACTIVE',
    ),
    metadata: sanitizeReraJsonObject(read(input, fallback, 'metadata'), 'metadata'),
  };
}

export function normalizeReraParticipantInput(input = {}, fallback = {}) {
  if (!isPlainObject(input) || !isPlainObject(fallback)) {
    invalid('participant', 'INVALID_INPUT', 'Participant input must be an object');
  }
  const effectiveFrom = parseDate(
    read(input, fallback, 'effective_from', 'start_date', 'valid_from'),
    'effective_from',
  );
  const effectiveTo = parseDate(
    read(input, fallback, 'effective_to', 'end_date', 'valid_until'),
    'effective_to',
  );
  ensureOnOrAfter(effectiveTo, effectiveFrom, 'effective_to', 'effective_from', { requireEarlier: true });

  return {
    site_id: positiveId(read(input, fallback, 'site_id'), 'site_id', { required: true }),
    rera_project_id: positiveId(
      read(input, fallback, 'rera_project_id', 'project_id'),
      'rera_project_id',
      { required: true },
    ),
    rera_project_phase_id: positiveId(
      read(input, fallback, 'rera_project_phase_id', 'phase_id'),
      'rera_project_phase_id',
    ),
    stakeholder_id: positiveId(
      read(input, fallback, 'stakeholder_id', 'rera_stakeholder_id', 'entity_id'),
      'stakeholder_id',
      { required: true },
    ),
    participant_role: enumValue(
      read(input, fallback, 'participant_role', 'role', 'project_role'),
      'participant_role',
      PARTICIPANT_ROLE_SET,
      undefined,
      PARTICIPANT_ROLE_ALIASES,
    ),
    is_primary: booleanValue(read(input, fallback, 'is_primary', 'primary'), 'is_primary', false),
    ownership_percentage: finiteNumber(
      read(input, fallback, 'ownership_percentage', 'ownership_share', 'share_percentage'),
      'ownership_percentage',
      { min: 0, max: 100 },
    ),
    effective_from: effectiveFrom,
    effective_to: effectiveTo,
    basis_reference: text(read(input, fallback, 'basis_reference', 'basis'), 'basis_reference', 4_000),
    notes: text(read(input, fallback, 'notes'), 'notes', 10_000),
  };
}

const APPROVAL_REVIEW_ALIASES = Object.freeze({
  NOT_REVIEWED: 'PENDING',
  UNDER_REVIEW: 'PENDING',
  REVIEWED: 'ACCEPTED',
  VERIFIED: 'ACCEPTED',
  RETURNED: 'REJECTED',
});

export function classifyApprovalRecordKind(rawType, explicitKind = null) {
  if (explicitKind !== undefined && explicitKind !== null && explicitKind !== '') {
    return enumValue(explicitKind, 'rera_record_kind', APPROVAL_KIND_SET);
  }
  const value = upper(rawType);
  if (/PROJECT.*REGISTRATION|REGISTRATION.*PROJECT/.test(value)) return 'PROJECT_REGISTRATION';
  if (/PHASE.*REGISTRATION|REGISTRATION.*PHASE/.test(value)) return 'PHASE_REGISTRATION';
  if (/(^|_)NOC($|_)/.test(value) || value.includes('NO_OBJECTION')) return 'NOC';
  if (value.includes('PERMIT')) return 'PERMIT';
  if (value.includes('CERTIFICATE')) return 'CERTIFICATE';
  if (value.includes('EXEMPT')) return 'EXEMPTION';
  if (value.includes('EXTENSION')) return 'EXTENSION';
  return 'APPROVAL';
}

const reminderDays = (raw) => {
  if (raw === undefined || raw === null || raw === '') return [180, 90, 60, 30, 15, 7, 0];
  if (!Array.isArray(raw) || raw.length > 32) {
    invalid('reminder_days', 'INVALID_REMINDERS', 'reminder_days must be an array with at most 32 entries');
  }
  const values = raw.map((entry) => {
    if (!/^\d+$/.test(String(entry).trim())) {
      invalid('reminder_days', 'INVALID_REMINDERS', 'reminder_days must contain non-negative integers');
    }
    const value = Number(entry);
    if (!Number.isSafeInteger(value) || value < 0 || value > 3_650) {
      invalid('reminder_days', 'INVALID_REMINDERS', 'reminder_days values must be between 0 and 3650');
    }
    return value;
  });
  return [...new Set(values)].sort((left, right) => right - left);
};

export function normalizeReraApprovalInput(input = {}, fallback = {}) {
  if (!isPlainObject(input) || !isPlainObject(fallback)) {
    invalid('approval', 'INVALID_INPUT', 'Approval input must be an object');
  }
  const approvalType = text(
    read(input, fallback, 'approval_type', 'licence_type', 'type', 'name'),
    'approval_type',
    120,
    { required: true },
  );
  const authorityAlias = read(input, fallback, 'authority', 'issuer');
  const authorityAliasIsId = authorityAlias !== undefined && authorityAlias !== null
    && /^\d+$/.test(String(authorityAlias).trim());
  const issueDate = parseDate(read(input, fallback, 'issue_date', 'issued_at'), 'issue_date');
  const effectiveDate = parseDate(read(input, fallback, 'effective_date', 'valid_from'), 'effective_date');
  const expiryDate = parseDate(read(input, fallback, 'expiry_date', 'valid_until'), 'expiry_date');
  ensureOnOrAfter(expiryDate, effectiveDate || issueDate, 'expiry_date', effectiveDate ? 'effective_date' : 'issue_date');

  const reraProjectId = positiveId(
    read(input, fallback, 'rera_project_id', 'project_id'),
    'rera_project_id',
    { required: true },
  );
  const reraPhaseId = positiveId(
    read(input, fallback, 'rera_project_phase_id', 'phase_id'),
    'rera_project_phase_id',
  );
  if (reraPhaseId && !reraProjectId) {
    invalid('rera_project_id', 'PROJECT_REQUIRED_FOR_PHASE', 'A phase-scoped approval requires rera_project_id');
  }

  const reviewStatus = enumValue(
    read(input, fallback, 'rera_evidence_review_status', 'review_status'),
    'rera_evidence_review_status',
    APPROVAL_REVIEW_SET,
    'PENDING',
    APPROVAL_REVIEW_ALIASES,
  );
  const reviewedBy = positiveId(read(input, fallback, 'rera_reviewed_by', 'reviewed_by'), 'rera_reviewed_by');
  const reviewedAt = parseTimestamp(read(input, fallback, 'rera_reviewed_at', 'reviewed_at'), 'rera_reviewed_at');
  if (['ACCEPTED', 'REJECTED'].includes(reviewStatus) && (!reviewedBy || !reviewedAt)) {
    invalid(
      'rera_evidence_review_status',
      'REVIEW_ACTOR_REQUIRED',
      'Accepted or rejected evidence review requires rera_reviewed_by and rera_reviewed_at',
    );
  }

  const sourceReference = text(
    read(input, fallback, 'rera_source_reference', 'source_reference'),
    'rera_source_reference',
    4_000,
  );
  const sourceUrlRaw = read(input, fallback, 'rera_source_url', 'source_url', 'official_source_url')
    ?? (sourceReference && isHttpUrl(sourceReference) ? sourceReference : null);
  const reraStatusRaw = read(input, fallback, 'rera_status', 'status');

  const value = {
    site_id: positiveId(read(input, fallback, 'site_id'), 'site_id', { required: true }),
    authority_id: positiveId(
      read(input, fallback, 'authority_id') ?? (authorityAliasIsId ? authorityAlias : null),
      'authority_id',
    ),
    compliance_item_id: positiveId(read(input, fallback, 'compliance_item_id'), 'compliance_item_id'),
    name: text(read(input, fallback, 'name', 'approval_type', 'type'), 'name', 300, { required: true }),
    licence_type: approvalType,
    licence_number: text(
      read(input, fallback, 'licence_number', 'reference_number', 'reference'),
      'licence_number',
      150,
    ),
    issue_date: issueDate,
    effective_date: effectiveDate,
    expiry_date: expiryDate,
    renewal_application_date: parseDate(
      read(input, fallback, 'renewal_application_date'),
      'renewal_application_date',
    ),
    renewal_status: text(
      read(input, fallback, 'renewal_status'),
      'renewal_status',
      40,
      { uppercase: true },
    ) || 'NOT_STARTED',
    renewal_cost: finiteNumber(read(input, fallback, 'renewal_cost'), 'renewal_cost', { min: 0 }) ?? 0,
    security_deposit: finiteNumber(read(input, fallback, 'security_deposit'), 'security_deposit', { min: 0 }) ?? 0,
    conditions: text(read(input, fallback, 'conditions'), 'conditions', 10_000),
    responsible_person_id: positiveId(
      read(input, fallback, 'responsible_person_id', 'owner_id', 'responsible_user_id'),
      'responsible_person_id',
    ),
    verification_status: text(
      read(input, fallback, 'verification_status'),
      'verification_status',
      30,
      { uppercase: true },
    ) || 'UNVERIFIED',
    reminder_days: reminderDays(read(input, fallback, 'reminder_days')),
    notes: text(read(input, fallback, 'notes'), 'notes', 10_000),
    metadata: sanitizeReraJsonObject(read(input, fallback, 'metadata'), 'metadata'),
    rera_record_kind: classifyApprovalRecordKind(
      approvalType,
      read(input, fallback, 'rera_record_kind', 'record_kind', 'kind'),
    ),
    rera_status: enumValue(reraStatusRaw, 'rera_status', APPROVAL_STATUS_SET, 'DRAFT'),
    rera_authority_label: text(
      read(input, fallback, 'rera_authority_label', 'authority_label')
        ?? (!authorityAliasIsId ? authorityAlias : null),
      'rera_authority_label',
      300,
    ),
    rera_owner_label: text(
      read(input, fallback, 'rera_owner_label', 'owner_name', 'responsible_user_name', 'owner'),
      'rera_owner_label',
      300,
    ),
    rera_project_id: reraProjectId,
    rera_project_phase_id: reraPhaseId,
    rera_ruleset_requirement_id: positiveId(
      read(input, fallback, 'rera_ruleset_requirement_id', 'requirement_id'),
      'rera_ruleset_requirement_id',
    ),
    rera_source_type: enumValue(
      read(input, fallback, 'rera_source_type', 'source_type'),
      'rera_source_type',
      APPROVAL_SOURCE_SET,
      'USER_RECORDED',
    ),
    rera_source_reference: sourceReference,
    rera_source_url: urlValue(sourceUrlRaw, 'rera_source_url'),
    rera_source_checked_at: parseTimestamp(
      read(input, fallback, 'rera_source_checked_at', 'source_checked_at'),
      'rera_source_checked_at',
    ),
    rera_evidence_review_status: reviewStatus,
    rera_reviewed_by: reviewedBy,
    rera_reviewed_at: reviewedAt,
    rera_review_notes: text(read(input, fallback, 'rera_review_notes', 'review_notes'), 'rera_review_notes', 4_000),
  };

  // Mirror migration 094's compliance-sensitive state constraints at the API
  // boundary so malformed claims produce a useful 400 instead of a database
  // constraint failure. These checks validate recorded evidence only; they do
  // not infer legal applicability or authority verification.
  if (value.rera_status === 'APPROVED') {
    if (!value.authority_id && !value.rera_authority_label) {
      invalid('authority', 'APPROVED_AUTHORITY_REQUIRED', 'Approved status requires a recorded authority');
    }
    if (!value.licence_number) {
      invalid('reference_number', 'APPROVED_REFERENCE_REQUIRED', 'Approved status requires a reference number');
    }
    if (!value.effective_date && !value.issue_date) {
      invalid('issue_date', 'APPROVED_DATE_REQUIRED', 'Approved status requires an issue or effective date');
    }
  }
  if (['EXPIRED', 'RENEWAL_DUE'].includes(value.rera_status) && !value.expiry_date) {
    invalid('expiry_date', 'EXPIRY_DATE_REQUIRED', `${value.rera_status} requires an expiry date`);
  }
  if (value.rera_status === 'NOT_APPLICABLE'
      && (!value.rera_reviewed_by || !value.rera_reviewed_at || !value.rera_review_notes)) {
    invalid(
      'rera_status',
      'NOT_APPLICABLE_REVIEW_REQUIRED',
      'Not applicable status requires a reviewer, review time, and reason',
    );
  }

  return value;
}

const calendarDate = (raw, field) => {
  if (raw === undefined || raw === null || raw === '') return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) invalid(field, 'INVALID_DATE', `${field} must be a valid date`);
    return raw.toISOString().slice(0, 10);
  }
  const candidate = String(raw).slice(0, 10);
  return parseDate(candidate, field);
};

/**
 * Derive a display/attention state from an explicitly recorded expiry date.
 * The warning threshold is product configuration, not a statutory deadline.
 */
export function deriveApprovalExpiry(input = {}, options = {}) {
  const config = isPlainObject(input)
    ? input
    : { ...options, expiryDate: input };
  const expiryDate = calendarDate(
    config.expiryDate ?? config.expiry_date ?? config.validUntil ?? config.valid_until,
    'expiry_date',
  );
  const asOfDate = calendarDate(config.today ?? config.asOfDate ?? config.as_of_date ?? new Date(), 'today');
  const thresholdRaw = config.thresholdDays ?? config.threshold_days
    ?? options.thresholdDays ?? options.threshold_days
    ?? DEFAULT_APPROVAL_EXPIRY_THRESHOLD_DAYS;
  if (!/^\d+$/.test(String(thresholdRaw).trim())) {
    invalid('threshold_days', 'INVALID_THRESHOLD', 'threshold_days must be a non-negative integer');
  }
  const thresholdDays = Number(thresholdRaw);
  if (!Number.isSafeInteger(thresholdDays) || thresholdDays < 0 || thresholdDays > 3_650) {
    invalid('threshold_days', 'INVALID_THRESHOLD', 'threshold_days must be between 0 and 3650');
  }

  if (!expiryDate) {
    return {
      state: APPROVAL_EXPIRY_STATES.NO_EXPIRY,
      status: APPROVAL_EXPIRY_STATES.NO_EXPIRY,
      expiry_date: null,
      as_of_date: asOfDate,
      threshold_days: thresholdDays,
      days_remaining: null,
      is_expired: false,
      is_expiring_soon: false,
      needs_attention: false,
    };
  }

  const daysRemaining = Math.round((
    Date.parse(`${expiryDate}T00:00:00.000Z`) - Date.parse(`${asOfDate}T00:00:00.000Z`)
  ) / DAY_MS);
  let state = APPROVAL_EXPIRY_STATES.ACTIVE;
  if (daysRemaining < 0) state = APPROVAL_EXPIRY_STATES.EXPIRED;
  else if (daysRemaining === 0) state = APPROVAL_EXPIRY_STATES.EXPIRES_TODAY;
  else if (daysRemaining <= thresholdDays) state = APPROVAL_EXPIRY_STATES.EXPIRING_SOON;

  return {
    state,
    status: state,
    expiry_date: expiryDate,
    as_of_date: asOfDate,
    threshold_days: thresholdDays,
    days_remaining: daysRemaining,
    is_expired: state === APPROVAL_EXPIRY_STATES.EXPIRED,
    is_expiring_soon: [
      APPROVAL_EXPIRY_STATES.EXPIRING_SOON,
      APPROVAL_EXPIRY_STATES.EXPIRES_TODAY,
    ].includes(state),
    needs_attention: state !== APPROVAL_EXPIRY_STATES.ACTIVE,
  };
}

export const normalizeProjectInput = normalizeReraProjectInput;
export const normalizePhaseInput = normalizeReraPhaseInput;
export const normalizeStakeholderInput = normalizeReraStakeholderInput;
export const normalizeParticipantInput = normalizeReraParticipantInput;
export const normalizeApprovalInput = normalizeReraApprovalInput;
export const deriveApprovalExpiryStatus = deriveApprovalExpiry;
