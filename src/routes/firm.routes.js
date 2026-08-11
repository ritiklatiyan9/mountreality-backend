import express from 'express';
const router = express.Router();

import {
  createFirm, listFirms, getFirm, updateFirm, deleteFirm,
  createTransaction, createFirmToFirmTransfer, listTransactions, getTransaction, updateTransaction, deleteTransaction, bulkDeleteTransactions,
  bulkCreateTransactions, getAutocomplete, listCashFlowLedgersForFirm, getFirmHistoryAnalytics,
} from '../controllers/firm.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';
import { requireEntitySiteAccess, requireBulkEntitySiteAccess } from '../middlewares/legacyEntitySiteAccess.middleware.js';

const firmReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'firms' });
// Autocomplete + cashflow-ledger dropdown rarely change; long-TTL meta
// cache that survives transaction writes.
const firmMetaCache = cacheResponse({ ttlSeconds: 300, namespace: 'firms-meta' });
// Anchored prefix so 'firms-meta|...' isn't busted by transaction writes.
const bustFirmCache = invalidateCacheOnSuccess(['firms|', '/daybook']);
// Firm CRUD also affects the meta cache (firm names appear in dropdowns).
const bustFirmAndMetaCache = invalidateCacheOnSuccess(['firms|', 'firms-meta|', '/daybook']);

// All firm routes require auth
router.use(authMiddleware);

// ── Firm endpoints ──
const firmById = requireEntitySiteAccess({ entity: 'firm', module: 'firm_transactions' });
const firmByQuery = requireEntitySiteAccess({ entity: 'firm', source: 'query', key: 'firm_id', module: 'firm_transactions' });
const firmByBody = requireEntitySiteAccess({ entity: 'firm', source: 'body', key: 'firm_id', module: 'firm_transactions' });
const transactionById = requireEntitySiteAccess({ entity: 'firm_transaction', module: 'firm_transactions' });
const transactionBulk = requireBulkEntitySiteAccess({
  module: 'firm_transactions',
  getItems: (req) => (req.body.ids || req.body.transaction_ids || []).map((id) => ({ entity: 'firm_transaction', id })),
});
const transactionFirmBulk = requireBulkEntitySiteAccess({
  module: 'firm_transactions',
  getItems: (req) => (req.body.transactions || []).map((row) => ({ entity: 'firm', id: row?.firm_id })),
});
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), firmReadCache, listFirms);                           // ?site_id=X
router.get('/list', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), firmReadCache, listFirms);                       // ?site_id=X
router.get('/autocomplete', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), firmMetaCache, getAutocomplete);         // ?site_id=X
router.get('/cashflow-ledgers', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), firmMetaCache, listCashFlowLedgersForFirm); // ?site_id=X
router.get('/history/analytics', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), firmReadCache, getFirmHistoryAnalytics);   // ?site_id=X
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), firmById, firmReadCache, getFirm);
router.post('/', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'write'), bustFirmAndMetaCache, createFirm);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'update'), firmById, bustFirmAndMetaCache, updateFirm);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'delete'), firmById, bustFirmAndMetaCache, deleteFirm);

// ── Transaction endpoints ──
router.get('/transactions/list', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), firmByQuery, firmReadCache, listTransactions);             // ?firm_id=X
router.post('/transactions/firm-to-firm', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'write'), bustFirmCache, createFirmToFirmTransfer);
router.get('/transactions/:id', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), transactionById, firmReadCache, getTransaction);
router.post('/transactions', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'write'), firmByBody, bustFirmCache, createTransaction);
router.post('/transactions/bulk', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'write'), transactionFirmBulk, bustFirmCache, bulkCreateTransactions);     // Bulk import
router.put('/transactions/:id', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'update'), transactionById, bustFirmCache, updateTransaction);
router.delete('/transactions/:id', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'delete'), transactionById, bustFirmCache, deleteTransaction);
router.post('/transactions/bulk-delete', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'delete'), transactionBulk, bustFirmCache, bulkDeleteTransactions);

export default router;
