import express from 'express';
import multer from 'multer';
import path from 'path';
const router = express.Router();

import {
  createRegistry, listRegistries, getRegistry, updateRegistry, deleteRegistry,
  createRegistryPayment, listRegistryPayments, getRegistryPayment, updateRegistryPayment, deleteRegistryPayment,
  getRegistryAutocomplete, getRegistryNoc, saveRegistryNoc, approveRegistryNoc,
  getRegistryPlotClearance, listRegistryHandovers, createRegistryHandover,
} from '../controllers/registry.controller.js';
import {
  listRegistryDocumentPlots,
  getRegistryDocuments,
  uploadRegistryDocument,
  deleteRegistryDocument,
} from '../controllers/registryDocument.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import requireRegistrySiteAccess from '../middlewares/registrySiteAccess.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const registryReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'registries' });
// Autocomplete (member names, firms, plot options, recent bank/cheque payments)
// is the heaviest single endpoint AND changes rarely — long-TTL meta cache
// that survives registry/payment writes.
const registryMetaCache = cacheResponse({ ttlSeconds: 300, namespace: 'registries-meta' });
// Anchored prefix so 'registries-meta|...' isn't busted by writes.
const bustRegistryCache = invalidateCacheOnSuccess(['registries|']);

const accessByQuerySite = requireRegistrySiteAccess({ entity: 'site', source: 'query', key: 'site_id' });
const accessByBodySite = requireRegistrySiteAccess({ entity: 'site', source: 'body', key: 'site_id' });
const accessByParamRegistry = requireRegistrySiteAccess({ entity: 'registry', source: 'params', key: 'id' });
const accessByQueryRegistry = requireRegistrySiteAccess({ entity: 'registry', source: 'query', key: 'registry_id' });
const accessByBodyRegistry = requireRegistrySiteAccess({ entity: 'registry', source: 'body', key: 'registry_id' });
const accessByParamPayment = requireRegistrySiteAccess({ entity: 'payment', source: 'params', key: 'id' });
const accessByQueryPlot = requireRegistrySiteAccess({ entity: 'plot', source: 'query', key: 'plot_id' });
const accessByBodyPlot = requireRegistrySiteAccess({ entity: 'plot', source: 'body', key: 'plot_id' });
const accessByParamDocumentPlot = requireRegistrySiteAccess({ entity: 'plot', source: 'params', key: 'plotId' });
const accessByBodySourcePlotPayment = requireRegistrySiteAccess({ entity: 'plotPayment', source: 'body', key: 'source_plot_payment_id' });

const registryDocumentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    const mimeByExtension = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    const expectedMime = mimeByExtension[extension];
    if (expectedMime && (mime === expectedMime || mime === 'application/octet-stream')) return cb(null, true);
    return cb(new Error('Use a PDF, Word, JPG, PNG, or WEBP file'));
  },
});

const receiveRegistryDocument = (req, res, next) => {
  registryDocumentUpload.single('file')(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'The file is larger than the 25 MB limit' });
    }
    return res.status(400).json({ message: error.message || 'The upload could not be read' });
  });
};

// All registry routes require auth
router.use(authMiddleware);

// ── Registry-owned documents ──
// These endpoints intentionally use plot_registry permissions. The generic
// /plot-documents API remains scoped to plot_payments and other categories.
router.get('/documents/plots', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), accessByQuerySite, listRegistryDocumentPlots);
router.get('/documents/plot/:plotId', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), accessByParamDocumentPlot, getRegistryDocuments);
// Resolve site access before Multer buffers the file in memory.
router.post('/documents/plot/:plotId', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'write'), accessByParamDocumentPlot, receiveRegistryDocument, bustRegistryCache, uploadRegistryDocument);
router.delete('/documents/:docId', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'delete'), bustRegistryCache, deleteRegistryDocument);

// ── Registry Payment endpoints (BEFORE /:id to avoid route conflict) ──
router.get('/payments/list', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), accessByQueryRegistry, registryReadCache, listRegistryPayments);                        // ?registry_id=X
router.get('/payments/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), accessByParamPayment, registryReadCache, getRegistryPayment);
router.post('/payments', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'write'), accessByBodyRegistry, accessByBodySourcePlotPayment, bustRegistryCache, createRegistryPayment);
router.put('/payments/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'update'), accessByParamPayment, bustRegistryCache, updateRegistryPayment);
router.delete('/payments/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'delete'), accessByParamPayment, bustRegistryCache, deleteRegistryPayment);

// ── Payments-clear check (create-registry form) — BEFORE /:id ──
router.get('/plot-clearance', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), accessByQueryPlot, getRegistryPlotClearance);

// ── Document handover timeline ──
router.get('/:id/handovers', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), accessByParamRegistry, registryReadCache, listRegistryHandovers);
router.post('/:id/handovers', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'write'), accessByParamRegistry, bustRegistryCache, createRegistryHandover);

// ── NOC endpoints ──
router.get('/:id/noc', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), accessByParamRegistry, registryReadCache, getRegistryNoc);
router.put('/:id/noc', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'update'), accessByParamRegistry, bustRegistryCache, saveRegistryNoc);
router.put('/:id/noc/approve', requireRole('admin'), requirePermission('plot_registry', 'update'), accessByParamRegistry, bustRegistryCache, approveRegistryNoc);

// ── Registry endpoints ──
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), accessByQuerySite, registryReadCache, listRegistries);                                           // ?site_id=X
router.get('/autocomplete', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), accessByQuerySite, registryMetaCache, getRegistryAutocomplete);                      // ?site_id=X
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), accessByParamRegistry, registryReadCache, getRegistry);
router.post('/', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'write'), accessByBodySite, accessByBodyPlot, bustRegistryCache, createRegistry);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'update'), accessByParamRegistry, accessByBodyPlot, bustRegistryCache, updateRegistry);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'delete'), accessByParamRegistry, bustRegistryCache, deleteRegistry);

export default router;
