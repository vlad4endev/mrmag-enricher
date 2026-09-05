/**
 * server.js — бэкенд для index_final.html. Без зависимостей, только node:http.
 *
 * Запуск:
 *   OPENROUTER_API_KEY=sk-or-v1-... node server.js
 *   PORT=3000 ALLOWED_HOSTS=mrmag.ru,adn-avto.ru node server.js
 *
 * Ключ OpenRouter остаётся здесь и в браузер не попадает. Перед публикацией
 * задайте APP_PASSWORD: /api/enrich тратит деньги, и открытый доступ к нему —
 * это открытый доступ к вашему счёту. Браузер входит через форму (cookie),
 * скрипты — по-прежнему Basic.
 *
 * Маршруты:
 *   GET  /healthz             проба живости, без аутентификации
 *   GET  /api/models          список моделей включённых провайдеров (кэш MODELS_TTL_MS)
 *   GET  /api/settings        провайдеры ИИ, парсеры, условия, шаблон промпта (ключи скрыты)
 *   PUT  /api/settings        сохранить настройки; пустой api_key оставляет прежний
 *   POST /api/prompt/preview  превью системного промпта { template?, category }
 *   GET  /api/parser          статус и настройки поиска пустых карточек
 *   GET  /api/product?url=... прокси к каталогу, только по разрешённым хостам
 *   GET  /api/categories      разделы из требований и схемы полей
 *   GET  /api/catalog?category=kholodilniki[&limit=N]
 *                             обход раздела: товары с описаниями + автофильтры
 *   POST /api/export          выгрузка заказчика: products + filters + held
 *   POST /api/export-v2       витрина v2: filters + products
 *   POST /api/filters         фильтры по переданному списку товаров
 *   POST /api/quality         качество исходных данных по списку товаров
 *   POST /api/enrich          обогащение одного товара {model, product, category?}
 *   POST /api/jobs            фоновый прогон {model, products[], indices?, category?}
 *   GET  /api/jobs            список прогонов: что идёт сейчас и что уже прошло
 *   GET  /api/jobs/:id[?from=N&products=1]
 *                             состояние прогона; from — сколько результатов уже
 *                             у клиента, отдаётся только хвост
 *   POST /api/jobs/:id/stop   остановить прогон после текущего товара
 *   DELETE /api/jobs/:id      забыть прогон вместе с файлом на диске
 *
 * Товар без description и annotation не пропускается молча: по имени
 * ищется описание в сети (ensureSource), и адрес найденной страницы
 * возвращается в source_url. Отключается WEB_LOOKUP=0.
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
  RateLimiter, enrichProduct, rpmFor, schemaFor, schemaForProduct, SCHEMAS, netError,
  RUB_PER_USD, RUB_RATE_DATE, isEnrichable, productFacts,
  buildSystemPrompt, defaultSystemPromptTemplate, PROMPT_PLACEHOLDERS,
} from './lib.js';
import { CATEGORIES, findCategory, crawlCategory, loadFeed, buildFilters, ensureSource, WEB_LOOKUP } from './catalog.js';
import { buildV2 } from './export_v2.js';
import { buildCustomerExport, buildGoldShapeExport } from './pipeline/export.js';
import { dictForProducts } from './pipeline/schema.js';
import { createJobStore } from './jobs.js';
import { loadConfig } from './pipeline/dict.js';
import { publicParserStatus } from './pipeline/search.js';
import {
  loadSettings, saveSettings, publicSettings, applySettingsPatch,
  resolveProvider, providerEndpoint, providerKey,
  bootstrapSettingsFile, PROVIDER_PRESETS, envOverrides,
  parsersView, conditionsView,
} from './settings.js';

const API_KEY = process.env.OPENROUTER_API_KEY || '';
const PORT    = Number(process.env.PORT || 3000);
const HOST    = process.env.HOST || '0.0.0.0';
const ROOT    = path.dirname(fileURLToPath(import.meta.url));

// Вход: форма ставит httpOnly-cookie, скрипты могут слать Basic. Пусто — сервер
// открыт, при старте будет предупреждение.
const APP_USER     = process.env.APP_USER || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_MS   = Number(process.env.SESSION_TTL_MS || 7 * 24 * 3600_000);
const COOKIE_NAME  = 'enricher';

// Прокси ходит только по этим хостам: свободный URL от клиента — это доступ
// во внутреннюю сеть и к метаданным облака.
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || 'mrmag.ru,adn-avto.ru')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

bootstrapSettingsFile(ROOT);
{
  const boot = loadSettings(ROOT);
  const def = resolveProvider(boot);
  if (!providerKey(def) && !API_KEY) {
    console.error('❌ Нет ключа у провайдера по умолчанию — задайте его в настройках или OPENROUTER_API_KEY');
    process.exit(1);
  }
}

// Список моделей — 300+ КБ. Тянем раз на TTL; параллельные запросы ждут один промис.
const MODELS_TTL = Number(process.env.MODELS_TTL_MS || 5 * 60_000);
let modelsCache = { at: 0, list: null, errors: [] };
let modelsInflight = null;

function tagModels(raw, p) {
  return (raw || []).map(m => ({
    ...m,
    id: m.id || m.name,
    provider: p.id,
    provider_name: p.name,
  })).filter(m => m.id);
}

/** Модели из карточки провайдера — без сети. DeepSeek/Ollama ими и живут. */
function listedModels(p) {
  return tagModels((p.models || []).map(id => ({ id, name: id, pricing: null })), p);
}

