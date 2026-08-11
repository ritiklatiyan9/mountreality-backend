import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { getPlotDocBytes } from '../utils/plotDocStorage.js';
import {
  assertPortalAction,
  listPortalMemberships,
  serializeBuyerBooking,
  serializeProfessionalCertification,
  serializeReleasedInventory,
  writePortalAudit,
} from '../services/portalAccess.service.js';
import { CERTIFICATION_TRANSITIONS } from '../services/constructionPhase3.service.js';
import { assertClientPortalModule } from '../services/portalConfiguration.service.js';

const id = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
const limit = (value, fallback = 50, max = 200) => Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);

const buyerBookingScope = (membership, alias = 'b', memberParam = '$4') => `
  ${alias}.organization_id=$1 AND ${alias}.site_id=$2
  AND ($3::bigint IS NULL OR ${alias}.rera_project_id=$3)
  AND (${alias}.client_member_id=${memberParam} OR EXISTS (
    SELECT 1 FROM booking_allottees ba
     WHERE ba.booking_id=${alias}.id AND ba.member_id=${memberParam} AND ba.status='ACTIVE'
       AND ba.effective_from<=CURRENT_DATE AND (ba.effective_to IS NULL OR ba.effective_to>=CURRENT_DATE)
  ))`;

const assertClientDiscussionTarget = (membership, configuration, targetType) => {
  assertClientPortalModule(membership, configuration, 'discussions');
  if (targetType === 'BOOKING') assertClientPortalModule(membership, configuration, 'overview');
  if (targetType === 'DOCUMENT') assertClientPortalModule(membership, configuration, 'documents');
  if (targetType === 'PROJECT_UPDATE') assertClientPortalModule(membership, configuration, 'project_updates');
};

export const getPortalContext = asyncHandler(async (req, res) => {
  const memberships = await listPortalMemberships(req.user.id, req.user.organization_id);
  res.json({ memberships });
});

export const getBuyerHome = asyncHandler(async (req, res) => {
  const membership = req.portalMembership;
  assertClientPortalModule(membership, req.portalConfiguration, 'overview');
  assertPortalAction(membership, 'view_booking', true);
  const params = [membership.organization_id, membership.site_id, membership.rera_project_id, membership.domain_entity_id];
  const { rows } = await pool.query(
    `SELECT b.id AS booking_id,b.booking_no AS booking_reference,b.lifecycle_status AS booking_status,
            b.booking_date AS booked_at,b.final_consideration AS agreed_value,
            p.id AS plot_id,p.plot_no,p.plot_size,p.plot_rate,p.status AS plot_status,
            b.rera_project_id,b.rera_project_phase_id,rp.name AS project_name,
            rp.registration_number,rpp.name AS phase_name,
            COALESCE(pay.received,0) AS amount_received,
            GREATEST(COALESCE(b.final_consideration,p.sale_price,0)-COALESCE(pay.received,0)+COALESCE(ref.refunded,0),0) AS amount_due,
            b.agreement_status,COALESCE(pr.lifecycle_status,p.registry_status) AS registry_status,
            COALESCE(pos.status,p.possession_status) AS possession_status
       FROM bookings b
       JOIN plots p ON p.id=b.plot_id AND p.site_id=b.site_id
       LEFT JOIN rera_projects rp ON rp.id=b.rera_project_id AND rp.organization_id=b.organization_id
       LEFT JOIN rera_project_phases rpp ON rpp.id=b.rera_project_phase_id AND rpp.organization_id=b.organization_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(amount),0) AS received FROM plot_payments pp
          WHERE pp.booking_id=b.id AND LOWER(COALESCE(pp.status,'approved'))='approved'
            AND UPPER(COALESCE(pp.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
       ) pay ON TRUE
       LEFT JOIN LATERAL (SELECT COALESCE(SUM(amount),0) AS refunded FROM booking_refunds WHERE booking_id=b.id AND status='POSTED') ref ON TRUE
       LEFT JOIN LATERAL (SELECT lifecycle_status FROM plot_registries WHERE booking_id=b.id ORDER BY id DESC LIMIT 1) pr ON TRUE
       LEFT JOIN LATERAL (SELECT status FROM plot_possessions WHERE booking_id=b.id ORDER BY id DESC LIMIT 1) pos ON TRUE
      WHERE ${buyerBookingScope(membership)}
      ORDER BY b.booking_date DESC,b.id DESC`,
    params,
  );
  const bookings = rows.map(serializeBuyerBooking);
  res.json({ membership_id: membership.id, bookings, summary: {
    properties: bookings.length,
    agreed_value: rows.reduce((sum, row) => sum + Number(row.agreed_value || 0), 0),
    received: rows.reduce((sum, row) => sum + Number(row.amount_received || 0), 0),
    due: rows.reduce((sum, row) => sum + Number(row.amount_due || 0), 0),
  } });
});

