import crypto from 'crypto';
import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import permissionModel from '../models/Permission.model.js';
import {
  addComplianceSiteScope, assertComplianceSiteAccess, getScopedComplianceEntity,
  isOrgAdmin, parsePositiveId, writeComplianceAudit,
} from '../utils/complianceAccess.js';
import {
  buildOccurrences, COMPLIANCE_STATUSES, DEFAULT_TRANSITIONS, isTransitionAllowed, parseDate,
} from '../services/complianceEngine.service.js';

const RISK_LEVELS = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const PRIORITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const TERMINAL_STATUSES = new Set(['COMPLETED', 'NOT_APPLICABLE', 'CANCELLED']);
const NOTICE_TRANSITIONS = Object.freeze({
  RECEIVED: ['ASSIGNED', 'CLOSED'],
  ASSIGNED: ['UNDER_REVIEW', 'CLOSED'],
  UNDER_REVIEW: ['REPLY_DRAFTING', 'CLOSED'],
  REPLY_DRAFTING: ['UNDER_REVIEW', 'APPROVAL_PENDING'],
  APPROVAL_PENDING: ['REPLY_DRAFTING', 'REPLY_SUBMITTED'],
  REPLY_SUBMITTED: ['CLOSED'],
  CLOSED: [],
});
const NOTICE_STATUSES = new Set(Object.keys(NOTICE_TRANSITIONS));
const ENTITY_CONFIG = Object.freeze({
  licence: {
    table: 'compliance_licences', permission: 'compliance', label: 'LICENCE',
    required: ['name'], listOrder: 'COALESCE(e.expiry_date, DATE \'9999-12-31\') ASC, e.id DESC',
    fields: ['site_id', 'authority_id', 'compliance_item_id', 'name', 'licence_type', 'licence_number',
      'issue_date', 'effective_date', 'expiry_date', 'renewal_application_date', 'renewal_status',
      'renewal_cost', 'security_deposit', 'conditions', 'responsible_person_id',
      'verification_status', 'reminder_days', 'notes', 'metadata'],
  },
  case: {
    table: 'legal_cases', permission: 'legal', label: 'LEGAL_CASE',
    required: ['title'], listOrder: 'COALESCE(e.next_hearing_date, TIMESTAMPTZ \'9999-12-31\') ASC, e.id DESC',
    fields: ['site_id', 'title', 'case_type', 'court_authority', 'case_number', 'filing_number',
      'case_year', 'opposite_party', 'party_type', 'advocate', 'internal_owner_id', 'summary',
      'claim_amount', 'financial_exposure', 'risk_level', 'stage', 'next_hearing_date',
      'last_hearing_date', 'filing_date', 'limitation_date', 'status', 'related_entities',
      'notes', 'confidentiality'],
  },
  notice: {
    table: 'legal_notices', permission: 'legal', label: 'LEGAL_NOTICE',
    required: ['subject'], listOrder: 'COALESCE(e.reply_due_date, DATE \'9999-12-31\') ASC, e.id DESC',
    fields: ['site_id', 'authority_id', 'legal_case_id', 'notice_number', 'notice_type', 'direction',
      'sender', 'recipient', 'date_received', 'notice_date', 'reply_due_date',
      'responsible_person_id', 'reviewing_manager_id', 'advocate', 'risk_level', 'status',
      'subject', 'summary', 'amount_involved', 'draft_reply', 'final_reply', 'submission_proof',
      'dispatch_details', 'courier_tracking', 'related_entities', 'notes'],
  },
  inspection: {
    table: 'compliance_inspections', permission: 'compliance', label: 'INSPECTION',
    required: ['inspection_type', 'scheduled_at'], listOrder: 'e.scheduled_at ASC, e.id DESC',
    fields: ['site_id', 'authority_id', 'compliance_item_id', 'legal_case_id', 'inspection_type',
      'scheduled_at', 'location', 'meeting_mode', 'meeting_link', 'responsible_person_id',
      'attendees', 'preparation_checklist', 'required_documents', 'findings',
      'non_conformities', 'corrective_actions', 'follow_up_date', 'status'],
  },
});

const upper = (value, fallback = null) => value === undefined || value === null || value === ''
  ? fallback
  : String(value).trim().toUpperCase().replace(/\s+/g, '_');
const text = (value, max = 5000) => value === undefined
  ? undefined
  : (value === null || value === '' ? null : String(value).trim().slice(0, max));
const jsonObject = (value, fallback = {}) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value : fallback
);
const jsonArray = (value, fallback = []) => (Array.isArray(value) ? value : fallback);
const boundedPage = (req) => ({
  page: Math.max(Number.parseInt(req.query.page, 10) || 1, 1),
  limit: Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 25, 1), 100),
});
const codeFor = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
const normalizeIntArray = (value, fallback = []) => {
  if (value === undefined || value === null) return [...fallback];
  const source = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(source.map((v) => Number.parseInt(v, 10)).filter((v) => Number.isInteger(v) && v >= 0 && v <= 3650))]
    .sort((a, b) => b - a)
    .slice(0, 24);
};
const storedDate = (value) => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = parseDate(value);
  if (!parsed) throw Object.assign(new Error('Invalid date. Use YYYY-MM-DD.'), { statusCode: 400 });
  return parsed.toISOString().slice(0, 10);
};
const requireReason = (value) => {
  const reason = text(value, 2000);
  if (!reason) throw Object.assign(new Error('A reason is required'), { statusCode: 400 });
  return reason;
};

async function settingsFor(orgId, db = pool) {
  const { rows } = await db.query(
    `SELECT * FROM compliance_settings WHERE organization_id = $1`,
    [orgId]
  );
  return rows[0] || {
    organization_id: orgId,
    timezone: 'Asia/Kolkata',
    due_date_change_requires_approval: true,
    completion_requires_approval: false,
    notification_channels: ['DASHBOARD', 'EMAIL'],
    default_reminder_days: [30, 15, 7, 1, 0],
    overdue_escalation_days: [1, 3, 7, 14],
    legal_case_stages: ['PRE_LITIGATION','NOTICE_ISSUED','REPLY_SUBMITTED','CASE_FILED','ADMISSION','EVIDENCE','ARGUMENTS','ORDER_RESERVED','JUDGEMENT','APPEAL','EXECUTION','SETTLED','CLOSED'],
    notice_status_transitions: NOTICE_TRANSITIONS,
    status_transitions: DEFAULT_TRANSITIONS,
  };
}

async function hasModuleRead(req, module) {
  if (isOrgAdmin(req.user)) return true;
  const permission = await permissionModel.getPermission(req.user.id, module);
  return permission?.can_read === true;
}

async function accessibleUser(req, userId, siteId, db = pool) {
  if (!userId) return null;
  const params = [userId, req.user.organization_id];
  let scope = '';
  if (siteId) {
    params.push(siteId);
    scope = ` AND (u.role IN ('admin','super_admin') OR EXISTS (
      SELECT 1 FROM user_sites us WHERE us.user_id = u.id AND us.site_id = $3
    ))`;
  }
  const { rows } = await db.query(
    `SELECT u.id FROM users u
      WHERE u.id = $1 AND u.organization_id = $2 AND u.is_active = TRUE ${scope}
      LIMIT 1`,
    params
  );
  return rows[0]?.id || null;
}

function cleanCompliancePayload(body, { partial = false } = {}) {
  const result = {};
  const stringFields = [
    'title', 'description', 'category', 'subcategory', 'compliance_type', 'state', 'district',
    'department', 'applicable_law', 'section_reference', 'frequency', 'external_consultant',
    'penalty_details', 'notes', 'confidentiality',
  ];
  for (const field of stringFields) {
    if (body[field] !== undefined) result[field] = text(body[field], field === 'title' ? 300 : 10000);
  }
  if (!partial && !result.title) throw Object.assign(new Error('Title is required'), { statusCode: 400 });
  if (body.original_due_date !== undefined) result.original_due_date = storedDate(body.original_due_date);
  if (body.current_due_date !== undefined) result.current_due_date = storedDate(body.current_due_date);
  if (body.next_due_date !== undefined) result.next_due_date = storedDate(body.next_due_date);
  if (body.last_completed_date !== undefined) result.last_completed_date = storedDate(body.last_completed_date);
  if (body.grace_period_days !== undefined) result.grace_period_days = Math.min(Math.max(Number.parseInt(body.grace_period_days, 10) || 0, 0), 3650);
  if (body.reminder_days !== undefined) result.reminder_days = normalizeIntArray(body.reminder_days);
  if (body.priority !== undefined) result.priority = PRIORITIES.has(upper(body.priority)) ? upper(body.priority) : 'MEDIUM';
  if (body.risk_level !== undefined) result.risk_level = RISK_LEVELS.has(upper(body.risk_level)) ? upper(body.risk_level) : 'MEDIUM';
  if (body.financial_impact !== undefined) result.financial_impact = Math.max(Number(body.financial_impact) || 0, 0);
  if (body.completion_percentage !== undefined) result.completion_percentage = Math.min(Math.max(Number.parseInt(body.completion_percentage, 10) || 0, 0), 100);
  if (body.tags !== undefined) result.tags = jsonArray(body.tags);
  if (body.related_entities !== undefined) result.related_entities = jsonObject(body.related_entities);
  if (body.metadata !== undefined) result.metadata = jsonObject(body.metadata);
  if (body.approval_required !== undefined) result.approval_required = Boolean(body.approval_required);
  return result;
}

function sqlUpdate(payload, startAt = 1) {
  const fields = Object.keys(payload);
  const values = Object.values(payload);
  return {
    fields,
    values,
    set: fields.map((field, index) => `${field} = $${startAt + index}`).join(', '),
  };
}

/** Dashboard analytics and priority queues. */
export const complianceDashboard = asyncHandler(async (req, res) => {
  const orgId = req.user.organization_id;
  const canViewLegal = await hasModuleRead(req, 'legal');
  const params = [orgId];
  let scope = addComplianceSiteScope(req, 'i', params);
  const requestedSite = req.query.site_id ? await assertComplianceSiteAccess(req, res, req.query.site_id) : null;
  if (requestedSite === false) return;
  let requestedSiteParam = null;
  if (requestedSite) {
    params.push(requestedSite);
    requestedSiteParam = params.length;
    scope += ` AND i.site_id = $${requestedSiteParam}`;
  }

  const relatedParams = [...params];
  const dashboardFilters = [
    ['state', 'i.state', (value) => text(value, 120)],
    ['category', 'i.category', (value) => upper(value)],
    ['status', 'i.status', (value) => upper(value)],
    ['risk', 'i.risk_level', (value) => upper(value)],
    ['authority_id', 'i.authority_id', (value) => parsePositiveId(value)],
    ['responsible_user_id', 'i.assigned_to', (value) => parsePositiveId(value)],
  ];
  for (const [queryKey, column, transform] of dashboardFilters) {
    if (req.query[queryKey]) {
      const value = transform(req.query[queryKey]);
      if (value === null) return res.status(400).json({ message: `Invalid ${queryKey}` });
      params.push(value);
      scope += ` AND ${column}=$${params.length}`;
    }
  }
  if (req.query.from) {
    params.push(storedDate(req.query.from));
    scope += ` AND i.current_due_date >= $${params.length}`;
  }
  if (req.query.to) {
    params.push(storedDate(req.query.to));
    scope += ` AND i.current_due_date <= $${params.length}`;
  }
  const base = `i.organization_id = $1 AND i.deleted_at IS NULL ${scope}`;
  const relatedScope = (alias) => [
    isOrgAdmin(req.user) ? '' : `AND ${alias}.site_id IN (SELECT site_id FROM user_sites WHERE user_id=$2)`,
    requestedSiteParam ? `AND ${alias}.site_id=$${requestedSiteParam}` : '',
  ].filter(Boolean).join(' ');
  const documentTypeScope = canViewLegal ? '' : `AND d.entity_type NOT IN ('LEGAL_CASE','LEGAL_NOTICE')`;
  const [summary, status, risk, site, authority, monthly, legal, licences, notices, priority, employee, legalStage, expiryTimeline] = await Promise.all([
    pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE i.status NOT IN ('COMPLETED','CANCELLED','NOT_APPLICABLE'))::int AS active,
        COUNT(*) FILTER (WHERE i.current_due_date = CURRENT_DATE AND i.status NOT IN ('COMPLETED','CANCELLED','NOT_APPLICABLE'))::int AS due_today,
        COUNT(*) FILTER (WHERE i.current_due_date > CURRENT_DATE AND i.current_due_date <= CURRENT_DATE + 7 AND i.status NOT IN ('COMPLETED','CANCELLED','NOT_APPLICABLE'))::int AS due_7,
        COUNT(*) FILTER (WHERE i.current_due_date > CURRENT_DATE AND i.current_due_date <= CURRENT_DATE + 30 AND i.status NOT IN ('COMPLETED','CANCELLED','NOT_APPLICABLE'))::int AS due_30,
        COUNT(*) FILTER (WHERE i.current_due_date < CURRENT_DATE AND i.status NOT IN ('COMPLETED','CANCELLED','NOT_APPLICABLE'))::int AS overdue,
        COUNT(*) FILTER (WHERE i.status = 'COMPLETED' AND i.last_completed_date >= date_trunc('month', CURRENT_DATE))::int AS completed_month,
        COUNT(*) FILTER (WHERE i.risk_level IN ('HIGH','CRITICAL') AND i.status NOT IN ('COMPLETED','CANCELLED','NOT_APPLICABLE'))::int AS high_risk,
        COUNT(*) FILTER (WHERE i.assigned_to IS NULL AND i.status NOT IN ('COMPLETED','CANCELLED','NOT_APPLICABLE'))::int AS unassigned
       FROM compliance_items i WHERE ${base}`,
      params
    ),
    pool.query(`SELECT i.status AS label, COUNT(*)::int AS value FROM compliance_items i WHERE ${base} GROUP BY i.status ORDER BY value DESC`, params),
    pool.query(`SELECT i.risk_level AS label, COUNT(*)::int AS value FROM compliance_items i WHERE ${base} GROUP BY i.risk_level`, params),
    pool.query(`SELECT COALESCE(s.name,'Organisation-wide') AS label, COUNT(*)::int AS value FROM compliance_items i LEFT JOIN sites s ON s.id=i.site_id WHERE ${base} GROUP BY s.name ORDER BY value DESC LIMIT 12`, params),
    pool.query(`SELECT COALESCE(a.name,i.department,'Unspecified') AS label, COUNT(*)::int AS value FROM compliance_items i LEFT JOIN compliance_authorities a ON a.id=i.authority_id WHERE ${base} GROUP BY COALESCE(a.name,i.department,'Unspecified') ORDER BY value DESC LIMIT 12`, params),
    pool.query(
      `SELECT to_char(month, 'YYYY-MM') AS month,
              COUNT(i.id) FILTER (WHERE i.current_due_date >= month AND i.current_due_date < month + INTERVAL '1 month')::int AS due,
              COUNT(i.id) FILTER (WHERE i.last_completed_date >= month AND i.last_completed_date < month + INTERVAL '1 month')::int AS completed
         FROM generate_series(date_trunc('month', CURRENT_DATE) - INTERVAL '5 months', date_trunc('month', CURRENT_DATE) + INTERVAL '6 months', INTERVAL '1 month') month
         LEFT JOIN compliance_items i ON ${base.replace('$1', '$1')}
          AND ((i.current_due_date >= month AND i.current_due_date < month + INTERVAL '1 month')
            OR (i.last_completed_date >= month AND i.last_completed_date < month + INTERVAL '1 month'))
        GROUP BY month ORDER BY month`,
      params
    ),
    canViewLegal ? pool.query(
      `SELECT COUNT(*) FILTER (WHERE c.status NOT IN ('CLOSED','SETTLED'))::int AS open_cases,
              COUNT(*) FILTER (WHERE c.next_hearing_date >= NOW() AND c.next_hearing_date < NOW() + INTERVAL '30 days')::int AS hearings_30,
              COALESCE(SUM(c.financial_exposure) FILTER (WHERE c.status NOT IN ('CLOSED','SETTLED')),0) AS exposure
        FROM legal_cases c
        WHERE c.organization_id=$1 AND c.deleted_at IS NULL
          ${relatedScope('c')}`,
      relatedParams
    ) : Promise.resolve({ rows: [{ open_cases: 0, hearings_30: 0, exposure: 0 }] }),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE l.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 90)::int AS expiring_90,
              COUNT(*) FILTER (WHERE l.expiry_date < CURRENT_DATE)::int AS expired
        FROM compliance_licences l
        WHERE l.organization_id=$1 AND l.deleted_at IS NULL
          ${relatedScope('l')}`,
      relatedParams
    ),
    canViewLegal ? pool.query(
      `SELECT COUNT(*) FILTER (WHERE n.status NOT IN ('CLOSED','REPLY_SUBMITTED'))::int AS pending_notices,
              COUNT(*) FILTER (WHERE n.reply_due_date < CURRENT_DATE AND n.status NOT IN ('CLOSED','REPLY_SUBMITTED'))::int AS overdue_replies
        FROM legal_notices n
        WHERE n.organization_id=$1 AND n.deleted_at IS NULL
          ${relatedScope('n')}`,
      relatedParams
    ) : Promise.resolve({ rows: [{ pending_notices: 0, overdue_replies: 0 }] }),
    pool.query(
      `SELECT i.id,i.compliance_code,i.title,i.status,i.risk_level,i.priority,i.current_due_date,
              i.financial_impact,i.assigned_to,u.name AS assigned_to_name,s.name AS site_name,a.name AS authority_name,
              (i.current_due_date - CURRENT_DATE)::int AS days_remaining
         FROM compliance_items i
         LEFT JOIN users u ON u.id=i.assigned_to
         LEFT JOIN sites s ON s.id=i.site_id
         LEFT JOIN compliance_authorities a ON a.id=i.authority_id
        WHERE ${base}
          AND i.status NOT IN ('COMPLETED','CANCELLED','NOT_APPLICABLE')
        ORDER BY
          CASE i.risk_level WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
          i.current_due_date NULLS LAST
        LIMIT 12`,
      params
    ),
    pool.query(
      `SELECT COALESCE(u.name,'Unassigned') AS label,COUNT(*)::int AS value
         FROM compliance_items i
         LEFT JOIN users u ON u.id=i.assigned_to AND u.organization_id=i.organization_id
        WHERE ${base}
        GROUP BY COALESCE(u.name,'Unassigned')
        ORDER BY value DESC LIMIT 10`,
      params
    ),
    canViewLegal ? pool.query(
      `SELECT COALESCE(c.stage,'UNSPECIFIED') AS label,COUNT(*)::int AS value
         FROM legal_cases c
        WHERE c.organization_id=$1 AND c.deleted_at IS NULL ${relatedScope('c')}
        GROUP BY COALESCE(c.stage,'UNSPECIFIED')
        ORDER BY value DESC`,
      relatedParams
    ) : Promise.resolve({ rows: [] }),
    pool.query(
      `SELECT to_char(expiry_month,'YYYY-MM') AS month,COUNT(*)::int AS value
         FROM (
           SELECT date_trunc('month',l.expiry_date)::date AS expiry_month
             FROM compliance_licences l
            WHERE l.organization_id=$1 AND l.deleted_at IS NULL
              AND l.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE+INTERVAL '12 months'
              ${relatedScope('l')}
           UNION ALL
           SELECT date_trunc('month',d.expiry_date)::date AS expiry_month
             FROM compliance_documents d
           WHERE d.organization_id=$1 AND d.deleted_at IS NULL
              AND d.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE+INTERVAL '12 months'
              ${documentTypeScope}
              ${relatedScope('d')}
         ) expiries
        GROUP BY expiry_month ORDER BY expiry_month`,
      relatedParams
    ),
  ]);

  res.json({
    summary: {
      ...summary.rows[0],
      open_legal_cases: legal.rows[0]?.open_cases || 0,
      pending_notices: notices.rows[0]?.pending_notices || 0,
      expiring_approvals: licences.rows[0]?.expiring_90 || 0,
    },
    charts: {
      status: status.rows, risk: risk.rows, sites: site.rows,
      authorities: authority.rows, monthly: monthly.rows,
      employees: employee.rows, legal_stages: legalStage.rows, expiry_timeline: expiryTimeline.rows,
    },
    legal: legal.rows[0], licences: licences.rows[0], notices: notices.rows[0],
    priority: priority.rows,
  });
});

