/**
 * socks.js — мост SOCKS5 → HTTP CONNECT и маршрутизация LLM-запросов.
 *
 * Встроенная поддержка прокси в Node (NODE_USE_ENV_PROXY) понимает только
 * HTTP-прокси. Провайдеры же обычно выдают SOCKS5, в том числе ссылкой вида
 * tg://socks?server=...&port=...&user=...&pass=... Переписывать весь fetch ради
 * этого не нужно: поднимаем на localhost крошечный HTTP-прокси, который каждый
 * CONNECT уводит в SOCKS5.
 *
 * Трафик остаётся сквозным TLS: мост видит только имя хоста, но не содержимое,
 * поэтому ключ OpenRouter владельцу прокси не достаётся.
 *
 * LLM-вызовы идут через providerFetch(): явный выбор «через прокси / напрямую»
 * на провайдера, без зависимости от того, успел ли Node зафиксировать HTTPS_PROXY.
 */

import net from 'net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

/**
 * Разбирает адрес прокси. Понимает socks5://user:pass@host:port и ссылку
 * tg://socks?server=..., которую дают телеграм-прокси.
 */
export function parseProxy(str) {
  const s = String(str || '').trim();
  if (!s) return null;

  if (/^(tg|https?):\/\/(socks|proxy)/i.test(s) || s.includes('?server=')) {
    const q = new URLSearchParams(s.slice(s.indexOf('?') + 1));
    const host = q.get('server');
    const port = Number(q.get('port'));
    if (!host || !port) throw new Error('в ссылке прокси нет server или port');
    return { host, port, user: q.get('user') || null, pass: q.get('pass') || null };
  }

  let u;
  try { u = new URL(s.includes('://') ? s : `socks5://${s}`); }
  catch { throw new Error(`не разобрать адрес прокси: ${s.slice(0, 40)}`); }
  if (!u.hostname || !u.port) throw new Error('в адресе прокси нет хоста или порта');
  return {
    host: u.hostname,
    port: Number(u.port),
    user: u.username ? decodeURIComponent(u.username) : null,
    pass: u.password ? decodeURIComponent(u.password) : null,
  };
}

const REPLY = [
  'ok', 'общий сбой сервера', 'запрещено правилами', 'сеть недоступна',
  'хост недоступен', 'соединение отклонено', 'TTL истёк',
  'команда не поддерживается', 'тип адреса не поддерживается',
];

/**
 * Пошаговое чтение рукопожатия одним накопительным буфером.
 *
 * Наивный вариант «повесить data, снять после n байт, лишнее вернуть через
 * unshift» теряет данные: сокет остаётся в потоковом режиме, и возвращённый
 * хвост эмитится в момент, когда слушателя уже нет. Поэтому слушатель один на
 * всё рукопожатие, а остаток отдаётся вызывающему явно.
 */
function reader(sock) {
  let buf = Buffer.alloc(0);
  let want = 0, pending = null;
  const pump = () => {
    if (!pending || buf.length < want) return;
    const out = buf.subarray(0, want);
    buf = buf.subarray(want);
    const done = pending;
    pending = null;
    done(out);
  };
  const onData = d => { buf = Buffer.concat([buf, d]); pump(); };
  sock.on('data', onData);
  return {
    read: n => new Promise(resolve => { want = n; pending = resolve; pump(); }),
    /** Снимает слушателя и возвращает непрочитанный хвост. */
    finish: () => { sock.off('data', onData); return buf; },
  };
}

