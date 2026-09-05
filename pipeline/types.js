/** Нормализаторы по type из справочника. Допустимые значения — тоже из него. */

const BOOL_TRUE = new Set(['да', 'yes', 'true', 'есть', 'имеется', 'включено', 'поддерживается', 'присутствует', '+', 'on']);
/** «Нет» только при явном отрицании. «0» и «без» слишком двусмысленны → unknown. */
const BOOL_FALSE = new Set([
  'нет', 'no', 'false', 'отсутствует', 'выключено', 'off',
  'не поддерживается', 'не предусмотрено', 'не имеется',
]);

const CLASS_CYR = { а: 'A', б: 'B', в: 'B', г: 'G', д: 'D', е: 'E', с: 'C' };

const UNIT_TO_CM = { мм: 0.1, cm: 1, см: 1, m: 100, м: 100 };
const UNIT_TO_KG = { г: 0.001, kg: 1, кг: 1 };
const UNIT_TO_L = { мл: 0.001, l: 1, л: 1 };

export function parseNumber(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw).replace(',', '.').replace(/\s+/g, '');
  if (/^\s*(-|—|нет данных|не указано|n\/?a)\s*$/i.test(String(raw))) return null;
  // Корзина фильтра «от 40,5 до 50» — не значение товара.
  if (/(?:^|\s)от(?:\s|$)/i.test(raw) && /до\s*\d/i.test(raw)) return null;
  const m = String(raw).replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

function unitIn(text) {
  const s = String(text || '').toLowerCase();
  if (/(?<![а-яёa-z])мм(?![а-яёa-z])/.test(s)) return 'мм';
  if (/(?<![а-яёa-z])см(?![а-яёa-z])/.test(s)) return 'см';
  if (/(?<![а-яёa-z])(?:кг|килограмм)/.test(s)) return 'кг';
  if (/(?<![а-яёa-z])(?:г|грамм)(?![а-яёa-z])/.test(s)) return 'г';
  if (/(?<![а-яёa-z])(?:мл)(?![а-яёa-z])/.test(s)) return 'мл';
  // Годы/месяцы раньше «л»: иначе «5 лет» читается как литры.
  if (/(?<![а-яёa-z])(?:мес(?:яц(?:а|ев)?)?)\.?(?![а-яёa-z])/.test(s)) return 'мес';
  if (/(?<![а-яёa-z])(?:год(?:а|ов)?|лет)\.?(?![а-яёa-z])/.test(s)) return 'лет';
  if (/(?<![а-яёa-z])(?:л|литр)(?![а-яёa-z])/.test(s)) return 'л';
  if (/(?<![а-яёa-z])(?:дба|дб)/.test(s)) return 'дБ';
  if (/об\s*\/?\s*мин/.test(s)) return 'об/мин';
  return null;
}

function convert(n, from, to) {
  if (n == null || !to) return n;
  const f = from && from.toLowerCase();
  const t = to.toLowerCase();
  if (!f || f === t) return n;
  if (t === 'см' && UNIT_TO_CM[f] != null) return n * UNIT_TO_CM[f];
  if (t === 'кг' && UNIT_TO_KG[f] != null) return n * UNIT_TO_KG[f];
  if (t === 'л' && UNIT_TO_L[f] != null) return n * UNIT_TO_L[f];
  if (t === 'мм' && f === 'см') return n * 10;
  // Гарантия: «5 лет» → 60 мес.
  if ((t === 'мес' || t === 'месяц' || t === 'месяцев') && /^(?:год|года|лет)$/.test(f)) {
    return n * 12;
  }
  if ((t === 'год' || t === 'лет') && /^(?:мес|месяц|месяцев)$/.test(f)) {
    return n / 12;
  }
  return n;
}

function inRange(n, range) {
  if (!range || n == null) return true;
  return n >= range[0] && n <= range[1];
}

const ECHO_LEAD = /^(?:цвет|тип|товара|значение|корпус[аеу]?)\s+/i;
const ECHO_TAIL = /\s+(?:загрузк[аиеу]|корпуса?|товара|машины?|цвет)$/i;
const ADJ_END = /(ый|ий|ой|ая|яя|ое|ее|ые|ие)$/;

