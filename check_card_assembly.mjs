#!/usr/bin/env node
/**
 * Регресс сборки карточки на сохранённых JSON.
 *
 * Падает, если среди N последних записей есть:
 *   • web_info === ""  (должно быть null или непустая строка)
 *   • в description_html служебный дамп «В характеристиках:» / «Параметры модели:»
 *     / «По данным карточки:» / «Основные характеристики:»
 *
 *   node check_card_assembly.mjs [file.json|dir ...] [--last 50]
 *
 * В контейнере products_*.json часто нет: /api/export качает файл в браузер,
 * OUT_DIR=/data/out на томе может быть пустым. Без аргументов скрипт ищет
 * выгрузки, затем задачи в /data/jobs и прогоняет сборку (web_info + strip)
 * по последним enriched-ответам.
 */
import fs from 'node:fs';
import path from 'node:path';
import { catalogWebInfo } from './pipeline/export.js';
import { auditAssembledCards, stripHallucinationClaims } from './pipeline/quality_validate.js';

const PRODUCTS_NAME_RE = /^(?:products(?:_v2)?_\d+|products_all)\.json$/;
const SKIP_DIR_RE = /^(cache|photos|photo_jobs|node_modules|\.git)$/;

function parseArgs(argv) {
  let last = 50;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--last' || a === '-n') {
      last = Number(argv[++i]);
      if (!Number.isFinite(last) || last < 0) last = 50;
    } else if (!a.startsWith('-')) {
      files.push(a);
    }
  }
  return { last, files };
}

function isJobPayload(data) {
  return Boolean(
    data
    && typeof data === 'object'
    && Array.isArray(data.results)
    && Array.isArray(data.products),
  );
}

function rowsFromJob(data, source) {
  const rows = [];
  const results = data.results || [];
  const products = data.products || [];
  const indices = Array.isArray(data.indices) ? data.indices : null;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const enr = r?.enriched;
    if (!enr || typeof enr !== 'object' || Array.isArray(enr) || enr._truncated) continue;
    const prodIdx = indices?.[i] ?? i;
    const rec = products[prodIdx] || products[i] || r.product || {};
    const desc = enr.description_html || enr.description || '';
    rows.push({
      id: rec.id ?? enr.id ?? `${path.basename(source, '.json')}:${i}`,
      web_info: catalogWebInfo(enr, rec),
      description_html: stripHallucinationClaims(desc),
      _source: source,
    });
  }
  return rows;
}

function rowsFromPayload(data, source = '') {
  if (isJobPayload(data)) return rowsFromJob(data, source);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.products)) return data.products;
  if (Array.isArray(data?.results)) {
    return data.results.flatMap((r, i) => {
      const p = r?.product || r?.row || r;
      if (p && (p.description_html != null || 'web_info' in (p || {}))) return [p];
      if (r?.enriched && typeof r.enriched === 'object' && !Array.isArray(r.enriched)) {
        const desc = r.enriched.description_html || r.enriched.description || '';
        return [{
          id: r.enriched.id ?? data.products?.[i]?.id ?? i,
          web_info: catalogWebInfo(r.enriched, p || {}),
          description_html: stripHallucinationClaims(desc),
        }];
      }
      return [];
    });
  }
  return [];
}

function listDirNames(dir, { max = 24 } = {}) {
  try {
    const names = fs.readdirSync(dir).sort();
    if (names.length <= max) return names;
    return [...names.slice(0, max), `… ещё ${names.length - max}`];
  } catch (e) {
    return [`(не прочитать: ${e.code || e.message})`];
  }
}

function printInventory() {
  const roots = [
    process.env.OUT_DIR,
    '/data/out',
    process.env.JOBS_DIR,
    '/data/jobs',
    process.env.DUMPS_DIR,
    '/data/dumps',
    '/data',
    'out',
    'jobs',
    '.',
  ].filter(Boolean);
  const seen = new Set();
  console.error('что есть на диске:');
  for (const dir of roots) {
    const abs = path.resolve(dir);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!fs.existsSync(abs)) {
      console.error(`  ${abs}: нет`);
      continue;
    }
    const st = fs.statSync(abs);
    if (!st.isDirectory()) {
      console.error(`  ${abs}: файл`);
      continue;
    }
    console.error(`  ${abs}: ${listDirNames(abs).join(', ') || '(пусто)'}`);
  }
}

