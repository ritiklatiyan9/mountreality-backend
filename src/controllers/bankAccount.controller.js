import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { maskAccountNumber } from '../services/bankAccount.service.js';
import {
  autoMatchStatementLines,
  reconciliationDifference,
  reconciliationProgress,
  roundMoney,
} from '../services/bankReconciliation.service.js';

const VPA_RE = /^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const clean = (value, max) => String(value ?? '').trim().slice(0, max);
const positiveId = (value) => {
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const monthPeriod = (value) => {
  const raw = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return null;
  const start = `${match[1]}-${match[2]}-01`;
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { month: start, start, end };
};

const cleanDate = (value) => {
  const raw = String(value || '').slice(0, 10);
  return ISO_DATE_RE.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) ? raw : null;
};

const statementLinePayload = (row, index, period) => {
  const transactionDate = cleanDate(row?.transaction_date || row?.date || row?.value_date);
  const debit = Math.max(roundMoney(row?.debit), 0);
  const credit = Math.max(roundMoney(row?.credit), 0);
  if (!transactionDate || transactionDate < period.start || transactionDate > period.end) return null;
  if ((debit <= 0 && credit <= 0) || (debit > 0 && credit > 0)) return null;
  return {
    row_number: index + 1,
    transaction_date: transactionDate,
    value_date: cleanDate(row?.value_date),
    description: clean(row?.description || row?.narration || row?.particular || 'BANK TRANSACTION', 500),
    reference: clean(row?.reference || row?.transaction_id || row?.cheque_no, 180) || null,
    debit,
    credit,
    running_balance: row?.running_balance === '' || row?.running_balance == null ? null : roundMoney(row.running_balance),
  };
};

const accountPayload = (body, { partial = false } = {}) => {
  const result = {};
  const assign = (key, max, transform = (value) => value) => {
    if (partial && body[key] === undefined) return;
    const value = clean(body[key], max);
    result[key] = value ? transform(value) : null;
  };
  assign('label', 100);
  assign('bank_name', 100, (value) => value.toUpperCase());
  assign('account_no', 50);
  assign('ifsc', 20, (value) => value.toUpperCase());
  assign('account_type', 30, (value) => value.toUpperCase());
  assign('payee_name', 100);
  assign('vpa', 100, (value) => value.toLowerCase());
  assign('notes', 500);
  if (!partial || body.is_active !== undefined) result.is_active = body.is_active !== false;

  if (!partial && !result.label) throw Object.assign(new Error('Account label is required'), { status: 400 });
  if (!partial && !result.bank_name) throw Object.assign(new Error('Bank name is required'), { status: 400 });
  if (partial && body.label !== undefined && !result.label) {
    throw Object.assign(new Error('Account label cannot be empty'), { status: 400 });
  }
  if (partial && body.bank_name !== undefined && !result.bank_name) {
    throw Object.assign(new Error('Bank name cannot be empty'), { status: 400 });
  }
  if (result.vpa && !VPA_RE.test(result.vpa)) {
    throw Object.assign(new Error('Invalid VPA / UPI ID'), { status: 400 });
  }
  if (result.ifsc && !IFSC_RE.test(result.ifsc)) {
    throw Object.assign(new Error('Invalid IFSC code'), { status: 400 });
  }
  return result;
};

const publicAccount = (row) => {
  const { account_no: accountNumber, ...safe } = row;
  return { ...safe, masked_account_no: maskAccountNumber(accountNumber) };
};

const ACCOUNT_SUMMARY_SQL = `
  WITH tx AS (
    SELECT bank_account_id,COALESCE(credit,0)-COALESCE(debit,0) AS net FROM day_book
      WHERE site_id=$1 AND bank_account_id IS NOT NULL
        AND farmer_payment_id IS NULL AND commission_id IS NULL
        AND cash_flow_entry_id IS NULL AND firm_transaction_id IS NULL
        AND plot_payment_id IS NULL
    UNION ALL SELECT bank_account_id,COALESCE(credit,0)-COALESCE(debit,0) FROM expenses WHERE site_id=$1 AND bank_account_id IS NOT NULL
    UNION ALL SELECT fp.bank_account_id,-fp.amount FROM farmer_payments fp JOIN farmers f ON f.id=fp.farmer_id WHERE f.site_id=$1 AND fp.bank_account_id IS NOT NULL
    UNION ALL SELECT bank_account_id,COALESCE(credit,0)-COALESCE(debit,0) FROM cash_flow_entries WHERE site_id=$1 AND bank_account_id IS NOT NULL
    UNION ALL SELECT bank_account_id,COALESCE(credit,0)-COALESCE(debit,0) FROM firm_transactions WHERE site_id=$1 AND bank_account_id IS NOT NULL
    UNION ALL SELECT bank_account_id,amount FROM plot_payments WHERE site_id=$1 AND bank_account_id IS NOT NULL
    UNION ALL SELECT bank_account_id,amount FROM plot_installment_payments WHERE plot_id IN (SELECT id FROM plots WHERE site_id=$1) AND bank_account_id IS NOT NULL
    UNION ALL SELECT bank_account_id,-amount FROM vendor_payments WHERE site_id=$1 AND bank_account_id IS NOT NULL
    UNION ALL SELECT bank_account_id,-amount FROM vendor_inventory_payments WHERE site_id=$1 AND bank_account_id IS NOT NULL
    UNION ALL SELECT bank_account_id,-amount FROM plot_commissions WHERE site_id=$1 AND bank_account_id IS NOT NULL
    UNION ALL SELECT bank_account_id,-amount FROM plot_commission_payments WHERE site_id=$1 AND bank_account_id IS NOT NULL
    UNION ALL SELECT bank_account_id,amount FROM plot_registry_payments WHERE site_id=$1 AND bank_account_id IS NOT NULL AND source_plot_payment_id IS NULL
  ), totals AS (
    SELECT bank_account_id,COUNT(*)::int AS transaction_count,COALESCE(SUM(net),0)::numeric AS ledger_balance
      FROM tx GROUP BY bank_account_id
  )
  SELECT a.*,COALESCE(t.transaction_count,0) AS transaction_count,
         COALESCE(t.ledger_balance,0)::numeric AS ledger_balance,
         u.name AS created_by_name
    FROM upi_accounts a
    LEFT JOIN totals t ON t.bank_account_id=a.id
    LEFT JOIN users u ON u.id=a.created_by
   WHERE a.site_id=$1
   ORDER BY a.is_active DESC,a.bank_name,a.label,a.id`;

