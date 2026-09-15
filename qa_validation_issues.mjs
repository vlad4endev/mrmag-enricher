#!/usr/bin/env node
/**
 * Read-only сводка validation_issues после прогона.
 * Ничего не пишет в products/filters/data/dictionaries — только отчёт в out/.
 *
 *   node qa_validation_issues.mjs 467
 *   node qa_validation_issues.mjs out/provenance_467.json
 *   node qa_validation_issues.mjs out/products_467.json
 *   node qa_validation_issues.mjs out/validate_467.json
 *
 * Флага --write нет нарочно.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, loadDictionary, loadProducts, hasDictionary } from './pipeline/dict.js';
import { normalizeProduct } from './pipeline/normalize.js';
import { assignFilterValues, buildFilters } from './pipeline/facets.js';
import { finalizeRecord } from './pipeline/quality_validate.js';
import { validateProducts } from './pipeline/validate.js';
import { findDescAnnotationIssues } from './pipeline/desc_annotation_align.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const SAMPLE_CAP = 8;

const args = process.argv.slice(2).filter((a) => a !== '--write');
if (process.argv.includes('--write')) {
  console.error('qa_validation_issues.mjs read-only: флага --write нет');
  process.exit(1);
}

const input = args[0];
if (!input) {
  console.error('usage: node qa_validation_issues.mjs <catId|provenance_*.json|products_*.json|validate_*.json>');
  process.exit(1);
}

function readJson(abs) {
  return JSON.parse(fs.readFileSync(abs, 'utf-8'));
}

function resolveExisting(...cands) {
  for (const p of cands) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function kindOf(issue) {
  return String(issue?.kind || issue?.action || 'unknown');
}

function issueId(row, issue) {
  return issue?.id ?? row?.id ?? row?.sku ?? null;
}

function addIssue(bag, row, issue) {
  const kind = kindOf(issue);
  const slot = bag.get(kind) || { kind, count: 0, products: new Set(), samples: [] };
  slot.count += 1;
  const id = issueId(row, issue);
  if (id != null) slot.products.add(String(id));
  if (slot.samples.length < SAMPLE_CAP) {
    slot.samples.push({
      id,
      action: issue?.action || null,
      code: issue?.code ?? issue?.field ?? null,
      detail: String(issue?.detail || issue?.reason || issue?.said || '').slice(0, 180),
    });
  }
  bag.set(kind, slot);
}

function fromIssueList(rows, getIssues) {
  const bag = new Map();
  let scanned = 0;
  let withIssues = 0;
  let needsReview = 0;
  for (const row of rows || []) {
    scanned += 1;
    const issues = getIssues(row) || [];
    if (row?.needs_review) needsReview += 1;
    if (!issues.length) continue;
    withIssues += 1;
    for (const issue of issues) addIssue(bag, row, issue);
  }
  return { bag, scanned, withIssues, needsReview };
}

function table(bag) {
  return [...bag.values()]
    .map((s) => ({
      kind: s.kind,
      events: s.count,
      products: s.products.size,
      samples: s.samples,
    }))
    .sort((a, b) => b.products - a.products || b.events - a.events || a.kind.localeCompare(b.kind));
}

function printTable(rows) {
  console.log(
    'kind'.padEnd(32)
    + 'товаров'.padStart(10)
    + 'событий'.padStart(10)
    + '  примеры id',
  );
  console.log('-'.repeat(88));
  if (!rows.length) {
    console.log('(пусто)');
    return;
  }
  for (const r of rows) {
    const ids = r.samples.map((s) => s.id).filter((id) => id != null).join(', ');
    console.log(
      String(r.kind).padEnd(32)
      + String(r.products).padStart(10)
      + String(r.events).padStart(10)
      + (ids ? `  ${ids}` : ''),
    );
  }
}

function provenanceRows(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.products)) return raw.products;
  return [];
}

function collectProvenance(raw) {
  const rows = provenanceRows(raw);
  return fromIssueList(rows, (r) => r.validation_issues);
}

function collectValidate(raw) {
  const errors = Array.isArray(raw) ? raw : (raw.errors || []);
  const bag = new Map();
  for (const issue of errors) addIssue(bag, { id: issue.id }, issue);
  const ids = new Set(errors.map((e) => e.id).filter((id) => id != null));
  return {
    bag,
    scanned: raw?.summary?.products ?? ids.size,
    withIssues: ids.size,
    needsReview: 0,
  };
}

function collectProductsHtml(products) {
  const bag = new Map();
  let scanned = 0;
  let withIssues = 0;
  for (const p of products || []) {
    scanned += 1;
    const issues = findDescAnnotationIssues(
      p.description_html || p.description || '',
      p.annotation_html || p.annotation || '',
      { id: p.id ?? p.sku },
    );
    if (!issues.length) continue;
    withIssues += 1;
    for (const issue of issues) {
      addIssue(bag, p, {
        kind: issue.kind === 'fabrication' ? 'desc_fabrication' : 'desc_contradiction',
        action: 'needs_review',
        code: issue.topic_id,
        detail: issue.said,
        id: issue.id,
      });
    }
  }
  return { bag, scanned, withIssues, needsReview: 0 };
}

function liveFromDump(catId, productsById) {
  if (!hasDictionary(catId, ROOT)) {
    throw new Error(`нет справочника dictionaries/attributes_${catId}.json`);
  }
  const dumpPath = resolveExisting(
    path.join(ROOT, `data_${catId}.json`),
    path.join(ROOT, 'out', `data_${catId}.json`),
  );
  if (!dumpPath) throw new Error(`нет data_${catId}.json`);
  const dict = loadDictionary(catId, ROOT);
  const config = loadConfig(ROOT);
  const dump = loadProducts(dumpPath);
  const recs = [];
  for (const src of dump) {
    const rec = normalizeProduct({ ...src }, dict, config);
    const card = productsById.get(String(rec.id));
    const enriched = card
      ? {
        description: String(card.description_html || card.description || ''),
        short_description: '',
        bullets: [],
        meta_keywords: card.meta_keywords || '',
      }
      : {
        description: String(src.description || ''),
        short_description: '',
        bullets: [],
      };
    recs.push({ rec, enriched });
  }
  const onlyRecs = recs.map((x) => x.rec);
  const built = buildFilters(onlyRecs, dict, config);
  for (const { rec, enriched } of recs) {
    const assigned = assignFilterValues(rec, dict, built.debug, config);
    finalizeRecord(rec, dict, { enriched, assigned });
  }
  return fromIssueList(recs.map((x) => x.rec), (r) => r.validation_issues);
}

function mergeBags(a, b) {
  const out = new Map(a);
  for (const [kind, slot] of b) {
    const cur = out.get(kind) || { kind, count: 0, products: new Set(), samples: [] };
    cur.count += slot.count;
    for (const id of slot.products) cur.products.add(id);
    for (const s of slot.samples) {
      if (cur.samples.length >= SAMPLE_CAP) break;
      cur.samples.push(s);
    }
    out.set(kind, cur);
  }
  return out;
}

const abs = path.isAbsolute(input) ? input : path.join(ROOT, input);
const isJsonArg = /\.json$/i.test(input);
if (isJsonArg && !fs.existsSync(abs)) {
  console.error(`нет файла ${abs}`);
  process.exit(1);
}

let catId = String(input);
let source = 'dump';
let collected;

if (isJsonArg || fs.existsSync(abs) && /\.json$/i.test(abs)) {
  const base = path.basename(abs);
  const raw = readJson(abs);
  const m = base.match(/^(provenance|products|validate|data)_(\w+)\.json$/i);
  catId = m?.[2] || (String(raw?.catId || 'unknown'));

  if (/^provenance_/i.test(base)) {
    source = 'provenance';
    collected = collectProvenance(raw);
  } else if (/^validate_/i.test(base)) {
    source = 'validate';
    collected = collectValidate(raw);
  } else if (/^data_/i.test(base)) {
    source = 'dump';
    collected = liveFromDump(catId, new Map());
  } else {
    source = 'products';
    const products = Array.isArray(raw) ? raw : (raw.products || []);
    collected = collectProductsHtml(products);
    const looksCustomer = products.some((p) => p && ('description_html' in p || 'filters' in p));
    if (looksCustomer && hasDictionary(catId, ROOT)) {
      const dict = loadDictionary(catId, ROOT);
      const verdict = validateProducts(products, dict);
      const fromValidate = collectValidate(verdict);
      collected.bag = mergeBags(collected.bag, fromValidate.bag);
    }
  }
} else {
  catId = String(input);
  const provPath = resolveExisting(
    path.join(ROOT, 'out', `provenance_${catId}.json`),
    path.join(ROOT, `provenance_${catId}.json`),
  );
  const productsPath = resolveExisting(
    path.join(ROOT, 'out', `products_${catId}.json`),
    path.join(ROOT, `products_${catId}.json`),
  );
  let products = [];
  if (productsPath) {
    const rawP = readJson(productsPath);
    products = Array.isArray(rawP) ? rawP : (rawP.products || []);
  }
  const byId = new Map(products.map((p) => [String(p.id ?? p.sku), p]));
  if (provPath) {
    source = 'provenance';
    collected = collectProvenance(readJson(provPath));
  } else {
    source = 'dump';
    collected = liveFromDump(catId, byId);
  }
}

const rows = table(collected.bag);
console.log(`\nQA validation_issues  cat=${catId}  source=${source}  n=${collected.scanned}`
  + `  с_проблемами=${collected.withIssues}  needs_review=${collected.needsReview}\n`);
printTable(rows);

if (rows.length) {
  console.log('\nПримеры:');
  for (const r of rows.slice(0, 12)) {
    for (const s of r.samples.slice(0, 2)) {
      console.log(`  [${r.kind}] id=${s.id} ${s.detail || ''}`.trimEnd());
    }
  }
}

const outDir = path.join(ROOT, 'out');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `validation_issues_${catId}.json`);
fs.writeFileSync(outPath, `${JSON.stringify({
  catId,
  source,
  scanned: collected.scanned,
  with_issues: collected.withIssues,
  needs_review: collected.needsReview,
  kinds: rows,
  written: false,
}, null, 2)}\n`);
console.log(`\nотчёт → ${path.relative(ROOT, outPath)}`);

if (rows.length) process.exitCode = 2;
