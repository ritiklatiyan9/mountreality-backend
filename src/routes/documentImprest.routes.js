import express from 'express';
import multer from 'multer';
import path from 'path';

import {
  listDocumentImprest, createDocumentImprest, returnDocumentImprest,
  updateDocumentImprest, deleteDocumentImprest,
} from '../controllers/documentImprest.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';

const router = express.Router();

// In-memory storage — the buffer goes straight to the shared S3 util (same approach
// as plot-documents). Proofs are camera captures, so images only, 10 MB cap.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okExt = /\.(jpg|jpeg|png|webp)$/.test(path.extname(file.originalname).toLowerCase());
    const okMime = /^image\/(jpe?g|png|webp)$/.test(file.mimetype);
    if (okExt && okMime) return cb(null, true);
    cb(new Error('Proof must be a photo (jpg, png or webp)'));
  },
});

router.use(authMiddleware);

router.get('/', requirePermission('document_imprest', 'read'), listDocumentImprest);
router.get('/peers', requirePermission('document_imprest', 'read'), asyncHandler(async (req, res) => {
  const siteId = Number.parseInt(req.query.site_id, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return res.status(400).json({ message: 'A valid site_id is required' });
  }

  const { rows: siteRows } = await pool.query('SELECT id FROM sites WHERE id = $1 LIMIT 1', [siteId]);
  if (!siteRows[0]) return res.status(404).json({ message: 'Site not found' });

  if (req.user.role === 'sub_admin') {
    const { rows: accessRows } = await pool.query(
      'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
      [req.user.id, siteId]
    );
    if (!accessRows[0]) return res.status(403).json({ message: 'Access denied to this site' });
  }

  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.role
       FROM users u
      WHERE u.is_active = true
        AND u.id != $1
        AND (
          u.role IN ('admin', 'super_admin')
          OR (
            u.role = 'sub_admin'
            AND EXISTS (
              SELECT 1
                FROM user_sites us
               WHERE us.user_id = u.id
                 AND us.site_id = $2
            )
          )
        )
      ORDER BY CASE u.role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
               u.name ASC,
               u.email ASC`,
    [req.user.id, siteId]
  );

  res.json({ peers: rows });
}));
router.post('/', requirePermission('document_imprest', 'write'), upload.single('photo'), createDocumentImprest);
router.post('/:id/return', requirePermission('document_imprest', 'update'), upload.single('photo'), returnDocumentImprest);
router.put('/:id', requirePermission('document_imprest', 'update'), updateDocumentImprest);
router.delete('/:id', requirePermission('document_imprest', 'delete'), deleteDocumentImprest);

export default router;
