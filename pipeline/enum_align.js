/**
 * Согласование enum-характеристик между описанием, аннотацией, meta и фильтрами.
 *
 * Источник истины после разрешения — attrs; filters/annotation на выгрузке
 * строятся из attrs. Проза и meta_keywords подтягиваются к канону.
 *
 * Приоритет при конфликте поверхностей:
 * 1) явная строка «Установка: …» / «Тип: …» в аннотации или описании;
 * 2) однозначный claim в description (фильтры должны совпадать с описанием);
 * 3) attrs с сильным provenance (не derived/S0);
 * 4) текущий attrs / filter.
 */

import { aliasValue, hasStrictEnum, valueFold, annotationCase } from './types.js';

/** Коды, где полярные значения часто путают (обязательная сверка). */
export const PRIORITY_ENUM_CODES = new Set([
  'install',
  'load_type',
  'construction',
  'cooling',
  'fridge_type',
  'freezer_pos',
  'control_type',
  'motor_type',
  'compressor_type',
]);

/** Уровни provenance, которым не доверяем против явного claim в описании. */
const WEAK_LEVELS = new Set(['model', 'review', 'other', 'distributor', 'retailer', 'S3']);

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function isWeakProv(prov) {
  if (!prov) return true;
  const how = String(prov.how || '');
  if (/^derived_/.test(how) || /^enum_align:/.test(how)) return true;
  return WEAK_LEVELS.has(String(prov.level || 'other'));
}

/**
 * Все каноны attr → список меток (канон + aliases), длинные первыми.
 * @returns {{ canon: string, label: string, fold: string }[]}
 */
export function enumLabelIndex(attr) {
  if (!hasStrictEnum(attr)) return [];
  const out = [];
  for (const [canon, list] of Object.entries(attr.value_aliases || {})) {
    const labels = [canon, ...(list || [])];
    for (const label of labels) {
      const fold = valueFold(label);
      if (!fold || fold.length < 3) continue;
      out.push({ canon, label: String(label), fold });
    }
  }
  out.sort((a, b) => b.fold.length - a.fold.length || a.fold.localeCompare(b.fold));
  return out;
}

/**
 * Находит каноны enum, упомянутые в тексте.
 * @returns {{ canon: string, match: string, labeled: boolean, index: number }[]}
 */
export function findEnumClaimsInText(text, attr) {
  const plain = stripHtml(text);
  if (!plain) return [];
  const index = enumLabelIndex(attr);
  if (!index.length) return [];

  const syns = [...(attr.synonyms || []), attr.name, attr.facet?.label].filter(Boolean);
  const labelRe = syns.length
    ? new RegExp(
      `(?:${syns.map(s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*[-–—:]\\s*([^,<;.\\n]+)`,
      'i',
    )
    : null;

  const hits = [];
  const seenCanon = new Set();

  // Сначала размеченные «Установка: встраиваемая» — сильнее свободного текста.
  if (labelRe) {
    let m;
    const re = new RegExp(labelRe.source, 'gi');
    while ((m = re.exec(plain))) {
      const raw = String(m[1] || '').trim();
      const canon = aliasValue(attr, raw);
      if (!canon) continue;
      hits.push({
        canon,
        match: m[0],
        labeled: true,
        index: m.index,
      });
      seenCanon.add(valueFold(canon));
    }
  }

  // Свободные вхождения по исходному тексту (пробелы/дефисы гибкие).
  // Longest-first из enumLabelIndex — «С возможностью встраивания» раньше «Встраиваемая».
  const occupied = [];
  const lower = plain.toLowerCase().replace(/ё/g, 'е');
  for (const row of index) {
    const esc = row.label
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/[\s\-–—]+/g, '[\\s\\-–—]*');
    const re = new RegExp(`(?<![а-яa-z0-9])${esc}(?![а-яa-z0-9])`, 'gi');
    let m;
    while ((m = re.exec(lower))) {
      const start = m.index;
      const end = start + m[0].length;
      if (occupied.some(r => start < r.end && end > r.start)) continue;
      occupied.push({ start, end });
      if (seenCanon.has(valueFold(row.canon))) continue;
      hits.push({
        canon: row.canon,
        match: plain.slice(start, end) || row.label,
        labeled: false,
        index: start,
      });
      seenCanon.add(valueFold(row.canon));
    }
  }

  return hits;
}

