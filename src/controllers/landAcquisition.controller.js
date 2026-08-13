import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { isOrgAdmin, parsePositiveId, writeComplianceAudit } from '../utils/complianceAccess.js';
import { createPayment as createLegacyFarmerPayment } from './farmer.controller.js';
import { buildVerifyUrl, ReceiptType } from '../utils/receiptToken.js';
import {
  acquisitionCompletionChecklist,
  deriveAcquisitionLifecycle,
  deriveFinancialStatus,
  makeAcquisitionReference,
  normalizeAcquisitionInput,
  normalizeAgreement,
  normalizeFinancialTerms,
  normalizeLandDetails,
} from '../services/landAcquisition.service.js';

const POSTED_PAYMENT = `LOWER(COALESCE(fp.status,'approved'))='approved'
  AND UPPER(COALESCE(fp.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')`;

const scope = (req) => ({
  siteId: Number.parseInt(req.landAcquisitionSiteId ?? req.siteContextId, 10),
  organizationId: Number.parseInt(req.user?.organization_id, 10),
});

const transaction = async (work) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const normalizeOr400 = (res, normalizer, input, options) => {
  try {
    return normalizer(input, options);
  } catch (error) {
    res.status(400).json({ message: error.message });
    return null;
  }
};

const paymentSummaryLateral = `
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(SUM(fp.amount) FILTER (WHERE ${POSTED_PAYMENT}),0)::numeric AS total_paid,
      COALESCE(SUM(
        CASE WHEN ${POSTED_PAYMENT} THEN
          CASE WHEN UPPER(COALESCE(fp.payment_mode,''))='SPLIT' THEN COALESCE(fp.cash_amount,0)
               WHEN ledger_bucket(fp.payment_mode)='cash' THEN fp.amount ELSE 0 END
        ELSE 0 END
      ),0)::numeric AS cash_paid,
      COALESCE(SUM(
        CASE WHEN ${POSTED_PAYMENT} THEN
          CASE WHEN UPPER(COALESCE(fp.payment_mode,''))='SPLIT' THEN COALESCE(fp.bank_amount,0)
               WHEN ledger_bucket(fp.payment_mode)='cash' THEN 0 ELSE fp.amount END
        ELSE 0 END
      ),0)::numeric AS bank_paid,
      COUNT(*) FILTER (WHERE ${POSTED_PAYMENT})::int AS posted_payment_count,
      COUNT(*)::int AS payment_count
    FROM farmer_payments fp
    WHERE fp.farmer_id=f.id
  ) pay ON TRUE`;

const agreementLateral = `
  LEFT JOIN LATERAL (
    SELECT a.id,a.revision_number,a.agreement_type,a.agreement_date,a.agreement_number,
           a.agreement_status,a.agreement_value,a.remarks,a.reviewed_by,a.reviewed_at,a.created_at
      FROM land_acquisition_agreements a
     WHERE a.organization_id=s.organization_id AND a.site_id=f.site_id AND a.acquisition_id=f.id
     ORDER BY a.revision_number DESC,a.id DESC
     LIMIT 1
  ) agreement ON TRUE`;

const scheduleLateral = `
  LEFT JOIN LATERAL (
    SELECT
      MIN(schedule_row.due_date) FILTER (
        WHERE schedule_row.due_date IS NOT NULL
          AND schedule_row.expected_amount > schedule_row.allocated_amount
      ) AS next_due_date,
      COALESCE(SUM(schedule_row.expected_amount),0)::numeric AS scheduled_amount,
      COALESCE(SUM(schedule_row.allocated_amount),0)::numeric AS schedule_paid,
      BOOL_OR(
        schedule_row.due_date < CURRENT_DATE
        AND schedule_row.expected_amount > schedule_row.allocated_amount
      ) AS has_overdue
    FROM (
      SELECT ps.id,ps.due_date,ps.expected_amount,
             COALESCE(SUM(pa.allocated_amount) FILTER (
               WHERE ${POSTED_PAYMENT}
             ),0)::numeric AS allocated_amount
        FROM land_acquisition_payment_schedules ps
        LEFT JOIN land_acquisition_payment_allocations pa ON pa.schedule_item_id=ps.id
        LEFT JOIN farmer_payments fp ON fp.id=pa.farmer_payment_id
       WHERE ps.acquisition_id=f.id AND ps.site_id=f.site_id
         AND ps.superseded_at IS NULL AND ps.schedule_status <> 'CANCELLED'
       GROUP BY ps.id
    ) schedule_row
  ) schedule ON TRUE`;

const documentLateral = `
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS document_count
      FROM compliance_documents d
     WHERE d.organization_id=s.organization_id AND d.site_id=f.site_id
       AND d.entity_type='LAND_ACQUISITION' AND d.entity_id=f.id AND d.deleted_at IS NULL
  ) docs ON TRUE`;

const baseSelect = `
  SELECT f.*,
         s.organization_id,
         s.name AS site_name,
         COALESCE(m.full_name,f.name) AS landowner_name,
         COALESCE(m.phone,f.phone) AS landowner_phone,
         COALESCE(m.address,f.address) AS landowner_address,
         m.member_type AS landowner_type,
         rp.name AS project_name,
         responsible.name AS responsible_user_name,
         COALESCE(pay.total_paid,0) AS total_paid,
         COALESCE(pay.cash_paid,0) AS cash_paid,
         COALESCE(pay.bank_paid,0) AS bank_paid,
         COALESCE(pay.posted_payment_count,0) AS posted_payment_count,
         COALESCE(pay.payment_count,0) AS payment_count,
         agreement.id AS agreement_id,
         agreement.revision_number AS agreement_revision,
         agreement.agreement_type,
         agreement.agreement_date,
         agreement.agreement_number,
         agreement.agreement_status,
         agreement.agreement_value,
         agreement.remarks AS agreement_remarks,
         schedule.next_due_date,
         schedule.scheduled_amount,
         schedule.schedule_paid,
         COALESCE(schedule.has_overdue,FALSE) AS has_overdue,
         COALESCE(docs.document_count,0) AS document_count
    FROM farmers f
    JOIN sites s ON s.id=f.site_id
    LEFT JOIN members m ON m.id=f.member_id AND m.site_id=f.site_id
    LEFT JOIN rera_projects rp ON rp.id=f.rera_project_id AND rp.site_id=f.site_id
    LEFT JOIN users responsible ON responsible.id=f.responsible_user_id
    ${paymentSummaryLateral}
    ${agreementLateral}
    ${scheduleLateral}
    ${documentLateral}`;

const toNumber = (value) => Number.parseFloat(value) || 0;

