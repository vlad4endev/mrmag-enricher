/**
 * Поиск той же модели: DuckDuckGo (HTML POST, без ключа) и запасные движки.
 *
 * Настройки — config.json → search / search.duckduckgo.
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

const ENGINE_HOST = /(?:^|\.)(?:duckduckgo|google|gstatic|googleusercontent|yastatic|bing|brave|mojeek)\./i;

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

let lastFetch = 0;
let lastSearch = 0;

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

/**
 * Сводит config.json.search и переменные окружения.
 * WEB_LOOKUP=0 / DDG_REGION / SEARCH_URL перекрывают файл.
 */
export function resolveSearchSettings(config = {}) {
  const s = config.search || {};
  const ddg = s.duckduckgo || {};
  const envOff = process.env.WEB_LOOKUP === '0';
  return {
    enabled: !envOff && s.enabled !== false,
    tries: num(process.env.WEB_LOOKUP_TRIES, s.tries, 3),
    gapMs: num(process.env.SEARCH_GAP_MS, s.gap_ms, 3000),
    timeoutMs: num(s.timeout_ms, 20_000),
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
  const enabled = search.enabled;
  let engine = 'выключен';
  if (enabled) {
    if (search.extraUrl) engine = 'свой поисковик';
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
    query_suffix: search.querySuffix,
    skip_hosts: search.skipHosts,
    search_url: search.extraUrl || null,
    fallback: search.fallback,
    engines: search.engines,
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
  const last = kind === 'search' ? lastSearch : lastFetch;
  const wait = gapMs - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  if (kind === 'search') lastSearch = Date.now();
  else lastFetch = Date.now();
}

export async function fetchPage(url, { timeoutMs = 20_000 } = {}) {
  const file = cachePath(url);
  if (fresh(file, ttlMs())) return fs.readFileSync(file, 'utf-8');

  await waitGap('fetch', Number(process.env.CRAWL_GAP_MS || 250));

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
}

async function fetchForm(url, body, { timeoutMs = 20_000, cacheKey, gapMs } = {}) {
  const file = cachePath(cacheKey || `${url}?${body}`);
  if (fresh(file, ttlMs())) return fs.readFileSync(file, 'utf-8');

  await waitGap('search', gapMs ?? Number(process.env.SEARCH_GAP_MS || 3000));

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

function withSiteFilter(query, ddg) {
  const q = String(query || '').replace(/\s+/g, ' ').trim();
  const site = String(ddg?.siteFilter || '').trim();
  return site ? `${q} site:${site}` : q;
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

export async function searchWeb(query, config = {}) {
  const settings = resolveSearchSettings(config);
  const q = withSiteFilter(query, settings.duckduckgo);
  if (!q) throw new Error('пустой поисковый запрос');
  if (!settings.enabled) throw new Error('поиск выключен');

  const errors = [];

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
      errors.push(`${eng.name || host}: выдача без ссылок`);
    } catch (e) {
      errors.push(`${eng.name || 'поиск'}: ${e.message}`);
    }
  }

  if (settings.duckduckgo.enabled) {
    try {
      return await searchDuckDuckGo(query, config);
    } catch (e) {
      errors.push(e.message);
    }
  }

  for (const name of settings.fallback) {
    const template = FALLBACK[name];
    if (!template) continue;
    try {
      const url = template.replace('%s', encodeURIComponent(q));
      const host = new URL(url).hostname.replace(/^www\./, '');
      await waitGap('search', settings.gapMs);
      const html = await fetchPage(url, { timeoutMs: settings.timeoutMs });
      const urls = name.startsWith('ddg')
        ? parseDuckDuckGoResults(html, settings)
        : parseSearchResults(html, host, settings);
      if (urls.length) return urls;
      errors.push(`${host}: выдача без ссылок`);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }

  throw new Error(errors.join('; ') || 'поисковики не настроены');
}

export function searchQuery(rec, configOrSettings = {}) {
  const settings = configOrSettings && 'querySuffix' in configOrSettings
    ? configOrSettings
    : resolveSearchSettings(configOrSettings);
  const suffix = String(settings.querySuffix ?? 'характеристики').trim();
  const name = String(rec?.name || '').replace(/["«»]/g, ' ').replace(/\s+/g, ' ').trim();
  if (name) return suffix ? `${name} ${suffix}` : name;
  const bits = [rec?.identity?.brand, rec?.identity?.model, suffix].filter(Boolean);
  return bits.join(' ');
}
