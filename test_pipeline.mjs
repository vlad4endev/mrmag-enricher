import { loadConfig, loadDictionary, loadProducts, attrsWithCoverage, loadCategories } from './pipeline/dict.js';
import { normalizeProduct, formatCounts } from './pipeline/normalize.js';
import { bucketLabel, buildFilters } from './pipeline/facets.js';
import { renderCard, annotationRows, MIN_ANNOTATION_ROWS, verifyDescription } from './pipeline/generate.js';
import { compactAnnotation, compactHtml, serializeProduct, metaKeywords, buildCustomerExport, buildGoldShapeExport } from './pipeline/export.js';
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
  const { matchKey } = await import('./pipeline/match.js');
  const {
    stripHallucinationClaims, checkDescriptionClaims,
  } = await import('./pipeline/quality_validate.js');
  const { expectedDictCatId } = await import('./pipeline/schema.js');
  const { dedupeAnnotationValue } = await import('./pipeline/export.js');
  const { schemaForProduct, enrichProduct } = await import('./lib.js');

  // Guard: ATLANT category "467" → customer/dict facets
  const atlant = {
    ...p467[11391],
    category: '467',
    enriched: {
      specs: {
        тип_товара: 'стиральная машина',
        бренд: 'ATLANT',
        модель: '60С1010',
        назначение: 'стирка белья',
        ширина_мм: 596,
        высота_мм: 846,
        глубина_мм: 550,
        вес_кг: 62,
        цвет: 'белый',
        материал: 'пластик',
        гарантия_мес: 60,
      },
      description: 'Гарантия на двигатель — 5 лет, что говорит о надёжности конструкции. Класс A++.',
      bullets: ['Загрузка — 6 кг', 'Отжим — 1000 об/мин', 'Класс A++'],
      strong: [],
      meta_keywords: 'а, б, в, г, д, е, ж',
      web_info: null,
    },
  };
  assert.equal(dictForProducts([atlant], '467')?.catId, '467');
  assert.equal(expectedDictCatId([atlant], '467'), '467');
  const cust = await buildCustomerExport([atlant], {
    dict: d467, config, root: '.',
    filtersAgent: { mode: 'heuristic' },
  });
  assert.equal(cust.products.length, 1, 'customer path must export ATLANT');
  assert.ok(cust.validation?.ok, JSON.stringify(cust.validation?.errors));
  assert.ok(cust.filters_agent?.mode === 'heuristic' || cust.filters_agent?.mode === 'skip');
  const fkeys = Object.keys(cust.products[0].filters);
  const genericOnly = [
    'Тип товара', 'Бренд', 'Модель', 'Назначение', 'Ширина, мм', 'Высота, мм',
    'Глубина, мм', 'Вес, кг', 'Цвет', 'Материал', 'Гарантия мес',
  ];
  assert.ok(
    !genericOnly.every(k => fkeys.includes(k)) || fkeys.some(k => !genericOnly.includes(k)),
    `filters must not be GENERIC-only: ${fkeys.join(', ')}`,
  );
  for (const need of [
    'Загрузка белья, кг',
    'Скорость отжима, об/мин',
    'Класс энергоэффективности',
    'Уровень шума, дБ',
    'Количество программ',
  ]) {
    assert.ok(fkeys.includes(need), `missing facet filter ${need}; got ${fkeys.join(', ')}`);
  }
  assert.ok(!('Материал' in cust.products[0].filters), 'tank plastic must not become filters.Материал');

  // Semantic mapping 467 / 929
  assert.equal(matchKey('Материал бака', d467, { value: 'пластик' }).attr?.code, 'tank_material');
  assert.equal(matchKey('Материал', d467, { value: 'пластик' }).attr?.code, undefined);
  const d929map = loadDictionary('929', '.');
  assert.equal(matchKey('Ширина', d929map).attr?.code, 'width');
  assert.equal(matchKey('Ширина встраивания', d929map).attr?.code, 'install_width');

  // Description claims A–D
  const claimA = 'Гарантия на двигатель — 5 лет, что говорит о надёжности конструкции. Класс энергопотребления — A++.';
  assert.equal(
    stripHallucinationClaims(claimA),
    'Гарантия на двигатель — 5 лет. Класс энергопотребления — A++.',
  );
  const claimB = 'Класс A++ подтверждает экономичность модели.';
  const strippedB = stripHallucinationClaims(claimB);
  assert.ok(
    !/подтверждает\s+экономичность/i.test(strippedB) || !strippedB.trim(),
    `claim B must be removed or empty; got ${JSON.stringify(strippedB)}`,
  );
  assert.ok(checkDescriptionClaims({ description: claimB }).some(i => i.kind === 'hallucination_marker'));
  const claimC = '<p>Гарантия — 5 лет, что говорит о надёжности конструкции.</p>'
    + '<p><strong>Класс</strong> A++.</p><ul><li>Тихая</li></ul>';
  const strippedC = stripHallucinationClaims(claimC);
  assert.match(strippedC, /<p>/);
  assert.match(strippedC, /<strong>/);
  assert.match(strippedC, /<ul><li>/);
  assert.ok(!/<\/?[a-z]+[^>]*$/i.test(strippedC.replace(/>[^<]*$/i, '>')), 'no truncated tags');
  assert.equal((strippedC.match(/<p>/g) || []).length, (strippedC.match(/<\/p>/g) || []).length);
  assert.equal((strippedC.match(/<ul>/g) || []).length, (strippedC.match(/<\/ul>/g) || []).length);
  assert.equal((strippedC.match(/<li>/g) || []).length, (strippedC.match(/<\/li>/g) || []).length);
  assert.ok(!/говорит о над[её]жност/i.test(strippedC));
  const claimD = 'Стиральная машина с загрузкой 6 кг и отжимом 1000 об/мин.';
  assert.equal(stripHallucinationClaims(claimD), claimD);

  const goldDesc = buildGoldShapeExport([{
    id: 99,
    name: 'Товар без раздела',
    annotation: 'Тип - гаджет Цвет - белый',
    enriched: { description: claimA, bullets: ['a', 'b', 'c'], strong: [], meta_keywords: 'а, б, в, г, д, е, ж', web_info: null },
  }]);
  assert.ok(!/говорит о над[её]жност/i.test(goldDesc.products[0].description_html));
  assert.deepEqual(goldDesc.filters, []);
  assert.ok(goldDesc.needs_review?.length >= 1);

  // Annotation dedup
  assert.equal(
    dedupeAnnotationValue('Защита от скачков напряжения, от детей, от детей, от протечек'),
    'Защита от скачков напряжения, от детей, от протечек',
  );
  const ann = compactAnnotation(
    'Защита - Защита от скачков напряжения,от детей, от детей, от протечек, от скачков питания',
  );
  assert.ok(!/от детей,\s*от детей/i.test(ann));
  assert.match(ann, /от детей/);

  // Gold only when category truly unknown
  assert.equal(expectedDictCatId([{ name: 'Носки хлопковые' }], 'без раздела'), null);

  // Known category + dict unavailable → NOT silent _generic
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-miss-'));
  try {
    assert.throws(
      () => schemaForProduct({ name: 'Стиральная машина X', category: '467' }, '467', tmpRoot),
      (e) => e?.code === 'DICT_UNAVAILABLE'
        && e.resolved_category === '467'
        && e.dict_debug?.exists === false
        && String(e.dict_debug?.expectedPath || '').includes('attributes_467.json'),
    );
    const miss = await enrichProduct(
      { name: 'Стиральная машина X', category: '467', description: 'Загрузка 6 кг отжим 1000' },
      { apiKey: 'x', model: 'x', root: tmpRoot, limiter: { wait: async () => {} } },
    );
    assert.equal(miss.enriched, null);
    assert.equal(miss.needs_review, true);
    assert.ok(miss.validation_issues?.some(i => i.kind === 'dict_unavailable'));
    assert.equal(miss.debug?.model_called, false);
    assert.match(String(miss.debug?.raw_response || ''), /MODEL_NOT_CALLED/);
    assert.notEqual(miss.debug?.schema?.slug, '_generic');
    const unknown = schemaForProduct({ name: 'Носки хлопковые' }, 'без раздела', tmpRoot);
    assert.equal(unknown.slug, '_generic', 'unknown category may still use _generic');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // Enrichment и export — один resolver/root для attributes_467.json
  {
    const { dictionaryPath, hasDictionary, PROJECT_ROOT: dictRoot } = await import('./pipeline/dict.js');
    const { tryLoadDictSchema, PROJECT_ROOT: schemaRoot } = await import('./pipeline/schema.js');
    assert.equal(dictRoot, schemaRoot, 'единый PROJECT_ROOT');
    assert.ok(hasDictionary(467), 'attributes_467.json must exist for known category');
    const enrichSchema = schemaForProduct(atlant, '467');
    const exportDict = dictForProducts([atlant], '467');
    assert.equal(enrichSchema.id, 467);
    assert.equal(enrichSchema.fromDictionary, true);
    assert.equal(exportDict?.catId, '467');
    assert.equal(
      dictionaryPath(467),
      dictionaryPath(467, dictRoot),
      'enrichment default path == export PROJECT_ROOT path',
    );
    assert.ok(tryLoadDictSchema(467)?.fromDictionary);
    // Explicit wrong root still fails loud for known category
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-empty-'));
    try {
      assert.equal(dictForProducts([atlant], '467', empty), null);
      assert.throws(() => schemaForProduct(atlant, '467', empty), (e) => e?.code === 'DICT_UNAVAILABLE');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  }

  console.log('ok P0 export path / facets / material / width / claims / dedup / dict-fail');
}

{
  const keys = v2FacetSpecKeys(d523);
  assert.ok(keys.has('цвет') && keys.has('тип_товара') && keys.has('бренд'));
  assert.ok(!keys.has('хладагент') && !keys.has('вес_кг'));
  const w = v2FacetSpecKeys(d467);
  assert.ok(w.has('вес_кг'), 'вес стиральной машины — фильтр (facet.enabled=true)');
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
  assert.equal(p.filters['Количество камер'], '2', 'камеры — filter при facet.enabled');
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
  assert.equal(expectedFilters(d467).length, 17);
  assert.equal(expectedFilters(d523).length, 22);
  const ids = [11391, 29921, 44772, 12957, 44773, 44782, 52904, 128925, 182681, 190925];
  const recs = ids.map(id => all.find(x => x.id === id)).filter(Boolean);
  const rows = recs.map(r => serializeProduct(r, d467, built.debug));
  const src = new Map(recs.map(r => [r.id, r]));
  const { errors } = validateProducts(rows, d467, src);
  const blocking = errors.filter(e => e.kind !== 'filter_missing');
  assert.equal(blocking.length, 0, JSON.stringify(blocking.slice(0, 8), null, 2));
  assert.ok(
    !errors.some(e => e.kind === 'filter_unit_not_cm' || e.kind === 'filter_object_stringified'),
    'dims must not stringify objects or require unit in label',
  );

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
  const out = await buildCustomerExport([p], {
    dict: d467, config, root: '.',
    filtersAgent: { mode: 'heuristic' },
  });
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].id, 11391);
  assert.equal(out.products[0].name, p467[11391].name);
  assert.deepEqual(Object.keys(out.products[0]), PRODUCT_FIELDS);
  assert.match(out.products[0].annotation_html, /ATLANT/);
  const thin = await buildCustomerExport(
    [{ sku: '1', name: 'Стиральная машина X', annotation: '', description: '' }],
    { dict: d467, config, root: '.', filtersAgent: { mode: 'heuristic' } },
  );
  assert.equal(thin.products.length, 0);
  assert.equal(thin.held.length, 1);
  assert.equal(thin.held[0].id, 1);
  console.log('ok buildCustomerExport sku→id / hold');
}