const LEDGER_SQL = `
  SELECT * FROM (
    SELECT 'daybook'::text AS source,db.id,db.date,db.particular AS description,
           COALESCE(db.debit,0)::numeric AS debit,COALESCE(db.credit,0)::numeric AS credit,
           db.payment_mode,db.remarks AS reference,db.status
      FROM day_book db WHERE db.site_id=$1 AND db.bank_account_id=$2
        AND db.farmer_payment_id IS NULL AND db.commission_id IS NULL
        AND db.cash_flow_entry_id IS NULL AND db.firm_transaction_id IS NULL
        AND db.plot_payment_id IS NULL
    UNION ALL
    SELECT 'expense',e.id,e.date,COALESCE(e.remark,e.category,'EXPENSE'),
           COALESCE(e.debit,0),COALESCE(e.credit,0),e.payment_mode,e.remark,e.status
      FROM expenses e WHERE e.site_id=$1 AND e.bank_account_id=$2
    UNION ALL
    SELECT 'land-payment',fp.id,fp.date,COALESCE(fp.particular,'LAND / FARMER PAYMENT'),
           CASE WHEN fp.amount >= 0 THEN fp.amount ELSE 0 END,
           CASE WHEN fp.amount < 0 THEN ABS(fp.amount) ELSE 0 END,
           fp.payment_mode,fp.remarks,COALESCE(fp.status,'approved')
      FROM farmer_payments fp JOIN farmers f ON f.id=fp.farmer_id
     WHERE f.site_id=$1 AND fp.bank_account_id=$2
    UNION ALL
    SELECT 'personal-ledger',cfe.id,cfe.date,cfe.particular,
           COALESCE(cfe.debit,0),COALESCE(cfe.credit,0),cfe.cash_type,cfe.remarks,cfe.status
      FROM cash_flow_entries cfe WHERE cfe.site_id=$1 AND cfe.bank_account_id=$2
    UNION ALL
    SELECT 'firm-transaction',ft.id,ft.date,ft.description,
           COALESCE(ft.debit,0),COALESCE(ft.credit,0),ft.payment_mode,COALESCE(ft.remark,ft.purpose),ft.status
      FROM firm_transactions ft WHERE ft.site_id=$1 AND ft.bank_account_id=$2
    UNION ALL
    SELECT 'plot-payment',pp.id,pp.date,COALESCE(pp.narration,'PLOT PAYMENT'),
           CASE WHEN pp.amount < 0 THEN ABS(pp.amount) ELSE 0 END,
           CASE WHEN pp.amount >= 0 THEN pp.amount ELSE 0 END,
           pp.payment_type,COALESCE(pp.bank_details,pp.receipt_no),pp.status
      FROM plot_payments pp WHERE pp.site_id=$1 AND pp.bank_account_id=$2
    UNION ALL
    SELECT 'installment-payment',pip.id,pip.payment_date,COALESCE(pi.installment_name,'PLOT INSTALLMENT'),
           CASE WHEN pip.amount < 0 THEN ABS(pip.amount) ELSE 0 END,
           CASE WHEN pip.amount >= 0 THEN pip.amount ELSE 0 END,
           pip.payment_mode,COALESCE(pip.reference,pip.notes),'approved'
      FROM plot_installment_payments pip
      JOIN plots p ON p.id=pip.plot_id
      LEFT JOIN plot_installments pi ON pi.id=pip.installment_id
     WHERE p.site_id=$1 AND pip.bank_account_id=$2
    UNION ALL
    SELECT 'vendor-payment',vp.id,vp.payment_date,'VENDOR PAYMENT',
           CASE WHEN vp.amount >= 0 THEN vp.amount ELSE 0 END,
           CASE WHEN vp.amount < 0 THEN ABS(vp.amount) ELSE 0 END,
           UPPER(vp.payment_mode),COALESCE(vp.reference_no,vp.note),vp.status
      FROM vendor_payments vp WHERE vp.site_id=$1 AND vp.bank_account_id=$2
    UNION ALL
    SELECT 'vendor-inventory-payment',vip.id,vip.payment_date,COALESCE(vio.item_name,'VENDOR INVENTORY PAYMENT'),
           CASE WHEN vip.amount >= 0 THEN vip.amount ELSE 0 END,
           CASE WHEN vip.amount < 0 THEN ABS(vip.amount) ELSE 0 END,
           UPPER(vip.payment_mode),COALESCE(vip.reference_no,vip.note),'approved'
      FROM vendor_inventory_payments vip
      LEFT JOIN vendor_inventory_orders vio ON vio.id=vip.order_id
     WHERE vip.site_id=$1 AND vip.bank_account_id=$2
    UNION ALL
    SELECT 'commission',pc.id,pc.date,COALESCE(pc.particular,'PLOT COMMISSION'),
           CASE WHEN pc.amount >= 0 THEN pc.amount ELSE 0 END,
           CASE WHEN pc.amount < 0 THEN ABS(pc.amount) ELSE 0 END,
           pc.payment_mode,COALESCE(pc.by_note,pc.remarks),pc.status
      FROM plot_commissions pc WHERE pc.site_id=$1 AND pc.bank_account_id=$2
    UNION ALL
    SELECT 'commission-payment',pcp.id,pcp.date,'PLOT COMMISSION',
           CASE WHEN pcp.amount >= 0 THEN pcp.amount ELSE 0 END,
           CASE WHEN pcp.amount < 0 THEN ABS(pcp.amount) ELSE 0 END,
           pcp.payment_mode,COALESCE(pcp.transaction_id,pcp.remarks),pcp.status
      FROM plot_commission_payments pcp WHERE pcp.site_id=$1 AND pcp.bank_account_id=$2
    UNION ALL
    SELECT 'registry-payment',prp.id,prp.payment_date,'REGISTRY / NOC PAYMENT',
           CASE WHEN prp.amount < 0 THEN ABS(prp.amount) ELSE 0 END,
           CASE WHEN prp.amount >= 0 THEN prp.amount ELSE 0 END,
           prp.payment_mode,COALESCE(prp.cheque_no,prp.notes),'approved'
      FROM plot_registry_payments prp
     WHERE prp.site_id=$1 AND prp.bank_account_id=$2 AND prp.source_plot_payment_id IS NULL
  ) ledger`;

