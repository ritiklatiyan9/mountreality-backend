import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({
  host: process.env.DB_HOST, port: +process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER,
  password: String(process.env.DB_PASSWORD || ''), ssl: { rejectUnauthorized: false },
});
const fmt = n => Number(n).toLocaleString('en-IN');

// Expenses page query for commissions (with JOINs)
const withJoinQ = `
  SELECT pcp.id, pcp.amount, pcp.date, pcp.site_id as pcp_site, pcm.id as pcm_id, ag.id as agent_id
  FROM plot_commission_payments pcp
  JOIN plot_commissions_v2 pcm ON pcp.plot_commission_id = pcm.id
  JOIN plots p ON pcm.plot_id = p.id
  JOIN members ag ON pcm.agent_id = ag.id
  WHERE pcp.site_id = 5
  AND (pcp.cheque_status IS NULL OR pcp.cheque_status NOT IN ('BOUNCED','RETURNED'))
  ORDER BY pcp.id
`;

// Consistency/KPI query for commissions (direct, no extra JOINs)
const directQ = `
  SELECT id, amount, date, site_id
  FROM plot_commission_payments
  WHERE site_id = 5 AND date >= '1970-01-01' AND date < '2100-01-01'
  AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  ORDER BY id
`;

// Also without date filter
const noDateQ = `
  SELECT id, amount, date, site_id
  FROM plot_commission_payments
  WHERE site_id = 5
  AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  ORDER BY id
`;

const [joinRes, directRes, noDateRes] = await Promise.all([
  pool.query(withJoinQ),
  pool.query(directQ),
  pool.query(noDateQ),
]);

console.log(`With JOINs (expenses page): ${joinRes.rows.length} rows, ₹${fmt(joinRes.rows.reduce((s,r)=>s+Number(r.amount),0))}`);
console.log(`Direct with date filter:    ${directRes.rows.length} rows, ₹${fmt(directRes.rows.reduce((s,r)=>s+Number(r.amount),0))}`);
console.log(`Direct no date filter:      ${noDateRes.rows.length} rows, ₹${fmt(noDateRes.rows.reduce((s,r)=>s+Number(r.amount),0))}`);

// Find which rows are in withJoin but not in direct
const directIds = new Set(directRes.rows.map(r => r.id));
const noDateIds = new Set(noDateRes.rows.map(r => r.id));
const joinIds = new Set(joinRes.rows.map(r => r.id));

const extraInJoin = joinRes.rows.filter(r => !directIds.has(r.id));
const extraInDirect = directRes.rows.filter(r => !joinIds.has(r.id));
const missingFromDirect = noDateRes.rows.filter(r => !directIds.has(r.id));

console.log(`\nExtra in JOIN (not in direct+date):`, extraInJoin);
console.log(`Extra in direct (not in JOIN):`, extraInDirect);
console.log(`In noDate but not in date-filtered:`, missingFromDirect);

// Check if JOIN creates duplicates
const joinIdCounts = {};
joinRes.rows.forEach(r => { joinIdCounts[r.id] = (joinIdCounts[r.id]||0)+1; });
const dupes = Object.entries(joinIdCounts).filter(([_,c])=>c>1);
if (dupes.length) console.log('\nDuplicate IDs from JOIN:', dupes);
else console.log('\nNo duplicate IDs from JOIN');

await pool.end();
