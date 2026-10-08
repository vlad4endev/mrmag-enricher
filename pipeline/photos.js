/**
 * Альбомы фото: массовая загрузка, метаданные, выгрузка в ML.
 * На диске: photos/{albumId}/meta.json + files/{itemId}.{ext}
 * В Docker — PHOTOS_DIR=/data/photos (том).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { resolveDictRoot } from './dict.js';
import { providerFetch } from '../socks.js';
import { recordProviderSpend, usageCostRub, roundMoney } from './provider_billing.js';

const ALBUM_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const ITEM_RE = /^[a-zA-Z0-9_-]{8,40}$/;
const MAX_ALBUMS = 200;
/** Потолок альбома: 15k+ прогоны; переопределяется PHOTO_MAX_ITEMS. */
const MAX_ITEMS = Math.max(1, Math.min(100_000, Number(process.env.PHOTO_MAX_ITEMS || 20_000)));
const MAX_FILE_BYTES = Number(process.env.PHOTO_MAX_BYTES || 12 * 1024 * 1024);
const MAX_BATCH_BYTES = Number(process.env.PHOTO_BATCH_BYTES || 48 * 1024 * 1024);
const MAX_BATCH_FILES = Number(process.env.PHOTO_BATCH_FILES || 40);

/** Очередь на альбом: параллельные workers не затирают чужие поля в meta.json. */
const albumTails = new Map();

export async function withAlbumLock(albumId, fn) {
  const key = String(albumId || '');
  const prev = albumTails.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((r) => { release = r; });
  albumTails.set(key, prev.then(() => gate, () => gate));
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const EXT_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function photosDir(root) {
  if (process.env.PHOTOS_DIR) return process.env.PHOTOS_DIR;
  const settings = process.env.SETTINGS_PATH;
  if (settings && (settings === '/data/config.json' || settings.startsWith('/data/'))) {
    return '/data/photos';
  }
  return path.join(resolveDictRoot(root), 'photos');
}

export function bootstrapPhotosDir(root) {
  const dest = photosDir(root);
  try {
    fs.mkdirSync(dest, { recursive: true });
  } catch (e) {
    throw new Error(
      `не удалось создать каталог фото «${dest}»: ${e.message}. `
      + 'В Docker задайте PHOTOS_DIR=/data/photos.',
    );
  }
  return dest;
}

function albumDir(albumId, root) {
  return path.join(photosDir(root), albumId);
}

function metaPath(albumId, root) {
  return path.join(albumDir(albumId, root), 'meta.json');
}

function filesDir(albumId, root) {
  return path.join(albumDir(albumId, root), 'files');
}

function assertAlbumId(id) {
  if (!ALBUM_RE.test(String(id || ''))) throw httpError(400, 'Некорректный id альбома');
  return String(id);
}

function assertItemId(id) {
  if (!ITEM_RE.test(String(id || ''))) throw httpError(400, 'Некорректный id фото');
  return String(id);
}

function newId(prefix = '') {
  return `${prefix}${crypto.randomBytes(8).toString('hex')}`;
}

function blankAlbum(id, name = '') {
  const now = Date.now();
  return {
    id,
    name: String(name || id).trim() || id,
    created_at: now,
    updated_at: now,
    category: null,
    model: null,
    items: [],
  };
}

function readMeta(albumId, root) {
  const file = metaPath(albumId, root);
  if (!fs.existsSync(file)) throw httpError(404, 'Альбом не найден');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) {
      throw new Error('битый meta.json');
    }
    return raw;
  } catch (e) {
    if (e.status) throw e;
    throw httpError(500, `не удалось прочитать альбом: ${e.message}`);
  }
}

