/**
 * settings.js — гибкие настройки прогона: провайдеры ИИ, парсеры, условия.
 *
 * Источник — config.json (или SETTINGS_PATH в контейнере). Переменные окружения
 * по-прежнему перекрывают файл в момент вызова (WEB_LOOKUP=0, ключ провайдера),
 * но сами значения правятся из интерфейса и переживают перезапуск.
 *
 * Ключи в файл можно писать, но наружу они не уходят: GET отдаёт только
 * has_key / намёк из последних символов. Пустой api_key в PUT сохраняет прежний
 * (и у провайдера ИИ, и у Yandex Search API).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { configPath, loadConfig } from './pipeline/dict.js';
import { normalizeExportTemplates, persistExportTemplates } from './pipeline/export_template.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export const PROVIDER_KINDS = ['openai'];
export const PROVIDER_AUTH = ['bearer', 'api-key'];

/** Короткие id моделей Yandex AI Studio → подписи в списке. */
export const YANDEX_MODEL_LABELS = {
  'yandexgpt-lite/latest': 'YandexGPT Lite',
  'yandexgpt/latest': 'YandexGPT Pro',
  'aliceai-llm/latest': 'Alice AI LLM',
  'qwen3-235b-a22b-fp8/latest': 'Qwen3 235B',
  'gpt-oss-120b/latest': 'GPT-OSS 120B',
};

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
    headers: { 'HTTP-Referer': 'https://mrmag.ru', 'X-Title': 'Ogran' },
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
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai',
    // Официальный OpenAI-совместимый URL без /v1: POST /chat/completions.
    // deepseek-chat / deepseek-reasoner сняты 24.07.2026.
    base_url: 'https://api.deepseek.com',
    api_key_env: 'DEEPSEEK_API_KEY',
    models_path: '/models',
    chat_path: '/chat/completions',
    headers: {},
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
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
  {
    id: 'yandex',
    name: 'Yandex AI Studio',
    kind: 'openai',
    auth: 'api-key',
    // OpenAI-совместимый чат: POST /v1/chat/completions, модель gpt://<folder>/…
    base_url: 'https://ai.api.cloud.yandex.net/v1',
    api_key_env: 'YANDEX_API_KEY',
    folder_id: '',
    folder_id_env: 'YANDEX_FOLDER_ID',
    models_path: '',
    chat_path: '/chat/completions',
    headers: {},
    models: [
      'yandexgpt-lite/latest',
      'yandexgpt/latest',
      'aliceai-llm/latest',
      'qwen3-235b-a22b-fp8/latest',
      'gpt-oss-120b/latest',
    ],
    model_labels: { ...YANDEX_MODEL_LABELS },
    notes: 'Ключ с правом yc.ai.foundationModels.execute (не Search API). Folder ID — тот же каталог Cloud, что у поиска.',
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
    headers: { 'HTTP-Referer': 'https://mrmag.ru', 'X-Title': 'Ogran' },
    models: [],
    notes: '',
  };
}

export function defaultConditions(raw = {}) {
  const policy = raw.mismatch_policy;
  return {
    mismatch_policy: ['prefer_source', 'flag', 'strict'].includes(policy) ? policy : 'prefer_source',
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
    page_timeout_ms: 10_000,
    min_pairs: 3,
    query_suffix: 'характеристики',
    skip_hosts: ['mrmag.ru'],
    search_url: '',
    fallback_engines: ['mojeek', 'brave'],
    engines: [],
    yandex: {
      enabled: true,
      api_key: '',
      api_key_env: 'YANDEX_SEARCH_API_KEY',
      folder_id: '',
      folder_id_env: 'YANDEX_FOLDER_ID',
      search_type: 'ru',
      l10n: 'ru',
      family_mode: 'none',
      region: '225',
      num: 10,
      endpoint: '',
      site_filter: '',
    },
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

function mapStringEntries(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [String(k), String(v)]).filter(([k]) => k),
  );
}

function providerAuthSchemeOf(raw, preset = {}) {
  const a = String(raw?.auth ?? preset.auth ?? 'bearer').toLowerCase().replace('_', '-');
  return PROVIDER_AUTH.includes(a) ? a : 'bearer';
}

export function isYandexLlm(p) {
  if (!p) return false;
  if (p.id === 'yandex') return true;
  return /(?:^|[./])(?:ai|llm)\.api\.cloud\.yandex\.net/i.test(String(p.base_url || ''));
}

