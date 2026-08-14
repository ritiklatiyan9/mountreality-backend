import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';
import {
  addLegalCaseTimeline, applyTemplate, complianceAuditLog, complianceCalendar,
  complianceDashboard, complianceNotifications, complianceReports, createAuthority,
  createChecklistItem, createComplianceCategory, createComplianceEntity, createComplianceItem, createTemplate,
  deleteAuthority, deleteComplianceCategory, deleteComplianceEntity, deleteComplianceItem, deleteTemplate, duplicateTemplate,
  exportTemplates, importTemplates,
  getComplianceEntity, getComplianceItem, getComplianceSettings, getLegalConfiguration, getMyComplianceTasks,
  listAuthorities, listComplianceCategories, listComplianceEntity, listComplianceItems, listComplianceUsers,
  linkComplianceExpense, listTemplates, markAllComplianceNotificationsRead, markComplianceNotificationRead,
  rescheduleComplianceItem, reviewComplianceApproval, reviewDueDateChange,
  unlinkComplianceExpense,
  updateAuthority, updateChecklistItem, updateComplianceCategory, updateComplianceEntity, updateComplianceItem,
  updateComplianceSettings, updateComplianceStatus, updateLegalNoticeStatus, updateTemplate,
} from '../controllers/compliance.controller.js';

const router = express.Router();
const cache = cacheResponse({ ttlSeconds: 45, namespace: 'compliance' });
const bust = invalidateCacheOnSuccess(['compliance|']);

router.use(authMiddleware, requireRole('admin', 'sub_admin'));

router.get('/dashboard', requirePermission('compliance', 'read'), cache, complianceDashboard);
router.get('/calendar', requirePermission('compliance', 'read'), cache, complianceCalendar);
router.get('/my-tasks', requirePermission('compliance', 'read'), getMyComplianceTasks);
router.get('/users', requirePermission('compliance', 'read'), listComplianceUsers);
router.get('/legal-users', requirePermission('legal', 'read'), listComplianceUsers);
router.get('/notifications', requirePermission('compliance', 'read'), complianceNotifications);
router.patch('/notifications/:notificationId/read', requirePermission('compliance', 'read'), markComplianceNotificationRead);
router.post('/notifications/read-all', requirePermission('compliance', 'read'), markAllComplianceNotificationsRead);
router.get('/legal-notifications', requirePermission('legal', 'read'), complianceNotifications);
router.patch('/legal-notifications/:notificationId/read', requirePermission('legal', 'read'), markComplianceNotificationRead);
router.post('/legal-notifications/read-all', requirePermission('legal', 'read'), markAllComplianceNotificationsRead);
router.get('/audit', requirePermission('compliance_settings', 'read'), complianceAuditLog);
router.get('/reports', requirePermission('compliance', 'read'), complianceReports);
router.get('/legal-reports', requirePermission('legal', 'read'), complianceReports);
router.get('/legal-config', requirePermission('legal', 'read'), getLegalConfiguration);

router.get('/items', requirePermission('compliance', 'read'), listComplianceItems);
router.post('/items', requirePermission('compliance', 'write'), bust, createComplianceItem);
router.get('/items/:id', requirePermission('compliance', 'read'), getComplianceItem);
router.patch('/items/:id', requirePermission('compliance', 'update'), bust, updateComplianceItem);
router.delete('/items/:id', requirePermission('compliance', 'delete'), bust, deleteComplianceItem);
router.post('/items/:id/status', requirePermission('compliance', 'update'), bust, updateComplianceStatus);
router.post('/items/:id/reschedule', requirePermission('compliance', 'update'), bust, rescheduleComplianceItem);
router.post('/items/:id/checklist', requirePermission('compliance', 'write'), bust, createChecklistItem);
router.patch('/items/:id/checklist/:checklistId', requirePermission('compliance', 'update'), bust, updateChecklistItem);
router.post('/items/:id/finance-links', requirePermission('compliance', 'update'), bust, linkComplianceExpense);
router.delete('/items/:id/finance-links/:linkId', requirePermission('compliance', 'update'), bust, unlinkComplianceExpense);

router.post('/due-date-changes/:changeId/review', requirePermission('compliance_settings', 'update'), bust, reviewDueDateChange);
router.post('/approvals/:approvalId/review', requirePermission('compliance_settings', 'update'), bust, reviewComplianceApproval);
router.post('/legal-approvals/:approvalId/review', requirePermission('legal', 'update'), bust, reviewComplianceApproval);

