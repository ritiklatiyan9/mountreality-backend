import express from 'express';
const router = express.Router();
import {
  getDashboardPermissions,
  getMyDashboardPermissions,
  updateDashboardPermissions,
  listUsersWithDashboardPermissions,
} from '../controllers/dashboardPermission.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

// User's own dashboard permissions rarely change — long-TTL cache.
// Per-user cache key (built from req.user.id by cache.middleware.js) keeps
// each user's state isolated.
const dashPermsMeCache = cacheResponse({ ttlSeconds: 300, namespace: 'dash-perms-me' });
const bustDashPermsCache = invalidateCacheOnSuccess(['dash-perms-me|']);

// Any logged-in user can fetch their own dashboard permissions
router.get('/me', authMiddleware, dashPermsMeCache, getMyDashboardPermissions);

// Admin-only: manage other users' dashboard component access
router.use(authMiddleware, requireRole('admin'));

router.get('/users', listUsersWithDashboardPermissions);
router.get('/:userId', getDashboardPermissions);
router.put('/:userId', bustDashPermsCache, updateDashboardPermissions);

export default router;
