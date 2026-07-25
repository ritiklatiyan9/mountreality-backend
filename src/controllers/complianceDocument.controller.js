import path from 'path';
import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import permissionModel from '../models/Permission.model.js';
import {
  deletePlotDoc, getPlotDocUrl, uploadPlotDoc,
} from '../utils/plotDocStorage.js';
import { isOcrable, runDmsOcr } from '../services/dmsOcr.service.js';
import {
  assertComplianceSiteAccess, getScopedComplianceEntity, isOrgAdmin, parsePositiveId,
  writeComplianceAudit,
} from '../utils/complianceAccess.js';

const ENTITY = Object.freeze({
  COMPLIANCE: { table: 'compliance_items', module: 'compliance' },
  LICENCE: { table: 'compliance_licences', module: 'compliance' },
  LEGAL_CASE: { table: 'legal_cases', module: 'legal' },
  LEGAL_NOTICE: { table: 'legal_notices', module: 'legal' },
  INSPECTION: { table: 'compliance_inspections', module: 'compliance' },
});
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const normalizedType = (value) => String(value || '').trim().toUpperCase();
const validDate = (value) => {
  if (!value) return true;
  const raw = String(value);
  if (!DATE_RE.test(raw)) return false;
  const [year, month, day] = raw.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
};

async function requireEntity(req, res, rawType, rawId, action = 'read') {
  const entityType = normalizedType(rawType);
  const config = ENTITY[entityType];
  const entityId = parsePositiveId(rawId);
  if (!config || !entityId) {
    res.status(400).json({ message: 'Invalid compliance document entity' });
    return null;
  }
  if (!isOrgAdmin(req.user)) {
    const permission = await permissionModel.getPermission(req.user.id, config.module);
    if (permission?.[`can_${action}`] !== true) {
      res.status(403).json({ message: `${action} access to ${config.module} is required` });
      return null;
    }
  }
  const entity = await getScopedComplianceEntity(req, config.table, entityId);
  if (!entity) {
    res.status(404).json({ message: 'Related record not found' });
    return null;
  }
  return { entityType, entityId, entity, config };
}

const toPublic = async (row) => {
  const result = { ...row };
  result.file_url = await getPlotDocUrl(result.storage_key);
  delete result.storage_key;
  delete result.ocr_text;
  return result;
};

async function processOcr(documentId, buffer, mime) {
  if (!isOcrable(mime)) {
    await pool.query(`UPDATE compliance_documents SET ocr_status='NOT_SUPPORTED' WHERE id=$1`, [documentId]);
    return;
  }
  try {
    await pool.query(`UPDATE compliance_documents SET ocr_status='PROCESSING' WHERE id=$1`, [documentId]);
    const { text } = await runDmsOcr(buffer, mime);
    await pool.query(`UPDATE compliance_documents SET ocr_status='DONE',ocr_text=$1,ocr_error=NULL WHERE id=$2`, [text, documentId]);
  } catch (error) {
    await pool.query(`UPDATE compliance_documents SET ocr_status='FAILED',ocr_error=$1 WHERE id=$2`, [String(error.message || error).slice(0, 2000), documentId]).catch(() => {});
  }
}

