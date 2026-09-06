/**
 * Отдельный category-level проход нормализации значений фасетов.
 * Состав фильтров — только schema (facet.enabled). ИИ (или эвристика) клеит
 * сырые attrs к канонам value_aliases; buildFilters пишет filters_*.json.
 */

import { aliasValue, displayEnum, hasStrictEnum, looksLikeEnumFragment, unifyEnumValues, valueFold } from './types.js';
import { facetKind, filterSourceAllowed } from './facets.js';

const BARE_BOOL = /^(?:нет|да|есть|имеется|yes|no)$/i;

/** Фасеты, где агент склеивает строки (range — бакеты из schema, boolean — true/false). */
function agentFacetAttrs(dict) {
  return (dict?.attrs || []).filter(a => {
    if (!a?.facet?.enabled || a.tier === 'X') return false;
    const kind = facetKind(a);
    if (kind === 'range' || kind === 'boolean') return false;
    return a.type === 'enum' || a.type === 'text' || a.type === 'class_scale' || !a.type;
  });
}

function valueList(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v.filter(x => x != null && x !== '') : [v];
}

/**
 * Уникальные сырые значения по facet.enabled enum/text (+ частоты).
 * Только графа характеристик (S0/S1/S2) — S3/model не попадают в inventory.
 */
export function collectFacetValueInventory(recs, dict, config = {}) {
  const out = [];
  for (const attr of agentFacetAttrs(dict)) {
    const counts = new Map();
    for (const rec of recs || []) {
      if (!filterSourceAllowed(rec, attr.code, config)) continue;
      for (const v of valueList(rec.attrs?.[attr.code])) {
        const raw = typeof v === 'string' ? v : String(v);
        if (!raw.trim()) continue;
        counts.set(raw, (counts.get(raw) || 0) + 1);
      }
    }
    if (!counts.size) continue;
    const canons = hasStrictEnum(attr) ? Object.keys(attr.value_aliases) : [];
    out.push({
      attr_code: attr.code,
      name: attr.facet?.label || attr.name,
      type: attr.type,
      canons,
      values: [...counts]
        .map(([raw, count]) => ({ raw, count }))
        .sort((a, b) => b.count - a.count || a.raw.localeCompare(b.raw, 'ru')),
    });
  }
  return out;
}

/** System-промпт: schema SoT, только map→канон или skip. */
export function buildFiltersAgentPrompt(dict, inventory, { categoryName = '', catId = '' } = {}) {
  const facets = (inventory || []).map(f => ({
    attr_code: f.attr_code,
    name: f.name,
    canons: f.canons,
  }));
  return `Ты нормализуешь значения фасетов интернет-магазина перед записью filters_{id}.json.

Категория: ${categoryName || catId || 'не указана'} (id=${catId || '—'})

ПРАВИЛА:
1. Состав фильтров задан schema — НЕ предлагай новые фасеты и НЕ меняй имена.
2. Входные raw уже только из графы характеристик карточки (annotation/S1, при пустой — description/S2). Не выдумывай значения.
3. Для каждого raw-значения: action=map + canon из списка canons этого attr_code, либо action=skip.
4. Мусор («Зоны свежести - нет», «Освещения - …», хвосты « - нет/да», «[object Object]») → skip.
5. Голые «нет»/«да»/«есть» в enum → skip.
6. Единый стиль: одно написание канона на весь каталог (как в canons).
7. Если canons пуст — только skip для фрагментов; иначе оставь без map (не выдумывай канон).
8. Ответь ТОЛЬКО JSON-объектом, без markdown.

ФАСЕТЫ (допустимые attr_code и canons):
${JSON.stringify(facets, null, 2)}

ФОРМАТ ОТВЕТА:
{
  "mappings": [
    { "attr_code": "fridge_type", "raw": "…", "canon": "Двухкамерный", "action": "map" },
    { "attr_code": "fridge_type", "raw": "Зоны свежести - нет", "canon": null, "action": "skip" }
  ],
  "notes": []
}`;
}

export function buildFiltersAgentUserContent(inventory) {
  const slim = (inventory || []).map(f => ({
    attr_code: f.attr_code,
    name: f.name,
    values: f.values.slice(0, 80),
  }));
  return `Нормализуй значения фасетов по всем товарам категории:\n${JSON.stringify(slim, null, 2)}`;
}

function allowedCanons(attr) {
  if (!hasStrictEnum(attr)) return null;
  return new Set(Object.keys(attr.value_aliases).map(k => valueFold(k)));
}

/**
 * Жёсткий парсер ответа модели. Неизвестный code / канон вне aliases → отброс.
 */
