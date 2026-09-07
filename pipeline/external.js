/**
 * Добор характеристик у товаров без своих данных (S3) и страны производства.
 *
 * 1. По имени ищем ту же модель в поисковике.
 * 2. Читаем страницы выдачи, пока бренд и модель (или опознавательные
 *    слова имени) не совпадут.
 * 3. Таблицу характеристик разбираем тем же парсером, что и свой фид,
 *    и дописываем пустые поля. Уже заполненное из annotation не трогаем.
 * 4. Если своих данных достаточно, но страны производства в исходнике нет —
 *    отдельный поиск по модели («бренд модель страна производства»).
 *
 * WW80AG6S28AELP и WW80AGAS26AXLP — разные товары: чужая страница
 * с соседней моделью отбрасывается.
 */

import { extractPairsFromPage, visibleText } from './parse.js';
import { identityMatches, nameKeyTokens } from './identity.js';
import { ingestPairs } from './normalize.js';
import { matchKey } from './match.js';
import { searchWeb, fetchPage, searchQuery, countryQuery, resolveSearchSettings } from './search.js';

const MIN_PAIRS = 2;

function filledCount(rec) {
  let n = 0;
  for (const [code, v] of Object.entries(rec.attrs || {})) {
    if (v == null || v === '') continue;
    if (code === 'brand' && rec.provenance?.brand?.level === 'S0') continue;
    n++;
  }
  return n;
}

/** Своих характеристик мало, а по имени товар ещё можно найти. */
export function needsExternal(rec, { minAttrs = 5 } = {}) {
  if (filledCount(rec) >= minAttrs) return false;
  if (rec?.identity?.model) return true;
  return nameKeyTokens(rec?.name || rec?.identity?.name, rec?.identity?.brand).length > 0;
}

/** Страны нет в исходнике, а по модели ещё можно найти чужую карточку. */
export function needsCountry(rec, dict) {
  if (!dict?.byCode?.has('country')) return false;
  const v = rec?.attrs?.country;
  if (v != null && v !== '') return false;
  if (rec?.identity?.model) return true;
  return nameKeyTokens(rec?.name || rec?.identity?.name, rec?.identity?.brand).length > 0;
}

/**
 * Разобрать HTML-страницу характеристик. Без совпадения модели или
 * опознавательных слов имени — пусто: чужие цифры дороже пропуска.
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

function countryPairsOf(pairs, dict, config) {
  const fuzzyMin = config?.fuzzy?.min_score ?? 0.9;
  return (pairs || []).filter(p => {
    const matched = matchKey(p.key, dict, { value: p.value, fuzzyMin });
    return matched.attr?.code === 'country';
  });
}

/**
 * На совпавшей модели достаточно одной пары «страна — значение».
 * MIN_PAIRS для полной таблицы здесь не действует: ищем только страну.
 */
export function parseCountryFromPage(html, identity, dict, config) {
  const text = visibleText(html);
  if (!identityMatches(text, identity, dict)) {
    return { ok: false, reason: 'модель не совпала', pairs: [] };
  }
  const pairs = extractPairsFromPage(html, dict).map(p => ({ ...p, source: 'S3' }));
  const country = countryPairsOf(pairs, dict, config);
  if (!country.length) return { ok: false, reason: 'страны нет на странице', pairs };
  return { ok: true, pairs: country };
}

/**
 * Найти страну производства по модели. Чужие поля не трогаем:
 * карточка уже заполнена, нужен только пропуск в исходнике.
 */
export async function lookupCountry(rec, dict, config, io = {}) {
  const settings = resolveSearchSettings(config);
  if (!settings.enabled) {
    return { rec, ok: false, reason: 'поиск выключен' };
  }
  if (!needsCountry(rec, dict)) {
    return { rec, ok: false, reason: 'страна уже есть или искать не по чему' };
  }
  const query = io.query || countryQuery(rec);
  if (!query) return { rec, ok: false, reason: 'пустой поисковый запрос' };
  const search = io.search || (q => searchWeb(q, config));
  const fetchHtml = io.fetchHtml || (url => fetchPage(url, { timeoutMs: settings.timeoutMs }));
  const maxPages = io.maxPages ?? settings.tries;
  const onNote = io.onNote || (() => {});

  let urls = [];
  try {
    onNote(`ищем страну: ${query}`);
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
    const got = parseCountryFromPage(html, rec.identity, dict, config);
    if (!got.ok) {
      tried.push(`${host}: ${got.reason}`);
      continue;
    }
    const page_data = html ? visibleText(html) : '';
    applyExternal(rec, got.pairs, dict, config, { url, query, page_data });
    onNote(`страна с ${host}: ${rec.attrs.country}`);
    return { rec, ok: true, url, query, pairs: got.pairs };
  }
  return {
    rec,
    ok: false,
    query,
    reason: tried.length ? tried.join('; ') : 'выдача пуста',
  };
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
  // Tier B — высокий приоритет дообогащения; A — низкий; X не дообогащается.
  const need = recs.filter(r => needsExternal(r, { minAttrs }));
  const score = (rec) => {
    let b = 0, a = 0;
    for (const attr of dict.attrs) {
      if (attr.tier === 'X' || attr.inferable === false) continue;
      if (rec.attrs[attr.code] != null) continue;
      if (attr.tier === 'B') b++;
      else if (attr.tier === 'A') a++;
    }
    return b * 1000 + a;
  };
  need.sort((x, y) => score(y) - score(x));
  const results = [];
  for (const rec of need) {
    results.push(await lookupExternal(rec, dict, config, io));
  }
  const forCountry = recs.filter(r => needsCountry(r, dict));
  for (const rec of forCountry) {
    results.push(await lookupCountry(rec, dict, config, io));
  }
  return results;
}
