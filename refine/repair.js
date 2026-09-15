/**
 * Доработка готовой выгрузки: лишнее срезаем, дыры закрываем фактом.
 * Типичные значения категории не подставляем — пусто лучше выдумки.
 */

import { ingestPairs, refreshDerivedFacets } from '../pipeline/normalize.js';
import { extractPairs } from '../pipeline/parse.js';
import { buildFilters, assignFilterValues } from '../pipeline/facets.js';
import {
  serializeProduct, serializeFilters, compactHtml, catalogWebInfo, metaKeywords, KEYWORDS,
} from '../pipeline/export.js';
import { renderAnnotation, renderDescription } from '../pipeline/generate.js';
import {
  finalizeRecord, stripHallucinationClaims, SPEC_DUMP_HEADING_RE,
} from '../pipeline/quality_validate.js';
import { alignEnumSurfaces } from '../pipeline/enum_align.js';
import { validateProducts } from '../pipeline/validate.js';
import { enrichMissing } from '../pipeline/external.js';
import { resolveSearchSettings } from '../pipeline/search.js';
import { auditPack } from './audit.js';

function stripSpecDump(html) {
  const s = String(html || '');
  if (!SPEC_DUMP_HEADING_RE.test(s)) return s;
  return s.replace(/(?:<p>)?\s*(?:В характеристиках|Параметры модели|По данным карточки|Основные характеристики)\s*:[\s\S]*$/i, '').trim();
}

function keepDescription(rec, dict) {
  let html = rec._uploaded?.description_html || '';
  html = stripSpecDump(html);
  html = stripHallucinationClaims(html);
  html = compactHtml(html);
  if (html.replace(/<[^>]+>/g, '').trim().length >= 80) return html;
  return compactHtml(renderDescription(rec, dict));
}

function keepMeta(rec, dict) {
  const raw = String(rec._uploaded?.meta_keywords || rec._enriched?.meta_keywords || '');
  const kw = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (kw.length >= KEYWORDS.min && kw.length <= KEYWORDS.max) return kw.join(', ');
  return metaKeywords(rec, dict);
}

function harvestMore(rec, dict, config) {
  const blobs = [
    rec._uploaded?.annotation_html,
    rec._uploaded?.description_html,
    rec.description,
    rec.annotation,
    rec._enriched?.description,
    rec.external?.page_data,
    rec.external?.web_info,
  ].filter(Boolean);
  for (const blob of blobs) {
    const wrapped = /</.test(blob) ? blob : String(blob).split(/\n+/).map(l => `${l}<br>`).join('');
    const pairs = extractPairs(wrapped, dict).map(p => ({ ...p, source: 'S1' }));
    if (pairs.length) ingestPairs(rec, pairs, dict, config);
  }
}

function uploadedEvidence(rec) {
  return [
    rec._uploaded?.annotation_html,
    rec._uploaded?.description_html,
    rec._uploaded?.meta_keywords,
    JSON.stringify(rec._uploaded?.filters || {}),
    rec.name,
  ].join('\n').toLowerCase();
}

/** Категорийные S0-догадки («у всех стиралок нет сушки») — не факты карточки. */
function stripCategoryGuesses(rec) {
  const blob = uploadedEvidence(rec);
  const mention = {
    drying: /сушк/,
    motor_type: /двигател|мотор|инвертор|коллектор|щеточн|bldc/,
    display: /диспл/,
  };
  for (const [code, re] of Object.entries(mention)) {
    const prov = rec.provenance?.[code];
    if (!prov || prov.level !== 'S0') continue;
    if (!String(prov.how || '').startsWith('derived_')) continue;
    if (re.test(blob)) continue;
    delete rec.attrs[code];
    delete rec.provenance[code];
  }
}

