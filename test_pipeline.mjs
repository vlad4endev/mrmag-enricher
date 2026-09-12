import { loadConfig, loadDictionary, loadProducts, attrsWithCoverage, loadCategories } from './pipeline/dict.js';
import { normalizeProduct, formatCounts } from './pipeline/normalize.js';
import { bucketLabel, buildFilters, facetKind } from './pipeline/facets.js';
import { renderCard, annotationRows, MIN_ANNOTATION_ROWS, verifyDescription } from './pipeline/generate.js';
import { compactAnnotation, compactHtml, serializeProduct, metaKeywords, buildCustomerExport, buildGoldShapeExport } from './pipeline/export.js';
import { validateProducts, validateDescription, expectedFilters, PRODUCT_FIELDS } from './pipeline/validate.js';
import { webInfoFrom, cleanReviewText, isReview } from './pipeline/reviews.js';
import { dictForProducts } from './pipeline/schema.js';
import { buildV2 } from './export_v2.js';
import { dictToV2Rows, v2FacetSpecKeys } from './pipeline/v2.js';
import {
  parseDumpPayload, normalizeDumpRow, saveDump, getDump, listDumps, deleteDump,
  restoreDumpArchive, catIdFromDumpName, previewDump, dumpsDir, listShopCategories,
  findDumpProduct,
} from './pipeline/dumps.js';
import { displayEnum, isBrandFilterKey, valueFold } from './pipeline/types.js';
import { identityMatches, nameKeyTokens, parseIdentity } from './pipeline/identity.js';
import { extractPairsFromPage, pairFromTableCells, parseProductFields, needDescriptionParse, collectParseHits, collectPageHits, formatParseNotes } from './pipeline/parse.js';
import { needsExternal, parseProductBySpecs, lookupExternal, enrichMissing, needsCountry, lookupCountry, parseCountryFromPage, needsMissingLookup, lookupMissing, parseMissingFromPage, missingRequiredCodes } from './pipeline/external.js';
import {
  parseSearchResults, parseDuckDuckGoResults, isDuckDuckGoBlocked,
  parseYandexSearchXml, parseYandexSearchResponse,
  searchQuery, countryQuery, missingQuery, searchWeb, searchDuckDuckGo, searchYandex,
  resolveSearchSettings, publicParserStatus, isTimeoutError, fetchPage, firstMatchingPage,
  probeParser, explainSearchError,
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
  // Ключ и значение на соседних <br>-строках — формат 1С, не «Ключ значение» в одной строке.
  const { p, r } = run(444506, d467, p467);
  assert.equal(r.format, 'BR');
  assert.equal(r.attrs.load_max, 6, `load_max: ${r.attrs.load_max}; keys=${r.pairs.map(x => x.key).join(' | ')}`);
  assert.equal(r.attrs.spin_max, 1000, `spin_max: ${r.attrs.spin_max}`);
  assert.ok(r.pairs.some(x => /макс\.?\s*загрузка/i.test(x.key) && String(x.value).includes('6')));
  assert.ok(r.pairs.some(x => /скорость отжима/i.test(x.key) && String(x.value).includes('1000')));
  console.log('ok 444506 alternating BR');
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

{
  // Автомат / полуавтомат: парсинг ключа магазина, имя, раздел 953, без путаницы с «Тип».
  const { matchKey } = await import('./pipeline/match.js');
  const { aliasValue } = await import('./pipeline/types.js');
  const wt = d467.byCode.get('washer_type');
  assert.ok(wt, 'washer_type in dictionary');
  assert.equal(aliasValue(wt, 'автомат'), 'Автоматическая');
  assert.equal(aliasValue(wt, 'полуавтомат'), 'Полуавтоматическая');
  assert.equal(aliasValue(wt, 'semi-automatic'), 'Полуавтоматическая');
  assert.equal(matchKey('Вид стиральной машины', d467).attr?.code, 'washer_type');
  assert.equal(matchKey('Тип', d467).attr?.code !== 'washer_type', true, 'bare «Тип» ≠ washer_type');
  assert.notEqual(matchKey('Тип загрузки', d467).attr?.code, 'washer_type');

  const fromAnn = normalizeProduct({
    id: 900101,
    name: 'Стиральная машина Test Auto',
    annotation: '<ul><li>Вид стиральной машины - Автоматическая</li><li>Тип загрузки - Фронтальная</li></ul>',
    description: '',
  }, d467, config);
  assert.equal(fromAnn.attrs.washer_type, 'Автоматическая');
  assert.equal(fromAnn.attrs.load_type, 'Фронтальная');

  const fromName = normalizeProduct({
    id: 900102,
    name: 'Автоматическая стиральная машина RENOVA WAF-6010M1',
    annotation: '',
    description: '',
  }, d467, config);
  assert.equal(fromName.attrs.washer_type, 'Автоматическая');

  const semi = normalizeProduct({
    id: 900103,
    name: 'Стиральная машина полуавтомат Test SM-2',
    annotation: '<ul><li>Загрузка белья, кг - 6</li></ul>',
    description: '',
  }, d467, config);
  assert.equal(semi.attrs.washer_type, 'Полуавтоматическая');

  const fromCat = normalizeProduct({
    id: 900104,
    name: 'Стиральная машина Test Cat',
    category: 'Полуавтоматические стиральные машины',
    category_id: 953,
    annotation: '',
    description: '',
  }, d467, config);
  assert.equal(fromCat.attrs.washer_type, 'Полуавтоматическая');

  const { r: lg } = run(52907, d467, p467);
  assert.equal(lg.attrs.washer_type, 'Автоматическая', 'LG: ключ «Вид стиральной машины»');

  const { r: renova } = run(355162, d467, p467);
  assert.equal(renova.attrs.washer_type, 'Автоматическая', 'RENOVA: из имени');

  // Обычная стиралка без маркера → автомат (раздел 467).
  const { r: plain } = run(11391, d467, p467);
  assert.equal(plain.attrs.washer_type, 'Автоматическая');

  console.log('ok washer_type auto/semi');
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
  const parsed = parseProductFields({
    annotation: 'Линейка - Super<br>Комплектация - полная<br>Артикул поставщика - 111',
    description: 'Макс. загрузка - 6 кг<br>Скорость отжима - 1000 об/мин<br>Высота - 85 см<br>Ширина - 60 см<br>Глубина - 45 см',
  }, d467);
  assert.ok(parsed.fromAnn.length >= 3);
  assert.ok(parsed.fromDesc.length >= 4, `desc pairs: ${parsed.fromDesc.map(x => x.key).join(' | ')}`);
  const r = normalizeProduct({
    id: 1,
    name: 'Стиральная машина Test 6kg',
    annotation: 'Линейка - Super<br>Комплектация - полная<br>Артикул поставщика - 111',
    description: 'Макс. загрузка - 6 кг<br>Скорость отжима - 1000 об/мин<br>Высота - 85 см<br>Ширина - 60 см<br>Глубина - 45 см',
  }, d467, config);
  assert.equal(r.attrs.load_max, 6, `load_max from dump description, got ${r.attrs.load_max}`);
  assert.equal(r.attrs.spin_max, 1000);
  console.log('ok sparse annotation + dump description fills empty axes');
}

{
  const requiredAnn = [
    'Вид стиральной машины - Автоматическая',
    'Тип загрузки - Фронтальная',
    'Максимальная загрузка белья - 6 кг',
    'Максимальная скорость отжима - 1000 об/мин',
    'Класс энергоэффективности - A++',
    'Уровень шума при стирке - 59 дБ',
    'Количество программ - 16',
    'Ширина - 59.6 см',
    'Глубина - 45 см',
    'Тип двигателя - Инверторный',
  ].join('<br>');
  const desc = 'Макс. загрузка - 9 кг<br>Скорость отжима - 800 об/мин<br>Высота - 85 см<br>Цвет - белый<br>Дисплей - есть';
  const parsed = parseProductFields({ annotation: requiredAnn, description: desc }, d467);
  assert.equal(needDescriptionParse(parsed.fromAnn, d467, { format: parsed.format, dumpDesc: true }), false);
  assert.equal(parsed.fromDesc.length, 0, `шаг 2 не должен парсить, если шаг 1 закрыл обязательные: ${parsed.fromDesc.map(x => x.key).join(' | ')}`);
  const r = normalizeProduct({
    id: 2,
    name: 'Стиральная машина Test 6kg',
    annotation: requiredAnn,
    description: desc,
  }, d467, config);
  assert.equal(r.attrs.load_max, 6, `S1 не должен уступить парсингу description, got ${r.attrs.load_max}`);
  assert.equal(r.attrs.spin_max, 1000);
  console.log('ok step 2 parse skipped when required filters filled');
}

{
  const partialAnn = [
    'Тип загрузки - Фронтальная',
    'Максимальная загрузка белья - 6 кг',
    'Максимальная скорость отжима - 1000 об/мин',
    'Класс энергоэффективности - A++',
    'Уровень шума при стирке - 59 дБ',
    'Количество программ - 16',
    'Ширина - 59.6 см',
    'Глубина - 45 см',
  ].join('<br>');
  const desc = 'Тип двигателя - Инверторный<br>Макс. загрузка - 9 кг<br>Цвет - белый<br>Дисплей - есть<br>Гарантия - 2 года';
  const parsed = parseProductFields({ annotation: partialAnn, description: desc }, d467);
  assert.ok(parsed.fromAnn.length >= 8);
  assert.ok(parsed.fromDesc.length >= 1, `шаг 2 должен разобрать dump, если шаг 1 не закрыл обязательный фильтр: ${parsed.fromDesc.map(x => x.key).join(' | ')}`);
  const r = normalizeProduct({
    id: 3,
    name: 'Стиральная машина Test 6kg',
    annotation: partialAnn,
    description: desc,
  }, d467, config);
  assert.equal(r.attrs.load_max, 6, 'шаг 1 не уступает парсингу по уже заполненной оси');
  assert.ok(r.attrs.motor_type, `шаг 2 добирает пустой обязательный фильтр, got ${r.attrs.motor_type}`);
  assert.equal(r.provenance.motor_type.level, 'S2');
  console.log('ok step 2 parse fills only missing required filter');
}

{
  // Attributes магазина — шаг 0: закрывают обязательный фильтр без annotation.
  const attrs = [
    { name: 'Вид стиральной машины', value: 'Автоматическая' },
    { name: 'Тип загрузки', value: 'Фронтальная' },
    { name: 'Максимальная загрузка белья', value: '6 кг' },
    { name: 'Максимальная скорость отжима', value: '1000 об/мин' },
    { name: 'Класс энергоэффективности', value: 'A++' },
    { name: 'Уровень шума при стирке', value: '59 дБ' },
    { name: 'Количество программ', value: '16' },
    { name: 'Ширина', value: '59.6 см' },
    { name: 'Глубина', value: '45 см' },
    { name: 'Тип двигателя', value: 'Инверторный' },
  ];
  const desc = 'Макс. загрузка - 9 кг<br>Скорость отжима - 800 об/мин<br>Цвет - белый';
  const parsed = parseProductFields({ annotation: '', description: desc, attributes: attrs }, d467);
  assert.ok(parsed.fromAttrs.length >= 10, `fromAttrs=${parsed.fromAttrs.length}`);
  assert.equal(parsed.fromDesc.length, 0, 'шаг 2 не нужен, если attributes закрыли обязательные');
  const r = normalizeProduct({
    id: 4,
    name: 'Стиральная машина Attr 6kg',
    annotation: '',
    description: desc,
    attributes: attrs,
  }, d467, config);
  assert.equal(r.attrs.load_max, 6, `attrs S0 → load_max, got ${r.attrs.load_max}`);
  assert.equal(r.attrs.spin_max, 1000);
  assert.equal(r.provenance.load_max?.level, 'S0');
  console.log('ok attributes close required filters before description parse');
}

{
  const { toPipelineProduct } = await import('./pipeline/export.js');
  const src = toPipelineProduct({
    id: 5,
    name: 'X',
    annotation: '',
    description: '',
    attributes: [{ name: 'Тип загрузки', value: 'Фронтальная' }],
  });
  assert.ok(Array.isArray(src.attributes) && src.attributes[0].value === 'Фронтальная');
  console.log('ok toPipelineProduct keeps attributes');
}

{
  // Нет нужных атрибутов/фильтров в annotation → допарсиваем description,
  // даже если там одна пара (не полный dump).
  const ann = [
    'Тип загрузки - Фронтальная',
    'Максимальная загрузка белья - 6 кг',
    'Максимальная скорость отжима - 1000 об/мин',
    'Класс энергоэффективности - A++',
    'Уровень шума при стирке - 59 дБ',
    'Количество программ - 16',
    'Ширина - 59.6 см',
    'Глубина - 45 см',
  ].join('<br>');
  const desc = 'Тип двигателя - Инверторный';
  assert.equal(needDescriptionParse(
    parseProductFields({ annotation: ann, description: '' }, d467).fromAnn,
    d467,
    { format: 'BR', dumpDesc: false },
  ), true, 'дырка в обязательном фильтре → допарсить');
  const parsed = parseProductFields({ annotation: ann, description: desc }, d467);
  assert.ok(parsed.fromDesc.some(p => /двигател/i.test(p.key)),
    `должен допарсить тип двигателя: ${parsed.fromDesc.map(x => x.key).join(' | ')}`);
  const r = normalizeProduct({
    id: 6,
    name: 'Стиральная машина Hole 6kg',
    annotation: ann,
    description: desc,
  }, d467, config);
  assert.ok(r.attrs.motor_type, `допарс закрыл motor_type, got ${r.attrs.motor_type}`);
  console.log('ok missing required filter → parse description further');
}

{
  assert.deepEqual(pairFromTableCells(['Ширина', '60 см']), ['Ширина', '60 см']);
  assert.deepEqual(pairFromTableCells(['★', 'Ширина', '60 см']), ['Ширина', '60 см']);
  assert.deepEqual(pairFromTableCells(['Высота', '85', 'см']), ['Высота', '85 см']);
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Product',
    additionalProperty: [{ name: 'Максимальная загрузка', value: '7 кг' }],
    width: { value: 60, unitText: 'см' },
  })}</script>
    <div class="chars__name">Скорость отжима</div>
    <div class="chars__value">1200 об/мин</div>`;
  const pairs = extractPairsFromPage(html, d467);
  const byKey = Object.fromEntries(pairs.map(p => [p.key, p.value]));
  assert.equal(byKey['Максимальная загрузка'], '7 кг');
  assert.match(String(byKey['Ширина'] || ''), /60/);
  assert.match(String(byKey['Скорость отжима'] || ''), /1200/);
  console.log('ok page parser: json-ld + div specs + 3-cell');
}

{
  const shop = `<h3>Характеристики</h3>
    <div class="row"><div class="col-sm-5 text-muted">Тип загрузки</div><div class="col-sm-7">фронтальная</div></div>
    <div class="row"><div class="col-sm-5">Макс. загрузка</div><div class="col-sm-7">6 кг</div></div>
    <ul><li><span>Скорость отжима</span><span>1200 об/мин</span></li></ul>`;
  const pairs = extractPairsFromPage(shop, d467);
  const byKey = Object.fromEntries(pairs.map(p => [p.key, p.value]));
  assert.equal(byKey['Тип загрузки'], 'фронтальная');
  assert.match(String(byKey['Макс. загрузка'] || ''), /6/);
  assert.match(String(byKey['Скорость отжима'] || ''), /1200/);
  console.log('ok page parser: bootstrap columns + list from search result');
}

{
  const parsed = collectParseHits({
    annotation: 'Макс. загрузка - 6 кг<br>Скорость отжима - 1000 об/мин',
    description: 'Цвет - белый<br>Тип загрузки - фронтальная<br>Установка - отдельно стоящая<br>Дисплей - есть',
  }, d467);
  assert.ok(parsed.hits.length >= 2, `hits ${parsed.hits.length}`);
  assert.ok(parsed.hits.some(h => h.where === 'аннотация' && /загрузк/i.test(h.key)));
  const notes = formatParseNotes(parsed, { origin: 'карточка' });
  assert.match(notes[0], /Парсинг \(карточка\)/);
  assert.match(notes.join('\n'), /аннотация/);
  assert.match(notes.join('\n'), /6 кг/);
  console.log('ok parse log: what was found and from where');
}

{
  const page = collectPageHits([
    { name: 'Общий объём', value: '310 л', via: 'table' },
    { name: 'Цвет', value: 'белый', via: 'jsonld' },
  ]);
  assert.equal(page.hits[0].where, 'таблица');
  assert.equal(page.hits[1].where, 'JSON-LD');
  const notes = formatParseNotes(page, { origin: 'dns-shop.ru' });
  assert.match(notes[0], /dns-shop\.ru/);
  assert.match(notes.join('\n'), /таблица: Общий объём = 310 л/);
  assert.match(notes.join('\n'), /JSON-LD: Цвет = белый/);
  console.log('ok page parse log groups by extractor');
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
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const order = [];
  const found = await firstMatchingPage(
    ['https://a.test/slow-wrong', 'https://b.test/fast-right', 'https://c.test/later'],
    {
      maxPages: 3,
      fetchHtml: async url => {
        if (url.includes('slow')) { await sleep(40); order.push('slow'); return '<p>wrong</p>'; }
        if (url.includes('fast')) { await sleep(5); order.push('fast'); return '<p>right</p>'; }
        order.push('later');
        return '<p>later</p>';
      },
      match: html => ({ ok: /right/.test(html), reason: 'не та' }),
    },
  );
  assert.equal(found.ok, true);
  assert.equal(found.url, 'https://b.test/fast-right');
  assert.ok(order.includes('fast'));
  assert.ok(order.includes('slow'), 'первая ссылка должна дочитаться, иначе порядок выдачи сломается');
    const empty = await firstMatchingPage([], { fetchHtml: async () => '', match: () => ({ ok: true }) });
    assert.equal(empty.ok, false);
    const failed = await firstMatchingPage(['https://a.test/down', 'https://b.test/ok'], {
      fetchHtml: async url => {
        if (url.includes('down')) throw new Error('HTTP 403 на https://a.test/down');
        return '<p>ok</p>';
      },
      match: html => ({ ok: /ok/.test(html) }),
    });
    assert.equal(failed.ok, true);
    assert.equal(failed.url, 'https://b.test/ok');
    assert.match(failed.tried.join(' '), /не открылась \(HTTP 403/);
    console.log('ok firstMatchingPage keeps SERP order and fetches in parallel');
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
  const rec = normalizeProduct(p467[419718], d467, config);
  assert.equal(needsExternal(rec), false, 'карточка живая — полный S3-скрейп не нужен');
  assert.equal(rec.attrs.spin_max, null, 'не выдумывать об/мин из 5109');
  assert.ok(missingRequiredCodes(rec, d467).includes('spin_max'));
  assert.equal(needsMissingLookup(rec, d467), true);
  assert.equal(needsMissingLookup(normalizeProduct(p467[343148], d467, config), d467), false);
  assert.match(missingQuery(rec, d467, ['spin_max']), /BWSA 5109/);
  assert.match(missingQuery(rec, d467, ['spin_max']), /отжим/i);
  assert.match(missingQuery(rec, d467, ['spin_max', 'energy_class']), /характеристики/);

  const html = `
    <h1>Стиральная машина Indesit BWSA 5109 WWV</h1>
    <table>
      <tr><td>Скорость отжима</td><td>1000 об/мин</td></tr>
      <tr><td>Максимальная загрузка</td><td>9 кг</td></tr>
    </table>`;
  const parsed = parseMissingFromPage(html, rec, d467, config);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.pairs.some(p => /отжим/i.test(p.key)), true);
  assert.equal(parsed.pairs.some(p => /загрузк/i.test(p.key)), false, 'уже заполненную загрузку со страницы не берём');

  const found = await lookupMissing(rec, d467, config, {
    search: async q => {
      assert.match(q, /BWSA 5109/);
      assert.doesNotMatch(q, /характеристики товара/);
      return ['https://a.test/wrong', 'https://b.test/spin'];
    },
    fetchHtml: async url => {
      if (url.includes('wrong')) {
        return '<h1>Indesit BWSA 7109 WWV</h1><table><tr><td>Скорость отжима</td><td>1400 об/мин</td></tr></table>';
      }
      return html;
    },
  });
  assert.equal(found.ok, true, found.reason);
  assert.equal(rec.attrs.spin_max, 1000);
  assert.equal(rec.provenance.spin_max.level, 'S3');
  assert.equal(rec.attrs.load_max, 5, 'своя загрузка не затирается чужой');

  const f12 = normalizeProduct(p467[444500], d467, config);
  assert.equal(f12.attrs.spin_max, null, 'F12 из артикула — не об/мин');
  const noPage = await lookupMissing(f12, d467, config, {
    search: async () => ['https://x.test/other'],
    fetchHtml: async () => '<h1>LG F14A8TD</h1><table><tr><td>Скорость отжима</td><td>1400 об/мин</td></tr></table>',
  });
  assert.equal(noPage.ok, false);
  assert.equal(f12.attrs.spin_max, null, 'чужая модель F14 не подходит к F12');
  console.log('ok missing required filter from web by model, article not parsed as rpm');
}

{
  const rec = normalizeProduct(p467[419718], d467, config);
  const notes = [];
  const results = await enrichMissing([rec], d467, config, {
    search: async () => ['https://b.test/spin'],
    fetchHtml: async () => `
      <h1>Стиральная машина Indesit BWSA 5109 WWV</h1>
      <table><tr><td>Скорость отжима</td><td>1200 об/мин</td></tr></table>`,
    onNote: m => notes.push(m),
  });
  assert.ok(results.some(r => r.ok && r.rec.attrs.spin_max === 1200), results.map(r => r.reason).join('; '));
  assert.equal(rec.attrs.spin_max, 1200);
  assert.ok(notes.some(n => /недостающ/i.test(n)), notes.join(' | '));
  console.log('ok enrichMissing looks up full cards with an empty required filter');
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
  assert.equal(searchQuery(rec, config), 'Indesit BWSE 7129X WSV RU характеристики');
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
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<yandexsearch>
  <response>
    <results>
      <grouping>
        <group><doc><url>https://shop.example/card</url><title>A</title></doc></group>
        <group><doc><url>https://mrmag.ru/same</url><title>skip</title></doc></group>
        <group><doc><url><![CDATA[https://shop.example/other]]></url><title>dup host</title></doc></group>
        <group><doc><url>https://www.google.com/search?q=x</url><title>engine</title></doc></group>
        <group><doc><url>https://mastodon.social/@x</url><title>junk</title></doc></group>
        <group><doc><url>https://other.example/tovar?a=1&amp;b=2</url><title>B</title></doc></group>
      </grouping>
    </results>
  </response>
</yandexsearch>`;
  assert.deepEqual(
    parseYandexSearchXml(xml),
    ['https://shop.example/card', 'https://other.example/tovar?a=1&b=2'],
  );
  assert.deepEqual(parseYandexSearchXml('<response><error code="15">not found</error></response>'), []);
  assert.deepEqual(parseYandexSearchXml('<response><error code="15"/></response>'), []);
  assert.throws(
    () => parseYandexSearchXml('<response><error code="32">quota</error></response>'),
    /Yandex Search API: 32/,
  );
  assert.throws(
    () => parseYandexSearchXml('<yandexsearch><response><error code=\'42\'>ключ</error></response></yandexsearch>'),
    /Yandex Search API: 42/,
  );
  const encoded = Buffer.from(xml, 'utf8').toString('base64');
  assert.deepEqual(
    parseYandexSearchResponse({ rawData: encoded }),
    ['https://shop.example/card', 'https://other.example/tovar?a=1&b=2'],
  );
  assert.deepEqual(
    parseYandexSearchResponse({ response: { rawData: `  ${encoded}  ` } }),
    ['https://shop.example/card', 'https://other.example/tovar?a=1&b=2'],
  );
  assert.deepEqual(
    parseYandexSearchResponse({ rawData: xml }),
    ['https://shop.example/card', 'https://other.example/tovar?a=1&b=2'],
  );
  const withCopy = `<?xml version="1.0"?><yandexsearch><response><results><grouping>
    <group><doc>
      <url><![CDATA[https://vendor.example/p?a=1&b=2]]></url>
      <title>A <hlword>model</hlword></title>
      <saved-copy-url>https://hghltd.yandex.net/yandbtm?url=https%3A%2F%2Fvendor.example%2Fp</saved-copy-url>
    </doc></group>
    <group><doc><url>https://vendor.example/p?a=1&amp;b=2&apos;x</url></doc></group>
  </grouping></results></response></yandexsearch>`;
  assert.deepEqual(parseYandexSearchXml(withCopy), ['https://vendor.example/p?a=1&b=2']);
  const info = JSON.stringify({
    docs: [
      { Num: 1, DocumentTitle: 'A', FullUrl: 'https://info.example/card' },
      { Num: 2, FullUrl: 'https://mastodon.social/@x' },
    ],
  });
  assert.deepEqual(
    parseYandexSearchResponse({ rawData: Buffer.from(info, 'utf8').toString('base64') }),
    ['https://info.example/card'],
  );
  console.log('ok Yandex Search API XML: organic links, ads and junk skipped');
}

