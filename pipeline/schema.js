/**
 * Схема ИИ и ключи specs из справочника dictionaries/attributes_{id}.json.
 * Без зашитых FRIDGE_/WASHER_ списков.
 */

import {
  hasDictionary, loadDictionary, loadCategories, loadConfig,
  listDictionaries, categoryName,
  PROJECT_ROOT, resolveDictRoot,
} from './dict.js';
import { extractPairs } from './parse.js';
import { matchKey } from './match.js';
import { normalizeValue } from './types.js';
import { attrLabel } from './types.js';
import { parseDimensions } from './dimensions.js';

export { PROJECT_ROOT, resolveDictRoot };

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

export function resolveCatId(key, root) {
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

export function schemaFromDictionary(dict, { slug = null, name = null, root } = {}) {
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
      return loadCategories(root).find(c => Number(c.id) === Number(dict.catId))?.name;
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

export function tryLoadDictSchema(key, root) {
  const resolved = resolveDictRoot(root);
  let catId = resolveCatId(key, resolved);
  if (catId && !hasDictionary(catId, resolved) && DICT_FALLBACK[catId]) {
    catId = String(DICT_FALLBACK[catId]);
  }
  if (!catId || !hasDictionary(catId, resolved)) return null;
  const dict = loadDictionary(catId, resolved);
  const slug = Object.entries(CRAWL_SLUGS).find(([, id]) => String(id) === catId)?.[0] || null;
  let name = null;
  try {
    name = loadCategories(resolved).find(c => String(c.id) === catId)?.name;
  } catch { /* */ }
  return schemaFromDictionary(dict, { slug, name, root: resolved });
}

const SKIP_CAT_HINT = new Set(['', 'all', 'без раздела', 'bez_razdela', 'все разделы']);

/**
 * Эти три файла обязаны быть: пропажа — ошибка, не _generic.
 * Любой другой attributes_{id}.json подхватывается с диска сам.
 */
const MUST_HAVE_DICT_IDS = new Set([
  '467', '523', '929',
  ...Object.keys(DICT_FALLBACK).map(String),
  ...Object.values(DICT_FALLBACK).map(String),
]);

/** Синонимы числа/падежа, которых нет в categories.json («стиральная» ≠ «Стиральные машины»). */
const NAME_ALIASES = [
  { re: /стиральн/, id: '467' },
  { re: /холодильник/, id: '523' },
  { re: /вытяжк|воздухоочистител/, id: '929' },
];

export function isMustHaveDict(id) {
  return MUST_HAVE_DICT_IDS.has(String(id));
}

function dictIdsOnDisk(root) {
  try {
    return listDictionaries(root).map(d => String(d.id));
  } catch {
    return [];
  }
}

function foldRu(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е');
}

/** Укороченное слово: «холодильники» и «холодильник» сходятся в «холодиль». */
function wordStem(w) {
  const s = foldRu(w).replace(/[^a-zа-я0-9]/g, '');
  if (s.length <= 4) return s;
  return s.slice(0, -1).slice(0, 7);
}

function nameScore(text, catName) {
  const t = foldRu(text);
  const cn = foldRu(catName);
  if (!t || !cn || cn.length < 5) return 0;
  if (t.includes(cn)) return 1000 + cn.length;
  const words = cn.split(/[\s,/]+/).map(w => w.trim())
    .filter(w => w.length >= 5 && !/^(для|или|при|без)$/i.test(w));
  if (!words.length) return 0;
  let hit = 0;
  for (const w of words) {
    const st = wordStem(w);
    if (st.length >= 4 && t.includes(st)) hit++;
  }
  return hit === words.length ? 100 + cn.length + hit * 5 : 0;
}

/**
 * cat_id справочника по тексту (имя товара, название раздела).
 * Сначала файлы attributes_*.json + имена из categories.json (длиннее побеждает),
 * затем алиасы 467/523/929 — даже если файла нет (чтобы отдать DICT_UNAVAILABLE).
 */
export function dictIdFromText(text, root) {
  const resolved = resolveDictRoot(root);
  const n = foldRu(text).trim();
  if (!n || SKIP_CAT_HINT.has(n)) return null;

  const scored = [];
  for (const id of dictIdsOnDisk(resolved)) {
    const score = nameScore(n, categoryName(id, resolved));
    if (score > 0) scored.push({ id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored[0] && (scored.length === 1 || scored[0].score > scored[1].score)) {
    return scored[0].id;
  }

  for (const a of NAME_ALIASES) {
    if (a.re.test(n)) return a.id;
  }
  return null;
}

function withFallbackId(id) {
  const s = String(id);
  return DICT_FALLBACK[s] != null ? String(DICT_FALLBACK[s]) : s;
}

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
 * Новый attributes_{id}.json сам попадает в список через hasDictionary.
 */
export function expectedDictCatId(products, category, root) {
  const resolved = resolveDictRoot(root);
  for (const hint of categoryHints(products, category)) {
    if (hint == null) continue;
    const s = String(hint).trim();
    if (!s || SKIP_CAT_HINT.has(s.toLowerCase())) continue;
    const byId = resolveCatId(s, resolved);
    if (byId) {
      const target = withFallbackId(byId);
      if (isMustHaveDict(byId) || isMustHaveDict(target) || hasDictionary(target, resolved)) {
        return target;
      }
    }
    const fromText = dictIdFromText(s, resolved);
    if (fromText) return withFallbackId(fromText);
  }
  return null;
}

export function dictForProducts(products, category, root) {
  const resolved = resolveDictRoot(root);
  for (const hint of categoryHints(products, category)) {
    if (hint == null) continue;
    const s = String(hint).trim();
    if (!s || SKIP_CAT_HINT.has(s.toLowerCase())) continue;
    const loaded = tryLoadDictSchema(s, resolved);
    if (loaded?.dict) return loaded.dict;
    const fromText = dictIdFromText(s, resolved);
    if (!fromText) continue;
    const d = tryLoadDictSchema(fromText, resolved);
    if (d?.dict) return d.dict;
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
  const disputed = new Set();
  const sameNum = (a, b) => typeof a === 'number' && typeof b === 'number'
    ? Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.02)
    : a === b;
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
    // multi (климатический класс N, SN, ST, T) — не режем до первого токена.
    if (Array.isArray(val)) {
      val = attr.cardinality === 'multi'
        ? val.map(x => String(x ?? '').trim()).filter(Boolean).join(', ')
        : val[0];
    }
    if (disputed.has(key)) continue;
    if (out[key] == null) {
      out[key] = val;
      continue;
    }
    // Два разных значения на один ключ (например «Программы»→24ч и «…стирки»→16) —
    // не first-wins: снимаем факт, дальше LABEL/другой источник может дать однозначное.
    if (!sameNum(out[key], val)) {
      delete out[key];
      disputed.add(key);
    }
  }
  return out;
}

export function loadConfigSafe(root = '.') {
  try { return loadConfig(root); }
  catch { return { fuzzy: { min_score: 0.9 } }; }
}
