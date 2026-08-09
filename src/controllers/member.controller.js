import asyncHandler from '../utils/asyncHandler.js';
import { memberModel } from '../models/Member.model.js';
import { uploadSingle } from '../utils/upload.js';
import pool from '../config/db.js';
import { extractMemberKyc } from '../services/memberKycOcr.service.js';

const money = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const normalizedDebit = (row) => Math.max(money(row?.debit), 0) + Math.max(-money(row?.credit), 0);
const normalizedCredit = (row) => Math.max(money(row?.credit), 0) + Math.max(-money(row?.debit), 0);

// ── MEMBER FIELDS (whitelist) ──
export const MEMBER_FIELDS = [
  'member_type', 'role', 'full_name', 'father_name', 'gender', 'date_of_birth', 'blood_group',
  'phone', 'alt_phone', 'email', 'whatsapp',
  'address', 'city', 'state', 'pincode',
  'aadhar_no', 'pan_no', 'voter_id',
  'bank_name', 'account_no', 'ifsc_code', 'branch',
  'occupation', 'company_name', 'reference', 'notes', 'status',
  // New personal fields
  'mother_name', 'spouse_name', 'nationality', 'religion', 'caste',
  'marital_status', 'anniversary_date', 'qualification',
  // Additional identity
  'passport_no', 'driving_license_no', 'gst_no', 'tin_no',
  // Emergency contact
  'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relation',
  // Co-applicant (joint applicant)
  'co_applicant_name', 'co_applicant_relation', 'co_applicant_dob', 'co_applicant_gender',
  'co_applicant_phone', 'co_applicant_email', 'co_applicant_aadhar', 'co_applicant_pan',
  'co_applicant_address', 'permanent_address',
  // Nominee
  'nominee_name', 'nominee_relation', 'nominee_phone',
  // Employee-specific
  'employee_id', 'designation', 'department', 'date_of_joining', 'salary', 'employment_type',
  // Farmer-specific
  'land_area', 'crop_type', 'farm_location', 'irrigation_type', 'farming_experience',
  // Broker-specific
  'license_number', 'commission_rate', 'operating_areas',
  // Vendor-specific
  'business_name', 'service_type', 'payment_terms',
  // Team (for broker/member/employee/partner)
  'team',
];

const sanitize = (body) => {
  const data = {};
  MEMBER_FIELDS.forEach(f => {
    if (body[f] !== undefined) {
      let val = body[f];
      if (typeof val === 'string') val = val.trim();
      // Uppercase certain fields
      if (['full_name', 'father_name', 'member_type', 'role', 'gender', 'blood_group',
        'city', 'state', 'aadhar_no', 'pan_no', 'voter_id', 'ifsc_code',
        'occupation', 'company_name', 'reference', 'status',
        'mother_name', 'spouse_name', 'nationality', 'religion', 'caste',
        'marital_status', 'qualification', 'passport_no', 'driving_license_no',
        'gst_no', 'tin_no', 'emergency_contact_name', 'emergency_contact_relation',
        'nominee_name', 'nominee_relation', 'designation', 'department',
        'employment_type', 'team',
        'co_applicant_name', 'co_applicant_relation', 'co_applicant_gender',
        'co_applicant_aadhar', 'co_applicant_pan'].includes(f) && val) {
        val = val.toUpperCase();
      }
      data[f] = val || null;
    }
  });
  return data;
};

// Document field names that map to file upload keys
export const DOC_FIELDS = [
  'photo', 'aadhar_front_url', 'aadhar_back_url', 'pan_card_url',
  'voter_id_url', 'passport_url', 'driving_license_url', 'cheque_url', 'other_kyc_url',
  'resume_url', 'marksheet_10th_url', 'marksheet_12th_url',
  'degree_certificate_url', 'experience_certificate_url',
  'offer_letter_url', 'other_certificate_url',
];

