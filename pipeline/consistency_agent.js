/**
 * ИИ-агент сверки поверхностей карточки:
 * description_html / annotation_html / attrs / filters не должны расходиться.
 *
 * Порядок:
 * 1) детерминированный скан (enum_align + checkFilterConsistency);
 * 2) автоправка alignEnumSurfaces;
 * 3) спорные (ambiguous) → ИИ (или эвристика: пометить needs_review);
 * 4) пересчёт filters из исправленных attrs.
 */

import { aliasValue, annotationCase, hasStrictEnum, valueFold } from './types.js';
import { assignFilterValues, filterSourceAllowed } from './facets.js';
import {
  alignEnumSurfaces,
  findEnumClaimsInText,
  resolveEnumTruth,
  rewriteEnumInText,
  provenanceLevelForAlign,
  PRIORITY_ENUM_CODES,
} from './enum_align.js';
import { checkFilterConsistency } from './quality_validate.js';
import { annotationRows } from './generate.js';

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function enumAttrs(dict) {
  return (dict?.attrs || []).filter(a =>
    a.tier !== 'X'
    && hasStrictEnum(a)
    && Object.keys(a.value_aliases || {}).length >= 2
    && (PRIORITY_ENUM_CODES.has(a.code) || a.facet?.enabled || a.show_in_annotation));
}

function surfaceTexts(rec, enriched) {
  const enr = enriched || rec._enriched || null;
  return {
    description: enr?.description
      ?? rec.description
      ?? '',
    annotation: rec.annotation
      || (Array.isArray(rec.source_pairs)
        ? rec.source_pairs.map(p => `${p.key}: ${p.value}`).join('\n')
        : '')
      || annotationRows(rec, rec._dict || { attrs: [] })
        .map(r => `${r.label}: ${r.value}`)
        .join('\n'),
    meta: enr?.meta_keywords ?? '',
  };
}

/**
 * Снимок расхождений одной карточки (без записи).
 * @returns {{ id, name, issues: object[], surfaces: object }}
 */
