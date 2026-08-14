// Sanity check for Google Calendar sync building blocks — no network, no DB writes.
// Run: node check_google_calendar_sync.mjs
import assert from 'assert';

process.env.CALENDAR_TOKEN_ENC_KEY ||= 'a'.repeat(64); // 32-byte hex test key

const { encrypt, decrypt } = await import('./src/utils/tokenCrypto.js');
const { buildEventBody, SOURCES } = await import('./src/services/googleCalendarSync.service.js');

// tokenCrypto round-trip + tamper rejection
const secret = 'ya29.test-token-value';
const packed = encrypt(secret);
assert.strictEqual(decrypt(packed), secret, 'decrypt must invert encrypt');
assert.notStrictEqual(encrypt(secret), packed, 'iv must differ per call');
assert.throws(() => decrypt(Buffer.from('tampered' + packed, 'utf8').toString('base64')), 'tampered ciphertext must fail auth');

// All-day event: date string passes through, end date is exclusive (+1 day)
const allDay = buildEventBody('COMPLIANCE', {
  title: 'GST return', current_due_date: '2026-08-20', status: 'PENDING', risk_level: 'HIGH',
}, ['a@x.com', 'b@x.com']);
assert.strictEqual(allDay.start.date, '2026-08-20');
assert.strictEqual(allDay.end.date, '2026-08-21', 'all-day end must be next day (Google exclusive end)');
assert.strictEqual(allDay.summary, 'GST return');
assert.deepStrictEqual(allDay.attendees, [{ email: 'a@x.com' }, { email: 'b@x.com' }]);
assert.ok(allDay.description.includes('Status: PENDING') && allDay.description.includes('Risk: HIGH'));

// All-day from a Date object (pg returns DATE columns as Date at local midnight)
const fromDate = buildEventBody('LICENCE_EXPIRY', { name: 'Trade licence', expiry_date: new Date(2026, 11, 31) }, []);
assert.strictEqual(fromDate.start.date, '2026-12-31', 'local Date must not shift a day via UTC conversion');

// Timed event: 1-hour duration, app timezone
const hearing = new Date('2026-09-01T05:30:00.000Z'); // 11:00 IST
const timed = buildEventBody('LEGAL_HEARING', { title: 'XYZ vs State', next_hearing_date: hearing, status: 'OPEN' }, []);
assert.strictEqual(timed.start.dateTime, hearing.toISOString());
assert.strictEqual(new Date(timed.end.dateTime) - new Date(timed.start.dateTime), 3600000, 'timed events default to 1 hour');
assert.strictEqual(timed.start.timeZone, 'Asia/Kolkata');

// Every event type maps to a real source table config
for (const type of ['COMPLIANCE', 'LEGAL_HEARING', 'NOTICE_REPLY', 'INSPECTION', 'LICENCE_EXPIRY']) {
  assert.ok(SOURCES[type]?.table && SOURCES[type]?.dateField, `SOURCES missing ${type}`);
}

console.log('✓ google calendar sync sanity checks passed');
process.exit(0);
