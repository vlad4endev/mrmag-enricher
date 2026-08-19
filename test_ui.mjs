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

const groups = { '.cnt-grid .cnt-btn': [], '.fbtn': [], '.rtab': [], '.mitem': [], '.page': [], '.ntab': [] };
for (const n of ['1', '10', '50', '100', '500']) { const e = new El('cnt' + n); e.dataset.n = n; groups['.cnt-grid .cnt-btn'].push(e); }
for (const f of ['all', 'thin', 'warn', 'err', 'conf'])  { const e = new El('f' + f);  e.dataset.f = f; groups['.fbtn'].push(e); }
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
// Ответ сервера интерфейс читает текстом — заглушки собираем так же.
const reply = (data, ok = true, status = ok ? 200 : 500) =>
  Promise.resolve({ ok, status, text: () => Promise.resolve(typeof data === 'string' ? data : JSON.stringify(data)) });
globalThis.URL = { createObjectURL: () => 'blob:', revokeObjectURL: () => {} };
/**
 * Заглушка фонового прогона. Цикл по товарам считает сервер (POST /api/jobs и
 * опрос состояния), поэтому вкладка проверяется как его клиент: задача ставится,
 * а опрос отдаёт результаты. tail — сколько товаров ещё не обработано: дырка в
 * конце ответа, по ней клиент понимает, докуда двигать курсор.
 */
function fakeJobs(make, { status = 'done', tail = 0, id = 'job-test', seed = null } = {}) {
  let job = seed, polls = 0;
  const at = () => (typeof status === 'function' ? status(polls) : status);
  const fn = (url, opts) => {
    if (url === '/api/jobs' && opts?.method === 'POST') {
      job = JSON.parse(opts.body);
      return reply({ id, status: 'running', total: job.products.length, done: 0, indices: job.indices });
    }
    if (url.startsWith(`/api/jobs/${id}/stop`)) { fn.stopped = true; return reply({ id, status: 'running' }); }
    if (url.startsWith(`/api/jobs/${id}`)) {
      const from = Number(new URLSearchParams(url.split('?')[1] || '').get('from') || 0);
      const st = at();
      polls++;
      // Пока прогон идёт, готово столько, сколько успел сервер: последний
      // опрос отдаёт всё.
      const hole = st === 'running' ? Math.max(tail, 1) : tail;
      const results = job.products.map((p, k) => k < job.products.length - hole ? make(p, k) : null);
      const done = results.filter(Boolean).length;
      return reply({
        id, status: st, model: job.model, total: results.length, done, indices: job.indices,
        from, results: results.slice(from), products: job.products,
        started_at: 1000, finished_at: 2000,
        usage: {
          prompt_tokens: 0, completion_tokens: 0, cost: 0,
          ok:   results.filter(r => r?.enriched).length,
          skip: results.filter(r => r?.skipped).length,
          err:  results.filter(r => r && !r.enriched && !r.skipped).length,
        },
      });
    }
    if (url === '/api/jobs') return reply({ jobs: job ? [{ id, status: at() }] : [] });
    return Promise.reject(new Error(`неожиданный запрос ${url}`));
  };
  fn.job = () => job;
  return fn;
}
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
export const api={syncSteps,setCnt,setCntFree,applyCnt,applySource,setSource,pickDataCat,renderDataCats,runCat,readProd,renderList,statusOf,selectResult,renderDetail,plural,
  renderEstimate,setFilter,stepError,pick,sumRun,renderFoot,clearResults,restoreResults,saveResults,
  downloadAll,downloadCategoryFiles,downloadV2,initTheme,toggleTheme,applyTheme,dur,renderRunline,
  loadCategories,catOf,renderModelList,filterModels,
  applyDates,clearDates,renderDates,passesFilter,queued,onProdInput,apiJson,run,
  stopJob,follow,attachJob,resumeJob,applyJob,finishRun};
