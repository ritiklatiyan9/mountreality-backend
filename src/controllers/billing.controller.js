import crypto from 'crypto';
import Razorpay from 'razorpay';
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { sendPlanPurchaseEmail, sendOwnerNotificationEmail } from '../utils/mailer.js';

const PERIOD_DAYS = { monthly: 30, annual: 365 };
const ANNUAL_DISCOUNT_PERCENT = 15;

const normalizeBillingCycle = (value) => value === 'annual' ? 'annual' : 'monthly';
const billedAmount = (price, billingCycle) => billingCycle === 'annual'
  ? Math.round(Number(price) * 12 * (1 - ANNUAL_DISCOUNT_PERCENT / 100))
  : Number(price);

let razorpayClient = null;
const razorpay = () => {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return null;
  if (!razorpayClient) {
    razorpayClient = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return razorpayClient;
};

/** GET /billing/plans — public (signup page shows pricing before login) */
export const listPlans = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, code, name, price_inr, site_limit, features, max_users FROM plans WHERE is_active = true ORDER BY price_inr ASC'
  );
  res.json({ plans: rows });
});

/** GET /billing/subscription — current org's plan, validity and site usage */
export const getSubscription = asyncHandler(async (req, res) => {
  const orgId = req.user.organization_id;
  if (!orgId) return res.status(400).json({ message: 'No organization linked to this account' });

  const { rows } = await pool.query(
    // Read billing_cycle through the row JSON instead of a direct column
    // reference. This keeps the account page available on deployments that
    // have the subscriptions table but have not yet applied the additive
    // annual-billing column migration; once present, its real value is used.
    `SELECT s.id, s.status, COALESCE(to_jsonb(s)->>'billing_cycle', 'monthly') AS billing_cycle,
            s.amount_inr, s.current_period_start, s.current_period_end, s.created_at,
            p.id AS plan_id, p.code AS plan_code, p.name AS plan_name, p.price_inr, p.site_limit
     FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id
     WHERE s.organization_id = $1 AND s.status = 'active' AND s.current_period_end > NOW()
     ORDER BY s.current_period_end DESC
     LIMIT 1`,
    [orgId]
  );

  const { rows: usage } = await pool.query('SELECT COUNT(*)::int AS sites_used FROM sites WHERE organization_id = $1', [orgId]);
  const { rows: org } = await pool.query('SELECT name FROM organizations WHERE id = $1', [orgId]);

  res.json({
    organization: org[0]?.name || null,
    subscription: rows[0] || null,
    sites_used: usage[0].sites_used,
  });
});

/**
 * POST /billing/order — body { plan_id, billing_cycle?: 'monthly' | 'annual' }.
 * Creates a Razorpay order and a matching 'pending' subscription row; the row is
 * activated only after signature verification in /billing/verify.
 */
export const createOrder = asyncHandler(async (req, res) => {
  const client = razorpay();
  if (!client) return res.status(503).json({ message: 'Payments are not configured on this server (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing)' });

  const orgId = req.user.organization_id;
  if (!orgId) return res.status(400).json({ message: 'No organization linked to this account' });

  const planId = parseInt(req.body.plan_id, 10);
  const billingCycle = normalizeBillingCycle(req.body.billing_cycle);
  const { rows: plans } = await pool.query('SELECT * FROM plans WHERE id = $1', [planId]);
  const plan = plans[0];
  if (!plan) return res.status(400).json({ message: 'Invalid plan' });

  const amountInr = billedAmount(plan.price_inr, billingCycle);
  const order = await client.orders.create({
    amount: amountInr * 100, // paise
    currency: 'INR',
    receipt: `org-${orgId}-${Date.now()}`,
    notes: { organization_id: String(orgId), plan_code: plan.code, billing_cycle: billingCycle, annual_discount_percent: billingCycle === 'annual' ? String(ANNUAL_DISCOUNT_PERCENT) : '0' },
  });

  await pool.query(
    `INSERT INTO subscriptions (organization_id, plan_id, status, razorpay_order_id, amount_inr, billing_cycle)
     VALUES ($1, $2, 'pending', $3, $4, $5)`,
    [orgId, plan.id, order.id, amountInr, billingCycle]
  );

  res.json({
    order_id: order.id,
    amount: order.amount,
    currency: order.currency,
    key_id: process.env.RAZORPAY_KEY_ID,
    plan: { id: plan.id, name: plan.name, price_inr: plan.price_inr, site_limit: plan.site_limit },
    billing_cycle: billingCycle,
    billed_amount_inr: amountInr,
    discount_percent: billingCycle === 'annual' ? ANNUAL_DISCOUNT_PERCENT : 0,
    term_days: PERIOD_DAYS[billingCycle],
  });
});

