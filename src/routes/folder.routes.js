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
import { requireEntitySiteAccess, requireRequestSiteAccess } from '../middlewares/legacyEntitySiteAccess.middleware.js';

const router = express.Router();

router.use(authMiddleware);

const folderById = requireEntitySiteAccess({ entity: 'folder', module: 'excel' });
const parentFromQuery = requireEntitySiteAccess({ entity: 'folder', source: 'query', key: 'parentId', module: 'excel' });
const parentFromBody = requireEntitySiteAccess({ entity: 'folder', source: 'body', key: 'parentId', module: 'excel' });

router.get('/', requirePermission('excel', 'read'), requireRequestSiteAccess({ source: 'query', module: 'excel' }), parentFromQuery, listFolders);
router.post('/', requirePermission('excel', 'write'), requireRequestSiteAccess({ module: 'excel' }), parentFromBody, createFolder);
router.put('/:id/rename', requirePermission('excel', 'update'), folderById, renameFolder);
router.put('/:id/move', requirePermission('excel', 'update'), folderById, parentFromBody, moveFolder);
router.delete('/:id', requirePermission('excel', 'delete'), folderById, deleteFolder);

export default router;
