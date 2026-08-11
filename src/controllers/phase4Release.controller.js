import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { writePortalAudit } from '../services/portalAccess.service.js';

const TYPES = new Set(['BUYER', 'BROKER', 'PROFESSIONAL']);
const id = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = (value) => Array.isArray(value) ? value : [];
const type = (value) => String(value || '').trim().toUpperCase();

async function scopedMembership({ membershipId, organizationId, siteId, portalType }, db = pool) {
  if (!membershipId) return null;
  const { rows } = await db.query(
    `SELECT id FROM portal_memberships WHERE id=$1 AND organization_id=$2
      AND site_id IS NOT DISTINCT FROM $3::integer AND portal_type=$4
      AND status IN ('PENDING','ACTIVE','SUSPENDED')`,
    [membershipId, organizationId, siteId, portalType],
  );
  return rows[0] || null;
}

async function createNotificationRows({ organizationId, siteId, projectId = null, phaseId = null, portalTypes, eventType, sourceType, sourceId, title, message, actionPath, membershipId = null }, db = pool) {
  const { rows } = await db.query(
    `WITH recipients AS MATERIALIZED (
       SELECT pm.id
         FROM portal_memberships pm
        WHERE pm.organization_id=$1 AND pm.site_id IS NOT DISTINCT FROM $2::integer
          AND pm.status='ACTIVE' AND pm.effective_from<=NOW()
          AND (pm.effective_to IS NULL OR pm.effective_to>NOW())
          AND pm.portal_type=ANY($3::text[])
          AND ($4::bigint IS NULL OR pm.rera_project_id=$4)
          AND ($5::bigint IS NULL OR pm.rera_project_phase_id IS NULL OR pm.rera_project_phase_id=$5)
          AND ($6::bigint IS NULL OR pm.id=$6)
     ), inserted AS (
       INSERT INTO portal_notifications
         (organization_id,membership_id,event_type,source_type,source_id,title,message,action_path,dedupe_key)
       SELECT $1,r.id,$7,$8,$9,$10,$11,$12,$13 FROM recipients r
       ON CONFLICT (membership_id,dedupe_key) DO NOTHING
       RETURNING id,membership_id
     ), deliveries AS (
       INSERT INTO portal_notification_deliveries (notification_id,channel,status)
       SELECT i.id,'DASHBOARD','DELIVERED'
         FROM inserted i
         LEFT JOIN portal_notification_preferences p ON p.membership_id=i.membership_id
        WHERE COALESCE(p.dashboard_enabled,TRUE)
       ON CONFLICT DO NOTHING
       RETURNING notification_id
     )
     SELECT (SELECT COUNT(*)::int FROM recipients) AS recipient_count,
            (SELECT COUNT(*)::int FROM inserted) AS created_count,
            (SELECT COUNT(*)::int FROM deliveries) AS delivery_count`,
    [organizationId, siteId, portalTypes, projectId, phaseId, membershipId,
      eventType, sourceType, sourceId, title, message, actionPath,
      `${eventType}:${sourceType}:${sourceId}`],
  );
  return Number(rows[0]?.recipient_count || 0);
}

export const listAudienceReleases = asyncHandler(async (req, res) => {
  const [documents, inventory, updates] = await Promise.all([
    pool.query(
      `SELECT pdg.*,pm.user_id,u.name AS audience_name,u.email AS audience_email
         FROM portal_document_grants pdg
         LEFT JOIN portal_memberships pm ON pm.id=pdg.membership_id
         LEFT JOIN users u ON u.id=pm.user_id
        WHERE pdg.organization_id=$1 ORDER BY pdg.created_at DESC LIMIT 250`,
      [req.user.organization_id],
    ),
    pool.query(
      `SELECT pir.*,p.plot_no FROM portal_inventory_releases pir JOIN plots p ON p.id=pir.plot_id
        WHERE pir.organization_id=$1 ORDER BY pir.created_at DESC LIMIT 250`,
      [req.user.organization_id],
    ),
    pool.query(
      `SELECT pu.*,rp.name AS project_name,rpp.name AS phase_name
         FROM portal_project_updates pu JOIN rera_projects rp ON rp.id=pu.rera_project_id
         LEFT JOIN rera_project_phases rpp ON rpp.id=pu.rera_project_phase_id
        WHERE pu.organization_id=$1 ORDER BY pu.created_at DESC LIMIT 250`,
      [req.user.organization_id],
    ),
  ]);
  res.json({ document_releases: documents.rows, inventory_releases: inventory.rows, project_updates: updates.rows });
});

