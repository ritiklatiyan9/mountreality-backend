import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { REPORTS, reportList } from '../services/reportDefinitions.js';

/**
 * Generic report engine. Every module report is the same four queries driven by
 * a declarative definition (services/reportDefinitions.js):
 *   totals → KPIs, trend by month/day, breakdown by dimension, detail rows.
 *
 * All identifiers come from the definitions (server-side constants) and every
 * user value is a bound parameter — nothing from the request is interpolated
 * into SQL.
 */

const MAX_ROWS = 5000;

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** Permission gate: admins pass, sub-admins need read on the module's key. */
const canRead = async (req, permission) => {
  if (req.user.role === 'admin' || req.user.role === 'super_admin') return true;
  const { rows } = await pool.query(
    'SELECT can_read FROM user_permissions WHERE user_id = $1 AND module = $2 LIMIT 1',
    [req.user.id, permission]
  );
  return Boolean(rows[0]?.can_read);
};

const siteAccessOk = async (req, siteId) => {
  if (req.user.role === 'admin' || req.user.role === 'super_admin') return true;
  const { rows } = await pool.query(
    'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
    [req.user.id, siteId]
  );
  return Boolean(rows[0]);
};

/** Shared WHERE + params for a definition. Returns { where, params }. */
const scope = (def, siteId, from, to) => {
  const params = [siteId, from, to];
  let where = `${def.siteCol} = $1 AND ${def.dateCol} >= $2::date AND ${def.dateCol} < ($3::date + INTERVAL '1 day')`;
  if (def.where) where += ` AND ${def.where}`;
  return { where, params };
};

