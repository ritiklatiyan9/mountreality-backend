import express from 'express';
import {
    getUsers,
    getConversations,
    getOrCreateConversation,
    getMessages,
    sendMessage,
    deleteMessage
} from '../controllers/chat.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';

const router = express.Router();

// All chat routes require authentication
router.use(authMiddleware);

router.get('/users', requirePermission('chat', 'read'), getUsers);
router.get('/conversations', requirePermission('chat', 'read'), getConversations);
router.get('/conversations/:userId', requirePermission('chat', 'read'), getOrCreateConversation); // Start a chat
router.get('/messages/:conversationId', requirePermission('chat', 'read'), getMessages);
router.post('/messages', requirePermission('chat', 'write'), sendMessage);

// Admin only routes
// We check if requireAdmin or similar exists in role middleware
router.delete('/messages/:messageId', requireRole('admin'), requirePermission('chat', 'delete'), deleteMessage);

export default router;
