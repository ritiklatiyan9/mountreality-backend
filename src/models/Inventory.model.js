import pool from '../config/db.js';

/**
 * Inventory model — stock is DERIVED from the inventory_movements ledger, never
 * stored. These helpers are the single place that encodes the on-hand / reserved
 * math, reused by both the inventory and construction controllers.
 */

// Signed on-hand + reserved aggregation over the movement ledger.
// on-hand: physical stock; reserved: soft-held (doesn't reduce on-hand).
const STOCK_AGG = `
  SELECT material_id,
    SUM(CASE
      WHEN movement_type IN ('RECEIPT','RETURN','TRANSFER_IN') THEN qty
      WHEN movement_type IN ('ISSUE','CONSUMPTION','TRANSFER_OUT') THEN -qty
      WHEN movement_type = 'ADJUSTMENT' THEN qty
      ELSE 0 END) AS on_hand,
    SUM(CASE
      WHEN movement_type = 'RESERVE' THEN qty
      WHEN movement_type = 'UNRESERVE' THEN -qty
      ELSE 0 END) AS reserved
  FROM inventory_movements
  GROUP BY material_id
`;

export const inventoryModel = {
  /** Materials for a site, each with live on_hand / reserved / available / value. */
  async listMaterials(siteId, { search, lowStock } = {}) {
    const params = [siteId];
    let where = 'WHERE m.site_id = $1';
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (m.name ILIKE $${params.length} OR m.code ILIKE $${params.length} OR m.category ILIKE $${params.length})`;
    }
    // Low-stock filter is applied after aggregation (references derived on_hand).
    const having = lowStock ? `AND m.min_stock > 0 AND COALESCE(s.on_hand, 0) < m.min_stock` : '';
    const { rows } = await pool.query(
      `SELECT m.*,
         COALESCE(s.on_hand, 0)  AS on_hand,
         COALESCE(s.reserved, 0) AS reserved,
         COALESCE(s.on_hand, 0) - COALESCE(s.reserved, 0) AS available,
         COALESCE(s.on_hand, 0) * m.rate AS stock_value,
         (m.min_stock > 0 AND COALESCE(s.on_hand, 0) < m.min_stock) AS is_low_stock
       FROM inventory_materials m
       LEFT JOIN (${STOCK_AGG}) s ON s.material_id = m.id
       ${where} ${having}
       ORDER BY m.name ASC`,
      params
    );
    return rows;
  },

  /** Live stock for a single material: { on_hand, reserved, available }. */
  async stockFor(materialId, client = pool) {
    const { rows } = await client.query(
      `SELECT
         COALESCE(SUM(CASE
           WHEN movement_type IN ('RECEIPT','RETURN','TRANSFER_IN') THEN qty
           WHEN movement_type IN ('ISSUE','CONSUMPTION','TRANSFER_OUT') THEN -qty
           WHEN movement_type = 'ADJUSTMENT' THEN qty ELSE 0 END), 0) AS on_hand,
         COALESCE(SUM(CASE
           WHEN movement_type = 'RESERVE' THEN qty
           WHEN movement_type = 'UNRESERVE' THEN -qty ELSE 0 END), 0) AS reserved
       FROM inventory_movements WHERE material_id = $1`,
      [materialId]
    );
    const on_hand = parseFloat(rows[0].on_hand) || 0;
    const reserved = parseFloat(rows[0].reserved) || 0;
    return { on_hand, reserved, available: on_hand - reserved };
  },

  /** Append one movement to the ledger. Accepts a client for transaction reuse. */
  async insertMovement(m, client = pool) {
    const { rows } = await client.query(
      `INSERT INTO inventory_movements
         (site_id, material_id, movement_type, qty, rate, project_id, task_id, request_id, ref_type, ref_id, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        m.site_id, m.material_id, m.movement_type, m.qty, m.rate || 0,
        m.project_id || null, m.task_id || null, m.request_id || null,
        m.ref_type || null, m.ref_id || null, m.note || null, m.created_by || null,
      ]
    );
    return rows[0];
  },

  /** Movement history (newest first), optionally scoped to one material. */
  async listMovements(siteId, { materialId, limit = 200 } = {}) {
    const params = [siteId];
    let where = 'WHERE mv.site_id = $1';
    if (materialId) { params.push(materialId); where += ` AND mv.material_id = $${params.length}`; }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT mv.*, m.name AS material_name, m.unit AS material_unit,
              p.name AS project_name, u.name AS created_by_name
         FROM inventory_movements mv
         JOIN inventory_materials m ON m.id = mv.material_id
         LEFT JOIN construction_projects p ON p.id = mv.project_id
         LEFT JOIN users u ON u.id = mv.created_by
         ${where}
         ORDER BY mv.created_at DESC, mv.id DESC
         LIMIT $${params.length}`,
      params
    );
    return rows;
  },

  /** Dashboard-card numbers for a site's inventory. */
  async summary(siteId) {
    const { rows } = await pool.query(
      `WITH stock AS (
         SELECT m.id, m.rate, m.min_stock,
           COALESCE(s.on_hand, 0) AS on_hand
         FROM inventory_materials m
         LEFT JOIN (${STOCK_AGG}) s ON s.material_id = m.id
         WHERE m.site_id = $1
       )
       SELECT
         COUNT(*)::int AS material_count,
         COALESCE(SUM(on_hand * rate), 0) AS total_value,
         COUNT(*) FILTER (WHERE min_stock > 0 AND on_hand < min_stock)::int AS low_stock_count
       FROM stock`,
      [siteId]
    );
    return rows[0];
  },
};
