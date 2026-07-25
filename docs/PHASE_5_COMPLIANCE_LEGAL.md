# Phase 5 — Compliance & Legal Control Centre

## Overview

Phase 5 adds a tenant-aware compliance and legal workspace to MountReality. It covers:

- Compliance dashboard, priority queue, calendar, register, checklists and controlled status workflow
- Reusable recurring templates with configurable due-date rules
- Approval/licence, legal case, notice/reply, inspection/hearing and document-expiry registers
- Private evidence storage with signed URLs, OCR indexing, version history and audited downloads
- Due-date and completion approvals, legal-reply approval, assignment and My Tasks
- Existing-expense links for fees and penalties without creating duplicate accounting records
- Hourly recurrence, expiry, reminder, escalation, overdue and risk jobs
- Management/audit reports with CSV, XLSX and print export
- Global header-bell alerts with unread state, deep links and a main-dashboard Compliance Watch card

No authority or state-specific legal deadline is hard-coded. Administrators own the rules, recurrence and applicability.

## Architecture

The feature follows the existing application:

- React/Vite frontend, existing shadcn-style components, AuthContext permissions and current-site context
- Express routes under `/api/compliance` and `/api/compliance-documents`
- PostgreSQL additive migrations `088_compliance_legal_control_centre.js` and `089_compliance_notification_centre.js`
- Existing JWT authentication, organisation boundary and `user_sites` site assignments
- Existing private S3-compatible storage, signed URL and DMS OCR utilities
- Existing SMTP mailer, SQS SMS worker and MSG91 WhatsApp adapter
- Existing in-process hourly scheduling style, protected by a PostgreSQL advisory lock for multi-instance idempotency

All record lookups constrain `organization_id`. Sub-admin queries additionally constrain records through `user_sites`. Admin and super-admin roles retain organisation-wide access.

## Database model

| Table | Purpose |
| --- | --- |
| `compliance_authorities` | Organisation-owned authority and department master |
| `compliance_templates` | Configurable recurrence, applicability, reminders and checklists |
| `compliance_items` | Central obligation register |
| `compliance_checklist_items` | Mandatory/optional completion tasks |
| `compliance_status_history` | Immutable status timeline |
| `compliance_due_date_changes` | Old/new date, reason and approval history |
| `compliance_approvals` | Completion, due-date and legal-reply approvals |
| `compliance_licences` | Approval/licence validity and renewal register |
| `compliance_finance_links` | References existing `expenses` rows; no duplicate posting |
| `legal_cases` | Legal matter, exposure, stage and hearing register |
| `legal_case_timeline` | Hearings, orders, filings, outcomes and next actions |
| `legal_notices` | Incoming/outgoing notices and reply workspace |
| `compliance_inspections` | Inspections, hearings, findings and corrective actions |
| `compliance_documents` | Private evidence metadata, storage key, OCR and expiry |
| `compliance_notification_log` | Channel delivery, dedupe, retry and failure history |
| `compliance_audit_log` | User, action, old/new values, reason, IP and timestamp |
| `compliance_settings` | Timezone, workflows, legal stages, reminders and channels |

Indexes cover organisation, site, due/expiry dates, status/risk, assignee, authority, case/notice numbers, OCR and notification processing. Partial unique indexes make recurring task and notification generation idempotent.

## API

All routes require authentication and an active subscription.

### Dashboard and work queues

- `GET /api/compliance/dashboard`
- `GET /api/compliance/calendar`
- `GET /api/compliance/my-tasks`
- `GET /api/compliance/users`
- `GET /api/compliance/legal-users`
- `GET /api/compliance/legal-authorities`
- `GET /api/compliance/notifications`
- `PATCH /api/compliance/notifications/:notificationId/read`
- `POST /api/compliance/notifications/read-all`
- `GET /api/compliance/legal-notifications`
- `PATCH /api/compliance/legal-notifications/:notificationId/read`
- `POST /api/compliance/legal-notifications/read-all`
- `GET /api/compliance/audit`
- `GET /api/compliance/reports`
- `GET /api/compliance/legal-reports`
- `GET /api/compliance/legal-config`