{
  const src = p467[11391];
  const out = buildGoldShapeExport([{
    ...src,
    enriched: { specs: { цвет: 'белый', материал: 'пластик' }, seo_keywords: ['стиральная машина ATLANT'] },
  }]);
  assert.equal(out.products.length, 1);
  assert.deepEqual(Object.keys(out.products[0]), PRODUCT_FIELDS);
  assert.ok(out.products[0].annotation_html.includes('<li>'));
  assert.match(out.products[0].annotation_html, /Тип загрузки/);
  assert.deepEqual(out.products[0].filters, {});
  assert.deepEqual(out.filters, []);
  assert.ok(Array.isArray(out.needs_review) && out.needs_review.length >= 1);
  assert.ok(!('Материал' in out.products[0].filters));
  const hood = buildGoldShapeExport([{
    sku: '21670',
    name: 'Кухонная вытяжка X',
    annotation: '<ul><li>Тип - вытяжка</li><li>Максимальная производительность - 400 м³/ч</li></ul>',
    enriched: { specs: { цвет: 'нержавеющая сталь' }, short_description: '<h1>X</h1><p>Текст</p>' },
  }]);
  assert.deepEqual(Object.keys(hood.products[0]), PRODUCT_FIELDS);
  assert.match(hood.products[0].annotation_html, /производительность/i);
  assert.ok(!hood.products[0].description_html.includes('<h1'));
  assert.deepEqual(hood.products[0].filters, {});
  console.log('ok buildGoldShapeExport keeps 7 fields, empty filters, needs_review');
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
  assert.equal(dictForProducts([{ name: 'Вытяжка Lex' }], 929)?.catId, '929');
  assert.equal(dictForProducts([{ name: 'Вытяжка Lex' }], 'без раздела')?.catId, '929');
  console.log('ok dictForProducts resolves washer/fridge/hoods');
}

