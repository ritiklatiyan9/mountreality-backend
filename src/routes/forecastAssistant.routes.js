import express from 'express';
const router = express.Router();

import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import forecastSiteAccess from '../middlewares/forecastSiteAccess.middleware.js';
import createRateLimiter from '../middlewares/rateLimit.middleware.js';
import { postForecastAssistant } from '../controllers/forecastAssistant.controller.js';

router.use(authMiddleware);

const forecastAssistantRateLimit = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 15,
  keyPrefix: 'ratelimit:forecast-assistant:',
});

router.post(
  '/assistant',
  forecastAssistantRateLimit,
  requireRole('admin', 'sub_admin'),
  requirePermission('finance_forecast', 'read'),
  forecastSiteAccess,
  postForecastAssistant
);

export default router;
