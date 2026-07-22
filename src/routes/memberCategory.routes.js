import express from 'express';
const router = express.Router();

import {
    listCategories, createCategory, updateCategory, deleteCategory,
} from '../controllers/memberCategory.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const memberCategoryReadCache = cacheResponse({ ttlSeconds: 60, namespace: 'member-categories' });
const bustMemberCategoryCache = invalidateCacheOnSuccess(['member-categories|']);

router.use(authMiddleware);

// All authenticated users can list categories
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('clients', 'read'), memberCategoryReadCache, listCategories);

// Only admin can manage categories
router.post('/', requireRole('admin'), bustMemberCategoryCache, createCategory);
router.put('/:id', requireRole('admin'), bustMemberCategoryCache, updateCategory);
router.delete('/:id', requireRole('admin'), bustMemberCategoryCache, deleteCategory);

export default router;