/** Build the full report payload for a module + range. */
export const buildReport = async (moduleKey, siteId, from, to, { rowLimit = 500 } = {}) => {
  const def = REPORTS[moduleKey];
  const { where, params } = scope(def, siteId, from, to);
  // Headcount reports have no money column — NULL needs a type or SUM() is ambiguous.
  const amount = def.amount || 'NULL::numeric';
  // Day-level granularity for short ranges, month-level for long ones.
  const spanDays = Math.round((new Date(to) - new Date(from)) / 86400000);
  const bucket = spanDays <= 62 ? 'day' : 'month';

  const [totals, trend, breakdown, rows] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS record_count,
              COALESCE(SUM(${amount}), 0)::numeric(18,2) AS total,
              COALESCE(AVG(${amount}), 0)::numeric(18,2) AS average,
              COALESCE(MAX(${amount}), 0)::numeric(18,2) AS largest,
              MIN(${def.dateCol}) AS first_entry,
              MAX(${def.dateCol}) AS last_entry
         FROM ${def.from} WHERE ${where}`,
      params
    ),
    pool.query(
      `SELECT to_char(date_trunc('${bucket}', ${def.dateCol}), 'YYYY-MM-DD') AS bucket,
              COUNT(*)::int AS count,
              COALESCE(SUM(${amount}), 0)::numeric(18,2) AS total
         FROM ${def.from} WHERE ${where}
        GROUP BY 1 ORDER BY 1`,
      params
    ),
    pool.query(
      `SELECT ${def.dimension.expr} AS label,
              COUNT(*)::int AS count,
              COALESCE(SUM(${amount}), 0)::numeric(18,2) AS total
         FROM ${def.from} WHERE ${where}
        GROUP BY 1 ORDER BY ${def.amount ? 'total' : 'count'} DESC NULLS LAST LIMIT 12`,
      params
    ),
    pool.query(
      `SELECT ${def.columns.map((c) => `${c.expr} AS "${c.key}"`).join(', ')}
         FROM ${def.from} WHERE ${where}
        ORDER BY ${def.dateCol} DESC NULLS LAST LIMIT $4`,
      [...params, Math.min(rowLimit, MAX_ROWS)]
    ),
  ]);

  const t = totals.rows[0];
  const kpis = [
    { key: 'records', label: 'Records', value: t.record_count, type: 'number' },
    ...(def.amount ? [
      { key: 'total', label: def.amountLabel, value: Number(t.total), type: 'money' },
      { key: 'average', label: `Average ${def.amountLabel.toLowerCase()}`, value: Number(t.average), type: 'money' },
      { key: 'largest', label: 'Largest single', value: Number(t.largest), type: 'money' },
    ] : []),
    { key: 'span', label: 'Active days', value: new Set(trend.rows.map((r) => r.bucket)).size, type: 'number' },
  ];

  return {
    module: moduleKey,
    label: def.label,
    description: def.description,
    range: { from, to, bucket },
    kpis,
    trend: trend.rows.map((r) => ({ bucket: r.bucket, count: r.count, total: Number(r.total) })),
    breakdown: breakdown.rows.map((r) => ({ label: r.label, count: r.count, total: Number(r.total) })),
    dimension_label: def.dimension.label,
    columns: def.columns.map(({ key, label, type }) => ({ key, label, type: type || 'text' })),
    rows: rows.rows,
    row_limit_hit: rows.rows.length >= Math.min(rowLimit, MAX_ROWS),
    generated_at: new Date().toISOString(),
  };
};

/** Resolve + validate the common request shape. Returns null after responding. */
const parseRequest = async (req, res, source) => {
  const moduleKey = String(req.params.module || source.module || '');
  const def = REPORTS[moduleKey];
  if (!def) { res.status(404).json({ message: `Unknown report module: ${moduleKey}` }); return null; }

  const siteId = parseInt(source.site_id, 10);
  if (!Number.isInteger(siteId)) { res.status(400).json({ message: 'site_id is required' }); return null; }
  if (!(await siteAccessOk(req, siteId))) { res.status(403).json({ message: 'Access denied to this site' }); return null; }
  if (!(await canRead(req, def.permission))) {
    res.status(403).json({ message: `You do not have read access to ${def.label}` });
    return null;
  }

  const to = isDate(source.to) ? source.to : new Date().toISOString().slice(0, 10);
  const from = isDate(source.from) ? source.from : new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  if (from > to) { res.status(400).json({ message: '"from" date must be before "to" date' }); return null; }

  return { moduleKey, siteId, from, to };
};

/** GET /reports/modules — the picker, filtered to what this user may read. */
export const listReportModules = asyncHandler(async (req, res) => {
  const all = reportList();
  const allowed = [];
  for (const r of all) if (await canRead(req, r.permission)) allowed.push(r);
  res.json({ modules: allowed });
});

/** GET /reports/:module?site_id=&from=&to=&limit= */
export const getReport = asyncHandler(async (req, res) => {
  const parsed = await parseRequest(req, res, req.query);
  if (!parsed) return;
  const report = await buildReport(parsed.moduleKey, parsed.siteId, parsed.from, parsed.to, {
    rowLimit: parseInt(req.query.limit, 10) || 500,
  });
  res.json({ report });
});

// ── Groq AI narrative ───────────────────────────────────────

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = () => process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

/** Compact the report so the model sees signal, not 500 rows of noise. */
const digest = (report, siteName) => ({
  site: siteName,
  report: report.label,
  period: `${report.range.from} to ${report.range.to}`,
  kpis: report.kpis.map((k) => `${k.label}: ${k.value}`),
  trend: report.trend.slice(-24).map((t) => ({ period: t.bucket, count: t.count, total: t.total })),
  [`by_${report.dimension_label.toLowerCase().replace(/\s+/g, '_')}`]: report.breakdown,
  sample_rows: report.rows.slice(0, 25),
  total_rows: report.rows.length,
});

/** POST /reports/:module/ai — Groq-written executive summary of the report. */
export const aiReportSummary = asyncHandler(async (req, res) => {
  if (!process.env.GROQ_API_KEY) {
    return res.status(503).json({ message: 'GROQ_API_KEY is not configured on the server' });
  }
  const parsed = await parseRequest(req, res, req.body);
  if (!parsed) return;

  const report = await buildReport(parsed.moduleKey, parsed.siteId, parsed.from, parsed.to, { rowLimit: 500 });
  if (!report.rows.length) {
    return res.json({ insight: { headline: 'No data in this period', summary: 'There are no records for the selected module and date range, so there is nothing to analyse yet.', highlights: [], risks: [], actions: [] }, empty: true });
  }

  const { rows: [site] } = await pool.query('SELECT name FROM sites WHERE id = $1', [parsed.siteId]);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: GROQ_MODEL(),
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are a financial analyst for an Indian real-estate development company. You are given aggregated data from one module of their accounting system. ' +
              'Analyse only what the data shows — never invent figures, and quote numbers exactly as given (Indian numbering, ₹ for money). ' +
              'Respond as JSON: {"headline": string, "summary": string (2-4 sentences), "highlights": [{"title": string, "detail": string}], ' +
              '"risks": [{"title": string, "detail": string, "severity": "low"|"medium"|"high"}], "actions": [string]}. ' +
              'Give 3-5 highlights, 0-4 risks (only real ones evidenced by the data), and 2-4 concrete next actions.',
          },
          { role: 'user', content: JSON.stringify(digest(report, site?.name || 'the site')) },
        ],
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(502).json({ message: data?.error?.message || `Groq request failed (HTTP ${response.status})` });
    }
    let insight;
    try {
      insight = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    } catch {
      return res.status(502).json({ message: 'Groq returned an unreadable response' });
    }
    res.json({
      insight: {
        headline: insight.headline || 'Report analysis',
        summary: insight.summary || '',
        highlights: Array.isArray(insight.highlights) ? insight.highlights : [],
        risks: Array.isArray(insight.risks) ? insight.risks : [],
        actions: Array.isArray(insight.actions) ? insight.actions : [],
      },
      model: data.model || GROQ_MODEL(),
    });
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ message: 'Groq took too long to respond' });
    throw err;
  } finally {
    clearTimeout(timer);
  }
});
