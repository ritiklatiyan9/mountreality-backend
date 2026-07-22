import express from 'express';
import { getBalanceSheet } from '../controllers/balanceSheet.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse } from '../middlewares/cache.middleware.js';

const router = express.Router();

router.use(authMiddleware);
router.get(
  '/',
  requireRole('admin', 'sub_admin'),
  requirePermission('balance_sheet', 'read'),
  cacheResponse({ ttlSeconds: 30, namespace: 'balance-sheet' }),
  getBalanceSheet,
);

export default router;