/** Paginated central compliance register. */
export const listComplianceItems = asyncHandler(async (req, res) => {
  const { page, limit } = boundedPage(req);
  const params = [req.user.organization_id];
  const where = ['i.organization_id = $1', 'i.deleted_at IS NULL'];
  const siteScope = addComplianceSiteScope(req, 'i', params);
  if (siteScope) where.push(siteScope.replace(/^\s*AND\s*/, ''));

  if (req.query.site_id) {
    const siteId = await assertComplianceSiteAccess(req, res, req.query.site_id);
    if (siteId === false) return;
    params.push(siteId); where.push(`i.site_id = $${params.length}`);
  }
  for (const [key, column] of [['status', 'status'], ['risk', 'risk_level'], ['category', 'category'], ['type', 'compliance_type'], ['assigned_to', 'assigned_to'], ['authority_id', 'authority_id']]) {
    if (req.query[key]) { params.push(req.query[key]); where.push(`i.${column} = $${params.length}`); }
  }
  if (req.query.from) { params.push(storedDate(req.query.from)); where.push(`i.current_due_date >= $${params.length}`); }
  if (req.query.to) { params.push(storedDate(req.query.to)); where.push(`i.current_due_date <= $${params.length}`); }
  if (req.query.overdue === 'true') where.push(`i.current_due_date < CURRENT_DATE AND i.status NOT IN ('COMPLETED','CANCELLED','NOT_APPLICABLE')`);
  if (req.query.q) {
    params.push(`%${String(req.query.q).trim().slice(0, 100).replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(i.title ILIKE $${params.length} ESCAPE '\\' OR i.compliance_code ILIKE $${params.length} ESCAPE '\\' OR i.description ILIKE $${params.length} ESCAPE '\\')`);
  }
  const clause = where.join(' AND ');
  const count = await pool.query(`SELECT COUNT(*)::int AS total FROM compliance_items i WHERE ${clause}`, params);
  params.push(limit, (page - 1) * limit);
  const { rows } = await pool.query(
    `SELECT i.*,s.name AS site_name,a.name AS authority_name,u.name AS assigned_to_name,
            rv.name AS reviewer_name,ap.name AS approver_name,
            (i.current_due_date - CURRENT_DATE)::int AS days_remaining,
            COUNT(*) OVER()::int AS total_count
       FROM compliance_items i
       LEFT JOIN sites s ON s.id=i.site_id
       LEFT JOIN compliance_authorities a ON a.id=i.authority_id
       LEFT JOIN users u ON u.id=i.assigned_to
       LEFT JOIN users rv ON rv.id=i.reviewing_manager_id
       LEFT JOIN users ap ON ap.id=i.approving_authority_id
      WHERE ${clause}
      ORDER BY
        CASE WHEN i.current_due_date < CURRENT_DATE AND i.status NOT IN ('COMPLETED','CANCELLED','NOT_APPLICABLE') THEN 0 ELSE 1 END,
        i.current_due_date NULLS LAST, i.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ items: rows.map(({ total_count: _total, ...row }) => row), pagination: { page, limit, total: count.rows[0].total, pages: Math.ceil(count.rows[0].total / limit) } });
});

export const getComplianceItem = asyncHandler(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid compliance item ID' });
  const item = await getScopedComplianceEntity(req, 'compliance_items', id);
  if (!item) return res.status(404).json({ message: 'Compliance item not found' });
  const [checklist, history, dateChanges, approvals, documents, people, financeLinks] = await Promise.all([
    pool.query(`SELECT c.*,u.name AS assigned_to_name,done.name AS completed_by_name FROM compliance_checklist_items c LEFT JOIN users u ON u.id=c.assigned_to LEFT JOIN users done ON done.id=c.completed_by WHERE c.organization_id=$1 AND c.compliance_item_id=$2 ORDER BY c.sequence,c.id`, [req.user.organization_id, id]),
    pool.query(`SELECT h.*,u.name AS changed_by_name FROM compliance_status_history h LEFT JOIN users u ON u.id=h.changed_by WHERE h.organization_id=$1 AND h.compliance_item_id=$2 ORDER BY h.changed_at DESC LIMIT 200`, [req.user.organization_id, id]),
    pool.query(`SELECT d.*,r.name AS requested_by_name,v.name AS reviewed_by_name FROM compliance_due_date_changes d LEFT JOIN users r ON r.id=d.requested_by LEFT JOIN users v ON v.id=d.reviewed_by WHERE d.organization_id=$1 AND d.compliance_item_id=$2 ORDER BY d.requested_at DESC`, [req.user.organization_id, id]),
    pool.query(`SELECT a.*,r.name AS requested_by_name,v.name AS reviewed_by_name FROM compliance_approvals a LEFT JOIN users r ON r.id=a.requested_by LEFT JOIN users v ON v.id=a.reviewed_by WHERE a.organization_id=$1 AND a.compliance_item_id=$2 ORDER BY a.requested_at DESC`, [req.user.organization_id, id]),
    pool.query(`SELECT id,category,title,original_name,mime_type,file_size,version_no,tags,verification_status,approval_status,confidentiality,issue_date,expiry_date,issuing_authority,uploaded_by,created_at FROM compliance_documents WHERE organization_id=$1 AND entity_type='COMPLIANCE' AND entity_id=$2 AND deleted_at IS NULL ${isOrgAdmin(req.user) ? '' : `AND confidentiality <> 'RESTRICTED'`} ORDER BY created_at DESC`, [req.user.organization_id, id]),
    pool.query(
      `SELECT assigned.name AS assigned_to_name,reviewer.name AS reviewer_name,approver.name AS approver_name,
              s.name AS site_name,a.name AS authority_name
         FROM compliance_items i
         LEFT JOIN users assigned ON assigned.id=i.assigned_to AND assigned.organization_id=i.organization_id
         LEFT JOIN users reviewer ON reviewer.id=i.reviewing_manager_id AND reviewer.organization_id=i.organization_id
         LEFT JOIN users approver ON approver.id=i.approving_authority_id AND approver.organization_id=i.organization_id
         LEFT JOIN sites s ON s.id=i.site_id AND s.organization_id=i.organization_id
         LEFT JOIN compliance_authorities a ON a.id=i.authority_id AND a.organization_id=i.organization_id
        WHERE i.id=$1 AND i.organization_id=$2`,
      [id, req.user.organization_id]
    ),
    pool.query(
      `SELECT l.id,l.expense_id,l.cost_type,l.notes,l.created_at,
              e.date,e.debit,e.credit,e.remark,e.category,u.name AS linked_by_name
         FROM compliance_finance_links l
         JOIN expenses e ON e.id=l.expense_id AND e.site_id=l.site_id
         LEFT JOIN users u ON u.id=l.linked_by AND u.organization_id=l.organization_id
        WHERE l.organization_id=$1 AND l.compliance_item_id=$2
        ORDER BY l.created_at DESC`,
      [req.user.organization_id, id]
    ),
  ]);
  res.json({ item: { ...item, ...(people.rows[0] || {}) }, checklist: checklist.rows, history: history.rows, due_date_changes: dateChanges.rows, approvals: approvals.rows, documents: documents.rows, finance_links: financeLinks.rows });
});

export const createComplianceItem = asyncHandler(async (req, res) => {
  const orgId = req.user.organization_id;
  const siteId = await assertComplianceSiteAccess(req, res, req.body.site_id);
  if (siteId === false) return;
  if (!isOrgAdmin(req.user) && !siteId) return res.status(400).json({ message: 'Sub-admin compliance items must be assigned to a site' });
  const payload = cleanCompliancePayload(req.body);
  const configured = await settingsFor(orgId);
  if (payload.reminder_days === undefined) payload.reminder_days = configured.default_reminder_days;
  if (payload.original_due_date === undefined) payload.original_due_date = payload.current_due_date || null;
  if (payload.current_due_date === undefined) payload.current_due_date = payload.original_due_date || null;

  for (const field of ['assigned_to', 'reviewing_manager_id', 'approving_authority_id']) {
    if (req.body[field] !== undefined) {
      const valid = await accessibleUser(req, parsePositiveId(req.body[field]), siteId);
      if (req.body[field] && !valid) return res.status(400).json({ message: `Invalid ${field.replaceAll('_', ' ')}` });
      payload[field] = valid;
    }
  }
  if (req.body.authority_id !== undefined) payload.authority_id = await assertOwnedReference(req, 'authority_id', parsePositiveId(req.body.authority_id));
  if (req.body.template_id !== undefined) payload.template_id = await assertOwnedReference(req, 'template_id', parsePositiveId(req.body.template_id));
  payload.site_id = siteId;
  payload.organization_id = orgId;
  payload.compliance_code = text(req.body.compliance_code, 60) || codeFor('CMP');
  payload.created_by = req.user.id;
  payload.updated_by = req.user.id;

  const checklist = jsonArray(req.body.checklist);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fields = Object.keys(payload);
    const values = Object.values(payload);
    const { rows } = await client.query(
      `INSERT INTO compliance_items (${fields.join(',')})
       VALUES (${fields.map((_, index) => `$${index + 1}`).join(',')})
       RETURNING *`,
      values
    );
    const item = rows[0];
    for (let index = 0; index < checklist.length; index += 1) {
      const row = checklist[index];
      if (!text(row.title, 300)) continue;
      const checklistAssignee = row.assigned_to
        ? await accessibleUser(req, parsePositiveId(row.assigned_to), siteId, client)
        : null;
      if (row.assigned_to && !checklistAssignee) {
        throw Object.assign(new Error('Invalid checklist assignee'), { statusCode: 400 });
      }
      await client.query(
        `INSERT INTO compliance_checklist_items
          (organization_id,compliance_item_id,title,description,is_mandatory,assigned_to,due_date,required_document_type,sequence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [orgId, item.id, text(row.title, 300), text(row.description), Boolean(row.is_mandatory),
          checklistAssignee, storedDate(row.due_date), text(row.required_document_type, 120), index]
      );
    }
    await client.query(
      `INSERT INTO compliance_status_history
        (organization_id,compliance_item_id,previous_status,new_status,changed_by,comment)
       VALUES ($1,$2,NULL,$3,$4,$5)`,
      [orgId, item.id, item.status, req.user.id, 'Compliance item created']
    );
    await writeComplianceAudit(client, req, { action: 'CREATE', entityType: 'COMPLIANCE', entityId: item.id, siteId, newValue: item });
    await client.query('COMMIT');
    res.status(201).json({ item });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ message: 'Compliance code already exists' });
    throw error;
  } finally {
    client.release();
  }
});

