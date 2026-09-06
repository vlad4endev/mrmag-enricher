/**
 * Приведение filters к формату витрины: только характеристики → attrs → фасеты.
 * Умеет пересобрать из data_{id}.json и санитить уже готовый filters JSON.
 */

import fs from 'fs';
import path from 'path';
import {
  loadConfig, loadDictionary, loadProducts, catIdFromFile, writeJson,
} from './dict.js';
import { normalizeProduct } from './normalize.js';
import { buildFilters, facetKind } from './facets.js';
import { serializeFilters } from './export.js';
import {
  runFiltersAgent, assertFiltersClean, heuristicFiltersMappings, applyFiltersAgentMappings,
} from './filters_agent.js';
import {
  aliasValue, displayEnum, hasStrictEnum, looksLikeEnumFragment, valueFold, unifyEnumValues,
} from './types.js';

const BARE_BOOL = /^(?:нет|да|есть|имеется|yes|no)$/i;

/** Доп. схлопывания, если в готовом filters ещё торчат синонимы канонов. */
const EXTRA_COLLAPSE = [
  // freezer / install leftovers inside wrong facets
  [/^(сверху|верхнее|в верхней части)$/i, 'Верхнее'],
  [/^(снизу|нижнее|внизу|в нижней части)$/i, 'Нижнее'],
  [/^(слева|справа|сбоку|боковое)$/i, 'Сбоку'],
  // compressor
  [/^(inverter|инвертор|инверторный|умный инверторный|инверторный компрессор)$/i, 'Инверторный'],
  [/^(стандартный|обычный)$/i, 'Стандартный'],
  [/^(коллекторный)$/i, 'Коллекторный'],
  // control
  [/^(электронная|электронное|электронное управление)$/i, 'Электронное'],
  [/^(сенсор|сенсорное|touch)$/i, 'Сенсорное'],
  [/^(механическое|электромеханическое|электро-механическое|поворотный механизм)$/i, 'Механическое'],
  // cooling / defrost
  [/^(no\s*frost|nofrost|total no frost|full no frost|ноу\s*фрост|автоматическ\w*(?:\s*\(no frost\))?)$/i, 'No Frost'],
  [/^(капельн\w*(?:\s+систем\w*)?)$/i, 'Капельная'],
  [/^(ручн\w*(?:\s+разморозк\w*)?)$/i, 'Ручная разморозка'],
];

function attrByFilterName(dict) {
  const map = new Map();
  for (const a of dict.attrs || []) {
    if (!a.facet?.enabled || a.tier === 'X') continue;
    map.set(a.facet.label || a.name, a);
  }
  return map;
}

function collapseByAliases(attr, raw) {
  const aliased = aliasValue(attr, raw);
  if (aliased) return displayEnum(aliased) || aliased;
  return null;
}

function collapseExtra(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  for (const [re, canon] of EXTRA_COLLAPSE) {
    if (re.test(s)) return canon;
  }
  return null;
}

function isJunkValue(s, attr = null) {
  const t = String(s || '').trim();
  if (!t) return true;
  if (BARE_BOOL.test(t)) return true;
  if (looksLikeEnumFragment(t)) return true;
  if (/^(led|tft|lcd)\s*дисплей$/i.test(t)) return true;
  if (attr?.code === 'control_type' && /дисплей|led|tft|lcd/i.test(t)) return true;
  // Смешение осей внутри «Тип холодильника»
  if (attr?.code === 'fridge_type') {
    if (/^отдельно\s*стоящ|встраива/i.test(t)) return true;
    if (/нижней морозильн|верхней морозильн/i.test(t)) return true;
  }
  return false;
}

/**
 * Санитация готового каталога фасетов под витрину.
 * @returns {{ filters, fixes: object[], issues: object[] }}
 */
