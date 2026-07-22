import express from 'express';
const router = express.Router();

import { getPermissions, updatePermissions } from '../controllers/permission.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const permissionReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'permissions' });
const bustPermissionCache = invalidateCacheOnSuccess(['permissions|']);

// All permission routes require authentication + admin role
router.use(authMiddleware, requireRole('admin'));

router.get('/:userId', permissionReadCache, getPermissions);
router.put('/:userId', bustPermissionCache, updatePermissions);

export default router;
