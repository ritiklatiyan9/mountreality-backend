import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { uploadPlotDoc, getPlotDocUrl, deletePlotDoc } from '../utils/plotDocStorage.js';

/**
 * Document Imprest — register of physical documents handed over on site.
 *
 * Every issue is recorded with a camera photo taken at the moment of handover
 * (the proof), optionally an expected-return deadline, and later the return
 * with its own optional proof photo. Rows are the permanent history, scoped
 * to one site. Admins can work across sites; sub-admins can only access
 * records for sites assigned to them in user_sites. Each action stamps who did it.
 */

const S3_PREFIX = 'document_imprest';

const isAdminRole = (role) => role === 'admin' || role === 'super_admin';

const ensureSiteAccess = async (req, res, siteId) => {
  if (isAdminRole(req.user.role)) return true;

  const { rows } = await pool.query(
    'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
    [req.user.id, siteId]
  );
  if (rows[0]) return true;

  res.status(403).json({ message: 'Access denied to this site' });
  return false;
};

/** Resolve the record's authoritative site before exposing proof keys or mutating it. */
const getAccessibleRecord = async (req, res, id) => {
  const { rows } = await pool.query('SELECT * FROM document_imprest WHERE id = $1', [id]);
  const record = rows[0];
  if (!record) {
    res.status(404).json({ message: 'Record not found' });
    return null;
  }
  if (!await ensureSiteAccess(req, res, record.site_id)) return null;
  return record;
};

const getSiteReceiver = async (receiverUserId, siteId) => {
  const { rows } = await pool.query(
    `SELECT u.id
       FROM users u
      WHERE u.id = $1
        AND u.is_active = true
        AND (
          u.role IN ('admin', 'super_admin')
          OR EXISTS (
            SELECT 1 FROM user_sites us
             WHERE us.user_id = u.id AND us.site_id = $2
          )
        )
      LIMIT 1`,
    [receiverUserId, siteId]
  );
  return rows[0] || null;
};

const RECORD_SELECT = `
  SELECT di.*,
         iu.name  AS issued_by_name,   iu.email AS issued_by_email,
         ru.name  AS receiver_user_name, ru.email AS receiver_user_email,
         rb.name  AS return_received_by_name
    FROM document_imprest di
    LEFT JOIN users iu ON iu.id = di.issued_by
    LEFT JOIN users ru ON ru.id = di.receiver_user_id
    LEFT JOIN users rb ON rb.id = di.return_received_by
`;

/** Attach fresh signed URLs for the proof photos and strip raw storage keys. */
const withPhotoUrls = async (row) => {
  const r = { ...row };
  try { r.photo_url = await getPlotDocUrl(r.photo_key); } catch { r.photo_url = null; }
  try { r.return_photo_url = r.return_photo_key ? await getPlotDocUrl(r.return_photo_key) : null; } catch { r.return_photo_url = null; }
  delete r.photo_key;
  delete r.return_photo_key;
  return r;
};

/**
 * GET /document-imprest?site_id=&status=&q=
 * Site-scoped register, newest first, plus summary counts for that site.
 * status: ISSUED | RETURNED | OVERDUE (overdue = still out past its deadline).
 */
