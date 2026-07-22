import express from 'express';
const router = express.Router();

import {
  listAllPending,
  getPendingCounts,
  approveEntry,
  rejectEntry,
  bulkApprove,
  bulkReject,
  updateChequeStatus,
  listChequeEntries,
} from '../controllers/approval.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const approvalReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'approvals' });
// Approval mutations affect all modules (expenses, farmers, plots, cashflow, daybook, etc.)
const bustApprovalCache = invalidateCacheOnSuccess(['/approvals', '/expenses', '/farmers', '/plots', '/cashflow', '/daybook', '/firms', '/registries']);

// All approval routes require auth + admin role or sub-admin with expense_approval permission
router.use(authMiddleware);
router.use(requireRole('admin', 'sub_admin'), requirePermission('expense_approval', 'read'));

router.get('/pending', approvalReadCache, listAllPending);           // ?site_id=X&date_from=&date_to=&module=
router.get('/counts', approvalReadCache, getPendingCounts);           // ?site_id=X
router.get('/cheques', approvalReadCache, listChequeEntries);         // ?site_id=X&status=PENDING|CLEARED|BOUNCED|RETURNED|all
router.put('/:id/approve', bustApprovalCache, approveEntry);          // ?source=farmer_payment|plot_commission|...
router.put('/:id/reject', bustApprovalCache, rejectEntry);            // ?source=...
router.post('/bulk-approve', bustApprovalCache, bulkApprove);         // { items: [{ id, source }] }
router.post('/bulk-reject', bustApprovalCache, bulkReject);           // { items: [{ id, source }] }
router.patch('/cheque-status', bustApprovalCache, updateChequeStatus); // { id, source, cheque_status }

export default router;
