/**
 * Постобработка description_html ↔ annotation_html.
 * Источник истины — annotation (уже собранный HTML / словарь полей).
 * Ловит: (а) фабрикацию фактов без поля в annotation,
 *        (б) противоречие значениям annotation.
 * Промпт обогащения не трогаем — только механический ремонт.
 */

import { valueFold } from './types.js';

/** Темы из ТЗ: маркеры в прозе → подпись в annotation (null = поля нет в схеме). */
export const DESC_TOPICS = Object.freeze([
  {
    id: 'leak_protection',
    label: 'защита от протечек',
    annotationLabels: ['Защита от протечек', 'Защита от протечек воды'],
    /** В схеме 467 поля нет — любое утверждение = фабрикация. */
    schemaAbsent: true,
    topicRe: /защит[а-яё]*\s+от\s+протеч|протечк|aquastop|aquaprotect|аквастоп/i,
  },
  {
    id: 'child_lock',
    label: 'защита от детей',
    annotationLabels: ['Защита от детей'],
    topicRe: /защит[а-яё]*\s+от\s+детей|блокировк[а-яё]*\s+(?:панели|кнопок).{0,24}дет|child\s*lock/i,
  },
  {
    id: 'steam',
    label: 'функция пара',
    annotationLabels: ['Функция пара'],
    schemaAbsent: true,
    topicRe: /функци[а-яё]*\s+пара|(?:^|[^\wа-яё])пар(?:ом|а|у)?(?![а-яё])/i,
  },
  {
    id: 'wireless',
    label: 'беспроводное подключение',
    annotationLabels: ['Беспроводное подключение', 'Wi-Fi', 'WiFi'],
    schemaAbsent: true,
    topicRe: /беспроводн|wi-?fi|вай[\s-]?фай|bluetooth|блютуз/i,
  },
  {
    id: 'drum_material',
    label: 'материал барабана',
    annotationLabels: ['Материал барабана'],
    topicRe: /(?:материал\s+)?барабан|барабан[аеу]?\s*[-–—:]\s*(?:из\s+)?/i,
    material: true,
  },
  {
    id: 'tank_material',
    label: 'материал бака',
    annotationLabels: ['Материал бака'],
    topicRe: /(?:материал\s+)?бак[аеу](?![а-яё])|бак[аеу]?\s*[-–—:]\s*(?:из\s+)?/i,
    material: true,
  },
  {
    id: 'drying',
    label: 'сушка',
    annotationLabels: ['Сушка'],
    topicRe: /сушк/i,
  },
]);

const ASSERT_RE = /(?:не\s+)?(?:имеет|оснащен[аоы]?|предусмотрен[аоы]?|поддерживает)|отсутствует|(?:^|[^\wа-яё])(?:есть|нет)(?![а-яё])/i;

const MATERIAL_VALUE_RE = /(?:из\s+)?(нержавеющ(?:ей|ая)\s+стал[иь]|нержавейк[аи]|пластик[аеу]?|полипропилен[аеу]?|эмалированн(?:ой|ая)\s+стал[иь]|комбинированн(?:ый|ого))/i;

const BOOL_POS = /(?:^|[^\wа-яё])(?:есть|да|имеется|предусмотрен[аоы]?|поддерживает|оснащен[аоы]?)(?![а-яё])/i;
const BOOL_NEG = /(?:не\s+(?:имеет|оснащен[аоы]?|предусмотрен[аоы]?|поддерживает)|отсутствует|(?:^|[^\wа-яё])нет(?![а-яё]))/i;

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function fold(s) {
  return valueFold(s) || String(s || '').toLowerCase().replace(/ё/g, 'е').trim();
}

/**
 * Парсит annotation_html в словарь {подпись: значение}.
 * @param {string} html
 * @returns {Record<string, string>}
 */
export function parseAnnotationDict(html) {
  const out = {};
  const s = String(html || '');
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(s))) {
    const plain = stripHtml(m[1]);
    const sep = plain.match(/^([^:：\-–—]+)[:：\-–—]\s*(.+)$/);
    if (!sep) continue;
    const label = sep[1].trim();
    const value = sep[2].trim();
    if (label && value) out[label] = value;
  }
  // Без тегов: «Подпись: значение» по строкам.
  if (!Object.keys(out).length && s.trim()) {
    for (const line of stripHtml(s).split(/[;\n]+/)) {
      const sep = line.match(/^([^:：\-–—]+)[:：\-–—]\s*(.+)$/);
      if (!sep) continue;
      const label = sep[1].trim();
      const value = sep[2].trim();
      if (label && value) out[label] = value;
    }
  }
  return out;
}

