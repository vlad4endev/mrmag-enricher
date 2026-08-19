/**
 * catalog.js — сборка каталога категории mrmag.ru и автофильтров.
 *
 * Заказчик задаёт категории адресом раздела:
 *   Холодильники        https://mrmag.ru/shop/kholodilniki        (523)
 *   Стиральные машины   https://mrmag.ru/shop/stiralnye_mashiny   (467)
 *
 * id категории НЕ вбит в код — он читается со страницы (data-category), иначе
 * при переносе раздела файлы молча уедут под чужим номером.
 *
 * Листинг раздела отдаёт по 20 товаров и уже содержит всё для фильтра: sku,
 * название, цену, наличие, картинку и бренд (ссылка class="mr-brand"). Поэтому
 * бренд и цена берутся из самого магазина, а не угадываются по названию.
 *
 * Описание и характеристики листинг не отдаёт. Их источник:
 *   1) фид products.json — если sku там есть (для холодильников это все 259),
 *   2) страница товара — по одному запросу на товар (стиральные машины).
 *
 * Результат — товары в том же виде, что и в фиде products.json, плюс brand и
 * available. Это важно: обогащение, extractFacts и isEnrichable работают с
 * description + annotation, и таблица характеристик со страницы товара
 * разворачивается в annotation ровно так, как это делает сам фид.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { netError } from './lib.js';

export const ORIGIN = 'https://mrmag.ru';
export const FEED_URL = `${ORIGIN}/scripts/sync_local/products.json`;

/**
 * Разделы из требований. Адрес — то, что задаёт заказчик; id указан для поиска
 * по номеру, но истиной считается id со страницы: при расхождении будет
 * предупреждение, а имена файлов возьмут номер страницы, а не этот список.
 */
export const CATEGORIES = [
  { slug: 'kholodilniki',      name: 'Холодильники',      id: 523, url: `${ORIGIN}/shop/kholodilniki` },
  { slug: 'stiralnye_mashiny', name: 'Стиральные машины', id: 467, url: `${ORIGIN}/shop/stiralnye_mashiny` },
];

/** Раздел по slug, названию, id или адресу. */
export const findCategory = key => {
  const k = String(key ?? '');
  return CATEGORIES.find(c => c.slug === k || c.name === k || c.url === k || String(c.id) === k);
};

// ── КЭШ СТРАНИЦ ──────────────────────────────────────────────
// 21 листинг + 160 страниц товара на прогон. Без кэша отладка разбора бьёт по
// чужому серверу и по времени, поэтому страницы лежат сутки.
const CACHE_DIR = process.env.PAGE_CACHE_DIR || '.page_cache';
const CACHE_TTL = Number(process.env.PAGE_CACHE_TTL_MS || 24 * 3600 * 1000);
const UA = 'mrmag-enricher/1.0 (+catalog builder)';

const cachePath = url =>
  path.join(CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex') + '.html');

export const sleep = ms => new Promise(r => setTimeout(r, ms));

let lastFetch = 0;
const MIN_GAP_MS = Number(process.env.CRAWL_GAP_MS || 250); // ~4 запроса в секунду

/** GET с кэшем на диске и минимальной паузой между обращениями к сайту. */
export async function fetchPage(url, { noCache = false } = {}) {
  const file = cachePath(url);
  if (!noCache && fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < CACHE_TTL) {
    return fs.readFileSync(file, 'utf-8');
  }
  const gap = MIN_GAP_MS - (Date.now() - lastFetch);
  if (gap > 0) await sleep(gap);
  lastFetch = Date.now();

  let res, html;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(45_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} на ${url}`);
    // Тело читаем внутри try: таймаут прерывает и его.
    html = await res.text();
  } catch (e) {
    throw new Error(/^HTTP /.test(e.message) ? e.message : `${url} — ${netError(e)}`);
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, html, 'utf-8');
  return html;
}

// ── РАЗБОР HTML ──────────────────────────────────────────────
const ENTITIES = {
  nbsp: ' ', times: '×', mdash: '—', ndash: '–', deg: '°', quot: '"', apos: "'",
  laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', middot: '·', hellip: '…',
  sup2: '²', sup3: '³', lt: '<', gt: '>', amp: '&',
};
/** Точка с запятой в фиде часто отсутствует: «310&nbsp л», «40&deg C». */
const decode = s => String(s || '')
  .replace(/&([a-z]+);?/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
  .replace(/&#(\d+);?/g, (m, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);?/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/\s{2,}/g, ' ').trim();

const attr = (block, name, kind = 'content') => {
  const m = block.match(new RegExp(`itemprop="${name}"[^>]*\\b${kind}="([^"]*)"`, 'i'));
  return m ? decode(m[1]) : null;
};

