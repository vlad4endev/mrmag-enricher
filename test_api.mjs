/**
 * test_api.mjs — проверка HTTP-слоя: вход, проба живости, отказы прокси,
 * валидация /api/enrich. Запуск: node test_api.mjs
 *
 * Сеть не нужна: все проверяемые ответы формируются до обращения к OpenRouter
 * и до обхода каталога. Ключ подставляется заведомо нерабочий — если какая-то
 * проверка вдруг начнёт ходить в сеть, это будет видно по ошибке авторизации.
 */

import assert from 'assert';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3400 + Math.floor(process.uptime() * 7) % 100;
// Фоновые прогоны пишутся на диск — в тесте в свой каталог, не в рабочий.
const JOBS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'enricher-jobs-'));
const SETTINGS_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'enricher-cfg-')), 'config.json');
fs.copyFileSync(path.join(ROOT, 'config.json'), SETTINGS_PATH);
const PASS = 'test-pass';
const auth = 'Basic ' + Buffer.from(`admin:${PASS}`).toString('base64');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };
const url = p => `http://127.0.0.1:${PORT}${p}`;

const srv = spawn(process.execPath, ['server.js'], {
  env: {
    ...process.env,
    OPENROUTER_API_KEY: 'sk-or-v1-test-not-a-real-key',
    APP_PASSWORD: PASS,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    PAGE_CACHE_DIR: '.page_cache',
    JOBS_DIR,
    SETTINGS_PATH,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', d => { if (/Error|error/.test(String(d))) process.stderr.write(d); });

/** Ждём, пока порт начнёт отвечать: без этого тест гонится со стартом сервера. */
async function ready(timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try { if ((await fetch(url('/healthz'))).ok) return; } catch { /* ещё не поднялся */ }
    if (Date.now() > until) throw new Error('сервер не поднялся');
    await new Promise(r => setTimeout(r, 150));
  }
}

try {
  await ready();

  console.log('\nВход');
  await t('проба живости отвечает без пароля', async () => {
    const r = await fetch(url('/healthz'));
    assert.strictEqual(r.status, 200, 'балансировщик пароля не знает');
    assert.strictEqual((await r.json()).ok, true);
  });
  await t('без пароля закрыты и страница, и API', async () => {
    for (const p of ['/', '/api/categories', '/api/models', '/api/parser', '/api/settings', '/api/catalog?category=523']) {
      assert.strictEqual((await fetch(url(p))).status, 401, `${p} должен требовать вход`);
    }
    const r = await fetch(url('/api/enrich'), { method: 'POST', body: '{}' });
    assert.strictEqual(r.status, 401, 'тратящий деньги маршрут — тем более');
  });
  await t('страница входа — HTML без системного диалога', async () => {
    const r = await fetch(url('/'));
    assert.strictEqual(r.status, 401);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    assert.equal(r.headers.get('www-authenticate'), null, 'WWW-Authenticate вызвал бы окно браузера поверх формы');
    assert.match(await r.text(), /Войти/);
  });
  await t('API предлагает Basic для скриптов', async () => {
    const r = await fetch(url('/api/categories'));
    assert.strictEqual(r.status, 401);
    assert.match(r.headers.get('www-authenticate') || '', /^Basic realm=/);
  });
  await t('форма входа ставит сессию', async () => {
    const r = await fetch(url('/api/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ user: 'admin', password: PASS }),
    });
    assert.strictEqual(r.status, 200);
    const setCookie = typeof r.headers.getSetCookie === 'function'
      ? (r.headers.getSetCookie()[0] || '')
      : (r.headers.get('set-cookie') || '');
    const cookie = setCookie.split(';')[0];
    assert.match(cookie, /^enricher=/);
    const page = await fetch(url('/'), { headers: { cookie } });
    assert.strictEqual(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /text\/html/);
  });
  await t('неверный пароль формы не ставит сессию', async () => {
    const r = await fetch(url('/api/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ user: 'admin', password: 'nope' }),
    });
    assert.strictEqual(r.status, 401);
    assert.equal((r.headers.getSetCookie?.() || []).length, 0, 'сессия не должна ставиться');
  });
  await t('неверный пароль не проходит', async () => {
    const bad = 'Basic ' + Buffer.from('admin:nope').toString('base64');
    assert.strictEqual((await fetch(url('/'), { headers: { authorization: bad } })).status, 401);
  });
  await t('верный пароль отдаёт страницу', async () => {
    const r = await fetch(url('/'), { headers: { authorization: auth } });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
  });

  console.log('\nРазделы');
  await t('/api/categories отдаёт оба раздела с id и полями', async () => {
    const d = await (await fetch(url('/api/categories'), { headers: { authorization: auth } })).json();
    const byId = Object.fromEntries(d.categories.map(c => [c.id, c]));
    assert.ok(byId[523] && byId[467], 'должны быть 523 и 467');
    assert.strictEqual(byId[523].slug, 'kholodilniki');
    assert.ok(byId[467].spec_keys.includes('скорость_отжима_об_мин'));
    assert.ok(!byId[467].spec_keys.includes('объем_морозильной_камеры_л'), 'схемы не должны смешиваться');
  });
  await t('/api/parser отдаёт статус поиска пустых карточек', async () => {
    const d = await (await fetch(url('/api/parser'), { headers: { authorization: auth } })).json();
    assert.strictEqual(d.enabled, true);
    assert.strictEqual(d.duckduckgo.method, 'POST');
    assert.strictEqual(d.duckduckgo.endpoint, 'html');
    assert.strictEqual(d.duckduckgo.region, 'ru-ru');
    assert.ok(d.tries >= 1);
    assert.ok(d.serpapi);
    assert.strictEqual(d.serpapi.engine, 'google');
    if (d.serpapi.has_key) assert.match(d.label, /SerpAPI/i);
    else assert.match(d.label, /DuckDuckGo/i);
  });
  await t('/api/settings отдаёт провайдеров без ключей и заготовки', async () => {
    const r = await fetch(url('/api/settings'), { headers: { authorization: auth } });
    assert.strictEqual(r.status, 200);
    const d = await r.json();
    assert.ok(d.settings.providers.some(p => p.id === 'openrouter'));
    assert.ok(d.presets.some(p => p.id === 'ollama'));
    assert.ok(d.presets.some(p => p.id === 'deepseek' && p.base_url === 'https://api.deepseek.com'));
    assert.ok(d.settings.providers.some(p => p.id === 'deepseek'));
    assert.ok(d.settings.providers.every(p => !('api_key' in p) || !p.api_key), 'секрет не должен уезжать в браузер');
    assert.strictEqual(d.conditions.items.find(i => i.id === 'mismatch_policy').value, 'flag');
    assert.ok(d.parsers.parsers.some(p => p.kind === 'duckduckgo'));
    assert.ok(d.parsers.parsers.some(p => p.kind === 'serpapi'));
    assert.ok(!JSON.stringify(d).includes('serp-secret'), 'ключ SerpAPI не должен уезжать в браузер');
    assert.ok(!('api_key' in (d.settings.search.serpapi || {})) || !d.settings.search.serpapi.api_key);
    assert.ok(!('api_key' in (d.parsers.serpapi || {})) || !d.parsers.serpapi.api_key);
  });
  await t('/api/models отдаёт DeepSeek из карточки, не дожидаясь OpenRouter', async () => {
    const t0 = Date.now();
    const r = await fetch(url('/api/models'), { headers: { authorization: auth } });
    const ms = Date.now() - t0;
    assert.strictEqual(r.status, 200, await r.clone().text());
    const d = await r.json();
    assert.ok(d.data.some(m => m.id === 'deepseek-v4-flash' && m.provider === 'deepseek'));
    assert.ok(ms < 3000, `справочник ждал сеть ${ms} мс`);
  });
  await t('PUT /api/settings сохраняет условие и не затирает ключ пустой строкой', async () => {
    const cur = await (await fetch(url('/api/settings'), { headers: { authorization: auth } })).json();
    const providers = cur.settings.providers.map(p => ({ ...p, api_key: '' }));
    const r = await fetch(url('/api/settings'), {
      method: 'PUT',
      headers: { authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providers,
        conditions: { ...cur.settings.conditions, mismatch_policy: 'strict' },
        search: cur.settings.search,
        model: cur.settings.model,
      }),
    });
    assert.strictEqual(r.status, 200, (await r.clone().text()).slice(0, 200));
    const d = await r.json();
    assert.strictEqual(d.settings.conditions.mismatch_policy, 'strict');
    const saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    assert.strictEqual(saved.conditions.mismatch_policy, 'strict');
    assert.strictEqual(saved.providers[0].api_key, '', 'пустой ключ в PATCH не должен ничего записать');
  });
  await t('PUT с некорректным URL провайдера — 400', async () => {
    const cur = await (await fetch(url('/api/settings'), { headers: { authorization: auth } })).json();
    const r = await fetch(url('/api/settings'), {
      method: 'PUT',
      headers: { authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providers: [{ ...cur.settings.providers[0], base_url: 'not-a-url' }],
      }),
    });
    assert.strictEqual(r.status, 400);
    const d = await r.json();
    assert.match(d.error, /base_url/i);
  });
  await t('неизвестный раздел — 400 со списком доступных', async () => {
    const r = await fetch(url('/api/catalog?category=zzz'), { headers: { authorization: auth } });
    assert.strictEqual(r.status, 400);
    const d = await r.json();
    assert.deepStrictEqual(d.categories, ['kholodilniki', 'stiralnye_mashiny']);
  });

  console.log('\nПрокси каталога');
  await t('чужой хост и метаданные облака не проксируются', async () => {
    for (const target of ['https://evil.example/x', 'http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:22/']) {
      const r = await fetch(url('/api/product?url=' + encodeURIComponent(target)), { headers: { authorization: auth } });
      assert.strictEqual(r.status, 403, `${target} должен быть отклонён`);
    }
  });
  await t('не-URL и не-http отклоняются', async () => {
    for (const [target, code] of [['не url', 400], ['file:///etc/passwd', 400], ['', 400]]) {
      const r = await fetch(url('/api/product?url=' + encodeURIComponent(target)), { headers: { authorization: auth } });
      assert.strictEqual(r.status, code, `${target} → ожидался ${code}`);
    }
  });

  console.log('\nКачество исходных данных');
  const postQuality = body => fetch(url('/api/quality'), {
    method: 'POST',
    headers: { authorization: auth, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  await t('без пароля не считает', async () => {
    assert.strictEqual((await fetch(url('/api/quality'), { method: 'POST', body: '{}' })).status, 401);
  });
  await t('битое тело и пустой список — 400', async () => {
    assert.strictEqual((await postQuality('{не json')).status, 400);
    assert.strictEqual((await postQuality({ products: [] })).status, 400);
  });
  await t('отвечает тем же вердиктом, с которым /api/enrich пропустит товар', async () => {
    const products = [
      { sku: '1', category: 'Холодильники', description: 'Двухкамерный холодильник, общий объем 310 л, класс A, No Frost, ширина 59.5 см, вес 66 кг' },
      { sku: '2', category: 'Холодильники' },
      { sku: '3', category: 'Холодильники', description: 'Хороший' },
    ];
    const d = await (await postQuality({ products })).json();
    assert.strictEqual(d.quality.length, 3);
    assert.strictEqual(d.quality[0].ok, true, 'из этого текста есть что извлекать');
    assert.strictEqual(d.quality[1].ok, false);
    assert.match(d.quality[1].reason, /нет ни description/);
    assert.strictEqual(d.quality[2].ok, false, 'семь букв — не характеристики');

    // Тот же товар в /api/enrich должен не тратить деньги, а вернуться пропуском.
    const e = await (await fetch(url('/api/enrich'), {
      method: 'POST', headers: { authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', product: products[1] }),
    })).json();
    assert.strictEqual(e.enriched, null);
    assert.strictEqual(e.skipped, d.quality[1].reason, 'фильтр и прогон обязаны говорить одно и то же');
  });

  await t('спор текста с атрибутами доезжает до интерфейса без прогона', async () => {
    // Товар 561253 из products_523.json: в тексте 194,7 см, а в фильтре
    // магазина полка «От 181 до 190 см». Ошибка каталога, а не модели.
    const products = [
      { sku: '561253', category: 'Холодильники',
        description: 'Двухкамерный холодильник, общий объем 310 л, No Frost, высота 194.7 см, ширина 59.5 см',
        attributes: [{ name: 'Высота холодильника', value: 'От 181 до 190 см' }] },
      { sku: 'ok', category: 'Холодильники',
        description: 'Двухкамерный холодильник, общий объем 310 л, No Frost, высота 185 см, ширина 59.5 см',
        attributes: [{ name: 'Высота холодильника', value: 'От 181 до 190 см' }] },
    ];
    const d = await (await postQuality({ products })).json();
    assert.strictEqual(d.quality[0].conflicts.length, 1);
    assert.strictEqual(d.quality[0].conflicts[0].field, 'высота_мм');
    assert.strictEqual(d.quality[0].conflicts[0].text, 1947);
    assert.match(d.quality[0].conflicts[0].attr, /От 181 до 190 см/);
    assert.strictEqual(d.quality[0].ok, true, 'спор источников не повод не обогащать товар');
    assert.deepStrictEqual(d.quality[1].conflicts, [], 'согласованный товар в список не попадает');
  });

  console.log('\nФильтры по списку товаров');
  const postFilters = body => fetch(url('/api/filters'), {
    method: 'POST',
    headers: { authorization: auth, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  await t('без пароля не считает', async () => {
    const r = await fetch(url('/api/filters'), { method: 'POST', body: '{}' });
    assert.strictEqual(r.status, 401);
  });
  await t('битое тело и пустой список — 400', async () => {
    assert.strictEqual((await postFilters('{не json')).status, 400);
    assert.strictEqual((await postFilters({ products: [] })).status, 400);
    assert.strictEqual((await postFilters({})).status, 400);
  });
  await t('фильтры считаются той же функцией, что пишет файл', async () => {
    const r = await postFilters({
      category_id: 523, category: 'Холодильники', url: 'https://mrmag.ru/shop/kholodilniki',
      products: [
        { sku: '1', brand: 'DON', brand_slug: 'don', price: 30000 },
        { sku: '2', brand: 'DON', brand_slug: 'don', price: 45000 },
        { sku: '3', brand: 'LG',  brand_slug: 'lg',  price: 90000 },
        { sku: '4', price: 0 },
      ],
    });
    assert.strictEqual(r.status, 200);
    const d = await r.json();
    assert.strictEqual(d.category_id, 523);
    assert.strictEqual(d.products_total, 4);
    const brand = d.filters.find(f => f.code === 'brand');
    const price = d.filters.find(f => f.code === 'price');
    assert.deepStrictEqual(brand.values.map(v => v.value), ['DON', 'LG'], 'сначала частые бренды');
    assert.strictEqual(brand.without_value, 1, 'товар без бренда должен быть посчитан');
    assert.strictEqual(price.min, 30000);
    assert.strictEqual(price.max, 90000);
    assert.strictEqual(price.without_price, 1, 'цена 0 — это отсутствие цены');
  });

  console.log('\nВыгрузка v2');
  const postV2 = body => fetch(url('/api/export-v2'), {
    method: 'POST',
    headers: { authorization: auth, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  await t('без пароля не считает', async () => {
    assert.strictEqual((await fetch(url('/api/export-v2'), { method: 'POST', body: '{}' })).status, 401);
  });
  await t('битое тело, пустой список и список без прогона — 400', async () => {
    assert.strictEqual((await postV2('{не json')).status, 400);
    assert.strictEqual((await postV2({ products: [] })).status, 400);
    assert.strictEqual((await postV2({ products: [{ sku: '1', enriched: null }] })).status, 400,
      'выгрузка без обогащения — пустой файл, а не успех');
  });
  await t('фасеты и товары считает buildV2 на сервере', async () => {
    const r = await postV2({ products: [
      { sku: '1', name: 'A', enriched: { specs: { цвет: 'белый', объем_л: 310 }, short_description: 'Коротко', seo_keywords: ['к'] } },
      { sku: '2', name: 'B', enriched: { specs: { цвет: 'чёрный', объем_л: 225 }, short_description: 'Коротко', seo_keywords: [] } },
    ] });
    assert.strictEqual(r.status, 200);
    const d = await r.json();
    assert.deepStrictEqual(d.filters.map(f => f.name), ['Цвет', 'Объем, л']);
    assert.strictEqual(d.products.length, 2);
    assert.strictEqual(d.products[0].id, 1);
    assert.ok(d.filters.find(f => f.name === 'Цвет').value.includes(d.products[0].filters['Цвет']));
  });
  await t('категория 523 — семь полей, хладагент и вес не в filters', async () => {
    const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'data_523.json'), 'utf8'))
      .find(p => p.id === 260);
    assert.ok(src, 'в data_523.json нет 260');
    const r = await postV2({ category: 523, products: [src] });
    assert.strictEqual(r.status, 200);
    const d = await r.json();
    assert.deepStrictEqual(Object.keys(d.products[0]), [
      'id', 'name', 'meta_keywords', 'description_html', 'annotation_html', 'filters', 'web_info',
    ]);
    assert.ok(!('Хладагент' in d.products[0].filters));
    assert.ok(!('Вес, кг' in d.products[0].filters));
    assert.ok(d.products[0].annotation_html);
    assert.ok(!d.products[0].description_html.includes('<h1'));
    assert.ok(!d.filters.some(f => /Хладагент|Вес/.test(f.name)));
  });
  await t('прогон целиком — тело больше мегабайта не отбивается', async () => {
    // 259 обогащённых товаров — это ~1,5 МБ: на общем лимите readBody пакетная
    // выгрузка падала «Тело запроса слишком велико».
    const filler = 'о'.repeat(6000);
    const products = Array.from({ length: 259 }, (_, i) => ({
      sku: String(i + 1), name: `Товар ${i + 1}`,
      enriched: { specs: { цвет: 'белый' }, short_description: filler },
    }));
    assert.ok(JSON.stringify({ products }).length > 1_000_000, 'проверка бессмысленна на теле меньше лимита');
    const r = await postV2({ products });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).products.length, 259);
  });

  console.log('\nВыгрузка заказчика');
  const postExport = body => fetch(url('/api/export'), {
    method: 'POST',
    headers: { authorization: auth, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  await t('без пароля не считает', async () => {
    assert.strictEqual((await fetch(url('/api/export'), { method: 'POST', body: '{}' })).status, 401);
  });
  await t('битое тело и пустой список — 400', async () => {
    assert.strictEqual((await postExport('{не json')).status, 400);
    assert.strictEqual((await postExport({ products: [] })).status, 400);
  });
  await t('товар без характеристик — 400 и held', async () => {
    const r = await postExport({
      category: 467,
      products: [{ sku: '1', name: 'Стиральная машина X', annotation: '', description: '' }],
    });
    assert.strictEqual(r.status, 400);
    const d = await r.json();
    assert.ok(Array.isArray(d.held) && d.held.length === 1);
  });
  await t('ATLANT 11391 — семь полей и бакеты', async () => {
    const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'data_467.json'), 'utf8'))
      .find(p => p.id === 11391);
    assert.ok(src, 'в data_467.json нет 11391');
    const r = await postExport({ category: 467, products: [{ ...src, sku: String(src.id) }] });
    assert.strictEqual(r.status, 200);
    const d = await r.json();
    assert.strictEqual(d.products.length, 1);
    assert.deepStrictEqual(Object.keys(d.products[0]), [
      'id', 'name', 'meta_keywords', 'description_html', 'annotation_html', 'filters', 'web_info',
    ]);
    assert.strictEqual(d.products[0].id, 11391);
    assert.strictEqual(d.products[0].name, src.name);
    assert.match(d.products[0].annotation_html, /ATLANT/);
    assert.ok(Array.isArray(d.products[0].filters['Высота, см']));
    assert.ok(!d.products[0].description_html.includes('<h1'));
  });
  await t('без раздела — справочник из имени стиральной машины', async () => {
    const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'data_467.json'), 'utf8'))
      .find(p => p.id === 11391);
    const r = await postExport({
      category: 'без раздела',
      products: [{ ...src, sku: String(src.id), category: '' }],
    });
    assert.strictEqual(r.status, 200);
    const d = await r.json();
    assert.strictEqual(d.products[0].id, 11391);
    assert.ok(d.products[0].annotation_html);
  });
  await t('раздел без справочника не ломает выгрузку', async () => {
    const r = await postExport({
      category: 929,
      products: [{
        sku: '1', name: 'Вытяжка X',
        enriched: { specs: { цвет: 'белый' }, short_description: 'Коротко', seo_keywords: [] },
      }],
    });
    assert.strictEqual(r.status, 200);
    const d = await r.json();
    assert.ok(d.products.length);
    assert.deepStrictEqual(Object.keys(d.products[0]), [
      'id', 'name', 'meta_keywords', 'description_html', 'annotation_html', 'filters', 'web_info',
    ]);
    assert.match(d.products[0].annotation_html, /цвет: белый/i);
    assert.ok(Array.isArray(d.products[0].filters['Цвет']));
  });

  console.log('\nВалидация обогащения');
  const post = body => fetch(url('/api/enrich'), {
    method: 'POST',
    headers: { authorization: auth, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  await t('битое тело, нет модели, нет товара — 400', async () => {
    assert.strictEqual((await post('{не json')).status, 400);
    assert.strictEqual((await post({ product: {} })).status, 400);
    assert.strictEqual((await post({ model: 'x/y' })).status, 400);
  });
  await t('товар без пригодного текста не уходит в модель', async () => {
    // Ответ приходит до обращения к OpenRouter — иначе на нерабочем ключе была бы ошибка.
    const r = await post({ model: 'deepseek/deepseek-v3.2', product: { description: 'Холодильник белый' } });
    assert.strictEqual(r.status, 200);
    const d = await r.json();
    assert.strictEqual(d.enriched, null);
    assert.match(d.skipped, /ни одной распознанной/);
    assert.strictEqual(d.usage.cost, 0, 'за пропуск платить нечем');
  });

  console.log('\nФоновый прогон');
  // Товар без пригодного текста пропускается до обращения к OpenRouter, поэтому
  // весь жизненный цикл прогона проверяется без сети и без денег.
  const EMPTY = [{ sku: 'a1', name: 'Холодильник' }, { sku: 'a2', name: 'Холодильник' }];
  const postJob = body => fetch(url('/api/jobs'), {
    method: 'POST',
    headers: { authorization: auth, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const getJob = (id, q = '') => fetch(url(`/api/jobs/${id}${q}`), { headers: { authorization: auth } });
  /** Ждём конца прогона: он идёт в фоне, а не в ответе на запрос. */
  const settle = async (id, timeoutMs = 20_000) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const d = await (await getJob(id, '?from=0')).json();
      if (d.status !== 'running' && d.status !== 'queued') return d;
      if (Date.now() > until) throw new Error(`прогон ${id} не закончился: ${d.status} ${d.done}/${d.total}`);
      await new Promise(r => setTimeout(r, 100));
    }
  };

  await t('без пароля прогон не поставить и не посмотреть', async () => {
    assert.strictEqual((await fetch(url('/api/jobs'), { method: 'POST', body: '{}' })).status, 401);
    assert.strictEqual((await fetch(url('/api/jobs'))).status, 401);
    assert.strictEqual((await fetch(url('/api/jobs/nope'))).status, 401);
  });
  await t('битое тело, нет модели, нет товаров, кривые indices — 400', async () => {
    assert.strictEqual((await postJob('{не json')).status, 400);
    assert.strictEqual((await postJob({ products: EMPTY })).status, 400);
    assert.strictEqual((await postJob({ model: 'x/y', products: [] })).status, 400);
    assert.strictEqual((await postJob({ model: 'x/y', products: EMPTY, indices: [0] })).status, 400);
  });
  await t('чужого прогона нет — 404, а не пустой ответ', async () => {
    assert.strictEqual((await getJob('нет-такого')).status, 404);
  });

  let jobId;
  await t('прогон отвечает сразу, а работает после ответа', async () => {
    const r = await postJob({ model: 'deepseek/deepseek-v3.2', products: EMPTY, indices: [4, 7] });
    assert.strictEqual(r.status, 202, 'клиент не ждёт конца прогона — он получает id');
    const d = await r.json();
    jobId = d.id;
    assert.ok(jobId, 'без id прогон не найти после перезагрузки страницы');
    assert.strictEqual(d.total, 2);
  });
  await t('результаты доезжают, indices возвращаются как отданы', async () => {
    const d = await settle(jobId);
    assert.strictEqual(d.status, 'done');
    assert.strictEqual(d.done, 2);
    assert.deepStrictEqual(d.indices, [4, 7], 'по ним интерфейс кладёт результат в свою строку');
    assert.strictEqual(d.results.length, 2);
    assert.ok(d.results.every(x => x.enriched === null && x.skipped), 'пустые карточки пропущены');
    assert.strictEqual(d.usage.cost, 0, 'за пропуск платить нечем');
    assert.strictEqual(d.usage.skip, 2);
  });
  await t('from отдаёт только хвост — опрос не тащит одно и то же', async () => {
    const d = await (await getJob(jobId, '?from=1')).json();
    assert.strictEqual(d.from, 1);
    assert.strictEqual(d.results.length, 1, 'первый результат у клиента уже есть');
    const all = await (await getJob(jobId, '?from=0&products=1')).json();
    assert.strictEqual(all.products.length, 2, 'товары нужны, если зашли из другого браузера');
    const bare = await (await getJob(jobId, '?from=0')).json();
    assert.strictEqual(bare.products, undefined, 'без запроса товары не гоняем');
  });
  await t('список прогонов показывает, что идёт и что прошло', async () => {
    const { jobs } = await (await fetch(url('/api/jobs'), { headers: { authorization: auth } })).json();
    const mine = jobs.find(j => j.id === jobId);
    assert.ok(mine, 'иначе прогон, запущенный в другом браузере, не найти');
    assert.strictEqual(mine.status, 'done');
    assert.strictEqual(mine.results, undefined, 'в списке — сводка, а не мегабайты результатов');
  });
  await t('остановка отвечает и на уже законченном прогоне', async () => {
    const r = await fetch(url(`/api/jobs/${jobId}/stop`), { method: 'POST', headers: { authorization: auth } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).status, 'done', 'законченный прогон не переписываем');
  });
  await t('прогон живёт на диске — перезапуск сервера его не теряет', async () => {
    const file = path.join(JOBS_DIR, `${jobId}.json`);
    assert.ok(fs.existsSync(file), 'без файла перезапуск потерял бы оплаченное');
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.strictEqual(saved.results.filter(Boolean).length, 2);
  });
  await t('удаление забирает и запись, и файл', async () => {
    const r = await fetch(url(`/api/jobs/${jobId}`), { method: 'DELETE', headers: { authorization: auth } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await getJob(jobId)).status, 404);
    assert.ok(!fs.existsSync(path.join(JOBS_DIR, `${jobId}.json`)), 'файл тоже должен уйти');
  });

  console.log('\nМаршрутизация');
  await t('неизвестный путь и метод', async () => {
    assert.strictEqual((await fetch(url('/секрет'), { headers: { authorization: auth } })).status, 404);
    const r = await fetch(url('/api/models'), { method: 'DELETE', headers: { authorization: auth } });
    assert.strictEqual(r.status, 405);
  });

  console.log('\nПерезапуск сервера доводит прерванный прогон');
  await t('прогон со статусом running продолжается с недоделанного товара', async () => {
    // Ровно то, что делает docker restart посреди прогона: половина товаров
    // обработана, статус остался running. Новый процесс обязан довести остаток.
    const id = 'resume-test';
    const half = {
      id, at: Date.now(), model: 'deepseek/deepseek-v3.2', category: null,
      status: 'running', total: 2, done: 1, indices: [0, 1], products: EMPTY,
      results: [{ enriched: null, skipped: 'пусто', iT: 0, oT: 0, cost: 0 }, null],
    };
    fs.writeFileSync(path.join(JOBS_DIR, `${id}.json`), JSON.stringify(half));

    const port2 = PORT + 1;
    const srv2 = spawn(process.execPath, ['server.js'], {
      env: { ...process.env, OPENROUTER_API_KEY: 'sk-or-v1-test-not-a-real-key', APP_PASSWORD: PASS,
             PORT: String(port2), HOST: '127.0.0.1', PAGE_CACHE_DIR: '.page_cache', JOBS_DIR, SETTINGS_PATH },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    try {
      const until = Date.now() + 20_000;
      for (;;) {
        let d = null;
        try {
          const r = await fetch(`http://127.0.0.1:${port2}/api/jobs/${id}?from=0`, { headers: { authorization: auth } });
          if (r.ok) d = await r.json();
        } catch { /* сервер ещё поднимается */ }
        if (d && d.status === 'done') {
          assert.strictEqual(d.done, 2, 'второй товар обработан уже новым процессом');
          assert.ok(d.results.every(Boolean));
          break;
        }
        if (Date.now() > until) throw new Error(`прогон не продолжился: ${d?.status} ${d?.done}/${d?.total}`);
        await new Promise(r => setTimeout(r, 150));
      }
    } finally {
      srv2.kill('SIGTERM');
    }
  });

  console.log(`\n✅ ${n} проверок API пройдено\n`);
} finally {
  srv.kill('SIGTERM');
  fs.rmSync(JOBS_DIR, { recursive: true, force: true });
}
