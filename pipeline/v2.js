/**
 * Справочник → вход buildV2. Эталон выхода — products_v2_{id}.json:
 * id, name, meta_keywords, description_html, filters со строками.
 *
 * Ключи specs — как в схеме ИИ (объем_общий_л, ширина_мм), не коды справочника:
 * splitKey из них собирает те же подписи, что в эталоне («Объем общий, л»).
 */

import { metaKeywords } from './export.js';

const PRODUCT_TYPE = {
  523: 'холодильник',
  467: 'стиральная машина',
};

/** code справочника → ключ specs (строка) или { key, mul } для см → мм. */
const CODE_TO_SPEC = {
  523: {
    brand: 'бренд',
    energy_class: 'класс_энергоэффективности',
    vol_total: 'объем_общий_л',
    vol_fridge: 'объем_холодильной_камеры_л',
    vol_freezer: 'объем_морозильной_камеры_л',
    cooling: 'система_охлаждения',
    chambers: 'количество_камер',
    freezer_pos: 'расположение_морозильника',
    control_type: 'тип_управления',
    refrigerant: 'хладагент',
    noise: 'уровень_шума_дб',
    freeze_power: 'мощность_замораживания_кг_сут',
    height: { key: 'высота_мм', mul: 10 },
    width: { key: 'ширина_мм', mul: 10 },
    depth: { key: 'глубина_мм', mul: 10 },
    weight: 'вес_кг',
    color: 'цвет',
  },
  467: {
    brand: 'бренд',
    load_type: 'тип_загрузки',
    install: 'установка',
    load_max: 'максимальная_загрузка_кг',
    spin_max: 'скорость_отжима_об_мин',
    energy_class: 'класс_энергоэффективности',
    wash_class: 'класс_стирки',
    spin_class: 'класс_отжима',
    programs_qty: 'количество_программ',
    water_use: 'расход_воды_л_цикл',
    noise_wash: 'уровень_шума_стирки_дб',
    noise_spin: 'уровень_шума_отжима_дб',
    control_type: 'тип_управления',
    display: 'дисплей',
    drying: 'сушка',
    height: { key: 'высота_мм', mul: 10 },
    width: { key: 'ширина_мм', mul: 10 },
    depth: { key: 'глубина_мм', mul: 10 },
    weight: 'вес_кг',
    color: 'цвет',
  },
};

function unwrap(v) {
  if (Array.isArray(v)) return v.length ? unwrap(v[0]) : null;
  return v;
}

/** Кириллица в эталоне строчная («нижнее», «механическое»), латиница как есть. */
function specText(v) {
  const s = String(v ?? '').trim();
  if (!s) return s;
  if (/[а-яё]/i.test(s) && !/[a-z]/i.test(s)) return s.toLowerCase();
  return s;
}

function snapCooling(v) {
  const t = String(v).toLowerCase().replace(/ё/g, 'е');
  if (/без\s*no\s*frost|капельн/.test(t)) return 'капельная';
  if (/no\s*frost|ноу\s*фрост/.test(t)) return 'No Frost';
  return specText(v);
}

function snapFreezer(v) {
  const t = String(v).toLowerCase().replace(/ё/g, 'е');
  if (/нижн|снизу/.test(t)) return 'нижнее';
  if (/верхн|сверху/.test(t)) return 'верхнее';
  if (/бок/.test(t)) return 'боковое';
  if (/нет|без/.test(t)) return 'нет морозильника';
  return specText(v);
}

function snapInstall(v) {
  const t = String(v).toLowerCase().replace(/ё/g, 'е');
  if (/встраив/.test(t)) return 'встраиваемая';
  if (/столешниц/.test(t)) return 'под столешницу';
  if (/отдельн/.test(t)) return 'отдельностоящая';
  return specText(v);
}

function snapControl(v) {
  const t = String(v).toLowerCase().replace(/ё/g, 'е');
  if (/сенсор/.test(t)) return 'сенсорное';
  if (/кнопоч/.test(t)) return 'кнопочное';
  if (/электрон/.test(t) && !/электромехан/.test(t)) return 'электронное';
  if (/механич/.test(t)) return 'механическое';
  return specText(v);
}

function specFromAttr(key, raw, attr) {
  const v = unwrap(raw);
  if (v == null || v === '') return null;
  if (attr?.type === 'boolean' || typeof v === 'boolean') return v ? 'да' : 'нет';
  if (typeof v === 'number') return v;
  if (key === 'система_охлаждения') return snapCooling(v);
  if (key === 'расположение_морозильника') return snapFreezer(v);
  if (key === 'установка') return snapInstall(v);
  if (key === 'тип_управления') return snapControl(v);
  if (key === 'цвет') return specText(String(v).split(/\s*\/\s*/)[0]);
  return specText(v);
}

function inferFreezer(rec) {
  const blob = `${rec.attrs?.freezer_pos || ''} ${rec.attrs?.fridge_type || ''} ${rec.name || ''}`;
  const got = snapFreezer(blob);
  return ['нижнее', 'верхнее', 'боковое', 'нет морозильника'].includes(got) ? got : null;
}

function inferChambers(rec) {
  const t = `${rec.attrs?.fridge_type || ''} ${rec.name || ''}`.toLowerCase();
  if (/четырехкамер|четырёхкамер/.test(t)) return 4;
  if (/трехкамер|трёхкамер/.test(t)) return 3;
  if (/двухкамер/.test(t)) return 2;
  if (/однокамер/.test(t)) return 1;
  return null;
}

function buildSpecs(rec, dict) {
  const map = CODE_TO_SPEC[dict.catId] || CODE_TO_SPEC[String(dict.catId)] || {};
  const specs = {};
  const type = PRODUCT_TYPE[dict.catId] || PRODUCT_TYPE[Number(dict.catId)];
  if (type) specs.тип_товара = type;
  const model = rec.identity?.model;
  if (model) specs.модель = String(model).trim();

  for (const [code, dest] of Object.entries(map)) {
    const attr = dict.byCode.get(code);
    const raw = rec.attrs?.[code];
    const key = typeof dest === 'object' ? dest.key : dest;
    const mul = typeof dest === 'object' ? dest.mul : 1;
    let val = specFromAttr(key, raw, attr);
    if (typeof val === 'number' && mul !== 1) val = Math.round(val * mul * 1000) / 1000;
    if (val == null || val === '') continue;
    specs[key] = val;
  }

  if (specs.расположение_морозильника == null) {
    const pos = inferFreezer(rec);
    if (pos) specs.расположение_морозильника = pos;
  }
  if (specs.количество_камер == null) {
    const n = inferChambers(rec);
    if (n) specs.количество_камер = n;
  }
  return specs;
}

/**
 * Одна запись справочника → товар для buildV2.
 * Если уже есть enriched с ИИ — его не переписываем: эталонные абзацы от модели.
 */
export function dictToV2Row(rec, dict) {
  if (rec?.enriched?.specs) {
    return {
      sku: rec.sku ?? rec.id,
      name: rec.name,
      price: rec.price,
      enriched: rec.enriched,
    };
  }
  const specs = buildSpecs(rec, dict);
  return {
    sku: rec.id,
    name: rec.name,
    price: rec.price,
    enriched: {
      specs,
      h1: rec.name || '',
      short_description: '',
      seo_description: '',
      bullets: [],
      seo_keywords: String(metaKeywords(rec, dict) || '').split(',').map(s => s.trim()).filter(Boolean),
    },
  };
}

export function dictToV2Rows(recs, dict) {
  return (recs || []).map(r => dictToV2Row(r, dict));
}
