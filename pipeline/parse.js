/** Разбор annotation/description в пары ключ–значение. Без канонизации. */

import { annotationFormat, splitHtmlChunks, stripHtml, hasBr, hasLi, isHeadingLine, normKey } from './text.js';
import { matchLine, exactMatch, longestPrefixMatch } from './match.js';
import { requiredFilterAttrs } from './required_filters.js';

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

const UNIT_CELL = /^(?:кг|г|см|мм|м|л|мл|дба|дб|шт|%|об\/?\s*мин|квт·ч\/год)$/i;

/** Ячейки строки таблицы → [ключ, значение]. Иконка / единица — третья колонка. */
export function pairFromTableCells(cells) {
  const c = (cells || []).map(s => String(s || '').replace(/\s+/g, ' ').trim()).filter(s => s && s !== '–' && s !== '-');
  if (c.length < 2) return null;
  if (c.length === 2) return [c[0], c[1]];
  if (UNIT_CELL.test(c[c.length - 1])) return [c[0], `${c[1]} ${c[c.length - 1]}`.trim()];
  if (c[0].length <= 2 && !/[а-яёa-z]/i.test(c[0])) return [c[1], c[2]];
  return [c[0], c[1]];
}

function ldScalar(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  if (Array.isArray(v)) return ldScalar(v[0]);
  if (typeof v === 'object') {
    if (v.value != null) {
      const u = v.unitText || v.unitCode || '';
      return String(u ? `${v.value} ${u}` : v.value).trim();
    }
    if (typeof v.name === 'string' && v.value == null) return '';
  }
  return '';
}

