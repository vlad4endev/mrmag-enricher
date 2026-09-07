/**
 * Отчёт заполненности фильтров категории: coverage, unmapped_values, mismatch.
 */

const FEW_FILTERS = 5;

function filterNamesFromDict(dict) {
  return (dict?.attrs || [])
    .filter(a => a.facet?.enabled && a.tier !== 'X' && a.facet?.status !== 'not_a_filter')
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.code.localeCompare(b.code))
    .map(a => a.facet.label || a.name);
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
  const mismatchSet = new Set(mismatchIds.map(String));

  const eligible = (products || []).filter(p => !mismatchSet.has(String(p.id)));
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

  return {
    category_id: Number(catId) || catId,
    products_total: (products || []).length,
    eligible_products: eligible.length,
    filters,
    products_with_few_filters,
    category_mismatch: mismatchIds,
  };
}
