import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  INDIA_RERA_CENTRAL_RULESET_CODE,
  normalizeIndiaJurisdictionCode,
  rulesetMatchesIndiaJurisdiction,
} from '../src/services/jurisdiction.service.js';
import { validateOperatingProfile } from '../src/services/operatingProfile.service.js';

const profile = (overrides = {}) => ({
  operating_model: 'RERA_PROJECT_PROMOTER',
  jurisdiction_country: 'INDIA',
  jurisdiction_state: '',
  development_basis: 'OTHER',
  project_shape: 'PLOTTED_DEVELOPMENT',
  regulatory_status: 'APPLICABILITY_UNDER_REVIEW',
  project_structure: 'SINGLE_PROJECT',
  finance_payment_mode: 'ALL_MODES',
  ruleset_version_id: 10,
  ...overrides,
});

const publishedRuleset = (overrides = {}) => ({
  id: 10,
  lifecycle_status: 'PUBLISHED',
  source_review_status: 'NOT_APPLICABLE',
  effective_from: null,
  effective_to: null,
  organization_id: null,
  code: INDIA_RERA_CENTRAL_RULESET_CODE,
  jurisdiction_country_code: 'IN',
  jurisdiction_state_code: null,
  ...overrides,
});

const validateWithRuleset = (candidateProfile, ruleset) => validateOperatingProfile(candidateProfile, {
  organizationId: 3,
  siteId: 8,
  db: { query: async () => ({ rows: [ruleset] }) },
});

test('India jurisdiction normalization is state-aware and never infers Haryana from a blank value', () => {
  assert.equal(normalizeIndiaJurisdictionCode(''), null);
  assert.equal(normalizeIndiaJurisdictionCode('Haryana'), 'HR');
  assert.equal(normalizeIndiaJurisdictionCode('HR'), 'HR');
  assert.equal(normalizeIndiaJurisdictionCode('Uttar Pradesh'), 'UP');
  assert.equal(normalizeIndiaJurisdictionCode('NCT of Delhi'), 'DL');
  assert.equal(normalizeIndiaJurisdictionCode('Pondicherry'), 'PY');
  assert.equal(rulesetMatchesIndiaJurisdiction({
    profileCountry: 'INDIA',
    profileState: '',
    rulesetCountry: 'IN',
    rulesetState: 'HR',
    allowCentral: false,
  }), false);
});

test('central RERA controls work nationwide while a state extension must match exactly', async () => {
  const central = await validateWithRuleset(profile(), publishedRuleset());
  assert.equal(central.valid, true);

  const mismatch = await validateWithRuleset(
    profile({ jurisdiction_state: 'Uttar Pradesh' }),
    publishedRuleset({ code: 'HR_TENANT_PACK', jurisdiction_state_code: 'HR' }),
  );
  assert.equal(mismatch.valid, false);
  assert.ok(mismatch.errors.some((row) => row.code === 'RULESET_JURISDICTION_MISMATCH'));

  const match = await validateWithRuleset(
    profile({ jurisdiction_state: 'Haryana' }),
    publishedRuleset({ code: 'HR_TENANT_PACK', jurisdiction_state_code: 'HR' }),
  );
  assert.equal(match.valid, true);

  const outsideIndia = await validateWithRuleset(
    profile({ jurisdiction_country: 'OTHER' }),
    publishedRuleset(),
  );
  assert.equal(outsideIndia.valid, false);

  const missingCountry = await validateWithRuleset(
    profile({ jurisdiction_country: '' }),
    publishedRuleset(),
  );
  assert.equal(missingCountry.valid, false);
});

test('fresh installs seed nationwide controls and the upgrade retires only the legacy platform demo', async () => {
  const [foundation, upgrade, controller, errorMiddleware, settings] = await Promise.all([
    readFile(new URL('../src/migrations/094_rera_phase1_foundation.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/migrations/125_pan_india_rera_rulesets.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/controllers/operatingProfile.controller.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/middlewares/error.middleware.js', import.meta.url), 'utf8'),
    readFile(new URL('../../Frontend/src/components/settings/OperatingProfileSettings.jsx', import.meta.url), 'utf8'),
  ]);

  assert.match(foundation, /INDIA_RERA_CENTRAL/);
  assert.doesNotMatch(foundation, /HRERA_FOUNDATION|Haryana RERA Operating Foundation/);
  assert.match(upgrade, /organization_id IS NULL[\s\S]*HRERA_FOUNDATION/);
  assert.match(upgrade, /trg_site_profile_ruleset_jurisdiction/);
  assert.match(controller, /applyCentralReraRuleset/);
  assert.match(errorMiddleware, /site_profile_ruleset_jurisdiction_mismatch/);
  assert.match(errorMiddleware, /RULESET_JURISDICTION_MISMATCH/);
  assert.match(settings, /rulesetMatchesJurisdiction/);
  assert.match(settings, /No reviewed \{jurisdictionName\} extension is configured/);
});
