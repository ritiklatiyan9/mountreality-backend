import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_SITE_POLICY_MODULES,
  EXISTING_MODULES,
  LEGACY_MODULE_POLICY,
  NEW_MODULES,
  RERA_MODULE_KEYS,
  isSiteModuleAllowed,
  resolvePolicyFromProfile,
  validateFieldPayload,
  validateFieldPolicyPayload,
} from '../src/services/sitePolicy.service.js';
import {
  buildOperatingProfilePreview,
  normalizeOperatingProfileInput,
} from '../src/services/operatingProfile.service.js';

const CANONICAL_RERA_MODULES = [
  'operating_profile',
  'rera_projects',
  'rera_approvals',
  'rera_evidence',
  'rera_rulesets',
];

const publishedProfile = (overrides = {}) => ({
  id: 41,
  organization_id: 7,
  site_id: 19,
  revision_number: 4,
  lifecycle_status: 'PUBLISHED',
  effective_to: null,
  deleted_at: null,
  operating_model: 'RERA_PROJECT_PROMOTER',
  project_shape: 'PLOTTED_DEVELOPMENT',
  development_basis: 'LANDOWNER',
  regulatory_status: 'APPLICABILITY_UNDER_REVIEW',
  project_structure: 'SINGLE_PROJECT',
  ruleset_version_id: 91,
  ...overrides,
});

test('RERA policy exposes only the five canonical RBAC module identities', () => {
  assert.deepEqual(Object.values(RERA_MODULE_KEYS), CANONICAL_RERA_MODULES);
  assert.deepEqual(NEW_MODULES, CANONICAL_RERA_MODULES);
  assert.deepEqual(
    [...new Set(ALL_SITE_POLICY_MODULES)],
    [...EXISTING_MODULES, ...CANONICAL_RERA_MODULES],
  );
  assert.equal(NEW_MODULES.includes('rera_control_centre'), false);
  assert.equal(NEW_MODULES.includes('rera_stakeholders'), false);
  assert.equal(NEW_MODULES.includes('rera_land'), false);
});

test('a Site without a published profile is explicitly legacy-compatible', () => {
  const policy = resolvePolicyFromProfile({});

  assert.equal(policy.mode, 'LEGACY');
  assert.equal(policy.policy_revision, null);
  assert.equal(policy.profile, null);
  assert.deepEqual(policy.modules, LEGACY_MODULE_POLICY);
  for (const module of EXISTING_MODULES) assert.equal(policy.modules[module], true, module);
  for (const module of NEW_MODULES) assert.equal(policy.modules[module], false, module);
  assert.equal(policy.capabilities.legacy_compatible, true);
  assert.equal(policy.capabilities.rera_workspace, false);
});

test('draft profiles never affect runtime but may be resolved explicitly for preview', () => {
  const draft = publishedProfile({
    lifecycle_status: 'DRAFT',
    module_overrides: { rera_projects: true },
  });

  const runtime = resolvePolicyFromProfile({ profile: draft });
  assert.equal(runtime.mode, 'LEGACY');
  assert.equal(runtime.modules.rera_projects, false);

  const preview = resolvePolicyFromProfile({ profile: draft, allowUnpublished: true });
  assert.equal(preview.mode, 'PREVIEW');
  assert.equal(preview.policy_revision, draft.revision_number);
  assert.equal(preview.modules.rera_projects, true);
  assert.ok(preview.reasons.some(({ code }) => code === 'UNPUBLISHED_PROFILE_PREVIEW'));
});

test('published profiles derive safe project-shape and RERA capabilities', () => {
  const policy = resolvePolicyFromProfile({ profile: publishedProfile() });

  assert.equal(policy.mode, 'PROFILE');
  assert.equal(policy.policy_revision, 4);
  for (const module of CANONICAL_RERA_MODULES) assert.equal(policy.modules[module], true, module);
  assert.equal(policy.capabilities.rera_control_centre, true);
  assert.equal(policy.capabilities.stakeholder_register, true);
  assert.equal(policy.capabilities.landowner_linked, true);
  assert.equal(policy.capabilities.plotted_inventory, true);
  assert.equal(policy.terminology.land_party, 'Landowner');
  assert.equal(policy.fields.plots.plot_no.label, 'Approved Plot Number');
});

