import { runDmsOcr } from './dmsOcr.service.js';

const TIMEOUT_MS = Number(process.env.DMS_OCR_TIMEOUT_MS || 120_000);

const FIELD_NAMES = [
  'full_name', 'father_name', 'mother_name', 'spouse_name', 'date_of_birth',
  'gender', 'marital_status', 'nationality', 'religion', 'qualification',
  'occupation', 'company_name', 'phone', 'alt_phone', 'whatsapp', 'email',
  'address', 'city', 'state', 'pincode', 'aadhar_no', 'pan_no', 'voter_id',
  'passport_no', 'driving_license_no', 'gst_no', 'nominee_name',
  'nominee_relation', 'nominee_phone', 'bank_name', 'account_no', 'ifsc_code',
  'branch',
];

const DOC_HINTS = {
  AADHAAR: 'Prioritise name, father or husband name, date of birth, gender, Aadhaar number and address with city/state/pincode.',
  PAN: 'Prioritise full name, father name, date of birth and PAN number.',
  VOTER_ID: 'Prioritise full name, relative name, date of birth, gender, voter ID and address.',
  PASSPORT: 'Prioritise full name, parent/spouse names, date of birth, gender, passport number, nationality and address.',
  DL: 'Prioritise full name, relative name, date of birth, driving licence number and address.',
  CHEQUE: 'Prioritise account holder name, bank name, account number, IFSC code and branch.',
  KYC_FORM: 'Read every filled field, including applicant, contact, address, identity, nominee and bank details.',
  OTHER: 'Read every recognisable KYC field from the document.',
};

const withTimeout = async (fn) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
};

const parseJson = (value = '') => {
  const clean = String(value).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
    throw new Error('OCR completed, but the KYC field response was not valid JSON');
  }
};

const extractionPrompt = (text, documentType, documentSide = null) => `
You extract Indian KYC data from OCR text. Return one JSON object only with this shape:
{"fields":{"full_name":"..."},"confidence":{"full_name":0.95}}

Rules:
- Only use these field keys: ${FIELD_NAMES.join(', ')}.
- Omit a field when the text does not clearly contain it. Never guess or fabricate.
- Confidence is a number from 0 to 1 for every returned field.
- date_of_birth must be YYYY-MM-DD when a complete date is visible.
- gender must be MALE, FEMALE or OTHER; marital_status must be SINGLE, MARRIED, DIVORCED or WIDOWED.
- Keep account, ID and phone numbers as strings. Remove spaces from PAN, IFSC and ID values where appropriate.
- Preserve a readable full address. Do not include labels such as "Address:" in values.
- Indian Aadhaar has 12 digits, PAN follows AAAAA9999A and IFSC generally follows AAAA0XXXXXX.
- ${DOC_HINTS[documentType] || DOC_HINTS.OTHER}
${documentType === 'AADHAAR' && documentSide === 'FRONT' ? '- This is the FRONT side. Prioritise identity fields; do not invent address fields that are not printed.' : ''}
${documentType === 'AADHAAR' && documentSide === 'BACK' ? '- This is the BACK side. Prioritise address, city, state and pincode; retain any clearly printed Aadhaar number.' : ''}

OCR TEXT:
${String(text || '').slice(0, 45_000)}
`;