function normalizeProvider(raw, { keepKey = '', keepFolder = '' } = {}) {
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
    ? mapStringEntries(raw.headers)
    : { ...(preset.headers || {}) };
  const labelsSrc = (raw?.model_labels && typeof raw.model_labels === 'object')
    ? raw.model_labels
    : (preset.model_labels || {});
  const folderId = (raw && Object.prototype.hasOwnProperty.call(raw, 'folder_id'))
    ? str(raw.folder_id)
    : (keepFolder || str(raw?.folder_id));
  return {
    id: slugId(raw?.id || raw?.name, 'provider'),
    name: str(raw?.name || preset.name, 'Провайдер').slice(0, 80),
    kind,
    auth: providerAuthSchemeOf(raw, preset),
    base_url: str(raw?.base_url || preset.base_url, 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    api_key: apiKey,
    api_key_env: str(raw?.api_key_env ?? preset.api_key_env).slice(0, 80),
    folder_id: folderId.slice(0, 80),
    folder_id_env: str(raw?.folder_id_env ?? preset.folder_id_env).slice(0, 80),
    enabled: raw?.enabled !== false,
    default: raw?.default === true,
    models_path: str(raw?.models_path ?? preset.models_path, '/models'),
    chat_path: str(raw?.chat_path ?? preset.chat_path, '/chat/completions'),
    headers,
    models: models.length ? models : [...(preset.models || [])],
    model_labels: mapStringEntries(labelsSrc),
    notes: str(raw?.notes ?? preset.notes).slice(0, 500),
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

const YANDEX_SEARCH_TYPES = new Set(['ru', 'com', 'tr', 'kk', 'be', 'uz']);
const YANDEX_L10N = new Set(['ru', 'en', 'uk', 'be', 'kk', 'tr']);
const YANDEX_FAMILY = new Set(['none', 'moderate', 'strict']);

function shortCode(raw, prefix) {
  return String(raw || '').toLowerCase().replace(new RegExp(`^${prefix}`), '');
}

function keepOrReplaceKey(raw, prevKey) {
  if (raw && Object.prototype.hasOwnProperty.call(raw, 'api_key') && raw.api_key === null) return '';
  if (!raw?.api_key) return prevKey || '';
  return str(raw.api_key);
}

function normalizeSearch(raw = {}, prev = {}) {
  const base = defaultSearch();
  const ddg = raw.duckduckgo && typeof raw.duckduckgo === 'object' ? raw.duckduckgo : {};
  const ya = raw.yandex && typeof raw.yandex === 'object' ? raw.yandex : {};
  const prevYa = prev.yandex && typeof prev.yandex === 'object' ? prev.yandex : {};
  const skip = Array.isArray(raw.skip_hosts)
    ? raw.skip_hosts.map(h => String(h).trim()).filter(Boolean)
    : base.skip_hosts;
  const fallback = Array.isArray(raw.fallback_engines)
    ? raw.fallback_engines.map(s => String(s).trim()).filter(Boolean)
    : base.fallback_engines;
  const engines = Array.isArray(raw.engines) ? raw.engines.map(normalizeEngine).filter(e => e.url) : [];
  const searchType = shortCode(ya.search_type || 'ru', 'search_type_');
  const l10n = shortCode(ya.l10n || 'ru', 'localization_');
  const family = shortCode(ya.family_mode || 'none', 'family_mode_');
  return {
    enabled: raw.enabled !== false,
    tries: num(raw.tries, base.tries, { min: 1, max: 10 }),
    gap_ms: num(raw.gap_ms, base.gap_ms, { min: 0, max: 60_000 }),
    timeout_ms: num(raw.timeout_ms, base.timeout_ms, { min: 1000, max: 120_000 }),
    page_timeout_ms: num(raw.page_timeout_ms, base.page_timeout_ms, { min: 1000, max: 60_000 }),
    min_pairs: num(raw.min_pairs, base.min_pairs, { min: 1, max: 50 }),
    query_suffix: str(raw.query_suffix, base.query_suffix).slice(0, 80),
    skip_hosts: skip.length ? skip : base.skip_hosts,
    search_url: str(raw.search_url),
    fallback_engines: fallback,
    engines,
    yandex: {
      enabled: ya.enabled !== false,
      api_key: keepOrReplaceKey(ya, prevYa.api_key),
      api_key_env: str(ya.api_key_env, 'YANDEX_SEARCH_API_KEY').slice(0, 80),
      folder_id: str(ya.folder_id, prevYa.folder_id || '').slice(0, 80),
      folder_id_env: str(ya.folder_id_env, 'YANDEX_FOLDER_ID').slice(0, 80),
      search_type: YANDEX_SEARCH_TYPES.has(searchType) ? searchType : 'ru',
      l10n: YANDEX_L10N.has(l10n) ? l10n : 'ru',
      family_mode: YANDEX_FAMILY.has(family) ? family : 'none',
      region: str(ya.region, '225').slice(0, 16),
      num: num(ya.num, 10, { min: 1, max: 100 }),
      endpoint: str(ya.endpoint || ya.url),
      site_filter: str(ya.site_filter).slice(0, 80),
    },
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

/** 'all' или список slug/id разделов. Пустой список — ещё не выбранные, не «все». */
export function normalizePromptScope(raw) {
  if (raw === 'all' || raw === true || raw == null || raw === '') return 'all';
  const list = Array.isArray(raw)
    ? raw
    : String(raw).split(/[,;]+/);
  const keys = [...new Set(list.map(s => String(s).trim()).filter(Boolean))].slice(0, 80);
  return keys;
}

function normalizeSystemPrompts(rawList, legacyPrompt = '') {
  const taken = new Set();
  const out = [];
  const src = Array.isArray(rawList) ? rawList : [];
  for (const item of src) {
    if (!item || typeof item !== 'object') continue;
    const id = uniqueId(item.id || item.name || `prompt-${out.length + 1}`, taken);
    taken.add(id);
    const scope = normalizePromptScope(item.scope);
    const isAll = scope === 'all';
    out.push({
      id,
      name: str(item.name, isAll ? 'Все разделы' : 'Выбранные').slice(0, 80),
      scope,
      template: String(item.template ?? '').slice(0, 80_000),
    });
  }
  if (!out.some(p => p.scope === 'all')) {
    out.unshift({
      id: uniqueId('default', taken),
      name: 'Все разделы',
      scope: 'all',
      template: String(legacyPrompt ?? '').slice(0, 80_000),
    });
  }
  if (!out.length) {
    out.push({
      id: 'default',
      name: 'Все разделы',
      scope: 'all',
      template: String(legacyPrompt ?? '').slice(0, 80_000),
    });
  }
  return out;
}

function persistSystemPrompts(list) {
  if (!Array.isArray(list) || !list.length) return undefined;
  const slim = [];
  for (const p of list) {
    const tpl = String(p?.template || '');
    const isAll = p.scope === 'all';
    const selected = Array.isArray(p.scope) && p.scope.length;
    if (isAll && !tpl.trim()) continue;
    if (!isAll && !selected) continue;
    slim.push({
      id: p.id,
      name: str(p.name).slice(0, 80),
      scope: isAll ? 'all' : p.scope,
      template: tpl.slice(0, 80_000),
    });
  }
  return slim.length ? slim : undefined;
}

function persistModel(model) {
  const out = { ...model };
  const prompts = persistSystemPrompts(model.system_prompts);
  if (prompts) out.system_prompts = prompts;
  else delete out.system_prompts;
  const all = (prompts || []).find(p => p.scope === 'all');
  out.system_prompt = all ? all.template : '';
  return out;
}

function normalizeModel(raw = {}) {
  const legacy = String(raw.system_prompt ?? '').slice(0, 80_000);
  const system_prompts = normalizeSystemPrompts(
    Array.isArray(raw.system_prompts) ? raw.system_prompts : null,
    legacy,
  );
  const all = system_prompts.find(p => p.scope === 'all');
  return {
    name: str(raw.name).slice(0, 120),
    prompt_version: str(raw.prompt_version, 'dict-v1').slice(0, 40),
    // Пустая строка — встроенный шаблон из lib.js. Иначе текст с {{плейсхолдерами}}.
    system_prompt: all ? all.template : legacy,
    system_prompts,
    max_retries: num(raw.max_retries, 2, { min: 1, max: 2 }),
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
    const prevP = prevById.get(raw?.id) || {};
    const keepKey = prevP.api_key || '';
    const keepFolder = prevP.folder_id || '';
    const p = normalizeProvider(raw, { keepKey, keepFolder });
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
    search: normalizeSearch(raw.search, prev?.search),
    providers: normalizeProviders(raw.providers, prev?.providers),
    conditions,
    export_templates: normalizeExportTemplates(raw.export_templates),
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

export function providerHasFolder(p, settings) {
  return !!providerFolderId(p, settings);
}

export function providerFolderId(p, settings) {
  if (p?.folder_id) return String(p.folder_id).trim();
  const envName = p?.folder_id_env;
  if (envName && process.env[envName]) return String(process.env[envName]).trim();
  if (!isYandexLlm(p)) return '';
  const ya = settings?.search?.yandex;
  if (ya?.folder_id) return String(ya.folder_id).trim();
  const searchEnv = ya?.folder_id_env || 'YANDEX_FOLDER_ID';
  if (process.env[searchEnv]) return String(process.env[searchEnv]).trim();
  return String(process.env.YANDEX_FOLDER_ID || process.env.YC_FOLDER_ID || process.env.FOLDER_ID || '').trim();
}

function headerHas(headers, name) {
  const want = String(name).toLowerCase();
  return Object.keys(headers || {}).some(k => k.toLowerCase() === want);
}

export function providerAuthHeader(p, apiKey) {
  if (!apiKey) return {};
  const scheme = providerAuthSchemeOf(p);
  return { Authorization: scheme === 'api-key' ? `Api-Key ${apiKey}` : `Bearer ${apiKey}` };
}

const MODEL_URI_RE = /^(gpt|emb|ds):\/\//i;

/** Короткие id Yandex → gpt://<folder>/<id>. Остальные провайдеры без изменений. */
export function resolveProviderModel(p, modelId, settings) {
  const raw = String(modelId || '').trim();
  if (!raw) return raw;
  const folder = providerFolderId(p, settings);
  const id = folder ? raw.replace(/\{folder_id\}/gi, folder) : raw;
  if (!isYandexLlm(p) || MODEL_URI_RE.test(id)) return id;
  if (!folder) return id;
  return `gpt://${folder}/${id.replace(/^\/+/, '')}`;
}

function publicYandex(ya = {}) {
  const envName = ya.api_key_env || 'YANDEX_SEARCH_API_KEY';
  const envKey = envName && process.env[envName] ? process.env[envName] : '';
  const stored = ya.api_key || '';
  const folderEnv = ya.folder_id_env || 'YANDEX_FOLDER_ID';
  const rest = { ...ya };
  delete rest.api_key;
  return {
    ...rest,
    has_key: !!(stored || envKey),
    key_hint: hintOf(stored || envKey),
    key_from: stored ? 'file' : envKey ? 'env' : 'none',
    has_folder: !!(ya.folder_id || (folderEnv && process.env[folderEnv])),
  };
}

/** То, что видит интерфейс: без секретов. */
export function publicProvider(p, settings) {
  const envKey = p.api_key_env && process.env[p.api_key_env] ? process.env[p.api_key_env] : '';
  const stored = p.api_key || '';
  const folder = providerFolderId(p, settings);
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    auth: p.auth || 'bearer',
    base_url: p.base_url,
    api_key_env: p.api_key_env || '',
    folder_id: p.folder_id || '',
    folder_id_env: p.folder_id_env || '',
    enabled: p.enabled,
    default: p.default,
    models_path: p.models_path,
    chat_path: p.chat_path,
    headers: p.headers,
    models: p.models,
    model_labels: p.model_labels || {},
    notes: p.notes,
    has_key: !!(stored || envKey),
    key_hint: hintOf(stored || envKey),
    key_from: stored ? 'file' : envKey ? 'env' : 'none',
    has_folder: !!folder,
  };
}

export function publicSettings(settings) {
  return {
    ...settings,
    providers: (settings.providers || []).map(p => publicProvider(p, settings)),
    search: {
      ...settings.search,
      yandex: publicYandex(settings.search?.yandex || {}),
    },
  };
}

export function envOverrides() {
  const out = [];
  if (process.env.WEB_LOOKUP === '0') out.push({ key: 'WEB_LOOKUP', value: '0', note: 'поиск пустых карточек выключен переменной окружения' });
  if (process.env.SEARCH_URL) out.push({ key: 'SEARCH_URL', value: process.env.SEARCH_URL, note: 'свой поисковик перекрывает поле в файле' });
  if (process.env.YANDEX_API_KEY) {
    out.push({ key: 'YANDEX_API_KEY', value: '••••', note: 'ключ Yandex AI Studio из окружения' });
  }
  if (process.env.YANDEX_SEARCH_API_KEY || process.env.YC_API_KEY) {
    out.push({ key: 'YANDEX_SEARCH_API_KEY', value: '••••', note: 'ключ Yandex Search API из окружения' });
  }
  if (process.env.YANDEX_FOLDER_ID || process.env.YC_FOLDER_ID || process.env.FOLDER_ID) {
    out.push({ key: 'YANDEX_FOLDER_ID', value: '••••', note: 'folder id Yandex Cloud из окружения' });
  }
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
  const yaUrl = cfg.search?.yandex?.endpoint;
  if (yaUrl && !isHttpUrl(yaUrl)) errors.push('endpoint Yandex Search API должен быть http(s)');
  const extra = cfg.search?.search_url;
  if (extra && !extra.includes('%s')) errors.push('свой поисковик: в URL должен быть %s вместо запроса');
  for (const e of cfg.search?.engines || []) {
    if (!e.url.includes('%s')) errors.push(`парсер «${e.name || e.id}»: в URL должен быть %s`);
    const probe = e.url.replace('%s', 'q');
    if (!isHttpUrl(probe)) errors.push(`парсер «${e.name || e.id}»: некорректный URL`);
  }
  if (!['prefer_source', 'flag', 'strict'].includes(cfg.conditions?.mismatch_policy)) {
    errors.push('политика расхождений: prefer_source, flag или strict');
  }
  return errors;
}

function persistable(settings) {
  const export_templates = persistExportTemplates(settings.export_templates);
  return {
    facet_min_coverage: settings.facet_min_coverage,
    target_coverage: settings.target_coverage,
    description: { min_attrs: settings.description.min_attrs },
    fuzzy: { min_score: settings.fuzzy.min_score },
    model: persistModel(settings.model),
    search: settings.search,
    providers: settings.providers,
    conditions: settings.conditions,
    ...(export_templates ? { export_templates } : {}),
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
 * Для провайдеров и Yandex Search API api_key: "" — оставить прежний, null — стереть.
 */
export function applySettingsPatch(current, patch = {}) {
  const next = { ...current };
  if (patch.search) next.search = { ...current.search, ...patch.search };
  if (patch.model) next.model = { ...current.model, ...patch.model };
  if (patch.conditions) next.conditions = { ...current.conditions, ...patch.conditions };
  if (Array.isArray(patch.providers)) next.providers = patch.providers;
  if (patch.export_templates && typeof patch.export_templates === 'object') {
    const prev = current.export_templates || {};
    const two = patch.export_templates.two;
    const v2 = patch.export_templates.v2;
    next.export_templates = {
      two: two && typeof two === 'object' ? { ...(prev.two || {}), ...two } : prev.two,
      v2: v2 && typeof v2 === 'object' ? { ...(prev.v2 || {}), ...v2 } : prev.v2,
    };
  }
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

export function providerEndpoint(p, settings) {
  const apiKey = providerKey(p);
  const folderId = providerFolderId(p, settings);
  const headers = { ...(p.headers || {}) };
  Object.assign(headers, providerAuthHeader(p, apiKey));
  if (folderId && !headerHas(headers, 'x-folder-id')) {
    headers['x-folder-id'] = folderId;
  }
  return {
    baseUrl: String(p.base_url || '').replace(/\/+$/, ''),
    chatUrl: joinUrl(p.base_url, p.chat_path || '/chat/completions'),
    modelsUrl: joinUrl(p.base_url, p.models_path || '/models'),
    headers,
    apiKey,
    folderId,
    auth: providerAuthSchemeOf(p),
  };
}

/** Список парсеров, который рисует интерфейс: Yandex, DuckDuckGo, запасные, свои URL. */
export function parsersView(search = {}) {
  const s = normalizeSearch(search);
  const list = [];
  list.push({
    id: 'yandex',
    kind: 'yandex',
    name: 'Yandex Search API',
    enabled: s.yandex.enabled,
    builtin: true,
    search_type: s.yandex.search_type,
    l10n: s.yandex.l10n,
    region: s.yandex.region || '',
    has_key: !!(s.yandex.api_key || (s.yandex.api_key_env && process.env[s.yandex.api_key_env])),
    has_folder: !!(s.yandex.folder_id || (s.yandex.folder_id_env && process.env[s.yandex.folder_id_env])),
  });
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
  return { ...s, yandex: publicYandex(s.yandex), parsers: list };
}

export function conditionsView(conditions = {}) {
  const c = defaultConditions(conditions);
  return {
    ...c,
    items: [
      { id: 'mismatch_policy', name: 'Расхождения модели с текстом', kind: 'enum',
        value: c.mismatch_policy, options: ['prefer_source', 'flag', 'strict'],
        hint: 'prefer_source — взять факт источника; flag — то же + пометка; strict — вне интервала обнулить' },
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
