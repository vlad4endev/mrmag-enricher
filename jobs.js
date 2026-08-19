/**
 * jobs.js — прогон обогащения живёт на сервере, а не во вкладке браузера.
 *
 * Раньше цикл по товарам крутил index_final.html: закрытая вкладка, спящий
 * ноутбук или потерянный wifi обрывали работу на середине, и уже оплаченные
 * товары приходилось прогонять заново. Теперь браузер только ставит задачу и
 * спрашивает прогресс — считает сервер.
 *
 * Задача пишется на диск после каждого товара (JOBS_DIR, по умолчанию ./jobs),
 * поэтому:
 *   • вкладку можно закрыть — прогон идёт дальше;
 *   • можно зайти с другого браузера и увидеть тот же прогресс (GET /api/jobs);
 *   • перезапуск сервера (docker restart, деплой) не теряет результаты и
 *     доводит незаконченную задачу с того товара, на котором остановился.
 *
 * Форма задачи на диске:
 *   { id, at, model, category, status, indices, products, results, done, ... }
 * results[k] соответствует indices[k] — индексу товара в списке интерфейса.
 * Позиция без ответа остаётся null: прогон бывает частичным.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const now = () => Date.now();

export function createJobStore({
  enrichOne,
  dir = process.env.JOBS_DIR || 'jobs',
  // Неделя: столько живёт результат, за который заплатили и который могли не
  // успеть выгрузить. Дальше он мусор.
  ttlMs = Number(process.env.JOBS_TTL_MS || 7 * 24 * 3600_000),
  log = console.log,
} = {}) {
  const jobs = new Map();
  const file = id => path.join(dir, `${id}.json`);

  fs.mkdirSync(dir, { recursive: true });

  // Диск — журнал, а не хранилище на горячем пути: пишем не чаще раза в
  // секунду, но конец задачи и остановку фиксируем сразу.
  // ponytail: если задач станет много, писать только дельту результатов.
  const pending = new Map();

  function flush(job) {
    pending.delete(job.id);
    if (job.removed) return;                 // файл уже удалён — не воскрешаем
    job.saved_at = now();
    const tmp = `${file(job.id)}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(job));
      fs.renameSync(tmp, file(job.id));
    } catch (e) {
      // Потеря журнала не должна ронять прогон: он важнее записи.
      log(`⚠ job ${job.id}: не записан на диск — ${e.message}`);
    }
  }

  function save(job, immediate = false) {
    if (immediate) {
      const t = pending.get(job.id);
      if (t) clearTimeout(t);
      return flush(job);
    }
    if (pending.has(job.id)) return;
    pending.set(job.id, setTimeout(() => flush(job), 1000));
  }

  /** Итог по задаче: то же, что подвал интерфейса считает по результатам. */
  function usageOf(job) {
    let prompt_tokens = 0, completion_tokens = 0, cost = 0, ok = 0, err = 0, skip = 0;
    for (const r of job.results) {
      if (!r) continue;
      prompt_tokens     += r.iT   || 0;
      completion_tokens += r.oT   || 0;
      cost              += r.cost || 0;
      if (r.enriched) ok++; else if (r.skipped) skip++; else err++;
    }
    return { prompt_tokens, completion_tokens, cost, ok, err, skip };
  }

  function summary(job) {
    return {
      id: job.id, at: job.at, model: job.model, category: job.category ?? null,
      status: job.status, total: job.total, done: job.done,
      started_at: job.started_at ?? null, finished_at: job.finished_at ?? null,
      error: job.error ?? null, note: job.note ?? null, usage: usageOf(job),
    };
  }

  /**
   * Состояние задачи для интерфейса. from — сколько результатов у клиента уже
   * есть: результаты приходят по порядку очереди, поэтому хвоста достаточно, и
   * опрос раз в секунду не тащит по мегабайту одного и того же.
   */
  function state(job, { from = 0, products = false } = {}) {
    const at = Math.max(0, Math.min(Number(from) || 0, job.total));
    return {
      ...summary(job),
      indices: job.indices,
      from: at,
      results: job.results.slice(at),
      ...(products ? { products: job.products } : {}),
    };
  }

  function get(id)  { return jobs.get(id) || null; }
  function list()   {
    return [...jobs.values()].sort((a, b) => b.at - a.at).map(summary);
  }

  /**
   * Остановка после текущего товара. Статус меняет сам прогон, когда выйдет из
   * цикла: иначе клиент увидел бы «остановлен» раньше, чем придёт результат
   * товара, который уже оплачен и вот-вот допишется.
   */
  function stop(job, reason = 'остановлен') {
    if (job.status !== 'running' && job.status !== 'queued') return summary(job);
    job.stopping = true;
    job.note = reason;
    save(job, true);
    return summary(job);
  }

  function remove(id) {
    const job = jobs.get(id);
    if (!job) return false;
    job.removed = true;
    if (job.status === 'running') stop(job, 'удалён пользователем');
    jobs.delete(id);
    try { fs.unlinkSync(file(id)); } catch { /* уже нет — и хорошо */ }
    return true;
  }

  /** Задачи старше ttlMs выкидываем: результат уже не нужен никому. */
  function prune() {
    for (const job of [...jobs.values()]) {
      if (job.status !== 'running' && now() - (job.finished_at || job.at) > ttlMs) remove(job.id);
    }
  }

  async function runJob(job) {
    job.status = 'running';
    job.stopping = false;
    job.error = null;
    job.note = null;
    job.started_at = job.started_at || now();
    save(job, true);
    log(`▶ job ${job.id}: ${job.total} товаров, модель ${job.model}`);

    for (let k = 0; k < job.total; k++) {
      if (job.stopping) break;
      if (job.results[k]) continue;                    // возобновление после перезапуска
      job.at_position = k;
      try {
        const d = await enrichOne(job.products[k], { model: job.model, category: job.category });
        job.results[k] = {
          enriched: d.enriched ?? null,
          ...(d.skipped ? { skipped: d.skipped } : {}),
          ...(d.source_url ? { source: d.source_url } : {}),
          iT:   d.usage?.prompt_tokens ?? 0,
          oT:   d.usage?.completion_tokens ?? 0,
          cost: typeof d.usage?.cost === 'number' ? d.usage.cost : 0,
        };
      } catch (e) {
        // Провал одного товара не отменяет прогон — ровно как в браузере.
        // Неудачные попытки оплачены, поэтому usage сохраняем и на ошибке.
        job.results[k] = {
          enriched: null, error: e.message,
          iT: e.usage?.iT ?? 0, oT: e.usage?.oT ?? 0, cost: e.usage?.cost ?? 0,
        };
      }
      job.done = job.results.filter(Boolean).length;
      save(job);
    }

    if (job.stopping) job.status = 'stopped';
    else if (job.status === 'running') job.status = 'done';
    job.finished_at = now();
    job.at_position = -1;
    save(job, true);
    const u = usageOf(job);
    log(`■ job ${job.id}: ${job.status}, готово ${u.ok}, пропущено ${u.skip}, ошибок ${u.err}, $${u.cost.toFixed(5)}`);
  }

  /**
   * Новая задача. Товары приходят из интерфейса уже отфильтрованными, вместе с
   * их индексами в списке — обратная дорога результата к строке на экране.
   */
  function create({ model, category, products, indices }) {
    prune();
    const job = {
      id: crypto.randomUUID(),
      at: now(),
      model,
      category: category ?? null,
      status: 'queued',
      total: products.length,
      done: 0,
      at_position: -1,
      indices: indices?.length === products.length ? indices : products.map((_, i) => i),
      products,
      results: new Array(products.length).fill(null),
    };
    jobs.set(job.id, job);
    // Прогон не ждёт ответа на запрос: клиент получает id и опрашивает прогресс.
    runJob(job).catch(e => {
      job.status = 'error';
      job.error = e.message;
      job.finished_at = now();
      save(job, true);
      log(`✗ job ${job.id}: ${e.message}`);
    });
    return job;
  }

  /**
   * Восстановление с диска при старте. Задача, которую прервал перезапуск,
   * доводится с того товара, на котором остановилась: результаты уже оплачены.
   */
  function restore() {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }
    const resumed = [];
    for (const f of files) {
      let job;
      try { job = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch { continue; }
      if (!job?.id || !Array.isArray(job.products)) continue;
      job.results = Array.isArray(job.results) ? job.results : [];
      job.done = job.results.filter(Boolean).length;
      jobs.set(job.id, job);
      if (job.status === 'running' || job.status === 'queued') {
        resumed.push(job.id);
        runJob(job).catch(e => { job.status = 'error'; job.error = e.message; save(job, true); });
      }
    }
    prune();
    return resumed;
  }

  return { create, get, list, state, stop, remove, restore, summary, usageOf, jobs };
}
