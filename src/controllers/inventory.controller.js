import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { inventoryModel } from '../models/Inventory.model.js';

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const requireSite = (req, res) => {
  const siteId = parseInt(req.query.site_id || req.body.site_id, 10);
  if (!siteId) { res.status(400).json({ message: 'site_id is required' }); return null; }
  return siteId;
};

// Movement types that physically reduce on-hand → must be covered by stock.
const REDUCING = new Set(['ISSUE', 'CONSUMPTION', 'TRANSFER_OUT']);
const ALL_TYPES = new Set([
  'RECEIPT', 'ISSUE', 'CONSUMPTION', 'ADJUSTMENT',
  'RESERVE', 'UNRESERVE', 'TRANSFER_IN', 'TRANSFER_OUT', 'RETURN',
]);

// ── Material master ─────────────────────────────────────────

export const listMaterials = asyncHandler(async (req, res) => {
  const siteId = requireSite(req, res); if (!siteId) return;
  const materials = await inventoryModel.listMaterials(siteId, {
    search: req.query.search?.trim() || undefined,
    lowStock: req.query.low_stock === 'true',
  });
  res.json({ materials });
});

export const createMaterial = asyncHandler(async (req, res) => {
  const siteId = requireSite(req, res); if (!siteId) return;
  const { name, code, unit, category, min_stock, rate, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ message: 'Material name is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO inventory_materials (site_id, name, code, unit, category, min_stock, rate, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [siteId, name.trim().toUpperCase(), code?.trim() || null, (unit?.trim() || 'NOS').toUpperCase(),
       category?.trim() || null, num(min_stock) || 0, num(rate) || 0, notes?.trim() || null, req.user.id]
    );
    res.status(201).json({ material: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'A material with this name already exists at this site' });
    throw err;
  }
});

export const updateMaterial = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fields = ['name', 'code', 'unit', 'category', 'min_stock', 'rate', 'notes', 'is_active'];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] === undefined) continue;
    let v = req.body[f];
    if (f === 'name' || f === 'unit') v = String(v).trim().toUpperCase();
    else if (f === 'min_stock' || f === 'rate') v = num(v) || 0;
    else if (f === 'is_active') v = Boolean(v);
    else v = v === null ? null : String(v).trim() || null;
    params.push(v);
    sets.push(`${f} = $${params.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ message: 'Nothing to update' });
  params.push(id);
  const { rows } = await pool.query(
    `UPDATE inventory_materials SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ message: 'Material not found' });
  res.json({ material: rows[0] });
});

export const deleteMaterial = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await pool.query('SELECT 1 FROM inventory_movements WHERE material_id = $1 LIMIT 1', [id]);
  if (rows.length) return res.status(409).json({ message: 'Cannot delete — this material has stock movements. Deactivate it instead.' });
  const del = await pool.query('DELETE FROM inventory_materials WHERE id = $1 RETURNING id', [id]);
  if (!del.rows[0]) return res.status(404).json({ message: 'Material not found' });
  res.json({ success: true });
});

export const getMaterial = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await pool.query('SELECT * FROM inventory_materials WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ message: 'Material not found' });
  const stock = await inventoryModel.stockFor(id);
  const movements = await inventoryModel.listMovements(rows[0].site_id, { materialId: id, limit: 50 });
  res.json({ material: { ...rows[0], ...stock, stock_value: stock.on_hand * (parseFloat(rows[0].rate) || 0) }, movements });
});

// ── Movements (Receipt / Adjustment / Reserve / Transfer / Return …) ─────────

export const listMovements = asyncHandler(async (req, res) => {
  const siteId = requireSite(req, res); if (!siteId) return;
  const movements = await inventoryModel.listMovements(siteId, {
    materialId: req.query.material_id ? parseInt(req.query.material_id, 10) : undefined,
    limit: Math.min(parseInt(req.query.limit, 10) || 200, 1000),
  });
  res.json({ movements });
});