test('address alone never infers HRERA and non-plotted defaults hide plot workflows safely', () => {
  const genericHaryana = resolvePolicyFromProfile({
    profile: publishedProfile({
      operating_model: 'GENERIC_LAND_DEVELOPER',
      jurisdiction_state_code: 'HR',
      authority_code: null,
      authority_name: null,
      project_shape: 'APARTMENT',
      development_basis: 'OTHER',
    }),
  });

  assert.equal(genericHaryana.modules.operating_profile, true);
  for (const module of CANONICAL_RERA_MODULES.slice(1)) {
    assert.equal(genericHaryana.modules[module], false, module);
  }
  assert.equal(genericHaryana.capabilities.rera_workspace, false);
  assert.equal(genericHaryana.capabilities.group_housing_inventory, true);
  assert.equal(genericHaryana.modules.plot_payments, false);
  assert.equal(genericHaryana.modules.plot_registry, false);
  assert.equal(genericHaryana.modules.farmers, false);
  assert.equal(genericHaryana.terminology.inventory_unit, 'Unit');
});

test('Development Authority profiles use the development project workspace without RERA terminology', () => {
  const policy = resolvePolicyFromProfile({
    profile: publishedProfile({
      operating_model: 'DEVELOPMENT_AUTHORISED_BUILDER',
      development_basis: 'OTHER',
      ruleset_version_id: null,
      authority_code: null,
      authority_name: null,
    }),
  });

  assert.equal(policy.modules.rera_projects, true);
  assert.equal(policy.capabilities.project_workspace, true);
  assert.equal(policy.capabilities.rera_workspace, false);
  assert.equal(policy.terminology.project, 'Development Project');
  assert.equal(policy.terminology.compliance_workspace, 'Development Control Centre');
});

test('ruleset policy applies before profile overrides for modules, terms and fields', () => {
  const profile = publishedProfile({
    module_overrides: {
      rera_projects: true,
      rera_evidence: false,
    },
    terminology_overrides: {
      inventory_unit: 'Profile Parcel',
    },
    field_policy_overrides: {
      plots: {
        plot_no: { label: 'Profile Plot ID', required: false, read_only: true },
      },
    },
  });
  const rulesetVersion = {
    id: 91,
    version: 3,
    module_policy: {
      modules: {
        rera_projects: { enabled: false },
        rera_evidence: { enabled: true },
        rera_stakeholders: { enabled: true },
      },
    },
    terminology_policy: { inventory_unit: 'Ruleset Parcel' },
    field_policy: {
      plots: {
        plot_no: { label: 'Ruleset Plot ID', required: true, help_text: 'Reviewed config' },
      },
    },
    capability_policy: { rera_control_centre: false },
  };

  const policy = resolvePolicyFromProfile({ profile, rulesetVersion });

  assert.equal(policy.modules.rera_projects, true);
  assert.equal(policy.modules.rera_evidence, false);
  assert.equal(Object.hasOwn(policy.modules, 'rera_stakeholders'), false);
  assert.equal(policy.terminology.inventory_unit, 'Profile Parcel');
  assert.deepEqual(policy.fields.plots.plot_no, {
    label: 'Profile Plot ID',
    required: false,
    help_text: 'Reviewed config',
    read_only: true,
  });
  assert.equal(policy.capabilities.rera_control_centre, false);
  assert.ok(policy.reasons.some(({ code }) => code === 'RULESET_POLICY_IGNORED_PARTS'));
  assert.ok(policy.reasons.some(({ code }) => code === 'RULESET_POLICY_APPLIED'));
  assert.ok(policy.reasons.some(({ code }) => code === 'PROFILE_POLICY_APPLIED'));
});

test('mismatched and malformed rulesets cannot open canonical RERA modules', () => {
  const generic = publishedProfile({
    operating_model: 'GENERIC_LAND_DEVELOPER',
    development_basis: 'OTHER',
    ruleset_version_id: 11,
  });
  const mismatched = resolvePolicyFromProfile({
    profile: generic,
    rulesetVersion: {
      id: 12,
      module_policy: { rera_projects: true, rera_rulesets: true },
    },
  });
  assert.equal(mismatched.modules.rera_projects, false);
  assert.equal(mismatched.modules.rera_rulesets, false);
  assert.ok(mismatched.reasons.some(({ code }) => code === 'RULESET_VERSION_MISMATCH'));

  const malformed = resolvePolicyFromProfile({
    profile: generic,
    rulesetVersion: {
      id: 11,
      module_policy: {
        rera_projects: 'truthy',
        rera_stakeholders: true,
        rera_land: true,
      },
    },
  });
  for (const module of CANONICAL_RERA_MODULES.slice(1)) {
    assert.equal(malformed.modules[module], false, module);
  }
  assert.equal(Object.hasOwn(malformed.modules, 'rera_stakeholders'), false);
  assert.equal(Object.hasOwn(malformed.modules, 'rera_land'), false);
});

