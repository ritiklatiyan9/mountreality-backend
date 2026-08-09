import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVAL_EXPIRY_STATES,
  RERA_APPROVAL_RECORD_KINDS,
  RERA_APPROVAL_STATUSES,
  RERA_AREA_UNITS,
  RERA_DEVELOPMENT_BASES,
  RERA_ENTITY_TYPES,
  RERA_FIELD_POLICY_INPUTS,
  RERA_PARTICIPANT_ROLES,
  RERA_PROJECT_SHAPES,
  RERA_REGULATORY_STATUSES,
  RERA_STAKEHOLDER_TYPES,
  ReraFoundationValidationError,
  classifyApprovalRecordKind,
  buildReraFieldPolicyPayload,
  deriveApprovalExpiry,
  normalizeReraApprovalInput,
  normalizeReraParticipantInput,
  normalizeReraPhaseInput,
  normalizeReraProjectInput,
  normalizeReraStakeholderInput,
  sanitizeReraJsonObject,
} from '../src/services/reraFoundation.service.js';

const expectValidation = (operation, field, code) => {
  assert.throws(operation, (error) => (
    error instanceof ReraFoundationValidationError
    && error.statusCode === 400
    && error.field === field
    && (!code || error.code === code)
  ));
};

const projectContext = {
  site_id: 10,
  operating_profile_revision_id: 21,
  ruleset_version_id: 32,
};

test('exported domain enums mirror migration 094 values', () => {
  assert.deepEqual(RERA_PROJECT_SHAPES, [
    'PLOTTED_DEVELOPMENT', 'APARTMENT', 'COMMERCIAL', 'MIXED_USE',
  ]);
  assert.deepEqual(RERA_DEVELOPMENT_BASES, [
    'LANDOWNER', 'DEVELOPMENT_AGREEMENT', 'JOINT_DEVELOPMENT_AGREEMENT',
    'COLLABORATION_AGREEMENT', 'CO_PROMOTER', 'POWER_OF_ATTORNEY', 'OTHER',
  ]);
  assert.deepEqual(RERA_AREA_UNITS, ['SQ_M', 'SQ_FT', 'SQ_YD', 'ACRE', 'HECTARE', 'BIGHA']);
  assert.ok(RERA_REGULATORY_STATUSES.includes('REGISTERED'));
  assert.ok(RERA_REGULATORY_STATUSES.includes('APPLICABILITY_UNDER_REVIEW'));
  assert.ok(RERA_STAKEHOLDER_TYPES.includes('AUTHORIZED_SIGNATORY'));
  assert.ok(RERA_ENTITY_TYPES.includes('GOVERNMENT_BODY'));
  assert.deepEqual(RERA_PARTICIPANT_ROLES, RERA_STAKEHOLDER_TYPES);
  assert.deepEqual(RERA_APPROVAL_STATUSES, [
    'MISSING', 'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED',
    'RENEWAL_DUE', 'EXPIRED', 'REJECTED', 'NOT_APPLICABLE',
  ]);
  assert.deepEqual(RERA_APPROVAL_RECORD_KINDS, [
    'PROJECT_REGISTRATION', 'PHASE_REGISTRATION', 'APPROVAL', 'NOC',
    'PERMIT', 'CERTIFICATE', 'EXEMPTION', 'EXTENSION', 'OTHER',
  ]);
});

