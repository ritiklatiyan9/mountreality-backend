import 'dotenv/config';
import http from 'http';
import app from './app.js';
import { connectDB } from './config/db.js';
import { initSocket } from './config/socket.js';
import { initCache } from './config/cache.js';
import { startSmsReminderScheduler, stopSmsReminderScheduler } from './services/smsReminder.service.js';
import { startComplianceScheduler, stopComplianceScheduler } from './services/complianceScheduler.service.js';
import { validateRuntimeConfig } from './config/runtime.js';
import pool from './config/db.js';

const PORT = process.env.PORT || 3000;

validateRuntimeConfig();

const server = http.createServer(app);

// Initialize Socket.io attached to the native HTTP server
initSocket(server);

initCache();

connectDB().then(async () => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
  startSmsReminderScheduler();
  startComplianceScheduler();
}).catch(err => {
  console.error('Failed to connect to DB', err);
  process.exit(1);
});

let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received; draining connections`);
  stopSmsReminderScheduler();
  stopComplianceScheduler();
  const forceExit = setTimeout(() => {
    console.error('[shutdown] graceful timeout exceeded');
    process.exit(1);
  }, 10_000);
  forceExit.unref?.();
  server.close(async () => {
    try {
      await pool.end();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      console.error('[shutdown] database pool close failed:', error.message);
      process.exit(1);
    }
  });
};

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