/** Открывает через SOCKS5 туннель до host:port и отдаёт готовый сокет. */
export function socksConnect(cfg, host, port, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const s = net.connect(cfg.port, cfg.host);
    const fail = e => { s.destroy(); reject(e instanceof Error ? e : new Error(e)); };
    s.setTimeout(timeoutMs, () => fail(new Error(`прокси ${cfg.host}:${cfg.port} не отвечает`)));
    s.once('error', e => fail(new Error(`прокси ${cfg.host}:${cfg.port}: ${e.message}`)));

    s.once('connect', async () => {
      const rd = reader(s);
      try {
        // Предлагаем оба метода: без пароля и логин/пароль.
        s.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
        const [, method] = await rd.read(2);

        if (method === 0x02) {
          if (!cfg.user) throw new Error('прокси требует логин и пароль');
          const u = Buffer.from(cfg.user), p = Buffer.from(cfg.pass || '');
          s.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          const [, status] = await rd.read(2);
          if (status !== 0x00) throw new Error('прокси отклонил логин или пароль');
        } else if (method !== 0x00) {
          throw new Error('прокси не поддерживает ни один из предложенных методов авторизации');
        }

        // latin1: заголовки HTTP читаются побайтово, и в SOCKS должны уйти те же
        // байты. utf8 здесь переисказил бы всё, что вне ASCII.
        const dom = Buffer.from(host, 'latin1');
        s.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, dom.length]), dom,
          Buffer.from([port >> 8, port & 0xff]),
        ]));
        const rep = await rd.read(4);
        if (rep[1] !== 0x00) throw new Error(`SOCKS: ${REPLY[rep[1]] ?? rep[1]}`);
        // Дочитываем адрес привязки: 4 байта IPv4, 16 — IPv6, либо длина+имя.
        const extra = rep[3] === 0x01 ? 4 : rep[3] === 0x04 ? 16 : (await rd.read(1))[0];
        await rd.read(extra + 2);

        // Хвост, пришедший вместе с ответом, принадлежит уже туннелю: ставим
        // сокет на паузу, снимаем слушателя и возвращаем байты в поток —
        // дальше их заберёт pipe.
        s.pause();
        const rest = rd.finish();
        if (rest.length) s.unshift(rest);
        s.setTimeout(0);
        resolve(s);
      } catch (e) { rd.finish(); fail(e); }
    });
  });
}

/**
 * Поднимает на localhost HTTP-прокси, переводящий CONNECT в SOCKS5.
 * Возвращает { url, close } — url кладётся в HTTPS_PROXY.
 */
export function startBridge(cfg, port = 0, host = '127.0.0.1') {
  const server = net.createServer(client => {
    client.once('error', () => client.destroy());
    let head = '';
    const onData = chunk => {
      head += chunk.toString('latin1');
      if (head.length > 8192) return client.destroy();
      if (!head.includes('\r\n\r\n')) return;
      client.off('data', onData);

      const m = /^CONNECT\s+(\S+?):(\d+)/i.exec(head);
      if (!m) return client.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n');

      socksConnect(cfg, m[1], Number(m[2])).then(upstream => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        client.pipe(upstream);
        upstream.pipe(client);
        upstream.once('error', () => client.destroy());
      }).catch(e => {
        client.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${e.message}`);
      });
    };
    client.on('data', onData);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${server.address().port}`;
      resolve({ url, server, close: () => new Promise(r => server.close(r)) });
    });
  });
}

/**
 * Хосты, которые не гоняем через прокси OpenRouter. Каталог — российский,
 * DeepSeek и Yandex Cloud Search API — отдельные API: телеграм-SOCKS часто
 * рвёт CONNECT до чужих хостов (таймаут / «Request was cancelled»), а с
 * этого IP они доступны. Карточки dns-shop / atlant-online из выдачи Yandex
 * fetch'ем через SOCKS не качаем: для них fetchDirect (свой Agent, без прокси).
 * Search API ещё и сверяет IP с кабинетом (код 33) —
 * через заграничный SOCKS ключ не примется. Дописываем даже если NO_PROXY
 * уже стоит в .env.
 */
export const DIRECT_HOSTS = [
  'mrmag.ru', 'localhost', '127.0.0.1',
  'api.deepseek.com', '.deepseek.com',
  'searchapi.api.cloud.yandex.net', '.api.cloud.yandex.net',
];

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const brotli = promisify(zlib.brotliDecompress);

const directAgents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 8 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 8 }),
};

const MAX_DIRECT_BODY = 8 * 1024 * 1024;

async function decodeHttpBody(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc.includes('br')) return (await brotli(buf)).toString('utf8');
    if (enc.includes('gzip')) return (await gunzip(buf)).toString('utf8');
    if (enc.includes('deflate')) return (await inflate(buf)).toString('utf8');
  } catch {
    return buf.toString('utf8');
  }
  return buf.toString('utf8');
}