/** Upload all document files in parallel and only save when every selected file succeeds. */
const uploadDocuments = async (files, options) => {
  const urls = {};
  if (!files) return urls;

  const tasks = [];
  for (const fieldName of DOC_FIELDS) {
    const fileArr = files[fieldName];
    if (fileArr && fileArr.length > 0) {
      tasks.push(uploadSingle(fileArr[0], 's3', { ...options, folder: 'member-files' }).then((url) => ({ fieldName, url })));
    }
  }
  try {
    const uploaded = await Promise.all(tasks);
    uploaded.forEach(({ fieldName, url }) => { urls[fieldName] = url; });
  } catch (error) {
    console.error('Member document upload failed:', error?.message || error);
    throw new Error('Profile image or document upload failed. Please retry.');
  }
  return urls;
};

/** POST /members — Create a new member */
export const createMember = asyncHandler(async (req, res) => {
  const { site_id } = req.body;
  if (!site_id) return res.status(400).json({ message: 'Site is required' });

  const data = sanitize(req.body);
  if (!data.full_name) return res.status(400).json({ message: 'Full name is required' });

  data.site_id = parseInt(site_id);
  data.created_by = req.user.id;

  // Run phone uniqueness check + document uploads in PARALLEL
  const phoneCheckPromise = data.phone
    ? pool.query(
        `SELECT id, full_name FROM members WHERE site_id = $1 AND phone = $2 LIMIT 1`,
        [data.site_id, data.phone]
      )
    : Promise.resolve({ rows: [] });

  const [phoneCheck, docUrls] = await Promise.all([
    phoneCheckPromise,
    uploadDocuments(req.files, { localBaseUrl: `${req.protocol}://${req.get('host')}` }),
  ]);

  if (phoneCheck.rows.length > 0) {
    return res.status(409).json({ message: `Phone number ${data.phone} is already registered to ${phoneCheck.rows[0].full_name}` });
  }

  Object.assign(data, docUrls);

  const member = await memberModel.create(data, pool);
  res.status(201).json({ member });
});

/** POST /members/kyc/extract — OCR a document and return reviewable member fields. */
export const extractKycDocument = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Select a KYC image or PDF' });
  const allowedTypes = new Set(['AADHAAR', 'PAN', 'VOTER_ID', 'PASSPORT', 'DL', 'CHEQUE', 'KYC_FORM', 'OTHER']);
  const requestedType = String(req.body.document_type || 'OTHER').toUpperCase();
  const documentType = allowedTypes.has(requestedType) ? requestedType : 'OTHER';
  try {
    const result = await extractMemberKyc(req.file.buffer, req.file.mimetype, documentType);
    const reviewable = { ...result };
    delete reviewable.rawText;
    res.json({ ...reviewable, document_type: documentType });
  } catch (error) {
    console.error('Member KYC OCR failed:', error?.message || error);
    if (String(error?.message || '').includes('API_KEY is not set')) {
      return res.status(503).json({ message: 'KYC OCR is not configured on this server' });
    }
    if (error?.name === 'AbortError') {
      return res.status(504).json({ message: 'KYC reading took too long. Please retry with a clearer or smaller document.' });
    }
    return res.status(422).json({ message: 'We could not confidently read this document. Try a clearer image or enter the details manually.' });
  }
});

/**
 * POST /members/:id/register-sites — copy an existing member profile into one
 * or more sites. Existing rows are never changed; matching site registrations
 * are reported and skipped.
 */
