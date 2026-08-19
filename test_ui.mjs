/**
 * test_ui.mjs — проверка логики интерфейса. Запуск: node test_ui.mjs
 *
 * Скрипт извлекается прямо из index_final.html и выполняется поверх
 * минимальной заглушки DOM. Браузер не нужен, но проверяется настоящий код:
 * состояние шагов, фильтры, статусы и выгрузка.
 *
 * Эти проверки уже нашли два падения на частично завершённом прогоне —
 * именно там, где результат восстанавливается из localStorage.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ── ЗАГЛУШКА DOM ─────────────────────────────────────────────
class El {
  constructor(id, cls) {
    this.id = id; this._cls = new Set(cls ? cls.split(' ') : []);
    this.style = {}; this._txt = ''; this._html = '';
    this.dataset = {}; this.disabled = false; this.children = []; this.parent = null;
    this.classList = {
      add: c => this._cls.add(c),
      remove: c => this._cls.delete(c),
      toggle: (c, f) => { const on = f === undefined ? !this._cls.has(c) : f; on ? this._cls.add(c) : this._cls.delete(c); return on; },
      contains: c => this._cls.has(c),
    };
  }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._cls].join(' '); }
  set textContent(v) { this._txt = String(v); }
  get textContent() { return this._txt; }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  _all() { return this.children.flatMap(c => [c, ...c._all()]); }
  querySelectorAll(sel) { const c = sel.replace(/^\./, ''); return this._all().filter(e => e._cls.has(c)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); }
  addEventListener() {}
  focus() {}
  click() {}
  setAttribute(k, v) { this._attr = this._attr || {}; this._attr[k] = String(v); }
  getAttribute(k) { return this._attr?.[k] ?? null; }
}

const html = fs.readFileSync(path.join(ROOT, 'index_final.html'), 'utf-8');
const ids = [...new Set([...html.slice(0, html.indexOf('<script>')).matchAll(/id="([^"]+)"/g)].map(m => m[1]))];

const store = new Map(ids.map(id => [id, new El(id)]));
for (const n of ['step1', 'step2', 'step3']) store.get(n).appendChild(new El(n + '-b', 'step-b'));

const groups = { '.cnt-grid .cnt-btn': [], '.cat-btn': [], '.fbtn': [], '.rtab': [], '.mitem': [], '.page': [], '.ntab': [] };
for (const n of ['1', '10', '50', '100', '500']) { const e = new El('cnt' + n); e.dataset.n = n; groups['.cnt-grid .cnt-btn'].push(e); }
for (const f of ['all', 'thin', 'warn', 'err'])  { const e = new El('f' + f);  e.dataset.f = f; groups['.fbtn'].push(e); }
groups['.rtab'].push(new El('rt1'), new El('rt2'));

globalThis.document = {
  getElementById: id => { if (!store.has(id)) store.set(id, new El(id)); return store.get(id); },
  querySelectorAll: sel => groups[sel] || [],
  querySelector:    sel => (groups[sel] || [])[0] || null,
  createElement:    () => new El('new'),
  addEventListener: () => {},
  fonts: { ready: Promise.resolve(), check: () => true },
  documentElement: new El('html'),
};
globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = v; },
  removeItem(k) { delete this._d[k]; },
};
globalThis.confirm = () => true;
globalThis.window = { matchMedia: () => ({ matches: false }) };
globalThis.fetch = () => Promise.reject(new Error('сеть в тесте отключена'));
globalThis.URL = { createObjectURL: () => 'blob:', revokeObjectURL: () => {} };
globalThis.Blob = class { constructor(a) { this.parts = a; } };
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: () => Promise.resolve() } }, configurable: true,
});

// ── ЗАГРУЗКА СКРИПТА СТРАНИЦЫ ────────────────────────────────
const script = html.match(/<script>\n([\s\S]*)<\/script>/)[1]
  .replace('checkIconFont();', '')
  .replace(/\ninit\(\);/, '')
  .replace(/\ncalcUpdate\(\);/, '');

const EXPORTS = `
export const api={syncSteps,setCnt,setCntFree,applyCnt,applySource,setSource,pickDataCat,renderDataCats,readProd,renderList,statusOf,selectResult,renderDetail,plural,
  renderEstimate,setFilter,stepError,pick,sumRun,renderFoot,clearResults,restoreResults,saveResults,
  downloadAll,downloadCategoryFiles,downloadV2,initTheme,toggleTheme,applyTheme,dur,renderRunline,
  loadCategories,loadCategory,renderModelList,filterModels,
  applyDates,clearDates,renderDates,passesFilter,queued,onProdInput};
export const st={get items(){return items},set items(v){items=v},
  get srcItems(){return srcItems},set srcItems(v){srcItems=v},
  get pickCat(){return pickCat},set pickCat(v){pickCat=v},get selCnt(){return selCnt},get results(){return results},
  set results(v){results=v},get selModel(){return selModel},
  get allModels(){return allModels},set allModels(v){allModels=v},
  get curIdx(){return curIdx},get filter(){return filter},
  get running(){return running},set running(v){running=v},
  get runIdx(){return runIdx},set runIdx(v){runIdx=v},
  get curCat(){return curCat},set curCat(v){curCat=v},
  get categories(){return categories},set categories(v){categories=v},
  set schemas(v){schemas=v},
  set runT0(v){runT0=v},
  get quality(){return quality},set quality(v){quality=v},
  get dateKey(){return dateKey}};
`;
const tmp = path.join(ROOT, '.ui_under_test.mjs');
fs.writeFileSync(tmp, script + EXPORTS, 'utf-8');
let api, st;
try {
  ({ api, st } = await import('file://' + tmp));
} finally {
  fs.unlinkSync(tmp);
}

const G = id => document.getElementById(id);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
const tAsync = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };

const MODEL = { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2', pricing: { prompt: '0.00000027', completion: '0.00000041' } };
const ok    = () => ({ original: {}, enriched: { specs: {}, warnings: [] }, iT: 1200, oT: 700, cost: 0.0006 });
const warn  = () => ({ original: {}, enriched: { specs: {}, warnings: [{ field: 'объем_общий_л', model: 250, source: 310, note: 'не совпало' }] }, iT: 1100, oT: 650, cost: 0.00055 });
const err   = () => ({ original: {}, enriched: null, error: 'таймаут 60000ms' });
const skip  = () => ({ original: {}, enriched: null, skipped: 'нет характеристик' });

console.log('\nКнопка запуска всегда объясняет своё состояние');
t('без модели выключена и говорит почему', () => {
  st.items = []; st.results = [];
  api.syncSteps();
  assert.strictEqual(G('runBtn').disabled, true);
  assert.match(G('runWhy').textContent, /выберите модель/i);
});
t('с моделью, но без товаров — всё ещё выключена', () => {
  st.allModels = [MODEL];
  api.pick(MODEL.id);
  assert.strictEqual(G('runBtn').disabled, true);
  assert.match(G('runWhy').textContent, /загрузите товары/i);
  assert.ok(G('step1').classList.contains('done'), 'шаг 1 должен быть отмечен');
});
t('с моделью и товарами — включается', () => {
  st.items = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  api.syncSteps();
  assert.strictEqual(G('runBtn').disabled, false);
  assert.match(G('runWhy').textContent, /Будет обработано 3 товара/);
  assert.strictEqual(G('sub2').textContent, '3 товара');
});
t('повторный запуск предупреждает о замене результатов', () => {
  st.results = [ok(), ok(), null];
  api.syncSteps();
  assert.match(G('runWhy').textContent, /заменит текущие 2 результата/);
});

console.log('\nФильтр «Без данных» и даты импорта');
const F = f => groups['.fbtn'].find(b => b.dataset.f === f);
t('без ответа /api/quality кнопка «Без данных» выключена', () => {
  st.items = [{ name: 'A' }, { name: 'B' }];
  st.results = []; st.quality = [];
  api.setFilter(F('all'));
  api.renderList();
  assert.strictEqual(F('thin').disabled, true, 'нечего фильтровать — кнопка не должна кликаться');
});
t('фильтр оставляет только товары без нормальных данных', () => {
  st.items = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  st.results = [];
  st.quality = [{ ok: true }, { ok: false, reason: 'нет ни description, ни annotation' }, { ok: false, reason: 'текст 12 симв.' }];
  api.renderList();
  assert.strictEqual(F('thin').textContent, 'Без данных 2', 'счётчик берётся из ответа сервера');
  api.setFilter(F('thin'));
  assert.deepStrictEqual(api.queued(), [1, 2]);
  assert.match(G('midList').innerHTML, /нет ни description/, 'причина видна в строке товара');
  assert.ok(!/>A</.test(G('midList').innerHTML), 'товар с данными в фильтр попасть не должен');
});
t('прогон обещает ровно то, что в фильтре', () => {
  api.syncSteps();
  assert.match(G('runWhy').textContent, /Будет обработано 2 из 3/);
  api.renderEstimate();
  assert.match(G('est').innerHTML, /За 2 товара из 3/);
});
t('без поля с датой строка дат скрыта', () => {
  api.setFilter(F('all'));
  api.renderDates();
  assert.strictEqual(G('dateFilter').style.display, 'none');
  assert.strictEqual(st.dateKey, null);
});
t('дата импорта найдена — диапазон сужает список', () => {
  st.items = [
    { name: 'A', imported_at: '2026-06-01T10:00:00Z' },
    { name: 'B', imported_at: '2026-06-05T10:00:00Z' },
    { name: 'C', imported_at: '2026-07-20T10:00:00Z' },
    { name: 'D' },
  ];
  st.results = []; st.quality = [];
  api.renderDates();
  assert.strictEqual(st.dateKey, 'imported_at');
  assert.strictEqual(G('dateFilter').style.display, 'flex');
  assert.match(G('dateHint').textContent, /imported_at/);
  assert.match(G('dateHint').textContent, /без даты 1/, 'товар без даты нужно посчитать отдельно');
  G('dFrom').value = '2026-06-01'; G('dTo').value = '2026-06-05';
  api.applyDates();
  assert.deepStrictEqual(api.queued(), [0, 1], 'граничные дни входят в диапазон, товар без даты — нет');
});
t('фильтры складываются: «без данных» внутри диапазона', () => {
  st.quality = [{ ok: true }, { ok: false, reason: 'пусто' }, { ok: false, reason: 'пусто' }, { ok: false, reason: 'пусто' }];
  api.renderList();
  api.setFilter(F('thin'));
  assert.deepStrictEqual(api.queued(), [1], 'C и D вне диапазона дат');
});
t('сброс дат возвращает весь список', () => {
  api.clearDates();
  api.setFilter(F('all'));
  assert.deepStrictEqual(api.queued(), [0, 1, 2, 3]);
});

console.log('\nРусские склонения в подписях');
t('1 / 2 / 5 / 11 / 21 / 104', () => {
  const p = n => api.plural(n, 'товар', 'товара', 'товаров');
  assert.deepStrictEqual([1, 2, 5, 11, 21, 104].map(p), ['товар', 'товара', 'товаров', 'товаров', 'товар', 'товара']);
});

console.log('\nОценка стоимости — для загруженного количества');
t('показывает и всего, и за штуку, и допущение', () => {
  st.items = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  api.renderEstimate();
  const h = G('est').innerHTML;
  assert.match(h, /За 3 товара/);
  assert.match(h, /За один товар/);
  assert.match(h, /1200↑ 700↓/, 'допущение о токенах должно быть подписано');
  assert.match(h, /Курс 80/);
});
t('без модели или товаров — только пояснение', () => {
  st.items = [];
  api.renderEstimate();
  assert.match(G('est').innerHTML, /появится стоимость/);
});

console.log('\n«Сколько обработать» — одна настройка с одним смыслом');
const CNT = n => groups['.cnt-grid .cnt-btn'].find(b => b.dataset.n === n);
t('урезает уже загруженный список', () => {
  st.srcItems = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  G('prod').value = '';
  api.setCnt(CNT('1'));
  assert.strictEqual(st.items.length, 1);
  assert.match(G('fetchHint').textContent, /первые 1 товар/);
});
t('возвращает товары обратно, когда число снова растёт', () => {
  api.setCnt(CNT('10'));
  assert.strictEqual(st.items.length, 3, 'источник загружен целиком — срез должен вырасти');
});
t('не добавляет товаров, которых нет', () => {
  api.setCnt(CNT('500'));
  assert.strictEqual(st.items.length, 3, 'выбор 500 не должен размножать 3 товара');
});
t('своё число подсвечивает поле и гасит кнопку', () => {
  const inp = G('cntIn'); inp.value = '2';
  api.setCntFree(inp);
  assert.ok(inp.classList.contains('on'), 'поле подсвечивается как выбранное');
  assert.ok(!CNT('500').classList.contains('on'), 'кнопка гаснет');
});
await tAsync('своё число применяется после паузы в наборе', async () => {
  await new Promise(r => setTimeout(r, 450));   // «25» по дороге проходит через «2»
  assert.strictEqual(st.selCnt, 2);
  assert.strictEqual(st.items.length, 2);
  const inp = G('cntIn'); inp.value = '-5';     // мусор не обнуляет список
  api.setCntFree(inp);
  await new Promise(r => setTimeout(r, 450));
  assert.strictEqual(st.selCnt, 1, 'меньше одного товара обрабатывать нечего');
  api.setCnt(CNT('10'));
});

console.log('\nКатегории берутся из самих товаров');
t('чипы показывают, что есть в загруженном', () => {
  api.setSource([{ name: 'A', category: 'Холодильники' }, { name: 'B', category: 'Посуда' },
                 { name: 'C', category: 'Холодильники' }]);
  const html = G('dataCatRow').innerHTML;
  assert.match(html, /Холодильники/);
  assert.match(html, /Посуда/);
  assert.match(html, /3 товара/, 'у «Все категории» — весь источник');
  assert.strictEqual(G('dataCats').style.display, '');
});
t('выбор категории оставляет только её товары', () => {
  api.pickDataCat('Холодильники');
  assert.strictEqual(st.items.length, 2);
  assert.ok(st.items.every(p => p.category === 'Холодильники'));
  api.pickDataCat(null);
  assert.strictEqual(st.items.length, 3, 'возврат к «Все категории»');
});
t('лимит режет уже выбранную категорию', () => {
  api.pickDataCat('Холодильники');
  api.setCnt(CNT('1'));
  assert.strictEqual(st.items.length, 1);
  api.setCnt(CNT('10'));
});
t('без категорий выбирать нечего — блок скрыт', () => {
  api.setSource([{ name: 'A' }, { name: 'B' }]);
  assert.strictEqual(G('dataCats').style.display, 'none');
  assert.strictEqual(st.items.length, 2);
});

console.log('\nОшибки показываются внутри шага, а не через alert()');
t('битый JSON попадает в шаг 2 и убирается после починки', () => {
  G('prod').value = '{битый json';
  const e = api.readProd();
  assert.ok(e, 'разбор должен вернуть ошибку');
  api.stepError(2, e);
  assert.match(G('step2').querySelector('.inline-err').textContent, /JSON/);
  api.stepError(2, null);
  assert.strictEqual(G('step2').querySelector('.inline-err'), null);
});
t('не-объект в массиве отлавливается с номером', () => {
  G('prod').value = '[{"name":"A"}, 42]';
  assert.match(api.readProd(), /№2/);
});
t('пустое поле — не ошибка', () => {
  G('prod').value = '';
  assert.strictEqual(api.readProd(), null);
  assert.strictEqual(st.items.length, 0);
});

console.log('\nСтатусы товаров и фильтры');
t('четыре состояния различаются', () => {
  st.items = [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }];
  st.quality = [];
  st.results = [ok(), warn(), err(), skip()];
  assert.deepStrictEqual([0, 1, 2, 3].map(i => api.statusOf(i).cls), ['ok', 'wa', 'er', 'sk']);
});
t('необработанный товар — «в очереди»', () => {
  st.results = [ok(), null, null, null];
  assert.strictEqual(api.statusOf(1).cls, 'pd');
  st.results = [ok(), warn(), err(), skip()];
});
t('счётчики на фильтрах считают верно', () => {
  api.renderList();
  assert.strictEqual(F('all').textContent, 'Все 4');
  assert.strictEqual(F('warn').textContent, 'Расхождения 1');
  assert.strictEqual(F('err').textContent, 'Ошибки 1');
});
t('фильтр сужает список и переводит на первую проблему', () => {
  api.setFilter(F('err'));
  assert.strictEqual(st.filter, 'err');
  assert.strictEqual((G('midList').innerHTML.match(/class="ri s-[a-z]+(?: on)?"/g) || []).length, 1);
  assert.strictEqual(st.curIdx, 2, 'должен выбраться товар с ошибкой');
  api.setFilter(F('all'));
});
t('фильтр без совпадений выключен', () => {
  st.results = [ok(), ok(), ok(), ok()];
  api.renderList();
  assert.strictEqual(F('warn').disabled, true, 'нет расхождений — кнопка неактивна');
  assert.strictEqual(F('err').disabled, true, 'нет ошибок — кнопка неактивна');
  st.results = [ok(), warn(), err(), skip()];
});
t('полоса прогресса отражает долю обработанных', () => {
  st.results = [ok(), warn(), null, null];
  api.renderList();
  assert.strictEqual(G('midBarF').style.width, '50%');
  st.results = [ok(), warn(), err(), skip()];
  api.renderList();
  assert.strictEqual(G('midBarF').style.width, '100%');
});

console.log('\nИтоги прогона');
t('суммы и разбивка по состояниям', () => {
  const s = api.sumRun();
  assert.strictEqual(s.ok, 2, 'успешные считают и товары с расхождениями');
  assert.strictEqual(s.warn, 1);
  assert.strictEqual(s.err, 1);
  assert.strictEqual(s.skip, 1);
  assert.ok(Math.abs(s.tCost - 0.00115) < 1e-9, 'стоимость: ' + s.tCost);
  assert.strictEqual(s.tIn, 2300);
});
t('подвал показывает всё нужное', () => {
  api.renderFoot(api.sumRun(), 'за 12.3с');
  const h = G('foot').innerHTML;
  for (const frag of ['Готово', 'Токены', 'Итого', 'Ошибок', 'Расхождений', 'Пропущено', 'за 12.3с']) {
    assert.ok(h.includes(frag), 'нет фрагмента: ' + frag);
  }
});

console.log('\nПанель деталей различает состояния');
t('необработанный товар показывает исходный текст без HTML', () => {
  st.items = [{ name: 'X', description: '<p>размер 57.4x61x171 см. класс A.</p>' }];
  st.results = [null];
  api.selectResult(0);
  const h = G('detail').innerHTML;
  assert.match(h, /Исходный текст/);
  assert.ok(!h.includes('<p>'), 'теги описания должны быть вычищены');
  assert.strictEqual(G('rtabs').style.display, 'none', 'табы не нужны без результата');
});
t('пропуск отличается от ошибки и объясняет, что денег не потратили', () => {
  st.results = [skip()];
  api.renderDetail();
  const h = G('detail').innerHTML;
  assert.match(h, /Пропущен без обращения/);
  assert.match(h, /деньги не потрачены/);
});
t('ошибка показана как ошибка', () => {
  st.results = [err()];
  api.renderDetail();
  assert.match(G('detail').innerHTML, /errbox/);
});
t('расхождения выводятся первым блоком', () => {
  st.results = [warn()];
  api.renderDetail();
  assert.match(G('detail').innerHTML, /warnbox/);
  assert.strictEqual(G('rtabs').style.display, 'flex');
});

console.log('\nЧастично завершённый прогон (здесь ранее было два падения)');
t('восстановление прогона с пропусками не роняет страницу', () => {
  st.items = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  st.results = [ok(), null, null];
  api.saveResults();
  st.items = []; st.results = [];
  api.restoreResults();            // внутри вызывает syncSteps
  assert.strictEqual(st.results.length, 3);
  assert.strictEqual(st.items.length, 3);
  assert.strictEqual(G('clrBtn').style.display, 'inline-block');
});
t('выгрузка JSON пропускает необработанные позиции', () => {
  let captured = null;
  const RealBlob = globalThis.Blob;
  globalThis.Blob = class { constructor(p) { captured = p[0]; } };
  try { api.downloadAll('json'); } finally { globalThis.Blob = RealBlob; }
  const parsed = JSON.parse(captured);
  assert.strictEqual(parsed.items.length, 1, 'в выгрузке только обработанный товар');
  assert.strictEqual(parsed.rub_per_usd, 80);
});
t('выгрузка TXT не падает на пропусках', () => {
  let captured = null;
  const RealBlob = globalThis.Blob;
  globalThis.Blob = class { constructor(p) { captured = p[0]; } };
  try { api.downloadAll('txt'); } finally { globalThis.Blob = RealBlob; }
  assert.match(captured, /AI ENRICHER/);
  assert.match(captured, /Курс: 80/);
});
console.log('\nДва файла на раздел');
// Ловим и содержимое (Blob), и имя (a.download): пара файлов на раздел — это
// про имена не меньше, чем про содержимое.
const catchFiles = async fn => {
  const files = [];
  const RealBlob = globalThis.Blob, realCreate = document.createElement;
  let last = null;
  globalThis.Blob = class { constructor(p) { last = p[0]; } };
  document.createElement = () => {
    const a = new El('a');
    Object.defineProperty(a, 'download', { set(v) { files.push({ name: v, body: last }); }, configurable: true });
    return a;
  };
  try { await fn(); } finally { globalThis.Blob = RealBlob; document.createElement = realCreate; }
  return files;
};

await tAsync('раздел выгружается парой products/filters с фильтром всего раздела', async () => {
  st.curCat = {
    category_id: 523, category: 'Холодильники', slug: 'kholodilniki', url: 'https://mrmag.ru/shop/kholodilniki',
    filters_file: { category_id: 523, products_total: 256, filters: [{ code: 'brand', values: [{ value: 'DON' }] }] },
  };
  st.items = [{ sku: '1', name: 'A', category: 'Холодильники' }, { sku: '2', name: 'B', category: 'Холодильники' }];
  st.results = [{ enriched: { specs: {}, warnings: [] }, iT: 10, oT: 5, cost: 0.001 }, null];

  const files = await catchFiles(() => api.downloadCategoryFiles());
  assert.deepStrictEqual(files.map(f => f.name), ['products_523.json', 'filters_523.json']);

  const products = JSON.parse(files[0].body);
  assert.strictEqual(products.length, 2, 'в файл идут все загруженные товары, не только обработанные');
  assert.ok(products[0].enriched, 'обогащённый товар несёт enriched');
  assert.strictEqual(products[0]._meta.cost_usd, 0.001);
  assert.strictEqual(products[1].enriched, null, 'необработанный — enriched: null, как в файле из CLI');
  // Фильтр раздела, а не окна: товаров загружено 2, а в фильтре 256.
  assert.strictEqual(JSON.parse(files[1].body).products_total, 256);
});

await tAsync('товары из фида раскладываются по разделам, фильтры считает сервер', async () => {
  st.curCat = null;
  st.categories = [{ slug: 'kholodilniki', name: 'Холодильники', id: 523, url: 'u1' }];
  st.schemas = { posuda: { id: null, name: 'Посуда' } };
  st.items = [
    { sku: '1', name: 'Холодильник', category: 'Холодильники' },
    { sku: '2', name: 'Кастрюля',    category: 'Посуда' },
  ];
  st.results = [null, null];

  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    asked.push(JSON.parse(opts.body));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ category_id: null, filters: [] }) });
  };
  let files;
  try { files = await catchFiles(() => api.downloadCategoryFiles()); }
  finally { globalThis.fetch = realFetch; }

  assert.deepStrictEqual(files.map(f => f.name),
    ['products_523.json', 'filters_523.json', 'products_posuda.json', 'filters_posuda.json'],
    'без id раздела имя файла берёт slug схемы — молча склеивать разделы нельзя');
  assert.strictEqual(asked.length, 2, 'фильтры считает сервер, а не копия buildFilters в браузере');
  assert.deepStrictEqual(asked.map(a => a.products.length), [1, 1]);
});

await tAsync('сбой фильтров не оставляет половину пары', async () => {
  st.curCat = null;
  st.items = [{ sku: '1', name: 'X', category: 'Посуда' }];
  st.results = [null];
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'сервер лёг' }) });
  let files;
  try { files = await catchFiles(() => api.downloadCategoryFiles()); }
  finally { globalThis.fetch = realFetch; }
  assert.strictEqual(files.length, 0, 'products без filters выгружать нельзя');
});

console.log('\nВыгрузка JSON v2');
await tAsync('три файла: категории, фасеты диапазонами и товары', async () => {
  st.curCat = { category_id: 523, category: 'Холодильники', slug: 'kholodilniki', url: 'u' };
  st.items = [
    { sku: '1', name: 'Холодильник A', category: 'Холодильники' },
    { sku: '2', name: 'Холодильник B', category: 'Холодильники' },
    { sku: '3', name: 'Холодильник C', category: 'Холодильники' },   // без прогона
  ];
  st.results = [
    { enriched: { specs: { цвет: 'белый' }, warnings: [] } },
    { enriched: { specs: { цвет: 'чёрный' }, warnings: [] } },
    null,
  ];

  let sent = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    sent = { url, body: JSON.parse(opts.body) };
    return Promise.resolve({ ok: true, json: () => Promise.resolve({
      filters: [{ name: 'Цвет', value: ['белый', 'чёрный'] }],
      products: [{ id: 1, name: 'Холодильник A', meta_keywords: '', description_html: '<p>a</p>', filters: { Цвет: 'белый' } }],
    }) });
  };
  let files;
  try { files = await catchFiles(() => api.downloadV2()); }
  finally { globalThis.fetch = realFetch; }

  assert.strictEqual(sent.url, '/api/export-v2');
  assert.strictEqual(sent.body.products.length, 2, 'необработанные товары в v2 не идут — им нечем быть');
  assert.deepStrictEqual(files.map(f => f.name),
    ['categories_v2.json', 'filters_v2_523.json', 'products_v2_523.json']);
  assert.deepStrictEqual(JSON.parse(files[0].body), { categories: [{ id: 523, name: 'Холодильники' }] });
  assert.deepStrictEqual(JSON.parse(files[1].body).filters[0].name, 'Цвет');
  assert.strictEqual(JSON.parse(files[2].body)[0].description_html, '<p>a</p>');
});

await tAsync('без прогона выгрузка v2 не зовёт сервер', async () => {
  st.results = [null, null, null];
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('сервер не должен вызываться'); };
  let files;
  try { files = await catchFiles(() => api.downloadV2()); }
  finally { globalThis.fetch = realFetch; }
  assert.strictEqual(files.length, 0);
});

t('сброс очищает состояние и прячет кнопки', () => {
  api.clearResults();
  assert.strictEqual(st.results.length, 0);
  assert.strictEqual(G('clrBtn').style.display, 'none');
  // Список товаров сохраняется — его можно перезапустить, поэтому полоса «0%».
  assert.match(G('midBarF').style.width, /^0%?$/);
});

console.log('\nОбратная связь во время прогона');
t('длительность читается по-человечески', () => {
  assert.strictEqual(api.dur(0), '0с');
  assert.strictEqual(api.dur(8400), '8с');
  assert.strictEqual(api.dur(59_000), '59с');
  assert.strictEqual(api.dur(80_000), '1:20');
  assert.strictEqual(api.dur(725_000), '12:05');
  assert.strictEqual(api.dur(-500), '0с', 'отрицательное время не должно вылезать');
});
t('обрабатываемый товар отличается от стоящих в очереди', () => {
  st.items = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  st.results = [ok(), null, null];
  st.running = true; st.runIdx = 1;
  assert.strictEqual(api.statusOf(1).cls, 'run', 'активный должен быть run');
  assert.strictEqual(api.statusOf(1).txt, 'обрабатывается');
  assert.strictEqual(api.statusOf(2).cls, 'pd', 'следующий — всё ещё в очереди');
  assert.strictEqual(api.statusOf(0).cls, 'ok', 'готовый не меняется');
});
t('вне прогона активного товара нет', () => {
  st.running = false; st.runIdx = -1;
  assert.strictEqual(api.statusOf(1).cls, 'pd');
});
t('строка прогресса показывает остаток по фактической скорости', () => {
  st.running = true; st.runIdx = 1;
  st.runT0 = Date.now() - 4000;      // 4 с на 1 готовый товар
  api.renderRunline();
  const h = G('runline').innerHTML;
  assert.strictEqual(G('runline').style.display, 'flex');
  assert.match(h, /Обрабатываем/);
  assert.match(h, /2 из 3/, 'должен показывать номер текущего товара');
  assert.match(h, /осталось ~8с/, 'по 4с на товар и 2 осталось → ~8с. Получено: ' + h);
  assert.match(h, /flake spinning/, 'снежинка должна вращаться');
});
t('заливка кнопки отражает долю выполненного', () => {
  assert.strictEqual(G('rbFill').style.width, '33%');
});
t('после прогона строка и заливка гаснут', () => {
  st.running = false;
  api.renderRunline();
  assert.strictEqual(G('runline').style.display, 'none');
  assert.strictEqual(G('rbFill').style.width, '0');
});
t('в списке у активного товара своя разметка', () => {
  st.running = true; st.runIdx = 1;
  api.renderList();
  assert.match(G('midList').innerHTML, /class="ri s-run/, 'нужен класс s-run для подсветки');
  st.running = false; st.runIdx = -1;
});

console.log('\nТема оформления');
t('по умолчанию светлая', () => {
  localStorage.removeItem('enricher.theme');
  api.initTheme();
  assert.strictEqual(document.documentElement.getAttribute('data-theme'), 'light');
  assert.strictEqual(G('themeIcon').textContent, '☾');
});
t('переключение сохраняется', () => {
  api.toggleTheme();
  assert.strictEqual(document.documentElement.getAttribute('data-theme'), 'dark');
  assert.strictEqual(localStorage.getItem('enricher.theme'), 'dark');
  assert.strictEqual(G('themeIcon').textContent, '☀');
  api.initTheme();
  assert.strictEqual(document.documentElement.getAttribute('data-theme'), 'dark', 'выбор должен переживать перезагрузку');
});
t('обратно на светлую', () => {
  api.toggleTheme();
  assert.strictEqual(document.documentElement.getAttribute('data-theme'), 'light');
  assert.strictEqual(localStorage.getItem('enricher.theme'), 'light');
});
t('системная тёмная уважается при первом заходе', () => {
  localStorage.removeItem('enricher.theme');
  const real = globalThis.window.matchMedia;
  globalThis.window.matchMedia = () => ({ matches: true });
  try { api.initTheme(); } finally { globalThis.window.matchMedia = real; }
  assert.strictEqual(document.documentElement.getAttribute('data-theme'), 'dark');
});

console.log('\nВыбор модели без справочника цен');
t('справочник не загрузился — id вводится вручную', () => {
  // openrouter.ai недоступен, allModels пуст. Работа не должна вставать:
  // серверу нужен только id модели, цена придёт по факту в usage ответа.
  st.allModels = [];
  G('msrch').value = 'deepseek/deepseek-v3.2';
  api.renderModelList([]);
  assert.match(G('mdrop').innerHTML, /Использовать «deepseek\/deepseek-v3\.2» как есть/);
});
t('мусор вместо id вручную не предлагается', () => {
  st.allModels = [];
  G('msrch').value = 'холодильник';
  api.renderModelList([]);
  assert.doesNotMatch(G('mdrop').innerHTML, /как есть/);
  assert.match(G('mdrop').innerHTML, /Список моделей не загрузился/);
});
t('выбранная вручную модель доезжает до запуска', () => {
  st.allModels = [];
  api.pick('deepseek/deepseek-v3.2');
  assert.strictEqual(st.selModel.id, 'deepseek/deepseek-v3.2');
  assert.strictEqual(st.selModel.manual, true);
  assert.match(G('mselPrice').textContent, /по факту/, 'цену неизвестной модели выдумывать нельзя');
  st.items = [{ sku: '1', description: 'общий объем 300 л' }];
  api.syncSteps();
  assert.strictEqual(G('runBtn').disabled, false, 'запуск должен разблокироваться');
});
t('модель из справочника по-прежнему показывает цену', () => {
  st.allModels = [MODEL];
  api.pick(MODEL.id);
  assert.strictEqual(st.selModel.manual, undefined);
  assert.match(G('mselPrice').textContent, /за 1M/);
});

console.log('\nРазделы каталога');
const CATS = {
  categories: [
    { slug: 'kholodilniki', name: 'Холодильники', url: 'u1', id: 523, spec_keys: ['бренд', 'объем_общий_л'] },
    { slug: 'stiralnye_mashiny', name: 'Стиральные машины', url: 'u2', id: 467, spec_keys: ['бренд'] },
  ],
};
const CATALOG = {
  category_id: 467, category: 'Стиральные машины', slug: 'stiralnye_mashiny',
  count: 153, loaded: 2, partial: true,
  filters: [
    { code: 'brand', values: [{ value: 'Haier', count: 1 }, { value: 'LG', count: 1 }] },
    { code: 'price', min: 8999, max: 149999 },
  ],
  products: [
    { sku: '1', name: 'Стиральная машина Haier', description: 'Тип загрузки - фронтальная' },
    { sku: '2', name: 'Стиральная машина LG', description: 'Тип загрузки - вертикальная' },
  ],
};
const stubFetch = map => { globalThis.fetch = url => {
  const hit = Object.entries(map).find(([k]) => url.includes(k));
  if (!hit) return Promise.reject(new Error('нет заглушки для ' + url));
  const [, v] = hit;
  return Promise.resolve(v instanceof Error
    ? { ok: false, status: 502, json: () => Promise.resolve({ error: v.message }) }
    : { ok: true, status: 200, json: () => Promise.resolve(v) });
}; };

await tAsync('разделы приходят с сервера, а не вбиты в страницу', async () => {
  stubFetch({ '/api/categories': CATS });
  await api.loadCategories();
  const html = G('catRow').innerHTML;
  assert.match(html, /Холодильники/);
  assert.match(html, /Стиральные машины/);
  assert.match(html, /id 467/, 'id раздела виден пользователю');
  assert.match(html, /data-slug="kholodilniki"/);
});
await tAsync('сервер без разделов не ломает шаг — остаётся ввод адреса', async () => {
  stubFetch({ '/api/categories': new Error('OpenRouter недоступен') });
  await api.loadCategories();
  assert.match(G('catRow').innerHTML, /Разделы недоступны/);
  assert.match(G('catRow').innerHTML, /адрес JSON/);
});
await tAsync('выбор раздела грузит товары и показывает автофильтры', async () => {
  stubFetch({ '/api/categories': CATS, '/api/catalog': CATALOG });
  await api.loadCategories();
  st.items = []; st.results = [];
  await api.loadCategory('stiralnye_mashiny');
  assert.strictEqual(st.items.length, 2);
  assert.strictEqual(st.curCat.slug, 'stiralnye_mashiny', 'категория нужна для схемы полей на сервере');
  const hint = G('fetchHint').innerHTML;
  assert.match(hint, /из 153 в разделе/, 'итог — по всему разделу, а не по загруженному окну');
  assert.match(hint, /id 467/);
  assert.match(hint, /брендов 2/);
  assert.match(hint, /8[\s\u00a0]999/, 'цена из автофильтра (пробел неразрывный)');
});
await tAsync('ошибка раздела не затирает загруженные товары', async () => {
  stubFetch({ '/api/categories': CATS, '/api/catalog': new Error('Не удалось обойти раздел') });
  await api.loadCategories();
  st.items = [{ sku: 'x', name: 'Старый товар', description: 'общий объем 300 л' }];
  await api.loadCategory('kholodilniki');
  assert.strictEqual(st.items.length, 1, 'прежние товары должны остаться');
  assert.strictEqual(st.curCat, null);
  assert.match(G('step2').querySelector('.inline-err').textContent, /обойти раздел/);
});
globalThis.fetch = () => Promise.reject(new Error('сеть в тесте отключена'));


console.log(`\n✅ ${n} проверок интерфейса пройдено\n`);
