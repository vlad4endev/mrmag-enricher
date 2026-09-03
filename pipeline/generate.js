/** HTML карточки собирается программно. Модель структуру, не текст. */

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtVal(attr, v) {
  if (v == null) return '';
  if (v === true) return 'есть';
  if (v === false) return 'нет';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'number') return attr.unit ? `${v} ${attr.unit}` : String(v);
  return String(v);
}

export function renderCard(rec, dict) {
  const visible = dict.attrs.filter(a => a.show_in_annotation && rec.attrs[a.code] != null);
  const lis = visible
    .sort((a, b) => a.order - b.order)
    .map(a => `<li>${esc(a.name)} - ${esc(fmtVal(a, rec.attrs[a.code]))}</li>`);
  const highlights = dict.attrs
    .filter(a => a.highlight && rec.attrs[a.code] != null)
    .sort((a, b) => a.order - b.order)
    .map(a => `${a.name}: ${fmtVal(a, rec.attrs[a.code])}`);

  const annotation = lis.length ? `<ul>\n${lis.join('\n')}\n</ul>` : rec.annotation;
  let description = rec.description;
  if (!String(description || '').trim() || rec.dump) {
    const intro = highlights.length
      ? `<p>${esc(highlights.join('. '))}.</p>`
      : '';
    description = intro;
  }
  return { annotation, description, highlights };
}

export function verifyDescription(html, rec, dict) {
  const errors = [];
  const text = String(html || '');
  const re = /(\d+(?:[.,]\d+)?)\s*(мм|см|м|кг|л|дБ|дб|об\/мин)/gi;
  let m;
  while ((m = re.exec(text))) {
    const n = parseFloat(m[1].replace(',', '.'));
    const unit = m[2].toLowerCase() === 'дб' ? 'дБ' : m[2];
    const hit = dict.attrs.find(a => rec.attrs[a.code] === n || rec.attrs[a.code] === n / 10 || rec.attrs[a.code] === n * 10);
    if (hit && hit.unit && hit.unit.toLowerCase() !== String(unit).toLowerCase() && !(hit.unit === 'дБ' && /дб/i.test(unit))) {
      errors.push({ kind: 'unit_mismatch', number: n, unit, attr: hit.code, attr_unit: hit.unit });
    }
  }
  return errors;
}
