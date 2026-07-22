/**
 * Plot Payments GraphQL Service
 * Optimized SQL queries replacing multiple REST endpoints with single GraphQL calls.
 */
import pool from '../../config/db.js';

/**
 * Fetch all plots for a site with payment aggregates in a SINGLE query
 * using LEFT JOIN + GROUP BY instead of 6 correlated subqueries per row.
 */
export async function getPlotsWithTotals(siteId) {
  // Per-plot RECEIVED = plot_payments + plot_installment_payments (both across
  // every payment mode). Two LATERAL joins keep the query readable; the final
  // `total_received`, `received_bank` and `received_cash` are the sum of each
  // leg. Bounced / returned cheques are excluded on both sources.
  const query = `
    SELECT
      p.*,
      -- booking_date is a DATE column → pg hands it back as a JS Date, which the
      -- GraphQLString field then serializes as epoch-millis (unparseable on the
      -- client). Emit a stable 'YYYY-MM-DD' string instead. The duplicate column
      -- name intentionally overrides the one from p.* (last column wins in pg).
      to_char(p.booking_date, 'YYYY-MM-DD') AS booking_date,
      COALESCE(pp_agg.total_received, 0) + COALESCE(ip_agg.total_received, 0)
        AS total_received,
      COALESCE(pp_agg.received_bank, 0)  + COALESCE(ip_agg.received_bank, 0)
        AS received_bank,
      COALESCE(pp_agg.received_cash, 0)  + COALESCE(ip_agg.received_cash, 0)
        AS received_cash,
      COALESCE(pp_agg.payment_count, 0)::int + COALESCE(ip_agg.payment_count, 0)::int
        AS payment_count,
      COALESCE(pp_agg.payment_buyer_names, '')  AS payment_buyer_names,
      COALESCE(pp_agg.payment_booked_bys, '')   AS payment_booked_bys
    FROM plots p
    LEFT JOIN LATERAL (
      SELECT
        SUM(pp.amount) FILTER (WHERE LOWER(COALESCE(pp.status, 'approved')) = 'approved' AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED'))
          AS total_received,
        SUM(pp.amount) FILTER (WHERE ledger_bucket(pp.payment_type) <> 'cash' AND LOWER(COALESCE(pp.status, 'approved')) = 'approved' AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED'))
          AS received_bank,
        SUM(pp.amount) FILTER (WHERE ledger_bucket(pp.payment_type) = 'cash' AND LOWER(COALESCE(pp.status, 'approved')) = 'approved' AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED'))
          AS received_cash,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(pp.status, 'approved')) = 'approved' AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED'))::int AS payment_count,
        string_agg(DISTINCT pp.buyer_name, ', ') FILTER (WHERE pp.buyer_name IS NOT NULL AND pp.buyer_name != '')
          AS payment_buyer_names,
        string_agg(DISTINCT pp.booked_by, ', ') FILTER (WHERE pp.booked_by IS NOT NULL AND pp.booked_by != '')
          AS payment_booked_bys
      FROM plot_payments pp
      WHERE pp.plot_id = p.id
    ) pp_agg ON true
    LEFT JOIN LATERAL (
      SELECT
        SUM(pip.amount) FILTER (WHERE UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED'))
          AS total_received,
        SUM(pip.amount) FILTER (WHERE ledger_bucket(pip.payment_mode) <> 'cash' AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED'))
          AS received_bank,
        SUM(pip.amount) FILTER (WHERE ledger_bucket(pip.payment_mode) = 'cash' AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED'))
          AS received_cash,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED'))::int AS payment_count
      FROM plot_installment_payments pip
      WHERE pip.plot_id = p.id
    ) ip_agg ON true
    WHERE p.site_id = $1
    ORDER BY p.plot_no ASC
  `;
  const { rows } = await pool.query(query, [siteId]);
  return rows;
}

/**
 * Fetch autocomplete data for a site in a SINGLE query using UNION ALL
 * instead of 6+ separate queries.
 */
