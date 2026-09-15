/**
 * Постобработка description_html ↔ annotation_html.
 * Источник истины — annotation (уже собранный HTML / словарь полей).
 * Ловит: (а) фабрикацию фактов без поля в annotation,
 *        (б) противоречие значениям annotation.
 * Плюс общий сканер «защита от X» / «функция X» вне whitelist схемы.
 * Промпт: см. defaultSystemPromptTemplate (запрет выдумывать отсутствующие темы).
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
    // «протеч» ловит и «протечек» (род. мн. в перечислении), не только «протечк*».
    topicRe: /защит[а-яё]*\s+от\s+протеч|протеч|aquastop|aquaprotect|аквастоп/i,
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
    // Именительный «бак» / «Бак из …» — гласная после «бак» опциональна.
    topicRe: /(?:материал\s+)?бак(?:а|е|у)?(?![а-яё])|бак(?:а|е|у)?\s*[-–—:]?\s*(?:из\s+)?/i,
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

function canonMaterial(raw) {
  const v = String(raw || '').toLowerCase().replace(/ё/g, 'е');
  if (/нержав|stainless/.test(v)) return 'нержавеющая сталь';
  if (/эмалир/.test(v)) return 'эмалированная сталь';
  if (/комбинир/.test(v)) return 'комбинированный';
  if (/пластик|полипропилен|pom/.test(v)) return 'пластик';
  return fold(raw);
}

/** Материал рядом с «бак» или «барабан» — независимо, даже в одном предложении. */
function extractMaterialClaim(sentence, topicId = null) {
  const s = String(sentence || '');
  const mat = String.raw`нержавеющ(?:ей|ая)\s+стал[иь]|нержавейк[аи]|пластик[аеу]?|полипропилен[аеу]?|эмалированн(?:ой|ая)\s+стал[иь]|комбинированн(?:ый|ого)`;
  if (topicId === 'tank_material') {
    const near = s.match(new RegExp(
      String.raw`бак(?:а|е|у)?(?![а-яё])\s*(?:[-–—:]\s*)?(?:из\s+)?(${mat})`,
      'i',
    )) || s.match(new RegExp(
      String.raw`(?:из\s+)?(${mat})\s+бак(?:а|е|у)?(?![а-яё])`,
      'i',
    ));
    return near ? canonMaterial(near[1]) : null;
  }
  if (topicId === 'drum_material') {
    const near = s.match(new RegExp(
      String.raw`барабан(?:а|е|у)?(?![а-яё])\s*(?:[-–—:]\s*)?(?:из\s+)?(${mat})`,
      'i',
    )) || s.match(new RegExp(
      String.raw`(?:из\s+)?(${mat})\s+барабан(?:а|е|у)?(?![а-яё])`,
      'i',
    ));
    return near ? canonMaterial(near[1]) : null;
  }
  const m = s.match(MATERIAL_VALUE_RE);
  return m ? canonMaterial(m[1]) : null;
}

function extractBoolClaim(sentence) {
  if (BOOL_NEG.test(sentence)) return false;
  if (BOOL_POS.test(sentence)) return true;
  return null;
}

function isAssertive(sentence, topic) {
  // Поля нет в схеме категории: любое упоминание в прозе — утверждение, не фон.
  // Иначе «частичная защита от протечек (корпус)» без «имеет/нет» проходит.
  if (topic.schemaAbsent) return true;
  if (ASSERT_RE.test(sentence)) return true;
  if (topic.material && MATERIAL_VALUE_RE.test(sentence) && topic.topicRe.test(sentence)) {
    return true;
  }
  // «барабан — из нержавеющей стали» без «имеет»
  if (topic.material && /барабан|бак[аеу]/.test(sentence) && MATERIAL_VALUE_RE.test(sentence)) {
    return true;
  }
  // Каталожная строка, вклеенная в прозу: «Защита от детей — есть».
  if (/\s[-–—:]\s/.test(sentence) && topic.topicRe.test(sentence)) return true;
  return false;
}

