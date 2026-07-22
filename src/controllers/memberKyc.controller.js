import crypto from 'crypto';
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { clearCacheByPrefixes } from '../config/cache.js';
import { extractMemberKyc } from '../services/memberKycOcr.service.js';
import {
  deletePlotDoc, getPlotDocBytes, getPlotDocPublicUrl, getPlotDocUrl, uploadPlotDoc,
} from '../utils/plotDocStorage.js';

const DOCUMENT_FIELDS_BY_TYPE = {
  PHOTO: ['photo'],
  AADHAAR: ['aadhar_front_url', 'aadhar_back_url'],
  PAN: ['pan_card_url'],
  VOTER_ID: ['voter_id_url'],
  PASSPORT: ['passport_url'],
  DL: ['driving_license_url'],
  CHEQUE: ['cheque_url'],
  KYC_FORM: ['other_kyc_url'],
  OTHER: ['other_kyc_url'],
};

const MEMBER_UPDATE_FIELDS = [
  'full_name', 'father_name', 'mother_name', 'spouse_name', 'gender', 'date_of_birth',
  'marital_status', 'religion', 'nationality', 'qualification', 'occupation', 'company_name',
  'phone', 'alt_phone', 'whatsapp', 'email', 'address', 'city', 'state', 'pincode',
  'aadhar_no', 'pan_no', 'voter_id', 'passport_no', 'driving_license_no',
  'gst_no',
  'bank_name', 'account_no', 'ifsc_code', 'branch',
  'nominee_name', 'nominee_relation', 'nominee_phone',
];

const UPPERCASE_MEMBER_FIELDS = new Set([
  'full_name', 'father_name', 'mother_name', 'spouse_name', 'gender', 'marital_status',
  'religion', 'nationality', 'qualification', 'occupation', 'company_name', 'address',
  'city', 'state', 'aadhar_no', 'pan_no', 'voter_id', 'passport_no',
  'driving_license_no', 'gst_no', 'bank_name', 'ifsc_code', 'branch', 'nominee_name',
  'nominee_relation',
]);

const MEMBER_DOCUMENT_FIELDS = new Set(Object.values(DOCUMENT_FIELDS_BY_TYPE).flat());
const MUTABLE_CASE_STATUSES = new Set(['OPEN', 'OCR_PENDING', 'OCR_DONE']);

const normalisePhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const canAccessSite = async (user, siteId) => {
  if (['admin', 'super_admin'].includes(user?.role)) return true;
  const { rows } = await pool.query(
    'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
    [user?.id, siteId]
  );
  return Boolean(rows[0]);
};

const getAccessibleCase = async (caseId, user) => {
  const { rows } = await pool.query(
    `SELECT k.*, m.full_name AS client_name, m.phone AS client_phone,
            m.photo AS client_photo, m.updated_at AS member_updated_at,
            s.name AS site_name
       FROM kyc_cases k
       LEFT JOIN members m ON m.id = k.client_member_id
       LEFT JOIN sites s ON s.id = k.site_id
      WHERE k.id = $1`,
    [caseId]
  );
  const kycCase = rows[0];
  if (!kycCase) return { missing: true };
  if (!(await canAccessSite(user, kycCase.site_id))) return { denied: true };
  return { kycCase };
};

const getLatestDocumentResult = async (documentId) => {
  const { rows } = await pool.query(
    `SELECT d.*, r.extracted_fields, r.confidence_overall,
            r.confidence_map, r.engine AS result_engine, r.processed_at
       FROM documents d
       LEFT JOIN LATERAL (
         SELECT * FROM ocr_results o
          WHERE o.document_id = d.id
          ORDER BY o.id DESC LIMIT 1
       ) r ON true
      WHERE d.id = $1`,
    [documentId]
  );
  return rows[0] || null;
};

const newestDocument = (documents = []) => documents.reduce(
  (latest, document) => (!latest || Number(document.id) > Number(latest.id) ? document : latest),
  null
);

/**
 * Return the current document in each member-profile slot while retaining every
 * upload row in the database as immutable history. Older shared KYC rows did not
 * record a slot, so the newest legacy document remains the compatibility fallback.
 */
