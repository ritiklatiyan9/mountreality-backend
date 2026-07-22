import fs from 'fs';
import path from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

/**
 * Firebase Admin — verifies Google Sign-In ID tokens minted by the frontend's
 * Firebase popup (project `defencegardenbooking`, SAME project as the booking app,
 * so one Google account works across both ERPs).
 *
 * The key is loaded from the FIRST source that exists:
 *   1. FIREBASE_SERVICE_ACCOUNT_B64 env var — the key JSON, base64-encoded.
 *      (One env var, no files: the easiest option on Render/hosted platforms.)
 *   2. FIREBASE_SERVICE_ACCOUNT_JSON env var — the raw key JSON.
 *   3. A key file: $FIREBASE_SERVICE_ACCOUNT, secrets/firebase-service-account.json
 *      (local dev), /etc/secrets/... or repo root (Render secret-file mounts).
 * When nothing is found the app still boots — /auth/google then reports 503 and
 * GET /auth/google/status shows configured:false.
 */
let app = null;
let keySource = null;
let initError = null;

const readKeyJson = () => {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    keySource = 'env:FIREBASE_SERVICE_ACCOUNT_B64';
    return Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    keySource = 'env:FIREBASE_SERVICE_ACCOUNT_JSON';
    return process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  }
  // Render mounts secret files at /etc/secrets/<name> and at the service root.
  const candidates = [
    process.env.FIREBASE_SERVICE_ACCOUNT,
    'secrets/firebase-service-account.json',
    '/etc/secrets/firebase-service-account.json',
    'firebase-service-account.json',
  ]
    .filter(Boolean)
    .map((p) => path.resolve(process.cwd(), p));
  const keyPath = candidates.find((p) => fs.existsSync(p));
  if (keyPath) {
    keySource = `file:${keyPath}`;
    return fs.readFileSync(keyPath, 'utf8');
  }
  console.warn('[rgaccount-api] Firebase key not found. No FIREBASE_SERVICE_ACCOUNT_B64/_JSON env var; tried files:', candidates.join(', '));
  return null;
};

try {
  const raw = readKeyJson();
  if (raw) {
    const serviceAccount = JSON.parse(raw);
    app = initializeApp({ credential: cert(serviceAccount) }, 'rgaccount-google-auth');
    console.log(`[rgaccount-api] Firebase Admin ready (project ${serviceAccount.project_id}, source ${keySource})`);
  }
} catch (err) {
  console.error(`[rgaccount-api] Firebase Admin init failed (source ${keySource}):`, err.message);
  initError = err.message;
  app = null;
}

export const firebaseEnabled = () => !!app;

/** Non-secret diagnostics for GET /auth/google/status — says WHICH step failed:
 *  env var not set at all, set but unparseable, or everything fine. */
export const firebaseStatus = () => ({
  configured: !!app,
  source: app ? keySource.split(':')[0] : null,
  env_b64_present: !!process.env.FIREBASE_SERVICE_ACCOUNT_B64,
  env_b64_length: (process.env.FIREBASE_SERVICE_ACCOUNT_B64 || '').length,
  init_error: initError,
});

/** Verify a Firebase ID token → decoded payload (throws on invalid/expired). */
export const verifyFirebaseIdToken = (idToken) => getAuth(app).verifyIdToken(idToken);
