import pool from '../config/db.js';

const NORMALIZED_LEDGER_CTE = `
  WITH source_rows AS (
    SELECT
      cfe.id,
      cfe.site_id,
      cfe.date::date AS entry_date,
      cfe.particular,
      cfe.remarks,
      -- Keep one positive-sided representation everywhere. Some legacy rows
      -- stored reversals as a negative value on the opposite side; moving
      -- those values across preserves (credit - debit) exactly while making
      -- direction filters and totals deterministic.
      (
        GREATEST(COALESCE(cfe.debit, 0), 0)
        + GREATEST(-COALESCE(cfe.credit, 0), 0)
      )::numeric AS debit,
      (
        GREATEST(COALESCE(cfe.credit, 0), 0)
        + GREATEST(-COALESCE(cfe.debit, 0), 0)
      )::numeric AS credit,
      -- raw_mode = the canonical detail (cash / bank / cheque), used by the
      -- by_mode breakdown and the fine-grained $6 filter. ledger_bucket() is
      -- the one classifier (migration 081); it is idempotent on already
      -- normalised cash_type; every value other than explicit cash/cheque is
      -- classified into the bank book.
      ledger_bucket(cfe.cash_type) AS raw_mode,
      -- bucket = the BOOK, and there are only two: Cash and Bank. Anything not
      -- physical cash — bank, UPI, IMPS, NEFT, RTGS, cheque, unclassified —
      -- settles through a bank account, so it belongs to the Bank book. This
      -- is the same rule as NON_CASH_BUCKETS in the UI and the non-cash
      -- filters in CashFlow.model, so all three agree.
      CASE WHEN ledger_bucket(cfe.cash_type) = 'cash' THEN 'cash' ELSE 'bank' END AS bucket,
      COALESCE(NULLIF(TRIM(cfe.source_module), ''), 'personal_ledger') AS source_key,
      cfe.source_id,
      cfe.status,
      cfe.cheque_status,
      cfe.cheque_no,
      COALESCE(
        cfe.voucher_url,
        fp.voucher_url,
        pp.voucher_url,
        vp.voucher_url,
        ex.voucher_url,
        db.voucher_url
      ) AS voucher_url,
      COALESCE(
        f.name,
        pp.buyer_name,
        vc.vendor_name,
        NULLIF(cfm.ledger_name, ''),
        NULLIF(db.to_entity, ''),
        NULLIF(db.from_entity, ''),
        NULLIF(cfe.to_name, ''),
        cfe.particular
      ) AS entity_name,
      COALESCE(
        CASE WHEN p.plot_no IS NOT NULL THEN CONCAT('Plot ', p.plot_no, CASE WHEN p.block IS NOT NULL THEN CONCAT(' · Block ', p.block) ELSE '' END) END,
        CASE WHEN NULLIF(cfm.ledger_name, '') IS NOT NULL THEN CONCAT(INITCAP(COALESCE(cfm.ledger_type, 'site')), ' ledger · ', cfm.ledger_name) END,
        NULLIF(CONCAT_WS(' → ', NULLIF(db.from_entity, ''), NULLIF(db.to_entity, '')), ''),
        NULLIF(cfe.remarks, '')
      ) AS linked_detail,
      COALESCE(u.name, 'System') AS created_by_name,
      cfe.created_at,
      (cfe.source_module = 'farmer_payments'
        AND UPPER(COALESCE(fp.payment_mode, '')) = 'SPLIT'
        AND (COALESCE(fp.cash_amount, 0) + COALESCE(fp.bank_amount, 0)) > 0) AS is_split,
      COALESCE(fp.cash_amount, 0)::numeric AS split_cash,
      COALESCE(fp.bank_amount, 0)::numeric AS split_bank,
      UPPER(COALESCE(db.entry_type, '')) AS daybook_entry_type
    FROM cash_flow_entries cfe
    LEFT JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
    LEFT JOIN users u ON u.id = cfe.created_by
    LEFT JOIN farmer_payments fp
      ON cfe.source_module = 'farmer_payments' AND fp.id = cfe.source_id
    LEFT JOIN farmers f ON f.id = fp.farmer_id
    LEFT JOIN plot_payments pp
      ON cfe.source_module = 'plot_payments' AND pp.id = cfe.source_id
    LEFT JOIN plots p ON p.id = pp.plot_id
    LEFT JOIN vendor_payments vp
      ON cfe.source_module = 'vendor_payments' AND vp.id = cfe.source_id
    LEFT JOIN vendor_commitments vc ON vc.id = vp.commitment_id
    LEFT JOIN expenses ex
      ON cfe.source_module = 'expenses' AND ex.id = cfe.source_id
    LEFT JOIN day_book db
      ON cfe.source_module = 'day_book' AND db.id = cfe.source_id
    WHERE cfe.site_id = $1
      AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'
      AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
      AND COALESCE(cfe.source_module, '') NOT IN (
        'imprest', 'imprest_requests', 'document_imprest', 'document_imprest_requests',
        -- Registry payments only map an already-received plot payment to its
        -- registry record. They are never a second inflow or an expense.
        'plot_registry_payments'
      )
      -- Person-ledger mirror rows duplicate their source module row (migration
      -- 076) — counting both would double every person-mapped transaction.
      AND COALESCE(cfe.source_module, '') NOT LIKE '%\\_person'
      AND NOT (cfe.source_module = 'day_book' AND UPPER(COALESCE(db.entry_type, '')) = 'IMPREST')
  ),
  normalized_entries AS (
    SELECT
      id::text AS id,
      site_id,
      entry_date,
      particular,
      remarks,
      debit,
      credit,
      raw_mode,
      bucket,
      source_key,
      source_id,
      status,
      cheque_status,
      cheque_no,
      voucher_url,
      entity_name,
      linked_detail,
      created_by_name,
      created_at
    FROM source_rows
    WHERE NOT is_split

    UNION ALL

    SELECT
      CONCAT(id, ':cash') AS id,
      site_id,
      entry_date,
      particular,
      remarks,
      split_cash AS debit,
      0::numeric AS credit,
      'cash' AS raw_mode,
      'cash' AS bucket,
      source_key,
      source_id,
      status,
      cheque_status,
      cheque_no,
      voucher_url,
      entity_name,
      CONCAT_WS(' · ', linked_detail, 'Cash part of split payment') AS linked_detail,
      created_by_name,
      created_at
    FROM source_rows
    WHERE is_split AND split_cash > 0

    UNION ALL

    SELECT
      CONCAT(id, ':bank') AS id,
      site_id,
      entry_date,
      particular,
      remarks,
      split_bank AS debit,
      0::numeric AS credit,
      'bank' AS raw_mode,
      'bank' AS bucket,
      source_key,
      source_id,
      status,
      cheque_status,
      cheque_no,
      voucher_url,
      entity_name,
      CONCAT_WS(' · ', linked_detail, 'Bank part of split payment') AS linked_detail,
      created_by_name,
      created_at
    FROM source_rows
    WHERE is_split AND split_bank > 0
  ),
  valid_entries AS (
    SELECT *
    FROM normalized_entries
    WHERE entry_date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
  ),
  -- Accounting totals are scoped only by the selected book. Main is the
  -- complete union of the two mutually-exclusive Cash and Bank buckets, so
  -- its opening/movement/closing always equals Cash + Bank. Search, source,
  -- direction and detail-mode are presentation filters and must not rewrite
  -- those balances.
  book_entries AS (
    SELECT *
    FROM valid_entries
    WHERE ($4::text = 'all' OR bucket = $4::text)
  ),
  book_entries_with_balance AS (
    SELECT *,
      COALESCE(SUM(credit - debit) OVER (
        ORDER BY entry_date ASC, created_at ASC, id ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ), 0)::numeric AS running_balance
    FROM book_entries
  ),
  scoped_entries AS (
    SELECT *
    FROM book_entries_with_balance
    WHERE ($5::text = 'all' OR source_key = $5::text)
      AND ($6::text = 'all' OR raw_mode = $6::text)
      AND (
        $7::text = 'all'
        OR ($7::text = 'credit' AND credit > 0)
        OR ($7::text = 'debit' AND debit > 0)
      )
      AND (
        $8::text = ''
        OR particular ILIKE CONCAT('%', $8::text, '%')
        OR COALESCE(entity_name, '') ILIKE CONCAT('%', $8::text, '%')
        OR COALESCE(linked_detail, '') ILIKE CONCAT('%', $8::text, '%')
        OR COALESCE(remarks, '') ILIKE CONCAT('%', $8::text, '%')
      )
  ),
  period_entries AS (
    SELECT *
    FROM scoped_entries
    WHERE ($2::date IS NULL OR entry_date >= $2::date)
      AND ($3::date IS NULL OR entry_date <= $3::date)
  ),
  book_period_entries AS (
    SELECT *
    FROM book_entries
    WHERE ($2::date IS NULL OR entry_date >= $2::date)
      AND ($3::date IS NULL OR entry_date <= $3::date)
  ),
  opening AS (
    SELECT COALESCE(SUM(credit - debit), 0)::numeric AS amount
    FROM book_entries
    WHERE $2::date IS NOT NULL AND entry_date < $2::date
  ),
  summary AS (
    SELECT
      COALESCE(SUM(debit), 0)::numeric AS total_debit,
      COALESCE(SUM(credit), 0)::numeric AS total_credit,
      COALESCE(SUM(credit - debit), 0)::numeric AS net_movement,
      COUNT(*)::int AS total_entries
    FROM book_period_entries
  ),
  presentation_summary AS (
    SELECT COUNT(*)::int AS filtered_entries
    FROM period_entries
  )
`;

