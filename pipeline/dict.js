/** Загрузчик справочника dictionaries/attributes_{cat_id}.json. */

import fs from 'fs';
import path from 'path';
import { normKey } from './text.js';

export function catIdFromFile(file) {
  const m = String(file).match(/(\d+)(?:\.[^.]+)?$/);
  if (!m) throw new Error(`не удалось определить cat_id из имени файла: ${file}`);
  return m[1];
}

/**
 * Файл настроек. В контейнере это /data/config.json (SETTINGS_PATH), чтобы
 * правки из интерфейса переживали пересборку образа. Локально — config.json
 * в корне проекта.
 */
export function configPath(root = '.') {
  if (process.env.SETTINGS_PATH) return process.env.SETTINGS_PATH;
  return path.join(root, 'config.json');
}

export function loadConfig(root = '.') {
  return JSON.parse(fs.readFileSync(configPath(root), 'utf-8'));
}

/** Путь к справочнику категории. Новая категория = один файл здесь. */
export function dictionaryPath(catId, root = '.') {
  return path.join(root, 'dictionaries', `attributes_${catId}.json`);
}

export function benchmarksPath(catId, root = '.') {
  return path.join(root, 'dictionaries', `benchmarks_${catId}.json`);
}

export function hasDictionary(catId, root = '.') {
  return fs.existsSync(dictionaryPath(catId, root));
}

export function categoryName(catId, root = '.') {
  try {
    const hit = loadCategories(root).find(c => String(c.id) === String(catId));
    return hit?.name || `Категория ${catId}`;
  } catch {
    return `Категория ${catId}`;
  }
}

/** Заготовка атрибута для UI «добавить строку» / пустой справочник. */
export function blankAttribute(partial = {}) {
  const name = partial.name || 'Новый атрибут';
  const code = partial.code || 'new_attr';
  const facetIn = partial.facet && typeof partial.facet === 'object' ? partial.facet : {};
  return {
    code,
    name,
    description: partial.description || '',
    type: partial.type || 'enum',
    unit: partial.unit ?? null,
    cardinality: partial.cardinality || 'single',
    order: partial.order ?? 10,
    show_in_annotation: partial.show_in_annotation !== false,
    highlight: !!partial.highlight,
    inferable: partial.inferable !== false,
    tier: partial.tier || 'B',
    decision_reason: partial.decision_reason || '',
    coverage_now: 0,
    coverage_final: 0,
    valid_range: partial.valid_range ?? null,
    synonyms: Array.isArray(partial.synonyms) ? partial.synonyms : [name],
    blacklist: Array.isArray(partial.blacklist) ? partial.blacklist : [],
    value_aliases: partial.value_aliases && typeof partial.value_aliases === 'object'
      ? partial.value_aliases
      : {},
    facet: {
      enabled: false,
      label: name,
      kind: 'enum',
      ...facetIn,
    },
  };
}

/** Минимальный старт: бренд как фасет — без него выгрузка фильтров почти бесполезна. */
export function seedDictionaryAttrs() {
  return [
    blankAttribute({
      code: 'brand',
      name: 'Бренд',
      order: 0,
      tier: 'A',
      highlight: true,
      synonyms: ['Бренд', 'Производитель', 'Марка', 'Торговая марка'],
      facet: { enabled: true, label: 'Бренд', kind: 'enum' },
    }),
  ];
}

/** Все attributes_{id}.json в dictionaries/ — для вкладки «Справочник». */
export function listDictionaries(root = '.') {
  const dir = path.join(root, 'dictionaries');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map(f => f.match(/^attributes_(\d+)\.json$/i)?.[1])
    .filter(Boolean)
    .sort((a, b) => Number(a) - Number(b))
    .map(id => {
      const file = dictionaryPath(id, root);
      let attrs = [];
      try { attrs = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { attrs = []; }
      const list = Array.isArray(attrs) ? attrs : [];
      return {
        id: String(id),
        name: categoryName(id, root),
        file: path.relative(root, file),
        attrs: list.length,
        facets: list.filter(a => a?.facet?.enabled).length,
        annotation: list.filter(a => a?.show_in_annotation).length,
      };
    });
}

/**
 * Создать attributes_{id}.json.
 * copyFrom — клон другого справочника; иначе seed (бренд) или переданный attrs.
 */
export function createDictionary(catId, { copyFrom = null, attrs = null } = {}, root = '.') {
  if (!/^\d+$/.test(String(catId))) {
    throw Object.assign(new Error('id справочника — только цифры'), { status: 400 });
  }
  if (hasDictionary(catId, root)) {
    throw Object.assign(new Error(`справочник attributes_${catId}.json уже есть`), { status: 409 });
  }
  let list;
  if (Array.isArray(attrs) && attrs.length) {
    list = attrs;
  } else if (copyFrom != null && String(copyFrom) !== '') {
    if (!hasDictionary(copyFrom, root)) {
      throw Object.assign(new Error(`нечего копировать: нет attributes_${copyFrom}.json`), { status: 404 });
    }
    list = readDictionaryAttrs(copyFrom, root).map(a => structuredClone(a));
  } else {
    list = seedDictionaryAttrs();
  }
  const saved = saveDictionaryAttrs(catId, list, root);
  return {
    id: String(catId),
    name: categoryName(catId, root),
    file: path.relative(root, dictionaryPath(catId, root)),
    attrs: saved,
  };
}

export function deleteDictionary(catId, root = '.') {
  if (!/^\d+$/.test(String(catId))) {
    throw Object.assign(new Error('id справочника — только цифры'), { status: 400 });
  }
  const file = dictionaryPath(catId, root);
  if (!fs.existsSync(file)) {
    throw Object.assign(new Error(`нет справочника attributes_${catId}.json`), { status: 404 });
  }
  fs.unlinkSync(file);
  return { ok: true, id: String(catId) };
}

/** Сырой массив атрибутов без индекса — для UI и сохранения. */
export function readDictionaryAttrs(catId, root = '.') {
  const file = dictionaryPath(catId, root);
  if (!fs.existsSync(file)) throw Object.assign(new Error(`нет справочника attributes_${catId}.json`), { status: 404 });
  const attrs = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (!Array.isArray(attrs) || !attrs.length) {
    throw Object.assign(new Error(`пустой справочник attributes_${catId}.json`), { status: 400 });
  }
  return attrs;
}

/** Проверка и запись attributes_{id}.json. */
export function saveDictionaryAttrs(catId, attrs, root = '.') {
  if (!/^\d+$/.test(String(catId))) {
    throw Object.assign(new Error('id справочника — только цифры'), { status: 400 });
  }
  if (!Array.isArray(attrs) || !attrs.length) {
    throw Object.assign(new Error('ожидался непустой массив атрибутов'), { status: 400 });
  }
  const codes = new Set();
  for (const a of attrs) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      throw Object.assign(new Error('каждый атрибут — объект'), { status: 400 });
    }
    if (!a.code || typeof a.code !== 'string') {
      throw Object.assign(new Error('у атрибута нет code'), { status: 400 });
    }
    if (!a.name || typeof a.name !== 'string') {
      throw Object.assign(new Error(`у «${a.code}» нет name`), { status: 400 });
    }
    if (codes.has(a.code)) {
      throw Object.assign(new Error(`дублируется code «${a.code}»`), { status: 400 });
    }
    codes.add(a.code);
  }
  // Индексация ловит битые синонимы до записи на диск.
  indexDictionary(attrs, String(catId));
  const file = dictionaryPath(catId, root);
  const dir = path.dirname(file);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(attrs, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
  return readDictionaryAttrs(catId, root);
}

