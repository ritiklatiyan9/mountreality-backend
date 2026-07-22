import express from 'express';
import multer from 'multer';
import path from 'path';

import {
  listPlotsWithDocs, getPlotDocuments, uploadPlotDocument, deletePlotDocument,
} from '../controllers/plotDocument.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';

const router = express.Router();
const MIME_BY_EXTENSION = new Map([
  ['.jpg', new Set(['image/jpeg'])],
  ['.jpeg', new Set(['image/jpeg'])],
  ['.png', new Set(['image/png'])],
  ['.webp', new Set(['image/webp'])],
  ['.pdf', new Set(['application/pdf'])],
  ['.doc', new Set(['application/msword'])],
  ['.docx', new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document'])],
]);

// In-memory storage so we hand the buffer straight to the shared S3 util (same approach as
// the booking module). Accept images + pdf + doc/docx, 25 MB cap (registry deed scans run large;
// the client compresses PDFs losslessly before upload).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
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

const receivePlotDocument = (req, res, next) => {
  upload.single('file')(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'File is too large. The maximum size is 25 MB.' });
    }
    return res.status(400).json({ message: error.message || 'The selected file could not be uploaded.' });
  });
};

// All plot-document routes require auth. Access reuses the plot_payments permission.
router.use(authMiddleware);

router.get('/', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), listPlotsWithDocs);                          // ?site_id=X
router.get('/:plotId', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), getPlotDocuments);
router.post('/:plotId', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'write'), receivePlotDocument, uploadPlotDocument);
router.delete('/doc/:docId', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'delete'), deletePlotDocument);

export default router;
