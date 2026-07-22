import express from 'express';
import { forceLogoutSession, getTodayActivity } from '../controllers/activity.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const router = express.Router();

const activityReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'activity' });
const bustActivityCache = invalidateCacheOnSuccess(['/activity']);

// Only admin needs to see all activity metrics
router.get('/today', authMiddleware, requireRole('admin'), activityReadCache, getTodayActivity);
router.post('/logout-session', authMiddleware, requireRole('admin'), bustActivityCache, forceLogoutSession);

export default router;
