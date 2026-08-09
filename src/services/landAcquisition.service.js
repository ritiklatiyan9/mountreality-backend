const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MONEY = 999_999_999_999_999.99;

export const ACQUISITION_TYPES = Object.freeze([
  'DIRECT_PURCHASE', 'DEVELOPMENT_RIGHTS', 'JOINT_DEVELOPMENT',
  'COLLABORATION', 'LEASE', 'OTHER',
]);
export const ACQUISITION_LIFECYCLES = Object.freeze([
  'DRAFT', 'LAND_DETAILS', 'AGREEMENT_PENDING', 'AGREEMENT_COMPLETED',
  'FINANCIAL_TERMS_CONFIRMED', 'PAYMENT_IN_PROGRESS', 'FULLY_PAID', 'COMPLETED',
]);
export const AGREEMENT_STATUSES = Object.freeze([
  'NOT_STARTED', 'DRAFT', 'UNDER_REVIEW', 'EXECUTED', 'CANCELLED', 'SUPERSEDED',
]);
export const FINANCIAL_STATUSES = Object.freeze([
  'NOT_STARTED', 'PARTIALLY_PAID', 'FULLY_PAID', 'OVERDUE', 'ON_HOLD',
]);
export const AREA_UNITS = Object.freeze(['BIGHA', 'YARD', 'SQMT', 'ACRE', 'HECTARE']);
export const PAYMENT_MODES = Object.freeze(['CASH', 'BANK', 'CHEQUE', 'SPLIT']);

const cleanText = (value, max, { required = false } = {}) => {
  if (value === undefined) return undefined;
  const text = String(value ?? '').trim();
  if (!text) {
    if (required) throw new Error('A required value is missing');
    return null;
  }
  if (text.length > max) throw new Error(`Value exceeds the ${max} character limit`);
  return text;
};

