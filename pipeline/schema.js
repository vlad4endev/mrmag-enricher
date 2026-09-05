/**
 * Схема ИИ и ключи specs из справочника dictionaries/attributes_{id}.json.
 * Без зашитых FRIDGE_/WASHER_ списков.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { hasDictionary, loadDictionary, loadCategories } from './dict.js';
import { extractPairs } from './parse.js';
import { matchKey } from './match.js';
import { normalizeValue } from './types.js';
import { attrLabel } from './types.js';
import { loadConfig } from './dict.js';
import { parseDimensions } from './dimensions.js';

/** Корень проекта, а не process.cwd(): иначе при старте из другой папки уходит _generic. */
const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Стабильные ключи specs (совместимы с эталоном v2 / промптом). */
const CODE_TO_SPEC = {
  brand: 'бренд',
  energy_class: 'класс_энергоэффективности',
  vol_total: 'объем_общий_л',
  vol_fridge: 'объем_холодильной_камеры_л',
  vol_freezer: 'объем_морозильной_камеры_л',
  cooling: 'система_охлаждения',
  chambers: 'количество_камер',
  freezer_pos: 'расположение_морозильника',
  control_type: 'тип_управления',
  refrigerant: 'хладагент',
  noise: 'уровень_шума_дб',
  freeze_power: 'мощность_замораживания_кг_сут',
  weight: 'вес_кг',
  color: 'цвет',
  load_type: 'тип_загрузки',
  install: 'установка',
  load_max: 'максимальная_загрузка_кг',
  spin_max: 'скорость_отжима_об_мин',
  wash_class: 'класс_стирки',
  spin_class: 'класс_отжима',
  programs_qty: 'количество_программ',
  water_use: 'расход_воды_л_цикл',
  noise_wash: 'уровень_шума_стирки_дб',
  noise_spin: 'уровень_шума_отжима_дб',
  display: 'дисплей',
  drying: 'сушка',
  child_lock: 'защита_от_детей',
  height: { key: 'высота_мм', mul: 10 },
  width: { key: 'ширина_мм', mul: 10 },
  install_width: { key: 'ширина_встраивания_мм', mul: 10 },
  depth: { key: 'глубина_мм', mul: 10 },
  install_depth: { key: 'глубина_встраивания_мм', mul: 10 },
  fridge_type: 'тип_холодильника',
  compressor_type: 'тип_компрессора',
  motor_type: 'тип_двигателя',
  country: 'страна_производства',
  product_type: 'тип_товара',
  construction: 'конструкция',
  airflow: 'производительность_м3_ч',
  body_material: 'материал_корпуса',
  speeds: 'количество_скоростей',
  work_modes: 'режимы_работы',
  lighting: 'тип_освещения',
  filter: 'фильтр',
  noise: 'уровень_шума_дб',
  duct_diameter: 'диаметр_патрубка_мм',
  power: 'потребляемая_мощность_вт',
};

/** Разделы без своего файла → существующий справочник. */
const DICT_FALLBACK = {
  528: 929, // «Вытяжки и Воздухоочистители» → справочник встраиваемых
};

/** Slug обхода магазина → cat_id. URL не содержат имён характеристик. */
export const CRAWL_SLUGS = {
  kholodilniki: 523,
  stiralnye_mashiny: 467,
};

export function resolveCatId(key, root = '.') {
  if (key == null || key === '') return null;
  if (typeof key === 'object' && key.id != null) return String(key.id);
  const k = String(key).trim();
  if (/^\d+$/.test(k)) return k;
  if (CRAWL_SLUGS[k]) return String(CRAWL_SLUGS[k]);
  try {
    const cats = loadCategories(root);
    const lower = k.toLowerCase();
    const hit = cats.find(c =>
      String(c.id) === k ||
      String(c.name).toLowerCase() === lower ||
      lower.endsWith(String(c.name).toLowerCase()),
    );
    if (hit && hasDictionary(hit.id, root)) return String(hit.id);
  } catch { /* no categories */ }
  return null;
}

