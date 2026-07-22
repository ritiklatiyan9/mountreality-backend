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

router.use(authMiddleware);

// Dashboard summary
router.get('/summary', requirePermission('construction', 'read'), constructionSummary);

// Projects
router.get('/projects', requirePermission('construction', 'read'), listProjects);
router.post('/projects', requirePermission('construction', 'write'), createProject);
router.get('/projects/:id', requirePermission('construction', 'read'), getProject);
router.put('/projects/:id', requirePermission('construction', 'update'), updateProject);
router.delete('/projects/:id', requirePermission('construction', 'delete'), deleteProject);

// Tasks (nested create, flat update/delete)
router.post('/projects/:id/tasks', requirePermission('construction', 'write'), createTask);
router.put('/tasks/:taskId', requirePermission('construction', 'update'), updateTask);
router.delete('/tasks/:taskId', requirePermission('construction', 'delete'), deleteTask);

// Material requests + issue flow
router.post('/projects/:id/material-requests', requirePermission('construction', 'write'), createMaterialRequest);
router.get('/material-requests/:reqId', requirePermission('construction', 'read'), getMaterialRequest);
router.put('/material-requests/:reqId', requirePermission('construction', 'update'), updateMaterialRequest);
router.post('/material-requests/:reqId/issue', requirePermission('construction', 'write'), issueMaterialRequest);

// Consumption (draws stock, feeds actual cost)
router.post('/projects/:id/consume', requirePermission('construction', 'write'), consumeMaterial);

export default router;