export function parseFiltersAgentResponse(raw, dict) {
  let data = raw;
  if (typeof raw === 'string') {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('filters_agent: ответ модели не JSON');
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('filters_agent: ожидался объект { mappings }');
  }
  const list = Array.isArray(data.mappings) ? data.mappings : [];
  const byCode = dict?.byCode || new Map((dict?.attrs || []).map(a => [a.code, a]));
  const mappings = [];
  const rejected = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const attr_code = String(item.attr_code || '').trim();
    const rawVal = item.raw == null ? '' : String(item.raw);
    const action = item.action === 'skip' ? 'skip' : 'map';
    const attr = byCode.get(attr_code);
    if (!attr || !attr.facet?.enabled || attr.tier === 'X') {
      rejected.push({ attr_code, raw: rawVal, reason: 'unknown_attr' });
      continue;
    }
    if (facetKind(attr) === 'range' || facetKind(attr) === 'boolean') {
      rejected.push({ attr_code, raw: rawVal, reason: 'not_enum_facet' });
      continue;
    }
    if (action === 'skip') {
      mappings.push({ attr_code, raw: rawVal, canon: null, action: 'skip' });
      continue;
    }
    let canon = item.canon == null ? null : String(item.canon).trim();
    if (!canon) {
      rejected.push({ attr_code, raw: rawVal, reason: 'empty_canon' });
      continue;
    }
    if (looksLikeEnumFragment(canon) || BARE_BOOL.test(canon)) {
      rejected.push({ attr_code, raw: rawVal, reason: 'garbage_canon', canon });
      continue;
    }
    const allowed = allowedCanons(attr);
    if (allowed) {
      const hit = [...Object.keys(attr.value_aliases)].find(k => valueFold(k) === valueFold(canon));
      if (!hit) {
        rejected.push({ attr_code, raw: rawVal, reason: 'canon_not_in_aliases', canon });
        continue;
      }
      canon = hit;
    }
    mappings.push({ attr_code, raw: rawVal, canon, action: 'map' });
  }

  return {
    mappings,
    rejected,
    notes: Array.isArray(data.notes) ? data.notes.map(String) : [],
  };
}

/** Эвристика без LLM: aliasValue / fragment → map|skip. */
export function heuristicFiltersMappings(recs, dict, config = {}) {
  const inventory = collectFacetValueInventory(recs, dict, config);
  const byCode = dict.byCode || new Map(dict.attrs.map(a => [a.code, a]));
  const mappings = [];
  for (const facet of inventory) {
    const attr = byCode.get(facet.attr_code);
    if (!attr) continue;
    for (const { raw } of facet.values) {
      if (looksLikeEnumFragment(raw) || BARE_BOOL.test(String(raw).trim())) {
        mappings.push({ attr_code: attr.code, raw, canon: null, action: 'skip' });
        continue;
      }
      const aliased = aliasValue(attr, raw);
      if (aliased) {
        const shown = displayEnum(aliased) || aliased;
        if (valueFold(shown) !== valueFold(raw) || raw !== aliased) {
          mappings.push({ attr_code: attr.code, raw, canon: aliased, action: 'map' });
        }
        continue;
      }
      if (hasStrictEnum(attr)) {
        mappings.push({ attr_code: attr.code, raw, canon: null, action: 'skip' });
      }
    }
  }
  return mappings;
}

/**
 * Применить mappings к rec.attrs. skip → null; map → канон.
 * Сопоставление по точному raw (и fold-fallback).
 */
export function applyFiltersAgentMappings(recs, mappings) {
  if (!recs?.length || !mappings?.length) return { applied: 0, skipped: 0 };

  const byAttr = new Map();
  for (const m of mappings) {
    if (!byAttr.has(m.attr_code)) byAttr.set(m.attr_code, []);
    byAttr.get(m.attr_code).push(m);
  }

  let applied = 0;
  let skipped = 0;

  for (const rec of recs) {
    if (!rec.attrs) continue;
    for (const [code, list] of byAttr) {
      const cur = rec.attrs[code];
      if (cur == null || cur === '') continue;

      const mapOne = (v) => {
        const s = typeof v === 'string' ? v : String(v);
        let hit = list.find(m => m.raw === s);
        if (!hit) {
          const fold = valueFold(s);
          hit = list.find(m => valueFold(m.raw) === fold);
        }
        if (!hit) return { v, changed: false };
        if (hit.action === 'skip') {
          skipped++;
          return { v: null, changed: true };
        }
        applied++;
        return { v: hit.canon, changed: true };
      };

      if (Array.isArray(cur)) {
        const next = [];
        const seen = new Set();
        let changed = false;
        for (const x of cur) {
          const r = mapOne(x);
          if (r.changed) changed = true;
          if (r.v == null || r.v === '') continue;
          const k = valueFold(r.v);
          if (seen.has(k)) continue;
          seen.add(k);
          next.push(r.v);
        }
        if (changed) rec.attrs[code] = next.length ? next : null;
      } else {
        const r = mapOne(cur);
        if (r.changed) rec.attrs[code] = r.v;
      }
    }
  }
  return { applied, skipped };
}

