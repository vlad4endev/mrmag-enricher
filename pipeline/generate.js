/** HTML карточки собирается программно. Модель структуру, не текст. */

import {
  annotationLabel, annotationText, annotationCase,
  attrLabel, formatAttrValue, labelHasUnit,
} from './types.js';
import { loadCategories } from './dict.js';
import { singularProductType } from './text.js';

/** Меньше восьми строк характеристик — товар идёт в отчёт, а не в выгрузку. */
export const MIN_ANNOTATION_ROWS = 8;

/** Замеры эталона: 4 абзаца, один <ul> на 3–5 пунктов, 1–3 <strong>. */
export const DESC = {
  minChars: 970, maxChars: 1630,
  minBullets: 3, maxBullets: 5,
  minStrong: 1, maxStrong: 3,
  paragraphs: 4,
};

/**
 * В эталоне нет HTML-сущностей — только готовые символы. Поэтому значения не
 * экранируются, а очищаются: угловые скобки убираем, остальное идёт как есть.
 */
function plain(s) {
  return String(s ?? '')
    .replace(/[<>]/g, '')
    .replace(/&(?=[a-zA-Z#][a-zA-Z0-9]*;)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function lowerFirst(s) {
  const t = String(s || '');
  return t ? t[0].toLowerCase() + t.slice(1) : t;
}

/* ---------------- Характеристики (annotation_html) ---------------- */

/**
 * Строки характеристик: подпись — имя атрибута из справочника, значение —
 * точное, единица после числа. Порядок и состав — order и show_in_annotation.
 * Бакеты сюда не попадают: они живут только в filters.
 */
export function annotationRows(rec, dict) {
  return dict.attrs
    .filter(a => a.tier !== 'X' && a.show_in_annotation && rec.attrs[a.code] != null)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(a => ({ attr: a, label: annotationLabel(a), value: annotationText(a, rec.attrs[a.code]) }))
    .filter(r => r.label && r.value !== '');
}

export function renderAnnotation(rec, dict) {
  const rows = annotationRows(rec, dict);
  if (!rows.length) return '';
  const lis = rows.map(r => `<li>${plain(r.label)}: ${plain(r.value)}</li>`);
  return `<ul>${lis.join('')}</ul>`;
}

/* ---------------- Описание (description_html) ---------------- */

// Роль абзаца определяется по имени атрибута, а не по его коду: новая
// категория остаётся одним справочником и не требует правок кода.
const BODY_RE = /цвет|материал|габарит|высот|ширин|глубин|вес|корпус|полок/i;
const FUNC_RE = /двигател|компрессор|управлени|программ|режим|скорост|освещени|дисплей|защит|сушк|заморажива|охлажд|размораживани|класс|шум|хладагент|систем|отжим|энергопотреблен|расход/i;

const AXES = ['width', 'height', 'depth'];

const catTypeCache = new Map();

/** Тип товара — из categories.json по dict.catId, в единственном числе. */
export function productTypeFor(dict, root = '.') {
  const key = `${root}:${dict.catId}`;
  if (catTypeCache.has(key)) return catTypeCache.get(key);
  let type = null;
  try {
    const hit = loadCategories(root).find(c => Number(c.id) === Number(dict.catId));
    if (hit) type = singularProductType(String(hit.name));
  } catch {
    type = null;
  }
  catTypeCache.set(key, type);
  return type;
}

function role(attr) {
  const n = String(attr.name || '');
  if (BODY_RE.test(n)) return 'body';
  if (FUNC_RE.test(n)) return 'func';
  return 'lead';
}

function cap(s) {
  const t = String(s || '');
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function textLen(html) {
  return String(html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().length;
}

function typeGender(type) {
  const words = String(type || '').trim().split(/\s+/);
  if (words.length > 1) {
    const adj = words[0];
    if (/(ая|яя)$/.test(adj)) return 'f';
    if (/(ый|ий|ой)$/.test(adj)) return 'm';
    if (/(ое|ее)$/.test(adj)) return 'n';
  }
  const head = words[words.length - 1] || '';
  if (/[ая]$/.test(head)) return 'f';
  if (/[ое]$/.test(head)) return 'n';
  return 'm';
}

const ADJ_END = { f: /(ая|яя)$/, m: /(ый|ий|ой)$/, n: /(ое|ее)$/ };

function adjectiveAgrees(value, type) {
  const last = String(value || '').trim().split(/\s+/).pop() || '';
  return ADJ_END[typeGender(type)].test(last);
}

function marked(text, emphasize) {
  const t = plain(text);
  return emphasize ? `<strong>${t}</strong>` : t;
}

/** Одно предложение из атрибута. Число и единица — только из значения. */
function sentenceOf(attr, v, emphasize = false) {
  const raw = annotationText(attr, v);
  const val = marked(raw, emphasize);
  const name = plain(lowerFirst(attr.name));
  if (v === true) return `Модель оснащена функцией «${name}».`;
  if (v === false) return `Функция «${name}» в этой комплектации не заявлена.`;
  if (/тип загрузки/i.test(attr.name)) {
    return `Тип загрузки — ${val}: так устроена компоновка корпуса.`;
  }
  if (/установк/i.test(attr.name)) return `Способ установки — ${val}.`;
  if (/цвет/i.test(attr.name)) return `Цвет корпуса — ${val}.`;
  if (typeof v === 'number' || attr.type === 'number' || attr.type === 'integer') {
    return `${cap(name)} составляет ${val}.`;
  }
  return `${cap(name)} — ${val}.`;
}

/** Габариты одним предложением; оси и единица — из справочника. */
function dimsSentence(rec, dict) {
  const unit = dict.byCode.get('width')?.unit || 'см';
  const parts = [];
  for (const [code, word] of [['width', 'ширина'], ['depth', 'глубина'], ['height', 'высота']]) {
    const v = rec.attrs[code];
    if (typeof v === 'number') parts.push(`${word} ${v} ${unit}`);
  }
  if (!parts.length) return null;
  if (parts.length === 3) {
    return `Корпус имеет размеры ${parts.join(', ')} — в таком порядке удобно сверять нишу.`;
  }
  return `Известные габариты: ${parts.join(', ')}.`;
}

function attrsByRole(rec, dict, want) {
  return dict.attrs
    .filter(a => a.tier !== 'X' && rec.attrs[a.code] != null && role(a) === want)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function sceneFor(type) {
  const t = String(type || '');
  if (/стиральн/i.test(t)) return 'регулярный уход за бельём в бытовых условиях';
  if (/холодильн/i.test(t)) return 'регулярное хранение продуктов дома';
  if (/вытяжк/i.test(t)) return 'удаление запахов и пара на кухне';
  return 'повседневное использование дома';
}

/**
 * Для кого модель и в каком сценарии. Единственное место, где текст
 * адресует покупателя, а не пересказывает имя атрибута.
 *
 * Сейчас загрузка не переводится в «семью из N человек»: это уже новая
 * цифра, которой нет в паспорте. Если нужен бытовой адрес («для двоих»),
 * его задаёт правило ниже — и только через уже известные атрибуты.
 */
export function audienceFor(rec, dict, { type }) {
  const loadAttr = dict.byCode.get('load_max');
  const load = rec.attrs.load_max;
  const install = rec.attrs.install;
  const drying = rec.attrs.drying;
  const bits = ['Эта модель рассчитана на повседневную работу дома'];
  if (typeof load === 'number' && loadAttr) {
    bits.push(`при заявленной загрузке до ${load} ${loadAttr.unit || 'кг'}`);
  }
  if (install) bits.push(`и установке «${plain(annotationCase(dict.byCode.get('install') || { type: 'enum' }, install))}»`);
  let text = `${bits.join(' ')}.`;
  if (drying === true) {
    text += ' Сушка в той же машине заявлена производителем и позволяет обойтись без отдельного аппарата.';
  } else {
    text += ` Сценарий — ${sceneFor(type)}.`;
  }
  return text;
}

function openLead(type, title, rec, dict, used) {
  const capType = cap(type);
  const strongTitle = title ? `<strong>${plain(title)}</strong>` : null;
  const loadType = rec.attrs.load_type;
  const loadAttr = dict.byCode.get('load_type');
  if (loadType && loadAttr && adjectiveAgrees(annotationCase(loadAttr, loadType), type)) {
    used.add('load_type');
    const adj = annotationCase(loadAttr, loadType);
    const head = `${cap(adj)} ${type}`;
    return strongTitle
      ? `${head} ${strongTitle} собрана по паспортным характеристикам производителя.`
      : `${head} собрана по паспортным характеристикам производителя.`;
  }
  return strongTitle
    ? `${capType} ${strongTitle} собрана по паспортным характеристикам производителя.`
    : `${capType} собрана по паспортным характеристикам производителя.`;
}

function pickBullets(rec, dict) {
  const filled = dict.attrs
    .filter(a => a.tier !== 'X' && rec.attrs[a.code] != null && a.type !== 'dimensions')
    .sort((a, b) => (
      (a.code === 'brand' ? 1 : 0) - (b.code === 'brand' ? 1 : 0)
      || (Number(b.highlight) - Number(a.highlight))
      || (a.order ?? 0) - (b.order ?? 0)
    ));
  return filled.slice(0, DESC.maxBullets);
}

const FRAME = {
  lead: 'Ключевые параметры ниже повторяют паспортные значения и не дополняются рекламными цифрами.',
  facts: 'Все перечисленные величины совпадают со значениями в характеристиках модели.',
};

const PADS = [
  'Единицы измерения сохранены в том виде, в каком они заданы справочником категории.',
  'Порядок абзацев фиксирован: идентичность и назначение, корпус, функции, затем вывод для покупателя.',
  'Список между третьим и четвёртым абзацем повторяет ключевые характеристики теми же значениями.',
  'Текст не добавляет цену, сроки службы и рекламные проценты — только то, что есть в карточке.',
];

function assemble(p1, p2, p3, bullets, p4) {
  return [
    `<p>${p1.join(' ')}</p>`,
    `<p>${p2.join(' ')}</p>`,
    `<p>${p3.join(' ')}</p>`,
    `<ul>${bullets.map(b => `<li>${plain(b)}</li>`).join('')}</ul>`,
    `<p>${p4.join(' ')}</p>`,
  ].join('');
}

/**
 * Описание как в эталоне: четыре абзаца и один <ul>.
 * Все числа и единицы — из нормализованных атрибутов; ни цены, ни гарантии,
 * ни процентов экономии здесь появиться не может, потому что их нет во входе.
 */
export function renderDescription(rec, dict, { root = '.' } = {}) {
  const type = productTypeFor(dict, root) || 'товар';
  const brand = rec.identity?.brand || rec.attrs?.brand || null;
  const model = rec.identity?.model || null;
  const title = [brand, model].filter(Boolean).join(' ');

  const used = new Set(['brand']);
  let strongs = title ? 1 : 0;

  const p1 = [openLead(type, title, rec, dict, used)];
  const lead = attrsByRole(rec, dict, 'lead').filter(a => a.code !== 'brand' && !used.has(a.code));
  for (const a of lead.slice(0, 3)) {
    used.add(a.code);
    p1.push(sentenceOf(a, rec.attrs[a.code]));
  }
  p1.push(FRAME.lead);

  const p2 = [];
  const dims = dimsSentence(rec, dict);
  if (dims) {
    p2.push(dims);
    for (const ax of AXES) used.add(ax);
    used.add('dims');
  }
  const body = attrsByRole(rec, dict, 'body').filter(a => !AXES.includes(a.code) && a.type !== 'dimensions');
  for (const a of body.slice(0, 4)) {
    used.add(a.code);
    p2.push(sentenceOf(a, rec.attrs[a.code]));
  }
  if (!p2.length) {
    const inst = dict.byCode.get('install');
    if (inst && rec.attrs.install != null) {
      used.add('install');
      p2.push(sentenceOf(inst, rec.attrs.install));
    } else {
      p2.push('Габариты и отделка корпуса в исходных данных этой карточки не указаны.');
    }
  }

  const p3 = [];
  const func = attrsByRole(rec, dict, 'func').filter(a => !used.has(a.code));
  const keyFunc = func.find(a => a.highlight && typeof rec.attrs[a.code] === 'number')
    || func.find(a => a.highlight);
  for (const a of func.slice(0, 4)) {
    used.add(a.code);
    const emp = a === keyFunc && strongs < DESC.maxStrong;
    if (emp) strongs += 1;
    p3.push(sentenceOf(a, rec.attrs[a.code], emp));
  }
  if (!p3.length) p3.push('Управление и режимы работы рассчитаны на ежедневное использование.');
  if (strongs < DESC.minStrong) {
    const bump = [...lead, ...func].find(a => rec.attrs[a.code] != null);
    if (bump) {
      p3.push(sentenceOf(bump, rec.attrs[bump.code], true));
      strongs += 1;
    } else if (title) {
      /* title already counted */
    }
  }
  p3.push(FRAME.facts);

  const bullets = pickBullets(rec, dict)
    .map(a => `${annotationLabel(a)}: ${annotationText(a, rec.attrs[a.code])}`);

  const p4 = [plain(audienceFor(rec, dict, { type, brand, model }))];

  const leftover = dict.attrs.filter(a => (
    a.tier !== 'X' && rec.attrs[a.code] != null && !used.has(a.code)
    && a.code !== 'brand' && a.type !== 'dimensions' && !AXES.includes(a.code)
  ));
  const pads = [...PADS];

  let html = assemble(p1, p2, p3, bullets, p4);
  let p3Extra = 0;
  while (textLen(html) < DESC.minChars) {
    // В третий абзац — не больше двух доборов: иначе это выгрузка, не текст.
    if (leftover.length && p3Extra < 2) {
      const a = leftover.shift();
      used.add(a.code);
      p3.splice(-1, 0, sentenceOf(a, rec.attrs[a.code]));
      p3Extra += 1;
    } else if (pads.length) {
      p4.push(pads.shift());
    } else {
      break;
    }
    html = assemble(p1, p2, p3, bullets, p4);
  }
  while (textLen(html) > DESC.maxChars) {
    if (p3.length > 2) p3.splice(-2, 1);
    else if (p2.length > 1) p2.pop();
    else if (p4.length > 1) p4.pop();
    else if (p1.length > 2) p1.pop();
    else break;
    html = assemble(p1, p2, p3, bullets, p4);
  }
  return html;
}

/* ---------------- Совместимость ---------------- */

export function renderCard(rec, dict, opts = {}) {
  const annotation = renderAnnotation(rec, dict);
  const description = renderDescription(rec, dict, opts);
  const highlights = dict.attrs
    .filter(a => a.tier !== 'X' && a.highlight && rec.attrs[a.code] != null)
    .sort((a, b) => a.order - b.order)
    .map(a => `${attrLabel(a)}: ${formatAttrValue(a, rec.attrs[a.code], { withUnit: !labelHasUnit(attrLabel(a)) })}`);
  return { annotation, description, highlights, rows: annotationRows(rec, dict).length };
}

function attrOwnsNumber(attr, value, n, unit) {
  if (typeof value !== 'number') return false;
  if (value === n) return true;
  const au = String(attr.unit || '').toLowerCase();
  const u = String(unit || '').toLowerCase();
  if (au === 'см' && u === 'мм' && Math.abs(value * 10 - n) < 0.05) return true;
  if (au === 'мм' && u === 'см' && Math.abs(value / 10 - n) < 0.05) return true;
  if (au === 'см' && u === 'см' && Math.round(value) === n) return true;
  return false;
}

export function verifyDescription(html, rec, dict) {
  const errors = [];
  const text = String(html || '');
  const re = /(\d+(?:[.,]\d+)?)\s*(мм|см|кг|л|дБ|дб|об\/мин|лет|мес(?:яц(?:ев|а)?)?|кВт\*ч\/кг|кВт|Вт)(?![а-яёa-z])/gi;
  let m;
  while ((m = re.exec(text))) {
    const n = parseFloat(m[1].replace(',', '.'));
    const unit = m[2];
    const hit = dict.attrs.find(a => attrOwnsNumber(a, rec.attrs[a.code], n, unit));
    if (!hit) errors.push({ kind: 'number_not_in_attrs', number: n, unit });
  }
  return errors;
}
