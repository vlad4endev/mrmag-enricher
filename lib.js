/**
 * lib.js — общая логика обогащения: промпт, вызов OpenRouter, разбор и проверка ответа.
 *
 * Единственный источник истины по схеме. И CLI (enricher_mrmag.js), и сервер
 * (server.js) берут промпт и нормализацию отсюда — иначе форматы расходятся.
 *
 * Факты из текста (extractFacts) работают в три стороны:
 *   1) уезжают модели в промпте как проверенные значения,
 *   2) сверяют её ответ (crossCheck → warnings),
 *   3) добирают поля, которые она оставила null (filled_from_text).
 * Поэтому ложный факт дороже пропущенного: он и подсказывает неверно, и
 * помечает верный ответ расхождением. Отсюда диапазоны правдоподобия,
 * недоверие к подписи осей, не прошедшей эти диапазоны, и отказ выставлять
 * систему охлаждения при отрицании или противоречии в тексте.
 */

// ── КУРС ─────────────────────────────────────────────────────
// Обновляйте вместе с датой — она печатается в отчётах и выводится в UI.
export const RUB_PER_USD = Number(process.env.RUB_PER_USD || 80);
export const RUB_RATE_DATE = process.env.RUB_RATE_DATE || '18.08.2026';

// ── ПОЛИТИКА РАСХОЖДЕНИЙ ─────────────────────────────────────
// 'flag'   — записать значение модели, факт из текста и пометку (по умолчанию).
// 'strict' — при расхождении обнулить поле модели, оставив только факт из текста.
export const MISMATCH_POLICY = process.env.MISMATCH_POLICY || 'flag';

// Порог «короткого» текста. Сам по себе он товар не отсекает: короткое описание
// бывает плотным — "размер 57.4x61x171 см. двухкамерный. класс A. общий объем 310 л."
// это 84 символа и пять характеристик. Отсекаем только короткое И без фактов.
export const MIN_SOURCE_CHARS = Number(process.env.MIN_SOURCE_CHARS || 100);

// ── ПОЛЯ КАТЕГОРИЙ ───────────────────────────────────────────
// У холодильника и стиральной машины общего — только габариты и класс
// энергоэффективности. Один список полей на всё означал бы, что машина получает
// в промпте «объем морозильной камеры», а холодильник — «скорость отжима».
// Поэтому набор полей, промпт и разбор фактов свои на каждую категорию;
// собирается это в SCHEMAS ниже, после общих помощников разбора.

const FRIDGE_NUMERIC = [
  'объем_общий_л',
  'объем_холодильной_камеры_л',
  'объем_морозильной_камеры_л',
  'количество_камер',
  'уровень_шума_дб',
  'мощность_замораживания_кг_сут',
  'вес_кг',
  'ширина_мм',
  'высота_мм',
  'глубина_мм',
];

const FRIDGE_SPECS = [
  'тип_товара', 'бренд', 'модель', 'класс_энергоэффективности',
  'объем_общий_л', 'объем_холодильной_камеры_л', 'объем_морозильной_камеры_л',
  'система_охлаждения', 'количество_камер', 'расположение_морозильника',
  'тип_управления', 'хладагент', 'уровень_шума_дб',
  'мощность_замораживания_кг_сут', 'вес_кг',
  'ширина_мм', 'высота_мм', 'глубина_мм', 'цвет', 'тип_ручек',
];

const WASHER_NUMERIC = [
  'максимальная_загрузка_кг',
  'скорость_отжима_об_мин',
  'количество_программ',
  'расход_воды_л_цикл',
  'уровень_шума_стирки_дб',
  'уровень_шума_отжима_дб',
  'вес_кг',
  'ширина_мм',
  'высота_мм',
  'глубина_мм',
];

const WASHER_SPECS = [
  'тип_товара', 'бренд', 'модель', 'тип_загрузки', 'установка',
  'максимальная_загрузка_кг', 'скорость_отжима_об_мин',
  'класс_энергоэффективности', 'класс_стирки', 'класс_отжима',
  'количество_программ', 'расход_воды_л_цикл',
  'уровень_шума_стирки_дб', 'уровень_шума_отжима_дб',
  'тип_управления', 'дисплей', 'сушка', 'защита_от_протечек',
  'вес_кг', 'ширина_мм', 'высота_мм', 'глубина_мм', 'цвет',
];

// ── ОШИБКИ СЕТИ ──────────────────────────────────────────────
/**
 * undici отдаёт бесполезное «fetch failed», а настоящая причина лежит в
 * error.cause: ENETUNREACH (нет IPv6-маршрута), EAI_AGAIN (не резолвится),
 * ETIMEDOUT (режет firewall). Без неё диагностика превращается в гадание.
 */
export function netError(e) {
  if (e?.name === 'TimeoutError') return `таймаут: ${e.message}`;
  const cause = e?.cause?.message || e?.cause?.code;
  return cause ? `${e.message} (${cause})` : String(e?.message || e);
}

