/**
 * Товар не своей категории: тип по наименованию ≠ тип раздела.
 * Пока нет решения заказчика — флаг, отчёт, не считать пустые фильтры дефектом.
 */

const CAT_KIND = {
  467: 'washer',
  523: 'fridge',
  929: 'hood',
};

const DRYER_RE = /сушильн|суш(?:ильная)?\s*маш/i;
const WASHER_RE = /стиральн/i;
const FRIDGE_RE = /холодильник/i;
const HOOD_RE = /вытяжк|воздухоочист/i;
const ACCESSORY_RE = /соединительн|элемент\s*ck|комплект\s*для\s*колонн|переходник/i;

export function inferProductKind(name) {
  const n = String(name || '').replace(/ё/g, 'е');
  if (ACCESSORY_RE.test(n) && !WASHER_RE.test(n) && !FRIDGE_RE.test(n)) return 'accessory';
  if (DRYER_RE.test(n) && !WASHER_RE.test(n)) return 'dryer';
  if (WASHER_RE.test(n)) return 'washer';
  if (FRIDGE_RE.test(n)) return 'fridge';
  if (HOOD_RE.test(n)) return 'hood';
  return 'other';
}

export function expectedCategoryKind(catId) {
  return CAT_KIND[String(catId)] || null;
}

/**
 * @returns {{ expected: string, got: string } | null}
 */
export function categoryMismatchOf(name, catId) {
  const expected = expectedCategoryKind(catId);
  if (!expected) return null;
  const got = inferProductKind(name);
  if (got === expected || got === 'other') return null;
  return { expected, got };
}

export function markCategoryMismatch(rec, catId) {
  const miss = categoryMismatchOf(rec?.name, catId);
  if (!miss) {
    rec.category_mismatch = false;
    return null;
  }
  rec.category_mismatch = true;
  rec.category_mismatch_detail = miss;
  if (!Array.isArray(rec.flags)) rec.flags = [];
  if (!rec.flags.includes('category_mismatch')) rec.flags.push('category_mismatch');
  return miss;
}

export function isCategoryMismatch(rec) {
  return Boolean(rec?.category_mismatch);
}
