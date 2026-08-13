import 'dotenv/config';
import pool from '../config/db.js';

const arg = (name) => {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  return match ? Number.parseInt(match.split('=')[1], 10) : null;
};

const dateIn = (days) => {
  const value = new Date();
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 10);
};

const demoExpenses = [
  ['DWC-EXP-001', -26, 'DIWAN CITY PROJECT ACCOUNT', 'NORTHLINE INFRA PVT LTD', 'NEFT', 185000, 0, 'CONSTRUCTION', 'approved', 'Foundation concrete mobilisation milestone', 'HDFC-DC-4821', 'GURUGRAM MAIN', null, null],
  ['DWC-EXP-002', -23, 'DIWAN CITY PETTY CASH', 'SITE OPERATIONS TEAM', 'CASH', 12450, 0, 'SITE OPERATIONS', 'approved', 'Site office consumables and generator diesel', null, null, null, null],
  ['DWC-EXP-003', -20, 'DIWAN CITY PROJECT ACCOUNT', 'HARYANA STATE POLLUTION CONTROL BOARD', 'UPI', 18000, 0, 'LEGAL & COMPLIANCE', 'approved', 'Environmental monitoring submission fee', 'HDFC-DC-4821', 'GURUGRAM MAIN', null, null],
  ['DWC-EXP-004', -17, 'DIWAN CITY PROJECT ACCOUNT', 'SENTINEL SECURITY SERVICES', 'BANK', 74600, 0, 'SECURITY', 'approved', 'Monthly perimeter security and access-control service', 'HDFC-DC-4821', 'GURUGRAM MAIN', null, null],
  ['DWC-EXP-005', -14, 'DIWAN CITY PROJECT ACCOUNT', 'ARROW MEDIA HOUSE', 'RTGS', 96000, 0, 'MARKETING', 'pending', 'Digital campaign and site-launch collateral', 'HDFC-DC-4821', 'GURUGRAM MAIN', null, null],
  ['DWC-EXP-006', -11, 'DIWAN CITY PETTY CASH', 'TOWER A SITE TEAM', 'CASH', 8250, 0, 'LABOUR WELFARE', 'approved', 'Safety refreshments and protective supplies', null, null, null, null],
  ['DWC-EXP-007', -9, 'DIWAN CITY PROJECT ACCOUNT', 'ADV. MEERA SETHI', 'TRANSFER', 55000, 0, 'PROFESSIONAL FEES', 'approved', 'Land-title hearing preparation and legal opinion', 'HDFC-DC-4821', 'GURUGRAM MAIN', null, null],
  ['DWC-EXP-008', -7, 'DIWAN CITY PROJECT ACCOUNT', 'GURUGRAM MUNICIPAL CORPORATION', 'CHEQUE', 25000, 0, 'LEGAL & COMPLIANCE', 'pending', 'Storm-water corrective-action inspection deposit', 'HDFC-DC-4821', 'GURUGRAM MAIN', 'DWC-CHQ-1087', 'PENDING'],
  ['DWC-EXP-009', -5, 'DIWAN CITY PROJECT ACCOUNT', 'SAPPHIRE POWER SOLUTIONS', 'IMPS', 34900, 0, 'UTILITIES', 'approved', 'Temporary electricity connection and meter deposit', 'HDFC-DC-4821', 'GURUGRAM MAIN', null, null],
  ['DWC-EXP-010', -3, 'DIWAN CITY PROJECT ACCOUNT', 'NORTHLINE INFRA PVT LTD', 'NEFT', 210000, 0, 'CONSTRUCTION', 'approved', 'RCC work running bill — Tower A', 'HDFC-DC-4821', 'GURUGRAM MAIN', null, null],
  ['DWC-EXP-011', -1, 'DIWAN CITY PETTY CASH', 'SITE OPERATIONS TEAM', 'CASH', 6400, 0, 'SITE OPERATIONS', 'pending', 'Survey stakes, barricade tape and field stationery', null, null, null, null],
  ['DWC-EXP-012', 0, 'SUPPLIER CREDIT NOTE', 'DIWAN CITY PROJECT ACCOUNT', 'BANK', 0, 22500, 'CONSTRUCTION', 'approved', 'Credit received against damaged shuttering material', 'HDFC-DC-4821', 'GURUGRAM MAIN', null, null],
  ['DWC-EXP-013', 2, 'DIWAN CITY PROJECT ACCOUNT', 'FIRE & EMERGENCY SERVICES HARYANA', 'UPI', 12500, 0, 'LEGAL & COMPLIANCE', 'pending', 'Fire NOC renewal application fee', 'HDFC-DC-4821', 'GURUGRAM MAIN', null, null],
  ['DWC-EXP-014', 4, 'DIWAN CITY PROJECT ACCOUNT', 'GREENFIELD LANDSCAPES', 'BANK', 47800, 0, 'SITE DEVELOPMENT', 'rejected', 'Rejected duplicate landscaping mobilisation request', 'HDFC-DC-4821', 'GURUGRAM MAIN', null, null],
];

