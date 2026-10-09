/**
 * Фоновые прогоны описания фото — по тому же принципу, что jobs.js:
 * браузер ставит задачу, сервер крутит цикл и пишет прогресс на диск.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  getAlbumJobIndex, readPhotoFile, applyDescribeResult, PHOTO_LIMITS,
} from './photos.js';
import { describePhoto } from './photo_agent.js';
import { usageCostRub } from './provider_billing.js';

const now = () => Date.now();
const LOG_CAP = 2000;
export const PHOTO_JOB_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.PHOTO_JOB_CONCURRENCY || 2)));
export const PHOTO_JOB_MAX_CONSEC_ERR = Math.max(
  1,
  Math.min(100, Number(process.env.PHOTO_JOB_MAX_CONSEC_ERR || 15)),
);
/** Один товар: скачивание + vision. Без этого stop/зависание сети держат job вечно на 0/N. */
export const PHOTO_JOB_ITEM_TIMEOUT_MS = Math.max(
  30_000,
  Math.min(600_000, Number(process.env.PHOTO_JOB_ITEM_TIMEOUT_MS || 150_000)),
);
/** После Стоп ждём in-flight, затем принудительно closed. */
export const PHOTO_JOB_STOP_GRACE_MS = Math.max(
  3_000,
  Math.min(120_000, Number(process.env.PHOTO_JOB_STOP_GRACE_MS || 20_000)),
);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(label || `таймаут ${ms}ms`), { status: 504, timeout: true }));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const DESCRIBED = new Set(['described', 'ready']);
const PENDING = new Set(['uploaded', 'error']);

/** Ошибки скачивания фида — не копят consecutive (шлюз может быть жив). */
export function isFeedFetchError(err) {
  const msg = String(err?.message || err || '');
  return /изображение недоступно|файл на диске не найден|файл слишком|содержимое не JPEG|по ссылке не картинка|товар пропущен|таймаут фото/i.test(msg);
}

