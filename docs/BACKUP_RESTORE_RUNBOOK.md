# Backup and Restore Runbook

Status: procedure ready; an isolated restore rehearsal has not yet been executed. This is a release gate.

## Objectives and ownership

- Target RPO: 24 hours for scheduled backups; use provider point-in-time recovery for a smaller loss window when enabled.
- Target RTO for a controlled pilot: 4 hours.
- Incident commander: production owner.
- Database operator: person with Neon project and branch/restore access.
- Application verifier: backend release owner plus one finance-domain reviewer.
- Never restore into the live database as a rehearsal.

## Preconditions

- PostgreSQL client tools must match or be newer than the server major version.
- `DATABASE_URL` must reference the source database using a read-capable account.
- `RESTORE_DATABASE_URL` must reference a newly-created empty, isolated database/branch.
- Store dumps in encrypted storage with restricted access. Do not place them in this repository.
- Record the source commit, migration ledger, UTC start time, operator, and ticket/incident ID.

## 1. Source preflight

```bash
export READINESS_TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
export BACKUP_FILE="/secure/backups/accounts-${READINESS_TIMESTAMP}.dump"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT version, applied_at FROM app_schema_migrations ORDER BY applied_at, version;"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT current_database(), NOW(), pg_size_pretty(pg_database_size(current_database()));"
```

Capture baseline counts for at least:

```sql
SELECT 'organizations' AS relation, COUNT(*) FROM organizations
UNION ALL SELECT 'sites', COUNT(*) FROM sites
UNION ALL SELECT 'users', COUNT(*) FROM users
UNION ALL SELECT 'plots', COUNT(*) FROM plots
UNION ALL SELECT 'plot_payments', COUNT(*) FROM plot_payments
UNION ALL SELECT 'cash_flow_entries', COUNT(*) FROM cash_flow_entries
UNION ALL SELECT 'inventory_movements', COUNT(*) FROM inventory_movements
UNION ALL SELECT 'compliance_documents', COUNT(*) FROM compliance_documents;
```

## 2. Create backup

```bash
pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-acl \
  --verbose \
  --file="$BACKUP_FILE"
pg_restore --list "$BACKUP_FILE" > "${BACKUP_FILE}.manifest"
shasum -a 256 "$BACKUP_FILE" "${BACKUP_FILE}.manifest"
```

The command must exit successfully. Record duration, byte size, SHA-256, and manifest line count.

## 3. Restore to an isolated target

The target must be empty. Do not use `--clean` against any shared database.

```bash
pg_restore \
  --exit-on-error \
  --no-owner \
  --no-acl \
  --dbname="$RESTORE_DATABASE_URL" \
  "$BACKUP_FILE"
```

Run `ANALYZE` after restore:

```bash
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "ANALYZE;"
```

## 4. Restore verification

- Compare every baseline row count; explain any difference.
- Compare the migration ledger.
- Verify migrations 103–106, including the Phase 3/4 schema reconciliation ledger entry, columns, and indexes.
- Run duplicate checks for Razorpay payment IDs, inventory idempotency keys, and imprest source postings.
- Run the ledger consistency check and Phase 4 performance check with the restored database configuration.
- Boot the application against only the restored database and verify `/health/live` and `/health/ready`.
- Run authenticated smoke tests for owner/admin/sub-admin against non-production identities.
- Verify private document metadata without downloading or exposing production objects.

Expected schema checks:

```sql
SELECT version FROM app_schema_migrations
 WHERE version IN (
  '103_session_security_hardening_v1',
  '104_financial_idempotency_hardening_v1',
  '105_inventory_invariants_v1',
  '106_phase34_migration_ledger_reconciliation_v1'
 ) ORDER BY version;

SELECT indexname FROM pg_indexes
 WHERE schemaname='public' AND indexname IN (
  'idx_user_sessions_active_user',
  'idx_user_sessions_refresh_expiry',
  'uq_imprest_source_posting',
  'uq_subscriptions_razorpay_payment',
  'uq_inventory_movement_idempotency'
 ) ORDER BY indexname;
```

## 5. Acceptance record

The rehearsal passes only when:

- dump, manifest, and checksum exist;
- restore exits with no errors;
- row counts and migration ledger match;
- integrity and performance checks pass;
- the backend boots and authenticated smoke checks pass;
- duration fits the 4-hour RTO;
- evidence is attached to the release record.

Delete the isolated branch only after evidence has been reviewed. Follow the provider retention policy for the encrypted dump.

## Production recovery decision

1. Stop writes or place the application in maintenance mode.
2. Preserve evidence and determine the last known-good recovery point.
3. Prefer provider point-in-time recovery into a new branch/database.
4. Verify it using the same restore checks.
5. Update the deployment secret to the verified database endpoint.
6. Deploy the last compatible application release.
7. Resume writes only after finance and tenant-isolation smoke checks pass.

Migrations 098–106 are additive and forward-only. Application rollback should deploy the previous compatible build; do not improvise destructive down-migrations during an incident.