const abs = u => (!u ? null : u.startsWith('http') ? u : ORIGIN + u);

/**
 * Товары со страницы листинга + id категории + число страниц.
 * Каждый товар — отдельный блок schema.org/Product, поэтому режем по нему.
 */
export function parseListing(html) {
  const idm = html.match(/data-category="(\d+)"/);
  const pages = Math.max(1, ...[...html.matchAll(/[?&]page=(\d+)/g)].map(m => +m[1]));

  const items = [];
  for (const block of html.split(/itemtype="http:\/\/schema\.org\/Product"/i).slice(1)) {
    const sku = block.match(/data-sku="(\d+)"/)?.[1];
    if (!sku) continue;                     // хлебные крошки и прочие Product-блоки без корзины
    const brand = block.match(/class="mr-brand"[^>]*>([^<]+)</i)
      || block.match(/href="[^"]*\/kupit\/brand-([a-z0-9_-]+)"/i);
    items.push({
      sku,
      name:        decode(block.match(/itemprop="name"[^>]*>([^<]*)</i)?.[1]),
      product_url: abs(attr(block, 'url', 'href')),
      image:       abs(attr(block, 'image', 'src')),
      price:       attr(block, 'price') == null ? null : Number(attr(block, 'price')),
      available:   /schema\.org\/InStock/i.test(block),
      brand:       brand ? decode(brand[1]) : null,
      brand_slug:  block.match(/\/kupit\/brand-([a-z0-9_-]+)/i)?.[1] ?? null,
    });
  }
  return { categoryId: idm ? Number(idm[1]) : null, pages, items };
}

/**
 * Описание и характеристики со страницы товара. Таблица характеристик — пары
 * «подпись / значение» в двух колонках; она же разворачивается в annotation,
 * потому что весь разбор фактов читает description + annotation.
 */
