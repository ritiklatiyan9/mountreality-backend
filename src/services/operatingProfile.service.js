import {
  ALL_SITE_POLICY_MODULES,
  resolvePolicyFromProfile,
  SITE_POLICY_CAPABILITY_KEYS,
  validateFieldPolicyPayload,
} from './sitePolicy.service.js';
import {
  INDIA_RERA_CENTRAL_RULESET_CODE,
  rulesetMatchesIndiaJurisdiction,
} from './jurisdiction.service.js';

export const OPERATING_PROFILE_OPTIONS = Object.freeze({
  operating_models: [
    { value: 'GENERIC_LAND_DEVELOPER', label: 'Generic Land Developer' },
    { value: 'DEVELOPMENT_AUTHORISED_BUILDER', label: 'Development Authorised Builder' },
    { value: 'RERA_PROJECT_PROMOTER', label: 'RERA Project Promoter' },
    { value: 'RERA_ONGOING_PROJECT_REGULARISATION', label: 'Ongoing Project Regularisation' },
  ],
  development_bases: [
    { value: 'LANDOWNER', label: 'Landowner' },
    { value: 'DEVELOPMENT_AGREEMENT', label: 'Development Agreement' },
    { value: 'JOINT_DEVELOPMENT_AGREEMENT', label: 'Joint Development Agreement' },
    { value: 'COLLABORATION_AGREEMENT', label: 'Collaboration Agreement' },
    { value: 'CO_PROMOTER', label: 'Co-promoter' },
    { value: 'POWER_OF_ATTORNEY', label: 'Power of Attorney' },
    { value: 'OTHER', label: 'Other' },
  ],
  project_shapes: [
    { value: 'PLOTTED_DEVELOPMENT', label: 'Plotted Development' },
    { value: 'APARTMENT', label: 'Apartment' },
    { value: 'COMMERCIAL', label: 'Commercial' },
    { value: 'MIXED_USE', label: 'Mixed Use' },
  ],
  regulatory_statuses: [
    'DRAFT', 'APPLICABILITY_UNDER_REVIEW', 'EXEMPTION_UNDER_REVIEW',
    'APPLICATION_IN_PREPARATION', 'FILED', 'REGISTERED', 'AMENDMENT_PENDING',
    'EXTENSION_PENDING', 'EXPIRED', 'LAPSED', 'REVOKED', 'COMPLETED',
  ].map((value) => ({ value, label: value === 'REGISTERED' ? 'Registration Recorded' : value.replaceAll('_', ' ').toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()) })),
  project_structures: [
    { value: 'SINGLE_PROJECT', label: 'Single Project' },
    { value: 'PHASE_WISE', label: 'Phase-wise' },
    { value: 'MULTIPLE_RERA_PROJECTS', label: 'Multiple RERA Projects' },
  ],
  finance_payment_modes: [
    { value: 'ALL_MODES', label: 'All payment modes' },
    { value: 'BANK_ONLY', label: 'Bank only' },
  ],
});

const allowed = Object.freeze({
  operating_model: new Set(OPERATING_PROFILE_OPTIONS.operating_models.map((row) => row.value)),
  development_basis: new Set(OPERATING_PROFILE_OPTIONS.development_bases.map((row) => row.value)),
  project_shape: new Set(OPERATING_PROFILE_OPTIONS.project_shapes.map((row) => row.value)),
  regulatory_status: new Set(OPERATING_PROFILE_OPTIONS.regulatory_statuses.map((row) => row.value)),
  project_structure: new Set(OPERATING_PROFILE_OPTIONS.project_structures.map((row) => row.value)),
  finance_payment_mode: new Set(OPERATING_PROFILE_OPTIONS.finance_payment_modes.map((row) => row.value)),
});

const text = (value, max = 255) => {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized.slice(0, max) : null;
};

const list = (value) => (Array.isArray(value) ? [...new Set(value.map((item) => text(item, 100)).filter(Boolean))] : []);

const SAFE_POLICY_KEY = /^[a-z][a-z0-9_.-]{0,99}$/i;
const BLOCKED_POLICY_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const POLICY_MAX_BYTES = 64 * 1024;

