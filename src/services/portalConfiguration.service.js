import pool from '../config/db.js';

export const CLIENT_PORTAL_SETTING_KEY = 'client_portal_configuration_v1';
export const CLIENT_PORTAL_MODULE_KEYS = Object.freeze([
  'overview',
  'transactions',
  'upcoming_installments',
  'documents',
  'project_updates',
  'discussions',
]);
export const TRANSACTION_VISIBILITY_SCOPES = Object.freeze(['ALL', 'CASH', 'BANK', 'SELECTED']);

export const DEFAULT_CLIENT_PORTAL_CONFIGURATION = Object.freeze({
  portal_enabled: true,
  modules: Object.freeze({
    overview: true,
    transactions: true,
    upcoming_installments: true,
    documents: true,
    project_updates: true,
    discussions: true,
  }),
  transaction_visibility: Object.freeze({
    scope: 'ALL',
    selected_modes: Object.freeze([]),
  }),
});

const cleanMode = (value) => String(value || '').trim().toUpperCase().slice(0, 50);

export function normalizeClientPortalConfiguration(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const inputModules = input.modules && typeof input.modules === 'object' && !Array.isArray(input.modules)
    ? input.modules
    : {};
  const inputVisibility = input.transaction_visibility
    && typeof input.transaction_visibility === 'object'
    && !Array.isArray(input.transaction_visibility)
    ? input.transaction_visibility
    : {};
  const rawScope = String(inputVisibility.scope || DEFAULT_CLIENT_PORTAL_CONFIGURATION.transaction_visibility.scope).toUpperCase();
  const scope = TRANSACTION_VISIBILITY_SCOPES.includes(rawScope) ? rawScope : 'ALL';
  const selectedModes = [...new Set(
    (Array.isArray(inputVisibility.selected_modes) ? inputVisibility.selected_modes : [])
      .map(cleanMode)
      .filter((mode) => mode && /^[A-Z0-9][A-Z0-9 _./&+()-]*$/.test(mode)),
  )].slice(0, 20);

  return {
    portal_enabled: typeof input.portal_enabled === 'boolean'
      ? input.portal_enabled
      : DEFAULT_CLIENT_PORTAL_CONFIGURATION.portal_enabled,
    modules: Object.fromEntries(CLIENT_PORTAL_MODULE_KEYS.map((key) => [
      key,
      typeof inputModules[key] === 'boolean'
        ? inputModules[key]
        : DEFAULT_CLIENT_PORTAL_CONFIGURATION.modules[key],
    ])),
    transaction_visibility: { scope, selected_modes: selectedModes },
  };
}

export function validateClientPortalConfiguration(value) {
  const configuration = normalizeClientPortalConfiguration(value);
  if (configuration.transaction_visibility.scope === 'SELECTED'
    && configuration.transaction_visibility.selected_modes.length === 0) {
    const error = new Error('Select at least one transaction mode when visibility is set to Selected modes');
    error.status = 400;
    error.code = 'PORTAL_TRANSACTION_MODE_REQUIRED';
    throw error;
  }
  return configuration;
}

export function clientPortalActions(value) {
  const configuration = normalizeClientPortalConfiguration(value);
  const actions = [];
  if (configuration.modules.overview) actions.push('view_booking');
  if (configuration.modules.transactions || configuration.modules.upcoming_installments) actions.push('view_payments');
  if (configuration.modules.documents) actions.push('view_documents');
  if (configuration.modules.project_updates) actions.push('view_updates');
  if (configuration.modules.discussions) actions.push('comment');
  return actions;
}

export async function getClientPortalConfiguration(siteId, db = pool) {
  const { rows } = await db.query(
    `SELECT setting_value
       FROM application_settings
      WHERE site_id=$1 AND setting_key=$2
      LIMIT 1`,
    [siteId, CLIENT_PORTAL_SETTING_KEY],
  );
  return normalizeClientPortalConfiguration(rows[0]?.setting_value);
}

export async function saveClientPortalConfiguration(siteId, configuration, updatedBy, db = pool) {
  const normalized = validateClientPortalConfiguration(configuration);
  const { rows } = await db.query(
    `INSERT INTO application_settings (site_id,setting_key,setting_value,updated_by,updated_at)
     VALUES ($1,$2,$3::jsonb,$4,NOW())
     ON CONFLICT (site_id,setting_key)
     DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()
     RETURNING setting_value,updated_at`,
    [siteId, CLIENT_PORTAL_SETTING_KEY, JSON.stringify(normalized), updatedBy],
  );
  return { configuration: normalizeClientPortalConfiguration(rows[0].setting_value), updated_at: rows[0].updated_at };
}

export async function listClientPortalPaymentModes(siteId, db = pool) {
  const { rows } = await db.query(
    `SELECT mode FROM (
       SELECT DISTINCT UPPER(TRIM(payment_type)) AS mode
         FROM plot_payments
        WHERE site_id=$1 AND NULLIF(TRIM(payment_type),'') IS NOT NULL
       UNION
       SELECT DISTINCT UPPER(TRIM(pip.payment_mode)) AS mode
         FROM plot_installment_payments pip
         JOIN plots p ON p.id=pip.plot_id
        WHERE p.site_id=$1 AND NULLIF(TRIM(pip.payment_mode),'') IS NOT NULL
     ) modes
     WHERE mode IS NOT NULL
     ORDER BY mode
     LIMIT 100`,
    [siteId],
  );
  const discovered = rows.map((row) => cleanMode(row.mode)).filter(Boolean);
  return [...new Set(['CASH', 'BANK', 'UPI', 'CHEQUE', 'NEFT', 'RTGS', 'IMPS', ...discovered])];
}

export function assertClientPortalAvailable(membership, configuration) {
  if (membership?.portal_type !== 'BUYER') return;
  if (configuration?.portal_enabled !== false) return;
  const error = new Error('The client portal is temporarily disabled by the organization');
  error.status = 403;
  error.code = 'CLIENT_PORTAL_DISABLED';
  throw error;
}

export function assertClientPortalModule(membership, configuration, moduleKey) {
  if (membership?.portal_type !== 'BUYER') return;
  if (!CLIENT_PORTAL_MODULE_KEYS.includes(moduleKey)) {
    const error = new Error('Client portal module policy is invalid');
    error.status = 500;
    error.code = 'PORTAL_MODULE_POLICY_INVALID';
    throw error;
  }
  assertClientPortalAvailable(membership, configuration);
  if (configuration?.modules?.[moduleKey] === true) return;
  const error = new Error('This client portal module is not available');
  error.status = 403;
  error.code = 'PORTAL_MODULE_DISABLED';
  throw error;
}
