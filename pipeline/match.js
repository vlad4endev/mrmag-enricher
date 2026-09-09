/** Сопоставление ключа со справочником: blacklist → синоним → bag-of-words → нечёткое. */

import { normKey, tokens } from './text.js';

function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = s => {
    const g = new Set();
    const t = ` ${s} `;
    for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
    return g;
  };
  const A = grams(a), B = grams(b);
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return (2 * n) / (A.size + B.size);
}

function wordSetKey(nk) {
  return tokens(nk).slice().sort().join(' ');
}

function blacklistHit(nk, dict) {
  for (const b of dict.blacklistIndex) {
    if (nk === b.norm) return b;
    if (nk.startsWith(b.norm + ' ') || nk.endsWith(' ' + b.norm)) return b;
  }
  return null;
}

/** Кандидат отклоняется, если его нормальная форма в blacklist любого атрибута. */
function fuzzyBlacklisted(nk, dict) {
  return Boolean(blacklistHit(nk, dict));
}

function looksLikeClass(value) {
  const s = String(value || '').trim();
  if (/^[a-gа-е]\+{0,3}$/iu.test(s)) return true;
  return /класс\s*[a-gа-е]\+{0,3}/iu.test(s);
}

function looksLikeBool(value) {
  const s = String(value || '').trim().toLowerCase().replace(/ё/g, 'е');
  return /^(да|нет|есть|имеется|true|false|yes|no)$/i.test(s);
}

