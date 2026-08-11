import pool from '../config/db.js';

/**
 * Stable module identities that existed before the regulatory workspace.
 *
 * Keep presentation labels out of this list. A profile may change terminology,
 * but routes, permission keys and stored data must continue to use these keys.
 */
export const EXISTING_MODULES = Object.freeze([
  'dashboard',
  'clients',
  'vendors',
  'farmers',
  'commissions',
  'daybook',
  'balance_sheet',
  'cashflow',
  'firm_transactions',
  'plot_payments',
  'plot_registry',
  'document_search',
  'expenses',
  'expense_approval',
  'imprest',
  'document_imprest',
  'upi_collect',
  'construction',
  'inventory',
  'chat',
  'excel',
  'reports',
  'settings',
  'finance_forecast',
  'compliance',
  'legal',
  'compliance_templates',
  'compliance_settings',
]);

export const EXISTING_MODULE_KEYS = EXISTING_MODULES;
export const LEGACY_MODULES = EXISTING_MODULES;

export const RERA_MODULE_KEYS = Object.freeze({
  OPERATING_PROFILE: 'operating_profile',
  PROJECTS: 'rera_projects',
  APPROVALS: 'rera_approvals',
  EVIDENCE: 'rera_evidence',
  RULESETS: 'rera_rulesets',
});

export const NEW_MODULES = Object.freeze(Object.values(RERA_MODULE_KEYS));
export const NEW_RERA_MODULE_KEYS = NEW_MODULES;
export const ALL_SITE_POLICY_MODULES = Object.freeze([...EXISTING_MODULES, ...NEW_MODULES]);

const KNOWN_MODULES = new Set(ALL_SITE_POLICY_MODULES);
const CACHE_TTL_MS = 15_000;
const CACHE_MAX_ENTRIES = 500;
const FIELD_POLICY_MAX_BYTES = 64 * 1024;
const FIELD_POLICY_MAX_SECTIONS = 64;
const FIELD_POLICY_MAX_FIELDS = 200;
const SAFE_KEY_RE = /^[a-z][a-z0-9_.-]{0,99}$/i;
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const sitePolicyCache = new Map();

const BASE_TERMINOLOGY = Object.freeze({
  site: 'Site',
  project: 'Project',
  inventory_unit: 'Plot',
  land_party: 'Farmer',
  land_module: 'Farmer Payments',
  collections_module: 'Plot Payments',
  conveyance_module: 'Plot Registry',
  commission_module: 'Plot Commission',
  compliance_workspace: 'Compliance & Legal',
});

export const SITE_POLICY_CAPABILITY_KEYS = Object.freeze([
  'legacy_compatible',
  'profile_configured',
  'profile_versioned',
  'field_policy_enabled',
  'project_workspace',
  'rera_workspace',
  'rera_control_centre',
  'stakeholder_register',
  'approval_register',
  'evidence_vault',
  'ruleset_information',
  'plotted_inventory',
  'group_housing_inventory',
  'commercial_inventory',
  'mixed_use_inventory',
  'landowner_linked',
  'construction_certification',
  'filing_preparation',
  'project_change_control',
]);

const KNOWN_CAPABILITIES = new Set(SITE_POLICY_CAPABILITY_KEYS);

const LANDOWNER_LINKED_BASES = new Set([
  'LANDOWNER',
  'DEVELOPMENT_AGREEMENT',
  'JOINT_DEVELOPMENT_AGREEMENT',
  'COLLABORATION_AGREEMENT',
  'CO_PROMOTER',
  'POWER_OF_ATTORNEY',
]);

const PROJECT_WORKSPACE_MODELS = new Set([
  'DEVELOPMENT_AUTHORISED_BUILDER',
  'RERA_PROJECT_PROMOTER',
  'RERA_ONGOING_PROJECT_REGULARISATION',
]);

const RERA_OPERATING_MODELS = new Set([
  'RERA_PROJECT_PROMOTER',
  'RERA_ONGOING_PROJECT_REGULARISATION',
]);

const clone = (value) => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const isPlainObject = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
);

const upper = (value) => String(value || '').trim().toUpperCase();

const positiveId = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const safeKey = (value) => {
  const key = String(value || '').trim();
  return SAFE_KEY_RE.test(key) && !BLOCKED_KEYS.has(key) ? key : null;
};