export function scanProductConsistency(rec, dict, {
  enriched = null,
  assigned = null,
  config = {},
} = {}) {
  const id = rec?.id ?? rec?.sku;
  const issues = [];
  if (!rec || !dict || rec.category_mismatch) {
    return { id, name: rec?.name, issues, surfaces: {} };
  }

  const enr = enriched || rec._enriched || null;
  const texts = surfaceTexts(rec, enr);
  // Для скана annotation берём и исходник, и то, что уйдёт в annotation_html.
  const annFromAttrs = annotationRows(rec, dict).map(r => `${r.label}: ${r.value}`).join('\n');
  const annotationBlob = [texts.annotation, annFromAttrs].filter(Boolean).join('\n');

  const surfacesOut = {};
  for (const attr of enumAttrs(dict)) {
    const facetName = attr.facet?.label || attr.name;
    const filterVal = assigned?.[facetName] ?? assigned?.[attr.name] ?? null;
    const resolved = resolveEnumTruth(
      attr,
      {
        description: texts.description,
        annotation: annotationBlob,
        meta: texts.meta,
        filter: filterVal,
      },
      rec.attrs?.[attr.code],
      rec.provenance?.[attr.code],
    );
    if (!resolved.truth && !resolved.ambiguous) continue;

    const attrCanon = rec.attrs?.[attr.code] != null
      ? (aliasValue(attr, rec.attrs[attr.code]) || String(rec.attrs[attr.code]))
      : null;
    const filterCanon = filterVal != null
      ? aliasValue(attr, Array.isArray(filterVal) ? filterVal[0] : filterVal)
      : null;

    const row = {
      attr_code: attr.code,
      name: facetName,
      truth: resolved.truth,
      action: resolved.action,
      ambiguous: resolved.ambiguous,
      description: resolved.sources.description,
      annotation: resolved.sources.annotation,
      filter: filterCanon,
      attr: attrCanon,
      in_filters: filterVal != null,
      source_allowed: filterSourceAllowed(rec, attr.code, config),
    };
    surfacesOut[attr.code] = row;

    if (resolved.ambiguous) {
      issues.push({
        id,
        attr_code: attr.code,
        kind: 'enum_surface_ambiguous',
        detail: `${facetName}: несколько значений`,
        ...row,
      });
      continue;
    }

    const mismatch = [];
    for (const [k, v] of Object.entries({
      description: row.description,
      annotation: row.annotation,
      filter: row.filter,
      attr: row.attr,
    })) {
      if (v != null && resolved.truth && valueFold(v) !== valueFold(resolved.truth)) {
        mismatch.push(`${k}=${v}`);
      }
    }
    if (mismatch.length) {
      issues.push({
        id,
        attr_code: attr.code,
        kind: 'enum_surface_mismatch',
        detail: `${facetName}: истина=${resolved.truth}; ${mismatch.join(', ')}`,
        ...row,
      });
    }

    // В аннотации/описании есть факт, attrs есть, а filters пуст из‑за model-provenance.
    if (
      attr.facet?.enabled
      && resolved.truth
      && attrCanon
      && valueFold(attrCanon) === valueFold(resolved.truth)
      && filterVal == null
      && !filterSourceAllowed(rec, attr.code, config)
      && (row.description || row.annotation)
    ) {
      issues.push({
        id,
        attr_code: attr.code,
        kind: 'filter_missing_blocked_source',
        detail: `${facetName}=${resolved.truth}: есть в тексте, нет в filters (provenance)`,
        ...row,
      });
    }
  }

  for (const fi of checkFilterConsistency(rec, dict, assigned)) {
    const attr = dict.byCode?.get(fi.code);
    const attrVal = rec.attrs?.[fi.code];
    issues.push({
      id,
      attr_code: fi.code,
      kind: fi.kind,
      detail: fi.detail,
      action: fi.action,
      truth: attr && attrVal != null
        ? (aliasValue(attr, attrVal) || String(attrVal))
        : (attrVal ?? null),
      attr: attrVal ?? null,
    });
  }

  return {
    id,
    name: rec.name,
    issues,
    surfaces: surfacesOut,
  };
}

/**
 * Карточки только с проблемами — вход для ИИ.
 */
export function collectConsistencyCards(recs, dict, {
  debugFacets = [],
  config = {},
  unmapped = null,
  maxCards = 40,
} = {}) {
  const cards = [];
  for (const rec of recs || []) {
    if (rec?.category_mismatch) continue;
    const assigned = assignFilterValues(rec, dict, debugFacets, config, unmapped);
    const scan = scanProductConsistency(rec, dict, {
      enriched: rec._enriched,
      assigned,
      config,
    });
    if (!scan.issues.length) continue;
    cards.push({
      id: scan.id,
      name: scan.name,
      description: stripHtml(rec._enriched?.description || rec.description || '').slice(0, 500),
      annotation: annotationRows(rec, dict)
        .slice(0, 20)
        .map(r => `${r.label}: ${r.value}`),
      filters: Object.fromEntries(
        Object.entries(assigned || {}).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
      ),
      issues: scan.issues.map(i => ({
        attr_code: i.attr_code,
        kind: i.kind,
        detail: i.detail,
        description: i.description ?? null,
        annotation: i.annotation ?? null,
        filter: i.filter ?? null,
        attr: i.attr ?? null,
        truth_hint: i.truth ?? null,
      })),
      canons: Object.fromEntries(
        scan.issues
          .filter(i => i.attr_code && dict.byCode?.get(i.attr_code))
          .map(i => {
            const a = dict.byCode.get(i.attr_code);
            return [i.attr_code, Object.keys(a.value_aliases || {})];
          }),
      ),
    });
    if (cards.length >= maxCards) break;
  }
  return cards;
}