// The lifecycle shown to users is derived from approved financial truth. Keep
// list filters aligned with that derived value instead of relying on the last
// workflow hint persisted on the Farmer/acquisition row.
const postedPaidForAcquisitionSql = `COALESCE((
  SELECT SUM(payment.amount)
    FROM farmer_payments payment
   WHERE payment.farmer_id=f.id
     AND LOWER(COALESCE(payment.status,'approved'))='approved'
     AND UPPER(COALESCE(payment.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
),0)`;

const presentAcquisition = (row) => {
  if (!row) return null;
  const total = toNumber(row.total_amount);
  const paid = toNumber(row.total_paid);
  const lifecycle = deriveAcquisitionLifecycle(row);
  const financialStatus = deriveFinancialStatus({
    totalAmount: total,
    totalPaid: paid,
    hasOverdue: Boolean(row.has_overdue),
    onHold: String(row.status || '').toLowerCase() === 'inactive',
  });
  const completion = acquisitionCompletionChecklist(row);
  return {
    ...row,
    acquisition_reference: row.acquisition_reference || `LEGACY-${row.id}`,
    is_legacy: !row.acquisition_reference,
    legacy_mapping_status: row.acquisition_reference ? row.legacy_mapping_status : 'REVIEW_REQUIRED',
    effective_lifecycle_status: lifecycle,
    financial_status: financialStatus,
    total_amount: total,
    total_paid: paid,
    outstanding: Math.max(total - paid, 0),
    cash_amount: toNumber(row.cash_amount),
    bank_amount: toNumber(row.bank_amount),
    cash_paid: toNumber(row.cash_paid),
    bank_paid: toNumber(row.bank_paid),
    scheduled_amount: toNumber(row.scheduled_amount),
    schedule_paid: toNumber(row.schedule_paid),
    completion,
  };
};

async function getAcquisition(db, req, id, { lock = false } = {}) {
  const { siteId, organizationId } = scope(req);
  const { rows } = await db.query(
    `${baseSelect}
      WHERE f.id=$1 AND f.site_id=$2 AND s.organization_id=$3
      ${lock ? 'FOR UPDATE OF f' : ''}`,
    [id, siteId, organizationId],
  );
  return presentAcquisition(rows[0]);
}

const updateFields = async (db, id, siteId, organizationId, fields) => {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (!entries.length) return null;
  const values = entries.map(([, value]) => value);
  values.push(id, siteId, organizationId);
  const { rows } = await db.query(
    `UPDATE farmers f SET ${entries.map(([key], index) => `${key}=$${index + 1}`).join(',')},
            updated_at=NOW(),workflow_version=workflow_version+1
       FROM sites s
      WHERE f.id=$${entries.length + 1} AND f.site_id=$${entries.length + 2}
        AND s.id=f.site_id AND s.organization_id=$${entries.length + 3}
      RETURNING f.*`,
    values,
  );
  return rows[0] || null;
};