test('project normalizer accepts frontend aliases and emits canonical schema columns', () => {
  const project = normalizeReraProjectInput({
    ...projectContext,
    code: 'ggn-mix-01',
    project_name: 'Green District',
    project_type: 'mixed-use',
    development_basis: 'joint-development-agreement',
    status: 'registered',
    authority: 'Haryana Real Estate Regulatory Authority, Gurugram',
    authority_code: 'hrera-ggm',
    jurisdiction: {
      state: 'Haryana',
      district: 'Gurugram',
      pincode: '122001',
      address: 'Sector 70',
    },
    registration_number: 'HRERA-GGM-123',
    registration_date: '2026-08-01',
    registration_expiry_date: '2031-08-01',
    proposed_start_date: '2026-09-01',
    committed_completion_date: '2030-09-01',
    official_source_url: 'https://haryanarera.gov.in/project/HRERA-GGM-123',
    total_land_area: '25.5',
    project_area: 20,
    area_unit: 'acre',
    metadata: { plan: { version: 1 }, tags: ['mixed'] },
  });

  assert.equal(project.site_id, 10);
  assert.equal(project.operating_profile_revision_id, 21);
  assert.equal(project.ruleset_version_id, 32);
  assert.equal(project.project_code, 'GGN-MIX-01');
  assert.equal(project.name, 'Green District');
  assert.equal(project.project_shape, 'MIXED_USE');
  assert.equal(project.development_basis, 'JOINT_DEVELOPMENT_AGREEMENT');
  assert.equal(project.regulatory_status, 'REGISTERED');
  assert.equal(project.authority_name, 'Haryana Real Estate Regulatory Authority, Gurugram');
  assert.equal(project.authority_code, 'HRERA-GGM');
  assert.equal(project.state, 'Haryana');
  assert.equal(project.district, 'Gurugram');
  assert.equal(project.address, 'Sector 70');
  assert.equal(project.proposed_completion_date, '2030-09-01');
  assert.equal(project.source_url, 'https://haryanarera.gov.in/project/HRERA-GGM-123');
  assert.equal(project.total_land_area, 25.5);
  assert.equal(project.project_area, 20);
  assert.equal(project.area_unit, 'ACRE');
  assert.deepEqual(project.metadata, { plan: { version: 1 }, tags: ['mixed'] });
  assert.equal(Object.hasOwn(project, 'organization_id'), false);
});

test('project normalizer enforces registration, status, area and date invariants', () => {
  const base = {
    ...projectContext,
    name: 'Project',
    project_code: 'P-1',
    project_shape: 'PLOTTED_DEVELOPMENT',
    development_basis: 'LANDOWNER',
  };

  expectValidation(
    () => normalizeReraProjectInput({ ...base, regulatory_status: 'REGISTERED' }),
    'authority_id',
    'REGISTERED_AUTHORITY_REQUIRED',
  );
  expectValidation(
    () => normalizeReraProjectInput({
      ...base,
      regulatory_status: 'REVOKED',
    }),
    'status_reason',
    'STATUS_REASON_REQUIRED',
  );
  expectValidation(
    () => normalizeReraProjectInput({ ...base, total_land_area: 10, project_area: 11 }),
    'project_area',
    'AREA_EXCEEDS_TOTAL',
  );
  expectValidation(
    () => normalizeReraProjectInput({
      ...base,
      proposed_start_date: '2027-01-01',
      committed_completion_date: '2026-12-31',
    }),
    'proposed_completion_date',
    'DATE_ORDER',
  );
  expectValidation(
    () => normalizeReraProjectInput({ ...base, official_source_url: 'javascript:alert(1)' }),
    'source_url',
    'INVALID_URL',
  );
  expectValidation(
    () => normalizeReraProjectInput({
      ...projectContext,
      name: 'Project',
      project_code: 'P-1',
      project_type: 'VILLA',
      development_basis: 'LANDOWNER',
    }),
    'project_shape',
    'UNSUPPORTED_VALUE',
  );
});

test('phase normalizer accepts code/status aliases and inherits recorded authority details', () => {
  const phase = normalizeReraPhaseInput({
    site_id: '10',
    project_id: '51',
    code: 'phase-a',
    phase_name: 'Phase A',
    status: 'REGISTERED',
    registration_number: 'HRERA-PH-A',
    registration_date: '2026-08-02',
    proposed_start_date: '2026-09-01',
    committed_completion_date: '2028-09-01',
    phase_area: '8.25',
    area_unit: 'hectare',
  }, {
    authority_code: 'HRERA-GGM',
    authority_name: 'HRERA Gurugram',
  });

  assert.equal(phase.site_id, 10);
  assert.equal(phase.rera_project_id, 51);
  assert.equal(phase.phase_code, 'PHASE-A');
  assert.equal(phase.name, 'Phase A');
  assert.equal(phase.regulatory_status, 'REGISTERED');
  assert.equal(phase.authority_id, null);
  assert.equal(phase.authority_code, 'HRERA-GGM');
  assert.equal(phase.authority_name, 'HRERA Gurugram');
  assert.equal(phase.proposed_completion_date, '2028-09-01');
  assert.equal(phase.phase_area, 8.25);
  assert.equal(phase.area_unit, 'HECTARE');
});

