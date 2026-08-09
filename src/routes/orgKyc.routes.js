import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import { getKyc, updateKyc, submitKyc } from '../controllers/orgKyc.controller.js';

const router = express.Router();

router.use(authMiddleware);

// Everyone signed in may READ it — the reminder modal and the Settings
// timeline render for any member of the tenant.
router.get('/kyc', getKyc);

// Only admins may WRITE: this is the company's legal identity, not a
// personal profile setting a sub-admin should be able to rewrite.
router.put('/kyc', requireRole('admin', 'super_admin'), updateKyc);
router.post('/kyc/submit', requireRole('admin', 'super_admin'), submitKyc);

export default router;