const selectActiveDocuments = (rows = []) => {
  const active = [];
  const aadhaar = rows.filter((document) => document.type === 'AADHAAR');
  const labelledAadhaar = (field) => newestDocument(
    aadhaar.filter((document) => document.member_document_field === field)
  );
  let front = labelledAadhaar('aadhar_front_url');
  let back = labelledAadhaar('aadhar_back_url');
  const legacyAadhaar = aadhaar
    .filter((document) => !document.member_document_field)
    .sort((left, right) => Number(left.id) - Number(right.id));

  if (!front && !back) {
    const latestPair = legacyAadhaar.slice(-2);
    [front, back] = latestPair;
  } else if (!front) {
    front = legacyAadhaar.at(-1) || null;
  } else if (!back) {
    back = legacyAadhaar.at(-1) || null;
  }

  const nonAadhaar = rows.filter((document) => document.type !== 'AADHAAR');
  const labelledBySlot = new Map();
  for (const document of nonAadhaar.filter((item) => item.member_document_field)) {
    const current = labelledBySlot.get(document.member_document_field);
    if (!current || Number(document.id) > Number(current.id)) {
      labelledBySlot.set(document.member_document_field, document);
    }
  }
  active.push(...labelledBySlot.values());

  const labelledTypes = new Set([...labelledBySlot.values()].map((document) => document.type));
  const legacyByType = new Map();
  for (const document of nonAadhaar.filter((item) => !item.member_document_field)) {
    const expectedSlots = DOCUMENT_FIELDS_BY_TYPE[document.type] || [];
    if (labelledTypes.has(document.type)
      || expectedSlots.some((field) => labelledBySlot.has(field))) continue;
    const current = legacyByType.get(document.type);
    if (!current || Number(document.id) > Number(current.id)) legacyByType.set(document.type, document);
  }
  active.push(...legacyByType.values());

  active.sort((left, right) => Number(left.id) - Number(right.id));
  if (front) active.push(front);
  if (back) active.push(back);
  return active;
};

const getCaseDocuments = async (caseId) => {
  const { rows } = await pool.query(
    `SELECT d.*, r.extracted_fields, r.confidence_overall,
            r.confidence_map, r.engine AS result_engine, r.processed_at
       FROM documents d
       LEFT JOIN LATERAL (
         SELECT * FROM ocr_results o
          WHERE o.document_id = d.id
          ORDER BY o.id DESC LIMIT 1
       ) r ON true
      WHERE d.kyc_case_id = $1
      ORDER BY d.id ASC`,
    [caseId]
  );

  const activeDocuments = selectActiveDocuments(rows);
  await Promise.all(activeDocuments.map(async (document) => {
    try {
      document.file_url = await getPlotDocUrl(document.file_path);
    } catch {
      document.file_url = null;
    }
  }));
  return activeDocuments;
};

