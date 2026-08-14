import 'dotenv/config';
import pool from '../config/db.js';

/*
 * Rebalances only the Customer Inventory demo bookings at Diwan Valley.
 * The Customer Inventory metric named "Receivables" means OUTSTANDING,
 * therefore this script targets ₹32 Cr outstanding and ₹20 Cr approved
 * collections, for a ₹52 Cr total visible portfolio.
 *
 * Usage:
 *   node src/scripts/normalizeCustomerInventoryPortfolio.js --dry-run
 *   node src/scripts/normalizeCustomerInventoryPortfolio.js
 */

const SITE_ID = 5;
const TARGET_RECEIVABLE_CENTS = 32_000_000_000;
const TARGET_COLLECTED_CENTS = 20_000_000_000;
const DRY_RUN = process.argv.includes('--dry-run');
const SEED_MATCHERS = [
  'DEMO_CUSTOMER_LIFECYCLE_2023_2026:%',
  'DEMO_BOOKED_CUSTOMERS_2023_2026:%',
];

const cents = (value) => Math.round(Number(value || 0) * 100);
const money = (value) => (value / 100).toFixed(2);
const asJson = (value) => {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
};

const allocateCents = (total, weights) => {
  const safeWeights = weights.map((weight) => Math.max(0, Number(weight) || 0));
  const denominator = safeWeights.reduce((sum, value) => sum + value, 0);
  if (!safeWeights.length) return [];
  let assigned = 0;
  return safeWeights.map((weight, index) => {
    const amount = index === safeWeights.length - 1
      ? total - assigned
      : Math.round(total * ((denominator > 0 ? weight : 1) / (denominator > 0 ? denominator : safeWeights.length)));
    assigned += amount;
    return amount;
  });
};