function walkJsonLd(node, add, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (const x of node) walkJsonLd(x, add, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const props = node.additionalProperty || node.additionalProperties;
  if (props) {
    for (const p of Array.isArray(props) ? props : [props]) {
      const name = p?.name || p?.propertyID;
      const val = ldScalar(p?.value);
      if (name && val) add(name, val, 'jsonld');
    }
  }
  for (const [key, label] of [
    ['color', 'Цвет'], ['width', 'Ширина'], ['height', 'Высота'],
    ['depth', 'Глубина'], ['weight', 'Вес'], ['material', 'Материал'],
  ]) {
    const val = ldScalar(node[key]);
    if (val) add(label, val, 'jsonld');
  }
  if (node.brand) {
    const b = typeof node.brand === 'string' ? node.brand : ldScalar(node.brand.name);
    if (b) add('Бренд', b, 'jsonld');
  }
  if (node['@graph']) walkJsonLd(node['@graph'], add, depth + 1);
}

function pairsFromJsonLd(html, add) {
  for (const m of String(html || '').matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    walkJsonLd(data, add);
  }
}

function mappedPairCount(pairs, dict) {
  if (!dict || !pairs?.length) return 0;
  let n = 0;
  for (const p of pairs) {
    if (exactMatch(p.key, dict, p.value)) n++;
  }
  return n;
}

function mappedAttrCodes(pairs, dict) {
  const codes = new Set();
  if (!dict || !pairs?.length) return codes;
  for (const p of pairs) {
    const hit = exactMatch(p.key, dict, p.value);
    if (hit?.attr?.code) codes.add(hit.attr.code);
  }
  return codes;
}

/**
 * Шаг 2 (парсинг description) — только если шаг 1 не закрыл обязательный
 * фильтр. Маркетинг без таблицы характеристик не разбираем: иначе три
 * случайные пары из прозы попадают в ingest.
 */
export function needDescriptionParse(fromAnn, dict, { format, dumpDesc } = {}) {
  if (format === 'EMPTY') return true;
  const mappedAnn = mappedPairCount(fromAnn, dict);
  const required = requiredFilterAttrs(dict);
  const missingRequired = required.length
    ? required.some(a => !mappedAttrCodes(fromAnn, dict).has(a.code))
    : (fromAnn?.length || 0) < 3 || mappedAnn < 3;
  if (!missingRequired) return false;
  return Boolean(dumpDesc) || (fromAnn?.length || 0) < 3 || mappedAnn < 3;
}

/** Две колонки Bootstrap/Bitrix: col-sm-5 + col-sm-7 на карточке магазина. */
function columnPairRe() {
  const col = String.raw`<div[^>]*class="[^"]*\bcol(?:-(?:sm|md|lg|xl))?-\d+\b[^"]*"[^>]*>([\s\S]*?)</div>`;
  return new RegExp(`${col}\\s*${col}`, 'gi');
}

function namedBlockRe() {
  const name = String.raw`-name|_name|__name|-title|_title|__title|-label|_label|__label|-key|_key|__key`;
  const value = String.raw`-value|_value|__value|-val|_val|__val|-text|_text|__text`;
  return new RegExp(
    String.raw`<(div|span|dt|th)[^>]*class="[^"]*(?:${name})[^"]*"[^>]*>([\s\S]*?)</\1>\s*`
    + String.raw`<(div|span|dd|td)[^>]*class="[^"]*(?:${value})[^"]*"[^>]*>([\s\S]*?)</\3>`,
    'gi',
  );
}

function pairsFromColumnRows(body, add) {
  for (const m of body.matchAll(columnPairRe())) {
    add(stripHtml(m[1]), stripHtml(m[2]), 'div');
  }
}

/** <li><span>Ключ</span><span>значение</span></li> без table/dl. */
function pairsFromListItems(body, add) {
  for (const li of body.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const inner = li[1];
    if (/<a\b|<ul\b|<ol\b/i.test(inner)) continue;
    const parts = [...inner.matchAll(/<(div|span|p|strong|b|dt|dd|em)[^>]*>([\s\S]*?)<\/\1>/gi)]
      .map(m => stripHtml(m[2]))
      .filter(Boolean);
    if (parts.length === 2) add(parts[0], parts[1], 'dl');
  }
}

function pairsFromItemprop(body, add) {
  const re = /itemprop=["']name["'][^>]*>([\s\S]*?)<\/(?:span|div|dt|td|th)>\s*<[^>]+itemprop=["']value["']([^>]*)>([\s\S]*?)<\//gi;
  for (const m of body.matchAll(re)) {
    const fromAttr = String(m[2] || '').match(/content=["']([^"']*)["']/i)?.[1];
    add(stripHtml(m[1]), stripHtml(fromAttr || m[3] || ''), 'jsonld');
  }
}

/**
 * Таблица характеристик с произвольной HTML-страницы: JSON-LD, tr/td,
 * dt/dd, колонки Bootstrap, блоки name/value магазинов, затем текст.
 * Дамп заказчика — «ключ - значение<br>»; страница из поиска — вёрстка магазина.
 */
export function extractPairsFromPage(html, dict) {
  const raw = String(html || '');
  const body = raw.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ');
  const pairs = [];
  const seen = new Set();
  const add = (key, value, via) => {
    const k = String(key || '').replace(/\s+/g, ' ').trim();
    const v = String(value || '').replace(/\s+/g, ' ').trim();
    if (!k || !v || k === v) return;
    if (k.length > 80 || v.length > 240 || /^https?:/i.test(v)) return;
    if (isHeadingLine(k)) return;
    const id = k.toLowerCase();
    if (seen.has(id)) return;
    seen.add(id);
    pairs.push({ key: k, value: v, via });
  };
  pairsFromJsonLd(raw, add);
  for (const row of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => stripHtml(m[1]));
    const pair = pairFromTableCells(cells);
    if (pair) add(pair[0], pair[1], 'table');
  }
  for (const pair of body.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)) {
    add(stripHtml(pair[1]), stripHtml(pair[2]), 'dl');
  }
  const divPair = namedBlockRe();
  for (const m of body.matchAll(divPair)) {
    add(stripHtml(m[2]), stripHtml(m[4]), 'div');
  }
  pairsFromColumnRows(body, add);
  pairsFromListItems(body, add);
  pairsFromItemprop(body, add);
  // Текст вне уже разобранной вёрстки: иначе колонки склеиваются в ложные пары.
  const rest = body
    .replace(/<table\b[\s\S]*?<\/table>/gi, ' ')
    .replace(/<dl\b[\s\S]*?<\/dl>/gi, ' ')
    .replace(columnPairRe(), ' ')
    .replace(namedBlockRe(), ' ');
  if (stripHtml(rest).length > 20) {
    for (const p of extractPairs(rest, dict)) add(p.key, p.value, p.via || 'text');
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
  // Два шага по приоритету. Шаг 1 — annotation (S1). Шаг 2 (парсинг
  // description, S2) включается только если шаг 1 не закрыл обязательный
  // фильтр: setAttr всё равно не перетирает, но чужие пары из прозы
  // не должны попадать в ingest, когда ось уже заполнена.
  const fromAnn = extractPairs(product.annotation, dict).map(p => ({ ...p, source: 'S1' }));
  let fromDesc = [];
  let dump = false;
  const dumpDesc = detectDump(product.description);
  if (needDescriptionParse(fromAnn, dict, { format, dumpDesc })) {
    dump = dumpDesc;
    fromDesc = extractPairs(product.description, dict).map(p => ({ ...p, source: 'S2' }));
    if (!dump && fromDesc.length < 3) fromDesc = [];
    if (fromDesc.length >= 3) dump = true;
  }
  const pairs = fromAnn.length ? fromAnn.concat(fromDesc) : fromDesc;
  return { format, pairs, dump, fromAnn, fromDesc };
}

/** Откуда взялась пара — для лога и экрана хода обогащения. */
export const SOURCE_LABEL = {
  S1: 'аннотация',
  S2: 'описание',
  page: 'страница',
  attributes: 'атрибуты магазина',
};

export const VIA_LABEL = {
  sep: 'разделитель',
  dict: 'справочник',
  case: 'регистр',
  jsonld: 'JSON-LD',
  table: 'таблица',
  dl: 'список',
  div: 'блок',
  text: 'текст',
  attr: 'атрибут',
};

export function viaLabel(via) {
  return VIA_LABEL[via] || via || '';
}

export function sourceLabel(source) {
  return SOURCE_LABEL[source] || source || '';
}

function clipVal(s, cap = 80) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= cap) return t;
  return `${t.slice(0, cap - 1)}…`;
}

