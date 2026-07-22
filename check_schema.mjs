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
    // Check plot_payments columns
    const { rows: pp } = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'plot_payments'
      ORDER BY ordinal_position
    `);
    console.log('\nplot_payments columns:');
    pp.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

    // Check plot_installment_payments columns
    const { rows: ip } = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'plot_installment_payments'
      ORDER BY ordinal_position
    `);
    console.log('\nplot_installment_payments columns:');
    ip.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

    // Check plots columns
    const { rows: pl } = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'plots'
      ORDER BY ordinal_position
    `);
    console.log('\nplots columns:');
    pl.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

    // Sample plot_payments data
    const { rows: ppSample } = await client.query(`
      SELECT * FROM plot_payments LIMIT 3
    `);
    console.log('\nplot_payments sample:');
    ppSample.forEach(r => console.log(JSON.stringify(r)));

    // Sample plot_installment_payments data
    const { rows: ipSample } = await client.query(`
      SELECT * FROM plot_installment_payments LIMIT 3
    `);
    console.log('\nplot_installment_payments sample:');
    ipSample.forEach(r => console.log(JSON.stringify(r)));

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
