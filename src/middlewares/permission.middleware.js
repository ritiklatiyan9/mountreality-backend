import permissionModel from '../models/Permission.model.js';

/**
 * Permission-based access middleware.
 * Usage: requirePermission('farmers', 'delete')
 * Actions: 'read', 'write', 'update', 'delete'
 *
 * Admin always passes. Sub-admin is checked against user_permissions table.
 */
const requirePermission = (module, action) => {
    return async (req, res, next) => {
        try {
            // Admin and super_admin always have full access
            if (req.user.role === 'admin' || req.user.role === 'super_admin') {
                return next();
            }

            // For sub_admin, check permissions
            if (req.user.role === 'sub_admin') {
                const permission = await permissionModel.getPermission(req.user.id, module);

                // If no permission record exists, deny by default
                if (!permission) {
                    return res.status(403).json({ message: `You do not have permission to ${action} in this module` });
                }

                const fieldName = `can_${action}`;
                // Fail closed for malformed/legacy rows as well as explicit
                // false values. Only a stored boolean true grants access.
                if (permission[fieldName] !== true) {
                    return res.status(403).json({ message: `You do not have permission to ${action} in this module` });
                }

                return next();
            }

            // Other roles denied
            return res.status(403).json({ message: 'Insufficient permissions' });
        } catch (err) {
            console.error('Permission middleware error:', err);
            return res.status(500).json({ message: 'Permission check failed' });
        }
    };
};

export default requirePermission;
