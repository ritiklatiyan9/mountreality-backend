import asyncHandler from '../utils/asyncHandler.js';
import {
  getCachedForecastContext, buildCompactContext, detectIntent, parseWhatIfAmount,
  buildActionPayload, buildMessages, streamOpenRouterCompletion, getDeterministicFallback,
} from '../services/forecastAssistant.service.js';

const HORIZON_OPTIONS = new Set([3, 6, 12, 18]);
const LOOKBACK_OPTIONS = new Set([3, 6, 12, 24]);
const SCENARIO_OPTIONS = new Set(['conservative', 'base', 'optimistic']);
const HEARTBEAT_MS = 15000;

const clampOption = (value, allowed, fallback) => {
  const n = Number(value);
  return allowed.has(n) ? n : fallback;
};

const sendEvent = (res, event, data) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

let openRouterConfigLogged = false;
const getOpenRouterConfig = () => {
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  if (!openRouterConfigLogged) {
    console.log(`[ForecastAssistant] AI: ${apiKey ? 'OpenRouter configured' : 'fallback-only (no OPENROUTER_API_KEY)'}`);
    openRouterConfigLogged = true;
  }
  return {
    apiKey,
    model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  };
};

export const postForecastAssistant = asyncHandler(async (req, res) => {
  // ── Validate everything before a single header is written ──
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message || message.length > 1000) {
    return res.status(400).json({ message: 'A message between 1 and 1000 characters is required' });
  }

  const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
  const history = rawHistory
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
    .slice(-8)
    .map((h) => ({ role: h.role, content: h.content.slice(0, 1000) }));

  const horizonMonths = clampOption(req.body?.horizonMonths, HORIZON_OPTIONS, 6);
  const lookbackMonths = clampOption(req.body?.lookbackMonths, LOOKBACK_OPTIONS, 6);
  const scenario = SCENARIO_OPTIONS.has(req.body?.scenario) ? req.body.scenario : 'base';
  const siteId = req.forecastSiteId; // set by forecastSiteAccess middleware

  const forecast = await getCachedForecastContext(siteId, horizonMonths, lookbackMonths);
  const context = buildCompactContext(forecast, scenario);
  const intent = detectIntent(message);
  const amount = parseWhatIfAmount(message);
  const action = buildActionPayload(intent, context, amount);

  // ── Everything past this point is SSE — no more normal JSON responses ──
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let closed = false;
  const controller = new AbortController();
  req.on('close', () => {
    closed = true;
    controller.abort();
  });

  sendEvent(res, 'meta', {
    confidenceLevel: context.confidenceLevel,
    riskLevel: context.riskLevel,
    generatedAt: context.generatedAt,
  });
  if (action) sendEvent(res, 'action', action);

  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  const { apiKey, model, baseUrl } = getOpenRouterConfig();
  let tokensSent = false;
  const onToken = (delta) => {
    tokensSent = true;
    if (!closed) sendEvent(res, 'token', { delta });
  };

  try {
    if (apiKey) {
      const messages = buildMessages(context, history, message);
      await streamOpenRouterCompletion({ apiKey, model, baseUrl, messages, signal: controller.signal, onToken });
    } else {
      onToken(getDeterministicFallback(intent, context, amount));
    }
  } catch (err) {
    if (tokensSent) {
      // Already mid-reply — never silently swap content, just stop cleanly.
      clearInterval(heartbeat);
      if (!closed) {
        sendEvent(res, 'error', { message: 'The assistant was interrupted. Please try again.' });
        sendEvent(res, 'done', {});
        res.end();
      }
      return;
    }
    // Nothing streamed yet — degrade to the deterministic fallback so the
    // user still gets a well-formed, useful reply instead of an error.
    if (!closed) onToken(getDeterministicFallback(intent, context, amount));
  }

  clearInterval(heartbeat);
  if (!closed) {
    sendEvent(res, 'done', {});
    res.end();
  }
});