function parseMaxCost(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function createPhotoJobStore({
  describeOne,
  dir = process.env.PHOTO_JOBS_DIR || 'photo_jobs',
  ttlMs = Number(process.env.PHOTO_JOBS_TTL_MS || 7 * 24 * 3600_000),
  concurrency = PHOTO_JOB_CONCURRENCY,
  maxConsecutiveErrors = PHOTO_JOB_MAX_CONSEC_ERR,
  itemTimeoutMs = PHOTO_JOB_ITEM_TIMEOUT_MS,
  stopGraceMs = PHOTO_JOB_STOP_GRACE_MS,
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
      skipped: job.skipped || 0,
      cost: job.cost,
      max_cost_rub: job.max_cost_rub ?? null,
      stop_reason: job.stop_reason || null,
      current_id: job.current_id || null,
      heartbeat_at: job.heartbeat_at || null,
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

  function loadFromDisk(id) {
    try {
      const job = JSON.parse(fs.readFileSync(file(id), 'utf-8'));
      return job?.id ? job : null;
    } catch {
      return null;
    }
  }

  function get(id) {
    const mem = jobs.get(id) || null;
    if (!mem) return loadFromDisk(id);
    // results срезаны при restore — подтянуть с диска для опроса UI
    if (mem._results_on_disk && !Array.isArray(mem.results)) {
      const disk = loadFromDisk(id);
      if (disk) {
        mem.results = disk.results;
        mem.log = disk.log;
        mem._results_on_disk = false;
      }
    }
    return mem;
  }

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

  /**
   * Выбор id для прогона.
   * - без item_ids → только uploaded|error; пусто → 400 (не переописываем всё).
   * - с item_ids → без force пропускаем already described/ready.
   */
  function resolveItemIds(album, item_ids, force) {
    const byId = new Map(album.items.map(i => [i.id, i]));
    let ids;
    let skipped = 0;

    if (Array.isArray(item_ids) && item_ids.length) {
      ids = [];
      for (const raw of item_ids.map(String)) {
        const item = byId.get(raw);
        if (!item) continue;
        if (!force && DESCRIBED.has(item.status)) {
          skipped += 1;
          continue;
        }
        ids.push(raw);
      }
      if (!ids.length) {
        throw Object.assign(
          new Error(skipped
            ? 'Выбранные фото уже описаны — передайте force:true для переописания'
            : 'Среди выбранных нет фото альбома'),
          { status: 400 },
        );
      }
    } else {
      ids = album.items.filter(i => PENDING.has(i.status)).map(i => i.id);
      if (!ids.length) {
        throw Object.assign(
          new Error('Нечего описывать: нет фото со статусом uploaded/error'),
          { status: 400 },
        );
      }
    }
    return { ids, skipped };
  }

  /** Идущий прогон по альбому — для UI после reload и запрета второго старта. */
  function activeForAlbum(albumId) {
    const aid = String(albumId || '');
    if (!aid) return null;
    for (const job of jobs.values()) {
      if (job.album_id === aid && job.status === 'running' && !job.finished_at && !job.removed) {
        return job;
      }
    }
    return null;
  }

  function create({
    album_id,
    model,
    provider = null,
    item_ids = null,
    force = false,
    max_cost_rub = null,
    balance_rub = null,
  }) {
    if (!album_id) throw Object.assign(new Error('Нет album_id'), { status: 400 });
    if (!model) throw Object.assign(new Error('Нет модели'), { status: 400 });

    const live = activeForAlbum(album_id);
    if (live) {
      throw Object.assign(
        new Error(`Уже идёт прогон ${live.id} (${live.done}/${live.item_ids.length}) — закройте страницу: он продолжит; Стоп — чтобы остановить`),
        { status: 409, job_id: live.id },
      );
    }

    // Индекс id+status — не publicAlbum со всеми description (OOM / 502 на 15k).
    const album = getAlbumJobIndex(album_id);
    const { ids, skipped } = resolveItemIds(album, item_ids, Boolean(force));
    if (ids.length > PHOTO_LIMITS.MAX_ITEMS) {
      throw Object.assign(new Error('Слишком много фото'), { status: 400 });
    }

    const costCap = parseMaxCost(max_cost_rub);
    const bal = typeof balance_rub === 'number' && Number.isFinite(balance_rub) ? balance_rub : null;

    if (bal != null && bal <= 0) {
      throw Object.assign(new Error('Баланс AITUNNEL пуст — пополнение перед прогоном'), { status: 402 });
    }

    const id = crypto.randomBytes(6).toString('hex');
    const job = {
      id,
      at: now(),
      album_id,
      model,
      provider,
      force: Boolean(force),
      item_ids: ids,
      results: ids.map(() => null),
      done: 0,
      ok: 0,
      err: 0,
      skipped,
      cost: 0,
      max_cost_rub: costCap,
      consecutive_err: 0,
      max_consecutive_errors: maxConsecutiveErrors,
      stop_reason: null,
      status: 'running',
      stop: false,
      log: [],
      finished_at: null,
    };
    jobs.set(id, job);
    pushLog(job, `старт: ${ids.length} фото · ${model}${skipped ? ` · skip ${skipped} уже описанных` : ''}`);
    pushLog(job, 'фон: закрытие вкладки не останавливает прогон — Стоп или конец очереди');
    if (costCap != null) pushLog(job, `лимит бюджета: ${costCap} ₽`);
    if (bal != null) {
      pushLog(job, `баланс AITUNNEL: ${bal} ₽`);
      if (costCap != null && bal < costCap) {
        pushLog(job, `баланс (${bal} ₽) ниже лимита прогона (${costCap} ₽)`, 'warn');
      }
    }
    save(job, true);
    void run(job);
    return job;
  }

  function requestStop(job, reason) {
    job.stop = true;
    job.stop_reason = reason;
    pushLog(job, reason, 'warn');
    save(job, true);
  }

  function finalizeJob(job, status) {
    if (job.finished_at || job.removed) return;
    job.status = status;
    job.finished_at = now();
    const reason = job.stop_reason ? ` · ${job.stop_reason}` : '';
    pushLog(
      job,
      `готово: ok=${job.ok} err=${job.err}${job.skipped ? ` skip=${job.skipped}` : ''}${reason}`,
      job.err || job.stop || status === 'stopped' ? 'warn' : 'ok',
    );
    save(job, true);
  }

  async function run(job) {
    const queue = job.item_ids.map((itemId, idx) => ({ itemId, idx }));
    let cursor = 0;
    const itemTimeout = itemTimeoutMs;

    const worker = async () => {
      while (cursor < queue.length) {
        if (job.stop || job.removed || job.finished_at) break;

        if (job.max_cost_rub != null && job.cost >= job.max_cost_rub) {
          if (!job.stop) requestStop(job, `лимит бюджета ${job.max_cost_rub} ₽`);
          break;
        }

        const slot = queue[cursor++];
        if (!slot) break;
        const { itemId, idx } = slot;
        job.current_id = itemId;
        job.heartbeat_at = now();
        try {
          pushLog(job, `[${idx + 1}/${job.item_ids.length}] ${itemId}`);
          save(job);
          const result = await withTimeout(
            describeOne({
              albumId: job.album_id,
              itemId,
              model: job.model,
              provider: job.provider,
              onNote: (msg) => pushLog(job, `  ${itemId}: ${msg}`),
            }),
            itemTimeout,
            `таймаут фото ${Math.round(itemTimeout / 1000)}с (${itemId})`,
          );
          if (job.finished_at || job.removed) return;
          job.results[idx] = { id: itemId, ok: true, ...result };
          job.ok += 1;
          job.consecutive_err = 0;
          const costRub = usageCostRub(result?.usage)
            ?? (typeof result?.usage?.cost === 'number' ? result.usage.cost : null);
          if (typeof costRub === 'number') job.cost += costRub;
          pushLog(job, `ok ${itemId}${typeof costRub === 'number' ? ` · ${costRub.toFixed(2)} ₽` : ''}`, 'ok');

          if (job.max_cost_rub != null && job.cost >= job.max_cost_rub) {
            requestStop(job, `лимит бюджета ${job.max_cost_rub} ₽ (набрано ${job.cost.toFixed(2)} ₽)`);
          }
        } catch (e) {
          if (job.finished_at || job.removed) return;
          const rawHint = e.raw ? ` · raw: ${String(e.raw).replace(/\s+/g, ' ').slice(0, 220)}` : '';
          job.results[idx] = { id: itemId, ok: false, error: e.message, raw: e.raw || null };
          job.err += 1;
          try {
            await applyDescribeResult(job.album_id, itemId, { error: e.message + rawHint });
          } catch { /* */ }
          pushLog(job, `err ${itemId}: ${e.message}${rawHint}`, 'err');

          if (isFeedFetchError(e) || e.timeout) {
            job.consecutive_err = 0;
          } else {
            job.consecutive_err = (job.consecutive_err || 0) + 1;
            const cap = job.max_consecutive_errors || maxConsecutiveErrors;
            if (job.consecutive_err >= cap) {
              requestStop(job, `стоп: ${cap} ошибок API/сети подряд`);
            }
          }
        }
        if (job.finished_at || job.removed) return;
        job.done += 1;
        job.current_id = null;
        job.heartbeat_at = now();
        save(job);
      }
    };

    const n = Math.min(concurrency, job.item_ids.length);
    const workersDone = Promise.all(Array.from({ length: n }, () => worker()));

    // Стоп при зависшем describeOne раньше ждал вечно → UI «running · остановка запрошена · 0/N».
    const stopWatch = (async () => {
      while (!job.finished_at && !job.removed) {
        await sleep(1000);
        if (!job.stop) continue;
        await sleep(stopGraceMs);
        if (!job.finished_at && !job.removed) {
          pushLog(job, `принудительная остановка после ${Math.round(stopGraceMs / 1000)}с ожидания`, 'warn');
          return 'force-stop';
        }
      }
      return 'ended';
    })();

    const outcome = await Promise.race([
      workersDone.then(() => 'workers'),
      stopWatch,
    ]);

    if (job.removed) return;
    if (outcome === 'force-stop') {
      finalizeJob(job, 'stopped');
      return;
    }
    await workersDone.catch(() => {});
    finalizeJob(job, job.stop ? 'stopped' : 'done');
  }

  function stop(id) {
    const job = jobs.get(id) || loadFromDisk(id);
    if (!job) return false;
    jobs.set(job.id, job);
    if (job.finished_at) return true;
    job.stop = true;
    job.stop_reason = job.stop_reason || 'остановка запрошена';
    job.stop_at = now();
    pushLog(job, 'остановка запрошена', 'warn');
    save(job, true);
    // Если воркеры уже мертвы (рестарт UI / зависший await) — закроем сами.
    setTimeout(() => {
      const live = jobs.get(id);
      if (live && !live.finished_at && live.stop) {
        pushLog(live, 'стоп: воркеры не ответили — закрываю job', 'warn');
        finalizeJob(live, 'stopped');
      }
    }, stopGraceMs + 500);
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
        if (job.status === 'running' && !job.finished_at) {
          // Не догоняем автоматически дорогие vision-прогоны после рестарта —
          // помечаем interrupted, чтобы не сжечь бюджет молча.
          job.status = 'interrupted';
          job.finished_at = now();
          job.stop_reason = job.stop_reason || 'прерван перезапуском сервера';
          pushLog(job, 'прерван перезапуском сервера', 'warn');
          save(job, true);
        }
        // Законченные прогоны на 5k+ results не держим в RAM — список/summary хватает;
        // state() при запросе перечитает файл с диска при необходимости.
        if (job.finished_at && Array.isArray(job.results) && job.results.length > 200) {
          job.results = undefined;
          if (Array.isArray(job.log) && job.log.length > 100) {
            job.log = job.log.slice(-100);
          }
          job._results_on_disk = true;
        }
        jobs.set(job.id, job);
        n += 1;
      } catch { /* */ }
    }
    return n;
  }

  return { create, get, list, state, summary, stop, remove, restore, resolveItemIds, activeForAlbum };
}

/** Обёртка одного фото для store — вызывается из server.js с провайдером. */
export async function describeAlbumItem({
  albumId, itemId, model, provider, onNote, describeImpl,
}) {
  const file = await readPhotoFile(albumId, itemId);
  const result = await (describeImpl || describePhoto)(file, {
    model,
    provider,
    onNote,
  });
  const saved = await applyDescribeResult(albumId, itemId, result);
  return { item: saved, usage: result.usage };
}
