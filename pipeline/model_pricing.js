/**
 * Тарифы моделей для калькулятора и /api/models.
 *
 * OpenRouter кладёт в pricing.prompt / completion доллары за токен.
 * Публичный каталог AITUNNEL — prompt_cost / completion_cost в ₽ за 1M
 * (https://aitunnel.ru/docs/models). DeepSeek и Yandex /models цен не отдают —
 * для них запас из официальных прайсов, помечается pricing_source: 'fallback'.
 */

import { isAitunnelProvider } from './provider_billing.js';

function isYandexProvider(p) {
  if (!p) return false;
  if (p.id === 'yandex') return true;
  return /(?:^|[./])(?:ai|llm)\.api\.cloud\.yandex\.net/i.test(String(p.base_url || ''));
}

const AITUNNEL_CATALOG_URL = 'https://api.aitunnel.ru/public/aitunnel/models/chat';

function numOrNull(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function round6(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 1e12) / 1e12;
}

function normId(id) {
  return String(id || '').toLowerCase().trim();
}

/**
 * Запас, когда каталог провайдера не прислал цену.
 * DeepSeek: peak, cache miss, $/1M — с 14.09.2026 deepseek-v4-pro идёт в Flash.
 * Yandex: синхронный режим, ₽/1M (= ₽ за 1K × 1000).
 */
const FALLBACK_USD_PER_1M = [
  { test: id => /^(deepseek-flash|deepseek-v4-flash)/.test(id), prompt: 0.30, completion: 1.20 },
  { test: id => /^deepseek-v4-pro/.test(id), prompt: 0.30, completion: 1.20 },
  { test: id => /^deepseek-chat/.test(id), prompt: 0.28, completion: 0.42 },
  { test: id => /^deepseek-reasoner/.test(id), prompt: 0.28, completion: 0.42 },
];

const FALLBACK_RUB_PER_1M = [
  { test: id => /yandexgpt-lite/.test(id), prompt: 200, completion: 200 },
  { test: id => /aliceai-llm/.test(id) && /flash/.test(id), prompt: 100, completion: 200 },
  { test: id => /aliceai-llm/.test(id), prompt: 500, completion: 1200 },
  { test: id => /yandexgpt/.test(id), prompt: 800, completion: 800 },
  { test: id => /qwen3-235b/.test(id), prompt: 500, completion: 500 },
  { test: id => /gpt-oss-120b/.test(id), prompt: 300, completion: 300 },
  { test: id => /gpt-oss-20b/.test(id), prompt: 100, completion: 100 },
];

function usdPerTokenFrom1M(per1m) {
  return { prompt: round6(per1m.prompt / 1e6), completion: round6(per1m.completion / 1e6) };
}

function rubPer1MFromUsdToken(pricing, rubPerUsd) {
  const rate = Number(rubPerUsd) > 0 ? Number(rubPerUsd) : 80;
  return {
    prompt: round6((parseFloat(pricing.prompt) || 0) * 1e6 * rate),
    completion: round6((parseFloat(pricing.completion) || 0) * 1e6 * rate),
  };
}

function usdTokenFromRub1M(rub, rubPerUsd) {
  const rate = Number(rubPerUsd) > 0 ? Number(rubPerUsd) : 80;
  return {
    prompt: round6((rub.prompt / rate) / 1e6),
    completion: round6((rub.completion / rate) / 1e6),
  };
}

function packUsd({ prompt, completion }, source, rubPerUsd) {
  const pricing = { prompt: round6(prompt), completion: round6(completion) };
  return {
    pricing,
    pricing_rub: rubPer1MFromUsdToken(pricing, rubPerUsd),
    pricing_source: source,
    pricing_currency: 'USD',
  };
}

function packRub({ prompt, completion }, source, rubPerUsd) {
  const pricing_rub = { prompt: round6(prompt), completion: round6(completion) };
  return {
    pricing: usdTokenFromRub1M(pricing_rub, rubPerUsd),
    pricing_rub,
    pricing_source: source,
    pricing_currency: 'RUB',
  };
}

/** Разобрать цену из ответа /models или публичного каталога AITUNNEL. */
export function extractCatalogPricing(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const promptCost = numOrNull(raw.prompt_cost);
  const completionCost = numOrNull(raw.completion_cost);
  if (promptCost != null || completionCost != null) {
    return { kind: 'rub_1m', prompt: promptCost || 0, completion: completionCost || 0 };
  }
  const p = raw.pricing && typeof raw.pricing === 'object' ? raw.pricing : null;
  if (!p) return null;
  const prompt = numOrNull(p.prompt);
  const completion = numOrNull(p.completion);
  if (prompt == null && completion == null) return null;
  return { kind: 'usd_token', prompt: prompt || 0, completion: completion || 0 };
}

export function fallbackPricing(provider, modelId, rubPerUsd) {
  const id = normId(modelId);
  const pid = String(provider?.id || '').toLowerCase();
  const url = String(provider?.base_url || '');
  if (pid === 'ollama' || /11434/.test(url) || /localhost|127\.0\.0\.1/.test(url)) {
    return packUsd({ prompt: 0, completion: 0 }, 'local', rubPerUsd);
  }
  if (pid === 'deepseek' || /deepseek\.com/i.test(url)) {
    const hit = FALLBACK_USD_PER_1M.find(x => x.test(id));
    if (hit) return packUsd({ prompt: hit.prompt, completion: hit.completion }, 'fallback', rubPerUsd);
  }
  if (isYandexProvider(provider)) {
    const hit = FALLBACK_RUB_PER_1M.find(x => x.test(id));
    if (hit) return packRub({ prompt: hit.prompt, completion: hit.completion }, 'fallback', rubPerUsd);
  }
  return null;
}

/**
 * Навесить тариф: сначала из каталога (или уже лежащего pricing), иначе запас.
 * Не затирает живую цену запасом.
 */
export function decorateModelPricing(model, provider, { rubPerUsd, catalogRow } = {}) {
  const live = extractCatalogPricing(catalogRow) || extractCatalogPricing(model);
  let pack = null;
  if (live?.kind === 'rub_1m') pack = packRub(live, 'catalog', rubPerUsd);
  else if (live?.kind === 'usd_token') pack = packUsd(live, 'catalog', rubPerUsd);
  if (!pack) pack = fallbackPricing(provider, model?.id, rubPerUsd);
  if (!pack) {
    return {
      ...model,
      pricing: model?.pricing || null,
      pricing_rub: null,
      pricing_source: model?.pricing ? 'catalog' : null,
      pricing_currency: null,
    };
  }
  return { ...model, ...pack };
}

export function decorateModels(list, provider, { rubPerUsd, catalog } = {}) {
  return (list || []).map(m => {
    const row = catalog && m?.id ? catalog[m.id] || catalog[normId(m.id)] : null;
    return decorateModelPricing(m, provider, { rubPerUsd, catalogRow: row });
  });
}

/** Публичный каталог AITUNNEL без ключа. Сбой — null, карточки всё равно остаются. */
export async function fetchAitunnelPublicCatalog({
  fetchImpl = fetch,
  timeoutMs = 12_000,
} = {}) {
  try {
    const r = await fetchImpl(AITUNNEL_CATALOG_URL, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    if (!r.ok) return null;
    const data = JSON.parse(text);
    const map = data?.chat && typeof data.chat === 'object' ? data.chat : data;
    if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
    return map;
  } catch {
    return null;
  }
}

export function providerWantsAitunnelCatalog(p) {
  return isAitunnelProvider(p);
}

export { AITUNNEL_CATALOG_URL, usdPerTokenFrom1M };
