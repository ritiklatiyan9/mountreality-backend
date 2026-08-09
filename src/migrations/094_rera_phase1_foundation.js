import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 094 — RERA Phase 1 operating foundation.
 *
 * This migration is deliberately additive and forward-only:
 *   - it creates versioned policy/configuration records;
 *   - it does not classify or backfill any existing site;
 *   - it does not seed statutory requirements, deadlines or compliance claims;
 *   - it links the new domain to the existing compliance control centre rather
 *     than introducing another approval, evidence or reminder subsystem.
 *
 * Published profile revisions are intended to be treated as immutable by the
 * application. A change is represented by a new revision and the former
 * published revision is moved to SUPERSEDED in the same transaction.
 */
async function migrate() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('094_rera_phase1_foundation'))`);

    // Composite keys below prevent a record from pointing at another tenant's
    // site or authority while retaining the existing single-column PKs.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_sites_organization_id_id
        ON sites (organization_id, id)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_authorities_org_id
        ON compliance_authorities (organization_id, id)
    `);

    // ---------------------------------------------------------------------
    // Versioned, source-aware platform/tenant operating rulesets.
    // ---------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_rulesets (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE RESTRICT,
        scope VARCHAR(20) NOT NULL DEFAULT 'PLATFORM'
          CHECK (scope IN ('PLATFORM', 'TENANT')),
        code VARCHAR(80) NOT NULL CHECK (BTRIM(code) <> ''),
        name VARCHAR(200) NOT NULL CHECK (BTRIM(name) <> ''),
        jurisdiction_country_code VARCHAR(2) NOT NULL DEFAULT 'IN',
        jurisdiction_state_code VARCHAR(20),
        authority_label VARCHAR(200),
        description TEXT,
        source_kind VARCHAR(40) NOT NULL DEFAULT 'INTERNAL_CONFIGURATION'
          CHECK (source_kind IN (
            'INTERNAL_CONFIGURATION', 'OFFICIAL_PORTAL', 'AUTHORITY_DOCUMENT',
            'STATUTE_OR_RULE', 'UNVERIFIED_REFERENCE', 'OTHER'
          )),
        source_reference TEXT,
        source_url TEXT,
        source_review_status VARCHAR(24) NOT NULL DEFAULT 'PENDING'
          CHECK (source_review_status IN ('NOT_APPLICABLE', 'PENDING', 'REVIEWED', 'REJECTED')),
        source_review_notes TEXT,
        disclaimer TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT rera_rulesets_scope_owner_chk CHECK (
          (scope = 'PLATFORM' AND organization_id IS NULL)
          OR (scope = 'TENANT' AND organization_id IS NOT NULL)
        ),
        CONSTRAINT rera_rulesets_state_code_chk CHECK (
          jurisdiction_state_code IS NULL OR BTRIM(jurisdiction_state_code) <> ''
        )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_rulesets_platform_code
        ON rera_rulesets (UPPER(code))
        WHERE organization_id IS NULL AND deleted_at IS NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_rulesets_tenant_code
        ON rera_rulesets (organization_id, UPPER(code))
        WHERE organization_id IS NOT NULL AND deleted_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rera_rulesets_scope_jurisdiction
        ON rera_rulesets (scope, jurisdiction_country_code, jurisdiction_state_code, is_active)
        WHERE deleted_at IS NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_ruleset_versions (
        id BIGSERIAL PRIMARY KEY,
        ruleset_id BIGINT NOT NULL REFERENCES rera_rulesets(id) ON DELETE RESTRICT,
        version INTEGER NOT NULL CHECK (version > 0),
        version_label VARCHAR(100),
        lifecycle_status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
          CHECK (lifecycle_status IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'WITHDRAWN')),
        content_classification VARCHAR(32) NOT NULL DEFAULT 'CONFIGURATION_ONLY'
          CHECK (content_classification IN ('CONFIGURATION_ONLY', 'LEGAL_REQUIREMENTS')),
        contains_legal_requirements BOOLEAN NOT NULL DEFAULT FALSE,
        effective_from DATE,
        effective_to DATE,
        source_kind VARCHAR(40) NOT NULL DEFAULT 'INTERNAL_CONFIGURATION'
          CHECK (source_kind IN (
            'INTERNAL_CONFIGURATION', 'OFFICIAL_PORTAL', 'AUTHORITY_DOCUMENT',
            'STATUTE_OR_RULE', 'UNVERIFIED_REFERENCE', 'OTHER'
          )),
        source_title TEXT,
        source_reference TEXT,
        source_url TEXT,
        source_published_on DATE,
        source_retrieved_at TIMESTAMPTZ,
        source_review_status VARCHAR(24) NOT NULL DEFAULT 'PENDING'
          CHECK (source_review_status IN ('NOT_APPLICABLE', 'PENDING', 'REVIEWED', 'REJECTED')),
        source_review_notes TEXT,
        legal_disclaimer TEXT NOT NULL,
        module_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        terminology_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        field_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        capability_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMPTZ,
        published_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        published_at TIMESTAMPTZ,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT uq_rera_ruleset_version UNIQUE (ruleset_id, version),
        CONSTRAINT rera_ruleset_version_dates_chk CHECK (
          effective_to IS NULL OR (effective_from IS NOT NULL AND effective_to >= effective_from)
        ),
        CONSTRAINT rera_ruleset_version_json_chk CHECK (
          jsonb_typeof(module_policy) = 'object'
          AND jsonb_typeof(terminology_policy) = 'object'
          AND jsonb_typeof(field_policy) = 'object'
          AND jsonb_typeof(capability_policy) = 'object'
        ),
        CONSTRAINT rera_ruleset_legal_content_chk CHECK (
          (contains_legal_requirements = FALSE AND content_classification = 'CONFIGURATION_ONLY')
          OR (
            contains_legal_requirements = TRUE
            AND content_classification = 'LEGAL_REQUIREMENTS'
            AND source_review_status = 'REVIEWED'
            AND NULLIF(BTRIM(source_reference), '') IS NOT NULL
          )
        ),
        CONSTRAINT rera_ruleset_published_at_chk CHECK (
          lifecycle_status <> 'PUBLISHED' OR published_at IS NOT NULL
        ),
        CONSTRAINT rera_ruleset_reviewed_at_chk CHECK (
          source_review_status <> 'REVIEWED' OR reviewed_at IS NOT NULL
        )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_ruleset_one_published
        ON rera_ruleset_versions (ruleset_id)
        WHERE lifecycle_status = 'PUBLISHED' AND deleted_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rera_ruleset_versions_status
        ON rera_ruleset_versions (ruleset_id, lifecycle_status, version DESC)
        WHERE deleted_at IS NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_ruleset_requirements (
        id BIGSERIAL PRIMARY KEY,
        ruleset_version_id BIGINT NOT NULL REFERENCES rera_ruleset_versions(id) ON DELETE RESTRICT,
        requirement_code VARCHAR(100) NOT NULL CHECK (BTRIM(requirement_code) <> ''),
        requirement_kind VARCHAR(32) NOT NULL
          CHECK (requirement_kind IN (
            'CONFIGURATION', 'DOCUMENT', 'APPROVAL', 'DISCLOSURE',
            'MILESTONE', 'FILING', 'OTHER'
          )),
        module_key VARCHAR(100),
        title VARCHAR(300) NOT NULL CHECK (BTRIM(title) <> ''),
        description TEXT,
        is_mandatory BOOLEAN NOT NULL DEFAULT FALSE,
        is_legal_requirement BOOLEAN NOT NULL DEFAULT FALSE,
        applicability_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        field_requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
        deadline_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        evidence_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        source_reference TEXT,
        source_url TEXT,
        source_review_status VARCHAR(24) NOT NULL DEFAULT 'PENDING'
          CHECK (source_review_status IN ('NOT_APPLICABLE', 'PENDING', 'REVIEWED', 'REJECTED')),
        sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_rera_ruleset_requirement UNIQUE (ruleset_version_id, requirement_code),
        CONSTRAINT rera_requirement_json_chk CHECK (
          jsonb_typeof(applicability_policy) = 'object'
          AND jsonb_typeof(field_requirements) = 'object'
          AND jsonb_typeof(deadline_policy) = 'object'
          AND jsonb_typeof(evidence_policy) = 'object'
        ),
        CONSTRAINT rera_requirement_legal_source_chk CHECK (
          is_legal_requirement = FALSE
          OR (
            source_review_status = 'REVIEWED'
            AND NULLIF(BTRIM(source_reference), '') IS NOT NULL
          )
        )
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rera_requirements_version_module
        ON rera_ruleset_requirements (ruleset_version_id, module_key, sequence)
        WHERE is_active = TRUE
    `);

    // ---------------------------------------------------------------------
    // Immutable-version-capable, reviewed site operating profiles.
    // No INSERT into this table is performed for existing sites.
    // ---------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS site_operating_profile_revisions (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        site_id INTEGER NOT NULL,
        revision_number INTEGER NOT NULL CHECK (revision_number > 0),
        previous_revision_id BIGINT,
        ruleset_version_id BIGINT REFERENCES rera_ruleset_versions(id) ON DELETE RESTRICT,
        regulatory_authority_id INTEGER,
        lifecycle_status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
          CHECK (lifecycle_status IN (
            'DRAFT', 'VALIDATION', 'REVIEW', 'PUBLISHED', 'REJECTED', 'SUPERSEDED'
          )),
        review_decision VARCHAR(20) NOT NULL DEFAULT 'PENDING'
          CHECK (review_decision IN ('PENDING', 'APPROVED', 'REJECTED')),
        operating_model VARCHAR(48) NOT NULL
          CHECK (operating_model IN (
            'GENERIC_LAND_DEVELOPER',
            'DEVELOPMENT_AUTHORISED_BUILDER',
            'RERA_PROJECT_PROMOTER',
            'RERA_ONGOING_PROJECT_REGULARISATION'
          )),
        project_shape VARCHAR(32) NOT NULL
          CHECK (project_shape IN (
            'PLOTTED_DEVELOPMENT', 'APARTMENT', 'COMMERCIAL', 'MIXED_USE'
          )),
        development_basis VARCHAR(40) NOT NULL
          CHECK (development_basis IN (
            'LANDOWNER', 'DEVELOPMENT_AGREEMENT', 'JOINT_DEVELOPMENT_AGREEMENT',
            'COLLABORATION_AGREEMENT', 'CO_PROMOTER', 'POWER_OF_ATTORNEY', 'OTHER'
          )),
        regulatory_status VARCHAR(40) NOT NULL DEFAULT 'DRAFT'
          CHECK (regulatory_status IN (
            'DRAFT', 'APPLICABILITY_UNDER_REVIEW', 'EXEMPTION_UNDER_REVIEW',
            'APPLICATION_IN_PREPARATION', 'FILED', 'REGISTERED',
            'AMENDMENT_PENDING', 'EXTENSION_PENDING', 'EXPIRED', 'LAPSED',
            'REVOKED', 'COMPLETED'
          )),
        jurisdiction_country VARCHAR(100) NOT NULL DEFAULT 'INDIA',
        jurisdiction_state VARCHAR(100),
        authority_code VARCHAR(100),
        authority_name VARCHAR(300),
        district VARCHAR(100),
        development_basis_notes TEXT,
        project_structure VARCHAR(32) NOT NULL DEFAULT 'SINGLE_PROJECT'
          CHECK (project_structure IN ('SINGLE_PROJECT', 'PHASE_WISE', 'MULTIPLE_RERA_PROJECTS')),
        fund_control_modes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        applicability_notes TEXT,
        module_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
        terminology_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
        field_policy_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
        capability_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
        validation_results JSONB NOT NULL DEFAULT '{}'::jsonb,
        effective_from TIMESTAMPTZ,
        effective_to TIMESTAMPTZ,
        change_reason TEXT,
        review_notes TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        published_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ,
        CONSTRAINT uq_site_profile_revision UNIQUE (organization_id, site_id, revision_number),
        CONSTRAINT uq_site_profile_org_site_id UNIQUE (organization_id, site_id, id),
        CONSTRAINT fk_site_profile_site FOREIGN KEY (organization_id, site_id)
          REFERENCES sites (organization_id, id) ON DELETE RESTRICT,
        CONSTRAINT fk_site_profile_authority FOREIGN KEY (organization_id, regulatory_authority_id)
          REFERENCES compliance_authorities (organization_id, id) ON DELETE RESTRICT,
        CONSTRAINT fk_site_profile_previous FOREIGN KEY (
          organization_id, site_id, previous_revision_id
        ) REFERENCES site_operating_profile_revisions (organization_id, site_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT site_profile_dates_chk CHECK (
          effective_to IS NULL OR (effective_from IS NOT NULL AND effective_to >= effective_from)
        ),
        CONSTRAINT site_profile_json_chk CHECK (
          jsonb_typeof(module_overrides) = 'object'
          AND jsonb_typeof(terminology_overrides) = 'object'
          AND jsonb_typeof(field_policy_overrides) = 'object'
          AND jsonb_typeof(capability_overrides) = 'object'
          AND jsonb_typeof(validation_results) = 'object'
        ),
        CONSTRAINT site_profile_published_chk CHECK (
          lifecycle_status <> 'PUBLISHED'
          OR (
            review_decision = 'APPROVED'
            AND reviewed_by IS NOT NULL
            AND reviewed_at IS NOT NULL
            AND published_by IS NOT NULL
            AND published_at IS NOT NULL
            AND effective_from IS NOT NULL
            AND ruleset_version_id IS NOT NULL
          )
        ),
        CONSTRAINT site_profile_review_decision_chk CHECK (
          review_decision = 'PENDING'
          OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
        ),
        CONSTRAINT site_profile_rejected_chk CHECK (
          lifecycle_status <> 'REJECTED'
          OR (
            review_decision = 'REJECTED'
            AND NULLIF(BTRIM(review_notes), '') IS NOT NULL
          )
        ),
        CONSTRAINT site_profile_superseded_chk CHECK (
          lifecycle_status <> 'SUPERSEDED' OR effective_to IS NOT NULL
        )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_site_profile_one_open
        ON site_operating_profile_revisions (organization_id, site_id)
        WHERE lifecycle_status IN ('DRAFT', 'VALIDATION', 'REVIEW', 'REJECTED')
          AND deleted_at IS NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_site_profile_one_published
        ON site_operating_profile_revisions (organization_id, site_id)
        WHERE lifecycle_status = 'PUBLISHED' AND deleted_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_site_profiles_tenant_status
        ON site_operating_profile_revisions (organization_id, site_id, lifecycle_status, revision_number DESC)
        WHERE deleted_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_site_profiles_ruleset_version
        ON site_operating_profile_revisions (ruleset_version_id)
        WHERE deleted_at IS NULL
    `);

    // ---------------------------------------------------------------------
    // Canonical RERA stakeholders and project/phase domain.
    // ---------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_stakeholders (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        stakeholder_code VARCHAR(80),
        stakeholder_type VARCHAR(36) NOT NULL
          CHECK (stakeholder_type IN (
            'PROMOTER', 'CO_PROMOTER', 'LANDOWNER', 'DEVELOPER', 'COLLABORATOR',
            'AUTHORIZED_SIGNATORY', 'CONSULTANT', 'CONTRACTOR', 'OTHER'
          )),
        entity_type VARCHAR(24) NOT NULL
          CHECK (entity_type IN (
            'INDIVIDUAL', 'PROPRIETORSHIP', 'PARTNERSHIP', 'LLP', 'COMPANY',
            'TRUST', 'SOCIETY', 'GOVERNMENT_BODY', 'OTHER'
          )),
        legal_name VARCHAR(300) NOT NULL CHECK (BTRIM(legal_name) <> ''),
        trade_name VARCHAR(300),
        pan VARCHAR(20),
        gstin VARCHAR(20),
        cin_or_llpin VARCHAR(40),
        registration_number VARCHAR(100),
        email VARCHAR(255),
        phone VARCHAR(30),
        address JSONB NOT NULL DEFAULT '{}'::jsonb,
        authorized_signatory_name VARCHAR(255),
        record_review_status VARCHAR(24) NOT NULL DEFAULT 'RECORD_ONLY'
          CHECK (record_review_status IN ('RECORD_ONLY', 'PENDING', 'REVIEWED', 'REJECTED')),
        review_notes TEXT,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMPTZ,
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
          CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED')),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT uq_rera_stakeholder_org_id UNIQUE (organization_id, id),
        CONSTRAINT rera_stakeholder_json_chk CHECK (
          jsonb_typeof(address) = 'object' AND jsonb_typeof(metadata) = 'object'
        ),
        CONSTRAINT rera_stakeholder_review_chk CHECK (
          record_review_status NOT IN ('REVIEWED', 'REJECTED')
          OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
        ),
        CONSTRAINT rera_stakeholder_rejected_chk CHECK (
          record_review_status <> 'REJECTED'
          OR NULLIF(BTRIM(review_notes), '') IS NOT NULL
        )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_stakeholder_org_code
        ON rera_stakeholders (organization_id, UPPER(stakeholder_code))
        WHERE stakeholder_code IS NOT NULL AND deleted_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rera_stakeholders_org_type
        ON rera_stakeholders (organization_id, stakeholder_type, status)
        WHERE deleted_at IS NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_projects (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        site_id INTEGER NOT NULL,
        operating_profile_revision_id BIGINT NOT NULL,
        ruleset_version_id BIGINT NOT NULL REFERENCES rera_ruleset_versions(id) ON DELETE RESTRICT,
        authority_id INTEGER,
        authority_code VARCHAR(100),
        authority_name VARCHAR(300),
        project_code VARCHAR(80) NOT NULL CHECK (BTRIM(project_code) <> ''),
        name VARCHAR(300) NOT NULL CHECK (BTRIM(name) <> ''),
        project_shape VARCHAR(32) NOT NULL
          CHECK (project_shape IN (
            'PLOTTED_DEVELOPMENT', 'APARTMENT', 'COMMERCIAL', 'MIXED_USE'
          )),
        development_basis VARCHAR(40) NOT NULL
          CHECK (development_basis IN (
            'LANDOWNER', 'DEVELOPMENT_AGREEMENT', 'JOINT_DEVELOPMENT_AGREEMENT',
            'COLLABORATION_AGREEMENT', 'CO_PROMOTER', 'POWER_OF_ATTORNEY', 'OTHER'
          )),
        regulatory_status VARCHAR(40) NOT NULL DEFAULT 'DRAFT'
          CHECK (regulatory_status IN (
            'DRAFT', 'APPLICABILITY_UNDER_REVIEW', 'EXEMPTION_UNDER_REVIEW',
            'APPLICATION_IN_PREPARATION', 'FILED', 'REGISTERED',
            'AMENDMENT_PENDING', 'EXTENSION_PENDING', 'EXPIRED', 'LAPSED',
            'REVOKED', 'COMPLETED'
          )),
        status_reason TEXT,
        registration_number VARCHAR(150),
        registration_date DATE,
        registration_expiry_date DATE,
        proposed_start_date DATE,
        proposed_completion_date DATE,
        actual_completion_date DATE,
        address TEXT,
        district VARCHAR(100),
        state VARCHAR(100),
        pincode VARCHAR(12),
        latitude NUMERIC(9,6),
        longitude NUMERIC(9,6),
        total_land_area NUMERIC(18,4) CHECK (total_land_area IS NULL OR total_land_area > 0),
        project_area NUMERIC(18,4) CHECK (project_area IS NULL OR project_area > 0),
        area_unit VARCHAR(20)
          CHECK (area_unit IS NULL OR area_unit IN (
            'SQ_M', 'SQ_FT', 'SQ_YD', 'ACRE', 'HECTARE', 'BIGHA'
          )),
        source_review_status VARCHAR(24) NOT NULL DEFAULT 'RECORD_ONLY'
          CHECK (source_review_status IN ('RECORD_ONLY', 'PENDING', 'REVIEWED', 'REJECTED')),
        source_reference TEXT,
        source_url TEXT,
        source_reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        source_reviewed_at TIMESTAMPTZ,
        source_review_notes TEXT,
        notes TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT uq_rera_project_org_site_id UNIQUE (organization_id, site_id, id),
        CONSTRAINT uq_rera_project_org_id UNIQUE (organization_id, id),
        CONSTRAINT fk_rera_project_site FOREIGN KEY (organization_id, site_id)
          REFERENCES sites (organization_id, id) ON DELETE RESTRICT,
        CONSTRAINT fk_rera_project_profile FOREIGN KEY (
          organization_id, site_id, operating_profile_revision_id
        ) REFERENCES site_operating_profile_revisions (organization_id, site_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_rera_project_authority FOREIGN KEY (organization_id, authority_id)
          REFERENCES compliance_authorities (organization_id, id) ON DELETE RESTRICT,
        CONSTRAINT rera_project_dates_chk CHECK (
          (registration_expiry_date IS NULL OR (
            registration_date IS NOT NULL AND registration_expiry_date >= registration_date
          ))
          AND (proposed_completion_date IS NULL OR (
            proposed_start_date IS NOT NULL AND proposed_completion_date >= proposed_start_date
          ))
          AND (actual_completion_date IS NULL OR proposed_start_date IS NULL
            OR actual_completion_date >= proposed_start_date)
        ),
        CONSTRAINT rera_project_area_chk CHECK (
          project_area IS NULL OR total_land_area IS NULL OR project_area <= total_land_area
        ),
        CONSTRAINT rera_project_registered_claim_chk CHECK (
          regulatory_status <> 'REGISTERED'
          OR (
            (authority_id IS NOT NULL
              OR NULLIF(BTRIM(authority_code), '') IS NOT NULL
              OR NULLIF(BTRIM(authority_name), '') IS NOT NULL)
            AND NULLIF(BTRIM(registration_number), '') IS NOT NULL
            AND registration_date IS NOT NULL
            AND NULLIF(BTRIM(source_url), '') IS NOT NULL
          )
        ),
        CONSTRAINT rera_project_review_status_reason_chk CHECK (
          regulatory_status NOT IN ('EXEMPTION_UNDER_REVIEW', 'REVOKED')
          OR NULLIF(BTRIM(status_reason), '') IS NOT NULL
        ),
        CONSTRAINT rera_project_source_review_audit_chk CHECK (
          source_review_status NOT IN ('REVIEWED', 'REJECTED')
          OR (source_reviewed_by IS NOT NULL AND source_reviewed_at IS NOT NULL)
        ),
        CONSTRAINT rera_project_source_rejected_notes_chk CHECK (
          source_review_status <> 'REJECTED'
          OR NULLIF(BTRIM(source_review_notes), '') IS NOT NULL
        ),
        CONSTRAINT rera_project_expired_date_chk CHECK (
          regulatory_status <> 'EXPIRED' OR registration_expiry_date IS NOT NULL
        ),
        CONSTRAINT rera_project_completed_date_chk CHECK (
          regulatory_status <> 'COMPLETED' OR actual_completion_date IS NOT NULL
        ),
        CONSTRAINT rera_project_json_chk CHECK (jsonb_typeof(metadata) = 'object')
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_project_site_code
        ON rera_projects (organization_id, site_id, UPPER(project_code))
        WHERE deleted_at IS NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_project_registration
        ON rera_projects (organization_id, authority_id, UPPER(registration_number))
        WHERE registration_number IS NOT NULL AND deleted_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rera_projects_tenant_site_status
        ON rera_projects (organization_id, site_id, regulatory_status, updated_at DESC)
        WHERE deleted_at IS NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_project_phases (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        site_id INTEGER NOT NULL,
        rera_project_id BIGINT NOT NULL,
        authority_id INTEGER,
        authority_code VARCHAR(100),
        authority_name VARCHAR(300),
        phase_code VARCHAR(80) NOT NULL CHECK (BTRIM(phase_code) <> ''),
        name VARCHAR(300) NOT NULL CHECK (BTRIM(name) <> ''),
        regulatory_status VARCHAR(40) NOT NULL DEFAULT 'DRAFT'
          CHECK (regulatory_status IN (
            'DRAFT', 'APPLICABILITY_UNDER_REVIEW', 'EXEMPTION_UNDER_REVIEW',
            'APPLICATION_IN_PREPARATION', 'FILED', 'REGISTERED',
            'AMENDMENT_PENDING', 'EXTENSION_PENDING', 'EXPIRED', 'LAPSED',
            'REVOKED', 'COMPLETED'
          )),
        status_reason TEXT,
        registration_number VARCHAR(150),
        registration_date DATE,
        registration_expiry_date DATE,
        proposed_start_date DATE,
        proposed_completion_date DATE,
        actual_completion_date DATE,
        phase_area NUMERIC(18,4) CHECK (phase_area IS NULL OR phase_area > 0),
        area_unit VARCHAR(20)
          CHECK (area_unit IS NULL OR area_unit IN (
            'SQ_M', 'SQ_FT', 'SQ_YD', 'ACRE', 'HECTARE', 'BIGHA'
          )),
        notes TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT uq_rera_phase_org_site_project_id UNIQUE (
          organization_id, site_id, rera_project_id, id
        ),
        CONSTRAINT uq_rera_phase_org_site_id UNIQUE (organization_id, site_id, id),
        CONSTRAINT uq_rera_phase_org_id UNIQUE (organization_id, id),
        CONSTRAINT fk_rera_phase_project FOREIGN KEY (
          organization_id, site_id, rera_project_id
        ) REFERENCES rera_projects (organization_id, site_id, id) ON DELETE RESTRICT,
        CONSTRAINT fk_rera_phase_authority FOREIGN KEY (organization_id, authority_id)
          REFERENCES compliance_authorities (organization_id, id) ON DELETE RESTRICT,
        CONSTRAINT rera_phase_dates_chk CHECK (
          (registration_expiry_date IS NULL OR (
            registration_date IS NOT NULL AND registration_expiry_date >= registration_date
          ))
          AND (proposed_completion_date IS NULL OR (
            proposed_start_date IS NOT NULL AND proposed_completion_date >= proposed_start_date
          ))
          AND (actual_completion_date IS NULL OR proposed_start_date IS NULL
            OR actual_completion_date >= proposed_start_date)
        ),
        CONSTRAINT rera_phase_registered_claim_chk CHECK (
          regulatory_status <> 'REGISTERED'
          OR (
            (authority_id IS NOT NULL
              OR NULLIF(BTRIM(authority_code), '') IS NOT NULL
              OR NULLIF(BTRIM(authority_name), '') IS NOT NULL)
            AND NULLIF(BTRIM(registration_number), '') IS NOT NULL
            AND registration_date IS NOT NULL
          )
        ),
        CONSTRAINT rera_phase_review_status_reason_chk CHECK (
          regulatory_status NOT IN ('EXEMPTION_UNDER_REVIEW', 'REVOKED')
          OR NULLIF(BTRIM(status_reason), '') IS NOT NULL
        ),
        CONSTRAINT rera_phase_expired_date_chk CHECK (
          regulatory_status <> 'EXPIRED' OR registration_expiry_date IS NOT NULL
        ),
        CONSTRAINT rera_phase_completed_date_chk CHECK (
          regulatory_status <> 'COMPLETED' OR actual_completion_date IS NOT NULL
        ),
        CONSTRAINT rera_phase_json_chk CHECK (jsonb_typeof(metadata) = 'object')
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_phase_project_code
        ON rera_project_phases (organization_id, rera_project_id, UPPER(phase_code))
        WHERE deleted_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rera_phases_tenant_site_status
        ON rera_project_phases (organization_id, site_id, regulatory_status, updated_at DESC)
        WHERE deleted_at IS NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_project_participants (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        site_id INTEGER NOT NULL,
        rera_project_id BIGINT NOT NULL,
        rera_project_phase_id BIGINT,
        stakeholder_id BIGINT NOT NULL,
        participant_role VARCHAR(36) NOT NULL
          CHECK (participant_role IN (
            'PROMOTER', 'CO_PROMOTER', 'LANDOWNER', 'DEVELOPER', 'COLLABORATOR',
            'AUTHORIZED_SIGNATORY', 'CONSULTANT', 'CONTRACTOR', 'OTHER'
          )),
        is_primary BOOLEAN NOT NULL DEFAULT FALSE,
        ownership_percentage NUMERIC(7,4)
          CHECK (ownership_percentage IS NULL OR ownership_percentage BETWEEN 0 AND 100),
        effective_from DATE,
        effective_to DATE,
        basis_reference TEXT,
        notes TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT fk_rera_participant_project FOREIGN KEY (
          organization_id, site_id, rera_project_id
        ) REFERENCES rera_projects (organization_id, site_id, id) ON DELETE RESTRICT,
        CONSTRAINT fk_rera_participant_phase FOREIGN KEY (
          organization_id, site_id, rera_project_id, rera_project_phase_id
        ) REFERENCES rera_project_phases (organization_id, site_id, rera_project_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_rera_participant_stakeholder FOREIGN KEY (
          organization_id, stakeholder_id
        ) REFERENCES rera_stakeholders (organization_id, id) ON DELETE RESTRICT,
        CONSTRAINT rera_participant_dates_chk CHECK (
          effective_to IS NULL OR (effective_from IS NOT NULL AND effective_to >= effective_from)
        )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_participant_active_role
        ON rera_project_participants (
          organization_id, rera_project_id, COALESCE(rera_project_phase_id, 0),
          stakeholder_id, participant_role
        )
        WHERE effective_to IS NULL AND deleted_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rera_participants_project
        ON rera_project_participants (organization_id, site_id, rera_project_id, participant_role)
        WHERE deleted_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rera_participants_stakeholder
        ON rera_project_participants (organization_id, stakeholder_id)
        WHERE deleted_at IS NULL
    `);

    // Lightweight land identity. Existing farmer/payment records remain
    // untouched; parcels can be linked explicitly after review.
    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_land_parcels (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        site_id INTEGER NOT NULL,
        parcel_code VARCHAR(100) NOT NULL CHECK (BTRIM(parcel_code) <> ''),
        survey_number VARCHAR(150),
        khasra_number VARCHAR(150),
        khewat_number VARCHAR(150),
        village VARCHAR(150),
        tehsil VARCHAR(150),
        district VARCHAR(150),
        state VARCHAR(100),
        area NUMERIC(18,4) NOT NULL CHECK (area > 0),
        area_unit VARCHAR(20) NOT NULL
          CHECK (area_unit IN ('SQ_M', 'SQ_FT', 'SQ_YD', 'ACRE', 'HECTARE', 'BIGHA')),
        title_record_status VARCHAR(32) NOT NULL DEFAULT 'RECORD_ONLY'
          CHECK (title_record_status IN (
            'RECORD_ONLY', 'UNDER_REVIEW', 'REVIEWED', 'ENCUMBERED', 'DISPUTED', 'UNKNOWN'
          )),
        title_reference TEXT,
        notes TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT uq_rera_parcel_org_site_id UNIQUE (organization_id, site_id, id),
        CONSTRAINT fk_rera_parcel_site FOREIGN KEY (organization_id, site_id)
          REFERENCES sites (organization_id, id) ON DELETE RESTRICT,
        CONSTRAINT rera_parcel_json_chk CHECK (jsonb_typeof(metadata) = 'object')
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_parcel_site_code
        ON rera_land_parcels (organization_id, site_id, UPPER(parcel_code))
        WHERE deleted_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rera_parcels_tenant_site
        ON rera_land_parcels (organization_id, site_id, title_record_status)
        WHERE deleted_at IS NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_project_land_parcels (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        site_id INTEGER NOT NULL,
        rera_project_id BIGINT NOT NULL,
        rera_project_phase_id BIGINT,
        rera_land_parcel_id BIGINT NOT NULL,
        linked_area NUMERIC(18,4) CHECK (linked_area IS NULL OR linked_area > 0),
        area_unit VARCHAR(20)
          CHECK (area_unit IS NULL OR area_unit IN (
            'SQ_M', 'SQ_FT', 'SQ_YD', 'ACRE', 'HECTARE', 'BIGHA'
          )),
        effective_from DATE,
        effective_to DATE,
        basis_reference TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT fk_rera_project_parcel_project FOREIGN KEY (
          organization_id, site_id, rera_project_id
        ) REFERENCES rera_projects (organization_id, site_id, id) ON DELETE RESTRICT,
        CONSTRAINT fk_rera_project_parcel_phase FOREIGN KEY (
          organization_id, site_id, rera_project_id, rera_project_phase_id
        ) REFERENCES rera_project_phases (organization_id, site_id, rera_project_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_rera_project_parcel_parcel FOREIGN KEY (
          organization_id, site_id, rera_land_parcel_id
        ) REFERENCES rera_land_parcels (organization_id, site_id, id) ON DELETE RESTRICT,
        CONSTRAINT rera_project_parcel_dates_chk CHECK (
          effective_to IS NULL OR (effective_from IS NOT NULL AND effective_to >= effective_from)
        )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_project_parcel_active
        ON rera_project_land_parcels (
          organization_id, rera_project_id, COALESCE(rera_project_phase_id, 0), rera_land_parcel_id
        )
        WHERE effective_to IS NULL AND deleted_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rera_project_parcels_project
        ON rera_project_land_parcels (organization_id, site_id, rera_project_id)
        WHERE deleted_at IS NULL
    `);

    // Platform rulesets are shared; tenant-authored rulesets are private to
    // their organization. A normal composite FK cannot express that
    // "NULL owner means platform, otherwise same tenant" rule, so enforce it
    // at the database boundary for every direct ruleset-version reference.
    await client.query(`
      CREATE OR REPLACE FUNCTION enforce_rera_ruleset_version_scope()
      RETURNS TRIGGER AS $$
      DECLARE
        owner_organization_id INTEGER;
      BEGIN
        IF NEW.ruleset_version_id IS NULL THEN
          RETURN NEW;
        END IF;

        SELECT r.organization_id
          INTO owner_organization_id
          FROM rera_ruleset_versions v
          JOIN rera_rulesets r ON r.id = v.ruleset_id
         WHERE v.id = NEW.ruleset_version_id
           AND v.deleted_at IS NULL
           AND r.deleted_at IS NULL;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'RERA ruleset version is unavailable'
            USING ERRCODE = '23503';
        END IF;
        IF owner_organization_id IS NOT NULL
           AND owner_organization_id <> NEW.organization_id THEN
          RAISE EXCEPTION 'RERA ruleset version belongs to another organization'
            USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
           WHERE tgname = 'trg_site_profile_ruleset_scope' AND NOT tgisinternal
        ) THEN
          EXECUTE 'CREATE TRIGGER trg_site_profile_ruleset_scope
            BEFORE INSERT OR UPDATE OF organization_id, ruleset_version_id
            ON site_operating_profile_revisions
            FOR EACH ROW EXECUTE FUNCTION enforce_rera_ruleset_version_scope()';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
           WHERE tgname = 'trg_rera_project_ruleset_scope' AND NOT tgisinternal
        ) THEN
          EXECUTE 'CREATE TRIGGER trg_rera_project_ruleset_scope
            BEFORE INSERT OR UPDATE OF organization_id, ruleset_version_id
            ON rera_projects
            FOR EACH ROW EXECUTE FUNCTION enforce_rera_ruleset_version_scope()';
        END IF;
      END $$
    `);

    // A project is a child of the exact published Site profile revision and
    // must use that revision's pinned ruleset. Independent valid foreign keys
    // are insufficient because they could otherwise reference two unrelated
    // same-tenant/platform configurations.
    await client.query(`
      CREATE OR REPLACE FUNCTION enforce_rera_project_profile_ruleset()
      RETURNS TRIGGER AS $$
      DECLARE
        profile_ruleset_version_id BIGINT;
        profile_lifecycle_status VARCHAR(20);
        profile_effective_to TIMESTAMPTZ;
        ruleset_lifecycle_status VARCHAR(20);
        ruleset_is_active BOOLEAN;
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
             AND NEW.site_id IS NOT DISTINCT FROM OLD.site_id
             AND NEW.operating_profile_revision_id IS NOT DISTINCT FROM OLD.operating_profile_revision_id
             AND NEW.ruleset_version_id IS NOT DISTINCT FROM OLD.ruleset_version_id THEN
            RETURN NEW;
          END IF;
        END IF;

        SELECT p.ruleset_version_id, p.lifecycle_status, p.effective_to
          INTO profile_ruleset_version_id, profile_lifecycle_status, profile_effective_to
          FROM site_operating_profile_revisions p
         WHERE p.id = NEW.operating_profile_revision_id
           AND p.organization_id = NEW.organization_id
           AND p.site_id = NEW.site_id
           AND p.deleted_at IS NULL;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'RERA project operating profile is unavailable'
            USING ERRCODE = '23503';
        END IF;
        IF profile_lifecycle_status <> 'PUBLISHED' OR profile_effective_to IS NOT NULL THEN
          RAISE EXCEPTION 'RERA projects require the active published Site profile'
            USING ERRCODE = '23514';
        END IF;
        IF profile_ruleset_version_id IS DISTINCT FROM NEW.ruleset_version_id THEN
          RAISE EXCEPTION 'RERA project ruleset must match its Site profile revision'
            USING ERRCODE = '23514';
        END IF;
        SELECT rv.lifecycle_status, r.is_active
          INTO ruleset_lifecycle_status, ruleset_is_active
          FROM rera_ruleset_versions rv
          JOIN rera_rulesets r ON r.id=rv.ruleset_id
         WHERE rv.id=NEW.ruleset_version_id
           AND rv.deleted_at IS NULL AND r.deleted_at IS NULL;
        IF NOT FOUND OR ruleset_is_active IS DISTINCT FROM TRUE
           OR ruleset_lifecycle_status NOT IN ('PUBLISHED','SUPERSEDED') THEN
          RAISE EXCEPTION 'RERA projects require an active published or pinned superseded ruleset version'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
           WHERE tgname = 'trg_rera_project_profile_ruleset' AND NOT tgisinternal
        ) THEN
          EXECUTE 'CREATE TRIGGER trg_rera_project_profile_ruleset
            BEFORE INSERT OR UPDATE OF organization_id, site_id,
              operating_profile_revision_id, ruleset_version_id
            ON rera_projects
            FOR EACH ROW EXECUTE FUNCTION enforce_rera_project_profile_ruleset()';
        END IF;
      END $$
    `);

    // ---------------------------------------------------------------------
    // Reuse the existing compliance engine, approval register and evidence
    // store by adding nullable RERA references. Existing rows remain valid.
    // ---------------------------------------------------------------------
    await client.query(`
      ALTER TABLE compliance_items
        ADD COLUMN IF NOT EXISTS rera_project_id BIGINT,
        ADD COLUMN IF NOT EXISTS rera_project_phase_id BIGINT,
        ADD COLUMN IF NOT EXISTS rera_ruleset_requirement_id BIGINT
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_compliance_item_rera_project'
        ) THEN
          ALTER TABLE compliance_items
            ADD CONSTRAINT fk_compliance_item_rera_project
            FOREIGN KEY (organization_id, site_id, rera_project_id)
            REFERENCES rera_projects (organization_id, site_id, id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_compliance_item_rera_phase'
        ) THEN
          ALTER TABLE compliance_items
            ADD CONSTRAINT fk_compliance_item_rera_phase
            FOREIGN KEY (organization_id, site_id, rera_project_id, rera_project_phase_id)
            REFERENCES rera_project_phases (organization_id, site_id, rera_project_id, id)
            ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_compliance_item_rera_requirement'
        ) THEN
          ALTER TABLE compliance_items
            ADD CONSTRAINT fk_compliance_item_rera_requirement
            FOREIGN KEY (rera_ruleset_requirement_id)
            REFERENCES rera_ruleset_requirements (id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_item_rera_scope_chk'
        ) THEN
          ALTER TABLE compliance_items
            ADD CONSTRAINT compliance_item_rera_scope_chk CHECK (
              (rera_project_id IS NULL OR site_id IS NOT NULL)
              AND (rera_project_phase_id IS NULL
                OR (site_id IS NOT NULL AND rera_project_id IS NOT NULL))
            );
        END IF;
      END $$
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_compliance_items_rera_project
        ON compliance_items (organization_id, site_id, rera_project_id, current_due_date)
        WHERE rera_project_id IS NOT NULL AND deleted_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_compliance_items_rera_requirement
        ON compliance_items (rera_ruleset_requirement_id)
        WHERE rera_ruleset_requirement_id IS NOT NULL AND deleted_at IS NULL
    `);

    await client.query(`
      ALTER TABLE compliance_licences
        ADD COLUMN IF NOT EXISTS rera_record_kind VARCHAR(40),
        ADD COLUMN IF NOT EXISTS rera_status VARCHAR(32),
        ADD COLUMN IF NOT EXISTS rera_authority_label VARCHAR(300),
        ADD COLUMN IF NOT EXISTS rera_owner_label VARCHAR(300),
        ADD COLUMN IF NOT EXISTS rera_project_id BIGINT,
        ADD COLUMN IF NOT EXISTS rera_project_phase_id BIGINT,
        ADD COLUMN IF NOT EXISTS rera_ruleset_requirement_id BIGINT,
        ADD COLUMN IF NOT EXISTS rera_source_type VARCHAR(32),
        ADD COLUMN IF NOT EXISTS rera_source_reference TEXT,
        ADD COLUMN IF NOT EXISTS rera_source_url TEXT,
        ADD COLUMN IF NOT EXISTS rera_source_checked_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS rera_evidence_review_status VARCHAR(20),
        ADD COLUMN IF NOT EXISTS rera_reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS rera_reviewed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS rera_review_notes TEXT
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_licence_rera_kind_chk'
        ) THEN
          ALTER TABLE compliance_licences
            ADD CONSTRAINT compliance_licence_rera_kind_chk CHECK (
              rera_record_kind IS NULL OR rera_record_kind IN (
                'PROJECT_REGISTRATION', 'PHASE_REGISTRATION', 'APPROVAL', 'NOC',
                'PERMIT', 'CERTIFICATE', 'EXEMPTION', 'EXTENSION', 'OTHER'
              )
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_licence_rera_source_chk'
        ) THEN
          ALTER TABLE compliance_licences
            ADD CONSTRAINT compliance_licence_rera_source_chk CHECK (
              rera_source_type IS NULL OR rera_source_type IN (
                'USER_RECORDED', 'OFFICIAL_PORTAL', 'AUTHORITY_DOCUMENT', 'IMPORTED', 'OTHER'
              )
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_licence_rera_status_chk'
        ) THEN
          ALTER TABLE compliance_licences
            ADD CONSTRAINT compliance_licence_rera_status_chk CHECK (
              rera_status IS NULL OR rera_status IN (
                'MISSING', 'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED',
                'EXPIRED', 'RENEWAL_DUE', 'REJECTED', 'NOT_APPLICABLE'
              )
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_licence_rera_review_chk'
        ) THEN
          ALTER TABLE compliance_licences
            ADD CONSTRAINT compliance_licence_rera_review_chk CHECK (
              rera_evidence_review_status IS NULL
              OR rera_evidence_review_status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'NOT_REQUIRED')
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_licence_rera_reviewed_at_chk'
        ) THEN
          ALTER TABLE compliance_licences
            ADD CONSTRAINT compliance_licence_rera_reviewed_at_chk CHECK (
              rera_evidence_review_status NOT IN ('ACCEPTED', 'REJECTED')
              OR (rera_reviewed_by IS NOT NULL AND rera_reviewed_at IS NOT NULL)
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_compliance_licence_rera_project'
        ) THEN
          ALTER TABLE compliance_licences
            ADD CONSTRAINT fk_compliance_licence_rera_project
            FOREIGN KEY (organization_id, site_id, rera_project_id)
            REFERENCES rera_projects (organization_id, site_id, id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_compliance_licence_rera_phase'
        ) THEN
          ALTER TABLE compliance_licences
            ADD CONSTRAINT fk_compliance_licence_rera_phase
            FOREIGN KEY (organization_id, site_id, rera_project_id, rera_project_phase_id)
            REFERENCES rera_project_phases (organization_id, site_id, rera_project_id, id)
            ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_compliance_licence_rera_requirement'
        ) THEN
          ALTER TABLE compliance_licences
            ADD CONSTRAINT fk_compliance_licence_rera_requirement
            FOREIGN KEY (rera_ruleset_requirement_id)
            REFERENCES rera_ruleset_requirements (id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_licence_rera_scope_chk'
        ) THEN
          ALTER TABLE compliance_licences
            ADD CONSTRAINT compliance_licence_rera_scope_chk CHECK (
              (rera_project_id IS NULL OR site_id IS NOT NULL)
              AND (rera_project_phase_id IS NULL
                OR (site_id IS NOT NULL AND rera_project_id IS NOT NULL))
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_licence_rera_approved_chk'
        ) THEN
          ALTER TABLE compliance_licences
            ADD CONSTRAINT compliance_licence_rera_approved_chk CHECK (
              rera_status <> 'APPROVED'
              OR (
                (authority_id IS NOT NULL OR NULLIF(BTRIM(rera_authority_label), '') IS NOT NULL)
                AND NULLIF(BTRIM(licence_number), '') IS NOT NULL
                AND COALESCE(effective_date, issue_date) IS NOT NULL
              )
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_licence_rera_expiry_chk'
        ) THEN
          ALTER TABLE compliance_licences
            ADD CONSTRAINT compliance_licence_rera_expiry_chk CHECK (
              rera_status NOT IN ('EXPIRED', 'RENEWAL_DUE') OR expiry_date IS NOT NULL
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_licence_rera_dates_chk'
        ) THEN
          ALTER TABLE compliance_licences
            ADD CONSTRAINT compliance_licence_rera_dates_chk CHECK (
              rera_record_kind IS NULL
              OR expiry_date IS NULL
              OR (COALESCE(effective_date, issue_date) IS NOT NULL
                AND expiry_date >= COALESCE(effective_date, issue_date))
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_licence_rera_na_review_chk'
        ) THEN
          ALTER TABLE compliance_licences
            ADD CONSTRAINT compliance_licence_rera_na_review_chk CHECK (
              rera_status <> 'NOT_APPLICABLE'
              OR (
                rera_reviewed_by IS NOT NULL
                AND rera_reviewed_at IS NOT NULL
                AND NULLIF(BTRIM(rera_review_notes), '') IS NOT NULL
              )
            );
        END IF;
      END $$
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_compliance_licences_rera_project
        ON compliance_licences (organization_id, site_id, rera_project_id, rera_record_kind)
        WHERE rera_project_id IS NOT NULL AND deleted_at IS NULL
    `);

    // RERA domain identities are BIGSERIAL. Widen every reused polymorphic
    // compliance reference before those records can be linked, audited or
    // scheduled; INTEGER would fail once an identity exceeds 32-bit range.
    await client.query(`
      ALTER TABLE compliance_approvals ALTER COLUMN entity_id TYPE BIGINT USING entity_id::BIGINT;
      ALTER TABLE compliance_documents ALTER COLUMN entity_id TYPE BIGINT USING entity_id::BIGINT;
      ALTER TABLE compliance_notification_log ALTER COLUMN entity_id TYPE BIGINT USING entity_id::BIGINT;
      ALTER TABLE compliance_audit_log ALTER COLUMN entity_id TYPE BIGINT USING entity_id::BIGINT
    `);

    await client.query(`
      ALTER TABLE compliance_documents
        ADD COLUMN IF NOT EXISTS document_type VARCHAR(120),
        ADD COLUMN IF NOT EXISTS document_number VARCHAR(200),
        ADD COLUMN IF NOT EXISTS effective_date DATE,
        ADD COLUMN IF NOT EXISTS source_type VARCHAR(32),
        ADD COLUMN IF NOT EXISTS source_reference TEXT,
        ADD COLUMN IF NOT EXISTS source_url TEXT,
        ADD COLUMN IF NOT EXISTS source_retrieved_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS review_status VARCHAR(20),
        ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS review_notes TEXT,
        ADD COLUMN IF NOT EXISTS document_series_key VARCHAR(160),
        ADD COLUMN IF NOT EXISTS supersedes_document_id BIGINT,
        ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS superseded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS rera_project_id BIGINT,
        ADD COLUMN IF NOT EXISTS rera_project_phase_id BIGINT,
        ADD COLUMN IF NOT EXISTS rera_ruleset_requirement_id BIGINT
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_documents_series_version
        ON compliance_documents (
          organization_id, entity_type, entity_id, document_series_key, version_no
        )
        WHERE document_series_key IS NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_documents_org_id
        ON compliance_documents (organization_id, id)
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_document_source_type_chk'
        ) THEN
          ALTER TABLE compliance_documents
            ADD CONSTRAINT compliance_document_source_type_chk CHECK (
              source_type IS NULL OR source_type IN (
                'USER_UPLOADED', 'OFFICIAL_PORTAL', 'AUTHORITY_DOCUMENT', 'IMPORTED', 'OTHER'
              )
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_document_review_status_chk'
        ) THEN
          ALTER TABLE compliance_documents
            ADD CONSTRAINT compliance_document_review_status_chk CHECK (
              review_status IS NULL OR review_status IN (
                'NOT_REVIEWED', 'PENDING', 'ACCEPTED', 'REJECTED'
              )
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_document_reviewed_at_chk'
        ) THEN
          ALTER TABLE compliance_documents
            ADD CONSTRAINT compliance_document_reviewed_at_chk CHECK (
              review_status NOT IN ('ACCEPTED', 'REJECTED')
              OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_document_not_self_supersede_chk'
        ) THEN
          ALTER TABLE compliance_documents
            ADD CONSTRAINT compliance_document_not_self_supersede_chk CHECK (
              supersedes_document_id IS NULL OR supersedes_document_id <> id
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_document_effective_dates_chk'
        ) THEN
          ALTER TABLE compliance_documents
            ADD CONSTRAINT compliance_document_effective_dates_chk CHECK (
              effective_date IS NULL
              OR (
                (issue_date IS NULL OR effective_date >= issue_date)
                AND (expiry_date IS NULL OR expiry_date >= effective_date)
              )
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_compliance_document_supersedes'
        ) THEN
          ALTER TABLE compliance_documents
            ADD CONSTRAINT fk_compliance_document_supersedes
            FOREIGN KEY (organization_id, supersedes_document_id)
            REFERENCES compliance_documents (organization_id, id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_compliance_document_rera_project'
        ) THEN
          ALTER TABLE compliance_documents
            ADD CONSTRAINT fk_compliance_document_rera_project
            FOREIGN KEY (organization_id, site_id, rera_project_id)
            REFERENCES rera_projects (organization_id, site_id, id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_compliance_document_rera_phase'
        ) THEN
          ALTER TABLE compliance_documents
            ADD CONSTRAINT fk_compliance_document_rera_phase
            FOREIGN KEY (organization_id, site_id, rera_project_id, rera_project_phase_id)
            REFERENCES rera_project_phases (organization_id, site_id, rera_project_id, id)
            ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_compliance_document_rera_requirement'
        ) THEN
          ALTER TABLE compliance_documents
            ADD CONSTRAINT fk_compliance_document_rera_requirement
            FOREIGN KEY (rera_ruleset_requirement_id)
            REFERENCES rera_ruleset_requirements (id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_document_rera_scope_chk'
        ) THEN
          ALTER TABLE compliance_documents
            ADD CONSTRAINT compliance_document_rera_scope_chk CHECK (
              (rera_project_id IS NULL OR site_id IS NOT NULL)
              AND (rera_project_phase_id IS NULL
                OR (site_id IS NOT NULL AND rera_project_id IS NOT NULL))
            );
        END IF;
      END $$
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_document_superseded_once
        ON compliance_documents (organization_id, supersedes_document_id)
        WHERE supersedes_document_id IS NOT NULL AND deleted_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_compliance_documents_rera_project
        ON compliance_documents (
          organization_id, site_id, rera_project_id, rera_project_phase_id, created_at DESC
        )
        WHERE rera_project_id IS NOT NULL AND deleted_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_compliance_documents_number
        ON compliance_documents (organization_id, UPPER(document_number))
        WHERE document_number IS NOT NULL AND deleted_at IS NULL
    `);

    // Apply the same global-or-same-tenant rule when existing compliance
    // records reference a versioned ruleset requirement.
    await client.query(`
      CREATE OR REPLACE FUNCTION enforce_rera_requirement_scope()
      RETURNS TRIGGER AS $$
      DECLARE
        owner_organization_id INTEGER;
      BEGIN
        IF NEW.rera_ruleset_requirement_id IS NULL THEN
          RETURN NEW;
        END IF;

        SELECT r.organization_id
          INTO owner_organization_id
          FROM rera_ruleset_requirements requirement
          JOIN rera_ruleset_versions v ON v.id = requirement.ruleset_version_id
          JOIN rera_rulesets r ON r.id = v.ruleset_id
         WHERE requirement.id = NEW.rera_ruleset_requirement_id
           AND v.deleted_at IS NULL
           AND r.deleted_at IS NULL;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'RERA ruleset requirement is unavailable'
            USING ERRCODE = '23503';
        END IF;
        IF owner_organization_id IS NOT NULL
           AND owner_organization_id <> NEW.organization_id THEN
          RAISE EXCEPTION 'RERA ruleset requirement belongs to another organization'
            USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
           WHERE tgname = 'trg_compliance_item_rera_requirement_scope' AND NOT tgisinternal
        ) THEN
          EXECUTE 'CREATE TRIGGER trg_compliance_item_rera_requirement_scope
            BEFORE INSERT OR UPDATE OF organization_id, rera_ruleset_requirement_id
            ON compliance_items
            FOR EACH ROW EXECUTE FUNCTION enforce_rera_requirement_scope()';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
           WHERE tgname = 'trg_compliance_licence_rera_requirement_scope' AND NOT tgisinternal
        ) THEN
          EXECUTE 'CREATE TRIGGER trg_compliance_licence_rera_requirement_scope
            BEFORE INSERT OR UPDATE OF organization_id, rera_ruleset_requirement_id
            ON compliance_licences
            FOR EACH ROW EXECUTE FUNCTION enforce_rera_requirement_scope()';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
           WHERE tgname = 'trg_compliance_document_rera_requirement_scope' AND NOT tgisinternal
        ) THEN
          EXECUTE 'CREATE TRIGGER trg_compliance_document_rera_requirement_scope
            BEFORE INSERT OR UPDATE OF organization_id, rera_ruleset_requirement_id
            ON compliance_documents
            FOR EACH ROW EXECUTE FUNCTION enforce_rera_requirement_scope()';
        END IF;
      END $$
    `);

    // ---------------------------------------------------------------------
    // Configuration-only seed identities and v1 policies.
    // These contain no statutory requirement rows and no deadline rules.
    // HRERA remains explicitly source-review pending.
    // ---------------------------------------------------------------------
    await client.query(`
      INSERT INTO rera_rulesets (
        organization_id, scope, code, name, jurisdiction_country_code,
        jurisdiction_state_code, authority_label, description, source_kind,
        source_review_status, source_review_notes, disclaimer
      )
      SELECT
        NULL, 'PLATFORM', 'GENERIC_FOUNDATION', 'Generic Development Foundation', 'IN',
        NULL, NULL,
        'Safe generic operating configuration for sites whose regulatory applicability is not yet classified.',
        'INTERNAL_CONFIGURATION', 'NOT_APPLICABLE',
        'Configuration identity only; it is not a legal ruleset.',
        'Configuration only. It does not provide legal advice, determine RERA applicability, or assert compliance.'
      WHERE NOT EXISTS (
        SELECT 1 FROM rera_rulesets
        WHERE organization_id IS NULL AND UPPER(code) = 'GENERIC_FOUNDATION' AND deleted_at IS NULL
      )
    `);
    await client.query(`
      INSERT INTO rera_rulesets (
        organization_id, scope, code, name, jurisdiction_country_code,
        jurisdiction_state_code, authority_label, description, source_kind,
        source_review_status, source_review_notes, disclaimer
      )
      SELECT
        NULL, 'PLATFORM', 'HRERA_FOUNDATION', 'Haryana RERA Operating Foundation', 'IN',
        'HR', 'Haryana Real Estate Regulatory Authority',
        'Configuration-only Haryana operating profile. Official source mapping and legal review are pending.',
        'UNVERIFIED_REFERENCE', 'PENDING',
        'Pending official-source mapping and qualified legal review; no statutory claims are encoded.',
        'Configuration only. It does not provide legal advice, determine applicability, or assert HRERA/RERA compliance.'
      WHERE NOT EXISTS (
        SELECT 1 FROM rera_rulesets
        WHERE organization_id IS NULL AND UPPER(code) = 'HRERA_FOUNDATION' AND deleted_at IS NULL
      )
    `);

    await client.query(`
      INSERT INTO rera_ruleset_versions (
        ruleset_id, version, version_label, lifecycle_status,
        content_classification, contains_legal_requirements, source_kind,
        source_title, source_review_status, source_review_notes, legal_disclaimer,
        module_policy, terminology_policy, field_policy, capability_policy,
        published_at
      )
      SELECT
        r.id, 1, 'Foundation v1', 'PUBLISHED',
        'CONFIGURATION_ONLY', FALSE, 'INTERNAL_CONFIGURATION',
        'MountReality generic operating configuration', 'NOT_APPLICABLE',
        'No external legal source is claimed by this configuration.',
        'Configuration only; no statutory requirements or legal deadlines are included.',
        '{
          "mode":"GENERIC_FOUNDATION",
          "modules":{
            "operating_profile":{"enabled":true},
            "rera_rulesets":{"enabled":true}
          }
        }'::jsonb,
        '{"site":"Site","project":"Project","phase":"Phase","stakeholder":"Stakeholder"}'::jsonb,
        '{}'::jsonb,
        '{
          "profile_configured":true,
          "profile_versioned":true,
          "field_policy_enabled":true,
          "ruleset_information":true
        }'::jsonb,
        NOW()
      FROM rera_rulesets r
      WHERE r.organization_id IS NULL
        AND UPPER(r.code) = 'GENERIC_FOUNDATION'
        AND r.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM rera_ruleset_versions v
          WHERE v.ruleset_id = r.id AND v.version = 1
        )
    `);
    await client.query(`
      INSERT INTO rera_ruleset_versions (
        ruleset_id, version, version_label, lifecycle_status,
        content_classification, contains_legal_requirements, source_kind,
        source_title, source_review_status, source_review_notes, legal_disclaimer,
        module_policy, terminology_policy, field_policy, capability_policy,
        published_at
      )
      SELECT
        r.id, 1, 'Foundation v1 — source review pending', 'PUBLISHED',
        'CONFIGURATION_ONLY', FALSE, 'UNVERIFIED_REFERENCE',
        'Haryana RERA operating configuration (official-source review pending)', 'PENDING',
        'No legal requirement, filing deadline, threshold, fee or statutory interpretation is included.',
        'Source review pending. This configuration does not assert HRERA/RERA registration, approval or compliance.',
        '{
          "mode":"HRERA_FOUNDATION",
          "jurisdiction":"HR",
          "source_review":"PENDING",
          "modules":{
            "operating_profile":{"enabled":true},
            "rera_projects":{"enabled":true},
            "rera_approvals":{"enabled":true},
            "rera_evidence":{"enabled":true},
            "rera_rulesets":{"enabled":true}
          }
        }'::jsonb,
        '{
          "site":"Project Site",
          "project":"RERA Project Record",
          "phase":"Project Phase",
          "stakeholder":"Promoter / Project Stakeholder"
        }'::jsonb,
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
      WHERE r.organization_id IS NULL
        AND UPPER(r.code) = 'HRERA_FOUNDATION'
        AND r.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM rera_ruleset_versions v
          WHERE v.ruleset_id = r.id AND v.version = 1
        )
    `);

    await client.query(`
      COMMENT ON TABLE site_operating_profile_revisions IS
        'Versioned per-site operating policy. Existing sites are intentionally not backfilled.'
    `);
    await client.query(`
      COMMENT ON TABLE rera_ruleset_requirements IS
        'Source-reviewed configuration/legal requirement records. Migration 094 seeds no rows here.'
    `);
    await client.query(`
      COMMENT ON COLUMN rera_projects.regulatory_status IS
        'Recorded workflow state only; REGISTERED requires authority, number and date but is not a government verification claim.'
    `);

    await client.query('COMMIT');
    console.log('Migration 094_rera_phase1_foundation complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 094_rera_phase1_foundation failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

// Forward-only by design: regulated history and compliance links are never
// destructively dropped by an automated rollback command.
async function rollback() {
  console.warn('Migration 094 is forward-only; --down made no database changes.');
}

const action = process.argv.includes('--down') ? rollback : migrate;
action()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
