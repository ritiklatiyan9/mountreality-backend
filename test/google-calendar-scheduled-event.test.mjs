import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEventBody, SOURCES } from '../src/services/googleCalendarSync.service.js';

test('dashboard scheduled events are registered as Google Calendar sources', () => {
  assert.deepEqual(SOURCES.SCHEDULED_EVENT, {
    table: 'scheduled_events',
    titleField: 'title',
    dateField: 'event_date',
    timeField: 'event_time',
    descriptionField: 'description',
    timed: false,
  });
});

test('scheduled event with a time creates a one-hour IST calendar invitation', () => {
  const body = buildEventBody('SCHEDULED_EVENT', {
    title: 'Monthly project review',
    description: 'Review collections and pending approvals.',
    event_date: '2026-08-20',
    event_time: '09:30:00',
    priority: 'HIGH',
    status: 'SCHEDULED',
  }, ['finance@example.com']);

  assert.equal(body.summary, 'Monthly project review');
  assert.equal(body.start.dateTime, '2026-08-20T04:00:00.000Z');
  assert.equal(body.end.dateTime, '2026-08-20T05:00:00.000Z');
  assert.equal(body.start.timeZone, 'Asia/Kolkata');
  assert.deepEqual(body.attendees, [{ email: 'finance@example.com' }]);
  assert.deepEqual(body.reminders, {
    useDefault: false,
    overrides: [
      { method: 'popup', minutes: 1440 },
      { method: 'popup', minutes: 30 },
    ],
  });
  assert.match(body.description, /Priority: HIGH/);
  assert.match(body.description, /Review collections/);
});

test('scheduled event without a time remains an all-day invitation', () => {
  const body = buildEventBody('SCHEDULED_EVENT', {
    title: 'Document submission',
    event_date: '2026-08-31',
    event_time: null,
  });

  assert.deepEqual(body.start, { date: '2026-08-31' });
  assert.deepEqual(body.end, { date: '2026-09-01' });
  assert.deepEqual(body.reminders, {
    useDefault: false,
    overrides: [
      { method: 'popup', minutes: 1440 },
      { method: 'popup', minutes: 0 },
    ],
  });
});

test('timed events carry distinct one-day, on-day and 30-minute phone reminders', () => {
  const body = buildEventBody('SCHEDULED_EVENT', {
    title: 'Site coordination',
    event_date: '2026-08-21',
    event_time: '10:30:00',
  });

  assert.deepEqual(body.reminders.overrides, [
    { method: 'popup', minutes: 1440 },
    { method: 'popup', minutes: 90 },
    { method: 'popup', minutes: 30 },
  ]);
});
