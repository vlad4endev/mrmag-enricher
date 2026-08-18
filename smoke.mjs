/**
 * smoke.mjs — проверка уже развёрнутого сервера. Запуск:
 *
 *   node smoke.mjs https://enricher.example.ru
 *   node smoke.mjs https://enricher.example.ru admin:пароль
 *
 * Ходит только по безопасным маршрутам: денег не тратит, каталог не обходит
 * дольше одного товара. Нужна после каждого обновления — иначе «задеплоил»
 * означает «файлы скопировались», а не «работает».
 */

const [, , base, creds] = process.argv;
if (!base) {
  console.error('Укажите адрес: node smoke.mjs https://host [user:пароль]');
  process.exit(2);
}
const root = base.replace(/\/+$/, '');
const headers = creds ? { authorization: 'Basic ' + Buffer.from(creds).toString('base64') } : {};

let failed = 0;
const check = async (name, fn) => {
  try {
    const note = await fn();
    console.log(`  ✓ ${name}${note ? ` — ${note}` : ''}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name} — ${e.message}`);
  }
};
const get = async (path, opts = {}) => {
  const r = await fetch(root + path, { headers, signal: AbortSignal.timeout(120_000), ...opts });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { r, body };
};
const need = (cond, msg) => { if (!cond) throw new Error(msg); };

console.log(`\nПроверяем ${root}\n`);

await check('жив', async () => {
  const { r, body } = await get('/healthz');
  need(r.ok, `HTTP ${r.status}`);
  need(body?.ok === true, 'ответ без ok:true');
  return `аптайм ${body.uptime_s}с`;
});

await check('вход закрыт', async () => {
  const r = await fetch(root + '/api/categories', { signal: AbortSignal.timeout(20_000) });
  if (r.status === 401) return 'пароль спрашивается';
  need(false, r.ok
    ? 'API отвечает БЕЗ пароля — задайте APP_PASSWORD, иначе ключ OpenRouter открыт'
    : `неожиданный HTTP ${r.status}`);
});

await check('разделы', async () => {
  const { r, body } = await get('/api/categories');
  need(r.ok, `HTTP ${r.status}${r.status === 401 ? ' — передайте user:пароль вторым аргументом' : ''}`);
  const ids = (body.categories || []).map(c => c.id);
  need(ids.includes(523) && ids.includes(467), `нет 523/467, пришло ${ids.join(',') || 'пусто'}`);
  return `${body.categories.length}: ${body.categories.map(c => `${c.name} (${c.id})`).join(', ')}`;
});

await check('модели OpenRouter', async () => {
  const { r, body } = await get('/api/models');
  need(r.ok, `HTTP ${r.status}: ${body?.error || ''}`.slice(0, 120));
  need(body.data?.length, 'пустой список — проверьте OPENROUTER_API_KEY');
  return `${body.data.length} моделей, курс ${body.rub_per_usd} ₽ на ${body.rub_rate_date}`;
});

await check('обход раздела и автофильтры', async () => {
  const { r, body } = await get('/api/catalog?category=kholodilniki&limit=1');
  need(r.ok, `HTTP ${r.status}: ${body?.error || ''}`.slice(0, 120));
  need(body.products?.length === 1, 'товар не пришёл');
  const brand = body.filters?.find(f => f.code === 'brand');
  const price = body.filters?.find(f => f.code === 'price');
  need(brand?.values?.length, 'фильтр по бренду пуст');
  need(price?.min > 0, 'нет диапазона цен');
  need(body.count > 1, 'фильтр посчитан по окну, а не по разделу');
  return `id ${body.category_id}, ${body.count} товаров, брендов ${brand.values.length}, ${price.min}–${price.max} ₽`;
});

await check('прокси не пускает за пределы списка', async () => {
  const { r } = await get('/api/product?url=' + encodeURIComponent('http://169.254.169.254/latest/meta-data/'));
  need(r.status === 403, `ожидался 403, пришёл ${r.status}`);
});

await check('обогащение отвечает и не тратит зря', async () => {
  // Товар без пригодного текста: ответ формируется до обращения к модели.
  const { r, body } = await get('/api/enrich', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek/deepseek-v3.2', product: { description: 'Холодильник белый' } }),
  });
  need(r.ok, `HTTP ${r.status}: ${body?.error || ''}`.slice(0, 120));
  need(body.skipped, 'товар без характеристик должен быть пропущен');
  need(body.usage?.cost === 0, 'за пропуск списана стоимость');
  return 'пропуск без оплаты работает';
});

console.log(failed ? `\n❌ Провалено проверок: ${failed}\n` : '\n✅ Развёрнутая версия отвечает как ожидается\n');
process.exit(failed ? 1 : 0);