/**
 * GET HTML мимо HTTPS_PROXY / SOCKS OpenRouter.
 *
 * global fetch при NODE_USE_ENV_PROXY=1 гоняет dns-shop и atlant-online
 * в тот же заграничный SOCKS, что и Cloudflare: CONNECT висит, в логе
 * «не открылась». https.request со своим Agent идёт с этого IP.
 */
export function fetchDirect(url, {
  headers = {},
  timeoutMs = 20_000,
  method = 'GET',
  maxRedirects = 5,
} = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); }
    catch { return reject(new Error(`не URL: ${url}`)); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return reject(new Error(`схема ${u.protocol} не поддерживается`));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method,
      headers,
      agent: directAgents[u.protocol],
      timeout: timeoutMs,
    }, res => {
      const loc = res.headers.location;
      if (loc && [301, 302, 303, 307, 308].includes(res.statusCode) && hops < maxRedirects) {
        res.resume();
        const next = new URL(loc, u).href;
        const hopMethod = [307, 308].includes(res.statusCode) ? method : 'GET';
        return resolve(fetchDirect(next, { headers, timeoutMs, method: hopMethod, maxRedirects }, hops + 1));
      }
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > MAX_DIRECT_BODY) {
          req.destroy();
          reject(new Error(`ответ больше ${MAX_DIRECT_BODY} байт`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          url: u.href,
          headers: res.headers,
          async text() {
            return decodeHttpBody(buf, res.headers['content-encoding']);
          },
        });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => {
      req.destroy();
      const e = new Error(`таймаут ${timeoutMs}ms (${u.hostname})`);
      e.name = 'TimeoutError';
      reject(e);
    });
    req.on('error', reject);
    req.end();
  });
}

export function mergeNoProxy(...hosts) {
  const hasUpper = process.env.NO_PROXY != null;
  const hasLower = process.env.no_proxy != null;
  const envKey = hasUpper || !hasLower ? 'NO_PROXY' : 'no_proxy';
  const have = [];
  const seen = new Set();
  for (const h of [...String(process.env.NO_PROXY || process.env.no_proxy || '').split(/[\s,]+/), ...hosts]) {
    const s = String(h || '').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    have.push(s);
  }
  process.env[envKey] = have.join(',');
  if (envKey === 'NO_PROXY' && hasLower) process.env.no_proxy = process.env.NO_PROXY;
  if (envKey === 'no_proxy' && hasUpper) process.env.NO_PROXY = process.env.no_proxy;
  return process.env[envKey];
}

export function applyDirectHosts(extra = []) {
  const proxied = isProxyActive()
    || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.SOCKS_PROXY;
  if (!proxied) return process.env.NO_PROXY || process.env.no_proxy || '';
  return mergeNoProxy(...DIRECT_HOSTS, ...extra);
}

/** Хост провайдера для NO_PROXY, когда у него use_proxy=false. */
export function hostFromUrl(url) {
  try { return new URL(String(url || '')).hostname; }
  catch { return ''; }
}

export function mergeProviderBypassHosts(providers = []) {
  const hosts = [];
  for (const p of providers) {
    if (p?.use_proxy !== false) continue;
    const h = hostFromUrl(p.base_url);
    if (h) hosts.push(h, `.${h.replace(/^\./, '')}`);
  }
  return applyDirectHosts(hosts);
}

// ── Runtime proxy (настройки UI + .env) ───────────────────────

const runtime = {
  enabled: false,
  httpProxyUrl: null,
  socksCfg: null,
  bridge: null,
  source: 'none',
  rawMasked: '',
  bridgePort: 18080,
};

function maskProxyUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    if (/^(tg|https?):\/\/(socks|proxy)/i.test(s) || s.includes('?server=')) {
      const q = new URLSearchParams(s.slice(s.indexOf('?') + 1));
      const host = q.get('server') || '?';
      const port = q.get('port') || '?';
      const user = q.get('user');
      return user
        ? `tg://socks?server=${host}&port=${port}&user=${user}&pass=••••`
        : `tg://socks?server=${host}&port=${port}`;
    }
    const u = new URL(s.includes('://') ? s : `socks5://${s}`);
    if (u.password) u.password = '••••';
    return u.toString();
  } catch {
    return s.slice(0, 24) + (s.length > 24 ? '…' : '');
  }
}

