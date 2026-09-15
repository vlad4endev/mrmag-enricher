/**
 * Добор витринных фильтров: факты из связного текста, затем типовые значения.
 * Пустой фасет на витрине хуже типичного значения той же категории.
 */

import { expectedCategoryKind, inferProductKind } from './category_mismatch.js';
import { storefrontFilterAttrs } from './required_filters.js';
import { parseTriple } from './dimensions.js';
import { aliasValue, defrostCanonFromCooling, hasStrictEnum, normalizeValue, unifyEnumValues } from './types.js';

const COLOR_WORD = [
  [/бел(?:ый|ая|ое|ого)/i, 'Белый'],
  [/серебрист|серебро|инокс|нержав|stainless/i, 'Серебристый'],
  [/сер(?:ый|ая|ое|ого)|графит|антрацит/i, 'Серый'],
  [/черн(?:ый|ая|ое|ого)|чёрн/i, 'Чёрный'],
  [/бежев|слонов/i, 'Бежевый'],
  [/красн/i, 'Красный'],
  [/син(?:ий|яя|ее)/i, 'Синий'],
];

const WASHER_DEFAULTS = {
  washer_type: 'Автоматическая',
  load_type: 'Фронтальная',
  install: 'Отдельностоящая',
  drying: 'Нет',
  display: 'Нет',
  control_type: 'Механическое',
  motor_type: 'Коллекторный',
  color: 'Белый',
  energy_class: 'A',
  wash_class: 'A',
  spin_class: 'B',
  programs_qty: '15',
  noise_wash: '58',
  load_max: '7',
  spin_max: '1000',
  height: '85',
  width: '60',
  depth: '45',
  weight: '60',
};

const FRIDGE_DEFAULTS = {
  fridge_type: 'Двухкамерный',
  chambers: '2',
  doors: '2',
  freezer_pos: 'Снизу',
  cooling: 'Капельная',
  display: 'Нет',
  door_reversible: 'Да',
  control_type: 'Механическое',
  color: 'Белый',
  energy_class: 'A',
  noise: '40',
  vol_total: '300',
  vol_fridge: '200',
  vol_freezer: '100',
  freeze_power: '5',
  height: '180',
  width: '60',
  depth: '60',
};

function applyDerived(rec, dict, code, rawLabel, how, level = 'S0', opts = {}) {
  if (rawLabel == null || rawLabel === '') return false;
  if (!dict.byCode.has(code)) return false;
  if (rec.attrs[code] != null && !opts.overwrite) return false;
  const attr = dict.byCode.get(code);
  if (attr.tier === 'X') return false;
  const norm = normalizeValue(attr, String(rawLabel), { keyText: attr.name });
  if (!norm.ok) return false;
  rec.attrs[code] = norm.value;
  rec.provenance = rec.provenance || {};
  rec.provenance[code] = { level, raw: String(rawLabel), model: null, prompt: null, how };
  return true;
}

function storefrontVacant(rec, attr) {
  const v = rec.attrs[attr.code];
  if (v == null || v === '') return true;
  const parts = Array.isArray(v) ? v : [v];
  if (hasStrictEnum(attr) || attr.type === 'class_scale') {
    return !parts.some(x => x != null && x !== '' && aliasValue(attr, String(x)));
  }
  return false;
}

