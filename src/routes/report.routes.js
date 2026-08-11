import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import { cacheResponse } from '../middlewares/cache.middleware.js';
import { listReportModules, getReport, aiReportSummary } from '../controllers/report.controller.js';
import createRateLimiter from '../middlewares/rateLimit.middleware.js';

const router = express.Router();
const aiReportLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 20, keyPrefix: 'ai-report:' });

router.use(authMiddleware, requireRole('admin', 'sub_admin'));

// Per-module read permission is enforced inside the controller.
router.get('/modules', listReportModules);
router.get('/:module', cacheResponse({ ttlSeconds: 60, namespace: 'reports' }), getReport);
router.post('/:module/ai', aiReportLimiter, aiReportSummary);

export default router;
