import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { hashPassword } from '../config/jwt.js';
import userModel from '../models/User.model.js';
import { generateUniqueSubdomain, isValidSubdomain } from '../utils/subdomain.js';
import { sendRegistrationEmail, sendPlanPurchaseEmail, sendOwnerNotificationEmail } from '../utils/mailer.js';

const OWNER_ORGANIZATION_SNAPSHOT_QUERY = `
  SELECT
    o.id, o.name, o.subdomain, o.is_active, o.created_at,
    sa.name AS super_admin_name, sa.email AS super_admin_email,
    (SELECT COUNT(*)::int FROM users u WHERE u.organization_id = o.id) AS user_count,
    (SELECT COUNT(*)::int FROM sites s WHERE s.organization_id = o.id) AS site_count,
    (SELECT ok.status FROM organization_kyc ok WHERE ok.organization_id = o.id LIMIT 1) AS kyc_status,
    current_sub.id AS subscription_id,
    current_sub.plan_id, current_sub.plan_name, current_sub.price_inr,
    current_sub.site_limit, current_sub.max_users,
    current_sub.current_period_start, current_sub.current_period_end,
    latest_sub.status AS latest_subscription_status,
    latest_sub.current_period_end AS latest_subscription_end,
    latest_sub.created_at AS latest_subscription_created_at
  FROM organizations o
  LEFT JOIN LATERAL (
    SELECT u.name, u.email
      FROM users u
     WHERE u.organization_id = o.id AND u.role = 'super_admin'
     ORDER BY u.created_at ASC
     LIMIT 1
  ) sa ON true
  LEFT JOIN LATERAL (
    SELECT s.id, s.plan_id, p.name AS plan_name, p.price_inr, p.site_limit, p.max_users,
           s.current_period_start, s.current_period_end
      FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id
     WHERE s.organization_id = o.id
       AND s.status = 'active'
       AND s.current_period_end > NOW()
     ORDER BY s.current_period_end DESC
     LIMIT 1
  ) current_sub ON true
  LEFT JOIN LATERAL (
    SELECT s.status, s.current_period_end, s.created_at
      FROM subscriptions s
     WHERE s.organization_id = o.id
     ORDER BY s.created_at DESC
     LIMIT 1
  ) latest_sub ON true
  ORDER BY o.created_at DESC
`;

