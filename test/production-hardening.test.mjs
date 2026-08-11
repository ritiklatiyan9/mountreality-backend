import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const backend = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const frontend = (file) => readFile(new URL(`../../Frontend/${file}`, import.meta.url), 'utf8');

test('access and refresh tokens are bound to active revocable sessions', async () => {
  const [authController, authMiddleware, migration] = await Promise.all([
    backend('src/controllers/auth.controller.js'),
    backend('src/middlewares/auth.middleware.js'),
    backend('src/migrations/103_session_security_hardening.js'),
  ]);
  assert.match(authController, /sessionId[\s\S]*sid:/);
  assert.match(authController, /refresh_token_hash/);
  assert.match(authController, /comparePassword\(refreshToken, session\.refresh_token_hash\)/);
  assert.match(authController, /logout_time=CURRENT_TIMESTAMP[\s\S]*WHERE id=\$1 AND user_id=\$2/);
  assert.match(authMiddleware, /decoded\.sid/);
  assert.match(authMiddleware, /us\.logout_time IS NULL/);
  assert.match(authMiddleware, /decoded\.version !== dbUser\.token_version/);
  assert.match(migration, /refresh_expires_at/);
  assert.match(migration, /app_schema_migrations/);
});

test('chat HTTP and socket access remain organization and participant scoped', async () => {
  const [controller, model, socket] = await Promise.all([
    backend('src/controllers/chat.controller.js'),
    backend('src/models/Conversation.model.js'),
    backend('src/config/socket.js'),
  ]);
  assert.match(controller, /organization_id/);
  assert.match(controller, /user1_id[\s\S]*user2_id/);
  assert.match(model, /organization_id/);
  assert.match(socket, /c\.id=\$1/);
  assert.match(socket, /c\.user1_id=\$2 OR c\.user2_id=\$2/);
  assert.match(socket, /organization_id/);
  assert.match(socket, /logout_time IS NULL/);
});

test('generic uploads are bounded, rate limited, provider constrained and signature checked', async () => {
  const [routes, middleware] = await Promise.all([
    backend('src/routes/upload.routes.js'),
    backend('src/middlewares/multer.middleware.js'),
  ]);
  assert.match(routes, /uploadRateLimit/);
  assert.match(routes, /\['s3', 'cloudinary'\]/);
  assert.match(routes, /validateUploadedFiles/);
  assert.match(middleware, /fileSize: 5 \* 1024 \* 1024/);
  assert.match(middleware, /upload\.array\('files', 10\)/);
  assert.match(middleware, /89504e470d0a1a0a/);
  assert.match(middleware, /%PDF-/);
  assert.match(middleware, /INVALID_FILE_SIGNATURE/);
});

test('billing and financial writes use locks, transactions and idempotency constraints', async () => {
  const [billing, daybook, imprest, financeMigration, inventoryMigration] = await Promise.all([
    backend('src/controllers/billing.controller.js'),
    backend('src/controllers/daybook.controller.js'),
    backend('src/models/Imprest.model.js'),
    backend('src/migrations/104_financial_idempotency_hardening.js'),
    backend('src/migrations/105_inventory_invariants.js'),
  ]);
  assert.match(billing, /pg_advisory_xact_lock/);
  assert.match(billing, /FOR UPDATE/);
  assert.match(billing, /timingSafeEqual/);
  assert.match(billing, /captured/);
  assert.match(daybook, /const atomicWrite/);
  assert.ok((daybook.match(/await atomicWrite\(/g) || []).length >= 12);
  assert.match(imprest, /pg_advisory_xact_lock/);
  assert.match(imprest, /ON CONFLICT DO NOTHING/);
  assert.match(financeMigration, /uq_imprest_source_posting/);
  assert.match(financeMigration, /uq_subscriptions_razorpay_payment/);
  assert.match(inventoryMigration, /uq_inventory_movement_idempotency/);
});

test('frontend printing and navigation hardening remain in the production build', async () => {
  const [safePrint, app, vercel] = await Promise.all([
    frontend('src/lib/safePrint.js'),
    frontend('src/App.jsx'),
    frontend('vercel.json'),
  ]);
  assert.match(safePrint, /DOMPurify\.sanitize/);
  assert.match(safePrint, /FORBID_TAGS/);
  assert.match(safePrint, /targetWindow\.opener = null/);
  assert.doesNotMatch(app, /const lazyPage/);
  assert.match(app, /lazy\(\(\) => import\('\.\/pages\/Dashboard\.jsx'\)\)/);
  assert.match(vercel, /Content-Security-Policy/);
  assert.match(vercel, /frame-ancestors 'none'/);
});