const ledgerForPeriod = async (db, siteId, accountId, start, end) => {
  const { rows } = await db.query(
    `${LEDGER_SQL}
      WHERE date >= $3::date AND date <= $4::date
      ORDER BY date,id`,
    [siteId, accountId, start, end],
  );
  return rows;
};

const loadReconciliationWorkspace = async ({ db = pool, siteId, accountId, month, reconciliationId }) => {
  const conditions = ['site_id=$1', 'bank_account_id=$2'];
  const params = [siteId, accountId];
  if (reconciliationId) {
    params.push(reconciliationId);
    conditions.push(`id=$${params.length}`);
  } else if (month) {
    params.push(month);
    conditions.push(`statement_month=$${params.length}::date`);
  }
  const { rows: batches } = await db.query(
    `SELECT * FROM bank_reconciliations
      WHERE ${conditions.join(' AND ')}
      ORDER BY statement_month DESC,id DESC LIMIT 1`,
    params,
  );
  const reconciliation = batches[0] || null;
  if (!reconciliation) {
    return {
      reconciliation: null,
      lines: [],
      ledger_unmatched: [],
      metrics: {
        total_lines: 0, matched_lines: 0, suggested_lines: 0, unmatched_lines: 0,
        ignored_lines: 0, ledger_unmatched: 0, progress: 0, difference: 0, can_close: false,
      },
    };
  }

  const [{ rows: lines }, ledgerRows] = await Promise.all([
    db.query(
      `SELECT l.*,u.name AS matched_by_name
         FROM bank_statement_lines l
         LEFT JOIN users u ON u.id=l.matched_by
        WHERE l.reconciliation_id=$1
        ORDER BY l.transaction_date,l.row_number,l.id`,
      [reconciliation.id],
    ),
    ledgerForPeriod(db, siteId, accountId, reconciliation.period_start, reconciliation.period_end),
  ]);
  const ledgerMap = new Map(ledgerRows.map((row) => [`${row.source}:${row.id}`, row]));
  const matchedKeys = new Set(
    lines
      .filter((line) => line.match_status === 'MATCHED' && line.matched_source && line.matched_source_id)
      .map((line) => `${line.matched_source}:${line.matched_source_id}`),
  );
  const ledgerUnmatched = ledgerRows.filter((row) => !matchedKeys.has(`${row.source}:${row.id}`));
  const count = (status) => lines.filter((line) => line.match_status === status).length;
  const ledgerDebit = ledgerRows.reduce((sum, row) => sum + Number(row.debit || 0), 0);
  const ledgerCredit = ledgerRows.reduce((sum, row) => sum + Number(row.credit || 0), 0);
  const difference = reconciliationDifference({
    statementDebit: reconciliation.statement_total_debit,
    statementCredit: reconciliation.statement_total_credit,
    ledgerDebit,
    ledgerCredit,
  });
  const computedClosing = roundMoney(
    Number(reconciliation.opening_balance || 0)
      + Number(reconciliation.statement_total_credit || 0)
      - Number(reconciliation.statement_total_debit || 0),
  );
  const closingVariance = reconciliation.closing_balance == null
    ? 0
    : roundMoney(Number(reconciliation.closing_balance) - computedClosing);
  const matched = count('MATCHED');
  const ignored = count('IGNORED');
  const suggested = count('SUGGESTED');
  const unmatched = count('UNMATCHED');
  const canClose = lines.length > 0
    && suggested === 0
    && unmatched === 0
    && ledgerUnmatched.length === 0
    && Math.abs(difference) < 0.01
    && Math.abs(closingVariance) < 0.01;

  return {
    reconciliation,
    lines: lines.map((line) => ({
      ...line,
      matched_transaction: line.matched_source && line.matched_source_id
        ? ledgerMap.get(`${line.matched_source}:${line.matched_source_id}`) || null
        : null,
    })),
    ledger_unmatched: ledgerUnmatched,
    metrics: {
      total_lines: lines.length,
      matched_lines: matched,
      suggested_lines: suggested,
      unmatched_lines: unmatched,
      ignored_lines: ignored,
      ledger_total_debit: roundMoney(ledgerDebit),
      ledger_total_credit: roundMoney(ledgerCredit),
      ledger_unmatched: ledgerUnmatched.length,
      difference: roundMoney(difference),
      computed_closing_balance: computedClosing,
      closing_variance: closingVariance,
      progress: reconciliationProgress({ matched, ignored, total: lines.length }),
      can_close: canClose,
    },
  };
};