export const registerMemberInSites = asyncHandler(async (req, res) => {
  const memberId = Number.parseInt(req.params.id, 10);
  const requestedSiteIds = Array.isArray(req.body.site_ids)
    ? [...new Set(req.body.site_ids.map((id) => Number.parseInt(id, 10)).filter(Number.isInteger))]
    : [];
  if (!Number.isInteger(memberId)) return res.status(400).json({ message: 'Invalid member id' });
  if (requestedSiteIds.length === 0) return res.status(400).json({ message: 'Select at least one site' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [source] } = await client.query('SELECT * FROM members WHERE id = $1 FOR SHARE', [memberId]);
    if (!source) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Member not found' });
    }

    const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
    if (!isAdmin) {
      const { rows: sourceAccess } = await client.query(
        'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
        [req.user.id, source.site_id]
      );
      if (!sourceAccess[0]) {
        await client.query('ROLLBACK');
        return res.status(403).json({ message: 'This member is outside your assigned sites' });
      }
    }
    const accessResult = isAdmin
      ? await client.query('SELECT id, name FROM sites WHERE id = ANY($1::int[])', [requestedSiteIds])
      : await client.query(
          `SELECT s.id, s.name FROM sites s
             JOIN user_sites us ON us.site_id = s.id
            WHERE us.user_id = $1 AND s.id = ANY($2::int[])`,
          [req.user.id, requestedSiteIds]
        );
    if (accessResult.rows.length !== requestedSiteIds.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'One or more selected sites are unavailable to your account' });
    }

    const siteNames = new Map(accessResult.rows.map((site) => [site.id, site.name]));
    const created = [];
    const existing = [];

    for (const targetSiteId of requestedSiteIds) {
      if (targetSiteId === source.site_id) {
        existing.push({ site_id: targetSiteId, site_name: siteNames.get(targetSiteId), member_id: source.id });
        continue;
      }

      const matchConditions = [];
      const matchParams = [targetSiteId];
      const addMatch = (column, value, normaliser = 'alphanumeric') => {
        if (!value) return;
        matchParams.push(String(value).trim());
        const parameter = `$${matchParams.length}`;
        if (normaliser === 'phone') {
          matchConditions.push(`RIGHT(REGEXP_REPLACE(COALESCE(${column}, ''), '\\D', '', 'g'), 10) = RIGHT(REGEXP_REPLACE(${parameter}, '\\D', '', 'g'), 10)`);
        } else if (normaliser === 'aadhaar') {
          matchConditions.push(`RIGHT(REGEXP_REPLACE(COALESCE(${column}, ''), '\\D', '', 'g'), 12) = RIGHT(REGEXP_REPLACE(${parameter}, '\\D', '', 'g'), 12)`);
        } else {
          matchConditions.push(`UPPER(REGEXP_REPLACE(COALESCE(${column}, ''), '[^A-Za-z0-9]', '', 'g')) = UPPER(REGEXP_REPLACE(${parameter}, '[^A-Za-z0-9]', '', 'g'))`);
        }
      };
      addMatch('phone', source.phone, 'phone');
      addMatch('aadhar_no', source.aadhar_no, 'aadhaar');
      addMatch('pan_no', source.pan_no);
      if (matchConditions.length === 0) {
        matchParams.push(source.full_name);
        let fallback = `UPPER(full_name) = UPPER($${matchParams.length})`;
        if (source.father_name) {
          matchParams.push(source.father_name);
          fallback += ` AND UPPER(COALESCE(father_name, '')) = UPPER($${matchParams.length})`;
        }
        if (source.date_of_birth) {
          matchParams.push(source.date_of_birth);
          fallback += ` AND date_of_birth = $${matchParams.length}`;
        }
        matchConditions.push(`(${fallback})`);
      }
      const { rows: [matched] } = await client.query(
        `SELECT id, full_name FROM members WHERE site_id = $1 AND (${matchConditions.join(' OR ')}) LIMIT 1`,
        matchParams
      );
      if (matched) {
        existing.push({ site_id: targetSiteId, site_name: siteNames.get(targetSiteId), member_id: matched.id });
        continue;
      }

      const copy = { site_id: targetSiteId, created_by: req.user.id };
      [...MEMBER_FIELDS, ...DOC_FIELDS].forEach((field) => {
        if (source[field] !== undefined) copy[field] = source[field];
      });
      const cloned = await memberModel.create(copy, client);
      created.push({ site_id: targetSiteId, site_name: siteNames.get(targetSiteId), member_id: cloned.id });
    }

    await client.query('COMMIT');
    res.status(created.length ? 201 : 200).json({
      message: created.length
        ? `Registered ${source.full_name} in ${created.length} site${created.length === 1 ? '' : 's'}`
        : 'This member is already registered in the selected sites',
      created,
      existing,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') {
      return res.status(409).json({ message: 'A matching member is already registered in one of the selected sites' });
    }
    throw error;
  } finally {
    client.release();
  }
});

