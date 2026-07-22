import MasterModel from './MasterModel.js';

class ExpenseCategoryModel extends MasterModel {
    constructor() {
        super('expense_categories');
    }

    async findAllOrdered(dbPool) {
        const { rows } = await dbPool.query(
            `SELECT * FROM expense_categories ORDER BY grp, name`
        );
        return rows;
    }

    async findByName(name, dbPool) {
        const { rows } = await dbPool.query(
            `SELECT * FROM expense_categories WHERE UPPER(name) = UPPER($1)`,
            [name]
        );
        return rows[0] || null;
    }
}

export const expenseCategoryModel = new ExpenseCategoryModel();
