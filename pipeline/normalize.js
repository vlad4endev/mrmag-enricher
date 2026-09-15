/** Ш1–Ш5: разбор, сопоставление, нормализация, габариты, покрытие. Без сети и модели. */

import { parseProductFields } from './parse.js';
import { matchKey } from './match.js';
import {
  normalizeValue,
  countUnitsInValues,
  defrostCanonFromCooling,
  isDripCooling,
  manualFreezerDefrostInBlob,
  valueFold,
} from './types.js';
import { parseDimensions, reconcileDimensions, isCompleteDims } from './dimensions.js';
import { parseIdentity } from './identity.js';
import { isPackingKey, normKey } from './text.js';
import { inferProductKind, isWasherLike, markCategoryMismatch } from './category_mismatch.js';
import { harvestStorefrontFacts } from './storefront_fill.js';

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

/** «Уровень шума (стирка / отжим) — 55 / 73 дБ»: первое число — стирка, второе — отжим. */
function parseDualWashSpinNoise(key, value) {
  const k = String(key || '').toLowerCase().replace(/ё/g, 'е');
  const v = String(value || '').toLowerCase().replace(/ё/g, 'е');
  const blob = `${k} ${v}`;
  // Подписи «стирка/отжим» бывают в ключе ИЛИ в значении: «60/76 дБ (стирка/отжим)».
  if (!/шум/.test(blob) || !/стирк/.test(blob) || !/отжим|вращен/.test(blob)) return null;
  const nums = String(value || '').replace(',', '.').match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 2) return null;
  const wash = Number(nums[0]);
  const spin = Number(nums[1]);
  if (!Number.isFinite(wash) || !Number.isFinite(spin)) return null;
  return { wash, spin };
}

