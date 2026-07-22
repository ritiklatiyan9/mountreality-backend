import MasterModel from './MasterModel.js';

// ── Day Book Daily Balance Model ──
// Stores per-site per-date opening and closing balance for the Day Book module.
class DayBookDailyBalanceModel extends MasterModel {
  constructor() {
    super('day_book_daily_balance');
  }

  async findBySiteAndDate(siteId, date, pool) {
    const { rows } = await pool.query(
      `SELECT * FROM day_book_daily_balance WHERE site_id = $1 AND date = $2`,
      [siteId, date]
    );
    return rows[0] || null;
  }

  // Most-recent prior record (used to seed today's opening = yesterday's closing).
  async findLatestBefore(siteId, date, pool) {
    const { rows } = await pool.query(
      `SELECT * FROM day_book_daily_balance
       WHERE site_id = $1 AND date < $2
       ORDER BY date DESC
       LIMIT 1`,
      [siteId, date]
    );
    return rows[0] || null;
  }

  // Lock opening on first write; subsequent calls just refresh closing.
  async upsertOpening(siteId, date, openingBalance, pool) {
    const { rows } = await pool.query(
      `INSERT INTO day_book_daily_balance (site_id, date, opening_balance, closing_balance)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (site_id, date) DO NOTHING
       RETURNING *`,
      [siteId, date, openingBalance]
    );
    if (rows[0]) return rows[0];
    return this.findBySiteAndDate(siteId, date, pool);
  }

  async updateClosing(siteId, date, closingBalance, pool) {
    const { rows } = await pool.query(
      `UPDATE day_book_daily_balance
       SET closing_balance = $3, updated_at = CURRENT_TIMESTAMP
       WHERE site_id = $1 AND date = $2
       RETURNING *`,
      [siteId, date, closingBalance]
    );
    return rows[0] || null;
  }
}

export const dayBookDailyBalanceModel = new DayBookDailyBalanceModel();
