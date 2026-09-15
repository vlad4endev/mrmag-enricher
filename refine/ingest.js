/**
 * Приём готовых файлов обогащения. Форматы разные — внутри всегда rec пайплайна.
 * Основной прогон сюда не ходит: это вход доводки, не обогащения.
 */

import { loadConfig, loadDictionary, listDictionaries, hasDictionary, categoryName } from '../pipeline/dict.js';
import { dictForProducts, expectedDictCatId, resolveCatId } from '../pipeline/schema.js';
import { normalizeProduct, ingestPairs } from '../pipeline/normalize.js';
import { toPipelineProduct, applyEnrichedSpecs } from '../pipeline/export.js';
import { extractPairs } from '../pipeline/parse.js';
import { matchKey } from '../pipeline/match.js';
import { expectedFilters, isRangeBucketLabel } from '../pipeline/validate.js';
import { isBrandFilterKey, isBrandAttr, valueFold, aliasValue } from '../pipeline/types.js';
import { storefrontFilterAttrs } from '../pipeline/required_filters.js';
import { findDumpProduct } from '../pipeline/dumps.js';
import { markCategoryMismatch } from '../pipeline/category_mismatch.js';

const PRICE_RE = /^(?:цена|price)(?:\s*,\s*₽)?$/i;
const SKIP_META = new Set([
  'category', 'category_id', 'cat_id', 'url', 'generated_at', 'products_total',
  'enriched_total', 'filters', 'products', 'name', 'id',
]);

export function isPriceFilterKey(name) {
  return PRICE_RE.test(String(name || '').trim());
}

export function asProductList(payload) {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload.filter(p => p && typeof p === 'object');
  if (typeof payload !== 'object') return [];
  for (const key of ['products', 'items', 'rows', 'data']) {
    if (Array.isArray(payload[key])) {
      return payload[key].filter(p => p && typeof p === 'object');
    }
  }
  if (payload.id != null || payload.sku != null || payload.annotation_html || payload.filters) {
    return [payload];
  }
  return [];
}

function facetValues(item) {
  if (!item || typeof item !== 'object') return [];
  if (Array.isArray(item.value)) return item.value.map(v => String(v)).filter(Boolean);
  if (item.value != null && typeof item.value !== 'object') return [String(item.value)];
  if (Array.isArray(item.values)) {
    return item.values.map(v => {
      if (v == null) return '';
      if (typeof v === 'object') return String(v.value ?? v.label ?? v.name ?? '');
      return String(v);
    }).filter(Boolean);
  }
  return [];
}

export function asFilterList(payload) {
  if (payload == null) return { items: [], meta: {} };
  const meta = {};
  let raw = payload;
  if (typeof payload === 'object' && !Array.isArray(payload)) {
    meta.category_id = payload.category_id ?? payload.cat_id ?? null;
    meta.category = payload.category ?? payload.category_name ?? null;
    raw = payload.filters ?? payload.facets ?? payload.items ?? payload;
  }
  if (Array.isArray(raw)) {
    return {
      items: raw.filter(x => x && typeof x === 'object' && (x.name || x.code || x.label)).map(x => ({
        name: String(x.name || x.label || x.code || '').trim(),
        code: x.code || null,
        values: facetValues(x),
      })).filter(x => x.name),
      meta,
    };
  }
  if (raw && typeof raw === 'object') {
    const items = [];
    for (const [name, val] of Object.entries(raw)) {
      if (SKIP_META.has(name)) continue;
      const values = Array.isArray(val)
        ? val.map(v => (v && typeof v === 'object' ? String(v.value ?? v.label ?? '') : String(v))).filter(Boolean)
        : val != null ? [String(val)] : [];
      items.push({ name, values });
    }
    return { items, meta };
  }
  return { items: [], meta };
}

export function catIdFromFilename(name) {
  const s = String(name || '');
  const m = s.match(/(?:products|filters|data)(?:_v2)?_(\d+)/i)
    || s.match(/(?:^|[^\d])(\d{3,5})(?:\.[^.]+)?$/);
  return m ? m[1] : null;
}

export function detectShape(products) {
  const list = asProductList(products);
  if (!list.length) return 'empty';
  let customer = 0;
  let v2 = 0;
  let catalog = 0;
  for (const p of list.slice(0, 40)) {
    if (p.annotation_html && p.filters && typeof p.filters === 'object') customer++;
    if (p.name && p.description_html && p.filters && !p.annotation_html) v2++;
    if (p.annotation || p.product_url || p.sku || p.enriched) catalog++;
  }
  if (customer >= v2 && customer >= catalog && customer > 0) return 'customer';
  if (v2 > customer && v2 >= catalog) return 'v2';
  return 'catalog';
}

