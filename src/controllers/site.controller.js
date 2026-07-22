import asyncHandler from '../utils/asyncHandler.js';
import siteModel from '../models/Site.model.js';
import pool from '../config/db.js';

/** The org's active plan (highest site_limit if several periods are stacked). */
const getActivePlan = async (orgId) => {
  const { rows } = await pool.query(
    `SELECT p.site_limit, p.name
     FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id
     WHERE s.organization_id = $1 AND s.status = 'active' AND s.current_period_end > NOW()
     ORDER BY s.current_period_end DESC
     LIMIT 1`,
    [orgId]
  );
  return rows[0] || null;
};

/**
 * POST /sites
 * Create a new site (admin only) — scoped to the caller's organization and
 * capped by the subscription plan's site limit.
 */
export const createSite = asyncHandler(async (req, res) => {
  const { name, code, address, city, state, description, status } = req.body;
  const orgId = req.user.organization_id;

  if (!name) {
    return res.status(400).json({ message: 'Site name is required' });
  }

  const plan = await getActivePlan(orgId);
  if (!plan) return res.status(402).json({ code: 'SUBSCRIPTION_REQUIRED', message: 'No active subscription' });

  const used = await siteModel.countByOrg(orgId, pool);
  if (used >= plan.site_limit) {
    return res.status(403).json({
      message: `Your ${plan.name} plan allows ${plan.site_limit} site${plan.site_limit === 1 ? '' : 's'}. Upgrade your plan to add more.`,
    });
  }

  // Check unique code within the organization
  if (code) {
    const existing = await siteModel.findByCode(code, orgId, pool);
    if (existing) return res.status(400).json({ message: 'Site code already exists' });
  }

  const siteData = {
    name,
    code: code || null,
    address: address || null,
    city: city || null,
    state: state || null,
    description: description || null,
    status: status || 'active',
    created_by: req.user.id,
    organization_id: orgId,
  };

  const site = await siteModel.create(siteData, pool);
  res.status(201).json({ site });
});

/**
 * GET /sites
 * Get sites – admin gets the organization's sites, sub_admin only assigned sites
 */
export const listSites = asyncHandler(async (req, res) => {
  let sites;

  if (req.user.role === 'admin' || req.user.role === 'super_admin') {
    sites = await siteModel.findAllByOrg(req.user.organization_id, pool);
  } else {
    sites = await siteModel.findByUserId(req.user.id, pool);
  }

  res.json({ sites });
});

/**
 * GET /sites/:id
 * Get a single site (must belong to the caller's organization)
 */
export const getSite = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const site = await siteModel.findById(parseInt(id), pool);

  if (!site || site.organization_id !== req.user.organization_id) {
    return res.status(404).json({ message: 'Site not found' });
  }

  // Sub-admins can only access assigned sites
  if (req.user.role === 'sub_admin') {
    const userSites = await siteModel.findByUserId(req.user.id, pool);
    const hasAccess = userSites.some(s => s.id === site.id);
    if (!hasAccess) return res.status(403).json({ message: 'Access denied to this site' });
  }

  res.json({ site });
});

/**
 * PUT /sites/:id
 * Update a site (admin only, own organization)
 */
export const updateSite = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, code, address, city, state, description, status } = req.body;
  const orgId = req.user.organization_id;

  const site = await siteModel.findById(parseInt(id), pool);
  if (!site || site.organization_id !== orgId) return res.status(404).json({ message: 'Site not found' });

  // Check unique code if changed
  if (code && code !== site.code) {
    const existing = await siteModel.findByCode(code, orgId, pool);
    if (existing) return res.status(400).json({ message: 'Site code already exists' });
  }

  const updateData = {};
  if (name) updateData.name = name;
  if (code !== undefined) updateData.code = code;
  if (address !== undefined) updateData.address = address;
  if (city !== undefined) updateData.city = city;
  if (state !== undefined) updateData.state = state;
  if (description !== undefined) updateData.description = description;
  if (status) updateData.status = status;

  const updated = await siteModel.update(parseInt(id), updateData, pool);
  res.json({ site: updated });
});

/**
 * DELETE /sites/:id
 * Delete a site (admin only, own organization)
 */
export const deleteSite = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const site = await siteModel.findById(parseInt(id), pool);
  if (!site || site.organization_id !== req.user.organization_id) {
    return res.status(404).json({ message: 'Site not found' });
  }

  await siteModel.delete(parseInt(id), pool);
  res.json({ message: 'Site deleted' });
});