test('field-policy JSON is bounded, normalized and prototype-safe', () => {
  const valid = validateFieldPolicyPayload({
    plots: {
      plot_no: {
        label: 'Approved Plot Number',
        helpText: 'Use the approved plan reference.',
        required: true,
        readonly: false,
        validation: { min_length: 2 },
        options: ['A', 'B'],
      },
    },
  });
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.value.plots.plot_no, {
    label: 'Approved Plot Number',
    help_text: 'Use the approved plan reference.',
    required: true,
    read_only: false,
    validation: { min_length: 2 },
    options: ['A', 'B'],
  });

  const polluted = validateFieldPolicyPayload(JSON.parse(
    '{"plots":{"plot_no":{"__proto__":{"polluted":true},"unknown_rule":true}}}',
  ));
  assert.equal(polluted.valid, false);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.hasOwn(polluted.value.plots.plot_no, '__proto__'), false);
  assert.equal(validateFieldPolicyPayload([]).valid, false);
});

test('field payload enforcement rejects hidden and server-owned values and enforces required fields', () => {
  const fields = {
    projects: {
      name: { required: true },
      public_note: { visible: true },
      internal_note: { visible: false },
      registration_status: { read_only: true },
      calculated_score: { calculated: true },
    },
  };
  const result = validateFieldPayload({
    fields,
    section: 'projects',
    payload: {
      public_note: 'safe',
      internal_note: 'hidden',
      registration_status: 'REGISTERED',
      calculated_score: 100,
    },
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.value, { public_note: 'safe' });
  assert.ok(result.errors.some((message) => message.includes('internal_note')));
  assert.ok(result.errors.some((message) => message.includes('registration_status')));
  assert.ok(result.errors.some((message) => message.includes('calculated_score')));
  assert.ok(result.errors.some((message) => message.includes('name is required')));

  const partial = validateFieldPayload({
    fields,
    section: 'projects',
    payload: { public_note: 'updated' },
    partial: true,
  });
  assert.deepEqual(partial, {
    valid: true,
    ok: true,
    value: { public_note: 'updated' },
    errors: [],
  });
});

test('operating profile persistence rejects malformed policy and previews nested required fields', () => {
  const cleared = normalizeOperatingProfileInput({
    authority_name: null,
    module_overrides: { rera_evidence: false },
    field_policy_overrides: { projects: { name: { required: true, label: 'Project name' } } },
  }, {
    authority_name: 'Previous Authority',
    operating_model: 'RERA_PROJECT_PROMOTER',
    development_basis: 'OTHER',
    project_shape: 'PLOTTED_DEVELOPMENT',
    regulatory_status: 'DRAFT',
    project_structure: 'SINGLE_PROJECT',
  });
  assert.equal(cleared.authority_name, null);
  assert.equal(cleared.module_overrides.rera_evidence, false);

  assert.throws(
    () => normalizeOperatingProfileInput({ module_overrides: { imaginary_module: true } }),
    /Unknown module override/,
  );
  assert.throws(
    () => normalizeOperatingProfileInput({
      field_policy_overrides: { projects: { name: { executable_rule: true } } },
    }),
    /Unknown field-policy property/,
  );

  const preview = buildOperatingProfilePreview({
    currentProfile: null,
    proposedProfile: {
      ...publishedProfile({ lifecycle_status: 'DRAFT' }),
      field_policy_overrides: cleared.field_policy_overrides,
    },
    rulesetVersion: { id: 91 },
  });
  assert.deepEqual(preview.required_fields_added, [
    { key: 'projects.name', label: 'Project name' },
  ]);
});

test('unknown module checks fail closed without touching the database', async () => {
  let queryCount = 0;
  const db = {
    query: async () => {
      queryCount += 1;
      throw new Error('unexpected query');
    },
  };

  assert.equal(await isSiteModuleAllowed({
    organizationId: 7,
    siteId: 19,
    module: 'rera_stakeholders',
    db,
  }), false);
  assert.equal(queryCount, 0);
});
