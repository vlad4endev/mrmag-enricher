import assert from 'node:assert/strict';
import { loadConfig, loadDictionary } from './pipeline/dict.js';
import { ingestPack, ingestProduct, detectCategory, detectShape, asProductList, asFilterList, dumpNameMatches } from './refine/ingest.js';
import { findDumpProduct } from './pipeline/dumps.js';
import { auditPack } from './refine/audit.js';
import { repairPack } from './refine/repair.js';
import { analyzeFiles } from './refine/index.js';

const config = loadConfig('.');
const d467 = loadDictionary('467', '.');

function washerCard(over = {}) {
  return {
    id: 11391,
    name: 'Стиральная машина Indesit IWUB 4085',
    meta_keywords: 'стиральная машина Indesit, фронтальная стиральная машина, стиральная машина 6 кг, стиральная машина белая, отдельностоящая стиральная машина, стиральная машина 1000 об/мин, узкая стиральная машина',
    description_html: '<p>Фронтальная стиральная машина <strong>Indesit IWUB 4085</strong> рассчитана на 6 кг белья.</p><p>Отжим 1000 об/мин, класс A, белый корпус.</p><p>Отдельностоящая установка, механическое управление.</p><ul><li>тихая работа</li><li>компактный корпус</li><li>понятные программы</li></ul><p>Подходит для небольшой ванной.</p>',
    annotation_html: '<ul><li>Тип загрузки: фронтальная</li><li>Максимальная загрузка белья: 6 кг</li><li>Цвет: белый</li><li>Подарок в комплекте: тазик</li></ul>',
    filters: {
      'Тип загрузки': ['Фронтальная'],
      'Бренд': ['Indesit'],
      'Выдуманный фильтр': ['foo'],
      'Загрузка белья, кг': ['6'],
      'Цвет': ['Белый'],
    },
    web_info: null,
    ...over,
  };
}

{
  const list = asProductList({ products: [washerCard()] });
  assert.equal(list.length, 1);
  assert.equal(detectShape(list), 'customer');
  const cat = detectCategory({
    products: list,
    filenames: ['products_467.json'],
    root: '.',
  });
  assert.equal(cat.id, '467');
  console.log('ok detect category/shape');
}

{
  const filt = asFilterList({
    category_id: 467,
    filters: [
      { name: 'Цвет', value: ['Белый', 'Чёрный'] },
      { name: 'Бренд', value: ['LG'] },
    ],
  });
  assert.equal(filt.meta.category_id, 467);
  assert.equal(filt.items.length, 2);
  console.log('ok parse filters file');
}

{
  const rec = ingestProduct(washerCard(), d467, config, { root: '.' });
  assert.equal(rec.attrs.load_type, 'Фронтальная');
  assert.equal(rec.attrs.load_max, 6);
  assert.ok(rec.attrs.color);
  const pack = ingestPack({
    products: [washerCard()],
    filters: {
      filters: [
        { name: 'Цвет', value: ['Белый'] },
        { name: 'Бренд', value: ['Indesit'] },
        { name: 'Акция', value: ['скидка'] },
      ],
    },
    filenames: ['products_467.json', 'filters_467.json'],
    root: '.',
  });
  const audit = auditPack(pack);
  assert.equal(audit.category.id, '467');
  const item = audit.items[0];
  assert.ok(item.extra.some(e => e.name === 'Бренд'), JSON.stringify(item.extra));
  assert.ok(item.extra.some(e => e.name === 'Выдуманный фильтр'));
  assert.ok(item.extra.some(e => /подарок/i.test(e.name)), JSON.stringify(item.extra));
  assert.ok(audit.filters_file.extra.some(e => e.name === 'Бренд'));
  assert.ok(audit.filters_file.extra.some(e => e.name === 'Акция'));
  console.log('ok audit extras');
}

