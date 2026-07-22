import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { createHandler } from 'graphql-http/lib/use/express';
import { schema as graphqlSchema } from './graphql/schema.js';
import pool from './config/db.js';
import authMiddleware from './middlewares/auth.middleware.js';
import errorMiddleware from './middlewares/error.middleware.js';

const app = express();

app.use(helmet());
app.use(morgan('combined'));
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

import path from 'path';
// Serve fallback local excel files if AWS S3 isn't configured
app.use('/uploads/excel', express.static(path.join(process.cwd(), 'uploads', 'excel')));
// Serve fallback local plot/KYC documents if AWS S3 isn't configured (dev only)
app.use('/uploads/kyc_documents', express.static(path.join(process.cwd(), 'uploads', 'kyc_documents')));

// ── GraphQL endpoint (dashboard BFF) ──
app.all(
  '/graphql',
  // Reuse the REST authentication boundary so active-user, token-version and
  // session revocation checks cannot drift between the two APIs.
  authMiddleware,
  createHandler({
    schema: graphqlSchema,
    context: async (req) => {
      const user = req.raw.user;
      if (user.role !== 'sub_admin') {
        return { user, permissions: new Map(), siteIds: new Set() };
      }

      const [permissionResult, siteResult] = await Promise.all([
        pool.query(
          `SELECT module, can_read, can_write, can_update, can_delete
             FROM user_permissions
            WHERE user_id = $1`,
          [user.id]
        ),
        pool.query('SELECT site_id FROM user_sites WHERE user_id = $1', [user.id]),
      ]);

      return {
        user,
        permissions: new Map(permissionResult.rows.map((row) => [row.module, row])),
        siteIds: new Set(siteResult.rows.map((row) => Number(row.site_id))),
      };
    },
  })
);

// routes
import indexRoutes from './routes/index.js';
app.use('/', indexRoutes);

// error middleware
app.use(errorMiddleware);

// ── Keep-alive: ping backends every 12 minutes so they don't sleep ──
const KEEP_ALIVE_URLS = [
  'https://cropland-crm-backend.onrender.com',
  'https://diwan-city-backend.onrender.com',
  'https://prithivi-backend.onrender.com',
  'https://makeandman.onrender.com',
];
const KEEP_ALIVE_INTERVAL_MS = 12 * 60 * 1000;

setInterval(async () => {
  for (const url of KEEP_ALIVE_URLS) {
    try {
      const res = await fetch(url, { method: 'GET' });
      console.log(`[keep-alive] pinged ${url} -> ${res.status}`);
    } catch (err) {
      console.error(`[keep-alive] ping failed for ${url}: ${err.message}`);
    }
  }
}, KEEP_ALIVE_INTERVAL_MS);

export default app;
