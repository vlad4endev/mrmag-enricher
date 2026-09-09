/** Ш1–Ш5: разбор, сопоставление, нормализация, габариты, покрытие. Без сети и модели. */

import { parseProductFields } from './parse.js';
import { matchKey } from './match.js';
import { normalizeValue, countUnitsInValues } from './types.js';
import { parseDimensions, reconcileDimensions } from './dimensions.js';
import { parseIdentity } from './identity.js';
import { isPackingKey, normKey } from './text.js';

/** Приоритет источников: исходный JSON важнее веб-страницы похожего товара. */
export const SOURCE_RANK = Object.freeze({
  manufacturer: 50,
  official_product_page: 45,
  S0: 40,
  source_json: 35,
  S1: 35,
  S2: 20,
  trusted_retailer: 15,
  major_retailer: 15,
  S3: 10,
  retailer: 10,
  distributor: 8,
  model: 5,
  review: 3,
  other: 0,
});

function sourceRank(level) {
  if (level == null) return 0;
  return SOURCE_RANK[level] ?? SOURCE_RANK.other;
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 1e-9;
  }
  return String(a) === String(b);
}

function emptyState(dict) {
  const attrs = {};
  for (const a of dict.attrs) {
    if (a.tier === 'X') continue;
    attrs[a.code] = null;
  }
  return attrs;
}

/**
 * Запись атрибута с учётом приоритета источников.
 * При конфликте — логируем; при равном приоритете значение снимаем (unknown)
 * и ставим needs_review, а не оставляем «первое попавшееся» как факт.
 */
export function setAttr(rec, code, value, prov) {
  if (value == null) return false;
  if (!(code in rec.attrs)) return false; // tier X — нет слота
  const existing = rec.attrs[code];
  if (existing == null) {
    rec.attrs[code] = value;
    rec.provenance[code] = attachEvidence(code, value, prov);
    return true;
  }
  if (valuesEqual(existing, value)) {
    // Тот же факт из другого источника — усиливаем evidence, не конфликт.
    const old = rec.provenance[code] || {};
    if (sourceRank(prov?.level) > sourceRank(old.level)) {
      rec.provenance[code] = attachEvidence(code, value, { ...prov, previous_source: old.level });
    }
    return false;
  }

  const oldProv = rec.provenance[code] || {};
  const oldRank = sourceRank(oldProv.level);
  const newRank = sourceRank(prov?.level);
  if (!Array.isArray(rec.conflicts)) rec.conflicts = [];

  if (newRank > oldRank) {
    rec.conflicts.push({
      attribute: code,
      values: [
        { value: existing, source: oldProv.level || 'unknown', raw: oldProv.raw || null },
        { value, source: prov?.level || 'unknown', raw: prov?.raw || null },
      ],
      selected_value: value,
      reason: `priority ${prov?.level} > ${oldProv.level}`,
      kept: 'incoming',
      needs_review: false,
    });
    rec.attrs[code] = value;
    rec.provenance[code] = attachEvidence(code, value, { ...prov, conflict: true, previous: existing });
    return true;
  }

  if (newRank < oldRank) {
    rec.conflicts.push({
      attribute: code,
      values: [
        { value: existing, source: oldProv.level || 'unknown', raw: oldProv.raw || null },
        { value, source: prov?.level || 'unknown', raw: prov?.raw || null },
      ],
      selected_value: existing,
      reason: `priority ${oldProv.level} > ${prov?.level}`,
      kept: 'existing',
      needs_review: false,
    });
    return false;
  }

  // Равный приоритет — однозначного выбора нет: оставляем первое
  // (порядок ingest = annotation → description → web), помечаем needs_review.
  // Не обнуляем молча: иначе валидный S2 из того же текста теряется из‑за
  // соседней кривой строки («Установка = на стиральную машину…»).
  rec.conflicts.push({
    attribute: code,
    values: [
      { value: existing, source: oldProv.level || 'unknown', raw: oldProv.raw || null },
      { value, source: prov?.level || 'unknown', raw: prov?.raw || null },
    ],
    selected_value: existing,
    reason: 'equal_priority_keep_first',
    kept: 'existing',
    needs_review: true,
  });
  if (!Array.isArray(rec.flags)) rec.flags = [];
  if (!rec.flags.includes('conflict_unresolved')) rec.flags.push('conflict_unresolved');
  rec.needs_review = true;
  return false;
}

