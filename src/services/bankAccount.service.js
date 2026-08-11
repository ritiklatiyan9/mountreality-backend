import pool from '../config/db.js';
import { classifyPaymentMode } from '../utils/paymentMode.js';

const positiveId = (value) => {
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

export const resolveBankAccountSelection = async ({
  siteId,
  paymentMode,
  bankAccountId,
  db = pool,
  required = true,
}) => {
  if (!String(paymentMode ?? '').trim()) return null;
  if (classifyPaymentMode(paymentMode) === 'cash') return null;

  const accountId = positiveId(bankAccountId);
  if (!accountId) {
    if (required) {
      const error = new Error('Select a bank account for this non-cash transaction');
      error.status = 400;
      error.code = 'BANK_ACCOUNT_REQUIRED';
      throw error;
    }
    return null;
  }

  const normalizedSiteId = positiveId(siteId);
  if (!normalizedSiteId) {
    const error = new Error('A valid site is required before selecting a bank account');
    error.status = 400;
    throw error;
  }

  const { rows } = await db.query(
    `SELECT id,site_id,label,bank_name,account_no,ifsc,is_active
       FROM upi_accounts
      WHERE id=$1 AND site_id=$2
      LIMIT 1`,
    [accountId, normalizedSiteId],
  );
  const account = rows[0];
  if (!account) {
    const error = new Error('Selected bank account does not belong to this Site');
    error.status = 409;
    error.code = 'BANK_ACCOUNT_SCOPE_MISMATCH';
    throw error;
  }
  if (!account.is_active) {
    const error = new Error('Selected bank account is inactive');
    error.status = 409;
    error.code = 'BANK_ACCOUNT_INACTIVE';
    throw error;
  }
  return account.id;
};

export const maskAccountNumber = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return `•••• ${raw.slice(-4)}`;
};
