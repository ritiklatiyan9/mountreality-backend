import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { writeComplianceAudit, parsePositiveId } from '../utils/complianceAccess.js';
import { getReraSite } from '../utils/reraAccess.js';
import {
  buildOperatingProfilePreview,
  normalizeOperatingProfileInput,
  OPERATING_PROFILE_OPTIONS,
  validateOperatingProfile,
} from '../services/operatingProfile.service.js';
import { invalidateSitePolicy, resolveSitePolicy } from '../services/sitePolicy.service.js';

const PROFILE_COLUMNS = [
  'operating_model', 'jurisdiction_country', 'jurisdiction_state', 'authority_code',
  'authority_name', 'district', 'development_basis', 'development_basis_notes',
  'project_shape', 'regulatory_status', 'project_structure', 'fund_control_modes',
  'ruleset_version_id', 'module_overrides', 'terminology_overrides',
  'field_policy_overrides', 'capability_overrides', 'workflow_policy_overrides', 'change_reason',
];

const openStatuses = ['DRAFT', 'VALIDATION', 'REVIEW', 'REJECTED'];

const profileSelect = `
  SELECT sp.*,r.name AS ruleset_name,r.code AS ruleset_code,
         rv.version AS ruleset_version,rv.lifecycle_status AS ruleset_status,
         rv.source_review_status AS ruleset_review_status,
         creator.name AS created_by_name,updater.name AS updated_by_name,
         reviewer.name AS reviewed_by_name,publisher.name AS published_by_name
    FROM site_operating_profile_revisions sp
    LEFT JOIN rera_ruleset_versions rv ON rv.id=sp.ruleset_version_id
    LEFT JOIN rera_rulesets r ON r.id=rv.ruleset_id
    LEFT JOIN users creator ON creator.id=sp.created_by AND creator.organization_id=sp.organization_id
    LEFT JOIN users updater ON updater.id=sp.updated_by AND updater.organization_id=sp.organization_id
    LEFT JOIN users reviewer ON reviewer.id=sp.reviewed_by AND reviewer.organization_id=sp.organization_id
    LEFT JOIN users publisher ON publisher.id=sp.published_by AND publisher.organization_id=sp.organization_id`;

