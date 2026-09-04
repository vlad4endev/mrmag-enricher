/**
 * export_v2.js — выгрузка «JSON v2»: фасеты каталога и товары с готовым
 * description_html. Формат — как products_v2 / filters_v2 заказчика:
 * checkbox-фасеты, числа свёрнуты в диапазоны, enum сведён к одному написанию.
 *
 * Одно и то же значение у товара и в списке каталога считает одна функция.
 */

import { v2FacetSpecKeys, specKeyFromAttr } from './pipeline/v2.js';
import { CODE_TO_SPEC } from './pipeline/schema.js';
import { displayEnum, valueFold } from './pipeline/types.js';

// Числовое поле схемы кончается единицей измерения: она уходит и в имя фасета
// («Объем, л»), и в строку характеристики («Объем: 25 л»).
const UNIT = {
  л: 'л', мл: 'мл', кг: 'кг', г: 'г', мм: 'мм', см: 'см', м: 'м', м2: 'м²', мм2: 'мм²',
  вт: 'Вт', квт: 'кВт', в: 'В', а: 'А', ач: 'А·ч', гц: 'Гц', дб: 'дБ', к: 'К', лм: 'лм',
  мес: 'мес', ч: 'ч', мин: 'мин', бар: 'бар', нм: 'Н·м', дюйм: 'дюйм',
  процент: '%', шт: 'шт', ip: 'IP',
  об_мин: 'об/мин', кг_сут: 'кг/сут', л_цикл: 'л/цикл', л_мин: 'л/мин',
  м2_л: 'м²/л', кг_м2: 'кг/м²',
};

// «да/нет» в схеме — это «Есть/Нет» в фильтре: галочка «да» читается как ошибка.
const YESNO = { да: 'Есть', нет: 'Нет' };

const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
const num = v => String(+(+v).toFixed(3));

/** Ключ схемы → подпись и единица: объем_общий_л → {label:'Объем общий', unit:'л'}. */
export function splitKey(key) {
  const parts = String(key).split('_');
  for (const take of [2, 1]) {
    if (parts.length <= take) continue;      // из имени поля нельзя вычесть всё
    const unit = UNIT[parts.slice(-take).join('_')];
    if (unit) return { label: cap(parts.slice(0, -take).join(' ')), unit };
  }
  return { label: cap(parts.join(' ')), unit: '' };
}

const facetName = key => {
  const { label, unit } = splitKey(key);
  return unit ? `${label}, ${unit}` : label;
};

// Пока значений мало, диапазоны не нужны: шесть объёмов читаются лучше, чем
// шесть интервалов вокруг них. 256 холодильников дают 60 разных объёмов —
// вот там перечисление и превращается в бесполезные 60 галочек.
const DISCRETE_MAX = 6;
const TARGET_BUCKETS = 8;
const NICE = [1, 2, 2.5, 5, 10];

/** Ключи, которые выглядят как паспорт товара, а не как фасет каталога. */
const SKIP_SPEC = new Set(['модель', 'комплектация', 'артикул', 'sku']);
const MAX_ENUM = 24;
const MAX_AVG_LEN = 48;

/** Круглый шаг: ~1/8 разброса, подтянутый до 1/2/2.5/5/10 × 10^k. */
function niceStep(span) {
  if (!(span > 0)) return 1;
  const rough = span / TARGET_BUCKETS;
  const mag = 10 ** Math.floor(Math.log10(rough));
  for (const n of NICE) if (rough <= n * mag * 1.000001) return n * mag;
  return 10 * mag;
}

/**
 * Число → подпись фасета. Пока уникальных значений мало — как есть («12», «24»).
 * Дальше — корзины; шаг из справочника (facet.step), иначе niceStep по разбросу.
 * open_last из справочника даёт «1000+» на последнем бакете, как в эталоне.
 */
function bucketize(values, facet, mul = 1) {
  const uniq = [...new Set(values)].sort((a, b) => a - b);
  if (uniq.length <= DISCRETE_MAX) return num;
  if (facet?.kind === 'enum') return num;
  let step;
  let openLast = false;
  if (facet?.kind === 'range' && facet.step > 0) {
    step = facet.step * mul;
    openLast = !!facet.open_last;
  } else {
    step = niceStep(uniq[uniq.length - 1] - uniq[0]);
    if (step <= 1 && uniq.every(Number.isInteger)) return num;
  }
  const maxLo = Math.floor(uniq[uniq.length - 1] / step) * step;
  const dec = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const round = x => +x.toFixed(dec);
  return v => {
    const lo = round(Math.floor(Number(v) / step) * step);
    if (openLast && lo === round(maxLo)) return `${num(lo)}+`;
    return `${num(lo)}-${num(round(lo + step))}`;
  };
}

function attrBySpecKey(dict) {
  const map = new Map();
  if (!dict?.attrs) return map;
  for (const attr of dict.attrs) {
    map.set(specKeyFromAttr(attr).key, attr);
    const dest = CODE_TO_SPEC[attr.code];
    if (dest) map.set(typeof dest === 'object' ? dest.key : dest, attr);
  }
  return map;
}

