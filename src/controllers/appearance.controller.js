import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';

const THEMES = new Set(['light', 'dark']);
const ADMIN_ROLES = new Set(['admin', 'super_admin']);

const parseTheme = (value) => {
  const theme = String(value || '').trim().toLowerCase();
  if (!THEMES.has(theme)) {
    throw Object.assign(new Error('Theme must be light or dark'), { status: 400 });
  }
  return theme;
};

const loadAppearance = async ({ userId, organizationId }, db = pool) => {
  const [personalResult, companyResult] = await Promise.all([
    db.query('SELECT theme FROM user_appearance_preferences WHERE user_id=$1 LIMIT 1', [userId]),
    organizationId
      ? db.query('SELECT theme,updated_at FROM organization_appearance_settings WHERE organization_id=$1 LIMIT 1', [organizationId])
      : Promise.resolve({ rows: [] }),
  ]);

  const personalTheme = personalResult.rows[0]?.theme || null;
  const companyTheme = companyResult.rows[0]?.theme || 'light';
  return {
    personal_theme: personalTheme,
    company_theme: companyTheme,
    effective_theme: personalTheme || companyTheme,
    company_updated_at: companyResult.rows[0]?.updated_at || null,
  };
};

export const getAppearance = asyncHandler(async (req, res) => {
  const appearance = await loadAppearance({ userId: req.user.id, organizationId: req.user.organization_id });
  res.json({
    ...appearance,
    can_apply_company_theme: ADMIN_ROLES.has(req.user.role) && Boolean(req.user.organization_id),
  });
});

export const setPersonalTheme = asyncHandler(async (req, res) => {
  const theme = parseTheme(req.body.theme);
  const { rows } = await pool.query(
    `INSERT INTO user_appearance_preferences(user_id,theme,updated_at)
     VALUES($1,$2,NOW())
     ON CONFLICT(user_id) DO UPDATE SET theme=EXCLUDED.theme,updated_at=NOW()
     RETURNING theme,updated_at`,
    [req.user.id, theme],
  );
  const appearance = await loadAppearance({ userId: req.user.id, organizationId: req.user.organization_id });
  res.json({ ...appearance, personal_updated_at: rows[0].updated_at });
});

export const clearPersonalTheme = asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM user_appearance_preferences WHERE user_id=$1', [req.user.id]);
  res.json(await loadAppearance({ userId: req.user.id, organizationId: req.user.organization_id }));
});

export const setCompanyTheme = asyncHandler(async (req, res) => {
  const theme = parseTheme(req.body.theme);
  const organizationId = req.user.organization_id;
  if (!organizationId) return res.status(400).json({ message: 'A company workspace is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO organization_appearance_settings(organization_id,theme,updated_by,updated_at)
       VALUES($1,$2,$3,NOW())
       ON CONFLICT(organization_id) DO UPDATE
         SET theme=EXCLUDED.theme,updated_by=EXCLUDED.updated_by,updated_at=NOW()
       RETURNING theme,updated_at`,
      [organizationId, theme, req.user.id],
    );

    // “Apply to everyone” is intentional: clear individual overrides for
    // this organization so every member receives the published company theme.
    await client.query(
      `DELETE FROM user_appearance_preferences preference
       USING users member
       WHERE preference.user_id=member.id AND member.organization_id=$1`,
      [organizationId],
    );
    await client.query('COMMIT');
    res.json({
      personal_theme: null,
      company_theme: rows[0].theme,
      effective_theme: rows[0].theme,
      company_updated_at: rows[0].updated_at,
      message: 'Company theme applied to all members',
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});