export function buildConsistencyAgentPrompt(dict, { categoryName = '', catId = '' } = {}) {
  const enums = enumAttrs(dict).map(a => ({
    attr_code: a.code,
    name: a.facet?.label || a.name,
    canons: Object.keys(a.value_aliases || {}),
  }));
  return `Ты проверяешь согласованность карточки интернет-магазина перед выгрузкой JSON.

Категория: ${categoryName || catId || 'не указана'} (id=${catId || '—'})

ПОВЕРХНОСТИ (должны говорить одно и то же):
1) description — текст описания (description_html)
2) annotation — характеристики (annotation_html)
3) filters — витринные фильтры товара
4) attr — нормализованное значение в attrs

ПРАВИЛА:
1. Для каждого issue выбери ОДИН канон truth строго из canons этого attr_code.
2. Приоритет: явная строка «Установка: …» в description/annotation → однозначный claim в description → annotation → filters.
3. action:
   - set_attr — записать truth в attrs и подтянуть прозу/filters
   - needs_review — нельзя решить однозначно (оставь как есть, пометь)
   - keep — расхождения нет / уже верно (редко)
4. Нельзя выдумывать канон вне списка canons.
5. Range-бакеты («55-60» vs «59.6 см») — НЕ issue: filters намеренно бакетируют числа.
6. Ответь ТОЛЬКО JSON-объектом, без markdown.

ФАСЕТЫ И КАНОНЫ:
${JSON.stringify(enums, null, 2)}

ФОРМАТ ОТВЕТА:
{
  "decisions": [
    {
      "id": 44772,
      "attr_code": "install",
      "truth": "Отдельностоящая",
      "action": "set_attr",
      "reason": "в описании отдельностоящая, в аннотации ошибочно встраиваемая"
    }
  ],
  "notes": []
}`;
}

export function buildConsistencyAgentUserContent(cards) {
  return `Проверь и устрани расхождения description ↔ annotation ↔ filters. Для каждого issue — decision:\n${JSON.stringify(cards, null, 2)}`;
}

/**
 * Жёсткий парсер ответа модели.
 */
