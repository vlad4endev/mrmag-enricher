/**
 * Биллинг шлюзов: AITUNNEL отдаёт ₽ в usage.cost_rub и GET /aitunnel/balance.
 * OpenRouter — usage.cost в USD. Фото ходит только в AITUNNEL.
 */

import fs from 'fs';
import path from 'path';
import { configPath } from './dict.js';

function numOrNull(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function roundMoney(n, digits = 4) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  const p = 10 ** digits;
  return Math.round(x * p) / p;
}

export function isAitunnelProvider(p) {
  const id = String(p?.id || '');
  const url = String(p?.base_url || '');
  return id === 'aitunnel' || /aitunnel/i.test(id) || /aitunnel\.ru/i.test(url);
}

/**
 * Единый вид usage: для AITUNNEL cost_rub и balance из ответа API
 * (см. https://aitunnel.ru/docs/payments).
 * { currency: 'RUB' } — если шлюз не прислал cost_rub, но прислал cost, это рубли.
 */
export function normalizeProviderUsage(raw, { currency = null } = {}) {
  const u = raw && typeof raw === 'object' ? raw : {};
  const prompt = numOrNull(u.prompt_tokens ?? u.input_tokens) ?? 0;
  const completion = numOrNull(u.completion_tokens ?? u.output_tokens) ?? 0;
  const total = numOrNull(u.total_tokens) ?? (prompt + completion);
  const costRubField = numOrNull(u.cost_rub);
  const costField = numOrNull(u.cost);
  const rub = costRubField ?? (currency === 'RUB' ? costField : null);
  const usd = costRubField != null ? null : (currency === 'RUB' ? null : costField);
  const cur = rub != null ? 'RUB' : (usd != null ? 'USD' : (currency || null));
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cost_rub: rub,
    cost: rub ?? usd,
    currency: cur,
    balance: numOrNull(u.balance),
  };
}

export function usageCostRub(usage) {
  if (!usage) return null;
  const n = normalizeProviderUsage(usage);
  return n.cost_rub;
}

function usageFile(root) {
  return path.join(path.dirname(configPath(root)), 'provider_usage.json');
}

export function loadProviderUsage(root) {
  const file = usageFile(root);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { providers: {} };
    return { providers: raw.providers && typeof raw.providers === 'object' ? raw.providers : {} };
  } catch {
    return { providers: {} };
  }
}

function saveProviderUsage(state, root) {
  const file = usageFile(root);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, file);
}

export function recordProviderSpend(providerId, usage, root) {
  const id = String(providerId || '').trim();
  if (!id) return null;
  const n = normalizeProviderUsage(usage, { currency: isAitunnelProvider({ id }) ? 'RUB' : null });
  const cost = n.cost_rub;
  const hasCost = typeof cost === 'number';
  const hasBal = typeof n.balance === 'number';
  if (!hasCost && !hasBal) return n;
  const state = loadProviderUsage(root);
  const row = state.providers[id] && typeof state.providers[id] === 'object'
    ? state.providers[id]
    : { spent_rub: 0 };
  if (hasCost) row.spent_rub = roundMoney((Number(row.spent_rub) || 0) + cost);
  if (hasBal) row.last_balance = n.balance;
  row.updated_at = Date.now();
  state.providers[id] = row;
  saveProviderUsage(state, root);
  return n;
}

export function touchProviderBalance(providerId, { balance, budget } = {}, root) {
  const id = String(providerId || '').trim();
  if (!id) return;
  const state = loadProviderUsage(root);
  const row = state.providers[id] && typeof state.providers[id] === 'object'
    ? state.providers[id]
    : { spent_rub: 0 };
  if (typeof balance === 'number') row.last_balance = balance;
  if (typeof budget === 'number') row.last_budget = budget;
  row.updated_at = Date.now();
  state.providers[id] = row;
  saveProviderUsage(state, root);
}

export function providerSpentRub(providerId, { photos = 0 } = {}, root) {
  const id = String(providerId || '').trim();
  const row = loadProviderUsage(root).providers[id] || {};
  const ledger = Number(row.spent_rub) || 0;
  const fromPhotos = Number(photos) || 0;
  return roundMoney(Math.max(ledger, fromPhotos));
}

export async function fetchAitunnelBalance({
  baseUrl,
  headers = {},
  fetchImpl = fetch,
  timeoutMs = 15_000,
} = {}) {
  const url = `${String(baseUrl || '').replace(/\/+$/, '')}/aitunnel/balance`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { ...(headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* */ }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || data?.message
      || `HTTP ${res.status}: ${String(text).slice(0, 180)}`;
    throw Object.assign(new Error(String(msg)), { status: res.status >= 400 ? res.status : 502 });
  }
  return {
    balance: numOrNull(data?.balance),
    budget: numOrNull(data?.budget),
  };
}
