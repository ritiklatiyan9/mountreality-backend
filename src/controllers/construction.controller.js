import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { inventoryModel } from '../models/Inventory.model.js';

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const requireSite = (req, res) => {
  const siteId = parseInt(req.query.site_id || req.body.site_id, 10);
  if (!siteId) { res.status(400).json({ message: 'site_id is required' }); return null; }
  return siteId;
};

// Recompute a request's status from its line items (CANCELLED stays sticky).
const deriveRequestStatus = (items) => {
  const anyIssued = items.some((i) => Number(i.qty_issued) > 0);
  const allFilled = items.every((i) => Number(i.qty_issued) >= Number(i.qty_requested));
  if (allFilled) return 'FULFILLED';
  if (anyIssued) return 'PARTIALLY_FULFILLED';
  return 'REQUESTED';
};

// ── Projects ────────────────────────────────────────────────

export const listProjects = asyncHandler(async (req, res) => {
  const siteId = requireSite(req, res); if (!siteId) return;
  const params = [siteId];
  let where = 'WHERE p.site_id = $1';
  if (req.query.status && req.query.status !== 'all') { params.push(req.query.status.toUpperCase()); where += ` AND p.status = $${params.length}`; }
  if (req.query.search?.trim()) { params.push(`%${req.query.search.trim()}%`); where += ` AND (p.name ILIKE $${params.length} OR p.code ILIKE $${params.length})`; }
  const { rows } = await pool.query(
    `SELECT p.*,
       COALESCE(t.task_count, 0)::int         AS task_count,
       COALESCE(t.done_count, 0)::int         AS done_task_count,
       COALESCE(c.actual_cost, 0)             AS actual_cost,
       COALESCE(r.pending_requests, 0)::int   AS pending_requests,
       (p.target_end_date IS NOT NULL AND p.target_end_date < CURRENT_DATE AND p.status <> 'COMPLETED') AS is_overdue
     FROM construction_projects p
     LEFT JOIN (SELECT project_id, COUNT(*) task_count, COUNT(*) FILTER (WHERE status='DONE') done_count
                FROM construction_tasks GROUP BY project_id) t ON t.project_id = p.id
     LEFT JOIN (SELECT project_id, SUM(qty*rate) actual_cost
                FROM inventory_movements WHERE movement_type='CONSUMPTION' GROUP BY project_id) c ON c.project_id = p.id
     LEFT JOIN (SELECT project_id, COUNT(*) pending_requests
                FROM construction_material_requests WHERE status IN ('REQUESTED','PARTIALLY_FULFILLED') GROUP BY project_id) r ON r.project_id = p.id
     ${where}
     ORDER BY p.created_at DESC`,
    params
  );
  res.json({ projects: rows });
});

export const createProject = asyncHandler(async (req, res) => {
  const siteId = requireSite(req, res); if (!siteId) return;
  const { name, code, status, start_date, target_end_date, budget, notes, assigned_admin_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ message: 'Project name is required' });
  const { rows } = await pool.query(
    `INSERT INTO construction_projects (site_id, name, code, status, start_date, target_end_date, budget, notes, assigned_admin_id, created_by)
     VALUES ($1,$2,$3,COALESCE($4,'PLANNING'),$5,$6,$7,$8,$9,$10) RETURNING *`,
    [siteId, name.trim(), code?.trim() || null, status?.toUpperCase() || null,
     start_date || null, target_end_date || null, num(budget) || 0, notes?.trim() || null,
     assigned_admin_id || null, req.user.id]
  );
  res.status(201).json({ project: rows[0] });
});