function pickSyn(list, value) {
  if (list.length === 1) return list[0];
  const looksClass = looksLikeClass(value);
  const looksNum = /^-?\d/.test(String(value || '').trim());
  const looksBool = looksLikeBool(value);
  const scored = list.map(x => {
    let s = x.len;
    if (looksClass && x.attr.type === 'class_scale') s += 100;
    if (looksNum && (x.attr.type === 'number' || x.attr.type === 'integer')) s += 100;
    if (!looksNum && x.attr.type === 'enum') s += 10;
    if (x.attr.type === 'boolean' && !looksBool) s -= 50;
    if (x.attr.type === 'boolean' && looksBool) s += 40;
    return { ...x, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored[0];
}

/** Точное совпадение нормальной формы → confidence 1.0. */
export function exactMatch(key, dict, value) {
  const nk = normKey(key);
  if (!nk) return null;
  const hit = dict.synonymIndex.get(nk);
  if (hit?.length) return { ...pickSyn(hit, value), confidence: 1, how: 'synonym' };
  return null;
}

/** Совпадение по множеству слов без порядка → 0.95. */
export function bagOfWordsMatch(key, dict, value) {
  const nk = normKey(key);
  if (!nk) return null;
  const want = wordSetKey(nk);
  if (!want) return null;
  let best = null;
  for (const [syn, list] of dict.synonymIndex) {
    if (wordSetKey(syn) !== want) continue;
    if (syn === nk) continue; // точное уже проверено
    const cand = pickSyn(list, value);
    const score = syn.length;
    if (!best || score > best._score) best = { ...cand, confidence: 0.95, how: 'bag', _score: score };
  }
  return best;
}

/**
 * Самый длинный синоним, с которого начинается строка.
 * Нужен BR-формату без явного разделителя и M2: «Загрузка белья (кг) 4».
 */
export function longestPrefixMatch(line, dict) {
  const nk = normKey(line);
  if (!nk) return null;
  let best = null;
  for (const [syn, list] of dict.synonymIndex) {
    if (nk === syn || nk.startsWith(syn + ' ')) {
      const rest = nk.slice(syn.length).trim();
      if (rest) {
        const first = rest.split(' ')[0];
        if (dict.blacklistIndex.some(b =>
          b.norm === `${syn} ${first}` || b.norm.startsWith(`${syn} ${first}`))) {
          continue;
        }
      }
      // Предпочитаем raw, который реально является префиксом исходной строки.
      const preferred = pickRawForLine(line, list, syn);
      const cand = preferred || pickSyn(list, rest);
      const score = syn.length;
      if (!best || score > best.score) best = { ...cand, syn, score, confidence: 1, how: 'prefix' };
    }
  }
  return best;
}

function pickRawForLine(line, list, synNorm) {
  const src = String(line).trim();
  const folded = src.toLowerCase().replace(/ё/g, 'е');
  let best = null;
  for (const item of list) {
    const raw = String(item.raw || '');
    if (!raw) continue;
    const rf = raw.toLowerCase().replace(/ё/g, 'е');
    if (folded === rf || folded.startsWith(rf + ' ') || folded.startsWith(rf + ':') || folded.startsWith(rf + '-')) {
      if (!best || raw.length > best.raw.length) best = item;
    }
  }
  if (best) return best;
  // «Загрузка белья (кг)» vs синоним с той же нормой: берём raw, чья норма = synNorm,
  // и который содержится в строке с учётом скобок.
  for (const item of list) {
    if (normKey(item.raw) !== synNorm) continue;
    const words = src.split(/\s+/);
    for (let n = 1; n <= words.length; n++) {
      const prefix = words.slice(0, n).join(' ');
      if (normKey(prefix) === synNorm) {
        return { ...item, raw: prefix };
      }
    }
  }
  return null;
}

export function fuzzyMatch(key, dict, minScore) {
  const nk = normKey(key);
  if (!nk || nk.length < 4) return null;
  if (fuzzyBlacklisted(nk, dict)) return null;
  let best = null;
  for (const [syn, list] of dict.synonymIndex) {
    if (Math.abs(syn.length - nk.length) > 12) continue;
    if (fuzzyBlacklisted(syn, dict)) continue;
    const sc = dice(nk, syn);
    if (sc >= minScore && (!best || sc > best.confidence)) {
      best = { ...pickSyn(list), confidence: sc, how: 'fuzzy', fuzzy_match: true };
    }
  }
  return best;
}

/**
 * Полный каскад сопоставления одного ключа.
 * 1. точное совпадение → 1.0
 * 2. множество слов → 0.95
 * 3. blacklist — до нечёткого (не отменяет точный синоним другого атрибута)
 * 4. нечёткое; кандидат из blacklist любого атрибута → отказ
 * 5. unmapped
 */
export function matchKey(key, dict, { value = '', fuzzyMin = 0.9 } = {}) {
  const nk = normKey(key);
  if (!nk) return { attr: null, raw: key, confidence: 0, how: 'unmapped' };

  const exact = exactMatch(key, dict, value);
  if (exact) return exact;

  const bag = bagOfWordsMatch(key, dict, value);
  if (bag) return bag;

  const banned = blacklistHit(nk, dict);
  if (banned) return { attr: null, raw: key, confidence: 0, how: 'blacklist', banned };

  const fuzzy = fuzzyMatch(key, dict, fuzzyMin);
  if (fuzzy) return fuzzy;

  return { attr: null, raw: key, confidence: 0, how: 'unmapped' };
}

export function matchLine(line, dict, opts) {
  const prefix = longestPrefixMatch(line, dict);
  if (!prefix) return null;
  const synNorm = normKey(prefix.raw || prefix.attr.name);
  // Находим исходный префикс строки, чья нормальная форма = синоним.
  const split = splitOriginalByNormPrefix(line, synNorm);
  if (!split || !split.value) return null;
  return { ...prefix, raw: split.key, value: split.value };
}

/** Отрезать от исходной строки префикс с нормальной формой synNorm. */
export function splitOriginalByNormPrefix(line, synNorm) {
  const src = String(line).trim();
  const words = src.split(/\s+/);
  for (let n = words.length - 1; n >= 1; n--) {
    const key = words.slice(0, n).join(' ');
    const value = words.slice(n).join(' ').replace(/^[:\-–—]\s*/, '').replace(/[.;]\s*$/, '').trim();
    if (normKey(key) === synNorm && value) return { key, value };
  }
  // Префикс может быть короче из-за снятых единиц в скобках: «Загрузка белья (кг) 4»
  // synNorm = «загрузка белья», key из 2 слов + скобки с единицей.
  for (let n = 1; n < words.length; n++) {
    const key = words.slice(0, n).join(' ');
    const nk = normKey(key);
    if (nk === synNorm) {
      const value = words.slice(n).join(' ').replace(/^[:\-–—]\s*/, '').replace(/[.;]\s*$/, '').trim();
      if (value) return { key, value };
    }
    // Ключ + единичные скобки: n токенов нормы, в исходнике больше из-за (кг)
    if (synNorm.startsWith(nk) || nk.startsWith(synNorm.split(' ').slice(0, tokens(key).length).join(' '))) {
      /* continue expanding */
    }
  }
  // Жадно: набрать токены пока normKey(prefix) не станет равен synNorm.
  let acc = [];
  for (let i = 0; i < words.length; i++) {
    acc.push(words[i]);
    if (normKey(acc.join(' ')) === synNorm) {
      const value = words.slice(i + 1).join(' ').replace(/^[:\-–—]\s*/, '').replace(/[.;]\s*$/, '').trim();
      if (value) return { key: acc.join(' '), value };
    }
  }
  return null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