const positiveId = (value, label, { nullable = true } = {}) => {
  if ((value === undefined || value === null || value === '') && nullable) return null;
  const id = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label} is invalid`);
  return id;
};

const numberValue = (value, label, {
  nullable = true, min = 0, max = Number.MAX_SAFE_INTEGER,
} = {}) => {
  if ((value === undefined || value === null || value === '') && nullable) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return number;
};

const dateValue = (value, label, { nullable = true } = {}) => {
  if ((value === undefined || value === null || value === '') && nullable) return null;
  const raw = String(value);
  if (!DATE_RE.test(raw)) throw new Error(`${label} must use YYYY-MM-DD`);
  const [year, month, day] = raw.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error(`${label} is not a valid date`);
  }
  return raw;
};

const enumValue = (value, allowed, label, fallback = null) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toUpperCase();
  if (!allowed.includes(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
};

const safeJsonList = (value, label, maxItems = 20) => {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : (() => {
    try { return JSON.parse(value); } catch { throw new Error(`${label} must be a list`); }
  })();
  if (!Array.isArray(list) || list.length > maxItems) throw new Error(`${label} must contain at most ${maxItems} items`);
  return list.map((item) => cleanText(item, 240, { required: true }));
};

export function normalizeAcquisitionInput(input = {}) {
  return {
    site_id: positiveId(input.site_id, 'Site', { nullable: false }),
    member_id: positiveId(input.member_id ?? input.landowner_member_id, 'Landowner', { nullable: false }),
    acquisition_type: enumValue(input.acquisition_type, ACQUISITION_TYPES, 'Acquisition type', 'DIRECT_PURCHASE'),
    rera_project_id: positiveId(input.rera_project_id ?? input.project_id, 'Project'),
    responsible_user_id: positiveId(input.responsible_user_id, 'Responsible employee'),
    notes: cleanText(input.notes, 4000),
  };
}

export function normalizeLandDetails(input = {}, { partial = false } = {}) {
  const result = {
    village: cleanText(input.village, 160),
    tehsil: cleanText(input.tehsil, 160),
    district: cleanText(input.district, 160),
    state: cleanText(input.state, 160),
    khasra_number: cleanText(input.khasra_number ?? input.khasra, 200),
    survey_number: cleanText(input.survey_number, 200),
    parcel_number: cleanText(input.parcel_number, 200),
    land_size_bigha: numberValue(input.land_area ?? input.land_size_bigha, 'Land area', { min: 0.0001, max: 1_000_000 }),
    land_size_unit: enumValue(input.area_unit ?? input.land_size_unit, AREA_UNITS, 'Area unit', partial ? undefined : 'BIGHA'),
    land_type: cleanText(input.land_type, 80),
    ownership_share: numberValue(input.ownership_share, 'Ownership share', { min: 0.0001, max: 100 }),
    land_notes: cleanText(input.land_notes ?? input.notes, 4000),
  };
  if (partial) {
    return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
  }
  if (!result.village) throw new Error('Village is required');
  if (!result.khasra_number && !result.survey_number && !result.parcel_number) {
    throw new Error('Khasra, survey or parcel number is required');
  }
  if (!result.land_size_bigha) throw new Error('Land area is required');
  return result;
}

export function normalizeAgreement(input = {}) {
  const agreement = {
    agreement_type: cleanText(input.agreement_type, 80, { required: true }),
    agreement_date: dateValue(input.agreement_date, 'Agreement date'),
    agreement_number: cleanText(input.agreement_number, 160),
    agreement_status: enumValue(input.agreement_status ?? input.status, AGREEMENT_STATUSES, 'Agreement status', 'DRAFT'),
    agreement_value: numberValue(input.agreement_value ?? input.value, 'Agreement value', { min: 0, max: MAX_MONEY }),
    witness_parties: safeJsonList(input.witness_parties, 'Witnesses and parties'),
    remarks: cleanText(input.remarks, 4000),
  };
  if (agreement.agreement_status === 'EXECUTED' && !agreement.agreement_date) {
    throw new Error('Agreement date is required when an agreement is executed');
  }
  return agreement;
}

export function normalizeFinancialTerms(input = {}) {
  const total = numberValue(input.total_agreed_value ?? input.total_amount, 'Total agreed value', {
    nullable: false, min: 0.01, max: MAX_MONEY,
  });
  const cash = numberValue(input.cash_component ?? input.cash_amount, 'Cash component', {
    nullable: false, min: 0, max: MAX_MONEY,
  });
  const bank = numberValue(input.bank_component ?? input.bank_amount, 'Bank component', {
    nullable: false, min: 0, max: MAX_MONEY,
  });
  const other = numberValue(input.other_component, 'Other component', { min: 0, max: MAX_MONEY }) ?? 0;
  if (Math.abs((cash + bank + other) - total) > 0.009) {
    throw new Error('Cash, bank and other components must equal the total agreed value');
  }
  if (other > 0) throw new Error('Other payment components are not supported by the current accounting engine');

  const rawSchedule = input.schedule ?? input.payment_schedule ?? [];
  if (!Array.isArray(rawSchedule) || rawSchedule.length > 100) {
    throw new Error('Payment schedule must contain at most 100 items');
  }
  const schedule = rawSchedule.map((item, index) => ({
    sequence_no: index + 1,
    description: cleanText(item.description, 240, { required: true }),
    due_date: dateValue(item.due_date, `Schedule item ${index + 1} due date`),
    expected_amount: numberValue(item.amount ?? item.expected_amount, `Schedule item ${index + 1} amount`, {
      nullable: false, min: 0.01, max: MAX_MONEY,
    }),
    preferred_mode: enumValue(item.preferred_mode ?? item.payment_mode, PAYMENT_MODES, 'Preferred payment mode'),
  }));
  const scheduledTotal = schedule.reduce((sum, item) => sum + item.expected_amount, 0);
  if (schedule.length && Math.abs(scheduledTotal - total) > 0.009) {
    throw new Error('Payment schedule total must equal the agreed value');
  }
  return {
    total_amount: total,
    cash_amount: cash,
    bank_amount: bank,
    payment_mode: cash > 0 && bank > 0 ? 'SPLIT' : cash > 0 ? 'CASH' : 'BANK',
    schedule,
    reason: cleanText(input.reason, 1000),
  };
}

export function deriveFinancialStatus({ totalAmount, totalPaid, hasOverdue = false, onHold = false }) {
  if (onHold) return 'ON_HOLD';
  const total = Number(totalAmount) || 0;
  const paid = Number(totalPaid) || 0;
  if (hasOverdue && paid < total) return 'OVERDUE';
  if (total > 0 && paid >= total - 0.009) return 'FULLY_PAID';
  if (paid > 0) return 'PARTIALLY_PAID';
  return 'NOT_STARTED';
}

export function deriveAcquisitionLifecycle(record = {}) {
  if (record.completed_at || String(record.lifecycle_status || '').toUpperCase() === 'COMPLETED') return 'COMPLETED';
  const total = Number(record.total_amount) || 0;
  const paid = Number(record.total_paid) || 0;
  if (record.financial_terms_status === 'CONFIRMED' && total > 0 && paid >= total - 0.009) return 'FULLY_PAID';
  if (paid > 0) return 'PAYMENT_IN_PROGRESS';
  if (record.financial_terms_status === 'CONFIRMED') return 'FINANCIAL_TERMS_CONFIRMED';
  if (String(record.agreement_status || '').toUpperCase() === 'EXECUTED') return 'AGREEMENT_COMPLETED';
  if (record.agreement_status && String(record.agreement_status).toUpperCase() !== 'NOT_STARTED') return 'AGREEMENT_PENDING';
  const hasLand = Boolean(
    record.village
    && (record.khasra_number || record.survey_number || record.parcel_number)
    && Number(record.land_size_bigha) > 0,
  );
  return hasLand ? 'LAND_DETAILS' : 'DRAFT';
}

export function acquisitionCompletionChecklist(record = {}, { requiredDocumentCount = 0 } = {}) {
  const total = Number(record.total_amount) || 0;
  const paid = Number(record.total_paid) || 0;
  const checks = [
    {
      key: 'land_details',
      label: 'Land details complete',
      complete: Boolean(record.village && (record.khasra_number || record.survey_number || record.parcel_number) && Number(record.land_size_bigha) > 0),
    },
    {
      key: 'agreement',
      label: 'Agreement executed',
      complete: String(record.agreement_status || '').toUpperCase() === 'EXECUTED',
    },
    {
      key: 'financial_terms',
      label: 'Financial terms confirmed',
      complete: record.financial_terms_status === 'CONFIRMED' && total > 0,
    },
    {
      key: 'payments',
      label: 'Payments complete',
      complete: total > 0 && paid >= total - 0.009,
    },
    {
      key: 'documents',
      label: requiredDocumentCount > 0
        ? `Required documents present (${requiredDocumentCount})`
        : 'Document requirements (none configured)',
      complete: requiredDocumentCount <= 0 || Number(record.document_count || 0) >= requiredDocumentCount,
    },
  ];
  return { checks, eligible: checks.every((check) => check.complete) };
}

export function makeAcquisitionReference(id, createdAt = new Date()) {
  const numericId = positiveId(id, 'Acquisition', { nullable: false });
  const year = new Date(createdAt).getUTCFullYear();
  if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new Error('Acquisition year is invalid');
  return `LA-${year}-${String(numericId).padStart(4, '0')}`;
}