function uniqueCanons(hits) {
  const out = [];
  const seen = new Set();
  for (const h of hits) {
    const k = valueFold(h.canon);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h.canon);
  }
  return out;
}

function pickFromHits(hits) {
  if (!hits.length) return null;
  const labeled = hits.filter(h => h.labeled);
  if (labeled.length) {
    const canons = uniqueCanons(labeled);
    if (canons.length === 1) return canons[0];
  }
  const canons = uniqueCanons(hits);
  return canons.length === 1 ? canons[0] : null;
}

/**
 * Решает канон для одного enum-атрибута по всем поверхностям карточки.
 * @returns {{ truth: string|null, ambiguous: boolean, sources: object, action: string }}
 */
export function resolveEnumTruth(attr, surfaces, current, prov = null) {
  const descHits = findEnumClaimsInText(surfaces.description || '', attr);
  const annHits = findEnumClaimsInText(surfaces.annotation || '', attr);
  const metaHits = findEnumClaimsInText(surfaces.meta || '', attr);
  const filterRaw = surfaces.filter;
  const filterCanon = filterRaw != null
    ? aliasValue(attr, Array.isArray(filterRaw) ? filterRaw[0] : filterRaw)
    : null;
  const attrCanon = current != null ? aliasValue(attr, current) || String(current) : null;

  const fromDesc = pickFromHits(descHits);
  const fromAnn = pickFromHits(annHits);
  const fromMeta = pickFromHits(metaHits);

  const sources = {
    description: fromDesc,
    annotation: fromAnn,
    meta: fromMeta,
    filter: filterCanon,
    attr: attrCanon,
    desc_hits: descHits.map(h => h.canon),
    ann_hits: annHits.map(h => h.canon),
  };

  // Конфликт внутри одной поверхности — нужна ручная проверка.
  if (uniqueCanons(descHits).length > 1 || uniqueCanons(annHits).length > 1) {
    return {
      truth: attrCanon || fromDesc || fromAnn || filterCanon || fromMeta,
      ambiguous: true,
      sources,
      action: 'needs_review',
    };
  }

  const labeledAnn = pickFromHits(annHits.filter(h => h.labeled));
  const labeledDesc = pickFromHits(descHits.filter(h => h.labeled));

  // 1) Размеченное описание («Установка: отдельностоящая»).
  if (labeledDesc) {
    return { truth: labeledDesc, ambiguous: false, sources, action: 'from_description_label' };
  }

  // 2) Однозначный claim в description — фильтры/аннотация подтягиваются к нему.
  if (fromDesc) {
    const others = [fromAnn, fromMeta, filterCanon, attrCanon].filter(Boolean);
    const conflict = others.some(v => valueFold(v) !== valueFold(fromDesc));
    if (conflict && attrCanon && !isWeakProv(prov)
      && valueFold(attrCanon) !== valueFold(fromDesc)
      && !fromAnn && !labeledAnn) {
      // Сильный attrs, описание без таблицы и без конфликта с аннотацией.
      return { truth: attrCanon, ambiguous: false, sources, action: 'keep_strong_attr' };
    }
    return {
      truth: fromDesc,
      ambiguous: false,
      sources,
      action: conflict ? 'from_description' : 'ok',
    };
  }

  // 3) Размеченная аннотация (когда описания про установку молчит).
  if (labeledAnn) {
    return { truth: labeledAnn, ambiguous: false, sources, action: 'from_annotation_label' };
  }

  // 4) Сильный attrs.
  if (attrCanon && !isWeakProv(prov)) {
    return { truth: attrCanon, ambiguous: false, sources, action: 'keep_strong_attr' };
  }

  // 5) Аннотация / filter / attrs / meta.
  if (fromAnn) {
    return { truth: fromAnn, ambiguous: false, sources, action: 'from_annotation' };
  }
  if (filterCanon) {
    return { truth: filterCanon, ambiguous: false, sources, action: 'from_filter' };
  }
  if (attrCanon) {
    return { truth: attrCanon, ambiguous: false, sources, action: 'keep_attr' };
  }
  if (fromMeta) {
    return { truth: fromMeta, ambiguous: false, sources, action: 'from_meta' };
  }

  return { truth: null, ambiguous: false, sources, action: 'empty' };
}