export const getProject = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await pool.query('SELECT * FROM construction_projects WHERE id = $1', [id]);
  const project = rows[0];
  if (!project) return res.status(404).json({ message: 'Project not found' });

  const [tasks, requests, cost] = await Promise.all([
    pool.query('SELECT * FROM construction_tasks WHERE project_id = $1 ORDER BY sequence ASC, id ASC', [id]),
    pool.query(
      `SELECT r.*, u.name AS requested_by_name,
         COALESCE(json_agg(json_build_object(
           'id', ri.id, 'material_id', ri.material_id, 'material_name', m.name, 'unit', m.unit,
           'qty_requested', ri.qty_requested, 'qty_issued', ri.qty_issued,
           'qty_shortage', GREATEST(ri.qty_requested - ri.qty_issued, 0)
         ) ORDER BY ri.id) FILTER (WHERE ri.id IS NOT NULL), '[]') AS items
       FROM construction_material_requests r
       LEFT JOIN construction_material_request_items ri ON ri.request_id = r.id
       LEFT JOIN inventory_materials m ON m.id = ri.material_id
       LEFT JOIN users u ON u.id = r.requested_by
       WHERE r.project_id = $1
       GROUP BY r.id, u.name
       ORDER BY r.created_at DESC`,
      [id]
    ),
    pool.query(`SELECT COALESCE(SUM(qty*rate),0) AS actual_cost FROM inventory_movements WHERE movement_type='CONSUMPTION' AND project_id = $1`, [id]),
  ]);

  res.json({
    project: { ...project, actual_cost: parseFloat(cost.rows[0].actual_cost) || 0 },
    tasks: tasks.rows,
    material_requests: requests.rows,
  });
});

export const updateProject = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fields = ['name', 'code', 'status', 'start_date', 'target_end_date', 'actual_end_date', 'budget', 'progress_pct', 'notes', 'assigned_admin_id'];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] === undefined) continue;
    let v = req.body[f];
    if (f === 'status') v = String(v).toUpperCase();
    else if (f === 'budget') v = num(v) || 0;
    else if (f === 'progress_pct') v = Math.max(0, Math.min(100, parseInt(v, 10) || 0));
    else if (['start_date', 'target_end_date', 'actual_end_date', 'assigned_admin_id'].includes(f)) v = v || null;
    else v = v === null ? null : String(v).trim() || null;
    params.push(v);
    sets.push(`${f} = $${params.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ message: 'Nothing to update' });
  params.push(id);
  const { rows } = await pool.query(
    `UPDATE construction_projects SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ message: 'Project not found' });
  res.json({ project: rows[0] });
});

export const deleteProject = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const del = await pool.query('DELETE FROM construction_projects WHERE id = $1 RETURNING id', [id]);
  if (!del.rows[0]) return res.status(404).json({ message: 'Project not found' });
  res.json({ success: true });
});

// ── Tasks ───────────────────────────────────────────────────

export const createTask = asyncHandler(async (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  const { name, status, progress_pct, sequence, start_date, due_date } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ message: 'Task name is required' });
  const { rows } = await pool.query(
    `INSERT INTO construction_tasks (project_id, name, status, progress_pct, sequence, start_date, due_date, created_by)
     VALUES ($1,$2,COALESCE($3,'PENDING'),$4,$5,$6,$7,$8) RETURNING *`,
    [projectId, name.trim(), status?.toUpperCase() || null,
     Math.max(0, Math.min(100, parseInt(progress_pct, 10) || 0)), parseInt(sequence, 10) || 0,
     start_date || null, due_date || null, req.user.id]
  );
  res.status(201).json({ task: rows[0] });
});

export const updateTask = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.taskId, 10);
  const fields = ['name', 'status', 'progress_pct', 'sequence', 'start_date', 'due_date'];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] === undefined) continue;
    let v = req.body[f];
    if (f === 'status') v = String(v).toUpperCase();
    else if (f === 'progress_pct') v = Math.max(0, Math.min(100, parseInt(v, 10) || 0));
    else if (f === 'sequence') v = parseInt(v, 10) || 0;
    else if (f === 'name') v = String(v).trim();
    else v = v || null;
    params.push(v);
    sets.push(`${f} = $${params.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ message: 'Nothing to update' });
  params.push(id);
  const { rows } = await pool.query(
    `UPDATE construction_tasks SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ message: 'Task not found' });
  res.json({ task: rows[0] });
});

export const deleteTask = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.taskId, 10);
  const del = await pool.query('DELETE FROM construction_tasks WHERE id = $1 RETURNING id', [id]);
  if (!del.rows[0]) return res.status(404).json({ message: 'Task not found' });
  res.json({ success: true });
});

