/**
 * Согласованный лист заказчика: «Есть ли в фильтре? = да».
 * Имена для проверки покрытия — отсюда, не из ключей выходного filters.
 */

export const APPROVED_YES = Object.freeze({
  467: Object.freeze([
    'Тип загрузки',
    'Максимальная загрузка белья',
    'Максимальная скорость отжима',
    'Класс энергоэффективности',
    'Класс стирки',
    'Класс эффективности отжима',
    'Уровень шума при стирке',
    'Цвет корпуса',
    'Тип управления',
    'Количество программ',
    'Дисплей',
    'Высота',
    'Ширина',
    'Глубина',
    'Габариты (ШхГхВ)',
    'Вес',
    'Установка',
    'Тип двигателя',
    'Сушка',
    'Тип',
  ]),
  523: Object.freeze([
    'Тип холодильника',
    'Количество камер',
    'Количество дверей',
    'Расположение морозильной камеры',
    'Общий объём',
    'Объём холодильной камеры',
    'Объём морозильной камеры',
    'Система охлаждения',
    'Размораживание холодильной камеры',
    'Размораживание морозильной камеры',
    'Класс энергоэффективности',
    'Тип компрессора',
    'Уровень шума',
    'Мощность замораживания',
    'Высота',
    'Ширина',
    'Глубина',
    'Цвет корпуса',
    'Тип управления',
    'Дисплей',
    'Перенавешиваемые двери',
  ]),
});

/**
 * «Есть ли в фильтре? = нет»: в карточке (характеристики) быть должны,
 * в filters_* — нет. Бренд отдельно: сопоставление по id.
 */
export const APPROVED_NO = Object.freeze({
  467: Object.freeze([
    'Бренд',
    'Уровень шума при отжиме',
    'Материал бака',
    'Материал барабана',
    'Защита от детей',
    'Расход воды за цикл',
    'Энергопотребление за год',
    'Страна производства',
  ]),
  523: Object.freeze([
    'Бренд',
    'Климатический класс',
    'Хладагент',
    'Количество компрессоров',
    'Габариты (ШхВхГ)',
    'Вес',
    'Материал полок',
    'Освещение',
    'Энергопотребление за год',
    'Страна производства',
  ]),
});

/**
 * Лист «да», но пусто честнее выдуманного «нет»: не входят в гейт 100%.
 */
export const OPTIONAL_YES = Object.freeze({
  523: Object.freeze(['Дисплей', 'Перенавешиваемые двери']),
});

export function optionalApproved(catId) {
  return OPTIONAL_YES[catKey(catId)] || [];
}

export function isOptionalApproved(name, catId) {
  return optionalApproved(catId).includes(String(name || ''));
}

/** Имя строки листа → ключ product.filters (facet.label). */
export const APPROVED_MAP = Object.freeze({
  467: Object.freeze({
    'Тип': 'Тип',
    // Согласован позже: attr.name = витринный «Тип».
    'Вид стиральной машины': 'Тип',
    'Тип загрузки': 'Тип загрузки',
    'Максимальная загрузка белья': 'Загрузка белья, кг',
    'Загрузка белья, кг': 'Загрузка белья, кг',
    'Максимальная скорость отжима': 'Скорость отжима, об/мин',
    'Скорость отжима, об/мин': 'Скорость отжима, об/мин',
    'Класс энергоэффективности': 'Класс энергоэффективности',
    'Класс стирки': 'Класс стирки',
    'Класс эффективности отжима': 'Класс эффективности отжима',
    'Уровень шума при стирке': 'Уровень шума, дБ',
    'Уровень шума, дБ': 'Уровень шума, дБ',
    'Цвет корпуса': 'Цвет корпуса',
    'Цвет': 'Цвет корпуса',
    'Тип управления': 'Тип управления',
    'Количество программ': 'Количество программ',
    'Дисплей': 'Дисплей',
    'Высота': 'Высота, см',
    'Высота, см': 'Высота, см',
    'Ширина': 'Ширина, см',
    'Ширина, см': 'Ширина, см',
    'Глубина': 'Глубина, см',
    'Глубина, см': 'Глубина, см',
    'Габариты': 'Габариты (ШхГхВ)',
    'Габариты (ШхГхВ)': 'Габариты (ШхГхВ)',
    'Вес': 'Вес, кг',
    'Вес, кг': 'Вес, кг',
    'Установка': 'Установка',
    'Тип двигателя': 'Тип двигателя',
    'Сушка': 'Сушка',
    'Уровень шума при отжиме': 'Уровень шума при отжиме',
    'Материал бака': 'Материал бака',
    'Материал барабана': 'Материал барабана',
    'Защита от детей': 'Защита от детей',
    'Расход воды за цикл': 'Расход воды за цикл',
    'Энергопотребление за год': 'Энергопотребление за год',
    'Страна производства': 'Страна производства',
  }),
  523: Object.freeze({
    'Тип холодильника': 'Тип холодильника',
    'Количество камер': 'Количество камер',
    'Количество дверей': 'Количество дверей',
    'Расположение морозильной камеры': 'Расположение морозильной камеры',
    'Общий объём': 'Общий объём, л',
    'Общий объём, л': 'Общий объём, л',
    'Объём холодильной камеры': 'Объём холодильной камеры, л',
    'Объём холодильной камеры, л': 'Объём холодильной камеры, л',
    'Объём морозильной камеры': 'Объём морозильной камеры, л',
    'Объём морозильной камеры, л': 'Объём морозильной камеры, л',
    'Система охлаждения': 'Система охлаждения',
    'Размораживание холодильной камеры': 'Размораживание холодильной камеры',
    'Размораживание морозильной камеры': 'Размораживание морозильной камеры',
    'Класс энергоэффективности': 'Класс энергоэффективности',
    'Тип компрессора': 'Тип компрессора',
    'Уровень шума': 'Уровень шума, дБ',
    'Уровень шума, дБ': 'Уровень шума, дБ',
    'Мощность замораживания': 'Мощность замораживания, кг/сут',
    'Мощность замораживания, кг/сут': 'Мощность замораживания, кг/сут',
    'Высота': 'Высота, см',
    'Высота, см': 'Высота, см',
    'Ширина': 'Ширина, см',
    'Ширина, см': 'Ширина, см',
    'Глубина': 'Глубина, см',
    'Глубина, см': 'Глубина, см',
    'Тип управления': 'Тип управления',
    'Дисплей': 'Дисплей',
    'Перенавешиваемые двери': 'Перенавешиваемые двери',
    'Климатический класс': 'Климатический класс',
    'Хладагент': 'Хладагент',
    'Количество компрессоров': 'Количество компрессоров',
    'Габариты': 'Габариты (ШхВхГ)',
    'Габариты (ШхВхГ)': 'Габариты (ШхВхГ)',
    'Вес': 'Вес, кг',
    'Вес, кг': 'Вес, кг',
    'Цвет корпуса': 'Цвет корпуса',
    'Цвет': 'Цвет корпуса',
    'Материал полок': 'Материал полок',
    'Освещение': 'Освещение',
    'Энергопотребление за год': 'Энергопотребление за год',
    'Страна производства': 'Страна производства',
  }),
});

