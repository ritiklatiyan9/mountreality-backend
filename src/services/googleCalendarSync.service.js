import { google } from 'googleapis';
import pool from '../config/db.js';
import { encrypt, decrypt } from '../utils/tokenCrypto.js';

/**
 * Best-effort push of compliance events to the organization's connected
 * Google Calendar. One Google account is connected per organization; the
 * configured notify emails ride along as attendees so Google delivers the
 * invite to their phones. Sync is never allowed to fail the primary request —
 * call sites go through queueCalendarSync, which swallows and logs.
 */

const TIME_ZONE = 'Asia/Kolkata'; // matches complianceCalendar's display timezone

// Mirrors the union in compliance.controller complianceCalendar(): where each
// event type's title/date live, and whether the date carries a time of day.
export const SOURCES = Object.freeze({
  COMPLIANCE: { table: 'compliance_items', titleField: 'title', dateField: 'current_due_date', timed: false },
  LEGAL_HEARING: { table: 'legal_cases', titleField: 'title', dateField: 'next_hearing_date', timed: true },
  NOTICE_REPLY: { table: 'legal_notices', titleField: 'subject', dateField: 'reply_due_date', timed: false },
  INSPECTION: { table: 'compliance_inspections', titleField: 'inspection_type', dateField: 'scheduled_at', timed: true },
  LICENCE_EXPIRY: { table: 'compliance_licences', titleField: 'name', dateField: 'expiry_date', timed: false },
  SCHEDULED_EVENT: {
    table: 'scheduled_events', titleField: 'title', dateField: 'event_date', timeField: 'event_time',
    descriptionField: 'description', timed: false,
  },
});

const EVENT_LABELS = Object.freeze({
  COMPLIANCE: 'Compliance deadline',
  LEGAL_HEARING: 'Legal hearing',
  NOTICE_REPLY: 'Notice reply due',
  INSPECTION: 'Inspection',
  LICENCE_EXPIRY: 'Licence expiry',
  SCHEDULED_EVENT: 'Scheduled calendar event',
});

const isConfigured = () =>
  Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    && process.env.GOOGLE_REDIRECT_URI && process.env.CALENDAR_TOKEN_ENC_KEY);

export const buildOAuthClient = () => new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI,
);

const ymd = (value) => {
  const d = value instanceof Date ? value : new Date(value);
  const shifted = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 10);
};

const nextDay = (dateStr) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

// Google Calendar popup reminders surface through the native Calendar app on
// phones signed into the connected account. Direct email reminders are sent by
// scheduledEventReminder.service, so Google only handles the mobile popup path.
const scheduledEventCalendarReminders = (optionalTime) => {
  if (!optionalTime) {
    return [
      { method: 'popup', minutes: 1440 },
      { method: 'popup', minutes: 0 },
    ];
  }
  const [hours, minutes] = optionalTime.split(':').map(Number);
  const startMinutes = (hours * 60) + minutes;
  const onDayMinutes = startMinutes > 540
    ? startMinutes - 540
    : Math.min(60, startMinutes);
  return [...new Set([1440, onDayMinutes, 30])]
    .map((offset) => ({ method: 'popup', minutes: offset }));
};

/** Pure event-body builder — exercised directly by the sanity check script. */
export const buildEventBody = (eventType, row, attendeeEmails = []) => {
  const cfg = SOURCES[eventType];
  const label = EVENT_LABELS[eventType];
  const title = row[cfg.titleField] || label;
  const dateValue = row[cfg.dateField];
  const descriptionLines = [
    label,
    row.status ? `Status: ${row.status}` : null,
    row.risk_level ? `Risk: ${row.risk_level}` : null,
    row.priority ? `Priority: ${row.priority}` : null,
    row.location ? `Location: ${row.location}` : null,
    cfg.descriptionField && row[cfg.descriptionField]
      ? String(row[cfg.descriptionField]).trim()
      : null,
  ].filter(Boolean);

  let start;
  let end;
  const optionalTime = cfg.timeField && row[cfg.timeField]
    ? String(row[cfg.timeField]).slice(0, 8)
    : null;
  if (cfg.timed || optionalTime) {
    const datePart = typeof dateValue === 'string' ? dateValue.slice(0, 10) : ymd(dateValue);
    const startDate = optionalTime
      ? new Date(`${datePart}T${optionalTime}+05:30`)
      : (dateValue instanceof Date ? dateValue : new Date(dateValue));
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); // 1h default duration
    start = { dateTime: startDate.toISOString(), timeZone: TIME_ZONE };
    end = { dateTime: endDate.toISOString(), timeZone: TIME_ZONE };
  } else {
    const dateStr = typeof dateValue === 'string' ? dateValue.slice(0, 10) : ymd(dateValue);
    start = { date: dateStr };
    end = { date: nextDay(dateStr) }; // Google all-day end date is exclusive
  }

  return {
    summary: title,
    description: descriptionLines.join('\n'),
    start,
    end,
    attendees: attendeeEmails.map((email) => ({ email })),
    reminders: eventType === 'SCHEDULED_EVENT'
      ? { useDefault: false, overrides: scheduledEventCalendarReminders(optionalTime) }
      : { useDefault: true },
  };
};

