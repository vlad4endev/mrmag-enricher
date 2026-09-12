#!/usr/bin/env node
/**
 * Собирает конфиг Xray-клиента из VLESS_LINK (share-ссылка из 3x-ui / панели).
 * Пишет JSON в путь из argv[2] или stdout.
 *
 * Поддержка: tcp/ws/grpc, security=none|tls|reality, flow=xtls-rprx-vision.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function q(sp, key, fallback = '') {
  const v = sp.get(key);
  return v == null || v === '' ? fallback : v;
}

export function parseVlessLink(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('VLESS_LINK пуст');
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new Error('VLESS_LINK: не удалось разобрать URL');
  }
  if (url.protocol !== 'vless:') {
    throw new Error(`VLESS_LINK: нужен vless://, сейчас ${url.protocol}`);
  }
  const uuid = decodeURIComponent(url.username || '');
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) {
    throw new Error('VLESS_LINK: нет UUID (vless://UUID@host:port?…)');
  }
  const host = url.hostname;
  const port = Number(url.port) || 443;
  if (!host) throw new Error('VLESS_LINK: нет host');

  const sp = url.searchParams;
  const type = (q(sp, 'type', 'tcp') || 'tcp').toLowerCase();
  const security = (q(sp, 'security', 'none') || 'none').toLowerCase();
  const flow = q(sp, 'flow', '');
  const sni = q(sp, 'sni', q(sp, 'host', host));
  const fp = q(sp, 'fp', 'chrome') || 'chrome';
  const alpn = q(sp, 'alpn', '');
  const path = decodeURIComponent(q(sp, 'path', '/'));
  const wsHost = q(sp, 'host', sni);
  const serviceName = q(sp, 'serviceName', q(sp, 'servicename', ''));
  const pbk = q(sp, 'pbk', '');
  const sid = q(sp, 'sid', '');
  const spx = q(sp, 'spx', '');
  const encryption = q(sp, 'encryption', 'none') || 'none';

  return {
    uuid, host, port, type, security, flow, sni, fp, alpn, path, wsHost, serviceName, pbk, sid, spx, encryption,
  };
}

export function buildXrayConfig(link, {
  socksPort = 1080,
  httpPort = 7890,
} = {}) {
  const p = typeof link === 'string' ? parseVlessLink(link) : link;

  const user = {
    id: p.uuid,
    encryption: p.encryption || 'none',
    level: 0,
  };
  if (p.flow) user.flow = p.flow;

  const streamSettings = {
    network: p.type === 'ws' || p.type === 'grpc' ? p.type : 'tcp',
  };

  if (p.type === 'ws') {
    streamSettings.wsSettings = {
      path: p.path || '/',
      headers: p.wsHost ? { Host: p.wsHost } : {},
    };
  } else if (p.type === 'grpc') {
    streamSettings.grpcSettings = {
      serviceName: p.serviceName || '',
    };
  }

  if (p.security === 'reality') {
    if (!p.pbk) throw new Error('VLESS Reality: в ссылке нет pbk (public key)');
    streamSettings.security = 'reality';
    streamSettings.realitySettings = {
      show: false,
      fingerprint: p.fp || 'chrome',
      serverName: p.sni || p.host,
      publicKey: p.pbk,
      shortId: p.sid || '',
      spiderX: p.spx || '',
    };
  } else if (p.security === 'tls') {
    streamSettings.security = 'tls';
    streamSettings.tlsSettings = {
      serverName: p.sni || p.host,
      allowInsecure: false,
      fingerprint: p.fp || 'chrome',
      ...(p.alpn ? { alpn: p.alpn.split(',').map(x => x.trim()).filter(Boolean) } : {}),
    };
  } else {
    streamSettings.security = 'none';
  }

  return {
    log: { loglevel: process.env.XRAY_LOG_LEVEL || 'warning' },
    inbounds: [
      {
        tag: 'socks-in',
        listen: '0.0.0.0',
        port: Number(socksPort) || 1080,
        protocol: 'socks',
        settings: { udp: false, auth: 'noauth' },
        sniffing: { enabled: true, destOverride: ['http', 'tls'] },
      },
      {
        tag: 'http-in',
        listen: '0.0.0.0',
        port: Number(httpPort) || 7890,
        protocol: 'http',
        settings: { allowTransparent: false },
        sniffing: { enabled: true, destOverride: ['http', 'tls'] },
      },
    ],
    outbounds: [
      {
        tag: 'vless-out',
        protocol: 'vless',
        settings: {
          vnext: [{
            address: p.host,
            port: p.port,
            users: [user],
          }],
        },
        streamSettings,
      },
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' },
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', outboundTag: 'vless-out', inboundTag: ['socks-in', 'http-in'] },
      ],
    },
  };
}

const ranAsCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (ranAsCli) {
  const outPath = process.argv[2];
  const link = process.env.VLESS_LINK || '';
  try {
    const cfg = buildXrayConfig(link, {
      socksPort: process.env.VLESS_SOCKS_PORT || 1080,
      httpPort: process.env.VLESS_HTTP_PORT || 7890,
    });
    const json = JSON.stringify(cfg, null, 2);
    if (outPath) writeFileSync(outPath, json);
    else process.stdout.write(json);
  } catch (e) {
    console.error(`vless-config: ${e.message}`);
    process.exit(1);
  }
}