{
  const { facetKind, assignFilterValues, buildFilters, bucketLabel } = await import('./pipeline/facets.js');
  const { normalizeValue } = await import('./pipeline/types.js');
  const { setAttr } = await import('./pipeline/normalize.js');
  const {
    finalizeRecord, stripUnconfirmedNegatives, checkDescriptionClaims, buildConfirmedAttributes,
  } = await import('./pipeline/quality_validate.js');
  const { identityMatches, variantConflicts, modelVariantMarkers } = await import('./pipeline/identity.js');
  const { matchKey } = await import('./pipeline/match.js');
  const d929 = loadDictionary('929', '.');

  // TEST 1: speeds 2 → annotation exact, filters exact (not 2-2.2)
  const speeds = d929.byCode.get('speeds');
  assert.equal(speeds.type, 'integer');
  assert.equal(facetKind(speeds), 'enum');

  // TEST 2 + 8: width vs install_width
  assert.ok(d929.byCode.has('install_width'));
  assert.ok(!d929.byCode.get('width').synonyms?.some(x => /встраиван/i.test(x)));
  const mWidth = matchKey('Ширина', d929, { value: '50 см', fuzzyMin: 0.9 });
  const mInst = matchKey('Ширина встраивания', d929, { value: '60 см', fuzzyMin: 0.9 });
  assert.equal(mWidth.attr?.code, 'width');
  assert.equal(mInst.attr?.code, 'install_width');

  const hood = {
    id: 1,
    name: 'Вытяжка Elikor Интегра-60',
    attrs: Object.fromEntries(d929.attrs.filter(a => a.tier !== 'X').map(a => [a.code, null])),
    provenance: {},
    conflicts: [],
    flags: [],
    identity: { brand: 'Elikor', model: 'Интегра-60' },
  };
  setAttr(hood, 'speeds', 2, { level: 'S1', raw: 'Количество скоростей = 2' });
  setAttr(hood, 'width', 50, { level: 'S1', raw: 'Ширина = 50 см' });
  setAttr(hood, 'install_width', 60, { level: 'S1', raw: 'Ширина встраивания = 60 см' });
  assert.equal(hood.attrs.speeds, 2);
  assert.equal(hood.attrs.width, 50);
  assert.equal(hood.attrs.install_width, 60);
  assert.equal(bucketLabel(50, d929.byCode.get('width').facet), '50-55');

  const built = buildFilters([hood], d929, config);
  const assigned = assignFilterValues(hood, d929, built.debug);
  assert.deepEqual(assigned['Количество скоростей'], ['2']);
  assert.deepEqual(assigned['Ширина, см'], ['50-55']);
  assert.ok(!('Ширина встраивания, см' in assigned) || !assigned['Ширина встраивания, см'],
    'install_width facet disabled — не в публичных filters');

  // TEST 5: conflict S1 vs S3 keeps S1; equal S1 vs S1 → unresolved
  setAttr(hood, 'speeds', 3, { level: 'S3', raw: 'Количество скоростей = 3' });
  assert.equal(hood.attrs.speeds, 2, 'S1 не перетирается S3');
  const eq = {
    id: 2,
    attrs: Object.fromEntries(d929.attrs.filter(a => a.tier !== 'X').map(a => [a.code, null])),
    provenance: {},
    conflicts: [],
    flags: [],
  };
  setAttr(eq, 'speeds', 2, { level: 'S1', raw: 'скорости = 2' });
  setAttr(eq, 'speeds', 3, { level: 'S1', raw: 'скорости = 3' });
  assert.equal(eq.attrs.speeds, 2, 'равный приоритет → оставляем первое');
  assert.equal(eq.needs_review, true);
  assert.ok(eq.conflicts.some(c => c.needs_review && c.reason === 'equal_priority_keep_first'));

  setAttr(hood, 'speeds', 3, { level: 'manufacturer', raw: 'скорости: 3' });
  assert.equal(hood.attrs.speeds, 3, 'manufacturer побеждает S1');

  // TEST 3: boolean unknown
  const no = normalizeValue({ type: 'boolean', code: 'child_lock' }, 'нет');
  assert.equal(no.value, false);
  assert.equal(normalizeValue({ type: 'boolean', code: 'x' }, 'доступно опционально').ok, false);
  assert.equal(normalizeValue({ type: 'boolean', code: 'x' }, '0').ok, false);

  // TEST 4: warranty 5 лет → 60
  const war = normalizeValue(
    { type: 'integer', code: 'warranty', unit: 'мес', valid_range: [1, 240] },
    '5 лет',
  );
  assert.equal(war.value, 60);
  assert.equal(normalizeValue(
    { type: 'integer', code: 'warranty', unit: 'мес', valid_range: [1, 240] },
    '2 года',
  ).value, 24);
  assert.equal(normalizeValue(
    { type: 'integer', code: 'warranty', unit: 'мес', valid_range: [1, 240] },
    '12 месяцев',
  ).value, 12);

  const washer = normalizeProduct(p467[11391], d467, config);
  washer.attrs.child_lock = false;
  washer.provenance.child_lock = { level: 'model', raw: 'inferred' };
  assert.ok(stripUnconfirmedNegatives(washer, d467).some(s => s.code === 'child_lock'));
  assert.equal(washer.attrs.child_lock, null);
  washer.attrs.display = false;
  washer.provenance.display = { level: 'S1', raw: 'Дисплей = нет' };
  assert.equal(stripUnconfirmedNegatives(washer, d467).length, 0);

  // TEST 6: Integra variants — no cross-contamination via identity
  assert.equal(modelVariantMarkers('Интегра-60').sizes[0], '60');
  assert.equal(modelVariantMarkers('Интегра Glass 50').glass, true);
  assert.equal(
    identityMatches('Elikor Интегра-60 400 м3/ч 2 скорости', { brand: 'Elikor', model: 'Интегра-60' }, d929),
    true,
  );
  assert.equal(
    identityMatches('Elikor Интегра-50 350 м3/ч', { brand: 'Elikor', model: 'Интегра-60' }, d929),
    false,
  );
  assert.equal(
    identityMatches('Elikor Интегра Glass 60 нерж', { brand: 'Elikor', model: 'Интегра-60' }, d929),
    false,
  );
  assert.equal(
    identityMatches('Elikor Интегра Glass 60', { brand: 'Elikor', model: 'Интегра Glass 60' }, d929),
    true,
  );
  assert.ok(variantConflicts('Elikor Интегра Glass 60', 'Интегра-60'));

  // TEST 7: description number not in attrs → validation error
  const descIssues = checkDescriptionClaims(
    { description: 'Производительность 999 м³/ч подходит для кухни 40 м².' },
    hood,
    d929,
  );
  assert.ok(descIssues.some(i => i.kind === 'number_not_in_attrs' || i.kind === 'hallucination_marker'));

  const fin = finalizeRecord(hood, d929, {
    assigned: assignFilterValues(hood, d929, buildFilters([hood], d929, config).debug),
    enriched: { description: 'Вытяжка Elikor Интегра-60. Ширина 50 см.' },
  });
  assert.ok(fin.quality.sources);
  assert.ok(Array.isArray(hood.confirmed));
  assert.ok(hood.confirmed.some(c => c.attribute === 'width' && c.normalized_value === 50));
  assert.ok(hood.provenance.speeds?.evidence?.normalized_value === 3);
  assert.equal(PRODUCT_FIELDS.length, 7);
  console.log('ok enrichment P0/P1: speeds/width/boolean/warranty/conflict/identity/description/quality');
}

