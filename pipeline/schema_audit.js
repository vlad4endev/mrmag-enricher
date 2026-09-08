/**
 * Аудит category schema (attributes_{id}.json): мусорные значения,
 * дубликаты/синонимы, несовместимые типы, пустые ENUM при включённом фасете.
 * Ничего не удаляет — только предложения для админки.
 */

import { facetKind } from './facets.js';
import { valueFold, displayEnum, looksLikeEnumFragment } from './types.js';

const ATTR_TYPES = new Set([
  'string', 'text', 'integer', 'number', 'boolean', 'enum', 'multi_enum', 'class_scale', 'dimensions',
]);

const FACET_KINDS = new Set(['none', 'enum', 'range', 'boolean']);

/**
 * Однословные ключи вроде «Тип» матчят чужие пары («Тип = зоны свежести - нет»)
 * и засоряют filters_*.json на витрине.
 */
const GENERIC_NAME_SYNONYM = /^(?:тип|вид|класс|наличие|система|режим|опция|функция)$/i;

/** Допустимые пары type × facet.kind (none = facet.enabled false). */
const TYPE_FACET_OK = {
  string: new Set(['none', 'enum']),
  text: new Set(['none', 'enum']),
  integer: new Set(['none', 'enum', 'range']),
  number: new Set(['none', 'enum', 'range']),
  boolean: new Set(['none', 'boolean', 'enum']),
  enum: new Set(['none', 'enum']),
  multi_enum: new Set(['none', 'enum']),
  class_scale: new Set(['none', 'enum']),
  dimensions: new Set(['none', 'enum']),
};

function fold(s) {
  return valueFold(String(s ?? ''));
}

function looksLikeFragment(val) {
  return looksLikeEnumFragment(val);
}

function otherAttrHit(val, attr, allAttrs) {
  const f = fold(val);
  if (!f || f.length < 4) return null;
  for (const other of allAttrs) {
    if (other.code === attr.code) continue;
    const names = [other.name, ...(other.synonyms || []), other.facet?.label].filter(Boolean);
    for (const n of names) {
      const nf = fold(n);
      if (!nf || nf.length < 4) continue;
      if (f.includes(nf) || nf.includes(f)) return { code: other.code, name: other.name, via: 'label' };
    }
    const aliases = other.value_aliases || {};
    for (const [canon, syns] of Object.entries(aliases)) {
      for (const s of [canon, ...(syns || [])]) {
        const sf = fold(s);
        if (sf && sf.length >= 4 && f === sf) {
          return { code: other.code, name: other.name, via: 'value', canon };
        }
      }
    }
  }
  return null;
}

function nearDuplicates(labels) {
  const pairs = [];
  const items = labels.map(l => ({ raw: l, fold: fold(l), stem: fold(l).replace(/(ое|ая|ый|ий|ее|ье)$/, '') }));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (!a.fold || !b.fold) continue;
      if (a.fold === b.fold) {
        pairs.push({ a: a.raw, b: b.raw, kind: 'exact' });
        continue;
      }
      if (a.stem.length >= 4 && a.stem === b.stem) {
        pairs.push({ a: a.raw, b: b.raw, kind: 'stem' });
        continue;
      }
      // «Сверху» / «Верхнее», «Внизу» / «Нижнее»
      const short = a.fold.length <= b.fold.length ? a : b;
      const long = short === a ? b : a;
      if (short.fold.length >= 4 && long.fold.includes(short.fold)) {
        pairs.push({ a: a.raw, b: b.raw, kind: 'contains' });
      }
    }
  }
  return pairs;
}

function canonList(attr) {
  const aliases = attr.value_aliases || {};
  return Object.keys(aliases);
}

function synonymMap(attr) {
  const aliases = attr.value_aliases || {};
  const out = [];
  for (const [canon, list] of Object.entries(aliases)) {
    out.push({
      label: canon,
      value: canon,
      synonyms: Array.isArray(list) ? list : [],
    });
  }
  return out;
}

function facetTypeOf(attr) {
  if (!attr.facet?.enabled) return 'none';
  return facetKind(attr) || attr.facet.kind || 'enum';
}

