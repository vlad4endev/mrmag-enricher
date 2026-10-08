/**
 * Кусковая приёмка большого YML за прокси с client_max_body_size ~1m.
 * Части пишутся на диск, на последней — склеиваются в один XML-файл.
 */

import fs from 'fs';
import path from 'path';
import { photosDir } from './photos.js';

const UPLOAD_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const MAX_PARTS = 200;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PART_CHARS = 900_000; // JSON-обёртка + чанк должны влезать в ~1 МБ nginx
const TTL_MS = 60 * 60 * 1000;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function uploadsRoot(root) {
  return path.join(photosDir(root), '.yml_uploads');
}

function uploadDir(root, uploadId) {
  if (!UPLOAD_RE.test(uploadId)) throw httpError(400, 'Некорректный upload_id');
  return path.join(uploadsRoot(root), uploadId);
}

function partPath(dir, part) {
  return path.join(dir, `${String(part).padStart(5, '0')}.part`);
}

function metaPath(dir) {
  return path.join(dir, 'meta.json');
}

function cleanupOld(root) {
  const base = uploadsRoot(root);
  if (!fs.existsSync(base)) return;
  const now = Date.now();
  for (const name of fs.readdirSync(base)) {
    const dir = path.join(base, name);
    try {
      const st = fs.statSync(dir);
      if (!st.isDirectory()) continue;
      let age = now - st.mtimeMs;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath(dir), 'utf8'));
        if (meta.at) age = now - meta.at;
      } catch { /* */ }
      if (age > TTL_MS) fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* */ }
  }
}

/**
 * Принять один кусок. На последнем parts-1 возвращает { done:true, filePath }.
 * Иначе { done:false, received, parts }.
 */
export function acceptYmlChunk(root, {
  upload_id,
  part,
  parts,
  data,
  album_id = '',
} = {}) {
  cleanupOld(root);
  const uploadId = String(upload_id || '');
  const partN = Number(part);
  const partsN = Number(parts);
  const chunk = String(data ?? '');

  if (!UPLOAD_RE.test(uploadId)) throw httpError(400, 'Некорректный upload_id');
  if (!Number.isInteger(partN) || partN < 0) throw httpError(400, 'Некорректный part');
  if (!Number.isInteger(partsN) || partsN < 1 || partsN > MAX_PARTS) {
    throw httpError(400, `parts должен быть 1…${MAX_PARTS}`);
  }
  if (partN >= partsN) throw httpError(400, 'part вне диапазона');
  if (!chunk.length) throw httpError(400, 'Пустой кусок фида');
  if (chunk.length > MAX_PART_CHARS) {
    throw httpError(413, `Кусок больше ${MAX_PART_CHARS} символов — уменьшите размер чанка`);
  }

  const dir = uploadDir(root, uploadId);
  fs.mkdirSync(dir, { recursive: true });
  const metaFile = metaPath(dir);
  let meta = { at: Date.now(), parts: partsN, album_id: String(album_id || ''), bytes: 0, got: {} };
  if (fs.existsSync(metaFile)) {
    try { meta = { ...meta, ...JSON.parse(fs.readFileSync(metaFile, 'utf8')) }; } catch { /* */ }
  }
  if (meta.parts && meta.parts !== partsN) throw httpError(400, 'parts не совпадает с началом загрузки');
  meta.parts = partsN;
  meta.at = Date.now();
  meta.album_id = String(album_id || meta.album_id || '');

  const prevBytes = Number(meta.bytes) || 0;
  // перезапись того же part — вычитаем старый размер
  if (meta.got?.[partN]) {
    meta.bytes = Math.max(0, prevBytes - Number(meta.got[partN]));
  }
  if (meta.bytes + chunk.length > MAX_TOTAL_BYTES) {
    throw httpError(413, `Фид больше ${Math.round(MAX_TOTAL_BYTES / 1e6)} МБ`);
  }

  fs.writeFileSync(partPath(dir, partN), chunk, 'utf8');
  meta.got = meta.got || {};
  meta.got[partN] = chunk.length;
  meta.bytes = (Number(meta.bytes) || 0) + chunk.length;
  fs.writeFileSync(metaFile, JSON.stringify(meta));

  const received = Object.keys(meta.got).length;
  if (received < partsN) {
    return { done: false, received, parts: partsN, bytes: meta.bytes };
  }

  // Все части на месте — склеить в xml
  const outFile = path.join(dir, 'feed.xml');
  const fd = fs.openSync(outFile, 'w');
  try {
    for (let i = 0; i < partsN; i++) {
      const p = partPath(dir, i);
      if (!fs.existsSync(p)) throw httpError(400, `Не хватает куска ${i + 1}/${partsN}`);
      fs.writeSync(fd, fs.readFileSync(p));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { done: true, filePath: outFile, bytes: meta.bytes, parts: partsN, uploadDir: dir };
}

/** Удалить временную папку загрузки (после успешного импорта или ошибки). */
export function discardYmlUpload(root, uploadIdOrDir) {
  try {
    const dir = uploadIdOrDir.includes(path.sep) || uploadIdOrDir.includes('/')
      ? uploadIdOrDir
      : uploadDir(root, uploadIdOrDir);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* */ }
}

export const YML_CHUNK_LIMITS = {
  MAX_PARTS,
  MAX_TOTAL_BYTES,
  MAX_PART_CHARS,
  TTL_MS,
};
