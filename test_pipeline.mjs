import { loadConfig, loadDictionary, loadProducts, attrsWithCoverage, loadCategories } from './pipeline/dict.js';
import { normalizeProduct, formatCounts } from './pipeline/normalize.js';
import { bucketLabel } from './pipeline/facets.js';
import { renderCard } from './pipeline/generate.js';
import { identityMatches } from './pipeline/identity.js';
import { needsExternal, parseProductBySpecs, lookupExternal, enrichMissing } from './pipeline/external.js';
import {
  parseSearchResults, parseDuckDuckGoResults, isDuckDuckGoBlocked,
  searchQuery, searchWeb, searchDuckDuckGo, resolveSearchSettings,
} from './pipeline/search.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const config = loadConfig('.');
const d467 = loadDictionary('467', '.');
const d523 = loadDictionary('523', '.');
const p467 = Object.fromEntries(loadProducts('data_467.json').map(p => [p.id, p]));
const p523 = Object.fromEntries(loadProducts('data_523.json').map(p => [p.id, p]));

function run(id, dict, src) {
  const p = src[id];
  assert.ok(p, `нет товара ${id}`);
  return { p, r: normalizeProduct(p, dict, config) };
}

{
  const { p, r } = run(11391, d467, p467);
  assert.equal(r.format, 'LI');
  assert.equal(r.pairs.length, 30);
  assert.equal(r.attrs.load_max, 6);
  assert.equal(r.attrs.height, 84.6);
  assert.equal(r.attrs.noise_wash, 59);
  assert.equal(r.attrs.spin_max, 1000);
  assert.equal(r.attrs.energy_class, 'A++');
  assert.ok([...r.unmapped.keys()].includes('Линейка'));
  assert.equal(r.name, p.name);
  const h = d467.byCode.get('height').facet;
  const n = d467.byCode.get('noise_wash').facet;
  const s = d467.byCode.get('spin_max').facet;
  assert.equal(bucketLabel(r.attrs.height, h), '80-85');
  assert.equal(bucketLabel(r.attrs.noise_wash, n), '55-60');
  assert.equal(bucketLabel(r.attrs.spin_max, s), '1000-1200');
  console.log('ok 11391');
}

{
  const { p, r } = run(29921, d467, p467);
  assert.equal(r.format, 'BR');
  assert.equal(String(p.description || '').trim(), '');
  assert.equal(r.attrs.load_max, 4);
  assert.equal(r.attrs.weight, 47);
  assert.ok(r.pairs.some(x => x.key === 'Загрузка белья (кг)' && String(x.value).startsWith('4')));
  assert.ok(r.pairs.some(x => x.key === 'Интерфейс' || x.key === 'Интерфейс 2D') === true);
  assert.ok(r.pairs.some(x => x.key === 'Интерфейс'), `ключи: ${r.pairs.map(x => x.key).join(' | ')}`);
  assert.ok(!r.pairs.some(x => /брутто/i.test(x.key)) || r.attrs.weight === 47);
  assert.equal(r.identity.article, '31007816');
  assert.equal(r.name, p.name);
  console.log('ok 29921');
}

{
  const { p, r } = run(426283, d523, p523);
  assert.equal(r.format, 'EMPTY');
  assert.equal(r.dump, true);
  assert.ok(r.pairs.length >= 38, r.pairs.length);
  assert.ok(r.pairs.every(x => x.source === 'S2'));
  assert.equal(r.attrs.height, 190.5);
  assert.equal(r.attrs.width, 70);
  assert.equal(r.attrs.depth, 67.6);
  assert.notEqual(r.attrs.height, 200);
  assert.equal(r.attrs.weight, 105);
  assert.equal(r.identity.brand, 'Haier');
  assert.equal(r.identity.model, 'A4F742CMGU1');
  assert.ok(!Object.values(r.provenance).some(x => x.level === 'S3'));
  const card = renderCard(r, d523);
  assert.ok(card.description != null);
  console.log('ok 426283');
}

console.log('golden tests passed');

{
  const all467 = loadProducts('data_467.json');
  const all523 = loadProducts('data_523.json');
  assert.equal(all467.length, 161);
  assert.equal(all523.length, 254);
  const recs467 = all467.map(p => normalizeProduct(p, d467, config));
  const recs523 = all523.map(p => normalizeProduct(p, d523, config));
  assert.ok(recs467.every((r, i) => r.name === all467[i].name));
  assert.ok(recs523.every((r, i) => r.name === all523[i].name));
  assert.deepEqual(formatCounts(recs467), { LI: 64, BR: 92, EMPTY: 5, OTHER: 0 });
  assert.deepEqual(formatCounts(recs523), { LI: 134, BR: 99, EMPTY: 21, OTHER: 0 });
  console.log('ok formats + names 415');
}