router.get('/categories', requirePermission('compliance', 'read'), listComplianceCategories);
router.post('/categories', requirePermission('compliance_settings', 'write'), bust, createComplianceCategory);
router.patch('/categories/:id', requirePermission('compliance_settings', 'update'), bust, updateComplianceCategory);
router.delete('/categories/:id', requirePermission('compliance_settings', 'delete'), bust, deleteComplianceCategory);

router.get('/authorities', requirePermission('compliance', 'read'), listAuthorities);
router.get('/legal-authorities', requirePermission('legal', 'read'), listAuthorities);
router.post('/authorities', requirePermission('compliance_settings', 'write'), bust, createAuthority);
router.patch('/authorities/:id', requirePermission('compliance_settings', 'update'), bust, updateAuthority);
router.delete('/authorities/:id', requirePermission('compliance_settings', 'delete'), bust, deleteAuthority);

router.get('/templates', requirePermission('compliance_templates', 'read'), listTemplates);
router.get('/templates-export', requirePermission('compliance_templates', 'read'), exportTemplates);
router.post('/templates-import', requirePermission('compliance_templates', 'write'), bust, importTemplates);
router.post('/templates', requirePermission('compliance_templates', 'write'), bust, createTemplate);
router.patch('/templates/:id', requirePermission('compliance_templates', 'update'), bust, updateTemplate);
router.delete('/templates/:id', requirePermission('compliance_templates', 'delete'), bust, deleteTemplate);
router.post('/templates/:id/duplicate', requirePermission('compliance_templates', 'write'), bust, duplicateTemplate);
router.post('/templates/:id/apply', requirePermission('compliance_templates', 'write'), bust, applyTemplate);

router.get('/settings', requirePermission('compliance_settings', 'read'), getComplianceSettings);
router.put('/settings', requirePermission('compliance_settings', 'update'), bust, updateComplianceSettings);

// Approval and licence register.
router.get('/licences', requirePermission('compliance', 'read'), listComplianceEntity('licence'));
router.post('/licences', requirePermission('compliance', 'write'), bust, createComplianceEntity('licence'));
router.get('/licences/:id', requirePermission('compliance', 'read'), getComplianceEntity('licence'));
router.patch('/licences/:id', requirePermission('compliance', 'update'), bust, updateComplianceEntity('licence'));
router.delete('/licences/:id', requirePermission('compliance', 'delete'), bust, deleteComplianceEntity('licence'));

// Legal matters, notices and hearing/case timeline.
router.get('/legal-cases', requirePermission('legal', 'read'), listComplianceEntity('case'));
router.post('/legal-cases', requirePermission('legal', 'write'), bust, createComplianceEntity('case'));
router.get('/legal-cases/:id', requirePermission('legal', 'read'), getComplianceEntity('case'));
router.patch('/legal-cases/:id', requirePermission('legal', 'update'), bust, updateComplianceEntity('case'));
router.delete('/legal-cases/:id', requirePermission('legal', 'delete'), bust, deleteComplianceEntity('case'));
router.post('/legal-cases/:id/timeline', requirePermission('legal', 'write'), bust, addLegalCaseTimeline);

router.get('/notices', requirePermission('legal', 'read'), listComplianceEntity('notice'));
router.post('/notices', requirePermission('legal', 'write'), bust, createComplianceEntity('notice'));
router.get('/notices/:id', requirePermission('legal', 'read'), getComplianceEntity('notice'));
router.patch('/notices/:id', requirePermission('legal', 'update'), bust, updateComplianceEntity('notice'));
router.post('/notices/:id/status', requirePermission('legal', 'update'), bust, updateLegalNoticeStatus);
router.delete('/notices/:id', requirePermission('legal', 'delete'), bust, deleteComplianceEntity('notice'));

router.get('/inspections', requirePermission('compliance', 'read'), listComplianceEntity('inspection'));
router.post('/inspections', requirePermission('compliance', 'write'), bust, createComplianceEntity('inspection'));
router.get('/inspections/:id', requirePermission('compliance', 'read'), getComplianceEntity('inspection'));
router.patch('/inspections/:id', requirePermission('compliance', 'update'), bust, updateComplianceEntity('inspection'));
router.delete('/inspections/:id', requirePermission('compliance', 'delete'), bust, deleteComplianceEntity('inspection'));

export default router;
