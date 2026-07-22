import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';

// ══════════════════════════════════════════════════
//  UPI COLLECT — bank accounts (VPA) + dynamic QR log
// ══════════════════════════════════════════════════

const VPA_RE = /^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/;

/**
 * GET /upi/accounts?site_id=X
 */
export const listAccounts = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const result = await pool.query(
    `SELECT a.*, u.name as created_by_name
     FROM upi_accounts a
     LEFT JOIN users u ON a.created_by = u.id
     WHERE a.site_id = $1
     ORDER BY a.is_active DESC, a.id ASC`,
    [parseInt(site_id)]
  );
  res.json({ accounts: result.rows });
});

/**
 * POST /upi/accounts
 */
export const createAccount = asyncHandler(async (req, res) => {
  const { site_id, label, payee_name, vpa, bank_name, account_no, ifsc } = req.body;
  if (!site_id || !label?.trim() || !payee_name?.trim() || !vpa?.trim()) {
    return res.status(400).json({ message: 'site_id, label, payee_name and vpa are required' });
  }
  const cleanVpa = vpa.trim().toLowerCase();
  if (!VPA_RE.test(cleanVpa)) {
    return res.status(400).json({ message: 'Invalid VPA / UPI ID (expected format: name@bank)' });
  }
  const result = await pool.query(
    `INSERT INTO upi_accounts (site_id, label, payee_name, vpa, bank_name, account_no, ifsc, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      parseInt(site_id), label.trim(), payee_name.trim(), cleanVpa,
      bank_name?.trim() || null, account_no?.trim() || null,
      ifsc?.trim().toUpperCase() || null, req.user.id,
    ]
  );
  res.status(201).json({ account: result.rows[0] });
});

/**
 * PUT /upi/accounts/:id
 */
export const updateAccount = asyncHandler(async (req, res) => {
  const { label, payee_name, vpa, bank_name, account_no, ifsc, is_active } = req.body;
  const sets = [];
  const params = [];
  let i = 1;
  const set = (col, val) => { sets.push(`${col} = $${i++}`); params.push(val); };

  if (label !== undefined) set('label', label.trim());
  if (payee_name !== undefined) set('payee_name', payee_name.trim());
  if (vpa !== undefined) {
    const cleanVpa = String(vpa).trim().toLowerCase();
    if (!VPA_RE.test(cleanVpa)) {
      return res.status(400).json({ message: 'Invalid VPA / UPI ID (expected format: name@bank)' });
    }
    set('vpa', cleanVpa);
  }
  if (bank_name !== undefined) set('bank_name', bank_name?.trim() || null);
  if (account_no !== undefined) set('account_no', account_no?.trim() || null);
  if (ifsc !== undefined) set('ifsc', ifsc?.trim().toUpperCase() || null);
  if (is_active !== undefined) set('is_active', !!is_active);

  if (!sets.length) return res.status(400).json({ message: 'Nothing to update' });
  sets.push(`updated_at = NOW()`);
  params.push(parseInt(req.params.id));

  const result = await pool.query(
    `UPDATE upi_accounts SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    params
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Account not found' });
  res.json({ account: result.rows[0] });
});

/**
 * DELETE /upi/accounts/:id
 * Accounts referenced by QRs can't be hard-deleted (FK) — deactivate instead.
 */
export const deleteAccount = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const result = await pool.query(`DELETE FROM upi_accounts WHERE id = $1 RETURNING id`, [id]);
    if (!result.rows[0]) return res.status(404).json({ message: 'Account not found' });
    return res.json({ message: 'Account deleted' });
  } catch (err) {
    if (err.code === '23503') {
      await pool.query(`UPDATE upi_accounts SET is_active = false, updated_at = NOW() WHERE id = $1`, [id]);
      return res.json({ message: 'Account has QR history — deactivated instead of deleted', deactivated: true });
    }
    throw err;
  }
});

/**
 * POST /upi/qrs
 * Logs a dynamic QR request; the QR image itself is rendered client-side
 * from the returned row (vpa + payee_name + amount + txn_ref).
 */
