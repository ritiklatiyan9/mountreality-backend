import asyncHandler from '../utils/asyncHandler.js';
import balanceSheetModel from '../models/BalanceSheet.model.js';
import pool from '../config/db.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_SCOPES = new Set(['all', 'cash', 'bank']);
const VALID_DIRECTIONS = new Set(['all', 'credit', 'debit']);
const VALID_MODES = new Set(['all', 'cash', 'bank', 'cheque']);

const todayInIndia = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const shiftIsoDays = (iso, days) => {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const previousYearIso = (iso) => {
  const [year, month, day] = iso.split('-').map(Number);
  const candidate = new Date(Date.UTC(year - 1, month - 1, day));
  // 29 February becomes 1 March in a non-leap year; CA comparatives should
  // use the final valid day of the same month instead.
  if (candidate.getUTCMonth() !== month - 1) candidate.setUTCDate(0);
  return candidate.toISOString().slice(0, 10);
};

const presetRange = (preset) => {
  const today = todayInIndia();
  const [year, month] = today.split('-').map(Number);

  if (preset === 'today') return { dateFrom: today, dateTo: today };
  if (preset === 'week') {
    const day = new Date(`${today}T12:00:00Z`).getUTCDay() || 7;
    return { dateFrom: shiftIsoDays(today, 1 - day), dateTo: today };
  }
  if (preset === 'month') return { dateFrom: `${year}-${String(month).padStart(2, '0')}-01`, dateTo: today };
  if (preset === 'year') return { dateFrom: `${year}-01-01`, dateTo: today };
  return { dateFrom: null, dateTo: null };
};

export const getBalanceSheet = asyncHandler(async (req, res) => {
  const siteId = Number.parseInt(req.query.site_id, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return res.status(400).json({ message: 'A valid site_id is required' });
  }

  const scope = VALID_SCOPES.has(req.query.scope) ? req.query.scope : 'all';
  const direction = VALID_DIRECTIONS.has(req.query.direction) ? req.query.direction : 'all';
  const paymentMode = VALID_MODES.has(req.query.payment_mode) ? req.query.payment_mode : 'all';
  const source = String(req.query.source || 'all').trim().slice(0, 80) || 'all';
  const search = String(req.query.q || '').trim().slice(0, 120);
  const preset = String(req.query.preset || 'overall').toLowerCase();

  let { dateFrom, dateTo } = presetRange(preset);
  if (req.query.date) {
    if (!DATE_RE.test(req.query.date)) return res.status(400).json({ message: 'date must be YYYY-MM-DD' });
    dateFrom = req.query.date;
    dateTo = req.query.date;
  }
  if (req.query.date_from || req.query.date_to) {
    dateFrom = req.query.date_from || null;
    dateTo = req.query.date_to || null;
    if ((dateFrom && !DATE_RE.test(dateFrom)) || (dateTo && !DATE_RE.test(dateTo))) {
      return res.status(400).json({ message: 'date_from and date_to must be YYYY-MM-DD' });
    }
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    return res.status(400).json({ message: 'date_from cannot be after date_to' });
  }

  // Statements are also used by Day Book's Overall print and Excel exports.
  // Keep a generous safety ceiling while allowing those exports to include all
  // normal accounting history rather than a truncated on-screen subset.
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 2500, 1), 100000);
  const rangeDays = dateFrom && dateTo
    ? Math.ceil((new Date(`${dateTo}T00:00:00`) - new Date(`${dateFrom}T00:00:00`)) / 86400000) + 1
    : null;
  const grain = rangeDays !== null && rangeDays <= 62 ? 'day' : 'month';

  const organizationId = Number(req.user?.organization_id);
  const siteResult = await pool.query(
    `SELECT
       s.id, s.name, s.code, s.address, s.city, s.state,
       o.name AS organization_name,
       ok.company_name, ok.registered_address, ok.gst_number, ok.director_name
     FROM sites s
     JOIN organizations o ON o.id = s.organization_id
     LEFT JOIN organization_kyc ok ON ok.organization_id = o.id
     WHERE s.id = $1 AND s.organization_id = $2`,
    [siteId, organizationId],
  );
  const siteRow = siteResult.rows[0];
  if (!siteRow) return res.status(404).json({ message: 'Site not found' });

  const requestedComparative = String(req.query.comparative_to || '').trim();
  if (requestedComparative && !DATE_RE.test(requestedComparative)) {
    return res.status(400).json({ message: 'comparative_to must be YYYY-MM-DD' });
  }
  const comparativeTo = requestedComparative || previousYearIso(dateTo || todayInIndia());
  const report = await balanceSheetModel.getReport({
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
    comparativeTo,
  });

  const site = {
    id: siteRow.id,
    name: siteRow.name,
    code: siteRow.code,
    address: siteRow.address,
    city: siteRow.city,
    state: siteRow.state,
  };
  const organization = {
    name: siteRow.company_name || siteRow.organization_name,
    registered_address: siteRow.registered_address || '',
    gst_number: siteRow.gst_number || '',
    director_name: siteRow.director_name || '',
  };

  res.json({
    site,
    organization,
    scope,
    period: { preset, date_from: dateFrom, date_to: dateTo, comparative_to: comparativeTo, grain },
    filters: { source, payment_mode: paymentMode, direction, q: search },
    ...report,
  });
});