const policyError = (field, message) => {
  const error = new Error(message);
  error.statusCode = 400;
  error.field = field;
  throw error;
};

const plainObject = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const boundedPolicyObject = (value, field) => {
  if (value === undefined || value === null) return {};
  if (!plainObject(value)) policyError(field, `${field.replaceAll('_', ' ')} must be a JSON object`);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    policyError(field, `${field.replaceAll('_', ' ')} must contain valid JSON data`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > POLICY_MAX_BYTES) {
    policyError(field, `${field.replaceAll('_', ' ')} must not exceed ${POLICY_MAX_BYTES} bytes`);
  }

  let keyCount = 0;
  const sanitize = (entry, depth = 0) => {
    if (entry === null || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) policyError(field, `${field.replaceAll('_', ' ')} contains an invalid number`);
      return entry;
    }
    if (typeof entry === 'string') return entry.slice(0, 4000);
    if (depth >= 6) policyError(field, `${field.replaceAll('_', ' ')} is too deeply nested`);
    if (Array.isArray(entry)) {
      if (entry.length > 500) policyError(field, `${field.replaceAll('_', ' ')} contains too many array items`);
      return entry.map((item) => sanitize(item, depth + 1));
    }
    if (!plainObject(entry)) policyError(field, `${field.replaceAll('_', ' ')} contains unsupported data`);
    const result = {};
    for (const [key, item] of Object.entries(entry)) {
      keyCount += 1;
      if (keyCount > 500) policyError(field, `${field.replaceAll('_', ' ')} contains too many keys`);
      if (!SAFE_POLICY_KEY.test(key) || BLOCKED_POLICY_KEYS.has(key)) {
        policyError(field, `${field.replaceAll('_', ' ')} contains an invalid key`);
      }
      result[key] = sanitize(item, depth + 1);
    }
    return result;
  };
  return sanitize(value);
};

const normalizeModuleOverrides = (value) => {
  const result = boundedPolicyObject(value, 'module_overrides');
  const known = new Set(ALL_SITE_POLICY_MODULES);
  for (const [key, setting] of Object.entries(result)) {
    if (!known.has(key)) policyError('module_overrides', `Unknown module override: ${key}`);
    if (typeof setting === 'boolean') continue;
    if (!plainObject(setting) || typeof setting.enabled !== 'boolean'
        || Object.keys(setting).some((property) => property !== 'enabled')) {
      policyError('module_overrides', `${key} must be boolean or { enabled: boolean }`);
    }
  }
  return result;
};

const normalizeTerminologyOverrides = (value) => {
  const result = boundedPolicyObject(value, 'terminology_overrides');
  for (const [key, label] of Object.entries(result)) {
    if (typeof label !== 'string' || !label.trim() || label.length > 120) {
      policyError('terminology_overrides', `${key} must be a non-empty label of at most 120 characters`);
    }
    result[key] = label.trim();
  }
  return result;
};

const normalizeCapabilityOverrides = (value) => {
  const result = boundedPolicyObject(value, 'capability_overrides');
  const known = new Set(SITE_POLICY_CAPABILITY_KEYS);
  for (const [key, enabled] of Object.entries(result)) {
    if (!known.has(key)) policyError('capability_overrides', `Unknown capability override: ${key}`);
    if (typeof enabled !== 'boolean') policyError('capability_overrides', `${key} must be boolean`);
  }
  return result;
};

const normalizeFieldOverrides = (value) => {
  const bounded = boundedPolicyObject(value, 'field_policy_overrides');
  const validation = validateFieldPolicyPayload(bounded);
  if (!validation.valid) policyError('field_policy_overrides', validation.errors[0]);
  return validation.value;
};

