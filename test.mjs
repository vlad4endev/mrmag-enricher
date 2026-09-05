/**
 * test.mjs — самопроверка логики разбора и валидации. Запуск: node test.mjs
 * Без фреймворков: если что-то из этого падает, обогащение писать мусор в каталог.
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  coerceNumber, extractFacts as extractFactsIn, crossCheck, parseResponse,
  repairTruncatedJson, MAX_COMPLETION_TOKENS,
  normalizeResponse as normalizeResponseIn, stripHtml, RateLimiter, isEnrichable,
  buildUserContent, rpmFor, attrFacts, productFacts, modelToken, hasCountryFact,
  SCHEMAS, GENERIC_SCHEMA, schemaFor, schemaForProduct, buildSystemPrompt, enrichProduct, netError,
  seoPackageEmpty, cardTextsEmpty,
} from './lib.js';

// Схема по умолчанию — универсальная, а не холодильник: неизвестная категория
// не должна молча получать чужие поля. Тесты холодильника называют схему сами,
// а сам дефолт проверяется отдельно в разделе «Схемы категорий».
const extractFacts = (text, key = 'kholodilniki') => extractFactsIn(text, key);
const normalizeResponse = (data, src = '', key = 'kholodilniki', attrs = []) => normalizeResponseIn(data, src, key, attrs);
const attr = (name, value) => ({ name, value });
import { parseListing, parseProductPage, buildFilters, assignMissingBrands, writeCategoryFiles,
  parseSearchResults, parseAnyProductPage, pageDescribesProduct } from './catalog.js';
import http from 'http';
import { buildV2, splitKey } from './export_v2.js';
import { loadDictionary } from './pipeline/dict.js';
import { parseProxy, startBridge, setupProxy, mergeNoProxy, applyDirectHosts } from './socks.js';
import net from 'net';

// fetch подменяется в разделе про запросы к модели. Возвращаем именно исходный,
// а не удаляем: delete снимает встроенный fetch на весь процесс, и тесты,
// которым нужна настоящая сеть (поиск товара), падают на «fetch is not defined».
const nativeFetch = globalThis.fetch;

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
const tAsync = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };

console.log('\nПриведение чисел');
t('строка с единицей → число', () => {
  assert.strictEqual(coerceNumber('310 л'), 310);
  assert.strictEqual(coerceNumber('57,4'), 57.4);
  assert.strictEqual(coerceNumber('≈60 кг'), 60);
  assert.strictEqual(coerceNumber(42), 42);
});
t('пустые маркеры → null', () => {
  for (const v of [null, undefined, '', '-', '—', 'нет данных', 'не указано', 'N/A', 'текст']) {
    assert.strictEqual(coerceNumber(v), null, `ожидался null для ${JSON.stringify(v)}`);
  }
});
t('NaN и Infinity → null', () => {
  assert.strictEqual(coerceNumber(NaN), null);
  assert.strictEqual(coerceNumber(Infinity), null);
});

console.log('\nОчистка HTML');
t('теги и сущности', () => {
  assert.strictEqual(stripHtml('<p>Объём&nbsp;310&nbsp;л</p>'), 'Объём 310 л');
  assert.strictEqual(stripHtml('57.4&times;61'), '57.4×61');
  assert.strictEqual(stripHtml(null), '');
});

console.log('\nФакты из текста (кириллица)');
t('реальное описание из каталога', () => {
  // Справочник разбирает пары ключ–значение; габариты без подписи осей → tallest.
  const f = extractFacts(
    'Габариты: 57.4x61x171 см<br>Общий объем - 310 л<br>Класс энергоэффективности - A<br>Количество камер - 2',
  );
  assert.deepStrictEqual(f.размеры_мм, [574, 610, 1710]);
  assert.strictEqual(f.высота_мм, 1710);
  assert.strictEqual(f.объем_общий_л, 310);
  assert.strictEqual(f.класс_энергоэффективности, 'A');
  assert.strictEqual(f.количество_камер, 2);
});
t('\\w не ломает кириллические суффиксы', () => {
  assert.strictEqual(extractFacts('Общий объём: 250 л').объем_общий_л, 250);
  assert.strictEqual(extractFacts('Вес: 62 кг').вес_кг, 62);
  assert.strictEqual(extractFacts('Количество камер - 3').количество_камер, 3);
});
t('система охлаждения', () => {
  assert.strictEqual(extractFacts('Система охлаждения - No Frost').система_охлаждения, 'No Frost');
  assert.strictEqual(extractFacts('Система охлаждения - капельная').система_охлаждения, 'Капельная');
});
t('страна производства и изготовления — одно поле', () => {
  assert.strictEqual(extractFacts('Страна производства - Россия').страна_производства, 'Россия');
  assert.strictEqual(extractFacts('Страна изготовления - Китай').страна_производства, 'Китай');
  assert.strictEqual(extractFacts('Страна-изготовитель: Беларусь').страна_производства, 'Беларусь');
  assert.equal(hasCountryFact({
    description: '',
    annotation: 'Общий объем - 310 л<br>Страна изготовления - Китай',
  }, 'kholodilniki'), true);
  assert.equal(hasCountryFact({
    description: 'Двухкамерный холодильник с общим объёмом 310 л и системой No Frost.',
    annotation: 'Общий объем - 310 л',
  }, 'kholodilniki'), false);
});
t('шум и миллиметры без пересчёта', () => {
  assert.strictEqual(extractFacts('Уровень шума - 39 дБ').уровень_шума_дб, 39);
  assert.deepStrictEqual(extractFacts('600x650x2000 мм').размеры_мм, [600, 650, 2000]);
});
t('пустой текст не падает', () => {
  assert.deepStrictEqual(extractFacts(''), {});
  assert.deepStrictEqual(extractFacts(null), {});
});

console.log('\nСверка с фактами');
t('совпадение не даёт предупреждений', () => {
  const facts = extractFacts('Габариты: 57.4x61x171 см<br>Общий объем - 310 л<br>Класс энергоэффективности - A');
  const specs = { объем_общий_л: 310, класс_энергоэффективности: 'A', высота_мм: 1710, ширина_мм: 574, глубина_мм: 610 };
  assert.deepStrictEqual(crossCheck(specs, facts), []);
});
t('расхождение по числу помечается', () => {
  const facts = extractFacts('Общий объем - 310 л');
  const w = crossCheck({ объем_общий_л: 250 }, facts);
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].field, 'объем_общий_л');
  assert.strictEqual(w[0].source, 310);
});
t('размер не из текста помечается', () => {
  const facts = extractFacts('размер 57.4x61x171 см');
  const w = crossCheck({ ширина_мм: 900 }, facts);
  assert.strictEqual(w.length, 1);
  assert.match(w[0].note, /нет в размерах/);
});
t('перепутанные оси не считаются ошибкой', () => {
  const facts = extractFacts('размер 57.4x61x171 см');
  assert.deepStrictEqual(crossCheck({ ширина_мм: 610, глубина_мм: 574 }, facts), []);
});
t('null у модели не проверяется', () => {
  const facts = extractFacts('Общий объем - 310 л');
  assert.deepStrictEqual(crossCheck({ объем_общий_л: null }, facts), []);
});

console.log('\nОтбор товаров, за которые стоит платить');
t('короткое, но плотное описание НЕ пропускается', () => {
  const p = {
    description: 'Габариты: 57.4x61x171 см. Общий объем - 310 л. Класс энергоэффективности - A.',
  };
  assert.ok(p.description.length < 120, 'описание должно быть коротким');
  assert.strictEqual(isEnrichable(p).ok, true, 'плотное описание нельзя отсекать по длине');
});
t('короткое и без характеристик пропускается', () => {
  const r = isEnrichable({ description: 'Холодильник белый' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /ни одной распознанной/);
});
t('пустой товар пропускается', () => {
  assert.strictEqual(isEnrichable({}).ok, false);
  assert.match(isEnrichable({ description: '   ' }).reason, /нет ни description/);
});
t('длинное описание проходит даже без распознанных полей', () => {
  assert.strictEqual(isEnrichable({ description: 'Отличный холодильник для дома. '.repeat(6) }).ok, true);
});
t('annotation учитывается наравне с description', () => {
  assert.strictEqual(isEnrichable({ description: '', annotation: 'Общий объем - 250 л' }).ok, true);
});

console.log('\nРазбор ответа модели');
t('чистый JSON', () => {
  assert.strictEqual(parseResponse('{"a":1}').a, 1);
});
t('обёртка в markdown', () => {
  assert.strictEqual(parseResponse('```json\n{"a":2}\n```').a, 2);
  assert.strictEqual(parseResponse('```\n{"a":3}\n```').a, 3);
});
t('массив вместо объекта → первый элемент', () => {
  assert.strictEqual(parseResponse('[{"a":4}]').a, 4);
});
t('JSON среди пояснений', () => {
  assert.strictEqual(parseResponse('Вот результат: {"a":5} — готово').a, 5);
});
t('пустой ответ бросает', () => {
  assert.throws(() => parseResponse(''), /Пустой ответ/);
  assert.throws(() => parseResponse('совсем не json'), /распарсить/);
});
t('обрезанный JSON закрывает строку и скобки', () => {
  const r = repairTruncatedJson('{"specs":{"бренд":"DON"},"seo_description":"Холодильник DON');
  assert.strictEqual(r.specs.бренд, 'DON');
  assert.match(r.seo_description, /^Холодильник DON/);
});

console.log('\nНормализация');
t('числа-строки приводятся, схема заполняется целиком', () => {
  const r = normalizeResponse({
    specs: { объем_общий_л: '310 л', вес_кг: '≈60', бренд: 'DON', цвет: 'нет данных' },
    synonyms: ['а', '  б  ', ''],
    seo_description: '  Описание.  ',
  }, 'общий объем 310 л');
  assert.strictEqual(r.specs.объем_общий_л, 310);
  assert.strictEqual(r.specs.вес_кг, 60);
  assert.strictEqual(r.specs.бренд, 'DON');
  assert.strictEqual(r.specs.цвет, null, '"нет данных" должно стать null');
  assert.strictEqual(r.specs.хладагент, null, 'отсутствующий ключ схемы должен быть null');
  assert.deepStrictEqual(r.synonyms, ['а', 'б']);
  assert.strictEqual(r.seo_description, 'Описание.');
  assert.deepStrictEqual(r.warnings, []);
});
t('мусор вместо массивов не роняет', () => {
  const r = normalizeResponse({ specs: {}, synonyms: 'строка', seo_keywords: null });
  assert.deepStrictEqual(r.synonyms, []);
  assert.deepStrictEqual(r.seo_keywords, []);
});
t('не объект бросает', () => {
  assert.throws(() => normalizeResponse(null), /не объект/);
  assert.throws(() => normalizeResponse([1]), /не объект/);
});
t('расхождение доезжает до warnings', () => {
  const r = normalizeResponse({ specs: { объем_общий_л: 250 } }, 'Общий объем - 310 л');
  assert.strictEqual(r.warnings.length, 1);
  assert.strictEqual(r.source_facts.объем_общий_л, 310);
});

console.log('\nАтрибуты магазина как источник фактов');
// Все значения ниже взяты дословно из products_523.json и products_467.json.
t('однозначное значение атрибута становится фактом', () => {
  const f = k => attrFacts([attr('Система разморозки', k)], 'kholodilniki').facts.система_охлаждения;
  assert.strictEqual(f('Total No Frost'), 'No Frost');
  assert.strictEqual(f('Full No Frost'), 'No Frost');
  assert.strictEqual(f('Капельная система'), 'капельная');
  assert.strictEqual(f('Ручная разморозка'), 'ручная разморозка');
  // «Автоматическая» в атрибутах магазина — та же No Frost.
  assert.strictEqual(f('Автоматическая/ No Frost'), 'No Frost');
});
t('атрибут с двумя системами сразу — это фасет фильтра, а не характеристика', () => {
  const f = k => attrFacts([attr('Система разморозки', k)], 'kholodilniki').facts.система_охлаждения;
  // 75 товаров каталога: «или капельная, или ручная» — какая именно, неизвестно.
  assert.strictEqual(f('Капельная система/ручная'), undefined);
  assert.strictEqual(f('Автоматическая/ручная'), undefined, '«автоматическая» тоже вариант, значит их два');
  assert.strictEqual(f('No Frost/капельная'), undefined);
});
t('интервал фильтра не выдаётся за точное значение', () => {
  const { facts, bounds } = attrFacts([attr('Высота холодильника', 'От 181 до 190 см')], 'kholodilniki');
  assert.strictEqual(facts.высота_мм, undefined, 'подставить интервал в поле нельзя');
  assert.deepStrictEqual([bounds.высота_мм.lo, bounds.высота_мм.hi], [1810, 1900]);
});
t('открытый интервал не получает выдуманной второй границы', () => {
  // Регрессия: с /от\b/ проверка не срабатывала — в JS кириллица неслововая, —
  // и «От 201 см» молча становилось точной высотой 2010 мм.
  const { facts, bounds } = attrFacts([attr('Высота холодильника', 'От 201 см')], 'kholodilniki');
  assert.strictEqual(facts.высота_мм, undefined);
  assert.deepStrictEqual([bounds.высота_мм.lo, bounds.высота_мм.hi], [2010, Infinity]);
  const до = attrFacts([attr('Общий Объем', 'До 100л')], 'kholodilniki').bounds.объем_общий_л;
  assert.deepStrictEqual([до.lo, до.hi], [0, 100]);
});
t('число без «от/до» — точное значение', () => {
  const f = v => attrFacts([attr('Мax загрузка белья, (кг)', v)], 'stiralnye_mashiny').facts;
  assert.strictEqual(f('7').максимальная_загрузка_кг, 7);
  assert.strictEqual(f('5.5').максимальная_загрузка_кг, 5.5);
  const b = attrFacts([attr('Глубина, (см)', 'от 40,5 до 50')], 'stiralnye_mashiny').bounds;
  assert.deepStrictEqual([b.глубина_мм.lo, b.глубина_мм.hi], [405, 500], 'запятая как разделитель, см → мм');
});
t('спор текста с атрибутом снимает факт, а не выбирает победителя', () => {
  // Товар 561253: в тексте 194,7 см, в фильтре полка «От 181 до 190 см».
  // Магазин противоречит сам себе — сверять модель по такому нельзя.
  const p = { description: 'Высота 194.7 см', attributes: [attr('Высота холодильника', 'От 181 до 190 см')] };
  const { facts, bounds } = productFacts(p, 'kholodilniki');
  assert.strictEqual(facts.высота_мм, undefined);
  assert.strictEqual(bounds.высота_мм, undefined);
});
t('точное число из текста подтверждает интервал и снимает его', () => {
  const p = { description: 'Высота 185 см', attributes: [attr('Высота холодильника', 'От 181 до 190 см')] };
  const { facts, bounds } = productFacts(p, 'kholodilniki');
  assert.strictEqual(facts.высота_мм, 1850);
  assert.strictEqual(bounds.высота_мм, undefined, 'сверять дважды одно и то же незачем');
});

console.log('\nСверка по интервалу атрибута');
t('значение внутри интервала расхождением не считается', () => {
  const r = normalizeResponse({ specs: { объем_общий_л: 350 } }, 'Холодильник',
    'kholodilniki', [attr('Общий Объем', 'От 301л до 400л')]);
  assert.deepStrictEqual(r.warnings, []);
});
t('значение вне интервала попадает в расхождения', () => {
  const r = normalizeResponse({ specs: { объем_общий_л: 180 } }, 'Холодильник',
    'kholodilniki', [attr('Общий Объем', 'От 301л до 400л')]);
  assert.strictEqual(r.warnings.length, 1);
  assert.strictEqual(r.warnings[0].field, 'объем_общий_л');
  assert.match(r.warnings[0].note, /От 301л до 400л/, 'в тексте расхождения видно, чем именно недоволен');
});
t('округление магазина по границе не придирка', () => {
  // 1800 мм в полке «От 181 до 190 см» — товаровед округлил, а не ошибся.
  const r = normalizeResponse({ specs: { высота_мм: 1800 } }, 'Холодильник',
    'kholodilniki', [attr('Высота холодильника', 'От 181 до 190 см')]);
  assert.deepStrictEqual(r.warnings, []);
});
t('атрибут добирает поле, которое модель оставила пустым', () => {
  const r = normalizeResponse({ specs: { система_охлаждения: null } }, 'Холодильник',
    'kholodilniki', [attr('Система разморозки', 'Total No Frost')]);
  assert.strictEqual(r.specs.система_охлаждения, 'No Frost');
  assert.ok(r.filled_from_text.includes('система_охлаждения'));
});

console.log('\nОграничитель частоты');
t('не превышает rpm в минутном окне', () => {
  const rl = new RateLimiter(20);
  let clock = 0, calls = [];
  // Имитация без реального ожидания: повторяем арифметику wait().
  for (let i = 0; i < 100; i++) {
    rl.window = rl.window.filter(x => clock - x < 60_000);
    if (rl.window.length >= rl.rpm) clock += 60_000 - (clock - rl.window[0]) + 150;
    else if (clock - rl.lastCall < rl.minDelay) clock += rl.minDelay - (clock - rl.lastCall);
    rl.lastCall = clock; rl.window.push(clock); calls.push(clock);
  }
  for (const start of calls) {
    const inWindow = calls.filter(c => c >= start && c < start + 60_000).length;
    assert.ok(inWindow <= 20, `в окне с ${start} оказалось ${inWindow} запросов`);
  }
});

// ── ФОРМАТЫ КАТАЛОГА ─────────────────────────────────────────
// Пары ключ–значение в стиле annotation; эвристики fridgeFacts сняты.
console.log('\nФорматы каталога: единица ПЕРЕД числом');
t('«Вес (кг) - 72» и «Масса, кг., не более 74»', () => {
  assert.strictEqual(extractFacts('Вес (кг) - 72').вес_кг, 72);
  assert.strictEqual(extractFacts('Масса, кг., не более 74').вес_кг, 74);
  assert.strictEqual(extractFacts('Вес: 75 кг').вес_кг, 75);
  assert.strictEqual(extractFacts('Вес - 71 кг').вес_кг, 71);
});
t('«Уровень шума (дБА) - 41» и «Мощность замораживания (кг/сут) - 7»', () => {
  assert.strictEqual(extractFacts('Уровень шума (дБА) - 41').уровень_шума_дб, 41);
  assert.strictEqual(extractFacts('Мощность замораживания (кг/сут) - 7').мощность_замораживания_кг_сут, 7);
});
t('«Общий объем, л 122» и «Объем брутто (л)/Общий - 365»', () => {
  assert.strictEqual(extractFacts('Общий объем, л 122').объем_общий_л, 122);
  assert.strictEqual(extractFacts('Объем брутто (л)/Общий - 365').объем_общий_л, 365);
});
t('«Общий объем холодильника» — это ОБЩИЙ, а не объём камеры', () => {
  const f = extractFacts(
    'Общий объем холодильника - 180 л<br>Объем холодильного отделения - 117 л<br>Объем морозильного отделения - 63 л.',
  );
  assert.strictEqual(f.объем_общий_л, 180);
  assert.strictEqual(f.объем_холодильной_камеры_л, 117, 'подпись «холодильника» не должна давать объём камеры');
  assert.strictEqual(f.объем_морозильной_камеры_л, 63);
});
t('единица обязательна: «Количество полок 3» не литры', () => {
  assert.strictEqual(extractFacts('Общий объем не указан. Количество полок 3').объем_общий_л, undefined);
});
t('диапазон отсекает мусор', () => {
  assert.strictEqual(extractFacts('Высота 2 полки').высота_мм, undefined);
  assert.strictEqual(extractFacts('Вес 2 кг').вес_кг, undefined);
});

console.log('\nГабариты: порядок осей');
t('подписанные оси дают точные ширину/высоту/глубину', () => {
  const f = extractFacts('Габариты (Без упаковки) (Ш × В × Г, мм) - 580× 2010× 610');
  assert.strictEqual(f.ширина_мм, 580);
  assert.strictEqual(f.высота_мм, 2010);
  assert.strictEqual(f.глубина_мм, 610);
});
t('другой порядок осей и сантиметры', () => {
  const f = extractFacts('Габариты (ШxГxВ): 60x64x176 см Холод');
  assert.deepStrictEqual([f.ширина_мм, f.глубина_мм, f.высота_мм], [600, 640, 1760]);
});
t('ВхШхГ читается как ВхШхГ, а не как «высота — самое большое»', () => {
  const f = extractFacts('Габаритные размеры, мм (ВхШхГ) 815x1790x680');
  assert.strictEqual(f.высота_мм, 815, 'подпись важнее эвристики «большое = высота»');
  assert.strictEqual(f.ширина_мм, 1790);
});
t('габариты упаковки не берутся, если есть нетто', () => {
  const f = extractFacts('Размеры с учетом упаковки (ШхГхВ) - 60х62х202 см Габариты (ШхГхВ) - 59х60х200 см');
  assert.strictEqual(f.высота_мм, 2000);
  assert.strictEqual(f.ширина_мм, 590);
});
t('лживая подпись отбрасывается целиком', () => {
  const f = extractFacts('Размеры, мм (ШхГхВ) - 595 х 1860 х 590');
  assert.strictEqual(f.высота_мм, 1860, 'при недостоверной подписи высота = самое большое');
  assert.notStrictEqual(f.глубина_мм, 1860);
});
t('подписи по отдельности', () => {
  const f = extractFacts('Высота, мм - 2025<br>Глубина, мм - 630<br>Ширина, мм - 595');
  assert.deepStrictEqual([f.высота_мм, f.глубина_мм, f.ширина_мм], [2025, 630, 595]);
});
t('см и значение без единицы', () => {
  assert.strictEqual(extractFacts('Высота 100,1 см').высота_мм, 1001);
  assert.strictEqual(extractFacts('Высота - 202').высота_мм, 2020);
  assert.strictEqual(extractFacts('Высота, мм - 2025').высота_мм, 2025);
});

console.log('\nОхлаждение и класс энергоэффективности');
t('«без No Frost» → капельная (алиас справочника), не No Frost', () => {
  assert.strictEqual(extractFacts('Система охлаждения - без NO FROST').система_охлаждения, 'Капельная');
  assert.strictEqual(extractFacts('Система охлаждения - Без No Frost').система_охлаждения, 'Капельная');
});
t('«No Frost Нет» не становится положительным No Frost', () => {
  assert.notStrictEqual(extractFacts('No Frost - Нет').система_охлаждения, 'No Frost');
  assert.notStrictEqual(extractFacts('Система охлаждения - Нет').система_охлаждения, 'No Frost');
});
t('пара «Система охлаждения - No Frost»', () => {
  assert.strictEqual(extractFacts('Система охлаждения - No Frost').система_охлаждения, 'No Frost');
  assert.strictEqual(extractFacts('Система охлаждения - капельная').система_охлаждения, 'Капельная');
});
t('кириллическая «А+» приводится к латинской', () => {
  assert.strictEqual(extractFacts('Класс энергоэффективности - А+').класс_энергоэффективности, 'A+');
  assert.strictEqual(extractFacts('Класс энергоэффективности - A++').класс_энергоэффективности, 'A++');
  assert.strictEqual(extractFacts('класс A').класс_энергоэффективности, 'A');
});
t('климатический класс не уходит в энергоэффективность', () => {
  assert.strictEqual(extractFacts('Климатический класс SN-ST').класс_энергоэффективности, undefined);
  assert.strictEqual(extractFacts('Климатический класс - N, ST').класс_энергоэффективности, undefined);
});
t('хладагент', () => {
  assert.strictEqual(extractFacts('Хладагент - R600a').хладагент, 'R600a');
  assert.match(String(extractFacts('Хладагент - R 600A').хладагент || ''), /R\s*600a/i);
});

console.log('\nСверка: одно расхождение на поле');
t('высота не помечается дважды', () => {
  const facts = extractFacts('размер 57.4x61x171 см');
  const w = crossCheck({ высота_мм: 900 }, facts);
  assert.strictEqual(w.length, 1, 'общая сверка и проверка тройки не должны дублировать поле');
});

console.log('\nДобор пустых полей и передача фактов модели');
t('null у модели заполняется фактом из текста', () => {
  const r = normalizeResponse({ specs: { бренд: 'DON' } }, 'Общий объем, л - 310<br>Вес (кг) - 62');
  assert.strictEqual(r.specs.объем_общий_л, 310);
  assert.strictEqual(r.specs.вес_кг, 62);
  assert.ok(r.filled_from_text.includes('объем_общий_л'), 'добор должен быть перечислен');
  assert.deepStrictEqual(r.warnings, [], 'добор — не расхождение');
});
t('значение модели не перезаписывается добором', () => {
  const r = normalizeResponse({ specs: { объем_общий_л: 305 } }, 'Общий объем, л - 310');
  assert.strictEqual(r.specs.объем_общий_л, 305);
  assert.deepStrictEqual(r.filled_from_text, []);
});
t('facts уезжают в запрос к модели', () => {
  const body = JSON.parse(buildUserContent(
    { name: 'X', description: 'Общий объем, л - 310' },
    extractFacts('Общий объем, л - 310'),
  ));
  assert.strictEqual(body.facts.объем_общий_л, 310);
  assert.strictEqual(JSON.parse(buildUserContent({ name: 'X' })).facts, undefined);
});
t('rpm известных моделей не занижается до 20', () => {
  assert.strictEqual(rpmFor('openai/gpt-4o-mini'), 500);
  assert.strictEqual(rpmFor('чего-то-нет'), 20);
});

// ── КАТЕГОРИИ И СХЕМЫ ────────────────────────────────────────
console.log('\nСхемы категорий');
t('схема находится по slug, id и названию', () => {
  assert.strictEqual(schemaFor('stiralnye_mashiny').id, 467);
  assert.strictEqual(schemaFor(467).slug, 'stiralnye_mashiny');
  assert.strictEqual(schemaFor('Холодильники').id, 523);
  assert.strictEqual(schemaFor('чего-то нет').slug, '_generic', 'неизвестная категория — универсальная схема');
  assert.strictEqual(schemaFor('').slug, '_generic');
  assert.strictEqual(schemaFor('Техника для дома/Холодильники').slug, 'kholodilniki',
    'из пути категории берётся самый точный раздел');
  assert.strictEqual(schemaFor('Посуда').slug, 'posuda');
  assert.strictEqual(schemaFor({ id: 523 }).slug, 'kholodilniki', 'объект категории с id — не generic');
});
t('холодильник без category не уходит в универсальные 16 полей', () => {
  const s = schemaForProduct({ name: 'Холодильник Pozis RK-103 W' });
  assert.strictEqual(s.id, 523);
  assert.ok(s.specKeys.includes('система_охлаждения'));
  assert.ok(!s.specKeys.includes('назначение'), 'это не generic');
  const atlant = schemaForProduct({ name: 'Холодильник ATLANT ХМ 6025-031' });
  assert.strictEqual(atlant.id, 523);
  assert.ok(!atlant.specKeys.includes('мощность_вт'));
  assert.ok(!atlant.specKeys.includes('напряжение_в'));
  assert.strictEqual(schemaForProduct({ name: 'Стиральная машина ATLANT' }).id, 467);
});
t('поля категорий не пересекаются по смыслу', () => {
  const f = schemaFor('kholodilniki').specKeys, w = schemaFor('stiralnye_mashiny').specKeys;
  assert.ok(f.includes('объем_морозильной_камеры_л') && !w.includes('объем_морозильной_камеры_л'));
  assert.ok(w.includes('скорость_отжима_об_мин') && !f.includes('скорость_отжима_об_мин'));
});
t('реестр схем целостен', () => {
  const dictSchemas = {
    kholodilniki: schemaFor('kholodilniki'),
    stiralnye_mashiny: schemaFor('stiralnye_mashiny'),
  };
  for (const [key, s] of Object.entries({ ...SCHEMAS, ...dictSchemas, _generic: GENERIC_SCHEMA })) {
    const keys = new Set(s.specKeys);
    assert.strictEqual(keys.size, s.specKeys.length, `${key}: повтор поля`);
    for (const k of s.numericKeys) assert.ok(keys.has(k), `${key}: numeric ${k} вне specKeys`);
    for (const k of Object.keys(s.enums)) {
      assert.ok(keys.has(k), `${key}: enum ${k} вне specKeys`);
      assert.ok(s.enums[k].length >= 2, `${key}: список ${k} короче двух значений`);
      assert.ok(!s.numericKeys.includes(k), `${key}: ${k} и число, и список`);
    }
    for (const [k] of s.labels || []) assert.ok(keys.has(k), `${key}: подпись ${k} вне specKeys`);
    for (const [k, r] of Object.entries(s.ranges)) {
      assert.ok(Array.isArray(r) && r.length === 2 && r[0] < r[1], `${key}: диапазон ${k} нерабочий`);
    }
    assert.ok(s.name && s.subject, `${key}: нет имени или предмета`);
  }
});
t('все шестнадцать разделов магазина покрыты схемой', () => {
  const sections = [
    'tekhnika_dlya_doma', 'tekhnika_dlya_kukhni', 'audio_videotekhnika', 'posuda',
    'santekhnika', 'instrument_i_oborudovanie', 'stroitelnye_materialy',
    'otdelochnye_materialy', 'lakokrasochnaya_produktsiya', 'dveri',
    'gazovoe_oborudovanie', 'elektro_elementy', 'sadovyy_inventar',
    'tovary_dlya_uyuta', 'otdyh-na-prirode', 'rasprodazha-skidki',
  ];
  for (const slug of sections) assert.ok(SCHEMAS[slug], `нет схемы раздела ${slug}`);
});
t('«самое большое — высота» только там, где это правда', () => {
  const tv = 'Габариты 960x560x80 мм';
  assert.strictEqual(extractFacts(tv, 'audio_videotekhnika').высота_мм, undefined,
    'у телевизора наибольшая сторона — ширина, гадать нельзя');
  assert.deepStrictEqual(extractFacts(tv, 'audio_videotekhnika').размеры_мм, [80, 560, 960],
    'тройка при этом сохраняется — оси распределит модель');
  assert.strictEqual(extractFacts('Габариты 600x650x2000 мм', 'kholodilniki').высота_мм, 2000);
  assert.strictEqual(SCHEMAS.audio_videotekhnika.tallest, false);
  assert.strictEqual(GENERIC_SCHEMA.tallest, false, 'категория неизвестна — не гадаем');
  assert.ok(!buildSystemPrompt('audio_videotekhnika').includes('самое большое число это высота'));
});
t('чужие поля не протекают между разделами', () => {
  const tv = SCHEMAS.audio_videotekhnika.specKeys;
  assert.ok(tv.includes('диагональ_дюйм'));
  assert.ok(!tv.some(k => /морозил|отжим|загрузк/.test(k)), 'телевизору достались поля техники');
  assert.ok(!GENERIC_SCHEMA.specKeys.some(k => /морозил|отжим|диагонал/.test(k)),
    'универсальная схема не должна тянуть поля конкретной категории');
});
t('промпт называет категорию и её поля', () => {
  const p = buildSystemPrompt('stiralnye_mashiny');
  assert.match(p, /Категория: Стиральные машины/);
  assert.match(p, /"скорость_отжима_об_мин": null/);
  assert.ok(!/морозил/i.test(p), 'в промпте машины не должно быть морозильной камеры');
});

t('промпт универсальной схемы не подсовывает чужие поля', () => {
  const p = buildSystemPrompt('чего-то нет');
  assert.match(p, /Категория: Товары/);
  assert.ok(!/морозил|отжим|диагонал/i.test(p));
});
t('промпт перечисляет значения фасетов и SEO-пакет', () => {
  const p = buildSystemPrompt('kholodilniki');
  assert.match(p, /система_охлаждения/);
  if (/система_охлаждения:/.test(p)) assert.match(p, /No Frost/);
  for (const k of ['seo_title', 'h1', 'meta_description', 'short_description', 'bullets']) {
    assert.ok(p.includes(k), `в промпте нет ${k}`);
  }
  assert.match(p, /ЗНАЧЕНИЯ ДЛЯ ФИЛЬТРОВ/);
});
t('значение вне списка не попадает в фасет', () => {
  const r = normalizeResponse({ specs: { тип_загрузки: 'Фронтальная', сушка: 'есть', дисплей: 'иногда' } },
    '', 'stiralnye_mashiny');
  assert.match(String(r.specs.тип_загрузки), /фронтальн/i, 'регистр не должен плодить фасеты');
  assert.ok(r.specs.сушка === 'да' || r.specs.сушка === 'Да' || r.specs.сушка === true);
  // «иногда» нет в справочнике — поле обнуляется или остаётся с предупреждением.
  assert.ok(r.specs.дисплей == null || r.warnings.some(w => w.field === 'дисплей'));
});
t('основной текст: порог длины зависит от того, есть ли о чём писать', () => {
  const rich = { тип_товара: 'холодильник', бренд: 'LG', модель: 'GA-B419', цвет: 'белый',
    объем_общий_л: 310, вес_кг: 62, высота_мм: 1900, система_охлаждения: 'No Frost' };
  const issue = (specs, len) => normalizeResponse({ specs, seo_description: 'к'.repeat(len) })
    .seo_issues.find(x => x.startsWith('seo_description'));

  assert.match(issue(rich, 500), /рекомендуется 900–2200/, 'на восьми характеристиках 500 символов — мало');
  assert.strictEqual(issue(rich, 1200), undefined);
  assert.strictEqual(issue({ бренд: 'LG' }, 500), undefined,
    'на одной характеристике 900 символов честно не написать — порог ниже');
});
t('промпт требует основной текст первым и абзацами', () => {
  const p = buildSystemPrompt('kholodilniki');
  assert.match(p, /900–1800 символов, ТРИ абзаца/);
  // Порядок ключей: длинный текст раньше короткого, иначе короткий забирает суть.
  assert.ok(p.indexOf('"seo_description": "..."') < p.indexOf('"short_description": "..."'));
  assert.ok(p.indexOf('"seo_description": "..."') < p.indexOf('"seo_title": "..."'));
  // Тексты карточки до specs: при обрыве страница не остаётся пустой.
  assert.ok(p.indexOf('"seo_description": "..."') < p.indexOf('"specs"'), 'описание раньше specs');
  assert.match(p, /Вода запрещена/);
  assert.match(p, /Для поисковиков/);
});
t('SEO-пакет нормализуется, длины проверяются', () => {
  const r = normalizeResponse({
    specs: {},
    seo_title: '  Холодильник LG GA-B419SQGL No Frost 302 л  ',
    h1: 'Холодильник LG GA-B419SQGL',
    meta_description: 'к',
    bullets: ['  Объём 302 л  ', ''],
  });
  assert.strictEqual(r.seo_title, 'Холодильник LG GA-B419SQGL No Frost 302 л');
  assert.deepStrictEqual(r.bullets, ['Объём 302 л']);
  assert.ok(r.seo_issues.some(x => x.startsWith('meta_description: 1 симв.')));
  assert.ok(r.seo_issues.some(x => x === 'short_description: пусто'));
  assert.ok(!r.seo_issues.some(x => x.startsWith('seo_title:')), 'нормальный title не повод для заметки');
  assert.ok(cardTextsEmpty({ specs: { бренд: 'LG' } }));
  assert.ok(cardTextsEmpty({ seo_title: 'Title ok', meta_description: 'x'.repeat(140) }),
    'только meta — карточка всё ещё пустая');
  assert.ok(!cardTextsEmpty({ seo_description: 'Текст', h1: 'H1', short_description: 'Кратко' }));
  assert.ok(!seoPackageEmpty({ seo_description: 'Текст', h1: 'H1', short_description: 'Кратко' }));
});

console.log('\nФакты стиральных машин');
t('подписи магазина: тип загрузки и загрузка белья', () => {
  const f = extractFacts('Тип загрузки - фронтальная<br>Мax загрузка белья, (кг) - 7', 'stiralnye_mashiny');
  assert.match(String(f.тип_загрузки), /фронтальн/i);
  assert.strictEqual(f.максимальная_загрузка_кг, 7);
});
t('«Глубина, (см) - от 40,5 до 50» — диапазон фильтра, не факт', () => {
  const f = extractFacts('Глубина, (см) - от 40,5 до 50', 'stiralnye_mashiny');
  assert.strictEqual(f.глубина_мм, undefined, 'диапазон нельзя объявлять размером товара');
  assert.strictEqual(extractFacts('Глубина, см - 60', 'stiralnye_mashiny').глубина_мм, 600);
});
t('отжим и программы читаются с числом до подписи', () => {
  const f = extractFacts('Скорость отжима - 1200<br>Количество программ - 15', 'stiralnye_mashiny');
  assert.strictEqual(f.скорость_отжима_об_мин, 1200);
  assert.strictEqual(f.количество_программ, 15);
});
t('«вертикальные ручки» не делают загрузку вертикальной', () => {
  assert.strictEqual(extractFacts('2 ручки вертикальные', 'stiralnye_mashiny').тип_загрузки, undefined);
});
t('загрузка без единицы не берётся', () => {
  const f = extractFacts('регулирует расход воды в зависимости от загрузки. Программа Хлопок 40', 'stiralnye_mashiny');
  assert.strictEqual(f.максимальная_загрузка_кг, undefined);
});
t('нормализация берёт поля своей категории', () => {
  const r = normalizeResponse({ specs: { скорость_отжима_об_мин: '1200 об/мин' } },
    'Тип загрузки - фронтальная', 'stiralnye_mashiny');
  assert.strictEqual(r.specs.скорость_отжима_об_мин, 1200);
  assert.match(String(r.specs.тип_загрузки), /фронтальн/i, 'факт должен добраться');
  assert.ok(!('объем_морозильной_камеры_л' in r.specs));
});

// ── РАЗБОР КАТАЛОГА ──────────────────────────────────────────
// Разметка ниже — вырезка из реальных страниц mrmag.ru.
console.log('\nРазбор раздела');
const LISTING = `<div data-category="523"></div>
<a href="/shop/kholodilniki?page=2">2</a><a href="/shop/kholodilniki?page=13">13</a>
<div class="col mr-item" itemscope itemtype="http://schema.org/Product">
  <a itemprop="url" href="/shop/kholodilniki/kholodilnik_lg_ga_b419sqgl"><span itemprop="name">Холодильник LG GA-B419SQGL</span></a>
  <img itemprop="image" src="https://mrmag.ru/img/200x200/originals/a.jpg">
  <a href="/shop/kholodilniki/kupit/brand-lg" class="mr-brand"> LG </a>
  <div itemprop="offers" itemscope itemtype="http://schema.org/Offer">
    <meta itemprop="price" content="43790.00"><link itemprop="availability" href="http://schema.org/InStock">
    <button class="js-item-add" data-sku="296646"></button>
  </div></div>
<div itemscope itemtype="http://schema.org/Product">
  <a itemprop="url" href="/shop/kholodilniki/pozis-rk-102"><span itemprop="name">Холодильник Pozis RK-102</span></a>
  <a href="/shop/kholodilniki/kupit/brand-pozis" class="mr-brand"> POZIS </a>
  <meta itemprop="price" content="18450.00"><link itemprop="availability" href="http://schema.org/OutOfStock">
  <button class="js-item-add" data-sku="315460"></button></div>`;

t('id категории, число страниц и товары', () => {
  const r = parseListing(LISTING);
  assert.strictEqual(r.categoryId, 523, 'id берётся со страницы, а не из кода');
  assert.strictEqual(r.pages, 13);
  assert.strictEqual(r.items.length, 2);
  const [a, b] = r.items;
  assert.strictEqual(a.sku, '296646');
  assert.strictEqual(a.name, 'Холодильник LG GA-B419SQGL');
  assert.strictEqual(a.price, 43790);
  assert.strictEqual(a.brand, 'LG');
  assert.strictEqual(a.brand_slug, 'lg');
  assert.strictEqual(a.available, true);
  assert.strictEqual(a.product_url, 'https://mrmag.ru/shop/kholodilniki/kholodilnik_lg_ga_b419sqgl');
  assert.strictEqual(b.available, false, 'OutOfStock должен читаться как нет в наличии');
});
t('блок без кнопки в корзину товаром не считается', () => {
  const r = parseListing('<div data-category="1"></div><div itemtype="http://schema.org/Product"><span itemprop="name">Крошка</span></div>');
  assert.strictEqual(r.items.length, 0, 'хлебные крошки — тоже Product-разметка');
});

const PRODUCT = `<h3>Описание</h3>
<div itemprop="description" class="p-2"><p>Стиральная машина HW60 с загрузкой 6&nbsp;кг.</p></div>
</section><section><h3 class="border-bottom pb-1">Характеристики</h3><div class="p-2">
<div class="row border-bottom py-1"><div class="col-sm-5 text-muted">Тип загрузки</div><div class="col-sm-7"> фронтальная </div></div>
<div class="row border-bottom py-1"><div class="col-sm-5 text-muted">Мax загрузка белья, (кг)</div><div class="col-sm-7"> 6 </div></div>
</div></section>`;

t('страница товара: описание и характеристики', () => {
  const p = parseProductPage(PRODUCT);
  assert.match(p.description, /загрузкой 6 кг/);
  assert.deepStrictEqual(p.attributes, [
    { name: 'Тип загрузки', value: 'фронтальная' },
    { name: 'Мax загрузка белья, (кг)', value: '6' },
  ]);
  // Разбор фактов читает description + annotation, поэтому таблица
  // разворачивается в annotation ровно как в фиде магазина.
  assert.strictEqual(p.annotation, 'Тип загрузки - фронтальная<br>Мax загрузка белья, (кг) - 6');
  assert.strictEqual(extractFacts(p.annotation, 'stiralnye_mashiny').максимальная_загрузка_кг, 6);
});

console.log('\nАвтофильтры');
t('бренд и цена строятся из товаров', () => {
  const cat = { id: 523, name: 'Холодильники', url: 'u' };
  const f = buildFilters(cat, [
    { brand: 'LG', brand_slug: 'lg', price: 43790 },
    { brand: 'LG', brand_slug: 'lg', price: 52890 },
    { brand: 'POZIS', brand_slug: 'pozis', price: 18450 },
    { brand: null, brand_slug: null, price: null },
  ]);
  assert.strictEqual(f.category_id, 523);
  assert.strictEqual(f.products_total, 4);
  const [brand, price] = f.filters;
  assert.strictEqual(brand.code, 'brand');
  assert.deepStrictEqual(brand.values.map(v => [v.value, v.count]), [['LG', 2], ['POZIS', 1]]);
  assert.strictEqual(brand.without_value, 1, 'товар без бренда должен быть посчитан отдельно');
  assert.strictEqual(price.min, 18450);
  assert.strictEqual(price.max, 52890);
  assert.strictEqual(price.without_price, 1);
  assert.ok(price.step >= 10 && price.step <= price.max - price.min, `шаг ${price.step} бессмыслен`);
});
t('бренд из названия по словарю категории', () => {
  const items = [
    { name: 'Холодильник LG GA-B419', brand: 'LG', brand_slug: 'lg' },
    { name: 'Холодильник ATLANT ХМ-4619', brand: 'Атлант', brand_slug: 'atlant' },
    { name: 'Холодильники_1/ATLANT ХМ-4619-101' },              // магазин бренд не привязал
    { name: 'ХОЛОДИЛЬНИК БИРЮСА M50' },                          // словаря нет — остаётся пустым
    { name: 'Norsk NR-100' },                                    // «orsk» внутри слова не считается
  ];
  const filled = assignMissingBrands(items);
  assert.strictEqual(filled, 1);
  assert.strictEqual(items[2].brand, 'Атлант', 'по латинскому slug в названии');
  assert.strictEqual(items[2].brand_source, 'name', 'источник должен быть виден');
  assert.strictEqual(items[3].brand, undefined, 'бренда нет в словаре категории');
  assert.strictEqual(items[4].brand, undefined);
  assert.strictEqual(items[0].brand_source, undefined, 'бренду от магазина пометка не нужна');
});
t('бренд берётся из обогащения, когда магазин его не отдал', () => {
  // Так выглядит прогон по фиду: brand в товарах нет вовсе, и словарю
  // assignMissingBrands не с чего начать — раньше фильтр выходил пустым.
  const f = buildFilters({ id: 523, name: 'Холодильники', url: 'u' }, [
    { sku: '1', price: 30000, enriched: { specs: { бренд: 'LG' } } },
    { sku: '2', price: 45000, enriched: { specs: { бренд: 'LG' } } },
    { sku: '3', price: 18000, enriched: { specs: { бренд: 'DON' } } },
    { sku: '4', price: 1624, enriched: null },
  ]);
  const brand = f.filters.find(x => x.code === 'brand');
  assert.deepStrictEqual(brand.values.map(v => [v.value, v.count]), [['LG', 2], ['DON', 1]]);
  assert.strictEqual(brand.without_value, 1, 'товар без прогона остаётся без бренда');
  assert.strictEqual(brand.assigned_by_ai, 3, 'источник бренда должен быть виден в файле');
  assert.ok(!f.filters.some(x => x.code === 'бренд'), 'бренд не должен идти вторым фасетом');
});
t('фасеты обогащения попадают в файл фильтров со счётчиками', () => {
  const row = (sku, specs, price) => ({ sku, name: 'Товар ' + sku, price, enriched: { specs } });
  const f = buildFilters({ id: 523, name: 'Холодильники', url: 'u' }, [
    row('1', { система_охлаждения: 'No Frost', объем_общий_л: 310, высота_мм: 1900 }, 30000),
    row('2', { система_охлаждения: 'No Frost', объем_общий_л: 365 }, 45000),
    row('3', { система_охлаждения: 'капельная', объем_общий_л: 419, высота_мм: 1880 }, 18000),
  ]);
  assert.strictEqual(f.enriched_total, 3, 'файл должен говорить, сколько товаров обогащено');

  const cool = f.filters.find(x => x.code === 'система_охлаждения');
  assert.strictEqual(cool.name, 'Система охлаждения');
  assert.strictEqual(cool.source, 'enriched', 'видно, что фасет из прогона, а не из магазина');
  assert.deepStrictEqual(cool.values, [{ value: 'No Frost', count: 2 }, { value: 'Капельная', count: 1 }]);

  const vol = f.filters.find(x => x.code === 'объем_общий_л');
  assert.strictEqual(vol.name, 'Объем общий, л', 'единица уезжает в имя фасета');
  assert.strictEqual(vol.min, 310, 'крайние значения по сырым числам — по подписям слайдер не построить');
  assert.strictEqual(vol.max, 419);

  const h = f.filters.find(x => x.code === 'высота_мм');
  assert.strictEqual(h.without_value, 1, 'у одного товара высоты нет');
});
t('фасеты считаются по обогащённым, бренд и цена — по всему разделу', () => {
  // CLI пишет фильтры по листингу раздела, а прогон бывает по окну.
  const listing = [
    { sku: '1', brand: 'LG', brand_slug: 'lg', price: 30000 },
    { sku: '2', brand: 'DON', brand_slug: 'don', price: 45000 },
  ];
  const run = [{ sku: '1', brand: 'LG', brand_slug: 'lg', price: 30000, enriched: { specs: { цвет: 'белый' } } }];
  const f = buildFilters({ id: 523, name: 'Х', url: 'u' }, listing, { facetsFrom: run });
  assert.strictEqual(f.products_total, 2, 'бренд и цена — по разделу');
  assert.strictEqual(f.enriched_total, 1);
  assert.deepStrictEqual(f.filters.find(x => x.code === 'цвет').values, [{ value: 'Белый', count: 1 }]);
});
t('пустая категория не роняет фильтры', () => {
  const f = buildFilters({ id: 1, name: 'X', url: 'u' }, []);
  assert.deepStrictEqual(f.filters[0].values, []);
  assert.strictEqual(f.filters[1].min, null);
});

console.log('\nФайлы категории');
t('products_(id).json — массив, filters_(id).json рядом', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catfiles-'));
  const cat = { id: 523, name: 'Холодильники', slug: 'kholodilniki', url: 'https://mrmag.ru/shop/kholodilniki' };
  const items = [{ sku: '1', name: 'Холодильник LG', brand: 'LG', brand_slug: 'lg', price: 43790 }];
  const { productsFile, filtersFile } = writeCategoryFiles(cat, items, { dir });

  assert.strictEqual(path.basename(productsFile), 'products_523.json', 'имя файла несёт id раздела');
  assert.strictEqual(path.basename(filtersFile), 'filters_523.json');
  const written = JSON.parse(fs.readFileSync(productsFile, 'utf-8'));
  assert.ok(Array.isArray(written), 'товары — массив, без обёртки');
  assert.strictEqual(written[0].sku, '1');
  // Когда собрано и сколько товаров — в файле фильтров, поэтому массив ничего не теряет.
  const f = JSON.parse(fs.readFileSync(filtersFile, 'utf-8'));
  assert.strictEqual(f.category_id, 523);
  assert.strictEqual(f.products_total, 1);
  assert.ok(f.generated_at);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── ПУТЬ ЗАПРОСА К МОДЕЛИ ────────────────────────────────────
// Заглушка вместо OpenRouter: это единственный участок, где тратятся деньги,
// и проверять его на живом API дорого и нестабильно.
console.log('\nЗапрос к модели');
{
  const answer = specs => JSON.stringify({
    specs, synonyms: ['а'], search_aliases: [], seo_keywords: [], seo_description: 'Описание.',
  });
  const reply = (content, { finish = 'stop', usage = {}, status = 200, error = null } = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['retry-after', '0']]),
    text: () => Promise.resolve(JSON.stringify(error
      ? { error }
      : { choices: [{ finish_reason: finish, message: { content } }], usage })),
  });

  const record = [];
  const stub = replies => {
    let i = 0;
    globalThis.fetch = (url, opts) => {
      record.push({ url, body: JSON.parse(opts.body) });
      return Promise.resolve(replies[Math.min(i++, replies.length - 1)]);
    };
  };
  const limiter = new RateLimiter(60_000);   // без реальных пауз в тесте
  const run = (product, opts = {}) => enrichProduct(product, {
    model: 'test/model', apiKey: 'k', limiter, maxRetries: 3, ...opts,
  });

  await tAsync('факты и схема уезжают в запрос, ответ нормализуется', async () => {
    record.length = 0;
    stub([reply(answer({ объем_общий_л: '310 л', бренд: 'DON' }),
      { usage: { prompt_tokens: 1000, completion_tokens: 500, cost: 0.002 } })]);
    const r = await run({ name: 'Холодильник DON', category: 'Холодильники',
      description: 'Общий объем, л 310 Вес (кг) - 62' });

    const [{ url, body }] = record;
    assert.match(url, /openrouter\.ai/);
    assert.strictEqual(body.response_format.type, 'json_object');
    assert.strictEqual(body.usage.include, true, 'без этого OpenRouter не вернёт стоимость');
    assert.match(body.messages[0].content, /Категория: Холодильники/);
    assert.strictEqual(JSON.parse(body.messages[1].content).facts.объем_общий_л, 310,
      'проверенные факты должны уехать модели');

    assert.strictEqual(r.enriched.specs.объем_общий_л, 310);
    assert.strictEqual(r.enriched.specs.вес_кг, 62, 'пропущенное моделью добирается из текста');
    assert.deepStrictEqual(r.enriched.warnings, []);
    assert.strictEqual(r.cost, 0.002);
    assert.strictEqual(r.costSource, 'openrouter');
    assert.strictEqual(r.attempts, 1);
  });

  await tAsync('схема стиральных машин меняет промпт и поля', async () => {
    record.length = 0;
    stub([reply(answer({ скорость_отжима_об_мин: 1200 }), { usage: { prompt_tokens: 10, completion_tokens: 5 } })]);
    const r = await run(
      { name: 'Стиральная машина', description: 'Тип загрузки - фронтальная' },
      { schema: schemaFor('stiralnye_mashiny') },
    );
    assert.match(record[0].body.messages[0].content, /Категория: Стиральные машины/);
    assert.strictEqual(r.enriched.specs.скорость_отжима_об_мин, 1200);
    assert.match(String(r.enriched.specs.тип_загрузки), /фронтальн/i);
    assert.ok(!('объем_морозильной_камеры_л' in r.enriched.specs));
  });

  await tAsync('обрыв по длине поднимает лимит, а расход суммируется', async () => {
    record.length = 0;
    stub([
      reply('обрезано без json', { finish: 'length', usage: { prompt_tokens: 900, completion_tokens: 2500, cost: 0.003 } }),
      reply(answer({ бренд: 'DON' }), { usage: { prompt_tokens: 900, completion_tokens: 400, cost: 0.001 } }),
    ]);
    const r = await run({ name: 'X', description: 'Общий объем, л - 310<br>Вес (кг) - 62' }, { maxTokens: 2500 });
    assert.strictEqual(record.length, 2);
    assert.strictEqual(record[0].body.max_tokens, 2500);
    assert.strictEqual(record[1].body.max_tokens, 5000, 'повтор с тем же лимитом бессмыслен');
    // Обрезанная попытка тоже оплачена: 0.003 + 0.001.
    assert.strictEqual(+r.cost.toFixed(6), 0.004, 'ретрай — оплаченный запрос');
    assert.strictEqual(r.iT, 1800);
    assert.strictEqual(r.oT, 2900);
  });

  await tAsync('у DeepSeek thinking выключен, иначе max_tokens съедает цепочка', async () => {
    record.length = 0;
    stub([reply(answer({ бренд: 'DON' }), { usage: { prompt_tokens: 10, completion_tokens: 5 } })]);
    await run({ name: 'X', description: 'Общий объем, л 310' }, { model: 'deepseek/deepseek-v3.2' });
    const body = record[0].body;
    assert.deepStrictEqual(body.thinking, { type: 'disabled' });
    assert.strictEqual(body.reasoning.enabled, false);
    assert.strictEqual(body.reasoning.effort, 'none');
    assert.strictEqual(body.enable_thinking, false);
  });

  await tAsync('GPT не получает thinking-поля', async () => {
    record.length = 0;
    stub([reply(answer({ бренд: 'DON' }), { usage: {} })]);
    await run({ name: 'X', description: 'Общий объем, л 310' }, { model: 'openai/gpt-4o-mini' });
    assert.ok(!('thinking' in record[0].body));
    assert.ok(!('reasoning' in record[0].body));
  });

  await tAsync('обрыв с целым JSON принимается без повтора', async () => {
    record.length = 0;
    stub([reply(answer({ бренд: 'DON' }), { finish: 'length', usage: { prompt_tokens: 10, completion_tokens: 5 } })]);
    const r = await run({ name: 'X', description: 'Общий объем, л 310' }, { maxTokens: 8000 });
    assert.strictEqual(record.length, 1, 'JSON закрыт — повтор не нужен');
    assert.strictEqual(r.enriched.specs.бренд, 'DON');
  });

  await tAsync('обрыв без SEO поднимает лимит и повторяет', async () => {
    record.length = 0;
    const bare = JSON.stringify({ specs: { бренд: 'DON' } });
    stub([
      reply(bare, { finish: 'length', usage: { prompt_tokens: 10, completion_tokens: 2500, cost: 0.002 } }),
      reply(answer({ бренд: 'DON' }), { usage: { prompt_tokens: 10, completion_tokens: 400, cost: 0.001 } }),
    ]);
    const notes = [];
    const r = await run({ name: 'X', description: 'Общий объем, л 310' }, {
      maxTokens: 2500, onNote: m => notes.push(m),
    });
    assert.strictEqual(record.length, 2);
    assert.strictEqual(record[1].body.max_tokens, 5000);
    assert.ok(notes.some(n => /обрыв по длине/.test(n)));
    assert.ok(!seoPackageEmpty(r.enriched));
    assert.strictEqual(r.enriched.specs.бренд, 'DON');
  });

  await tAsync('пустой SEO-пакет на stop повторяется', async () => {
    record.length = 0;
    stub([
      reply(JSON.stringify({ specs: { бренд: 'DON' } }), { usage: { prompt_tokens: 5, completion_tokens: 5 } }),
      reply(answer({ бренд: 'DON' }), { usage: { prompt_tokens: 5, completion_tokens: 20 } }),
    ]);
    const notes = [];
    const r = await run({ name: 'X', description: 'Общий объем, л 310' }, { onNote: m => notes.push(m) });
    assert.strictEqual(record.length, 2);
    assert.ok(notes.some(n => /тексты карточки пусты/.test(n)));
    assert.strictEqual(r.enriched.seo_description, 'Описание.');
  });

  await tAsync('после исчерпания попыток SEO добирается отдельным запросом', async () => {
    record.length = 0;
    const bare = JSON.stringify({ specs: { бренд: 'DON' } });
    const seoOnly = JSON.stringify({
      seo_description: 'Холодильник DON для кухни.\n\nОбъём и габариты из specs.\n\nПеред покупкой сверьте нишу.',
      bullets: ['Объём — запас продуктов'],
      short_description: 'Холодильник DON с нужным объёмом для кухни.',
      meta_description: 'Холодильник DON: характеристики из карточки, объём и габариты для выбора по кухне.',
      h1: 'Холодильник DON',
      seo_title: 'Холодильник DON купить — характеристики',
      synonyms: ['холодильник дон'],
      search_aliases: ['дон холодильник'],
      seo_keywords: ['холодильник don'],
    });
    stub([
      reply(bare, { usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.001 } }),
      reply(seoOnly, { usage: { prompt_tokens: 8, completion_tokens: 200, cost: 0.002 } }),
    ]);
    const notes = [];
    const r = await run({ name: 'X', description: 'Общий объем, л 310' }, {
      maxRetries: 1, onNote: m => notes.push(m),
    });
    assert.strictEqual(record.length, 2, 'основной + добор текстов');
    assert.ok(notes.some(n => /добираем тексты карточки/.test(n)));
    assert.ok(record[1].body.messages[0].content.includes('редактор карточки'));
    assert.ok(!record[1].body.messages[0].content.includes('"specs"'), 'добор без скелета specs');
    assert.match(r.enriched.seo_title, /DON/);
    assert.ok(!cardTextsEmpty(r.enriched));
    assert.strictEqual(r.enriched.specs.бренд, 'DON');
    assert.strictEqual(+r.cost.toFixed(6), 0.003);
  });

  await tAsync('ретрай обрыва идёт до потолка настроек, не до 8000', async () => {
    record.length = 0;
    stub([
      reply('обрезано без json', { finish: 'length', usage: { prompt_tokens: 1, completion_tokens: 8000, cost: 0.01 } }),
      reply(answer({ бренд: 'DON' }), { usage: { prompt_tokens: 1, completion_tokens: 100, cost: 0.001 } }),
    ]);
    const r = await run({ name: 'X', description: 'Общий объем, л 310' }, { maxTokens: 8000 });
    assert.strictEqual(record[0].body.max_tokens, 8000);
    assert.strictEqual(record[1].body.max_tokens, MAX_COMPLETION_TOKENS);
    assert.strictEqual(r.enriched.specs.бренд, 'DON');
  });

  await tAsync('обрезанный JSON с готовыми specs не роняет товар', async () => {
    record.length = 0;
    stub([reply('{"specs":{"бренд":"DON","модель":"290 G"},"seo_description":"Холодильник DON', {
      finish: 'length', usage: { prompt_tokens: 10, completion_tokens: 8000 },
    })]);
    const r = await run({ name: 'X', description: 'Общий объем, л 310' }, { maxTokens: 8000, maxRetries: 1 });
    assert.strictEqual(record.length, 1);
    assert.strictEqual(r.enriched.specs.бренд, 'DON');
  });

  await tAsync('тариф модели считает стоимость, когда OpenRouter её не вернул', async () => {
    stub([reply(answer({ бренд: 'DON' }), { usage: { prompt_tokens: 1000, completion_tokens: 500 } })]);
    const r = await run({ name: 'X', description: 'Общий объем, л 310' },
      { pricing: { prompt: 0.000001, completion: 0.000002 } });
    assert.strictEqual(r.cost, 1000 * 0.000001 + 500 * 0.000002);
    assert.strictEqual(r.costSource, 'тариф модели');
  });

  await tAsync('502 повторяется, 401 — нет', async () => {
    record.length = 0;
    stub([reply(null, { status: 502, error: { code: 502, message: 'шлюз' } }),
          reply(answer({ бренд: 'DON' }), { usage: {} })]);
    await run({ name: 'X', description: 'Общий объем, л 310' });
    assert.strictEqual(record.length, 2, '502 имеет смысл повторить');

    record.length = 0;
    stub([reply(null, { status: 401, error: { code: 401, message: 'User not found.' } })]);
    await assert.rejects(() => run({ name: 'X', description: 'Общий объем, л 310' }), /User not found/);
    assert.strictEqual(record.length, 1, 'неверный ключ повторять бессмысленно');
  });

  await tAsync('провал отдаёт потраченное в error.usage', async () => {
    stub([reply('это не json', { usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0005 } })]);
    const e = await run({ name: 'X', description: 'Общий объем, л 310' }).then(() => null, err => err);
    assert.ok(e, 'должно бросить');
    assert.strictEqual(e.usage.iT, 300, 'три попытки по 100 входных токенов');
    assert.strictEqual(+e.usage.cost.toFixed(6), 0.0015, 'деньги за неудачу не должны исчезать');
  });

  await tAsync('обрыв CONNECT называет хост, а не голое fetch failed', async () => {
    const cancelled = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('Request was cancelled.'), { name: 'AbortError' }),
    });
    globalThis.fetch = () => Promise.reject(cancelled);
    const e = await run({ name: 'X', description: 'Общий объем, л 310' }, {
      maxRetries: 1,
      chatUrl: 'https://api.deepseek.com/chat/completions',
    }).then(() => null, err => err);
    assert.ok(e, 'должно бросить');
    assert.match(e.message, /api\.deepseek\.com/, 'иначе не видно, кого оборвали');
    assert.match(e.message, /оборван/);
    assert.doesNotMatch(e.message, /^fetch failed/);
  });

  globalThis.fetch = nativeFetch;
}

// ── ПРОКСИ ───────────────────────────────────────────────────
console.log('\nОшибки сети');
t('разворачивает cause вместо голого fetch failed', () => {
  const e = Object.assign(new Error('fetch failed'), { cause: { code: 'ENETUNREACH', message: 'network unreachable' } });
  assert.match(netError(e), /fetch failed/);
  assert.match(netError(e), /network unreachable|ENETUNREACH/);
});
t('обрыв CONNECT не маскируется под таймаут', () => {
  const e = Object.assign(new Error('fetch failed'), {
    cause: Object.assign(new Error('Request was cancelled.'), { name: 'AbortError' }),
  });
  const s = netError(e);
  assert.match(s, /оборван/);
  assert.match(s, /cancelled/i);
  assert.doesNotMatch(s, /^таймаут/);
});
t('AbortSignal.timeout не оставляет английскую формулировку', () => {
  const e = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  assert.strictEqual(netError(e), 'таймаут');
});

console.log('\nАдрес прокси');
t('разбирает три формы записи', () => {
  assert.deepStrictEqual(parseProxy('tg://socks?server=1.2.3.4&port=3443&user=u&pass=p'),
    { host: '1.2.3.4', port: 3443, user: 'u', pass: 'p' });
  assert.deepStrictEqual(parseProxy('socks5://u:p@1.2.3.4:1080'),
    { host: '1.2.3.4', port: 1080, user: 'u', pass: 'p' });
  assert.deepStrictEqual(parseProxy('1.2.3.4:1080'),
    { host: '1.2.3.4', port: 1080, user: null, pass: null });
  assert.strictEqual(parseProxy(''), null);
});
t('мусор не проглатывается молча', () => {
  assert.throws(() => parseProxy('tg://socks?server=1.2.3.4'), /port/);
  assert.throws(() => parseProxy('socks5://1.2.3.4'), /порт/);
});
t('mergeNoProxy дописывает DeepSeek к уже заданному списку', () => {
  const prev = process.env.NO_PROXY;
  process.env.NO_PROXY = 'mrmag.ru,localhost,127.0.0.1';
  const out = mergeNoProxy('api.deepseek.com', '.deepseek.com');
  assert.match(out, /mrmag\.ru/);
  assert.match(out, /api\.deepseek\.com/);
  assert.match(out, /\.deepseek\.com/);
  if (prev === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = prev;
});
t('без прокси applyDirectHosts не выдумывает NO_PROXY', () => {
  const prevN = process.env.NO_PROXY;
  const prevH = process.env.HTTPS_PROXY;
  const prevS = process.env.SOCKS_PROXY;
  delete process.env.NO_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.SOCKS_PROXY;
  assert.strictEqual(applyDirectHosts(), '');
  assert.strictEqual(process.env.NO_PROXY, undefined);
  if (prevN !== undefined) process.env.NO_PROXY = prevN;
  if (prevH !== undefined) process.env.HTTPS_PROXY = prevH;
  if (prevS !== undefined) process.env.SOCKS_PROXY = prevS;
});
t('HTTPS_PROXY без SOCKS всё равно выводит DeepSeek из туннеля', () => {
  const prevN = process.env.NO_PROXY;
  const prevH = process.env.HTTPS_PROXY;
  delete process.env.NO_PROXY;
  process.env.HTTPS_PROXY = 'http://127.0.0.1:18080';
  applyDirectHosts();
  assert.match(process.env.NO_PROXY, /api\.deepseek\.com/);
  if (prevN === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = prevN;
  if (prevH === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = prevH;
});

console.log('\nМост SOCKS5 → HTTP CONNECT');
{
  // Поддельный SOCKS5-сервер: нужен, чтобы проверять мост без сети и без
  // чужого прокси. Логин и пароль он тоже требует — иначе ветка авторизации
  // осталась бы непроверенной.
  const fakeSocks = (creds) => net.createServer(sock => {
    let stage = 'greet';
    sock.on('data', async d => {
      if (stage === 'greet') {
        const methods = [...d.subarray(2, 2 + d[1])];
        if (creds && methods.includes(2)) { sock.write(Buffer.from([5, 2])); stage = 'auth'; }
        else if (!creds && methods.includes(0)) { sock.write(Buffer.from([5, 0])); stage = 'req'; }
        else sock.write(Buffer.from([5, 0xff]));
        return;
      }
      if (stage === 'auth') {
        const ulen = d[1], user = d.subarray(2, 2 + ulen).toString();
        const plen = d[2 + ulen], pass = d.subarray(3 + ulen, 3 + ulen + plen).toString();
        const ok = user === creds.user && pass === creds.pass;
        sock.write(Buffer.from([1, ok ? 0 : 1]));
        stage = ok ? 'req' : 'dead';
        return;
      }
      if (stage === 'req') {
        const host = d.subarray(5, 5 + d[4]).toString();
        const port = d.readUInt16BE(5 + d[4]);
        const up = net.connect(port, host === 'target.test' ? '127.0.0.1' : host, () => {
          sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          sock.pipe(up); up.pipe(sock);
        });
        up.on('error', () => sock.write(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
        stage = 'piped';
      }
    });
  });

  const listen = (srv, ...a) => new Promise(r => srv.listen(...a, () => r(srv.address().port)));
  /** Один запрос через мост: CONNECT, затем обмен байтами. */
  const throughBridge = (bridgeUrl, target) => new Promise((resolve, reject) => {
    const u = new URL(bridgeUrl);
    const c = net.connect(Number(u.port), u.hostname, () => {
      c.write(`CONNECT target.test:${target} HTTP/1.1\r\nHost: target.test:${target}\r\n\r\n`);
    });
    let buf = '', tunnelled = false;
    c.setTimeout(5000, () => { c.destroy(); reject(new Error('таймаут моста')); });
    c.on('error', reject);
    c.on('data', d => {
      buf += d.toString('latin1');
      if (!tunnelled && buf.includes('\r\n\r\n')) {
        const status = buf.split('\r\n')[0];
        if (!/200/.test(status)) { c.destroy(); return resolve({ status, echo: null }); }
        tunnelled = true; buf = '';
        c.write('ping-pong');            // ASCII: сравниваем побайтово, без кодировок
      } else if (tunnelled && buf.length >= 9) {
        c.destroy();
        resolve({ status: 'HTTP/1.1 200', echo: buf });
      }
    });
  });

  // Цель туннеля — эхо-сервер.
  const echo = net.createServer(s => s.pipe(s));
  const echoPort = await listen(echo, 0, '127.0.0.1');

  await tAsync('туннель с логином и паролем доносит байты', async () => {
    const socks = fakeSocks({ user: 'u', pass: 'p' });
    const sp = await listen(socks, 0, '127.0.0.1');
    const b = await startBridge({ host: '127.0.0.1', port: sp, user: 'u', pass: 'p' });
    const r = await throughBridge(b.url, echoPort);
    assert.match(r.status, /200/);
    assert.strictEqual(r.echo, 'ping-pong', 'данные должны пройти в обе стороны');
    await b.close(); socks.close();
  });

  await tAsync('неверный пароль — 502, а не молчание', async () => {
    const socks = fakeSocks({ user: 'u', pass: 'p' });
    const sp = await listen(socks, 0, '127.0.0.1');
    const b = await startBridge({ host: '127.0.0.1', port: sp, user: 'u', pass: 'НЕВЕРНЫЙ' });
    const r = await throughBridge(b.url, echoPort);
    assert.match(r.status, /502/, 'клиент обязан узнать о провале авторизации');
    await b.close(); socks.close();
  });

  await tAsync('мост без прокси не поднимается сам по себе', async () => {
    delete process.env.SOCKS_PROXY;
    assert.strictEqual(await setupProxy(), null);
    assert.strictEqual(process.env.HTTPS_PROXY, undefined);
  });

  await tAsync('setupProxy направляет https в мост, а mrmag мимо', async () => {
    const socks = fakeSocks(null);
    const sp = await listen(socks, 0, '127.0.0.1');
    process.env.SOCKS_PROXY = `socks5://127.0.0.1:${sp}`;
    const p = await setupProxy();
    assert.match(process.env.HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.strictEqual(process.env.NODE_USE_ENV_PROXY, '1');
    assert.match(process.env.NO_PROXY, /mrmag\.ru/, 'каталог не должен ходить через заграничный прокси');
    assert.match(process.env.NO_PROXY, /api\.deepseek\.com/, 'DeepSeek не должен ходить через SOCKS OpenRouter');
    await p.close(); socks.close();
    delete process.env.SOCKS_PROXY; delete process.env.HTTPS_PROXY;
    delete process.env.NODE_USE_ENV_PROXY; delete process.env.NO_PROXY;
  });

  await tAsync('setupProxy дописывает DeepSeek, даже если NO_PROXY уже в .env', async () => {
    const socks = fakeSocks(null);
    const sp = await listen(socks, 0, '127.0.0.1');
    process.env.SOCKS_PROXY = `socks5://127.0.0.1:${sp}`;
    process.env.NO_PROXY = 'mrmag.ru,localhost,127.0.0.1';
    const p = await setupProxy();
    assert.match(process.env.NO_PROXY, /mrmag\.ru/);
    assert.match(process.env.NO_PROXY, /api\.deepseek\.com/);
    await p.close(); socks.close();
    delete process.env.SOCKS_PROXY; delete process.env.HTTPS_PROXY;
    delete process.env.NODE_USE_ENV_PROXY; delete process.env.NO_PROXY;
  });

  echo.close();
}

