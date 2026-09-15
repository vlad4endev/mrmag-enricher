/**
 * Сверка значений: бакет фильтра vs точное число из annotation,
 * и явные факты description vs filters/annotation.
 */

import { matchBucket, coerceFacetNumber, facetKind } from './facets.js';
import {
  catKey, sheetToFilterKey, hasFilterValue, displayFilterValue, APPROVED_MAP,
} from './approved_filters.js';
import { axisOrderNearTriple } from './dimensions.js';

const SIZE_LABELS = {
  depth: ['глубина', 'глубина, см'],
  height: ['высота', 'высота, см'],
  width: ['ширина', 'ширина, см'],
  weight: ['вес', 'вес, кг', 'вес нетто'],
  noise: ['уровень шума при стирке', 'шум при стирке', 'уровень шума'],
  vol_total: ['общий объём', 'общий объем', 'объём общий'],
  vol_fridge: ['объём холодильной камеры', 'объем холодильной камеры'],
  vol_freezer: ['объём морозильной камеры', 'объем морозильной камеры'],
};

const SHEET_TO_SIZE = {
  'Глубина': 'depth',
  'Глубина, см': 'depth',
  'Высота': 'height',
  'Высота, см': 'height',
  'Ширина': 'width',
  'Ширина, см': 'width',
  'Вес': 'weight',
  'Вес, кг': 'weight',
  'Уровень шума при стирке': 'noise',
  'Уровень шума': 'noise',
  'Общий объём': 'vol_total',
  'Объём холодильной камеры': 'vol_fridge',
  'Объём морозильной камеры': 'vol_freezer',
};

export function plainText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(li|p|div|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&times;/gi, '×')
    .replace(/&ndash;|&mdash;/gi, '—')
    .replace(/\s+/g, ' ')
    .trim();
}