export const listLandAcquisitions = asyncHandler(async (req, res) => {
  const { siteId, organizationId } = scope(req);
  const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 25, 1), 100);
  const params = [siteId, organizationId];
  const where = ['f.site_id=$1', 's.organization_id=$2'];
  const add = (value) => { params.push(value); return `$${params.length}`; };

  if (req.query.q) {
    const p = add(String(req.query.q).trim().slice(0, 120));
    where.push(`(f.acquisition_reference ILIKE '%'||${p}||'%' OR f.name ILIKE '%'||${p}||'%'
      OR m.full_name ILIKE '%'||${p}||'%' OR f.village ILIKE '%'||${p}||'%'
      OR f.khasra_number ILIKE '%'||${p}||'%')`);
  }
  if (req.query.status && String(req.query.status).toLowerCase() !== 'all') {
    const requestedStatus = String(req.query.status).trim().toUpperCase();
    if (requestedStatus === 'LEGACY') {
      where.push('f.acquisition_reference IS NULL');
    } else if (requestedStatus === 'COMPLETED') {
      where.push(`(f.completed_at IS NOT NULL OR f.lifecycle_status='COMPLETED')`);
    } else if (requestedStatus === 'FULLY_PAID') {
      where.push(`f.completed_at IS NULL AND f.financial_terms_status='CONFIRMED'
        AND f.total_amount > 0 AND ${postedPaidForAcquisitionSql} >= f.total_amount - 0.009`);
    } else if (requestedStatus === 'PAYMENT_IN_PROGRESS') {
      where.push(`f.completed_at IS NULL AND ${postedPaidForAcquisitionSql} > 0
        AND ${postedPaidForAcquisitionSql} < f.total_amount - 0.009`);
    } else {
      const p = add(requestedStatus);
      where.push(`COALESCE(f.lifecycle_status,'DRAFT')=${p}`);
    }
  }
  if (req.query.landowner_id) where.push(`f.member_id=${add(parsePositiveId(req.query.landowner_id) || 0)}`);
  if (req.query.village) where.push(`f.village ILIKE '%'||${add(String(req.query.village).trim().slice(0, 160))}||'%'`);
  if (req.query.from) where.push(`f.created_at::date>=${add(req.query.from)}`);
  if (req.query.to) where.push(`f.created_at::date<=${add(req.query.to)}`);

  const clause = where.join(' AND ');
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM farmers f JOIN sites s ON s.id=f.site_id
      LEFT JOIN members m ON m.id=f.member_id AND m.site_id=f.site_id WHERE ${clause}`,
    params,
  );
  params.push(limit, (page - 1) * limit);
  const { rows } = await pool.query(
    `${baseSelect} WHERE ${clause}
      ORDER BY f.created_at DESC,f.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const total = countRows[0]?.total || 0;
  res.json({
    acquisitions: rows.map(presentAcquisition),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

export const getLandAcquisitionOptions = asyncHandler(async (req, res) => {
  const { siteId, organizationId } = scope(req);
  const [landowners, employees, projects] = await Promise.all([
    pool.query(
      `SELECT m.id,m.full_name,m.phone,m.address,m.member_type
         FROM members m JOIN sites s ON s.id=m.site_id AND s.organization_id=$2
        WHERE m.site_id=$1 AND UPPER(COALESCE(m.member_type,'')) IN ('FARMER','LANDOWNER')
        ORDER BY m.full_name`,
      [siteId, organizationId],
    ),
    pool.query(
      `SELECT u.id,u.name,u.role
         FROM users u
        WHERE u.organization_id=$2 AND u.is_active=TRUE AND (
          u.role IN ('admin','super_admin') OR EXISTS (
            SELECT 1 FROM user_sites us WHERE us.user_id=u.id AND us.site_id=$1
          )
        ) ORDER BY u.name`,
      [siteId, organizationId],
    ),
    pool.query(
      `SELECT p.id,p.name,p.registration_number,p.regulatory_status
         FROM rera_projects p
        WHERE p.organization_id=$2 AND p.site_id=$1 AND p.deleted_at IS NULL
        ORDER BY p.name`,
      [siteId, organizationId],
    ),
  ]);
  res.json({ landowners: landowners.rows, responsible_employees: employees.rows, projects: projects.rows });
});

export const getLandAcquisitionOverview = asyncHandler(async (req, res) => {
  const { siteId, organizationId } = scope(req);
  const { rows } = await pool.query(
    `${baseSelect}
      WHERE f.site_id=$1 AND s.organization_id=$2
      ORDER BY f.created_at DESC,f.id DESC`,
    [siteId, organizationId],
  );
  const acquisitions = rows.map(presentAcquisition);
  const summary = acquisitions.reduce((acc, item) => {
    acc.total_acquisitions += 1;
    if (item.effective_lifecycle_status !== 'COMPLETED') acc.active_acquisitions += 1;
    acc.total_land += toNumber(item.land_size_bigha);
    acc.total_agreed += item.total_amount;
    acc.total_paid += item.total_paid;
    acc.outstanding += item.outstanding;
    if (item.next_due_date) acc.payments_due += 1;
    return acc;
  }, {
    total_acquisitions: 0, active_acquisitions: 0, total_land: 0,
    total_agreed: 0, total_paid: 0, outstanding: 0, payments_due: 0,
  });
  const attention = acquisitions.flatMap((item) => {
    const messages = [];
    if (!item.agreement_status || !['EXECUTED', 'SUPERSEDED'].includes(item.agreement_status)) messages.push('Agreement pending execution');
    if (item.financial_status === 'OVERDUE') messages.push('Payment schedule is overdue');
    if (!item.document_count) messages.push('No land or agreement documents uploaded');
    if (item.financial_status === 'FULLY_PAID' && item.effective_lifecycle_status !== 'COMPLETED') messages.push('Fully paid and ready for completion review');
    if (item.is_legacy) messages.push('Legacy record needs acquisition review');
    return messages.map((message) => ({
      acquisition_id: item.id,
      acquisition_reference: item.acquisition_reference,
      landowner_name: item.landowner_name,
      message,
    }));
  }).slice(0, 12);
  const [auditResult, paymentResult] = await Promise.all([
    pool.query(
      `SELECT a.id,a.action,a.entity_id,a.new_value,a.reason,a.created_at,u.name AS user_name
         FROM compliance_audit_log a
         LEFT JOIN users u ON u.id=a.user_id AND u.organization_id=a.organization_id
        WHERE a.organization_id=$1 AND a.site_id=$2 AND a.entity_type='LAND_ACQUISITION'
        ORDER BY a.created_at DESC,a.id DESC LIMIT 12`,
      [organizationId, siteId],
    ),
    pool.query(
      `SELECT ('payment-'||fp.id)::text AS id,
              CASE WHEN fp.reverses_payment_id IS NULL THEN 'PAYMENT_RECORDED' ELSE 'PAYMENT_REVERSAL_RECORDED' END AS action,
              f.id AS entity_id,
              jsonb_build_object('payment_id',fp.id,'amount',fp.amount,'payment_mode',fp.payment_mode,'status',fp.status) AS new_value,
              fp.reversal_reason AS reason,fp.created_at,u.name AS user_name
         FROM farmer_payments fp
         JOIN farmers f ON f.id=fp.farmer_id AND f.site_id=$2
         JOIN sites s ON s.id=f.site_id AND s.organization_id=$1
         LEFT JOIN users u ON u.id=fp.created_by AND u.organization_id=$1
        ORDER BY fp.created_at DESC,fp.id DESC LIMIT 12`,
      [organizationId, siteId],
    ),
  ]);
  const recentActivity = [...auditResult.rows, ...paymentResult.rows]
    .sort((left, right) => new Date(right.created_at) - new Date(left.created_at))
    .slice(0, 12);
  res.json({ summary, attention, recent_activity: recentActivity, recent_acquisitions: acquisitions.slice(0, 8) });
});

export const createLandAcquisition = asyncHandler(async (req, res) => {
  const payload = normalizeOr400(res, normalizeAcquisitionInput, req.body);
  if (!payload) return;
  const land = normalizeOr400(res, normalizeLandDetails, req.body.land || req.body, { partial: true });
  if (!land) return;
  const { siteId, organizationId } = scope(req);
  if (payload.site_id !== siteId) return res.status(409).json({ message: 'Selected Site does not match the request context' });

  const created = await transaction(async (client) => {
    const { rows: memberRows } = await client.query(
      `SELECT m.* FROM members m JOIN sites s ON s.id=m.site_id AND s.organization_id=$3
        WHERE m.id=$1 AND m.site_id=$2 LIMIT 1 FOR UPDATE OF m`,
      [payload.member_id, siteId, organizationId],
    );
    const member = memberRows[0];
    if (!member) return { error: [404, 'Registered landowner not found for this Site'] };

    const hasLand = Boolean(land.village && (land.khasra_number || land.survey_number || land.parcel_number) && land.land_size_bigha);
    const { rows } = await client.query(
      `INSERT INTO farmers
        (name,phone,address,total_amount,interest_rate,site_id,created_by,notes,status,member_id,
         payment_mode,cash_amount,bank_amount,land_size_bigha,land_size_unit,
         acquisition_type,lifecycle_status,legacy_mapping_status,rera_project_id,responsible_user_id,
         village,tehsil,district,state,khasra_number,survey_number,parcel_number,land_type,
         ownership_share,land_notes,financial_terms_status)
       VALUES ($1,$2,$3,0,0,$4,$5,$6,'active',$7,'BANK',0,0,$8,$9,$10,$11,'MAPPED',$12,$13,
               $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'DRAFT')
       RETURNING *`,
      [
        member.full_name, member.phone || null, member.address || null, siteId, req.user.id,
        payload.notes, member.id, land.land_size_bigha ?? null, land.land_size_unit || 'BIGHA',
        payload.acquisition_type, hasLand ? 'LAND_DETAILS' : 'DRAFT', payload.rera_project_id,
        payload.responsible_user_id, land.village ?? null, land.tehsil ?? null, land.district ?? null,
        land.state ?? null, land.khasra_number ?? null, land.survey_number ?? null,
        land.parcel_number ?? null, land.land_type ?? null, land.ownership_share ?? null,
        land.land_notes ?? null,
      ],
    );
    const reference = makeAcquisitionReference(rows[0].id, rows[0].created_at);
    const { rows: referencedRows } = await client.query(
      `UPDATE farmers SET acquisition_reference=$1 WHERE id=$2 AND site_id=$3 RETURNING *`,
      [reference, rows[0].id, siteId],
    );
    await writeComplianceAudit(client, req, {
      action: 'CREATE', entityType: 'LAND_ACQUISITION', entityId: rows[0].id, siteId,
      newValue: { acquisition_reference: reference, landowner_member_id: member.id, acquisition_type: payload.acquisition_type },
    });
    return { acquisition: referencedRows[0] };
  });
  if (created.error) return res.status(created.error[0]).json({ message: created.error[1] });
  const acquisition = await getAcquisition(pool, req, created.acquisition.id);
  res.status(201).json({ acquisition });
});

export const getLandAcquisition = asyncHandler(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  const acquisition = await getAcquisition(pool, req, id);
  if (!acquisition) return res.status(404).json({ message: 'Land acquisition not found' });
  const { siteId, organizationId } = scope(req);
  const [agreements, schedule, payments, activity] = await Promise.all([
    pool.query(
      `SELECT a.*,u.name AS created_by_name,r.name AS reviewed_by_name
         FROM land_acquisition_agreements a
         LEFT JOIN users u ON u.id=a.created_by LEFT JOIN users r ON r.id=a.reviewed_by
        WHERE a.organization_id=$1 AND a.site_id=$2 AND a.acquisition_id=$3
        ORDER BY a.revision_number DESC,a.id DESC`,
      [organizationId, siteId, id],
    ),
    pool.query(
      `SELECT ps.*,
              COALESCE(SUM(pa.allocated_amount) FILTER (WHERE ${POSTED_PAYMENT}),0)::numeric AS amount_paid
         FROM land_acquisition_payment_schedules ps
         LEFT JOIN land_acquisition_payment_allocations pa ON pa.schedule_item_id=ps.id
         LEFT JOIN farmer_payments fp ON fp.id=pa.farmer_payment_id
        WHERE ps.organization_id=$1 AND ps.site_id=$2 AND ps.acquisition_id=$3
          AND ps.superseded_at IS NULL
        GROUP BY ps.id ORDER BY ps.sequence_no`,
      [organizationId, siteId, id],
    ),
    pool.query(
      `SELECT fp.*,u.name AS recorded_by_name,ps.description AS allocated_schedule
         FROM farmer_payments fp
         JOIN farmers f ON f.id=fp.farmer_id AND f.site_id=$2
         JOIN sites s ON s.id=f.site_id AND s.organization_id=$1
         LEFT JOIN users u ON u.id=fp.created_by AND u.organization_id=$1
         LEFT JOIN land_acquisition_payment_allocations pa ON pa.farmer_payment_id=fp.id
         LEFT JOIN land_acquisition_payment_schedules ps ON ps.id=pa.schedule_item_id
        WHERE fp.farmer_id=$3
        ORDER BY fp.date DESC,fp.id DESC LIMIT 100`,
      [organizationId, siteId, id],
    ),
    pool.query(
      `SELECT a.id,a.action,a.previous_value,a.new_value,a.reason,a.created_at,u.name AS user_name
         FROM compliance_audit_log a
         LEFT JOIN users u ON u.id=a.user_id AND u.organization_id=a.organization_id
        WHERE a.organization_id=$1 AND a.site_id=$2 AND a.entity_type='LAND_ACQUISITION' AND a.entity_id=$3
        ORDER BY a.created_at DESC,a.id DESC LIMIT 100`,
      [organizationId, siteId, id],
    ),
  ]);
  const timeline = [
    ...activity.rows,
    ...payments.rows.map((payment) => ({
      id: `payment-${payment.id}`,
      action: payment.reverses_payment_id ? 'PAYMENT_REVERSAL_RECORDED' : 'PAYMENT_RECORDED',
      new_value: {
        payment_id: payment.id,
        amount: payment.amount,
        payment_mode: payment.payment_mode,
        status: payment.status,
      },
      reason: payment.reversal_reason || payment.remarks || null,
      created_at: payment.created_at,
      user_name: payment.recorded_by_name,
    })),
  ].sort((left, right) => new Date(right.created_at) - new Date(left.created_at)).slice(0, 100);
  res.json({
    acquisition,
    agreements: agreements.rows,
    payment_schedule: schedule.rows.map((item) => ({
      ...item,
      amount_paid: toNumber(item.amount_paid),
      outstanding: Math.max(toNumber(item.expected_amount) - toNumber(item.amount_paid), 0),
      effective_status: toNumber(item.amount_paid) >= toNumber(item.expected_amount) - 0.009
        ? 'PAID'
        : toNumber(item.amount_paid) > 0
          ? 'PARTIALLY_PAID'
          : item.due_date && new Date(item.due_date) < new Date(new Date().toISOString().slice(0, 10))
            ? 'OVERDUE' : 'PENDING',
    })),
    transactions: payments.rows.map((payment) => ({
      ...payment,
      verifyUrl: buildVerifyUrl({
        t: ReceiptType.FARMER,
        i: payment.id,
        fn: acquisition.landowner_name || null,
        a: payment.amount,
        d: payment.date,
        pm: payment.payment_mode || null,
        sn: acquisition.site_name || null,
      }),
    })),
    activity: timeline,
  });
});

export const updateLandDetails = asyncHandler(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  const land = normalizeOr400(res, normalizeLandDetails, req.body, { partial: true });
  if (!land) return;
  const { siteId, organizationId } = scope(req);
  const result = await transaction(async (client) => {
    const before = await getAcquisition(client, req, id, { lock: true });
    if (!before) return { error: [404, 'Land acquisition not found'] };
    if (before.completed_at) return { error: [409, 'Reopen this completed acquisition before editing land details'] };
    const next = { ...before, ...land };
    const lifecycle = deriveAcquisitionLifecycle(next);
    const updated = await updateFields(client, id, siteId, organizationId, { ...land, lifecycle_status: lifecycle });
    await writeComplianceAudit(client, req, {
      action: 'LAND_DETAILS_UPDATE', entityType: 'LAND_ACQUISITION', entityId: id, siteId,
      previousValue: Object.fromEntries(Object.keys(land).map((key) => [key, before[key]])),
      newValue: Object.fromEntries(Object.keys(land).map((key) => [key, updated[key]])),
      reason: req.body.reason,
    });
    return { updated };
  });
  if (result.error) return res.status(result.error[0]).json({ message: result.error[1] });
  res.json({ acquisition: await getAcquisition(pool, req, id) });
});

