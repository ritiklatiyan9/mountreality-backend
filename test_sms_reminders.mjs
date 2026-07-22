/**
 * Self-check for payment-reminder SMS selection + config parsing.
 * Pure logic, no DB, no AWS:  node test_sms_reminders.mjs
 */
import assert from 'node:assert';
import { normaliseConfig, selectDueReminders, smsText, SMS_DEFAULTS } from './src/services/smsReminder.service.js';

// ── config parsing ──
const cfg = normaliseConfig({ enabled: 'true', days_before: '7, 3, 1, 3, 999, abc, -2', send_hour: '9' });
assert.deepEqual(cfg.days_before, [7, 3, 1], 'dedupes, drops out-of-range/garbage, sorts desc');
assert.equal(cfg.enabled, true);
assert.equal(cfg.send_hour, 9);
assert.equal(normaliseConfig({ send_hour: 26 }).send_hour, SMS_DEFAULTS.send_hour, 'invalid hour falls back');
assert.equal(normaliseConfig(null).enabled, false, 'unset config is off by default');
assert.deepEqual(normaliseConfig({ days_before: [0] }).days_before, [0], '0 = on the due date is valid');

// ── who gets a message today ──
const reminders = [
  { type: 'upcoming', days_until: 7, plot_id: 1 },
  { type: 'upcoming', days_until: 5, plot_id: 2 },   // not a configured lead day
  { type: 'upcoming', days_until: 1, plot_id: 3 },
  { type: 'overdue', days_overdue: 3, plot_id: 4 },
  { type: 'overdue', days_overdue: 4, plot_id: 5 },  // not a configured day
  { type: 'inactive', plot_id: 6 },                  // never SMS-ed
  { type: 'slow_payer', plot_id: 7 },
];
const picked = selectDueReminders(reminders, cfg).map((r) => r.plot_id);
assert.deepEqual(picked, [1, 3, 4], 'only exact lead/overdue days, only due-date types');

const noOverdue = selectDueReminders(reminders, { ...cfg, include_overdue: false }).map((r) => r.plot_id);
assert.deepEqual(noOverdue, [1, 3], 'overdue can be switched off');

// ── message body ──
const upcoming = smsText({ type: 'upcoming', buyer_name: 'ASHA RANI', plot_no: 'A-12', amount_due: 150000, due_date: '2026-08-01', days_until: 3 }, 'Defence Garden');
assert.ok(upcoming.includes('A-12') && upcoming.includes('Rs.1,50,000') && upcoming.includes('in 3 day'), upcoming);
const overdue = smsText({ type: 'overdue', buyer_name: 'ASHA RANI', plot_no: 'A-12', amount_due: 5000, due_date: '2026-07-01', days_overdue: 19 }, 'Defence Garden');
assert.ok(overdue.includes('19 day(s) overdue'), overdue);
assert.ok(!/[₹]/.test(upcoming + overdue), 'no non-GSM characters — keeps SMS to one segment');

console.log('✓ sms reminder selection checks passed');