function isLeakFeat(feat) {
  return /протеч|aquastop|aquaprotect|аквастоп/i.test(String(feat || ''));
}

function isChildLockFeat(feat) {
  return /детей|child\s*lock|блокировк/i.test(String(feat || ''));
}

/**
 * «защита от A, от B и от C» / «защита от A и B» → элементы списка без «от».
 * Первый «защита от» общий, дальше — перечисление через запятую и «и».
 */
export function extractProtectionListItems(sentence) {
  const s = String(sentence || '');
  const out = [];
  const leadRe = /защит[а-яё]*\s+от\s+/gi;
  let m;
  while ((m = leadRe.exec(s))) {
    const after = s.slice(m.index + m[0].length);
    const stop = after.search(/[.!?;]/);
    const tail = (stop < 0 ? after : after.slice(0, stop)).trim();
    if (!tail) continue;
    const parts = tail.split(/\s*(?:,\s*|\s+и\s+)(?:от\s+)?/i)
      .map(p => p.replace(/^от\s+/i, '').replace(/\s+/g, ' ').trim())
      .filter(p => p.length >= 3);
    for (const feat of parts) {
      out.push({ feat, index: m.index, lead: m[0] });
    }
  }
  return out;
}

/** Обрывки после вырезания подстроки, не целого фрагмента. */
export const HANGING_FRAGMENT_RES = Object.freeze([
  /<p>\s*,/i,
  /<p>\s*(?:что|включая|глубину)(?![а-яёa-z0-9])/,
  /\.\s*,\s*(?:что|включая|глубину)(?![а-яёa-z0-9])/i,
  /[.!?…]\s*(?:что|включая|глубину)(?![а-яёa-z0-9])/,
  /не имеет\s*[.!?]/i,
  /учтите\s*[.!?]/i,
  /^\s*,/,
  /^\s*(?:что|включая|глубину)(?![а-яёa-z0-9])/,
]);

export function findHangingFragments(text) {
  const s = String(text || '');
  if (!s.trim()) return [];
  const hits = [];
  for (const re of HANGING_FRAGMENT_RES) {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    const rx = new RegExp(re.source, flags);
    let m;
    while ((m = rx.exec(s))) {
      hits.push({ pattern: re.source, match: m[0], index: m.index });
    }
  }
  return hits;
}

function joinProtectionItems(items) {
  const list = (items || []).map(it => String(it || '').trim()).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  const rest = list.slice(1).map(it => (/^от\s+/i.test(it) ? it : `от ${it}`));
  if (rest.length === 1) return `${list[0]} и ${rest[0]}`;
  return `${list[0]}, ${rest.slice(0, -1).join(', ')} и ${rest[rest.length - 1]}`;
}

function dropFeatForTopic(topic) {
  return (feat) => {
    const f = String(feat || '');
    if (topic.id === 'leak_protection' || /протеч/i.test(topic.label || '')) return isLeakFeat(f);
    if (topic.id === 'child_lock' || /детей/i.test(topic.label || '')) return isChildLockFeat(f);
    const lab = String(topic.label || '').replace(/^защита от\s+/i, '');
    if (lab && (fold(f).includes(fold(lab)) || fold(lab).includes(fold(f)))) return true;
    if (topic.topicRe) {
      try {
        if (topic.topicRe.test(f) || topic.topicRe.test(`защита от ${f}`)) return true;
      } catch { /* invalid topicRe */ }
    }
    return false;
  };
}

function stripFabricatedProtectionItems(sentence, dropFeat) {
  const leadRe = /((?:частичн[а-яё]*|полн[а-яё]*|общ[а-яё]*)\s+)?(защит[а-яё]*\s+от\s+)([^.;!?]+)/gi;
  return String(sentence || '').replace(leadRe, (full, adj, lead, tail) => {
    const items = String(tail || '').split(/\s*(?:,\s*|\s+и\s+)(?:от\s+)?/i)
      .map(p => p.replace(/^от\s+/i, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (!items.length) return full;
    const kept = items.filter(it => !dropFeat(it));
    if (!kept.length) return '';
    if (kept.length === items.length) return full;
    return `${adj || ''}${lead}${joinProtectionItems(kept)}`;
  });
}

function splitFragments(sentence) {
  const s = String(sentence || '');
  const parts = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === ',' || ch === ';') {
      parts.push({ text: buf, sep: ch });
      buf = '';
    } else buf += ch;
  }
  parts.push({ text: buf, sep: '' });
  return parts;
}