function annotationValueFor(topic, dict) {
  if (topic.schemaAbsent) return null;
  for (const lab of topic.annotationLabels || []) {
    if (dict[lab] != null && String(dict[lab]).trim() !== '') return String(dict[lab]).trim();
  }
  // Case-insensitive lookup.
  const folded = Object.fromEntries(
    Object.entries(dict).map(([k, v]) => [fold(k), v]),
  );
  for (const lab of topic.annotationLabels || []) {
    const v = folded[fold(lab)];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

function hasTopicField(topic, dict) {
  if (topic.schemaAbsent) return false;
  return annotationValueFor(topic, dict) != null;
}

function extractMaterialClaim(sentence) {
  const m = sentence.match(MATERIAL_VALUE_RE);
  if (!m) return null;
  const raw = m[1].toLowerCase().replace(/ё/g, 'е');
  if (/нержав|stainless/.test(raw)) return 'нержавеющая сталь';
  if (/эмалир/.test(raw)) return 'эмалированная сталь';
  if (/комбинир/.test(raw)) return 'комбинированный';
  if (/пластик|полипропилен|pom/.test(raw)) return 'пластик';
  return fold(m[1]);
}

function extractBoolClaim(sentence) {
  if (BOOL_NEG.test(sentence)) return false;
  if (BOOL_POS.test(sentence)) return true;
  return null;
}

function isAssertive(sentence, topic) {
  if (ASSERT_RE.test(sentence)) return true;
  if (topic.material && MATERIAL_VALUE_RE.test(sentence) && topic.topicRe.test(sentence)) {
    return true;
  }
  // «барабан — из нержавеющей стали» без «имеет»
  if (topic.material && /барабан|бак[аеу]/.test(sentence) && MATERIAL_VALUE_RE.test(sentence)) {
    return true;
  }
  return false;
}

function sentenceMentionsTopic(sentence, topic) {
  if (!topic.topicRe.test(sentence)) return false;
  // «пар» слишком короткий — требуем функцию пара или «оснащена … паром»
  if (topic.id === 'steam') {
    return /функци[а-яё]*\s+пара|пар(?:ом|а)\b|оснащен[аоы]?.{0,40}пар/i.test(sentence);
  }
  // бак vs барабан: не путать
  if (topic.id === 'tank_material') {
    if (/барабан/i.test(sentence) && !/бак/i.test(sentence)) return false;
  }
  if (topic.id === 'drum_material') {
    if (/бак[аеу]/i.test(sentence) && !/барабан/i.test(sentence)) return false;
  }
  return true;
}

function valuesAgree(topic, claimed, annValue) {
  if (claimed == null || annValue == null) return true;
  const ann = fold(annValue);
  if (topic.material) {
    const claim = fold(claimed);
    const canon = (v) => {
      if (/нержав|stainless/.test(v)) return 'нержавеющая сталь';
      if (/эмалир/.test(v)) return 'эмалированная сталь';
      if (/комбинир/.test(v)) return 'комбинированный';
      if (/пластик|полипропилен|pom/.test(v)) return 'пластик';
      return v;
    };
    return canon(claim) === canon(ann);
  }
  // boolean-ish
  const annBool = /^(?:есть|да|true|имеется)$/i.test(annValue.trim())
    ? true
    : /^(?:нет|отсутствует|false)$/i.test(annValue.trim())
      ? false
      : null;
  if (typeof claimed === 'boolean' && annBool != null) return claimed === annBool;
  return fold(String(claimed)) === ann;
}

function splitSentences(text) {
  const s = String(text || '');
  if (!s.trim()) return [];
  const parts = s.split(/([.!?…]+\s*)/);
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    const body = parts[i] || '';
    const sep = parts[i + 1] || '';
    if (!body.trim() && !sep) continue;
    out.push({ body, sep, full: body + sep });
  }
  return out;
}

/**
 * Находит расхождения description vs annotation.
 * @returns {{ id?: *, topic: string, kind: 'fabrication'|'contradiction', said: string, annotation: string|null, sentence: string }[]}
 */
export function findDescAnnotationIssues(descriptionHtml, annotationHtml, { id = null } = {}) {
  const dict = parseAnnotationDict(annotationHtml);
  const plain = stripHtml(descriptionHtml);
  const issues = [];
  for (const sent of splitSentences(plain)) {
    const body = sent.body;
    if (!body.trim()) continue;
    for (const topic of DESC_TOPICS) {
      if (!sentenceMentionsTopic(body, topic)) continue;
      if (!isAssertive(body, topic)) continue;

      const hasField = hasTopicField(topic, dict);
      const annVal = annotationValueFor(topic, dict);

      if (!hasField) {
        issues.push({
          id,
          topic: topic.label,
          topic_id: topic.id,
          kind: 'fabrication',
          said: body.trim(),
          annotation: null,
          sentence: body.trim(),
        });
        continue;
      }

      let claimed = null;
      if (topic.material) claimed = extractMaterialClaim(body);
      else claimed = extractBoolClaim(body);

      if (claimed != null && !valuesAgree(topic, claimed, annVal)) {
        issues.push({
          id,
          topic: topic.label,
          topic_id: topic.id,
          kind: 'contradiction',
          said: body.trim(),
          annotation: annVal,
          sentence: body.trim(),
        });
      }
    }
  }
  return issues;
}

function tidyPunct(s) {
  return String(s || '')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,+/g, ',')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+\./g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/(?:^|[.!?…]\s+)и\s+/gi, (m) => m.replace(/\s+и\s+/i, ' '))
    .replace(/^\s*и\s+/i, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function materialPhrase(annValue) {
  const v = fold(annValue);
  if (/нержав/.test(v)) return 'из нержавеющей стали';
  if (/эмалир/.test(v)) return 'из эмалированной стали';
  if (/комбинир/.test(v)) return 'комбинированный';
  if (/пластик|полипропилен/.test(v)) return 'из пластика';
  return String(annValue).toLowerCase();
}

function boolPhrase(annValue, topicLabel) {
  const ann = fold(annValue);
  const pos = /^(?:есть|да|true|имеется)$/i.test(String(annValue).trim())
    || (!/^(?:нет|отсутствует|false)$/i.test(String(annValue).trim()) && /есть|да/.test(ann));
  const neg = /^(?:нет|отсутствует|false)$/i.test(String(annValue).trim());
  if (neg || (!pos && /нет/.test(ann))) {
    return `не имеет ${topicLabel}`;
  }
  return `имеет ${topicLabel}`;
}

/**
 * Переписывает клаузу противоречия под значение annotation.
 */
function rewriteContradiction(sentence, topic, annValue) {
  let s = sentence;
  if (topic.material) {
    const phrase = materialPhrase(annValue);
    // «барабан — из нержавеющей стали» / «материал барабана — пластик»
    s = s.replace(
      /((?:материал\s+)?(?:барабан[аеу]?|бак[аеу]?)\s*[-–—:]?\s*(?:из\s+)?)([^,;.!?]+)/i,
      (_, lead) => `${lead.replace(/\s+$/, ' ').replace(/из\s+$/i, '')}${phrase.startsWith('из ') ? phrase : phrase}`,
    );
    // fallback: заменить материал целиком
    if (MATERIAL_VALUE_RE.test(s) && fold(extractMaterialClaim(s) || '') !== fold(annValue)) {
      s = s.replace(MATERIAL_VALUE_RE, phrase.replace(/^из\s+/, ''));
    }
    return tidyPunct(s);
  }
  // boolean: вырезать негатив/позитив и поставить канон
  const phrase = boolPhrase(annValue, topic.label);
  if (BOOL_NEG.test(s) || BOOL_POS.test(s)) {
    // Упрощённо: если предложение в основном про эту тему — заменить целиком на короткую фразу.
    if (s.replace(topic.topicRe, '').trim().length < 40) {
      return phrase.charAt(0).toUpperCase() + phrase.slice(1);
    }
  }
  return tidyPunct(s);
}

/**
 * Ремонт plain-текста: удалить fabrication-предложения, поправить contradictions.
 */
export function repairDescriptionPlain(text, annotationHtml) {
  const dict = parseAnnotationDict(annotationHtml);
  const parts = splitSentences(text);
  let out = '';
  const fixes = [];

  for (const sent of parts) {
    const body = sent.body;
    if (!body.trim()) {
      out += body + sent.sep;
      continue;
    }

    let drop = false;
    let rewritten = body;
    const hitTopics = [];

    for (const topic of DESC_TOPICS) {
      if (!sentenceMentionsTopic(body, topic)) continue;
      if (!isAssertive(body, topic)) continue;

      const hasField = hasTopicField(topic, dict);
      const annVal = annotationValueFor(topic, dict);

      if (!hasField) {
        drop = true;
        fixes.push({ kind: 'fabrication', topic: topic.label, sentence: body.trim() });
        break;
      }

      let claimed = topic.material ? extractMaterialClaim(body) : extractBoolClaim(body);
      if (claimed != null && !valuesAgree(topic, claimed, annVal)) {
        hitTopics.push({ topic, annVal });
      }
    }

    if (drop) continue;

    for (const { topic, annVal } of hitTopics) {
      const next = rewriteContradiction(rewritten, topic, annVal);
      if (next !== rewritten) {
        fixes.push({
          kind: 'contradiction',
          topic: topic.label,
          sentence: body.trim(),
          annotation: annVal,
          repaired: next.trim(),
        });
        rewritten = next;
      }
    }

    out += rewritten + sent.sep;
  }

  return { text: tidyPunct(out), fixes };
}

/**
 * Ремонт HTML: правки только в текстовых узлах.
 * @returns {{ html: string, fixes: object[] }}
 */
export function repairDescriptionHtml(descriptionHtml, annotationHtml) {
  const s = String(descriptionHtml || '');
  if (!s.trim()) return { html: s, fixes: [] };

  const allFixes = [];
  if (/<[a-z][\s\S]*>/i.test(s)) {
    const html = s.replace(/(^|>)([^<]*)/g, (_, edge, frag) => {
      if (!frag.trim()) return edge + frag;
      const { text, fixes } = repairDescriptionPlain(frag, annotationHtml);
      allFixes.push(...fixes);
      return edge + text;
    });
    return {
      html: html.replace(/<p>\s*<\/p>/gi, '').replace(/<li>\s*<\/li>/gi, ''),
      fixes: allFixes,
    };
  }

  const { text, fixes } = repairDescriptionPlain(s, annotationHtml);
  return { html: text, fixes };
}

/**
 * Сводка по массиву товаров (products_*.json shape).
 */
export function auditDescAnnotation(products) {
  const byTopic = Object.fromEntries(
    DESC_TOPICS.map(t => [t.id, {
      topic: t.label,
      ok: 0,
      problem: 0,
      mentions: 0,
      correctness_pct: 100,
    }]),
  );
  const rows = [];

  for (const p of products || []) {
    const id = p?.id ?? p?.sku;
    const desc = p?.description_html || p?.description || '';
    const ann = p?.annotation_html || p?.annotation || '';
    const issues = findDescAnnotationIssues(desc, ann, { id });
    const mentioned = new Set();

    const plain = stripHtml(desc);
    for (const topic of DESC_TOPICS) {
      for (const sent of splitSentences(plain)) {
        if (sentenceMentionsTopic(sent.body, topic) && isAssertive(sent.body, topic)) {
          mentioned.add(topic.id);
        }
      }
    }

    for (const tid of mentioned) {
      byTopic[tid].mentions += 1;
    }

    const problemTopics = new Set(issues.map(i => i.topic_id));
    for (const tid of mentioned) {
      if (problemTopics.has(tid)) byTopic[tid].problem += 1;
      else byTopic[tid].ok += 1;
    }

    for (const issue of issues) {
      rows.push(issue);
    }
  }

  for (const t of Object.values(byTopic)) {
    const total = t.ok + t.problem;
    t.correctness_pct = total ? Math.round((t.ok / total) * 1000) / 10 : 100;
  }

  return {
    topics: DESC_TOPICS.map(t => byTopic[t.id]),
    issues: rows,
    scanned: (products || []).length,
  };
}