function fieldType(attr) {
  if (attr.type === 'number' || attr.type === 'integer') return 'num';
  if (attr.type === 'boolean') return ['да', 'нет'];
  if (attr.type === 'enum' && attr.value_aliases && Object.keys(attr.value_aliases).length >= 2) {
    return Object.keys(attr.value_aliases);
  }
  return 'str';
}

function specDest(attr) {
  const dest = CODE_TO_SPEC[attr.code];
  if (dest) return dest;
  const label = attrLabel(attr);
  let key = String(label || attr.name || attr.code)
    .toLowerCase().replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, '_').replace(/^_|_$/g, '');
  if (attr.unit === 'см') return { key: key.replace(/_?см$/, '') + '_мм', mul: 10 };
  return key;
}

export { specDest, CODE_TO_SPEC };

export function schemaFromDictionary(dict, { slug = null, name = null } = {}) {
  const fields = [
    ['тип_товара', 'str'],
    ['бренд', 'str'],
    ['модель', 'str'],
  ];
  const ranges = {};
  const seen = new Set(['тип_товара', 'бренд', 'модель']);

  for (const attr of dict.attrs) {
    if (attr.tier === 'X') continue;
    const dest = specDest(attr);
    const key = typeof dest === 'object' ? dest.key : dest;
    if (seen.has(key)) continue;
    seen.add(key);
    fields.push([key, fieldType(attr)]);
    if (attr.valid_range && (attr.type === 'number' || attr.type === 'integer')) {
      let [lo, hi] = attr.valid_range;
      if (typeof dest === 'object' && dest.mul === 10) {
        lo *= 10; hi *= 10;
      }
      ranges[key] = [lo, hi];
    }
  }

  const catName = name || (() => {
    try {
      return loadCategories('.').find(c => Number(c.id) === Number(dict.catId))?.name;
    } catch { return null; }
  })();

  const slugOut = slug || Object.entries(CRAWL_SLUGS).find(([, id]) => String(id) === String(dict.catId))?.[0] || `cat_${dict.catId}`;

  return {
    slug: slugOut,
    id: Number(dict.catId),
    name: catName || `Категория ${dict.catId}`,
    subject: (catName || 'товаров').toLowerCase(),
    specKeys: fields.map(([k]) => k),
    numericKeys: fields.filter(([, t]) => t === 'num').map(([k]) => k),
    enums: Object.fromEntries(fields.filter(([, t]) => Array.isArray(t)).map(([k, t]) => [k, t])),
    labels: [],
    attrs: [],
    ranges,
    tallest: true,
    extra: () => {},
    unitNotes: [],
    hints: ['Характеристики и диапазоны — из справочника dictionaries/attributes_' + dict.catId + '.json'],
    fromDictionary: true,
    dict,
  };
}

export function tryLoadDictSchema(key, root = PROJECT_ROOT) {
  let catId = resolveCatId(key, root);
  if (catId && !hasDictionary(catId, root) && DICT_FALLBACK[catId]) {
    catId = String(DICT_FALLBACK[catId]);
  }
  if (!catId || !hasDictionary(catId, root)) return null;
  const dict = loadDictionary(catId, root);
  const slug = Object.entries(CRAWL_SLUGS).find(([, id]) => String(id) === catId)?.[0] || null;
  let name = null;
  try {
    name = loadCategories(root).find(c => String(c.id) === catId)?.name;
  } catch { /* */ }
  return schemaFromDictionary(dict, { slug, name });
}

const SKIP_CAT_HINT = new Set(['', 'all', 'без раздела', 'bez_razdela', 'все разделы']);

/** Известные справочники: отсутствие файла при таком id — ошибка, не gold. */
const KNOWN_DICT_IDS = new Set([
  '467', '523', '929',
  ...Object.keys(DICT_FALLBACK).map(String),
  ...Object.values(DICT_FALLBACK).map(String),
]);

/**
 * Справочник для выгрузки: id, slug, путь «…/Стиральные машины», имя товара.
 * Иначе UI шлёт «без раздела» / «all» и /api/export падает, хотя в пачке
 * стиральные машины со справочником 467.
 */
