import asyncHandler from '../utils/asyncHandler.js';
import { folderModel } from '../models/Folder.model.js';
import { deleteFromS3 } from '../utils/s3.js';
import pool from '../config/db.js';

/**
 * GET /folders?parentId=&site_id=
 * List folders inside a parent folder, scoped by site
 */
export const listFolders = asyncHandler(async (req, res) => {
    const parentId = req.query.parentId ? parseInt(req.query.parentId) : null;
    const siteId = req.query.site_id ? parseInt(req.query.site_id) : null;
    if (!siteId) return res.status(400).json({ message: 'site_id is required' });

    const folders = await folderModel.listByParent(parentId, siteId, pool);
    const breadcrumb = await folderModel.getBreadcrumb(parentId, pool);
    res.json({ folders, breadcrumb });
});

/**
 * POST /folders
 * Create a new folder
 */
export const createFolder = asyncHandler(async (req, res) => {
    const { name, parentId, site_id } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Folder name is required' });
    if (!site_id) return res.status(400).json({ message: 'site_id is required' });

    const folder = await folderModel.createFolder(name.trim(), parentId || null, parseInt(site_id), req.user.id, pool);
    res.status(201).json({ folder });
});

/**
 * PUT /folders/:id/rename
 * Rename a folder
 */
export const renameFolder = asyncHandler(async (req, res) => {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Folder name is required' });

    const folder = await folderModel.renameFolder(parseInt(req.params.id), name.trim(), pool);
    if (!folder) return res.status(404).json({ message: 'Folder not found' });
    res.json({ folder });
});

/**
 * PUT /folders/:id/move
 * Move a folder under a new parent (body.parentId), or to root (parentId null).
 */
export const moveFolder = asyncHandler(async (req, res) => {
    const { parentId } = req.body;
    const { folder, error } = await folderModel.moveFolder(parseInt(req.params.id), parentId ?? null, pool);
    if (error) {
        const status = error === 'Folder not found' || error === 'Target folder not found' ? 404 : 400;
        return res.status(status).json({ message: error });
    }
    res.json({ folder });
});

/**
 * DELETE /folders/:id
 * Delete a folder and all contents
 */
export const deleteFolder = asyncHandler(async (req, res) => {
    const { folder, deletedS3Keys } = await folderModel.deleteFolder(parseInt(req.params.id), pool);
    if (!folder) return res.status(404).json({ message: 'Folder not found' });

    // Clean up S3 files
    for (const key of deletedS3Keys) {
        try { await deleteFromS3(key); } catch (e) { console.error('S3 cleanup error:', e); }
    }

    res.json({ message: 'Folder deleted successfully' });
});