/**
 * Заменяет в тексте чужие каноны на display-форму truth.
 */
export function rewriteEnumInText(text, attr, truth) {
  if (truth == null || text == null) return { text: text || '', fixes: [] };
  const index = enumLabelIndex(attr);
  if (!index.length) return { text: String(text), fixes: [] };

  const truthFold = valueFold(truth);
  const display = annotationCase(attr, truth) || String(truth);
  const fixes = [];
  let out = String(text);

  // Группируем по канону чужие метки — длинные первыми.
  const foreign = index.filter(r => valueFold(r.canon) !== truthFold);
  // Уникальные label без дублей fold
  const seen = new Set();
  const labels = [];
  for (const r of foreign) {
    if (seen.has(r.fold)) continue;
    seen.add(r.fold);
    labels.push(r);
  }

  for (const row of labels) {
    // Word-ish boundaries for Cyrillic
    const esc = row.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const re = new RegExp(`(?<![а-яёa-z0-9])${esc}(?![а-яёa-z0-9])`, 'gi');
    if (!re.test(out)) continue;
    out = out.replace(re, () => {
      fixes.push({ code: attr.code, from: row.label, to: display, canon: truth });
      return display;
    });
  }

  return { text: out, fixes };
}

function attrsEligible(dict) {
  return (dict?.attrs || []).filter(a =>
    a.tier !== 'X'
    && hasStrictEnum(a)
    && Object.keys(a.value_aliases || {}).length >= 2
    && (PRIORITY_ENUM_CODES.has(a.code) || a.facet?.enabled || a.show_in_annotation));
}

/**
 * Проверка + автоправка rec.attrs и enriched-текстов.
 * @returns {{ issues: object[], actions: object[], enum_fixes: object[] }}
 */