export const updateComplianceItem = asyncHandler(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  const existing = id ? await getScopedComplianceEntity(req, 'compliance_items', id) : null;
  if (!existing) return res.status(404).json({ message: 'Compliance item not found' });
  const payload = cleanCompliancePayload(req.body, { partial: true });
  delete payload.current_due_date; // legally significant; use reschedule endpoint
  delete payload.status; // use status endpoint
  let siteId = existing.site_id;
  if (req.body.site_id !== undefined) {
    siteId = await assertComplianceSiteAccess(req, res, req.body.site_id);
    if (siteId === false) return;
    payload.site_id = siteId;
    for (const field of ['assigned_to', 'reviewing_manager_id', 'approving_authority_id']) {
      if (existing[field] && req.body[field] === undefined) {
        const stillValid = await accessibleUser(req, existing[field], siteId);
        if (!stillValid) return res.status(409).json({ message: `Reassign ${field.replaceAll('_', ' ')} before changing the site` });
      }
    }
  }
  for (const field of ['assigned_to', 'reviewing_manager_id', 'approving_authority_id']) {
    if (req.body[field] !== undefined) {
      const valid = await accessibleUser(req, parsePositiveId(req.body[field]), siteId);
      if (req.body[field] && !valid) return res.status(400).json({ message: `Invalid ${field.replaceAll('_', ' ')}` });
      payload[field] = valid;
    }
  }
  for (const field of ['authority_id', 'template_id']) {
    if (req.body[field] !== undefined) payload[field] = await assertOwnedReference(req, field, parsePositiveId(req.body[field]));
  }
  if (req.body.risk_level !== undefined && upper(req.body.risk_level) !== existing.risk_level) {
    payload.risk_override_reason = requireReason(req.body.risk_override_reason);
  }
  if (!Object.keys(payload).length) return res.status(400).json({ message: 'Nothing to update' });
  payload.updated_by = req.user.id;
  const update = sqlUpdate(payload);
  const { rows } = await pool.query(
    `UPDATE compliance_items SET ${update.set},updated_at=NOW()
      WHERE id=$${update.values.length + 1} AND organization_id=$${update.values.length + 2}
      RETURNING *`,
    [...update.values, id, req.user.organization_id]
  );
  await writeComplianceAudit(pool, req, { action: 'UPDATE', entityType: 'COMPLIANCE', entityId: id, siteId, previousValue: existing, newValue: rows[0], reason: req.body.reason });
  res.json({ item: rows[0] });
});

export const deleteComplianceItem = asyncHandler(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  const existing = id ? await getScopedComplianceEntity(req, 'compliance_items', id) : null;
  if (!existing) return res.status(404).json({ message: 'Compliance item not found' });
  const reason = requireReason(req.body.reason);
  await pool.query(`UPDATE compliance_items SET deleted_at=NOW(),updated_by=$1,updated_at=NOW() WHERE id=$2 AND organization_id=$3`, [req.user.id, id, req.user.organization_id]);
  await writeComplianceAudit(pool, req, { action: 'DELETE', entityType: 'COMPLIANCE', entityId: id, siteId: existing.site_id, previousValue: existing, reason });
  res.json({ success: true });
});

export const linkComplianceExpense = asyncHandler(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  const expenseId = parsePositiveId(req.body.expense_id);
  const item = id ? await getScopedComplianceEntity(req, 'compliance_items', id) : null;
  if (!item) return res.status(404).json({ message: 'Compliance item not found' });
  if (!item.site_id) return res.status(409).json({ message: 'Assign the compliance item to a site before linking an expense' });
  if (!expenseId) return res.status(400).json({ message: 'A valid expense_id is required' });
  const { rows: expenseRows } = await pool.query(
    `SELECT e.id,e.site_id,e.date,e.debit,e.credit,e.remark,e.category
       FROM expenses e
       JOIN sites s ON s.id=e.site_id
      WHERE e.id=$1 AND e.site_id=$2 AND s.organization_id=$3
      LIMIT 1`,
    [expenseId, item.site_id, req.user.organization_id]
  );
  if (!expenseRows[0]) return res.status(400).json({ message: 'Expense was not found in this organisation and site' });
  const costType = upper(req.body.cost_type, 'COMPLIANCE_FEE');
  const { rows } = await pool.query(
    `INSERT INTO compliance_finance_links
      (organization_id,site_id,compliance_item_id,expense_id,cost_type,notes,linked_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (organization_id,compliance_item_id,expense_id)
     DO UPDATE SET cost_type=EXCLUDED.cost_type,notes=EXCLUDED.notes
     RETURNING *`,
    [req.user.organization_id, item.site_id, id, expenseId, costType, text(req.body.notes, 5000), req.user.id]
  );
  await writeComplianceAudit(pool, req, {
    action: 'FINANCE_LINK', entityType: 'COMPLIANCE', entityId: id, siteId: item.site_id,
    newValue: { ...rows[0], expense: expenseRows[0] },
  });
  res.status(201).json({ finance_link: { ...rows[0], expense: expenseRows[0] } });
});

export const unlinkComplianceExpense = asyncHandler(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  const linkId = parsePositiveId(req.params.linkId);
  const item = id ? await getScopedComplianceEntity(req, 'compliance_items', id) : null;
  if (!item) return res.status(404).json({ message: 'Compliance item not found' });
  const reason = requireReason(req.body.reason);
  const { rows } = await pool.query(
    `DELETE FROM compliance_finance_links
      WHERE id=$1 AND compliance_item_id=$2 AND organization_id=$3
      RETURNING *`,
    [linkId, id, req.user.organization_id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Finance link not found' });
  await writeComplianceAudit(pool, req, {
    action: 'FINANCE_UNLINK', entityType: 'COMPLIANCE', entityId: id, siteId: item.site_id,
    previousValue: rows[0], reason,
  });
  res.json({ success: true });
});

export const updateComplianceStatus = asyncHandler(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  const target = upper(req.body.status);
  if (!COMPLIANCE_STATUSES.includes(target)) return res.status(400).json({ message: 'Invalid compliance status' });
  const comment = text(req.body.comment, 5000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await getScopedComplianceEntity(req, 'compliance_items', id, { db: client });
    if (!existing) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Compliance item not found' }); }
    const settings = await settingsFor(req.user.organization_id, client);
    if (!isTransitionAllowed(existing.status, target, settings.status_transitions)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `Status cannot move from ${existing.status} to ${target}` });
    }
    if (existing.status === 'APPROVAL_PENDING' && target === 'COMPLETED' && !isOrgAdmin(req.user)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Completion is already awaiting reviewer approval' });
    }
    if (target === 'COMPLETED') {
      const { rows: pending } = await client.query(
        `SELECT COUNT(*)::int AS count FROM compliance_checklist_items
          WHERE compliance_item_id=$1 AND organization_id=$2 AND is_mandatory=TRUE AND status <> 'COMPLETED'`,
        [id, req.user.organization_id]
      );
      if (pending[0].count > 0 && !(isOrgAdmin(req.user) && req.body.override_reason)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: `${pending[0].count} mandatory checklist item(s) are incomplete` });
      }
      if ((existing.approval_required || settings.completion_requires_approval) && !isOrgAdmin(req.user)) {
        const { rows } = await client.query(
          `INSERT INTO compliance_approvals
            (organization_id,compliance_item_id,entity_type,entity_id,action_type,requested_by,assigned_approver_id,request_comment)
           VALUES ($1,$2,'COMPLIANCE',$2,'COMPLETE',$3,$4,$5)
           ON CONFLICT (organization_id,entity_type,entity_id,action_type)
             WHERE status='PENDING' AND entity_id IS NOT NULL
           DO UPDATE SET request_comment=EXCLUDED.request_comment,requested_by=EXCLUDED.requested_by
           RETURNING *`,
          [req.user.organization_id, id, req.user.id, existing.approving_authority_id || existing.reviewing_manager_id, comment]
        );
        await client.query(`UPDATE compliance_items SET status='APPROVAL_PENDING',updated_by=$1,updated_at=NOW() WHERE id=$2`, [req.user.id, id]);
        await client.query(`INSERT INTO compliance_status_history (organization_id,compliance_item_id,previous_status,new_status,changed_by,comment) VALUES ($1,$2,$3,'APPROVAL_PENDING',$4,$5)`, [req.user.organization_id, id, existing.status, req.user.id, comment]);
        await writeComplianceAudit(client, req, { action: 'SUBMIT_COMPLETION', entityType: 'COMPLIANCE', entityId: id, siteId: existing.site_id, previousValue: { status: existing.status }, newValue: { status: 'APPROVAL_PENDING', approval_id: rows[0].id }, reason: comment });
        await client.query('COMMIT');
        return res.status(202).json({ approval: rows[0], status: 'APPROVAL_PENDING' });
      }
    }
    const completionDate = target === 'COMPLETED' ? 'CURRENT_DATE' : 'last_completed_date';
    const progress = target === 'COMPLETED' ? 100 : existing.completion_percentage;
    const { rows } = await client.query(
      `UPDATE compliance_items
          SET status=$1,completion_percentage=$2,last_completed_date=${completionDate},updated_by=$3,updated_at=NOW()
        WHERE id=$4 AND organization_id=$5 RETURNING *`,
      [target, progress, req.user.id, id, req.user.organization_id]
    );
    await client.query(
      `INSERT INTO compliance_status_history (organization_id,compliance_item_id,previous_status,new_status,changed_by,comment)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.user.organization_id, id, existing.status, target, req.user.id, comment || req.body.override_reason]
    );
    await writeComplianceAudit(client, req, { action: 'STATUS_CHANGE', entityType: 'COMPLIANCE', entityId: id, siteId: existing.site_id, previousValue: { status: existing.status }, newValue: { status: target }, reason: comment || req.body.override_reason });
    await client.query('COMMIT');
    res.json({ item: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

export const rescheduleComplianceItem = asyncHandler(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  const existing = id ? await getScopedComplianceEntity(req, 'compliance_items', id) : null;
  if (!existing) return res.status(404).json({ message: 'Compliance item not found' });
  const newDate = storedDate(req.body.new_due_date);
  if (!newDate) return res.status(400).json({ message: 'New due date is required' });
  const reason = requireReason(req.body.reason);
  const settings = await settingsFor(req.user.organization_id);
  if (settings.due_date_change_requires_approval && !isOrgAdmin(req.user)) {
    const { rows } = await pool.query(
      `INSERT INTO compliance_due_date_changes
        (organization_id,compliance_item_id,old_due_date,new_due_date,reason,requested_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (organization_id,compliance_item_id) WHERE status='PENDING'
       DO NOTHING RETURNING *`,
      [req.user.organization_id, id, existing.current_due_date, newDate, reason, req.user.id]
    );
    if (!rows[0]) return res.status(409).json({ message: 'A due-date change is already awaiting approval' });
    await writeComplianceAudit(pool, req, { action: 'RESCHEDULE_REQUESTED', entityType: 'COMPLIANCE', entityId: id, siteId: existing.site_id, previousValue: { current_due_date: existing.current_due_date }, newValue: { requested_due_date: newDate }, reason });
    return res.status(202).json({ due_date_change: rows[0], pending_approval: true });
  }
  const { rows } = await pool.query(
    `INSERT INTO compliance_due_date_changes
      (organization_id,compliance_item_id,old_due_date,new_due_date,reason,status,requested_by,reviewed_by,reviewed_at)
     VALUES ($1,$2,$3,$4,$5,'APPROVED',$6,$6,NOW()) RETURNING *`,
    [req.user.organization_id, id, existing.current_due_date, newDate, reason, req.user.id]
  );
  await pool.query(`UPDATE compliance_items SET current_due_date=$1,updated_by=$2,updated_at=NOW() WHERE id=$3 AND organization_id=$4`, [newDate, req.user.id, id, req.user.organization_id]);
  await writeComplianceAudit(pool, req, { action: 'RESCHEDULE_APPROVED', entityType: 'COMPLIANCE', entityId: id, siteId: existing.site_id, previousValue: { current_due_date: existing.current_due_date }, newValue: { current_due_date: newDate }, reason });
  res.json({ due_date_change: rows[0], pending_approval: false });
});

export const reviewDueDateChange = asyncHandler(async (req, res) => {
  const changeId = parsePositiveId(req.params.changeId);
  const decision = upper(req.body.decision);
  if (!['APPROVED', 'REJECTED'].includes(decision)) return res.status(400).json({ message: 'Decision must be APPROVED or REJECTED' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT d.*,i.site_id FROM compliance_due_date_changes d
       JOIN compliance_items i ON i.id=d.compliance_item_id
       WHERE d.id=$1 AND d.organization_id=$2 AND d.status='PENDING'
         AND ($3::boolean=TRUE OR i.site_id IN (SELECT site_id FROM user_sites WHERE user_id=$4))
       FOR UPDATE`,
      [changeId, req.user.organization_id, isOrgAdmin(req.user), req.user.id]
    );
    const change = rows[0];
    if (!change) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Pending due-date request not found' }); }
    await client.query(
      `UPDATE compliance_due_date_changes SET status=$1,reviewed_by=$2,review_comment=$3,reviewed_at=NOW() WHERE id=$4`,
      [decision, req.user.id, text(req.body.comment), changeId]
    );
    if (decision === 'APPROVED') {
      await client.query(`UPDATE compliance_items SET current_due_date=$1,updated_by=$2,updated_at=NOW() WHERE id=$3 AND organization_id=$4`, [change.new_due_date, req.user.id, change.compliance_item_id, req.user.organization_id]);
    }
    await writeComplianceAudit(client, req, { action: `RESCHEDULE_${decision}`, entityType: 'COMPLIANCE', entityId: change.compliance_item_id, siteId: change.site_id, previousValue: { current_due_date: change.old_due_date }, newValue: { current_due_date: decision === 'APPROVED' ? change.new_due_date : change.old_due_date }, reason: req.body.comment || change.reason });
    await client.query('COMMIT');
    res.json({ success: true, decision });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

export const createChecklistItem = asyncHandler(async (req, res) => {
  const itemId = parsePositiveId(req.params.id);
  const item = itemId ? await getScopedComplianceEntity(req, 'compliance_items', itemId) : null;
  if (!item) return res.status(404).json({ message: 'Compliance item not found' });
  if (!text(req.body.title, 300)) return res.status(400).json({ message: 'Checklist title is required' });
  const assignee = req.body.assigned_to ? await accessibleUser(req, parsePositiveId(req.body.assigned_to), item.site_id) : null;
  if (req.body.assigned_to && !assignee) return res.status(400).json({ message: 'Invalid checklist assignee' });
  const { rows } = await pool.query(
    `INSERT INTO compliance_checklist_items
      (organization_id,compliance_item_id,title,description,is_mandatory,assigned_to,due_date,required_document_type,sequence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [req.user.organization_id, itemId, text(req.body.title, 300), text(req.body.description),
      Boolean(req.body.is_mandatory), assignee, storedDate(req.body.due_date),
      text(req.body.required_document_type, 120), Number.parseInt(req.body.sequence, 10) || 0]
  );
  await writeComplianceAudit(pool, req, { action: 'CHECKLIST_CREATE', entityType: 'COMPLIANCE', entityId: itemId, siteId: item.site_id, newValue: rows[0] });
  res.status(201).json({ checklist_item: rows[0] });
});

export const updateChecklistItem = asyncHandler(async (req, res) => {
  const itemId = parsePositiveId(req.params.id);
  const checklistId = parsePositiveId(req.params.checklistId);
  const item = itemId ? await getScopedComplianceEntity(req, 'compliance_items', itemId) : null;
  if (!item) return res.status(404).json({ message: 'Compliance item not found' });
  const { rows: existingRows } = await pool.query(`SELECT * FROM compliance_checklist_items WHERE id=$1 AND compliance_item_id=$2 AND organization_id=$3`, [checklistId, itemId, req.user.organization_id]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ message: 'Checklist item not found' });
  const payload = {};
  for (const field of ['title', 'description', 'required_document_type', 'comments']) {
    if (req.body[field] !== undefined) payload[field] = text(req.body[field], field === 'title' ? 300 : 5000);
  }
  if (req.body.is_mandatory !== undefined) payload.is_mandatory = Boolean(req.body.is_mandatory);
  if (req.body.due_date !== undefined) payload.due_date = storedDate(req.body.due_date);
  if (req.body.sequence !== undefined) payload.sequence = Number.parseInt(req.body.sequence, 10) || 0;
  if (req.body.assigned_to !== undefined) {
    payload.assigned_to = req.body.assigned_to
      ? await accessibleUser(req, parsePositiveId(req.body.assigned_to), item.site_id)
      : null;
    if (req.body.assigned_to && !payload.assigned_to) return res.status(400).json({ message: 'Invalid checklist assignee' });
  }
  if (req.body.status !== undefined) {
    payload.status = upper(req.body.status);
    payload.completed_by = payload.status === 'COMPLETED' ? req.user.id : null;
    payload.completed_at = payload.status === 'COMPLETED' ? new Date() : null;
  }
  if (!Object.keys(payload).length) return res.status(400).json({ message: 'Nothing to update' });
  const update = sqlUpdate(payload);
  const { rows } = await pool.query(
    `UPDATE compliance_checklist_items SET ${update.set},updated_at=NOW()
      WHERE id=$${update.values.length + 1} AND compliance_item_id=$${update.values.length + 2} AND organization_id=$${update.values.length + 3}
      RETURNING *`,
    [...update.values, checklistId, itemId, req.user.organization_id]
  );
  const { rows: progressRows } = await pool.query(
    `SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE status='COMPLETED')::int AS completed
       FROM compliance_checklist_items WHERE compliance_item_id=$1`,
    [itemId]
  );
  const progress = progressRows[0].total ? Math.round(progressRows[0].completed / progressRows[0].total * 100) : 0;
  await pool.query(`UPDATE compliance_items SET completion_percentage=$1,updated_at=NOW() WHERE id=$2`, [progress, itemId]);
  await writeComplianceAudit(pool, req, { action: 'CHECKLIST_UPDATE', entityType: 'COMPLIANCE', entityId: itemId, siteId: item.site_id, previousValue: existing, newValue: rows[0] });
  res.json({ checklist_item: rows[0], completion_percentage: progress });
});

export const reviewComplianceApproval = asyncHandler(async (req, res) => {
  const approvalId = parsePositiveId(req.params.approvalId);
  const legalEndpoint = req.path.includes('/legal-approvals/');
  const approvalScope = legalEndpoint
    ? `AND a.entity_type='LEGAL_NOTICE' AND a.action_type='LEGAL_REPLY'`
    : `AND a.entity_type='COMPLIANCE' AND a.compliance_item_id IS NOT NULL`;
  const decision = upper(req.body.decision);
  const statusMap = { APPROVE: 'APPROVED', REJECT: 'REJECTED', RETURN: 'RETURNED', REQUEST_INFORMATION: 'INFO_REQUESTED' };
  const approvalStatus = statusMap[decision];
  if (!approvalStatus) return res.status(400).json({ message: 'Invalid approval decision' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT a.*,COALESCE(i.site_id,n.site_id) AS site_id,i.status AS item_status,
              n.status AS notice_status
         FROM compliance_approvals a
       LEFT JOIN compliance_items i ON i.id=a.compliance_item_id
       LEFT JOIN legal_notices n ON a.entity_type='LEGAL_NOTICE' AND n.id=a.entity_id
       WHERE a.id=$1 AND a.organization_id=$2 AND a.status='PENDING'
         ${approvalScope}
         AND ($3::boolean=TRUE OR COALESCE(i.site_id,n.site_id) IN (SELECT site_id FROM user_sites WHERE user_id=$4))
       FOR UPDATE`,
      [approvalId, req.user.organization_id, isOrgAdmin(req.user), req.user.id]
    );
    const approval = rows[0];
    if (!approval) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Pending approval not found' }); }
    if (!isOrgAdmin(req.user) && approval.assigned_approver_id && approval.assigned_approver_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'This approval is assigned to another reviewer' });
    }
    await client.query(
      `UPDATE compliance_approvals SET status=$1,reviewed_by=$2,review_comment=$3,reviewed_at=NOW() WHERE id=$4`,
      [approvalStatus, req.user.id, text(req.body.comment), approvalId]
    );
    if (approval.action_type === 'COMPLETE' && approval.compliance_item_id) {
      const nextStatus = approvalStatus === 'APPROVED' ? 'COMPLETED'
        : approvalStatus === 'RETURNED' || approvalStatus === 'INFO_REQUESTED' ? 'RETURNED_FOR_CORRECTION'
          : 'REJECTED';
      await client.query(
        `UPDATE compliance_items SET status=$1,completion_percentage=CASE WHEN $1='COMPLETED' THEN 100 ELSE completion_percentage END,
          last_completed_date=CASE WHEN $1='COMPLETED' THEN CURRENT_DATE ELSE last_completed_date END,
          updated_by=$2,updated_at=NOW() WHERE id=$3`,
        [nextStatus, req.user.id, approval.compliance_item_id]
      );
      await client.query(
        `INSERT INTO compliance_status_history (organization_id,compliance_item_id,previous_status,new_status,changed_by,comment)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.user.organization_id, approval.compliance_item_id, approval.item_status, nextStatus, req.user.id, text(req.body.comment)]
      );
    }
    if (approval.action_type === 'LEGAL_REPLY' && approval.entity_type === 'LEGAL_NOTICE' && approval.entity_id) {
      const nextStatus = approvalStatus === 'APPROVED' ? 'REPLY_SUBMITTED' : 'REPLY_DRAFTING';
      await client.query(
        `UPDATE legal_notices SET status=$1,updated_by=$2,updated_at=NOW()
          WHERE id=$3 AND organization_id=$4`,
        [nextStatus, req.user.id, approval.entity_id, req.user.organization_id]
      );
    }
    await writeComplianceAudit(client, req, { action: `APPROVAL_${approvalStatus}`, entityType: approval.entity_type, entityId: approval.entity_id || approval.compliance_item_id, siteId: approval.site_id, previousValue: { status: 'PENDING' }, newValue: { status: approvalStatus }, reason: req.body.comment });
    await client.query('COMMIT');
    res.json({ success: true, status: approvalStatus });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

export const complianceCalendar = asyncHandler(async (req, res) => {
  const canViewLegal = await hasModuleRead(req, 'legal');
  const from = storedDate(req.query.from);
  const to = storedDate(req.query.to);
  if (!from || !to) return res.status(400).json({ message: 'from and to dates are required' });
  const params = [req.user.organization_id, from, to];
  const itemScope = addComplianceSiteScope(req, 'i', params);
  const caseScope = isOrgAdmin(req.user) ? '' : `AND c.site_id IN (SELECT site_id FROM user_sites WHERE user_id=$${params.length})`;
  const noticeScope = isOrgAdmin(req.user) ? '' : `AND n.site_id IN (SELECT site_id FROM user_sites WHERE user_id=$${params.length})`;
  const inspectionScope = isOrgAdmin(req.user) ? '' : `AND x.site_id IN (SELECT site_id FROM user_sites WHERE user_id=$${params.length})`;
  const licenceScope = isOrgAdmin(req.user) ? '' : `AND l.site_id IN (SELECT site_id FROM user_sites WHERE user_id=$${params.length})`;
  let siteParam = null;
  if (req.query.site_id) {
    const siteId = await assertComplianceSiteAccess(req, res, req.query.site_id);
    if (siteId === false) return;
    params.push(siteId);
    siteParam = params.length;
  }
  const selectedSite = (alias) => siteParam ? `AND ${alias}.site_id=$${siteParam}` : '';
  const [items, cases, notices, inspections, licences] = await Promise.all([
    pool.query(`SELECT i.id,'COMPLIANCE' AS event_type,i.title,i.current_due_date AS event_date,i.status,i.risk_level,i.site_id,s.name AS site_name FROM compliance_items i LEFT JOIN sites s ON s.id=i.site_id WHERE i.organization_id=$1 AND i.deleted_at IS NULL AND i.current_due_date BETWEEN $2 AND $3 ${itemScope} ${selectedSite('i')}`, params),
    canViewLegal ? pool.query(`SELECT c.id,'LEGAL_HEARING' AS event_type,c.title,c.next_hearing_date AS event_date,c.status,c.risk_level,c.site_id,s.name AS site_name FROM legal_cases c LEFT JOIN sites s ON s.id=c.site_id WHERE c.organization_id=$1 AND c.deleted_at IS NULL AND c.next_hearing_date::date BETWEEN $2 AND $3 ${caseScope} ${selectedSite('c')}`, params) : Promise.resolve({ rows: [] }),
    canViewLegal ? pool.query(`SELECT n.id,'NOTICE_REPLY' AS event_type,n.subject AS title,n.reply_due_date AS event_date,n.status,n.risk_level,n.site_id,s.name AS site_name FROM legal_notices n LEFT JOIN sites s ON s.id=n.site_id WHERE n.organization_id=$1 AND n.deleted_at IS NULL AND n.reply_due_date BETWEEN $2 AND $3 ${noticeScope} ${selectedSite('n')}`, params) : Promise.resolve({ rows: [] }),
    pool.query(`SELECT x.id,'INSPECTION' AS event_type,x.inspection_type AS title,x.scheduled_at AS event_date,x.status,'MEDIUM' AS risk_level,x.site_id,s.name AS site_name FROM compliance_inspections x LEFT JOIN sites s ON s.id=x.site_id WHERE x.organization_id=$1 AND x.deleted_at IS NULL AND x.scheduled_at::date BETWEEN $2 AND $3 ${inspectionScope} ${selectedSite('x')}`, params),
    pool.query(`SELECT l.id,'LICENCE_EXPIRY' AS event_type,l.name AS title,l.expiry_date AS event_date,l.renewal_status AS status,'HIGH' AS risk_level,l.site_id,s.name AS site_name FROM compliance_licences l LEFT JOIN sites s ON s.id=l.site_id WHERE l.organization_id=$1 AND l.deleted_at IS NULL AND l.expiry_date BETWEEN $2 AND $3 ${licenceScope} ${selectedSite('l')}`, params),
  ]);
  res.json({ events: [...items.rows, ...cases.rows, ...notices.rows, ...inspections.rows, ...licences.rows].sort((a, b) => new Date(a.event_date) - new Date(b.event_date)) });
});

// ── Authorities ─────────────────────────────────────────────────────

export const listAuthorities = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.*,COUNT(i.id)::int AS compliance_count
       FROM compliance_authorities a
       LEFT JOIN compliance_items i ON i.authority_id=a.id AND i.deleted_at IS NULL
        AND ($2::boolean=TRUE OR i.site_id IN (SELECT site_id FROM user_sites WHERE user_id=$3))
      WHERE a.organization_id=$1 AND a.deleted_at IS NULL
      GROUP BY a.id ORDER BY a.is_active DESC,a.name`,
    [req.user.organization_id, isOrgAdmin(req.user), req.user.id]
  );
  res.json({ authorities: rows });
});