const writeOwnerAudit = async (executor, req, {
  action,
  summary,
  organizationId = null,
  organizationName = null,
  metadata = {},
}) => {
  await executor.query(
    `INSERT INTO platform_owner_audit_log
       (actor_user_id, organization_id, organization_name, action, summary, metadata,
        request_id, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
    [
      req.user?.id ?? null,
      organizationId,
      organizationName,
      action,
      summary,
      JSON.stringify(metadata),
      req.requestId || null,
      req.ip || null,
      req.get?.('user-agent') || null,
    ],
  );
};

const loadOwnerOrganizationSnapshots = async () => {
  const { rows } = await pool.query(OWNER_ORGANIZATION_SNAPSHOT_QUERY);
  return rows;
};

const classifyOrganizationHealth = (org) => {
  const end = org.current_period_end ? new Date(org.current_period_end) : null;
  const daysLeft = end ? Math.ceil((end.getTime() - Date.now()) / 86400000) : 0;
  const siteLimit = Number(org.site_limit || 0);
  const userLimit = org.max_users == null ? null : Number(org.max_users);
  const siteCapacityRisk = siteLimit > 0 && siteLimit < 999999 && Number(org.site_count) >= Math.max(1, Math.floor(siteLimit * 0.8));
  const userCapacityRisk = userLimit != null && userLimit > 0 && Number(org.user_count) >= Math.max(1, Math.floor(userLimit * 0.8));

  if (!org.is_active) return { status: 'disabled', label: 'Disabled', reasons: ['Organization is disabled'], daysLeft };
  if (!org.subscription_id && org.latest_subscription_status === 'pending') {
    return { status: 'payment_pending', label: 'Payment pending', reasons: ['Payment order has not been activated'], daysLeft };
  }
  if (!org.subscription_id) {
    return { status: 'expired', label: 'Subscription expired', reasons: ['No active subscription'], daysLeft };
  }
  if (daysLeft <= 7) return { status: 'renewal_urgent', label: 'Renewal due soon', reasons: [`Subscription ends in ${Math.max(0, daysLeft)} day${daysLeft === 1 ? '' : 's'}`], daysLeft };
  if (daysLeft <= 30) return { status: 'renewal', label: 'Renewal this month', reasons: [`Subscription ends in ${daysLeft} days`], daysLeft };
  if (org.kyc_status !== 'verified') {
    return { status: 'onboarding', label: 'Onboarding incomplete', reasons: [`Company KYC is ${org.kyc_status || 'pending'}`], daysLeft };
  }
  if (siteCapacityRisk || userCapacityRisk) {
    const reasons = [];
    if (siteCapacityRisk) reasons.push(`Sites at ${org.site_count}/${siteLimit}`);
    if (userCapacityRisk) reasons.push(`Users at ${org.user_count}/${userLimit}`);
    return { status: 'capacity', label: 'Near plan limit', reasons, daysLeft };
  }
  return { status: 'healthy', label: 'Healthy', reasons: [], daysLeft };
};

/** GET /owner/operations — launch operations view: tenant health, billing risk and audit activity. */
export const getOperations = asyncHandler(async (req, res) => {
  const [organizations, activityResult] = await Promise.all([
    loadOwnerOrganizationSnapshots(),
    pool.query(`
      SELECT a.id, a.action, a.summary, a.organization_id, a.organization_name,
             a.metadata, a.created_at, u.name AS actor_name
        FROM platform_owner_audit_log a
        LEFT JOIN users u ON u.id = a.actor_user_id
       ORDER BY a.created_at DESC
       LIMIT 12
    `),
  ]);

  const enriched = organizations.map((org) => ({
    ...org,
    health: classifyOrganizationHealth(org),
  }));
  const attentionPriority = {
    disabled: 0, expired: 1, payment_pending: 2, renewal_urgent: 3,
    renewal: 4, onboarding: 5, capacity: 6, healthy: 99,
  };
  const attention = enriched
    .filter((org) => org.health.status !== 'healthy')
    .sort((a, b) => (attentionPriority[a.health.status] - attentionPriority[b.health.status]) || (a.health.daysLeft - b.health.daysLeft))
    .slice(0, 12);

  const active = enriched.filter((org) => org.subscription_id);
  const expiring7d = active.filter((org) => org.health.daysLeft <= 7).length;
  const expiring30d = active.filter((org) => org.health.daysLeft <= 30).length;
  const expired = enriched.filter((org) => !org.subscription_id && org.latest_subscription_status === 'active').length;
  const pendingPayments = enriched.filter((org) => !org.subscription_id && org.latest_subscription_status === 'pending').length;
  const capacityRisks = enriched.filter((org) => org.health.status === 'capacity').length;
  const kycPending = enriched.filter((org) => org.kyc_status !== 'verified').length;
  const recentSignups = enriched.slice(0, 6);

  res.json({
    stats: {
      total_organizations: enriched.length,
      active_organizations: enriched.filter((org) => org.is_active).length,
      total_users: enriched.reduce((sum, org) => sum + Number(org.user_count || 0), 0),
      total_sites: enriched.reduce((sum, org) => sum + Number(org.site_count || 0), 0),
      subscribed_organizations: active.length,
      mrr_inr: active.reduce((sum, org) => sum + Number(org.price_inr || 0), 0),
      signups_last_30d: enriched.filter((org) => new Date(org.created_at) > new Date(Date.now() - 30 * 86400000)).length,
      disabled_organizations: enriched.filter((org) => !org.is_active).length,
      expiring_7d: expiring7d,
      expiring_30d: expiring30d,
      expired_subscriptions: expired,
      pending_payments: pendingPayments,
      capacity_risks: capacityRisks,
      kyc_pending: kycPending,
    },
    attention,
    recent_signups: recentSignups,
    activity: activityResult.rows,
  });
});

/** GET /owner/audit — paginated owner mutations, optionally for one organization. */
export const getOwnerAudit = asyncHandler(async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const organizationId = parseInt(req.query.organization_id, 10);
  const values = [];
  const where = [];
  if (Number.isInteger(organizationId) && organizationId > 0) {
    values.push(organizationId);
    where.push(`a.organization_id = $${values.length}`);
  }
  values.push(limit);
  const { rows } = await pool.query(
    `SELECT a.id, a.action, a.summary, a.organization_id, a.organization_name,
            a.metadata, a.request_id, a.ip_address, a.created_at,
            u.name AS actor_name, u.email AS actor_email
       FROM platform_owner_audit_log a
       LEFT JOIN users u ON u.id = a.actor_user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.created_at DESC
      LIMIT $${values.length}`,
    values,
  );
  res.json({ audit: rows });
});

/**
 * GET /owner/stats — platform KPIs for the Owner Panel dashboard.
 */
export const getStats = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM organizations) AS total_organizations,
      (SELECT COUNT(*)::int FROM organizations WHERE is_active = true) AS active_organizations,
      (SELECT COUNT(*)::int FROM users WHERE role <> 'owner') AS total_users,
      (SELECT COUNT(*)::int FROM sites) AS total_sites,
      (SELECT COUNT(DISTINCT organization_id)::int FROM subscriptions
        WHERE status = 'active' AND current_period_end > NOW()) AS subscribed_organizations,
      (SELECT COALESCE(SUM(p.price_inr), 0)::int
         FROM (
           SELECT DISTINCT ON (s.organization_id) s.plan_id
           FROM subscriptions s
           WHERE s.status = 'active' AND s.current_period_end > NOW()
           ORDER BY s.organization_id, s.current_period_end DESC
         ) latest
         JOIN plans p ON p.id = latest.plan_id) AS mrr_inr,
      (SELECT COUNT(*)::int FROM organizations WHERE created_at > NOW() - INTERVAL '30 days') AS signups_last_30d
  `);
  res.json(rows[0]);
});