export function parseConsistencyAgentResponse(raw, dict) {
  let data = raw;
  if (typeof raw === 'string') {
    const t = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    try {
      data = JSON.parse(t);
    } catch {
      const m = t.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('consistency_agent: ответ модели не JSON');
      data = JSON.parse(m[0]);
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('consistency_agent: ожидался объект { decisions }');
  }
  const decisions = [];
  const rejected = [];
  for (const d of Array.isArray(data.decisions) ? data.decisions : []) {
    if (!d || typeof d !== 'object') continue;
    const attr = dict.byCode?.get(String(d.attr_code || ''));
    if (!attr || !hasStrictEnum(attr)) {
      rejected.push({ ...d, reason: 'unknown_attr' });
      continue;
    }
    const action = String(d.action || '').toLowerCase();
    if (!['set_attr', 'needs_review', 'keep'].includes(action)) {
      rejected.push({ ...d, reason: 'bad_action' });
      continue;
    }
    let truth = d.truth != null ? aliasValue(attr, d.truth) : null;
    if (action === 'set_attr') {
      if (!truth) {
        rejected.push({ ...d, reason: 'truth_not_in_aliases' });
        continue;
      }
    } else {
      truth = truth || (d.truth != null ? String(d.truth) : null);
    }
    decisions.push({
      id: d.id,
      attr_code: attr.code,
      truth,
      action,
      reason: d.reason != null ? String(d.reason) : '',
    });
  }
  const notes = Array.isArray(data.notes)
    ? data.notes.map(n => String(n)).filter(Boolean)
    : [];
  return { decisions, rejected, notes };
}

/**
 * Эвристика без ИИ: для mismatch берём truth_hint / resolveEnumTruth;
 * ambiguous → needs_review.
 */
export function heuristicConsistencyDecisions(cards) {
  const decisions = [];
  for (const card of cards || []) {
    for (const issue of card.issues || []) {
      if (!issue.attr_code) continue;
      if (issue.kind === 'enum_surface_ambiguous') {
        decisions.push({
          id: card.id,
          attr_code: issue.attr_code,
          truth: issue.truth_hint || issue.attr || null,
          action: 'needs_review',
          reason: 'ambiguous_surfaces',
        });
        continue;
      }
      const truth = issue.truth_hint || issue.description || issue.annotation || issue.attr;
      if (!truth) {
        decisions.push({
          id: card.id,
          attr_code: issue.attr_code,
          truth: null,
          action: 'needs_review',
          reason: 'no_truth',
        });
        continue;
      }
      decisions.push({
        id: card.id,
        attr_code: issue.attr_code,
        truth,
        action: 'set_attr',
        reason: issue.kind || 'heuristic',
      });
    }
  }
  return decisions;
}

function findRec(recs, id) {
  const sid = String(id);
  return (recs || []).find(r => String(r.id ?? r.sku) === sid);
}

/**
 * Применить decisions к recs: attrs + проза enriched.
 * @returns {{ applied: number, review: number, kept: number }}
 */
export function applyConsistencyDecisions(recs, dict, decisions) {
  const stats = { applied: 0, review: 0, kept: 0 };
  for (const d of decisions || []) {
    const rec = findRec(recs, d.id);
    if (!rec?.attrs) continue;
    const attr = dict.byCode?.get(d.attr_code);
    if (!attr) continue;

    if (d.action === 'keep') {
      stats.kept++;
      continue;
    }
    if (d.action === 'needs_review') {
      rec.needs_review = true;
      rec.validation_issues = [
        ...(rec.validation_issues || []),
        {
          code: attr.code,
          kind: 'consistency_needs_review',
          action: 'needs_review',
          detail: d.reason || `${attr.name}: неоднозначно`,
        },
      ];
      stats.review++;
      continue;
    }

    const canon = aliasValue(attr, d.truth) || d.truth;
    if (!canon) continue;
    const prev = rec.attrs[attr.code];
    const prevCanon = prev != null ? (aliasValue(attr, prev) || String(prev)) : null;
    rec.attrs[attr.code] = canon;
    const prevLevel = rec.provenance?.[attr.code]?.level;
    const nextLevel = provenanceLevelForAlign('from_description', prevLevel);
    rec.provenance = rec.provenance || {};
    rec.provenance[attr.code] = {
      ...(rec.provenance[attr.code] || {}),
      level: nextLevel,
      raw: String(canon),
      how: 'consistency_agent:set_attr',
      evidence: {
        ...(rec.provenance[attr.code]?.evidence || {}),
        normalized_value: canon,
        consistency_reason: d.reason || '',
      },
    };

    const target = rec._enriched;
    if (target && typeof target === 'object') {
      for (const field of ['description', 'short_description', 'meta_keywords']) {
        if (typeof target[field] !== 'string' || !target[field]) continue;
        const { text, fixes } = rewriteEnumInText(target[field], attr, canon);
        if (fixes.length) target[field] = text;
      }
      if (Array.isArray(target.bullets)) {
        target.bullets = target.bullets.map((b) => {
          if (typeof b !== 'string') return b;
          return rewriteEnumInText(b, attr, canon).text;
        });
      }
    }

    if (!prevCanon || valueFold(prevCanon) !== valueFold(canon)) stats.applied++;
    else stats.applied++;
  }
  return stats;
}

/**
 * Автоправка без ИИ: alignEnumSurfaces по всем recs с текущими filters.
 */
export function autoFixConsistency(recs, dict, {
  debugFacets = [],
  config = {},
  unmapped = null,
} = {}) {
  let fixed = 0;
  for (const rec of recs || []) {
    if (rec?.category_mismatch) continue;
    const assigned = assignFilterValues(rec, dict, debugFacets, config, unmapped);
    const pass = alignEnumSurfaces(rec, dict, {
      enriched: rec._enriched,
      assigned,
      autoFix: true,
    });
    fixed += (pass.actions || []).filter(a =>
      a.action === 'align_attr' || a.action === 'elevate_prov' || a.action === 'align_prose').length;
  }
  return { fixed };
}

async function callConsistencyLlm({
  provider,
  fetchImpl,
  model,
  system,
  user,
  timeoutMs,
  maxTokens,
}) {
  const chatUrl = provider.chatUrl
    || `${String(provider.baseUrl || '').replace(/\/$/, '')}/chat/completions`;
  const resHttp = await fetchImpl(chatUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider.headers || {}),
      ...(provider.apiKey && !(provider.headers?.Authorization || provider.headers?.authorization)
        ? { Authorization: `Bearer ${provider.apiKey}` }
        : {}),
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
  return data?.choices?.[0]?.message?.content || '';
}

/**
 * Полный проход сверки категории.
 * @returns {{ mode, cards, decisions, rejected, notes, stats, remaining }}
 */
export async function runConsistencyAgent({
  recs,
  dict,
  config = {},
  debugFacets = [],
  unmapped = null,
  provider = null,
  fetchImpl = globalThis.fetch,
  mode = 'auto', // auto | ai | heuristic
  model = '',
  timeoutMs = 90_000,
  maxTokens = 4000,
  categoryName = '',
  catId = '',
  maxCards = 40,
} = {}) {
  const notes = [];

  // 1) Детерминированная автоправка (description ↔ attrs ↔ filters).
  const auto = autoFixConsistency(recs, dict, { debugFacets, config, unmapped });

  // 2) Что осталось после автоправки.
  let cards = collectConsistencyCards(recs, dict, {
    debugFacets,
    config,
    unmapped,
    maxCards,
  });

  if (!cards.length) {
    return {
      mode: 'skip',
      cards: [],
      decisions: [],
      rejected: [],
      notes: ['расхождений description↔annotation↔filters не найдено'],
      stats: { auto_fixed: auto.fixed, applied: 0, review: 0, kept: 0 },
      remaining: [],
    };
  }

  const wantAi = mode === 'ai' || (mode === 'auto' && provider?.apiKey);
  let decisions = [];
  let rejected = [];
  let usedMode = 'heuristic';

  if (wantAi && provider?.apiKey && typeof fetchImpl === 'function') {
    const system = buildConsistencyAgentPrompt(dict, {
      categoryName,
      catId: catId || dict.catId,
    });
    const user = buildConsistencyAgentUserContent(cards);
    try {
      const content = await callConsistencyLlm({
        provider,
        fetchImpl,
        model,
        system,
        user,
        timeoutMs,
        maxTokens,
      });
      const parsed = parseConsistencyAgentResponse(content, dict);
      decisions = parsed.decisions;
      rejected = parsed.rejected;
      notes.push(...parsed.notes);
      usedMode = 'ai';
    } catch (e) {
      notes.push(`ai_fallback: ${e.message || e}`);
      decisions = heuristicConsistencyDecisions(cards);
      usedMode = 'heuristic';
    }
  } else {
    decisions = heuristicConsistencyDecisions(cards);
    if (mode === 'ai') notes.push('нет API-ключа — эвристика');
    usedMode = 'heuristic';
  }

  // Канонизировать truth через aliases перед записью.
  decisions = decisions.map((d) => {
    if (d.action !== 'set_attr' || d.truth == null) return d;
    const attr = dict.byCode?.get(d.attr_code);
    if (!attr) return d;
    const canon = aliasValue(attr, d.truth);
    return canon ? { ...d, truth: canon } : { ...d, action: 'needs_review', reason: 'truth_not_in_aliases' };
  });

  const stats = applyConsistencyDecisions(recs, dict, decisions);
  stats.auto_fixed = auto.fixed;

  // Повторный align после решений ИИ.
  autoFixConsistency(recs, dict, { debugFacets, config, unmapped });

  const remaining = collectConsistencyCards(recs, dict, {
    debugFacets,
    config,
    unmapped,
    maxCards,
  });

  return {
    mode: usedMode,
    cards,
    decisions,
    rejected,
    notes,
    stats,
    remaining,
  };
}

/** Display-форма канона — для тестов/отчётов. */
export function displayTruth(attr, truth) {
  return annotationCase(attr, truth) || String(truth || '');
}

export { findEnumClaimsInText };