{
  const pack = ingestPack({
    products: [washerCard({
      annotation_html: '<ul><li>Тип загрузки: фронтальная</li><li>Максимальная загрузка белья: 6 кг</li><li>Цвет: белый</li></ul>',
      filters: {
        'Тип загрузки': ['Фронтальная'],
        'Бренд': ['Indesit'],
        'Выдуманный фильтр': ['foo'],
        'Загрузка белья, кг': ['5-6'],
        'Цвет': ['Белый'],
      },
    })],
    filters: { filters: [{ name: 'Бренд', value: ['Indesit'] }, { name: 'Цвет', value: ['Белый'] }] },
    filenames: ['products_467.json'],
    root: '.',
  });
  const rec = pack.recs[0];
  assert.equal(rec.attrs.load_max, 6, 'бакет фильтра не должен затирать точное значение из аннотации');
  const result = await repairPack(pack, { lookup: false });
  const row = result.files.products[0];
  assert.ok(!row.filters['Бренд']);
  assert.ok(!row.filters['Выдуманный фильтр']);
  assert.ok(row.filters['Тип загрузки']);
  assert.ok(!/Подарок/i.test(row.annotation_html));
  assert.ok(/Тип загрузки:/i.test(row.annotation_html));
  assert.ok(!(result.files.filters.filters || []).some(f => /бренд/i.test(f.name)));
  assert.ok(!(result.files.filters.filters || []).some(f => f.name === 'Акция'));
  assert.equal(result.report.extra_after, 0, JSON.stringify(result.after.summary));
  console.log('ok repair strip extras');
}

{
  const pack = ingestPack({
    products: [{
      id: 42,
      name: 'Стиральная машина LG F2J6HS0W',
      description_html: '<p>Стиральная машина с загрузкой 7 кг белья.</p>',
      annotation_html: '',
      filters: { 'Тип загрузки': ['Вертикальная'] },
      web_info: null,
    }],
    filenames: ['products_467.json'],
    root: '.',
  });
  const rec = pack.recs[0];
  assert.equal(rec.attrs.load_type, 'Вертикальная', 'enum из фильтра добирает пустую аннотацию');
  console.log('ok fill from filter enum');
}

{
  const { audit } = analyzeFiles({
    products: [washerCard()],
    filenames: ['products_467.json'],
  }, '.');
  assert.ok(audit.summary.extra > 0);
  console.log('ok analyzeFiles');
}

{
  assert.equal(dumpNameMatches('Стиральная машина ATLANT 60С1010', 'Стиральная машина Indesit IWUB 4085'), false);
  assert.equal(dumpNameMatches('Стиральная машина ATLANT 60С1010', 'ATLANT 60С1010 белая'), true);
  const pack = ingestPack({
    products: [washerCard()],
    filenames: ['products_467.json'],
    root: '.',
  });
  assert.ok(!pack.recs[0].flags.includes('refine_dump'), 'чужой товар с тем же SKU дампа не подмешивать');
  const result = await repairPack(pack, { lookup: false });
  const ann = result.files.products[0].annotation_html;
  assert.ok(!/A\+\+/.test(ann), 'A++ из чужого дампа');
  assert.ok(!/16 программ/i.test(ann), 'программы из чужого дампа');
  assert.ok(!/Дисплей/i.test(ann), 'дисплей не угадывать без текста');
  assert.ok(!/коллекторн/i.test(ann), 'мотор не угадывать без текста');
  assert.ok(!/Сушка:/i.test(ann), 'сушку не ставить «нет» всем стиралкам');
  assert.ok(!result.files.products[0].filters['Бренд']);
  const dump = findDumpProduct('467', 11391, '.');
  if (dump?.name) {
    const same = ingestPack({
      products: [{
        id: 11391,
        name: dump.name,
        description_html: '<p>Короткое описание без характеристик.</p>',
        annotation_html: '',
        filters: {},
        web_info: null,
      }],
      filenames: ['products_467.json'],
      root: '.',
    });
    assert.ok(same.recs[0].flags.includes('refine_dump'), 'свой дамп той же модели можно добрать');
  }
  console.log('ok dump name guard');
}

console.log('refine tests ok');
