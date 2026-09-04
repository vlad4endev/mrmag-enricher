#!/usr/bin/env node
/**
 * CLI справочнико-управляемого пайплайна.
 * Третья категория — это новый dictionaries/attributes_{cat_id}.json, без правок этого файла.
 *
 *   node cli.mjs inspect   data_467.json
 *   node cli.mjs normalize data_467.json
 *   node cli.mjs enrich    data_467.json [--no-external] [--limit N]
 *   node cli.mjs lookup    data_467.json [--limit N]
 *     → поиск той же модели в сети, добор характеристик (S3)
 *   node cli.mjs config
 *     → текущие настройки поиска (config.json + env), в т.ч. DuckDuckGo
 *   node cli.mjs facets    data_467.json
 *   node cli.mjs artifacts data_467.json data_523.json
 *     → dictionaries/attributes_*.json, categories.json
 *   node cli.mjs validate  out/products_467.json
 *   node cli.mjs report    467
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  catIdFromFile, loadConfig, loadDictionary, loadProducts, writeJson,
  loadCategories, writeCategories, attrsWithCoverage, dictionaryPath,
} from './pipeline/dict.js';
import { extractPairs } from './pipeline/parse.js';
import { annotationFormat, stripHtml, normKey } from './pipeline/text.js';
import { normalizeProduct, coverage, formatCounts, unmappedFreq } from './pipeline/normalize.js';
import { buildFilters } from './pipeline/facets.js';
import { buildReport } from './pipeline/report.js';
import { renderCard, annotationRows, MIN_ANNOTATION_ROWS } from './pipeline/generate.js';
import { serializeProducts, serializeFilters } from './pipeline/export.js';
import { validateProducts } from './pipeline/validate.js';
import { webInfoFrom } from './pipeline/reviews.js';
import { enrichMissing } from './pipeline/external.js';
import { resolveSearchSettings } from './pipeline/search.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT_DIR || path.join(ROOT, 'out');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? true;
}

function loadAll(dataFile) {
  const catId = catIdFromFile(dataFile);
  const config = loadConfig(ROOT);
  const dict = loadDictionary(catId, ROOT);
  const products = loadProducts(path.resolve(dataFile));
  return { catId, config, dict, products };
}

function inspect(dataFile) {
  const { products, dict } = loadAll(dataFile);
  const keys = new Map();
  const values = new Map();
  const formats = { LI: 0, BR: 0, EMPTY: 0, OTHER: 0 };
  for (const p of products) {
    formats[annotationFormat(p.annotation)]++;
    for (const pair of extractPairs(p.annotation, dict).concat(extractPairs(p.description, dict))) {
      keys.set(pair.key, (keys.get(pair.key) || 0) + 1);
      values.set(pair.value, (values.get(pair.value) || 0) + 1);
    }
  }
  const report = {
    products: products.length,
    formats,
    keys: [...keys].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count })),
    values_top: [...values].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([value, count]) => ({ value, count })),
  };
  console.log(JSON.stringify({ products: report.products, formats, keys: report.keys.slice(0, 40) }, null, 2));
  writeJson(path.join(OUT, `inspect_${catIdFromFile(dataFile)}.json`), report);
}

function runNormalize(dataFile) {
  const { catId, config, dict, products } = loadAll(dataFile);
  const recs = products.map(p => {
    const r = normalizeProduct(p, dict, config);
    r._nameIn = p.name;
    return r;
  });
  const cov = coverage(recs, dict);
  const formats = formatCounts(recs);
  const unmapped = unmappedFreq(recs);
  const diffs = dict.attrs
    .filter(a => a.code !== 'brand' && a.coverage_now != null)
    .map(a => ({ code: a.code, name: a.name, now: a.coverage_now, fact: cov[a.code].fact, d: cov[a.code].fact - a.coverage_now }))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));

  const dims = {
    parsed: recs.reduce((s, r) => s + r.stats.dims_parsed, 0),
    unknown: recs.reduce((s, r) => s + r.stats.dims_unknown, 0),
    packed: recs.reduce((s, r) => s + r.stats.packed_dims, 0),
    height: cov.height?.fact, width: cov.width?.fact, depth: cov.depth?.fact,
  };

  const out = {
    catId,
    products: recs.length,
    formats,
    coverage: Object.fromEntries(dict.attrs.map(a => [a.code, cov[a.code]])),
    diffs,
    unmapped: unmapped.slice(0, 50).map(([key, count]) => ({ key, count })),
    dims,
    names_intact: recs.every(r => r.name === r._nameIn),
  };

  fs.mkdirSync(OUT, { recursive: true });
  writeJson(path.join(OUT, `normalized_${catId}.json`), recs.map(serializeRec));
  writeJson(path.join(OUT, `normalize_report_${catId}.json`), out);

  console.log(`\nnormalize ${catId}  n=${recs.length}  formats LI/BR/EMPTY=${formats.LI}/${formats.BR}/${formats.EMPTY}`);
  console.log(`name intact: ${out.names_intact}   dims parsed/unknown/packed=${dims.parsed}/${dims.unknown}/${dims.packed}`);
  console.log('coverage vs coverage_now (top расхождения):');
  for (const d of diffs.slice(0, 20)) {
    const mark = d.d === 0 ? 'OK' : (Math.abs(d.d) <= 2 ? '~' : '!!');
    console.log(`  ${mark} ${String(d.fact).padStart(3)}%  now ${String(d.now).padStart(3)}%  ${d.code}  ${d.name}`);
  }
  const miss = diffs.filter(d => d.d !== 0).length;
  console.log(`расхождений: ${miss}/${diffs.length}`);
  return { recs, dict, config, catId, cov, formats, unmapped };
}

function serializeRec(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    annotation: r.annotation,
    attrs: r.attrs,
    identity: r.identity,
    provenance: r.provenance,
    format: r.format,
    flags: r.flags,
    moderation: r.moderation,
    unmapped: [...r.unmapped],
  };
}

function coverageMap(cov, dict) {
  const out = {};
  for (const a of dict.attrs) out[a.code] = cov[a.code]?.fact_filled ?? 0;
  return out;
}

/** Клиентский выход после обогащения: dictionaries/attributes_{id}.json + categories.json. */
function writeCustomerDeliverables({ recs, dict, catId, cov }) {
  const attrsOut = attrsWithCoverage(dict, coverageMap(cov, dict));
  writeJson(dictionaryPath(catId, ROOT), attrsOut);
  writeCategories(path.join(ROOT, 'categories.json'), loadCategories(ROOT));
  return attrsOut;
}