// ── Material requests ───────────────────────────────────────

export const createMaterialRequest = asyncHandler(async (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  const { task_id, note, items } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: 'At least one item is required' });
  const clean = items
    .map((i) => ({ material_id: parseInt(i.material_id, 10), qty: Number(i.qty ?? i.qty_requested) }))
    .filter((i) => i.material_id && Number.isFinite(i.qty) && i.qty > 0);
  if (clean.length === 0) return res.status(400).json({ message: 'Items must have a material and a positive qty' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const proj = await client.query('SELECT site_id FROM construction_projects WHERE id = $1', [projectId]);
    if (!proj.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Project not found' }); }
    const siteId = proj.rows[0].site_id;

    const reqRow = await client.query(
      `INSERT INTO construction_material_requests (site_id, project_id, task_id, status, note, requested_by)
       VALUES ($1,$2,$3,'REQUESTED',$4,$5) RETURNING *`,
      [siteId, projectId, task_id || null, note?.trim() || null, req.user.id]
    );
    const request = reqRow.rows[0];
    for (const it of clean) {
      await client.query(
        `INSERT INTO construction_material_request_items (request_id, material_id, qty_requested) VALUES ($1,$2,$3)`,
        [request.id, it.material_id, it.qty]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ request });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

export const getMaterialRequest = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.reqId, 10);
  const { rows } = await pool.query(
    `SELECT r.*, u.name AS requested_by_name, p.name AS project_name
       FROM construction_material_requests r
       LEFT JOIN users u ON u.id = r.requested_by
       LEFT JOIN construction_projects p ON p.id = r.project_id
      WHERE r.id = $1`,
    [id]
  );
  const request = rows[0];
  if (!request) return res.status(404).json({ message: 'Request not found' });

  const items = await pool.query(
    `SELECT ri.*, m.name AS material_name, m.unit,
            GREATEST(ri.qty_requested - ri.qty_issued, 0) AS qty_shortage
       FROM construction_material_request_items ri
       JOIN inventory_materials m ON m.id = ri.material_id
      WHERE ri.request_id = $1 ORDER BY ri.id`,
    [id]
  );
  // Attach live available stock per item so the UI can show issue-now vs shortage.
  const withStock = await Promise.all(items.rows.map(async (it) => {
    const stock = await inventoryModel.stockFor(it.material_id);
    return { ...it, available: stock.available, on_hand: stock.on_hand };
  }));
  res.json({ request, items: withStock });
});

/**
 * Issue available stock against a request. For each line, issue the lesser of
 * (still-needed, currently-available). Physically reduces stock via ISSUE
 * movements, all in one transaction, then recomputes the request status.
 */
export const issueMaterialRequest = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.reqId, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM construction_material_requests WHERE id = $1 FOR UPDATE', [id]);
    const request = r.rows[0];
    if (!request) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Request not found' }); }
    if (request.status === 'CANCELLED') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'Request is cancelled' }); }

    const itemsRes = await client.query('SELECT * FROM construction_material_request_items WHERE request_id = $1 ORDER BY id', [id]);
    const issued = [];
    for (const it of itemsRes.rows) {
      const remaining = Number(it.qty_requested) - Number(it.qty_issued);
      if (remaining <= 0) continue;
      const stock = await inventoryModel.stockFor(it.material_id, client); // sees this txn's inserts
      const toIssue = Math.min(remaining, Math.max(0, stock.available));
      if (toIssue <= 0) continue;
      const mat = await client.query('SELECT rate FROM inventory_materials WHERE id = $1', [it.material_id]);
      await inventoryModel.insertMovement({
        site_id: request.site_id, material_id: it.material_id, movement_type: 'ISSUE',
        qty: toIssue, rate: parseFloat(mat.rows[0]?.rate) || 0,
        project_id: request.project_id, task_id: request.task_id, request_id: request.id,
        ref_type: 'material_request', ref_id: request.id, note: 'Issued against material request',
        created_by: req.user.id,
      }, client);
      await client.query('UPDATE construction_material_request_items SET qty_issued = qty_issued + $1 WHERE id = $2', [toIssue, it.id]);
      issued.push({ material_id: it.material_id, qty: toIssue });
    }

    const fresh = await client.query('SELECT qty_requested, qty_issued FROM construction_material_request_items WHERE request_id = $1', [id]);
    const status = deriveRequestStatus(fresh.rows);
    await client.query('UPDATE construction_material_requests SET status = $1, updated_at = NOW() WHERE id = $2', [status, id]);

    await client.query('COMMIT');
    const shortages = fresh.rows
      .map((i) => Number(i.qty_requested) - Number(i.qty_issued))
      .filter((s) => s > 0);
    res.json({ status, issued, has_shortage: shortages.length > 0 });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