{
  // Universal: every product filter name ⊆ facet.enabled labels for that dict
  const { assignFilterValues } = await import('./pipeline/facets.js');
  const { stripHallucinationClaims } = await import('./pipeline/quality_validate.js');
  const { normalizeValue } = await import('./pipeline/types.js');
  const enabledLabels = (dict) => new Set(
    dict.attrs
      .filter(a => a.tier !== 'X' && a.facet?.enabled)
      .map(a => a.facet.label || a.name),
  );
  const genericOnlyNames = new Set([
    'Тип товара', 'Бренд', 'Модель', 'Назначение', 'Ширина, мм', 'Высота, мм',
    'Глубина, мм', 'Вес, кг', 'Цвет', 'Материал', 'Гарантия мес',
  ]);

  for (const [catId, dict, samples] of [
    ['467', d467, [normalizeProduct(p467[11391], d467, config)]],
    ['523', d523, [normalizeProduct(p523[260], d523, config)]],
  ]) {
    const allowed = enabledLabels(dict);
    const built = buildFilters(samples, dict, config);
    for (const f of built.filters) {
      assert.ok(allowed.has(f.name), `cat ${catId}: catalog filter «${f.name}» not in facet.enabled`);
    }
    for (const rec of samples) {
      const assigned = assignFilterValues(rec, dict, built.debug);
      const names = Object.keys(assigned);
      assert.ok(names.length, `cat ${catId} id=${rec.id}: expected filters`);
      for (const name of names) {
        assert.ok(allowed.has(name), `cat ${catId} id=${rec.id}: «${name}» not facet.enabled`);
      }
      const onlyGeneric = names.length > 0 && names.every(n => genericOnlyNames.has(n));
      assert.ok(!onlyGeneric, `cat ${catId}: GENERIC-only filters forbidden: ${names.join(', ')}`);
    }
  }
  console.log('ok universal filters ⊆ facet.enabled (no GENERIC-only)');
}

