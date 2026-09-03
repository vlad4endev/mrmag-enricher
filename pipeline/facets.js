/** Фильтры строго по facet.* справочника. Вид и шаг из справочника, не из данных. */

export function bucketLabel(value, facet, { isLast = false } = {}) {
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

function displayValue(v) {
  if (v === true) return 'Есть';
  if (v === false) return 'Нет';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

/**
 * Строит filters.json. Пустые бакеты не создаются.
 * Для range: [a; b) при bound_rule=left_closed.
 */
export function buildFilters(recs, dict, config) {
  const minCov = config.facet_min_coverage ?? 70;
  const total = recs.length || 1;
  const filters = [];
  const excluded = [];

  for (const attr of dict.attrs) {
    const facet = attr.facet || {};
    if (!facet.enabled) continue;

    const filled = recs.filter(r => r.attrs[attr.code] != null);
    const cov = (filled.length / total) * 100;
    if (attr.tier === 'B' && cov < minCov) {
      excluded.push({
        code: attr.code,
        name: attr.name,
        coverage: Math.round(cov),
        reason: `После дообогащения заполненность ${Math.round(cov)}% ниже порога ${minCov}%`,
      });
      continue;
    }

    const counts = new Map();
    if (facet.kind === 'range') {
      const nums = filled.map(r => numericOf(r.attrs[attr.code])).filter(v => v != null);
      const labels = nums.map(v => {
        const lo = Math.floor(v / facet.step) * facet.step;
        return lo;
      });
      const maxLo = labels.length ? Math.max(...labels) : null;
      for (let i = 0; i < nums.length; i++) {
        const lo = labels[i];
        const isLast = facet.open_last && lo === maxLo;
        const lab = bucketLabel(nums[i], facet, { isLast });
        counts.set(lab, (counts.get(lab) || 0) + 1);
      }
    } else {
      for (const r of filled) {
        const v = r.attrs[attr.code];
        const parts = Array.isArray(v) ? v : [v];
        for (const p of parts) {
          const lab = displayValue(p);
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

    filters.push({
      name: facet.label || attr.name,
      value: values,
      _code: attr.code,
      _counts: Object.fromEntries(counts),
    });
  }

  return {
    filters: filters.map(({ name, value }) => ({ name, value })),
    debug: filters,
    excluded,
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
      out[f.name] = bucketLabel(n, facet, { isLast });
    } else {
      out[f.name] = displayValue(Array.isArray(v) ? v[0] : v);
    }
  }
  return out;
}
