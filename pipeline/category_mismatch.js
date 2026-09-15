/**
 * Товар не своей категории: тип по наименованию ≠ тип раздела.
 * Пока нет решения заказчика — флаг, отчёт, не считать пустые фильтры дефектом.
 *
 * Категории сушилок в categories.json нет. Аксессуары стиралок — 487.
 */

const CAT_KIND = {
  467: 'washer',
  523: 'fridge',
  929: 'hood',
};

/** Куда перенести чужой SKU, если такой раздел уже есть. */
const SUGGESTED_CATEGORY = {
  accessory: { 467: 487 },
};

const DRYER_RE = /сушильн|суш(?:ильная)?\s*маш/i;
const WASHER_RE = /стиральн|стир\.?\s*машин|ст[\s-]?маш/i;
const WASHER_DRYER_RE = /стирально[-\s]?сушильн|с\s+сушкой|с\s+функци(?:ей|я)\s+сушк|\bHWD\d|сушка\s*[-–—:]\s*(?:да|есть|\+)|для\s+сушки|\(\s*сушка\s*\)|(?:загрузк\w*|цикл[ае]?)\s+[^\n.]{0,32}сушк/i;
const FRIDGE_RE = /холодильник/i;
const HOOD_RE = /вытяжк|воздухоочист/i;
const ACCESSORY_RE = /соединительн|элемент\s*ck|комплект\s*для\s*колонн|переходник/i;

/** Латинская C перед кириллицей: «Cушильная» / «Cтиральная». */
export function foldHomoglyphs(s) {
  return String(s || '')
    .replace(/C(?=[а-яёА-ЯЁ])/g, 'С')
    .replace(/c(?=[а-яёА-ЯЁ])/g, 'с');
}

function classifyBlob(n) {
  if (ACCESSORY_RE.test(n) && !WASHER_RE.test(n) && !FRIDGE_RE.test(n)) return 'accessory';
  if (DRYER_RE.test(n) && !WASHER_RE.test(n)) return 'dryer';
  if (WASHER_DRYER_RE.test(n)) return 'washer-dryer';
  if (WASHER_RE.test(n)) return 'washer';
  if (FRIDGE_RE.test(n)) return 'fridge';
  if (HOOD_RE.test(n)) return 'hood';
  return 'other';
}

export function inferProductKind(name, extra = '') {
  const foldedName = foldHomoglyphs(name || '').replace(/ё/g, 'е');
  const nameKind = classifyBlob(foldedName);
  // Название «Сушильная машина» / CK-3 важнее аннотации: там часто «для стиральной».
  if (nameKind === 'dryer' || nameKind === 'accessory' || nameKind === 'fridge' || nameKind === 'hood') {
    return nameKind;
  }
  const blobKind = classifyBlob(foldHomoglyphs(`${name || ''}\n${extra || ''}`).replace(/ё/g, 'е'));
  if (nameKind === 'washer-dryer' || blobKind === 'washer-dryer') return 'washer-dryer';
  if (nameKind === 'washer') return 'washer';
  return blobKind;
}

export function kindFitsCategory(kind, expected) {
  if (!expected) return true;
  if (kind === expected || kind === 'other') return true;
  if (expected === 'washer' && kind === 'washer-dryer') return true;
  return false;
}

export function isWasherLike(kind) {
  return kind === 'washer' || kind === 'washer-dryer';
}

export function expectedCategoryKind(catId) {
  return CAT_KIND[String(catId)] || null;
}

export function suggestedCategoryId(kind, catId) {
  const to = SUGGESTED_CATEGORY[kind]?.[String(catId)];
  return to != null ? to : null;
}

/**
 * @returns {{ expected: string, got: string } | null}
 */
export function categoryMismatchOf(name, catId, extra = '') {
  const expected = expectedCategoryKind(catId);
  if (!expected) return null;
  const got = inferProductKind(name, extra);
  if (kindFitsCategory(got, expected)) return null;
  return { expected, got };
}

export function markCategoryMismatch(rec, catId) {
  const extra = [rec?.annotation, rec?.annotation_html, rec?.description].filter(Boolean).join('\n');
  const kind = inferProductKind(rec?.name, extra);
  rec.product_kind = kind;
  rec.suggested_category_id = suggestedCategoryId(kind, catId);
  const miss = categoryMismatchOf(rec?.name, catId, extra);
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