/** Сравнение значений без регистра, пробелов, дефисов и латинской x в кириллице. */
export function valueFold(s) {
  let t = String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е');
  if (/[а-я]/.test(t)) t = t.replace(/[xc]/g, ch => (ch === 'x' ? 'х' : 'с'));
  return t.replace(/[\s\-–—.,;:'"`«»()/\\]+/g, '');
}

export function valueStem(s) {
  return valueFold(s).replace(ADJ_END, '').replace(/ист$/, '');
}

/**
 * Единый вид enum/text: пробелы, скобки, эхо-слова, Title Case для кириллицы.
 * Латиница (A++, ATLANT, LED) не трогается.
 */
export function displayEnum(raw) {
  let t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return t;
  // Кириллические «эхо»-скобки убираем; латиницу оставляем: «… (No Frost)».
  t = t.replace(/\s*\(([^)]*)\)\s*/g, (_, inner) => {
    const i = String(inner).trim();
    if (/[A-Za-z]/.test(i)) return ` (${i})`;
    return ' ';
  }).replace(/\s+/g, ' ').trim();
  t = t.replace(/[.;,]+$/g, '').trim();
  t = t.replace(ECHO_LEAD, '').replace(ECHO_TAIL, '').trim();
  if (!t || isEchoOnly(t)) return '';
  t = t.replace(/нерж\.?\s*стал[ьи]?/gi, 'нержавеющая сталь');
  if (/[а-яё]/i.test(t)) {
    t = t.replace(/[Cc](?=[А-ЯЁа-яё])|(?<=[А-ЯЁа-яё])[Cc]/g, 'с');
  }
  if (!/[а-яё]/i.test(t)) return t;
  const chars = [...t];
  chars[0] = chars[0].toUpperCase();
  let out = chars[0];
  for (let i = 1; i < chars.length; i++) {
    const ch = chars[i];
    out += /[А-ЯЁа-яё]/.test(ch) ? ch.toLowerCase() : ch;
  }
  return out;
}

export function attrLabel(attr) {
  return (attr.facet && attr.facet.label) || attr.name;
}

/**
 * Подпись строки характеристик — имя атрибута из справочника.
 * facet.label («Загрузка белья, кг») принадлежит фильтру: там значение
 * бакетировано, здесь стоит точное, и единица идёт после числа.
 */
export function annotationLabel(attr) {
  return attr.name;
}

/** Регистр значения сохраняют классы, латиница и имена собственные. */
const KEEP_CASE_CODES = new Set(['brand', 'country', 'refrigerant']);

/** «R600a,58» / «R600a 57 г» / «R-600a (изобутан)» → код хладагента. */
export function extractRefrigerantCode(raw) {
  const m = String(raw ?? '').match(/\b(R-?\d{2,4}[A-Za-z]?)\b/i);
  if (!m) return null;
  return m[1].replace(/-/g, '').replace(/^r/, 'R');
}

export function annotationCase(attr, s) {
  const t = String(s ?? '');
  if (!t) return t;
  if (attr.type === 'class_scale') return t;          // A++, B
  if (KEEP_CASE_CODES.has(attr.code)) return t;       // ATLANT, Россия, R600a
  if (!/[а-яё]/i.test(t)) return t;                   // No Frost, LED, SN-T
  return t[0].toLowerCase() + t.slice(1);
}

/** Порядок осей берётся из имени атрибута: «Габариты (ШхГхВ)» ≠ «(ШхВхГ)». */
const AXIS_FIELD = { ш: 'width', в: 'height', г: 'depth', д: 'depth' };

export function formatDimensions(attr, v, { withUnit = true } = {}) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return '';
  const axes = String(attr.name || '').match(/\(([шхвгд]+)\)/i)?.[1] || 'швг';
  const order = [...axes.toLowerCase()].filter(ch => AXIS_FIELD[ch]).map(ch => AXIS_FIELD[ch]);
  const parts = (order.length === 3 ? order : ['width', 'height', 'depth'])
    .map(f => v[f])
    .filter(x => typeof x === 'number');
  if (parts.length !== 3) return '';
  const body = parts.map(String).join('×');
  if (withUnit && attr.unit) return `${body} ${attr.unit}`;
  return body;
}