export function repairRecord(rec, dict, config) {
  harvestMore(rec, dict, config);
  refreshDerivedFacets(rec, dict, rec);
  stripCategoryGuesses(rec);
  alignEnumSurfaces(rec, dict, {
    enriched: rec._enriched,
    assigned: rec._uploaded?.filters || null,
    autoFix: true,
  });
  finalizeRecord(rec, dict, { enriched: rec._enriched, assigned: null });

  const descHtml = keepDescription(rec, dict);
  if (rec._enriched && typeof rec._enriched === 'object') {
    rec._enriched.description = rec._enriched.description
      ? stripHallucinationClaims(rec._enriched.description)
      : descHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    rec._enriched.meta_keywords = keepMeta(rec, dict);
    rec._enriched.web_info = rec._uploaded?.web_info ?? rec._enriched.web_info;
  }
  rec._uploaded = rec._uploaded || {};
  rec._uploaded.description_html = descHtml;
  rec._uploaded.meta_keywords = keepMeta(rec, dict);
  rec._uploaded.annotation_html = renderAnnotation(rec, dict);
  rec._uploaded.filters = {};
  return rec;
}

function toV2Products(rows, names) {
  return rows.map((row, i) => {
    const filters = {};
    for (const [k, v] of Object.entries(row.filters || {})) {
      filters[k] = Array.isArray(v) ? v[0] : v;
    }
    return {
      id: row.id,
      name: names[i] || null,
      meta_keywords: row.meta_keywords,
      description_html: row.description_html,
      filters,
    };
  });
}

function toV2Filters(built) {
  return serializeFilters(built);
}

export async function repairPack(pack, {
  lookup = true,
  onProgress = null,
} = {}) {
  const { recs, dict, config, shape, category } = pack;
  const before = auditPack(pack);

  if (lookup && resolveSearchSettings(config).enabled) {
    const note = (msg) => { if (onProgress) onProgress({ step: 'lookup', msg }); };
    note('поиск недостающих характеристик в сети');
    await enrichMissing(recs, dict, config, {
      onNote: (msg) => note(String(msg || '')),
    });
  }

  let i = 0;
  for (const rec of recs) {
    repairRecord(rec, dict, config);
    i++;
    if (onProgress && (i % 10 === 0 || i === recs.length)) {
      onProgress({ step: 'repair', done: i, total: recs.length, msg: `карточка ${i}/${recs.length}` });
    }
  }

  const cfg = { ...config, storefront_complete: false };
  const built = buildFilters(recs, dict, cfg);
  const debugFacets = built.debug || [];
  const products = recs.map((rec) => {
    const row = serializeProduct(rec, dict, debugFacets, {
      config: cfg,
      enriched: rec._enriched,
    });
    if (rec._uploaded?.description_html) {
      row.description_html = rec._uploaded.description_html;
    }
    if (rec._uploaded?.meta_keywords) {
      row.meta_keywords = rec._uploaded.meta_keywords;
    }
    row.annotation_html = renderAnnotation(rec, dict);
    row.filters = assignFilterValues(rec, dict, debugFacets, cfg);
    for (const [k, v] of Object.entries(row.filters)) {
      row.filters[k] = Array.isArray(v) ? v : [v];
    }
    row.web_info = catalogWebInfo(rec._enriched, rec);
    rec._uploaded.filters = row.filters;
    rec._uploaded.annotation_html = row.annotation_html;
    rec._uploaded.description_html = row.description_html;
    return row;
  });

  const filters = serializeFilters(built);
  const names = recs.map(r => r.name || r._uploaded?.name || '');
  const files = {
    products,
    filters,
  };
  if (shape === 'v2') {
    files.products_v2 = toV2Products(products, names);
    files.filters_v2 = toV2Filters(built);
  }

  const repairedPack = {
    ...pack,
    recs,
    filters: {
      items: (filters.filters || []).map(f => ({
        name: f.name,
        values: Array.isArray(f.value) ? f.value : [],
      })),
    },
  };
  const after = auditPack(repairedPack);
  const validation = validateProducts(products, dict);

  return {
    category,
    shape,
    files,
    before,
    after,
    validation: {
      ok: validation.ok,
      errors: (validation.errors || []).slice(0, 80),
      summary: validation.summary,
    },
    report: {
      stripped: before.summary.extra,
      missing_before: before.summary.missing_required,
      missing_after: after.summary.missing_required,
      extra_after: after.summary.extra,
      filled_required: Math.max(0, before.summary.missing_required - after.summary.missing_required),
    },
  };
}
