import permissionModel from '../models/Permission.model.js';
import { isSiteModuleAllowed, NEW_MODULES } from '../services/sitePolicy.service.js';

const SITE_POLICY_MODULES = new Set(NEW_MODULES);

async function enforceSitePolicy(req, res, module) {
    // The Operating Profile is the Site control plane. Keeping it reachable is
    // what lets a legacy Site create its first published policy; user RBAC is
    // still enforced separately below.
    if (module === 'operating_profile') return true;

    const siteId = req.siteContextId;
    if (!siteId) {
        // Existing endpoints historically allowed organization-wide requests,
        // so preserve that behaviour. New policy-only domains must always carry
        // an explicit selected-Site context and fail closed without one.
        if (SITE_POLICY_MODULES.has(module)) {
            res.status(400).json({
                code: 'SITE_CONTEXT_REQUIRED',
                message: 'Select a Site before using this module',
            });
            return false;
        }
        return true;
    }

    const allowed = await isSiteModuleAllowed({
        organizationId: req.user.organization_id,
        siteId,
        module,
    });
    if (!allowed) {
        res.status(403).json({
            code: 'SITE_POLICY_DENIED',
            message: 'This module is not available for the selected Site operating profile',
        });
        return false;
    }
    return true;
}

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
            let rbacAllowed = false;

            // Admin and super_admin bypass user RBAC, but never the selected
            // Site policy. This keeps direct API access aligned with the UI.
            if (req.user.role === 'admin' || req.user.role === 'super_admin') {
                rbacAllowed = true;
            }

            // For sub_admin, check permissions
            if (!rbacAllowed && req.user.role === 'sub_admin') {
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

                rbacAllowed = true;
            }

            if (!rbacAllowed) {
                return res.status(403).json({ message: 'Insufficient permissions' });
            }

            if (!(await enforceSitePolicy(req, res, module))) return;
            return next();
        } catch (err) {
            console.error('Permission middleware error:', err);
            return res.status(500).json({ message: 'Permission check failed' });
        }
    };
};

export default requirePermission;
