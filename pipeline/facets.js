/** Фильтры строго по facet.* справочника. Вид и шаг из справочника, не из данных. */

import { formatAttrValue, hasStrictEnum, looksLikeEnumFragment, unifyEnumValues } from './types.js';

/** Доля товаров на одно значение, выше которой фильтр перестаёт различать товары. */
const DOMINANT_SHARE = 95;

/**
 * Источники значений для filters_*.json — те же, что для annotation_html:
 * исходник (S0/S1/S2) и внешние страницы (S3/retailer). Вывод модели (model)
 * в витрину не едет: это не факт из карточки и не факт с сайта.
 */
export const DEFAULT_FILTER_SOURCES = Object.freeze([
  'S0', 'S1', 'S2', 'S3',
  'source_json', 'manufacturer', 'official_product_page',
  'trusted_retailer', 'major_retailer', 'retailer', 'distributor',
]);

/**
 * Можно ли брать attrs[code] в каталожный фильтр.
 * Записи без provenance (юнит-фикстуры) — допускаются; пустой level при живом
 * provenance — нет (неизвестный источник).
 */
export function filterSourceAllowed(rec, code, config = {}) {
  const allowed = config.filter_sources || DEFAULT_FILTER_SOURCES;
  const set = allowed instanceof Set ? allowed : new Set(allowed);
  const bag = rec?.provenance;
  if (!bag || typeof bag !== 'object' || !Object.keys(bag).length) return true;
  const level = bag[code]?.level;
  if (!level) return false;
  return set.has(level);
}

/**
 * Счётные величины без единицы (скорости, камеры, программы): перечень
 * точных значений, а не бакеты «2-2.2».
 */
