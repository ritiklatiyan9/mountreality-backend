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
import requireCommissionSiteAccess from '../middlewares/commissionSiteAccess.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const plotCommissionReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'plot-commissions' });
// /plots is just the list of plots a commission can be assigned to — it
// rarely changes, so it gets its own namespace with a longer TTL and is
// NOT busted by every commission/payment write.
const plotsForCommissionCache = cacheResponse({ ttlSeconds: 300, namespace: 'plot-commissions-plots' });
// Anchored prefix so the dedicated cache survives writes.
const bustPlotCommissionCache = invalidateCacheOnSuccess(['plot-commissions|']);
const accessByQuerySite = requireCommissionSiteAccess({ entity: 'site', source: 'query', key: 'site_id' });
const accessByBodySite = requireCommissionSiteAccess({ entity: 'site', source: 'body', key: 'site_id' });
const accessByBodyPlot = requireCommissionSiteAccess({ entity: 'plot', source: 'body', key: 'plot_id' });
const accessByPlot = requireCommissionSiteAccess({ entity: 'plot', source: 'params', key: 'plotId' });
const accessByMaster = requireCommissionSiteAccess({ entity: 'master', source: 'params', key: 'id' });
const accessByBodyMaster = requireCommissionSiteAccess({ entity: 'master', source: 'body', key: 'master_id' });
const accessByPayment = requireCommissionSiteAccess({ entity: 'payment', source: 'params', key: 'id' });
const accessByBulkPayments = requireCommissionSiteAccess({ entity: 'payments', source: 'body', key: 'ids' });

// All routes require auth
router.use(authMiddleware);

// These permissions use the existing 'commissions' module permission identifier for backward compatibility/simplicity
router.get('/plots', requireRole('admin', 'sub_admin'), accessByQuerySite, requirePermission('commissions', 'read'), plotsForCommissionCache, getPlotsForCommission);
router.post('/create', requireRole('admin', 'sub_admin'), accessByBodySite, accessByBodyPlot, requirePermission('commissions', 'write'), bustPlotCommissionCache, createPlotCommission);
router.get('/list', requireRole('admin', 'sub_admin'), accessByQuerySite, requirePermission('commissions', 'read'), plotCommissionReadCache, listPlotCommissions);

// Payment routes (more specific, must come before /:id routes)
router.post('/payment', requireRole('admin', 'sub_admin'), accessByBodyMaster, requirePermission('commissions', 'write'), bustPlotCommissionCache, createPlotCommissionPayment);
router.put('/payment/:id', requireRole('admin', 'sub_admin'), accessByPayment, requirePermission('commissions', 'update'), bustPlotCommissionCache, updatePlotCommissionPayment);
router.delete('/payment/:id', requireRole('admin', 'sub_admin'), accessByPayment, requirePermission('commissions', 'delete'), bustPlotCommissionCache, deletePlotCommissionPayment);
router.post('/payment/bulk-delete', requireRole('admin', 'sub_admin'), accessByBulkPayments, requirePermission('commissions', 'delete'), bustPlotCommissionCache, bulkDeletePlotCommissionPayments);

// Analytics route (more specific, must come before /:id routes)
router.get('/analytics/:id', requireRole('admin', 'sub_admin'), accessByMaster, requirePermission('commissions', 'read'), plotCommissionReadCache, getPlotCommissionAnalytics);

// Plot-level detail route (all commissions for a plot)
router.get('/plot/:plotId', requireRole('admin', 'sub_admin'), accessByPlot, requirePermission('commissions', 'read'), plotCommissionReadCache, getPlotCommissionByPlot);

// Master commission routes (less specific, come last)
router.get('/:id', requireRole('admin', 'sub_admin'), accessByMaster, requirePermission('commissions', 'read'), plotCommissionReadCache, getPlotCommissionDetail);
router.put('/:id', requireRole('admin', 'sub_admin'), accessByMaster, requirePermission('commissions', 'update'), bustPlotCommissionCache, updatePlotCommission);
router.delete('/:id', requireRole('admin', 'sub_admin'), accessByMaster, requirePermission('commissions', 'delete'), bustPlotCommissionCache, deletePlotCommission);

export default router;
