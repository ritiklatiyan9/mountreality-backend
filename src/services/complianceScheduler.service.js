import pool from '../config/db.js';
import { buildOccurrences } from './complianceEngine.service.js';
import { mailerEnabled, sendComplianceReminderEmail } from '../utils/mailer.js';
import { enqueueSms, isSmsQueueConfigured } from '../utils/sqs.js';
import { isWhatsAppConfigured, sendWATemplate } from '../utils/notify.js';

const HOUR_MS = 60 * 60 * 1000;
let timer = null;

const codeFor = () => `CMP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;

async function generateRecurringItems(client) {
  const { rows: templates } = await client.query(
    `SELECT t.*
       FROM compliance_templates t
      WHERE t.is_active=TRUE AND t.deleted_at IS NULL
        AND t.start_date IS NOT NULL
        AND jsonb_array_length(t.applicable_site_ids) > 0`
  );
  let generated = 0;
  const through = new Date(Date.now() + 366 * 86400000).toISOString().slice(0, 10);
  for (const template of templates) {
    let occurrences;
    try {
      occurrences = buildOccurrences({
        frequency: template.frequency,
        startDate: template.start_date,
        endDate: template.end_date,
        dueDateRule: template.due_date_rule,
        throughDate: through,
      });
    } catch (error) {
      console.error(`[compliance] template ${template.id} recurrence invalid: ${error.message}`);
      continue;
    }
    const siteIds = (template.applicable_site_ids || []).map(Number).filter(Number.isInteger);
    for (const siteId of siteIds) {
      const site = await client.query(
        `SELECT id FROM sites WHERE id=$1 AND organization_id=$2 LIMIT 1`,
        [siteId, template.organization_id]
      );
      if (!site.rows[0]) continue;
      for (const occurrence of occurrences) {
        const generatedKey = `template:${template.id}:site:${siteId}:period:${occurrence.periodKey}`;
        const { rows } = await client.query(
          `INSERT INTO compliance_items
            (organization_id,site_id,template_id,authority_id,compliance_code,title,description,
             category,subcategory,compliance_type,state,district,frequency,original_due_date,current_due_date,
             reminder_days,reviewing_manager_id,approving_authority_id,risk_level,priority,approval_required,
             generated_key,created_by,updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16,$17,$18,$18,$19,$20,$21,$21)
           ON CONFLICT (organization_id,generated_key)
             WHERE generated_key IS NOT NULL AND deleted_at IS NULL
           DO NOTHING RETURNING id`,
          [template.organization_id, siteId, template.id, template.authority_id, codeFor(),
            template.name, template.description, template.category, template.subcategory,
            template.compliance_type, template.applicable_state, template.applicable_district,
            template.frequency, occurrence.dueDate, template.default_reminder_days,
            template.default_reviewer_id, template.default_approver_id, template.default_risk,
            template.approval_required, generatedKey, template.updated_by || template.created_by]
        );
        const itemId = rows[0]?.id;
        if (!itemId) continue;
        generated += 1;
        for (let index = 0; index < (template.required_checklist || []).length; index += 1) {
          const row = template.required_checklist[index];
          if (!String(row?.title || '').trim()) continue;
          await client.query(
            `INSERT INTO compliance_checklist_items
              (organization_id,compliance_item_id,title,description,is_mandatory,required_document_type,sequence)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [template.organization_id, itemId, String(row.title).slice(0, 300),
              row.description || null, Boolean(row.is_mandatory),
              row.required_document_type || null, index]
          );
        }
      }
    }
  }
  return generated;
}

