/** Разбор составных габаритов. Порядок осей — из имени ключа, не из данных. */

import { isPackingKey } from './text.js';

const AXIS_LETTER = { ш: 'width', в: 'height', г: 'depth', д: 'depth', w: 'width', h: 'height', d: 'depth' };
const AXIS_WORD = [
  [/ширин/i, 'width'],
  [/высот/i, 'height'],
  [/глубин/i, 'depth'],
  [/длин/i, 'depth'],
];

const RE_TRIPLE = /(\d+(?:[.,]\d+)?)\s*(?:[x×хX*]|\s+на\s+)\s*(\d+(?:[.,]\d+)?)\s*(?:[x×хX*]|\s+на\s+)\s*(\d+(?:[.,]\d+)?)/i;
const RE_LETTERS = /([швгдwhd])\s*[x×хx*]\s*([швгдwhd])\s*[x×хx*]\s*([швгдwhd])/i;
const BARE_DIM_KEYS = /^(габариты|размеры|размер)$/i;

export function axisOrderFromKey(key) {
  const s = String(key || '');
  // Ближайшая к числам подпись — последняя в окне, не первая в абзаце.
  const letterRe = new RegExp(RE_LETTERS.source, 'gi');
  let letters = null;
  let m;
  while ((m = letterRe.exec(s))) {
    letters = [m[1], m[2], m[3]].map(c => AXIS_LETTER[c.toLowerCase()]);
  }
  if (letters?.length === 3 && letters.every(Boolean)) return letters;
  const words = [];
  const re = /ширин[аыеу]?|высот[аыеу]?|глубин[аыеу]?/gi;
  while ((m = re.exec(s))) {
    const w = AXIS_WORD.find(([p]) => p.test(m[0]));
    if (w) words.push(w[1]);
  }
  if (words.length === 3) return words;
  return null;
}

const AXIS_LETTER_RU = { width: 'Ш', height: 'В', depth: 'Г' };
const AXIS_WORD_RU = { width: 'ширина', height: 'высота', depth: 'глубина' };

/** Каталог 467 — Ш×Г×В, 523 — Ш×В×Г: порядок из имени атрибута dims. */
export function catalogAxisOrder(dict) {
  const attr = dict?.byCode?.get?.('dims')
    || (dict?.attrs || []).find(a => a?.code === 'dims');
  return axisOrderFromKey(attr?.facet?.label || attr?.name || 'ШхГхВ')
    || ['width', 'depth', 'height'];
}

export function catalogDimsPrompt(dict) {
  const order = catalogAxisOrder(dict);
  return `${order.map(a => AXIS_LETTER_RU[a]).join('×')} (${order.map(a => AXIS_WORD_RU[a]).join(' × ')})`;
}

/** Подпись осей рядом с тройкой: скобки слева, иногда справа. */
export function axisOrderNearTriple(src, start, end) {
  const left = String(src || '').slice(Math.max(0, start - 140), start);
  const low = left.toLowerCase();
  const cut = Math.max(low.lastIndexOf('габарит'), low.lastIndexOf('размер'), low.lastIndexOf('('));
  const before = cut >= 0 ? left.slice(cut) : left.slice(-90);
  const after = String(src || '').slice(end, end + 36);
  return axisOrderFromKey(before) || axisOrderFromKey(after);
}

export function parseTriple(raw) {
  const m = String(raw || '').match(RE_TRIPLE);
  if (!m) return null;
  return [m[1], m[2], m[3]].map(x => parseFloat(x.replace(',', '.')));
}

function toCm(n, unitHint) {
  if (unitHint === 'мм' || (unitHint == null && n >= 400)) return n / 10;
  return n;
}

function unitHint(key, value) {
  const s = `${key} ${value}`.toLowerCase();
  if (/(?<![а-яёa-z])мм(?![а-яё])/.test(s)) return 'мм';
  if (/(?<![а-яёa-z])см(?![а-яё])/.test(s)) return 'см';
  return null;
}

/**
 * @returns {{dims: {width?:number,height?:number,depth?:number}, flag?: string, packed?: boolean}|null}
 */
export function parseDimensions(key, value) {
  if (isPackingKey(key) || isPackingKey(value)) {
    return { dims: null, packed: true, flag: 'packing_discarded' };
  }
  // «600 x 550(*590/**1030) x 850» — в скобках альтернативы, не третья ось.
  const cleaned = String(value || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const nums = parseTriple(cleaned) || parseTriple(value);
  if (!nums) return null;
  const unit = unitHint(key, value);
  const cm = nums.map(n => +toCm(n, unit).toFixed(2));
  const order = axisOrderFromKey(key);
  if (!order) {
    return { dims: null, flag: 'dimensions_axis_order_unknown', raw: cm };
  }
  const dims = {};
  order.forEach((axis, i) => { dims[axis] = cm[i]; });
  return { dims, packed: false };
}

/**
 * Приоритет у отдельных Высота/Ширина/Глубина.
 * Расхождение с составными > 5% → dimensions_mismatch.
 */
export function reconcileDimensions(separate, compound) {
  if (!compound) return { dims: separate || null, flag: null };
  if (!separate) return { dims: compound, flag: null };
  const out = { ...compound, ...separate };
  for (const axis of ['width', 'height', 'depth']) {
    const a = separate[axis];
    const b = compound[axis];
    if (a == null || b == null) continue;
    const base = Math.max(Math.abs(a), Math.abs(b), 1e-9);
    if (Math.abs(a - b) / base > 0.05) {
      return { dims: separate, flag: 'dimensions_mismatch' };
    }
  }
  return { dims: out, flag: null };
}

/** Три числа на месте — можно клеить «Ш×Г×В». Неполный объект габаритов = дыра. */
export function isCompleteDims(v) {
  return Boolean(
    v && typeof v === 'object' && !Array.isArray(v)
    && typeof v.width === 'number'
    && typeof v.height === 'number'
    && typeof v.depth === 'number',
  );
}

export function dimsFromAxes(rec) {
  if (isCompleteDims(rec?.attrs?.dims)) return rec.attrs.dims;
  const width = rec?.attrs?.width;
  const height = rec?.attrs?.height;
  const depth = rec?.attrs?.depth;
  if (typeof width === 'number' && typeof height === 'number' && typeof depth === 'number') {
    return { width, height, depth };
  }
  return null;
}
