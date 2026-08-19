/**
 * export_v2.js — выгрузка «JSON v2»: фасеты каталога и товары с готовым
 * description_html.
 *
 * Чем отличается от filters_(id).json: там фильтр магазина (бренд из листинга
 * и слайдер цены), здесь фасеты из обогащения — все checkbox, числовые поля
 * свёрнуты в диапазоны. Одно и то же значение у товара и в списке каталога
 * считает одна функция: разойдись они хоть в округлении — товар не попадёт ни
 * в один свой фасет, и фильтр молча отдаст пустой раздел.
 *
 * На входе — массив товаров в форме products_(id).json (товар + enriched),
 * поэтому модуль одинаково работает и из интерфейса, и по файлу из CLI.
 */

// Числовое поле схемы кончается единицей измерения: она уходит и в имя фасета
// («Объем, л»), и в строку характеристики («Объем: 25 л»).
const UNIT = {
  л: 'л', мл: 'мл', кг: 'кг', г: 'г', мм: 'мм', см: 'см', м: 'м', м2: 'м²', мм2: 'мм²',
  вт: 'Вт', квт: 'кВт', в: 'В', а: 'А', ач: 'А·ч', гц: 'Гц', дб: 'дБ', к: 'К', лм: 'лм',
  мес: 'мес', ч: 'ч', мин: 'мин', бар: 'бар', нм: 'Н·м', дюйм: 'дюйм',
  процент: '%', шт: 'шт', ip: 'IP',
  об_мин: 'об/мин', кг_сут: 'кг/сут', л_цикл: 'л/цикл', л_мин: 'л/мин',
  м2_л: 'м²/л', кг_м2: 'кг/м²',
};

// «да/нет» в схеме — это «Есть/Нет» в фильтре: галочка «да» читается как ошибка.
const YESNO = { да: 'Есть', нет: 'Нет' };

const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
const num = v => String(+(+v).toFixed(3));

/** Ключ схемы → подпись и единица: объем_общий_л → {label:'Объем общий', unit:'л'}. */
export function splitKey(key) {
  const parts = String(key).split('_');
  for (const take of [2, 1]) {
    if (parts.length <= take) continue;      // из имени поля нельзя вычесть всё
    const unit = UNIT[parts.slice(-take).join('_')];
    if (unit) return { label: cap(parts.slice(0, -take).join(' ')), unit };
  }
  return { label: cap(parts.join(' ')), unit: '' };
}

const facetName = key => {
  const { label, unit } = splitKey(key);
  return unit ? `${label}, ${unit}` : label;
};

// Пока значений мало, диапазоны не нужны: шесть объёмов читаются лучше, чем
// шесть интервалов вокруг них. 256 холодильников дают 60 разных объёмов —
// вот там перечисление и превращается в бесполезные 60 галочек.
const DISCRETE_MAX = 6;
const TARGET_BUCKETS = 8;
const NICE = [1, 2, 2.5, 5, 10];

/** Круглый шаг: ~1/8 разброса, подтянутый до 1/2/2.5/5/10 × 10^k. */
function niceStep(span) {
  const rough = span / TARGET_BUCKETS;
  const mag = 10 ** Math.floor(Math.log10(rough));
  for (const n of NICE) if (rough <= n * mag * 1.000001) return n * mag;
  return 10 * mag;
}

/**
 * Функция «число → подпись диапазона» по разбросу значений раздела.
 * Диапазон считается от самого значения, а не подбором по списку границ:
 * пустых интервалов в фасете тогда не бывает по построению.
 */
