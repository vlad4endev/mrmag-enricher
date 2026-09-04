/** Фильтры строго по facet.* справочника. Вид и шаг из справочника, не из данных. */

import { formatAttrValue, unifyEnumValues } from './types.js';

/** Доля товаров на одно значение, выше которой фильтр перестаёт различать товары. */
const DOMINANT_SHARE = 95;

/**
 * Вид фильтра следует из типа атрибута, а не из разброса данных.
 * Счётная величина — перечень: «2, 3, 4 скорости», а не «2-2.2» и «2.8-3».
 */
export function facetKind(attr) {
  const kind = attr.facet?.kind;
  if (kind === 'range' && attr.type === 'integer') return 'enum';
  return kind;
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : String(+n.toFixed(3));
}

/** Начало полузакрытого интервала [a; b): 600 при шаге 50 — это 600-650, не 550-600. */
function bucketLo(value, step) {
  return Math.floor(Number(value) / step) * step;
}

export function bucketLabel(value, facet, { isLast = false } = {}) {
  if (facet.kind !== 'range') return String(value);
  const step = facet.step;
  if (!(step > 0)) throw new Error(`facet.step обязателен для range (${facet.label})`);
  const lo = bucketLo(value, step);
  if (facet.open_last && isLast) return `${fmt(lo)}+`;
  return `${fmt(lo)}-${fmt(lo + step)}`;
}

function numericOf(v) {
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function displayValue(attr, v) {
  return formatAttrValue(attr, v, { withUnit: false });
}

/** Значения атрибута как список: multi даёт несколько, single — одно. */
function valueList(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v.filter(x => x != null && x !== '') : [v];
}

/**
 * Строит filters.json. Состав — только facet.enabled справочника: универсальный
 * набор «тип товара, назначение, вес» внутри категории ничего не различает.
 * Для range: [a; b); последний бакет открытый при facet.open_last.
 * Пустые бакеты не создаются.
 */
export function buildFilters(recs, dict, config) {
  unifyEnumValues(recs, dict);
  if (config.facet_min_coverage == null) {
    throw new Error('config.facet_min_coverage обязателен');
  }
  const minCov = config.facet_min_coverage;
  const total = recs.length || 1;
  const filters = [];
  const excluded = [];
  const warnings = [];

  for (const attr of dict.attrs) {
    const facet = attr.facet || {};
    if (!facet.enabled) {
      if (facet.disabled_reason) {
        excluded.push({ code: attr.code, name: attr.name, reason: facet.disabled_reason });
      }
      continue;
    }
    if (attr.tier === 'X') continue;

    const filled = recs.filter(r => r.attrs[attr.code] != null);
    const cov = (filled.length / total) * 100;

    const counts = new Map();
    const kind = facetKind(attr);

    if (kind === 'range') {
      if (!(facet.step > 0)) throw new Error(`facet.step обязателен для range (${facet.label || attr.name})`);
      const nums = filled.map(r => numericOf(r.attrs[attr.code])).filter(v => v != null);
      if (!nums.length) continue;
      const maxLo = Math.max(...nums.map(v => bucketLo(v, facet.step)));

      for (const v of nums) {
        const isLast = !!facet.open_last && bucketLo(v, facet.step) === maxLo;
        const lab = bucketLabel(v, { ...facet, kind: 'range' }, { isLast });
        counts.set(lab, (counts.get(lab) || 0) + 1);
      }

      const sum = [...counts.values()].reduce((a, b) => a + b, 0);
      if (sum !== nums.length) {
        throw new Error(
          `сумма counter фасета «${facet.label || attr.name}» = ${sum}, ` +
          `числовых значений = ${nums.length} — выгрузка заблокирована`,
        );
      }
      if (counts.size > 8) {
        warnings.push({
          code: attr.code,
          name: facet.label || attr.name,
          occupied: counts.size,
          reason: `Занятых бакетов ${counts.size} > 8; шаг задан справочником, пересчёт запрещён`,
        });
      }
    } else {
      // Мультизначный атрибут даёт товару несколько значений фильтра:
      // «механическое, кнопочное» попадает и в «Механическое», и в «Кнопочное».
      for (const r of filled) {
        const seen = new Set();
        for (const p of valueList(r.attrs[attr.code])) {
          const lab = displayValue(attr, p);
          if (!lab || seen.has(lab)) continue;
          seen.add(lab);
          counts.set(lab, (counts.get(lab) || 0) + 1);
        }
      }
    }

    const values = [...counts]
      .filter(([, c]) => c > 0)
      .sort((a, b) => {
        const na = parseFloat(a[0]), nb = parseFloat(b[0]);
        if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
        return a[0].localeCompare(b[0], 'ru');
      })
      .map(([value]) => value);

    if (!values.length) continue;

    // Фильтр, где одно значение покрывает почти все товары каталога, не
    // помогает выбирать: доля считается от всех товаров, а не от заполненных.
    const topShare = (Math.max(...counts.values()) / total) * 100;
    if (topShare > DOMINANT_SHARE) {
      warnings.push({
        code: attr.code,
        name: facet.label || attr.name,
        share: Math.round(topShare * 10) / 10,
        reason: `Одно значение у ${Math.round(topShare)}% заполненных — фильтр не различает товары`,
      });
    }
    if (cov < minCov) {
      warnings.push({
        code: attr.code,
        name: facet.label || attr.name,
        coverage: Math.round(cov * 10) / 10,
        reason: `Заполненность ${Math.round(cov)}% ниже ориентира ${minCov}%; состав фильтров задан справочником`,
      });
    }

    filters.push({
      name: facet.label || attr.name,
      value: values,
      _code: attr.code,
      _counts: Object.fromEntries(counts),
      _order: attr.order ?? 0,
    });
  }

  filters.sort((a, b) => (a._order - b._order) || a.name.localeCompare(b.name, 'ru'));

  return {
    filters: filters.map(({ name, value }) => ({ name, value })),
    debug: filters,
    excluded,
    warnings,
  };
}

/**
 * Значения фильтров одного товара. Всегда массив: мультизначный атрибут
 * ставит товар сразу в несколько значений фильтра.
 */
export function assignFilterValues(rec, dict, debugFacets) {
  const out = {};
  for (const f of debugFacets) {
    const v = rec.attrs[f._code];
    if (v == null) continue;
    const attr = dict.byCode.get(f._code);
    const facet = attr.facet;
    if (facetKind(attr) === 'range') {
      const n = numericOf(v);
      if (n == null) continue;
      const maxLo = Math.max(...f.value.map(x => parseFloat(x)));
      const isLast = !!facet.open_last && bucketLo(n, facet.step) === maxLo;
      out[f.name] = [bucketLabel(n, { ...facet, kind: 'range' }, { isLast })];
    } else {
      const labels = [];
      for (const p of valueList(v)) {
        const lab = displayValue(attr, p);
        if (lab && !labels.includes(lab)) labels.push(lab);
      }
      if (labels.length) out[f.name] = labels;
    }
  }
  return out;
}