test('phase normalizer enforces phase status and date rules', () => {
  const base = {
    site_id: 10,
    project_id: 51,
    code: 'P1',
    name: 'Phase 1',
  };
  expectValidation(
    () => normalizeReraPhaseInput({ ...base, status: 'REGISTERED' }),
    'authority_id',
    'REGISTERED_AUTHORITY_REQUIRED',
  );
  expectValidation(
    () => normalizeReraPhaseInput({ ...base, status: 'COMPLETED' }),
    'actual_completion_date',
    'COMPLETION_DATE_REQUIRED',
  );
  expectValidation(
    () => normalizeReraPhaseInput({ ...base, registration_expiry_date: '2028-01-01' }),
    'registration_expiry_date',
    'MISSING_START_DATE',
  );
});

test('stakeholder normalizer accepts frontend identity, address and contact aliases', () => {
  const stakeholder = normalizeReraStakeholderInput({
    legal_name: '  Example Build LLP  ',
    entity_type: 'llp',
    pan: 'abcde1234f',
    gstin: '06abcde1234f1z5',
    cin_llpin: 'aab-1234',
    registered_address: 'Sector 62, Gurugram',
    contact_name: 'Riya Sharma',
    contact_email: 'LEGAL@EXAMPLE.COM',
    contact_phone: '+91 99999 99999',
    status: 'active',
    metadata: { source: 'customer_record' },
  });

  assert.equal(stakeholder.stakeholder_type, 'OTHER');
  assert.equal(stakeholder.entity_type, 'LLP');
  assert.equal(stakeholder.legal_name, 'Example Build LLP');
  assert.equal(stakeholder.pan, 'ABCDE1234F');
  assert.equal(stakeholder.gstin, '06ABCDE1234F1Z5');
  assert.equal(stakeholder.cin_or_llpin, 'AAB-1234');
  assert.deepEqual(stakeholder.address, { formatted: 'Sector 62, Gurugram' });
  assert.equal(stakeholder.authorized_signatory_name, 'Riya Sharma');
  assert.equal(stakeholder.email, 'legal@example.com');
  assert.equal(stakeholder.phone, '+91 99999 99999');
  assert.equal(stakeholder.status, 'ACTIVE');
});

test('stakeholder review and safe JSON constraints fail closed', () => {
  expectValidation(
    () => normalizeReraStakeholderInput({ legal_name: 'Name', entity_type: 'ALIEN' }),
    'entity_type',
    'UNSUPPORTED_VALUE',
  );
  expectValidation(
    () => normalizeReraStakeholderInput({
      legal_name: 'Name',
      entity_type: 'COMPANY',
      review_status: 'REVIEWED',
    }),
    'reviewed_at',
    'REVIEW_TIMESTAMP_REQUIRED',
  );
  const unsafe = JSON.parse('{"safe":true,"__proto__":{"polluted":true}}');
  expectValidation(() => sanitizeReraJsonObject(unsafe), 'metadata', 'UNSAFE_JSON_KEY');
  assert.equal(Object.prototype.polluted, undefined);
  expectValidation(
    () => sanitizeReraJsonObject({ note: 'bad\u0000text' }),
    'metadata',
    'UNSAFE_JSON',
  );
});