function walkJsonFiles(dir, { depth = 2, pred } = {}) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  const st = fs.statSync(dir);
  if (!st.isDirectory()) return pred(dir) ? [dir] : [];
  const stack = [{ dir, depth }];
  while (stack.length) {
    const cur = stack.pop();
    let names;
    try {
      names = fs.readdirSync(cur.dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const full = path.join(cur.dir, name);
      let child;
      try {
        child = fs.statSync(full);
      } catch {
        continue;
      }
      if (child.isDirectory()) {
        if (cur.depth <= 0 || SKIP_DIR_RE.test(name)) continue;
        stack.push({ dir: full, depth: cur.depth - 1 });
        continue;
      }
      if (child.isFile() && pred(full, name)) out.push(full);
    }
  }
  return out;
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function listProductFiles(dir) {
  return walkJsonFiles(dir, {
    depth: 2,
    pred: (_full, name) => PRODUCTS_NAME_RE.test(name),
  });
}

function listJobFiles(dir) {
  return walkJsonFiles(dir, {
    depth: 1,
    pred: (full, name) => name.endsWith('.json') && !name.endsWith('.tmp') && !PRODUCTS_NAME_RE.test(name),
  }).sort((a, b) => mtime(a) - mtime(b));
}

function uniqueFiles(files) {
  const seen = new Set();
  const out = [];
  for (const file of files) {
    const abs = path.resolve(file);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(file);
  }
  return out;
}

function expandTargets(inputs) {
  const out = [];
  for (const input of inputs) {
    if (!fs.existsSync(input)) {
      console.error(`нет файла: ${input}`);
      printInventory();
      console.error('укажите существующий JSON или каталог. В контейнере карточки обычно в /data/jobs, не в /data/out/products_523.json');
      process.exit(2);
    }
    const st = fs.statSync(input);
    if (st.isDirectory()) {
      const products = listProductFiles(input);
      const jobs = products.length ? [] : listJobFiles(input);
      const found = products.length ? products : jobs;
      if (!found.length) {
        console.error(`в ${input} нет products_*.json и job JSON`);
        printInventory();
        process.exit(2);
      }
      out.push(...found);
      continue;
    }
    out.push(input);
  }
  return uniqueFiles(out);
}

function defaultFiles() {
  const productDirs = [
    process.env.OUT_DIR,
    '/data/out',
    process.env.DUMPS_DIR,
    '/data/dumps',
    'out',
    '.',
  ].filter(Boolean);
  const jobDirs = [
    process.env.JOBS_DIR,
    '/data/jobs',
    'jobs',
  ].filter(Boolean);

  const seen = new Set();
  const products = [];
  for (const dir of productDirs) {
    const abs = path.resolve(dir);
    if (seen.has(abs)) continue;
    seen.add(abs);
    products.push(...listProductFiles(dir));
  }
  const productFiles = uniqueFiles(products).sort();
  if (productFiles.length) return { files: productFiles, kind: 'export' };

  const jobs = [];
  for (const dir of jobDirs) {
    const abs = path.resolve(dir);
    if (seen.has(abs)) continue;
    seen.add(abs);
    jobs.push(...listJobFiles(dir));
  }
  const jobFiles = uniqueFiles(jobs);
  return { files: jobFiles, kind: jobFiles.length ? 'jobs' : 'none' };
}

function collectRows(files) {
  const rows = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    for (const r of rowsFromPayload(data, file)) {
      if (r && typeof r === 'object') rows.push(r);
    }
  }
  return rows;
}

const { last, files } = parseArgs(process.argv.slice(2));
const discovered = files.length ? { files: expandTargets(files), kind: 'cli' } : defaultFiles();
const targets = discovered.files;
if (!targets.length) {
  console.error('нет сохранённых карточек: ни products_*.json, ни задач в /data/jobs');
  printInventory();
  process.exit(2);
}
console.log(`источник: ${discovered.kind}`);
console.log(`файлы: ${targets.join(', ')}`);

const rows = collectRows(targets);
const audit = auditAssembledCards(rows, { last });
console.log(`скан: ${audit.scanned} из ${rows.length} (last=${last})`);
if (audit.empty_web_info.length) {
  console.error(`web_info === "": ${audit.empty_web_info.join(', ')}`);
}
if (audit.spec_dump.length) {
  console.error(`дамп характеристик в description_html: ${audit.spec_dump.join(', ')}`);
}
if (!audit.ok) process.exit(1);
console.log('ok: web_info не пустая строка, служебного дампа specs нет');
