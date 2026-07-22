import express from 'express';
const router = express.Router();

import {
	createSubAdmin,
	listSubAdmins,
	updateSubAdmin,
	deleteSubAdmin,
	listApprovers,
	updateManagedUserAccess,
	resetManagedUserPassword,
	listApprovalManagers,
	updateApprovalManager,
} from '../controllers/admin.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const adminReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'admin' });
const bustAdminCache = invalidateCacheOnSuccess(['/admin']);

// Approver list is needed by entry forms for both admin and sub-admin users.
router.get('/approvers', authMiddleware, requireRole('admin', 'sub_admin'), adminReadCache, listApprovers);

// Remaining routes are admin-only management routes.
router.use(authMiddleware, requireRole('admin'));

router.post('/sub-admins', bustAdminCache, createSubAdmin);
router.get('/sub-admins', adminReadCache, listSubAdmins);
router.put('/sub-admins/:id', bustAdminCache, updateSubAdmin);
router.delete('/sub-admins/:id', bustAdminCache, deleteSubAdmin);
router.patch('/sub-admins/:id/access', bustAdminCache, updateManagedUserAccess);
router.post('/sub-admins/:id/reset-password', bustAdminCache, resetManagedUserPassword);

// Approval Manager routes (admin only)
router.get('/approval-managers', adminReadCache, listApprovalManagers);
router.put('/approval-managers/:userId', bustAdminCache, updateApprovalManager);

export default router;