/** GET /members?site_id=X&type=CLIENT */
export const listMembers = asyncHandler(async (req, res) => {
  const { site_id, type } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const [members, summary] = await Promise.all([
    memberModel.findBySiteIdList(parseInt(site_id), pool, type || null),
    memberModel.getSummary(parseInt(site_id), pool),
  ]);
  res.json({ members, summary });
});

/** GET /members/search?site_id=X&q=... */
export const searchMembers = asyncHandler(async (req, res) => {
  const { site_id, q } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const members = await memberModel.search(parseInt(site_id), q || '', pool);
  res.json({ members });
});

/** GET /members/autocomplete?site_id=X */
export const getMemberAutocomplete = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const data = await memberModel.getAutocomplete(parseInt(site_id), pool);
  res.json(data);
});

/** GET /members/:id */
export const getMember = asyncHandler(async (req, res) => {
  const member = await memberModel.findById(parseInt(req.params.id), pool);
  if (!member) return res.status(404).json({ message: 'Member not found' });
  res.json({ member });
});

/** PUT /members/:id */
export const updateMember = asyncHandler(async (req, res) => {
  const memberId = parseInt(req.params.id);

  // Run all 3 in PARALLEL: existence/site lookup, phone uniqueness, document uploads.
  // The phone check runs unconditionally (with `$2 IS NULL` guard) so we don't add a serial step.
  const data = sanitize(req.body);

  const existingPromise = pool.query(
    `SELECT id, site_id FROM members WHERE id = $1`,
    [memberId]
  );
  const phoneCheckPromise = data.phone
    ? pool.query(
        `SELECT m.id, m.full_name
           FROM members m
           JOIN members me ON me.id = $2
          WHERE m.site_id = me.site_id AND m.phone = $1 AND m.id != $2
          LIMIT 1`,
        [data.phone, memberId]
      )
    : Promise.resolve({ rows: [] });
  const docUploadPromise = uploadDocuments(req.files, { localBaseUrl: `${req.protocol}://${req.get('host')}` });

  const [existingRes, phoneCheck, docUrls] = await Promise.all([
    existingPromise,
    phoneCheckPromise,
    docUploadPromise,
  ]);

  const existing = existingRes.rows[0];
  if (!existing) return res.status(404).json({ message: 'Member not found' });

  if (phoneCheck.rows.length > 0) {
    return res.status(409).json({ message: `Phone number ${data.phone} is already registered to ${phoneCheck.rows[0].full_name}` });
  }

  Object.assign(data, docUrls);

  // Handle removing documents
  for (const field of DOC_FIELDS) {
    if (req.body[`remove_${field}`] === 'true') {
      data[field] = null;
    }
  }

  if (Object.keys(data).length === 0) return res.status(400).json({ message: 'Nothing to update' });

  const updated = await memberModel.update(memberId, data, pool);
  res.json({ member: updated });
});

/** DELETE /members/:id */
export const deleteMember = asyncHandler(async (req, res) => {
  const existing = await memberModel.findById(parseInt(req.params.id), pool);
  if (!existing) return res.status(404).json({ message: 'Member not found' });
  await memberModel.delete(parseInt(req.params.id), pool);
  res.json({ message: 'Member deleted' });
});

/**
 * POST /members/bulk-delete
 * Body: { ids: number[] }
 */
export const bulkDeleteMembers = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((id) => parseInt(id)).filter(Number.isInteger) : [];
  if (ids.length === 0) return res.status(400).json({ message: 'ids array is required' });

  const result = await pool.query(`DELETE FROM members WHERE id = ANY($1::int[]) RETURNING id`, [ids]);
  res.json({ message: `${result.rows.length} client(s) deleted`, deleted: result.rows.map((r) => r.id) });
});

