import express from 'express';
const router = express.Router();

import { uploadSingle, uploadMany } from '../utils/upload.js';
import {
  receiveManyUploads,
  receiveSingleUpload,
  validateUploadedFiles,
} from '../middlewares/multer.middleware.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import createRateLimiter from '../middlewares/rateLimit.middleware.js';

const uploadRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyPrefix: 'upload:',
});

const readProvider = (req) => {
  const provider = String(req.query.provider || 's3').toLowerCase();
  if (!['s3', 'cloudinary'].includes(provider)) {
    const error = new Error('Unsupported upload provider');
    error.status = 400;
    error.code = 'INVALID_UPLOAD_PROVIDER';
    throw error;
  }
  return provider;
};

const enforceProvider = (req, _res, next) => {
  try {
    req.uploadProvider = readProvider(req);
    next();
  } catch (error) {
    next(error);
  }
};

router.post('/single', authMiddleware, uploadRateLimit, enforceProvider, receiveSingleUpload, validateUploadedFiles, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const url = await uploadSingle(req.file, req.uploadProvider);
    res.json({ url, fileUrl: url });
  } catch (err) {
    next(err);
  }
});

router.post('/many', authMiddleware, uploadRateLimit, enforceProvider, receiveManyUploads, validateUploadedFiles, async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ message: 'No files uploaded' });
    const urls = await uploadMany(req.files, req.uploadProvider);
    res.json({ urls });
  } catch (err) {
    next(err);
  }
});

export default router;