function joinFragments(parts) {
  const kept = (parts || []).filter(p => String(p?.text || '').trim());
  let out = '';
  for (let i = 0; i < kept.length; i++) {
    out += kept[i].text;
    if (i < kept.length - 1) out += (kept[i].sep || ',');
  }
  return out;
}

function clauseContainsTopic(clause, topic) {
  const s = String(clause || '');
  if (!s.trim()) return false;
  if (topic.id === 'leak_protection' || /протеч/i.test(topic.label || '')) {
    if (extractProtectionListItems(s).some(it => isLeakFeat(it.feat))) return true;
    return isLeakFeat(s);
  }
  if (topic.id === 'generic_feature' && topic.label) {
    const lab = fold(String(topic.label).replace(/^защита от\s+/i, ''));
    if (lab && extractProtectionListItems(s).some((it) => {
      const f = fold(it.feat);
      return f === lab || f.includes(lab) || lab.includes(f);
    })) return true;
  }
  if (topic.topicRe) {
    try {
      if (topic.topicRe.test(s)) return true;
    } catch { /* */ }
  }
  if (topic.label && fold(s).includes(fold(topic.label))) return true;
  return false;
}

function featureCoveredByTopics(feat) {
  const blob = `защита от ${feat}`;
  return DESC_TOPICS.some((t) => {
    if (t.id === 'leak_protection') return isLeakFeat(feat);
    if (t.id === 'child_lock') return isChildLockFeat(feat);
    try {
      return t.topicRe.test(blob) || t.topicRe.test(feat);
    } catch {
      return false;
    }
  });
}

