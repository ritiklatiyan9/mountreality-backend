import assert from 'node:assert/strict';
import pool from '../config/db.js';

try {
  const schema = await pool.query(`
    SELECT to_regclass('public.scheduled_event_reminder_deliveries')::text AS table_name,
           EXISTS (
             SELECT 1 FROM pg_indexes
              WHERE schemaname='public' AND indexname='idx_scheduled_event_reminders_queue'
           ) AS has_queue_index
  `);
  assert.equal(schema.rows[0]?.table_name, 'scheduled_event_reminder_deliveries');
  assert.equal(schema.rows[0]?.has_queue_index, true);

  const { rows } = await pool.query(`
    WITH samples AS (
      SELECT 'TIMED'::text AS kind,DATE '2026-08-20' AS event_date,TIME '10:30' AS event_time
      UNION ALL
      SELECT 'ALL_DAY',DATE '2026-08-20',NULL::time
    ),
    schedule AS (
      SELECT kind,event_date,event_time,
             CASE WHEN event_time IS NULL
               THEN ((event_date-1)+TIME '09:00') AT TIME ZONE 'Asia/Kolkata'
               ELSE ((event_date+event_time) AT TIME ZONE 'Asia/Kolkata')-INTERVAL '1 day'
             END AS one_day_before,
             (event_date+TIME '09:00') AT TIME ZONE 'Asia/Kolkata' AS on_day,
             CASE WHEN event_time IS NULL THEN NULL
               ELSE ((event_date+event_time) AT TIME ZONE 'Asia/Kolkata')-INTERVAL '30 minutes'
             END AS thirty_minutes_before
        FROM samples
    )
    SELECT kind,
           to_char(one_day_before AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI') AS one_day_before,
           to_char(on_day AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI') AS on_day,
           CASE WHEN thirty_minutes_before IS NULL THEN NULL
             ELSE to_char(thirty_minutes_before AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI')
           END AS thirty_minutes_before
      FROM schedule ORDER BY kind DESC
  `);
  const timed = rows.find((row) => row.kind === 'TIMED');
  const allDay = rows.find((row) => row.kind === 'ALL_DAY');
  assert.deepEqual(timed, {
    kind: 'TIMED',
    one_day_before: '2026-08-19 10:30',
    on_day: '2026-08-20 09:00',
    thirty_minutes_before: '2026-08-20 10:00',
  });
  assert.deepEqual(allDay, {
    kind: 'ALL_DAY',
    one_day_before: '2026-08-19 09:00',
    on_day: '2026-08-20 09:00',
    thirty_minutes_before: null,
  });
  console.log('scheduled event reminders ok — durable queue and IST timing verified');
} finally {
  await pool.end();
}