export function normalizeOperatingProfileInput(input = {}, fallback = {}) {
  if (!plainObject(input) || !plainObject(fallback)) {
    policyError('profile', 'Operating profile input must be a JSON object');
  }
  const pick = (field, defaultValue = null) => {
    if (Object.prototype.hasOwnProperty.call(input, field)) return input[field];
    if (Object.prototype.hasOwnProperty.call(fallback, field)) return fallback[field];
    return defaultValue;
  };
  const result = {
    operating_model: text(pick('operating_model', 'GENERIC_LAND_DEVELOPER'), 80),
    jurisdiction_country: text(pick('jurisdiction_country', 'INDIA'), 100) || 'INDIA',
    jurisdiction_state: text(pick('jurisdiction_state'), 100),
    authority_code: text(pick('authority_code'), 100),
    authority_name: text(pick('authority_name'), 300),
    district: text(pick('district'), 100),
    development_basis: text(pick('development_basis', 'OTHER'), 80),
    development_basis_notes: text(pick('development_basis_notes'), 4000),
    project_shape: text(pick('project_shape', 'PLOTTED_DEVELOPMENT'), 80),
    regulatory_status: text(pick('regulatory_status', 'APPLICABILITY_UNDER_REVIEW'), 80),
    project_structure: text(pick('project_structure', 'SINGLE_PROJECT'), 80),
    finance_payment_mode: text(pick('finance_payment_mode', 'ALL_MODES'), 20),
    fund_control_modes: list(pick('fund_control_modes', [])),
    ruleset_version_id: Number.isSafeInteger(Number(pick('ruleset_version_id')))
      && Number(pick('ruleset_version_id')) > 0 ? Number(pick('ruleset_version_id')) : null,
    module_overrides: normalizeModuleOverrides(pick('module_overrides', {})),
    terminology_overrides: normalizeTerminologyOverrides(pick('terminology_overrides', {})),
    field_policy_overrides: normalizeFieldOverrides(pick('field_policy_overrides', {})),
    capability_overrides: normalizeCapabilityOverrides(pick('capability_overrides', {})),
    workflow_policy_overrides: boundedPolicyObject(pick('workflow_policy_overrides', {}), 'workflow_policy_overrides'),
    change_reason: text(pick('change_reason'), 4000),
  };

  for (const [field, values] of Object.entries(allowed)) {
    if (!values.has(result[field])) {
      const error = new Error(`Unsupported ${field.replaceAll('_', ' ')}`);
      error.statusCode = 400;
      error.field = field;
      throw error;
    }
  }
  return result;
}

const issue = (field, code, message) => ({ field, code, message });
const RULESET_OPERATING_MODELS = new Set([
  'RERA_PROJECT_PROMOTER',
  'RERA_ONGOING_PROJECT_REGULARISATION',
]);

/**
 * Domain validation deliberately checks configuration completeness only. It
 * does not encode legal deadlines, fees, thresholds, forms or conclusions.
 */
