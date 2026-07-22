import express from 'express';
import multer from 'multer';
import path from 'path';

import {
  uploadDmsDocument, searchDmsDocuments, getDmsDocument,
  updateDmsDocument, retryOcr, deleteDmsDocument,
  listUnassignedDmsDocuments, assignUnassignedDmsDocument,
} from '../controllers/dmsDocument.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';

const router = express.Router();
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MIME_BY_EXTENSION = new Map([
  ['.jpg', new Set(['image/jpeg'])],
  ['.jpeg', new Set(['image/jpeg'])],
  ['.png', new Set(['image/png'])],
  ['.webp', new Set(['image/webp'])],
  ['.pdf', new Set(['application/pdf'])],
  ['.doc', new Set(['application/msword'])],
  ['.docx', new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document'])],
]);

// In-memory storage → hand the buffer straight to the shared S3 util + OCR. 25 MB cap (deed scans
// run large; the client compresses before upload). Same accept-set as plotDocument.routes.js.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    const suppliedMime = String(file.mimetype || '').toLowerCase();
    const expectedMimes = MIME_BY_EXTENSION.get(extension);
    if (expectedMimes && (expectedMimes.has(suppliedMime) || suppliedMime === 'application/octet-stream')) {
      return cb(null, true);
    }
    cb(new Error('Invalid file type (allowed: jpg, jpeg, png, webp, pdf, doc, docx)'));
  },
});

// Turn upload validation failures into useful client errors instead of allowing Multer errors
// to fall through to the generic 500 handler.
const receiveDocument = (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'File is too large. The maximum size is 25 MB.' });
    }
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ message: 'Upload one file per request.' });
    }
    return res.status(400).json({ message: err.message || 'The selected file could not be uploaded.' });
  });
};

router.use(authMiddleware);

// Document Search is independently assignable from Plot Registry.
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('document_search', 'read'), searchDmsDocuments);
router.get(
  '/unassigned',
  requireRole('admin'),
  requirePermission('document_search', 'read'),
  listUnassignedDmsDocuments
);
router.patch(
  '/unassigned/:id/assign',
  requireRole('admin'),
  requirePermission('document_search', 'update'),
  assignUnassignedDmsDocument
);
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('document_search', 'read'), getDmsDocument);
router.post('/', requireRole('admin', 'sub_admin'), requirePermission('document_search', 'write'), receiveDocument, uploadDmsDocument);
router.post('/:id/retry-ocr', requireRole('admin', 'sub_admin'), requirePermission('document_search', 'write'), retryOcr);
router.patch('/:id', requireRole('admin', 'sub_admin'), requirePermission('document_search', 'update'), updateDmsDocument);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('document_search', 'delete'), deleteDmsDocument);

export default router;
