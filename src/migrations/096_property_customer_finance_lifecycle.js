import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 096 — Property, customer and finance lifecycle (Phase 2).
 *
 * This is deliberately an in-place extension. `plots`, `bookings`,
 * `plot_payments`, `plot_installments`, `plot_registries`, `documents`,
 * `firm_transactions` and `day_book` remain the operational sources of truth.
 * New tables hold relationships, workflow decisions and allocations only.
 * Legacy rows are never guessed into a RERA project/phase or booking.
 */
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('096_property_customer_finance_lifecycle'))`);

    // Ruleset workflow configuration is separate from presentation/field
    // policy. Empty JSON means "no reviewed control configured" and therefore
    // never invents a statutory threshold.
    await client.query(`
      ALTER TABLE rera_ruleset_versions
        ADD COLUMN IF NOT EXISTS workflow_policy JSONB NOT NULL DEFAULT '{}'::jsonb
    `);
    await client.query(`
      ALTER TABLE site_operating_profile_revisions
        ADD COLUMN IF NOT EXISTS workflow_policy_overrides JSONB NOT NULL DEFAULT '{}'::jsonb
    `);

    await client.query(`
      ALTER TABLE plots
        ADD COLUMN IF NOT EXISTS rera_project_id BIGINT REFERENCES rera_projects(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS rera_project_phase_id BIGINT REFERENCES rera_project_phases(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS project_mapping_status VARCHAR(24) NOT NULL DEFAULT 'REVIEW_REQUIRED',
        ADD COLUMN IF NOT EXISTS plan_layout_version VARCHAR(120),
        ADD COLUMN IF NOT EXISTS approved_area NUMERIC(15,3),
        ADD COLUMN IF NOT EXISTS lifecycle_status VARCHAR(32),
        ADD COLUMN IF NOT EXISTS agreement_status VARCHAR(32),
        ADD COLUMN IF NOT EXISTS financial_status VARCHAR(32),
        ADD COLUMN IF NOT EXISTS registry_status VARCHAR(32),
        ADD COLUMN IF NOT EXISTS possession_status VARCHAR(32),
        ADD COLUMN IF NOT EXISTS lifecycle_version INTEGER NOT NULL DEFAULT 1
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_plots_site_id_id ON plots(site_id,id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_members_site_id_id ON members(site_id,id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plots_project_phase ON plots(site_id,rera_project_id,rera_project_phase_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plots_lifecycle ON plots(site_id,lifecycle_status,status)`);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='plots_project_mapping_status_chk') THEN
          ALTER TABLE plots ADD CONSTRAINT plots_project_mapping_status_chk CHECK (
            project_mapping_status IN ('MAPPED','UNMAPPED','REVIEW_REQUIRED','NOT_APPLICABLE')
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='plots_lifecycle_status_chk') THEN
          ALTER TABLE plots ADD CONSTRAINT plots_lifecycle_status_chk CHECK (
            lifecycle_status IS NULL OR lifecycle_status IN (
              'AVAILABLE','HOLD','BOOKED','ALLOTTED','AGREEMENT_EXECUTED',
              'REGISTRY_PENDING','REGISTRY_COMPLETE','POSSESSION_PENDING','POSSESSED',
              'CANCELLATION_REQUESTED','CANCELLATION_APPROVED','REFUND_PENDING','CANCELLED'
            )
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='plots_approved_area_chk') THEN
          ALTER TABLE plots ADD CONSTRAINT plots_approved_area_chk CHECK (approved_area IS NULL OR approved_area >= 0);
        END IF;
      END $$
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION validate_property_project_mapping()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE v_site_org INTEGER; v_phase_project BIGINT;
      BEGIN
        SELECT organization_id INTO v_site_org FROM sites WHERE id=NEW.site_id;
        IF v_site_org IS NULL THEN RAISE EXCEPTION 'Property Site was not found'; END IF;
        IF NEW.project_mapping_status='MAPPED' AND NEW.rera_project_id IS NULL THEN
          RAISE EXCEPTION 'Mapped property requires a project';
        END IF;
        IF NEW.rera_project_phase_id IS NOT NULL AND NEW.rera_project_id IS NULL THEN
          RAISE EXCEPTION 'Property phase requires a project';
        END IF;
        IF NEW.rera_project_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM rera_projects rp
           WHERE rp.id=NEW.rera_project_id AND rp.site_id=NEW.site_id
             AND rp.organization_id=v_site_org AND rp.deleted_at IS NULL
        ) THEN RAISE EXCEPTION 'Property project is outside the Site or organization'; END IF;
        IF NEW.rera_project_phase_id IS NOT NULL THEN
          SELECT rera_project_id INTO v_phase_project FROM rera_project_phases
           WHERE id=NEW.rera_project_phase_id AND site_id=NEW.site_id
             AND organization_id=v_site_org AND deleted_at IS NULL;
          IF v_phase_project IS NULL OR v_phase_project IS DISTINCT FROM NEW.rera_project_id THEN
            RAISE EXCEPTION 'Property phase does not belong to the selected project';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_validate_property_project_mapping ON plots`);
    await client.query(`
      CREATE TRIGGER trg_validate_property_project_mapping
      BEFORE INSERT OR UPDATE OF site_id,rera_project_id,rera_project_phase_id,project_mapping_status ON plots
      FOR EACH ROW EXECUTE FUNCTION validate_property_project_mapping()
    `);

    // Promote the shared booking record into the lifecycle aggregate while
    // retaining every booking-app column and FK.
    await client.query(`ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check`);
    await client.query(`
      ALTER TABLE bookings
        ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS rera_project_id BIGINT REFERENCES rera_projects(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS rera_project_phase_id BIGINT REFERENCES rera_project_phases(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS operating_profile_revision_id BIGINT REFERENCES site_operating_profile_revisions(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS ruleset_version_id BIGINT REFERENCES rera_ruleset_versions(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS commercial_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS base_price NUMERIC(15,2),
        ADD COLUMN IF NOT EXISTS charges NUMERIC(15,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS final_consideration NUMERIC(15,2),
        ADD COLUMN IF NOT EXISTS price_version VARCHAR(80),
        ADD COLUMN IF NOT EXISTS price_effective_date DATE,
        ADD COLUMN IF NOT EXISTS commercial_approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS agreement_required BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS agreement_status VARCHAR(32) NOT NULL DEFAULT 'NOT_STARTED',
        ADD COLUMN IF NOT EXISTS lifecycle_status VARCHAR(32),
        ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(120),
        ADD COLUMN IF NOT EXISTS confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS workflow_version INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ
    `);
    await client.query(`
      UPDATE bookings b
         SET organization_id=s.organization_id,
             final_consideration=COALESCE(b.final_consideration,b.sale_price),
             lifecycle_status=COALESCE(b.lifecycle_status,
               CASE WHEN b.status='CANCELLED' THEN 'CANCELLED'
                    WHEN b.status='CONFIRMED' THEN 'BOOKED'
                    ELSE 'DRAFT' END)
        FROM sites s
       WHERE s.id=b.site_id
         AND (b.organization_id IS NULL OR b.final_consideration IS NULL OR b.lifecycle_status IS NULL)
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bookings_status_check') THEN
          ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN (
            'DRAFT','KYC_PENDING','KYC_DONE','CONFIRMED','CANCELLATION_REQUESTED',
            'CANCELLATION_APPROVED','REFUND_PENDING','CANCELLED','TRANSFERRED','CLOSED'
          ));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bookings_lifecycle_status_chk') THEN
          ALTER TABLE bookings ADD CONSTRAINT bookings_lifecycle_status_chk CHECK (
            lifecycle_status IS NULL OR lifecycle_status IN (
              'DRAFT','HOLD','BOOKED','ALLOTTED','AGREEMENT_EXECUTED','REGISTRY_PENDING',
              'REGISTRY_COMPLETE','POSSESSION_PENDING','POSSESSED','CANCELLATION_REQUESTED',
              'CANCELLATION_APPROVED','REFUND_PENDING','CANCELLED','TRANSFERRED','CLOSED'
            )
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bookings_agreement_status_chk') THEN
          ALTER TABLE bookings ADD CONSTRAINT bookings_agreement_status_chk CHECK (agreement_status IN (
            'NOT_STARTED','DRAFT','PREPARED','UNDER_REVIEW','APPROVED_FOR_EXECUTION',
            'EXECUTED','SUPERSEDED','CANCELLED'
          ));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bookings_commercial_money_chk') THEN
          ALTER TABLE bookings ADD CONSTRAINT bookings_commercial_money_chk CHECK (
            COALESCE(base_price,0) >= 0 AND charges >= 0 AND discount_amount >= 0
            AND COALESCE(final_consideration,sale_price,0) >= 0
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_bookings_org_site') THEN
          ALTER TABLE bookings ADD CONSTRAINT fk_bookings_org_site
            FOREIGN KEY (organization_id,site_id) REFERENCES sites(organization_id,id) ON DELETE RESTRICT;
        END IF;
      END $$
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_site_id_id ON bookings(site_id,id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_org_site_id ON bookings(organization_id,site_id,id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_idempotency ON bookings(organization_id,site_id,idempotency_key) WHERE idempotency_key IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_workspace ON bookings(site_id,lifecycle_status,updated_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_project_phase ON bookings(site_id,rera_project_id,rera_project_phase_id)`);
    // A partial unique index is added only when legacy data has no conflicts.
    // The trigger below remains authoritative on every database.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='uq_bookings_one_active_plot')
           AND NOT EXISTS (
             SELECT plot_id FROM bookings
              WHERE plot_id IS NOT NULL
                AND COALESCE(lifecycle_status,'DRAFT') NOT IN ('CANCELLED','TRANSFERRED','CLOSED')
              GROUP BY plot_id HAVING COUNT(*) > 1
           ) THEN
          CREATE UNIQUE INDEX uq_bookings_one_active_plot ON bookings(plot_id)
            WHERE plot_id IS NOT NULL
              AND COALESCE(lifecycle_status,'DRAFT') NOT IN ('CANCELLED','TRANSFERRED','CLOSED');
        END IF;
      END $$
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION validate_property_booking_scope()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE v_site_org INTEGER; v_plot_site INTEGER; v_project_phase BIGINT;
              v_project_profile BIGINT; v_project_ruleset BIGINT;
      BEGIN
        SELECT organization_id INTO v_site_org FROM sites WHERE id=NEW.site_id;
        IF v_site_org IS NULL THEN
          RAISE EXCEPTION 'Booking Site was not found';
        END IF;
        IF NEW.organization_id IS NULL THEN
          NEW.organization_id := v_site_org;
        ELSIF NEW.organization_id IS DISTINCT FROM v_site_org THEN
          RAISE EXCEPTION 'Booking organization and Site do not match';
        END IF;
        IF NEW.plot_id IS NOT NULL THEN
          SELECT site_id INTO v_plot_site FROM plots WHERE id=NEW.plot_id;
          IF v_plot_site IS DISTINCT FROM NEW.site_id THEN RAISE EXCEPTION 'Booking property is outside the Site'; END IF;
        END IF;
        IF NEW.client_member_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM members WHERE id=NEW.client_member_id AND site_id=NEW.site_id
        ) THEN RAISE EXCEPTION 'Primary allottee is outside the booking Site'; END IF;
        IF NEW.rera_project_id IS NOT NULL THEN
          SELECT p.operating_profile_revision_id,p.ruleset_version_id
            INTO v_project_profile,v_project_ruleset
            FROM rera_projects p WHERE p.id=NEW.rera_project_id
             AND p.organization_id=NEW.organization_id AND p.site_id=NEW.site_id AND p.deleted_at IS NULL;
          IF v_project_profile IS NULL THEN RAISE EXCEPTION 'Booking project is outside the Site or organization'; END IF;
          IF NEW.operating_profile_revision_id IS DISTINCT FROM v_project_profile
             OR NEW.ruleset_version_id IS DISTINCT FROM v_project_ruleset THEN
            RAISE EXCEPTION 'Booking profile and ruleset must match the project snapshot';
          END IF;
        END IF;
        IF NEW.rera_project_phase_id IS NOT NULL THEN
          SELECT rera_project_id INTO v_project_phase FROM rera_project_phases
           WHERE id=NEW.rera_project_phase_id AND organization_id=NEW.organization_id
             AND site_id=NEW.site_id AND deleted_at IS NULL;
          IF v_project_phase IS NULL OR v_project_phase IS DISTINCT FROM NEW.rera_project_id THEN
            RAISE EXCEPTION 'Booking phase does not belong to the selected project';
          END IF;
        END IF;
        IF NEW.plot_id IS NOT NULL
           AND COALESCE(NEW.lifecycle_status,'DRAFT') NOT IN ('CANCELLED','TRANSFERRED','CLOSED')
           AND EXISTS (
             SELECT 1 FROM bookings b WHERE b.plot_id=NEW.plot_id AND b.id<>COALESCE(NEW.id,-1)
               AND COALESCE(b.lifecycle_status,'DRAFT') NOT IN ('CANCELLED','TRANSFERRED','CLOSED')
           ) THEN RAISE EXCEPTION 'Property already has an active booking' USING ERRCODE='unique_violation'; END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_validate_property_booking_scope ON bookings`);
    await client.query(`
      CREATE TRIGGER trg_validate_property_booking_scope
      BEFORE INSERT OR UPDATE OF organization_id,site_id,plot_id,client_member_id,
        rera_project_id,rera_project_phase_id,operating_profile_revision_id,ruleset_version_id,lifecycle_status ON bookings
      FOR EACH ROW EXECUTE FUNCTION validate_property_booking_scope()
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS booking_allottees (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL,
        booking_id INTEGER NOT NULL,
        member_id INTEGER NOT NULL,
        allottee_role VARCHAR(20) NOT NULL CHECK (allottee_role IN ('PRIMARY','JOINT')),
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FORMER','REMOVED')),
        effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
        effective_to DATE,
        relationship_notes TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_booking_allottee_booking FOREIGN KEY (organization_id,site_id,booking_id)
          REFERENCES bookings(organization_id,site_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_booking_allottee_member FOREIGN KEY (site_id,member_id)
          REFERENCES members(site_id,id) ON DELETE RESTRICT,
        CONSTRAINT booking_allottee_dates_chk CHECK (effective_to IS NULL OR effective_to>=effective_from),
        UNIQUE (booking_id,member_id,effective_from)
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_primary_allottee ON booking_allottees(booking_id) WHERE allottee_role='PRIMARY' AND status='ACTIVE'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_booking_allottee_member ON booking_allottees(site_id,member_id,status)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS booking_agreements (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL,
        booking_id INTEGER NOT NULL,
        plot_id INTEGER NOT NULL,
        rera_project_id BIGINT,
        rera_project_phase_id BIGINT,
        version_number INTEGER NOT NULL CHECK (version_number>0),
        agreement_number VARCHAR(120),
        agreement_type VARCHAR(80) NOT NULL DEFAULT 'ALLOTMENT_AGREEMENT',
        template_version VARCHAR(80),
        commercial_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        status VARCHAR(32) NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
          'DRAFT','PREPARED','UNDER_REVIEW','APPROVED_FOR_EXECUTION','EXECUTED','SUPERSEDED','CANCELLED'
        )),
        effective_date DATE,
        execution_date DATE,
        supersedes_agreement_id BIGINT,
        change_reason TEXT,
        review_notes TEXT,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMPTZ,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_booking_agreement_booking FOREIGN KEY (organization_id,site_id,booking_id)
          REFERENCES bookings(organization_id,site_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_booking_agreement_plot FOREIGN KEY (site_id,plot_id)
          REFERENCES plots(site_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_booking_agreement_previous FOREIGN KEY (supersedes_agreement_id)
          REFERENCES booking_agreements(id) ON DELETE RESTRICT,
        CONSTRAINT booking_agreement_execution_chk CHECK (status<>'EXECUTED' OR execution_date IS NOT NULL),
        CONSTRAINT booking_agreement_review_chk CHECK (reviewed_at IS NULL OR reviewed_by IS NOT NULL),
        UNIQUE (booking_id,version_number)
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_agreement_active ON booking_agreements(booking_id) WHERE status NOT IN ('SUPERSEDED','CANCELLED')`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_booking_agreement_status ON booking_agreements(site_id,status,updated_at DESC)`);

    await client.query(`
      ALTER TABLE plot_installments
        ADD COLUMN IF NOT EXISTS booking_id INTEGER REFERENCES bookings(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS milestone_code VARCHAR(60),
        ADD COLUMN IF NOT EXISTS demand_raised_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS demand_reference VARCHAR(100),
        ADD COLUMN IF NOT EXISTS rera_project_id BIGINT REFERENCES rera_projects(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS rera_project_phase_id BIGINT REFERENCES rera_project_phases(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS schedule_version INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_plot_installments_plot_id_id ON plot_installments(plot_id,id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plot_installments_booking_due ON plot_installments(booking_id,due_date) WHERE superseded_at IS NULL`);

    await client.query(`
      ALTER TABLE plot_payments
        ADD COLUMN IF NOT EXISTS booking_id INTEGER REFERENCES bookings(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS allottee_member_id INTEGER REFERENCES members(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS rera_project_id BIGINT REFERENCES rera_projects(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS rera_project_phase_id BIGINT REFERENCES rera_project_phases(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS agreement_id BIGINT REFERENCES booking_agreements(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS firm_id INTEGER REFERENCES firms(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS receipt_no VARCHAR(80),
        ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(120),
        ADD COLUMN IF NOT EXISTS ruleset_decision JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS reconciliation_status VARCHAR(24) NOT NULL DEFAULT 'UNMATCHED',
        ADD COLUMN IF NOT EXISTS reconciled_firm_transaction_id INTEGER REFERENCES firm_transactions(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS reconciled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS reversal_of_payment_id INTEGER REFERENCES plot_payments(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS reversal_reason TEXT
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='plot_payments_reconciliation_status_chk') THEN
          ALTER TABLE plot_payments ADD CONSTRAINT plot_payments_reconciliation_status_chk CHECK (
            reconciliation_status IN ('MATCHED','PARTIAL','UNMATCHED','AMOUNT_VARIANCE','DUPLICATE','WRONG_PROJECT','UNDER_REVIEW')
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='plot_payments_reversal_reason_chk') THEN
          ALTER TABLE plot_payments ADD CONSTRAINT plot_payments_reversal_reason_chk CHECK (
            reversal_of_payment_id IS NULL OR NULLIF(BTRIM(reversal_reason),'') IS NOT NULL
          );
        END IF;
      END $$
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_plot_payments_idempotency ON plot_payments(site_id,idempotency_key) WHERE idempotency_key IS NOT NULL`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_plot_payment_receipt_no ON plot_payments(site_id,receipt_no) WHERE receipt_no IS NOT NULL`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_plot_payment_reversal ON plot_payments(reversal_of_payment_id) WHERE reversal_of_payment_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plot_payment_booking ON plot_payments(booking_id,date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plot_payment_project_phase ON plot_payments(site_id,rera_project_id,rera_project_phase_id,date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plot_payment_reconciliation ON plot_payments(site_id,reconciliation_status,date DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS plot_payment_allocations (
        id BIGSERIAL PRIMARY KEY,
        plot_payment_id INTEGER NOT NULL REFERENCES plot_payments(id) ON DELETE RESTRICT,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
        installment_id INTEGER NOT NULL REFERENCES plot_installments(id) ON DELETE RESTRICT,
        allocated_amount NUMERIC(15,2) NOT NULL CHECK (allocated_amount<>0),
        allocation_type VARCHAR(20) NOT NULL DEFAULT 'PAYMENT' CHECK (allocation_type IN ('PAYMENT','ADJUSTMENT','REFUND','REVERSAL')),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (plot_payment_id,installment_id,allocation_type)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plot_payment_allocation_schedule ON plot_payment_allocations(installment_id,created_at)`);

    await client.query(`
      CREATE OR REPLACE FUNCTION validate_plot_payment_lifecycle_scope()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE v_booking bookings%ROWTYPE; v_agreement_booking INTEGER;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM plots p WHERE p.id=NEW.plot_id AND p.site_id=NEW.site_id) THEN
          RAISE EXCEPTION 'Payment property is outside the Site';
        END IF;
        IF NEW.firm_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM firms f WHERE f.id=NEW.firm_id AND f.site_id=NEW.site_id
        ) THEN RAISE EXCEPTION 'Payment account is outside the Site'; END IF;
        IF NEW.booking_id IS NOT NULL THEN
          SELECT * INTO v_booking FROM bookings WHERE id=NEW.booking_id;
          IF NOT FOUND OR v_booking.site_id IS DISTINCT FROM NEW.site_id
             OR v_booking.plot_id IS DISTINCT FROM NEW.plot_id THEN
            RAISE EXCEPTION 'Payment booking, property and Site do not match';
          END IF;
          IF NEW.allottee_member_id IS DISTINCT FROM v_booking.client_member_id
             OR NEW.rera_project_id IS DISTINCT FROM v_booking.rera_project_id
             OR NEW.rera_project_phase_id IS DISTINCT FROM v_booking.rera_project_phase_id THEN
            RAISE EXCEPTION 'Payment lifecycle context differs from the booking snapshot';
          END IF;
          IF NEW.agreement_id IS NOT NULL THEN
            SELECT booking_id INTO v_agreement_booking FROM booking_agreements WHERE id=NEW.agreement_id;
            IF v_agreement_booking IS DISTINCT FROM NEW.booking_id THEN
              RAISE EXCEPTION 'Payment agreement does not belong to the booking';
            END IF;
          END IF;
        ELSIF NEW.allottee_member_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM members m WHERE m.id=NEW.allottee_member_id AND m.site_id=NEW.site_id
        ) THEN RAISE EXCEPTION 'Payment allottee is outside the Site'; END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_validate_plot_payment_lifecycle_scope ON plot_payments`);
    await client.query(`
      CREATE TRIGGER trg_validate_plot_payment_lifecycle_scope
      BEFORE INSERT OR UPDATE OF plot_id,site_id,booking_id,allottee_member_id,
        rera_project_id,rera_project_phase_id,agreement_id,firm_id ON plot_payments
      FOR EACH ROW EXECUTE FUNCTION validate_plot_payment_lifecycle_scope()
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION validate_plot_payment_allocation_scope()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE v_payment_booking INTEGER; v_payment_plot INTEGER; v_schedule_booking INTEGER;
              v_schedule_plot INTEGER; v_schedule_amount NUMERIC(15,2); v_allocated NUMERIC(15,2);
      BEGIN
        SELECT booking_id,plot_id INTO v_payment_booking,v_payment_plot
          FROM plot_payments WHERE id=NEW.plot_payment_id;
        SELECT booking_id,plot_id,amount INTO v_schedule_booking,v_schedule_plot,v_schedule_amount
          FROM plot_installments WHERE id=NEW.installment_id FOR UPDATE;
        IF v_payment_booking IS NULL OR v_schedule_booking IS NULL
           OR v_payment_booking IS DISTINCT FROM NEW.booking_id
           OR v_schedule_booking IS DISTINCT FROM NEW.booking_id
           OR v_payment_plot IS DISTINCT FROM v_schedule_plot THEN
          RAISE EXCEPTION 'Payment allocation crosses booking or property boundaries';
        END IF;
        SELECT COALESCE(SUM(allocated_amount),0) INTO v_allocated
          FROM plot_payment_allocations
         WHERE installment_id=NEW.installment_id AND id<>COALESCE(NEW.id,-1);
        IF NEW.allocation_type IN ('PAYMENT','ADJUSTMENT')
           AND v_allocated+NEW.allocated_amount > v_schedule_amount THEN
          RAISE EXCEPTION 'Payment allocation exceeds the schedule amount';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_validate_plot_payment_allocation_scope ON plot_payment_allocations`);
    await client.query(`
      CREATE TRIGGER trg_validate_plot_payment_allocation_scope
      BEFORE INSERT OR UPDATE OF plot_payment_id,booking_id,installment_id,allocated_amount,allocation_type
      ON plot_payment_allocations FOR EACH ROW EXECUTE FUNCTION validate_plot_payment_allocation_scope()
    `);

    await client.query(`
      ALTER TABLE plot_registries
        ADD COLUMN IF NOT EXISTS booking_id INTEGER REFERENCES bookings(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS allottee_member_id INTEGER REFERENCES members(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS rera_project_id BIGINT REFERENCES rera_projects(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS rera_project_phase_id BIGINT REFERENCES rera_project_phases(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS agreement_id BIGINT REFERENCES booking_agreements(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS lifecycle_status VARCHAR(24) NOT NULL DEFAULT 'NOT_READY',
        ADD COLUMN IF NOT EXISTS readiness_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS readiness_result JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS possession_status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
        ADD COLUMN IF NOT EXISTS workflow_version INTEGER NOT NULL DEFAULT 1
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='plot_registries_lifecycle_status_chk') THEN
          ALTER TABLE plot_registries ADD CONSTRAINT plot_registries_lifecycle_status_chk CHECK (
            lifecycle_status IN ('NOT_READY','READY','SCHEDULED','DOCUMENTS_READY','EXECUTED','COMPLETE','CANCELLED')
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='plot_registries_possession_status_chk') THEN
          ALTER TABLE plot_registries ADD CONSTRAINT plot_registries_possession_status_chk CHECK (
            possession_status IN ('PENDING','READY','HANDOVER_SCHEDULED','ACKNOWLEDGED','POSSESSED','CANCELLED')
          );
        END IF;
      END $$
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_registry_lifecycle ON plot_registries(site_id,lifecycle_status,possession_status,updated_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_registry_booking ON plot_registries(booking_id)`);

    await client.query(`
      CREATE OR REPLACE FUNCTION validate_plot_registry_lifecycle_scope()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE v_booking bookings%ROWTYPE; v_agreement_booking INTEGER;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM plots p WHERE p.id=NEW.plot_id AND p.site_id=NEW.site_id) THEN
          RAISE EXCEPTION 'Registry property is outside the Site';
        END IF;
        IF NEW.booking_id IS NOT NULL THEN
          SELECT * INTO v_booking FROM bookings WHERE id=NEW.booking_id;
          IF NOT FOUND OR v_booking.site_id IS DISTINCT FROM NEW.site_id
             OR v_booking.plot_id IS DISTINCT FROM NEW.plot_id THEN
            RAISE EXCEPTION 'Registry booking, property and Site do not match';
          END IF;
          IF NEW.allottee_member_id IS DISTINCT FROM v_booking.client_member_id
             OR NEW.rera_project_id IS DISTINCT FROM v_booking.rera_project_id
             OR NEW.rera_project_phase_id IS DISTINCT FROM v_booking.rera_project_phase_id THEN
            RAISE EXCEPTION 'Registry lifecycle context differs from the booking snapshot';
          END IF;
          IF NEW.agreement_id IS NOT NULL THEN
            SELECT booking_id INTO v_agreement_booking FROM booking_agreements WHERE id=NEW.agreement_id;
            IF v_agreement_booking IS DISTINCT FROM NEW.booking_id THEN
              RAISE EXCEPTION 'Registry agreement does not belong to the booking';
            END IF;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_validate_plot_registry_lifecycle_scope ON plot_registries`);
    await client.query(`
      CREATE TRIGGER trg_validate_plot_registry_lifecycle_scope
      BEFORE INSERT OR UPDATE OF plot_id,site_id,booking_id,allottee_member_id,
        rera_project_id,rera_project_phase_id,agreement_id ON plot_registries
      FOR EACH ROW EXECUTE FUNCTION validate_plot_registry_lifecycle_scope()
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS booking_cancellations (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL,
        booking_id INTEGER NOT NULL,
        plot_id INTEGER NOT NULL,
        status VARCHAR(28) NOT NULL DEFAULT 'REQUESTED' CHECK (status IN (
          'REQUESTED','FINANCIAL_REVIEW','AGREEMENT_REVIEW','APPROVAL_PENDING','APPROVED',
          'REFUND_PENDING','REFUNDED','PROPERTY_RELEASED','REJECTED','CLOSED'
        )),
        reason TEXT NOT NULL,
        collected_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
        already_refunded NUMERIC(15,2) NOT NULL DEFAULT 0,
        proposed_deduction NUMERIC(15,2) NOT NULL DEFAULT 0,
        refund_due NUMERIC(15,2) NOT NULL DEFAULT 0,
        commission_impact NUMERIC(15,2) NOT NULL DEFAULT 0,
        financial_review JSONB NOT NULL DEFAULT '{}'::jsonb,
        agreement_review JSONB NOT NULL DEFAULT '{}'::jsonb,
        requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approved_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        idempotency_key VARCHAR(120),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_booking_cancellation_booking FOREIGN KEY (organization_id,site_id,booking_id)
          REFERENCES bookings(organization_id,site_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_booking_cancellation_plot FOREIGN KEY (site_id,plot_id)
          REFERENCES plots(site_id,id) ON DELETE RESTRICT,
        CONSTRAINT booking_cancellation_money_chk CHECK (
          collected_amount>=0 AND already_refunded>=0 AND proposed_deduction>=0 AND refund_due>=0
        )
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_open_cancellation ON booking_cancellations(booking_id) WHERE status NOT IN ('PROPERTY_RELEASED','REJECTED','CLOSED')`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_cancellation_idempotency ON booking_cancellations(organization_id,site_id,idempotency_key) WHERE idempotency_key IS NOT NULL`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='booking_cancellation_approval_chk') THEN
          ALTER TABLE booking_cancellations ADD CONSTRAINT booking_cancellation_approval_chk CHECK (
            status NOT IN ('APPROVED','REFUND_PENDING','REFUNDED','PROPERTY_RELEASED')
            OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
          );
        END IF;
      END $$
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS booking_refunds (
        id BIGSERIAL PRIMARY KEY,
        cancellation_id BIGINT NOT NULL REFERENCES booking_cancellations(id) ON DELETE RESTRICT,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
        original_plot_payment_id INTEGER REFERENCES plot_payments(id) ON DELETE RESTRICT,
        amount NUMERIC(15,2) NOT NULL CHECK (amount>0),
        payment_mode VARCHAR(20) NOT NULL CHECK (payment_mode IN ('CASH','BANK','CHEQUE')),
        firm_id INTEGER REFERENCES firms(id) ON DELETE RESTRICT,
        reference VARCHAR(255),
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','POSTED','REJECTED','CANCELLED')),
        day_book_id INTEGER REFERENCES day_book(id) ON DELETE RESTRICT,
        firm_transaction_id INTEGER REFERENCES firm_transactions(id) ON DELETE RESTRICT,
        approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approved_at TIMESTAMPTZ,
        posted_at TIMESTAMPTZ,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        idempotency_key VARCHAR(120),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      ALTER TABLE booking_refunds
        ADD COLUMN IF NOT EXISTS day_book_id INTEGER REFERENCES day_book(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS firm_transaction_id INTEGER REFERENCES firm_transactions(id) ON DELETE RESTRICT
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_refund_idempotency ON booking_refunds(booking_id,idempotency_key) WHERE idempotency_key IS NOT NULL`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='booking_refund_posting_chk') THEN
          ALTER TABLE booking_refunds ADD CONSTRAINT booking_refund_posting_chk CHECK (
            status<>'POSTED' OR (
              posted_at IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL
              AND ((payment_mode='CASH' AND day_book_id IS NOT NULL)
                OR (payment_mode IN ('BANK','CHEQUE') AND firm_transaction_id IS NOT NULL))
            )
          );
        END IF;
      END $$
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS booking_transfers (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL,
        booking_id INTEGER NOT NULL,
        plot_id INTEGER NOT NULL,
        from_member_id INTEGER NOT NULL,
        to_member_id INTEGER NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'REQUESTED' CHECK (status IN (
          'REQUESTED','DOCUMENT_REVIEW','FINANCIAL_REVIEW','APPROVAL_PENDING','APPROVED','EFFECTIVE','REJECTED','CANCELLED'
        )),
        reason TEXT NOT NULL,
        effective_date DATE,
        transfer_charge NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (transfer_charge>=0),
        review_context JSONB NOT NULL DEFAULT '{}'::jsonb,
        requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approved_at TIMESTAMPTZ,
        idempotency_key VARCHAR(120),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_booking_transfer_booking FOREIGN KEY (organization_id,site_id,booking_id)
          REFERENCES bookings(organization_id,site_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_booking_transfer_plot FOREIGN KEY (site_id,plot_id) REFERENCES plots(site_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_booking_transfer_from FOREIGN KEY (site_id,from_member_id) REFERENCES members(site_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_booking_transfer_to FOREIGN KEY (site_id,to_member_id) REFERENCES members(site_id,id) ON DELETE RESTRICT,
        CONSTRAINT booking_transfer_members_chk CHECK (from_member_id<>to_member_id)
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_open_transfer ON booking_transfers(booking_id) WHERE status NOT IN ('EFFECTIVE','REJECTED','CANCELLED')`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_transfer_idempotency ON booking_transfers(booking_id,idempotency_key) WHERE idempotency_key IS NOT NULL`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='booking_transfer_effective_chk') THEN
          ALTER TABLE booking_transfers ADD CONSTRAINT booking_transfer_effective_chk CHECK (
            status<>'EFFECTIVE' OR (effective_date IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
          );
        END IF;
      END $$
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS plot_possessions (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL,
        plot_id INTEGER NOT NULL,
        booking_id INTEGER NOT NULL,
        registry_id INTEGER NOT NULL,
        allottee_member_id INTEGER NOT NULL,
        rera_project_id BIGINT,
        rera_project_phase_id BIGINT,
        status VARCHAR(24) NOT NULL DEFAULT 'PENDING' CHECK (status IN (
          'PENDING','READY','HANDOVER_SCHEDULED','DOCUMENTS_DELIVERED','ACKNOWLEDGED','POSSESSED','CANCELLED'
        )),
        scheduled_at TIMESTAMPTZ,
        possession_date DATE,
        checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
        acknowledgement JSONB NOT NULL DEFAULT '{}'::jsonb,
        handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        completed_at TIMESTAMPTZ,
        idempotency_key VARCHAR(120),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_plot_possession_booking FOREIGN KEY (organization_id,site_id,booking_id)
          REFERENCES bookings(organization_id,site_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_plot_possession_plot FOREIGN KEY (site_id,plot_id) REFERENCES plots(site_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_plot_possession_registry FOREIGN KEY (registry_id) REFERENCES plot_registries(id) ON DELETE RESTRICT,
        CONSTRAINT fk_plot_possession_allottee FOREIGN KEY (site_id,allottee_member_id) REFERENCES members(site_id,id) ON DELETE RESTRICT,
        UNIQUE (registry_id)
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_plot_possession_idempotency ON plot_possessions(booking_id,idempotency_key) WHERE idempotency_key IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plot_possession_status ON plot_possessions(site_id,status,scheduled_at)`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='plot_possession_completion_chk') THEN
          ALTER TABLE plot_possessions ADD CONSTRAINT plot_possession_completion_chk CHECK (
            status<>'POSSESSED' OR (
              possession_date IS NOT NULL AND completed_by IS NOT NULL AND completed_at IS NOT NULL
              AND acknowledgement<>'{}'::jsonb
            )
          );
        END IF;
      END $$
    `);

    // Existing bank accounts and source transactions remain authoritative.
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_account_mappings (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL,
        firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE RESTRICT,
        rera_project_id BIGINT NOT NULL REFERENCES rera_projects(id) ON DELETE RESTRICT,
        rera_project_phase_id BIGINT REFERENCES rera_project_phases(id) ON DELETE RESTRICT,
        purpose VARCHAR(80) NOT NULL,
        effective_from DATE NOT NULL,
        effective_to DATE,
        evidence_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
        review_status VARCHAR(24) NOT NULL DEFAULT 'PENDING' CHECK (review_status IN ('PENDING','REVIEWED','REJECTED')),
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMPTZ,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_project_account_site FOREIGN KEY (organization_id,site_id) REFERENCES sites(organization_id,id) ON DELETE RESTRICT,
        CONSTRAINT project_account_dates_chk CHECK (effective_to IS NULL OR effective_to>=effective_from),
        CONSTRAINT project_account_review_chk CHECK (reviewed_at IS NULL OR reviewed_by IS NOT NULL)
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_project_account_active ON project_account_mappings(firm_id,rera_project_id,COALESCE(rera_project_phase_id,0),purpose) WHERE effective_to IS NULL`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_account_review_state_chk') THEN
          ALTER TABLE project_account_mappings ADD CONSTRAINT project_account_review_state_chk CHECK (
            (review_status='PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL)
            OR (review_status IN ('REVIEWED','REJECTED') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
          );
        END IF;
      END $$
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS project_transaction_allocations (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL,
        source_module VARCHAR(50) NOT NULL,
        source_id BIGINT NOT NULL,
        rera_project_id BIGINT NOT NULL REFERENCES rera_projects(id) ON DELETE RESTRICT,
        rera_project_phase_id BIGINT REFERENCES rera_project_phases(id) ON DELETE RESTRICT,
        allocation_method VARCHAR(20) NOT NULL CHECK (allocation_method IN ('DIRECT','AMOUNT','PERCENTAGE')),
        amount NUMERIC(15,2) NOT NULL CHECK (amount>=0),
        percentage NUMERIC(7,4) CHECK (percentage IS NULL OR (percentage>0 AND percentage<=100)),
        reason TEXT,
        approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approved_at TIMESTAMPTZ,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_project_allocation_site FOREIGN KEY (organization_id,site_id) REFERENCES sites(organization_id,id) ON DELETE RESTRICT,
        UNIQUE (organization_id,source_module,source_id,rera_project_id,rera_project_phase_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_project_allocations_project ON project_transaction_allocations(site_id,rera_project_id,rera_project_phase_id,created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_project_allocations_source ON project_transaction_allocations(source_module,source_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_project_allocation_scope ON project_transaction_allocations(organization_id,source_module,source_id,rera_project_id,COALESCE(rera_project_phase_id,0))`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_allocation_source_chk') THEN
          ALTER TABLE project_transaction_allocations ADD CONSTRAINT project_allocation_source_chk CHECK (
            source_module IN ('EXPENSE','VENDOR_PAYMENT','FARMER_PAYMENT','FIRM_TRANSACTION','DAY_BOOK')
          );
        END IF;
      END $$
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION validate_project_account_scope()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE v_phase_project BIGINT;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM sites s WHERE s.id=NEW.site_id AND s.organization_id=NEW.organization_id) THEN
          RAISE EXCEPTION 'Project account Site and organization do not match';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=NEW.firm_id AND f.site_id=NEW.site_id) THEN
          RAISE EXCEPTION 'Project account is outside the Site';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM rera_projects p WHERE p.id=NEW.rera_project_id
          AND p.site_id=NEW.site_id AND p.organization_id=NEW.organization_id AND p.deleted_at IS NULL) THEN
          RAISE EXCEPTION 'Project account project is outside the Site';
        END IF;
        IF NEW.rera_project_phase_id IS NOT NULL THEN
          SELECT rera_project_id INTO v_phase_project FROM rera_project_phases
           WHERE id=NEW.rera_project_phase_id AND site_id=NEW.site_id
             AND organization_id=NEW.organization_id AND deleted_at IS NULL;
          IF v_phase_project IS DISTINCT FROM NEW.rera_project_id THEN
            RAISE EXCEPTION 'Project account phase does not belong to the project';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_validate_project_account_scope ON project_account_mappings`);
    await client.query(`
      CREATE TRIGGER trg_validate_project_account_scope BEFORE INSERT OR UPDATE OF
        organization_id,site_id,firm_id,rera_project_id,rera_project_phase_id
      ON project_account_mappings FOR EACH ROW EXECUTE FUNCTION validate_project_account_scope()
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION validate_project_allocation_scope()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE v_phase_project BIGINT;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM rera_projects p WHERE p.id=NEW.rera_project_id
          AND p.site_id=NEW.site_id AND p.organization_id=NEW.organization_id AND p.deleted_at IS NULL) THEN
          RAISE EXCEPTION 'Allocated project is outside the Site or organization';
        END IF;
        IF NEW.rera_project_phase_id IS NOT NULL THEN
          SELECT rera_project_id INTO v_phase_project FROM rera_project_phases
           WHERE id=NEW.rera_project_phase_id AND site_id=NEW.site_id
             AND organization_id=NEW.organization_id AND deleted_at IS NULL;
          IF v_phase_project IS DISTINCT FROM NEW.rera_project_id THEN
            RAISE EXCEPTION 'Allocated phase does not belong to the project';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_validate_project_allocation_scope ON project_transaction_allocations`);
    await client.query(`
      CREATE TRIGGER trg_validate_project_allocation_scope BEFORE INSERT OR UPDATE OF
        organization_id,site_id,rera_project_id,rera_project_phase_id
      ON project_transaction_allocations FOR EACH ROW EXECUTE FUNCTION validate_project_allocation_scope()
    `);

    // Context on the existing finance rows. No new ledger or bank account is
    // introduced, and no legacy record is classified automatically.
    for (const table of ['firm_transactions','day_book','cash_flow_entries','expenses','vendor_payments','farmer_payments']) {
      await client.query(`ALTER TABLE ${table}
        ADD COLUMN IF NOT EXISTS rera_project_id BIGINT REFERENCES rera_projects(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS rera_project_phase_id BIGINT REFERENCES rera_project_phases(id) ON DELETE RESTRICT`);
    }
    await client.query(`ALTER TABLE firm_transactions ADD COLUMN IF NOT EXISTS reconciliation_context JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await client.query(`ALTER TABLE day_book ADD COLUMN IF NOT EXISTS booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_day_book_project_phase ON day_book(site_id,rera_project_id,rera_project_phase_id,date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_firm_transactions_project_phase ON firm_transactions(site_id,rera_project_id,rera_project_phase_id,date DESC)`);

    // Shared document engine: nullable relationship columns only. Files remain
    // in the same `documents` storage and authenticated download paths.
    await client.query(`
      ALTER TABLE documents
        ADD COLUMN IF NOT EXISTS booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS agreement_id BIGINT REFERENCES booking_agreements(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS possession_id BIGINT REFERENCES plot_possessions(id) ON DELETE SET NULL
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_documents_booking ON documents(booking_id,created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_documents_agreement ON documents(agreement_id,created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_documents_possession ON documents(possession_id,created_at DESC)`);

    await client.query(`ALTER TABLE plots ADD COLUMN IF NOT EXISTS current_booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plots_current_booking ON plots(current_booking_id) WHERE current_booking_id IS NOT NULL`);

    await client.query(`
      COMMENT ON TABLE plot_payment_allocations IS
        'Allocation only. plot_payments remains the monetary source of truth.'
    `);
    await client.query(`
      COMMENT ON TABLE project_transaction_allocations IS
        'Project/phase attribution only. The referenced legacy transaction remains the accounting source of truth.'
    `);
    await client.query(`
      COMMENT ON COLUMN plots.project_mapping_status IS
        'No project or phase is inferred for legacy plots; REVIEW_REQUIRED is explicit quarantine.'
    `);

    await client.query('COMMIT');
    console.log('Migration 096_property_customer_finance_lifecycle complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 096_property_customer_finance_lifecycle failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

async function rollback() {
  console.warn('Migration 096 is forward-only; --down made no database changes.');
}

const action = process.argv.includes('--down') ? rollback : migrate;
action()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
