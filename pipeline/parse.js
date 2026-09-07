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

/** Значение на отдельной <br>-строке: «6 кг», «A+++», «да». */
function isBareValue(text) {
  const s = String(text || '').trim();
  if (!s || hasExplicitSep(s) || isHeadingLine(s)) return false;
  if (/^(да|нет|есть|имеется)$/iu.test(s)) return true;
  if (/^[A-GА-Е]\+{0,3}$/iu.test(s)) return true;
  return /^-?\d/.test(s);
}

/** Ключ без значения: «Макс. загрузка» на своей строке, значение — на следующей. */
function isKeyOnlyLine(text) {
  const s = String(text || '').trim();
  if (!s || hasExplicitSep(s) || isHeadingLine(s) || isBareValue(s)) return false;
  if (!/[а-яёa-z]/i.test(s) || /^\d/.test(s) || s.length > 80) return false;
  return true;
}

/**
 * 1С часто кладёт ключ и значение на соседние <br>-строки:
 * «Макс. загрузка<br />6 кг<br />Макс. скорость отжима<br />1000 об/мин».
 * Без склейки pairFromChunk видит две обрубка и обе отбрасывает.
 */
export function stitchKeyValueLines(chunks) {
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    const cur = chunks[i];
    const next = chunks[i + 1];
    if (next && isKeyOnlyLine(cur) && isBareValue(next)) {
      out.push(`${cur}: ${next}`);
      i++;
      continue;
    }
    out.push(cur);
  }
  return out;
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

  // M1: явный разделитель. Ключ не начинается с цифры («2 – переставляемые»).
  const sep = splitBySep(text);
  if (sep && !/^\d/.test(sep.key.trim())) {
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

/**
 * Отрезать от value следующий «Ключ: значение», если он прилип к хвосту.
 * Справочник помогает, но не обязателен: в dump-прозе следующих ключей часто
 * нет в dict. Если dict-ключ встретился далеко в хвосте (другое размораживание),
 * а раньше есть «.… Ключ:», берём самый ранний разрез — иначе первая фраза
 * превращается в помойку из пяти характеристик.
 */
export function splitOffNextPair(value, dict) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;

  let best = null;
  const consider = (head, rest) => {
    const h = String(head || '').trim();
    const r = String(rest || '').trim();
    if (h.length < 2 || h.length > 160 || !r) return;
    if (!best || h.length < best.head.length) best = { head: h, rest: r };
  };

  // «автоматическое (капельная система). Количество полок: 3 …»
  const sentRe = /\.\s+([А-ЯЁA-Za-zа-яё][^:\n]{1,80}:\s*\S)/u;
  const sent = sentRe.exec(s);
  if (sent && sent.index >= 0) {
    consider(s.slice(0, sent.index), s.slice(sent.index + 1).replace(/^\.\s*/, ''));
  }

  // «да Перевешиваемые двери - да Габариты…» — без точки между парами после stripHtml(<li>).
  const boolInline = s.match(/^(да|нет|есть|имеется)\s+([А-ЯЁA-Za-zа-яё][^–—:\n]{2,70}\s+[-–—:]\s*\S[\s\S]*)$/iu);
  if (boolInline) consider(boolInline[1], boolInline[2]);

  // Короткий ответ + следующий «Ключ - значение» с типовым хвостом каталога.
  const inline = s.match(/^(.{1,40}?)\s+([А-ЯЁA-Z][^–—:\n]{2,70}\s+[-–—]\s+\S[\s\S]*)$/u);
  if (inline && /габарит|размер|двер|вес|масс|объ[её]м|нетто|брутто|перевеш|перенавеш|шум|класс/i.test(inline[2])) {
    consider(inline[1], inline[2]);
  }

  if (dict) {
    const parts = s.split(/\s+/);
    for (let i = 1; i < parts.length; i++) {
      const rest = parts.slice(i).join(' ');
      if (!hasExplicitSep(rest)) continue;
      const sep = splitBySep(rest);
      if (!sep || !exactMatch(sep.key, dict, sep.value)) continue;
      consider(parts.slice(0, i).join(' '), rest);
      break; // ближайший dict-ключ по порядку слов
    }
  }

  return best;
}

