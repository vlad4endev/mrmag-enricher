/** Фильтры строго по facet.* справочника. Вид и шаг из справочника, не из данных. */

import { formatAttrValue, unifyEnumValues } from './types.js';

export function bucketLabel(value, facet, { isLast = false, isLastClosed = false } = {}) {
  if (facet.kind !== 'range') return String(value);
  const step = facet.step;
  if (!(step > 0)) throw new Error(`facet.step обязателен для range (${facet.label})`);
  const lo = Math.floor(Number(value) / step) * step;
  if (facet.open_last && isLast) return `${fmt(lo)}+`;
  const hi = lo + step;
  return `${fmt(lo)}-${fmt(hi)}`;
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : String(+n.toFixed(3));
}

function numericOf(v) {
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function displayValue(attr, v) {
  return formatAttrValue(attr, v, { withUnit: false });
}

/**
 * Строит filters.json. Пустые бакеты не создаются.
 * Для range: [a; b) при bound_rule=left_closed; последний закрытый включает правую границу.
 * Сумма counter диапазонного фильтра = число товаров с заполненным атрибутом.
 */
export function buildFilters(recs, dict, config) {
  unifyEnumValues(recs, dict);
  if (config.facet_min_coverage == null) {
    throw new Error('config.facet_min_coverage обязателен');
  }
  const minCov = config.facet_min_coverage;
  const total = recs.length || 1;
  const filters = [];
  const excluded = [];
  const warnings = [];

  for (const attr of dict.attrs) {
    if (attr.tier === 'X') continue;
    if (attr.tier === 'C') continue;

    const facet = attr.facet || {};
    if (!facet.enabled) continue;

    const filled = recs.filter(r => r.attrs[attr.code] != null);
    const cov = (filled.length / total) * 100;

    // A — фильтр сразу; B — только при покрытии ≥ порога (после дообогащения).
    if (attr.tier === 'B' && cov < minCov) {
      excluded.push({
        code: attr.code,
        name: attr.name,
        coverage: Math.round(cov * 10) / 10,
        reason: `После дообогащения заполненность ${Math.round(cov)}% ниже порога ${minCov}%`,
      });
      continue;
    }

    const counts = new Map();
    let filledCount = filled.length;

    if (facet.kind === 'range') {
      if (!(facet.step > 0)) throw new Error(`facet.step обязателен для range (${facet.label || attr.name})`);
      const nums = filled.map(r => numericOf(r.attrs[attr.code])).filter(v => v != null);
      filledCount = nums.length;
      if (!nums.length) continue;

      const minV = Math.min(...nums);
      const seriesStart = Math.floor(minV / facet.step) * facet.step;
      const labels = nums.map(v => Math.floor(v / facet.step) * facet.step);
      const maxLo = Math.max(...labels);
      // Последний закрытый бакет (без open_last): включает правую границу.
      const lastClosedHi = maxLo + facet.step;

      for (let i = 0; i < nums.length; i++) {
        const v = nums[i];
        let lo = labels[i];
        // Значения ниже seriesStart не ожидаются; подтягиваем к началу ряда.
        if (lo < seriesStart) lo = seriesStart;
        const isLast = facet.open_last && lo === maxLo;
        const isLastClosed = !facet.open_last && lo === maxLo && v === lastClosedHi;
        // [a; b): на границе b значение относится к следующему бакету —
        // floor уже даёт это. Последний закрытый: v == hi остаётся в maxLo.
        if (!facet.open_last && v === lastClosedHi) {
          lo = maxLo;
        }
        const lab = bucketLabel(v, facet, { isLast: isLast || (lo === maxLo && facet.open_last), isLastClosed });
        // Пересчёт метки при сдвиге lo для last-closed edge case.
        const finalLab = (lo !== labels[i] && !facet.open_last)
          ? `${fmt(maxLo)}-${fmt(lastClosedHi)}`
          : lab;
        counts.set(finalLab, (counts.get(finalLab) || 0) + 1);
      }

      const sum = [...counts.values()].reduce((a, b) => a + b, 0);
      if (sum !== filledCount) {
        throw new Error(
          `сумма counter фасета «${facet.label || attr.name}» = ${sum}, ` +
          `заполненных товаров = ${filledCount} — выгрузка заблокирована`,
        );
      }
      const occupied = [...counts.keys()].length;
      if (occupied > 8) {
        warnings.push({
          code: attr.code,
          name: facet.label || attr.name,
          occupied,
          reason: `Занятых бакетов ${occupied} > 8; шаг задан справочником, пересчёт запрещён`,
        });
      }
    } else {
      for (const r of filled) {
        const v = r.attrs[attr.code];
        const parts = Array.isArray(v) ? v : [v];
        for (const p of parts) {
          const lab = displayValue(attr, p);
          if (!lab) continue;
          counts.set(lab, (counts.get(lab) || 0) + 1);
        }
      }
    }

    const values = [...counts]
      .filter(([, c]) => c > 0)
      .sort((a, b) => {
        const na = parseFloat(a[0]), nb = parseFloat(b[0]);
        if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
        return a[0].localeCompare(b[0], 'ru');
      })
      .map(([value]) => value);

    if (!values.length) continue;

    filters.push({
      name: facet.label || attr.name,
      value: values,
      _code: attr.code,
      _counts: Object.fromEntries(counts),
      _order: attr.order ?? 0,
    });
  }

  filters.sort((a, b) => (a._order - b._order) || a.name.localeCompare(b.name, 'ru'));

  return {
    filters: filters.map(({ name, value }) => ({ name, value })),
    debug: filters,
    excluded,
    warnings,
  };
}

export function assignFilterValues(rec, dict, debugFacets) {
  const out = {};
  for (const f of debugFacets) {
    const v = rec.attrs[f._code];
    if (v == null) continue;
    const attr = dict.byCode.get(f._code);
    const facet = attr.facet;
    if (facet.kind === 'range') {
      const n = numericOf(v);
      if (n == null) continue;
      const labels = f.value;
      const lo = Math.floor(n / facet.step) * facet.step;
      const maxLo = Math.max(...labels.map(x => parseFloat(x)));
      const isLast = facet.open_last && lo === maxLo;
      out[f.name] = [bucketLabel(n, facet, { isLast })];
    } else {
      const parts = Array.isArray(v) ? v : [v];
      out[f.name] = parts.map(p => displayValue(attr, p));
    }
  }
  return out;
}
