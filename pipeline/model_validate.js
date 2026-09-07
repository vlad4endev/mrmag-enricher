import { cardProseSpecIssues } from './prose_align.js';

/**
 * Контракт ответа модели и строгая валидация.
 * Пустая строка вместо null — ошибка. Лишние ключи — ошибка схемы.
 * Режим бедных данных: <5 specs + description 400–700 в 2 абзацах — допустим.
 *
 * Лимиты чуть мягче промпта: deepseek часто даёт 940–949 / 95–99 /
 * 6 bullets при почти правильном содержании — иначе лишний retry и needs_review.
 */

export const MODEL_KEYS = Object.freeze([
  'specs',
  'short_description',
  'description',
  'bullets',
  'strong',
  'meta_keywords',
  'web_info',
]);

const MODEL_KEY_SET = new Set(MODEL_KEYS);
const HTML_RE = /<\/?[a-zA-Z][^>]*>/;
const RICH_SPECS = 5;

export const SHORT_MIN = 95;
export const SHORT_MAX = 200;
export const DESCR_RICH_MIN = 900;
export const DESCR_RICH_MAX = 1600;
export const DESCR_POOR_MIN = 400;
export const DESCR_POOR_MAX = 700;
export const BULLET_COUNT_MAX = 5;
export const BULLET_MAX = 120;
export const STRONG_COUNT_MAX = 3;
export const META_PHRASE_MAX = 9;

function hasHtml(v) {
  if (typeof v === 'string') return HTML_RE.test(v);
  if (Array.isArray(v)) return v.some(hasHtml);
  if (v && typeof v === 'object') return Object.values(v).some(hasHtml);
  return false;
}

function emptyStringSomewhere(v, path = '') {
  const hits = [];
  if (v === '') hits.push(path || '(root)');
  else if (Array.isArray(v)) {
    v.forEach((x, i) => hits.push(...emptyStringSomewhere(x, `${path}[${i}]`)));
  } else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      hits.push(...emptyStringSomewhere(val, path ? `${path}.${k}` : k));
    }
  }
  return hits;
}

export function paragraphs(text) {
  return String(text || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
}

function phraseCount(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean).length;
}

function sentenceCount(s) {
  return (String(s || '').match(/[.!?…]/g) || []).length;
}

function firstSentence(s) {
  const t = String(s || '').trim();
  const m = t.match(/^[\s\S]*?[.!?…](?=\s|$)/);
  return (m ? m[0] : t).trim();
}

export function isPoorDataCard(card, filledSpecs) {
  const n = filledSpecs ?? (card?.specs && typeof card.specs === 'object'
    ? Object.values(card.specs).filter(v => v != null && v !== '').length
    : 0);
  return n < RICH_SPECS;
}

/**
 * Мягкая правка карточки до валидации: обрезка bullets/strong/meta,
 * одно предложение в short, укорачивание слишком длинного description.
 * Не дописывает текст — короткие поля остаются на retry/needs_review.
 * Мутирует card, возвращает тот же объект.
 */
