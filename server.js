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
 *   GET  /api/dictionaries      список + catalog + pending (дампы без справочника)
 *   POST /api/dictionaries      создать { id, copyFrom? }
 *   GET  /api/dictionaries/:id  атрибуты справочника
 *   PUT  /api/dictionaries/:id  сохранить атрибуты справочника
 *   DELETE /api/dictionaries/:id  удалить файл справочника
 *   GET  /api/dictionaries/:id/audit  проверка схемы (мусор, дубликаты, типы)
 *   GET|POST /api/dictionaries/:id/filter-preview  превью фасетов из schema
 *   POST /api/dictionaries/:id/probe  атрибуция на одном товаре
 *   POST /api/dictionaries/:id/import-suggest  AI/эвристика: список → proposals
 *   POST /api/dictionaries/:id/import-apply    применить proposals к attrs
 *   GET  /api/dictionaries/:id/from-dump       ключи характеристик из дампа (для импорта)
 *   GET  /api/dumps            исходники data_{id}.json (товары заказчика)
 *   GET  /api/dumps/:id        дамп целиком {products, …}
 *   GET  /api/dumps/:id/preview  таблица: id, name, есть ли характеристики
 *   PUT  /api/dumps/:id        загрузить/заменить массив или {products, name}
 *   DELETE /api/dumps/:id      убрать текущий файл (копия в archive/)
 *   POST /api/dumps/:id/restore  вернуть из archive { file }
 *   GET  /api/catalog?category=kholodilniki[&limit=N]
 *                             обход раздела: товары с описаниями + автофильтры
 *   POST /api/export          выгрузка заказчика: products + filters + held
 *   POST /api/export-v2       витрина v2: filters + products
 *   POST /api/filters/build   отдельный сбор filters после обогащения (агент)
 *   POST /api/filters         фильтры по переданному списку товаров (legacy catalog)
 *   POST /api/quality         качество исходных данных по списку товаров
 *   POST /api/enrich          обогащение одного товара {model, product, category?}
 *   POST /api/jobs            фоновый прогон {model, products[], indices?, category?}
 *   GET  /api/jobs            список прогонов: что идёт сейчас и что уже прошло
 *   GET  /api/jobs/:id[?from=N&products=1&logFrom=N&details=1&detailPos=N]
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
  RUB_PER_USD, RUB_RATE_DATE, isEnrichable, productFacts, hydrateFromDump,
  buildSystemPrompt, defaultSystemPromptTemplate, PROMPT_PLACEHOLDERS,
  resolveSystemPrompt, modelNotCalledDebug,
} from './lib.js';
import { CATEGORIES, findCategory, crawlCategory, loadFeed, buildFilters, ensureSource, WEB_LOOKUP, needsWebSpecs } from './catalog.js';
import { buildV2 } from './export_v2.js';
import { buildCustomerExport, buildGoldShapeExport, buildFiltersOnly } from './pipeline/export.js';
import { dictForProducts, expectedDictCatId } from './pipeline/schema.js';
import { collectParseHits, formatParseNotes, slimParseTrace } from './pipeline/parse.js';
import { createJobStore } from './jobs.js';
import {
  loadConfig, loadDictionary, hasDictionary, listDictionaries,
  readDictionaryAttrs, saveDictionaryAttrs,
  createDictionary, deleteDictionary, blankAttribute, categoryName,
  dictionaryPath, dictDebugInfo, formatDictDebug,
  bootstrapDictionariesDir,
} from './pipeline/dict.js';
import {
  bootstrapDumpsDir, listDumps, getDump, previewDump,
  parseDumpPayload, saveDump, deleteDump, restoreDumpArchive,
  listShopCategories, dumpsDir, DUMP_LIMITS,
} from './pipeline/dumps.js';
import { normalizeProduct } from './pipeline/normalize.js';
import { buildFilters as buildDictFilters } from './pipeline/facets.js';
import {
  auditDictionary, previewFilters, probeProductAttribution, coerceFacetForType,
} from './pipeline/schema_audit.js';
import {
  parseImportLines, buildImportSuggestPrompt, buildImportUserContent,
  heuristicSuggest, parseModelSuggestions, applySuggestions,
  harvestDumpAttrLines,
} from './pipeline/schema_import.js';
import { publicParserStatus } from './pipeline/search.js';
import {
  loadSettings, saveSettings, publicSettings, applySettingsPatch,
  resolveProvider, providerEndpoint, providerKey,
  bootstrapSettingsFile, PROVIDER_PRESETS, envOverrides,
  parsersView, conditionsView,
} from './settings.js';
import { exportTemplatesView } from './pipeline/export_template.js';
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
bootstrapDictionariesDir(ROOT);
bootstrapDumpsDir(ROOT);
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

