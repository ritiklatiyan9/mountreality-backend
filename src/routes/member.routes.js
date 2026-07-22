import express from 'express';
const router = express.Router();

import {
  createMember, listMembers, searchMembers, getMemberAutocomplete,
  getMember, updateMember, deleteMember, bulkDeleteMembers, getMemberTransactions, getMemberFinancialInfo,
  extractKycDocument, registerMemberInSites,
} from '../controllers/member.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import upload from '../middlewares/multer.middleware.js';
import multer from 'multer';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const memberReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'members' });
// Autocomplete values (cities/occupations/companies/references) rarely change,
// so they get a longer TTL and a separate namespace so they're NOT busted
// by every member write. The bust prefix below is anchored with `|` so the
// "members-ac" namespace doesn't accidentally match.
const autocompleteCache = cacheResponse({ ttlSeconds: 300, namespace: 'members-ac' });
const bustMemberCache = invalidateCacheOnSuccess(['members|']);
const kycUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const accepted = file.mimetype?.startsWith('image/') || file.mimetype === 'application/pdf';
    cb(accepted ? null : new Error('KYC documents must be an image or PDF'), accepted);
  },
});
const acceptKycUpload = (req, res, next) => {
  kycUpload.single('document')(req, res, (error) => {
    if (!error) return next();
    const isTooLarge = error.code === 'LIMIT_FILE_SIZE';
    return res.status(400).json({ message: isTooLarge ? 'KYC documents must be smaller than 5 MB' : (error.message || 'Invalid KYC document') });
  });
};

router.use(authMiddleware);

// Multi-file upload config for member documents
const memberUpload = upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'aadhar_front_url', maxCount: 1 },
  { name: 'aadhar_back_url', maxCount: 1 },
  { name: 'pan_card_url', maxCount: 1 },
  { name: 'voter_id_url', maxCount: 1 },
  { name: 'passport_url', maxCount: 1 },
  { name: 'driving_license_url', maxCount: 1 },
  { name: 'cheque_url', maxCount: 1 },
  { name: 'other_kyc_url', maxCount: 1 },
  { name: 'resume_url', maxCount: 1 },
  { name: 'marksheet_10th_url', maxCount: 1 },
  { name: 'marksheet_12th_url', maxCount: 1 },
  { name: 'degree_certificate_url', maxCount: 1 },
  { name: 'experience_certificate_url', maxCount: 1 },
  { name: 'offer_letter_url', maxCount: 1 },
  { name: 'other_certificate_url', maxCount: 1 },
]);

// Static routes first
router.get('/search', requireRole('admin', 'sub_admin'), requirePermission('clients', 'read'), memberReadCache, searchMembers);
router.get('/autocomplete', requireRole('admin', 'sub_admin'), requirePermission('clients', 'read'), autocompleteCache, getMemberAutocomplete);
router.post('/kyc/extract', requireRole('admin', 'sub_admin'), requirePermission('clients', 'read'), acceptKycUpload, extractKycDocument);
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('clients', 'read'), memberReadCache, listMembers);

// With file upload for documents
router.post('/', requireRole('admin', 'sub_admin'), memberUpload, requirePermission('clients', 'write'), bustMemberCache, createMember);
router.put('/:id', requireRole('admin', 'sub_admin'), memberUpload, requirePermission('clients', 'update'), bustMemberCache, updateMember);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('clients', 'delete'), bustMemberCache, deleteMember);
router.post('/bulk-delete', requireRole('admin', 'sub_admin'), requirePermission('clients', 'delete'), bustMemberCache, bulkDeleteMembers);
router.post('/:id/register-sites', requireRole('admin', 'sub_admin'), requirePermission('clients', 'write'), bustMemberCache, registerMemberInSites);

// Member transactions
router.get('/:id/transactions', requireRole('admin', 'sub_admin'), requirePermission('clients', 'read'), memberReadCache, getMemberTransactions);
router.get('/:id/financial-info', requireRole('admin', 'sub_admin'), requirePermission('clients', 'read'), memberReadCache, getMemberFinancialInfo);

// Dynamic param last
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('clients', 'read'), memberReadCache, getMember);

export default router;
