import express from 'express';
const router = express.Router();

import {
  listProjects, createProject, getProject, updateProject, deleteProject,
  createTask, updateTask, deleteTask,
  createMaterialRequest, getMaterialRequest, issueMaterialRequest, updateMaterialRequest,
  consumeMaterial, constructionSummary,
} from '../controllers/construction.controller.js';
import {
  createCertification,
  createCostForecast,
  createDailyUpdate,
  createFilingPeriod,
  createFilingSnapshot,
  createProjectControl,
  createRisk,
  createWorkPackage,
  getConstructionCommandCentre,
  getWorkPackage,
  listCertifications,
  listFilingPeriods,
  listProjectControls,
  linkWorkPackageCommitment,
  recordFilingSubmission,
  reviseSchedule,
  runFilingReconciliation,
  transitionCertification,
  transitionFilingPeriod,
  transitionProjectControl,
  updateWorkPackage,
  updateFilingRequirement,
} from '../controllers/constructionPhase3.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import requireConstructionSiteAccess from '../middlewares/constructionSiteAccess.middleware.js';

const accessByQuerySite = requireConstructionSiteAccess({ entity: 'site', source: 'query', key: 'site_id' });
const accessByBodySite = requireConstructionSiteAccess({ entity: 'site', source: 'body', key: 'site_id' });
const accessByProject = requireConstructionSiteAccess({ entity: 'project', source: 'params', key: 'id' });
const accessByTask = requireConstructionSiteAccess({ entity: 'task', source: 'params', key: 'taskId' });
const accessByRequest = requireConstructionSiteAccess({ entity: 'request', source: 'params', key: 'reqId' });
const accessByBodyProject = requireConstructionSiteAccess({ entity: 'project', source: 'body', key: 'construction_project_id' });
const accessByBodyPackage = requireConstructionSiteAccess({ entity: 'workPackage', source: 'body', key: 'work_package_id' });
const accessByPackage = requireConstructionSiteAccess({ entity: 'workPackage', source: 'params', key: 'workPackageId' });
const accessByCertification = requireConstructionSiteAccess({ entity: 'certification', source: 'params', key: 'certificationId', module: 'rera_evidence' });
const accessByFiling = requireConstructionSiteAccess({ entity: 'filing', source: 'params', key: 'filingId', module: 'rera_projects' });
const accessByChange = requireConstructionSiteAccess({ entity: 'change', source: 'params', key: 'controlId', module: 'rera_projects' });
const accessByExtension = requireConstructionSiteAccess({ entity: 'extension', source: 'params', key: 'controlId', module: 'rera_projects' });
const reraAccessByQuerySite = requireConstructionSiteAccess({ entity: 'site', source: 'query', key: 'site_id', module: 'rera_projects' });
const evidenceAccessByQuerySite = requireConstructionSiteAccess({ entity: 'site', source: 'query', key: 'site_id', module: 'rera_evidence' });
const reraAccessByBodyProject = requireConstructionSiteAccess({ entity: 'project', source: 'body', key: 'construction_project_id', module: 'rera_projects' });
const evidenceAccessByBodyProject = requireConstructionSiteAccess({ entity: 'project', source: 'body', key: 'construction_project_id', module: 'rera_evidence' });

router.use(authMiddleware);

// Dashboard summary
router.get('/summary', accessByQuerySite, requirePermission('construction', 'read'), constructionSummary);
router.get('/command-centre', accessByQuerySite, requirePermission('construction', 'read'), getConstructionCommandCentre);

