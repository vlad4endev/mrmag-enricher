/**
 * server.js — бэкенд для index_final.html. Без зависимостей, только node:http.
 *
 * Запуск:
 *   OPENROUTER_API_KEY=sk-or-v1-... node server.js
 *   PORT=3000 ALLOWED_HOSTS=mrmag.ru,adn-avto.ru node server.js
 *
 * Ключ OpenRouter остаётся здесь и в браузер не попадает. Перед публикацией
 * задайте APP_PASSWORD: /api/enrich тратит деньги, и открытый доступ к нему —
 * это открытый доступ к вашему счёту.
 *
 * Маршруты:
 *   GET  /healthz             проба живости, без аутентификации
 *   GET  /api/models          список моделей с актуальными ценами (кэш MODELS_TTL_MS)
 *   GET  /api/product?url=... прокси к каталогу, только по разрешённым хостам
 *   GET  /api/categories      разделы из требований и схемы полей
 *   GET  /api/catalog?category=kholodilniki[&limit=N]
 *                             обход раздела: товары с описаниями + автофильтры
 *   POST /api/enrich          обогащение одного товара {model, product, category?}
 *
 * Ответ /api/enrich: { enriched, usage:{prompt_tokens, completion_tokens, cost,
 * cost_source, attempts} }. Токены и стоимость — сумма по всем попыткам, включая
 * ретраи; при провале usage приходит вместе с полем error, чтобы потраченное
 * на неудачные попытки не терялось в отчёте.
 */

import http from 'http';
import crypto from 'crypto';
import dns from 'dns';
import { setupProxy } from './socks.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  RateLimiter, enrichProduct, rpmFor, schemaFor, SCHEMAS, netError,
  RUB_PER_USD, RUB_RATE_DATE, MISMATCH_POLICY, isEnrichable,
} from './lib.js';
import { CATEGORIES, findCategory, crawlCategory, loadFeed, buildFilters } from './catalog.js';

const API_KEY = process.env.OPENROUTER_API_KEY;
const PORT    = Number(process.env.PORT || 3000);
const HOST    = process.env.HOST || '0.0.0.0';
const ROOT    = path.dirname(fileURLToPath(import.meta.url));

// Вход по Basic. Пусто — сервер открыт, при старте будет предупреждение.
const APP_USER     = process.env.APP_USER || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || '';

// Прокси ходит только по этим хостам: свободный URL от клиента — это доступ
// во внутреннюю сеть и к метаданным облака.
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || 'mrmag.ru,adn-avto.ru')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

if (!API_KEY) {
  console.error('❌ Установите OPENROUTER_API_KEY');
  process.exit(1);
}

// Список моделей — 300+ КБ и один и тот же для /api/models и для тарифа. Тянем
// его один раз на TTL, параллельные запросы ждут один и тот же промис.
const MODELS_TTL = Number(process.env.MODELS_TTL_MS || 5 * 60_000);
let modelsCache = { at: 0, list: null };
let modelsInflight = null;

async function models() {
  if (modelsCache.list && Date.now() - modelsCache.at < MODELS_TTL) return modelsCache.list;
  if (!modelsInflight) {
    modelsInflight = (async () => {
      let r;
      try {
        r = await fetch('https://openrouter.ai/api/v1/models', {
          headers: { Authorization: `Bearer ${API_KEY}` },
          signal:  AbortSignal.timeout(20_000),
        });
      } catch (e) {
        throw new Error(`не достучались до openrouter.ai — ${netError(e)}`);
      }
      const text = await r.text();
      if (!r.ok) throw new Error(explainUpstream(r, text));
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('OpenRouter вернул не JSON'); }
      modelsCache = { at: Date.now(), list: data.data || [] };
      return modelsCache.list;
    })().finally(() => { modelsInflight = null; });
  }
  return modelsInflight;
}

/**
 * Cloudflare перед OpenRouter отдаёт 403 «Access denied by security policy» по
 * географии IP — на публичный эндпоинт, ещё до проверки ключа. Голый код 403
 * толкает искать проблему в ключе, хотя ключ тут ни при чём.
 */
function explainUpstream(res, text) {
  const ray = res.headers.get('cf-ray') || '';
  if (res.status === 403 && /security policy/i.test(text)) {
    const edge = ray.split('-')[1];
    return `OpenRouter отклонил запрос с этого адреса (Cloudflare${edge ? `, узел ${edge}` : ''}). ` +
      'Ключ ни при чём — 403 приходит и без него. Нужен выход через сеть другой страны: ' +
      'задайте HTTPS_PROXY в .env';
  }
  if (res.status === 401) return 'OpenRouter не принял ключ — проверьте OPENROUTER_API_KEY';
  return `OpenRouter HTTP ${res.status}: ${text.slice(0, 200)}`;
}