/** Подсказки категории из выгрузки / товара (без «без раздела»). */
function categoryHints(products, category) {
  const hints = [category];
  for (const p of products || []) {
    hints.push(p.category_id, p.category, p.name);
  }
  return hints;
}

/**
 * Ожидаемый cat_id справочника, даже если файл сейчас недоступен.
 * Нужен, чтобы apiExport не уходил в gold при «467» без attributes_467.json.
 */
export function expectedDictCatId(products, category, root = '.') {
  for (const hint of categoryHints(products, category)) {
    if (hint == null) continue;
    const s = String(hint).trim();
    if (!s || SKIP_CAT_HINT.has(s.toLowerCase())) continue;
    const byId = resolveCatId(s, root);
    if (byId) {
      const fb = DICT_FALLBACK[byId] != null ? String(DICT_FALLBACK[byId]) : null;
      const target = fb || String(byId);
      if (KNOWN_DICT_IDS.has(String(byId)) || KNOWN_DICT_IDS.has(target) || hasDictionary(target, root)) {
        return target;
      }
    }
    const n = s.toLowerCase().replace(/ё/g, 'е');
    if (/стиральн/.test(n)) return '467';
    if (/холодильник/.test(n)) return '523';
    if (/вытяжк|воздухоочистител/.test(n)) return '929';
  }
  return null;
}

export function dictForProducts(products, category, root = '.') {
  for (const hint of categoryHints(products, category)) {
    if (hint == null) continue;
    const s = String(hint).trim();
    if (!s || SKIP_CAT_HINT.has(s.toLowerCase())) continue;
    const loaded = tryLoadDictSchema(s, root);
    if (loaded?.dict) return loaded.dict;
    const n = s.toLowerCase().replace(/ё/g, 'е');
    if (/стиральн/.test(n)) {
      const d = tryLoadDictSchema(467, root);
      if (d?.dict) return d.dict;
    }
    if (/холодильник/.test(n)) {
      const d = tryLoadDictSchema(523, root);
      if (d?.dict) return d.dict;
    }
    if (/вытяжк|воздухоочистител/.test(n)) {
      const d = tryLoadDictSchema(929, root);
      if (d?.dict) return d.dict;
    }
  }
  return null;
}

/**
 * Извлечь факты из текста через пайплайн справочника.
 * Ключи — как в схеме ИИ (объем_общий_л, высота_мм).
 */
export function extractFactsFromDictionary(text, dict, config) {
  const html = String(text || '');
  if (!html.trim()) return {};
  const wrapped = /</.test(html) ? html : html.split(/\n+/).map(l => `${l}<br>`).join('');
  const pairs = extractPairs(wrapped, dict);
  const fuzzyMin = config?.fuzzy?.min_score ?? 0.9;
  const out = {};
  for (const pair of pairs) {
    const matched = matchKey(pair.key, dict, { value: pair.value, fuzzyMin });
    if (!matched.attr || matched.attr.tier === 'X') continue;
    const attr = matched.attr;
    if (attr.type === 'dimensions' || attr.code === 'dims') {
      const parsed = parseDimensions(pair.key, String(pair.value));
      if (parsed?.dims) {
        const axisKey = { width: 'ширина_мм', height: 'высота_мм', depth: 'глубина_мм' };
        for (const [axis, cm] of Object.entries(parsed.dims)) {
          const k = axisKey[axis];
          if (k && out[k] == null && cm != null) out[k] = Math.round(cm * 10);
        }
      }
      continue;
    }
    const dest = specDest(attr);
    const key = typeof dest === 'object' ? dest.key : dest;
    const mul = typeof dest === 'object' ? dest.mul : 1;
    const norm = normalizeValue(attr, pair.value, { keyText: pair.key });
    if (!norm.ok) continue;
    let val = norm.value;
    if (typeof val === 'number' && mul !== 1) val = Math.round(val * mul * 1000) / 1000;
    if (Array.isArray(val)) val = val[0];
    if (out[key] == null) out[key] = val;
  }
  return out;
}

export function loadConfigSafe(root = '.') {
  try { return loadConfig(root); }
  catch { return { fuzzy: { min_score: 0.9 } }; }
}
