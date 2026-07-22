import { Server } from 'socket.io';
import { verifyToken } from './jwt.js';

let io;
// Map to keep track of user socket connections
// userId -> socketId
const userSocketMap = new Map();

export const initSocket = (server) => {
    io = new Server(server, {
        cors: {
            origin: '*', // Be careful in production, you might want to restrict this
            methods: ['GET', 'POST']
        }
    });

    // Middleware for Socket authentication
    io.use((socket, next) => {
        const token = socket.handshake.auth.token;
        if (!token) {
            return next(new Error('Authentication error'));
        }
        try {
            const decoded = verifyToken(token);
            socket.user = decoded;
            next();
        } catch (err) {
            next(new Error('Authentication error'));
        }
    });

    io.on('connection', (socket) => {
        const userId = socket.user.id;
        console.log(`User connected: ${userId} (${socket.id})`);

        // Store user socket mapping
        userSocketMap.set(userId, socket.id);

        // Broadcast online status to others
        io.emit('user_online', { userId });

        // Join a specific conversation room
        socket.on('join_conversation', (conversationId) => {
            socket.join(`conversation_${conversationId}`);
            console.log(`User ${userId} joined conversation_${conversationId}`);
        });

        socket.on('leave_conversation', (conversationId) => {
            socket.leave(`conversation_${conversationId}`);
            console.log(`User ${userId} left conversation_${conversationId}`);
        });

        // Handle typing events
        socket.on('typing', ({ conversationId, isTyping }) => {
            socket.to(`conversation_${conversationId}`).emit('typing', {
                userId,
                conversationId,
                isTyping
            });
        });

        // Explicit disconnect
        socket.on('disconnect', () => {
            console.log(`User disconnected: ${userId}`);
            userSocketMap.delete(userId);
            io.emit('user_offline', { userId });
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
