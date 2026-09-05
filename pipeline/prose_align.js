/**
 * Согласование текстов карточки (description / bullets / short) со specs.
 * После crossCheck источник истины — specs; цифры в прозе не имеют права
 * расходиться с характеристиками (типичный баг: «16 программ» в тексте и 24 в specs).
 *
 * Автоправка только по размеченным паттернам (подпись + число), без голой
 * замены любого «24» в абзаце — иначе ломается «отсрочка 24 ч».
 */

/** @typedef {{ key: string, label: string, re: RegExp }} ProseClaim */

/** @type {ProseClaim[]} */
export const PROSE_NUMERIC_CLAIMS = [
  {
    key: 'количество_программ',
    label: 'программ',
    // «Количество программ стирки — 16» / «16 программ» / «24 программами»
    // После кириллицы \\b не работает (\\w = латиница) — смотрим границы явно.
    re: /(?:(?:количеств[а-яё]*\s+)?программ[а-яё]*(?:\s+стирки)?\s*[-–—:=]?\s*)(\d{1,2})(?!\d)|(?<![а-яёa-z0-9.])(\d{1,2})(\s*программ[а-яё]*)(?![а-яё])/gi,
  },
  {
    key: 'максимальная_загрузка_кг',
    label: 'загрузка',
    // Только с подписью «загрузка» — иначе «6 кг» перепишет вес.
    re: /(?:(?:макс(?:имальн[а-яё]*)?\s+)?загрузк[а-яё]*(?:\s+белья)?[^0-9\n]{0,24})(\d+(?:[.,]\d+)?)\s*кг(?![а-яёa-z])|(?<![а-яёa-z0-9.])(\d+(?:[.,]\d+)?)(\s*кг\s+белья)/gi,
  },
  {
    key: 'скорость_отжима_об_мин',
    label: 'отжим',
    re: /(?:(?:скорост[а-яё]*\s+)?отжим[а-яё]*[^0-9\n]{0,24})(\d{3,4})\b|\b(\d{3,4})(\s*об\.?\s*\/?\s*мин)/gi,
  },
  {
    key: 'объем_общий_л',
    label: 'объём',
    re: /(?:общ(?:ий|его)?\s+объ[её]м[а-яё]*[^0-9\n]{0,24})(\d+(?:[.,]\d+)?)\s*л\b/gi,
  },
  {
    key: 'вес_кг',
    label: 'вес',
    re: /(?:\bвес[а-яё]*[^0-9\n]{0,16})(\d+(?:[.,]\d+)?)\s*кг\b/gi,
  },
  {
    key: 'уровень_шума_стирки_дб',
    label: 'шум стирки',
    re: /(?:шум[а-яё]*(?:\s+при)?\s+стирк[а-яё]*[^0-9\n]{0,16})(\d{2,3})\s*дБ\b/gi,
  },
  {
    key: 'уровень_шума_отжима_дб',
    label: 'шум отжима',
    re: /(?:шум[а-яё]*(?:\s+при)?\s+отжим[а-яё]*[^0-9\n]{0,16})(\d{2,3})\s*дБ\b/gi,
  },
  {
    key: 'уровень_шума_дб',
    label: 'шум',
    re: /(?:(?:уровень\s+)?шум[а-яё]*[^0-9\n]{0,24})(\d{2,3})\s*дБ\b/gi,
  },
  {
    key: 'расход_воды_л_цикл',
    label: 'расход воды',
    re: /(?:расход[а-яё]*\s+вод[а-яё]*[^0-9\n]{0,24})(\d+(?:[.,]\d+)?)\s*л\b/gi,
  },
  {
    key: 'расход_воды_л',
    label: 'расход воды',
    re: /(?:расход[а-яё]*\s+вод[а-яё]*[^0-9\n]{0,24})(\d+(?:[.,]\d+)?)\s*л\b/gi,
  },
];

