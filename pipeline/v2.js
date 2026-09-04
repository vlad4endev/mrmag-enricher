/**
 * Справочник → вход buildV2.
 * Ключи specs и подписи — из facet.label / name / unit;
 * тип товара — из categories.json. Без CODE_TO_SPEC / PRODUCT_TYPE на 467/523.
 */

import { metaKeywords } from './export.js';
import { loadCategories } from './dict.js';
import { attrLabel } from './types.js';

function unwrap(v) {
  if (Array.isArray(v)) return v.length ? unwrap(v[0]) : null;
  return v;
}

function specText(v) {
  const s = String(v ?? '').trim();
  if (!s) return s;
  if (/[а-яё]/i.test(s) && !/[a-z]/i.test(s)) return s.toLowerCase();
  return s;
}

/** «Общий объём, л» → общий_объем_л; см → мм с множителем. */
function specKeyFromAttr(attr) {
  const label = attrLabel(attr);
  let base = String(label || attr.name || attr.code)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, '_')
    .replace(/^_|_$/g, '');
  if (attr.unit === 'см') {
    base = base.replace(/_?см$/, '') + '_мм';
    return { key: base.replace(/__/g, '_'), mul: 10 };
  }
  if (attr.unit) {
    const u = String(attr.unit).toLowerCase().replace(/\//g, '_').replace(/·/g, '').replace(/\s+/g, '_');
    if (!base.includes(u)) base = `${base}_${u}`;
  }
  return { key: base.replace(/__/g, '_'), mul: 1 };
}

function productTypeFromCategories(catId, root = '.') {
  try {
    const cats = loadCategories(root);
    const hit = cats.find(c => Number(c.id) === Number(catId));
    if (!hit) return null;
    return singularProductType(String(hit.name));
  } catch {
    return null;
  }
}

/** «Холодильники» → «холодильник»; «Стиральные машины» → «стиральная машина». */
function singularProductType(name) {
  const s = String(name || '').toLowerCase().replace(/ё/g, 'е').trim();
  if (!s) return null;
  const adjNoun = s.match(/^(\S+?)ые\s+(\S+?)ы$/u);
  if (adjNoun) return `${adjNoun[1]}ая ${adjNoun[2]}а`;
  const adjNounIe = s.match(/^(\S+?)ие\s+(\S+?)и$/u);
  if (adjNounIe) return `${adjNounIe[1]}яя ${adjNounIe[2]}`;
  if (/и$/.test(s) && !/\s/.test(s)) return s.slice(0, -1);
  return s;
}

function snapCooling(v) {
  const t = String(v).toLowerCase().replace(/ё/g, 'е');
  if (/без\s*no\s*frost|капельн/.test(t)) return 'капельная';
  if (/no\s*frost|ноу\s*фрост|full\s*no/.test(t)) return 'No Frost';
  return specText(v);
}

function snapFreezer(v) {
  const t = String(v).toLowerCase().replace(/ё/g, 'е');
  if (/нижн|снизу/.test(t)) return 'нижнее';
  if (/верхн|сверху/.test(t)) return 'верхнее';
  if (/бок/.test(t)) return 'боковое';
  if (/нет|без/.test(t)) return 'нет морозильника';
  return specText(v);
}

function snapInstall(v) {
  const t = String(v).toLowerCase().replace(/ё/g, 'е');
  if (/встраив/.test(t)) return 'встраиваемая';
  if (/столешниц/.test(t)) return 'под столешницу';
  if (/отдельн/.test(t)) return 'отдельностоящая';
  return specText(v);
}

function snapControl(v) {
  const t = String(v).toLowerCase().replace(/ё/g, 'е');
  if (/сенсор/.test(t)) return 'сенсорное';
  if (/кнопоч/.test(t)) return 'кнопочное';
  if (/электрон/.test(t) && !/электромехан/.test(t)) return 'электронное';
  if (/механич/.test(t)) return 'механическое';
  return specText(v);
}

