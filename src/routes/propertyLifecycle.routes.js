import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import requirePropertyLifecycleSiteAccess from '../middlewares/propertyLifecycleSiteAccess.middleware.js';
import {
  attachAgreementDocument,
  createAgreementRevision,
  createBooking,
  createPossession,
  createProjectAccountMapping,
  createProjectTransactionAllocation,
  createRefund,
  decideCancellation,
  executeTransfer,
  getBookingLifecycle,
  getProjectFinance,
  getRegistryReadiness,
  listPropertyWorkspace,
  mapPropertyProject,
  postRefund,
  previewCollectionGuard,
  reconcilePayment,
  requestCancellation,
  requestTransfer,
  reviewProjectAccountMapping,
  transitionAgreement,
  transitionPossession,
  transitionRegistryLifecycle,
} from '../controllers/propertyLifecycle.controller.js';

const router = express.Router();
router.use(authMiddleware, requireRole('admin', 'sub_admin'));

const paymentSite = (entity, source, key) => requirePropertyLifecycleSiteAccess({ entity, source, key, module: 'plot_payments' });
const registrySite = (entity, source, key) => requirePropertyLifecycleSiteAccess({ entity, source, key, module: 'plot_registry' });

router.get('/workspace', paymentSite('site', 'query', 'site_id'), requirePermission('plot_payments', 'read'), listPropertyWorkspace);
router.get('/project-finance', paymentSite('site', 'query', 'site_id'), requirePermission('plot_payments', 'read'), getProjectFinance);
router.post('/project-finance/accounts', paymentSite('site', 'body', 'site_id'), requirePermission('plot_payments', 'update'), createProjectAccountMapping);
router.patch('/project-finance/accounts/:mappingId/review', paymentSite('projectAccount', 'params', 'mappingId'), requirePermission('plot_payments', 'update'), reviewProjectAccountMapping);
router.post('/project-finance/allocations', paymentSite('site', 'body', 'site_id'), requirePermission('plot_payments', 'update'), createProjectTransactionAllocation);

router.post('/bookings', paymentSite('plot', 'body', 'plot_id'), requirePermission('plot_payments', 'write'), createBooking);
router.get('/bookings/:bookingId', paymentSite('booking', 'params', 'bookingId'), requirePermission('plot_payments', 'read'), getBookingLifecycle);
router.patch('/plots/:plotId/mapping', paymentSite('plot', 'params', 'plotId'), requirePermission('plot_payments', 'update'), mapPropertyProject);

router.post('/bookings/:bookingId/agreements', paymentSite('booking', 'params', 'bookingId'), requirePermission('plot_payments', 'write'), createAgreementRevision);
router.patch('/agreements/:agreementId/status', paymentSite('agreement', 'params', 'agreementId'), requirePermission('plot_payments', 'update'), transitionAgreement);
router.post('/agreements/:agreementId/documents/:documentId', paymentSite('agreement', 'params', 'agreementId'), requirePermission('plot_payments', 'update'), attachAgreementDocument);
router.post('/collections/guard', paymentSite('site', 'body', 'site_id'), requirePermission('plot_payments', 'write'), previewCollectionGuard);

router.post('/bookings/:bookingId/cancellations', paymentSite('booking', 'params', 'bookingId'), requirePermission('plot_payments', 'update'), requestCancellation);
router.patch('/cancellations/:cancellationId/decision', paymentSite('cancellation', 'params', 'cancellationId'), requirePermission('plot_payments', 'update'), decideCancellation);
router.post('/cancellations/:cancellationId/refunds', paymentSite('cancellation', 'params', 'cancellationId'), requirePermission('plot_payments', 'write'), createRefund);
router.post('/refunds/:refundId/post', paymentSite('refund', 'params', 'refundId'), requirePermission('plot_payments', 'update'), postRefund);

router.post('/bookings/:bookingId/transfers', paymentSite('booking', 'params', 'bookingId'), requirePermission('plot_payments', 'update'), requestTransfer);
router.post('/transfers/:transferId/execute', paymentSite('transfer', 'params', 'transferId'), requirePermission('plot_payments', 'update'), executeTransfer);

router.get('/registries/:registryId/readiness', registrySite('registry', 'params', 'registryId'), requirePermission('plot_registry', 'read'), getRegistryReadiness);
router.patch('/registries/:registryId/status', registrySite('registry', 'params', 'registryId'), requirePermission('plot_registry', 'update'), transitionRegistryLifecycle);
router.post('/registries/:registryId/possession', registrySite('registry', 'params', 'registryId'), requirePermission('plot_registry', 'write'), createPossession);
router.patch('/possessions/:possessionId/status', registrySite('possession', 'params', 'possessionId'), requirePermission('plot_registry', 'update'), transitionPossession);

router.post('/payments/:paymentId/reconcile', paymentSite('payment', 'params', 'paymentId'), requirePermission('plot_payments', 'update'), reconcilePayment);

export default router;
