import pool from '../config/db.js';
import { syncComplianceEvent } from '../services/googleCalendarSync.service.js';

let synced = 0;
let failed = 0;
try {
  const { rows } = await pool.query(
    `SELECT e.organization_id,e.id
       FROM scheduled_events e
       JOIN google_calendar_connections c
         ON c.organization_id=e.organization_id AND c.status='active'
      WHERE e.deleted_at IS NULL AND e.status='SCHEDULED' AND e.event_date >= CURRENT_DATE
      ORDER BY e.organization_id,e.event_date,e.event_time,e.id`,
  );
  for (const event of rows) {
    try {
      await syncComplianceEvent(event.organization_id, 'SCHEDULED_EVENT', event.id);
      synced += 1;
    } catch (error) {
      failed += 1;
      console.error(`[gcal] phone reminder sync failed for event ${event.id}:`, error.message);
    }
  }
  console.log(JSON.stringify({ targeted: rows.length, synced, failed }));
} finally {
  await pool.end();
}
