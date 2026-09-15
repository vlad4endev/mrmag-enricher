/**
 * Фоновые прогоны доводки — отдельно от jobs.js обогащения и photo_jobs.
 * Браузер ставит задачу, сервер крутит анализ и ремонт, прогресс на диске.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ingestPack } from './ingest.js';
import { auditPack } from './audit.js';
import { repairPack } from './repair.js';

const now = () => Date.now();
const LOG_CAP = 2000;
export const REFINE_JOB_CONCURRENCY = 1;

export function createRefineJobStore({
  dir = process.env.REFINE_JOBS_DIR || 'refine_jobs',
  ttlMs = Number(process.env.REFINE_JOBS_TTL_MS || 7 * 24 * 3600_000),
  log = console.log,
  root = '.',
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
      const slim = persistable(job);
      fs.writeFileSync(tmp, JSON.stringify(slim));
      fs.renameSync(tmp, file(job.id));
    } catch (e) {
      log(`⚠ refine-job ${job.id}: не записан — ${e.message}`);
    }
  }

  function persistable(job) {
    const copy = { ...job };
    delete copy._pack;
    return copy;
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
      status: job.status,
      kind: 'refine',
      category: job.category,
      shape: job.shape,
      total: job.total,
      done: job.done,
      lookup: Boolean(job.lookup),
      at: job.at,
      finished_at: job.finished_at || null,
      stop: Boolean(job.stop),
      error: job.error || null,
      report: job.report || null,
    };
  }

  function state(job, { from = 0, logFrom = 0, files = 0 } = {}) {
    const lf = Math.max(0, Number(logFrom) || 0);
    const out = {
      ...summary(job),
      audit: job.audit || null,
      log: (job.log || []).slice(lf),
      log_from: lf,
    };
    if (files || job.status === 'done') {
      out.files = job.files || null;
      out.validation = job.validation || null;
      out.after = job.after || null;
    }
    return out;
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

  function create({ products, filters = null, filenames = [], category = null, lookup = true }) {
    const id = crypto.randomBytes(6).toString('hex');
    const job = {
      id,
      at: now(),
      kind: 'refine',
      products,
      filters,
      filenames,
      category_hint: category,
      lookup: lookup !== false,
      total: Array.isArray(products) ? products.length : 0,
      done: 0,
      status: 'running',
      stop: false,
      log: [],
      finished_at: null,
      files: null,
      audit: null,
      report: null,
      error: null,
    };
    jobs.set(id, job);
    pushLog(job, `старт доводки: ${job.total} товаров`);
    save(job, true);
    void run(job);
    return job;
  }

  async function run(job) {
    try {
      if (onProgressSafe(job, { step: 'ingest', msg: 'разбор файлов' })) return;
      const pack = ingestPack({
        products: job.products,
        filters: job.filters,
        filenames: job.filenames,
        category: job.category_hint,
        root,
      });
      job.category = pack.category;
      job.shape = pack.shape;
      job.total = pack.recs.length;
      job._pack = pack;
      if (onProgressSafe(job, { step: 'audit', msg: 'анализ карточек' })) return;
      job.audit = slimAudit(auditPack(pack));
      pushLog(job, `категория ${pack.category.id} · лишнего ${job.audit.summary.extra} · дыр ${job.audit.summary.missing_required}`);
      save(job);

      if (onProgressSafe(job, { step: 'repair', msg: 'доработка' })) return;
      const result = await repairPack(pack, {
        lookup: job.lookup,
        onProgress: (p) => {
          if (p.done != null) job.done = p.done;
          pushLog(job, p.msg || p.step);
          save(job);
        },
      });
      if (job.stop || job.removed) {
        job.status = 'stopped';
        job.finished_at = now();
        save(job, true);
        return;
      }
      job.files = result.files;
      job.validation = result.validation;
      job.after = slimAudit(result.after);
      job.report = result.report;
      job.done = job.total;
      job.status = 'done';
      job.finished_at = now();
      delete job.products;
      delete job.filters;
      delete job._pack;
      pushLog(job, `готово: срезано ${result.report.stripped}, добрано обязательных ${result.report.filled_required}`, 'ok');
      save(job, true);
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      job.finished_at = now();
      pushLog(job, e.message, 'err');
      save(job, true);
    }
  }

  function onProgressSafe(job, entry) {
    if (job.stop || job.removed) {
      job.status = 'stopped';
      job.finished_at = now();
      save(job, true);
      return true;
    }
    pushLog(job, entry.msg || entry.step);
    save(job);
    return false;
  }

  function slimAudit(audit) {
    return {
      category: audit.category,
      shape: audit.shape,
      products_total: audit.products_total,
      summary: audit.summary,
      filters_file: audit.filters_file,
      expected: audit.expected,
      items: (audit.items || []).map(i => ({
        id: i.id,
        name: i.name,
        status: i.status,
        extra: i.extra,
        missing: i.missing.filter(m => m.required).concat(i.missing.filter(m => !m.required).slice(0, 8)),
        issues: i.issues.slice(0, 12),
        filled: i.filled,
        annotation_rows: i.annotation_rows,
      })),
    };
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

  function stop(id) {
    const job = jobs.get(id);
    if (!job) return false;
    job.stop = true;
    pushLog(job, 'остановка запрошена', 'warn');
    save(job, true);
    return true;
  }

  return { create, get, list, state, summary, stop, remove, restore };
}
