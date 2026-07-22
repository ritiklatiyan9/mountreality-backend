import express from 'express';
const router = express.Router();

import { saveSignatures, SIGN_TARGETS } from '../controllers/signature.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';

router.use(authMiddleware);
router.use(requireRole('admin', 'sub_admin'));

// Permission module depends on the target — resolve it, then delegate to the
// standard permission middleware (admins pass, sub-admins need module update).
const requireTargetPermission = (req, res, next) => {
  const target = SIGN_TARGETS[req.params.target];
  if (!target) return res.status(400).json({ message: 'Unknown signature target' });
  return requirePermission(target.perm, 'update')(req, res, next);
};

router.put('/:target/:id', requireTargetPermission, saveSignatures);

export default router;