// ── ОЧИСТКА HTML ─────────────────────────────────────────────
export function stripHtml(str) {
  if (!str) return '';
  return str
    .replace(/&nbsp;?/gi, ' ')
    .replace(/&times;?/gi, '×')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── ПРИВЕДЕНИЕ ЧИСЕЛ ─────────────────────────────────────────
/**
 * Модель регулярно отдаёт числовые поля строками: "310 л", "≈60", "57,4".
 * Возвращает число либо null. Пустые маркеры ("нет данных", "-") → null.
 */
export function coerceNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(',', '.');
  if (/^\s*(-|—|нет данных|не указано|n\/?a|null)\s*$/i.test(s)) return null;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

// ── ФАКТЫ ИЗ ТЕКСТА (детерминированно) ───────────────────────
// Каталог кладёт единицу и до значения, и после: «Вес (кг) - 72», «Вес: 75 кг»,
// «Габариты (Ш × В × Г, мм) - 580× 2010× 610», «Высота, мм 2025». Регулярка на
// каждый формат не масштабируется, поэтому разбор общий: подпись → служебный
// разделитель → число, а единицу ищем по обе стороны от числа.

const C = '[а-яё]';

// Между подписью и числом допускаем служебный мусор: единицу в скобках, запятые,
// тире, «не более», «до». Точка с запятой и перевод строки — граница поля.
const GAP = '[^0-9\\n;]{0,24}?';
const NUM = '(\\d+(?:[.,]\\d+)?)';
const numOf = s => parseFloat(String(s).replace(',', '.'));

/**
 * Проверка правдоподобия по диапазонам схемы: отсекает ошибки разбора вроде
 * «Высота 2 полки» → 2 мм. Поле без диапазона пропускается как есть.
 */
const inRange = (key, v, ranges) => {
  if (!Number.isFinite(v)) return false;
  const r = ranges?.[key];
  return !r || (v >= r[0] && v <= r[1]);
};

// \b в JS считает кириллицу неслововой, поэтому границы задаём явно.
const RE_MM = /(?<![а-яёa-z])мм(?![а-яё])/i;
const RE_CM = /(?<![а-яёa-z])см(?![а-яё])/i;
const unitOf = s => (RE_MM.test(s) ? 'мм' : RE_CM.test(s) ? 'см' : null);
// Литры: «, л.», «(л)», «180 л», «Общий объем, Литр».
const RE_L = /(?<![а-яёa-z])(?:л|литр[а-яё]*)(?![а-яё])/i;

/** Первое число после подписи, вместе с текстом слева и справа от него. */
function labeled(text, label) {
  // head нужен потому, что единица бывает внутри самой подписи:
  // «Объем брутто (л)/Общий - 365», «Уровень шума (дБА) - 41».
  const m = text.match(new RegExp('(' + label + ')(' + GAP + ')' + NUM + '\\s*([а-яёa-z]{0,12}\\.?)', 'i'));
  if (!m) return null;
  // «Глубина, (см) - от 40,5 до 50» — это корзина фильтра, а не глубина товара.
  // Диапазон фактом быть не может: утверждать по нему 405 мм значит врать.
  if (/(?<![а-яё])от(?![а-яё])/i.test(m[2]) && /^\s*до\s*\d/i.test(text.slice(m.index + m[0].length - m[4].length))) return null;
  return { head: m[1], gap: m[2], value: numOf(m[3]), tail: m[4] };
}

/** Линейный размер в мм. Единица берётся справа, затем слева от числа. */
function lengthMm(text, label) {
  const h = labeled(text, label);
  if (!h) return null;
  const u = unitOf(h.tail) || unitOf(h.gap);
  // Без единицы: у холодильника см двух-трёхзначные, мм — четырёхзначные.
  const k = u === 'мм' ? 1 : u === 'см' ? 10 : h.value >= 400 ? 1 : 10;
  return Math.round(h.value * k);
}

// ── ТРОЙКА РАЗМЕРОВ ──────────────────────────────────────────
const RE_TRIPLE = /(\d+(?:[.,]\d+)?)\s*[x×х]\s*(\d+(?:[.,]\d+)?)\s*[x×х]\s*(\d+(?:[.,]\d+)?)/gi;
// Подпись осей: «(Ш × В × Г, мм)», «(ВхШхГ)», «(ШxГxВ):».
const RE_AXES = /([швгд])\s*[x×х]\s*([швгд])\s*[x×х]\s*([швгд])\s*[,)]/i;
const AXIS = { ш: 'ширина_мм', в: 'высота_мм', г: 'глубина_мм', д: 'глубина_мм' };
// Габариты упаковки крупнее самого товара — сверять по ним нельзя.
const RE_PACK = /упаковк|брутто|с\s+уч[её]т|в\s+коробк/i;

/**
 * Все тройки в тексте с их единицей и порядком осей. Возвращает лучшую:
 * нетто с подписанными осями → нетто → что есть.
 */