function aliasFromAttr(attr, raw) {
  const aliases = attr?.value_aliases;
  if (!aliases) return null;
  const folded = valueFold(raw);
  for (const [canon, list] of Object.entries(aliases)) {
    if (valueFold(canon) === folded) return canon;
    if ((list || []).some(x => valueFold(x) === folded)) return canon;
  }
  return null;
}

/** Title Case для кириллицы, алиас справочника, «да/нет» → Есть/Нет. */
function formatString(v, attr) {
  const s = String(v ?? '').trim();
  if (!s) return s;
  const yn = YESNO[s.toLowerCase()];
  if (yn) return yn;
  const aliased = aliasFromAttr(attr, s);
  return displayEnum(aliased ?? s) || s;
}

function pickMode(list) {
  const c = new Map();
  for (const x of list) c.set(x, (c.get(x) || 0) + 1);
  return [...c].sort((a, b) =>
    b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0], 'ru'))[0][0];
}

/** Атлант/АТЛАНТ и чёрный/черный — одно значение фильтра. */
function unifyLabels(labels) {
  const groups = new Map();
  for (const lab of labels) {
    const k = valueFold(lab);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(lab);
  }
  const canon = new Map();
  for (const list of groups.values()) {
    const winner = pickMode(list);
    for (const x of list) canon.set(x, winner);
  }
  return canon;
}

function skipSpecKey(key) {
  const k = String(key || '').toLowerCase();
  if (SKIP_SPEC.has(k)) return true;
  return /(?:^|_)(?:модель|комплектация|артикул)$/.test(k);
}

function keepStringFacet(name, values) {
  if (/^(бренд|тип товара)$/i.test(String(name))) return true;
  if (values.length > MAX_ENUM) return false;
  const avg = values.reduce((s, x) => s + String(x).length, 0) / (values.length || 1);
  return avg <= MAX_AVG_LEN;
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** id товара — sku магазина; числовой отдаём числом, как в примере заказчика. */
const idOf = p => (/^\d+$/.test(String(p.sku ?? '')) ? Number(p.sku) : (p.sku ?? null));

/** Пустая строка в эталоне — граница абзаца, не пробел внутри одного <p>. */
function paras(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => `<p>${esc(s.replace(/\n+/g, ' '))}</p>`);
}

/**
 * Описание как страница товара из эталона: H1, лид, абзацы seo_description,
 * плюсы, затем характеристики. Пустые строки в тексте — границы абзацев,
 * иначе три абзаца эталона схлопнулись бы в один <p>.
 */