export const createMovement = asyncHandler(async (req, res) => {
  const siteId = requireSite(req, res); if (!siteId) return;
  const { material_id, movement_type, qty, rate, project_id, task_id, ref_type, ref_id, note } = req.body;
  const type = String(movement_type || '').toUpperCase();
  if (!material_id) return res.status(400).json({ message: 'material_id is required' });
  if (!ALL_TYPES.has(type)) return res.status(400).json({ message: 'Invalid movement_type' });
  const q = Number(qty);
  if (!Number.isFinite(q) || q === 0) return res.status(400).json({ message: 'qty must be a non-zero number' });
  // Only ADJUSTMENT may be negative; everything else is a positive magnitude.
  if (type !== 'ADJUSTMENT' && q < 0) return res.status(400).json({ message: 'qty must be positive for this movement type' });

  const mat = await pool.query('SELECT id, rate FROM inventory_materials WHERE id = $1 AND site_id = $2', [material_id, siteId]);
  if (!mat.rows[0]) return res.status(404).json({ message: 'Material not found for this site' });

  // Guard stock-reducing movements against going negative.
  if (REDUCING.has(type) || type === 'RESERVE') {
    const { on_hand, available } = await inventoryModel.stockFor(material_id);
    const cap = type === 'RESERVE' ? available : on_hand;
    if (q > cap) return res.status(400).json({ message: `Only ${cap} in stock — cannot ${type.toLowerCase()} ${q}` });
  }

  const movement = await inventoryModel.insertMovement({
    site_id: siteId, material_id, movement_type: type, qty: q,
    rate: rate !== undefined ? Number(rate) : parseFloat(mat.rows[0].rate) || 0,
    project_id, task_id, ref_type, ref_id, note, created_by: req.user.id,
  });
  res.status(201).json({ movement });
});

// ── Vendor order → stock (procurement link) ─────────────────

/**
 * Receive (part of) a vendor inventory order into stock: appends a RECEIPT
 * movement tagged ref_type='VENDOR_ORDER' so received_qty on the order derives
 * from the same ledger. Material is matched by name at the site, or created.
 */
export const receiveVendorOrder = asyncHandler(async (req, res) => {
  const siteId = requireSite(req, res); if (!siteId) return;
  const orderId = parseInt(req.params.orderId, 10);
  if (!Number.isInteger(orderId)) return res.status(400).json({ message: 'Invalid order id' });
  const qty = Number(req.body.qty);
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ message: 'qty must be greater than 0' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the order so two concurrent receipts can't both pass the pending check.
    const { rows: [order] } = await client.query(
      `SELECT id, item_name, item_category, unit, rate, qty_ordered, status, vendor_name
         FROM vendor_inventory_orders WHERE id = $1 AND site_id = $2 FOR UPDATE`,
      [orderId, siteId]
    );
    if (!order) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Vendor order not found for this site' }); }
    if (order.status === 'cancelled') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'Order is cancelled' }); }

    const { rows: [rec] } = await client.query(
      `SELECT COALESCE(SUM(qty), 0) AS received FROM inventory_movements
        WHERE ref_type = 'VENDOR_ORDER' AND ref_id = $1 AND movement_type = 'RECEIPT'`,
      [orderId]
    );
    const pending = (parseFloat(order.qty_ordered) || 0) - (parseFloat(rec.received) || 0);
    if (qty > pending + 1e-9) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: `Only ${pending} ${order.unit} pending on this order` });
    }

    let materialId = req.body.material_id ? parseInt(req.body.material_id, 10) : null;
    if (materialId) {
      const chk = await client.query('SELECT id FROM inventory_materials WHERE id = $1 AND site_id = $2', [materialId, siteId]);
      if (!chk.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'Material not found for this site' }); }
    } else {
      const name = String(order.item_name || '').trim().toUpperCase();
      const found = await client.query('SELECT id FROM inventory_materials WHERE site_id = $1 AND name = $2', [siteId, name]);
      materialId = found.rows[0]?.id || (await client.query(
        `INSERT INTO inventory_materials (site_id, name, unit, category, rate, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [siteId, name, String(order.unit || 'NOS').toUpperCase(), order.item_category || null,
         parseFloat(order.rate) || 0, req.user.id]
      )).rows[0].id;
    }

    const movement = await inventoryModel.insertMovement({
      site_id: siteId, material_id: materialId, movement_type: 'RECEIPT', qty,
      rate: req.body.rate !== undefined && req.body.rate !== '' ? Number(req.body.rate) : parseFloat(order.rate) || 0,
      ref_type: 'VENDOR_ORDER', ref_id: orderId,
      note: (req.body.note || '').trim() || `Vendor order #${orderId} — ${order.vendor_name}`,
      created_by: req.user.id,
    }, client);

    await client.query('COMMIT');
    res.status(201).json({ movement, material_id: materialId, pending_qty: pending - qty });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ── Dashboard summary ───────────────────────────────────────

export const inventorySummary = asyncHandler(async (req, res) => {
  const siteId = requireSite(req, res); if (!siteId) return;
  res.json({ summary: await inventoryModel.summary(siteId) });
});