function writeContractData(recs, dict, catId) {
  const rows = recs.map((r) => {
    const card = r.card || renderCard(r, dict);
    return {
      id: r.id,
      name: r.name,
      description: card.description ?? r.description ?? '',
      annotation: card.annotation ?? r.annotation ?? '',
    };
  });
  writeJson(path.join(OUT, `data_${catId}.json`), rows, 2);
  return rows;
}

function writeOutputs({ recs, dict, config, catId, cov, covAfter, formats, unmapped }, { customer = false } = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  const after = covAfter || cov;
  for (const rec of recs) {
    if (!rec.card) rec.card = renderCard(rec, dict);
  }
  // Товар с неполными характеристиками уходит в отчёт, а не в выгрузку:
  // пустой annotation_html у заказчика — дефект, воспроизводить его не нужно.
  const held = recs.filter(r => annotationRows(r, dict).length < MIN_ANNOTATION_ROWS);
  const heldIds = new Set(held.map(r => r.id));
  const exported = recs.filter(r => !heldIds.has(r.id));

  const built = buildFilters(exported, dict, config);
  writeContractData(recs, dict, catId);
  const products = serializeProducts(exported, dict, built.debug, { root: ROOT });
  writeJson(path.join(OUT, `products_${catId}.json`), products, 4);
  writeJson(path.join(OUT, `filters_${catId}.json`), serializeFilters(built), 4);
  const heldRows = held.map(r => ({
    id: r.id,
    name: r.name,
    rows: annotationRows(r, dict).length,
    reason: `характеристик ${annotationRows(r, dict).length} < ${MIN_ANNOTATION_ROWS}`,
  }));
  writeJson(path.join(OUT, `held_${catId}.json`), heldRows, 2);
  const noReview = recs.filter(r => !webInfoFrom(
    r.web_info ?? r.external?.web_info ?? r.review ?? r.external?.review ?? r.page_data ?? r.external?.page_data ?? '',
  )).map(r => ({ id: r.id, name: r.name, reason: 'нет отзыва покупателя' }));
  writeJson(path.join(OUT, `noreview_${catId}.json`), noReview, 2);
  const verdict = validateProducts(products, dict, new Map(recs.map(r => [r.id, r])));
  writeJson(path.join(OUT, `validate_${catId}.json`), verdict, 2);
  if (!verdict.ok) {
    console.log(`validate ${catId}: ${verdict.errors.length} нарушений`);
  }

  writeJson(path.join(OUT, `products_v2_${catId}.json`), products, 4);
  writeJson(path.join(OUT, `filters_v2_${catId}.json`), serializeFilters(built), 4);
  const cat = loadCategories(ROOT).find(c => Number(c.id) === Number(catId));
  writeJson(path.join(OUT, 'categories_v2.json'), {
    categories: [{ id: Number(catId), name: cat?.name || String(catId) }],
  }, 2);

  const attrsOut = attrsWithCoverage(dict, coverageMap(after, dict));
  writeJson(path.join(OUT, `attributes_${catId}.json`), attrsOut);

  const sources = sourceStats(recs);
  const report = buildReport({
    recs, dict, config,
    coverageBefore: cov,
    coverageAfter: after,
    formats, unmapped, excluded: built.excluded, sources,
    held: heldRows, noReview,
  });
  writeJson(path.join(OUT, `report_${catId}.json`), report);

  const provenance = recs.map(r => ({
    id: r.id,
    provenance: r.provenance,
    identity: r.identity,
    source_url: r.external?.url ?? null,
  }));
  writeJson(path.join(OUT, `provenance_${catId}.json`), provenance);

  if (customer) writeCustomerDeliverables({ recs, dict, catId, cov: after });
  console.log(`выгрузка: products_${catId}.json и products_v2_${catId}.json — семь полей заказчика`);
  return built;
}

