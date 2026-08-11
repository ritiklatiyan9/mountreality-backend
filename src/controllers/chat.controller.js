import pool from '../config/db.js';
import User from '../models/User.model.js';
import Conversation from '../models/Conversation.model.js';
import Message from '../models/Message.model.js';
import { emitNewMessage } from '../config/socket.js';

const canAccessConversation = async (conversationId, userId, organizationId) => {
    const result = await pool.query(
        `SELECT c.id
           FROM conversations c
           JOIN users u1 ON u1.id = c.user1_id
           JOIN users u2 ON u2.id = c.user2_id
          WHERE c.id = $1 AND (c.user1_id = $2 OR c.user2_id = $2)
            AND u1.organization_id = $3 AND u2.organization_id = $3
          LIMIT 1`,
        [conversationId, userId, organizationId]
    );
    return result.rowCount > 0;
};

export const getUsers = async (req, res) => {
    try {
        const currentUserId = req.user.id;
        // Chat is an organization-local collaboration surface. Never reveal
        // global identities, even to an administrator.
        const query = `
      SELECT id, name, email, role, photo 
      FROM users 
      WHERE id != $1 AND organization_id = $2 AND is_active = true
      ORDER BY name ASC
    `;
        const result = await pool.query(query, [currentUserId, req.user.organization_id]);

        res.status(200).json({ users: result.rows });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

export const getConversations = async (req, res) => {
    try {
        const currentUserId = req.user.id;
        const conversations = await Conversation.getUserConversations(currentUserId, req.user.organization_id, pool);

        res.status(200).json({ conversations });
    } catch (error) {
        console.error('Error fetching conversations:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

export const getOrCreateConversation = async (req, res) => {
    try {
        const currentUserId = req.user.id;
        const { userId } = req.params; // other user's ID

        if (parseInt(currentUserId) === parseInt(userId)) {
            return res.status(400).json({ message: 'Cannot create conversation with yourself' });
        }

        const userResult = await pool.query(
            'SELECT id FROM users WHERE id = $1 AND organization_id = $2 AND is_active = true LIMIT 1',
            [userId, req.user.organization_id]
        );
        if (userResult.rowCount === 0) {
            return res.status(404).json({ message: 'The selected user is not available for chat' });
        }

        const conversation = await Conversation.findOrCreateConversation(currentUserId, userId, req.user.organization_id, pool);
        res.status(200).json({ conversation });
    } catch (error) {
        console.error('Error finding/creating conversation:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

export const getMessages = async (req, res) => {
    try {
        const { conversationId } = req.params;

        if (!await canAccessConversation(conversationId, req.user.id, req.user.organization_id)) {
            return res.status(404).json({ message: 'Conversation not found' });
        }

        // Also mark them as read when fetching
        await Message.markAsRead(conversationId, req.user.id, pool);

        const messages = await Message.getMessagesByConversationId(conversationId, pool);
        res.status(200).json({ messages });
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

export const sendMessage = async (req, res) => {
    try {
        const senderId = req.user.id;
        const { conversationId, text, attachmentUrl } = req.body;
        const messageText = typeof text === 'string' ? text.trim() : '';

        if (!messageText && !attachmentUrl) {
            return res.status(400).json({ message: 'Message text or attachment is required' });
        }

        if (!await canAccessConversation(conversationId, senderId, req.user.organization_id)) {
            return res.status(404).json({ message: 'Conversation not found' });
        }

        const message = await Message.createMessage(conversationId, senderId, messageText, attachmentUrl, pool);

        // We fetch the message again just to get the sender details (name, photo)
        // so it matches the format of getMessages for realtime appending
        const messageWithDetailsQuery = `
      SELECT m.*, u.name as sender_name, u.photo as sender_photo
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.id = $1
    `;
        const detailsResult = await pool.query(messageWithDetailsQuery, [message.id]);
        const finalMessage = detailsResult.rows[0];

        // Emit via sockets
        emitNewMessage(conversationId, finalMessage);

        res.status(201).json({ message: finalMessage });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

export const deleteMessage = async (req, res) => {
    try {
        const { messageId } = req.params;

        // Only super-admins usually allowed, but let's check basic permissions or roles if needed
        // Assuming role middleware checks it or we can check req.user.role here
        if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
            return res.status(403).json({ message: 'Only admins can delete messages' });
        }

        const deleted = await pool.query(
            `DELETE FROM messages m
              USING conversations c, users u1, users u2
             WHERE m.id = $1 AND c.id = m.conversation_id
               AND u1.id = c.user1_id AND u2.id = c.user2_id
               AND u1.organization_id = $2 AND u2.organization_id = $2
             RETURNING m.id`,
            [messageId, req.user.organization_id]
        );
        if (!deleted.rows[0]) return res.status(404).json({ message: 'Message not found' });
        res.status(200).json({ message: 'Message deleted successfully' });
    } catch (error) {
        console.error('Error deleting message:', error);
        res.status(500).json({ message: 'Server error' });
    }
};
