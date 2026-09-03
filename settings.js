/**
 * settings.js — гибкие настройки прогона: провайдеры ИИ, парсеры, условия.
 *
 * Источник — config.json (или SETTINGS_PATH в контейнере). Переменные окружения
 * по-прежнему перекрывают файл в момент вызова (WEB_LOOKUP=0, ключ провайдера),
 * но сами значения правятся из интерфейса и переживают перезапуск.
 *
 * Ключи в файл можно писать, но наружу они не уходят: GET отдаёт только
 * has_key / намёк из последних символов. Пустой api_key в PUT сохраняет прежний.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { configPath, loadConfig } from './pipeline/dict.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export const PROVIDER_KINDS = ['openai'];

/** Заготовки: пользователь добавляет провайдера в два клика, поля уже заполнены. */
export const PROVIDER_PRESETS = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_env: 'OPENROUTER_API_KEY',
    models_path: '/models',
    chat_path: '/chat/completions',
    headers: { 'HTTP-Referer': 'https://mrmag.ru', 'X-Title': 'mrmag enricher' },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    base_url: 'https://api.openai.com/v1',
    api_key_env: 'OPENAI_API_KEY',
    models_path: '/models',
    chat_path: '/chat/completions',
    headers: {},
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'openai',
    base_url: 'https://api.groq.com/openai/v1',
    api_key_env: 'GROQ_API_KEY',
    models_path: '/models',
    chat_path: '/chat/completions',
    headers: {},
  },
  {
    id: 'together',
    name: 'Together AI',
    kind: 'openai',
    base_url: 'https://api.together.xyz/v1',
    api_key_env: 'TOGETHER_API_KEY',
    models_path: '/models',
    chat_path: '/chat/completions',
    headers: {},
  },
  {
    id: 'ollama',
    name: 'Ollama (локально)',
    kind: 'openai',
    base_url: 'http://127.0.0.1:11434/v1',
    api_key_env: '',
    models_path: '/models',
    chat_path: '/chat/completions',
    headers: {},
    models: ['llama3.1', 'qwen2.5'],
  },
];

const FALLBACK_URLS = {
  mojeek: 'https://www.mojeek.com/search?q=%s',
  brave: 'https://search.brave.com/search?q=%s',
  ddg_lite: 'https://lite.duckduckgo.com/lite/?q=%s',
};

function slugId(raw, fallback = 'item') {
  const s = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || fallback;
}

function uniqueId(want, taken) {
  let id = slugId(want, 'item');
  if (!taken.has(id)) return id;
  for (let i = 2; i < 1000; i++) {
    const next = `${id.slice(0, 36)}-${i}`;
    if (!taken.has(next)) return next;
  }
  return `${id.slice(0, 24)}-${crypto.randomBytes(3).toString('hex')}`;
}

