import asyncHandler from '../utils/asyncHandler.js';
import { excelModel } from '../models/excel.model.js';
import pool from '../config/db.js';
import { uploadToS3, deleteFromS3, generateSignedGetUrl } from '../utils/s3.js';

/**
 * POST /excel
 * Create a new spreadsheet file
 */
export const createFile = asyncHandler(async (req, res) => {
    const { name = 'Untitled Spreadsheet', folder_id, file_type, site_id } = req.body;

    if (!site_id) {
        return res.status(400).json({ message: 'Site is required' });
    }
    if (!req.file) {
        return res.status(400).json({ message: 'File is required' });
    }

    // Upload the file to S3
    const s3_key = await uploadToS3(req.file.buffer, req.file.originalname, req.file.mimetype);

    // Detect file type from extension
    const ext = req.file.originalname.split('.').pop().toLowerCase();
    let detectedType = file_type || 'excel';
    if (['pdf'].includes(ext)) detectedType = 'pdf';
    else if (['doc', 'docx'].includes(ext)) detectedType = 'doc';
    else if (['xlsx', 'xls', 'csv'].includes(ext)) detectedType = 'excel';

    const createData = {
        name,
        s3_key,
        size_bytes: req.file.size,
        file_type: detectedType,
        site_id: parseInt(site_id),
        created_by: req.user.id,
        updated_by: req.user.id,
    };
    if (folder_id) createData.folder_id = parseInt(folder_id);

    const file = await excelModel.create(createData, pool);

    res.status(201).json({ file });
});

/**
 * GET /excel
 * List all files for current user
 */
export const listFiles = asyncHandler(async (req, res) => {
    const folderId = req.query.folderId ? parseInt(req.query.folderId) : null;
    const siteId = req.query.site_id ? parseInt(req.query.site_id) : null;
    if (!siteId) return res.status(400).json({ message: 'site_id is required' });

    const files = await excelModel.findAllBySite(siteId, pool, folderId);
    res.json({ files });
});

/**
 * GET /excel/recent
 * Recent files for sidebar
 */
export const getRecentFiles = asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit) || 5;
    const files = await excelModel.findRecent(req.user.id, limit, pool);
    res.json({ files });
});

/**
 * GET /excel/:id
 * Get single file with full data
 */
export const getFile = asyncHandler(async (req, res) => {
    const file = await excelModel.findByIdWithData(parseInt(req.params.id), pool);
    if (!file) return res.status(404).json({ message: 'File not found' });

    // Generate secure AWS S3 download link valid for 1 hour
    let downloadUrl = null;
    if (file.s3_key) {
        downloadUrl = await generateSignedGetUrl(file.s3_key);
    }

    res.json({ file, downloadUrl });
});

/**
 * PUT /excel/:id
 * Update file (auto-save — sheet data + optional name)
 */
export const updateFile = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { name } = req.body;

    const existing = await excelModel.findById(parseInt(id), pool);
    if (!existing) return res.status(404).json({ message: 'File not found' });

    // Handle incoming file overwrite (save operation)
    if (req.file) {
        // Upload new file to S3
        const originalName = req.file.originalname || existing.name;
        const new_s3_key = await uploadToS3(req.file.buffer, originalName, req.file.mimetype);

        // Update database pointer
        const result = await excelModel.updateS3Details(parseInt(id), new_s3_key, req.file.size, req.user.id, pool);

        // Optionally update name if provided simultaneously
        if (name && name !== existing.name) {
            await excelModel.rename(parseInt(id), name, req.user.id, pool);
            result.name = name;
        }

        // We could delete old s3_key here to save space: await deleteFromS3(existing.s3_key)
        // But skipping to prevent breaking duplicated files sharing the old key

        return res.json({ file: result });
    }

    // Full update (just name via existing API if no file attached)
    if (name) {
        const updated = await excelModel.rename(parseInt(id), name, req.user.id, pool);
        return res.json({ file: updated });
    }

    res.json({ file: existing });
});

/**
 * PUT /excel/:id/rename
 * Rename file
 */
export const renameFile = asyncHandler(async (req, res) => {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Name is required' });

    const file = await excelModel.rename(parseInt(req.params.id), name.trim(), req.user.id, pool);
    if (!file) return res.status(404).json({ message: 'File not found' });
    res.json({ file });
});

/**
 * PUT /excel/:id/move
 * Move a file into a folder (body.folderId) or to root (folderId null).
 */
export const moveFile = asyncHandler(async (req, res) => {
    const { folderId } = req.body;
    const existing = await excelModel.findById(parseInt(req.params.id), pool);
    if (!existing) return res.status(404).json({ message: 'File not found' });

    const file = await excelModel.moveToFolder(parseInt(req.params.id), folderId ?? null, pool);
    if (!file) return res.status(400).json({ message: 'Invalid destination folder' });
    res.json({ file });
});

/**
 * POST /excel/:id/duplicate
 * Duplicate a file
 */
export const duplicateFile = asyncHandler(async (req, res) => {
    const file = await excelModel.duplicate(parseInt(req.params.id), req.user.id, pool);
    if (!file) return res.status(404).json({ message: 'File not found' });
    res.status(201).json({ file });
});

/**
 * DELETE /excel/:id
 * Delete a file
 */
export const deleteFile = asyncHandler(async (req, res) => {
    const existing = await excelModel.findById(parseInt(req.params.id), pool);
    if (!existing) return res.status(404).json({ message: 'File not found' });

    if (existing.s3_key) {
        // Caution: If duplicate() creates references to the same object, 
        // deleting here deletes it for duplicates too!
        // To be safe, we let S3 bucket lifecycle rules clean up orphaned files,
        // or we check if count of files sharing this s3_key == 1.
        // For now, we will delete it to prevent storage leaks.
        try {
            const countQuery = await pool.query(`SELECT COUNT(*) as count FROM excel_files WHERE s3_key = $1`, [existing.s3_key]);
            if (parseInt(countQuery.rows[0].count) <= 1) {
                await deleteFromS3(existing.s3_key);
            }
        } catch (e) { console.error("Could not delete from S3"); }
    }

    await excelModel.delete(parseInt(req.params.id), pool);
    res.json({ message: 'File deleted successfully' });
});