/** Returns an authenticated calendar client for the org, or null if not connected. */
const orgCalendar = async (orgId) => {
  if (!isConfigured()) return null;
  const { rows } = await pool.query(
    `SELECT id, access_token_enc, refresh_token_enc, token_expiry
       FROM google_calendar_connections
      WHERE organization_id=$1 AND status='active' LIMIT 1`,
    [orgId],
  );
  const connection = rows[0];
  if (!connection) return null;

  const auth = buildOAuthClient();
  auth.setCredentials({
    access_token: decrypt(connection.access_token_enc),
    refresh_token: decrypt(connection.refresh_token_enc),
    expiry_date: connection.token_expiry ? new Date(connection.token_expiry).getTime() : undefined,
  });
  auth.on('tokens', (tokens) => {
    if (!tokens.access_token) return;
    pool.query(
      `UPDATE google_calendar_connections
          SET access_token_enc=$1, token_expiry=$2, updated_at=NOW()
        WHERE id=$3`,
      [encrypt(tokens.access_token), tokens.expiry_date ? new Date(tokens.expiry_date) : null, connection.id],
    ).catch((err) => console.error('[gcal] failed to persist refreshed token:', err.message));
  });
  return google.calendar({ version: 'v3', auth });
};

const deleteLinkedEvent = async (calendar, orgId, eventType, sourceId) => {
  const { rows } = await pool.query(
    `SELECT id, google_event_id FROM google_calendar_event_links
      WHERE organization_id=$1 AND event_type=$2 AND source_id=$3 LIMIT 1`,
    [orgId, eventType, sourceId],
  );
  if (!rows[0]) return;
  try {
    await calendar.events.delete({ calendarId: 'primary', eventId: rows[0].google_event_id, sendUpdates: 'all' });
  } catch (err) {
    if (![404, 410].includes(err?.code ?? err?.response?.status)) throw err;
  }
  await pool.query('DELETE FROM google_calendar_event_links WHERE id=$1', [rows[0].id]);
};

/**
 * Reconcile one internal event with Google Calendar: upsert while the source
 * row is live and dated, cancel when it is deleted or loses its date.
 */
export const syncComplianceEvent = async (orgId, eventType, sourceId) => {
  const cfg = SOURCES[eventType];
  if (!cfg) throw new Error(`Unknown calendar event type: ${eventType}`);
  const calendar = await orgCalendar(orgId);
  if (!calendar) return; // org not connected — nothing to do

  const { rows } = await pool.query(
    `SELECT * FROM ${cfg.table} WHERE id=$1 AND organization_id=$2 LIMIT 1`,
    [sourceId, orgId],
  );
  const row = rows[0];
  if (!row || row.deleted_at || !row[cfg.dateField]) {
    return deleteLinkedEvent(calendar, orgId, eventType, sourceId);
  }

  const { rows: emailRows } = await pool.query(
    'SELECT email FROM google_calendar_notify_emails WHERE organization_id=$1 ORDER BY email',
    [orgId],
  );
  const body = buildEventBody(eventType, row, emailRows.map((r) => r.email));

  const { rows: linkRows } = await pool.query(
    `SELECT id, google_event_id FROM google_calendar_event_links
      WHERE organization_id=$1 AND event_type=$2 AND source_id=$3 LIMIT 1`,
    [orgId, eventType, sourceId],
  );
  const link = linkRows[0];

  if (link) {
    try {
      await calendar.events.update({
        calendarId: 'primary', eventId: link.google_event_id, requestBody: body, sendUpdates: 'all',
      });
      await pool.query('UPDATE google_calendar_event_links SET updated_at=NOW() WHERE id=$1', [link.id]);
      console.log(`[gcal] updated ${eventType}#${sourceId} (org ${orgId}) → ${link.google_event_id}`);
      return;
    } catch (err) {
      if (![404, 410].includes(err?.code ?? err?.response?.status)) throw err;
      await pool.query('DELETE FROM google_calendar_event_links WHERE id=$1', [link.id]);
      // fall through to insert a fresh event
    }
  }

  const { data } = await calendar.events.insert({
    calendarId: 'primary', requestBody: body, sendUpdates: 'all',
  });
  await pool.query(
    `INSERT INTO google_calendar_event_links (organization_id, event_type, source_id, google_event_id)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (organization_id, event_type, source_id)
     DO UPDATE SET google_event_id=EXCLUDED.google_event_id, updated_at=NOW()`,
    [orgId, eventType, sourceId, data.id],
  );
  console.log(`[gcal] created ${eventType}#${sourceId} (org ${orgId}) → ${data.id}`);
};

/** Fire-and-forget hook for controllers — never throws into the request path. */
export const queueCalendarSync = (orgId, eventType, sourceId) => {
  syncComplianceEvent(orgId, eventType, sourceId).catch((err) => {
    console.error(`[gcal] sync ${eventType}#${sourceId} (org ${orgId}) failed:`, err.message);
  });
};

/**
 * Push every future-dated live event to the connected calendar. Runs after a
 * successful connect so existing records appear without waiting to be edited.
 * Sequential on purpose — one org's backfill stays far below API rate limits.
 */
export const backfillOrgEvents = async (orgId) => {
  let synced = 0;
  for (const [eventType, cfg] of Object.entries(SOURCES)) {
    const { rows } = await pool.query(
      `SELECT id FROM ${cfg.table}
        WHERE organization_id=$1 AND deleted_at IS NULL AND ${cfg.dateField} >= CURRENT_DATE`,
      [orgId],
    );
    for (const row of rows) {
      try {
        await syncComplianceEvent(orgId, eventType, row.id);
        synced += 1;
      } catch (err) {
        console.error(`[gcal] backfill ${eventType}#${row.id} (org ${orgId}) failed:`, err.message);
      }
    }
  }
  console.log(`[gcal] backfill complete for org ${orgId}: ${synced} events synced`);
  return synced;
};
