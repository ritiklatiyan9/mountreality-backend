import crypto from 'crypto';

/**
 * AES-256-GCM for OAuth tokens at rest. Key comes from CALENDAR_TOKEN_ENC_KEY
 * (32 bytes, hex or base64). Output packs iv + authTag + ciphertext into one
 * base64 string so a token fits in a single TEXT column.
 */
const keyFromEnv = () => {
  const raw = String(process.env.CALENDAR_TOKEN_ENC_KEY || '').trim();
  if (!raw) throw new Error('CALENDAR_TOKEN_ENC_KEY is not set');
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === 32) return b64;
  throw new Error('CALENDAR_TOKEN_ENC_KEY must decode to 32 bytes (hex or base64)');
};

export const encrypt = (text) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromEnv(), iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
};

export const decrypt = (packed) => {
  const buf = Buffer.from(String(packed), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromEnv(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
};