/**
 * Строка характеристик: «Максимальная загрузка белья: 6 кг».
 * Точное значение, единица после числа, мультизначные через запятую,
 * логические — «есть» / «нет». Заглушки не выводятся вовсе.
 */
export function annotationText(attr, v) {
  if (v == null || v === '') return '';
  if (Array.isArray(v)) {
    const seen = new Set();
    const parts = [];
    for (const x of v) {
      const s = annotationText(attr, x);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      parts.push(s);
    }
    return parts.join(', ');
  }
  if (v === true) return 'есть';
  if (v === false) return 'нет';
  if (typeof v === 'number') {
    return attr.unit ? `${v} ${attr.unit}` : String(v);
  }
  if (attr.type === 'dimensions' || typeof v === 'object') return formatDimensions(attr, v);
  return annotationCase(attr, displayEnum(v));
}

export function labelHasUnit(label) {
  return /,\s*\S+$/.test(String(label || ''));
}

/** Значение для карточки, фильтров и аннотации — одна и та же строка. */
export function formatAttrValue(attr, v, { withUnit = false } = {}) {
  if (v == null || v === '') return '';
  if (Array.isArray(v)) {
    return v.map(x => formatAttrValue(attr, x, { withUnit: false })).filter(Boolean).join(', ');
  }
  if (v === true) return 'Есть';
  if (v === false) return 'Нет';
  if (attr.type === 'dimensions' || (v && typeof v === 'object' && !Array.isArray(v))) {
    // Объект габаритов нельзя отдавать в displayEnum — получится «[object Object]».
    return formatDimensions(attr, v, { withUnit: withUnit && !!attr.unit });
  }
  if (typeof v === 'number') {
    const n = Number.isInteger(v) ? String(v) : String(v);
    if (withUnit && attr.unit) return `${n} ${attr.unit}`;
    return n;
  }
  return displayEnum(v);
}

function isEchoOnly(s) {
  return /^(загрузк[аиеу]?|корпус[аеу]?|товара?|машины?|цвет|тип|значение)$/.test(valueFold(s));
}

function isBareBooleanWord(val) {
  const k = String(val || '').trim().toLowerCase().replace(/ё/g, 'е');
  return BOOL_TRUE.has(k) || BOOL_FALSE.has(k);
}

/**
 * «Инверторный двигатель: Да» → значение «Инверторный», если ключ — синоним,
 * а не каноническое имя атрибута («Тип двигателя»).
 */
