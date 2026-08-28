import pool from '../config/db.js';
import { runScheduledEventReminderScheduler } from '../services/scheduledEventReminder.service.js';

try {
  const result = await runScheduledEventReminderScheduler();
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
