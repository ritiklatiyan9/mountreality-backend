import 'dotenv/config';
import pool from '../config/db.js';

const REQUIRED_INDEXES = [
  'idx_bookings_portal_member_scope', 'idx_booking_allottees_portal_member',
  'idx_plot_payments_portal_booking', 'idx_booking_refunds_portal_booking',
  'idx_plot_registries_portal_booking', 'idx_plot_possessions_portal_booking',
  'idx_plot_commissions_portal_broker', 'idx_commission_payments_portal',
  'idx_certifications_portal_professional', 'idx_certification_evidence_portal',
  'idx_portal_memberships_context', 'idx_portal_document_released_feed',
  'idx_portal_inventory_released_feed', 'idx_portal_updates_released_feed',
  'idx_portal_updates_audiences_gin', 'idx_portal_notifications_feed',
  'idx_portal_notification_delivery_queue', 'idx_portal_comments_unresolved',
  'idx_construction_tasks_project_rollup', 'idx_inventory_movements_project_rollup',
  'idx_project_allocations_project_rollup', 'idx_construction_forecast_approved_latest',
  'idx_construction_commitment_project_rollup',
  'idx_bookings_enterprise_project_rollup', 'idx_certifications_enterprise_latest',
  'idx_registries_enterprise_project_rollup', 'idx_licences_enterprise_expiry',
  'idx_filings_enterprise_project_rollup',
];

function collectPlanNodes(node, result = { node_types: new Set(), indexes: new Set() }) {
  if (!node) return result;
  if (node['Node Type']) result.node_types.add(node['Node Type']);
  if (node['Index Name']) result.indexes.add(node['Index Name']);
  for (const child of node.Plans || []) collectPlanNodes(child, result);
  return result;
}

async function explain(client, name, sql, params) {
  const result = await client.query(`EXPLAIN (FORMAT JSON, COSTS TRUE) ${sql}`, params);
  const plan = result.rows[0]['QUERY PLAN'][0].Plan;
  const nodes = collectPlanNodes(plan);
  return {
    name,
    startup_cost: plan['Startup Cost'],
    total_cost: plan['Total Cost'],
    estimated_rows: plan['Plan Rows'],
    node_types: [...nodes.node_types],
    selected_indexes: [...nodes.indexes],
  };
}

