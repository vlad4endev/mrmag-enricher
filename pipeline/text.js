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

const UNIT_TOKEN = /(?:^|\s)(кг|г|см|мм|м|л|мл|дба|дб|об\/?\s*мин|квт·ч\/год|квт\*?ч\/?кг|квтч\/г|квт|шт|%)(?:\s|$)/gi;

/** Нормальная форма ключа: регистр, пунктуация, единицы в скобках. */
export function normKey(s) {
  return fold(s)
    .replace(/&nbsp;?/gi, ' ')
    .replace(/[«»„“”"'`]/g, '')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/[,.;:!?*/\\|]/g, ' ')
    .replace(/[×xх]/gi, 'x')
    .replace(UNIT_TOKEN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
