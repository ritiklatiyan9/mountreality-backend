import crypto from 'crypto';
import path from 'path';
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import {
  uploadPlotDoc, getPlotDocUrl, getPlotDocBytes, deletePlotDoc,
} from '../utils/plotDocStorage.js';
import { runDmsOcr, isOcrable } from '../services/dmsOcr.service.js';

/**
 * Document Search / DMS controller.
 *
 * DMS rows live in the shared `documents` table and are isolated by
 * uploaded_source='DMS'. Migration 069 adds their metadata, dates, OCR text,
 * and PostgreSQL full-text indexes.
 */

const VALID_CATEGORIES = new Set(['KHATAUNI', 'SALE_DEED', 'AGREEMENT', 'REGISTRY', 'MAP', 'OTHER']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIME_BY_EXTENSION = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const OCR_STALE_INTERVAL = '10 minutes';

// List/card columns deliberately exclude the potentially large OCR body.
const LIST_COLS = `
  d.id, d.category, d.title, d.original_name, d.file_path, d.mime_type, d.file_size,
  d.metadata, d.doc_date, d.expiry_date, d.ocr_status, d.ocr_engine, d.created_at,
  COALESCE(u.name, u.email) AS uploaded_by_name`;

const normalizeCategory = (value) => {
  const category = String(value || 'OTHER').toUpperCase();
  return VALID_CATEGORIES.has(category) ? category : 'OTHER';
};

// Browsers sometimes report an allowed file as application/octet-stream. Use
// the already-validated extension so PDF OCR is not silently skipped.
const normalizeMime = (file) => {
  const supplied = String(file?.mimetype || '').toLowerCase();
  if (supplied && supplied !== 'application/octet-stream') return supplied;
  return MIME_BY_EXTENSION[path.extname(file?.originalname || '').toLowerCase()] || supplied;
};

const validDate = (value) => {
  if (value === undefined || value === null || value === '') return true;
  const text = String(value);
  if (!DATE_RE.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
};

const storedDateText = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

const parseMetadata = (value) => {
  if (value === undefined || value === null || value === '') return { value: {} };
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      return { error: 'Document details must be a JSON object.' };
    }
    if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > 32 * 1024) {
      return { error: 'Document details are too large.' };
    }
    return { value: parsed };
  } catch {
    return { error: 'Document details contain invalid JSON.' };
  }
};

const parseId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const escapeLike = (value) => String(value).replace(/[\\%_]/g, '\\$&');

const getAccessibleSiteId = async (req, res, rawSiteId) => {
  const siteId = parseId(rawSiteId);
  if (!siteId) {
    res.status(400).json({ message: 'A valid site_id is required.' });
    return null;
  }

  const { rows } = await pool.query('SELECT id FROM sites WHERE id = $1 LIMIT 1', [siteId]);
  if (!rows[0]) {
    res.status(404).json({ message: 'Site not found.' });
    return null;
  }

  if (!['admin', 'super_admin'].includes(req.user?.role)) {
    const access = await pool.query(
      'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
      [req.user?.id, siteId]
    );
    if (!access.rows[0]) {
      res.status(403).json({ message: 'Access denied to this site.' });
      return null;
    }
  }

  return siteId;
};

// Do not expose the internal S3 key. Every response receives a fresh signed URL.
const toPublicDocument = async (document) => {
  const result = { ...document };
  try { result.file_url = await getPlotDocUrl(result.file_path); } catch { result.file_url = null; }
  delete result.file_path;
  delete result.total_count;
  return result;
};

/**
 * GET /documents/unassigned
 *
 * Legacy DMS rows with no site are deliberately invisible to normal search.
 * This admin-only queue exposes just enough metadata and a short-lived signed
 * preview URL for an administrator to determine the correct destination.
 */
export const listUnassignedDmsDocuments = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 24, 1), 100);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);

  const [{ rows }, countResult] = await Promise.all([
    pool.query(
      `SELECT ${LIST_COLS}, d.ocr_error
         FROM documents d
         LEFT JOIN users u ON u.id = d.uploaded_by
        WHERE d.uploaded_source = 'DMS'
          AND d.site_id IS NULL
        ORDER BY d.created_at ASC, d.id ASC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total
         FROM documents
        WHERE uploaded_source = 'DMS'
          AND site_id IS NULL`
    ),
  ]);

  const total = countResult.rows[0]?.total || 0;
  const documents = await Promise.all(rows.map(toPublicDocument));
  res.json({
    documents,
    total,
    limit,
    offset,
    has_more: offset + documents.length < total,
  });
});