console.log('\nВыгрузка v2: фасеты и товары');
const v2row = (sku, specs, extra = {}) => ({
  sku, name: 'Товар ' + sku,
  enriched: { specs, short_description: 'Коротко', seo_description: 'Подробно', seo_keywords: ['ключ'], ...extra },
});

t('ключ схемы разбирается на подпись и единицу', () => {
  assert.deepStrictEqual(splitKey('объем_общий_л'), { label: 'Объем общий', unit: 'л' });
  assert.deepStrictEqual(splitKey('скорость_отжима_об_мин'), { label: 'Скорость отжима', unit: 'об/мин' });
  assert.deepStrictEqual(splitKey('мощность_замораживания_кг_сут'), { label: 'Мощность замораживания', unit: 'кг/сут' });
  assert.deepStrictEqual(splitKey('тип_загрузки'), { label: 'Тип загрузки', unit: '' });
});

t('значение товара совпадает со значением фасета', () => {
  // Восемь объёмов сворачиваются в корзины шагом 50; подпись у товара
  // и в списке фасета обязана совпасть — иначе товар не попадёт в фильтр.
  const vols = [190, 225, 298, 310, 355, 364, 420, 455];
  const rows = vols.map((v, i) => v2row(String(i + 1), { объем_общий_л: v }));
  const { filters, products } = buildV2(rows);
  const facet = filters.find(f => f.name === 'Объем общий, л');
  assert.deepStrictEqual(facet.value, [
    '150-200', '200-250', '250-300', '300-350', '350-400', '400-450', '450-500',
  ]);
  for (const p of products) {
    assert.ok(facet.value.includes(p.filters['Объем общий, л']),
      `значение ${p.filters['Объем общий, л']} товара ${p.id} отсутствует в фасете`);
  }
});