function isHttpProxyUrl(raw) {
  try {
    const u = new URL(String(raw || '').includes('://') ? String(raw) : `http://${raw}`);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** SOCKS5 / tg://socks — не путать с обычным http://proxy.example:3128. */
function isSocksLike(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  if (/^socks5?:\/\//i.test(s)) return true;
  if (/^(tg|https?):\/\/socks\b/i.test(s)) return true;
  if (/[?&]server=/i.test(s) && /socks/i.test(s)) return true;
  // host:port или user:pass@host:port без схемы — SOCKS5
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true;
  return false;
}

export function isProxyActive() {
  return !!(runtime.enabled && runtime.httpProxyUrl);
}

export function getProxyHttpUrl() {
  return isProxyActive() ? runtime.httpProxyUrl : null;
}

export function proxyRuntimeInfo() {
  return {
    active: isProxyActive(),
    source: runtime.source,
    mode: runtime.socksCfg ? 'socks5' : (runtime.httpProxyUrl ? 'http' : 'none'),
    bridge_url: runtime.bridge?.url || null,
    host: runtime.socksCfg?.host
      || (runtime.httpProxyUrl ? hostFromUrl(runtime.httpProxyUrl) : null),
    url_hint: runtime.rawMasked || '',
    bridge_port: runtime.bridgePort,
  };
}

async function closeOwnedBridge() {
  if (!runtime.bridge) return;
  try { await runtime.bridge.close(); } catch { /* */ }
  runtime.bridge = null;
}

/**
 * Включает/выключает исходящий прокси для providerFetch.
 * url: socks5://… | tg://socks?… | http://user:pass@host:port
 * Пустой url при enabled=true — ошибка.
 */
export async function applyProxyConfig({
  enabled = false,
  url = '',
  bridge_port,
  source = 'settings',
} = {}, log = () => {}) {
  let port = Number(bridge_port || process.env.SOCKS_BRIDGE_PORT || 18080) || 18080;
  // Не слушаем на порту самого SOCKS (частая ошибка: 3443 из tg:// ссылки).
  if (url) {
    try {
      const socks = parseProxy(url);
      if (socks?.port && port === socks.port) port = 18080;
    } catch { /* validate later */ }
  }
  if (port === 3443) port = 18080;
  runtime.bridgePort = port;

  if (!enabled || !String(url || '').trim()) {
    await closeOwnedBridge();
    runtime.enabled = false;
    runtime.httpProxyUrl = null;
    runtime.socksCfg = null;
    runtime.source = 'none';
    runtime.rawMasked = '';
    applyDirectHosts();
    log('  Прокси: выключен');
    return { active: false };
  }

  const raw = String(url).trim();
  runtime.rawMasked = maskProxyUrl(raw);

  if (isSocksLike(raw)) {
    const cfg = parseProxy(raw);
    const expected = `http://127.0.0.1:${port}`;
    // Переиспользуем мост, если уже слушает тот же порт.
    if (!runtime.bridge || runtime.bridge.url !== expected) {
      await closeOwnedBridge();
      try {
        runtime.bridge = await startBridge(cfg, port);
      } catch (e) {
        throw new Error(e.code === 'EADDRINUSE'
          ? `порт моста ${port} занят — задайте другой bridge_port / SOCKS_BRIDGE_PORT`
          : e.message);
      }
    }
    runtime.socksCfg = cfg;
    runtime.httpProxyUrl = runtime.bridge.url;
    runtime.enabled = true;
    runtime.source = source;
    process.env.NODE_USE_ENV_PROXY = '1';
    // Не перетираем заранее заданный HTTPS_PROXY из .env, если он уже указывает на мост.
    const preset = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (!preset || preset === expected) process.env.HTTPS_PROXY = runtime.bridge.url;
    applyDirectHosts();
    log(`  Прокси: SOCKS5 ${cfg.host}:${cfg.port}${cfg.user ? ` (логин ${cfg.user})` : ''} → ${runtime.bridge.url} [${source}]`);
    log(`  Мимо прокси: ${process.env.NO_PROXY || process.env.no_proxy || ''}`);
    return { active: true, ...proxyRuntimeInfo() };
  }

  if (!isHttpProxyUrl(raw)) {
    throw new Error('адрес прокси: нужен socks5://, tg://socks?… или http(s)://');
  }
  await closeOwnedBridge();
  runtime.socksCfg = null;
  const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
  runtime.httpProxyUrl = u.toString();
  runtime.enabled = true;
  runtime.source = source;
  process.env.NODE_USE_ENV_PROXY = '1';
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy) {
    process.env.HTTPS_PROXY = runtime.httpProxyUrl;
  }
  applyDirectHosts();
  log(`  Прокси: HTTP ${u.hostname}:${u.port || 80}${u.username ? ` (логин ${decodeURIComponent(u.username)})` : ''} [${source}]`);
  log(`  Мимо прокси: ${process.env.NO_PROXY || process.env.no_proxy || ''}`);
  return { active: true, ...proxyRuntimeInfo() };
}

/**
 * Старт: сначала .env (SOCKS_PROXY / HTTPS_PROXY), затем настройки из файла,
 * если в .env прокси не задан.
 */
export async function setupProxy(log = () => {}, settingsProxy = null) {
  const envSocks = process.env.SOCKS_PROXY;
  const envHttp = process.env.HTTPS_PROXY || process.env.https_proxy;
  const fromSettings = settingsProxy && settingsProxy.enabled !== false && settingsProxy.url;

  if (envSocks) {
    // Порт моста: только SOCKS_BRIDGE_PORT из env, иначе 18080.
    // settings.bridge_port сюда не берём — туда часто попадает порт SOCKS.
    const out = await applyProxyConfig({
      enabled: true,
      url: envSocks,
      bridge_port: process.env.SOCKS_BRIDGE_PORT || 18080,
      source: 'env',
    }, log);
    const expected = `http://127.0.0.1:${runtime.bridgePort}`;
    if (!envHttp) {
      log(`  ⚠  HTTPS_PROXY не был задан до старта. Часть версий Node это уже не`);
      log(`     подхватит для системного fetch. LLM-запросы идут через явный маршрут.`);
      log(`       HTTPS_PROXY=${expected}`);
    } else if (envHttp !== expected && runtime.bridge) {
      log(`  ⚠  HTTPS_PROXY=${envHttp} не совпадает с мостом ${expected}`);
    }
    return out;
  }

  if (envHttp && !fromSettings) {
    // Чистый HTTP-прокси из .env без SOCKS.
    const out = await applyProxyConfig({
      enabled: true,
      url: envHttp,
      source: 'env',
    }, log);
    return out;
  }

  if (fromSettings) {
    return applyProxyConfig({
      enabled: settingsProxy.enabled !== false,
      url: settingsProxy.url,
      bridge_port: settingsProxy.bridge_port,
      source: 'settings',
    }, log);
  }

  await applyProxyConfig({ enabled: false }, log);
  const bypass = applyDirectHosts();
  if (bypass && (process.env.HTTPS_PROXY || process.env.https_proxy)) {
    log(`  Мимо прокси: ${bypass}`);
  }
  return null;
}

// ── fetch с явным маршрутом (прокси / напрямую) ───────────────

function headersFromNode(raw) {
  const map = new Map();
  for (const [k, v] of Object.entries(raw || {})) {
    if (v == null) continue;
    map.set(String(k).toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v));
  }
  return {
    get: name => map.get(String(name).toLowerCase()) || null,
    has: name => map.has(String(name).toLowerCase()),
    entries: () => map.entries(),
  };
}

function fetchResponse(status, headers, buf, url) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: http.STATUS_CODES[status] || '',
    headers: headersFromNode(headers),
    url,
    async text() {
      return decodeHttpBody(buf, headers['content-encoding']);
    },
    async json() {
      return JSON.parse(await this.text());
    },
  };
}

