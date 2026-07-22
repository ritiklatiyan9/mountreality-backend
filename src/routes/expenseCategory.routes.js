import express from 'express';
const router = express.Router();

import {
    listExpenseCategories,
    createExpenseCategory,
    updateExpenseCategory,
    deleteExpenseCategory,
} from '../controllers/expenseCategory.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const expenseCategoryReadCache = cacheResponse({ ttlSeconds: 300, namespace: 'expense-categories' });
const bustExpenseCategoryCache = invalidateCacheOnSuccess(['expense-categories|']);

router.use(authMiddleware);

router.get('/', requirePermission('expenses', 'read'), expenseCategoryReadCache, listExpenseCategories);
router.post('/', requireRole('admin'), bustExpenseCategoryCache, createExpenseCategory);
router.put('/:id', requireRole('admin'), bustExpenseCategoryCache, updateExpenseCategory);
router.delete('/:id', requireRole('admin'), bustExpenseCategoryCache, deleteExpenseCategory);

export default router;
