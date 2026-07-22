import pool from '../config/db.js';

export const FEATURE_KEYS = Object.freeze({
  PLOT_REGISTRY_WORKFLOW_UNLOCKED: 'plot_registry_workflow_unlocked',
});

const FEATURE_DEFAULTS = Object.freeze({
  [FEATURE_KEYS.PLOT_REGISTRY_WORKFLOW_UNLOCKED]: false,
});

const parseStoredBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  if (value && typeof value === 'object' && 'enabled' in value) return Boolean(value.enabled);
  return fallback;
};

class ApplicationSettingModel {
  async getFeatures(siteId) {
    const keys = Object.keys(FEATURE_DEFAULTS);
    const { rows } = await pool.query(
      `SELECT setting_key, setting_value
       FROM application_settings
       WHERE site_id = $1 AND setting_key = ANY($2::text[])`,
      [siteId, keys]
    );

    const features = { ...FEATURE_DEFAULTS };
    for (const row of rows) {
      features[row.setting_key] = parseStoredBoolean(
        row.setting_value,
        FEATURE_DEFAULTS[row.setting_key]
      );
    }
    return features;
  }

  async isFeatureEnabled(siteId, featureKey) {
    if (!Object.prototype.hasOwnProperty.call(FEATURE_DEFAULTS, featureKey)) return false;

    const { rows } = await pool.query(
      `SELECT setting_value
       FROM application_settings
       WHERE site_id = $1 AND setting_key = $2
       LIMIT 1`,
      [siteId, featureKey]
    );

    return rows[0]
      ? parseStoredBoolean(rows[0].setting_value, FEATURE_DEFAULTS[featureKey])
      : FEATURE_DEFAULTS[featureKey];
  }

  async setFeature(siteId, featureKey, enabled, updatedBy) {
    if (!Object.prototype.hasOwnProperty.call(FEATURE_DEFAULTS, featureKey)) {
      throw new Error(`Unknown feature setting: ${featureKey}`);
    }

    const { rows } = await pool.query(
      `INSERT INTO application_settings
         (site_id, setting_key, setting_value, updated_by, updated_at)
       VALUES ($1, $2, to_jsonb($3::boolean), $4, NOW())
       ON CONFLICT (site_id, setting_key)
       DO UPDATE SET
         setting_value = EXCLUDED.setting_value,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING setting_value`,
      [siteId, featureKey, enabled, updatedBy]
    );

    return parseStoredBoolean(rows[0]?.setting_value, FEATURE_DEFAULTS[featureKey]);
  }

  /** Read an arbitrary JSON setting (not a boolean feature flag). */
  async getJson(siteId, key, fallback = null) {
    const { rows } = await pool.query(
      'SELECT setting_value FROM application_settings WHERE site_id = $1 AND setting_key = $2 LIMIT 1',
      [siteId, key]
    );
    return rows[0] ? rows[0].setting_value : fallback;
  }

  /** Upsert an arbitrary JSON setting. */
  async setJson(siteId, key, value, updatedBy) {
    const { rows } = await pool.query(
      `INSERT INTO application_settings (site_id, setting_key, setting_value, updated_by, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, NOW())
       ON CONFLICT (site_id, setting_key)
       DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING setting_value`,
      [siteId, key, JSON.stringify(value), updatedBy]
    );
    return rows[0].setting_value;
  }
}

export default new ApplicationSettingModel();