// Phase 3 operational WBS. These extend the existing Construction aggregate.
router.post('/projects/:id/work-packages', accessByProject, requirePermission('construction', 'write'), createWorkPackage);
router.get('/work-packages/:workPackageId', accessByPackage, requirePermission('construction', 'read'), getWorkPackage);
router.put('/work-packages/:workPackageId', accessByPackage, requirePermission('construction', 'update'), updateWorkPackage);
router.post('/work-packages/:workPackageId/vendor-commitments', accessByPackage, requirePermission('construction', 'write'), linkWorkPackageCommitment);
router.post('/daily-updates', accessByBodyPackage, requirePermission('construction', 'write'), createDailyUpdate);
router.post('/projects/:id/schedule-revisions', accessByProject, requirePermission('construction', 'update'), reviseSchedule);
router.post('/projects/:id/cost-forecasts', accessByProject, requirePermission('construction', 'write'), createCostForecast);
router.post('/risks', accessByBodyProject, requirePermission('construction', 'write'), createRisk);

// Certification remains separate from operational progress and uses evidence RBAC.
router.get('/certifications', evidenceAccessByQuerySite, requirePermission('rera_evidence', 'read'), listCertifications);
router.post('/certifications', evidenceAccessByBodyProject, requirePermission('rera_evidence', 'write'), createCertification);
router.post('/certifications/:certificationId/transition', accessByCertification, requirePermission('rera_evidence', 'update'), transitionCertification);

// Ruleset-driven filing preparation; no government portal submission is automated.
router.get('/filing-periods', reraAccessByQuerySite, requirePermission('rera_projects', 'read'), listFilingPeriods);
router.post('/filing-periods', reraAccessByBodyProject, requirePermission('rera_projects', 'write'), createFilingPeriod);
router.post('/filing-periods/:filingId/reconcile', accessByFiling, requirePermission('rera_projects', 'update'), runFilingReconciliation);
router.put('/filing-periods/:filingId/requirements/:requirementId', accessByFiling, requirePermission('rera_projects', 'update'), updateFilingRequirement);
router.post('/filing-periods/:filingId/snapshots', accessByFiling, requirePermission('rera_projects', 'write'), createFilingSnapshot);
router.post('/filing-periods/:filingId/submissions', accessByFiling, requirePermission('rera_projects', 'write'), recordFilingSubmission);
router.post('/filing-periods/:filingId/transition', accessByFiling, requirePermission('rera_projects', 'update'), transitionFilingPeriod);

router.get('/project-controls', reraAccessByQuerySite, requirePermission('rera_projects', 'read'), listProjectControls);
router.post('/project-controls/:controlType', reraAccessByBodyProject, requirePermission('rera_projects', 'write'), createProjectControl);
router.post('/project-controls/change/:controlId/transition', accessByChange, requirePermission('rera_projects', 'update'), transitionProjectControl);
router.post('/project-controls/extension/:controlId/transition', accessByExtension, requirePermission('rera_projects', 'update'), transitionProjectControl);

// Projects
router.get('/projects', accessByQuerySite, requirePermission('construction', 'read'), listProjects);
router.post('/projects', accessByBodySite, requirePermission('construction', 'write'), createProject);
router.get('/projects/:id', accessByProject, requirePermission('construction', 'read'), getProject);
router.put('/projects/:id', accessByProject, requirePermission('construction', 'update'), updateProject);
router.delete('/projects/:id', accessByProject, requirePermission('construction', 'delete'), deleteProject);

// Tasks (nested create, flat update/delete)
router.post('/projects/:id/tasks', accessByProject, requirePermission('construction', 'write'), createTask);
router.put('/tasks/:taskId', accessByTask, requirePermission('construction', 'update'), updateTask);
router.delete('/tasks/:taskId', accessByTask, requirePermission('construction', 'delete'), deleteTask);

// Material requests + issue flow
router.post('/projects/:id/material-requests', accessByProject, requirePermission('construction', 'write'), createMaterialRequest);
router.get('/material-requests/:reqId', accessByRequest, requirePermission('construction', 'read'), getMaterialRequest);
router.put('/material-requests/:reqId', accessByRequest, requirePermission('construction', 'update'), updateMaterialRequest);
router.post('/material-requests/:reqId/issue', accessByRequest, requirePermission('construction', 'write'), issueMaterialRequest);

// Consumption (draws stock, feeds actual cost)
router.post('/projects/:id/consume', accessByProject, requirePermission('construction', 'write'), consumeMaterial);

export default router;