function writeMeta(album, root) {
  const id = assertAlbumId(album.id);
  const dir = albumDir(id, root);
  fs.mkdirSync(filesDir(id, root), { recursive: true });
  album.updated_at = Date.now();
  const tmp = `${metaPath(id, root)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(album, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, metaPath(id, root));
  return album;
}

export function listAlbums(root) {
  bootstrapPhotosDir(root);
  const dir = photosDir(root);
  const names = fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && ALBUM_RE.test(d.name))
    .map(d => d.name)
    .sort((a, b) => b.localeCompare(a));

  return names.slice(0, MAX_ALBUMS).map((id) => {
    try {
      const meta = readMeta(id, root);
      const described = meta.items.filter(i => i.status === 'described' || i.status === 'ready').length;
      const errors = meta.items.filter(i => i.status === 'error').length;
      const bytes = meta.items.reduce((s, i) => s + (Number(i.bytes) || 0), 0);
      return {
        id: meta.id,
        name: meta.name,
        category: meta.category || null,
        model: meta.model || null,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        items: meta.items.length,
        described,
        errors,
        pending: meta.items.length - described - errors,
        bytes,
      };
    } catch {
      return { id, name: id, items: 0, described: 0, errors: 0, pending: 0, bytes: 0, broken: true };
    }
  });
}

export function createAlbum(name, { category = null } = {}, root) {
  bootstrapPhotosDir(root);
  if (listAlbums(root).length >= MAX_ALBUMS) {
    throw httpError(400, `Лимит альбомов: ${MAX_ALBUMS}`);
  }
  const id = newId('a');
  const album = blankAlbum(id, name);
  if (category != null && String(category).trim()) album.category = String(category).trim();
  writeMeta(album, root);
  return publicAlbum(album);
}

export function getAlbum(albumId, root) {
  const meta = readMeta(assertAlbumId(albumId), root);
  return publicAlbum(meta);
}

/** Сумма списаний AITUNNEL по всем описанным фото, ₽. */
export function sumPhotoSpend(root) {
  bootstrapPhotosDir(root);
  let sum = 0;
  for (const album of listAlbums(root)) {
    if (album.broken) continue;
    try {
      const meta = readMeta(album.id, root);
      for (const item of meta.items || []) {
        const cost = usageCostRub(item.usage);
        if (typeof cost === 'number') sum += cost;
      }
    } catch { /* битый альбом */ }
  }
  return roundMoney(sum);
}

function publicAlbum(meta) {
  return {
    id: meta.id,
    name: meta.name,
    category: meta.category || null,
    model: meta.model || null,
    created_at: meta.created_at,
    updated_at: meta.updated_at,
    items: (meta.items || []).map(publicItem),
  };
}

/** Id картинки для выгрузки: явный image_id → stem URL фида → id записи. */
export function photoImageId(item) {
  if (!item) return '';
  if (item.image_id != null && String(item.image_id).trim()) return String(item.image_id).trim();
  if (item.image_url) {
    const stem = String(item.image_url).split(/[?#]/)[0].split('/').pop() || '';
    const id = stem.replace(/\.[^.]+$/, '').trim();
    if (id) return id;
  }
  return item.id ? String(item.id) : '';
}

/** Позиция готова к ML-выгрузке: описана vision’ом (или вручную помечена ready). */
export function isPhotoExportable(item) {
  if (!item) return false;
  return item.status === 'described' || item.status === 'ready';
}

function publicItem(item) {
  const product_id = item.product_id || null;
  const dump_category = item.dump_category || null;
  return {
    id: item.id,
    filename: item.filename,
    mime: item.mime,
    bytes: item.bytes,
    product_id,
    image_id: photoImageId(item) || null,
    sku: item.sku || null,
    dump_category,
    dump_bound: Boolean(product_id && dump_category),
    feed: item.feed || null,
    image_url: item.image_url || null,
    status: item.status || 'uploaded',
    description: item.description || null,
    caption: item.caption || null,
    on_image: item.on_image || null,
    alt: item.alt || null,
    tags: item.tags || [],
    attributes: item.attributes || {},
    warnings: item.warnings || [],
    error: item.error || null,
    usage: item.usage || null,
    described_at: item.described_at || null,
    created_at: item.created_at,
  };
}

export function renameAlbum(albumId, name, root) {
  const meta = readMeta(assertAlbumId(albumId), root);
  const label = String(name || '').trim();
  if (!label) throw httpError(400, 'Укажите название альбома');
  meta.name = label.slice(0, 120);
  writeMeta(meta, root);
  return publicAlbum(meta);
}

export function patchAlbum(albumId, patch = {}, root) {
  const meta = readMeta(assertAlbumId(albumId), root);
  if (patch.name != null) {
    const label = String(patch.name || '').trim();
    if (!label) throw httpError(400, 'Укажите название альбома');
    meta.name = label.slice(0, 120);
  }
  if ('category' in patch) {
    meta.category = patch.category != null && String(patch.category).trim()
      ? String(patch.category).trim()
      : null;
  }
  writeMeta(meta, root);
  return publicAlbum(meta);
}

export function deleteAlbum(albumId, root) {
  const id = assertAlbumId(albumId);
  const dir = albumDir(id, root);
  if (!fs.existsSync(dir)) throw httpError(404, 'Альбом не найден');
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, id };
}

function sniffMime(buf, filename = '') {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 6 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) {
    return 'image/gif';
  }
  const ext = String(filename).split('.').pop()?.toLowerCase();
  if (ext && EXT_MIME[ext]) return EXT_MIME[ext];
  return null;
}

function decodeDataUrlOrBase64(raw) {
  const s = String(raw || '');
  const m = s.match(/^data:([^;]+);base64,(.+)$/i);
  if (m) return { mimeHint: m[1].toLowerCase(), buf: Buffer.from(m[2], 'base64') };
  return { mimeHint: null, buf: Buffer.from(s.replace(/\s+/g, ''), 'base64') };
}

/** Картинка фидового товара скачивается при первом обращении и кэшируется в альбоме. */
async function fetchFeedImage(meta, item, root, fetchImpl = fetch) {
  const MIN_IMAGE_BYTES = 1024; // заглушки/пиксели трекеров — не фото товара
  // Источник годится, только если по ссылке реально лежит картинка (проверяем содержимое, а не расширение в URL).
  async function attempt(get) {
    const res = await get();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = String(res.headers?.get?.('content-type') || '').toLowerCase();
    if (/^(text|application\/(xml|json))/.test(type)) throw new Error(`по ссылке не картинка (${type.split(';')[0]})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < MIN_IMAGE_BYTES) throw new Error('файл слишком мал для фото');
    if (buf.length > MAX_FILE_BYTES) throw new Error('файл слишком большой');
    const mime = sniffMime(buf); // без имени файла: только сигнатура JPEG/PNG/WebP/GIF
    if (!mime) throw new Error('содержимое не JPEG/PNG/WebP/GIF');
    return { buf, mime };
  }

  const errors = [];
  let got = null;
  // Сеть сервера может резать сайт магазина (DNS/DPI): прямое соединение, затем прокси приложения.
  for (const [label, get] of [
    ['напрямую', () => fetchImpl(item.image_url, { signal: AbortSignal.timeout(30_000) })],
    ['через прокси', () => providerFetch(item.image_url, { signal: AbortSignal.timeout(60_000) }, { useProxy: true })],
  ]) {
    try { got = await attempt(get); break; } catch (e) { errors.push(`${label}: ${e.cause?.code || e.message}`); }
  }
  if (!got) throw httpError(502, `изображение недоступно ${item.image_url} (${errors.join('; ')}) — товар пропущен`);

  const stored = `${item.id}.${MIME_EXT[got.mime]}`;
  fs.mkdirSync(filesDir(meta.id, root), { recursive: true });
  fs.writeFileSync(path.join(filesDir(meta.id, root), stored), got.buf);
  // Под lock: параллельный applyDescribeResult не должен затереть stored.
  await withAlbumLock(meta.id, async () => {
    const fresh = readMeta(meta.id, root);
    const row = fresh.items.find(i => i.id === item.id);
    if (!row) throw httpError(404, 'Фото не найдено');
    Object.assign(row, { stored, mime: got.mime, bytes: got.buf.length });
    Object.assign(item, { stored, mime: got.mime, bytes: got.buf.length });
    writeMeta(fresh, root);
  });
}

