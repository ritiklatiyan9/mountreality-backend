import express from 'express';
import {
  createEditRequest,
  listEditRequests,
  listMyEditRequests,
  getEditRequestCounts,
  approveEditRequest,
  rejectEditRequest,
} from '../controllers/editRequest.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import upload from '../middlewares/multer.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const router = express.Router();

const editRequestReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'edit-requests' });
// Cache keys are `<namespace>|u:<id>|<path>|<query>` — prefixes must be the
// namespace, not the URL path.
const bustEditRequestCache = invalidateCacheOnSuccess(['edit-requests|']);
// Approval applies the change to the target module's records (e.g.
// plot_registry_create creates a registry) — bust those read caches too.
const bustApprovalCaches = invalidateCacheOnSuccess([
  'edit-requests|', 'registries|', 'registries-meta|',
]);

// All routes require authentication
router.use(authMiddleware);

// Only administrators/sub-admins can enter the approval workflow. The
// controller applies the target module permission and record-site checks
// before reading or storing the original record.
router.post('/', requireRole('admin', 'sub_admin'), upload.single('proof_photo'), bustEditRequestCache, createEditRequest);

// Re-evaluate current site/module access on every request; caching this endpoint
// would keep revoked permissions visible for the cache TTL.
router.get('/my-requests', listMyEditRequests);

// Admin endpoints
router.get('/', requireRole('admin'), editRequestReadCache, listEditRequests);
router.get('/counts', requireRole('admin'), editRequestReadCache, getEditRequestCounts);
router.put('/:id/approve', requireRole('admin'), upload.single('review_photo'), bustApprovalCaches, approveEditRequest);
router.put('/:id/reject', requireRole('admin'), bustEditRequestCache, rejectEditRequest);

export default router;