### Compliance register

- `GET|POST /api/compliance/items`
- `GET|PATCH|DELETE /api/compliance/items/:id`
- `POST /api/compliance/items/:id/status`
- `POST /api/compliance/items/:id/reschedule`
- `POST /api/compliance/items/:id/checklist`
- `PATCH /api/compliance/items/:id/checklist/:checklistId`
- `POST /api/compliance/items/:id/finance-links`
- `DELETE /api/compliance/items/:id/finance-links/:linkId`
- `POST /api/compliance/due-date-changes/:changeId/review`
- `POST /api/compliance/approvals/:approvalId/review`

### Templates and masters

- `GET|POST /api/compliance/templates`
- `PATCH|DELETE /api/compliance/templates/:id`
- `POST /api/compliance/templates/:id/duplicate`
- `POST /api/compliance/templates/:id/apply`
- `GET /api/compliance/templates-export`
- `POST /api/compliance/templates-import`
- `GET|POST /api/compliance/authorities`
- `PATCH|DELETE /api/compliance/authorities/:id`
- `GET|PUT /api/compliance/settings`

### Legal, licence and inspection registers

- `GET|POST /api/compliance/licences`
- `GET|PATCH|DELETE /api/compliance/licences/:id`
- `GET|POST /api/compliance/legal-cases`
- `GET|PATCH|DELETE /api/compliance/legal-cases/:id`
- `POST /api/compliance/legal-cases/:id/timeline`
- `GET|POST /api/compliance/notices`
- `GET|PATCH|DELETE /api/compliance/notices/:id`
- `POST /api/compliance/notices/:id/status`
- `POST /api/compliance/legal-approvals/:approvalId/review`
- `GET|POST /api/compliance/inspections`
- `GET|PATCH|DELETE /api/compliance/inspections/:id`

### Private evidence

- `GET|POST /api/compliance-documents/:entityType/:entityId`
- `GET|DELETE /api/compliance-documents/file/:documentId`
- `GET /api/compliance-documents/expiring`

Allowed entity types are `COMPLIANCE`, `LICENCE`, `LEGAL_CASE`, `LEGAL_NOTICE` and `INSPECTION`. Uploads are limited to one validated PDF, Word or image file up to 25 MB per request.

## Permissions

The existing four-action permission model is preserved:

| Module | Read | Write | Update | Delete |
| --- | --- | --- | --- | --- |
| `compliance` | dashboard/register/calendar/licence/inspection/evidence view | create records/checklists/evidence | edit, assign, status, reschedule and finance links | soft-delete records/evidence |
| `legal` | cases/notices/hearings/reports | create matters, updates and evidence | edit workflow and review assigned legal replies | soft-delete legal records/evidence |
| `compliance_templates` | view/export | create/import/apply/duplicate | edit/activate/deactivate | soft-delete |
| `compliance_settings` | settings and audit | create authorities | workflow settings and approval review | delete authorities |

These modules are fail-closed for existing and new sub-admins. Admin and super-admin roles keep the existing middleware bypass. Sensitive legal permissions are not granted automatically.

## Background jobs

`startComplianceScheduler()` runs hourly unless `COMPLIANCE_SCHEDULER=off`.

Each run:

1. Obtains PostgreSQL advisory lock `compliance_scheduler_hourly`.
2. Generates the next 12 months of recurring obligations.
3. Marks overdue obligations using each organisation's IANA timezone.
4. Recalculates risk, preserving manual overrides.
5. Produces compliance, licence, legal hearing, notice, inspection and document-expiry reminders.
6. Escalates overdue work to the reviewer and, after 14 days, an organisation administrator.
7. Commits the durable, deduplicated queue before contacting external providers.
8. Claims queued/failed messages atomically and retries failures up to three attempts.
9. Writes channel delivery/failure results to the notification log.