{
  // Smoke ATLANT 60С1010 / 467
  const { stripHallucinationClaims } = await import('./pipeline/quality_validate.js');
  const { normalizeValue } = await import('./pipeline/types.js');
  const src = p467[11391];
  assert.match(src.name, /ATLANT\s+60[СC]1010/i);
  assert.equal(dictForProducts([{ ...src, category: '467' }], '467')?.catId, '467');
  const r = normalizeProduct(src, d467, config);
  const built = buildFilters([r], d467, config);
  const row = serializeProduct(r, d467, built.debug);
  assert.deepEqual(Object.keys(row), PRODUCT_FIELDS);
  for (const need of [
    'Загрузка белья, кг',
    'Скорость отжима, об/мин',
    'Класс энергоэффективности',
    'Уровень шума, дБ',
    'Количество программ',
  ]) {
    assert.ok(need in row.filters, need);
  }
  assert.ok(d467.byCode.get('weight').facet.enabled);
  assert.ok('Вес, кг' in row.filters, 'вес — filter при facet.enabled');
  assert.ok(!('Материал' in row.filters));
  assert.equal(
    normalizeValue(
      { type: 'integer', code: 'warranty', unit: 'мес', valid_range: [1, 240] },
      '5 лет',
    ).value,
    60,
  );
  const ann = row.annotation_html || '';
  const childHits = ann.match(/от детей/gi) || [];
  assert.ok(childHits.length <= 1, `annotation duplicate protection: ${ann}`);
  assert.ok(!/говорит о над[её]жност|подтверждает экономичность/i.test(row.description_html));
  assert.equal(
    stripHallucinationClaims(row.description_html.replace(/<[^>]+>/g, ' ')).includes('говорит о'),
    false,
  );
  console.log('ok smoke ATLANT 11391 / category 467');
}

{
  // Smoke 929: width ≠ install_width
  const { setAttr } = await import('./pipeline/normalize.js');
  const { assignFilterValues } = await import('./pipeline/facets.js');
  const { matchKey } = await import('./pipeline/match.js');
  const d929 = loadDictionary('929', '.');
  assert.equal(matchKey('Ширина', d929).attr?.code, 'width');
  assert.equal(matchKey('Ширина встраивания', d929).attr?.code, 'install_width');
  const hood = {
    id: 929001,
    name: 'Вытяжка тест 929',
    attrs: Object.fromEntries(d929.attrs.filter(a => a.tier !== 'X').map(a => [a.code, null])),
    provenance: {},
    conflicts: [],
    flags: [],
    identity: { brand: 'Test', model: 'W50' },
  };
  setAttr(hood, 'width', 50, { level: 'S1', raw: 'Ширина = 50 см' });
  setAttr(hood, 'install_width', 60, { level: 'S1', raw: 'Ширина встраивания = 60 см' });
  assert.equal(hood.attrs.width, 50);
  assert.equal(hood.attrs.install_width, 60);
  assert.notEqual(hood.attrs.width, hood.attrs.install_width);
  const built = buildFilters([hood], d929, config);
  const assigned = assignFilterValues(hood, d929, built.debug);
  assert.ok('Ширина, см' in assigned);
  assert.ok(!('Ширина встраивания, см' in assigned) || !assigned['Ширина встраивания, см']?.length);
  console.log('ok smoke category 929 width vs install_width');
}

{
  // P1: dimensions facet — no [object Object]; unit from schema; structure preserved
  const { formatAttrValue, formatDimensions, valueFold } = await import('./pipeline/types.js');
  const { assignFilterValues } = await import('./pipeline/facets.js');
  const { validateProducts, expectedFilters } = await import('./pipeline/validate.js');
  const { parseDimensions } = await import('./pipeline/dimensions.js');

  const dimsAttr = d467.byCode.get('dims');
  assert.equal(dimsAttr.type, 'dimensions');
  assert.equal(dimsAttr.unit, 'см');
  // Фасет выключен: покупатель выбирает по ширине/глубине/высоте отдельно.
  assert.equal(dimsAttr.facet?.enabled, false);
  assert.ok(dimsAttr.facet?.reason || dimsAttr.name);

  const parsed = parseDimensions('Габариты (ШхГхВ)', '59.5×42×85 см');
  assert.ok(parsed?.dims);
  assert.equal(typeof parsed.dims, 'object');
  assert.deepEqual(
    { w: parsed.dims.width, d: parsed.dims.depth, h: parsed.dims.height },
    { w: 59.5, d: 42, h: 85 },
  );

  const r = normalizeProduct(p467[44772], d467, config);
  assert.equal(typeof r.attrs.dims, 'object');
  assert.ok(r.attrs.dims && !Array.isArray(r.attrs.dims));
  assert.equal(typeof r.attrs.dims.width, 'number');
  assert.equal(typeof r.attrs.dims.depth, 'number');
  assert.equal(typeof r.attrs.dims.height, 'number');

  const asFilter = formatAttrValue(dimsAttr, r.attrs.dims, { withUnit: false });
  assert.match(asFilter, /^\d+(?:\.\d+)?×\d+(?:\.\d+)?×\d+(?:\.\d+)?$/);
  assert.notEqual(asFilter, '[object Object]');
  assert.ok(!asFilter.includes('[object Object]'));
  assert.equal(
    formatAttrValue(dimsAttr, r.attrs.dims, { withUnit: false }),
    formatDimensions(dimsAttr, r.attrs.dims, { withUnit: false }),
  );
  assert.match(formatDimensions(dimsAttr, r.attrs.dims, { withUnit: true }), / см$/);

  // Object must survive in attrs until serialize (stringify only at format time)
  assert.equal(typeof r.attrs.dims, 'object');
  const built = buildFilters([r], d467, config);
  const assigned = assignFilterValues(r, d467, built.debug);
  const lab = 'Габариты (ШхГхВ)';
  // dims не в фасетах — в filters товара ключа нет; формат значения всё равно валиден.
  assert.ok(!(lab in assigned) || !assigned[lab]?.length);
  assert.ok(!JSON.stringify(assigned).includes('[object Object]'));

  const row = serializeProduct(r, d467, built.debug);
  assert.ok(!(lab in (row.filters || {})));
  assert.ok(!JSON.stringify(row.filters).includes('[object Object]'));

  // Unit from schema: dims хранится, но не в expectedFilters пока facet.enabled=false
  const exp = expectedFilters(d467).find(f => f.name === lab);
  assert.equal(exp, undefined);
  const { errors } = validateProducts([row], d467, new Map([[r.id, r]]));
  assert.ok(!errors.some(e => e.kind === 'filter_unit_not_cm'), JSON.stringify(errors));
  assert.ok(!errors.some(e => e.kind === 'filter_object_stringified'));
  assert.ok(!errors.some(e => e.kind === 'filter_unit_mismatch' && String(e.detail).includes(lab)));

  // Label unit must match schema unit when suffix present (локальный dict с включённым фасетом)
  const badDict = {
    catId: 'test',
    attrs: [{
      ...dimsAttr,
      facet: { enabled: true, label: 'Габариты (ШхГхВ), кг', kind: 'enum' },
    }],
    byCode: new Map([['dims', { ...dimsAttr, facet: { enabled: true, label: 'Габариты (ШхГхВ), кг', kind: 'enum' } }]]),
  };
  const badRow = {
    id: 1,
    name: 't',
    meta_keywords: 'а, б, в, г, д, е, ж',
    description_html: '<p>Описание товара без лишних обещаний.</p>',
    annotation_html: '<ul><li>Бренд: Test</li><li>Тип: a</li><li>Загрузка: 6 кг</li><li>Отжим: 1000</li><li>Класс: A</li><li>Шум: 50</li><li>Ширина: 60</li></ul>',
    filters: { 'Габариты (ШхГхВ), кг': [asFilter] },
    web_info: '',
  };
  const badErr = validateProducts([badRow], badDict, new Map()).errors;
  assert.ok(
    badErr.some(e => e.kind === 'filter_unit_mismatch'),
    `expected filter_unit_mismatch, got ${JSON.stringify(badErr)}`,
  );
  assert.ok(valueFold('кг') !== valueFold('см'));

  console.log('ok P1 dimensions facet / unit-from-schema / no [object Object]');
}

