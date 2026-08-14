import pool from '../config/db.js';

const requiredTables = [
  'rera_collection_deposit_allocations',
  'rera_fund_withdrawals',
];
const requiredTriggers = [
  'trg_validate_rera_deposit_scope',
  'trg_validate_rera_withdrawal_scope',
  'trg_validate_reviewed_rera_designated_account',
  'trg_rera_deposit_account_evidence',
  'trg_rera_withdrawal_account_evidence',
  'trg_protect_active_rera_account_bank_details',
  'trg_protect_rera_deposit_lifecycle',
  'trg_protect_rera_withdrawal_lifecycle',
  'trg_protect_rera_firm_transaction_update',
  'trg_protect_rera_firm_transaction_delete',
  'trg_protect_rera_plot_payment_insert',
  'trg_protect_rera_plot_payment_update',
  'trg_protect_rera_plot_payment_delete',
  'trg_protect_reviewed_rera_mapping_identity',
  'trg_protect_rera_evidence_document_update',
  'trg_protect_rera_evidence_document_delete',
];
const requiredIndexes = [
  'uq_rera_deposit_idempotency',
  'idx_rera_deposit_project_status',
  'idx_rera_deposit_payment',
  'uq_rera_withdrawal_idempotency',
  'idx_rera_withdrawal_project_status',
  'idx_firm_transactions_rera_choices',
  'idx_project_account_rera_choices',
];

try {
  const [tables, triggers, indexes, migration, bankPolicy] = await Promise.all([
    pool.query(
      `SELECT name,to_regclass('public.'||name) IS NOT NULL AS present
         FROM unnest($1::text[]) AS name`,
      [requiredTables],
    ),
    pool.query(
      `SELECT tgname AS name,tgenabled='O' AS enabled
         FROM pg_trigger WHERE tgname=ANY($1::text[]) AND NOT tgisinternal`,
      [requiredTriggers],
    ),
    pool.query(
      `SELECT indexname AS name FROM pg_indexes
        WHERE schemaname='public' AND indexname=ANY($1::text[])`,
      [requiredIndexes],
    ),
    pool.query(
      `SELECT version,applied_at FROM app_schema_migrations
        WHERE version=ANY($1::text[]) ORDER BY version`,
      [[
        '120_rera_project_finance_controls_v1',
        '121_rera_designated_account_hardening_v1',
        '122_rera_project_finance_hardening_v1',
      ]],
    ),
    pool.query(`
      SELECT
        rera_bank_entry_is_eligible('approved','UPI',NULL) AS approved_bank,
        rera_bank_entry_is_eligible('approved','cash',NULL) AS cash,
        rera_bank_entry_is_eligible('pending','bank',NULL) AS pending,
        rera_bank_entry_is_eligible('approved','cheque','BOUNCED') AS bounced
    `),
  ]);
  const tableMap = new Map(tables.rows.map((row) => [row.name, row.present]));
  const triggerMap = new Map(triggers.rows.map((row) => [row.name, row.enabled]));
  const indexSet = new Set(indexes.rows.map((row) => row.name));
  const missing = [
    ...requiredTables.filter((name) => !tableMap.get(name)).map((name) => `table:${name}`),
    ...requiredTriggers.filter((name) => !triggerMap.get(name)).map((name) => `trigger:${name}`),
    ...requiredIndexes.filter((name) => !indexSet.has(name)).map((name) => `index:${name}`),
    ...([
      '120_rera_project_finance_controls_v1',
      '121_rera_designated_account_hardening_v1',
      '122_rera_project_finance_hardening_v1',
    ]
      .filter((version) => !migration.rows.some((row) => row.version === version))
      .map((version) => `migration:${version}`)),
  ];
  if (missing.length) throw new Error(`Missing RERA finance controls: ${missing.join(', ')}`);
  const predicate = bankPolicy.rows[0] || {};
  if (predicate.approved_bank !== true || predicate.cash !== false
      || predicate.pending !== false || predicate.bounced !== false) {
    throw new Error(`RERA bank-entry predicate failed closed: ${JSON.stringify(predicate)}`);
  }
  console.log(JSON.stringify({
    ok: true,
    migrations: migration.rows,
    tables: requiredTables,
    triggers: requiredTriggers,
    indexes: requiredIndexes,
    bank_entry_predicate: predicate,
  }, null, 2));
} finally {
  await pool.end();
}