Dashboard alerts are stored locally. Email uses SMTP. SMS is queued through the existing SQS worker. WhatsApp uses the existing MSG91 adapter and an approved compliance template.

## Environment variables

See `.env.example`.

- `COMPLIANCE_SCHEDULER=on|off`
- `FRONTEND_URL`
- Existing SMTP variables: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- Existing SQS variables: `AWS_SMS_QUEUE_URL`, `AWS_SQS_REGION`, AWS credentials/provider chain
- Existing MSG91 variables plus `MSG91_COMPLIANCE_TEMPLATE`

The WhatsApp template must have four body values in this order: recipient name, record title, due date and reminder message.

## Installation and migration

From `Accounts/rgaccountbackend`:

```bash
npm install
npm run migrate:compliance
npm run test:compliance
```

The migration is additive and re-runnable. It does not rename or delete existing application data.

Rollback is available for a controlled pre-production rollback:

```bash
npm run migrate:compliance:down
```

Rollback removes all Phase 5 tables and their Phase 5 data. Back up the database first. It is never executed automatically.

Start the API normally:

```bash
npm run dev
```

For SMS delivery, run the existing worker separately:

```bash
npm run worker:sms
```

## Optional development seed

Seed data is blocked when `NODE_ENV=production` and requires explicit tenant/site IDs:

```bash
npm run seed:compliance -- --organization=1 --site=1
```

It adds a demo authority, recurring filing template, filing/checklist, document-expiry obligation, licence, legal case/timeline/hearing, notice and inspection. Re-running it is idempotent.

## Frontend routes

- `/compliance/dashboard`
- `/compliance/my-tasks`
- `/compliance/calendar`
- `/compliance/register` and `/compliance/register/:id`
- `/compliance/licences`
- `/compliance/filings` and `/compliance/templates`
- `/compliance/documents`
- `/compliance/authorities`
- `/compliance/reports`
- `/compliance/settings`
- `/legal/cases` and `/legal/cases/:id`
- `/legal/notices` and `/legal/notices/:id`
- `/legal/hearings`
- `/legal/inspections`
- `/legal/reports`

## Reports

The report endpoint and UI support all 18 requested report families: compliance summary, upcoming due, overdue, completion, approval expiry, licence renewal, compliance by project, compliance by authority, compliance by responsible user, compliance risk, legal case summary, hearing calendar, notice/reply, legal exposure, document expiry, inspection/corrective action, audit trail and penalty/fee.

Site, date, status, risk, authority and responsible-user filters are applied server-side where relevant to the selected report. Results are capped at 5,000 records per export request and the on-screen table renders up to 1,000 rows. CSV and XLSX use the existing client export dependency; print supplies the PDF workflow through the browser's print-to-PDF support.

## Testing

```bash
# Backend Phase 5 engine and security contracts
npm run test:compliance

# Existing backend regression suites
npm run test:accounting
npm run test:finance-forecast

# Frontend
cd ../rgaccount
npm run build
npx eslint src/pages/ComplianceLegal.jsx src/pages/ComplianceItemDetail.jsx \
  src/pages/LegalCaseDetail.jsx src/pages/LegalNoticeDetail.jsx \
  src/components/compliance/complianceUi.js src/App.jsx \
  src/components/sidebar/navConfig.js src/lib/launcherModules.js \
  src/pages/PermissionManagement.jsx
```

The 21 Phase 5 tests cover recurrence and due-date rules, invalid dates, workflow rejection, checklist blocking, reminder/escalation offsets, notification dedupe, recipient-scoped unread state, risk behavior, workflow/report route contracts, queue idempotency/claims/retries and source-level authentication, tenant, permission and document-access contracts. Database migrations and HTTP workflows should also be exercised against a cloned or test database before production rollout.

## User workflows

### Create and complete an obligation