export const listDocumentImprest = asyncHandler(async (req, res) => {
  const { status, q, site_id } = req.query;
  const siteId = parseInt(site_id, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) return res.status(400).json({ message: 'A valid site_id is required' });
  if (!await ensureSiteAccess(req, res, siteId)) return;

  const where = [];
  const params = [siteId];
  where.push('di.site_id = $1');

  if (status === 'OVERDUE') {
    where.push(`di.status = 'ISSUED' AND di.expected_return_at IS NOT NULL AND di.expected_return_at < now()`);
  } else if (status === 'ISSUED' || status === 'RETURNED') {
    params.push(status);
    where.push(`di.status = $${params.length}`);
  }
  if (q && String(q).trim()) {
    params.push(`%${String(q).trim()}%`);
    const p = `$${params.length}`;
    where.push(`(di.document_name ILIKE ${p} OR di.receiver_name ILIKE ${p} OR ru.name ILIKE ${p} OR iu.name ILIKE ${p})`);
  }

  const { rows } = await pool.query(
    `${RECORD_SELECT}
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY di.created_at DESC, di.id DESC
     LIMIT 500`,
    params
  );

  const { rows: [stats] } = await pool.query(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'ISSUED')::int   AS issued,
           COUNT(*) FILTER (WHERE status = 'RETURNED')::int AS returned,
           COUNT(*) FILTER (WHERE status = 'ISSUED' AND expected_return_at IS NOT NULL AND expected_return_at < now())::int AS overdue
      FROM document_imprest
     WHERE site_id = $1
  `, [siteId]);

  res.json({ records: await Promise.all(rows.map(withPhotoUrls)), stats });
});

/**
 * POST /document-imprest  (multipart)
 * Record a handover. Requires: document_name + photo (the camera proof).
 * Receiver is a system user (receiver_user_id) or a free-text name (receiver_name).
 * expected_return_at (ISO string) is optional — absent means open-ended.
 */
export const createDocumentImprest = asyncHandler(async (req, res) => {
  const { document_name, description, receiver_user_id, receiver_name, expected_return_at, remarks, site_id } = req.body;

  if (!document_name || !String(document_name).trim()) {
    return res.status(400).json({ message: 'Document name is required' });
  }
  if (!req.file) {
    return res.status(400).json({ message: 'A handover photo is required as proof' });
  }
  const siteId = parseInt(site_id, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) return res.status(400).json({ message: 'A valid site_id is required' });
  const { rows: siteRows } = await pool.query('SELECT id FROM sites WHERE id = $1', [siteId]);
  if (!siteRows[0]) return res.status(400).json({ message: 'Site not found' });
  if (!await ensureSiteAccess(req, res, siteId)) return;

  let receiverUserId = null;
  if (receiver_user_id) {
    receiverUserId = parseInt(receiver_user_id, 10);
    if (Number.isNaN(receiverUserId)) return res.status(400).json({ message: 'Invalid receiver_user_id' });
    if (!await getSiteReceiver(receiverUserId, siteId)) {
      return res.status(400).json({ message: 'Receiver is not available for this site' });
    }
  }
  const receiverName = receiver_name && String(receiver_name).trim() ? String(receiver_name).trim() : null;
  if (!receiverUserId && !receiverName) {
    return res.status(400).json({ message: 'Select a receiver or enter the receiver name' });
  }

  let expectedReturnAt = null;
  if (expected_return_at) {
    expectedReturnAt = new Date(expected_return_at);
    if (Number.isNaN(expectedReturnAt.getTime())) return res.status(400).json({ message: 'Invalid expected return time' });
  }

  let photoKey = null;
  let photoPersisted = false;
  try {
    photoKey = await uploadPlotDoc(req.file.buffer, req.file.originalname || 'handover.jpg', req.file.mimetype, S3_PREFIX);

    const { rows: [created] } = await pool.query(
      `INSERT INTO document_imprest
         (document_name, description, receiver_user_id, receiver_name, issued_by, photo_key, expected_return_at, remarks, site_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [String(document_name).trim(), description || null, receiverUserId, receiverName, req.user.id, photoKey, expectedReturnAt, remarks || null, siteId]
    );
    photoPersisted = true;

    const { rows } = await pool.query(`${RECORD_SELECT} WHERE di.id = $1`, [created.id]);
    res.status(201).json({ record: await withPhotoUrls(rows[0]) });
  } catch (error) {
    if (photoKey && !photoPersisted) await deletePlotDoc(photoKey).catch(() => {});
    throw error;
  }
});

/**
 * PUT /document-imprest/:id
 * Edit a record's details (name, description, receiver, deadline, remarks).
 * The handover proof photo is immutable — that's the point of it.
 * Gated by the document_imprest `update` permission at the route.
 */