/**
 * GET /owner/analytics — trends for the Analytics page: signups, revenue, plan mix.
 */
export const getAnalytics = asyncHandler(async (req, res) => {
  const [signups, revenue, planMix] = await Promise.all([
    pool.query(`
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(COUNT(o.id), 0)::int AS count
      FROM generate_series(CURRENT_DATE - INTERVAL '29 days', CURRENT_DATE, INTERVAL '1 day') d(day)
      LEFT JOIN organizations o ON o.created_at::date = d.day
      GROUP BY d.day ORDER BY d.day
    `),
    pool.query(`
      SELECT to_char(m.month, 'Mon YYYY') AS month, COALESCE(SUM(s.amount_inr), 0)::int AS revenue_inr
      FROM generate_series(date_trunc('month', CURRENT_DATE) - INTERVAL '5 months', date_trunc('month', CURRENT_DATE), INTERVAL '1 month') m(month)
      LEFT JOIN subscriptions s
        ON date_trunc('month', s.created_at) = m.month AND s.status = 'active'
      GROUP BY m.month ORDER BY m.month
    `),
    pool.query(`
      SELECT p.name AS plan_name, COUNT(DISTINCT s.organization_id)::int AS count
      FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id
      WHERE s.status = 'active' AND s.current_period_end > NOW()
      GROUP BY p.name
      ORDER BY count DESC
    `),
  ]);

  res.json({
    signups: signups.rows,
    revenue: revenue.rows,
    plan_mix: planMix.rows,
  });
});

/**
 * POST /owner/organizations — manual registration.
 * Owner-provisioned signup for phone/offline deals: creates the company + its
 * super_admin and an immediately-active subscription, bypassing Razorpay entirely.
 * Body: { company_name, name, email, password, phone?, plan_id, days? }
 */
