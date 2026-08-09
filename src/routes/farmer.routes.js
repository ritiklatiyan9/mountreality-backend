import express from 'express';
const router = express.Router();

import {
  createFarmer,
  listFarmers,
  getFarmer,
  updateFarmer,
  deleteFarmer,
  bulkDeleteFarmers,
  createPayment,
  listPayments,
  updatePayment,
  deletePayment,
  bulkDeletePayments,
  listFarmerMembers,
  verifyFarmerReceipt,
} from '../controllers/farmer.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import requireFarmerSiteAccess from '../middlewares/farmerSiteAccess.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const farmerReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'farmers' });
// Member-list dropdown rarely changes; longer TTL in a separate namespace so
// farmer-payment writes don't bust it.
const farmerMembersCache = cacheResponse({ ttlSeconds: 300, namespace: 'farmers-members' });
// Farmer mutations affect daybook dashboard too. Anchored prefix so the
// "farmers-members" cache survives.
const bustFarmerCache = invalidateCacheOnSuccess(['farmers|', '/daybook']);

const accessByQuerySite = requireFarmerSiteAccess({ entity: 'site', source: 'query', key: 'site_id' });
const accessByBodySite = requireFarmerSiteAccess({ entity: 'site', source: 'body', key: 'site_id' });
const accessByParamFarmer = requireFarmerSiteAccess({ entity: 'farmer', source: 'params', key: 'id' });
const accessByParentFarmer = requireFarmerSiteAccess({ entity: 'farmer', source: 'params', key: 'farmerId' });
const accessByParamPayment = requireFarmerSiteAccess({ entity: 'payment', source: 'params', key: 'paymentId' });
const accessByBulkFarmers = requireFarmerSiteAccess({ entity: 'farmers', source: 'body', key: 'ids' });
const accessByBulkPayments = requireFarmerSiteAccess({ entity: 'payments', source: 'body', key: 'ids' });

// Public: verify receipt (no auth) — MUST be before authMiddleware
router.get('/verify-receipt', verifyFarmerReceipt);

// All farmer routes require auth
router.use(authMiddleware);

// Farmer members (for registration dropdown) — must come before /:id
router.get('/members', requireRole('admin', 'sub_admin'), accessByQuerySite, requirePermission('farmers', 'read'), farmerMembersCache, listFarmerMembers);

// Farmer CRUD
router.get('/', requireRole('admin', 'sub_admin'), accessByQuerySite, requirePermission('farmers', 'read'), farmerReadCache, listFarmers);                                     // ?site_id=X
router.get('/:id', requireRole('admin', 'sub_admin'), accessByParamFarmer, requirePermission('farmers', 'read'), farmerReadCache, getFarmer);
router.post('/', requireRole('admin', 'sub_admin'), accessByBodySite, requirePermission('farmers', 'write'), bustFarmerCache, createFarmer);
router.put('/:id', requireRole('admin', 'sub_admin'), accessByParamFarmer, requirePermission('farmers', 'update'), bustFarmerCache, updateFarmer);
router.delete('/:id', requireRole('admin', 'sub_admin'), accessByParamFarmer, requirePermission('farmers', 'delete'), bustFarmerCache, deleteFarmer);
router.post('/bulk-delete', requireRole('admin', 'sub_admin'), accessByBulkFarmers, requirePermission('farmers', 'delete'), bustFarmerCache, bulkDeleteFarmers);

// Farmer Payments (installments)
router.get('/:farmerId/payments', requireRole('admin', 'sub_admin'), accessByParentFarmer, requirePermission('farmers', 'read'), farmerReadCache, listPayments);
router.post('/:farmerId/payments', requireRole('admin', 'sub_admin'), accessByParentFarmer, requirePermission('farmers', 'write'), bustFarmerCache, createPayment);
router.put('/:farmerId/payments/:paymentId', requireRole('admin', 'sub_admin'), accessByParentFarmer, accessByParamPayment, requirePermission('farmers', 'update'), bustFarmerCache, updatePayment);
router.delete('/:farmerId/payments/:paymentId', requireRole('admin', 'sub_admin'), accessByParentFarmer, accessByParamPayment, requirePermission('farmers', 'delete'), bustFarmerCache, deletePayment);
router.post('/:farmerId/payments/bulk-delete', requireRole('admin', 'sub_admin'), accessByParentFarmer, accessByBulkPayments, requirePermission('farmers', 'delete'), bustFarmerCache, bulkDeletePayments);

export default router;
