import MasterModel from './MasterModel.js';

// ── Installment Model ──
class InstallmentModel extends MasterModel {
  constructor() {
    super('plot_installments');
  }

  /** All installments for a plot, sorted by due_date */
  async findByPlotId(plotId, pool) {
    const query = `
      SELECT * FROM plot_installments
      WHERE plot_id = $1
      ORDER BY sort_order ASC, due_date ASC
    `;
    const result = await pool.query(query, [plotId]);
    return result.rows;
  }

  /** Refresh statuses based on current date and payments */
  async refreshStatuses(plotId, pool) {
    const today = new Date().toISOString().split('T')[0];
    // Mark overdue: past due_date, not fully paid
    await pool.query(`
      UPDATE plot_installments
      SET status = 'overdue'
      WHERE plot_id = $1
        AND due_date < $2
        AND paid_amount < amount
        AND status != 'paid'
    `, [plotId, today]);

    // Mark partially_paid: has some payment but not full
    await pool.query(`
      UPDATE plot_installments
      SET status = 'partially_paid'
      WHERE plot_id = $1
        AND paid_amount > 0
        AND paid_amount < amount
        AND status NOT IN ('paid', 'overdue')
    `, [plotId]);

    // Mark paid: fully paid
    await pool.query(`
      UPDATE plot_installments
      SET status = 'paid'
      WHERE plot_id = $1
        AND paid_amount >= amount
    `, [plotId]);
  }
}

// ── Installment Payment Model ──
class InstallmentPaymentModel extends MasterModel {
  constructor() {
    super('plot_installment_payments');
  }

  /** All payments for an installment */
  async findByInstallmentId(installmentId, pool) {
    const query = `
      SELECT pip.*, u.name AS created_by_name
      FROM plot_installment_payments pip
      LEFT JOIN users u ON u.id = pip.created_by
      WHERE pip.installment_id = $1
      ORDER BY pip.payment_date ASC, pip.created_at ASC
    `;
    const result = await pool.query(query, [installmentId]);
    return result.rows;
  }

  /** All payments for a plot */
  async findByPlotId(plotId, pool) {
    const query = `
      SELECT pip.*, pi.installment_name, pi.due_date, u.name AS created_by_name
      FROM plot_installment_payments pip
      JOIN plot_installments pi ON pi.id = pip.installment_id
      LEFT JOIN users u ON u.id = pip.created_by
      WHERE pip.plot_id = $1
      ORDER BY pip.payment_date ASC, pip.created_at ASC
    `;
    const result = await pool.query(query, [plotId]);
    return result.rows;
  }
}

export const installmentModel = new InstallmentModel();
export const installmentPaymentModel = new InstallmentPaymentModel();
