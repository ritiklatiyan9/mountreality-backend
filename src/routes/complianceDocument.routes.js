import express from 'express';
import multer from 'multer';
import path from 'path';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import createRateLimiter from '../middlewares/rateLimit.middleware.js';
import {
  deleteComplianceDocument, getComplianceDocument, listComplianceDocuments,
  listExpiringComplianceDocuments, uploadComplianceDocument,
} from '../controllers/complianceDocument.controller.js';

const router = express.Router();
const MAX_BYTES = 25 * 1024 * 1024;
const MIME_BY_EXTENSION = new Map([
  ['.jpg', new Set(['image/jpeg'])], ['.jpeg', new Set(['image/jpeg'])],
  ['.png', new Set(['image/png'])], ['.webp', new Set(['image/webp'])],
  ['.pdf', new Set(['application/pdf'])], ['.doc', new Set(['application/msword'])],
  ['.docx', new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document'])],
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const expected = MIME_BY_EXTENSION.get(path.extname(file.originalname || '').toLowerCase());
    const mime = String(file.mimetype || '').toLowerCase();
    if (expected?.has(mime)) return cb(null, true);
    return cb(new Error('Invalid file type'));
  },
});
const receive = (req, res, next) => upload.single('file')(req, res, (error) => {
  if (!error) return next();
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ message: 'Document exceeds the 25 MB limit' });
  }
  return res.status(400).json({ message: error.message || 'Upload failed' });
});
const uploadLimiter = createRateLimiter({ windowMs: 60_000, max: 20, keyPrefix: 'compliance-upload:' });

router.use(authMiddleware, requireRole('admin', 'sub_admin'));
router.get('/expiring', requirePermission('compliance', 'read'), listExpiringComplianceDocuments);
router.get('/file/:documentId', getComplianceDocument);
router.delete('/file/:documentId', deleteComplianceDocument);
router.get('/:entityType/:entityId', listComplianceDocuments);
router.post('/:entityType/:entityId', uploadLimiter, receive, uploadComplianceDocument);

export default router;