function descHtml(e) {
  const out = [];
  const h1 = String(e.h1 || '').trim();
  if (h1) out.push(`<h1>${esc(h1)}</h1>`);

  const intro = String(e.short_description || '').trim();
  if (intro) out.push(`<p>${esc(intro)}</p>`);

  const long = String(e.seo_description || '').trim();
  if (long && long !== intro) out.push(...paras(long));

  const bullets = (e.bullets || []).map(b => String(b).trim()).filter(Boolean);
  if (bullets.length) out.push(`<ul>${bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>`);

  const li = Object.entries(e.specs || {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => {
      const { label, unit } = splitKey(k);
      const val = typeof v === 'number'
        ? `${num(v)}${unit ? ` ${unit}` : ''}`
        : (YESNO[String(v).toLowerCase()] || String(v));
      return `<li>${esc(label)}: ${esc(val)}</li>`;
    });
  if (li.length) out.push(`<ul>${li.join('')}</ul>`);
  return out.join('');
}

const keywords = e => {
  const list = (e.seo_keywords || []).length ? e.seo_keywords : (e.search_aliases || []);
  return [...new Set(list.map(s => String(s).trim()).filter(Boolean))].join(', ');
};

/**
 * Товары и фасеты раздела: { filters: [{name, value:[…]}], products: [{…}] }.
 * Необработанные позиции пропускаются — без enriched у товара нет ни
 * description_html, ни характеристик, то есть в v2 ему нечем быть.
 */
export const enrichedRows = rows => (rows || []).filter(r => r && r.enriched && r.enriched.specs);

/**
 * Разброс числовых полей по всему набору и функция «число/строка → подпись фасета».
 * Диапазон нельзя выбрать по одному товару, поэтому сначала весь набор.
 * Если передан dict — шаг range-фасета только из facet.step, без niceStep.
 */
export function facetScale(enriched, dict) {
  const byKey = attrBySpecKey(dict);
  const nums = new Map();
  const numKey = new Map();
  const strings = new Map();
  for (const r of enriched) {
    for (const [k, v] of Object.entries(r.enriched.specs)) {
      if (v == null || v === '') continue;
      const name = facetName(k);
      if (typeof v === 'number') {
        if (!nums.has(name)) nums.set(name, []);
        nums.get(name).push(v);
        if (!numKey.has(name)) numKey.set(name, k);
      } else {
        if (!strings.has(name)) strings.set(name, []);
        strings.get(name).push(formatString(v, byKey.get(k)));
      }
    }
  }

  const bucket = new Map();
  for (const [name, vs] of nums) {
    const key = numKey.get(name);
    const attr = byKey.get(key);
    const mul = attr ? (specKeyFromAttr(attr).mul || 1) : 1;
    bucket.set(name, bucketize(vs, attr?.facet, mul));
  }
  const canon = new Map();
  for (const [name, list] of strings) canon.set(name, unifyLabels(list));

  const valueOf = (name, v, key) => {
    if (typeof v === 'number') return bucket.get(name)(v);
    const lab = formatString(v, byKey.get(key));
    return canon.get(name)?.get(lab) || lab;
  };
  return { nums, valueOf };
}

/**
 * Фасеты из обогащения со счётчиками — для filters_(id).json, где у фильтра есть
 * код поля, тип и количество товаров на значение. В v2 та же раскладка идёт без
 * счётчиков: там формат импорта, а не витрина.
 */
export function specFacets(rows, dict) {
  const enriched = enrichedRows(rows);
  if (!enriched.length) return [];
  const { nums, valueOf } = facetScale(enriched, dict);

  // Порядок полей — как в схеме: он осмысленный, и фильтр читается сверху вниз.
  const facets = new Map();
  for (const r of enriched) {
    for (const k of Object.keys(r.enriched.specs)) {
      if (skipSpecKey(k)) continue;
      if (!facets.has(k)) facets.set(k, new Map());
    }
  }
  for (const r of enriched) {
    for (const [k, v] of Object.entries(r.enriched.specs)) {
      if (v == null || v === '') continue;
      if (skipSpecKey(k)) continue;
      const counts = facets.get(k);
      if (!counts) continue;
      const label = valueOf(facetName(k), v, k);
      counts.set(label, (counts.get(label) || 0) + 1);
    }
  }

  const lead = s => parseFloat(s);
  return [...facets].filter(([, counts]) => counts.size).map(([key, counts]) => {
    const name = facetName(key);
    const numeric = nums.has(name);
    const labels = [...counts.keys()];
    if (!numeric && !keepStringFacet(name, labels)) return null;
    const raw = numeric ? enriched.map(r => r.enriched.specs[key]).filter(v => typeof v === 'number') : [];
    const filled = [...counts.values()].reduce((a, b) => a + b, 0);
    return {
      code: key, name, type: 'checkbox', source: 'enriched',
      values: [...counts].map(([value, count]) => ({ value, count }))
        .sort((a, b) => (numeric ? lead(a.value) - lead(b.value)
          : b.count - a.count || String(a.value).localeCompare(String(b.value), 'ru'))),
      // Крайние значения по сырым числам: подписи фасета — это уже интервалы,
      // и слайдер по ним не построить.
      ...(numeric && raw.length ? { min: Math.min(...raw), max: Math.max(...raw) } : {}),
      ...(filled < enriched.length ? { without_value: enriched.length - filled } : {}),
    };
  }).filter(Boolean);
}

function resolveFacetKeys(opts = {}) {
  if (opts.facetKeys instanceof Set) return opts.facetKeys;
  if (Array.isArray(opts.facetKeys)) return new Set(opts.facetKeys);
  if (opts.dict) return v2FacetSpecKeys(opts.dict);
  return null;
}

export function buildV2(rows, opts = {}) {
  const enriched = enrichedRows(rows);
  const { nums, valueOf } = facetScale(enriched, opts.dict);
  const facetKeys = resolveFacetKeys(opts);

  const products = enriched.map(r => {
    const e = r.enriched;
    const filters = {};
    for (const [k, v] of Object.entries(e.specs)) {
      if (v == null || v === '') continue;
      if (skipSpecKey(k)) continue;
      if (facetKeys && !facetKeys.has(k)) continue;
      const name = facetName(k);
      filters[name] = valueOf(name, v, k);
    }
    return {
      id: idOf(r),
      name: r.name || e.seo_title || '',
      meta_keywords: keywords(e),
      description_html: descHtml(e),
      filters,
    };
  });

  // Список фасета собирается из выгруженных товаров, а не считается заново:
  // так в каталоге не может оказаться значения, которого нет ни у кого.
  const facets = new Map();
  for (const p of products) {
    for (const [name, v] of Object.entries(p.filters)) {
      if (!facets.has(name)) facets.set(name, new Set());
      facets.get(name).add(v);
    }
  }

  const dropped = new Set();
  const lead = s => parseFloat(s);
  const filters = [...facets].map(([name, set]) => {
    const values = [...set];
    const numeric = nums.has(name);
    if (!numeric && !keepStringFacet(name, values)) {
      dropped.add(name);
      return null;
    }
    return {
      name,
      value: values.sort((a, b) =>
        numeric ? lead(a) - lead(b) : String(a).localeCompare(String(b), 'ru')),
    };
  }).filter(Boolean);

  if (dropped.size) {
    for (const p of products) {
      for (const name of dropped) delete p.filters[name];
    }
  }

  return { filters, products };
}
