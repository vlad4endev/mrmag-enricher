/**
 * Импорт списка характеристик → предложения для schema.
 * AI (или эвристика) раскладывает строки по атрибутам / предлагает новые.
 * Ничего не пишет на диск — только proposals для UI.
 */

import { blankAttribute, indexDictionary } from './dict.js';
import { matchKey } from './match.js';
import { valueFold, displayEnum, aliasValue } from './types.js';
import { normKey } from './text.js';

const ACTIONS = new Set([
  'synonym_name',   // синоним названия атрибута
  'value',          // канон / синоним значения ENUM
  'blacklist',      // «не путать с»
  'new_attr',       // новый атрибут
  'skip',           // мусор / не относится
]);

/** Разбор вставленного списка: строки, «ключ - значение», CSV. */
export function parseImportLines(text) {
  const raw = String(text || '');
  const lines = raw
    .split(/\r?\n|;/)
    .map(s => s.replace(/^\s*[-•*\d.)]+\s*/, '').trim())
    .filter(Boolean);

  const items = [];
  const seen = new Set();
  for (const line of lines) {
    // «Ключ: значение» / «Ключ - значение» / «Ключ — значение»
    const m = line.match(/^(.{2,80}?)\s*[=:−–—-]\s*(.+)$/u);
    let label = line;
    let value = null;
    if (m) {
      label = m[1].trim();
      value = m[2].trim();
      if (!value || /^(—|-|нет данных|n\/?a)$/i.test(value)) value = null;
    }
    const key = valueFold(`${label}|${value || ''}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push({
      id: `i${items.length + 1}`,
      raw: line,
      label,
      value,
    });
  }
  return items;
}

function slugCode(name, used) {
  let base = String(name || 'attr')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, '_')
    .replace(/^_|_$/g, '')
    .replace(/[а-я]+/g, (w) => {
      // простая транслит-заглушка для UI; AI обычно даёт латиницу
      const map = {
        а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z',
        и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
        р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch',
        ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
      };
      return [...w].map(c => map[c] || c).join('');
    })
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') || 'attr';
  if (!/^[a-z]/.test(base)) base = `a_${base}`;
  base = base.slice(0, 40);
  let code = base;
  let n = 2;
  while (used.has(code)) {
    code = `${base}_${n++}`;
  }
  used.add(code);
  return code;
}

function attrBrief(attr) {
  const canons = Object.keys(attr.value_aliases || {}).slice(0, 12);
  return {
    code: attr.code,
    name: attr.name,
    type: attr.type,
    unit: attr.unit || null,
    facet: !!attr.facet?.enabled,
    synonyms: (attr.synonyms || []).slice(0, 6),
    blacklist: (attr.blacklist || []).slice(0, 6),
    canons,
  };
}

/** Промпт: текущая schema + список строк → JSON proposals. */
export function buildImportSuggestPrompt(attrs, { categoryName = '', catId = '' } = {}) {
  const brief = (attrs || []).filter(a => a.tier !== 'X').map(attrBrief);
  return `Ты помогаешь заполнять category schema интернет-магазина (attributes_${catId || 'N'}.json).

Категория: ${categoryName || catId || 'не указана'}

ПРАВИЛА:
1. Schema — единственный источник истины для фильтров.
2. Не выдумывай фильтры: либо привяжи строку к существующему атрибуту, либо предложи new_attr.
3. Мусор («Зоны свежести - нет» как значение «Тип холодильника», «[object Object]», фрагменты «Освещения - …») → action=skip или blacklist другого атрибута.
4. Для ENUM: канон на русском (как на витрине), синонимы — варианты написания.
5. Boolean: type=boolean, значения Есть/Нет не нужны в value_aliases.
6. Числа/объёмы/габариты: type=number|integer + unit.
7. code нового атрибута: латиница snake_case, уникален.
8. Ответь ТОЛЬКО JSON-объектом, без markdown.

ТЕКУЩИЕ АТРИБУТЫ:
${JSON.stringify(brief, null, 2)}

ФОРМАТ ОТВЕТА:
{
  "items": [
    {
      "id": "i1",
      "raw": "исходная строка",
      "action": "value|synonym_name|blacklist|new_attr|skip",
      "attr_code": "существующий code или null",
      "canon": "каноническое значение ENUM или null",
      "synonyms": ["..."],
      "confidence": 0.0,
      "note": "кратко почему",
      "proposed": null
    },
    {
      "id": "i2",
      "raw": "...",
      "action": "new_attr",
      "attr_code": null,
      "canon": null,
      "synonyms": [],
      "confidence": 0.8,
      "note": "...",
      "proposed": {
        "code": "freshness_zone",
        "name": "Зоны свежести",
        "type": "enum",
        "unit": null,
        "facet_enabled": true,
        "facet_kind": "enum",
        "description": "...",
        "synonyms": ["Зона свежести"],
        "blacklist": ["Тип холодильника"],
        "value_aliases": { "Есть": ["есть", "да"], "Нет": ["нет"] }
      }
    }
  ]
}`;
}

export function buildImportUserContent(items) {
  return JSON.stringify({
    task: 'map_source_lines_to_category_schema',
    lines: items.map(i => ({
      id: i.id,
      raw: i.raw,
      label: i.label,
      value: i.value,
    })),
  }, null, 2);
}

/** Эвристика без ИИ: matchKey по label. */
export function heuristicSuggest(items, attrs, { fuzzyMin = 0.72 } = {}) {
  const dict = indexDictionary(attrs, 'tmp');
  const used = new Set(attrs.map(a => a.code));
  const out = [];

  for (const item of items) {
    const matched = matchKey(item.label, dict, { value: item.value || '', fuzzyMin });
    if (matched?.how === 'blacklist') {
      out.push({
        id: item.id,
        raw: item.raw,
        action: 'skip',
        attr_code: matched.attr?.code || null,
        canon: null,
        synonyms: [],
        confidence: 0.5,
        note: `blacklist «${matched.raw || item.label}»`,
        proposed: null,
        source: 'heuristic',
      });
      continue;
    }
    if (matched?.attr && matched.how !== 'none') {
      const attr = matched.attr;
      if (item.value && (attr.type === 'enum' || attr.type === 'text')) {
        const aliased = aliasValue(attr, item.value);
        const canon = aliased || displayEnum(item.value) || item.value;
        out.push({
          id: item.id,
          raw: item.raw,
          action: 'value',
          attr_code: attr.code,
          canon,
          synonyms: [...new Set([item.value, canon, aliased].filter(Boolean))],
          confidence: aliased
            ? 0.9
            : (matched.how === 'exact' || matched.how === 'synonym' ? 0.7 : 0.55),
          note: aliased
            ? `синоним → канон «${canon}» (${attr.name})`
            : (Object.keys(attr.value_aliases || {}).length
              ? `новое значение для ${attr.name} (проверьте — нет в aliases)`
              : `значение → ${attr.name}`),
          proposed: null,
          source: 'heuristic',
        });
      } else if (item.value && attr.type === 'boolean') {
        out.push({
          id: item.id,
          raw: item.raw,
          action: 'skip',
          attr_code: attr.code,
          canon: null,
          synonyms: [],
          confidence: 0.7,
          note: `boolean «${attr.name}» — каноны Есть/Нет задаются типом`,
          proposed: null,
          source: 'heuristic',
        });
      } else if (normKey(item.label) !== normKey(attr.name)) {
        out.push({
          id: item.id,
          raw: item.raw,
          action: 'synonym_name',
          attr_code: attr.code,
          canon: null,
          synonyms: [item.label],
          confidence: 0.75,
          note: `синоним названия → ${attr.name}`,
          proposed: null,
          source: 'heuristic',
        });
      } else {
        out.push({
          id: item.id,
          raw: item.raw,
          action: 'skip',
          attr_code: attr.code,
          canon: null,
          synonyms: [],
          confidence: 0.4,
          note: 'уже есть как имя атрибута',
          proposed: null,
          source: 'heuristic',
        });
      }
      continue;
    }

    // Нет матча — предложить новый атрибут по label
    const name = item.label;
    const code = slugCode(name, used);
    const type = guessType(item);
    const proposed = {
      code,
      name,
      type,
      unit: guessUnit(item),
      facet_enabled: type === 'enum' || type === 'boolean' || type === 'number' || type === 'integer',
      facet_kind: type === 'boolean' ? 'boolean' : (type === 'number' || type === 'integer' ? 'range' : 'enum'),
      description: '',
      synonyms: [name],
      blacklist: [],
      value_aliases: {},
    };
    if (type === 'enum' && item.value) {
      const canon = displayEnum(item.value) || item.value;
      proposed.value_aliases[canon] = [item.value, canon].filter((v, i, a) => a.indexOf(v) === i);
    }
    out.push({
      id: item.id,
      raw: item.raw,
      action: 'new_attr',
      attr_code: null,
      canon: item.value ? (displayEnum(item.value) || item.value) : null,
      synonyms: item.value ? [item.value] : [],
      confidence: 0.45,
      note: 'нет совпадения в schema — черновик атрибута',
      proposed,
      source: 'heuristic',
    });
  }
  return out;
}

function guessType(item) {
  const blob = `${item.label} ${item.value || ''}`.toLowerCase();
  if (/дисплей|наличие|перенавеш|перевеш|wifi|wi-fi|защита от детей|ноу фрост|есть\/нет/.test(blob)
    && (!item.value || /^(да|нет|есть|нет)$/i.test(item.value))) {
    return 'boolean';
  }
  if (/объ[её]м|высота|ширина|глубина|вес|мощност|шум|л\.|мм|см|кг|дб|вт/.test(blob)) {
    if (/камер|двер|программ|скорост/.test(blob) && !/объ[её]м/.test(blob)) return 'integer';
    return 'number';
  }
  if (/количество|число/.test(blob)) return 'integer';
  return 'enum';
}

function guessUnit(item) {
  const blob = `${item.label} ${item.value || ''}`.toLowerCase();
  if (/\bл\b|литр/.test(blob)) return 'л';
  if (/\bмм\b/.test(blob)) return 'мм';
  if (/\bсм\b/.test(blob)) return 'см';
  if (/\bкг\b/.test(blob)) return 'кг';
  if (/дб/.test(blob)) return 'дБ';
  if (/\bвт\b|\bw\b/.test(blob)) return 'Вт';
  return null;
}

/** Разобрать JSON ответа модели → нормализованные items. */
export function parseModelSuggestions(raw, items) {
  let data = raw;
  if (typeof raw === 'string') {
    const s = raw.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    try { data = JSON.parse(s); }
    catch {
      const m = s.match(/\{[\s\S]*\}/);
      if (!m) throw Object.assign(new Error('модель вернула не JSON'), { status: 502 });
      data = JSON.parse(m[0]);
    }
  }
  const list = Array.isArray(data) ? data : (data?.items || []);
  const byId = new Map(items.map(i => [i.id, i]));
  const out = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const id = row.id || null;
    const src = (id && byId.get(id)) || items.find(i => i.raw === row.raw) || null;
    let action = String(row.action || 'skip');
    if (!ACTIONS.has(action)) action = 'skip';
    out.push({
      id: id || src?.id || `i${out.length + 1}`,
      raw: row.raw || src?.raw || '',
      action,
      attr_code: row.attr_code || row.code || null,
      canon: row.canon || null,
      synonyms: Array.isArray(row.synonyms) ? row.synonyms.map(String).filter(Boolean) : [],
      confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0.5,
      note: row.note || '',
      proposed: row.proposed && typeof row.proposed === 'object' ? row.proposed : null,
      source: 'ai',
      selected: action !== 'skip',
    });
  }
  // строки без ответа модели — skip
  const covered = new Set(out.map(o => o.id));
  for (const item of items) {
    if (covered.has(item.id)) continue;
    out.push({
      id: item.id,
      raw: item.raw,
      action: 'skip',
      attr_code: null,
      canon: null,
      synonyms: [],
      confidence: 0,
      note: 'модель не вернула строку',
      proposed: null,
      source: 'ai',
      selected: false,
    });
  }
  return out;
}

/**
 * Применить выбранные proposals к копии attrs.
 * @returns {{ attrs, applied: number, created: number, skipped: number }}
 */
export function applySuggestions(attrs, suggestions) {
  const list = (attrs || []).map(a => structuredClone(a));
  const byCode = new Map(list.map(a => [a.code, a]));
  let applied = 0;
  let created = 0;
  let skipped = 0;
  const used = new Set(list.map(a => a.code));
  const maxOrder = list.reduce((m, a) => Math.max(m, a.order || 0), 0);
  let nextOrder = maxOrder + 10;

  for (const s of suggestions || []) {
    if (s.selected === false || s.action === 'skip') {
      skipped++;
      continue;
    }

    if (s.action === 'new_attr' && s.proposed) {
      let code = String(s.proposed.code || '').trim();
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(code) || byCode.has(code)) {
        code = slugCode(s.proposed.name || code || 'attr', used);
      } else {
        used.add(code);
      }
      const type = s.proposed.type || 'enum';
      const name = s.proposed.name || s.raw || code;
      const attr = blankAttribute({
        code,
        name,
        type: type === 'multi_enum' ? 'enum' : type,
        unit: s.proposed.unit ?? null,
        order: nextOrder,
        description: s.proposed.description || '',
        synonyms: Array.isArray(s.proposed.synonyms) && s.proposed.synonyms.length
          ? s.proposed.synonyms
          : [name],
        blacklist: Array.isArray(s.proposed.blacklist) ? s.proposed.blacklist : [],
        value_aliases: s.proposed.value_aliases && typeof s.proposed.value_aliases === 'object'
          ? s.proposed.value_aliases
          : {},
        facet: {
          enabled: s.proposed.facet_enabled !== false,
          label: name,
          kind: s.proposed.facet_kind
            || (type === 'boolean' ? 'boolean' : (type === 'number' || type === 'integer' ? 'range' : 'enum')),
        },
      });
      if (type === 'multi_enum') attr.cardinality = 'multi';
      if (s.canon && (attr.type === 'enum' || attr.type === 'text')) {
        const syns = [...new Set([s.canon, ...(s.synonyms || [])].filter(Boolean))];
        attr.value_aliases[s.canon] = syns;
      }
      list.push(attr);
      byCode.set(code, attr);
      nextOrder += 10;
      created++;
      applied++;
      continue;
    }

    const attr = byCode.get(s.attr_code);
    if (!attr) {
      skipped++;
      continue;
    }

    if (s.action === 'synonym_name') {
      const syns = new Set(attr.synonyms || []);
      for (const x of [s.raw, ...(s.synonyms || [])]) {
        const t = String(x || '').trim();
        if (t) syns.add(t);
      }
      attr.synonyms = [...syns];
      applied++;
      continue;
    }

    if (s.action === 'blacklist') {
      const bl = new Set(attr.blacklist || []);
      for (const x of [s.raw, s.canon, ...(s.synonyms || [])]) {
        const t = String(x || '').trim();
        if (t && valueFold(t) !== valueFold(attr.name)) bl.add(t);
      }
      attr.blacklist = [...bl];
      applied++;
      continue;
    }

    if (s.action === 'value') {
      if (attr.type !== 'enum' && attr.type !== 'text') {
        skipped++;
        continue;
      }
      attr.value_aliases = attr.value_aliases || {};
      const canon = String(s.canon || s.synonyms?.[0] || '').trim();
      if (!canon) {
        skipped++;
        continue;
      }
      const prev = attr.value_aliases[canon] || [];
      const syns = new Set([canon, ...prev, ...(s.synonyms || [])].map(x => String(x).trim()).filter(Boolean));
      attr.value_aliases[canon] = [...syns];
      applied++;
      continue;
    }

    skipped++;
  }

  return { attrs: list, applied, created, skipped };
}
