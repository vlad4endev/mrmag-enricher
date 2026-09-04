/** Нормализация строк и HTML. Категорийных правил здесь нет. */

export function stripHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&nbsp;?/gi, ' ')
    .replace(/&times;?/gi, '×')
    .replace(/&deg;?/gi, '°')
    .replace(/&ndash;?|&mdash;?/gi, '–')
    .replace(/&laquo;?/gi, '«')
    .replace(/&raquo;?/gi, '»')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function fold(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е');
}

/** Единицы измерения в скобках или после запятой. */
const UNIT_ONLY = /^(?:кг|г|см|мм|м|л|мл|дба|дб|дБ|об\/?\s*мин|квт·ч\/год|квт\*?ч\/?кг|квтч\/г|квт|шт|%|кг\/сут)$/i;
const UNIT_TAIL = /(?:,\s*|\s+)(кг|г|см|мм|м|л|мл|дба|дб|об\/?\s*мин|квт·ч\/год|квт\*?ч\/?кг|квтч\/г|квт|шт|%)$/i;
const QUALIFIER = /\b(?:не\s+более|не\s+менее|макс(?:имальн(?:ый|ая|ое|ые))?|максимум|[mм]ax|прибл(?:изительно)?)\b/gi;

/**
 * Нормальная форма ключа:
 * нижний регистр → ё→е → скобки только с единицей → хвостовая единица после запятой
 * → «не более / макс / прибл» → пунктуация в пробел → схлопнуть пробелы.
 */
export function normKey(s) {
  let t = fold(s)
    .replace(/&nbsp;?/gi, ' ')
    .replace(/[«»„“”"'`]/g, '');
  // Скобки, содержащие только единицу измерения — снять целиком.
  t = t.replace(/\(([^)]*)\)/g, (_, inner) => (UNIT_ONLY.test(String(inner).trim()) ? ' ' : ` ${inner} `));
  t = t.replace(/\[([^\]]*)\]/g, (_, inner) => (UNIT_ONLY.test(String(inner).trim()) ? ' ' : ` ${inner} `));
  t = t.replace(UNIT_TAIL, ' ');
  // «Max» / «Мax» (кириллица+латиница) — то же, что «макс»; \b в JS не видит кириллицу.
  t = t.replace(/(^|[\s(,;])[mм]ax(?=[\s),;.]|$)/gi, '$1 ');
  t = t.replace(QUALIFIER, ' ');
  t = t
    .replace(/[,.;:!?*/\\|+\-–—]/g, ' ')
    .replace(/[×xх]/gi, 'x')
    .replace(/\s+/g, ' ')
    .trim();
  return t;
}

export function tokens(s) {
  return normKey(s).split(' ').filter(Boolean);
}

export function hasLi(html) {
  return /<li\b/i.test(html || '');
}

export function hasBr(html) {
  return /<br\b/i.test(html || '');
}

export function annotationFormat(html) {
  const s = html || '';
  if (hasLi(s)) return 'LI';
  if (hasBr(s)) return 'BR';
  return stripHtml(s) ? 'OTHER' : 'EMPTY';
}

export function splitHtmlChunks(html) {
  const s = String(html || '');
  if (hasLi(s)) {
    return [...s.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(m => stripHtml(m[1])).filter(Boolean);
  }
  return s.split(/<br\s*\/?>/i).map(stripHtml).filter(Boolean);
}

export function isPackingKey(key) {
  const s = String(key || '');
  if (/без\s+упаковк/i.test(s)) return false;
  return /в\s+упаковк|товарной\s+упаковк|с\s+уч[её]том\s+упаковк|брутто|в\s+коробк/i.test(s);
}

/** Строка-заголовок: «Размеры:» или «УПРАВЛЕНИЕ И ФУНКЦИОНАЛ». */
export function isHeadingLine(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (/:\s*$/.test(s) && !/\S:\s*\S/.test(s)) return true;
  const letters = s.replace(/[^A-Za-zА-ЯЁа-яё]/g, '');
  if (letters.length >= 3 && !/\d/.test(s) && letters === letters.toUpperCase() && /[А-ЯЁA-Z]/.test(letters)) {
    return true;
  }
  return false;
}