async function findProfile(req, res, rawId, { db = pool, lock = false } = {}) {
  const id = parsePositiveId(rawId);
  if (!id) {
    res.status(400).json({ message: 'Invalid operating profile revision' });
    return null;
  }
  const { rows } = await db.query(
    `SELECT * FROM site_operating_profile_revisions
      WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL
      LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
    [id, req.user.organization_id]
  );
  if (!rows[0]) {
    res.status(404).json({ message: 'Operating profile revision not found' });
    return null;
  }
  if (!req.siteContextId) {
    res.status(400).json({ code: 'SITE_CONTEXT_REQUIRED', message: 'Select a Site before using its operating profile' });
    return null;
  }
  if (Number(req.siteContextId) !== Number(rows[0].site_id)) {
    res.status(409).json({ message: 'Selected site does not match the operating profile revision' });
    return null;
  }
  const site = await getReraSite(req, res, rows[0].site_id, { db });
  return site ? { profile: rows[0], site } : null;
}

async function hydratedProfile(id, organizationId, db = pool) {
  const { rows } = await db.query(
    `${profileSelect} WHERE sp.id=$1 AND sp.organization_id=$2 LIMIT 1`,
    [id, organizationId]
  );
  return rows[0] || null;
}

async function getRulesetVersion(id, organizationId, db = pool) {
  if (!id) return null;
  const { rows } = await db.query(
    `SELECT rv.*,r.name,r.code,r.organization_id
       FROM rera_ruleset_versions rv
       JOIN rera_rulesets r ON r.id=rv.ruleset_id
      WHERE rv.id=$1 AND rv.deleted_at IS NULL AND r.deleted_at IS NULL
        AND r.is_active=TRUE
        AND (r.organization_id IS NULL OR r.organization_id=$2)
      LIMIT 1`,
    [id, organizationId]
  );
  return rows[0] || null;
}

function parseInput(req, res, fallback = {}) {
  try {
    return normalizeOperatingProfileInput(req.body, fallback);
  } catch (error) {
    res.status(400).json({ message: error.message, field: error.field || null });
    return null;
  }
}

const PREVIEW_IMPACT_QUERIES = Object.freeze({
  plot_payments: {
    label: 'Plot and collection records',
    sql: 'SELECT COUNT(*)::int AS count FROM plots WHERE site_id=$1',
  },
  plot_registry: {
    label: 'Registry records',
    sql: 'SELECT COUNT(*)::int AS count FROM plot_registries WHERE site_id=$1',
  },
  commissions: {
    label: 'Commission records',
    sql: 'SELECT COUNT(*)::int AS count FROM plot_commissions_v2 WHERE site_id=$1',
  },
  farmers: {
    label: 'Land party records',
    sql: 'SELECT COUNT(*)::int AS count FROM farmers WHERE site_id=$1',
  },
  construction: {
    label: 'Construction project records',
    sql: 'SELECT COUNT(*)::int AS count FROM construction_projects WHERE site_id=$1',
  },
  inventory: {
    label: 'Inventory material records',
    sql: 'SELECT COUNT(*)::int AS count FROM inventory_materials WHERE site_id=$1',
  },
  compliance: {
    label: 'Compliance records',
    sql: 'SELECT COUNT(*)::int AS count FROM compliance_items WHERE site_id=$1 AND deleted_at IS NULL',
  },
});

async function attachPreviewImpact(preview, {
  siteId, currentRulesetVersionId, proposedRulesetVersionId, db = pool,
}) {
  const impactedModules = (preview.modules_hidden || [])
    .filter((module) => PREVIEW_IMPACT_QUERIES[module]);
  const impactRows = await Promise.all(impactedModules.map(async (module) => {
    const config = PREVIEW_IMPACT_QUERIES[module];
    const { rows } = await db.query(config.sql, [siteId]);
    const count = Number(rows[0]?.count || 0);
    return count > 0 ? {
      module,
      label: config.label,
      record_count: count,
      message: `${count} existing ${config.label.toLowerCase()} remain stored and require workflow mapping before this module is hidden.`,
    } : null;
  }));
  preview.records_requiring_mapping = impactRows.filter(Boolean);

  const versionIds = [...new Set([
    Number(currentRulesetVersionId), Number(proposedRulesetVersionId),
  ].filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!versionIds.length || Number(currentRulesetVersionId) === Number(proposedRulesetVersionId)) {
    preview.rules_activated = [];
    preview.rules_deactivated = [];
    return preview;
  }
  const { rows: requirementRows } = await db.query(
    `SELECT ruleset_version_id,requirement_code,title,requirement_kind,module_key,
            is_mandatory,is_legal_requirement,source_review_status
       FROM rera_ruleset_requirements
      WHERE ruleset_version_id=ANY($1::bigint[]) AND is_active=TRUE
      ORDER BY sequence,requirement_code`,
    [versionIds]
  );
  const current = new Map(requirementRows
    .filter((row) => Number(row.ruleset_version_id) === Number(currentRulesetVersionId))
    .map((row) => [row.requirement_code, row]));
  const proposed = new Map(requirementRows
    .filter((row) => Number(row.ruleset_version_id) === Number(proposedRulesetVersionId))
    .map((row) => [row.requirement_code, row]));
  preview.rules_activated = [...proposed]
    .filter(([key]) => !current.has(key))
    .map(([, row]) => row);
  preview.rules_deactivated = [...current]
    .filter(([key]) => !proposed.has(key))
    .map(([, row]) => row);
  return preview;
}

/** GET /settings/site-policy?site_id= */
export const getEffectiveSitePolicy = asyncHandler(async (req, res) => {
  const site = await getReraSite(req, res, req.query.site_id);
  if (!site) return;
  const policy = await resolveSitePolicy({
    organizationId: req.user.organization_id,
    siteId: site.id,
    db: pool,
  });
  res.set('Cache-Control', 'private, max-age=15, stale-while-revalidate=30');
  res.json(policy);
});

/** GET /settings/operating-profile?site_id= */
export const getOperatingProfile = asyncHandler(async (req, res) => {
  const site = await getReraSite(req, res, req.query.site_id);
  if (!site) return;
  const [publishedResult, draftResult, historyResult, rulesetResult] = await Promise.all([
    pool.query(
      `${profileSelect} WHERE sp.organization_id=$1 AND sp.site_id=$2
        AND sp.lifecycle_status='PUBLISHED' AND sp.effective_to IS NULL AND sp.deleted_at IS NULL
        ORDER BY sp.revision_number DESC LIMIT 1`,
      [req.user.organization_id, site.id]
    ),
    pool.query(
      `${profileSelect} WHERE sp.organization_id=$1 AND sp.site_id=$2
        AND sp.lifecycle_status=ANY($3::text[]) AND sp.deleted_at IS NULL
        ORDER BY sp.revision_number DESC LIMIT 1`,
      [req.user.organization_id, site.id, openStatuses]
    ),
    pool.query(
      `${profileSelect} WHERE sp.organization_id=$1 AND sp.site_id=$2 AND sp.deleted_at IS NULL
        ORDER BY sp.revision_number DESC`,
      [req.user.organization_id, site.id]
    ),
    pool.query(
      `SELECT r.id AS ruleset_id,r.code,r.name,r.jurisdiction_country_code,
              r.jurisdiction_state_code,r.authority_label,
              rv.id AS version_id,rv.version,rv.lifecycle_status AS status,
              rv.source_review_status AS review_status,
              rv.content_classification AS configuration_scope,
              rv.effective_from,rv.effective_to,
              jsonb_build_object(
                'kind',rv.source_kind,'title',rv.source_title,
                'reference',rv.source_reference,'url',rv.source_url
              ) AS source_references
         FROM rera_rulesets r
         JOIN rera_ruleset_versions rv ON rv.ruleset_id=r.id AND rv.deleted_at IS NULL
        WHERE r.deleted_at IS NULL AND r.is_active=TRUE
          AND (r.organization_id IS NULL OR r.organization_id=$1)
          AND rv.lifecycle_status='PUBLISHED'
          AND (rv.effective_from IS NULL OR rv.effective_from <= NOW())
          AND (rv.effective_to IS NULL OR rv.effective_to > NOW())
        ORDER BY (r.organization_id IS NULL) DESC,r.name,rv.created_at DESC`,
      [req.user.organization_id]
    ),
  ]);
  res.json({
    site: { id: site.id, name: site.name },
    published_profile: publishedResult.rows[0] || null,
    draft_profile: draftResult.rows[0] || null,
    history: historyResult.rows,
    rulesets: rulesetResult.rows,
    options: OPERATING_PROFILE_OPTIONS,
  });
});

/** POST /settings/operating-profile/drafts */
export const createOperatingProfileDraft = asyncHandler(async (req, res) => {
  const site = await getReraSite(req, res, req.body.site_id);
  if (!site) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM sites WHERE id=$1 AND organization_id=$2 FOR UPDATE', [site.id, req.user.organization_id]);
    const { rows: open } = await client.query(
      `SELECT id,lifecycle_status FROM site_operating_profile_revisions
        WHERE organization_id=$1 AND site_id=$2 AND lifecycle_status=ANY($3::text[])
          AND deleted_at IS NULL ORDER BY revision_number DESC LIMIT 1`,
      [req.user.organization_id, site.id, openStatuses]
    );
    if (open[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'This Site already has an open profile revision', profile_id: open[0].id });
    }
    const { rows: publishedRows } = await client.query(
      `SELECT * FROM site_operating_profile_revisions
        WHERE organization_id=$1 AND site_id=$2 AND lifecycle_status='PUBLISHED'
          AND effective_to IS NULL AND deleted_at IS NULL
        ORDER BY revision_number DESC LIMIT 1`,
      [req.user.organization_id, site.id]
    );
    // New revisions inherit every validated policy override from the currently
    // published revision unless the caller explicitly replaces/clears it.
    // This prevents the onboarding form's basic fields from silently erasing
    // module, terminology, capability or field policy.
    const input = parseInput(req, res, publishedRows[0] || {});
    if (!input) {
      await client.query('ROLLBACK');
      return;
    }
    if (input.ruleset_version_id && !await getRulesetVersion(input.ruleset_version_id, req.user.organization_id, client)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Selected ruleset version is not available' });
    }
    const { rows } = await client.query(
      `INSERT INTO site_operating_profile_revisions (
         organization_id,site_id,revision_number,lifecycle_status,review_decision,previous_revision_id,
         ${PROFILE_COLUMNS.join(',')},created_by,updated_by
       ) VALUES (
         $1,$2,(SELECT COALESCE(MAX(revision_number),0)+1 FROM site_operating_profile_revisions WHERE organization_id=$1 AND site_id=$2),
         'DRAFT','PENDING',
         (SELECT id FROM site_operating_profile_revisions WHERE organization_id=$1 AND site_id=$2 AND lifecycle_status='PUBLISHED' AND effective_to IS NULL ORDER BY revision_number DESC LIMIT 1),
         ${PROFILE_COLUMNS.map((_, index) => `$${index + 3}`).join(',')},
         $${PROFILE_COLUMNS.length + 3},$${PROFILE_COLUMNS.length + 3}
       ) RETURNING *`,
      [req.user.organization_id, site.id, ...PROFILE_COLUMNS.map((column) => input[column]), req.user.id]
    );
    await writeComplianceAudit(client, req, {
      action: 'OPERATING_PROFILE_DRAFT_CREATED', entityType: 'OPERATING_PROFILE',
      entityId: rows[0].id, siteId: site.id, newValue: rows[0], reason: input.change_reason,
    });
    await client.query('COMMIT');
    res.status(201).json({ profile: await hydratedProfile(rows[0].id, req.user.organization_id) });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

/** PATCH /settings/operating-profile/drafts/:id */
export const updateOperatingProfileDraft = asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const context = await findProfile(req, res, req.params.id, { db: client, lock: true });
    if (!context) {
      await client.query('ROLLBACK');
      return;
    }
    if (!['DRAFT', 'REJECTED'].includes(context.profile.lifecycle_status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Only a draft or rejected revision can be edited' });
    }
    const input = parseInput(req, res, context.profile);
    if (!input) {
      await client.query('ROLLBACK');
      return;
    }
    if (input.ruleset_version_id
        && !await getRulesetVersion(input.ruleset_version_id, req.user.organization_id, client)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Selected ruleset version is not available' });
    }
    const values = PROFILE_COLUMNS.map((column) => input[column]);
    const assignments = PROFILE_COLUMNS.map((column, index) => `${column}=$${index + 1}`).join(',');
    const { rows } = await client.query(
      `UPDATE site_operating_profile_revisions SET ${assignments},
              lifecycle_status='DRAFT',review_decision='PENDING',reviewed_by=NULL,reviewed_at=NULL,
              review_notes=NULL,validation_results='{}'::jsonb,updated_by=$${values.length + 1},updated_at=NOW()
        WHERE id=$${values.length + 2} AND organization_id=$${values.length + 3}
          AND site_id=$${values.length + 4} AND lifecycle_status IN ('DRAFT','REJECTED')
        RETURNING *`,
      [...values, req.user.id, context.profile.id, req.user.organization_id, context.site.id]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'The operating profile revision changed before it could be updated' });
    }
    await writeComplianceAudit(client, req, {
      action: 'OPERATING_PROFILE_DRAFT_UPDATED', entityType: 'OPERATING_PROFILE',
      entityId: context.profile.id, siteId: context.site.id,
      previousValue: context.profile, newValue: rows[0], reason: input.change_reason,
    });
    const profile = await hydratedProfile(rows[0].id, req.user.organization_id, client);
    await client.query('COMMIT');
    return res.json({ profile });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

/** GET /settings/operating-profile/:id/preview */
export const previewOperatingProfile = asyncHandler(async (req, res) => {
  const context = await findProfile(req, res, req.params.id);
  if (!context) return;
  const { rows: publishedRows } = await pool.query(
    `SELECT * FROM site_operating_profile_revisions
      WHERE organization_id=$1 AND site_id=$2 AND lifecycle_status='PUBLISHED'
        AND effective_to IS NULL AND deleted_at IS NULL ORDER BY revision_number DESC LIMIT 1`,
    [req.user.organization_id, context.site.id]
  );
  const [rulesetVersion, currentRuleset] = await Promise.all([
    getRulesetVersion(context.profile.ruleset_version_id, req.user.organization_id),
    getRulesetVersion(publishedRows[0]?.ruleset_version_id, req.user.organization_id),
  ]);
  const current = publishedRows[0] ? { ...publishedRows[0], ruleset_version: currentRuleset } : null;
  const preview = buildOperatingProfilePreview({ currentProfile: current, proposedProfile: context.profile, rulesetVersion });
  await attachPreviewImpact(preview, {
    siteId: context.site.id,
    currentRulesetVersionId: publishedRows[0]?.ruleset_version_id,
    proposedRulesetVersionId: context.profile.ruleset_version_id,
  });
  res.json({ preview });
});

/** POST /settings/operating-profile/:id/validate */
export const validateOperatingProfileRevision = asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const context = await findProfile(req, res, req.params.id, { db: client, lock: true });
    if (!context) {
      await client.query('ROLLBACK');
      return;
    }
    if (context.profile.lifecycle_status !== 'DRAFT') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Only a draft can enter validation' });
    }
    const validation = await validateOperatingProfile(context.profile, {
      db: client, organizationId: req.user.organization_id, siteId: context.site.id,
    });
    const nextStatus = validation.valid ? 'VALIDATION' : 'DRAFT';
    const { rows } = await client.query(
      `UPDATE site_operating_profile_revisions
          SET lifecycle_status=$1,validation_results=$2,updated_by=$3,updated_at=NOW()
        WHERE id=$4 AND organization_id=$5 AND site_id=$6 AND lifecycle_status='DRAFT'
        RETURNING *`,
      [nextStatus, validation, req.user.id, context.profile.id, req.user.organization_id, context.site.id]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'The operating profile revision changed before validation completed' });
    }
    await writeComplianceAudit(client, req, {
      action: validation.valid ? 'OPERATING_PROFILE_VALIDATED' : 'OPERATING_PROFILE_VALIDATION_FAILED',
      entityType: 'OPERATING_PROFILE', entityId: context.profile.id, siteId: context.site.id,
      previousValue: {
        lifecycle_status: context.profile.lifecycle_status,
        validation_results: context.profile.validation_results,
      },
      newValue: { lifecycle_status: nextStatus, validation },
    });
    const profile = validation.valid
      ? await hydratedProfile(rows[0].id, req.user.organization_id, client)
      : rows[0];
    await client.query('COMMIT');
    if (!validation.valid) {
      return res.status(422).json({ message: 'Profile validation needs attention', validation, profile });
    }
    return res.json({ message: 'Profile validation completed', validation, profile });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

/** POST /settings/operating-profile/:id/submit-review */
export const submitOperatingProfileReview = asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const context = await findProfile(req, res, req.params.id, { db: client, lock: true });
    if (!context) {
      await client.query('ROLLBACK');
      return;
    }
    if (context.profile.lifecycle_status !== 'VALIDATION') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'The revision must pass validation before review' });
    }
    const reason = String(req.body.reason || context.profile.change_reason || '').trim();
    if (!reason) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'A reason is required before review' });
    }
    const { rows } = await client.query(
      `UPDATE site_operating_profile_revisions
          SET lifecycle_status='REVIEW',review_decision='PENDING',change_reason=$1,updated_by=$2,updated_at=NOW()
        WHERE id=$3 AND organization_id=$4 AND site_id=$5 AND lifecycle_status='VALIDATION'
        RETURNING *`,
      [reason.slice(0, 4000), req.user.id, context.profile.id, req.user.organization_id, context.site.id]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'The operating profile revision changed before review submission' });
    }
    await writeComplianceAudit(client, req, {
      action: 'OPERATING_PROFILE_REVIEW_REQUESTED', entityType: 'OPERATING_PROFILE',
      entityId: context.profile.id, siteId: context.site.id,
      previousValue: { lifecycle_status: context.profile.lifecycle_status },
      newValue: { lifecycle_status: rows[0].lifecycle_status }, reason,
    });
    const profile = await hydratedProfile(rows[0].id, req.user.organization_id, client);
    await client.query('COMMIT');
    return res.json({ message: 'Profile submitted for review', profile });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

/** POST /settings/operating-profile/:id/review */
export const reviewOperatingProfile = asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const context = await findProfile(req, res, req.params.id, { db: client, lock: true });
    if (!context) {
      await client.query('ROLLBACK');
      return;
    }
    if (context.profile.lifecycle_status !== 'REVIEW') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'This revision is not awaiting review' });
    }
    const decision = String(req.body.decision || '').toUpperCase();
    if (!['APPROVED', 'REJECTED'].includes(decision)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'decision must be APPROVED or REJECTED' });
    }
    const notes = String(req.body.notes || '').trim();
    if (decision === 'REJECTED' && !notes) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Review notes are required when rejecting a revision' });
    }
    const lifecycle = decision === 'REJECTED' ? 'REJECTED' : 'REVIEW';
    const { rows } = await client.query(
      `UPDATE site_operating_profile_revisions
          SET lifecycle_status=$1,review_decision=$2,review_notes=$3,reviewed_by=$4,reviewed_at=NOW(),updated_by=$4,updated_at=NOW()
        WHERE id=$5 AND organization_id=$6 AND site_id=$7 AND lifecycle_status='REVIEW'
        RETURNING *`,
      [lifecycle, decision, notes.slice(0, 4000) || null, req.user.id,
        context.profile.id, req.user.organization_id, context.site.id]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'The operating profile revision changed before review completed' });
    }
    await writeComplianceAudit(client, req, {
      action: `OPERATING_PROFILE_REVIEW_${decision}`, entityType: 'OPERATING_PROFILE',
      entityId: context.profile.id, siteId: context.site.id,
      previousValue: {
        lifecycle_status: context.profile.lifecycle_status,
        review_decision: context.profile.review_decision,
      },
      newValue: {
        lifecycle_status: rows[0].lifecycle_status,
        review_decision: rows[0].review_decision,
      },
      reason: notes,
    });
    const profile = await hydratedProfile(rows[0].id, req.user.organization_id, client);
    await client.query('COMMIT');
    return res.json({
      message: decision === 'APPROVED' ? 'Profile review approved' : 'Profile returned for correction',
      profile,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

/** POST /settings/operating-profile/:id/publish */
export const publishOperatingProfile = asyncHandler(async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ message: 'A publication reason is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const context = await findProfile(req, res, req.params.id, { db: client, lock: true });
    if (!context) {
      await client.query('ROLLBACK');
      return;
    }
    if (context.profile.lifecycle_status !== 'REVIEW' || context.profile.review_decision !== 'APPROVED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'The revision must be reviewed and approved before publication' });
    }
    await client.query('SELECT id FROM sites WHERE id=$1 AND organization_id=$2 FOR UPDATE', [context.site.id, req.user.organization_id]);
    const validation = await validateOperatingProfile(context.profile, {
      db: client, organizationId: req.user.organization_id, siteId: context.site.id,
    });
    if (!validation.valid) {
      const { rows: invalidRows } = await client.query(
        `UPDATE site_operating_profile_revisions
            SET validation_results=$1,updated_by=$2,updated_at=NOW()
          WHERE id=$3 AND organization_id=$4 AND site_id=$5
            AND lifecycle_status='REVIEW' AND review_decision='APPROVED'
          RETURNING *`,
        [validation, req.user.id, context.profile.id, req.user.organization_id, context.site.id]
      );
      if (!invalidRows[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: 'The operating profile revision changed during publication validation' });
      }
      await writeComplianceAudit(client, req, {
        action: 'OPERATING_PROFILE_PUBLICATION_VALIDATION_FAILED',
        entityType: 'OPERATING_PROFILE', entityId: context.profile.id, siteId: context.site.id,
        previousValue: {
          lifecycle_status: context.profile.lifecycle_status,
          review_decision: context.profile.review_decision,
          validation_results: context.profile.validation_results,
        },
        newValue: {
          lifecycle_status: invalidRows[0].lifecycle_status,
          review_decision: invalidRows[0].review_decision,
          validation_results: validation,
        },
        reason,
      });
      await client.query('COMMIT');
      return res.status(422).json({
        message: 'Profile no longer passes publication validation',
        validation,
        profile: invalidRows[0],
      });
    }
    const { rows: previousRows } = await client.query(
      `UPDATE site_operating_profile_revisions
          SET lifecycle_status='SUPERSEDED',effective_to=NOW(),updated_by=$1,updated_at=NOW()
        WHERE organization_id=$2 AND site_id=$3 AND lifecycle_status='PUBLISHED'
          AND effective_to IS NULL AND id<>$4
        RETURNING *`,
      [req.user.id, req.user.organization_id, context.site.id, context.profile.id]
    );
    const { rows } = await client.query(
      `UPDATE site_operating_profile_revisions
          SET lifecycle_status='PUBLISHED',effective_from=NOW(),effective_to=NULL,
              change_reason=$1,published_by=$2,published_at=NOW(),updated_by=$2,updated_at=NOW(),
              validation_results=$3
        WHERE id=$4 AND organization_id=$5 AND site_id=$6
          AND lifecycle_status='REVIEW' AND review_decision='APPROVED'
        RETURNING *`,
      [reason.slice(0, 4000), req.user.id, validation, context.profile.id,
        req.user.organization_id, context.site.id]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'The operating profile revision changed during publication' });
    }
    await writeComplianceAudit(client, req, {
      action: 'OPERATING_PROFILE_PUBLISHED', entityType: 'OPERATING_PROFILE',
      entityId: rows[0].id, siteId: context.site.id,
      previousValue: previousRows[0] || null, newValue: rows[0], reason,
    });
    const profile = await hydratedProfile(rows[0].id, req.user.organization_id, client);
    await client.query('COMMIT');
    invalidateSitePolicy(context.site.id);
    res.json({ message: 'Operating profile published', profile });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});
