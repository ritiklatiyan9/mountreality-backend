import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import {
    listFolders,
    createFolder,
    renameFolder,
    moveFolder,
    deleteFolder,
} from '../controllers/folder.controller.js';
import requirePermission from '../middlewares/permission.middleware.js';

const router = express.Router();

router.use(authMiddleware);

router.get('/', requirePermission('excel', 'read'), listFolders);
router.post('/', requirePermission('excel', 'write'), createFolder);
router.put('/:id/rename', requirePermission('excel', 'update'), renameFolder);
router.put('/:id/move', requirePermission('excel', 'update'), moveFolder);
router.delete('/:id', requirePermission('excel', 'delete'), deleteFolder);

export default router;