function extractDims(text) {
  const cands = [];
  const low = text.toLowerCase();
  let prevEnd = 0;
  for (const m of text.matchAll(RE_TRIPLE)) {
    // Контекст тройки — только её собственная подпись: от предыдущей тройки и
    // не раньше последнего «габарит/размер». Иначе «в упаковке» от соседней
    // строки помечает упаковкой и нетто-габариты тоже.
    const chunk = text.slice(prevEnd, m.index);
    const cut = Math.max(low.lastIndexOf('габарит', m.index), low.lastIndexOf('размер', m.index)) - prevEnd;
    const before = cut > 0 ? chunk.slice(cut) : chunk.slice(-90);
    const after  = text.slice(m.index + m[0].length, m.index + m[0].length + 14);
    prevEnd = m.index + m[0].length;
    const u = unitOf(after) || unitOf(before);
    const raw = [m[1], m[2], m[3]].map(numOf);
    // Без единицы: если хоть одно число четырёхзначное — это уже мм.
    const k = u === 'мм' ? 1 : u === 'см' ? 10 : Math.max(...raw) >= 400 ? 1 : 10;
    const ax = before.match(RE_AXES);
    cands.push({
      nums:   raw.map(x => Math.round(x * k)),
      axes:   ax ? [ax[1], ax[2], ax[3]].map(c => AXIS[c.toLowerCase()]) : null,
      packed: RE_PACK.test(before),
    });
  }
  return cands.find(c => !c.packed && c.axes) || cands.find(c => !c.packed) || cands[0] || null;
}

// ── ОБЩИЕ ПРИЗНАКИ ───────────────────────────────────────────
const RE_KG = /(?<![а-яёa-z])(?:кг|килограмм[а-яё]*)(?![а-яё])/i;
const RE_DB = /(?<![а-яёa-z])(?:дб|дба|децибел[а-яё]*)(?![а-яё])/i;

// Класс энергоэффективности. Строгий вариант требует «энерг» рядом — иначе
// «климатический класс SN» и «класс - N, ST» уедут в энергоэффективность.
const RE_ECLASS = new RegExp(`энерг${C}*(?:\\s+${C}+)?[^0-9A-Za-zА-Яа-яё]{0,8}([A-GА-Е]\\+{0,3})(?![A-Za-zА-Яа-яё])`, 'i');
const RE_ECLASS_LOOSE = /класс[^0-9A-Za-zА-Яа-яё]{0,6}([A-GА-Е]\+{0,3})(?![A-Za-zА-Яа-яё])/i;
const CYR2LAT = { А: 'A', Б: 'B', В: 'B', Г: 'G', Д: 'D', Е: 'E', С: 'C' };

/** Габариты и класс энергоэффективности есть у обеих категорий. */
function commonFacts(t, ranges) {
  const f = {};
  const ok = (key, v) => inRange(key, v, ranges);

  const d = extractDims(t);
  if (d) {
    f.размеры_мм = [...d.nums].sort((a, b) => a - b);
    // Подпись осей бывает лживой: в каталоге встречается «(ШхГхВ) - 595 х 1860 х 590»,
    // где «глубина» 1860 мм. Подпись, не прошедшая диапазоны, доверия не заслуживает —
    // тогда работаем как без подписи.
    const axed = d.axes && d.axes.every((key, i) => key && ok(key, d.nums[i]));
    if (axed) d.axes.forEach((key, i) => { f[key] = d.nums[i]; });
    else if (ok('высота_мм', f.размеры_мм[2])) f.высота_мм = f.размеры_мм[2];
  }
  // Отдельные подписи добирают то, чего в тройке не было.
  for (const [key, label] of [['высота_мм', 'высот[аы]'], ['ширина_мм', 'ширин[аы]'], ['глубина_мм', 'глубин[аы]']]) {
    if (f[key] != null) continue;
    const v = lengthMm(t, label);
    if (ok(key, v)) f[key] = v;
  }

  const e = t.match(RE_ECLASS) || t.match(RE_ECLASS_LOOSE);
  if (e) {
    const c = e[1].toUpperCase();
    f.класс_энергоэффективности = (CYR2LAT[c[0]] || c[0]) + c.slice(1);
  }
  return f;
}

// ── ХОЛОДИЛЬНИКИ ─────────────────────────────────────────────
const FRIDGE_RANGE = {
  ширина_мм: [300, 2600], высота_мм: [400, 2600], глубина_мм: [250, 1200],
  вес_кг: [8, 300],
  объем_общий_л: [15, 1200], объем_холодильной_камеры_л: [5, 900],
  объем_морозильной_камеры_л: [1, 600],
  уровень_шума_дб: [15, 75], мощность_замораживания_кг_сут: [1, 40],
  количество_камер: [1, 4],
};

