import express from 'express';
const router = express.Router();

import {
  register, signup, login, googleLogin, googleStatus,
  refresh, logout, updateProfile, getMe, changePassword,
} from '../controllers/auth.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import upload from '../middlewares/multer.middleware.js';

router.post('/register', upload.single('photo'), register);  // First admin only (Postman)
router.post('/signup', signup);                              // SaaS: new company + super_admin
router.post('/login', login);
router.post('/google', googleLogin);          // Sign in with Google (Firebase ID token)
router.get('/google/status', googleStatus);   // Non-secret diagnostics: is Google Sign-In configured?
router.post('/refresh', refresh);
router.post('/logout', authMiddleware, logout);
router.get('/me', authMiddleware, getMe);
router.put('/profile', authMiddleware, upload.single('photo'), updateProfile);
router.put('/change-password', authMiddleware, changePassword);

export default router;