export const uploadComplianceDocument = asyncHandler(async (req, res) => {
  const context = await requireEntity(req, res, req.params.entityType, req.params.entityId, 'write');
  if (!context) return;
  if (!req.file?.buffer?.length) return res.status(400).json({ message: 'Select a non-empty document' });
  const suppliedMime = String(req.file.mimetype || '').toLowerCase();
  if (!ALLOWED_MIME.has(suppliedMime)) return res.status(400).json({ message: 'Unsupported document type' });
  if (!validDate(req.body.issue_date) || !validDate(req.body.expiry_date)) {
    return res.status(400).json({ message: 'Issue and expiry dates must use YYYY-MM-DD' });
  }
  const confidentiality = String(req.body.confidentiality || 'INTERNAL').toUpperCase();
  if (confidentiality === 'RESTRICTED' && !isOrgAdmin(req.user)) {
    return res.status(403).json({ message: 'Only administrators can upload restricted evidence' });
  }
  const title = String(req.body.title || path.parse(req.file.originalname).name || 'Evidence').trim().slice(0, 300);
  const category = String(req.body.category || 'OTHER').trim().toUpperCase().slice(0, 120);
  const storageKey = await uploadPlotDoc(
    req.file.buffer, req.file.originalname, suppliedMime,
    `compliance/${req.user.organization_id}/${context.entityType.toLowerCase()}`
  );
  try {
    const { rows } = await pool.query(
      `INSERT INTO compliance_documents
        (organization_id,site_id,entity_type,entity_id,category,title,original_name,storage_key,
         mime_type,file_size,version_no,tags,verification_status,approval_status,confidentiality,
         issue_date,expiry_date,issuing_authority,uploaded_by)
       VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         COALESCE((SELECT MAX(version_no)+1 FROM compliance_documents
                    WHERE organization_id=$1 AND entity_type=$3 AND entity_id=$4
                      AND category=$5 AND title=$6 AND deleted_at IS NULL),1),
         $11,$12,$13,$14,$15,$16,$17,$18
       ) RETURNING *`,
      [
        req.user.organization_id, context.entity.site_id || null, context.entityType, context.entityId,
        category, title, String(req.file.originalname).slice(0, 500), storageKey, suppliedMime,
        req.file.size || req.file.buffer.length,
        Array.isArray(req.body.tags) ? req.body.tags : String(req.body.tags || '').split(',').map((v) => v.trim()).filter(Boolean),
        String(req.body.verification_status || 'UNVERIFIED').toUpperCase(),
        String(req.body.approval_status || 'NOT_REQUIRED').toUpperCase(),
        ['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'].includes(confidentiality) ? confidentiality : 'INTERNAL',
        req.body.issue_date || null, req.body.expiry_date || null,
        String(req.body.issuing_authority || '').trim().slice(0, 300) || null, req.user.id,
      ]
    );
    await writeComplianceAudit(pool, req, {
      action: 'DOCUMENT_UPLOAD', entityType: context.entityType, entityId: context.entityId,
      siteId: context.entity.site_id, newValue: { document_id: rows[0].id, title, category, confidentiality },
    });
    void processOcr(rows[0].id, req.file.buffer, suppliedMime);
    res.status(201).json({ document: await toPublic(rows[0]) });
  } catch (error) {
    await deletePlotDoc(storageKey).catch(() => {});
    throw error;
  }
});

export const listComplianceDocuments = asyncHandler(async (req, res) => {
  const context = await requireEntity(req, res, req.params.entityType, req.params.entityId);
  if (!context) return;
  const params = [req.user.organization_id, context.entityType, context.entityId];
  let search = '';
  if (req.query.q) {
    params.push(String(req.query.q).trim().slice(0, 100));
    search = `AND (
      d.title ILIKE '%' || $4 || '%'
      OR d.original_name ILIKE '%' || $4 || '%'
      OR to_tsvector('simple',COALESCE(d.ocr_text,'')) @@ plainto_tsquery('simple',$4)
    )`;
  }
  const confidentiality = isOrgAdmin(req.user) ? '' : `AND d.confidentiality <> 'RESTRICTED'`;
  const { rows } = await pool.query(
    `SELECT d.id,d.category,d.title,d.original_name,d.mime_type,d.file_size,d.version_no,d.ocr_status,
            d.tags,d.verification_status,d.approval_status,d.confidentiality,d.issue_date,d.expiry_date,
            d.issuing_authority,d.uploaded_by,u.name AS uploaded_by_name,d.created_at
       FROM compliance_documents d
       LEFT JOIN users u ON u.id=d.uploaded_by
      WHERE d.organization_id=$1 AND d.entity_type=$2 AND d.entity_id=$3
        AND d.deleted_at IS NULL ${confidentiality} ${search}
      ORDER BY d.created_at DESC`,
    params
  );
  res.json({ documents: rows });
});