function typeFacetIssue(attr) {
  const t = attr.type || 'string';
  const fk = facetTypeOf(attr);
  const allowed = TYPE_FACET_OK[t];
  if (!allowed) {
    return { severity: 'warn', code: 'unknown_type', message: `неизвестный type «${t}»` };
  }
  if (attr.facet?.enabled && !allowed.has(fk === 'none' ? 'enum' : fk) && fk !== 'none') {
    return {
      severity: 'error',
      code: 'type_facet_mismatch',
      message: `type «${t}» несовместим с facet.kind «${fk}»`,
    };
  }
  if (t === 'boolean' && attr.facet?.enabled && fk === 'enum') {
    return {
      severity: 'warn',
      code: 'boolean_as_enum',
      message: 'для boolean лучше facet.kind = boolean (Есть/Нет)',
    };
  }
  if (fk === 'range' && !(attr.type === 'number' || attr.type === 'integer')) {
    return {
      severity: 'error',
      code: 'range_not_numeric',
      message: 'range допустим только для number/integer',
    };
  }
  if (fk === 'range') {
    const breaks = attr.facet?.breaks;
    const step = attr.facet?.step;
    if (!(Array.isArray(breaks) && breaks.length >= 2) && !(step > 0)) {
      return {
        severity: 'error',
        code: 'range_no_buckets',
        message: 'для range нужны facet.breaks (≥2) или facet.step > 0',
      };
    }
  }
  return null;
}

/**
 * Аудит одного атрибута.
 * @returns {{ code, name, status, issues: object[], stats }}
 */
export function auditAttribute(attr, allAttrs = []) {
  const issues = [];
  const canons = canonList(attr);
  const syns = synonymMap(attr);
  const fk = facetTypeOf(attr);

  if (!ATTR_TYPES.has(attr.type)) {
    issues.push({ severity: 'error', kind: 'bad_type', message: `type «${attr.type}»` });
  }

  const tf = typeFacetIssue(attr);
  if (tf) issues.push({ ...tf, kind: tf.code });

  if (attr.facet?.enabled && FACET_KINDS.has(fk) === false && fk !== 'enum') {
    issues.push({ severity: 'warn', kind: 'bad_facet_kind', message: `facet.kind «${fk}»` });
  }

  // ENUM без канонов при включённом фасете — AI может плодить мусор в filters.
  if (attr.facet?.enabled && (attr.type === 'enum' || attr.type === 'multi_enum') && !canons.length) {
    issues.push({
      severity: 'error',
      kind: 'empty_enum_canons',
      message: 'facet.enabled, но value_aliases пуст — фильтр будет собирать произвольные строки',
      fix: 'добавьте канонические значения и синонимы',
    });
  }

  // Имя-синоним «Тип» / «Вид» — слишком широкий матч для пар ключ=значение.
  for (const syn of attr.synonyms || []) {
    const s = String(syn || '').trim();
    if (!s) continue;
    if (GENERIC_NAME_SYNONYM.test(s)) {
      issues.push({
        severity: 'error',
        kind: 'generic_name_synonym',
        value: s,
        message: `синоним имени «${s}» слишком общий — матчит чужие характеристики и засоряет фильтры`,
        fix: 'замените на уточнение: «Тип холодильника», «Тип управления»…',
        actions: ['delete', 'keep'],
      });
    }
  }

  for (const { label, synonyms } of syns) {
    if (!label || !String(label).trim()) {
      issues.push({ severity: 'error', kind: 'empty_canon', message: 'пустое каноническое значение' });
      continue;
    }
    if (looksLikeFragment(label)) {
      issues.push({
        severity: 'error',
        kind: 'garbage_canon',
        value: label,
        message: `канон похож на фрагмент характеристики: «${label}»`,
        actions: ['delete', 'move', 'keep'],
      });
    }
    const hit = otherAttrHit(label, attr, allAttrs);
    if (hit) {
      issues.push({
        severity: 'error',
        kind: 'wrong_attribute',
        value: label,
        message: `«${label}» похоже на «${hit.name}» (${hit.code})`,
        suggest_attr: hit.code,
        actions: ['delete', 'move', 'keep'],
      });
    }
    for (const s of synonyms) {
      if (!s || !String(s).trim()) {
        issues.push({ severity: 'warn', kind: 'empty_synonym', value: label, message: 'пустой синоним' });
        continue;
      }
      if (looksLikeFragment(s)) {
        issues.push({
          severity: 'warn',
          kind: 'garbage_synonym',
          value: s,
          canon: label,
          message: `синоним похож на мусор: «${s}»`,
          actions: ['delete', 'keep'],
        });
      }
      const sh = otherAttrHit(s, attr, allAttrs);
      if (sh && fold(s) !== fold(label)) {
        issues.push({
          severity: 'warn',
          kind: 'synonym_other_attr',
          value: s,
          canon: label,
          message: `синоним «${s}» ближе к «${sh.name}»`,
          suggest_attr: sh.code,
          actions: ['delete', 'move', 'keep'],
        });
      }
    }
  }

  const dupes = nearDuplicates(canons);
  for (const d of dupes) {
    issues.push({
      severity: 'warn',
      kind: 'duplicate_canons',
      value: d.a,
      other: d.b,
      message: `возможные дубликаты/синонимы: «${d.a}» ↔ «${d.b}» (${d.kind})`,
      actions: ['merge', 'keep'],
      merge_into: d.a,
      merge_from: d.b,
    });
  }

  // blacklist («не путать с») — подсказка, если пусто у похожих имён
  if (attr.facet?.enabled && (!attr.blacklist || !attr.blacklist.length)) {
    const related = allAttrs.filter(o => {
      if (o.code === attr.code) return false;
      const a = fold(attr.name);
      const b = fold(o.name);
      if (!a || !b) return false;
      const shared = a.split(/\s+/).filter(w => w.length >= 4 && b.includes(w));
      return shared.length >= 1;
    }).slice(0, 6);
    if (related.length) {
      issues.push({
        severity: 'info',
        kind: 'suggest_blacklist',
        message: 'стоит заполнить «Не путать с»',
        suggest: related.map(r => r.name),
      });
    }
  }

  const errors = issues.filter(i => i.severity === 'error').length;
  const warns = issues.filter(i => i.severity === 'warn').length;
  let status = 'OK';
  if (errors) status = 'ERROR';
  else if (warns) status = 'WARN';

  return {
    code: attr.code,
    name: attr.name,
    type: attr.type,
    unit: attr.unit ?? null,
    facet_enabled: !!attr.facet?.enabled,
    facet_kind: fk,
    values_count: canons.length,
    synonyms_count: syns.reduce((n, x) => n + x.synonyms.length, 0),
    status,
    issues,
    canons: syns,
    blacklist: attr.blacklist || [],
  };
}

