/** Клиентская выгрузка: products_{id}.json и filters_{id}.json, как в эталоне. */

import { splitHtmlChunks } from './text.js';
import { assignFilterValues, buildFilters } from './facets.js';
import { renderCard, renderAnnotation, renderDescription, productTypeFor, annotationRows, MIN_ANNOTATION_ROWS } from './generate.js';
import { annotationText, annotationCase, isBrandFilterKey } from './types.js';
import { webInfoFrom } from './reviews.js';
import { normalizeProduct, ingestPairs, deriveDimsFromAxes } from './normalize.js';
import { specDest } from './schema.js';
import { buildDescriptionHtml } from './model_validate.js';
import { finalizeRecord, checkFilterConsistency, stripHallucinationClaims, checkDescriptionClaims } from './quality_validate.js';
import { runFiltersAgent, assertFiltersClean } from './filters_agent.js';
import { validateProducts } from './validate.js';
import { markCategoryMismatch } from './category_mismatch.js';
import { buildFilterCoverageReport } from './filter_report.js';

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
    if (m) return `<li>${esc(m[1].trim())}: ${esc(dedupeAnnotationValue(m[2].trim()))}</li>`;
    return `<li>${esc(dedupeAnnotationValue(line))}</li>`;
  });
  return `<ul>${lis.join('')}</ul>`;
}

/** Повторы через запятую («от детей, от детей») → одно вхождение. */
export function dedupeAnnotationValue(raw) {
  const parts = String(raw || '').split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1) return String(raw || '').trim();
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const k = p.toLowerCase().replace(/ё/g, 'е');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out.join(', ');
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
    if (isBrandFilterKey(name)) continue;
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
 * Одна запись products_{id}.json — шесть полей в порядке эталона:
 * id, meta_keywords, description_html, annotation_html, filters, web_info.
 * name не выгружается: заказчик сопоставляет по id. description_html — из ответа модели.
 */
export function serializeProduct(rec, dict, debugFacets, opts = {}) {
  const enr = opts.enriched || null;
  // Сначала снять неподтверждённые «нет», затем считать filters.
  if (!opts.skipFinalize) {
    finalizeRecord(rec, dict, { enriched: enr, assigned: null });
  }
  const assigned = assignFilterValues(rec, dict, debugFacets, opts.config || {});
  if (!opts.skipFinalize && assigned && !rec.category_mismatch) {
    const filterIssues = checkFilterConsistency(rec, dict, assigned);
    if (filterIssues.length) {
      rec.validation_issues = [...(rec.validation_issues || []), ...filterIssues];
    }
  }
  const meta = enr && typeof enr.meta_keywords === 'string' && enr.meta_keywords.trim()
    ? enr.meta_keywords.trim()
    : metaKeywords(rec, dict, opts);
  const descSrc = enr?.description != null
    ? stripHallucinationClaims(enr.description)
    : null;
  const descHtml = descSrc
    ? compactHtml(buildDescriptionHtml({
      description: descSrc,
      bullets: Array.isArray(enr.bullets)
        ? enr.bullets.map(b => (typeof b === 'string' ? stripHallucinationClaims(b) : b))
        : enr?.bullets,
      strong: enr.strong,
    }))
    : compactHtml(renderDescription(rec, dict, opts));
  const web = enr && 'web_info' in enr
    ? (enr.web_info == null ? '' : String(enr.web_info))
    : webInfoFrom(reviewSource(rec));
  return {
    id: rec.id,
    meta_keywords: meta,
    description_html: descHtml,
    annotation_html: renderAnnotation(rec, dict),
    filters: asFilterArrays(assigned),
    web_info: web,
  };
}

export function serializeProducts(recs, dict, debugFacets, opts = {}) {
  return (recs || []).map((r) => serializeProduct(r, dict, debugFacets, {
    ...opts,
    enriched: r._enriched || opts.enriched,
  }));
}

export function serializeFilters(built) {
  return {
    filters: (built.filters || []).filter(f => !isBrandFilterKey(f?.name)),
  };
}

/**
 * Товар из UI/фида → вход normalizeProduct.
 * В окне id часто лежит в sku (строка «11391»), в эталоне — число.
 * Готовый products_*.json несёт annotation_html / description_html — без них
 * повторная выгрузка теряет характеристики и оставляет «старые» filters.
 */
export function toPipelineProduct(p) {
  const rawId = p?.id ?? p?.sku;
  const id = rawId != null && /^\d+$/.test(String(rawId)) ? Number(rawId) : rawId;
  const annotation = firstNonEmpty(
    p?.annotation,
    p?.annotation_html,
    p?.characteristics,
    p?.attrs_html,
  );
  const description = firstNonEmpty(
    p?.description,
    p?.description_html,
    p?.seo_description,
  );
  return {
    id,
    name: p?.name,
    description,
    annotation,
    web_info: p?.web_info
      ?? p?.review
      ?? p?.external?.web_info
      ?? p?.external?.review
      ?? '',
  };
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
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
  deriveDimsFromAxes(rec, dict);
}