export const saveLandAgreement = asyncHandler(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  const agreement = normalizeOr400(res, normalizeAgreement, req.body);
  if (!agreement) return;
  const { siteId, organizationId } = scope(req);
  const result = await transaction(async (client) => {
    const acquisition = await getAcquisition(client, req, id, { lock: true });
    if (!acquisition) return { error: [404, 'Land acquisition not found'] };
    if (acquisition.completed_at) return { error: [409, 'Reopen this completed acquisition before changing its agreement'] };
    const { rows: previousRows } = await client.query(
      `SELECT * FROM land_acquisition_agreements
        WHERE organization_id=$1 AND site_id=$2 AND acquisition_id=$3
        ORDER BY revision_number DESC,id DESC LIMIT 1 FOR UPDATE`,
      [organizationId, siteId, id],
    );
    const previous = previousRows[0] || null;
    const revision = Number(previous?.revision_number || 0) + 1;
    if (agreement.agreement_status === 'EXECUTED' && previous?.agreement_status === 'EXECUTED') {
      await client.query(
        `UPDATE land_acquisition_agreements SET agreement_status='SUPERSEDED',updated_at=NOW()
          WHERE id=$1 AND organization_id=$2 AND site_id=$3 AND acquisition_id=$4`,
        [previous.id, organizationId, siteId, id],
      );
    }
    const reviewed = ['UNDER_REVIEW', 'EXECUTED'].includes(agreement.agreement_status);
    const { rows } = await client.query(
      `INSERT INTO land_acquisition_agreements
        (organization_id,site_id,acquisition_id,revision_number,agreement_type,agreement_date,
         agreement_number,agreement_status,agreement_value,witness_parties,remarks,
         supersedes_agreement_id,created_by,reviewed_by,reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        organizationId, siteId, id, revision, agreement.agreement_type, agreement.agreement_date,
        agreement.agreement_number, agreement.agreement_status, agreement.agreement_value,
        JSON.stringify(agreement.witness_parties), agreement.remarks, previous?.id || null, req.user.id,
        reviewed ? req.user.id : null, reviewed ? new Date() : null,
      ],
    );
    const lifecycle = agreement.agreement_status === 'EXECUTED' ? 'AGREEMENT_COMPLETED' : 'AGREEMENT_PENDING';
    await updateFields(client, id, siteId, organizationId, { lifecycle_status: lifecycle });
    await writeComplianceAudit(client, req, {
      action: 'AGREEMENT_REVISION_CREATE', entityType: 'LAND_ACQUISITION', entityId: id, siteId,
      previousValue: previous, newValue: rows[0], reason: req.body.reason,
    });
    return { agreement: rows[0] };
  });
  if (result.error) return res.status(result.error[0]).json({ message: result.error[1] });
  res.status(201).json({ agreement: result.agreement, acquisition: await getAcquisition(pool, req, id) });
});

export const confirmLandFinancialTerms = asyncHandler(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  const terms = normalizeOr400(res, normalizeFinancialTerms, req.body);
  if (!terms) return;
  const { siteId, organizationId } = scope(req);
  const result = await transaction(async (client) => {
    const acquisition = await getAcquisition(client, req, id, { lock: true });
    if (!acquisition) return { error: [404, 'Land acquisition not found'] };
    if (acquisition.completed_at) return { error: [409, 'Reopen this completed acquisition before changing financial terms'] };
    if (acquisition.agreement_status !== 'EXECUTED') {
      return { error: [409, 'Execute the acquisition agreement before confirming financial terms'] };
    }
    if (terms.total_amount + 0.009 < acquisition.total_paid) {
      return { error: [409, 'Agreed value cannot be lower than valid posted payments'] };
    }
    const changingConfirmed = acquisition.financial_terms_status === 'CONFIRMED'
      && (Math.abs(acquisition.total_amount - terms.total_amount) > 0.009
        || Math.abs(acquisition.cash_amount - terms.cash_amount) > 0.009
        || Math.abs(acquisition.bank_amount - terms.bank_amount) > 0.009);
    if (changingConfirmed && !terms.reason) return { error: [400, 'A reason is required to revise confirmed financial terms'] };

    const { rows: revisionRows } = await client.query(
      `SELECT COALESCE(MAX(revision_number),0)+1 AS revision
         FROM land_acquisition_payment_schedules WHERE acquisition_id=$1`,
      [id],
    );
    const revision = Number(revisionRows[0].revision || 1);
    await client.query(
      `UPDATE land_acquisition_payment_schedules
          SET schedule_status='SUPERSEDED',superseded_at=NOW(),updated_at=NOW()
        WHERE organization_id=$1 AND site_id=$2 AND acquisition_id=$3 AND superseded_at IS NULL`,
      [organizationId, siteId, id],
    );
    for (const item of terms.schedule) {
      await client.query(
        `INSERT INTO land_acquisition_payment_schedules
          (organization_id,site_id,acquisition_id,revision_number,sequence_no,description,due_date,
           expected_amount,preferred_mode,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [organizationId, siteId, id, revision, item.sequence_no, item.description, item.due_date,
          item.expected_amount, item.preferred_mode, req.user.id],
      );
    }
    const before = {
      total_amount: acquisition.total_amount, cash_amount: acquisition.cash_amount,
      bank_amount: acquisition.bank_amount, financial_terms_status: acquisition.financial_terms_status,
    };
    const updated = await updateFields(client, id, siteId, organizationId, {
      total_amount: terms.total_amount,
      cash_amount: terms.cash_amount,
      bank_amount: terms.bank_amount,
      payment_mode: terms.payment_mode,
      financial_terms_status: 'CONFIRMED',
      financial_terms_confirmed_at: new Date(),
      financial_terms_confirmed_by: req.user.id,
      lifecycle_status: acquisition.total_paid > 0 ? 'PAYMENT_IN_PROGRESS' : 'FINANCIAL_TERMS_CONFIRMED',
    });
    await writeComplianceAudit(client, req, {
      action: changingConfirmed ? 'FINANCIAL_TERMS_REVISE' : 'FINANCIAL_TERMS_CONFIRM',
      entityType: 'LAND_ACQUISITION', entityId: id, siteId, previousValue: before,
      newValue: { total_amount: updated.total_amount, cash_amount: updated.cash_amount, bank_amount: updated.bank_amount, schedule_revision: revision },
      reason: terms.reason,
    });
    return { updated };
  });
  if (result.error) return res.status(result.error[0]).json({ message: result.error[1] });
  res.json({ acquisition: await getAcquisition(pool, req, id) });
});

