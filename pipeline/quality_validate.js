/**
 * Финальная проверка карточки перед serialize.
 * Цель: максимум подтверждённых полей, минимум галлюцинаций.
 * Не ломает клиентский JSON — quality/actions/confirmed остаются на rec.
 *
 * Классификация действий: strip | unknown | needs_review | conflict.
 * Опасное авто-исправление без однозначного решения запрещено.
 */

import { facetKind, bucketLabel, matchBucket, toIntEnum, coerceFacetNumber } from './facets.js';
import { annotationText, formatAttrValue, aliasValue, valueFold } from './types.js';
import { annotationRows, verifyDescription } from './generate.js';
import { SOURCE_RANK } from './normalize.js';
import { alignEnumSurfaces } from './enum_align.js';

const NEGATIVE_RE = /^(?:нет|отсутствует|не\s+поддерживается|не\s+предусмотрено|не\s+имеется)$/i;
export const HALLUCINATION_RE = new RegExp(
  String.raw`(?:идеальн|лучш(?:ий|ая|ее)|№\s*1|premium|премиум|для\s+кухн[ие]\s+\d+\s*м|площад[ьи]\s+\d+|снижает\s+уровень\s+шума|обеспечивает\s+высокую|говорит\s+о\s+над[её]жност|подтверждает(?:ют)?\s+(?:над[её]жност|экономичност)|экономичность\s+модели)`,
  'i',
);

/**
 * Механическое удаление маркетинговых клауз/предложений.
 * Без rewrite: только известные claim-фразы и отсев предложений по HALLUCINATION_RE.
 * HTML: правки только в текстовых узлах — теги не режем.
 */
function stripClaimsPlain(text, { trimEnd = true } = {}) {
  let s = String(text || '');
  if (!s.trim()) return s;
  s = s.replace(/,?\s*что\s+говорит\s+о\s+над[её]жност[иь](?:\s+конструкции)?\.?/gi, '.');
  s = s.replace(/,?\s*что\s+подтверждает\s+над[её]жност[иь][^.!?\n]*/gi, '');
  s = s.replace(/,?\s*(?:и\s+)?подтверждает(?:ют)?\s+экономичность(?:\s+модели)?\.?/gi, '');
  s = s.replace(/\.\s*\./g, '.');
  const chunks = s.split(/([.!?…]+\s*)/);
  let out = '';
  for (let i = 0; i < chunks.length; i += 2) {
    const body = chunks[i] || '';
    const sep = chunks[i + 1] || '';
    if (!body.trim()) {
      out += body + sep;
      continue;
    }
    if (HALLUCINATION_RE.test(body)) continue;
    out += body + sep;
  }
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ');
  return trimEnd ? out.trim() : out;
}

export function stripHallucinationClaims(text) {
  const s = String(text || '');
  if (!s.trim()) return s;
  if (/<[a-z][\s\S]*>/i.test(s)) {
    return s.replace(/(^|>)([^<]*)/g, (_, edge, frag) => edge + stripClaimsPlain(frag, { trimEnd: false }));
  }
  return stripClaimsPlain(s);
}

const SOURCE_BUCKET = {
  manufacturer: 'manufacturer',
  official_product_page: 'official',
  S0: 'source_json',
  S1: 'source_json',
  source_json: 'source_json',
  S2: 'source_json',
  S3: 'retailer',
  trusted_retailer: 'retailer',
  major_retailer: 'retailer',
  retailer: 'retailer',
  distributor: 'other',
  model: 'other',
  review: 'other',
  other: 'other',
};

function filledAttrs(rec, dict) {
  const out = [];
  for (const a of dict.attrs) {
    if (a.tier === 'X') continue;
    const v = rec.attrs?.[a.code];
    if (v == null || v === '') continue;
    out.push(a);
  }
  return out;
}

function isFalseyClaim(attr, value) {
  if (value === false) return true;
  if (typeof value === 'string' && NEGATIVE_RE.test(value.trim())) return true;
  return false;
}

/**
 * Удаляет неподтверждённые «нет» без явного источника → unknown.
 */
export function stripUnconfirmedNegatives(rec, dict) {
  const removed = [];
  for (const a of dict.attrs) {
    if (a.tier === 'X' || a.type !== 'boolean') continue;
    const v = rec.attrs?.[a.code];
    if (!isFalseyClaim(a, v)) continue;
    const prov = rec.provenance?.[a.code];
    const raw = String(prov?.raw || '');
    const explicit = /(?:нет|отсутств|не\s+поддержив|не\s+предусмотр|false|выключен)/i.test(raw);
    if (explicit) continue;
    rec.attrs[a.code] = null;
    if (rec.provenance) delete rec.provenance[a.code];
    removed.push({ code: a.code, action: 'unknown', reason: 'negative_without_evidence' });
  }
  return removed;
}

