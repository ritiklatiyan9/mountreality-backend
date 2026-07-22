import asyncHandler from '../utils/asyncHandler.js';
import { memberCategoryModel } from '../models/MemberCategory.model.js';
import pool from '../config/db.js';

/** GET /member-categories — List all categories */
export const listCategories = asyncHandler(async (req, res) => {
    const categories = await memberCategoryModel.findAllOrdered(pool);
    res.json({ categories });
});

/** POST /member-categories — Create a custom category */
export const createCategory = asyncHandler(async (req, res) => {
    const { name, description, icon, color } = req.body;
    if (!name) return res.status(400).json({ message: 'Category name is required' });

    const slug = name.trim().toUpperCase().replace(/\s+/g, '_');

    // Check duplicate
    const existing = await memberCategoryModel.findBySlug(slug, pool);
    if (existing) return res.status(409).json({ message: 'Category with this name already exists' });

    const category = await memberCategoryModel.create({
        name: name.trim(),
        slug,
        description: description || null,
        icon: icon || 'Tag',
        color: color || 'slate',
        is_predefined: false,
    }, pool);

    res.status(201).json({ category });
});

/** PUT /member-categories/:id — Update a custom category */
export const updateCategory = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const existing = await memberCategoryModel.findById(parseInt(id), pool);
    if (!existing) return res.status(404).json({ message: 'Category not found' });
    if (existing.is_predefined) return res.status(403).json({ message: 'Cannot modify predefined categories' });

    const { name, description, icon, color } = req.body;
    const data = {};
    if (name !== undefined) {
        data.name = name.trim();
        data.slug = name.trim().toUpperCase().replace(/\s+/g, '_');
    }
    if (description !== undefined) data.description = description;
    if (icon !== undefined) data.icon = icon;
    if (color !== undefined) data.color = color;
    data.updated_at = new Date();

    const updated = await memberCategoryModel.update(parseInt(id), data, pool);
    res.json({ category: updated });
});

/** DELETE /member-categories/:id — Delete a custom category */
export const deleteCategory = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const existing = await memberCategoryModel.findById(parseInt(id), pool);
    if (!existing) return res.status(404).json({ message: 'Category not found' });
    if (existing.is_predefined) return res.status(403).json({ message: 'Cannot delete predefined categories' });

    await memberCategoryModel.delete(parseInt(id), pool);
    res.json({ message: 'Category deleted' });
});
