import express from 'express';
const router = express.Router();

import {
  listAccounts, createAccount, updateAccount, deleteAccount,
  createQr, listQrs, updateQrStatus, getDisplayQr, updateQr, deleteQr,
} from '../controllers/upi.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import requireUpiSiteAccess from '../middlewares/upiSiteAccess.middleware.js';

const accessByQuerySite = requireUpiSiteAccess({ entity: 'site', source: 'query', key: 'site_id' });
const accessByBodySite = requireUpiSiteAccess({ entity: 'site', source: 'body', key: 'site_id' });
const accessByBodyAccount = requireUpiSiteAccess({ entity: 'account', source: 'body', key: 'upi_account_id' });
const accessByParamAccount = requireUpiSiteAccess({ entity: 'account', source: 'params', key: 'id' });
const accessByParamQr = requireUpiSiteAccess({ entity: 'qr', source: 'params', key: 'id' });

router.use(authMiddleware);
router.use(requireRole('admin', 'sub_admin'));

// ── Bank accounts / VPAs ──
router.get('/accounts', requirePermission('upi_collect', 'read'), accessByQuerySite, listAccounts);
router.post('/accounts', requirePermission('upi_collect', 'write'), accessByBodySite, createAccount);
router.put('/accounts/:id', requirePermission('upi_collect', 'update'), accessByParamAccount, updateAccount);
router.delete('/accounts/:id', requirePermission('upi_collect', 'delete'), accessByParamAccount, deleteAccount);

// ── Dynamic QR log ──
router.get('/qrs/display', requirePermission('upi_collect', 'read'), accessByQuerySite, getDisplayQr);
router.get('/qrs', requirePermission('upi_collect', 'read'), accessByQuerySite, listQrs);
router.post('/qrs', requirePermission('upi_collect', 'write'), accessByBodySite, accessByBodyAccount, createQr);
router.put('/qrs/:id/status', requirePermission('upi_collect', 'update'), accessByParamQr, updateQrStatus);
router.put('/qrs/:id', requirePermission('upi_collect', 'update'), accessByParamQr, updateQr);
router.delete('/qrs/:id', requirePermission('upi_collect', 'delete'), accessByParamQr, deleteQr);

export default router;