export function sanitizeFilterCatalog(filters, dict) {
  const byName = attrByFilterName(dict);
  const fixes = [];
  const issues = [];
  const out = [];

  for (const f of filters || []) {
    const name = f.name;
    const attr = byName.get(name);
    // Витрина — только facet.enabled из справочника.
    if (dict?.attrs?.length && !attr) {
      fixes.push({ name, raw: null, action: 'drop_facet', reason: 'not_enabled_or_unknown' });
      continue;
    }
    const kind = attr ? facetKind(attr) : null;
    const rawValues = Array.isArray(f.value) ? f.value : [];
    const next = [];
    const seen = new Set();

    for (const raw of rawValues) {
      const s = String(raw ?? '').trim();
      if (!s) continue;

      if (kind === 'range' || kind === 'boolean') {
        const k = valueFold(s);
        if (seen.has(k)) continue;
        seen.add(k);
        next.push(s);
        continue;
      }

      if (isJunkValue(s, attr)) {
        fixes.push({ name, raw: s, action: 'drop', reason: 'junk_or_wrong_axis' });
        continue;
      }

      let canon = attr ? collapseByAliases(attr, s) : null;
      if (!canon) {
        const extra = collapseExtra(s);
        if (extra && attr) {
          // extra → попробовать как alias канона атрибута
          canon = collapseByAliases(attr, extra) || (
            hasStrictEnum(attr)
              ? (Object.keys(attr.value_aliases).find(k => valueFold(k) === valueFold(extra)) || null)
              : extra
          );
        } else if (extra && !attr) {
          canon = extra;
        }
      }
      if (!canon) canon = displayEnum(s) || s;

      if (attr && hasStrictEnum(attr)) {
        const hit = Object.keys(attr.value_aliases).find(k => valueFold(k) === valueFold(canon));
        if (!hit) {
          fixes.push({ name, raw: s, action: 'drop', reason: 'not_in_aliases', canon });
          issues.push({ name, value: s, kind: 'filter_not_in_aliases' });
          continue;
        }
        canon = hit;
      }

      if (valueFold(canon) !== valueFold(s)) {
        fixes.push({ name, raw: s, action: 'map', canon });
      }

      const k = valueFold(canon);
      if (seen.has(k)) continue;
      seen.add(k);
      next.push(canon);
    }

    if (!next.length) {
      fixes.push({ name, raw: null, action: 'drop_facet', reason: 'empty_after_sanitize' });
      continue;
    }

    // Сортировка: числа/бакеты по ведущему числу, иначе locale RU.
    next.sort((a, b) => {
      const na = parseFloat(a);
      const nb = parseFloat(b);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return String(a).localeCompare(String(b), 'ru');
    });

    out.push({ name, value: next });
  }

  const clean = assertFiltersClean(out, dict);
  for (const e of clean.errors || []) issues.push(e);

  return {
    filters: out,
    fixes,
    issues,
    validation: clean,
  };
}

/**
 * Аудит: что ещё плохо для витрины.
 */