function numEq(a, b) {
  const x = Number(String(a).replace(',', '.'));
  const y = Number(String(b).replace(',', '.'));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= Math.max(0.05, Math.abs(y) * 0.01);
}

function expectedFor(specs, key) {
  const v = specs?.[key];
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Находит в тексте числа у известных подписей, не совпадающие со specs.
 * @returns {{ key: string, label: string, found: number, expected: number, match: string }[]}
 */
export function findProseSpecMismatches(text, specs, claims = PROSE_NUMERIC_CLAIMS) {
  const s = String(text || '');
  if (!s || !specs) return [];
  const out = [];
  for (const claim of claims) {
    const expected = expectedFor(specs, claim.key);
    if (expected == null) continue;
    const re = new RegExp(claim.re.source, claim.re.flags);
    let m;
    while ((m = re.exec(s))) {
      const raw = m[1] ?? m[2];
      if (raw == null) continue;
      const found = Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(found) || numEq(found, expected)) continue;
      out.push({
        key: claim.key,
        label: claim.label,
        found,
        expected,
        match: m[0],
      });
    }
  }
  return out;
}

/**
 * Подставляет expected вместо found в каждом размеченном совпадении.
 * @returns {{ text: string, fixes: object[] }}
 */
export function alignTextToSpecs(text, specs, claims = PROSE_NUMERIC_CLAIMS) {
  let out = String(text || '');
  const fixes = [];
  if (!out || !specs) return { text: out, fixes };

  for (const claim of claims) {
    const expected = expectedFor(specs, claim.key);
    if (expected == null) continue;
    const re = new RegExp(claim.re.source, claim.re.flags);
    out = out.replace(re, (full, g1, g2, g3) => {
      const raw = g1 ?? g2;
      if (raw == null) return full;
      const found = Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(found) || numEq(found, expected)) return full;
      const next = String(expected).includes('.')
        ? String(expected)
        : String(Math.round(expected));
      fixes.push({ key: claim.key, label: claim.label, found, expected: Number(next), match: full });
      if (g1 != null && g2 == null) {
        // «…программ — 24» → число в группе 1
        return full.replace(String(raw), next);
      }
      // «24 программ» → число в группе 2, хвост в g3
      return full.replace(String(raw), next);
    });
  }
  return { text: out, fixes };
}

/**
 * Согласовать все карточные тексты со specs.
 * @returns {{ short_description, description, bullets, prose_fixes }}
 */
export function alignCardTextsToSpecs(card, specs) {
  const prose_fixes = [];
  const one = (field, value) => {
    if (typeof value !== 'string') return value;
    const { text, fixes } = alignTextToSpecs(value, specs);
    for (const f of fixes) prose_fixes.push({ field, ...f });
    return text;
  };
  const bullets = Array.isArray(card?.bullets)
    ? card.bullets.map((b, i) => (typeof b === 'string' ? one(`bullets[${i}]`, b) : b))
    : card?.bullets;

  return {
    short_description: one('short_description', card?.short_description ?? ''),
    description: one('description', card?.description ?? ''),
    bullets,
    prose_fixes,
  };
}

/**
 * Остаточные расхождения после (или без) автоправки — для validateModelResponse.
 */
export function cardProseSpecIssues(card, specs) {
  const issues = [];
  const scan = (field, text) => {
    for (const m of findProseSpecMismatches(text, specs)) {
      issues.push({
        field,
        reason: `${m.label}: в тексте ${m.found}, в характеристиках ${m.expected}`,
        key: m.key,
        found: m.found,
        expected: m.expected,
      });
    }
  };
  if (typeof card?.short_description === 'string') scan('short_description', card.short_description);
  if (typeof card?.description === 'string') scan('description', card.description);
  if (Array.isArray(card?.bullets)) {
    card.bullets.forEach((b, i) => {
      if (typeof b === 'string') scan(`bullets[${i}]`, b);
    });
  }
  return issues;
}