export const updateDocumentImprest = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ message: 'Invalid id' });

  const existing = await getAccessibleRecord(req, res, id);
  if (!existing) return;

  const { document_name, description, receiver_user_id, receiver_name, expected_return_at, remarks } = req.body;

  if (!document_name || !String(document_name).trim()) {
    return res.status(400).json({ message: 'Document name is required' });
  }

  let receiverUserId = null;
  if (receiver_user_id) {
    receiverUserId = parseInt(receiver_user_id, 10);
    if (Number.isNaN(receiverUserId)) return res.status(400).json({ message: 'Invalid receiver_user_id' });
    if (!await getSiteReceiver(receiverUserId, existing.site_id)) {
      return res.status(400).json({ message: 'Receiver is not available for this site' });
    }
  }
  const receiverName = receiver_name && String(receiver_name).trim() ? String(receiver_name).trim() : null;
  if (!receiverUserId && !receiverName) {
    return res.status(400).json({ message: 'Select a receiver or enter the receiver name' });
  }

  let expectedReturnAt = null;
  if (expected_return_at) {
    expectedReturnAt = new Date(expected_return_at);
    if (Number.isNaN(expectedReturnAt.getTime())) return res.status(400).json({ message: 'Invalid expected return time' });
  }

  await pool.query(
    `UPDATE document_imprest
        SET document_name = $2, description = $3, receiver_user_id = $4,
            receiver_name = $5, expected_return_at = $6, remarks = $7
      WHERE id = $1`,
    [id, String(document_name).trim(), description || null, receiverUserId, receiverName, expectedReturnAt, remarks || null]
  );

  const { rows } = await pool.query(`${RECORD_SELECT} WHERE di.id = $1`, [id]);
  res.json({ record: await withPhotoUrls(rows[0]) });
});

/**
 * DELETE /document-imprest/:id
 * Remove a record and its proof photos (best-effort S3 cleanup).
 * Gated by the document_imprest `delete` permission at the route —
 * admins only unless a sub-admin is explicitly granted delete.
 */
export const deleteDocumentImprest = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ message: 'Invalid id' });

  const record = await getAccessibleRecord(req, res, id);
  if (!record) return;

  await pool.query('DELETE FROM document_imprest WHERE id = $1', [id]);
  try { await deletePlotDoc(record.photo_key); } catch { /* best-effort */ }
  try { await deletePlotDoc(record.return_photo_key); } catch { /* best-effort */ }

  res.json({ message: 'Record deleted' });
});

/**
 * POST /document-imprest/:id/return  (multipart)
 * Mark a document as returned. Photo proof and remarks are optional here —
 * the mandatory proof was captured at handover.
 */
export const returnDocumentImprest = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ message: 'Invalid id' });

  const existing = await getAccessibleRecord(req, res, id);
  if (!existing) return;
  if (existing.status === 'RETURNED') return res.status(409).json({ message: 'Document is already marked returned' });

  let returnPhotoKey = null;
  let returnPhotoPersisted = false;
  try {
    if (req.file) {
      returnPhotoKey = await uploadPlotDoc(req.file.buffer, req.file.originalname || 'return.jpg', req.file.mimetype, S3_PREFIX);
    }

    const { rows: transitionedRows } = await pool.query(
      `UPDATE document_imprest
          SET status = 'RETURNED', returned_at = now(),
              return_photo_key = $2, return_received_by = $3, return_remarks = $4
        WHERE id = $1
          AND status = 'ISSUED'
        RETURNING id`,
      [id, returnPhotoKey, req.user.id, req.body.return_remarks || null]
    );

    // Another authorized request may have returned the document after our
    // initial access check but before this write. Never overwrite that audit
    // event, and remove any proof object uploaded by the losing request.
    if (!transitionedRows[0]) {
      if (returnPhotoKey) {
        try {
          await deletePlotDoc(returnPhotoKey);
        } catch (cleanupError) {
          console.error(`Document imprest ${id} losing return proof cleanup failed:`, cleanupError.message);
        }
        returnPhotoKey = null;
      }
      return res.status(409).json({ message: 'Document is already marked returned' });
    }
    returnPhotoPersisted = true;

    const { rows } = await pool.query(`${RECORD_SELECT} WHERE di.id = $1`, [id]);
    res.json({ record: await withPhotoUrls(rows[0]) });
  } catch (error) {
    if (returnPhotoKey && !returnPhotoPersisted) await deletePlotDoc(returnPhotoKey).catch(() => {});
    throw error;
  }
});
