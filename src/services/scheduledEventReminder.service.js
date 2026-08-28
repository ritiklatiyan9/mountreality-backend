import pool from '../config/db.js';
import { sendCalendarEventPush } from './firebasePush.service.js';
import { mailerEnabled, sendComplianceReminderEmail } from '../utils/mailer.js';

const DEFAULT_TICK_MS = 60 * 1000;
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
const REMINDER_NOTIFICATION_TYPES = Object.freeze({
  ONE_DAY_BEFORE: 'EVENT_REMINDER_ONE_DAY_BEFORE',
  ON_DAY: 'EVENT_REMINDER_ON_DAY',
  THIRTY_MINUTES_BEFORE: 'EVENT_REMINDER_THIRTY_MINUTES_BEFORE',
});

let timer = null;
let running = false;

const eventDate = (value) => String(value || '').slice(0, 10);

export const buildScheduledEventReminderContent = (event, reminderType) => {
  const time = event.calendar_event_time ? ` at ${event.calendar_event_time}` : '';
  const when = `${eventDate(event.event_date)}${time}`;
  if (reminderType === 'ONE_DAY_BEFORE') {
    return {
      title: `Event tomorrow: ${event.title}`,
      message: `${event.title} is scheduled tomorrow${time}.`,
      pushTitle: 'Calendar reminder · Tomorrow',
      pushBody: `${event.title} · ${when}`,
    };
  }
  if (reminderType === 'THIRTY_MINUTES_BEFORE') {
    return {
      title: `Event in 30 minutes: ${event.title}`,
      message: `${event.title} starts in 30 minutes${time}.`,
      pushTitle: 'Calendar reminder · 30 minutes',
      pushBody: `${event.title} · ${when}`,
    };
  }
  return {
    title: `Event today: ${event.title}`,
    message: `${event.title} is scheduled today${time}.`,
    pushTitle: 'Calendar reminder · Today',
    pushBody: `${event.title} · ${when}`,
  };
};

async function findDueReminders(client, now) {
  const { rows } = await client.query(
    `WITH base AS (
       SELECT e.id,e.organization_id,e.site_id,e.title,e.description,e.event_date,e.event_time,
              e.priority,e.created_by,e.created_at,s.name AS site_name,
              CASE
                WHEN e.event_time IS NULL
                  THEN (e.event_date + TIME '23:59:59') AT TIME ZONE 'Asia/Kolkata'
                ELSE (e.event_date + e.event_time) AT TIME ZONE 'Asia/Kolkata'
              END AS event_at,
              (e.event_date + TIME '00:00') AT TIME ZONE 'Asia/Kolkata' AS day_start_at,
              (e.event_date + TIME '09:00') AT TIME ZONE 'Asia/Kolkata' AS day_reminder_at
         FROM scheduled_events e
         LEFT JOIN sites s ON s.id=e.site_id AND s.organization_id=e.organization_id
        WHERE e.deleted_at IS NULL AND e.status='SCHEDULED'
     ),
     schedule AS (
       SELECT b.*,r.reminder_type,r.due_at
         FROM base b
         CROSS JOIN LATERAL (
           SELECT 'ONE_DAY_BEFORE'::varchar AS reminder_type,
                  CASE WHEN b.event_time IS NULL
                    THEN ((b.event_date-1) + TIME '09:00') AT TIME ZONE 'Asia/Kolkata'
                    ELSE b.event_at-INTERVAL '1 day'
                  END AS due_at
           UNION ALL
           SELECT 'ON_DAY'::varchar,
                  CASE WHEN b.event_at <= b.day_reminder_at
                    THEN GREATEST(b.day_start_at,b.event_at-INTERVAL '1 hour')
                    ELSE b.day_reminder_at
                  END
           UNION ALL
           SELECT 'THIRTY_MINUTES_BEFORE'::varchar,b.event_at-INTERVAL '30 minutes'
            WHERE b.event_time IS NOT NULL
         ) r
     )
     SELECT id,organization_id,site_id,title,description,
            to_char(event_date,'YYYY-MM-DD') AS event_date,
            CASE WHEN event_time IS NULL THEN NULL ELSE to_char(event_time,'HH12:MI AM') END AS calendar_event_time,
            priority,created_by,site_name,event_at,reminder_type,due_at
       FROM schedule
      WHERE due_at <= $1::timestamptz
        AND due_at >= $1::timestamptz-INTERVAL '36 hours'
        AND due_at >= created_at-INTERVAL '1 minute'
        AND event_at > $1::timestamptz
      ORDER BY due_at,id,reminder_type
      LIMIT 250`,
    [now],
  );
  return rows;
}