function sentenceMentionsTopic(sentence, topic) {
  // «защита от детей, от протечек и от скачков» — каждый элемент списка отдельно.
  if (topic.id === 'leak_protection') {
    if (extractProtectionListItems(sentence).some(it => isLeakFeat(it.feat))) return true;
  }
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
    return canonMaterial(claim) === canonMaterial(ann);
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

function annotationHasFeature(dict, featureName) {
  const want = fold(featureName);
  if (!want || want.length < 3) return false;
  for (const [lab, val] of Object.entries(dict || {})) {
    const lf = fold(lab);
    if (lf.includes(want) || want.includes(lf)) return true;
    // Значение само по себе — не подпись характеристики.
    void val;
  }
  return false;
}

/**
 * Общий сканер: «защита от X» / «функция X» / «оснащена X» / «не имеет X»
 * без привязки к whitelist схемы. Если в annotation нет такой подписи — фабрикация.
 */
export function findGenericFeatureClaims(descriptionHtml, annotationHtml, { id = null } = {}) {
  const dict = parseAnnotationDict(annotationHtml);
  const plain = stripHtml(descriptionHtml);
  const issues = [];
  const patterns = [
    {
      re: /защит[а-яё]*\s+от\s+([а-яёa-z0-9][а-яёa-z0-9\s\-–—]{1,40}?)(?=\s*[,;.!?)(]|$)/gi,
      labelOf: (x) => `защита от ${x}`,
    },
    {
      re: /функци[а-яё]*\s+([а-яёa-z0-9][а-яёa-z0-9\s\-–—]{1,40}?)(?=\s*[,;.!?)(]|$)/gi,
      labelOf: (x) => `функция ${x}`,
    },
    {
      re: /(?:не\s+)?оснащен[аоы]?\s+([а-яёa-z0-9][а-яёa-z0-9\s\-–—]{2,40}?)(?=\s*[,;.!?)(]|$)/gi,
      labelOf: (x) => x,
    },
    {
      re: /(?:не\s+)?имеет\s+([а-яёa-z0-9][а-яёa-z0-9\s\-–—]{2,40}?)(?=\s*[,;.!?)(]|$)/gi,
      labelOf: (x) => x,
    },
  ];

  for (const sent of splitSentences(plain)) {
    const body = sent.body;
    if (!body.trim()) continue;
    for (const { re, labelOf } of patterns) {
      const rx = new RegExp(re.source, re.flags);
      let m;
      while ((m = rx.exec(body))) {
        const rawFeat = String(m[1] || '').trim().replace(/\s+/g, ' ');
        // Обрезать хвост союза: «пара и беспроводным» → отдельные темы ловит DESC_TOPICS.
        const feat = rawFeat.replace(/\s+и\s+.*$/i, '').trim();
        if (feat.length < 3) continue;
        // Известные темы из DESC_TOPICS уже обработаны там — здесь только «дыры» схемы.
        const covered = DESC_TOPICS.some(t => t.topicRe.test(m[0]));
        if (covered) continue;
        const label = labelOf(feat);
        if (annotationHasFeature(dict, label) || annotationHasFeature(dict, feat)) continue;
        issues.push({
          id,
          topic: label,
          topic_id: 'generic_feature',
          kind: 'fabrication',
          said: body.trim(),
          annotation: null,
          sentence: body.trim(),
          match: m[0],
        });
      }
    }
    // Перечисление после общего «защита от»: каждый элемент — отдельная тема.
    const seen = new Set(issues.filter(i => i.sentence === body.trim()).map(i => fold(i.topic)));
    for (const it of extractProtectionListItems(body)) {
      const feat = it.feat;
      if (featureCoveredByTopics(feat)) continue;
      const label = `защита от ${feat}`;
      if (seen.has(fold(label)) || seen.has(fold(feat))) continue;
      if (annotationHasFeature(dict, label) || annotationHasFeature(dict, feat)) continue;
      seen.add(fold(label));
      issues.push({
        id,
        topic: label,
        topic_id: 'generic_feature',
        kind: 'fabrication',
        said: body.trim(),
        annotation: null,
        sentence: body.trim(),
        match: `защита от ${feat}`,
      });
    }
  }
  return issues;
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
      if (topic.material) claimed = extractMaterialClaim(body, topic.id);
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
  issues.push(...findGenericFeatureClaims(descriptionHtml, annotationHtml, { id }));
  return issues;
}

function tidyPunct(s) {
  return String(s || '')
    .replace(/^\s*,\s*/g, '')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,+/g, ',')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+\./g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/\.\s*,/g, '.')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/(?:^|[.!?…]\s+)и\s+/gi, (m) => m.replace(/\s+и\s+/i, ' '))
    .replace(/^\s*и\s+/i, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function dropFragmentsOrSentence(sentence, topic) {
  const frags = splitFragments(sentence);
  const kept = frags.filter(f => !clauseContainsTopic(f.text, topic));
  if (!kept.length) return '';
  let next = tidyPunct(joinFragments(kept));
  if (findHangingFragments(next).length) return '';
  if (next.replace(/\s+/g, '').length < 12) return '';
  return next;
}

/**
 * Вырезать целый фрагмент/предложение с фабрикацией, не подстроку.
 * Смешанное «защита от A, от B» — выкинуть только сфабрикованные элементы списка.
 */
function stripFabricationClause(sentence, topic) {
  let s = String(sentence || '');
  const items = extractProtectionListItems(s);
  if (items.length >= 2) {
    const next = stripFabricatedProtectionItems(s, dropFeatForTopic(topic));
    s = tidyPunct(next);
    if (findHangingFragments(s).length) return '';
    if (clauseContainsTopic(s, topic)) return dropFragmentsOrSentence(s, topic);
    if (s.replace(/\s+/g, '').length < 12) return '';
    return s;
  }
  return dropFragmentsOrSentence(s, topic);
}

/**
 * Удаляет предложения/абзацы с висячими обрывками. Если абзац после правки
 * всё ещё битый — выбрасываем его, а не сохраняем «не имеет.» / «<p>, …».
 */
export function sanitizeHangingProse(text) {
  const raw = String(text || '');
  if (!raw.trim()) return raw;
  if (/<[a-z][\s\S]*>/i.test(raw)) {
    const html = raw.replace(/<(p|li|h[1-6]|td|th|div)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (full, tag, attrs, inner) => {
      const next = sanitizeHangingPlain(inner);
      if (!String(next).trim()) return '';
      return `<${tag}${attrs}>${next}</${tag}>`;
    });
    return html.replace(/<p>\s*<\/p>/gi, '').replace(/<li>\s*<\/li>/gi, '');
  }
  return sanitizeHangingPlain(raw);
}

function sanitizeHangingPlain(text) {
  let s = tidyPunct(String(text || '').replace(/^\s*,\s*/, ''));
  if (!s.trim()) return '';
  if (!findHangingFragments(s).length && !findHangingFragments(`<p>${s}</p>`).length) return s;
  const parts = splitSentences(s);
  let out = '';
  for (const sent of parts) {
    const chunk = tidyPunct(sent.body);
    if (!chunk) continue;
    if (findHangingFragments(chunk).length) continue;
    if (findHangingFragments(sent.full).length) continue;
    out += chunk + (sent.sep || ( /[.!?…]$/.test(chunk) ? '' : '. '));
  }
  s = tidyPunct(out);
  if (findHangingFragments(s).length) return '';
  return s;
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
 * Бак и барабан в одном предложении правятся независимо.
 */
function rewriteContradiction(sentence, topic, annValue) {
  let s = sentence;
  if (topic.material) {
    const phrase = materialPhrase(annValue);
    const mat = String.raw`нержавеющ(?:ей|ая)\s+стал[иь]|нержавейк[аи]|пластик[аеу]?|полипропилен[аеу]?|эмалированн(?:ой|ая)\s+стал[иь]|комбинированн(?:ый|ого)`;
    if (topic.id === 'tank_material') {
      s = s.replace(
        new RegExp(String.raw`(бак(?:а|е|у)?(?![а-яё])\s*(?:[-–—:]\s*)?(?:из\s+)?)(${mat})`, 'i'),
        (_, lead) => `${lead.replace(/\s+$/, ' ').replace(/из\s+$/i, '')}${phrase}`,
      );
    } else if (topic.id === 'drum_material') {
      s = s.replace(
        new RegExp(String.raw`(барабан(?:а|е|у)?(?![а-яё])\s*(?:[-–—:]\s*)?(?:из\s+)?)(${mat})`, 'i'),
        (_, lead) => `${lead.replace(/\s+$/, ' ').replace(/из\s+$/i, '')}${phrase}`,
      );
    } else {
      s = s.replace(
        /((?:материал\s+)?(?:барабан[аеу]?|бак[аеу]?)\s*[-–—:]?\s*(?:из\s+)?)([^,;.!?]+)/i,
        (_, lead) => `${lead.replace(/\s+$/, ' ').replace(/из\s+$/i, '')}${phrase}`,
      );
    }
    return tidyPunct(s);
  }
  const phrase = boolPhrase(annValue, topic.label);
  if (BOOL_NEG.test(s) || BOOL_POS.test(s)) {
    if (s.replace(topic.topicRe, '').trim().length < 40) {
      return phrase.charAt(0).toUpperCase() + phrase.slice(1);
    }
  }
  return tidyPunct(s);
}

/**
 * Ремонт plain-текста: удалить fabrication-предложения/клаузы, поправить contradictions.
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
    const fabTopics = [];

    for (const topic of DESC_TOPICS) {
      if (!sentenceMentionsTopic(rewritten, topic)) continue;
      if (!isAssertive(rewritten, topic)) continue;

      const hasField = hasTopicField(topic, dict);
      const annVal = annotationValueFor(topic, dict);

      if (!hasField) {
        fabTopics.push(topic);
        continue;
      }

      const claimed = topic.material
        ? extractMaterialClaim(rewritten, topic.id)
        : extractBoolClaim(rewritten);
      if (claimed != null && !valuesAgree(topic, claimed, annVal)) {
        hitTopics.push({ topic, annVal });
      }
    }

    // Общие «защита от X» / «функция X» без поля в annotation.
    for (const g of findGenericFeatureClaims(rewritten, annotationHtml)) {
      fabTopics.push({
        id: g.topic_id,
        label: g.topic,
        topicRe: new RegExp(String(g.match || g.topic).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      });
    }

    for (const topic of fabTopics) {
      const before = rewritten;
      const next = stripFabricationClause(rewritten, topic);
      if (next === '') {
        drop = true;
        fixes.push({ kind: 'fabrication', topic: topic.label, sentence: body.trim() });
        break;
      }
      if (next !== before) {
        rewritten = next;
        fixes.push({ kind: 'fabrication', topic: topic.label, sentence: body.trim(), repaired: next });
        continue;
      }
      // Тема уже снята предыдущим проходом — не дропать целое предложение.
      if (clauseContainsTopic(rewritten, topic) || (topic.topicRe && topic.topicRe.test(rewritten))) {
        drop = true;
        fixes.push({ kind: 'fabrication', topic: topic.label, sentence: body.trim() });
        break;
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

    if (findHangingFragments(rewritten).length) {
      const cleaned = sanitizeHangingPlain(rewritten);
      if (!cleaned || findHangingFragments(cleaned).length) {
        // Битую правку не сохраняем: абзац/предложение выкидываем, не оставляем обрывок.
        fixes.push({ kind: 'hanging_fragment', topic: 'prose', sentence: rewritten.trim() });
        continue;
      }
      rewritten = cleaned;
    }

    out += rewritten + sent.sep;
  }

  return { text: sanitizeHangingProse(tidyPunct(out)), fixes };
}

/**
 * Ремонт HTML.
 * Блок (p/li/…) чинится целиком по stripHtml: иначе «барабан — из
 * <strong>нержавеющей стали</strong>» режется по узлам, topic и значение
 * оказываются в разных фрагментах, и contradiction не срабатывает.
 * Блоки без темы не трогаем — внутренние <strong> остаются.
 * @returns {{ html: string, fixes: object[] }}
 */
export function repairDescriptionHtml(descriptionHtml, annotationHtml) {
  const s = String(descriptionHtml || '');
  if (!s.trim()) return { html: s, fixes: [] };

  if (!/<[a-z][\s\S]*>/i.test(s)) {
    const { text, fixes } = repairDescriptionPlain(s, annotationHtml);
    return { html: sanitizeHangingProse(text), fixes };
  }

  const allFixes = [];
  const BLOCK_RE = /<(p|li|h[1-6]|td|th|div)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let blocks = 0;
  let html = s.replace(BLOCK_RE, (full, tag, attrs, inner) => {
    blocks += 1;
    const orig = stripHtml(inner);
    const { text, fixes } = repairDescriptionPlain(orig, annotationHtml);
    if (!fixes.length && text === orig && !findHangingFragments(inner).length) return full;
    allFixes.push(...fixes);
    if (!String(text).trim()) return '';
    return `<${tag}${attrs}>${text}</${tag}>`;
  });

  if (!blocks) {
    html = s.replace(/(^|>)([^<]*)/g, (_, edge, frag) => {
      if (!frag.trim()) return edge + frag;
      const { text, fixes } = repairDescriptionPlain(frag, annotationHtml);
      allFixes.push(...fixes);
      return edge + text;
    });
  }

  return {
    html: sanitizeHangingProse(html.replace(/<p>\s*<\/p>/gi, '').replace(/<li>\s*<\/li>/gi, '')),
    fixes: allFixes,
  };
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
