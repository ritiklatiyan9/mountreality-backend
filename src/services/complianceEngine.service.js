const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const COMPLIANCE_STATUSES = Object.freeze([
  'DRAFT', 'NOT_STARTED', 'IN_PROGRESS', 'AWAITING_DOCUMENTS',
  'AWAITING_EXTERNAL_AUTHORITY', 'UNDER_REVIEW', 'APPROVAL_PENDING',
  'SUBMITTED', 'COMPLETED', 'REJECTED', 'RETURNED_FOR_CORRECTION',
  'ON_HOLD', 'NOT_APPLICABLE', 'OVERDUE', 'CANCELLED',
]);

export const DEFAULT_TRANSITIONS = Object.freeze({
  DRAFT: ['NOT_STARTED', 'CANCELLED'],
  NOT_STARTED: ['IN_PROGRESS', 'ON_HOLD', 'NOT_APPLICABLE', 'CANCELLED'],
  IN_PROGRESS: ['AWAITING_DOCUMENTS', 'AWAITING_EXTERNAL_AUTHORITY', 'UNDER_REVIEW', 'APPROVAL_PENDING', 'SUBMITTED', 'ON_HOLD'],
  AWAITING_DOCUMENTS: ['IN_PROGRESS', 'SUBMITTED', 'ON_HOLD'],
  AWAITING_EXTERNAL_AUTHORITY: ['IN_PROGRESS', 'SUBMITTED', 'COMPLETED', 'ON_HOLD'],
  UNDER_REVIEW: ['APPROVAL_PENDING', 'SUBMITTED', 'RETURNED_FOR_CORRECTION', 'COMPLETED'],
  APPROVAL_PENDING: ['COMPLETED', 'REJECTED', 'RETURNED_FOR_CORRECTION'],
  SUBMITTED: ['UNDER_REVIEW', 'COMPLETED', 'REJECTED', 'RETURNED_FOR_CORRECTION'],
  REJECTED: ['IN_PROGRESS', 'CANCELLED'],
  RETURNED_FOR_CORRECTION: ['IN_PROGRESS', 'SUBMITTED'],
  ON_HOLD: ['IN_PROGRESS', 'CANCELLED'],
  OVERDUE: ['IN_PROGRESS', 'SUBMITTED', 'COMPLETED', 'ON_HOLD'],
  COMPLETED: [],
  NOT_APPLICABLE: [],
  CANCELLED: [],
});

const pad = (n) => String(n).padStart(2, '0');
export const dateKey = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

export const parseDate = (raw) => {
  if (!raw) return null;
  const value = raw instanceof Date ? dateKey(raw) : String(raw).slice(0, 10);
  if (!DATE_RE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || dateKey(parsed) !== value ? null : parsed;
};

const addDays = (date, days) => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + Number(days || 0));
  return next;
};

const endOfMonth = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
const endOfQuarter = (date) => {
  const endMonth = Math.floor(date.getUTCMonth() / 3) * 3 + 2;
  return new Date(Date.UTC(date.getUTCFullYear(), endMonth + 1, 0));
};
const endOfFinancialYear = (date) => {
  const year = date.getUTCMonth() >= 3 ? date.getUTCFullYear() + 1 : date.getUTCFullYear();
  return new Date(Date.UTC(year, 2, 31));
};

/** Calculate one due date from an administrator-defined rule. */
export function calculateDueDate(rule = {}, periodStart, eventDate = null) {
  const start = parseDate(periodStart);
  if (!start) throw new Error('A valid period start date is required');
  const type = String(rule.type || 'MANUAL').toUpperCase();
  const offset = Number.parseInt(rule.days || rule.offset_days, 10) || 0;

  if (type === 'MANUAL') return parseDate(rule.date) || start;
  if (type === 'FIXED_DAY_OF_MONTH') {
    const requested = Math.min(Math.max(Number.parseInt(rule.day, 10) || 1, 1), 31);
    const last = endOfMonth(start).getUTCDate();
    return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), Math.min(requested, last)));
  }
  if (type === 'DAYS_AFTER_MONTH_END') return addDays(endOfMonth(start), offset);
  if (type === 'DAYS_AFTER_QUARTER_END') return addDays(endOfQuarter(start), offset);
  if (type === 'DAYS_AFTER_FINANCIAL_YEAR_END') return addDays(endOfFinancialYear(start), offset);
  if (type === 'DAYS_AFTER_EVENT') {
    const event = parseDate(eventDate || rule.event_date);
    if (!event) throw new Error('An event date is required for this due-date rule');
    return addDays(event, offset);
  }
  throw new Error(`Unsupported due-date rule: ${type}`);
}