export const getBuyerPayments = asyncHandler(async (req, res) => {
  const membership = req.portalMembership;
  assertClientPortalModule(membership, req.portalConfiguration, 'transactions');
  assertPortalAction(membership, 'view_payments', true);
  const pageSize = limit(req.query.limit);
  const visibility = req.portalConfiguration.transaction_visibility;
  const selectedModes = visibility.selected_modes;
  const { rows } = await pool.query(
    `WITH scoped_bookings AS (
       SELECT b.id,b.plot_id,b.booking_no
         FROM bookings b
        WHERE ${buyerBookingScope(membership)}
     ), portal_transactions AS (
       SELECT 'DIRECT'::text AS source,pp.id,pp.booking_id,pp.plot_id,pp.date,
              pp.amount,UPPER(TRIM(COALESCE(pp.payment_type,'UNSPECIFIED'))) AS payment_mode,
              pp.receipt_no AS reference,pp.created_at,sb.booking_no,p.plot_no
         FROM plot_payments pp
         JOIN scoped_bookings sb ON sb.id=pp.booking_id AND sb.plot_id=pp.plot_id
         JOIN plots p ON p.id=pp.plot_id AND p.site_id=$2
        WHERE pp.site_id=$2
          AND LOWER(COALESCE(pp.status,'approved'))='approved'
          AND UPPER(COALESCE(pp.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
       UNION ALL
       SELECT 'INSTALLMENT'::text AS source,pip.id,sb.id AS booking_id,pip.plot_id,pip.payment_date AS date,
              pip.amount,UPPER(TRIM(COALESCE(pip.payment_mode,'UNSPECIFIED'))) AS payment_mode,
              pip.reference,pip.created_at,sb.booking_no,p.plot_no
         FROM plot_installment_payments pip
         JOIN plots p ON p.id=pip.plot_id AND p.site_id=$2
         JOIN LATERAL (
           SELECT scoped.id,scoped.booking_no FROM scoped_bookings scoped
            WHERE scoped.plot_id=pip.plot_id ORDER BY scoped.id DESC LIMIT 1
         ) sb ON TRUE
        WHERE UPPER(COALESCE(pip.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
     )
     SELECT source,id,booking_id,plot_id,date,amount,payment_mode,reference,created_at,booking_no,plot_no
       FROM portal_transactions
      WHERE ($5::text='ALL'
        OR ($5::text='CASH' AND ledger_bucket(payment_mode)='cash')
        OR ($5::text='BANK' AND ledger_bucket(payment_mode)<>'cash')
        OR ($5::text='SELECTED' AND payment_mode=ANY($6::text[])))
      ORDER BY date DESC,created_at DESC,id DESC
      LIMIT $7`,
    [membership.organization_id, membership.site_id, membership.rera_project_id,
      membership.domain_entity_id, visibility.scope, selectedModes, pageSize],
  );
  res.json({
    transactions: rows,
    payments: rows,
    visibility: { scope: visibility.scope, selected_modes: visibility.scope === 'SELECTED' ? selectedModes : [] },
  });
});

export const getBuyerUpcomingInstallments = asyncHandler(async (req, res) => {
  const membership = req.portalMembership;
  assertClientPortalModule(membership, req.portalConfiguration, 'upcoming_installments');
  assertPortalAction(membership, 'view_payments', true);
  const pageSize = limit(req.query.limit, 50, 100);
  const { rows } = await pool.query(
    `WITH scoped_bookings AS (
       SELECT b.id,b.plot_id,b.booking_no
         FROM bookings b
        WHERE ${buyerBookingScope(membership)}
     )
     SELECT pi.id,pi.booking_id,pi.plot_id,pi.installment_name,pi.amount,pi.due_date,
            GREATEST(pi.amount-GREATEST(COALESCE(pa.allocated,0),COALESCE(pi.paid_amount,0)),0) AS amount_due,
            CASE WHEN pi.due_date=CURRENT_DATE THEN 'DUE_TODAY'
                 WHEN pi.due_date<CURRENT_DATE THEN 'OVERDUE'
                 ELSE 'UPCOMING' END AS due_status,
            (pi.due_date-CURRENT_DATE)::int AS days_until_due,sb.booking_no,p.plot_no
       FROM plot_installments pi
       JOIN scoped_bookings sb ON sb.id=pi.booking_id AND sb.plot_id=pi.plot_id
       JOIN plots p ON p.id=pi.plot_id AND p.site_id=$2
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(ppa.allocated_amount),0) AS allocated
           FROM plot_payment_allocations ppa
           JOIN plot_payments allocated_payment ON allocated_payment.id=ppa.plot_payment_id
          WHERE ppa.installment_id=pi.id
            AND LOWER(COALESCE(allocated_payment.status,'approved'))='approved'
            AND UPPER(COALESCE(allocated_payment.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
       ) pa ON TRUE
      WHERE pi.superseded_at IS NULL
        AND GREATEST(pi.amount-GREATEST(COALESCE(pa.allocated,0),COALESCE(pi.paid_amount,0)),0)>0
      ORDER BY (pi.due_date<CURRENT_DATE) DESC,pi.due_date,pi.sort_order,pi.id
      LIMIT $5`,
    [membership.organization_id, membership.site_id, membership.rera_project_id,
      membership.domain_entity_id, pageSize],
  );
  res.json({ installments: rows });
});