/**
 * Импорт товаров из YML (см. yml_feed.js): фото не качаем сразу, храним ссылку и факты фида.
 * Повторный импорт того же фида пропускает уже добавленные offer id.
 */
export function importFeedOffers(albumId, offers, root) {
  const meta = readMeta(assertAlbumId(albumId), root);
  const have = new Set(meta.items.map(i => i.product_id).filter(Boolean));
  const fresh = offers.filter(o => o.image_url && !have.has(o.id));
  if (meta.items.length + fresh.length > MAX_ITEMS) {
    throw httpError(400, `Лимит фото в альбоме: ${MAX_ITEMS} — уменьшите выборку`);
  }
  for (const o of fresh) {
    const id = newId();
    meta.items.push({
      id,
      filename: (o.image_url.split(/[?#]/)[0].split('/').pop() || o.id).replace(/[^\w.\-а-яА-ЯёЁ]+/g, '_').slice(0, 120),
      stored: null,
      mime: null,
      bytes: 0,
      image_url: o.image_url,
      product_id: o.id,
      sku: o.vendor_code || null,
      dump_category: null,
      feed: {
        name: o.name,
        category: o.category || null,
        brand: o.vendor || null,
        article: o.vendor_code || null,
        url: o.url || null,
        specs: o.params,
        synonyms: o.synonyms,
        shop_description: o.description || null,
      },
      status: 'uploaded',
      description: null, caption: null, on_image: null, alt: null,
      tags: [], attributes: {}, warnings: [], error: null, usage: null, described_at: null,
      created_at: Date.now(),
    });
  }
  writeMeta(meta, root);
  return { album: publicAlbum(meta), added: fresh.length, skipped: offers.length - fresh.length };
}

/**
 * Массовая загрузка: [{ name, data (base64|dataURL), product_id?, sku? }]
 */
export function uploadPhotos(albumId, files, root) {
  const meta = readMeta(assertAlbumId(albumId), root);
  if (!Array.isArray(files) || !files.length) throw httpError(400, 'Нет файлов');
  if (files.length > MAX_BATCH_FILES) {
    throw httpError(400, `За раз не больше ${MAX_BATCH_FILES} файлов`);
  }
  if (meta.items.length + files.length > MAX_ITEMS) {
    throw httpError(400, `Лимит фото в альбоме: ${MAX_ITEMS}`);
  }

  let batchBytes = 0;
  const added = [];
  const dir = filesDir(meta.id, root);
  fs.mkdirSync(dir, { recursive: true });

  for (const file of files) {
    if (!file || typeof file !== 'object') throw httpError(400, 'Файл должен быть объектом');
    const filename = String(file.name || 'photo.jpg').replace(/[^\w.\- ()а-яА-ЯёЁ]+/g, '_').slice(0, 180);
    const { mimeHint, buf } = decodeDataUrlOrBase64(file.data);
    if (!buf.length) throw httpError(400, `Пустой файл «${filename}»`);
    if (buf.length > MAX_FILE_BYTES) {
      throw httpError(400, `«${filename}» больше ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} МБ`);
    }
    batchBytes += buf.length;
    if (batchBytes > MAX_BATCH_BYTES) {
      throw httpError(400, `Пакет больше ${Math.round(MAX_BATCH_BYTES / 1024 / 1024)} МБ — загрузите частями`);
    }

    const mime = sniffMime(buf, filename) || (MIME_EXT[mimeHint] ? mimeHint : null);
    if (!mime || !MIME_EXT[mime]) {
      throw httpError(400, `«${filename}»: нужен JPEG/PNG/WebP/GIF`);
    }
    const ext = MIME_EXT[mime];
    const id = newId();
    const stored = `${id}.${ext}`;
    fs.writeFileSync(path.join(dir, stored), buf);

    const item = {
      id,
      filename,
      stored,
      mime,
      bytes: buf.length,
      product_id: file.product_id != null ? String(file.product_id).trim() || null : null,
      sku: file.sku != null ? String(file.sku).trim() || null : null,
      dump_category: file.dump_category != null ? String(file.dump_category).trim() || null : null,
      status: 'uploaded',
      description: null,
      caption: null,
      on_image: null,
      alt: null,
      tags: [],
      attributes: {},
      warnings: [],
      error: null,
      usage: null,
      described_at: null,
      created_at: Date.now(),
    };
    meta.items.push(item);
    added.push(publicItem(item));
  }

  writeMeta(meta, root);
  return { album: publicAlbum(meta), added };
}

export function patchPhotoItem(albumId, itemId, patch, root) {
  const meta = readMeta(assertAlbumId(albumId), root);
  const id = assertItemId(itemId);
  const item = meta.items.find(i => i.id === id);
  if (!item) throw httpError(404, 'Фото не найдено');

  if (patch && typeof patch === 'object') {
    if ('product_id' in patch) {
      item.product_id = patch.product_id != null ? String(patch.product_id).trim() || null : null;
    }
    if ('sku' in patch) {
      item.sku = patch.sku != null ? String(patch.sku).trim() || null : null;
    }
    if ('dump_category' in patch) {
      item.dump_category = patch.dump_category != null && String(patch.dump_category).trim()
        ? String(patch.dump_category).trim()
        : null;
    }
    // Явная отвязка: dump_bound=false сбрасывает и id, и раздел
    if (patch.dump_bound === false) {
      item.product_id = null;
      item.sku = null;
      item.dump_category = null;
    }
    if ('description' in patch && patch.description != null) {
      item.description = String(patch.description).slice(0, 8000);
    }
    if ('caption' in patch && patch.caption != null) item.caption = String(patch.caption).slice(0, 1000);
    if ('on_image' in patch && patch.on_image != null) item.on_image = String(patch.on_image).slice(0, 2000);
    if ('alt' in patch && patch.alt != null) item.alt = String(patch.alt).slice(0, 500);
    if ('tags' in patch && Array.isArray(patch.tags)) {
      item.tags = patch.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 40);
    }
    // Любая правка текста описания → в выгрузку (не оставляем uploaded с заполненным caption).
    if (
      item.status === 'uploaded'
      && (String(item.caption || '').trim() || String(item.description || '').trim())
    ) {
      item.status = 'described';
    }
  }
  writeMeta(meta, root);
  return publicItem(item);
}

export function deletePhotoItem(albumId, itemId, root) {
  const meta = readMeta(assertAlbumId(albumId), root);
  const id = assertItemId(itemId);
  const idx = meta.items.findIndex(i => i.id === id);
  if (idx < 0) throw httpError(404, 'Фото не найдено');
  const [item] = meta.items.splice(idx, 1);
  const file = item.stored ? path.join(filesDir(meta.id, root), item.stored) : null;
  try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch { /* */ }
  writeMeta(meta, root);
  return { ok: true, id };
}

export async function readPhotoFile(albumId, itemId, root) {
  const meta = readMeta(assertAlbumId(albumId), root);
  const id = assertItemId(itemId);
  const item = meta.items.find(i => i.id === id);
  if (!item) throw httpError(404, 'Фото не найдено');
  if (!item.stored && item.image_url) await fetchFeedImage(meta, item, root);
  const file = path.join(filesDir(meta.id, root), item.stored);
  if (!fs.existsSync(file)) throw httpError(404, 'Файл на диске не найден');
  return {
    item: publicItem(item),
    mime: item.mime,
    buf: fs.readFileSync(file),
    path: file,
  };
}

export async function applyDescribeResult(albumId, itemId, result, root) {
  return withAlbumLock(albumId, async () => {
    const meta = readMeta(assertAlbumId(albumId), root);
    const id = assertItemId(itemId);
    const item = meta.items.find(i => i.id === id);
    if (!item) throw httpError(404, 'Фото не найдено');

    if (result?.error) {
      item.status = 'error';
      item.error = String(result.error).slice(0, 800);
      if (result.usage) {
        item.usage = result.usage;
        recordProviderSpend('aitunnel', result.usage, root);
      }
      writeMeta(meta, root);
      return publicItem(item);
    }

    item.status = 'described';
    item.error = null;
    item.description = String(result.description || '').slice(0, 8000);
    item.caption = String(result.caption || '').slice(0, 1000);
    item.on_image = String(result.on_image || '').slice(0, 2000) || null;
    item.alt = String(result.alt || '').slice(0, 500);
    item.tags = Array.isArray(result.tags)
      ? result.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 40)
      : [];
    item.attributes = result.attributes && typeof result.attributes === 'object'
      ? result.attributes
      : {};
    item.warnings = Array.isArray(result.warnings) ? result.warnings.slice(0, 20) : [];
    item.usage = result.usage || null;
    if (result.usage) recordProviderSpend('aitunnel', result.usage, root);
    item.described_at = Date.now();
    if (result.model) meta.model = result.model;
    writeMeta(meta, root);
    return publicItem(item);
  });
}

const ATTR_ORDER = ['view', 'color', 'product_type', 'brand_visible', 'text_on_image'];

function orderedAttributes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cleaned = {};
  const put = (k, v) => {
    if (v == null) return;
    if (typeof v === 'boolean') {
      if (v === true) cleaned[k] = true;
      return;
    }
    const s = String(v).trim();
    if (s) cleaned[k] = s;
  };
  for (const k of ATTR_ORDER) {
    if (k in raw) put(k, raw[k]);
  }
  for (const [k, v] of Object.entries(raw)) {
    if (k in cleaned || ATTR_ORDER.includes(k)) continue;
    put(String(k).slice(0, 40), v);
  }
  return Object.keys(cleaned).length ? cleaned : null;
}