function isHttpUrl(s) {
  try {
    const u = new URL(String(s || ''));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function num(v, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function str(v, fallback = '') {
  return v == null ? fallback : String(v);
}

function joinUrl(base, p) {
  const b = String(base || '').replace(/\/+$/, '');
  const s = String(p || '');
  if (!s) return b;
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, '');
  return b + (s.startsWith('/') ? s : '/' + s);
}

export function defaultProvider() {
  return {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai',
    base_url: 'https://openrouter.ai/api/v1',
    api_key: '',
    api_key_env: 'OPENROUTER_API_KEY',
    enabled: true,
    default: true,
    models_path: '/models',
    chat_path: '/chat/completions',
    headers: { 'HTTP-Referer': 'https://mrmag.ru', 'X-Title': 'mrmag enricher' },
    models: [],
    notes: '',
  };
}

export function defaultConditions(raw = {}) {
  return {
    mismatch_policy: raw.mismatch_policy === 'strict' ? 'strict' : 'flag',
    min_source_chars: num(raw.min_source_chars, 100, { min: 0, max: 10_000 }),
    min_attrs: num(raw.min_attrs, 5, { min: 0, max: 50 }),
    facet_min_coverage: num(raw.facet_min_coverage, 70, { min: 0, max: 100 }),
    target_coverage: num(raw.target_coverage, 90, { min: 0, max: 100 }),
    fuzzy_min_score: num(raw.fuzzy_min_score, 0.93, { min: 0, max: 1 }),
  };
}

export function defaultSearch() {
  return {
    enabled: true,
    tries: 3,
    gap_ms: 3000,
    timeout_ms: 20_000,
    min_pairs: 3,
    query_suffix: 'характеристики',
    skip_hosts: ['mrmag.ru'],
    search_url: '',
    fallback_engines: ['mojeek', 'brave'],
    engines: [],
    duckduckgo: {
      enabled: true,
      endpoint: 'html',
      region: 'ru-ru',
      method: 'POST',
      safe_search: -1,
      site_filter: '',
      url: '',
    },
  };
}

function normalizeProvider(raw, { keepKey = '' } = {}) {
  const preset = PROVIDER_PRESETS.find(p => p.id === raw?.id) || {};
  const kind = PROVIDER_KINDS.includes(raw?.kind) ? raw.kind : 'openai';
  let apiKey;
  if (raw && Object.prototype.hasOwnProperty.call(raw, 'api_key') && raw.api_key === null) {
    apiKey = '';
  } else if (!raw?.api_key) {
    apiKey = keepKey;
  } else {
    apiKey = str(raw.api_key);
  }
  const models = Array.isArray(raw?.models)
    ? raw.models.map(m => String(m).trim()).filter(Boolean).slice(0, 200)
    : [];
  const headers = (raw?.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers))
    ? Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [String(k), String(v)]).filter(([k]) => k))
    : { ...(preset.headers || {}) };
  return {
    id: slugId(raw?.id || raw?.name, 'provider'),
    name: str(raw?.name || preset.name, 'Провайдер').slice(0, 80),
    kind,
    base_url: str(raw?.base_url || preset.base_url, 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    api_key: apiKey,
    api_key_env: str(raw?.api_key_env ?? preset.api_key_env).slice(0, 80),
    enabled: raw?.enabled !== false,
    default: raw?.default === true,
    models_path: str(raw?.models_path ?? preset.models_path, '/models'),
    chat_path: str(raw?.chat_path ?? preset.chat_path, '/chat/completions'),
    headers,
    models,
    notes: str(raw?.notes).slice(0, 500),
  };
}

function normalizeEngine(raw) {
  return {
    id: slugId(raw?.id || raw?.name, 'engine'),
    name: str(raw?.name, 'Поиск').slice(0, 80),
    url: str(raw?.url).trim(),
    enabled: raw?.enabled !== false,
  };
}

