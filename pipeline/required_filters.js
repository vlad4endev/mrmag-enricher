/**
 * Обязательные фильтры категории: оси витрины, по которым покупатель ИЩЕТ товар.
 * Состав фасетов по-прежнему задаёт schema (facet.enabled); здесь только роль.
 */

import { isBrandAttr } from './types.js';

export function isStorefrontFilter(attr) {
  if (!attr || attr.tier === 'X' || isBrandAttr(attr)) return false;
  if (!attr.facet?.enabled || attr.facet?.status === 'not_a_filter') return false;
  return true;
}

/**
 * Явный facet.required перекрывает эвристику.
 * Иначе highlight или tier A среди включённых фасетов — тип, ёмкость, размер,
 * энергокласс, ключевая технология. Цвет/дисплей без флага — необязательные.
 */
export function isRequiredFilter(attr) {
  if (!isStorefrontFilter(attr)) return false;
  if (attr.facet?.required === true) return true;
  if (attr.facet?.required === false) return false;
  return attr.highlight === true || attr.tier === 'A';
}

function sortedFilterAttrs(dict, pred) {
  return (dict?.attrs || [])
    .filter(pred)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.code).localeCompare(String(b.code)));
}

export function storefrontFilterAttrs(dict) {
  return sortedFilterAttrs(dict, isStorefrontFilter);
}

export function requiredFilterAttrs(dict) {
  return sortedFilterAttrs(dict, isRequiredFilter);
}

export function optionalFilterAttrs(dict) {
  return sortedFilterAttrs(dict, a => isStorefrontFilter(a) && !isRequiredFilter(a));
}
