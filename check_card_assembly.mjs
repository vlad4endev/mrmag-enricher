#!/usr/bin/env node
/**
 * Регресс сборки карточки на сохранённых JSON.
 *
 * Падает, если среди N последних записей есть:
 *   • web_info === ""  (должно быть null или непустая строка)
 *   • в description_html служебный дамп «В характеристиках:» / «Параметры модели:»
 *     / «По данным карточки:» / «Основные характеристики:»
 *
 *   node check_card_assembly.mjs [file.json ...] [--last 50]
 */
import fs from 'node:fs';
import path from 'node:path';
import { auditAssembledCards } from './pipeline/quality_validate.js';

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

function rowsFromPayload(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.products)) return data.products;
  if (Array.isArray(data?.results)) {
    return data.results.flatMap((r, i) => {
      const p = r?.product || r?.row || r;
      if (p && (p.description_html != null || 'web_info' in (p || {}))) return [p];
      if (r?.enriched && r.enriched.description_html != null) {
        return [{ id: r.enriched.id ?? data.products?.[i]?.id ?? i, ...r.enriched }];
      }
      return [];
    });
  }
  return [];
}

function collectRows(files) {
  const rows = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    for (const r of rowsFromPayload(data)) {
      if (r && typeof r === 'object') rows.push(r);
    }
  }
  return rows;
}

function listProductFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const st = fs.statSync(dir);
  if (!st.isDirectory()) return [];
  return fs.readdirSync(dir)
    .filter((name) => /^products(?:_v2)?_\d+\.json$/.test(name) || name === 'products_all.json')
    .map((name) => path.join(dir, name));
}

function defaultFiles() {
  const dirs = [
    process.env.OUT_DIR,
    '/data/out',
    'out',
    '.',
  ].filter(Boolean);
  const seen = new Set();
  const names = [];
  for (const dir of dirs) {
    const abs = path.resolve(dir);
    if (seen.has(abs)) continue;
    seen.add(abs);
    names.push(...listProductFiles(dir));
  }
  return names.sort();
}

const { last, files } = parseArgs(process.argv.slice(2));
const targets = files.length ? files : defaultFiles();
if (!targets.length) {
  console.error('нет файлов products_*.json — укажите путь явно (в контейнере: /data/out/products_523.json)');
  process.exit(2);
}
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