export const st={get items(){return items},set items(v){items=v},
  get srcItems(){return srcItems},set srcItems(v){srcItems=v},
  get pickCat(){return pickCat},set pickCat(v){pickCat=v},get selCnt(){return selCnt},get results(){return results},
  set results(v){results=v},get selModel(){return selModel},
  get allModels(){return allModels},set allModels(v){allModels=v},
  get curIdx(){return curIdx},get filter(){return filter},
  get running(){return running},set running(v){running=v},
  get runIdx(){return runIdx},set runIdx(v){runIdx=v},
  get categories(){return categories},set categories(v){categories=v},
  set schemas(v){schemas=v},
  set runT0(v){runT0=v},
  get quality(){return quality},set quality(v){quality=v},
  get runStore(){return runStore},
  get jobId(){return jobId},set jobId(v){jobId=v},
  get jobPos(){return jobPos},set jobPos(v){jobPos=v},
  get following(){return following},set following(v){following=v},
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
t('спор текста с атрибутами виден до прогона', () => {
  // conflicts приходят из /api/quality вместе с ok/reason: это свойство
  // исходных данных, и знать его надо ДО того, как потрачены деньги.
  st.items = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  st.results = [];
  st.quality = [
    { ok: true },
    { ok: true, conflicts: [{ field: 'высота_мм', text: 1947, attr: 'Высота холодильника: От 181 до 190 см' }] },
    { ok: true, conflicts: [] },
  ];
  api.setFilter(F('all'));
  api.renderList();
  assert.strictEqual(F('conf').textContent, 'Ошибки каталога 1');
  api.setFilter(F('conf'));
  assert.deepStrictEqual(api.queued(), [1]);
  assert.match(G('midList').innerHTML, /каталог противоречит себе/, 'причина видна в строке');
  api.setFilter(F('all'));
});
t('карточка необработанного товара объясняет, что именно спорит', () => {
  st.items = [{ name: 'A', description: 'Высота 194.7 см' }];
  st.results = [];
  st.quality = [{ ok: true, conflicts: [{ field: 'высота_мм', text: 1947, attr: 'Высота холодильника: От 181 до 190 см' }] }];
  api.selectResult(0);
  const html = G('detail').innerHTML;
  assert.match(html, /Каталог противоречит сам себе \(1\)/);
  assert.match(html, /1947/);
  assert.match(html, /От 181 до 190 см/, 'видно обе стороны спора, а не только вердикт');
  assert.match(html, /Товар ещё не обработан/, 'спор показан вместе с обычным содержимым карточки');
});
t('без спора блок не появляется', () => {
  st.quality = [{ ok: true, conflicts: [] }];
  api.selectResult(0);
  assert.ok(!/противоречит/.test(G('detail').innerHTML));
  st.quality = [];
  api.selectResult(0);
  assert.ok(!/противоречит/.test(G('detail').innerHTML), 'старый ответ сервера без поля conflicts не должен ронять карточку');

  // Возвращаем состояние, на котором стоит следующая проверка: набор тестов
  // идёт по одному и тому же интерфейсу, а не пересоздаёт его на каждый случай.
  st.items = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  st.quality = [{ ok: true }, { ok: false, reason: 'нет ни description, ни annotation' }, { ok: false, reason: 'текст 12 симв.' }];
  api.renderList();
  api.setFilter(F('thin'));
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
t('выбранная категория уходит на сервер одна на весь прогон', () => {
  api.setSource([{ name: 'A', category: 'Холодильники' }, { name: 'B', category: 'Посуда' }]);
  assert.strictEqual(api.runCat(), undefined, 'ничего не выбрано — схему подбирает сервер по товару');
  api.pickDataCat('Холодильники');
  assert.strictEqual(api.runCat(), 'Холодильники');
  api.pickDataCat('');
  assert.strictEqual(api.runCat(), '', '«без категории» — сервер вернётся к категории товара');
  api.pickDataCat(null);
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
t('описание, добранное из сети, показывает источник, а не выдаёт его за свой', () => {
  st.results = [{ ...ok(), source: 'https://shop.example/card?utm=1' }];
  api.renderDetail();
  const h = G('detail').innerHTML;
  assert.match(h, /добрано из сети/);
  assert.match(h, /shop\.example<\/a>/, 'в карточке домен, а не адрес целиком');
  assert.match(h, /href="https:\/\/shop\.example\/card\?utm=1"/);
});
t('источник уезжает в выгрузку JSON', () => {
  let captured = null;
  const RealBlob = globalThis.Blob;
  globalThis.Blob = class { constructor(p) { captured = p[0]; } };
  try { api.downloadAll('json'); } finally { globalThis.Blob = RealBlob; }
  assert.strictEqual(JSON.parse(captured).items[0].source_url, 'https://shop.example/card?utm=1');
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
// Выгрузка читает и окно (items/results), и хранилище прогона: тест, который
// выставляет окно напрямую, обязан начинать с пустого хранилища — иначе в файл
// приедут товары предыдущей проверки.
const setWindow = (its, res) => { st.runStore.clear(); st.items = its; st.results = res; };

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

await tAsync('одна категория выгружается парой products/filters с её id', async () => {
  st.categories = [{ slug: 'kholodilniki', name: 'Холодильники', id: 523, url: 'u1' }];
  setWindow([{ sku: '1', name: 'A', category: 'Холодильники' }, { sku: '2', name: 'B', category: 'Холодильники' }],
    [{ enriched: { specs: {}, warnings: [] }, iT: 10, oT: 5, cost: 0.001 }, null]);

  const realFetch = globalThis.fetch;
  globalThis.fetch = () => reply({ category_id: 523, products_total: 2, filters: [] });
  let files;
  try { files = await catchFiles(() => api.downloadCategoryFiles()); }
  finally { globalThis.fetch = realFetch; }

  // id раздела — из справочника с сервера, по названию категории товара.
  assert.deepStrictEqual(files.map(f => f.name), ['products_523.json', 'filters_523.json']);
  const products = JSON.parse(files[0].body);
  assert.strictEqual(products.length, 2, 'в файл идут все загруженные товары, не только обработанные');
  assert.ok(products[0].enriched, 'обогащённый товар несёт enriched');
  assert.strictEqual(products[0]._meta.cost_usd, 0.001);
  assert.strictEqual(products[1].enriched, null, 'необработанный — enriched: null, как в файле из CLI');
});

await tAsync('товары из фида идут одной парой файлов, фильтры считает сервер', async () => {
  st.categories = [{ slug: 'kholodilniki', name: 'Холодильники', id: 523, url: 'u1' }];
  st.schemas = { posuda: { id: null, name: 'Посуда' } };
  setWindow([
    { sku: '1', name: 'Холодильник', category: 'Холодильники' },
    { sku: '2', name: 'Кастрюля',    category: 'Посуда' },
  ], [null, null]);

  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    asked.push(JSON.parse(opts.body));
    return reply({ category_id: null, filters: [] });
  };
  let files;
  try { files = await catchFiles(() => api.downloadCategoryFiles()); }
  finally { globalThis.fetch = realFetch; }

  assert.deepStrictEqual(files.map(f => f.name), ['products_all.json', 'filters_all.json'],
    'прогон — одна пара файлов; на нескольких разделах id в имени соврал бы, поэтому all');
  assert.strictEqual(asked.length, 1, 'фильтры считает сервер, а не копия buildFilters в браузере');
  assert.strictEqual(asked[0].products.length, 2, 'в один файл идут товары всех разделов');
  assert.strictEqual(asked[0].category_id, null, 'склеенному набору нельзя приписать id одного из разделов');
});

await tAsync('окно сузилось после прогона — в файл идёт весь прогон', async () => {
  // Тот самый случай: 259 товаров обработали, потом открыли один — в файле
  // оказывался он один, потому что выгрузка читала окно, а не прогон.
  st.curCat = null; st.categories = []; st.schemas = {};
  st.runStore.clear();
  st.allModels = [MODEL]; api.pick(MODEL.id);
  api.setSource([{ sku: '1', name: 'A', category: 'Холодильники' },
                 { sku: '2', name: 'B', category: 'Холодильники' },
                 { sku: '3', name: 'C', category: 'Холодильники' }]);

  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeJobs(() => ({ enriched: { specs: { цвет: 'белый' }, warnings: [] },
    iT: 10, oT: 5, cost: 0.001 }));
  try { await api.run(); } finally { globalThis.fetch = realFetch; }
  assert.strictEqual(st.results.filter(Boolean).length, 3, 'прогон прошёл по всем трём');

  api.setCnt(CNT('1'));
  assert.strictEqual(st.items.length, 1, 'окно сузилось до одного товара');

  globalThis.fetch = () => reply({ category_id: null, filters: [] });
  let files;
  try { files = await catchFiles(() => api.downloadCategoryFiles()); }
  finally { globalThis.fetch = realFetch; }

  const products = JSON.parse(files[0].body);
  assert.strictEqual(products.length, 3, 'в файле весь прогон, а не открытый товар');
  assert.ok(products.every(p => p.enriched), 'у каждого свой результат');
  assert.deepStrictEqual(products.map(p => p.sku), ['1', '2', '3'], 'товары не перепутались местами');
  api.setCnt(CNT('10'));
});

await tAsync('сбой фильтров не оставляет половину пары', async () => {
  setWindow([{ sku: '1', name: 'X', category: 'Посуда' }], [null]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => reply({ error: 'сервер лёг' }, false);
  let files;
  try { files = await catchFiles(() => api.downloadCategoryFiles()); }
  finally { globalThis.fetch = realFetch; }
  assert.strictEqual(files.length, 0, 'products без filters выгружать нельзя');
});

console.log('\nВыгрузка JSON v2');
await tAsync('три файла: категории, фасеты диапазонами и товары', async () => {
  st.categories = [{ slug: 'kholodilniki', name: 'Холодильники', id: 523, url: 'u' }];
  setWindow([
    { sku: '1', name: 'Холодильник A', category: 'Холодильники' },
    { sku: '2', name: 'Холодильник B', category: 'Холодильники' },
    { sku: '3', name: 'Холодильник C', category: 'Холодильники' },   // без прогона
  ], [
    { enriched: { specs: { цвет: 'белый' }, warnings: [] } },
    { enriched: { specs: { цвет: 'чёрный' }, warnings: [] } },
    null,
  ]);

  let sent = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    sent = { url, body: JSON.parse(opts.body) };
    return reply({
      filters: [{ name: 'Цвет', value: ['белый', 'чёрный'] }],
      products: [{ id: 1, name: 'Холодильник A', meta_keywords: '', description_html: '<p>a</p>', filters: { Цвет: 'белый' } }],
    });
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

console.log('\nСправочник разделов');
const CATS = {
  categories: [
    { slug: 'kholodilniki', name: 'Холодильники', url: 'u1', id: 523, spec_keys: ['бренд', 'объем_общий_л'] },
    { slug: 'stiralnye_mashiny', name: 'Стиральные машины', url: 'u2', id: 467, spec_keys: ['бренд'] },
  ],
};
const stubFetch = map => { globalThis.fetch = url => {
  const hit = Object.entries(map).find(([k]) => url.includes(k));
  if (!hit) return Promise.reject(new Error('нет заглушки для ' + url));
  const [, v] = hit;
  return v instanceof Error ? reply({ error: v.message }, false, 502) : reply(v);
}; };

await tAsync('справочник разделов приходит с сервера, а не вбит в страницу', async () => {
  st.categories = []; st.schemas = {};
  stubFetch({ '/api/categories': CATS });
  await api.loadCategories();
  assert.deepStrictEqual(st.categories.map(c => c.slug), ['kholodilniki', 'stiralnye_mashiny']);
});
await tAsync('без справочника интерфейс работает — он нужен только именам файлов', async () => {
  st.categories = [];
  stubFetch({ '/api/categories': new Error('сервер лёг') });
  await api.loadCategories();
  st.items = [{ sku: '1', name: 'X', category: 'Холодильники' }];
  assert.strictEqual(api.catOf(st.items[0]).id, null, 'без id раздела файл назовётся по all');
  assert.strictEqual(api.catOf(st.items[0]).name, 'Холодильники', 'название берётся у товара');
});
globalThis.fetch = () => Promise.reject(new Error('сеть в тесте отключена'));

console.log('\nПрогон считает сервер, а не вкладка');
t('первый заход без сохранений ничего не ломает', () => {
  // Падение здесь обрывало весь init — вместе с подхватом идущего прогона.
  localStorage.removeItem('enricher.lastRun');
  api.restoreResults();
});

// Раньше цикл по товарам крутила эта страница: закрытая вкладка обрывала работу
// на середине. Теперь она ставит задачу и опрашивает прогресс.
const THREE = () => [{ sku: '1', name: 'A', category: 'Холодильники' },
                     { sku: '2', name: 'B', category: 'Холодильники' },
                     { sku: '3', name: 'C', category: 'Холодильники' }];
const DONE = () => ({ enriched: { specs: { цвет: 'белый' }, warnings: [] }, iT: 10, oT: 5, cost: 0.001 });

await tAsync('вкладка ставит задачу на сервер и помнит её id, пока она идёт', async () => {
  st.runStore.clear();
  st.allModels = [MODEL]; api.pick(MODEL.id);
  api.setSource(THREE());

  let idWhileRunning = null;
  const f = fakeJobs(() => { idWhileRunning = localStorage.getItem('enricher.jobId'); return DONE(); });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f;
  try { await api.run(); } finally { globalThis.fetch = realFetch; }

  assert.strictEqual(f.job().model, MODEL.id, 'модель уходит на сервер, а не остаётся в браузере');
  assert.deepStrictEqual(f.job().indices, [0, 1, 2], 'по ним результат вернётся в свою строку');
  assert.strictEqual(f.job().products.length, 3);
  assert.strictEqual(idWhileRunning, 'job-test', 'id сохранён сразу: без него закрытую вкладку не вернуть к прогону');
  assert.strictEqual(localStorage.getItem('enricher.jobId'), null, 'прогон кончился — следить больше не за чем');
  assert.strictEqual(st.results.filter(Boolean).length, 3);
  assert.strictEqual(st.running, false);
});

await tAsync('необработанный хвост не выдаётся за готовый', async () => {
  st.runStore.clear();
  api.setSource(THREE());
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeJobs(DONE, { tail: 1 });
  try { await api.run(); } finally { globalThis.fetch = realFetch; }
  assert.strictEqual(st.results.filter(Boolean).length, 2, 'третий товар сервер не отдал — значит, его нет');
  assert.strictEqual(st.results[2], undefined, 'дырка в конце ответа — это очередь, а не пропуск');
});

await tAsync('прогон ещё идёт — вкладка дожидается конца и показывает прогресс', async () => {
  st.runStore.clear();
  api.setSource(THREE());
  const realFetch = globalThis.fetch;
  // Первый опрос застаёт прогон в работе, следующий — законченным.
  globalThis.fetch = fakeJobs(DONE, { status: n => (n === 0 ? 'running' : 'done') });
  const run = api.run();
  // Пока опрос в паузе, интерфейс уже показывает работу и предлагает остановку.
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(st.running, true);
  api.renderRunline();
  assert.match(G('runline').innerHTML, /Остановить/, 'остановка должна быть под рукой');
  assert.match(G('runline').innerHTML, /закрыть/, 'вкладку закрывать можно — об этом надо сказать');
  api.syncSteps();
  assert.strictEqual(G('runBtn').disabled, false, 'та же кнопка останавливает');
  await run;
  assert.strictEqual(st.results.filter(Boolean).length, 3, 'дождались всех');
  assert.strictEqual(st.running, false);
});

await tAsync('во время прогона кнопка останавливает, а не ставит второй', async () => {
  const realFetch = globalThis.fetch;
  const f = fakeJobs(DONE);
  globalThis.fetch = f;
  st.running = true; st.jobId = 'job-test';
  try { await api.run(); } finally { globalThis.fetch = realFetch; st.running = false; st.jobId = null; }
  assert.strictEqual(f.stopped, true, 'нажали во время работы — значит, остановить');
  assert.strictEqual(f.job(), null, 'второй прогон по тем же товарам — двойная оплата');
});

await tAsync('открыли страницу заново — результат забирается с сервера', async () => {
  // Прогон закончился, пока вкладка была закрыта. Своих товаров здесь нет —
  // очистили localStorage или зашли с другой машины: берём их из прогона.
  st.runStore.clear();
  api.setSource([]);
  st.results = [];
  localStorage.setItem('enricher.jobId', 'job-test');
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeJobs(DONE, { seed: { model: MODEL.id, products: THREE(), indices: [4, 9, 11] } });
  try { await api.resumeJob(); } finally { globalThis.fetch = realFetch; }

  assert.strictEqual(st.items.length, 3, 'товары пришли из прогона');
  assert.strictEqual(st.results.filter(Boolean).length, 3, 'и результаты вместе с ними');
  assert.deepStrictEqual(st.results.map(r => r.enriched.specs.цвет), ['белый', 'белый', 'белый']);
  assert.strictEqual(st.results.length, 3,
    'индексы чужой вкладки (4, 9, 11) здесь не значат ничего — результат ложится по очереди');
});

await tAsync('прогон запустили в другом браузере — здесь виден его процесс', async () => {
  // Своего id в этой вкладке нет, но на сервере что-то идёт: показываем это,
  // иначе прогон работает вслепую.
  st.runStore.clear();
  api.setSource([]);
  st.results = [];
  localStorage.removeItem('enricher.jobId');
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeJobs(DONE, {
    status: n => (n === 0 ? 'running' : 'done'),
    seed: { model: MODEL.id, products: THREE(), indices: [0, 1, 2] },
  });
  try {
    await api.resumeJob();
    assert.strictEqual(st.jobId, 'job-test', 'идущий прогон подхвачен по списку /api/jobs');
    assert.strictEqual(st.running, true, 'и показан как идущий');
    // Опрос продолжается сам — ждём его конца, как ждал бы человек у экрана.
    const until = Date.now() + 8000;
    while (st.following && Date.now() < until) await new Promise(r => setTimeout(r, 100));
  } finally { globalThis.fetch = realFetch; }
  assert.strictEqual(st.running, false, 'прогон дошёл до конца');
  assert.strictEqual(st.results.filter(Boolean).length, 3);
});

await tAsync('прогон уже забыт сервером — сохранённое остаётся, id убирается', async () => {
  st.runStore.clear();
  api.setSource(THREE());
  localStorage.setItem('enricher.jobId', 'job-test');
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => reply({ error: 'Прогон не найден — возможно, он уже удалён' }, false, 404);
  try { await api.resumeJob(); } finally { globalThis.fetch = realFetch; }
  assert.strictEqual(localStorage.getItem('enricher.jobId'), null, 'следить не за чем — и незачем пытаться при каждом входе');
  assert.strictEqual(st.running, false);
});

console.log('\nОтвет сервера не JSON');
// Ответ не-JSON интерфейс раньше отдавал пользователю как «Unexpected token 'Т'»:
// r.json() падал раньше, чем доходило дело до проверки r.ok.
await tAsync('401 объясняет, что нужен вход, а не ломается на разборе JSON', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => reply('Требуется вход', false, 401);
  try { await api.apiJson('/api/models'); assert.fail('ошибка должна была вылететь'); }
  catch (e) { assert.match(e.message, /Требуется вход/); assert.doesNotMatch(e.message, /JSON\b.*not valid|Unexpected token/); }
  finally { globalThis.fetch = realFetch; }
});
await tAsync('504 от шлюза объясняется, а не вываливает HTML в таблицу', async () => {
  const realFetch = globalThis.fetch;
  const page = '<html>\n<head><title>504 Gateway Time-out</title></head>\n<body>\n<center><h1>504 Gateway Time-out</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>';
  globalThis.fetch = () => reply(page, false, 504);
  try { await api.apiJson('/api/enrich'); assert.fail('ошибка должна была вылететь'); }
  catch (e) {
    assert.match(e.message, /proxy_read_timeout/, 'сообщение называет причину, а не только код');
    assert.doesNotMatch(e.message, /</, 'разметка страницы шлюза в результат не попадает');
  }
  finally { globalThis.fetch = realFetch; }
});
await tAsync('свою ошибку сервера шлюзовое объяснение не подменяет', async () => {
  const realFetch = globalThis.fetch;
  // 502 отдаёт и сам сервер, когда модель не ответила: там JSON и своя причина.
  globalThis.fetch = () => reply({ error: 'таймаут 60000ms' }, false, 502);
  try { await api.apiJson('/api/enrich'); assert.fail('ошибка должна была вылететь'); }
  catch (e) { assert.strictEqual(e.message, 'таймаут 60000ms'); }
  finally { globalThis.fetch = realFetch; }
});
await tAsync('200 с пустым телом не выдаётся за успех', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => reply('');
  try { await api.apiJson('/api/categories'); assert.fail('ошибка должна была вылететь'); }
  catch (e) { assert.match(e.message, /не JSON/); }
  finally { globalThis.fetch = realFetch; }
});


console.log(`\n✅ ${n} проверок интерфейса пройдено\n`);