/** PATCH /documents/unassigned/:id/assign */
export const assignUnassignedDmsDocument = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid document ID.' });

  const siteId = await getAccessibleSiteId(req, res, req.body.site_id);
  if (!siteId) return;

  // The NULL predicate is the concurrency guard: once one administrator has
  // assigned a row, a stale second dialog cannot silently move it elsewhere.
  const { rows } = await pool.query(
    `WITH assigned AS (
       UPDATE documents
          SET site_id = $1, updated_at = now()
        WHERE id = $2
          AND uploaded_source = 'DMS'
          AND site_id IS NULL
       RETURNING *
     )
     SELECT ${LIST_COLS}
       FROM assigned d
       LEFT JOIN users u ON u.id = d.uploaded_by`,
    [siteId, id]
  );

  if (!rows[0]) {
    const existing = await pool.query(
      `SELECT site_id
         FROM documents
        WHERE id = $1 AND uploaded_source = 'DMS'
        LIMIT 1`,
      [id]
    );
    if (!existing.rows[0]) return res.status(404).json({ message: 'Legacy document not found.' });
    return res.status(409).json({ message: 'This document has already been assigned to a site.' });
  }

  res.json({
    message: 'Document assigned to the selected site.',
    document: await toPublicDocument({ ...rows[0], site_id: siteId }),
  });
});

/**
 * Build a safe prefix tsquery. Unicode combining marks are retained because
 * Devanagari vowel signs and halants are marks rather than letters.
 */
export const buildTsQuery = (query) =>
  String(query || '')
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}\p{M}]/gu, ''))
    .filter(Boolean)
    .slice(0, 12)
    .map((term) => `${term}:*`)
    .join(' & ');

// OCR runs after the upload response. Failures are persisted and can be retried
// from the UI without making an otherwise successful file upload fail.
const processDmsOcr = async (documentId, buffer, mimeType) => {
  try {
    await pool.query(
      `UPDATE documents
          SET ocr_status='PROCESSING', ocr_started_at=now(), updated_at=now()
        WHERE id=$1 AND uploaded_source='DMS'`,
      [documentId]
    );
    const { text, engine } = await runDmsOcr(buffer, mimeType);
    await pool.query(
      `UPDATE documents
          SET ocr_text=$1, ocr_status='DONE', ocr_engine=$2,
              ocr_completed_at=now(), ocr_error=NULL, updated_at=now()
        WHERE id=$3 AND uploaded_source='DMS'`,
      [text, engine, documentId]
    );
  } catch (error) {
    await pool.query(
      `UPDATE documents
          SET ocr_status='FAILED', ocr_error=$1, ocr_completed_at=now(), updated_at=now()
        WHERE id=$2 AND uploaded_source='DMS'`,
      [String(error?.message || error).slice(0, 2000), documentId]
    ).catch(() => {});
    console.error(`[dms ocr] document ${documentId} failed:`, error.message);
  }
};

/** POST /documents (multipart file + metadata). */
export const uploadDmsDocument = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.body.site_id);
  if (!siteId) return;
  if (!req.file) return res.status(400).json({ message: 'Select a file to upload.' });
  if (!req.file.size) return res.status(400).json({ message: 'The selected file is empty.' });

  const category = normalizeCategory(req.body.category);
  const fallbackTitle = (req.file.originalname || 'Document').replace(/\.[^.]+$/, '');
  const title = String(req.body.title || fallbackTitle).trim().slice(0, 300) || fallbackTitle;
  const docDate = req.body.doc_date || null;
  const expiryDate = req.body.expiry_date || null;

  if (!validDate(docDate) || !validDate(expiryDate)) {
    return res.status(400).json({ message: 'Document and expiry dates must use YYYY-MM-DD format.' });
  }
  if (docDate && expiryDate && expiryDate < docDate) {
    return res.status(400).json({ message: 'Expiry date cannot be earlier than the document date.' });
  }

  const parsedMetadata = parseMetadata(req.body.metadata);
  if (parsedMetadata.error) return res.status(400).json({ message: parsedMetadata.error });

  const mimeType = normalizeMime(req.file);
  const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  let storageKey;

  try {
    storageKey = await uploadPlotDoc(req.file.buffer, req.file.originalname, mimeType);
    const willOcr = isOcrable(mimeType);
    const { rows } = await pool.query(
      `INSERT INTO documents
         (site_id, type, category, title, original_name, file_path, file_hash, mime_type, file_size,
          metadata, doc_date, expiry_date, ocr_status, ocr_engine, ocr_completed_at,
          uploaded_source, uploaded_by)
       VALUES ($1, 'OTHER', $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::date, $11::date,
               $12, $13, $14, 'DMS', $15)
       RETURNING id, category, title, original_name, file_path, mime_type, file_size,
                 metadata, doc_date, expiry_date, ocr_status, ocr_engine, created_at`,
      [
        siteId,
        category,
        title,
        req.file.originalname,
        storageKey,
        fileHash,
        mimeType,
        req.file.size,
        JSON.stringify(parsedMetadata.value),
        docDate,
        expiryDate,
        willOcr ? 'PENDING' : 'DONE',
        willOcr ? null : 'none',
        willOcr ? null : new Date(),
        req.user?.id || null,
      ]
    );

    const document = rows[0];
    res.status(201).json(await toPublicDocument(document));
    if (willOcr) void processDmsOcr(document.id, req.file.buffer, mimeType);
  } catch (error) {
    // S3/local storage succeeded but the DB insert did not: remove the orphan.
    if (storageKey) await deletePlotDoc(storageKey).catch(() => {});
    throw error;
  }
});