export const createAuthority = asyncHandler(async (req, res) => {
  if (!text(req.body.name, 255)) return res.status(400).json({ message: 'Authority name is required' });
  const payload = {
    organization_id: req.user.organization_id,
    name: text(req.body.name, 255),
    department_name: text(req.body.department_name, 255),
    authority_type: text(req.body.authority_type, 100),
    state: text(req.body.state, 100),
    district: text(req.body.district, 100),
    address: text(req.body.address), contact_person: text(req.body.contact_person, 255),
    phone: text(req.body.phone, 30), email: text(req.body.email, 255),
    website: text(req.body.website, 500), office_timings: text(req.body.office_timings, 255),
    categories: jsonArray(req.body.categories), notes: text(req.body.notes),
    created_by: req.user.id, updated_by: req.user.id,
  };
  const fields = Object.keys(payload), values = Object.values(payload);
  try {
    const { rows } = await pool.query(`INSERT INTO compliance_authorities (${fields.join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, values);
    await writeComplianceAudit(pool, req, { action: 'CREATE', entityType: 'AUTHORITY', entityId: rows[0].id, newValue: rows[0] });
    res.status(201).json({ authority: rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ message: 'This authority already exists for the location' });
    throw error;
  }
});

export const updateAuthority = asyncHandler(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  const { rows: beforeRows } = await pool.query(`SELECT * FROM compliance_authorities WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`, [id, req.user.organization_id]);
  const before = beforeRows[0];
  if (!before) return res.status(404).json({ message: 'Authority not found' });
  const payload = {};
  for (const field of ['name','department_name','authority_type','state','district','address','contact_person','phone','email','website','office_timings','notes']) {
    if (req.body[field] !== undefined) payload[field] = text(req.body[field], field === 'notes' || field === 'address' ? 5000 : 500);
  }
  if (req.body.categories !== undefined) payload.categories = jsonArray(req.body.categories);
  if (req.body.is_active !== undefined) payload.is_active = Boolean(req.body.is_active);
  payload.updated_by = req.user.id;
  const update = sqlUpdate(payload);
  const { rows } = await pool.query(`UPDATE compliance_authorities SET ${update.set},updated_at=NOW() WHERE id=$${update.values.length + 1} AND organization_id=$${update.values.length + 2} RETURNING *`, [...update.values, id, req.user.organization_id]);
  await writeComplianceAudit(pool, req, { action: 'UPDATE', entityType: 'AUTHORITY', entityId: id, previousValue: before, newValue: rows[0] });
  res.json({ authority: rows[0] });
});

export const deleteAuthority = asyncHandler(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  const reason = requireReason(req.body.reason);
  const { rows } = await pool.query(`UPDATE compliance_authorities SET deleted_at=NOW(),updated_by=$1,updated_at=NOW() WHERE id=$2 AND organization_id=$3 AND deleted_at IS NULL RETURNING *`, [req.user.id, id, req.user.organization_id]);
  if (!rows[0]) return res.status(404).json({ message: 'Authority not found' });
  await writeComplianceAudit(pool, req, { action: 'DELETE', entityType: 'AUTHORITY', entityId: id, previousValue: rows[0], reason });
  res.json({ success: true });
});

// ── Templates and recurring generation ──────────────────────────────

export const listTemplates = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.*,a.name AS authority_name,u.name AS reviewer_name,ap.name AS approver_name
       FROM compliance_templates t
       LEFT JOIN compliance_authorities a ON a.id=t.authority_id
       LEFT JOIN users u ON u.id=t.default_reviewer_id
       LEFT JOIN users ap ON ap.id=t.default_approver_id
      WHERE t.organization_id=$1 AND t.deleted_at IS NULL ORDER BY t.is_active DESC,t.name`,
    [req.user.organization_id]
  );
  res.json({ templates: rows });
});

function cleanTemplatePayload(body, { partial = false } = {}) {
  const payload = {};
  for (const field of ['name','category','subcategory','compliance_type','description','applicable_state','applicable_district','applicable_project_type','applicability_conditions','frequency','default_responsible_role']) {
    if (body[field] !== undefined) payload[field] = text(body[field], field === 'description' || field === 'applicability_conditions' ? 10000 : 300);
  }
  if (!partial && !payload.name) throw Object.assign(new Error('Template name is required'), { statusCode: 400 });
  if (body.authority_id !== undefined) payload.authority_id = parsePositiveId(body.authority_id);
  if (body.applicable_site_ids !== undefined) payload.applicable_site_ids = jsonArray(body.applicable_site_ids).map(parsePositiveId).filter(Boolean);
  if (body.start_date !== undefined) payload.start_date = storedDate(body.start_date);
  if (body.end_date !== undefined) payload.end_date = storedDate(body.end_date);
  if (body.default_reviewer_id !== undefined) payload.default_reviewer_id = parsePositiveId(body.default_reviewer_id);
  if (body.default_approver_id !== undefined) payload.default_approver_id = parsePositiveId(body.default_approver_id);
  if (body.due_date_rule !== undefined) payload.due_date_rule = jsonObject(body.due_date_rule, { type: 'MANUAL' });
  if (body.required_checklist !== undefined) payload.required_checklist = jsonArray(body.required_checklist);
  if (body.required_documents !== undefined) payload.required_documents = jsonArray(body.required_documents);
  if (body.default_risk !== undefined) payload.default_risk = RISK_LEVELS.has(upper(body.default_risk)) ? upper(body.default_risk) : 'MEDIUM';
  if (body.default_reminder_days !== undefined) payload.default_reminder_days = normalizeIntArray(body.default_reminder_days);
  if (body.default_escalations !== undefined) payload.default_escalations = jsonArray(body.default_escalations);
  for (const field of ['renewal_required','approval_required','is_active']) if (body[field] !== undefined) payload[field] = Boolean(body[field]);
  return payload;
}

async function validateTemplateReferences(req, payload, db = pool) {
  if (payload.authority_id) {
    payload.authority_id = await assertOwnedReference(req, 'authority_id', payload.authority_id, db);
  }
  if (payload.applicable_site_ids) {
    for (const siteId of payload.applicable_site_ids) {
      const accessible = await assertComplianceSiteAccess(
        req,
        { status: (status) => ({ json: ({ message }) => { throw Object.assign(new Error(message), { statusCode: status }); } }) },
        siteId,
        { required: true, db }
      );
      if (!accessible) throw Object.assign(new Error(`Access denied to site ${siteId}`), { statusCode: 403 });
    }
  }
  for (const field of ['default_reviewer_id', 'default_approver_id']) {
    if (payload[field]) {
      const valid = await accessibleUser(req, payload[field], null, db);
      if (!valid) throw Object.assign(new Error(`Invalid ${field.replaceAll('_', ' ')}`), { statusCode: 400 });
      payload[field] = valid;
    }
  }
  if (payload.start_date && payload.end_date && payload.start_date > payload.end_date) {
    throw Object.assign(new Error('Template end date cannot be before its start date'), { statusCode: 400 });
  }
  return payload;
}

export const createTemplate = asyncHandler(async (req, res) => {
  const payload = cleanTemplatePayload(req.body);
  await validateTemplateReferences(req, payload);
  Object.assign(payload, { organization_id: req.user.organization_id, created_by: req.user.id, updated_by: req.user.id });
  const fields = Object.keys(payload), values = Object.values(payload);
  try {
    const { rows } = await pool.query(`INSERT INTO compliance_templates (${fields.join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, values);
    await writeComplianceAudit(pool, req, { action: 'CREATE', entityType: 'COMPLIANCE_TEMPLATE', entityId: rows[0].id, newValue: rows[0] });
    res.status(201).json({ template: rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ message: 'A template with this name already exists' });
    throw error;
  }
});

export const updateTemplate = asyncHandler(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  const { rows: beforeRows } = await pool.query(`SELECT * FROM compliance_templates WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`, [id, req.user.organization_id]);
  if (!beforeRows[0]) return res.status(404).json({ message: 'Template not found' });
  const payload = cleanTemplatePayload(req.body, { partial: true });
  await validateTemplateReferences(req, payload);
  const effectiveStart = payload.start_date ?? beforeRows[0].start_date;
  const effectiveEnd = payload.end_date ?? beforeRows[0].end_date;
  if (effectiveStart && effectiveEnd && String(effectiveStart).slice(0, 10) > String(effectiveEnd).slice(0, 10)) {
    return res.status(400).json({ message: 'Template end date cannot be before its start date' });
  }
  if (!Object.keys(payload).length) return res.status(400).json({ message: 'Nothing to update' });
  payload.updated_by = req.user.id;
  const update = sqlUpdate(payload);
  const { rows } = await pool.query(`UPDATE compliance_templates SET ${update.set},updated_at=NOW() WHERE id=$${update.values.length + 1} AND organization_id=$${update.values.length + 2} RETURNING *`, [...update.values, id, req.user.organization_id]);
  await writeComplianceAudit(pool, req, { action: 'UPDATE', entityType: 'COMPLIANCE_TEMPLATE', entityId: id, previousValue: beforeRows[0], newValue: rows[0] });
  res.json({ template: rows[0] });
});

export const duplicateTemplate = asyncHandler(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  const { rows } = await pool.query(`SELECT * FROM compliance_templates WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`, [id, req.user.organization_id]);
  const source = rows[0];
  if (!source) return res.status(404).json({ message: 'Template not found' });
  const { id: _id, created_at: _ca, updated_at: _ua, deleted_at: _da, ...copy } = source;
  copy.name = text(req.body.name, 255) || `${source.name} Copy`;
  copy.created_by = req.user.id; copy.updated_by = req.user.id;
  const fields = Object.keys(copy), values = Object.values(copy);
  const inserted = await pool.query(`INSERT INTO compliance_templates (${fields.join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, values);
  await writeComplianceAudit(pool, req, { action: 'DUPLICATE', entityType: 'COMPLIANCE_TEMPLATE', entityId: inserted.rows[0].id, previousValue: { source_id: id }, newValue: inserted.rows[0] });
  res.status(201).json({ template: inserted.rows[0] });
});

export const deleteTemplate = asyncHandler(async (req, res) => {
  const id = parsePositiveId(req.params.id);
  const reason = requireReason(req.body.reason);
  const { rows } = await pool.query(
    `UPDATE compliance_templates
        SET deleted_at=NOW(),is_active=FALSE,updated_by=$1,updated_at=NOW()
      WHERE id=$2 AND organization_id=$3 AND deleted_at IS NULL
      RETURNING *`,
    [req.user.id, id, req.user.organization_id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Template not found' });
  await writeComplianceAudit(pool, req, {
    action: 'DELETE', entityType: 'COMPLIANCE_TEMPLATE', entityId: id,
    previousValue: rows[0], reason,
  });
  res.json({ success: true });
});

export const exportTemplates = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT name,category,subcategory,compliance_type,description,applicable_state,applicable_district,
            applicable_project_type,applicability_conditions,applicable_site_ids,frequency,start_date,end_date,
            due_date_rule,default_responsible_role,required_checklist,required_documents,default_risk,
            default_reminder_days,default_escalations,renewal_required,approval_required,is_active
       FROM compliance_templates
      WHERE organization_id=$1 AND deleted_at IS NULL
      ORDER BY name`,
    [req.user.organization_id]
  );
  await writeComplianceAudit(pool, req, {
    action: 'EXPORT', entityType: 'COMPLIANCE_TEMPLATE',
    newValue: { exported_count: rows.length },
  });
  res.json({ schema_version: 1, exported_at: new Date().toISOString(), templates: rows });
});

export const importTemplates = asyncHandler(async (req, res) => {
  const templates = jsonArray(req.body.templates);
  if (!templates.length || templates.length > 100) {
    return res.status(400).json({ message: 'Import must contain between 1 and 100 templates' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let imported = 0;
    for (const source of templates) {
      const payload = cleanTemplatePayload(source);
      await validateTemplateReferences(req, payload, client);
      Object.assign(payload, {
        organization_id: req.user.organization_id,
        created_by: req.user.id,
        updated_by: req.user.id,
      });
      const fields = Object.keys(payload);
      const values = Object.values(payload);
      const result = await client.query(
        `INSERT INTO compliance_templates (${fields.join(',')})
         VALUES (${fields.map((_, index) => `$${index + 1}`).join(',')})
         ON CONFLICT (organization_id,UPPER(name)) WHERE deleted_at IS NULL
         DO NOTHING RETURNING id`,
        values
      );
      imported += result.rowCount;
    }
    await writeComplianceAudit(client, req, {
      action: 'IMPORT', entityType: 'COMPLIANCE_TEMPLATE',
      newValue: { requested_count: templates.length, imported_count: imported },
    });
    await client.query('COMMIT');
    res.status(201).json({ imported, skipped: templates.length - imported });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    throw error;
  } finally {
    client.release();
  }
});

export async function generateTemplateItems({
  req, templateId, siteIds, startDate, endDate = null, throughDate, eventDate = null, db = pool,
}) {
  const { rows } = await db.query(`SELECT * FROM compliance_templates WHERE id=$1 AND organization_id=$2 AND is_active=TRUE AND deleted_at IS NULL`, [templateId, req.user.organization_id]);
  const template = rows[0];
  if (!template) throw Object.assign(new Error('Active template not found'), { statusCode: 404 });
  const occurrences = buildOccurrences({
    frequency: template.frequency, startDate, endDate,
    dueDateRule: template.due_date_rule, eventDate, throughDate,
  });
  let generated = 0, skipped = 0;
  for (const siteId of siteIds) {
    const accessible = await assertComplianceSiteAccess(req, { status: () => ({ json: () => {} }) }, siteId, { required: true, db });
    if (!accessible) throw Object.assign(new Error(`Access denied to site ${siteId}`), { statusCode: 403 });
    for (const occurrence of occurrences) {
      const generatedKey = `template:${template.id}:site:${siteId}:period:${occurrence.periodKey}`;
      const insert = await db.query(
        `INSERT INTO compliance_items
          (organization_id,site_id,template_id,authority_id,compliance_code,title,description,
           category,subcategory,compliance_type,state,district,frequency,original_due_date,current_due_date,
           reminder_days,reviewing_manager_id,approving_authority_id,risk_level,priority,approval_required,
           generated_key,created_by,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16,$17,$18,$18,$19,$20,$21,$21)
         ON CONFLICT (organization_id,generated_key) WHERE generated_key IS NOT NULL AND deleted_at IS NULL DO NOTHING
         RETURNING *`,
        [req.user.organization_id, siteId, template.id, template.authority_id, codeFor('CMP'),
          template.name, template.description, template.category, template.subcategory, template.compliance_type,
          template.applicable_state, template.applicable_district, template.frequency, occurrence.dueDate,
          template.default_reminder_days, template.default_reviewer_id, template.default_approver_id,
          template.default_risk, template.approval_required, generatedKey, req.user.id]
      );
      if (!insert.rows[0]) { skipped += 1; continue; }
      generated += 1;
      for (let index = 0; index < (template.required_checklist || []).length; index += 1) {
        const row = template.required_checklist[index];
        if (!text(row.title, 300)) continue;
        await db.query(
          `INSERT INTO compliance_checklist_items
            (organization_id,compliance_item_id,title,description,is_mandatory,required_document_type,sequence)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [req.user.organization_id, insert.rows[0].id, text(row.title, 300), text(row.description),
            Boolean(row.is_mandatory), text(row.required_document_type, 120), index]
        );
      }
    }
  }
  return { generated, skipped, occurrences: occurrences.length };
}

export const applyTemplate = asyncHandler(async (req, res) => {
  const templateId = parsePositiveId(req.params.id);
  const siteIds = [...new Set(jsonArray(req.body.site_ids).map(parsePositiveId).filter(Boolean))];
  if (!siteIds.length) return res.status(400).json({ message: 'Select at least one site' });
  const startDate = storedDate(req.body.start_date) || new Date().toISOString().slice(0, 10);
  const through = storedDate(req.body.through_date) || new Date(Date.now() + 366 * 86400000).toISOString().slice(0, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await generateTemplateItems({
      req, templateId, siteIds, startDate, endDate: storedDate(req.body.end_date),
      throughDate: through, eventDate: storedDate(req.body.event_date), db: client,
    });
    await writeComplianceAudit(client, req, { action: 'APPLY_TEMPLATE', entityType: 'COMPLIANCE_TEMPLATE', entityId: templateId, newValue: { site_ids: siteIds, ...result } });
    await client.query('COMMIT');
    res.status(201).json(result);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    throw error;
  } finally {
    client.release();
  }
});

export const getComplianceSettings = asyncHandler(async (req, res) => {
  res.json({ settings: await settingsFor(req.user.organization_id) });
});

export const getLegalConfiguration = asyncHandler(async (req, res) => {
  const settings = await settingsFor(req.user.organization_id);
  res.json({
    case_stages: settings.legal_case_stages,
    notice_status_transitions: settings.notice_status_transitions,
  });
});

export const updateComplianceSettings = asyncHandler(async (req, res) => {
  const current = await settingsFor(req.user.organization_id);
  const timezone = text(req.body.timezone, 80) || current.timezone;
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(new Date()); } catch {
    return res.status(400).json({ message: 'Invalid IANA timezone' });
  }
  const channels = jsonArray(req.body.notification_channels, current.notification_channels)
    .map((value) => upper(value)).filter((value) => ['DASHBOARD','EMAIL','SMS','WHATSAPP'].includes(value));
  const transitions = jsonObject(req.body.status_transitions, current.status_transitions);
  const legalCaseStages = jsonArray(req.body.legal_case_stages, current.legal_case_stages)
    .map((value) => upper(value)).filter(Boolean).slice(0, 50);
  if (!legalCaseStages.length) return res.status(400).json({ message: 'At least one legal case stage is required' });
  const noticeTransitions = jsonObject(req.body.notice_status_transitions, current.notice_status_transitions);
  for (const [from, targets] of Object.entries(transitions)) {
    if (!COMPLIANCE_STATUSES.includes(upper(from)) || !Array.isArray(targets) || targets.some((target) => !COMPLIANCE_STATUSES.includes(upper(target)))) {
      return res.status(400).json({ message: 'Status transition configuration contains an invalid status' });
    }
  }
  for (const [from, targets] of Object.entries(noticeTransitions)) {
    if (!NOTICE_STATUSES.has(upper(from)) || !Array.isArray(targets) || targets.some((target) => !NOTICE_STATUSES.has(upper(target)))) {
      return res.status(400).json({ message: 'Notice transition configuration contains an invalid status' });
    }
  }
  const { rows } = await pool.query(
    `INSERT INTO compliance_settings
      (organization_id,timezone,due_date_change_requires_approval,completion_requires_approval,
       notification_channels,default_reminder_days,overdue_escalation_days,status_transitions,
       legal_case_stages,notice_status_transitions,updated_by,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (organization_id) DO UPDATE SET
       timezone=EXCLUDED.timezone,due_date_change_requires_approval=EXCLUDED.due_date_change_requires_approval,
       completion_requires_approval=EXCLUDED.completion_requires_approval,
       notification_channels=EXCLUDED.notification_channels,default_reminder_days=EXCLUDED.default_reminder_days,
       overdue_escalation_days=EXCLUDED.overdue_escalation_days,status_transitions=EXCLUDED.status_transitions,
       legal_case_stages=EXCLUDED.legal_case_stages,notice_status_transitions=EXCLUDED.notice_status_transitions,
       updated_by=EXCLUDED.updated_by,updated_at=NOW()
     RETURNING *`,
    [req.user.organization_id, timezone,
      req.body.due_date_change_requires_approval ?? current.due_date_change_requires_approval,
      req.body.completion_requires_approval ?? current.completion_requires_approval,
      channels, normalizeIntArray(req.body.default_reminder_days, current.default_reminder_days),
      normalizeIntArray(req.body.overdue_escalation_days, current.overdue_escalation_days),
      transitions, legalCaseStages, noticeTransitions, req.user.id]
  );
  await writeComplianceAudit(pool, req, { action: 'UPDATE', entityType: 'COMPLIANCE_SETTINGS', previousValue: current, newValue: rows[0] });
  res.json({ settings: rows[0] });
});

