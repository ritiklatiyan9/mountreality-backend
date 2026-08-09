import pool from '../config/db.js';
import { enforceEntitySiteAccess } from '../utils/siteAccessPolicy.js';

const LOOKUPS = Object.freeze({
  site: null,
  plot: 'SELECT site_id FROM plots WHERE id=$1 LIMIT 1',
  booking: 'SELECT site_id FROM bookings WHERE id=$1 LIMIT 1',
  agreement: 'SELECT site_id FROM booking_agreements WHERE id=$1 LIMIT 1',
  cancellation: 'SELECT site_id FROM booking_cancellations WHERE id=$1 LIMIT 1',
  refund: 'SELECT bc.site_id FROM booking_refunds br JOIN booking_cancellations bc ON bc.id=br.cancellation_id WHERE br.id=$1 LIMIT 1',
  transfer: 'SELECT site_id FROM booking_transfers WHERE id=$1 LIMIT 1',
  registry: 'SELECT site_id FROM plot_registries WHERE id=$1 LIMIT 1',
  possession: 'SELECT site_id FROM plot_possessions WHERE id=$1 LIMIT 1',
  payment: 'SELECT site_id FROM plot_payments WHERE id=$1 LIMIT 1',
  firmTransaction: 'SELECT site_id FROM firm_transactions WHERE id=$1 LIMIT 1',
  projectAccount: 'SELECT site_id FROM project_account_mappings WHERE id=$1 LIMIT 1',
  projectAllocation: 'SELECT site_id FROM project_transaction_allocations WHERE id=$1 LIMIT 1',
});

const parseId = (value) => {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

export default function requirePropertyLifecycleSiteAccess({
  entity, source, key, module = 'plot_payments',
}) {
  if (!Object.prototype.hasOwnProperty.call(LOOKUPS, entity)) {
    throw new Error(`Unsupported property lifecycle entity: ${entity}`);
  }
  return async (req, res, next) => {
    try {
      const entityId = parseId(req[source]?.[key]);
      if (!entityId) return next();
      let siteId = entityId;
      if (LOOKUPS[entity]) {
        const { rows } = await pool.query(LOOKUPS[entity], [entityId]);
        if (!rows[0]) return next();
        siteId = parseId(rows[0].site_id);
      }
      if (!siteId) return res.status(409).json({ message: 'This record is not linked to a Site' });
      const allowed = await enforceEntitySiteAccess({
        req, res, siteId, module, contextProperty: 'propertyLifecycleSiteId',
      });
      if (allowed) next();
    } catch (error) {
      next(error);
    }
  };
}
