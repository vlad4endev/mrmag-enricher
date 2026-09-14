/**
 * Фоновые прогоны описания фото — по тому же принципу, что jobs.js:
 * браузер ставит задачу, сервер крутит цикл и пишет прогресс на диск.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  getAlbum, readPhotoFile, applyDescribeResult, PHOTO_LIMITS,
} from './photos.js';
import { describePhoto } from './photo_agent.js';
import { usageCostRub } from './provider_billing.js';

const now = () => Date.now();
const LOG_CAP = 2000;
export const PHOTO_JOB_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.PHOTO_JOB_CONCURRENCY || 2)));

export function createPhotoJobStore({
  describeOne,
  dir = process.env.PHOTO_JOBS_DIR || 'photo_jobs',
  ttlMs = Number(process.env.PHOTO_JOBS_TTL_MS || 7 * 24 * 3600_000),
  concurrency = PHOTO_JOB_CONCURRENCY,
  log = console.log,
} = {}) {
  const jobs = new Map();
  const file = id => path.join(dir, `${id}.json`);
  fs.mkdirSync(dir, { recursive: true });
  const pending = new Map();

  function flush(job) {
    pending.delete(job.id);
    if (job.removed) return;
    job.saved_at = now();
    const tmp = `${file(job.id)}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(job));
      fs.renameSync(tmp, file(job.id));
    } catch (e) {
      log(`⚠ photo-job ${job.id}: не записан — ${e.message}`);
    }
  }

  function save(job, immediate = false) {
    if (immediate) {
      const t = pending.get(job.id);
      if (t) clearTimeout(t);
      return flush(job);
    }
    if (pending.has(job.id)) return;
    pending.set(job.id, setTimeout(() => flush(job), 800));
  }

  function pushLog(job, message, level = 'info') {
    if (!Array.isArray(job.log)) job.log = [];
    job.log.push({ at: now(), level, message: String(message).slice(0, 500) });
    if (job.log.length > LOG_CAP) job.log.splice(0, job.log.length - LOG_CAP);
  }

  function summary(job) {
    return {
      id: job.id,
      album_id: job.album_id,
      model: job.model,
      status: job.status,
      total: job.item_ids.length,
      done: job.done,
      ok: job.ok,
      err: job.err,
      cost: job.cost,
      at: job.at,
      finished_at: job.finished_at || null,
      stop: Boolean(job.stop),
    };
  }

  function state(job, { from = 0, logFrom = 0 } = {}) {
    const f = Math.max(0, Number(from) || 0);
    const lf = Math.max(0, Number(logFrom) || 0);
    return {
      ...summary(job),
      results: (job.results || []).slice(f),
      results_from: f,
      log: (job.log || []).slice(lf),
      log_from: lf,
    };
  }

  function get(id) { return jobs.get(id) || null; }

  function list() {
    return [...jobs.values()]
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, 80)
      .map(summary);
  }

  function remove(id) {
    const job = jobs.get(id);
    if (!job) return false;
    job.removed = true;
    job.stop = true;
    jobs.delete(id);
    try { fs.unlinkSync(file(id)); } catch { /* */ }
    return true;
  }

  function create({ album_id, model, provider = null, item_ids = null }) {
    if (!album_id) throw Object.assign(new Error('Нет album_id'), { status: 400 });
    if (!model) throw Object.assign(new Error('Нет модели'), { status: 400 });

    const album = getAlbum(album_id);
    let ids = Array.isArray(item_ids) && item_ids.length
      ? item_ids.map(String)
      : album.items.filter(i => i.status === 'uploaded' || i.status === 'error').map(i => i.id);
    if (!ids.length) {
      ids = album.items.map(i => i.id);
    }
    if (!ids.length) throw Object.assign(new Error('В альбоме нет фото'), { status: 400 });
    if (ids.length > PHOTO_LIMITS.MAX_ITEMS) {
      throw Object.assign(new Error('Слишком много фото'), { status: 400 });
    }

    const id = crypto.randomBytes(6).toString('hex');
    const job = {
      id,
      at: now(),
      album_id,
      model,
      provider,
      item_ids: ids,
      results: ids.map(() => null),
      done: 0,
      ok: 0,
      err: 0,
      cost: 0,
      status: 'running',
      stop: false,
      log: [],
      finished_at: null,
    };
    jobs.set(id, job);
    pushLog(job, `старт: ${ids.length} фото · ${model}`);
    save(job, true);
    void run(job);
    return job;
  }

  async function run(job) {
    const queue = job.item_ids.map((itemId, idx) => ({ itemId, idx }));
    let cursor = 0;

    const worker = async () => {
      while (cursor < queue.length) {
        if (job.stop || job.removed) break;
        const slot = queue[cursor++];
        if (!slot) break;
        const { itemId, idx } = slot;
        try {
          pushLog(job, `[${idx + 1}/${job.item_ids.length}] ${itemId}`);
          const result = await describeOne({
            albumId: job.album_id,
            itemId,
            model: job.model,
            provider: job.provider,
            onNote: (msg) => pushLog(job, `  ${itemId}: ${msg}`),
          });
          job.results[idx] = { id: itemId, ok: true, ...result };
          job.ok += 1;
          const costRub = usageCostRub(result?.usage)
            ?? (typeof result?.usage?.cost === 'number' ? result.usage.cost : null);
          if (typeof costRub === 'number') job.cost += costRub;
          pushLog(job, `ok ${itemId}${typeof costRub === 'number' ? ` · ${costRub.toFixed(2)} ₽` : ''}`, 'ok');
        } catch (e) {
          const rawHint = e.raw ? ` · raw: ${String(e.raw).replace(/\s+/g, ' ').slice(0, 220)}` : '';
          job.results[idx] = { id: itemId, ok: false, error: e.message, raw: e.raw || null };
          job.err += 1;
          try {
            applyDescribeResult(job.album_id, itemId, { error: e.message + rawHint });
          } catch { /* */ }
          pushLog(job, `err ${itemId}: ${e.message}${rawHint}`, 'err');
        }
        job.done += 1;
        save(job);
      }
    };

    const n = Math.min(concurrency, job.item_ids.length);
    await Promise.all(Array.from({ length: n }, () => worker()));

    if (job.removed) return;
    job.status = job.stop ? 'stopped' : 'done';
    job.finished_at = now();
    pushLog(job, `готово: ok=${job.ok} err=${job.err}`, job.err ? 'warn' : 'ok');
    save(job, true);
  }

  function stop(id) {
    const job = jobs.get(id);
    if (!job) return false;
    job.stop = true;
    pushLog(job, 'остановка запрошена', 'warn');
    save(job, true);
    return true;
  }

  function restore() {
    if (!fs.existsSync(dir)) return 0;
    let n = 0;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const job = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
        if (!job?.id) continue;
        if (job.finished_at && now() - job.finished_at > ttlMs) {
          try { fs.unlinkSync(path.join(dir, name)); } catch { /* */ }
          continue;
        }
        jobs.set(job.id, job);
        if (job.status === 'running' && !job.finished_at) {
          // Не догоняем автоматически дорогие vision-прогоны после рестарта —
          // помечаем interrupted, чтобы не сжечь бюджет молча.
          job.status = 'interrupted';
          job.finished_at = now();
          pushLog(job, 'прерван перезапуском сервера', 'warn');
          save(job, true);
        }
        n += 1;
      } catch { /* */ }
    }
    return n;
  }

  return { create, get, list, state, summary, stop, remove, restore };
}

/** Обёртка одного фото для store — вызывается из server.js с провайдером. */
export async function describeAlbumItem({
  albumId, itemId, model, provider, onNote, describeImpl,
}) {
  const file = readPhotoFile(albumId, itemId);
  const result = await (describeImpl || describePhoto)(file, {
    model,
    provider,
    onNote,
  });
  const saved = applyDescribeResult(albumId, itemId, result);
  return { item: saved, usage: result.usage };
}