export function alignEnumSurfaces(rec, dict, {
  enriched = null,
  assigned = null,
  autoFix = true,
} = {}) {
  const issues = [];
  const actions = [];
  const enum_fixes = [];
  if (!rec || !dict || rec.category_mismatch) {
    return { issues, actions, enum_fixes };
  }

  const description = enriched?.description
    ?? rec._enriched?.description
    ?? rec.description
    ?? '';
  const annotation = rec.annotation
    || (Array.isArray(rec.source_pairs)
      ? rec.source_pairs.map(p => `${p.key}: ${p.value}`).join('\n')
      : '');
  const meta = enriched?.meta_keywords ?? rec._enriched?.meta_keywords ?? '';

  for (const attr of attrsEligible(dict)) {
    const facetName = attr.facet?.label || attr.name;
    const filterVal = assigned?.[facetName] ?? assigned?.[attr.name] ?? null;
    const resolved = resolveEnumTruth(
      attr,
      {
        description,
        annotation,
        meta,
        filter: filterVal,
      },
      rec.attrs?.[attr.code],
      rec.provenance?.[attr.code],
    );

    if (!resolved.truth) continue;

    const current = rec.attrs?.[attr.code];
    const currentCanon = current != null ? (aliasValue(attr, current) || String(current)) : null;
    const mismatchSurfaces = [];
    for (const [surf, val] of Object.entries({
      description: resolved.sources.description,
      annotation: resolved.sources.annotation,
      meta: resolved.sources.meta,
      filter: resolved.sources.filter,
      attr: currentCanon,
    })) {
      if (val != null && valueFold(val) !== valueFold(resolved.truth)) {
        mismatchSurfaces.push(`${surf}=${val}`);
      }
    }

    if (resolved.ambiguous) {
      issues.push({
        code: attr.code,
        kind: 'enum_surface_ambiguous',
        action: 'needs_review',
        detail: `${attr.name}: ${mismatchSurfaces.join(' | ') || 'несколько значений в тексте'}`,
        truth: resolved.truth,
        sources: resolved.sources,
      });
      continue;
    }

    if (!mismatchSurfaces.length && resolved.action === 'ok') continue;

    if (mismatchSurfaces.length) {
      issues.push({
        code: attr.code,
        kind: 'enum_surface_mismatch',
        action: autoFix ? 'strip' : 'needs_review',
        detail: `${attr.name}: истина=${resolved.truth}; расхождение: ${mismatchSurfaces.join(', ')}`,
        truth: resolved.truth,
        sources: resolved.sources,
        resolve: resolved.action,
      });
    }

    if (!autoFix) continue;

    // Attrs → канон.
    if (!currentCanon || valueFold(currentCanon) !== valueFold(resolved.truth)) {
      rec.attrs[attr.code] = resolved.truth;
      rec.provenance = rec.provenance || {};
      rec.provenance[attr.code] = {
        ...(rec.provenance[attr.code] || {}),
        level: rec.provenance[attr.code]?.level || 'S0',
        raw: resolved.truth,
        how: `enum_align:${resolved.action}`,
        evidence: {
          ...(rec.provenance[attr.code]?.evidence || {}),
          normalized_value: resolved.truth,
          enum_align: resolved.action,
        },
      };
      actions.push({
        code: attr.code,
        action: 'align_attr',
        from: currentCanon,
        to: resolved.truth,
        reason: resolved.action,
      });
      enum_fixes.push({
        code: attr.code,
        field: 'attrs',
        from: currentCanon,
        to: resolved.truth,
      });
    }

    // Проза enriched.
    const target = enriched || rec._enriched;
    if (target && typeof target === 'object') {
      for (const field of ['description', 'short_description']) {
        if (typeof target[field] !== 'string' || !target[field]) continue;
        const { text, fixes } = rewriteEnumInText(target[field], attr, resolved.truth);
        if (fixes.length) {
          target[field] = text;
          for (const f of fixes) {
            enum_fixes.push({ ...f, field });
            actions.push({ code: attr.code, action: 'align_prose', field, from: f.from, to: f.to });
          }
        }
      }
      if (Array.isArray(target.bullets)) {
        target.bullets = target.bullets.map((b, i) => {
          if (typeof b !== 'string') return b;
          const { text, fixes } = rewriteEnumInText(b, attr, resolved.truth);
          for (const f of fixes) {
            enum_fixes.push({ ...f, field: `bullets[${i}]` });
            actions.push({
              code: attr.code,
              action: 'align_prose',
              field: `bullets[${i}]`,
              from: f.from,
              to: f.to,
            });
          }
          return text;
        });
      }
      // meta_keywords с чужим enum — помечаем на пересборку.
      if (typeof target.meta_keywords === 'string' && target.meta_keywords) {
        const metaHits = findEnumClaimsInText(target.meta_keywords, attr);
        const bad = metaHits.some(h => valueFold(h.canon) !== valueFold(resolved.truth));
        if (bad) {
          target._meta_keywords_stale = true;
          const { text, fixes } = rewriteEnumInText(target.meta_keywords, attr, resolved.truth);
          if (fixes.length) {
            target.meta_keywords = text;
            for (const f of fixes) {
              enum_fixes.push({ ...f, field: 'meta_keywords' });
              actions.push({
                code: attr.code,
                action: 'align_meta',
                from: f.from,
                to: f.to,
              });
            }
          }
        }
      }
    }
  }

  return { issues, actions, enum_fixes };
}

/**
 * Только диагностика (без записи в rec) — для quality score / UI.
 */
export function checkEnumSurfaceConsistency(rec, dict, {
  enriched = null,
  assigned = null,
} = {}) {
  const { issues } = alignEnumSurfaces(rec, dict, {
    enriched,
    assigned,
    autoFix: false,
  });
  return issues;
}
