/**
 * socks.js — мост SOCKS5 → HTTP CONNECT.
 *
 * Встроенная поддержка прокси в Node (NODE_USE_ENV_PROXY) понимает только
 * HTTP-прокси. Провайдеры же обычно выдают SOCKS5, в том числе ссылкой вида
 * tg://socks?server=...&port=...&user=...&pass=... Переписывать весь fetch ради
 * этого не нужно: поднимаем на localhost крошечный HTTP-прокси, который каждый
 * CONNECT уводит в SOCKS5.
 *
 * Трафик остаётся сквозным TLS: мост видит только имя хоста, но не содержимое,
 * поэтому ключ OpenRouter владельцу прокси не достаётся.
 */

import net from 'net';

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
 * Поднимает мост, если задан SOCKS_PROXY, и направляет в него весь исходящий
 * https. Вызывать до первого fetch: переменные окружения Node читает при
 * создании соединения, поэтому выставленные на старте они подхватываются.
 */
export async function setupProxy(log = () => {}) {
  const raw = process.env.SOCKS_PROXY;
  if (!raw) return null;

  const cfg = parseProxy(raw);
  const bridge = await startBridge(cfg);
  process.env.NODE_USE_ENV_PROXY = '1';
  process.env.HTTPS_PROXY = bridge.url;
  // Каталог магазина через заграничный прокси гонять незачем — лишний крюк и
  // лишняя точка отказа. Свой список, если задан, не трогаем.
  if (!process.env.NO_PROXY && !process.env.no_proxy) {
    process.env.NO_PROXY = 'mrmag.ru,localhost,127.0.0.1';
  }
  log(`  Прокси: SOCKS5 ${cfg.host}:${cfg.port}${cfg.user ? ` (логин ${cfg.user})` : ''} → ${bridge.url}`);
  log(`  Мимо прокси: ${process.env.NO_PROXY || process.env.no_proxy}`);
  return { cfg, ...bridge };
}