function factText(rec, product) {
  return [
    product?.name || rec.name,
    rec.annotation || product?.annotation,
    rec.description || product?.description,
  ].filter(Boolean).join(' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/ё/g, 'е');
}

function num(re, text) {
  const m = String(text || '').match(re);
  if (!m) return null;
  const n = parseFloat(String(m[1]).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function cls(re, text) {
  const m = String(text || '').match(re);
  if (!m) return null;
  return String(m[1]).toUpperCase()
    .replace('А', 'A').replace('В', 'B').replace('С', 'C').replace('Е', 'E');
}

/**
 * Цифры и флаги из имени / аннотации / описания, если пары ключ–значение не сработали.
 */
export function harvestStorefrontFacts(rec, dict, product) {
  const t = factText(rec, product);
  const kind = inferProductKind(product?.name || rec.name);
  const put = (code, raw, how) => applyDerived(rec, dict, code, raw, how);

  {
    const m = t.match(/(?:максимальн\w*\s+)?загрузк\w*(?:\s+(?:белья|сухого\s+белья))?[^0-9]{0,28}(\d+(?:[.,]\d+)?)\s*кг/i)
      || t.match(/максимальн\w+\s+загрузк\w*[^0-9]{0,20}(\d+(?:[.,]\d+)?)\s*кг/i)
      || t.match(/до\s+(\d+(?:[.,]\d+)?)\s*кг/i);
    if (m) put('load_max', m[1], 'harvest_load');
  }
  {
    const m = t.match(/(?:скорость|число\s+оборот|отжим)[^0-9]{0,48}(\d{3,4})\s*(?:об|rpm)/i)
      || t.match(/(\d{3,4})\s*оборот/i);
    if (m && Number(m[1]) >= 400 && Number(m[1]) <= 2000) put('spin_max', m[1], 'harvest_spin');
  }
  put(
    'energy_class',
    cls(/класс(?:а)?\s+энерго\w*\s*[-–—:]?\s*([A-GА-Е]\+{0,3})/i, t)
      || cls(/класс\s*[-–—:]\s*([A-GА-Е]\+{1,3})\b/i, t)
      || cls(/\bкласс\s+([A-GА-Е]\+{1,3})\b/i, t),
    'harvest_energy',
  );
  put('wash_class', cls(/класс(?:а)?\s+(?:эффективности\s+)?стирк[аи]\s*[-–—:]?\s*([A-GА-Е])/i, t), 'harvest_wash_class');
  put('spin_class', cls(/класс(?:а)?\s+(?:эффективности\s+)?отжим[аеу]\s*[-–—:]?\s*([A-GА-Е])/i, t), 'harvest_spin_class');
  {
    const m = t.match(/кол-?во\s+режимов\s*[-–—:]?\s*(\d{1,2})/i)
      || t.match(/(\d{1,2})\s*(?:программ|режимов(?:\s+стирк)?)/i)
      || t.match(/(\d{1,2})\s*пр\b/i);
    if (m && Number(m[1]) >= 3 && Number(m[1]) <= 40) put('programs_qty', m[1], 'harvest_programs');
  }
  {
    const dual = t.match(/шум[^0-9]{0,24}(\d{2,3})\s*\/\s*(\d{2,3})\s*дБ/i);
    const m = dual
      || t.match(/шум[^0-9]{0,40}стирк[^0-9]{0,12}(\d{2,3})/i)
      || t.match(/при\s+стирке[^0-9]{0,8}(\d{2,3})/i);
    if (m && Number(m[1]) >= 30 && Number(m[1]) <= 90) put('noise_wash', m[1], 'harvest_noise');
  }
  {
    const m = t.match(/вес(?:\s+нетто)?[^0-9]{0,16}(\d+(?:[.,]\d+)?)\s*кг/i);
    if (m && !/брутто|упаковк/i.test(m[0])) {
      const n = Number(String(m[1]).replace(',', '.'));
      if (n >= 20 && n <= 200) put('weight', m[1], 'harvest_weight');
    }
  }

  const triple = parseTriple(t);
  if (triple && rec.attrs.dims == null) {
    const [a, b, c] = triple;
    if (a < 400 && b < 400 && c < 400) {
      put('width', a, 'harvest_dims');
      put('depth', b, 'harvest_dims');
      put('height', c, 'harvest_dims');
    }
  }

  for (const [re, label] of COLOR_WORD) {
    if (re.test(t)) {
      put('color', label, 'harvest_color');
      break;
    }
  }

  if (/инвертор/i.test(t)) put('motor_type', 'Инверторный', 'harvest_motor');
  else if (/коллектор|щеточн/i.test(t)) put('motor_type', 'Коллекторный', 'harvest_motor');

  if (dict.byCode.has('load_max')) {
    if (/сенсорн/i.test(t)) put('control_type', 'Сенсорное', 'harvest_control');
    else if (/электронн/i.test(t)) put('control_type', 'Электронное', 'harvest_control');
    else if (/механическ|электромеханическ|поворотн/i.test(t)) put('control_type', 'Механическое', 'harvest_control');
  } else if (/сенсорн|электронн/i.test(t)) {
    put('control_type', 'Электронное', 'harvest_control');
  } else if (/механическ|электромеханическ|поворотн/i.test(t)) {
    put('control_type', 'Механическое', 'harvest_control');
  }

  if (/без\s+диспл|диспл\w*\s+(нет|отсутств)/i.test(t)) {
    put('display', 'Нет', 'harvest_display');
  } else if (/тип\s+дисплея|led[\s-]?дисп|диспл\w*\s*[-–—:]?\s*(led|tft|lcd|есть|да)\b|цифров\w*\s+\(?символьн/i.test(t)) {
    put('display', 'Есть', 'harvest_display');
  }

  if (kind === 'fridge' || dict.byCode.has('fridge_type')) {
    put('vol_total', num(/общ(?:ий|его)?\s+объ[её]м[^0-9]{0,28}(\d{2,4})\s*л/i, t), 'harvest_vol');
    put('vol_fridge', num(/объ[её]м\s+холодильн\w*\s+камер[^0-9]{0,20}(\d{2,4})/i, t), 'harvest_vol');
    put('vol_freezer', num(/объ[её]м\s+морозильн\w*\s+камер[^0-9]{0,20}(\d{2,3})/i, t), 'harvest_vol');
    put('freeze_power', num(/замораживани\w*[^0-9]{0,24}(\d+(?:[.,]\d+)?)\s*кг/i, t), 'harvest_freeze');
    put('noise', num(/шум[^0-9]{0,24}(\d{2})/i, t), 'harvest_noise');
    if (/перенавеш|перевеш\w*\s+двер/i.test(t)) {
      if (/\bнет\b/i.test(t) && /перенавеш|перевеш/i.test(t)) put('door_reversible', 'Нет', 'harvest_doorside');
      else put('door_reversible', 'Да', 'harvest_doorside');
    }
  }

  if (kind === 'dryer') {
    put('drying', 'Есть', 'harvest_drying');
  }
}

/**
 * Закрывает пустые и неканонические витринные оси типичным значением категории.
 */
export function fillStorefrontDefaults(rec, dict, product) {
  const kind = inferProductKind(product?.name || rec.name);
  const expected = expectedCategoryKind(dict.catId);
  if (expected && kind !== expected && kind !== 'other') return;
  const table = dict.byCode.has('load_max') ? WASHER_DEFAULTS : FRIDGE_DEFAULTS;
  if (kind === 'dryer') {
    applyDerived(rec, dict, 'drying', 'Есть', 'storefront_default');
    applyDerived(rec, dict, 'load_type', 'Фронтальная', 'storefront_default');
  }
  for (const attr of storefrontFilterAttrs(dict)) {
    if (!storefrontVacant(rec, attr)) continue;
    let raw = table[attr.code];
    if (raw == null) continue;
    if (attr.code === 'drying' && kind === 'dryer') raw = 'Есть';
    if (attr.code === 'control_type' && rec.attrs.display === true) raw = 'Электронное';
    if (attr.code === 'motor_type' && /инвертор/i.test(String(product?.name || rec.name || ''))) {
      raw = 'Инверторный';
    }
    applyDerived(rec, dict, attr.code, String(raw), 'storefront_default', 'S0', { overwrite: true });
  }
  const cool = rec.attrs.cooling;
  if (cool != null) {
    const fridge = defrostCanonFromCooling(cool, 'fridge');
    if (fridge) applyDerived(rec, dict, 'defrost_fridge', fridge, 'derived_defrost_from_cooling');
    const freezer = defrostCanonFromCooling(cool, 'freezer');
    if (freezer) applyDerived(rec, dict, 'defrost_freezer', freezer, 'derived_defrost_from_cooling');
  }
  composeDimsFromAxes(rec, dict);
}

function composeDimsFromAxes(rec, dict) {
  if (!dict.byCode.has('dims') || rec.attrs.dims != null) return;
  const width = rec.attrs.width;
  const height = rec.attrs.height;
  const depth = rec.attrs.depth;
  if (typeof width !== 'number' || typeof height !== 'number' || typeof depth !== 'number') return;
  rec.attrs.dims = { width, height, depth };
  rec.provenance = rec.provenance || {};
  rec.provenance.dims = {
    level: 'S0',
    raw: `${width}×${depth}×${height}`,
    model: null,
    prompt: null,
    how: 'storefront_default_dims',
  };
}

export function completeStorefrontRecs(recs, dict) {
  unifyEnumValues(recs, dict);
  for (const rec of recs || []) {
    fillStorefrontDefaults(rec, dict, rec);
  }
  return recs;
}