/** GET /documents?q=&category=&from=&to=&expiring=&limit=&offset=. */
export const searchDmsDocuments = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.query.site_id);
  if (!siteId) return;
  const { category, from, to, expiring } = req.query;
  const query = String(req.query.q || '').trim().slice(0, 200);
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 100);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);

  if (category && category !== 'ALL' && !VALID_CATEGORIES.has(String(category).toUpperCase())) {
    return res.status(400).json({ message: 'Unknown document type.' });
  }
  if (!validDate(from) || !validDate(to)) {
    return res.status(400).json({ message: 'Date filters must use YYYY-MM-DD format.' });
  }
  if (from && to && String(from) > String(to)) {
    return res.status(400).json({ message: 'The start date cannot be after the end date.' });
  }

  // OCR runs asynchronously in this process. If a deploy or crash interrupted a
  // job, make it actionable instead of polling a permanent PROCESSING state.
  await pool.query(
    `UPDATE documents
        SET ocr_status = 'FAILED',
            ocr_error = 'Text extraction was interrupted. Retry the document.',
            ocr_completed_at = now(),
            updated_at = now()
      WHERE uploaded_source = 'DMS'
        AND site_id = $1
        AND ocr_status IN ('PENDING', 'PROCESSING')
        AND COALESCE(ocr_started_at, created_at) < now() - $2::interval`,
    [siteId, OCR_STALE_INTERVAL]
  );

  const params = [];
  const add = (value) => { params.push(value); return `$${params.length}`; };
  const filters = [
    `d.uploaded_source = 'DMS'`,
    `d.site_id = ${add(siteId)}`,
  ];

  if (category && category !== 'ALL') filters.push(`d.category = ${add(String(category).toUpperCase())}`);
  if (from) filters.push(`d.doc_date >= ${add(from)}::date`);
  if (to) filters.push(`d.doc_date <= ${add(to)}::date`);
  if (expiring) {
    const days = Math.min(Math.max(Number.parseInt(expiring, 10) || 30, 1), 365);
    filters.push(`d.expiry_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + ${add(days)}::int)`);
  }

  const tsQuery = buildTsQuery(query);
  let rankExpression = '0::float4';
  let snippetExpression = 'NULL::text';

  if (query) {
    const likeParam = add(`%${escapeLike(query)}%`);
    if (tsQuery) {
      const tsParam = add(tsQuery);
      filters.push(`(
        d.search_tsv @@ to_tsquery('simple', ${tsParam})
        OR d.ocr_text ILIKE ${likeParam} ESCAPE E'\\\\'
        OR d.title ILIKE ${likeParam} ESCAPE E'\\\\'
        OR d.original_name ILIKE ${likeParam} ESCAPE E'\\\\'
        OR d.metadata::text ILIKE ${likeParam} ESCAPE E'\\\\'
      )`);
      rankExpression = `CASE WHEN d.search_tsv @@ to_tsquery('simple', ${tsParam})
        THEN ts_rank(d.search_tsv, to_tsquery('simple', ${tsParam})) ELSE 0::float4 END`;
      snippetExpression = `CASE WHEN d.search_tsv @@ to_tsquery('simple', ${tsParam})
        THEN ts_headline(
          'simple', left(coalesce(d.ocr_text, d.title, ''), 20000),
          to_tsquery('simple', ${tsParam}),
          'MaxFragments=2,MinWords=3,MaxWords=14,StartSel=«,StopSel=»'
        ) ELSE NULL END`;
    } else {
      filters.push(`(
        d.ocr_text ILIKE ${likeParam} ESCAPE E'\\\\'
        OR d.title ILIKE ${likeParam} ESCAPE E'\\\\'
        OR d.original_name ILIKE ${likeParam} ESCAPE E'\\\\'
        OR d.metadata::text ILIKE ${likeParam} ESCAPE E'\\\\'
      )`);
    }
  }

  const whereSql = filters.join(' AND ');
  const summarySql = `
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE d.ocr_status = 'DONE')::int AS searchable,
           COUNT(*) FILTER (WHERE d.ocr_status IN ('PENDING', 'PROCESSING'))::int AS processing,
           COUNT(*) FILTER (WHERE d.ocr_status = 'FAILED')::int AS failed,
           COUNT(*) FILTER (
             WHERE d.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
           )::int AS expiring
      FROM documents d
     WHERE ${whereSql}`;
  const summaryParams = [...params];

  const sql = `
    SELECT ${LIST_COLS}, ${rankExpression} AS rank, ${snippetExpression} AS snippet
      FROM documents d
      LEFT JOIN users u ON u.id = d.uploaded_by
     WHERE ${whereSql}
     ORDER BY rank DESC, d.created_at DESC, d.id DESC
     LIMIT ${add(limit)} OFFSET ${add(offset)}`;

  const [{ rows }, { rows: summaryRows }] = await Promise.all([
    pool.query(sql, params),
    pool.query(summarySql, summaryParams),
  ]);
  const summary = summaryRows[0] || {
    total: 0, searchable: 0, processing: 0, failed: 0, expiring: 0,
  };
  const total = summary.total || 0;
  const documents = await Promise.all(rows.map(toPublicDocument));
  res.json({
    documents,
    total,
    summary,
    limit,
    offset,
    has_more: offset + documents.length < total,
  });
});

