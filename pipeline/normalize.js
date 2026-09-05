/** Ш1–Ш5: разбор, сопоставление, нормализация, габариты, покрытие. Без сети и модели. */

import { parseProductFields } from './parse.js';
import { matchKey } from './match.js';
import { normalizeValue, countUnitsInValues } from './types.js';
import { parseDimensions, reconcileDimensions } from './dimensions.js';
import { parseIdentity } from './identity.js';
import { isPackingKey, normKey } from './text.js';

function emptyState(dict) {
  const attrs = {};
  for (const a of dict.attrs) {
    if (a.tier === 'X') continue;
    attrs[a.code] = null;
  }
  return attrs;
}

function setAttr(rec, code, value, prov) {
  if (value == null || rec.attrs[code] != null) return false;
  if (!(code in rec.attrs)) return false; // tier X — нет слота
  rec.attrs[code] = value;
  rec.provenance[code] = prov;
  return true;
}

function applyDims(rec, dims, prov, dict) {
  let used = false;
  for (const axis of ['width', 'height', 'depth']) {
    if (dims[axis] == null || !dict.byCode.has(axis)) continue;
    const attr = dict.byCode.get(axis);
    if (attr.tier === 'X') continue;
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
  if (isPackingKey(key) && /габарит|размер|ширин|высот|глубин|вес|масс/i.test(key)) {
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
  if (attr.tier === 'X') {
    rec.stats.tier_x++;
    return;
  }

  rec.mapped.add(attr.code);
  const prov = {
    level: pair.source || 'S1',
    raw: `${key} = ${pair.value}`,
    model: null,
    prompt: null,
    how: matched.how,
    fuzzy_match: matched.fuzzy_match || false,
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
    const separate = {
      width: rec.attrs.width,
      height: rec.attrs.height,
      depth: rec.attrs.depth,
    };
    const hasSeparate = separate.width != null || separate.height != null || separate.depth != null;
    const recon = reconcileDimensions(
      hasSeparate ? Object.fromEntries(Object.entries(separate).filter(([, v]) => v != null)) : null,
      parsed.dims,
    );
    if (recon.flag === 'dimensions_mismatch') {
      rec.flags.push('dimensions_mismatch');
      rec.moderation.push({ code: attr.code, reason: 'dimensions_mismatch', key, value: pair.value });
    }
    setAttr(rec, attr.code, recon.dims, prov);
    applyDims(rec, recon.dims, { ...prov, from: 'dims' }, dict);
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
    stats: { packed_dims: 0, dims_parsed: 0, dims_unknown: 0, blacklisted: 0, units: 0, tier_x: 0 },
    format: 'EMPTY',
    dump: false,
  };

  if (rec.identity.brand && dict.byCode.has('brand')) {
    const brandAttr = dict.byCode.get('brand');
    if (brandAttr.tier !== 'X') {
      setAttr(rec, 'brand', rec.identity.brand, {
        level: 'S0', raw: product.name, model: null, prompt: null, how: 'name',
      });
    }
  }

  // Тип товара из имени: «Кухонная вытяжка …» / «Воздухоочиститель …».
  if (dict.byCode.has('product_type') && rec.attrs.product_type == null) {
    const n = String(product.name || '').toLowerCase().replace(/ё/g, 'е');
    let pt = null;
    if (/воздухоочистител/.test(n)) pt = 'Воздухоочиститель';
    else if (/вытяжк/.test(n)) pt = 'Вытяжка';
    if (pt) {
      setAttr(rec, 'product_type', pt, {
        level: 'S0', raw: product.name, model: null, prompt: null, how: 'name',
      });
    }
  }

  const parsed = parseProductFields(product, dict);
  rec.format = parsed.format;
  rec.dump = parsed.dump;
  rec.pairs = parsed.pairs;
  rec.stats.units = countUnitsInValues(parsed.pairs);

  for (const a of dict.attrs) {
    if (a.tier === 'X') continue;
    const syns = new Set([a.name, ...(a.synonyms || [])].map(s => normKey(s)).filter(Boolean));
    const src = parsed.fromAnn.length ? parsed.fromAnn : [];
    if (src.some(p => syns.has(normKey(p.key)))) rec.mapped.add(a.code);
  }

  ingestPairs(rec, parsed.pairs, dict, config);

  return rec;
}

export function ingestPairs(rec, pairs, dict, config) {
  const fuzzyMin = config?.fuzzy?.min_score ?? config?.conditions?.fuzzy_min_score;
  if (fuzzyMin == null) throw new Error('config.fuzzy.min_score обязателен');
  for (const pair of pairs) {
    const matched = matchKey(pair.key, dict, { value: pair.value, fuzzyMin });
    // inferable: false — запрет вывода моделью (source=model), не S1/S2/S3.
    if (matched.attr && matched.attr.inferable === false && pair.source === 'model') {
      continue;
    }
    if (matched.attr?.tier === 'X') continue;
    ingestPair(rec, pair, dict, { fuzzyMin });
  }
}

export function coverage(recs, dict) {
  const total = recs.length || 1;
  const out = {};
  for (const a of dict.attrs) {
    if (a.tier === 'X') {
      out[a.code] = { coverage_now: a.coverage_now, fact: 0, fact_filled: 0, fact_direct: 0, filled: 0, direct: 0, mapped: 0, total: recs.length };
      continue;
    }
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
