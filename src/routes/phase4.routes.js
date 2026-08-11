import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import createRateLimiter from '../middlewares/rateLimit.middleware.js';
import { resolveEntitlement, requireEntitlement, PORTAL_FEATURE } from '../services/entitlement.service.js';
import { requirePortalMembership } from '../services/portalAccess.service.js';
import {
  createPortalInvitation, listPortalIdentityAdmin, revokePortalInvitation, revokePortalMembership,
} from '../controllers/portalInvitation.controller.js';
import {
  createPortalComment, getBrokerCommission, getBrokerHome, getBuyerHome, getBuyerPayments,
  getBuyerUpcomingInstallments,
  getPortalContext, getPortalNotificationPreferences, listPortalComments, listPortalDocuments,
  listPortalNotifications, listPortalUpdates, listProfessionalCertifications,
  markPortalNotificationRead, resolvePortalComment, streamPortalDocument, transitionProfessionalCertification,
  updatePortalNotificationPreferences,
} from '../controllers/portal.controller.js';
import {
  getClientPortalAdminConfiguration,
  updateClientPortalAdminConfiguration,
} from '../controllers/portalConfiguration.controller.js';
import {
  listAudienceReleases, releasePortalDocument, releasePortalInventory,
  releasePortalProjectUpdate, withdrawAudienceRelease,
} from '../controllers/phase4Release.controller.js';
import {
  createRulesetReleaseWorkflow, listRulesetReleaseWorkflows, transitionRulesetReleaseWorkflow,
} from '../controllers/rulesetRelease.controller.js';
import {
  acceptGroupInvitation, assignSiteLegalEntity, createDeveloperGroup, createLegalEntity,
  getEnterprisePortfolio, inviteOrganizationToGroup, listEnterpriseStructure,
} from '../controllers/enterprisePortfolio.controller.js';
import {
  createIntegrationConnection, listIntegrationConnections, receiveIntegrationWebhook, updateIntegrationStatus,
} from '../controllers/integrationFramework.controller.js';
import { listOrganizationEntitlements } from '../controllers/entitlement.controller.js';

const router = express.Router();
const webhookLimiter = createRateLimiter({
  windowMs: 60_000, max: 120, keyPrefix: 'integration-webhook:', requireUser: false,
  keyGenerator: (req) => `${req.ip || 'unknown'}:${req.params.connectionId || ''}`,
});
const portalTrafficLimiter = createRateLimiter({
  windowMs: 60_000, max: 240, keyPrefix: 'portal-traffic:',
  keyGenerator: (req) => req.user?.id || 'anonymous',
});
const portalMutationLimiter = createRateLimiter({
  windowMs: 60_000, max: 40, keyPrefix: 'portal-mutation:',
  keyGenerator: (req) => req.user?.id || 'anonymous',
});
const portalAdminMutationLimiter = createRateLimiter({
  windowMs: 60_000, max: 30, keyPrefix: 'portal-admin-mutation:',
});

// Signed, timestamped and idempotent. This route must remain before auth.
router.post('/webhooks/:connectionId/:connectionKey', webhookLimiter, receiveIntegrationWebhook);

router.use(authMiddleware);
router.use('/portal', portalTrafficLimiter, (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  res.set('Pragma', 'no-cache');
  res.set('Vary', 'Authorization, X-Portal-Membership-ID');
  next();
});
router.get('/portal/context', getPortalContext);

router.get('/portal/buyer/home', requirePortalMembership('BUYER'), getBuyerHome);
router.get('/portal/buyer/payments', requirePortalMembership('BUYER'), getBuyerPayments);
router.get('/portal/buyer/installments', requirePortalMembership('BUYER'), getBuyerUpcomingInstallments);

router.get('/portal/broker/home', requirePortalMembership('BROKER'), getBrokerHome);
router.get('/portal/broker/commissions/:commissionId', requirePortalMembership('BROKER'), getBrokerCommission);

router.get('/portal/professional/certifications', requirePortalMembership('PROFESSIONAL'), listProfessionalCertifications);
router.patch('/portal/professional/certifications/:certificationId/status', requirePortalMembership('PROFESSIONAL'), transitionProfessionalCertification);

router.get('/portal/documents', requirePortalMembership(), listPortalDocuments);
router.get('/portal/documents/:grantId/content', requirePortalMembership(), streamPortalDocument);
router.get('/portal/updates', requirePortalMembership(), listPortalUpdates);
router.get('/portal/comments', requirePortalMembership(), listPortalComments);
router.post('/portal/comments', portalMutationLimiter, requirePortalMembership(), createPortalComment);
router.patch('/portal/comments/:commentId/resolve', portalMutationLimiter, requirePortalMembership(), resolvePortalComment);
router.get('/portal/notifications', requirePortalMembership(), listPortalNotifications);
router.patch('/portal/notifications/:notificationId/read', portalMutationLimiter, requirePortalMembership(), markPortalNotificationRead);
router.get('/portal/notification-preferences', requirePortalMembership(), getPortalNotificationPreferences);
router.put('/portal/notification-preferences', portalMutationLimiter, requirePortalMembership(), updatePortalNotificationPreferences);