const REPORT_QUERY = `${NORMALIZED_LEDGER_CTE}
  SELECT jsonb_build_object(
    'summary', jsonb_build_object(
      'opening_balance', opening.amount,
      'total_debit', summary.total_debit,
      'total_credit', summary.total_credit,
      'net_movement', summary.net_movement,
      'closing_balance', opening.amount + summary.net_movement,
      'total_entries', summary.total_entries
    ),
    'transactions', COALESCE((
      SELECT jsonb_agg(to_jsonb(tx) ORDER BY tx.entry_date DESC, tx.created_at DESC, tx.id DESC)
      FROM (
        SELECT
          id,
          TO_CHAR(entry_date, 'YYYY-MM-DD') AS entry_date,
          particular,
          remarks,
          debit,
          credit,
          running_balance,
          raw_mode AS payment_mode,
          bucket,
          source_key,
          source_id,
          status,
          cheque_status,
          cheque_no,
          voucher_url,
          entity_name,
          linked_detail,
          created_by_name,
          created_at
        FROM period_entries
        ORDER BY entry_date DESC, created_at DESC, id DESC
        LIMIT $9::int
      ) tx
    ), '[]'::jsonb),
    'by_source', COALESCE((
      SELECT jsonb_agg(to_jsonb(s) ORDER BY s.total_credit + s.total_debit DESC)
      FROM (
        SELECT source_key, COUNT(*)::int AS entries,
          COALESCE(SUM(debit), 0)::numeric AS total_debit,
          COALESCE(SUM(credit), 0)::numeric AS total_credit,
          COALESCE(SUM(credit - debit), 0)::numeric AS net
        FROM period_entries GROUP BY source_key
      ) s
    ), '[]'::jsonb),
    'by_mode', COALESCE((
      SELECT jsonb_agg(to_jsonb(m) ORDER BY m.total_credit + m.total_debit DESC)
      FROM (
        SELECT bucket, raw_mode AS payment_mode, COUNT(*)::int AS entries,
          COALESCE(SUM(debit), 0)::numeric AS total_debit,
          COALESCE(SUM(credit), 0)::numeric AS total_credit,
          COALESCE(SUM(credit - debit), 0)::numeric AS net
        FROM period_entries GROUP BY bucket, raw_mode
      ) m
    ), '[]'::jsonb),
    'timeline', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.period)
      FROM (
        SELECT
          CASE WHEN $10::text = 'day' THEN entry_date ELSE DATE_TRUNC('month', entry_date)::date END AS period,
          COALESCE(SUM(debit), 0)::numeric AS total_debit,
          COALESCE(SUM(credit), 0)::numeric AS total_credit,
          COALESCE(SUM(credit - debit), 0)::numeric AS net
        FROM period_entries
        GROUP BY CASE WHEN $10::text = 'day' THEN entry_date ELSE DATE_TRUNC('month', entry_date)::date END
      ) t
    ), '[]'::jsonb),
    'quality', jsonb_build_object(
      'invalid_date_entries', (
        SELECT COUNT(*)::int FROM source_rows
        WHERE entry_date < DATE '1900-01-01' OR entry_date > DATE '2100-12-31'
      ),
      'excluded_unapproved', (
        SELECT COUNT(*)::int FROM cash_flow_entries
        WHERE site_id = $1 AND LOWER(COALESCE(status, 'approved')) <> 'approved'
      ),
      'excluded_bounced', (
        SELECT COUNT(*)::int FROM cash_flow_entries
        WHERE site_id = $1 AND UPPER(COALESCE(cheque_status, '')) IN ('BOUNCED', 'RETURNED')
      ),
      'accounting_entries', summary.total_entries,
      'filtered_entries', presentation_summary.filtered_entries,
      'returned_entries', LEAST(presentation_summary.filtered_entries, $9::int),
      'is_truncated', presentation_summary.filtered_entries > $9::int
    )
  ) AS report
  FROM summary CROSS JOIN opening CROSS JOIN presentation_summary
`;

class BalanceSheetModel {
  async getReport({
    siteId,
    dateFrom = null,
    dateTo = null,
    scope = 'all',
    source = 'all',
    paymentMode = 'all',
    direction = 'all',
    search = '',
    limit = 2500,
    grain = 'day',
  }) {
    const result = await pool.query(REPORT_QUERY, [
      siteId,
      dateFrom,
      dateTo,
      scope,
      source,
      paymentMode,
      direction,
      search,
      limit,
      grain,
    ]);
    return result.rows[0]?.report || null;
  }
}

export default new BalanceSheetModel();
