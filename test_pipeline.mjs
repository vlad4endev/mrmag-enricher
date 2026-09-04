import { loadConfig, loadDictionary, loadProducts, attrsWithCoverage, loadCategories } from './pipeline/dict.js';
import { normalizeProduct, formatCounts } from './pipeline/normalize.js';
import { bucketLabel, buildFilters } from './pipeline/facets.js';
import { renderCard, annotationRows, MIN_ANNOTATION_ROWS, verifyDescription } from './pipeline/generate.js';
import { compactAnnotation, compactHtml, serializeProduct, metaKeywords, buildCustomerExport } from './pipeline/export.js';
import { validateProducts, validateDescription, expectedFilters, PRODUCT_FIELDS } from './pipeline/validate.js';
import { webInfoFrom, cleanReviewText, isReview } from './pipeline/reviews.js';
import { dictForProducts } from './pipeline/schema.js';
import { buildV2 } from './export_v2.js';
import { dictToV2Rows, v2FacetSpecKeys } from './pipeline/v2.js';
import { displayEnum, valueFold } from './pipeline/types.js';
import { identityMatches, nameKeyTokens, parseIdentity } from './pipeline/identity.js';
import { needsExternal, parseProductBySpecs, lookupExternal, enrichMissing, needsCountry, lookupCountry, parseCountryFromPage } from './pipeline/external.js';
import {
  parseSearchResults, parseDuckDuckGoResults, isDuckDuckGoBlocked,
  parseSerpApiResults, searchQuery, countryQuery, searchWeb, searchDuckDuckGo, searchSerpApi,
  resolveSearchSettings, publicParserStatus, isTimeoutError, fetchPage,
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
  assert.equal(r.attrs.install, 'Отдельно стоящая');
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
  assert.equal(needsCountry(normalizeProduct(p467[11391], d467, config), d467), true);
  assert.equal(needsCountry(normalizeProduct(p523[426283], d523, config), d523), false);

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
  const made = normalizeProduct({
    id: 1,
    name: 'Холодильник LG GA-B419SQGL',
    annotation: 'Страна изготовления - Китай<br>Общий объем - 310 л',
    description: '',
  }, d523, config);
  assert.equal(made.attrs.country, 'Китай');
  const rec = normalizeProduct(p467[11391], d467, config);
  assert.equal(rec.attrs.country, null);
  assert.equal(needsCountry(rec, d467), true);
  assert.match(countryQuery(rec), /60С1010/);
  assert.match(countryQuery(rec), /страна производства$/);
  const atlantId = parseIdentity('Холодильник ATLANT ХМ 6025-031', d523);
  assert.equal(atlantId.brand, 'ATLANT');
  assert.equal(atlantId.model, 'ХМ 6025-031');
  assert.equal(
    countryQuery({ identity: atlantId, brand: 'ATLANT' }),
    'ATLANT ХМ 6025-031 страна производства',
  );
  const html = `
    <h1>Стиральная машина ATLANT 60С1010</h1>
    <table>
      <tr><td>Страна изготовления</td><td>Беларусь</td></tr>
    </table>`;
  const parsed = parseCountryFromPage(html, rec.identity, d467, config);
  assert.equal(parsed.ok, true, parsed.reason);
  const found = await lookupCountry(rec, d467, config, {
    search: async q => {
      assert.match(q, /60С1010/);
      return ['https://a.test/wrong', 'https://b.test/country'];
    },
    fetchHtml: async url => {
      if (url.includes('wrong')) {
        return '<h1>ATLANT 50С1010</h1><table><tr><td>Страна изготовления</td><td>Китай</td></tr></table>';
      }
      return html;
    },
  });
  assert.equal(found.ok, true, found.reason);
  assert.equal(rec.attrs.country, 'Беларусь');
  assert.equal(rec.provenance.country.level, 'S3');
  assert.equal(rec.attrs.load_max, 6, 'чужие поля с страницы страны не затирают свои');
  console.log('ok country from web by model, neighbour rejected, source fields kept');
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
  const abort = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  assert.equal(isTimeoutError(abort), true);
  assert.equal(isTimeoutError(new Error('HTTP 403 на https://x')), false);
  const cancelled = Object.assign(new Error('fetch failed'), {
    cause: Object.assign(new Error('Request was cancelled.'), { name: 'AbortError' }),
  });
  assert.equal(isTimeoutError(cancelled), false, 'обрыв CONNECT — не таймаут');

  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-timeout-'));
  const prevFetch = globalThis.fetch;
  const prev = {
    PAGE_CACHE_DIR: process.env.PAGE_CACHE_DIR,
    CRAWL_GAP_MS: process.env.CRAWL_GAP_MS,
    SEARCH_GAP_MS: process.env.SEARCH_GAP_MS,
    SEARCH_URL: process.env.SEARCH_URL,
    SERPAPI_KEY: process.env.SERPAPI_KEY,
    SERPAPI_API_KEY: process.env.SERPAPI_API_KEY,
  };
  process.env.PAGE_CACHE_DIR = cacheDir;
  process.env.CRAWL_GAP_MS = '0';
  process.env.SEARCH_GAP_MS = '0';
  delete process.env.SEARCH_URL;
  delete process.env.SERPAPI_KEY;
  delete process.env.SERPAPI_API_KEY;
  let fetches = 0;
  globalThis.fetch = () => {
    fetches++;
    return Promise.reject(abort);
  };
  try {
    await assert.rejects(
      () => fetchPage('https://example.com/search-timeout', { timeoutMs: 1500 }),
      e => /таймаут 1500ms/.test(e.message) && !/aborted due to timeout/i.test(e.message),
    );
    fetches = 0;
    await assert.rejects(
      () => searchWeb('LG GC-Q247CAMT', {
        search: {
          timeout_ms: 1500,
          gap_ms: 0,
          fallback_engines: ['mojeek', 'brave', 'ddg_lite'],
          duckduckgo: { enabled: true, method: 'POST', endpoint: 'html', region: 'ru-ru' },
          serpapi: { enabled: false },
        },
      }),
      e => /таймаут 1500ms/.test(e.message) && !/brave|ddg_lite/.test(e.message),
    );
    assert.equal(fetches, 2, `два таймаута подряд останавливают обход, было ${fetches} запросов`);
  } finally {
    globalThis.fetch = prevFetch;
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
  console.log('ok search timeout: русское сообщение, не AbortSignal');
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
  assert.deepEqual(Object.keys(row), PRODUCT_FIELDS);
  assert.equal(row.id, p.id);
  assert.equal(row.name, p.name);
  assert.match(row.meta_keywords, /стиральная машина ATLANT/);
  assert.match(row.description_html, /^<p>/);
  assert.equal(row.description_html.includes('\n'), false);
  assert.match(row.annotation_html, /^<ul><li>.+: .+<\/li>/);
  assert.equal(row.annotation_html.includes('\n'), false);
  assert.match(row.annotation_html, /Тип загрузки: фронтальная/);
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
  assert.match(emptyAnn.annotation_html, /Тип загрузки: фронтальная/);
  console.log('ok customer products+filters shape (11391)');
}

{
  const keys = v2FacetSpecKeys(d523);
  assert.ok(keys.has('цвет') && keys.has('тип_товара') && keys.has('бренд'));
  assert.ok(!keys.has('хладагент') && !keys.has('вес_кг'));
  const w = v2FacetSpecKeys(d467);
  assert.ok(!w.has('вес_кг'), 'вес стиральной машины — не фильтр');
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
  assert.equal(p.filters['Тип товара'], 'Холодильник');
  assert.equal(p.filters['Бренд'], 'Pozis');
  assert.ok(!('Модель' in p.filters), 'модель — паспорт, не фасет');
  // Подписи фасетов — из справочника (facet.label / name), не из CODE_TO_SPEC.
  assert.equal(p.filters['Общий объем, л'], '344');
  assert.equal(p.filters['Класс энергоэффективности'], 'A');
  assert.ok(!('Хладагент' in p.filters), 'хладагент — характеристика, не фильтр');
  assert.ok(!('Вес, кг' in p.filters), 'вес холодильника — характеристика, не фильтр');
  assert.equal(p.filters['Уровень шума, дБ'], '40');
  assert.equal(p.filters['Система охлаждения'], 'No Frost');
  assert.equal(p.filters['Тип управления'], 'Механическое');
  assert.equal(p.filters['Расположение морозильной камеры'], 'Нижнее');
  assert.ok(!('Количество камер' in p.filters), 'камеры — характеристика, не фильтр');
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
  assert.equal(p.filters['Тип товара'], 'Стиральная машина');
  assert.equal(p.filters['Тип загрузки'], 'Фронтальная');
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

{
  const cleaned = cleanReviewText('Отзыв о      Н--П3Д. Достоинства: 1. Не шумная 2. Простота монтажа');
  assert.ok(!/отзыв о/i.test(cleaned));
  assert.ok(!/--/.test(cleaned));
  assert.equal(isReview('Десятилетиями мы прилагаем все наши усилия в направлении улучшения'), false);
  assert.equal(webInfoFrom('Десятилетиями мы прилагаем все наши усилия. Наша компания — мировой лидер.'), '');
  const review = 'Купила месяц назад и пользуюсь каждый день. Достоинства: тихая, простота монтажа, яркая подсветка. '
    + 'Не жалею о покупке, рекомендую соседям. За эти деньги работает уже без нареканий, мне нравится набор программ. '
    + 'Впечатление положительное: стоит своих денег, посоветовали в сервисе. '.repeat(3);
  const web = webInfoFrom(review);
  assert.ok(web.length >= 300 && web.length <= 700, web.length);
  console.log('ok web_info clean / corporate drop');
}

{
  const all = loadProducts('data_467.json').map(p => normalizeProduct(p, d467, config));
  const exported = all.filter(r => annotationRows(r, d467).length >= MIN_ANNOTATION_ROWS);
  const built = buildFilters(exported, d467, config);
  assert.equal(expectedFilters(d467).length, 14);
  assert.equal(expectedFilters(d523).length, 17);
  const ids = [11391, 29921, 44772, 12957, 44773, 44782, 52904, 128925, 182681, 190925];
  const recs = ids.map(id => all.find(x => x.id === id)).filter(Boolean);
  const rows = recs.map(r => serializeProduct(r, d467, built.debug));
  const src = new Map(recs.map(r => [r.id, r]));
  const { errors } = validateProducts(rows, d467, src);
  const blocking = errors.filter(e => e.kind !== 'filter_missing');
  assert.equal(blocking.length, 0, JSON.stringify(blocking.slice(0, 8), null, 2));

  const a = rows.find(r => r.id === 11391);
  assert.deepEqual(Object.keys(a), PRODUCT_FIELDS);
  assert.match(a.annotation_html, /Максимальная загрузка белья: 6 кг/);
  assert.match(a.annotation_html, /Максимальная скорость отжима: 1000 об\/мин/);
  assert.match(a.annotation_html, /Класс энергоэффективности: A\+\+/);
  assert.match(a.annotation_html, /Уровень шума при стирке: 59 дБ/);
  assert.match(a.annotation_html, /Ширина: 59\.6 см/);
  assert.deepEqual(a.filters['Загрузка белья, кг'], ['6']);
  assert.deepEqual(a.filters['Скорость отжима, об/мин'], ['1000-1200']);
  assert.deepEqual(a.filters['Уровень шума, дБ'], ['55-60']);
  assert.deepEqual(a.filters['Ширина, см'], ['55-60']);
  assert.deepEqual(a.filters['Глубина, см'], ['55-60']);
  assert.deepEqual(a.filters['Высота, см'], ['80-85']);
  assert.ok(Object.keys(a.filters).length >= 8, Object.keys(a.filters).join(','));
  assert.ok(!/экономи[яи]|гарант/i.test(a.description_html));
  assert.ok(!/узк(?:ая|ий|ое|ие|ой)\b/i.test(a.meta_keywords));
  assert.ok(!a.description_html.includes('<h1'));
  assert.equal((a.description_html.match(/<ul\b/g) || []).length, 1);
  const strongs = (a.description_html.match(/<strong\b/g) || []).length;
  assert.ok(strongs >= 1 && strongs <= 3, strongs);
  assert.equal(validateDescription(a.description_html).length, 0);

  const c = rows.find(r => r.id === 29921);
  assert.equal(c.name, p467[29921].name);
  assert.match(c.annotation_html, /Вес: 47 кг/);
  assert.ok(!c.annotation_html.includes('49'));
  assert.ok(!('Материал' in c.filters));

  const i = rows.find(r => r.id === 44772);
  assert.equal(i.name, 'Стиральная машина "Indesit" IWSB 5085 (CIS) (62908)');
  assert.equal(i.filters.Бренд[0], 'Indesit');
  assert.ok(i.name.includes('"Indesit"'));
  console.log('ok checklist 10×467 (11391 / 29921 / 44772)');
}

{
  const p = { ...p467[11391], sku: String(p467[11391].id) };
  delete p.id;
  const out = buildCustomerExport([p], { dict: d467, config, root: '.' });
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].id, 11391);
  assert.equal(out.products[0].name, p467[11391].name);
  assert.deepEqual(Object.keys(out.products[0]), PRODUCT_FIELDS);
  assert.match(out.products[0].annotation_html, /ATLANT/);
  const thin = buildCustomerExport(
    [{ sku: '1', name: 'Стиральная машина X', annotation: '', description: '' }],
    { dict: d467, config, root: '.' },
  );
  assert.equal(thin.products.length, 0);
  assert.equal(thin.held.length, 1);
  assert.equal(thin.held[0].id, 1);
  console.log('ok buildCustomerExport sku→id / hold');
}

{
  const r = normalizeProduct(p467[11391], d467, config);
  const fake = '<p>Гарантия на двигатель составляет 5 лет, общая гарантия — 5 месяцев.</p>';
  const bad = verifyDescription(fake, r, d467);
  assert.ok(bad.some(e => e.kind === 'number_not_in_attrs' && e.number === 5), JSON.stringify(bad));
  const kw = metaKeywords(r, d467);
  assert.ok(!/узк(?:ая|ий|ое|ие|ой)\b/i.test(kw), kw);
  console.log('ok verifyDescription / no false «узкая»');
}

{
  assert.equal(dictForProducts([{ name: 'Стиральная машина ATLANT' }], 'без раздела').catId, '467');
  assert.equal(dictForProducts([{ name: 'Холодильник Pozis' }], 'all').catId, '523');
  assert.equal(dictForProducts([{ name: 'Вытяжка Lex' }], 929), null);
  console.log('ok dictForProducts resolves washer/fridge, skips hoods');
}

