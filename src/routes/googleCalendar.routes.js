import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import {
  getConnectUrl,
  oauthCallback,
  disconnect,
  getStatus,
  syncFutureEvents,
  addNotifyEmail,
  removeNotifyEmail,
} from '../controllers/googleCalendar.controller.js';

const router = express.Router();

// Google's browser redirect carries no auth header; the HMAC-signed state
// param (minted by the authenticated /connect call) authenticates this hit.
router.get('/google-calendar/callback', oauthCallback);

// Any authenticated user may see whether calendar sync is on; only admins
// may connect, disconnect, or edit the attendee list — same split as the
// other /settings routes (read open, writes admin-only).
router.get('/google-calendar/status', authMiddleware, getStatus);
router.get('/google-calendar/connect', authMiddleware, requireRole('admin'), getConnectUrl);
router.post('/google-calendar/disconnect', authMiddleware, requireRole('admin'), disconnect);
router.post('/google-calendar/sync', authMiddleware, requireRole('admin'), syncFutureEvents);
router.post('/google-calendar/emails', authMiddleware, requireRole('admin'), addNotifyEmail);
router.delete('/google-calendar/emails/:id', authMiddleware, requireRole('admin'), removeNotifyEmail);

export default router;