function snapLoad(v) {
  const t = String(v).toLowerCase().replace(/ё/g, 'е');
  if (/вертикал/.test(t)) return 'вертикальная';
  if (/фронтал/.test(t)) return 'фронтальная';
  return specText(v);
}

function specFromAttr(raw, attr) {
  const v = unwrap(raw);
  if (v == null || v === '') return null;
  if (attr?.type === 'boolean' || typeof v === 'boolean') return v ? 'да' : 'нет';
  if (typeof v === 'number') return v;
  if (attr?.type === 'class_scale') return String(v);
  if (attr?.code === 'cooling') return snapCooling(v);
  if (attr?.code === 'freezer_pos') return snapFreezer(v);
  if (attr?.code === 'install') return snapInstall(v);
  if (attr?.code === 'control_type') return snapControl(v);
  if (attr?.code === 'load_type') return snapLoad(v);
  if (attr?.code === 'color') return specText(String(v).split(/\s*\/\s*/)[0]);
  return specText(v);
}

function inferFreezer(rec) {
  const blob = `${rec.attrs?.freezer_pos || ''} ${rec.attrs?.fridge_type || ''} ${rec.name || ''}`;
  const got = snapFreezer(blob);
  return ['нижнее', 'верхнее', 'боковое', 'нет морозильника'].includes(got) ? got : null;
}

function inferChambers(rec) {
  const t = `${rec.attrs?.fridge_type || ''} ${rec.name || ''}`.toLowerCase();
  if (/четырехкамер|четырёхкамер/.test(t)) return 4;
  if (/трехкамер|трёхкамер/.test(t)) return 3;
  if (/двухкамер/.test(t)) return 2;
  if (/однокамер/.test(t)) return 1;
  return null;
}

export function buildSpecs(rec, dict, { root = '.' } = {}) {
  const specs = {};
  const type = productTypeFromCategories(dict.catId, root);
  if (type) specs.тип_товара = type;
  const model = rec.identity?.model;
  if (model) specs.модель = String(model).trim();

  for (const attr of dict.attrs) {
    if (attr.tier === 'X') continue;
    const raw = rec.attrs?.[attr.code];
    if (raw == null || raw === '') continue;
    const { key, mul } = specKeyFromAttr(attr);
    let val = specFromAttr(raw, attr);
    if (typeof val === 'number' && mul !== 1) val = Math.round(val * mul * 1000) / 1000;
    if (val == null || val === '') continue;
    specs[key] = val;
  }

  if (dict.byCode.has('freezer_pos')) {
    const k = specKeyFromAttr(dict.byCode.get('freezer_pos')).key;
    if (specs[k] == null) {
      const pos = inferFreezer(rec);
      if (pos) specs[k] = pos;
    }
  }
  if (dict.byCode.has('chambers')) {
    const k = specKeyFromAttr(dict.byCode.get('chambers')).key;
    if (specs[k] == null) {
      const n = inferChambers(rec);
      if (n) specs[k] = n;
    }
  }
  return specs;
}

export function dictToV2Row(rec, dict, opts = {}) {
  if (rec?.enriched?.specs) {
    return {
      sku: rec.sku ?? rec.id,
      name: rec.name,
      price: rec.price,
      enriched: rec.enriched,
    };
  }
  return {
    sku: rec.id,
    name: rec.name,
    price: rec.price,
    enriched: {
      specs: buildSpecs(rec, dict, opts),
      h1: rec.name || '',
      short_description: '',
      seo_description: '',
      bullets: [],
      seo_keywords: String(metaKeywords(rec, dict) || '').split(',').map(s => s.trim()).filter(Boolean),
    },
  };
}

export function dictToV2Rows(recs, dict, opts = {}) {
  return (recs || []).map(r => dictToV2Row(r, dict, opts));
}

export { specKeyFromAttr, productTypeFromCategories, singularProductType };
