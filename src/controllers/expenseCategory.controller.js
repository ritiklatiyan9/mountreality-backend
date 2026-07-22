import asyncHandler from '../utils/asyncHandler.js';
import { expenseCategoryModel } from '../models/ExpenseCategory.model.js';
import pool from '../config/db.js';

export const listExpenseCategories = asyncHandler(async (req, res) => {
    const categories = await expenseCategoryModel.findAllOrdered(pool);
    res.json({ categories });
});

export const createExpenseCategory = asyncHandler(async (req, res) => {
    const { name, icon, color, grp } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ message: 'Category name is required' });
    }

    const trimmed = name.trim().toUpperCase();

    // Single CTE: dup-check + INSERT in ONE round-trip (was 2).
    const result = await pool.query(
        `WITH existing AS (
           SELECT 1 FROM expense_categories WHERE UPPER(name) = $1 LIMIT 1
         ),
         ins AS (
           INSERT INTO expense_categories (name, icon, color, grp)
           SELECT $1, $2, $3, $4
           WHERE NOT EXISTS (SELECT 1 FROM existing)
           RETURNING *
         )
         SELECT
           (SELECT row_to_json(ins) FROM ins) AS category,
           EXISTS (SELECT 1 FROM existing) AS dup`,
        [trimmed, icon || 'Tag', color || 'slate', grp || 'Custom']
    );
    const row = result.rows[0];
    if (row.dup) return res.status(409).json({ message: 'Category already exists' });
    res.status(201).json({ category: row.category });
});

export const updateExpenseCategory = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id);
    const { name, icon, color, grp } = req.body;
    const data = {};
    if (name !== undefined) data.name = name.trim().toUpperCase();
    if (icon !== undefined) data.icon = icon;
    if (color !== undefined) data.color = color;
    if (grp !== undefined) data.grp = grp;

    if (Object.keys(data).length === 0) {
        return res.status(400).json({ message: 'Nothing to update' });
    }

    // Atomic UPDATE — saves a SELECT round-trip.
    const updated = await expenseCategoryModel.update(id, data, pool);
    if (!updated) return res.status(404).json({ message: 'Category not found' });
    res.json({ category: updated });
});

export const deleteExpenseCategory = asyncHandler(async (req, res) => {
    // Atomic DELETE — saves a SELECT round-trip.
    const result = await pool.query(
        `DELETE FROM expense_categories WHERE id = $1 RETURNING id`,
        [parseInt(req.params.id)]
    );
    if (!result.rows[0]) return res.status(404).json({ message: 'Category not found' });
    res.json({ message: 'Category deleted' });
});
