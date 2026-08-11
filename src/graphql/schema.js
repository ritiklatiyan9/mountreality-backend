/**
 * GraphQL Schema — Dashboard Analytics BFF.
 * Runs alongside existing REST API on /graphql.
 */
import {
  GraphQLSchema, GraphQLObjectType, GraphQLString, GraphQLFloat,
  GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLInputObjectType,
  GraphQLEnumType, GraphQLInt, GraphQLID, GraphQLError,
} from 'graphql';
import { getAllKpis } from './services/kpi.service.js';
import { verifyFinancialIntegrity } from './services/consistency.service.js';
import { getRevenueVsExpense, getProfitTrend, getExpenseByCategory } from './services/charts.service.js';
import { getExpensesPageData, getExpensesBreakdown } from './services/expenses.service.js';
import { getPlotPageData, getPlotPaymentDetail, getRegistryBankChequePayments } from './services/plotPayments.service.js';
import { cacheGet, cacheSet, cacheEnabled, clearCacheByPrefixes } from '../config/cache.js';
import pool from '../config/db.js';
import { inventoryModel } from '../models/Inventory.model.js';
import { getFinanceForecast } from '../services/forecastEngine.service.js';

const PRIVILEGED_ROLES = new Set(['admin', 'super_admin']);

function requireModuleRead(ctx, module, rawSiteId) {
  if (!ctx?.user) {
    throw new GraphQLError('Authentication required', { extensions: { code: 'UNAUTHENTICATED' } });
  }

  const siteId = Number(rawSiteId);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new GraphQLError('A valid siteId is required', { extensions: { code: 'BAD_USER_INPUT' } });
  }

  if (!ctx.siteIds?.has(siteId)) {
    throw new GraphQLError('Access denied to this site', { extensions: { code: 'FORBIDDEN' } });
  }

  if (PRIVILEGED_ROLES.has(ctx.user.role)) return siteId;
  if (ctx.user.role !== 'sub_admin') {
    throw new GraphQLError('Insufficient permissions', { extensions: { code: 'FORBIDDEN' } });
  }

  if (ctx.permissions?.get(module)?.can_read !== true) {
    throw new GraphQLError(`Read access to ${module} is required`, { extensions: { code: 'FORBIDDEN' } });
  }
  return siteId;
}

function requirePositiveId(rawValue, name) {
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new GraphQLError(`A valid ${name} is required`, { extensions: { code: 'BAD_USER_INPUT' } });
  }
  return value;
}

// ── Input types ──

const DateRangeInput = new GraphQLInputObjectType({
  name: 'DateRange',
  fields: {
    start: { type: new GraphQLNonNull(GraphQLString) },
    end:   { type: new GraphQLNonNull(GraphQLString) },
  },
});

const ResolutionEnum = new GraphQLEnumType({
  name: 'Resolution',
  values: {
    DAY:     { value: 'DAY' },
    WEEK:    { value: 'WEEK' },
    MONTH:   { value: 'MONTH' },
    QUARTER: { value: 'QUARTER' },
    YEAR:    { value: 'YEAR' },
  },
});

const ExpenseSortOrderEnum = new GraphQLEnumType({
  name: 'ExpenseSortOrder',
  values: {
    ASC:  { value: 'asc' },
    DESC: { value: 'desc' },
  },
});

