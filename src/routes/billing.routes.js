import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import { listPlans, getSubscription, createOrder, verifyPayment } from '../controllers/billing.controller.js';

const router = express.Router();

router.get('/plans', listPlans); // public — pricing shown on the signup page

router.get('/subscription', authMiddleware, getSubscription);
router.post('/order', authMiddleware, requireRole('admin'), createOrder);
router.post('/verify', authMiddleware, requireRole('admin'), verifyPayment);

export default router;