export const listComplianceUsers = asyncHandler(async (req, res) => {
  const siteId = req.query.site_id ? await assertComplianceSiteAccess(req, res, req.query.site_id) : null;
  if (siteId === false) return;
  const params = [req.user.organization_id];
  let scope = '';
  if (siteId) { params.push(siteId); scope = `AND (u.role IN ('admin','super_admin') OR EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id=u.id AND us.site_id=$2))`; }
  const { rows } = await pool.query(`SELECT u.id,u.name,u.email,u.phone,u.role FROM users u WHERE u.organization_id=$1 AND u.is_active=TRUE ${scope} ORDER BY CASE u.role WHEN 'super_admin' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,u.name`, params);
  res.json({ users: rows });
});

// ── Approval/licence, legal case, notice and inspection registers ───

const JSON_FIELDS = new Set([
  'metadata', 'related_entities', 'attendees', 'preparation_checklist',
  'required_documents', 'corrective_actions',
]);
const ARRAY_FIELDS = new Set(['reminder_days']);
const ID_FIELDS = new Set([
  'site_id', 'authority_id', 'compliance_item_id', 'legal_case_id',
  'responsible_person_id', 'reviewing_manager_id', 'internal_owner_id',
]);
const NUMBER_FIELDS = new Set([
  'renewal_cost', 'security_deposit', 'claim_amount', 'financial_exposure',
  'amount_involved', 'case_year',
]);
const DATE_FIELDS = new Set([
  'issue_date', 'effective_date', 'expiry_date', 'renewal_application_date',
  'filing_date', 'limitation_date', 'date_received', 'notice_date',
  'reply_due_date', 'follow_up_date',
]);
const TIMESTAMP_FIELDS = new Set([
  'next_hearing_date', 'last_hearing_date', 'scheduled_at',
]);
const UPPER_FIELDS = new Set([
  'licence_type', 'renewal_status', 'verification_status', 'case_type',
  'risk_level', 'stage', 'status', 'confidentiality', 'notice_type', 'direction',
  'meeting_mode',
]);
const ENTITY_DATE_COLUMN = {
  licence: 'expiry_date', case: 'next_hearing_date', notice: 'reply_due_date', inspection: 'scheduled_at',
};

