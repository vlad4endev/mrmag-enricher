/** Разбор annotation/description в пары ключ–значение. Без канонизации. */

import { annotationFormat, splitHtmlChunks, stripHtml, hasBr, hasLi, isHeadingLine, normKey } from './text.js';
import { matchLine, exactMatch, longestPrefixMatch } from './match.js';

/** Явные разделители M1: первое вхождение. */
const SEP = /\s+[-–—]\s+|\s*:\s+/;

function hasExplicitSep(text) {
  return SEP.test(String(text));
}

function splitBySep(text) {
  const m = String(text).match(SEP);
  if (!m) return null;
  const i = text.search(SEP);
  const key = text.slice(0, i).trim();
  const value = text.slice(i).replace(SEP, '').trim();
  if (!key || !value) return null;
  return { key, value };
}

/**
 * M3: граница «строчная буква или ) → заглавная или цифра».
 */
function splitByCaseBoundary(text) {
  const s = String(text || '').trim();
  const m = s.match(/^(.+?[a-zа-яё)])\s*(?=[A-ZА-ЯЁ0-9])/u);
  if (!m) return null;
  const key = m[1].trim();
  const value = s.slice(m[0].length).trim();
  if (key.length < 3 || !value) return null;
  if (!/[а-яёa-z]/i.test(key)) return null;
  return { key, value, via: 'case' };
}

/**
 * Каскад до первого успеха. Порядок принципиален.
 * Без явного разделителя: M2 → M3 → M4.
 * С разделителем: M1; если ключ не в справочнике — M2 на всю строку (контроль «Интерфейс 2D - …»).
 */
function pairFromChunk(chunk, dict) {
  const text = chunk.replace(/\s+/g, ' ').trim().replace(/[.;]\s*$/, '');
  if (!text) return null;
  if (isHeadingLine(text)) return null;

  const withSep = hasExplicitSep(text);

  // Без явного разделителя — M2 раньше всего.
  if (!withSep && dict) {
    const m2 = tryM2(text, dict);
    if (m2) return m2;
    const m3 = splitByCaseBoundary(text);
    if (m3) return m3;
    return null;
  }

  // M1: явный разделитель.
  const sep = splitBySep(text);
  if (sep) {
    if (dict) {
      const exact = exactMatch(sep.key, dict, sep.value);
      if (exact) return { ...sep, via: 'sep' };
      // Ключ M1 не в справочнике (Интерфейс 2D) → M2 на всю строку.
      const m2 = tryM2(text, dict);
      if (m2) return m2;
    }
    return { ...sep, via: 'sep' };
  }

  if (dict) {
    const m2 = tryM2(text, dict);
    if (m2) return m2;
  }

  const m3 = splitByCaseBoundary(text);
  if (m3) return m3;

  return null;
}

function tryM2(text, dict) {
  const prefixed = matchLine(text, dict);
  if (prefixed?.attr && prefixed.value) {
    return { key: prefixed.raw || prefixed.attr.name, value: prefixed.value, via: 'dict' };
  }
  return null;
}

/**
 * Сплошной абзац «Ключ значение. Ключ значение.» без br/li.
 * Точка внутри числа (59.6) не режет: после неё нет пробела и заглавной.
 */
function expandPlain(plain) {
  const byDot = String(plain || '').split(/\.\s+(?=[А-ЯЁA-Z])/).map(s => s.trim()).filter(Boolean);
  if (byDot.length >= 3) return byDot;
  const bySemi = String(plain || '').split(/\s*;\s*/).map(s => s.trim()).filter(Boolean);
  if (bySemi.length >= 3) return bySemi;
  const bySpace = String(plain || '').split(/(?<=\S)\s{2,}/).map(s => s.trim()).filter(Boolean);
  if (bySpace.length >= 3) return bySpace;
  return null;
}

