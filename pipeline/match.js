/** Сопоставление ключа со справочником: синоним → blacklist → нечёткое. */

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

function blacklistHit(nk, dict) {
  for (const b of dict.blacklistIndex) {
    if (nk === b.norm) return b;
    if (nk.startsWith(b.norm + ' ') || nk.endsWith(' ' + b.norm)) return b;
  }
  return null;
}

function pickSyn(list, value) {
  if (list.length === 1) return list[0];
  // Одинаковый синоним у двух атрибутов: «Класс энергопотребления» vs число кВт·ч.
  const looksClass = /^[a-gа-е]\+{0,3}$/i.test(String(value || '').trim());
  const looksNum = /^-?\d/.test(String(value || '').trim());
  const scored = list.map(x => {
    let s = x.len;
    if (looksClass && x.attr.type === 'class_scale') s += 100;
    if (looksNum && (x.attr.type === 'number' || x.attr.type === 'integer')) s += 100;
    if (!looksNum && x.attr.type === 'enum') s += 10;
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

/**
 * Самый длинный синоним, с которого начинается строка.
 * Нужен BR-формату без явного разделителя: «Загрузка белья (кг) 4».
 */
export function longestPrefixMatch(line, dict) {
  const nk = normKey(line);
  if (!nk) return null;
  let best = null;
  for (const [syn, list] of dict.synonymIndex) {
    if (nk === syn || nk.startsWith(syn + ' ')) {
      const rest = nk.slice(syn.length).trim();
      // «вес брутто» не должен схлопываться в синоним «вес».
      if (rest && dict.blacklistIndex.some(b => b.norm === `${syn} ${rest.split(' ')[0]}` || b.norm.startsWith(`${syn} ${rest.split(' ')[0]}`))) {
        continue;
      }
      const cand = pickSyn(list, rest);
      const score = syn.length;
      if (!best || score > best.score) best = { ...cand, score, confidence: 1, how: 'prefix' };
    }
  }
  return best;
}

export function fuzzyMatch(key, dict, minScore) {
  const nk = normKey(key);
  if (!nk || nk.length < 4) return null;
  let best = null;
  for (const [syn, list] of dict.synonymIndex) {
    if (Math.abs(syn.length - nk.length) > 12) continue;
    const sc = dice(nk, syn);
    if (sc >= minScore && (!best || sc > best.confidence)) {
      best = { ...pickSyn(list), confidence: sc, how: 'fuzzy' };
    }
  }
  return best;
}

/**
 * Полный каскад сопоставления одного ключа.
 * Blacklist проверяется до нечёткого и не отменяет точный синоним другого атрибута.
 */
export function matchKey(key, dict, { value = '', fuzzyMin = 0.93 } = {}) {
  const nk = normKey(key);
  const exact = exactMatch(key, dict, value);
  if (exact) return exact;

  const banned = blacklistHit(nk, dict);
  if (banned) return { attr: null, raw: key, confidence: 0, how: 'blacklist', banned };

  // Укорачиваем хвост («Интерфейс 2D» → «Интерфейс»), пока не совпадёт синоним.
  const t = tokens(key);
  for (let n = t.length - 1; n >= 1; n--) {
    const shorter = t.slice(0, n).join(' ');
    const hit = exactMatch(shorter, dict, value);
    if (hit) return { ...hit, how: 'shorten', raw: shorter };
  }

  const fuzzy = fuzzyMatch(key, dict, fuzzyMin);
  if (fuzzy) return fuzzy;

  return { attr: null, raw: key, confidence: 0, how: 'unmapped' };
}

export function matchLine(line, dict, opts) {
  const prefix = longestPrefixMatch(line, dict);
  if (prefix) {
    const rest = stripPrefix(line, prefix.raw || prefix.attr.name);
    return { ...prefix, value: rest };
  }
  return null;
}

function stripPrefix(line, raw) {
  const src = String(line).trim();
  const re = new RegExp('^' + escapeRe(raw) + '\\s*[:\\-–—]?\\s*', 'i');
  if (re.test(src)) return src.replace(re, '').replace(/[.;]\s*$/, '').trim();
  // Нормализованный префикс: режем по числу токенов.
  const n = tokens(raw).length;
  const orig = src.split(/\s+/);
  return orig.slice(n).join(' ').replace(/^[:\-–—]\s*/, '').replace(/[.;]\s*$/, '').trim();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