function dedupeModels(list) {
  const seen = new Set();
  const out = [];
  for (const m of list || []) {
    const k = `${m.provider || ''}\0${m.id}`;
    if (!m.id || seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}

function sortModels(list, defaultId) {
  return list.slice().sort((a, b) => {
    const ad = a.provider === defaultId ? 0 : 1;
    const bd = b.provider === defaultId ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return String(a.name || a.id).localeCompare(String(b.name || b.id), 'ru');
  });
}

async function fetchProviderModels(p, { timeoutMs = 20_000 } = {}) {
  const ep = providerEndpoint(p);
  const listed = listedModels(p);
  if (!p.models_path) return listed;
  const headers = { ...ep.headers };
  if (ep.apiKey) headers.Authorization = `Bearer ${ep.apiKey}`;
  let r, text;
  try {
    r = await fetch(ep.modelsUrl, { headers, signal: AbortSignal.timeout(timeoutMs) });
    text = await r.text();
  } catch (e) {
    if (listed.length) return listed;
    const host = (() => { try { return new URL(ep.modelsUrl).hostname; } catch { return p.name; } })();
    throw new Error(`не достучались до ${host} — ${netError(e)}`);
  }
  if (!r.ok) {
    if (listed.length) return listed;
    throw new Error(/openrouter\.ai/i.test(ep.modelsUrl) ? explainUpstream(r, text) : `${p.name} HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  let data;
  try { data = JSON.parse(text); } catch {
    if (listed.length) return listed;
    throw new Error(`${p.name} вернул не JSON`);
  }
  const rows = data.data || data.models || (Array.isArray(data) ? data : []);
  const fetched = tagModels(rows, p);
  return fetched.length ? dedupeModels([...fetched, ...listed]) : listed;
}

async function models() {
  if (modelsCache.list && Date.now() - modelsCache.at < MODELS_TTL) return modelsCache.list;
  const settings = loadSettings(ROOT);
  const enabled = settings.providers.filter(p => p.enabled);
  if (!enabled.length) throw new Error('нет включённых провайдеров ИИ');
  const defaultId = (enabled.find(p => p.default) || enabled[0]).id;
  const staticList = sortModels(dedupeModels(enabled.flatMap(listedModels)), defaultId);

  const loadRemote = async () => {
    const errors = [];
    const chunks = await Promise.all(enabled.map(async p => {
      const listed = listedModels(p);
      // OpenRouter без своего списка не должен на 20 с блокировать DeepSeek.
      const timeoutMs = listed.length ? 2500 : (p.default ? 10_000 : 4000);
      try { return await fetchProviderModels(p, { timeoutMs }); }
      catch (e) {
        errors.push({ provider: p.id, name: p.name, error: e.message });
        return listed;
      }
    }));
    const list = sortModels(dedupeModels(chunks.flat()), defaultId);
    if (!list.length) throw new Error(errors[0]?.error || 'ни один провайдер не отдал модели');
    modelsCache = { at: Date.now(), list, errors };
    return list;
  };

  // Карточка DeepSeek уже знает id моделей — отдаём их сразу, каталог OpenRouter
  // догоняет кэш, если ответит.
  if (staticList.length) {
    modelsCache = { at: Date.now(), list: staticList, errors: [] };
    if (!modelsInflight) {
      modelsInflight = loadRemote().catch(() => staticList).finally(() => { modelsInflight = null; });
    }
    return staticList;
  }

  if (!modelsInflight) {
    modelsInflight = loadRemote().finally(() => { modelsInflight = null; });
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

// Прогон на 259 товаров с обогащением — это ~1,5 МБ тела: на общем лимите
// пакетная выгрузка падала «Тело запроса слишком велико». Один товар в
// /api/enrich так и остаётся в пределах мегабайта.
const BULK_BODY_LIMIT = 64_000_000;

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
    const list = await models();
    json(res, 200, {
      data: list,
      errors: modelsCache.errors || [],
      rub_per_usd: RUB_PER_USD,
      rub_rate_date: RUB_RATE_DATE,
    });
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
    // enums отдаём наружу: это готовые значения фасетов, по ним строится фильтр
    // на витрине — иначе фронт угадывает список допустимых значений сам.
    schemas: Object.fromEntries(Object.entries(SCHEMAS).map(([k, v]) =>
      [k, { id: v.id, name: v.name, spec_keys: v.specKeys, numeric_keys: v.numericKeys, enums: v.enums }])),
  });
}

function apiParser(res) {
  let config = {};
  try { config = loadConfig(ROOT); } catch { /* defaults in resolveSearchSettings */ }
  const parser = publicParserStatus(config);
  if (!WEB_LOOKUP) {
    parser.enabled = false;
    parser.status = 'off';
    parser.label = 'выключен (WEB_LOOKUP=0)';
  }
  json(res, 200, parser);
}

function promptMeta(settings, category = null) {
  const custom = String(settings?.model?.system_prompt || '').trim();
  const template = custom || defaultSystemPromptTemplate();
  const cat = category || CATEGORIES[0]?.slug || 'kholodilniki';
  return {
    template: custom,
    default_template: defaultSystemPromptTemplate(),
    custom: !!custom,
    placeholders: PROMPT_PLACEHOLDERS,
    preview: buildSystemPrompt(cat, template),
    preview_category: cat,
  };
}

function apiSettingsGet(res) {
  const settings = loadSettings(ROOT);
  json(res, 200, {
    settings: publicSettings(settings),
    parsers: parsersView(settings.search),
    conditions: conditionsView(settings.conditions),
    presets: PROVIDER_PRESETS,
    overrides: envOverrides(),
    prompt: promptMeta(settings),
  });
}

async function apiSettingsPut(req, res) {
  const raw = await readBody(req, 1_000_000);
  let patch;
  try { patch = JSON.parse(raw); } catch { return json(res, 400, { error: 'Тело запроса не JSON' }); }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return json(res, 400, { error: 'Ожидался объект настроек' });
  }
  try {
    const next = applySettingsPatch(loadSettings(ROOT), patch);
    saveSettings(next, ROOT);
    modelsCache = { at: 0, list: null, errors: [] };
    const settings = loadSettings(ROOT);
    json(res, 200, {
      settings: publicSettings(settings),
      parsers: parsersView(settings.search),
      conditions: conditionsView(settings.conditions),
      presets: PROVIDER_PRESETS,
      overrides: envOverrides(),
      prompt: promptMeta(settings),
    });
  } catch (e) {
    json(res, e.status || 400, { error: e.message, details: e.details });
  }
}

/**
 * Превью собранного промпта: POST { template?, category }.
 * Без template берётся сохранённый или встроенный — чтобы вкладка «Промпт»
 * показывала то же, что уйдёт в модель после сохранения.
 */
async function apiPromptPreview(req, res) {
  const raw = await readBody(req, 1_000_000);
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'Тело запроса не JSON' }); }
  const settings = loadSettings(ROOT);
  const category = body?.category || CATEGORIES[0]?.slug || 'kholodilniki';
  const fromBody = body?.template != null ? String(body.template) : null;
  const custom = String(settings.model?.system_prompt || '').trim();
  const template = fromBody != null
    ? (String(fromBody).trim() ? fromBody : defaultSystemPromptTemplate())
    : (custom || defaultSystemPromptTemplate());
  json(res, 200, {
    category,
    custom: fromBody != null ? String(fromBody).trim() !== '' && fromBody !== defaultSystemPromptTemplate() : !!custom,
    preview: buildSystemPrompt(category, template),
    placeholders: PROMPT_PLACEHOLDERS,
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

  // Фильтр по всему разделу: бренд и цена есть у каждого товара листинга.
  const f = buildFilters(cat, cat.items);
  json(res, 200, {
    category_id: cat.id, category: cat.name, slug: cat.slug, url: cat.url,
    // count — весь раздел, loaded — сколько пришло с описаниями.
    count:   cat.listed,
    loaded:  cat.products.length,
    partial: cat.products.length < cat.listed,
    filters: f.filters,
    // Готовое содержимое filters_(id).json — ровно то, что пишет CLI. Интерфейс
    // выгружает его как есть: пересчитать фильтр по загруженному окну значило бы
    // отдать фильтр окна вместо фильтра раздела.
    filters_file: f,
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
  catch (e) { return json(res, 502, { error: netError(e) }); }
  try {
    json(res, 200, JSON.parse(text));
  } catch {
    json(res, 502, { error: 'Источник вернул не JSON' });
  }
}

/**
 * Фильтры по переданному списку товаров: POST { products, category_id, category, url }.
 * Нужно интерфейсу для выгрузки filters_(id).json, когда товары пришли не из
 * раздела, а по адресу фида и лежат в нём вперемешку по категориям. Считает та
 * же buildFilters, что пишет файл в CLI, — иначе два формата разъедутся.
 */
async function apiFilters(req, res) {
  const raw = await readBody(req, BULK_BODY_LIMIT);
  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Тело запроса не JSON' }); }

  const { products, category_id = null, category = null, url = null } = body || {};
  if (!Array.isArray(products) || !products.length) {
    return json(res, 400, { error: 'Не передан список товаров' });
  }
  json(res, 200, buildFilters({ id: category_id, name: category, url }, products));
}

/**
 * Качество исходных данных: POST { products, category } → { quality: [{ ok, reason }] }.
 * Интерфейсу нужно знать до прогона, по каким товарам платить бессмысленно.
 * Считает та же isEnrichable, что потом пропускает товар в /api/enrich, — копии
 * этой логики в браузере нет: разойдись они, фильтр «Без данных» показывал бы
 * одно, а прогон пропускал другое.
 */
async function apiQuality(req, res) {
  const raw = await readBody(req, BULK_BODY_LIMIT);
  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Тело запроса не JSON' }); }

  const { products, category = null } = body || {};
  if (!Array.isArray(products) || !products.length) {
    return json(res, 400, { error: 'Не передан список товаров' });
  }
  // Противоречия каталога считаются здесь же: это свойство исходных данных, а
  // не ответа модели, — значит видно до прогона и без единого запроса к ней.
  json(res, 200, {
    quality: products.map(p => {
      const schema = schemaForProduct(p || {}, category);
      return { ...isEnrichable(p || {}, schema), conflicts: productFacts(p || {}, schema).conflicts };
    }),
  });
}

/**
 * Выгрузка v2: POST { products, category } → { products, filters, held }.
 * Раздел со справочником идёт через тот же слой атрибутов, что /api/export.
 * Без справочника остаётся старый buildV2 — иначе универсальные 16 полей
 * не из чего нормализовать.
 */
async function apiExportV2(req, res) {
  const raw = await readBody(req, BULK_BODY_LIMIT);
  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Тело запроса не JSON' }); }

  const { products, category, category_id } = body || {};
  if (!Array.isArray(products) || !products.length) {
    return json(res, 400, { error: 'Не передан список товаров' });
  }
  const catKey = category ?? category_id
    ?? products.find(p => p.category)?.category
    ?? products.find(p => p.category_id)?.category_id;
  const dict = dictForProducts(products, catKey, ROOT);
  if (dict) {
    let config;
    try { config = loadConfig(ROOT); }
    catch { return json(res, 500, { error: 'не прочитался config.json' }); }
    const out = buildCustomerExport(products, { dict, config, root: ROOT });
    if (!out.products.length) {
      return json(res, 400, { error: 'нет товаров с полными характеристиками', held: out.held });
    }
    return json(res, 200, out);
  }
  const out = buildV2(products, {});
  if (!out.products.length) return json(res, 400, { error: 'Нет обогащённых товаров — в v2 нечего выгружать' });
  json(res, 200, out);
}

/**
 * Выгрузка заказчика: POST { products, category } → { products, filters, held }.
 * Справочник есть — слой атрибутов. Нет — семь полей из источника, не buildV2.
 */
async function apiExport(req, res) {
  const raw = await readBody(req, BULK_BODY_LIMIT);
  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Тело запроса не JSON' }); }

  const { products, category, category_id } = body || {};
  if (!Array.isArray(products) || !products.length) {
    return json(res, 400, { error: 'Не передан список товаров' });
  }
  const catKey = category ?? category_id
    ?? products.find(p => p.category)?.category
    ?? products.find(p => p.category_id)?.category_id;
  const dict = dictForProducts(products, catKey, ROOT);
  if (!dict) {
    // Не buildV2: пять полей без annotation_html — это «опять старая выгрузка».
    const out = buildGoldShapeExport(products);
    if (!out.products.length) {
      return json(res, 400, { error: 'Нет товаров для выгрузки' });
    }
    return json(res, 200, out);
  }
  let config;
  try { config = loadConfig(ROOT); }
  catch { return json(res, 500, { error: 'не прочитался config.json' }); }
  const out = buildCustomerExport(products, { dict, config, root: ROOT });
  if (!out.products.length) {
    return json(res, 400, { error: 'нет товаров с полными характеристиками', held: out.held });
  }
  json(res, 200, out);
}

/**
 * Обогащение одного товара — один путь для /api/enrich и для фонового прогона
 * (jobs.js). Возвращает то же тело, что уходит в браузер; при провале бросает
 * ошибку с .status и .usage, чтобы потраченное на неудачные попытки не терялось.
 */
async function enrichOne(product, { model, category, provider, onNote = () => {} } = {}) {
  // Категория определяет схему полей и промпт. Явное поле важнее, иначе берём
  // category самого товара — её проставляет и фид, и обход раздела.
  const schema = schemaForProduct(product, category);
  const settings = loadSettings(ROOT);
  const prov = resolveProvider(settings, provider);
  const ep = providerEndpoint(prov);
  const apiKey = ep.apiKey || API_KEY;
  const note = (msg, meta) => { try { onNote(msg, meta); } catch { /* лог клиента не роняет прогон */ } };

  const skip = reason => ({
    enriched: null,
    skipped:  reason,
    usage:    { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
  });

  note(`Схема «${schema.slug}» · провайдер «${prov.name}»`, { step: 'schema' });

  // Дешёвый вердикт без сети: своего текста нет и в названии не за что
  // зацепиться (нет ни артикула, ни бренда/модели) — искать нечего.
  const first = isEnrichable(product, schema);
  if (!first.ok && !first.web) {
    note(`Предпроверка: пропуск — ${first.reason}`, { step: 'gate', level: 'skip' });
    return skip(first.reason);
  }
  if (!first.ok && first.web) {
    note(`Предпроверка: своего текста нет — ищем описание в сети`, { step: 'gate' });
  } else {
    note(`Предпроверка: ок, есть исходный текст`, { step: 'gate' });
  }

  if (!apiKey) {
    const e = new Error(`нет ключа у провайдера «${prov.name}»`);
    e.status = 400;
    throw e;
  }

  // Опечатка в id модели иначе уходит в шлюз и возвращается как 404 —
  // и попутно плодит запись в limiters на каждую несуществующую строку.
  let entry = null;
  try {
    const list = await models();
    entry = list.find(m => m.id === model && (!provider || m.provider === provider))
      || list.find(m => m.id === model)
      || null;
    if (!entry && list.some(m => m.provider === prov.id)) {
      const e = new Error(`Модель «${model}» не найдена у провайдера «${prov.name}»`);
      e.status = 400;
      throw e;
    }
  } catch (e) {
    // Список недоступен — не блокируем работу, шлём как есть. А вот вердикт
    // «модели нет» — это ответ, а не сбой справочника.
    if (e.status === 400) throw e;
  }

  note(`Модель ${model}`, { step: 'model' });

  // Пустая карточка — описание из сети. Карточка с текстом, но без страны —
  // отдельный поиск только страны по модели. ensureSource сам решает, что
  // искать: чужую таблицу в уже заполненные поля не мешает.
  note(`Готовим исходный текст (сеть при необходимости)`, { step: 'web' });
  const found = await ensureSource(product, schema, {
    onNote: msg => note(msg, { step: 'web' }),
  });
  if (!found.gate.ok) {
    note(`После поиска: пропуск — ${found.gate.reason}`, { step: 'gate', level: 'skip' });
    return skip(found.gate.reason);
  }
  const filled = found.product;
  const sourceUrl = found.source ?? null;
  if (sourceUrl) note(`Исходный текст готов (сеть: ${sourceUrl})`, { step: 'web' });
  else note(`Исходный текст готов, отправляем в модель`, { step: 'model' });

  note(`Отправляем в модель ${model}`, { step: 'model' });
  const { enriched, iT, oT, cost, costSource, attempts } = await enrichProduct(filled, {
    model, apiKey, schema,
    limiter: limiterFor(`${prov.id}:${model}`),
    pricing: pricingOf(entry),
    chatUrl: ep.chatUrl,
    headers: ep.headers,
    mismatchPolicy: process.env.MISMATCH_POLICY || settings.conditions.mismatch_policy,
    maxRetries: settings.model.max_retries,
    timeoutMs: settings.model.timeout_ms,
    maxTokens: settings.model.max_tokens,
    systemPrompt: settings.model.system_prompt || '',
    referer: ep.headers['HTTP-Referer'] || 'https://mrmag.ru',
    title: ep.headers['X-Title'] || 'Ogran',
    onNote: msg => note(msg, { step: /retry|rate limit|обрыв|parse/i.test(msg) ? 'retry' : 'model', level: /retry|обрыв|parse/i.test(msg) ? 'warn' : 'info' }),
  });
  return {
    enriched,
    schema: schema.slug,
    provider: prov.id,
    ...(sourceUrl ? { source_url: sourceUrl } : {}),
    usage: { prompt_tokens: iT, completion_tokens: oT, cost, cost_source: costSource, attempts },
  };
}

async function apiEnrich(req, res) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Тело запроса не JSON' }); }

  const { model, product, category, provider } = body || {};
  if (!model || typeof model !== 'string') return json(res, 400, { error: 'Не передана модель' });
  if (!product || typeof product !== 'object') return json(res, 400, { error: 'Не передан товар' });

  try {
    json(res, 200, await enrichOne(product, { model, category, provider }));
  } catch (e) {
    // Неудачные попытки тоже оплачены — отдаём их, чтобы итог не занижался.
    json(res, e.status || 502, {
      error: e.message,
      usage: e.usage
        ? { prompt_tokens: e.usage.iT, completion_tokens: e.usage.oT, cost: e.usage.cost }
        : undefined,
    });
  }
}

// ── ФОНОВЫЕ ПРОГОНЫ ──────────────────────────────────────────
// Цикл по товарам крутит сервер, а не вкладка: закрытый браузер больше не
// обрывает работу на середине. Подробности и формат — в jobs.js.
const store = createJobStore({ enrichOne });

async function apiJobCreate(req, res) {
  // Прогон на 259 товаров — это больше мегабайта тела: общий лимит здесь мал.
  const raw = await readBody(req, BULK_BODY_LIMIT);
  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Тело запроса не JSON' }); }

  const { model, category, products, indices, provider } = body || {};
  if (!model || typeof model !== 'string') return json(res, 400, { error: 'Не передана модель' });
  if (!Array.isArray(products) || !products.length) return json(res, 400, { error: 'Не переданы товары' });
  if (products.some(p => !p || typeof p !== 'object')) return json(res, 400, { error: 'В списке товаров есть не объект' });
  if (indices != null && (!Array.isArray(indices) || indices.length !== products.length)) {
    return json(res, 400, { error: 'indices не совпадает по длине со списком товаров' });
  }

  const job = store.create({ model, category, products, indices, provider });
  json(res, 202, store.summary(job));
}

function apiJobState(res, id, u) {
  const job = store.get(id);
  if (!job) return json(res, 404, { error: 'Прогон не найден — возможно, он уже удалён' });
  json(res, 200, store.state(job, {
    from:     u.searchParams.get('from'),
    logFrom:  u.searchParams.get('logFrom'),
    products: u.searchParams.get('products') === '1',
  }));
}

// Интерфейс — страница приложения и страница входа. Каталог проекта целиком
// отдавать наружу не нужно.
const PAGE  = 'index_final.html';
const LOGIN = 'login.html';

function sendHtml(res, code, file, extra = {}) {
  if (!fs.existsSync(file)) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`Нет файла ${path.basename(file)}`);
  }
  res.writeHead(code, {
    'Content-Type':  'text/html; charset=utf-8',
    'Cache-Control': code === 200 ? 'no-cache' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  fs.createReadStream(file).pipe(res);
}

function serveStatic(res, urlPath) {
  if (urlPath !== '/' && urlPath !== '/' + PAGE) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Не найдено');
  }
  sendHtml(res, 200, path.join(ROOT, PAGE));
}

function serveLogin(res, code = 401) {
  sendHtml(res, code, path.join(ROOT, LOGIN));
}

// ── АУТЕНТИФИКАЦИЯ ───────────────────────────────────────────
/**
 * Ключ OpenRouter тратит тот, кто дотянулся до /api/enrich, поэтому открытый
 * наружу сервер — это открытый чужой кошелёк. Браузер входит формой и получает
 * подписанную cookie: системный диалог Basic поверх своей страницы входа не
 * всплывает. Скрипты и smoke по-прежнему шлют Basic. Пароля нет — сервер
 * работает, но громко предупреждает при старте.
 */
function sessionSecret() {
  return crypto.createHash('sha256').update(`enricher|${APP_PASSWORD}`).digest();
}

function makeSession() {
  const payload = Buffer.from(JSON.stringify({ u: APP_USER, exp: Date.now() + SESSION_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function cookieValue(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
}

function validSession(token) {
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return data.u === APP_USER && Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function cookieHeader(req, value, maxAgeSec) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
  ];
  // За nginx с TLS cookie без Secure браузер на https не сохранит. Локальный
  // http — наоборот, Secure сломал бы вход.
  if (req.headers['x-forwarded-proto'] === 'https') parts.push('Secure');
  return parts.join('; ');
}

function authorized(req) {
  if (!APP_PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (/^Basic /i.test(h)) {
    const [user, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf-8').split(':');
    const pass = rest.join(':');
    // Сравнение постоянного времени: иначе пароль подбирается по времени ответа.
    return safeEqual(user, APP_USER) && safeEqual(pass, APP_PASSWORD);
  }
  return validSession(cookieValue(req, COOKIE_NAME));
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  // Длины сравниваем отдельно: timingSafeEqual падает на разной длине.
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim().slice(0, 64);
  return req.socket.remoteAddress || 'unknown';
}

// Крышка на подбор пароля с одной машины. Карта маленькая — это не анти-DDoS.
const loginFail = new Map();
function loginLocked(ip) {
  const rec = loginFail.get(ip);
  if (!rec) return false;
  if (rec.until && Date.now() < rec.until) return true;
  if (rec.until && Date.now() >= rec.until) { loginFail.delete(ip); return false; }
  return false;
}
function noteLoginFail(ip) {
  if (loginFail.size > 4000) loginFail.clear();
  const rec = loginFail.get(ip) || { n: 0, until: 0 };
  rec.n += 1;
  if (rec.n >= 8) rec.until = Date.now() + 60_000;
  loginFail.set(ip, rec);
}

async function apiLogin(req, res) {
  const ip = clientIp(req);
  const wantsJson = /json/i.test(req.headers.accept || '') || /json/i.test(req.headers['content-type'] || '');
  const fail = (code, message) => {
    if (wantsJson) return json(res, code, { error: message });
    return serveLogin(res, code);
  };
  if (!APP_PASSWORD) {
    if (wantsJson) return json(res, 200, { ok: true });
    res.writeHead(302, { Location: '/' });
    return res.end();
  }
  if (loginLocked(ip)) return fail(429, 'Слишком много попыток — подождите минуту');

  let user = '', pass = '';
  try {
    const raw = await readBody(req, 4000);
    if (/json/i.test(req.headers['content-type'] || '')) {
      const body = JSON.parse(raw || '{}');
      user = String(body.user ?? '');
      pass = String(body.password ?? '');
    } else {
      const p = new URLSearchParams(raw);
      user = p.get('user') || '';
      pass = p.get('password') || '';
    }
  } catch {
    return fail(400, 'Не удалось прочитать данные входа');
  }

  if (!safeEqual(user, APP_USER) || !safeEqual(pass, APP_PASSWORD)) {
    noteLoginFail(ip);
    return fail(401, 'Неверный логин или пароль');
  }
  loginFail.delete(ip);
  const cookie = cookieHeader(req, makeSession(), Math.round(SESSION_MS / 1000));
  if (wantsJson) {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': cookie,
    });
    return res.end(JSON.stringify({ ok: true }));
  }
  res.writeHead(302, { Location: '/', 'Set-Cookie': cookie });
  res.end();
}

function apiLogout(req, res) {
  const cookie = cookieHeader(req, '', 0);
  const wantsJson = /json/i.test(req.headers.accept || '') || /json/i.test(req.headers['content-type'] || '');
  if (wantsJson || req.method === 'POST' && /json/i.test(req.headers['content-type'] || '')) {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': cookie,
    });
    return res.end(JSON.stringify({ ok: true }));
  }
  res.writeHead(302, { Location: '/', 'Set-Cookie': cookie });
  res.end();
}

function deny(req, res, pathname) {
  if (pathname.startsWith('/api/')) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Ogran", charset="UTF-8"',
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return res.end(JSON.stringify({ error: 'Требуется вход' }));
  }
  // Без WWW-Authenticate браузер не рисует системный диалог поверх формы.
  serveLogin(res, 401);
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

// Прерванные прогоны поднимаем с диска до приёма запросов: перезапуск сервера
// не должен стоить оплаченных товаров.
const resumedJobs = store.restore();

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

    // Страница и форма входа доступны без сессии — иначе браузер нечем заполнить.
    if (req.method === 'GET'  && (u.pathname === '/login' || u.pathname === '/login.html')) return serveLogin(res, 200);
    if (req.method === 'POST' && u.pathname === '/api/login')  return await apiLogin(req, res);
    if ((req.method === 'POST' || req.method === 'GET') && u.pathname === '/api/logout') return apiLogout(req, res);

    if (!authorized(req)) return deny(req, res, u.pathname);

    if (req.method === 'GET'  && u.pathname === '/api/models')     return await apiModels(res);
    if (req.method === 'GET'  && u.pathname === '/api/parser')     return apiParser(res);
    if (req.method === 'GET'  && u.pathname === '/api/settings')   return apiSettingsGet(res);
    if (req.method === 'PUT'  && u.pathname === '/api/settings')   return await apiSettingsPut(req, res);
    if (req.method === 'POST' && u.pathname === '/api/prompt/preview') return await apiPromptPreview(req, res);
    if (req.method === 'GET'  && u.pathname === '/api/categories') return apiCategories(res);
    if (req.method === 'POST' && u.pathname === '/api/filters')    return apiFilters(req, res);
    if (req.method === 'POST' && u.pathname === '/api/quality')    return apiQuality(req, res);
    if (req.method === 'POST' && u.pathname === '/api/export-v2')  return await apiExportV2(req, res);
    if (req.method === 'POST' && u.pathname === '/api/export')     return await apiExport(req, res);
    if (req.method === 'GET'  && u.pathname === '/api/catalog')    return await apiCatalog(res, u.searchParams.get('category'), u.searchParams.get('limit'));
    if (req.method === 'GET'  && u.pathname === '/api/product')    return await apiProduct(res, u.searchParams.get('url'));
    if (req.method === 'POST' && u.pathname === '/api/enrich')     return await apiEnrich(req, res);

    // Фоновый прогон: поставить, посмотреть, остановить, забыть.
    if (req.method === 'POST' && u.pathname === '/api/jobs')        return await apiJobCreate(req, res);
    if (req.method === 'GET'  && u.pathname === '/api/jobs')        return json(res, 200, { jobs: store.list() });
    const job = u.pathname.match(/^\/api\/jobs\/([\w-]+)(\/stop)?$/);
    if (job) {
      const [, id, stopping] = job;
      if (req.method === 'GET'    && !stopping) return apiJobState(res, id, u);
      if (req.method === 'DELETE' && !stopping) {
        return store.remove(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Прогон не найден' });
      }
      if (req.method === 'POST' && stopping) {
        const j = store.get(id);
        if (!j) return json(res, 404, { error: 'Прогон не найден' });
        return json(res, 200, store.stop(j));
      }
    }

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
  console.log(`\n  Ogran → http://${shown}:${PORT}`);
  console.log(`  Разделы: ${CATEGORIES.map(c => `${c.name} (${c.id})`).join(', ')}`);
  console.log(`  Прокси разрешён для: ${ALLOWED_HOSTS.join(', ')}`);
  console.log(`  Курс: ${RUB_PER_USD} ₽/$ на ${RUB_RATE_DATE} | политика расхождений: ${loadSettings(ROOT).conditions.mismatch_policy}`);
  console.log(`  Вход: ${APP_PASSWORD ? `форма + Basic, пользователь ${APP_USER}` : 'ОТКРЫТ'}`);
  try {
    const settings = loadSettings(ROOT);
    const on = settings.providers.filter(p => p.enabled);
    console.log(`  Провайдеры: ${on.map(p => `${p.name}${p.default ? ' (по умолч.)' : ''}`).join(', ') || 'нет'}`);
    const parser = publicParserStatus(settings);
    if (!WEB_LOOKUP) parser.label = 'выключен (WEB_LOOKUP=0)';
    console.log(`  Парсер: ${parser.label}${parser.enabled ? `, ${parser.tries} попытки` : ''}`);
  } catch {
    console.log('  Настройки: config.json не прочитан, будут значения по умолчанию');
  }
  if (resumedJobs.length) console.log(`  Продолжаем прерванные прогоны: ${resumedJobs.join(', ')}`);
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