t('мало значений — перечисление, а не диапазоны вокруг них', () => {
  const rows = [30, 40, 50].map((v, i) => v2row(String(i + 1), { объем_л: v }));
  assert.deepStrictEqual(buildV2(rows).filters[0], { name: 'Объем, л', value: ['30', '40', '50'] });
});

t('цена в эталоне заказчика не входит в выгрузку', () => {
  const rows = [7000, 19990].map((price, i) => ({ ...v2row(String(i + 1), { цвет: 'белый' }), price }));
  const { filters, products } = buildV2(rows);
  assert.ok(!filters.some(f => /[Цц]ена/.test(f.name)));
  assert.ok(!('Цена, ₽' in products[0].filters));
});

t('да/нет становится Есть/Нет и в фильтре, и в описании', () => {
  const { filters, products } = buildV2([v2row('1', { дисплей: 'да', сушка: 'нет' })]);
  assert.deepStrictEqual(filters.map(f => f.value), [['Есть'], ['Нет']]);
  assert.strictEqual(products[0].filters['Дисплей'], 'Есть');
  assert.match(products[0].description_html, /<li>Дисплей: Есть<\/li>/);
});

t('таблица заказчика: выключенный фасет остаётся в HTML, не в filters', () => {
  const dict = loadDictionary(523);
  const [p] = buildV2([v2row('1', {
    цвет: 'белый',
    хладагент: 'R600a',
    вес_кг: 74,
    тип_товара: 'холодильник',
  })], { dict }).products;
  assert.strictEqual(p.filters['Цвет'], 'Белый');
  assert.strictEqual(p.filters['Тип товара'], 'Холодильник');
  assert.ok(!('Хладагент' in p.filters));
  assert.ok(!('Вес, кг' in p.filters));
  assert.match(p.description_html, /<li>Хладагент: R600a<\/li>/);
  assert.match(p.description_html, /<li>Вес: 74 кг<\/li>/);
});

