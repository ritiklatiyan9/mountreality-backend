import express from 'express';
const router = express.Router();

import {
  listProjects, createProject, getProject, updateProject, deleteProject,
  createTask, updateTask, deleteTask,
  createMaterialRequest, getMaterialRequest, issueMaterialRequest, updateMaterialRequest,
  consumeMaterial, constructionSummary,
} from '../controllers/construction.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import requireConstructionSiteAccess from '../middlewares/constructionSiteAccess.middleware.js';

const accessByQuerySite = requireConstructionSiteAccess({ entity: 'site', source: 'query', key: 'site_id' });
const accessByBodySite = requireConstructionSiteAccess({ entity: 'site', source: 'body', key: 'site_id' });
const accessByProject = requireConstructionSiteAccess({ entity: 'project', source: 'params', key: 'id' });
const accessByTask = requireConstructionSiteAccess({ entity: 'task', source: 'params', key: 'taskId' });
const accessByRequest = requireConstructionSiteAccess({ entity: 'request', source: 'params', key: 'reqId' });

router.use(authMiddleware);

// Dashboard summary
router.get('/summary', accessByQuerySite, requirePermission('construction', 'read'), constructionSummary);

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
