import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isEligibleReraBankEntry,
  projectPhaseRequired,
  reraFinanceRequestFingerprint,
} from '../src/services/reraProjectFinancePolicy.service.js';

test('RERA bank evidence accepts only approved, non-cash and unbounced entries', () => {
  for (const paymentMode of ['bank', 'UPI', 'NEFT', 'cheque', '', 'cashless transfer']) {
    assert.equal(isEligibleReraBankEntry({
      status: 'APPROVED', payment_mode: paymentMode, cheque_status: null,
    }), true, `${paymentMode || 'blank'} is a bank-book mode`);
  }
  assert.equal(isEligibleReraBankEntry({
    status: 'approved', payment_mode: 'cheque', cheque_status: 'PENDING',
  }), true, 'approval plus an unbounced cheque is eligible');
  assert.equal(isEligibleReraBankEntry({
    status: 'approved', payment_mode: 'cash', cheque_status: null,
  }), false);
  assert.equal(isEligibleReraBankEntry({
    status: 'approved', payment_mode: 'CASH - OFFICE', cheque_status: null,
  }), false);
  assert.equal(isEligibleReraBankEntry({
    status: 'pending', payment_mode: 'bank', cheque_status: null,
  }), false);
  assert.equal(isEligibleReraBankEntry({
    status: 'rejected', payment_mode: 'bank', cheque_status: null,
  }), false);
  assert.equal(isEligibleReraBankEntry({
    status: 'approved', payment_mode: 'bank', cheque_status: 'BOUNCED',
  }), false);
  assert.equal(isEligibleReraBankEntry({
    status: 'approved', payment_mode: 'bank', cheque_status: 'returned',
  }), false);
});

test('RERA request fingerprints replay only an identical canonical payload', () => {
  const original = reraFinanceRequestFingerprint('RERA_DEPOSIT', [11, 12, '100.00', '2026-08-14']);
  const replay = reraFinanceRequestFingerprint('RERA_DEPOSIT', [11, 12, '100.00', '2026-08-14']);
  const changedAmount = reraFinanceRequestFingerprint('RERA_DEPOSIT', [11, 12, '101.00', '2026-08-14']);
  const changedKind = reraFinanceRequestFingerprint('RERA_WITHDRAWAL', [11, 12, '100.00', '2026-08-14']);
  assert.match(original, /^[0-9a-f]{64}$/);
  assert.equal(replay, original);
  assert.notEqual(changedAmount, original);
  assert.notEqual(changedKind, original);
});

test('a phase is mandatory only when the project has active phases', () => {
  assert.equal(projectPhaseRequired({ has_phases: true }, null), true);
  assert.equal(projectPhaseRequired({ has_phases: true }, undefined), true);
  assert.equal(projectPhaseRequired({ has_phases: true }, 7), false);
  assert.equal(projectPhaseRequired({ has_phases: false }, null), false);
  assert.equal(projectPhaseRequired(null, null), false);
});
