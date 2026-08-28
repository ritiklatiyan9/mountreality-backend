import pool from '../config/db.js';
import { firebaseMessaging } from '../config/firebaseAdmin.js';

const INVALID_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);
const FCM_BATCH_SIZE = 500;
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

const chunks = (items, size) => Array.from(
  { length: Math.ceil(items.length / size) },
  (_, index) => items.slice(index * size, (index + 1) * size),
);

/** Best-effort calendar FCM delivery. Invalid tokens are retired automatically. */
export async function sendCalendarEventPush({
  organizationId, recipientUserIds, event, title, body, type = 'SCHEDULED_EVENT', tag,
}) {
  const messaging = firebaseMessaging();
  if (!messaging) return { configured: false, targeted: 0, sent: 0, failed: 0 };
  const userIds = [...new Set(recipientUserIds.map(Number).filter(Number.isInteger))];
  if (!userIds.length) return { configured: true, targeted: 0, sent: 0, failed: 0 };

  const { rows } = await pool.query(
    `SELECT id,token
       FROM firebase_web_push_tokens
      WHERE organization_id=$1 AND user_id=ANY($2::int[]) AND is_active=TRUE
      ORDER BY id`,
    [organizationId, userIds],
  );
  if (!rows.length) return { configured: true, targeted: 0, sent: 0, failed: 0 };

  const date = String(event.event_date).slice(0, 10);
  const eventId = event.event_id ?? event.id;
  const time = event.calendar_event_time ? ` at ${event.calendar_event_time}` : '';
  const notificationTitle = title || 'Calendar event scheduled';
  const notificationBody = body || `${event.title} · ${date}${time}`;
  const relativeLink = `/compliance/calendar?date=${date}`;
  const absoluteLink = `${FRONTEND_URL}${relativeLink}`;
  let sent = 0;
  let failed = 0;
  const invalidIds = [];
  const successfulIds = [];

  for (const batch of chunks(rows, FCM_BATCH_SIZE)) {
    try {
      const webpush = {
        headers: { Urgency: 'high' },
        notification: {
          title: notificationTitle,
          body: notificationBody,
          icon: '/favicon.svg',
          tag: tag || `scheduled-event-${eventId}`,
          renotify: true,
        },
      };
      if (absoluteLink.startsWith('https://')) webpush.fcmOptions = { link: absoluteLink };
      const response = await messaging.sendEachForMulticast({
        tokens: batch.map((row) => row.token),
        notification: { title: notificationTitle, body: notificationBody },
        data: {
          type,
          event_id: String(eventId),
          site_id: String(event.site_id),
          event_date: date,
          link: relativeLink,
        },
        webpush,
      });
      sent += response.successCount;
      failed += response.failureCount;
      response.responses.forEach((result, index) => {
        const row = batch[index];
        if (result.success) successfulIds.push(row.id);
        else if (INVALID_TOKEN_CODES.has(result.error?.code)) invalidIds.push(row.id);
      });
    } catch (error) {
      failed += batch.length;
      console.error('[fcm] calendar push batch failed:', error.message);
    }
  }

  if (successfulIds.length) {
    await pool.query(
      `UPDATE firebase_web_push_tokens
          SET last_sent_at=NOW(),last_error=NULL,updated_at=NOW()
        WHERE id=ANY($1::bigint[])`,
      [successfulIds],
    );
  }
  if (invalidIds.length) {
    await pool.query(
      `UPDATE firebase_web_push_tokens
          SET is_active=FALSE,last_error='FCM token expired or was unregistered',updated_at=NOW()
        WHERE id=ANY($1::bigint[])`,
      [invalidIds],
    );
  }
  return { configured: true, targeted: rows.length, sent, failed };
}

/** Browser push sent immediately when an event is first scheduled. */
export function sendScheduledEventPush({ organizationId, recipientUserIds, event }) {
  return sendCalendarEventPush({ organizationId, recipientUserIds, event });
}