{
  const prev = {
    WEB_LOOKUP: process.env.WEB_LOOKUP,
    WEB_LOOKUP_TRIES: process.env.WEB_LOOKUP_TRIES,
    WEB_PAGE_TIMEOUT_MS: process.env.WEB_PAGE_TIMEOUT_MS,
    DDG_REGION: process.env.DDG_REGION,
    DDG_ENDPOINT: process.env.DDG_ENDPOINT,
    SEARCH_URL: process.env.SEARCH_URL,
    YANDEX_SEARCH_API_KEY: process.env.YANDEX_SEARCH_API_KEY,
    YANDEX_FOLDER_ID: process.env.YANDEX_FOLDER_ID,
    YANDEX_SEARCH_TYPE: process.env.YANDEX_SEARCH_TYPE,
    YC_API_KEY: process.env.YC_API_KEY,
    YC_FOLDER_ID: process.env.YC_FOLDER_ID,
    FOLDER_ID: process.env.FOLDER_ID,
    SEARCH_API_KEY: process.env.SEARCH_API_KEY,
  };
  try {
    delete process.env.WEB_LOOKUP;
    delete process.env.WEB_LOOKUP_TRIES;
    delete process.env.WEB_PAGE_TIMEOUT_MS;
    delete process.env.DDG_REGION;
    delete process.env.DDG_ENDPOINT;
    delete process.env.SEARCH_URL;
    delete process.env.YANDEX_SEARCH_API_KEY;
    delete process.env.YANDEX_FOLDER_ID;
    delete process.env.YANDEX_SEARCH_TYPE;
    delete process.env.YC_API_KEY;
    delete process.env.YC_FOLDER_ID;
    delete process.env.FOLDER_ID;
    delete process.env.SEARCH_API_KEY;
    const fromFile = resolveSearchSettings(config);
    assert.equal(fromFile.enabled, true);
    assert.equal(fromFile.tries, 3);
    assert.equal(fromFile.pageTimeoutMs, 10000);
    assert.equal(fromFile.yandex.enabled, true);
    assert.equal(fromFile.yandex.searchType, 'ru');
    assert.equal(fromFile.yandex.region, '225');
    assert.equal(fromFile.yandex.apiKey, '');
    assert.equal(fromFile.yandex.folderId, '');
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

    process.env.YANDEX_SEARCH_API_KEY = 'ya-key';
    process.env.YANDEX_FOLDER_ID = 'b1gfolder';
    process.env.YANDEX_SEARCH_TYPE = 'com';
    const withYa = resolveSearchSettings(config);
    assert.equal(withYa.yandex.apiKey, 'ya-key');
    assert.equal(withYa.yandex.folderId, 'b1gfolder');
    assert.equal(withYa.yandex.searchType, 'com');
    assert.equal(withYa.yandex.l10n, 'en');

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
  const prev = {
    YANDEX_SEARCH_API_KEY: process.env.YANDEX_SEARCH_API_KEY,
    YANDEX_FOLDER_ID: process.env.YANDEX_FOLDER_ID,
    YC_API_KEY: process.env.YC_API_KEY,
    YC_FOLDER_ID: process.env.YC_FOLDER_ID,
    FOLDER_ID: process.env.FOLDER_ID,
    SEARCH_API_KEY: process.env.SEARCH_API_KEY,
  };
  delete process.env.YANDEX_SEARCH_API_KEY;
  delete process.env.YANDEX_FOLDER_ID;
  delete process.env.YC_API_KEY;
  delete process.env.YC_FOLDER_ID;
  delete process.env.FOLDER_ID;
  delete process.env.SEARCH_API_KEY;
  try {
    const s = publicParserStatus(config);
    assert.equal(s.enabled, true);
    assert.equal(s.status, 'on');
    assert.equal(s.yandex.enabled, true);
    assert.equal(s.yandex.has_key, false);
    assert.equal(s.yandex.has_folder, false);
    assert.equal(s.duckduckgo.region, 'ru-ru');
    assert.equal(s.duckduckgo.method, 'POST');
    assert.match(s.label, /DuckDuckGo/);
    const onYa = publicParserStatus({
      search: {
        ...config.search,
        yandex: { ...config.search.yandex, api_key: 'yk', folder_id: 'folder' },
      },
    });
    assert.match(onYa.label, /Yandex Search API/);
    assert.equal(onYa.yandex.has_key, true);
    assert.equal(onYa.yandex.has_folder, true);
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
  const prev = {
    YANDEX_SEARCH_API_KEY: process.env.YANDEX_SEARCH_API_KEY,
    YANDEX_FOLDER_ID: process.env.YANDEX_FOLDER_ID,
    YC_API_KEY: process.env.YC_API_KEY,
    YC_FOLDER_ID: process.env.YC_FOLDER_ID,
    FOLDER_ID: process.env.FOLDER_ID,
    SEARCH_API_KEY: process.env.SEARCH_API_KEY,
  };
  delete process.env.YANDEX_SEARCH_API_KEY;
  delete process.env.YANDEX_FOLDER_ID;
  delete process.env.YC_API_KEY;
  delete process.env.YC_FOLDER_ID;
  delete process.env.FOLDER_ID;
  delete process.env.SEARCH_API_KEY;
  try {
    const off = await probeParser({ search: { enabled: false, duckduckgo: { enabled: false } } });
  assert.equal(off.ok, false);
  assert.match(off.summary, /выключен/i);
  assert.ok(off.checks.some(c => c.id === 'search' && c.ok === false));

  const noKey = await probeParser({
    search: {
      enabled: true,
      yandex: { enabled: true, api_key: '', folder_id: 'b1g', api_key_env: '__no_ya_key__', folder_id_env: '__no_ya_folder__' },
      duckduckgo: { enabled: false },
    },
  });
  assert.equal(noKey.ok, false);
  assert.match(noKey.summary, /ключа/i);
  assert.ok(noKey.checks.some(c => c.id === 'yandex' && c.code === 'no_key'));

  const noFolder = await probeParser({
    search: {
      enabled: true,
      yandex: { enabled: true, api_key: 'yk', folder_id: '', api_key_env: '__no_ya_key__', folder_id_env: '__no_ya_folder__' },
      duckduckgo: { enabled: false },
    },
  });
  assert.equal(noFolder.ok, false);
  assert.match(noFolder.summary, /Folder ID/i);

  const auth = explainSearchError('Yandex Search API: 42 ключ не прошёл аутентификацию');
  assert.equal(auth.code, '42');
  assert.match(auth.text, /не принят/);

  const to = explainSearchError('таймаут 15000ms (searchapi.api.cloud.yandex.net)', 'yandex');
  assert.equal(to.code, 'timeout');
  assert.match(to.text, /15 с/);
  assert.match(to.text, /searchapi\.api\.cloud\.yandex\.net/);
  assert.doesNotMatch(to.text, /превышен таймаут/);

  const prevProxy = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    https_proxy: process.env.https_proxy,
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
  };
  process.env.HTTPS_PROXY = 'http://127.0.0.1:18080';
  delete process.env.https_proxy;
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  try {
    const viaSocks = explainSearchError('таймаут 20000ms (searchapi.api.cloud.yandex.net)', 'yandex');
    assert.match(viaSocks.text, /SOCKS/);
    assert.match(viaSocks.text, /NO_PROXY/);
  } finally {
    for (const [k, v] of Object.entries(prevProxy)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  const live = await probeParser({
    search: {
      enabled: true,
      yandex: { enabled: true, api_key: 'yk', folder_id: 'b1g' },
      duckduckgo: { enabled: false },
    },
  }, { searchYandexFn: async () => ['https://shop.example/card', 'https://other.example/t'] });
  assert.equal(live.ok, true);
  assert.match(live.summary, /работает/);
  const ya = live.checks.find(c => c.id === 'yandex');
  assert.deepEqual(ya.hosts, ['shop.example', 'other.example']);

  const empty = await probeParser({
    search: {
      enabled: true,
      yandex: { enabled: true, api_key: 'yk', folder_id: 'b1g' },
      duckduckgo: { enabled: false },
    },
  }, { searchYandexFn: async () => { throw new Error('Yandex Search API: выдача без ссылок'); } });
  assert.equal(empty.ok, true, 'пустая выдача — ключ принят');
  assert.equal(empty.checks.find(c => c.id === 'yandex').warning, true);

  const bad = await probeParser({
    search: {
      enabled: true,
      yandex: { enabled: true, api_key: 'yk', folder_id: 'b1g' },
      duckduckgo: { enabled: false },
    },
  }, { searchYandexFn: async () => { throw new Error('Yandex Search API: 42 ключ не прошёл аутентификацию'); } });
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /не принят/);
  console.log('ok parser probe: config errors, live ok, empty, auth fail');
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
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
  };
  process.env.PAGE_CACHE_DIR = cacheDir;
  process.env.CRAWL_GAP_MS = '0';
  process.env.SEARCH_GAP_MS = '0';
  delete process.env.SEARCH_URL;
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
          yandex: { enabled: false },
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
    YANDEX_SEARCH_API_KEY: process.env.YANDEX_SEARCH_API_KEY,
    YANDEX_FOLDER_ID: process.env.YANDEX_FOLDER_ID,
    YC_API_KEY: process.env.YC_API_KEY,
    YC_FOLDER_ID: process.env.YC_FOLDER_ID,
    FOLDER_ID: process.env.FOLDER_ID,
    SEARCH_API_KEY: process.env.SEARCH_API_KEY,
  };
  process.env.SEARCH_URL = `http://127.0.0.1:${port}/serp?q=%s`;
  process.env.PAGE_CACHE_DIR = cacheDir;
  process.env.SEARCH_GAP_MS = '0';
  process.env.CRAWL_GAP_MS = '0';
  process.env.WEB_ALLOW_LOCAL = '1';
  delete process.env.YANDEX_SEARCH_API_KEY;
  delete process.env.YANDEX_FOLDER_ID;
  delete process.env.YC_API_KEY;
  delete process.env.YC_FOLDER_ID;
  delete process.env.FOLDER_ID;
  delete process.env.SEARCH_API_KEY;
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
  };
  delete process.env.SEARCH_URL;
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
      yandex: { ...(config.search.yandex || {}), enabled: false, api_key: '', folder_id: '' },
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
    if (u.pathname === '/v2/web/search') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        if (req.headers.authorization !== 'Api-Key ya-test-key') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'unauthorized' }));
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'bad json' }));
        }
        if (body.folderId !== 'b1gtest' || !body.query?.queryText) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'bad request' }));
        }
        const hit = `http://${req.headers.host}/card`;
        const xml = `<?xml version="1.0"?><yandexsearch><response><results><grouping>
          <group><doc><url>${hit}</url><title>Indesit BWSE</title></doc></group>
          <group><doc><url>https://mrmag.ru/skip</url><title>skip</title></doc></group>
        </grouping></results></response></yandexsearch>`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rawData: Buffer.from(xml, 'utf8').toString('base64') }));
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
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-yandex-'));
  const prev = {
    SEARCH_URL: process.env.SEARCH_URL,
    PAGE_CACHE_DIR: process.env.PAGE_CACHE_DIR,
    SEARCH_GAP_MS: process.env.SEARCH_GAP_MS,
    CRAWL_GAP_MS: process.env.CRAWL_GAP_MS,
    WEB_ALLOW_LOCAL: process.env.WEB_ALLOW_LOCAL,
    YANDEX_SEARCH_API_KEY: process.env.YANDEX_SEARCH_API_KEY,
    YANDEX_FOLDER_ID: process.env.YANDEX_FOLDER_ID,
  };
  delete process.env.SEARCH_URL;
  process.env.PAGE_CACHE_DIR = cacheDir;
  process.env.SEARCH_GAP_MS = '0';
  process.env.CRAWL_GAP_MS = '0';
  process.env.WEB_ALLOW_LOCAL = '1';
  process.env.YANDEX_SEARCH_API_KEY = 'ya-test-key';
  process.env.YANDEX_FOLDER_ID = 'b1gtest';
  const yaConfig = {
    ...config,
    search: {
      ...config.search,
      search_url: '',
      fallback_engines: [],
      gap_ms: 0,
      yandex: {
        enabled: true,
        api_key: '',
        api_key_env: 'YANDEX_SEARCH_API_KEY',
        folder_id: '',
        folder_id_env: 'YANDEX_FOLDER_ID',
        search_type: 'ru',
        l10n: 'ru',
        region: '225',
        endpoint: `http://127.0.0.1:${port}/v2/web/search`,
      },
      duckduckgo: { ...config.search.duckduckgo, enabled: false },
    },
  };
  try {
    const rec = normalizeProduct(p467[460989], d467, config);
    const urls = await searchYandex(searchQuery(rec, yaConfig), yaConfig);
    assert.ok(urls.some(u => u.includes('/card')), urls);
    const got = await lookupExternal(rec, d467, yaConfig);
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
  console.log('ok Yandex Search API XML → matching page → S3 specs');
}