/** Alias the existing payment writer; it remains the only payment engine. */
export const recordLandAcquisitionPayment = (req, res, next) => {
  req.params.farmerId = req.params.id;
  req.body = {
    ...req.body,
    mapped_member_id: req.landAcquisitionMemberId || req.body.mapped_member_id,
  };
  return createLegacyFarmerPayment(req, res, next);
};

export const reverseLandAcquisitionPayment = asyncHandler(async (req, res) => {
  const acquisitionId = parsePositiveId(req.params.id);
  const paymentId = parsePositiveId(req.params.paymentId);
  const reason = String(req.body.reason || '').trim().slice(0, 2000);
  if (!reason) return res.status(400).json({ message: 'A reversal reason is required' });
  const { siteId, organizationId } = scope(req);

  const result = await transaction(async (client) => {
    const acquisition = await getAcquisition(client, req, acquisitionId, { lock: true });
    if (!acquisition) return { error: [404, 'Land acquisition not found'] };
    if (acquisition.completed_at) return { error: [409, 'Completed acquisitions cannot receive payment reversals until reopened'] };
    const { rows } = await client.query(
      `SELECT fp.* FROM farmer_payments fp
        JOIN farmers f ON f.id=fp.farmer_id AND f.site_id=$3
        JOIN sites s ON s.id=f.site_id AND s.organization_id=$4
       WHERE fp.id=$1 AND fp.farmer_id=$2 LIMIT 1 FOR UPDATE OF fp`,
      [paymentId, acquisitionId, siteId, organizationId],
    );
    const original = rows[0];
    if (!original) return { error: [404, 'Payment not found for this acquisition'] };
    if (original.reverses_payment_id || Number(original.amount) <= 0) return { error: [409, 'Only an original positive payment can be reversed'] };
    if (String(original.status || '').toLowerCase() !== 'approved'
        || ['BOUNCED', 'RETURNED'].includes(String(original.cheque_status || '').toUpperCase())) {
      return { error: [409, 'Only a valid posted payment can be reversed'] };
    }
    const { rows: duplicateRows } = await client.query(
      `SELECT id FROM farmer_payments WHERE reverses_payment_id=$1 LIMIT 1`,
      [paymentId],
    );
    if (duplicateRows[0]) return { error: [409, 'This payment already has a reversal'] };

    const amount = -Math.abs(toNumber(original.amount));
    const cash = -Math.abs(toNumber(original.cash_amount));
    const bank = -Math.abs(toNumber(original.bank_amount));
    const { rows: reversalRows } = await client.query(
      `INSERT INTO farmer_payments
        (farmer_id,date,particular,amount,by_note,remarks,payment_mode,cash_amount,bank_amount,
         bank_name,bank_account_no,bank_reference,bank_ifsc,assigned_admin_id,status,created_by,
         mapped_member_id,mapped_user_id,reverses_payment_id,reversal_reason,idempotency_key)
       VALUES ($1,CURRENT_DATE,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [
        acquisitionId, `REVERSAL - ${original.particular || `PAYMENT #${paymentId}`}`, amount,
        original.by_note, reason, original.payment_mode, cash, bank, original.bank_name,
        original.bank_account_no, original.bank_reference, original.bank_ifsc,
        original.assigned_admin_id, req.user.id, acquisition.member_id, original.mapped_user_id,
        paymentId, reason, `reversal-${paymentId}`,
      ],
    );
    const reversal = reversalRows[0];
    const legs = String(original.payment_mode || '').toUpperCase() === 'SPLIT'
      ? [{ mode: 'CASH', amount: Math.abs(cash) }, { mode: 'BANK', amount: Math.abs(bank) }]
      : [{ mode: String(original.payment_mode || 'BANK').toUpperCase(), amount: Math.abs(amount) }];
    for (const leg of legs.filter((item) => item.amount > 0)) {
      await client.query(
        `INSERT INTO day_book
          (site_id,date,particular,entry_type,debit,credit,remarks,payment_mode,category,
           from_entity,to_entity,account_no,branch,created_by,assigned_admin_id,farmer_payment_id)
         VALUES ($1,CURRENT_DATE,$2,'FARMER PAYMENT',0,$3,$4,$5,'FARMER PAYMENT',$6,NULL,$7,$8,$9,$10,$11)`,
        [siteId, `${acquisition.landowner_name.toUpperCase()} - LAND PAYMENT REVERSAL`, leg.amount,
          reason, leg.mode, acquisition.landowner_name.toUpperCase(), original.bank_account_no,
          original.bank_ifsc, req.user.id, original.assigned_admin_id, reversal.id],
      );
    }
    await client.query(
      `INSERT INTO land_acquisition_payment_allocations
        (acquisition_id,schedule_item_id,farmer_payment_id,allocated_amount,created_by)
       SELECT acquisition_id,schedule_item_id,$1,-allocated_amount,$2
         FROM land_acquisition_payment_allocations WHERE farmer_payment_id=$3`,
      [reversal.id, req.user.id, paymentId],
    );
    await writeComplianceAudit(client, req, {
      action: 'PAYMENT_REVERSAL_REQUEST', entityType: 'LAND_ACQUISITION', entityId: acquisitionId,
      siteId, previousValue: { payment_id: paymentId, amount: original.amount },
      newValue: { reversal_payment_id: reversal.id, amount }, reason,
    });
    return { reversal };
  });
  if (result.error) return res.status(result.error[0]).json({ message: result.error[1] });
  res.status(201).json({ reversal: result.reversal, message: 'Reversal recorded and sent for approval' });
});

export const completeLandAcquisition = asyncHandler(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  const notes = String(req.body.notes || '').trim().slice(0, 4000) || null;
  const { siteId, organizationId } = scope(req);
  const result = await transaction(async (client) => {
    const acquisition = await getAcquisition(client, req, id, { lock: true });
    if (!acquisition) return { error: [404, 'Land acquisition not found'] };
    if (acquisition.completed_at) return { error: [409, 'This acquisition is already completed'] };
    const checklist = acquisitionCompletionChecklist(acquisition);
    if (!checklist.eligible) {
      return { error: [409, 'Complete land details, agreement, financial terms and valid posted payments before completion'], checklist };
    }
    const updated = await updateFields(client, id, siteId, organizationId, {
      lifecycle_status: 'COMPLETED', status: 'completed', completed_at: new Date(),
      completed_by: req.user.id, completion_notes: notes,
    });
    await writeComplianceAudit(client, req, {
      action: 'COMPLETE', entityType: 'LAND_ACQUISITION', entityId: id, siteId,
      previousValue: { lifecycle_status: acquisition.effective_lifecycle_status },
      newValue: { lifecycle_status: 'COMPLETED' }, reason: notes,
    });
    return { updated, checklist };
  });
  if (result.error) return res.status(result.error[0]).json({ message: result.error[1], checklist: result.checklist });
  res.json({ acquisition: await getAcquisition(pool, req, id), checklist: result.checklist });
});

export const reopenLandAcquisition = asyncHandler(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  const reason = String(req.body.reason || '').trim().slice(0, 2000);
  if (!reason) return res.status(400).json({ message: 'A reopening reason is required' });
  const { siteId, organizationId } = scope(req);
  const result = await transaction(async (client) => {
    const acquisition = await getAcquisition(client, req, id, { lock: true });
    if (!acquisition) return { error: [404, 'Land acquisition not found'] };
    if (!acquisition.completed_at) return { error: [409, 'This acquisition is not completed'] };
    const nextStatus = deriveAcquisitionLifecycle({ ...acquisition, completed_at: null, lifecycle_status: null });
    await updateFields(client, id, siteId, organizationId, {
      lifecycle_status: nextStatus, status: 'active', completed_at: null, completed_by: null,
      completion_notes: null, reopened_at: new Date(), reopened_by: req.user.id,
    });
    await writeComplianceAudit(client, req, {
      action: 'REOPEN', entityType: 'LAND_ACQUISITION', entityId: id, siteId,
      previousValue: { lifecycle_status: 'COMPLETED' }, newValue: { lifecycle_status: nextStatus }, reason,
    });
    return { ok: true };
  });
  if (result.error) return res.status(result.error[0]).json({ message: result.error[1] });
  res.json({ acquisition: await getAcquisition(pool, req, id) });
});

export const adoptLegacyLandAcquisition = asyncHandler(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  const memberId = parsePositiveId(req.body.member_id);
  const reason = String(req.body.reason || '').trim().slice(0, 2000);
  if (!memberId || !reason) return res.status(400).json({ message: 'Registered landowner and adoption reason are required' });
  const { siteId, organizationId } = scope(req);
  const result = await transaction(async (client) => {
    const acquisition = await getAcquisition(client, req, id, { lock: true });
    if (!acquisition) return { error: [404, 'Legacy Farmer record not found'] };
    if (acquisition.acquisition_reference && !acquisition.is_legacy) return { error: [409, 'This record is already an adopted Land Acquisition'] };
    const { rows: members } = await client.query(
      `SELECT m.* FROM members m JOIN sites s ON s.id=m.site_id AND s.organization_id=$3
        WHERE m.id=$1 AND m.site_id=$2 LIMIT 1`,
      [memberId, siteId, organizationId],
    );
    if (!members[0]) return { error: [404, 'Registered landowner not found for this Site'] };
    const reference = makeAcquisitionReference(id, acquisition.created_at);
    const nextLifecycle = deriveAcquisitionLifecycle(acquisition);
    await updateFields(client, id, siteId, organizationId, {
      member_id: memberId, acquisition_reference: reference,
      acquisition_type: req.body.acquisition_type || 'DIRECT_PURCHASE',
      legacy_mapping_status: 'MAPPED', lifecycle_status: nextLifecycle,
    });
    await writeComplianceAudit(client, req, {
      action: 'LEGACY_ADOPT', entityType: 'LAND_ACQUISITION', entityId: id, siteId,
      previousValue: { legacy_farmer_id: id, member_id: acquisition.member_id },
      newValue: { acquisition_reference: reference, member_id: memberId }, reason,
    });
    return { ok: true };
  });
  if (result.error) return res.status(result.error[0]).json({ message: result.error[1] });
  res.json({ acquisition: await getAcquisition(pool, req, id) });
});

export const listLandAcquisitionTransactions = asyncHandler(async (req, res) => {
  const { siteId, organizationId } = scope(req);
  const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 25, 1), 100);
  const params = [siteId, organizationId];
  const where = ['f.site_id=$1', 's.organization_id=$2'];
  const add = (value) => { params.push(value); return `$${params.length}`; };
  if (req.query.q) {
    const p = add(String(req.query.q).trim().slice(0, 120));
    where.push(`(f.acquisition_reference ILIKE '%'||${p}||'%' OR f.name ILIKE '%'||${p}||'%'
      OR fp.bank_reference ILIKE '%'||${p}||'%' OR fp.particular ILIKE '%'||${p}||'%')`);
  }
  if (req.query.mode) where.push(`UPPER(fp.payment_mode)=${add(String(req.query.mode).toUpperCase())}`);
  if (req.query.status) where.push(`LOWER(fp.status)=${add(String(req.query.status).toLowerCase())}`);
  if (req.query.from) where.push(`fp.date>=${add(req.query.from)}`);
  if (req.query.to) where.push(`fp.date<=${add(req.query.to)}`);
  const clause = where.join(' AND ');
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM farmer_payments fp
      JOIN farmers f ON f.id=fp.farmer_id JOIN sites s ON s.id=f.site_id WHERE ${clause}`,
    params,
  );
  params.push(limit, (page - 1) * limit);
  const { rows } = await pool.query(
    `SELECT fp.*,f.acquisition_reference,COALESCE(m.full_name,f.name) AS landowner_name,
            u.name AS recorded_by_name,ps.description AS allocated_schedule
       FROM farmer_payments fp
       JOIN farmers f ON f.id=fp.farmer_id
       JOIN sites s ON s.id=f.site_id
       LEFT JOIN members m ON m.id=f.member_id AND m.site_id=f.site_id
       LEFT JOIN users u ON u.id=fp.created_by AND u.organization_id=s.organization_id
       LEFT JOIN land_acquisition_payment_allocations pa ON pa.farmer_payment_id=fp.id
       LEFT JOIN land_acquisition_payment_schedules ps ON ps.id=pa.schedule_item_id
      WHERE ${clause}
      ORDER BY fp.date DESC,fp.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const total = countRows[0]?.total || 0;
  res.json({ transactions: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

export const getLandAcquisitionReports = asyncHandler(async (req, res) => {
  const { siteId, organizationId } = scope(req);
  const params = [siteId, organizationId];
  const [summaryRows, landowners, villages, modes, agreements, due] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total_acquisitions,
              COALESCE(SUM(f.land_size_bigha),0)::numeric AS total_land,
              COALESCE(SUM(f.total_amount),0)::numeric AS total_consideration,
              COUNT(*) FILTER (WHERE f.completed_at IS NOT NULL)::int AS completed,
              COUNT(*) FILTER (WHERE f.completed_at IS NULL)::int AS active
         FROM farmers f JOIN sites s ON s.id=f.site_id
        WHERE f.site_id=$1 AND s.organization_id=$2`, params,
    ),
    pool.query(
      `SELECT f.member_id,COALESCE(m.full_name,f.name) AS landowner_name,COUNT(*)::int AS acquisitions,
              COALESCE(SUM(f.land_size_bigha),0)::numeric AS total_land,
              COALESCE(SUM(f.total_amount),0)::numeric AS agreed_value,
              COALESCE(SUM(pay.total_paid),0)::numeric AS paid,
              COALESCE(SUM(f.total_amount-pay.total_paid),0)::numeric AS outstanding,
              MIN(next_due.due_date) AS next_due
         FROM farmers f JOIN sites s ON s.id=f.site_id
         LEFT JOIN members m ON m.id=f.member_id AND m.site_id=f.site_id
         LEFT JOIN LATERAL (SELECT COALESCE(SUM(fp.amount) FILTER (WHERE ${POSTED_PAYMENT}),0)::numeric AS total_paid FROM farmer_payments fp WHERE fp.farmer_id=f.id) pay ON TRUE
         LEFT JOIN LATERAL (SELECT MIN(ps.due_date) AS due_date FROM land_acquisition_payment_schedules ps WHERE ps.acquisition_id=f.id AND ps.superseded_at IS NULL AND ps.due_date>=CURRENT_DATE) next_due ON TRUE
        WHERE f.site_id=$1 AND s.organization_id=$2
        GROUP BY f.member_id,COALESCE(m.full_name,f.name)
        ORDER BY outstanding DESC`, params,
    ),
    pool.query(
      `SELECT COALESCE(NULLIF(BTRIM(f.village),''),'Not recorded') AS village,
              COUNT(*)::int AS acquisitions,COALESCE(SUM(f.land_size_bigha),0)::numeric AS total_land,
              COALESCE(SUM(f.total_amount),0)::numeric AS agreed_value
         FROM farmers f JOIN sites s ON s.id=f.site_id
        WHERE f.site_id=$1 AND s.organization_id=$2 GROUP BY 1 ORDER BY total_land DESC`, params,
    ),
    pool.query(
      `SELECT CASE WHEN UPPER(fp.payment_mode)='SPLIT' THEN 'SPLIT'
                   WHEN ledger_bucket(fp.payment_mode)='cash' THEN 'CASH' ELSE 'BANK' END AS mode,
              COALESCE(SUM(fp.amount),0)::numeric AS total,COUNT(*)::int AS transactions
         FROM farmer_payments fp JOIN farmers f ON f.id=fp.farmer_id
         JOIN sites s ON s.id=f.site_id
        WHERE f.site_id=$1 AND s.organization_id=$2 AND ${POSTED_PAYMENT}
        GROUP BY 1 ORDER BY 1`, params,
    ),
    pool.query(
      `SELECT COALESCE(a.agreement_status,'NOT_STARTED') AS status,COUNT(*)::int AS acquisitions
         FROM farmers f JOIN sites s ON s.id=f.site_id
         LEFT JOIN LATERAL (SELECT agreement_status FROM land_acquisition_agreements x WHERE x.acquisition_id=f.id ORDER BY revision_number DESC LIMIT 1) a ON TRUE
        WHERE f.site_id=$1 AND s.organization_id=$2 GROUP BY 1 ORDER BY 1`, params,
    ),
    pool.query(
      `SELECT f.id,f.acquisition_reference,COALESCE(m.full_name,f.name) AS landowner_name,
              ps.description,ps.due_date,ps.expected_amount,
              COALESCE(SUM(pa.allocated_amount) FILTER (WHERE ${POSTED_PAYMENT}),0)::numeric AS amount_paid
         FROM land_acquisition_payment_schedules ps
         JOIN farmers f ON f.id=ps.acquisition_id AND f.site_id=$1
         JOIN sites s ON s.id=f.site_id AND s.organization_id=$2
         LEFT JOIN members m ON m.id=f.member_id AND m.site_id=f.site_id
         LEFT JOIN land_acquisition_payment_allocations pa ON pa.schedule_item_id=ps.id
         LEFT JOIN farmer_payments fp ON fp.id=pa.farmer_payment_id
        WHERE ps.superseded_at IS NULL AND ps.due_date IS NOT NULL
        GROUP BY f.id,m.full_name,ps.id
       HAVING ps.expected_amount > COALESCE(SUM(pa.allocated_amount) FILTER (WHERE ${POSTED_PAYMENT}),0)
        ORDER BY ps.due_date ASC LIMIT 100`, params,
    ),
  ]);
  const paid = landowners.rows.reduce((sum, row) => sum + toNumber(row.paid), 0);
  const outstanding = landowners.rows.reduce((sum, row) => sum + toNumber(row.outstanding), 0);
  res.json({
    summary: { ...summaryRows.rows[0], paid, outstanding },
    landowner_outstanding: landowners.rows,
    village_summary: villages.rows,
    cash_vs_bank: modes.rows,
    agreement_status: agreements.rows,
    payment_due: due.rows.map((row) => ({ ...row, outstanding: Math.max(toNumber(row.expected_amount) - toNumber(row.amount_paid), 0) })),
  });
});

