import express from 'express';

import {
  addVendorPayment,
  createVendorCommitment,
  createVendorHead,
  deleteVendorHead,
  deleteVendorPayment,
  distributePaymentToItems,
  getVendorCommitmentDetail,
  getVendorPaymentReceipt,
  getVendorUsers,
  createVendorUser,
  listAllInventoryItems,
  deleteVendorCommitment,
  bulkDeleteVendorCommitments,
  bulkDeleteVendorPayments,
  listVendorCommitments,
  listVendorHeads,
  updateVendorCommitment,
  updateVendorCommitmentStatus,
  updateVendorPayment,
  updateVendorHead,
} from '../controllers/vendor.controller.js';
import {
  listInventoryOrders,
  getInventoryOrderDetail,
  createInventoryOrder,
  updateInventoryOrder,
  deleteInventoryOrder,
  addInventoryPayment,
  deleteInventoryPayment,
  listInventoryCategories,
  getInventoryStockSummary,
} from '../controllers/vendorInventory.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';
import { requireEntitySiteAccess, requireBulkEntitySiteAccess } from '../middlewares/legacyEntitySiteAccess.middleware.js';

const router = express.Router();

const vendorReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'vendors' });
// Vendor users + heads + categories rarely change; cache longer in a
// dedicated namespace and don't bust them on every commitment write.
const vendorMetaCache = cacheResponse({ ttlSeconds: 300, namespace: 'vendors-meta' });
// Anchored prefix so 'vendors|...' is busted but 'vendors-meta|...' survives.
const bustVendorCache = invalidateCacheOnSuccess(['vendors|']);
const bustVendorMetaCache = invalidateCacheOnSuccess(['vendors|', 'vendors-meta|']);

router.use(authMiddleware);
router.use(requireRole('admin', 'sub_admin'));

const vendorHeadById = requireEntitySiteAccess({ entity: 'vendor_head', module: 'vendors' });
const commitmentById = requireEntitySiteAccess({ entity: 'vendor_commitment', module: 'vendors' });
const paymentById = requireEntitySiteAccess({ entity: 'vendor_payment', source: 'params', key: 'paymentId', module: 'vendors' });
const orderById = requireEntitySiteAccess({ entity: 'inventory_order', module: 'vendors' });
const inventoryPaymentById = requireEntitySiteAccess({ entity: 'inventory_payment', source: 'params', key: 'paymentId', module: 'vendors' });
const commitmentBulk = requireBulkEntitySiteAccess({ module: 'vendors', getItems: (req) => (req.body.ids || []).map((id) => ({ entity: 'vendor_commitment', id })) });
const paymentBulk = requireBulkEntitySiteAccess({ module: 'vendors', getItems: (req) => (req.body.ids || []).map((id) => ({ entity: 'vendor_payment', id })) });

router.get('/users', requirePermission('vendors', 'read'), vendorMetaCache, getVendorUsers);
router.post('/users', requirePermission('vendors', 'write'), bustVendorMetaCache, createVendorUser);
router.get('/heads', requirePermission('vendors', 'read'), vendorMetaCache, listVendorHeads);
// Head writes also have to bust the vendors-meta cache (heads listing).
router.post('/heads', requirePermission('vendors', 'write'), bustVendorMetaCache, createVendorHead);
router.put('/heads/:id', requirePermission('vendors', 'update'), vendorHeadById, bustVendorMetaCache, updateVendorHead);
router.delete('/heads/:id', requirePermission('vendors', 'delete'), vendorHeadById, bustVendorMetaCache, deleteVendorHead);

router.get('/commitments', requirePermission('vendors', 'read'), vendorReadCache, listVendorCommitments);
router.get('/inventory-all', requirePermission('vendors', 'read'), vendorReadCache, listAllInventoryItems);
router.get('/commitments/:id', requirePermission('vendors', 'read'), commitmentById, vendorReadCache, getVendorCommitmentDetail);
router.get('/payments/:paymentId/receipt', requirePermission('vendors', 'read'), paymentById, vendorReadCache, getVendorPaymentReceipt);
router.post('/commitments', requirePermission('vendors', 'write'), bustVendorCache, createVendorCommitment);
router.put('/commitments/:id', requirePermission('vendors', 'update'), commitmentById, bustVendorCache, updateVendorCommitment);
router.delete('/commitments/:id', requirePermission('vendors', 'delete'), commitmentById, bustVendorCache, deleteVendorCommitment);
router.post('/commitments/bulk-delete', requirePermission('vendors', 'delete'), commitmentBulk, bustVendorCache, bulkDeleteVendorCommitments);
router.put('/commitments/:id/status', requirePermission('vendors', 'update'), commitmentById, bustVendorCache, updateVendorCommitmentStatus);
router.post('/commitments/:id/payments', requirePermission('vendors', 'write'), commitmentById, bustVendorCache, addVendorPayment);
router.post('/commitments/:id/distribute-payment', requirePermission('vendors', 'write'), commitmentById, bustVendorCache, distributePaymentToItems);
router.put('/payments/:paymentId', requirePermission('vendors', 'update'), paymentById, bustVendorCache, updateVendorPayment);
router.delete('/payments/:paymentId', requirePermission('vendors', 'delete'), paymentById, bustVendorCache, deleteVendorPayment);
router.post('/payments/bulk-delete', requirePermission('vendors', 'delete'), paymentBulk, bustVendorCache, bulkDeleteVendorPayments);

// ── Inventory ──────────────────────────────────────────────────────────────
router.get('/inventory/categories', requirePermission('vendors', 'read'), vendorMetaCache, listInventoryCategories);
router.get('/inventory/stock-summary', requirePermission('vendors', 'read'), vendorReadCache, getInventoryStockSummary);
router.get('/inventory', requirePermission('vendors', 'read'), vendorReadCache, listInventoryOrders);
router.post('/inventory', requirePermission('vendors', 'write'), bustVendorCache, createInventoryOrder);
router.get('/inventory/:id', requirePermission('vendors', 'read'), orderById, vendorReadCache, getInventoryOrderDetail);
router.put('/inventory/:id', requirePermission('vendors', 'update'), orderById, bustVendorCache, updateInventoryOrder);
router.delete('/inventory/:id', requirePermission('vendors', 'delete'), orderById, bustVendorCache, deleteInventoryOrder);

router.post('/inventory/:id/payments', requirePermission('vendors', 'write'), orderById, bustVendorCache, addInventoryPayment);
router.delete('/inventory/inv-payments/:paymentId', requirePermission('vendors', 'delete'), inventoryPaymentById, bustVendorCache, deleteInventoryPayment);

export default router;