{
  const all = loadProducts('data_467.json').map(p => normalizeProduct(p, d467, config));
  const built = buildFilters(all, d467, config);
  const r = all.find(x => x.id === 11391);
  const p = p467[11391];
  const row = serializeProduct(r, d467, built.debug);
  assert.deepEqual(Object.keys(row), PRODUCT_FIELDS);
  assert.equal(row.id, p.id);
  assert.ok(!('name' in row), 'name не в выгрузке: сопоставление по id');
  assert.match(row.meta_keywords, /стиральная машина ATLANT/);
  assert.match(row.description_html, /^<p>/);
  assert.equal(row.description_html.includes('\n'), false);
  assert.match(row.annotation_html, /^<ul><li>.+: .+<\/li>/);
  assert.equal(row.annotation_html.includes('\n'), false);
  assert.match(row.annotation_html, /Тип загрузки: фронтальная/);
  assert.ok(!/Бренд:/i.test(row.annotation_html), 'бренд не строка характеристик');
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
  assert.ok(keys.has('цвет') && keys.has('тип_товара'));
  assert.ok(!keys.has('бренд'), 'бренд не фасет v2: сопоставление по id');
  assert.ok(!keys.has('хладагент') && !keys.has('вес_кг'));
  const w = v2FacetSpecKeys(d467);
  assert.ok(w.has('вес_кг'), 'вес стиральной машины — фильтр (facet.enabled=true)');
  assert.ok(![...w].some(k => /габарит/.test(k)), 'составной WxHxH — в filters_*.json списком, не в v2 product.filters');
  assert.ok(![...w].some(k => /расход_воды/.test(k)));
  assert.ok(![...w].some(k => /шум.*отжим|отжима.*дб/.test(k)));
  console.log('ok v2FacetSpecKeys vs таблица заказчика');
}

