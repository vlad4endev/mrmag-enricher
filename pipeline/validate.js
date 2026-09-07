/**
 * Проверка выгрузки по чек-листу заказчика. Запускается на products_{id}.json
 * и падает до отправки, а не после. Ошибка разметки блокирует выгрузку.
 */

import { facetKind } from './facets.js';
import { DESC, MIN_ANNOTATION_ROWS, verifyDescription } from './generate.js';
import { WEB_INFO } from './reviews.js';
import { KEYWORDS } from './export.js';
import { valueFold } from './types.js';

/** Порядок и состав полей записи — ровно семь, как в схеме заказчика. */
export const PRODUCT_FIELDS = [
  'id', 'name', 'meta_keywords', 'description_html', 'annotation_html', 'filters', 'web_info',
];

const DESC_TAGS = ['p', 'ul', 'li', 'strong'];
const DOMINANT_SHARE = 95;

/**
 * Разметка: только разрешённые теги, все закрыты и вложены, без HTML-сущностей.
 * Возвращает список нарушений, пустой — значит разметка валидна.
 */
export function validateMarkup(html, allowed = DESC_TAGS) {
  const errors = [];
  const s = String(html || '');

  for (const m of s.matchAll(/&[a-zA-Z#][a-zA-Z0-9]*;/g)) {
    errors.push({ kind: 'html_entity', detail: m[0] });
  }

  const stack = [];
  for (const m of s.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
    const tag = m[1].toLowerCase();
    const closing = m[0].startsWith('</');
    const selfClosing = m[2] === '/';
    if (!allowed.includes(tag)) {
      errors.push({ kind: 'tag_not_allowed', detail: tag });
      continue;
    }
    if (selfClosing) continue;
    if (closing) {
      if (stack.pop() !== tag) errors.push({ kind: 'tag_not_closed', detail: tag });
    } else {
      stack.push(tag);
    }
  }
  for (const tag of stack) errors.push({ kind: 'tag_not_closed', detail: tag });

  // Незакрытая угловая скобка: «<p>текст<p» пройдёт regexp, но сломает страницу.
  const opens = (s.match(/</g) || []).length;
  const closes = (s.match(/>/g) || []).length;
  if (opens !== closes) errors.push({ kind: 'angle_bracket_unbalanced', detail: `${opens}/${closes}` });

  return errors;
}

/** «800-1000», «1400+», «до 10». */
export function isRangeBucketLabel(v) {
  const s = String(v).trim();
  if (/^до\s+-?\d+(?:\.\d+)?$/i.test(s)) return true;
  return /^-?\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?|\+)$/.test(s);
}

const textLen = html => String(html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().length;
const countTag = (html, tag) => (String(html || '').match(new RegExp(`<${tag}\\b`, 'gi')) || []).length;

/** description_html: 4 абзаца, один <ul> на 3–5 пунктов, 1–3 <strong>, без <h1>. */
export function validateDescription(html) {
  const errors = [...validateMarkup(html)];
  const p = countTag(html, 'p');
  const ul = countTag(html, 'ul');
  const li = countTag(html, 'li');
  const strong = countTag(html, 'strong');
  const len = textLen(html);

  if (/<h1\b/i.test(html)) errors.push({ kind: 'h1_present' });
  if (p !== DESC.paragraphs) errors.push({ kind: 'paragraphs', detail: p });
  if (ul !== 1) errors.push({ kind: 'ul_count', detail: ul });
  if (ul === 1 && (li < DESC.minBullets || li > DESC.maxBullets)) {
    errors.push({ kind: 'bullets', detail: li });
  }
  if (strong < DESC.minStrong || strong > DESC.maxStrong) {
    errors.push({ kind: 'strong', detail: strong });
  }
  if (len < DESC.minChars || len > DESC.maxChars) errors.push({ kind: 'length', detail: len });
  return errors;
}

/** annotation_html: разделитель «: », не менее 8 строк, значения без бакетов. */
export function validateAnnotation(html) {
  const errors = [...validateMarkup(html, ['ul', 'li'])];
  const items = [...String(html || '').matchAll(/<li>([\s\S]*?)<\/li>/gi)].map(m => m[1]);
  if (!items.length) {
    errors.push({ kind: 'annotation_empty' });
    return errors;
  }
  if (items.length < MIN_ANNOTATION_ROWS) errors.push({ kind: 'annotation_rows', detail: items.length });
  for (const it of items) {
    if (!/^[^:]+: .+$/.test(it)) errors.push({ kind: 'annotation_separator', detail: it });
    // Бакет принадлежит filters: «55-60» вместо точного значения — ошибка.
    if (/:\s*\d+(?:\.\d+)?-\d/.test(it)) errors.push({ kind: 'annotation_bucketed', detail: it });
    if (/:\s*(?:—|-|н\/д|нет данных|уточняйте)\s*$/i.test(it)) {
      errors.push({ kind: 'annotation_placeholder', detail: it });
    }
  }
  return errors;
}

/** Ожидаемый состав и порядок фильтров — из справочника, а не из данных. */
export function expectedFilters(dict) {
  return dict.attrs
    .filter(a => a.tier !== 'X' && a.facet?.enabled && a.facet?.status !== 'not_a_filter')
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(a => ({ code: a.code, name: a.facet.label || a.name, kind: facetKind(a), unit: a.unit }));
}

/**
 * Полная проверка выгрузки.
 * @param {object[]} rows       записи products_{id}.json
 * @param {object}   dict       справочник категории
 * @param {Map}      sourceById исходные товары по id (для побайтового name)
 */
export function validateProducts(rows, dict, sourceById = new Map()) {
  const errors = [];
  const add = (id, kind, detail) => errors.push({ id, kind, detail });
  const expected = expectedFilters(dict);
  const byName = new Map(expected.map(f => [f.name, f]));
  const order = new Map(expected.map((f, i) => [f.name, i]));

  const filterValueCounts = new Map();
  let multiValueSeen = 0;

  for (const r of rows) {
    const keys = Object.keys(r);
    if (keys.join() !== PRODUCT_FIELDS.join()) add(r.id, 'fields', keys.join());

    const src = sourceById.get(r.id);
    if (src && r.name !== src.name) add(r.id, 'name_changed', r.name);

    for (const e of validateDescription(r.description_html)) add(r.id, `description.${e.kind}`, e.detail);
    for (const e of validateAnnotation(r.annotation_html)) add(r.id, `annotation.${e.kind}`, e.detail);

    const kw = String(r.meta_keywords || '').split(',').map(s => s.trim()).filter(Boolean);
    if (kw.length < KEYWORDS.min || kw.length > KEYWORDS.max) {
      add(r.id, 'meta_keywords_count', kw.length);
    }
    if (new Set(kw.map(s => s.toLowerCase())).size !== kw.length) add(r.id, 'meta_keywords_duplicate', r.meta_keywords);
    if (/\d+\s*мм\b/.test(r.meta_keywords) || /м³|м²/.test(r.meta_keywords)) {
      add(r.id, 'meta_keywords_unit', r.meta_keywords);
    }

    const web = String(r.web_info ?? '');
    if (web && (web.length < WEB_INFO.min || web.length > WEB_INFO.max)) {
      add(r.id, 'web_info_length', web.length);
    }
    if (/гарант|экономи[яи]|продав|магазин/i.test(r.description_html)) {
      add(r.id, 'description.forbidden', 'гарантия/экономия/магазин');
    }
    if (src?.attrs) {
      for (const e of verifyDescription(r.description_html, src, dict)) {
        add(r.id, `description.${e.kind}`, e.detail || `${e.number} ${e.unit || ''}`.trim());
      }
    }
    if (/узк(?:ая|ий|ое|ие|ой)\b/i.test(r.meta_keywords || '')) {
      const depth = src?.attrs?.depth;
      if (!(typeof depth === 'number' && depth <= 40)) {
        add(r.id, 'meta_keywords_narrow', r.meta_keywords);
      }
    }

    if (!r.filters || typeof r.filters !== 'object' || Array.isArray(r.filters)) {
      add(r.id, 'filters_not_object');
      continue;
    }
    let prev = -1;
    for (const [name, val] of Object.entries(r.filters)) {
      if (!Array.isArray(val)) add(r.id, 'filter_not_array', name);
      const spec = byName.get(name);
      if (!spec) {
        add(r.id, 'filter_unknown', name);
        continue;
      }
      const pos = order.get(name);
      if (pos < prev) add(r.id, 'filter_order', name);
      prev = pos;

      if (Array.isArray(val) && val.length > 1) multiValueSeen++;
      // Числовой фильтр обязан быть бакетирован: точное значение живёт в аннотации.
      if (spec.kind === 'range') {
        for (const v of (Array.isArray(val) ? val : [val])) {
          if (!isRangeBucketLabel(v)) {
            add(r.id, 'filter_not_bucketed', `${name}=${v}`);
          }
        }
      }
      // Unit берётся из schema/facet (expectedFilters), а не из подписи.
      // Если в label есть суффикс «, …» — он должен совпадать со schema.unit.
      const labelUnit = String(name).match(/,\s*([^,]+)$/)?.[1]?.trim();
      if (labelUnit && spec.unit && valueFold(labelUnit) !== valueFold(spec.unit)) {
        add(r.id, 'filter_unit_mismatch', `${name} schema=${spec.unit}`);
      }
      for (const v of (Array.isArray(val) ? val : [val])) {
        if (String(v) === '[object Object]') {
          add(r.id, 'filter_object_stringified', name);
        }
      }

      const bucket = filterValueCounts.get(name) || new Map();
      for (const v of (Array.isArray(val) ? val : [val])) bucket.set(v, (bucket.get(v) || 0) + 1);
      filterValueCounts.set(name, bucket);
    }
  }

  // Состав фильтров по каталогу: ни одного лишнего, ни одного пропущенного.
  const present = new Set();
  for (const r of rows) for (const n of Object.keys(r.filters || {})) present.add(n);
  for (const f of expected) {
    if (!present.has(f.name)) errors.push({ id: null, kind: 'filter_missing', detail: f.name });
  }

  // «Одно значение покрывает более 95% товаров» — доля от всех товаров выгрузки,
  // а не от заполненных: пример заказчика — «Назначение» у всех 10 товаров.
  const dominant = [];
  for (const [name, counts] of filterValueCounts) {
    const share = (Math.max(...counts.values()) / (rows.length || 1)) * 100;
    if (share > DOMINANT_SHARE) dominant.push({ name, share: Math.round(share * 10) / 10 });
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      products: rows.length,
      filters_expected: expected.length,
      filters_present: present.size,
      multi_value_filters: multiValueSeen,
      dominant_filters: dominant,
      with_web_info: rows.filter(r => r.web_info).length,
    },
  };
}