test('participant normalizer maps frontend relationship aliases to exact schema columns', () => {
  const participant = normalizeReraParticipantInput({
    site_id: '10',
    project_id: '51',
    phase_id: '61',
    stakeholder_id: '71',
    role: 'AUTHORISED_SIGNATORY',
    primary: 'true',
    ownership_share: '12.5',
    start_date: '2026-08-01',
    end_date: '2027-08-01',
    basis: 'Recorded power of attorney reference',
  });

  assert.equal(participant.site_id, 10);
  assert.equal(participant.rera_project_id, 51);
  assert.equal(participant.rera_project_phase_id, 61);
  assert.equal(participant.stakeholder_id, 71);
  assert.equal(Object.hasOwn(participant, 'rera_stakeholder_id'), false);
  assert.equal(participant.participant_role, 'AUTHORIZED_SIGNATORY');
  assert.equal(participant.is_primary, true);
  assert.equal(participant.ownership_percentage, 12.5);
  assert.equal(participant.effective_from, '2026-08-01');
  assert.equal(participant.effective_to, '2027-08-01');
  assert.equal(participant.basis_reference, 'Recorded power of attorney reference');

  assert.equal(normalizeReraParticipantInput({
    site_id: 10,
    project_id: 51,
    stakeholder_id: 71,
    role: 'PROFESSIONAL',
  }).participant_role, 'CONSULTANT');
});

test('field-policy payload canonicalizes aliases and derived persisted values', () => {
  const participant = buildReraFieldPolicyPayload('rera_participants', {
    rera_stakeholder_id: 71,
    role: 'PROMOTER',
    phase_id: 61,
  }, {
    stakeholder_id: 71,
    participant_role: 'PROMOTER',
    rera_project_phase_id: 61,
  });
  assert.equal(participant.stakeholder_id, 71);
  assert.equal(participant.participant_role, 'PROMOTER');
  assert.equal(participant.rera_project_phase_id, 61);

  const project = buildReraFieldPolicyPayload('rera_projects', {
    authority: 'Authority',
    jurisdiction: { state: 'Haryana', district: 'Gurugram' },
    area: 12,
    source_reference: 'https://authority.example/project/1',
  }, {
    authority_name: 'Authority',
    authority_id: null,
    state: 'Haryana',
    district: 'Gurugram',
    address: null,
    pincode: null,
    project_area: 12,
    source_reference: 'https://authority.example/project/1',
    source_url: 'https://authority.example/project/1',
  });
  assert.equal(project.authority_name, 'Authority');
  assert.equal(project.project_area, 12);
  assert.equal(project.state, 'Haryana');
  assert.equal(project.district, 'Gurugram');
  assert.equal(project.source_url, 'https://authority.example/project/1');

  const approval = buildReraFieldPolicyPayload('rera_approvals', {
    approval_type: 'Fire NOC',
    authority: 'Authority',
    source_reference: 'https://authority.example/noc/1',
  }, {
    name: 'Fire NOC',
    licence_type: 'Fire NOC',
    rera_record_kind: 'NOC',
    authority_id: null,
    rera_authority_label: 'Authority',
    rera_source_reference: 'https://authority.example/noc/1',
    rera_source_url: 'https://authority.example/noc/1',
  });
  assert.equal(approval.name, 'Fire NOC');
  assert.equal(approval.licence_type, 'Fire NOC');
  assert.equal(approval.rera_record_kind, 'NOC');
  assert.equal(approval.rera_authority_label, 'Authority');
  assert.equal(approval.rera_source_url, 'https://authority.example/noc/1');

  // Every declared public alias must materialize its canonical persisted key;
  // this is what makes canonical hidden/read-only policy impossible to bypass.
  for (const [section, fields] of Object.entries(RERA_FIELD_POLICY_INPUTS)) {
    for (const [canonical, aliases] of Object.entries(fields)) {
      for (const alias of aliases) {
        const sentinel = `${section}:${canonical}:${alias}`;
        const candidate = buildReraFieldPolicyPayload(
          section,
          { [alias]: 'caller value' },
          { [canonical]: sentinel },
        );
        assert.equal(candidate[canonical], sentinel, `${section}.${alias} -> ${canonical}`);
      }
    }
  }
});

