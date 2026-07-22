import 'dotenv/config';
import pool from './src/config/db.js';

const BANK_FROMS = ['BANK', 'TRANSFER', 'CHEQUE', 'UPI', 'NEFT', 'RTGS'];

try {
  // Show current state
  const before = await pool.query('SELECT id, payment_from, payment_type, amount FROM plot_payments ORDER BY id');
  console.log('Before fix:');
  before.rows.forEach(r => console.log(`  id=${r.id} from=${r.payment_from} type=${r.payment_type} amt=${r.amount}`));

  // Fix: set payment_type = 'BANK' where payment_from is a bank mode
  const result = await pool.query(
    `UPDATE plot_payments SET payment_type = 'BANK' WHERE UPPER(payment_from) = ANY($1) AND payment_type = 'CASH' RETURNING id, payment_from, payment_type`,
    [BANK_FROMS]
  );
  console.log('\nUpdated ' + result.rowCount + ' payments to BANK type:');
  result.rows.forEach(r => console.log(`  id=${r.id} from=${r.payment_from} -> type=${r.payment_type}`));

  // Show after
  const after = await pool.query('SELECT id, payment_from, payment_type, amount FROM plot_payments ORDER BY id');
  console.log('\nAfter fix:');
  after.rows.forEach(r => console.log(`  id=${r.id} from=${r.payment_from} type=${r.payment_type} amt=${r.amount}`));

  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