{
  assert.throws(() => loadDictionary('999', '.'), /нет справочника/);
  const tmp = 'attributes_999.json';
  fs.writeFileSync(tmp, JSON.stringify([{
    code: 'brand', name: 'Бренд', description: 'x', type: 'enum', unit: null,
    cardinality: 'single', order: 0, show_in_annotation: true, highlight: true,
    inferable: true, tier: 'A', decision_reason: 'x', coverage_now: 0,
    valid_range: null, synonyms: ['Бренд'], blacklist: [],
    facet: { enabled: true, label: 'Бренд', kind: 'enum' },
  }], null, 2));
  try {
    const d = loadDictionary('999', '.');
    assert.equal(d.catId, '999');
    assert.equal(d.attrs[0].code, 'brand');
    console.log('ok third category = attributes file only');
  } finally {
    fs.unlinkSync(tmp);
  }
}

{
  const out = attrsWithCoverage(d467, { brand: 91.3, height: 75 });
  const brand = out.find(a => a.code === 'brand');
  const keys = Object.keys(brand);
  assert.equal(keys[keys.indexOf('coverage_now') + 1], 'coverage_final');
  assert.equal(brand.coverage_final, 91.3);
  const cats = loadCategories('.');
  assert.ok(Array.isArray(cats) && cats.length > 2);
  assert.deepEqual(Object.keys(cats.find(c => c.id === 467)), ['id', 'name']);
  assert.equal(cats.find(c => c.id === 467).name, 'Стиральные машины');
  assert.equal(cats.find(c => c.id === 523).name, 'Холодильники');
  console.log('ok customer output shape: attributes + categories {id,name}');
}

{
  const { p, r } = run(391361, d467, p467);
  assert.equal(r.format, 'EMPTY');
  assert.equal(r.dump, true);
  assert.ok(r.pairs.length >= 8, r.pairs.length);
  assert.ok(r.pairs.every(x => x.source === 'S2'));
  assert.equal(r.attrs.install, 'Отдельностоящая');
  assert.equal(r.attrs.height, 85);
  assert.equal(r.attrs.width, 59.6);
  assert.equal(r.attrs.depth, 46.5);
  assert.ok(!Object.values(r.provenance).some(x => x.level === 'S3'));
  console.log('ok 391361 empty annotation → specs from description');
}

{
  assert.equal(identityMatches('WW80AG6S28AELP Indesit', { brand: 'Indesit', model: 'WW80AG6S28AELP' }), true);
  assert.equal(identityMatches('WW80AGAS26AXLP Indesit', { brand: 'Indesit', model: 'WW80AG6S28AELP' }), false);
  assert.equal(identityMatches('Бирюса M418', { brand: 'Бирюса', model: '418' }), false);
  assert.equal(identityMatches('Indesit BWSE 7129X WSV RU', { brand: 'Indesit', model: 'BWSE 7129X WSV RU' }), true);
  assert.equal(
    identityMatches('Стиральная машина Индезит BWSE 7129X WSV RU', { brand: 'Indesit', model: 'BWSE 7129X WSV RU' }, d467),
    true,
  );
  console.log('ok identity match: full model, not a neighbour');
}

{
  const empty = normalizeProduct(p467[460989], d467, config);
  assert.equal(empty.format, 'EMPTY');
  assert.equal(empty.dump, false);
  assert.equal(needsExternal(empty), true);
  assert.equal(needsExternal(normalizeProduct(p523[426283], d523, config)), false);
  assert.equal(needsExternal(normalizeProduct(p467[11391], d467, config)), false);

  const html = `
    <h1>Стиральная машина Indesit BWSE 7129X WSV RU</h1>
    <table>
      <tr><td>Максимальная загрузка</td><td>7 кг</td></tr>
      <tr><td>Скорость отжима</td><td>1200 об/мин</td></tr>
      <tr><td>Класс энергопотребления</td><td>A+++</td></tr>
      <tr><td>Высота</td><td>85 см</td></tr>
      <tr><td>Ширина</td><td>60 см</td></tr>
      <tr><td>Глубина</td><td>54 см</td></tr>
    </table>`;
  const got = parseProductBySpecs(empty, html, d467, config, { url: 'https://example.test/indesit' });
  assert.equal(got.ok, true, got.reason);
  assert.equal(empty.attrs.load_max, 7);
  assert.equal(empty.attrs.spin_max, 1200);
  assert.equal(empty.attrs.height, 85);
  assert.equal(empty.provenance.load_max.level, 'S3');
  assert.equal(empty.external.url, 'https://example.test/indesit');

  const other = normalizeProduct(p467[460990], d467, config);
  const rejected = parseProductBySpecs(other, html, d467, config);
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /модель не совпала/);
  assert.equal(other.attrs.load_max, null);
  console.log('ok empty product parsed from specs table (S3), neighbour rejected');
}