// Подписи числовых полей. unit — единица, которую обязательно видеть рядом с
// числом: без неё «Общий объем холодильника 180 л» уезжает в объём камеры, а
// «Количество полок 3» — в литры.
const FRIDGE_LABELS = [
  ['объем_общий_л',                 `(?:общ${C}*\\s+об[ъь]?[её]м${C}*|об[ъь]?[её]м\\s+брутто[^0-9\\n]{0,14}общ${C}*)`, RE_L],
  ['объем_холодильной_камеры_л',    `об[ъь]?[её]м${C}*\\s+холодильн${C}*\\s+(?:камер|отделен|отсек)${C}*`, RE_L],
  ['объем_морозильной_камеры_л',    `об[ъь]?[её]м${C}*\\s+морозил${C}*(?:\\s+(?:камер|отделен|отсек)${C}*)?`, RE_L],
  ['уровень_шума_дб',               `уров${C}*\\s+шума`, null],
  ['мощность_замораживания_кг_сут', `мощност${C}*\\s+заморажив${C}*`, null],
  ['вес_кг',                        `(?:вес|масс${C})${C}*`, null],
  ['количество_камер',              `количеств${C}*\\s+камер`, null],
];

// Число перед подписью: «39 дБ», «двухкамерный».
const RE_NOISE_BARE = /(\d+)\s*д[Бб]/;
const RE_CHAMBERS_W = /(одно|двух|тр[ёе]х|четыр[ёе]х)камерн/i;
const CHAMBER_N = { 'одно': 1, 'двух': 2, 'трёх': 3, 'трех': 3, 'четырёх': 4, 'четырех': 4 };
// «Без No Frost» — это НЕ No Frost. Прежняя регулярка читала отрицание как факт.
const RE_NOFROST = /(без\s*[:\-–]?\s*)?(full\s*no\s*frost|no\s*frost|ноу\s*фрост)/i;
const RE_REFRIG = /хладагент[^0-9A-Za-z\n]{0,14}(R\s?\d{3}\s?[a-z]?)/i;

function fridgeFacts(t, f, ranges) {
  if (f.количество_камер == null) {
    const c = t.match(RE_CHAMBERS_W);
    if (c) f.количество_камер = CHAMBER_N[c[1].toLowerCase()] ?? null;
  }
  if (f.уровень_шума_дб == null) {
    const n = t.match(RE_NOISE_BARE);
    if (n && inRange('уровень_шума_дб', +n[1], ranges)) f.уровень_шума_дб = +n[1];
  }

  // Система охлаждения: при противоречии («No Frost» и «капельная» рядом) или
  // при отрицании факта не выставляем — лучше не проверить, чем проверить ложью.
  const drip = /капельн/i.test(t);
  const nf = RE_NOFROST.exec(t);
  const hasNF = Boolean(nf && !nf[1]);
  if (drip !== hasNF) f.система_охлаждения = drip ? 'капельная' : 'No Frost';

  const r = t.match(RE_REFRIG);
  if (r) f.хладагент = r[1].replace(/\s+/g, '').toUpperCase().replace(/([A-Z])$/, m => m.toLowerCase());
}

// ── СТИРАЛЬНЫЕ МАШИНЫ ────────────────────────────────────────
const WASHER_RANGE = {
  // Узкая машина 330 мм глубиной, «под столешницу» — 850 мм высотой.
  ширина_мм: [340, 900], высота_мм: [600, 1300], глубина_мм: [280, 800],
  вес_кг: [15, 140],
  максимальная_загрузка_кг: [1, 25],
  скорость_отжима_об_мин: [300, 2200],
  количество_программ: [1, 40],
  расход_воды_л_цикл: [10, 130],
  уровень_шума_стирки_дб: [30, 80],
  уровень_шума_отжима_дб: [40, 95],
};

const WASHER_LABELS = [
  // «Мax загрузка белья, (кг) - 7» — подпись магазина; «загрузкой 7 кг» — из текста.
  // Единица обязательна: иначе «в зависимости от загрузки. Программа Хлопок 40»
  // даёт загрузку 40 кг.
  ['максимальная_загрузка_кг', `загрузк${C}*(?:\\s+бель${C}*)?`, RE_KG],
  ['скорость_отжима_об_мин',   `отжим${C}*`, null],
  ['расход_воды_л_цикл',       `расход${C}*\\s+воды`, RE_L],
  ['уровень_шума_стирки_дб',   `шум${C}*\\s+(?:при\\s+)?стирк${C}*`, RE_DB],
  ['уровень_шума_отжима_дб',   `шум${C}*\\s+(?:при\\s+)?отжим${C}*`, RE_DB],
  ['количество_программ',      `количеств${C}*\\s+программ`, null],
  ['вес_кг',                   `(?:вес|масс${C})${C}*`, RE_KG],
];

// Число перед подписью: «15 программ», «1200 об/мин».
const RE_PROGRAMS_BARE = /(\d+)\s*программ/i;
const RE_RPM_BARE = /(\d+)\s*об[\/.\s]*мин/i;
// Просто «вертикальн» ловит «вертикальные ручки» — требуем рядом «загрузк»
// или «люк», иначе тип загрузки берётся из постороннего слова.
const RE_LOADING = /(?:тип\s+)?загрузк[а-яё]*[^.;]{0,24}?(фронтальн|вертикальн)|(фронтальн|вертикальн)[а-яё]*\s+(?:загрузк|люк)/i;