function collectPairs(chunks, dict) {
  const pairs = [];
  for (const ch of chunks) {
    let rest = ch;
    let guard = 0;
    while (rest && guard++ < 40) {
      // «Подставка для яиц. Морозильное отделение: …» — отбросить фразу без «:»/«-».
      rest = skipOrphanLead(rest);
      const p = pairFromChunk(rest, dict);
      if (!p) break;
      const split = splitOffNextPair(p.value, dict);
      if (split) {
        pairs.push(pairFromSplitHead(p, split.head, dict));
        rest = split.rest;
      } else {
        pairs.push(promoteNestedValue(p, dict));
        break;
      }
    }
  }
  return pairs;
}

/** Фраза без разделителя перед следующим «Ключ:» — не пара, а мусор dump-прозы. */
function skipOrphanLead(text) {
  let s = String(text || '').trim();
  for (let i = 0; i < 5; i++) {
    const m = s.match(/^([^:–—]{2,80}?)\.\s+([А-ЯЁA-Za-zа-яё][^:\n]{1,80}:\s*\S[\s\S]*)$/u);
    if (!m) break;
    if (hasExplicitSep(m[1])) break;
    // «Макс. загрузка: 6 кг» — точка аббревиатуры, не конец фразы.
    if (!/\s/.test(m[1].trim())) break;
    s = m[2].trim();
  }
  return s;
}

/**
 * Head после разреза сам может быть «Ключ: значение»
 * («Холодильное отделение» → «Размораживание…: автоматическое»).
 */
function pairFromSplitHead(outer, head, dict) {
  const nested = pairFromChunk(head, dict);
  if (nested && hasExplicitSep(head) && nested.key !== outer.key) {
    if (!dict || exactMatch(nested.key, dict, nested.value)) return nested;
    if (nested.via === 'sep' || nested.via === 'dict') return nested;
  }
  return { ...outer, value: head };
}

function promoteNestedValue(p, dict) {
  if (!p?.value || !hasExplicitSep(p.value)) return p;
  const nested = pairFromChunk(p.value, dict);
  if (!nested || nested.key === p.key) return p;
  if (dict && exactMatch(nested.key, dict, nested.value)) return nested;
  if (nested.via === 'sep' && nested.value.length < String(p.value).length) {
    // Внешний ключ — заголовок секции без атрибута в справочнике.
    if (dict && !exactMatch(p.key, dict, p.value)) return nested;
  }
  return p;
}

export function extractPairs(html, dict) {
  const chunks = stitchKeyValueLines(splitHtmlChunks(html));
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
  // Характеристики (annotation) — единственный основной источник фактов и фильтров.
  // Описание добирает только пустые оси: S1 всегда раньше S2, setAttr не перетирает.
  const fromAnn = extractPairs(product.annotation, dict).map(p => ({ ...p, source: 'S1' }));
  let fromDesc = [];
  let dump = false;
  const needDesc = format === 'EMPTY' || fromAnn.length < 3;
  if (needDesc) {
    dump = detectDump(product.description);
    fromDesc = extractPairs(product.description, dict).map(p => ({ ...p, source: 'S2' }));
    if (!dump && fromDesc.length < 3) fromDesc = [];
    if (fromDesc.length >= 3) dump = true;
  }
  // Было: либо annotation, либо description. Из-за этого при 1–2 строках
  // в annotation фильтры строились из прозы описания, а не из характеристик.
  const pairs = fromAnn.length ? fromAnn.concat(fromDesc) : fromDesc;
  return { format, pairs, dump, fromAnn, fromDesc };
}