t('description_html: описание, характеристики с единицами, ключи в meta', () => {
  const [p] = buildV2([v2row('296646', { тип_товара: 'холодильник', объем_общий_л: 310, цвет: null })]).products;
  assert.strictEqual(p.id, 296646, 'id — числовой sku, как в примере заказчика');
  assert.strictEqual(p.meta_keywords, 'ключ');
  assert.strictEqual(p.description_html,
    '<p>Коротко</p><p>Подробно</p><ul><li>Тип товара: холодильник</li><li>Объем общий: 310 л</li></ul>');
  assert.ok(!('Цвет' in p.filters), 'пустая характеристика не создаёт фасет');
});

t('плюсы товара идут отдельным списком до характеристик', () => {
  const [p] = buildV2([v2row('1', { объем_л: 25 }, { bullets: ['Гриль 1200 Вт', '  ', 'Блокировка от детей'] })]).products;
  assert.strictEqual(p.description_html,
    '<p>Коротко</p><p>Подробно</p>'
    + '<ul><li>Гриль 1200 Вт</li><li>Блокировка от детей</li></ul>'
    + '<ul><li>Объем: 25 л</li></ul>',
    'пустой пункт в файл не идёт, точные характеристики и текст модели не смешиваются');
});

t('description_html: страница как в эталоне — h1, три абзаца, плюсы, specs', () => {
  const [p] = buildV2([v2row('1', { тип_товара: 'холодильник', объем_общий_л: 344 }, {
    h1: 'Холодильник Pozis RK FNF-172 W с нижней морозильной камерой',
    short_description: 'Двухкамерный холодильник Pozis.',
    seo_description: 'Первый абзац.\n\nВторой абзац.\n\nТретий абзац.',
    bullets: ['Full No Frost — камеры не требуют разморозки'],
  })]).products;
  assert.strictEqual(p.description_html,
    '<h1>Холодильник Pozis RK FNF-172 W с нижней морозильной камерой</h1>'
    + '<p>Двухкамерный холодильник Pozis.</p>'
    + '<p>Первый абзац.</p><p>Второй абзац.</p><p>Третий абзац.</p>'
    + '<ul><li>Full No Frost — камеры не требуют разморозки</li></ul>'
    + '<ul><li>Тип товара: холодильник</li><li>Объем общий: 344 л</li></ul>');
});