function washerFacts(t, f, ranges) {
  if (f.количество_программ == null) {
    const p = t.match(RE_PROGRAMS_BARE);
    if (p && inRange('количество_программ', +p[1], ranges)) f.количество_программ = +p[1];
  }
  if (f.скорость_отжима_об_мин == null) {
    const r = t.match(RE_RPM_BARE);
    if (r && inRange('скорость_отжима_об_мин', +r[1], ranges)) f.скорость_отжима_об_мин = +r[1];
  }
  const l = t.match(RE_LOADING);
  if (l) f.тип_загрузки = /фронтальн/i.test(l[1] || l[2]) ? 'фронтальная' : 'вертикальная';
}

// ── РЕЕСТР СХЕМ ──────────────────────────────────────────────
/**
 * Схема категории: поля ответа, диапазоны правдоподобия, подписи для разбора
 * фактов и добавка к промпту. Ключ — slug раздела mrmag.ru; id проверяется по
 * тому, что вернула страница раздела (см. catalog.js).
 */
export const SCHEMAS = {
  kholodilniki: {
    slug: 'kholodilniki', id: 523, name: 'Холодильники',
    subject: 'холодильников и морозильников',
    specKeys: FRIDGE_SPECS, numericKeys: FRIDGE_NUMERIC,
    ranges: FRIDGE_RANGE, labels: FRIDGE_LABELS, extra: fridgeFacts,
    unitNotes: [
      'Поля _л — целые литры, _кг — килограммы, _дб — децибелы',
      'система_охлаждения: "No Frost" или "капельная". "Без No Frost" — это капельная, НЕ No Frost',
    ],
  },
  stiralnye_mashiny: {
    slug: 'stiralnye_mashiny', id: 467, name: 'Стиральные машины',
    subject: 'стиральных машин',
    specKeys: WASHER_SPECS, numericKeys: WASHER_NUMERIC,
    ranges: WASHER_RANGE, labels: WASHER_LABELS, extra: washerFacts,
    unitNotes: [
      'скорость_отжима_об_мин — оборотов в минуту, только число',
      'максимальная_загрузка_кг — килограммы сухого белья',
      'тип_загрузки: "фронтальная" или "вертикальная"',
      'Глубина в виде "от 40,5 до 50" — это диапазон фильтра магазина, а не размер. Такое в глубина_мм не пиши, ставь null',
    ],
  },
};

const DEFAULT_SCHEMA = SCHEMAS.kholodilniki;

/** Схема по slug, id категории, названию или объекту схемы. */
export function schemaFor(key) {
  if (!key) return DEFAULT_SCHEMA;
  if (typeof key === 'object') return key.specKeys ? key : DEFAULT_SCHEMA;
  const k = String(key);
  return SCHEMAS[k]
    || Object.values(SCHEMAS).find(s => String(s.id) === k || s.name === k)
    || DEFAULT_SCHEMA;
}

// ── ПРОМПТ ───────────────────────────────────────────────────
export function buildSystemPrompt(schemaKey) {
  const s = schemaFor(schemaKey);
  return `Ты эксперт по e-commerce SEO и описаниям товаров бытовой техники.
Категория: ${s.name}.

Тебе передан ОДИН товар с его характеристиками из описания и аннотации.
Твоя задача — извлечь структурированные данные и создать SEO-материалы для ${s.subject}.

СТРОГИЕ ПРАВИЛА:
- Верни ОДИН JSON-объект {}, НЕ массив []
- НЕ придумывай характеристики которых нет в переданных данных
- Извлекай данные из description и annotation — они уже содержат характеристики
- Если данных нет — используй null. Пустая строка и "нет данных" запрещены, только null

ЕДИНИЦЫ ИЗМЕРЕНИЯ (важно):
- Все поля с суффиксом _мм — в миллиметрах. В описаниях размеры часто в сантиметрах:
  "размер 57.4x61x171 см" → умножь каждое число на 10
- Порядок осей в тройке размеров НЕ фиксирован. Если он подписан — "(Ш×В×Г)",
  "(В×Ш×Г)", "(Ш×Г×В)" — следуй подписи. Если подписи нет, самое большое число
  это высота
- Габариты "в упаковке", "брутто", "с учётом упаковки" не подход: нужны
  размеры самого товара
${s.unitNotes.map(x => `- ${x}`).join('\n')}
- Числовые поля — только число, без единицы в значении

ПРОВЕРЕННЫЕ ФАКТЫ:
В поле "facts" переданы значения, уже извлечённые из текста детерминированным
разбором и приведённые к нужным единицам. Они приоритетнее твоей интерпретации:
если факт задан — перенеси его в specs как есть, не пересчитывая.
"размеры_мм" — три габарита по возрастанию без привязки к осям. Если
ширина/высота/глубина в facts не заданы, распредели тройку по осям сам.

СТРУКТУРА ОТВЕТА (строго):
{
  "specs": {
${s.specKeys.map(k => `    "${k}": ${s.numericKeys.includes(k) ? 'null' : '"..."'}`).join(',\n')}
  },
  "synonyms": [],
  "search_aliases": [],
  "seo_keywords": [],
  "seo_description": ""
}

ПРАВИЛА ЗАПОЛНЕНИЯ:
- specs: извлекай из description и annotation, ключи уже заданы — заполняй только те что есть в данных
- synonyms: 4-5 альтернативных названий товара
- search_aliases: 5-7 поисковых запросов как их вводят покупатели
- seo_keywords: 5-7 SEO-фраз для продвижения
- seo_description: готовое SEO-описание товара 2-3 предложения на основе характеристик`;
}