/** Tenant- and site-scoped document-expiry register across all compliance entities. */
export const listExpiringComplianceDocuments = asyncHandler(async (req, res) => {
  const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 25, 1), 100);
  const params = [req.user.organization_id];
  const where = ['d.organization_id=$1', 'd.deleted_at IS NULL', 'd.expiry_date IS NOT NULL'];
  if (!isOrgAdmin(req.user)) {
    const legalPermission = await permissionModel.getPermission(req.user.id, 'legal');
    if (legalPermission?.can_read !== true) {
      where.push(`d.entity_type NOT IN ('LEGAL_CASE','LEGAL_NOTICE')`);
    }
  }
  if (!isOrgAdmin(req.user)) {
    params.push(req.user.id);
    where.push(`d.site_id IN (SELECT us.site_id FROM user_sites us WHERE us.user_id=$${params.length})`);
    where.push(`d.confidentiality <> 'RESTRICTED'`);
  }
  if (req.query.site_id) {
    const siteId = await assertComplianceSiteAccess(req, res, req.query.site_id);
    if (siteId === false) return;
    params.push(siteId);
    where.push(`d.site_id=$${params.length}`);
  }
  if (req.query.from) {
    if (!validDate(req.query.from)) return res.status(400).json({ message: 'Invalid from date' });
    params.push(req.query.from);
    where.push(`d.expiry_date >= $${params.length}`);
  }
  if (req.query.to) {
    if (!validDate(req.query.to)) return res.status(400).json({ message: 'Invalid to date' });
    params.push(req.query.to);
    where.push(`d.expiry_date <= $${params.length}`);
  }
  if (req.query.entity_type) {
    const entityType = normalizedType(req.query.entity_type);
    if (!ENTITY[entityType]) return res.status(400).json({ message: 'Invalid entity type' });
    params.push(entityType);
    where.push(`d.entity_type=$${params.length}`);
  }
  if (req.query.q) {
    params.push(String(req.query.q).trim().slice(0, 100));
    where.push(`(
      d.title ILIKE '%' || $${params.length} || '%'
      OR d.original_name ILIKE '%' || $${params.length} || '%'
      OR d.issuing_authority ILIKE '%' || $${params.length} || '%'
    )`);
  }
  const clause = where.join(' AND ');
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM compliance_documents d WHERE ${clause}`,
    params
  );
  params.push(limit, (page - 1) * limit);
  const { rows } = await pool.query(
    `SELECT d.id,d.site_id,d.entity_type,d.entity_id,d.category,d.title,d.original_name,
            d.mime_type,d.file_size,d.version_no,d.verification_status,d.confidentiality,
            d.issue_date,d.expiry_date,d.issuing_authority,d.created_at,
            s.name AS site_name,u.name AS uploaded_by_name,
            (d.expiry_date-CURRENT_DATE)::int AS days_remaining
       FROM compliance_documents d
       LEFT JOIN sites s ON s.id=d.site_id AND s.organization_id=d.organization_id
       LEFT JOIN users u ON u.id=d.uploaded_by AND u.organization_id=d.organization_id
      WHERE ${clause}
      ORDER BY d.expiry_date ASC,d.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = countRows[0]?.total || 0;
  res.json({ documents: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

export const getComplianceDocument = asyncHandler(async (req, res) => {
  const documentId = parsePositiveId(req.params.documentId);
  const { rows } = await pool.query(
    `SELECT * FROM compliance_documents WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [documentId, req.user.organization_id]
  );
  const document = rows[0];
  if (!document) return res.status(404).json({ message: 'Document not found' });
  const context = await requireEntity(req, res, document.entity_type, document.entity_id);
  if (!context) return;
  if (document.confidentiality === 'RESTRICTED' && !isOrgAdmin(req.user)) {
    return res.status(403).json({ message: 'Restricted document access denied' });
  }
  await writeComplianceAudit(pool, req, {
    action: 'DOCUMENT_DOWNLOAD', entityType: document.entity_type, entityId: document.entity_id,
    siteId: document.site_id, newValue: { document_id: document.id, title: document.title },
  });
  res.json({ document: await toPublic(document) });
});

export const deleteComplianceDocument = asyncHandler(async (req, res) => {
  const documentId = parsePositiveId(req.params.documentId);
  const { rows } = await pool.query(
    `SELECT * FROM compliance_documents WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [documentId, req.user.organization_id]
  );
  const document = rows[0];
  if (!document) return res.status(404).json({ message: 'Document not found' });
  const context = await requireEntity(req, res, document.entity_type, document.entity_id, 'delete');
  if (!context) return;
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ message: 'A deletion reason is required' });
  await pool.query(`UPDATE compliance_documents SET deleted_at=NOW() WHERE id=$1 AND organization_id=$2`, [documentId, req.user.organization_id]);
  await deletePlotDoc(document.storage_key).catch(() => {});
  await writeComplianceAudit(pool, req, {
    action: 'DOCUMENT_DELETE', entityType: document.entity_type, entityId: document.entity_id,
    siteId: document.site_id, previousValue: { document_id: document.id, title: document.title }, reason,
  });
  res.json({ success: true });
});
