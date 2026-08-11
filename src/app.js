import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { createHandler } from 'graphql-http/lib/use/express';
import { schema as graphqlSchema } from './graphql/schema.js';
import pool from './config/db.js';
import { corsOptions, logCorsPolicy } from './config/cors.js';
import authMiddleware from './middlewares/auth.middleware.js';
import errorMiddleware from './middlewares/error.middleware.js';
import crypto from 'crypto';
import { GraphQLError } from 'graphql';
import createRateLimiter from './middlewares/rateLimit.middleware.js';

const app = express();

const graphQLRateLimiter = createRateLimiter({ windowMs: 60_000, max: 120, keyPrefix: 'graphql:' });
const graphQLRequestBounds = (req, res, next) => {
  if (typeof req.body?.query !== 'string' || req.body.query.length > 20_000) {
    return res.status(400).json({ errors: [{ message: 'GraphQL query is missing or too large' }] });
  }
  return next();
};
const boundedGraphQLRule = (context) => {
  let depth = 0;
  let fieldCount = 0;
  let aliasCount = 0;
  let fragmentSpreads = 0;
  let reported = false;
  const rejectIfNeeded = (node) => {
    if (!reported && (depth > 12 || fieldCount > 150 || aliasCount > 30 || fragmentSpreads > 20)) {
      reported = true;
      context.reportError(new GraphQLError('GraphQL query exceeds the allowed complexity', { nodes: node }));
    }
  };
  return {
    Field: {
      enter(node) { depth += 1; fieldCount += 1; if (node.alias) aliasCount += 1; rejectIfNeeded(node); },
      leave() { depth -= 1; },
    },
    FragmentSpread(node) { fragmentSpreads += 1; rejectIfNeeded(node); },
  };
};

logCorsPolicy();

if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
app.use((req, res, next) => {
  const supplied = String(req.get('x-request-id') || '');
  req.requestId = /^[A-Za-z0-9._:-]{8,128}$/.test(supplied) ? supplied : crypto.randomUUID();
  res.set('X-Request-ID', req.requestId);
  next();
});
morgan.token('request-id', (req) => req.requestId);
app.use(morgan(':remote-addr - :method :url :status :res[content-length] :response-time ms request_id=:request-id'));
app.use(cors(corsOptions));
app.use(express.json({
  limit: '2mb',
  // Webhook signatures are calculated over the exact received bytes. Retain
  // them once at the parser boundary; normal controllers continue using body.
  verify: (req, _res, buffer) => {
    if (req.originalUrl.startsWith('/phase4/webhooks/')) req.rawBody = Buffer.from(buffer);
  },
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

import path from 'path';
// Local storage exists only for development. Production requires private object
// storage and never exposes KYC, spreadsheet or member files as static assets.
if (process.env.NODE_ENV !== 'production') {
  app.use('/uploads/excel', express.static(path.join(process.cwd(), 'uploads', 'excel')));
  app.use('/uploads/kyc_documents', express.static(path.join(process.cwd(), 'uploads', 'kyc_documents')));
  app.use('/uploads/members', express.static(path.join(process.cwd(), 'src', 'uploads')));
}

app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not_ready' });
  }
});

// ── GraphQL endpoint (dashboard BFF) ──
app.all(
  '/graphql',
  // Reuse the REST authentication boundary so active-user, token-version and
  // session revocation checks cannot drift between the two APIs.
  authMiddleware,
  graphQLRateLimiter,
  graphQLRequestBounds,
  createHandler({
    schema: graphqlSchema,
    validationRules: [boundedGraphQLRule],
    context: async (req) => {
      const user = req.raw.user;
      const permissionQuery = user.role === 'sub_admin'
        ? pool.query(
          `SELECT module, can_read, can_write, can_update, can_delete
             FROM user_permissions
            WHERE user_id = $1`,
          [user.id]
        )
        : Promise.resolve({ rows: [] });
      const siteQuery = user.role === 'sub_admin'
        ? pool.query(
          `SELECT us.site_id
             FROM user_sites us
             JOIN sites s ON s.id = us.site_id
            WHERE us.user_id = $1 AND s.organization_id = $2`,
          [user.id, user.organization_id],
        )
        : user.organization_id
          ? pool.query('SELECT id AS site_id FROM sites WHERE organization_id = $1', [user.organization_id])
          : Promise.resolve({ rows: [] });

      const [permissionResult, siteResult] = await Promise.all([permissionQuery, siteQuery]);

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

export default app;
