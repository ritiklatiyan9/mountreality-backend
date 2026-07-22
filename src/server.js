import 'dotenv/config';
import http from 'http';
import app from './app.js';
import { connectDB } from './config/db.js';
import { initSocket } from './config/socket.js';
import { initCache } from './config/cache.js';
import { startSmsReminderScheduler } from './services/smsReminder.service.js';

const PORT = process.env.PORT || 3000;

const server = http.createServer(app);

// Initialize Socket.io attached to the native HTTP server
initSocket(server);

initCache();

connectDB().then(async () => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
  startSmsReminderScheduler();
}).catch(err => {
  console.error('Failed to connect to DB', err);
  process.exit(1);
});