export function checkFilterConsistency(rec, dict, assigned) {
  const issues = [];
  if (!assigned || typeof assigned !== 'object') return issues;
  if (rec?.category_mismatch) return issues;
  for (const a of dict.attrs) {
    if (a.tier === 'X' || !a.facet?.enabled || a.facet?.status === 'not_a_filter') continue;
    const exact = rec.attrs?.[a.code];
    if (exact == null) continue;
    const name = a.facet.label || a.name;
    const filterVal = assigned[name];
    if (filterVal == null) continue;
    const kind = facetKind(a);
    if (kind === 'range') {
      const n = coerceFacetNumber(
        typeof exact === 'number' ? exact : Number(exact),
        a,
      );
      if (!Number.isFinite(n)) continue;
      const expected = matchBucket(n, a.facet) || bucketLabel(n, { ...a.facet, kind: 'range' });
      const got = Array.isArray(filterVal) ? filterVal[0] : filterVal;
      if (expected && String(got) !== String(expected)) {
        issues.push({
          code: a.code,
          kind: 'filter_mismatch',
          action: 'needs_review',
          detail: `${name}: filter=${got}, expected=${expected}, exact=${n}`,
        });
      }
    } else if (kind === 'int_enum') {
      const n = coerceFacetNumber(
        typeof exact === 'number' ? exact : Number(exact),
        a,
      );
      if (!Number.isFinite(n)) continue;
      const expected = toIntEnum(n, a.facet);
      const got = Array.isArray(filterVal) ? filterVal[0] : filterVal;
      if (expected && String(got) !== String(expected)) {
        issues.push({
          code: a.code,
          kind: 'filter_mismatch',
          action: 'needs_review',
          detail: `${name}: filter=${got}, expected=${expected}, exact=${n}`,
        });
      }
    } else if (kind === 'enum' || a.type === 'enum' || (a.type === 'integer' && kind !== 'range')) {
      // Дискретный атрибут: filter не должен быть бакетом «2-2.2».
      for (const v of (Array.isArray(filterVal) ? filterVal : [filterVal])) {
        if (/^\d+(?:\.\d+)?-\d/.test(String(v))) {
          issues.push({
            code: a.code,
            kind: 'discrete_as_range',
            action: 'needs_review',
            detail: `${name}=${v}`,
          });
        }
      }
      // Enum: значение фильтра должно совпадать с attrs (канон / alias).
      if (a.type === 'enum' || kind === 'enum') {
        const got = Array.isArray(filterVal) ? filterVal[0] : filterVal;
        const expectedCanon = aliasValue(a, exact) || String(exact);
        const gotCanon = aliasValue(a, got) || String(got);
        if (got != null && valueFold(expectedCanon) !== valueFold(gotCanon)) {
          issues.push({
            code: a.code,
            kind: 'filter_mismatch',
            action: 'needs_review',
            detail: `${name}: filter=${got}, expected=${expectedCanon}, exact=${exact}`,
          });
        }
      }
    }
  }
  return issues;
}

export function checkAnnotationFacts(rec, dict) {
  const issues = [];
  const rows = annotationRows(rec, dict);
  const seen = new Set();
  for (const row of rows) {
    const key = row.label.toLowerCase();
    if (seen.has(key)) {
      issues.push({ code: row.attr.code, kind: 'annotation_duplicate', action: 'strip', detail: row.label });
    }
    seen.add(key);
    if (/:\s*\d+(?:\.\d+)?-\d/.test(`${row.label}: ${row.value}`)) {
      issues.push({ code: row.attr.code, kind: 'annotation_bucketed', action: 'needs_review', detail: row.value });
    }
    const expected = annotationText(row.attr, rec.attrs[row.attr.code]);
    if (expected && row.value && expected !== row.value) {
      issues.push({
        code: row.attr.code,
        kind: 'annotation_mismatch',
        action: 'needs_review',
        detail: `got=${row.value}, expected=${expected}`,
      });
    }
  }
  return issues;
}

/**
 * Description: маркеры галлюцинаций + числа должны быть в confirmed attrs.
 */
