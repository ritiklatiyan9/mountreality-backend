import crypto from 'crypto';
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { hashPassword } from '../config/jwt.js';
import { sendPortalInvitationEmail } from '../utils/mailer.js';
import { assertPortalSeatAvailable } from '../services/entitlement.service.js';
import { writePortalAudit } from '../services/portalAccess.service.js';

const TYPES = new Set(['BUYER', 'BROKER', 'PROFESSIONAL']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

const id = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
const normalizedType = (value) => String(value || '').trim().toUpperCase();
const normalizedEmail = (value) => String(value || '').trim().toLowerCase();
const hashToken = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const ACTIONS = Object.freeze({
  BUYER: new Set(['view_booking', 'view_payments', 'view_documents', 'view_updates', 'comment']),
  BROKER: new Set(['view_inventory', 'view_commissions', 'view_documents', 'comment']),
  PROFESSIONAL: new Set(['view_certifications', 'view_documents', 'comment', 'transition_certification', 'view_finance', 'view_legal']),
});
const DEFAULT_ACTIONS = Object.freeze({
  BUYER: ['view_booking', 'view_payments', 'view_documents', 'view_updates', 'comment'],
  BROKER: ['view_inventory', 'view_commissions', 'view_documents', 'comment'],
  PROFESSIONAL: ['view_certifications', 'view_documents', 'comment', 'transition_certification'],
});

function permissionPolicy(portalType, raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const requested = Array.isArray(input.actions) ? input.actions.map(String) : DEFAULT_ACTIONS[portalType];
  const actions = [...new Set(requested.filter((action) => ACTIONS[portalType].has(action)))];
  return { actions };
}

async function validatePortalScope({ organizationId, siteId, projectId, phaseId, portalType, domainEntityId }, db) {
  if (!siteId) throw Object.assign(new Error('A valid site_id is required'), { status: 400, code: 'SITE_REQUIRED' });
  const { rows: sites } = await db.query('SELECT id,name FROM sites WHERE id=$1 AND organization_id=$2', [siteId, organizationId]);
  if (!sites[0]) throw Object.assign(new Error('Site is outside your organization'), { status: 403, code: 'SITE_SCOPE_DENIED' });

  if (projectId) {
    const { rows } = await db.query(
      `SELECT id FROM rera_projects WHERE id=$1 AND organization_id=$2 AND site_id=$3 AND deleted_at IS NULL`,
      [projectId, organizationId, siteId],
    );
    if (!rows[0]) throw Object.assign(new Error('Project is outside the selected Site'), { status: 400, code: 'PROJECT_SCOPE_INVALID' });
  }
  if (phaseId) {
    if (!projectId) throw Object.assign(new Error('A phase requires rera_project_id'), { status: 400, code: 'PROJECT_REQUIRED' });
    const { rows } = await db.query(
      `SELECT id FROM rera_project_phases WHERE id=$1 AND organization_id=$2 AND site_id=$3 AND rera_project_id=$4 AND deleted_at IS NULL`,
      [phaseId, organizationId, siteId, projectId],
    );
    if (!rows[0]) throw Object.assign(new Error('Phase is outside the selected project'), { status: 400, code: 'PHASE_SCOPE_INVALID' });
  }

  if (portalType === 'PROFESSIONAL') {
    if (!projectId) throw Object.assign(new Error('Professional invitations require a project'), { status: 400, code: 'PROJECT_REQUIRED' });
    const { rows } = await db.query(
      `SELECT rs.id,rs.legal_name AS identity_name
         FROM rera_stakeholders rs
        WHERE rs.id=$1 AND rs.organization_id=$2 AND rs.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM rera_project_participants pp
             WHERE pp.organization_id=$2 AND pp.rera_project_id=$3
               AND pp.stakeholder_id=rs.id AND pp.deleted_at IS NULL
               AND ($4::bigint IS NULL OR pp.rera_project_phase_id IS NULL OR pp.rera_project_phase_id=$4)
          )`,
      [domainEntityId, organizationId, projectId, phaseId],
    );
    if (!rows[0]) throw Object.assign(new Error('Professional is not assigned to this project scope'), { status: 400, code: 'PROFESSIONAL_NOT_ASSIGNED' });
    return { domainEntityType: 'RERA_STAKEHOLDER', identityName: rows[0].identity_name, siteName: sites[0].name };
  }

  const requiredMemberType = portalType === 'BROKER' ? 'BROKER' : null;
  const { rows } = await db.query(
    `SELECT id,full_name,member_type,email
       FROM members
      WHERE id=$1 AND site_id=$2
        AND ($3::text IS NULL OR member_type=$3)
        AND ($3::text IS NOT NULL OR member_type IN ('CLIENT','MEMBER'))`,
    [domainEntityId, siteId, requiredMemberType],
  );
  if (!rows[0]) throw Object.assign(new Error(`A matching ${portalType.toLowerCase()} member was not found in this Site`), { status: 400, code: 'DOMAIN_IDENTITY_INVALID' });

  if (portalType === 'BUYER') {
    const booking = await db.query(
      `SELECT 1 FROM bookings b
        WHERE b.organization_id=$1 AND b.site_id=$2
          AND ($4::bigint IS NULL OR b.rera_project_id=$4)
          AND ($5::bigint IS NULL OR b.rera_project_phase_id=$5)
          AND (b.client_member_id=$3 OR EXISTS (
            SELECT 1 FROM booking_allottees ba
             WHERE ba.booking_id=b.id AND ba.member_id=$3 AND ba.status='ACTIVE'
          ))
          AND COALESCE(b.lifecycle_status,'DRAFT') NOT IN ('CANCELLED','TRANSFERRED','CLOSED') LIMIT 1`,
      [organizationId, siteId, domainEntityId, projectId, phaseId],
    );
    if (!booking.rows[0]) throw Object.assign(new Error('Buyer has no active booking in the selected scope'), { status: 409, code: 'BUYER_BOOKING_REQUIRED' });
  }
  return { domainEntityType: 'MEMBER', identityName: rows[0].full_name, siteName: sites[0].name };
}

export const createPortalInvitation = asyncHandler(async (req, res) => {
  const portalType = normalizedType(req.body.portal_type);
  const email = normalizedEmail(req.body.email);
  const siteId = id(req.body.site_id);
  const projectId = req.body.rera_project_id ? id(req.body.rera_project_id) : null;
  const phaseId = req.body.rera_project_phase_id ? id(req.body.rera_project_phase_id) : null;
  const domainEntityId = id(req.body.domain_entity_id);
  if (!TYPES.has(portalType) || !EMAIL_RE.test(email) || !domainEntityId) {
    return res.status(400).json({ message: 'portal_type, email and a valid domain_entity_id are required' });
  }
  const expiresInDays = Math.min(Math.max(Number(req.body.expires_in_days) || 7, 1), 30);
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const client = await pool.connect();
  let invitation;
  let identity;
  try {
    await client.query('BEGIN');
    identity = await validatePortalScope({
      organizationId: req.user.organization_id, siteId, projectId, phaseId,
      portalType, domainEntityId,
    }, client);
    await assertPortalSeatAvailable({ organizationId: req.user.organization_id, portalType, db: client });
    const existingUser = await client.query('SELECT id,organization_id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1', [email]);
    if (existingUser.rows[0] && existingUser.rows[0].organization_id !== req.user.organization_id) {
      throw Object.assign(new Error('That identity belongs to another organization'), { status: 409, code: 'IDENTITY_TENANT_CONFLICT' });
    }
    const { rows } = await client.query(
      `INSERT INTO portal_invitations
        (organization_id,site_id,rera_project_id,rera_project_phase_id,portal_type,
         domain_entity_type,domain_entity_id,email,token_hash,permission_policy,
         expires_at,invited_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()+($11||' days')::interval,$12)
       RETURNING id,organization_id,site_id,rera_project_id,rera_project_phase_id,
                 portal_type,domain_entity_type,domain_entity_id,email,status,expires_at,created_at`,
      [req.user.organization_id, siteId, projectId, phaseId, portalType,
        identity.domainEntityType, domainEntityId, email, hashToken(rawToken),
        permissionPolicy(portalType, req.body.permission_policy), expiresInDays, req.user.id],
    );
    invitation = rows[0];
    await writePortalAudit({
      organizationId: req.user.organization_id, siteId, userId: req.user.id,
      action: 'PORTAL_INVITATION_CREATED', entityType: 'PORTAL_INVITATION', entityId: invitation.id,
      newValue: { portal_type: portalType, domain_entity_type: identity.domainEntityType, domain_entity_id: domainEntityId, email },
      ipAddress: req.ip,
    }, client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ message: 'A pending invitation already exists for this identity and scope' });
    if (error.status) return res.status(error.status).json({ code: error.code, message: error.message });
    throw error;
  } finally {
    client.release();
  }

  const invitationUrl = `${FRONTEND_URL}/portal/accept?token=${encodeURIComponent(rawToken)}`;
  const { rows: orgRows } = await pool.query('SELECT name FROM organizations WHERE id=$1', [req.user.organization_id]);
  let delivery = 'QUEUED';
  try {
    await sendPortalInvitationEmail({
      to: email, name: identity.identityName, portalType,
      organizationName: orgRows[0]?.name || 'Your organization', invitationUrl,
      expiresAt: new Date(invitation.expires_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    });
    delivery = 'SENT';
  } catch (error) {
    delivery = 'NOT_SENT';
    console.error('[portal invitation] email failed:', error.message);
  }
  res.status(201).json({ invitation, invitation_url: invitationUrl, email_delivery: delivery });
});

export const listPortalIdentityAdmin = asyncHandler(async (req, res) => {
  const [invitations, memberships] = await Promise.all([
    pool.query(
      `SELECT pi.id,pi.portal_type,pi.email,pi.domain_entity_type,pi.domain_entity_id,
              pi.site_id,pi.rera_project_id,pi.rera_project_phase_id,pi.status,
              pi.expires_at,pi.accepted_at,pi.revoked_at,pi.created_at,
              s.name AS site_name,rp.name AS project_name
         FROM portal_invitations pi
         LEFT JOIN sites s ON s.id=pi.site_id
         LEFT JOIN rera_projects rp ON rp.id=pi.rera_project_id
        WHERE pi.organization_id=$1 ORDER BY pi.created_at DESC LIMIT 250`,
      [req.user.organization_id],
    ),
    pool.query(
      `SELECT pm.id,pm.user_id,pm.portal_type,pm.domain_entity_type,pm.domain_entity_id,
              pm.site_id,pm.rera_project_id,pm.rera_project_phase_id,pm.status,
              pm.permission_policy,pm.effective_from,pm.effective_to,pm.created_at,
              u.name,u.email,s.name AS site_name,rp.name AS project_name
         FROM portal_memberships pm JOIN users u ON u.id=pm.user_id
         LEFT JOIN sites s ON s.id=pm.site_id LEFT JOIN rera_projects rp ON rp.id=pm.rera_project_id
        WHERE pm.organization_id=$1 ORDER BY pm.created_at DESC LIMIT 250`,
      [req.user.organization_id],
    ),
  ]);
  res.json({ invitations: invitations.rows, memberships: memberships.rows });
});

export const revokePortalInvitation = asyncHandler(async (req, res) => {
  const invitationId = id(req.params.invitationId);
  if (!invitationId) return res.status(400).json({ message: 'Invalid invitation ID' });
  const { rows } = await pool.query(
    `UPDATE portal_invitations SET status='REVOKED',revoked_by=$1,revoked_at=NOW()
      WHERE id=$2 AND organization_id=$3 AND status='PENDING' RETURNING id,status,revoked_at,site_id`,
    [req.user.id, invitationId, req.user.organization_id],
  );
  if (!rows[0]) return res.status(404).json({ message: 'Pending invitation not found' });
  await writePortalAudit({ organizationId: req.user.organization_id, siteId: rows[0].site_id, userId: req.user.id, action: 'PORTAL_INVITATION_REVOKED', entityType: 'PORTAL_INVITATION', entityId: invitationId, ipAddress: req.ip });
  res.json({ invitation: rows[0] });
});

export const revokePortalMembership = asyncHandler(async (req, res) => {
  const membershipId = id(req.params.membershipId);
  if (!membershipId) return res.status(400).json({ message: 'Invalid membership ID' });
  const { rows } = await pool.query(
    `UPDATE portal_memberships
        SET status='REVOKED',revoked_by=$1,revoked_at=NOW(),effective_to=COALESCE(effective_to,NOW()),updated_at=NOW()
      WHERE id=$2 AND organization_id=$3 AND status IN ('PENDING','ACTIVE','SUSPENDED')
      RETURNING id,status,revoked_at,site_id,user_id`,
    [req.user.id, membershipId, req.user.organization_id],
  );
  if (!rows[0]) return res.status(404).json({ message: 'Active membership not found' });
  await pool.query('UPDATE users SET token_version=token_version+1 WHERE id=$1', [rows[0].user_id]);
  await writePortalAudit({ organizationId: req.user.organization_id, siteId: rows[0].site_id, userId: req.user.id, action: 'PORTAL_MEMBERSHIP_REVOKED', entityType: 'PORTAL_MEMBERSHIP', entityId: membershipId, ipAddress: req.ip });
  res.json({ membership: rows[0] });
});

export const acceptPortalInvitation = asyncHandler(async (req, res) => {
  const rawToken = String(req.body.token || '').trim();
  if (rawToken.length < 32 || rawToken.length > 128) return res.status(400).json({ message: 'A valid invitation token is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM portal_invitations WHERE token_hash=$1 FOR UPDATE`,
      [hashToken(rawToken)],
    );
    const invitation = rows[0];
    if (!invitation || invitation.status !== 'PENDING') {
      await client.query('ROLLBACK');
      return res.status(410).json({ message: 'Invitation is invalid or no longer available' });
    }
    if (new Date(invitation.expires_at).getTime() <= Date.now()) {
      await client.query(`UPDATE portal_invitations SET status='EXPIRED' WHERE id=$1`, [invitation.id]);
      await client.query('COMMIT');
      return res.status(410).json({ message: 'Invitation has expired' });
    }
    await assertPortalSeatAvailable({ organizationId: invitation.organization_id, portalType: invitation.portal_type, db: client });

    const existing = await client.query('SELECT * FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1 FOR UPDATE', [invitation.email]);
    let user = existing.rows[0];
    if (user && user.organization_id !== invitation.organization_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'IDENTITY_TENANT_CONFLICT', message: 'This email is already linked to another organization' });
    }
    if (!user) {
      const password = String(req.body.password || '');
      const name = String(req.body.name || '').trim();
      if (!name || password.length < 10) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'Name and a password of at least 10 characters are required' });
      }
      const created = await client.query(
        `INSERT INTO users (name,email,password,role,organization_id,is_active,token_version,email_verified_at)
         VALUES ($1,$2,$3,'portal_user',$4,TRUE,1,NOW()) RETURNING *`,
        [name, invitation.email, await hashPassword(password), invitation.organization_id],
      );
      user = created.rows[0];
    } else if (!user.is_active) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'The linked account is inactive. Contact the organization administrator.' });
    }

    const membership = await client.query(
      `INSERT INTO portal_memberships
        (user_id,organization_id,site_id,rera_project_id,rera_project_phase_id,
         portal_type,domain_entity_type,domain_entity_id,permission_policy,status,
         effective_from,effective_to,invitation_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE',$10,$11,$12,$13)
       RETURNING id,portal_type,site_id,rera_project_id,rera_project_phase_id,status`,
      [user.id, invitation.organization_id, invitation.site_id, invitation.rera_project_id,
        invitation.rera_project_phase_id, invitation.portal_type, invitation.domain_entity_type,
        invitation.domain_entity_id, invitation.permission_policy, invitation.effective_from,
        invitation.effective_to, invitation.id, invitation.invited_by],
    );
    await client.query(
      `UPDATE portal_invitations SET status='ACCEPTED',accepted_by=$1,accepted_at=NOW() WHERE id=$2`,
      [user.id, invitation.id],
    );
    await client.query(
      `INSERT INTO portal_notification_preferences (membership_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [membership.rows[0].id],
    );
    await writePortalAudit({
      organizationId: invitation.organization_id, siteId: invitation.site_id, userId: user.id,
      action: 'PORTAL_INVITATION_ACCEPTED', entityType: 'PORTAL_MEMBERSHIP', entityId: membership.rows[0].id,
      newValue: { invitation_id: invitation.id, portal_type: invitation.portal_type }, ipAddress: req.ip,
    }, client);
    await client.query('COMMIT');
    res.status(201).json({ message: 'Invitation accepted. Sign in to continue.', membership: membership.rows[0], existing_account: Boolean(existing.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ message: 'This portal membership already exists' });
    if (error.status) return res.status(error.status).json({ code: error.code, message: error.message });
    throw error;
  } finally {
    client.release();
  }
});
