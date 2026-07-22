import pool from '../config/db.js';

const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Add commitment_id column to link inventory orders to vendor commitments
    const { rows } = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'vendor_inventory_orders' AND column_name = 'commitment_id'
    `);

    if (rows.length === 0) {
      await client.query(`
        ALTER TABLE vendor_inventory_orders
        ADD COLUMN commitment_id INTEGER REFERENCES vendor_commitments(id) ON DELETE SET NULL
      `);
      console.log('Added commitment_id to vendor_inventory_orders');

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_vio_commitment_id ON vendor_inventory_orders(commitment_id)
      `);
      console.log('Created index idx_vio_commitment_id');
    } else {
      console.log('commitment_id column already exists');
    }

    await client.query('COMMIT');
    console.log('Migration 044_vendor_inventory_commitment_link completed');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
