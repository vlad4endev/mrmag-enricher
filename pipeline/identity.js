/** Бренд, модель, артикул — только чтение name, без обратной записи. */

import { fold } from './text.js';

function aliasesOf(dict) {
  const attr = dict.byCode.get('brand');
  const map = [];
  if (!attr?.value_aliases) return map;
  for (const [canon, list] of Object.entries(attr.value_aliases)) {
    for (const v of [canon, ...list]) {
      const raw = String(v).trim();
      if (raw) map.push({ canon, raw, fold: fold(raw), len: raw.length });
    }
  }
  map.sort((a, b) => b.len - a.len);
  return map;
}

function findBrand(name, dict) {
  const folded = fold(name);
  for (const a of aliasesOf(dict)) {
    const i = folded.indexOf(a.fold);
    if (i < 0) continue;
    const before = i === 0 || !/[a-zа-яё0-9]/i.test(name[i - 1] || '');
    const after = i + a.fold.length >= folded.length || !/[a-zа-яё0-9]/i.test(name[i + a.raw.length] || '');
    if (before && after) return { canon: a.canon, raw: a.raw, index: i, length: a.raw.length };
  }
  return null;
}

/** Слова названия, по которым товар не узнать: тип, цвет, единицы. */
const GENERIC = /^(?:стиральн[а-яё]*|машин[а-яё]*|холодильник[а-яё]*|морозильник[а-яё]*|морозильн[а-яё]*|камер[а-яё]*|телевизор[а-яё]*|плит[а-яё]*|духовк[а-яё]*|посудомоечн[а-яё]*|микроволнов[а-яё]*|печ[а-яё]*|кондиционер[а-яё]*|вытяжк[а-яё]*|варочн[а-яё]*|поверхност[а-яё]*|сушильн[а-яё]*|сушилк[а-яё]*|встраиваем[а-яё]*|отдельностоящ[а-яё]*|двухкамерн[а-яё]*|однокамерн[а-яё]*|белый|белая|белое|черный|черная|черное|чёрный|чёрная|чёрное|серебристый|серебристая|серебристое|серый|серая|серое|красный|красная|красное|синий|синяя|синее|бежевый|бежевая|графит|графитовый|цвет|with|the|and|для|или|шт|см|мм|кг|л|и|с|a)$/i;

/**
 * Опознавательные слова из названия: бренд, модель, артикул.
 * «Холодильник белый» → [] — искать не по чему.
 * «Холодильник DON R 290 G» → ['DON', '290'] — однобуквенные суффиксы цвета отбрасываются.
 */
export function nameKeyTokens(name, extra) {
  const bits = [
    ...String(name || '').replace(/[«»""(),;]/g, ' ').split(/\s+/),
    ...[extra].flat().filter(Boolean).map(String),
  ];
  const out = [];
  const seen = new Set();
  for (const raw of bits) {
    const w = raw.replace(/^[.:]+|[.:]+$/g, '');
    if (!w || GENERIC.test(w)) continue;
    if (w.length < 2 && !/\d/.test(w)) continue;
    const id = fold(w).replace(/[^\p{L}\d]/gu, '');
    if (id.length < 2 || seen.has(id)) continue;
    seen.add(id);
    out.push(w);
  }
  return out;
}

export function parseIdentity(name, dict) {
  const src = String(name || '');
  const article = src.match(/\((\d{4,})\)\s*$/)?.[1] ?? null;
  const brand = findBrand(src, dict);
  let model = null;
  if (brand) {
    const after = src.slice(brand.index + brand.length).replace(/[«»""']/g, ' ').trim();
    const before = src.slice(0, brand.index).replace(/[«»""']/g, ' ').trim();
    const tail = after.replace(/\(\d{4,}\)\s*$/, '').trim();
    const head = before.split(/\s+/).filter(w => w && !GENERIC.test(w) && !/^[«»"]$/.test(w));
    if (tail && !/^["«»]+$/.test(tail)) model = tail.replace(/^["«\s]+|["»\s]+$/g, '').trim() || null;
    if (!model && head.length) model = head[head.length - 1];
  } else {
    const m = src.match(/([A-ZА-Я]{2,}[A-ZА-Я0-9\-/.]*)\s+([A-ZА-Я0-9][A-ZА-Я0-9\-/.]{2,})/);
    if (m) model = m[2];
  }
  return {
    brand: brand?.canon ?? null,
    model: model || null,
    article,
    name: src,
  };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Фраза целиком, с границами токена: WW80AG6S28AELP ≠ WW80AGAS26AXLP, 418 ≠ M418. */
export function containsTokenSequence(text, phrase) {
  const tokens = String(phrase || '').split(/[\s\-_/,]+/).filter(Boolean);
  if (!tokens.length) return false;
  const body = tokens.map(escapeRe).join('[\\s\\-_/]*');
  const re = new RegExp(`(^|[^A-Za-zА-Яа-яЁё0-9])${body}([^A-Za-zА-Яа-яЁё0-9]|$)`, 'i');
  return re.test(String(text || ''));
}

export function brandAliases(brand, dict) {
  const canon = String(brand || '').trim();
  if (!canon) return [];
  const list = dict?.byCode?.get('brand')?.value_aliases?.[canon] || [];
  return [...new Set([canon, ...list.map(v => String(v).trim()).filter(Boolean)])];
}

function brandOnPage(text, brand, dict) {
  if (!brand) return true;
  return brandAliases(brand, dict).some(a => containsTokenSequence(text, a));
}

/**
 * Правило 12: внешний источник принимается только при полном совпадении
 * бренда и модели одновременно. Синонимы бренда («Индезит» = Indesit)
 * берутся из справочника, если он передан.
 *
 * Модели в названии нет — сверяем опознавательные слова имени: иначе карточки
 * вроде «DON R 290» без артикула-токена оставались пустыми навсегда.
 */
export function identityMatches(text, identity, dict) {
  const model = String(identity?.model || '').trim();
  const brand = String(identity?.brand || '').trim();
  if (model) {
    if (!containsTokenSequence(text, model)) return false;
    return brandOnPage(text, brand, dict);
  }
  const keys = nameKeyTokens(identity?.name, brand);
  if (!keys.length) return false;
  if (!keys.every(k => containsTokenSequence(text, k))) return false;
  return brandOnPage(text, brand, dict);
}