{
  const rec = normalizeProduct(p467[461139], d467, config);
  const pages = {
    'https://a.test/wrong': '<h1>Indesit ILS3 61091</h1><table><tr><td>Загрузка</td><td>5 кг</td></tr><tr><td>Высота</td><td>85 см</td></tr><tr><td>Ширина</td><td>60 см</td></tr></table>',
    'https://b.test/right': '<h1>Стиральная машина INDESIT ILS3 71291 S</h1><table><tr><td>Максимальная загрузка</td><td>7 кг</td></tr><tr><td>Скорость отжима</td><td>1200</td></tr><tr><td>Класс энергопотребления</td><td>A++</td></tr><tr><td>Высота</td><td>85 см</td></tr></table>',
  };
  const found = await lookupExternal(rec, d467, config, {
    search: async () => ['https://a.test/wrong', 'https://b.test/right'],
    fetchHtml: async url => pages[url],
  });
  assert.equal(found.ok, true, found.reason);
  assert.equal(found.url, 'https://b.test/right');
  assert.equal(rec.attrs.load_max, 7);
  assert.notEqual(rec.attrs.load_max, 5);
  console.log('ok lookup skips neighbour page, takes matching model');
}

{
  const serp = `<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fshop.example%2Fcard&amp;rut=x">1</a>
    <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fshop.example%2Fdrugoy">тот же домен</a>
    <a href="https://mrmag.ru/shop/kholodilniki/x">наша пустая карточка</a>
    <a href="https://html.duckduckgo.com/settings">сам поисковик</a>
    <a href="https://second.example/">главная, не карточка</a>
    <a href="https://second.example/tovar">2</a>
    <a href="http://169.254.169.254/latest/meta-data/">метаданные облака</a>
    <a href="http://127.0.0.1:8080/admin">внутренняя сеть</a>`;
  assert.deepEqual(
    parseSearchResults(serp, 'html.duckduckgo.com'),
    ['https://shop.example/card', 'https://second.example/tovar'],
  );
  const rec = normalizeProduct(p467[460989], d467, config);
  assert.match(searchQuery(rec, config), /BWSE 7129X WSV RU/);
  assert.match(searchQuery(rec, config), /характеристики$/);
  console.log('ok search results: unwrap, skip mrmag and private hosts');
}

{
  const html = `
    <div class="result results_links_deep sponsored--ad result--ad">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fads.example%2Fbuy">реклама</a>
    </div>
    <div class="result results_links results_links_deep web-result">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fshop.example%2Fcard&amp;rut=x">Indesit</a>
      </h2>
    </div>
    <div class="result results_links results_links_deep web-result">
      <a class="result__a" href="https://mrmag.ru/shop/x">наш магазин</a>
    </div>
    <div class="result results_links results_links_deep web-result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fother.example%2Ftovar">вторая</a>
    </div>`;
  assert.deepEqual(
    parseDuckDuckGoResults(html),
    ['https://shop.example/card', 'https://other.example/tovar'],
  );
  assert.equal(isDuckDuckGoBlocked('<div class="anomaly-modal"></div><script src="/anomaly.js"></script>'), true);
  assert.equal(isDuckDuckGoBlocked(html), false);
  console.log('ok DuckDuckGo HTML: organic links, ads skipped, captcha detected');
}

