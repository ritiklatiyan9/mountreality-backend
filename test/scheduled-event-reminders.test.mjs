import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScheduledEventReminderContent } from '../src/services/scheduledEventReminder.service.js';

const event = {
  title: 'Monthly project review',
  event_date: '2026-08-20',
  calendar_event_time: '09:30 AM',
};

test('one-day calendar reminder clearly identifies tomorrow and the event time', () => {
  const content = buildScheduledEventReminderContent(event, 'ONE_DAY_BEFORE');
  assert.equal(content.pushTitle, 'Calendar reminder · Tomorrow');
  assert.match(content.message, /scheduled tomorrow at 09:30 AM/);
  assert.match(content.pushBody, /2026-08-20 at 09:30 AM/);
});

test('on-day calendar reminder clearly identifies today', () => {
  const content = buildScheduledEventReminderContent(event, 'ON_DAY');
  assert.equal(content.pushTitle, 'Calendar reminder · Today');
  assert.match(content.title, /^Event today:/);
});

test('30-minute calendar reminder clearly identifies the countdown', () => {
  const content = buildScheduledEventReminderContent(event, 'THIRTY_MINUTES_BEFORE');
  assert.equal(content.pushTitle, 'Calendar reminder · 30 minutes');
  assert.match(content.message, /starts in 30 minutes/);
});