async function seed() {
  if (process.env.NODE_ENV === 'production') throw new Error('Expense demo seed is disabled in production');
  const organizationId = arg('organization');
  const siteId = arg('site');
  if (!organizationId || !siteId) throw new Error('Usage: npm run seed:expenses -- --organization=<id> --site=<id>');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: sites } = await client.query(
      `SELECT s.id,s.name,o.name AS organization_name,
              (SELECT u.id FROM users u WHERE u.organization_id=s.organization_id AND u.is_active=TRUE ORDER BY CASE WHEN u.role IN ('admin','super_admin') THEN 0 ELSE 1 END,u.id LIMIT 1) AS owner_id
         FROM sites s JOIN organizations o ON o.id=s.organization_id
        WHERE s.id=$1 AND s.organization_id=$2`,
      [siteId, organizationId],
    );
    const site = sites[0];
    if (!site?.owner_id) throw new Error('Site/organisation not found or no active user exists');

    let inserted = 0;
    let cleaned = 0;
    for (const [code, offset, fromEntity, toEntity, mode, debit, credit, category, status, description, accountNo, branch, chequeNo, chequeStatus] of demoExpenses) {
      // Display expense names, never internal/demo seed codes, in the register
      // or on printed receipts. Keep the legacy value only for a safe cleanup
      // of entries created by an older seed run.
      const remark = description.toUpperCase();
      const legacyRemark = `DIWAN CITY DEMO · ${code} · ${remark}`;
      const cleanup = await client.query(
        `UPDATE expenses SET remark=$1, updated_at=NOW() WHERE site_id=$2 AND remark=$3`,
        [remark, siteId, legacyRemark],
      );
      cleaned += cleanup.rowCount;
      const { rowCount } = await client.query(
        `INSERT INTO expenses
          (site_id,date,from_entity,to_entity,payment_mode,debit,credit,remark,account_no,branch,category,
           status,approved_by,approved_at,assigned_admin_id,created_by,cheque_no,cheque_status)
         SELECT $1::integer,$2::date,$3::varchar(255),$4::varchar(255),$5::varchar(50),$6::numeric,$7::numeric,$8::text,$9::varchar(100),$10::varchar(255),$11::varchar(100),
                $12::varchar(20),CASE WHEN $12::varchar(20) IN ('approved','rejected') THEN $13::integer ELSE NULL END,
                CASE WHEN $12::varchar(20) IN ('approved','rejected') THEN NOW() - INTERVAL '1 day' ELSE NULL END,$13::integer,$13::integer,$14::varchar(50),$15::varchar(20)
          WHERE NOT EXISTS (SELECT 1 FROM expenses WHERE site_id=$1::integer AND remark=$8::text)`,
        [siteId, dateIn(offset), fromEntity, toEntity, mode, debit, credit, remark, accountNo, branch, category, status, site.owner_id, chequeNo, chequeStatus],
      );
      inserted += rowCount;
    }

    await client.query('COMMIT');
    console.log(`Expense demo seeded for ${site.organization_name} / ${site.name}: ${inserted} inserted, ${cleaned} expense names cleaned, ${demoExpenses.length - inserted - cleaned} already present.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

seed()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error('Expense demo seed failed:', error.message);
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