export const listBankAccountOptions = asyncHandler(async (req, res) => {
  const siteId = positiveId(req.query.site_id);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  const { rows } = await pool.query(
    `SELECT id,label,bank_name,account_type,ifsc,vpa,payee_name,is_active,
            RIGHT(COALESCE(account_no,''),4) AS account_last4
       FROM upi_accounts
      WHERE site_id=$1 AND is_active=TRUE
      ORDER BY bank_name,label,id`,
    [siteId],
  );
  res.json({ accounts: rows });
});

export const listBankAccounts = asyncHandler(async (req, res) => {
  const siteId = positiveId(req.query.site_id);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  const [{ rows }, reconciliationResult] = await Promise.all([
    pool.query(ACCOUNT_SUMMARY_SQL, [siteId]),
    pool.query(
      `SELECT DISTINCT ON (r.bank_account_id)
              r.bank_account_id,r.id AS reconciliation_id,r.statement_month,r.status AS reconciliation_status,
              COUNT(l.id)::int AS statement_lines,
              COUNT(l.id) FILTER (WHERE l.match_status='MATCHED')::int AS matched_lines,
              COUNT(l.id) FILTER (WHERE l.match_status IN ('UNMATCHED','SUGGESTED'))::int AS exception_lines
         FROM bank_reconciliations r
         LEFT JOIN bank_statement_lines l ON l.reconciliation_id=r.id
        WHERE r.site_id=$1
        GROUP BY r.bank_account_id,r.id,r.statement_month,r.status
        ORDER BY r.bank_account_id,r.statement_month DESC,r.id DESC`,
      [siteId],
    ).catch((error) => {
      // Keep the account register usable while a deployment is between code
      // rollout and migration 127.
      if (error.code === '42P01') return { rows: [] };
      throw error;
    }),
  ]);
  const reconciliations = new Map(reconciliationResult.rows.map((row) => [Number(row.bank_account_id), row]));
  res.json({
    accounts: rows.map((row) => ({ ...publicAccount(row), ...(reconciliations.get(Number(row.id)) || {}) })),
  });
});

export const createBankAccount = asyncHandler(async (req, res) => {
  const siteId = positiveId(req.body.site_id);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  const payload = accountPayload(req.body);
  if (payload.account_no) {
    const duplicate = await pool.query(
      `SELECT 1 FROM upi_accounts WHERE site_id=$1 AND LOWER(account_no)=LOWER($2) LIMIT 1`,
      [siteId, payload.account_no],
    );
    if (duplicate.rows[0]) return res.status(409).json({ message: 'This account number is already configured for the Site' });
  }
  const keys = Object.keys(payload);
  const values = Object.values(payload);
  const { rows } = await pool.query(
    `INSERT INTO upi_accounts(site_id,${keys.join(',')},created_by)
     VALUES($1,${keys.map((_, index) => `$${index + 2}`).join(',')},$${keys.length + 2}) RETURNING *`,
    [siteId, ...values, req.user.id],
  );
  res.status(201).json({ account: publicAccount(rows[0]) });
});

