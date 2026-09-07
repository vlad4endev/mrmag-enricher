/**
 * Дампы исходников заказчика: data_{catId}.json на диске.
 * В Docker — /data/dumps (том), локально — dumps/ рядом с проектом.
 */

import fs from 'fs';
import path from 'path';
import { resolveDictRoot, categoryName, listDictionaries, loadCategories } from './dict.js';

const DATA_FILE_RE = /^data_(\d+)\.json$/i;
const MAX_DUMP_BYTES = 32 * 1024 * 1024;
const MAX_PRODUCTS = 20_000;
const MAX_ARCHIVES = 8;

export function dumpsDir(root) {
  if (process.env.DUMPS_DIR) return process.env.DUMPS_DIR;
  const settings = process.env.SETTINGS_PATH;
  if (settings && (settings === '/data/config.json' || settings.startsWith('/data/'))) {
    return '/data/dumps';
  }
  return path.join(resolveDictRoot(root), 'dumps');
}

export function dumpPath(catId, root) {
  return path.join(dumpsDir(root), `data_${catId}.json`);
}

export function dumpsArchiveDir(root) {
  return path.join(dumpsDir(root), 'archive');
}

function dumpNamesPath(root) {
  return path.join(dumpsDir(root), 'names.json');
}

export function loadDumpNames(root) {
  const file = dumpNamesPath(root);
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [id, name] of Object.entries(raw)) {
      if (!/^\d+$/.test(id)) continue;
      const label = String(name || '').trim();
      if (label) out[id] = label;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeDumpName(catId, name, root) {
  const label = String(name || '').trim();
  if (!/^\d+$/.test(String(catId)) || !label) return;
  bootstrapDumpsDir(root);
  const names = loadDumpNames(root);
  names[String(catId)] = label;
  fs.writeFileSync(dumpNamesPath(root), `${JSON.stringify(names, null, 2)}\n`, 'utf-8');
}

export function dumpDisplayName(catId, root) {
  const custom = loadDumpNames(root)[String(catId)];
  if (custom) return custom;
  return categoryName(catId, root);
}

export function listShopCategories(root) {
  try {
    return loadCategories(root)
      .filter((c) => c && c.id != null && String(c.name || '').trim())
      .map((c) => ({ id: String(c.id), name: String(c.name).trim() }))
      .sort((a, b) => Number(a.id) - Number(b.id));
  } catch {
    return [];
  }
}

export function catIdFromDumpName(name) {
  const base = String(name || '').replace(/^.*[\\/]/, '');
  const m = base.match(/^(?:data|products|filters)_(\d+)(?:\.[^.]+)?$/i)
    || base.match(/^(\d+)(?:\.[^.]+)?$/);
  return m ? m[1] : null;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function bootstrapDumpsDir(root) {
  const dest = dumpsDir(root);
  try {
    fs.mkdirSync(dest, { recursive: true });
    fs.mkdirSync(dumpsArchiveDir(root), { recursive: true });
  } catch (e) {
    const err = new Error(
      `не удалось создать каталог дампов «${dest}»: ${e.message}. `
      + 'В Docker задайте DUMPS_DIR=/data/dumps (том /data).',
    );
    err.cause = e;
    err.status = 500;
    throw err;
  }
  if (process.env.DUMP_SEED === '0') return dest;
  const bundled = resolveDictRoot(root);
  if (path.resolve(dest) === path.resolve(bundled)) return dest;
  for (const name of fs.readdirSync(bundled)) {
    const m = name.match(DATA_FILE_RE);
    if (!m) continue;
    const to = path.join(dest, name);
    if (fs.existsSync(to)) continue;
    const from = path.join(bundled, name);
    try {
      fs.copyFileSync(from, to);
    } catch {
      /* нет прав на копию — дамп просто появится после загрузки в UI */
    }
  }
  return dest;
}

function annotationOf(p) {
  return String(p?.annotation ?? p?.annotation_html ?? p?.characteristics ?? '').trim();
}

export function normalizeDumpRow(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    throw httpError(400, 'каждый товар — объект {id, name, description, annotation}');
  }
  const rawId = p.id ?? p.sku ?? p.article;
  if (rawId == null || String(rawId).trim() === '') {
    throw httpError(400, 'у товара нет id / sku');
  }
  const name = String(p.name ?? p.title ?? '').trim();
  if (!name) throw httpError(400, `у товара ${rawId} нет названия`);
  const id = /^\d+$/.test(String(rawId)) ? Number(rawId) : String(rawId).trim();
  return {
    id,
    name,
    description: String(p.description ?? p.description_html ?? p.seo_description ?? ''),
    annotation: String(p.annotation ?? p.annotation_html ?? p.characteristics ?? p.attrs_html ?? ''),
  };
}

export function productsFromDumpPayload(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return null;
  for (const k of ['items', 'products', 'data']) {
    if (Array.isArray(parsed[k])) return parsed[k];
  }
  return null;
}

export function parseDumpPayload(raw, filename = '') {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw httpError(400, `не JSON: ${e.message}`);
  }
  const rows = productsFromDumpPayload(parsed);
  if (!rows) {
    throw httpError(400, 'нужен массив товаров или {products:[…]} / {items:[…]}');
  }
  if (rows.length > MAX_PRODUCTS) {
    throw httpError(400, `больше ${MAX_PRODUCTS} товаров в одном дампе нельзя`);
  }
  const products = rows.map((p, i) => {
    try {
      return normalizeDumpRow(p);
    } catch (e) {
      throw httpError(e.status || 400, `элемент №${i + 1}: ${e.message}`);
    }
  });
  if (!products.length) throw httpError(400, 'в файле нет товаров');
  const seen = new Set();
  for (const p of products) {
    const k = String(p.id);
    if (seen.has(k)) throw httpError(400, `повторный id ${p.id}`);
    seen.add(k);
  }
  let name = null;
  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
    const label = parsed.name ?? parsed.category_name;
    if (label != null && String(label).trim()) name = String(label).trim();
  }
  return {
    catId: catIdFromDumpName(filename),
    products,
    name,
  };
}