t('html в описании экранируется', () => {
  const [p] = buildV2([v2row('1', { цвет: 'белый & <b>яркий</b>' })]).products;
  assert.match(p.description_html, /белый &amp; &lt;b&gt;яркий&lt;\/b&gt;/);
});

t('без обогащения выгружать нечего', () => {
  assert.deepStrictEqual(buildV2([{ sku: '1', name: 'A', enriched: null }]), { filters: [], products: [] });
});

t('enum сводится к одному написанию, модель и комплектация не фасеты', () => {
  const rows = [
    v2row('1', { бренд: 'АТЛАНТ', цвет: 'чёрный', модель: 'X-1', комплектация: 'полки, ящики, лоток для яиц' }),
    v2row('2', { бренд: 'Атлант', цвет: 'черный', модель: 'X-2', комплектация: 'полки, ящики, подставка для яиц' }),
    v2row('3', { бренд: 'ATLANT', цвет: 'Черный', модель: 'X-3' }),
  ];
  const { filters, products } = buildV2(rows);
  const brands = filters.find(f => f.name === 'Бренд').value;
  assert.ok(brands.includes('Атлант'));
  assert.ok(!brands.includes('АТЛАНТ'));
  const colors = filters.find(f => f.name === 'Цвет').value;
  assert.equal(colors.length, 1);
  assert.ok(!filters.some(f => f.name === 'Модель'));
  assert.ok(!filters.some(f => f.name === 'Комплектация'));
  for (const p of products) {
    assert.ok(!('Модель' in p.filters));
    assert.ok(!('Комплектация' in p.filters));
    assert.equal(p.filters['Цвет'], colors[0]);
  }
});

