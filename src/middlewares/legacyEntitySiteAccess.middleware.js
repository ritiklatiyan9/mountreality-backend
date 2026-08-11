import pool from '../config/db.js';
import { enforceEntitySiteAccess } from '../utils/siteAccessPolicy.js';

const LOOKUPS = Object.freeze({
  expense: 'SELECT site_id FROM expenses WHERE id=$1 LIMIT 1',
  firm: 'SELECT site_id FROM firms WHERE id=$1 LIMIT 1',
  firm_transaction: 'SELECT site_id FROM firm_transactions WHERE id=$1 LIMIT 1',
  vendor_head: 'SELECT site_id FROM vendor_heads WHERE id=$1 LIMIT 1',
  vendor_commitment: 'SELECT site_id FROM vendor_commitments WHERE id=$1 LIMIT 1',
  vendor_payment: 'SELECT site_id FROM vendor_payments WHERE id=$1 LIMIT 1',
  inventory_order: 'SELECT site_id FROM vendor_inventory_orders WHERE id=$1 LIMIT 1',
  inventory_payment: 'SELECT site_id FROM vendor_inventory_payments WHERE id=$1 LIMIT 1',
  daybook: 'SELECT site_id FROM day_book WHERE id=$1 LIMIT 1',
  farmer_payment: `SELECT f.site_id FROM farmer_payments fp JOIN farmers f ON f.id=fp.farmer_id WHERE fp.id=$1 LIMIT 1`,
  plot_commission: 'SELECT site_id FROM plot_commissions WHERE id=$1 LIMIT 1',
  plot_commission_payment: 'SELECT site_id FROM plot_commission_payments WHERE id=$1 LIMIT 1',
  plot_installment_payment: `SELECT p.site_id FROM plot_installment_payments pip JOIN plots p ON p.id=pip.plot_id WHERE pip.id=$1 LIMIT 1`,
  cashflow_month: 'SELECT site_id FROM cash_flow_months WHERE id=$1 LIMIT 1',
  cashflow_entry: 'SELECT site_id FROM cash_flow_entries WHERE id=$1 LIMIT 1',
  plot_payment: 'SELECT site_id FROM plot_payments WHERE id=$1 LIMIT 1',
  member: 'SELECT site_id FROM members WHERE id=$1 LIMIT 1',
  excel_file: 'SELECT site_id FROM excel_files WHERE id=$1 LIMIT 1',
  folder: 'SELECT site_id FROM file_folders WHERE id=$1 LIMIT 1',
});

const positiveId = (value) => {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const entityName = (entity, req) => typeof entity === 'function' ? entity(req) : entity;

async function resolveSite(entity, id) {
  const sql = LOOKUPS[entity];
  if (!sql) throw new Error(`Unsupported Site-scoped entity: ${entity}`);
  const { rows } = await pool.query(sql, [id]);
  return rows[0]?.site_id || null;
}

export const requireEntitySiteAccess = ({ entity, source = 'params', key = 'id', module }) => async (req, res, next) => {
  try {
    const id = positiveId(req[source]?.[key]);
    if (!id) return next();
    const resolvedEntity = entityName(entity, req);
    const siteId = await resolveSite(resolvedEntity, id);
    if (!siteId) return next();
    const allowed = await enforceEntitySiteAccess({ req, res, siteId, module });
    if (!allowed) return;
    return next();
  } catch (error) {
    return next(error);
  }
};

export const requireRequestSiteAccess = ({ source = 'body', key = 'site_id', module }) => async (req, res, next) => {
  try {
    const siteId = positiveId(req[source]?.[key]);
    if (!siteId) return next();
    const allowed = await enforceEntitySiteAccess({ req, res, siteId, module });
    if (!allowed) return;
    return next();
  } catch (error) {
    return next(error);
  }
};

export const requireBulkEntitySiteAccess = ({ getItems, module }) => async (req, res, next) => {
  try {
    const raw = getItems(req) || [];
    const items = raw
      .map((item) => ({ entity: entityName(item.entity, req), id: positiveId(item.id) }))
      .filter((item) => item.id);
    if (items.length > 100) return res.status(400).json({ message: 'Bulk requests are limited to 100 records' });
    const sites = new Set();
    for (const item of items) {
      const siteId = await resolveSite(item.entity, item.id);
      if (!siteId) return res.status(404).json({ message: 'One or more records were not found' });
      sites.add(Number(siteId));
    }
    for (const siteId of sites) {
      const allowed = await enforceEntitySiteAccess({ req, res, siteId, module });
      if (!allowed) return;
    }
    return next();
  } catch (error) {
    return next(error);
  }
};

export default requireEntitySiteAccess;
