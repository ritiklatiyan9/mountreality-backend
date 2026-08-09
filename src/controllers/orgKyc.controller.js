import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { isValidGstin, normaliseGstin } from '../utils/gstin.js';

/* ── Company KYC ──────────────────────────────────────────────────────
   One row per tenant. The client drives a five-step wizard, but the API
   is a single upsert: partial saves are the whole point, since a user
   who fills two steps and closes the tab must not lose them.

   `isComplete` is computed here rather than trusted from the client —
   it is what silences the reminder modal, so the browser must not get to
   decide it. ── */

const REQUIRED = [
  'company_name',
  'registered_address',
  'communication_address',
  'director_name',
  'director_phone',
];

/** Every required field present and non-blank. */
export const isKycComplete = (row) =>
  !!row && REQUIRED.every((field) => String(row[field] ?? '').trim().length > 0);

/** Shape sent to the client, with the derived flags it renders from. */
export const presentKyc = (row) => {
  if (!row) return { status: 'pending', is_complete: false, steps_done: 0, steps_total: REQUIRED.length };
  const done = REQUIRED.filter((f) => String(row[f] ?? '').trim().length > 0).length;
  return {
    ...row,
    registered_lat: row.registered_lat === null ? null : Number(row.registered_lat),
    registered_lng: row.registered_lng === null ? null : Number(row.registered_lng),
    is_complete: isKycComplete(row),
    steps_done: done,
    steps_total: REQUIRED.length,
  };
};

/** Row for a tenant, creating the pending shell on first read. */
export const loadKyc = async (organizationId) => {
  if (!organizationId) return null;
  const { rows } = await pool.query(
    `INSERT INTO organization_kyc (organization_id)
     VALUES ($1) ON CONFLICT (organization_id) DO UPDATE SET organization_id = EXCLUDED.organization_id
     RETURNING *`,
    [organizationId]
  );
  return rows[0];
};

/** GET /org/kyc */
export const getKyc = asyncHandler(async (req, res) => {
  const row = await loadKyc(req.user.organization_id);
  res.json({ kyc: presentKyc(row) });
});

/* PUT /org/kyc — partial upsert. Only admins may write: KYC is the
   company's legal identity, not a personal profile setting. */
const WRITABLE = [
  'company_name', 'gst_number', 'registered_address', 'registered_lat', 'registered_lng',
  'communication_address', 'same_as_registered', 'director_name', 'director_phone',
];

const clean = (value) => (typeof value === 'string' ? value.trim() : value);

export const updateKyc = asyncHandler(async (req, res) => {
  const organizationId = req.user.organization_id;
  if (!organizationId) return res.status(400).json({ message: 'No organization on this account' });

  const current = await loadKyc(organizationId);
  if (current.status === 'verified') {
    return res.status(409).json({ message: 'KYC is already verified and can no longer be edited' });
  }

  const sets = [];
  const values = [];
  for (const field of WRITABLE) {
    if (req.body[field] === undefined) continue;
    let value = clean(req.body[field]);
    if (field === 'registered_lat' || field === 'registered_lng') {
      value = value === null || value === '' ? null : Number(value);
      if (value !== null && !Number.isFinite(value)) {
        return res.status(400).json({ message: `${field} must be a number` });
      }
      // Out-of-range coordinates mean a broken picker, not a valid pin.
      const limit = field === 'registered_lat' ? 90 : 180;
      if (value !== null && Math.abs(value) > limit) {
        return res.status(400).json({ message: `${field} is out of range` });
      }
    }
    if (field === 'same_as_registered') value = !!value;
    if (field === 'gst_number') {
      // Blank is a valid answer — it is optional. Anything else must be a
      // real GSTIN, checksum included.
      value = normaliseGstin(value);
      if (value === '') {
        value = null;
      } else if (!isValidGstin(value)) {
        return res.status(400).json({ message: 'That GSTIN does not look right. Check the 15 characters and try again.' });
      }
    }
    if (field === 'director_phone' && value) {
      const digits = String(value).replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) {
        return res.status(400).json({ message: 'Enter a valid contact number' });
      }
    }
    values.push(value);
    sets.push(`${field} = $${values.length}`);
  }

  if (!sets.length) return res.status(400).json({ message: 'Nothing to update' });

  // Mirroring here rather than in the client keeps the two addresses in
  // step even when the box is ticked on one device and edited on another.
  const merged = { ...current, ...Object.fromEntries(WRITABLE.map((f, i) => [f, req.body[f] !== undefined ? clean(req.body[f]) : current[f]])) };
  if (merged.same_as_registered) {
    values.push(merged.registered_address || '');
    sets.push(`communication_address = $${values.length}`);
  }

  values.push(organizationId);
  const { rows } = await pool.query(
    `UPDATE organization_kyc SET ${sets.join(', ')}, updated_at = NOW()
     WHERE organization_id = $${values.length} RETURNING *`,
    values
  );

  res.json({ kyc: presentKyc(rows[0]) });
});

/* POST /org/kyc/submit — lock it in for review. Re-validates server-side
   because the submit button's enabled state is a client-side opinion. */
export const submitKyc = asyncHandler(async (req, res) => {
  const current = await loadKyc(req.user.organization_id);
  if (!isKycComplete(current)) {
    return res.status(400).json({ message: 'Complete every step before submitting' });
  }
  if (current.status === 'verified') {
    return res.json({ kyc: presentKyc(current) });
  }

  const { rows } = await pool.query(
    `UPDATE organization_kyc
        SET status = 'submitted', submitted_at = NOW(), review_note = NULL, updated_at = NOW()
      WHERE organization_id = $1 RETURNING *`,
    [req.user.organization_id]
  );
  res.json({ kyc: presentKyc(rows[0]), message: 'KYC submitted for review' });
});