test('participant ownership and effective-date constraints are enforced', () => {
  const base = { site_id: 10, project_id: 51, stakeholder_id: 71, role: 'PROMOTER' };
  expectValidation(
    () => normalizeReraParticipantInput({ ...base, ownership_percentage: 101 }),
    'ownership_percentage',
    'OUT_OF_RANGE',
  );
  expectValidation(
    () => normalizeReraParticipantInput({ ...base, effective_to: '2026-09-01' }),
    'effective_to',
    'MISSING_START_DATE',
  );
  expectValidation(
    () => normalizeReraParticipantInput({ ...base, role: 'SUPER_PROMOTER' }),
    'participant_role',
    'UNSUPPORTED_VALUE',
  );
});

test('approval normalizer maps current UI fields into compliance_licences RERA columns', () => {
  const approval = normalizeReraApprovalInput({
    site_id: '10',
    project_id: '51',
    phase_id: '61',
    approval_type: 'Fire NOC',
    authority: 'Municipal Authority',
    reference_number: 'NOC-2026-7',
    issue_date: '2026-08-01',
    valid_from: '2026-08-02',
    valid_until: '2027-08-01',
    status: 'APPROVED',
    source_reference: 'Official portal record 7',
    official_source_url: 'https://authority.example.gov/noc/7',
    owner_name: 'Riya Sharma',
    review_status: 'REVIEWED',
    reviewed_by: '81',
    reviewed_at: '2026-08-09T10:30:00+05:30',
    reminder_days: [30, '7', 30, 0],
    metadata: { applicability: 'configured' },
  });

  assert.equal(approval.name, 'Fire NOC');
  assert.equal(approval.licence_type, 'Fire NOC');
  assert.equal(approval.rera_record_kind, 'NOC');
  assert.equal(approval.rera_project_id, 51);
  assert.equal(approval.rera_project_phase_id, 61);
  assert.equal(approval.rera_authority_label, 'Municipal Authority');
  assert.equal(approval.licence_number, 'NOC-2026-7');
  assert.equal(approval.issue_date, '2026-08-01');
  assert.equal(approval.effective_date, '2026-08-02');
  assert.equal(approval.expiry_date, '2027-08-01');
  assert.equal(approval.rera_status, 'APPROVED');
  assert.equal(approval.renewal_status, 'NOT_STARTED');
  assert.equal(approval.rera_source_reference, 'Official portal record 7');
  assert.equal(approval.rera_source_url, 'https://authority.example.gov/noc/7');
  assert.equal(approval.rera_owner_label, 'Riya Sharma');
  assert.equal(approval.rera_evidence_review_status, 'ACCEPTED');
  assert.equal(approval.rera_reviewed_by, 81);
  assert.equal(approval.rera_reviewed_at, '2026-08-09T05:00:00.000Z');
  assert.deepEqual(approval.reminder_days, [30, 7, 0]);
  assert.deepEqual(approval.metadata, { applicability: 'configured' });
});

test('approval classification and UI review aliases are deterministic', () => {
  assert.equal(classifyApprovalRecordKind('Project registration'), 'PROJECT_REGISTRATION');
  assert.equal(classifyApprovalRecordKind('Phase registration'), 'PHASE_REGISTRATION');
  assert.equal(classifyApprovalRecordKind('Occupancy certificate'), 'CERTIFICATE');
  assert.equal(classifyApprovalRecordKind('Layout sanction'), 'APPROVAL');
  assert.equal(classifyApprovalRecordKind('Anything', 'OTHER'), 'OTHER');

  const approval = normalizeReraApprovalInput({
    site_id: 10,
    project_id: 51,
    approval_type: 'Layout approval',
    status: 'UNDER_REVIEW',
    review_status: 'UNDER_REVIEW',
  });
  assert.equal(approval.rera_status, 'UNDER_REVIEW');
  assert.equal(approval.rera_evidence_review_status, 'PENDING');
});