const hasValidSignature = (file) => {
  const buffer = file?.buffer;
  if (!buffer?.length) return false;
  if (file.mimetype === 'application/pdf') return buffer.subarray(0, 5).toString('latin1') === '%PDF-';
  if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/jpg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (file.mimetype === 'image/png') {
    return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (file.mimetype === 'image/webp') {
    return buffer.subarray(0, 4).toString('latin1') === 'RIFF'
      && buffer.subarray(8, 12).toString('latin1') === 'WEBP';
  }
  return false;
};

const rollupCase = async (caseId) => {
  const { rows } = await pool.query(
    `SELECT id, type, member_document_field, ocr_status
       FROM documents WHERE kyc_case_id = $1
       ORDER BY id ASC`,
    [caseId]
  );
  const activeDocuments = selectActiveDocuments(rows);
  if (!activeDocuments.length) return;
  const nextStatus = activeDocuments.every((document) => document.ocr_status === 'DONE')
    ? 'OCR_DONE'
    : 'OCR_PENDING';
  await pool.query(
    `UPDATE kyc_cases SET status = $1, updated_at = now()
      WHERE id = $2 AND status NOT IN ('VERIFIED', 'REJECTED')`,
    [nextStatus, caseId]
  );
};

const processKycDocument = async (documentId, preloadedBuffer = null) => {
  const document = await getLatestDocumentResult(documentId);
  if (!document || document.type === 'PHOTO') return;
  try {
    await pool.query(
      `UPDATE documents SET ocr_status = 'PROCESSING', ocr_started_at = now(),
              ocr_error = NULL, updated_at = now() WHERE id = $1`,
      [documentId]
    );
    const buffer = preloadedBuffer || await getPlotDocBytes(document.file_path);
    const documentSide = document.member_document_field === 'aadhar_front_url'
      ? 'FRONT'
      : document.member_document_field === 'aadhar_back_url' ? 'BACK' : null;
    const result = await extractMemberKyc(buffer, document.mime_type, document.type, { documentSide });
    const confidenceValues = Object.values(result.confidence || {}).map(Number).filter(Number.isFinite);
    const overallConfidence = confidenceValues.length
      ? confidenceValues.reduce((sum, score) => sum + score, 0) / confidenceValues.length
      : 0;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ocr_results
           (document_id, raw_text, extracted_fields, confidence_overall,
            confidence_map, engine, processed_at)
         VALUES ($1, $2::jsonb, $3::jsonb, $4, $5::jsonb, $6, now())`,
        [
          documentId,
          JSON.stringify({ text: result.rawText || '' }),
          JSON.stringify(result.fields || {}),
          overallConfidence,
          JSON.stringify(result.confidence || {}),
          result.engine,
        ]
      );
      await client.query(
        `UPDATE documents SET ocr_status = 'DONE', ocr_engine = $1,
                ocr_completed_at = now(), ocr_error = NULL, updated_at = now()
          WHERE id = $2`,
        [result.engine, documentId]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(`[accounts kyc] OCR failed for document ${documentId}:`, error?.message || error);
    await pool.query(
      `UPDATE documents SET ocr_status = 'FAILED', ocr_error = $1,
              ocr_completed_at = now(), updated_at = now() WHERE id = $2`,
      [String(error?.message || error).slice(0, 1800), documentId]
    ).catch(() => {});
  } finally {
    await rollupCase(document.kyc_case_id).catch(() => {});
  }
};

/** POST /member-kyc/cases */
export const createCase = asyncHandler(async (req, res) => {
  const siteId = Number.parseInt(req.body.site_id, 10);
  if (!Number.isInteger(siteId)) return res.status(400).json({ message: 'A valid site is required' });
  if (!(await canAccessSite(req.user, siteId))) return res.status(403).json({ message: 'This site is unavailable to your account' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let member;
    let matchedExistingMember = false;
    const requestedMemberId = Number.parseInt(req.body.client_member_id, 10);
    if (Number.isInteger(requestedMemberId)) {
      const { rows } = await client.query(
        'SELECT id, site_id, full_name, phone FROM members WHERE id = $1 FOR SHARE',
        [requestedMemberId]
      );
      member = rows[0];
      if (!member) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: 'Member not found' });
      }
      if (Number(member.site_id) !== siteId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'The member does not belong to the selected site' });
      }
    } else {
      const fullName = String(req.body.full_name || '').trim().toUpperCase();
      const phone = normalisePhone(req.body.phone);
      if (!fullName) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'Customer name is required' });
      }
      if (phone.length < 6) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'A valid mobile number is required' });
      }
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`accounts-member-kyc:${siteId}:${phone}`]
      );
      const { rows: matches } = await client.query(
        `SELECT id, site_id, full_name, phone, created_by FROM members
          WHERE site_id = $1
            AND RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g'), 10) = RIGHT($2, 10)
          ORDER BY id DESC LIMIT 1 FOR SHARE`,
        [siteId, phone]
      );
      member = matches[0];
      matchedExistingMember = Boolean(member);
      if (!member) {
        const { rows } = await client.query(
          `INSERT INTO members
             (site_id, member_type, full_name, phone, status, created_by, created_at, updated_at)
           VALUES ($1, 'CLIENT', $2, $3, 'ACTIVE', $4, now(), now())
           RETURNING id, site_id, full_name, phone`,
          [siteId, fullName, phone, req.user.id]
        );
        member = rows[0];
      }
    }

    // A member-scoped lock serialises Edit, Add-by-phone and retry starts. This
    // closes the empty-result race where two requests could create open cases.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`accounts-member-kyc-member:${member.id}`]
    );

    const { rows: existingCases } = await client.query(
      `SELECT * FROM kyc_cases
        WHERE client_member_id = $1 AND site_id = $2 AND booking_id IS NULL
          AND status NOT IN ('VERIFIED', 'REJECTED')
        ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [member.id, siteId]
    );
    let kycCase = existingCases[0];
    if (matchedExistingMember && !req.clientKycPermissions?.canUpdate
      && (!kycCase || Number(kycCase.created_by) !== Number(req.user.id))) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: 'This mobile number is already registered. Update permission is required to open its KYC.',
      });
    }
    if (kycCase && !req.clientKycPermissions?.canUpdate
      && Number(kycCase.created_by) !== Number(req.user.id)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: 'Another user already owns this open KYC case. Update permission is required.',
      });
    }
    if (!kycCase) {
      const { rows } = await client.query(
        `INSERT INTO kyc_cases
           (booking_id, client_member_id, site_id, mode, status, created_by, created_at, updated_at)
         VALUES (NULL, $1, $2, 'MANUAL_OCR', 'OPEN', $3, now(), now())
         RETURNING *`,
        [member.id, siteId, req.user.id]
      );
      kycCase = rows[0];
    }
    await client.query('COMMIT');
    res.status(201).json({
      ...kycCase,
      client_member_id: member.id,
      client_name: member.full_name,
      client_phone: member.phone,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

/** GET /member-kyc/case/:id */
export const getCase = asyncHandler(async (req, res) => {
  const access = await getAccessibleCase(req.params.id, req.user);
  if (access.missing) return res.status(404).json({ message: 'KYC case not found' });
  if (access.denied) return res.status(403).json({ message: 'This KYC case is unavailable to your account' });
  const documents = await getCaseDocuments(access.kycCase.id);
  res.json({ ...access.kycCase, documents });
});

/** PATCH /member-kyc/case/:id/customer */
export const updateCaseCustomer = asyncHandler(async (req, res) => {
  const access = await getAccessibleCase(req.params.id, req.user);
  if (access.missing) return res.status(404).json({ message: 'KYC case not found' });
  if (access.denied) return res.status(403).json({ message: 'This KYC case is unavailable to your account' });
  const fullName = String(req.body.full_name || '').trim().toUpperCase();
  const phone = normalisePhone(req.body.phone);
  if (!fullName) return res.status(400).json({ message: 'Customer name is required' });
  if (phone.length < 6) return res.status(400).json({ message: 'A valid mobile number is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: lockedCases } = await client.query(
      'SELECT status FROM kyc_cases WHERE id = $1 FOR UPDATE',
      [access.kycCase.id]
    );
    if (!lockedCases[0] || !MUTABLE_CASE_STATUSES.has(lockedCases[0].status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Verified or rejected KYC cases cannot be changed' });
    }
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`accounts-member-kyc:${access.kycCase.site_id}:${phone}`]
    );
    const { rows: duplicateMembers } = await client.query(
      `SELECT id, full_name FROM members
        WHERE site_id = $1 AND id <> $2
          AND RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g'), 10) = RIGHT($3, 10)
        LIMIT 1`,
      [access.kycCase.site_id, access.kycCase.client_member_id, phone]
    );
    if (duplicateMembers[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `This mobile number belongs to ${duplicateMembers[0].full_name}` });
    }
    await client.query(
      'UPDATE members SET full_name = $1, phone = $2, updated_at = now() WHERE id = $3',
      [fullName, phone, access.kycCase.client_member_id]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  res.json({
    message: 'Customer updated',
    client_member_id: access.kycCase.client_member_id,
    client_name: fullName,
    client_phone: phone,
  });
});

/** POST /member-kyc/upload */
export const uploadDocument = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Select a KYC image or PDF' });
  if (!hasValidSignature(req.file)) return res.status(400).json({ message: 'The uploaded file content does not match its image/PDF type' });
  const access = await getAccessibleCase(req.body.kyc_case_id, req.user);
  if (access.missing) return res.status(404).json({ message: 'KYC case not found' });
  if (access.denied) return res.status(403).json({ message: 'This KYC case is unavailable to your account' });

  const type = String(req.body.type || 'OTHER').toUpperCase();
  const allowedFields = DOCUMENT_FIELDS_BY_TYPE[type];
  if (!allowedFields) return res.status(400).json({ message: 'Unsupported KYC document type' });
  if (type === 'PHOTO' && !req.file.mimetype.startsWith('image/')) {
    return res.status(400).json({ message: 'Customer photo must be an image' });
  }
  const requestedField = String(req.body.member_document_field || '').trim();
  if (type === 'AADHAAR' && !allowedFields.includes(requestedField)) {
    return res.status(400).json({ message: 'Choose whether this is the Aadhaar front or back side' });
  }
  const memberField = allowedFields.includes(requestedField) ? requestedField : allowedFields[0];

  if (memberField === 'aadhar_back_url') {
    const { rows } = await pool.query(
      `SELECT id, type, member_document_field, ocr_status
         FROM documents
        WHERE kyc_case_id = $1 AND type = 'AADHAAR'
        ORDER BY id ASC`,
      [access.kycCase.id]
    );
    const activeAadhaar = selectActiveDocuments(rows)
      .filter((document) => document.type === 'AADHAAR');
    const activeFront = activeAadhaar.find(
      (document) => document.member_document_field === 'aadhar_front_url'
    ) || activeAadhaar.find((document) => !document.member_document_field);
    if (activeFront?.ocr_status !== 'DONE') {
      return res.status(400).json({ message: 'Upload and finish the Aadhaar front side first' });
    }
  }

  const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const storageKey = await uploadPlotDoc(
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype,
    'kyc_documents'
  );
  const skipOcr = type === 'PHOTO';
  const client = await pool.connect();
  let document;
  try {
    await client.query('BEGIN');
    const { rows: lockedCases } = await client.query(
      'SELECT status FROM kyc_cases WHERE id = $1 FOR UPDATE',
      [access.kycCase.id]
    );
    if (!lockedCases[0] || !MUTABLE_CASE_STATUSES.has(lockedCases[0].status)) {
      await client.query('ROLLBACK');
      await deletePlotDoc(storageKey).catch(() => {});
      return res.status(409).json({ message: 'Verified or rejected KYC cases cannot accept uploads' });
    }
    const { rows } = await client.query(
      `INSERT INTO documents
         (kyc_case_id, client_member_id, site_id, type, member_document_field,
          original_name, file_path, file_hash, mime_type, file_size, ocr_status,
          ocr_engine, ocr_completed_at, uploaded_source, uploaded_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               'ACCOUNT', $14, now(), now())
       RETURNING *`,
      [
        access.kycCase.id,
        access.kycCase.client_member_id,
        access.kycCase.site_id,
        type,
        memberField,
        req.file.originalname,
        storageKey,
        fileHash,
        req.file.mimetype,
        req.file.size,
        skipOcr ? 'DONE' : 'PENDING',
        skipOcr ? 'none' : null,
        skipOcr ? new Date() : null,
        req.user.id,
      ]
    );
    [document] = rows;
    await client.query(
      `UPDATE kyc_cases SET status = $1, updated_at = now() WHERE id = $2`,
      [skipOcr ? 'OPEN' : 'OCR_PENDING', access.kycCase.id]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    await deletePlotDoc(storageKey).catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  res.status(201).json({
    documentId: document.id,
    ocr_status: document.ocr_status,
    type: document.type,
  });

  if (skipOcr) void rollupCase(access.kycCase.id);
  else void processKycDocument(document.id, req.file.buffer);
});

/** GET /member-kyc/document/:id */
export const getDocument = asyncHandler(async (req, res) => {
  const document = await getLatestDocumentResult(req.params.id);
  if (!document) return res.status(404).json({ message: 'KYC document not found' });
  const access = await getAccessibleCase(document.kyc_case_id, req.user);
  if (access.missing) return res.status(404).json({ message: 'KYC case not found' });
  if (access.denied) return res.status(403).json({ message: 'This KYC document is unavailable to your account' });
  try {
    document.file_url = await getPlotDocUrl(document.file_path);
  } catch {
    document.file_url = null;
  }
  res.json(document);
});

/** POST /member-kyc/document/:id/retry */
export const retryDocument = asyncHandler(async (req, res) => {
  const document = await getLatestDocumentResult(req.params.id);
  if (!document) return res.status(404).json({ message: 'KYC document not found' });
  const access = await getAccessibleCase(document.kyc_case_id, req.user);
  if (access.missing) return res.status(404).json({ message: 'KYC case not found' });
  if (access.denied) return res.status(403).json({ message: 'This KYC document is unavailable to your account' });
  if (document.type === 'PHOTO') return res.json({ documentId: document.id, ocr_status: 'DONE' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: lockedCases } = await client.query(
      'SELECT status FROM kyc_cases WHERE id = $1 FOR UPDATE',
      [document.kyc_case_id]
    );
    if (!lockedCases[0] || !MUTABLE_CASE_STATUSES.has(lockedCases[0].status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Verified or rejected KYC cases cannot be retried' });
    }
    await client.query(
      `UPDATE documents SET ocr_status = 'PENDING', ocr_error = NULL,
              ocr_started_at = NULL, ocr_completed_at = NULL, updated_at = now()
        WHERE id = $1`,
      [document.id]
    );
    await client.query(
      `UPDATE kyc_cases SET status = 'OCR_PENDING', updated_at = now() WHERE id = $1`,
      [document.kyc_case_id]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  res.json({ documentId: document.id, ocr_status: 'PENDING' });
  void processKycDocument(document.id);
});

/** POST /member-kyc/case/:id/extract-preview */
export const extractPreview = asyncHandler(async (req, res) => {
  const access = await getAccessibleCase(req.params.id, req.user);
  if (access.missing) return res.status(404).json({ message: 'KYC case not found' });
  if (access.denied) return res.status(403).json({ message: 'This KYC case is unavailable to your account' });
  const { rows } = await pool.query(
    `SELECT d.id, d.type, d.member_document_field, d.ocr_status,
            r.extracted_fields, r.confidence_map
       FROM documents d
       JOIN LATERAL (
         SELECT extracted_fields, confidence_map FROM ocr_results o
          WHERE o.document_id = d.id ORDER BY o.id DESC LIMIT 1
       ) r ON true
      WHERE d.kyc_case_id = $1
      ORDER BY d.id ASC`,
    [access.kycCase.id]
  );
  const activeDocuments = selectActiveDocuments(rows)
    .filter((document) => document.ocr_status === 'DONE');
  const extracted = {};
  const selectedConfidence = {};
  for (const row of activeDocuments) {
    for (const [field, value] of Object.entries(row.extracted_fields || {})) {
      if (value === null || value === undefined || String(value).trim() === '') continue;
      const score = Number(row.confidence_map?.[field]);
      const confidence = Number.isFinite(score) ? score : 0.5;
      if (selectedConfidence[field] === undefined || confidence >= selectedConfidence[field]) {
        extracted[field] = value;
        selectedConfidence[field] = confidence;
      }
    }
  }
  res.json({
    caseId: access.kycCase.id,
    extracted,
    confidence: selectedConfidence,
    docCount: activeDocuments.length,
  });
});

/** POST /member-kyc/case/:id/verify */
export const verifyCase = asyncHandler(async (req, res) => {
  const access = await getAccessibleCase(req.params.id, req.user);
  if (access.missing) return res.status(404).json({ message: 'KYC case not found' });
  if (access.denied) return res.status(403).json({ message: 'This KYC case is unavailable to your account' });
  const memberUpdate = req.body?.member_update || {};
  const data = {};
  for (const field of MEMBER_UPDATE_FIELDS) {
    if (memberUpdate[field] === undefined || memberUpdate[field] === null) continue;
    let value = typeof memberUpdate[field] === 'string'
      ? memberUpdate[field].trim()
      : memberUpdate[field];
    if (value === '') continue;
    if (UPPERCASE_MEMBER_FIELDS.has(field) && typeof value === 'string') value = value.toUpperCase();
    data[field] = value;
  }
  if (data.gender && !['MALE', 'FEMALE', 'OTHER'].includes(data.gender)) delete data.gender;
  if (data.phone) {
    data.phone = normalisePhone(data.phone);
    if (data.phone.length < 6) return res.status(400).json({ message: 'A valid mobile number is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: lockedCases } = await client.query(
      'SELECT * FROM kyc_cases WHERE id = $1 FOR UPDATE',
      [access.kycCase.id]
    );
    const lockedCase = lockedCases[0];
    if (!lockedCase || !MUTABLE_CASE_STATUSES.has(lockedCase.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'This KYC case is already verified or rejected' });
    }

    const { rows: documentRows } = await client.query(
      `SELECT id, type, member_document_field, ocr_status, file_path
         FROM documents WHERE kyc_case_id = $1 ORDER BY id ASC`,
      [lockedCase.id]
    );
    const activeDocuments = selectActiveDocuments(documentRows);
    const processingDocuments = activeDocuments.filter(
      (document) => ['PENDING', 'PROCESSING'].includes(document.ocr_status)
    );
    if (processingDocuments.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: `Wait for ${processingDocuments.length} document${processingDocuments.length === 1 ? '' : 's'} to finish processing`,
        code: 'OCR_IN_PROGRESS',
        processing_count: processingDocuments.length,
      });
    }
    const aadhaarSides = activeDocuments.filter((document) => document.type === 'AADHAAR');
    const readyCount = aadhaarSides.filter((document) => document.ocr_status === 'DONE').length;
    if (readyCount < 2) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `Aadhaar front and back are compulsory (${readyCount}/2 ready)`,
        code: 'AADHAAR_BOTH_SIDES_REQUIRED',
        ready_count: readyCount,
        required_count: 2,
      });
    }

    const { rows: memberRows } = await client.query(
      'SELECT updated_at FROM members WHERE id = $1 FOR UPDATE',
      [lockedCase.client_member_id]
    );
    if (!memberRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'The linked member no longer exists' });
    }
    const expectedUpdatedAt = req.body?.expected_member_updated_at;
    if (expectedUpdatedAt
      && new Date(expectedUpdatedAt).getTime() !== new Date(memberRows[0].updated_at).getTime()) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: 'This member was edited in another window. Reopen KYC to preserve the newer changes.',
        code: 'MEMBER_CHANGED',
      });
    }

    if (data.phone) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`accounts-member-kyc:${lockedCase.site_id}:${data.phone}`]
      );
      const { rows: duplicateMembers } = await client.query(
        `SELECT id, full_name FROM members
          WHERE site_id = $1 AND id <> $2
            AND RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g'), 10) = RIGHT($3, 10)
          LIMIT 1`,
        [lockedCase.site_id, lockedCase.client_member_id, data.phone]
      );
      if (duplicateMembers[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: `This mobile number belongs to ${duplicateMembers[0].full_name}` });
      }
    }

    const documentUpdates = {};
    for (const document of activeDocuments) {
      if (!MEMBER_DOCUMENT_FIELDS.has(document.member_document_field)) continue;
      const publicUrl = getPlotDocPublicUrl(document.file_path);
      if (publicUrl) documentUpdates[document.member_document_field] = publicUrl;
    }
    const verifiedUpdate = { ...data, ...documentUpdates };
    if (Object.keys(verifiedUpdate).length) {
      const assignments = Object.keys(verifiedUpdate).map((field, index) => `${field} = $${index + 1}`);
      const values = [...Object.values(verifiedUpdate), lockedCase.client_member_id];
      await client.query(
        `UPDATE members SET ${assignments.join(', ')}, updated_at = now()
          WHERE id = $${values.length}`,
        values
      );
    }
    await client.query(
      `UPDATE kyc_cases SET status = 'VERIFIED', verified_by = $1,
              verified_at = now(), updated_at = now() WHERE id = $2`,
      [req.user.id, lockedCase.id]
    );
    if (lockedCase.booking_id) {
      await client.query(
        `UPDATE bookings SET kyc_status = 'VERIFIED',
                status = CASE WHEN status = 'KYC_PENDING' THEN 'KYC_DONE' ELSE status END,
                updated_at = now() WHERE id = $1`,
        [lockedCase.booking_id]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await clearCacheByPrefixes(['members|']);
  res.json({ message: 'KYC verified and member updated', caseId: access.kycCase.id });
});
