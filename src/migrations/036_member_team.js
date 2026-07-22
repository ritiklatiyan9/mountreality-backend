import pool from '../config/db.js';

const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Add team column to members table
    const { rows } = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'members' AND column_name = 'team'
      ) AS has_col
    `);

    if (!rows[0].has_col) {
      await client.query(`ALTER TABLE members ADD COLUMN team VARCHAR(50)`);
      console.log('Added team column to members table');
    } else {
      console.log('team column already exists on members table');
    }

    await client.query('COMMIT');
    console.log('Migration 036_member_team complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 036_member_team failed:', err);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