export const updateBankAccount = asyncHandler(async (req, res) => {
  const id = positiveId(req.params.id);
  const payload = accountPayload(req.body, { partial: true });
  if (!id || Object.keys(payload).length === 0) return res.status(400).json({ message: 'Nothing to update' });
  if (payload.account_no) {
    const duplicate = await pool.query(
      `SELECT 1 FROM upi_accounts WHERE id<>$1 AND site_id=(SELECT site_id FROM upi_accounts WHERE id=$1) AND LOWER(account_no)=LOWER($2) LIMIT 1`,
      [id, payload.account_no],
    );
    if (duplicate.rows[0]) return res.status(409).json({ message: 'This account number is already configured for the Site' });
  }
  const sets = Object.keys(payload).map((key, index) => `${key}=$${index + 1}`);
  const { rows } = await pool.query(
    `UPDATE upi_accounts SET ${sets.join(',')},updated_at=NOW()
      WHERE id=$${sets.length + 1} RETURNING *`,
    [...Object.values(payload), id],
  );
  if (!rows[0]) return res.status(404).json({ message: 'Bank account not found' });
  res.json({ account: publicAccount(rows[0]) });
});

export const deleteBankAccount = asyncHandler(async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid bank account' });
  try {
    const { rows } = await pool.query('DELETE FROM upi_accounts WHERE id=$1 RETURNING id', [id]);
    if (!rows[0]) return res.status(404).json({ message: 'Bank account not found' });
    return res.json({ message: 'Bank account deleted' });
  } catch (error) {
    if (error.code !== '23503') throw error;
    await pool.query('UPDATE upi_accounts SET is_active=FALSE,updated_at=NOW() WHERE id=$1', [id]);
    return res.json({ message: 'Account has transaction history and was deactivated', deactivated: true });
  }
});

export const getBankAccountLedger = asyncHandler(async (req, res) => {
  const siteId = positiveId(req.query.site_id);
  const accountId = positiveId(req.params.id);
  const page = Math.max(positiveId(req.query.page) || 1, 1);
  const limit = Math.min(positiveId(req.query.limit) || 25, 100);
  if (!siteId || !accountId) return res.status(400).json({ message: 'A valid Site and bank account are required' });

  const accountResult = await pool.query(
    `SELECT * FROM upi_accounts WHERE id=$1 AND site_id=$2 LIMIT 1`,
    [accountId, siteId],
  );
  const account = accountResult.rows[0];
  if (!account) return res.status(404).json({ message: 'Bank account not found' });

  const params = [siteId, accountId];
  let where = '1=1';
  if (req.query.date_from) {
    params.push(req.query.date_from);
    where += ` AND date >= $${params.length}::date`;
  }
  if (req.query.date_to) {
    params.push(req.query.date_to);
    where += ` AND date <= $${params.length}::date`;
  }
  if (req.query.search) {
    params.push(`%${clean(req.query.search, 100).replace(/[\\%_]/g, '\\$&')}%`);
    where += ` AND (description ILIKE $${params.length} ESCAPE '\\' OR COALESCE(reference,'') ILIKE $${params.length} ESCAPE '\\')`;
  }

  const pageParams = [...params, limit, (page - 1) * limit];
  const [aggregate, { rows }] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(debit),0)::numeric AS total_debit,
              COALESCE(SUM(credit),0)::numeric AS total_credit
         FROM (${LEDGER_SQL} WHERE ${where}) scoped`,
      params,
    ),
    pool.query(
      `${LEDGER_SQL} WHERE ${where}
        ORDER BY date DESC,id DESC
        LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams,
    ),
  ]);
  const summary = aggregate.rows[0];
  res.json({
    account: publicAccount(account),
    transactions: rows,
    summary: {
      ...summary,
      balance: Number(summary.total_credit || 0) - Number(summary.total_debit || 0),
    },
    pagination: {
      currentPage: page,
      totalItems: summary.total,
      totalPages: Math.max(Math.ceil(summary.total / limit), 1),
      itemsPerPage: limit,
    },
  });
});

export const listBankReconciliations = asyncHandler(async (req, res) => {
  const siteId = positiveId(req.query.site_id);
  const accountId = positiveId(req.params.id);
  if (!siteId || !accountId) return res.status(400).json({ message: 'A valid Site and bank account are required' });
  const { rows } = await pool.query(
    `SELECT r.*,
            COUNT(l.id)::int AS total_lines,
            COUNT(l.id) FILTER (WHERE l.match_status='MATCHED')::int AS matched_lines,
            COUNT(l.id) FILTER (WHERE l.match_status='SUGGESTED')::int AS suggested_lines,
            COUNT(l.id) FILTER (WHERE l.match_status='UNMATCHED')::int AS unmatched_lines,
            COUNT(l.id) FILTER (WHERE l.match_status='IGNORED')::int AS ignored_lines,
            uploader.name AS uploaded_by_name,closer.name AS closed_by_name
       FROM bank_reconciliations r
       LEFT JOIN bank_statement_lines l ON l.reconciliation_id=r.id
       LEFT JOIN users uploader ON uploader.id=r.uploaded_by
       LEFT JOIN users closer ON closer.id=r.closed_by
      WHERE r.site_id=$1 AND r.bank_account_id=$2
      GROUP BY r.id,uploader.name,closer.name
      ORDER BY r.statement_month DESC,r.id DESC`,
    [siteId, accountId],
  );
  res.json({ reconciliations: rows });
});

export const getBankReconciliation = asyncHandler(async (req, res) => {
  const siteId = positiveId(req.query.site_id);
  const accountId = positiveId(req.params.id);
  const period = req.query.month ? monthPeriod(req.query.month) : null;
  if (!siteId || !accountId) return res.status(400).json({ message: 'A valid Site and bank account are required' });
  if (req.query.month && !period) return res.status(400).json({ message: 'month must use YYYY-MM format' });
  const workspace = await loadReconciliationWorkspace({
    siteId,
    accountId,
    month: period?.month,
    reconciliationId: positiveId(req.query.reconciliation_id),
  });
  res.json(workspace);
});