async function refreshOverdueAndRisk(client) {
  const overdue = await client.query(
    `WITH candidates AS (
       SELECT i.id,i.organization_id,i.status AS previous_status
         FROM compliance_items i
         LEFT JOIN compliance_settings cs ON cs.organization_id=i.organization_id
        WHERE i.deleted_at IS NULL
          AND i.current_due_date < (CURRENT_TIMESTAMP AT TIME ZONE COALESCE(cs.timezone,'Asia/Kolkata'))::date
          AND i.status NOT IN ('OVERDUE','COMPLETED','NOT_APPLICABLE','CANCELLED')
     ),
     changed AS (
       UPDATE compliance_items i
          SET status='OVERDUE',updated_at=NOW()
         FROM candidates c
        WHERE i.id=c.id AND i.organization_id=c.organization_id
       RETURNING i.id,i.organization_id,c.previous_status
     )
     INSERT INTO compliance_status_history
       (organization_id,compliance_item_id,previous_status,new_status,comment)
     SELECT organization_id,id,previous_status,'OVERDUE','Automatically marked overdue by the compliance scheduler'
       FROM changed
     RETURNING id`
  );
  await client.query(
    `UPDATE compliance_items i
        SET risk_level = CASE
          WHEN i.risk_override_reason IS NOT NULL THEN i.risk_level
          WHEN i.status IN ('COMPLETED','NOT_APPLICABLE','CANCELLED') THEN i.risk_level
          WHEN i.current_due_date < tz.today - 7 OR i.financial_impact >= 10000000 THEN 'CRITICAL'
          WHEN i.current_due_date < tz.today OR i.current_due_date <= tz.today + 3 OR i.financial_impact >= 2500000 THEN 'HIGH'
          WHEN i.current_due_date <= tz.today + 15 OR i.financial_impact >= 500000 THEN 'MEDIUM'
          ELSE 'LOW'
        END,
        updated_at=CASE
          WHEN i.risk_override_reason IS NULL THEN NOW() ELSE i.updated_at END
       FROM (
         SELECT o.id AS organization_id,
                (CURRENT_TIMESTAMP AT TIME ZONE COALESCE(cs.timezone,'Asia/Kolkata'))::date AS today
           FROM organizations o
           LEFT JOIN compliance_settings cs ON cs.organization_id=o.id
       ) tz
      WHERE i.organization_id=tz.organization_id AND i.deleted_at IS NULL`
  );
  return overdue.rowCount || 0;
}

async function dueNotifications(client) {
  const { rows } = await client.query(
    `WITH settings AS (
       SELECT o.id AS organization_id,
              COALESCE(cs.timezone,'Asia/Kolkata') AS timezone,
              COALESCE(cs.notification_channels,'["DASHBOARD","EMAIL"]'::jsonb) AS channels,
              COALESCE(cs.overdue_escalation_days,ARRAY[1,3,7,14]) AS overdue_days,
              (SELECT u.id FROM users u
                WHERE u.organization_id=o.id AND u.is_active=TRUE AND u.role IN ('admin','super_admin')
                ORDER BY CASE WHEN u.role='super_admin' THEN 0 ELSE 1 END,u.id LIMIT 1) AS admin_user_id,
              (CURRENT_TIMESTAMP AT TIME ZONE COALESCE(cs.timezone,'Asia/Kolkata'))::date AS today
         FROM organizations o LEFT JOIN compliance_settings cs ON cs.organization_id=o.id
        WHERE o.is_active=TRUE
     ),
     events AS (
       SELECT i.organization_id,i.site_id,'COMPLIANCE'::text AS entity_type,i.id AS entity_id,
              i.title,i.current_due_date AS due_date,
              COALESCE(i.assigned_to,i.reviewing_manager_id,i.approving_authority_id) AS recipient_user_id,
              i.reminder_days,i.reviewing_manager_id AS escalation_user_id,i.status
         FROM compliance_items i WHERE i.deleted_at IS NULL
           AND i.status NOT IN ('COMPLETED','NOT_APPLICABLE','CANCELLED')
       UNION ALL
       SELECT l.organization_id,l.site_id,'LICENCE',l.id,l.name,l.expiry_date,
              l.responsible_person_id,l.reminder_days,NULL,l.renewal_status
         FROM compliance_licences l WHERE l.deleted_at IS NULL AND l.expiry_date IS NOT NULL
       UNION ALL
       SELECT c.organization_id,c.site_id,'LEGAL_CASE',c.id,c.title,c.next_hearing_date::date,
              c.internal_owner_id,ARRAY[30,15,7,3,1,0],NULL,c.status
         FROM legal_cases c WHERE c.deleted_at IS NULL AND c.next_hearing_date IS NOT NULL
           AND c.status NOT IN ('CLOSED','SETTLED')
       UNION ALL
       SELECT n.organization_id,n.site_id,'LEGAL_NOTICE',n.id,n.subject,n.reply_due_date,
              n.responsible_person_id,ARRAY[30,15,7,3,1,0],n.reviewing_manager_id,n.status
         FROM legal_notices n WHERE n.deleted_at IS NULL AND n.reply_due_date IS NOT NULL
           AND n.status NOT IN ('CLOSED','REPLY_SUBMITTED')
       UNION ALL
       SELECT x.organization_id,x.site_id,'INSPECTION',x.id,x.inspection_type,x.scheduled_at::date,
              x.responsible_person_id,ARRAY[15,7,3,1,0],NULL,x.status
         FROM compliance_inspections x WHERE x.deleted_at IS NULL
           AND x.status NOT IN ('COMPLETED','CANCELLED')
       UNION ALL
       SELECT d.organization_id,d.site_id,'DOCUMENT',d.id,d.title,d.expiry_date,
              d.uploaded_by,ARRAY[180,90,60,30,15,7,0],NULL,d.verification_status
         FROM compliance_documents d WHERE d.deleted_at IS NULL AND d.expiry_date IS NOT NULL
     )
     SELECT e.*,s.today,s.channels,s.overdue_days,
            (e.due_date-s.today)::int AS days_remaining,
            recipient.user_id AS delivery_user_id,
            u.name AS recipient_name,u.email AS recipient_email,u.phone AS recipient_phone,
            site.name AS site_name
       FROM events e
       JOIN settings s ON s.organization_id=e.organization_id
       CROSS JOIN LATERAL unnest(
         CASE
           WHEN e.due_date < s.today AND (s.today-e.due_date)::int >= 14
             THEN ARRAY[e.recipient_user_id,e.escalation_user_id,s.admin_user_id]
           WHEN e.due_date < s.today AND e.escalation_user_id IS NOT NULL
             THEN ARRAY[e.recipient_user_id,e.escalation_user_id]
           ELSE ARRAY[e.recipient_user_id]
         END
       ) recipient(user_id)
       LEFT JOIN users u ON u.id=recipient.user_id AND u.organization_id=e.organization_id AND u.is_active=TRUE
       LEFT JOIN sites site ON site.id=e.site_id
      WHERE e.due_date IS NOT NULL
        AND recipient.user_id IS NOT NULL
        AND u.id IS NOT NULL
        AND (
          (e.due_date >= s.today AND (e.due_date-s.today)::int = ANY(e.reminder_days))
          OR
          (e.due_date < s.today AND (s.today-e.due_date)::int = ANY(s.overdue_days))
        )`
  );
  return rows;
}