async function reminderRecipients(client, event) {
  const [{ rows: users }, { rows: emails }] = await Promise.all([
    client.query(
      `SELECT DISTINCT u.id,u.name,u.email
         FROM users u
        WHERE u.organization_id=$1 AND u.is_active=TRUE
          AND (
            u.id=$3
            OR u.role IN ('admin','super_admin')
            OR (
              EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id=u.id AND us.site_id=$2)
              AND EXISTS (
                SELECT 1 FROM user_permissions up
                 WHERE up.user_id=u.id AND up.module='compliance' AND up.can_read=TRUE
              )
            )
          )
        ORDER BY u.id`,
      [event.organization_id, event.site_id, event.created_by],
    ),
    client.query(
      `SELECT DISTINCT LOWER(TRIM(email)) AS email
         FROM (
           SELECT google_account_email AS email
             FROM google_calendar_connections
            WHERE organization_id=$1 AND status='active'
           UNION ALL
           SELECT email FROM google_calendar_notify_emails WHERE organization_id=$1
         ) connected
        WHERE NULLIF(TRIM(email),'') IS NOT NULL
        ORDER BY email`,
      [event.organization_id],
    ),
  ]);
  const emailRecipients = new Map();
  for (const user of users) {
    const email = String(user.email || '').trim().toLowerCase();
    if (email) emailRecipients.set(email, { email, userId: user.id });
  }
  for (const row of emails) {
    if (!emailRecipients.has(row.email)) emailRecipients.set(row.email, { email: row.email });
  }
  return { users, emails: [...emailRecipients.values()] };
}

async function insertDelivery(client, event, reminderType, channel, recipient) {
  const { rowCount } = await client.query(
    `INSERT INTO scheduled_event_reminder_deliveries
      (organization_id,site_id,event_id,reminder_type,channel,recipient_key,
       recipient_user_id,recipient_email,due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (organization_id,event_id,reminder_type,channel,recipient_key) DO NOTHING`,
    [event.organization_id, event.site_id, event.id, reminderType, channel,
      recipient.key, recipient.userId || null, recipient.email || null, event.due_at],
  );
  return rowCount;
}

async function enqueueDueReminders(client, now) {
  const reminders = await findDueReminders(client, now);
  let queued = 0;
  for (const event of reminders) {
    const { users, emails } = await reminderRecipients(client, event);
    for (const user of users) {
      const recipient = { key: `user:${user.id}`, userId: user.id };
      queued += await insertDelivery(client, event, event.reminder_type, 'DASHBOARD', recipient);
      queued += await insertDelivery(client, event, event.reminder_type, 'FCM', recipient);
    }
    for (const row of emails) {
      queued += await insertDelivery(client, event, event.reminder_type, 'EMAIL', {
        key: `email:${row.email}`,
        email: row.email,
        userId: row.userId,
      });
    }
  }
  return { reminders: reminders.length, queued };
}

