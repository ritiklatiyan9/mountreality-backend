import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import {
  createOperatingProfileDraft,
  getEffectiveSitePolicy,
  getOperatingProfile,
  previewOperatingProfile,
  publishOperatingProfile,
  reviewOperatingProfile,
  submitOperatingProfileReview,
  updateOperatingProfileDraft,
  validateOperatingProfileRevision,
} from '../controllers/operatingProfile.controller.js';

const router = express.Router();

router.use(authMiddleware, requireRole('admin', 'sub_admin'));

// Runtime policy is required by every authenticated workspace role. Tenant and
// assigned-site boundaries are enforced in the controller before resolution.
router.get('/site-policy', getEffectiveSitePolicy);

router.get('/operating-profile', requirePermission('operating_profile', 'read'), getOperatingProfile);
router.post('/operating-profile/drafts', requirePermission('operating_profile', 'write'), createOperatingProfileDraft);
router.patch('/operating-profile/drafts/:id', requirePermission('operating_profile', 'update'), updateOperatingProfileDraft);
router.get('/operating-profile/:id/preview', requirePermission('operating_profile', 'read'), previewOperatingProfile);
router.post('/operating-profile/:id/validate', requirePermission('operating_profile', 'update'), validateOperatingProfileRevision);
router.post('/operating-profile/:id/submit-review', requirePermission('operating_profile', 'update'), submitOperatingProfileReview);
router.post('/operating-profile/:id/review', requireRole('admin'), requirePermission('operating_profile', 'update'), reviewOperatingProfile);
router.post('/operating-profile/:id/publish', requireRole('admin'), requirePermission('operating_profile', 'update'), publishOperatingProfile);

export default router;

