import pool from '../config/db.js';
import applicationSettingModel from '../models/ApplicationSetting.model.js';
import { buildPaymentReminders } from '../controllers/installment.controller.js';
import { normalisePhone } from '../utils/notify.js';
import { enqueueSms, isSmsQueueConfigured } from '../utils/sqs.js';

/**
 * Payment-reminder SMS: picks the plots due (or overdue) by exactly the number
 * of days an admin configured in Settings, resolves the buyer's phone, and
 * pushes one job per recipient onto SQS. Delivery happens in the worker
 * (src/workers/smsWorker.js) — this side never talks to an SMS provider.
 */

export const SMS_SETTING_KEY = 'payment_sms_reminders';

export const SMS_DEFAULTS = Object.freeze({
  enabled: false,
  days_before: [7, 3, 1],   // remind this many days BEFORE an installment is due
  include_overdue: true,    // …and the same number of days AFTER it went overdue
  send_hour: 10,            // IST hour of day for the automatic run
});

/** Coerce whatever is stored/posted into a valid config. */
export const normaliseConfig = (raw) => {
  const cfg = { ...SMS_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const days = Array.isArray(cfg.days_before) ? cfg.days_before : String(cfg.days_before || '').split(',');
  cfg.days_before = [...new Set(
    days.map((d) => parseInt(d, 10)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 90)
  )].sort((a, b) => b - a);
  cfg.enabled = Boolean(cfg.enabled);
  cfg.include_overdue = Boolean(cfg.include_overdue);
  const hour = parseInt(cfg.send_hour, 10);
  cfg.send_hour = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : SMS_DEFAULTS.send_hour;
  return cfg;
};

export const getConfig = async (siteId) =>
  normaliseConfig(await applicationSettingModel.getJson(siteId, SMS_SETTING_KEY, null));

export const saveConfig = async (siteId, raw, userId) => {
  const cfg = normaliseConfig(raw);
  await applicationSettingModel.setJson(siteId, SMS_SETTING_KEY, cfg, userId);
  return cfg;
};

const rupees = (n) => `Rs.${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const dateStr = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '');

/** The SMS body. Kept short — one segment where possible. */
export const smsText = (r, siteName) =>
  r.type === 'overdue'
    ? `Dear ${r.buyer_name || 'Customer'}, your payment of ${rupees(r.amount_due)} for Plot ${r.plot_no} was due on ${dateStr(r.due_date)} and is ${r.days_overdue} day(s) overdue. Please pay at the earliest. - ${siteName}`
    : `Dear ${r.buyer_name || 'Customer'}, a payment of ${rupees(r.amount_due)} for Plot ${r.plot_no} is due on ${dateStr(r.due_date)}${r.days_until === 0 ? ' (today)' : ` (in ${r.days_until} day(s))`}. - ${siteName}`;

/**
 * Reminders that should go out today for this config: installments due in
 * exactly one of the configured lead days, and (optionally) overdue by exactly
 * one of them — so a customer isn't texted every single day.
 */
export const selectDueReminders = (reminders, cfg) => {
  const days = new Set(cfg.days_before);
  return reminders.filter((r) => {
    if (r.type === 'upcoming') return days.has(r.days_until);
    if (r.type === 'overdue') return cfg.include_overdue && days.has(r.days_overdue);
    return false;
  });
};

/** Resolve buyer phones the same way the WhatsApp receipt notifier does. */
const phonesForPlots = async (siteId, plotIds) => {
  if (!plotIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT p.id AS plot_id, m.whatsapp, m.phone, m.alt_phone
       FROM plots p
       LEFT JOIN LATERAL (
         SELECT whatsapp, phone, alt_phone FROM members
          WHERE site_id = p.site_id AND UPPER(TRIM(full_name)) = UPPER(TRIM(p.buyer_name))
          ORDER BY id LIMIT 1
       ) m ON TRUE
      WHERE p.id = ANY($1)`,
    [plotIds]
  );
  const map = new Map();
  for (const row of rows) {
    const phone = normalisePhone(row.phone || row.whatsapp || row.alt_phone);
    if (phone) map.set(row.plot_id, phone);
  }
  return map;
};

/**
 * Queue reminder SMS for a site.
 * `source` 'auto' dedupes per reminder per day; 'manual' always sends.
 * Returns { queued, skipped, no_phone, failed, total }.
 */
