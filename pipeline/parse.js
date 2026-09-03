/** Разбор annotation/description в пары ключ–значение. Без канонизации. */

import { annotationFormat, splitHtmlChunks, stripHtml, hasBr, hasLi } from './text.js';
import { matchLine, matchKey } from './match.js';

const SEP = /\s+[-–—]\s+|\s*:\s+/;

function splitBySep(text) {
  const m = String(text).match(SEP);
  if (!m) return null;
  const i = text.search(SEP);
  const key = text.slice(0, i).trim();
  const value = text.slice(i).replace(SEP, '').trim();
  if (!key || !value) return null;
  return { key, value };
}

function pairFromChunk(chunk, dict) {
  const text = chunk.replace(/\s+/g, ' ').trim().replace(/[.;]\s*$/, '');
  if (!text) return null;

  const sep = splitBySep(text);
  if (sep) {
    const parts = sep.key.split(/\s+/);
    const last = parts[parts.length - 1];
    if (parts.length > 1 && /^[A-Z0-9]{1,4}$/i.test(last) && /[а-яё]/i.test(parts[0])) {
      sep.key = parts.slice(0, -1).join(' ');
    }
    if (dict) {
      const m = matchKey(sep.key, dict, { value: sep.value });
      if (m.how === 'shorten' && m.raw) return { key: m.raw, value: sep.value, via: 'sep-shorten' };
    }
    return { ...sep, via: 'sep' };
  }

  // Тройка габаритов: «Размеры (Ш х В х Г см) 59.6 х 85 х 46.5».
  // tailnum взял бы только 46.5, оставив две оси в ключе.
  if (dict && /\d+(?:[.,]\d+)?\s*[x×хX]\s*\d+(?:[.,]\d+)?\s*[x×хX]\s*\d/.test(text)) {
    const prefixed = matchLine(text, dict);
    if (prefixed?.attr && prefixed.value) {
      return { key: prefixed.raw || prefixed.attr.name, value: prefixed.value, via: 'dict' };
    }
  }

  const tail = text.match(/^(.*?)(\d+(?:[.,]\d+)?(?:\s*[а-яёa-z/%²³·\*]+)?)\s*$/i);
  if (tail && tail[1].trim().length >= 3 && /[а-яёa-z]/i.test(tail[1])) {
    return { key: tail[1].trim(), value: tail[2].trim(), via: 'tailnum' };
  }

  const prefixed = dict ? matchLine(text, dict) : null;
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

function collectPairs(chunks, dict) {
  const pairs = [];
  for (const ch of chunks) {
    const p = pairFromChunk(ch, dict);
    if (p) pairs.push(p);
  }
  return pairs;
}

export function extractPairs(html, dict) {
  const chunks = splitHtmlChunks(html);
  let pairs = collectPairs(chunks, dict);
  // Один длинный абзац даёт 0–1 пару на весь текст — режем по предложениям.
  if (chunks.length <= 1 && pairs.length <= 1) {
    const expanded = expandPlain(stripHtml(html));
    if (expanded) pairs = collectPairs(expanded, dict);
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
    // EMPTY без br/тире: характеристики всё равно могут лежать в абзаце.
    if (!dump && fromDesc.length < 3) fromDesc = [];
    if (fromDesc.length >= 3) dump = true;
  }
  return { format, pairs: fromAnn.length ? fromAnn : fromDesc, dump, fromAnn, fromDesc };
}
