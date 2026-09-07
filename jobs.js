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
import { doneStatusLabel } from './lib.js';

const now = () => Date.now();
/** Сколько строк лога держим в задаче: хватает на длинный прогон, диск не раздуваем. */
const LOG_CAP = Number(process.env.JOBS_LOG_CAP || 4000);
/** Потолок одного текстового поля в деталях (промпт/ответ) — иначе jobs/*.json раздуваются. */
const DETAIL_TEXT_CAP = Number(process.env.JOBS_DETAIL_TEXT_CAP || 200_000);

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

  /**
   * Строка пошагового лога прогона. level: info | ok | warn | err | skip.
   * step — короткий код этапа (start, gate, web, model, retry, done…).
   */
  function pushLog(job, entry) {
    if (!Array.isArray(job.log)) job.log = [];
    const row = {
      t: now(),
      level: entry.level || 'info',
      step: entry.step || 'note',
      msg: String(entry.msg ?? ''),
    };
    if (entry.pos != null) row.pos = entry.pos;
    job.log.push(row);
    if (job.log.length > LOG_CAP) job.log.splice(0, job.log.length - LOG_CAP);
    // Горячий снимок для UI: даже без полного лога клиент видит текущий этап.
    job.live = {
      step: row.step,
      msg: row.msg,
      level: row.level,
      pos: row.pos ?? job.at_position ?? null,
      at: row.t,
    };
  }

  function clipText(s, cap = DETAIL_TEXT_CAP) {
    if (s == null) return null;
    const t = String(s);
    if (t.length <= cap) return t;
    return `${t.slice(0, cap)}\n… [обрезано, было ${t.length} символов]`;
  }

  /** Детали одного товара для раздела «Логи» — промпт, ответ, результат. */
  function truncateDetail(detail) {
    if (!detail || typeof detail !== 'object') return null;
    const out = { ...detail };
    for (const key of ['source_text', 'system_prompt', 'user_content', 'raw_response', 'error', 'skipped']) {
      if (out[key] != null) out[key] = clipText(out[key]);
    }
    if (out.enriched != null && typeof out.enriched === 'object') {
      const raw = JSON.stringify(out.enriched, null, 2);
      if (raw.length > DETAIL_TEXT_CAP) {
        out.enriched_text = clipText(raw);
        out.enriched = { _truncated: true };
      }
    } else if (typeof out.enriched === 'string') {
      out.enriched = clipText(out.enriched);
    }
    return out;
  }

  function storeDetail(job, k, detail) {
    if (!Array.isArray(job.details)) job.details = new Array(job.total).fill(null);
    const steps = (job.log || []).filter(e => e.pos === k);
    job.details[k] = truncateDetail({ ...(detail || {}), steps, pos: k });
    // Сразу на диск: иначе restart между debounce и flush теряет trace при уже
    // записанном results[k] (повторно товар не обогащается).
    save(job, true);
  }

  function detailSummary(d, k) {
    if (!d) return { pos: k, status: 'pending' };
    return {
      pos: k,
      status: d.status || (d.error ? 'error' : d.skipped ? 'skip' : d.needs_review || d.status === 'needs_review' ? 'needs_review' : d.enriched ? 'ok' : 'pending'),
      product: d.product || null,
      schema: d.schema || null,
      model: d.model || null,
      provider: d.provider || null,
      error: d.error || null,
      skipped: d.skipped || null,
      needs_review: Boolean(d.needs_review || d.status === 'needs_review'),
      validation_issues: d.validation_issues || null,
      source_url: d.source_url || null,
      parser: Boolean(d.parser || d.source_url),
      corrected: Boolean(d.corrected),
      model_status: d.model_status || null,
      model_called: d.model_called ?? null,
      has_source: Boolean(d.source_text),
      has_system: Boolean(d.system_prompt),
      has_user: Boolean(d.user_content),
      has_response: Boolean(d.raw_response),
      has_enriched: Boolean(d.enriched || d.enriched_text),
      usage: d.usage || null,
    };
  }

  function productLabel(p, pos) {
    if (!p || typeof p !== 'object') return `товар №${pos + 1}`;
    const name = p.name || p.title || null;
    const sku = p.sku != null ? String(p.sku) : (p.id != null ? String(p.id) : null);
    if (name && sku) return `${name} (арт. ${sku})`;
    return name || (sku ? `арт. ${sku}` : `товар №${pos + 1}`);
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
      id: job.id, at: job.at, model: job.model, provider: job.provider ?? null, category: job.category ?? null,
      status: job.status, total: job.total, done: job.done,
      started_at: job.started_at ?? null, finished_at: job.finished_at ?? null,
      error: job.error ?? null, note: job.note ?? null, usage: usageOf(job),
      at_position: job.at_position ?? -1,
      live: job.live ?? null,
    };
  }

  /**
   * Состояние задачи для интерфейса. from — сколько результатов у клиента уже
   * есть: результаты приходят по порядку очереди, поэтому хвоста достаточно, и
   * опрос раз в секунду не тащит по мегабайту одного и того же.
   * logFrom — то же для пошагового лога: клиент дописывает хвост, не весь журнал.
   * details=1 — краткие карточки товаров для раздела «Логи».
   * detailPos=N — полный пакет одного товара (промпт/ответ/результат).
   */
  function state(job, { from = 0, products = false, logFrom = 0, details = false, detailPos = null } = {}) {
    const at = Math.max(0, Math.min(Number(from) || 0, job.total));
    const log = Array.isArray(job.log) ? job.log : [];
    const lf = Math.max(0, Math.min(Number(logFrom) || 0, log.length));
    const det = Array.isArray(job.details) ? job.details : [];
    const out = {
      ...summary(job),
      indices: job.indices,
      from: at,
      results: job.results.slice(at),
      at_position: job.at_position,
      log_from: lf,
      log_total: log.length,
      log: log.slice(lf),
      ...(products ? { products: job.products } : {}),
    };
    if (details) {
      out.details = Array.from({ length: job.total }, (_, k) => {
        const d = det[k];
        if (d) return detailSummary(d, k);
        // Пока деталь ещё не записана — подпись из исходного товара.
        const p = job.products[k];
        return {
          pos: k,
          status: job.results[k]
            ? (job.results[k].error ? 'error' : job.results[k].skipped ? 'skip' : job.results[k].enriched ? 'ok' : 'pending')
            : (job.at_position === k ? 'running' : 'pending'),
          product: {
            name: p?.name || p?.title || null,
            sku: p?.sku != null ? String(p.sku) : null,
            id: p?.id != null ? String(p.id) : null,
          },
          label: productLabel(p, k),
        };
      });
    }
    if (detailPos != null && detailPos !== '') {
      const k = Math.max(0, Math.min(Number(detailPos) || 0, job.total - 1));
      const d = det[k] || null;
      out.detail_pos = k;
      out.detail = d
        ? { ...d, steps: d.steps || log.filter(e => e.pos === k) }
        : {
            pos: k,
            status: 'pending',
            product: {
              name: job.products[k]?.name || job.products[k]?.title || null,
              sku: job.products[k]?.sku != null ? String(job.products[k].sku) : null,
            },
            steps: log.filter(e => e.pos === k),
          };
    }
    return out;
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
    if (!Array.isArray(job.log)) job.log = [];
    job.live = null;
    const resumed = job.results.some(Boolean);
    pushLog(job, {
      level: 'info', step: 'job',
      msg: resumed
        ? `Продолжаем прогон: ${job.total} товаров, модель ${job.model}${job.provider ? `, ${job.provider}` : ''}`
        : `Старт прогона: ${job.total} товаров, модель ${job.model}${job.provider ? `, ${job.provider}` : ''}`,
    });
    save(job, true);
    log(`▶ job ${job.id}: ${job.total} товаров, модель ${job.model}`);

    for (let k = 0; k < job.total; k++) {
      if (job.stopping) {
        pushLog(job, { level: 'warn', step: 'stop', msg: `Остановка: осталось ${job.total - k} из ${job.total}` });
        break;
      }
      if (job.results[k]) continue;                    // возобновление после перезапуска
      job.at_position = k;
      const label = productLabel(job.products[k], k);
      pushLog(job, {
        level: 'info', step: 'item', pos: k,
        msg: `[${k + 1}/${job.total}] ${label}`,
      });
      save(job);
      try {
        const d = await enrichOne(job.products[k], {
          model: job.model, category: job.category, provider: job.provider,
          onNote: (msg, meta = {}) => {
            pushLog(job, {
              level: meta.level || 'info',
              step: meta.step || 'note',
              pos: k,
              msg: String(msg),
            });
            save(job);
          },
        });
        job.results[k] = {
          enriched: d.enriched ?? null,
          ...(d.skipped ? { skipped: d.skipped } : {}),
          ...(d.needs_review && !d.enriched ? { needs_review: true, validation_issues: d.validation_issues || [] } : {}),
          ...(d.source_url ? { source: d.source_url } : {}),
          ...(d.parser ? { parser: true } : {}),
          ...(d.corrected ? { corrected: true } : {}),
          iT:   d.usage?.prompt_tokens ?? 0,
          oT:   d.usage?.completion_tokens ?? 0,
          cost: typeof d.usage?.cost === 'number' ? d.usage.cost : null,
        };
        if (d.skipped) {
          pushLog(job, { level: 'skip', step: 'skip', pos: k, msg: `⊘ Пропуск: ${d.skipped}` });
        } else if (d.needs_review && !d.enriched) {
          const issues = (d.validation_issues || []).map(i => `${i.field}: ${i.reason}`).join('; ');
          const iT = d.usage?.prompt_tokens ?? 0;
          const oT = d.usage?.completion_tokens ?? 0;
          const cost = typeof d.usage?.cost === 'number' ? d.usage.cost : null;
          pushLog(job, {
            level: 'warn', step: 'needs_review', pos: k,
            msg: `⚠ needs_review · ${issues || 'валидация'}`
              + ` · in=${iT} out=${oT}`
              + (cost != null ? ` · $${cost.toFixed(5)}` : '')
              + (d.usage?.attempts ? ` · попыток ${d.usage.attempts}` : ''),
          });
        } else {
          const iT = d.usage?.prompt_tokens ?? 0;
          const oT = d.usage?.completion_tokens ?? 0;
          const cost = typeof d.usage?.cost === 'number' ? d.usage.cost : null;
          const attempts = d.usage?.attempts;
          const mark = doneStatusLabel({
            parser: Boolean(d.parser || d.source_url),
            corrected: Boolean(d.corrected),
          });
          const pretty = mark.charAt(0).toUpperCase() + mark.slice(1);
          pushLog(job, {
            level: 'ok', step: 'done', pos: k,
            msg: `✓ ${pretty} · in=${iT} out=${oT}`
              + (cost != null ? ` · $${cost.toFixed(5)}` : '')
              + (attempts > 1 ? ` · попыток ${attempts}` : '')
              + (d.source_url ? ` · источник ${d.source_url}` : ''),
          });
        }
        storeDetail(job, k, d.detail || {
          product: { name: job.products[k]?.name || null, sku: job.products[k]?.sku != null ? String(job.products[k].sku) : null },
          status: d.skipped ? 'skip' : (d.needs_review && !d.enriched) ? 'needs_review' : 'ok',
          skipped: d.skipped || null,
          needs_review: Boolean(d.needs_review && !d.enriched),
          validation_issues: d.validation_issues || null,
          enriched: d.enriched ?? null,
          usage: d.usage || null,
          raw_response: d.detail?.raw_response ?? null,
          ...(d.source_url ? { source_url: d.source_url } : {}),
          ...(d.parser ? { parser: true } : {}),
          ...(d.corrected ? { corrected: true } : {}),
        });
      } catch (e) {
        // Провал одного товара не отменяет прогон — ровно как в браузере.
        // Неудачные попытки оплачены, поэтому usage сохраняем и на ошибке.
        job.results[k] = {
          enriched: null, error: e.message,
          iT: e.usage?.iT ?? 0, oT: e.usage?.oT ?? 0,
          cost: typeof e.usage?.cost === 'number' ? e.usage.cost : null,
        };
        pushLog(job, { level: 'err', step: 'error', pos: k, msg: `✗ Ошибка: ${e.message}` });
        storeDetail(job, k, e.detail || {
          product: { name: job.products[k]?.name || null, sku: job.products[k]?.sku != null ? String(job.products[k].sku) : null },
          status: 'error',
          error: e.message,
          usage: e.usage
            ? { prompt_tokens: e.usage.iT ?? 0, completion_tokens: e.usage.oT ?? 0, cost: e.usage.cost ?? 0 }
            : null,
        });
      }
      job.done = job.results.filter(Boolean).length;
      save(job);
    }

    if (job.stopping) job.status = 'stopped';
    else if (job.status === 'running') job.status = 'done';
    job.finished_at = now();
    job.at_position = -1;
    const u = usageOf(job);
    pushLog(job, {
      level: job.status === 'error' ? 'err' : (job.status === 'stopped' ? 'warn' : 'ok'),
      step: 'finish',
      msg: `Итог: ${job.status} · готово ${u.ok}, пропущено ${u.skip}, ошибок ${u.err}, $${u.cost.toFixed(5)}`,
    });
    // После финиша live не должен выглядеть как «ещё идёт».
    job.live = {
      step: 'finish',
      msg: job.status === 'done' ? 'Прогон завершён' : `Прогон: ${job.status}`,
      level: job.status === 'error' ? 'err' : (job.status === 'stopped' ? 'warn' : 'ok'),
      pos: null,
      at: now(),
    };
    save(job, true);
    log(`■ job ${job.id}: ${job.status}, готово ${u.ok}, пропущено ${u.skip}, ошибок ${u.err}, $${u.cost.toFixed(5)}`);
  }

  /**
   * Новая задача. Товары приходят из интерфейса уже отфильтрованными, вместе с
   * их индексами в списке — обратная дорога результата к строке на экране.
   */
  function create({ model, category, products, indices, provider }) {
    prune();
    const job = {
      id: crypto.randomUUID(),
      at: now(),
      model,
      provider: provider || null,
      category: category ?? null,
      status: 'queued',
      total: products.length,
      done: 0,
      at_position: -1,
      indices: indices?.length === products.length ? indices : products.map((_, i) => i),
      products,
      results: new Array(products.length).fill(null),
      details: new Array(products.length).fill(null),
      log: [],
    };
    jobs.set(job.id, job);
    // Прогон не ждёт ответа на запрос: клиент получает id и опрашивает прогресс.
    runJob(job).catch(e => {
      job.status = 'error';
      job.error = e.message;
      job.finished_at = now();
      pushLog(job, { level: 'err', step: 'fail', msg: `Прогон упал: ${e.message}` });
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
      job.details = Array.isArray(job.details) ? job.details : [];
      while (job.details.length < job.products.length) job.details.push(null);
      job.log = Array.isArray(job.log) ? job.log : [];
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
