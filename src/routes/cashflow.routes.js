import express from 'express';
const router = express.Router();

import {
  createMonth, listMonths, getMonth, updateMonth, deleteMonth,
  createEntry, listEntries, getAutocomplete, getEntry, updateEntry, deleteEntry, bulkDeleteEntries, listFirmsForCashFlow,
} from '../controllers/cashflow.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

// All cashflow routes require auth
router.use(authMiddleware);

const cashflowReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'cashflow' });
// Firms list + particulars autocomplete rarely change; longer TTL in a
// dedicated namespace so cashflow mutations don't bust them on every save.
const cashflowMetaCache = cacheResponse({ ttlSeconds: 300, namespace: 'cashflow-meta' });
// Anchored prefix so 'cashflow|...' is busted but 'cashflow-meta|...' survives.
const bustCashflowCache = invalidateCacheOnSuccess(['cashflow|', '/daybook']);

// ── Month endpoints ──
router.get('/months', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'read'), cashflowReadCache, listMonths);                                // ?site_id=X
router.get('/months/:id', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'read'), cashflowReadCache, getMonth);
router.post('/months', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'write'), bustCashflowCache, createMonth);
router.put('/months/:id', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'update'), bustCashflowCache, updateMonth);
router.delete('/months/:id', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'delete'), bustCashflowCache, deleteMonth);

// ── Entry endpoints ──
router.get('/entries', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'read'), cashflowReadCache, listEntries);                              // ?month_id=X
router.get('/entries/:id', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'read'), cashflowReadCache, getEntry);
router.post('/entries', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'write'), bustCashflowCache, createEntry);
router.put('/entries/:id', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'update'), bustCashflowCache, updateEntry);
router.delete('/entries/:id', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'delete'), bustCashflowCache, deleteEntry);
router.post('/entries/bulk-delete', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'delete'), bustCashflowCache, bulkDeleteEntries);

// ── Autocomplete (long-TTL meta cache, NOT busted by writes) ──
router.get('/autocomplete', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'read'), cashflowMetaCache, getAutocomplete);                     // ?site_id=X
router.get('/firms', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'read'), cashflowMetaCache, listFirmsForCashFlow);                       // ?site_id=X

export default router;
