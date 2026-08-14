import 'dotenv/config';
import pool from '../config/db.js';

/*
 * Seeds a visible, historically plausible customer lifecycle for local/demo
 * use. It only touches the named company-owned plots at Diwan Valley and is
 * safe to run again: a completed seed exits without adding duplicate rows.
 *
 * Run a reversible validation first:
 *   node src/scripts/seedCustomerLifecycleDemo.js --dry-run
 * Then seed:
 *   node src/scripts/seedCustomerLifecycleDemo.js
 */

const SITE_ID = 5;
const ORGANIZATION_ID = 6;
const SEED_KEY = 'DEMO_CUSTOMER_LIFECYCLE_2023_2026';
const DRY_RUN = process.argv.includes('--dry-run');
const RECEIPT_COUNT = 16;
const LAST_RECEIPT_DATE = '2026-08-05';

const customers = [
  { plotNo: 'A2', code: 'A2', name: 'Rohan Bhatia', phone: '9811102401', bookingDate: '2023-03-18', collectedPercent: 0.76, stage: 'BOOKED', occupation: 'Business owner' },
  { plotNo: 'A3', code: 'A3', name: 'Kavita Sood', phone: '9811102402', bookingDate: '2023-05-12', collectedPercent: 0.85, stage: 'ALLOTTED', occupation: 'School principal' },
  { plotNo: 'A4', code: 'A4', name: 'Manish Arora', phone: '9811102403', bookingDate: '2023-07-08', collectedPercent: 0.92, stage: 'AGREEMENT_EXECUTED', occupation: 'Chartered accountant' },
  { plotNo: 'A5', code: 'A5', name: 'Simran Kaur', phone: '9811102404', bookingDate: '2023-09-23', collectedPercent: 1, stage: 'AGREEMENT_EXECUTED', occupation: 'Architect' },
  { plotNo: 'A7', code: 'A7', name: 'Aditya Nayar', phone: '9811102405', bookingDate: '2024-01-15', collectedPercent: 0.96, stage: 'REGISTRY_PENDING', occupation: 'Software consultant' },
  { plotNo: 'A8', code: 'A8', name: 'Pooja Malhotra', phone: '9811102406', bookingDate: '2024-03-27', collectedPercent: 0.87, stage: 'REGISTRY_PENDING', occupation: 'Bank manager' },
  { plotNo: 'A9', code: 'A9', name: 'Sandeep Grover', phone: '9811102407', bookingDate: '2024-06-11', collectedPercent: 1, stage: 'POSSESSED', occupation: 'Manufacturer' },
  { plotNo: 'A10', code: 'A10', name: 'Nisha Kapoor', phone: '9811102408', bookingDate: '2024-08-19', collectedPercent: 1, stage: 'POSSESSED', occupation: 'Doctor' },
  { plotNo: 'A12', code: 'A12', name: 'Vivek Bansal', phone: '9811102409', bookingDate: '2024-10-06', collectedPercent: 0.66, stage: 'BOOKED', occupation: 'Export trader' },
  { plotNo: 'A13', code: 'A13', name: 'Meera Chawla', phone: '9811102410', bookingDate: '2024-12-14', collectedPercent: 0.9, stage: 'AGREEMENT_EXECUTED', occupation: 'University lecturer' },
];

const jointAllottees = [
  { code: 'A4-JOINT', name: 'Ritu Arora', phone: '9811102411', relation: 'Spouse' },
  { code: 'A9-JOINT', name: 'Ananya Grover', phone: '9811102412', relation: 'Spouse' },
];

const scheduleNames = [
  ['Booking token', 'BOOKING_TOKEN'],
  ['Allotment confirmation', 'ALLOTMENT'],
  ['Agreement preparation', 'AGREEMENT'],
  ['Installment 01', 'INSTALLMENT_01'],
  ['Installment 02', 'INSTALLMENT_02'],
  ['Installment 03', 'INSTALLMENT_03'],
  ['Registry readiness', 'REGISTRY'],
  ['Final settlement', 'FINAL_SETTLEMENT'],
];