export function checkDescriptionClaims(enriched, rec = null, dict = null) {
  const issues = [];
  if (!enriched || typeof enriched !== 'object') return issues;
  const texts = [
    enriched.description,
    enriched.short_description,
    ...(Array.isArray(enriched.bullets) ? enriched.bullets : []),
  ].filter(Boolean).join('\n');
  if (HALLUCINATION_RE.test(texts)) {
    issues.push({
      kind: 'hallucination_marker',
      action: 'needs_review',
      detail: 'неподтверждённая маркетинговая формулировка',
    });
  }
  if (/\b(?:wifi|wi-?fi|вай[\s-]?фай)\b.{0,20}(?:нет|отсутств|не\s+поддерж)/i.test(texts)
    || /(?:нет|отсутств|не\s+поддерж).{0,20}\b(?:wifi|wi-?fi|вай[\s-]?фай)\b/i.test(texts)) {
    issues.push({
      kind: 'negative_without_source',
      action: 'unknown',
      detail: 'Wi-Fi отрицается в тексте без confirmed false',
    });
  }
  if (rec && dict && enriched.description) {
    for (const e of verifyDescription(enriched.description, rec, dict)) {
      issues.push({
        kind: e.kind || 'number_not_in_attrs',
        action: 'needs_review',
        detail: `${e.number} ${e.unit || ''}`.trim(),
        number: e.number,
        unit: e.unit,
      });
    }
  }
  return issues;
}

/** width и install_width не должны совпадать «случайно» из одного ключа. */
export function checkWidthSeparation(rec, dict) {
  const issues = [];
  if (!dict?.byCode?.has('install_width')) return issues;
  const w = rec.attrs?.width;
  const iw = rec.attrs?.install_width;
  if (w == null || iw == null) return issues;
  const pw = rec.provenance?.width;
  const piw = rec.provenance?.install_width;
  // Один и тот же raw-ключ на оба — ошибка маппинга.
  if (pw?.raw && piw?.raw && pw.raw === piw.raw) {
    issues.push({
      kind: 'width_install_mixed',
      action: 'needs_review',
      detail: pw.raw,
      code: 'install_width',
    });
  }
  return issues;
}

/**
 * Собирает ConfirmedAttribute[] во rec.confirmed (внутренний слой).
 */
export function buildConfirmedAttributes(rec, dict, assigned = null) {
  const list = [];
  for (const a of filledAttrs(rec, dict)) {
    const prov = rec.provenance?.[a.code] || {};
    const name = a.facet?.label || a.name;
    let filterValue = null;
    if (assigned && assigned[name] != null) {
      filterValue = Array.isArray(assigned[name]) ? assigned[name][0] : assigned[name];
    } else if (a.facet?.enabled && facetKind(a) === 'range' && typeof rec.attrs[a.code] === 'number') {
      filterValue = matchBucket(rec.attrs[a.code], a.facet)
        || bucketLabel(rec.attrs[a.code], { ...a.facet, kind: 'range' });
    } else if (a.facet?.enabled && facetKind(a) === 'int_enum' && rec.attrs[a.code] != null) {
      filterValue = toIntEnum(coerceFacetNumber(Number(rec.attrs[a.code]), a), a.facet);
    } else if (a.facet?.enabled) {
      filterValue = formatAttrValue(a, rec.attrs[a.code], { withUnit: false });
    }
    const evidence = {
      attribute: a.code,
      name: a.name,
      raw_value: prov.raw ?? prov.evidence?.raw_value ?? null,
      normalized_value: rec.attrs[a.code],
      filter_value: filterValue,
      source: prov.level || prov.evidence?.source || 'other',
      evidence: prov.raw || prov.evidence?.evidence || null,
      confidence: prov.evidence?.confidence
        ?? (SOURCE_RANK[prov.level] >= 35 ? 0.9 : 0.6),
    };
    list.push(evidence);
    if (rec.provenance?.[a.code]) {
      rec.provenance[a.code].evidence = {
        ...(rec.provenance[a.code].evidence || {}),
        ...evidence,
      };
    }
  }
  rec.confirmed = list;
  return list;
}

/**
 * Quality report с разбивкой по источникам.
 */
export function qualityScore(rec, dict, issues = []) {
  const total = dict.attrs.filter(a => a.tier !== 'X' && a.tier !== 'C').length || 1;
  const confirmed = filledAttrs(rec, dict).length;
  const unknown = Math.max(0, total - confirmed);
  const conflicts = Array.isArray(rec.conflicts) ? rec.conflicts.length : 0;
  const unresolved = (rec.conflicts || []).filter(c => c.needs_review || c.kept === 'unresolved').length;
  const hallucinations = issues.filter(i =>
    i.kind === 'hallucination_marker'
    || i.kind === 'negative_without_source'
    || i.kind === 'number_not_in_attrs').length;
  const invalid = issues.filter(i =>
    i.kind === 'filter_mismatch'
    || i.kind === 'discrete_as_range'
    || i.kind === 'annotation_bucketed'
    || i.kind === 'enum_not_in_dict'
    || i.kind === 'enum_surface_mismatch'
    || i.kind === 'enum_surface_ambiguous'
    || i.kind === 'width_install_mixed').length;

  const sources = {
    source_json: 0,
    manufacturer: 0,
    official: 0,
    retailer: 0,
    other: 0,
  };
  for (const a of filledAttrs(rec, dict)) {
    const level = rec.provenance?.[a.code]?.level || 'other';
    const bucket = SOURCE_BUCKET[level] || 'other';
    sources[bucket] = (sources[bucket] || 0) + 1;
  }

  const penalty = unresolved * 0.05 + conflicts * 0.02 + hallucinations * 0.05 + invalid * 0.03;
  const score = Math.max(0, Math.min(1, confirmed / total - penalty));

  return {
    score: Math.round(score * 1000) / 1000,
    confirmed,
    unknown,
    conflicts,
    unresolved,
    invalid,
    hallucinations,
    attributes_total: total,
    attributes_confirmed: confirmed,
    attributes_unknown: unknown,
    attributes_conflicted: conflicts,
    sources,
  };
}