/**
 * Полный аудит справочника категории.
 */
export function auditDictionary(attrs) {
  const list = Array.isArray(attrs) ? attrs : [];
  const byAttr = list.map(a => auditAttribute(a, list));
  const problems = byAttr.reduce((n, a) => n + a.issues.filter(i => i.severity === 'error' || i.severity === 'warn').length, 0);
  const errors = byAttr.reduce((n, a) => n + a.issues.filter(i => i.severity === 'error').length, 0);
  return {
    attrs_total: list.length,
    facets_total: list.filter(a => a.facet?.enabled).length,
    problems,
    errors,
    attributes: byAttr,
  };
}

/**
 * Превью фильтра из схемы (+ опциональные счётчики по normalized attrs товаров).
 * products: [{ attrs: { code: value } }] или recs pipeline.
 */
export function previewFilters(attrs, products = []) {
  const list = Array.isArray(attrs) ? attrs : [];
  const recs = Array.isArray(products) ? products : [];
  const filters = [];

  for (const attr of [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    if (!attr.facet?.enabled || attr.tier === 'X') continue;
    const kind = facetTypeOf(attr);
    const name = attr.facet.label || attr.name;
    const counts = new Map();

    if (kind === 'range') {
      const breaks = Array.isArray(attr.facet.breaks) ? attr.facet.breaks.map(Number) : null;
      const step = attr.facet.step;
      const openLast = !!attr.facet.open_last;
      let buckets = [];
      if (breaks && breaks.length >= 2) {
        for (let i = 0; i < breaks.length - 1; i++) {
          buckets.push({
            lo: breaks[i],
            hi: breaks[i + 1],
            label: `${breaks[i]}–${breaks[i + 1]}`,
          });
        }
        if (openLast) {
          const last = breaks[breaks.length - 1];
          buckets.push({ lo: last, hi: Infinity, label: `${last}+` });
        }
      } else if (step > 0) {
        const vr = attr.valid_range || [0, step * 6];
        for (let lo = vr[0]; lo < vr[1]; lo += step) {
          buckets.push({ lo, hi: lo + step, label: `${lo}–${lo + step}` });
        }
        if (openLast) {
          const last = buckets[buckets.length - 1];
          if (last) last.label = `${last.lo}+`;
        }
      }
      for (const b of buckets) counts.set(b.label, 0);
      for (const r of recs) {
        const v = r.attrs?.[attr.code] ?? r[attr.code];
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n)) continue;
        const hit = buckets.find(b => n >= b.lo && n < b.hi)
          || (openLast ? buckets[buckets.length - 1] : null);
        if (!hit) continue;
        counts.set(hit.label, (counts.get(hit.label) || 0) + 1);
      }
    } else if (attr.type === 'boolean' || kind === 'boolean') {
      counts.set('Есть', 0);
      counts.set('Нет', 0);
      for (const r of recs) {
        const v = r.attrs?.[attr.code] ?? r[attr.code];
        if (v === true) counts.set('Есть', (counts.get('Есть') || 0) + 1);
        else if (v === false) counts.set('Нет', (counts.get('Нет') || 0) + 1);
      }
    } else {
      const canons = canonList(attr);
      for (const c of canons) counts.set(displayEnum(c) || c, 0);
      for (const r of recs) {
        const v = r.attrs?.[attr.code] ?? r[attr.code];
        if (v == null || v === '') continue;
        const vals = Array.isArray(v) ? v : [v];
        for (const one of vals) {
          const lab = displayEnum(String(one));
          if (!lab) continue;
          if (canons.length && !canons.some(c => fold(c) === fold(lab))) {
            // вне схемы — в preview не создаём новое значение
            continue;
          }
          counts.set(lab, (counts.get(lab) || 0) + 1);
        }
      }
    }

    const values = [...counts].map(([value, count]) => ({ value, count }));
    if (kind === 'range') {
      values.sort((a, b) => parseFloat(a.value) - parseFloat(b.value));
    } else {
      values.sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value), 'ru'));
    }

    filters.push({
      code: attr.code,
      name,
      kind,
      type: attr.type,
      unit: attr.unit ?? null,
      values,
      products_filled: recs.filter(r => {
        const v = r.attrs?.[attr.code] ?? r[attr.code];
        return v != null && v !== '';
      }).length,
      products_total: recs.length,
    });
  }

  return { filters, products_total: recs.length, schema_only: !recs.length };
}