/** GET /members/:id/transactions?site_id=X */
export const getMemberTransactions = asyncHandler(async (req, res) => {
  const memberId = parseInt(req.params.id);
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const member = await memberModel.findById(memberId, pool);
  if (!member) return res.status(404).json({ message: 'Member not found' });

  const siteId = parseInt(site_id);
  const memberName = member.full_name;

  // Fetch expenses linked by assigned_user_id OR by name match
  const expensesQuery = `
    SELECT e.id, e.date, e.from_entity, e.to_entity, e.payment_mode,
           e.debit, e.credit, e.remark, e.category, e.account_no, e.branch,
           e.voucher_url, e.status, e.created_at,
           'EXPENSE' as source
    FROM expenses e
    WHERE e.site_id = $1
      AND LOWER(COALESCE(e.status, 'approved')) = 'approved'
      AND UPPER(COALESCE(e.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
      AND (e.assigned_user_id = $2 OR UPPER(e.to_entity) = UPPER($3) OR UPPER(e.from_entity) = UPPER($3))
    ORDER BY e.date DESC, e.id DESC
  `;

  // Fetch daybook entries linked by assigned_user_id OR by name match
  const daybookQuery = `
    SELECT d.id, d.date, d.from_entity, d.to_entity, d.payment_mode,
           d.debit, d.credit, d.remarks AS remark, d.category, d.account_no, d.branch,
           d.entry_type, d.status, d.created_at,
           'DAYBOOK' as source
    FROM day_book d
    WHERE d.site_id = $1
      AND d.entry_type != 'EXPENSE'
      AND LOWER(COALESCE(d.status, 'approved')) = 'approved'
      AND UPPER(COALESCE(d.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
      AND (d.assigned_user_id = $2 OR UPPER(d.to_entity) = UPPER($3) OR UPPER(d.from_entity) = UPPER($3))
    ORDER BY d.date DESC, d.id DESC
  `;

  const [expResult, dbResult] = await Promise.all([
    pool.query(expensesQuery, [siteId, memberId, memberName]),
    pool.query(daybookQuery, [siteId, memberId, memberName]),
  ]);

  const expenses = expResult.rows;
  const daybook = dbResult.rows;

  // Combine and sort by date DESC
  const all = [...expenses, ...daybook].sort((a, b) => {
    const da = new Date(a.date), db = new Date(b.date);
    return db - da || b.id - a.id;
  });

  // Summary
  const totalDebit = all.reduce((sum, row) => sum + normalizedDebit(row), 0);
  const totalCredit = all.reduce((sum, row) => sum + normalizedCredit(row), 0);

  res.json({
    transactions: all,
    summary: {
      total_debit: totalDebit,
      total_credit: totalCredit,
      net: totalCredit - totalDebit,
      count: all.length,
    },
  });
});

