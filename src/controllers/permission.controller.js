import asyncHandler from '../utils/asyncHandler.js';
import permissionModel, { ALL_MODULES } from '../models/Permission.model.js';
import pool from '../config/db.js';

const findTenantSubAdmin = async (userId, organizationId) => {
    const { rows } = await pool.query(
        `SELECT id,role,organization_id FROM users
          WHERE id=$1 AND organization_id=$2 AND role='sub_admin' LIMIT 1`,
        [userId, organizationId]
    );
    return rows[0] || null;
};

/**
 * GET /permissions/:userId
 * Get all permissions for a sub-admin (admin only)
 */
export const getPermissions = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const parsedUserId = parseInt(userId, 10);

    if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) {
        return res.status(400).json({ message: 'Invalid userId' });
    }

    // Verify user exists and is a sub_admin
    const user = await findTenantSubAdmin(parsedUserId, req.user.organization_id);
    if (!user) {
        return res.status(404).json({ message: 'Sub-admin not found' });
    }

    const permissions = await permissionModel.getByUserId(parsedUserId);

    res.json({ permissions, modules: ALL_MODULES });
});

/**
 * PUT /permissions/:userId
 * Bulk update permissions for a sub-admin (admin only)
 * Body: { permissions: [{ module, can_read, can_write, can_update, can_delete }] }
 */
export const updatePermissions = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { permissions } = req.body;
    const parsedUserId = parseInt(userId, 10);

    if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) {
        return res.status(400).json({ message: 'Invalid userId' });
    }

    if (!permissions || !Array.isArray(permissions)) {
        return res.status(400).json({ message: 'permissions array is required' });
    }

    // Verify user exists and is a sub_admin
    const user = await findTenantSubAdmin(parsedUserId, req.user.organization_id);
    if (!user) {
        return res.status(404).json({ message: 'Sub-admin not found' });
    }

    const invalidModules = permissions
        .map(permission => permission?.module)
        .filter(module => !ALL_MODULES.includes(module));
    if (invalidModules.length > 0) {
        return res.status(400).json({
            message: `Unknown permission module(s): ${[...new Set(invalidModules)].join(', ')}`,
        });
    }

    const actionFields = ['can_read', 'can_write', 'can_update', 'can_delete'];
    const hasInvalidAction = permissions.some(permission =>
        actionFields.some(field => typeof permission[field] !== 'boolean')
    );
    if (hasInvalidAction) {
        return res.status(400).json({ message: 'Every permission action must be a boolean' });
    }

    // Last value wins for accidental duplicate module rows, then all writes are
    // committed atomically by the model.
    const deduplicated = [...new Map(permissions.map(permission => [permission.module, permission])).values()];
    await permissionModel.bulkUpsert(parsedUserId, deduplicated);
    const updated = await permissionModel.getByUserId(parsedUserId);
    res.json({
        permissions: updated,
        modules: ALL_MODULES,
        message: 'Permissions updated successfully',
    });
});