function bucketize(values) {
  const uniq = [...new Set(values)].sort((a, b) => a - b);
  if (uniq.length <= DISCRETE_MAX) return num;
  const step = niceStep(uniq[uniq.length - 1] - uniq[0]);
  // Шаг в единицу на целых значениях — это то же перечисление, только в виде
  // «39-40»: диапазон здесь ничего не сворачивает.
  if (step <= 1 && uniq.every(Number.isInteger)) return num;
  const dec = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const round = x => +x.toFixed(dec);
  return v => {
    const lo = round(Math.floor(v / step) * step);
    return `${num(lo)}-${num(round(lo + step))}`;
  };
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** id товара — sku магазина; числовой отдаём числом, как в примере заказчика. */
const idOf = p => (/^\d+$/.test(String(p.sku ?? '')) ? Number(p.sku) : (p.sku ?? null));

/**
 * Описание + характеристики одним html: абзац, список характеристик, плюсы
 * товара, абзац. Плюсы идут отдельным <ul> после характеристик: смешивать их
 * со списком нельзя — там точные значения, а здесь текст модели.
 */
function descHtml(e) {
  const out = [];
  const intro = e.short_description || e.seo_description || '';
  if (intro) out.push(`<p>${esc(intro)}</p>`);

  const li = Object.entries(e.specs || {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => {
      const { label, unit } = splitKey(k);
      const val = typeof v === 'number'
        ? `${num(v)}${unit ? ` ${unit}` : ''}`
        : (YESNO[String(v).toLowerCase()] || String(v));   // «да» и «Есть» в одном файле не соседствуют
      return `<li>${esc(label)}: ${esc(val)}</li>`;
    });
  if (li.length) out.push(`<ul>${li.join('')}</ul>`);

  const bullets = (e.bullets || []).map(b => String(b).trim()).filter(Boolean);
  if (bullets.length) out.push(`<ul>${bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>`);

  if (e.seo_description && e.seo_description !== intro) out.push(`<p>${esc(e.seo_description)}</p>`);
  return out.join('');
}

const keywords = e => {
  const list = (e.seo_keywords || []).length ? e.seo_keywords : (e.search_aliases || []);
  return [...new Set(list.map(s => String(s).trim()).filter(Boolean))].join(', ');
};

/**
 * Товары и фасеты раздела: { filters: [{name, value:[…]}], products: [{…}] }.
 * Необработанные позиции пропускаются — без enriched у товара нет ни
 * description_html, ни характеристик, то есть в v2 ему нечем быть.
 */
export function buildV2(rows) {
  const enriched = (rows || []).filter(r => r && r.enriched && r.enriched.specs);

  // Диапазон нельзя выбрать по одному товару: сначала весь разброс раздела.
  const nums = new Map();
  for (const r of enriched) {
    for (const [k, v] of Object.entries(r.enriched.specs)) {
      if (typeof v !== 'number') continue;
      const name = facetName(k);
      if (!nums.has(name)) nums.set(name, []);
      nums.get(name).push(v);
    }
  }
  const bucket = new Map([...nums].map(([name, vs]) => [name, bucketize(vs)]));
  const valueOf = (name, v) =>
    typeof v === 'number' ? bucket.get(name)(v) : (YESNO[String(v).toLowerCase()] || String(v));

  const products = enriched.map(r => {
    const e = r.enriched;
    const filters = {};
    for (const [k, v] of Object.entries(e.specs)) {
      if (v == null || v === '') continue;
      const name = facetName(k);
      filters[name] = valueOf(name, v);
    }
    return {
      id: idOf(r),
      name: r.name || e.seo_title || '',
      meta_keywords: keywords(e),
      description_html: descHtml(e),
      filters,
    };
  });

  // Список фасета собирается из выгруженных товаров, а не считается заново:
  // так в каталоге не может оказаться значения, которого нет ни у кого.
  const facets = new Map();
  for (const p of products) {
    for (const [name, v] of Object.entries(p.filters)) {
      if (!facets.has(name)) facets.set(name, new Set());
      facets.get(name).add(v);
    }
  }
  const lead = s => parseFloat(s);
  const filters = [...facets].map(([name, set]) => ({
    name,
    value: [...set].sort((a, b) =>
      nums.has(name) ? lead(a) - lead(b) : String(a).localeCompare(String(b), 'ru')),
  }));

  return { filters, products };
}