1. Select a site and open Compliance & Legal.
2. Create an obligation or apply an administrator-owned template.
3. Assign an owner, reviewer, risk, due date and reminders.
4. Complete checklist items and upload evidence.
5. Move through the configured statuses.
6. If completion approval is enabled, a reviewer approves or returns it.

### Change a legally important due date

1. Open the compliance detail.
2. Enter the new date and mandatory reason.
3. The original date is preserved.
4. If configured, a manager approves or rejects the request.
5. Both the request and decision appear in the audit trail.

### Legal matter and notice

1. Create a case and record its exposure, owner, advocate and next hearing.
2. Add hearings, orders, outcomes, next actions and private documents to the timeline.
3. Create a notice with its reply deadline.
4. Draft the reply, request approval and attach notice/reply/submission evidence.
5. An assigned reviewer approves or returns the reply before submission.

### Link a fee or penalty

1. Post the real expense in the existing Expenses module.
2. Open the compliance record and use **Link expense**.
3. Enter the existing expense ID and cost type.
4. The compliance audit stores the reference; no second expense or ledger row is created.

## Operational limits

- SMS delivery requires the existing worker process and SQS configuration.
- WhatsApp delivery requires a separately approved MSG91 compliance template; the application cannot create or approve Meta templates.
- OCR remains best-effort and is limited to MIME types supported by the existing OCR service.
- The legacy finance Approval Manager does not render compliance approvals; Phase 5 approvals are available in Compliance detail, Notice detail, My Tasks and the compliance audit.
- The implemented approval UI covers completion, due-date changes and legal replies. Licence renewal, settlement, case closure, overdue-waiver and risk-override approvals have database support through the generic approval ledger but do not yet have dedicated request/review screens.
- Licence and inspection documents are fully supported by the secure API; the first UI release manages their metadata in the register and uses compliance/legal detail pages for the richest evidence workspace.
- Cross-module links to plots, bookings, buyers, registries, farmers, vendors, contracts and payments are stored through `related_entities`; inline compliance widgets have not been added to every legacy profile page.
- Primary owner, reviewer and approver assignments are implemented. Role/department auto-routing, watchers and an external-consultant login experience remain future workflow extensions.
- Phase 5 unit/security contract tests pass, but no disposable PostgreSQL environment was available for migration or end-to-end HTTP tests in this implementation session.
- No database migration was run automatically during implementation; production operators must run it against the intended database.

## Files

### Backend created

- `src/controllers/compliance.controller.js`
- `src/controllers/complianceDocument.controller.js`
- `src/migrations/088_compliance_legal_control_centre.js`
- `src/migrations/089_compliance_notification_centre.js`
- `src/routes/compliance.routes.js`
- `src/routes/complianceDocument.routes.js`
- `src/scripts/seedComplianceDemo.js`
- `src/services/complianceEngine.service.js`
- `src/services/complianceScheduler.service.js`
- `src/utils/complianceAccess.js`
- `test/compliance-engine.test.mjs`
- `test/compliance-security-contract.test.mjs`
- `docs/PHASE_5_COMPLIANCE_LEGAL.md`

### Backend modified

- `.env.example`
- `package.json`
- `src/models/Permission.model.js`
- `src/routes/index.js`
- `src/server.js`
- `src/utils/mailer.js`

### Frontend created

- `src/components/compliance/complianceUi.js`
- `src/pages/ComplianceLegal.jsx`
- `src/pages/ComplianceItemDetail.jsx`
- `src/pages/LegalCaseDetail.jsx`
- `src/pages/LegalNoticeDetail.jsx`
- `src/components/dashboard/ComplianceWatchCard.jsx`

### Frontend modified

- `src/App.jsx`
- `src/components/Layout.jsx`
- `src/components/sidebar/navConfig.js`
- `src/lib/launcherModules.js`
- `src/pages/Dashboard.jsx`
- `src/pages/DashboardManagement.jsx`
- `src/pages/PermissionManagement.jsx`
