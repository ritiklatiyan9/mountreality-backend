import express from 'express';
const router = express.Router();

import {
  register, signup, login, googleLogin, googleStatus,
  refresh, logout, updateProfile, getMe, changePassword, markDomainIntroSeen,
} from '../controllers/auth.controller.js';
import { acceptPortalInvitation } from '../controllers/portalInvitation.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import upload from '../middlewares/multer.middleware.js';
import createRateLimiter from '../middlewares/rateLimit.middleware.js';

const publicAuthLimiter = createRateLimiter({
  windowMs: 15 * 60_000,
  max: 20,
  keyPrefix: 'public-auth:',
  requireUser: false,
  keyGenerator: (req) => `${req.ip || 'unknown'}:${String(req.body?.email || '').trim().toLowerCase().slice(0, 320)}`,
});
const loginIpLimiter = createRateLimiter({
  windowMs: 15 * 60_000,
  max: 60,
  keyPrefix: 'login-ip:',
  requireUser: false,
  keyGenerator: (req) => req.ip || 'unknown',
});
const inviteAcceptanceLimiter = createRateLimiter({
  windowMs: 15 * 60_000,
  max: 12,
  keyPrefix: 'portal-accept:',
  requireUser: false,
  keyGenerator: (req) => req.ip || 'unknown',
});

router.post('/register', publicAuthLimiter, upload.single('photo'), register);  // First admin only (Postman)
router.post('/signup', publicAuthLimiter, signup);                              // SaaS: new company + super_admin
router.post('/login', loginIpLimiter, publicAuthLimiter, login);
router.post('/google', publicAuthLimiter, googleLogin);          // Sign in with Google (Firebase ID token)
router.get('/google/status', googleStatus);   // Non-secret diagnostics: is Google Sign-In configured?
router.post('/portal-invitations/accept', inviteAcceptanceLimiter, acceptPortalInvitation);
router.post('/refresh', publicAuthLimiter, refresh);
router.post('/logout', authMiddleware, logout);
router.get('/me', authMiddleware, getMe);
router.post('/domain-intro-seen', authMiddleware, markDomainIntroSeen);
router.put('/profile', authMiddleware, upload.single('photo'), updateProfile);
router.put('/change-password', authMiddleware, changePassword);

export default router;