/**
 * Проверка атрибуции на одном товаре (normalized rec или сырой product + attrs).
 */
export function probeProductAttribution(attrs, product) {
  if (!product || typeof product !== 'object') {
    throw Object.assign(new Error('нужен product'), { status: 400 });
  }
  const list = Array.isArray(attrs) ? attrs : [];
  const byCode = new Map(list.map(a => [a.code, a]));
  const rows = [];
  const srcAttrs = product.attrs || product.normalized?.attrs || {};
  const provenance = product.provenance || product.normalized?.provenance || {};
  const conflicts = product.conflicts || product.normalized?.conflicts || [];

  for (const attr of list) {
    if (attr.tier === 'X') continue;
    const rawSlot = provenance[attr.code];
    const value = srcAttrs[attr.code];
    const conflict = conflicts.find(c => c.attribute === attr.code || c.code === attr.code);
    let status = 'empty';
    if (value != null && value !== '') status = 'OK';
    if (conflict) status = conflict.needs_review ? 'CONFLICT' : 'RESOLVED';

    const evidence = rawSlot?.evidence || null;
    rows.push({
      attribute: attr.name,
      code: attr.code,
      type: attr.type,
      raw_value: evidence?.raw_value ?? rawSlot?.raw ?? null,
      normalized_value: value ?? null,
      filter_value: evidence?.filter_value ?? null,
      source: evidence?.source ?? rawSlot?.level ?? null,
      source_type: rawSlot?.level ?? null,
      confidence: evidence?.confidence ?? null,
      status,
      conflict: conflict || null,
    });
  }

  // пары из annotation/description, не попавшие в attrs
  const orphanHints = [];
  if (Array.isArray(product.moderation)) {
    for (const m of product.moderation) {
      orphanHints.push(m);
    }
  }

  return {
    product: {
      id: product.id ?? null,
      name: product.name ?? null,
    },
    rows,
    orphan_hints: orphanHints,
    known_codes: [...byCode.keys()],
  };
}

/** Совместимость type/facet перед сохранением — мягкие автоправки. */
export function coerceFacetForType(attr) {
  const a = { ...attr, facet: { ...(attr.facet || {}) } };
  if (a.type === 'boolean' && a.facet.enabled) {
    if (a.facet.kind === 'enum' || !a.facet.kind) a.facet.kind = 'boolean';
  }
  if (a.type === 'multi_enum') {
    a.cardinality = 'multi';
    a.type = 'enum';
  }
  if (!a.facet.enabled) {
    // kind может остаться для UI
  } else if (a.type === 'number' || a.type === 'integer') {
    if (!a.facet.kind) a.facet.kind = 'range';
  } else if (!a.facet.kind) {
    a.facet.kind = a.type === 'boolean' ? 'boolean' : 'enum';
  }
  return a;
}

export function validateTypeFacetCombo(attr) {
  return typeFacetIssue(attr);
}

export { nearDuplicates, looksLikeFragment, TYPE_FACET_OK, ATTR_TYPES };
