import crypto from 'crypto';

import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import applicationSettingModel, { FEATURE_KEYS } from '../models/ApplicationSetting.model.js';
import { uploadPlotDoc, getPlotDocUrl, deletePlotDoc } from '../utils/plotDocStorage.js';

const REGISTRY_CATEGORIES = ['REGISTRY', 'NOC'];

const parsePositiveId = (value) => {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const ensureSiteAccess = async (req, res, siteId) => {
  if (req.user.role === 'admin' || req.user.role === 'super_admin') return true;
  const { rows } = await pool.query(
    'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
    [req.user.id, siteId]
  );
  if (rows[0]) return true;
  res.status(403).json({ message: 'Access denied to this site' });
  return false;
};

const getWorkflowOverride = async (siteId) => applicationSettingModel.isFeatureEnabled(
  siteId,
  FEATURE_KEYS.PLOT_REGISTRY_WORKFLOW_UNLOCKED
);

const attachSignedUrls = async (documents) => {
  await Promise.all(documents.map(async (document) => {
    try {
      document.file_url = await getPlotDocUrl(document.file_path);
    } catch {
      document.file_url = null;
    }
  }));
  return documents;
};

/** GET /registries/documents/plots?site_id=X
 * Registry-owned folder listing. Counts only deed and NOC documents, so a
 * plot-registry user never needs access to the broader plot-payments module. */
export const listRegistryDocumentPlots = asyncHandler(async (req, res) => {
  const siteId = parsePositiveId(req.query.site_id);
  if (!siteId) return res.status(400).json({ message: 'A valid site_id is required' });
  if (!await ensureSiteAccess(req, res, siteId)) return;

  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (p.site_id, p.plot_no, p.block)
              p.id, p.plot_no, p.block, p.status, p.buyer_name, p.plot_size,
              p.booking_by, p.booking_date, p.team, p.plot_tag, p.sale_price,
              (
                SELECT COUNT(*)
                  FROM documents d
                  LEFT JOIN kyc_cases k ON k.id = d.kyc_case_id
                  LEFT JOIN bookings b ON b.id = k.booking_id
                 WHERE (d.plot_id = p.id OR b.plot_id = p.id)
                   AND COALESCE(d.uploaded_source, 'BOOKING') <> 'DMS'
                   AND UPPER(COALESCE(d.category, '')) = ANY($2::text[])
              )::int AS doc_count
         FROM plots p
        WHERE p.site_id = $1
        ORDER BY p.site_id, p.plot_no, p.block, p.created_at DESC NULLS LAST, p.id DESC
     ) latest
     ORDER BY block ASC NULLS LAST,
              substring(plot_no from '^[^0-9]*') ASC,
              COALESCE(NULLIF(substring(plot_no from '[0-9]+'), '')::bigint, 0) ASC,
              plot_no ASC`,
    [siteId, REGISTRY_CATEGORIES]
  );

  res.json({ plots: rows });
});

/** GET /registries/documents/plot/:plotId */
export const getRegistryDocuments = asyncHandler(async (req, res) => {
  const plotId = parsePositiveId(req.params.plotId);
  if (!plotId) return res.status(400).json({ message: 'A valid plot ID is required' });

  const { rows: plotRows } = await pool.query(
    `SELECT id, plot_no, block, status, buyer_name, plot_size, plot_size_mtr,
            booking_by, booking_date, sale_price, plot_rate, team, plot_tag, site_id
       FROM plots
      WHERE id = $1`,
    [plotId]
  );
  const plot = plotRows[0];
  if (!plot) return res.status(404).json({ message: 'Plot not found' });
  if (!await ensureSiteAccess(req, res, plot.site_id)) return;

  const [documentResult, registryResult, workflowUnlocked] = await Promise.all([
    pool.query(
      `SELECT d.id, d.type, d.category, d.title, d.original_name, d.file_path,
            d.mime_type, d.file_size, d.uploaded_source, d.ocr_status, d.created_at,
            d.kyc_case_id, b.id AS booking_id, b.booking_no,
            COALESCE(u.name, u.email) AS uploaded_by_name
       FROM documents d
       LEFT JOIN kyc_cases k ON k.id = d.kyc_case_id
       LEFT JOIN bookings b ON b.id = k.booking_id
       LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE (d.plot_id = $1 OR b.plot_id = $1)
        AND COALESCE(d.uploaded_source, 'BOOKING') <> 'DMS'
        AND UPPER(COALESCE(d.category, '')) = ANY($2::text[])
      ORDER BY d.created_at DESC, d.id DESC`,
      [plotId, REGISTRY_CATEGORIES]
    ),
    pool.query(
      `SELECT id, noc_generated_at, noc_approved_at
         FROM plot_registries
        WHERE plot_id = $1
           OR (site_id = $2 AND UPPER(plot_no) = UPPER($3))
        ORDER BY id DESC
        LIMIT 1`,
      [plotId, plot.site_id, plot.plot_no]
    ),
    getWorkflowOverride(plot.site_id),
  ]);

  const documents = await attachSignedUrls(documentResult.rows);
  const registry = registryResult.rows[0] || null;
  res.json({
    plot,
    documents,
    workflow: {
      registry_id: registry?.id || null,
      noc_generated: Boolean(registry?.noc_generated_at),
      noc_approved: Boolean(registry?.noc_approved_at),
      workflow_unlocked: workflowUnlocked,
      registry_deed_allowed: workflowUnlocked || Boolean(registry?.noc_generated_at),
    },
  });
});

/** POST /registries/documents/plot/:plotId
 * Accepts REGISTRY or NOC only. In sequential mode, a registry deed follows a
 * generated NOC. The site-level workflow override deliberately bypasses that
 * business sequence while retaining file validation and module permission. */
export const uploadRegistryDocument = asyncHandler(async (req, res) => {
  const plotId = parsePositiveId(req.params.plotId);
  if (!plotId) return res.status(400).json({ message: 'A valid plot ID is required' });
  if (!req.file) return res.status(400).json({ message: 'Choose a file to upload' });

  const category = String(req.body.category || '').trim().toUpperCase();
  if (!REGISTRY_CATEGORIES.includes(category)) {
    return res.status(400).json({ message: 'Category must be Registry deed or NOC' });
  }

  const { rows: plotRows } = await pool.query(
    'SELECT id, site_id, plot_no FROM plots WHERE id = $1',
    [plotId]
  );
  const plot = plotRows[0];
  if (!plot) return res.status(404).json({ message: 'Plot not found' });
  if (!await ensureSiteAccess(req, res, plot.site_id)) return;

  const workflowUnlocked = await getWorkflowOverride(plot.site_id);
  if (category === 'REGISTRY' && !workflowUnlocked) {
    const { rows: registryRows } = await pool.query(
      `SELECT id, noc_generated_at
         FROM plot_registries
        WHERE plot_id = $1
           OR (site_id = $2 AND UPPER(plot_no) = UPPER($3))
        ORDER BY id DESC
        LIMIT 1`,
      [plotId, plot.site_id, plot.plot_no]
    );
    const registry = registryRows[0];
    if (!registry) {
      return res.status(409).json({
        code: 'REGISTRY_ENTRY_REQUIRED',
        message: 'Create the registry entry before uploading the registry deed',
      });
    }
    if (!registry.noc_generated_at) {
      return res.status(409).json({
        code: 'NOC_REQUIRED',
        message: 'Generate the NOC before uploading the registry deed, or enable the workflow override in Settings',
      });
    }
  }

  const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const duplicate = await pool.query(
    `SELECT id
       FROM documents
      WHERE plot_id = $1
        AND file_hash = $2
        AND UPPER(COALESCE(category, '')) = $3
      LIMIT 1`,
    [plotId, fileHash, category]
  );
  if (duplicate.rows[0]) {
    return res.status(409).json({
      code: 'DUPLICATE_DOCUMENT',
      message: 'This document has already been uploaded for the plot',
    });
  }

  const title = req.body.title ? String(req.body.title).trim().slice(0, 250) : null;
  let storageKey = null;
  let client;
  try {
    storageKey = await uploadPlotDoc(req.file.buffer, req.file.originalname, req.file.mimetype);
    client = await pool.connect();
    await client.query('BEGIN');

    let kycCaseId = null;
    let clientMemberId = null;
    const { rows: bookingRows } = await client.query(
      `SELECT id, client_member_id, site_id
         FROM bookings
        WHERE plot_id = $1 AND status <> 'CANCELLED'
        ORDER BY id DESC
        LIMIT 1`,
      [plotId]
    );
    const booking = bookingRows[0];
    if (booking) {
      clientMemberId = booking.client_member_id || null;
      const existing = await client.query(
        'SELECT id FROM kyc_cases WHERE booking_id = $1 ORDER BY id DESC LIMIT 1',
        [booking.id]
      );
      if (existing.rows[0]) {
        kycCaseId = existing.rows[0].id;
      } else {
        const created = await client.query(
          `INSERT INTO kyc_cases (booking_id, client_member_id, site_id, mode, status)
           VALUES ($1, $2, $3, 'MANUAL_OCR', 'OPEN')
           RETURNING id`,
          [booking.id, clientMemberId, booking.site_id || plot.site_id]
        );
        kycCaseId = created.rows[0].id;
      }
    }

    const { rows } = await client.query(
      `INSERT INTO documents
         (kyc_case_id, plot_id, client_member_id, site_id, type, category, title,
          original_name, file_path, file_hash, mime_type, file_size,
          ocr_status, ocr_engine, ocr_completed_at, uploaded_source, uploaded_by)
       VALUES ($1, $2, $3, $4, 'OTHER', $5, $6, $7, $8, $9, $10, $11,
               'DONE', 'none', NOW(), 'PLOT_REGISTRY', $12)
       RETURNING id, type, category, title, original_name, file_path, mime_type,
                 file_size, uploaded_source, ocr_status, created_at, kyc_case_id`,
      [
        kycCaseId,
        plotId,
        clientMemberId,
        plot.site_id,
        category,
        title,
        req.file.originalname,
        storageKey,
        fileHash,
        req.file.mimetype,
        req.file.size,
        req.user.id,
      ]
    );
    await client.query('COMMIT');

    const document = rows[0];
    try {
      document.file_url = await getPlotDocUrl(document.file_path);
    } catch {
      document.file_url = null;
    }
    return res.status(201).json({ document, workflow_unlocked: workflowUnlocked });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (storageKey) await deletePlotDoc(storageKey).catch(() => {});
    throw error;
  } finally {
    client?.release();
  }
});

/** DELETE /registries/documents/:docId */
export const deleteRegistryDocument = asyncHandler(async (req, res) => {
  const documentId = parsePositiveId(req.params.docId);
  if (!documentId) return res.status(400).json({ message: 'A valid document ID is required' });

  const { rows: documentRows } = await pool.query(
    `SELECT d.id, d.file_path,
            COALESCE(d.site_id, p.site_id, k.site_id, b.site_id) AS site_id
       FROM documents d
       LEFT JOIN plots p ON p.id = d.plot_id
       LEFT JOIN kyc_cases k ON k.id = d.kyc_case_id
       LEFT JOIN bookings b ON b.id = k.booking_id
      WHERE d.id = $1
        AND d.uploaded_source = 'PLOT_REGISTRY'
        AND UPPER(COALESCE(d.category, '')) = ANY($2::text[])
      LIMIT 1`,
    [documentId, REGISTRY_CATEGORIES]
  );
  const existing = documentRows[0];
  if (!existing) return res.status(404).json({ message: 'Registry document not found' });
  if (!existing.site_id) {
    return res.status(409).json({ message: 'The document is not linked to a site and cannot be removed here' });
  }
  if (!await ensureSiteAccess(req, res, existing.site_id)) return;

  const { rows } = await pool.query(
    `DELETE FROM documents
      WHERE id = $1
        AND uploaded_source = 'PLOT_REGISTRY'
        AND UPPER(COALESCE(category, '')) = ANY($2::text[])
      RETURNING id, file_path`,
    [documentId, REGISTRY_CATEGORIES]
  );
  const document = rows[0];
  if (!document) return res.status(404).json({ message: 'Registry document not found' });

  try {
    await deletePlotDoc(document.file_path);
  } catch (error) {
    console.error(`Registry document ${documentId} storage cleanup failed:`, error.message);
  }

  res.json({ message: 'Document deleted', documentId });
});