/** GET /members/:id/financial-info?site_id=X */
export const getMemberFinancialInfo = asyncHandler(async (req, res) => {
  const memberId = parseInt(req.params.id);
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const member = await memberModel.findById(memberId, pool);
  if (!member) return res.status(404).json({ message: 'Member not found' });

  const siteId = parseInt(site_id);
  const memberName = member.full_name;

  // Run all queries in parallel using name matching + FK where available
  const [expRes, commRes, plotPayRes, farmerPayRes, firmRes] = await Promise.all([
    // 1. Expenses — by assigned_user_id or name match
    pool.query(
      `SELECT e.id, e.date, e.from_entity, e.to_entity, e.payment_mode,
              e.debit, e.credit, e.remark, e.category, e.status, e.voucher_url
       FROM expenses e
       WHERE e.site_id = $1
         AND LOWER(COALESCE(e.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(e.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
         AND (e.assigned_user_id = $2 OR UPPER(e.to_entity) = UPPER($3) OR UPPER(e.from_entity) = UPPER($3))
       ORDER BY e.date DESC, e.id DESC`,
      [siteId, memberId, memberName]
    ),
    // 2. Plot Commissions — by particular (person name)
    pool.query(
      `SELECT pc.id, pc.date, pc.particular, pc.amount, pc.plot_no, pc.plot_size,
              pc.by_note, pc.remarks, pc.status, pc.voucher_url
       FROM plot_commissions pc
       WHERE pc.site_id = $1
         AND LOWER(COALESCE(pc.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(pc.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
         AND UPPER(pc.particular) = UPPER($2)
       ORDER BY pc.date DESC, pc.id DESC`,
      [siteId, memberName]
    ),
    // 3. Plot Payments — by payment_from (buyer name) or buyer_name on plot
    pool.query(
      `SELECT pp.id, pp.date, pp.amount, pp.payment_type, pp.bank_details,
              pp.narration, pp.payment_from, pp.received_by,
              p.plot_no, p.block, p.buyer_name
       FROM plot_payments pp
       JOIN plots p ON p.id = pp.plot_id
       WHERE pp.site_id = $1
         AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
         AND (UPPER(pp.payment_from) = UPPER($2) OR UPPER(p.buyer_name) = UPPER($2))
       ORDER BY pp.date DESC, pp.id DESC`,
      [siteId, memberName]
    ),
    // 4. Farmer Payments — via farmers.member_id
    pool.query(
      `SELECT fp.id, fp.date, fp.amount, fp.particular, fp.payment_mode,
              fp.cash_amount, fp.bank_amount, fp.remarks, fp.by_note,
              f.name AS farmer_name
       FROM farmer_payments fp
       JOIN farmers f ON f.id = fp.farmer_id
       WHERE f.site_id = $1
         AND f.member_id = $2
         AND LOWER(COALESCE(fp.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(fp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
       ORDER BY fp.date DESC, fp.id DESC`,
      [siteId, memberId]
    ),
    // 5. Firm Transactions — by name
    pool.query(
      `SELECT ft.id, ft.date, ft.debit, ft.credit, ft.description, ft.purpose,
              ft.remark, ft.cheque_no, ft.name,
              fi.name AS firm_name
       FROM firm_transactions ft
       JOIN firms fi ON fi.id = ft.firm_id
       WHERE fi.site_id = $1
         AND LOWER(COALESCE(ft.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(ft.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
         AND UPPER(ft.name) = UPPER($2)
       ORDER BY ft.date DESC, ft.id DESC`,
      [siteId, memberName]
    ),
  ]);

  const expenses = expRes.rows;
  const commissions = commRes.rows;
  const plotPayments = plotPayRes.rows;
  const farmerPayments = farmerPayRes.rows;
  const firmTransactions = firmRes.rows;

  // Summaries per category
  const expTotal = expenses.reduce(
    (sum, row) => ({
      debit: sum.debit + normalizedDebit(row),
      credit: sum.credit + normalizedCredit(row),
    }),
    { debit: 0, credit: 0 }
  );
  const commTotal = commissions.reduce((s, c) => s + (parseFloat(c.amount) || 0), 0);
  const plotPayTotal = plotPayments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const farmerPayTotal = farmerPayments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const firmTotal = firmTransactions.reduce(
    (sum, row) => ({
      debit: sum.debit + normalizedDebit(row),
      credit: sum.credit + normalizedCredit(row),
    }),
    { debit: 0, credit: 0 }
  );

  res.json({
    expenses,
    commissions,
    plot_payments: plotPayments,
    farmer_payments: farmerPayments,
    firm_transactions: firmTransactions,
    summary: {
      expenses: { count: expenses.length, debit: expTotal.debit, credit: expTotal.credit },
      commissions: { count: commissions.length, total: commTotal },
      plot_payments: { count: plotPayments.length, total: plotPayTotal },
      farmer_payments: { count: farmerPayments.length, total: farmerPayTotal },
      firm_transactions: { count: firmTransactions.length, debit: firmTotal.debit, credit: firmTotal.credit },
      grand_total_entries: expenses.length + commissions.length + plotPayments.length + farmerPayments.length + firmTransactions.length,
    },
  });
});
