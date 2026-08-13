import 'dotenv/config';
import pool from '../config/db.js';

const arg = (name) => {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  return match ? Number.parseInt(match.split('=')[1], 10) : null;
};

const historicalFarmers = [
  {
    name: 'BALDEV SINGH', phone: '9876504101', createdAt: '2023-02-14', totalAmount: 1800000,
    address: 'Village Kherki Majra, Gurugram, Haryana', village: 'Kherki Majra', tehsil: 'Gurugram',
    district: 'Gurugram', khasra: '118/2', landSize: 1.65, landRate: 1090909,
  },
  {
    name: 'SHANTI DEVI', phone: '9876504102', createdAt: '2024-01-22', totalAmount: 1450000,
    address: 'Village Wazirabad, Gurugram, Haryana', village: 'Wazirabad', tehsil: 'Gurugram',
    district: 'Gurugram', khasra: '74/6', landSize: 1.28, landRate: 1132813,
  },
  {
    name: 'MOHAN LAL', phone: '9876504103', createdAt: '2025-03-11', totalAmount: 2200000,
    address: 'Village Badshahpur, Gurugram, Haryana', village: 'Badshahpur', tehsil: 'Gurugram',
    district: 'Gurugram', khasra: '191/3', landSize: 2.05, landRate: 1073171,
  },
  {
    name: 'KAVITA SHARMA', phone: '9876504104', createdAt: '2026-01-18', totalAmount: 1650000,
    address: 'Village Kadarpur, Gurugram, Haryana', village: 'Kadarpur', tehsil: 'Gurugram',
    district: 'Gurugram', khasra: '42/1', landSize: 1.46, landRate: 1130137,
  },
];

const farmerPayments = [
  ['BALDEV SINGH', '2023-04-18', 'Initial land consideration instalment', 175000, 'CASH', 175000, 0],
  ['BALDEV SINGH', '2023-11-07', 'Land consideration instalment', 385000, 'BANK', 0, 385000],
  ['SHANTI DEVI', '2024-03-26', 'Land consideration instalment', 375000, 'SPLIT', 125000, 250000],
  ['BALDEV SINGH', '2024-10-15', 'Land consideration instalment', 290000, 'BANK', 0, 290000],
  ['MOHAN LAL', '2025-05-09', 'Initial land consideration instalment', 450000, 'BANK', 0, 450000],
  ['SHANTI DEVI', '2025-12-02', 'Land consideration instalment', 325000, 'CASH', 325000, 0],
  ['MOHAN LAL', '2026-04-19', 'Land consideration instalment', 540000, 'SPLIT', 140000, 400000],
  ['KAVITA SHARMA', '2026-07-28', 'Initial land consideration instalment', 425000, 'BANK', 0, 425000],
];

const expenses = [
  ['2023-03-21', 'DIWAN CITY PROJECT ACCOUNT', 'HORIZON SURVEY CONSULTANTS', 'BANK', 78000, 'PROFESSIONAL FEES', 'Boundary survey and land demarcation fees'],
  ['2023-07-12', 'DIWAN CITY PROJECT ACCOUNT', 'SITE INFRA SERVICES', 'BANK', 120000, 'SITE OPERATIONS', 'Site office setup and utility security deposit'],
  ['2023-11-24', 'DIWAN CITY PROJECT ACCOUNT', 'ADV. PRIYA KHANNA', 'BANK', 65000, 'LEGAL & COMPLIANCE', 'Title due diligence and mutation documentation'],
  ['2024-02-16', 'DIWAN CITY PROJECT ACCOUNT', 'NORTHRIDGE EARTHWORKS', 'BANK', 168000, 'SITE DEVELOPMENT', 'Access road grading and drainage material'],
  ['2024-06-28', 'DIWAN CITY PROJECT ACCOUNT', 'SENTINEL SECURITY SERVICES', 'BANK', 72000, 'SECURITY', 'Quarterly site security and maintenance service'],
  ['2024-10-08', 'DIWAN CITY PETTY CASH', 'NEXUS OFFICE SOLUTIONS', 'CASH', 96000, 'MARKETING', 'Sales office furniture and site signage'],
  ['2025-01-30', 'DIWAN CITY PROJECT ACCOUNT', 'ECOCHECK LABORATORIES', 'BANK', 38500, 'LEGAL & COMPLIANCE', 'Environmental testing and monitoring fees'],
  ['2025-05-17', 'DIWAN CITY PROJECT ACCOUNT', 'ARROW BUILDERS SUPPLY', 'BANK', 215000, 'CONSTRUCTION', 'Boundary wall repair and material supply'],
  ['2025-09-25', 'DIWAN CITY PROJECT ACCOUNT', 'AXIS DESIGN STUDIO', 'BANK', 110000, 'PROFESSIONAL FEES', 'Infrastructure design consultancy fees'],
  ['2026-01-14', 'DIWAN CITY PROJECT ACCOUNT', 'HARYANA DEVELOPMENT AUTHORITY', 'BANK', 42500, 'LEGAL & COMPLIANCE', 'Approval filing and statutory documentation'],
  ['2026-04-22', 'DIWAN CITY PROJECT ACCOUNT', 'SAPPHIRE POWER SOLUTIONS', 'BANK', 88000, 'UTILITIES', 'Site lighting and electrical maintenance'],
  ['2026-07-09', 'DIWAN CITY PETTY CASH', 'GREENFIELD COMMUNITY TRUST', 'CASH', 52000, 'SITE DEVELOPMENT', 'Community engagement and plantation drive'],
];