function proxyAuthHeader(proxyUrl) {
  try {
    const u = new URL(proxyUrl);
    if (!u.username) return {};
    const token = Buffer.from(
      `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}`,
      'utf8',
    ).toString('base64');
    return { 'Proxy-Authorization': `Basic ${token}` };
  } catch {
    return {};
  }
}

/** TCP через HTTP CONNECT до targetHost:targetPort. */
function connectHttpProxy(proxyUrl, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    let proxy;
    try { proxy = new URL(proxyUrl); }
    catch { return reject(new Error(`не URL прокси: ${proxyUrl}`)); }
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: {
        Host: `${targetHost}:${targetPort}`,
        ...proxyAuthHeader(proxyUrl),
      },
      timeout: timeoutMs,
    });
    let settled = false;
    const fail = e => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    // Не-200 на CONNECT (502 от моста, если SOCKS упал) приходит как
    // «response», а не «connect» — без слушателя запрос висит до таймаута.
    req.once('response', res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').trim().slice(0, 200);
        fail(new Error(
          body || `прокси CONNECT ${res.statusCode} (SOCKS недоступен или отклонил вход)`,
        ));
      });
      res.on('error', fail);
    });
    req.once('connect', (res, socket) => {
      if (settled) {
        socket.destroy();
        return;
      }
      if (res.statusCode !== 200) {
        socket.destroy();
        return fail(new Error(`прокси CONNECT ${res.statusCode}`));
      }
      settled = true;
      socket.setTimeout(0);
      resolve(socket);
    });
    req.once('timeout', () => fail(Object.assign(
      new Error(`прокси не отвечает ${timeoutMs}ms (CONNECT ${proxy.hostname}:${proxy.port || 80} → ${targetHost}:${targetPort})`),
      { name: 'TimeoutError' },
    )));
    req.once('error', fail);
    req.end();
  });
}

