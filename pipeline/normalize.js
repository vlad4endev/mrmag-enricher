/** Ш1–Ш5: разбор, сопоставление, нормализация, габариты, покрытие. Без сети и модели. */

import { parseProductFields } from './parse.js';
import { matchKey } from './match.js';
import { normalizeValue, countUnitsInValues } from './types.js';
import { parseDimensions } from './dimensions.js';
import { parseIdentity } from './identity.js';
import { isPackingKey, normKey } from './text.js';

function emptyState(dict) {
  const attrs = {};
  for (const a of dict.attrs) attrs[a.code] = null;
  return attrs;
}

function setAttr(rec, code, value, prov) {
  if (value == null || rec.attrs[code] != null) return false;
  rec.attrs[code] = value;
  rec.provenance[code] = prov;
  return true;
}

function applyDims(rec, dims, prov, dict) {
  let used = false;
  for (const axis of ['width', 'height', 'depth']) {
    if (dims[axis] == null || !dict.byCode.has(axis)) continue;
    const attr = dict.byCode.get(axis);
    const n = dims[axis];
    const range = attr.valid_range;
    if (range && (n < range[0] || n > range[1])) {
      rec.moderation.push({ code: axis, reason: 'out_of_range', value: n });
      continue;
    }
    if (setAttr(rec, axis, n, prov)) used = true;
  }
  return used;
}

export function ingestPair(rec, pair, dict, { fuzzyMin } = {}) {
  const key = pair.key;
  if (isPackingKey(key) && /габарит|размер|ширин|высот|глубин/i.test(key)) {
    rec.stats.packed_dims++;
    return;
  }

  const matched = matchKey(key, dict, { value: pair.value, fuzzyMin });
  if (!matched.attr) {
    if (matched.how === 'blacklist') rec.stats.blacklisted++;
    const k = key.replace(/\s+/g, ' ').trim();
    rec.unmapped.set(k, (rec.unmapped.get(k) || 0) + 1);
    return;
  }

  const attr = matched.attr;
  rec.mapped.add(attr.code);
  const prov = {
    level: pair.source || 'S1',
    raw: `${key} = ${pair.value}`,
    model: null,
    prompt: null,
    how: matched.how,
  };

  if (attr.type === 'dimensions') {
    const parsed = parseDimensions(key, pair.value);
    if (!parsed) {
      rec.unmapped.set(key, (rec.unmapped.get(key) || 0) + 1);
      return;
    }
    if (parsed.packed) {
      rec.stats.packed_dims++;
      return;
    }
    if (parsed.flag === 'dimensions_axis_order_unknown') {
      rec.flags.push('dimensions_axis_order_unknown');
      rec.moderation.push({ code: attr.code, reason: 'dimensions_axis_order_unknown', key, value: pair.value });
      rec.stats.dims_unknown++;
      return;
    }
    rec.stats.dims_parsed++;
    setAttr(rec, attr.code, parsed.dims, prov);
    applyDims(rec, parsed.dims, { ...prov, from: 'dims' }, dict);
    return;
  }

  const norm = normalizeValue(attr, pair.value, { keyText: key });
  if (!norm.ok) {
    if (norm.reason === 'out_of_range') {
      rec.moderation.push({ code: attr.code, reason: 'out_of_range', value: norm.parsed, raw: pair.value });
    }
    return;
  }
  setAttr(rec, attr.code, norm.value, prov);
}

export function normalizeProduct(product, dict, config) {
  const rec = {
    id: product.id,
    name: product.name,
    description: product.description,
    annotation: product.annotation,
    attrs: emptyState(dict),
    provenance: {},
    identity: parseIdentity(product.name, dict),
    unmapped: new Map(),
    mapped: new Set(),
    flags: [],
    moderation: [],
    stats: { packed_dims: 0, dims_parsed: 0, dims_unknown: 0, blacklisted: 0, units: 0 },
    format: 'EMPTY',
    dump: false,
  };

  if (rec.identity.brand && dict.byCode.has('brand')) {
    setAttr(rec, 'brand', rec.identity.brand, {
      level: 'S0', raw: product.name, model: null, prompt: null, how: 'name',
    });
  }

  const parsed = parseProductFields(product, dict);
  rec.format = parsed.format;
  rec.dump = parsed.dump;
  rec.pairs = parsed.pairs;
  rec.stats.units = countUnitsInValues(parsed.pairs);

  for (const a of dict.attrs) {
    const syns = new Set([a.name, ...(a.synonyms || [])].map(s => normKey(s)).filter(Boolean));
    const src = parsed.fromAnn.length ? parsed.fromAnn : [];
    if (src.some(p => syns.has(normKey(p.key)))) rec.mapped.add(a.code);
  }

  ingestPairs(rec, parsed.pairs, dict, config);

  return rec;
}

export function ingestPairs(rec, pairs, dict, config) {
  const fuzzyMin = config?.fuzzy?.min_score ?? 0.93;
  for (const pair of pairs) ingestPair(rec, pair, dict, { fuzzyMin });
}

export function coverage(recs, dict) {
  const total = recs.length || 1;
  const out = {};
  for (const a of dict.attrs) {
    const filled = recs.filter(r => r.attrs[a.code] != null).length;
    const direct = recs.filter(r => {
      const p = r.provenance[a.code];
      return p && p.from !== 'dims' && r.attrs[a.code] != null;
    }).length;
    const mapped = recs.filter(r => r.mapped?.has(a.code)).length;
    out[a.code] = {
      coverage_now: a.coverage_now,
      fact: Math.round((mapped / total) * 100),
      fact_filled: Math.round((filled / total) * 100),
      fact_direct: Math.round((direct / total) * 100),
      filled,
      direct,
      mapped,
      total: recs.length,
    };
  }
  return out;
}

export function formatCounts(recs) {
  const c = { LI: 0, BR: 0, EMPTY: 0, OTHER: 0 };
  for (const r of recs) c[r.format] = (c[r.format] || 0) + 1;
  return c;
}

export function unmappedFreq(recs) {
  const m = new Map();
  for (const r of recs) {
    for (const [k, n] of r.unmapped) m.set(k, (m.get(k) || 0) + n);
  }
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'));
}