function impliedEnumFromKey(attr, keyText) {
  const key = String(keyText || '').trim();
  if (!key) return null;
  if (valueFold(key) === valueFold(attr.name)) return null;
  // \w без флага u не матчит кириллицу — иначе «освещен\w*» не съедает «ие».
  const word = '[а-яёa-z]*';
  const stripped = key
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(new RegExp(`(?<![а-яёa-z])(?:тип|вид)(?![а-яёa-z])`, 'giu'), ' ')
    .replace(new RegExp(`(?<![а-яёa-z])(?:двигател${word}|мотор${word}|engine|motor)(?![а-яёa-z])`, 'giu'), ' ')
    .replace(new RegExp(`(?<![а-яёa-z])(?:освещен${word}|подсветк${word}|lighting)(?![а-яёa-z])`, 'giu'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let candidate = displayEnum(stripped || key);
  // «LED освещение: да» → LED → светодиодное
  if (/^led$/i.test(String(candidate || '').trim())) candidate = 'Светодиодное';
  if (!candidate || isBareBooleanWord(candidate) || isEchoOnly(candidate)) return null;
  if (valueFold(candidate) === valueFold(attr.name)) return null;
  return candidate;
}

function pickMode(list) {
  const c = new Map();
  for (const x of list) c.set(x, (c.get(x) || 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0], 'ru'))[0][0];
}

function resolveCanons(values) {
  const displayed = values.map(v => displayEnum(v));
  const groups = new Map();
  for (const d of displayed) {
    const k = valueStem(d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  const stems = [...groups.keys()].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const parent = new Map(stems.map(s => [s, s]));
  for (let i = 0; i < stems.length; i++) {
    const a = stems[i];
    if (a.length < 6) continue;
    for (let j = i + 1; j < stems.length; j++) {
      const b = stems[j];
      if (b.startsWith(a)) parent.set(b, parent.get(a));
    }
  }
  for (const d of new Set(displayed)) {
    const my = valueStem(d);
    const toks = String(d).split(/[\s,/|+]+/).map(valueStem).filter(t => t.length >= 6);
    for (const tok of toks) {
      if (tok === my || !groups.has(tok)) continue;
      parent.set(my, parent.get(tok));
    }
  }
  const byRoot = new Map();
  for (const [stem, list] of groups) {
    const root = parent.get(stem);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(...list);
  }
  const winner = new Map();
  for (const [root, list] of byRoot) winner.set(root, pickMode(list));
  const map = new Map();
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    const d = displayed[i];
    const w = winner.get(parent.get(valueStem(d))) || d;
    map.set(raw, w);
    map.set(d, w);
  }
  return map;
}

/**
 * Свести варианты одной характеристики к одному написанию по всему каталогу.
 * Срабатывает после нормализации товара, до сборки фильтров и выгрузки.
 */
export function unifyEnumValues(recs, dict) {
  if (!recs?.length || !dict) return recs;
  for (const attr of dict.attrs) {
    if (attr.type !== 'enum' && attr.type !== 'text') continue;
    const strings = [];
    for (const rec of recs) {
      const v = rec.attrs[attr.code];
      if (v == null) continue;
      if (Array.isArray(v)) {
        for (const x of v) if (typeof x === 'string') strings.push(x);
      } else if (typeof v === 'string') strings.push(v);
    }
    if (!strings.length) continue;
    const canon = resolveCanons(strings);
    for (const rec of recs) {
      const v = rec.attrs[attr.code];
      if (v == null) continue;
      if (Array.isArray(v)) {
        const seen = new Set();
        const next = [];
        for (const x of v) {
          const mapped = typeof x === 'string' ? (canon.get(x) || displayEnum(x)) : x;
          const k = typeof mapped === 'string' ? valueFold(mapped) : String(mapped);
          if (seen.has(k)) continue;
          seen.add(k);
          next.push(mapped);
        }
        rec.attrs[attr.code] = next;
      } else if (typeof v === 'string') {
        rec.attrs[attr.code] = canon.get(v) || displayEnum(v);
      }
    }
  }
  return recs;
}

export function aliasValue(attr, raw) {
  const aliases = attr?.value_aliases;
  if (!aliases) return null;
  const folds = new Set([valueFold(raw), valueFold(displayEnum(raw))].filter(Boolean));
  for (const [canon, list] of Object.entries(aliases)) {
    const keys = [valueFold(canon), ...(list || []).map(valueFold)];
    if (keys.some(k => folds.has(k))) return canon;
  }
  // «Светодиодное LED, 2 x 2 Вт» → канон по вхождению самой длинной метки.
  let best = null;
  let bestLen = 0;
  for (const [canon, list] of Object.entries(aliases)) {
    for (const k of [valueFold(canon), ...(list || []).map(valueFold)]) {
      if (!k || k.length < 4) continue;
      if (![...folds].some(f => f.includes(k))) continue;
      if (k.length > bestLen) {
        best = canon;
        bestLen = k.length;
      }
    }
  }
  return best;
}

/** LED и «Светодиодное» — одно значение для сверки specs ↔ facts. */
export function enumValuesEqual(attr, a, b) {
  if (a == null || b == null) return false;
  const ra = extractRefrigerantCode(a);
  const rb = extractRefrigerantCode(b);
  if (ra && rb && valueFold(ra) === valueFold(rb)) return true;
  const ca = aliasValue(attr, a) || displayEnum(String(a));
  const cb = aliasValue(attr, b) || displayEnum(String(b));
  if (valueFold(ca) === valueFold(cb)) return true;
  // Fallback без справочника: короткий LED ↔ светодиодн*
  const stem = (v) => {
    const f = valueFold(v);
    if (f === 'led' || /^светодиодн/.test(f)) return 'led';
    return f;
  };
  return stem(ca) === stem(cb);
}

/** Склеенный хвост чужих пар («да Перевешиваемые… Габариты…») — не факт освещения. */
export function isGluedFactDump(v) {
  const s = String(v ?? '').trim();
  if (s.length < 40) return false;
  if ((s.match(/\s[-–—]\s/g) || []).length >= 1 && /габарит|размер|двер|перевеш|перенавеш|нетто|брутто/i.test(s)) {
    return true;
  }
  if (/^да\s+/i.test(s) && /габарит|перевеш|перенавеш|размер/i.test(s)) return true;
  return false;
}

function splitMulti(raw) {
  return String(raw)
    .split(/\s*[,;/|]\s*|\s+и\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

export function normalizeValue(attr, raw, { keyText = '' } = {}) {
  const empty = { ok: false, value: null, reason: 'empty' };
  if (raw == null || String(raw).trim() === '') return empty;
  const text = String(raw).trim().replace(/[.;]\s*$/, '');
  const srcUnit = unitIn(text) || unitIn(keyText);

  const one = (typ, v) => {
    if (typ === 'number' || typ === 'integer') {
      const rawStr = String(v).trim();
      // Перечень режимов («отжим, полоскание… отсрочка — 24 ч») — не счётчик.
      // Число должно быть основным содержимым value, а не хвостом чужой строки.
      if (rawStr.length > 48 && !/^\d+(?:[.,]\d+)?/.test(rawStr)) {
        return { ok: false, value: null, reason: 'number_not_primary', raw: v };
      }
      if ((rawStr.match(/,/g) || []).length >= 2 && !/^\d+(?:[.,]\d+)?\s*(?:шт\.?)?$/i.test(rawStr)) {
        return { ok: false, value: null, reason: 'list_not_number', raw: v };
      }
      let n = parseNumber(v);
      if (n == null) return { ok: false, value: null, reason: 'not_number', raw: v };
      n = convert(n, srcUnit, attr.unit);
      if (typ === 'integer') n = Math.round(n);
      if (!inRange(n, attr.valid_range)) {
        return { ok: false, value: null, reason: 'out_of_range', raw: v, parsed: n };
      }
      return { ok: true, value: n, unit: attr.unit || srcUnit };
    }
    if (typ === 'boolean') {
      const k = v.trim().toLowerCase().replace(/ё/g, 'е');
      if (BOOL_TRUE.has(k) || k === '1' || /^\+$/.test(k)) return { ok: true, value: true };
      if (BOOL_FALSE.has(k) || /не\s+поддержива|не\s+предусмотр|не\s+имеется/i.test(k)) {
        return { ok: true, value: false };
      }
      // Отсутствие явного да/нет — unknown, не «нет» и не догадка «да».
      return { ok: false, value: null, reason: 'not_boolean', raw: v };
    }
    if (typ === 'class_scale') {
      const m = String(v).trim().match(/([A-Ga-gА-Еа-еA-Ea-eСсC])(\+{0,3})/);
      if (!m) return { ok: false, value: null, reason: 'not_class', raw: v };
      const letter = CLASS_CYR[m[1].toLowerCase()] || m[1].toUpperCase().replace('С', 'C');
      return { ok: true, value: letter + m[2] };
    }
    if (typ === 'enum' || typ === 'text') {
      // Хладагент: «R600a,58» / «R600a 57 г» → только код, не qty_in_enum.
      if (attr.code === 'refrigerant') {
        const code = extractRefrigerantCode(v);
        if (code) return { ok: true, value: code };
        if (/^\d+(?:[.,]\d+)?\s*(?:г|кг)?\s*$/i.test(String(v).trim())) {
          return { ok: false, value: null, reason: 'qty_not_refrigerant', raw: v };
        }
      }
      // Число с единицей в enum — скорее чужой атрибут, чем допустимое значение.
      // \b не работает с кириллицей в JS — смотрим границу вручную.
      if (/\d+(?:[.,]\d+)?\s*(?:кг|г|л|мл|см|мм|дб|об\/?\s*мин|вт|w)(?![а-яёa-z])/i.test(v)
        && !/фронтал|вертикал|камер|светоди|галоген|накалив|led|алюмин|жиров|угольн|r-?\d{2,4}/i.test(v)) {
        return { ok: false, value: null, reason: 'qty_in_enum', raw: v };
      }
      // Dump: «Автоматическое. Количество полок: 3…» / «да Перевешиваемые двери - да…»
      let rawEnum = String(v);
      if (typ === 'enum') {
        const dumpCut = rawEnum.match(/^(.+?)\.\s+[А-ЯЁA-Za-zа-яё][^:\n]{1,80}:/u);
        if (dumpCut) rawEnum = dumpCut[1].trim();
        const boolLead = rawEnum.match(/^(да|нет|есть|имеется)\s+[А-ЯЁA-Za-zа-яё]/iu);
        if (boolLead && /\s[-–—:]\s/.test(rawEnum)) rawEnum = boolLead[1];
        else if (/габарит|размер|двер|вес|масс|объ[её]м|нетто|брутто|перевеш|перенавеш/i.test(rawEnum)) {
          const inlineCut = rawEnum.match(/^(.{1,40}?)\s+[А-ЯЁA-Z][^–—:\n]{2,70}\s+[-–—]\s+\S/u);
          if (inlineCut) rawEnum = inlineCut[1].trim();
        }
      }
      const aliased = aliasValue(attr, rawEnum);
      if (!aliased && /^[a-z][a-z0-9]*[-_][a-z0-9_-]+$/.test(String(rawEnum).trim())) {
        return { ok: false, value: null, reason: 'slug', raw: v };
      }
      if (typ === 'enum' && isBareBooleanWord(rawEnum)) {
        const k = String(rawEnum).trim().toLowerCase().replace(/ё/g, 'е');
        if (BOOL_FALSE.has(k)) {
          return { ok: false, value: null, reason: 'bool_false_in_enum', raw: v };
        }
        const implied = impliedEnumFromKey(attr, keyText);
        if (implied) return { ok: true, value: aliasValue(attr, implied) || displayEnum(implied) };
        return { ok: false, value: null, reason: 'bool_in_enum', raw: v };
      }
      const val = displayEnum(aliased || rawEnum);
      if (!val) return empty;
      if (typ === 'enum' && (
        /:\s*\S/.test(val)
        || val.length > 80
        || /\.\s+[а-яё]/i.test(val)
        || ((val.match(/\s[-–—]\s/g) || []).length >= 1 && val.length > 30)
      )) {
        return { ok: false, value: null, reason: 'enum_dump', raw: v };
      }
      if (!aliased && (isEchoOnly(val) || valueFold(val) === valueFold(attr.name)
        || /^(?:освещение|подсветка|фильтр|материал|цвет|тип)$/i.test(val))) {
        return { ok: false, value: null, reason: 'echo_value', raw: v };
      }
      return { ok: true, value: val };
    }
    if (typ === 'dimensions') {
      return { ok: true, value: v, raw: v, type: 'dimensions' };
    }
    return { ok: false, value: null, reason: 'unknown_type', raw: v };
  };

  if (attr.cardinality === 'multi') {
    const parts = splitMulti(text);
    const seen = new Set();
    const values = [];
    for (const p of parts) {
      const r = one(attr.type, p);
      if (!r.ok) continue;
      const k = typeof r.value === 'string' ? valueFold(r.value) : String(r.value);
      if (seen.has(k)) continue;
      seen.add(k);
      values.push(r.value);
    }
    return values.length ? { ok: true, value: values } : { ok: false, value: null, reason: 'multi_empty' };
  }

  return one(attr.type, text);
}

export function countUnitsInValues(pairs) {
  let n = 0;
  for (const p of pairs) {
    if (unitIn(p.value) || unitIn(p.key)) n++;
  }
  return n;
}
