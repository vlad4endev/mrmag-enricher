/**
 * Поиск той же модели: Yandex Search API (Cloud v2), затем DuckDuckGo HTML
 * и запасные движки без ключа.
 *
 * Настройки — config.json → search / search.yandex / search.duckduckgo.
 * Переменные окружения перекрывают их в момент вызова, не при загрузке модуля.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const PRIVATE_HOST = new RegExp([
  '^localhost$', '\\.local$', '^\\[?::1\\]?$', '^\\[?f[cd]', '^\\[?fe80:',
  '^127\\.', '^10\\.', '^192\\.168\\.', '^169\\.254\\.', '^0\\.',
  '^172\\.(1[6-9]|2\\d|3[01])\\.',
].join('|'), 'i');

const ENGINE_HOST = /(?:^|\.)(?:duckduckgo|google|gstatic|googleusercontent|yastatic|bing|brave|mojeek|searchapi\.api\.cloud\.yandex)\./i;

/** Футер поисковика и соцсети: это не карточка товара, даже если href на странице выдачи. */
export const JUNK_HOST = /(?:^|\.)(?:mastodon\.social|buttondown\.email|spreadprivacy\.com|twitter\.com|x\.com|facebook\.com|fb\.com|instagram\.com|t\.me|telegram\.(?:me|org)|reddit\.com|tiktok\.com|pinterest\.com|linkedin\.com|threads\.net|bsky\.app|vk\.com|ok\.ru|youtube\.com|youtu\.be|dzen\.ru)$/i;

export function isJunkHost(host) {
  return JUNK_HOST.test(String(host || '').replace(/^www\./, ''));
}

const FALLBACK = {
  mojeek: 'https://www.mojeek.com/search?q=%s',
  brave: 'https://search.brave.com/search?q=%s',
  ddg_lite: 'https://lite.duckduckgo.com/lite/?q=%s',
};

const DDG_HTML = 'https://html.duckduckgo.com/html/';
const DDG_LITE = 'https://lite.duckduckgo.com/lite/';
const YANDEX_SEARCH = 'https://searchapi.api.cloud.yandex.net/v2/web/search';
const YANDEX_SEARCH_TYPES = new Set(['ru', 'com', 'tr', 'kk', 'be', 'uz']);
const YANDEX_L10N = new Set(['ru', 'en', 'uk', 'be', 'kk', 'tr']);
const YANDEX_FAMILY = {
  none: 'FAMILY_MODE_NONE',
  moderate: 'FAMILY_MODE_MODERATE',
  strict: 'FAMILY_MODE_STRICT',
};
/** l10n зависит от searchType: RU → ru/uk/be/kk, TR → tr, COM → en. */
const YANDEX_L10N_BY_TYPE = {
  ru: ['ru', 'uk', 'be', 'kk'],
  tr: ['tr'],
  com: ['en'],
  kk: ['kk', 'ru'],
  be: ['be', 'ru'],
  uz: ['ru', 'en'],
};
const YANDEX_REGION_TYPES = new Set(['ru', 'tr']);
/** Код 15 — пустая выдача, не ошибка. Остальные — сбой запроса. */
const YANDEX_XML_EMPTY = '15';
const YANDEX_XML_ERROR_HINT = {
  1: 'синтаксическая ошибка в запросе',
  2: 'пустой запрос',
  18: 'некорректные параметры запроса',
  19: 'несовместимые параметры группировки',
  20: 'неизвестная ошибка',
  31: 'каталог не зарегистрирован в Search API',
  32: 'превышена суточная квота',
  33: 'IP не совпадает с зарегистрированным',
  37: 'ошибка в параметрах запроса',
  42: 'ключ не прошёл аутентификацию',
  44: 'адрес API больше не поддерживается',
  48: 'тип поиска не совпадает с зарегистрированным',
  55: 'превышен лимит запросов в секунду',
  100: 'запрос похож на робота',
  10002: 'слишком много слов в запросе',
};