export async function validateOperatingProfile(profile, { db, organizationId, siteId }) {
  const errors = [];
  const warnings = [];
  if (!profile.operating_model) errors.push(issue('operating_model', 'REQUIRED', 'Select an operating model.'));
  if (!profile.development_basis) errors.push(issue('development_basis', 'REQUIRED', 'Select a development basis.'));
  if (!profile.project_shape) errors.push(issue('project_shape', 'REQUIRED', 'Select a project shape.'));
  if (!profile.project_structure) errors.push(issue('project_structure', 'REQUIRED', 'Select a project structure.'));
  if (!profile.finance_payment_mode) errors.push(issue('finance_payment_mode', 'REQUIRED', 'Select a finance payment mode.'));

  const regulatoryWorkflow = !['DRAFT', 'APPLICABILITY_UNDER_REVIEW', 'EXEMPTION_UNDER_REVIEW'].includes(profile.regulatory_status);
  if (regulatoryWorkflow && !profile.jurisdiction_state) {
    errors.push(issue('jurisdiction_state', 'REQUIRED_FOR_REGULATORY_WORKFLOW', 'Record the confirmed jurisdiction before advancing this status.'));
  }
  if (regulatoryWorkflow && !profile.authority_name && !profile.authority_code) {
    errors.push(issue('authority_name', 'AUTHORITY_REQUIRED', 'Select or record the confirmed authority before advancing this status.'));
  }

  if (profile.ruleset_version_id) {
    const { rows } = await db.query(
      `SELECT rv.id,rv.lifecycle_status,rv.source_review_status,
              rv.effective_from,rv.effective_to,r.organization_id,r.code,
              r.jurisdiction_country_code,r.jurisdiction_state_code
         FROM rera_ruleset_versions rv
         JOIN rera_rulesets r ON r.id=rv.ruleset_id
        WHERE rv.id=$1 AND (r.organization_id IS NULL OR r.organization_id=$2)
          AND rv.deleted_at IS NULL AND r.deleted_at IS NULL AND r.is_active=TRUE LIMIT 1`,
      [profile.ruleset_version_id, organizationId]
    );
    const selectedRuleset = rows[0];
    if (!selectedRuleset) errors.push(issue('ruleset_version_id', 'RULESET_NOT_AVAILABLE', 'The selected ruleset version is not available to this organization.'));
    else if (selectedRuleset.lifecycle_status !== 'PUBLISHED') {
      errors.push(issue('ruleset_version_id', 'RULESET_NOT_PUBLISHED', 'Select a published ruleset version before this profile advances.'));
    } else if (selectedRuleset.effective_from && new Date(selectedRuleset.effective_from) > new Date()) {
      errors.push(issue('ruleset_version_id', 'RULESET_NOT_EFFECTIVE', 'The selected ruleset version is not effective yet.'));
    } else if (selectedRuleset.effective_to && new Date(selectedRuleset.effective_to) <= new Date()) {
      errors.push(issue('ruleset_version_id', 'RULESET_EXPIRED', 'The selected ruleset version is no longer effective.'));
    } else if (RULESET_OPERATING_MODELS.has(profile.operating_model)
        && !rulesetMatchesIndiaJurisdiction({
          profileCountry: profile.jurisdiction_country,
          profileState: profile.jurisdiction_state,
          rulesetCountry: selectedRuleset.jurisdiction_country_code,
          rulesetState: selectedRuleset.jurisdiction_state_code,
          allowCentral: selectedRuleset.code === INDIA_RERA_CENTRAL_RULESET_CODE,
        })) {
      errors.push(issue(
        'ruleset_version_id',
        'RULESET_JURISDICTION_MISMATCH',
        'The selected regulatory controls do not match this Site jurisdiction.',
      ));
    } else if (!['REVIEWED', 'NOT_APPLICABLE'].includes(selectedRuleset.source_review_status)) {
      warnings.push(issue('ruleset_version_id', 'RULESET_REVIEW_PENDING', 'The selected ruleset is configuration-only or awaiting legal/content review.'));
    }
  } else if (RULESET_OPERATING_MODELS.has(profile.operating_model)) {
    errors.push(issue('ruleset_version_id', 'RERA_CENTRAL_RULESET_UNAVAILABLE', 'The central India RERA control profile is not available. Contact support.'));
  }

  if (profile.regulatory_status === 'REGISTERED') {
    const { rows } = await db.query(
      `SELECT p.id,p.registration_number,p.authority_name,p.authority_code,p.source_url,
              EXISTS (
                SELECT 1 FROM compliance_documents d
                 WHERE d.organization_id=p.organization_id
                   AND d.entity_type='RERA_PROJECT' AND d.entity_id=p.id
                   AND d.deleted_at IS NULL
              ) AS has_evidence
         FROM rera_projects p
        WHERE p.organization_id=$1 AND p.site_id=$2 AND p.deleted_at IS NULL
          AND p.regulatory_status='REGISTERED'
        ORDER BY p.updated_at DESC LIMIT 1`,
      [organizationId, siteId]
    );
    const project = rows[0];
    if (!project?.registration_number) errors.push(issue('regulatory_status', 'REGISTRATION_METADATA_REQUIRED', 'A RERA Project with a recorded registration number is required.'));
    if (project && !project.authority_name && !project.authority_code) errors.push(issue('regulatory_status', 'PROJECT_AUTHORITY_REQUIRED', 'The registered project must record its authority.'));
    if (project && !project.source_url) errors.push(issue('regulatory_status', 'SOURCE_REQUIRED', 'The registered project must retain an official/source reference.'));
    if (project && !project.has_evidence) errors.push(issue('regulatory_status', 'REGISTRATION_EVIDENCE_REQUIRED', 'Upload registration evidence against the RERA Project before publication.'));
  }

  if (profile.project_structure === 'PHASE_WISE') {
    const { rows } = await db.query(
      `SELECT 1 FROM rera_project_phases ph
        JOIN rera_projects p ON p.id=ph.rera_project_id AND p.organization_id=ph.organization_id
       WHERE p.organization_id=$1 AND p.site_id=$2
         AND p.deleted_at IS NULL AND ph.deleted_at IS NULL LIMIT 1`,
      [organizationId, siteId]
    );
    if (!rows[0]) warnings.push(issue('project_structure', 'PHASE_MAPPING_PENDING', 'Phase-wise behavior is selected, but no phase record exists yet.'));
  }

  return { valid: errors.length === 0, errors, warnings, checked_at: new Date().toISOString() };
}