export async function getPlotAutocomplete(siteId) {
  const query = `
    SELECT 'buyerName' AS type, p.buyer_name AS val
    FROM plots p
    WHERE p.site_id = $1 AND p.buyer_name IS NOT NULL AND p.buyer_name != ''
    GROUP BY p.buyer_name
    ORDER BY val ASC
  `;
  const paymentQuery = `
    SELECT type, val FROM (
      SELECT 'paymentFrom' AS type, payment_from AS val
      FROM plot_payments WHERE site_id = $1 AND payment_from IS NOT NULL AND payment_from != ''
      UNION
      SELECT 'bankDetail' AS type, bank_details AS val
      FROM plot_payments WHERE site_id = $1 AND bank_details IS NOT NULL AND bank_details != ''
      UNION
      SELECT 'narration' AS type, narration AS val
      FROM plot_payments WHERE site_id = $1 AND narration IS NOT NULL AND narration != ''
      UNION
      SELECT 'receivedBy' AS type, received_by AS val
      FROM plot_payments WHERE site_id = $1 AND received_by IS NOT NULL AND received_by != ''
      UNION
      SELECT 'bookedBy' AS type, booked_by AS val
      FROM plot_payments WHERE site_id = $1 AND booked_by IS NOT NULL AND booked_by != ''
    ) sub
    ORDER BY type, val
  `;
  const memberQuery = `
    SELECT full_name, phone, team, member_type
    FROM members
    WHERE site_id = $1 AND full_name IS NOT NULL AND full_name != ''
    ORDER BY full_name ASC
  `;

  const [buyerRes, paymentRes, memberRes] = await Promise.all([
    pool.query(query, [siteId]),
    pool.query(paymentQuery, [siteId]),
    pool.query(memberQuery, [siteId]),
  ]);

  const autocomplete = {
    buyerNames: [],
    paymentFroms: [],
    bankDetails: [],
    narrations: [],
    receivedBys: [],
    bookedBys: [],
    members: [],
  };

  // Buyer names from plots
  for (const row of buyerRes.rows) {
    autocomplete.buyerNames.push(row.val);
  }

  // Payment autocomplete values grouped by type
  for (const row of paymentRes.rows) {
    switch (row.type) {
      case 'paymentFrom': autocomplete.paymentFroms.push(row.val); break;
      case 'bankDetail':  autocomplete.bankDetails.push(row.val); break;
      case 'narration':   autocomplete.narrations.push(row.val); break;
      case 'receivedBy':  autocomplete.receivedBys.push(row.val); break;
      case 'bookedBy':    autocomplete.bookedBys.push(row.val); break;
    }
  }

  // Members
  autocomplete.members = memberRes.rows.map(r => ({
    name: r.full_name,
    phone: r.phone || '',
    team: r.team || '',
    memberType: r.member_type || '',
  }));

  return autocomplete;
}

/**
 * Fetch plot payments page data in a single call (plots + autocomplete).
 * This replaces the two parallel REST calls in the frontend.
 */
export async function getPlotPageData(siteId) {
  // Run free-to-sale check in parallel with data fetching
  const checkFreeToSaleQuery = `
    SELECT p.id, p.status, p.grace_period_days, p.free_to_sale_days
    FROM plots p
    WHERE p.site_id = $1
      AND p.installments_enabled = true
      AND p.free_to_sale_days > 0
      AND p.status NOT IN ('UNDER CANCELLATION', 'CANCELLED', 'RESALE', 'TRANSFERRED', 'COMPANY')
  `;

  const [plots, autocomplete] = await Promise.all([
    getPlotsWithTotals(siteId),
    getPlotAutocomplete(siteId),
  ]);

  return { plots, autocomplete };
}

/**
 * Fetch payments for a selected plot with breakdowns — replaces 3 REST calls.
 */