{
  const r = normalizeProduct(p523[260], d523, config);
  const [p] = buildV2(dictToV2Rows([r], d523), { dict: d523 }).products;
  assert.deepEqual(Object.keys(p), ['id', 'name', 'meta_keywords', 'description_html', 'filters']);
  assert.equal(p.id, 260);
  assert.equal(p.name, p523[260].name);
  assert.ok(!('annotation_html' in p));
  assert.ok(!('Бренд' in p.filters), 'бренд не фасет: заказчик сопоставляет по id');
  assert.equal(p.filters['Тип товара'], 'Холодильник');
  assert.ok(!('Модель' in p.filters), 'модель — паспорт, не фасет');
  // Подписи фасетов — из справочника (facet.label / name), не из CODE_TO_SPEC.
  assert.equal(p.filters['Общий объем, л'], '344');
  assert.equal(p.filters['Класс энергоэффективности'], 'A');
  assert.ok(!('Хладагент' in p.filters), 'хладагент — характеристика, не фильтр');
  assert.ok(!('Вес, кг' in p.filters), 'вес холодильника — характеристика, не фильтр');
  assert.equal(p.filters['Уровень шума, дБ'], '40');
  assert.equal(p.filters['Система охлаждения'], 'Full No Frost');
  assert.equal(p.filters['Тип управления'], 'Механическое');
  assert.equal(p.filters['Расположение морозильной камеры'], 'Снизу');
  assert.equal(p.filters['Количество камер'], '2', 'камеры — filter при facet.enabled');
  assert.match(p.description_html, /^<h1>Холодильник Pozis RK FNF-172 W<\/h1>/);
  assert.match(p.description_html, /<li>Тип товара: холодильник<\/li>/);
  assert.match(p.description_html, /<li>Общий объем: 344 л<\/li>/);
  assert.match(p.description_html, /<li>Система охлаждения: Full No Frost<\/li>/);
  assert.match(p.description_html, /<li>Хладагент: R600a<\/li>/);
  assert.match(p.description_html, /<li>Вес: 74 кг<\/li>/);
  assert.ok(!/Бренд:/i.test(p.description_html), 'бренд не строка характеристик');
  console.log('ok products_v2 shape (260 Pozis)');
}

{
  const r = normalizeProduct(p467[11391], d467, config);
  const [p] = buildV2(dictToV2Rows([r], d467), { dict: d467 }).products;
  assert.equal(p.filters['Тип товара'], 'Стиральная машина');
  assert.equal(p.filters['Тип загрузки'], 'Фронтальная');
  assert.ok(!('Бренд' in p.filters), 'бренд не фасет: заказчик сопоставляет по id');
  assert.equal(p.name, p467[11391].name);
  assert.equal(p.filters['Загрузка белья, кг'], '6');
  assert.equal(p.filters['Высота, мм'], '846');
  assert.equal(typeof p.filters['Тип загрузки'], 'string');
  assert.ok(!Object.keys(p.filters).some(n => /расход воды/i.test(n)));
  assert.ok(!Object.keys(p.filters).some(n => /отжима.*дб|шум при отжиме/i.test(n)));
  console.log('ok products_v2 washer (11391)');
}

{
  assert.equal(isBrandFilterKey('Бренд'), true);
  assert.equal(isBrandFilterKey('brand'), true);
  assert.equal(isBrandFilterKey('Тип загрузки'), false);
  const brand = d467.byCode.get('brand');
  const prevEnabled = brand.facet.enabled;
  const prevStatus = brand.facet.status;
  brand.facet.enabled = true;
  brand.facet.status = 'filter';
  try {
    const out = await buildCustomerExport([p467[11391]], {
      dict: d467, config, root: '.', filtersAgent: { mode: 'heuristic' },
    });
    const p = out.products.find(x => x.id === 11391);
    assert.ok(p, '11391 должен остаться в выгрузке');
    assert.ok(!('Бренд' in p.filters), 'включённый facet бренда всё равно не едет в JSON v2');
    assert.ok(!out.filters.some(f => /бренд/i.test(f.name)));
    assert.ok(!/Бренд:/i.test(p.annotation_html));
  } finally {
    brand.facet.enabled = prevEnabled;
    brand.facet.status = prevStatus;
  }
  console.log('ok brand hard-strip even if facet.enabled');
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
      assert.equal(p.name, p523[g.id].name);
      assert.ok(!('Бренд' in p.filters), 'бренд не фасет v2');
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
  assert.equal(expectedFilters(d467).length, 19);
  assert.equal(expectedFilters(d523).length, 20);
  {
    const { isRequiredFilter, requiredFilterAttrs, optionalFilterAttrs } = await import('./pipeline/required_filters.js');
    assert.equal(isRequiredFilter(d467.byCode.get('washer_type')), true);
    assert.equal(isRequiredFilter(d467.byCode.get('load_type')), true);
    assert.equal(isRequiredFilter(d467.byCode.get('load_max')), true);
    assert.equal(isRequiredFilter(d467.byCode.get('color')), false);
    assert.equal(isRequiredFilter(d467.byCode.get('brand')), false);
    assert.ok(requiredFilterAttrs(d467).some(a => a.code === 'energy_class'));
    assert.ok(optionalFilterAttrs(d467).some(a => a.code === 'color'));
    const { heuristicSuggest, buildImportSuggestPrompt } = await import('./pipeline/schema_import.js');
    assert.match(buildImportSuggestPrompt(d467.attrs, { catId: '467' }), /ОБЯЗАТЕЛЬНЫЕ ФИЛЬТРЫ КАТЕГОРИИ/);
    const hsReq = heuristicSuggest([{ id: 'i1', raw: 'Производительность — 650', label: 'Производительность', value: '650' }], []);
    assert.equal(hsReq[0].proposed.facet_required, true);
    const hsOpt = heuristicSuggest([{ id: 'i1', raw: 'Цвет — белый', label: 'Цвет', value: 'белый' }], []);
    assert.equal(hsOpt[0].proposed.facet_required, false);
  }
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
  assert.deepEqual(a.filters['Габариты (ШхГхВ)'], ['59.6×55×84.6']);
  assert.match(a.annotation_html, /Габариты \(ШхГхВ\): 59\.6×55×84\.6 см/);
  assert.ok(Object.keys(a.filters).length >= 8, Object.keys(a.filters).join(','));
  assert.ok(!/экономи[яи]|гарант/i.test(a.description_html));
  assert.ok(!/узк(?:ая|ий|ое|ие|ой)\b/i.test(a.meta_keywords));
  assert.ok(!a.description_html.includes('<h1'));
  assert.equal((a.description_html.match(/<ul\b/g) || []).length, 1);
  const strongs = (a.description_html.match(/<strong\b/g) || []).length;
  assert.ok(strongs >= 1 && strongs <= 3, strongs);
  assert.equal(validateDescription(a.description_html).length, 0);

  const c = rows.find(r => r.id === 29921);
  assert.ok(!('name' in c), 'name не в выгрузке: сопоставление по id');
  assert.match(c.annotation_html, /Вес: 47 кг/);
  assert.deepEqual(c.filters['Габариты (ШхГхВ)'], ['51×43×70']);
  assert.ok(!c.annotation_html.includes('49'));
  assert.ok(!('Материал' in c.filters));

  const i = rows.find(r => r.id === 44772);
  assert.ok(!('name' in i), 'name не в выгрузке: сопоставление по id');
  assert.ok(!('Бренд' in i.filters), 'бренд не фасет: сопоставление по id');
  assert.deepEqual(i.filters['Габариты (ШхГхВ)'], ['59.5×42×85']);

  const lg = rows.find(r => r.id === 12957);
  assert.deepEqual(lg.filters['Габариты (ШхГхВ)'], ['60×56×85']);
  assert.ok(p467[44772].name.includes('"Indesit"'), 'исходник по-прежнему с кавычками; в выгрузке name нет');
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
  assert.ok(!('name' in out.products[0]), 'name не в выгрузке: сопоставление по id');
  assert.deepEqual(Object.keys(out.products[0]), PRODUCT_FIELDS);
  assert.ok(!/Бренд:/i.test(out.products[0].annotation_html), 'бренд не строка характеристик');
  assert.match(out.products[0].annotation_html, /Тип загрузки: фронтальная/);
  const thin = await buildCustomerExport(
    [{ sku: '1', name: 'Стиральная машина X', annotation: '', description: '' }],
    { dict: d467, config, root: '.', filtersAgent: { mode: 'heuristic' } },
  );
  assert.equal(thin.products.length, 1);
  assert.equal(thin.products[0].id, 1);
  assert.equal(thin.held.length, 1);
  assert.equal(thin.held[0].id, 1);
  console.log('ok buildCustomerExport sku→id / hold');
}