/** GET /documents/:id, including its OCR text. */
export const getDmsDocument = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.query.site_id);
  if (!siteId) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid document ID.' });

  const { rows } = await pool.query(
    `SELECT d.id, d.category, d.title, d.original_name, d.file_path, d.mime_type, d.file_size,
            d.metadata, d.doc_date, d.expiry_date, d.ocr_status, d.ocr_engine, d.ocr_error,
            d.ocr_text, d.created_at, COALESCE(u.name, u.email) AS uploaded_by_name
       FROM documents d
       LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.id = $1 AND d.site_id = $2 AND d.uploaded_source = 'DMS'`,
    [id, siteId]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Document not found.' });
  res.json(await toPublicDocument(rows[0]));
});

/** PATCH /documents/:id. */
export const updateDmsDocument = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.body.site_id);
  if (!siteId) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid document ID.' });
  if (!validDate(req.body.doc_date) || !validDate(req.body.expiry_date)) {
    return res.status(400).json({ message: 'Document and expiry dates must use YYYY-MM-DD format.' });
  }
  if (req.body.doc_date && req.body.expiry_date && req.body.expiry_date < req.body.doc_date) {
    return res.status(400).json({ message: 'Expiry date cannot be earlier than the document date.' });
  }
  if (req.body.category !== undefined
      && !VALID_CATEGORIES.has(String(req.body.category).toUpperCase())) {
    return res.status(400).json({ message: 'Unknown document type.' });
  }

  // A partial PATCH must still be valid against the date already stored in the
  // other field; checking only when both values are present lets invalid ranges
  // slip through over two requests.
  if (req.body.doc_date !== undefined || req.body.expiry_date !== undefined) {
    const { rows: dateRows } = await pool.query(
      `SELECT doc_date, expiry_date
         FROM documents
        WHERE id = $1 AND site_id = $2 AND uploaded_source = 'DMS'`,
      [id, siteId]
    );
    if (!dateRows[0]) return res.status(404).json({ message: 'Document not found.' });
    const storedDocDate = storedDateText(dateRows[0].doc_date);
    const storedExpiryDate = storedDateText(dateRows[0].expiry_date);
    const nextDocDate = req.body.doc_date !== undefined ? (req.body.doc_date || null) : storedDocDate;
    const nextExpiryDate = req.body.expiry_date !== undefined ? (req.body.expiry_date || null) : storedExpiryDate;
    if (nextDocDate && nextExpiryDate && nextExpiryDate < nextDocDate) {
      return res.status(400).json({ message: 'Expiry date cannot be earlier than the document date.' });
    }
  }

  const params = [];
  const add = (value) => { params.push(value); return `$${params.length}`; };
  const sets = [];

  if (req.body.category !== undefined) sets.push(`category = ${add(normalizeCategory(req.body.category))}`);
  if (req.body.title !== undefined) sets.push(`title = ${add(String(req.body.title).trim().slice(0, 300) || null)}`);
  if (req.body.doc_date !== undefined) sets.push(`doc_date = ${add(req.body.doc_date || null)}::date`);
  if (req.body.expiry_date !== undefined) sets.push(`expiry_date = ${add(req.body.expiry_date || null)}::date`);
  if (req.body.metadata !== undefined) {
    const parsedMetadata = parseMetadata(req.body.metadata);
    if (parsedMetadata.error) return res.status(400).json({ message: parsedMetadata.error });
    sets.push(`metadata = ${add(JSON.stringify(parsedMetadata.value))}::jsonb`);
  }

  if (!sets.length) return res.status(400).json({ message: 'No changes were provided.' });
  sets.push('updated_at = now()');

  const { rows } = await pool.query(
    `UPDATE documents SET ${sets.join(', ')}
      WHERE id = ${add(id)} AND site_id = ${add(siteId)} AND uploaded_source = 'DMS'
      RETURNING id, category, title, doc_date, expiry_date, metadata`,
    params
  );
  if (!rows[0]) return res.status(404).json({ message: 'Document not found.' });
  res.json(rows[0]);
});

