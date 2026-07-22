import express from 'express';
const router = express.Router();

import {
  listMaterials, createMaterial, updateMaterial, deleteMaterial, getMaterial,
  listMovements, createMovement, inventorySummary, receiveVendorOrder,
} from '../controllers/inventory.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

router.use(authMiddleware);

// Receiving changes received_qty on cached vendor order lists.
router.post('/vendor-orders/:orderId/receive', requirePermission('inventory', 'write'),
  invalidateCacheOnSuccess(['vendors|']), receiveVendorOrder);

// Dashboard summary + stock history
router.get('/summary', requirePermission('inventory', 'read'), inventorySummary);
router.get('/movements', requirePermission('inventory', 'read'), listMovements);
router.post('/movements', requirePermission('inventory', 'write'), createMovement);

// Material master
router.get('/materials', requirePermission('inventory', 'read'), listMaterials);
router.post('/materials', requirePermission('inventory', 'write'), createMaterial);
router.get('/materials/:id', requirePermission('inventory', 'read'), getMaterial);
router.put('/materials/:id', requirePermission('inventory', 'update'), updateMaterial);
router.delete('/materials/:id', requirePermission('inventory', 'delete'), deleteMaterial);

export default router;
