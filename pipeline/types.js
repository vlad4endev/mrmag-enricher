/** Нормализаторы по type из справочника. Допустимые значения — тоже из него. */

const BOOL_TRUE = new Set(['да', 'yes', 'true', 'есть', 'имеется', 'включено', '+', '1', 'on']);
const BOOL_FALSE = new Set(['нет', 'no', 'false', 'отсутствует', 'выключено', '0', 'off', 'без']);

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
  if (/(?<![а-яёa-z])(?:л|литр)/.test(s)) return 'л';
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
  t = t.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
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

function aliasValue(attr, raw) {
  const aliases = attr.value_aliases;
  if (!aliases) return null;
  const folded = valueFold(raw);
  for (const [canon, list] of Object.entries(aliases)) {
    if (valueFold(canon) === folded) return canon;
    if ((list || []).some(v => valueFold(v) === folded)) return canon;
  }
  return null;
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
      if (BOOL_TRUE.has(k) || /^\+/.test(k)) return { ok: true, value: true };
      if (BOOL_FALSE.has(k)) return { ok: true, value: false };
      if (v.trim() && !/^-?\d/.test(v) && !/нет|отсутств/i.test(v)) return { ok: true, value: true };
      return { ok: false, value: null, reason: 'not_boolean', raw: v };
    }
    if (typ === 'class_scale') {
      const m = String(v).trim().match(/([A-Ga-gА-Еа-еA-Ea-eСсC])(\+{0,3})/);
      if (!m) return { ok: false, value: null, reason: 'not_class', raw: v };
      const letter = CLASS_CYR[m[1].toLowerCase()] || m[1].toUpperCase().replace('С', 'C');
      return { ok: true, value: letter + m[2] };
    }
    if (typ === 'enum' || typ === 'text') {
      // Число с единицей в enum — скорее чужой атрибут, чем допустимое значение.
      if (/\d+(?:[.,]\d+)?\s*(?:кг|г|л|мл|см|мм|дб|об)/i.test(v) && !/фронтал|вертикал|камер/i.test(v)) {
        return { ok: false, value: null, reason: 'qty_in_enum', raw: v };
      }
      const aliased = aliasValue(attr, v);
      const val = displayEnum(aliased || v);
      if (!val) return empty;
      if (typ === 'enum' && isBareBooleanWord(val)) {
        return { ok: false, value: null, reason: 'bool_in_enum', raw: v };
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