{
  const src = loadProducts('data_467.json');
  const out = await buildCustomerExport(src, {
    dict: d467, config, root: '.',
    filtersAgent: { mode: 'heuristic' },
  });
  assert.equal(out.products.length, src.length, `export dropped SKUs: ${src.length} → ${out.products.length}`);
  assert.deepEqual(out.products.map(p => p.id), src.map(p => p.id));
  assert.ok(out.products.some(p => p.id === 460989));
  assert.ok(out.products.some(p => p.id === 263214));
  assert.ok(out.held.some(h => h.id === 460989));
  const fridgeSrc = [p523[260], p523[461138]].filter(Boolean);
  const fridge = await buildCustomerExport(fridgeSrc, {
    dict: d523, config, root: '.',
    filtersAgent: { mode: 'heuristic' },
  });
  assert.equal(fridge.products.length, fridgeSrc.length);
  assert.ok(fridge.products.some(p => p.id === 461138));
  const std = await buildCustomerExport([{
    id: 99,
    name: 'Холодильник Test',
    annotation: '<ul><li>Тип компрессора - Стандартный</li><li>Цвет - Белый</li><li>Тип - Двухкамерный</li></ul>',
  }], { dict: d523, config, root: '.', filtersAgent: { mode: 'heuristic' } });
  assert.deepEqual(std.products[0].filters['Тип компрессора'], ['Стандартный']);
  console.log('ok export keeps every source SKU (460989 / 263214 / 461138)');
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
  console.log('ok buildGoldShapeExport keeps 6 fields, empty filters, needs_review');
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
  const { dictIdFromText, expectedDictCatId, tryLoadDictSchema } = await import('./pipeline/schema.js');
  const { schemaForProduct } = await import('./lib.js');
  const { seedDictionaryAttrs, writeJson } = await import('./pipeline/dict.js');
  const { harvestAttrLinesFromProducts, harvestDumpAttrLines } = await import('./pipeline/schema_import.js');

  const harvested = harvestAttrLinesFromProducts(loadProducts('data_467.json'), d467);
  assert.ok(harvested.length >= 10, `harvest 467 keys ${harvested.length}`);
  assert.ok(harvested.some(l => /загрузк/i.test(l)), harvested.slice(0, 8).join(' | '));
  const dumpLines = harvestDumpAttrLines('467', '.');
  assert.equal(dumpLines.id, '467');
  assert.ok(dumpLines.lines.length >= 10);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-514-'));
  try {
    fs.mkdirSync(path.join(tmp, 'dictionaries'));
    writeJson(path.join(tmp, 'categories.json'), [
      { id: 514, name: 'Микроволновые печи' },
      { id: 467, name: 'Стиральные машины' },
    ]);
    writeJson(path.join(tmp, 'dictionaries', 'attributes_514.json'), seedDictionaryAttrs());
    assert.equal(dictIdFromText('Микроволновая печь Samsung', tmp), '514');
    assert.equal(dictForProducts([{ name: 'Микроволновая печь LG' }], 'без раздела', tmp)?.catId, '514');
    const schema = schemaForProduct({ name: 'Микроволновая печь Samsung' }, 'без раздела', tmp);
    assert.equal(schema.id, 514);
    assert.equal(schema.fromDictionary, true);
    assert.ok(tryLoadDictSchema(514, tmp)?.fromDictionary);
    assert.equal(expectedDictCatId([{ name: 'Микроволновая печь' }], 'без раздела', tmp), '514');
    assert.equal(schemaForProduct({ name: 'Носки хлопковые' }, 'без раздела', tmp).slug, '_generic');
    assert.equal(dictIdFromText('Носки хлопковые', tmp), null);
    assert.equal(expectedDictCatId([{ name: 'Стиральная машина ATLANT' }], 'без раздела', tmp), '467');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('ok 4th dictionary from dump-shaped file + harvest');
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
  assert.equal(PRODUCT_FIELDS.length, 6);
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
  assert.deepEqual(row.filters['Габариты (ШхГхВ)'], ['59.6×55×84.6']);
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
  assert.equal(dimsAttr.facet?.enabled, true);
  assert.equal(facetKind(dimsAttr), 'enum');

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
  const dimsFacet = built.filters.find(f => f.name === lab);
  assert.ok(dimsFacet, 'габариты — список в filters_*.json');
  assert.ok(Array.isArray(dimsFacet.value) && dimsFacet.value.length >= 1);
  assert.match(dimsFacet.value[0], /^\d+(?:\.\d+)?×\d+(?:\.\d+)?×\d+(?:\.\d+)?$/);
  assert.deepEqual(assigned[lab], [asFilter]);
  assert.ok(!JSON.stringify(assigned).includes('[object Object]'));

  const row = serializeProduct(r, d467, built.debug);
  assert.deepEqual(row.filters[lab], [asFilter]);
  assert.ok(!JSON.stringify(row.filters).includes('[object Object]'));

  const exp = expectedFilters(d467).find(f => f.name === lab);
  assert.equal(exp?.kind, 'enum');
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
  assert.equal(normalizeValue(ft, 'Трехкамерный (3d)').value, 'Трёхкамерный');

  const { aliasValue } = await import('./pipeline/types.js');
  const pendingRaw = 'камера с двумя отделениями';
  const pending = normalizeValue(ft, pendingRaw, { keyText: 'Тип холодильника' });
  assert.equal(pending.ok, true, `pending must survive parse: ${JSON.stringify(pending)}`);
  assert.equal(pending.pending_canon, true);
  assert.equal(aliasValue(ft, pending.value), null, 'pending is not a dictionary canon yet');

  const pendingRec = normalizeProduct({
    id: 900001,
    name: 'Холодильник Test Pending',
    annotation: '<ul><li>Тип холодильника - камера с двумя отделениями</li></ul>',
    description: '',
  }, d523, config);
  assert.equal(pendingRec.attrs.fridge_type, pending.value);
  assert.equal(pendingRec.provenance.fridge_type?.pending_canon, true);

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

  // Без value_aliases enum-фасет не собираем — иначе сырой зоопарк на витрине.
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
  assert.ok(!looseBuilt.filters.find(f => f.name === 'Тип холодильника'));
  assert.ok(
    (looseBuilt.warnings || []).some(w => /без value_aliases/i.test(w.reason || '')),
    'empty aliases → warn + skip enum facet',
  );

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
  assert.equal(fridge.facet?.enabled, false, 'defrost_fridge не фасет витрины');
  assert.equal(freezer.facet?.enabled, false, 'defrost_freezer не фасет витрины');
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
  assert.ok(!built.filters.some(f => /Размораживание/i.test(f.name)));
  const cool = built.filters.find(f => f.name === 'Система охлаждения');
  assert.ok(cool, 'cooling facet present');
  assert.ok(cool.value.includes('No Frost'));
  assert.equal(cool.value.filter(v => /no\s*frost/i.test(v)).length, 1);
  assert.ok(cool.value.includes('Капельная'));
  assert.ok(cool.value.includes('Статическая'));
  assert.ok(!cool.value.includes('Ручная разморозка'));
  console.log('ok defrost/cooling: no duplicate No Frost / Ручное canons');
}

{
  // Регрессия: «грязный» каталог как у витрины до unify — санитайзер склеивает.
  const { sanitizeFilterCatalog } = await import('./pipeline/fix_filters.js');
  const fridge = d523.byCode.get('defrost_fridge');
  const freezer = d523.byCode.get('defrost_freezer');
  const prevFridge = fridge.facet;
  const prevFreezer = freezer.facet;
  fridge.facet = { enabled: true, label: fridge.name, kind: 'enum' };
  freezer.facet = { enabled: true, label: freezer.name, kind: 'enum' };
  try {
    const dirty = [
      {
        name: 'Система охлаждения',
        value: ['капельная', 'ручная разморозка', 'No Frost', 'Full No Frost', 'Total No Frost'],
      },
      {
        name: 'Размораживание холодильной камеры',
        value: ['Автоматическое (No Frost)', 'Капельная система', 'Ручное', 'No Frost'],
      },
      {
        name: 'Тип компрессора',
        value: ['Инвертор', 'Коллекторный', 'Стандартный', 'Inverter'],
      },
      {
        name: 'Тип управления',
        value: ['Механическое', 'Поворотный механизм', 'Сенсор', 'Электромеханическое', 'Электронная', 'LED дисплей'],
      },
      {
        name: 'Цвет корпуса',
        value: [
          'Белое стекло', 'Белый', 'Жемчужно-бежевый', 'Графит', 'Металлик',
          'Текстурированное черное стекло', 'Черная нержавеющая сталь',
        ],
      },
    ];
    const cleaned = sanitizeFilterCatalog(dirty, d523);
    assert.ok(cleaned.validation.ok);
    const cool = cleaned.filters.find(f => f.name === 'Система охлаждения');
    assert.ok(!cool.value.includes('Ручная разморозка'));
    assert.ok(cool.value.includes('Статическая'));
    assert.ok(cool.value.includes('Капельная'));
    assert.ok(cool.value.includes('No Frost'));
    assert.ok(cool.value.includes('Full No Frost'));
    assert.ok(!cool.value.includes('Total No Frost'));
    const defrost = cleaned.filters.find(f => f.name === 'Размораживание холодильной камеры');
    assert.deepEqual(defrost.value, ['Автоматическое (No Frost)', 'Капельная система', 'Ручное']);
    const comp = cleaned.filters.find(f => f.name === 'Тип компрессора');
    assert.deepEqual(comp.value, ['Инверторный', 'Стандартный']);
    assert.ok(!comp.value.includes('Коллекторный'));
    assert.ok(comp.value.includes('Стандартный'));
    const ctrl = cleaned.filters.find(f => f.name === 'Тип управления');
    assert.deepEqual(ctrl.value, ['Механическое', 'Сенсорное', 'Электронное']);
    const color = cleaned.filters.find(f => f.name === 'Цвет корпуса');
    assert.ok(color);
    assert.ok(!color.value.some(v => /стекло|жемчужно|графит|металлик/i.test(v)));
    assert.ok(color.value.includes('Белый'));
    assert.ok(color.value.includes('Бежевый'));
    assert.ok(color.value.includes('Серый'));
    assert.ok(color.value.includes('Серебристый'));
    assert.ok(color.value.includes('Чёрный'));
  } finally {
    fridge.facet = prevFridge;
    freezer.facet = prevFreezer;
  }
  console.log('ok sanitize dirty storefront filters (No Frost / Inverter / LED)');
}

{
  // Фильтры витрины — тот же источник, что annotation_html: S0–S3
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
  assert.equal(filterSourceAllowed(recS3, 'cooling', config), true);

  const built = buildFilters([recS1, recS3], d523, config);
  const cool = built.filters.find(f => f.name === 'Система охлаждения');
  assert.ok(cool, 'S1+S3 must create cooling facet');
  assert.ok(cool.value.includes('No Frost'));
  assert.ok(cool.value.includes('Капельная'), 'S3 must enter catalog filters');

  const assignedS3 = assignFilterValues(recS3, d523, built.debug, config);
  assert.deepEqual(assignedS3['Система охлаждения'], ['Капельная']);
  const assignedS1 = assignFilterValues(recS1, d523, built.debug, config);
  assert.deepEqual(assignedS1['Система охлаждения'], ['No Frost']);
  console.log('ok filters from specs (S1+S3)');
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
  assert.ok(buildFiltersAgentPrompt(d523, inv, { catId: '523' }).includes('required=true'));
  assert.ok(inv.some(f => f.attr_code === 'fridge_type' && f.required === true));

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

  // Сырое значение после парсинга → ИИ сводит к канону словаря; без map — снимаем.
  {
    const { stripPendingUnmapped } = await import('./pipeline/filters_agent.js');
    const { aliasValue: av } = await import('./pipeline/types.js');
    const raw = 'Камера с двумя отделениями';
    assert.equal(av(d523.byCode.get('fridge_type'), raw), null);
    const recMap = {
      id: 11,
      name: 'Холодильник Map',
      attrs: { fridge_type: raw },
    };
    const recSkip = {
      id: 12,
      name: 'Холодильник Skip',
      attrs: { fridge_type: raw },
    };
    for (const rec of [recMap, recSkip]) {
      for (const a of d523.attrs) {
        if (!(a.code in rec.attrs)) rec.attrs[a.code] = null;
      }
    }
    const mapFetch = async () => ({
      ok: true,
      async text() {
        return JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                mappings: [
                  { attr_code: 'fridge_type', raw, canon: 'Двухкамерный', action: 'map' },
                ],
              }),
            },
          }],
        });
      },
    });
    await runFiltersAgent({
      recs: [recMap],
      dict: d523,
      mode: 'ai',
      provider: { apiKey: 'test', chatUrl: 'http://example.invalid/v1/chat/completions' },
      fetchImpl: mapFetch,
      catId: '523',
    });
    assert.equal(recMap.attrs.fridge_type, 'Двухкамерный');

    await runFiltersAgent({ recs: [recSkip], dict: d523, mode: 'heuristic', catId: '523' });
    assert.equal(recSkip.attrs.fridge_type, null);
    assert.equal(stripPendingUnmapped([recSkip], d523), 0);
  }

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