/** Проверка готового { filters: [{name,value}] }: нет фрагментов и голых нет/да в enum. */
export function assertFiltersClean(filters, dict) {
  const errors = [];
  const byName = new Map();
  for (const a of dict?.attrs || []) {
    if (!a.facet?.enabled || a.tier === 'X') continue;
    byName.set(a.facet.label || a.name, a);
  }
  for (const f of filters || []) {
    const attr = byName.get(f.name);
    const kind = attr ? facetKind(attr) : null;
    if (kind === 'range' || kind === 'boolean') continue;
    for (const v of f.value || []) {
      const s = String(v);
      if (looksLikeEnumFragment(s) || BARE_BOOL.test(s)) {
        errors.push({ name: f.name, value: s, kind: 'dirty_filter_value' });
      }
      if (attr && hasStrictEnum(attr)) {
        const ok = Object.keys(attr.value_aliases).some(k => valueFold(k) === valueFold(s));
        if (!ok) errors.push({ name: f.name, value: s, kind: 'filter_not_in_aliases' });
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Category-level проход: inventory → AI|heuristic → apply → unifyEnumValues.
 * @returns {{ mode, mappings, rejected, notes, stats, inventory }}
 */
export async function runFiltersAgent({
  recs,
  dict,
  config = {},
  provider = null,
  fetchImpl = globalThis.fetch,
  mode = 'auto', // auto | ai | heuristic
  model = '',
  timeoutMs = 90_000,
  maxTokens = 4000,
  categoryName = '',
  catId = '',
} = {}) {
  const inventory = collectFacetValueInventory(recs, dict, config);
  if (!inventory.length) {
    unifyEnumValues(recs, dict);
    return {
      mode: 'skip',
      mappings: [],
      rejected: [],
      notes: ['нет enum-фасетов со значениями из характеристик'],
      stats: { applied: 0, skipped: 0 },
      inventory,
    };
  }

  const wantAi = mode === 'ai' || (mode === 'auto' && provider?.apiKey);
  let mappings = [];
  let rejected = [];
  let notes = [];
  let usedMode = 'heuristic';

  if (wantAi && provider?.apiKey && typeof fetchImpl === 'function') {
    const system = buildFiltersAgentPrompt(dict, inventory, { categoryName, catId: catId || dict.catId });
    const user = buildFiltersAgentUserContent(inventory);
    const chatUrl = provider.chatUrl
      || `${String(provider.baseUrl || '').replace(/\/$/, '')}/chat/completions`;
    try {
      const resHttp = await fetchImpl(chatUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
          ...(provider.headers || {}),
        },
        body: JSON.stringify({
          model: model || provider.model || 'deepseek/deepseek-v3.2',
          max_tokens: Math.min(8000, maxTokens),
          temperature: 0.1,
          response_format: { type: 'json_object' },
          usage: { include: true },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const bodyText = await resHttp.text();
      let data;
      try { data = JSON.parse(bodyText); } catch { data = null; }
      if (!resHttp.ok || data?.error) {
        throw new Error(data?.error?.message || `HTTP ${resHttp.status}`);
      }
      const content = data?.choices?.[0]?.message?.content || '';
      const parsed = parseFiltersAgentResponse(content, dict);
      mappings = parsed.mappings;
      rejected = parsed.rejected;
      notes = parsed.notes;
      usedMode = 'ai';
    } catch (e) {
      notes.push(`ai_fallback: ${e.message || e}`);
      mappings = heuristicFiltersMappings(recs, dict, config);
      usedMode = 'heuristic';
    }
  } else {
    mappings = heuristicFiltersMappings(recs, dict, config);
    if (mode === 'ai') notes.push('нет API-ключа — эвристика');
    usedMode = 'heuristic';
  }

  const stats = applyFiltersAgentMappings(recs, mappings);
  unifyEnumValues(recs, dict);

  return {
    mode: usedMode,
    mappings,
    rejected,
    notes,
    stats,
    inventory,
  };
}
