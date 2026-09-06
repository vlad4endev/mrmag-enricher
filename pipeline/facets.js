/** Фильтры строго по facet.* справочника. Вид и шаг из справочника, не из данных. */

import { formatAttrValue, hasStrictEnum, looksLikeEnumFragment, unifyEnumValues } from './types.js';

/** Доля товаров на одно значение, выше которой фильтр перестаёт различать товары. */
const DOMINANT_SHARE = 95;

/**
 * Источники значений для filters_*.json: только графа характеристик карточки.
 * S1 — annotation, S2 — description как замена пустой annotation, S0 — бренд из имени.
 * S3/model/retailer в фильтры сайта не едут (остаются в attrs/аннотации при необходимости).
 */
export const DEFAULT_FILTER_SOURCES = Object.freeze(['S0', 'S1', 'S2']);

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

/**
 * Вид фильтра следует из типа атрибута, а не из разброса данных.
 * Счётная величина — перечень: «2, 3, 4 скорости», а не «2-2.2» и «2.8-3».
 */
export function facetKind(attr) {
  const kind = attr.facet?.kind;
  if (attr.type === 'boolean') {
    if (kind === 'boolean' || kind === 'enum' || !kind) return 'boolean';
  }
  if (kind === 'boolean') return 'boolean';
  if (kind === 'range' && (attr.type === 'integer' || isDiscreteCount(attr))) return 'enum';
  return kind;
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : String(+n.toFixed(3));
}

function hasBreaks(facet) {
  return Array.isArray(facet?.breaks) && facet.breaks.length >= 2;
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
  if (facet.kind !== 'range') return String(value);
  if (hasBreaks(facet)) {
    return labelFromBreaks(value, facet.breaks, !!facet.open_last && isLast);
  }
  const step = facet.step;
  if (!(step > 0)) throw new Error(`facet.step обязателен для range (${facet.label})`);
  const lo = bucketLo(value, step, facet.origin);
  if (facet.open_last && isLast) return `${fmt(lo)}+`;
  return `${fmt(lo)}-${fmt(lo + step)}`;
}

function assertRangeFacet(facet, name) {
  if (hasBreaks(facet)) return;
  if (!(facet.step > 0)) {
    throw new Error(`facet.step или facet.breaks обязателен для range (${name})`);
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

/** Значения атрибута как список: multi даёт несколько, single — одно. */
function valueList(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v.filter(x => x != null && x !== '') : [v];
}

/**
 * Строит filters.json из нормализованных attrs товаров.
 * Источник attrs — характеристики (annotation), не проза описания.
 * Состав — только facet.enabled справочника: универсальный набор
 * «тип товара, назначение» внутри категории ничего не различает.
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

    const filled = recs.filter(r => r.attrs[attr.code] != null && filterSourceAllowed(r, attr.code, config));
    const cov = (filled.length / total) * 100;

    const counts = new Map();
    const kind = facetKind(attr);

    if (kind === 'range') {
      assertRangeFacet(facet, facet.label || attr.name);
      const nums = filled.map(r => numericOf(r.attrs[attr.code])).filter(v => v != null);
      if (!nums.length) continue;
      const maxLo = Math.max(...nums.map(v => rangeLo(v, facet)));

      for (const v of nums) {
        const isLast = !!facet.open_last && rangeLo(v, facet) === maxLo;
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
    } else if (kind === 'boolean') {
      // Только true/false → «Есть»/«Нет». unknown не попадает в фильтр.
      for (const r of filled) {
        const v = r.attrs[attr.code];
        if (v !== true && v !== false) continue;
        const lab = displayValue(attr, v);
        counts.set(lab, (counts.get(lab) || 0) + 1);
      }
    } else {
      // Мультизначный атрибут даёт товару несколько значений фильтра:
      // «механическое, кнопочное» попадает и в «Механическое», и в «Кнопочное».
      // Strict enum: значения вне value_aliases не создают filter value.
      // Без aliases — не собираем произвольные строки (иначе «Белое стекло»/LED).
      const strict = hasStrictEnum(attr);
      if (!strict && (attr.type === 'enum' || attr.type === 'text')) {
        warnings.push({
          code: attr.code,
          name: facet.label || attr.name,
          reason: 'facet.enabled без value_aliases — enum-фильтр пропущен, иначе сырой зоопарк значений',
        });
        continue;
      }
      const allowed = strict
        ? new Set(Object.keys(attr.value_aliases).map(k => displayValue(attr, k)))
        : null;
      for (const r of filled) {
        const seen = new Set();
        for (const p of valueList(r.attrs[attr.code])) {
          // displayValue уже алиасит; пустая строка = вне словаря при strict.
          const lab = displayValue(attr, p);
          if (!lab || seen.has(lab)) continue;
          if (allowed && !allowed.has(lab)) continue;
          // Без канонов — всё равно не пускаем «Зоны свежести - нет» на витрину.
          if (!allowed && looksLikeEnumFragment(lab)) continue;
          if (!allowed && /^(?:нет|да|есть|имеется|yes|no)$/i.test(lab)) continue;
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
 * Только графа характеристик (S0/S1/S2) — см. filterSourceAllowed.
 */
export function assignFilterValues(rec, dict, debugFacets, config = {}) {
  const out = {};
  for (const f of debugFacets) {
    const v = rec.attrs[f._code];
    if (v == null) continue;
    if (!filterSourceAllowed(rec, f._code, config)) continue;
    const attr = dict.byCode.get(f._code);
    const facet = attr.facet;
    if (facetKind(attr) === 'range') {
      const n = numericOf(v);
      if (n == null) continue;
      const maxLo = Math.max(...f.value.map(x => parseFloat(x)));
      const isLast = !!facet.open_last && rangeLo(n, facet) === maxLo;
      out[f.name] = [bucketLabel(n, { ...facet, kind: 'range' }, { isLast })];
    } else if (facetKind(attr) === 'boolean') {
      if (v !== true && v !== false) continue;
      out[f.name] = [displayValue(attr, v)];
    } else {
      // Только значения из каталожного фасета — иначе товар ссылается на пункт,
      // которого нет в filters_*.json, и витрина разъезжается.
      const allowed = new Set(f.value);
      const labels = [];
      for (const p of valueList(v)) {
        const lab = displayValue(attr, p);
        if (!lab || labels.includes(lab) || !allowed.has(lab)) continue;
        labels.push(lab);
      }
      if (labels.length) out[f.name] = labels;
    }
  }
  return out;
}