async function normalize() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: bookings } = await client.query(
      `SELECT b.id,b.booking_no,b.lifecycle_status,b.sale_price,b.base_price,b.final_consideration,
              b.commercial_snapshot,p.id AS plot_id,p.plot_no,p.sale_price AS plot_sale_price
         FROM bookings b
         JOIN plots p ON p.id=b.plot_id AND p.site_id=b.site_id
        WHERE b.site_id=$1
          AND (b.idempotency_key LIKE $2 OR b.idempotency_key LIKE $3)
          AND p.current_booking_id=b.id
        ORDER BY b.id
        FOR UPDATE OF b,p`,
      [SITE_ID, ...SEED_MATCHERS],
    );
    if (bookings.length !== 50) {
      throw new Error(`Expected 50 current demo bookings but found ${bookings.length}. No changes were made.`);
    }
    const bookingIds = bookings.map((booking) => booking.id);

    const { rows: fixedRows } = await client.query(
      `SELECT
         COALESCE(SUM(GREATEST(COALESCE(b.final_consideration,p.sale_price,0)-COALESCE(receipts.total,0),0)),0) AS outstanding,
         COALESCE(SUM(COALESCE(receipts.total,0)),0) AS collected
       FROM plots p
       JOIN bookings b ON b.id=p.current_booking_id AND b.site_id=p.site_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(pp.amount),0) AS total
           FROM plot_payments pp
          WHERE pp.booking_id=b.id
            AND LOWER(COALESCE(pp.status,'approved'))='approved'
            AND UPPER(COALESCE(pp.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
       ) receipts ON TRUE
      WHERE p.site_id=$1 AND NOT (b.id=ANY($2::int[]))`,
      [SITE_ID, bookingIds],
    );
    const fixedOutstanding = cents(fixedRows[0]?.outstanding);
    const fixedCollected = cents(fixedRows[0]?.collected);
    const seedOutstanding = TARGET_RECEIVABLE_CENTS - fixedOutstanding;
    const seedCollected = TARGET_COLLECTED_CENTS - fixedCollected;
    const seedPortfolio = seedOutstanding + seedCollected;
    if (seedOutstanding <= 0 || seedCollected <= 0 || seedPortfolio <= 0) {
      throw new Error('Non-demo bookings already exceed the requested portfolio targets. No changes were made.');
    }

    const priceWeights = bookings.map((booking) => cents(booking.final_consideration || booking.sale_price || booking.plot_sale_price));
    const targetPrices = allocateCents(seedPortfolio, priceWeights);
    const bookingPlans = bookings.map((booking, index) => ({
      ...booking,
      targetPrice: targetPrices[index],
      currentPrice: priceWeights[index],
      payments: [],
      installments: [],
    }));

    for (const plan of bookingPlans) {
      const { rows: payments } = await client.query(
        `SELECT pp.id,pp.amount,ppa.id AS allocation_id,ppa.installment_id
           FROM plot_payments pp
           LEFT JOIN plot_payment_allocations ppa ON ppa.plot_payment_id=pp.id
          WHERE pp.booking_id=$1
            AND LOWER(COALESCE(pp.status,'approved'))='approved'
            AND UPPER(COALESCE(pp.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
          ORDER BY pp.date,pp.id
          FOR UPDATE OF pp`,
        [plan.id],
      );
      const { rows: installments } = await client.query(
        `SELECT id,amount,sort_order
           FROM plot_installments
          WHERE booking_id=$1 AND superseded_at IS NULL
          ORDER BY sort_order,id
          FOR UPDATE`,
        [plan.id],
      );
      if (payments.length !== 16 || payments.some((payment) => !payment.allocation_id || !payment.installment_id)) {
        throw new Error(`Booking ${plan.booking_no || plan.id} must have 16 allocated approved receipts.`);
      }
      if (installments.length !== 8) throw new Error(`Booking ${plan.booking_no || plan.id} must have 8 current installments.`);
      plan.payments = payments;
      plan.installments = installments;
    }

    const possessed = bookingPlans.filter((plan) => plan.lifecycle_status === 'POSSESSED');
    const others = bookingPlans.filter((plan) => plan.lifecycle_status !== 'POSSESSED');
    const possessedCollected = possessed.reduce((sum, plan) => sum + plan.targetPrice, 0);
    const remainingCollections = seedCollected - possessedCollected;
    if (remainingCollections < 0) throw new Error('Possessed demo bookings alone exceed the requested collection target.');

    const otherCollectionWeights = others.map((plan) => plan.payments.reduce((sum, payment) => sum + cents(payment.amount), 0));
    const otherCollections = allocateCents(remainingCollections, otherCollectionWeights);
    others.forEach((plan, index) => { plan.targetCollected = otherCollections[index]; });
    possessed.forEach((plan) => { plan.targetCollected = plan.targetPrice; });

    for (const plan of bookingPlans) {
      if (plan.targetCollected > plan.targetPrice) {
        throw new Error(`Target collection would exceed the sale value for Plot ${plan.plot_no}.`);
      }

      const paymentAmounts = allocateCents(
        plan.targetCollected,
        plan.payments.map((payment) => cents(payment.amount)),
      );
      const allocatedByInstallment = new Map(plan.installments.map((installment) => [installment.id, 0]));
      const paymentIds = [];
      const allocationIds = [];
      const updatedPaymentAmounts = [];
      for (let index = 0; index < plan.payments.length; index += 1) {
        const payment = plan.payments[index];
        const amount = paymentAmounts[index];
        paymentIds.push(payment.id);
        allocationIds.push(payment.allocation_id);
        updatedPaymentAmounts.push(money(amount));
        allocatedByInstallment.set(payment.installment_id, (allocatedByInstallment.get(payment.installment_id) || 0) + amount);
      }

      // Each schedule is first funded with its assigned receipt amounts.
      // The uncollected balance is then distributed across the schedule, so
      // no payment allocation can exceed its installment's new cap.
      const scheduleSurplus = allocateCents(
        plan.targetPrice - plan.targetCollected,
        plan.installments.map((installment) => cents(installment.amount)),
      );
      const installmentAmounts = plan.installments.map((installment, index) => (
        (allocatedByInstallment.get(installment.id) || 0) + scheduleSurplus[index]
      ));
      const installmentIds = plan.installments.map((installment) => installment.id);
      const updatedInstallmentAmounts = installmentAmounts.map(money);

      // The allocation table enforces each receipt against its installment
      // cap, so expand the schedules before increasing receipt allocations.
      await client.query(
        `UPDATE plot_installments pi SET amount=data.amount,updated_at=NOW()
           FROM UNNEST($1::bigint[],$2::numeric[]) AS data(id,amount)
          WHERE pi.id=data.id`,
        [installmentIds, updatedInstallmentAmounts],
      );
      await client.query(
        `UPDATE plot_payments pp SET amount=data.amount,updated_at=NOW()
           FROM UNNEST($1::int[],$2::numeric[]) AS data(id,amount)
          WHERE pp.id=data.id`,
        [paymentIds, updatedPaymentAmounts],
      );
      await client.query(
        `UPDATE plot_payment_allocations ppa SET allocated_amount=data.amount
           FROM UNNEST($1::bigint[],$2::numeric[]) AS data(id,amount)
          WHERE ppa.id=data.id`,
        [allocationIds, updatedPaymentAmounts],
      );

      const updatedInstallmentPaid = [];
      const updatedInstallmentStatuses = [];
      for (let index = 0; index < plan.installments.length; index += 1) {
        const installment = plan.installments[index];
        const amount = installmentAmounts[index];
        const paid = allocatedByInstallment.get(installment.id) || 0;
        const status = paid >= amount ? 'paid' : paid > 0 ? 'partially_paid' : 'pending';
        updatedInstallmentPaid.push(money(paid));
        updatedInstallmentStatuses.push(status);
      }
      await client.query(
        `UPDATE plot_installments pi
            SET amount=data.amount,paid_amount=data.paid_amount,status=data.status,updated_at=NOW()
           FROM UNNEST($1::bigint[],$2::numeric[],$3::numeric[],$4::varchar[]) AS data(id,amount,paid_amount,status)
          WHERE pi.id=data.id`,
        [installmentIds, updatedInstallmentAmounts, updatedInstallmentPaid, updatedInstallmentStatuses],
      );

      const snapshot = {
        ...asJson(plan.commercial_snapshot),
        base_price: money(plan.targetPrice),
        charges: '0.00',
        discount_amount: '0.00',
        final_consideration: money(plan.targetPrice),
        price_version: 'DEMO-PORTFOLIO-52CR',
      };
      const financialStatus = plan.targetCollected === plan.targetPrice ? 'SETTLED' : 'PARTIALLY_COLLECTED';
      await client.query(
        `UPDATE bookings
            SET sale_price=$1,base_price=$1,final_consideration=$1,commercial_snapshot=$2,
                price_version='DEMO-PORTFOLIO-52CR',updated_at=NOW()
          WHERE id=$3`,
        [money(plan.targetPrice), snapshot, plan.id],
      );
      await client.query(
        `UPDATE plots
            SET sale_price=$1,to_receive_bank=$2,financial_status=$3,updated_at=NOW()
          WHERE id=$4 AND site_id=$5`,
        [money(plan.targetPrice), money(Math.round(plan.targetPrice * 0.78)), financialStatus, plan.plot_id, SITE_ID],
      );
      await client.query(
        `UPDATE booking_agreements SET commercial_snapshot=$1,updated_at=NOW() WHERE booking_id=$2`,
        [snapshot, plan.id],
      );
    }

    const { rows: checkRows } = await client.query(
      `SELECT
         COALESCE(SUM(GREATEST(COALESCE(b.final_consideration,p.sale_price,0)-COALESCE(receipts.total,0),0)),0) AS outstanding,
         COALESCE(SUM(COALESCE(receipts.total,0)),0) AS collected
       FROM plots p
       JOIN bookings b ON b.id=p.current_booking_id AND b.site_id=p.site_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(pp.amount),0) AS total
           FROM plot_payments pp
          WHERE pp.booking_id=b.id
            AND LOWER(COALESCE(pp.status,'approved'))='approved'
            AND UPPER(COALESCE(pp.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
       ) receipts ON TRUE
      WHERE p.site_id=$1`,
      [SITE_ID],
    );
    const outstanding = cents(checkRows[0]?.outstanding);
    const collected = cents(checkRows[0]?.collected);
    if (outstanding !== TARGET_RECEIVABLE_CENTS || collected !== TARGET_COLLECTED_CENTS) {
      throw new Error(`Target mismatch: outstanding ${money(outstanding)}, collected ${money(collected)}.`);
    }

    await client.query(DRY_RUN ? 'ROLLBACK' : 'COMMIT');
    console.log(`${DRY_RUN ? 'Validated' : 'Updated'} Customer Inventory portfolio:`, JSON.stringify({
      demo_bookings: bookingPlans.length,
      visible_outstanding: money(outstanding),
      approved_plot_collections: money(collected),
      total_portfolio: money(outstanding + collected),
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

normalize()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error('Customer Inventory portfolio normalisation failed:', error.message);
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
