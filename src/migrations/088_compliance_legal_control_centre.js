import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 088 — Compliance & Legal Control Centre.
 *
 * Additive, tenant-scoped and re-runnable. No existing table or column is
 * removed. Compliance evidence stores only private storage keys; URLs are
 * generated after an authenticated permission check.
 */
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('088_compliance_legal_control_centre'))`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS compliance_authorities (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        department_name VARCHAR(255),
        authority_type VARCHAR(100),
        state VARCHAR(100),
        district VARCHAR(100),
        address TEXT,
        contact_person VARCHAR(255),
        phone VARCHAR(30),
        email VARCHAR(255),
        website VARCHAR(500),
        office_timings VARCHAR(255),
        categories JSONB NOT NULL DEFAULT '[]'::jsonb,
        notes TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_authority_org_name_location
      ON compliance_authorities (
        organization_id, UPPER(name), COALESCE(UPPER(state), ''), COALESCE(UPPER(district), '')
      ) WHERE deleted_at IS NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS compliance_templates (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        authority_id INTEGER REFERENCES compliance_authorities(id) ON DELETE SET NULL,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(120) NOT NULL DEFAULT 'OTHER',
        subcategory VARCHAR(120),
        compliance_type VARCHAR(120) NOT NULL DEFAULT 'OTHER',
        description TEXT,
        applicable_state VARCHAR(100),
        applicable_district VARCHAR(100),
        applicable_project_type VARCHAR(120),
        applicability_conditions TEXT,
        applicable_site_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        frequency VARCHAR(30) NOT NULL DEFAULT 'ONE_TIME',
        start_date DATE,
        end_date DATE,
        due_date_rule JSONB NOT NULL DEFAULT '{"type":"MANUAL"}'::jsonb,
        default_responsible_role VARCHAR(80),
        default_reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        default_approver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        required_checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
        required_documents JSONB NOT NULL DEFAULT '[]'::jsonb,
        default_risk VARCHAR(20) NOT NULL DEFAULT 'MEDIUM'
          CHECK (default_risk IN ('LOW','MEDIUM','HIGH','CRITICAL')),
        default_reminder_days INTEGER[] NOT NULL DEFAULT ARRAY[30,15,7,1,0],
        default_escalations JSONB NOT NULL DEFAULT '[]'::jsonb,
        renewal_required BOOLEAN NOT NULL DEFAULT FALSE,
        approval_required BOOLEAN NOT NULL DEFAULT FALSE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_template_org_name
      ON compliance_templates (organization_id, UPPER(name)) WHERE deleted_at IS NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS compliance_items (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
        template_id INTEGER REFERENCES compliance_templates(id) ON DELETE SET NULL,
        authority_id INTEGER REFERENCES compliance_authorities(id) ON DELETE SET NULL,
        compliance_code VARCHAR(60) NOT NULL,
        title VARCHAR(300) NOT NULL,
        description TEXT,
        category VARCHAR(120) NOT NULL DEFAULT 'OTHER',
        subcategory VARCHAR(120),
        compliance_type VARCHAR(120) NOT NULL DEFAULT 'OTHER',
        state VARCHAR(100),
        district VARCHAR(100),
        department VARCHAR(255),
        applicable_law TEXT,
        section_reference VARCHAR(255),
        frequency VARCHAR(30) NOT NULL DEFAULT 'ONE_TIME',
        original_due_date DATE,
        current_due_date DATE,
        grace_period_days INTEGER NOT NULL DEFAULT 0 CHECK (grace_period_days BETWEEN 0 AND 3650),
        reminder_days INTEGER[] NOT NULL DEFAULT ARRAY[30,15,7,1,0],
        assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewing_manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approving_authority_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        external_consultant VARCHAR(255),
        priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM'
          CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
        risk_level VARCHAR(20) NOT NULL DEFAULT 'MEDIUM'
          CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
        risk_override_reason TEXT,
        financial_impact NUMERIC(15,2) NOT NULL DEFAULT 0,
        penalty_details TEXT,
        status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
        completion_percentage INTEGER NOT NULL DEFAULT 0 CHECK (completion_percentage BETWEEN 0 AND 100),
        last_completed_date DATE,
        next_due_date DATE,
        notes TEXT,
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        related_entities JSONB NOT NULL DEFAULT '{}'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        approval_required BOOLEAN NOT NULL DEFAULT FALSE,
        confidentiality VARCHAR(20) NOT NULL DEFAULT 'INTERNAL'
          CHECK (confidentiality IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
        generated_key VARCHAR(255),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        UNIQUE (organization_id, compliance_code)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_generated_key
      ON compliance_items (organization_id, generated_key)
      WHERE generated_key IS NOT NULL AND deleted_at IS NULL
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compliance_items_org_due ON compliance_items (organization_id, current_due_date) WHERE deleted_at IS NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compliance_items_site_due ON compliance_items (site_id, current_due_date) WHERE deleted_at IS NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compliance_items_status_risk ON compliance_items (organization_id, status, risk_level) WHERE deleted_at IS NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compliance_items_assignee ON compliance_items (assigned_to, current_due_date) WHERE deleted_at IS NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compliance_items_authority ON compliance_items (authority_id) WHERE deleted_at IS NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS compliance_checklist_items (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        compliance_item_id INTEGER NOT NULL REFERENCES compliance_items(id) ON DELETE CASCADE,
        title VARCHAR(300) NOT NULL,
        description TEXT,
        is_mandatory BOOLEAN NOT NULL DEFAULT FALSE,
        assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
        due_date DATE,
        status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
        required_document_type VARCHAR(120),
        completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        completed_at TIMESTAMPTZ,
        comments TEXT,
        sequence INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compliance_checklist_item ON compliance_checklist_items (compliance_item_id, sequence)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS compliance_status_history (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        compliance_item_id INTEGER NOT NULL REFERENCES compliance_items(id) ON DELETE CASCADE,
        previous_status VARCHAR(40),
        new_status VARCHAR(40) NOT NULL,
        changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        comment TEXT,
        attachment_document_id INTEGER,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compliance_status_history_item ON compliance_status_history (compliance_item_id, changed_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS compliance_due_date_changes (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        compliance_item_id INTEGER NOT NULL REFERENCES compliance_items(id) ON DELETE CASCADE,
        old_due_date DATE,
        new_due_date DATE NOT NULL,
        reason TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
          CHECK (status IN ('PENDING','APPROVED','REJECTED')),
        requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        review_comment TEXT,
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compliance_due_changes_pending ON compliance_due_date_changes (organization_id, status, requested_at DESC)`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_pending_due_change
      ON compliance_due_date_changes (organization_id,compliance_item_id)
      WHERE status='PENDING'
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS compliance_approvals (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        compliance_item_id INTEGER REFERENCES compliance_items(id) ON DELETE CASCADE,
        entity_type VARCHAR(40) NOT NULL DEFAULT 'COMPLIANCE',
        entity_id INTEGER,
        action_type VARCHAR(60) NOT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'PENDING'
          CHECK (status IN ('PENDING','APPROVED','REJECTED','RETURNED','INFO_REQUESTED')),
        requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        assigned_approver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        request_comment TEXT,
        review_comment TEXT,
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compliance_approvals_pending ON compliance_approvals (organization_id, status, assigned_approver_id)`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_pending_entity_action
      ON compliance_approvals (organization_id, entity_type, entity_id, action_type)
      WHERE status='PENDING' AND entity_id IS NOT NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS compliance_licences (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
        authority_id INTEGER REFERENCES compliance_authorities(id) ON DELETE SET NULL,
        compliance_item_id INTEGER REFERENCES compliance_items(id) ON DELETE SET NULL,
        name VARCHAR(300) NOT NULL,
        licence_type VARCHAR(120) NOT NULL DEFAULT 'OTHER',
        licence_number VARCHAR(150),
        issue_date DATE,
        effective_date DATE,
        expiry_date DATE,
        renewal_application_date DATE,
        renewal_status VARCHAR(40) NOT NULL DEFAULT 'NOT_STARTED',
        renewal_cost NUMERIC(15,2) NOT NULL DEFAULT 0,
        security_deposit NUMERIC(15,2) NOT NULL DEFAULT 0,
        conditions TEXT,
        responsible_person_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        verification_status VARCHAR(30) NOT NULL DEFAULT 'UNVERIFIED',
        reminder_days INTEGER[] NOT NULL DEFAULT ARRAY[180,90,60,30,15,7,0],
        notes TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compliance_licences_expiry ON compliance_licences (organization_id, expiry_date) WHERE deleted_at IS NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compliance_licences_site ON compliance_licences (site_id, expiry_date) WHERE deleted_at IS NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS compliance_finance_links (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        compliance_item_id INTEGER NOT NULL REFERENCES compliance_items(id) ON DELETE CASCADE,
        expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
        cost_type VARCHAR(60) NOT NULL DEFAULT 'COMPLIANCE_FEE',
        notes TEXT,
        linked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (organization_id, compliance_item_id, expense_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compliance_finance_expense ON compliance_finance_links (expense_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS legal_cases (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
        case_code VARCHAR(60) NOT NULL,
        title VARCHAR(300) NOT NULL,
        case_type VARCHAR(120) NOT NULL DEFAULT 'OTHER',
        court_authority VARCHAR(300),
        case_number VARCHAR(150),
        filing_number VARCHAR(150),
        case_year INTEGER,
        opposite_party VARCHAR(300),
        party_type VARCHAR(80),
        advocate VARCHAR(255),
        internal_owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        summary TEXT,
        claim_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
        financial_exposure NUMERIC(15,2) NOT NULL DEFAULT 0,
        risk_level VARCHAR(20) NOT NULL DEFAULT 'MEDIUM'
          CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
        stage VARCHAR(60) NOT NULL DEFAULT 'PRE_LITIGATION',
        next_hearing_date TIMESTAMPTZ,
        last_hearing_date TIMESTAMPTZ,
        filing_date DATE,
        limitation_date DATE,
        status VARCHAR(30) NOT NULL DEFAULT 'OPEN',
        related_entities JSONB NOT NULL DEFAULT '{}'::jsonb,
        notes TEXT,
        confidentiality VARCHAR(20) NOT NULL DEFAULT 'CONFIDENTIAL'
          CHECK (confidentiality IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        UNIQUE (organization_id, case_code)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_legal_cases_org_stage ON legal_cases (organization_id, status, stage) WHERE deleted_at IS NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_legal_cases_hearing ON legal_cases (organization_id, next_hearing_date) WHERE deleted_at IS NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_legal_cases_number ON legal_cases (organization_id, case_number) WHERE deleted_at IS NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS legal_case_timeline (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        legal_case_id INTEGER NOT NULL REFERENCES legal_cases(id) ON DELETE CASCADE,
        event_type VARCHAR(80) NOT NULL,
        event_date TIMESTAMPTZ NOT NULL,
        title VARCHAR(300) NOT NULL,
        description TEXT,
        outcome TEXT,
        next_action TEXT,
        next_action_due_date TIMESTAMPTZ,
        assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
        advocate VARCHAR(255),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_legal_timeline_case ON legal_case_timeline (legal_case_id, event_date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_legal_timeline_due ON legal_case_timeline (organization_id, next_action_due_date)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS legal_notices (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
        authority_id INTEGER REFERENCES compliance_authorities(id) ON DELETE SET NULL,
        legal_case_id INTEGER REFERENCES legal_cases(id) ON DELETE SET NULL,
        notice_number VARCHAR(150),
        notice_type VARCHAR(120) NOT NULL DEFAULT 'OTHER',
        direction VARCHAR(20) NOT NULL DEFAULT 'INCOMING'
          CHECK (direction IN ('INCOMING','OUTGOING')),
        sender VARCHAR(300),
        recipient VARCHAR(300),
        date_received DATE,
        notice_date DATE,
        reply_due_date DATE,
        responsible_person_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewing_manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        advocate VARCHAR(255),
        risk_level VARCHAR(20) NOT NULL DEFAULT 'MEDIUM'
          CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
        status VARCHAR(40) NOT NULL DEFAULT 'RECEIVED',
        subject VARCHAR(500) NOT NULL,
        summary TEXT,
        amount_involved NUMERIC(15,2) NOT NULL DEFAULT 0,
        draft_reply TEXT,
        final_reply TEXT,
        submission_proof TEXT,
        dispatch_details TEXT,
        courier_tracking VARCHAR(255),
        related_entities JSONB NOT NULL DEFAULT '{}'::jsonb,
        notes TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_legal_notices_due ON legal_notices (organization_id, reply_due_date, status) WHERE deleted_at IS NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_legal_notices_number ON legal_notices (organization_id, notice_number) WHERE deleted_at IS NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS compliance_inspections (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
        authority_id INTEGER REFERENCES compliance_authorities(id) ON DELETE SET NULL,
        compliance_item_id INTEGER REFERENCES compliance_items(id) ON DELETE SET NULL,
        legal_case_id INTEGER REFERENCES legal_cases(id) ON DELETE SET NULL,
        inspection_type VARCHAR(120) NOT NULL,
        scheduled_at TIMESTAMPTZ NOT NULL,
        location TEXT,
        meeting_mode VARCHAR(20) NOT NULL DEFAULT 'OFFLINE'
          CHECK (meeting_mode IN ('ONLINE','OFFLINE','HYBRID')),
        meeting_link TEXT,
        responsible_person_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        attendees JSONB NOT NULL DEFAULT '[]'::jsonb,
        preparation_checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
        required_documents JSONB NOT NULL DEFAULT '[]'::jsonb,
        findings TEXT,
        non_conformities TEXT,
        corrective_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
        follow_up_date DATE,
        status VARCHAR(30) NOT NULL DEFAULT 'SCHEDULED',
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compliance_inspections_schedule ON compliance_inspections (organization_id, scheduled_at, status) WHERE deleted_at IS NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS compliance_documents (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
        entity_type VARCHAR(40) NOT NULL,
        entity_id INTEGER NOT NULL,
        category VARCHAR(120) NOT NULL DEFAULT 'OTHER',
        title VARCHAR(300) NOT NULL,
        original_name VARCHAR(500) NOT NULL,
        storage_key TEXT NOT NULL,
        mime_type VARCHAR(150) NOT NULL,
        file_size BIGINT NOT NULL DEFAULT 0,
        version_no INTEGER NOT NULL DEFAULT 1,
        ocr_text TEXT,
        ocr_status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        ocr_error TEXT,
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        verification_status VARCHAR(30) NOT NULL DEFAULT 'UNVERIFIED',
        approval_status VARCHAR(30) NOT NULL DEFAULT 'NOT_REQUIRED',
        confidentiality VARCHAR(20) NOT NULL DEFAULT 'INTERNAL'
          CHECK (confidentiality IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
        issue_date DATE,
        expiry_date DATE,
        issuing_authority VARCHAR(300),
        uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compliance_documents_entity ON compliance_documents (organization_id, entity_type, entity_id, created_at DESC) WHERE deleted_at IS NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compliance_documents_expiry ON compliance_documents (organization_id, expiry_date) WHERE deleted_at IS NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compliance_documents_ocr ON compliance_documents USING gin (to_tsvector('simple', COALESCE(ocr_text,''))) WHERE deleted_at IS NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS compliance_notification_log (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
        entity_type VARCHAR(40) NOT NULL,
        entity_id INTEGER NOT NULL,
        recipient_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        channel VARCHAR(20) NOT NULL,
        notification_type VARCHAR(60) NOT NULL,
        scheduled_for DATE NOT NULL,
        title VARCHAR(300),
        due_date DATE,
        message TEXT NOT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        delivery_reference TEXT,
        failure_reason TEXT,
        sent_at TIMESTAMPTZ,
        last_attempt_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (organization_id, entity_type, entity_id, recipient_user_id, channel, notification_type, scheduled_for)
      )
    `);
    await client.query(`ALTER TABLE compliance_notification_log ADD COLUMN IF NOT EXISTS title VARCHAR(300)`);
    await client.query(`ALTER TABLE compliance_notification_log ADD COLUMN IF NOT EXISTS due_date DATE`);
    await client.query(`ALTER TABLE compliance_notification_log ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compliance_notifications_status ON compliance_notification_log (status, scheduled_for)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS compliance_audit_log (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action VARCHAR(100) NOT NULL,
        entity_type VARCHAR(60) NOT NULL,
        entity_id INTEGER,
        previous_value JSONB,
        new_value JSONB,
        reason TEXT,
        ip_address INET,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compliance_audit_entity ON compliance_audit_log (organization_id, entity_type, entity_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_compliance_audit_user ON compliance_audit_log (organization_id, user_id, created_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS compliance_settings (
        organization_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        timezone VARCHAR(80) NOT NULL DEFAULT 'Asia/Kolkata',
        due_date_change_requires_approval BOOLEAN NOT NULL DEFAULT TRUE,
        completion_requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
        notification_channels JSONB NOT NULL DEFAULT '["DASHBOARD","EMAIL"]'::jsonb,
        default_reminder_days INTEGER[] NOT NULL DEFAULT ARRAY[30,15,7,1,0],
        overdue_escalation_days INTEGER[] NOT NULL DEFAULT ARRAY[1,3,7,14],
        legal_case_stages JSONB NOT NULL DEFAULT '["PRE_LITIGATION","NOTICE_ISSUED","REPLY_SUBMITTED","CASE_FILED","ADMISSION","EVIDENCE","ARGUMENTS","ORDER_RESERVED","JUDGEMENT","APPEAL","EXECUTION","SETTLED","CLOSED"]'::jsonb,
        notice_status_transitions JSONB NOT NULL DEFAULT '{"RECEIVED":["ASSIGNED","CLOSED"],"ASSIGNED":["UNDER_REVIEW","CLOSED"],"UNDER_REVIEW":["REPLY_DRAFTING","CLOSED"],"REPLY_DRAFTING":["UNDER_REVIEW","APPROVAL_PENDING"],"APPROVAL_PENDING":["REPLY_DRAFTING","REPLY_SUBMITTED"],"REPLY_SUBMITTED":["CLOSED"],"CLOSED":[]}'::jsonb,
        status_transitions JSONB NOT NULL DEFAULT '{
          "DRAFT":["NOT_STARTED","CANCELLED"],
          "NOT_STARTED":["IN_PROGRESS","ON_HOLD","NOT_APPLICABLE","CANCELLED"],
          "IN_PROGRESS":["AWAITING_DOCUMENTS","AWAITING_EXTERNAL_AUTHORITY","UNDER_REVIEW","APPROVAL_PENDING","SUBMITTED","ON_HOLD"],
          "AWAITING_DOCUMENTS":["IN_PROGRESS","SUBMITTED","ON_HOLD"],
          "AWAITING_EXTERNAL_AUTHORITY":["IN_PROGRESS","SUBMITTED","COMPLETED","ON_HOLD"],
          "UNDER_REVIEW":["APPROVAL_PENDING","SUBMITTED","RETURNED_FOR_CORRECTION","COMPLETED"],
          "APPROVAL_PENDING":["COMPLETED","REJECTED","RETURNED_FOR_CORRECTION"],
          "SUBMITTED":["UNDER_REVIEW","COMPLETED","REJECTED","RETURNED_FOR_CORRECTION"],
          "REJECTED":["IN_PROGRESS","CANCELLED"],
          "RETURNED_FOR_CORRECTION":["IN_PROGRESS","SUBMITTED"],
          "ON_HOLD":["IN_PROGRESS","CANCELLED"],
          "OVERDUE":["IN_PROGRESS","SUBMITTED","COMPLETED","ON_HOLD"]
        }'::jsonb,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE compliance_settings ADD COLUMN IF NOT EXISTS legal_case_stages JSONB NOT NULL DEFAULT '["PRE_LITIGATION","NOTICE_ISSUED","REPLY_SUBMITTED","CASE_FILED","ADMISSION","EVIDENCE","ARGUMENTS","ORDER_RESERVED","JUDGEMENT","APPEAL","EXECUTION","SETTLED","CLOSED"]'::jsonb`);
    await client.query(`ALTER TABLE compliance_settings ADD COLUMN IF NOT EXISTS notice_status_transitions JSONB NOT NULL DEFAULT '{"RECEIVED":["ASSIGNED","CLOSED"],"ASSIGNED":["UNDER_REVIEW","CLOSED"],"UNDER_REVIEW":["REPLY_DRAFTING","CLOSED"],"REPLY_DRAFTING":["UNDER_REVIEW","APPROVAL_PENDING"],"APPROVAL_PENDING":["REPLY_DRAFTING","REPLY_SUBMITTED"],"REPLY_SUBMITTED":["CLOSED"],"CLOSED":[]}'::jsonb`);

    await client.query('COMMIT');
    console.log('Migration 088_compliance_legal_control_centre complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 088 failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

async function rollback() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('088_compliance_legal_control_centre'))`);
    for (const table of [
      'compliance_audit_log',
      'compliance_notification_log',
      'compliance_documents',
      'compliance_inspections',
      'legal_notices',
      'legal_case_timeline',
      'legal_cases',
      'compliance_licences',
      'compliance_finance_links',
      'compliance_approvals',
      'compliance_due_date_changes',
      'compliance_status_history',
      'compliance_checklist_items',
      'compliance_items',
      'compliance_templates',
      'compliance_authorities',
      'compliance_settings',
    ]) {
      await client.query(`DROP TABLE IF EXISTS ${table}`);
    }
    await client.query('COMMIT');
    console.log('Migration 088_compliance_legal_control_centre rolled back');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 088 rollback failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

const action = process.argv.includes('--down') ? rollback : migrate;
action()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
