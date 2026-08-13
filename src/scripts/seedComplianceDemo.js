import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pool from '../config/db.js';

const arg = (name) => {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  return match ? Number.parseInt(match.split('=')[1], 10) : null;
};
const dateIn = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const timeIn = (days, hour = 10) => {
  const date = new Date(Date.now() + days * 86400000);
  date.setHours(hour, 30, 0, 0);
  return date.toISOString();
};

const demoAuthorities = [
  ['Haryana Real Estate Regulatory Authority', 'Project Registration & Monitoring', 'RERA', 'Haryana', 'Gurugram', 'Compliance Facilitation Desk', 'rera.helpdesk@example.invalid'],
  ['Department of Town and Country Planning Haryana', 'Licensing Branch', 'STATE_AUTHORITY', 'Haryana', 'Gurugram', 'District Town Planner', 'dtcp.demo@example.invalid'],
  ['Municipal Corporation Gurugram', 'Building & Fire Coordination', 'LOCAL_AUTHORITY', 'Haryana', 'Gurugram', 'Zonal Compliance Officer', 'mcg.demo@example.invalid'],
  ['Haryana State Pollution Control Board', 'Regional Office', 'REGULATOR', 'Haryana', 'Gurugram', 'Environmental Engineer', 'hspcb.demo@example.invalid'],
  ['Fire and Emergency Services Haryana', 'Fire Prevention Wing', 'SAFETY_AUTHORITY', 'Haryana', 'Gurugram', 'Fire Station Officer', 'fire.demo@example.invalid'],
  ['Labour Department Haryana', 'Building & Other Construction Workers Cell', 'LABOUR_AUTHORITY', 'Haryana', 'Gurugram', 'Labour Inspector', 'labour.demo@example.invalid'],
];

const demoTemplates = [
  { name: 'RERA quarterly project progress filing', authority: demoAuthorities[0][0], category: 'RERA', type: 'RECURRING_FILING', frequency: 'QUARTERLY', risk: 'HIGH', days: 15, description: 'Quarterly progress, booking, construction and collection disclosures for Diwan City.' },
  { name: 'Fire safety certificate annual renewal', authority: demoAuthorities[4][0], category: 'SAFETY', type: 'LICENCE_RENEWAL', frequency: 'YEARLY', risk: 'CRITICAL', days: 30, description: 'Renewal workflow for fire systems, inspection evidence and authority acknowledgement.' },
  { name: 'Environmental monitoring submission', authority: demoAuthorities[3][0], category: 'ENVIRONMENT', type: 'ENVIRONMENT_COMPLIANCE', frequency: 'QUARTERLY', risk: 'HIGH', days: 10, description: 'Ambient air, water and construction-dust monitoring submission.' },
  { name: 'Construction labour welfare filing', authority: demoAuthorities[5][0], category: 'LABOUR', type: 'LABOUR_COMPLIANCE', frequency: 'MONTHLY', risk: 'MEDIUM', days: 7, description: 'Worker register, welfare contribution and contractor compliance pack.' },
  { name: 'Development licence condition review', authority: demoAuthorities[1][0], category: 'PROJECT', type: 'PROJECT_APPROVAL', frequency: 'HALF_YEARLY', risk: 'HIGH', days: 20, description: 'Internal review of development licence conditions and supporting records.' },
];