const actionPathFor = (event) => {
  if (event.entity_type === 'LEGAL_CASE') return `/legal/cases/${event.entity_id}`;
  if (event.entity_type === 'LEGAL_NOTICE') return `/legal/notices/${event.entity_id}`;
  if (event.entity_type === 'INSPECTION') return '/legal/inspections';
  if (event.entity_type === 'LICENCE') return '/compliance/licences';
  if (event.entity_type === 'DOCUMENT') return '/compliance/documents';
  return `/compliance/register/${event.entity_id}`;
};

async function dispatchChannel(event, channel, message) {
  if (channel === 'DASHBOARD') return { delivered: true };
  if (channel === 'EMAIL') {
    if (!event.recipient_email || !mailerEnabled()) {
      return { skipped: true, error: 'Recipient email or SMTP configuration missing' };
    }
    await sendComplianceReminderEmail({
      to: event.recipient_email,
      name: event.recipient_name,
      title: event.title || 'Compliance reminder',
      message,
      dueDate: event.due_date || event.scheduled_for,
      siteName: event.site_name,
      actionUrl: process.env.FRONTEND_URL
        ? `${process.env.FRONTEND_URL}${actionPathFor(event)}`
        : null,
    });
    return { delivered: true };
  }
  if (channel === 'SMS') {
    if (!event.recipient_phone || !isSmsQueueConfigured()) {
      return { skipped: true, error: 'Recipient phone or SMS queue configuration missing' };
    }
    const result = await enqueueSms([{
      to: event.recipient_phone,
      message,
      source: 'compliance',
      organization_id: event.organization_id,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
    }]);
    if (result.queued === 1) return { delivered: true, reference: 'SQS_QUEUED' };
    throw new Error(result.failed[0]?.error || 'SMS could not be queued');
  }
  if (channel === 'WHATSAPP') {
    const template = process.env.MSG91_COMPLIANCE_TEMPLATE;
    if (!event.recipient_phone || !template || !isWhatsAppConfigured()) {
      return { skipped: true, error: 'Recipient phone or approved compliance WhatsApp template missing' };
    }
    const result = await sendWATemplate(event.recipient_phone, template, {
      body_1: { type: 'text', value: event.recipient_name || 'Team member' },
      body_2: { type: 'text', value: event.title || 'Compliance reminder' },
      body_3: { type: 'text', value: String(event.due_date || event.scheduled_for || '') },
      body_4: { type: 'text', value: message },
    });
    if (result.success) return { delivered: true, reference: 'MSG91_ACCEPTED' };
    throw new Error(result.error || 'WhatsApp delivery failed');
  }
  return { skipped: true, error: `Unsupported notification channel: ${channel}` };
}

