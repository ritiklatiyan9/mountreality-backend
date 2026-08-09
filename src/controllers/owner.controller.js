import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { hashPassword } from '../config/jwt.js';
import userModel from '../models/User.model.js';
import { generateUniqueSubdomain, isValidSubdomain } from '../utils/subdomain.js';
import { sendRegistrationEmail, sendPlanPurchaseEmail, sendOwnerNotificationEmail } from '../utils/mailer.js';

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

  const [subscriptions, users, sites] = await Promise.all([
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
  ]);

  const current = subscriptions.rows.find((s) => s.status === 'active' && new Date(s.current_period_end) > new Date()) || null;

  res.json({
    organization: orgRows[0],
    current_subscription: current,
    subscription_history: subscriptions.rows,
    users: users.rows,
    sites: sites.rows,
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
  if (!Number.isInteger(orgId)) return res.status(400).json({ message: 'Invalid organization id' });
  if (!Number.isInteger(days) || days <= 0 || days > 3660) {
    return res.status(400).json({ message: 'days must be between 1 and 3660' });
  }

  const { rows: org } = await pool.query('SELECT id FROM organizations WHERE id = $1', [orgId]);
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

  res.json({ plan: rows[0], message: 'Plan updated' });
});
