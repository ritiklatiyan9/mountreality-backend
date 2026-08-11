import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import {
  clearPersonalTheme,
  getAppearance,
  setCompanyTheme,
  setPersonalTheme,
} from '../controllers/appearance.controller.js';

const router = express.Router();

router.use(authMiddleware);
router.get('/', getAppearance);
router.put('/personal', setPersonalTheme);
router.delete('/personal', clearPersonalTheme);
router.put('/company', requireRole('admin', 'super_admin'), setCompanyTheme);

export default router;
