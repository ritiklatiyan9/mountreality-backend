import crypto from 'crypto';
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { writePortalAudit } from '../services/portalAccess.service.js';

const id = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
const KIND = new Set(['API_CLIENT', 'WEBHOOK_IN', 'WEBHOOK_OUT', 'SSO_CONFIGURATION', 'DATA_EXPORT']);
const REF_RE = /^[A-Z][A-Z0-9_]{2,179}$/;
const SECRET_KEY_RE = /(^|_)(secret|password|passwd|token|credential|api_?key|private_?key)($|_)/i;

function containsInlineSecret(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsInlineSecret);
  return Object.entries(value).some(([key, child]) => SECRET_KEY_RE.test(key) || containsInlineSecret(child));
}

function validEndpoint(value) {
  if (!value) return true;
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
  } catch {
    return false;
  }
}

export const listIntegrationConnections = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ic.id,ic.connection_key,ic.integration_kind,ic.provider_key,ic.mode,ic.status,
            ic.secret_reference,ic.signing_secret_reference,ic.endpoint_url,ic.allowed_events,
            ic.configuration,ic.last_verified_at,ic.created_at,ic.updated_at,
            COALESCE(events.received,0)::int AS event_count,
            events.last_event_at
       FROM integration_connections ic
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS received,MAX(created_at) AS last_event_at
           FROM integration_events e WHERE e.connection_id=ic.id
       ) events ON TRUE
      WHERE ic.organization_id=$1 ORDER BY ic.created_at DESC`,
    [req.user.organization_id],
  );
  res.json({ connections: rows });
});

export const createIntegrationConnection = asyncHandler(async (req, res) => {
  const connectionKey = String(req.body.connection_key || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 100);
  const integrationKind = String(req.body.integration_kind || '').toUpperCase();
  const providerKey = String(req.body.provider_key || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 100);
  const secretReference = String(req.body.secret_reference || '').trim() || null;
  const signingSecretReference = String(req.body.signing_secret_reference || '').trim() || null;
  const endpointUrl = String(req.body.endpoint_url || '').trim() || null;
  const configuration = req.body.configuration && typeof req.body.configuration === 'object' && !Array.isArray(req.body.configuration) ? req.body.configuration : {};
  const allowedEvents = [...new Set((Array.isArray(req.body.allowed_events) ? req.body.allowed_events : []).map((event) => String(event).trim()).filter(Boolean).slice(0, 100))];
  if (!connectionKey || !KIND.has(integrationKind) || !providerKey) return res.status(400).json({ message: 'connection_key, integration_kind and provider_key are required' });
  if ((secretReference && !REF_RE.test(secretReference)) || (signingSecretReference && !REF_RE.test(signingSecretReference))) return res.status(400).json({ message: 'Secret references must be environment-variable names, not credentials' });
  if (containsInlineSecret(configuration)) return res.status(400).json({ code: 'INLINE_SECRET_REJECTED', message: 'Configuration cannot contain credentials; use a secret reference' });
  if (!validEndpoint(endpointUrl)) return res.status(400).json({ message: 'Endpoint must use HTTPS (localhost HTTP is allowed outside production)' });
  if (Buffer.byteLength(JSON.stringify(configuration), 'utf8') > 32 * 1024) return res.status(413).json({ message: 'Integration configuration is too large' });

  let status = 'DRAFT';
  let capabilityState = 'FRAMEWORK_ONLY';
  if (req.body.activate === true && integrationKind === 'WEBHOOK_IN') {
    if (!signingSecretReference || !process.env[signingSecretReference]) return res.status(409).json({ code: 'SECRET_REFERENCE_UNRESOLVED', message: 'The inbound signing secret reference is not configured in the server environment' });
    if (!allowedEvents.length) return res.status(400).json({ message: 'At least one allowed event is required before activation' });
    status = 'ACTIVE';
    capabilityState = 'INBOUND_VALIDATION_ACTIVE';
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO integration_connections
        (organization_id,connection_key,integration_kind,provider_key,mode,status,
         secret_reference,signing_secret_reference,endpoint_url,allowed_events,
         configuration,last_verified_at,created_by,updated_by)
       VALUES ($1,$2,$3,$4,'FRAMEWORK',$5,$6,$7,$8,$9,$10,
         CASE WHEN $5='ACTIVE' THEN NOW() END,$11,$11) RETURNING *`,
      [req.user.organization_id, connectionKey, integrationKind, providerKey, status,
        secretReference, signingSecretReference, endpointUrl, allowedEvents, configuration, req.user.id],
    );
    await writePortalAudit({ organizationId: req.user.organization_id, userId: req.user.id, action: 'INTEGRATION_CONNECTION_CREATED', entityType: 'INTEGRATION_CONNECTION', entityId: rows[0].id, newValue: { ...rows[0], configuration: undefined }, ipAddress: req.ip });
    res.status(201).json({ connection: rows[0], capability_state: capabilityState, webhook_path: integrationKind === 'WEBHOOK_IN' ? `/phase4/webhooks/${rows[0].id}/${rows[0].connection_key}` : null });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ message: 'That integration connection key already exists' });
    throw error;
  }
});

