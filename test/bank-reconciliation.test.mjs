import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoMatchStatementLines,
  reconciliationDifference,
  reconciliationProgress,
} from '../src/services/bankReconciliation.service.js';

test('auto matches a unique ledger transaction with the same date and amount', () => {
  const [line] = autoMatchStatementLines(
    [{ transaction_date: '2026-08-03', description: 'NEFT ABC', debit: 0, credit: 12500 }],
    [{ source: 'plot-payment', id: 42, date: '2026-08-03', description: 'ABC booking', debit: 0, credit: 12500 }],
  );
  assert.equal(line.match_status, 'MATCHED');
  assert.equal(line.matched_source, 'plot-payment');
  assert.equal(line.matched_source_id, 42);
});

test('creates a suggestion for an amount posted within three days', () => {
  const [line] = autoMatchStatementLines(
    [{ transaction_date: '2026-08-06', description: 'BANK CHARGE', debit: 250, credit: 0 }],
    [{ source: 'expense', id: 9, date: '2026-08-04', description: 'Bank charge', debit: 250, credit: 0 }],
  );
  assert.equal(line.match_status, 'SUGGESTED');
  assert.equal(line.matched_source_id, 9);
});

test('never consumes a reserved or already consumed ledger transaction twice', () => {
  const rows = autoMatchStatementLines(
    [
      { transaction_date: '2026-08-03', description: 'A', debit: 0, credit: 500 },
      { transaction_date: '2026-08-03', description: 'B', debit: 0, credit: 500 },
    ],
    [{ source: 'daybook', id: 5, date: '2026-08-03', description: 'A', debit: 0, credit: 500 }],
  );
  assert.equal(rows.filter((row) => row.match_status === 'MATCHED').length, 1);
  assert.equal(rows.filter((row) => row.match_status === 'UNMATCHED').length, 1);

  const [reserved] = autoMatchStatementLines(
    [{ transaction_date: '2026-08-03', description: 'A', debit: 0, credit: 500 }],
    [{ source: 'daybook', id: 5, date: '2026-08-03', description: 'A', debit: 0, credit: 500 }],
    new Set(['daybook:5']),
  );
  assert.equal(reserved.match_status, 'UNMATCHED');
});

test('computes net difference and completion progress', () => {
  assert.equal(reconciliationDifference({ statementDebit: 100, statementCredit: 900, ledgerDebit: 150, ledgerCredit: 950 }), 0);
  assert.equal(reconciliationProgress({ matched: 8, ignored: 1, total: 10 }), 90);
});