/** Блок сравнений для web_info. Нет файла — null (модель пишет web_info: null). */
export function loadBenchmarks(catId, root = '.') {
  const file = benchmarksPath(catId, root);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

export function loadDictionary(catId, root = '.') {
  const file = dictionaryPath(catId, root);
  if (!fs.existsSync(file)) {
    throw new Error(`нет справочника ${file} — третья категория добавляется только этим файлом`);
  }
  const attrs = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (!Array.isArray(attrs) || !attrs.length) throw new Error(`пустой справочник ${file}`);
  return indexDictionary(attrs, String(catId));
}

export function indexDictionary(attrs, catId) {
  const byCode = new Map();
  const synonymIndex = new Map(); // normKey → [{attr, raw, len}]
  const blacklistIndex = []; // {norm, attr, raw}

  for (const attr of attrs) {
    if (!attr.code) throw new Error('у атрибута нет code');
    byCode.set(attr.code, attr);
    const names = [attr.name, ...(attr.synonyms || [])];
    for (const raw of names) {
      const nk = normKey(raw);
      if (!nk) continue;
      const list = synonymIndex.get(nk) || [];
      list.push({ attr, raw, len: nk.length });
      synonymIndex.set(nk, list);
    }
    for (const raw of attr.blacklist || []) {
      const nk = normKey(raw);
      if (nk) blacklistIndex.push({ norm: nk, attr, raw });
    }
  }

  const ordered = [...attrs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.code.localeCompare(b.code));
  return { catId, attrs: ordered, byCode, synonymIndex, blacklistIndex };
}

export function loadProducts(file) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (!Array.isArray(rows)) throw new Error(`${file}: ожидался массив`);
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    description: r.description ?? '',
    annotation: r.annotation ?? '',
  }));
}

export function writeJson(file, data, indent = 2) {
  const dir = path.dirname(file);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, indent) + '\n', 'utf-8');
}

/** Категории на выходе — только {id, name}[], как в исходном categories.json. */
export function loadCategories(root = '.') {
  const p = path.join(root, 'categories.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

export function writeCategories(file, cats) {
  const slim = cats.map((c) => ({ id: Number(c.id), name: String(c.name) }));
  if (fs.existsSync(file)) {
    try {
      const cur = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const same =
        Array.isArray(cur) &&
        cur.length === slim.length &&
        cur.every((c, i) =>
          c &&
          Object.keys(c).length === 2 &&
          Object.prototype.hasOwnProperty.call(c, 'id') &&
          Object.prototype.hasOwnProperty.call(c, 'name') &&
          Number(c.id) === slim[i].id &&
          String(c.name) === slim[i].name
        );
      if (same) return;
    } catch {
      /* rewrite */
    }
  }
  const dir = path.dirname(file);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(slim, null, 4) + '\n', 'utf-8');
}

export function coverageFinal(recs, dict) {
  const n = recs.length || 1;
  const out = {};
  for (const a of dict.attrs) {
    const filled = recs.filter((r) => r.attrs[a.code] != null && r.attrs[a.code] !== '').length;
    out[a.code] = Math.round((1000 * filled) / n) / 10;
  }
  return out;
}

/** Справочник на выходе = входной attributes_{id}.json + coverage_final рядом с coverage_now. */
export function attrsWithCoverage(dict, coverage) {
  return dict.attrs.map((a) => {
    const final = coverage && coverage[a.code] != null ? coverage[a.code] : null;
    const out = {};
    let inserted = false;
    for (const [k, v] of Object.entries(a)) {
      if (k === 'coverage_final') continue;
      out[k] = v;
      if (k === 'coverage_now') {
        out.coverage_final = final;
        inserted = true;
      }
    }
    if (!inserted) out.coverage_final = final;
    return out;
  });
}
