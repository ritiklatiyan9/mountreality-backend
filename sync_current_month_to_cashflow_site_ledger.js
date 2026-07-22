import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const sslOption = process.env.DB_SSL === 'true' || (process.env.DB_HOST && process.env.DB_HOST.includes('neon'))
  ? { rejectUnauthorized: false }
  : false;

const pool = new pg.Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD != null ? String(process.env.DB_PASSWORD) : '',
  ssl: sslOption,
});

const toCashType = (mode) => {
  const m = String(mode || '').toUpperCase();
  return m.includes('BANK') ? 'bank' : 'cash';
};

async function ensureMonth(client, siteId, date, createdBy) {
  const result = await client.query(
    `SELECT ensure_site_cashflow_month($1, $2::date, $3) AS id`,
    [siteId, date, createdBy || null]
  );
  return result.rows[0]?.id;
}

async function insertCFEntry(client, row) {
  const monthId = await ensureMonth(client, row.site_id, row.date, row.created_by);

  await client.query(
    `INSERT INTO cash_flow_entries (
      cash_flow_month_id, site_id, date, particular, debit, credit, cash_type, remarks, created_by, source_module, source_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (source_module, source_id) DO NOTHING`,
    [
      monthId,
      row.site_id,
      row.date,
      row.particular,
      row.debit || 0,
      row.credit || 0,
      row.cash_type || 'cash',
      row.remarks || null,
      row.created_by || null,
      row.source_module,
      row.source_id,
    ]
  );
}

async function backfillCurrentMonth() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const d = new Date();
    const month = d.getMonth() + 1;
    const year = d.getFullYear();

    console.log(`Backfilling current month ${month}/${year} into site cashflow ledgers...`);

    const farmers = await client.query(
      `SELECT fp.id AS source_id, f.site_id, fp.date,
              ('FARMER PAYMENT - ' || COALESCE(f.name, 'FARMER'))::varchar(500) AS particular,
              COALESCE(fp.amount,0) AS debit,
              0::numeric AS credit,
              CASE WHEN UPPER(COALESCE(fp.payment_mode,'CASH')) = 'BANK' THEN 'bank' ELSE 'cash' END AS cash_type,
              fp.remarks,
              NULL::integer AS created_by
       FROM farmer_payments fp
       JOIN farmers f ON f.id = fp.farmer_id
       WHERE EXTRACT(MONTH FROM fp.date) = $1 AND EXTRACT(YEAR FROM fp.date) = $2`,
      [month, year]
    );

    for (const r of farmers.rows) {
      await insertCFEntry(client, { ...r, source_module: 'farmer_payments' });
    }

    const commissions = await client.query(
      `SELECT pc.id AS source_id, pc.site_id, pc.date,
              ('PLOT COMMISSION - ' || COALESCE(pc.particular, 'COMMISSION'))::varchar(500) AS particular,
              COALESCE(pc.amount,0) AS debit,
              0::numeric AS credit,
              CASE WHEN UPPER(COALESCE(pc.by_note,'CASH')) LIKE '%BANK%' THEN 'bank' ELSE 'cash' END AS cash_type,
              pc.remarks,
              pc.created_by
       FROM plot_commissions pc
       WHERE EXTRACT(MONTH FROM pc.date) = $1 AND EXTRACT(YEAR FROM pc.date) = $2`,
      [month, year]
    );

    for (const r of commissions.rows) {
      await insertCFEntry(client, { ...r, source_module: 'plot_commissions' });
    }

    const daybook = await client.query(
      `SELECT db.id AS source_id, db.site_id, db.date,
              COALESCE(db.particular, 'DAY BOOK ENTRY')::varchar(500) AS particular,
              COALESCE(db.debit,0) AS debit,
              COALESCE(db.credit,0) AS credit,
              CASE WHEN UPPER(COALESCE(db.payment_mode,'CASH')) LIKE '%BANK%' THEN 'bank' ELSE 'cash' END AS cash_type,
              db.remarks,
              db.created_by
       FROM day_book db
       WHERE EXTRACT(MONTH FROM db.date) = $1
         AND EXTRACT(YEAR FROM db.date) = $2
         AND UPPER(COALESCE(db.entry_type, 'GENERAL')) NOT IN ('CASH FLOW','FARMER PAYMENT','PLOT COMMISSION','FIRM TRANSACTION','PLOT PAYMENT')`,
      [month, year]
    );

    for (const r of daybook.rows) {
      if ((parseFloat(r.debit) || 0) === 0 && (parseFloat(r.credit) || 0) === 0) continue;
      await insertCFEntry(client, { ...r, source_module: 'day_book' });
    }

    const firms = await client.query(
      `SELECT ft.id AS source_id, ft.site_id, ft.date,
              COALESCE(ft.description, 'FIRM TRANSACTION')::varchar(500) AS particular,
              COALESCE(ft.debit,0) AS debit,
              COALESCE(ft.credit,0) AS credit,
              CASE WHEN LOWER(COALESCE(ft.payment_mode,'cash')) = 'bank' THEN 'bank' ELSE 'cash' END AS cash_type,
              ft.remark AS remarks,
              ft.created_by
       FROM firm_transactions ft
       WHERE EXTRACT(MONTH FROM ft.date) = $1 AND EXTRACT(YEAR FROM ft.date) = $2`,
      [month, year]
    );

    for (const r of firms.rows) {
      if ((parseFloat(r.debit) || 0) === 0 && (parseFloat(r.credit) || 0) === 0) continue;
      await insertCFEntry(client, { ...r, source_module: 'firm_transactions' });
    }

    const plotPayments = await client.query(
      `SELECT pp.id AS source_id, pp.site_id, pp.date,
              ('PLOT PAYMENT - ' || COALESCE(pp.payment_from, 'PLOT'))::varchar(500) AS particular,
              0::numeric AS debit,
              COALESCE(pp.amount,0) AS credit,
              CASE WHEN UPPER(COALESCE(pp.payment_type,'CASH')) = 'BANK' THEN 'bank' ELSE 'cash' END AS cash_type,
              pp.narration AS remarks,
              pp.created_by
       FROM plot_payments pp
       WHERE EXTRACT(MONTH FROM pp.date) = $1 AND EXTRACT(YEAR FROM pp.date) = $2`,
      [month, year]
    );

    for (const r of plotPayments.rows) {
      await insertCFEntry(client, { ...r, source_module: 'plot_payments' });
    }

    const expenses = await client.query(
      `SELECT e.id AS source_id, e.site_id, e.date,
              COALESCE(e.remark, 'EXPENSE ENTRY')::varchar(500) AS particular,
              COALESCE(e.debit,0) AS debit,
              COALESCE(e.credit,0) AS credit,
              CASE WHEN UPPER(COALESCE(e.payment_mode,'CASH')) LIKE '%BANK%' THEN 'bank' ELSE 'cash' END AS cash_type,
              CONCAT_WS(' | ', e.from_entity, e.to_entity, e.category) AS remarks,
              e.created_by
       FROM expenses e
       WHERE EXTRACT(MONTH FROM e.date) = $1 AND EXTRACT(YEAR FROM e.date) = $2`,
      [month, year]
    );

    for (const r of expenses.rows) {
      if ((parseFloat(r.debit) || 0) === 0 && (parseFloat(r.credit) || 0) === 0) continue;
      await insertCFEntry(client, { ...r, source_module: 'expenses' });
    }

    await client.query('COMMIT');
    console.log('✅ Current month backfill completed.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Backfill failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

backfillCurrentMonth().catch(() => process.exit(1));
