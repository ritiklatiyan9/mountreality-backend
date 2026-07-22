import pool from '../config/db.js';

const migrateUserSessions = async () => {
    try {
        // Note: The CASCADE delete ensures if an admin is deleted, their sessions are removed too.
        const query = `
      CREATE TABLE IF NOT EXISTS user_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        login_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        logout_time TIMESTAMP WITH TIME ZONE,
        ip_address VARCHAR(45)
      );

      CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_sessions_login_time ON user_sessions(login_time);
    `;
        await pool.query(query);
        console.log('✓ Migration applied: user_sessions table created');
    } catch (error) {
        console.error('Error in user_sessions migration:', error);
        throw error;
    }
};

export default migrateUserSessions;
