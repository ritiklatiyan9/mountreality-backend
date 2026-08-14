import { createHash } from 'node:crypto';

const CASH_PREFIX = /^CASH(?:[\s_-]|$)/i;
const INVALID_CHEQUE_STATES = new Set(['BOUNCED', 'RETURNED']);

const normalizedText = (value) => String(value ?? '').trim();

/**
 * Mirrors the database's ledger_bucket policy for the RERA evidence boundary:
 * only an explicitly cash-prefixed mode is physical cash; all other modes are
 * bank-book modes. Approval and cheque validity remain independent gates.
 */
export const isEligibleReraBankEntry = (entry) => (
  normalizedText(entry?.status).toLowerCase() === 'approved'
  && !CASH_PREFIX.test(normalizedText(entry?.payment_mode))
  && !INVALID_CHEQUE_STATES.has(normalizedText(entry?.cheque_status).toUpperCase())
);

export const reraFinanceRequestFingerprint = (kind, fields) => createHash('sha256')
  .update(JSON.stringify([kind, ...fields]))
  .digest('hex');

export const projectPhaseRequired = (project, phaseId) => (
  project?.has_phases === true && phaseId == null
);

