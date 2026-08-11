import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';

const UPLOAD_DIR = 'src/uploads';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    // A profile photo and its documents can arrive in the same millisecond.
    // Preserve every selected file instead of letting timestamp collisions
    // overwrite an earlier upload before storage receives it.
    cb(null, `${Date.now()}-${randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
  }
});

const ALLOWED_TYPES = new Map([
  ['.jpg', new Set(['image/jpeg'])],
  ['.jpeg', new Set(['image/jpeg'])],
  ['.png', new Set(['image/png'])],
  ['.webp', new Set(['image/webp'])],
  ['.pdf', new Set(['application/pdf'])],
]);

const uploadError = (message, code = 'INVALID_UPLOAD') => {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
};

const fileFilter = (_req, file, cb) => {
  const extension = path.extname(file.originalname).toLowerCase();
  const mimeTypes = ALLOWED_TYPES.get(extension);
  if (mimeTypes?.has(String(file.mimetype).toLowerCase())) return cb(null, true);
  return cb(uploadError('Only JPEG, PNG, WebP, and PDF files are allowed', 'INVALID_FILE_TYPE'));
};

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter
});

export const cleanupFile = (filePath) => {
  if (!filePath) return;
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') console.error('Error deleting temporary upload:', err.message);
  });
};

const cleanupRequestFiles = (req) => {
  const files = [...(req.files || []), ...(req.file ? [req.file] : [])];
  files.forEach((file) => cleanupFile(file.path));
};

const wrapMulter = (middleware) => (req, res, next) => {
  middleware(req, res, (error) => {
    if (!error) return next();
    cleanupRequestFiles(req);
    if (error instanceof multer.MulterError) {
      error.status = 400;
      error.message = error.code === 'LIMIT_FILE_SIZE'
        ? 'Each file must be 5 MB or smaller'
        : 'The upload request is invalid';
    }
    return next(error);
  });
};

const matchesMagicBytes = (buffer, extension) => {
  const hex = buffer.toString('hex');
  if (extension === '.jpg' || extension === '.jpeg') return hex.startsWith('ffd8ff');
  if (extension === '.png') return hex.startsWith('89504e470d0a1a0a');
  if (extension === '.webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (extension === '.pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  return false;
};

export const validateUploadedFiles = async (req, _res, next) => {
  const files = [...(req.files || []), ...(req.file ? [req.file] : [])];
  try {
    for (const file of files) {
      const handle = await fs.promises.open(file.path, 'r');
      try {
        const header = Buffer.alloc(16);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        const extension = path.extname(file.originalname).toLowerCase();
        if (!matchesMagicBytes(header.subarray(0, bytesRead), extension)) {
          throw uploadError('File content does not match its declared type', 'INVALID_FILE_SIGNATURE');
        }
      } finally {
        await handle.close();
      }
    }
    next();
  } catch (error) {
    cleanupRequestFiles(req);
    next(error);
  }
};

export const receiveSingleUpload = wrapMulter(upload.single('file'));
export const receiveManyUploads = wrapMulter(upload.array('files', 10));

export default upload;