async function queueNotification(client, event, channel) {
  const overdue = event.days_remaining < 0;
  const notificationType = overdue ? `OVERDUE_${Math.abs(event.days_remaining)}` : `DUE_${event.days_remaining}`;
  const message = overdue
    ? `${event.title} is ${Math.abs(event.days_remaining)} day(s) overdue.`
    : event.days_remaining === 0
      ? `${event.title} is due today.`
      : `${event.title} is due in ${event.days_remaining} day(s).`;
  const insert = await client.query(
    `INSERT INTO compliance_notification_log
      (organization_id,site_id,entity_type,entity_id,recipient_user_id,channel,
       notification_type,scheduled_for,title,due_date,message,status,attempt_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING',0)
     ON CONFLICT (organization_id,entity_type,entity_id,recipient_user_id,channel,notification_type,scheduled_for)
     DO NOTHING RETURNING id`,
    [event.organization_id,event.site_id,event.entity_type,event.entity_id,event.delivery_user_id || event.recipient_user_id,
      channel,notificationType,event.today,event.title,event.due_date,message]
  );
  return Boolean(insert.rows[0]?.id);
}

async function processNotificationQueue(client, max = 300) {
  let delivered = 0;
  let retried = 0;
  for (let index = 0; index < max; index += 1) {
    await client.query('BEGIN');
    const { rows: claimed } = await client.query(
      `WITH candidate AS (
         SELECT id FROM compliance_notification_log
          WHERE (
            status='PENDING'
            OR (status='FAILED' AND attempt_count < 3
                AND last_attempt_at < NOW()-INTERVAL '15 minutes')
          )
            AND created_at >= NOW()-INTERVAL '7 days'
          ORDER BY CASE WHEN status='PENDING' THEN 0 ELSE 1 END,created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE compliance_notification_log n
          SET status='PROCESSING',attempt_count=attempt_count+1,last_attempt_at=NOW()
         FROM candidate
        WHERE n.id=candidate.id
       RETURNING n.*`
    );
    const claimedRow = claimed[0];
    if (!claimedRow) {
      await client.query('COMMIT');
      break;
    }
    const { rows: enriched } = await client.query(
      `SELECT n.*,u.id AS active_recipient_id,u.name AS recipient_name,u.email AS recipient_email,u.phone AS recipient_phone,
              s.name AS site_name
         FROM compliance_notification_log n
         LEFT JOIN users u ON u.id=n.recipient_user_id AND u.organization_id=n.organization_id AND u.is_active=TRUE
         LEFT JOIN sites s ON s.id=n.site_id AND s.organization_id=n.organization_id
        WHERE n.id=$1`,
      [claimedRow.id]
    );
    await client.query('COMMIT');
    const row = enriched[0];
    if (row.attempt_count > 1) retried += 1;
    if (!row.active_recipient_id) {
      await pool.query(
        `UPDATE compliance_notification_log SET status='SKIPPED',failure_reason='Recipient is inactive or missing' WHERE id=$1 AND status='PROCESSING'`,
        [row.id]
      );
      continue;
    }
    try {
      const result = await dispatchChannel(row, row.channel, row.message);
      await pool.query(
        `UPDATE compliance_notification_log
            SET status=$1,
                sent_at=CASE WHEN $1='DELIVERED' THEN NOW() ELSE sent_at END,
                delivery_reference=$2,failure_reason=$3
          WHERE id=$4 AND status='PROCESSING'`,
        [result.delivered ? 'DELIVERED' : 'SKIPPED', result.reference || null, result.error || null, row.id]
      );
      if (result.delivered) delivered += 1;
    } catch (error) {
      await pool.query(
        `UPDATE compliance_notification_log
            SET status='FAILED',failure_reason=$1
          WHERE id=$2 AND status='PROCESSING'`,
        [String(error.message || error).slice(0, 1000), row.id]
      );
    }
  }
  return { delivered, retried };
}

export async function runComplianceScheduler() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('compliance_scheduler_hourly'))`);
    const generated = await generateRecurringItems(client);
    const overdue = await refreshOverdueAndRisk(client);
    const events = await dueNotifications(client);
    let queued = 0;
    for (const event of events) {
      const channels = Array.isArray(event.channels) ? event.channels : ['DASHBOARD'];
      for (const channel of channels) {
        if (await queueNotification(client, event, String(channel).toUpperCase())) queued += 1;
      }
    }
    await client.query('COMMIT');
    const { delivered, retried } = await processNotificationQueue(client);
    if (generated || overdue || queued || delivered) {
      console.log(`[compliance] generated=${generated} overdue=${overdue} queued=${queued} delivered=${delivered}`);
    }
    return { generated, overdue, queued, delivered, retried };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[compliance] scheduler failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

export function startComplianceScheduler() {
  if (timer || process.env.COMPLIANCE_SCHEDULER === 'off') return;
  const tick = () => runComplianceScheduler().catch(() => {});
  timer = setInterval(tick, HOUR_MS);
  timer.unref?.();
  setTimeout(tick, 30_000).unref?.();
  console.log('[compliance] hourly scheduler started');
}

export function stopComplianceScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