/** Тариф модели из того же кэша. Не найден / нули — считаем по usage.cost из ответа. */
function pricingOf(entry) {
  if (!entry?.pricing) return null;
  const prompt = parseFloat(entry.pricing.prompt) || 0;
  const completion = parseFloat(entry.pricing.completion) || 0;
  if (!prompt && !completion) return null;
  return { prompt, completion };
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

function dictionariesPayload() {
  const dictionaries = listDictionaries(ROOT);
  const dumps = listDumps(ROOT).filter(d => d.has_file);
  const dictIds = new Set(dictionaries.map(d => String(d.id)));
  return {
    dictionaries: dictionaries.map(d => ({
      ...d,
      has_dump: dumps.some(x => String(x.id) === String(d.id)),
    })),
    catalog: listShopCategories(ROOT),
    pending: dumps.filter(d => !dictIds.has(String(d.id))).map(d => ({
      id: String(d.id),
      name: d.name,
      products: d.products || 0,
    })),
  };
}

function apiDictionariesList(res) {
  try {
    json(res, 200, dictionariesPayload());
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}

async function apiDictionaryCreate(req, res) {
  const raw = await readBody(req, 64_000);
  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Тело запроса не JSON' }); }
  const id = body?.id ?? body?.catId;
  if (id == null || id === '') return json(res, 400, { error: 'укажите id раздела' });
  try {
    const created = createDictionary(id, {
      copyFrom: body.copyFrom ?? body.copy_from ?? null,
      attrs: Array.isArray(body.attrs) ? body.attrs : null,
    }, ROOT);
    json(res, 201, created);
  } catch (e) {
    json(res, e.status || 400, { error: e.message });
  }
}

function apiDictionaryGet(res, id) {
  try {
    const attrs = readDictionaryAttrs(id, ROOT);
    json(res, 200, {
      id: String(id),
      name: categoryName(id, ROOT),
      file: `dictionaries/attributes_${id}.json`,
      attrs,
    });
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
}

async function apiDictionaryPut(req, res, id) {
  const raw = await readBody(req, 2_000_000);
  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Тело запроса не JSON' }); }
  let attrs = Array.isArray(body) ? body : body?.attrs;
  if (Array.isArray(attrs)) attrs = attrs.map(a => coerceFacetForType(a));
  try {
    const saved = saveDictionaryAttrs(id, attrs, ROOT);
    json(res, 200, {
      id: String(id),
      name: categoryName(id, ROOT),
      file: `dictionaries/attributes_${id}.json`,
      attrs: saved,
      audit: auditDictionary(saved),
    });
  } catch (e) {
    json(res, e.status || 400, { error: e.message });
  }
}

function apiDictionaryDelete(res, id) {
  try {
    json(res, 200, deleteDictionary(id, ROOT));
  } catch (e) {
    json(res, e.status || 400, { error: e.message });
  }
}

function dumpHttpError(res, e) {
  const bulky = String(e.message || '').includes('велико');
  json(res, e.status || (bulky ? 413 : 400), { error: e.message });
}

function apiDumpsList(res) {
  try {
    json(res, 200, { dumps: listDumps(ROOT), catalog: listShopCategories(ROOT) });
  } catch (e) {
    dumpHttpError(res, e);
  }
}

function apiDumpGet(res, id) {
  try {
    json(res, 200, getDump(id, ROOT));
  } catch (e) {
    dumpHttpError(res, e);
  }
}

function apiDumpPreview(res, id, params) {
  try {
    json(res, 200, previewDump(id, {
      q: params.get('q') || '',
      offset: params.get('offset'),
      limit: params.get('limit'),
    }, ROOT));
  } catch (e) {
    dumpHttpError(res, e);
  }
}

async function apiDumpPut(req, res, id) {
  try {
    const raw = await readBody(req, DUMP_LIMITS.MAX_DUMP_BYTES);
    const parsed = parseDumpPayload(raw, `data_${id}.json`);
    json(res, 200, saveDump(id, parsed.products, ROOT, { name: parsed.name }));
  } catch (e) {
    dumpHttpError(res, e);
  }
}

function apiDumpDelete(res, id) {
  try {
    json(res, 200, deleteDump(id, ROOT));
  } catch (e) {
    dumpHttpError(res, e);
  }
}

async function apiDumpRestore(req, res, id) {
  const raw = await readBody(req, 64_000);
  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Тело запроса не JSON' }); }
  try {
    json(res, 200, restoreDumpArchive(id, body.file || body.filename, ROOT));
  } catch (e) {
    dumpHttpError(res, e);
  }
}

/** Заготовка строки атрибута для кнопки «Добавить» в UI. */
function apiDictionaryBlankAttr(res) {
  json(res, 200, { attr: blankAttribute({ code: 'new_attr', name: 'Новый атрибут', order: 100 }) });
}

/** Аудит схемы категории: мусор, дубликаты, пустые ENUM при facet.enabled. */
function apiDictionaryAudit(res, id) {
  try {
    const attrs = readDictionaryAttrs(id, ROOT);
    const report = auditDictionary(attrs);
    json(res, 200, {
      id: String(id),
      name: categoryName(id, ROOT),
      file: `dictionaries/attributes_${id}.json`,
      ...report,
    });
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
}

/**
 * Превью фильтров из schema (+ опциональные products с normalized attrs).
 * Body: { products?: [{ attrs }] } — без тела только каноны схемы (count=0).
 */
async function apiDictionaryFilterPreview(req, res, id) {
  let products = [];
  if (req.method === 'POST') {
    const raw = await readBody(req, 8_000_000);
    if (raw && String(raw).trim()) {
      let body;
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Тело запроса не JSON' }); }
      products = Array.isArray(body) ? body : (body?.products || body?.recs || []);
    }
  }
  try {
    const attrs = readDictionaryAttrs(id, ROOT);
    json(res, 200, {
      id: String(id),
      name: categoryName(id, ROOT),
      ...previewFilters(attrs, products),
    });
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
}

/** Проверка атрибуции на одном товаре { product }. */
async function apiDictionaryProbe(req, res, id) {
  const raw = await readBody(req, 2_000_000);
  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Тело запроса не JSON' }); }
  const product = body?.product || body;
  try {
    const attrs = readDictionaryAttrs(id, ROOT);
    json(res, 200, {
      id: String(id),
      ...probeProductAttribution(attrs, product),
    });
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
}

/** Ключи из дампа раздела — для textarea «Импорт списка». Ничего не пишет. */
function apiDictionaryFromDump(res, id) {
  try {
    json(res, 200, harvestDumpAttrLines(id, ROOT));
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
}

/**
 * Импорт списка характеристик → AI/эвристика раскладывает по атрибутам.
 * Body: { text, model?, provider?, mode?: 'ai'|'heuristic', attrs? }
 * attrs — незакоммиченный черновик из UI; иначе файл на диске.
 */
async function apiDictionaryImportSuggest(req, res, id) {
  const raw = await readBody(req, 2_000_000);
  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Тело запроса не JSON' }); }

  const text = body?.text ?? body?.list ?? '';
  const items = parseImportLines(text);
  if (!items.length) return json(res, 400, { error: 'пустой список — вставьте строки характеристик' });
  if (items.length > 400) return json(res, 400, { error: 'слишком длинный список (макс. 400 строк)' });

  let attrs;
  try {
    attrs = Array.isArray(body?.attrs) && body.attrs.length
      ? body.attrs
      : readDictionaryAttrs(id, ROOT);
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }

  const mode = body?.mode === 'heuristic' ? 'heuristic' : 'ai';
  const name = categoryName(id, ROOT);

  if (mode === 'heuristic') {
    const suggestions = heuristicSuggest(items, attrs).map(s => ({
      ...s,
      selected: s.action !== 'skip',
    }));
    return json(res, 200, {
      id: String(id),
      name,
      mode: 'heuristic',
      items,
      suggestions,
      usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
    });
  }

  const settings = loadSettings(ROOT);
  const prov = resolveProvider(settings, body?.provider);
  const ep = providerEndpoint(prov);
  const apiKey = ep.apiKey || API_KEY;
  if (!apiKey) {
    // Без ключа — эвристика, чтобы UI всё равно работал.
    const suggestions = heuristicSuggest(items, attrs).map(s => ({
      ...s,
      selected: s.action !== 'skip',
      note: (s.note ? s.note + ' · ' : '') + `нет ключа «${prov.name}» — эвристика`,
    }));
    return json(res, 200, {
      id: String(id),
      name,
      mode: 'heuristic',
      fallback: 'no_api_key',
      items,
      suggestions,
      usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
    });
  }

  const model = String(body?.model || settings.run?.model || 'deepseek/deepseek-v3.2').trim();
  const system = buildImportSuggestPrompt(attrs, { categoryName: name, catId: id });
  const user = buildImportUserContent(items);
  const chatUrl = ep.chatUrl || `${String(ep.baseUrl || '').replace(/\/$/, '')}/chat/completions`;
  const timeoutMs = Number(settings.run?.timeout_ms) || 90_000;
  const maxTokens = Math.min(8000, Number(settings.run?.max_tokens) || 4000);

  let resHttp;
  let bodyText;
  try {
    resHttp = await fetch(chatUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(ep.headers || {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        usage: { include: true },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    bodyText = await resHttp.text();
  } catch (e) {
    const timed = e.name === 'TimeoutError' || e.cause?.name === 'TimeoutError';
    return json(res, 502, {
      error: timed ? `таймаут модели ${timeoutMs}ms` : (e.message || 'сеть'),
    });
  }

  let data;
  try { data = JSON.parse(bodyText); } catch { data = null; }
  if (!resHttp.ok || data?.error) {
    const msg = data?.error?.message || `HTTP ${resHttp.status}: ${String(bodyText).slice(0, 160)}`;
    return json(res, 502, { error: msg });
  }

  const content = data?.choices?.[0]?.message?.content || '';
  let suggestions;
  try {
    suggestions = parseModelSuggestions(content, items);
  } catch (e) {
    return json(res, 502, { error: e.message || 'не разобрали ответ модели', raw: String(content).slice(0, 500) });
  }

  const usage = data?.usage || {};
  json(res, 200, {
    id: String(id),
    name,
    mode: 'ai',
    model,
    provider: prov.id,
    items,
    suggestions,
    usage: {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      cost: usage.cost ?? null,
    },
  });
}

/** Применить выбранные proposals к attrs (черновик или файл). Не пишет диск, если dry_run. */
async function apiDictionaryImportApply(req, res, id) {
  const raw = await readBody(req, 2_000_000);
  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Тело запроса не JSON' }); }

  let attrs;
  try {
    attrs = Array.isArray(body?.attrs) && body.attrs.length
      ? body.attrs
      : readDictionaryAttrs(id, ROOT);
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }

  const suggestions = Array.isArray(body?.suggestions) ? body.suggestions : [];
  if (!suggestions.length) return json(res, 400, { error: 'нет suggestions' });

  const result = applySuggestions(attrs, suggestions);
  const save = body?.save === true || body?.persist === true;
  if (save) {
    try {
      const coerced = result.attrs.map(a => coerceFacetForType(a));
      const saved = saveDictionaryAttrs(id, coerced, ROOT);
      return json(res, 200, {
        id: String(id),
        name: categoryName(id, ROOT),
        saved: true,
        applied: result.applied,
        created: result.created,
        skipped: result.skipped,
        attrs: saved,
        audit: auditDictionary(saved),
      });
    } catch (e) {
      return json(res, e.status || 400, { error: e.message });
    }
  }

  json(res, 200, {
    id: String(id),
    name: categoryName(id, ROOT),
    saved: false,
    applied: result.applied,
    created: result.created,
    skipped: result.skipped,
    attrs: result.attrs.map(a => coerceFacetForType(a)),
  });
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
  const builtin = defaultSystemPromptTemplate();
  const prompts = settings?.model?.system_prompts || [];
  const cat = category || CATEGORIES[0]?.slug || 'kholodilniki';
  const resolved = resolveSystemPrompt(cat, prompts, settings?.model?.system_prompt);
  const custom = String(resolved || '').trim();
  const template = custom || builtin;
  return {
    template: custom,
    default_template: builtin,
    custom: !!custom,
    placeholders: PROMPT_PLACEHOLDERS,
    preview: buildSystemPrompt(cat, template),
    preview_category: cat,
    prompts: prompts.map(p => {
      const tpl = String(p.template || '').trim();
      return {
        id: p.id,
        name: p.name,
        scope: p.scope,
        template: p.template || '',
        custom: !!tpl && tpl !== builtin,
      };
    }),
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
    export_templates: exportTemplatesView(settings.export_templates),
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
      export_templates: exportTemplatesView(settings.export_templates),
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
  const resolved = resolveSystemPrompt(category, settings.model?.system_prompts, settings.model?.system_prompt);
  const custom = String(resolved || '').trim();
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

  // Фильтр по всему разделу. При справочнике значения фасетов — из
  // характеристик товаров (annotation → attrs), не из прозы описания.
  let f;
  if (hasDictionary(cat.id, ROOT)) {
    try {
      const dict = loadDictionary(String(cat.id), ROOT);
      const config = loadConfig(ROOT);
      const recs = cat.products.map(p => normalizeProduct(p, dict, config));
      const built = buildDictFilters(recs, dict, config);
      f = {
        category_id: cat.id,
        category: cat.name,
        url: cat.url,
        products_total: cat.items.length,
        filters: built.filters,
        source: 'characteristics',
      };
    } catch {
      f = buildFilters(cat, cat.items);
    }
  } else {
    f = buildFilters(cat, cat.items);
  }
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
 * раздела, а по адресу фида и лежат в нём вперемешку по категориям.
 *
 * При наличии справочника — тот же путь, что CLI/export: характеристики
 * (annotation) → нормализованные attrs → filters. Иначе legacy catalog
 * (бренд/цена + enriched.specs).
 */
async function apiFilters(req, res) {
  const raw = await readBody(req, BULK_BODY_LIMIT);
  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Тело запроса не JSON' }); }

  const { products, category_id = null, category = null, url = null } = body || {};
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
    const out = await buildFiltersOnly(products, {
      dict,
      config,
      root: ROOT,
      filtersAgent: filtersAgentOptions({ ...body, category_name: categoryName(dict.catId, ROOT) }),
    });
    if (!out.validation?.ok) {
      return json(res, 422, {
        error: 'filters не прошли проверку чистоты',
        ...out,
      });
    }
    return json(res, 200, {
      category_id: dict.catId,
      category: categoryName(dict.catId, ROOT),
      url,
      products_total: products.length,
      filters: out.filters,
      filters_file: { filters: out.filters },
      filters_agent: out.filters_agent,
      source: 'characteristics',
    });
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
      try {
        const schema = schemaForProduct(p || {}, category);
        return { ...isEnrichable(p || {}, schema), conflicts: productFacts(p || {}, schema).conflicts };
      } catch (e) {
        if (e?.code === 'DICT_UNAVAILABLE') {
          return {
            ok: false,
            reason: e.message,
            needs_review: true,
            conflicts: [],
            resolved_category: e.resolved_category,
          };
        }
        throw e;
      }
    }),
  });
}

/**
 * Опции filters_agent для export / filters/build.
 * mode=heuristic|ai|auto; без ключа — эвристика.
 */
function filtersAgentOptions(body = {}) {
  const settings = loadSettings(ROOT);
  const prov = resolveProvider(settings, body?.provider);
  const ep = providerEndpoint(prov);
  const apiKey = ep.apiKey || API_KEY;
  const mode = body?.filters_agent === 'heuristic' || body?.mode === 'heuristic'
    ? 'heuristic'
    : (body?.filters_agent === 'ai' || body?.mode === 'ai' ? 'ai' : 'auto');
  return {
    mode,
    model: String(body?.model || settings.run?.model || '').trim(),
    timeoutMs: Number(settings.run?.timeout_ms) || 90_000,
    maxTokens: Math.min(8000, Number(settings.run?.max_tokens) || 4000),
    categoryName: body?.category_name || '',
    provider: apiKey ? {
      apiKey,
      baseUrl: ep.baseUrl,
      chatUrl: ep.chatUrl,
      headers: ep.headers,
      model: settings.run?.model,
    } : null,
  };
}

/** Убрать внутренние поля (_built…) из ответа клиенту. */
function publicExportPayload(out) {
  if (!out || typeof out !== 'object') return out;
  const {
    _built, _exported, _productsOut, ...pub
  } = out;
  return pub;
}

/** name в JSON v2: serializeProduct его не отдаёт, каталог склеивает по id. */
function withCatalogNames(productsOut, sources) {
  const names = new Map();
  for (const s of sources || []) {
    const id = s?.id ?? s?.sku;
    if (id == null) continue;
    const name = s.name || s.title;
    if (name) names.set(String(id), name);
  }
  return (productsOut || []).map((row) => {
    const { id, name: existing, ...rest } = row;
    return { id, name: existing ?? names.get(String(id)) ?? null, ...rest };
  });
}

/**
 * JSON v2 / витрина заказчика: если в пакете есть ответ модели, дамп без ИИ
 * в файл не примешиваем. Карточки дампа уже с annotation — иначе buildCustomerExport
 * сериализует весь data_*.json как «готовый» каталог.
 * Пакет без enriched (CLI: дамп → products_*.json) оставляем как есть.
 */
function productsForExport(products) {
  const list = Array.isArray(products) ? products : [];
  const ready = list.filter(p => {
    const e = p?.enriched;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
    const specs = e.specs;
    if (specs && typeof specs === 'object' && !Array.isArray(specs) && Object.keys(specs).length) return true;
    return Boolean(String(e.description || e.short_description || '').trim());
  });
  return ready.length ? ready : list;
}

/**
 * Выгрузка v2: POST { products, category } → { products, filters, held }.
 * Те же правила, что /api/export: dict → customer; known cat без dict → 422;
 * неизвестная категория → buildV2 без silent-gold по известному разделу.
 */
async function apiExportV2(req, res) {
  const raw = await readBody(req, BULK_BODY_LIMIT);
  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Тело запроса не JSON' }); }

  const { products: rawProducts, category, category_id } = body || {};
  if (!Array.isArray(rawProducts) || !rawProducts.length) {
    return json(res, 400, { error: 'Не передан список товаров' });
  }
  const products = productsForExport(rawProducts);
  const catKey = category ?? category_id
    ?? products.find(p => p.category)?.category
    ?? products.find(p => p.category_id)?.category_id;
  const dict = dictForProducts(products, catKey, ROOT);
  const expectedId = expectedDictCatId(products, catKey, ROOT);
  if (dict) {
    let config;
    try { config = loadConfig(ROOT); }
    catch { return json(res, 500, { error: 'не прочитался config.json' }); }
    const out = await buildCustomerExport(products, {
      dict, config, root: ROOT,
      filtersAgent: filtersAgentOptions({ ...body, category_name: categoryName(dict.catId, ROOT) }),
    });
    if (!out.validation?.ok) {
      return json(res, 422, {
        error: 'filters не прошли проверку чистоты',
        validation: out.validation,
        filters_agent: out.filters_agent,
        held: out.held,
      });
    }
    if (!out.products.length) {
      return json(res, 400, { error: 'нет товаров с полными характеристиками', held: out.held });
    }
    const pub = publicExportPayload(out);
    return json(res, 200, { ...pub, products: withCatalogNames(pub.products, products) });
  }
  if (expectedId) {
    return json(res, 422, {
      error: `категория ${expectedId} определена, но справочник attributes_${expectedId}.json недоступен`,
      needs_review: true,
      resolved_category: expectedId,
    });
  }
  const out = buildV2(products, {});
  if (!out.products.length) return json(res, 400, { error: 'Нет обогащённых товаров — в v2 нечего выгружать' });
  json(res, 200, { ...out, products: withCatalogNames(out.products, products) });
}

/**
 * Выгрузка заказчика: POST { products, category } → { products, filters, held }.
 * Справочник резолвится — только buildCustomerExport. Gold — лишь когда
 * категория реально неизвестна; filters тогда пустые + needs_review.
 */
async function apiExport(req, res) {
  const raw = await readBody(req, BULK_BODY_LIMIT);
  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Тело запроса не JSON' }); }

  const { products: rawProducts, category, category_id } = body || {};
  if (!Array.isArray(rawProducts) || !rawProducts.length) {
    return json(res, 400, { error: 'Не передан список товаров' });
  }
  const products = productsForExport(rawProducts);
  const catKey = category ?? category_id
    ?? products.find(p => p.category)?.category
    ?? products.find(p => p.category_id)?.category_id;
  const dict = dictForProducts(products, catKey, ROOT);
  const expectedId = expectedDictCatId(products, catKey, ROOT);
  const sample = products[0] || {};
  const logExport = (exportPath) => {
    const id = sample.id ?? sample.sku ?? null;
    const dictFile = dict
      ? path.relative(ROOT, dictionaryPath(dict.catId, ROOT))
      : (expectedId ? `attributes_${expectedId}.json (missing)` : null);
    console.log(
      `[export] id=${id} category=${catKey ?? ''} resolved=${expectedId ?? ''} `
      + `dict=${dictFile ?? '—'} path=${exportPath}`,
    );
  };

  if (dict) {
    logExport('customer');
    let config;
    try { config = loadConfig(ROOT); }
    catch { return json(res, 500, { error: 'не прочитался config.json' }); }
    const out = await buildCustomerExport(products, {
      dict, config, root: ROOT,
      filtersAgent: filtersAgentOptions({ ...body, category_name: categoryName(dict.catId, ROOT) }),
    });
    if (!out.validation?.ok) {
      return json(res, 422, {
        error: 'filters не прошли проверку чистоты',
        validation: out.validation,
        filters_agent: out.filters_agent,
        held: out.held,
      });
    }
    if (!out.products.length) {
      return json(res, 400, { error: 'нет товаров с полными характеристиками', held: out.held });
    }
    return json(res, 200, publicExportPayload(out));
  }

  if (expectedId) {
    logExport('error');
    return json(res, 422, {
      error: `категория ${expectedId} определена, но справочник attributes_${expectedId}.json недоступен`,
      needs_review: true,
      resolved_category: expectedId,
    });
  }

  logExport('gold');
  const out = buildGoldShapeExport(products);
  if (!out.products.length) {
    return json(res, 400, { error: 'Нет товаров для выгрузки' });
  }
  return json(res, 200, out);
}

/**
 * Отдельный сбор filters после обогащения.
 * POST { products, category, mode? } → { filters, validation, filters_agent, debug }.
 */
async function apiFiltersBuild(req, res) {
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
    const expectedId = expectedDictCatId(products, catKey, ROOT);
    return json(res, expectedId ? 422 : 400, {
      error: expectedId
        ? `категория ${expectedId} определена, но справочник недоступен`
        : 'нужен справочник attributes_{id}.json',
      needs_review: true,
    });
  }
  let config;
  try { config = loadConfig(ROOT); }
  catch { return json(res, 500, { error: 'не прочитался config.json' }); }

  const out = await buildFiltersOnly(products, {
    dict,
    config,
    root: ROOT,
    filtersAgent: filtersAgentOptions({ ...body, category_name: categoryName(dict.catId, ROOT) }),
  });
  if (!out.validation?.ok) {
    return json(res, 422, {
      error: 'filters не прошли проверку чистоты',
      ...out,
    });
  }
  return json(res, 200, out);
}

/**
 * Обогащение одного товара — один путь для /api/enrich и для фонового прогона
 * (jobs.js). Возвращает то же тело, что уходит в браузер; при провале бросает
 * ошибку с .status и .usage, чтобы потраченное на неудачные попытки не терялось.
 */
async function enrichOne(product, { model, category, provider, onNote = () => {} } = {}) {
  // Категория определяет схему полей и промпт. Явное поле важнее, иначе берём
  // category самого товара — её проставляет и фид, и обход раздела.
  const settings = loadSettings(ROOT);
  const prov = resolveProvider(settings, provider);
  const ep = providerEndpoint(prov);
  const apiKey = ep.apiKey || API_KEY;
  const note = (msg, meta) => { try { onNote(msg, meta); } catch { /* лог клиента не роняет прогон */ } };
  const productMeta = {
    name: product?.name || product?.title || null,
    sku: product?.sku != null ? String(product.sku) : null,
    id: product?.id != null ? String(product.id) : null,
    category: product?.category || category || null,
  };

  const parseTrace = { card: null, web: null, cardOrigin: null, webOrigin: null, webUrl: null, cardFile: null };
  const parseBundle = () => {
    const card = slimParseTrace(parseTrace.card);
    const web = slimParseTrace(parseTrace.web);
    if (!card && !web) return null;
    return {
      ...(card ? {
        card: {
          ...card,
          origin: parseTrace.cardOrigin || 'карточка',
          ...(parseTrace.cardFile ? { file: parseTrace.cardFile } : {}),
        },
      } : {}),
      ...(web ? {
        web: {
          ...web,
          origin: parseTrace.webOrigin || 'сеть',
          url: parseTrace.webUrl || null,
        },
      } : {}),
    };
  };

  /** Поля раздела «Логи» из debug enrichProduct / modelNotCalledDebug. */
  const detailTrace = (debug, extra = {}) => {
    const parse = extra.parse !== undefined ? extra.parse : parseBundle();
    return {
      source_text: debug?.source_text ?? null,
      system_prompt: debug?.system_prompt ?? null,
      user_content: debug?.user_content ?? null,
      raw_response: debug?.raw_response ?? null,
      enriched: extra.enriched !== undefined
        ? extra.enriched
        : (debug?.enriched_result ?? null),
      model_status: debug?.model_status ?? null,
      model_called: debug?.model_called ?? null,
      ...(debug?.error ? { error: debug.error } : {}),
      ...(parse ? { parse } : {}),
    };
  };

  let schema;
  try {
    schema = schemaForProduct(product, category, ROOT);
  } catch (e) {
    if (e?.code === 'DICT_UNAVAILABLE') {
      const dbgInfo = e.dict_debug || dictDebugInfo(e.resolved_category, ROOT);
      dbgInfo.productId = productMeta.id || productMeta.sku;
      const debugText = formatDictDebug(dbgInfo);
      note(debugText, { step: 'schema', level: 'warn' });
      console.warn(debugText);
      note(`needs_review: ${e.message}`, { step: 'schema', level: 'warn' });
      const dbg = modelNotCalledDebug(product, e.message);
      return {
        enriched: null,
        needs_review: true,
        validation_issues: [{ field: 'schema', reason: e.message, kind: 'dict_unavailable' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
        detail: {
          product: productMeta,
          schema: '_unavailable',
          provider: prov.id,
          model,
          status: 'needs_review',
          validation_issues: [{ field: 'schema', reason: e.message }],
          resolved_category: e.resolved_category,
          dict_debug: dbgInfo,
          dict_debug_text: debugText,
          ...detailTrace(dbg, { enriched: null }),
        },
      };
    }
    throw e;
  }
  note(`Схема «${schema.slug}» · провайдер «${prov.name}» · dict=${schema.fromDictionary ? `attributes_${schema.id}.json` : 'builtin'}`, { step: 'schema' });

  const skip = reason => {
    const dbg = modelNotCalledDebug(product, reason);
    const parse = parseBundle();
    return {
      enriched: null,
      skipped:  reason,
      ...(parse ? { parse } : {}),
      usage:    { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
      detail: {
        product: productMeta,
        schema: schema.slug,
        provider: prov.id,
        model,
        status: 'skip',
        skipped: reason,
        steps: [],
        ...detailTrace(dbg, { enriched: null, parse }),
      },
    };
  };

  // Дамп заказчика — исходник. Смотрим его до пропуска: пустая карточка
  // магазина с полной таблицей в data_{id}.json не должна уходить в skip.
  const fromDump = hydrateFromDump(product, schema, ROOT);
  const prepared = fromDump.product;
  if (fromDump.dump && fromDump.thin) {
    note(`В дампе мало характеристик (${fromDump.facts}) — парсим карточку`, { step: 'web' });
  } else if (fromDump.dump) {
    note(`Дамп: ${fromDump.facts} характеристик`, { step: 'gate' });
  }

  const publishParse = (msgs = []) => {
    const parse = parseBundle();
    if (!msgs.length) {
      if (parse) note('', { step: 'parse', parse });
      return;
    }
    msgs.forEach((msg, i) => {
      note(msg, { step: 'parse', ...(i === msgs.length - 1 && parse ? { parse } : {}) });
    });
  };

  parseTrace.card = collectParseHits(prepared, schema.dict);
  parseTrace.cardOrigin = fromDump.dump ? 'дамп' : 'карточка';
  parseTrace.cardFile = fromDump.dump && schema.id != null ? `data_${schema.id}.json` : null;
  publishParse(formatParseNotes(parseTrace.card, { origin: parseTrace.cardOrigin }));

  // Дешёвый вердикт без сети: своего текста нет и в названии не за что
  // зацепиться (нет ни артикула, ни бренда/модели) — искать нечего.
  const first = isEnrichable(prepared, schema);
  if (!first.ok && !first.web) {
    note(`Предпроверка: пропуск — ${first.reason}`, { step: 'gate', level: 'skip' });
    return skip(first.reason);
  }
  if (!first.ok && first.web) {
    note(`Предпроверка: своего текста нет — ищем описание в сети`, { step: 'gate' });
  } else if (needsWebSpecs(prepared, schema)) {
    note(`Предпроверка: мало характеристик (${first.facts ?? 0}) — доберём со страницы в сети`, { step: 'gate' });
  } else {
    note(`Предпроверка: ок, есть исходный текст`, { step: 'gate' });
  }

  if (!apiKey) {
    const e = new Error(`нет ключа у провайдера «${prov.name}»`);
    e.status = 400;
    const dbg = modelNotCalledDebug(product, e.message);
    e.detail = {
      product: productMeta,
      schema: schema.slug,
      provider: prov.id,
      model,
      status: 'error',
      error: e.message,
      ...detailTrace(dbg, { enriched: null }),
    };
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
      const dbg = modelNotCalledDebug(product, e.message);
      e.detail = {
        product: productMeta,
        schema: schema.slug,
        provider: prov.id,
        model,
        status: 'error',
        error: e.message,
        ...detailTrace(dbg, { enriched: null }),
      };
      throw e;
    }
  } catch (e) {
    // Список недоступен — не блокируем работу, шлём как есть. А вот вердикт
    // «модели нет» — это ответ, а не сбой справочника.
    if (e.status === 400) throw e;
  }

  note(`Модель ${model}`, { step: 'model' });

  // Пустая или бедная карточка — описание из сети (после дампа). Карточка
  // с достаточным числом фактов, но без страны — отдельный поиск только
  // страны по модели. ensureSource сам решает, что искать.
  note(`Готовим исходный текст (сеть при необходимости)`, { step: 'web' });
  const found = await ensureSource(prepared, schema, {
    onNote: (msg, meta = {}) => note(msg, { step: meta.step || 'web', level: meta.level, parse: meta.parse }),
    root: ROOT,
  });
  if (found.page_parse) {
    parseTrace.web = found.page_parse;
    parseTrace.webUrl = found.source || null;
    if (found.source) {
      try { parseTrace.webOrigin = new URL(found.source).hostname.replace(/^www\./, ''); }
      catch { parseTrace.webOrigin = 'сеть'; }
    } else {
      parseTrace.webOrigin = 'сеть';
    }
    publishParse();
  }
  if (!found.gate.ok) {
    note(`После поиска: пропуск — ${found.gate.reason}`, { step: 'gate', level: 'skip' });
    return skip(found.gate.reason);
  }
  const filled = found.product;
  let sourceUrl = found.source ?? null;
  const parserUsed = Boolean(found.parser || sourceUrl);
  if (sourceUrl) note(`Исходный текст готов (сеть: ${sourceUrl})`, { step: 'web' });
  else if (parserUsed) note(`Парсер запускался, своего текста хватает — отправляем в модель`, { step: 'web' });
  else note(`Исходный текст готов, отправляем в модель`, { step: 'model' });

  note(`Отправляем в модель ${model}`, { step: 'model' });
  try {
    const { enriched, iT, oT, cost, costSource, attempts, debug, needs_review, validation_issues, raw_response, corrected } = await enrichProduct(filled, {
      model, apiKey, schema,
      root: ROOT,
      limiter: limiterFor(`${prov.id}:${model}`),
      pricing: pricingOf(entry),
      chatUrl: ep.chatUrl,
      headers: ep.headers,
      mismatchPolicy: process.env.MISMATCH_POLICY || settings.conditions.mismatch_policy,
      maxRetries: Math.min(2, settings.model.max_retries || 2),
      timeoutMs: settings.model.timeout_ms,
      maxTokens: settings.model.max_tokens,
      systemPrompt: resolveSystemPrompt(schema, settings.model.system_prompts, settings.model.system_prompt),
      referer: ep.headers['HTTP-Referer'] || 'https://mrmag.ru',
      title: ep.headers['X-Title'] || 'Ogran',
      onNote: msg => note(msg, { step: /retry|rate limit|обрыв|parse|валидац|расхожден|дамп|проверку|правка|правим/i.test(msg) ? 'retry' : 'model', level: /retry|обрыв|parse|валидац|расхожден|дамп|проверку/i.test(msg) ? 'warn' : 'info' }),
    });

    const origin = {
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
      ...(parserUsed ? { parser: true } : {}),
      ...(corrected ? { corrected: true } : {}),
      ...(parseBundle() ? { parse: parseBundle() } : {}),
    };

    if (needs_review && !enriched) {
      note(`needs_review: ${(validation_issues || []).map(i => i.field).join(', ')}`, { step: 'validate', level: 'warn' });
      const preview = debug?.enriched_result ?? null;
      return {
        enriched: preview,
        needs_review: true,
        validation_issues: validation_issues || [],
        schema: schema.slug,
        provider: prov.id,
        ...origin,
        usage: { prompt_tokens: iT, completion_tokens: oT, cost, cost_source: costSource, attempts },
        detail: {
          product: productMeta,
          schema: schema.slug,
          provider: prov.id,
          model,
          status: 'needs_review',
          validation_issues: validation_issues || [],
          ...origin,
          usage: { prompt_tokens: iT, completion_tokens: oT, cost, cost_source: costSource, attempts },
          ...detailTrace({
            ...debug,
            raw_response: raw_response ?? debug?.raw_response ?? null,
          }, {
            enriched: preview,
          }),
        },
      };
    }

    return {
      enriched,
      schema: schema.slug,
      provider: prov.id,
      ...origin,
      usage: { prompt_tokens: iT, completion_tokens: oT, cost, cost_source: costSource, attempts },
      detail: {
        product: productMeta,
        schema: schema.slug,
        provider: prov.id,
        model,
        status: 'ok',
        ...origin,
        usage: { prompt_tokens: iT, completion_tokens: oT, cost, cost_source: costSource, attempts },
        ...detailTrace(debug, { enriched }),
      },
    };
  } catch (e) {
    const dbg = e.debug || modelNotCalledDebug(filled || product, e.message);
    e.detail = {
      product: productMeta,
      schema: schema.slug,
      provider: prov.id,
      model,
      status: 'error',
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
      usage: e.usage
        ? { prompt_tokens: e.usage.iT ?? 0, completion_tokens: e.usage.oT ?? 0, cost: e.usage.cost ?? 0 }
        : null,
      ...detailTrace(dbg, { enriched: dbg.enriched_result ?? null }),
      model_status: dbg.model_status || (dbg.model_called ? 'MODEL_ERROR' : 'MODEL_NOT_CALLED'),
      error: e.message,
    };
    throw e;
  }
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
  const detailPos = u.searchParams.get('detailPos');
  json(res, 200, store.state(job, {
    from:      u.searchParams.get('from'),
    logFrom:   u.searchParams.get('logFrom'),
    products:  u.searchParams.get('products') === '1',
    details:   u.searchParams.get('details') === '1',
    detailPos: detailPos != null && detailPos !== '' ? detailPos : null,
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
  if (urlPath === '/' || urlPath === '/' + PAGE) {
    return sendHtml(res, 200, path.join(ROOT, PAGE));
  }
  if (urlPath === '/schema_constructor.js') {
    const file = path.join(ROOT, 'schema_constructor.js');
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Не найдено');
    }
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  return res.end('Не найдено');
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
    if (req.method === 'GET'  && u.pathname === '/api/dumps') return apiDumpsList(res);
    const dumpPreview = u.pathname.match(/^\/api\/dumps\/(\d+)\/preview$/);
    if (dumpPreview && req.method === 'GET') return apiDumpPreview(res, dumpPreview[1], u.searchParams);
    const dumpRestore = u.pathname.match(/^\/api\/dumps\/(\d+)\/restore$/);
    if (dumpRestore && req.method === 'POST') return await apiDumpRestore(req, res, dumpRestore[1]);
    const dumpRoute = u.pathname.match(/^\/api\/dumps\/(\d+)$/);
    if (dumpRoute) {
      const id = dumpRoute[1];
      if (req.method === 'GET') return apiDumpGet(res, id);
      if (req.method === 'PUT') return await apiDumpPut(req, res, id);
      if (req.method === 'DELETE') return apiDumpDelete(res, id);
    }
    if (req.method === 'GET'  && u.pathname === '/api/dictionaries') return apiDictionariesList(res);
    if (req.method === 'POST' && u.pathname === '/api/dictionaries') return await apiDictionaryCreate(req, res);
    if (req.method === 'GET'  && u.pathname === '/api/dictionaries/blank-attr') return apiDictionaryBlankAttr(res);
    const dictAudit = u.pathname.match(/^\/api\/dictionaries\/(\d+)\/audit$/);
    if (dictAudit && req.method === 'GET') return apiDictionaryAudit(res, dictAudit[1]);
    const dictPreview = u.pathname.match(/^\/api\/dictionaries\/(\d+)\/filter-preview$/);
    if (dictPreview && (req.method === 'GET' || req.method === 'POST')) {
      return await apiDictionaryFilterPreview(req, res, dictPreview[1]);
    }
    const dictProbe = u.pathname.match(/^\/api\/dictionaries\/(\d+)\/probe$/);
    if (dictProbe && req.method === 'POST') return await apiDictionaryProbe(req, res, dictProbe[1]);
    const dictFromDump = u.pathname.match(/^\/api\/dictionaries\/(\d+)\/from-dump$/);
    if (dictFromDump && req.method === 'GET') return apiDictionaryFromDump(res, dictFromDump[1]);
    const dictImportSuggest = u.pathname.match(/^\/api\/dictionaries\/(\d+)\/import-suggest$/);
    if (dictImportSuggest && req.method === 'POST') {
      return await apiDictionaryImportSuggest(req, res, dictImportSuggest[1]);
    }
    const dictImportApply = u.pathname.match(/^\/api\/dictionaries\/(\d+)\/import-apply$/);
    if (dictImportApply && req.method === 'POST') {
      return await apiDictionaryImportApply(req, res, dictImportApply[1]);
    }
    const dictRoute = u.pathname.match(/^\/api\/dictionaries\/(\d+)$/);
    if (dictRoute) {
      const [, id] = dictRoute;
      if (req.method === 'GET') return apiDictionaryGet(res, id);
      if (req.method === 'PUT') return await apiDictionaryPut(req, res, id);
      if (req.method === 'DELETE') return apiDictionaryDelete(res, id);
    }
    if (req.method === 'POST' && u.pathname === '/api/filters/build') return await apiFiltersBuild(req, res);
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
  console.log(`  Дампы: ${dumpsDir(ROOT)}`);
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