const client = await pool.connect();
try {
  await client.query('BEGIN READ ONLY');
  await client.query(`SET LOCAL statement_timeout='15s'`);
  const indexResult = await client.query(
    `SELECT c.relname AS index_name,i.indisvalid,i.indisready
       FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE c.relname=ANY($1::text[]) ORDER BY c.relname`,
    [REQUIRED_INDEXES],
  );
  const valid = new Set(indexResult.rows.filter((row) => row.indisvalid && row.indisready).map((row) => row.index_name));
  const missing = REQUIRED_INDEXES.filter((index) => !valid.has(index));
  if (missing.length) throw new Error(`Missing or invalid Phase 4 indexes: ${missing.join(', ')}`);

  const sample = (await client.query(
    `SELECT COALESCE((SELECT id FROM organizations ORDER BY id LIMIT 1),0)::int AS organization_id,
            COALESCE((SELECT id FROM sites ORDER BY id LIMIT 1),0)::int AS site_id,
            COALESCE((SELECT id FROM members ORDER BY id LIMIT 1),0)::bigint AS member_id,
            COALESCE((SELECT id FROM rera_projects ORDER BY id LIMIT 1),0)::bigint AS project_id,
            COALESCE((SELECT id FROM rera_stakeholders ORDER BY id LIMIT 1),0)::bigint AS stakeholder_id,
            COALESCE((SELECT id FROM construction_projects ORDER BY id LIMIT 1),0)::bigint AS construction_project_id,
            COALESCE((SELECT id FROM portal_memberships ORDER BY id LIMIT 1),0)::bigint AS membership_id`,
  )).rows[0];

  const planSpecs = [
    ['buyer-bookings',
      `SELECT b.id FROM bookings b
        WHERE b.organization_id=$1 AND b.site_id=$2 AND b.rera_project_id=$3
          AND (b.client_member_id=$4 OR EXISTS (
            SELECT 1 FROM booking_allottees ba
             WHERE ba.booking_id=b.id AND ba.site_id=$2 AND ba.member_id=$4 AND ba.status='ACTIVE'
          )) ORDER BY b.booking_date DESC,b.id DESC`,
      [sample.organization_id, sample.site_id, sample.project_id, sample.member_id]],
    ['professional-certifications',
      `SELECT id FROM construction_certifications
        WHERE organization_id=$1 AND site_id=$2 AND professional_stakeholder_id=$3
          AND rera_project_id=$4 ORDER BY certification_period_end DESC,id DESC`,
      [sample.organization_id, sample.site_id, sample.stakeholder_id, sample.project_id]],
    ['released-project-updates',
      `SELECT id FROM portal_project_updates
        WHERE organization_id=$1 AND site_id=$2 AND rera_project_id=$3
          AND status='RELEASED' AND audience_types ? 'BUYER'
        ORDER BY released_at DESC,id DESC LIMIT 100`,
      [sample.organization_id, sample.site_id, sample.project_id]],
    ['portal-notifications',
      `SELECT id FROM portal_notifications
        WHERE membership_id=$1 AND organization_id=$2
        ORDER BY created_at DESC,id DESC LIMIT 100`,
      [sample.membership_id, sample.organization_id]],
    ['unresolved-portal-comments',
      `SELECT id FROM portal_comments
        WHERE organization_id=$1 AND target_type='PROJECT_UPDATE' AND target_id=$2
          AND deleted_at IS NULL AND resolved_at IS NULL
        ORDER BY created_at,id LIMIT 100`,
      [sample.organization_id, sample.project_id]],
    ['enterprise-booking-rollup',
      `SELECT COUNT(*),COALESCE(SUM(final_consideration),0) FROM bookings
        WHERE organization_id=$1 AND site_id=$2 AND rera_project_id=$3
          AND COALESCE(lifecycle_status,'DRAFT') NOT IN ('CANCELLED','TRANSFERRED','CLOSED')`,
      [sample.organization_id, sample.site_id, sample.project_id]],
    ['enterprise-certification-latest',
      `SELECT certified_progress_pct FROM construction_certifications
        WHERE construction_project_id=$1 AND status IN ('CERTIFIED','APPROVED')
        ORDER BY certification_period_end DESC,id DESC LIMIT 1`,
      [sample.construction_project_id]],
    ['enterprise-registry-rollup',
      `SELECT COUNT(*) FROM plot_registries
        WHERE site_id=$1 AND rera_project_id=$2 AND lifecycle_status NOT IN ('COMPLETE','CANCELLED')`,
      [sample.site_id, sample.project_id]],
  ];
  const plans = [];
  for (const [name, sql, params] of planSpecs) plans.push(await explain(client, name, sql, params));
  await client.query('SET LOCAL enable_seqscan=off');
  const growthPlans = [];
  for (const [name, sql, params] of planSpecs) growthPlans.push(await explain(client, name, sql, params));

  const stats = await client.query(
    `SELECT relname,n_live_tup,seq_scan,idx_scan
       FROM pg_stat_user_tables
      WHERE relname=ANY($1::text[]) ORDER BY relname`,
    [[
      'bookings', 'booking_allottees', 'construction_certifications', 'portal_memberships',
      'portal_document_grants', 'portal_inventory_releases', 'portal_project_updates', 'portal_notifications',
      'portal_comments', 'portal_notification_deliveries',
      'plot_registries', 'compliance_licences', 'rera_filing_periods',
    ]],
  );
  await client.query('COMMIT');
  console.log(JSON.stringify({
    required_indexes: REQUIRED_INDEXES.length,
    valid_indexes: valid.size,
    current_data_plans: plans,
    growth_index_candidates: growthPlans,
    note: 'Current tables are nearly empty, so sequential scans are correctly cheaper; growth candidates verify index compatibility.',
    table_stats: stats.rows,
  }, null, 2));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
