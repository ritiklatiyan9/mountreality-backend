const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

const isoDay = (value) => {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};

const dayDistance = (left, right) => {
  const a = isoDay(left);
  const b = isoDay(right);
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
};

const textTokens = (value) => new Set(
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token.length >= 3),
);

const textScore = (line, ledger) => {
  const left = textTokens(`${line.description || ''} ${line.reference || ''}`);
  const right = textTokens(`${ledger.description || ''} ${ledger.reference || ''}`);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  left.forEach((token) => { if (right.has(token)) overlap += 1; });
  return overlap / Math.max(left.size, right.size);
};

const sameAmountSide = (line, ledger) => (
  roundMoney(line.debit) === roundMoney(ledger.debit)
  && roundMoney(line.credit) === roundMoney(ledger.credit)
  && (roundMoney(line.debit) > 0 || roundMoney(line.credit) > 0)
);

const ledgerKey = (row) => `${row.source}:${row.id}`;

/**
 * Deterministic one-to-one matching for imported statement lines.
 * - Unique same-date/same-side/same-amount rows are matched automatically.
 * - Ambiguous or nearby (±3 day) amount matches are suggestions.
 * - A ledger transaction can be consumed only once, including prior batches.
 */
export const autoMatchStatementLines = (statementLines, ledgerRows, reservedKeys = new Set()) => {
  const used = new Set(reservedKeys);
  return statementLines.map((line) => {
    const available = ledgerRows.filter((row) => !used.has(ledgerKey(row)) && sameAmountSide(line, row));
    const exactDate = available
      .filter((row) => dayDistance(line.transaction_date, row.date) === 0)
      .map((row) => ({ row, score: textScore(line, row) }))
      .sort((a, b) => b.score - a.score);

    if (exactDate.length === 1 || (exactDate.length > 1 && exactDate[0].score >= 0.5 && exactDate[0].score > exactDate[1].score)) {
      const match = exactDate[0].row;
      used.add(ledgerKey(match));
      return {
        ...line,
        match_status: 'MATCHED',
        matched_source: match.source,
        matched_source_id: match.id,
        match_confidence: exactDate.length === 1 ? 98 : 94,
        match_note: exactDate.length === 1 ? 'Exact date and amount match' : 'Exact amount/date with reference match',
      };
    }

    const nearby = available
      .filter((row) => dayDistance(line.transaction_date, row.date) <= 3)
      .map((row) => ({ row, days: dayDistance(line.transaction_date, row.date), score: textScore(line, row) }))
      .sort((a, b) => a.days - b.days || b.score - a.score);
    const suggestion = exactDate[0] || nearby[0];
    if (suggestion) {
      const match = suggestion.row;
      return {
        ...line,
        match_status: 'SUGGESTED',
        matched_source: match.source,
        matched_source_id: match.id,
        match_confidence: dayDistance(line.transaction_date, match.date) === 0 ? 82 : Math.max(60, 78 - (dayDistance(line.transaction_date, match.date) * 6)),
        match_note: exactDate.length > 1 ? 'Multiple ledger rows have the same date and amount' : 'Amount match within three days',
      };
    }

    return {
      ...line,
      match_status: 'UNMATCHED',
      matched_source: null,
      matched_source_id: null,
      match_confidence: null,
      match_note: null,
    };
  });
};

export const reconciliationDifference = ({ statementDebit, statementCredit, ledgerDebit, ledgerCredit }) => (
  roundMoney((Number(statementCredit) || 0) - (Number(statementDebit) || 0))
  - roundMoney((Number(ledgerCredit) || 0) - (Number(ledgerDebit) || 0))
);

export const reconciliationProgress = ({ matched = 0, ignored = 0, total = 0 }) => (
  total > 0 ? Math.round(((Number(matched) + Number(ignored)) / Number(total)) * 100) : 0
);

export { roundMoney };
