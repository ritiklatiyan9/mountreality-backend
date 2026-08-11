import MasterModel from './MasterModel.js';

class ConversationModel extends MasterModel {
    constructor() {
        super('conversations');
    }

    /**
     * Find or create a conversation between two users
     */
    async findOrCreateConversation(user1Id, user2Id, organizationId, pool) {
        // Ensure smaller ID is always user1 to prevent duplicates like (1,2) and (2,1)
        const u1 = Math.min(user1Id, user2Id);
        const u2 = Math.max(user1Id, user2Id);

        try {
            // Check if exists
            const checkQuery = `
              SELECT c.*
                FROM ${this.tableName} c
                JOIN users u1 ON u1.id = c.user1_id
                JOIN users u2 ON u2.id = c.user2_id
               WHERE c.user1_id = $1 AND c.user2_id = $2
                 AND u1.organization_id = $3 AND u2.organization_id = $3
            `;
            const checkResult = await pool.query(checkQuery, [u1, u2, organizationId]);

            if (checkResult.rows.length > 0) {
                return checkResult.rows[0];
            }

            // Create new
            const createQuery = `
        INSERT INTO ${this.tableName} (user1_id, user2_id)
        VALUES ($1, $2)
        RETURNING *
      `;
            const createResult = await pool.query(createQuery, [u1, u2]);
            return createResult.rows[0];
        } catch (err) {
            throw err;
        }
    }

    /**
     * Get all conversations for a specific user
     * Joins with users table to get the OTHER user's details
     */
    async getUserConversations(userId, organizationId, pool) {
        const query = `
      SELECT 
        c.id as conversation_id,
        c.created_at as conversation_created_at,
        u.id as user_id,
        u.name as user_name,
        u.photo as user_photo,
        -- Get latest message for preview
        (SELECT message_text FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_time,
        -- Get unread count for this user
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id != $1 AND m.is_read = FALSE) as unread_count
      FROM ${this.tableName} c
      JOIN users u ON (u.id = CASE WHEN c.user1_id = $1 THEN c.user2_id ELSE c.user1_id END)
      WHERE (c.user1_id = $1 OR c.user2_id = $1)
        AND u.organization_id = $2
      ORDER BY COALESCE((SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1), c.created_at) DESC
    `;
        const result = await pool.query(query, [userId, organizationId]);
        return result.rows;
    }
}

export default new ConversationModel();