function num(...vals) {
  for (const v of vals) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function cacheDir() {
  return process.env.PAGE_CACHE_DIR || '.page_cache';
}

function cachePath(url) {
  return path.join(cacheDir(), crypto.createHash('sha1').update(url).digest('hex') + '.html');
}

function allowLocal() {
  return process.env.WEB_ALLOW_LOCAL === '1';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** AbortSignal.timeout() — TimeoutError; часть сбоев приходит как AbortError с этим текстом. */
export function isTimeoutError(e) {
  const text = [e?.name, e?.message, e?.cause?.name, e?.cause?.message].filter(Boolean).join(' ');
  return e?.name === 'TimeoutError'
    || e?.cause?.name === 'TimeoutError'
    || /таймаут|aborted due to timeout|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(text);
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function timedError(e, timeoutMs, url) {
  if (isTimeoutError(e)) {
    const host = hostOf(url);
    return new Error(host ? `таймаут ${timeoutMs}ms (${host})` : `таймаут ${timeoutMs}ms`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

function noProxyBypasses(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  return String(process.env.NO_PROXY || process.env.no_proxy || '').split(/[\s,]+/).some(raw => {
    const x = String(raw || '').trim().toLowerCase();
    if (!x) return false;
    if (x === '*') return true;
    if (x.startsWith('.')) return h === x.slice(1) || h.endsWith(x);
    return h === x || h.endsWith('.' + x);
  });
}

let lastFetch = 0;
let lastSearch = 0;
/** Очередь запросов к поисковику: три карточки сразу не бьют DDG параллельно (капча). */
let searchLock = Promise.resolve();

function fresh(file, ttlMs) {
  return fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < ttlMs;
}

function forget(file) {
  try { fs.unlinkSync(file); } catch { /* нечего забывать */ }
}

function ttlMs() {
  return Number(process.env.PAGE_CACHE_TTL_MS || 24 * 3600 * 1000);
}

function skipHostsOf(settings) {
  return (settings?.skipHosts || ['mrmag.ru']).map(h => String(h).replace(/^www\./, '').toLowerCase());
}

function isSkippedHost(host, settings) {
  const h = String(host || '').replace(/^www\./, '').toLowerCase();
  return skipHostsOf(settings).some(own => h === own || h.endsWith('.' + own));
}

function shortCode(raw, prefix) {
  return String(raw || '').toLowerCase().replace(new RegExp(`^${prefix}`), '');
}

function yandexSearchType(raw) {
  const code = shortCode(raw, 'search_type_');
  return YANDEX_SEARCH_TYPES.has(code) ? code : 'ru';
}

function yandexL10n(raw) {
  const code = shortCode(raw, 'localization_');
  return YANDEX_L10N.has(code) ? code : 'ru';
}

function yandexL10nForType(searchType, raw) {
  const requested = yandexL10n(raw);
  const allowed = YANDEX_L10N_BY_TYPE[searchType];
  if (!allowed) return requested;
  return allowed.includes(requested) ? requested : allowed[0];
}

function yandexFamily(raw) {
  const code = shortCode(raw, 'family_mode_');
  return YANDEX_FAMILY[code] ? code : 'none';
}

function resolveYandexKey(ya = {}) {
  if (ya.api_key) return String(ya.api_key);
  const envName = ya.api_key_env || 'YANDEX_SEARCH_API_KEY';
  return process.env[envName]
    || process.env.YANDEX_SEARCH_API_KEY
    || process.env.YC_API_KEY
    || process.env.SEARCH_API_KEY
    || '';
}

function resolveYandexFolder(ya = {}) {
  if (ya.folder_id) return String(ya.folder_id);
  const envName = ya.folder_id_env || 'YANDEX_FOLDER_ID';
  return process.env[envName]
    || process.env.YANDEX_FOLDER_ID
    || process.env.YC_FOLDER_ID
    || process.env.FOLDER_ID
    || '';
}

/**
 * Сводит config.json.search и переменные окружения.
 * WEB_LOOKUP=0 / DDG_REGION / SEARCH_URL / YANDEX_* перекрывают файл.
 */
export function resolveSearchSettings(config = {}) {
  const s = config.search || {};
  const ddg = s.duckduckgo || {};
  const ya = s.yandex || {};
  const envOff = process.env.WEB_LOOKUP === '0';
  const searchType = yandexSearchType(process.env.YANDEX_SEARCH_TYPE || ya.search_type || 'ru');
  return {
    enabled: !envOff && s.enabled !== false,
    tries: num(process.env.WEB_LOOKUP_TRIES, s.tries, 3),
    gapMs: num(process.env.SEARCH_GAP_MS, s.gap_ms, 3000),
    timeoutMs: num(s.timeout_ms, 20_000),
    pageTimeoutMs: num(process.env.WEB_PAGE_TIMEOUT_MS, s.page_timeout_ms, 10_000),
    minPairs: num(s.min_pairs, 3),
    querySuffix: s.query_suffix ?? 'характеристики',
    skipHosts: Array.isArray(s.skip_hosts) && s.skip_hosts.length ? s.skip_hosts : ['mrmag.ru'],
    extraUrl: process.env.SEARCH_URL || s.search_url || '',
    fallback: Array.isArray(s.fallback_engines) ? s.fallback_engines : ['mojeek', 'brave'],
    engines: Array.isArray(s.engines)
      ? s.engines
          .filter(e => e && e.enabled !== false && String(e.url || '').includes('%s'))
          .map(e => ({ name: String(e.name || e.id || 'поиск'), url: String(e.url) }))
      : [],
    yandex: {
      enabled: ya.enabled !== false,
      apiKey: resolveYandexKey(ya),
      apiKeyEnv: ya.api_key_env || 'YANDEX_SEARCH_API_KEY',
      folderId: resolveYandexFolder(ya),
      folderIdEnv: ya.folder_id_env || 'YANDEX_FOLDER_ID',
      searchType,
      l10n: yandexL10nForType(searchType, ya.l10n || 'ru'),
      familyMode: yandexFamily(ya.family_mode || 'none'),
      region: String(process.env.YANDEX_REGION ?? (ya.region == null ? '225' : ya.region)).trim(),
      num: num(ya.num, 10),
      endpoint: process.env.YANDEX_SEARCH_URL || ya.endpoint || ya.url || YANDEX_SEARCH,
      siteFilter: ya.site_filter || '',
    },
    duckduckgo: {
      enabled: ddg.enabled !== false,
      endpoint: String(process.env.DDG_ENDPOINT || ddg.endpoint || 'html').toLowerCase(),
      region: process.env.DDG_REGION || ddg.region || 'ru-ru',
      method: String(ddg.method || 'POST').toUpperCase(),
      safeSearch: num(ddg.safe_search, -1),
      siteFilter: ddg.site_filter || '',
      url: process.env.DDG_URL || ddg.url || '',
    },
  };
}

/** То, что видит интерфейс: фактические настройки поиска пустых карточек. */
export function publicParserStatus(config = {}) {
  const search = resolveSearchSettings(config);
  const ddg = search.duckduckgo;
  const ya = search.yandex;
  const enabled = search.enabled;
  const yandexReady = ya.enabled && ya.apiKey && ya.folderId;
  let engine = 'выключен';
  if (enabled) {
    if (yandexReady) engine = `Yandex Search API ${ya.searchType}`;
    else if (search.extraUrl) engine = 'свой поисковик';
    else if (ddg.enabled) engine = `DuckDuckGo ${ddg.method} ${ddg.endpoint}`;
    else engine = search.fallback[0] || 'поиск';
  }
  return {
    enabled,
    status: enabled ? 'on' : 'off',
    label: enabled ? engine : 'выключен',
    tries: search.tries,
    gap_ms: search.gapMs,
    timeout_ms: search.timeoutMs,
    page_timeout_ms: search.pageTimeoutMs,
    query_suffix: search.querySuffix,
    skip_hosts: search.skipHosts,
    search_url: search.extraUrl || null,
    fallback: search.fallback,
    engines: search.engines,
    yandex: {
      enabled: ya.enabled,
      has_key: !!ya.apiKey,
      has_folder: !!ya.folderId,
      search_type: ya.searchType,
      l10n: ya.l10n,
      region: ya.region || '',
      num: ya.num,
      site_filter: ya.siteFilter || '',
    },
    duckduckgo: {
      enabled: ddg.enabled,
      method: ddg.method,
      endpoint: ddg.endpoint,
      region: ddg.region,
      url: ddg.url || null,
      site_filter: ddg.siteFilter || '',
    },
  };
}

async function waitGap(kind, gapMs) {
  if (kind !== 'search') {
    const wait = gapMs - (Date.now() - lastFetch);
    if (wait > 0) await sleep(wait);
    lastFetch = Date.now();
    return;
  }
  // Страницы товаров качаются параллельно; поисковик — строго по одному.
  let release;
  const prev = searchLock;
  searchLock = new Promise(r => { release = r; });
  await prev;
  try {
    const wait = gapMs - (Date.now() - lastSearch);
    if (wait > 0) await sleep(wait);
    lastSearch = Date.now();
  } finally {
    release();
  }
}

function hostLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return String(url || ''); }
}

function fetchFailReason(err) {
  const raw = String(err?.message || err || 'нет ответа').replace(/\s+/g, ' ').trim();
  return raw.replace(/^https?:\/\/\S+\s+—\s+/, '').slice(0, 160) || 'нет ответа';
}

/**
 * Читает до maxPages адресов сразу, принимает первую подходящую в порядке
 * выдачи. Качество то же, что у последовательного обхода: чужая страница
 * раньше в SERP по-прежнему отбрасывается раньше своей. Зависшая первая
 * ссылка больше не держит следующие 20 секунд в очереди — они уже качаются.
 */
export async function firstMatchingPage(urls, {
  fetchHtml,
  match,
  maxPages = 3,
} = {}) {
  const slice = (urls || []).slice(0, maxPages);
  const tried = [];
  if (!slice.length) return { ok: false, tried };
  if (typeof fetchHtml !== 'function' || typeof match !== 'function') {
    throw new Error('firstMatchingPage: нужны fetchHtml и match');
  }

  const results = new Array(slice.length);
  let next = 0;
  let inflight = slice.length;
  let settled = false;

  return await new Promise(resolve => {
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const drain = () => {
      while (next < slice.length && results[next]) {
        const cur = results[next];
        const host = hostLabel(cur.url);
        next += 1;
        if (!cur.html) {
          tried.push(`${host}: не открылась (${fetchFailReason(cur.error)})`);
          continue;
        }
        let got;
        try { got = match(cur.html, cur.url); }
        catch {
          tried.push(`${host}: разбор не удался`);
          continue;
        }
        if (got && got.ok) {
          return finish({ ...got, ok: true, url: cur.url, html: cur.html, tried });
        }
        tried.push(`${host}: ${got?.reason || 'не подошла'}`);
      }
      if (inflight === 0) finish({ ok: false, tried });
    };

    slice.forEach((url, i) => {
      Promise.resolve()
        .then(() => fetchHtml(url))
        .then(html => {
          results[i] = { url, html: html == null ? null : html };
        })
        .catch(error => {
          results[i] = { url, html: null, error };
        })
        .finally(() => {
          inflight -= 1;
          drain();
        });
    });
  });
}

export async function fetchPage(url, { timeoutMs = 20_000 } = {}) {
  const file = cachePath(url);
  if (fresh(file, ttlMs())) return fs.readFileSync(file, 'utf-8');

  await waitGap('fetch', Number(process.env.CRAWL_GAP_MS || 250));

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'ru,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} на ${url}`);
    const html = await res.text();
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(file, html, 'utf-8');
    return html;
  } catch (e) {
    if (/^HTTP /.test(e.message)) throw e;
    throw timedError(e, timeoutMs, url);
  }
}

async function fetchForm(url, body, { timeoutMs = 20_000, cacheKey, gapMs } = {}) {
  const file = cachePath(cacheKey || `${url}?${body}`);
  if (fresh(file, ttlMs())) return fs.readFileSync(file, 'utf-8');

  await waitGap('search', gapMs ?? Number(process.env.SEARCH_GAP_MS || 3000));

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'ru,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: new URL(url).origin,
        Referer: url,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} на ${url}`);
    const html = await res.text();
    if (isDuckDuckGoBlocked(html)) {
      forget(file);
      throw new Error('DuckDuckGo: заглушка или капча вместо выдачи');
    }
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(file, html, 'utf-8');
    return html;
  } catch (e) {
    if (/^HTTP |заглушка|капча/.test(e.message)) throw e;
    throw timedError(e, timeoutMs, url);
  }
}

function jsonApiError(data, status) {
  const err = data?.error;
  if (typeof err === 'string' && err.trim()) return err;
  if (err && typeof err === 'object' && err.message) return String(err.message);
  if (typeof data?.message === 'string' && data.message.trim()) return data.message;
  if (data?.code != null && data.code !== 0 && data.rawData == null) {
    return `код ${data.code}`;
  }
  return `HTTP ${status}`;
}

async function fetchJson(url, { timeoutMs = 20_000, cacheKey, gapMs, method = 'GET', headers = {}, body, noCache = false } = {}) {
  const file = cachePath(cacheKey || url);
  if (!noCache && fresh(file, ttlMs())) {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { forget(file); }
  }

  await waitGap('search', gapMs ?? Number(process.env.SEARCH_GAP_MS || 3000));

  try {
    const hdrs = {
      'User-Agent': UA,
      Accept: 'application/json',
      ...headers,
    };
    const init = {
      method,
      headers: hdrs,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    };
    if (body != null) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (!hdrs['Content-Type'] && !hdrs['content-type']) hdrs['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch {
      forget(file);
      throw new Error(`ответ не JSON (HTTP ${res.status})`);
    }
    if (!res.ok || data.error || (data?.code != null && data.code !== 0 && data.rawData == null && !data.response)) {
      forget(file);
      throw new Error(jsonApiError(data, res.status));
    }
    if (!noCache) {
      fs.mkdirSync(cacheDir(), { recursive: true });
      fs.writeFileSync(file, text, 'utf-8');
    }
    return data;
  } catch (e) {
    if (/^HTTP |ответ не JSON/.test(e.message)) throw e;
    throw timedError(e, timeoutMs, url);
  }
}

export function unwrapDuckDuckGoUrl(href) {
  const raw = String(href || '').replace(/&amp;/g, '&');
  let u;
  try { u = new URL(raw.startsWith('//') ? 'https:' + raw : raw); } catch { return null; }
  if (/(^|\.)duckduckgo\.com$/i.test(u.hostname)) {
    const target = u.searchParams.get('uddg');
    if (!target) return null;
    try { return new URL(decodeURIComponent(target)); } catch {
      try { return new URL(target); } catch { return null; }
    }
  }
  if (/google\./i.test(u.hostname) && u.pathname === '/url') {
    const q = u.searchParams.get('q') || u.searchParams.get('url');
    if (q && /^https?:/i.test(q)) {
      try { return new URL(q); } catch { return null; }
    }
  }
  return u;
}

export function isDuckDuckGoBlocked(html) {
  const s = String(html || '');
  const hasHits = /result__a|result-link|web-result/i.test(s);
  if (hasHits) return false;
  return /anomaly-modal|anomaly\.js|unusual traffic|captcha|bots will be banned/i.test(s);
}

function pushUrl(urls, hosts, href, settings, engineHost) {
  const u = unwrapDuckDuckGoUrl(href);
  if (!u || !/^https?:$/.test(u.protocol)) return;
  const host = u.hostname.replace(/^www\./, '');
  if (isSkippedHost(host, settings)) return;
  if (isJunkHost(host)) return;
  if (engineHost && (host === engineHost || host.endsWith('.' + engineHost))) return;
  if (ENGINE_HOST.test(u.hostname)) return;
  if (!allowLocal() && PRIVATE_HOST.test(host)) return;
  if (u.pathname === '/' && !u.search) return;
  if (hosts.has(host)) return;
  hosts.add(host);
  urls.push(u.href);
}

function resultLink(chunk) {
  return chunk.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href=["']([^"']+)["']/i)
    || chunk.match(/href=["']([^"']+)["'][^>]*class="[^"]*result__a/i)
    || chunk.match(/<a[^>]*class="[^"]*result-link[^"]*"[^>]*href=["']([^"']+)["']/i);
}

/**
 * Разбор HTML-выдачи DuckDuckGo: organic `a.result__a`, без рекламы.
 * Запасной путь — любые href с uddg (lite и старая разметка).
 */
export function parseDuckDuckGoResults(html, settings = resolveSearchSettings()) {
  const urls = [];
  const hosts = new Set();
  const body = String(html || '');
  if (isDuckDuckGoBlocked(body)) return [];

  const open = /<div[^>]*class="([^"]*\bresult\b[^"]*)"[^>]*>/gi;
  let m;
  while ((m = open.exec(body))) {
    if (/\bresult--ad\b|\bresult--extra\b|\bsponsored/i.test(m[1])) continue;
    const link = resultLink(body.slice(m.index, m.index + 2500));
    if (link) pushUrl(urls, hosts, link[1], settings, '');
  }

  if (!urls.length) {
    for (const hit of body.matchAll(/<a[^>]*class="[^"]*(?:result__a|result-link)[^"]*"[^>]*href=["']([^"']+)["']/gi)) {
      pushUrl(urls, hosts, hit[1], settings, '');
    }
  }
  if (!urls.length) {
    for (const hit of body.matchAll(/href=["']([^"']*uddg=[^"']+)["']/gi)) {
      pushUrl(urls, hosts, hit[1], settings, '');
    }
  }
  return urls;
}

export function parseSearchResults(html, engineHost = '', settings = resolveSearchSettings()) {
  const urls = [];
  const hosts = new Set();
  for (const m of String(html).matchAll(/href=["']([^"']+)["']/g)) {
    pushUrl(urls, hosts, m[1], settings, engineHost.replace(/^www\./, ''));
  }
  return urls;
}

function ddgEndpoint(ddg) {
  if (ddg.url) return ddg.url;
  return ddg.endpoint === 'lite' ? DDG_LITE : DDG_HTML;
}

function withSiteFilter(query, filterSource) {
  const q = String(query || '').replace(/\s+/g, ' ').trim();
  const site = String(filterSource?.siteFilter || '').trim();
  return site ? `${q} site:${site}` : q;
}

function yandexSiteFilter(settings) {
  return { siteFilter: settings.yandex?.siteFilter || settings.duckduckgo?.siteFilter || '' };
}

function decodeXmlText(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function xmlAttr(attrs, name) {
  const m = String(attrs || '').match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? decodeXmlText(m[1]) : '';
}

function xmlSections(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b([^>]*)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'gi');
  let m;
  while ((m = re.exec(String(xml || '')))) {
    out.push({ attrs: m[1] || '', inner: m[2] || '' });
  }
  return out;
}

function yandexResponseXml(xml) {
  const responses = xmlSections(xml, 'response');
  return responses.length ? responses[responses.length - 1].inner : String(xml || '');
}

function yandexXmlError(xml) {
  const errors = xmlSections(xml, 'error');
  if (!errors.length) return null;
  const err = errors[0];
  const code = xmlAttr(err.attrs, 'code') || '';
  const text = decodeXmlText(err.inner);
  return { code, text };
}

function yandexDocUrl(docXml) {
  const urls = xmlSections(docXml, 'url');
  for (const node of urls) {
    const href = decodeXmlText(node.inner);
    if (href) return href;
  }
  return '';
}

function yandexOrganicDocs(xml) {
  const groups = xmlSections(xml, 'group');
  if (groups.length) {
    const docs = [];
    for (const group of groups) docs.push(...xmlSections(group.inner, 'doc'));
    return docs;
  }
  return xmlSections(xml, 'doc');
}

function looksLikeHtmlSearch(s) {
  return /<html[\s>]|<ol\b[^>]*class="[^"]*serp|class="[^"]*serp-item|class="[^"]*OrganicTitle/i.test(s);
}

function decodeYandexRawData(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().replace(/^\uFEFF/, '');
  if (!trimmed) return '';
  if (trimmed.startsWith('<') || trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  const compact = trimmed.replace(/\s+/g, '');
  try {
    return Buffer.from(compact, 'base64').toString('utf8').replace(/^\uFEFF/, '').trim();
  } catch {
    return '';
  }
}

function unwrapYandexRawData(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  return data.rawData
    ?? data.raw_data
    ?? data.response?.rawData
    ?? data.response?.raw_data
    ?? '';
}

function parseYandexInfoContext(data, settings) {
  const docs = Array.isArray(data?.docs) ? data.docs : [];
  const urls = [];
  const hosts = new Set();
  for (const doc of docs) {
    const href = String(doc?.FullUrl || doc?.fullUrl || doc?.url || '').trim();
    if (href) pushUrl(urls, hosts, href, settings, '');
  }
  return urls;
}

/**
 * Organic-ссылки из XML Yandex Search API v2.
 * Код 15 — пустая выдача, не ошибка. URL только из <doc><url>, не из saved-copy-url.
 */
export function parseYandexSearchXml(xml, settings = resolveSearchSettings()) {
  const body = String(xml || '');
  const payload = yandexResponseXml(body);
  const err = yandexXmlError(payload) || yandexXmlError(body);
  if (err && err.code && err.code !== YANDEX_XML_EMPTY) {
    const hint = YANDEX_XML_ERROR_HINT[err.code];
    const text = err.text || hint || '';
    throw new Error(`Yandex Search API: ${err.code}${text ? ` ${text}` : ''}`);
  }
  if (err?.code === YANDEX_XML_EMPTY) return [];

  const urls = [];
  const hosts = new Set();
  for (const doc of yandexOrganicDocs(payload)) {
    const href = yandexDocUrl(doc.inner);
    if (href) pushUrl(urls, hosts, href, settings, '');
  }
  return urls;
}

/** JSON-конверт `/v2/web/search`: `{ rawData: "<base64 XML>" }` или async `{ response.rawData }`. */
export function parseYandexSearchResponse(data, settings = resolveSearchSettings()) {
  const decoded = decodeYandexRawData(unwrapYandexRawData(data));
  if (!decoded) return [];
  if (decoded.startsWith('{') || decoded.startsWith('[')) {
    try {
      return parseYandexInfoContext(JSON.parse(decoded), settings);
    } catch {
      return [];
    }
  }
  if (looksLikeHtmlSearch(decoded)) return parseSearchResults(decoded, '', settings);
  return parseYandexSearchXml(decoded, settings);
}

/** Поиск через Yandex Cloud Search API v2. Ключ + folder id. */
export async function searchYandex(query, config = {}, { noCache = false } = {}) {
  const settings = resolveSearchSettings(config);
  const ya = settings.yandex;
  if (!ya.enabled) throw new Error('Yandex Search API выключен в настройках');
  if (!ya.apiKey) throw new Error('Yandex Search API: нет ключа (YANDEX_SEARCH_API_KEY или поле в настройках)');
  if (!ya.folderId) throw new Error('Yandex Search API: нет folder id (YANDEX_FOLDER_ID)');
  const q = withSiteFilter(query, yandexSiteFilter(settings));
  if (!q) throw new Error('пустой поисковый запрос');
  const queryText = q.slice(0, 400);

  let endpoint;
  try { endpoint = new URL(ya.endpoint || YANDEX_SEARCH); } catch {
    throw new Error('Yandex Search API: некорректный endpoint');
  }

  const searchType = `SEARCH_TYPE_${ya.searchType.toUpperCase()}`;
  const l10n = `LOCALIZATION_${ya.l10n.toUpperCase()}`;
  const body = {
    query: {
      searchType,
      queryText,
      familyMode: YANDEX_FAMILY[ya.familyMode] || 'FAMILY_MODE_NONE',
      page: '0',
    },
    groupSpec: {
      groupMode: 'GROUP_MODE_FLAT',
      groupsOnPage: String(Math.min(100, Math.max(1, ya.num || 10))),
      docsInGroup: '1',
    },
    l10n,
    folderId: String(ya.folderId).slice(0, 50),
    responseFormat: 'FORMAT_XML',
  };
  if (ya.region && YANDEX_REGION_TYPES.has(ya.searchType)) {
    body.region = String(ya.region).slice(0, 100);
  }

  const cacheKey = `yandex:${searchType}:${ya.region}:${queryText}`;
  try {
    const data = await fetchJson(endpoint.toString(), {
      timeoutMs: settings.timeoutMs,
      gapMs: settings.gapMs,
      cacheKey: noCache ? undefined : cacheKey,
      noCache,
      method: 'POST',
      headers: {
        Authorization: `Api-Key ${ya.apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    const urls = parseYandexSearchResponse(data, settings);
    if (!urls.length) throw new Error('Yandex Search API: выдача без ссылок');
    return urls;
  } catch (e) {
    if (!/выдача без ссылок/.test(e.message)) forget(cachePath(cacheKey));
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** Поиск в DuckDuckGo HTML/lite. Без ключа API. */
export async function searchDuckDuckGo(query, config = {}) {
  const settings = resolveSearchSettings(config);
  const ddg = settings.duckduckgo;
  if (!ddg.enabled) throw new Error('DuckDuckGo выключен в настройках');
  const q = withSiteFilter(query, ddg);
  if (!q) throw new Error('пустой поисковый запрос');
  const endpoint = ddgEndpoint(ddg);
  const params = new URLSearchParams({
    q,
    b: '',
    kl: ddg.region,
    kp: String(ddg.safeSearch),
  });

  let html;
  if (ddg.method === 'GET') {
    const url = `${endpoint}?${params}`;
    html = await fetchPage(url, { timeoutMs: settings.timeoutMs });
    if (isDuckDuckGoBlocked(html)) {
      forget(cachePath(url));
      throw new Error('DuckDuckGo: заглушка или капча вместо выдачи');
    }
  } else {
    html = await fetchForm(endpoint, params.toString(), {
      timeoutMs: settings.timeoutMs,
      gapMs: settings.gapMs,
      cacheKey: `ddg:${ddg.endpoint}:${ddg.region}:${q}`,
    });
  }
  const urls = parseDuckDuckGoResults(html, settings);
  if (!urls.length) throw new Error('DuckDuckGo: выдача без ссылок');
  return urls;
}

const PROBE_QUERY = 'холодильник ATLANT';

function hostsOf(urls, cap = 3) {
  const out = [];
  const seen = new Set();
  for (const href of urls || []) {
    try {
      const host = new URL(href).hostname.replace(/^www\./, '');
      if (!host || seen.has(host)) continue;
      seen.add(host);
      out.push(host);
      if (out.length >= cap) break;
    } catch { /* битая ссылка */ }
  }
  return out;
}

/**
 * Сообщение API → фраза для настроек. Коды XML Search API и типичные
 * ответы Cloud IAM, чтобы «42» не оставалось загадкой.
 */
export function explainSearchError(msg, engine = 'yandex') {
  const s = String(msg || '').trim() || 'неизвестная ошибка';
  const xmlCode = s.match(/Yandex Search API:\s*(\d+)/i)?.[1]
    || s.match(/\bкод\s+(\d+)\b/i)?.[1];
  const hint = xmlCode ? YANDEX_XML_ERROR_HINT[Number(xmlCode)] : '';

  if (engine === 'yandex' || /yandex/i.test(s)) {
    if (/выключен/i.test(s)) {
      return { code: 'disabled', text: 'Yandex Search API выключен — включите его в настройках парсера.' };
    }
    if (/нет ключа/i.test(s)) {
      return { code: 'no_key', text: 'Нет ключа API. Вставьте ключ или задайте YANDEX_SEARCH_API_KEY.' };
    }
    if (/нет folder/i.test(s)) {
      return { code: 'no_folder', text: 'Нет Folder ID. Укажите каталог Cloud с ролью search-api.editor.' };
    }
    if (/некорректный endpoint/i.test(s)) {
      return { code: 'endpoint', text: 'Некорректный адрес Search API.' };
    }
    if (xmlCode === '42' || /не прошёл аутентификацию/i.test(s) || /unauthor/i.test(s) || /\b401\b/.test(s)) {
      return { code: '42', text: 'Ключ не принят (код 42 / HTTP 401). Проверьте API-ключ и scope yc.search-api.execute.' };
    }
    if (xmlCode === '31') {
      return { code: '31', text: 'Каталог не зарегистрирован в Search API (код 31). Включите сервис для этого Folder ID.' };
    }
    if (xmlCode === '32' || xmlCode === '55') {
      return { code: xmlCode, text: `Лимит Search API: ${hint || s} (код ${xmlCode}). Подождите или поднимите квоту.` };
    }
    if (xmlCode === '33') {
      return { code: '33', text: 'IP сервера не совпадает с зарегистрированным в Search API (код 33).' };
    }
    if (xmlCode === '48') {
      return { code: '48', text: 'Тип поиска (ru/com/tr) не совпадает с тем, что зарегистрирован в кабинете (код 48).' };
    }
    if (/permission|forbidden|\b403\b|access denied/i.test(s)) {
      return { code: '403', text: 'Нет права search-api.editor на каталог (HTTP 403).' };
    }
    if (xmlCode && hint) {
      return { code: xmlCode, text: `Yandex Search API: ${hint} (код ${xmlCode}).` };
    }
    if (/выдача без ссылок/i.test(s)) {
      return { code: 'empty', text: 'Ключ принят, но в выдаче нет ссылок. Интеграция работает, запрос ничего не нашёл.' };
    }
  }
  if (/заглушка|капча/i.test(s)) {
    return { code: 'captcha', text: 'DuckDuckGo вернул капчу вместо выдачи — запасной поиск сейчас недоступен.' };
  }
  if (/таймаут/i.test(s)) {
    const ms = Number(s.match(/таймаут\s+(\d+)\s*ms/i)?.[1]);
    const host = s.match(/\(([^)\s]+)\)/)?.[1]
      || (engine === 'yandex' || /yandex/i.test(s) ? 'searchapi.api.cloud.yandex.net' : '');
    const wait = Number.isFinite(ms) && ms > 0 ? ` за ${Math.round(ms / 1000)} с` : '';
    const where = host ? ` (${host})` : '';
    const yandex = engine === 'yandex' || /yandex/i.test(s);
    let text = yandex
      ? `Yandex Search API не ответил${wait}${where}.`
      : `Нет ответа${wait}${where}.`;
    const proxied = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.SOCKS_PROXY;
    if (proxied && host && !noProxyBypasses(host)) {
      text += ' Запрос идёт через SOCKS OpenRouter — этот хост должен быть в NO_PROXY, как DeepSeek.';
    } else if (yandex) {
      text += ' Проверьте сеть до Cloud и что ключ с Folder ID заданы.';
    } else {
      text += ' Проверьте сеть и endpoint.';
    }
    return { code: 'timeout', text };
  }
  if (/поиск выключен/i.test(s)) {
    return { code: 'search_off', text: 'Поиск в сети выключен. Включите «Искать описания пустых карточек в сети».' };
  }
  return { code: xmlCode || 'error', text: s };
}

function probeCfg(config) {
  const search = { ...(config?.search || {}), gap_ms: 0 };
  const t = Number(search.timeout_ms);
  // Не короче CONNECT SOCKS (20 с): иначе AbortSignal срабатывает, пока
  // туннель ещё открывается, и проверка врёт «таймаут» вместо ответа API.
  search.timeout_ms = Number.isFinite(t) ? Math.min(20_000, Math.max(8_000, t)) : 20_000;
  return { ...config, search };
}

async function timedCall(fn) {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ok: true, ms: Date.now() - t0, value };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Живая проверка парсера для экрана настроек: ключ, folder, ответ Search API.
 * Пустая выдача (код 15) — не ошибка интеграции. DuckDuckGo зовём, только если
 * Yandex выключен или не ответил — чтобы было видно, сработает ли запасной путь.
 */
export async function probeParser(config = {}, io = {}) {
  const query = String(io.query || PROBE_QUERY).replace(/\s+/g, ' ').trim().slice(0, 80) || PROBE_QUERY;
  const cfg = probeCfg(config);
  const settings = resolveSearchSettings(cfg);
  const checks = [];
  const yaSearch = io.searchYandex || io.searchYandexFn || ((q, c) => searchYandex(q, c, { noCache: true }));
  const ddgSearch = io.searchDuckDuckGo || io.searchDuckDuckGoFn || ((q, c) => searchDuckDuckGo(q, c));

  if (!settings.enabled) {
    const { text } = explainSearchError('поиск выключен');
    checks.push({ id: 'search', ok: false, title: 'Поиск в сети', error: text, code: 'search_off' });
    return { ok: false, summary: text, query, checks };
  }
  checks.push({ id: 'search', ok: true, title: 'Поиск в сети', detail: 'включён' });

  const ya = settings.yandex;
  let yandexOk = false;
  let yandexTried = false;
  if (!ya.enabled) {
    checks.push({
      id: 'yandex', ok: true, skipped: true,
      title: 'Yandex Search API', detail: 'выключен — не проверялся',
    });
  } else if (!ya.apiKey) {
    yandexTried = true;
    const { text, code } = explainSearchError('Yandex Search API: нет ключа');
    checks.push({ id: 'yandex', ok: false, title: 'Yandex Search API', error: text, code });
  } else if (!ya.folderId) {
    yandexTried = true;
    const { text, code } = explainSearchError('Yandex Search API: нет folder id');
    checks.push({ id: 'yandex', ok: false, title: 'Yandex Search API', error: text, code });
  } else {
    yandexTried = true;
    const got = await timedCall(() => yaSearch(query, cfg));
    if (got.ok) {
      yandexOk = true;
      const n = got.value?.length || 0;
      const hosts = hostsOf(got.value);
      checks.push({
        id: 'yandex', ok: true, title: 'Yandex Search API',
        detail: n ? `${n} ${n === 1 ? 'ссылка' : 'ссылок'} за ${got.ms} мс` : `ответ за ${got.ms} мс`,
        ms: got.ms,
        urls: n,
        hosts,
      });
    } else if (/выдача без ссылок/i.test(got.error)) {
      yandexOk = true;
      const { text, code } = explainSearchError(got.error);
      checks.push({
        id: 'yandex', ok: true, warning: true, title: 'Yandex Search API',
        detail: text, code, ms: got.ms, urls: 0, hosts: [],
      });
    } else {
      const { text, code } = explainSearchError(got.error, 'yandex');
      checks.push({
        id: 'yandex', ok: false, title: 'Yandex Search API',
        error: text, code, raw: got.error, ms: got.ms,
      });
    }
  }

  const needFallback = !yandexOk && settings.duckduckgo.enabled;
  if (needFallback) {
    const got = await timedCall(() => ddgSearch(query, cfg));
    if (got.ok) {
      const n = got.value?.length || 0;
      checks.push({
        id: 'duckduckgo', ok: true, title: 'DuckDuckGo',
        detail: `запасной поиск отвечает (${n} ${n === 1 ? 'ссылка' : 'ссылок'})`,
        ms: got.ms, urls: n, hosts: hostsOf(got.value),
      });
    } else {
      const { text, code } = explainSearchError(got.error, 'duckduckgo');
      checks.push({
        id: 'duckduckgo', ok: false, title: 'DuckDuckGo',
        error: text, code, raw: got.error, ms: got.ms,
      });
    }
  } else if (!settings.duckduckgo.enabled && !yandexOk) {
    checks.push({
      id: 'duckduckgo', ok: true, skipped: true,
      title: 'DuckDuckGo', detail: 'выключен — не проверялся',
    });
  }

  const yaCheck = checks.find(c => c.id === 'yandex');
  const ddgCheck = checks.find(c => c.id === 'duckduckgo');
  const ok = yandexTried ? yandexOk : Boolean(ddgCheck?.ok && !ddgCheck.skipped);
  let summary;
  if (ok && yandexOk && yaCheck?.warning) {
    summary = yaCheck.detail;
  } else if (ok && yandexOk) {
    summary = `Yandex Search API работает${yaCheck?.detail ? `: ${yaCheck.detail}` : '.'}`;
  } else if (ok) {
    summary = ddgCheck?.detail || 'Запасной поиск отвечает. Yandex выключен.';
  } else if (yaCheck && !yaCheck.ok) {
    summary = yaCheck.error;
    if (ddgCheck?.ok && !ddgCheck.skipped) {
      summary += ' Запасной DuckDuckGo отвечает — прогон сможет искать, но основной API не работает.';
    }
  } else {
    summary = ddgCheck?.error || 'Ни один поисковик не ответил.';
  }

  return { ok, summary, query, checks };
}

export async function searchWeb(query, config = {}) {
  const settings = resolveSearchSettings(config);
  const q = withSiteFilter(query, settings.duckduckgo);
  if (!q) throw new Error('пустой поисковый запрос');
  if (!settings.enabled) throw new Error('поиск выключен');

  const errors = [];
  let timeoutStreak = 0;
  const note = (msg, err) => {
    errors.push(msg);
    if ((err && isTimeoutError(err)) || /таймаут \d+ms/.test(String(msg))) {
      timeoutStreak++;
      // Два таймаута подряд — сеть не отвечает. Дальше те же 20с × движок
      // только откладывают отправку имени в модель.
      if (timeoutStreak >= 2) throw new Error(errors.join('; '));
    } else {
      timeoutStreak = 0;
    }
  };

  if (settings.yandex.enabled && settings.yandex.apiKey && settings.yandex.folderId) {
    try {
      return await searchYandex(query, config);
    } catch (e) {
      note(e.message, e);
    }
  }

  const extra = String(settings.extraUrl || '').trim();
  const custom = [
    ...(extra.includes('%s') ? [{ name: 'свой поисковик', url: extra }] : []),
    ...(settings.engines || []),
  ];
  const seenUrl = new Set();
  for (const eng of custom) {
    const template = String(eng.url || '');
    if (!template.includes('%s') || seenUrl.has(template)) continue;
    seenUrl.add(template);
    try {
      const url = template.replace('%s', encodeURIComponent(q));
      const host = new URL(url).hostname.replace(/^www\./, '');
      await waitGap('search', settings.gapMs);
      const urls = parseSearchResults(await fetchPage(url, { timeoutMs: settings.timeoutMs }), host, settings);
      if (urls.length) return urls;
      note(`${eng.name || host}: выдача без ссылок`);
    } catch (e) {
      note(`${eng.name || 'поиск'}: ${e.message}`, e);
    }
  }

  let ddgFailed = false;
  if (settings.duckduckgo.enabled) {
    try {
      return await searchDuckDuckGo(query, config);
    } catch (e) {
      ddgFailed = true;
      note(e.message, e);
    }
  }

  for (const name of settings.fallback) {
    const template = FALLBACK[name];
    if (!template) continue;
    // Lite — тот же DuckDuckGo. Если html уже не ответил, ждать ещё 20с незачем.
    if (name.startsWith('ddg') && ddgFailed) {
      errors.push(`${name}: пропущен, DuckDuckGo уже не ответил`);
      continue;
    }
    try {
      const url = template.replace('%s', encodeURIComponent(q));
      const host = new URL(url).hostname.replace(/^www\./, '');
      await waitGap('search', settings.gapMs);
      const html = await fetchPage(url, { timeoutMs: settings.timeoutMs });
      const urls = name.startsWith('ddg')
        ? parseDuckDuckGoResults(html, settings)
        : parseSearchResults(html, host, settings);
      if (urls.length) return urls;
      note(`${host}: выдача без ссылок`);
    } catch (e) {
      note(`${name}: ${e.message}`, e);
    }
  }

  throw new Error(errors.join('; ') || 'поисковики не настроены');
}

export function searchQuery(rec, configOrSettings = {}) {
  const settings = configOrSettings && 'querySuffix' in configOrSettings
    ? configOrSettings
    : resolveSearchSettings(configOrSettings);
  const suffix = String(settings.querySuffix ?? 'характеристики').trim();
  const brand = String(rec?.identity?.brand || rec?.brand || '').trim();
  const model = String(rec?.identity?.model || '').trim();
  // Полное имя с артикулом и маркетинговым хвостом чаще ловит капчу DDG
  // и чужие модификации, чем «бренд модель».
  if (model) return [brand, model, suffix].filter(Boolean).join(' ');
  const name = String(rec?.name || '').replace(/["«»]/g, ' ').replace(/\s+/g, ' ').trim();
  return suffix && name ? `${name} ${suffix}` : (name || suffix);
}

/**
 * Запрос за страной производства: бренд + модель, без маркетингового хвоста
 * имени. Полное имя — только если модели в карточке нет.
 */
export function countryQuery(rec) {
  const brand = String(rec?.identity?.brand || rec?.brand || '').trim();
  const model = String(rec?.identity?.model || '').trim();
  if (model) return [brand, model, 'страна производства'].filter(Boolean).join(' ');
  const name = String(rec?.name || '').replace(/["«»]/g, ' ').replace(/\s+/g, ' ').trim();
  return name ? `${name} страна производства` : '';
}

/**
 * Запрос за дырой в обязательном фильтре: та же модель, не артикул как число.
 * Одна ось — её имя в запрос («скорость отжима»); несколько — таблица характеристик.
 */
export function missingQuery(rec, dict, codes = []) {
  const brand = String(rec?.identity?.brand || rec?.brand || '').trim();
  const model = String(rec?.identity?.model || '').trim();
  const unique = [...new Set((codes || []).filter(Boolean))];
  let hint = 'характеристики';
  if (unique.length === 1) {
    const attr = dict?.byCode?.get(unique[0]);
    const raw = String(attr?.facet?.label || attr?.name || '').trim();
    const stripped = raw.replace(/,\s*[^,]+$/, '').trim();
    if (stripped) hint = stripped;
  }
  if (model) return [brand, model, hint].filter(Boolean).join(' ');
  const name = String(rec?.name || '').replace(/["«»]/g, ' ').replace(/\s+/g, ' ').trim();
  return name ? `${name} ${hint}` : hint;
}