export function ingestPair(rec, pair, dict, { fuzzyMin } = {}) {
  const key = pair.key;
  if (isPackingKey(key) && /габарит|размер|ширин|высот|глубин|вес|масс/i.test(key)) {
    rec.stats.packed_dims++;
    return;
  }

  const dualNoise = parseDualWashSpinNoise(key, pair.value);
  if (dualNoise) {
    const baseProv = {
      level: pair.source || 'S1',
      raw: `${key} = ${pair.value}`,
      model: null,
      prompt: null,
      how: 'dual_noise',
    };
    if (dict.byCode.has('noise_wash')) {
      const attr = dict.byCode.get('noise_wash');
      const norm = normalizeValue(attr, dualNoise.wash, { keyText: key });
      if (norm.ok) {
        rec.mapped.add('noise_wash');
        setAttr(rec, 'noise_wash', norm.value, baseProv);
      }
    }
    if (dict.byCode.has('noise_spin')) {
      const attr = dict.byCode.get('noise_spin');
      const norm = normalizeValue(attr, dualNoise.spin, { keyText: key });
      if (norm.ok) {
        rec.mapped.add('noise_spin');
        setAttr(rec, 'noise_spin', norm.value, baseProv);
      }
    }
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

  // Автомат / полуавтомат: из имени или раздела (953 — полуавтоматы).
  // Чистые сушилки и аксессуары пропускаем (не путать с «сушкой» в описании СМА).
  if (dict.byCode.has('washer_type') && rec.attrs.washer_type == null) {
    const kind = recKind(rec, product);
    if (kind !== 'dryer' && kind !== 'accessory') {
      const n = String(product.name || '').toLowerCase().replace(/ё/g, 'е');
      const cat = `${product.category || ''} ${product.category_id || ''}`.toLowerCase().replace(/ё/g, 'е');
      let wt = null;
      if (
        /полуавтомат/.test(n)
        || /полуавтомат/.test(cat)
        || String(product.category_id) === '953'
        || String(product.category) === '953'
      ) {
        wt = 'Полуавтоматическая';
      } else if (/автоматическ/.test(n) && /стиральн/.test(n)) {
        wt = 'Автоматическая';
      }
      if (wt) {
        setAttr(rec, 'washer_type', wt, {
          level: 'S0',
          raw: product.name || product.category || String(product.category_id || ''),
          model: null,
          prompt: null,
          how: 'name',
        });
      }
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
    const src = [
      ...(parsed.fromAttrs || []),
      ...(parsed.fromAnn || []),
    ];
    if (src.some(p => syns.has(normKey(p.key)))) rec.mapped.add(a.code);
  }

  ingestPairs(rec, parsed.pairs, dict, config);
  deriveLinkedAttrs(rec, dict, product, config);
  markCategoryMismatch(rec, dict.catId);

  return rec;
}

function recKind(rec, product) {
  return inferProductKind(
    product?.name || rec?.name,
    [
      product?.annotation || rec?.annotation || '',
      product?.description || rec?.description || '',
    ].join('\n'),
  );
}

function factBlob(rec, product) {
  const strip = (s) => String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ');
  return [
    product?.name || rec.name,
    strip(rec.annotation || product?.annotation),
    strip(rec.description || product?.description),
    strip(rec._enriched?.description || product?._enriched?.description),
    rec.attrs.fridge_type,
    rec.provenance?.fridge_type?.raw,
  ].filter(Boolean).join(' ').toLowerCase().replace(/ё/g, 'е');
}

function derivedLevel(rec, fromCode) {
  const lv = rec.provenance?.[fromCode]?.level;
  if (lv === 'S1' || lv === 'S2' || lv === 'S3') return lv;
  return 'S0';
}

export function setDerived(rec, dict, code, rawLabel, how, level) {
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
  if (!dict?.byCode?.has('dims')) return false;
  if (!isCompleteDims(rec.attrs?.dims)) rec.attrs.dims = null;
  if (rec.attrs?.dims != null) return false;
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
function deriveLinkedAttrs(rec, dict, product, config) {
  const blob = factBlob(rec, product);

  if (dict.byCode.has('install') && rec.attrs.install == null) {
    const kind = recKind(rec, product);
    if (kind !== 'accessory') {
      const builtIn = /встраиваем|встроенн/.test(blob);
      const freestanding = /отдельн(?:о\s*)?стоя|напольн|свободностоя/.test(blob);
      // Явная строка «Установка: …» важнее свободных упоминаний в SEO/meta.
      const labeled = blob.match(/установк[а-яё]*\s*[-–—:]\s*([^\n,;<]+)/i);
      let label = null;
      if (labeled) {
        const raw = labeled[1];
        if (/встраиваем|встроенн/.test(raw)) label = 'Встраиваемая';
        else if (/отдельн|напольн|свободностоя/.test(raw)) label = 'Отдельностоящая';
        else if (/встраиван/.test(raw)) label = 'С возможностью встраивания';
      }
      if (!label) {
        if (builtIn && freestanding) {
          // Конфликт поверхностей — не угадываем; enum_align разберёт позже.
          label = null;
        } else if (builtIn) {
          label = 'Встраиваемая';
        } else {
          // Стиралки без явного «встраиваемая» — отдельностоящие.
          label = 'Отдельностоящая';
        }
      }
      if (label) setDerived(rec, dict, 'install', label, 'derived_install', 'S0');
    }
  }

  if (dict.byCode.has('load_type') && rec.attrs.load_type == null) {
    const kind = recKind(rec, product);
    if (kind !== 'dryer' && kind !== 'accessory') {
      if (/вертикал/.test(blob)) {
        setDerived(rec, dict, 'load_type', 'Вертикальная', 'derived_load_type', 'S0');
      } else if (/фронтал/.test(blob)) {
        setDerived(rec, dict, 'load_type', 'Фронтальная', 'derived_load_type', 'S0');
      } else if (isWasherLike(kind) || String(dict.catId) === '467') {
        // Вертикальные почти всегда названы; остальные СМА — фронтальные.
        setDerived(rec, dict, 'load_type', 'Фронтальная', 'derived_load_type', 'S0');
      }
    }
  }

  // Автомат vs полуавтомат: полуавтомат всегда сильнее; иначе явные маркеры
  // или стиралка/СМА в имени → автоматическая. Сушилки/аксессуары — не трогаем.
  if (dict.byCode.has('washer_type') && rec.attrs.washer_type == null) {
    const kind = recKind(rec, product);
    if (kind !== 'dryer' && kind !== 'accessory') {
      let label = null;
      if (/полуавтомат/.test(blob)) {
        label = 'Полуавтоматическая';
      } else if (
        /вид\s+стиральн\w*\s*[-–—:]\s*автомат/.test(blob)
        || /автоматическ\w*\s+стиральн/.test(blob)
        || /стиральн\w*\s+машин\w*[^\n.;]{0,40}автоматическ/.test(blob)
        || isWasherLike(kind)
        || /стиральн|стир\.?\s*маш/.test(blob)
        || String(dict.catId) === '467'
      ) {
        label = 'Автоматическая';
      }
      if (label) setDerived(rec, dict, 'washer_type', label, 'derived_washer_type', 'S0');
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

  if (dict.byCode.has('fridge_type') && rec.attrs.fridge_type == null) {
    let label = null;
    if (/side\s*-?\s*by\s*-?\s*side/.test(blob)) label = 'Side-by-Side';
    else if (/трехкамер|трёхкамер|3-камер/.test(blob)) label = 'Трёхкамерный';
    else if (/однокамер|1-камер/.test(blob)) label = 'Однокамерный';
    else if (/двухкамер|2-камер/.test(blob)) label = 'Двухкамерный';
    else if (rec.attrs.chambers === 1) label = 'Однокамерный';
    else if (rec.attrs.chambers === 3) label = 'Трёхкамерный';
    else if (rec.attrs.chambers === 2) label = 'Двухкамерный';
    if (label) {
      setDerived(rec, dict, 'fridge_type', label, 'derived_fridge_type', derivedLevel(rec, 'chambers'));
    }
  }

  if (dict.byCode.has('doors') && rec.attrs.doors == null) {
    let n = null;
    if (/четырехдвер|четырёхдвер|4-двер|4\s*двер/.test(blob)) n = 4;
    else if (/трехдвер|трёхдвер|3-двер|3\s*двер/.test(blob)) n = 3;
    else if (/однодвер|1-двер|1\s*двер/.test(blob)) n = 1;
    else if (/двухдвер|2-двер|2\s*двер/.test(blob)) n = 2;
    else if (rec.attrs.fridge_type === 'Однокамерный' || rec.attrs.chambers === 1) n = 1;
    else if (rec.attrs.fridge_type === 'Двухкамерный' || rec.attrs.chambers === 2) n = 2;
    if (n != null) {
      setDerived(rec, dict, 'doors', String(n), 'derived_doors', derivedLevel(rec, 'fridge_type'));
    }
  }

  if (dict.byCode.has('display') && rec.attrs.display == null) {
    let flag = null;
    if (/без\s+диспл|\bнет\b.{0,16}диспл|диспл\w*\s+(нет|отсутств)/i.test(blob)) {
      flag = 'Нет';
    } else if (/тип\s+дисплея|led[\s-]?дисп|диспл\w*\s*[-–—:]?\s*(led|tft|lcd|есть|да)\b|цифров\w*\s+\(?символьн|сенсорн\w+\s+диспл|\btft\b|\blcd\b[\s-]?дисп|\boled\b/i.test(blob)) {
      flag = 'Есть';
    } else {
      const kind = recKind(rec, product);
      const inCat = kind === 'fridge' || isWasherLike(kind)
        || ((String(dict.catId) === '467' || String(dict.catId) === '523')
          && kind !== 'accessory' && kind !== 'dryer');
      const ctrl = String(Array.isArray(rec.attrs.control_type)
        ? rec.attrs.control_type.join(' ')
        : (rec.attrs.control_type || ''));
      const mechanical = /механическ|электромеханическ|электро-механическ/.test(ctrl)
        || (!ctrl && /механическ|электромеханическ|электро-механическ/.test(blob)
          && !/электронн|сенсорн/.test(blob));
      if (inCat && mechanical && !/диспл|индикац\w+\s+температур/i.test(blob)) {
        flag = 'Нет';
      }
    }
    if (flag) setDerived(rec, dict, 'display', flag, 'derived_display', 'S0');
  }

  if (dict.byCode.has('drying') && rec.attrs.drying == null) {
    const kind = recKind(rec, product);
    let flag = null;
    if (kind === 'accessory') {
      flag = null;
    } else if (kind === 'dryer' || kind === 'washer-dryer'
      || /стирально-сушильн|с\s+сушкой|загрузк\w*.{0,24}для\s+сушк/i.test(blob)) {
      flag = 'Есть';
    } else if (/сушк[ауи]\s*[-–—:]\s*(нет|не\s|отсутств)|без\s+сушк/i.test(blob)) {
      flag = 'Нет';
    } else if (isWasherLike(kind) || String(dict.catId) === '467') {
      flag = 'Нет';
    }
    if (flag) setDerived(rec, dict, 'drying', flag, 'derived_drying', 'S0');
  }

  if (dict.byCode.has('motor_type') && rec.attrs.motor_type == null) {
    const kind = recKind(rec, product);
    let label = null;
    if (/инвертор|bldc|прямой\s+привод/i.test(blob)) label = 'Инверторный';
    else if (/щеточн|коллекторн/.test(blob)) label = 'Коллекторный';
    else if (
      (isWasherLike(kind) || String(dict.catId) === '467')
      && kind !== 'dryer'
      && kind !== 'accessory'
      && (rec.attrs.load_max != null || rec.attrs.spin_max != null || rec.attrs.energy_class != null)
    ) {
      label = 'Коллекторный';
    }
    if (label) setDerived(rec, dict, 'motor_type', label, 'derived_motor_type', 'S0');
  }

  if (dict.byCode.has('compressor_type') && rec.attrs.compressor_type == null) {
    if (/линейн|linear/.test(blob)) {
      setDerived(rec, dict, 'compressor_type', 'Линейный', 'derived_compressor', 'S0');
    } else if (/инвертор/.test(blob)) {
      setDerived(rec, dict, 'compressor_type', 'Инверторный', 'derived_compressor', 'S0');
    }
  }

  if (dict.byCode.has('cooling') && rec.attrs.cooling == null) {
    let label = null;
    if (/full\s*no\s*frost|total\s*no\s*frost/i.test(blob)) label = 'Full No Frost';
    else if (/без\s*no\s*frost|капельн/i.test(blob)) label = 'Капельная';
    else if (/\bfnf\b|no[\s-]?frost|ноу[\s-]?фрост/i.test(blob)) label = 'No Frost';
    else if (/ручн\w*\s+размороз/i.test(blob)) label = 'Статическая';
    else if (
      recKind(rec, product) === 'fridge'
      && /механическ|электромеханическ/.test(String(rec.attrs.control_type || ''))
    ) {
      label = 'Капельная';
    }
    if (label) setDerived(rec, dict, 'cooling', label, 'derived_cooling', 'S0');
  }

  harvestStorefrontFacts(rec, dict, product);

  refreshDerivedFacets(rec, dict, product);
}

function isNoFrostLabel(v) {
  return /no[\s-]?frost|ноу[\s-]?фрост/i.test(String(v || '').replace(/ё/g, 'е'));
}

/**
 * После specs/добора: разморозка из системы охлаждения и габариты из осей.
 * Капельная / «без No Frost»: морозилка — «Ручное». SEO «No Frost» не берём
 * и не оставляем, если ось уже успела заполниться моделью.
 */
export function refreshDerivedFacets(rec, dict, product) {
  const blob = factBlob(rec, product);
  const cooling = rec.attrs.cooling;
  const drip = isDripCooling(cooling);
  if (dict.byCode.has('defrost_fridge') && rec.attrs.defrost_fridge == null) {
    const label = defrostCanonFromCooling(cooling, 'fridge')
      || defrostCanonFromCooling(blob, 'fridge');
    if (label) {
      setDerived(rec, dict, 'defrost_fridge', label, 'derived_defrost_from_cooling', derivedLevel(rec, 'cooling'));
    }
  }
  if (dict.byCode.has('defrost_freezer')) {
    const manualFreezer = manualFreezerDefrostInBlob(blob);
    const label = manualFreezer
      ? 'Ручное'
      : (defrostCanonFromCooling(cooling, 'freezer')
        || (!drip ? defrostCanonFromCooling(blob, 'freezer') : 'Ручное'));
    const cur = rec.attrs.defrost_freezer;
    const forceManual = manualFreezer || (drip && isNoFrostLabel(cur) && label === 'Ручное');
    if (cur == null) {
      if (label) {
        setDerived(rec, dict, 'defrost_freezer', label, 'derived_defrost_from_cooling', derivedLevel(rec, 'cooling'));
      }
    } else if (forceManual && label && valueFold(cur) !== valueFold(label)) {
      rec.attrs.defrost_freezer = label;
      rec.provenance = rec.provenance || {};
      rec.provenance.defrost_freezer = {
        level: derivedLevel(rec, 'cooling'),
        raw: manualFreezer ? 'manual_freezer_defrost_in_blob' : String(cooling || label),
        model: null,
        prompt: null,
        how: 'derived_defrost_from_cooling',
        previous: cur,
      };
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