export const releasePortalDocument = asyncHandler(async (req, res) => {
  const documentStore = type(req.body.document_store);
  const documentId = id(req.body.document_id);
  const portalType = type(req.body.portal_type);
  const membershipId = req.body.membership_id ? id(req.body.membership_id) : null;
  const audienceScope = membershipId ? 'MEMBERSHIP' : 'PORTAL_TYPE';
  if (!['DOCUMENTS', 'COMPLIANCE_DOCUMENTS'].includes(documentStore) || !documentId || !TYPES.has(portalType)) {
    return res.status(400).json({ message: 'A valid document_store, document_id and portal_type are required' });
  }
  let document;
  if (documentStore === 'DOCUMENTS') {
    const { rows } = await pool.query(
      `SELECT d.id,COALESCE(d.site_id,p.site_id) AS site_id,d.title,d.original_name
         FROM documents d LEFT JOIN plots p ON p.id=d.plot_id
         JOIN sites s ON s.id=COALESCE(d.site_id,p.site_id) AND s.organization_id=$2
        WHERE d.id=$1 LIMIT 1`,
      [documentId, req.user.organization_id],
    );
    document = rows[0];
  } else {
    const { rows } = await pool.query(
      `SELECT id,site_id,title,original_name FROM compliance_documents
        WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`,
      [documentId, req.user.organization_id],
    );
    document = rows[0];
  }
  if (!document) return res.status(404).json({ message: 'Document not found in your organization' });
  if (membershipId && !await scopedMembership({ membershipId, organizationId: req.user.organization_id, siteId: document.site_id, portalType })) {
    return res.status(400).json({ message: 'Audience membership is outside the document scope' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO portal_document_grants
        (organization_id,site_id,document_store,document_id,portal_type,membership_id,
         audience_scope,status,title_override,release_notes,released_by,released_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'RELEASED',$8,$9,$10,NOW()) RETURNING *`,
      [req.user.organization_id, document.site_id, documentStore, documentId, portalType,
        membershipId, audienceScope, String(req.body.title_override || '').trim() || null,
        String(req.body.release_notes || '').trim() || null, req.user.id],
    );
    await createNotificationRows({
      organizationId: req.user.organization_id, siteId: document.site_id, portalTypes: [portalType],
      eventType: 'DOCUMENT_RELEASED', sourceType: 'PORTAL_DOCUMENT_GRANT', sourceId: rows[0].id,
      title: 'A document is now available', message: rows[0].title_override || document.title || document.original_name,
      actionPath: '/portal/documents', membershipId,
    });
    await writePortalAudit({ organizationId: req.user.organization_id, siteId: document.site_id, userId: req.user.id, action: 'PORTAL_DOCUMENT_RELEASED', entityType: 'PORTAL_DOCUMENT_GRANT', entityId: rows[0].id, newValue: rows[0], ipAddress: req.ip });
    res.status(201).json({ document_release: rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ message: 'This document already has an active release for that audience' });
    throw error;
  }
});

export const releasePortalInventory = asyncHandler(async (req, res) => {
  const plotId = id(req.body.plot_id);
  const portalType = type(req.body.portal_type || 'BROKER');
  const membershipId = req.body.membership_id ? id(req.body.membership_id) : null;
  if (!plotId || !['BUYER', 'BROKER'].includes(portalType)) return res.status(400).json({ message: 'A valid plot_id and portal_type are required' });
  const { rows: plots } = await pool.query(
    `SELECT p.id,p.site_id,p.plot_no,p.rera_project_id FROM plots p JOIN sites s ON s.id=p.site_id
      WHERE p.id=$1 AND s.organization_id=$2`,
    [plotId, req.user.organization_id],
  );
  const plot = plots[0];
  if (!plot) return res.status(404).json({ message: 'Property not found in your organization' });
  if (membershipId && !await scopedMembership({ membershipId, organizationId: req.user.organization_id, siteId: plot.site_id, portalType })) {
    return res.status(400).json({ message: 'Audience membership is outside the property scope' });
  }
  const allowed = new Set(['plot_no', 'plot_size', 'plot_rate', 'status', 'plot_tag', 'commission_rate']);
  const releasedFields = [...new Set(array(req.body.released_fields).map(String).filter((field) => allowed.has(field)))];
  if (!releasedFields.length) return res.status(400).json({ message: 'Select at least one safe released field' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO portal_inventory_releases
        (organization_id,site_id,plot_id,portal_type,membership_id,audience_scope,released_fields,status,released_by,released_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'RELEASED',$8,NOW()) RETURNING *`,
      [req.user.organization_id, plot.site_id, plot.id, portalType, membershipId,
        membershipId ? 'MEMBERSHIP' : 'PORTAL_TYPE', releasedFields, req.user.id],
    );
    await createNotificationRows({
      organizationId: req.user.organization_id, siteId: plot.site_id, projectId: plot.rera_project_id,
      portalTypes: [portalType], eventType: 'INVENTORY_RELEASED', sourceType: 'PORTAL_INVENTORY_RELEASE',
      sourceId: rows[0].id, title: 'Property inventory updated', message: `Property ${plot.plot_no} is now available in your released inventory.`,
      actionPath: '/portal/inventory', membershipId,
    });
    await writePortalAudit({ organizationId: req.user.organization_id, siteId: plot.site_id, userId: req.user.id, action: 'PORTAL_INVENTORY_RELEASED', entityType: 'PORTAL_INVENTORY_RELEASE', entityId: rows[0].id, newValue: rows[0], ipAddress: req.ip });
    res.status(201).json({ inventory_release: rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ message: 'This property already has an active release for that audience' });
    throw error;
  }
});

const SOURCE_QUERY = Object.freeze({
  CONSTRUCTION_DAILY_UPDATE: `SELECT id,organization_id,site_id,rera_project_id,rera_project_phase_id FROM construction_daily_updates WHERE id=$1`,
  CONSTRUCTION_CERTIFICATION: `SELECT id,organization_id,site_id,rera_project_id,rera_project_phase_id FROM construction_certifications WHERE id=$1`,
  CONSTRUCTION_PROJECT: `SELECT id,organization_id,site_id,rera_project_id,rera_project_phase_id FROM construction_projects WHERE id=$1`,
  RERA_PHASE: `SELECT id,organization_id,site_id,rera_project_id,id AS rera_project_phase_id FROM rera_project_phases WHERE id=$1 AND deleted_at IS NULL`,
});

export const releasePortalProjectUpdate = asyncHandler(async (req, res) => {
  const sourceType = type(req.body.source_type);
  const sourceId = id(req.body.source_id);
  const headline = String(req.body.headline || '').trim();
  const audienceTypes = [...new Set(array(req.body.audience_types).map(type).filter((item) => TYPES.has(item)))];
  if (!SOURCE_QUERY[sourceType] || !sourceId || !headline || headline.length > 300 || !audienceTypes.length) {
    return res.status(400).json({ message: 'A valid source, headline and at least one portal audience are required' });
  }
  const { rows: sources } = await pool.query(SOURCE_QUERY[sourceType], [sourceId]);
  const source = sources[0];
  if (!source || source.organization_id !== req.user.organization_id || !source.rera_project_id) {
    return res.status(404).json({ message: 'Source is not a project-scoped record in your organization' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO portal_project_updates
        (organization_id,site_id,rera_project_id,rera_project_phase_id,source_type,source_id,
         headline,summary,audience_types,status,released_by,released_at,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'RELEASED',$10,NOW(),$10) RETURNING *`,
      [req.user.organization_id, source.site_id, source.rera_project_id, source.rera_project_phase_id,
        sourceType, sourceId, headline, String(req.body.summary || '').trim() || null,
        audienceTypes, req.user.id],
    );
    await createNotificationRows({
      organizationId: req.user.organization_id, siteId: source.site_id, projectId: source.rera_project_id,
      phaseId: source.rera_project_phase_id, portalTypes: audienceTypes, eventType: 'PROJECT_UPDATE_RELEASED',
      sourceType: 'PORTAL_PROJECT_UPDATE', sourceId: rows[0].id, title: headline,
      message: rows[0].summary || 'A new project update is available.', actionPath: '/portal/updates',
    }, client);
    await writePortalAudit({ organizationId: req.user.organization_id, siteId: source.site_id, userId: req.user.id, action: 'PORTAL_PROJECT_UPDATE_RELEASED', entityType: 'PORTAL_PROJECT_UPDATE', entityId: rows[0].id, newValue: rows[0], ipAddress: req.ip }, client);
    await client.query('COMMIT');
    res.status(201).json({ project_update: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ message: 'That source already has a portal update release' });
    throw error;
  } finally {
    client.release();
  }
});

export const withdrawAudienceRelease = asyncHandler(async (req, res) => {
  const releaseType = type(req.params.releaseType);
  const releaseId = id(req.params.releaseId);
  const table = {
    DOCUMENT: 'portal_document_grants', INVENTORY: 'portal_inventory_releases', UPDATE: 'portal_project_updates',
  }[releaseType];
  if (!table || !releaseId) return res.status(400).json({ message: 'Invalid release type or ID' });
  const { rows } = await pool.query(
    `UPDATE ${table} SET status='WITHDRAWN',withdrawn_by=$1,withdrawn_at=NOW()
      WHERE id=$2 AND organization_id=$3 AND status='RELEASED' RETURNING id,site_id,status,withdrawn_at`,
    [req.user.id, releaseId, req.user.organization_id],
  );
  if (!rows[0]) return res.status(404).json({ message: 'Released audience record not found' });
  await writePortalAudit({ organizationId: req.user.organization_id, siteId: rows[0].site_id, userId: req.user.id, action: `PORTAL_${releaseType}_WITHDRAWN`, entityType: `PORTAL_${releaseType}_RELEASE`, entityId: releaseId, reason: String(req.body.reason || '').trim() || null, ipAddress: req.ip });
  res.json({ release: rows[0] });
});
