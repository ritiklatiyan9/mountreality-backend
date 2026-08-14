import 'dotenv/config';
import pool from '../config/db.js';

/*
 * Normalises the visible Diwan Valley demo farmer records to a ₹45 lakh
 * per-bigha land rate. It intentionally targets only records created by the
 * demo/historical seeds, never unrelated farmer data.
 *
 * Usage:
 *   node src/scripts/normalizeDemoFarmerPayments.js --dry-run
 *   node src/scripts/normalizeDemoFarmerPayments.js
 */

const SITE_ID = 5;
const RATE_PER_BIGHA = 4_500_000;
const DRY_RUN = process.argv.includes('--dry-run');

// The requested ceiling is 60%. Varying the positions makes the demo list
// look like a real acquisition register while keeping every record at or
// below that ceiling.
const PAID_PERCENTAGES = new Map([
  ['DEMO FARMER - RAJENDRA PAL', 0.60],
  ['DEMO FARMER - SUNITA DEVI', 0.55],
  ['DEMO FARMER - MAHESH KUMAR', 0.60],
  ['BALDEV SINGH', 0.58],
  ['SHANTI DEVI', 0.52],
  ['MOHAN LAL', 0.60],
  ['KAVITA SHARMA', 0.48],
]);

const toCents = (value) => Math.round(Number(value || 0) * 100);
const fromCents = (value) => (value / 100).toFixed(2);

const allocateCents = (total, weights) => {
  const safeWeights = weights.map((weight) => Math.max(0, Number(weight) || 0));
  const denominator = safeWeights.reduce((sum, value) => sum + value, 0) || safeWeights.length;
  let assigned = 0;
  return safeWeights.map((weight, index) => {
    const amount = index === safeWeights.length - 1
      ? total - assigned
      : Math.round(total * ((denominator ? weight : 1) / denominator));
    assigned += amount;
    return amount;
  });
};

const splitPaymentLegs = (payment, amountCents) => {
  const mode = String(payment.payment_mode || 'BANK').toUpperCase();
  if (mode === 'CASH') return { cash: amountCents, bank: 0 };
  if (mode !== 'SPLIT') return { cash: 0, bank: amountCents };

  const originalAmount = toCents(payment.amount);
  const originalCash = toCents(payment.cash_amount);
  const cash = originalAmount > 0
    ? Math.round(amountCents * (originalCash / originalAmount))
    : Math.round(amountCents / 2);
  return { cash, bank: amountCents - cash };
};

async function normalize() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: farmers } = await client.query(
      `SELECT f.id,f.name,f.land_size_bigha,f.notes
         FROM farmers f
        WHERE f.site_id=$1
          AND (f.notes LIKE 'DEMO SEED | Landowner payment schedule%'
            OR f.notes LIKE 'Historic land-acquisition record for Diwan City.%')
        ORDER BY f.id
        FOR UPDATE`,
      [SITE_ID],
    );

    if (farmers.length !== PAID_PERCENTAGES.size) {
      throw new Error(`Expected ${PAID_PERCENTAGES.size} demo farmers but found ${farmers.length}. No changes were made.`);
    }

    const summary = [];
    for (const farmer of farmers) {
      const paidPercent = PAID_PERCENTAGES.get(farmer.name);
      if (paidPercent == null) throw new Error(`Unexpected demo farmer: ${farmer.name}`);

      const landSize = Number(farmer.land_size_bigha || 0);
      if (!(landSize > 0)) throw new Error(`${farmer.name} does not have a valid bigha value.`);
      const totalCents = Math.round(landSize * RATE_PER_BIGHA * 100);
      const paidCents = Math.round(totalCents * paidPercent);

      const { rows: payments } = await client.query(
        `SELECT id,amount,payment_mode,cash_amount,bank_amount
           FROM farmer_payments
          WHERE farmer_id=$1
            AND LOWER(COALESCE(status,'approved'))='approved'
            AND UPPER(COALESCE(cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
          ORDER BY date,id
          FOR UPDATE`,
        [farmer.id],
      );
      if (!payments.length) throw new Error(`${farmer.name} has no approved payments to normalise.`);

      const paymentAmounts = allocateCents(paidCents, payments.map((payment) => toCents(payment.amount)));
      let cashCents = 0;
      let bankCents = 0;
      for (let index = 0; index < payments.length; index += 1) {
        const payment = payments[index];
        const amount = paymentAmounts[index];
        const legs = splitPaymentLegs(payment, amount);
        cashCents += legs.cash;
        bankCents += legs.bank;
        await client.query(
          `UPDATE farmer_payments
              SET amount=$1,cash_amount=$2,bank_amount=$3,updated_at=NOW()
            WHERE id=$4`,
          [fromCents(amount), fromCents(legs.cash), fromCents(legs.bank), payment.id],
        );
      }

      await client.query(
        `UPDATE farmers
            SET land_rate=$1,total_amount=$2,cash_amount=$3,bank_amount=$4,
                notes=CASE WHEN notes LIKE '%₹45 lakh per bigha%' THEN notes
                           ELSE CONCAT(COALESCE(notes,''),' | ₹45 lakh per bigha demo value; payments capped at 60%.') END,
                updated_at=NOW()
          WHERE id=$5 AND site_id=$6`,
        [RATE_PER_BIGHA, fromCents(totalCents), fromCents(cashCents), fromCents(bankCents), farmer.id, SITE_ID],
      );

      summary.push({
        farmer: farmer.name,
        bigha: landSize,
        committed: Number(fromCents(totalCents)),
        paid: Number(fromCents(paidCents)),
        paid_percent: Math.round(paidPercent * 100),
        payments: payments.length,
      });
    }

    await client.query(DRY_RUN ? 'ROLLBACK' : 'COMMIT');
    console.log(`${DRY_RUN ? 'Validated' : 'Updated'} demo farmer payment values:`, JSON.stringify(summary));
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
    console.error('Demo farmer payment normalisation failed:', error.message);
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