export const registerOrganization = asyncHandler(async (req, res) => {
  const { company_name, name, email, password, phone, plan_id } = req.body;
  const days = Number.isInteger(parseInt(req.body.days, 10)) ? parseInt(req.body.days, 10) : 30;

  if (!company_name || !name || !email || !password || !plan_id) {
    return res.status(400).json({ message: 'company_name, name, email, password and plan_id are required' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters long' });
  }
  if (days <= 0 || days > 3660) {
    return res.status(400).json({ message: 'days must be between 1 and 3660' });
  }

  const existing = await userModel.findByEmail(email, pool);
  if (existing) return res.status(400).json({ message: 'A user with this email already exists' });

  const { rows: plans } = await pool.query('SELECT * FROM plans WHERE id = $1', [parseInt(plan_id, 10)]);
  const plan = plans[0];
  if (!plan) return res.status(400).json({ message: 'Invalid plan' });

  const hashedPassword = await hashPassword(password);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const subdomain = await generateUniqueSubdomain(client, company_name);
    const org = await client.query(
      'INSERT INTO organizations (name, subdomain) VALUES ($1, $2) RETURNING *',
      [String(company_name).trim(), subdomain]
    );
    const user = await client.query(
      `INSERT INTO users (name, email, password, phone, role, organization_id, is_active, token_version)
       VALUES ($1, $2, $3, $4, 'super_admin', $5, true, 1) RETURNING id, name, email, phone, role, created_at`,
      [name, email, hashedPassword, phone || null, org.rows[0].id]
    );
    const subscription = await client.query(
      `INSERT INTO subscriptions (organization_id, plan_id, status, current_period_start, current_period_end)
       VALUES ($1, $2, 'active', NOW(), NOW() + ($3 || ' days')::interval) RETURNING *`,
      [org.rows[0].id, plan.id, days]
    );
    await writeOwnerAudit(client, req, {
      action: 'organization.registered',
      summary: `Registered ${company_name} on the ${plan.name} plan for ${days} days`,
      organizationId: org.rows[0].id,
      organizationName: company_name,
      metadata: { plan_id: plan.id, plan_name: plan.name, days, admin_email: email },
    });
    await client.query('COMMIT');

    sendRegistrationEmail({ to: email, name, companyName: company_name, orgSubdomain: subdomain })
      .catch((err) => console.error('[mailer] registration email failed:', err.message));
    sendPlanPurchaseEmail({
      to: email, name, companyName: company_name, planName: plan.name, amount: plan.price_inr, days, orgSubdomain: subdomain,
    }).catch((err) => console.error('[mailer] purchase email failed:', err.message));
    sendOwnerNotificationEmail({
      kind: 'registration', companyName: company_name, contactName: name, contactEmail: email,
      contactPhone: phone, planName: plan.name, amount: plan.price_inr, orgId: org.rows[0].id,
    }).catch((err) => console.error('[mailer] owner notify failed:', err.message));

    res.status(201).json({
      organization: org.rows[0],
      user: user.rows[0],
      subscription: subscription.rows[0],
      message: `${company_name} registered on the ${plan.name} plan`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

/**
 * GET /owner/organizations/:id — full detail for the company detail page:
 * org info, subscription history, users and sites (usage).
 */
export const getOrganizationDetail = asyncHandler(async (req, res) => {
  const orgId = parseInt(req.params.id, 10);
  if (!Number.isInteger(orgId)) return res.status(400).json({ message: 'Invalid organization id' });

  const { rows: orgRows } = await pool.query('SELECT * FROM organizations WHERE id = $1', [orgId]);
  if (!orgRows[0]) return res.status(404).json({ message: 'Organization not found' });

  const [subscriptions, users, sites, ownerAudit] = await Promise.all([
    pool.query(
      `SELECT s.*, p.code AS plan_code, p.name AS plan_name, p.price_inr, p.site_limit
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.organization_id = $1 ORDER BY s.created_at DESC`,
      [orgId]
    ),
    pool.query(
      `SELECT id, name, email, phone, role, is_active, created_at
       FROM users WHERE organization_id = $1 ORDER BY created_at ASC`,
      [orgId]
    ),
    pool.query(
      `SELECT id, name, code, city, state, status, created_at
       FROM sites WHERE organization_id = $1 ORDER BY created_at DESC`,
      [orgId]
    ),
    pool.query(
      `SELECT a.id, a.action, a.summary, a.metadata, a.created_at, u.name AS actor_name
         FROM platform_owner_audit_log a
         LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.organization_id = $1
        ORDER BY a.created_at DESC
        LIMIT 25`,
      [orgId]
    ),
  ]);

  const current = subscriptions.rows.find((s) => s.status === 'active' && new Date(s.current_period_end) > new Date()) || null;

  res.json({
    organization: orgRows[0],
    current_subscription: current,
    subscription_history: subscriptions.rows,
    users: users.rows,
    sites: sites.rows,
    owner_audit: ownerAudit.rows,
  });
});

/**
 * GET /owner/organizations — every tenant with its super admin, plan, validity and usage.
 */
export const listOrganizations = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT o.id, o.name, o.subdomain, o.is_active, o.created_at,
           sa.name AS super_admin_name, sa.email AS super_admin_email, sa.phone AS super_admin_phone,
           (SELECT COUNT(*)::int FROM users u WHERE u.organization_id = o.id) AS user_count,
           (SELECT COUNT(*)::int FROM sites s WHERE s.organization_id = o.id) AS site_count,
           sub.plan_id, sub.plan_name, sub.price_inr, sub.site_limit, sub.status AS subscription_status,
           sub.current_period_end
    FROM organizations o
    LEFT JOIN LATERAL (
      SELECT u.name, u.email, u.phone FROM users u
      WHERE u.organization_id = o.id AND u.role = 'super_admin'
      ORDER BY u.created_at ASC LIMIT 1
    ) sa ON true
    LEFT JOIN LATERAL (
      SELECT p.id AS plan_id, p.name AS plan_name, p.price_inr, p.site_limit, s.status, s.current_period_end
      FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id
      WHERE s.organization_id = o.id AND s.status = 'active' AND s.current_period_end > NOW()
      ORDER BY s.current_period_end DESC LIMIT 1
    ) sub ON true
    ORDER BY o.created_at DESC
  `);
  res.json({ organizations: rows });
});

/**
 * PATCH /owner/organizations/:id — body { is_active }.
 * Disabling an organization locks out every one of its users at the auth boundary.
 */
export const updateOrganization = asyncHandler(async (req, res) => {
  const orgId = parseInt(req.params.id, 10);
  const { is_active, subdomain } = req.body;
  if (!Number.isInteger(orgId)) return res.status(400).json({ message: 'Invalid organization id' });
  if (is_active === undefined && subdomain === undefined) {
    return res.status(400).json({ message: 'Nothing to update' });
  }
  if (is_active !== undefined && typeof is_active !== 'boolean') {
    return res.status(400).json({ message: 'is_active must be boolean' });
  }

  let slug;
  if (subdomain !== undefined) {
    slug = String(subdomain).trim().toLowerCase();
    if (!isValidSubdomain(slug)) {
      return res.status(400).json({
        message: '2-63 chars, lowercase letters/digits/hyphens, not reserved (www, console, api…)',
      });
    }
  }

  const sets = ['updated_at = NOW()'];
  const values = [];
  if (is_active !== undefined) { values.push(is_active); sets.push(`is_active = $${values.length}`); }
  if (slug !== undefined) { values.push(slug); sets.push(`subdomain = $${values.length}`); }
  values.push(orgId);

  let rows;
  try {
    ({ rows } = await pool.query(
      `UPDATE organizations SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    ));
  } catch (err) {
    // 23505 = unique_violation on the case-insensitive subdomain index.
    if (err.code === '23505') {
      return res.status(409).json({ message: 'That subdomain is already taken' });
    }
    throw err;
  }
  if (!rows[0]) return res.status(404).json({ message: 'Organization not found' });

  await writeOwnerAudit(pool, req, {
    action: is_active !== undefined ? 'organization.status_changed' : 'organization.domain_changed',
    summary: is_active !== undefined
      ? `${rows[0].name} ${is_active ? 'enabled' : 'disabled'}`
      : `Changed ${rows[0].name} subdomain to ${rows[0].subdomain}`,
    organizationId: orgId,
    organizationName: rows[0].name,
    metadata: { is_active, subdomain: slug },
  });

  res.json({ organization: rows[0], message: 'Organization updated' });
});

/**
 * DELETE /owner/organizations/:id — permanently removes an organization.
 * Only allowed while it has zero users and zero sites (users.organization_id /
 * sites.organization_id are NOT ON DELETE CASCADE, by design — an org with
 * real tenants should be disabled, not deleted). Subscriptions/compliance/KYC
 * rows do cascade, so an empty org's history goes with it.
 */
export const deleteOrganization = asyncHandler(async (req, res) => {
  const orgId = parseInt(req.params.id, 10);
  if (!Number.isInteger(orgId)) return res.status(400).json({ message: 'Invalid organization id' });

  const { rows: org } = await pool.query('SELECT name FROM organizations WHERE id = $1', [orgId]);
  if (!org[0]) return res.status(404).json({ message: 'Organization not found' });

  const { rows: [usage] } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM users WHERE organization_id = $1) AS user_count,
       (SELECT COUNT(*)::int FROM sites WHERE organization_id = $1) AS site_count`,
    [orgId]
  );
  if (usage.user_count > 0 || usage.site_count > 0) {
    return res.status(409).json({
      message: `Can't delete — ${org[0].name} still has ${usage.user_count} user${usage.user_count === 1 ? '' : 's'} and ${usage.site_count} site${usage.site_count === 1 ? '' : 's'}. Disable it instead, or remove its users and sites first.`,
    });
  }

  await writeOwnerAudit(pool, req, {
    action: 'organization.deleted',
    summary: `Deleted empty organization ${org[0].name}`,
    organizationId: orgId,
    organizationName: org[0].name,
    metadata: { user_count: usage.user_count, site_count: usage.site_count },
  });
  await pool.query('DELETE FROM organizations WHERE id = $1', [orgId]);
  res.json({ message: `${org[0].name} deleted` });
});