const modeCycle = [
  { paymentType: 'CASH', paymentFrom: 'BOOKING TOKEN', reference: 'CASH COUNTER' },
  { paymentType: 'BANK', paymentFrom: 'UPI COLLECTION', reference: 'UPI/DVW' },
  { paymentType: 'BANK', paymentFrom: 'NEFT COLLECTION', reference: 'NEFT/DVW' },
  { paymentType: 'CHEQUE', paymentFrom: 'CHEQUE COLLECTION', reference: 'CHQ/DVW' },
  { paymentType: 'BANK', paymentFrom: 'RTGS COLLECTION', reference: 'RTGS/DVW' },
  { paymentType: 'CASH', paymentFrom: 'CASH COLLECTION', reference: 'CASH COUNTER' },
  { paymentType: 'BANK', paymentFrom: 'INSTALLMENT COLLECTION', reference: 'IMPS/DVW' },
  { paymentType: 'CHEQUE', paymentFrom: 'CHEQUE COLLECTION', reference: 'CHQ/DVW' },
];

const pad = (value) => String(value).padStart(2, '0');
const isoDate = (value) => `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
const atNoon = (date) => new Date(`${date}T06:30:00.000Z`);
const addDays = (date, days) => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};
const cents = (value) => Math.round(Number(value) * 100);
const money = (value) => (value / 100).toFixed(2);

const splitCents = (total, parts) => {
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  return Array.from({ length: parts }, (_, index) => base + (index < remainder ? 1 : 0));
};

const distributedDates = (startDate, count) => {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${LAST_RECEIPT_DATE}T00:00:00.000Z`);
  const span = Math.max(0, Math.round((end - start) / 86400000));
  return Array.from({ length: count }, (_, index) => (
    isoDate(addDays(start, Math.round((span * index) / Math.max(count - 1, 1))))
  ));
};

const memberMarker = (code) => `${SEED_KEY}:MEMBER:${code}`;
const bookingMarker = (code) => `${SEED_KEY}:BOOKING:${code}`;
const receiptMarker = (code, sequence) => `${SEED_KEY}:RECEIPT:${code}:${pad(sequence)}`;

