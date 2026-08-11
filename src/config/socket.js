import { Server } from 'socket.io';
import { verifyToken } from './jwt.js';
import { socketCorsOptions } from './cors.js';
import pool from './db.js';

let io;
// Map to keep track of user socket connections
// userId -> socketId
const userSocketMap = new Map();

export const initSocket = (server) => {
    // Same allowlist the HTTP app uses — see config/cors.js.
    io = new Server(server, { cors: socketCorsOptions });

    // Middleware for Socket authentication
    io.use(async (socket, next) => {
        const token = socket.handshake.auth.token;
        if (!token) {
            return next(new Error('Authentication error'));
        }
        try {
            const decoded = verifyToken(token);
            if (!Number.isInteger(Number(decoded.sid))) throw new Error('Session missing');
            const { rows } = await pool.query(
                `SELECT u.id,u.role,u.organization_id,u.token_version
                   FROM users u
                   JOIN organizations o ON o.id=u.organization_id AND o.is_active=TRUE
                   JOIN user_sessions us ON us.id=$2 AND us.user_id=u.id
                        AND us.logout_time IS NULL
                  WHERE u.id=$1 AND u.is_active=TRUE
                    AND u.role <> 'portal_user'
                    AND EXISTS (
                      SELECT 1 FROM subscriptions s
                       WHERE s.organization_id=u.organization_id AND s.status='active'
                         AND s.current_period_end>NOW()
                    )
                  LIMIT 1`,
                [decoded.id, decoded.sid]
            );
            const user = rows[0];
            if (!user || user.token_version !== decoded.version) throw new Error('Session invalid');
            socket.user = user;
            next();
        } catch (err) {
            next(new Error('Authentication error'));
        }
    });

    io.on('connection', (socket) => {
        const userId = socket.user.id;
        const organizationId = socket.user.organization_id;
        const organizationRoom = `organization_${organizationId}`;
        const joinedConversations = new Set();
        console.log(`User connected: ${userId} (${socket.id})`);

        // Store user socket mapping
        const sockets = userSocketMap.get(userId) || new Set();
        sockets.add(socket.id);
        userSocketMap.set(userId, sockets);
        socket.join(organizationRoom);

        // Broadcast online status to others
        io.to(organizationRoom).emit('user_online', { userId });

        // Join a specific conversation room
        socket.on('join_conversation', async (conversationId, acknowledge = () => {}) => {
            try {
                const parsedId = Number.parseInt(conversationId, 10);
                if (!Number.isInteger(parsedId) || parsedId <= 0) throw new Error('Invalid conversation');
                const access = await pool.query(
                    `SELECT c.id FROM conversations c
                       JOIN users u1 ON u1.id=c.user1_id
                       JOIN users u2 ON u2.id=c.user2_id
                      WHERE c.id=$1 AND (c.user1_id=$2 OR c.user2_id=$2)
                        AND u1.organization_id=$3 AND u2.organization_id=$3 LIMIT 1`,
                    [parsedId, userId, organizationId]
                );
                if (!access.rows[0]) throw new Error('Conversation not found');
                joinedConversations.add(parsedId);
                socket.join(`conversation_${parsedId}`);
                acknowledge({ ok: true });
            } catch {
                acknowledge({ ok: false, message: 'Conversation not found' });
            }
        });

        socket.on('leave_conversation', (conversationId) => {
            const parsedId = Number.parseInt(conversationId, 10);
            joinedConversations.delete(parsedId);
            socket.leave(`conversation_${parsedId}`);
        });

        // Handle typing events
        socket.on('typing', ({ conversationId, isTyping }) => {
            const parsedId = Number.parseInt(conversationId, 10);
            if (!joinedConversations.has(parsedId)) return;
            socket.to(`conversation_${parsedId}`).emit('typing', {
                userId,
                conversationId: parsedId,
                isTyping
            });
        });

        // Explicit disconnect
        socket.on('disconnect', () => {
            console.log(`User disconnected: ${userId}`);
            const activeSockets = userSocketMap.get(userId);
            activeSockets?.delete(socket.id);
            if (!activeSockets?.size) {
                userSocketMap.delete(userId);
                io.to(organizationRoom).emit('user_offline', { userId });
            }
        });
    });

    return io;
};

export const getIo = () => {
    if (!io) {
        throw new Error('Socket.io is not initialized!');
    }
    return io;
};

/**
 * Emit a new message to a specific conversation
 */
export const emitNewMessage = (conversationId, message) => {
    if (io) {
        io.to(`conversation_${conversationId}`).emit('new_message', message);
    }
};
