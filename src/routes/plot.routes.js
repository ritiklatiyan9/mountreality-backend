import express from 'express';
const router = express.Router();

import {
  createPlot, listPlots, searchPlots, getPlot, updatePlot, deletePlot,
  createPayment, listPayments, getPayment, updatePayment, deletePayment,
  getAutocomplete,
} from '../controllers/plot.controller.js';
import {
  updateInstallmentSettings, listInstallments, createInstallments,
  updateInstallment, deleteInstallment,
  recordInstallmentPayment, listInstallmentPayments,
  paymentManagementList, paymentReminders, paymentAnalytics,
  sendPaymentReminderSms, paymentReminderSmsLog,
} from '../controllers/installment.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import requirePlotSiteAccess from '../middlewares/plotSiteAccess.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

// All plot routes require auth
router.use(authMiddleware);

const plotReadCache = cacheResponse({ ttlSeconds: 45, namespace: 'plots' });
// Autocomplete (members + plot-payment fields like buyer_name/payment_from)
// rarely changes; long-TTL meta cache that survives plot/payment writes.
const plotMetaCache = cacheResponse({ ttlSeconds: 300, namespace: 'plots-meta' });
// Anchored prefix so 'plots-meta|...' isn't busted by writes.
const bustPlotCache = invalidateCacheOnSuccess(['plots|', '/daybook']);

const accessByQuerySite = requirePlotSiteAccess({ entity: 'site', source: 'query', key: 'site_id' });
const accessByBodySite = requirePlotSiteAccess({ entity: 'site', source: 'body', key: 'site_id' });
const accessByParamPlot = requirePlotSiteAccess({ entity: 'plot', source: 'params', key: 'id' });
const accessByQueryPlot = requirePlotSiteAccess({ entity: 'plot', source: 'query', key: 'plot_id' });
const accessByBodyPlot = requirePlotSiteAccess({ entity: 'plot', source: 'body', key: 'plot_id' });
const accessByParamPayment = requirePlotSiteAccess({ entity: 'payment', source: 'params', key: 'id' });
const accessByParamInstallment = requirePlotSiteAccess({ entity: 'installment', source: 'params', key: 'instId' });

// ── Plot endpoints ──
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), accessByQuerySite, plotReadCache, listPlots);                                        // ?site_id=X
router.get('/search', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), accessByQuerySite, plotReadCache, searchPlots);                                 // ?site_id=X&q=A67
router.get('/autocomplete', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), accessByQuerySite, plotMetaCache, getAutocomplete);                      // ?site_id=X
router.get('/payment-management', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), accessByQuerySite, plotReadCache, paymentManagementList);           // ?site_id=X
router.get('/payment-reminders', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), accessByQuerySite, plotReadCache, paymentReminders);                  // ?site_id=X&page=1&limit=10
router.get('/payment-analytics', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), accessByQuerySite, plotReadCache, paymentAnalytics);                   // ?site_id=X&mode=...
// SMS reminders — must stay above '/:id' so they aren't swallowed by the param route.
router.get('/payment-reminders/sms-log', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), accessByQuerySite, paymentReminderSmsLog);                     // ?site_id=X
router.post('/payment-reminders/sms', requireRole('admin'), requirePermission('plot_payments', 'write'), accessByBodySite, sendPaymentReminderSms);                                    // manual send
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), accessByParamPlot, plotReadCache, getPlot);
router.post('/', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'write'), accessByBodySite, bustPlotCache, createPlot);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'update'), accessByParamPlot, bustPlotCache, updatePlot);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'delete'), accessByParamPlot, bustPlotCache, deletePlot);

// ── Payment endpoints ──
router.get('/payments/list', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), accessByQueryPlot, plotReadCache, listPayments);                        // ?plot_id=X
router.get('/payments/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), accessByParamPayment, plotReadCache, getPayment);
router.post('/payments', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'write'), accessByBodyPlot, bustPlotCache, createPayment);
router.put('/payments/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'update'), accessByParamPayment, bustPlotCache, updatePayment);
router.delete('/payments/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'delete'), accessByParamPayment, bustPlotCache, deletePayment);

// ── Installment management endpoints ──
router.get('/:id/installments', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), accessByParamPlot, plotReadCache, listInstallments);
router.post('/:id/installments', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'write'), accessByParamPlot, bustPlotCache, createInstallments);
router.put('/installments/:instId', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'update'), accessByParamInstallment, bustPlotCache, updateInstallment);
router.delete('/installments/:instId', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'delete'), accessByParamInstallment, bustPlotCache, deleteInstallment);
router.put('/:id/installment-settings', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'update'), accessByParamPlot, bustPlotCache, updateInstallmentSettings);
router.post('/:id/installment-payment', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'write'), accessByParamPlot, bustPlotCache, recordInstallmentPayment);
router.get('/:id/installment-payments', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), accessByParamPlot, plotReadCache, listInstallmentPayments);

export default router;