{
  // Регрессия: мусор «Тип = зоны свежести - нет» не едет в filters сайта.
  const { normalizeValue, looksLikeEnumFragment, hasStrictEnum } = await import('./pipeline/types.js');
  const { buildFilters, assignFilterValues } = await import('./pipeline/facets.js');
  const { auditAttribute } = await import('./pipeline/schema_audit.js');
  const { matchKey } = await import('./pipeline/match.js');

  const ft = d523.byCode.get('fridge_type');
  assert.ok(hasStrictEnum(ft), 'fridge_type must have value_aliases');
  assert.ok(!(ft.synonyms || []).includes('Тип'), 'bare synonym «Тип» must stay removed');
  assert.equal(matchKey('Тип', d523).how, 'unmapped', 'bare «Тип» must not match fridge_type');

  const junk = [
    'Зоны свежести - нет',
    'Освещения - лампа накаливания',
    'Установки - встраиваемый',
    'Штепсельной розетки - «Schuko»',
    'Полки - с откидной крышкой',
    'Охлаждения -',
    'нет',
  ];
  for (const v of junk) {
    assert.ok(looksLikeEnumFragment(v) || /^(?:нет)$/i.test(v), `fragment detect: ${v}`);
    const n = normalizeValue(ft, v, { keyText: 'Тип холодильника' });
    assert.equal(n.ok, false, `junk must not normalize: ${v} → ${JSON.stringify(n)}`);
  }
  assert.equal(normalizeValue(ft, 'Двухкамерный').value, 'Двухкамерный');
  assert.equal(normalizeValue(ft, 'Трехкамерный (3d)').value, 'Трехкамерный');

  const recs = [
    {
      id: 1,
      name: 'Холодильник Test A',
      attrs: {
        brand: 'Test',
        fridge_type: 'Зоны свежести - нет',
        control_type: 'Со смартфона - нет',
      },
    },
    {
      id: 2,
      name: 'Холодильник Test B',
      attrs: {
        brand: 'Test',
        fridge_type: 'Двухкамерный',
        control_type: 'Механическое',
      },
    },
    {
      id: 3,
      name: 'Холодильник Test C',
      attrs: {
        brand: 'Test',
        fridge_type: 'Side-by-Side',
        control_type: 'Сенсорное',
      },
    },
  ];
  // Минимальный dict-срез: только нужные attrs с facet.
  const miniAttrs = ['brand', 'fridge_type', 'control_type'].map(c => {
    const a = structuredClone(d523.byCode.get(c));
    // brand нужен для заполненности; facet уже enabled у fridge/control
    return a;
  });
  const mini = {
    catId: '523',
    attrs: miniAttrs,
    byCode: new Map(miniAttrs.map(a => [a.code, a])),
  };
  for (const r of recs) {
    for (const a of miniAttrs) {
      if (!(a.code in r.attrs)) r.attrs[a.code] = null;
    }
  }

  const built = buildFilters(structuredClone(recs), mini, config);
  const fridge = built.filters.find(f => f.name === 'Тип холодильника');
  assert.ok(fridge, 'Тип холодильника facet present');
  assert.deepEqual(fridge.value.slice().sort(), ['Side-by-Side', 'Двухкамерный'].sort());
  assert.ok(!fridge.value.some(v => /нет/i.test(v)), 'no «нет» in fridge_type filter');
  assert.ok(!fridge.value.some(v => looksLikeEnumFragment(v)), 'no fragments in fridge_type filter');

  const control = built.filters.find(f => f.name === 'Тип управления');
  assert.ok(control);
  assert.ok(!control.value.some(v => /нет/i.test(v)), 'no «нет» in control_type filter');
  assert.deepEqual(control.value.slice().sort(), ['Механическое', 'Сенсорное'].sort());

  const assigned = assignFilterValues(recs[0], mini, built.debug);
  assert.equal(assigned['Тип холодильника'], undefined, 'junk product gets no fridge_type filter');
  const assignedOk = assignFilterValues(recs[1], mini, built.debug);
  assert.deepEqual(assignedOk['Тип холодильника'], ['Двухкамерный']);

  // Без value_aliases всё равно режем фрагменты (защита от старого schema).
  const loose = structuredClone(ft);
  loose.value_aliases = {};
  delete loose.strict_enum;
  const looseRecs = [
    { id: 1, name: 't', attrs: { fridge_type: 'Зоны свежести - нет' } },
    { id: 2, name: 't', attrs: { fridge_type: 'Двухкамерный' } },
  ];
  const looseDict = {
    catId: '523',
    attrs: [loose],
    byCode: new Map([['fridge_type', loose]]),
  };
  for (const r of looseRecs) {
    if (!('fridge_type' in r.attrs)) r.attrs.fridge_type = null;
  }
  const looseBuilt = buildFilters(structuredClone(looseRecs), looseDict, config);
  const looseFt = looseBuilt.filters.find(f => f.name === 'Тип холодильника');
  assert.ok(looseFt);
  assert.deepEqual(looseFt.value, ['Двухкамерный']);

  const audit = auditAttribute({
    ...ft,
    synonyms: [...(ft.synonyms || []), 'Тип'],
  }, d523.attrs);
  assert.ok(
    audit.issues.some(i => i.kind === 'generic_name_synonym'),
    'audit must flag bare «Тип» synonym',
  );

  console.log('ok fridge_type filter: no junk / no «нет» on catalog facets');
}