const cleanTimestamp = (value) => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw Object.assign(new Error('Invalid date and time'), { statusCode: 400 });
  return parsed.toISOString();
};

async function assertOwnedReference(req, field, id, db = pool) {
  if (!id) return null;
  if (field === 'legal_case_id' && !(await hasModuleRead(req, 'legal'))) {
    throw Object.assign(new Error('Legal read access is required to link a case'), { statusCode: 403 });
  }
  if (field === 'compliance_item_id' && !(await hasModuleRead(req, 'compliance'))) {
    throw Object.assign(new Error('Compliance read access is required to link an obligation'), { statusCode: 403 });
  }
  const config = {
    authority_id: ['compliance_authorities', false],
    template_id: ['compliance_templates', false],
    compliance_item_id: ['compliance_items', true],
    legal_case_id: ['legal_cases', true],
  }[field];
  if (!config) return id;
  const [table, hasSite] = config;
  const params = [id, req.user.organization_id];
  const siteScope = hasSite && !isOrgAdmin(req.user)
    ? `AND site_id IN (SELECT site_id FROM user_sites WHERE user_id=$3)`
    : '';
  if (siteScope) params.push(req.user.id);
  const { rows } = await db.query(
    `SELECT id FROM ${table} WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL ${siteScope} LIMIT 1`,
    params
  );
  if (!rows[0]) throw Object.assign(new Error(`Invalid ${field.replaceAll('_', ' ')}`), { statusCode: 400 });
  return id;
}

async function cleanEntityPayload(req, config, { partial = false, db = pool, existingSiteId = null } = {}) {
  const payload = {};
  for (const field of config.fields) {
    if (req.body[field] === undefined) continue;
    if (JSON_FIELDS.has(field)) payload[field] = field === 'related_entities' || field === 'metadata'
      ? jsonObject(req.body[field])
      : jsonArray(req.body[field]);
    else if (ARRAY_FIELDS.has(field)) payload[field] = normalizeIntArray(req.body[field]);
    else if (DATE_FIELDS.has(field)) payload[field] = storedDate(req.body[field]);
    else if (TIMESTAMP_FIELDS.has(field)) payload[field] = cleanTimestamp(req.body[field]);
    else if (NUMBER_FIELDS.has(field)) payload[field] = field === 'case_year'
      ? (Number.parseInt(req.body[field], 10) || null)
      : Math.max(Number(req.body[field]) || 0, 0);
    else if (ID_FIELDS.has(field)) payload[field] = parsePositiveId(req.body[field]);
    else if (UPPER_FIELDS.has(field)) payload[field] = upper(req.body[field]);
    else payload[field] = text(req.body[field], ['summary','notes','conditions','findings','non_conformities','draft_reply','final_reply'].includes(field) ? 20000 : 1000);
  }
  if (!partial) {
    for (const required of config.required) {
      if (!payload[required]) throw Object.assign(new Error(`${required.replaceAll('_', ' ')} is required`), { statusCode: 400 });
    }
  }
  if (payload.risk_level && !RISK_LEVELS.has(payload.risk_level)) payload.risk_level = 'MEDIUM';
  if (req.body.site_id !== undefined || !partial) {
    const siteId = await assertComplianceSiteAccess(req, {
      status: (status) => ({ json: ({ message }) => { throw Object.assign(new Error(message), { statusCode: status }); } }),
    }, req.body.site_id, { db });
    if (siteId === false) throw Object.assign(new Error('Access denied to site'), { statusCode: 403 });
    if (!isOrgAdmin(req.user) && !siteId) throw Object.assign(new Error('A site is required'), { statusCode: 400 });
    payload.site_id = siteId;
  }
  for (const field of ['authority_id', 'compliance_item_id', 'legal_case_id']) {
    if (payload[field]) payload[field] = await assertOwnedReference(req, field, payload[field], db);
  }
  for (const field of ['responsible_person_id', 'reviewing_manager_id', 'internal_owner_id']) {
    if (payload[field]) {
      const valid = await accessibleUser(req, payload[field], payload.site_id || existingSiteId || req.body.site_id, db);
      if (!valid) throw Object.assign(new Error(`Invalid ${field.replaceAll('_', ' ')}`), { statusCode: 400 });
      payload[field] = valid;
    }
  }
  return payload;
}

export const listComplianceEntity = (entity) => asyncHandler(async (req, res) => {
  const config = ENTITY_CONFIG[entity];
  if (!config) return res.status(404).json({ message: 'Register not found' });
  const { page, limit } = boundedPage(req);
  const params = [req.user.organization_id];
  const where = ['e.organization_id=$1', 'e.deleted_at IS NULL'];
  const scope = addComplianceSiteScope(req, 'e', params);
  if (scope) where.push(scope.replace(/^\s*AND\s*/, ''));
  if (req.query.site_id) {
    const siteId = await assertComplianceSiteAccess(req, res, req.query.site_id);
    if (siteId === false) return;
    params.push(siteId); where.push(`e.site_id=$${params.length}`);
  }
  if (req.query.status) {
    params.push(upper(req.query.status));
    where.push(`e.${entity === 'licence' ? 'renewal_status' : 'status'}=$${params.length}`);
  }
  if (req.query.risk && ['case','notice'].includes(entity)) { params.push(upper(req.query.risk)); where.push(`e.risk_level=$${params.length}`); }
  const dateColumn = ENTITY_DATE_COLUMN[entity];
  if (req.query.from) { params.push(entity === 'inspection' || entity === 'case' ? cleanTimestamp(req.query.from) : storedDate(req.query.from)); where.push(`e.${dateColumn} >= $${params.length}`); }
  if (req.query.to) { params.push(entity === 'inspection' || entity === 'case' ? cleanTimestamp(req.query.to) : storedDate(req.query.to)); where.push(`e.${dateColumn} <= $${params.length}`); }
  if (req.query.q) {
    params.push(`%${String(req.query.q).slice(0, 100).replace(/[\\%_]/g, '\\$&')}%`);
    const searchable = entity === 'licence' ? ['name','licence_number']
      : entity === 'case' ? ['title','case_number','opposite_party']
        : entity === 'notice' ? ['subject','notice_number','sender']
          : ['inspection_type','location'];
    where.push(`(${searchable.map((column) => `e.${column} ILIKE $${params.length} ESCAPE '\\'`).join(' OR ')})`);
  }
  const clause = where.join(' AND ');
  const count = await pool.query(`SELECT COUNT(*)::int AS total FROM ${config.table} e WHERE ${clause}`, params);
  params.push(limit, (page - 1) * limit);
  const authoritySelect = entity === 'case' ? 'NULL::text AS authority_name' : 'a.name AS authority_name';
  const authorityJoin = entity === 'case' ? '' : 'LEFT JOIN compliance_authorities a ON a.id=e.authority_id';
  const { rows } = await pool.query(
    `SELECT e.*,s.name AS site_name,${authoritySelect},
            owner.name AS responsible_name
       FROM ${config.table} e
       LEFT JOIN sites s ON s.id=e.site_id
       ${authorityJoin}
       LEFT JOIN users owner ON owner.id=${entity === 'case' ? 'e.internal_owner_id' : 'e.responsible_person_id'}
      WHERE ${clause}
      ORDER BY ${config.listOrder}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ [entity === 'case' ? 'cases' : `${entity}s`]: rows, pagination: { page, limit, total: count.rows[0].total, pages: Math.ceil(count.rows[0].total / limit) } });
});

export const getComplianceEntity = (entity) => asyncHandler(async (req, res) => {
  const config = ENTITY_CONFIG[entity];
  const id = parsePositiveId(req.params.id);
  const row = id ? await getScopedComplianceEntity(req, config.table, id) : null;
  if (!row) return res.status(404).json({ message: `${config.label.replaceAll('_', ' ')} not found` });
  const [documents, timeline, related, approvals] = await Promise.all([
    pool.query(
      `SELECT id,category,title,original_name,mime_type,file_size,version_no,tags,verification_status,
              approval_status,confidentiality,issue_date,expiry_date,issuing_authority,uploaded_by,created_at
         FROM compliance_documents
        WHERE organization_id=$1 AND entity_type=$2 AND entity_id=$3 AND deleted_at IS NULL
          ${isOrgAdmin(req.user) ? '' : `AND confidentiality <> 'RESTRICTED'`}
        ORDER BY created_at DESC`,
      [req.user.organization_id, config.label, id]
    ),
    entity === 'case'
      ? pool.query(
        `SELECT t.*,u.name AS created_by_name,assignee.name AS assigned_to_name
           FROM legal_case_timeline t
           LEFT JOIN users u ON u.id=t.created_by
           LEFT JOIN users assignee ON assignee.id=t.assigned_to
          WHERE t.organization_id=$1 AND t.legal_case_id=$2 ORDER BY t.event_date DESC`,
        [req.user.organization_id, id]
      )
      : Promise.resolve({ rows: [] }),
    entity === 'case'
      ? pool.query(
        `SELECT s.name AS site_name,owner.name AS responsible_name
           FROM legal_cases c
           LEFT JOIN sites s ON s.id=c.site_id AND s.organization_id=c.organization_id
           LEFT JOIN users owner ON owner.id=c.internal_owner_id AND owner.organization_id=c.organization_id
          WHERE c.id=$1 AND c.organization_id=$2`,
        [id, req.user.organization_id]
      )
      : Promise.resolve({ rows: [] }),
    entity === 'notice'
      ? pool.query(
        `SELECT a.*,requested.name AS requested_by_name,reviewed.name AS reviewed_by_name
           FROM compliance_approvals a
           LEFT JOIN users requested ON requested.id=a.requested_by
           LEFT JOIN users reviewed ON reviewed.id=a.reviewed_by
          WHERE a.organization_id=$1 AND a.entity_type='LEGAL_NOTICE' AND a.entity_id=$2
          ORDER BY a.requested_at DESC`,
        [req.user.organization_id, id]
      )
      : Promise.resolve({ rows: [] }),
  ]);
  res.json({ [entity]: { ...row, ...(related.rows[0] || {}) }, documents: documents.rows, timeline: timeline.rows, approvals: approvals.rows });
});

export const createComplianceEntity = (entity) => asyncHandler(async (req, res) => {
  const config = ENTITY_CONFIG[entity];
  try {
    const payload = await cleanEntityPayload(req, config);
    if (entity === 'case') {
      const settings = await settingsFor(req.user.organization_id);
      if (!jsonArray(settings.legal_case_stages).includes(payload.stage || 'PRE_LITIGATION')) {
        return res.status(400).json({ message: 'Case stage is not configured for this organisation' });
      }
    }
    Object.assign(payload, {
      organization_id: req.user.organization_id,
      created_by: req.user.id,
      updated_by: req.user.id,
    });
    if (entity === 'case') payload.case_code = text(req.body.case_code, 60) || codeFor('CASE');
    const fields = Object.keys(payload), values = Object.values(payload);
    const { rows } = await pool.query(
      `INSERT INTO ${config.table} (${fields.join(',')})
       VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
      values
    );
    await writeComplianceAudit(pool, req, {
      action: 'CREATE', entityType: config.label, entityId: rows[0].id,
      siteId: rows[0].site_id, newValue: rows[0],
    });
    res.status(201).json({ [entity]: rows[0] });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    if (error.code === '23505') return res.status(409).json({ message: `${config.label.replaceAll('_', ' ')} code already exists` });
    throw error;
  }
});

export const updateComplianceEntity = (entity) => asyncHandler(async (req, res) => {
  const config = ENTITY_CONFIG[entity];
  const id = parsePositiveId(req.params.id);
  const existing = id ? await getScopedComplianceEntity(req, config.table, id) : null;
  if (!existing) return res.status(404).json({ message: `${config.label.replaceAll('_', ' ')} not found` });
  try {
    const payload = await cleanEntityPayload(req, config, { partial: true, existingSiteId: existing.site_id });
    if (payload.site_id && payload.site_id !== existing.site_id) {
      for (const field of ['responsible_person_id', 'reviewing_manager_id', 'internal_owner_id']) {
        if (existing[field] && req.body[field] === undefined) {
          const stillValid = await accessibleUser(req, existing[field], payload.site_id);
          if (!stillValid) return res.status(409).json({ message: `Reassign ${field.replaceAll('_', ' ')} before changing the site` });
        }
      }
    }
    if (entity === 'case' && payload.stage) {
      const settings = await settingsFor(req.user.organization_id);
      if (!jsonArray(settings.legal_case_stages).includes(payload.stage)) {
        return res.status(400).json({ message: 'Case stage is not configured for this organisation' });
      }
    }
    if (!Object.keys(payload).length) return res.status(400).json({ message: 'Nothing to update' });
    payload.updated_by = req.user.id;
    const update = sqlUpdate(payload);
    const { rows } = await pool.query(
      `UPDATE ${config.table} SET ${update.set},updated_at=NOW()
        WHERE id=$${update.values.length + 1} AND organization_id=$${update.values.length + 2}
        RETURNING *`,
      [...update.values, id, req.user.organization_id]
    );
    await writeComplianceAudit(pool, req, {
      action: 'UPDATE', entityType: config.label, entityId: id, siteId: existing.site_id,
      previousValue: existing, newValue: rows[0], reason: req.body.reason,
    });
    res.json({ [entity]: rows[0] });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    throw error;
  }
});

export const deleteComplianceEntity = (entity) => asyncHandler(async (req, res) => {
  const config = ENTITY_CONFIG[entity];
  const id = parsePositiveId(req.params.id);
  const existing = id ? await getScopedComplianceEntity(req, config.table, id) : null;
  if (!existing) return res.status(404).json({ message: `${config.label.replaceAll('_', ' ')} not found` });
  const reason = requireReason(req.body.reason);
  await pool.query(`UPDATE ${config.table} SET deleted_at=NOW(),updated_by=$1,updated_at=NOW() WHERE id=$2 AND organization_id=$3`, [req.user.id, id, req.user.organization_id]);
  await writeComplianceAudit(pool, req, { action: 'DELETE', entityType: config.label, entityId: id, siteId: existing.site_id, previousValue: existing, reason });
  res.json({ success: true });
});