export function nextPeriodStart(date, frequency) {
  const source = parseDate(date);
  if (!source) throw new Error('A valid period date is required');
  const next = new Date(source);
  switch (String(frequency || '').toUpperCase()) {
    case 'MONTHLY': next.setUTCMonth(next.getUTCMonth() + 1); break;
    case 'QUARTERLY': next.setUTCMonth(next.getUTCMonth() + 3); break;
    case 'HALF_YEARLY': next.setUTCMonth(next.getUTCMonth() + 6); break;
    case 'YEARLY': next.setUTCFullYear(next.getUTCFullYear() + 1); break;
    default: return null;
  }
  return next;
}

/**
 * Produce deterministic occurrences. `periodKey` is persisted as part of a
 * unique generated key, making repeated or concurrent scheduler runs harmless.
 */
export function buildOccurrences({
  frequency, startDate, endDate = null, dueDateRule = {}, eventDate = null,
  throughDate, maxOccurrences = 60,
}) {
  const start = parseDate(startDate);
  const through = parseDate(throughDate);
  const end = parseDate(endDate);
  if (!start || !through) throw new Error('Valid start and through dates are required');

  const normalizedFrequency = String(frequency || 'ONE_TIME').toUpperCase();
  if (['ONE_TIME', 'EVENT_BASED'].includes(normalizedFrequency)) {
    const due = calculateDueDate(dueDateRule, start, eventDate);
    return due <= through && (!end || due <= end)
      ? [{ periodStart: dateKey(start), dueDate: dateKey(due), periodKey: dateKey(start) }]
      : [];
  }

  const result = [];
  let cursor = start;
  while (cursor <= through && (!end || cursor <= end) && result.length < maxOccurrences) {
    const due = calculateDueDate(dueDateRule, cursor, eventDate);
    if (due <= through && (!end || due <= end)) {
      result.push({ periodStart: dateKey(cursor), dueDate: dateKey(due), periodKey: dateKey(cursor) });
    }
    const next = nextPeriodStart(cursor, normalizedFrequency);
    if (!next || next <= cursor) break;
    cursor = next;
  }
  return result;
}

export const isTransitionAllowed = (from, to, configuredTransitions = DEFAULT_TRANSITIONS) => {
  const source = String(from || '').toUpperCase();
  const target = String(to || '').toUpperCase();
  if (!COMPLIANCE_STATUSES.includes(target)) return false;
  if (source === target) return true;
  const allowed = configuredTransitions?.[source] || DEFAULT_TRANSITIONS[source] || [];
  return allowed.map((value) => String(value).toUpperCase()).includes(target);
};

export function calculateRisk({
  dueDate, financialImpact = 0, currentRisk = 'MEDIUM', status = 'NOT_STARTED', today = new Date(),
}) {
  if (['COMPLETED', 'CANCELLED', 'NOT_APPLICABLE'].includes(String(status).toUpperCase())) return currentRisk;
  const due = parseDate(dueDate);
  if (!due) return currentRisk;
  const base = parseDate(today) || new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const days = Math.floor((due - base) / 86400000);
  const impact = Number(financialImpact) || 0;
  if (days < -7 || impact >= 10000000) return 'CRITICAL';
  if (days < 0 || days <= 3 || impact >= 2500000) return 'HIGH';
  if (days <= 15 || impact >= 500000) return 'MEDIUM';
  return String(currentRisk || 'LOW').toUpperCase() === 'CRITICAL' ? 'CRITICAL' : 'LOW';
}

export function reminderDecision({
  dueDate, today = new Date(), reminderDays = [], overdueDays = [],
}) {
  const due = parseDate(dueDate);
  const base = parseDate(today);
  if (!due || !base) return null;
  const daysRemaining = Math.floor((due - base) / 86400000);
  const dueOffsets = new Set(reminderDays.map(Number));
  const overdueOffsets = new Set(overdueDays.map(Number));
  const shouldSend = daysRemaining >= 0
    ? dueOffsets.has(daysRemaining)
    : overdueOffsets.has(Math.abs(daysRemaining));
  if (!shouldSend) return null;
  return {
    daysRemaining,
    notificationType: daysRemaining < 0
      ? `OVERDUE_${Math.abs(daysRemaining)}`
      : `DUE_${daysRemaining}`,
  };
}

export const notificationDedupeKey = ({
  organizationId, entityType, entityId, recipientUserId, channel, notificationType, scheduledFor,
}) => {
  const scheduled = parseDate(scheduledFor);
  if (!scheduled) throw new Error('A valid scheduled date is required for notification deduplication');
  return [
    organizationId, String(entityType || '').toUpperCase(), entityId, recipientUserId,
    String(channel || '').toUpperCase(), String(notificationType || '').toUpperCase(),
    dateKey(scheduled),
  ].join(':');
};

export const mandatoryChecklistBlockers = (items = []) => items.filter(
  (item) => Boolean(item?.is_mandatory) && String(item?.status || '').toUpperCase() !== 'COMPLETED'
);