export function catKey(catId) {
  const s = String(catId || '').trim();
  if (s === '467' || /стиральн/i.test(s)) return '467';
  if (s === '523' || /холодильник/i.test(s)) return '523';
  return s;
}

export function approvedFilters(category) {
  const id = catKey(category);
  return [...(APPROVED_YES[id] || [])];
}

export function forbiddenFilters(category) {
  const id = catKey(category);
  return [...(APPROVED_NO[id] || [])];
}

/** Строки листа «нет» без бренда — только характеристики карточки. */
export function approvedSpecOnly(category) {
  return forbiddenFilters(category).filter(name => !/^бренд$/i.test(name));
}

export function sheetToFilterKey(sheetName, category) {
  const id = catKey(category);
  const map = APPROVED_MAP[id] || {};
  const name = String(sheetName || '').trim();
  return map[name] || name;
}

/** Канонический ключ и поздние алиасы одной строки листа. */
export function aliasKeysFor(sheetName, category) {
  const id = catKey(category);
  const map = APPROVED_MAP[id] || {};
  const canonical = sheetToFilterKey(sheetName, id);
  const keys = new Set([String(sheetName || '').trim(), canonical].filter(Boolean));
  for (const [from, to] of Object.entries(map)) {
    if (to === canonical || to === sheetName || from === sheetName || from === canonical) {
      keys.add(from);
      keys.add(to);
    }
  }
  return keys;
}

/** Ключи filters, которые закрывают строку листа «да» — включая поздние алиасы. */
export function allowedFilterKeys(category) {
  const id = catKey(category);
  const yes = APPROVED_YES[id] || [];
  const map = APPROVED_MAP[id] || {};
  const out = new Set();
  for (const name of yes) {
    for (const key of aliasKeysFor(name, id)) out.add(key);
  }
  const dest = new Set(out);
  for (const [from, to] of Object.entries(map)) {
    if (dest.has(to) || dest.has(from)) {
      out.add(from);
      out.add(to);
    }
  }
  return out;
}

export function hasFilterValue(filters, name) {
  const v = filters?.[name];
  if (v == null || v === '') return false;
  return Array.isArray(v) ? v.length > 0 : true;
}

export function displayFilterValue(v) {
  if (v == null || v === '') return '';
  return Array.isArray(v) ? v.map(x => String(x)).filter(Boolean).join(', ') : String(v);
}

export function lookupApprovedValue(filters, sheetName, category) {
  for (const key of aliasKeysFor(sheetName, category)) {
    if (hasFilterValue(filters, key)) {
      return { key, value: filters[key], ok: true };
    }
  }
  return { key: sheetToFilterKey(sheetName, category), value: null, ok: false };
}

export function forbiddenFilterKeys(category) {
  const id = catKey(category);
  const out = new Set();
  for (const name of APPROVED_NO[id] || []) {
    for (const key of aliasKeysFor(name, id)) out.add(key);
  }
  return out;
}

export function classifyOutputKey(key, category) {
  const name = String(key || '').trim();
  if (!name) return { kind: 'skip', reason: '' };
  const id = catKey(category);
  if (forbiddenFilterKeys(id).has(name)) {
    return { kind: 'forbidden', reason: 'в листе «нет» — только характеристика, не фильтр' };
  }
  const allowed = allowedFilterKeys(id);
  if (allowed.has(name)) return { kind: 'approved', reason: '' };
  return { kind: 'unlisted', reason: 'нет в согласованном листе категории' };
}

export function unapprovedFilterRows(filters, category) {
  const rows = [];
  for (const [name, raw] of Object.entries(filters || {})) {
    if (!hasFilterValue(filters, name)) continue;
    const cls = classifyOutputKey(name, category);
    if (cls.kind === 'approved' || cls.kind === 'skip') continue;
    rows.push({
      name,
      value: displayFilterValue(raw),
      ok: false,
      kind: 'unapproved',
      reason: cls.kind === 'forbidden' ? 'запрещён' : 'несогласованный фильтр',
      detail: cls.reason,
    });
  }
  return rows;
}