/** Тариф модели из того же кэша. Не найден — считаем по usage.cost из ответа. */
function pricingOf(entry) {
  if (!entry?.pricing) return null;
  return {
    prompt:     parseFloat(entry.pricing.prompt) || 0,      // $ за токен
    completion: parseFloat(entry.pricing.completion) || 0,
  };
}

// Один лимитер на модель — иначе параллельные вкладки выбьют rate limit.
const limiters = new Map();
const limiterFor = model => {
  let l = limiters.get(model);
  if (!l) {
    // id модели приходит от клиента: без ограничения Map растёт на произвольных
    // строках. Валидация ниже это ловит, но крышка нужна и без неё.
    if (limiters.size >= 200) limiters.clear();
    limiters.set(model, l = new RateLimiter(rpmFor(model)));
  }
  return l;
};

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store',
  });
  res.end(s);
};

// Каталог mrmag ~3,5 МБ. Крышка нужна, чтобы ответ источника не съел память.
const MAX_PROXY_BYTES = Number(process.env.MAX_PROXY_BYTES || 32 * 1024 * 1024);

/** Читает тело ответа с ограничением по размеру, обрывая поток на превышении. */
async function readCapped(res, limit) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`Ответ источника больше ${Math.round(limit / 1e6)} МБ — прокси прерван`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Тело запроса слишком велико')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ── МАРШРУТЫ ─────────────────────────────────────────────────
async function apiModels(res) {
  try {
    json(res, 200, { data: await models(), rub_per_usd: RUB_PER_USD, rub_rate_date: RUB_RATE_DATE });
  } catch (e) {
    json(res, 502, { error: e.message });
  }
}

/** Разделы из требований вместе с полями схемы — чтобы интерфейс не хардкодил. */
function apiCategories(res) {
  json(res, 200, {
    categories: CATEGORIES.map(c => {
      const s = schemaFor(c.slug);
      return {
        slug: c.slug, name: c.name, url: c.url, id: s.id,
        products_url: `${c.url}`, spec_keys: s.specKeys,
      };
    }),
    schemas: Object.fromEntries(Object.entries(SCHEMAS).map(([k, v]) => [k, { id: v.id, name: v.name, spec_keys: v.specKeys }])),
  });
}

/**
 * Обход раздела для интерфейса. Раздел — это HTML-листинг, а не JSON, поэтому
 * через /api/product его не загрузить. Страницы кэшируются на диске, так что
 * долгим бывает только первый заход (стиральные машины — 160 страниц товаров).
 */
// Обход идёт минуты и стучится на чужой сайт. Два одновременных запроса за один
// раздел должны ждать один обход, а не удваивать нагрузку.
const crawlsInFlight = new Map();

async function apiCatalog(res, key, limitRaw) {
  const target = findCategory(key || '') || (/^https?:/.test(key || '') ? { url: key } : null);
  if (!target) {
    return json(res, 400, {
      error: `Раздел "${key || ''}" не найден`,
      categories: CATEGORIES.map(c => c.slug),
    });
  }
  const limit = limitRaw ? Math.max(1, Math.min(2000, Number(limitRaw) || 0)) : Infinity;
  const jobKey = `${target.url}|${limit}`;
  let job = crawlsInFlight.get(jobKey);
  if (!job) {
    job = (async () => {
      const feed = await loadFeed().catch(() => null);
      return crawlCategory(target.url, { limit, feed });
    })().finally(() => crawlsInFlight.delete(jobKey));
    crawlsInFlight.set(jobKey, job);
  }

  let cat;
  try { cat = await job; }
  catch (e) { return json(res, 502, { error: `Не удалось обойти раздел: ${netError(e)}` }); }

  json(res, 200, {
    category_id: cat.id, category: cat.name, slug: cat.slug, url: cat.url,
    // count — весь раздел, loaded — сколько пришло с описаниями.
    count:   cat.listed,
    loaded:  cat.products.length,
    partial: cat.products.length < cat.listed,
    // Фильтр по всему разделу: бренд и цена есть у каждого товара листинга.
    filters: buildFilters(cat, cat.items).filters,
    products: cat.products,
  });
}

