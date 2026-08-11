import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 098 — Phase 3 construction certification and filing preparation.
 *
 * Forward-only and additive by design:
 *  - construction_projects/tasks and the inventory movement ledger stay canonical;
 *  - vendor commitments/payments and Phase 2 allocations remain monetary truth;
 *  - compliance_documents/compliance_audit_log remain evidence and audit truth;
 *  - certification and filing rows store immutable, source-referenced snapshots.
 *
 * No statutory requirement is seeded here. Filing requirements can only be
 * resolved from an already-versioned Phase 1 ruleset.
 */
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('098_construction_certification_filing'))`);

    // Phase 1 used an INTEGER polymorphic entity key while its regulatory
    // aggregates use BIGSERIAL. Widen in-place before Phase 3 links to those
    // aggregates; this is lossless and preserves the existing evidence store.
    await client.query(`ALTER TABLE compliance_documents ALTER COLUMN entity_id TYPE BIGINT`);
    await client.query(`ALTER TABLE compliance_audit_log ALTER COLUMN entity_id TYPE BIGINT`);

    // ------------------------------------------------------------------
    // Existing construction project: add tenant/RERA/schedule context.
    // Existing start_date/target_end_date remain the legacy current dates.
    // ------------------------------------------------------------------
    await client.query(`
      ALTER TABLE construction_projects
        ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS rera_project_id BIGINT REFERENCES rera_projects(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS rera_project_phase_id BIGINT REFERENCES rera_project_phases(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS scope_type VARCHAR(32) NOT NULL DEFAULT 'GENERAL',
        ADD COLUMN IF NOT EXISTS scope_label VARCHAR(200),
        ADD COLUMN IF NOT EXISTS plan_version VARCHAR(120),
        ADD COLUMN IF NOT EXISTS cost_centre_code VARCHAR(80),
        ADD COLUMN IF NOT EXISTS baseline_start_date DATE,
        ADD COLUMN IF NOT EXISTS baseline_end_date DATE,
        ADD COLUMN IF NOT EXISTS revised_start_date DATE,
        ADD COLUMN IF NOT EXISTS revised_end_date DATE,
        ADD COLUMN IF NOT EXISTS forecast_end_date DATE,
        ADD COLUMN IF NOT EXISTS progress_method VARCHAR(24) NOT NULL DEFAULT 'MANUAL',
        ADD COLUMN IF NOT EXISTS workflow_version INTEGER NOT NULL DEFAULT 1
    `);
    await client.query(`
      UPDATE construction_projects p
         SET organization_id=s.organization_id,
             baseline_start_date=COALESCE(p.baseline_start_date,p.start_date),
             baseline_end_date=COALESCE(p.baseline_end_date,p.target_end_date),
             revised_start_date=COALESCE(p.revised_start_date,p.start_date),
             revised_end_date=COALESCE(p.revised_end_date,p.target_end_date),
             forecast_end_date=COALESCE(p.forecast_end_date,p.target_end_date)
        FROM sites s
       WHERE s.id=p.site_id
         AND (p.organization_id IS NULL OR p.baseline_start_date IS NULL
           OR p.baseline_end_date IS NULL OR p.revised_start_date IS NULL
           OR p.revised_end_date IS NULL OR p.forecast_end_date IS NULL)
    `);
    await client.query(`ALTER TABLE construction_projects ALTER COLUMN organization_id SET NOT NULL`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_construction_project_org_site_id ON construction_projects(organization_id,site_id,id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_project_rera_scope ON construction_projects(organization_id,site_id,rera_project_id,rera_project_phase_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_project_forecast ON construction_projects(site_id,forecast_end_date,status)`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='construction_project_scope_type_chk') THEN
          ALTER TABLE construction_projects ADD CONSTRAINT construction_project_scope_type_chk CHECK (
            scope_type IN ('GENERAL','PLOTTED_INFRASTRUCTURE','BUILDING','TOWER','WING','BLOCK','COMMERCIAL','MIXED_USE')
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='construction_project_progress_method_chk') THEN
          ALTER TABLE construction_projects ADD CONSTRAINT construction_project_progress_method_chk CHECK (
            progress_method IN ('MANUAL','TASK_WEIGHTED','QUANTITY_WEIGHTED')
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='construction_project_schedule_dates_chk') THEN
          ALTER TABLE construction_projects ADD CONSTRAINT construction_project_schedule_dates_chk CHECK (
            (baseline_end_date IS NULL OR baseline_start_date IS NULL OR baseline_end_date>=baseline_start_date)
            AND (revised_end_date IS NULL OR revised_start_date IS NULL OR revised_end_date>=revised_start_date)
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='construction_project_rera_phase_requires_project_chk') THEN
          ALTER TABLE construction_projects ADD CONSTRAINT construction_project_rera_phase_requires_project_chk CHECK (
            rera_project_phase_id IS NULL OR rera_project_id IS NOT NULL
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_construction_project_rera_scope') THEN
          ALTER TABLE construction_projects ADD CONSTRAINT fk_construction_project_rera_scope
            FOREIGN KEY (organization_id,site_id,rera_project_id)
            REFERENCES rera_projects(organization_id,site_id,id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_construction_project_rera_phase_scope') THEN
          ALTER TABLE construction_projects ADD CONSTRAINT fk_construction_project_rera_phase_scope
            FOREIGN KEY (organization_id,site_id,rera_project_id,rera_project_phase_id)
            REFERENCES rera_project_phases(organization_id,site_id,rera_project_id,id) ON DELETE RESTRICT;
        END IF;
      END $$
    `);

    // ------------------------------------------------------------------
    // WBS: work packages are children of the existing construction project.
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS construction_work_packages (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        site_id INTEGER NOT NULL,
        construction_project_id INTEGER NOT NULL,
        rera_project_id BIGINT,
        rera_project_phase_id BIGINT,
        parent_work_package_id BIGINT,
        code VARCHAR(80) NOT NULL,
        name VARCHAR(300) NOT NULL CHECK (BTRIM(name)<>''),
        category VARCHAR(100),
        scope_type VARCHAR(32) NOT NULL DEFAULT 'GENERAL',
        scope_label VARCHAR(200),
        building_or_block VARCHAR(160),
        infrastructure_package VARCHAR(160),
        plan_version VARCHAR(120),
        cost_centre_code VARCHAR(80),
        approved_budget NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (approved_budget>=0),
        baseline_start_date DATE,
        baseline_end_date DATE,
        revised_start_date DATE,
        revised_end_date DATE,
        forecast_end_date DATE,
        actual_start_date DATE,
        actual_end_date DATE,
        owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        contractor_stakeholder_id BIGINT REFERENCES rera_stakeholders(id) ON DELETE SET NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'PLANNING',
        progress_method VARCHAR(24) NOT NULL DEFAULT 'MANUAL',
        operational_progress_pct NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (operational_progress_pct BETWEEN 0 AND 100),
        weight NUMERIC(9,6) CHECK (weight IS NULL OR (weight>0 AND weight<=100)),
        next_action TEXT,
        next_action_owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        next_action_due_date DATE,
        notes TEXT,
        workflow_version INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT fk_construction_work_package_project FOREIGN KEY (organization_id,site_id,construction_project_id)
          REFERENCES construction_projects(organization_id,site_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_construction_work_package_rera_project FOREIGN KEY (organization_id,site_id,rera_project_id)
          REFERENCES rera_projects(organization_id,site_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_construction_work_package_rera_phase FOREIGN KEY (organization_id,site_id,rera_project_id,rera_project_phase_id)
          REFERENCES rera_project_phases(organization_id,site_id,rera_project_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_construction_work_package_parent FOREIGN KEY (parent_work_package_id)
          REFERENCES construction_work_packages(id) ON DELETE RESTRICT,
        CONSTRAINT construction_work_package_status_chk CHECK (
          status IN ('PLANNING','ON_TRACK','AT_RISK','DELAYED','BLOCKED','COMPLETED','CANCELLED')
        ),
        CONSTRAINT construction_work_package_progress_method_chk CHECK (
          progress_method IN ('MANUAL','TASK_WEIGHTED','QUANTITY_WEIGHTED')
        ),
        CONSTRAINT construction_work_package_scope_chk CHECK (
          scope_type IN ('GENERAL','INFRASTRUCTURE','ROAD','DRAINAGE','ELECTRICAL','WATER','PARK','BOUNDARY','BUILDING','TOWER','WING','BLOCK','FLOOR','COMMERCIAL','OTHER')
        ),
        CONSTRAINT construction_work_package_dates_chk CHECK (
          (baseline_end_date IS NULL OR baseline_start_date IS NULL OR baseline_end_date>=baseline_start_date)
          AND (revised_end_date IS NULL OR revised_start_date IS NULL OR revised_end_date>=revised_start_date)
          AND (actual_end_date IS NULL OR actual_start_date IS NULL OR actual_end_date>=actual_start_date)
        )
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_construction_work_package_code ON construction_work_packages(construction_project_id,UPPER(code)) WHERE deleted_at IS NULL`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_construction_work_package_scope_id ON construction_work_packages(organization_id,site_id,construction_project_id,id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_work_package_workspace ON construction_work_packages(site_id,status,forecast_end_date,id) WHERE deleted_at IS NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_work_package_rera ON construction_work_packages(organization_id,rera_project_id,rera_project_phase_id) WHERE deleted_at IS NULL`);

    // Existing tasks remain valid with no work package; new tasks may be scoped.
    await client.query(`
      ALTER TABLE construction_tasks
        ADD COLUMN IF NOT EXISTS work_package_id BIGINT REFERENCES construction_work_packages(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS contractor_stakeholder_id BIGINT REFERENCES rera_stakeholders(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS baseline_start_date DATE,
        ADD COLUMN IF NOT EXISTS baseline_end_date DATE,
        ADD COLUMN IF NOT EXISTS revised_start_date DATE,
        ADD COLUMN IF NOT EXISTS revised_end_date DATE,
        ADD COLUMN IF NOT EXISTS forecast_end_date DATE,
        ADD COLUMN IF NOT EXISTS actual_start_date DATE,
        ADD COLUMN IF NOT EXISTS actual_end_date DATE,
        ADD COLUMN IF NOT EXISTS baseline_duration_days INTEGER,
        ADD COLUMN IF NOT EXISTS progress_method VARCHAR(24) NOT NULL DEFAULT 'MANUAL',
        ADD COLUMN IF NOT EXISTS weight NUMERIC(9,6),
        ADD COLUMN IF NOT EXISTS planned_quantity NUMERIC(18,4),
        ADD COLUMN IF NOT EXISTS completed_quantity NUMERIC(18,4),
        ADD COLUMN IF NOT EXISTS quantity_unit VARCHAR(40),
        ADD COLUMN IF NOT EXISTS blocker TEXT,
        ADD COLUMN IF NOT EXISTS workflow_version INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ
    `);
    await client.query(`
      UPDATE construction_tasks
         SET baseline_start_date=COALESCE(baseline_start_date,start_date),
             baseline_end_date=COALESCE(baseline_end_date,due_date),
             revised_start_date=COALESCE(revised_start_date,start_date),
             revised_end_date=COALESCE(revised_end_date,due_date),
             forecast_end_date=COALESCE(forecast_end_date,due_date)
       WHERE baseline_start_date IS NULL OR baseline_end_date IS NULL
          OR revised_start_date IS NULL OR revised_end_date IS NULL OR forecast_end_date IS NULL
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_tasks_work_package ON construction_tasks(work_package_id,sequence,id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_tasks_assignee_due ON construction_tasks(assignee_id,forecast_end_date,status)`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='construction_task_progress_method_chk') THEN
          ALTER TABLE construction_tasks ADD CONSTRAINT construction_task_progress_method_chk CHECK (
            progress_method IN ('MANUAL','QUANTITY')
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='construction_task_weight_chk') THEN
          ALTER TABLE construction_tasks ADD CONSTRAINT construction_task_weight_chk CHECK (
            weight IS NULL OR (weight>0 AND weight<=100)
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='construction_task_quantity_chk') THEN
          ALTER TABLE construction_tasks ADD CONSTRAINT construction_task_quantity_chk CHECK (
            planned_quantity IS NULL OR (planned_quantity>0 AND COALESCE(completed_quantity,0)>=0)
          );
        END IF;
      END $$
    `);

    // Reuse inventory/procurement/finance truth by adding relationship columns.
    await client.query(`ALTER TABLE construction_material_requests ADD COLUMN IF NOT EXISTS work_package_id BIGINT REFERENCES construction_work_packages(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS work_package_id BIGINT REFERENCES construction_work_packages(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE project_transaction_allocations ADD COLUMN IF NOT EXISTS construction_project_id INTEGER REFERENCES construction_projects(id) ON DELETE SET NULL, ADD COLUMN IF NOT EXISTS construction_work_package_id BIGINT REFERENCES construction_work_packages(id) ON DELETE SET NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_movement_work_package ON inventory_movements(work_package_id,created_at DESC) WHERE work_package_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_project_allocation_work_package ON project_transaction_allocations(construction_work_package_id,created_at DESC) WHERE construction_work_package_id IS NOT NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS construction_work_package_commitments (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        site_id INTEGER NOT NULL,
        construction_project_id INTEGER NOT NULL REFERENCES construction_projects(id) ON DELETE RESTRICT,
        work_package_id BIGINT NOT NULL REFERENCES construction_work_packages(id) ON DELETE RESTRICT,
        vendor_commitment_id INTEGER NOT NULL REFERENCES vendor_commitments(id) ON DELETE RESTRICT,
        allocation_amount NUMERIC(15,2),
        notes TEXT,
        linked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT construction_commitment_amount_chk CHECK (allocation_amount IS NULL OR allocation_amount>=0),
        CONSTRAINT fk_construction_commitment_project_scope FOREIGN KEY (organization_id,site_id,construction_project_id)
          REFERENCES construction_projects(organization_id,site_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_construction_commitment_package_scope FOREIGN KEY (organization_id,site_id,construction_project_id,work_package_id)
          REFERENCES construction_work_packages(organization_id,site_id,construction_project_id,id) ON DELETE RESTRICT,
        UNIQUE (work_package_id,vendor_commitment_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_commitment_package ON construction_work_package_commitments(work_package_id,vendor_commitment_id)`);

    // ------------------------------------------------------------------
    // Immutable schedule/progress/daily operational history.
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS construction_schedule_revisions (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        construction_project_id INTEGER NOT NULL REFERENCES construction_projects(id) ON DELETE RESTRICT,
        work_package_id BIGINT REFERENCES construction_work_packages(id) ON DELETE RESTRICT,
        task_id INTEGER REFERENCES construction_tasks(id) ON DELETE RESTRICT,
        entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN ('PROJECT','WORK_PACKAGE','TASK')),
        previous_start_date DATE,
        previous_end_date DATE,
        new_start_date DATE,
        new_end_date DATE,
        revision_kind VARCHAR(20) NOT NULL DEFAULT 'REVISED' CHECK (revision_kind IN ('REVISED','FORECAST')),
        reason TEXT NOT NULL CHECK (BTRIM(reason)<>''),
        delay_cause VARCHAR(160),
        requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approval_status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (approval_status IN ('PENDING','APPROVED','REJECTED')),
        effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_construction_schedule_project_scope FOREIGN KEY (organization_id,site_id,construction_project_id)
          REFERENCES construction_projects(organization_id,site_id,id) ON DELETE RESTRICT
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_schedule_history ON construction_schedule_revisions(construction_project_id,work_package_id,task_id,created_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS construction_progress_updates (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        construction_project_id INTEGER NOT NULL REFERENCES construction_projects(id) ON DELETE RESTRICT,
        work_package_id BIGINT REFERENCES construction_work_packages(id) ON DELETE RESTRICT,
        task_id INTEGER REFERENCES construction_tasks(id) ON DELETE RESTRICT,
        source_type VARCHAR(24) NOT NULL CHECK (source_type IN ('DAILY_UPDATE','TASK_STATUS','QUANTITY','WEIGHTED_CALCULATION','MANUAL_OVERRIDE')),
        previous_progress_pct NUMERIC(7,4) NOT NULL CHECK (previous_progress_pct BETWEEN 0 AND 100),
        new_progress_pct NUMERIC(7,4) NOT NULL CHECK (new_progress_pct BETWEEN 0 AND 100),
        reason TEXT NOT NULL CHECK (BTRIM(reason)<>''),
        evidence_required BOOLEAN NOT NULL DEFAULT FALSE,
        approval_status VARCHAR(20) NOT NULL DEFAULT 'NOT_REQUIRED' CHECK (approval_status IN ('NOT_REQUIRED','PENDING','APPROVED','REJECTED')),
        approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_construction_progress_project_scope FOREIGN KEY (organization_id,site_id,construction_project_id)
          REFERENCES construction_projects(organization_id,site_id,id) ON DELETE RESTRICT
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_progress_history ON construction_progress_updates(construction_project_id,work_package_id,task_id,created_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS construction_daily_updates (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        construction_project_id INTEGER NOT NULL REFERENCES construction_projects(id) ON DELETE RESTRICT,
        rera_project_id BIGINT REFERENCES rera_projects(id) ON DELETE RESTRICT,
        rera_project_phase_id BIGINT REFERENCES rera_project_phases(id) ON DELETE RESTRICT,
        work_package_id BIGINT REFERENCES construction_work_packages(id) ON DELETE RESTRICT,
        task_id INTEGER REFERENCES construction_tasks(id) ON DELETE RESTRICT,
        update_date DATE NOT NULL,
        previous_progress_pct NUMERIC(7,4),
        new_progress_pct NUMERIC(7,4),
        manpower JSONB NOT NULL DEFAULT '{}'::jsonb,
        work_completed TEXT NOT NULL CHECK (BTRIM(work_completed)<>''),
        work_planned TEXT,
        blocker TEXT,
        weather JSONB NOT NULL DEFAULT '{}'::jsonb,
        remarks TEXT,
        responsible_engineer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        review_status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (review_status IN ('PENDING','ACCEPTED','REJECTED')),
        review_reason TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_construction_daily_project_scope FOREIGN KEY (organization_id,site_id,construction_project_id)
          REFERENCES construction_projects(organization_id,site_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_construction_daily_rera_scope FOREIGN KEY (organization_id,site_id,rera_project_id)
          REFERENCES rera_projects(organization_id,site_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_construction_daily_rera_phase_scope FOREIGN KEY (organization_id,site_id,rera_project_id,rera_project_phase_id)
          REFERENCES rera_project_phases(organization_id,site_id,rera_project_id,id) ON DELETE RESTRICT,
        CONSTRAINT construction_daily_progress_chk CHECK (
          (previous_progress_pct IS NULL OR previous_progress_pct BETWEEN 0 AND 100)
          AND (new_progress_pct IS NULL OR new_progress_pct BETWEEN 0 AND 100)
        )
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_daily_workspace ON construction_daily_updates(site_id,construction_project_id,update_date DESC,id DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_daily_package ON construction_daily_updates(work_package_id,update_date DESC,id DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS construction_daily_update_materials (
        daily_update_id BIGINT NOT NULL REFERENCES construction_daily_updates(id) ON DELETE RESTRICT,
        inventory_movement_id INTEGER NOT NULL REFERENCES inventory_movements(id) ON DELETE RESTRICT,
        PRIMARY KEY (daily_update_id,inventory_movement_id)
      )
    `);

    // ------------------------------------------------------------------
    // Cost forecast inputs are append-only snapshots; accounting stays external.
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS construction_cost_forecasts (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        construction_project_id INTEGER NOT NULL REFERENCES construction_projects(id) ON DELETE RESTRICT,
        work_package_id BIGINT REFERENCES construction_work_packages(id) ON DELETE RESTRICT,
        as_of_date DATE NOT NULL,
        estimated_additional_cost NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (estimated_additional_cost>=0),
        methodology VARCHAR(32) NOT NULL DEFAULT 'MANUAL_ESTIMATE' CHECK (methodology IN ('MANUAL_ESTIMATE','DETERMINISTIC_REMAINING')),
        reason TEXT NOT NULL CHECK (BTRIM(reason)<>''),
        source_references JSONB NOT NULL DEFAULT '[]'::jsonb,
        supersedes_forecast_id BIGINT REFERENCES construction_cost_forecasts(id) ON DELETE RESTRICT,
        approval_status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (approval_status IN ('PENDING','APPROVED','REJECTED','SUPERSEDED')),
        approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approved_at TIMESTAMPTZ,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_construction_forecast_project_scope FOREIGN KEY (organization_id,site_id,construction_project_id)
          REFERENCES construction_projects(organization_id,site_id,id) ON DELETE RESTRICT
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_construction_cost_forecast_superseded ON construction_cost_forecasts(supersedes_forecast_id) WHERE supersedes_forecast_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_cost_forecast_scope ON construction_cost_forecasts(construction_project_id,work_package_id,as_of_date DESC,id DESC)`);

    // ------------------------------------------------------------------
    // Certified progress: immutable finalized snapshot, separate from operations.
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS construction_certifications (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        construction_project_id INTEGER NOT NULL REFERENCES construction_projects(id) ON DELETE RESTRICT,
        rera_project_id BIGINT NOT NULL REFERENCES rera_projects(id) ON DELETE RESTRICT,
        rera_project_phase_id BIGINT REFERENCES rera_project_phases(id) ON DELETE RESTRICT,
        work_package_id BIGINT REFERENCES construction_work_packages(id) ON DELETE RESTRICT,
        certification_period_start DATE NOT NULL,
        certification_period_end DATE NOT NULL,
        operational_progress_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        operational_progress_pct NUMERIC(7,4) NOT NULL CHECK (operational_progress_pct BETWEEN 0 AND 100),
        proposed_certified_progress_pct NUMERIC(7,4) NOT NULL CHECK (proposed_certified_progress_pct BETWEEN 0 AND 100),
        certified_progress_pct NUMERIC(7,4) CHECK (certified_progress_pct BETWEEN 0 AND 100),
        cost_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        input_data_references JSONB NOT NULL DEFAULT '[]'::jsonb,
        professional_stakeholder_id BIGINT NOT NULL REFERENCES rera_stakeholders(id) ON DELETE RESTRICT,
        professional_type VARCHAR(32) NOT NULL CHECK (professional_type IN ('ENGINEER','ARCHITECT','CHARTERED_ACCOUNTANT','OTHER')),
        certification_date DATE,
        status VARCHAR(28) NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
          'DRAFT','EVIDENCE_PREPARATION','PROFESSIONAL_REVIEW','INTERNAL_REVIEW',
          'CERTIFIED','APPROVED','REJECTED','REVISION_REQUIRED','SUPERSEDED'
        )),
        exceptions JSONB NOT NULL DEFAULT '[]'::jsonb,
        review_notes TEXT,
        idempotency_key VARCHAR(120),
        supersedes_certification_id BIGINT REFERENCES construction_certifications(id) ON DELETE RESTRICT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        finalized_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        finalized_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_construction_certification_project_scope FOREIGN KEY (organization_id,site_id,construction_project_id)
          REFERENCES construction_projects(organization_id,site_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_construction_certification_rera_scope FOREIGN KEY (organization_id,site_id,rera_project_id)
          REFERENCES rera_projects(organization_id,site_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_construction_certification_rera_phase_scope FOREIGN KEY (organization_id,site_id,rera_project_id,rera_project_phase_id)
          REFERENCES rera_project_phases(organization_id,site_id,rera_project_id,id) ON DELETE RESTRICT,
        CONSTRAINT construction_certification_period_chk CHECK (certification_period_end>=certification_period_start),
        CONSTRAINT construction_certification_final_chk CHECK (
          status NOT IN ('CERTIFIED','APPROVED') OR (
            certified_progress_pct IS NOT NULL AND certification_date IS NOT NULL
            AND finalized_by IS NOT NULL AND finalized_at IS NOT NULL
          )
        )
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_construction_certification_idempotency ON construction_certifications(organization_id,site_id,idempotency_key) WHERE idempotency_key IS NOT NULL`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_construction_certification_correction ON construction_certifications(supersedes_certification_id) WHERE supersedes_certification_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_certification_workspace ON construction_certifications(site_id,rera_project_id,rera_project_phase_id,status,certification_period_end DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_certification_package ON construction_certifications(work_package_id,status,certification_period_end DESC) WHERE work_package_id IS NOT NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS construction_certification_evidence (
        certification_id BIGINT NOT NULL REFERENCES construction_certifications(id) ON DELETE RESTRICT,
        compliance_document_id BIGINT NOT NULL REFERENCES compliance_documents(id) ON DELETE RESTRICT,
        evidence_role VARCHAR(80),
        linked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (certification_id,compliance_document_id)
      )
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION protect_final_construction_certification()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='DELETE' AND OLD.status IN ('CERTIFIED','APPROVED','SUPERSEDED') THEN
          RAISE EXCEPTION 'Finalized certification snapshots cannot be deleted';
        END IF;
        IF TG_OP='DELETE' THEN
          RETURN OLD;
        END IF;
        IF OLD.status IN ('CERTIFIED','APPROVED') THEN
          IF NEW.status IN ('APPROVED','SUPERSEDED')
             AND NEW.operational_progress_snapshot=OLD.operational_progress_snapshot
             AND NEW.certified_progress_pct IS NOT DISTINCT FROM OLD.certified_progress_pct
             AND NEW.cost_snapshot=OLD.cost_snapshot
             AND NEW.input_data_references=OLD.input_data_references
             AND NEW.professional_stakeholder_id=OLD.professional_stakeholder_id
             AND NEW.certification_date=OLD.certification_date THEN
            RETURN NEW;
          END IF;
          RAISE EXCEPTION 'Finalized certification snapshots are immutable; create a correction';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_protect_final_construction_certification ON construction_certifications`);
    await client.query(`CREATE TRIGGER trg_protect_final_construction_certification BEFORE UPDATE OR DELETE ON construction_certifications FOR EACH ROW EXECUTE FUNCTION protect_final_construction_certification()`);

    await client.query(`
      CREATE OR REPLACE FUNCTION protect_final_construction_certification_evidence()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE v_status VARCHAR(28);
      BEGIN
        SELECT status INTO v_status
          FROM construction_certifications
         WHERE id=COALESCE(NEW.certification_id,OLD.certification_id);
        IF v_status IN ('CERTIFIED','APPROVED','SUPERSEDED') THEN
          RAISE EXCEPTION 'Evidence links on finalized certifications are immutable';
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_protect_final_construction_certification_evidence ON construction_certification_evidence`);
    await client.query(`CREATE TRIGGER trg_protect_final_construction_certification_evidence BEFORE INSERT OR UPDATE OR DELETE ON construction_certification_evidence FOR EACH ROW EXECUTE FUNCTION protect_final_construction_certification_evidence()`);

    // ------------------------------------------------------------------
    // Factual risks.
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS construction_risks (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        construction_project_id INTEGER NOT NULL REFERENCES construction_projects(id) ON DELETE RESTRICT,
        work_package_id BIGINT REFERENCES construction_work_packages(id) ON DELETE RESTRICT,
        risk_type VARCHAR(40) NOT NULL,
        description TEXT NOT NULL CHECK (BTRIM(description)<>''),
        impact TEXT,
        severity VARCHAR(16) NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
        owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        due_date DATE,
        resolution TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED','ACCEPTED','CANCELLED')),
        source_references JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        ,CONSTRAINT fk_construction_risk_project_scope FOREIGN KEY (organization_id,site_id,construction_project_id)
          REFERENCES construction_projects(organization_id,site_id,id) ON DELETE RESTRICT
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_risks_open ON construction_risks(site_id,construction_project_id,severity,due_date) WHERE status IN ('OPEN','IN_PROGRESS')`);

    // ------------------------------------------------------------------
    // Ruleset-driven filing periods, reconciliation, immutable snapshots.
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_filing_periods (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        site_id INTEGER NOT NULL,
        rera_project_id BIGINT NOT NULL,
        rera_project_phase_id BIGINT,
        ruleset_version_id BIGINT NOT NULL REFERENCES rera_ruleset_versions(id) ON DELETE RESTRICT,
        filing_type VARCHAR(100) NOT NULL CHECK (BTRIM(filing_type)<>''),
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        due_date DATE,
        status VARCHAR(28) NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
          'DRAFT','DATA_RECONCILIATION','EVIDENCE_PENDING','REVIEW','READY',
          'SUBMITTED','ACCEPTED','REJECTED','RESUBMISSION_REQUIRED','SUPERSEDED'
        )),
        requirements_resolution_status VARCHAR(28) NOT NULL DEFAULT 'INCOMPLETE' CHECK (
          requirements_resolution_status IN ('INCOMPLETE','UNREVIEWED','RESOLVED')
        ),
        prepared_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        submission_date DATE,
        acknowledgement_number VARCHAR(200),
        idempotency_key VARCHAR(120),
        workflow_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_rera_filing_project FOREIGN KEY (organization_id,site_id,rera_project_id)
          REFERENCES rera_projects(organization_id,site_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_rera_filing_phase FOREIGN KEY (organization_id,site_id,rera_project_id,rera_project_phase_id)
          REFERENCES rera_project_phases(organization_id,site_id,rera_project_id,id) ON DELETE RESTRICT,
        CONSTRAINT rera_filing_period_dates_chk CHECK (period_end>=period_start)
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_filing_period_scope ON rera_filing_periods(rera_project_id,COALESCE(rera_project_phase_id,0),UPPER(filing_type),period_start,period_end)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_filing_idempotency ON rera_filing_periods(organization_id,site_id,idempotency_key) WHERE idempotency_key IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rera_filing_workspace ON rera_filing_periods(site_id,rera_project_id,status,due_date,id DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_filing_requirements (
        id BIGSERIAL PRIMARY KEY,
        filing_period_id BIGINT NOT NULL REFERENCES rera_filing_periods(id) ON DELETE RESTRICT,
        ruleset_requirement_id BIGINT REFERENCES rera_ruleset_requirements(id) ON DELETE RESTRICT,
        requirement_code VARCHAR(100) NOT NULL,
        requirement_kind VARCHAR(32) NOT NULL,
        title VARCHAR(300) NOT NULL,
        is_mandatory BOOLEAN NOT NULL DEFAULT FALSE,
        is_blocking BOOLEAN NOT NULL DEFAULT FALSE,
        source_review_status VARCHAR(24) NOT NULL,
        requirement_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        status VARCHAR(24) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETE','ATTENTION','MISSING','NOT_APPLICABLE','REVIEW_REQUIRED')),
        owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        resolution_notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (filing_period_id,requirement_code)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rera_filing_requirement_status ON rera_filing_requirements(filing_period_id,status,is_blocking)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_filing_reconciliation_results (
        id BIGSERIAL PRIMARY KEY,
        filing_period_id BIGINT NOT NULL REFERENCES rera_filing_periods(id) ON DELETE RESTRICT,
        run_key VARCHAR(120) NOT NULL,
        check_code VARCHAR(100) NOT NULL,
        section VARCHAR(80) NOT NULL,
        status VARCHAR(24) NOT NULL CHECK (status IN ('PASS','WARNING','ERROR','NOT_APPLICABLE','REVIEW_REQUIRED')),
        reason TEXT NOT NULL,
        expected_value JSONB,
        actual_value JSONB,
        difference_value JSONB,
        source_records JSONB NOT NULL DEFAULT '[]'::jsonb,
        rule_reference JSONB,
        owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        resolution_action TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (filing_period_id,run_key,check_code)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rera_filing_reconciliation_latest ON rera_filing_reconciliation_results(filing_period_id,created_at DESC,run_key)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_filing_snapshots (
        id BIGSERIAL PRIMARY KEY,
        filing_period_id BIGINT NOT NULL REFERENCES rera_filing_periods(id) ON DELETE RESTRICT,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        ruleset_version_id BIGINT NOT NULL REFERENCES rera_ruleset_versions(id) ON DELETE RESTRICT,
        snapshot_kind VARCHAR(24) NOT NULL CHECK (snapshot_kind IN ('REVIEW','READY','SUBMITTED')),
        generated_values JSONB NOT NULL,
        source_record_references JSONB NOT NULL,
        evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        certification_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        reconciliation_run_key VARCHAR(120),
        blocking_issue_count INTEGER NOT NULL DEFAULT 0 CHECK (blocking_issue_count>=0),
        idempotency_key VARCHAR(120),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_filing_snapshot_idempotency ON rera_filing_snapshots(filing_period_id,idempotency_key) WHERE idempotency_key IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rera_filing_snapshot_period ON rera_filing_snapshots(filing_period_id,created_at DESC,id DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_filing_submissions (
        id BIGSERIAL PRIMARY KEY,
        filing_period_id BIGINT NOT NULL REFERENCES rera_filing_periods(id) ON DELETE RESTRICT,
        filing_snapshot_id BIGINT NOT NULL REFERENCES rera_filing_snapshots(id) ON DELETE RESTRICT,
        submission_reference VARCHAR(240) NOT NULL,
        submission_date DATE NOT NULL,
        portal_or_authority VARCHAR(300) NOT NULL,
        acknowledgement_number VARCHAR(240),
        acknowledgement_document_id BIGINT REFERENCES compliance_documents(id) ON DELETE RESTRICT,
        remarks TEXT,
        idempotency_key VARCHAR(120),
        submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_filing_submission_idempotency ON rera_filing_submissions(filing_period_id,idempotency_key) WHERE idempotency_key IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rera_filing_submission_period ON rera_filing_submissions(filing_period_id,created_at DESC)`);

    await client.query(`
      CREATE OR REPLACE FUNCTION protect_rera_filing_snapshot()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Filing snapshots are immutable';
      END;
      $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_protect_rera_filing_snapshot ON rera_filing_snapshots`);
    await client.query(`CREATE TRIGGER trg_protect_rera_filing_snapshot BEFORE UPDATE OR DELETE ON rera_filing_snapshots FOR EACH ROW EXECUTE FUNCTION protect_rera_filing_snapshot()`);
    await client.query(`DROP TRIGGER IF EXISTS trg_protect_rera_filing_submission ON rera_filing_submissions`);
    await client.query(`CREATE TRIGGER trg_protect_rera_filing_submission BEFORE UPDATE OR DELETE ON rera_filing_submissions FOR EACH ROW EXECUTE FUNCTION protect_rera_filing_snapshot()`);

    // ------------------------------------------------------------------
    // Controlled amendments and extension preparation. No legal advice or
    // government submission automation is encoded.
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_project_change_requests (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        rera_project_id BIGINT NOT NULL REFERENCES rera_projects(id) ON DELETE RESTRICT,
        rera_project_phase_id BIGINT REFERENCES rera_project_phases(id) ON DELETE RESTRICT,
        ruleset_version_id BIGINT NOT NULL REFERENCES rera_ruleset_versions(id) ON DELETE RESTRICT,
        change_type VARCHAR(60) NOT NULL,
        old_value JSONB NOT NULL,
        proposed_value JSONB NOT NULL,
        reason TEXT NOT NULL CHECK (BTRIM(reason)<>''),
        impact_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
        affected_record_references JSONB NOT NULL DEFAULT '[]'::jsonb,
        required_evidence_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        required_approval_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        ruleset_impact JSONB NOT NULL DEFAULT '{}'::jsonb,
        status VARCHAR(28) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','EVIDENCE_PENDING','UNDER_REVIEW','READY','SUBMITTED','APPROVED','REJECTED','REVISION_REQUIRED','SUPERSEDED')),
        requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMPTZ,
        submission_reference VARCHAR(240),
        authority_decision_evidence_id BIGINT REFERENCES compliance_documents(id) ON DELETE RESTRICT,
        idempotency_key VARCHAR(120),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        ,CONSTRAINT fk_rera_change_project_scope FOREIGN KEY (organization_id,site_id,rera_project_id)
          REFERENCES rera_projects(organization_id,site_id,id) ON DELETE RESTRICT
        ,CONSTRAINT fk_rera_change_phase_scope FOREIGN KEY (organization_id,site_id,rera_project_id,rera_project_phase_id)
          REFERENCES rera_project_phases(organization_id,site_id,rera_project_id,id) ON DELETE RESTRICT
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_change_idempotency ON rera_project_change_requests(organization_id,site_id,idempotency_key) WHERE idempotency_key IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rera_change_workspace ON rera_project_change_requests(site_id,rera_project_id,status,created_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_project_extensions (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        rera_project_id BIGINT NOT NULL REFERENCES rera_projects(id) ON DELETE RESTRICT,
        rera_project_phase_id BIGINT REFERENCES rera_project_phases(id) ON DELETE RESTRICT,
        ruleset_version_id BIGINT NOT NULL REFERENCES rera_ruleset_versions(id) ON DELETE RESTRICT,
        current_completion_date DATE NOT NULL,
        proposed_completion_date DATE NOT NULL,
        reason TEXT NOT NULL CHECK (BTRIM(reason)<>''),
        delay_causes JSONB NOT NULL DEFAULT '[]'::jsonb,
        progress_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        cost_forecast_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        status VARCHAR(28) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','EVIDENCE_PENDING','UNDER_REVIEW','READY','SUBMITTED','APPROVED','REJECTED','RESUBMISSION_REQUIRED','SUPERSEDED')),
        submission_reference VARCHAR(240),
        authority_decision VARCHAR(40),
        authority_decision_date DATE,
        authority_decision_evidence_id BIGINT REFERENCES compliance_documents(id) ON DELETE RESTRICT,
        requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        idempotency_key VARCHAR(120),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT rera_extension_dates_chk CHECK (proposed_completion_date>current_completion_date),
        CONSTRAINT fk_rera_extension_project_scope FOREIGN KEY (organization_id,site_id,rera_project_id)
          REFERENCES rera_projects(organization_id,site_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_rera_extension_phase_scope FOREIGN KEY (organization_id,site_id,rera_project_id,rera_project_phase_id)
          REFERENCES rera_project_phases(organization_id,site_id,rera_project_id,id) ON DELETE RESTRICT,
        CONSTRAINT rera_extension_approval_evidence_chk CHECK (
          status<>'APPROVED' OR (authority_decision_evidence_id IS NOT NULL AND authority_decision_date IS NOT NULL)
        )
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_extension_idempotency ON rera_project_extensions(organization_id,site_id,idempotency_key) WHERE idempotency_key IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rera_extension_workspace ON rera_project_extensions(site_id,rera_project_id,status,created_at DESC)`);

    await client.query(`
      COMMENT ON TABLE construction_certifications IS
        'Certified progress snapshots. Finalized inputs are immutable and never overwrite operational progress.'
    `);
    await client.query(`
      COMMENT ON TABLE rera_filing_snapshots IS
        'Immutable filing preparation snapshot containing generated values and references to original source records.'
    `);
    await client.query(`
      COMMENT ON TABLE construction_work_package_commitments IS
        'Relationship only. vendor_commitments/vendor_payments remain the monetary source of truth.'
    `);

    await client.query('COMMIT');
    console.log('Migration 098_construction_certification_filing complete');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration 098_construction_certification_filing failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

async function rollback() {
  console.warn('Migration 098 is forward-only; --down made no database changes.');
}

const action = process.argv.includes('--down') ? rollback : migrate;
action().then(() => process.exit(0)).catch(() => process.exit(1));