console.log('\nОграничитель частоты под параллелью');
{
  // Параллельные вызовы обязаны встать в очередь: без этого они читают одно
  // состояние окна, проходят одновременно и rpm перестаёт соблюдаться.
  const rl = new RateLimiter(6000);           // minDelay = 10 мс
  const t0 = Date.now();
  const stamps = [];
  await Promise.all([1, 2, 3].map(async () => { await rl.wait(); stamps.push(Date.now() - t0); }));
  stamps.sort((a, b) => a - b);
  assert.ok(stamps[2] >= 15, `третий вызов прошёл на ${stamps[2]}мс — очередь не работает`);
  n++; console.log('  ✓ параллельные вызовы встают в очередь');
}

console.log('\nТовар без описания: поиск в сети');
{
  // Артикул или опознавательные слова имени — проверка, что найденная страница
  // про этот товар. Ошибётся она — в карточку уедут характеристики соседа.
  t('артикул узнаётся в названии, а слова с одной цифрой — нет', () => {
    assert.strictEqual(modelToken('Холодильник LG GC-Q247CAMT'), 'GC-Q247CAMT');
    assert.strictEqual(modelToken('Холодильник "Атлант" 2862-90'), '2862-90');
    // В скобках — внутренний код магазина, на чужом сайте его нет.
    assert.strictEqual(modelToken('Холодильник HOTPOINT-ARISTON HBD 1182.3 M NF H (78091)'), '1182.3');
    assert.strictEqual(modelToken('Холодильник 2-камерный белый'), null);
    assert.strictEqual(modelToken('Холодильник DON R 290 G'), null);
    assert.strictEqual(modelToken(''), null);
  });
  t('пустой товар ищется в сети по артикулу или по имени, но не по голому типу', () => {
    assert.strictEqual(isEnrichable({ name: 'Холодильник LG GC-Q247CAMT' }).web, true);
    assert.strictEqual(isEnrichable({ name: 'Холодильник DON R 290 G' }).web, true);
    assert.strictEqual(isEnrichable({ name: 'Холодильник белый' }).web, false);
  });

  t('выдача разворачивается в адреса: по одному на домен, без своего магазина', () => {
    const serp = `<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fshop.example%2Fcard&amp;rut=x">1</a>
      <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fshop.example%2Fdrugoy">тот же домен</a>
      <a href="https://mrmag.ru/shop/kholodilniki/x">наша пустая карточка</a>
      <a href="https://html.duckduckgo.com/settings">сам поисковик</a>
      <a href="https://second.example/">главная, не карточка</a>
      <a href="https://second.example/tovar">2</a>
      <a href="http://169.254.169.254/latest/meta-data/">метаданные облака</a>
      <a href="http://127.0.0.1:8080/admin">внутренняя сеть</a>
      <a href="/relative">не адрес</a>`;
    assert.deepStrictEqual(parseSearchResults(serp, 'html.duckduckgo.com'),
      ['https://shop.example/card', 'https://second.example/tovar'],
      'локальные и служебные адреса из выдачи не читаются: это доступ во внутреннюю сеть');
  });

  t('футер DuckDuckGo не считается выдачей: mastodon и рассылка не вытесняют карточку', () => {
    const organic = `<div class="result results_links web-result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://shop.example/atlant-2862-90')}">товар</a>
      </div>
      <a href="https://mastodon.social/@duckduckgo">Mastodon</a>
      <a href="https://buttondown.email/duckduckgo">newsletter</a>`;
    assert.deepStrictEqual(parseSearchResults(organic, 'html.duckduckgo.com'),
      ['https://shop.example/atlant-2862-90']);

    const footerOnly = `<div class="anomaly-modal"></div><script src="/anomaly.js"></script>
      <a href="https://mastodon.social/@duckduckgo">Mastodon</a>
      <a href="https://buttondown.email/duckduckgo">newsletter</a>
      <a href="https://shop.example/hidden">не органика</a>`;
    assert.deepStrictEqual(parseSearchResults(footerOnly, 'html.duckduckgo.com'), [],
      'заглушка с футером — пустая выдача, чтобы сработал следующий поисковик');
  });

  t('с чужой карточки берутся характеристики, а не реклама магазина', () => {
    const page = `<table><tr><td>Общий объём</td><td>310 л</td></tr>
        <tr><td>Класс энергопотребления</td><td>A+</td></tr>
        <tr><td>Ссылка</td><td>https://example/x</td></tr></table>
      <dl><dt>Система разморозки</dt><dd>No Frost</dd></dl>
      <p>Двухкамерный холодильник с нижней морозильной камерой и инверторным компрессором.</p>
      <p>Купить холодильник по цене 124420 руб. с доставкой в интернет-магазине БыстроТехника.</p>`;
    const got = parseAnyProductPage(page);
    assert.deepStrictEqual(got.attributes, [
      { name: 'Общий объём', value: '310 л' },
      { name: 'Класс энергопотребления', value: 'A+' },
      { name: 'Система разморозки', value: 'No Frost' },
    ], 'адрес в значении — не характеристика');
    assert.strictEqual(got.annotation,
      'Общий объём - 310 л<br>Класс энергопотребления - A+<br>Система разморозки - No Frost',
      'пары разделены <br> для пайплайна справочника');
    assert.match(got.description, /инверторным компрессором/);
    assert.doesNotMatch(got.description, /БыстроТехника|руб/, 'чужая реклама в описание не идёт');
  });

  // Прогон целиком на своих «поисковике» и «чужой карточке»: сеть не трогаем,
  // но проходим тот же путь, что и на живом сайте.
  const pages = {
    '/wrong': '<table><tr><td>Общий объём</td><td>200 л</td></tr></table>'
            + '<p>Холодильник другой модели с другими характеристиками внутри.</p>',
    '/right': '<h1>Холодильник LG GC Q247CAMT</h1>'
            + '<table><tr><td>Общий объём</td><td>310 л</td></tr>'
            + '<tr><td>Система разморозки</td><td>No Frost</td></tr>'
            + '<tr><td>Ширина</td><td>59.5 см</td></tr>'
            + '<tr><td>Высота</td><td>190 см</td></tr></table>',
    '/don': '<h1>Холодильник DON R 290 G</h1>'
          + '<table><tr><td>Общий объём</td><td>310 л</td></tr>'
          + '<tr><td>Система разморозки</td><td>капельная</td></tr>'
          + '<tr><td>Ширина</td><td>58 см</td></tr>'
          + '<tr><td>Высота</td><td>171 см</td></tr></table>',
    '/country': '<h1>Холодильник LG GC Q247CAMT</h1>'
          + '<table><tr><td>Страна изготовления</td><td>Китай</td></tr></table>',
    '/atlant': '<h1>Холодильник ATLANT ХМ 6025-031</h1>'
          + '<table><tr><td>Страна производства</td><td>Беларусь</td></tr></table>',
  };

  t('страница принимается по артикулу или по имени, соседняя модель — нет', () => {
    assert.strictEqual(pageDescribesProduct(pages['/don'], { name: 'Холодильник DON R 290 G' }).ok, true);
    assert.strictEqual(pageDescribesProduct(pages['/don'], { name: 'Холодильник DON R 291 G' }).ok, false);
    assert.strictEqual(pageDescribesProduct(pages['/right'], { name: 'Холодильник LG GC-Q247CAMT' }).ok, true);
    assert.strictEqual(pageDescribesProduct(pages['/wrong'], { name: 'Холодильник LG GC-Q247CAMT' }).ok, false);
  });
  const serpQueries = [];
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (url.pathname === '/serp') {
      const q = decodeURIComponent(url.search || '');
      serpQueries.push(q);
      if (/6025|ХМ/i.test(q)) {
        return res.end(`<a href="http://[::1]:${port}/atlant">a</a>`);
      }
      if (/стран/i.test(q)) {
        return res.end(`<a href="http://[::1]:${port}/country">c</a>`);
      }
      return res.end(`<a href="http://localhost:${port}/wrong">1</a><a href="http://[::1]:${port}/right">2</a>`);
    }
    res.end(pages[url.pathname] ?? 'нет такой страницы');
  });
  await new Promise(r => srv.listen(0, r));
  const port = srv.address().port;

  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-lookup-'));
  const prevSerp = { SERPAPI_KEY: process.env.SERPAPI_KEY, SERPAPI_API_KEY: process.env.SERPAPI_API_KEY };
  delete process.env.SERPAPI_KEY;
  delete process.env.SERPAPI_API_KEY;
  process.env.SEARCH_URL     = `http://127.0.0.1:${port}/serp?q=%s`;
  process.env.PAGE_CACHE_DIR = cacheDir;
  process.env.SEARCH_GAP_MS  = '0';
  process.env.CRAWL_GAP_MS   = '0';
  process.env.WEB_ALLOW_LOCAL = '1';   // заглушки живут на 127.0.0.1, в бою такие адреса запрещены
  // Отдельный экземпляр модуля: адрес поисковика и кэш читаются при загрузке.
  const web = await import('./catalog.js?web-lookup');

  await tAsync('страница без артикула отвергается, следующая — принимается', async () => {
    const product = { sku: '320420', name: 'Холодильник LG GC-Q247CAMT', description: '', annotation: '' };
    const got = await web.ensureSource(product, 'kholodilniki');
    assert.strictEqual(got.gate.ok, true, got.gate.reason);
    assert.strictEqual(got.source, `http://[::1]:${port}/right`);
    assert.match(got.product.annotation, /Общий объём - 310 л/);
    assert.strictEqual(got.product.source_url, got.source, 'источник обязан ехать вместе с текстом');
    assert.deepStrictEqual(product.description, '', 'исходный товар не переписывается на месте');
  });

  await tAsync('нет страны в исходнике — ищем по модели, своё описание не трогаем', async () => {
    serpQueries.length = 0;
    const product = {
      sku: '320420',
      name: 'Холодильник LG GC-Q247CAMT',
      brand: 'LG',
      description: 'Двухкамерный холодильник с нижней морозильной камерой, общим объёмом 310 литров и системой No Frost.',
      annotation: 'Общий объём - 310 л<br>Система разморозки - No Frost',
    };
    const got = await web.ensureSource(product, 'kholodilniki');
    assert.strictEqual(got.gate.ok, true, got.gate.reason);
    assert.match(got.product.annotation, /Страна производства - Китай/);
    assert.match(got.product.description, /Двухкамерный холодильник/);
    assert.strictEqual(got.source, `http://[::1]:${port}/country`);
  });

  await tAsync('холодильник с описанием без страны — ищем по полной модели ХМ', async () => {
    serpQueries.length = 0;
    const product = {
      name: 'Холодильник ATLANT ХМ 6025-031',
      brand: 'ATLANT',
      description: 'Двухкамерный холодильник с общим объёмом 384 литра и капельной системой охлаждения.',
      annotation: 'Общий объём - 384 л<br>Вес - 80 кг',
    };
    const got = await web.ensureSource(product, 'kholodilniki');
    assert.strictEqual(got.gate.ok, true, got.gate.reason);
    const asked = serpQueries.join(' ');
    assert.match(asked, /ХМ 6025-031/, 'модель целиком, не обрезанный 6025-031');
    assert.doesNotMatch(asked, /характеристики/, 'своё описание есть — полную карточку не скрейпим');
    assert.match(got.product.annotation, /Страна производства - Беларусь/);
    assert.match(got.product.description, /Двухкамерный холодильник/);
    assert.strictEqual(got.source, `http://[::1]:${port}/atlant`);
  });

  await tAsync('страна уже в исходнике — в сеть за ней не ходим', async () => {
    const product = {
      sku: '320420',
      name: 'Холодильник LG GC-Q247CAMT',
      description: 'Двухкамерный холодильник с нижней морозильной камерой, общим объёмом 310 литров и системой No Frost.',
      annotation: 'Общий объём - 310 л<br>Страна производства - Россия',
    };
    const got = await web.ensureSource(product, 'kholodilniki');
    assert.strictEqual(got.gate.ok, true);
    assert.strictEqual(got.source, undefined);
    assert.match(got.product.annotation, /Россия/);
    assert.doesNotMatch(got.product.annotation, /Китай/);
  });

  await tAsync('чужие характеристики без совпадения артикула не подставляются, имя всё равно идёт в модель', async () => {
    const product = { sku: '1', name: 'Холодильник LG GC-X999ZZZ', description: '' };
    const got = await web.ensureSource(product, 'kholodilniki');
    assert.strictEqual(got.gate.ok, true, 'опознаваемое имя — не пропуск, даже если страница не та');
    assert.match(got.gate.reason, /нет артикула|в сети не нашлось/);
    assert.strictEqual(got.source, undefined);
    assert.strictEqual(got.product.description, '', 'чужой текст не подставляется');
  });

  await tAsync('WEB_LOOKUP=0 возвращает прежний пропуск без единого запроса', async () => {
    process.env.WEB_LOOKUP = '0';
    const off = await import('./catalog.js?web-off');
    const got = await off.ensureSource({ name: 'Холодильник LG GC-Q247CAMT' }, 'kholodilniki');
    assert.strictEqual(got.gate.ok, false);
    assert.strictEqual(got.gate.reason, 'нет ни description, ни annotation');
    delete process.env.WEB_LOOKUP;
  });

  await new Promise(r => srv.close(r));
  fs.rmSync(cacheDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(prevSerp)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enricher-settings-'));
  const prev = process.env.SETTINGS_PATH;
  process.env.SETTINGS_PATH = path.join(dir, 'config.json');
  fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.json'), process.env.SETTINGS_PATH);
  const {
    loadSettings, applySettingsPatch, saveSettings, publicSettings, validateSettings,
    resolveProvider, parsersView, PROVIDER_PRESETS,
  } = await import('./settings.js');

  console.log('\nГибкие настройки');
  t('старый config без секций получает провайдера OpenRouter', () => {
    const s = loadSettings();
    assert.ok(s.providers.some(p => p.id === 'openrouter' && p.default));
    assert.strictEqual(s.conditions.mismatch_policy, 'flag');
    assert.ok(Array.isArray(s.search.engines));
  });
  t('публичное представление скрывает ключ', () => {
    const s = loadSettings();
    s.providers[0].api_key = 'sk-secret-abcdefgh';
    const pub = publicSettings(s);
    assert.ok(!JSON.stringify(pub).includes('sk-secret-abcdefgh'));
    assert.strictEqual(pub.providers[0].has_key, true);
    assert.match(pub.providers[0].key_hint, /efgh$/);
  });
  t('пустой api_key в PATCH оставляет прежний', () => {
    const cur = loadSettings();
    cur.providers[0].api_key = 'sk-keep-me';
    const next = applySettingsPatch(cur, {
      providers: [{ ...cur.providers[0], api_key: '' }],
    });
    assert.strictEqual(next.providers[0].api_key, 'sk-keep-me');
  });
  t('null api_key стирает ключ', () => {
    const cur = loadSettings();
    cur.providers[0].api_key = 'sk-drop-me';
    const next = applySettingsPatch(cur, {
      providers: [{ ...cur.providers[0], api_key: null }],
    });
    assert.strictEqual(next.providers[0].api_key, '');
  });
  t('свой парсер без %s не проходит валидацию', () => {
    const s = loadSettings();
    s.search.engines = [{ id: 'bad', name: 'bad', url: 'https://example.com/search', enabled: true }];
    assert.ok(validateSettings(s).some(e => /%s/.test(e)));
  });
  t('добавленный HTML-парсер сохраняется и виден в списке', () => {
    const cur = loadSettings();
    const next = applySettingsPatch(cur, {
      search: {
        ...cur.search,
        engines: [{ id: 'searx', name: 'SearxNG', url: 'https://searx.example/search?q=%s', enabled: true }],
      },
    });
    saveSettings(next);
    const again = loadSettings();
    assert.equal(again.search.engines[0].url, 'https://searx.example/search?q=%s');
    assert.ok(parsersView(again.search).parsers.some(p => p.name === 'SearxNG' && !p.builtin));
  });
  t('публичное представление скрывает ключ SerpAPI', () => {
    const s = loadSettings();
    s.search.serpapi.api_key = 'serp-secret-xyz9';
    const pub = publicSettings(s);
    assert.ok(!JSON.stringify(pub).includes('serp-secret-xyz9'));
    assert.strictEqual(pub.search.serpapi.has_key, true);
    assert.match(pub.search.serpapi.key_hint, /xyz9$/);
    assert.ok(!('api_key' in pub.search.serpapi) || !pub.search.serpapi.api_key);
  });
  t('пустой ключ SerpAPI в PATCH оставляет прежний', () => {
    const cur = loadSettings();
    cur.search.serpapi.api_key = 'serp-keep';
    const next = applySettingsPatch(cur, {
      search: { ...cur.search, serpapi: { ...cur.search.serpapi, api_key: '' } },
    });
    assert.strictEqual(next.search.serpapi.api_key, 'serp-keep');
  });
  t('SerpAPI есть в списке парсеров', () => {
    const s = loadSettings();
    assert.ok(parsersView(s.search).parsers.some(p => p.kind === 'serpapi' && p.engine === 'google'));
  });
  t('список парсеров не содержит ключ SerpAPI', () => {
    const s = loadSettings();
    s.search.serpapi.api_key = 'serp-secret-view';
    const view = parsersView(s.search);
    assert.ok(!JSON.stringify(view).includes('serp-secret-view'));
    assert.strictEqual(view.serpapi.has_key, true);
  });
  t('провайдер по умолчанию — выбранный default', () => {
    const s = loadSettings();
    assert.equal(resolveProvider(s).id, 'openrouter');
    assert.equal(resolveProvider(s, 'openrouter').name, 'OpenRouter');
  });
  t('заготовка DeepSeek — официальный API и текущие модели', () => {
    const ds = PROVIDER_PRESETS.find(p => p.id === 'deepseek');
    assert.ok(ds, 'нет заготовки deepseek');
    assert.equal(ds.base_url, 'https://api.deepseek.com');
    assert.equal(ds.api_key_env, 'DEEPSEEK_API_KEY');
    assert.ok(ds.models.includes('deepseek-v4-flash'));
    assert.ok(ds.models.includes('deepseek-v4-pro'));
    const s = loadSettings();
    assert.ok(s.providers.some(p => p.id === 'deepseek' && p.base_url === 'https://api.deepseek.com'));
    assert.equal(resolveProvider(s, 'deepseek').name, 'DeepSeek');
  });
  t('пустой список моделей DeepSeek дополняется из заготовки', () => {
    const next = applySettingsPatch(loadSettings(), {
      providers: [{
        id: 'deepseek', name: 'DeepSeek', kind: 'openai', enabled: true, default: true,
        base_url: 'https://api.deepseek.com', models: [],
      }],
    });
    const ds = next.providers.find(p => p.id === 'deepseek');
    assert.ok(ds.models.includes('deepseek-v4-flash'));
    assert.ok(ds.models.includes('deepseek-v4-pro'));
  });

  if (prev === undefined) delete process.env.SETTINGS_PATH;
  else process.env.SETTINGS_PATH = prev;
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n✅ ${n} проверок пройдено\n`);