async function apiProduct(res, target) {
  if (!target) return json(res, 400, { error: 'Не передан параметр url' });

  let u;
  try { u = new URL(target); } catch { return json(res, 400, { error: 'Некорректный URL' }); }
  if (!['http:', 'https:'].includes(u.protocol)) {
    return json(res, 400, { error: 'Разрешены только http и https' });
  }
  const host = u.hostname.toLowerCase();
  const allowed = ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
  if (!allowed) {
    return json(res, 403, { error: `Хост ${host} не разрешён. Доступны: ${ALLOWED_HOSTS.join(', ')}` });
  }

  // redirect:'error' обязателен: со 'follow' разрешённый хост увёл бы прокси
  // куда угодно и проверка списка стала бы декоративной.
  let r;
  try {
    r = await fetch(u, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
  } catch (e) {
    const why = /redirect/i.test(e.message)
      ? 'источник отвечает перенаправлением — укажите конечный адрес'
      : netError(e);
    return json(res, 502, { error: `Не удалось получить каталог: ${why}` });
  }
  if (!r.ok) return json(res, r.status, { error: `Источник ответил HTTP ${r.status}` });

  let text;
  try { text = await readCapped(r, MAX_PROXY_BYTES); }
  catch (e) { return json(res, 502, { error: e.message }); }
  try {
    json(res, 200, JSON.parse(text));
  } catch {
    json(res, 502, { error: 'Источник вернул не JSON' });
  }
}

async function apiEnrich(req, res) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Тело запроса не JSON' }); }

  const { model, product, category } = body || {};
  if (!model || typeof model !== 'string') return json(res, 400, { error: 'Не передана модель' });
  if (!product || typeof product !== 'object') return json(res, 400, { error: 'Не передан товар' });

  // Категория определяет схему полей и промпт. Явное поле важнее, иначе берём
  // category самого товара — её проставляет и фид, и обход раздела.
  const schema = schemaFor(category || product.category);

  const gate = isEnrichable(product, schema);
  if (!gate.ok) {
    return json(res, 200, {
      enriched: null,
      skipped:  gate.reason,
      usage:    { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
    });
  }

  // Опечатка в id модели иначе уходит в OpenRouter и возвращается как 404 —
  // и попутно плодит запись в limiters на каждую несуществующую строку.
  let entry = null;
  try {
    const list = await models();
    entry = list.find(m => m.id === model) || null;
    if (!entry) return json(res, 400, { error: `Модель "${model}" не найдена в OpenRouter` });
  } catch { /* список недоступен — не блокируем работу, шлём как есть */ }

  try {
    const { enriched, iT, oT, cost, costSource, attempts } = await enrichProduct(product, {
      model, apiKey: API_KEY, schema,
      limiter: limiterFor(model),
      pricing: pricingOf(entry),
    });
    json(res, 200, {
      enriched,
      schema: schema.slug,
      usage: { prompt_tokens: iT, completion_tokens: oT, cost, cost_source: costSource, attempts },
    });
  } catch (e) {
    // Неудачные попытки тоже оплачены — отдаём их, чтобы итог не занижался.
    json(res, 502, {
      error: e.message,
      usage: e.usage
        ? { prompt_tokens: e.usage.iT, completion_tokens: e.usage.oT, cost: e.usage.cost }
        : undefined,
    });
  }
}

// Интерфейс — один файл без внешних ресурсов, поэтому раздаём только его:
// каталог проекта целиком отдавать наружу не нужно.
const PAGE = 'index_final.html';

function serveStatic(res, urlPath) {
  if (urlPath !== '/' && urlPath !== '/' + PAGE) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Не найдено');
  }
  const file = path.join(ROOT, PAGE);
  if (!fs.existsSync(file)) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`Нет файла ${PAGE}`);
  }
  res.writeHead(200, {
    'Content-Type':  'text/html; charset=utf-8',
    // Одна страница целиком: без этого правки интерфейса не доходят до браузера.
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}

// ── СЕРВЕР ───────────────────────────────────────────────────
/**
 * Basic-аутентификация. Ключ OpenRouter тратит тот, кто дотянулся до /api/enrich,
 * поэтому открытый наружу сервер — это открытый чужой кошелёк. Basic выбран
 * потому, что его делает сам браузер: не нужен ни вход, ни хранение токена в JS.
 * Пароля нет — сервер работает, но громко предупреждает при старте.
 */
function authorized(req) {
  if (!APP_PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!/^Basic /i.test(h)) return false;
  const [user, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf-8').split(':');
  const pass = rest.join(':');
  // Сравнение постоянного времени: иначе пароль подбирается по времени ответа.
  return safeEqual(user, APP_USER) && safeEqual(pass, APP_PASSWORD);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  // Длины сравниваем отдельно: timingSafeEqual падает на разной длине.
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Мост поднимаем до старта приёма запросов: первый же /api/models должен уйти
// уже через прокси, иначе первый пользователь получит 403 на ровном месте.
const proxyLines = [];
try {
  await setupProxy(l => proxyLines.push(l));
} catch (e) {
  console.error(`❌ SOCKS_PROXY: ${e.message}`);
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Лог одной строкой: без него в прод-логах не видно ни кто ходит, ни сколько
  // это стоило по времени.
  res.on('finish', () => {
    if (u.pathname === '/healthz') return;               // не засоряем лог пробами
    console.log(`${req.method} ${u.pathname}${u.search} → ${res.statusCode} ${Date.now() - started}ms`);
  });

  try {
    // Проба живости — до аутентификации: балансировщик пароля не знает.
    if (u.pathname === '/healthz') {
      return json(res, 200, { ok: true, uptime_s: Math.round(process.uptime()) });
    }

    if (!authorized(req)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="AI Enricher", charset="UTF-8"',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      return res.end('Требуется вход');
    }

    if (req.method === 'GET'  && u.pathname === '/api/models')     return await apiModels(res);
    if (req.method === 'GET'  && u.pathname === '/api/categories') return apiCategories(res);
    if (req.method === 'GET'  && u.pathname === '/api/catalog')    return await apiCatalog(res, u.searchParams.get('category'), u.searchParams.get('limit'));
    if (req.method === 'GET'  && u.pathname === '/api/product')    return await apiProduct(res, u.searchParams.get('url'));
    if (req.method === 'POST' && u.pathname === '/api/enrich')     return await apiEnrich(req, res);
    if (req.method === 'GET') return serveStatic(res, u.pathname);
    json(res, 405, { error: 'Метод не поддерживается' });
  } catch (e) {
    // Ответ мог уже уйти — второй writeHead уронил бы процесс.
    if (res.headersSent) return res.end();
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`\n  AI Enricher → http://${shown}:${PORT}`);
  console.log(`  Разделы: ${CATEGORIES.map(c => `${c.name} (${c.id})`).join(', ')}`);
  console.log(`  Прокси разрешён для: ${ALLOWED_HOSTS.join(', ')}`);
  console.log(`  Курс: ${RUB_PER_USD} ₽/$ на ${RUB_RATE_DATE} | политика расхождений: ${MISMATCH_POLICY}`);
  console.log(`  Вход: ${APP_PASSWORD ? `Basic, пользователь ${APP_USER}` : 'ОТКРЫТ'}`);
  for (const l of proxyLines) console.log(l);

  // Прокси задаётся окружением, а не кодом — но молча это оставлять нельзя:
  // «не достучались до openrouter.ai» и «прокси не отвечает» лечатся по-разному.
  // Печатаем, куда на самом деле резолвится openrouter.ai. Если адрес
  // подменён или закреплённый в extra_hosts протух, это видно сразу в логе,
  // а не превращается в загадочный таймаут через месяц.
  dns.lookup('openrouter.ai', { all: true }, (err, addrs) => {
    if (err) return console.warn(`  ⚠ openrouter.ai не резолвится: ${err.message}`);
    console.log(`  openrouter.ai → ${addrs.map(a => a.address).join(', ')}`);
  });

  // Мост уже отчитался выше — второй строкой про тот же прокси лог не засоряем.
  const proxy = process.env.SOCKS_PROXY ? null : (process.env.HTTPS_PROXY || process.env.https_proxy);
  if (proxy) {
    console.log(`  Прокси: ${proxy.replace(/\/\/[^@]*@/, '//***@')}`);
    if (Number(process.versions.node.split('.')[0]) < 24) {
      console.warn(`  ⚠  Node ${process.versions.node}: встроенная поддержка HTTPS_PROXY
     появилась в 24 — прокси будет проигнорирован. Обновите образ.`);
    } else if (process.env.NODE_USE_ENV_PROXY !== '1') {
      console.warn('  ⚠  HTTPS_PROXY задан, но NODE_USE_ENV_PROXY=1 не выставлен — прокси не применится');
    }
  }
  if (!APP_PASSWORD && HOST === '0.0.0.0') {
    console.warn(`
  ⚠  Сервер слушает все интерфейсы БЕЗ пароля. Любой, кто до него дотянется,
     тратит ваш ключ OpenRouter. Перед публикацией задайте APP_PASSWORD
     (и APP_USER), либо привяжите к локальному адресу: HOST=127.0.0.1`);
  }
  console.log('');
});

// ── ЗАВЕРШЕНИЕ ───────────────────────────────────────────────
// Без этого docker stop и systemd restart рвут запрос на середине: контейнеру
// дают ~10 секунд, потом SIGKILL.
let closing = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (closing) process.exit(1);           // второй сигнал — выходим сразу
    closing = true;
    console.log(`\n${sig}: доводим текущие запросы и закрываемся`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

// Падать целиком из-за одного сорвавшегося промиса не нужно: логируем и живём.
process.on('unhandledRejection', e => console.error('Необработанный промис:', e?.message || e));
// А вот исключение оставляет процесс в неизвестном состоянии — выходим, пусть
// перезапустит супервизор.
process.on('uncaughtException', e => {
  console.error('Необработанное исключение:', e);
  process.exit(1);
});
