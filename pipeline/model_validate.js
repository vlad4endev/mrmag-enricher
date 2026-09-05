/**
 * Контракт ответа модели и строгая валидация.
 * Пустая строка вместо null — ошибка. Лишние ключи — ошибка схемы.
 * Режим бедных данных: <5 specs + description 400–700 в 2 абзацах — допустим.
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
 * @param {{ filledSpecs?: number, requireSpecFill?: boolean }} opts
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
    if (len < 120 || len > 200) add('short_description', `${len} симв., нужно 120–200`);
    if ((short.match(/[.!?…]/g) || []).length > 1) {
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
      if (len < 400 || len > 700) add('description', `${len} симв., при бедных данных нужно 400–700`);
      if (paras.length !== 2) add('description', `${paras.length} абзацев, при бедных данных нужно 2`);
    } else {
      if (len < 950 || len > 1600) add('description', `${len} симв., нужно 950–1600`);
      if (paras.length !== 4) add('description', `${paras.length} абзацев, нужно ровно 4 через \\n\\n`);
    }
  }

  if (!Array.isArray(data.bullets)) {
    add('bullets', 'должен быть массив');
  } else {
    const n = data.bullets.length;
    if (n < 3 || n > 5) add('bullets', `${n} элементов, нужно 3–5`);
    data.bullets.forEach((b, i) => {
      if (typeof b !== 'string') add(`bullets[${i}]`, 'не строка');
      else if (b.trim().length > 90) add(`bullets[${i}]`, `${b.trim().length} симв., максимум 90`);
    });
  }

  const mk = data.meta_keywords;
  if (typeof mk !== 'string' || !mk.trim()) {
    add('meta_keywords', 'обязательное непустое поле');
  } else {
    const n = phraseCount(mk);
    if (n < 7 || n > 9) add('meta_keywords', `${n} фраз, нужно 7–9 через запятую`);
  }

  if (data.strong != null) {
    if (!Array.isArray(data.strong)) {
      add('strong', 'должен быть массивом или отсутствовать');
    } else if (data.strong.length > 3) {
      add('strong', `${data.strong.length} элементов, максимум 3`);
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

  return issues;
}

/** Текст для второй попытки: перечень непройденных проверок. */
export function validationFeedbackLine(issues) {
  if (!issues?.length) return '';
  const parts = issues.map(({ field, reason }) => {
    if (/пусто|обязательн/i.test(reason)) {
      return `поле ${field} оказалось пустым или отсутствует (${reason})`;
    }
    return `поле ${field}: ${reason}`;
  });
  return `В предыдущем ответе ${parts.join('; ')}. Исправь эти поля и верни полный JSON по контракту.`;
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