/**
 * POST /owner/organizations/:id/extend — body { days, plan_id? }.
 * Manually grant/extend a subscription (comp, offline payment, goodwill).
 */
export const extendSubscription = asyncHandler(async (req, res) => {
  const orgId = parseInt(req.params.id, 10);
  const days = parseInt(req.body.days, 10);
  const reason = String(req.body.reason || '').trim();
  if (!Number.isInteger(orgId)) return res.status(400).json({ message: 'Invalid organization id' });
  if (!Number.isInteger(days) || days <= 0 || days > 3660) {
    return res.status(400).json({ message: 'days must be between 1 and 3660' });
  }
  if (reason.length < 5) return res.status(400).json({ message: 'A reason of at least 5 characters is required' });

  const { rows: org } = await pool.query('SELECT id, name FROM organizations WHERE id = $1', [orgId]);
  if (!org[0]) return res.status(404).json({ message: 'Organization not found' });

  let planId = parseInt(req.body.plan_id, 10);
  if (!Number.isInteger(planId)) {
    // Default: the org's latest plan, else the cheapest plan.
    const { rows } = await pool.query(
      `SELECT plan_id FROM subscriptions WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [orgId]
    );
    planId = rows[0]?.plan_id
      ?? (await pool.query('SELECT id FROM plans ORDER BY price_inr ASC LIMIT 1')).rows[0].id;
  }

  const { rows: sub } = await pool.query(
    `INSERT INTO subscriptions (organization_id, plan_id, status, current_period_start, current_period_end)
     SELECT $1, $2, 'active', starts.s, starts.s + ($3 || ' days')::interval
     FROM (
       SELECT GREATEST(NOW(), COALESCE(
         (SELECT MAX(current_period_end) FROM subscriptions WHERE organization_id = $1 AND status = 'active'),
         NOW()
       )) AS s
     ) starts
     RETURNING *`,
    [orgId, planId, days]
  );

  await writeOwnerAudit(pool, req, {
    action: 'subscription.extended',
    summary: `Extended ${org[0].name} subscription by ${days} days`,
    organizationId: orgId,
    organizationName: org[0].name,
    metadata: { days, plan_id: planId, reason },
  });

  res.json({ message: `Subscription extended by ${days} days`, subscription: sub[0] });
});

const slugify = (value) => String(value).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'plan';

const uniquePlanCode = async (name) => {
  const base = slugify(name);
  let code = base;
  let suffix = 2;
  while (true) {
    const { rows } = await pool.query('SELECT 1 FROM plans WHERE code = $1', [code]);
    if (!rows[0]) return code;
    code = `${base}-${suffix++}`;
  }
};

/**
 * GET /owner/plans — every plan, including inactive ones, for the management table.
 */
export const listPlansAdmin = asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM plans ORDER BY price_inr ASC');
  res.json({ plans: rows });
});

/**
 * POST /owner/plans — body { name, price_inr, site_limit, max_users?, features? }.
 * code is auto-derived from name; new plans are active by default.
 */
export const createPlan = asyncHandler(async (req, res) => {
  const { name, price_inr, site_limit, max_users, features } = req.body;
  if (!name || !Number.isFinite(Number(price_inr)) || !Number.isFinite(Number(site_limit))) {
    return res.status(400).json({ message: 'name, price_inr and site_limit are required' });
  }

  const code = await uniquePlanCode(name);
  const { rows } = await pool.query(
    `INSERT INTO plans (code, name, price_inr, site_limit, max_users, features)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      code,
      String(name).trim(),
      parseInt(price_inr, 10),
      parseInt(site_limit, 10),
      Number.isFinite(Number(max_users)) ? parseInt(max_users, 10) : null,
      JSON.stringify(Array.isArray(features) ? features : []),
    ]
  );

  await writeOwnerAudit(pool, req, {
    action: 'plan.created',
    summary: `Created ${name} plan`,
    metadata: {
      plan_id: rows[0].id,
      price_inr: parseInt(price_inr, 10),
      site_limit: parseInt(site_limit, 10),
      max_users: Number.isFinite(Number(max_users)) ? parseInt(max_users, 10) : null,
    },
  });

  res.status(201).json({ plan: rows[0], message: `${name} plan created` });
});

