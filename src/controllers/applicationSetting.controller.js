import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import applicationSettingModel, { FEATURE_KEYS } from '../models/ApplicationSetting.model.js';
import { getConfig as getSmsConfig, saveConfig as saveSmsConfig } from '../services/smsReminder.service.js';
import { isSmsQueueConfigured } from '../utils/sqs.js';

const getAccessibleSiteId = async (req, res, rawSiteId) => {
  const siteId = Number.parseInt(rawSiteId, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    res.status(400).json({ message: 'A valid site_id is required' });
    return null;
  }

  const { rows } = await pool.query('SELECT id FROM sites WHERE id = $1 LIMIT 1', [siteId]);
  if (!rows[0]) {
    res.status(404).json({ message: 'Site not found' });
    return null;
  }

  if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
    const access = await pool.query(
      'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
      [req.user.id, siteId]
    );
    if (!access.rows[0]) {
      res.status(403).json({ message: 'Access denied to this site' });
      return null;
    }
  }

  return siteId;
};

/** GET /settings/features?site_id=123 */
export const getFeatures = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.query.site_id);
  if (!siteId) return;

  const features = await applicationSettingModel.getFeatures(siteId);
  res.json({ site_id: siteId, features });
});

/** PUT /settings/features/plot-registry-workflow-unlocked */
export const updatePlotRegistryWorkflow = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.body.site_id);
  if (!siteId) return;

  if (typeof req.body.enabled !== 'boolean') {
    return res.status(400).json({ message: 'enabled must be a boolean' });
  }

  const enabled = await applicationSettingModel.setFeature(
    siteId,
    FEATURE_KEYS.PLOT_REGISTRY_WORKFLOW_UNLOCKED,
    req.body.enabled,
    req.user.id
  );

  res.json({
    site_id: siteId,
    features: { [FEATURE_KEYS.PLOT_REGISTRY_WORKFLOW_UNLOCKED]: enabled },
    message: enabled
      ? 'Plot Registry flexible navigation enabled'
      : 'Plot Registry sequential workflow restored',
  });
});

/** GET /settings/sms-reminders?site_id=123 */
export const getSmsReminderSettings = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.query.site_id);
  if (!siteId) return;

  res.json({
    site_id: siteId,
    settings: await getSmsConfig(siteId),
    queue_configured: isSmsQueueConfigured(),
  });
});

/** PUT /settings/sms-reminders */
export const updateSmsReminderSettings = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.body.site_id);
  if (!siteId) return;

  const settings = await saveSmsConfig(siteId, req.body, req.user.id);
  res.json({
    site_id: siteId,
    settings,
    queue_configured: isSmsQueueConfigured(),
    message: settings.enabled
      ? `Automatic SMS reminders on — ${settings.days_before.join(', ')} day(s) around the due date at ${String(settings.send_hour).padStart(2, '0')}:00 IST`
      : 'Automatic SMS reminders turned off',
  });
});
