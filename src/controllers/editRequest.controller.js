import asyncHandler from '../utils/asyncHandler.js';
import { editRequestModel } from '../models/EditRequest.model.js';
import { farmerModel, farmerPaymentModel } from '../models/Farmer.model.js';
import { plotModel, plotPaymentModel } from '../models/Plot.model.js';
import { dayBookModel } from '../models/DayBook.model.js';
import { expenseModel } from '../models/Expense.model.js';
import { plotCommissionModel } from '../models/PlotCommission.model.js';
import { cashFlowEntryModel } from '../models/CashFlow.model.js';
import { firmTransactionModel } from '../models/Firm.model.js';
import fs from 'node:fs/promises';
import { deleteCloudinaryAsset, uploadCloudinaryAsset } from '../utils/cloudinary.js';
import { createRegistryRecord } from './registry.controller.js';
import permissionModel from '../models/Permission.model.js';
import pool from '../config/db.js';
import { classifyPaymentMode, normalizeCashType } from '../utils/paymentMode.js';
import { resolveBankAccountSelection } from '../services/bankAccount.service.js';

const canonicalPaymentMode = (raw) => {
  const bucket = classifyPaymentMode(raw);
  return bucket === 'cash' ? 'CASH' : bucket === 'cheque' ? 'CHEQUE' : 'BANK';
};

const resolveChequeStatus = ({ currentMode, currentStatus, nextMode }) => {
  if (classifyPaymentMode(nextMode) !== 'cheque') return null;
  return classifyPaymentMode(currentMode) === 'cheque'
    ? (currentStatus || 'PENDING')
    : 'PENDING';
};

const normalizeFarmerAllocation = ({ paymentMode, totalAmount, cashAmount, bankAmount }) => {
  const total = Number(totalAmount ?? 0);
  if (!Number.isFinite(total)) throw new Error('Amount must be a valid number');
  const rawMode = String(paymentMode ?? '').trim().toUpperCase();
  if (rawMode === 'SPLIT') {
    const cash = Number(cashAmount ?? 0);
    const bank = Number(bankAmount ?? 0);
    if (!Number.isFinite(cash) || !Number.isFinite(bank) || cash < 0 || bank < 0
        || Math.abs((cash + bank) - total) > 1e-9) {
      throw new Error('Split cash and bank amounts must be nonnegative and equal the total amount');
    }
    return { mode: 'SPLIT', total, cash, bank };
  }
  const mode = canonicalPaymentMode(rawMode);
  return {
    mode,
    total,
    cash: mode === 'CASH' ? total : 0,
    bank: mode === 'CASH' ? 0 : total,
  };
};