/**
 * Шесть полей заказчика + фасеты. Неполные карточки (< 8 строк) остаются
 * в products и дублируются в held: потеря SKU хуже неполного фильтра.
 * Карточки с пометкой needs_review тоже в products: ИИ уже правил,
 * дыра в выгрузке хуже черновика. Отчёт needs_review — только аудит.
 *
 * После finalize — отдельный category-level filters_agent (ИИ или эвристика),
 * затем buildFilters. Битый filters_*.json не отдаём (validation.ok === false).
 */
export async function buildCustomerExport(products, {
  dict,
  config,
  root = '.',
  filtersAgent = null,
} = {}) {
  if (!dict) throw new Error('нет справочника категории');
  if (!config) throw new Error('нет config');
  const review = [];
  const recs = [];
  for (const p of products || []) {
    if (p?.needs_review) {
      review.push({
        id: p.id ?? p.sku,
        name: p.name,
        reason: 'needs_review',
        validation_issues: p.validation_issues || [],
        raw_response: p.raw_response || null,
      });
    }
    const src = toPipelineProduct(p);
    const rec = normalizeProduct(src, dict, config);
    rec.web_info = p.enriched?.web_info ?? src.web_info;
    rec.name = p.name;
    rec._enriched = p.enriched || null;
    applyEnrichedSpecs(rec, p.enriched?.specs, dict, config);
    markCategoryMismatch(rec, dict.catId);
    recs.push(rec);
  }
  const held = recs.filter(r => annotationRows(r, dict).length < MIN_ANNOTATION_ROWS);
  // Состав выгрузки = состав исходника. held — отчёт, не отсев.
  const exported = recs;
  // Сначала очистить неподтверждённые «нет», потом агент фасетов, потом buildFilters.
  for (const rec of exported) {
    finalizeRecord(rec, dict, { enriched: rec._enriched, assigned: null });
  }

  const agentOpts = filtersAgent && typeof filtersAgent === 'object' ? filtersAgent : {};
  const agent = await runFiltersAgent({
    recs: exported,
    dict,
    config,
    catId: dict.catId,
    ...agentOpts,
  });

  // Сушилка в разделе стиральных машин не должна задавать пункты каталога.
  const facetRecs = exported.filter(r => !r.category_mismatch);
  let built = buildFilters(facetRecs.length ? facetRecs : exported, dict, config);
  // Финальный проход: схлопнуть синонимы (No Frost / Inverter / Электронная),
  // даже если сырой attrs или старый сервер пропустил unify.
  const { sanitizeFilterCatalog } = await import('./fix_filters.js');
  const sanitized = sanitizeFilterCatalog(built.filters, dict);
  built = {
    ...built,
    filters: sanitized.filters,
    debug: (built.debug || []).map(f => {
      const hit = sanitized.filters.find(x => x.name === f.name);
      return hit ? { ...f, value: hit.value } : f;
    }).filter(f => sanitized.filters.some(x => x.name === f.name)),
    sanitize_fixes: sanitized.fixes,
  };
  const unmapped = built.unmapped || {};
  for (const rec of exported) {
    const assigned = assignFilterValues(rec, dict, built.debug, config, unmapped);
    if (rec.category_mismatch) continue;
    const filterIssues = checkFilterConsistency(rec, dict, assigned);
    if (filterIssues.length) {
      rec.validation_issues = [...(rec.validation_issues || []), ...filterIssues];
    }
  }

  const productsOut = serializeProducts(exported, dict, built.debug, { root, skipFinalize: true, config });
  const coverage = buildFilterCoverageReport({
    catId: dict.catId,
    products: productsOut,
    recs,
    dict,
    unmapped,
    threshold: config.facet_min_coverage ?? 70,
  });
  const clean = assertFiltersClean(built.filters, dict);
  const verdict = validateProducts(productsOut, dict, new Map(exported.map(r => [r.id, r])));
  // Gate только на грязь в значениях фасетов. filter_missing (фасет из schema
  // ни у кого не заполнен) — норма для частичной выгрузки / одного SKU.
  const dirtyKinds = new Set([
    'dirty_filter_value',
    'filter_not_in_aliases',
    'filter_object_stringified',
    'filter_unknown',
    'filter_not_bucketed',
    'filter_unit_mismatch',
  ]);
  const dirtyVerdict = verdict.errors.filter(e => dirtyKinds.has(e.kind));
  const validation = {
    ok: clean.ok && dirtyVerdict.length === 0,
    errors: [
      ...clean.errors.map(e => ({ id: null, kind: e.kind, detail: `${e.name}=${e.value}` })),
      ...dirtyVerdict,
    ],
    product_errors: verdict.errors.filter(e => !dirtyKinds.has(e.kind) && e.kind !== 'dirty_filter_value'),
  };

  const deliver = validation.ok;
  return {
    products: deliver ? productsOut : [],
    filters: deliver ? built.filters : [],
    held: held.map(r => ({
      id: r.id,
      name: r.name,
      rows: annotationRows(r, dict).length,
      reason: `характеристик ${annotationRows(r, dict).length} < ${MIN_ANNOTATION_ROWS}`,
    })),
    needs_review: review,
    filters_agent: {
      mode: agent.mode,
      mappings: agent.mappings?.length || 0,
      rejected: agent.rejected?.length || 0,
      stats: agent.stats,
      notes: agent.notes || [],
      sanitize_fixes: built.sanitize_fixes?.length || 0,
    },
    validation,
    coverage,
    quality: exported.map(r => ({
      id: r.id,
      score: r.quality?.score,
      confirmed: r.quality?.confirmed,
      unknown: r.quality?.unknown,
      conflicts: r.quality?.conflicts ?? (r.conflicts || []).length,
      invalid: r.quality?.invalid,
      hallucinations: r.quality?.hallucinations,
      sources: r.quality?.sources,
      issues: (r.validation_issues || []).length,
      needs_review: Boolean(r.needs_review),
    })),
    // Внутреннее: /api/filters/build и тесты.
    _built: built,
    _exported: exported,
    _productsOut: productsOut,
  };
}

