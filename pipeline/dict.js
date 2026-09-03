/** Загрузчик справочника attributes_{cat_id}.json. */

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

export function loadDictionary(catId, root = '.') {
  const file = path.join(root, `attributes_${catId}.json`);
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

export function writeJson(file, data) {
  const dir = path.dirname(file);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8');
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