export const updateIntegrationStatus = asyncHandler(async (req, res) => {
  const connectionId = id(req.params.connectionId);
  const requested = String(req.body.status || '').toUpperCase();
  if (!connectionId || !['ACTIVE', 'SUSPENDED', 'REVOKED'].includes(requested)) return res.status(400).json({ message: 'A valid connection and status are required' });
  const { rows: existing } = await pool.query('SELECT * FROM integration_connections WHERE id=$1 AND organization_id=$2', [connectionId, req.user.organization_id]);
  const connection = existing[0];
  if (!connection) return res.status(404).json({ message: 'Integration connection not found' });
  if (requested === 'ACTIVE') {
    if (connection.integration_kind !== 'WEBHOOK_IN') return res.status(409).json({ code: 'ADAPTER_NOT_IMPLEMENTED', message: 'Only generic inbound webhook validation can be activated; no provider adapter is implemented' });
    if (!connection.signing_secret_reference || !process.env[connection.signing_secret_reference]) return res.status(409).json({ code: 'SECRET_REFERENCE_UNRESOLVED', message: 'The signing secret reference is not configured' });
    if (!Array.isArray(connection.allowed_events) || !connection.allowed_events.length) return res.status(409).json({ message: 'Configure at least one allowed event before activation' });
  }
  const { rows } = await pool.query(
    `UPDATE integration_connections SET status=$1,updated_by=$2,updated_at=NOW(),
      last_verified_at=CASE WHEN $1='ACTIVE' THEN NOW() ELSE last_verified_at END
      WHERE id=$3 AND organization_id=$4 RETURNING *`,
    [requested, req.user.id, connectionId, req.user.organization_id],
  );
  await writePortalAudit({ organizationId: req.user.organization_id, userId: req.user.id, action: `INTEGRATION_CONNECTION_${requested}`, entityType: 'INTEGRATION_CONNECTION', entityId: connectionId, previousValue: { status: connection.status }, newValue: { status: requested }, reason: String(req.body.reason || '').trim() || null, ipAddress: req.ip });
  res.json({ connection: rows[0] });
});

export const receiveIntegrationWebhook = asyncHandler(async (req, res) => {
  const connectionId = id(req.params.connectionId);
  const connectionKey = String(req.params.connectionKey || '');
  const { rows } = await pool.query(
    `SELECT * FROM integration_connections WHERE id=$1 AND connection_key=$2
      AND integration_kind='WEBHOOK_IN' AND status='ACTIVE' LIMIT 1`,
    [connectionId, connectionKey],
  );
  const connection = rows[0];
  if (!connection) return res.status(404).json({ message: 'Active webhook connection not found' });
  const timestampText = String(req.header('X-MountReality-Timestamp') || '');
  const signatureText = String(req.header('X-MountReality-Signature') || '').replace(/^sha256=/i, '');
  const timestamp = Number(timestampText);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp * 1000) > 5 * 60 * 1000) return res.status(401).json({ message: 'Webhook timestamp is invalid or stale' });
  const secret = connection.signing_secret_reference ? process.env[connection.signing_secret_reference] : null;
  if (!secret || !/^[a-f0-9]{64}$/i.test(signatureText) || !req.rawBody) return res.status(401).json({ message: 'Webhook signature is invalid' });
  const expected = crypto.createHmac('sha256', secret).update(timestampText).update('.').update(req.rawBody).digest('hex');
  const valid = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signatureText, 'hex'));
  if (!valid) return res.status(401).json({ message: 'Webhook signature is invalid' });
  const eventType = String(req.body?.type || '').trim();
  if (!eventType || !connection.allowed_events.includes(eventType)) return res.status(422).json({ message: 'Webhook event type is not allowed' });
  const payloadHash = crypto.createHash('sha256').update(req.rawBody).digest('hex');
  const externalEventId = String(req.body?.id || req.header('X-Event-ID') || '').trim() || null;
  const idempotencyKey = String(req.header('Idempotency-Key') || externalEventId || payloadHash).slice(0, 180);
  try {
    const inserted = await pool.query(
      `INSERT INTO integration_events
        (connection_id,direction,event_type,external_event_id,idempotency_key,payload_sha256,signature_verified,status,processed_at)
       VALUES ($1,'INBOUND',$2,$3,$4,$5,TRUE,'VALIDATED',NOW()) RETURNING id,status,created_at`,
      [connection.id, eventType, externalEventId, idempotencyKey, payloadHash],
    );
    res.status(202).json({ accepted: true, event: inserted.rows[0], domain_mutation: false });
  } catch (error) {
    if (error.code === '23505') return res.status(200).json({ accepted: true, duplicate: true, domain_mutation: false });
    throw error;
  }
});

