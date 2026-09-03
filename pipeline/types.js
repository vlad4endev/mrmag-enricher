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

function aliasValue(attr, raw) {
  const aliases = attr.value_aliases;
  if (!aliases) return null;
  const fold = String(raw || '').trim().toLowerCase().replace(/ё/g, 'е');
  for (const [canon, list] of Object.entries(aliases)) {
    if (canon.toLowerCase() === fold) return canon;
    if ((list || []).some(v => String(v).trim().toLowerCase().replace(/ё/g, 'е') === fold)) return canon;
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
      const aliased = aliasValue(attr, v);
      const val = (aliased || v).replace(/\s+/g, ' ').trim();
      if (!val) return empty;
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
      const k = typeof r.value === 'string' ? r.value.toLowerCase() : String(r.value);
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
