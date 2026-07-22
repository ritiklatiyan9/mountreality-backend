import express from 'express';
const router = express.Router();

import {
  getPlotsForCommission,
  createPlotCommission,
  listPlotCommissions,
  getPlotCommissionDetail,
  getPlotCommissionByPlot,
  createPlotCommissionPayment,
  updatePlotCommissionPayment,
  deletePlotCommissionPayment,
  bulkDeletePlotCommissionPayments,
  getPlotCommissionAnalytics,
  updatePlotCommission,
  deletePlotCommission
} from '../controllers/plotCommissionV2.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const plotCommissionReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'plot-commissions' });
// /plots is just the list of plots a commission can be assigned to — it
// rarely changes, so it gets its own namespace with a longer TTL and is
// NOT busted by every commission/payment write.
const plotsForCommissionCache = cacheResponse({ ttlSeconds: 300, namespace: 'plot-commissions-plots' });
// Anchored prefix so the dedicated cache survives writes.
const bustPlotCommissionCache = invalidateCacheOnSuccess(['plot-commissions|']);

// All routes require auth
router.use(authMiddleware);

// These permissions use the existing 'commissions' module permission identifier for backward compatibility/simplicity
router.get('/plots', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), plotsForCommissionCache, getPlotsForCommission);
router.post('/create', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'write'), bustPlotCommissionCache, createPlotCommission);
router.get('/list', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), plotCommissionReadCache, listPlotCommissions);

// Payment routes (more specific, must come before /:id routes)
router.post('/payment', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'write'), bustPlotCommissionCache, createPlotCommissionPayment);
router.put('/payment/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'update'), bustPlotCommissionCache, updatePlotCommissionPayment);
router.delete('/payment/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'delete'), bustPlotCommissionCache, deletePlotCommissionPayment);
router.post('/payment/bulk-delete', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'delete'), bustPlotCommissionCache, bulkDeletePlotCommissionPayments);

// Analytics route (more specific, must come before /:id routes)
router.get('/analytics/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), plotCommissionReadCache, getPlotCommissionAnalytics);

// Plot-level detail route (all commissions for a plot)
router.get('/plot/:plotId', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), plotCommissionReadCache, getPlotCommissionByPlot);

// Master commission routes (less specific, come last)
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), plotCommissionReadCache, getPlotCommissionDetail);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'update'), bustPlotCommissionCache, updatePlotCommission);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'delete'), bustPlotCommissionCache, deletePlotCommission);

export default router;
