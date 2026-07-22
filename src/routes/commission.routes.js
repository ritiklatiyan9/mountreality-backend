import express from 'express';
const router = express.Router();

import {
  createCommission,
  listCommissions,
  getAutocomplete,
  getCommission,
  updateCommission,
  deleteCommission,
} from '../controllers/commission.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const commissionReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'commissions' });
const bustCommissionCache = invalidateCacheOnSuccess(['/commissions']);

// All commission routes require auth
router.use(authMiddleware);
// Commission CRUD
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), commissionReadCache, listCommissions);                           // ?site_id=X
router.get('/autocomplete', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), commissionReadCache, getAutocomplete);               // ?site_id=X
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), commissionReadCache, getCommission);
router.post('/', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'write'), bustCommissionCache, createCommission);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'update'), bustCommissionCache, updateCommission);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'delete'), bustCommissionCache, deleteCommission);

export default router;
