/**
 * DMS OCR — extract Hindi + English text from scanned legal documents (khatauni, sale deeds,
 * agreements, registry). Engine is pluggable via env `DMS_OCR_ENGINE`:
 *
 *   mistral (default) — Mistral OCR API. Purpose-built OCR, handles PDF *and* images natively in
 *                       ONE call (no page-splitting/preprocessing), strong on Devanagari + mixed
 *                       script. Needs env MISTRAL_API_KEY. Zero extra npm deps (global fetch).
 *   groq              — Groq vision LLM (same engine the booking module uses). Images only here —
 *                       PDF would need pdf→image (sharp/pdf-to-png-converter), which this backend
 *                       doesn't install; use the mistral engine for PDFs. Needs env GROQ_API_KEY.
 *
 * ponytail: the user asked for "Groq vision" but supplied a Mistral key and this backend has none of
 * the Groq PDF-preprocessing deps, while Mistral does PDF+image in one dependency-free call — so
 * Mistral is the default. Flip DMS_OCR_ENGINE=groq (+ a GROQ_API_KEY, images only) to switch.
 *
 * Requires Node 18+ (global fetch).
 */

const ENGINE = (process.env.DMS_OCR_ENGINE || 'mistral').toLowerCase();
const TIMEOUT_MS = Number(process.env.DMS_OCR_TIMEOUT_MS || 120_000);

const isImage = (mime = '') => mime.startsWith('image/');
const isPdf = (mime = '') => mime === 'application/pdf';

const withTimeout = async (fn) => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(t);
  }
};

// ── Mistral OCR ──────────────────────────────────────────────────────────────
const MISTRAL_URL = 'https://api.mistral.ai/v1/ocr';

const runMistral = async (buffer, mime) => {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error('MISTRAL_API_KEY is not set');

  const b64 = buffer.toString('base64');
  // Images → image_url, PDFs → document_url. Both accept a base64 data URI directly.
  const document = isPdf(mime)
    ? { type: 'document_url', document_url: `data:application/pdf;base64,${b64}` }
    : { type: 'image_url', image_url: `data:${mime || 'image/jpeg'};base64,${b64}` };

  const res = await withTimeout((signal) =>
    fetch(MISTRAL_URL, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest', document, include_image_base64: false }),
    })
  );
  if (!res.ok) throw new Error(`Mistral OCR ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = await res.json();
  const text = (data.pages || []).map((p) => p.markdown || p.text || '').join('\n\n').trim();
  return { text, engine: 'mistral-ocr' };
};

// ── Groq vision (images only) ────────────────────────────────────────────────
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const runGroq = async (buffer, mime) => {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY is not set');
  if (!isImage(mime)) throw new Error('Groq engine handles images only — use DMS_OCR_ENGINE=mistral for PDFs');

  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
  const res = await withTimeout((signal) =>
    fetch(GROQ_URL, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b',
        temperature: 0,
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe ALL text in this document exactly as written, preserving Hindi (Devanagari) and English. Output only the raw text, no commentary.' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
      }),
    })
  );
  if (!res.ok) throw new Error(`Groq vision ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  return { text, engine: 'groq-vision' };
};

/**
 * runDmsOcr(buffer, mime, filename) → { text, engine }
 * Only images + PDFs are OCR'd; anything else returns empty text (caller marks it archival).
 */
export const runDmsOcr = async (buffer, mime) => {
  if (!isImage(mime) && !isPdf(mime)) return { text: '', engine: 'none' };
  return ENGINE === 'groq' ? runGroq(buffer, mime) : runMistral(buffer, mime);
};

/** True when the given mime is worth OCR'ing (used to set initial ocr_status). */
export const isOcrable = (mime = '') => isImage(mime) || isPdf(mime);
