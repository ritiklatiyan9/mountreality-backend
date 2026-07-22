import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString:
    'postgresql://neondb_owner:npg_r5zpVtZnxRu1@ep-dark-boat-aijjdnhi-pooler.c-4.us-east-1.aws.neon.tech/rgaccount?sslmode=require',
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const client = await pool.connect();
  try {
    // Check distinct payment_type values in plot_payments
    const { rows: ptypes } = await client.query(`
      SELECT DISTINCT payment_type, status, COUNT(*) as cnt
      FROM plot_payments
      GROUP BY payment_type, status
      ORDER BY payment_type, status
    `);
    console.log('\nplot_payments payment_type + status combinations:');
    ptypes.forEach(r => console.log(`  payment_type="${r.payment_type}" status="${r.status}" count=${r.cnt}`));

    // Check installment payments
    const { rows: ipcnt } = await client.query(`SELECT COUNT(*) as cnt FROM plot_installment_payments`);
    console.log('\nplot_installment_payments total rows:', ipcnt[0].cnt);

    // Check plot_installment_payments payment_mode values
    const { rows: ipmodes } = await client.query(`
      SELECT DISTINCT payment_mode, cheque_status, COUNT(*) as cnt
      FROM plot_installment_payments
      GROUP BY payment_mode, cheque_status
    `);
    console.log('plot_installment_payments payment_mode + cheque_status:');
    ipmodes.forEach(r => console.log(`  payment_mode="${r.payment_mode}" cheque_status="${r.cheque_status}" count=${r.cnt}`));

    // Check distinct plot_tag values for BALAJI
    const { rows: tags } = await client.query(`
      SELECT DISTINCT plot_tag, COUNT(*) as cnt
      FROM plots
      WHERE site_id IN (SELECT id FROM sites WHERE name = 'BALAJI ASSOCIATES')
      GROUP BY plot_tag
    `);
    console.log('\nplot_tag values in BALAJI ASSOCIATES plots:');
    tags.forEach(r => console.log(`  "${r.plot_tag}" count=${r.cnt}`));

    // Check how site filter works - check sites table
    const { rows: sites } = await client.query(`
      SELECT id, name FROM sites ORDER BY id
    `);
    console.log('\nAll sites:');
    sites.forEach(r => console.log(`  id=${r.id} name="${r.name}"`));

    // Check plots table for site column
    const { rows: plotCols } = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'plots' AND column_name IN ('site', 'site_id', 'site_name')
    `);
    console.log('\nplots site-related columns:', plotCols.map(r => r.column_name));

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
