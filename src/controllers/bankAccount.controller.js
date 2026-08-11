import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { maskAccountNumber } from '../services/bankAccount.service.js';

const VPA_RE = /^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const clean = (value, max) => String(value ?? '').trim().slice(0, max);
const positiveId = (value) => {
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
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
  const { rows } = await pool.query(ACCOUNT_SUMMARY_SQL, [siteId]);
  res.json({
    accounts: rows.map(publicAccount),
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