// Map module name to { model, fetchOriginal }
const MODULE_MAP = {
  // Create-type request: a sub-admin wants a registry while the plot's bank
  // payments are not yet clear. record_id = plot_id (dedupes to one pending
  // request per plot); proposed_data = the full POST /registries payload.
  // Approval runs the real create, attributed to the original requester.
  plot_registry_create: {
    model: plotModel,
    fetchOriginal: async (id, db = pool) => plotModel.findById(parseInt(id), db),
    // Reject guaranteed-to-fail requests up-front instead of parking them in
    // the admin queue. Returns an error message or null.
    validateCreate: async (data, user, recordId, requestSiteId) => {
      if (user.role !== 'admin' && user.role !== 'super_admin' && user.role !== 'sub_admin') {
        return 'Not allowed to request a registry';
      }
      const total = (Array.isArray(data?.payments) ? data.payments : [])
        .reduce((n, p) => n + (parseFloat(p?.amount) || (p?.source_plot_payment_id ? 1 : 0)), 0);
      if (total <= 0) {
        return 'Map at least one payment before requesting a registry — a registry cannot be created without money mapped to it';
      }
      const siteId = Number.parseInt(data?.site_id, 10);
      const plotId = Number.parseInt(data?.plot_id, 10);
      if (!Number.isInteger(siteId) || siteId <= 0) return 'A valid registry site is required';
      if (!Number.isInteger(plotId) || plotId <= 0) return 'A valid plot is required';
      if (plotId !== Number.parseInt(recordId, 10)) return 'The request record does not match the selected plot';
      if (siteId !== Number.parseInt(requestSiteId, 10)) {
        return 'The request site does not match the registry site';
      }

      const [plotResult, siteAccessResult, permission] = await Promise.all([
        pool.query('SELECT site_id, plot_no FROM plots WHERE id = $1 LIMIT 1', [plotId]),
        user.role === 'sub_admin'
          ? pool.query('SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1', [user.id, siteId])
          : Promise.resolve({ rows: [{}] }),
        user.role === 'sub_admin'
          ? permissionModel.getPermission(user.id, 'plot_registry')
          : Promise.resolve({ can_write: true }),
      ]);
      if (!plotResult.rows[0]) return 'Plot not found';
      if (Number.parseInt(plotResult.rows[0].site_id, 10) !== siteId) {
        return 'Selected plot does not belong to the registry site';
      }
      if (String(plotResult.rows[0].plot_no || '').trim().toUpperCase()
          !== String(data?.plot_no || '').trim().toUpperCase()) {
        return 'Registry plot number does not match the selected plot';
      }
      if (!siteAccessResult.rows[0]) return 'Access denied to this registry site';
      if (permission?.can_write !== true) return 'Plot Registry create permission is required';

      if (data?.site_id && data?.plot_no) {
        const { rows } = await pool.query(
          `SELECT 1 FROM plot_registries WHERE site_id = $1 AND UPPER(plot_no) = UPPER($2) LIMIT 1`,
          [parseInt(data.site_id), String(data.plot_no).trim()]
        );
        if (rows.length) return `Registry for plot "${data.plot_no}" already exists`;
      }
      return null;
    },
    applyUpdate: async (id, data, editReq, db = pool) => {
      const out = await createRegistryRecord(data, editReq?.requested_by || null, db);
      if (out.status >= 400) throw new Error(out.body?.message || 'Failed to create registry');
      return out.body;
    },
  },
  farmer: {
    model: farmerModel,
    fetchOriginal: async (id, db = pool) => farmerModel.findById(parseInt(id), db),
    applyUpdate: async (id, data, editReq, db = pool) => {
      // farmers table columns: name, phone, address, total_amount, interest_rate, notes, status
      const allowed = {};
      if (data.name !== undefined) allowed.name = data.name;
      if (data.phone !== undefined) allowed.phone = data.phone;
      if (data.address !== undefined) allowed.address = data.address;
      if (data.interest_rate !== undefined) allowed.interest_rate = data.interest_rate;
      if (data.notes !== undefined) allowed.notes = data.notes;
      if (data.status !== undefined) allowed.status = data.status;
      if ([data.payment_mode, data.total_amount, data.cash_amount, data.bank_amount].some((value) => value !== undefined)) {
        const current = await farmerModel.findById(parseInt(id), db);
        const allocation = normalizeFarmerAllocation({
          paymentMode: data.payment_mode !== undefined ? data.payment_mode : current?.payment_mode,
          totalAmount: data.total_amount !== undefined ? data.total_amount : current?.total_amount,
          cashAmount: data.cash_amount !== undefined ? data.cash_amount : current?.cash_amount,
          bankAmount: data.bank_amount !== undefined ? data.bank_amount : current?.bank_amount,
        });
        allowed.total_amount = allocation.total;
        allowed.payment_mode = allocation.mode;
        allowed.cash_amount = allocation.cash;
        allowed.bank_amount = allocation.bank;
      }
      if (Object.keys(allowed).length > 0) {
        return farmerModel.update(parseInt(id), allowed, db);
      }
    },
  },
  farmer_payment: {
    model: farmerPaymentModel,
    fetchOriginal: async (id, db = pool) => farmerPaymentModel.findById(parseInt(id), db),
    applyUpdate: async (id, data, editReq, db = pool) => {
      // Keep the authoritative source allocation in sync; its trigger owns the
      // canonical Cash/Bank ledger row.
      const current = await farmerPaymentModel.findById(parseInt(id), db);
      const allowed = {};
      if (data.date !== undefined) allowed.date = data.date;
      if (data.particular !== undefined) allowed.particular = data.particular;
      if (data.amount !== undefined) allowed.amount = data.amount;
      if (data.by_note !== undefined) allowed.by_note = data.by_note;
      if (data.interest_rate !== undefined) allowed.interest_rate = data.interest_rate;
      if (data.interest_amount !== undefined) allowed.interest_amount = data.interest_amount;
      if (data.remarks !== undefined) allowed.remarks = data.remarks;
      if (data.farmer_id !== undefined) allowed.farmer_id = data.farmer_id;

      if ([data.payment_mode, data.amount, data.cash_amount, data.bank_amount].some((value) => value !== undefined)) {
        const allocation = normalizeFarmerAllocation({
          paymentMode: data.payment_mode !== undefined ? data.payment_mode : current?.payment_mode,
          totalAmount: data.amount !== undefined ? data.amount : current?.amount,
          cashAmount: data.cash_amount !== undefined ? data.cash_amount : current?.cash_amount,
          bankAmount: data.bank_amount !== undefined ? data.bank_amount : current?.bank_amount,
        });
        allowed.payment_mode = allocation.mode;
        allowed.amount = allocation.total;
        allowed.cash_amount = allocation.cash;
        allowed.bank_amount = allocation.bank;
        allowed.cheque_status = resolveChequeStatus({
          currentMode: current?.payment_mode,
          currentStatus: current?.cheque_status,
          nextMode: allocation.mode,
        });
        allowed.cheque_no = allocation.mode === 'CHEQUE'
          ? (data.cheque_no !== undefined ? data.cheque_no || null : current?.cheque_no || null)
          : null;
      } else if (data.cheque_no !== undefined) {
        allowed.cheque_no = classifyPaymentMode(current?.payment_mode) === 'cheque'
          ? data.cheque_no || null
          : null;
      }
      if (data.payment_mode !== undefined || data.bank_account_id !== undefined) {
        const { rows } = await db.query(
          `SELECT f.site_id FROM farmer_payments fp JOIN farmers f ON f.id=fp.farmer_id WHERE fp.id=$1 LIMIT 1`,
          [parseInt(id)],
        );
        allowed.bank_account_id = await resolveBankAccountSelection({
          siteId: rows[0]?.site_id,
          paymentMode: allowed.payment_mode || current?.payment_mode,
          bankAccountId: data.bank_account_id !== undefined ? data.bank_account_id : current?.bank_account_id,
          db,
        });
      }
      if (Object.keys(allowed).length > 0) {
        return farmerPaymentModel.update(parseInt(id), allowed, db);
      }
    },
  },
  plot: {
    model: plotModel,
    fetchOriginal: async (id, db = pool) => plotModel.findById(parseInt(id), db),
    applyUpdate: async (id, data, editReq, db = pool) => {
      // plots columns: plot_no, block, buyer_name, plot_size, plot_rate, sale_price, registry_area, circle_rate, to_receive_bank, first_installment, booking_by, booking_date, status, notes
      const allowed = {};
      for (const key of ['plot_no', 'block', 'buyer_name', 'plot_size', 'plot_rate', 'sale_price', 'registry_area', 'circle_rate', 'to_receive_bank', 'first_installment', 'booking_by', 'booking_date', 'notes']) {
        if (data[key] !== undefined) allowed[key] = data[key];
      }
      // Never write REGISTRY from this generic path. The validation below gives
      // a clear error for a promotion attempt; omitting it here is the final
      // race-safe backstop when editing a plot that is already registered.
      if (data.status !== undefined && String(data.status).trim().toUpperCase() !== 'REGISTRY') {
        allowed.status = data.status;
      }
      if (Object.keys(allowed).length > 0) {
        return plotModel.update(parseInt(id), allowed, db);
      }
    },
  },
  plot_payment: {
    model: plotPaymentModel,
    fetchOriginal: async (id, db = pool) => plotPaymentModel.findById(parseInt(id), db),
    applyUpdate: async (id, data, editReq, db = pool) => {
      // plot_payments columns: date, payment_from, payment_type, bank_details, narration, received_by, amount, plot_id
      const current = await plotPaymentModel.findById(parseInt(id), db);
      const allowed = {};
      if (data.date !== undefined) allowed.date = data.date;
      if (data.payment_from !== undefined) allowed.payment_from = data.payment_from;
      if (data.payment_type !== undefined) {
        allowed.payment_type = canonicalPaymentMode(data.payment_type);
        allowed.cheque_status = data.cheque_status !== undefined && allowed.payment_type === 'CHEQUE'
          ? (data.cheque_status ? String(data.cheque_status).trim().toUpperCase() : 'PENDING')
          : resolveChequeStatus({
            currentMode: current?.payment_type,
            currentStatus: current?.cheque_status,
            nextMode: allowed.payment_type,
          });
        allowed.cheque_no = allowed.payment_type === 'CHEQUE'
          ? (data.cheque_no !== undefined ? data.cheque_no || null : current?.cheque_no || null)
          : null;
      }
      if (data.bank_details !== undefined) allowed.bank_details = data.bank_details;
      if (data.narration !== undefined) allowed.narration = data.narration;
      if (data.received_by !== undefined) allowed.received_by = data.received_by;
      if (data.amount !== undefined) allowed.amount = data.amount;
      if (data.plot_id !== undefined) allowed.plot_id = data.plot_id;
      if (data.payment_type === undefined && data.cheque_no !== undefined) {
        allowed.cheque_no = classifyPaymentMode(current?.payment_type) === 'cheque'
          ? data.cheque_no || null
          : null;
      }
      if (data.payment_type === undefined && data.cheque_status !== undefined) {
        allowed.cheque_status = classifyPaymentMode(current?.payment_type) === 'cheque'
          ? (data.cheque_status ? String(data.cheque_status).trim().toUpperCase() : 'PENDING')
          : null;
      }
      if (data.payment_type !== undefined || data.bank_account_id !== undefined) {
        allowed.bank_account_id = await resolveBankAccountSelection({
          siteId: current?.site_id,
          paymentMode: allowed.payment_type || current?.payment_type,
          bankAccountId: data.bank_account_id !== undefined ? data.bank_account_id : current?.bank_account_id,
          db,
        });
      }
      if (Object.keys(allowed).length > 0) {
        return plotPaymentModel.update(parseInt(id), allowed, db);
      }
    },
  },
  daybook: {
    model: dayBookModel,
    fetchOriginal: async (id, db = pool) => dayBookModel.findById(parseInt(id), db),
    applyUpdate: async (id, data, editReq, db = pool) => {
      // day_book columns: date, particular, entry_type, debit, credit, remarks, payment_mode, category, from_entity, to_entity, account_no, branch
      const current = await dayBookModel.findById(parseInt(id), db);
      const allowed = {};
      for (const key of ['date', 'particular', 'entry_type', 'debit', 'credit', 'remarks', 'payment_mode', 'category', 'from_entity', 'to_entity', 'account_no', 'branch']) {
        if (data[key] !== undefined) allowed[key] = data[key];
      }
      if (data.payment_mode !== undefined) {
        const nextMode = data.payment_mode || 'BANK';
        allowed.payment_mode = nextMode;
        allowed.cheque_status = data.cheque_status !== undefined && classifyPaymentMode(nextMode) === 'cheque'
          ? (data.cheque_status ? String(data.cheque_status).trim().toUpperCase() : 'PENDING')
          : resolveChequeStatus({
            currentMode: current?.payment_mode,
            currentStatus: current?.cheque_status,
            nextMode,
          });
        allowed.cheque_no = classifyPaymentMode(nextMode) === 'cheque'
          ? (data.cheque_no !== undefined ? data.cheque_no || null : current?.cheque_no || null)
          : null;
      } else {
        if (data.cheque_no !== undefined) {
          allowed.cheque_no = classifyPaymentMode(current?.payment_mode) === 'cheque' ? data.cheque_no || null : null;
        }
        if (data.cheque_status !== undefined) {
          allowed.cheque_status = classifyPaymentMode(current?.payment_mode) === 'cheque'
            ? (data.cheque_status ? String(data.cheque_status).trim().toUpperCase() : 'PENDING')
            : null;
        }
      }
      if (data.payment_mode !== undefined || data.bank_account_id !== undefined) {
        allowed.bank_account_id = await resolveBankAccountSelection({
          siteId: current?.site_id,
          paymentMode: allowed.payment_mode || current?.payment_mode,
          bankAccountId: data.bank_account_id !== undefined ? data.bank_account_id : current?.bank_account_id,
          db,
        });
      }
      if (Object.keys(allowed).length > 0) {
        return dayBookModel.update(parseInt(id), allowed, db);
      }
    },
  },
  daybook_expense: {
    model: expenseModel,
    fetchOriginal: async (id, db = pool) => expenseModel.findById(parseInt(id), db),
    applyUpdate: async (id, data, editReq, db = pool) => {
      // expenses columns: date, from_entity, to_entity, payment_mode, debit, credit, remark, account_no, branch, category
      const current = await expenseModel.findById(parseInt(id), db);
      const allowed = {};
      if (data.date !== undefined) allowed.date = data.date;
      if (data.from_entity !== undefined) allowed.from_entity = data.from_entity;
      if (data.to_entity !== undefined) allowed.to_entity = data.to_entity;
      if (data.payment_mode !== undefined) {
        const nextMode = data.payment_mode || 'BANK';
        allowed.payment_mode = nextMode;
        allowed.cheque_status = resolveChequeStatus({
          currentMode: current?.payment_mode,
          currentStatus: current?.cheque_status,
          nextMode,
        });
        allowed.cheque_no = classifyPaymentMode(nextMode) === 'cheque'
          ? (data.cheque_no !== undefined ? data.cheque_no || null : current?.cheque_no || null)
          : null;
      } else if (data.cheque_no !== undefined) {
        allowed.cheque_no = classifyPaymentMode(current?.payment_mode) === 'cheque' ? data.cheque_no || null : null;
      }
      if (data.payment_mode !== undefined || data.bank_account_id !== undefined) {
        allowed.bank_account_id = await resolveBankAccountSelection({
          siteId: current?.site_id,
          paymentMode: allowed.payment_mode || current?.payment_mode,
          bankAccountId: data.bank_account_id !== undefined ? data.bank_account_id : current?.bank_account_id,
          db,
        });
      }
      if (data.debit !== undefined) allowed.debit = data.debit;
      if (data.credit !== undefined) allowed.credit = data.credit;
      if (data.remarks !== undefined) allowed.remark = data.remarks; // daybook uses 'remarks', expenses uses 'remark'
      if (data.remark !== undefined) allowed.remark = data.remark;
      if (data.account_no !== undefined) allowed.account_no = data.account_no;
      if (data.branch !== undefined) allowed.branch = data.branch;
      if (data.category !== undefined) allowed.category = data.category;
      if (Object.keys(allowed).length > 0) {
        return expenseModel.update(parseInt(id), allowed, db);
      }
    },
  },
  daybook_farmer_payment: {
    model: farmerPaymentModel,
    fetchOriginal: async (id, db = pool) => farmerPaymentModel.findById(parseInt(id), db),
    applyUpdate: async (id, data, editReq, db = pool) => {
      // Map daybook form fields → farmer_payments columns
      const current = await farmerPaymentModel.findById(parseInt(id), db);
      const fpUpdate = {};
      if (data.date !== undefined) fpUpdate.date = data.date;
      if (data.payment_mode !== undefined) fpUpdate.particular = data.payment_mode; // daybook payment_mode → fp particular
      if (data.particular !== undefined && !data.payment_mode) fpUpdate.particular = data.particular;
      if ([data.payment_mode, data.debit, data.cash_amount, data.bank_amount].some((value) => value !== undefined)) {
        const requestedMode = data.payment_mode !== undefined ? data.payment_mode : current?.payment_mode;
        const nextAmount = data.debit !== undefined ? (parseFloat(data.debit) || 0) : (parseFloat(current?.amount) || 0);
        let nextCash = data.cash_amount !== undefined ? data.cash_amount : current?.cash_amount;
        let nextBank = data.bank_amount !== undefined ? data.bank_amount : current?.bank_amount;
        if (String(requestedMode || '').trim().toUpperCase() === 'SPLIT'
            && data.debit !== undefined && data.cash_amount === undefined && data.bank_amount === undefined) {
          const oldCash = Math.max(parseFloat(current?.cash_amount) || 0, 0);
          const oldBank = Math.max(parseFloat(current?.bank_amount) || 0, 0);
          const oldParts = oldCash + oldBank;
          nextCash = oldParts > 0 ? nextAmount * oldCash / oldParts : 0;
          nextBank = nextAmount - nextCash;
        }
        const allocation = normalizeFarmerAllocation({
          paymentMode: requestedMode,
          totalAmount: nextAmount,
          cashAmount: nextCash,
          bankAmount: nextBank,
        });
        fpUpdate.payment_mode = allocation.mode;
        fpUpdate.amount = allocation.total;
        fpUpdate.cash_amount = allocation.cash;
        fpUpdate.bank_amount = allocation.bank;
        fpUpdate.cheque_status = resolveChequeStatus({
          currentMode: current?.payment_mode,
          currentStatus: current?.cheque_status,
          nextMode: allocation.mode,
        });
        fpUpdate.cheque_no = allocation.mode === 'CHEQUE'
          ? (data.cheque_no !== undefined ? data.cheque_no || null : current?.cheque_no || null)
          : null;
      } else if (data.cheque_no !== undefined) {
        fpUpdate.cheque_no = classifyPaymentMode(current?.payment_mode) === 'cheque'
          ? data.cheque_no || null
          : null;
      }
      if (data.payment_mode !== undefined || data.bank_account_id !== undefined) {
        const { rows } = await db.query(
          `SELECT f.site_id FROM farmer_payments fp JOIN farmers f ON f.id=fp.farmer_id WHERE fp.id=$1 LIMIT 1`,
          [parseInt(id)],
        );
        fpUpdate.bank_account_id = await resolveBankAccountSelection({
          siteId: rows[0]?.site_id,
          paymentMode: fpUpdate.payment_mode || current?.payment_mode,
          bankAccountId: data.bank_account_id !== undefined ? data.bank_account_id : current?.bank_account_id,
          db,
        });
      }
      if (data.by_note !== undefined) fpUpdate.by_note = data.by_note;
      if (data.farmer_id !== undefined) fpUpdate.farmer_id = data.farmer_id;
      if (data.interest_rate !== undefined) fpUpdate.interest_rate = parseFloat(data.interest_rate) || 0;
      if (data.interest_amount !== undefined) fpUpdate.interest_amount = parseFloat(data.interest_amount) || 0;
      if (data.remarks !== undefined) fpUpdate.remarks = data.remarks;

      if (Object.keys(fpUpdate).length > 0) {
        await farmerPaymentModel.update(parseInt(id), fpUpdate, db);
      }

      // Sync linked daybook entry
      const linkedDb = await db.query('SELECT id FROM day_book WHERE farmer_payment_id = $1', [parseInt(id)]);
      if (linkedDb.rows.length > 0) {
        const dbUpdate = {};
        for (const key of ['date', 'particular', 'entry_type', 'debit', 'credit', 'remarks', 'payment_mode', 'category', 'from_entity', 'to_entity', 'account_no', 'branch']) {
          if (data[key] !== undefined) dbUpdate[key] = data[key];
        }
        if (fpUpdate.cheque_no !== undefined) dbUpdate.cheque_no = fpUpdate.cheque_no;
        if (fpUpdate.cheque_status !== undefined) dbUpdate.cheque_status = fpUpdate.cheque_status;
        if (fpUpdate.bank_account_id !== undefined) dbUpdate.bank_account_id = fpUpdate.bank_account_id;
        if (Object.keys(dbUpdate).length > 0) {
          await dayBookModel.update(linkedDb.rows[0].id, dbUpdate, db);
        }
      }
    },
  },
  daybook_commission: {
    model: plotCommissionModel,
    fetchOriginal: async (id, db = pool) => plotCommissionModel.findById(parseInt(id), db),
    applyUpdate: async (id, data, editReq, db = pool) => {
      // Map daybook form fields → plot_commissions columns
      const current = await plotCommissionModel.findById(parseInt(id), db);
      const pcUpdate = {};
      if (data.date !== undefined) pcUpdate.date = data.date;
      if (data.particular !== undefined) pcUpdate.particular = data.particular;
      if (data.father_name !== undefined) pcUpdate.father_name = data.father_name;
      if (data.plot_no !== undefined) pcUpdate.plot_no = data.plot_no;
      if (data.plot_size !== undefined) pcUpdate.plot_size = data.plot_size;
      if (data.plot_rate !== undefined) pcUpdate.plot_rate = data.plot_rate;
      if (data.debit !== undefined) pcUpdate.amount = parseFloat(data.debit) || 0;
      if (data.by_note !== undefined) pcUpdate.by_note = data.by_note;
      if (data.remarks !== undefined) pcUpdate.remarks = data.remarks;
      if (data.payment_mode !== undefined) {
        pcUpdate.payment_mode = data.payment_mode ? String(data.payment_mode).trim().toUpperCase() : 'BANK';
        pcUpdate.cheque_status = resolveChequeStatus({
          currentMode: current?.payment_mode,
          currentStatus: current?.cheque_status,
          nextMode: pcUpdate.payment_mode,
        });
        pcUpdate.cheque_no = classifyPaymentMode(pcUpdate.payment_mode) === 'cheque'
          ? (data.cheque_no !== undefined ? data.cheque_no || null : current?.cheque_no || null)
          : null;
      } else if (data.cheque_no !== undefined) {
        pcUpdate.cheque_no = classifyPaymentMode(current?.payment_mode) === 'cheque'
          ? data.cheque_no || null
          : null;
      }
      if (data.payment_mode !== undefined || data.bank_account_id !== undefined) {
        pcUpdate.bank_account_id = await resolveBankAccountSelection({
          siteId: current?.site_id,
          paymentMode: pcUpdate.payment_mode || current?.payment_mode,
          bankAccountId: data.bank_account_id !== undefined ? data.bank_account_id : current?.bank_account_id,
          db,
        });
      }

      if (Object.keys(pcUpdate).length > 0) {
        await plotCommissionModel.update(parseInt(id), pcUpdate, db);
      }

      // Sync linked daybook entry
      const linkedDb = await db.query('SELECT id FROM day_book WHERE commission_id = $1', [parseInt(id)]);
      if (linkedDb.rows.length > 0) {
        const dbUpdate = {};
        for (const key of ['date', 'particular', 'entry_type', 'debit', 'credit', 'remarks', 'payment_mode', 'category', 'from_entity', 'to_entity', 'account_no', 'branch']) {
          if (data[key] !== undefined) dbUpdate[key] = data[key];
        }
        if (pcUpdate.cheque_no !== undefined) dbUpdate.cheque_no = pcUpdate.cheque_no;
        if (pcUpdate.cheque_status !== undefined) dbUpdate.cheque_status = pcUpdate.cheque_status;
        if (pcUpdate.bank_account_id !== undefined) dbUpdate.bank_account_id = pcUpdate.bank_account_id;
        if (Object.keys(dbUpdate).length > 0) {
          await dayBookModel.update(linkedDb.rows[0].id, dbUpdate, db);
        }
      }
    },
  },
  daybook_cashflow: {
    model: cashFlowEntryModel,
    fetchOriginal: async (id, db = pool) => cashFlowEntryModel.findById(parseInt(id), db),
    applyUpdate: async (id, data, editReq, db = pool) => {
      // Map daybook form fields → cash_flow_entries columns
      const current = await cashFlowEntryModel.findById(parseInt(id), db);
      const cfUpdate = {};
      if (data.date !== undefined) cfUpdate.date = data.date;
      if (data.particular !== undefined) cfUpdate.particular = data.particular;
      if (data.debit !== undefined) cfUpdate.debit = parseFloat(data.debit) || 0;
      if (data.credit !== undefined) cfUpdate.credit = parseFloat(data.credit) || 0;
      if (data.remarks !== undefined) cfUpdate.remarks = data.remarks;
      if (data.payment_mode !== undefined) {
        cfUpdate.cash_type = normalizeCashType(data.payment_mode);
        cfUpdate.cheque_status = resolveChequeStatus({
          currentMode: current?.cash_type,
          currentStatus: current?.cheque_status,
          nextMode: cfUpdate.cash_type,
        });
        cfUpdate.cheque_no = cfUpdate.cash_type === 'cheque'
          ? (data.cheque_no !== undefined ? data.cheque_no || null : current?.cheque_no || null)
          : null;
      } else if (data.cheque_no !== undefined) {
        cfUpdate.cheque_no = classifyPaymentMode(current?.cash_type) === 'cheque'
          ? data.cheque_no || null
          : null;
      }
      if (data.payment_mode !== undefined || data.bank_account_id !== undefined) {
        cfUpdate.bank_account_id = await resolveBankAccountSelection({
          siteId: current?.site_id,
          paymentMode: cfUpdate.cash_type || current?.cash_type || current?.payment_mode,
          bankAccountId: data.bank_account_id !== undefined ? data.bank_account_id : current?.bank_account_id,
          db,
        });
      }

      if (Object.keys(cfUpdate).length > 0) {
        await cashFlowEntryModel.update(parseInt(id), cfUpdate, db);
      }

      // Sync linked daybook entry
      const linkedDb = await db.query('SELECT id FROM day_book WHERE cash_flow_entry_id = $1', [parseInt(id)]);
      if (linkedDb.rows.length > 0) {
        const dbUpdate = {};
        for (const key of ['date', 'particular', 'entry_type', 'debit', 'credit', 'remarks', 'payment_mode', 'category', 'from_entity', 'to_entity', 'account_no', 'branch']) {
          if (data[key] !== undefined) dbUpdate[key] = data[key];
        }
        if (cfUpdate.cheque_no !== undefined) dbUpdate.cheque_no = cfUpdate.cheque_no;
        if (cfUpdate.cheque_status !== undefined) dbUpdate.cheque_status = cfUpdate.cheque_status;
        if (cfUpdate.bank_account_id !== undefined) dbUpdate.bank_account_id = cfUpdate.bank_account_id;
        if (Object.keys(dbUpdate).length > 0) {
          await dayBookModel.update(linkedDb.rows[0].id, dbUpdate, db);
        }
      }
    },
  },
  daybook_firm_transaction: {
    model: firmTransactionModel,
    fetchOriginal: async (id, db = pool) => firmTransactionModel.findById(parseInt(id), db),
    applyUpdate: async (id, data, editReq, db = pool) => {
      // Map daybook form fields → firm_transactions columns
      const current = await firmTransactionModel.findById(parseInt(id), db);
      const ftUpdate = {};
      if (data.date !== undefined) ftUpdate.date = data.date;
      if (data.particular !== undefined) ftUpdate.description = data.particular; // daybook particular → ft description
      if (data.debit !== undefined) ftUpdate.debit = parseFloat(data.debit) || 0;
      if (data.credit !== undefined) ftUpdate.credit = parseFloat(data.credit) || 0;
      if (data.firm_name !== undefined) ftUpdate.name = data.firm_name;
      if (data.firm_purpose !== undefined) ftUpdate.purpose = data.firm_purpose;
      if (data.firm_remark !== undefined) ftUpdate.remark = data.firm_remark;
      if (data.payment_mode !== undefined) {
        ftUpdate.payment_mode = normalizeCashType(data.payment_mode);
        ftUpdate.cheque_status = resolveChequeStatus({
          currentMode: current?.payment_mode,
          currentStatus: current?.cheque_status,
          nextMode: ftUpdate.payment_mode,
        });
        ftUpdate.cheque_no = ftUpdate.payment_mode === 'cheque'
          ? (data.firm_cheque_no !== undefined ? data.firm_cheque_no || null : current?.cheque_no || null)
          : null;
      } else if (data.firm_cheque_no !== undefined) {
        ftUpdate.cheque_no = classifyPaymentMode(current?.payment_mode) === 'cheque'
          ? data.firm_cheque_no || null
          : null;
      }
      if (data.payment_mode !== undefined || data.bank_account_id !== undefined) {
        ftUpdate.bank_account_id = await resolveBankAccountSelection({
          siteId: current?.site_id,
          paymentMode: ftUpdate.payment_mode || current?.payment_mode,
          bankAccountId: data.bank_account_id !== undefined ? data.bank_account_id : current?.bank_account_id,
          db,
        });
      }

      if (Object.keys(ftUpdate).length > 0) {
        await firmTransactionModel.update(parseInt(id), ftUpdate, db);
      }

      // Sync linked daybook entry
      const linkedDb = await db.query('SELECT id FROM day_book WHERE firm_transaction_id = $1', [parseInt(id)]);
      if (linkedDb.rows.length > 0) {
        const dbUpdate = {};
        for (const key of ['date', 'particular', 'entry_type', 'debit', 'credit', 'remarks', 'payment_mode', 'category', 'from_entity', 'to_entity', 'account_no', 'branch']) {
          if (data[key] !== undefined) dbUpdate[key] = data[key];
        }
        if (ftUpdate.cheque_no !== undefined) dbUpdate.cheque_no = ftUpdate.cheque_no;
        if (ftUpdate.cheque_status !== undefined) dbUpdate.cheque_status = ftUpdate.cheque_status;
        if (ftUpdate.bank_account_id !== undefined) dbUpdate.bank_account_id = ftUpdate.bank_account_id;
        if (Object.keys(dbUpdate).length > 0) {
          await dayBookModel.update(linkedDb.rows[0].id, dbUpdate, db);
        }
      }
    },
  },
  daybook_plot_payment: {
    model: plotPaymentModel,
    fetchOriginal: async (id, db = pool) => plotPaymentModel.findById(parseInt(id), db),
    applyUpdate: async (id, data, editReq, db = pool) => {
      // Map daybook form fields → plot_payments columns
      const current = await plotPaymentModel.findById(parseInt(id), db);
      const ppUpdate = {};
      if (data.date !== undefined) ppUpdate.date = data.date;
      if (data.pp_payment_from !== undefined) ppUpdate.payment_from = data.pp_payment_from;
      if (data.pp_payment_type !== undefined) {
        ppUpdate.payment_type = canonicalPaymentMode(data.pp_payment_type);
        ppUpdate.cheque_status = resolveChequeStatus({
          currentMode: current?.payment_type,
          currentStatus: current?.cheque_status,
          nextMode: ppUpdate.payment_type,
        });
        ppUpdate.cheque_no = ppUpdate.payment_type === 'CHEQUE'
          ? (data.pp_cheque_no !== undefined ? data.pp_cheque_no || null : current?.cheque_no || null)
          : null;
      }
      if (data.pp_bank_details !== undefined) ppUpdate.bank_details = data.pp_bank_details;
      if (data.pp_narration !== undefined) ppUpdate.narration = data.pp_narration;
      if (data.pp_received_by !== undefined) ppUpdate.received_by = data.pp_received_by;
      if (data.pp_payment_type === undefined && data.pp_cheque_no !== undefined) {
        ppUpdate.cheque_no = classifyPaymentMode(current?.payment_type) === 'cheque'
          ? data.pp_cheque_no || null
          : null;
      }
      if (data.pp_payment_type !== undefined || data.bank_account_id !== undefined) {
        ppUpdate.bank_account_id = await resolveBankAccountSelection({
          siteId: current?.site_id,
          paymentMode: ppUpdate.payment_type || current?.payment_type,
          bankAccountId: data.bank_account_id !== undefined ? data.bank_account_id : current?.bank_account_id,
          db,
        });
      }
      // For plot payments, the amount comes from credit (received) or debit (refund)
      if (data.credit !== undefined && parseFloat(data.credit) > 0) ppUpdate.amount = parseFloat(data.credit);
      else if (data.debit !== undefined && parseFloat(data.debit) > 0) ppUpdate.amount = -(parseFloat(data.debit));

      if (Object.keys(ppUpdate).length > 0) {
        await plotPaymentModel.update(parseInt(id), ppUpdate, db);
      }

      // Sync linked daybook entry
      const linkedDb = await db.query('SELECT id FROM day_book WHERE plot_payment_id = $1', [parseInt(id)]);
      if (linkedDb.rows.length > 0) {
        const dbUpdate = {};
        for (const key of ['date', 'particular', 'entry_type', 'debit', 'credit', 'remarks', 'payment_mode', 'category', 'from_entity', 'to_entity', 'account_no', 'branch']) {
          if (data[key] !== undefined) dbUpdate[key] = data[key];
        }
        if (ppUpdate.payment_type !== undefined) dbUpdate.payment_mode = ppUpdate.payment_type;
        if (ppUpdate.cheque_no !== undefined) dbUpdate.cheque_no = ppUpdate.cheque_no;
        if (ppUpdate.cheque_status !== undefined) dbUpdate.cheque_status = ppUpdate.cheque_status;
        if (ppUpdate.bank_account_id !== undefined) dbUpdate.bank_account_id = ppUpdate.bank_account_id;
        if (Object.keys(dbUpdate).length > 0) {
          await dayBookModel.update(linkedDb.rows[0].id, dbUpdate, db);
        }
      }
    },
  },
};