export function parseProductPage(html) {
  const desc = html.match(/itemprop="description"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '';
  const attributes = [];
  const table = html.match(/Характеристики<\/h3>([\s\S]*?)<\/section>/i)?.[1] ?? '';
  for (const row of table.split(/<div class="row/i).slice(1)) {
    const cols = [...row.matchAll(/<div class="col-sm-[57][^"]*"[^>]*>([\s\S]*?)<\/div>/gi)]
      .map(m => decode(m[1].replace(/<[^>]+>/g, ' ')));
    if (cols.length >= 2 && cols[0] && cols[1]) attributes.push({ name: cols[0], value: cols[1] });
  }
  return {
    description: decode(desc.replace(/<[^>]+>/g, ' ')),
    annotation:  attributes.map(a => `${a.name} - ${a.value}`).join(' '),
    attributes,
    brand:       html.match(/itemprop="brand"[^>]*content="([^"]*)"/i)?.[1] ?? null,
  };
}

// ── ФИД КАК ИСТОЧНИК ОПИСАНИЙ ────────────────────────────────
/** products.json по sku. Для холодильников закрывает все описания без запросов. */
export async function loadFeed() {
  const html = await fetchPage(FEED_URL);
  const bySku = new Map();
  for (const p of JSON.parse(html)) if (p?.sku != null) bySku.set(String(p.sku), p);
  return bySku;
}

/**
 * Часть товаров магазин не привязал к бренду, хотя бренд стоит в названии
 * («Холодильники_1/ATLANT ХМ-4619-101»). Оставить их без бренда — дырка в
 * фильтре, поэтому дописываем по словарю этой же категории: сам список брендов
 * авторитетный (из ссылок фильтра магазина), догадка только в сопоставлении.
 * Источник помечается в brand_source, чтобы это было видно, а не подразумевалось.
 */
export function assignMissingBrands(products) {
  const vocab = new Map();
  for (const p of products) {
    if (!p.brand_slug || !p.brand) continue;
    vocab.set(p.brand_slug, { brand: p.brand, slug: p.brand_slug });
  }
  // Длинные названия вперёд: «kraft» не должен опередить «kraft technology».
  const keys = [...vocab.values()]
    .flatMap(v => [{ ...v, word: v.brand }, { ...v, word: v.slug }])
    .sort((a, b) => b.word.length - a.word.length);

  let filled = 0;
  for (const p of products) {
    if (p.brand_slug || p.brand || !p.name) continue;
    const name = p.name.toLowerCase();
    const hit = keys.find(k => {
      const i = name.indexOf(k.word.toLowerCase());
      if (i < 0) return false;
      // Границы слова: «orsk» не должен найтись внутри «Norsk».
      const before = name[i - 1], after = name[i + k.word.length];
      return !/[a-zа-яё0-9]/i.test(before ?? ' ') && !/[a-zа-яё0-9]/i.test(after ?? ' ');
    });
    if (!hit) continue;
    p.brand = hit.brand;
    p.brand_slug = hit.slug;
    p.brand_source = 'name';   // у остальных источник — сам магазин
    filled++;
  }
  return filled;
}

// ── СБОРКА КАТЕГОРИИ ─────────────────────────────────────────
/**
 * Обходит раздел целиком и добирает описания только для окна.
 *
 * Листинг сам отдаёт бренд и цену, поэтому страницы листинга читаются всегда
 * все: фильтр должен описывать раздел, а не то окно, которое кто-то решил
 * обработать. Дорогая часть — описания со страниц товаров, вот её и ограничивает
 * limit/offset.
 *
 * Возвращает { id, slug, name, url, crawled_at, listed, items, products }:
 * items — весь раздел (без описаний), products — окно с описаниями.
 */
export async function crawlCategory(url, { limit = Infinity, offset = 0, feed = null, onNote = () => {} } = {}) {
  const known = findCategory(url);
  const first = parseListing(await fetchPage(url));
  if (!first.categoryId) throw new Error(`Не нашёл data-category на ${url} — раздел изменился?`);
  if (known?.id && known.id !== first.categoryId) {
    // Файлы пойдут под номером со страницы: он и есть настоящий.
    onNote(`id раздела изменился: в коде ${known.id}, на странице ${first.categoryId}`);
  }
  if (!first.items.length) throw new Error(`На ${url} не нашлось товаров`);

  const items = [...first.items];
  for (let page = 2; page <= first.pages; page++) {
    onNote(`листинг ${page}/${first.pages}`);
    const { items: more } = parseListing(await fetchPage(`${url}?page=${page}`));
    if (!more.length) break;
    items.push(...more);
  }

  // Словарь брендов строим по всему разделу — на окне он был бы беднее.
  const guessed = assignMissingBrands(items);
  if (guessed) onNote(`бренд по названию: ${guessed}`);

  const slug = new URL(url).pathname.split('/').filter(Boolean).pop();
  const name = known?.name ?? slug;
  for (const it of items) it.category = name;

  if (offset >= items.length) {
    throw new Error(`OFFSET=${offset} за пределами раздела (${items.length} товаров)`);
  }
  const window = items.slice(offset, limit === Infinity ? undefined : offset + limit);
  const products = [];

  for (const [i, it] of window.entries()) {
    const fromFeed = feed?.get(it.sku);
    let details;
    if (fromFeed) {
      // Через decode, как и страницу товара: иначе одно поле приходит в двух
      // видах — «310&nbsp л» из фида и «310 л» со страницы.
      details = {
        description: decode(fromFeed.description),
        annotation:  decode(fromFeed.annotation),
        attributes:  (fromFeed.attributes ?? []).map(a => ({ name: decode(a.name), value: decode(a.value) })),
      };
    } else {
      onNote(`товар ${i + 1}/${window.length}`);
      const page = parseProductPage(await fetchPage(it.product_url));
      details = { description: page.description, annotation: page.annotation, attributes: page.attributes };
      it.brand ||= page.brand;
    }
    products.push({ ...it, ...details });
  }

  return {
    id: first.categoryId, slug, name, url,
    crawled_at: new Date().toISOString(),
    listed: items.length,
    items,
    products,
  };
}

// ── АВТОФИЛЬТРЫ ──────────────────────────────────────────────
/**
 * Бренд и цена строятся из самих товаров: бренд — как его классифицирует
 * магазин, цена — фактический диапазон. Ничего вручную не задаётся, поэтому
 * файл не расходится с каталогом.
 */
export function buildFilters(category, products) {
  const brands = new Map();
  for (const p of products) {
    const key = p.brand_slug || p.brand;
    if (!key) continue;
    const b = brands.get(key) || { value: p.brand || key, slug: p.brand_slug || null, count: 0 };
    b.count++;
    brands.set(key, b);
  }

  const prices = products.map(p => p.price).filter(v => Number.isFinite(v) && v > 0);
  const noBrand = products.filter(p => !(p.brand_slug || p.brand)).length;
  const byName = products.filter(p => p.brand_source === 'name').length;

  return {
    category_id: category.id,
    category:    category.name,
    url:         category.url,
    generated_at: new Date().toISOString(),
    products_total: products.length,
    filters: [
      {
        code: 'brand', name: 'Бренд', type: 'checkbox',
        // Сначала частые: так фильтр читается без сортировки на клиенте.
        values: [...brands.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'ru')),
        ...(noBrand ? { without_value: noBrand } : {}),
        ...(byName ? { assigned_by_name: byName } : {}),
      },
      {
        code: 'price', name: 'Цена', type: 'range', unit: '₽',
        min: prices.length ? Math.min(...prices) : null,
        max: prices.length ? Math.max(...prices) : null,
        // Шаг слайдера от разброса цен, а не константой: 10 ₽ на диапазоне
        // 7 000–190 000 даёт бесполезно мелкую сетку.
        step: prices.length ? priceStep(Math.max(...prices) - Math.min(...prices)) : null,
        ...(prices.length < products.length ? { without_price: products.length - prices.length } : {}),
      },
    ],
  };
}

/** Круглый шаг: ~1% диапазона, округлённый вниз до 10/100/1000. */
function priceStep(span) {
  if (!(span > 0)) return null;
  const rough = span / 100;
  const mag = 10 ** Math.floor(Math.log10(rough));
  return Math.max(10, Math.round(rough / mag) * mag);
}

// ── ЗАПИСЬ ФАЙЛОВ КАТЕГОРИИ ──────────────────────────────────
/**
 * Два файла на категорию, как в требованиях: products_(id).json и
 * filters_(id).json. id — тот, что вернула страница раздела, а не придуманный.
 *
 * products_(id).json — массив товаров, как отдаёт products.json магазина, чтобы
 * импорт не разбирал обёртку. Ничего при этом не теряется: когда собрано и
 * сколько товаров — в filters_(id).json, модель и расход — в _meta каждого
 * обогащённого товара.
 */
export function writeCategoryFiles(category, products, { dir = '.', filterProducts = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });

  const productsFile = path.join(dir, `products_${category.id}.json`);
  fs.writeFileSync(productsFile, JSON.stringify(products, null, 2), 'utf-8');

  const filtersFile = path.join(dir, `filters_${category.id}.json`);
  // Фильтр описывает раздел, а не окно: бренд и цена есть у всех товаров
  // листинга, поэтому ограничивать их окном незачем и неверно.
  fs.writeFileSync(filtersFile, JSON.stringify(buildFilters(category, filterProducts || products), null, 2), 'utf-8');

  return { productsFile, filtersFile };
}