const demoItems = [
  ['DWC-CMP-001', 'RERA quarterly progress report — Q2', 'RERA', 'RERA_COMPLIANCE', 9, 'IN_PROGRESS', 'HIGH', 55, 25000, demoAuthorities[0][0], 'Real Estate (Regulation and Development) Act, 2016', 'Section 11', 'Validate construction progress and customer collection disclosures.'],
  ['DWC-CMP-002', 'Development licence condition compliance', 'PROJECT', 'PROJECT_APPROVAL', -8, 'OVERDUE', 'HIGH', 72, 150000, demoAuthorities[1][0], 'Haryana Development and Regulation of Urban Areas Act', 'Licence conditions', 'Updated engineering status is awaiting final management review.'],
  ['DWC-CMP-003', 'Fire NOC renewal package', 'SAFETY', 'FIRE_SAFETY', 28, 'AWAITING_DOCUMENTS', 'CRITICAL', 35, 75000, demoAuthorities[4][0], 'Applicable fire safety rules', 'Annual renewal', 'Hydrant test certificate and pump-room photographs are pending.'],
  ['DWC-CMP-004', 'Consent-to-establish monitoring return', 'ENVIRONMENT', 'ENVIRONMENT_COMPLIANCE', 45, 'NOT_STARTED', 'MEDIUM', 10, 18000, demoAuthorities[3][0], 'Environment (Protection) Act, 1986', 'Consent conditions', 'Compile ambient air, water and dust-control monitoring records.'],
  ['DWC-CMP-005', 'BOCW worker register and welfare filing', 'LABOUR', 'LABOUR_COMPLIANCE', 15, 'UNDER_REVIEW', 'MEDIUM', 80, 32000, demoAuthorities[5][0], 'Building and Other Construction Workers Act', 'Monthly return', 'Contractor declarations received and under internal review.'],
  ['DWC-CMP-006', 'GST TDS reconciliation and filing', 'TAX', 'TAX_COMPLIANCE', 3, 'SUBMITTED', 'MEDIUM', 92, 0, null, 'Central Goods and Services Tax Act', 'TDS return', 'Return submitted; acknowledgement reconciliation is pending.'],
  ['DWC-CMP-007', 'Electrical installation safety inspection', 'SAFETY', 'ELECTRICAL_SAFETY', 62, 'NOT_STARTED', 'LOW', 5, 12000, demoAuthorities[2][0], 'Central Electricity Authority safety regulations', 'Installation inspection', 'Coordinate inspection after energisation readiness review.'],
  ['DWC-CMP-008', 'Approved layout conditions verification', 'PROJECT', 'LOCAL_AUTHORITY_COMPLIANCE', -12, 'COMPLETED', 'LOW', 100, 0, demoAuthorities[1][0], 'Approved layout conditions', 'Layout approval', 'Verification completed and evidence archived.'],
  ['DWC-CMP-009', 'Monsoon storm-water corrective action', 'ENVIRONMENT', 'ENVIRONMENT_COMPLIANCE', -2, 'OVERDUE', 'CRITICAL', 40, 200000, demoAuthorities[2][0], 'Municipal environmental directions', 'Site inspection action', 'Complete silt-trap repairs and submit closure photographs.'],
  ['DWC-CMP-010', 'Contractor all-risk insurance renewal', 'INSURANCE', 'INSURANCE_RENEWAL', 80, 'IN_PROGRESS', 'MEDIUM', 30, 95000, null, 'Contractual insurance obligation', 'Policy renewal', 'Quotes received from two insurers; coverage comparison is underway.'],
  ['DWC-CMP-011', 'Water extraction permission review', 'ENVIRONMENT', 'LICENCE_RENEWAL', 120, 'NOT_STARTED', 'HIGH', 0, 45000, demoAuthorities[3][0], 'Groundwater permission conditions', 'Renewal review', 'Confirm consumption data before renewal application.'],
  ['DWC-CMP-012', 'Internal vendor statutory compliance audit', 'VENDOR', 'VENDOR_COMPLIANCE', 21, 'APPROVAL_PENDING', 'MEDIUM', 90, 0, null, 'Internal procurement policy', 'Quarterly vendor review', 'Audit pack is complete and awaiting compliance head approval.'],
];