export const queueRemindersForSite = async (siteId, { source = 'auto', userId = null, reminders = null } = {}) => {
  const cfg = await getConfig(siteId);
  if (source === 'auto' && !cfg.enabled) return { queued: 0, skipped: 0, no_phone: 0, failed: 0, total: 0, reason: 'disabled' };
  if (!isSmsQueueConfigured()) throw new Error('AWS_SMS_QUEUE_URL is not configured — cannot queue SMS');

  const { rows: [site] } = await pool.query('SELECT name FROM sites WHERE id = $1', [siteId]);
  const all = reminders || (await buildPaymentReminders(siteId));
  const due = selectDueReminders(all, cfg);
  if (!due.length) return { queued: 0, skipped: 0, no_phone: 0, failed: 0, total: 0 };

  const phones = await phonesForPlots(siteId, [...new Set(due.map((r) => r.plot_id))]);
  const today = new Date().toISOString().slice(0, 10);

  let noPhone = 0, skipped = 0, failed = 0;
  const jobs = [];
  const logIds = [];

  for (const r of due) {
    const phone = phones.get(r.plot_id);
    if (!phone) { noPhone++; continue; }
    const message = smsText(r, site?.name || 'Defence Garden');
    // Auto runs dedupe on (plot, installment, type, day); manual is always unique.
    const dedupeKey = source === 'manual'
      ? `manual:${r.plot_id}:${r.type}:${Date.now()}:${jobs.length}`
      : `${r.plot_id}:${r.installment_name || '-'}:${r.type}:${today}`;

    const { rows } = await pool.query(
      `INSERT INTO sms_reminder_log (site_id, plot_id, dedupe_key, phone, reminder_type, message, source, queued_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (site_id, dedupe_key) DO NOTHING
       RETURNING id`,
      [siteId, r.plot_id, dedupeKey, phone, r.type, message, source, userId]
    );
    if (!rows[0]) { skipped++; continue; }   // already sent today
    logIds.push(rows[0].id);
    jobs.push({ log_id: rows[0].id, site_id: siteId, plot_id: r.plot_id, to: phone, message });
  }

  const { queued, failed: sendFailures } = await enqueueSms(jobs);
  // Anything SQS refused is marked failed so it isn't mistaken for delivered
  // and can be retried by a later run.
  for (const f of sendFailures) {
    failed++;
    await pool.query('UPDATE sms_reminder_log SET status = $1, error = $2 WHERE id = $3',
      ['failed', String(f.error).slice(0, 500), logIds[f.index]]);
  }

  return { queued, skipped, no_phone: noPhone, failed, total: due.length };
};

const HOUR_MS = 3600000;
let timer = null;

/** Sites whose configured send hour matches the current IST hour. */
const sitesDueNow = async () => {
  const hourNow = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false,
  }).format(new Date()));
  const { rows } = await pool.query(
    `SELECT site_id, setting_value FROM application_settings WHERE setting_key = $1`,
    [SMS_SETTING_KEY]
  );
  return rows
    .map((row) => ({ siteId: row.site_id, cfg: normaliseConfig(row.setting_value) }))
    .filter(({ cfg }) => cfg.enabled && cfg.send_hour === hourNow);
};

export const runScheduledReminders = async () => {
  if (!isSmsQueueConfigured()) return;
  for (const { siteId } of await sitesDueNow()) {
    try {
      const result = await queueRemindersForSite(siteId, { source: 'auto' });
      if (result.queued || result.failed) console.log(`[sms-reminders] site ${siteId}:`, JSON.stringify(result));
    } catch (err) {
      console.error(`[sms-reminders] site ${siteId} failed:`, err?.message || err);
    }
  }
};

/**
 * Hourly tick — the per-site `send_hour` decides who actually runs, and the
 * dedupe key makes a double tick harmless.
 * ponytail: setInterval, not a cron dep; single API instance is already assumed
 * (see cache.js). Move to a real scheduler if the API is ever scaled out.
 */
export const startSmsReminderScheduler = () => {
  if (timer || process.env.SMS_REMINDER_SCHEDULER === 'off') return;
  timer = setInterval(() => { runScheduledReminders().catch(() => {}); }, HOUR_MS);
  timer.unref?.();
  console.log('[sms-reminders] hourly scheduler started');
};