// ── ФАКТЫ ────────────────────────────────────────────────────
/**
 * Извлекает из текста то, что берётся однозначно. Используется и как проверка
 * ответа модели, и как подсказка модели в промпте, и для добора пустых полей.
 */
export function extractFacts(text, schemaKey) {
  const t = String(text || '');
  if (!t) return {};
  const s = schemaFor(schemaKey);
  const f = commonFacts(t, s.ranges);

  for (const [key, label, unit] of s.labels) {
    const h = labeled(t, label);
    if (!h || !inRange(key, h.value, s.ranges)) continue;
    if (unit && !unit.test(h.tail) && !unit.test(h.gap) && !unit.test(h.head)) continue;
    f[key] = h.value;
  }

  s.extra(t, f, s.ranges);
  return f;
}

// ── СВЕРКА ОТВЕТА С ФАКТАМИ ──────────────────────────────────
const NUM_TOLERANCE = { высота_мм: 20, ширина_мм: 20, глубина_мм: 20, вес_кг: 1 }; // округления в описаниях

/**
 * Сравнивает specs модели с фактами из текста. Возвращает список расхождений;
 * при MISMATCH_POLICY='strict' спорное поле модели обнуляется.
 */
export function crossCheck(specs, facts) {
  const warnings = [];
  const flagged = new Set();
  const flag = (field, got, expected, note) => {
    if (flagged.has(field)) return; // одно расхождение на поле, а не два по разным путям
    flagged.add(field);
    warnings.push({ field, model: got, source: expected, note });
    if (MISMATCH_POLICY === 'strict') specs[field] = expected ?? null;
  };

  for (const [key, exp] of Object.entries(facts)) {
    if (key === 'размеры_мм') continue;
    if (!(key in specs)) continue;
    const got = specs[key];
    if (got == null) continue;

    if (typeof exp === 'number') {
      const tol = NUM_TOLERANCE[key] ?? Math.max(1, Math.abs(exp) * 0.02);
      if (Math.abs(Number(got) - exp) > tol) flag(key, got, exp, 'не совпало с текстом');
    } else if (String(got).toLowerCase() !== String(exp).toLowerCase()) {
      flag(key, got, exp, 'не совпало с текстом');
    }
  }

  // Оси без подписи: какая из трёх — не знаем, но само число обязано быть в тройке.
  if (Array.isArray(facts.размеры_мм)) {
    for (const key of ['ширина_мм', 'высота_мм', 'глубина_мм']) {
      if (key in facts) continue; // ось известна точно — уже сверена выше
      const got = specs[key];
      if (got == null) continue;
      const hit = facts.размеры_мм.some(x => Math.abs(x - Number(got)) <= 20);
      if (!hit) flag(key, got, null, `нет в размерах из текста (${facts.размеры_мм.join('×')} мм)`);
    }
  }

  return warnings;
}

// ── РАЗБОР ОТВЕТА ────────────────────────────────────────────
export function parseResponse(text) {
  if (!text?.trim()) throw new Error('Пустой ответ');
  const clean = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const p = JSON.parse(clean);
    return Array.isArray(p) ? p[0] : p;
  } catch {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) {
      const p = JSON.parse(m[0]);
      return Array.isArray(p) ? p[0] : p;
    }
    throw new Error(`Не удалось распарсить JSON: ${clean.slice(0, 80)}`);
  }
}

export function normalizeResponse(data, sourceText = '', schemaKey) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Ответ не объект');
  }
  const schema = schemaFor(schemaKey);
  const raw = data.specs && typeof data.specs === 'object' ? data.specs : {};
  const specs = {};
  for (const k of schema.specKeys) {
    const v = raw[k];
    if (schema.numericKeys.includes(k)) {
      specs[k] = coerceNumber(v);
    } else {
      const s = v == null ? null : String(v).trim();
      specs[k] = s && !/^(нет данных|не указано|-|—|n\/?a)$/i.test(s) ? s : null;
    }
  }

  const facts = extractFacts(sourceText, schema);
  const warnings = crossCheck(specs, facts);

  // Пропуск модели — не повод терять факт: если поле null, а в тексте значение
  // разобрано однозначно, подставляем его и перечисляем, что подставили.
  const filled_from_text = [];
  for (const k of schema.specKeys) {
    if (specs[k] != null || facts[k] == null) continue;
    specs[k] = facts[k];
    filled_from_text.push(k);
  }

  const arr = v => (Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : []);
  return {
    specs,
    synonyms:        arr(data.synonyms),
    search_aliases:  arr(data.search_aliases),
    seo_keywords:    arr(data.seo_keywords),
    seo_description: typeof data.seo_description === 'string' ? data.seo_description.trim() : '',
    source_facts:    facts,
    filled_from_text,
    warnings,
  };
}

