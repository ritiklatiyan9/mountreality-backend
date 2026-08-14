import pool from '../config/db.js';

const MIGRATION_KEY = '125_pan_india_rera_rulesets_v1';

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [MIGRATION_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.app_schema_migrations (
        version VARCHAR(160) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const applied = await client.query(
      'SELECT 1 FROM public.app_schema_migrations WHERE version=$1',
      [MIGRATION_KEY],
    );
    if (applied.rowCount > 0) {
      await client.query('COMMIT');
      console.log(`Migration ${MIGRATION_KEY} already applied — skipping`);
      return;
    }

    // One nationwide configuration identity pins the application-enforced
    // central RERA controls. State/UT packs remain optional extensions and
    // are selected only after their jurisdiction matches the Site profile.
    await client.query(`
      INSERT INTO rera_rulesets (
        organization_id,scope,code,name,jurisdiction_country_code,
        jurisdiction_state_code,authority_label,description,source_kind,
        source_review_status,source_review_notes,disclaimer
      )
      SELECT NULL,'PLATFORM','INDIA_RERA_CENTRAL','Central RERA Controls — India','IN',
             NULL,NULL,
             'Nationwide configuration identity for central RERA workflow controls; state and union-territory packs are optional extensions.',
             'INTERNAL_CONFIGURATION','NOT_APPLICABLE',
             'Central safeguards are enforced by application services and are not inferred from a state address.',
             'Operational configuration only. State-specific applicability and legal conclusions require reviewed jurisdiction sources.'
       WHERE NOT EXISTS (
         SELECT 1 FROM rera_rulesets
          WHERE organization_id IS NULL AND UPPER(code)='INDIA_RERA_CENTRAL'
            AND deleted_at IS NULL
       )
    `);
    await client.query(`
      INSERT INTO rera_ruleset_versions (
        ruleset_id,version,version_label,lifecycle_status,
        content_classification,contains_legal_requirements,source_kind,
        source_title,source_review_status,source_review_notes,legal_disclaimer,
        module_policy,terminology_policy,field_policy,capability_policy,published_at
      )
      SELECT r.id,1,'Central controls v1','PUBLISHED',
             'CONFIGURATION_ONLY',FALSE,'INTERNAL_CONFIGURATION',
             'MountReality central RERA workflow controls','NOT_APPLICABLE',
             'No state-specific requirement, deadline, fee or form is encoded by this version.',
             'Operational configuration only; this version does not certify legal compliance.',
             '{
               "mode":"INDIA_RERA_CENTRAL",
               "modules":{
                 "operating_profile":{"enabled":true},
                 "rera_projects":{"enabled":true},
                 "rera_approvals":{"enabled":true},
                 "rera_evidence":{"enabled":true},
                 "rera_rulesets":{"enabled":true}
               }
             }'::jsonb,
             '{"site":"Project Site","project":"RERA Project","phase":"Project Phase","stakeholder":"Project Stakeholder"}'::jsonb,
             '{}'::jsonb,
             '{
               "profile_configured":true,
               "profile_versioned":true,
               "field_policy_enabled":true,
               "project_workspace":true,
               "rera_workspace":true,
               "rera_control_centre":true,
               "stakeholder_register":true,
               "approval_register":true,
               "evidence_vault":true,
               "ruleset_information":true
             }'::jsonb,
             NOW()
        FROM rera_rulesets r
       WHERE r.organization_id IS NULL AND UPPER(r.code)='INDIA_RERA_CENTRAL'
         AND r.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM rera_ruleset_versions version
            WHERE version.ruleset_id=r.id AND version.version=1
         )
    `);

    // Retire the old global Haryana demo seed only when nothing has pinned it.
    // Real tenant-authored Haryana rulesets are untouched.
    await client.query(`
      UPDATE rera_rulesets ruleset
         SET is_active=FALSE,
             source_review_notes='Deprecated platform demo seed. Use a tenant-reviewed jurisdiction pack for Haryana.',
             updated_at=NOW()
       WHERE ruleset.organization_id IS NULL
         AND UPPER(ruleset.code)='HRERA_FOUNDATION'
         AND NOT EXISTS (
           SELECT 1
             FROM rera_ruleset_versions version
             JOIN site_operating_profile_revisions profile
               ON profile.ruleset_version_id=version.id AND profile.deleted_at IS NULL
            WHERE version.ruleset_id=ruleset.id
           UNION ALL
           SELECT 1
             FROM rera_ruleset_versions version
             JOIN rera_projects project
               ON project.ruleset_version_id=version.id AND project.deleted_at IS NULL
            WHERE version.ruleset_id=ruleset.id
         )
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION india_jurisdiction_code(p_value TEXT)
      RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
        SELECT CASE REGEXP_REPLACE(UPPER(BTRIM(COALESCE(p_value,''))),'[^A-Z0-9]+',' ','g')
          WHEN 'AN' THEN 'AN' WHEN 'ANDAMAN AND NICOBAR ISLANDS' THEN 'AN'
          WHEN 'AP' THEN 'AP' WHEN 'ANDHRA PRADESH' THEN 'AP'
          WHEN 'AR' THEN 'AR' WHEN 'ARUNACHAL PRADESH' THEN 'AR'
          WHEN 'AS' THEN 'AS' WHEN 'ASSAM' THEN 'AS'
          WHEN 'BR' THEN 'BR' WHEN 'BIHAR' THEN 'BR'
          WHEN 'CH' THEN 'CH' WHEN 'CHANDIGARH' THEN 'CH'
          WHEN 'CG' THEN 'CG' WHEN 'CT' THEN 'CG' WHEN 'CHHATTISGARH' THEN 'CG'
          WHEN 'DH' THEN 'DH' WHEN 'DN' THEN 'DH' WHEN 'DD' THEN 'DH'
          WHEN 'DADRA AND NAGAR HAVELI AND DAMAN AND DIU' THEN 'DH'
          WHEN 'DL' THEN 'DL' WHEN 'DELHI' THEN 'DL' WHEN 'NCT OF DELHI' THEN 'DL'
          WHEN 'GA' THEN 'GA' WHEN 'GOA' THEN 'GA'
          WHEN 'GJ' THEN 'GJ' WHEN 'GUJARAT' THEN 'GJ'
          WHEN 'HR' THEN 'HR' WHEN 'HARYANA' THEN 'HR'
          WHEN 'HP' THEN 'HP' WHEN 'HIMACHAL PRADESH' THEN 'HP'
          WHEN 'JK' THEN 'JK' WHEN 'JAMMU AND KASHMIR' THEN 'JK'
          WHEN 'JH' THEN 'JH' WHEN 'JHARKHAND' THEN 'JH'
          WHEN 'KA' THEN 'KA' WHEN 'KARNATAKA' THEN 'KA'
          WHEN 'KL' THEN 'KL' WHEN 'KERALA' THEN 'KL'
          WHEN 'LA' THEN 'LA' WHEN 'LADAKH' THEN 'LA'
          WHEN 'LD' THEN 'LD' WHEN 'LAKSHADWEEP' THEN 'LD'
          WHEN 'MP' THEN 'MP' WHEN 'MADHYA PRADESH' THEN 'MP'
          WHEN 'MH' THEN 'MH' WHEN 'MAHARASHTRA' THEN 'MH'
          WHEN 'MN' THEN 'MN' WHEN 'MANIPUR' THEN 'MN'
          WHEN 'ML' THEN 'ML' WHEN 'MEGHALAYA' THEN 'ML'
          WHEN 'MZ' THEN 'MZ' WHEN 'MIZORAM' THEN 'MZ'
          WHEN 'NL' THEN 'NL' WHEN 'NAGALAND' THEN 'NL'
          WHEN 'OD' THEN 'OD' WHEN 'OR' THEN 'OD' WHEN 'ODISHA' THEN 'OD' WHEN 'ORISSA' THEN 'OD'
          WHEN 'PY' THEN 'PY' WHEN 'PUDUCHERRY' THEN 'PY' WHEN 'PONDICHERRY' THEN 'PY'
          WHEN 'PB' THEN 'PB' WHEN 'PUNJAB' THEN 'PB'
          WHEN 'RJ' THEN 'RJ' WHEN 'RAJASTHAN' THEN 'RJ'
          WHEN 'SK' THEN 'SK' WHEN 'SIKKIM' THEN 'SK'
          WHEN 'TN' THEN 'TN' WHEN 'TAMIL NADU' THEN 'TN'
          WHEN 'TS' THEN 'TS' WHEN 'TG' THEN 'TS' WHEN 'TELANGANA' THEN 'TS'
          WHEN 'TR' THEN 'TR' WHEN 'TRIPURA' THEN 'TR'
          WHEN 'UP' THEN 'UP' WHEN 'UTTAR PRADESH' THEN 'UP'
          WHEN 'UK' THEN 'UK' WHEN 'UT' THEN 'UK' WHEN 'UTTARAKHAND' THEN 'UK' WHEN 'UTTARANCHAL' THEN 'UK'
          WHEN 'WB' THEN 'WB' WHEN 'WEST BENGAL' THEN 'WB'
          ELSE NULL
        END
      $$
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION enforce_site_profile_ruleset_jurisdiction()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        v_code TEXT;
        v_country TEXT;
        v_state TEXT;
        v_active BOOLEAN;
      BEGIN
        IF NEW.ruleset_version_id IS NULL
           OR NEW.operating_model NOT IN ('RERA_PROJECT_PROMOTER','RERA_ONGOING_PROJECT_REGULARISATION') THEN
          RETURN NEW;
        END IF;
        SELECT UPPER(ruleset.code),UPPER(ruleset.jurisdiction_country_code),
               ruleset.jurisdiction_state_code,ruleset.is_active
          INTO v_code,v_country,v_state,v_active
          FROM rera_ruleset_versions version
          JOIN rera_rulesets ruleset ON ruleset.id=version.ruleset_id
         WHERE version.id=NEW.ruleset_version_id
           AND version.deleted_at IS NULL AND ruleset.deleted_at IS NULL;
        IF NOT FOUND OR v_active IS DISTINCT FROM TRUE THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='The selected RERA ruleset is not active',
            CONSTRAINT='site_profile_ruleset_inactive';
        END IF;
        IF UPPER(BTRIM(COALESCE(NEW.jurisdiction_country,''))) NOT IN ('IN','INDIA') THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='The central RERA operating profile is available only for India',
            CONSTRAINT='site_profile_ruleset_country_mismatch';
        END IF;
        IF v_code='INDIA_RERA_CENTRAL' THEN RETURN NEW; END IF;
        IF v_country<>'IN' OR v_state IS NULL
           OR india_jurisdiction_code(NEW.jurisdiction_state) IS NULL
           OR india_jurisdiction_code(NEW.jurisdiction_state)
              IS DISTINCT FROM india_jurisdiction_code(v_state) THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='The selected state ruleset does not match the Site jurisdiction',
            CONSTRAINT='site_profile_ruleset_jurisdiction_mismatch';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_site_profile_ruleset_jurisdiction ON site_operating_profile_revisions');
    await client.query(`
      CREATE TRIGGER trg_site_profile_ruleset_jurisdiction
      BEFORE INSERT OR UPDATE OF operating_model,jurisdiction_country,jurisdiction_state,ruleset_version_id
      ON site_operating_profile_revisions
      FOR EACH ROW EXECUTE FUNCTION enforce_site_profile_ruleset_jurisdiction()
    `);

    await client.query(
      'INSERT INTO public.app_schema_migrations(version) VALUES ($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('✓ Migration applied: pan-India RERA ruleset selection');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration 125_pan_india_rera_rulesets failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
