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
  const letters = s.match(RE_LETTERS);
  if (letters) return [letters[1], letters[2], letters[3]].map(c => AXIS_LETTER[c.toLowerCase()]);
  const words = [];
  const re = /ширин[аыеу]?|высот[аыеу]?|глубин[аыеу]?/gi;
  let m;
  const text = s;
  while ((m = re.exec(text))) {
    const w = AXIS_WORD.find(([p]) => p.test(m[0]));
    if (w) words.push(w[1]);
  }
  if (words.length === 3) return words;
  return null;
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