export function summarizeDump(products) {
  let withAnnotation = 0;
  for (const p of products || []) {
    if (annotationOf(p)) withAnnotation++;
  }
  const n = (products || []).length;
  return {
    products: n,
    with_annotation: withAnnotation,
    empty_annotation: n - withAnnotation,
  };
}

function fileMeta(file) {
  const st = fs.statSync(file);
  return { bytes: st.size, mtime: st.mtime.toISOString() };
}

function archivePrefix(catId) {
  return `data_${catId}_`;
}

function listArchiveFiles(catId, root) {
  const dir = dumpsArchiveDir(root);
  if (!fs.existsSync(dir)) return [];
  const prefix = archivePrefix(catId);
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => {
      const file = path.join(dir, name);
      try {
        return { file: name, stamp: name.slice(prefix.length, -5), ...fileMeta(file), mtimeMs: fs.statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function listArchives(catId, root) {
  return listArchiveFiles(catId, root)
    .slice(0, MAX_ARCHIVES)
    .map(({ file, stamp, bytes, mtime }) => ({ file, stamp, bytes, mtime }));
}

function pruneArchives(catId, root) {
  for (const extra of listArchiveFiles(catId, root).slice(MAX_ARCHIVES)) {
    try { fs.unlinkSync(path.join(dumpsArchiveDir(root), extra.file)); } catch { /* ignore */ }
  }
}

function publicDump(catId, root, products, extra = {}) {
  const file = dumpPath(catId, root);
  const exists = fs.existsSync(file);
  const stats = summarizeDump(products || []);
  return {
    id: String(catId),
    name: dumpDisplayName(catId, root),
    file: exists ? `data_${catId}.json` : null,
    has_file: exists,
    ...stats,
    ...(exists ? fileMeta(file) : { bytes: 0, mtime: null }),
    archives: listArchives(catId, root),
    ...extra,
  };
}

function readDumpRows(catId, root) {
  const file = dumpPath(catId, root);
  if (!fs.existsSync(file)) {
    throw httpError(404, `нет дампа data_${catId}.json`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    throw httpError(400, `data_${catId}.json не читается: ${e.message}`);
  }
  const rows = productsFromDumpPayload(parsed);
  if (!rows) throw httpError(400, `data_${catId}.json: нужен массив товаров`);
  return rows;
}

export function listDumps(root) {
  bootstrapDumpsDir(root);
  const dir = dumpsDir(root);
  const byId = new Map();
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(DATA_FILE_RE);
    if (!m) continue;
    const id = m[1];
    try {
      const products = readDumpRows(id, root);
      byId.set(id, publicDump(id, root, products));
    } catch (e) {
      byId.set(id, publicDump(id, root, [], {
        error: e.message,
        products: 0,
        with_annotation: 0,
        empty_annotation: 0,
      }));
    }
  }
  for (const d of listDictionaries(root)) {
    if (byId.has(d.id)) continue;
    byId.set(d.id, publicDump(d.id, root, []));
  }
  return [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

export function getDump(catId, root) {
  if (!/^\d+$/.test(String(catId))) throw httpError(400, 'id раздела — только цифры');
  const products = readDumpRows(catId, root);
  return { ...publicDump(catId, root, products), products };
}

export function previewDump(catId, { q = '', offset = 0, limit = 40 } = {}, root) {
  const dump = getDump(catId, root);
  const needle = String(q || '').trim().toLowerCase();
  let rows = dump.products.map((p) => ({
    id: p.id,
    name: p.name,
    annotation_chars: annotationOf(p).length,
  }));
  if (needle) {
    rows = rows.filter((p) => (
      String(p.id).includes(needle) || String(p.name).toLowerCase().includes(needle)
    ));
  }
  const start = Math.max(0, Number(offset) || 0);
  const take = Math.min(200, Math.max(1, Number(limit) || 40));
  return {
    id: dump.id,
    name: dump.name,
    products: dump.products.length,
    with_annotation: dump.with_annotation,
    empty_annotation: dump.empty_annotation,
    matched: rows.length,
    offset: start,
    products_preview: rows.slice(start, start + take),
  };
}

function archiveCurrent(catId, root) {
  const file = dumpPath(catId, root);
  if (!fs.existsSync(file)) return null;
  const dir = dumpsArchiveDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `data_${catId}_${Date.now()}.json`);
  fs.copyFileSync(file, dest);
  pruneArchives(catId, root);
  return dest;
}

function writeDumpFile(catId, products, root) {
  const dir = dumpsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = dumpPath(catId, root);
  const payload = `${JSON.stringify(products, null, 2)}\n`;
  if (Buffer.byteLength(payload) > MAX_DUMP_BYTES) {
    throw httpError(413, `дамп больше ${Math.round(MAX_DUMP_BYTES / 1024 / 1024)} МБ`);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload, 'utf-8');
  fs.renameSync(tmp, file);
  return file;
}

export function saveDump(catId, products, root, { name } = {}) {
  if (!/^\d+$/.test(String(catId))) throw httpError(400, 'id раздела — только цифры');
  if (!Array.isArray(products) || !products.length) {
    throw httpError(400, 'передан пустой список товаров');
  }
  if (products.length > MAX_PRODUCTS) {
    throw httpError(400, `больше ${MAX_PRODUCTS} товаров в одном дампе нельзя`);
  }
  bootstrapDumpsDir(root);
  archiveCurrent(catId, root);
  const rows = products.map((p, i) => {
    try { return normalizeDumpRow(p); } catch (e) {
      throw httpError(e.status || 400, `элемент №${i + 1}: ${e.message}`);
    }
  });
  writeDumpFile(catId, rows, root);
  if (name) writeDumpName(catId, name, root);
  return publicDump(catId, root, rows);
}

export function deleteDump(catId, root) {
  if (!/^\d+$/.test(String(catId))) throw httpError(400, 'id раздела — только цифры');
  const file = dumpPath(catId, root);
  if (!fs.existsSync(file)) throw httpError(404, `нет дампа data_${catId}.json`);
  archiveCurrent(catId, root);
  fs.unlinkSync(file);
  return { ok: true, id: String(catId), archived: true };
}

const dumpIndexCache = new Map();

function dumpFileCandidates(catId, root) {
  const resolved = resolveDictRoot(root);
  const id = String(catId ?? '').replace(/^cat_/, '');
  return [...new Set([
    dumpPath(id, resolved),
    path.join(resolved, `data_${id}.json`),
  ])];
}

function indexDumpFile(file) {
  if (!fs.existsSync(file)) return null;
  const st = fs.statSync(file);
  const cached = dumpIndexCache.get(file);
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached.byKey;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
  const rows = productsFromDumpPayload(parsed);
  const byKey = new Map();
  if (Array.isArray(rows)) {
    for (const p of rows) {
      try {
        const row = normalizeDumpRow(p);
        for (const k of [row.id, p.id, p.sku, p.article]) {
          if (k == null || String(k).trim() === '') continue;
          const key = String(k).trim();
          if (!byKey.has(key)) byKey.set(key, row);
        }
      } catch {
        /* битая строка дампа — пропускаем */
      }
    }
  }
  dumpIndexCache.set(file, { mtime: st.mtimeMs, size: st.size, byKey });
  return byKey;
}

/**
 * Карточка заказчика из data_{catId}.json по id/sku.
 * Сначала каталог дампов, затем bundled-файл в корне проекта.
 */
export function findDumpProduct(catId, sku, root) {
  if (catId == null || sku == null) return null;
  const key = String(sku).trim();
  const id = String(catId).replace(/^cat_/, '').trim();
  if (!key || !id) return null;
  for (const file of dumpFileCandidates(id, root)) {
    try {
      const idx = indexDumpFile(file);
      if (idx?.has(key)) return idx.get(key);
    } catch {
      /* нет файла / не JSON */
    }
  }
  return null;
}

export function restoreDumpArchive(catId, archiveName, root) {
  if (!/^\d+$/.test(String(catId))) throw httpError(400, 'id раздела — только цифры');
  const base = path.basename(String(archiveName || ''));
  const prefix = archivePrefix(catId);
  if (!base.startsWith(prefix) || !base.endsWith('.json') || base !== String(archiveName || '')) {
    throw httpError(400, 'неверное имя архива');
  }
  const src = path.join(dumpsArchiveDir(root), base);
  if (!fs.existsSync(src)) throw httpError(404, 'архив не найден');
  const products = parseDumpPayload(fs.readFileSync(src, 'utf-8'), base).products;
  return saveDump(catId, products, root);
}

export const DUMP_LIMITS = { MAX_DUMP_BYTES, MAX_PRODUCTS, MAX_ARCHIVES };