export function softFixCardTexts(card, opts = {}) {
  if (!card || typeof card !== 'object') return card;
  const poor = opts.poorData === true || isPoorDataCard(card, opts.filledSpecs);
  const dMin = poor ? DESCR_POOR_MIN : DESCR_RICH_MIN;
  const dMax = poor ? DESCR_POOR_MAX : DESCR_RICH_MAX;
  const wantParas = poor ? 2 : 4;

  if (Array.isArray(card.bullets) && card.bullets.length > BULLET_COUNT_MAX) {
    card.bullets = card.bullets.slice(0, BULLET_COUNT_MAX);
  }
  if (Array.isArray(card.strong) && card.strong.length > STRONG_COUNT_MAX) {
    card.strong = card.strong.slice(0, STRONG_COUNT_MAX);
  }
  if (typeof card.meta_keywords === 'string') {
    const phrases = card.meta_keywords.split(',').map(x => x.trim()).filter(Boolean);
    if (phrases.length > META_PHRASE_MAX) {
      card.meta_keywords = phrases.slice(0, META_PHRASE_MAX).join(', ');
    }
  }

  if (typeof card.short_description === 'string' && card.short_description.trim()) {
    let s = card.short_description.trim();
    if (sentenceCount(s) > 1) s = firstSentence(s);
    if (s.length > SHORT_MAX) {
      const cut = s.slice(0, SHORT_MAX);
      const sp = cut.lastIndexOf(' ');
      s = (sp > SHORT_MIN ? cut.slice(0, sp) : cut).trim();
      if (!/[.!?…]$/.test(s)) s = `${s}.`;
    }
    card.short_description = s;
  }

  if (typeof card.description === 'string' && card.description.trim()) {
    let paras = paragraphs(card.description);
    if (paras.length > wantParas) paras = paras.slice(0, wantParas);
    let desc = paras.join('\n\n');
    if (desc.length > dMax) {
      while (desc.length > dMax && paras.length > 1) {
        paras = paras.slice(0, -1);
        desc = paras.join('\n\n');
      }
      if (desc.length > dMax) {
        const cut = desc.slice(0, dMax);
        const sp = cut.lastIndexOf(' ');
        desc = (sp > dMin ? cut.slice(0, sp) : cut).trim();
        if (!/[.!?…]$/.test(desc)) desc = `${desc}.`;
      }
    }
    card.description = desc;
  }

  return card;
}

/**
 * Дословное вхождение без учёта регистра (кириллица: «Гарантия» ↔ «гарантия»).
 * Возвращает срез из haystack с исходным регистром — так <strong> потом совпадёт.
 */
export function matchLiteral(haystack, needle) {
  const h = String(haystack || '');
  const n = String(needle || '');
  if (!n) return '';
  const hi = h.toLocaleLowerCase('ru');
  const ni = n.toLocaleLowerCase('ru');
  const at = hi.indexOf(ni);
  if (at < 0) return null;
  return h.slice(at, at + n.length);
}

/**
 * @param {object} data — сырой/нормализованный ответ модели
 * @param {{ filledSpecs?: number, requireSpecFill?: boolean, checkProseSpecs?: boolean }} opts
 * @returns {{ field: string, reason: string }[]}
 */