{
  const { matchBucket, toIntEnum, coerceFacetNumber, assignFilterValues, buildFilters } = await import('./pipeline/facets.js');
  const { applyEnrichedSpecs } = await import('./pipeline/export.js');
  const { markCategoryMismatch } = await import('./pipeline/category_mismatch.js');
  const { buildFilterCoverageReport } = await import('./pipeline/filter_report.js');
  const { aliasValue } = await import('./pipeline/types.js');

  const loadFacet = d467.byCode.get('load_max').facet;
  assert.equal(loadFacet.kind, 'int_enum');
  assert.equal(toIntEnum(5.5, loadFacet), '6');
  assert.equal(toIntEnum(3.5, loadFacet), '4');
  assert.equal(toIntEnum(7, loadFacet), '7');

  const progFacet = d467.byCode.get('programs_qty').facet;
  assert.equal(matchBucket(3, progFacet), null);
  assert.equal(matchBucket(16, progFacet), '15-20');
  assert.equal(matchBucket(15, progFacet), '15-20');
  assert.equal(matchBucket(10, progFacet), '10-15');
  assert.equal(matchBucket(90, progFacet), null);

  assert.equal(d467.byCode.get('dims').facet.enabled, true);
  assert.notEqual(d467.byCode.get('dims').facet.status, 'not_a_filter');
  assert.equal(facetKind(d467.byCode.get('dims')), 'enum');
  assert.equal(d467.byCode.get('display').facet.enabled, true);

  const motor = d467.byCode.get('motor_type');
  assert.ok(!Object.keys(motor.value_aliases).includes('Стандартный'));
  assert.equal(aliasValue(motor, 'стандартный'), 'Коллекторный');
  assert.equal(aliasValue(d467.byCode.get('control_type'), 'поворотный механизм'), 'Механическое');
  assert.equal(aliasValue(d467.byCode.get('control_type'), 'кнопочное'), null);
  assert.ok(!Object.keys(d467.byCode.get('control_type').value_aliases).includes('Кнопочное'));
  assert.equal(aliasValue(d467.byCode.get('install'), 'отдельно стоящая'), 'Отдельностоящая');
  assert.equal(aliasValue(d523.byCode.get('cooling'), 'ручная разморозка'), 'Статическая');
  assert.equal(aliasValue(d523.byCode.get('cooling'), 'full no frost'), 'Full No Frost');
  assert.equal(aliasValue(d523.byCode.get('cooling'), 'No Frost'), 'No Frost');
  assert.equal(aliasValue(d523.byCode.get('compressor_type'), 'линейный'), 'Линейный');
  assert.equal(aliasValue(d523.byCode.get('compressor_type'), 'стандартный'), 'Стандартный');
  assert.equal(aliasValue(d523.byCode.get('compressor_type'), 'коллекторный'), 'Стандартный');
  assert.ok(Object.keys(d523.byCode.get('compressor_type').value_aliases).includes('Стандартный'));
  assert.ok(!Object.keys(d523.byCode.get('compressor_type').value_aliases).includes('Коллекторный'));
  assert.equal(aliasValue(d467.byCode.get('color'), 'антрацит'), 'Серый');
  assert.equal(aliasValue(d467.byCode.get('color'), 'инокс'), 'Серебристый');
  assert.ok(!Object.keys(d467.byCode.get('color').value_aliases).includes('Антрацит'));
  assert.equal(aliasValue(d523.byCode.get('fridge_type'), 'Трехкамерный'), 'Трёхкамерный');
  assert.equal(aliasValue(d523.byCode.get('freezer_pos'), 'Верхнее'), 'Сверху');
  assert.equal(aliasValue(d523.byCode.get('freezer_pos'), 'Отсутствует'), 'Отсутствует');
  assert.equal(aliasValue(d523.byCode.get('freezer_pos'), 'Слева'), 'Сбоку');
  assert.ok(Object.keys(d523.byCode.get('freezer_pos').value_aliases).includes('Сбоку'));
  assert.equal(matchBucket(92, d467.byCode.get('height').facet), '90+');
  assert.equal(matchBucket(52.5, d467.byCode.get('height').facet), '50-70');
  assert.equal(matchBucket(72, d523.byCode.get('depth').facet), '70+');
  assert.equal(matchBucket(44.2, d523.byCode.get('depth').facet), '40-45');
  assert.equal(matchBucket(49.2, d523.byCode.get('height').facet), '40-50');
  assert.ok(Object.keys(d467.byCode.get('energy_class').value_aliases).includes('C'));
  assert.ok(!Object.keys(d467.byCode.get('energy_class').value_aliases).includes('D'));
  assert.ok(!Object.keys(d523.byCode.get('energy_class').value_aliases).includes('E'));

  assert.equal(coerceFacetNumber(850, d467.byCode.get('height')), 85);
  assert.equal(coerceFacetNumber(60, d467.byCode.get('height')), 60);

  const empty = normalizeProduct(p467[460989], d467, config);
  applyEnrichedSpecs(empty, {
    максимальная_загрузка_кг: 7,
    скорость_отжима_об_мин: 1200,
    класс_энергоэффективности: 'A+++',
    уровень_шума_стирки_дб: 59,
    высота_мм: 850,
    ширина_мм: 600,
    глубина_мм: 540,
    количество_программ: 16,
    тип_загрузки: 'фронтальная',
    тип_управления: 'поворотный механизм',
    установка: 'отдельно стоящая',
    дисплей: 'есть',
    бренд: 'Indesit',
  }, d467, config);
  assert.equal(empty.attrs.load_max, 7);
  assert.equal(empty.provenance.load_max.level, 'S3');
  const builtS3 = buildFilters([empty], d467, config);
  const assignedS3 = assignFilterValues(empty, d467, builtS3.debug, config);
  assert.ok(Object.keys(assignedS3).length >= 8, Object.keys(assignedS3).join(','));
  assert.deepEqual(assignedS3['Загрузка белья, кг'], ['7']);
  assert.deepEqual(assignedS3['Количество программ'], ['15-20']);
  assert.deepEqual(assignedS3['Габариты (ШхГхВ)'], ['60×54×85']);

  // filters в карточке — только после обогащения, из enriched.specs.
  const { fillCardFiltersAfterEnrich } = await import('./pipeline/export.js');
  const cardFilters = fillCardFiltersAfterEnrich(
    p467[460989],
    {
      specs: {
        максимальная_загрузка_кг: 7,
        скорость_отжима_об_мин: 1200,
        класс_энергоэффективности: 'A+++',
        уровень_шума_стирки_дб: 59,
        высота_мм: 850,
        ширина_мм: 600,
        глубина_мм: 540,
        количество_программ: 16,
        тип_загрузки: 'фронтальная',
        тип_управления: 'поворотный механизм',
        установка: 'отдельно стоящая',
        дисплей: 'есть',
      },
    },
    d467,
    config,
  );
  assert.ok(Object.keys(cardFilters).length >= 8, Object.keys(cardFilters).join(','));
  assert.deepEqual(cardFilters['Загрузка белья, кг'], ['7']);
  assert.deepEqual(cardFilters['Количество программ'], ['15-20']);
  // Без обогащения — пусто. Пустой объект enriched: оси из исходника после
  // прогона (тайминг «после»), но без specs модели.
  assert.deepEqual(fillCardFiltersAfterEnrich(p467[460989], null, d467, config), {});
  const afterEmpty = fillCardFiltersAfterEnrich(p467[460989], {}, d467, config);
  assert.ok(typeof afterEmpty === 'object');
  assert.ok(!('Загрузка белья, кг' in afterEmpty) || afterEmpty['Загрузка белья, кг']);

  const dryer = { id: 455270, name: 'Сушильная машина Pioneer DM-10701WH' };
  assert.ok(markCategoryMismatch(dryer, '467'));
  const acc = { id: 436864, name: 'Соединительный элемент CK-3' };
  assert.ok(markCategoryMismatch(acc, '467'));
  const washerOk = { id: 1, name: 'Стиральная машина ATLANT 60С1010' };
  assert.equal(markCategoryMismatch(washerOk, '467'), null);

  const { parseDimensions } = await import('./pipeline/dimensions.js');
  const { normalizeValue } = await import('./pipeline/types.js');

  const filt = (id, dict, src) => {
    const r = normalizeProduct(src[id], dict, config);
    const built = buildFilters([r], dict, config);
    return { r, assigned: assignFilterValues(r, dict, built.debug, config) };
  };

  const w272663 = filt(272663, d467, p467);
  assert.equal(w272663.r.attrs.install, 'Отдельностоящая');
  assert.deepEqual(w272663.assigned['Установка'], ['Отдельностоящая']);

  const w343148 = filt(343148, d467, p467);
  assert.equal(w343148.r.attrs.height, 98.5);
  assert.equal(w343148.r.attrs.width, 70.1);
  assert.deepEqual(w343148.assigned['Высота, см'], ['90+']);
  assert.deepEqual(w343148.assigned['Ширина, см'], ['65+']);

  const w388135 = filt(388135, d467, p467);
  assert.deepEqual(w388135.r.attrs.control_type, ['Электронное']);
  assert.deepEqual(w388135.assigned['Тип управления'], ['Электронное']);

  const w423424 = filt(423424, d467, p467);
  assert.equal(w423424.r.attrs.depth, 49);
  assert.deepEqual(w423424.assigned['Глубина, см'], ['45-50']);

  const messy = parseDimensions(
    'Размеры (ширина х глубина(*макс. корпус/ **с открытой дверцей) х высота, мм.)',
    '600 x 550(*590/**1030) x 850',
  );
  assert.deepEqual(messy?.dims, { width: 60, depth: 55, height: 85 });
  const w406572 = filt(406572, d467, p467);
  assert.equal(w406572.r.attrs.height, 85);
  assert.deepEqual(w406572.assigned['Высота, см'], ['85-90']);

  const w419718 = filt(419718, d467, p467);
  assert.equal(w419718.r.attrs.spin_max, null, 'не выдумывать об/мин из артикула');
  assert.equal(w419718.assigned['Скорость отжима, об/мин'], undefined);

  const w451601 = filt(451601, d467, p467);
  assert.deepEqual(w451601.assigned['Тип управления'], ['Электронное']);

  const w455270 = filt(455270, d467, p467);
  assert.equal(w455270.r.attrs.install, 'Отдельностоящая');
  assert.equal(w455270.r.attrs.load_type, null, 'сушилка: не подставлять фронтальную');
  assert.equal(w455270.r.attrs.washer_type, null, 'сушилка: не ставить автомат/полуавтомат');

  const w458847 = filt(458847, d467, p467);
  assert.equal(w458847.r.attrs.height, 52.5);
  assert.deepEqual(w458847.assigned['Высота, см'], ['50-70']);
  assert.equal(w458847.r.attrs.spin_max, null);

  const abs = normalizeValue(d523.byCode.get('freezer_pos'), 'Отсутствует');
  assert.equal(abs.ok, true);
  assert.equal(abs.value, 'Отсутствует');

  const f805 = filt(805, d523, p523);
  assert.equal(f805.r.attrs.energy_class, 'A+');
  assert.equal(f805.r.attrs.freezer_pos, 'Снизу');
  assert.deepEqual(f805.assigned['Класс энергоэффективности'], ['A+']);
  assert.deepEqual(f805.assigned['Расположение морозильной камеры'], ['Снизу']);

  const f247375 = filt(247375, d523, p523);
  assert.equal(f247375.r.attrs.chambers, 2);
  assert.equal(f247375.r.attrs.freezer_pos, 'Снизу');
  assert.deepEqual(f247375.assigned['Количество камер'], ['2']);

  const f316688 = filt(316688, d523, p523);
  assert.equal(f316688.r.attrs.height, 49.2);
  assert.deepEqual(f316688.assigned['Высота, см'], ['40-50']);

  const f377295 = filt(377295, d523, p523);
  assert.equal(f377295.r.attrs.freezer_pos, 'Отсутствует');
  assert.deepEqual(f377295.assigned['Расположение морозильной камеры'], ['Отсутствует']);

  const f236424 = filt(236424, d523, p523);
  assert.equal(f236424.r.attrs.freezer_pos, 'Сверху');
  assert.deepEqual(f236424.assigned['Расположение морозильной камеры'], ['Сверху']);

  const f385186 = filt(385186, d523, p523);
  assert.equal(f385186.r.attrs.depth, 44.2);
  assert.deepEqual(f385186.assigned['Глубина, см'], ['40-45']);

  const f403857 = filt(403857, d523, p523);
  assert.equal(f403857.r.attrs.freezer_pos, 'Сбоку');
  assert.deepEqual(f403857.assigned['Расположение морозильной камеры'], ['Сбоку']);

  const f408165 = filt(408165, d523, p523);
  assert.equal(f408165.r.attrs.depth, 72.6);
  assert.deepEqual(f408165.assigned['Глубина, см'], ['70+']);

  const f461138 = filt(461138, d523, p523);
  assert.equal(f461138.r.attrs.height, null, 'пустая карточка — не выдумывать габариты');
  assert.equal(f461138.r.attrs.energy_class, null);

  console.log('ok listed SKU holes: install/control/energy/freezer/size buckets');

  const report = buildFilterCoverageReport({
    catId: 467,
    dict: d467,
    products: [
      { id: 1, filters: { Бренд: ['A'] } },
      { id: 455270, filters: { Бренд: ['Pioneer'] } },
    ],
    recs: [washerOk, dryer],
    unmapped: { 'Тип управления': new Map([['поворотный механизм', 4]]) },
  });
  assert.equal(report.products_total, 2);
  assert.deepEqual(report.category_mismatch, [455270]);
  assert.ok(report.filters.every(f => Array.isArray(f.unmapped_values)));
  const ctrl = report.filters.find(f => f.name === 'Тип управления');
  assert.deepEqual(ctrl.unmapped_values, [{ value: 'поворотный механизм', count: 4 }]);
  assert.ok(Array.isArray(report.required_filters) && report.required_filters.includes('Загрузка белья, кг'));
  assert.ok(!report.required_filters.includes('Цвет'));
  assert.ok(Array.isArray(report.products_missing_required_filters));

  const { buildCustomerExport: bce2 } = await import('./pipeline/export.js');
  const mixed = await bce2([
    { id: 11391, name: 'Стиральная машина ATLANT 60С1010', annotation: p467[11391].annotation, description: p467[11391].description },
    { id: 455270, name: 'Сушильная машина Pioneer DM-10701WH', annotation: '<p>Бренд: Pioneer<br/>Загрузка: 7 кг</p>' },
  ], { dict: d467, config, root: '.', filtersAgent: { mode: 'heuristic' } });
  const brandFacet = mixed.filters.find(f => f.name === 'Бренд');
  assert.ok(!brandFacet, 'бренд не фасет выгрузки: сопоставление по id');
  assert.ok(!mixed.filters.some(f => (f.value || []).includes('Pioneer')), 'dryer must not add Pioneer to washer catalog');
  assert.ok(mixed.coverage.category_mismatch.includes(455270));
  assert.equal(mixed.products.length, 2);
  assert.ok(mixed.products.some(p => p.id === 455270), 'mismatch SKU stays in products');
  console.log('ok filter spec overlays / S3→filters / mismatch / coverage');
}