const ExpensesPageFiltersInput = new GraphQLInputObjectType({
  name: 'ExpensesPageFiltersInput',
  fields: {
    search:      { type: GraphQLString },
    mode:        { type: GraphQLString },
    category:    { type: GraphQLString },
    // Multi-category filter — each entry is ILIKE-matched against the category column and
    // all conditions are AND'd (e.g. ["PHASE 2", "JCB"] returns rows whose category contains
    // both substrings). Takes precedence over `category` when non-empty.
    categories:  { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    toEntity:    { type: GraphQLString },
    dateFrom:    { type: GraphQLString },
    dateTo:      { type: GraphQLString },
    missingBill: { type: GraphQLBoolean },
    order:       { type: ExpenseSortOrderEnum },
    onlySite:    { type: GraphQLBoolean },
  },
});

// ── Output types ──

const DiscrepancyType = new GraphQLObjectType({
  name: 'Discrepancy',
  fields: {
    kpi:       { type: new GraphQLNonNull(GraphQLString) },
    runAValue: { type: new GraphQLNonNull(GraphQLFloat) },
    runBValue: { type: new GraphQLNonNull(GraphQLFloat) },
    diff:      { type: new GraphQLNonNull(GraphQLFloat) },
    severity:  { type: new GraphQLNonNull(GraphQLString) },
  },
});

const KpiRunType = new GraphQLObjectType({
  name: 'KpiRun',
  fields: {
    totalRevenue:  { type: new GraphQLNonNull(GraphQLFloat) },
    totalExpense:  { type: new GraphQLNonNull(GraphQLFloat) },
    netProfit:     { type: new GraphQLNonNull(GraphQLFloat) },
    profitMargin:  { type: new GraphQLNonNull(GraphQLFloat) },
    outstanding:   { type: new GraphQLNonNull(GraphQLFloat) },
    cashflow:      { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const QueryDescType = new GraphQLObjectType({
  name: 'QueryDescription',
  fields: {
    runA:    { type: GraphQLString },
    runB:    { type: GraphQLString },
    formula: { type: GraphQLString },
  },
});

const VerificationType = new GraphQLObjectType({
  name: 'ConsistencyResult',
  fields: {
    passed:        { type: new GraphQLNonNull(GraphQLBoolean) },
    runA:          { type: new GraphQLNonNull(KpiRunType) },
    runB:          { type: new GraphQLNonNull(KpiRunType) },
    discrepancies: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(DiscrepancyType))) },
    checkedAt:     { type: new GraphQLNonNull(GraphQLString) },
    queriesUsed:   { type: GraphQLString }, // JSON string of query descriptions
  },
});

const CashflowDetailType = new GraphQLObjectType({
  name: 'CashflowDetail',
  fields: {
    incoming: { type: new GraphQLNonNull(GraphQLFloat) },
    outgoing: { type: new GraphQLNonNull(GraphQLFloat) },
    net:      { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const OutstandingDetailType = new GraphQLObjectType({
  name: 'OutstandingDetail',
  fields: {
    given:    { type: new GraphQLNonNull(GraphQLFloat) },
    returned: { type: new GraphQLNonNull(GraphQLFloat) },
    pending:  { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const BreakdownItemType = new GraphQLObjectType({
  name: 'BreakdownItem',
  fields: {
    module: { type: new GraphQLNonNull(GraphQLString) },
    debit:  { type: new GraphQLNonNull(GraphQLFloat) },
    credit: { type: new GraphQLNonNull(GraphQLFloat) },
    count:  { type: new GraphQLNonNull(GraphQLInt) },
  },
});

// ── Finance Forecast types ──

const ForecastSourceMixItemType = new GraphQLObjectType({
  name: 'ForecastSourceMixItem',
  fields: {
    source: { type: new GraphQLNonNull(GraphQLString) },
    amount: { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const ForecastHistoryMonthType = new GraphQLObjectType({
  name: 'ForecastHistoryMonth',
  fields: {
    key:      { type: new GraphQLNonNull(GraphQLString) },
    label:    { type: new GraphQLNonNull(GraphQLString) },
    inflow:   { type: new GraphQLNonNull(GraphQLFloat) },
    outflow:  { type: new GraphQLNonNull(GraphQLFloat) },
    net:      { type: new GraphQLNonNull(GraphQLFloat) },
    txnCount: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const ForecastWeekdayType = new GraphQLObjectType({
  name: 'ForecastWeekday',
  fields: {
    weekday:  { type: new GraphQLNonNull(GraphQLInt) },
    label:    { type: new GraphQLNonNull(GraphQLString) },
    txnCount: { type: new GraphQLNonNull(GraphQLInt) },
    inflow:   { type: new GraphQLNonNull(GraphQLFloat) },
    outflow:  { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const ForecastDueItemsType = new GraphQLObjectType({
  name: 'ForecastDueItems',
  fields: {
    overdueReceivables: { type: new GraphQLNonNull(GraphQLFloat) },
    vendorOverdue:      { type: new GraphQLNonNull(GraphQLFloat) },
    vendorUnscheduled:  { type: new GraphQLNonNull(GraphQLFloat) },
    farmerOutstanding:  { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const ForecastScenarioType = new GraphQLObjectType({
  name: 'ForecastScenario',
  fields: {
    inflow:               { type: new GraphQLNonNull(GraphQLFloat) },
    outflow:              { type: new GraphQLNonNull(GraphQLFloat) },
    net:                  { type: new GraphQLNonNull(GraphQLFloat) },
    projectedClosingCash: { type: new GraphQLNonNull(GraphQLFloat) },
    lowerBound:           { type: new GraphQLNonNull(GraphQLFloat) },
    upperBound:           { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const ForecastMonthScenariosType = new GraphQLObjectType({
  name: 'ForecastMonthScenarios',
  fields: {
    conservative: { type: new GraphQLNonNull(ForecastScenarioType) },
    base:         { type: new GraphQLNonNull(ForecastScenarioType) },
    optimistic:   { type: new GraphQLNonNull(ForecastScenarioType) },
  },
});

const ForecastMonthType = new GraphQLObjectType({
  name: 'ForecastMonth',
  fields: {
    key:              { type: new GraphQLNonNull(GraphQLString) },
    label:            { type: new GraphQLNonNull(GraphQLString) },
    patternInflow:    { type: new GraphQLNonNull(GraphQLFloat) },
    patternOutflow:   { type: new GraphQLNonNull(GraphQLFloat) },
    scheduledInflow:  { type: new GraphQLNonNull(GraphQLFloat) },
    scheduledOutflow: { type: new GraphQLNonNull(GraphQLFloat) },
    scenarios:        { type: new GraphQLNonNull(ForecastMonthScenariosType) },
  },
});

const FinanceForecastType = new GraphQLObjectType({
  name: 'FinanceForecast',
  fields: {
    modelVersion:          { type: new GraphQLNonNull(GraphQLString) },
    generatedAt:           { type: new GraphQLNonNull(GraphQLString) },
    disclaimer:            { type: new GraphQLNonNull(GraphQLString) },
    horizonMonths:         { type: new GraphQLNonNull(GraphQLInt) },
    lookbackMonths:        { type: new GraphQLNonNull(GraphQLInt) },
    currentCash:           { type: new GraphQLNonNull(GraphQLFloat) },
    expectedTotalInflow:   { type: new GraphQLNonNull(GraphQLFloat) },
    expectedTotalOutflow:  { type: new GraphQLNonNull(GraphQLFloat) },
    netMovement:           { type: new GraphQLNonNull(GraphQLFloat) },
    lowestProjectedCash:   { type: new GraphQLNonNull(GraphQLFloat) },
    firstDeficitMonth:     { type: GraphQLString },
    deficitMonthCount:     { type: new GraphQLNonNull(GraphQLInt) },
    conservativeCashFloor: { type: new GraphQLNonNull(GraphQLFloat) },
    riskLevel:             { type: new GraphQLNonNull(GraphQLString) },
    riskSummary:           { type: new GraphQLNonNull(GraphQLString) },
    inflowTrendPct:        { type: new GraphQLNonNull(GraphQLFloat) },
    outflowTrendPct:       { type: new GraphQLNonNull(GraphQLFloat) },
    inflowVolatility:      { type: new GraphQLNonNull(GraphQLFloat) },
    outflowVolatility:     { type: new GraphQLNonNull(GraphQLFloat) },
    confidenceScore:       { type: new GraphQLNonNull(GraphQLInt) },
    confidenceLevel:       { type: new GraphQLNonNull(GraphQLString) },
    history:               { type: new GraphQLList(ForecastHistoryMonthType) },
    weekdayPattern:        { type: new GraphQLList(ForecastWeekdayType) },
    sourceMixRevenue:      { type: new GraphQLList(ForecastSourceMixItemType) },
    sourceMixExpense:      { type: new GraphQLList(ForecastSourceMixItemType) },
    dueItems:              { type: ForecastDueItemsType },
    months:                { type: new GraphQLList(ForecastMonthType) },
  },
});

const ImprestDistributionType = new GraphQLObjectType({
  name: 'ImprestDistribution',
  fields: {
    subAdminId:     { type: new GraphQLNonNull(GraphQLID) },
    recipientName:  { type: new GraphQLNonNull(GraphQLString) },
    totalAmount:    { type: new GraphQLNonNull(GraphQLFloat) },
    allocationCount:{ type: new GraphQLNonNull(GraphQLInt) },
  },
});

const ImprestPairType = new GraphQLObjectType({
  name: 'ImprestPair',
  fields: {
    giverId:         { type: new GraphQLNonNull(GraphQLID) },
    giverName:       { type: new GraphQLNonNull(GraphQLString) },
    giverRole:       { type: new GraphQLNonNull(GraphQLString) },
    receiverId:      { type: new GraphQLNonNull(GraphQLID) },
    receiverName:    { type: new GraphQLNonNull(GraphQLString) },
    receiverRole:    { type: new GraphQLNonNull(GraphQLString) },
    totalAmount:     { type: new GraphQLNonNull(GraphQLFloat) },
    allocationCount: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const KpiCardsType = new GraphQLObjectType({
  name: 'KpiCards',
  fields: {
    totalRevenue:          { type: new GraphQLNonNull(GraphQLFloat) },
    totalIncoming:         { type: new GraphQLNonNull(GraphQLFloat) },
    totalOutgoing:         { type: new GraphQLNonNull(GraphQLFloat) },
    openingBalance:        { type: new GraphQLNonNull(GraphQLFloat) },
    siteBalance:           { type: new GraphQLNonNull(GraphQLFloat) },
    totalExpense:          { type: new GraphQLNonNull(GraphQLFloat) },
    netProfit:             { type: new GraphQLNonNull(GraphQLFloat) },
    profitMargin:          { type: new GraphQLNonNull(GraphQLFloat) },
    outstanding:           { type: new GraphQLNonNull(GraphQLFloat) },
    cashflow:              { type: new GraphQLNonNull(GraphQLFloat) },
    personalLedgerCredit:  { type: new GraphQLNonNull(GraphQLFloat) },
    imprestGiven:          { type: new GraphQLNonNull(GraphQLFloat) },
    registryPayments:      { type: new GraphQLNonNull(GraphQLFloat) },
    registryPaymentsCount: { type: new GraphQLNonNull(GraphQLInt) },
    registryPaymentsNew:      { type: GraphQLFloat },
    registryPaymentsOld:      { type: GraphQLFloat },
    registryPaymentsNewCount: { type: GraphQLInt },
    registryPaymentsOldCount: { type: GraphQLInt },
    imprestDistribution:   { type: new GraphQLList(ImprestDistributionType) },
    imprestPairs:          { type: new GraphQLList(ImprestPairType) },
    breakdown:             { type: new GraphQLList(BreakdownItemType) },
    cashflowDetail:        { type: CashflowDetailType },
    outstandingDetail:     { type: OutstandingDetailType },
  },
});

const ChartPointType = new GraphQLObjectType({
  name: 'ChartPoint',
  fields: {
    date:    { type: new GraphQLNonNull(GraphQLString) },
    label:   { type: new GraphQLNonNull(GraphQLString) },
    value:   { type: GraphQLFloat },
    revenue: { type: GraphQLFloat },
    expense: { type: GraphQLFloat },
  },
});

const CategoryExpenseType = new GraphQLObjectType({
  name: 'CategoryExpense',
  fields: {
    category: { type: new GraphQLNonNull(GraphQLString) },
    amount:   { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const ExpensePageSummaryType = new GraphQLObjectType({
  name: 'ExpensePageSummary',
  fields: {
    total_debit:  { type: GraphQLFloat },
    total_credit: { type: GraphQLFloat },
    total_count:  { type: GraphQLInt },
  },
});

const ExpensePagePaginationType = new GraphQLObjectType({
  name: 'ExpensePagePagination',
  fields: {
    totalItems:  { type: new GraphQLNonNull(GraphQLInt) },
    totalPages:  { type: new GraphQLNonNull(GraphQLInt) },
    currentPage: { type: new GraphQLNonNull(GraphQLInt) },
    itemsPerPage:{ type: new GraphQLNonNull(GraphQLInt) },
  },
});

const ExpenseModeBreakdownType = new GraphQLObjectType({
  name: 'ExpenseModeBreakdown',
  fields: {
    payment_mode: { type: GraphQLString },
    total_debit:  { type: GraphQLFloat },
    total_credit: { type: GraphQLFloat },
    entries:      { type: GraphQLInt },
  },
});

const ExpenseCategoryBreakdownType = new GraphQLObjectType({
  name: 'ExpenseCategoryBreakdown',
  fields: {
    category:     { type: GraphQLString },
    total_debit:  { type: GraphQLFloat },
    total_credit: { type: GraphQLFloat },
    entries:      { type: GraphQLInt },
  },
});

const ExpenseEntryType = new GraphQLObjectType({
  name: 'ExpenseEntry',
  fields: {
    id:                { type: new GraphQLNonNull(GraphQLID) },
    original_id:       { type: GraphQLInt },
    site_id:           { type: GraphQLInt },
    date:              { type: GraphQLString },
    from_entity:       { type: GraphQLString },
    to_entity:         { type: GraphQLString },
    payment_mode:      { type: GraphQLString },
    debit:             { type: GraphQLFloat },
    credit:            { type: GraphQLFloat },
    balance:           { type: GraphQLFloat },
    remark:            { type: GraphQLString },
    account_no:        { type: GraphQLString },
    branch:            { type: GraphQLString },
    category:          { type: GraphQLString },
    status:            { type: GraphQLString },
    approved_by:       { type: GraphQLInt },
    approved_at:       { type: GraphQLString },
    approved_by_name:  { type: GraphQLString },
    created_by:        { type: GraphQLInt },
    created_by_name:   { type: GraphQLString },
    created_at:        { type: GraphQLString },
    updated_at:        { type: GraphQLString },
    assigned_user_id:  { type: GraphQLInt },
    assigned_user_name:{ type: GraphQLString },
    assigned_admin_id: { type: GraphQLInt },
    assigned_admin_name:{ type: GraphQLString },
    voucher_url:       { type: GraphQLString },
    bill_url:          { type: GraphQLString },
    customer_signature_url: { type: GraphQLString },
    authority_signature_url: { type: GraphQLString },
    source:            { type: GraphQLString },
    cheque_no:         { type: GraphQLString },
    cheque_status:     { type: GraphQLString },
    verifyUrl:         { type: GraphQLString },
  },
});

const ExpensesPageDataType = new GraphQLObjectType({
  name: 'ExpensesPageData',
  fields: {
    expenses:          { type: new GraphQLList(ExpenseEntryType) },
    summary:           { type: ExpensePageSummaryType },
    pagination:        { type: ExpensePagePaginationType },
    modeBreakdown:     { type: new GraphQLList(ExpenseModeBreakdownType) },
    categoryBreakdown: { type: new GraphQLList(ExpenseCategoryBreakdownType) },
  },
});

const ExpensesBreakdownType = new GraphQLObjectType({
  name: 'ExpensesBreakdown',
  fields: {
    modeBreakdown:     { type: new GraphQLList(ExpenseModeBreakdownType) },
    categoryBreakdown: { type: new GraphQLList(ExpenseCategoryBreakdownType) },
  },
});

// ── Plot Payment Types ──

const PlotMemberType = new GraphQLObjectType({
  name: 'PlotMember',
  fields: {
    name:       { type: new GraphQLNonNull(GraphQLString) },
    phone:      { type: GraphQLString },
    team:       { type: GraphQLString },
    memberType: { type: GraphQLString },
  },
});

const PlotAutocompleteType = new GraphQLObjectType({
  name: 'PlotAutocomplete',
  fields: {
    buyerNames:   { type: new GraphQLList(GraphQLString) },
    paymentFroms: { type: new GraphQLList(GraphQLString) },
    bankDetails:  { type: new GraphQLList(GraphQLString) },
    narrations:   { type: new GraphQLList(GraphQLString) },
    receivedBys:  { type: new GraphQLList(GraphQLString) },
    bookedBys:    { type: new GraphQLList(GraphQLString) },
    members:      { type: new GraphQLList(PlotMemberType) },
  },
});

const PlotType = new GraphQLObjectType({
  name: 'Plot',
  fields: {
    id:                  { type: new GraphQLNonNull(GraphQLID) },
    site_id:             { type: GraphQLInt },
    plot_no:             { type: GraphQLString },
    block:               { type: GraphQLString },
    buyer_name:          { type: GraphQLString },
    plot_size:           { type: GraphQLFloat },
    plot_size_mtr:       { type: GraphQLFloat },
    plot_rate:           { type: GraphQLFloat },
    sale_price:          { type: GraphQLFloat },
    registry_area:       { type: GraphQLFloat },
    circle_rate:         { type: GraphQLFloat },
    to_receive_bank:     { type: GraphQLFloat },
    first_installment:   { type: GraphQLFloat },
    booking_by:          { type: GraphQLString },
    booking_date:        { type: GraphQLString },
    status:              { type: GraphQLString },
    notes:               { type: GraphQLString },
    plot_tag:            { type: GraphQLString },
    team:                { type: GraphQLString },
    plot_commission:     { type: GraphQLFloat },
    commission_enabled:  { type: GraphQLBoolean },
    commission_type:     { type: GraphQLString },
    commission_value:    { type: GraphQLFloat },
    commission_rate:     { type: GraphQLFloat },
    original_plot_rate:  { type: GraphQLFloat },
    discount_rate:       { type: GraphQLFloat },
    plc_charges:         { type: GraphQLFloat },
    installments_enabled: { type: GraphQLBoolean },
    interest_enabled:    { type: GraphQLBoolean },
    interest_rate:       { type: GraphQLFloat },
    interest_type:       { type: GraphQLString },
    grace_period_days:   { type: GraphQLInt },
    free_to_sale_days:   { type: GraphQLInt },
    assigned_admin_id:   { type: GraphQLInt },
    created_by:          { type: GraphQLInt },
    created_at:          { type: GraphQLString },
    updated_at:          { type: GraphQLString },
    // Payment aggregates
    total_received:        { type: GraphQLFloat },
    received_bank:         { type: GraphQLFloat },
    received_cash:         { type: GraphQLFloat },
    payment_count:         { type: GraphQLInt },
    payment_buyer_names:   { type: GraphQLString },
    payment_booked_bys:    { type: GraphQLString },
  },
});

const PlotPageDataType = new GraphQLObjectType({
  name: 'PlotPageData',
  fields: {
    plots:        { type: new GraphQLList(PlotType) },
    autocomplete: { type: PlotAutocompleteType },
  },
});

const PlotPaymentType = new GraphQLObjectType({
  name: 'PlotPayment',
  fields: {
    id:                { type: new GraphQLNonNull(GraphQLID) },
    plot_id:           { type: GraphQLInt },
    site_id:           { type: GraphQLInt },
    date:              { type: GraphQLString },
    payment_from:      { type: GraphQLString },
    payment_type:      { type: GraphQLString },
    bank_details:      { type: GraphQLString },
    bank_name:         { type: GraphQLString },
    branch:            { type: GraphQLString },
    narration:         { type: GraphQLString },
    amount:            { type: GraphQLFloat },
    voucher_url:       { type: GraphQLString },
    customer_signature_url:  { type: GraphQLString },
    authority_signature_url: { type: GraphQLString },
    assigned_admin_id: { type: GraphQLInt },
    buyer_name:        { type: GraphQLString },
    booked_by:         { type: GraphQLString },
    received_by:       { type: GraphQLString },
    cheque_no:         { type: GraphQLString },
    cheque_status:     { type: GraphQLString },
    status:            { type: GraphQLString },
    approved_by:       { type: GraphQLInt },
    approved_at:       { type: GraphQLString },
    created_by:        { type: GraphQLInt },
    created_by_name:   { type: GraphQLString },
    created_at:        { type: GraphQLString },
    source:            { type: GraphQLString },
  },
});

const PaymentBreakdownType = new GraphQLObjectType({
  name: 'PaymentBreakdown',
  fields: {
    payment_from: { type: GraphQLString },
    received_by:  { type: GraphQLString },
    entries:      { type: GraphQLInt },
    total_amount: { type: GraphQLFloat },
    // DIRECT, INSTALLMENT, or MIXED when a label contains both sources.
    source:       { type: GraphQLString },
  },
});

const PlotInstallmentType = new GraphQLObjectType({
  name: 'PlotInstallment',
  fields: {
    id:               { type: new GraphQLNonNull(GraphQLID) },
    plot_id:          { type: GraphQLInt },
    installment_name: { type: GraphQLString },
    amount:           { type: GraphQLFloat },
    due_date:         { type: GraphQLString },
    sort_order:       { type: GraphQLInt },
    paid_amount:      { type: GraphQLFloat },
    created_at:       { type: GraphQLString },
  },
});

const PlotPaymentDetailType = new GraphQLObjectType({
  name: 'PlotPaymentDetail',
  fields: {
    payments:              { type: new GraphQLList(PlotPaymentType) },
    plot:                  { type: PlotType },
    fromBreakdown:         { type: new GraphQLList(PaymentBreakdownType) },
    receivedByBreakdown:   { type: new GraphQLList(PaymentBreakdownType) },
    installments:          { type: new GraphQLList(PlotInstallmentType) },
    installmentPayments:   { type: new GraphQLList(PlotPaymentType) },
  },
});

const RegistryLinkablePaymentType = new GraphQLObjectType({
  name: 'RegistryLinkablePayment',
  fields: {
    id:                        { type: new GraphQLNonNull(GraphQLID) },
    plot_id:                   { type: GraphQLInt },
    plot_no:                   { type: GraphQLString },
    customer_name:             { type: GraphQLString },
    customer_phone:            { type: GraphQLString },
    date:                      { type: GraphQLString },
    amount:                    { type: GraphQLFloat },
    payment_type:              { type: GraphQLString },
    payment_from:              { type: GraphQLString },
    narration:                 { type: GraphQLString },
    bank_details:              { type: GraphQLString },
    mapped_registry_payment_id: { type: GraphQLInt },
  },
});

// ── Cache helpers ──
const CACHE_TTL = 15; // 15 seconds — short enough to stay fresh while reducing DB load
const FORECAST_CACHE_TTL = 55; // Finance Forecast polls every 60s; cache just under that

function cacheKey(prefix, siteId, start, end) {
  return `dashboard:${prefix}:${siteId}:${start}:${end}`;
}

function serializeFilters(filters = {}) {
  return Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${String(value)}`)
    .join('|') || 'none';
}

function expensesCacheKey(userId, siteId, page, limit, filters) {
  return `expenses:page:${userId}:${siteId}:${page}:${limit}:${filters}`;
}

// ── Root Query ──

// ── Construction + Inventory dashboard cards ──
const ConstructionDashboardType = new GraphQLObjectType({
  name: 'ConstructionDashboard',
  fields: {
    activeProjects:          { type: GraphQLInt },
    delayedProjects:         { type: GraphQLInt },
    avgProgress:             { type: GraphQLInt },
    pendingMaterialRequests: { type: GraphQLInt },
    totalBudget:             { type: GraphQLFloat },
    totalActualCost:         { type: GraphQLFloat },
  },
});
const InventoryDashboardType = new GraphQLObjectType({
  name: 'InventoryDashboard',
  fields: {
    materialCount:           { type: GraphQLInt },
    totalValue:              { type: GraphQLFloat },
    lowStockCount:           { type: GraphQLInt },
    pendingVendorDeliveries: { type: GraphQLInt },
  },
});

const QueryType = new GraphQLObjectType({
  name: 'Query',
  fields: {
    constructionDashboard: {
      type: ConstructionDashboardType,
      args: { siteId: { type: new GraphQLNonNull(GraphQLID) } },
      async resolve(_, { siteId }, ctx) {
        const id = requireModuleRead(ctx, 'construction', siteId);
        const [agg, req, cost] = await Promise.all([
          pool.query(
            `SELECT
               COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active_projects,
               COUNT(*) FILTER (WHERE status = 'DELAYED' OR (target_end_date IS NOT NULL AND target_end_date < CURRENT_DATE AND status <> 'COMPLETED'))::int AS delayed_projects,
               COALESCE(ROUND(AVG(progress_pct) FILTER (WHERE status IN ('ACTIVE','DELAYED'))), 0)::int AS avg_progress,
               COALESCE(SUM(budget), 0) AS total_budget
             FROM construction_projects WHERE site_id = $1`, [id]),
          pool.query(`SELECT COUNT(*)::int AS c FROM construction_material_requests WHERE site_id = $1 AND status IN ('REQUESTED','PARTIALLY_FULFILLED')`, [id]),
          pool.query(`SELECT COALESCE(SUM(qty*rate),0) AS c FROM inventory_movements WHERE movement_type='CONSUMPTION' AND site_id = $1`, [id]),
        ]);
        return {
          activeProjects: agg.rows[0].active_projects,
          delayedProjects: agg.rows[0].delayed_projects,
          avgProgress: agg.rows[0].avg_progress,
          pendingMaterialRequests: req.rows[0].c,
          totalBudget: parseFloat(agg.rows[0].total_budget) || 0,
          totalActualCost: parseFloat(cost.rows[0].c) || 0,
        };
      },
    },
    inventoryDashboard: {
      type: InventoryDashboardType,
      args: { siteId: { type: new GraphQLNonNull(GraphQLID) } },
      async resolve(_, { siteId }, ctx) {
        const id = requireModuleRead(ctx, 'inventory', siteId);
        const [s, deliv] = await Promise.all([
          inventoryModel.summary(id),
          pool.query(`SELECT COUNT(*)::int AS c FROM vendor_inventory_orders WHERE site_id = $1 AND status IN ('open','partial')`, [id]),
        ]);
        return {
          materialCount: s.material_count,
          totalValue: parseFloat(s.total_value) || 0,
          lowStockCount: s.low_stock_count,
          pendingVendorDeliveries: deliv.rows[0].c,
        };
      },
    },
    kpiCards: {
      type: KpiCardsType,
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
        range:  { type: new GraphQLNonNull(DateRangeInput) },
        excludeOldPlots: { type: GraphQLBoolean },
      },
      async resolve(_, { siteId, range, excludeOldPlots = false }, ctx) {
        const id = requireModuleRead(ctx, 'dashboard', siteId);

        // Redis cache — was completely UNCACHED before despite running 9
        // heavy parallel queries on every Dashboard load. This is the
        // single biggest perf win on the dashboard. Mutations on any of
        // the 6 source modules already call clearCacheByPrefixes(['dashboard:'])
        // (see e.g. cashflow.controller.js), so cached values stay fresh.
        const key = cacheKey(`kpi-cards-v2${excludeOldPlots ? '-new' : ''}`, id, range.start, range.end);

        if (cacheEnabled()) {
          const cached = await cacheGet(key);
          if (cached) return cached;
        }

        const result = await getAllKpis(id, range.start, range.end, excludeOldPlots);

        // Transform breakdown object → array for GraphQL
        const breakdownArr = Object.entries(result.breakdown).map(([mod, v]) => ({
          module: mod,
          debit: v.debit || 0,
          credit: v.credit || 0,
          count: v.count || 0,
        }));

        const payload = { ...result, breakdown: breakdownArr };
        if (cacheEnabled()) await cacheSet(key, payload, CACHE_TTL);
        return payload;
      },
    },

    financeForecast: {
      type: FinanceForecastType,
      args: {
        siteId:         { type: new GraphQLNonNull(GraphQLID) },
        horizonMonths:  { type: GraphQLInt },
        lookbackMonths: { type: GraphQLInt },
        forceRefresh:   { type: GraphQLBoolean },
      },
      async resolve(_, { siteId, horizonMonths = 6, lookbackMonths = 6, forceRefresh = false }, ctx) {
        const id = requireModuleRead(ctx, 'finance_forecast', siteId);

        // Same dashboard: cache namespace/helper as kpiCards, so the existing
        // clearCacheByPrefixes(['dashboard:', ...]) calls that already fire
        // after farmer/plot/vendor/expense mutations invalidate this too,
        // with no extra wiring at each mutation call site.
        const key = cacheKey('finance-forecast', id, horizonMonths, lookbackMonths);

        if (!forceRefresh && cacheEnabled()) {
          const cached = await cacheGet(key);
          if (cached) return cached;
        }

        const result = await getFinanceForecast(id, { horizonMonths, lookbackMonths });

        const payload = {
          ...result,
          sourceMixRevenue: Object.entries(result.sourceMix.revenue).map(([source, amount]) => ({ source, amount })),
          sourceMixExpense: Object.entries(result.sourceMix.expense).map(([source, amount]) => ({ source, amount })),
        };
        if (cacheEnabled()) await cacheSet(key, payload, FORECAST_CACHE_TTL);
        return payload;
      },
    },

    verifyFinancialIntegrity: {
      type: VerificationType,
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
        range:  { type: new GraphQLNonNull(DateRangeInput) },
      },
      async resolve(_, { siteId, range }, ctx) {
        const id = requireModuleRead(ctx, 'dashboard', siteId);
        const result = await verifyFinancialIntegrity(id, range.start, range.end);
        return {
          ...result,
          queriesUsed: JSON.stringify(result.queriesUsed),
        };
      },
    },

    revenueVsExpense: {
      type: new GraphQLList(ChartPointType),
      args: {
        siteId:     { type: new GraphQLNonNull(GraphQLID) },
        range:      { type: new GraphQLNonNull(DateRangeInput) },
        resolution: { type: ResolutionEnum },
        excludeOldPlots: { type: GraphQLBoolean },
      },
      async resolve(_, { siteId, range, resolution = 'MONTH', excludeOldPlots = false }, ctx) {
        const id = requireModuleRead(ctx, 'dashboard', siteId);
        const key = cacheKey(`chart-rve-v2-${resolution}${excludeOldPlots ? '-new' : ''}`, id, range.start, range.end);

        if (cacheEnabled()) {
          const cached = await cacheGet(key);
          if (cached) return cached;
        }

        const data = await getRevenueVsExpense(id, range.start, range.end, resolution, excludeOldPlots);
        if (cacheEnabled()) await cacheSet(key, data, CACHE_TTL);
        return data;
      },
    },

    profitTrend: {
      type: new GraphQLList(ChartPointType),
      args: {
        siteId:     { type: new GraphQLNonNull(GraphQLID) },
        range:      { type: new GraphQLNonNull(DateRangeInput) },
        resolution: { type: ResolutionEnum },
        excludeOldPlots: { type: GraphQLBoolean },
      },
      async resolve(_, { siteId, range, resolution = 'MONTH', excludeOldPlots = false }, ctx) {
        const id = requireModuleRead(ctx, 'dashboard', siteId);
        const key = cacheKey(`chart-profit-v2-${resolution}${excludeOldPlots ? '-new' : ''}`, id, range.start, range.end);

        if (cacheEnabled()) {
          const cached = await cacheGet(key);
          if (cached) return cached;
        }

        const data = await getProfitTrend(id, range.start, range.end, resolution, excludeOldPlots);
        if (cacheEnabled()) await cacheSet(key, data, CACHE_TTL);
        return data;
      },
    },

    expensesByCategory: {
      type: new GraphQLList(CategoryExpenseType),
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
        range:  { type: new GraphQLNonNull(DateRangeInput) },
        top:    { type: GraphQLInt },
      },
      async resolve(_, { siteId, range, top = 8 }, ctx) {
        const id = requireModuleRead(ctx, 'dashboard', siteId);
        const data = await getExpenseByCategory(id, range.start, range.end, top);
        return data;
      },
    },

    expensesPageData: {
      type: ExpensesPageDataType,
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
        page:   { type: GraphQLInt },
        limit:  { type: GraphQLInt },
        filters:{ type: ExpensesPageFiltersInput },
        includeBreakdowns: { type: GraphQLBoolean },
      },
      async resolve(_, { siteId, page = 1, limit = 20, filters = {}, includeBreakdowns = false }, ctx) {
        const id = requireModuleRead(ctx, 'expenses', siteId);
        const safePage = Number.isFinite(page) ? Math.max(1, page) : 1;
        const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, limit)) : 20;
        const normalizedFilters = {
          search: filters.search || undefined,
          mode: filters.mode || undefined,
          category: filters.category || undefined,
          categories: Array.isArray(filters.categories) && filters.categories.length > 0
            ? filters.categories.map((c) => String(c).trim()).filter(Boolean)
            : undefined,
          to_entity: filters.toEntity || undefined,
          dateFrom: filters.dateFrom || undefined,
          dateTo: filters.dateTo || undefined,
          missing_bill: filters.missingBill ? 'true' : undefined,
          order: filters.order || 'desc',
          // Expenses module should show only entries from expense page.
          only_site: filters.onlySite === false ? undefined : 'true',
        };

        const key = expensesCacheKey(
          ctx.user.id || 'anon',
          id,
          safePage,
          safeLimit,
          serializeFilters(normalizedFilters),
        ) + `:br=${includeBreakdowns ? 1 : 0}`;

        if (cacheEnabled()) {
          const cached = await cacheGet(key);
          if (cached) return cached;
        }

        const data = await getExpensesPageData(id, {
          filters: normalizedFilters,
          page: safePage,
          limit: safeLimit,
          includeBreakdowns,
        });

        if (cacheEnabled()) await cacheSet(key, data, CACHE_TTL);
        return data;
      },
    },

    expensesBreakdown: {
      type: ExpensesBreakdownType,
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
        filters:{ type: ExpensesPageFiltersInput },
      },
      async resolve(_, { siteId, filters = {} }, ctx) {
        const id = requireModuleRead(ctx, 'expenses', siteId);
        const normalizedFilters = {
          search: filters.search || undefined,
          mode: filters.mode || undefined,
          category: filters.category || undefined,
          categories: Array.isArray(filters.categories) && filters.categories.length > 0
            ? filters.categories.map((c) => String(c).trim()).filter(Boolean)
            : undefined,
          to_entity: filters.toEntity || undefined,
          dateFrom: filters.dateFrom || undefined,
          dateTo: filters.dateTo || undefined,
          missing_bill: filters.missingBill ? 'true' : undefined,
          order: filters.order || 'desc',
          only_site: filters.onlySite === false ? undefined : 'true',
        };

        const key = `expenses:breakdown:${ctx.user.id || 'anon'}:${id}:${serializeFilters(normalizedFilters)}`;

        if (cacheEnabled()) {
          const cached = await cacheGet(key);
          if (cached) return cached;
        }

        const data = await getExpensesBreakdown(id, { filters: normalizedFilters });

        if (cacheEnabled()) await cacheSet(key, data, CACHE_TTL);
        return data;
      },
    },

    // ── Plot Payments queries ──

    plotPageData: {
      type: PlotPageDataType,
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
      },
      async resolve(_, { siteId }, ctx) {
        const id = requireModuleRead(ctx, 'plot_payments', siteId);
        const key = `plots:pageData:${id}`;

        if (cacheEnabled()) {
          const cached = await cacheGet(key);
          if (cached) return cached;
        }

        const data = await getPlotPageData(id);

        if (cacheEnabled()) await cacheSet(key, data, 60); // 1 min cache
        return data;
      },
    },

    plotPaymentDetail: {
      type: PlotPaymentDetailType,
      args: {
        plotId: { type: new GraphQLNonNull(GraphQLID) },
        siteId: { type: new GraphQLNonNull(GraphQLID) },
      },
      async resolve(_, { plotId, siteId }, ctx) {
        const id = requireModuleRead(ctx, 'plot_payments', siteId);
        const data = await getPlotPaymentDetail(requirePositiveId(plotId, 'plotId'), id);
        return data;
      },
    },

    registryBankChequePayments: {
      type: new GraphQLList(RegistryLinkablePaymentType),
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
      },
      async resolve(_, { siteId }, ctx) {
        const id = requireModuleRead(ctx, 'plot_registry', siteId);
        return getRegistryBankChequePayments(id);
      },
    },
  },
});

// ── Mutation: invalidate dashboard cache ──
const MutationType = new GraphQLObjectType({
  name: 'Mutation',
  fields: {
    invalidateDashboardCache: {
      type: GraphQLBoolean,
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
      },
      async resolve(_, { siteId }, ctx) {
        const id = requireModuleRead(ctx, 'dashboard', siteId);
        await clearCacheByPrefixes([`dashboard:*:${id}:`]);
        return true;
      },
    },

    invalidatePlotCache: {
      type: GraphQLBoolean,
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
      },
      async resolve(_, { siteId }, ctx) {
        const id = requireModuleRead(ctx, 'plot_payments', siteId);
        await clearCacheByPrefixes([`plots:pageData:${id}`]);
        return true;
      },
    },
  },
});

export const schema = new GraphQLSchema({
  query: QueryType,
  mutation: MutationType,
});