const callStructuredModel = async (prompt) => {
  const requestedEngine = String(
    process.env.KYC_AI_ENGINE || 'auto'
  ).toLowerCase();
  if (!['auto', 'groq', 'mistral'].includes(requestedEngine)) {
    throw new Error(`Unsupported KYC_AI_ENGINE: ${requestedEngine}`);
  }
  if (requestedEngine === 'groq' && !process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not set for KYC_AI_ENGINE=groq');
  }
  const useGroq = requestedEngine !== 'mistral' && Boolean(process.env.GROQ_API_KEY);
  const url = useGroq
    ? 'https://api.groq.com/openai/v1/chat/completions'
    : 'https://api.mistral.ai/v1/chat/completions';
  const key = useGroq ? process.env.GROQ_API_KEY : process.env.MISTRAL_API_KEY;
  if (!key) throw new Error(useGroq ? 'GROQ_API_KEY is not set' : 'MISTRAL_API_KEY is not set');

  // KYC structuring is intentionally pinned to the requested active text model.
  // This also prevents an old/deprecated vision model left in deployment env
  // from recreating the model_not_found failure that triggered this migration.
  const configuredGroqModel = String(process.env.GROQ_MODEL || '').trim();
  const groqModel = configuredGroqModel === 'llama-3.3-70b-versatile'
    ? configuredGroqModel
    : 'llama-3.3-70b-versatile';
  const model = useGroq
    ? groqModel
    : (process.env.MISTRAL_KYC_MODEL || 'mistral-small-latest');
  const body = {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You are a precise KYC data extraction engine. Output valid JSON only.' },
      { role: 'user', content: prompt },
    ],
  };

  const response = await withTimeout((signal) => fetch(url, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  if (!response.ok) {
    throw new Error(`KYC extraction ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const data = await response.json();
  return {
    payload: parseJson(data.choices?.[0]?.message?.content || ''),
    aiEngine: useGroq ? 'groq-llama-3.3' : 'mistral-ai',
  };
};

const normaliseResult = (payload) => {
  const sourceFields = payload?.fields && typeof payload.fields === 'object' ? payload.fields : {};
  const sourceConfidence = payload?.confidence && typeof payload.confidence === 'object' ? payload.confidence : {};
  const fields = {};
  const confidence = {};

  for (const key of FIELD_NAMES) {
    const raw = sourceFields[key];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    let value = String(raw).trim();
    if (['pan_no', 'ifsc_code', 'aadhar_no', 'voter_id', 'passport_no', 'driving_license_no'].includes(key)) {
      value = value.replace(/\s+/g, '').toUpperCase();
    }
    if (key === 'aadhar_no') {
      value = value.replace(/\D/g, '');
      if (!/^\d{12}$/.test(value)) continue;
    }
    if (key === 'pan_no' && !/^[A-Z]{5}\d{4}[A-Z]$/.test(value)) continue;
    if (key === 'ifsc_code' && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(value)) continue;
    if (['phone', 'alt_phone', 'whatsapp', 'nominee_phone'].includes(key)) {
      value = value.replace(/\D/g, '');
      if (value.length > 10) value = value.slice(-10);
      if (!/^\d{10}$/.test(value)) continue;
    }
    if (key === 'pincode') {
      value = value.replace(/\D/g, '');
      if (!/^\d{6}$/.test(value)) continue;
    }
    if (key === 'date_of_birth') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) continue;
    }
    if (key === 'gender') {
      value = value.toUpperCase();
      if (!['MALE', 'FEMALE', 'OTHER'].includes(value)) continue;
    }
    if (key === 'marital_status') {
      value = value.toUpperCase();
      if (!['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED'].includes(value)) continue;
    }
    if (key === 'email') value = value.toLowerCase();
    fields[key] = value;
    const score = Number(sourceConfidence[key]);
    confidence[key] = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0.75;
  }
  return { fields, confidence };
};

/**
 * OCR a KYC document and turn its text into the member form's canonical fields.
 * The underlying OCR provider remains selected by DMS_OCR_ENGINE, keeping this
 * flow compatible with both Mistral (PDF + images) and Groq (images).
 */
export const extractMemberKycFromText = async (text, documentType = 'OTHER', documentSide = null) => {
  if (!text) throw new Error('No readable text was found in this document');
  const { payload, aiEngine } = await callStructuredModel(extractionPrompt(text, documentType, documentSide));
  return { ...normaliseResult(payload), aiEngine };
};

export const extractMemberKyc = async (buffer, mime, documentType = 'OTHER', { documentSide = null } = {}) => {
  const { text, engine } = await runDmsOcr(buffer, mime);
  if (!text) throw new Error('No readable text was found in this document');
  const result = await extractMemberKycFromText(text, documentType, documentSide);
  return {
    ...result,
    engine: `${engine}+${result.aiEngine}`,
    rawText: text,
    textPreview: text.slice(0, 1200),
  };
};