export function auditFilterCatalog(filters, dict) {
  const byName = attrByFilterName(dict);
  const issues = [];

  for (const f of filters || []) {
    const attr = byName.get(f.name);
    const vals = f.value || [];
    if (!attr) {
      issues.push({ severity: 'warn', name: f.name, kind: 'unknown_facet' });
      continue;
    }
    const kind = facetKind(attr);

    if (kind !== 'range' && kind !== 'boolean' && vals.length === 1) {
      issues.push({
        severity: 'info',
        name: f.name,
        kind: 'single_value',
        detail: vals[0],
      });
    }

    // Подозрительные пары синонимов в одном фасете
    const folds = vals.map(v => valueFold(v));
    const pairs = [
      ['верхнее', 'сверху'],
      ['нижнее', 'снизу'],
      ['инвертор', 'инверторный'],
      ['inverter', 'инвертор'],
      ['no frost', 'автоматическое (no frost)'],
      ['электронное', 'электронная'],
      ['сенсор', 'сенсорное'],
    ];
    for (const [a, b] of pairs) {
      if (folds.includes(a) && folds.includes(b)) {
        issues.push({
          severity: 'error',
          name: f.name,
          kind: 'synonym_pair',
          detail: `${a} + ${b}`,
        });
      }
    }

    if (attr.code === 'fridge_type') {
      for (const v of vals) {
        if (/отдельно|встраива|нижней морозильн|верхней морозильн/i.test(v)) {
          issues.push({
            severity: 'error',
            name: f.name,
            kind: 'mixed_axis',
            detail: v,
          });
        }
      }
    }

    if (attr.code === 'control_type') {
      for (const v of vals) {
        if (/дисплей|led|tft|lcd/i.test(v)) {
          issues.push({
            severity: 'error',
            name: f.name,
            kind: 'wrong_axis_display',
            detail: v,
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Полный проход: data → normalize (характеристики) → agent → build → sanitize.
 */
export async function rebuildStorefrontFilters(dataFile, {
  root = '.',
  outDir = null,
  mode = 'heuristic',
  write = true,
} = {}) {
  const catId = catIdFromFile(dataFile);
  const dict = loadDictionary(catId, root);
  const config = loadConfig(root);
  const products = loadProducts(dataFile);
  const recs = products.map(p => normalizeProduct(p, dict, config));

  const agent = await runFiltersAgent({
    recs,
    dict,
    config,
    mode,
    catId,
    categoryName: dict.catId,
  });

  // На случай mode=heuristic без AI — всё равно прогоняем heuristic mappings явно,
  // если agent вернул skip из-за пустого inventory.
  if (!agent.mappings?.length) {
    const mappings = heuristicFiltersMappings(recs, dict, config);
    applyFiltersAgentMappings(recs, mappings);
    unifyEnumValues(recs, dict);
  }

  const built = buildFilters(recs, dict, config);
  const sanitized = sanitizeFilterCatalog(built.filters, dict);
  const audit = auditFilterCatalog(sanitized.filters, dict);
  const payload = serializeFilters({ filters: sanitized.filters });

  const dir = outDir || path.join(root, 'out');
  const outPath = path.join(dir, `filters_${catId}.json`);
  const reportPath = path.join(dir, `filters_fix_report_${catId}.json`);
  const report = {
    catId,
    source: 'characteristics',
    products: products.length,
    agent: {
      mode: agent.mode,
      mappings: agent.mappings?.length || 0,
      skipped: agent.stats?.skipped || 0,
    },
    fixes: sanitized.fixes,
    issues: [...sanitized.issues, ...audit],
    validation: sanitized.validation,
    filters: sanitized.filters.map(f => ({
      name: f.name,
      values: f.value.length,
      sample: f.value.slice(0, 8),
    })),
  };

  if (write) {
    fs.mkdirSync(dir, { recursive: true });
    writeJson(outPath, payload, 4);
    writeJson(reportPath, report, 2);
  }

  return {
    catId,
    filters: sanitized.filters,
    payload,
    report,
    outPath,
    reportPath,
    validation: sanitized.validation,
  };
}

/**
 * Санитация уже готового filters_*.json по справочнику категории.
 */
export function sanitizeStorefrontFiltersFile(filtersFile, catId, {
  root = '.',
  outDir = null,
  write = true,
} = {}) {
  const dict = loadDictionary(catId, root);
  const raw = JSON.parse(fs.readFileSync(filtersFile, 'utf8'));
  const list = Array.isArray(raw?.filters) ? raw.filters : (Array.isArray(raw) ? raw : []);
  const sanitized = sanitizeFilterCatalog(list, dict);
  const audit = auditFilterCatalog(sanitized.filters, dict);
  const payload = serializeFilters({ filters: sanitized.filters });

  const dir = outDir || path.dirname(path.resolve(filtersFile));
  const outPath = path.join(dir, `filters_${catId}.json`);
  const reportPath = path.join(dir, `filters_fix_report_${catId}.json`);
  const report = {
    catId,
    source: 'sanitize_file',
    input: filtersFile,
    fixes: sanitized.fixes,
    issues: [...sanitized.issues, ...audit],
    validation: sanitized.validation,
  };

  if (write) {
    fs.mkdirSync(dir, { recursive: true });
    writeJson(outPath, payload, 4);
    writeJson(reportPath, report, 2);
  }

  return { catId, filters: sanitized.filters, payload, report, outPath, reportPath, validation: sanitized.validation };
}
