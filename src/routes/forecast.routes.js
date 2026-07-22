import express from 'express';
import { getCashflowForecast } from '../controllers/forecast.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

const router = express.Router();
router.use(authMiddleware);

router.get(
  '/',
  requireRole('admin', 'sub_admin'),
  requirePermission('dashboard', 'read'),
  getCashflowForecast
);

export default router;
