import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOccurrences, calculateDueDate, calculateRisk, dateKey, isTransitionAllowed,
  mandatoryChecklistBlockers, notificationDedupeKey, reminderDecision,
} from '../src/services/complianceEngine.service.js';

test('fixed day clamps to the last day of a short month', () => {
  assert.equal(dateKey(calculateDueDate({ type: 'FIXED_DAY_OF_MONTH', day: 31 }, '2026-02-01')), '2026-02-28');
});

test('quarter rule calculates from quarter end', () => {
  assert.equal(dateKey(calculateDueDate({ type: 'DAYS_AFTER_QUARTER_END', days: 15 }, '2026-04-01')), '2026-07-15');
});

test('recurring generation is deterministic and bounded by through date', () => {
  const rows = buildOccurrences({
    frequency: 'MONTHLY',
    startDate: '2026-01-01',
    dueDateRule: { type: 'DAYS_AFTER_MONTH_END', days: 7 },
    throughDate: '2026-03-31',
  });
  assert.deepEqual(rows.map((row) => row.dueDate), ['2026-02-07', '2026-03-07']);
  assert.deepEqual(rows.map((row) => row.periodKey), ['2026-01-01', '2026-02-01']);
});

test('invalid workflow jumps are rejected', () => {
  assert.equal(isTransitionAllowed('DRAFT', 'COMPLETED'), false);
  assert.equal(isTransitionAllowed('SUBMITTED', 'UNDER_REVIEW'), true);
});

test('overdue and high exposure items become critical', () => {
  assert.equal(calculateRisk({
    dueDate: '2026-01-01', status: 'IN_PROGRESS', today: new Date('2026-01-10T00:00:00Z'),
  }), 'CRITICAL');
  assert.equal(calculateRisk({
    dueDate: '2026-12-01', financialImpact: 12000000, status: 'IN_PROGRESS', today: new Date('2026-01-01T00:00:00Z'),
  }), 'CRITICAL');
});

test('invalid dates and missing event dates fail closed', () => {
  assert.throws(() => calculateDueDate({ type: 'MANUAL' }, '2026-02-30'), /valid period start/i);
  assert.throws(() => calculateDueDate({ type: 'DAYS_AFTER_EVENT', days: 10 }, '2026-01-01'), /event date/i);
});

test('recurrence is bounded to prevent runaway generation', () => {
  const rows = buildOccurrences({
    frequency: 'MONTHLY',
    startDate: '2020-01-01',
    dueDateRule: { type: 'MANUAL' },
    throughDate: '2040-01-01',
    maxOccurrences: 12,
  });
  assert.equal(rows.length, 12);
});

test('custom workflow cannot grant an unknown target status', () => {
  assert.equal(isTransitionAllowed('DRAFT', 'SECRET_STATE', { DRAFT: ['SECRET_STATE'] }), false);
  assert.equal(isTransitionAllowed('DRAFT', 'IN_PROGRESS', { DRAFT: ['IN_PROGRESS'] }), true);
});

test('mandatory checklist blockers ignore optional and completed work', () => {
  const blockers = mandatoryChecklistBlockers([
    { is_mandatory: true, status: 'PENDING', title: 'Proof' },
    { is_mandatory: false, status: 'PENDING', title: 'Optional note' },
    { is_mandatory: true, status: 'COMPLETED', title: 'Return' },
  ]);
  assert.deepEqual(blockers.map((row) => row.title), ['Proof']);
});

test('reminders fire only on configured due and escalation offsets', () => {
  assert.deepEqual(reminderDecision({
    dueDate: '2026-07-31', today: '2026-07-24', reminderDays: [30, 15, 7, 1, 0],
  }), { daysRemaining: 7, notificationType: 'DUE_7' });
  assert.deepEqual(reminderDecision({
    dueDate: '2026-07-20', today: '2026-07-23', overdueDays: [1, 3, 7],
  }), { daysRemaining: -3, notificationType: 'OVERDUE_3' });
  assert.equal(reminderDecision({
    dueDate: '2026-07-31', today: '2026-07-25', reminderDays: [7],
  }), null);
});

test('notification dedupe key is stable and channel-sensitive', () => {
  const base = {
    organizationId: 9, entityType: 'compliance', entityId: 22,
    recipientUserId: 4, notificationType: 'due_7', scheduledFor: '2026-07-25',
  };
  assert.equal(notificationDedupeKey({ ...base, channel: 'email' }), notificationDedupeKey({ ...base, channel: 'EMAIL' }));
  assert.notEqual(notificationDedupeKey({ ...base, channel: 'EMAIL' }), notificationDedupeKey({ ...base, channel: 'SMS' }));
});

test('terminal records keep their reviewed risk', () => {
  assert.equal(calculateRisk({
    dueDate: '2020-01-01', status: 'COMPLETED', currentRisk: 'LOW', today: new Date('2026-01-01T00:00:00Z'),
  }), 'LOW');
});