export function resolveFilterAttr(name, dict) {
  const n = String(name || '').trim();
  if (!n) return null;
  if (isBrandFilterKey(n) || isBrandAttr({ name: n, code: n })) {
    return { special: 'brand', attr: dict.byCode.get('brand') || null };
  }
  if (isPriceFilterKey(n)) return { special: 'price', attr: null };
  const expected = expectedFilters(dict);
  const fold = valueFold(n);
  const exact = expected.find(f => valueFold(f.name) === fold);
  if (exact) return { special: null, attr: dict.byCode.get(exact.code) };
  const matched = matchKey(n, dict, { fuzzyMin: 0.92 });
  if (matched?.attr && matched.attr.tier !== 'X') {
    return { special: null, attr: matched.attr };
  }
  return { special: null, attr: null };
}

function scoreDictByFilters(filterNames, dict) {
  if (!filterNames.length) return 0;
  let hit = 0;
  for (const name of filterNames) {
    if (isBrandFilterKey(name) || isPriceFilterKey(name)) continue;
    const resolved = resolveFilterAttr(name, dict);
    if (resolved?.attr && !resolved.special) hit += resolved.attr.facet?.enabled ? 1 : 0.4;
  }
  return hit;
}

export function detectCategory({ products, filters, filenames = [], hint = null, root } = {}) {
  const list = asProductList(products);
  const filterPack = asFilterList(filters);
  const names = [
    hint,
    filterPack.meta.category_id,
    filterPack.meta.category,
    ...filenames.map(catIdFromFilename),
    ...list.slice(0, 20).map(p => p.category_id ?? p.cat_id ?? p.category),
  ].filter(v => v != null && String(v).trim() !== '');

  for (const n of names) {
    const id = resolveCatId(n, root) || expectedDictCatId(list, n, root);
    if (id && hasDictionary(id, root)) {
      return { id: String(id), name: categoryName(id, root), how: 'hint' };
    }
  }

  const byProducts = dictForProducts(list, hint, root);
  if (byProducts?.catId) {
    return { id: String(byProducts.catId), name: categoryName(byProducts.catId, root), how: 'products' };
  }

  const filterNames = filterPack.items.map(i => i.name);
  if (filterNames.length) {
    let best = null;
    for (const d of listDictionaries(root)) {
      try {
        const dict = loadDictionary(d.id, root);
        const score = scoreDictByFilters(filterNames, dict);
        if (!best || score > best.score) best = { id: String(d.id), name: d.name, score };
      } catch { /* */ }
    }
    if (best && best.score >= 3) {
      return { id: best.id, name: best.name, how: 'filters', score: best.score };
    }
  }

  return null;
}

function filterPairs(filtersObj, dict) {
  if (!filtersObj || typeof filtersObj !== 'object' || Array.isArray(filtersObj)) return [];
  const pairs = [];
  for (const [name, raw] of Object.entries(filtersObj)) {
    const resolved = resolveFilterAttr(name, dict);
    if (!resolved?.attr || resolved.special) continue;
    const vals = Array.isArray(raw) ? raw : [raw];
    for (const v of vals) {
      if (v == null || v === '') continue;
      const s = String(v);
      if (isRangeBucketLabel(s)) continue;
      const aliased = aliasValue(resolved.attr, s);
      pairs.push({
        key: resolved.attr.name,
        value: aliased || s,
        source: 'S2',
      });
    }
  }
  return pairs;
}

function htmlPairs(html, dict) {
  const s = String(html || '').trim();
  if (!s) return [];
  const wrapped = /</.test(s) ? s : s.split(/\n+/).map(l => `${l}<br>`).join('');
  return extractPairs(wrapped, dict).map(p => ({ ...p, source: p.source || 'S1' }));
}

const DUMP_GENERIC_TOKEN = /^(стиральн[а-яё]*|машин[а-яё]*|холодильник[а-яё]*|вытяжк[а-яё]*|бел[а-яё]*|чёрн[а-яё]*|черн[а-яё]*|фронтальн[а-яё]*|вертикальн[а-яё]*|отдельностоящ[а-яё]*|встраиваем[а-яё]*|автоматическ[а-яё]*|для|кг|см|мм)$/i;

/** Дамп по SKU подмешиваем только если это та же модель, а не чужой товар с тем же id. */
export function dumpNameMatches(dumpName, productName) {
  const toks = (s) => String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-z0-9а-я]+/i)
    .filter(t => t.length >= 3 && !DUMP_GENERIC_TOKEN.test(t));
  const dumpToks = new Set(toks(dumpName));
  const productToks = toks(productName);
  if (!dumpToks.size || !productToks.length) return false;
  return productToks.some(t => dumpToks.has(t));
}

function dumpTitle(dump) {
  if (!dump || typeof dump !== 'object') return '';
  return dump.name || dump.title || dump.model || dump.sku_name || '';
}