/**
 * POST /billing/verify — body { razorpay_order_id, razorpay_payment_id, razorpay_signature }.
 * Verifies Razorpay's HMAC and activates the pending subscription for its paid term.
 * Renewals stack: the new period starts when the current active period ends.
 */
export const verifyPayment = asyncHandler(async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ message: 'Missing payment verification fields' });
  }

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const suppliedBuffer = /^[a-f0-9]{64}$/i.test(String(razorpay_signature))
    ? Buffer.from(String(razorpay_signature), 'hex')
    : Buffer.alloc(0);
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    return res.status(400).json({ message: 'Payment verification failed' });
  }

  const orgId = req.user.organization_id;
  const { rows: candidateRows } = await pool.query(
    `SELECT id,billing_cycle,amount_inr,status,razorpay_payment_id FROM subscriptions
     WHERE razorpay_order_id = $1 AND organization_id = $2
     LIMIT 1`,
    [razorpay_order_id, orgId]
  );
  const candidate = candidateRows[0];
  if (!candidate) return res.status(404).json({ message: 'Subscription order not found' });
  if (candidate.status === 'active' && candidate.razorpay_payment_id === razorpay_payment_id) {
    return res.json({ message: 'Subscription already activated', subscription: candidate, idempotent: true });
  }
  if (candidate.status !== 'pending') return res.status(409).json({ message: 'Subscription order is no longer pending' });

  const paymentClient = razorpay();
  if (!paymentClient) return res.status(503).json({ message: 'Payments are not configured on this server' });
  let payment;
  try {
    payment = await paymentClient.payments.fetch(razorpay_payment_id);
  } catch (error) {
    console.error('[billing] provider payment verification failed:', error.message);
    return res.status(502).json({ message: 'Payment provider verification is temporarily unavailable' });
  }
  const expectedPaise = Math.round(Number(candidate.amount_inr) * 100);
  if (payment.order_id !== razorpay_order_id
    || Number(payment.amount) !== expectedPaise
    || payment.currency !== 'INR'
    || payment.status !== 'captured') {
    return res.status(409).json({ message: 'Payment amount, currency or capture status does not match this order' });
  }

  const billingCycle = normalizeBillingCycle(candidate.billing_cycle);
  const client = await pool.connect();
  let activated;
  let newlyActivated = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1,$2)', [42045, Number(orgId)]);
    const locked = await client.query(
      `SELECT * FROM subscriptions WHERE id=$1 AND organization_id=$2 FOR UPDATE`,
      [candidate.id, orgId]
    );
    const current = locked.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Subscription order not found' });
    }
    if (current.status === 'active' && current.razorpay_payment_id === razorpay_payment_id) {
      await client.query('COMMIT');
      return res.json({ message: 'Subscription already activated', subscription: current, idempotent: true });
    }
    if (current.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Subscription order is no longer pending' });
    }
    const { rows } = await client.query(
      `WITH periods AS (
         SELECT GREATEST(NOW(),COALESCE(MAX(current_period_end),NOW())) AS start
           FROM subscriptions
          WHERE organization_id=$3 AND status='active' AND id<>$2
       )
       UPDATE subscriptions
          SET status='active',razorpay_payment_id=$1,
              current_period_start=periods.start,
              current_period_end=periods.start+($4 || ' days')::interval
         FROM periods
        WHERE subscriptions.id=$2 AND subscriptions.organization_id=$3
          AND subscriptions.status='pending'
       RETURNING subscriptions.*`,
      [razorpay_payment_id, candidate.id, orgId, PERIOD_DAYS[billingCycle]]
    );
    activated = rows[0];
    if (!activated) throw new Error('Subscription activation lost its pending state');
    newlyActivated = true;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const { rows: [recipient] } = await pool.query(
    `SELECT u.name, u.email, o.id AS org_id, o.name AS org_name, o.subdomain AS org_subdomain, p.name AS plan_name
     FROM users u JOIN organizations o ON o.id = u.organization_id
     JOIN plans p ON p.id = $2 WHERE u.id = $1`,
    [req.user.id, activated.plan_id]
  );
  if (recipient && newlyActivated) {
    sendPlanPurchaseEmail({
      to: recipient.email, name: recipient.name, companyName: recipient.org_name,
      planName: recipient.plan_name, amount: activated.amount_inr, orgSubdomain: recipient.org_subdomain,
    }).catch((err) => console.error('[mailer] purchase email failed:', err.message));
    sendOwnerNotificationEmail({
      kind: 'purchase', companyName: recipient.org_name, contactName: recipient.name,
      contactEmail: recipient.email, planName: recipient.plan_name, amount: activated.amount_inr, orgId: recipient.org_id,
    }).catch((err) => console.error('[mailer] owner notify failed:', err.message));
  }

  res.json({ message: 'Subscription activated', subscription: activated });
});