// Historical plot receipts use the existing DIWAN CITY inventory: the company
// plot is used for early direct receipts and the current A1 booking is used
// only after its actual 2026 booking date.
const plotPayments = [
  { plotId: 2, date: '2023-05-03', payer: 'VIKAS MALIK', buyer: 'VIKAS MALIK', amount: 325000, mode: 'BANK', receipt: 'DWC-HR-2023-001' },
  { plotId: 2, date: '2024-04-24', payer: 'NEHA GUPTA', buyer: 'NEHA GUPTA', amount: 450000, mode: 'CASH', receipt: 'DWC-HR-2024-001' },
  { plotId: 2, date: '2025-06-18', payer: 'ROHIT VERMA', buyer: 'ROHIT VERMA', amount: 525000, mode: 'BANK', receipt: 'DWC-HR-2025-001' },
  { plotId: 8, date: '2026-08-10', payer: 'AAKASH', buyer: 'AAKASH', amount: 520000, mode: 'BANK', receipt: 'DWC-HR-2026-001', bookingId: 1, allotteeMemberId: 30, projectId: 1, phaseId: 1 },
];

const personalLedgerEntries = [
  ['RAVI SHARMA', '2023-04-11', 'Site visit and coordination advance', 15000, 0, 'cash'],
  ['RAVI SHARMA', '2023-09-29', 'Travel advance adjustment received', 0, 6500, 'bank'],
  ['ANITA KUMARI', '2024-02-08', 'Local authority liaison advance', 28000, 0, 'bank'],
  ['ANITA KUMARI', '2024-07-19', 'Approved expense reimbursement received', 0, 12000, 'bank'],
  ['RAVI SHARMA', '2025-03-14', 'Project coordination travel advance', 18000, 0, 'cash'],
  ['DEEPAK MALIK', '2025-10-06', 'Documentation advance settlement received', 0, 22500, 'bank'],
  ['ANITA KUMARI', '2026-01-27', 'Community meeting advance', 14500, 0, 'cash'],
  ['RAVI SHARMA', '2026-06-21', 'Project advance settlement received', 0, 35000, 'bank'],
];

const asTimestamp = (date) => `${date}T12:00:00+05:30`;

async function ensurePersonalLedgerMonth(client, { siteId, entryDate, ledgerName, ownerId }) {
  const date = new Date(`${entryDate}T00:00:00Z`);
  const month = date.getUTCMonth() + 1;
  const year = date.getUTCFullYear();
  const name = ledgerName.toUpperCase();

  const { rows } = await client.query(
    `INSERT INTO cash_flow_months
      (site_id, month, year, opening_balance, ledger_name, ledger_type, notes, created_by)
     VALUES ($1, $2, $3, 0, $4, 'person', 'Historical manual personal ledger', $5)
     ON CONFLICT (site_id, month, year, ledger_name) DO NOTHING
     RETURNING id, is_locked`,
    [siteId, month, year, name, ownerId],
  );

  const ledger = rows[0] || (await client.query(
    `SELECT id, is_locked FROM cash_flow_months
      WHERE site_id=$1 AND month=$2 AND year=$3 AND ledger_name=$4`,
    [siteId, month, year, name],
  )).rows[0];
  if (!ledger || ledger.is_locked) throw new Error(`Personal ledger ${name} for ${month}/${year} is unavailable`);
  return ledger.id;
}