/**
 * Только сбор filters после агента (для POST /api/filters/build).
 */
export async function buildFiltersOnly(products, opts = {}) {
  const out = await buildCustomerExport(products, opts);
  const agentFull = out.filters_agent || {};
  return {
    filters: out.validation?.ok ? out.filters : [],
    validation: out.validation,
    filters_agent: agentFull,
    held: out.held,
    debug: {
      warnings: out._built?.warnings || [],
      excluded: out._built?.excluded || [],
      agent_notes: agentFull.notes || [],
      mode: agentFull.mode,
    },
    products_count: (out._productsOut || out.products || []).length,
    exported_count: out._exported?.length || 0,
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

function stripH1(html) {
  return String(html || '').replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi, '').trim();
}

function keywordsFrom(p) {
  const raw = p?.enriched?.meta_keywords ?? p?.enriched?.seo_keywords ?? p?.meta_keywords ?? '';
  if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean).slice(0, 9).join(', ');
  return String(raw || '').trim();
}

/**
 * Шесть полей эталона без справочника. Аннотация — все строки источника
 * (или specs). description_html — из ответа модели. filters всегда [].
 */
export function serializeLooseProduct(p) {
  const src = toPipelineProduct(p);
  const annotation = compactAnnotation(src.annotation)
    || specsToAnnotation(p?.enriched?.specs);
  const enr = p?.enriched ? { ...p.enriched } : null;
  if (enr) {
    if (typeof enr.description === 'string') enr.description = stripHallucinationClaims(enr.description);
    if (typeof enr.short_description === 'string') {
      enr.short_description = stripHallucinationClaims(enr.short_description);
    }
    if (Array.isArray(enr.bullets)) {
      enr.bullets = enr.bullets.map(b =>
        (typeof b === 'string' ? stripHallucinationClaims(b) : b)).filter(b => b && String(b).trim());
    }
  }
  const descIssues = checkDescriptionClaims(enr || { description: src.description });
  const desc = enr?.description
    ? compactHtml(buildDescriptionHtml({
      description: enr.description,
      bullets: enr.bullets,
      strong: enr.strong,
    }))
    : compactHtml(stripH1(
      enr?.seo_description
      || enr?.short_description
      || stripHallucinationClaims(src.description)
      || '',
    ));
  const web = enr && 'web_info' in enr
    ? (enr.web_info == null ? '' : String(enr.web_info))
    : webInfoFrom(reviewSource({ ...src, ...p }));
  return {
    id: src.id,
    meta_keywords: keywordsFrom(p),
    description_html: desc,
    annotation_html: annotation,
    filters: {},
    web_info: web,
    _gold_needs_review: true,
    _gold_issues: descIssues,
    _gold_name: p?.name ?? src.name,
  };
}

/** «2 файла» без attributes_{id}: оболочка эталона, filters пустые, needs_review. */
export function buildGoldShapeExport(products) {
  const rows = (products || []).map(serializeLooseProduct)
    .filter(p => p.annotation_html || p.description_html);
  const review = rows.map(p => ({
    id: p.id,
    name: p._gold_name,
    reason: 'gold_export_no_category_dict',
    validation_issues: p._gold_issues || [],
  }));
  const productsOut = rows.map(({ _gold_needs_review, _gold_issues, _gold_name, ...rest }) => rest);
  return {
    products: productsOut,
    filters: [],
    held: [],
    needs_review: review,
  };
}