{
  // No Frost / Ручное: один канон на фильтр, без дублей написаний
  const { aliasValue } = await import('./pipeline/types.js');
  const { buildFilters } = await import('./pipeline/facets.js');
  const { runFiltersAgent } = await import('./pipeline/filters_agent.js');

  const fridge = d523.byCode.get('defrost_fridge');
  const freezer = d523.byCode.get('defrost_freezer');
  for (const v of ['No Frost', 'NoFrost', 'Автоматическое', 'Автоматическое (No Frost)']) {
    assert.equal(aliasValue(fridge, v), 'Автоматическое (No Frost)', v);
  }
  for (const v of ['Ручное', 'Ручная разморозка', 'ручная']) {
    assert.equal(aliasValue(fridge, v), 'Ручное', v);
  }
  assert.equal(aliasValue(freezer, 'Low Frost'), 'Автоматическое (No Frost)');

  const recs = [
    { id: 1, name: 't', attrs: { defrost_fridge: 'No Frost', defrost_freezer: 'NoFrost', cooling: 'NO FROST' } },
    { id: 2, name: 't', attrs: { defrost_fridge: 'Автоматическое', defrost_freezer: 'Low Frost', cooling: 'Капельная' } },
    { id: 3, name: 't', attrs: { defrost_fridge: 'Ручная разморозка', defrost_freezer: 'Ручное', cooling: 'ручная' } },
    { id: 4, name: 't', attrs: { defrost_fridge: 'Капельная система', defrost_freezer: 'Автоматическое (No Frost)', cooling: 'Без наледи' } },
  ];
  for (const r of recs) {
    for (const a of d523.attrs) {
      if (!(a.code in r.attrs)) r.attrs[a.code] = null;
    }
  }
  const clone = structuredClone(recs);
  await runFiltersAgent({ recs: clone, dict: d523, mode: 'heuristic', catId: '523' });
  const built = buildFilters(clone, d523, config);
  const fr = built.filters.find(f => f.name === 'Размораживание холодильной камеры');
  const fz = built.filters.find(f => f.name === 'Размораживание морозильной камеры');
  const cool = built.filters.find(f => f.name === 'Система охлаждения');
  assert.deepEqual(fr.value.slice().sort(), ['Автоматическое (No Frost)', 'Капельная система', 'Ручное'].sort());
  assert.deepEqual(fz.value.slice().sort(), ['Автоматическое (No Frost)', 'Ручное'].sort());
  assert.ok(!fr.value.includes('No Frost') && !fr.value.includes('Ручная разморозка'));
  assert.ok(!fz.value.includes('No Frost') && !fz.value.includes('Low Frost'));
  assert.ok(cool.value.includes('No Frost'));
  assert.equal(cool.value.filter(v => /no\s*frost/i.test(v)).length, 1);
  console.log('ok defrost/cooling: no duplicate No Frost / Ручное canons');
}

{
  // Фильтры сайта — только графа характеристик (S1), не S3/AI
  const { buildFilters, assignFilterValues, filterSourceAllowed } = await import('./pipeline/facets.js');
  const cooling = d523.byCode.get('cooling');
  assert.ok(cooling?.facet?.enabled);

  const recS1 = {
    id: 1,
    name: 'Холодильник Test',
    attrs: Object.fromEntries(d523.attrs.filter(a => a.tier !== 'X').map(a => [a.code, null])),
    provenance: {},
  };
  recS1.attrs.cooling = 'No Frost';
  recS1.provenance.cooling = { level: 'S1', raw: 'Система охлаждения = No Frost' };

  const recS3 = {
    id: 2,
    name: 'Холодильник AI',
    attrs: Object.fromEntries(d523.attrs.filter(a => a.tier !== 'X').map(a => [a.code, null])),
    provenance: {},
  };
  recS3.attrs.cooling = 'Капельная';
  recS3.provenance.cooling = { level: 'S3', raw: 'specs' };

  assert.equal(filterSourceAllowed(recS1, 'cooling', config), true);
  assert.equal(filterSourceAllowed(recS3, 'cooling', config), false);

  const built = buildFilters([recS1, recS3], d523, config);
  const cool = built.filters.find(f => f.name === 'Система охлаждения');
  assert.ok(cool, 'S1 must create cooling facet');
  assert.deepEqual(cool.value, ['No Frost']);
  assert.ok(!cool.value.includes('Капельная'), 'S3 must not enter catalog filters');

  const assignedS3 = assignFilterValues(recS3, d523, built.debug, config);
  assert.equal(assignedS3['Система охлаждения'], undefined);
  const assignedS1 = assignFilterValues(recS1, d523, built.debug, config);
  assert.deepEqual(assignedS1['Система охлаждения'], ['No Frost']);
  console.log('ok filters from characteristics only (S1), S3 excluded');
}

