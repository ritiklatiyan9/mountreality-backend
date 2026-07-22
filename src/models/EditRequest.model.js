import MasterModel from './MasterModel.js';

class EditRequestModelClass extends MasterModel {
  constructor() {
    super('edit_requests');
  }

  /**
   * Find all pending edit requests (optionally filtered by site)
   */
  async findPending(pool, siteId = null) {
    let query = `
      SELECT er.*, 
             u.name AS requested_by_name, u.email AS requested_by_email,
             COALESCE(s.name, s2.name) AS site_name,
             ru.name AS reviewed_by_name,
             COALESCE(er.original_data->>'plot_no', p.plot_no) AS record_plot_no,
             COALESCE(er.original_data->>'booking_by', er.original_data->>'booked_by', p.booking_by) AS record_booked_by,
             COALESCE(er.original_data->>'payment_type', er.original_data->>'payment_mode', er.original_data->>'particular') AS record_payment_mode,
             COALESCE(er.original_data->>'buyer_name', p.buyer_name) AS record_buyer_name
      FROM edit_requests er
      LEFT JOIN users u ON er.requested_by = u.id
      LEFT JOIN sites s ON er.site_id = s.id
      LEFT JOIN users ru ON er.reviewed_by = ru.id
      LEFT JOIN plots p ON er.module IN ('plot_payment','daybook_plot_payment') AND p.id = (er.original_data->>'plot_id')::int
      LEFT JOIN sites s2 ON er.site_id IS NULL AND s2.id = (er.original_data->>'site_id')::int
    `;
    const params = [];
    
    if (siteId) {
      query += ` WHERE COALESCE(er.site_id, (er.original_data->>'site_id')::int) = $1`;
      params.push(parseInt(siteId));
    }
    
    query += ` ORDER BY er.created_at DESC`;
    
    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Find edit requests by status
   */
  async findByStatus(status, pool, siteId = null) {
    let query = `
      SELECT er.*, 
             u.name AS requested_by_name, u.email AS requested_by_email,
             COALESCE(s.name, s2.name) AS site_name,
             ru.name AS reviewed_by_name,
             COALESCE(er.original_data->>'plot_no', p.plot_no) AS record_plot_no,
             COALESCE(er.original_data->>'booking_by', er.original_data->>'booked_by', p.booking_by) AS record_booked_by,
             COALESCE(er.original_data->>'payment_type', er.original_data->>'payment_mode', er.original_data->>'particular') AS record_payment_mode,
             COALESCE(er.original_data->>'buyer_name', p.buyer_name) AS record_buyer_name
      FROM edit_requests er
      LEFT JOIN users u ON er.requested_by = u.id
      LEFT JOIN sites s ON er.site_id = s.id
      LEFT JOIN users ru ON er.reviewed_by = ru.id
      LEFT JOIN plots p ON er.module IN ('plot_payment','daybook_plot_payment') AND p.id = (er.original_data->>'plot_id')::int
      LEFT JOIN sites s2 ON er.site_id IS NULL AND s2.id = (er.original_data->>'site_id')::int
      WHERE er.status = $1
    `;
    const params = [status];
    
    if (siteId) {
      query += ` AND COALESCE(er.site_id, (er.original_data->>'site_id')::int) = $2`;
      params.push(parseInt(siteId));
    }
    
    query += ` ORDER BY er.created_at DESC`;
    
    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Check if there's already a pending edit request for a specific record
   */
  async findPendingForRecord(module, recordId, pool) {
    const query = `
      SELECT * FROM edit_requests 
      WHERE module = $1 AND record_id = $2 AND status = 'pending'
      LIMIT 1
    `;
    const result = await pool.query(query, [module, parseInt(recordId)]);
    return result.rows[0] || null;
  }

  /** Lock one request inside an existing transaction before a state change. */
  async findByIdForUpdate(id, db) {
    const result = await db.query(
      'SELECT * FROM edit_requests WHERE id = $1 FOR UPDATE',
      [parseInt(id)]
    );
    return result.rows[0] || null;
  }

  /**
   * Transition only a still-pending request. PostgreSQL re-checks the WHERE
   * predicate after waiting on a concurrent row lock, so approve/reject cannot
   * overwrite one another.
   */
  async transitionPending(id, data, db) {
    const keys = Object.keys(data);
    if (keys.length === 0) return null;
    const values = Object.values(data);
    const setClause = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
    values.push(parseInt(id));
    const result = await db.query(
      `UPDATE edit_requests
          SET ${setClause}
        WHERE id = $${values.length} AND status = 'pending'
        RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  /**
   * Get status counts
   */
  async getStatusCounts(pool, siteId = null) {
    let query = `
      SELECT 
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'approved') AS approved,
        COUNT(*) FILTER (WHERE status = 'rejected') AS rejected
      FROM edit_requests
    `;
    const params = [];
    
    if (siteId) {
      query += ` WHERE site_id = $1`;
      params.push(parseInt(siteId));
    }
    
    const result = await pool.query(query, params);
    return result.rows[0];
  }

  /**
   * Find requests made by a specific user
   */
  async findByRequester(userId, pool) {
    const query = `
      SELECT er.*, 
             s.name AS site_name,
             ru.name AS reviewed_by_name
      FROM edit_requests er
      LEFT JOIN sites s ON er.site_id = s.id
      LEFT JOIN users ru ON er.reviewed_by = ru.id
      WHERE er.requested_by = $1
      ORDER BY er.created_at DESC
    `;
    const result = await pool.query(query, [parseInt(userId)]);
    return result.rows;
  }
}

export const editRequestModel = new EditRequestModelClass();
