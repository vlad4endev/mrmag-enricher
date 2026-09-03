/**
 * Добор характеристик у товаров без своих данных (S3).
 *
 * 1. По имени ищем ту же модель в поисковике.
 * 2. Читаем страницы выдачи, пока бренд и модель не совпадут целиком.
 * 3. Таблицу характеристик разбираем тем же парсером, что и свой фид,
 *    и дописываем пустые поля. Уже заполненное из annotation не трогаем.
 *
 * WW80AG6S28AELP и WW80AGAS26AXLP — разные товары: чужая страница
 * с соседней моделью отбрасывается.
 */

import { extractPairsFromPage, visibleText } from './parse.js';
import { identityMatches } from './identity.js';
import { ingestPairs } from './normalize.js';
import { searchWeb, fetchPage, searchQuery, resolveSearchSettings } from './search.js';

const MIN_PAIRS = 3;

function filledCount(rec) {
  let n = 0;
  for (const [code, v] of Object.entries(rec.attrs || {})) {
    if (v == null || v === '') continue;
    if (code === 'brand' && rec.provenance?.brand?.level === 'S0') continue;
    n++;
  }
  return n;
}

/** Своих характеристик мало, а модель из имени есть — есть что искать. */
export function needsExternal(rec, { minAttrs = 5 } = {}) {
  if (!rec?.identity?.model) return false;
  return filledCount(rec) < minAttrs;
}

/**
 * Разобрать HTML-страницу характеристик. Без совпадения модели — пусто:
 * чужие цифры дороже пропуска.
 */
export function parseExternalSpecs(html, identity, dict) {
  const text = visibleText(html);
  if (!identityMatches(text, identity, dict)) {
    return { ok: false, reason: 'модель не совпала', pairs: [] };
  }
  const pairs = extractPairsFromPage(html, dict).map(p => ({ ...p, source: 'S3' }));
  if (pairs.length < MIN_PAIRS) {
    return { ok: false, reason: 'на странице мало характеристик', pairs };
  }
  return { ok: true, pairs };
}

export function applyExternal(rec, pairs, dict, config, meta = {}) {
  if (!pairs?.length) return rec;
  ingestPairs(rec, pairs, dict, config);
  rec.pairs = [...(rec.pairs || []), ...pairs];
  rec.flags.push('external_source');
  rec.external = {
    url: meta.url || null,
    query: meta.query || null,
    pairs: pairs.length,
    ...(meta.page_data ? { page_data: meta.page_data } : {}),
    ...(meta.web_info ? { web_info: meta.web_info } : {}),
  };
  return rec;
}

/**
 * Товар без данных → пары из HTML, если модель на странице та же.
 */
export function parseProductBySpecs(rec, html, dict, config, meta = {}) {
  const parsed = parseExternalSpecs(html, rec.identity, dict);
  if (!parsed.ok) return { rec, ...parsed };
  const page_data = meta.page_data || (html ? visibleText(html) : '');
  applyExternal(rec, parsed.pairs, dict, config, { ...meta, page_data });
  return { rec, ok: true, pairs: parsed.pairs };
}

/**
 * Найти товар в поисковике, взять характеристики, дописать в запись.
 * io.search / io.fetchHtml подставляются в тестах.
 */
export async function lookupExternal(rec, dict, config, io = {}) {
  const settings = resolveSearchSettings(config);
  const minAttrs = config?.description?.min_attrs ?? 5;
  if (!settings.enabled) {
    return { rec, ok: false, reason: 'поиск выключен' };
  }
  if (!needsExternal(rec, { minAttrs })) {
    return { rec, ok: false, reason: 'своих данных достаточно' };
  }
  const query = io.query || searchQuery(rec, settings);
  const search = io.search || (q => searchWeb(q, config));
  const fetchHtml = io.fetchHtml || (url => fetchPage(url, { timeoutMs: settings.timeoutMs }));
  const maxPages = io.maxPages ?? settings.tries;
  const onNote = io.onNote || (() => {});

  let urls = [];
  try {
    onNote(`ищем: ${query}`);
    urls = await search(query);
  } catch (e) {
    return { rec, ok: false, reason: `поиск не удался: ${e.message}`, query };
  }

  const tried = [];
  for (const url of (urls || []).slice(0, maxPages)) {
    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* оставляем url */ }
    let html;
    try { html = await fetchHtml(url); }
    catch { tried.push(`${host}: не открылась`); continue; }
    const got = parseProductBySpecs(rec, html, dict, config, { url, query });
    if (got.ok) {
      onNote(`взяли ${got.pairs.length} характеристик с ${host}`);
      return { rec, ok: true, url, query, pairs: got.pairs };
    }
    tried.push(`${host}: ${got.reason}`);
  }
  return {
    rec,
    ok: false,
    query,
    reason: tried.length ? tried.join('; ') : 'выдача пуста',
  };
}

export async function enrichMissing(recs, dict, config, io = {}) {
  if (!resolveSearchSettings(config).enabled) return [];
  const minAttrs = config?.description?.min_attrs ?? 5;
  const results = [];
  for (const rec of recs) {
    if (!needsExternal(rec, { minAttrs })) continue;
    results.push(await lookupExternal(rec, dict, config, io));
  }
  return results;
}
