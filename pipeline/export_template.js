/**
 * Редактируемые шаблоны файлов выгрузки.
 *
 * Ключи JSON — поля файла. Живые данные подставляются по имени ключа
 * или через {{поле}}. Пример-словарь фасетов («Цвет»: [«белый»]) не режет
 * реальные ключи: в файл уходит фактический объект filters.
 * Пустой шаблон в настройках = встроенный эталон.
 */

export const EXPORT_PLACEHOLDERS = [
  { key: '{{id}}', note: 'SKU товара' },
  { key: '{{name}}', note: 'название из каталога' },
  { key: '{{sku}}', note: 'артикул, если есть' },
  { key: '{{meta_keywords}}', note: 'ключевые фразы' },
  { key: '{{description_html}}', note: 'описание карточки' },
  { key: '{{annotation_html}}', note: 'список характеристик' },
  { key: '{{filters}}', note: 'фасеты карточки' },
  { key: '{{web_info}}', note: 'отзыв или пустая строка' },
  { key: '{{category}}', note: 'имя раздела' },
  { key: '{{category_id}}', note: 'id раздела' },
  { key: '{{slug}}', note: 'slug раздела' },
  { key: '{{value}}', note: 'значения фасета (в filters_*.json)' },
];

const SCHEMA_KEYS = new Set([
  'id', 'sku', 'name', 'title', 'value', 'values', 'filters', 'categories',
  'meta_keywords', 'description_html', 'annotation_html', 'web_info',
  'type', 'slug', 'url', 'category', 'category_id',
]);

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g;
const FULL_PLACEHOLDER_RE = /^\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}$/;
const MAX_TPL_BYTES = 80_000;

function cloneJson(v) {
  return JSON.parse(JSON.stringify(v));
}

export function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Словарь фасетов: ключи — подписи фильтра, значения — массивы.
 * Запись {name, value} сюда не попадает: name есть в SCHEMA_KEYS.
 */
function isFacetMap(obj) {
  if (!isPlainObject(obj)) return false;
  const keys = Object.keys(obj);
  if (!keys.length) return true;
  if (keys.some(k => SCHEMA_KEYS.has(k))) return false;
  return Object.values(obj).every(v => Array.isArray(v));
}

function lookup(ctx, path) {
  return String(path || '').split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
}