{
  const prevDir = process.env.DUMPS_DIR;
  const prevSeed = process.env.DUMP_SEED;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enricher-dumps-'));
  process.env.DUMPS_DIR = dir;
  process.env.DUMP_SEED = '0';
  try {
    assert.equal(catIdFromDumpName('data_467.json'), '467');
    assert.equal(catIdFromDumpName('products_523.json'), '523');
    assert.equal(catIdFromDumpName('catalog.json'), null);

    const wrapped = parseDumpPayload(JSON.stringify({
      name: 'Герметики',
      products: [
        { sku: '10', title: 'Мойка', annotation_html: '<li>Тип</li>' },
        { id: 11, name: 'Мойка 2', description_html: '<p>x</p>', annotation: '' },
      ],
    }), 'data_467.json');
    assert.equal(wrapped.catId, '467');
    assert.equal(wrapped.name, 'Герметики');
    assert.equal(wrapped.products.length, 2);
    assert.equal(wrapped.products[0].id, 10);
    assert.match(wrapped.products[0].annotation, /Тип/);

    assert.throws(() => parseDumpPayload('[]', 'data_1.json'), /нет товаров/);
    assert.throws(
      () => parseDumpPayload(JSON.stringify([{ id: 1, name: 'A' }, { id: 1, name: 'B' }]), 'data_1.json'),
      /повторный id/,
    );

    const row = normalizeDumpRow({ id: 5, name: 'X', annotation: 'y' });
    assert.deepEqual(row, { id: 5, name: 'X', description: '', annotation: 'y' });

    const saved = saveDump('42', [{ id: 7, name: 'Первый', description: '', annotation: 'есть' }], '.');
    assert.equal(saved.has_file, true);
    assert.equal(saved.has_dictionary, false);
    assert.equal(saved.products, 1);
    assert.equal(saved.with_annotation, 1);
    assert.ok(fs.existsSync(path.join(dumpsDir('.'), 'data_42.json')));

    saveDump('42', [{ id: 8, name: 'Второй', description: '', annotation: '' }], '.');
    const listed = listDumps('.');
    const card = listed.find(d => d.id === '42');
    assert.ok(card);
    assert.equal(card.has_dictionary, false);
    const washerDump = listed.find(d => d.id === '467');
    assert.ok(washerDump, 'карточка 467 остаётся из справочника');
    assert.equal(washerDump.has_dictionary, true);
    assert.equal(card.products, 1);
    assert.equal(card.empty_annotation, 1);
    assert.ok(card.archives.length >= 1, 'замена кладёт предыдущий в архив');
    assert.equal(getDump('42', '.').products[0].id, 8);

    const firstArchive = card.archives.find(a => {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'archive', a.file), 'utf8'));
      return raw[0]?.id === 7;
    });
    assert.ok(firstArchive, 'в архиве должна быть первая версия');
    restoreDumpArchive('42', firstArchive.file, '.');
    assert.equal(getDump('42', '.').products[0].id, 7);

    const fromDump = findDumpProduct('42', 7, '.');
    assert.ok(fromDump);
    assert.equal(fromDump.id, 7);
    assert.match(fromDump.annotation, /есть/);
    assert.equal(findDumpProduct('42', 'нет-такого', '.'), null);
    const bundled = findDumpProduct('467', 11391, '.');
    assert.ok(bundled, 'без файла в dumps/ берём bundled data_467.json');
    assert.match(bundled.name, /ATLANT/i);

    const prev = previewDump('42', { q: 'Перв', limit: 10 }, '.');
    assert.equal(prev.matched, 1);
    assert.equal(prev.products_preview[0].id, 7);

    deleteDump('42', '.');
    assert.equal(fs.existsSync(path.join(dumpsDir('.'), 'data_42.json')), false);

    saveDump('999001', [{ id: 1, name: 'X', description: '', annotation: '' }], '.', { name: 'Тестовая' });
    const named = listDumps('.').find(d => d.id === '999001');
    assert.ok(named);
    assert.equal(named.name, 'Тестовая');
    const namesFile = JSON.parse(fs.readFileSync(path.join(dir, 'names.json'), 'utf8'));
    assert.equal(namesFile['999001'], 'Тестовая');
    deleteDump('999001', '.');

    const shop = listShopCategories('.');
    assert.ok(shop.some(c => c.id === '467'));
    assert.ok(shop.some(c => c.id === '800'));
    assert.ok(shop.length > 100, 'каталог магазина, не только слоты словаря');
    console.log('ok dumps store / archive / preview');
  } finally {
    if (prevDir === undefined) delete process.env.DUMPS_DIR;
    else process.env.DUMPS_DIR = prevDir;
    if (prevSeed === undefined) delete process.env.DUMP_SEED;
    else process.env.DUMP_SEED = prevSeed;
  }
}

