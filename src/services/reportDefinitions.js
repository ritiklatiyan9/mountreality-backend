/**
 * Report definitions — one entry per reportable module.
 *
 * Everything the engine needs is declarative: where the rows come from, which
 * column is the date, what the money column is, which dimension to break down
 * by, and which columns land in the detail table. The engine (report.controller)
 * turns each of these into KPIs + a monthly trend + a breakdown + detail rows,
 * so adding a module is ~12 lines here and no new SQL.
 *
 * `permission` is the existing permission module key — reports never widen access.
 */

export const REPORTS = Object.freeze({
  plot_payments: {
    label: 'Plot Payments (Collections)',
    description: 'Money received against plots — by mode, plot and buyer.',
    permission: 'plot_payments',
    icon: 'IndianRupee',
    from: `plot_payments pp LEFT JOIN plots p ON p.id = pp.plot_id LEFT JOIN users u ON u.id = pp.created_by`,
    siteCol: 'pp.site_id',
    dateCol: 'pp.date',
    // Reports are posted-ledger views: approval queues remain available in
    // their own modules, but never inflate financial KPIs/trends here.
    where: `LOWER(COALESCE(pp.status, 'approved')) = 'approved'
      AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')`,
    amount: 'pp.amount',
    amountLabel: 'Collected',
    dimension: { expr: `CASE WHEN ledger_bucket(pp.payment_type) = 'cash' THEN 'CASH' ELSE 'BANK' END`, label: 'Payment book' },
    columns: [
      { key: 'date', expr: 'pp.date', label: 'Date', type: 'date' },
      { key: 'plot_no', expr: 'p.plot_no', label: 'Plot' },
      { key: 'block', expr: 'p.block', label: 'Block' },
      { key: 'buyer_name', expr: `COALESCE(pp.buyer_name, p.buyer_name)`, label: 'Buyer' },
      { key: 'amount', expr: 'pp.amount', label: 'Amount', type: 'money' },
      { key: 'payment_type', expr: 'pp.payment_type', label: 'Mode' },
      { key: 'payment_from', expr: 'pp.payment_from', label: 'Received from' },
      { key: 'cheque_status', expr: 'pp.cheque_status', label: 'Cheque status' },
      { key: 'received_by', expr: 'pp.received_by', label: 'Received by' },
      { key: 'created_by_name', expr: 'u.name', label: 'Entered by' },
    ],
  },

  plots: {
    label: 'Plot Sales & Bookings',
    description: 'Inventory of plots with sale value, booking and status.',
    permission: 'plot_payments',
    icon: 'LandPlot',
    from: `plots p`,
    siteCol: 'p.site_id',
    dateCol: 'p.booking_date',
    amount: 'p.sale_price',
    amountLabel: 'Sale value',
    dimension: { expr: `COALESCE(NULLIF(p.status, ''), 'UNSPECIFIED')`, label: 'Status' },
    columns: [
      { key: 'booking_date', expr: 'p.booking_date', label: 'Booked on', type: 'date' },
      { key: 'plot_no', expr: 'p.plot_no', label: 'Plot' },
      { key: 'block', expr: 'p.block', label: 'Block' },
      { key: 'buyer_name', expr: 'p.buyer_name', label: 'Buyer' },
      { key: 'plot_size', expr: 'p.plot_size', label: 'Size', type: 'number' },
      { key: 'sale_price', expr: 'p.sale_price', label: 'Sale price', type: 'money' },
      { key: 'received', expr: `
        COALESCE((
          SELECT SUM(x.amount)
          FROM plot_payments x
          WHERE x.plot_id = p.id
            AND LOWER(COALESCE(x.status, 'approved')) = 'approved'
            AND UPPER(COALESCE(x.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
        ), 0)
        + COALESCE((
          SELECT SUM(pip.amount)
          FROM plot_installment_payments pip
          WHERE pip.plot_id = p.id
            AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
        ), 0)
      `, label: 'Received', type: 'money' },
      { key: 'status', expr: 'p.status', label: 'Status' },
      { key: 'booking_by', expr: 'p.booking_by', label: 'Booked by' },
    ],
  },

  expenses: {
    label: 'Expenses',
    description: 'Outflows by category, mode and entity.',
    permission: 'expenses',
    icon: 'Receipt',
    from: `expenses e LEFT JOIN users u ON u.id = e.created_by`,
    siteCol: 'e.site_id',
    dateCol: 'e.date',
    amount: 'e.debit',
    amountLabel: 'Spent',
    where: `LOWER(COALESCE(e.status, 'approved')) = 'approved'
      AND UPPER(COALESCE(e.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')`,
    dimension: { expr: `COALESCE(NULLIF(e.category, ''), 'UNCATEGORIZED')`, label: 'Category' },
    columns: [
      { key: 'date', expr: 'e.date', label: 'Date', type: 'date' },
      { key: 'category', expr: 'e.category', label: 'Category' },
      { key: 'to_entity', expr: 'e.to_entity', label: 'Paid to' },
      { key: 'from_entity', expr: 'e.from_entity', label: 'Paid from' },
      { key: 'debit', expr: 'e.debit', label: 'Debit', type: 'money' },
      { key: 'credit', expr: 'e.credit', label: 'Credit', type: 'money' },
      { key: 'payment_mode', expr: 'e.payment_mode', label: 'Mode' },
      { key: 'status', expr: 'e.status', label: 'Status' },
      { key: 'remark', expr: 'e.remark', label: 'Remark' },
    ],
  },

  vendor_payments: {
    label: 'Vendor Payments',
    description: 'Payments released against vendor commitments.',
    permission: 'vendors',
    icon: 'Store',
    from: `vendor_payments vp LEFT JOIN vendor_commitments vc ON vc.id = vp.commitment_id`,
    siteCol: 'vp.site_id',
    dateCol: 'vp.payment_date',
    amount: 'vp.amount',
    amountLabel: 'Paid',
    where: `LOWER(COALESCE(vp.status, 'approved')) = 'approved'
      AND UPPER(COALESCE(vp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')`,
    dimension: { expr: `COALESCE(NULLIF(vc.head_name, ''), 'UNCATEGORIZED')`, label: 'Vendor head' },
    columns: [
      { key: 'payment_date', expr: 'vp.payment_date', label: 'Date', type: 'date' },
      { key: 'vendor_name', expr: 'vc.vendor_name', label: 'Vendor' },
      { key: 'work_title', expr: 'vc.work_title', label: 'Work' },
      { key: 'head_name', expr: 'vc.head_name', label: 'Head' },
      { key: 'amount', expr: 'vp.amount', label: 'Amount', type: 'money' },
      { key: 'payment_mode', expr: 'vp.payment_mode', label: 'Mode' },
      { key: 'cheque_status', expr: 'vp.cheque_status', label: 'Cheque status' },
      { key: 'reference_no', expr: 'vp.reference_no', label: 'Reference' },
    ],
  },

  vendor_commitments: {
    label: 'Vendor Commitments',
    description: 'Contracted work with paid vs outstanding value.',
    permission: 'vendors',
    icon: 'FileSignature',
    from: `vendor_commitments vc`,
    siteCol: 'vc.site_id',
    dateCol: 'vc.start_date',
    amount: 'vc.contract_amount',
    amountLabel: 'Contracted',
    dimension: { expr: `COALESCE(NULLIF(vc.head_name, ''), 'UNCATEGORIZED')`, label: 'Head' },
    columns: [
      { key: 'start_date', expr: 'vc.start_date', label: 'Start', type: 'date' },
      { key: 'due_date', expr: 'vc.due_date', label: 'Due', type: 'date' },
      { key: 'vendor_name', expr: 'vc.vendor_name', label: 'Vendor' },
      { key: 'work_title', expr: 'vc.work_title', label: 'Work' },
      { key: 'contract_amount', expr: 'vc.contract_amount', label: 'Contract', type: 'money' },
      { key: 'paid', expr: `COALESCE((SELECT SUM(x.amount) FROM vendor_payments x WHERE x.commitment_id = vc.id AND LOWER(COALESCE(x.status, 'approved')) = 'approved' AND UPPER(COALESCE(x.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')), 0)`, label: 'Paid', type: 'money' },
      { key: 'outstanding', expr: `vc.contract_amount - COALESCE((SELECT SUM(x.amount) FROM vendor_payments x WHERE x.commitment_id = vc.id AND LOWER(COALESCE(x.status, 'approved')) = 'approved' AND UPPER(COALESCE(x.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')), 0)`, label: 'Outstanding', type: 'money' },
      { key: 'status', expr: 'vc.status', label: 'Status' },
    ],
  },

  procurement: {
    label: 'Procurement Orders',
    description: 'Vendor purchase orders, payment status and stock received.',
    permission: 'vendors',
    icon: 'PackageSearch',
    from: `vendor_inventory_orders o`,
    siteCol: 'o.site_id',
    dateCol: 'o.order_date',
    amount: `ROUND(o.qty_ordered * o.rate - COALESCE(CASE WHEN o.discount_pct > 0 THEN ROUND(o.qty_ordered * o.rate * o.discount_pct / 100, 2) ELSE o.discount_amount END, 0), 2)`,
    amountLabel: 'Order value',
    dimension: { expr: `COALESCE(NULLIF(o.item_category, ''), 'UNCATEGORIZED')`, label: 'Item category' },
    columns: [
      { key: 'order_date', expr: 'o.order_date', label: 'Date', type: 'date' },
      { key: 'item_name', expr: 'o.item_name', label: 'Item' },
      { key: 'vendor_name', expr: 'o.vendor_name', label: 'Vendor' },
      { key: 'qty_ordered', expr: 'o.qty_ordered', label: 'Qty', type: 'number' },
      { key: 'rate', expr: 'o.rate', label: 'Rate', type: 'money' },
      { key: 'order_value', expr: `ROUND(o.qty_ordered * o.rate - COALESCE(CASE WHEN o.discount_pct > 0 THEN ROUND(o.qty_ordered * o.rate * o.discount_pct / 100, 2) ELSE o.discount_amount END, 0), 2)`, label: 'Value', type: 'money' },
      { key: 'total_paid', expr: 'o.total_paid', label: 'Paid', type: 'money' },
      { key: 'received_qty', expr: `COALESCE((SELECT SUM(mv.qty) FROM inventory_movements mv WHERE mv.ref_type = 'VENDOR_ORDER' AND mv.ref_id = o.id AND mv.movement_type = 'RECEIPT'), 0)`, label: 'Received', type: 'number' },
      { key: 'status', expr: 'o.status', label: 'Status' },
    ],
  },

  inventory: {
    label: 'Inventory Movements',
    description: 'Stock in/out with value, by movement type and material.',
    permission: 'inventory',
    icon: 'Boxes',
    from: `inventory_movements mv JOIN inventory_materials m ON m.id = mv.material_id LEFT JOIN construction_projects cp ON cp.id = mv.project_id LEFT JOIN users u ON u.id = mv.created_by`,
    siteCol: 'mv.site_id',
    dateCol: 'mv.created_at',
    amount: 'mv.qty * mv.rate',
    amountLabel: 'Movement value',
    dimension: { expr: 'mv.movement_type', label: 'Movement type' },
    columns: [
      { key: 'created_at', expr: 'mv.created_at', label: 'Date', type: 'date' },
      { key: 'material_name', expr: 'm.name', label: 'Material' },
      { key: 'movement_type', expr: 'mv.movement_type', label: 'Type' },
      { key: 'qty', expr: 'mv.qty', label: 'Qty', type: 'number' },
      { key: 'unit', expr: 'm.unit', label: 'Unit' },
      { key: 'rate', expr: 'mv.rate', label: 'Rate', type: 'money' },
      { key: 'value', expr: 'mv.qty * mv.rate', label: 'Value', type: 'money' },
      { key: 'project_name', expr: 'cp.name', label: 'Project' },
      { key: 'created_by_name', expr: 'u.name', label: 'By' },
    ],
  },

  construction: {
    label: 'Construction Projects',
    description: 'Project budgets, progress and consumed material cost.',
    permission: 'construction',
    icon: 'HardHat',
    from: `construction_projects cp`,
    siteCol: 'cp.site_id',
    dateCol: 'cp.start_date',
    amount: 'cp.budget',
    amountLabel: 'Budget',
    dimension: { expr: `COALESCE(NULLIF(cp.status, ''), 'UNSPECIFIED')`, label: 'Status' },
    columns: [
      { key: 'start_date', expr: 'cp.start_date', label: 'Start', type: 'date' },
      { key: 'name', expr: 'cp.name', label: 'Project' },
      { key: 'status', expr: 'cp.status', label: 'Status' },
      { key: 'budget', expr: 'cp.budget', label: 'Budget', type: 'money' },
      { key: 'actual_cost', expr: `COALESCE((SELECT SUM(mv.qty * mv.rate) FROM inventory_movements mv WHERE mv.project_id = cp.id AND mv.movement_type = 'CONSUMPTION'), 0)`, label: 'Material cost', type: 'money' },
      { key: 'progress_pct', expr: 'cp.progress_pct', label: 'Progress %', type: 'number' },
      { key: 'target_end_date', expr: 'cp.target_end_date', label: 'Target end', type: 'date' },
    ],
  },

  farmer_payments: {
    label: 'Farmer Payments',
    description: 'Land payouts to farmers with interest and mode.',
    permission: 'farmers',
    icon: 'Wheat',
    from: `farmer_payments fp JOIN farmers f ON f.id = fp.farmer_id`,
    siteCol: 'f.site_id',
    dateCol: 'fp.date',
    amount: 'fp.amount',
    amountLabel: 'Paid',
    where: `LOWER(COALESCE(fp.status, 'approved')) = 'approved'
      AND UPPER(COALESCE(fp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')`,
    dimension: { expr: `COALESCE(NULLIF(UPPER(fp.payment_mode), ''), 'UNSPECIFIED')`, label: 'Payment mode' },
    columns: [
      { key: 'date', expr: 'fp.date', label: 'Date', type: 'date' },
      { key: 'farmer_name', expr: 'f.name', label: 'Farmer' },
      { key: 'particular', expr: 'fp.particular', label: 'Particular' },
      { key: 'amount', expr: 'fp.amount', label: 'Amount', type: 'money' },
      { key: 'interest_amount', expr: 'fp.interest_amount', label: 'Interest', type: 'money' },
      { key: 'payment_mode', expr: 'fp.payment_mode', label: 'Mode' },
      { key: 'status', expr: 'fp.status', label: 'Status' },
    ],
  },

  daybook: {
    label: 'Day Book',
    description: 'Every ledger entry with debit/credit and category.',
    permission: 'daybook',
    icon: 'BookOpen',
    from: `day_book db`,
    siteCol: 'db.site_id',
    dateCol: 'db.date',
    amount: 'db.debit',
    amountLabel: 'Debit total',
    where: `LOWER(COALESCE(db.status, 'approved')) = 'approved'
      AND UPPER(COALESCE(db.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')`,
    dimension: { expr: `COALESCE(NULLIF(db.category, ''), 'UNCATEGORIZED')`, label: 'Category' },
    columns: [
      { key: 'date', expr: 'db.date', label: 'Date', type: 'date' },
      { key: 'particular', expr: 'db.particular', label: 'Particular' },
      { key: 'entry_type', expr: 'db.entry_type', label: 'Type' },
      { key: 'category', expr: 'db.category', label: 'Category' },
      { key: 'debit', expr: 'db.debit', label: 'Debit', type: 'money' },
      { key: 'credit', expr: 'db.credit', label: 'Credit', type: 'money' },
      { key: 'payment_mode', expr: 'db.payment_mode', label: 'Mode' },
      { key: 'from_entity', expr: 'db.from_entity', label: 'From' },
      { key: 'to_entity', expr: 'db.to_entity', label: 'To' },
    ],
  },

  cashflow: {
    label: 'Cash Flow',
    description: 'Cash in/out entries by cash type.',
    permission: 'cashflow',
    icon: 'ArrowLeftRight',
    from: `cash_flow_entries ce`,
    siteCol: 'ce.site_id',
    dateCol: 'ce.date',
    amount: 'ce.credit',
    amountLabel: 'Cash in',
    where: `LOWER(COALESCE(ce.status, 'approved')) = 'approved'
      AND UPPER(COALESCE(ce.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
      AND COALESCE(ce.source_module, '') NOT IN ('plot_registry_payments', 'plot_registry_payments_person')
      AND COALESCE(ce.source_module, '') NOT LIKE '%\\_person'`,
    dimension: { expr: `COALESCE(NULLIF(ce.cash_type, ''), 'UNSPECIFIED')`, label: 'Cash type' },
    columns: [
      { key: 'date', expr: 'ce.date', label: 'Date', type: 'date' },
      { key: 'particular', expr: 'ce.particular', label: 'Particular' },
      { key: 'credit', expr: 'ce.credit', label: 'In', type: 'money' },
      { key: 'debit', expr: 'ce.debit', label: 'Out', type: 'money' },
      { key: 'cash_type', expr: 'ce.cash_type', label: 'Cash type' },
      { key: 'status', expr: 'ce.status', label: 'Status' },
      { key: 'remarks', expr: 'ce.remarks', label: 'Remarks' },
    ],
  },

  firm_transactions: {
    label: 'Firm Transactions',
    description: 'Inter-firm movement of funds.',
    permission: 'firm_transactions',
    icon: 'Building2',
    from: `firm_transactions ft LEFT JOIN firms fm ON fm.id = ft.firm_id`,
    siteCol: 'ft.site_id',
    dateCol: 'ft.date',
    amount: 'ft.debit',
    amountLabel: 'Debit total',
    where: `LOWER(COALESCE(ft.status, 'approved')) = 'approved'
      AND UPPER(COALESCE(ft.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')`,
    dimension: { expr: `COALESCE(NULLIF(fm.name, ''), 'UNKNOWN FIRM')`, label: 'Firm' },
    columns: [
      { key: 'date', expr: 'ft.date', label: 'Date', type: 'date' },
      { key: 'firm_name', expr: 'fm.name', label: 'Firm' },
      { key: 'name', expr: 'ft.name', label: 'Party' },
      { key: 'purpose', expr: 'ft.purpose', label: 'Purpose' },
      { key: 'debit', expr: 'ft.debit', label: 'Debit', type: 'money' },
      { key: 'credit', expr: 'ft.credit', label: 'Credit', type: 'money' },
      { key: 'payment_mode', expr: 'ft.payment_mode', label: 'Mode' },
      { key: 'status', expr: 'ft.status', label: 'Status' },
    ],
  },

  commissions: {
    label: 'Plot Commissions',
    description: 'Agent commissions raised and paid out.',
    permission: 'commissions',
    icon: 'HandCoins',
    from: `plot_commissions_v2 pc LEFT JOIN plots p ON p.id = pc.plot_id LEFT JOIN users a ON a.id = pc.agent_id`,
    siteCol: 'pc.site_id',
    dateCol: 'pc.created_at',
    amount: 'pc.total_commission',
    amountLabel: 'Commission',
    dimension: { expr: `COALESCE(NULLIF(pc.status, ''), 'UNSPECIFIED')`, label: 'Status' },
    columns: [
      { key: 'created_at', expr: 'pc.created_at', label: 'Raised on', type: 'date' },
      { key: 'agent_name', expr: 'a.name', label: 'Agent' },
      { key: 'plot_no', expr: 'p.plot_no', label: 'Plot' },
      { key: 'total_commission', expr: 'pc.total_commission', label: 'Commission', type: 'money' },
      { key: 'paid', expr: `COALESCE((SELECT SUM(x.amount) FROM plot_commission_payments x WHERE x.plot_commission_id = pc.id AND LOWER(COALESCE(x.status, 'approved')) = 'approved' AND UPPER(COALESCE(x.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')), 0)`, label: 'Paid', type: 'money' },
      { key: 'status', expr: 'pc.status', label: 'Status' },
    ],
  },

  registry: {
    label: 'Plot Registry',
    description: 'Registered plots with registry payment and NOC status.',
    permission: 'plot_registry',
    icon: 'ScrollText',
    from: `plot_registries pr`,
    siteCol: 'pr.site_id',
    dateCol: 'pr.registry_date',
    amount: 'pr.registry_payment',
    amountLabel: 'Registry payment',
    dimension: { expr: `CASE WHEN pr.noc_approved_at IS NOT NULL THEN 'NOC APPROVED' WHEN pr.noc_generated_at IS NOT NULL THEN 'NOC GENERATED' ELSE 'PENDING NOC' END`, label: 'NOC stage' },
    columns: [
      { key: 'registry_date', expr: 'pr.registry_date', label: 'Registry date', type: 'date' },
      { key: 'plot_no', expr: 'pr.plot_no', label: 'Plot' },
      { key: 'customer_name', expr: 'pr.customer_name', label: 'Customer' },
      { key: 'farmer_name', expr: 'pr.farmer_name', label: 'Farmer' },
      { key: 'registry_payment', expr: 'pr.registry_payment', label: 'Registry payment', type: 'money' },
      { key: 'bank_amount', expr: 'pr.bank_amount', label: 'Bank amount', type: 'money' },
      { key: 'noc_no', expr: 'pr.noc_no', label: 'NOC no' },
    ],
  },

  imprest: {
    label: 'Imprest Ledger',
    description: 'Cash advances issued to and settled by staff.',
    permission: 'imprest',
    icon: 'Wallet',
    from: `imprest_ledger il LEFT JOIN users u ON u.id = il.user_id`,
    siteCol: 'il.site_id',
    dateCol: 'il.created_at',
    amount: 'il.amount',
    amountLabel: 'Ledger amount',
    dimension: { expr: `COALESCE(NULLIF(il.type, ''), 'UNSPECIFIED')`, label: 'Entry type' },
    columns: [
      { key: 'created_at', expr: 'il.created_at', label: 'Date', type: 'date' },
      { key: 'user_name', expr: 'u.name', label: 'Holder' },
      { key: 'type', expr: 'il.type', label: 'Type' },
      { key: 'amount', expr: 'il.amount', label: 'Amount', type: 'money' },
      { key: 'balance_after', expr: 'il.balance_after', label: 'Balance after', type: 'money' },
      { key: 'remarks', expr: 'il.remarks', label: 'Remarks' },
    ],
  },

  clients: {
    label: 'Members & Clients',
    description: 'People on record by type and status.',
    permission: 'clients',
    icon: 'Users',
    from: `members mb`,
    siteCol: 'mb.site_id',
    dateCol: 'mb.created_at',
    amount: null,             // headcount report — no money column
    amountLabel: 'Records',
    dimension: { expr: `COALESCE(NULLIF(mb.member_type, ''), 'UNSPECIFIED')`, label: 'Member type' },
    columns: [
      { key: 'created_at', expr: 'mb.created_at', label: 'Added', type: 'date' },
      { key: 'full_name', expr: 'mb.full_name', label: 'Name' },
      { key: 'member_type', expr: 'mb.member_type', label: 'Type' },
      { key: 'phone', expr: 'mb.phone', label: 'Phone' },
      { key: 'city', expr: 'mb.city', label: 'City' },
      { key: 'status', expr: 'mb.status', label: 'Status' },
    ],
  },
});

export const reportList = () =>
  Object.entries(REPORTS).map(([key, r]) => ({
    key, label: r.label, description: r.description, permission: r.permission, icon: r.icon,
    has_amount: Boolean(r.amount),
  }));
