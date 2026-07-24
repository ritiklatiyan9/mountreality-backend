import { cacheGet, cacheSet, cacheEnabled } from '../config/cache.js';
import { getFinanceForecast } from './forecastEngine.service.js';

const FORECAST_CACHE_TTL = 55;

const forecastCacheKey = (siteId, horizonMonths, lookbackMonths) =>
  `dashboard:finance-forecast:${siteId}:${horizonMonths}:${lookbackMonths}`;

/** Shares its cache entry with the financeForecast GraphQL resolver
 * (schema.js) — same key format, same TTL — so a chat turn never forces an
 * extra full recompute on top of the page's own 60s poll. */
export async function getCachedForecastContext(siteId, horizonMonths, lookbackMonths) {
  const key = forecastCacheKey(siteId, horizonMonths, lookbackMonths);
  if (cacheEnabled()) {
    const cached = await cacheGet(key);
    if (cached) return cached;
  }

  const result = await getFinanceForecast(siteId, { horizonMonths, lookbackMonths });
  const payload = {
    ...result,
    sourceMixRevenue: Object.entries(result.sourceMix.revenue).map(([source, amount]) => ({ source, amount })),
    sourceMixExpense: Object.entries(result.sourceMix.expense).map(([source, amount]) => ({ source, amount })),
  };
  if (cacheEnabled()) await cacheSet(key, payload, FORECAST_CACHE_TTL);
  return payload;
}

/** Reduces the full forecast payload to only what the assistant needs —
 * pre-aggregated figures only, never raw transaction rows (there are none
 * in this object anyway). Keeps the prompt small and the AI's numbers
 * traceable back to one source of truth. */
export function buildCompactContext(forecast, selectedScenario) {
  return {
    generatedAt: forecast.generatedAt,
    currentCash: forecast.currentCash,
    expectedTotalInflow: forecast.expectedTotalInflow,
    expectedTotalOutflow: forecast.expectedTotalOutflow,
    netMovement: forecast.netMovement,
    lowestProjectedCash: forecast.lowestProjectedCash,
    firstDeficitMonth: forecast.firstDeficitMonth,
    deficitMonthCount: forecast.deficitMonthCount,
    conservativeCashFloor: forecast.conservativeCashFloor,
    riskLevel: forecast.riskLevel,
    riskSummary: forecast.riskSummary,
    confidenceLevel: forecast.confidenceLevel,
    confidenceScore: forecast.confidenceScore,
    inflowTrendPct: forecast.inflowTrendPct,
    outflowTrendPct: forecast.outflowTrendPct,
    dueItems: forecast.dueItems,
    selectedScenario: selectedScenario || 'base',
    months: (forecast.months || []).map((m) => ({
      key: m.key,
      label: m.label,
      scenarios: {
        conservative: { net: m.scenarios.conservative.net, closingCash: m.scenarios.conservative.projectedClosingCash },
        base: { net: m.scenarios.base.net, closingCash: m.scenarios.base.projectedClosingCash },
        optimistic: { net: m.scenarios.optimistic.net, closingCash: m.scenarios.optimistic.projectedClosingCash },
      },
    })),
  };
}

// ── Deterministic intent detection (never model-decided) ──

const WHATIF_RE = /\b(what[\s-]?if|possibilit(?:y|ies)|scenario)\b/i;
const NEXT_MONTH_RE = /\b(next month|coming month|agla month|agle mahine|aane wale mahine)\b/i;
const IMPROVE_RE = /\b(improve|better|optimi[sz]e|increase (my )?cash|reduce (my )?risk|fix (it|this))\b/i;
const RISK_RE = /\b(risk|biggest (risk|problem|worry)|danger|worst case|exposure)\b/i;

export function detectIntent(message) {
  const text = String(message || '');
  if (WHATIF_RE.test(text)) return 'whatif';
  if (NEXT_MONTH_RE.test(text)) return 'next_month';
  if (IMPROVE_RE.test(text)) return 'improve';
  if (RISK_RE.test(text)) return 'risk';
  return 'general';
}