function num(s) {
  const n = parseFloat(String(s || '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function toCm(n, unit, labeledSize) {
  if (n == null) return null;
  const u = String(unit || '').toLowerCase();
  if (u === 'мм' || u === 'mm') return n / 10;
  if (u === 'см' || u === 'cm') return n;
  if (labeledSize && n >= 100 && n <= 2500) return n / 10;
  return n;
}

export function parseBucketRange(label) {
  const s = String(label || '').trim();
  const plus = s.match(/^(\d+(?:[.,]\d+)?)\+\s*$/);
  if (plus) return { min: num(plus[1]), max: Infinity, label: s };
  const span = s.match(/^(\d+(?:[.,]\d+)?)\s*[-–—]\s*(\d+(?:[.,]\d+)?)$/);
  if (span) return { min: num(span[1]), max: num(span[2]), label: s };
  return null;
}

export function valueInBucket(n, label) {
  if (!Number.isFinite(n) || label == null || label === '') return null;
  const r = parseBucketRange(label);
  if (!r || r.min == null) return null;
  if (r.max === Infinity) return n >= r.min;
  return n >= r.min && n <= r.max;
}

function labeledNumber(text, labels) {
  const src = String(text || '');
  for (const lab of labels) {
    const esc = lab.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`${esc}[^0-9]{0,28}(\\d+(?:[.,]\\d+)?)\\s*(мм|см|mm|cm)?`, 'i');
    const m = src.match(re);
    if (!m) continue;
    const n = num(m[1]);
    if (n == null) continue;
    const size = /глубин|высот|ширин|габарит/i.test(lab);
    return toCm(n, m[2], size);
  }
  return null;
}

const DEFAULT_DIM_ORDER = ['width', 'depth', 'height'];

/**
 * Тройка габаритов. Порядок осей — из букв Ш/В/Г в скобках рядом,
 * не «три числа подряд всегда ШхГхВ».
 * @returns {{ width: number, depth: number, height: number, unit: string, raw: string }[]}
 */
export function parseDimTriples(text) {
  const src = String(text || '');
  const out = [];
  const re = /(\d+(?:[.,]\d+)?)\s*[×xхX*]\s*(\d+(?:[.,]\d+)?)\s*[×xхX*]\s*(\d+(?:[.,]\d+)?)\s*(мм|см|mm|cm)?/gi;
  let m;
  while ((m = re.exec(src))) {
    const a = num(m[1]);
    const b = num(m[2]);
    const c = num(m[3]);
    const unit = m[4] || (Math.max(a, b, c) > 100 ? 'мм' : 'см');
    const order = axisOrderNearTriple(src, m.index, m.index + m[0].length) || DEFAULT_DIM_ORDER;
    const nums = [a, b, c];
    const pick = (axis) => {
      const i = order.indexOf(axis);
      return i >= 0 ? nums[i] : null;
    };
    out.push({
      width: toCm(pick('width'), unit, true),
      depth: toCm(pick('depth'), unit, true),
      height: toCm(pick('height'), unit, true),
      unit,
      raw: m[0].replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

function finiteTriple(t) {
  if (!t) return null;
  const v = [t.width, t.depth, t.height];
  return v.every(n => Number.isFinite(n)) ? v : null;
}

/** Одна и та же коробка: те же три числа, другой порядок осей. */
export function sameDimBox(a, b, eps = 0.6) {
  const va = finiteTriple(a);
  const vb = finiteTriple(b);
  if (!va || !vb) return false;
  const sa = [...va].sort((x, y) => x - y);
  const sb = [...vb].sort((x, y) => x - y);
  return sa.every((n, i) => Math.abs(n - sb[i]) <= eps);
}

function axesFromLabeled(text, fallbackTriple) {
  const out = { ...(fallbackTriple || {}) };
  for (const [sheet, size] of Object.entries(SHEET_TO_SIZE)) {
    if (!SIZE_LABELS[size]) continue;
    const n = labeledNumber(text, SIZE_LABELS[size]);
    if (n != null) out[size] = n;
  }
  return out;
}

function firstFilterLabel(filters, sheetName, category) {
  const key = sheetToFilterKey(sheetName, category);
  const v = filters?.[key] ?? filters?.[sheetName];
  if (!hasFilterValue({ [key]: v }, key) && !hasFilterValue(filters, sheetName)) return { key, label: '' };
  return { key, label: displayFilterValue(v) };
}

function attrForFilterKey(dict, key) {
  if (!dict?.attrs) return null;
  return dict.attrs.find(a => (a.facet?.label || a.name) === key) || null;
}

function numbersClose(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.05;
}

function bucketOk(n, filterLabel, attr) {
  if (!Number.isFinite(n) || !filterLabel) return null;
  const got = String(Array.isArray(filterLabel) ? filterLabel[0] : filterLabel);
  const coerced = attr ? coerceFacetNumber(n, attr) : n;
  const gotN = Number(String(got).replace(',', '.'));
  if (numbersClose(gotN, coerced)) return true;
  if (attr && facetKind(attr) === 'range') {
    const expected = matchBucket(coerced, attr.facet);
    if (expected) return String(got) === String(expected);
  }
  return valueInBucket(n, got.split(',')[0].trim());
}

/**
 * @returns {{ name: string, kind: string, detail: string, annotation?: *, filter?: *, description?: * }[]}
 */
export function auditFilterValues({
  filters = {},
  dict = null,
  category = null,
  description = '',
  annotation = '',
} = {}) {
  const cat = catKey(category || dict?.catId);
  const issues = [];
  const ann = plainText(annotation);
  const desc = plainText(description);
  const triplesDesc = parseDimTriples(desc);
  const triplesAnn = parseDimTriples(ann);
  const knownAnn = axesFromLabeled(ann, triplesAnn[0]);
  const permuteOnly = !labeledNumber(desc, SIZE_LABELS.depth)
    && !labeledNumber(desc, SIZE_LABELS.height)
    && !labeledNumber(desc, SIZE_LABELS.width)
    && sameDimBox(triplesDesc[0], knownAnn);

  const seenSize = new Set();
  for (const [sheet, size] of Object.entries(SHEET_TO_SIZE)) {
    if (seenSize.has(size)) continue;
    seenSize.add(size);
    const map = APPROVED_MAP[cat] || {};
    if (!map[sheet] && sheetToFilterKey(sheet, cat) === sheet && !SIZE_LABELS[size]) continue;
    const { key, label } = firstFilterLabel(filters, sheet, cat);
    if (!label) continue;
    const labels = SIZE_LABELS[size] || [sheet];
    const fromAnn = labeledNumber(ann, labels);
    const fromDesc = labeledNumber(desc, labels);
    const fromTripleDesc = triplesDesc[0]?.[size];
    const fromTripleAnn = triplesAnn[0]?.[size];
    const exact = fromAnn ?? fromTripleAnn;
    const claimed = fromDesc ?? fromTripleDesc;
    const skipPermute = permuteOnly && fromDesc == null && ['depth', 'height', 'width'].includes(size);

    if (exact != null) {
      const attr = attrForFilterKey(dict, key);
      const ok = bucketOk(exact, label, attr);
      if (ok === false) {
        issues.push({
          name: sheet,
          kind: 'bucket',
          detail: `${sheet}: в annotation ${exact} не входит в бакет filters «${label}»`,
          annotation: exact,
          filter: label,
        });
      }
    }

    if (skipPermute) continue;

    if (claimed != null && exact != null && Math.abs(claimed - exact) > 0.6) {
      issues.push({
        name: sheet,
        kind: 'cross_field',
        detail: `${sheet}: description ${claimed} ≠ annotation ${exact} (фильтр «${label}»)`,
        description: claimed,
        annotation: exact,
        filter: label,
      });
    } else if (claimed != null && label) {
      const attr = attrForFilterKey(dict, key);
      const ok = bucketOk(claimed, label, attr);
      if (ok === false) {
        issues.push({
          name: sheet,
          kind: 'cross_field',
          detail: `${sheet}: в description ${claimed}, бакет filters «${label}»`,
          description: claimed,
          filter: label,
        });
      }
    }
  }

  if (/тип\s+двигателя\s+не\s+указан|двигател\w*\s+не\s+указан/i.test(desc)
    && (hasFilterValue(filters, 'Тип двигателя') || hasFilterValue(filters, 'Тип'))) {
    const motor = displayFilterValue(filters['Тип двигателя'] || filters['Тип']);
    issues.push({
      name: 'Тип двигателя',
      kind: 'cross_field',
      detail: `description говорит «тип двигателя не указан», filters = «${motor}»`,
      description: 'не указан',
      filter: motor,
    });
  }

  if (/не\s+имеет\s+сушк|без\s+сушк/i.test(desc) && hasFilterValue(filters, 'Сушка')) {
    const v = displayFilterValue(filters['Сушка']);
    if (!/нет|false|без/i.test(v)) {
      issues.push({
        name: 'Сушка',
        kind: 'cross_field',
        detail: `description: нет сушки, filters = «${v}»`,
        description: 'нет',
        filter: v,
      });
    }
  }

  if (/оснащ[её]н\w*\s+сушк|с\s+сушкой/i.test(desc) && hasFilterValue(filters, 'Сушка')) {
    const v = displayFilterValue(filters['Сушка']);
    if (/нет|false/i.test(v)) {
      issues.push({
        name: 'Сушка',
        kind: 'cross_field',
        detail: `description: есть сушка, filters = «${v}»`,
        description: 'есть',
        filter: v,
      });
    }
  }

  return issues;
}