const requireAdmin = requireRole('admin');
const requireBodyPortalEntitlements = async (req, res, next) => {
  try {
    const types = req.path.endsWith('/project-updates')
      ? [...new Set((Array.isArray(req.body.audience_types) ? req.body.audience_types : []).map((value) => String(value).toUpperCase()))]
      : [String(req.body.portal_type || 'BROKER').toUpperCase()];
    for (const portalType of types) {
      if (!PORTAL_FEATURE[portalType]) return res.status(400).json({ message: 'Invalid portal audience type' });
      const entitlement = await resolveEntitlement(req.user.organization_id, PORTAL_FEATURE[portalType]);
      if (!entitlement.enabled) return res.status(403).json({ code: 'FEATURE_NOT_ENTITLED', feature: PORTAL_FEATURE[portalType], message: 'That portal is not enabled for the organization plan' });
    }
    return next();
  } catch (error) { return next(error); }
};

router.get('/admin/entitlements', requireAdmin, listOrganizationEntitlements);
router.get('/admin/client-portal-configuration', requireAdmin, getClientPortalAdminConfiguration);
router.put('/admin/client-portal-configuration', requireAdmin, portalAdminMutationLimiter, updateClientPortalAdminConfiguration);
router.get('/admin/portal-identities', requireAdmin, listPortalIdentityAdmin);
router.post('/admin/portal-invitations', requireAdmin, portalAdminMutationLimiter, createPortalInvitation);
router.delete('/admin/portal-invitations/:invitationId', requireAdmin, portalAdminMutationLimiter, revokePortalInvitation);
router.delete('/admin/portal-memberships/:membershipId', requireAdmin, portalAdminMutationLimiter, revokePortalMembership);

router.get('/admin/audience-releases', requireAdmin, listAudienceReleases);
router.post('/admin/document-releases', requireAdmin, requireBodyPortalEntitlements, releasePortalDocument);
router.post('/admin/inventory-releases', requireAdmin, requireBodyPortalEntitlements, releasePortalInventory);
router.post('/admin/project-updates', requireAdmin, requireBodyPortalEntitlements, releasePortalProjectUpdate);
router.post('/admin/releases/:releaseType/:releaseId/withdraw', requireAdmin, withdrawAudienceRelease);

router.get('/admin/ruleset-releases', requireRole('admin', 'sub_admin'), requirePermission('rera_rulesets', 'read'), listRulesetReleaseWorkflows);
router.post('/admin/ruleset-releases', requireRole('admin', 'sub_admin'), requirePermission('rera_rulesets', 'write'), requireEntitlement('ruleset_packs'), createRulesetReleaseWorkflow);
router.patch('/admin/ruleset-releases/:workflowId/status', requireRole('admin', 'sub_admin'), requirePermission('rera_rulesets', 'update'), requireEntitlement('ruleset_packs'), transitionRulesetReleaseWorkflow);

router.get('/admin/integrations', requireAdmin, requireEntitlement('api_access'), listIntegrationConnections);
router.post('/admin/integrations', requireAdmin, requireEntitlement('api_access'), createIntegrationConnection);
router.patch('/admin/integrations/:connectionId/status', requireAdmin, requireEntitlement('api_access'), updateIntegrationStatus);

router.get('/admin/enterprise/structure', requireAdmin, requireEntitlement('enterprise_portfolio'), listEnterpriseStructure);
router.post('/admin/enterprise/groups', requireAdmin, requireEntitlement('enterprise_portfolio'), createDeveloperGroup);
router.post('/admin/enterprise/groups/:groupId/organizations', requireAdmin, requireEntitlement('enterprise_portfolio'), inviteOrganizationToGroup);
router.post('/admin/enterprise/groups/:groupId/accept', requireAdmin, requireEntitlement('enterprise_portfolio'), acceptGroupInvitation);
router.post('/admin/enterprise/legal-entities', requireAdmin, requireEntitlement('enterprise_portfolio'), createLegalEntity);
router.post('/admin/enterprise/site-assignments', requireAdmin, requireEntitlement('enterprise_portfolio'), assignSiteLegalEntity);
router.get('/admin/enterprise/portfolio', requireAdmin, requireEntitlement('enterprise_portfolio'), getEnterprisePortfolio);

export default router;