export const getBrokerHome = asyncHandler(async (req, res) => {
  const membership = req.portalMembership;
  const [commissions, inventory, profile] = await Promise.all([
    pool.query(
      `SELECT pc.id,pc.plot_id,pc.total_commission,pc.status,pc.created_at,p.plot_no,
              COALESCE(pay.paid,0) AS paid,GREATEST(pc.total_commission-COALESCE(pay.paid,0),0) AS balance
         FROM plot_commissions_v2 pc
         JOIN plots p ON p.id=pc.plot_id AND p.site_id=pc.site_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(amount),0) AS paid FROM plot_commission_payments
            WHERE plot_commission_id=pc.id AND LOWER(COALESCE(status,'approved'))='approved'
              AND UPPER(COALESCE(cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
         ) pay ON TRUE
        WHERE pc.site_id=$1 AND pc.agent_id=$2
          AND ($3::bigint IS NULL OR p.rera_project_id=$3)
        ORDER BY pc.created_at DESC,pc.id DESC`,
      [membership.site_id, membership.domain_entity_id, membership.rera_project_id],
    ),
    pool.query(
      `SELECT pir.id AS release_id,pir.released_fields,pir.released_at,p.id AS plot_id,
              p.plot_no,p.plot_size,p.plot_rate,p.status AS plot_status,p.plot_tag,p.commission_rate
         FROM portal_inventory_releases pir JOIN plots p ON p.id=pir.plot_id AND p.site_id=pir.site_id
        WHERE pir.organization_id=$1 AND pir.site_id=$2 AND pir.portal_type='BROKER'
          AND pir.status='RELEASED' AND (pir.audience_scope='PORTAL_TYPE' OR pir.membership_id=$3)
          AND ($4::bigint IS NULL OR p.rera_project_id=$4)
        ORDER BY pir.released_at DESC,pir.id DESC LIMIT 200`,
      [membership.organization_id, membership.site_id, membership.id, membership.rera_project_id],
    ),
    pool.query(
      `SELECT id,full_name,business_name,license_number,operating_areas,commission_rate,status
         FROM members WHERE id=$1 AND site_id=$2 AND member_type='BROKER' LIMIT 1`,
      [membership.domain_entity_id, membership.site_id],
    ),
  ]);
  const ownCommissions = commissions.rows;
  res.json({
    membership_id: membership.id,
    broker_profile: profile.rows[0] ? {
      id: profile.rows[0].id,
      name: profile.rows[0].full_name,
      business_name: profile.rows[0].business_name,
      operating_areas: profile.rows[0].operating_areas,
      commission_rate: profile.rows[0].commission_rate,
      account_status: profile.rows[0].status,
      registration: {
        reference: profile.rows[0].license_number || null,
        record_status: profile.rows[0].license_number ? 'RECORDED' : 'NOT_RECORDED',
        verification_status: 'NOT_GOVERNMENT_VERIFIED',
      },
      project_authorization: {
        status: membership.rera_project_id ? 'SCOPED_TO_PROJECT' : 'SITE_WIDE_PORTAL_SCOPE',
        rera_project_id: membership.rera_project_id || null,
        source: 'portal_membership',
      },
    } : null,
    inventory: inventory.rows.map(serializeReleasedInventory),
    commissions: ownCommissions,
    summary: {
      released_properties: inventory.rowCount,
      total_commission: ownCommissions.reduce((sum, row) => sum + Number(row.total_commission || 0), 0),
      paid: ownCommissions.reduce((sum, row) => sum + Number(row.paid || 0), 0),
      balance: ownCommissions.reduce((sum, row) => sum + Number(row.balance || 0), 0),
    },
  });
});