export const updateLegalNoticeStatus = asyncHandler(async (req, res) => {
  const noticeId = parsePositiveId(req.params.id);
  const target = upper(req.body.status);
  const notice = noticeId ? await getScopedComplianceEntity(req, 'legal_notices', noticeId) : null;
  if (!notice) return res.status(404).json({ message: 'Legal notice not found' });
  const settings = await settingsFor(req.user.organization_id);
  const allowed = settings.notice_status_transitions?.[notice.status] || NOTICE_TRANSITIONS[notice.status] || [];
  if (target !== notice.status && !allowed.includes(target)) {
    return res.status(409).json({ message: `Notice cannot move from ${notice.status} to ${target}` });
  }
  if (target === 'REPLY_SUBMITTED' && !isOrgAdmin(req.user)) {
    return res.status(403).json({ message: 'A legal reply must be approved before it is marked submitted' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (target === 'APPROVAL_PENDING' && !isOrgAdmin(req.user)) {
      if (!notice.draft_reply) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: 'Save a draft reply before requesting approval' });
      }
      const { rows: approvals } = await client.query(
        `INSERT INTO compliance_approvals
          (organization_id,entity_type,entity_id,action_type,requested_by,assigned_approver_id,request_comment)
         VALUES ($1,'LEGAL_NOTICE',$2,'LEGAL_REPLY',$3,$4,$5)
         ON CONFLICT (organization_id,entity_type,entity_id,action_type)
           WHERE status='PENDING' AND entity_id IS NOT NULL
         DO UPDATE SET request_comment=EXCLUDED.request_comment,requested_by=EXCLUDED.requested_by
         RETURNING *`,
        [req.user.organization_id, noticeId, req.user.id, notice.reviewing_manager_id, text(req.body.comment)]
      );
      await client.query(
        `UPDATE legal_notices SET status='APPROVAL_PENDING',updated_by=$1,updated_at=NOW()
          WHERE id=$2 AND organization_id=$3`,
        [req.user.id, noticeId, req.user.organization_id]
      );
      await writeComplianceAudit(client, req, {
        action: 'LEGAL_REPLY_SUBMIT_APPROVAL', entityType: 'LEGAL_NOTICE', entityId: noticeId,
        siteId: notice.site_id, previousValue: { status: notice.status },
        newValue: { status: 'APPROVAL_PENDING', approval_id: approvals[0].id },
        reason: req.body.comment,
      });
      await client.query('COMMIT');
      return res.status(202).json({ approval: approvals[0], status: 'APPROVAL_PENDING' });
    }
    const { rows } = await client.query(
      `UPDATE legal_notices SET status=$1,updated_by=$2,updated_at=NOW()
        WHERE id=$3 AND organization_id=$4 RETURNING *`,
      [target, req.user.id, noticeId, req.user.organization_id]
    );
    await writeComplianceAudit(client, req, {
      action: 'NOTICE_STATUS_CHANGE', entityType: 'LEGAL_NOTICE', entityId: noticeId,
      siteId: notice.site_id, previousValue: { status: notice.status },
      newValue: { status: target }, reason: req.body.comment,
    });
    await client.query('COMMIT');
    res.json({ notice: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

export const addLegalCaseTimeline = asyncHandler(async (req, res) => {
  const caseId = parsePositiveId(req.params.id);
  const legalCase = caseId ? await getScopedComplianceEntity(req, 'legal_cases', caseId) : null;
  if (!legalCase) return res.status(404).json({ message: 'Legal case not found' });
  if (!text(req.body.title, 300) || !req.body.event_date) return res.status(400).json({ message: 'Title and event date are required' });
  const assigned = req.body.assigned_to ? await accessibleUser(req, parsePositiveId(req.body.assigned_to), legalCase.site_id) : null;
  if (req.body.assigned_to && !assigned) return res.status(400).json({ message: 'Invalid next-action assignee' });
  const { rows } = await pool.query(
    `INSERT INTO legal_case_timeline
      (organization_id,legal_case_id,event_type,event_date,title,description,outcome,next_action,
       next_action_due_date,assigned_to,advocate,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [req.user.organization_id, caseId, upper(req.body.event_type, 'UPDATE'), cleanTimestamp(req.body.event_date),
      text(req.body.title, 300), text(req.body.description, 20000), text(req.body.outcome, 10000),
      text(req.body.next_action, 5000), cleanTimestamp(req.body.next_action_due_date), assigned,
      text(req.body.advocate, 255), req.user.id]
  );
  if (upper(req.body.event_type) === 'HEARING') {
    await pool.query(
      `UPDATE legal_cases SET last_hearing_date=$1,next_hearing_date=$2,updated_by=$3,updated_at=NOW()
        WHERE id=$4 AND organization_id=$5`,
      [cleanTimestamp(req.body.event_date), cleanTimestamp(req.body.next_action_due_date), req.user.id, caseId, req.user.organization_id]
    );
  }
  await writeComplianceAudit(pool, req, { action: 'TIMELINE_CREATE', entityType: 'LEGAL_CASE', entityId: caseId, siteId: legalCase.site_id, newValue: rows[0] });
  res.status(201).json({ timeline_item: rows[0] });
});

export const getMyComplianceTasks = asyncHandler(async (req, res) => {
  const canViewLegal = await hasModuleRead(req, 'legal');
  const params = [req.user.organization_id, req.user.id];
  const scopeFor = (alias) => isOrgAdmin(req.user) ? '' : `AND ${alias}.site_id IN (SELECT site_id FROM user_sites WHERE user_id=$2)`;
  const [items, approvals, cases, notices, inspections] = await Promise.all([
    pool.query(
      `SELECT i.*,s.name AS site_name,(i.current_due_date-CURRENT_DATE)::int AS days_remaining
         FROM compliance_items i LEFT JOIN sites s ON s.id=i.site_id
        WHERE i.organization_id=$1 AND i.deleted_at IS NULL AND i.assigned_to=$2
          AND i.status NOT IN ('COMPLETED','CANCELLED','NOT_APPLICABLE') ${scopeFor('i')}
        ORDER BY i.current_due_date NULLS LAST LIMIT 100`,
      params
    ),
    pool.query(
      `SELECT a.*,i.title AS compliance_title FROM compliance_approvals a
       LEFT JOIN compliance_items i ON i.id=a.compliance_item_id
       WHERE a.organization_id=$1 AND a.status='PENDING' AND a.entity_type='COMPLIANCE'
         AND ($3::boolean=TRUE OR a.assigned_approver_id=$2)
         ${isOrgAdmin(req.user) ? '' : `AND i.site_id IN (SELECT site_id FROM user_sites WHERE user_id=$2)`}
       ORDER BY a.requested_at`,
      [req.user.organization_id, req.user.id, isOrgAdmin(req.user)]
    ),
    canViewLegal ? pool.query(`SELECT c.id,c.title,c.next_hearing_date,c.risk_level,c.stage,c.status FROM legal_cases c WHERE c.organization_id=$1 AND c.deleted_at IS NULL AND c.internal_owner_id=$2 AND c.status NOT IN ('CLOSED','SETTLED') ${scopeFor('c')} ORDER BY c.next_hearing_date NULLS LAST LIMIT 50`, params) : Promise.resolve({ rows: [] }),
    canViewLegal ? pool.query(`SELECT n.id,n.subject,n.reply_due_date,n.risk_level,n.status FROM legal_notices n WHERE n.organization_id=$1 AND n.deleted_at IS NULL AND n.responsible_person_id=$2 AND n.status NOT IN ('CLOSED','REPLY_SUBMITTED') ${scopeFor('n')} ORDER BY n.reply_due_date NULLS LAST LIMIT 50`, params) : Promise.resolve({ rows: [] }),
    pool.query(`SELECT x.id,x.inspection_type,x.scheduled_at,x.status FROM compliance_inspections x WHERE x.organization_id=$1 AND x.deleted_at IS NULL AND x.responsible_person_id=$2 AND x.status NOT IN ('COMPLETED','CANCELLED') ${scopeFor('x')} ORDER BY x.scheduled_at LIMIT 50`, params),
  ]);
  res.json({ items: items.rows, approvals: approvals.rows, legal_cases: cases.rows, notices: notices.rows, inspections: inspections.rows });
});

export const complianceAuditLog = asyncHandler(async (req, res) => {
  const canViewLegal = await hasModuleRead(req, 'legal');
  const { page, limit } = boundedPage(req);
  const params = [req.user.organization_id];
  const where = ['a.organization_id=$1'];
  if (!canViewLegal) where.push(`a.entity_type NOT IN ('LEGAL_CASE','LEGAL_NOTICE')`);
  if (req.query.entity_type) { params.push(upper(req.query.entity_type)); where.push(`a.entity_type=$${params.length}`); }
  if (req.query.entity_id) { params.push(parsePositiveId(req.query.entity_id)); where.push(`a.entity_id=$${params.length}`); }
  if (req.query.site_id) {
    const siteId = await assertComplianceSiteAccess(req, res, req.query.site_id);
    if (siteId === false) return;
    params.push(siteId); where.push(`a.site_id=$${params.length}`);
  }
  if (!isOrgAdmin(req.user)) {
    params.push(req.user.id);
    where.push(`a.site_id IN (SELECT site_id FROM user_sites WHERE user_id=$${params.length})`);
  }
  const count = await pool.query(`SELECT COUNT(*)::int AS total FROM compliance_audit_log a WHERE ${where.join(' AND ')}`, params);
  params.push(limit, (page - 1) * limit);
  const { rows } = await pool.query(
    `SELECT a.*,u.name AS user_name,s.name AS site_name
       FROM compliance_audit_log a
       LEFT JOIN users u ON u.id=a.user_id LEFT JOIN sites s ON s.id=a.site_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ audit: rows, pagination: { page, limit, total: count.rows[0].total, pages: Math.ceil(count.rows[0].total / limit) } });
});

export const complianceNotifications = asyncHandler(async (req, res) => {
  const canViewLegal = await hasModuleRead(req, 'legal');
  const legalOnlyEndpoint = req.path.startsWith('/legal-notifications');
  const params = [req.user.organization_id, req.user.id];
  const where = [
    'n.organization_id=$1',
    'n.recipient_user_id=$2',
    `n.channel='DASHBOARD'`,
    `n.status='DELIVERED'`,
  ];
  if (legalOnlyEndpoint) where.push(`n.entity_type IN ('LEGAL_CASE','LEGAL_NOTICE')`);
  else if (!canViewLegal) where.push(`n.entity_type NOT IN ('LEGAL_CASE','LEGAL_NOTICE')`);
  if (req.query.site_id) {
    const siteId = await assertComplianceSiteAccess(req, res, req.query.site_id);
    if (siteId === false) return;
    params.push(siteId);
    where.push(`n.site_id=$${params.length}`);
  }
  const clause = where.join(' AND ');
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE n.read_at IS NULL)::int AS unread_count
       FROM compliance_notification_log n
      WHERE ${clause}`,
    params
  );
  const { rows } = await pool.query(
    `SELECT n.*,s.name AS site_name
       FROM compliance_notification_log n
       LEFT JOIN sites s ON s.id=n.site_id AND s.organization_id=n.organization_id
      WHERE ${clause}
      ORDER BY n.read_at NULLS FIRST,n.created_at DESC
      LIMIT 50`,
    params
  );
  const actionPath = (row) => {
    if (row.entity_type === 'LEGAL_CASE') return `/legal/cases/${row.entity_id}`;
    if (row.entity_type === 'LEGAL_NOTICE') return `/legal/notices/${row.entity_id}`;
    if (row.entity_type === 'LICENCE') return '/compliance/licences';
    if (row.entity_type === 'INSPECTION') return '/legal/inspections';
    if (row.entity_type === 'DOCUMENT') return '/compliance/documents';
    return `/compliance/register/${row.entity_id}`;
  };
  res.json({
    notifications: rows.map((row) => ({ ...row, action_path: actionPath(row) })),
    unread_count: countRows[0]?.unread_count || 0,
  });
});

export const markComplianceNotificationRead = asyncHandler(async (req, res) => {
  const notificationId = parsePositiveId(req.params.notificationId);
  if (!notificationId) return res.status(400).json({ message: 'Invalid notification ID' });
  const canViewLegal = await hasModuleRead(req, 'legal');
  const legalOnlyEndpoint = req.path.startsWith('/legal-notifications');
  const entityScope = legalOnlyEndpoint
    ? `AND entity_type IN ('LEGAL_CASE','LEGAL_NOTICE')`
    : canViewLegal ? '' : `AND entity_type NOT IN ('LEGAL_CASE','LEGAL_NOTICE')`;
  const { rows } = await pool.query(
    `UPDATE compliance_notification_log
        SET read_at=COALESCE(read_at,NOW())
      WHERE id=$1 AND organization_id=$2 AND recipient_user_id=$3
        AND channel='DASHBOARD' ${entityScope}
        AND ($4::boolean=TRUE OR site_id IN (
          SELECT site_id FROM user_sites WHERE user_id=$3
        ))
      RETURNING id,read_at,entity_type`,
    [notificationId, req.user.organization_id, req.user.id, isOrgAdmin(req.user)]
  );
  const notification = rows[0];
  if (!notification) return res.status(404).json({ message: 'Notification not found' });
  res.json({ notification });
});

export const markAllComplianceNotificationsRead = asyncHandler(async (req, res) => {
  const canViewLegal = await hasModuleRead(req, 'legal');
  const legalOnlyEndpoint = req.path.startsWith('/legal-notifications');
  const params = [req.user.organization_id, req.user.id];
  const where = [
    'organization_id=$1', 'recipient_user_id=$2', `channel='DASHBOARD'`,
    `status='DELIVERED'`, 'read_at IS NULL',
  ];
  if (legalOnlyEndpoint) where.push(`entity_type IN ('LEGAL_CASE','LEGAL_NOTICE')`);
  else if (!canViewLegal) where.push(`entity_type NOT IN ('LEGAL_CASE','LEGAL_NOTICE')`);
  if (req.body.site_id) {
    const siteId = await assertComplianceSiteAccess(req, res, req.body.site_id);
    if (siteId === false) return;
    params.push(siteId);
    where.push(`site_id=$${params.length}`);
  }
  const result = await pool.query(
    `UPDATE compliance_notification_log SET read_at=NOW() WHERE ${where.join(' AND ')}`,
    params
  );
  res.json({ updated: result.rowCount || 0 });
});

export const complianceReports = asyncHandler(async (req, res) => {
  const reportType = upper(req.query.report_type, 'COMPLIANCE_SUMMARY');
  const legalEndpoint = req.path.endsWith('/legal-reports');
  const legalReportTypes = new Set([
    'LEGAL_CASE_SUMMARY', 'LEGAL_FINANCIAL_EXPOSURE', 'HEARING_CALENDAR',
    'NOTICE_REPLY', 'COMPLIANCE_AUDIT_TRAIL',
  ]);
  const complianceReportTypes = new Set([
    'COMPLIANCE_SUMMARY', 'UPCOMING_DUE', 'OVERDUE_COMPLIANCE', 'COMPLIANCE_COMPLETION',
    'COMPLIANCE_BY_PROJECT', 'COMPLIANCE_BY_AUTHORITY', 'COMPLIANCE_BY_RESPONSIBLE_USER',
    'COMPLIANCE_RISK',
    'APPROVAL_EXPIRY', 'LICENCE_RENEWAL', 'DOCUMENT_EXPIRY',
    'INSPECTION_CORRECTIVE_ACTION', 'PENALTY_FEE',
  ]);
  if ((legalEndpoint && !legalReportTypes.has(reportType)) || (!legalEndpoint && !complianceReportTypes.has(reportType))) {
    return res.status(403).json({ message: 'This report type requires a different module permission' });
  }
  const specialised = {
    APPROVAL_EXPIRY: {
      table: 'compliance_licences', alias: 'r', date: 'expiry_date', status: 'renewal_status',
      authority: 'authority_id', responsible: 'responsible_person_id',
      select: `r.name,r.licence_type,r.licence_number,r.issue_date,r.expiry_date,r.renewal_status,
               r.renewal_cost,r.security_deposit,r.verification_status,
               a.name AS authority_name,u.name AS responsible_user,
               (r.expiry_date-CURRENT_DATE)::int AS days_remaining`,
      joins: `LEFT JOIN compliance_authorities a ON a.id=r.authority_id AND a.organization_id=r.organization_id
              LEFT JOIN users u ON u.id=r.responsible_person_id AND u.organization_id=r.organization_id`,
    },
    LICENCE_RENEWAL: {
      table: 'compliance_licences', alias: 'r', date: 'expiry_date', status: 'renewal_status',
      authority: 'authority_id', responsible: 'responsible_person_id',
      select: `r.name,r.licence_type,r.licence_number,r.expiry_date,r.renewal_application_date,
               r.renewal_status,r.renewal_cost,r.verification_status,
               a.name AS authority_name,u.name AS responsible_user,
               (r.expiry_date-CURRENT_DATE)::int AS days_remaining`,
      joins: `LEFT JOIN compliance_authorities a ON a.id=r.authority_id AND a.organization_id=r.organization_id
              LEFT JOIN users u ON u.id=r.responsible_person_id AND u.organization_id=r.organization_id`,
    },
    LEGAL_CASE_SUMMARY: {
      table: 'legal_cases', alias: 'r', date: 'next_hearing_date', status: 'status', risk: 'risk_level',
      responsible: 'internal_owner_id',
      select: `r.case_code,r.title,r.case_type,r.court_authority,r.case_number,r.opposite_party,
               r.advocate,r.stage,r.status,r.risk_level,r.next_hearing_date,r.claim_amount,
               r.financial_exposure,u.name AS responsible_user`,
      joins: `LEFT JOIN users u ON u.id=r.internal_owner_id AND u.organization_id=r.organization_id`,
    },
    LEGAL_FINANCIAL_EXPOSURE: {
      table: 'legal_cases', alias: 'r', date: 'next_hearing_date', status: 'status', risk: 'risk_level',
      responsible: 'internal_owner_id',
      select: `r.case_code,r.title,r.case_type,r.opposite_party,r.stage,r.status,r.risk_level,
               r.claim_amount,r.financial_exposure,r.next_hearing_date,r.advocate`,
      joins: '',
    },
    HEARING_CALENDAR: {
      table: 'legal_cases', alias: 'r', date: 'next_hearing_date', status: 'status', risk: 'risk_level',
      responsible: 'internal_owner_id',
      select: `r.id,r.case_code,r.title,r.case_type,r.court_authority,r.case_number,r.stage,r.status,
               r.risk_level,r.next_hearing_date,r.advocate,u.name AS responsible_user`,
      joins: `LEFT JOIN users u ON u.id=r.internal_owner_id AND u.organization_id=r.organization_id`,
      extra: 'r.next_hearing_date IS NOT NULL',
    },
    NOTICE_REPLY: {
      table: 'legal_notices', alias: 'r', date: 'reply_due_date', status: 'status', risk: 'risk_level',
      authority: 'authority_id', responsible: 'responsible_person_id',
      select: `r.notice_number,r.notice_type,r.direction,r.sender,r.recipient,r.subject,r.notice_date,
               r.reply_due_date,r.status,r.risk_level,r.amount_involved,r.courier_tracking,
               u.name AS responsible_user,(r.reply_due_date-CURRENT_DATE)::int AS days_remaining`,
      joins: `LEFT JOIN users u ON u.id=r.responsible_person_id AND u.organization_id=r.organization_id`,
    },
    DOCUMENT_EXPIRY: {
      table: 'compliance_documents', alias: 'r', date: 'expiry_date', status: 'verification_status',
      responsible: 'uploaded_by',
      select: `r.entity_type,r.entity_id,r.category,r.title,r.original_name,r.version_no,
               r.verification_status,r.confidentiality,r.issue_date,r.expiry_date,r.issuing_authority,
               u.name AS responsible_user,(r.expiry_date-CURRENT_DATE)::int AS days_remaining`,
      joins: `LEFT JOIN users u ON u.id=r.uploaded_by AND u.organization_id=r.organization_id`,
      extra: 'r.expiry_date IS NOT NULL',
    },
    INSPECTION_CORRECTIVE_ACTION: {
      table: 'compliance_inspections', alias: 'r', date: 'scheduled_at', status: 'status',
      authority: 'authority_id', responsible: 'responsible_person_id',
      select: `r.inspection_type,r.scheduled_at,r.location,r.meeting_mode,r.status,r.findings,
               r.non_conformities,r.corrective_actions,r.follow_up_date,u.name AS responsible_user`,
      joins: `LEFT JOIN users u ON u.id=r.responsible_person_id AND u.organization_id=r.organization_id`,
    },
    COMPLIANCE_AUDIT_TRAIL: {
      table: 'compliance_audit_log', alias: 'r', date: 'created_at',
      responsible: 'user_id',
      select: `r.action,r.entity_type,r.entity_id,r.reason,r.previous_value,r.new_value,r.ip_address,
               r.created_at,u.name AS responsible_user`,
      joins: `LEFT JOIN users u ON u.id=r.user_id AND u.organization_id=r.organization_id`,
      noDeleted: true,
    },
    PENALTY_FEE: {
      table: 'compliance_finance_links', alias: 'r', date: 'created_at',
      responsible: 'linked_by',
      select: `i.compliance_code,i.title,r.cost_type,r.notes,r.expense_id,e.date AS expense_date,
               e.debit,e.credit,e.category,e.remark,u.name AS responsible_user,r.created_at`,
      joins: `JOIN compliance_items i ON i.id=r.compliance_item_id AND i.organization_id=r.organization_id
              JOIN expenses e ON e.id=r.expense_id AND e.site_id=r.site_id
              LEFT JOIN users u ON u.id=r.linked_by AND u.organization_id=r.organization_id`,
      noDeleted: true,
    },
  }[reportType];

  if (specialised) {
    const params = [req.user.organization_id];
    const alias = specialised.alias;
    const where = [`${alias}.organization_id=$1`];
    if (!specialised.noDeleted) where.push(`${alias}.deleted_at IS NULL`);
    if (specialised.extra) where.push(specialised.extra);
    if (legalEndpoint && reportType === 'COMPLIANCE_AUDIT_TRAIL') {
      where.push(`${alias}.entity_type IN ('LEGAL_CASE','LEGAL_NOTICE')`);
    }
    if (!legalEndpoint && reportType === 'DOCUMENT_EXPIRY') {
      where.push(`${alias}.entity_type NOT IN ('LEGAL_CASE','LEGAL_NOTICE')`);
    }
    const scope = addComplianceSiteScope(req, alias, params);
    if (scope) where.push(scope.replace(/^\s*AND\s*/, ''));
    if (req.query.site_id) {
      const siteId = await assertComplianceSiteAccess(req, res, req.query.site_id);
      if (siteId === false) return;
      params.push(siteId); where.push(`${alias}.site_id=$${params.length}`);
    }
    if (req.query.from) { params.push(storedDate(req.query.from)); where.push(`${alias}.${specialised.date}::date >= $${params.length}`); }
    if (req.query.to) { params.push(storedDate(req.query.to)); where.push(`${alias}.${specialised.date}::date <= $${params.length}`); }
    if (req.query.status && specialised.status) { params.push(upper(req.query.status)); where.push(`${alias}.${specialised.status}=$${params.length}`); }
    if (req.query.risk && specialised.risk) { params.push(upper(req.query.risk)); where.push(`${alias}.${specialised.risk}=$${params.length}`); }
    if (req.query.authority_id && specialised.authority) {
      params.push(parsePositiveId(req.query.authority_id));
      where.push(`${alias}.${specialised.authority}=$${params.length}`);
    }
    if (req.query.responsible_user_id && specialised.responsible) {
      params.push(parsePositiveId(req.query.responsible_user_id));
      where.push(`${alias}.${specialised.responsible}=$${params.length}`);
    }
    const { rows } = await pool.query(
      `SELECT ${specialised.select},s.name AS site_name
         FROM ${specialised.table} ${alias}
         LEFT JOIN sites s ON s.id=${alias}.site_id AND s.organization_id=${alias}.organization_id
         ${specialised.joins}
        WHERE ${where.join(' AND ')}
        ORDER BY ${alias}.${specialised.date} DESC NULLS LAST
        LIMIT 5000`,
      params
    );
    const financialFields = ['financial_exposure','amount_involved','renewal_cost','debit','credit'];
    const summary = rows.reduce((acc, row) => {
      acc.total += 1;
      if (Number(row.days_remaining) < 0) acc.overdue += 1;
      acc.financial_impact += financialFields.reduce((sum, field) => sum + (Number(row[field]) || 0), 0);
      return acc;
    }, { total: 0, overdue: 0, financial_impact: 0, by_status: {}, by_risk: {} });
    return res.json({
      report: {
        report_type: reportType, generated_at: new Date().toISOString(), summary,
        columns: rows[0] ? Object.keys(rows[0]) : [], rows,
      },
    });
  }

  const params = [req.user.organization_id];
  const where = ['i.organization_id=$1', 'i.deleted_at IS NULL'];
  const scope = addComplianceSiteScope(req, 'i', params);
  if (scope) where.push(scope.replace(/^\s*AND\s*/, ''));
  if (req.query.site_id) {
    const siteId = await assertComplianceSiteAccess(req, res, req.query.site_id);
    if (siteId === false) return;
    params.push(siteId); where.push(`i.site_id=$${params.length}`);
  }
  if (req.query.from) { params.push(storedDate(req.query.from)); where.push(`i.current_due_date >= $${params.length}`); }
  if (req.query.to) { params.push(storedDate(req.query.to)); where.push(`i.current_due_date <= $${params.length}`); }
  if (req.query.status) { params.push(upper(req.query.status)); where.push(`i.status=$${params.length}`); }
  if (req.query.risk) { params.push(upper(req.query.risk)); where.push(`i.risk_level=$${params.length}`); }
  if (req.query.category) { params.push(upper(req.query.category)); where.push(`i.category=$${params.length}`); }
  if (req.query.authority_id) { params.push(parsePositiveId(req.query.authority_id)); where.push(`i.authority_id=$${params.length}`); }
  if (req.query.responsible_user_id) { params.push(parsePositiveId(req.query.responsible_user_id)); where.push(`i.assigned_to=$${params.length}`); }
  if (reportType === 'UPCOMING_DUE') where.push(`i.current_due_date >= CURRENT_DATE AND i.status NOT IN ('COMPLETED','CANCELLED','NOT_APPLICABLE')`);
  if (reportType === 'OVERDUE_COMPLIANCE') where.push(`i.current_due_date < CURRENT_DATE AND i.status NOT IN ('COMPLETED','CANCELLED','NOT_APPLICABLE')`);
  if (reportType === 'COMPLIANCE_COMPLETION') where.push(`i.status='COMPLETED'`);
  const aggregateDimension = {
    COMPLIANCE_BY_PROJECT: `COALESCE(s.name,'Organisation-wide')`,
    COMPLIANCE_BY_AUTHORITY: `COALESCE(a.name,i.department,'Unspecified')`,
    COMPLIANCE_BY_RESPONSIBLE_USER: `COALESCE(u.name,'Unassigned')`,
    COMPLIANCE_RISK: `COALESCE(i.risk_level,'UNSPECIFIED')`,
  }[reportType];
  if (aggregateDimension) {
    const { rows } = await pool.query(
      `SELECT ${aggregateDimension} AS group_name,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE i.status='COMPLETED')::int AS completed,
              COUNT(*) FILTER (
                WHERE i.current_due_date<CURRENT_DATE
                  AND i.status NOT IN ('COMPLETED','CANCELLED','NOT_APPLICABLE')
              )::int AS overdue,
              COUNT(*) FILTER (WHERE i.risk_level IN ('HIGH','CRITICAL'))::int AS high_risk,
              COALESCE(SUM(i.financial_impact),0) AS financial_impact,
              ROUND(
                COUNT(*) FILTER (WHERE i.status='COMPLETED')::numeric * 100
                / NULLIF(COUNT(*),0), 1
              ) AS completion_percent
         FROM compliance_items i
         LEFT JOIN sites s ON s.id=i.site_id AND s.organization_id=i.organization_id
         LEFT JOIN compliance_authorities a ON a.id=i.authority_id AND a.organization_id=i.organization_id
         LEFT JOIN users u ON u.id=i.assigned_to AND u.organization_id=i.organization_id
        WHERE ${where.join(' AND ')}
        GROUP BY ${aggregateDimension}
        ORDER BY total DESC,group_name
        LIMIT 5000`,
      params
    );
    const summary = rows.reduce((acc, row) => ({
      total: acc.total + Number(row.total || 0),
      completed: acc.completed + Number(row.completed || 0),
      overdue: acc.overdue + Number(row.overdue || 0),
      high_risk: acc.high_risk + Number(row.high_risk || 0),
      financial_impact: acc.financial_impact + Number(row.financial_impact || 0),
    }), { total: 0, completed: 0, overdue: 0, high_risk: 0, financial_impact: 0 });
    return res.json({
      report: {
        report_type: reportType,
        generated_at: new Date().toISOString(),
        summary,
        columns: ['group_name','total','completed','overdue','high_risk','completion_percent','financial_impact'],
        rows,
      },
    });
  }
  const { rows } = await pool.query(
    `SELECT i.compliance_code,i.title,i.category,i.compliance_type,i.status,i.risk_level,i.priority,
            i.original_due_date,i.current_due_date,i.last_completed_date,i.financial_impact,
            s.name AS site_name,a.name AS authority_name,u.name AS responsible_user,
            (i.current_due_date-CURRENT_DATE)::int AS days_remaining
       FROM compliance_items i
       LEFT JOIN sites s ON s.id=i.site_id
       LEFT JOIN compliance_authorities a ON a.id=i.authority_id
       LEFT JOIN users u ON u.id=i.assigned_to
      WHERE ${where.join(' AND ')}
      ORDER BY i.current_due_date NULLS LAST,i.id DESC
      LIMIT 5000`,
    params
  );
  const summary = rows.reduce((acc, row) => {
    acc.total += 1;
    acc.financial_impact += Number(row.financial_impact) || 0;
    acc.by_status[row.status] = (acc.by_status[row.status] || 0) + 1;
    acc.by_risk[row.risk_level] = (acc.by_risk[row.risk_level] || 0) + 1;
    if (row.days_remaining < 0 && !TERMINAL_STATUSES.has(row.status)) acc.overdue += 1;
    return acc;
  }, { total: 0, overdue: 0, financial_impact: 0, by_status: {}, by_risk: {} });
  res.json({ report: { report_type: reportType, generated_at: new Date().toISOString(), summary, columns: [
    'compliance_code','title','category','compliance_type','status','risk_level','priority',
    'site_name','authority_name','responsible_user','original_due_date','current_due_date',
    'last_completed_date','days_remaining','financial_impact',
  ], rows } });
});