/** Стабильный порядок ключей рабочего ML-формата. */
export const PHOTO_EXPORT_KEYS = [
  'image', 'caption', 'objects', 'description', 'alt', 'tags', 'attributes', 'product_id', 'image_id',
];

/**
 * Запись ML-выгрузки — полный набор полей в стабильном порядке:
 * image · caption · objects · description · alt · tags · attributes · product_id · image_id
 * image — название товара (как в фиде), не URL.
 */
export function photoExportRow(item, {
  include_images = false,
  album_id = null,
  root,
} = {}) {
  const image = String(item.feed?.name || item.filename || '').trim();
  const caption = String(item.caption || '').trim();
  const objects = String(item.on_image || '').trim();
  const description = String(item.description || '').trim();
  const alt = String(item.alt || '').trim();
  const tags = Array.isArray(item.tags)
    ? [...new Set(item.tags.map(t => String(t).trim()).filter(Boolean))]
    : [];
  const attributes = orderedAttributes(item.attributes) || {};
  const productId = item.product_id != null ? String(item.product_id).trim() : '';
  const imageId = photoImageId(item);

  const row = {
    image,
    caption,
    objects,
    description,
    alt,
    tags,
    attributes,
    product_id: productId,
    image_id: imageId,
  };

  if (include_images && album_id && item.stored && root) {
    try {
      const fp = path.join(filesDir(album_id, root), item.stored);
      row.image_base64 = fs.readFileSync(fp).toString('base64');
    } catch { /* skip broken file */ }
  }

  return row;
}