export const getBrokerCommission = asyncHandler(async (req, res) => {
  const membership = req.portalMembership;
  assertPortalAction(membership, 'view_commissions', true);
  const commissionId = id(req.params.commissionId);
  if (!commissionId) return res.status(400).json({ message: 'Invalid commission ID' });
  const { rows } = await pool.query(
    `SELECT pc.id,pc.plot_id,pc.total_commission,pc.remarks,pc.status,pc.created_at,
            p.plot_no,p.plot_size,
            COALESCE(jsonb_agg(jsonb_build_object(
              'id',pay.id,'date',pay.date,'amount',pay.amount,'payment_mode',pay.payment_mode,
              'status',pay.status,'remarks',pay.remarks,'created_at',pay.created_at
            ) ORDER BY pay.date,pay.id) FILTER (WHERE pay.id IS NOT NULL),'[]') AS payments
       FROM plot_commissions_v2 pc
       JOIN plots p ON p.id=pc.plot_id AND p.site_id=pc.site_id
       LEFT JOIN plot_commission_payments pay ON pay.plot_commission_id=pc.id
      WHERE pc.id=$1 AND pc.site_id=$2 AND pc.agent_id=$3
        AND ($4::bigint IS NULL OR p.rera_project_id=$4)
      GROUP BY pc.id,p.id`,
    [commissionId, membership.site_id, membership.domain_entity_id, membership.rera_project_id],
  );
  if (!rows[0]) return res.status(404).json({ message: 'Commission not found' });
  res.json({ commission: rows[0] });
});

export const listProfessionalCertifications = asyncHandler(async (req, res) => {
  const membership = req.portalMembership;
  assertPortalAction(membership, 'view_certifications', true);
  const { rows } = await pool.query(
    `SELECT c.*,p.name AS construction_project_name,wp.name AS work_package_name,
            COALESCE(ev.evidence,'[]') AS evidence
       FROM construction_certifications c
       JOIN construction_projects p ON p.id=c.construction_project_id
       LEFT JOIN construction_work_packages wp ON wp.id=c.work_package_id
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object('document_id',d.id,'title',d.title,
                  'verification_status',d.verification_status,'approval_status',d.approval_status)
                  ORDER BY d.created_at DESC) AS evidence
           FROM construction_certification_evidence ce
           JOIN compliance_documents d ON d.id=ce.compliance_document_id AND d.deleted_at IS NULL
          WHERE ce.certification_id=c.id
       ) ev ON TRUE
      WHERE c.organization_id=$1 AND c.site_id=$2 AND c.professional_stakeholder_id=$3
        AND c.rera_project_id=$4
        AND ($5::bigint IS NULL OR c.rera_project_phase_id=$5)
      ORDER BY c.certification_period_end DESC,c.id DESC`,
    [membership.organization_id, membership.site_id, membership.domain_entity_id,
      membership.rera_project_id, membership.rera_project_phase_id],
  );
  res.json({ certifications: rows.map((row) => ({
    ...serializeProfessionalCertification(row, membership),
    construction_project_name: row.construction_project_name,
    work_package_name: row.work_package_name,
    evidence: row.evidence,
    allowed_transitions: row.status === 'PROFESSIONAL_REVIEW'
      ? (CERTIFICATION_TRANSITIONS[row.status] || []).filter((status) => ['INTERNAL_REVIEW', 'REVISION_REQUIRED'].includes(status))
      : [],
  })) });
});