export const importBankStatement = asyncHandler(async (req, res) => {
  const siteId = positiveId(req.body.site_id);
  const accountId = positiveId(req.params.id);
  const period = monthPeriod(req.body.statement_month);
  const rawRows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!siteId || !accountId || !period) return res.status(400).json({ message: 'Site, bank account and statement month are required' });
  if (rawRows.length === 0 || rawRows.length > 5000) return res.status(400).json({ message: 'Statement must contain between 1 and 5,000 rows' });

  const parsedRows = rawRows.map((row, index) => statementLinePayload(row, index, period)).filter(Boolean);
  if (!parsedRows.length) return res.status(400).json({ message: 'No valid statement rows were found for the selected month' });
  const skippedRows = rawRows.length - parsedRows.length;
  const openingBalance = roundMoney(req.body.opening_balance);
  const closingBalance = req.body.closing_balance === '' || req.body.closing_balance == null
    ? null
    : roundMoney(req.body.closing_balance);
  const statementDebit = roundMoney(parsedRows.reduce((sum, row) => sum + row.debit, 0));
  const statementCredit = roundMoney(parsedRows.reduce((sum, row) => sum + row.credit, 0));

  const client = await pool.connect();
  let reconciliationId;
  try {
    await client.query('BEGIN');
    const account = await client.query('SELECT id FROM upi_accounts WHERE id=$1 AND site_id=$2 FOR UPDATE', [accountId, siteId]);
    if (!account.rows[0]) {
      const error = new Error('Bank account not found');
      error.status = 404;
      throw error;
    }
    const existing = await client.query(
      'SELECT id,status FROM bank_reconciliations WHERE bank_account_id=$1 AND statement_month=$2::date FOR UPDATE',
      [accountId, period.month],
    );
    if (existing.rows[0]?.status === 'CLOSED') {
      const error = new Error('This month is closed. Reopen it before replacing the statement.');
      error.status = 409;
      throw error;
    }

    if (existing.rows[0]) {
      reconciliationId = existing.rows[0].id;
      await client.query('DELETE FROM bank_statement_lines WHERE reconciliation_id=$1', [reconciliationId]);
      await client.query(
        `UPDATE bank_reconciliations
            SET period_start=$1,period_end=$2,file_name=$3,opening_balance=$4,closing_balance=$5,
                statement_total_debit=$6,statement_total_credit=$7,status='IN_PROGRESS',notes=$8,
                uploaded_by=$9,closed_by=NULL,closed_at=NULL,updated_at=NOW()
          WHERE id=$10`,
        [period.start, period.end, clean(req.body.file_name, 255) || null, openingBalance, closingBalance,
          statementDebit, statementCredit, clean(req.body.notes, 1000) || null, req.user.id, reconciliationId],
      );
    } else {
      const created = await client.query(
        `INSERT INTO bank_reconciliations(
           site_id,bank_account_id,statement_month,period_start,period_end,file_name,opening_balance,
           closing_balance,statement_total_debit,statement_total_credit,status,notes,uploaded_by
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'IN_PROGRESS',$11,$12) RETURNING id`,
        [siteId, accountId, period.month, period.start, period.end, clean(req.body.file_name, 255) || null,
          openingBalance, closingBalance, statementDebit, statementCredit, clean(req.body.notes, 1000) || null, req.user.id],
      );
      reconciliationId = created.rows[0].id;
    }

    const [ledgerRows, reservedResult] = await Promise.all([
      ledgerForPeriod(client, siteId, accountId, period.start, period.end),
      client.query(
        `SELECT matched_source,matched_source_id FROM bank_statement_lines
          WHERE bank_account_id=$1 AND reconciliation_id<>$2 AND match_status='MATCHED'`,
        [accountId, reconciliationId],
      ),
    ]);
    const reserved = new Set(reservedResult.rows.map((row) => `${row.matched_source}:${row.matched_source_id}`));
    const matchedRows = autoMatchStatementLines(parsedRows, ledgerRows, reserved);
    await client.query(
      `INSERT INTO bank_statement_lines(
         reconciliation_id,site_id,bank_account_id,row_number,transaction_date,value_date,description,reference,
         debit,credit,running_balance,match_status,matched_source,matched_source_id,match_confidence,match_note,
         matched_by,matched_at
       )
       SELECT $1,$2,$3,x.row_number,x.transaction_date::date,x.value_date::date,x.description,x.reference,
              x.debit,x.credit,x.running_balance,x.match_status,x.matched_source,x.matched_source_id,
              x.match_confidence,x.match_note,
              CASE WHEN x.match_status='MATCHED' THEN $4 ELSE NULL END,
              CASE WHEN x.match_status='MATCHED' THEN NOW() ELSE NULL END
         FROM jsonb_to_recordset($5::jsonb) AS x(
           row_number integer,transaction_date text,value_date text,description text,reference text,
           debit numeric,credit numeric,running_balance numeric,match_status text,matched_source text,
           matched_source_id bigint,match_confidence integer,match_note text
         )`,
      [reconciliationId, siteId, accountId, req.user.id, JSON.stringify(matchedRows)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.status) return res.status(error.status).json({ message: error.message });
    throw error;
  } finally {
    client.release();
  }

  const workspace = await loadReconciliationWorkspace({ siteId, accountId, reconciliationId });
  res.status(201).json({ ...workspace, import_summary: { received: rawRows.length, imported: parsedRows.length, skipped: skippedRows } });
});