export async function getPlotPaymentDetail(plotId, siteId) {
  const paymentsQuery = `
    SELECT pp.*, 'payment' AS source, u.name AS created_by_name
    FROM plot_payments pp
    JOIN plots authorized_plot
      ON authorized_plot.id = pp.plot_id
     AND authorized_plot.site_id = $2
    LEFT JOIN users u ON u.id = pp.created_by
    WHERE pp.plot_id = $1
    ORDER BY pp.date ASC, pp.created_at ASC
  `;

  const plotQuery = `
    SELECT p.*,
      -- See getPlotsWithTotals: stable date string so GraphQLString doesn't emit epoch-millis.
      to_char(p.booking_date, 'YYYY-MM-DD') AS booking_date,
      COALESCE(pp_agg.total_received, 0) + COALESCE(ip_agg.total_received, 0)
        AS total_received,
      COALESCE(pp_agg.received_bank, 0)  + COALESCE(ip_agg.received_bank, 0)
        AS received_bank,
      COALESCE(pp_agg.received_cash, 0)  + COALESCE(ip_agg.received_cash, 0)
        AS received_cash,
      COALESCE(pp_agg.payment_count, 0)::int + COALESCE(ip_agg.payment_count, 0)::int
        AS payment_count
    FROM plots p
    LEFT JOIN LATERAL (
      SELECT
        SUM(pp.amount) FILTER (WHERE LOWER(COALESCE(pp.status, 'approved')) = 'approved' AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED'))
          AS total_received,
        SUM(pp.amount) FILTER (WHERE ledger_bucket(pp.payment_type) <> 'cash' AND LOWER(COALESCE(pp.status, 'approved')) = 'approved' AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED'))
          AS received_bank,
        SUM(pp.amount) FILTER (WHERE ledger_bucket(pp.payment_type) = 'cash' AND LOWER(COALESCE(pp.status, 'approved')) = 'approved' AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED'))
          AS received_cash,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(pp.status, 'approved')) = 'approved' AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED'))::int AS payment_count
      FROM plot_payments pp
      WHERE pp.plot_id = p.id
    ) pp_agg ON true
    LEFT JOIN LATERAL (
      SELECT
        SUM(pip.amount) FILTER (WHERE UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED'))
          AS total_received,
        SUM(pip.amount) FILTER (WHERE ledger_bucket(pip.payment_mode) <> 'cash' AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED'))
          AS received_bank,
        SUM(pip.amount) FILTER (WHERE ledger_bucket(pip.payment_mode) = 'cash' AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED'))
          AS received_cash,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED'))::int AS payment_count
      FROM plot_installment_payments pip
      WHERE pip.plot_id = p.id
    ) ip_agg ON true
    WHERE p.id = $1
      AND p.site_id = $2
  `;

  // Keep breakdowns on the exact same posted receipt population as
  // plot.total_received: approved direct payments plus auto-posted installment
  // payments, each selected once. The latter have no approval-state column.
  const fromBreakdownQuery = `
    SELECT
      receipt.payment_from,
      COUNT(*)::int AS entries,
      COALESCE(SUM(receipt.amount), 0) AS total_amount,
      CASE
        WHEN COUNT(DISTINCT receipt.source) = 1 THEN MIN(receipt.source)
        ELSE 'MIXED'
      END AS source
    FROM (
      SELECT
        COALESCE(
          NULLIF(UPPER(TRIM(pp.payment_from)), ''),
          NULLIF(UPPER(TRIM(pp.payment_type)), ''),
          'OTHER'
        ) AS payment_from,
        pp.amount,
        'DIRECT'::varchar AS source
      FROM plot_payments pp
      JOIN plots authorized_plot
        ON authorized_plot.id = pp.plot_id
       AND authorized_plot.site_id = $2
      WHERE pp.plot_id = $1
        AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
        AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')

      UNION ALL

      SELECT
        UPPER(COALESCE(NULLIF(TRIM(pip.payment_mode), ''), 'BANK')) AS payment_from,
        pip.amount,
        'INSTALLMENT'::varchar AS source
      FROM plot_installment_payments pip
      JOIN plots authorized_plot
        ON authorized_plot.id = pip.plot_id
       AND authorized_plot.site_id = $2
      WHERE pip.plot_id = $1
        AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
    ) receipt
    GROUP BY receipt.payment_from
    ORDER BY total_amount DESC
  `;

  const receivedByBreakdownQuery = `
    SELECT
      receipt.received_by,
      COUNT(*)::int AS entries,
      COALESCE(SUM(receipt.amount), 0) AS total_amount,
      CASE
        WHEN COUNT(DISTINCT receipt.source) = 1 THEN MIN(receipt.source)
        ELSE 'MIXED'
      END AS source
    FROM (
      SELECT
        COALESCE(NULLIF(UPPER(TRIM(pp.received_by)), ''), 'UNKNOWN') AS received_by,
        pp.amount,
        'DIRECT'::varchar AS source
      FROM plot_payments pp
      JOIN plots authorized_plot
        ON authorized_plot.id = pp.plot_id
       AND authorized_plot.site_id = $2
      WHERE pp.plot_id = $1
        AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
        AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')

      UNION ALL

      SELECT
        'INSTALLMENT AUTO-POST'::varchar AS received_by,
        pip.amount,
        'INSTALLMENT'::varchar AS source
      FROM plot_installment_payments pip
      JOIN plots authorized_plot
        ON authorized_plot.id = pip.plot_id
       AND authorized_plot.site_id = $2
      WHERE pip.plot_id = $1
        AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
    ) receipt
    GROUP BY receipt.received_by
    ORDER BY total_amount DESC
  `;

  const installmentsQuery = `
    SELECT pi.*,
      COALESCE(
        (SELECT SUM(pip.amount) FROM plot_installment_payments pip
          WHERE pip.installment_id = pi.id
            AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')),
        0
      ) AS paid_amount
    FROM plot_installments pi
    JOIN plots authorized_plot
      ON authorized_plot.id = pi.plot_id
     AND authorized_plot.site_id = $2
    WHERE pi.plot_id = $1
    ORDER BY pi.sort_order ASC, pi.due_date ASC
  `;

  const installmentPaymentsQuery = `
    SELECT CONCAT('pip_', pip.id) AS id,
      pip.plot_id,
      p.site_id,
      TO_CHAR(pip.payment_date, 'YYYY-MM-DD') AS date,
      UPPER(COALESCE(NULLIF(TRIM(pip.payment_mode), ''), 'BANK')) AS payment_from,
      UPPER(COALESCE(NULLIF(TRIM(pip.payment_mode), ''), 'BANK')) AS payment_type,
      pip.reference AS bank_details,
      pip.notes AS narration,
      pip.amount,
      pip.cheque_no,
      pip.cheque_status,
      'approved'::varchar AS status,
      'INSTALLMENT AUTO-POST'::varchar AS received_by,
      pip.created_by,
      u.name AS created_by_name,
      pip.created_at,
      'installment_payment'::varchar AS source
    FROM plot_installment_payments pip
    JOIN plots p ON p.id = pip.plot_id AND p.site_id = $2
    LEFT JOIN users u ON u.id = pip.created_by
    WHERE pip.plot_id = $1
    ORDER BY pip.payment_date ASC, pip.created_at ASC
  `;

  const [paymentsRes, plotRes, fromRes, recByRes, instRes, instPaymentsRes] = await Promise.all([
    pool.query(paymentsQuery, [plotId, siteId]),
    pool.query(plotQuery, [plotId, siteId]),
    pool.query(fromBreakdownQuery, [plotId, siteId]),
    pool.query(receivedByBreakdownQuery, [plotId, siteId]),
    pool.query(installmentsQuery, [plotId, siteId]),
    pool.query(installmentPaymentsQuery, [plotId, siteId]),
  ]);

  return {
    payments: paymentsRes.rows,
    plot: plotRes.rows[0] || null,
    fromBreakdown: fromRes.rows,
    receivedByBreakdown: recByRes.rows,
    installments: instRes.rows,
    installmentPayments: instPaymentsRes.rows,
  };
}

