import express from 'express';
const router = express.Router();

import { uploadSingle, uploadMany } from '../utils/upload.js';
import upload from '../middlewares/multer.middleware.js';
import authMiddleware from '../middlewares/auth.middleware.js';

router.post('/single', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const { provider = 's3' } = req.query;
    const url = await uploadSingle(req.file, provider);
    res.json({ url, fileUrl: url });
  } catch (err) {
    console.error('[Upload] Failed:', err.message);
    res.status(500).json({ message: 'File upload failed: ' + err.message });
  }
});

router.post('/many', authMiddleware, upload.array('files'), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ message: 'No files uploaded' });
    const { provider = 's3' } = req.query;
    const urls = await uploadMany(req.files, provider);
    res.json({ urls });
  } catch (err) {
    console.error('[Upload] Failed:', err.message);
    res.status(500).json({ message: 'File upload failed: ' + err.message });
  }
});

export default router;