/**
 * Финальный проход до serializeProduct.
 * @returns {{ ok: boolean, issues: object[], actions: object[], quality: object, needs_review: boolean }}
 */
export function finalizeRecord(rec, dict, { enriched = null, assigned = null } = {}) {
  const actions = [];
  const removed = stripUnconfirmedNegatives(rec, dict);
  for (const r of removed) actions.push(r);

  // Сначала согласовать enum-поверхности (описание ↔ attrs ↔ фильтры),
  // затем проверять факты — иначе annotation/filter ловят устаревшее значение.
  const enr = enriched || rec._enriched || null;
  const enumAligned = alignEnumSurfaces(rec, dict, {
    enriched: enr,
    assigned,
    autoFix: true,
  });
  for (const a of enumAligned.actions) actions.push(a);

  const issues = [
    ...enumAligned.issues,
    ...checkAnnotationFacts(rec, dict),
    ...checkFilterConsistency(rec, dict, assigned),
    ...checkDescriptionClaims(enr, rec, dict),
    ...checkWidthSeparation(rec, dict),
  ];

  for (const c of rec.conflicts || []) {
    issues.push({
      code: c.attribute,
      kind: 'conflict',
      action: c.needs_review ? 'needs_review' : 'conflict',
      detail: c.values.map(v => `${v.source}=${v.value}`).join(' vs '),
      reason: c.reason,
      selected_value: c.selected_value,
    });
  }

  for (const a of dict.attrs) {
    if (a.tier === 'X' || a.type !== 'enum') continue;
    const v = rec.attrs?.[a.code];
    if (v == null) continue;
    const allowed = a.value_aliases ? Object.keys(a.value_aliases) : null;
    if (!allowed?.length) continue;
    const list = Array.isArray(v) ? v : [v];
    for (const one of list) {
      const fold = String(one).toLowerCase();
      const hit = allowed.some(x => x.toLowerCase() === fold
        || (a.value_aliases[x] || []).some(y => String(y).toLowerCase() === fold));
      if (!hit) {
        issues.push({ code: a.code, kind: 'enum_not_in_dict', action: 'needs_review', detail: String(one) });
      }
    }
  }

  buildConfirmedAttributes(rec, dict, assigned);

  if (enriched && typeof enriched === 'object') {
    if (typeof enriched.description === 'string') {
      enriched.description = stripHallucinationClaims(enriched.description);
    }
    if (typeof enriched.short_description === 'string') {
      enriched.short_description = stripHallucinationClaims(enriched.short_description);
    }
    if (Array.isArray(enriched.bullets)) {
      enriched.bullets = enriched.bullets.map(b =>
        (typeof b === 'string' ? stripHallucinationClaims(b) : b)).filter(b => b && String(b).trim());
    }
  }

  const quality = qualityScore(rec, dict, issues);
  rec.quality = quality;
  rec.validation_issues = issues;
  rec.validation_actions = actions;

  const needsReview = Boolean(rec.needs_review)
    || (rec.conflicts || []).some(c => c.needs_review)
    || issues.some(i => i.action === 'needs_review'
      && (i.kind === 'hallucination_marker'
        || i.kind === 'number_not_in_attrs'
        || i.kind === 'discrete_as_range'
        || i.kind === 'width_install_mixed'
        || i.kind === 'enum_surface_ambiguous'
        || i.kind === 'conflict'));

  if (needsReview) rec.needs_review = true;

  const blocking = issues.filter(i =>
    i.kind === 'annotation_bucketed'
    || i.kind === 'filter_mismatch'
    || i.kind === 'discrete_as_range'
    || i.kind === 'hallucination_marker'
    || i.kind === 'number_not_in_attrs');

  return {
    ok: blocking.length === 0 && !needsReview,
    issues,
    actions,
    quality,
    needs_review: needsReview,
  };
}
