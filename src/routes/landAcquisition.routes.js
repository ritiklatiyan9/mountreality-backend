import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import requireLandAcquisitionSiteAccess from '../middlewares/landAcquisitionSiteAccess.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';
import {
  adoptLegacyLandAcquisition,
  completeLandAcquisition,
  confirmLandFinancialTerms,
  createLandAcquisition,
  getLandAcquisition,
  getLandAcquisitionOptions,
  getLandAcquisitionOverview,
  getLandAcquisitionReports,
  getLandownerAcquisitionSummary,
  listLandAcquisitions,
  listLandAcquisitionTransactions,
  recordLandAcquisitionPayment,
  reopenLandAcquisition,
  requireAdminForReopen,
  reverseLandAcquisitionPayment,
  saveLandAgreement,
  updateLandDetails,
} from '../controllers/landAcquisition.controller.js';

const router = express.Router();
const byQuerySite = requireLandAcquisitionSiteAccess({ entity: 'site', source: 'query', key: 'site_id' });
const byBodySite = requireLandAcquisitionSiteAccess({ entity: 'site', source: 'body', key: 'site_id' });
const byAcquisition = requireLandAcquisitionSiteAccess({ entity: 'acquisition', source: 'params', key: 'id' });
const landCache = cacheResponse({ ttlSeconds: 30, namespace: 'land-acquisitions' });
const bustLandCache = invalidateCacheOnSuccess(['land-acquisitions|', 'farmers|', '/daybook']);

router.use(authMiddleware, requireRole('admin', 'sub_admin'));

router.get('/overview', byQuerySite, requirePermission('farmers', 'read'), landCache, getLandAcquisitionOverview);
router.get('/options', byQuerySite, requirePermission('farmers', 'read'), landCache, getLandAcquisitionOptions);
router.get('/transactions', byQuerySite, requirePermission('farmers', 'read'), landCache, listLandAcquisitionTransactions);
router.get('/reports', byQuerySite, requirePermission('farmers', 'read'), landCache, getLandAcquisitionReports);
router.get('/landowners/:memberId/summary', byQuerySite, requirePermission('farmers', 'read'), landCache, getLandownerAcquisitionSummary);
router.get('/', byQuerySite, requirePermission('farmers', 'read'), landCache, listLandAcquisitions);
router.post('/', byBodySite, requirePermission('farmers', 'write'), bustLandCache, createLandAcquisition);

router.get('/:id', byAcquisition, requirePermission('farmers', 'read'), landCache, getLandAcquisition);
router.patch('/:id/land', byAcquisition, requirePermission('farmers', 'update'), bustLandCache, updateLandDetails);
router.post('/:id/agreements', byAcquisition, requirePermission('farmers', 'update'), bustLandCache, saveLandAgreement);
router.post('/:id/financial-terms', byAcquisition, requirePermission('farmers', 'update'), bustLandCache, confirmLandFinancialTerms);
router.post('/:id/transactions', byAcquisition, requirePermission('farmers', 'write'), bustLandCache, recordLandAcquisitionPayment);
router.post('/:id/transactions/:paymentId/reverse', byAcquisition, requirePermission('farmers', 'update'), bustLandCache, reverseLandAcquisitionPayment);
router.post('/:id/complete', byAcquisition, requirePermission('farmers', 'update'), bustLandCache, completeLandAcquisition);
router.post('/:id/reopen', byAcquisition, requireAdminForReopen, requirePermission('farmers', 'update'), bustLandCache, reopenLandAcquisition);
router.post('/:id/adopt-legacy', byAcquisition, requirePermission('farmers', 'update'), bustLandCache, adoptLegacyLandAcquisition);

export default router;
