/** HTML карточки собирается программно. Модель структуру, не текст. */

import { attrLabel, formatAttrValue, labelHasUnit } from './types.js';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtVal(attr, v) {
  const label = attrLabel(attr);
  return formatAttrValue(attr, v, { withUnit: !labelHasUnit(label) });
}

export function renderCard(rec, dict) {
  const visible = dict.attrs.filter(a => a.show_in_annotation && rec.attrs[a.code] != null);
  const lis = visible
    .sort((a, b) => a.order - b.order)
    .map(a => `<li>${esc(attrLabel(a))}: ${esc(fmtVal(a, rec.attrs[a.code]))}</li>`);
  const highlights = dict.attrs
    .filter(a => a.highlight && rec.attrs[a.code] != null)
    .sort((a, b) => a.order - b.order)
    .map(a => `${attrLabel(a)}: ${fmtVal(a, rec.attrs[a.code])}`);

  const annotation = lis.length ? `<ul>${lis.join('')}</ul>` : '';
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
