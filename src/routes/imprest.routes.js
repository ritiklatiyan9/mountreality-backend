import express from 'express';
const router = express.Router();

import {
  createAllocation,
  listAllocations,
  cancelAllocation,
  getPendingReceipts,
  confirmReceipt,
  getBalance,
  getLedger,
  getAllBalances,
  createExpenseFromImprest,
  createExpenseRequest,
  listExpenseRequests,
  approveExpenseRequest,
  rejectExpenseRequest,
  adjustBalance,
  createReturn,
  listReturns,
  getPendingReturns,
  acceptReturn,
  rejectReturn,
  listTransferPeers,
} from '../controllers/imprest.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import requireImprestSiteAccess, { requireImprestParticipant } from '../middlewares/imprestSiteAccess.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const imprestReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'imprest' });
const bustImprestCache = invalidateCacheOnSuccess(['imprest|']);

const accessByQuerySite = requireImprestSiteAccess({ entity: 'site', source: 'query', key: 'site_id' });
const accessByRequiredBodySite = requireImprestSiteAccess({ entity: 'site', source: 'body', key: 'site_id', required: true });
const accessByAllocation = requireImprestSiteAccess({ entity: 'allocation', source: 'params', key: 'id' });
const accessByExpenseRequest = requireImprestSiteAccess({ entity: 'expenseRequest', source: 'params', key: 'id' });
const accessByReturn = requireImprestSiteAccess({ entity: 'return', source: 'params', key: 'id' });
const requireAllocationRecipient = requireImprestParticipant({ key: 'sub_admin_id', label: 'Recipient' });
const requireTargetUser = requireImprestParticipant({ key: 'user_id', label: 'Target user' });
const requireAssignedReviewer = requireImprestParticipant({
  key: 'assigned_admin_id',
  label: 'Assigned reviewer',
  required: false,
});

// All imprest routes require auth
router.use(authMiddleware);

// ── Balance & Ledger (any authenticated user) ──
router.get('/balance', requirePermission('imprest', 'read'), accessByQuerySite, imprestReadCache, getBalance);
router.get('/ledger', requirePermission('imprest', 'read'), accessByQuerySite, imprestReadCache, getLedger);
router.get('/peers', requirePermission('imprest', 'read'), accessByQuerySite, imprestReadCache, listTransferPeers);

// ── Pending receipts (sub-admin confirms received funds) ──
router.get('/pending-receipts', requirePermission('imprest', 'read'), accessByQuerySite, imprestReadCache, getPendingReceipts);
router.put('/allocations/:id/confirm', requirePermission('imprest', 'update'), accessByAllocation, bustImprestCache, confirmReceipt);

// ── Sub-admin creates expense from imprest ──
router.post('/expense', requirePermission('imprest', 'write'), accessByRequiredBodySite, requireAssignedReviewer, bustImprestCache, createExpenseFromImprest);

// ── Expense requests (overdraft flow) ──
router.get('/expense-requests', requirePermission('imprest', 'read'), accessByQuerySite, imprestReadCache, listExpenseRequests);
router.post('/expense-requests', requirePermission('imprest', 'write'), accessByRequiredBodySite, requireAssignedReviewer, bustImprestCache, createExpenseRequest);

// ── Allocations: admin → sub-admin OR sub-admin → sub-admin (peer transfer) ──
// Controller enforces role-specific rules (ledger debit for sub-admin giver, ownership check on cancel).
router.post('/allocations', requirePermission('imprest', 'write'), accessByRequiredBodySite, requireAllocationRecipient, requireAssignedReviewer, bustImprestCache, createAllocation);
router.get('/allocations', requirePermission('imprest', 'read'), accessByQuerySite, imprestReadCache, listAllocations);
router.delete('/allocations/:id', requirePermission('imprest', 'delete'), accessByAllocation, bustImprestCache, cancelAllocation);

// ── Admin-only routes ──
router.get('/all-balances', requireRole('admin'), accessByQuerySite, imprestReadCache, getAllBalances);
router.post('/adjust', requireRole('admin'), accessByRequiredBodySite, requireTargetUser, bustImprestCache, adjustBalance);

// ── Admin approve/reject expense requests ──
router.put('/expense-requests/:id/approve', requireRole('admin'), accessByExpenseRequest, bustImprestCache, approveExpenseRequest);
router.put('/expense-requests/:id/reject', requireRole('admin'), accessByExpenseRequest, bustImprestCache, rejectExpenseRequest);

// ── Imprest returns (sub-admin → admin money return) ──
router.post('/returns', requirePermission('imprest', 'write'), accessByRequiredBodySite, requireAssignedReviewer, bustImprestCache, createReturn);
router.get('/returns', requirePermission('imprest', 'read'), accessByQuerySite, imprestReadCache, listReturns);
router.get('/pending-returns', requireRole('admin'), accessByQuerySite, imprestReadCache, getPendingReturns);
router.put('/returns/:id/accept', requireRole('admin'), accessByReturn, bustImprestCache, acceptReturn);
router.put('/returns/:id/reject', requireRole('admin'), accessByReturn, bustImprestCache, rejectReturn);

export default router;