function isDiscreteCount(attr) {
  if (attr.unit) return false;
  const r = attr.valid_range;
  if (!Array.isArray(r) || r.length < 2) return false;
  const lo = Number(r[0]);
  const hi = Number(r[1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
  return hi - lo <= 20 && lo >= 0 && Number.isInteger(lo) && Number.isInteger(hi);
}

function hasExplicitBuckets(facet) {
  return Array.isArray(facet?.buckets) && facet.buckets.length > 0;
}

/**
 * Вид фильтра следует из типа атрибута, а не из разброса данных.
 * Счётная величина — перечень: «2, 3, 4 скорости», а не «2-2.2» и «2.8-3».
 * Явные buckets / int_enum из filters_spec не схлопываются в enum.
 */
export function facetKind(attr) {
  const kind = attr.facet?.kind;
  if (kind === 'int_enum') return 'int_enum';
  if (attr.type === 'boolean') {
    if (kind === 'boolean' || kind === 'enum' || !kind) return 'boolean';
  }
  if (kind === 'boolean') return 'boolean';
  if (kind === 'range' && hasExplicitBuckets(attr.facet)) return 'range';
  if (kind === 'range' && hasBreaks(attr.facet)) return 'range';
  if (kind === 'range' && (attr.type === 'integer' || isDiscreteCount(attr))) return 'enum';
  return kind;
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : String(+n.toFixed(3));
}

function hasBreaks(facet) {
  return Array.isArray(facet?.breaks) && facet.breaks.length >= 2;
}

function fmtBucketNum(n) {
  return Number.isInteger(n) ? String(n) : String(+n.toFixed(3));
}

/** Явные buckets spec → {label, min, max}; иначе из breaks. */
export function facetBuckets(facet) {
  if (hasExplicitBuckets(facet)) {
    return facet.buckets.map(b => ({
      label: b.label,
      min: b.min == null || b.min === '' ? -Infinity : Number(b.min),
      max: b.max == null || b.max === '' ? Infinity : Number(b.max),
    }));
  }
  if (hasBreaks(facet)) {
    const b = facet.breaks.map(Number);
    const out = [];
    for (let i = 0; i < b.length - 1; i++) {
      out.push({
        label: `${fmtBucketNum(b[i])}-${fmtBucketNum(b[i + 1])}`,
        min: b[i],
        max: b[i + 1],
      });
    }
    if (facet.open_last) {
      out.push({
        label: `${fmtBucketNum(b[b.length - 1])}+`,
        min: b[b.length - 1],
        max: Infinity,
      });
    }
    return out;
  }
  return null;
}

/**
 * left_closed: интервал [min; max), значение на границе — в правый бакет.
 * open_last / max=null — открытый последний.
 */
export function matchBucket(value, facet) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const buckets = facetBuckets(facet);
  if (!buckets?.length) return null;
  const leftClosed = (facet.bound_rule || 'left_closed') !== 'right_closed';
  const hits = buckets.filter((b) => {
    if (leftClosed) return n >= b.min && n < b.max;
    return n > b.min && n <= b.max;
  });
  if (!hits.length) return null;
  hits.sort((a, b) => b.min - a.min);
  return hits[0].label;
}

export function toIntEnum(value, facet = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const round = facet.round || 'ceil';
  let i;
  if (round === 'floor') i = Math.floor(n);
  else if (round === 'nearest') i = Math.round(n);
  else i = Math.ceil(n);
  const allowed = facet.int_values;
  if (Array.isArray(allowed) && allowed.length) {
    if (!allowed.map(Number).includes(i)) return null;
  }
  return String(i);
}

/** 850 мм, записанные без единицы, не должны попадать в фильтр «…, см». */
export function coerceFacetNumber(n, attr) {
  if (!Number.isFinite(n)) return n;
  if (attr?.unit === 'см' && n >= 400) return n / 10;
  if (attr?.unit === 'кг' && n >= 400 && attr.code === 'load_max') return n;
  return n;
}

function trackUnmapped(bag, name, raw) {
  if (!bag || !name || raw == null || raw === '') return;
  const s = String(raw).trim();
  if (!s) return;
  if (!bag[name]) bag[name] = new Map();
  bag[name].set(s, (bag[name].get(s) || 0) + 1);
}

/**
 * Начало полузакрытого интервала [a; b).
 * origin смещает сетку: шум 34–44 при step 10, а не 30–40.
 */
function bucketLo(value, step, origin = 0) {
  const o = Number(origin) || 0;
  return Math.floor((Number(value) - o) / step) * step + o;
}

/** Подпись бакета по фиксированным границам эталона: [17.4, 22.5, 27.5, 32]. */
function labelFromBreaks(value, breaks, openLast) {
  const b = breaks.map(Number);
  if (openLast && value >= b[b.length - 1]) return `${fmt(b[b.length - 1])}+`;
  if (value >= b[b.length - 1]) {
    return `${fmt(b[b.length - 2])}-${fmt(b[b.length - 1])}`;
  }
  for (let i = b.length - 2; i >= 0; i--) {
    if (value >= b[i]) return `${fmt(b[i])}-${fmt(b[i + 1])}`;
  }
  return `${fmt(b[0])}-${fmt(b[1])}`;
}

function rangeLo(value, facet) {
  if (hasBreaks(facet)) {
    const b = facet.breaks.map(Number);
    if (value >= b[b.length - 1]) return b[b.length - (facet.open_last ? 1 : 2)];
    for (let i = b.length - 2; i >= 0; i--) {
      if (value >= b[i]) return b[i];
    }
    return b[0];
  }
  if (!(facet.step > 0)) throw new Error(`facet.step обязателен для range (${facet.label})`);
  return bucketLo(value, facet.step, facet.origin);
}

export function bucketLabel(value, facet, { isLast = false } = {}) {
  const fromSpec = matchBucket(value, facet);
  if (fromSpec) return fromSpec;
  if (hasExplicitBuckets(facet) || hasBreaks(facet)) return null;
  if (facet.kind !== 'range') return String(value);
  const step = facet.step;
  if (!(step > 0)) throw new Error(`facet.step обязателен для range (${facet.label})`);
  const lo = bucketLo(value, step, facet.origin);
  if (facet.open_last && isLast) return `${fmt(lo)}+`;
  return `${fmt(lo)}-${fmt(lo + step)}`;
}

function assertRangeFacet(facet, name) {
  if (hasExplicitBuckets(facet) || hasBreaks(facet)) return;
  if (!(facet.step > 0)) {
    throw new Error(`facet.step, facet.breaks или facet.buckets обязателен для range (${name})`);
  }
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

/** Пункты фильтра — только каноны value_aliases, в т.ч. class_scale (A+++…C). */
function filterAllowedLabels(attr) {
  const aliases = attr?.value_aliases;
  if (!aliases || typeof aliases !== 'object') return null;
  const keys = Object.keys(aliases);
  if (!keys.length) return null;
  if (!hasStrictEnum(attr) && attr.type !== 'class_scale') return null;
  return new Set(keys.map(k => displayValue(attr, k)).filter(Boolean));
}

/** Значения атрибута как список: multi даёт несколько, single — одно. */
function valueList(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v.filter(x => x != null && x !== '') : [v];
}

/**
 * Строит filters.json из нормализованных attrs товаров.
 * Источник — те же specs, что идут в annotation_html (S0–S3).
 * Состав — только facet.enabled / не not_a_filter.
 * Для range: [min; max) по buckets spec; пустые бакеты не создаются.
 * Несопоставленные значения — в debug.unmapped, не на витрину.
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
  const unmapped = {};

  for (const attr of dict.attrs) {
    const facet = attr.facet || {};
    if (!facet.enabled || facet.status === 'not_a_filter') {
      if (facet.disabled_reason || facet.status === 'not_a_filter') {
        excluded.push({
          code: attr.code,
          name: attr.name,
          reason: facet.reason || facet.disabled_reason || 'not_a_filter',
        });
      }
      continue;
    }
    if (attr.tier === 'X') continue;

    const filled = recs.filter(r => r.attrs[attr.code] != null && filterSourceAllowed(r, attr.code, config));
    const cov = (filled.length / total) * 100;

    const counts = new Map();
    const kind = facetKind(attr);
    const fname = facet.label || attr.name;

    if (kind === 'range') {
      assertRangeFacet(facet, fname);
      const mapped = [];
      for (const r of filled) {
        const raw = numericOf(r.attrs[attr.code]);
        if (raw == null) continue;
        const n = coerceFacetNumber(raw, attr);
        const lab = matchBucket(n, facet) || (
          hasExplicitBuckets(facet) || hasBreaks(facet)
            ? null
            : bucketLabel(n, { ...facet, kind: 'range' })
        );
        if (!lab) {
          trackUnmapped(unmapped, fname, r.attrs[attr.code]);
          continue;
        }
        mapped.push(lab);
        counts.set(lab, (counts.get(lab) || 0) + 1);
      }
      if (!mapped.length) continue;
      if (counts.size > 8) {
        warnings.push({
          code: attr.code,
          name: fname,
          occupied: counts.size,
          reason: `Занятых бакетов ${counts.size} > 8; шаг задан справочником, пересчёт запрещён`,
        });
      }
    } else if (kind === 'int_enum') {
      for (const r of filled) {
        const raw = numericOf(r.attrs[attr.code]);
        if (raw == null) {
          trackUnmapped(unmapped, fname, r.attrs[attr.code]);
          continue;
        }
        const n = coerceFacetNumber(raw, attr);
        const lab = toIntEnum(n, facet);
        if (!lab) {
          trackUnmapped(unmapped, fname, r.attrs[attr.code]);
          continue;
        }
        counts.set(lab, (counts.get(lab) || 0) + 1);
      }
    } else if (kind === 'boolean') {
      for (const r of filled) {
        const v = r.attrs[attr.code];
        if (v !== true && v !== false) {
          trackUnmapped(unmapped, fname, v);
          continue;
        }
        const lab = displayValue(attr, v);
        counts.set(lab, (counts.get(lab) || 0) + 1);
      }
    } else {
      const allowed = filterAllowedLabels(attr);
      const strict = allowed != null;
      if (!strict && (attr.type === 'enum' || attr.type === 'text')) {
        warnings.push({
          code: attr.code,
          name: fname,
          reason: 'facet.enabled без value_aliases — enum-фильтр пропущен, иначе сырой зоопарк значений',
        });
        continue;
      }
      for (const r of filled) {
        const seen = new Set();
        let any = false;
        for (const p of valueList(r.attrs[attr.code])) {
          const lab = displayValue(attr, p);
          if (!lab || seen.has(lab)) continue;
          if (allowed && !allowed.has(lab)) {
            trackUnmapped(unmapped, fname, p);
            continue;
          }
          if (!allowed && looksLikeEnumFragment(lab)) {
            trackUnmapped(unmapped, fname, p);
            continue;
          }
          if (!allowed && /^(?:нет|да|есть|имеется|yes|no)$/i.test(lab)) {
            trackUnmapped(unmapped, fname, p);
            continue;
          }
          seen.add(lab);
          any = true;
          counts.set(lab, (counts.get(lab) || 0) + 1);
        }
        if (!any && valueList(r.attrs[attr.code]).length) {
          /* already tracked per value */
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

    const topShare = (Math.max(...counts.values()) / total) * 100;
    if (topShare > DOMINANT_SHARE) {
      warnings.push({
        code: attr.code,
        name: fname,
        share: Math.round(topShare * 10) / 10,
        reason: `Одно значение у ${Math.round(topShare)}% заполненных — фильтр не различает товары`,
      });
    }
    if (cov < minCov) {
      warnings.push({
        code: attr.code,
        name: fname,
        coverage: Math.round(cov * 10) / 10,
        reason: `Заполненность ${Math.round(cov)}% ниже ориентира ${minCov}%; состав фильтров задан справочником`,
      });
    }

    filters.push({
      name: fname,
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
    unmapped,
  };
}

/**
 * Значения фильтров одного товара. Всегда массив: мультизначный атрибут
 * ставит товар сразу в несколько значений фильтра.
 */
export function assignFilterValues(rec, dict, debugFacets, config = {}, unmapped = null) {
  const out = {};
  for (const f of debugFacets) {
    const v = rec.attrs[f._code];
    if (v == null) continue;
    if (!filterSourceAllowed(rec, f._code, config)) continue;
    const attr = dict.byCode.get(f._code);
    if (!attr) continue;
    const facet = attr.facet || {};
    if (facet.status === 'not_a_filter') continue;
    const kind = facetKind(attr);
    if (kind === 'range') {
      const raw = numericOf(v);
      if (raw == null) continue;
      const n = coerceFacetNumber(raw, attr);
      const lab = matchBucket(n, facet) || (
        hasExplicitBuckets(facet) || hasBreaks(facet)
          ? null
          : bucketLabel(n, { ...facet, kind: 'range' })
      );
      if (!lab || !f.value.includes(lab)) {
        trackUnmapped(unmapped, f.name, v);
        continue;
      }
      out[f.name] = [lab];
    } else if (kind === 'int_enum') {
      const raw = numericOf(v);
      if (raw == null) {
        trackUnmapped(unmapped, f.name, v);
        continue;
      }
      const lab = toIntEnum(coerceFacetNumber(raw, attr), facet);
      if (!lab || !f.value.includes(lab)) {
        trackUnmapped(unmapped, f.name, v);
        continue;
      }
      out[f.name] = [lab];
    } else if (kind === 'boolean') {
      if (v !== true && v !== false) {
        trackUnmapped(unmapped, f.name, v);
        continue;
      }
      out[f.name] = [displayValue(attr, v)];
    } else {
      const allowed = new Set(f.value);
      const labels = [];
      for (const p of valueList(v)) {
        const lab = displayValue(attr, p);
        if (!lab || labels.includes(lab)) continue;
        if (!allowed.has(lab)) {
          trackUnmapped(unmapped, f.name, p);
          continue;
        }
        labels.push(lab);
      }
      if (labels.length) out[f.name] = labels;
    }
  }
  return out;
}