export function validateModelResponse(data, opts = {}) {
  const issues = [];
  const add = (field, reason) => issues.push({ field, reason });

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    add('schema', 'ответ не объект');
    return issues;
  }

  for (const k of Object.keys(data)) {
    if (!MODEL_KEY_SET.has(k)) add(k, 'лишний ключ сверх контракта');
  }

  for (const hit of emptyStringSomewhere(data)) {
    add(hit, 'пустая строка вместо null');
  }

  if (hasHtml(data)) add('html', 'HTML-теги не допускаются');

  if (!('specs' in data) || data.specs == null || typeof data.specs !== 'object' || Array.isArray(data.specs)) {
    add('specs', 'отсутствует или не объект');
  } else {
    const filled = opts.filledSpecs ?? Object.values(data.specs).filter(v => v != null && v !== '').length;
    if (Object.keys(data.specs).length > 0 && filled === 0 && opts.requireSpecFill) {
      add('specs', 'не заполнен ни один ключ при непустом исходнике');
    }
  }

  const filledSpecs = opts.filledSpecs
    ?? (data.specs && typeof data.specs === 'object'
      ? Object.values(data.specs).filter(v => v != null && v !== '').length
      : 0);
  const poorData = filledSpecs < RICH_SPECS;

  const short = data.short_description;
  if (typeof short !== 'string' || !short.trim()) {
    add('short_description', 'обязательное непустое поле');
  } else {
    const len = short.trim().length;
    if (len < SHORT_MIN || len > SHORT_MAX) {
      add('short_description', `${len} симв., нужно ${SHORT_MIN}–${SHORT_MAX}`);
    }
    if (sentenceCount(short) > 1) {
      add('short_description', 'должно быть одно предложение');
    }
  }

  const desc = data.description;
  if (typeof desc !== 'string' || !desc.trim()) {
    add('description', 'обязательное непустое поле');
  } else {
    const len = desc.trim().length;
    const paras = paragraphs(desc);
    if (poorData) {
      if (len < DESCR_POOR_MIN || len > DESCR_POOR_MAX) {
        add('description', `${len} симв., при бедных данных нужно ${DESCR_POOR_MIN}–${DESCR_POOR_MAX}`);
      }
      if (paras.length !== 2) add('description', `${paras.length} абзацев, при бедных данных нужно 2`);
    } else {
      if (len < DESCR_RICH_MIN || len > DESCR_RICH_MAX) {
        add('description', `${len} симв., нужно ${DESCR_RICH_MIN}–${DESCR_RICH_MAX}`);
      }
      if (paras.length !== 4) add('description', `${paras.length} абзацев, нужно ровно 4 через \\n\\n`);
    }
  }

  if (!Array.isArray(data.bullets)) {
    add('bullets', 'должен быть массив');
  } else {
    const n = data.bullets.length;
    if (n < 3 || n > BULLET_COUNT_MAX) add('bullets', `${n} элементов, нужно 3–${BULLET_COUNT_MAX}`);
    data.bullets.forEach((b, i) => {
      if (typeof b !== 'string') add(`bullets[${i}]`, 'не строка');
      else if (b.trim().length > BULLET_MAX) {
        add(`bullets[${i}]`, `${b.trim().length} симв., максимум ${BULLET_MAX}`);
      }
    });
  }

  const mk = data.meta_keywords;
  if (typeof mk !== 'string' || !mk.trim()) {
    add('meta_keywords', 'обязательное непустое поле');
  } else {
    const n = phraseCount(mk);
    if (n < 7 || n > META_PHRASE_MAX) {
      add('meta_keywords', `${n} фраз, нужно 7–${META_PHRASE_MAX} через запятую`);
    }
  }

  if (data.strong != null) {
    if (!Array.isArray(data.strong)) {
      add('strong', 'должен быть массивом или отсутствовать');
    } else if (data.strong.length > STRONG_COUNT_MAX) {
      add('strong', `${data.strong.length} элементов, максимум ${STRONG_COUNT_MAX}`);
    } else {
      const body = typeof desc === 'string' ? desc : '';
      data.strong.forEach((s, i) => {
        if (typeof s !== 'string') add(`strong[${i}]`, 'не строка');
        else if (s && matchLiteral(body, s) == null) {
          add(`strong[${i}]`, 'не встречается в description дословно');
        }
      });
    }
  }

  if (data.web_info != null) {
    if (typeof data.web_info !== 'string') {
      add('web_info', 'должна быть строка или null');
    } else {
      const len = data.web_info.trim().length;
      if (len < 300 || len > 700) add('web_info', `${len} симв., нужно 300–700 либо null`);
    }
  }

  if (opts.checkProseSpecs !== false && data.specs && typeof data.specs === 'object') {
    for (const m of cardProseSpecIssues(data, data.specs)) {
      add(m.field, m.reason);
    }
  }

  return issues;
}

/**
 * Текст для второй попытки: только упавшие поля, с явной инструкцией
 * (не «сократи description», когда нужно дописать; не добавляй 6-й bullet).
 */
export function validationFeedbackLine(issues, opts = {}) {
  if (!issues?.length) return '';
  const poor = opts.poorData === true;
  const dMin = poor ? DESCR_POOR_MIN : DESCR_RICH_MIN;
  const dMax = poor ? DESCR_POOR_MAX : DESCR_RICH_MAX;
  const wantParas = poor ? 2 : 4;

  const parts = issues.map(({ field, reason }) => {
    if (field === 'short_description') {
      if (/одно предложение/i.test(reason)) {
        return 'short_description: ровно ОДНО предложение (одна точка в конце), без второго предложения';
      }
      if (/симв/i.test(reason)) {
        return `short_description: длина строго ${SHORT_MIN}–${SHORT_MAX} символов (сейчас ${reason})`;
      }
    }
    if (field === 'description') {
      if (/абзац/i.test(reason)) {
        return `description: ровно ${wantParas} абзаца через пустую строку (\\n\\n), без лишних`;
      }
      if (/симв/i.test(reason)) {
        const tooShort = /\d+/.test(reason) && Number(reason.match(/^(\d+)/)?.[1]) < dMin;
        return tooShort
          ? `description: ДОПИШИ до ${dMin}–${dMax} символов (${wantParas} абзаца) — сейчас слишком коротко (${reason}). Не сокращай.`
          : `description: уложи в ${dMin}–${dMax} символов (${wantParas} абзаца) — сейчас ${reason}`;
      }
    }
    if (field === 'bullets' && /элемент/i.test(reason)) {
      return `bullets: ровно 3–${BULLET_COUNT_MAX} пунктов (не больше ${BULLET_COUNT_MAX})`;
    }
    if (field === 'strong' && /максимум|элемент/i.test(reason)) {
      return `strong: не больше ${STRONG_COUNT_MAX} фрагментов, каждый дословно из description`;
    }
    if (field === 'meta_keywords' && /фраз/i.test(reason)) {
      return `meta_keywords: 7–${META_PHRASE_MAX} фраз через запятую`;
    }
    if (/пусто|обязательн/i.test(reason)) {
      return `поле ${field} оказалось пустым или отсутствует (${reason})`;
    }
    return `поле ${field}: ${reason}`;
  });
  return `В предыдущем ответе ${parts.join('; ')}. Исправь ТОЛЬКО эти поля, остальное не ломай, верни полный JSON.`;
}