/**
 * Fetch recent posted plot payments for a site — used by PlotRegistry "Link
 * Payments" dropdown. Registry is only a reference mapping, so every settlement
 * mode (UPI/RTGS/IMPS/custom included) is eligible; mapping never posts money.
 * Checks if source_plot_payment_id column exists for mapped_registry_payment_id tracking.
 */
export async function getRegistryBankChequePayments(siteId) {
  const hasColResult = await pool.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'plot_registry_payments'
        AND column_name = 'source_plot_payment_id'
    ) AS exists
  `);
  const hasCol = !!hasColResult.rows?.[0]?.exists;

  const query = hasCol
    ? `
      SELECT
        pp.id, pp.plot_id, p.plot_no,
        p.buyer_name AS customer_name,
        m.phone AS customer_phone,
        pp.date, pp.amount, pp.payment_type, pp.payment_from,
        pp.narration, pp.bank_details,
        prp.id AS mapped_registry_payment_id
      FROM plot_payments pp
      LEFT JOIN plots p ON p.id = pp.plot_id
      LEFT JOIN members m ON m.site_id = pp.site_id AND UPPER(m.full_name) = UPPER(COALESCE(p.buyer_name, ''))
      LEFT JOIN plot_registry_payments prp ON prp.source_plot_payment_id = pp.id
      WHERE pp.site_id = $1
        AND (pp.amount IS NOT NULL AND pp.amount > 0)
        AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
        AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
      ORDER BY pp.date DESC, pp.created_at DESC
    `
    : `
      SELECT
        pp.id, pp.plot_id, p.plot_no,
        p.buyer_name AS customer_name,
        m.phone AS customer_phone,
        pp.date, pp.amount, pp.payment_type, pp.payment_from,
        pp.narration, pp.bank_details,
        NULL::INTEGER AS mapped_registry_payment_id
      FROM plot_payments pp
      LEFT JOIN plots p ON p.id = pp.plot_id
      LEFT JOIN members m ON m.site_id = pp.site_id AND UPPER(m.full_name) = UPPER(COALESCE(p.buyer_name, ''))
      WHERE pp.site_id = $1
        AND (pp.amount IS NOT NULL AND pp.amount > 0)
        AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
        AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
      ORDER BY pp.date DESC, pp.created_at DESC
    `;

  const { rows } = await pool.query(query, [siteId]);
  return rows.map(r => ({
    ...r,
    date: r.date instanceof Date ? r.date.toISOString() : r.date,
  }));
}