test('approval normalizer rejects invalid workflow, review and date payloads', () => {
  const base = { site_id: 10, project_id: 51, approval_type: 'Approval' };
  expectValidation(
    () => normalizeReraApprovalInput({ ...base, status: 'REGISTERED' }),
    'rera_status',
    'UNSUPPORTED_VALUE',
  );
  expectValidation(
    () => normalizeReraApprovalInput({ ...base, review_status: 'REVIEWED' }),
    'rera_evidence_review_status',
    'REVIEW_ACTOR_REQUIRED',
  );
  expectValidation(
    () => normalizeReraApprovalInput({
      ...base,
      issue_date: '2027-01-01',
      valid_until: '2026-12-31',
    }),
    'expiry_date',
    'DATE_ORDER',
  );
  expectValidation(
    () => normalizeReraApprovalInput({ ...base, official_source_url: 'file:///tmp/evidence' }),
    'rera_source_url',
    'INVALID_URL',
  );
  expectValidation(
    () => normalizeReraApprovalInput({ ...base, status: 'APPROVED' }),
    'authority',
    'APPROVED_AUTHORITY_REQUIRED',
  );
  expectValidation(
    () => normalizeReraApprovalInput({ ...base, status: 'EXPIRED' }),
    'expiry_date',
    'EXPIRY_DATE_REQUIRED',
  );
  expectValidation(
    () => normalizeReraApprovalInput({ ...base, status: 'NOT_APPLICABLE' }),
    'rera_status',
    'NOT_APPLICABLE_REVIEW_REQUIRED',
  );
});

test('approval expiry derivation is calendar-based and threshold-configurable', () => {
  assert.deepEqual(deriveApprovalExpiry({ today: '2026-08-01', thresholdDays: 18 }), {
    state: 'NO_EXPIRY',
    status: 'NO_EXPIRY',
    expiry_date: null,
    as_of_date: '2026-08-01',
    threshold_days: 18,
    days_remaining: null,
    is_expired: false,
    is_expiring_soon: false,
    needs_attention: false,
  });

  const active = deriveApprovalExpiry({
    expiry_date: '2026-09-01', today: '2026-08-01', threshold_days: 30,
  });
  assert.equal(active.state, APPROVAL_EXPIRY_STATES.ACTIVE);
  assert.equal(active.days_remaining, 31);
  assert.equal(active.needs_attention, false);

  const soon = deriveApprovalExpiry('2026-08-19', {
    today: '2026-08-01', thresholdDays: 18,
  });
  assert.equal(soon.state, APPROVAL_EXPIRY_STATES.EXPIRING_SOON);
  assert.equal(soon.days_remaining, 18);
  assert.equal(soon.needs_attention, true);

  const today = deriveApprovalExpiry({ valid_until: '2026-08-01', today: '2026-08-01' });
  assert.equal(today.state, APPROVAL_EXPIRY_STATES.EXPIRES_TODAY);
  assert.equal(today.days_remaining, 0);

  const expired = deriveApprovalExpiry({ expiryDate: '2026-07-31', asOfDate: '2026-08-01' });
  assert.equal(expired.state, APPROVAL_EXPIRY_STATES.EXPIRED);
  assert.equal(expired.days_remaining, -1);
  assert.equal(expired.is_expired, true);
});

test('expiry threshold and dates reject malformed configuration', () => {
  expectValidation(
    () => deriveApprovalExpiry({ expiry_date: '2026-02-30', today: '2026-01-01' }),
    'expiry_date',
    'INVALID_DATE',
  );
  expectValidation(
    () => deriveApprovalExpiry({ expiry_date: '2026-03-01', today: '2026-01-01', thresholdDays: -1 }),
    'threshold_days',
    'INVALID_THRESHOLD',
  );
  expectValidation(
    () => deriveApprovalExpiry({ expiry_date: '2026-03-01', today: 'not-a-date' }),
    'today',
    'INVALID_DATE',
  );
});