async function seed() {
  if (process.env.NODE_ENV === 'production') throw new Error('Compliance demo seed is disabled in production');
  const organizationId = arg('organization');
  const siteId = arg('site');
  if (!organizationId || !siteId) throw new Error('Usage: npm run seed:compliance -- --organization=<id> --site=<id>');

  const client = await pool.connect();
  let phase = 'site lookup';
  try {
    await client.query('BEGIN');
    const { rows: sites } = await client.query(
      `SELECT s.id,s.name,s.organization_id,o.name AS organization_name,
              ARRAY(SELECT u.id FROM users u WHERE u.organization_id=s.organization_id AND u.is_active=TRUE ORDER BY CASE WHEN u.role IN ('admin','super_admin') THEN 0 ELSE 1 END,u.id LIMIT 4) AS user_ids
         FROM sites s JOIN organizations o ON o.id=s.organization_id
        WHERE s.id=$1 AND s.organization_id=$2`,
      [siteId, organizationId],
    );
    const site = sites[0];
    if (!site?.user_ids?.length) throw new Error('Site/organisation not found or no active user exists');
    const [ownerId, reviewerId = ownerId, backupId = ownerId] = site.user_ids;

    phase = 'authorities';
    const authorityIds = new Map();
    for (const authority of demoAuthorities) {
      const { rows } = await client.query(
        `INSERT INTO compliance_authorities
          (organization_id,name,department_name,authority_type,state,district,contact_person,email,categories,notes,created_by,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'["PROJECT","SAFETY","LEGAL"]'::jsonb,'DIWAN CITY demonstration master record',$9,$9)
         ON CONFLICT (organization_id,UPPER(name),COALESCE(UPPER(state),''),COALESCE(UPPER(district),'')) WHERE deleted_at IS NULL
         DO UPDATE SET department_name=EXCLUDED.department_name,contact_person=EXCLUDED.contact_person,email=EXCLUDED.email,is_active=TRUE,updated_by=EXCLUDED.updated_by,updated_at=NOW()
         RETURNING id,name`,
        [organizationId, ...authority, ownerId],
      );
      authorityIds.set(rows[0].name, rows[0].id);
    }

    phase = 'templates';
    const templateIds = new Map();
    for (const template of demoTemplates) {
      const { rows } = await client.query(
        `INSERT INTO compliance_templates
          (organization_id,authority_id,name,category,compliance_type,description,applicable_state,applicable_district,
           applicable_site_ids,frequency,start_date,due_date_rule,default_responsible_role,required_checklist,
           required_documents,default_risk,default_reminder_days,approval_required,is_active,created_by,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,'Haryana','Gurugram',$7::jsonb,$8,CURRENT_DATE,$9::jsonb,'COMPLIANCE_OFFICER',
           '[{"title":"Prepare filing pack","is_mandatory":true},{"title":"Obtain authority acknowledgement","is_mandatory":true,"required_document_type":"ACKNOWLEDGEMENT"}]'::jsonb,
           '["APPLICATION","CHALLAN","ACKNOWLEDGEMENT"]'::jsonb,$10,ARRAY[30,15,7,3,1,0],TRUE,TRUE,$11,$11)
         ON CONFLICT (organization_id,UPPER(name)) WHERE deleted_at IS NULL
         DO UPDATE SET authority_id=EXCLUDED.authority_id,description=EXCLUDED.description,applicable_site_ids=EXCLUDED.applicable_site_ids,is_active=TRUE,updated_by=EXCLUDED.updated_by,updated_at=NOW()
         RETURNING id,name`,
        [organizationId, authorityIds.get(template.authority), template.name, template.category, template.type, template.description, JSON.stringify([siteId]), template.frequency, JSON.stringify({ type: template.frequency === 'QUARTERLY' ? 'DAYS_AFTER_QUARTER_END' : 'DAYS_AFTER_MONTH_END', days: template.days }), template.risk, ownerId],
      );
      templateIds.set(rows[0].name, rows[0].id);
    }

    phase = 'compliance items';
    const itemIds = new Map();
    for (const [index, item] of demoItems.entries()) {
      const [code, title, category, type, dueOffset, status, risk, completion, impact, authority, law, section, notes] = item;
      const templateId = index < demoTemplates.length ? templateIds.get(demoTemplates[index].name) : null;
      const { rows } = await client.query(
        `INSERT INTO compliance_items
          (organization_id,site_id,template_id,authority_id,compliance_code,title,description,category,compliance_type,
           state,district,department,applicable_law,section_reference,frequency,original_due_date,current_due_date,
           assigned_to,reviewing_manager_id,approving_authority_id,priority,risk_level,financial_impact,status,
           completion_percentage,notes,tags,approval_required,generated_key,created_by,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Haryana','Gurugram','Compliance & Legal',$10,$11,'ONE_TIME',$12,$12,
           $13,$14,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,TRUE,$22,$13,$13)
         ON CONFLICT (organization_id,compliance_code)
         DO UPDATE SET title=EXCLUDED.title,current_due_date=EXCLUDED.current_due_date,status=EXCLUDED.status,
           risk_level=EXCLUDED.risk_level,completion_percentage=EXCLUDED.completion_percentage,notes=EXCLUDED.notes,
           authority_id=EXCLUDED.authority_id,assigned_to=EXCLUDED.assigned_to,updated_by=EXCLUDED.updated_by,updated_at=NOW(),deleted_at=NULL
         RETURNING id,compliance_code`,
        [organizationId, siteId, templateId, authority ? authorityIds.get(authority) : null, code, title, notes, category, type, law, section, dateIn(dueOffset), ownerId, reviewerId, risk === 'CRITICAL' ? 'CRITICAL' : risk, risk, impact, status, completion, notes, JSON.stringify(['DIWAN_CITY_DEMO', category]), `diwan-city-demo:${code}`],
      );
      itemIds.set(rows[0].compliance_code, rows[0].id);
    }

    phase = 'checklists and history';
    for (const [code, itemId] of itemIds) {
      const completed = code === 'DWC-CMP-008';
      const checklist = [
        ['Collect supporting records', 1, completed ? 'COMPLETED' : 'COMPLETED'],
        ['Complete internal verification', 2, completed ? 'COMPLETED' : 'IN_PROGRESS'],
        ['Archive authority acknowledgement', 3, completed ? 'COMPLETED' : 'PENDING'],
      ];
      for (const [title, sequence, status] of checklist) {
        await client.query(
          `INSERT INTO compliance_checklist_items
            (organization_id,compliance_item_id,title,description,is_mandatory,assigned_to,due_date,status,completed_by,completed_at,sequence)
           SELECT $1::integer,$2::integer,$3::varchar(300),'DIWAN CITY demonstration checklist task',TRUE,$4::integer,$5::date,$6::varchar(30),
                  CASE WHEN $6::varchar(30)='COMPLETED' THEN $4::integer ELSE NULL END,CASE WHEN $6::varchar(30)='COMPLETED' THEN NOW()-INTERVAL '2 days' ELSE NULL END,$7::integer
           WHERE NOT EXISTS (SELECT 1 FROM compliance_checklist_items WHERE organization_id=$1 AND compliance_item_id=$2 AND title=$3::varchar(300))`,
          [organizationId, itemId, title, backupId, dateIn(sequence * 3), status, sequence],
        );
      }
      await client.query(
        `INSERT INTO compliance_status_history (organization_id,compliance_item_id,previous_status,new_status,changed_by,comment,changed_at)
         SELECT $1,$2,'NOT_STARTED',(SELECT status FROM compliance_items WHERE id=$2),$3,'DIWAN CITY demo workflow initialized',NOW()-INTERVAL '5 days'
         WHERE NOT EXISTS (SELECT 1 FROM compliance_status_history WHERE organization_id=$1 AND compliance_item_id=$2 AND comment='DIWAN CITY demo workflow initialized')`,
        [organizationId, itemId, ownerId],
      );
    }

    phase = 'due date changes';
    await client.query(
      `INSERT INTO compliance_due_date_changes (organization_id,compliance_item_id,old_due_date,new_due_date,reason,status,requested_by)
       SELECT $1,$2,$3,$4,'Authority portal maintenance window; extension evidence attached.','PENDING',$5
       WHERE NOT EXISTS (SELECT 1 FROM compliance_due_date_changes WHERE organization_id=$1 AND compliance_item_id=$2 AND status='PENDING')`,
      [organizationId, itemIds.get('DWC-CMP-003'), dateIn(28), dateIn(35), backupId],
    );
    phase = 'approvals';
    await client.query(
      `INSERT INTO compliance_approvals (organization_id,compliance_item_id,entity_type,entity_id,action_type,status,requested_by,assigned_approver_id,request_comment)
       SELECT $1::integer,$2::integer,'COMPLIANCE',$2::bigint,'COMPLETION','PENDING',$3::integer,$4::integer,'Vendor statutory audit pack is ready for final approval.'
       WHERE NOT EXISTS (SELECT 1 FROM compliance_approvals WHERE organization_id=$1::integer AND entity_type='COMPLIANCE' AND entity_id=$2::bigint AND action_type='COMPLETION' AND status='PENDING')`,
      [organizationId, itemIds.get('DWC-CMP-012'), backupId, reviewerId],
    );

    phase = 'licences';
    const licences = [
      ['DWC-DTCP-2024-017', 'Diwan Valley development licence', 'PROJECT_APPROVAL', -420, 210, 'IN_PROGRESS', 'VERIFIED', 185000, demoAuthorities[1][0]],
      ['DWC-RERA-REG-0621', 'RERA project registration', 'RERA_COMPLIANCE', -300, 430, 'NOT_STARTED', 'VERIFIED', 0, demoAuthorities[0][0]],
      ['DWC-FIRE-NOC-044', 'Provisional fire safety NOC', 'FIRE_SAFETY', -320, 28, 'DOCUMENTS_PENDING', 'VERIFIED', 45000, demoAuthorities[4][0]],
      ['DWC-CTE-2025-118', 'Consent to establish', 'ENVIRONMENT_COMPLIANCE', -210, 155, 'NOT_STARTED', 'VERIFIED', 72000, demoAuthorities[3][0]],
      ['DWC-ELEC-HT-019', 'Electrical installation approval', 'ELECTRICAL_SAFETY', -180, 62, 'NOT_STARTED', 'PENDING_REVIEW', 25000, demoAuthorities[2][0]],
      ['DWC-LAB-REG-211', 'Principal employer BOCW registration', 'LABOUR_COMPLIANCE', -240, 330, 'NOT_REQUIRED', 'VERIFIED', 18000, demoAuthorities[5][0]],
    ];
    const licenceIds = new Map();
    for (const [number, name, type, issueOffset, expiryOffset, renewal, verification, cost, authority] of licences) {
      const { rows } = await client.query(
        `INSERT INTO compliance_licences
          (organization_id,site_id,authority_id,name,licence_type,licence_number,issue_date,effective_date,expiry_date,
           renewal_status,renewal_cost,conditions,responsible_person_id,verification_status,notes,created_by,updated_by)
         SELECT $1::integer,$2::integer,$3::integer,$4::varchar(300),$5::varchar(120),$6::varchar(150),$7::date,$7::date,$8::date,$9::varchar(40),$10::numeric,'Maintain valid records and report material changes.',$11::integer,$12::varchar(30),'DIWAN CITY demonstration approval',$11::integer,$11::integer
         WHERE NOT EXISTS (SELECT 1 FROM compliance_licences WHERE organization_id=$1::integer AND licence_number=$6::varchar(150) AND deleted_at IS NULL)
         RETURNING id`,
        [organizationId, siteId, authorityIds.get(authority), name, type, number, dateIn(issueOffset), dateIn(expiryOffset), renewal, cost, ownerId, verification],
      );
      const existing = rows[0] || (await client.query(`SELECT id FROM compliance_licences WHERE organization_id=$1 AND licence_number=$2 AND deleted_at IS NULL`, [organizationId, number])).rows[0];
      licenceIds.set(number, existing.id);
    }

    phase = 'legal cases';
    const cases = [
      ['DWC-CASE-001', 'Land title clarification — Sector 14 parcel', 'TITLE_DISPUTE', 'Civil Court Gurugram', 'CS/214/2026', 'Raghubir Singh', 'Adv. Meera Sethi', 8500000, 2400000, 'HIGH', 'EVIDENCE', 18, 'ACTIVE'],
      ['DWC-CASE-002', 'Contractor delay and liquidated damages claim', 'ARBITRATION', 'Delhi International Arbitration Centre', 'ARB/88/2026', 'Northline Infra Pvt Ltd', 'Adv. Arjun Malhotra', 4200000, 1750000, 'MEDIUM', 'ARGUMENTS', 34, 'ACTIVE'],
      ['DWC-CASE-003', 'Customer allotment cancellation petition', 'RERA', 'Haryana RERA Authority', 'HRERA/CC/319/2026', 'Neha Bansal', 'Adv. Kavita Rao', 1600000, 650000, 'MEDIUM', 'ADMISSION', 12, 'OPEN'],
      ['DWC-CASE-004', 'Access road right-of-way proceeding', 'REVENUE', 'Sub-Divisional Magistrate Gurugram', 'ROW/41/2025', 'Village Panchayat', 'Adv. Rahul Dahiya', 0, 300000, 'LOW', 'SETTLED', -25, 'SETTLED'],
    ];
    const caseIds = new Map();
    for (const [code, title, type, court, number, opposite, advocate, claim, exposure, risk, stage, hearingOffset, status] of cases) {
      const { rows } = await client.query(
        `INSERT INTO legal_cases
          (organization_id,site_id,case_code,title,case_type,court_authority,case_number,case_year,opposite_party,advocate,
           internal_owner_id,summary,claim_amount,financial_exposure,risk_level,stage,next_hearing_date,filing_date,limitation_date,status,notes,created_by,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,EXTRACT(YEAR FROM CURRENT_DATE)::int,$8,$9,$10,
           'DIWAN CITY demonstration legal matter with an auditable action history.',$11,$12,$13,$14,$15,CURRENT_DATE-90,CURRENT_DATE+180,$16,'Privileged internal demo note.',$10,$10)
         ON CONFLICT (organization_id,case_code) DO UPDATE SET title=EXCLUDED.title,next_hearing_date=EXCLUDED.next_hearing_date,stage=EXCLUDED.stage,status=EXCLUDED.status,risk_level=EXCLUDED.risk_level,updated_at=NOW(),deleted_at=NULL
         RETURNING id,case_code`,
        [organizationId, siteId, code, title, type, court, number, opposite, advocate, ownerId, claim, exposure, risk, stage, timeIn(hearingOffset, 11), status],
      );
      caseIds.set(rows[0].case_code, rows[0].id);
    }
    phase = 'case timelines';
    for (const [code, caseId] of caseIds) {
      for (const event of [
        ['SUBMISSION', -21, 'Case brief and evidence index filed', 'Documents reviewed and indexed.', 'Filing accepted for record.', 'Prepare next hearing note', 7],
        ['HEARING', -7, 'Counsel conference completed', 'Legal strategy and exposure reviewed.', 'Action list agreed.', 'Confirm witness availability', 14],
      ]) {
        await client.query(
          `INSERT INTO legal_case_timeline (organization_id,legal_case_id,event_type,event_date,title,description,outcome,next_action,next_action_due_date,assigned_to,advocate,created_by)
           SELECT $1::integer,$2::integer,$3::varchar(80),$4::timestamptz,$5::varchar(300),$6::text,$7::text,$8::text,$9::timestamptz,$10::integer,'DIWAN CITY panel counsel',$10::integer
           WHERE NOT EXISTS (SELECT 1 FROM legal_case_timeline WHERE organization_id=$1::integer AND legal_case_id=$2::integer AND title=$5::varchar(300))`,
          [organizationId, caseId, event[0], timeIn(event[1]), `${code}: ${event[2]}`, event[3], event[4], event[5], timeIn(event[6]), backupId],
        );
      }
    }

    phase = 'legal notices';
    const notices = [
      ['DWC-NOT-001', 'SHOW_CAUSE', 'INCOMING', 'Municipal Corporation Gurugram', 'Diwan City', -9, -1, 'CRITICAL', 'UNDER_REVIEW', 'Show-cause notice regarding storm-water management', 500000, demoAuthorities[2][0], 'Corrective-action photographs and contractor statement are being compiled.'],
      ['DWC-NOT-002', 'RERA', 'INCOMING', 'Haryana RERA Authority', 'Diwan City', -5, 9, 'HIGH', 'REPLY_DRAFTING', 'Clarification on quarterly project progress disclosure', 0, demoAuthorities[0][0], 'Draft response reconciles construction and collection disclosures.'],
      ['DWC-NOT-003', 'VENDOR', 'OUTGOING', 'Diwan City', 'Northline Infra Pvt Ltd', -12, 5, 'MEDIUM', 'REPLY_SUBMITTED', 'Notice to cure milestone delay', 1200000, null, 'Notice dispatched with programme-recovery requirements.'],
      ['DWC-NOT-004', 'LABOUR', 'INCOMING', 'Labour Department Haryana', 'Diwan City', -3, 12, 'MEDIUM', 'ASSIGNED', 'Worker register inspection query', 25000, demoAuthorities[5][0], 'Site HR and contractor records are assigned for response.'],
      ['DWC-NOT-005', 'CUSTOMER_LEGAL', 'INCOMING', 'Counsel for allottee', 'Diwan City', -2, 21, 'LOW', 'RECEIVED', 'Request for allotment ledger reconciliation', 375000, null, 'Accounts statement and booking terms are under verification.'],
    ];
    const noticeIds = new Map();
    for (const notice of notices) {
      const [number, type, direction, sender, recipient, receivedOffset, dueOffset, risk, status, subject, amount, authority, summary] = notice;
      const linkedCase = type === 'RERA' ? caseIds.get('DWC-CASE-003') : null;
      const { rows } = await client.query(
        `INSERT INTO legal_notices
          (organization_id,site_id,authority_id,legal_case_id,notice_number,notice_type,direction,sender,recipient,date_received,notice_date,
           reply_due_date,responsible_person_id,reviewing_manager_id,advocate,risk_level,status,subject,summary,amount_involved,draft_reply,created_by,updated_by)
         SELECT $1::integer,$2::integer,$3::integer,$4::integer,$5::varchar(150),$6::varchar(120),$7::varchar(20),$8::varchar(300),$9::varchar(300),$10::date,$10::date,$11::date,$12::integer,$13::integer,'DIWAN CITY legal panel',$14::varchar(20),$15::varchar(40),$16::varchar(500),$17::text,$18::numeric,
                CASE WHEN $15::varchar(40) IN ('REPLY_DRAFTING','UNDER_REVIEW') THEN 'Draft response prepared for internal review and supporting evidence confirmation.' ELSE NULL END,$12::integer,$12::integer
         WHERE NOT EXISTS (SELECT 1 FROM legal_notices WHERE organization_id=$1::integer AND notice_number=$5::varchar(150) AND deleted_at IS NULL)
         RETURNING id`,
        [organizationId, siteId, authority ? authorityIds.get(authority) : null, linkedCase, number, type, direction, sender, recipient, dateIn(receivedOffset), dateIn(dueOffset), ownerId, reviewerId, risk, status, subject, summary, amount],
      );
      const existing = rows[0] || (await client.query(`SELECT id FROM legal_notices WHERE organization_id=$1 AND notice_number=$2 AND deleted_at IS NULL`, [organizationId, number])).rows[0];
      noticeIds.set(number, existing.id);
    }

    phase = 'inspections';
    const inspections = [
      ['FIRE_INSPECTION', 10, 'Diwan Valley · Tower A fire command centre', 'OFFLINE', 'SCHEDULED', demoAuthorities[4][0]],
      ['ENVIRONMENTAL_INSPECTION', 17, 'Diwan Valley · construction zone', 'HYBRID', 'PREPARATION', demoAuthorities[3][0]],
      ['LABOUR_INSPECTION', 24, 'Diwan Valley · site administration office', 'OFFLINE', 'SCHEDULED', demoAuthorities[5][0]],
      ['INTERNAL_AUDIT', 5, 'Diwan City · compliance review room', 'ONLINE', 'CONFIRMED', null],
      ['RERA_HEARING', 12, 'Haryana RERA Gurugram bench', 'HYBRID', 'SCHEDULED', demoAuthorities[0][0]],
    ];
    const inspectionIds = new Map();
    for (const [type, offset, location, mode, status, authority] of inspections) {
      const { rows } = await client.query(
        `INSERT INTO compliance_inspections
          (organization_id,site_id,authority_id,inspection_type,scheduled_at,location,meeting_mode,responsible_person_id,
           attendees,preparation_checklist,required_documents,corrective_actions,status,created_by,updated_by)
         SELECT $1::integer,$2::integer,$3::integer,$4::varchar(120),$5::timestamptz,$6::text,$7::varchar(20),$8::integer,'[{"name":"Site compliance team"}]'::jsonb,
                '[{"title":"Confirm attendance","status":"COMPLETED"},{"title":"Prepare evidence room","status":"PENDING"}]'::jsonb,
                '["APPROVAL_COPY","SITE_REGISTER","PHOTO_EVIDENCE"]'::jsonb,'[]'::jsonb,$9::varchar(30),$8::integer,$8::integer
         WHERE NOT EXISTS (SELECT 1 FROM compliance_inspections WHERE organization_id=$1::integer AND site_id=$2::integer AND inspection_type=$4::varchar(120) AND location=$6::text AND deleted_at IS NULL)
         RETURNING id`,
        [organizationId, siteId, authority ? authorityIds.get(authority) : null, type, timeIn(offset, 10), location, mode, backupId, status],
      );
      const existing = rows[0] || (await client.query(`SELECT id FROM compliance_inspections WHERE organization_id=$1 AND site_id=$2 AND inspection_type=$3 AND location=$4 AND deleted_at IS NULL`, [organizationId, siteId, type, location])).rows[0];
      inspectionIds.set(type, existing.id);
    }

    phase = 'documents';
    const documentDir = path.join(process.cwd(), 'uploads', 'compliance_documents');
    fs.mkdirSync(documentDir, { recursive: true });
    const documents = [
      ['COMPLIANCE', itemIds.get('DWC-CMP-001'), 'RERA quarterly filing working paper', 'FILING', 90, 'VERIFIED'],
      ['COMPLIANCE', itemIds.get('DWC-CMP-003'), 'Fire equipment test certificate', 'CERTIFICATE', 35, 'PENDING_REVIEW'],
      ['LICENCE', licenceIds.get('DWC-DTCP-2024-017'), 'Development licence conditions extract', 'APPROVAL', 210, 'VERIFIED'],
      ['LEGAL_CASE', caseIds.get('DWC-CASE-001'), 'Title document evidence index', 'EVIDENCE_INDEX', 365, 'VERIFIED'],
      ['LEGAL_NOTICE', noticeIds.get('DWC-NOT-002'), 'RERA notice reply working draft', 'REPLY_DRAFT', 60, 'PENDING_REVIEW'],
      ['INSPECTION', inspectionIds.get('FIRE_INSPECTION'), 'Fire inspection readiness checklist', 'CHECKLIST', 10, 'VERIFIED'],
    ];
    for (const [index, document] of documents.entries()) {
      const [entityType, entityId, title, category, expiryOffset, verification] = document;
      const storedName = `diwan-city-compliance-demo-${index + 1}.txt`;
      const seriesKey = `diwan-city-demo-document-${index + 1}`;
      fs.writeFileSync(path.join(documentDir, storedName), `${title}\n\nDIWAN CITY demonstration evidence record.\nEntity: ${entityType} #${entityId}\nGenerated for local product demonstration only.\n`);
      await client.query(
        `INSERT INTO compliance_documents
          (organization_id,site_id,entity_type,entity_id,category,title,original_name,storage_key,mime_type,file_size,version_no,
           ocr_text,ocr_status,tags,verification_status,approval_status,confidentiality,issue_date,expiry_date,issuing_authority,
           uploaded_by,source_type,review_status,reviewed_by,reviewed_at,document_series_key)
         SELECT $1::integer,$2::integer,$3::varchar(40),$4::bigint,$5::varchar(120),$6::varchar(300),$7::varchar(500),$8::text,'text/plain',$9::bigint,1,$10::text,'DONE','["DIWAN_CITY_DEMO"]'::jsonb,$11::varchar(30),'NOT_REQUIRED',
                CASE WHEN $3::varchar(40) LIKE 'LEGAL_%' THEN 'CONFIDENTIAL' ELSE 'INTERNAL' END,CURRENT_DATE-30,$12::date,'DIWAN CITY compliance office',$13::integer,'IMPORTED','ACCEPTED',$13::integer,NOW(),$14::varchar(160)
         WHERE NOT EXISTS (SELECT 1 FROM compliance_documents WHERE organization_id=$1::integer AND document_series_key=$14::varchar(160) AND deleted_at IS NULL)`,
        [organizationId, siteId, entityType, entityId, category, title, storedName, `local-private::${storedName}`, fs.statSync(path.join(documentDir, storedName)).size, `${title} DIWAN CITY demonstration evidence`, verification, dateIn(expiryOffset), ownerId, seriesKey],
      );
    }

    phase = 'notifications';
    const notifications = [
      ['COMPLIANCE', itemIds.get('DWC-CMP-002'), 'OVERDUE', 'Development licence condition compliance is overdue', dateIn(-8)],
      ['COMPLIANCE', itemIds.get('DWC-CMP-003'), 'DUE_SOON', 'Fire NOC renewal requires documents', dateIn(28)],
      ['LEGAL_NOTICE', noticeIds.get('DWC-NOT-001'), 'REPLY_DUE', 'Storm-water show-cause reply is overdue', dateIn(-1)],
      ['INSPECTION', inspectionIds.get('FIRE_INSPECTION'), 'UPCOMING', 'Fire inspection preparation is due', dateIn(10)],
    ];
    for (const [entityType, entityId, notificationType, title, dueDate] of notifications) {
      await client.query(
        `INSERT INTO compliance_notification_log
          (organization_id,site_id,entity_type,entity_id,recipient_user_id,channel,notification_type,scheduled_for,title,due_date,message,status)
         SELECT $1::integer,$2::integer,$3::varchar(40),$4::bigint,$5::integer,'DASHBOARD',$6::varchar(60),CURRENT_DATE,$7::varchar(300),$8::date,$7::text,'PENDING'
         WHERE NOT EXISTS (SELECT 1 FROM compliance_notification_log WHERE organization_id=$1::integer AND title=$7::varchar(300))`,
        [organizationId, siteId, entityType, entityId, ownerId, notificationType, title, dueDate],
      );
    }

    phase = 'audit log';
    for (const [action, entityType, entityId, reason] of [
      ['DEMO_ITEM_CREATED', 'COMPLIANCE', itemIds.get('DWC-CMP-001'), 'DIWAN CITY demo: quarterly filing workspace initialized'],
      ['DEMO_RENEWAL_TRACKED', 'LICENCE', licenceIds.get('DWC-FIRE-NOC-044'), 'DIWAN CITY demo: renewal evidence requested'],
      ['DEMO_CASE_REVIEWED', 'LEGAL_CASE', caseIds.get('DWC-CASE-001'), 'DIWAN CITY demo: legal exposure reviewed'],
      ['DEMO_NOTICE_ASSIGNED', 'LEGAL_NOTICE', noticeIds.get('DWC-NOT-001'), 'DIWAN CITY demo: reply owner assigned'],
      ['DEMO_INSPECTION_SCHEDULED', 'INSPECTION', inspectionIds.get('FIRE_INSPECTION'), 'DIWAN CITY demo: inspection preparation started'],
    ]) {
      await client.query(
        `INSERT INTO compliance_audit_log (organization_id,site_id,user_id,action,entity_type,entity_id,new_value,reason,created_at)
         SELECT $1::integer,$2::integer,$3::integer,$4::varchar(100),$5::varchar(60),$6::bigint,'{"source":"DIWAN_CITY_DEMO"}'::jsonb,$7::text,NOW()-INTERVAL '1 day'
         WHERE NOT EXISTS (SELECT 1 FROM compliance_audit_log WHERE organization_id=$1::integer AND action=$4::varchar(100) AND entity_type=$5::varchar(60) AND entity_id=$6::bigint AND reason=$7::text)`,
        [organizationId, siteId, ownerId, action, entityType, entityId, reason],
      );
    }

    phase = 'settings';
    await client.query(
      `INSERT INTO compliance_settings (organization_id,timezone,due_date_change_requires_approval,completion_requires_approval,notification_channels,default_reminder_days,overdue_escalation_days,updated_by)
       VALUES ($1,'Asia/Kolkata',TRUE,TRUE,'["DASHBOARD","EMAIL"]'::jsonb,ARRAY[30,15,7,3,1,0],ARRAY[1,3,7,14],$2)
       ON CONFLICT (organization_id) DO UPDATE SET notification_channels=EXCLUDED.notification_channels,default_reminder_days=EXCLUDED.default_reminder_days,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [organizationId, ownerId],
    );

    await client.query('COMMIT');
    console.log(`Compliance demo seeded for ${site.organization_name} / ${site.name}: ${demoItems.length} obligations, ${licences.length} licences, ${cases.length} cases, ${notices.length} notices, ${inspections.length} inspections and ${documents.length} documents.`);
  } catch (error) {
    await client.query('ROLLBACK');
    error.message = `${phase}: ${error.message}`;
    throw error;
  } finally {
    client.release();
  }
}

seed()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error('Compliance demo seed failed:', error.message, error.detail || '', error.where || '');
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