/**
 * PATCH /owner/plans/:id — body any of { name, price_inr, site_limit, max_users, features, is_active }.
 */
export const updatePlan = asyncHandler(async (req, res) => {
  const planId = parseInt(req.params.id, 10);
  if (!Number.isInteger(planId)) return res.status(400).json({ message: 'Invalid plan id' });

  const { name, price_inr, site_limit, max_users, features, is_active } = req.body;
  const sets = [];
  const values = [];
  const set = (column, value) => { values.push(value); sets.push(`${column} = $${values.length}`); };

  if (name !== undefined) set('name', String(name).trim());
  if (price_inr !== undefined) set('price_inr', parseInt(price_inr, 10));
  if (site_limit !== undefined) set('site_limit', parseInt(site_limit, 10));
  if (max_users !== undefined) set('max_users', max_users === null || max_users === '' ? null : parseInt(max_users, 10));
  if (features !== undefined) set('features', JSON.stringify(Array.isArray(features) ? features : []));
  if (is_active !== undefined) {
    if (typeof is_active !== 'boolean') return res.status(400).json({ message: 'is_active must be boolean' });
    set('is_active', is_active);
  }
  if (!sets.length) return res.status(400).json({ message: 'Nothing to update' });

  values.push(planId);
  const { rows } = await pool.query(
    `UPDATE plans SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ message: 'Plan not found' });

  await writeOwnerAudit(pool, req, {
    action: 'plan.updated',
    summary: `Updated ${rows[0].name} plan`,
    metadata: { plan_id: planId, changes: req.body },
  });

  res.json({ plan: rows[0], message: 'Plan updated' });
});