function readHttpMessage(socket, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let head = Buffer.alloc(0);
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      const e = new Error(`таймаут ${timeoutMs}ms`);
      e.name = 'TimeoutError';
      reject(e);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onErr);
      socket.off('end', onEnd);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onErr = e => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('соединение закрыто до ответа'));
    };
    const onData = chunk => {
      head = Buffer.concat([head, chunk]);
      const split = head.indexOf('\r\n\r\n');
      if (split < 0) {
        if (head.length > 1024 * 1024) {
          settled = true;
          cleanup();
          socket.destroy();
          reject(new Error('заголовки ответа слишком большие'));
        }
        return;
      }
      const rawHead = head.subarray(0, split).toString('latin1');
      let body = head.subarray(split + 4);
      const lines = rawHead.split('\r\n');
      const statusLine = lines[0] || '';
      const m = /^HTTP\/\d\.\d\s+(\d+)/i.exec(statusLine);
      if (!m) {
        settled = true;
        cleanup();
        socket.destroy();
        return reject(new Error('не HTTP-ответ'));
      }
      const status = Number(m[1]);
      const headers = {};
      for (let i = 1; i < lines.length; i++) {
        const idx = lines[i].indexOf(':');
        if (idx < 0) continue;
        const k = lines[i].slice(0, idx).trim().toLowerCase();
        const v = lines[i].slice(idx + 1).trim();
        headers[k] = headers[k] ? `${headers[k]}, ${v}` : v;
      }
      const len = headers['content-length'] != null ? Number(headers['content-length']) : null;
      const chunked = /chunked/i.test(headers['transfer-encoding'] || '');

      const finish = buf => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ status, headers, body: buf });
      };

      if (Number.isFinite(len) && len >= 0) {
        const take = () => {
          if (body.length >= len) {
            socket.pause();
            const out = body.subarray(0, len);
            const rest = body.subarray(len);
            if (rest.length) socket.unshift(rest);
            finish(out);
            return true;
          }
          return false;
        };
        if (take()) return;
        const more = c => {
          body = Buffer.concat([body, c]);
          if (body.length > MAX_DIRECT_BODY) {
            settled = true;
            cleanup();
            socket.destroy();
            reject(new Error(`ответ больше ${MAX_DIRECT_BODY} байт`));
            return;
          }
          take();
        };
        socket.on('data', more);
        socket.once('end', () => finish(body));
        return;
      }

      if (chunked) {
        const decode = () => {
          const parts = [];
          let pos = 0;
          while (true) {
            const nl = body.indexOf('\r\n', pos);
            if (nl < 0) return null;
            const sizeLine = body.subarray(pos, nl).toString('latin1').split(';')[0].trim();
            const size = parseInt(sizeLine, 16);
            if (!Number.isFinite(size)) return null;
            const start = nl + 2;
            const end = start + size;
            if (body.length < end + 2) return null;
            if (size === 0) {
              return Buffer.concat(parts);
            }
            parts.push(body.subarray(start, end));
            pos = end + 2;
          }
        };
        const tryDecode = () => {
          const out = decode();
          if (out) finish(out);
        };
        tryDecode();
        if (settled) return;
        socket.on('data', c => {
          body = Buffer.concat([body, c]);
          if (body.length > MAX_DIRECT_BODY) {
            settled = true;
            cleanup();
            socket.destroy();
            reject(new Error(`ответ больше ${MAX_DIRECT_BODY} байт`));
            return;
          }
          tryDecode();
        });
        socket.once('end', () => {
          const out = decode();
          finish(out || body);
        });
        return;
      }

      // Без длины — читаем до закрытия сокета.
      socket.on('data', c => {
        body = Buffer.concat([body, c]);
        if (body.length > MAX_DIRECT_BODY) {
          settled = true;
          cleanup();
          socket.destroy();
          reject(new Error(`ответ больше ${MAX_DIRECT_BODY} байт`));
        }
      });
      socket.once('end', () => finish(body));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    socket.on('data', onData);
    socket.on('error', onErr);
    socket.on('end', onEnd);
  });
}

