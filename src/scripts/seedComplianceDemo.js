import 'dotenv/config';
import pool from '../config/db.js';

const arg = (name) => {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  return match ? Number.parseInt(match.split('=')[1], 10) : null;
};
const iso = (days) => new Date(Date.now() + days * 86400000).toISOString();

async function seed() {
  if (process.env.NODE_ENV === 'production') throw new Error('Compliance demo seed is disabled in production');
  const organizationId = arg('organization');
  const siteId = arg('site');
  if (!organizationId || !siteId) {
    throw new Error('Usage: npm run seed:compliance -- --organization=<id> --site=<id>');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: sites } = await client.query(
      `SELECT s.id,s.organization_id,
              (SELECT u.id FROM users u WHERE u.organization_id=s.organization_id AND u.is_active=TRUE ORDER BY CASE WHEN u.role IN ('admin','super_admin') THEN 0 ELSE 1 END,u.id LIMIT 1) AS user_id
         FROM sites s WHERE s.id=$1 AND s.organization_id=$2`,
      [siteId, organizationId]
    );
    if (!sites[0]?.user_id) throw new Error('Site/organisation not found or no active user exists');
    const userId = sites[0].user_id;

    const authority = await client.query(
      `INSERT INTO compliance_authorities
        (organization_id,name,department_name,authority_type,state,district,contact_person,email,created_by,updated_by)
       VALUES ($1,'Demo Development Authority','Town Planning','LOCAL_AUTHORITY','Demo State','Demo District','Demo Officer','demo.authority@example.invalid',$2,$2)
       ON CONFLICT (organization_id,UPPER(name),COALESCE(UPPER(state),''),COALESCE(UPPER(district),''))
         WHERE deleted_at IS NULL
       DO UPDATE SET updated_at=NOW()
       RETURNING id`,
      [organizationId, userId]
    );
    const authorityId = authority.rows[0].id;

    const template = await client.query(
      `INSERT INTO compliance_templates
        (organization_id,authority_id,name,category,compliance_type,description,applicable_site_ids,
         frequency,start_date,due_date_rule,default_responsible_role,required_checklist,
         required_documents,default_risk,default_reminder_days,is_active,created_by,updated_by)
       VALUES ($1,$2,'Demo quarterly project filing','PROJECT','RECURRING_FILING',
         'Development-only sample recurring filing. Replace its rule before operational use.',
         $3::jsonb,'QUARTERLY',CURRENT_DATE,'{"type":"DAYS_AFTER_QUARTER_END","days":15}'::jsonb,
         'COMPLIANCE_OFFICER',
         '[{"title":"Prepare return","is_mandatory":true},{"title":"Upload acknowledgement","is_mandatory":true,"required_document_type":"ACKNOWLEDGEMENT"}]'::jsonb,
         '["RETURN","CHALLAN","ACKNOWLEDGEMENT"]'::jsonb,'MEDIUM',ARRAY[30,15,7,1,0],TRUE,$4,$4)
       ON CONFLICT (organization_id,UPPER(name)) WHERE deleted_at IS NULL
       DO UPDATE SET applicable_site_ids=EXCLUDED.applicable_site_ids,updated_at=NOW()
       RETURNING id`,
      [organizationId, authorityId, JSON.stringify([siteId]), userId]
    );

    const item = await client.query(
      `INSERT INTO compliance_items
        (organization_id,site_id,template_id,authority_id,compliance_code,title,description,category,
         compliance_type,frequency,original_due_date,current_due_date,assigned_to,reviewing_manager_id,
         priority,risk_level,status,reminder_days,generated_key,created_by,updated_by)
       VALUES ($1,$2,$3,$4,'DEMO-CMP-QUARTERLY','Demo quarterly project filing',
         'Development-only compliance sample','PROJECT','RECURRING_FILING','QUARTERLY',
         CURRENT_DATE+15,CURRENT_DATE+15,$5,$5,'HIGH','HIGH','IN_PROGRESS',ARRAY[15,7,1,0],
         'demo:quarterly-filing',$5,$5)
       ON CONFLICT (organization_id,compliance_code)
       DO UPDATE SET updated_at=NOW()
       RETURNING id`,
      [organizationId, siteId, template.rows[0].id, authorityId, userId]
    );
    await client.query(
      `INSERT INTO compliance_checklist_items
        (organization_id,compliance_item_id,title,is_mandatory,assigned_to,due_date,sequence)
       SELECT $1,$2,v.title,TRUE,$3,CURRENT_DATE+v.days,v.sequence
         FROM (VALUES ('Prepare filing package',10,1),('Obtain submission acknowledgement',15,2)) v(title,days,sequence)
       WHERE NOT EXISTS (
         SELECT 1 FROM compliance_checklist_items c
          WHERE c.organization_id=$1 AND c.compliance_item_id=$2 AND c.title=v.title
       )`,
      [organizationId, item.rows[0].id, userId]
    );
    await client.query(
      `INSERT INTO compliance_items
        (organization_id,site_id,authority_id,compliance_code,title,category,compliance_type,
         frequency,original_due_date,current_due_date,assigned_to,priority,risk_level,status,
         reminder_days,generated_key,created_by,updated_by)
       VALUES ($1,$2,$3,'DEMO-CMP-DOC-EXPIRY','Demo fire certificate expiry','SAFETY','DOCUMENT_EXPIRY',
         'YEARLY',CURRENT_DATE+60,CURRENT_DATE+60,$4,'HIGH','HIGH','NOT_STARTED',
         ARRAY[60,30,15,7,0],'demo:document-expiry',$4,$4)
       ON CONFLICT (organization_id,compliance_code) DO NOTHING`,
      [organizationId, siteId, authorityId, userId]
    );

    await client.query(
      `INSERT INTO compliance_licences
        (organization_id,site_id,authority_id,name,licence_type,licence_number,issue_date,effective_date,
         expiry_date,renewal_status,responsible_person_id,verification_status,created_by,updated_by)
       SELECT $1,$2,$3,'Demo layout approval','LAYOUT_APPROVAL','DEMO-LA-001',
              CURRENT_DATE-300,CURRENT_DATE-300,CURRENT_DATE+90,'NOT_STARTED',$4,'VERIFIED',$4,$4
       WHERE NOT EXISTS (
         SELECT 1 FROM compliance_licences WHERE organization_id=$1 AND licence_number='DEMO-LA-001' AND deleted_at IS NULL
       )`,
      [organizationId, siteId, authorityId, userId]
    );

    const legalCase = await client.query(
      `INSERT INTO legal_cases
        (organization_id,site_id,case_code,title,case_type,court_authority,case_number,case_year,
         opposite_party,advocate,internal_owner_id,summary,claim_amount,financial_exposure,risk_level,
         stage,next_hearing_date,status,created_by,updated_by)
       VALUES ($1,$2,'DEMO-CASE-001','Demo land-title matter','TITLE_DISPUTE','Demo Civil Court',
         'DEMO/123',EXTRACT(YEAR FROM CURRENT_DATE)::int,'Demo claimant','Demo Advocate',$3,
         'Development-only legal matter sample.',2500000,1250000,'HIGH','EVIDENCE',$4,'ACTIVE',$3,$3)
       ON CONFLICT (organization_id,case_code)
       DO UPDATE SET next_hearing_date=EXCLUDED.next_hearing_date,updated_at=NOW()
       RETURNING id`,
      [organizationId, siteId, userId, iso(21)]
    );
    await client.query(
      `INSERT INTO legal_case_timeline
        (organization_id,legal_case_id,event_type,event_date,title,next_action,next_action_due_date,assigned_to,created_by)
       SELECT $1,$2,'HEARING',NOW()-INTERVAL '14 days','Demo preliminary hearing',
              'Prepare title evidence bundle',$3,$4,$4
       WHERE NOT EXISTS (
         SELECT 1 FROM legal_case_timeline WHERE organization_id=$1 AND legal_case_id=$2 AND title='Demo preliminary hearing'
       )`,
      [organizationId, legalCase.rows[0].id, iso(14), userId]
    );
    await client.query(
      `INSERT INTO legal_notices
        (organization_id,site_id,authority_id,legal_case_id,notice_number,notice_type,direction,
         sender,recipient,date_received,notice_date,reply_due_date,responsible_person_id,reviewing_manager_id,
         risk_level,status,subject,summary,amount_involved,created_by,updated_by)
       SELECT $1,$2,$3,$4,'DEMO-NOTICE-001','GOVERNMENT','INCOMING','Demo Authority','MountReality',
              CURRENT_DATE,CURRENT_DATE,CURRENT_DATE+14,$5,$5,'HIGH','ASSIGNED',
              'Demo show-cause notice','Development-only notice sample.',500000,$5,$5
       WHERE NOT EXISTS (
         SELECT 1 FROM legal_notices WHERE organization_id=$1 AND notice_number='DEMO-NOTICE-001' AND deleted_at IS NULL
       )`,
      [organizationId, siteId, authorityId, legalCase.rows[0].id, userId]
    );
    await client.query(
      `INSERT INTO compliance_inspections
        (organization_id,site_id,authority_id,inspection_type,scheduled_at,location,meeting_mode,
         responsible_person_id,attendees,preparation_checklist,required_documents,status,created_by,updated_by)
       SELECT $1,$2,$3,'FIRE_INSPECTION',$4,'Demo project site','OFFLINE',$5,
              '[]'::jsonb,'[{"title":"Check extinguishers","status":"PENDING"}]'::jsonb,
              '["FIRE_CERTIFICATE","SITE_PLAN"]'::jsonb,'SCHEDULED',$5,$5
       WHERE NOT EXISTS (
         SELECT 1 FROM compliance_inspections WHERE organization_id=$1 AND site_id=$2
           AND inspection_type='FIRE_INSPECTION' AND deleted_at IS NULL
       )`,
      [organizationId, siteId, authorityId, iso(10), userId]
    );

    await client.query('COMMIT');
    console.log(`Compliance demo data seeded for organization ${organizationId}, site ${siteId}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Compliance demo seed failed:', error.message);
    process.exit(1);
  });