const timelineFor = ({ bookingDate, stage, transactionDates, bookingId, plotNo }) => {
  const timeline = [
    ['PROPERTY_BOOKED', bookingDate, `Demo booking confirmed for Plot ${plotNo}.`],
    ['CUSTOMER_KYC_COMPLETED', transactionDates[1], 'Customer KYC and contact verification completed.'],
    ['PAYMENT_SCHEDULE_ISSUED', transactionDates[2], 'Eight-stage collection schedule issued to the customer.'],
    ['INITIAL_RECEIPT_POSTED', transactionDates[3], 'Initial collection receipts posted and reconciled.'],
    ['COLLECTION_MILESTONE_REVIEWED', transactionDates[7], 'Collection milestone reviewed with the relationship manager.'],
    ['ACCOUNT_STATEMENT_SHARED', transactionDates[11], 'Updated statement of account shared with the customer.'],
  ];
  if (['AGREEMENT_EXECUTED', 'REGISTRY_PENDING', 'POSSESSED'].includes(stage)) {
    timeline.push(['AGREEMENT_EXECUTED', transactionDates[9], 'Allotment agreement executed and archived.']);
  }
  if (['REGISTRY_PENDING', 'POSSESSED'].includes(stage)) {
    timeline.push(['REGISTRY_PREPARATION_STARTED', transactionDates[13], 'Registry papers and payment evidence reviewed.']);
  }
  if (stage === 'POSSESSED') {
    timeline.push(['POSSESSION_COMPLETED', transactionDates[15], 'Possession handover acknowledged by the customer.']);
  }
  return timeline.map(([action, date, reason]) => ({
    action,
    date,
    reason,
    newValue: { source: SEED_KEY, booking_id: bookingId, plot_no: plotNo },
  }));
};

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL TIME ZONE "Asia/Kolkata"');

    const { rows: existingRows } = await client.query(
      `SELECT id FROM bookings
        WHERE organization_id=$1 AND site_id=$2 AND idempotency_key LIKE $3
        LIMIT 1`,
      [ORGANIZATION_ID, SITE_ID, `${SEED_KEY}:%`],
    );
    if (existingRows[0]) {
      await client.query(DRY_RUN ? 'ROLLBACK' : 'COMMIT');
      console.log(`${SEED_KEY} is already present — no rows were added.`);
      return;
    }

    const { rows: adminRows } = await client.query(
      `SELECT id FROM users
        WHERE organization_id=$1 AND role IN ('admin','super_admin')
          AND COALESCE(is_active,TRUE)=TRUE
        ORDER BY id LIMIT 1`,
      [ORGANIZATION_ID],
    );
    const adminId = adminRows[0]?.id;
    if (!adminId) throw new Error('An active administrator is required for the demo lifecycle seed.');

    const { rows: accountRows } = await client.query(
      `SELECT id,bank_name FROM upi_accounts
        WHERE site_id=$1 AND is_active=TRUE
        ORDER BY id LIMIT 1`,
      [SITE_ID],
    );
    const bankAccount = accountRows[0];
    if (!bankAccount) throw new Error('An active site bank account is required for the demo receipts.');

    const plotNos = customers.map(({ plotNo }) => plotNo);
    const { rows: plots } = await client.query(
      `SELECT id,plot_no,block,plot_size,sale_price,status,current_booking_id,notes
         FROM plots
        WHERE site_id=$1 AND plot_no=ANY($2::text[])
        ORDER BY plot_no
        FOR UPDATE`,
      [SITE_ID, plotNos],
    );
    if (plots.length !== customers.length) throw new Error('One or more requested demo plots could not be found.');
    const plotsByNo = new Map(plots.map((plot) => [plot.plot_no, plot]));
    for (const profile of customers) {
      const plot = plotsByNo.get(profile.plotNo);
      if (plot.current_booking_id || String(plot.status).toUpperCase() !== 'COMPANY') {
        throw new Error(`Plot ${profile.plotNo} is no longer a safe company-owned plot for this seed.`);
      }
    }

    const memberIds = new Map();
    const allPeople = [
      ...customers.map(({ code, name, phone, occupation }) => ({ code, name, phone, occupation, relation: null })),
      ...jointAllottees.map(({ code, name, phone, relation }) => ({ code, name, phone, occupation: null, relation })),
    ];
    for (const person of allPeople) {
      const marker = memberMarker(person.code);
      const { rows } = await client.query(
        `INSERT INTO members
           (site_id,member_type,full_name,phone,email,address,city,state,pincode,occupation,status,notes,created_by,created_at,updated_at)
         VALUES ($1,'CLIENT',$2,$3,$4,$5,'Gurugram','Haryana','122001',$6,'ACTIVE',$7,$8,$9,$9)
         RETURNING id`,
        [
          SITE_ID,
          person.name,
          person.phone,
          `${person.code.toLowerCase()}@demo.diwanvalley.test`,
          'Demo customer record · Diwan Valley',
          person.occupation || `Joint allottee (${person.relation})`,
          marker,
          adminId,
          atNoon('2023-01-01'),
        ],
      );
      memberIds.set(person.code, rows[0].id);
    }

    let bookingCount = 0;
    let installmentCount = 0;
    let paymentCount = 0;
    let auditCount = 0;
    let agreementCount = 0;
    let registryCount = 0;
    let possessionCount = 0;

    for (const profile of customers) {
      const plot = plotsByNo.get(profile.plotNo);
      const primaryMemberId = memberIds.get(profile.code);
      const joint = jointAllottees.find((entry) => entry.code.startsWith(`${profile.code}-`));
      const jointMemberId = joint ? memberIds.get(joint.code) : null;
      const saleCents = cents(plot.sale_price);
      const collectedCents = Math.round(saleCents * profile.collectedPercent);
      const scheduleAmounts = splitCents(saleCents, scheduleNames.length);
      const paymentAmounts = splitCents(collectedCents, RECEIPT_COUNT);
      const transactionDates = distributedDates(profile.bookingDate, RECEIPT_COUNT);
      const snapshot = {
        source: SEED_KEY,
        base_price: money(saleCents),
        charges: '0.00',
        discount_amount: '0.00',
        final_consideration: money(saleCents),
        price_version: 'DEMO-2023-2026',
        effective_date: profile.bookingDate,
      };

      const { rows: bookingRows } = await client.query(
        `INSERT INTO bookings
           (organization_id,site_id,plot_id,client_member_id,booking_date,sale_price,payment_plan,status,kyc_status,
            buyer_name,booked_by,notes,created_by,created_at,updated_at,commercial_snapshot,base_price,charges,
            discount_amount,final_consideration,price_version,price_effective_date,agreement_required,agreement_status,
            lifecycle_status,idempotency_key,confirmed_by,confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6,'INSTALLMENT','CONFIRMED','VERIFIED',$7,'RITIK KUMAR',$8,$9,$10,$10,$11,$6,0,0,$6,
                 'DEMO-2023-2026',$5,$12,$13,$14,$15,$9,$10)
         RETURNING id`,
        [
          ORGANIZATION_ID, SITE_ID, plot.id, primaryMemberId, profile.bookingDate, money(saleCents), profile.name,
          `${SEED_KEY} · Historical customer lifecycle from 2023 to 2026.`, adminId, atNoon(profile.bookingDate), snapshot,
          ['AGREEMENT_EXECUTED', 'REGISTRY_PENDING', 'POSSESSED'].includes(profile.stage),
          ['AGREEMENT_EXECUTED', 'REGISTRY_PENDING', 'POSSESSED'].includes(profile.stage) ? 'EXECUTED' : 'NOT_STARTED',
          profile.stage, bookingMarker(profile.code),
        ],
      );
      const bookingId = bookingRows[0].id;
      const bookingNo = `DVC-${profile.bookingDate.slice(0, 4)}-${profile.code}-${String(bookingId).padStart(5, '0')}`;
      await client.query(`UPDATE bookings SET booking_no=$1 WHERE id=$2`, [bookingNo, bookingId]);
      bookingCount += 1;

      await client.query(
        `INSERT INTO booking_allottees
           (organization_id,site_id,booking_id,member_id,allottee_role,status,effective_from,relationship_notes,created_by,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'PRIMARY','ACTIVE',$5,NULL,$6,$7,$7)`,
        [ORGANIZATION_ID, SITE_ID, bookingId, primaryMemberId, profile.bookingDate, adminId, atNoon(profile.bookingDate)],
      );
      if (jointMemberId) {
        await client.query(
          `INSERT INTO booking_allottees
             (organization_id,site_id,booking_id,member_id,allottee_role,status,effective_from,relationship_notes,created_by,created_at,updated_at)
           VALUES ($1,$2,$3,$4,'JOINT','ACTIVE',$5,$6,$7,$8,$8)`,
          [ORGANIZATION_ID, SITE_ID, bookingId, jointMemberId, profile.bookingDate, joint.relation, adminId, atNoon(profile.bookingDate)],
        );
      }

      const installmentIds = [];
      for (let index = 0; index < scheduleNames.length; index += 1) {
        const [installmentName, milestoneCode] = scheduleNames[index];
        const dueDate = transactionDates[Math.min(index * 2 + 1, transactionDates.length - 1)];
        const { rows } = await client.query(
          `INSERT INTO plot_installments
             (plot_id,booking_id,installment_name,milestone_code,amount,due_date,status,paid_amount,interest_amount,sort_order,
              demand_raised_at,demand_reference,schedule_version,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,'pending',0,0,$7,$8,$9,1,$8,$8)
           RETURNING id`,
          [plot.id, bookingId, installmentName, milestoneCode, money(scheduleAmounts[index]), dueDate, index + 1, atNoon(profile.bookingDate), `DVC-${profile.code}-D${pad(index + 1)}`],
        );
        installmentIds.push(rows[0].id);
        installmentCount += 1;
      }

      const schedulePaid = Array.from({ length: scheduleNames.length }, () => 0);
      for (let index = 0; index < RECEIPT_COUNT; index += 1) {
        const mode = modeCycle[index % modeCycle.length];
        const amount = paymentAmounts[index];
        const receiptDate = transactionDates[index];
        const installmentIndex = index % installmentIds.length;
        const chequeNo = mode.paymentType === 'CHEQUE' ? `DVC-${profile.code}-${pad(index + 1)}` : null;
        const bankish = mode.paymentType !== 'CASH';
        const { rows } = await client.query(
          `INSERT INTO plot_payments
             (plot_id,site_id,date,payment_from,payment_type,bank_details,bank_name,branch,narration,received_by,amount,
              created_by,created_at,updated_at,assigned_admin_id,status,approved_by,approved_at,cheque_no,cheque_status,
              buyer_name,booked_by,booking_id,allottee_member_id,receipt_no,idempotency_key,ruleset_decision,
              reconciliation_status,bank_account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ADMIN',$10,$11,$12,$12,$11,'approved',$11,$12,$13,$14,$15,
                   'RITIK KUMAR',$16,$17,$18,$19,$20,'MATCHED',$21)
           RETURNING id`,
          [
            plot.id, SITE_ID, receiptDate, mode.paymentFrom, mode.paymentType,
            `${mode.reference}/${profile.code}/${pad(index + 1)}`,
            bankish ? bankAccount.bank_name : null,
            bankish ? 'SECTOR 14' : null,
            `Demo receipt ${pad(index + 1)} of ${RECEIPT_COUNT} · ${mode.paymentFrom}`,
            money(amount), adminId, atNoon(receiptDate), chequeNo,
            mode.paymentType === 'CHEQUE' ? 'CLEARED' : null, profile.name, bookingId, primaryMemberId,
            `DVC-REC-${profile.code}-${pad(index + 1)}`, receiptMarker(profile.code, index + 1),
            { source: SEED_KEY, decision: 'ALLOWED', collection_stage: index + 1 },
            bankish ? bankAccount.id : null,
          ],
        );
        await client.query(
          `INSERT INTO plot_payment_allocations
             (plot_payment_id,booking_id,installment_id,allocated_amount,created_by,created_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [rows[0].id, bookingId, installmentIds[installmentIndex], money(amount), adminId, atNoon(receiptDate)],
        );
        schedulePaid[installmentIndex] += amount;
        paymentCount += 1;
      }

      for (let index = 0; index < installmentIds.length; index += 1) {
        const paid = schedulePaid[index];
        const scheduled = scheduleAmounts[index];
        const status = paid >= scheduled ? 'paid' : paid > 0 ? 'partially_paid' : 'pending';
        await client.query(
          `UPDATE plot_installments SET paid_amount=$1,status=$2,updated_at=$3 WHERE id=$4`,
          [money(paid), status, atNoon(LAST_RECEIPT_DATE), installmentIds[index]],
        );
      }

      let agreementId = null;
      if (['AGREEMENT_EXECUTED', 'REGISTRY_PENDING', 'POSSESSED'].includes(profile.stage)) {
        const executionDate = transactionDates[9];
        const { rows } = await client.query(
          `INSERT INTO booking_agreements
             (organization_id,site_id,booking_id,plot_id,version_number,agreement_number,agreement_type,template_version,
              commercial_snapshot,status,effective_date,execution_date,review_notes,reviewed_by,reviewed_at,created_by,created_at,updated_at)
           VALUES ($1,$2,$3,$4,1,$5,'ALLOTMENT_AGREEMENT','DEMO-2023-2026',$6,'EXECUTED',$7,$7,
                   'Demo agreement executed after collection review.',$8,$9,$8,$9,$9)
           RETURNING id`,
          [ORGANIZATION_ID, SITE_ID, bookingId, plot.id, `DVC/AGR/${profile.code}/${profile.bookingDate.slice(0, 4)}`, snapshot, executionDate, adminId, atNoon(executionDate)],
        );
        agreementId = rows[0].id;
        agreementCount += 1;
      }

      let registryId = null;
      if (['REGISTRY_PENDING', 'POSSESSED'].includes(profile.stage)) {
        const registryDate = profile.stage === 'POSSESSED' ? transactionDates[13] : null;
        const registryLifecycle = profile.stage === 'POSSESSED' ? 'COMPLETE' : 'SCHEDULED';
        const possessionStatus = profile.stage === 'POSSESSED' ? 'POSSESSED' : 'PENDING';
        const { rows } = await client.query(
          `INSERT INTO plot_registries
             (site_id,plot_no,customer_name,size_sqyard,registry_date,registry_payment,notes,created_by,created_at,updated_at,
              assigned_admin_id,plot_id,circle_rate,booking_id,allottee_member_id,agreement_id,lifecycle_status,readiness_policy,
              readiness_result,scheduled_at,completed_at,completed_by,possession_status,workflow_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$8,$10,0,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,1)
           RETURNING id`,
          [
            SITE_ID, plot.plot_no, profile.name, plot.plot_size || null, registryDate,
            money(Math.round(saleCents * 0.06)), `${SEED_KEY} · Registry workflow timeline.`, adminId,
            atNoon(transactionDates[13]), plot.id, bookingId, primaryMemberId, agreementId, registryLifecycle,
            { source: SEED_KEY }, { ready: profile.stage === 'POSSESSED', source: SEED_KEY },
            atNoon(transactionDates[14]), profile.stage === 'POSSESSED' ? atNoon(transactionDates[14]) : null,
            profile.stage === 'POSSESSED' ? adminId : null, possessionStatus,
          ],
        );
        registryId = rows[0].id;
        registryCount += 1;
      }

      if (profile.stage === 'POSSESSED') {
        await client.query(
          `INSERT INTO plot_possessions
             (organization_id,site_id,plot_id,booking_id,registry_id,allottee_member_id,status,scheduled_at,possession_date,
              checklist,acknowledgement,handled_by,completed_by,completed_at,idempotency_key,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,'POSSESSED',$7,$8,$9,$10,$11,$11,$7,$12,$7,$7)`,
          [
            ORGANIZATION_ID, SITE_ID, plot.id, bookingId, registryId, primaryMemberId,
            atNoon(transactionDates[14]), transactionDates[15],
            JSON.stringify([{ item: 'Keys handed over', complete: true }, { item: 'Site orientation completed', complete: true }]),
            { acknowledged_by: profile.name, acknowledged_on: transactionDates[15], source: SEED_KEY },
            adminId, `${SEED_KEY}:POSSESSION:${profile.code}`,
          ],
        );
        possessionCount += 1;
      }

      const plotStatus = profile.stage === 'POSSESSED' ? 'POSSESSED' : 'BOOKED';
      const registryStatus = profile.stage === 'POSSESSED' ? 'COMPLETE' : profile.stage === 'REGISTRY_PENDING' ? 'SCHEDULED' : null;
      const possessionStatus = profile.stage === 'POSSESSED' ? 'POSSESSED' : null;
      const financialStatus = profile.collectedPercent === 1 ? 'SETTLED' : 'PARTIALLY_COLLECTED';
      await client.query(
        `UPDATE plots SET current_booking_id=$1,buyer_name=$2,booking_by='RITIK KUMAR',booking_date=$3,sale_price=$4,
           status=$5,lifecycle_status=$6,agreement_status=$7,financial_status=$8,registry_status=$9,possession_status=$10,
           to_receive_bank=$11,installments_enabled=TRUE,notes=COALESCE(notes,'') || $12,lifecycle_version=lifecycle_version+1,
           updated_at=$13
         WHERE id=$14 AND site_id=$15`,
        [
          bookingId, profile.name, profile.bookingDate, money(saleCents), plotStatus, profile.stage,
          agreementId ? 'EXECUTED' : 'NOT_STARTED', financialStatus, registryStatus, possessionStatus,
          money(Math.round(saleCents * 0.78)), ` | ${SEED_KEY}`, atNoon(LAST_RECEIPT_DATE), plot.id, SITE_ID,
        ],
      );

      for (const event of timelineFor({ ...profile, transactionDates, bookingId, plotNo: plot.plot_no })) {
        await client.query(
          `INSERT INTO compliance_audit_log
             (organization_id,site_id,user_id,action,entity_type,entity_id,new_value,reason,created_at)
           VALUES ($1,$2,$3,$4,'PROPERTY_BOOKING',$5,$6,$7,$8)`,
          [ORGANIZATION_ID, SITE_ID, adminId, event.action, bookingId, event.newValue, event.reason, atNoon(event.date)],
        );
        auditCount += 1;
      }
    }

    const summary = {
      customers: customers.length + jointAllottees.length,
      bookings: bookingCount,
      installments: installmentCount,
      payments: paymentCount,
      agreements: agreementCount,
      registries: registryCount,
      possessions: possessionCount,
      timeline_events: auditCount,
      payment_range: '2023-03-18 to 2026-08-05',
    };
    await client.query(DRY_RUN ? 'ROLLBACK' : 'COMMIT');
    console.log(`${DRY_RUN ? 'Validated' : 'Seeded'} customer lifecycle demo:`, JSON.stringify(summary));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

seed()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error('Customer lifecycle demo seed failed:', {
      message: error.message,
      detail: error.detail,
      position: error.position,
      where: error.where,
    });
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