export const createQr = asyncHandler(async (req, res) => {
  const { site_id, upi_account_id, amount, note } = req.body;
  const amt = parseFloat(amount);
  if (!site_id || !upi_account_id || !Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ message: 'site_id, upi_account_id and a positive amount are required' });
  }
  const acc = (await pool.query(
    `SELECT * FROM upi_accounts WHERE id = $1 AND site_id = $2 AND is_active = true`,
    [parseInt(upi_account_id), parseInt(site_id)]
  )).rows[0];
  if (!acc) return res.status(404).json({ message: 'Active UPI account not found for this site' });

  const txnRef = `DGQ${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1296).toString(36).toUpperCase()}`;
  const result = await pool.query(
    `INSERT INTO payment_qrs (site_id, upi_account_id, amount, note, txn_ref, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [parseInt(site_id), acc.id, amt.toFixed(2), note?.trim() || null, txnRef, req.user.id]
  );
  res.status(201).json({ qr: { ...result.rows[0], vpa: acc.vpa, payee_name: acc.payee_name, account_label: acc.label } });
});

/**
 * GET /upi/qrs?site_id=X&status=pending&page=1&limit=10
 */
export const listQrs = asyncHandler(async (req, res) => {
  const { site_id, status, page = 1, limit = 10 } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const safeLimit = Math.min(Math.max(parseInt(limit) || 10, 1), 200);
  const safePage = Math.max(parseInt(page) || 1, 1);

  const params = [parseInt(site_id)];
  let where = 'q.site_id = $1';
  if (status && status !== 'all') { params.push(status); where += ` AND q.status = $2`; }

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM payment_qrs q WHERE ${where}`,
    params
  );
  const totalItems = countResult.rows[0].total;

  params.push(safeLimit, (safePage - 1) * safeLimit);
  const result = await pool.query(
    `SELECT q.*, a.label as account_label, a.vpa, a.payee_name, u.name as created_by_name
     FROM payment_qrs q
     JOIN upi_accounts a ON q.upi_account_id = a.id
     LEFT JOIN users u ON q.created_by = u.id
     WHERE ${where}
     ORDER BY q.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({
    qrs: result.rows,
    pagination: {
      totalItems,
      totalPages: Math.max(Math.ceil(totalItems / safeLimit), 1),
      currentPage: safePage,
      itemsPerPage: safeLimit,
    },
  });
});

/**
 * PUT /upi/qrs/:id — edit amount/note (pending QRs only; the QR image is
 * re-rendered client-side from the updated row).
 */
export const updateQr = asyncHandler(async (req, res) => {
  const { amount, note } = req.body;
  const id = parseInt(req.params.id);
  const existing = (await pool.query(`SELECT * FROM payment_qrs WHERE id = $1`, [id])).rows[0];
  if (!existing) return res.status(404).json({ message: 'QR not found' });
  if (existing.status !== 'pending') {
    return res.status(400).json({ message: 'Only pending QRs can be edited' });
  }

  const sets = [];
  const params = [];
  let i = 1;
  if (amount !== undefined) {
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ message: 'Amount must be a positive number' });
    sets.push(`amount = $${i++}`);
    params.push(amt.toFixed(2));
  }
  if (note !== undefined) {
    sets.push(`note = $${i++}`);
    params.push(note?.trim() || null);
  }
  if (!sets.length) return res.status(400).json({ message: 'Nothing to update' });
  params.push(id);

  const result = await pool.query(
    `UPDATE payment_qrs SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    params
  );
  const acc = (await pool.query(`SELECT label, vpa, payee_name FROM upi_accounts WHERE id = $1`, [result.rows[0].upi_account_id])).rows[0];
  res.json({ qr: { ...result.rows[0], account_label: acc.label, vpa: acc.vpa, payee_name: acc.payee_name } });
});

/**
 * DELETE /upi/qrs/:id
 */
export const deleteQr = asyncHandler(async (req, res) => {
  const result = await pool.query(`DELETE FROM payment_qrs WHERE id = $1 RETURNING id`, [parseInt(req.params.id)]);
  if (!result.rows[0]) return res.status(404).json({ message: 'QR not found' });
  res.json({ message: 'QR deleted' });
});

/**
 * PUT /upi/qrs/:id/status  { status: 'received' | 'cancelled' | 'pending' }
 */
export const updateQrStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['received', 'cancelled', 'pending'].includes(status)) {
    return res.status(400).json({ message: 'status must be received, cancelled or pending' });
  }
  const result = await pool.query(
    `UPDATE payment_qrs
     SET status = $1, received_at = CASE WHEN $2 THEN NOW() ELSE NULL END
     WHERE id = $3 RETURNING *`,
    [status, status === 'received', parseInt(req.params.id)]
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'QR not found' });
  res.json({ qr: result.rows[0] });
});

/**
 * GET /upi/qrs/display?site_id=X
 * Latest pending QR with everything needed to render it — built for the
 * outside-office display screen to poll.
 */
export const getDisplayQr = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const result = await pool.query(
    `SELECT q.*, a.label as account_label, a.vpa, a.payee_name
     FROM payment_qrs q
     JOIN upi_accounts a ON q.upi_account_id = a.id
     WHERE q.site_id = $1 AND q.status = 'pending'
     ORDER BY q.id DESC
     LIMIT 1`,
    [parseInt(site_id)]
  );
  res.json({ qr: result.rows[0] || null });
});
