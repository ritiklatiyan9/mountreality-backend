import MasterModel from './MasterModel.js';

class MessageModel extends MasterModel {
    constructor() {
        super('messages');
    }

    /**
     * Get all messages for a specific conversation
     */
    async getMessagesByConversationId(conversationId, pool) {
        const query = `
      SELECT m.*, u.name as sender_name, u.photo as sender_photo
      FROM ${this.tableName} m
      JOIN users u ON m.sender_id = u.id
      WHERE m.conversation_id = $1
      ORDER BY m.created_at ASC
    `;
        const result = await pool.query(query, [conversationId]);
        return result.rows;
    }

    /**
     * Create a new message
     */
    async createMessage(conversationId, senderId, text, attachmentUrl, pool) {
        const query = `
      INSERT INTO ${this.tableName} (conversation_id, sender_id, message_text, attachment_url)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;
        const result = await pool.query(query, [
            conversationId,
            senderId,
            text || null,
            attachmentUrl || null
        ]);
        return result.rows[0];
    }

    /**
     * Mark all unread messages in a conversation as read for a specific user
     * (The user marking them read is the receiver, so we update where sender != userId)
     */
    async markAsRead(conversationId, userId, pool) {
        const query = `
      UPDATE ${this.tableName}
      SET is_read = TRUE
      WHERE conversation_id = $1 AND sender_id != $2 AND is_read = FALSE
      RETURNING *
    `;
        const result = await pool.query(query, [conversationId, userId]);
        return result.rowCount; // return number of updated rows
    }

    /**
     * Delete a message (For Admin feature)
     */
    async deleteMessage(messageId, pool) {
        const query = `DELETE FROM ${this.tableName} WHERE id = $1 RETURNING *`;
        const result = await pool.query(query, [messageId]);
        return result.rows[0];
    }

}

export default new MessageModel();
