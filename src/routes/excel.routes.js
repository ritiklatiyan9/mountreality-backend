import express from 'express';
import multer from 'multer';
import authMiddleware from '../middlewares/auth.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { requireEntitySiteAccess, requireRequestSiteAccess } from '../middlewares/legacyEntitySiteAccess.middleware.js';
import createRateLimiter from '../middlewares/rateLimit.middleware.js';
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
const excelUploadLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30, keyPrefix: 'excel-upload:' });
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
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

const fileById = requireEntitySiteAccess({ entity: 'excel_file', module: 'excel' });
const folderFromBody = requireEntitySiteAccess({ entity: 'folder', source: 'body', key: 'folder_id', module: 'excel' });
const destinationFromBody = requireEntitySiteAccess({ entity: 'folder', source: 'body', key: 'folderId', module: 'excel' });

router.post('/', requirePermission('excel', 'write'), excelUploadLimiter, upload.single('file'), requireRequestSiteAccess({ module: 'excel' }), folderFromBody, createFile);
router.get('/', requirePermission('excel', 'read'), requireRequestSiteAccess({ source: 'query', module: 'excel' }), listFiles);
router.get('/recent', requirePermission('excel', 'read'), getRecentFiles);
router.get('/:id', requirePermission('excel', 'read'), fileById, getFile);
router.put('/:id', requirePermission('excel', 'update'), fileById, excelUploadLimiter, upload.single('file'), updateFile);
router.put('/:id/rename', requirePermission('excel', 'update'), fileById, renameFile);
router.put('/:id/move', requirePermission('excel', 'update'), fileById, destinationFromBody, moveFile);
router.post('/:id/duplicate', requirePermission('excel', 'write'), fileById, duplicateFile);
router.delete('/:id', requirePermission('excel', 'delete'), fileById, deleteFile);

export default router;