function normalizeSearch(raw = {}) {
  const base = defaultSearch();
  const ddg = raw.duckduckgo && typeof raw.duckduckgo === 'object' ? raw.duckduckgo : {};
  const skip = Array.isArray(raw.skip_hosts)
    ? raw.skip_hosts.map(h => String(h).trim()).filter(Boolean)
    : base.skip_hosts;
  const fallback = Array.isArray(raw.fallback_engines)
    ? raw.fallback_engines.map(s => String(s).trim()).filter(Boolean)
    : base.fallback_engines;
  const engines = Array.isArray(raw.engines) ? raw.engines.map(normalizeEngine).filter(e => e.url) : [];
  return {
    enabled: raw.enabled !== false,
    tries: num(raw.tries, base.tries, { min: 1, max: 10 }),
    gap_ms: num(raw.gap_ms, base.gap_ms, { min: 0, max: 60_000 }),
    timeout_ms: num(raw.timeout_ms, base.timeout_ms, { min: 1000, max: 120_000 }),
    min_pairs: num(raw.min_pairs, base.min_pairs, { min: 1, max: 50 }),
    query_suffix: str(raw.query_suffix, base.query_suffix).slice(0, 80),
    skip_hosts: skip.length ? skip : base.skip_hosts,
    search_url: str(raw.search_url),
    fallback_engines: fallback,
    engines,
    duckduckgo: {
      enabled: ddg.enabled !== false,
      endpoint: String(ddg.endpoint || 'html').toLowerCase() === 'lite' ? 'lite' : 'html',
      region: str(ddg.region, 'ru-ru').slice(0, 16),
      method: String(ddg.method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST',
      safe_search: num(ddg.safe_search, -1, { min: -2, max: 1 }),
      site_filter: str(ddg.site_filter).slice(0, 80),
      url: str(ddg.url),
    },
  };
}

function normalizeModel(raw = {}) {
  return {
    name: str(raw.name).slice(0, 120),
    prompt_version: str(raw.prompt_version, 'dict-v1').slice(0, 40),
    max_retries: num(raw.max_retries, 3, { min: 1, max: 8 }),
    timeout_ms: num(raw.timeout_ms, 60_000, { min: 5000, max: 300_000 }),
    max_tokens: num(raw.max_tokens, 3200, { min: 256, max: 16_000 }),
  };
}

function normalizeProviders(list, prev = []) {
  const prevById = new Map((prev || []).map(p => [p.id, p]));
  const src = Array.isArray(list) && list.length ? list : [defaultProvider()];
  const taken = new Set();
  const out = [];
  for (const raw of src) {
    const keepKey = prevById.get(raw?.id)?.api_key || '';
    const p = normalizeProvider(raw, { keepKey });
    p.id = uniqueId(p.id, taken);
    taken.add(p.id);
    out.push(p);
  }
  if (!out.length) out.push(defaultProvider());
  if (!out.some(p => p.default)) {
    const firstOn = out.find(p => p.enabled) || out[0];
    firstOn.default = true;
  }
  let seenDefault = false;
  for (const p of out) {
    if (p.default && seenDefault) p.default = false;
    else if (p.default) seenDefault = true;
  }
  return out;
}

/**
 * Сводит файл и значения по умолчанию. Старый config.json без секций
 * providers / conditions продолжает работать: недостающее дописывается в памяти.
 */
export function normalizeSettings(raw = {}, prev = null) {
  const conditionsIn = raw.conditions && typeof raw.conditions === 'object' ? raw.conditions : {};
  const conditions = defaultConditions({
    mismatch_policy: conditionsIn.mismatch_policy || process.env.MISMATCH_POLICY,
    min_source_chars: conditionsIn.min_source_chars ?? process.env.MIN_SOURCE_CHARS,
    min_attrs: conditionsIn.min_attrs ?? raw.description?.min_attrs,
    facet_min_coverage: conditionsIn.facet_min_coverage ?? raw.facet_min_coverage,
    target_coverage: conditionsIn.target_coverage ?? raw.target_coverage,
    fuzzy_min_score: conditionsIn.fuzzy_min_score ?? raw.fuzzy?.min_score,
  });
  return {
    facet_min_coverage: conditions.facet_min_coverage,
    target_coverage: conditions.target_coverage,
    description: { min_attrs: conditions.min_attrs },
    fuzzy: { min_score: conditions.fuzzy_min_score },
    model: normalizeModel(raw.model),
    search: normalizeSearch(raw.search),
    providers: normalizeProviders(raw.providers, prev?.providers),
    conditions,
  };
}

export function loadSettings(root = ROOT) {
  let raw = {};
  try { raw = loadConfig(root); } catch { /* пустой файл / первый запуск */ }
  return normalizeSettings(raw);
}

function hintOf(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 4) return '••••';
  return '••••' + s.slice(-4);
}

export function providerHasKey(p) {
  if (p?.api_key) return true;
  const envName = p?.api_key_env;
  return !!(envName && process.env[envName]);
}

export function providerKey(p) {
  if (p?.api_key) return p.api_key;
  const envName = p?.api_key_env;
  return (envName && process.env[envName]) || '';
}

/** То, что видит интерфейс: без секретов. */
export function publicProvider(p) {
  const envKey = p.api_key_env && process.env[p.api_key_env] ? process.env[p.api_key_env] : '';
  const stored = p.api_key || '';
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    base_url: p.base_url,
    api_key_env: p.api_key_env || '',
    enabled: p.enabled,
    default: p.default,
    models_path: p.models_path,
    chat_path: p.chat_path,
    headers: p.headers,
    models: p.models,
    notes: p.notes,
    has_key: !!(stored || envKey),
    key_hint: hintOf(stored || envKey),
    key_from: stored ? 'file' : envKey ? 'env' : 'none',
  };
}