function splitOffNextPair(value, dict) {
  if (!dict || !value) return null;
  const parts = String(value).trim().split(/\s+/);
  for (let i = 1; i < parts.length; i++) {
    const rest = parts.slice(i).join(' ');
    if (!hasExplicitSep(rest)) continue;
    const sep = splitBySep(rest);
    if (!sep || !exactMatch(sep.key, dict, sep.value)) continue;
    return { head: parts.slice(0, i).join(' '), rest };
  }
  return null;
}

function collectPairs(chunks, dict) {
  const pairs = [];
  for (const ch of chunks) {
    let rest = ch;
    let guard = 0;
    while (rest && guard++ < 20) {
      const p = pairFromChunk(rest, dict);
      if (!p) break;
      const split = splitOffNextPair(p.value, dict);
      if (split) {
        pairs.push({ ...p, value: split.head });
        rest = split.rest;
      } else {
        pairs.push(p);
        break;
      }
    }
  }
  return pairs;
}

export function extractPairs(html, dict) {
  const chunks = splitHtmlChunks(html);
  let pairs = collectPairs(chunks, dict);
  if (chunks.length <= 1 && pairs.length <= 1) {
    const expanded = expandPlain(stripHtml(html));
    if (expanded) pairs = collectPairs(expanded, dict);
  }
  // <ul> забирает только li: соседний <p> с объёмами иначе выпадает.
  if (hasLi(html)) {
    const rest = String(html).replace(/<(ul|ol)\b[\s\S]*?<\/\1>/gi, ' ');
    if (stripHtml(rest).length > 20) {
      pairs = pairs.concat(extractPairs(rest, dict));
    }
  }
  return pairs;
}

/**
 * Таблица характеристик с произвольной HTML-страницы: tr/td, dt/dd, затем
 * обычный разбор, если таблиц нет. Для товаров без своих annotation/description.
 */
export function extractPairsFromPage(html, dict) {
  const body = String(html || '').replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ');
  const pairs = [];
  const seen = new Set();
  const add = (key, value, via) => {
    const k = String(key || '').replace(/\s+/g, ' ').trim();
    const v = String(value || '').replace(/\s+/g, ' ').trim();
    if (!k || !v || k === v) return;
    if (k.length > 80 || v.length > 200 || /^https?:/i.test(v)) return;
    if (isHeadingLine(k)) return;
    const id = k.toLowerCase();
    if (seen.has(id)) return;
    seen.add(id);
    pairs.push({ key: k, value: v, via });
  };
  for (const row of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => stripHtml(m[1]));
    if (cells.length === 2) add(cells[0], cells[1], 'table');
  }
  for (const pair of body.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)) {
    add(stripHtml(pair[1]), stripHtml(pair[2]), 'dl');
  }
  if (pairs.length < 3) {
    for (const p of extractPairs(body, dict)) add(p.key, p.value, p.via || 'text');
  }
  return pairs;
}

/** Видимый текст страницы плюс JSON-LD: модель часто только в разметке. */
export function visibleText(html) {
  const s = String(html || '');
  const ld = [...s.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1]).join(' ');
  const body = s.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ');
  return stripHtml(`${body} ${ld}`);
}

export function detectDump(html) {
  if (!html || !stripHtml(html)) return false;
  const chunks = splitHtmlChunks(html);
  if (chunks.length >= 8) return true;
  const dashes = (stripHtml(html).match(/\s[-–—]\s/g) || []).length;
  return dashes >= 8 || (hasBr(html) && chunks.length >= 5) || hasLi(html);
}

export function parseProductFields(product, dict) {
  const format = annotationFormat(product.annotation);
  const fromAnn = extractPairs(product.annotation, dict).map(p => ({ ...p, source: 'S1' }));
  let fromDesc = [];
  let dump = false;
  if (format === 'EMPTY' || fromAnn.length < 3) {
    dump = detectDump(product.description);
    fromDesc = extractPairs(product.description, dict).map(p => ({ ...p, source: 'S2' }));
    if (!dump && fromDesc.length < 3) fromDesc = [];
    if (fromDesc.length >= 3) dump = true;
  }
  return { format, pairs: fromAnn.length ? fromAnn : fromDesc, dump, fromAnn, fromDesc };
}
