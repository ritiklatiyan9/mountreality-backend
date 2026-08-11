# Controlled Pilot Runbook

Status: ready for execution after the P0 security-history and restore-rehearsal gates close.

## Pilot scope

- One organization and one real Site.
- Named owner, accountant, Site/construction user, registry/payment user, and sub-admin.
- A separate organization test identity used only for isolation checks.
- No direct SQL updates for daily pilot work.
- All issues recorded with request ID, user role, Site, time, expected result, actual result, severity, and evidence.

## Onboarding checklist

1. Confirm legal organization name, timezone, currency, fiscal opening date, and primary contacts.
2. Create the Site and publish the reviewed operating profile.
3. Configure role permissions using least privilege; never pilot only as super-admin.
4. Import master data through preview/validation flows. Reject unknown or ambiguous rows.
5. Reconcile opening cash/bank balances, customer receivables, vendor payables, plot status, and inventory on-hand.
6. Record signed-off source totals and application totals in the pilot evidence record.
7. Upload only approved evidence types; confirm private document authorization with a second role.
8. Train each user with only their acceptance script below.
9. Confirm support channel, incident owner, pilot hours, and rollback decision-maker.

## Data reconciliation

For every import batch record: source file checksum, row count, accepted count, rejected count, duplicate count, total debit, total credit, opening balance, operator, and approval. Preview must not write. The committed batch must be re-exported and compared to the source totals. Ambiguous Site, person, plot, payment, or legal classification must be rejected for human review.

Minimum reconciliation:

- cash and bank opening balances;
- plot inventory by lifecycle status;
- customer receivables and posted receipts;
- vendor commitments, payments, and payables;
- inventory on-hand/reserved/available by material;
- compliance evidence count and access grants.

## Owner acceptance script

1. Log in and select the pilot Site.
2. Review Money, plots, receivables, vendor payables, construction, compliance, and registry.
3. Drill from dashboard to the source record for one amount in each financial area.
4. Export a report and reconcile it to the visible total.
5. Switch Sites and confirm the page reloads only Site-scoped data.

## Accountant acceptance script

1. Record a customer payment with an idempotency key.
2. Generate and verify the receipt.
3. Reconcile the bank/cash classification and ledger posting.
4. Record and approve a vendor payment.
5. Confirm the payable and Day Book position changed exactly once.
6. Correct a deliberate mistake through the approved edit/reversal workflow; do not delete the audit trail.
7. Retry one request and prove no duplicate posting appears.

## Site/construction acceptance script

1. Create a material request.
2. Receive material, issue part of it, and confirm on-hand/reserved/available.
3. Retry the receive/issue request and prove inventory did not duplicate.
4. Record a construction update and upload allowed evidence.
5. Attempt an issue above available stock and confirm it is rejected.

## Registry/payment acceptance script

1. Open a registry-ready property and review readiness evidence.
2. Upload the required private document and verify unauthorized download is denied.
3. Schedule and complete registry using the controlled workflow.
4. Schedule possession.
5. Confirm another Site and another organization cannot address the record by changing IDs.

## Sub-admin and isolation script

1. Assign the sub-admin only to the pilot Site and minimum modules.
2. Confirm other Sites are absent from navigation, search, lists, exports, WebSocket/chat, and direct-ID requests.
3. Use a second-organization identity to repeat direct-ID and multipart Site/organization tampering attempts.
4. Expected result is denial or not-found with no data disclosure.

## Failure/retry script

- Repeat payment verification and inventory writes.
- Disconnect after submit and retry with the same idempotency key.
- Upload malformed content with an allowed extension.
- Request an expired/private document URL.
- Revoke a session and retry REST plus WebSocket access.
- Lock a cash-flow month and attempt mutation.
- Simulate storage and mail failure; the financial transaction must remain consistent and the user must receive an actionable error/request ID.

## Issue severity

- P0: tenant/data exposure, duplicate or missing money, inventory corruption, unrecoverable data loss, authentication bypass.
- P1: core daily workflow blocked, wrong totals/status, private document inaccessible to valid role, severe performance.
- P2: workaround exists; usability or secondary report problem.
- P3: cosmetic or low-impact improvement.

P0 stops the pilot immediately. P1 blocks wider activation until fixed and retested.

## Pilot exit criteria

- All four role scripts pass without developer intervention or direct SQL.
- Cross-Site and cross-tenant checks pass.
- Opening balances and key subledgers reconcile.
- No P0 or unresolved P1 remains.
- Backup/restore rehearsal evidence is approved.
- Owner signs the production checklist and known-limitations list.