export function publicSettings(settings) {
  return {
    ...settings,
    providers: (settings.providers || []).map(publicProvider),
  };
}

export function envOverrides() {
  const out = [];
  if (process.env.WEB_LOOKUP === '0') out.push({ key: 'WEB_LOOKUP', value: '0', note: 'поиск пустых карточек выключен переменной окружения' });
  if (process.env.SEARCH_URL) out.push({ key: 'SEARCH_URL', value: process.env.SEARCH_URL, note: 'свой поисковик перекрывает поле в файле' });
  if (process.env.MISMATCH_POLICY) out.push({ key: 'MISMATCH_POLICY', value: process.env.MISMATCH_POLICY, note: 'политика расхождений из окружения' });
  if (process.env.DDG_REGION) out.push({ key: 'DDG_REGION', value: process.env.DDG_REGION, note: 'регион DuckDuckGo из окружения' });
  return out;
}

export function validateSettings(cfg) {
  const errors = [];
  if (!cfg.providers?.length) errors.push('нужен хотя бы один провайдер ИИ');
  const ids = new Set();
  for (const p of cfg.providers || []) {
    if (!p.id) errors.push('у провайдера нет id');
    else if (ids.has(p.id)) errors.push(`дублируется id провайдера «${p.id}»`);
    ids.add(p.id);
    if (!isHttpUrl(p.base_url)) errors.push(`провайдер «${p.name || p.id}»: некорректный base_url`);
    if (!PROVIDER_KINDS.includes(p.kind)) errors.push(`провайдер «${p.id}»: неизвестный тип ${p.kind}`);
  }
  if ((cfg.providers || []).filter(p => p.default).length !== 1) {
    errors.push('ровно один провайдер должен быть выбран по умолчанию');
  }
  const ddgUrl = cfg.search?.duckduckgo?.url;
  if (ddgUrl && !isHttpUrl(ddgUrl)) errors.push('URL выдачи DuckDuckGo должен быть http(s)');
  const extra = cfg.search?.search_url;
  if (extra && !extra.includes('%s')) errors.push('свой поисковик: в URL должен быть %s вместо запроса');
  for (const e of cfg.search?.engines || []) {
    if (!e.url.includes('%s')) errors.push(`парсер «${e.name || e.id}»: в URL должен быть %s`);
    const probe = e.url.replace('%s', 'q');
    if (!isHttpUrl(probe)) errors.push(`парсер «${e.name || e.id}»: некорректный URL`);
  }
  if (!['flag', 'strict'].includes(cfg.conditions?.mismatch_policy)) {
    errors.push('политика расхождений: flag или strict');
  }
  return errors;
}

function persistable(settings) {
  return {
    facet_min_coverage: settings.facet_min_coverage,
    target_coverage: settings.target_coverage,
    description: { min_attrs: settings.description.min_attrs },
    fuzzy: { min_score: settings.fuzzy.min_score },
    model: settings.model,
    search: settings.search,
    providers: settings.providers,
    conditions: settings.conditions,
  };
}

/** Первый запуск в контейнере: копируем встроенный config.json на том. */
export function bootstrapSettingsFile(root = ROOT) {
  const dest = configPath(root);
  if (fs.existsSync(dest)) return dest;
  const bundled = path.join(root, 'config.json');
  if (dest !== bundled && fs.existsSync(bundled)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(bundled, dest);
  }
  return dest;
}

export function saveSettings(settings, root = ROOT) {
  const errors = validateSettings(settings);
  if (errors.length) {
    const e = new Error(errors[0]);
    e.details = errors;
    e.status = 400;
    throw e;
  }
  const dest = configPath(root);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(persistable(settings), null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, dest);
  return dest;
}

/**
 * Применяет PATCH: полная замена секции, если она передана.
 * Для провайдеров api_key: "" — оставить прежний, null — стереть.
 */
