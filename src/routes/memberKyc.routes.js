import express from 'express';
import multer from 'multer';
import path from 'path';
import {
  createCase, extractPreview, getCase, getDocument, retryDocument,
  updateCaseCustomer, uploadDocument, verifyCase,
} from '../controllers/memberKyc.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import { invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';
import permissionModel from '../models/Permission.model.js';
import pool from '../config/db.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);
    const allowedMimes = new Set([
      'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf',
    ]);
    const accepted = allowedExtensions.has(extension) && allowedMimes.has(file.mimetype);
    callback(accepted ? null : new Error('KYC files must be JPG, PNG, WebP or PDF'), accepted);
  },
});

const acceptUpload = (req, res, next) => {
  upload.single('file')(req, res, (error) => {
    if (!error) return next();
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'KYC files must be smaller than 10 MB'
      : (error.message || 'Invalid KYC file');
    return res.status(400).json({ message });
  });
};

router.use(authMiddleware, requireRole('admin', 'sub_admin'));
const bustMemberCache = invalidateCacheOnSuccess(['members|']);

const loadClientKycPermissions = async (req, res, next) => {
  try {
    if (['admin', 'super_admin'].includes(req.user.role)) {
      req.clientKycPermissions = { canWrite: true, canUpdate: true };
      return next();
    }
    const permission = await permissionModel.getPermission(req.user.id, 'clients');
    req.clientKycPermissions = {
      canWrite: Boolean(permission?.can_write),
      canUpdate: Boolean(permission?.can_update),
    };
    return next();
  } catch (error) {
    console.error('KYC permission lookup failed:', error?.message || error);
    return res.status(500).json({ message: 'Permission check failed' });
  }
};

const requireKycStartPermission = (req, res, next) => {
  const editingExistingMember = Number.isInteger(Number.parseInt(req.body.client_member_id, 10));
  const allowed = editingExistingMember
    ? req.clientKycPermissions?.canUpdate
    : req.clientKycPermissions?.canWrite;
  if (allowed) return next();
  return res.status(403).json({
    message: editingExistingMember
      ? 'You do not have permission to update clients'
      : 'You do not have permission to create clients',
  });
};

const requireKycMutationPermission = (caseSource) => async (req, res, next) => {
  if (req.clientKycPermissions?.canUpdate) return next();
  if (!req.clientKycPermissions?.canWrite) {
    return res.status(403).json({ message: 'You do not have permission to update clients' });
  }
  try {
    const result = caseSource === 'document'
      ? await pool.query(
          `SELECT k.created_by, k.booking_id
             FROM documents d JOIN kyc_cases k ON k.id = d.kyc_case_id
            WHERE d.id = $1`,
          [req.params.id]
        )
      : await pool.query(
          'SELECT created_by, booking_id FROM kyc_cases WHERE id = $1',
          [caseSource === 'body' ? req.body.kyc_case_id : req.params.id]
        );
    const kycCase = result.rows[0];
    if (kycCase && !kycCase.booking_id && Number(kycCase.created_by) === Number(req.user.id)) {
      return next();
    }
    return res.status(403).json({
      message: 'Update permission is required for a KYC case created by another user',
    });
  } catch (error) {
    console.error('KYC ownership check failed:', error?.message || error);
    return res.status(500).json({ message: 'Permission check failed' });
  }
};

router.use(loadClientKycPermissions);

router.post('/cases', requireKycStartPermission, bustMemberCache, createCase);
router.get('/case/:id', requirePermission('clients', 'read'), getCase);
router.patch('/case/:id/customer', requireKycMutationPermission('params'), bustMemberCache, updateCaseCustomer);
// Multer must parse the multipart body before the ownership middleware can read
// kyc_case_id. Authentication/role checks have already run at router level.
router.post('/upload', acceptUpload, requireKycMutationPermission('body'), uploadDocument);
router.get('/document/:id', requirePermission('clients', 'read'), getDocument);
router.post('/document/:id/retry', requireKycMutationPermission('document'), retryDocument);
router.post('/case/:id/extract-preview', requirePermission('clients', 'read'), extractPreview);
router.post('/case/:id/verify', requireKycMutationPermission('params'), bustMemberCache, verifyCase);

export default router;