// ── ТЕЛО ЗАПРОСА ─────────────────────────────────────────────
export function buildUserContent(product, facts = null) {
  return JSON.stringify({
    facts:       facts && Object.keys(facts).length ? facts : undefined,
    name:        product.name,
    sku:         product.sku,
    brand:       product.brand || undefined,   // бренд по классификации магазина
    category:    product.category,
    description: stripHtml(product.description),
    annotation:  stripHtml(product.annotation),
    attributes:  product.attributes || [],
    price:       product.price,
  });
}

export function sourceText(product) {
  return (stripHtml(product.description) + ' ' + stripHtml(product.annotation)).trim();
}

/**
 * Стоит ли платить за запрос по этому товару.
 * Короткий текст сам по себе не приговор — важно, есть ли в нём что извлекать.
 * Возвращает { ok } либо { ok:false, reason } для пометки в выгрузке.
 */
export function isEnrichable(product, schemaKey) {
  const text = sourceText(product);
  if (!text) return { ok: false, reason: 'нет ни description, ни annotation' };
  const factCount = Object.keys(extractFacts(text, schemaKey)).length;
  if (text.length < MIN_SOURCE_CHARS && factCount === 0) {
    return { ok: false, reason: `текст ${text.length} симв. и ни одной распознанной характеристики` };
  }
  return { ok: true };
}

function buildRequestBody(model, product, maxTokens = 2500, schemaKey) {
  return {
    model,
    max_tokens:  maxTokens,
    temperature: 0.1,
    // Снимает причину ошибок парсинга вместо того, чтобы лечить их ретраями.
    response_format: { type: 'json_object' },
    // Возвращает фактическую стоимость запроса — не считаем её сами.
    usage: { include: true },
    messages: [
      { role: 'system', content: buildSystemPrompt(schemaKey) },
      { role: 'user',   content: product },
    ],
  };
}

// ── RATE LIMITER ─────────────────────────────────────────────
// Проверено прогоном: обе ветки рабочие, окно срабатывает как основная.
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export class RateLimiter {
  constructor(rpm, extraDelayMs = 0) {
    this.rpm      = rpm;
    this.minDelay = Math.ceil(60_000 / rpm) + extraDelayMs;
    this.lastCall = 0;
    this.window   = [];
  }
  async wait(onWait) {
    // Очередь обязательна: без неё параллельные вызовы читают одно и то же
    // состояние окна, все проходят проверку и rpm перестаёт соблюдаться.
    const prev = this.tail || Promise.resolve();
    let release;
    this.tail = new Promise(r => { release = r; });
    await prev;
    try { await this.#slot(onWait); } finally { release(); }
  }

  async #slot(onWait) {
    const now = Date.now();
    this.window = this.window.filter(t => now - t < 60_000);
    if (this.window.length >= this.rpm) {
      const waitMs = 60_000 - (now - this.window[0]) + 150;
      onWait?.(waitMs);
      await sleep(waitMs);
    } else {
      const since = Date.now() - this.lastCall;
      if (since < this.minDelay) await sleep(this.minDelay - since);
    }
    this.lastCall = Date.now();
    this.window.push(this.lastCall);
  }
}

// Rate limits OpenRouter (rpm). Неизвестная модель — консервативные 20.
const MODEL_RPM = {
  'deepseek/deepseek-v3.2':          20,
  'deepseek/deepseek-v3.2-20251201': 20,
  'deepseek/deepseek-chat':          20,
  'openai/gpt-4o':                  500,
  'openai/gpt-4o-mini':             500,
  'anthropic/claude-haiku-4-5':      50,
  'anthropic/claude-3-haiku':        50,
  'google/gemini-2.5-flash-preview': 30,
  'google/gemini-flash-1.5':         60,
};
export const rpmFor = model => MODEL_RPM[model] || 20;

// ── ЦЕНЫ МОДЕЛИ ──────────────────────────────────────────────
/** Тариф выбранной модели с OpenRouter — резерв, если ответ не вернул usage.cost. */
export async function fetchModelPricing(model, apiKey) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal:  AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const { data } = await res.json();
    const m = (data || []).find(x => x.id === model);
    if (!m?.pricing) return null;
    return {
      prompt:     parseFloat(m.pricing.prompt) || 0,      // $ за токен
      completion: parseFloat(m.pricing.completion) || 0,
    };
  } catch {
    return null;
  }
}

// ── ЗАПРОС К OPENROUTER ──────────────────────────────────────
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 524]);

