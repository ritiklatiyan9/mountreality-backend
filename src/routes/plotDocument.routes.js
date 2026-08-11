import express from 'express';
import multer from 'multer';
import path from 'path';

import {
  listPlotsWithDocs, getPlotDocuments, uploadPlotDocument, deletePlotDocument,
} from '../controllers/plotDocument.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import pool from '../config/db.js';
import { enforceEntitySiteAccess, parseSiteId } from '../utils/siteAccessPolicy.js';
import createRateLimiter from '../middlewares/rateLimit.middleware.js';

const router = express.Router();
const plotDocumentUploadLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 30, keyPrefix: 'plot-document-upload:' });
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

const PLOT_DOCUMENT_SITE_LOOKUPS = Object.freeze({
  plot: 'SELECT site_id FROM plots WHERE id = $1 LIMIT 1',
  document: `SELECT COALESCE(d.site_id, p.site_id, k.site_id, b.site_id) AS site_id
               FROM documents d
               LEFT JOIN plots p ON p.id = d.plot_id
               LEFT JOIN kyc_cases k ON k.id = d.kyc_case_id
               LEFT JOIN bookings b ON b.id = k.booking_id
              WHERE d.id = $1
                AND COALESCE(d.uploaded_source, 'BOOKING') NOT IN ('DMS', 'PLOT_REGISTRY')
                AND UPPER(COALESCE(d.category, '')) NOT IN ('REGISTRY', 'NOC')
                AND (d.plot_id IS NOT NULL OR b.plot_id IS NOT NULL)
              LIMIT 1`,
});

const requirePlotDocumentSite = ({ entity, source, key }) => async (req, res, next) => {
  try {
    const entityId = parseSiteId(req[source]?.[key]);
    if (!entityId) return res.status(400).json({ message: `A valid ${key} is required` });

    let siteId = entityId;
    if (entity !== 'site') {
      const lookup = PLOT_DOCUMENT_SITE_LOOKUPS[entity];
      if (!lookup) throw new Error(`Unsupported plot-document access entity: ${entity}`);
      const { rows } = await pool.query(lookup, [entityId]);
      // Preserve the controller's endpoint-specific 404 response.
      if (!rows[0]) return next();
      siteId = parseSiteId(rows[0].site_id);
      if (!siteId) {
        return res.status(409).json({ message: 'This record is not linked to a Site' });
      }
    }

    const allowed = await enforceEntitySiteAccess({
      req,
      res,
      siteId,
      module: 'plot_payments',
      contextProperty: 'plotDocumentSiteId',
    });
    if (!allowed) return;
    return next();
  } catch (error) {
    return next(error);
  }
};

const accessByQuerySite = requirePlotDocumentSite({ entity: 'site', source: 'query', key: 'site_id' });
const accessByPlot = requirePlotDocumentSite({ entity: 'plot', source: 'params', key: 'plotId' });
const accessByDocument = requirePlotDocumentSite({ entity: 'document', source: 'params', key: 'docId' });

// All plot-document routes require auth. Access reuses the plot_payments permission.
router.use(authMiddleware);

router.get('/', requireRole('admin', 'sub_admin'), accessByQuerySite, requirePermission('plot_payments', 'read'), listPlotsWithDocs);                          // ?site_id=X
router.get('/:plotId', requireRole('admin', 'sub_admin'), accessByPlot, requirePermission('plot_payments', 'read'), getPlotDocuments);
// Resolve authorization before Multer buffers an uploaded file.
router.post('/:plotId', requireRole('admin', 'sub_admin'), accessByPlot, requirePermission('plot_payments', 'write'), plotDocumentUploadLimiter, receivePlotDocument, uploadPlotDocument);
router.delete('/doc/:docId', requireRole('admin', 'sub_admin'), accessByDocument, requirePermission('plot_payments', 'delete'), deletePlotDocument);

export default router;