async function claimDelivery() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `WITH candidate AS (
         SELECT id FROM scheduled_event_reminder_deliveries
          WHERE (
            status='PENDING'
            OR (status='FAILED' AND attempt_count < 3 AND last_attempt_at < NOW()-INTERVAL '5 minutes')
            OR (status='PROCESSING' AND attempt_count < 3 AND last_attempt_at < NOW()-INTERVAL '10 minutes')
          )
            AND due_at <= NOW()
            AND created_at >= NOW()-INTERVAL '7 days'
          ORDER BY due_at,id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE scheduled_event_reminder_deliveries d
          SET status='PROCESSING',attempt_count=attempt_count+1,last_attempt_at=NOW(),updated_at=NOW()
         FROM candidate
        WHERE d.id=candidate.id
       RETURNING d.*`,
    );
    const delivery = rows[0];
    if (!delivery) {
      await client.query('COMMIT');
      return null;
    }
    const { rows: enriched } = await client.query(
      `SELECT d.*,e.title,e.description,e.event_date,e.event_time,e.priority,e.status AS event_status,
              CASE WHEN e.event_time IS NULL THEN NULL ELSE to_char(e.event_time,'HH12:MI AM') END AS calendar_event_time,
              s.name AS site_name,u.name AS recipient_name,u.is_active AS recipient_active
         FROM scheduled_event_reminder_deliveries d
         JOIN scheduled_events e ON e.id=d.event_id AND e.organization_id=d.organization_id
         LEFT JOIN sites s ON s.id=d.site_id AND s.organization_id=d.organization_id
         LEFT JOIN users u ON u.id=d.recipient_user_id AND u.organization_id=d.organization_id
        WHERE d.id=$1`,
      [delivery.id],
    );
    await client.query('COMMIT');
    return enriched[0] || delivery;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function dispatchDelivery(delivery) {
  if (delivery.event_status !== 'SCHEDULED') {
    return { status: 'SKIPPED', error: 'Event is no longer scheduled' };
  }
  if (delivery.recipient_user_id && delivery.recipient_active !== true) {
    return { status: 'SKIPPED', error: 'Recipient is inactive or missing' };
  }
  const content = buildScheduledEventReminderContent(delivery, delivery.reminder_type);
  if (delivery.channel === 'DASHBOARD') {
    await pool.query(
      `INSERT INTO compliance_notification_log
        (organization_id,site_id,entity_type,entity_id,recipient_user_id,channel,
         notification_type,scheduled_for,title,due_date,message,status,attempt_count,sent_at,last_attempt_at)
       VALUES ($1,$2,'SCHEDULED_EVENT',$3,$4,'DASHBOARD',$5,
               ($6::timestamptz AT TIME ZONE 'Asia/Kolkata')::date,$7,$8,$9,'DELIVERED',1,NOW(),NOW())
       ON CONFLICT (organization_id,entity_type,entity_id,recipient_user_id,channel,notification_type,scheduled_for)
       DO NOTHING`,
      [delivery.organization_id, delivery.site_id, delivery.event_id, delivery.recipient_user_id,
        REMINDER_NOTIFICATION_TYPES[delivery.reminder_type], delivery.due_at, content.title,
        eventDate(delivery.event_date), content.message],
    );
    return { status: 'DELIVERED', reference: 'DASHBOARD_NOTIFICATION' };
  }
  if (delivery.channel === 'FCM') {
    const result = await sendCalendarEventPush({
      organizationId: delivery.organization_id,
      recipientUserIds: [delivery.recipient_user_id],
      event: delivery,
      title: content.pushTitle,
      body: content.pushBody,
      type: REMINDER_NOTIFICATION_TYPES[delivery.reminder_type],
      tag: `scheduled-event-${delivery.event_id}-${delivery.reminder_type.toLowerCase()}`,
    });
    if (!result.configured) return { status: 'SKIPPED', error: 'Firebase Admin is not configured' };
    if (!result.targeted) return { status: 'SKIPPED', error: 'Recipient has no active FCM token' };
    if (!result.sent) throw new Error(`FCM delivery failed for ${result.failed} token(s)`);
    return { status: 'DELIVERED', reference: JSON.stringify(result) };
  }
  if (delivery.channel === 'EMAIL') {
    if (!delivery.recipient_email || !mailerEnabled()) {
      return { status: 'SKIPPED', error: 'Connected email or SMTP configuration is missing' };
    }
    await sendComplianceReminderEmail({
      to: delivery.recipient_email,
      name: delivery.recipient_email,
      title: content.title,
      message: content.message,
      dueDate: `${eventDate(delivery.event_date)}${delivery.calendar_event_time ? ` ${delivery.calendar_event_time}` : ''}`,
      siteName: delivery.site_name,
      actionUrl: `${FRONTEND_URL}/compliance/calendar?date=${eventDate(delivery.event_date)}`,
    });
    return { status: 'DELIVERED', reference: 'SMTP_ACCEPTED' };
  }
  return { status: 'SKIPPED', error: `Unsupported channel: ${delivery.channel}` };
}

