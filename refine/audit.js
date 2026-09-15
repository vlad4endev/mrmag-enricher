/**
 * Разбор готовой пары products + filters: что лишнее, чего не хватает, где спор.
 * Без сети и без модели — только справочник и поверхности карточки.
 */

import { expectedFilters, isRangeBucketLabel, validateDescription, validateAnnotation } from '../pipeline/validate.js';
import { checkFilterConsistency, HALLUCINATION_RE, SPEC_DUMP_HEADING_RE } from '../pipeline/quality_validate.js';
import { assignFilterValues } from '../pipeline/facets.js';
import { annotationRows } from '../pipeline/generate.js';
import { matchKey } from '../pipeline/match.js';
import { aliasValue, hasStrictEnum, isBrandFilterKey, valueFold } from '../pipeline/types.js';
import { requiredFilterAttrs, storefrontFilterAttrs, sheetCharacteristicAttrs } from '../pipeline/required_filters.js';
import { isPriceFilterKey, resolveFilterAttr } from './ingest.js';

function emptyAttr(rec, code) {
  const v = rec?.attrs?.[code];
  if (v == null || v === '') return true;
  if (Array.isArray(v) && !v.length) return true;
  return false;
}

function annotationExtras(rec, dict) {
  const html = rec._uploaded?.annotation_html || rec.annotation || '';
  const items = [...String(html).matchAll(/<li>([\s\S]*?)<\/li>/gi)].map(m => m[1]);
  const extras = [];
  for (const raw of items) {
    const text = String(raw).replace(/<[^>]+>/g, '').trim();
    const m = text.match(/^(.+?)\s*:\s+(.+)$/);
    const key = m ? m[1].trim() : text;
    if (!key) continue;
    const matched = matchKey(key, dict, { fuzzyMin: 0.9 });
    if (matched?.attr && matched.attr.tier !== 'X') continue;
    extras.push({ kind: 'extra_annotation', name: key, value: m ? m[2].trim() : '', action: 'strip' });
  }
  return extras;
}

function productFilterExtras(rec, dict) {
  const extras = [];
  const uploaded = rec._uploaded?.filters || {};
  for (const [name, raw] of Object.entries(uploaded)) {
    if (isBrandFilterKey(name)) {
      extras.push({ kind: 'extra_filter', name, value: raw, action: 'strip', reason: 'бренд не фасет' });
      continue;
    }
    if (isPriceFilterKey(name)) {
      extras.push({ kind: 'extra_filter', name, value: raw, action: 'strip', reason: 'цена не из справочника' });
      continue;
    }
    const resolved = resolveFilterAttr(name, dict);
    if (!resolved?.attr || resolved.special) {
      extras.push({ kind: 'extra_filter', name, value: raw, action: 'strip', reason: 'нет в справочнике' });
      continue;
    }
    const attr = resolved.attr;
    if (!attr.facet?.enabled || attr.facet?.status === 'not_a_filter') {
      extras.push({ kind: 'extra_filter', name, value: raw, action: 'strip', reason: 'не фасет витрины' });
      continue;
    }
    const vals = Array.isArray(raw) ? raw : [raw];
    if (hasStrictEnum(attr)) {
      for (const v of vals) {
        if (v == null || v === '') continue;
        if (isRangeBucketLabel(v)) {
          extras.push({ kind: 'extra_value', name, value: v, action: 'strip', reason: 'бакет на enum' });
          continue;
        }
        if (!aliasValue(attr, v)) {
          extras.push({ kind: 'extra_value', name, value: v, action: 'strip', reason: 'значение не из канонов' });
        }
      }
    }
  }
  return extras;
}

function missingFor(rec, dict) {
  const missing = [];
  for (const a of requiredFilterAttrs(dict)) {
    if (emptyAttr(rec, a.code)) {
      missing.push({
        code: a.code,
        name: a.facet?.label || a.name,
        required: true,
        action: 'fill',
      });
    }
  }
  for (const a of storefrontFilterAttrs(dict)) {
    if (requiredFilterAttrs(dict).some(x => x.code === a.code)) continue;
    if (emptyAttr(rec, a.code)) {
      missing.push({
        code: a.code,
        name: a.facet?.label || a.name,
        required: false,
        action: 'fill',
      });
    }
  }
  for (const a of sheetCharacteristicAttrs(dict)) {
    if (missing.some(m => m.code === a.code)) continue;
    if (emptyAttr(rec, a.code)) {
      missing.push({
        code: a.code,
        name: a.name,
        required: false,
        sheet: true,
        action: 'fill',
      });
    }
  }
  return missing;
}

function textIssues(rec) {
  const issues = [];
  const desc = rec._uploaded?.description_html || rec._enriched?.description || '';
  if (SPEC_DUMP_HEADING_RE.test(desc)) {
    issues.push({ kind: 'spec_dump', action: 'strip', detail: 'служебный дамп характеристик в описании' });
  }
  if (HALLUCINATION_RE.test(desc)) {
    issues.push({ kind: 'hallucination', action: 'strip', detail: 'маркетинговая формулировка без факта' });
  }
  return issues;
}