/** Сколько ждать по заголовкам ответа. Провайдер знает это точнее нас. */
function retryAfterMs(res) {
  const ra = res.headers.get('retry-after');
  if (ra) {
    const sec = Number(ra);
    if (Number.isFinite(sec)) return Math.min(60_000, Math.max(0, sec * 1000));
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.min(60_000, Math.max(0, at - Date.now()));
  }
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    // Заголовок приходит и в миллисекундах epoch, и в секундах epoch.
    const ms = (reset > 1e12 ? reset : reset * 1000) - Date.now();
    if (ms > 0) return Math.min(60_000, ms);
  }
  return null;
}

/**
 * Один товар → обогащённая запись. Ретраит только то, что имеет смысл повторять.
 * Токены и стоимость суммируются по всем попыткам: ретрай — это оплаченный
 * запрос, и отчёт, показывающий только последнюю попытку, занижает расход.
 * Возвращает { enriched, iT, oT, cost, costSource, attempts }. При провале
 * бросает ошибку с полем .usage — потраченное на неудачные попытки.
 */
export async function enrichProduct(product, opts) {
  const {
    model, apiKey, limiter, pricing = null, schema = DEFAULT_SCHEMA,
    maxRetries = 3, maxTokens = 2500, timeoutMs = 60_000,
    onNote = () => {}, referer = 'https://mrmag.ru', title = 'mrmag enricher',
  } = opts;

  const src = sourceText(product);
  const facts = extractFacts(src, schema);
  const userContent = buildUserContent(product, facts);
  let tokenBudget = maxTokens;
  let lastErr;

  let iT = 0, oT = 0, cost = 0, costSource = 'нет данных';
  const usage = () => ({ iT, oT, cost: costSource === 'нет данных' ? null : cost });
  // Ошибку отдаём вместе с тем, что уже потрачено, — иначе расход теряется.
  const fail = e => { e.usage = usage(); throw e; };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await limiter.wait(ms => onNote(`rate limit ${ms}ms`));

    let res, data;
    try {
      res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method:  'POST',
        headers: {
          Authorization:    `Bearer ${apiKey}`,
          'Content-Type':   'application/json',
          'HTTP-Referer':   referer,
          'X-Title':        title,
        },
        body:   JSON.stringify(buildRequestBody(model, userContent, tokenBudget, schema)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // Таймаут и сетевой сбой — имеет смысл повторить.
      lastErr = new Error(e.name === 'TimeoutError' ? `таймаут ${timeoutMs}ms` : netError(e));
      if (attempt < maxRetries) { onNote(`сеть, retry ${attempt}`); await sleep(attempt * 3000); continue; }
      fail(lastErr);
    }

    // Шлюз может ответить HTML — читаем текстом, чтобы res.json() не съел ошибку.
    const bodyText = await res.text();
    try { data = JSON.parse(bodyText); } catch { data = null; }

    if (!res.ok || data?.error) {
      const code = data?.error?.code ?? res.status;
      const msg  = data?.error?.message || `HTTP ${res.status}: ${bodyText.slice(0, 120)}`;
      lastErr = new Error(msg);
      if (attempt < maxRetries && RETRYABLE.has(Number(code))) {
        const wait = retryAfterMs(res) ?? attempt * 4000;
        onNote(`${code}, retry ${attempt}, ${wait}ms`);
        await sleep(wait);
        continue;
      }
      fail(lastErr);
    }

    const choice = data?.choices?.[0];
    if (!choice) {
      lastErr = new Error('Нет choices в ответе');
      if (attempt < maxRetries) { onNote(`пустой ответ, retry ${attempt}`); await sleep(attempt * 5000); continue; }
      fail(lastErr);
    }

    const inTok  = data.usage?.prompt_tokens     ?? 0;
    const outTok = data.usage?.completion_tokens ?? 0;
    iT += inTok;
    oT += outTok;
    if (typeof data.usage?.cost === 'number') {
      cost += data.usage.cost;
      costSource = 'openrouter';           // фактический счёт от OpenRouter
    } else if (pricing) {
      cost += inTok * pricing.prompt + outTok * pricing.completion;
      if (costSource === 'нет данных') costSource = 'тариф модели';
    }

    // Обрыв по длине — детерминированная ошибка: повтор с тем же лимитом бессмыслен.
    if (choice.finish_reason === 'length') {
      if (attempt < maxRetries && tokenBudget < 8000) {
        tokenBudget = Math.min(8000, tokenBudget * 2);
        onNote(`обрыв по длине, max_tokens→${tokenBudget}`);
        continue;
      }
      fail(new Error(`Ответ обрезан на max_tokens=${tokenBudget}`));
    }

    let enriched;
    try {
      enriched = normalizeResponse(parseResponse(choice.message?.content ?? ''), src, schema);
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) { onNote(`parse err, retry ${attempt}`); await sleep(2000); continue; }
      fail(err);
    }

    return { enriched, ...usage(), costSource, attempts: attempt };
  }

  fail(lastErr || new Error('Не удалось обогатить'));
}