const AMOUNT_RE = /₹?\s*(\d+(?:\.\d+)?)\s*(crore\b|cr\.?\b|lakh\b|lac\b|l\b|k\b|thousand\b)?/i;

/** Best-effort hint only — never treated as authoritative; used solely to
 * pre-fill the Cash Possibility Lab modal. */
export function parseWhatIfAmount(message) {
  const text = String(message || '');
  const match = text.match(AMOUNT_RE);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] || '').toLowerCase().replace(/\.$/, '');
  if (unit.startsWith('cr')) return value * 1e7;
  if (unit === 'lakh' || unit === 'lac' || unit === 'l') return value * 1e5;
  if (unit === 'k' || unit === 'thousand') return value * 1e3;
  return unit ? value : null; // a bare number with no unit is too ambiguous to act on
}

export function buildActionPayload(intent, context, amount) {
  if (intent !== 'whatif' && intent !== 'next_month') return null;
  return {
    type: 'open_scenario_lab',
    openingCash: context.currentCash,
    suggestedAmount: amount ?? null,
    horizonMonths: context.months?.length || 6,
  };
}

// ── Prompting ──

const SYSTEM_PROMPT = `You are Forecast Copilot, embedded in a real-estate/ERP application, helping a business owner understand their site's cash-flow forecast.
Rules you must always follow:
- Reply in the same language/style the user just wrote in (English, Hindi, or Hinglish).
- Use Indian currency style: ₹, lakh, crore (e.g. ₹12.5 lakh, ₹2.3 crore) — never "million"/"billion".
- Start with a direct one-line answer, then 2-4 short evidence points, then exactly one practical next step.
- Keep the whole reply under 140 words.
- Never use markdown, tables, headings, bullet symbols, or JSON — plain conversational sentences only.
- Clearly distinguish actual/historical cash, projected/forecast cash, known dues, and overdue dues, and say plainly when a figure is uncertain.
- Never invent a transaction, party name, date, or amount that is not present in the JSON context you are given. Never claim you performed an action in the ERP — you cannot.
- The JSON context is your only source of numbers — quote it, never estimate your own.`;

/** Truncates history to the last 8 turns BEFORE prepending the system
 * message, so truncation can never drop it. Restricts roles to user/
 * assistant so a client can't smuggle role:'system' to override this
 * prompt via chat history. */
export function buildMessages(context, history, userMessage) {
  const safeHistory = Array.isArray(history)
    ? history
        .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
        .slice(-8)
        .map((h) => ({ role: h.role, content: h.content.slice(0, 1000) }))
    : [];

  return [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\nCurrent forecast context (JSON, the only source of truth for numbers):\n${JSON.stringify(context)}` },
    ...safeHistory,
    { role: 'user', content: userMessage },
  ];
}

// ── OpenRouter streaming ──

/**
 * Streams an OpenAI-compatible chat completion from OpenRouter, forwarding
 * each token delta via onToken. Throws on any non-2xx response or network
 * error — callers must fall back to the deterministic reply in that case.
 */
export async function streamOpenRouterCompletion({ apiKey, model, baseUrl, messages, signal, onToken }) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, stream: true, temperature: 0.4, max_tokens: 450 }),
    signal,
  });

  if (!response.ok || !response.body) {
    let detail = '';
    try { detail = await response.text(); } catch { /* ignore */ }
    throw new Error(`OpenRouter request failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.startsWith('data: ')) continue; // skip blank lines + OpenRouter's ':' comment/keep-alive lines
      const dataStr = line.slice(6).trim();
      if (dataStr === '[DONE]') return full;
      try {
        const json = JSON.parse(dataStr);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onToken(delta);
        }
      } catch {
        // A malformed/partial line should never happen once terminated by
        // '\n' (OpenRouter puts one full JSON object per line) — ignore defensively.
      }
    }
  }
  return full;
}

