import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import requireUpiSiteAccess from '../middlewares/upiSiteAccess.middleware.js';
import {
  createBankAccount,
  deleteBankAccount,
  getBankAccountLedger,
  listBankAccountOptions,
  listBankAccounts,
  updateBankAccount,
} from '../controllers/bankAccount.controller.js';

const router = express.Router();
const accessByQuerySite = requireUpiSiteAccess({ entity: 'site', source: 'query', key: 'site_id' });
const accessByBodySite = requireUpiSiteAccess({ entity: 'site', source: 'body', key: 'site_id' });
const accessByParamAccount = requireUpiSiteAccess({ entity: 'account', source: 'params', key: 'id' });

router.use(authMiddleware);
router.use(requireRole('admin', 'sub_admin'));

// Minimal, masked options are available to every authenticated Site operator;
// the transaction endpoint itself still enforces its module permission.
router.get('/options', accessByQuerySite, listBankAccountOptions);
router.get('/', requirePermission('plot_payments', 'read'), accessByQuerySite, listBankAccounts);
router.post('/', requirePermission('plot_payments', 'write'), accessByBodySite, createBankAccount);
router.get('/:id/transactions', requirePermission('plot_payments', 'read'), accessByParamAccount, accessByQuerySite, getBankAccountLedger);
router.put('/:id', requirePermission('plot_payments', 'update'), accessByParamAccount, updateBankAccount);
router.delete('/:id', requirePermission('plot_payments', 'delete'), accessByParamAccount, deleteBankAccount);

export default router;
