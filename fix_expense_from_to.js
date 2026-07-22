import 'dotenv/config';
import pool from './src/config/db.js';

async function fixFromTo() {
  try {
    // Fix farmer payment entries: move farmer name from from_entity to to_entity
    const r1 = await pool.query(`
      UPDATE day_book
      SET to_entity = from_entity, from_entity = NULL
      WHERE entry_type = 'FARMER PAYMENT'
        AND from_entity IS NOT NULL
        AND (to_entity IS NULL OR to_entity = '')
      RETURNING id, to_entity
    `);
    console.log('Fixed', r1.rowCount, 'farmer payment DayBook entries');

    // Fix farmer payment entries where bank entries had bank_name as to_entity and farmer as from_entity
    const r2 = await pool.query(`
      UPDATE day_book
      SET to_entity = from_entity, from_entity = to_entity
      WHERE entry_type = 'FARMER PAYMENT'
        AND from_entity IS NOT NULL
        AND to_entity IS NOT NULL
        AND particular LIKE '%FARMER PAYMENT (BANK)%'
      RETURNING id, from_entity, to_entity
    `);
    console.log('Fixed', r2.rowCount, 'farmer payment BANK DayBook entries');

    console.log('Done!');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

fixFromTo();