export const getLandownerAcquisitionSummary = asyncHandler(async (req, res) => {
  const memberId = parsePositiveId(req.params.memberId);
  const { siteId, organizationId } = scope(req);
  const { rows } = await pool.query(
    `${baseSelect} WHERE f.site_id=$1 AND s.organization_id=$2 AND f.member_id=$3
      ORDER BY f.created_at DESC,f.id DESC`,
    [siteId, organizationId, memberId],
  );
  if (!rows.length) return res.status(404).json({ message: 'No acquisitions found for this landowner at the selected Site' });
  const acquisitions = rows.map(presentAcquisition);
  res.json({
    landowner: {
      id: memberId,
      name: acquisitions[0].landowner_name,
      phone: acquisitions[0].landowner_phone,
      acquisitions: acquisitions.length,
      total_land: acquisitions.reduce((sum, item) => sum + toNumber(item.land_size_bigha), 0),
      total_consideration: acquisitions.reduce((sum, item) => sum + item.total_amount, 0),
      paid: acquisitions.reduce((sum, item) => sum + item.total_paid, 0),
      outstanding: acquisitions.reduce((sum, item) => sum + item.outstanding, 0),
    },
    acquisitions,
  });
});

export const requireAdminForReopen = (req, res, next) => {
  if (!isOrgAdmin(req.user)) return res.status(403).json({ message: 'Only administrators can reopen a completed acquisition' });
  return next();
};
