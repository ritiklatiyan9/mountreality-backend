import express from 'express';
import {
  createDayBookEntry,
  listDayBookEntries,
  getDayBookEntry,
  updateDayBookEntry,
  deleteDayBookEntry,
  getAutocomplete,
  updateExpenseFromDayBook,
  deleteExpenseFromDayBook,
  listFarmersForDayBook,
  updateFarmerPaymentFromDayBook,
  deleteFarmerPaymentFromDayBook,
  listMembersForDayBook,
  updateCommissionFromDayBook,
  deleteCommissionFromDayBook,
  listCashFlowLedgersForDayBook,
  updateCashFlowEntryFromDayBook,
  deleteCashFlowEntryFromDayBook,
  listFirmsForDayBook,
  updateFirmTransactionFromDayBook,
  deleteFirmTransactionFromDayBook,
  listPlotsForDayBook,
  updatePlotPaymentFromDayBook,
  deletePlotPaymentFromDayBook,
  updateModulePaymentFromDayBook,
  deleteModulePaymentFromDayBook,
  listRecentTransactions,
  getProfitSummary,
  getProfitMonthly,
  getLatestDate,
  verifyData,
  getDailyBalance,
  getModeBalance,
} from '../controllers/daybook.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';
import { requireEntitySiteAccess } from '../middlewares/legacyEntitySiteAccess.middleware.js';

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

const daybookReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'daybook' });
// Daybook mutations affect expenses, farmers, cashflow, plots, firms — bust all related caches
const bustDaybookCache = invalidateCacheOnSuccess(['/daybook', '/expenses', '/farmers', '/cashflow', '/plots', '/firms']);
const byEntity = (entity) => requireEntitySiteAccess({ entity, module: 'daybook' });
const daybookById = byEntity('daybook');
const expenseById = byEntity('expense');
const farmerPaymentById = byEntity('farmer_payment');
const commissionById = byEntity('plot_commission');
const cashflowEntryById = byEntity('cashflow_entry');
const cashflowMonthByBody = requireEntitySiteAccess({ entity: 'cashflow_month', source: 'body', key: 'cash_flow_month_id', module: 'daybook' });
const firmTransactionById = byEntity('firm_transaction');
const plotPaymentById = byEntity('plot_payment');
const moduleEntity = (req) => ({
  'vendor-payment': 'vendor_payment',
  'commission-payment': 'plot_commission_payment',
  'installment-payment': 'plot_installment_payment',
}[req.params.module] || 'daybook');
const modulePaymentById = byEntity(moduleEntity);

// Recent transactions (Dashboard) — must be before /:id route
router.get('/recent', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), daybookReadCache, listRecentTransactions);

// Profit summary (Dashboard)
router.get('/profit-summary', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), daybookReadCache, getProfitSummary);
router.get('/profit-monthly', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), daybookReadCache, getProfitMonthly);

// Data verify (Dashboard)
router.get('/verify-data', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), verifyData);

// Latest date with data (auto-jump on site change)
router.get('/latest-date', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), daybookReadCache, getLatestDate);

// Daily opening + closing balance (seeds today on first read)
router.get('/daily-balance', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), getDailyBalance);

// Cash + Bank cumulative balance (powers the cards on /daybook/cash and /daybook/bank)
router.get('/mode-balance', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), daybookReadCache, getModeBalance);

// Day Book CRUD
router.post('/', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'write'), cashflowMonthByBody, bustDaybookCache, createDayBookEntry);
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), daybookReadCache, listDayBookEntries);
router.get('/autocomplete', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), daybookReadCache, getAutocomplete);

// Farmers list for dropdown
router.get('/farmers', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), daybookReadCache, listFarmersForDayBook);

// Expense entries managed from Day Book
router.put('/expense/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'update'), expenseById, bustDaybookCache, updateExpenseFromDayBook);
router.delete('/expense/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'delete'), expenseById, bustDaybookCache, deleteExpenseFromDayBook);

// Farmer payment entries managed from Day Book
router.put('/farmer-payment/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'update'), farmerPaymentById, bustDaybookCache, updateFarmerPaymentFromDayBook);
router.delete('/farmer-payment/:id', requirePermission('daybook', 'delete'), farmerPaymentById, bustDaybookCache, deleteFarmerPaymentFromDayBook);

// Members list for dropdown (Plot Commission)
router.get('/members', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), daybookReadCache, listMembersForDayBook);

// Commission entries managed from Day Book
router.put('/commission/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'update'), commissionById, bustDaybookCache, updateCommissionFromDayBook);
router.delete('/commission/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'delete'), commissionById, bustDaybookCache, deleteCommissionFromDayBook);

// Cash Flow ledgers list for dropdown + entries managed from Day Book
router.get('/cashflow-ledgers', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), daybookReadCache, listCashFlowLedgersForDayBook);
router.put('/cashflow-entry/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'update'), cashflowEntryById, bustDaybookCache, updateCashFlowEntryFromDayBook);
router.delete('/cashflow-entry/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'delete'), cashflowEntryById, bustDaybookCache, deleteCashFlowEntryFromDayBook);

// Firms list for dropdown + firm transactions managed from Day Book
router.get('/firms', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), daybookReadCache, listFirmsForDayBook);
router.put('/firm-transaction/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'update'), firmTransactionById, bustDaybookCache, updateFirmTransactionFromDayBook);
router.delete('/firm-transaction/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'delete'), firmTransactionById, bustDaybookCache, deleteFirmTransactionFromDayBook);

// Plots list for dropdown + plot payments managed from Day Book
router.get('/plots', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), daybookReadCache, listPlotsForDayBook);
router.put('/plot-payment/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'update'), plotPaymentById, bustDaybookCache, updatePlotPaymentFromDayBook);
router.delete('/plot-payment/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'delete'), plotPaymentById, bustDaybookCache, deletePlotPaymentFromDayBook);

// Vendor / commission / installment / registry payments managed from Day Book
// (module param is whitelisted in the controller)
router.put('/module/:module/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'update'), modulePaymentById, bustDaybookCache, updateModulePaymentFromDayBook);
router.delete('/module/:module/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'delete'), modulePaymentById, bustDaybookCache, deleteModulePaymentFromDayBook);

router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), daybookById, daybookReadCache, getDayBookEntry);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'update'), daybookById, bustDaybookCache, updateDayBookEntry);
router.delete('/:id', requirePermission('daybook', 'delete'), daybookById, bustDaybookCache, deleteDayBookEntry);

export default router;