async function seed() {
  if (process.env.NODE_ENV === 'production') throw new Error('Historical demo seed is disabled in production');
  const organizationId = arg('organization');
  const siteId = arg('site');
  if (!organizationId || !siteId) {
    throw new Error('Usage: npm run seed:historical-demo -- --organization=<id> --site=<id>');
  }

  const client = await pool.connect();
  const results = { farmers: 0, farmerPayments: 0, expenses: 0, plotPayments: 0, personalLedgerEntries: 0 };
  let currentOperation = 'site validation';
  try {
    await client.query('BEGIN');
    const { rows: sites } = await client.query(
      `SELECT s.id, s.name, o.name AS organization_name,
              (SELECT u.id FROM users u
                WHERE u.organization_id=s.organization_id AND u.is_active=TRUE
                ORDER BY CASE WHEN u.role IN ('admin','super_admin') THEN 0 ELSE 1 END, u.id
                LIMIT 1) AS owner_id
         FROM sites s
         JOIN organizations o ON o.id=s.organization_id
        WHERE s.id=$1 AND s.organization_id=$2`,
      [siteId, organizationId],
    );
    const site = sites[0];
    if (!site?.owner_id) throw new Error('Site/organisation not found or no active user exists');

    const farmerIds = new Map();
    for (const farmer of historicalFarmers) {
      currentOperation = `farmer ${farmer.name}`;
      const existing = await client.query(
        `SELECT id FROM farmers WHERE site_id=$1 AND phone=$2 LIMIT 1`,
        [siteId, farmer.phone],
      );
      if (existing.rows[0]) {
        farmerIds.set(farmer.name, existing.rows[0].id);
        continue;
      }

      const inserted = await client.query(
        `INSERT INTO farmers
          (name, phone, address, total_amount, interest_rate, site_id, created_by, notes, status,
           payment_mode, cash_amount, bank_amount, land_size_bigha, land_rate, acquisition_reference,
           acquisition_type, village, tehsil, district, state, khasra_number, land_type, ownership_share,
           land_notes, responsible_user_id, created_at, updated_at)
         VALUES
          ($1,$2,$3,$4,0,$5,$6,$7,'active','BANK',0,$4,$8,$9,NULL,NULL,$10,$11,$12,'Haryana',$13,
           'Agricultural',100,'Historic land-acquisition record',$6,$14::timestamptz,$14::timestamptz)
         RETURNING id`,
        [
          farmer.name, farmer.phone, farmer.address, farmer.totalAmount, siteId, site.owner_id,
          'Historic land-acquisition record for Diwan City.', farmer.landSize, farmer.landRate,
          farmer.village, farmer.tehsil, farmer.district, farmer.khasra, asTimestamp(farmer.createdAt),
        ],
      );
      farmerIds.set(farmer.name, inserted.rows[0].id);
      results.farmers += 1;
    }

    for (const [farmerName, date, particular, amount, paymentMode, cashAmount, bankAmount] of farmerPayments) {
      currentOperation = `farmer payment ${farmerName} on ${date}`;
      const farmerId = farmerIds.get(farmerName);
      const idempotencyKey = `historical-farmer-${date}-${farmerId}`;
      const { rowCount } = await client.query(
        `INSERT INTO farmer_payments
          (farmer_id, date, particular, amount, interest_rate, interest_amount, remarks, payment_mode,
           cash_amount, bank_amount, bank_name, bank_reference, status, approved_by, approved_at,
           assigned_admin_id, created_by, idempotency_key, created_at, updated_at)
         SELECT $1::integer,$2::date,$3::varchar(255),$4::numeric,0,0,$5::text,$6::varchar(20),$7::numeric,$8::numeric,
                CASE WHEN $6::varchar(20) IN ('BANK'::varchar, 'SPLIT'::varchar) THEN 'HDFC BANK' ELSE NULL END,
                CASE WHEN $6::varchar(20) IN ('BANK'::varchar, 'SPLIT'::varchar) THEN $9::varchar(120) ELSE NULL END,
                'approved',$10::integer,$11::timestamptz,$10::integer,$10::integer,$9::varchar(120),$11::timestamptz,$11::timestamptz
          WHERE NOT EXISTS (
            SELECT 1 FROM farmer_payments WHERE farmer_id=$1::integer AND idempotency_key=$9::varchar(120)
          )`,
        [
          farmerId, date, particular, amount, 'Historic land-acquisition payment', paymentMode,
          cashAmount, bankAmount, idempotencyKey, site.owner_id, asTimestamp(date),
        ],
      );
      results.farmerPayments += rowCount;
    }

    for (const [date, fromEntity, toEntity, paymentMode, debit, category, description] of expenses) {
      currentOperation = `expense ${description}`;
      const remark = description.toUpperCase();
      const { rowCount } = await client.query(
        `INSERT INTO expenses
          (site_id, date, from_entity, to_entity, payment_mode, debit, credit, remark, account_no, branch,
           category, status, approved_by, approved_at, assigned_admin_id, created_by, created_at, updated_at)
         SELECT $1::integer,$2::date,$3::varchar(255),$4::varchar(255),$5::varchar(50),$6::numeric,0,$7::text,
                CASE WHEN $5::varchar(50)='BANK'::varchar THEN 'HDFC-DC-4821' ELSE NULL END,
                CASE WHEN $5::varchar(50)='BANK'::varchar THEN 'GURUGRAM MAIN' ELSE NULL END,
                $8::varchar(100),'approved',$9::integer,$10::timestamptz,$9::integer,$9::integer,$10::timestamptz,$10::timestamptz
          WHERE NOT EXISTS (SELECT 1 FROM expenses WHERE site_id=$1::integer AND remark=$7::text)`,
        [siteId, date, fromEntity, toEntity, paymentMode, debit, remark, category, site.owner_id, asTimestamp(date)],
      );
      results.expenses += rowCount;
    }

    for (const payment of plotPayments) {
      currentOperation = `plot payment ${payment.receipt}`;
      const idempotencyKey = `historical-plot-${payment.receipt.toLowerCase()}`;
      const { rowCount } = await client.query(
        `INSERT INTO plot_payments
          (plot_id, site_id, date, payment_from, bank_details, narration, received_by, amount, created_by,
           payment_type, status, approved_by, approved_at, assigned_admin_id, bank_name, buyer_name, booked_by,
           booking_id, allottee_member_id, rera_project_id, rera_project_phase_id, receipt_no, idempotency_key,
           reconciliation_status, created_at, updated_at)
         SELECT $1::integer,$2::integer,$3::date,$4::varchar(255),
                CASE WHEN $5::varchar(20)='BANK'::varchar THEN 'HDFC BANK · DIWAN CITY COLLECTION' ELSE 'SITE CASH COLLECTION' END,
                'Historic plot receipt', 'Admin', $6::numeric,$7::integer,$5::varchar(20),'approved',$7::integer,$8::timestamptz,$7::integer,
                CASE WHEN $5::varchar(20)='BANK'::varchar THEN 'HDFC BANK' ELSE NULL END,$9::varchar(255),'Admin',$10::integer,$11::integer,$12::bigint,$13::bigint,$14::varchar(100),$15::varchar(120),
                'UNMATCHED',$8::timestamptz,$8::timestamptz
          WHERE NOT EXISTS (SELECT 1 FROM plot_payments WHERE site_id=$2::integer AND idempotency_key=$15::varchar(120))`,
        [
          payment.plotId, siteId, payment.date, payment.payer, payment.mode, payment.amount, site.owner_id,
          asTimestamp(payment.date), payment.buyer, payment.bookingId ?? null, payment.allotteeMemberId ?? null,
          payment.projectId ?? null, payment.phaseId ?? null, payment.receipt, idempotencyKey,
        ],
      );
      results.plotPayments += rowCount;
    }

    for (const [ledgerName, date, particular, debit, credit, cashType] of personalLedgerEntries) {
      currentOperation = `personal ledger ${ledgerName} on ${date}`;
      const monthId = await ensurePersonalLedgerMonth(client, { siteId, entryDate: date, ledgerName, ownerId: site.owner_id });
      const { rowCount } = await client.query(
        `INSERT INTO cash_flow_entries
          (cash_flow_month_id, site_id, date, particular, debit, credit, cash_type, remarks, created_by,
           status, approved_by, approved_at, assigned_admin_id, created_at, updated_at)
         SELECT $1::integer,$2::integer,$3::date,$4::varchar(500),$5::numeric,$6::numeric,$7::varchar(20),'Manual personal ledger entry',$8::integer,
                'approved',$8::integer,$9::timestamptz,$8::integer,$9::timestamptz,$9::timestamptz
          WHERE NOT EXISTS (
            SELECT 1 FROM cash_flow_entries
             WHERE cash_flow_month_id=$1::integer AND date=$3::date AND particular=$4::varchar(500)
               AND debit=$5::numeric AND credit=$6::numeric AND source_module IS NULL
          )`,
        [monthId, siteId, date, particular.toUpperCase(), debit, credit, cashType, site.owner_id, asTimestamp(date)],
      );
      results.personalLedgerEntries += rowCount;
    }

    await client.query('COMMIT');
    console.log(`Historical finance data seeded for ${site.organization_name} / ${site.name}: ${JSON.stringify(results)}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw new Error(`${currentOperation}: ${error.message}`);
  } finally {
    client.release();
  }
}

seed()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error('Historical finance seed failed:', error.message);
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
