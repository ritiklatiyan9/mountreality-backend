import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Phase 4 — controlled portals, release/audience policy, integrations and
 * enterprise portfolio foundations.
 *
 * Additive and re-runnable. Operational records remain in their Phase 1–3
 * tables; every Phase 4 row is an identity grant, audience/release decision,
 * communication record, workflow envelope or traceable organization link.
 */
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('099_phase4_portals_enterprise'))`);

    // A person may hold internal permissions and portal grants on the same
    // users row. PORTAL_USER is only the safe base role for invitees who do not
    // already have an internal account.
    await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
    await client.query(`
      ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('owner','super_admin','admin','sub_admin','agent','portal_user'))
    `);
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email))`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS product_features (
        feature_key VARCHAR(100) PRIMARY KEY,
        category VARCHAR(40) NOT NULL,
        display_name VARCHAR(160) NOT NULL,
        description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      INSERT INTO product_features (feature_key,category,display_name,description) VALUES
        ('buyer_portal','PORTAL','Buyer portal','Controlled buyer access to owned booking, payment, document and project-update records'),
        ('broker_portal','PORTAL','Broker portal','Controlled broker access to released inventory and the broker commission ledger'),
        ('professional_portal','PORTAL','Professional portal','Controlled professional review and certification workspace'),
        ('ruleset_packs','REGULATORY','Ruleset packs','Reviewed and versioned jurisdiction ruleset releases'),
        ('advanced_analytics','ANALYTICS','Advanced analytics','Advanced cross-project operational analytics'),
        ('enterprise_portfolio','ENTERPRISE','Enterprise portfolio','Group and legal-entity portfolio rollups with traceable sources'),
        ('api_access','INTEGRATION','API access','Managed external API and webhook access'),
        ('sso','IDENTITY','Enterprise SSO','Enterprise identity-provider configuration')
      ON CONFLICT (feature_key) DO UPDATE SET
        category=EXCLUDED.category, display_name=EXCLUDED.display_name,
        description=EXCLUDED.description
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS plan_entitlements (
        plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        feature_key VARCHAR(100) NOT NULL REFERENCES product_features(feature_key) ON DELETE CASCADE,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        limit_value INTEGER CHECK (limit_value IS NULL OR limit_value>=0),
        configuration JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(configuration)='object'),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (plan_id,feature_key)
      )
    `);
    await client.query(`
      INSERT INTO plan_entitlements (plan_id,feature_key,enabled,limit_value)
      SELECT p.id, f.feature_key,
        CASE
          WHEN f.feature_key IN ('buyer_portal','broker_portal','professional_portal','ruleset_packs') THEN TRUE
          WHEN f.feature_key='advanced_analytics' AND p.code IN ('growth','enterprise') THEN TRUE
          WHEN f.feature_key IN ('enterprise_portfolio','api_access','sso') AND p.code='enterprise' THEN TRUE
          ELSE FALSE
        END,
        CASE
          WHEN f.feature_key='buyer_portal' THEN CASE p.code WHEN 'starter' THEN 50 WHEN 'growth' THEN 500 ELSE NULL END
          WHEN f.feature_key='broker_portal' THEN CASE p.code WHEN 'starter' THEN 10 WHEN 'growth' THEN 100 ELSE NULL END
          WHEN f.feature_key='professional_portal' THEN CASE p.code WHEN 'starter' THEN 10 WHEN 'growth' THEN 100 ELSE NULL END
          ELSE NULL
        END
      FROM plans p CROSS JOIN product_features f
      ON CONFLICT (plan_id,feature_key) DO NOTHING
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS organization_entitlement_overrides (
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        feature_key VARCHAR(100) NOT NULL REFERENCES product_features(feature_key) ON DELETE CASCADE,
        enabled BOOLEAN,
        limit_value INTEGER CHECK (limit_value IS NULL OR limit_value>=0),
        configuration JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(configuration)='object'),
        reason TEXT NOT NULL,
        effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        effective_to TIMESTAMPTZ,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (organization_id,feature_key),
        CHECK (effective_to IS NULL OR effective_to>effective_from)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS portal_invitations (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        site_id INTEGER REFERENCES sites(id) ON DELETE RESTRICT,
        rera_project_id BIGINT REFERENCES rera_projects(id) ON DELETE RESTRICT,
        rera_project_phase_id BIGINT REFERENCES rera_project_phases(id) ON DELETE RESTRICT,
        portal_type VARCHAR(24) NOT NULL CHECK (portal_type IN ('BUYER','BROKER','PROFESSIONAL')),
        domain_entity_type VARCHAR(32) NOT NULL CHECK (domain_entity_type IN ('MEMBER','RERA_STAKEHOLDER')),
        domain_entity_id BIGINT NOT NULL,
        email VARCHAR(320) NOT NULL CHECK (BTRIM(email)<>''),
        token_hash CHAR(64) NOT NULL UNIQUE,
        permission_policy JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(permission_policy)='object'),
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','REVOKED','EXPIRED')),
        effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        effective_to TIMESTAMPTZ,
        expires_at TIMESTAMPTZ NOT NULL,
        invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        accepted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        accepted_at TIMESTAMPTZ,
        revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (expires_at>created_at),
        CHECK (effective_to IS NULL OR effective_to>effective_from),
        CHECK ((status='ACCEPTED')=(accepted_by IS NOT NULL AND accepted_at IS NOT NULL)),
        CHECK (status<>'REVOKED' OR revoked_at IS NOT NULL)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_invitation_pending
      ON portal_invitations (
        organization_id,LOWER(email),portal_type,domain_entity_type,domain_entity_id,
        COALESCE(site_id,0),COALESCE(rera_project_id,0),COALESCE(rera_project_phase_id,0)
      ) WHERE status='PENDING'
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_portal_invitation_expiry ON portal_invitations(status,expires_at)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS portal_memberships (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        site_id INTEGER REFERENCES sites(id) ON DELETE RESTRICT,
        rera_project_id BIGINT REFERENCES rera_projects(id) ON DELETE RESTRICT,
        rera_project_phase_id BIGINT REFERENCES rera_project_phases(id) ON DELETE RESTRICT,
        portal_type VARCHAR(24) NOT NULL CHECK (portal_type IN ('BUYER','BROKER','PROFESSIONAL')),
        domain_entity_type VARCHAR(32) NOT NULL CHECK (domain_entity_type IN ('MEMBER','RERA_STAKEHOLDER')),
        domain_entity_id BIGINT NOT NULL,
        permission_policy JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(permission_policy)='object'),
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('PENDING','ACTIVE','SUSPENDED','REVOKED','EXPIRED')),
        effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        effective_to TIMESTAMPTZ,
        invitation_id BIGINT REFERENCES portal_invitations(id) ON DELETE SET NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (effective_to IS NULL OR effective_to>effective_from),
        CHECK (status<>'REVOKED' OR revoked_at IS NOT NULL)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_membership_identity_scope
      ON portal_memberships (
        user_id,organization_id,portal_type,domain_entity_type,domain_entity_id,
        COALESCE(site_id,0),COALESCE(rera_project_id,0),COALESCE(rera_project_phase_id,0)
      ) WHERE status IN ('PENDING','ACTIVE','SUSPENDED')
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_portal_membership_user_active ON portal_memberships(user_id,portal_type,status,effective_from,effective_to)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_portal_membership_scope ON portal_memberships(organization_id,site_id,rera_project_id,rera_project_phase_id,portal_type,status)`);

    // Memberships fail closed at the database boundary if a generic domain
    // reference or any scope column points outside the tenant/project.
    await client.query(`
      CREATE OR REPLACE FUNCTION validate_portal_identity_scope()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE v_user_org INTEGER; v_site_org INTEGER; v_project_site INTEGER;
              v_project_org INTEGER; v_phase_project BIGINT; v_phase_site INTEGER;
              v_member_site INTEGER; v_member_type VARCHAR; v_stakeholder_org INTEGER;
      BEGIN
        SELECT organization_id INTO v_user_org FROM users WHERE id=NEW.user_id AND is_active=TRUE;
        IF v_user_org IS NULL OR v_user_org<>NEW.organization_id THEN
          RAISE EXCEPTION 'Portal identity belongs to another organization' USING ERRCODE='42501';
        END IF;
        IF NEW.site_id IS NOT NULL THEN
          SELECT organization_id INTO v_site_org FROM sites WHERE id=NEW.site_id;
          IF v_site_org IS NULL OR v_site_org<>NEW.organization_id THEN
            RAISE EXCEPTION 'Portal Site belongs to another organization' USING ERRCODE='42501';
          END IF;
        END IF;
        IF NEW.rera_project_id IS NOT NULL THEN
          SELECT organization_id,site_id INTO v_project_org,v_project_site FROM rera_projects WHERE id=NEW.rera_project_id AND deleted_at IS NULL;
          IF v_project_org IS NULL OR v_project_org<>NEW.organization_id OR (NEW.site_id IS NOT NULL AND v_project_site<>NEW.site_id) THEN
            RAISE EXCEPTION 'Portal project is outside the membership scope' USING ERRCODE='42501';
          END IF;
        END IF;
        IF NEW.rera_project_phase_id IS NOT NULL THEN
          SELECT rera_project_id,site_id INTO v_phase_project,v_phase_site FROM rera_project_phases WHERE id=NEW.rera_project_phase_id AND deleted_at IS NULL;
          IF v_phase_project IS NULL OR NEW.rera_project_id IS NULL OR v_phase_project<>NEW.rera_project_id OR (NEW.site_id IS NOT NULL AND v_phase_site<>NEW.site_id) THEN
            RAISE EXCEPTION 'Portal phase is outside the membership project' USING ERRCODE='42501';
          END IF;
        END IF;
        IF NEW.domain_entity_type='MEMBER' THEN
          SELECT site_id,member_type INTO v_member_site,v_member_type FROM members WHERE id=NEW.domain_entity_id;
          IF v_member_site IS NULL OR NEW.site_id IS NULL OR v_member_site<>NEW.site_id THEN
            RAISE EXCEPTION 'Portal member is outside the membership Site' USING ERRCODE='42501';
          END IF;
          IF NEW.portal_type='BUYER' AND v_member_type NOT IN ('CLIENT','MEMBER') THEN
            RAISE EXCEPTION 'Buyer portal requires a client/member record';
          END IF;
          IF NEW.portal_type='BROKER' AND v_member_type<>'BROKER' THEN
            RAISE EXCEPTION 'Broker portal requires a broker member record';
          END IF;
        ELSE
          SELECT organization_id INTO v_stakeholder_org FROM rera_stakeholders WHERE id=NEW.domain_entity_id AND deleted_at IS NULL;
          IF NEW.portal_type<>'PROFESSIONAL' OR v_stakeholder_org IS NULL OR v_stakeholder_org<>NEW.organization_id THEN
            RAISE EXCEPTION 'Professional portal requires a same-tenant stakeholder' USING ERRCODE='42501';
          END IF;
          IF NEW.rera_project_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM rera_project_participants p
             WHERE p.organization_id=NEW.organization_id AND p.rera_project_id=NEW.rera_project_id
               AND p.stakeholder_id=NEW.domain_entity_id AND p.deleted_at IS NULL
               AND (NEW.rera_project_phase_id IS NULL OR p.rera_project_phase_id IS NULL OR p.rera_project_phase_id=NEW.rera_project_phase_id)
          ) THEN RAISE EXCEPTION 'Professional is not assigned to this project scope' USING ERRCODE='42501'; END IF;
        END IF;
        RETURN NEW;
      END; $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_validate_portal_identity_scope ON portal_memberships`);
    await client.query(`
      CREATE TRIGGER trg_validate_portal_identity_scope
      BEFORE INSERT OR UPDATE OF user_id,organization_id,site_id,rera_project_id,rera_project_phase_id,portal_type,domain_entity_type,domain_entity_id
      ON portal_memberships FOR EACH ROW EXECUTE FUNCTION validate_portal_identity_scope()
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS portal_document_grants (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        site_id INTEGER REFERENCES sites(id) ON DELETE RESTRICT,
        document_store VARCHAR(32) NOT NULL CHECK (document_store IN ('DOCUMENTS','COMPLIANCE_DOCUMENTS')),
        document_id BIGINT NOT NULL,
        portal_type VARCHAR(24) NOT NULL CHECK (portal_type IN ('BUYER','BROKER','PROFESSIONAL')),
        membership_id BIGINT REFERENCES portal_memberships(id) ON DELETE CASCADE,
        audience_scope VARCHAR(24) NOT NULL DEFAULT 'MEMBERSHIP' CHECK (audience_scope IN ('MEMBERSHIP','PORTAL_TYPE')),
        status VARCHAR(20) NOT NULL DEFAULT 'RELEASED' CHECK (status IN ('DRAFT','RELEASED','WITHDRAWN')),
        title_override VARCHAR(300),
        release_notes TEXT,
        released_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        released_at TIMESTAMPTZ,
        withdrawn_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        withdrawn_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK ((audience_scope='MEMBERSHIP')=(membership_id IS NOT NULL)),
        CHECK (status<>'RELEASED' OR (released_by IS NOT NULL AND released_at IS NOT NULL)),
        CHECK (status<>'WITHDRAWN' OR withdrawn_at IS NOT NULL)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_document_grant_active
      ON portal_document_grants(document_store,document_id,portal_type,COALESCE(membership_id,0))
      WHERE status IN ('DRAFT','RELEASED')
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_portal_document_audience ON portal_document_grants(organization_id,site_id,portal_type,status,membership_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS portal_inventory_releases (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        plot_id INTEGER NOT NULL REFERENCES plots(id) ON DELETE RESTRICT,
        portal_type VARCHAR(24) NOT NULL DEFAULT 'BROKER' CHECK (portal_type IN ('BUYER','BROKER')),
        membership_id BIGINT REFERENCES portal_memberships(id) ON DELETE CASCADE,
        audience_scope VARCHAR(24) NOT NULL DEFAULT 'PORTAL_TYPE' CHECK (audience_scope IN ('MEMBERSHIP','PORTAL_TYPE')),
        released_fields JSONB NOT NULL DEFAULT '["plot_no","plot_size","plot_rate","status"]'::jsonb CHECK (jsonb_typeof(released_fields)='array'),
        status VARCHAR(20) NOT NULL DEFAULT 'RELEASED' CHECK (status IN ('DRAFT','RELEASED','WITHDRAWN')),
        released_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        released_at TIMESTAMPTZ,
        withdrawn_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        withdrawn_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK ((audience_scope='MEMBERSHIP')=(membership_id IS NOT NULL)),
        CHECK (status<>'RELEASED' OR (released_by IS NOT NULL AND released_at IS NOT NULL)),
        CHECK (status<>'WITHDRAWN' OR withdrawn_at IS NOT NULL)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_inventory_release_active
      ON portal_inventory_releases(plot_id,portal_type,COALESCE(membership_id,0))
      WHERE status IN ('DRAFT','RELEASED')
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_portal_inventory_audience ON portal_inventory_releases(organization_id,site_id,portal_type,status,membership_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS portal_project_updates (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        rera_project_id BIGINT NOT NULL REFERENCES rera_projects(id) ON DELETE RESTRICT,
        rera_project_phase_id BIGINT REFERENCES rera_project_phases(id) ON DELETE RESTRICT,
        source_type VARCHAR(48) NOT NULL CHECK (source_type IN ('CONSTRUCTION_DAILY_UPDATE','CONSTRUCTION_CERTIFICATION','CONSTRUCTION_PROJECT','RERA_PHASE')),
        source_id BIGINT NOT NULL,
        headline VARCHAR(300) NOT NULL CHECK (BTRIM(headline)<>''),
        summary TEXT,
        audience_types JSONB NOT NULL DEFAULT '["BUYER"]'::jsonb CHECK (jsonb_typeof(audience_types)='array'),
        status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','RELEASED','WITHDRAWN')),
        released_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        released_at TIMESTAMPTZ,
        withdrawn_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        withdrawn_at TIMESTAMPTZ,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (status<>'RELEASED' OR (released_by IS NOT NULL AND released_at IS NOT NULL)),
        CHECK (status<>'WITHDRAWN' OR withdrawn_at IS NOT NULL),
        UNIQUE (organization_id,source_type,source_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_portal_updates_release ON portal_project_updates(rera_project_id,rera_project_phase_id,status,released_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS portal_comments (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        site_id INTEGER REFERENCES sites(id) ON DELETE RESTRICT,
        membership_id BIGINT REFERENCES portal_memberships(id) ON DELETE SET NULL,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        target_type VARCHAR(48) NOT NULL,
        target_id BIGINT NOT NULL,
        parent_comment_id BIGINT REFERENCES portal_comments(id) ON DELETE RESTRICT,
        body TEXT NOT NULL CHECK (BTRIM(body)<>'' AND LENGTH(body)<=10000),
        visibility VARCHAR(32) NOT NULL DEFAULT 'INTERNAL' CHECK (visibility IN ('INTERNAL','ALL_PORTAL','BUYER','BROKER','PROFESSIONAL')),
        edited_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_portal_comments_target ON portal_comments(organization_id,target_type,target_id,created_at) WHERE deleted_at IS NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS portal_notification_preferences (
        membership_id BIGINT PRIMARY KEY REFERENCES portal_memberships(id) ON DELETE CASCADE,
        event_preferences JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(event_preferences)='object'),
        quiet_hours JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(quiet_hours)='object'),
        email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        sms_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        dashboard_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS portal_notifications (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        membership_id BIGINT NOT NULL REFERENCES portal_memberships(id) ON DELETE CASCADE,
        event_type VARCHAR(80) NOT NULL,
        source_type VARCHAR(60),
        source_id BIGINT,
        title VARCHAR(300) NOT NULL,
        message TEXT NOT NULL,
        action_path TEXT,
        dedupe_key VARCHAR(180) NOT NULL,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (membership_id,dedupe_key)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_portal_notifications_unread ON portal_notifications(membership_id,created_at DESC) WHERE read_at IS NULL`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS portal_notification_deliveries (
        id BIGSERIAL PRIMARY KEY,
        notification_id BIGINT NOT NULL REFERENCES portal_notifications(id) ON DELETE CASCADE,
        channel VARCHAR(20) NOT NULL CHECK (channel IN ('DASHBOARD','EMAIL','SMS')),
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','DELIVERED','FAILED','SKIPPED')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        delivery_reference TEXT,
        failure_reason TEXT,
        last_attempt_at TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (notification_id,channel)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_ruleset_release_workflows (
        id BIGSERIAL PRIMARY KEY,
        ruleset_version_id BIGINT NOT NULL UNIQUE REFERENCES rera_ruleset_versions(id) ON DELETE RESTRICT,
        workflow_status VARCHAR(24) NOT NULL DEFAULT 'DRAFT' CHECK (workflow_status IN ('DRAFT','SOURCE_REVIEW','LEGAL_REVIEW','IMPACT_REVIEW','APPROVED','RELEASED','REJECTED','RETIRED')),
        source_record JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_record)='object'),
        source_reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        source_reviewed_at TIMESTAMPTZ,
        legal_reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        legal_reviewed_at TIMESTAMPTZ,
        approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approved_at TIMESTAMPTZ,
        released_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        released_at TIMESTAMPTZ,
        review_notes TEXT,
        rejection_reason TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (workflow_status<>'RELEASED' OR (approved_at IS NOT NULL AND released_by IS NOT NULL AND released_at IS NOT NULL)),
        CHECK (workflow_status<>'REJECTED' OR NULLIF(BTRIM(rejection_reason),'') IS NOT NULL)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_ruleset_impact_snapshots (
        id BIGSERIAL PRIMARY KEY,
        workflow_id BIGINT NOT NULL REFERENCES rera_ruleset_release_workflows(id) ON DELETE RESTRICT,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        impacted_site_count INTEGER NOT NULL DEFAULT 0,
        impacted_project_count INTEGER NOT NULL DEFAULT 0,
        impacted_profile_count INTEGER NOT NULL DEFAULT 0,
        impact_details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(impact_details)='object'),
        computed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ruleset_impact_workflow ON rera_ruleset_impact_snapshots(workflow_id,computed_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS integration_connections (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        connection_key VARCHAR(100) NOT NULL,
        integration_kind VARCHAR(32) NOT NULL CHECK (integration_kind IN ('API_CLIENT','WEBHOOK_IN','WEBHOOK_OUT','SSO_CONFIGURATION','DATA_EXPORT')),
        provider_key VARCHAR(100) NOT NULL,
        mode VARCHAR(20) NOT NULL DEFAULT 'FRAMEWORK' CHECK (mode IN ('FRAMEWORK','SANDBOX','LIVE')),
        status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','SUSPENDED','REVOKED')),
        secret_reference VARCHAR(180),
        signing_secret_reference VARCHAR(180),
        endpoint_url TEXT,
        allowed_events JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_events)='array'),
        configuration JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(configuration)='object'),
        last_verified_at TIMESTAMPTZ,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (organization_id,connection_key),
        CHECK (secret_reference IS NULL OR secret_reference ~ '^[A-Z][A-Z0-9_]{2,179}$'),
        CHECK (signing_secret_reference IS NULL OR signing_secret_reference ~ '^[A-Z][A-Z0-9_]{2,179}$')
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS integration_events (
        id BIGSERIAL PRIMARY KEY,
        connection_id BIGINT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
        direction VARCHAR(12) NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
        event_type VARCHAR(100) NOT NULL,
        external_event_id VARCHAR(180),
        idempotency_key VARCHAR(180) NOT NULL,
        payload_sha256 CHAR(64) NOT NULL,
        signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
        status VARCHAR(24) NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','VALIDATED','PROCESSING','DELIVERED','FAILED','REJECTED')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        response_code INTEGER,
        failure_reason TEXT,
        next_attempt_at TIMESTAMPTZ,
        processed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (connection_id,direction,idempotency_key)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_integration_event_retry ON integration_events(status,next_attempt_at) WHERE status='FAILED'`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS developer_groups (
        id BIGSERIAL PRIMARY KEY,
        owner_organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        group_code VARCHAR(80) NOT NULL,
        legal_name VARCHAR(300) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT','ACTIVE','INACTIVE','ARCHIVED')),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (owner_organization_id,group_code)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS developer_group_organizations (
        group_id BIGINT NOT NULL REFERENCES developer_groups(id) ON DELETE CASCADE,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        relationship_status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (relationship_status IN ('PENDING','ACTIVE','REJECTED','REMOVED')),
        invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        accepted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        accepted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (group_id,organization_id),
        CHECK (relationship_status<>'ACTIVE' OR accepted_at IS NOT NULL)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_developer_group_org ON developer_group_organizations(organization_id,relationship_status,group_id)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS legal_entities (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        developer_group_id BIGINT REFERENCES developer_groups(id) ON DELETE SET NULL,
        entity_code VARCHAR(80) NOT NULL,
        legal_name VARCHAR(300) NOT NULL,
        entity_type VARCHAR(32) NOT NULL CHECK (entity_type IN ('PROPRIETORSHIP','PARTNERSHIP','LLP','COMPANY','TRUST','SOCIETY','OTHER')),
        pan VARCHAR(20),
        gstin VARCHAR(20),
        cin_or_llpin VARCHAR(40),
        registered_address JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(registered_address)='object'),
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT','ACTIVE','INACTIVE','ARCHIVED')),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (organization_id,entity_code),
        UNIQUE (organization_id,id)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS site_legal_entity_assignments (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL,
        legal_entity_id BIGINT NOT NULL,
        relationship_type VARCHAR(32) NOT NULL DEFAULT 'PROJECT_OWNER' CHECK (relationship_type IN ('PROJECT_OWNER','PROMOTER','DEVELOPER','LANDOWNER','OPERATING_ENTITY','OTHER')),
        effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
        effective_to DATE,
        basis_reference TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        FOREIGN KEY (organization_id,site_id) REFERENCES sites(organization_id,id) ON DELETE RESTRICT,
        FOREIGN KEY (organization_id,legal_entity_id) REFERENCES legal_entities(organization_id,id) ON DELETE RESTRICT,
        CHECK (effective_to IS NULL OR effective_to>=effective_from)
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_site_legal_entity_active_role ON site_legal_entity_assignments(site_id,relationship_type) WHERE effective_to IS NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_legal_entity_site ON site_legal_entity_assignments(legal_entity_id,effective_to,site_id)`);

    await client.query('COMMIT');
    console.log('Migration 099_phase4_portals_enterprise complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 099_phase4_portals_enterprise failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
