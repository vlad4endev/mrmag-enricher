#!/usr/bin/env node
/**
 * Доводка готовых файлов, отдельно от node cli.mjs enrich.
 *
 *   node refine/cli.mjs audit  products_467.json filters_467.json
 *   node refine/cli.mjs repair products_467.json filters_467.json [--no-lookup]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { analyzeFiles, refineFiles } from './index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cmd = process.argv[2];
const files = process.argv.slice(3).filter(a => !a.startsWith('--'));
const noLookup = process.argv.includes('--no-lookup');

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf-8'));
}

function splitInputs(list) {
  const products = [];
  let filters = null;
  const filenames = [];
  for (const f of list) {
    const name = path.basename(f);
    filenames.push(name);
    const data = readJson(f);
    if (/filters/i.test(name) && !Array.isArray(data)) {
      filters = data;
      continue;
    }
    if (data && !Array.isArray(data) && Array.isArray(data.filters) && !data.products && !/products/i.test(name)) {
      filters = data;
      continue;
    }
    const rows = Array.isArray(data) ? data : data.products;
    if (Array.isArray(rows)) products.push(...rows);
    else throw new Error(`${f}: не список товаров и не файл фильтров`);
  }
  return { products, filters, filenames };
}

if (cmd !== 'audit' && cmd !== 'repair') {
  console.error('usage: node refine/cli.mjs audit|repair products.json [filters.json]');
  process.exit(2);
}
if (!files.length) {
  console.error('нужен хотя бы файл товаров');
  process.exit(2);
}

const input = splitInputs(files);

if (cmd === 'audit') {
  const { audit } = analyzeFiles(input, ROOT);
  console.log(JSON.stringify({
    category: audit.category,
    shape: audit.shape,
    summary: audit.summary,
    filters_file: audit.filters_file,
    dirty: audit.items.filter(i => i.status !== 'ok').slice(0, 20),
  }, null, 2));
} else {
  const result = await refineFiles(input, { lookup: !noLookup, root: ROOT });
  const outDir = process.env.OUT_DIR || path.join(ROOT, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const id = result.category?.id || 'all';
  const prodFile = path.join(outDir, `products_refined_${id}.json`);
  const filtFile = path.join(outDir, `filters_refined_${id}.json`);
  fs.writeFileSync(prodFile, JSON.stringify(result.files.products, null, 2) + '\n');
  fs.writeFileSync(filtFile, JSON.stringify(result.files.filters, null, 2) + '\n');
  if (result.files.products_v2) {
    fs.writeFileSync(path.join(outDir, `products_v2_refined_${id}.json`), JSON.stringify(result.files.products_v2, null, 2) + '\n');
    fs.writeFileSync(path.join(outDir, `filters_v2_refined_${id}.json`), JSON.stringify(result.files.filters_v2, null, 2) + '\n');
  }
  console.log(JSON.stringify({
    category: result.category,
    report: result.report,
    validation: result.validation.summary,
    after: result.after.summary,
    files: { products: prodFile, filters: filtFile },
  }, null, 2));
}