function sourceStats(recs) {
  let s1 = 0, s2 = 0, s3 = 0, extProducts = 0;
  for (const r of recs) {
    const levels = new Set(Object.values(r.provenance).map(p => p.level));
    for (const p of Object.values(r.provenance)) {
      if (p.level === 'S1') s1++;
      else if (p.level === 'S2') s2++;
      else if (p.level === 'S3') s3++;
    }
    if (levels.has('S3')) extProducts++;
  }
  return {
    from_annotation: s1,
    from_description: s2,
    from_external: s3,
    products_with_external: extProducts,
  };
}

/**
 * Проверка выгрузки по чек-листу. Ненулевой код возврата — чтобы CI падал
 * до отправки заказчику, а не после.
 */
function validateFile(file) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const catId = catIdFromFile(file);
  const dict = loadDictionary(catId, ROOT);
  const src = loadProducts(path.join(ROOT, `data_${catId}.json`));
  const byId = new Map(src.map(p => [p.id, p]));

  const { ok, errors, summary } = validateProducts(rows, dict, byId);

  console.log(`validate ${catId}: товаров ${summary.products}, ` +
    `фильтров ${summary.filters_present}/${summary.filters_expected}, ` +
    `мультизначных значений ${summary.multi_value_filters}, ` +
    `с web_info ${summary.with_web_info}`);
  for (const d of summary.dominant_filters) {
    console.log(`  !! «${d.name}»: одно значение у ${d.share}% — фильтр не различает товары`);
  }

  const byKind = new Map();
  for (const e of errors) byKind.set(e.kind, (byKind.get(e.kind) || 0) + 1);
  for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
    const sample = errors.find(e => e.kind === kind);
    console.log(`  ${String(n).padStart(4)}  ${kind}${sample?.detail != null ? `  напр. ${sample.id ?? ''} ${sample.detail}` : ''}`);
  }
  console.log(ok ? 'OK: чек-лист пройден' : `НЕ ПРОЙДЕНО: ${errors.length} нарушений`);
  writeJson(path.join(OUT, `validate_${catId}.json`), { ok, summary, errors }, 2);
  if (!ok) process.exitCode = 1;
}

function reportCmd(catId) {
  const file = path.join(OUT, `report_${catId}.json`);
  const r = JSON.parse(fs.readFileSync(file, 'utf-8'));
  console.log(JSON.stringify({
    formats: r.summary.formats,
    criteria: r.sections[1].items.map(i => `${i.fact ? 'OK' : 'NO'} ${i.name}`),
    excluded: r.sections[4].items,
    unmapped_top: r.sections[7].items.slice(0, 15),
  }, null, 2));
}