/** Экранирование текста для XML (атрибуты и содержимое тегов). */
export function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * ML-выгрузка в XML «как в фиде»: yml_catalog → shop → offers → offer.
 * Те же поля, что в JSON (image→name, caption, objects, description, alt, tags,
 * attributes, product_id, image_id) + picture из image_url товара.
 */
export function photosToYmlXml(photos, { imageUrls = [] } = {}) {
  const offers = photos.map((row, i) => {
    const id = String(row.product_id || row.image_id || `photo-${i + 1}`).trim();
    const lines = [`    <offer id="${escapeXml(id)}">`];
    if (row.image) lines.push(`      <name>${escapeXml(row.image)}</name>`);
    const picture = imageUrls[i] || row.image_url || '';
    if (picture) lines.push(`      <picture>${escapeXml(picture)}</picture>`);
    for (const key of ['caption', 'objects', 'description', 'alt']) {
      const val = String(row[key] || '').trim();
      if (val) lines.push(`      <${key}>${escapeXml(val)}</${key}>`);
    }
    if (Array.isArray(row.tags) && row.tags.length) {
      lines.push('      <tags>');
      for (const t of row.tags) {
        const tag = String(t || '').trim();
        if (tag) lines.push(`        <tag>${escapeXml(tag)}</tag>`);
      }
      lines.push('      </tags>');
    }
    const attrs = row.attributes && typeof row.attributes === 'object' && !Array.isArray(row.attributes)
      ? row.attributes
      : null;
    if (attrs && Object.keys(attrs).length) {
      lines.push('      <attributes>');
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        const name = String(k || '').trim();
        if (!name) continue;
        lines.push(`        <param name="${escapeXml(name)}">${escapeXml(String(v))}</param>`);
      }
      lines.push('      </attributes>');
    }
    if (row.product_id) lines.push(`      <product_id>${escapeXml(row.product_id)}</product_id>`);
    if (row.image_id) lines.push(`      <image_id>${escapeXml(row.image_id)}</image_id>`);
    if (row.image_base64) {
      lines.push(`      <image_base64>${escapeXml(row.image_base64)}</image_base64>`);
    }
    lines.push('    </offer>');
    return lines.join('\n');
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<yml_catalog>',
    '  <shop>',
    '    <offers>',
    ...offers,
    '    </offers>',
    '  </shop>',
    '</yml_catalog>',
    '',
  ].join('\n');
}