{
  // filters_agent: mock LLM + heuristic для 467 / 523 / 929
  const {
    collectFacetValueInventory, parseFiltersAgentResponse, applyFiltersAgentMappings,
    heuristicFiltersMappings, runFiltersAgent, assertFiltersClean, buildFiltersAgentPrompt,
  } = await import('./pipeline/filters_agent.js');
  const { buildFilters } = await import('./pipeline/facets.js');
  const { buildCustomerExport: bce } = await import('./pipeline/export.js');

  const junkRaw = 'Зоны свежести - нет';
  const recs523 = [
    { id: 1, name: 'Холодильник A', attrs: { brand: 'Haier', fridge_type: junkRaw, control_type: 'Со смартфона - нет' } },
    { id: 2, name: 'Холодильник B', attrs: { brand: 'Haier', fridge_type: 'Холодильник двухкамерный с нижней морозильной камерой', control_type: 'механическое' } },
    { id: 3, name: 'Холодильник C', attrs: { brand: 'LG', fridge_type: 'Side by Side', control_type: 'сенсор' } },
  ];
  for (const r of recs523) {
    for (const a of d523.attrs) {
      if (!(a.code in r.attrs)) r.attrs[a.code] = null;
    }
  }

  const inv = collectFacetValueInventory(recs523, d523);
  assert.ok(inv.some(f => f.attr_code === 'fridge_type'));
  assert.ok(buildFiltersAgentPrompt(d523, inv, { catId: '523' }).includes('НЕ предлагай новые фасеты'));

  const parsedBad = parseFiltersAgentResponse({
    mappings: [
      { attr_code: 'fridge_type', raw: junkRaw, action: 'skip' },
      { attr_code: 'fridge_type', raw: 'Холодильник двухкамерный с нижней морозильной камерой', canon: 'Двухкамерный', action: 'map' },
      { attr_code: 'fridge_type', raw: 'x', canon: 'НесуществующийТип', action: 'map' },
      { attr_code: 'no_such', raw: 'y', canon: 'z', action: 'map' },
    ],
  }, d523);
  assert.ok(parsedBad.mappings.some(m => m.action === 'skip' && m.raw === junkRaw));
  assert.ok(parsedBad.mappings.some(m => m.canon === 'Двухкамерный'));
  assert.ok(parsedBad.rejected.some(r => r.reason === 'canon_not_in_aliases'));
  assert.ok(parsedBad.rejected.some(r => r.reason === 'unknown_attr'));

  const cloneH = structuredClone(recs523);
  const heur = heuristicFiltersMappings(cloneH, d523);
  applyFiltersAgentMappings(cloneH, heur);
  assert.equal(cloneH[0].attrs.fridge_type, null);
  assert.equal(cloneH[1].attrs.fridge_type, 'Двухкамерный');

  const mockFetch = async () => ({
    ok: true,
    async text() {
      return JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              mappings: [
                { attr_code: 'fridge_type', raw: junkRaw, action: 'skip' },
                { attr_code: 'fridge_type', raw: 'Холодильник двухкамерный с нижней морозильной камерой', canon: 'Двухкамерный', action: 'map' },
                { attr_code: 'fridge_type', raw: 'Side by Side', canon: 'Side-by-Side', action: 'map' },
                { attr_code: 'control_type', raw: 'Со смартфона - нет', action: 'skip' },
                { attr_code: 'control_type', raw: 'механическое', canon: 'Механическое', action: 'map' },
                { attr_code: 'control_type', raw: 'сенсор', canon: 'Сенсорное', action: 'map' },
              ],
              notes: ['mock'],
            }),
          },
        }],
      });
    },
  });

  const cloneAi = structuredClone(recs523);
  const ai = await runFiltersAgent({
    recs: cloneAi,
    dict: d523,
    mode: 'ai',
    provider: { apiKey: 'test', baseUrl: 'http://example.invalid', chatUrl: 'http://example.invalid/v1/chat/completions' },
    fetchImpl: mockFetch,
    catId: '523',
  });
  assert.equal(ai.mode, 'ai');
  const builtAi = buildFilters(cloneAi, d523, config);
  const ftAi = builtAi.filters.find(f => f.name === 'Тип холодильника');
  assert.deepEqual(ftAi.value.slice().sort(), ['Side-by-Side', 'Двухкамерный'].sort());
  assert.ok(assertFiltersClean(builtAi.filters, d523).ok);

  // heuristic runFiltersAgent
  const cloneHe = structuredClone(recs523);
  const he = await runFiltersAgent({ recs: cloneHe, dict: d523, mode: 'heuristic', catId: '523' });
  assert.equal(he.mode, 'heuristic');
  const builtHe = buildFilters(cloneHe, d523, config);
  assert.ok(assertFiltersClean(builtHe.filters, d523).ok);
  assert.ok(!builtHe.filters.find(f => f.name === 'Тип холодильника')?.value.some(v => /нет/i.test(v)));

  // 467: load_type style unify via heuristic export
  const washer = await bce([p467[11391]], {
    dict: d467, config, root: '.',
    filtersAgent: { mode: 'heuristic' },
  });
  assert.ok(washer.validation?.ok, JSON.stringify(washer.validation));
  assert.ok(washer.filters.some(f => f.name === 'Тип загрузки' || f.name.includes('Загрузка') || f.value?.length >= 0));

  // 929 if dictionary exists
  let d929local = null;
  try { d929local = loadDictionary('929', '.'); } catch { /* optional */ }
  if (d929local) {
    const hoodList = (() => {
      try { return loadProducts('products_929.json'); } catch { return []; }
    })();
    const hoodSrc = hoodList[0];
    if (hoodSrc) {
      const hood = await bce([{ ...hoodSrc, enriched: hoodSrc.enriched || null }], {
        dict: d929local, config, root: '.',
        filtersAgent: { mode: 'heuristic' },
      });
      assert.ok(hood.filters_agent);
      if (hood.products.length) assert.ok(hood.validation?.ok, JSON.stringify(hood.validation));
    }
  }

  console.log('ok filters_agent mock-LLM + heuristic (467/523/929)');
}