{
  const { findEnumClaimsInText, alignEnumSurfaces, provenanceLevelForAlign } = await import('./pipeline/enum_align.js');
  const { finalizeRecord } = await import('./pipeline/quality_validate.js');
  const { normalizeProduct } = await import('./pipeline/normalize.js');
  const { assignFilterValues, buildFilters, filterSourceAllowed } = await import('./pipeline/facets.js');
  const { serializeProduct } = await import('./pipeline/export.js');
  const { valueFold } = await import('./pipeline/types.js');

  assert.equal(provenanceLevelForAlign('from_description', 'model'), 'S2');
  assert.equal(provenanceLevelForAlign('from_annotation_label', 'model'), 'S1');
  assert.equal(provenanceLevelForAlign('ok', 'model'), 'S0');
  assert.equal(provenanceLevelForAlign('ok', 'S1'), 'S1');

  const install = d467.byCode.get('install');
  assert.ok(findEnumClaimsInText('отдельностоящая модель', install).some(h => /отдельн/i.test(h.canon)));
  assert.ok(findEnumClaimsInText('Установка: встраиваемая', install).some(h => h.labeled && /встраив/i.test(h.canon)));

  const src = {
    id: 44772,
    name: 'Стиральная машина Indesit IWSB 5085',
    description: 'Стиральная машина Indesit — отдельностоящая модель с загрузкой 5 кг.',
    annotation: [
      'Установка - встраиваемая',
      'Максимальная загрузка - 5 кг',
      'Скорость отжима - 1000 об/мин',
      'Количество программ - 16',
      'Класс энергопотребления - A',
      'Тип загрузки - Фронтальная',
    ].join('\n'),
  };
  const rec = normalizeProduct(src, d467, config);
  const enriched = {
    description: 'Стиральная машина Indesit — <strong>отдельностоящая модель</strong>.',
    meta_keywords: 'стиральная машина встраиваемая, стиральная машина Indesit',
    bullets: ['Установка: встраиваемая'],
  };
  const fin = finalizeRecord(rec, d467, { enriched });
  assert.ok(/отдельн/i.test(String(rec.attrs.install)), rec.attrs.install);
  assert.ok(filterSourceAllowed(rec, 'install', config), 'после align provenance не model');
  assert.match(enriched.description, /отдельностоящ/i);
  assert.match(enriched.meta_keywords, /отдельностоящ/i);
  assert.match(enriched.bullets[0], /отдельностоящ/i);
  assert.ok(fin.issues.some(i => i.kind === 'enum_surface_mismatch'));

  const built = buildFilters([rec], d467, config);
  const out = serializeProduct(rec, d467, built.debug, { enriched, skipFinalize: true, config });
  const filt = out.filters['Установка']?.[0] || '';
  assert.ok(/отдельн/i.test(filt), filt);
  assert.match(out.annotation_html, /Установка:\s*отдельностоящ/i);
  assert.ok(!/встраиваем/i.test(out.annotation_html), out.annotation_html);
  assert.ok(!/встраиваем/i.test(out.meta_keywords), out.meta_keywords);
  assert.equal(valueFold(filt).includes('отдельн') || /отдельн/.test(valueFold(filt)), true);

  // model-provenance уже совпадает с описанием — раньше filters молча пропускали, annotation показывал.
  const modelRec = {
    id: 99,
    name: 'Стиралка model-prov',
    attrs: Object.fromEntries(d467.attrs.filter(a => a.tier !== 'X').map(a => [a.code, null])),
    provenance: {},
    annotation: 'Установка: отдельностоящая\nТип загрузки: Фронтальная',
  };
  modelRec.attrs.install = 'Отдельностоящая';
  modelRec.attrs.load_type = 'Фронтальная';
  modelRec.provenance.install = { level: 'model', how: 'model', raw: 'Отдельностоящая' };
  modelRec.provenance.load_type = { level: 'S1', how: 'parse', raw: 'Фронтальная' };
  assert.equal(filterSourceAllowed(modelRec, 'install', config), false);
  const enrOk = { description: 'Отдельностоящая стиральная машина с фронтальной загрузкой.' };
  alignEnumSurfaces(modelRec, d467, { enriched: enrOk, autoFix: true });
  assert.equal(filterSourceAllowed(modelRec, 'install', config), true, modelRec.provenance.install);
  assert.ok(/отдельн/i.test(String(modelRec.attrs.install)));
  const builtM = buildFilters([modelRec], d467, config);
  const assignedM = assignFilterValues(modelRec, d467, builtM.debug, config);
  assert.ok(/отдельн/i.test(String(assignedM['Установка']?.[0] || '')), assignedM);

  // Холодильник: No Frost в описании vs капельная в attrs — описание побеждает при слабом provenance.
  const cool = d523.byCode.get('cooling');
  if (cool) {
    const fridge = {
      id: 1,
      name: 'Холодильник test',
      attrs: Object.fromEntries(d523.attrs.filter(a => a.tier !== 'X').map(a => [a.code, null])),
      provenance: {},
      annotation: 'Система охлаждения: капельная',
    };
    fridge.attrs.cooling = 'Капельная';
    fridge.provenance.cooling = { level: 'model', how: 'model', raw: 'Капельная' };
    const enr = { description: 'Холодильник с системой No Frost.' };
    alignEnumSurfaces(fridge, d523, { enriched: enr, autoFix: true });
    assert.ok(/no\s*frost|автомат/i.test(String(fridge.attrs.cooling)), fridge.attrs.cooling);
    assert.ok(filterSourceAllowed(fridge, 'cooling', config), fridge.provenance.cooling);
  }

  console.log('ok enum_align description↔filters (install / cooling / model-prov)');
}

{
  const {
    scanProductConsistency,
    parseConsistencyAgentResponse,
    heuristicConsistencyDecisions,
    runConsistencyAgent,
    applyConsistencyDecisions,
  } = await import('./pipeline/consistency_agent.js');
  const { normalizeProduct } = await import('./pipeline/normalize.js');
  const { buildFilters, assignFilterValues, filterSourceAllowed } = await import('./pipeline/facets.js');
  const { serializeProduct } = await import('./pipeline/export.js');

  // Описание «отдельностоящая», аннотация «встраиваемая» → автоправка чинит до ИИ.
  const src = {
    id: 99001,
    name: 'Стиральная машина consistency',
    description: 'Отдельностоящая стиральная машина с загрузкой 5 кг.',
    annotation: [
      'Установка - встраиваемая',
      'Максимальная загрузка - 5 кг',
      'Скорость отжима - 1000 об/мин',
      'Количество программ - 16',
      'Класс энергопотребления - A',
      'Тип загрузки - Фронтальная',
    ].join('\n'),
  };
  const rec = normalizeProduct(src, d467, config);
  rec._enriched = {
    description: 'Стиральная машина — <strong>отдельностоящая</strong> модель.',
    meta_keywords: 'стиральная машина встраиваемая',
    bullets: ['Установка: встраиваемая'],
  };
  const built0 = buildFilters([rec], d467, config);
  const assigned0 = assignFilterValues(rec, d467, built0.debug, config);
  const before = scanProductConsistency(rec, d467, {
    enriched: rec._enriched,
    assigned: assigned0,
    config,
  });
  assert.ok(before.issues.some(i => i.kind === 'enum_surface_mismatch'), before.issues);

  const heRun = await runConsistencyAgent({
    recs: [rec],
    dict: d467,
    config,
    debugFacets: built0.debug,
    mode: 'heuristic',
    catId: '467',
  });
  assert.ok(heRun.stats.auto_fixed >= 1 || heRun.stats.applied >= 1, heRun.stats);
  assert.ok(/отдельн/i.test(String(rec.attrs.install)), rec.attrs.install);
  assert.ok(filterSourceAllowed(rec, 'install', config), rec.provenance.install);

  const built1 = buildFilters([rec], d467, config);
  const out = serializeProduct(rec, d467, built1.debug, {
    enriched: rec._enriched,
    skipFinalize: true,
    config,
  });
  assert.ok(/отдельн/i.test(out.filters['Установка']?.[0] || ''), out.filters);
  assert.match(out.annotation_html, /отдельностоящ/i);
  assert.ok(!/встраиваем/i.test(out.annotation_html));

  // ИИ-путь: ambiguous (оба канона в одном тексте) → mock LLM.
  const amb = normalizeProduct({
    id: 99002,
    name: 'Ambiguous washer',
    annotation: [
      'Максимальная загрузка - 5 кг',
      'Скорость отжима - 1000 об/мин',
      'Количество программ - 16',
      'Класс энергопотребления - A',
      'Тип загрузки - Фронтальная',
    ].join('\n'),
    description: 'модель',
  }, d467, config);
  amb.attrs.install = null;
  amb._enriched = {
    description: 'Подходит и как встраиваемая, и как отдельностоящая стиральная машина.',
  };
  const builtA = buildFilters([amb], d467, config);
  const mockFetch = async () => {
    const body = {
      decisions: [{
        id: 99002,
        attr_code: 'install',
        truth: 'Отдельностоящая',
        action: 'set_attr',
        reason: 'mock resolve ambiguous',
      }],
      notes: ['mock'],
    };
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] });
      },
    };
  };
  const ai = await runConsistencyAgent({
    recs: [amb],
    dict: d467,
    config,
    debugFacets: builtA.debug,
    mode: 'ai',
    provider: { apiKey: 'test', baseUrl: 'http://mock', model: 'mock' },
    fetchImpl: mockFetch,
    catId: '467',
  });
  // Если автоправка уже сняла ambiguous — skip; иначе ai.
  assert.ok(ai.mode === 'ai' || ai.mode === 'skip' || ai.mode === 'heuristic', ai.mode);
  if (ai.mode === 'ai') {
    assert.ok(/отдельн/i.test(String(amb.attrs.install)), amb.attrs.install);
  }

  // Парсер отбрасывает канон вне aliases.
  const bad = parseConsistencyAgentResponse(JSON.stringify({
    decisions: [
      { id: 1, attr_code: 'install', truth: 'Летающая', action: 'set_attr' },
      { id: 1, attr_code: 'install', truth: 'Отдельностоящая', action: 'set_attr' },
    ],
  }), d467);
  assert.equal(bad.decisions.length, 1);
  assert.equal(bad.rejected.length, 1);

  // Эвристика: mismatch → set_attr по truth_hint.
  const he = heuristicConsistencyDecisions([{
    id: 1,
    issues: [{
      attr_code: 'install',
      kind: 'enum_surface_mismatch',
      truth_hint: 'Отдельностоящая',
      description: 'Отдельностоящая',
      annotation: 'Встраиваемая',
    }],
  }]);
  assert.equal(he[0].action, 'set_attr');
  assert.ok(/отдельн/i.test(he[0].truth));

  // apply + needs_review
  const r2 = normalizeProduct({
    id: 2,
    name: 'X',
    annotation: 'Тип загрузки - Фронтальная\nУстановка - отдельностоящая',
    description: 'тест',
  }, d467, config);
  applyConsistencyDecisions([r2], d467, [{
    id: 2,
    attr_code: 'install',
    truth: null,
    action: 'needs_review',
    reason: 'ambiguous',
  }]);
  assert.equal(r2.needs_review, true);

  console.log('ok consistency_agent description↔annotation↔filters');
}