export const updateMaterialRequest = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.reqId, 10);
  const { status, note } = req.body;
  const sets = [];
  const params = [];
  if (status !== undefined) { params.push(String(status).toUpperCase()); sets.push(`status = $${params.length}`); }
  if (note !== undefined) { params.push(note?.trim() || null); sets.push(`note = $${params.length}`); }
  if (sets.length === 0) return res.status(400).json({ message: 'Nothing to update' });
  params.push(id);
  const { rows } = await pool.query(
    `UPDATE construction_material_requests SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ message: 'Request not found' });
  res.json({ request: rows[0] });
});

// ── Consumption (draws stock, feeds actual cost) ────────────

export const consumeMaterial = asyncHandler(async (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  const { material_id, qty, task_id, note, rate } = req.body;
  const q = Number(qty);
  if (!material_id || !Number.isFinite(q) || q <= 0) return res.status(400).json({ message: 'material_id and a positive qty are required' });

  const proj = await pool.query('SELECT site_id FROM construction_projects WHERE id = $1', [projectId]);
  if (!proj.rows[0]) return res.status(404).json({ message: 'Project not found' });
  const siteId = proj.rows[0].site_id;

  const mat = await pool.query('SELECT rate FROM inventory_materials WHERE id = $1 AND site_id = $2', [material_id, siteId]);
  if (!mat.rows[0]) return res.status(404).json({ message: 'Material not found for this site' });

  const stock = await inventoryModel.stockFor(material_id);
  if (q > stock.on_hand) return res.status(400).json({ message: `Only ${stock.on_hand} in stock — cannot consume ${q}` });

  const movement = await inventoryModel.insertMovement({
    site_id: siteId, material_id, movement_type: 'CONSUMPTION', qty: q,
    rate: rate !== undefined ? Number(rate) : parseFloat(mat.rows[0].rate) || 0,
    project_id: projectId, task_id: task_id || null, ref_type: 'consumption',
    note: note?.trim() || null, created_by: req.user.id,
  });
  res.status(201).json({ movement });
});

// ── Dashboard summary ───────────────────────────────────────

export const constructionSummary = asyncHandler(async (req, res) => {
  const siteId = requireSite(req, res); if (!siteId) return;
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active_projects,
       COUNT(*) FILTER (WHERE status = 'DELAYED' OR (target_end_date IS NOT NULL AND target_end_date < CURRENT_DATE AND status <> 'COMPLETED'))::int AS delayed_projects,
       COALESCE(ROUND(AVG(progress_pct) FILTER (WHERE status IN ('ACTIVE','DELAYED'))), 0)::int AS avg_progress,
       COALESCE(SUM(budget), 0) AS total_budget
     FROM construction_projects WHERE site_id = $1`,
    [siteId]
  );
  const [pendingReq, actual] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS pending_material_requests FROM construction_material_requests WHERE site_id = $1 AND status IN ('REQUESTED','PARTIALLY_FULFILLED')`, [siteId]),
    pool.query(`SELECT COALESCE(SUM(qty*rate),0) AS actual_cost FROM inventory_movements WHERE movement_type='CONSUMPTION' AND site_id = $1`, [siteId]),
  ]);
  res.json({
    summary: {
      ...rows[0],
      pending_material_requests: pendingReq.rows[0].pending_material_requests,
      total_actual_cost: parseFloat(actual.rows[0].actual_cost) || 0,
    },
  });
});
