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

const PORT = 3400 + Math.floor(process.uptime() * 7) % 100;
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
    for (const p of ['/', '/api/categories', '/api/models', '/api/catalog?category=523']) {
      assert.strictEqual((await fetch(url(p))).status, 401, `${p} должен требовать вход`);
    }
    const r = await fetch(url('/api/enrich'), { method: 'POST', body: '{}' });
    assert.strictEqual(r.status, 401, 'тратящий деньги маршрут — тем более');
  });
  await t('браузеру предлагается Basic', async () => {
    const r = await fetch(url('/'));
    assert.match(r.headers.get('www-authenticate') || '', /^Basic realm=/);
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

  console.log('\nМаршрутизация');
  await t('неизвестный путь и метод', async () => {
    assert.strictEqual((await fetch(url('/секрет'), { headers: { authorization: auth } })).status, 404);
    const r = await fetch(url('/api/models'), { method: 'DELETE', headers: { authorization: auth } });
    assert.strictEqual(r.status, 405);
  });

  console.log(`\n✅ ${n} проверок API пройдено\n`);
} finally {
  srv.kill('SIGTERM');
}
