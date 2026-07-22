import express from 'express';
const router = express.Router();

import { createSite, listSites, getSite, updateSite, deleteSite } from '../controllers/site.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const siteReadCache = cacheResponse({ ttlSeconds: 60, namespace: 'sites' });
const bustSiteCache = invalidateCacheOnSuccess(['/sites']);

// All site routes require auth
router.use(authMiddleware);

router.get('/', siteReadCache, listSites);                              // admin + sub_admin
router.get('/:id', siteReadCache, getSite);                             // admin + sub_admin (access-checked)
router.post('/', requireRole('admin'), bustSiteCache, createSite);      // admin only
router.put('/:id', requireRole('admin'), bustSiteCache, updateSite);    // admin only
router.delete('/:id', requireRole('admin'), bustSiteCache, deleteSite); // admin only

export default router;
