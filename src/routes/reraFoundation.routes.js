import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import {
  createReraApproval,
  createReraProject,
  createReraProjectParticipant,
  createReraProjectPhase,
  createReraStakeholder,
  deleteReraProjectParticipant,
  deriveReraSiteContext,
  getReraControlCentre,
  listReraRulesets,
  updateReraApproval,
  updateReraProject,
  updateReraProjectPhase,
  updateReraStakeholder,
} from '../controllers/reraFoundation.controller.js';

const router = express.Router();

const requireSelectedSite = (req, res, next) => {
  if (!req.siteContextId) {
    return res.status(400).json({
      code: 'SITE_CONTEXT_REQUIRED',
      message: 'Select a Site before using the RERA workspace',
    });
  }
  return next();
};

router.use(authMiddleware, requireRole('admin', 'sub_admin'));

router.get(
  '/control-centre',
  requireSelectedSite,
  requirePermission('rera_projects', 'read'),
  getReraControlCentre,
);
router.get(
  '/rulesets',
  requireSelectedSite,
  requirePermission('rera_rulesets', 'read'),
  listReraRulesets,
);

router.post(
  '/projects',
  requireSelectedSite,
  requirePermission('rera_projects', 'write'),
  createReraProject,
);
router.patch(
  '/projects/:projectId',
  deriveReraSiteContext('project'),
  requirePermission('rera_projects', 'update'),
  updateReraProject,
);
router.post(
  '/projects/:projectId/phases',
  deriveReraSiteContext('project'),
  requirePermission('rera_projects', 'write'),
  createReraProjectPhase,
);
router.patch(
  '/phases/:phaseId',
  deriveReraSiteContext('phase'),
  requirePermission('rera_projects', 'update'),
  updateReraProjectPhase,
);

router.post(
  '/stakeholders',
  requireSelectedSite,
  requirePermission('rera_projects', 'write'),
  createReraStakeholder,
);
router.patch(
  '/stakeholders/:stakeholderId',
  requireSelectedSite,
  requirePermission('rera_projects', 'update'),
  updateReraStakeholder,
);
router.post(
  '/projects/:projectId/participants',
  deriveReraSiteContext('project'),
  requirePermission('rera_projects', 'write'),
  createReraProjectParticipant,
);
router.delete(
  '/participants/:participantId',
  deriveReraSiteContext('participant'),
  requirePermission('rera_projects', 'delete'),
  deleteReraProjectParticipant,
);

router.post(
  '/approvals',
  deriveReraSiteContext('bodyProject'),
  requirePermission('rera_approvals', 'write'),
  createReraApproval,
);
router.patch(
  '/approvals/:approvalId',
  deriveReraSiteContext('approval'),
  requirePermission('rera_approvals', 'update'),
  updateReraApproval,
);

export default router;
