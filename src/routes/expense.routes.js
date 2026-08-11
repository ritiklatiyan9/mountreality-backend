import express from 'express';
const router = express.Router();

import {
  createExpense, listExpenses, getExpense,
  updateExpense, deleteExpense, bulkDeleteExpenses, getAutocomplete,
  listPendingExpenses, getStatusCounts,
  approveExpense, rejectExpense, bulkApproveExpenses,
} from '../controllers/expense.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';
import { requireEntitySiteAccess, requireBulkEntitySiteAccess, requireRequestSiteAccess } from '../middlewares/legacyEntitySiteAccess.middleware.js';

// All expense routes require auth
router.use(authMiddleware);

const expenseReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'expenses' });
// Autocomplete (DISTINCT scans across 7 columns) rarely changes; long-TTL
// meta cache that survives expense writes.
const expenseMetaCache = cacheResponse({ ttlSeconds: 300, namespace: 'expenses-meta' });
// Anchored prefix so 'expenses-meta|...' isn't busted by writes.
const bustExpenseCache = invalidateCacheOnSuccess(['expenses|', '/daybook', 'expenses:page:']);

// Standard expense CRUD
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('expenses', 'read'), expenseReadCache, listExpenses);                            // ?site_id=X
router.get('/autocomplete', requireRole('admin', 'sub_admin'), requirePermission('expenses', 'read'), requireRequestSiteAccess({ source: 'query', module: 'expenses' }), expenseMetaCache, getAutocomplete);             // ?site_id=X
router.get('/pending', requireRole('admin', 'sub_admin'), requirePermission('expense_approval', 'read'), requireRequestSiteAccess({ source: 'query', module: 'expense_approval' }), expenseReadCache, listPendingExpenses);     // Expense approval: get pending expenses
router.get('/status-counts', requireRole('admin', 'sub_admin'), requirePermission('expense_approval', 'read'), requireRequestSiteAccess({ source: 'query', module: 'expense_approval' }), expenseReadCache, getStatusCounts);   // Expense approval: get status counts
const expenseById = requireEntitySiteAccess({ entity: 'expense', module: 'expenses' });
const approvalEntity = (req) => req.query.source === 'daybook' ? 'daybook' : req.query.source === 'vendor_payment' ? 'vendor_payment' : 'expense';
const approvalById = requireEntitySiteAccess({ entity: approvalEntity, module: 'expenses' });
const expenseBulk = requireBulkEntitySiteAccess({
  module: 'expenses',
  getItems: (req) => (req.body.expense_ids || req.body.ids || req.body.items || []).map((item) => (
    typeof item === 'object'
      ? { id: item.id, entity: item.source === 'daybook' ? 'daybook' : item.source === 'vendor_payment' ? 'vendor_payment' : 'expense' }
      : { id: item, entity: 'expense' }
  )),
});
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('expenses', 'read'), expenseById, expenseReadCache, getExpense);
router.post('/', requireRole('admin', 'sub_admin'), requirePermission('expenses', 'write'), bustExpenseCache, createExpense);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('expenses', 'update'), expenseById, bustExpenseCache, updateExpense);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('expenses', 'delete'), expenseById, bustExpenseCache, deleteExpense);
router.post('/bulk-delete', requireRole('admin', 'sub_admin'), requirePermission('expenses', 'delete'), expenseBulk, bustExpenseCache, bulkDeleteExpenses);

// Approval routes (admin or sub-admin with expense_approval permission)
router.put('/:id/approve', requireRole('admin', 'sub_admin'), requirePermission('expense_approval', 'write'), approvalById, bustExpenseCache, approveExpense);
router.put('/:id/reject', requireRole('admin', 'sub_admin'), requirePermission('expense_approval', 'write'), approvalById, bustExpenseCache, rejectExpense);
router.post('/bulk-approve', requireRole('admin', 'sub_admin'), requirePermission('expense_approval', 'write'), expenseBulk, bustExpenseCache, bulkApproveExpenses);

export default router;