export const transitionProfessionalCertification = asyncHandler(async (req, res) => {
  const membership = req.portalMembership;
  assertPortalAction(membership, 'transition_certification', true);
  const certificationId = id(req.params.certificationId);
  const nextStatus = String(req.body.status || '').toUpperCase();
  if (!certificationId || !['INTERNAL_REVIEW', 'REVISION_REQUIRED'].includes(nextStatus)) {
    return res.status(400).json({ message: 'Professional review may submit for internal review or request a revision' });
  }
  const notes = String(req.body.review_notes || '').trim();
  if (!notes || notes.length > 8000) return res.status(400).json({ message: 'Review notes are required and must be at most 8000 characters' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM construction_certifications
        WHERE id=$1 AND organization_id=$2 AND site_id=$3
          AND professional_stakeholder_id=$4 AND rera_project_id=$5
          AND ($6::bigint IS NULL OR rera_project_phase_id=$6) FOR UPDATE`,
      [certificationId, membership.organization_id, membership.site_id, membership.domain_entity_id,
        membership.rera_project_id, membership.rera_project_phase_id],
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Certification not found' });
    }
    if (rows[0].status !== 'PROFESSIONAL_REVIEW' || !CERTIFICATION_TRANSITIONS.PROFESSIONAL_REVIEW.includes(nextStatus)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'INVALID_TRANSITION', message: `Certification is currently ${rows[0].status}` });
    }
    const changed = await client.query(
      `UPDATE construction_certifications SET status=$1,review_notes=$2,reviewed_by=$3,updated_at=NOW()
        WHERE id=$4 RETURNING *`,
      [nextStatus, notes, req.user.id, certificationId],
    );
    await writePortalAudit({
      organizationId: membership.organization_id, siteId: membership.site_id, userId: req.user.id,
      action: `PORTAL_CERTIFICATION_${nextStatus}`, entityType: 'CONSTRUCTION_CERTIFICATION', entityId: certificationId,
      previousValue: { status: rows[0].status }, newValue: { status: nextStatus }, reason: notes, ipAddress: req.ip,
    }, client);
    await client.query('COMMIT');
    res.json({ certification: serializeProfessionalCertification(changed.rows[0], membership) });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

export const listPortalDocuments = asyncHandler(async (req, res) => {
  const membership = req.portalMembership;
  assertClientPortalModule(membership, req.portalConfiguration, 'documents');
  assertPortalAction(membership, 'view_documents', true);
  const { rows } = await pool.query(
    `SELECT pdg.id AS grant_id,pdg.document_store,pdg.document_id,pdg.title_override,
            pdg.release_notes,pdg.released_at,
            CASE WHEN pdg.document_store='DOCUMENTS' THEN d.title ELSE cd.title END AS source_title,
            CASE WHEN pdg.document_store='DOCUMENTS' THEN d.original_name ELSE cd.original_name END AS original_name,
            CASE WHEN pdg.document_store='DOCUMENTS' THEN d.category ELSE cd.category END AS category,
            CASE WHEN pdg.document_store='DOCUMENTS' THEN d.mime_type ELSE cd.mime_type END AS mime_type,
            CASE WHEN pdg.document_store='DOCUMENTS' THEN d.file_size ELSE cd.file_size END AS file_size,
            CASE WHEN pdg.document_store='DOCUMENTS' THEN d.doc_date ELSE cd.issue_date END AS document_date
       FROM portal_document_grants pdg
       LEFT JOIN documents d ON pdg.document_store='DOCUMENTS' AND d.id=pdg.document_id
       LEFT JOIN compliance_documents cd ON pdg.document_store='COMPLIANCE_DOCUMENTS' AND cd.id=pdg.document_id AND cd.deleted_at IS NULL
      WHERE pdg.organization_id=$1 AND pdg.portal_type=$2 AND pdg.status='RELEASED'
        AND (pdg.site_id IS NULL OR pdg.site_id=$3)
        AND (pdg.audience_scope='PORTAL_TYPE' OR pdg.membership_id=$4)
        AND ((pdg.document_store='DOCUMENTS' AND d.id IS NOT NULL) OR (pdg.document_store='COMPLIANCE_DOCUMENTS' AND cd.id IS NOT NULL))
      ORDER BY pdg.released_at DESC,pdg.id DESC`,
    [membership.organization_id, membership.portal_type, membership.site_id, membership.id],
  );
  res.json({ documents: rows.map((row) => ({ ...row, title: row.title_override || row.source_title, content_path: `/phase4/portal/documents/${row.grant_id}/content`, source_title: undefined })) });
});

export const streamPortalDocument = asyncHandler(async (req, res) => {
  const membership = req.portalMembership;
  assertClientPortalModule(membership, req.portalConfiguration, 'documents');
  assertPortalAction(membership, 'view_documents', true);
  const grantId = id(req.params.grantId);
  if (!grantId) return res.status(400).json({ message: 'Invalid document grant ID' });
  const { rows } = await pool.query(
    `SELECT pdg.document_store,
            CASE WHEN pdg.document_store='DOCUMENTS' THEN d.file_path ELSE cd.storage_key END AS storage_key,
            CASE WHEN pdg.document_store='DOCUMENTS' THEN d.mime_type ELSE cd.mime_type END AS mime_type,
            CASE WHEN pdg.document_store='DOCUMENTS' THEN d.original_name ELSE cd.original_name END AS original_name
       FROM portal_document_grants pdg
       LEFT JOIN documents d ON pdg.document_store='DOCUMENTS' AND d.id=pdg.document_id
       LEFT JOIN compliance_documents cd ON pdg.document_store='COMPLIANCE_DOCUMENTS' AND cd.id=pdg.document_id AND cd.deleted_at IS NULL
      WHERE pdg.id=$1 AND pdg.organization_id=$2 AND pdg.portal_type=$3 AND pdg.status='RELEASED'
        AND (pdg.site_id IS NULL OR pdg.site_id=$4)
        AND (pdg.audience_scope='PORTAL_TYPE' OR pdg.membership_id=$5)
      LIMIT 1`,
    [grantId, membership.organization_id, membership.portal_type, membership.site_id, membership.id],
  );
  if (!rows[0]?.storage_key) return res.status(404).json({ message: 'Released document not found' });
  const bytes = await getPlotDocBytes(rows[0].storage_key);
  const safeName = String(rows[0].original_name || 'document').replace(/[\r\n"]/g, '_');
  res.set('Content-Type', rows[0].mime_type || 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename="${safeName}"`);
  res.set('Cache-Control', 'private, no-store');
  res.send(bytes);
});

export const listPortalUpdates = asyncHandler(async (req, res) => {
  const membership = req.portalMembership;
  assertClientPortalModule(membership, req.portalConfiguration, 'project_updates');
  assertPortalAction(membership, 'view_updates', membership.portal_type !== 'BUYER');
  const { rows } = await pool.query(
    `SELECT pu.id,pu.source_type,pu.source_id,pu.headline,pu.summary,pu.released_at,
            CASE WHEN pu.source_type='CONSTRUCTION_DAILY_UPDATE' THEN du.update_date
                 WHEN pu.source_type='CONSTRUCTION_CERTIFICATION' THEN cc.certification_date
                 ELSE pu.released_at::date END AS source_date,
            CASE WHEN pu.source_type='CONSTRUCTION_DAILY_UPDATE' THEN du.new_progress_pct
                 WHEN pu.source_type='CONSTRUCTION_CERTIFICATION' THEN cc.certified_progress_pct END AS progress_pct,
            CASE WHEN pu.source_type='CONSTRUCTION_CERTIFICATION' THEN cc.status
                 WHEN pu.source_type='CONSTRUCTION_DAILY_UPDATE' THEN du.review_status END AS source_status
       FROM portal_project_updates pu
       LEFT JOIN construction_daily_updates du ON pu.source_type='CONSTRUCTION_DAILY_UPDATE' AND du.id=pu.source_id
       LEFT JOIN construction_certifications cc ON pu.source_type='CONSTRUCTION_CERTIFICATION' AND cc.id=pu.source_id
      WHERE pu.organization_id=$1 AND pu.site_id=$2 AND pu.rera_project_id=$3
        AND ($4::bigint IS NULL OR pu.rera_project_phase_id IS NULL OR pu.rera_project_phase_id=$4)
        AND pu.status='RELEASED' AND pu.audience_types ? $5
      ORDER BY pu.released_at DESC,pu.id DESC LIMIT 100`,
    [membership.organization_id, membership.site_id, membership.rera_project_id,
      membership.rera_project_phase_id, membership.portal_type],
  );
  res.json({ updates: rows });
});

async function assertCommentTarget(membership, targetType, targetId) {
  if (targetType === 'DOCUMENT') {
    const { rows } = await pool.query(
      `SELECT 1 FROM portal_document_grants WHERE id=$1 AND organization_id=$2 AND portal_type=$3
        AND status='RELEASED' AND (site_id IS NULL OR site_id=$5)
        AND (audience_scope='PORTAL_TYPE' OR membership_id=$4)`,
      [targetId, membership.organization_id, membership.portal_type, membership.id, membership.site_id],
    );
    return Boolean(rows[0]);
  }
  if (membership.portal_type === 'BUYER' && targetType === 'BOOKING') {
    const { rows } = await pool.query(
      `SELECT 1 FROM bookings b WHERE b.id=$5 AND ${buyerBookingScope(membership)} LIMIT 1`,
      [membership.organization_id, membership.site_id, membership.rera_project_id, membership.domain_entity_id, targetId],
    );
    return Boolean(rows[0]);
  }
  if (membership.portal_type === 'BROKER' && targetType === 'COMMISSION') {
    const { rows } = await pool.query(
      `SELECT 1 FROM plot_commissions_v2 pc JOIN plots p ON p.id=pc.plot_id
        WHERE pc.id=$1 AND pc.site_id=$2 AND pc.agent_id=$3 AND ($4::bigint IS NULL OR p.rera_project_id=$4)`,
      [targetId, membership.site_id, membership.domain_entity_id, membership.rera_project_id],
    );
    return Boolean(rows[0]);
  }
  if (membership.portal_type === 'PROFESSIONAL' && targetType === 'CERTIFICATION') {
    const { rows } = await pool.query(
      `SELECT 1 FROM construction_certifications WHERE id=$1 AND organization_id=$2 AND site_id=$3
        AND professional_stakeholder_id=$4 AND rera_project_id=$5
        AND ($6::bigint IS NULL OR rera_project_phase_id=$6)`,
      [targetId, membership.organization_id, membership.site_id, membership.domain_entity_id,
        membership.rera_project_id, membership.rera_project_phase_id],
    );
    return Boolean(rows[0]);
  }
  if (targetType === 'PROJECT_UPDATE') {
    const { rows } = await pool.query(
      `SELECT 1 FROM portal_project_updates WHERE id=$1 AND organization_id=$2 AND site_id=$3
        AND rera_project_id=$4 AND status='RELEASED' AND audience_types ? $5`,
      [targetId, membership.organization_id, membership.site_id, membership.rera_project_id, membership.portal_type],
    );
    return Boolean(rows[0]);
  }
  return false;
}

export const listPortalComments = asyncHandler(async (req, res) => {
  const membership = req.portalMembership;
  const targetType = String(req.query.target_type || '').toUpperCase();
  assertClientDiscussionTarget(membership, req.portalConfiguration, targetType);
  assertPortalAction(membership, 'comment', true);
  const targetId = id(req.query.target_id);
  if (!targetId || !await assertCommentTarget(membership, targetType, targetId)) return res.status(404).json({ message: 'Comment thread not found' });
  const { rows } = await pool.query(
    `SELECT pc.id,pc.parent_comment_id,pc.body,pc.edited_at,pc.created_at,
            pc.resolved_at,pc.resolution_notes,
            CASE WHEN pc.membership_id=$4 THEN 'YOU' ELSE 'TEAM' END AS author_label,
            CASE WHEN pdg.id IS NULL THEN NULL ELSE jsonb_build_object(
              'grant_id',pdg.id,'title',COALESCE(pdg.title_override,'Released document'),
              'content_path','/phase4/portal/documents/'||pdg.id||'/content'
            ) END AS attachment
       FROM portal_comments pc
       LEFT JOIN portal_document_grants pdg ON pdg.id=pc.attachment_document_grant_id
        AND pdg.status='RELEASED' AND pdg.organization_id=pc.organization_id
        AND (pdg.site_id IS NULL OR pdg.site_id=pc.site_id)
      WHERE pc.organization_id=$1 AND pc.target_type=$2 AND pc.target_id=$3 AND pc.deleted_at IS NULL
        AND pc.site_id=$6
        AND (pc.visibility='ALL_PORTAL' OR pc.visibility=$5 OR pc.membership_id=$4)
      ORDER BY pc.created_at,pc.id LIMIT 500`,
    [membership.organization_id, targetType, targetId, membership.id, membership.portal_type, membership.site_id],
  );
  res.json({ comments: rows });
});

export const createPortalComment = asyncHandler(async (req, res) => {
  const membership = req.portalMembership;
  const targetType = String(req.body.target_type || '').toUpperCase();
  assertClientDiscussionTarget(membership, req.portalConfiguration, targetType);
  assertPortalAction(membership, 'comment', true);
  const targetId = id(req.body.target_id);
  const body = String(req.body.body || '').trim();
  const parentId = req.body.parent_comment_id ? id(req.body.parent_comment_id) : null;
  const attachmentGrantId = req.body.attachment_document_grant_id ? id(req.body.attachment_document_grant_id) : null;
  if (!targetId || !body || body.length > 10000 || !await assertCommentTarget(membership, targetType, targetId)) {
    return res.status(400).json({ message: 'A valid accessible target and comment of at most 10000 characters are required' });
  }
  if (parentId) {
    const parent = await pool.query(
      `SELECT 1 FROM portal_comments
        WHERE id=$1 AND organization_id=$2 AND site_id=$3 AND target_type=$4 AND target_id=$5
          AND deleted_at IS NULL
          AND (visibility='ALL_PORTAL' OR visibility=$6 OR membership_id=$7)`,
      [parentId, membership.organization_id, membership.site_id, targetType, targetId,
        membership.portal_type, membership.id],
    );
    if (!parent.rows[0]) return res.status(400).json({ message: 'Parent comment is outside this thread' });
  }
  if (req.body.attachment_document_grant_id && !attachmentGrantId) {
    return res.status(400).json({ message: 'Attachment grant is invalid' });
  }
  if (attachmentGrantId && !await assertCommentTarget(membership, 'DOCUMENT', attachmentGrantId)) {
    return res.status(403).json({ message: 'Attachment is not released to this portal membership' });
  }
  const { rows } = await pool.query(
    `INSERT INTO portal_comments
      (organization_id,site_id,membership_id,created_by,target_type,target_id,parent_comment_id,body,visibility,attachment_document_grant_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id,parent_comment_id,body,visibility,attachment_document_grant_id,resolved_at,created_at`,
    [membership.organization_id, membership.site_id, membership.id, req.user.id, targetType,
      targetId, parentId, body, membership.portal_type, attachmentGrantId],
  );
  res.status(201).json({ comment: rows[0] });
});

export const resolvePortalComment = asyncHandler(async (req, res) => {
  const membership = req.portalMembership;
  assertClientPortalModule(membership, req.portalConfiguration, 'discussions');
  assertPortalAction(membership, 'comment', true);
  const commentId = id(req.params.commentId);
  const notes = String(req.body.resolution_notes || '').trim();
  if (!commentId || !notes || notes.length > 2000) {
    return res.status(400).json({ message: 'Resolution notes are required and must be at most 2000 characters' });
  }
  const current = await pool.query(
    `SELECT id,target_type,target_id,visibility,resolved_at FROM portal_comments
      WHERE id=$1 AND organization_id=$2 AND site_id=$5 AND deleted_at IS NULL
        AND (visibility='ALL_PORTAL' OR visibility=$3 OR membership_id=$4)`,
    [commentId, membership.organization_id, membership.portal_type, membership.id, membership.site_id],
  );
  const comment = current.rows[0];
  if (comment) assertClientDiscussionTarget(membership, req.portalConfiguration, comment.target_type);
  if (!comment || !await assertCommentTarget(membership, comment.target_type, comment.target_id)) {
    return res.status(404).json({ message: 'Comment not found in this portal scope' });
  }
  if (comment.resolved_at) return res.status(409).json({ message: 'Comment is already resolved' });
  const { rows } = await pool.query(
    `UPDATE portal_comments SET resolved_at=NOW(),resolved_by=$1,resolution_notes=$2
      WHERE id=$3 AND organization_id=$4 AND site_id=$5 AND resolved_at IS NULL
      RETURNING id,resolved_at,resolution_notes`,
    [req.user.id, notes, commentId, membership.organization_id, membership.site_id],
  );
  await writePortalAudit({
    organizationId: membership.organization_id, siteId: membership.site_id, userId: req.user.id,
    action: 'PORTAL_COMMENT_RESOLVED', entityType: 'PORTAL_COMMENT', entityId: commentId,
    previousValue: { resolved: false }, newValue: { resolved: true }, reason: notes, ipAddress: req.ip,
  });
  res.json({ comment: rows[0] });
});

export const listPortalNotifications = asyncHandler(async (req, res) => {
  const membership = req.portalMembership;
  const { rows } = await pool.query(
    `SELECT id,event_type,source_type,source_id,title,message,action_path,read_at,created_at
       FROM portal_notifications WHERE membership_id=$1 AND organization_id=$2
      ORDER BY created_at DESC,id DESC LIMIT $3`,
    [membership.id, membership.organization_id, limit(req.query.limit, 50, 100)],
  );
  res.json({ notifications: rows, unread: rows.filter((row) => !row.read_at).length });
});

export const markPortalNotificationRead = asyncHandler(async (req, res) => {
  const notificationId = id(req.params.notificationId);
  const { rows } = await pool.query(
    `UPDATE portal_notifications SET read_at=COALESCE(read_at,NOW())
      WHERE id=$1 AND membership_id=$2 AND organization_id=$3 RETURNING id,read_at`,
    [notificationId, req.portalMembership.id, req.portalMembership.organization_id],
  );
  if (!rows[0]) return res.status(404).json({ message: 'Notification not found' });
  res.json({ notification: rows[0] });
});

export const getPortalNotificationPreferences = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM portal_notification_preferences WHERE membership_id=$1`,
    [req.portalMembership.id],
  );
  res.json({ preferences: rows[0] || { membership_id: req.portalMembership.id, email_enabled: true, sms_enabled: false, dashboard_enabled: true, event_preferences: {}, quiet_hours: {} } });
});

export const updatePortalNotificationPreferences = asyncHandler(async (req, res) => {
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const { rows } = await pool.query(
    `INSERT INTO portal_notification_preferences
      (membership_id,event_preferences,quiet_hours,email_enabled,sms_enabled,dashboard_enabled,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (membership_id) DO UPDATE SET event_preferences=EXCLUDED.event_preferences,
       quiet_hours=EXCLUDED.quiet_hours,email_enabled=EXCLUDED.email_enabled,
       sms_enabled=EXCLUDED.sms_enabled,dashboard_enabled=EXCLUDED.dashboard_enabled,updated_at=NOW()
     RETURNING *`,
    [req.portalMembership.id, object(req.body.event_preferences), object(req.body.quiet_hours),
      req.body.email_enabled !== false, req.body.sms_enabled === true, req.body.dashboard_enabled !== false],
  );
  res.json({ preferences: rows[0] });
});
