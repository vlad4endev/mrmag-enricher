/** Клиентская выгрузка: products_{id}.json и filters_{id}.json, как в эталоне. */

import { splitHtmlChunks } from './text.js';
import { assignFilterValues, buildFilters } from './facets.js';
import { renderCard, renderAnnotation, renderDescription, productTypeFor, annotationRows, MIN_ANNOTATION_ROWS } from './generate.js';
import { annotationText, annotationCase } from './types.js';
import { webInfoFrom } from './reviews.js';
import { normalizeProduct, ingestPairs } from './normalize.js';
import { specDest } from './schema.js';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}


/** Сжать HTML до эталонного вида: без переводов строк между тегами. */
export function compactHtml(html) {
  return String(html || '')
    .replace(/\r\n?/g, '\n')
    .replace(/>\s+</g, '><')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Сжать произвольный список в компактный <ul><li>Ключ: значение</li></ul>.
 * Клиентская аннотация собирается из нормализованных attrs (renderCard), не из сырого HTML.
 */
export function compactAnnotation(html) {
  const chunks = splitHtmlChunks(html);
  if (!chunks.length) return '';
  const lis = chunks.map((line) => {
    const m = String(line).match(/^(.+?)\s*[-–—:]\s*(.+)$/);
    if (m) return `<li>${esc(m[1].trim())}: ${esc(m[2].trim())}</li>`;
    return `<li>${esc(line)}</li>`;
  });
  return `<ul>${lis.join('')}</ul>`;
}

/* ---------------- meta_keywords ---------------- */

export const KEYWORDS = { min: 7, max: 9 };

/** Единицы в разговорной форме: «м3/ч», не «м³/ч»; «50 см», не «500 мм». */
function unitTalk(unit) {
  return String(unit || '').replace(/³/g, '3').replace(/²/g, '2').replace(/·/g, ' ');
}

/** Габарит в запросе — round-число: люди ищут «60 см», а не «59.6 см». */
const DIM_CODES = new Set(['width', 'height', 'depth']);

function typeGender(type) {
  const words = String(type || '').trim().split(/\s+/);
  if (words.length > 1) {
    const adj = words[0];
    if (/(ая|яя)$/.test(adj)) return 'f';
    if (/(ый|ий|ой)$/.test(adj)) return 'm';
    if (/(ое|ее)$/.test(adj)) return 'n';
  }
  const head = words[words.length - 1] || '';
  if (/[ая]$/.test(head)) return 'f';
  if (/[ое]$/.test(head)) return 'n';
  return 'm';
}

const ADJ_END = { f: /(ая|яя)$/, m: /(ый|ий|ой)$/, n: /(ое|ее)$/ };

/** «фронтальная» + «стиральная машина» → прилагательное впереди, если род совпал. */
function adjectiveFirst(value, type) {
  const last = String(value || '').trim().split(/\s+/).pop() || '';
  return ADJ_END[typeGender(type)].test(last);
}

function phraseFor(attr, value, type) {
  if (typeof value === 'number') {
    // Число без единицы не запрос: «стиральная машина 16» ничего не значит.
    if (!attr.unit) return null;
    const n = DIM_CODES.has(attr.code) ? Math.round(value) : value;
    return `${type} ${n} ${unitTalk(attr.unit)}`;
  }
  if (typeof value === 'boolean' || value == null || typeof value === 'object') return null;
  // Запятая внутри значения («отдельно стоящая, съемная крышка») разорвала бы
  // фразу на две: в запрос идёт только первая часть.
  const head = String(value).split(',')[0].trim();
  const v = annotationCase(attr, head);
  if (!v) return null;
  return adjectiveFirst(v, type) ? `${v} ${type}` : `${type} ${v}`;
}

/**
 * meta_keywords: 7–9 фраз через запятую. Каждая фраза — тип товара плюс одна
 * характеристика; все значения из нормализованных атрибутов, придумывать
 * запросы нельзя. Повторов нет, строчные буквы кроме брендов и моделей.
 */
export function metaKeywords(rec, dict, { root = '.' } = {}) {
  const type = productTypeFor(dict, root);
  const brand = rec.identity?.brand || rec.attrs?.brand || null;
  const model = rec.identity?.model || null;
  if (!type) return '';

  const out = [];
  const seen = new Set();
  // Запятая — разделитель фраз, внутри фразы её быть не может.
  const push = (phrase) => {
    const p = String(phrase || '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    if (!p) return;
    const k = p.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(p);
  };

  if (brand) push(`${type} ${brand}`);
  // Индекс модели до скобки: в разборе за ним оседают номер ГТД и страна.
  const modelHead = String(model || '').split(/[(,]/)[0].trim();
  if (modelHead) push(`${type} ${modelHead}`);

  // Сначала ключевые характеристики, затем остальные — до верхней границы.
  const ranked = [...dict.attrs]
    .filter(a => a.tier !== 'X' && a.code !== 'brand' && rec.attrs[a.code] != null)
    .sort((a, b) => (b.highlight ? 1 : 0) - (a.highlight ? 1 : 0) || (a.order ?? 0) - (b.order ?? 0));

  // «Узкая» — глубина до 40 см, не ширина 60 см. Иначе запрос ведёт не туда.
  const slimOk = typeof rec.attrs.depth === 'number' && rec.attrs.depth <= 40;
  const pushSafe = (phrase) => {
    if (/узк(?:ая|ий|ое|ие|ой)\b/i.test(phrase || '') && !slimOk) return;
    push(phrase);
  };

  for (const a of ranked) {
    if (out.length >= KEYWORDS.max) break;
    const raw = rec.attrs[a.code];
    const one = Array.isArray(raw) ? raw[0] : raw;
    pushSafe(phraseFor(a, one, type));
  }

  // У скудной карточки предметных характеристик меньше семи. Добираем теми же
  // атрибутами в других формах запроса — придумывать фразы нельзя.
  if (out.length < KEYWORDS.min && modelHead) {
    if (brand) push(`${brand} ${modelHead}`);
    push(modelHead);
  }
  for (const a of ranked) {
    if (out.length >= KEYWORDS.min) break;
    if (rec.attrs[a.code] === true) push(`${type} ${a.name.toLowerCase()}`);
  }

  return out.slice(0, KEYWORDS.max).join(', ');
}

/* ---------------- Запись товара ---------------- */

function asFilterArrays(assigned) {
  const out = {};
  for (const [name, v] of Object.entries(assigned || {})) {
    if (v == null || v === '') continue;
    const list = Array.isArray(v) ? v : [v];
    if (list.length) out[name] = list;
  }
  return out;
}

/** Сырой источник отзыва: явное поле, иначе текст страницы источника. */
function reviewSource(rec) {
  return rec.web_info
    ?? rec.external?.web_info
    ?? rec.review
    ?? rec.external?.review
    ?? rec.page_data
    ?? rec.external?.page_data
    ?? '';
}

/**
 * Одна запись products_{id}.json — ровно семь полей в порядке эталона:
 * id, name, meta_keywords, description_html, annotation_html, filters, web_info.
 * name переносится побайтово. web_info всегда на месте: отзыв или пустая строка.
 */
export function serializeProduct(rec, dict, debugFacets, opts = {}) {
  const assigned = assignFilterValues(rec, dict, debugFacets);
  return {
    id: rec.id,
    name: rec.name,
    meta_keywords: metaKeywords(rec, dict, opts),
    description_html: compactHtml(renderDescription(rec, dict, opts)),
    annotation_html: renderAnnotation(rec, dict),
    filters: asFilterArrays(assigned),
    web_info: webInfoFrom(reviewSource(rec)),
  };
}

export function serializeProducts(recs, dict, debugFacets, opts = {}) {
  return (recs || []).map((r) => serializeProduct(r, dict, debugFacets, opts));
}

export function serializeFilters(built) {
  return { filters: built.filters || [] };
}

/**
 * Товар из UI/фида → вход normalizeProduct.
 * В окне id часто лежит в sku (строка «11391»), в эталоне — число.
 */
export function toPipelineProduct(p) {
  const rawId = p?.id ?? p?.sku;
  const id = rawId != null && /^\d+$/.test(String(rawId)) ? Number(rawId) : rawId;
  return {
    id,
    name: p?.name,
    description: p?.description ?? '',
    annotation: p?.annotation ?? '',
    web_info: p?.web_info
      ?? p?.review
      ?? p?.external?.web_info
      ?? p?.external?.review
      ?? '',
  };
}

/**
 * Добирает пустые attrs из enriched.specs. Аннотация магазина уже в rec —
 * setAttr не перезаписывает. Ключи specs те же, что у ИИ (высота_мм и т.д.).
 */
export function applyEnrichedSpecs(rec, specs, dict, config) {
  if (!specs || typeof specs !== 'object') return;
  const pairs = [];
  for (const attr of dict.attrs) {
    if (attr.tier === 'X') continue;
    const dest = specDest(attr);
    const key = typeof dest === 'object' ? dest.key : dest;
    const mul = typeof dest === 'object' ? dest.mul : 1;
    let val = specs[key];
    if (val == null || val === '') continue;
    if (typeof val === 'number' && mul !== 1) val = val / mul;
    pairs.push({
      key: attr.name,
      value: Array.isArray(val) ? val.join(', ') : String(val),
      source: 'S3',
    });
  }
  if (pairs.length) ingestPairs(rec, pairs, dict, config);
}

/**
 * Семь полей заказчика + фасеты. Неполные карточки (< 8 строк) — в held,
 * не в products: пустой annotation_html у клиента считается дефектом.
 */
export function buildCustomerExport(products, { dict, config, root = '.' } = {}) {
  if (!dict) throw new Error('нет справочника категории');
  if (!config) throw new Error('нет config');
  const recs = (products || []).map((p) => {
    const src = toPipelineProduct(p);
    const rec = normalizeProduct(src, dict, config);
    rec.web_info = src.web_info;
    rec.name = p.name;
    applyEnrichedSpecs(rec, p.enriched?.specs, dict, config);
    return rec;
  });
  const held = recs.filter(r => annotationRows(r, dict).length < MIN_ANNOTATION_ROWS);
  const heldIds = new Set(held.map(r => r.id));
  const exported = recs.filter(r => !heldIds.has(r.id));
  const built = buildFilters(exported, dict, config);
  return {
    products: serializeProducts(exported, dict, built.debug, { root }),
    filters: built.filters,
    held: held.map(r => ({
      id: r.id,
      name: r.name,
      rows: annotationRows(r, dict).length,
      reason: `характеристик ${annotationRows(r, dict).length} < ${MIN_ANNOTATION_ROWS}`,
    })),
  };
}

/** Подпись ключа specs: цвет → Цвет; объем_л → Объем, л. */
function humanizeSpecKey(key) {
  const raw = String(key || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  return raw.replace(/^./, c => c.toUpperCase()).replace(/\s+л$/, ', л')
    .replace(/\s+мм$/, ', мм').replace(/\s+см$/, ', см')
    .replace(/\s+кг$/, ', кг').replace(/\s+вт$/, ', Вт')
    .replace(/\s+дб$/, ', дБ');
}

function specValue(v) {
  if (Array.isArray(v)) return v.map(x => String(x)).filter(Boolean);
  if (v == null || v === '') return [];
  return [String(v)];
}

function specsToAnnotation(specs) {
  if (!specs || typeof specs !== 'object') return '';
  const lis = Object.entries(specs).flatMap(([k, v]) => {
    const label = humanizeSpecKey(k);
    return specValue(v).map(one => `<li>${esc(label)}: ${esc(one)}</li>`);
  });
  return lis.length ? `<ul>${lis.join('')}</ul>` : '';
}

function filtersFromSpecs(specs) {
  const out = {};
  if (!specs || typeof specs !== 'object') return out;
  for (const [k, v] of Object.entries(specs)) {
    const label = humanizeSpecKey(k);
    const list = specValue(v);
    if (label && list.length) out[label] = list;
  }
  return out;
}

function stripH1(html) {
  return String(html || '').replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi, '').trim();
}

function keywordsFrom(p) {
  const raw = p?.enriched?.seo_keywords ?? p?.meta_keywords ?? '';
  if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean).slice(0, 9).join(', ');
  return String(raw || '').trim();
}

/**
 * Семь полей эталона без справочника. Аннотация — все строки источника
 * (или specs), не старый 5-польный v2. Бакетов нет: их задаёт словарь.
 */
export function serializeLooseProduct(p) {
  const src = toPipelineProduct(p);
  const annotation = compactAnnotation(src.annotation)
    || specsToAnnotation(p?.enriched?.specs);
  const desc = compactHtml(stripH1(
    p?.enriched?.seo_description
    || p?.enriched?.short_description
    || src.description
    || '',
  ));
  return {
    id: src.id,
    name: p?.name ?? src.name,
    meta_keywords: keywordsFrom(p),
    description_html: desc,
    annotation_html: annotation,
    filters: filtersFromSpecs(p?.enriched?.specs),
    web_info: webInfoFrom(reviewSource({ ...src, ...p })),
  };
}

/** «2 файла» без attributes_{id}: та же оболочка, что у эталона. */
export function buildGoldShapeExport(products) {
  const rows = (products || []).map(serializeLooseProduct)
    .filter(p => p.annotation_html || p.description_html);
  const catalog = new Map();
  for (const p of rows) {
    for (const [name, vals] of Object.entries(p.filters || {})) {
      const set = catalog.get(name) || new Set();
      for (const v of vals) set.add(v);
      catalog.set(name, set);
    }
  }
  return {
    products: rows,
    filters: [...catalog].map(([name, set]) => ({ name, value: [...set] })),
    held: [],
  };
}