/** Внутренний ConfirmedAttribute в provenance (не в клиентский JSON). */
function attachEvidence(code, value, prov) {
  const raw = prov?.raw ?? null;
  return {
    ...prov,
    evidence: {
      attribute: code,
      raw_value: raw,
      normalized_value: value,
      filter_value: null,
      source: prov?.level || 'other',
      evidence: raw,
      confidence: evidenceConfidence(prov),
    },
  };
}

function evidenceConfidence(prov) {
  const rank = sourceRank(prov?.level);
  if (rank >= 45) return 1;
  if (rank >= 30) return 0.9;
  if (rank >= 15) return 0.7;
  if (rank >= 5) return 0.5;
  return 0.3;
}

function tryCompoundDims(key, value) {
  const blob = `${key} ${value}`;
  if (!/(\d+(?:[.,]\d+)?)\s*(?:[x×хX*]|\s+на\s+)\s*(\d+(?:[.,]\d+)?)\s*(?:[x×хX*]|\s+на\s+)\s*(\d+(?:[.,]\d+)?)/i.test(blob)) {
    return null;
  }
  const parsed = parseDimensions(blob, value);
  if (parsed?.dims && !parsed.packed && parsed.flag !== 'dimensions_axis_order_unknown') return parsed;
  return null;
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
      const fallback = parseDimensions(attr.name || 'ШхГхВ', pair.value);
      if (fallback?.dims && !fallback.packed && fallback.flag !== 'dimensions_axis_order_unknown') {
        rec.stats.dims_parsed++;
        applyDims(rec, fallback.dims, { ...prov, from: 'dims', how: 'dims_attr_order' }, dict);
        setAttr(rec, attr.code, fallback.dims, prov);
        return;
      }
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
    // «Высота х Ширина х Глубина … — 177.5 х 90.5 х 72.6»: ключ съехал на первую ось.
    const compound = tryCompoundDims(key, pair.value);
    if (compound) {
      rec.stats.dims_parsed++;
      applyDims(rec, compound.dims, { ...prov, from: 'dims', how: 'dims_from_axis_line' }, dict);
      if (dict.byCode.has('dims')) setAttr(rec, 'dims', compound.dims, { ...prov, from: 'dims' });
      return;
    }
    return;
  }
  setAttr(rec, attr.code, norm.value, {
    ...prov,
    pending_canon: Boolean(norm.pending_canon),
  });
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
    conflicts: [],
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
  deriveLinkedAttrs(rec, dict, product);

  return rec;
}

