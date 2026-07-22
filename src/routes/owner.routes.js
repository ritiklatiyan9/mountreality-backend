import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import {
  getStats, getAnalytics, listOrganizations, getOrganizationDetail,
  registerOrganization, updateOrganization, extendSubscription,
} from '../controllers/owner.controller.js';

const router = express.Router();

// Strictly the platform owner. Deliberately NOT requireRole — that middleware
// lets every tenant super_admin through, which would expose all tenants.
const requireOwner = (req, res, next) => {
  if (req.user?.role !== 'owner') {
    return res.status(403).json({ message: 'Owner access required' });
  }
  next();
};

router.use(authMiddleware, requireOwner);

router.get('/stats', getStats);
router.get('/analytics', getAnalytics);
router.get('/organizations', listOrganizations);
router.post('/organizations', registerOrganization);
router.get('/organizations/:id', getOrganizationDetail);
router.patch('/organizations/:id', updateOrganization);
router.post('/organizations/:id/extend', extendSubscription);

export default router;