function interpolate(str, ctx) {
  const full = String(str).match(FULL_PLACEHOLDER_RE);
  if (full) {
    const v = lookup(ctx, full[1]);
    return v === undefined ? '' : v;
  }
  if (!str.includes('{{')) return str;
  return str.replace(PLACEHOLDER_RE, (_, path) => {
    const v = lookup(ctx, path);
    if (v == null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
}

function applyNode(template, data, ctx) {
  if (typeof template === 'string') return interpolate(template, ctx || data || {});
  if (template == null || typeof template !== 'object') return template;

  if (Array.isArray(template)) {
    const src = Array.isArray(data) ? data : [];
    if (!template.length) return src.map(item => item);
    const itemTpl = template[0];
    if (itemTpl && typeof itemTpl === 'object') {
      return src.map(item => applyNode(itemTpl, item, item));
    }
    return src.length ? src.slice() : template.slice();
  }

  if (isFacetMap(template) && isPlainObject(data)) return cloneJson(data);
  if (isFacetMap(template) && (data == null || !isPlainObject(data))) return {};

  const out = {};
  for (const [key, example] of Object.entries(template)) {
    const has = data != null && Object.prototype.hasOwnProperty.call(data, key);
    const val = has ? data[key] : undefined;
    if (typeof example === 'string') {
      const interp = interpolate(example, ctx || data || {});
      if (interp !== example) out[key] = interp;
      else if (has) out[key] = val;
      else out[key] = example;
    } else if (example && typeof example === 'object') {
      const nested = has
        ? val
        : (Array.isArray(example) ? [] : {});
      out[key] = applyNode(example, nested, Array.isArray(example) ? nested : (ctx || data || {}));
    } else {
      out[key] = has ? val : example;
    }
  }
  return out;
}

/**
 * Наложить шаблон на данные выгрузки.
 * Массив товаров: template — массив из одного примера или объект-карточка.
 * Объект файла (filters/categories): template задаёт оболочку и поля элементов.
 */
export function applyExportTemplate(data, template) {
  if (template == null) return data;
  if (Array.isArray(data)) {
    const shape = Array.isArray(template) ? template[0] : template;
    if (shape == null) return data.slice();
    return data.map(item => applyNode(shape, item, item));
  }
  return applyNode(template, data, data);
}

export function attachExportContext(products, sources = []) {
  const map = new Map();
  for (const s of sources || []) {
    const id = s?.id ?? s?.sku;
    if (id != null) map.set(String(id), s);
  }
  return (products || []).map((p) => {
    const s = map.get(String(p?.id)) || {};
    return {
      name: s.name,
      sku: s.sku ?? s.id ?? p.id,
      category: s.category ?? s.category_name ?? s.name,
      category_id: s.category_id ?? s.cat_id,
      slug: s.slug,
      url: s.url,
      ...p,
    };
  });
}

export function shapeProductsFile(products, template, sources) {
  return applyExportTemplate(attachExportContext(products, sources), template);
}

export function shapeFiltersFile(filters, template) {
  const data = Array.isArray(filters) ? { filters } : (filters && typeof filters === 'object' ? filters : { filters: [] });
  return applyExportTemplate(data, template);
}

export function shapeCategoriesFile(categories, template) {
  const data = Array.isArray(categories)
    ? { categories }
    : (categories && typeof categories === 'object' ? categories : { categories: [] });
  return applyExportTemplate(data, template);
}

function defaultProduct() {
  return {
    id: 21670,
    meta_keywords: 'вытяжка Elikor, полновстраиваемая вытяжка, вытяжка 50 см, …',
    description_html: '<p>Полновстраиваемая кухонная вытяжка <strong>Elikor …</strong> — …</p><p>…</p><p>…</p><ul><li>…</li><li>…</li><li>…</li></ul><p>…</p>',
    annotation_html: '<ul><li>Тип: вытяжка</li><li>Конструкция: полновстраиваемая</li><li>Цвет: нержавеющая сталь</li><li>Ширина: 52 см</li></ul>',
    filters: {
      'Тип товара': ['Вытяжка'],
      'Конструкция': ['Полновстраиваемая'],
      'Ширина, см': ['50-55'],
      'Цвет': ['Нержавеющая сталь'],
    },
    web_info: 'Купила месяц назад. Достоинства: тихая, простота монтажа. …',
  };
}

/** JSON v2 — те же поля витрины плюс name из каталога. «2 файла» name не тащат. */
function defaultProductV2() {
  const p = defaultProduct();
  return {
    id: p.id,
    name: 'Вытяжка Elikor Integra 50 нержавеющая сталь',
    meta_keywords: p.meta_keywords,
    description_html: p.description_html,
    annotation_html: p.annotation_html,
    filters: p.filters,
    web_info: p.web_info,
  };
}

function defaultFilters() {
  return {
    filters: [
      { name: 'Тип товара', value: ['Вытяжка'] },
      { name: 'Конструкция', value: ['Полновстраиваемая', 'Каминная'] },
      { name: 'Ширина, см', value: ['50-55', '55-60', '60-65'] },
      { name: 'Цвет', value: ['Белый', 'Нержавеющая сталь', 'Чёрный'] },
    ],
  };
}

function defaultCategories() {
  return { categories: [{ id: 929, name: 'Встраиваемые вытяжки' }] };
}

export function defaultExportTemplates() {
  const filters = defaultFilters();
  return {
    two: { products: [cloneJson(defaultProduct())], filters: cloneJson(filters) },
    v2: {
      products: [cloneJson(defaultProductV2())],
      filters: cloneJson(filters),
      categories: cloneJson(defaultCategories()),
    },
  };
}

function parseTplValue(raw, fallback) {
  if (raw == null || raw === '') return null;
  let val = raw;
  if (typeof raw === 'string') {
    if (!String(raw).trim()) return null;
    try { val = JSON.parse(raw); }
    catch {
      const e = new Error('Шаблон выгрузки: невалидный JSON');
      e.status = 400;
      throw e;
    }
  }
  if (typeof val !== 'object' || val === null) {
    const e = new Error('Шаблон выгрузки должен быть JSON-объектом или массивом');
    e.status = 400;
    throw e;
  }
  const dumped = JSON.stringify(val);
  if (dumped.length > MAX_TPL_BYTES) {
    const e = new Error('Шаблон выгрузки слишком большой');
    e.status = 400;
    throw e;
  }
  if (jsonEqual(val, fallback)) return null;
  return val;
}

function emptyPack() {
  return { two: { products: null, filters: null }, v2: { products: null, filters: null, categories: null } };
}

export function normalizeExportTemplates(raw = {}) {
  const defaults = defaultExportTemplates();
  const src = raw && typeof raw === 'object' ? raw : {};
  const twoIn = src.two && typeof src.two === 'object' ? src.two : {};
  const v2In = src.v2 && typeof src.v2 === 'object' ? src.v2 : {};
  return {
    two: {
      products: parseTplValue(twoIn.products, defaults.two.products),
      filters: parseTplValue(twoIn.filters, defaults.two.filters),
    },
    v2: {
      products: parseTplValue(v2In.products, defaults.v2.products),
      filters: parseTplValue(v2In.filters, defaults.v2.filters),
      categories: parseTplValue(v2In.categories, defaults.v2.categories),
    },
  };
}

function pickTpl(saved, fallback) {
  return saved != null ? saved : fallback;
}

export function exportTemplatesView(saved) {
  const defaults = defaultExportTemplates();
  const t = saved && typeof saved === 'object' ? saved : emptyPack();
  const two = t.two || {};
  const v2 = t.v2 || {};
  return {
    two: {
      products: pickTpl(two.products, defaults.two.products),
      filters: pickTpl(two.filters, defaults.two.filters),
      custom: { products: two.products != null, filters: two.filters != null },
    },
    v2: {
      products: pickTpl(v2.products, defaults.v2.products),
      filters: pickTpl(v2.filters, defaults.v2.filters),
      categories: pickTpl(v2.categories, defaults.v2.categories),
      custom: {
        products: v2.products != null,
        filters: v2.filters != null,
        categories: v2.categories != null,
      },
    },
    defaults,
    placeholders: EXPORT_PLACEHOLDERS,
  };
}

export function persistExportTemplates(t) {
  if (!t || typeof t !== 'object') return undefined;
  const out = {};
  for (const kind of ['two', 'v2']) {
    const pack = t[kind];
    if (!pack || typeof pack !== 'object') continue;
    const slim = {};
    for (const [k, v] of Object.entries(pack)) {
      if (v != null) slim[k] = v;
    }
    if (Object.keys(slim).length) out[kind] = slim;
  }
  return Object.keys(out).length ? out : undefined;
}

export function resolveExportPack(saved, kind) {
  const view = exportTemplatesView(saved);
  return kind === 'v2' ? view.v2 : view.two;
}
