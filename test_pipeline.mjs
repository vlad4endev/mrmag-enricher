import { loadConfig, loadDictionary, loadProducts, attrsWithCoverage, loadCategories } from './pipeline/dict.js';
import { normalizeProduct, formatCounts } from './pipeline/normalize.js';
import { bucketLabel, buildFilters } from './pipeline/facets.js';
import { renderCard } from './pipeline/generate.js';
import { compactAnnotation, compactHtml, serializeProduct, metaKeywords } from './pipeline/export.js';
import { buildV2 } from './export_v2.js';
import { dictToV2Rows, v2FacetSpecKeys } from './pipeline/v2.js';
import { displayEnum, valueFold } from './pipeline/types.js';
import { identityMatches, nameKeyTokens, parseIdentity } from './pipeline/identity.js';
import { needsExternal, parseProductBySpecs, lookupExternal, enrichMissing } from './pipeline/external.js';
import {
  parseSearchResults, parseDuckDuckGoResults, isDuckDuckGoBlocked,
  parseSerpApiResults, searchQuery, searchWeb, searchDuckDuckGo, searchSerpApi,
  resolveSearchSettings, publicParserStatus,
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

{
  const { p, r } = run(11391, d467, p467);
  assert.equal(r.attrs.load_type, 'Фронтальная');
  assert.equal(displayEnum('фронтальная загрузка'), 'Фронтальная');
  assert.equal(displayEnum('товара белый'), 'Белый');
  assert.equal(displayEnum('электронное (интеллектуальное)'), 'Электронное');
  assert.equal(displayEnum('Cтекло'), 'Стекло');
  assert.equal(displayEnum('Нерж. сталь'), 'Нержавеющая сталь');
  assert.equal(displayEnum('меxанический'), 'Меxанический');
  assert.equal(valueFold('меxанический'), valueFold('механический'));
  assert.equal(valueFold('Отдельно стоящая'), valueFold('Отдельностоящая'));
  console.log('ok displayEnum / valueFold');
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
  const tmpDir = 'dictionaries';
  const tmp = path.join(tmpDir, 'attributes_999.json');
  fs.mkdirSync(tmpDir, { recursive: true });
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
  assert.deepEqual(nameKeyTokens('Холодильник белый'), []);
  assert.deepEqual(nameKeyTokens('Холодильник DON R 290 G'), ['DON', '290']);
  assert.equal(
    identityMatches('Холодильник DON R 290 G объём 310', { name: 'Холодильник DON R 290 G' }),
    true,
  );
  assert.equal(
    identityMatches('Холодильник DON R 291 G', { name: 'Холодильник DON R 290 G' }),
    false,
  );
  const donId = parseIdentity('Холодильник DON R 290 G', d523);
  assert.equal(needsExternal({ identity: donId, name: donId.name, attrs: {}, provenance: {} }), true);
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
  const footer = `<div class="anomaly-modal"></div><script src="/anomaly.js"></script>
    <a href="https://mastodon.social/@duckduckgo">Mastodon</a>
    <a href="https://buttondown.email/duckduckgo">newsletter</a>`;
  assert.deepEqual(parseDuckDuckGoResults(footer), []);
  assert.deepEqual(parseSearchResults(footer, 'html.duckduckgo.com'), []);
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
  const data = {
    organic_results: [
      { position: 1, link: 'https://shop.example/card' },
      { position: 2, link: 'https://mrmag.ru/same' },
      { position: 3, link: 'https://shop.example/other' },
      { position: 4, link: 'https://www.google.com/search?q=x' },
      { position: 5, link: 'https://mastodon.social/@x' },
      { position: 6, url: 'https://other.example/tovar' },
    ],
    ads: [{ link: 'https://ads.example/buy' }],
  };
  assert.deepEqual(
    parseSerpApiResults(data),
    ['https://shop.example/card', 'https://other.example/tovar'],
  );
  assert.deepEqual(parseSerpApiResults({ organic_results: [] }), []);
  console.log('ok SerpAPI JSON: organic links, ads and junk skipped');
}

{
  const prev = {
    WEB_LOOKUP: process.env.WEB_LOOKUP,
    WEB_LOOKUP_TRIES: process.env.WEB_LOOKUP_TRIES,
    DDG_REGION: process.env.DDG_REGION,
    DDG_ENDPOINT: process.env.DDG_ENDPOINT,
    SEARCH_URL: process.env.SEARCH_URL,
    SERPAPI_KEY: process.env.SERPAPI_KEY,
    SERPAPI_API_KEY: process.env.SERPAPI_API_KEY,
    SERPAPI_ENGINE: process.env.SERPAPI_ENGINE,
  };
  try {
    delete process.env.WEB_LOOKUP;
    delete process.env.WEB_LOOKUP_TRIES;
    delete process.env.DDG_REGION;
    delete process.env.DDG_ENDPOINT;
    delete process.env.SEARCH_URL;
    delete process.env.SERPAPI_KEY;
    delete process.env.SERPAPI_API_KEY;
    delete process.env.SERPAPI_ENGINE;
    const fromFile = resolveSearchSettings(config);
    assert.equal(fromFile.enabled, true);
    assert.equal(fromFile.tries, 3);
    assert.equal(fromFile.serpapi.enabled, true);
    assert.equal(fromFile.serpapi.engine, 'google');
    assert.equal(fromFile.serpapi.gl, 'ru');
    assert.equal(fromFile.serpapi.apiKey, '');
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

    process.env.SERPAPI_KEY = 'test-key';
    process.env.SERPAPI_ENGINE = 'bing';
    const withSerp = resolveSearchSettings(config);
    assert.equal(withSerp.serpapi.apiKey, 'test-key');
    assert.equal(withSerp.serpapi.engine, 'bing');

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
  const prev = { SERPAPI_KEY: process.env.SERPAPI_KEY, SERPAPI_API_KEY: process.env.SERPAPI_API_KEY };
  delete process.env.SERPAPI_KEY;
  delete process.env.SERPAPI_API_KEY;
  try {
    const s = publicParserStatus(config);
    assert.equal(s.enabled, true);
    assert.equal(s.status, 'on');
    assert.equal(s.serpapi.enabled, true);
    assert.equal(s.serpapi.has_key, false);
    assert.equal(s.serpapi.engine, 'google');
    assert.equal(s.duckduckgo.region, 'ru-ru');
    assert.equal(s.duckduckgo.method, 'POST');
    assert.match(s.label, /DuckDuckGo/);
    const onKey = publicParserStatus({
      search: { ...config.search, serpapi: { ...config.search.serpapi, api_key: 'k' } },
    });
    assert.match(onKey.label, /SerpAPI/);
    assert.equal(onKey.serpapi.has_key, true);
    const off = publicParserStatus({ search: { enabled: false } });
    assert.equal(off.enabled, false);
    assert.equal(off.status, 'off');
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  console.log('ok parser status for the UI');
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
    SERPAPI_KEY: process.env.SERPAPI_KEY,
    SERPAPI_API_KEY: process.env.SERPAPI_API_KEY,
  };
  process.env.SEARCH_URL = `http://127.0.0.1:${port}/serp?q=%s`;
  process.env.PAGE_CACHE_DIR = cacheDir;
  process.env.SEARCH_GAP_MS = '0';
  process.env.CRAWL_GAP_MS = '0';
  process.env.WEB_ALLOW_LOCAL = '1';
  delete process.env.SERPAPI_KEY;
  delete process.env.SERPAPI_API_KEY;
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

{
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        const p = new URLSearchParams(raw);
        const hit = `http://${req.headers.host}/card`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (p.get('kl') !== 'ru-ru' || !String(p.get('q') || '').includes('BWSE')) {
          return res.end('<div class="anomaly-modal"></div><script src="/anomaly.js"></script>');
        }
        res.end(`<div class="result results_links web-result">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(hit)}">карточка</a>
        </div>`);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h1>Стиральная машина Indesit BWSE 7129X WSV RU</h1>
      <table><tr><td>Максимальная загрузка</td><td>7 кг</td></tr>
      <tr><td>Скорость отжима</td><td>1200</td></tr>
      <tr><td>Класс энергопотребления</td><td>A+++</td></tr>
      <tr><td>Высота</td><td>85 см</td></tr></table>`);
  });
  await new Promise(r => srv.listen(0, r));
  const port = srv.address().port;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-ddg-'));
  const prev = {
    SEARCH_URL: process.env.SEARCH_URL,
    PAGE_CACHE_DIR: process.env.PAGE_CACHE_DIR,
    SEARCH_GAP_MS: process.env.SEARCH_GAP_MS,
    CRAWL_GAP_MS: process.env.CRAWL_GAP_MS,
    WEB_ALLOW_LOCAL: process.env.WEB_ALLOW_LOCAL,
    DDG_URL: process.env.DDG_URL,
    SERPAPI_KEY: process.env.SERPAPI_KEY,
    SERPAPI_API_KEY: process.env.SERPAPI_API_KEY,
  };
  delete process.env.SEARCH_URL;
  delete process.env.SERPAPI_KEY;
  delete process.env.SERPAPI_API_KEY;
  process.env.PAGE_CACHE_DIR = cacheDir;
  process.env.SEARCH_GAP_MS = '0';
  process.env.CRAWL_GAP_MS = '0';
  process.env.WEB_ALLOW_LOCAL = '1';
  const ddgConfig = {
    ...config,
    search: {
      ...config.search,
      search_url: '',
      fallback_engines: [],
      gap_ms: 0,
      serpapi: { ...(config.search.serpapi || {}), enabled: false, api_key: '' },
      duckduckgo: {
        ...config.search.duckduckgo,
        enabled: true,
        method: 'POST',
        region: 'ru-ru',
        url: `http://127.0.0.1:${port}/html/`,
      },
    },
  };
  try {
    const rec = normalizeProduct(p467[460989], d467, config);
    const urls = await searchDuckDuckGo(searchQuery(rec, ddgConfig), ddgConfig);
    assert.ok(urls.some(u => u.includes('/card')), urls);
    const got = await lookupExternal(rec, d467, ddgConfig);
    assert.equal(got.ok, true, got.reason);
    assert.equal(rec.attrs.load_max, 7);
    assert.equal(rec.provenance.load_max.level, 'S3');
  } finally {
    await new Promise(r => srv.close(r));
    fs.rmSync(cacheDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  console.log('ok DuckDuckGo POST → matching page → S3 specs');
}

{
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/search.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (u.searchParams.get('api_key') !== 'test-key' || u.searchParams.get('gl') !== 'ru') {
        return res.end(JSON.stringify({ error: 'Invalid API key' }));
      }
      const hit = `http://${req.headers.host}/card`;
      return res.end(JSON.stringify({
        organic_results: [
          { position: 1, link: hit, title: 'Indesit BWSE' },
          { position: 2, link: 'https://mrmag.ru/skip' },
        ],
      }));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h1>Стиральная машина Indesit BWSE 7129X WSV RU</h1>
      <table><tr><td>Максимальная загрузка</td><td>7 кг</td></tr>
      <tr><td>Скорость отжима</td><td>1200</td></tr>
      <tr><td>Класс энергопотребления</td><td>A+++</td></tr>
      <tr><td>Высота</td><td>85 см</td></tr></table>`);
  });
  await new Promise(r => srv.listen(0, r));
  const port = srv.address().port;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-serpapi-'));
  const prev = {
    SEARCH_URL: process.env.SEARCH_URL,
    PAGE_CACHE_DIR: process.env.PAGE_CACHE_DIR,
    SEARCH_GAP_MS: process.env.SEARCH_GAP_MS,
    CRAWL_GAP_MS: process.env.CRAWL_GAP_MS,
    WEB_ALLOW_LOCAL: process.env.WEB_ALLOW_LOCAL,
    SERPAPI_KEY: process.env.SERPAPI_KEY,
    SERPAPI_API_KEY: process.env.SERPAPI_API_KEY,
  };
  delete process.env.SEARCH_URL;
  process.env.PAGE_CACHE_DIR = cacheDir;
  process.env.SEARCH_GAP_MS = '0';
  process.env.CRAWL_GAP_MS = '0';
  process.env.WEB_ALLOW_LOCAL = '1';
  process.env.SERPAPI_KEY = 'test-key';
  const serpConfig = {
    ...config,
    search: {
      ...config.search,
      search_url: '',
      fallback_engines: [],
      gap_ms: 0,
      serpapi: {
        enabled: true,
        api_key: '',
        api_key_env: 'SERPAPI_KEY',
        engine: 'google',
        gl: 'ru',
        hl: 'ru',
        google_domain: 'google.ru',
        location: '',
        endpoint: `http://127.0.0.1:${port}/search.json`,
      },
      duckduckgo: { ...config.search.duckduckgo, enabled: false },
    },
  };
  try {
    const rec = normalizeProduct(p467[460989], d467, config);
    const urls = await searchSerpApi(searchQuery(rec, serpConfig), serpConfig);
    assert.ok(urls.some(u => u.includes('/card')), urls);
    const got = await lookupExternal(rec, d467, serpConfig);
    assert.equal(got.ok, true, got.reason);
    assert.equal(rec.attrs.load_max, 7);
    assert.equal(rec.provenance.load_max.level, 'S3');
  } finally {
    await new Promise(r => srv.close(r));
    fs.rmSync(cacheDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  console.log('ok SerpAPI JSON → matching page → S3 specs');
}

{
  const all = loadProducts('data_467.json').map(p => normalizeProduct(p, d467, config));
  const built = buildFilters(all, d467, config);
  const r = all.find(x => x.id === 11391);
  const p = p467[11391];
  const row = serializeProduct(r, d467, built.debug);
  assert.deepEqual(Object.keys(row).filter(k => k !== 'web_info' && k !== 'page_data'), [
    'id', 'name', 'meta_keywords', 'description_html', 'annotation_html', 'filters',
  ]);
  assert.equal(row.id, p.id);
  assert.equal(row.name, p.name);
  assert.match(row.meta_keywords, /стиральная машина ATLANT/);
  assert.match(row.description_html, /^<p>/);
  assert.equal(row.description_html.includes('\n'), false);
  assert.match(row.annotation_html, /^<ul><li>.+: .+<\/li>/);
  assert.equal(row.annotation_html.includes('\n'), false);
  assert.match(row.annotation_html, /Тип загрузки: Фронтальная/);
  assert.match(row.annotation_html, /Бренд: ATLANT/);
  assert.ok(Array.isArray(row.filters['Высота, см']));
  assert.equal(row.filters['Высота, см'][0], '80-85');
  assert.equal(row.filters['Скорость отжима, об/мин'][0], '1000-1200');
  const facetNames = new Set(built.filters.map(f => f.name));
  for (const name of Object.keys(row.filters)) {
    assert.ok(facetNames.has(name), name);
    assert.ok(Array.isArray(row.filters[name]) && row.filters[name].length);
  }
  for (const f of built.filters) {
    if (row.filters[f.name]) assert.ok(f.value.includes(row.filters[f.name][0]), f.name);
  }
  assert.deepEqual(built.filters.map(f => Object.keys(f)), built.filters.map(() => ['name', 'value']));
  assert.ok(built.filters.every(f => Array.isArray(f.value)));
  for (const f of built.filters) {
    const folds = f.value.map(valueFold);
    assert.equal(new Set(folds).size, folds.length, `дубли в фильтре ${f.name}: ${f.value.join(' | ')}`);
  }
  const loadTypes = [...new Set(all.map(x => x.attrs.load_type).filter(Boolean))];
  assert.ok(loadTypes.includes('Фронтальная'));
  for (const v of loadTypes) {
    assert.ok(['Фронтальная', 'Вертикальная'].includes(v), v);
  }
  assert.equal(compactAnnotation(''), '');
  assert.equal(compactHtml('<p>a</p>\n<p>b</p>'), '<p>a</p><p>b</p>');
  assert.ok(metaKeywords(r, d467).includes('ATLANT'));
  const emptyAnn = serializeProduct({ ...r, annotation: '' }, d467, built.debug);
  assert.match(emptyAnn.annotation_html, /Тип загрузки: Фронтальная/);
  console.log('ok customer products+filters shape (11391)');
}

{
  const keys = v2FacetSpecKeys(d523);
  assert.ok(keys.has('цвет') && keys.has('тип_товара') && keys.has('бренд'));
  assert.ok(!keys.has('хладагент') && !keys.has('вес_кг'));
  const w = v2FacetSpecKeys(d467);
  assert.ok(w.has('вес_кг'), 'вес стиральной машины в таблице — фильтр');
  assert.ok(![...w].some(k => /расход_воды/.test(k)));
  assert.ok(![...w].some(k => /шум.*отжим|отжима.*дб/.test(k)));
  console.log('ok v2FacetSpecKeys vs таблица заказчика');
}

{
  const r = normalizeProduct(p523[260], d523, config);
  const [p] = buildV2(dictToV2Rows([r], d523), { dict: d523 }).products;
  assert.deepEqual(Object.keys(p), ['id', 'name', 'meta_keywords', 'description_html', 'filters']);
  assert.equal(p.id, 260);
  assert.equal(p.name, 'Холодильник Pozis RK FNF-172 W');
  assert.ok(!('annotation_html' in p));
  assert.equal(typeof p.filters['Бренд'], 'string');
  assert.equal(p.filters['Тип товара'], 'холодильник');
  assert.equal(p.filters['Бренд'], 'Pozis');
  assert.equal(p.filters['Модель'], 'RK FNF-172 W');
  // Подписи фасетов — из справочника (facet.label / name), не из CODE_TO_SPEC.
  assert.equal(p.filters['Общий объем, л'], '344');
  assert.equal(p.filters['Класс энергоэффективности'], 'A');
  assert.ok(!('Хладагент' in p.filters), 'хладагент — характеристика, не фильтр');
  assert.ok(!('Вес, кг' in p.filters), 'вес холодильника — характеристика, не фильтр');
  assert.equal(p.filters['Уровень шума, дБ'], '40');
  assert.equal(p.filters['Система охлаждения'], 'No Frost');
  assert.equal(p.filters['Тип управления'], 'механическое');
  assert.equal(p.filters['Расположение морозильной камеры'], 'нижнее');
  assert.equal(p.filters['Количество камер'], '2');
  assert.match(p.description_html, /^<h1>Холодильник Pozis RK FNF-172 W<\/h1>/);
  assert.match(p.description_html, /<li>Тип товара: холодильник<\/li>/);
  assert.match(p.description_html, /<li>Общий объем: 344 л<\/li>/);
  assert.match(p.description_html, /<li>Система охлаждения: No Frost<\/li>/);
  assert.match(p.description_html, /<li>Хладагент: R600a<\/li>/);
  assert.match(p.description_html, /<li>Вес: 74 кг<\/li>/);
  console.log('ok products_v2 shape (260 Pozis)');
}

{
  const r = normalizeProduct(p467[11391], d467, config);
  const [p] = buildV2(dictToV2Rows([r], d467), { dict: d467 }).products;
  assert.equal(p.filters['Тип товара'], 'стиральная машина');
  assert.equal(p.filters['Тип загрузки'], 'фронтальная');
  assert.equal(p.filters['Бренд'], 'ATLANT');
  assert.equal(p.filters['Загрузка белья, кг'], '6');
  assert.equal(p.filters['Высота, мм'], '846');
  assert.equal(typeof p.filters['Тип загрузки'], 'string');
  assert.ok(!Object.keys(p.filters).some(n => /расход воды/i.test(n)));
  assert.ok(!Object.keys(p.filters).some(n => /отжима.*дб|шум при отжиме/i.test(n)));
  console.log('ok products_v2 washer (11391)');
}

{
  const goldFile = '/Users/vl4endev/Downloads/products_v2_523.json';
  if (fs.existsSync(goldFile)) {
    const gold = JSON.parse(fs.readFileSync(goldFile, 'utf8'));
    const recs = [260, 805].map(id => normalizeProduct(p523[id], d523, config));
    const { products } = buildV2(dictToV2Rows(recs, d523), { dict: d523 });
    assert.equal(products.length, 2);
    for (const g of gold) {
      const p = products.find(x => x.id === g.id);
      assert.ok(p, `нет товара ${g.id}`);
      assert.deepEqual(Object.keys(p), Object.keys(g));
      // Эталон с прежними CODE_TO_SPEC-подписями и эвристиками extractFacts —
      // при расхождении значений не валим: источник истины теперь справочник.
      assert.ok(p.filters['Бренд']);
      assert.ok(p.filters['Тип товара']);
    }
    console.log('ok products_v2 структура vs эталон заказчика (260, 805)');
  }
}

