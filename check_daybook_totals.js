import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const pool = new pg.Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, ssl: process.env.DB_HOST?.includes('neon') ? { rejectUnauthorized: false } : false });
const fmt = (n) => new Intl.NumberFormat('en-IN').format(n);

const db = await pool.query(`SELECT COALESCE(SUM(credit),0) as cr, COALESCE(SUM(debit),0) as dr FROM day_book WHERE site_id=2 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))`);
console.log('Day Book table: Credit=' + fmt(parseFloat(db.rows[0].cr)) + ' Debit=' + fmt(parseFloat(db.rows[0].dr)));

const cfe = await pool.query(`SELECT COALESCE(SUM(cfe.credit),0) as cr, COALESCE(SUM(cfe.debit),0) as dr FROM cash_flow_entries cfe JOIN cash_flow_months cfm ON cfm.id=cfe.cash_flow_month_id WHERE cfe.site_id=2 AND cfm.ledger_type='site' AND cfe.source_module='day_book' AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))`);
console.log('CFE day_book site: Credit=' + fmt(parseFloat(cfe.rows[0].cr)) + ' Debit=' + fmt(parseFloat(cfe.rows[0].dr)));

const ft = await pool.query(`SELECT COALESCE(SUM(ft.debit),0) as dr, COALESCE(SUM(ft.credit),0) as cr FROM firm_transactions ft JOIN firms f ON f.id=ft.firm_id WHERE f.site_id=2 AND (ft.cheque_status IS NULL OR ft.cheque_status NOT IN ('BOUNCED','RETURNED'))`);
console.log('Firm txn table: Debit=' + fmt(parseFloat(ft.rows[0].dr)) + ' Credit=' + fmt(parseFloat(ft.rows[0].cr)));

const cfeF = await pool.query(`SELECT COALESCE(SUM(COALESCE(cfe.debit,0)+COALESCE(cfe.credit,0)),0) as amt, COUNT(*) as cnt FROM cash_flow_entries cfe WHERE cfe.site_id=2 AND cfe.is_firm_transaction=true AND COALESCE(cfe.source_module,'')!='firm_transactions' AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))`);
console.log('CFE is_firm but not source=firm: count=' + cfeF.rows[0].cnt + ' total_amt=' + fmt(parseFloat(cfeF.rows[0].amt)));

await pool.end();
