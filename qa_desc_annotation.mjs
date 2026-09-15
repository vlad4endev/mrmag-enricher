#!/usr/bin/env node
/**
 * QA: description_html ↔ annotation_html.
 *
 *   node qa_desc_annotation.mjs out/products_467.json
 *   node qa_desc_annotation.mjs out/products_467.json --write
 *
 * Отчёт: таблица по темам + список id с расхождениями.
 * --write перезаписывает description_html отремонтированной версией.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  auditDescAnnotation,
  repairDescriptionHtml,
  parseAnnotationDict,
  DESC_TOPICS,
} from './pipeline/desc_annotation_align.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const args = process.argv.slice(2).filter(a => a !== '--write');
const doWrite = process.argv.includes('--write');
const file = args[0];

if (!file) {
  console.error('usage: node qa_desc_annotation.mjs <products_{id}.json> [--write]');
  process.exit(1);
}

const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
if (!fs.existsSync(abs)) {
  console.error(`нет файла ${abs}`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(abs, 'utf-8'));
const products = Array.isArray(raw) ? raw : (raw.products || []);
const catId = (path.basename(abs).match(/products_(\w+)/) || [])[1] || 'unknown';

const report = auditDescAnnotation(products);

console.log(`\nQA description ↔ annotation  file=${path.basename(abs)}  n=${report.scanned}\n`);
console.log(
  'тема'.padEnd(32)
  + 'ок'.padStart(6)
  + 'проблема'.padStart(10)
  + 'корректность_%'.padStart(16)
  + 'упоминаний'.padStart(12),
);
console.log('-'.repeat(76));
for (const t of report.topics) {
  console.log(
    String(t.topic).padEnd(32)
    + String(t.ok).padStart(6)
    + String(t.problem).padStart(10)
    + String(t.correctness_pct).padStart(16)
    + String(t.mentions).padStart(12),
  );
}

if (report.issues.length) {
  console.log(`\nРасхождения (${report.issues.length}):\n`);
  for (const i of report.issues.slice(0, 200)) {
    console.log(
      `  id=${i.id}  [${i.kind}]  ${i.topic}\n`
      + `    сказано: ${i.said.slice(0, 120)}\n`
      + `    annotation: ${i.annotation == null ? '∅ (нет поля)' : i.annotation}`,
    );
  }
  if (report.issues.length > 200) {
    console.log(`  … ещё ${report.issues.length - 200}`);
  }
} else {
  console.log('\nРасхождений не найдено.');
}

// След «Материал бака»: есть ли в annotation_html и не попал ли в filters.
const tankTrace = { in_annotation: 0, missing_annotation: 0, wrongly_in_filters: 0, samples: [] };
for (const p of products) {
  const dict = parseAnnotationDict(p.annotation_html || '');
  const hasAnn = dict['Материал бака'] != null;
  const hasFilter = p.filters && Object.keys(p.filters).some(k => /материал\s+бак/i.test(k));
  if (hasAnn) tankTrace.in_annotation += 1;
  else tankTrace.missing_annotation += 1;
  if (hasFilter) {
    tankTrace.wrongly_in_filters += 1;
    if (tankTrace.samples.length < 5) {
      tankTrace.samples.push({ id: p.id, note: 'Материал бака в filters — неожиданно (APPROVED_NO)' });
    }
  }
}
console.log('\nСлед «Материал бака»:');
console.log(`  в annotation_html: ${tankTrace.in_annotation}`);
console.log(`  нет в annotation_html: ${tankTrace.missing_annotation}`);
console.log(`  ошибочно в filters: ${tankTrace.wrongly_in_filters}`);
console.log('  (facet.enabled=false → в filters_* быть не должно; если есть на сайте — смотреть импорт витрины)');

if (doWrite) {
  let fixed = 0;
  for (const p of products) {
    const before = p.description_html || '';
    const { html, fixes } = repairDescriptionHtml(before, p.annotation_html || '');
    if (html !== before && fixes.length) {
      p.description_html = html;
      fixed += 1;
    }
  }
  const outPayload = Array.isArray(raw) ? products : { ...raw, products };
  fs.writeFileSync(abs, JSON.stringify(outPayload, null, 2) + '\n');
  console.log(`\n--write: исправлено карточек: ${fixed}`);
}

const outDir = path.join(ROOT, 'out');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `desc_annotation_${catId}.json`);
fs.writeFileSync(outPath, JSON.stringify({
  file: path.basename(abs),
  catId,
  scanned: report.scanned,
  topics: report.topics,
  issues: report.issues,
  tank_material_trace: tankTrace,
  topic_ids: DESC_TOPICS.map(t => t.id),
  written: doWrite,
}, null, 2) + '\n');
console.log(`\nотчёт → ${path.relative(ROOT, outPath)}`);

if (report.issues.length) process.exitCode = 2;
