/** Клиентская выгрузка: products_{id}.json и filters_{id}.json, как в эталоне. */

import { splitHtmlChunks } from './text.js';
import { assignFilterValues } from './facets.js';
import { renderCard } from './generate.js';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}


/** Сжать HTML до эталонного вида: без переводов строк между тегами. */
export function compactHtml(html) {
  return String(html || '')
    .replace(/\r\n?/g, '\n')
    .replace(/>\s+</g, '><')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Сжать произвольный список в компактный <ul><li>Ключ: значение</li></ul>.
 * Клиентская аннотация собирается из нормализованных attrs (renderCard), не из сырого HTML.
 */
export function compactAnnotation(html) {
  const chunks = splitHtmlChunks(html);
  if (!chunks.length) return '';
  const lis = chunks.map((line) => {
    const m = String(line).match(/^(.+?)\s*[-–—:]\s*(.+)$/);
    if (m) return `<li>${esc(m[1].trim())}: ${esc(m[2].trim())}</li>`;
    return `<li>${esc(line)}</li>`;
  });
  return `<ul>${lis.join('')}</ul>`;
}

function typeFromName(rec) {
  const name = String(rec.name || '');
  const brand = rec.identity?.brand;
  let head = name;
  if (brand) {
    const i = name.toLowerCase().indexOf(String(brand).toLowerCase());
    if (i > 0) head = name.slice(0, i);
  }
  const words = head
    .replace(/кухонн\w+/gi, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/[«»""]/g, ''))
    .filter((w) => w && !/^\d/.test(w) && w.length > 2);
  return words.slice(0, 2).join(' ').toLowerCase().trim();
}

/** meta_keywords: тип + бренд, затем отличительные фасеты. */
export function metaKeywords(rec, dict) {
  const type = typeFromName(rec);
  const brand = rec.identity?.brand || rec.attrs?.brand;
  const out = [];
  if (type && brand) out.push(`${type} ${brand}`);
  else if (type) out.push(type);
  else if (brand) out.push(String(brand));

  for (const a of dict.attrs) {
    if (!a.facet?.enabled) continue;
    const v = rec.attrs?.[a.code];
    if (v == null || v === '') continue;
    if (a.code === 'brand') continue;
    const n = typeof v === 'number' ? v : Number(v);
    const numeric = typeof v === 'number' || a.type === 'number' || a.type === 'integer';
    if (numeric && Number.isFinite(n)) {
      if (!type) continue;
      const unit = a.unit ? ` ${a.unit}` : '';
      out.push(`${type} ${n}${unit}`.replace(/\s+/g, ' ').trim());
      continue;
    }
    const raw = String(Array.isArray(v) ? v[0] : v).trim();
    if (!raw) continue;
    const lab = /[а-яё]/i.test(raw) ? raw.toLowerCase() : raw;
    out.push(type ? `${lab} ${type}` : lab);
  }
  return [...new Set(out)].slice(0, 10).join(', ');
}

function descriptionHtml(rec, dict) {
  const card = rec.card || renderCard(rec, dict);
  const html = card.description || rec.description || '';
  return compactHtml(html);
}

function annotationHtml(rec, dict) {
  const card = rec.card || renderCard(rec, dict);
  return compactHtml(card.annotation || '');
}

function asFilterArrays(assigned) {
  const out = {};
  for (const [name, v] of Object.entries(assigned || {})) {
    if (v == null || v === '') continue;
    out[name] = Array.isArray(v) ? v : [v];
  }
  return out;
}

/**
 * Одна запись products_{id}.json.
 * Порядок полей как в эталоне: id, name, meta_keywords, description_html,
 * annotation_html, filters, затем web_info / page_data если они есть.
 */
export function serializeProduct(rec, dict, debugFacets) {
  const assigned = assignFilterValues(rec, dict, debugFacets);
  const product = {
    id: rec.id,
    name: rec.name,
    meta_keywords: metaKeywords(rec, dict),
    description_html: descriptionHtml(rec, dict),
    annotation_html: annotationHtml(rec, dict),
    filters: asFilterArrays(assigned),
  };
  const web = rec.web_info || rec.external?.web_info;
  if (web) product.web_info = String(web);
  const page = rec.page_data || rec.external?.page_data;
  if (page) product.page_data = String(page);
  return product;
}

export function serializeProducts(recs, dict, debugFacets) {
  return (recs || []).map((r) => serializeProduct(r, dict, debugFacets));
}

export function serializeFilters(built) {
  return { filters: built.filters || [] };
}