const jsonSize = (value) => {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const legacyModulePolicy = () => Object.fromEntries([
  ...EXISTING_MODULES.map((key) => [key, true]),
  ...NEW_MODULES.map((key) => [key, false]),
]);

export const LEGACY_MODULE_POLICY = Object.freeze(legacyModulePolicy());

const baseCapabilities = () => ({
  legacy_compatible: true,
  profile_configured: false,
  profile_versioned: false,
  field_policy_enabled: false,
  project_workspace: false,
  rera_workspace: false,
  rera_control_centre: false,
  stakeholder_register: false,
  approval_register: false,
  evidence_vault: false,
  ruleset_information: false,
  plotted_inventory: false,
  group_housing_inventory: false,
  commercial_inventory: false,
  mixed_use_inventory: false,
  landowner_linked: false,
  construction_certification: false,
  filing_preparation: false,
  project_change_control: false,
});

const configuredValue = (profile, key) => {
  if (profile?.[key] !== undefined && profile?.[key] !== null) return profile[key];
  if (isPlainObject(profile?.configuration) && profile.configuration[key] !== undefined) {
    return profile.configuration[key];
  }
  return null;
};

const profileLifecycle = (profile) => upper(
  profile?.lifecycle_status ?? profile?.lifecycleStatus ?? profile?.status
);

const isPublishedProfile = (profile) => (
  isPlainObject(profile)
  && profileLifecycle(profile) === 'PUBLISHED'
  && !profile.deleted_at
  && !profile.effective_to
);

const hasExplicitReraContext = (profile) => {
  const operatingModel = upper(configuredValue(profile, 'operating_model'));
  if (RERA_OPERATING_MODELS.has(operatingModel)) return true;

  // Authority/jurisdiction are explicit profile selections. Site address/state
  // is deliberately not considered here: Haryana must never imply HRERA.
  const explicitRegulatoryValues = [
    configuredValue(profile, 'jurisdiction'),
    configuredValue(profile, 'authority'),
    configuredValue(profile, 'authority_code'),
    configuredValue(profile, 'authority_name'),
  ];
  return explicitRegulatoryValues.some((value) => /(^|[^A-Z])H?RERA([^A-Z]|$)/.test(upper(value)));
};

const mergeFields = (base, override) => {
  const next = clone(base || {});
  for (const [section, sectionValue] of Object.entries(override || {})) {
    if (!isPlainObject(sectionValue)) continue;
    if (!isPlainObject(next[section])) next[section] = {};
    for (const [field, fieldValue] of Object.entries(sectionValue)) {
      if (!isPlainObject(fieldValue)) continue;
      next[section][field] = {
        ...(isPlainObject(next[section][field]) ? next[section][field] : {}),
        ...clone(fieldValue),
      };
    }
  }
  return next;
};

const sanitizeBoundedJson = (value, {
  maxDepth = 3, maxKeys = 40, maxArray = 100, maxString = 1000,
} = {}, depth = 0) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, maxString);
  if (depth >= maxDepth) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, maxArray)
      .map((entry) => sanitizeBoundedJson(entry, {
        maxDepth, maxKeys, maxArray, maxString,
      }, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (!isPlainObject(value)) return undefined;
  const result = {};
  for (const [rawKey, entry] of Object.entries(value).slice(0, maxKeys)) {
    const key = safeKey(rawKey);
    if (!key) continue;
    const sanitized = sanitizeBoundedJson(entry, {
      maxDepth, maxKeys, maxArray, maxString,
    }, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
};

const FIELD_BOOLEAN_KEYS = new Set(['visible', 'required', 'read_only', 'readonly', 'calculated']);
const FIELD_STRING_KEYS = new Set([
  'label', 'help_text', 'helpText', 'section', 'placeholder', 'reason', 'format',
]);
const FIELD_JSON_KEYS = new Set(['validation', 'options', 'workflow_precondition']);

/**
 * Validate and sanitize ruleset/profile field-policy JSON before persistence or
 * policy resolution. The result never retains prototype-polluting keys or
 * unbounded nested data.
 */
export function validateFieldPolicyPayload(payload) {
  if (payload === undefined || payload === null) {
    return { valid: true, ok: true, value: {}, errors: [] };
  }
  if (!isPlainObject(payload)) {
    return {
      valid: false,
      ok: false,
      value: {},
      errors: ['Field policy must be a JSON object'],
    };
  }
  if (jsonSize(payload) > FIELD_POLICY_MAX_BYTES) {
    return {
      valid: false,
      ok: false,
      value: {},
      errors: [`Field policy must not exceed ${FIELD_POLICY_MAX_BYTES} bytes`],
    };
  }

  const errors = [];
  const value = {};
  const sections = Object.entries(payload);
  if (sections.length > FIELD_POLICY_MAX_SECTIONS) {
    errors.push(`Field policy must not contain more than ${FIELD_POLICY_MAX_SECTIONS} sections`);
  }

  for (const [rawSection, rawFields] of sections.slice(0, FIELD_POLICY_MAX_SECTIONS)) {
    const section = safeKey(rawSection);
    if (!section) {
      errors.push(`Invalid field-policy section: ${String(rawSection).slice(0, 100)}`);
      continue;
    }
    if (!isPlainObject(rawFields)) {
      errors.push(`Field-policy section ${section} must be an object`);
      continue;
    }
    const fieldEntries = Object.entries(rawFields);
    if (fieldEntries.length > FIELD_POLICY_MAX_FIELDS) {
      errors.push(`${section} must not contain more than ${FIELD_POLICY_MAX_FIELDS} fields`);
    }
    const fields = {};
    for (const [rawField, rawSpec] of fieldEntries.slice(0, FIELD_POLICY_MAX_FIELDS)) {
      const field = safeKey(rawField);
      if (!field) {
        errors.push(`Invalid field key in ${section}: ${String(rawField).slice(0, 100)}`);
        continue;
      }
      if (!isPlainObject(rawSpec)) {
        errors.push(`${section}.${field} must be an object`);
        continue;
      }
      const spec = {};
      for (const [rawProperty, rawValue] of Object.entries(rawSpec)) {
        const property = safeKey(rawProperty);
        if (!property) {
          errors.push(`Invalid property in ${section}.${field}`);
          continue;
        }
        if (FIELD_BOOLEAN_KEYS.has(property)) {
          if (typeof rawValue !== 'boolean') {
            errors.push(`${section}.${field}.${property} must be boolean`);
            continue;
          }
          const normalizedProperty = property === 'readonly' ? 'read_only' : property;
          spec[normalizedProperty] = rawValue;
          continue;
        }
        if (FIELD_STRING_KEYS.has(property)) {
          if (typeof rawValue !== 'string') {
            errors.push(`${section}.${field}.${property} must be a string`);
            continue;
          }
          const normalizedProperty = property === 'helpText' ? 'help_text' : property;
          spec[normalizedProperty] = rawValue.trim().slice(0, property === 'help_text' ? 1000 : 300);
          continue;
        }
        if (FIELD_JSON_KEYS.has(property)) {
          const sanitized = sanitizeBoundedJson(rawValue);
          if (sanitized === undefined) {
            errors.push(`${section}.${field}.${property} contains unsupported data`);
            continue;
          }
          spec[property] = sanitized;
          continue;
        }
        errors.push(`Unknown field-policy property: ${section}.${field}.${property}`);
      }
      fields[field] = spec;
    }
    value[section] = fields;
  }

  return { valid: errors.length === 0, ok: errors.length === 0, value, errors };
}

const isMissingRequiredValue = (value) => (
  value === undefined
  || value === null
  || (typeof value === 'string' && !value.trim())
  || (Array.isArray(value) && value.length === 0)
);

/**
 * Validate a form/API payload against an already-resolved field policy.
 *
 * Field policy is additive: fields with no policy entry remain available so a
 * legacy form cannot be broken merely because a profile only overrides a few
 * fields. Explicitly hidden, read-only or calculated fields are rejected on
 * write. Required fields are enforced for create/full-update payloads.
 */
export function validateFieldPayload({
  payload,
  policy = null,
  fields = null,
  fieldPolicy = null,
  section = null,
  partial = false,
} = {}) {
  if (!isPlainObject(payload)) {
    return {
      valid: false,
      ok: false,
      value: {},
      errors: ['Payload must be a JSON object'],
    };
  }

  const availableFields = firstDefined(fields, fieldPolicy, policy?.fields, {});
  const sectionKey = section === null ? null : safeKey(section);
  if (section !== null && !sectionKey) {
    return {
      valid: false,
      ok: false,
      value: {},
      errors: ['A valid field-policy section is required'],
    };
  }
  const scopedPolicy = sectionKey ? availableFields?.[sectionKey] : availableFields;
  if (!isPlainObject(scopedPolicy)) {
    return {
      valid: false,
      ok: false,
      value: {},
      errors: [`No valid field policy exists for ${sectionKey || 'the payload'}`],
    };
  }

  const errors = [];
  const value = {};
  for (const [rawField, rawValue] of Object.entries(payload)) {
    const field = safeKey(rawField);
    if (!field) {
      errors.push(`Invalid payload field: ${String(rawField).slice(0, 100)}`);
      continue;
    }
    const specification = scopedPolicy[field];
    if (isPlainObject(specification)) {
      if (specification.visible === false) {
        errors.push(`${field} is not available for this Site profile`);
        continue;
      }
      if (specification.read_only === true || specification.readonly === true) {
        errors.push(`${field} is read-only for this Site profile`);
        continue;
      }
      if (specification.calculated === true) {
        errors.push(`${field} is calculated and cannot be submitted`);
        continue;
      }
    }
    value[field] = clone(rawValue);
  }

  if (!partial) {
    for (const [field, specification] of Object.entries(scopedPolicy)) {
      if (!isPlainObject(specification) || specification.required !== true) continue;
      if (specification.visible === false || specification.read_only === true
          || specification.readonly === true || specification.calculated === true) continue;
      if (isMissingRequiredValue(payload[field])) errors.push(`${field} is required`);
    }
  }

  return { valid: errors.length === 0, ok: errors.length === 0, value, errors };
}

export const validatePayloadAgainstFieldPolicy = validateFieldPayload;

const normalizeModulePolicy = (payload) => {
  if (payload === undefined || payload === null) return { value: {}, errors: [] };
  if (!isPlainObject(payload)) {
    return { value: {}, errors: ['Module policy must be a JSON object'] };
  }

  const value = {};
  const errors = [];
  const body = isPlainObject(payload.modules) ? payload.modules : payload;

  for (const [rawKey, rawSetting] of Object.entries(body)) {
    if (['allow', 'deny', 'enabled_modules', 'disabled_modules', 'modules'].includes(rawKey)) continue;
    const key = String(rawKey || '').trim();
    if (!KNOWN_MODULES.has(key)) {
      errors.push(`Unknown module policy key: ${key.slice(0, 100)}`);
      continue;
    }
    const enabled = typeof rawSetting === 'boolean'
      ? rawSetting
      : (isPlainObject(rawSetting) && typeof rawSetting.enabled === 'boolean'
        ? rawSetting.enabled
        : null);
    if (enabled === null) {
      errors.push(`Module policy ${key} must be boolean or { enabled: boolean }`);
      continue;
    }
    value[key] = enabled;
  }

  const applyList = (raw, enabled, label) => {
    if (raw === undefined) return;
    if (!Array.isArray(raw)) {
      errors.push(`${label} must be an array`);
      return;
    }
    for (const rawKey of raw.slice(0, ALL_SITE_POLICY_MODULES.length)) {
      const key = String(rawKey || '').trim();
      if (!KNOWN_MODULES.has(key)) {
        errors.push(`Unknown module policy key: ${key.slice(0, 100)}`);
        continue;
      }
      value[key] = enabled;
    }
  };

  applyList(payload.allow ?? payload.enabled_modules, true, 'Module allow list');
  applyList(payload.deny ?? payload.disabled_modules, false, 'Module deny list');
  if (body !== payload) {
    applyList(body.allow ?? body.enabled_modules, true, 'Module allow list');
    applyList(body.deny ?? body.disabled_modules, false, 'Module deny list');
  }
  return { value, errors };
};

const normalizeTerminologyPolicy = (payload) => {
  if (payload === undefined || payload === null) return { value: {}, errors: [] };
  if (!isPlainObject(payload)) {
    return { value: {}, errors: ['Terminology policy must be a JSON object'] };
  }
  const value = {};
  const errors = [];
  for (const [rawKey, rawValue] of Object.entries(payload).slice(0, 100)) {
    const key = safeKey(rawKey);
    if (!key) {
      errors.push(`Invalid terminology key: ${String(rawKey).slice(0, 100)}`);
      continue;
    }
    if (typeof rawValue !== 'string' || !rawValue.trim()) {
      errors.push(`Terminology ${key} must be a non-empty string`);
      continue;
    }
    value[key] = rawValue.trim().slice(0, 120);
  }
  return { value, errors };
};

const normalizeCapabilityPolicy = (payload) => {
  if (payload === undefined || payload === null) return { value: {}, errors: [] };
  if (!isPlainObject(payload)) {
    return { value: {}, errors: ['Capability policy must be a JSON object'] };
  }
  const value = {};
  const errors = [];
  for (const [rawKey, rawValue] of Object.entries(payload)) {
    const key = String(rawKey || '').trim();
    if (!KNOWN_CAPABILITIES.has(key)) {
      errors.push(`Unknown capability policy key: ${key.slice(0, 100)}`);
      continue;
    }
    if (typeof rawValue !== 'boolean') {
      errors.push(`Capability ${key} must be boolean`);
      continue;
    }
    value[key] = rawValue;
  }
  return { value, errors };
};

const firstDefined = (...values) => values.find((value) => value !== undefined && value !== null);

const rulesetPolicies = (rulesetVersion) => ({
  modules: firstDefined(rulesetVersion?.module_policy, rulesetVersion?.modules),
  capabilities: firstDefined(rulesetVersion?.capability_policy, rulesetVersion?.capabilities),
  terminology: firstDefined(rulesetVersion?.terminology_policy, rulesetVersion?.terminology),
  fields: firstDefined(rulesetVersion?.field_policy, rulesetVersion?.fields),
});

const profilePolicies = (profile) => {
  const envelope = isPlainObject(profile?.policy_overrides) ? profile.policy_overrides : {};
  return {
    modules: firstDefined(
      profile?.module_policy_overrides,
      profile?.module_overrides,
      envelope.modules,
    ),
    capabilities: firstDefined(
      profile?.capability_policy_overrides,
      profile?.capability_overrides,
      envelope.capabilities,
    ),
    terminology: firstDefined(
      profile?.terminology_policy_overrides,
      profile?.terminology_overrides,
      envelope.terminology,
    ),
    fields: firstDefined(
      profile?.field_policy_overrides,
      profile?.field_overrides,
      envelope.fields,
    ),
  };
};

const profileDefaults = (profile) => {
  const modules = {};
  const capabilities = baseCapabilities();
  const terminology = {};
  let fields = {};

  const operatingModel = upper(configuredValue(profile, 'operating_model'));
  const projectShape = upper(configuredValue(profile, 'project_shape'));
  const developmentBasis = upper(configuredValue(profile, 'development_basis'));
  const landownerLinked = LANDOWNER_LINKED_BASES.has(developmentBasis);
  const projectWorkspace = PROJECT_WORKSPACE_MODELS.has(operatingModel);
  const reraWorkspace = hasExplicitReraContext(profile);

  modules[RERA_MODULE_KEYS.OPERATING_PROFILE] = true;
  if (projectWorkspace) {
    modules[RERA_MODULE_KEYS.PROJECTS] = true;
  }
  if (reraWorkspace) {
    modules[RERA_MODULE_KEYS.PROJECTS] = true;
    modules[RERA_MODULE_KEYS.APPROVALS] = true;
    modules[RERA_MODULE_KEYS.EVIDENCE] = true;
    modules[RERA_MODULE_KEYS.RULESETS] = true;
  }

  capabilities.profile_configured = true;
  capabilities.profile_versioned = true;
  capabilities.field_policy_enabled = true;
  capabilities.project_workspace = projectWorkspace || reraWorkspace;
  capabilities.rera_workspace = reraWorkspace;
  capabilities.rera_control_centre = reraWorkspace;
  capabilities.stakeholder_register = modules[RERA_MODULE_KEYS.PROJECTS] === true;
  capabilities.approval_register = modules[RERA_MODULE_KEYS.APPROVALS] === true;
  capabilities.evidence_vault = modules[RERA_MODULE_KEYS.EVIDENCE] === true;
  capabilities.ruleset_information = modules[RERA_MODULE_KEYS.RULESETS] === true;
  capabilities.landowner_linked = landownerLinked;
  capabilities.construction_certification = reraWorkspace;
  capabilities.filing_preparation = reraWorkspace;
  capabilities.project_change_control = reraWorkspace;

  if (['PLOTTED_DEVELOPMENT', 'MIXED_USE'].includes(projectShape)) {
    capabilities.plotted_inventory = true;
    capabilities.mixed_use_inventory = projectShape === 'MIXED_USE';
    terminology.inventory_unit = 'Plot';
    fields = mergeFields(fields, {
      plots: {
        plot_no: { label: 'Approved Plot Number' },
        block: { label: 'Layout Block' },
        plot_size: { label: 'Approved Plan Area' },
      },
    });
  }

  if (['APARTMENT', 'COMMERCIAL'].includes(projectShape)) {
    capabilities.group_housing_inventory = projectShape === 'APARTMENT';
    capabilities.commercial_inventory = projectShape === 'COMMERCIAL';
    terminology.inventory_unit = projectShape === 'APARTMENT' ? 'Unit' : 'Commercial Unit';

    // Phase 1 intentionally has no tower/unit sales hierarchy. Hide legacy
    // plot-specific workflows for an explicitly published non-plotted profile;
    // a reviewed ruleset/profile override may re-enable them where appropriate.
    modules.plot_payments = false;
    modules.plot_registry = false;
    modules.commissions = false;
    modules.farmers = landownerLinked;
  }

  if (landownerLinked) {
    modules.farmers = true;
    terminology.land_party = 'Landowner';
    terminology.land_module = 'Land & Development Rights';
    fields = mergeFields(fields, {
      farmers: {
        name: { label: 'Landowner Name' },
      },
    });
  }

  if (reraWorkspace) {
    terminology.project = 'RERA Project';
    terminology.compliance_workspace = 'RERA Control Centre';
  } else if (projectWorkspace) {
    // The underlying Phase 1 tables and permissions retain their canonical
    // RERA names, but a Development Authority must never be presented with a
    // RERA-labelled setup flow unless an explicit RERA context is configured.
    terminology.project = 'Development Project';
    terminology.compliance_workspace = 'Development Control Centre';
  }

  return { modules, capabilities, terminology, fields };
};

const profileSummary = (profile) => ({
  id: profile.id ?? null,
  revision_number: profile.revision_number ?? profile.revision ?? null,
  revision: profile.revision_number ?? profile.revision ?? null,
  lifecycle_status: profileLifecycle(profile),
  operating_model: configuredValue(profile, 'operating_model'),
  jurisdiction: configuredValue(profile, 'jurisdiction'),
  jurisdiction_country: configuredValue(profile, 'jurisdiction_country'),
  jurisdiction_state: configuredValue(profile, 'jurisdiction_state'),
  authority_id: configuredValue(profile, 'authority_id'),
  authority: configuredValue(profile, 'authority'),
  authority_code: configuredValue(profile, 'authority_code'),
  authority_name: configuredValue(profile, 'authority_name'),
  district: configuredValue(profile, 'district'),
  development_basis: configuredValue(profile, 'development_basis'),
  project_shape: configuredValue(profile, 'project_shape'),
  regulatory_status: configuredValue(profile, 'regulatory_status'),
  project_structure: configuredValue(profile, 'project_structure'),
  ruleset_version_id: profile.ruleset_version_id ?? null,
  effective_from: profile.effective_from ?? null,
});

const addPolicyLayer = ({
  layerName, policies, modules, capabilities, terminology, fields, reasons,
}) => {
  const modulePolicy = normalizeModulePolicy(policies.modules);
  Object.assign(modules, modulePolicy.value);
  const capabilityPolicy = normalizeCapabilityPolicy(policies.capabilities);
  Object.assign(capabilities, capabilityPolicy.value);
  const terminologyPolicy = normalizeTerminologyPolicy(policies.terminology);
  Object.assign(terminology, terminologyPolicy.value);
  const fieldPolicy = validateFieldPolicyPayload(policies.fields);
  const mergedFields = mergeFields(fields, fieldPolicy.value);

  const errors = [
    ...modulePolicy.errors,
    ...capabilityPolicy.errors,
    ...terminologyPolicy.errors,
    ...fieldPolicy.errors,
  ];
  if (errors.length) {
    reasons.push({
      code: `${layerName.toUpperCase()}_POLICY_IGNORED_PARTS`,
      message: `${layerName} contained malformed or unknown policy entries; those entries were ignored`,
      details: errors.slice(0, 20),
    });
  }
  const applied = Object.keys(modulePolicy.value).length
    + Object.keys(capabilityPolicy.value).length
    + Object.keys(terminologyPolicy.value).length
    + Object.keys(fieldPolicy.value).length;
  if (applied) {
    reasons.push({
      code: `${layerName.toUpperCase()}_POLICY_APPLIED`,
      message: `${layerName} policy applied`,
    });
  }
  return mergedFields;
};

/**
 * Pure effective-policy resolver.
 *
 * Resolution order is intentionally fixed:
 *   stable legacy baseline -> safe profile-derived defaults -> published
 *   ruleset JSON -> profile overrides.
 *
 * A draft/review/superseded profile is treated exactly like no profile.
 */
export function resolvePolicyFromProfile({
  profile = null,
  rulesetVersion = null,
  allowUnpublished = false,
  preview = false,
} = {}) {
  const modules = legacyModulePolicy();
  const capabilities = baseCapabilities();
  const terminology = { ...BASE_TERMINOLOGY };
  let fields = {};
  const reasons = [];

  const published = isPublishedProfile(profile);
  if (!published && !(allowUnpublished || preview)) {
    reasons.push({
      code: profile ? 'PROFILE_NOT_PUBLISHED' : 'NO_PUBLISHED_PROFILE',
      message: 'Legacy-compatible site policy is active',
    });
    return {
      site_id: profile?.site_id ?? null,
      mode: 'LEGACY',
      policy_revision: null,
      profile: null,
      modules,
      capabilities,
      terminology,
      fields,
      reasons,
    };
  }

  const defaults = profileDefaults(profile);
  Object.assign(modules, defaults.modules);
  Object.assign(capabilities, defaults.capabilities);
  Object.assign(terminology, defaults.terminology);
  fields = mergeFields(fields, defaults.fields);
  reasons.push(published ? {
    code: 'PUBLISHED_PROFILE_ACTIVE',
    message: 'Published Site Operating Profile is active',
  } : {
    code: 'UNPUBLISHED_PROFILE_PREVIEW',
    message: 'Unpublished Site Operating Profile was resolved for preview only',
  });

  const expectedRulesetId = positiveId(profile.ruleset_version_id);
  const suppliedRulesetId = positiveId(rulesetVersion?.id);
  const rulesetMatches = Boolean(
    rulesetVersion
    && expectedRulesetId
    && suppliedRulesetId
    && expectedRulesetId === suppliedRulesetId
  );

  if (rulesetVersion && rulesetMatches) {
    fields = addPolicyLayer({
      layerName: 'ruleset',
      policies: rulesetPolicies(rulesetVersion),
      modules,
      capabilities,
      terminology,
      fields,
      reasons,
    });
  } else if (rulesetVersion) {
    reasons.push({
      code: 'RULESET_VERSION_MISMATCH',
      message: 'Ruleset policy was ignored because it does not match the published profile',
    });
  }

  fields = addPolicyLayer({
    layerName: 'profile',
    policies: profilePolicies(profile),
    modules,
    capabilities,
    terminology,
    fields,
    reasons,
  });

  // Security invariant: every known module is an explicit boolean. Unknown
  // or malformed policy can never accidentally make a new module truthy.
  for (const moduleKey of ALL_SITE_POLICY_MODULES) {
    modules[moduleKey] = modules[moduleKey] === true;
  }

  return {
    site_id: profile.site_id ?? null,
    mode: published ? 'PROFILE' : 'PREVIEW',
    policy_revision: profile.revision_number ?? profile.revision ?? profile.id ?? null,
    profile: profileSummary(profile),
    modules,
    capabilities,
    terminology,
    fields,
    reasons,
  };
}

const cacheKeyFor = (organizationId, siteId, header) => [
  organizationId,
  siteId,
  header.profile_revision_id || 'legacy',
  header.profile_revision || 'none',
  header.ruleset_version_id || 'none',
  header.ruleset_version || 'none',
].join(':');

const pruneCache = () => {
  const now = Date.now();
  for (const [key, entry] of sitePolicyCache) {
    if (entry.expiresAt <= now) sitePolicyCache.delete(key);
  }
  while (sitePolicyCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = sitePolicyCache.keys().next().value;
    if (oldestKey === undefined) break;
    sitePolicyCache.delete(oldestKey);
  }
};

const loadPolicyHeader = async (db, organizationId, siteId) => {
  const { rows } = await db.query(
    `SELECT s.id AS site_id,
            p.id AS profile_revision_id,
            p.revision_number AS profile_revision,
            p.ruleset_version_id,
            rv.version AS ruleset_version
       FROM sites s
       LEFT JOIN LATERAL (
         SELECT spr.id,spr.revision_number,spr.ruleset_version_id
           FROM site_operating_profile_revisions spr
          WHERE spr.organization_id=$1
            AND spr.site_id=s.id
            AND spr.lifecycle_status='PUBLISHED'
            AND spr.effective_to IS NULL
            AND spr.deleted_at IS NULL
          ORDER BY spr.revision_number DESC,spr.id DESC
          LIMIT 1
       ) p ON TRUE
       LEFT JOIN LATERAL (
         SELECT version
           FROM rera_ruleset_versions candidate
          JOIN rera_rulesets ruleset
             ON ruleset.id=candidate.ruleset_id
            AND ruleset.deleted_at IS NULL
            AND ruleset.is_active=TRUE
          WHERE candidate.id=p.ruleset_version_id
            AND candidate.deleted_at IS NULL
            AND candidate.lifecycle_status IN ('PUBLISHED','SUPERSEDED')
            AND (ruleset.organization_id IS NULL OR ruleset.organization_id=$1)
          LIMIT 1
       ) rv ON TRUE
      WHERE s.id=$2 AND s.organization_id=$1
      LIMIT 1`,
    [organizationId, siteId],
  );
  return rows[0] || null;
};

const loadPublishedPolicy = async (db, organizationId, siteId, profileRevisionId) => {
  const { rows } = await db.query(
    `SELECT p.*,
            rv.id AS resolved_ruleset_version_id,
            rv.version AS resolved_ruleset_version,
            rv.module_policy AS resolved_ruleset_module_policy,
            rv.terminology_policy AS resolved_ruleset_terminology_policy,
            rv.field_policy AS resolved_ruleset_field_policy,
            rv.capability_policy AS resolved_ruleset_capability_policy
       FROM site_operating_profile_revisions p
       LEFT JOIN LATERAL (
         SELECT candidate.id,candidate.version,candidate.module_policy,
                candidate.terminology_policy,candidate.field_policy,
                candidate.capability_policy
           FROM rera_ruleset_versions candidate
          JOIN rera_rulesets ruleset
             ON ruleset.id=candidate.ruleset_id
            AND ruleset.deleted_at IS NULL
            AND ruleset.is_active=TRUE
          WHERE candidate.id=p.ruleset_version_id
            AND candidate.deleted_at IS NULL
            AND candidate.lifecycle_status IN ('PUBLISHED','SUPERSEDED')
            AND (ruleset.organization_id IS NULL OR ruleset.organization_id=p.organization_id)
          LIMIT 1
       ) rv ON TRUE
      WHERE p.id=$3
        AND p.organization_id=$1
        AND p.site_id=$2
        AND p.lifecycle_status='PUBLISHED'
        AND p.effective_to IS NULL
        AND p.deleted_at IS NULL
      LIMIT 1`,
    [organizationId, siteId, profileRevisionId],
  );
  return rows[0] || null;
};

const notFoundError = () => {
  const error = new Error('Site not found or access is outside the organization');
  error.statusCode = 404;
  return error;
};

/** Resolve the published effective policy after validating site ownership. */
export async function resolveSitePolicy({ organizationId, siteId, db = pool } = {}) {
  const orgId = positiveId(organizationId);
  const resolvedSiteId = positiveId(siteId);
  if (!orgId || !resolvedSiteId) {
    const error = new Error('Valid organizationId and siteId are required');
    error.statusCode = 400;
    throw error;
  }
  if (!db || typeof db.query !== 'function') throw new TypeError('db.query is required');

  // This small ownership/header query runs before the cache lookup. It prevents
  // a stale cache entry from surviving profile publication or cross-tenant use.
  const header = await loadPolicyHeader(db, orgId, resolvedSiteId);
  if (!header) throw notFoundError();

  const cacheKey = cacheKeyFor(orgId, resolvedSiteId, header);
  const cached = sitePolicyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return clone(cached.value);

  let policy;
  if (!header.profile_revision_id) {
    policy = resolvePolicyFromProfile();
    policy.site_id = resolvedSiteId;
  } else {
    const row = await loadPublishedPolicy(
      db,
      orgId,
      resolvedSiteId,
      header.profile_revision_id,
    );

    // Publication may race the header/full reads. Re-resolve once against the
    // new active revision instead of applying a superseded snapshot.
    if (!row) {
      invalidateSitePolicy(resolvedSiteId);
      const refreshed = await loadPolicyHeader(db, orgId, resolvedSiteId);
      if (!refreshed) throw notFoundError();
      if (refreshed.profile_revision_id !== header.profile_revision_id) {
        return resolveSitePolicy({ organizationId: orgId, siteId: resolvedSiteId, db });
      }
      policy = resolvePolicyFromProfile();
      policy.site_id = resolvedSiteId;
      policy.reasons.push({
        code: 'PROFILE_PUBLICATION_RACE',
        message: 'Legacy-compatible policy was used while profile publication changed',
      });
    } else {
      const rulesetVersion = row.resolved_ruleset_version_id
        ? {
          id: row.resolved_ruleset_version_id,
          version: row.resolved_ruleset_version,
          module_policy: row.resolved_ruleset_module_policy,
          terminology_policy: row.resolved_ruleset_terminology_policy,
          field_policy: row.resolved_ruleset_field_policy,
          capability_policy: row.resolved_ruleset_capability_policy,
        }
        : null;
      policy = resolvePolicyFromProfile({ profile: row, rulesetVersion });
      policy.site_id = resolvedSiteId;
    }
  }

  pruneCache();
  sitePolicyCache.set(cacheKey, {
    siteId: resolvedSiteId,
    expiresAt: Date.now() + CACHE_TTL_MS,
    value: clone(policy),
  });
  return clone(policy);
}

/** Backend route/action guard primitive. Unknown module identities deny. */
export async function isSiteModuleAllowed({
  organizationId, siteId, module, db = pool,
} = {}) {
  const moduleKey = String(module || '').trim();
  if (!KNOWN_MODULES.has(moduleKey)) return false;
  const policy = await resolveSitePolicy({ organizationId, siteId, db });
  return policy.modules[moduleKey] === true;
}

/** Invalidate every tenant-specific cache entry for a site after publication. */
export function invalidateSitePolicy(siteId) {
  const resolvedSiteId = positiveId(siteId);
  if (!resolvedSiteId) return 0;
  let removed = 0;
  for (const [key, entry] of sitePolicyCache) {
    if (entry.siteId === resolvedSiteId) {
      sitePolicyCache.delete(key);
      removed += 1;
    }
  }
  return removed;
}