/**
 * Третий проход: расхождения с источником и/или «на проверку».
 * Модель сверяет дамп + annotation/description и возвращает полный JSON
 * до перехода к следующему товару.
 */
export function sourceCorrectionFeedback({ warnings = [], issues = [], hasDump = false } = {}) {
  const parts = [];
  if (warnings.length) {
    const list = warnings.map((w) => {
      const src = w.source != null ? `, в источнике должно быть ${JSON.stringify(w.source)}` : '';
      return `${w.field}: модель дала ${JSON.stringify(w.model)}${src} (${w.note || 'не совпало с текстом'})`;
    }).join('; ');
    parts.push(
      `Расхождения с текстом источника: ${list}. Возьми значение из дампа/annotation/description/facts, поправь specs И те же цифры в short_description, description и bullets.`,
    );
  }
  if (issues.length) {
    const line = validationFeedbackLine(issues);
    if (line) parts.push(line);
  }
  const dumpHint = hasDump
    ? ' В поле dump — исходная карточка заказчика: каждый спорный факт сверь с dump.annotation и dump.description.'
    : ' Сверь спорные поля с annotation, description, attributes и facts.';
  const head = warnings.length && issues.length
    ? 'Карточка с расхождениями и ошибками валидации — в выгрузку v2 не попадёт, пока не исправишь.'
    : issues.length
      ? 'Карточка «на проверку» — в выгрузку v2 не попадёт, пока не исправишь валидацию.'
      : 'Есть расхождения с текстом источника — приведи карточку в соответствие до следующего товара.';
  return `${head}${dumpHint} ${parts.join(' ')} Верни полный JSON. Не выдумывай значения, которых нет в источнике.`.trim();
}

/**
 * description + bullets + strong → description_html эталона.
 * Порядок: p1, p2, p3, <ul>, p4. Без <h1>.
 */
export function buildDescriptionHtml({ description, bullets, strong } = {}) {
  const paras = paragraphs(description);
  const marks = (Array.isArray(strong) ? strong : [])
    .filter(s => typeof s === 'string' && s.trim())
    .sort((a, b) => b.length - a.length);

  const wrapStrong = (text) => {
    let out = String(text || '');
    for (const m of marks) {
      const hit = matchLiteral(out, m);
      if (hit == null) continue;
      out = out.split(hit).join(`<strong>${hit}</strong>`);
    }
    return out;
  };

  const pTags = paras.map(p => `<p>${wrapStrong(p)}</p>`);
  const lis = (Array.isArray(bullets) ? bullets : [])
    .map(b => String(b || '').trim())
    .filter(Boolean)
    .map(b => `<li>${b}</li>`);
  const ul = lis.length ? `<ul>${lis.join('')}</ul>` : '';

  if (pTags.length >= 4) {
    return [pTags[0], pTags[1], pTags[2], ul, pTags[3]].filter(Boolean).join('');
  }
  if (pTags.length === 2) {
    return [pTags[0], ul, pTags[1]].filter(Boolean).join('');
  }
  if (!pTags.length) return ul;
  return [...pTags.slice(0, -1), ul, pTags[pTags.length - 1]].filter(Boolean).join('');
}