export function applySettingsPatch(current, patch = {}) {
  const next = { ...current };
  if (patch.search) next.search = { ...current.search, ...patch.search };
  if (patch.model) next.model = { ...current.model, ...patch.model };
  if (patch.conditions) next.conditions = { ...current.conditions, ...patch.conditions };
  if (Array.isArray(patch.providers)) next.providers = patch.providers;
  return normalizeSettings(next, current);
}

export function resolveProvider(settings, id) {
  const list = settings?.providers || [];
  if (id) {
    const hit = list.find(p => p.id === id);
    if (hit) return hit;
  }
  return list.find(p => p.default) || list.find(p => p.enabled) || list[0] || defaultProvider();
}

export function providerEndpoint(p) {
  return {
    baseUrl: String(p.base_url || '').replace(/\/+$/, ''),
    chatUrl: joinUrl(p.base_url, p.chat_path || '/chat/completions'),
    modelsUrl: joinUrl(p.base_url, p.models_path || '/models'),
    headers: { ...(p.headers || {}) },
    apiKey: providerKey(p),
  };
}

/** Список парсеров, который рисует интерфейс: DuckDuckGo, запасные, свои URL. */
export function parsersView(search = {}) {
  const s = normalizeSearch(search);
  const list = [];
  list.push({
    id: 'duckduckgo',
    kind: 'duckduckgo',
    name: 'DuckDuckGo',
    enabled: s.duckduckgo.enabled,
    builtin: true,
    endpoint: s.duckduckgo.endpoint,
    region: s.duckduckgo.region,
    method: s.duckduckgo.method,
    url: s.duckduckgo.url || '',
    site_filter: s.duckduckgo.site_filter || '',
  });
  if (s.search_url) {
    list.push({
      id: 'search_url',
      kind: 'html_search',
      name: 'Свой поисковик (SEARCH_URL)',
      enabled: true,
      builtin: true,
      url: s.search_url,
    });
  }
  for (const name of Object.keys(FALLBACK_URLS)) {
    list.push({
      id: name,
      kind: 'html_search',
      name: name === 'ddg_lite' ? 'DuckDuckGo Lite' : name[0].toUpperCase() + name.slice(1),
      enabled: s.fallback_engines.includes(name),
      builtin: true,
      url: FALLBACK_URLS[name],
    });
  }
  for (const e of s.engines) {
    list.push({
      id: e.id,
      kind: 'html_search',
      name: e.name,
      enabled: e.enabled,
      builtin: false,
      url: e.url,
    });
  }
  return { ...s, parsers: list };
}

export function conditionsView(conditions = {}) {
  const c = defaultConditions(conditions);
  return {
    ...c,
    items: [
      { id: 'mismatch_policy', name: 'Расхождения модели с текстом', kind: 'enum',
        value: c.mismatch_policy, options: ['flag', 'strict'],
        hint: 'flag — оставить значение и пометить; strict — обнулить спорное поле' },
      { id: 'min_source_chars', name: 'Минимум символов в описании', kind: 'number',
        value: c.min_source_chars, min: 0, max: 10_000,
        hint: 'короткий текст без фактов товар не обогащается' },
      { id: 'min_attrs', name: 'Минимум характеристик в карточке', kind: 'number',
        value: c.min_attrs, min: 0, max: 50,
        hint: 'ниже порога SEO-текст может быть короче — нет материала для трёх абзацев' },
      { id: 'facet_min_coverage', name: 'Покрытие фасета, %', kind: 'number',
        value: c.facet_min_coverage, min: 0, max: 100,
        hint: 'фильтр витрины появляется, когда заполнено не меньше этой доли товаров' },
      { id: 'target_coverage', name: 'Целевое покрытие, %', kind: 'number',
        value: c.target_coverage, min: 0, max: 100,
        hint: 'ориентир для отчёта CLI, на прогон не влияет' },
      { id: 'fuzzy_min_score', name: 'Нечёткое совпадение ключа', kind: 'number',
        value: c.fuzzy_min_score, min: 0, max: 1, step: 0.01,
        hint: 'порог сопоставления подписи характеристики со справочником' },
    ],
  };
}

export { FALLBACK_URLS };