export function auditProduct(rec, dict, debugFacets = []) {
  const extra = [...productFilterExtras(rec, dict), ...annotationExtras(rec, dict)];
  const missing = missingFor(rec, dict);
  const issues = [...textIssues(rec)];
  const assigned = rec._uploaded?.filters || {};
  for (const e of checkFilterConsistency(rec, dict, assigned)) {
    issues.push({ kind: e.kind || 'mismatch', action: 'fix', detail: e.detail, code: e.code });
  }
  if (debugFacets.length) {
    const rebuilt = assignFilterValues(rec, dict, debugFacets, {});
    for (const e of checkFilterConsistency(rec, dict, rebuilt)) {
      if (!issues.some(i => i.detail === e.detail)) {
        issues.push({ kind: e.kind || 'mismatch', action: 'fix', detail: e.detail, code: e.code });
      }
    }
  }
  const descHtml = rec._uploaded?.description_html;
  if (descHtml) {
    for (const e of validateDescription(descHtml)) {
      if (e.kind === 'length' || e.kind === 'paragraphs' || e.kind === 'ul_count') continue;
      issues.push({ kind: `description.${e.kind}`, action: 'fix', detail: e.detail });
    }
  }
  const annHtml = rec._uploaded?.annotation_html;
  if (annHtml) {
    for (const e of validateAnnotation(annHtml)) {
      if (e.kind === 'annotation_rows') continue;
      issues.push({ kind: `annotation.${e.kind}`, action: 'strip', detail: e.detail });
    }
  }

  const filled = Object.values(rec.attrs || {}).filter(v => v != null && v !== '').length;
  const status = extra.length
    ? 'extra'
    : missing.some(m => m.required)
      ? 'missing'
      : issues.length
        ? 'issues'
        : 'ok';

  return {
    id: rec.id,
    name: rec.name || rec._uploaded?.name || '',
    status,
    extra,
    missing,
    issues,
    filled,
    annotation_rows: annotationRows(rec, dict).length,
  };
}

export function auditFiltersFile(filterPack, recs, dict) {
  const extra = [];
  const extra_values = [];
  const expected = expectedFilters(dict);
  const byName = new Map(expected.map(f => [valueFold(f.name), f]));
  const present = new Set();
  const used = new Map();
  for (const rec of recs) {
    for (const [name, raw] of Object.entries(rec._uploaded?.filters || {})) {
      const vals = Array.isArray(raw) ? raw : [raw];
      const bag = used.get(valueFold(name)) || new Set();
      for (const v of vals) if (v != null && v !== '') bag.add(valueFold(v));
      used.set(valueFold(name), bag);
    }
  }

  for (const item of filterPack.items || []) {
    const name = item.name;
    if (isBrandFilterKey(name) || isPriceFilterKey(name)) {
      extra.push({ name, reason: isBrandFilterKey(name) ? 'бренд не фасет' : 'цена не из справочника' });
      continue;
    }
    const resolved = resolveFilterAttr(name, dict);
    if (!resolved?.attr || !resolved.attr.facet?.enabled) {
      extra.push({ name, reason: 'нет в справочнике витрины' });
      continue;
    }
    present.add(valueFold(resolved.attr.facet.label || resolved.attr.name));
    const attr = resolved.attr;
    if (hasStrictEnum(attr)) {
      for (const v of item.values || []) {
        if (!aliasValue(attr, v)) {
          extra_values.push({ name, value: v, reason: 'значение не из канонов' });
        }
      }
    }
  }

  const missing = expected
    .filter(f => !present.has(valueFold(f.name)))
    .map(f => ({ name: f.name, code: f.code }));

  return { extra, extra_values, missing, expected: expected.length, present: present.size };
}

export function auditPack(pack) {
  const { recs, dict, filters, category, shape } = pack;
  const items = recs.map(rec => auditProduct(rec, dict));
  const filters_file = auditFiltersFile(filters, recs, dict);
  const extra_filters = items.reduce((n, i) => n + i.extra.filter(e => e.kind === 'extra_filter' || e.kind === 'extra_value' || e.kind === 'extra_annotation').length, 0);
  const missing_required = items.reduce((n, i) => n + i.missing.filter(m => m.required).length, 0);
  const missing_optional = items.reduce((n, i) => n + i.missing.filter(m => !m.required).length, 0);
  const clean = items.filter(i => i.status === 'ok').length;
  return {
    category,
    shape,
    products_total: recs.length,
    summary: {
      extra: extra_filters + filters_file.extra.length + filters_file.extra_values.length,
      extra_filters,
      extra_file_facets: filters_file.extra.length,
      extra_file_values: filters_file.extra_values.length,
      missing_required,
      missing_optional,
      issues: items.reduce((n, i) => n + i.issues.length, 0),
      clean,
      dirty: recs.length - clean,
    },
    filters_file,
    expected: expectedFilters(dict),
    items,
  };
}