function showConfig() {
  const config = loadConfig(ROOT);
  const search = resolveSearchSettings(config);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...config, search_resolved: search }, null, 2));
    return;
  }
  const ddg = search.duckduckgo;
  console.log(`покрытие: цель ${config.target_coverage}%, фильтры от ${config.facet_min_coverage}%`);
  console.log(`карточка: минимум ${config.description?.min_attrs ?? 5} характеристик, нечёткое совпадение ≥ ${config.fuzzy?.min_score ?? 0.93}`);
  console.log(`поиск в сети: ${search.enabled ? 'включён' : 'выключен'}`);
  console.log(`  попыток на товар: ${search.tries}`);
  console.log(`  пауза / таймаут: ${search.gapMs} мс / ${search.timeoutMs} мс`);
  console.log(`  хвост запроса: «${search.querySuffix}»`);
  console.log(`  свои хосты пропускаем: ${search.skipHosts.join(', ')}`);
  console.log(`  свой поисковик: ${search.extraUrl || 'нет'}`);
  console.log(`  DuckDuckGo: ${ddg.enabled ? `${ddg.method} ${ddg.endpoint}, регион ${ddg.region}` : 'выключен'}`);
  if (ddg.url) console.log(`  DuckDuckGo URL: ${ddg.url}`);
  if (ddg.siteFilter) console.log(`  site: ${ddg.siteFilter}`);
  console.log(`  запасные движки: ${search.fallback.join(', ') || 'нет'}`);
  console.log('\nперекрыть файл: WEB_LOOKUP=0, SEARCH_URL, WEB_LOOKUP_TRIES, SEARCH_GAP_MS, DDG_REGION, DDG_ENDPOINT, DDG_URL');
}

async function runEnrich(dataFile, { external = true, limit = null } = {}) {
  const r = runNormalize(dataFile);
  if (limit) r.recs = r.recs.slice(0, Number(limit));
  const search = resolveSearchSettings(r.config);
  if (external && search.enabled) {
    const found = await enrichMissing(r.recs, r.dict, r.config, {
      onNote: msg => process.stdout.write(`  ${msg}\n`),
    });
    const ok = found.filter(x => x.ok).length;
    console.log(`external: ${ok}/${found.length} пустых карточек добрано`);
    for (const x of found) {
      const who = x.rec.identity?.model || x.rec.id;
      if (x.ok) console.log(`  OK ${who} ← ${x.url}`);
      else console.log(`  .. ${who} — ${x.reason}`);
    }
    r.covAfter = coverage(r.recs, r.dict);
  }
  for (const rec of r.recs) rec.card = renderCard(rec, r.dict);
  writeOutputs(r, { customer: true });
  console.log(`customer: dictionaries/attributes_${r.catId}.json, categories.json`);
  return r;
}

const cmd = process.argv[2];
const files = process.argv.slice(3).filter(a => !a.startsWith('--'));

if (cmd === 'inspect') inspect(files[0]);
else if (cmd === 'normalize') {
  const r = runNormalize(files[0]);
  writeOutputs(r);
}
else if (cmd === 'enrich' || cmd === 'lookup') {
  await runEnrich(files[0], {
    external: cmd === 'lookup' || !process.argv.includes('--no-external'),
    limit: arg('--limit'),
  });
}
else if (cmd === 'facets') {
  const r = runNormalize(files[0]);
  const built = writeOutputs(r);
  console.log(built.filters.map(f => f.name).join(' · '));
}
else if (cmd === 'artifacts') {
  const targets = files.length ? files : [
    path.join(ROOT, 'data_467.json'),
    path.join(ROOT, 'data_523.json'),
  ];
  for (const f of targets) {
    const r = runNormalize(f);
    for (const rec of r.recs) rec.card = renderCard(rec, r.dict);
    writeOutputs(r, { customer: true });
  }
  console.log('customer: dictionaries/attributes_*.json, categories.json');
}
else if (cmd === 'config') showConfig();
else if (cmd === 'validate') validateFile(files[0]);
else if (cmd === 'report') reportCmd(files[0]);
else {
  console.error(`команды: inspect | normalize | enrich | lookup | config | facets | artifacts | validate | report`);
  process.exit(1);
}