/** POST /documents/:id/retry-ocr. */
export const retryOcr = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.body.site_id);
  if (!siteId) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid document ID.' });

  const { rows } = await pool.query(
    `SELECT id, file_path, mime_type, ocr_status, ocr_started_at, created_at
       FROM documents
      WHERE id = $1 AND site_id = $2 AND uploaded_source = 'DMS'`,
    [id, siteId]
  );
  const document = rows[0];
  if (!document) return res.status(404).json({ message: 'Document not found.' });
  if (!isOcrable(document.mime_type)) {
    return res.status(400).json({ message: 'This file type does not support text extraction.' });
  }
  const { rows: claimedRows } = await pool.query(
    `UPDATE documents
        SET ocr_status = 'PENDING', ocr_error = NULL,
            ocr_started_at = now(), ocr_completed_at = NULL, updated_at = now()
      WHERE id = $1 AND site_id = $2 AND uploaded_source = 'DMS'
        AND (
          ocr_status NOT IN ('PENDING', 'PROCESSING')
          OR COALESCE(ocr_started_at, created_at) < now() - $3::interval
        )
      RETURNING id`,
    [id, siteId, OCR_STALE_INTERVAL]
  );
  if (!claimedRows[0]) {
    return res.status(409).json({ message: 'Text extraction is already running.' });
  }

  let buffer;
  try {
    buffer = await getPlotDocBytes(document.file_path);
  } catch {
    await pool.query(
      `UPDATE documents
          SET ocr_status='FAILED', ocr_error='The stored file could not be read.',
              ocr_completed_at=now(), updated_at=now()
        WHERE id=$1 AND site_id=$2 AND uploaded_source='DMS'`,
      [id, siteId]
    ).catch(() => {});
    return res.status(502).json({ message: 'The stored file could not be read for text extraction.' });
  }
  res.json({ message: 'Text extraction restarted.', id });
  void processDmsOcr(id, buffer, document.mime_type);
});

/** DELETE /documents/:id. */
export const deleteDmsDocument = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.query.site_id);
  if (!siteId) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid document ID.' });

  // Delete the row first so a temporary S3 cleanup failure never leaves a broken
  // record in search. Storage cleanup remains best-effort.
  const { rows } = await pool.query(
    `DELETE FROM documents
      WHERE id = $1 AND site_id = $2 AND uploaded_source = 'DMS'
      RETURNING id, file_path`,
    [id, siteId]
  );
  const document = rows[0];
  if (!document) return res.status(404).json({ message: 'Document not found.' });

  try { await deletePlotDoc(document.file_path); } catch { /* best-effort cleanup */ }
  res.json({ message: 'Document deleted.', id });
});