// ── CLI: собрать каталог без ИИ ──────────────────────────────
// node catalog.js                       — все категории из требований
// OUT_DIR=./out node catalog.js         — куда писать файлы
// CATEGORY=stiralnye_mashiny node catalog.js
// LIMIT=20 node catalog.js              — окно для проверки разбора
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const only = process.env.CATEGORY;
  const limit = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
  const targets = only ? [findCategory(only) ?? { url: only }] : CATEGORIES;

  const feed = await loadFeed().catch(e => {
    console.warn(`⚠ фид недоступен (${e.message}) — описания пойдут со страниц товаров`);
    return null;
  });

  for (const t of targets) {
    process.stdout.write(`\n📥 ${t.name || t.url}`);
    const cat = await crawlCategory(t.url, { limit, feed, onNote: () => process.stdout.write('.') });
    const { productsFile, filtersFile } = writeCategoryFiles(cat, cat.products, {
      dir: process.env.OUT_DIR || '.',      // в контейнере /app писать нельзя
      filterProducts: cat.items,
    });
    const f = buildFilters(cat, cat.items);
    console.log(`\n   id=${cat.id}  товаров=${cat.products.length} из ${cat.listed}` +
      `  брендов=${f.filters[0].values.length}  цена ${f.filters[1].min}–${f.filters[1].max} ₽`);
    console.log(`   ✅ ${productsFile}`);
    console.log(`   ✅ ${filtersFile}`);
  }
  console.log('');
}
