/**
 * overlays: dictionaries/filters_spec_{id}.json и values_{id}.json.
 * Состав и бакеты фильтров — из spec; каноны витрины — из values, символ в символ.
 */

import { clampBrandFacet, isBrandAttr, isBrandFilterKey, valueFold } from './types.js';

function uniqueList(list) {
  const seen = new Set();
  const out = [];
  for (const x of list || []) {
    const s = String(x || '').trim();
    if (!s) continue;
    const f = valueFold(s);
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(s);
  }
  return out;
}

function attrBySpec(attrs, item) {
  if (item?.code) {
    const hit = attrs.find(a => a.code === item.code);
    if (hit) return hit;
  }
  const name = item?.name;
  if (!name) return null;
  return attrs.find(a => (a.facet?.label || a.name) === name) || null;
}

export function applyOneFilterSpec(attr, item) {
  if (isBrandAttr(attr) || isBrandFilterKey(item?.code) || isBrandFilterKey(item?.name)) {
    clampBrandFacet(attr);
    return;
  }
  if (!attr.facet || typeof attr.facet !== 'object') attr.facet = {};
  const facet = attr.facet;
  if (item.status === 'not_a_filter') {
    facet.enabled = false;
    facet.status = 'not_a_filter';
    if (Array.isArray(item.derives)) facet.derives = item.derives;
    if (item.reason) facet.reason = item.reason;
    else if (!facet.reason) facet.reason = 'not_a_filter';
    return;
  }
  if (item.status === 'filter') {
    facet.enabled = true;
    if (facet.status === 'not_a_filter') delete facet.status;
  }
  if (item.required === true) facet.required = true;
  else if (item.required === false) facet.required = false;
  if (item.type === 'int_enum') {
    facet.kind = 'int_enum';
    facet.round = item.round || facet.round || 'ceil';
    const vals = item.values || item.int_values;
    if (Array.isArray(vals)) facet.int_values = vals.map(Number).filter(Number.isFinite);
  } else if (item.type === 'range') {
    facet.kind = 'range';
    if (item.bound_rule) facet.bound_rule = item.bound_rule;
    if (item.open_last != null) facet.open_last = !!item.open_last;
    if (Array.isArray(item.buckets)) facet.buckets = item.buckets;
  } else if (item.type === 'boolean') {
    facet.kind = 'boolean';
  } else if (item.type === 'enum') {
    facet.kind = 'enum';
  }
  if (item.name) facet.label = item.name;
  if (item.bound_rule) facet.bound_rule = item.bound_rule;
  if (Array.isArray(item.buckets)) facet.buckets = item.buckets;
}

function applyValuesToAttr(attr, canons) {
  if (!canons || typeof canons !== 'object') return;
  const next = {};
  for (const [canon, aliases] of Object.entries(canons)) {
    const key = String(canon || '').trim();
    if (!key) continue;
    const list = Array.isArray(aliases) ? aliases : [];
    next[key] = uniqueList([key, ...list]);
  }
  if (Object.keys(next).length) attr.value_aliases = next;
}

export function applyFiltersSpec(attrs, spec) {
  if (!Array.isArray(attrs) || !spec || !Array.isArray(spec.filters)) return attrs;
  for (const item of spec.filters) {
    const attr = attrBySpec(attrs, item);
    if (!attr) continue;
    applyOneFilterSpec(attr, item);
  }
  return attrs;
}

export function applyValuesMap(attrs, values) {
  if (!Array.isArray(attrs) || !values || typeof values !== 'object') return attrs;
  for (const attr of attrs) {
    const name = attr.facet?.label || attr.name;
    applyValuesToAttr(attr, values[name] || values[attr.code] || null);
  }
  return attrs;
}

/**
 * Накладывает spec и карту синонимов на массив атрибутов (in-place).
 */
export function applyFilterOverlays(attrs, spec, values) {
  applyFiltersSpec(attrs, spec);
  applyValuesMap(attrs, values);
  return attrs;
}

export function lookupValuesCanon(valuesMap, filterName, raw) {
  if (!valuesMap || raw == null) return null;
  const canons = valuesMap[filterName];
  if (!canons || typeof canons !== 'object') return null;
  const folds = new Set([valueFold(raw)].filter(Boolean));
  for (const [canon, aliases] of Object.entries(canons)) {
    const keys = [valueFold(canon), ...(aliases || []).map(valueFold)];
    if (keys.some(k => folds.has(k))) return canon;
  }
  return null;
}

export function valuesObjectFromFile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.values && typeof raw.values === 'object') return raw.values;
  const skip = new Set(['category_id', 'catId', 'id']);
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (skip.has(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}