async function processDeliveryQueue(max = 300) {
  let delivered = 0;
  let skipped = 0;
  let failed = 0;
  for (let index = 0; index < max; index += 1) {
    const delivery = await claimDelivery();
    if (!delivery) break;
    try {
      const result = await dispatchDelivery(delivery);
      await pool.query(
        `UPDATE scheduled_event_reminder_deliveries
            SET status=$1,sent_at=CASE WHEN $1='DELIVERED' THEN NOW() ELSE sent_at END,
                delivery_reference=$2,failure_reason=$3,updated_at=NOW()
          WHERE id=$4 AND status='PROCESSING'`,
        [result.status, result.reference || null, result.error || null, delivery.id],
      );
      if (result.status === 'DELIVERED') delivered += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      await pool.query(
        `UPDATE scheduled_event_reminder_deliveries
            SET status='FAILED',failure_reason=$1,updated_at=NOW()
          WHERE id=$2 AND status='PROCESSING'`,
        [String(error.message || error).slice(0, 1000), delivery.id],
      );
    }
  }
  return { delivered, skipped, failed };
}

export async function runScheduledEventReminderScheduler({ now = new Date(), max = 300 } = {}) {
  const lockClient = await pool.connect();
  let locked = false;
  try {
    const { rows } = await lockClient.query(
      `SELECT pg_try_advisory_lock(hashtext('scheduled_event_reminder_scheduler')) AS locked`,
    );
    locked = rows[0]?.locked === true;
    if (!locked) return { skipped: true, reason: 'Another reminder worker is active' };
    const generated = await enqueueDueReminders(lockClient, now);
    const processed = await processDeliveryQueue(max);
    const result = { ...generated, ...processed };
    if (result.queued || result.delivered || result.failed) {
      console.log(`[calendar-reminders] due=${result.reminders} queued=${result.queued} delivered=${result.delivered} skipped=${result.skipped} failed=${result.failed}`);
    }
    return result;
  } catch (error) {
    console.error('[calendar-reminders] scheduler failed:', error.message);
    throw error;
  } finally {
    if (locked) {
      await lockClient.query(
        `SELECT pg_advisory_unlock(hashtext('scheduled_event_reminder_scheduler'))`,
      ).catch(() => {});
    }
    lockClient.release();
  }
}

export function startScheduledEventReminderScheduler() {
  if (timer || process.env.CALENDAR_REMINDER_SCHEDULER === 'off') return;
  const configured = Number(process.env.CALENDAR_REMINDER_INTERVAL_MS);
  const interval = Number.isFinite(configured) && configured >= 15_000 ? configured : DEFAULT_TICK_MS;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runScheduledEventReminderScheduler();
    } catch {
      // The scheduler reports its own error and retries on the next tick.
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, interval);
  timer.unref?.();
  setTimeout(tick, 10_000).unref?.();
  console.log(`[calendar-reminders] scheduler started (${Math.round(interval / 1000)}s interval)`);
}

export function stopScheduledEventReminderScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}