const EDIT_REQUEST_PERMISSION_MODULE = Object.freeze({
  plot_registry_create: 'plot_registry',
  farmer: 'farmers',
  farmer_payment: 'farmers',
  plot: 'plot_payments',
  plot_payment: 'plot_payments',
  daybook: 'daybook',
  daybook_expense: 'daybook',
  daybook_farmer_payment: 'daybook',
  daybook_commission: 'daybook',
  daybook_cashflow: 'daybook',
  daybook_firm_transaction: 'daybook',
  daybook_plot_payment: 'daybook',
});

const parsePositiveId = (value) => {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const requiresCreatePermission = (requestModule) => requestModule === 'plot_registry_create';

const hasRequiredRequestPermission = (permission, requestModule) => (
  permission?.can_read === true
  && (!requiresCreatePermission(requestModule) || permission?.can_write === true)
);

const permissionRequirementMessage = (permissionModule, requestModule) => (
  requiresCreatePermission(requestModule)
    ? `Read and create access to ${permissionModule.replaceAll('_', ' ')} is required`
    : `Read access to ${permissionModule.replaceAll('_', ' ')} is required`
);

const rejectCreateRequest = (res, status, message) => res.status(status).json({ message });

const cleanupLocalUpload = async (filePath) => {
  if (!filePath) return;
  try {
    await fs.rm(filePath, { force: true });
  } catch (error) {
    // Cleanup must never hide the API result, but an unexpected filesystem
    // failure is still operationally useful.
    console.error('Edit request local upload cleanup failed:', error.message);
  }
};

const cleanupCloudUpload = async (asset) => {
  if (!asset?.publicId) return;
  try {
    await deleteCloudinaryAsset(asset);
  } catch (error) {
    // Keep the original database/application error as the response cause.
    console.error('Edit request Cloudinary rollback failed:', error.message);
  }
};

class EditRequestWorkflowError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const workflowError = (status, message) => new EditRequestWorkflowError(status, message);

const PROPOSED_DESTINATION_RULES = Object.freeze({
  plot_registry_create: { fields: ['plot_id'], table: 'plots', label: 'plot' },
  plot_payment: { fields: ['plot_id'], table: 'plots', label: 'plot' },
  daybook_plot_payment: { fields: ['plot_id', 'pp_plot_id'], table: 'plots', label: 'plot' },
  farmer_payment: { fields: ['farmer_id'], table: 'farmers', label: 'farmer' },
  daybook_farmer_payment: { fields: ['farmer_id'], table: 'farmers', label: 'farmer' },
});

/** Ensure proposed identifiers/status cannot bypass site or registry workflow. */
const validateProposedDestinationSite = async ({
  module,
  proposedData,
  siteId,
  recordId,
  currentRecord,
  db = pool,
}) => {
  if (proposedData?.site_id !== undefined) {
    const proposedSiteId = parsePositiveId(proposedData.site_id);
    if (!proposedSiteId || proposedSiteId !== parsePositiveId(siteId)) {
      return 'Proposed data cannot move the record to another site';
    }
  }

  if (proposedData?.registry_id !== undefined) {
    const registryId = parsePositiveId(proposedData.registry_id);
    if (!registryId) return 'A valid registry is required';
    const { rows } = await db.query(
      'SELECT site_id FROM plot_registries WHERE id = $1 LIMIT 1 FOR SHARE',
      [registryId]
    );
    if (!rows[0]) return 'Selected registry was not found';
    if (parsePositiveId(rows[0].site_id) !== parsePositiveId(siteId)) {
      return 'Selected registry does not belong to the request site';
    }
  }

  if (module === 'plot' && proposedData?.status !== undefined) {
    const currentStatus = String(currentRecord?.status || '').trim().toUpperCase();
    const nextStatus = String(proposedData.status || '').trim().toUpperCase();
    if (nextStatus !== currentStatus && (nextStatus === 'REGISTRY' || currentStatus === 'REGISTRY')) {
      return 'Registry status can only be changed through the Plot Registry NOC workflow';
    }
  }

  if (
    module === 'plot_registry_create'
    && parsePositiveId(proposedData?.plot_id) !== parsePositiveId(recordId)
  ) {
    return 'The registry request must remain bound to its original plot';
  }

  const rule = PROPOSED_DESTINATION_RULES[module];
  if (!rule) return null;

  const fields = rule.fields.filter((key) => proposedData?.[key] !== undefined);
  for (const field of fields) {
    const destinationId = parsePositiveId(proposedData[field]);
    if (!destinationId) return `A valid ${rule.label} is required`;

    const { rows } = await db.query(
      `SELECT site_id FROM ${rule.table} WHERE id = $1 LIMIT 1 FOR SHARE`,
      [destinationId]
    );
    if (!rows[0]) return `Selected ${rule.label} was not found`;
    if (parsePositiveId(rows[0].site_id) !== parsePositiveId(siteId)) {
      return `Selected ${rule.label} does not belong to the request site`;
    }
  }
  return null;
};

const resolveRecordSiteId = async (module, record, db = pool) => {
  if (module === 'farmer_payment' || module === 'daybook_farmer_payment') {
    const { rows } = await db.query(
      `SELECT f.site_id
         FROM farmer_payments fp
         JOIN farmers f ON f.id = fp.farmer_id
        WHERE fp.id = $1
        LIMIT 1
        FOR SHARE OF fp, f`,
      [record.id]
    );
    return parsePositiveId(rows[0]?.site_id);
  }

  return parsePositiveId(record?.site_id);
};

// ══════════════════════════════════════════════════
//  CREATE EDIT REQUEST (sub-admin)
// ══════════════════════════════════════════════════

/**
 * POST /edit-requests
 * Sub-admin submits an edit request with proof photo
 */
export const createEditRequest = asyncHandler(async (req, res) => {
  let proofAsset = null;
  let persisted = false;

  try {
    const { module, record_id, proposed_data, site_id } = req.body;

    if (!module || !record_id) {
      return rejectCreateRequest(res, 400, 'Module and record_id are required');
    }

    if (!MODULE_MAP[module]) {
      return rejectCreateRequest(res, 400, `Invalid module: ${module}`);
    }

    const recordId = parsePositiveId(record_id);
    if (!recordId) {
      return rejectCreateRequest(res, 400, 'A valid record_id is required');
    }

    const handler = MODULE_MAP[module];
    const permissionModule = EDIT_REQUEST_PERMISSION_MODULE[module];
    if (req.user.role === 'sub_admin') {
      const permission = await permissionModel.getPermission(req.user.id, permissionModule);
      if (!hasRequiredRequestPermission(permission, module)) {
        return rejectCreateRequest(
          res,
          403,
          permissionRequirementMessage(permissionModule, module)
        );
      }
    }

    // Parse proposed_data if it's a string.
    let parsedProposed = proposed_data;
    if (typeof proposed_data === 'string') {
      try {
        parsedProposed = JSON.parse(proposed_data);
      } catch {
        return rejectCreateRequest(res, 400, 'Invalid proposed_data JSON');
      }
    }
    if (!parsedProposed || typeof parsedProposed !== 'object' || Array.isArray(parsedProposed)) {
      return rejectCreateRequest(res, 400, 'proposed_data must be an object');
    }

    // Resolve the real record before accepting the caller-supplied site. The
    // record's site is authoritative and prevents cross-site queue injection.
    const originalRecord = await handler.fetchOriginal(recordId);
    if (!originalRecord) {
      return rejectCreateRequest(res, 404, 'Record not found');
    }
    const recordSiteId = await resolveRecordSiteId(module, originalRecord);
    if (!recordSiteId) {
      return rejectCreateRequest(res, 409, 'The record is not linked to a valid site');
    }

    if (req.user.role === 'sub_admin') {
      const { rows } = await pool.query(
        'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
        [req.user.id, recordSiteId]
      );
      // Use a 404 so callers cannot probe whether another site's record exists.
      if (!rows[0]) return rejectCreateRequest(res, 404, 'Record not found');
    }

    if (site_id !== undefined && site_id !== null && site_id !== '') {
      const requestedSiteId = parsePositiveId(site_id);
      if (!requestedSiteId || requestedSiteId !== recordSiteId) {
        return rejectCreateRequest(res, 400, 'The request site does not match the record site');
      }
    }

    const destinationError = await validateProposedDestinationSite({
      module,
      proposedData: parsedProposed,
      siteId: recordSiteId,
      recordId,
      currentRecord: originalRecord,
    });
    if (destinationError) return rejectCreateRequest(res, 400, destinationError);

    const existing = await editRequestModel.findPendingForRecord(module, recordId, pool);
    if (existing) {
      return rejectCreateRequest(res, 409, 'There is already a pending edit request for this record');
    }

    // Module-specific up-front validation (create-type requests) — don't park
    // requests in the admin queue that approval is guaranteed to reject.
    if (handler.validateCreate) {
      const invalid = await handler.validateCreate(parsedProposed, req.user, recordId, recordSiteId);
      if (invalid) return rejectCreateRequest(res, 400, invalid);
    }

    // Upload only after every deterministic validation. Retain publicId until
    // persistence succeeds so a failed INSERT can compensate the cloud upload.
    if (req.file) proofAsset = await uploadCloudinaryAsset(req.file.path, 'edit-proofs');

    const editRequest = await editRequestModel.create({
      requested_by: req.user.id,
      site_id: recordSiteId,
      module,
      record_id: recordId,
      original_data: JSON.stringify(originalRecord),
      proposed_data: JSON.stringify(parsedProposed),
      proof_photo_url: proofAsset?.url || null,
      status: 'pending',
    }, pool);
    persisted = true;

    return res.status(201).json({ editRequest, message: 'Edit request submitted for admin approval' });
  } catch (error) {
    if (proofAsset && !persisted) await cleanupCloudUpload(proofAsset);
    throw error;
  } finally {
    await cleanupLocalUpload(req.file?.path);
  }
});

// ══════════════════════════════════════════════════
//  LIST EDIT REQUESTS (admin or requester)
// ══════════════════════════════════════════════════

/**
 * GET /edit-requests?status=pending&site_id=X
 */
export const listEditRequests = asyncHandler(async (req, res) => {
  const { status, site_id } = req.query;

  let requests;
  if (status) {
    requests = await editRequestModel.findByStatus(status, pool, site_id || null);
  } else {
    requests = await editRequestModel.findPending(pool, site_id || null);
  }

  res.json({ requests });
});

/**
 * GET /edit-requests/my-requests
 * Sub-admin views their own requests
 */
export const listMyEditRequests = asyncHandler(async (req, res) => {
  let requests = await editRequestModel.findByRequester(req.user.id, pool);
  const requestedSiteId = req.query.site_id ? parsePositiveId(req.query.site_id) : null;
  if (req.query.site_id && !requestedSiteId) {
    return res.status(400).json({ message: 'A valid site_id is required' });
  }

  if (req.user.role === 'sub_admin') {
    const [siteResult, permissions] = await Promise.all([
      pool.query('SELECT site_id FROM user_sites WHERE user_id = $1', [req.user.id]),
      permissionModel.getByUserId(req.user.id),
    ]);
    const siteIds = new Set(siteResult.rows.map((row) => parsePositiveId(row.site_id)).filter(Boolean));
    const permissionsByModule = new Map(
      permissions.map((permission) => [permission.module, permission])
    );

    requests = requests.filter((request) => {
      let original = request.original_data;
      if (typeof original === 'string') {
        try { original = JSON.parse(original); } catch { original = {}; }
      }
      const requestSiteId = parsePositiveId(request.site_id) || parsePositiveId(original?.site_id);
      const permissionModule = EDIT_REQUEST_PERMISSION_MODULE[request.module];
      const permission = permissionsByModule.get(permissionModule);
      return requestSiteId
        && siteIds.has(requestSiteId)
        && hasRequiredRequestPermission(permission, request.module)
        && (!requestedSiteId || requestSiteId === requestedSiteId);
    });
  } else if (requestedSiteId) {
    requests = requests.filter((request) => parsePositiveId(request.site_id) === requestedSiteId);
  }

  res.json({ requests });
});

/**
 * GET /edit-requests/counts?site_id=X
 * Get status counts for badge display
 */
export const getEditRequestCounts = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  const counts = await editRequestModel.getStatusCounts(pool, site_id || null);
  res.json(counts);
});