const changedKeys = (current = {}, proposed = {}) => {
  const keys = new Set([...Object.keys(current), ...Object.keys(proposed)]);
  return [...keys].filter((key) => JSON.stringify(current[key]) !== JSON.stringify(proposed[key]));
};

const flattenFieldPolicy = (fields = {}) => Object.fromEntries(
  Object.entries(fields).flatMap(([section, sectionFields]) => (
    plainObject(sectionFields)
      ? Object.entries(sectionFields).map(([field, specification]) => [
        `${section}.${field}`,
        specification,
      ])
      : []
  )),
);

export function buildOperatingProfilePreview({ currentProfile, proposedProfile, rulesetVersion = null }) {
  const currentPolicy = currentProfile
    ? resolvePolicyFromProfile({ profile: currentProfile, rulesetVersion: currentProfile.ruleset_version || null })
    : resolvePolicyFromProfile();
  // Draft/review revisions must never affect runtime behaviour, but the
  // preview needs to resolve the proposed layers exactly as publication would.
  const proposedPolicy = resolvePolicyFromProfile({
    profile: proposedProfile,
    rulesetVersion,
    preview: true,
  });
  const currentModules = currentPolicy?.modules || {};
  const proposedModules = proposedPolicy.modules || {};
  const moduleKeys = new Set([...Object.keys(currentModules), ...Object.keys(proposedModules)]);
  const modulesAdded = [...moduleKeys].filter((key) => proposedModules[key] === true && currentModules[key] !== true);
  const modulesHidden = [...moduleKeys].filter((key) => proposedModules[key] === false && currentModules[key] !== false);
  const terminologyKeys = changedKeys(currentPolicy?.terminology || {}, proposedPolicy.terminology || {});
  const currentFields = flattenFieldPolicy(currentPolicy?.fields || {});
  const proposedFields = flattenFieldPolicy(proposedPolicy.fields || {});
  const fieldKeys = changedKeys(currentFields, proposedFields);

  return {
    current: currentProfile ? {
      id: currentProfile.id,
      revision: currentProfile.revision_number ?? currentProfile.revision,
      operating_model: currentProfile.operating_model,
    } : { label: 'Legacy-compatible behavior', revision: null },
    proposed: {
      id: proposedProfile.id,
      revision: proposedProfile.revision_number ?? proposedProfile.revision,
      operating_model: proposedProfile.operating_model,
    },
    finance_mode_change: {
      from: currentProfile?.finance_payment_mode || 'ALL_MODES',
      to: proposedProfile.finance_payment_mode || 'ALL_MODES',
      changed: (currentProfile?.finance_payment_mode || 'ALL_MODES')
        !== (proposedProfile.finance_payment_mode || 'ALL_MODES'),
    },
    modules_added: modulesAdded,
    modules_hidden: modulesHidden,
    labels_changed: terminologyKeys.map((key) => ({ key, label: key })),
    required_fields_added: fieldKeys
      .filter((key) => proposedFields[key]?.required === true && currentFields[key]?.required !== true)
      .map((key) => ({ key, label: proposedFields[key].label || key })),
    field_policies_changed: fieldKeys,
    rules_activated: [],
    rules_deactivated: [],
    records_requiring_mapping: [],
    warnings: rulesetVersion?.source_review_status
      && !['REVIEWED', 'NOT_APPLICABLE'].includes(rulesetVersion.source_review_status)
      ? ['The selected ruleset is not marked as reviewed legal content.']
      : [],
  };
}