// ── Deterministic local fallback (no AI) ──

const fmtINR = (v) => {
  const n = Math.round(Number(v) || 0);
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} crore`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} lakh`;
  return `${sign}₹${abs.toLocaleString('en-IN')}`;
};

const labelizeDueKey = (key) => key.replace(/([A-Z])/g, ' $1').toLowerCase();

/** Template replies built only from the compact context — used when no
 * OPENROUTER_API_KEY is configured, or the upstream call fails before any
 * token reached the client. Deliberately English-only (unlike the AI
 * path): reliably detecting the user's language without a model isn't
 * feasible, and a wrong-language fallback would be worse than a plain one. */
export function getDeterministicFallback(intent, context, amount) {
  if (intent === 'risk') {
    const dues = context.dueItems || {};
    const [worstKey, worstValue] = Object.entries(dues).sort((a, b) => (b[1] || 0) - (a[1] || 0))[0] || [];
    return `Your biggest risk right now is ${context.riskLevel} — ${context.riskSummary} `
      + `Lowest projected cash is ${fmtINR(context.lowestProjectedCash)}${context.firstDeficitMonth ? `, first reached around ${context.firstDeficitMonth}` : ''}. `
      + `${worstValue > 0 ? `The largest known exposure is ${labelizeDueKey(worstKey)} at ${fmtINR(worstValue)}.` : 'No major overdue exposure is pending right now.'} `
      + `Confidence in this forecast is ${context.confidenceLevel}. `
      + `Next step: review the month-by-month table around ${context.firstDeficitMonth || 'the coming months'} and line up collections before then.`;
  }

  if (intent === 'next_month' && context.months?.[0]) {
    const m = context.months[0];
    return `${m.label} is projected to close at ${fmtINR(m.scenarios.base.closingCash)} in the base case (net movement ${fmtINR(m.scenarios.base.net)}). `
      + `Conservative case closes at ${fmtINR(m.scenarios.conservative.closingCash)}, optimistic at ${fmtINR(m.scenarios.optimistic.closingCash)}. `
      + `Overall risk is ${context.riskLevel} with ${context.confidenceLevel} confidence. `
      + `Next step: open the Cash Possibility Lab below to compare all three cases for this month side by side.`;
  }

  if (intent === 'whatif') {
    const extra = amount ? ` adding ${fmtINR(amount)} to today's ${fmtINR(context.currentCash)}` : '';
    return `I can model that${extra || ' as an opening-cash change'} in the Cash Possibility Lab, comparing conservative, base, and optimistic outcomes month by month. `
      + `Right now the base case shows net movement of ${fmtINR(context.netMovement)} over the forecast window, with lowest projected cash at ${fmtINR(context.lowestProjectedCash)}. `
      + `Next step: tap "Open Cash Possibility Lab" below to try the exact numbers.`;
  }

  if (intent === 'improve') {
    const focus = context.outflowTrendPct >= context.inflowTrendPct
      ? 'the outflow trend, which is rising faster than inflow'
      : 'the inflow side, which is growing slower than outflow';
    return `To improve the outcome, focus on ${focus}. `
      + `Current net movement is ${fmtINR(context.netMovement)} with ${context.riskLevel} risk and ${context.confidenceLevel} confidence. `
      + `${context.deficitMonthCount > 0 ? `${context.deficitMonthCount} month(s) are projected to dip into deficit.` : 'No month is currently projected to go into deficit.'} `
      + `Next step: clear overdue receivables first — they convert directly into available cash without waiting for the forecast trend to shift.`;
  }

  return `Current cash is ${fmtINR(context.currentCash)}, with a projected net movement of ${fmtINR(context.netMovement)} and ${context.riskLevel} risk over the forecast window. `
    + `Confidence in this forecast is ${context.confidenceLevel}, based on recent transaction patterns and known dues. `
    + `Next step: ask me about your biggest risk, next month, or try a what-if to dig deeper.`;
}
