import express from 'express';
import multer from 'multer';
import authMiddleware from '../middlewares/auth.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import {
    createFile,
    listFiles,
    getRecentFiles,
    getFile,
    updateFile,
    renameFile,
    moveFile,
    duplicateFile,
    deleteFile,
} from '../controllers/excel.controller.js';

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
            'application/vnd.ms-excel', // xls
            'text/csv',
            'application/pdf',
            'application/msword', // doc
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
        ];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('File type not supported. Allowed: xlsx, xls, csv, pdf, doc, docx'), false);
        }
    },
});

// All routes require authentication
router.use(authMiddleware);

router.post('/', requirePermission('excel', 'write'), upload.single('file'), createFile);
router.get('/', requirePermission('excel', 'read'), listFiles);
router.get('/recent', requirePermission('excel', 'read'), getRecentFiles);
router.get('/:id', requirePermission('excel', 'read'), getFile);
router.put('/:id', requirePermission('excel', 'update'), upload.single('file'), updateFile);
router.put('/:id/rename', requirePermission('excel', 'update'), renameFile);
router.put('/:id/move', requirePermission('excel', 'update'), moveFile);
router.post('/:id/duplicate', requirePermission('excel', 'write'), duplicateFile);
router.delete('/:id', requirePermission('excel', 'delete'), deleteFile);

export default router;