function ruHits(n) {
  const m = Math.abs(n) % 100;
  const d = m % 10;
  if (m >= 11 && m <= 14) return 'характеристик';
  if (d === 1) return 'характеристика';
  if (d >= 2 && d <= 4) return 'характеристики';
  return 'характеристик';
}

function hitFromPair(p, fallbackSource = 'S1') {
  const key = String(p?.key || p?.name || '').replace(/\s+/g, ' ').trim();
  const value = String(p?.value ?? '').replace(/\s+/g, ' ').trim();
  if (!key || !value) return null;
  const source = p.source || fallbackSource;
  const via = p.via || 'sep';
  const where = source === 'page' ? (viaLabel(via) || 'страница') : (sourceLabel(source) || 'карточка');
  return { key, value, where, how: viaLabel(via), source, via };
}

/** Пары annotation/description с подписью источника — то, что уходит в лог. */
export function collectParseHits(product, dict) {
  const parsed = parseProductFields(product || {}, dict);
  const hits = [];
  for (const p of parsed.pairs) {
    const hit = hitFromPair(p, p.source || 'S1');
    if (hit) hits.push(hit);
  }
  return {
    format: parsed.format,
    dump: parsed.dump,
    hits,
    counts: {
      annotation: parsed.fromAnn.length,
      description: parsed.fromDesc.length,
    },
  };
}

/** Пары со страницы (таблица, JSON-LD, dl) — «откуда» = способ разбора. */
export function collectPageHits(attributes) {
  const hits = [];
  for (const a of attributes || []) {
    const hit = hitFromPair({
      key: a.name || a.key,
      value: a.value,
      source: 'page',
      via: a.via || 'text',
    }, 'page');
    if (hit) hits.push(hit);
  }
  const counts = {};
  for (const h of hits) counts[h.via] = (counts[h.via] || 0) + 1;
  return { hits, counts };
}

/**
 * Строки для журнала прогона: сводка, затем группы «откуда: ключ = значение».
 * Не по одной паре на строку — иначе длинный прогон вытесняет LOG_CAP.
 */
export function formatParseNotes(trace, { origin = 'карточка', maxPerGroup = 20 } = {}) {
  const hits = Array.isArray(trace?.hits) ? trace.hits : [];
  if (!hits.length) return [`Парсинг (${origin}): ничего не разобрали`];
  const groups = new Map();
  for (const h of hits) {
    const g = h.where || 'источник';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(h);
  }
  const summary = [...groups.entries()].map(([g, list]) => `${g} ${list.length}`).join(', ');
  const notes = [`Парсинг (${origin}): ${hits.length} ${ruHits(hits.length)} · ${summary}`];
  for (const [g, list] of groups) {
    const show = list.slice(0, maxPerGroup);
    const more = list.length - show.length;
    const body = show.map(h => {
      const val = clipVal(h.value);
      const skipHow = !h.how || h.how === g || h.how === 'разделитель' || h.how === 'атрибут';
      return skipHow ? `${h.key} = ${val}` : `${h.key} = ${val} [${h.how}]`;
    }).join('; ');
    notes.push(`  ← ${g}: ${body}${more > 0 ? `; … ещё ${more}` : ''}`);
  }
  return notes;
}

/** Полный список пар для раздела «Логи». */
export function parseHitsText(trace) {
  const hits = Array.isArray(trace?.hits) ? trace.hits : [];
  if (!hits.length) return '— ничего не разобрали —';
  return hits.map(h => {
    const how = h.how && h.how !== h.where ? ` [${h.how}]` : '';
    return `${h.where || '?'}${how}: ${h.key} = ${h.value}`;
  }).join('\n');
}

export function slimParseTrace(trace, cap = 80) {
  if (!trace || !Array.isArray(trace.hits)) return null;
  return {
    format: trace.format ?? null,
    dump: Boolean(trace.dump),
    counts: trace.counts || null,
    hits: trace.hits.slice(0, cap).map(h => ({
      key: String(h.key || '').slice(0, 80),
      value: String(h.value || '').slice(0, 160),
      where: h.where || null,
      how: h.how || null,
      source: h.source || null,
      via: h.via || null,
    })),
  };
}
