/**
 * Отчёт заполненности фильтров категории: coverage, unmapped_values, mismatch.
 */

import { isBrandAttr } from './types.js';
import { requiredFilterAttrs } from './required_filters.js';

const FEW_FILTERS = 5;

function filterNamesFromDict(dict) {
  return (dict?.attrs || [])
    .filter(a => !isBrandAttr(a) && a.facet?.enabled && a.tier !== 'X' && a.facet?.status !== 'not_a_filter')
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.code.localeCompare(b.code))
    .map(a => a.facet.label || a.name);
}

function displayFilterValue(v) {
  if (v == null || v === '') return '';
  return Array.isArray(v) ? v.map(x => String(x)).filter(Boolean).join(', ') : String(v);
}

/**
 * Тест одной карточки после обогащения: все витринные фильтры справочника
 * и покрытие filled/total. Пустой filters даёт 0% — это тоже результат.
 */
export function cardFilterCoverage(filters, dict) {
  const fromDict = filterNamesFromDict(dict);
  const keys = Object.keys(filters || {});
  const names = fromDict.length ? fromDict : keys;
  const rows = names.map((name) => {
    const ok = hasFilterValue(filters, name);
    return { name, value: displayFilterValue(filters?.[name]), ok };
  });
  const filled = rows.filter(r => r.ok).length;
  const total = rows.length;
  return {
    total,
    filled,
    empty: Math.max(0, total - filled),
    coverage: total ? Math.round((filled / total) * 100) : 0,
    rows,
  };
}

function hasFilterValue(filters, name) {
  const v = filters?.[name];
  if (v == null || v === '') return false;
  return Array.isArray(v) ? v.length > 0 : true;
}

function unmappedList(mapForName) {
  if (!mapForName) return [];
  if (Array.isArray(mapForName)) {
    return mapForName.map(x => (
      x && typeof x === 'object'
        ? { value: String(x.value), count: Number(x.count) || 0 }
        : { value: String(x), count: 1 }
    )).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'ru'));
  }
  return [...mapForName]
    .map(([value, count]) => ({ value: String(value), count: Number(count) || 0 }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'ru'));
}

/**
 * @param {object} opts
 * @param {string|number} opts.catId
 * @param {object[]} opts.products  выгрузка с полем filters
 * @param {object[]} opts.recs      нормализованные записи (id, category_mismatch)
 * @param {object} opts.dict
 * @param {object} [opts.unmapped]  { filterName: Map(value → count) | Array }
 * @param {number} [opts.threshold]
 */
export function buildFilterCoverageReport({
  catId,
  products = [],
  recs = [],
  dict,
  unmapped = {},
  threshold = 70,
} = {}) {
  const byId = new Map((recs || []).map(r => [String(r.id), r]));
  const names = filterNamesFromDict(dict);
  const mismatchIds = [...new Set(
    (recs || [])
      .filter(r => r.category_mismatch)
      .map(r => r.id)
      .filter(id => id != null),
  )];

  const eligible = (products || []).filter((p) => {
    const rec = byId.get(String(p.id));
    return !rec?.category_mismatch;
  });
  const denom = eligible.length || 1;

  const filters = names.map((name) => {
    const filled = eligible.filter(p => hasFilterValue(p.filters, name)).length;
    const coverage = Math.round((filled / denom) * 100);
    return {
      name,
      filled,
      coverage,
      status: coverage >= threshold ? 'ok' : 'below_threshold',
      unmapped_values: unmappedList(unmapped[name]),
    };
  });

  const products_with_few_filters = eligible
    .filter(p => Object.keys(p.filters || {}).length <= FEW_FILTERS)
    .map(p => p.id);

  const requiredNames = requiredFilterAttrs(dict).map(a => a.facet?.label || a.name);
  const needRequired = Math.min(3, requiredNames.length);
  const products_missing_required_filters = eligible
    .filter((p) => {
      if (!requiredNames.length) return false;
      const filled = requiredNames.filter(name => hasFilterValue(p.filters, name)).length;
      return filled < needRequired;
    })
    .map(p => p.id);

  return {
    category_id: Number(catId) || catId,
    products_total: (products || []).length,
    eligible_products: eligible.length,
    filters,
    required_filters: requiredNames,
    products_with_few_filters,
    products_missing_required_filters,
    category_mismatch: mismatchIds,
  };
}
