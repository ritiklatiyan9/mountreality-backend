import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Phase 4 hot-path indexes.
 *
 * These indexes follow the exact tenant/identity predicates used by the
 * buyer, broker, professional and control-centre APIs. The migration is
 * additive and re-runnable; it does not change domain data or source history.
 */
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('100_phase4_performance_hardening'))`);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_portal_member_scope
      ON bookings(organization_id,site_id,client_member_id,rera_project_id,booking_date DESC,id DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_booking_allottees_portal_member
      ON booking_allottees(site_id,member_id,booking_id,effective_from,effective_to)
      WHERE status='ACTIVE'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plot_payments_portal_booking
      ON plot_payments(booking_id,date DESC,id DESC)
      INCLUDE (amount,status,cheque_status,plot_id,site_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_booking_refunds_portal_booking
      ON booking_refunds(booking_id,status)
      INCLUDE (amount)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plot_registries_portal_booking
      ON plot_registries(booking_id,id DESC)
      INCLUDE (lifecycle_status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plot_possessions_portal_booking
      ON plot_possessions(booking_id,id DESC)
      INCLUDE (status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plot_commissions_portal_broker
      ON plot_commissions_v2(site_id,agent_id,created_at DESC,id DESC)
      INCLUDE (plot_id,total_commission,status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_commission_payments_portal
      ON plot_commission_payments(plot_commission_id,date DESC,id DESC)
      INCLUDE (amount,status,cheque_status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_certifications_portal_professional
      ON construction_certifications(
        organization_id,site_id,professional_stakeholder_id,rera_project_id,
        rera_project_phase_id,certification_period_end DESC,id DESC
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_certification_evidence_portal
      ON construction_certification_evidence(certification_id,compliance_document_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_portal_memberships_context
      ON portal_memberships(user_id,organization_id,status,updated_at DESC,id DESC)
      INCLUDE (site_id,rera_project_id,rera_project_phase_id,portal_type,domain_entity_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_portal_document_released_feed
      ON portal_document_grants(organization_id,portal_type,site_id,released_at DESC,id DESC)
      INCLUDE (membership_id,audience_scope,document_store,document_id)
      WHERE status='RELEASED'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_portal_inventory_released_feed
      ON portal_inventory_releases(organization_id,site_id,portal_type,released_at DESC,id DESC)
      INCLUDE (membership_id,audience_scope,plot_id)
      WHERE status='RELEASED'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_portal_updates_released_feed
      ON portal_project_updates(organization_id,site_id,rera_project_id,rera_project_phase_id,released_at DESC,id DESC)
      WHERE status='RELEASED'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_portal_updates_audiences_gin
      ON portal_project_updates USING GIN(audience_types jsonb_path_ops)
      WHERE status='RELEASED'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_portal_notifications_feed
      ON portal_notifications(membership_id,organization_id,created_at DESC,id DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_portal_notification_delivery_queue
      ON portal_notification_deliveries(status,created_at,id)
      WHERE status IN ('PENDING','FAILED')
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_construction_tasks_project_rollup
      ON construction_tasks(project_id,status,work_package_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_inventory_movements_project_rollup
      ON inventory_movements(site_id,project_id,movement_type,work_package_id)
      INCLUDE (qty,rate)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_project_allocations_project_rollup
      ON project_transaction_allocations(site_id,construction_project_id,construction_work_package_id)
      INCLUDE (amount)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_construction_forecast_approved_latest
      ON construction_cost_forecasts(construction_project_id,work_package_id,as_of_date DESC,id DESC)
      INCLUDE (estimated_additional_cost)
      WHERE approval_status='APPROVED'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_construction_commitment_project_rollup
      ON construction_work_package_commitments(construction_project_id,work_package_id,vendor_commitment_id)
      INCLUDE (allocation_amount)
    `);

    await client.query('COMMIT');

    // Refresh planner statistics after the new access paths are visible. Each
    // ANALYZE is isolated so an optional/empty table cannot roll back indexes.
    const tables = [
      'bookings', 'booking_allottees', 'plot_payments', 'plot_commissions_v2',
      'plot_commission_payments', 'construction_certifications', 'portal_memberships',
      'portal_document_grants', 'portal_inventory_releases', 'portal_project_updates',
      'portal_notifications', 'construction_work_packages', 'rera_filing_periods',
    ];
    for (const table of tables) await client.query(`ANALYZE ${table}`);
    console.log('Migration 100_phase4_performance_hardening complete');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration 100_phase4_performance_hardening failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