{
  const prev = {
    WEB_LOOKUP: process.env.WEB_LOOKUP,
    WEB_LOOKUP_TRIES: process.env.WEB_LOOKUP_TRIES,
    DDG_REGION: process.env.DDG_REGION,
    DDG_ENDPOINT: process.env.DDG_ENDPOINT,
    SEARCH_URL: process.env.SEARCH_URL,
  };
  try {
    delete process.env.WEB_LOOKUP;
    delete process.env.WEB_LOOKUP_TRIES;
    delete process.env.DDG_REGION;
    delete process.env.DDG_ENDPOINT;
    delete process.env.SEARCH_URL;
    const fromFile = resolveSearchSettings(config);
    assert.equal(fromFile.enabled, true);
    assert.equal(fromFile.tries, 3);
    assert.equal(fromFile.duckduckgo.region, 'ru-ru');
    assert.equal(fromFile.duckduckgo.endpoint, 'html');
    assert.equal(fromFile.duckduckgo.method, 'POST');
    assert.equal(fromFile.querySuffix, 'характеристики');

    process.env.WEB_LOOKUP = '0';
    process.env.WEB_LOOKUP_TRIES = '5';
    process.env.DDG_REGION = 'uk-en';
    process.env.DDG_ENDPOINT = 'lite';
    process.env.SEARCH_URL = 'https://searx.example/search?q=%s';
    const fromEnv = resolveSearchSettings(config);
    assert.equal(fromEnv.enabled, false);
    assert.equal(fromEnv.tries, 5);
    assert.equal(fromEnv.duckduckgo.region, 'uk-en');
    assert.equal(fromEnv.duckduckgo.endpoint, 'lite');
    assert.equal(fromEnv.extraUrl, 'https://searx.example/search?q=%s');

    delete process.env.WEB_LOOKUP;
    const fileOff = resolveSearchSettings({ search: { enabled: false } });
    assert.equal(fileOff.enabled, false);
    const ddgOff = resolveSearchSettings({ search: { duckduckgo: { enabled: false } } });
    assert.equal(ddgOff.duckduckgo.enabled, false);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const rec = normalizeProduct(p467[460989], d467, config);
  assert.match(searchQuery(rec, { search: { query_suffix: 'спецификация' } }), /спецификация$/);
  console.log('ok search settings: config.json + env override + DuckDuckGo region');
}

{
  const rec = normalizeProduct(p467[460989], d467, config);
  const prev = process.env.WEB_LOOKUP;
  process.env.WEB_LOOKUP = '0';
  try {
    const r = await enrichMissing([rec], d467, config);
    assert.deepEqual(r, []);
    assert.equal(rec.attrs.load_max, null);
  } finally {
    if (prev === undefined) delete process.env.WEB_LOOKUP;
    else process.env.WEB_LOOKUP = prev;
  }
  console.log('ok WEB_LOOKUP=0 skips search');
}

{
  const pages = {
    '/wrong': '<h1>Indesit ILS3 61091</h1><table><tr><td>Максимальная загрузка</td><td>5 кг</td></tr><tr><td>Высота</td><td>85 см</td></tr><tr><td>Ширина</td><td>60 см</td></tr></table>',
    '/right': '<h1>Стиральная машина Indesit BWSE 7129X WSV RU</h1><table><tr><td>Максимальная загрузка</td><td>7 кг</td></tr><tr><td>Скорость отжима</td><td>1200</td></tr><tr><td>Класс энергопотребления</td><td>A+++</td></tr><tr><td>Высота</td><td>85 см</td></tr></table>',
  };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (url.pathname === '/serp') {
      return res.end(`<a href="http://localhost:${port}/wrong">1</a><a href="http://[::1]:${port}/right">2</a>`);
    }
    res.end(pages[url.pathname] ?? 'нет');
  });
  await new Promise(r => srv.listen(0, r));
  const port = srv.address().port;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-search-'));
  const prev = {
    SEARCH_URL: process.env.SEARCH_URL,
    PAGE_CACHE_DIR: process.env.PAGE_CACHE_DIR,
    SEARCH_GAP_MS: process.env.SEARCH_GAP_MS,
    CRAWL_GAP_MS: process.env.CRAWL_GAP_MS,
    WEB_ALLOW_LOCAL: process.env.WEB_ALLOW_LOCAL,
  };
  process.env.SEARCH_URL = `http://127.0.0.1:${port}/serp?q=%s`;
  process.env.PAGE_CACHE_DIR = cacheDir;
  process.env.SEARCH_GAP_MS = '0';
  process.env.CRAWL_GAP_MS = '0';
  process.env.WEB_ALLOW_LOCAL = '1';
  try {
    const rec = normalizeProduct(p467[460989], d467, config);
    const urls = await searchWeb(searchQuery(rec));
    assert.ok(urls.some(u => u.includes('/right')), urls);
    const got = await lookupExternal(rec, d467, config);
    assert.equal(got.ok, true, got.reason);
    assert.match(got.url, /\/right$/);
    assert.equal(rec.attrs.load_max, 7);
    assert.equal(rec.provenance.load_max.level, 'S3');
    assert.ok(rec.external.url);
  } finally {
    await new Promise(r => srv.close(r));
    fs.rmSync(cacheDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  console.log('ok search engine → matching page → S3 specs');
}