/**
 * ML-датасет: JSONL / JSON / XML (YML-фид).
 * Все described|ready попадают в файл; ключи строки — стабильный рабочий набор.
 * include_images=false — без base64 (лёгкий).
 */
export function buildMlExport(albumId, {
  format = 'jsonl',
  include_images = false,
  only_described = true,
} = {}, root) {
  const meta = readMeta(assertAlbumId(albumId), root);
  let items = meta.items.slice();
  if (only_described) {
    items = items.filter(isPhotoExportable);
  }
  if (!items.length) throw httpError(400, 'Нет описанных фото для выгрузки');

  const photos = items.map((item) => photoExportRow(item, {
    include_images,
    album_id: meta.id,
    root,
  }));

  // Инвариант: ни одна обработанная позиция не потерялась и ключи полные.
  if (photos.length !== items.length) {
    throw httpError(500, `Выгрузка обрезана: ${photos.length} из ${items.length}`);
  }
  for (const row of photos) {
    for (const key of PHOTO_EXPORT_KEYS) {
      if (!(key in row)) throw httpError(500, `В выгрузке нет поля «${key}»`);
    }
  }

  const fmt = format === 'yml' ? 'xml' : format;
  const pack = { count: photos.length, album_id: meta.id };

  if (fmt === 'xml') {
    return {
      ...pack,
      filename: `photos_${meta.id}.xml`,
      mime: 'application/xml; charset=utf-8',
      body: photosToYmlXml(photos, {
        imageUrls: items.map(i => i.image_url || null),
      }),
    };
  }

  if (fmt === 'json') {
    return {
      ...pack,
      filename: `photos_${meta.id}.json`,
      mime: 'application/json; charset=utf-8',
      body: `${JSON.stringify(photos, null, 2)}\n`,
    };
  }

  const lines = photos.map(r => JSON.stringify(r)).join('\n') + '\n';
  return {
    ...pack,
    filename: `photos_${meta.id}.jsonl`,
    mime: 'application/x-ndjson; charset=utf-8',
    body: lines,
  };
}

export const PHOTO_LIMITS = {
  MAX_FILE_BYTES,
  MAX_BATCH_BYTES,
  MAX_BATCH_FILES,
  MAX_ITEMS,
  MAX_ALBUMS,
};
