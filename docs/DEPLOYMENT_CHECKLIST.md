# Production Deployment Checklist

## Release evidence

- [ ] Release commit/tag identified; all intended changes reviewed.
- [ ] No unrelated dirty-worktree changes are included.
- [ ] Backend syntax check passes.
- [ ] `npm run test:phases1-4` passes.
- [ ] `npm run test:hardening` passes.
- [ ] Frontend `npm run lint` exits with zero errors.
- [ ] Account frontend `npm run build` passes.
- [ ] Owner frontend `npm run build` passes.
- [ ] Production-only dependency audits report zero known vulnerabilities in all three packages.
- [ ] Phase 4 performance check reports 28/28 required indexes.

## Security and secrets

- [ ] Rotate the Neon/database credential previously present in Git history.
- [ ] Revoke any other secret found during full remote-history scanning.
- [ ] Purge database/customer exports and credential-bearing blobs from remote Git history using an approved history-rewrite window.
- [ ] All collaborators have re-cloned after the history rewrite.
- [ ] `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `RECEIPT_VERIFY_SECRET` are unique, random, and at least 32 characters.
- [ ] `CORS_ORIGINS` is an exact HTTPS allowlist with no wildcard.
- [ ] S3 Block Public Access is enabled and the bucket policy has been independently reviewed.
- [ ] Deployment uses workload/role credentials or secret-manager values, not committed keys.
- [ ] TLS verification is enabled for PostgreSQL.
- [ ] Production logs contain no tokens, credentials, document URLs, or personal data.

## Database and recovery

- [ ] A fresh backup was created and checksummed.
- [ ] The backup was restored to an isolated database/branch using the backup runbook.
- [ ] Restored row counts, ledger checks, and authenticated smoke tests passed.
- [ ] Migrations 103, 104, 105, and 106 are present in `app_schema_migrations`.
- [ ] Required columns and unique indexes were verified after migration.
- [ ] Rollback owner and point-in-time recovery steps are confirmed.

## Runtime configuration

- [ ] `NODE_ENV=production`.
- [ ] `FRONTEND_URL` and all CORS origins use HTTPS.
- [ ] S3 bucket and region are configured; no production local-file fallback exists.
- [ ] Razorpay key, secret, and webhook verification are configured in secret storage.
- [ ] Firebase service account is supplied outside the repository if Google login is enabled.
- [ ] `/health/live` and `/health/ready` are configured in the platform probes.
- [ ] Graceful shutdown timeout is compatible with the platform termination window.
- [ ] At least one alert covers readiness failures, elevated 5xx, latency, DB exhaustion, and scheduler failures.

## Controlled rollout

- [ ] Deploy backend before frontends when session/security schema changes are pending.
- [ ] Verify live/ready endpoints and one read-only admin request.
- [ ] Deploy Account frontend and Owner frontend.
- [ ] Validate login, token refresh, logout, site switching, and a permission-denied path.
- [ ] Validate one read and one controlled write in finance, inventory, documents, and portals.
- [ ] Confirm no cross-Site/cross-tenant data is visible using dedicated test identities.
- [ ] Monitor errors, request IDs, latency, DB connections, and duplicate-key errors for at least 30 minutes.
- [ ] Keep rollback decision-maker available during the observation window.

## Stop/rollback conditions

Rollback or stop writes for any cross-tenant exposure, duplicate financial posting, inconsistent ledger balance, negative-stock race, inaccessible private evidence, authentication loop, migration error, sustained readiness failure, or unexplained 5xx spike.