// ══════════════════════════════════════════════════
//  APPROVE EDIT REQUEST (admin)
// ══════════════════════════════════════════════════

/**
 * PUT /edit-requests/:id/approve
 * Admin approves an edit request — applies the proposed changes
 */
export const approveEditRequest = asyncHandler(async (req, res) => {
  const requestId = parsePositiveId(req.params.id);
  let client = null;
  let transactionStarted = false;
  let reviewAsset = null;
  let committed = false;

  try {
    if (!requestId) throw workflowError(400, 'A valid edit request id is required');

    client = await pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    // The row lock serializes approve/approve and approve/reject. Every target
    // model below also receives this client, so the mutation and state change
    // share one commit boundary.
    const editReq = await editRequestModel.findByIdForUpdate(requestId, client);
    if (!editReq) throw workflowError(404, 'Edit request not found');
    if (editReq.status !== 'pending') {
      throw workflowError(409, `Edit request is already ${editReq.status}`);
    }

    const handler = MODULE_MAP[editReq.module];
    if (!handler) throw workflowError(400, `Unknown module: ${editReq.module}`);

    // Re-check the authoritative record, site assignment, and module access at
    // approval time. This handles legacy requests and later access revocations.
    const { rows: currentRows } = await client.query(
      `SELECT * FROM ${handler.model.tableName} WHERE id = $1 FOR UPDATE`,
      [parsePositiveId(editReq.record_id)]
    );
    const currentRecord = currentRows[0];
    if (!currentRecord) throw workflowError(409, 'The target record no longer exists');

    const currentSiteId = await resolveRecordSiteId(editReq.module, currentRecord, client);
    if (!currentSiteId || currentSiteId !== parsePositiveId(editReq.site_id)) {
      throw workflowError(409, 'The target record no longer matches the request site');
    }

    const { rows: requesterRows } = await client.query(
      'SELECT id, role, is_active FROM users WHERE id = $1 LIMIT 1 FOR SHARE',
      [editReq.requested_by]
    );
    const requester = requesterRows[0];
    if (!requester || requester.is_active === false) {
      throw workflowError(409, 'The requester account is no longer active');
    }

    if (requester.role === 'sub_admin') {
      const { rows: siteRows } = await client.query(
        'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1 FOR SHARE',
        [requester.id, currentSiteId]
      );
      const { rows: permissionRows } = await client.query(
        `SELECT can_read, can_write
          FROM user_permissions
          WHERE user_id = $1 AND module = $2
          LIMIT 1
          FOR SHARE`,
        [requester.id, EDIT_REQUEST_PERMISSION_MODULE[editReq.module]]
      );
      if (!siteRows[0] || !hasRequiredRequestPermission(permissionRows[0], editReq.module)) {
        throw workflowError(409, 'The requester no longer has access to this module and site');
      }
    } else if (requester.role !== 'admin' && requester.role !== 'super_admin') {
      throw workflowError(409, 'The requester role is no longer eligible');
    }

    let proposedData = editReq.proposed_data;
    if (typeof proposedData === 'string') {
      try {
        proposedData = JSON.parse(proposedData);
      } catch {
        throw workflowError(409, 'The stored proposed data is invalid');
      }
    }
    if (!proposedData || typeof proposedData !== 'object' || Array.isArray(proposedData)) {
      throw workflowError(409, 'The stored proposed data is invalid');
    }
    proposedData = { ...proposedData };

    // Remove immutable bookkeeping fields even from legacy requests.
    delete proposedData.id;
    delete proposedData.created_at;
    delete proposedData.updated_at;
    delete proposedData.created_by;

    const destinationError = await validateProposedDestinationSite({
      module: editReq.module,
      proposedData,
      siteId: currentSiteId,
      recordId: editReq.record_id,
      currentRecord,
      db: client,
    });
    if (destinationError) throw workflowError(409, destinationError);

    // Upload after all validation while the request row is locked. If any
    // database step fails, the transaction rolls back and the asset is removed.
    if (req.file) {
      reviewAsset = await uploadCloudinaryAsset(req.file.path, 'edit-review-proofs');
    }

    let applied;
    try {
      applied = await handler.applyUpdate(editReq.record_id, proposedData, editReq, client);
    } catch (error) {
      throw workflowError(400, `Could not apply this request: ${error.message}`);
    }

    const now = new Date().toISOString();
    const updatePayload = {
      status: 'approved',
      reviewed_by: req.user.id,
      reviewed_at: now,
      updated_at: now,
    };
    if (reviewAsset) updatePayload.review_photo_url = reviewAsset.url;

    const updated = await editRequestModel.transitionPending(requestId, updatePayload, client);
    if (!updated) throw workflowError(409, 'Edit request is no longer pending');

    await client.query('COMMIT');
    transactionStarted = false;
    committed = true;

    let message = 'Edit request approved and changes applied';
    if (applied?.payments_skipped > 0) {
      message += ` — note: ${applied.payments_skipped} linked payment(s) were no longer available and were skipped`;
    }
    return res.json({ editRequest: updated, applied: applied ?? null, message });
  } catch (error) {
    if (transactionStarted && client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Edit request approval rollback failed:', rollbackError.message);
      }
    }
    if (reviewAsset && !committed) await cleanupCloudUpload(reviewAsset);

    if (error instanceof EditRequestWorkflowError) {
      return res.status(error.status).json({ message: error.message });
    }
    throw error;
  } finally {
    if (client) client.release();
    await cleanupLocalUpload(req.file?.path);
  }
});

// ══════════════════════════════════════════════════
//  REJECT EDIT REQUEST (admin)
// ══════════════════════════════════════════════════

/**
 * PUT /edit-requests/:id/reject
 * Admin rejects an edit request
 */
export const rejectEditRequest = asyncHandler(async (req, res) => {
  const requestId = parsePositiveId(req.params.id);
  const { rejection_reason } = req.body;

  if (!requestId) return res.status(400).json({ message: 'A valid edit request id is required' });

  const updated = await editRequestModel.transitionPending(requestId, {
    status: 'rejected',
    reviewed_by: req.user.id,
    reviewed_at: new Date().toISOString(),
    rejection_reason: rejection_reason || null,
    updated_at: new Date().toISOString(),
  }, pool);

  if (!updated) {
    const existing = await editRequestModel.findById(requestId, pool);
    if (!existing) return res.status(404).json({ message: 'Edit request not found' });
    return res.status(409).json({ message: `Edit request is already ${existing.status}` });
  }

  res.json({ editRequest: updated, message: 'Edit request rejected' });
});
