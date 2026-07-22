import MasterModel from './MasterModel.js';

class MemberCategoryModel extends MasterModel {
    constructor() {
        super('member_categories');
    }

    /** All categories ordered: predefined first, then custom */
    async findAllOrdered(pool) {
        const query = `SELECT * FROM member_categories ORDER BY is_predefined DESC, name ASC`;
        const result = await pool.query(query);
        return result.rows;
    }

    /** Find by slug */
    async findBySlug(slug, pool) {
        const query = `SELECT * FROM member_categories WHERE slug = $1`;
        const result = await pool.query(query, [slug]);
        return result.rows[0];
    }
}

export const memberCategoryModel = new MemberCategoryModel();
