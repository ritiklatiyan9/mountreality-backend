import crypto from 'crypto';
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { uploadPlotDoc, getPlotDocUrl, deletePlotDoc } from '../utils/plotDocStorage.js';

/**
 * Plot Documents controller — a plot-centric view of the SHARED `documents` table.
 *
 * A plot's documents = rows attached directly (documents.plot_id) OR reachable through the
 * booking module's chain (kyc_cases → bookings.plot_id). This unifies Account-uploaded plot
 * docs with Booking-uploaded KYC docs into one source of truth (see migration 059).
 */

// Document categories surfaced in the Account UI (free-text tolerant; stored in `category`).
const VALID_CATEGORIES = new Set([
  'AGREEMENT', 'MAP', 'ALLOTMENT', 'RECEIPT', 'ID_PROOF', 'OTHER',
]);
const REGISTRY_CATEGORIES = new Set(['REGISTRY', 'NOC']);

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

/** GET /plot-documents?site_id=  → plots for a site with a per-plot document count. */
export const listPlotsWithDocs = asyncHandler(async (req, res) => {
  const { site_id, categories } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const siteId = Number.parseInt(site_id, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return res.status(400).json({ message: 'A valid site_id is required' });
  }
  if (!await ensureSiteAccess(req, res, siteId)) return;

  // Optional comma-separated category filter for the generic plot-document view.
  // Registry deeds and NOCs are owned by the separately permissioned registry API.
  const cats = categories
    ? String(categories).split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
    : null;

  // A plot that's been resold gets a new `plots` row per sale cycle (new buyer,
  // its own payment trail) — same plot_no repeats. DISTINCT ON collapses each
  // physical plot down to its latest cycle (most recent created_at) so the
  // Documents view shows one card per plot instead of one per sale.
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (p.site_id, p.plot_no, p.block)
              p.id, p.plot_no, p.block, p.status, p.buyer_name, p.plot_size,
              p.booking_by, p.booking_date, p.team, p.plot_tag, p.sale_price,
              (
                SELECT COUNT(*) FROM documents d
                  LEFT JOIN kyc_cases k ON k.id = d.kyc_case_id
                  LEFT JOIN bookings b ON b.id = k.booking_id
                WHERE (d.plot_id = p.id OR b.plot_id = p.id)
                  AND COALESCE(d.uploaded_source, 'BOOKING') NOT IN ('DMS', 'PLOT_REGISTRY')
                  AND UPPER(COALESCE(d.category, '')) NOT IN ('REGISTRY', 'NOC')
                  AND ($2::text[] IS NULL OR upper(d.category) = ANY($2::text[]))
              )::int AS doc_count
         FROM plots p
        WHERE p.site_id = $1
        ORDER BY p.site_id, p.plot_no, p.block, p.created_at DESC NULLS LAST, p.id DESC
     ) latest
     ORDER BY block ASC NULLS LAST,
              substring(plot_no from '^[^0-9]*') ASC,
              COALESCE(NULLIF(substring(plot_no from '[0-9]+'), '')::bigint, 0) ASC,
              plot_no ASC`,
    [siteId, cats]
  );
  res.json({ plots: rows });
});

/** GET /plot-documents/:plotId  → plot meta + its documents (each with a fresh signed URL). */
export const getPlotDocuments = asyncHandler(async (req, res) => {
  const { plotId } = req.params;

  const { rows: plotRows } = await pool.query(
    `SELECT id, plot_no, block, status, buyer_name, plot_size, plot_size_mtr,
            booking_by, booking_date, sale_price, plot_rate, team, plot_tag, site_id
       FROM plots WHERE id = $1`,
    [plotId]
  );
  const plot = plotRows[0];
  if (!plot) return res.status(404).json({ message: 'Plot not found' });
  if (!await ensureSiteAccess(req, res, plot.site_id)) return;

  const { rows: docs } = await pool.query(
    `SELECT d.id, d.type, d.category, d.title, d.original_name, d.file_path,
            d.mime_type, d.file_size, d.uploaded_source, d.ocr_status, d.created_at,
            d.kyc_case_id, b.id AS booking_id, b.booking_no,
            COALESCE(u.name, u.email) AS uploaded_by_name
       FROM documents d
       LEFT JOIN kyc_cases k ON k.id = d.kyc_case_id
       LEFT JOIN bookings  b ON b.id = k.booking_id
       LEFT JOIN users     u ON u.id = d.uploaded_by
      WHERE (d.plot_id = $1 OR b.plot_id = $1)
        AND COALESCE(d.uploaded_source, 'BOOKING') NOT IN ('DMS', 'PLOT_REGISTRY')
        AND UPPER(COALESCE(d.category, '')) NOT IN ('REGISTRY', 'NOC')
      ORDER BY d.created_at DESC, d.id DESC`,
    [plotId]
  );

  for (const d of docs) {
    try { d.file_url = await getPlotDocUrl(d.file_path); } catch { d.file_url = null; }
  }

  res.json({ plot, documents: docs });
});

/**
 * POST /plot-documents/:plotId  (multipart: file=<binary>, category, title)
 * Stores the file in the shared S3 bucket and inserts a `documents` row linked to the plot.
 * If the plot has a (non-cancelled) booking, the doc is ALSO attached to that booking's KYC
 * case so it appears on the Booking app's /bookings/:id page (bidirectional integration).
 */
export const uploadPlotDocument = asyncHandler(async (req, res) => {
  const { plotId } = req.params;
  if (!req.file) return res.status(400).json({ message: 'No file uploaded (field name: file)' });

  const { rows: plotRows } = await pool.query('SELECT id, site_id FROM plots WHERE id = $1', [plotId]);
  const plot = plotRows[0];
  if (!plot) return res.status(404).json({ message: 'Plot not found' });
  if (!await ensureSiteAccess(req, res, plot.site_id)) return;

  const rawCat = String(req.body.category || 'OTHER').toUpperCase();
  if (REGISTRY_CATEGORIES.has(rawCat)) {
    return res.status(400).json({
      message: 'Upload registry deeds and NOCs from the Plot Registry module',
    });
  }
  const category = VALID_CATEGORIES.has(rawCat) ? rawCat : 'OTHER';
  const title = req.body.title ? String(req.body.title).trim() : null;

  // If a live booking exists for this plot, link the doc to its KYC case so the booking app
  // shows it too. Pick the most recent non-cancelled booking.
  let kycCaseId = null;
  let clientMemberId = null;
  const { rows: bookingRows } = await pool.query(
    `SELECT id, client_member_id, site_id FROM bookings
      WHERE plot_id = $1 AND status <> 'CANCELLED'
      ORDER BY id DESC LIMIT 1`,
    [plotId]
  );
  const booking = bookingRows[0];
  if (booking) {
    clientMemberId = booking.client_member_id || null;
    const existing = await pool.query(
      'SELECT id FROM kyc_cases WHERE booking_id = $1 ORDER BY id DESC LIMIT 1',
      [booking.id]
    );
    if (existing.rows[0]) {
      kycCaseId = existing.rows[0].id;
    } else {
      const created = await pool.query(
        `INSERT INTO kyc_cases (booking_id, client_member_id, site_id, mode, status)
         VALUES ($1, $2, $3, 'MANUAL_OCR', 'OPEN') RETURNING id`,
        [booking.id, booking.client_member_id || null, booking.site_id || plot.site_id]
      );
      kycCaseId = created.rows[0].id;
    }
  }

  const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  let storageKey;
  try {
    storageKey = await uploadPlotDoc(req.file.buffer, req.file.originalname, req.file.mimetype);

    // type stays 'OTHER' so the existing documents_type_check constraint is untouched; the human
    // category lives in `category`. Archival docs skip OCR (status DONE).
    const { rows } = await pool.query(
      `INSERT INTO documents
         (kyc_case_id, plot_id, client_member_id, site_id, type, category, title,
          original_name, file_path, file_hash, mime_type, file_size,
          ocr_status, ocr_engine, ocr_completed_at, uploaded_source, uploaded_by)
       VALUES ($1, $2, $3, $4, 'OTHER', $5, $6, $7, $8, $9, $10, $11, 'DONE', 'none', now(), 'ACCOUNT', $12)
       RETURNING id, type, category, title, original_name, file_path, mime_type, file_size,
                 uploaded_source, ocr_status, created_at, kyc_case_id`,
      [
        kycCaseId, plotId, clientMemberId, plot.site_id, category, title,
        req.file.originalname, storageKey, fileHash, req.file.mimetype, req.file.size,
        req.user?.id || null,
      ]
    );

    const doc = rows[0];
    try { doc.file_url = await getPlotDocUrl(doc.file_path); } catch { doc.file_url = null; }
    res.status(201).json(doc);
  } catch (error) {
    if (storageKey) await deletePlotDoc(storageKey).catch(() => {});
    throw error;
  }
});

/** DELETE /plot-documents/doc/:docId  → remove the file + DB row (cascades ocr_results). */
export const deletePlotDocument = asyncHandler(async (req, res) => {
  const { docId } = req.params;
  const { rows } = await pool.query(
    `SELECT d.id, d.file_path,
            COALESCE(d.site_id, p.site_id, k.site_id, b.site_id) AS site_id
       FROM documents d
       LEFT JOIN plots p ON p.id = d.plot_id
       LEFT JOIN kyc_cases k ON k.id = d.kyc_case_id
       LEFT JOIN bookings b ON b.id = k.booking_id
      WHERE d.id = $1
        AND COALESCE(d.uploaded_source, 'BOOKING') NOT IN ('DMS', 'PLOT_REGISTRY')
        AND UPPER(COALESCE(d.category, '')) NOT IN ('REGISTRY', 'NOC')
        AND (d.plot_id IS NOT NULL OR b.plot_id IS NOT NULL)
      LIMIT 1`,
    [docId]
  );
  const doc = rows[0];
  if (!doc) return res.status(404).json({ message: 'Document not found' });
  if (!doc.site_id) {
    return res.status(409).json({ message: 'The document is not linked to a site and cannot be removed here' });
  }
  if (!await ensureSiteAccess(req, res, doc.site_id)) return;

  const deleted = await pool.query(
    `DELETE FROM documents
      WHERE id = $1
        AND COALESCE(uploaded_source, 'BOOKING') NOT IN ('DMS', 'PLOT_REGISTRY')
        AND UPPER(COALESCE(category, '')) NOT IN ('REGISTRY', 'NOC')
      RETURNING id, file_path`,
    [docId]
  );
  if (!deleted.rows[0]) return res.status(404).json({ message: 'Document not found' });
  try { await deletePlotDoc(deleted.rows[0].file_path); } catch { /* best-effort file cleanup */ }

  res.json({ message: 'Document deleted', documentId: Number(docId) });
});