function factBlob(rec, product) {
  const ann = String(rec.annotation || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ');
  return [
    product?.name || rec.name,
    ann,
    rec.attrs.fridge_type,
    rec.provenance?.fridge_type?.raw,
  ].filter(Boolean).join(' ').toLowerCase().replace(/ё/g, 'е');
}

function derivedLevel(rec, fromCode) {
  const lv = rec.provenance?.[fromCode]?.level;
  if (lv === 'S1' || lv === 'S2' || lv === 'S3') return lv;
  return 'S0';
}

function setDerived(rec, dict, code, rawLabel, how, level) {
  if (!dict.byCode.has(code) || rec.attrs[code] != null) return false;
  const attr = dict.byCode.get(code);
  if (attr.tier === 'X') return false;
  const norm = normalizeValue(attr, rawLabel, { keyText: attr.name });
  if (!norm.ok) return false;
  return setAttr(rec, code, norm.value, {
    level,
    raw: rawLabel,
    model: null,
    prompt: null,
    how,
  });
}

/**
 * Составные габариты для filters_*.json: если в источнике нет строки Ш×Г×В,
 * но есть все три оси, склеиваем тот же объект, что пишет аннотация.
 */
export function deriveDimsFromAxes(rec, dict) {
  if (!dict?.byCode?.has('dims') || rec.attrs?.dims != null) return false;
  const attr = dict.byCode.get('dims');
  if (attr.tier === 'X') return false;
  const width = rec.attrs.width;
  const height = rec.attrs.height;
  const depth = rec.attrs.depth;
  if (typeof width !== 'number' || typeof height !== 'number' || typeof depth !== 'number') {
    return false;
  }
  const levels = ['width', 'height', 'depth']
    .map(code => rec.provenance?.[code]?.level)
    .filter(Boolean);
  let level = 'S0';
  if (levels.length) {
    level = levels[0];
    for (const lv of levels) {
      if (sourceRank(lv) < sourceRank(level)) level = lv;
    }
  }
  return setAttr(rec, 'dims', { width, height, depth }, {
    level,
    raw: `${width}×${depth}×${height}`,
    model: null,
    prompt: null,
    how: 'derived_dims_from_axes',
    from: 'axes',
  });
}

/**
 * Связанные факты из уже разобранного текста: тип холодильника → камеры
 * и сторона морозилки; стиралка без «установки» → отдельностоящая.
 * level не 'model': иначе filterSourceAllowed выкинет значение с витрины.
 */
function deriveLinkedAttrs(rec, dict, product) {
  const blob = factBlob(rec, product);

  if (dict.byCode.has('install') && rec.attrs.install == null) {
    const builtIn = /встраиваем|встроенн/.test(blob);
    const label = builtIn ? 'Встраиваемая' : 'Отдельностоящая';
    setDerived(rec, dict, 'install', label, 'derived_install', 'S0');
  }

  if (dict.byCode.has('load_type') && rec.attrs.load_type == null && !/сушильн/.test(blob)) {
    if (/вертикал/.test(blob)) {
      setDerived(rec, dict, 'load_type', 'Вертикальная', 'derived_load_type', 'S0');
    } else if (/фронтал/.test(blob)) {
      setDerived(rec, dict, 'load_type', 'Фронтальная', 'derived_load_type', 'S0');
    }
  }

  if (dict.byCode.has('freezer_pos') && rec.attrs.freezer_pos == null) {
    let label = null;
    if (/side\s*-?\s*by\s*-?\s*side|сбоку/.test(blob)) label = 'Сбоку';
    else if (/без морозил/.test(blob)) label = 'Отсутствует';
    else if (/нижн|снизу/.test(blob)) label = 'Снизу';
    else if (/верхн|сверху/.test(blob)) label = 'Сверху';
    else if (/однокамер/.test(blob) && /(?<![а-яё])нто(?![а-яё])/u.test(blob)) label = 'Сверху';
    if (label) {
      setDerived(rec, dict, 'freezer_pos', label, 'derived_from_fridge_type', derivedLevel(rec, 'fridge_type'));
    }
  }

  if (dict.byCode.has('chambers') && rec.attrs.chambers == null) {
    let n = null;
    if (/четырехкамер|четырёхкамер|4-камер/.test(blob)) n = 4;
    else if (/трехкамер|трёхкамер|3-камер/.test(blob)) n = 3;
    else if (/однокамер|1-камер/.test(blob)) n = 1;
    else if (/двухкамер|2-камер|side\s*-?\s*by|нижн\w*.{0,20}морозил|верхн\w*.{0,20}морозил|четырехдвер|четырёхдвер/.test(blob)) n = 2;
    if (n != null) {
      setDerived(rec, dict, 'chambers', String(n), 'derived_chambers', derivedLevel(rec, 'fridge_type'));
    }
  }

  deriveDimsFromAxes(rec, dict);
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