function fillFromDump(rec, dict, config, root) {
  const dump = findDumpProduct(dict.catId, rec.id ?? rec.sku, root);
  if (!dump) return false;
  const recName = rec.name || rec._uploaded?.name || '';
  if (!dumpNameMatches(dumpTitle(dump), recName)) return false;
  const src = toPipelineProduct(dump);
  if (!src.annotation && !src.description) return false;
  const tmp = normalizeProduct(src, dict, config);
  let n = 0;
  for (const [code, val] of Object.entries(tmp.attrs || {})) {
    if (val == null || val === '') continue;
    if (rec.attrs[code] != null && rec.attrs[code] !== '') continue;
    rec.attrs[code] = val;
    rec.provenance[code] = tmp.provenance?.[code] || { level: 'S1', raw: 'dump', how: 'refine_dump' };
    n++;
  }
  if (n) rec.flags.push('refine_dump');
  return n > 0;
}

function withFilterFacts(raw, dict) {
  const extra = [];
  const filters = raw?.filters;
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return raw;
  for (const [name, val] of Object.entries(filters)) {
    const resolved = resolveFilterAttr(name, dict);
    if (!resolved?.attr || resolved.special) continue;
    const vals = Array.isArray(val) ? val : [val];
    for (const v of vals) {
      if (v == null || v === '') continue;
      if (isRangeBucketLabel(String(v))) continue;
      extra.push(`${resolved.attr.name}: ${v}`);
    }
  }
  if (!extra.length) return raw;
  const block = extra.join('\n');
  const annotation = [raw.annotation, block].filter(Boolean).join('\n');
  const htmlExtra = extra.map(line => `<li>${line}</li>`).join('');
  let annotation_html = raw.annotation_html || '';
  if (annotation_html && /<\/ul>/i.test(annotation_html)) {
    annotation_html = annotation_html.replace(/<\/ul>/i, `${htmlExtra}</ul>`);
  } else if (annotation_html) {
    annotation_html = `${annotation_html}<ul>${htmlExtra}</ul>`;
  } else {
    annotation_html = `<ul>${htmlExtra}</ul>`;
  }
  return { ...raw, annotation, annotation_html };
}

export function ingestProduct(raw, dict, config, { root } = {}) {
  const uploadedFilters = (raw.filters && typeof raw.filters === 'object' && !Array.isArray(raw.filters))
    ? { ...raw.filters }
    : {};
  const src = toPipelineProduct(withFilterFacts(raw, dict));
  const rec = normalizeProduct(src, dict, config);
  rec.name = raw.name || rec.name;
  rec.sku = raw.sku ?? raw.id ?? rec.id;
  rec.price = Number.isFinite(Number(raw.price)) ? Number(raw.price) : rec.price;
  rec._uploaded = {
    filters: uploadedFilters,
    annotation_html: raw.annotation_html || '',
    description_html: raw.description_html || raw.seo_description || '',
    meta_keywords: raw.meta_keywords || raw.enriched?.meta_keywords || '',
    web_info: raw.web_info ?? raw.enriched?.web_info ?? null,
    name: raw.name || rec.name || '',
  };
  rec._enriched = raw.enriched && typeof raw.enriched === 'object' ? raw.enriched : {
    description: stripTags(rec._uploaded.description_html),
    meta_keywords: rec._uploaded.meta_keywords,
    web_info: rec._uploaded.web_info,
    bullets: raw.bullets || raw.enriched?.bullets || null,
  };

  ingestPairs(rec, htmlPairs(rec._uploaded.annotation_html, dict), dict, config);
  ingestPairs(rec, htmlPairs(rec._uploaded.description_html, dict), dict, config);
  ingestPairs(rec, filterPairs(rec._uploaded.filters, dict), dict, config);
  applyEnrichedSpecs(rec, raw.enriched?.specs || raw.specs, dict, config);
  if (root) fillFromDump(rec, dict, config, root);
  markCategoryMismatch(rec, dict.catId);
  return rec;
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function ingestPack({
  products,
  filters = null,
  filenames = [],
  category = null,
  config = null,
  root,
} = {}) {
  const list = asProductList(products);
  if (!list.length) {
    throw Object.assign(new Error('Нет товаров в загруженных файлах'), { status: 400 });
  }
  const cfg = config || loadConfig(root);
  const detected = detectCategory({ products: list, filters, filenames, hint: category, root });
  if (!detected?.id) {
    throw Object.assign(new Error('Не удалось определить категорию — укажите раздел вручную'), { status: 422 });
  }
  const dict = loadDictionary(detected.id, root);
  const recs = list.map(p => ingestProduct(p, dict, cfg, { root }));
  const filterPack = asFilterList(filters);
  return {
    dict,
    config: cfg,
    category: detected,
    shape: detectShape(list),
    recs,
    filters: filterPack,
    products_total: recs.length,
  };
}

export function expectedStorefront(dict) {
  return storefrontFilterAttrs(dict).map(a => ({
    code: a.code,
    name: a.facet?.label || a.name,
    required: a.facet?.required === true || a.highlight === true || a.tier === 'A',
    kind: a.facet?.kind || a.type,
  }));
}