export const autoReconcileBankStatement = asyncHandler(async (req, res) => {
  const siteId = positiveId(req.body.site_id);
  const accountId = positiveId(req.params.id);
  const reconciliationId = positiveId(req.params.reconciliationId);
  if (!siteId || !accountId || !reconciliationId) return res.status(400).json({ message: 'Valid reconciliation details are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: batches } = await client.query(
      `SELECT * FROM bank_reconciliations WHERE id=$1 AND site_id=$2 AND bank_account_id=$3 FOR UPDATE`,
      [reconciliationId, siteId, accountId],
    );
    const batch = batches[0];
    if (!batch) throw Object.assign(new Error('Reconciliation not found'), { status: 404 });
    if (batch.status === 'CLOSED') throw Object.assign(new Error('Closed reconciliation cannot be changed'), { status: 409 });
    const [{ rows: candidates }, ledgerRows, { rows: reservedRows }] = await Promise.all([
      client.query(
        `SELECT id,transaction_date,description,reference,debit,credit
           FROM bank_statement_lines
          WHERE reconciliation_id=$1 AND match_status IN ('UNMATCHED','SUGGESTED')
          ORDER BY row_number`,
        [reconciliationId],
      ),
      ledgerForPeriod(client, siteId, accountId, batch.period_start, batch.period_end),
      client.query(
        `SELECT matched_source,matched_source_id FROM bank_statement_lines
          WHERE bank_account_id=$1 AND match_status='MATCHED'`,
        [accountId],
      ),
    ]);
    const reserved = new Set(reservedRows.map((row) => `${row.matched_source}:${row.matched_source_id}`));
    const matches = autoMatchStatementLines(candidates, ledgerRows, reserved);
    await client.query(
      `UPDATE bank_statement_lines l
          SET match_status=x.match_status,matched_source=x.matched_source,matched_source_id=x.matched_source_id,
              match_confidence=x.match_confidence,match_note=x.match_note,
              matched_by=CASE WHEN x.match_status='MATCHED' THEN $1 ELSE NULL END,
              matched_at=CASE WHEN x.match_status='MATCHED' THEN NOW() ELSE NULL END,updated_at=NOW()
         FROM jsonb_to_recordset($2::jsonb) AS x(
           id bigint,match_status text,matched_source text,matched_source_id bigint,match_confidence integer,match_note text
         )
        WHERE l.id=x.id AND l.reconciliation_id=$3`,
      [req.user.id, JSON.stringify(matches), reconciliationId],
    );
    await client.query('UPDATE bank_reconciliations SET status=\'IN_PROGRESS\',updated_at=NOW() WHERE id=$1', [reconciliationId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.status) return res.status(error.status).json({ message: error.message });
    throw error;
  } finally { client.release(); }

  res.json(await loadReconciliationWorkspace({ siteId, accountId, reconciliationId }));
});

export const updateBankStatementLineMatch = asyncHandler(async (req, res) => {
  const siteId = positiveId(req.body.site_id);
  const accountId = positiveId(req.params.id);
  const reconciliationId = positiveId(req.params.reconciliationId);
  const lineId = positiveId(req.params.lineId);
  const action = String(req.body.action || '').toLowerCase();
  if (!siteId || !accountId || !reconciliationId || !lineId) return res.status(400).json({ message: 'Valid reconciliation details are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT l.*,r.period_start,r.period_end,r.status AS reconciliation_status
         FROM bank_statement_lines l JOIN bank_reconciliations r ON r.id=l.reconciliation_id
        WHERE l.id=$1 AND l.reconciliation_id=$2 AND l.site_id=$3 AND l.bank_account_id=$4 FOR UPDATE`,
      [lineId, reconciliationId, siteId, accountId],
    );
    const line = rows[0];
    if (!line) throw Object.assign(new Error('Statement line not found'), { status: 404 });
    if (line.reconciliation_status === 'CLOSED') throw Object.assign(new Error('Closed reconciliation cannot be changed'), { status: 409 });

    if (action === 'clear') {
      await client.query(
        `UPDATE bank_statement_lines SET match_status='UNMATCHED',matched_source=NULL,matched_source_id=NULL,
          match_confidence=NULL,match_note=NULL,matched_by=NULL,matched_at=NULL,updated_at=NOW() WHERE id=$1`,
        [lineId],
      );
    } else if (action === 'ignore') {
      await client.query(
        `UPDATE bank_statement_lines SET match_status='IGNORED',matched_source=NULL,matched_source_id=NULL,
          match_confidence=NULL,match_note=$2,matched_by=$3,matched_at=NOW(),updated_at=NOW() WHERE id=$1`,
        [lineId, clean(req.body.note, 500) || 'Ignored during reconciliation', req.user.id],
      );
    } else if (action === 'accept' || action === 'match') {
      const source = action === 'accept' ? line.matched_source : clean(req.body.source, 60);
      const sourceId = action === 'accept' ? positiveId(line.matched_source_id) : positiveId(req.body.source_id);
      if (!source || !sourceId) throw Object.assign(new Error('Select a ledger transaction to match'), { status: 400 });
      const ledgerRows = await ledgerForPeriod(client, siteId, accountId, line.period_start, line.period_end);
      const candidate = ledgerRows.find((row) => row.source === source && Number(row.id) === Number(sourceId));
      if (!candidate) throw Object.assign(new Error('Selected ledger transaction is outside this account or statement period'), { status: 409 });
      await client.query(
        `UPDATE bank_statement_lines SET match_status='MATCHED',matched_source=$2,matched_source_id=$3,
          match_confidence=$4,match_note=$5,matched_by=$6,matched_at=NOW(),updated_at=NOW() WHERE id=$1`,
        [lineId, source, sourceId, action === 'accept' ? (line.match_confidence || 80) : 100,
          clean(req.body.note, 500) || (action === 'accept' ? 'Suggested match accepted' : 'Manually matched'), req.user.id],
      );
    } else {
      throw Object.assign(new Error('action must be accept, match, clear or ignore'), { status: 400 });
    }
    await client.query('UPDATE bank_reconciliations SET status=\'IN_PROGRESS\',updated_at=NOW() WHERE id=$1', [reconciliationId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return res.status(409).json({ message: 'That ledger transaction is already matched to another statement line' });
    if (error.status) return res.status(error.status).json({ message: error.message });
    throw error;
  } finally { client.release(); }

  res.json(await loadReconciliationWorkspace({ siteId, accountId, reconciliationId }));
});

export const closeBankReconciliation = asyncHandler(async (req, res) => {
  const siteId = positiveId(req.body.site_id);
  const accountId = positiveId(req.params.id);
  const reconciliationId = positiveId(req.params.reconciliationId);
  const workspace = await loadReconciliationWorkspace({ siteId, accountId, reconciliationId });
  if (!workspace.reconciliation) return res.status(404).json({ message: 'Reconciliation not found' });
  if (!workspace.metrics.can_close) {
    return res.status(409).json({
      message: 'Resolve statement exceptions, unmatched ledger entries, and balance differences before closing the month',
      metrics: workspace.metrics,
    });
  }
  await pool.query(
    `UPDATE bank_reconciliations SET status='CLOSED',closed_by=$1,closed_at=NOW(),updated_at=NOW()
      WHERE id=$2 AND site_id=$3 AND bank_account_id=$4`,
    [req.user.id, reconciliationId, siteId, accountId],
  );
  res.json(await loadReconciliationWorkspace({ siteId, accountId, reconciliationId }));
});

export const reopenBankReconciliation = asyncHandler(async (req, res) => {
  const siteId = positiveId(req.body.site_id);
  const accountId = positiveId(req.params.id);
  const reconciliationId = positiveId(req.params.reconciliationId);
  const { rowCount } = await pool.query(
    `UPDATE bank_reconciliations SET status='IN_PROGRESS',closed_by=NULL,closed_at=NULL,updated_at=NOW()
      WHERE id=$1 AND site_id=$2 AND bank_account_id=$3`,
    [reconciliationId, siteId, accountId],
  );
  if (!rowCount) return res.status(404).json({ message: 'Reconciliation not found' });
  res.json(await loadReconciliationWorkspace({ siteId, accountId, reconciliationId }));
});

export const createBankAdjustment = asyncHandler(async (req, res) => {
  const siteId = positiveId(req.body.site_id);
  const accountId = positiveId(req.params.id);
  const date = cleanDate(req.body.date);
  const direction = String(req.body.direction || '').toLowerCase();
  const amount = Math.abs(roundMoney(req.body.amount));
  const description = clean(req.body.description, 200);
  const mode = clean(req.body.payment_mode || 'BANK', 30).toUpperCase();
  if (!siteId || !accountId || !date || !description || !amount || !['debit', 'credit'].includes(direction)) {
    return res.status(400).json({ message: 'Date, direction, amount and description are required' });
  }
  if (mode === 'CASH') return res.status(400).json({ message: 'Bank adjustments must use a non-cash mode' });
  const account = await pool.query('SELECT id FROM upi_accounts WHERE id=$1 AND site_id=$2 AND is_active=TRUE', [accountId, siteId]);
  if (!account.rows[0]) return res.status(409).json({ message: 'Bank account is inactive or unavailable' });
  const { rows } = await pool.query(
    `INSERT INTO day_book(site_id,date,particular,entry_type,debit,credit,remarks,payment_mode,category,created_by,bank_account_id)
     VALUES($1,$2,$3,'BANK ADJUSTMENT',$4,$5,$6,$7,'RECONCILIATION',$8,$9) RETURNING *`,
    [siteId, date, description.toUpperCase(), direction === 'debit' ? amount : 0, direction === 'credit' ? amount : 0,
      clean(req.body.reference, 500) || null, mode, req.user.id, accountId],
  );
  res.status(201).json({ transaction: rows[0], message: 'Bank adjustment added to the unified ledger' });
});