/**
 * Универсальный HTTP(S) запрос: напрямую или через HTTP CONNECT-прокси.
 * Совместим с минимальным подмножеством fetch (ok/status/headers/text/json).
 */
export async function fetchHttp(url, {
  method = 'GET',
  headers = {},
  body = null,
  timeoutMs = 60_000,
  signal = null,
  proxyUrl = null,
} = {}) {
  let u;
  try { u = new URL(url); }
  catch { throw new Error(`не URL: ${url}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`схема ${u.protocol} не поддерживается`);
  }

  const payload = body == null ? null
    : (Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
  const hdrs = { ...(headers || {}) };
  if (payload && !Object.keys(hdrs).some(k => k.toLowerCase() === 'content-length')) {
    hdrs['Content-Length'] = String(payload.length);
  }
  if (!Object.keys(hdrs).some(k => k.toLowerCase() === 'host')) {
    hdrs.Host = u.host;
  }
  if (!Object.keys(hdrs).some(k => k.toLowerCase() === 'connection')) {
    hdrs.Connection = 'close';
  }

  const head = Object.entries(hdrs)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');
  const path = `${u.pathname}${u.search}` || '/';
  const reqLines = `${method.toUpperCase()} ${path} HTTP/1.1\r\n${head}\r\n\r\n`;

  let socket;
  if (proxyUrl) {
    const tunnel = await connectHttpProxy(proxyUrl, u.hostname, Number(u.port) || (u.protocol === 'https:' ? 443 : 80), timeoutMs);
    if (u.protocol === 'https:') {
      socket = await new Promise((resolve, reject) => {
        const s = tls.connect({
          socket: tunnel,
          servername: u.hostname,
          ALPNProtocols: ['http/1.1'],
        }, () => resolve(s));
        s.once('error', reject);
      });
    } else {
      socket = tunnel;
    }
  } else {
    const lib = u.protocol === 'https:' ? https : http;
    socket = await new Promise((resolve, reject) => {
      const req = lib.request(u, {
        method: method.toUpperCase(),
        headers: hdrs,
        agent: directAgents[u.protocol],
        timeout: timeoutMs,
        signal: signal || undefined,
      }, res => {
        const chunks = [];
        let size = 0;
        res.on('data', c => {
          size += c.length;
          if (size > MAX_DIRECT_BODY) {
            req.destroy();
            reject(new Error(`ответ больше ${MAX_DIRECT_BODY} байт`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          resolve({
            kind: 'direct-res',
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', reject);
      });
      req.on('timeout', () => {
        req.destroy();
        const e = new Error(`таймаут ${timeoutMs}ms (${u.hostname})`);
        e.name = 'TimeoutError';
        reject(e);
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
    if (socket.kind === 'direct-res') {
      return fetchResponse(socket.status, socket.headers, socket.body, u.href);
    }
  }

  socket.write(reqLines);
  if (payload) socket.write(payload);
  const msg = await readHttpMessage(socket, timeoutMs, signal);
  try { socket.destroy(); } catch { /* */ }
  return fetchResponse(msg.status, msg.headers, msg.body, u.href);
}

/**
 * Запрос к API провайдера ИИ: useProxy=true → через активный прокси,
 * иначе мимо (даже если в окружении стоит HTTPS_PROXY).
 */
export function providerFetch(url, init = {}, { useProxy = false } = {}) {
  const timeoutMs = (() => {
    if (init.signal?.timeout) return init.signal.timeout; // нестандартно
    return 120_000;
  })();
  // AbortSignal.timeout() не отдаёт ms — берём большой запас; вызывающий
  // передаёт свой signal, и readHttpMessage/https.request его уважают.
  const proxyUrl = useProxy ? getProxyHttpUrl() : null;
  if (useProxy && !proxyUrl) {
    // Прокси запрошен, но не настроен — обычный fetch (как раньше).
    return fetch(url, init);
  }
  return fetchHttp(url, {
    method: init.method || 'GET',
    headers: init.headers || {},
    body: init.body ?? null,
    signal: init.signal || null,
    timeoutMs,
    proxyUrl,
  });
}

/** Проверка: TCP до SOCKS → CONNECT через мост → HTTPS до цели. */
export async function probeProxy(targetUrl = 'https://openrouter.ai') {
  const info = proxyRuntimeInfo();
  if (!info.active) {
    return { ok: false, error: 'прокси не активен — включите в настройках или задайте SOCKS_PROXY', ...info };
  }
  const host = hostFromUrl(targetUrl) || 'openrouter.ai';
  const started = Date.now();
  const steps = [];

  if (runtime.socksCfg) {
    const { host: sh, port: sp } = runtime.socksCfg;
    const t0 = Date.now();
    try {
      await new Promise((resolve, reject) => {
        const s = net.connect(sp, sh);
        const fail = e => { s.destroy(); reject(e); };
        s.setTimeout(8_000, () => fail(Object.assign(new Error(`TCP ${sh}:${sp} таймаут`), { name: 'TimeoutError' })));
        s.once('error', fail);
        s.once('connect', () => { s.destroy(); resolve(); });
      });
      steps.push({ id: 'socks_tcp', ok: true, title: `TCP до SOCKS ${sh}:${sp}`, ms: Date.now() - t0 });
    } catch (e) {
      steps.push({ id: 'socks_tcp', ok: false, title: `TCP до SOCKS ${sh}:${sp}`, error: e.message, ms: Date.now() - t0 });
      return {
        ok: false,
        error: `SOCKS ${sh}:${sp} недоступен: ${e.message}`,
        ms: Date.now() - started,
        target: host,
        steps,
        ...info,
      };
    }

    const t1 = Date.now();
    try {
      const sock = await socksConnect(runtime.socksCfg, host, 443, 20_000);
      sock.destroy();
      steps.push({ id: 'socks_handshake', ok: true, title: `SOCKS CONNECT ${host}:443`, ms: Date.now() - t1 });
    } catch (e) {
      steps.push({ id: 'socks_handshake', ok: false, title: `SOCKS CONNECT ${host}:443`, error: e.message, ms: Date.now() - t1 });
      return {
        ok: false,
        error: `SOCKS отклонил туннель до ${host}: ${e.message}`,
        ms: Date.now() - started,
        target: host,
        steps,
        ...info,
      };
    }
  }

  const t2 = Date.now();
  try {
    const res = await fetchHttp(`https://${host}/`, {
      method: 'GET',
      headers: { Accept: '*/*', 'User-Agent': 'Ogran-proxy-probe/1' },
      timeoutMs: 25_000,
      proxyUrl: getProxyHttpUrl(),
    });
    steps.push({
      id: 'https',
      ok: true,
      title: `HTTPS через мост → ${host}`,
      status: res.status,
      ms: Date.now() - t2,
    });
    return {
      ok: true,
      status: res.status,
      ms: Date.now() - started,
      target: host,
      steps,
      ...info,
    };
  } catch (e) {
    steps.push({ id: 'https', ok: false, title: `HTTPS через мост → ${host}`, error: e.message, ms: Date.now() - t2 });
    return {
      ok: false,
      error: e.message || String(e),
      ms: Date.now() - started,
      target: host,
      steps,
      ...info,
    };
  }
}
