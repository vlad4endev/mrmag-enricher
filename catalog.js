/**
 * catalog.js — сборка каталога категории mrmag.ru и автофильтров.
 *
 * Разделы со справочником: dictionaries/attributes_{id}.json + categories.json.
 * URL обхода магазина — slug из CRAWL_SLUGS (только адрес, без имён характеристик).
 * id категории при записи файлов берётся со страницы (data-category).
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
import { netError, isEnrichable, modelToken, MIN_SOURCE_CHARS } from './lib.js';
import { specFacets, enrichedRows } from './export_v2.js';
import { loadConfig, loadCategories, hasDictionary } from './pipeline/dict.js';
import { CRAWL_SLUGS } from './pipeline/schema.js';
import { containsTokenSequence, nameKeyTokens } from './pipeline/identity.js';
import {
  isDuckDuckGoBlocked, isJunkHost, parseDuckDuckGoResults,
  searchWeb as pipelineSearchWeb,
} from './pipeline/search.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export const ORIGIN = 'https://mrmag.ru';
export const FEED_URL = `${ORIGIN}/scripts/sync_local/products.json`;

/** URL обхода: slug → полный адрес раздела (без имён атрибутов). */
const CRAWL_URLS = Object.fromEntries(
  Object.keys(CRAWL_SLUGS).map(slug => [slug, `${ORIGIN}/shop/${slug}`]),
);

/**
 * Разделы, для которых есть dictionaries/attributes_{id}.json.
 * Имена — из categories.json; slug/URL — только для обхода магазина.
 */
export function resolveCrawlCategories(root = ROOT) {
  let cats = [];
  try { cats = loadCategories(root); } catch { /* */ }
  const byId = new Map(cats.map(c => [String(c.id), c]));
  const out = [];
  for (const [slug, id] of Object.entries(CRAWL_SLUGS)) {
    if (!hasDictionary(id, root)) continue;
    const meta = byId.get(String(id));
    out.push({
      slug,
      id: Number(id),
      name: meta?.name || `Категория ${id}`,
      url: CRAWL_URLS[slug] || `${ORIGIN}/shop/${slug}`,
    });
  }
  return out;
}

export const CATEGORIES = resolveCrawlCategories();

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
export async function fetchPage(url, { noCache = false, ua = UA, timeoutMs = 45_000 } = {}) {
  const file = cachePath(url);
  if (!noCache && fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < CACHE_TTL) {
    return fs.readFileSync(file, 'utf-8');
  }
  const gap = MIN_GAP_MS - (Date.now() - lastFetch);
  if (gap > 0) await sleep(gap);
  lastFetch = Date.now();

  let res, html;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': ua, 'Accept-Language': 'ru,en;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs),
    });
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
    annotation:  attributes.map(a => `${a.name} - ${a.value}`).join('<br>'),
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

// ── ТОВАР БЕЗ ОПИСАНИЯ: ПОИСК В СЕТИ ─────────────────────────
/**
 * Часть карточек магазина пуста и в фиде, и на самой странице товара
 * (проверено: у 41 холодильника из 1654 нет ни description, ни annotation, а
 * на странице нет даже таблицы характеристик). Модели такой товар показывать
 * нечего — он уходит в «пропущен». Но сам товар существует: та же модель
 * описана у производителя и у других продавцов.
 *
 * Поэтому: ищем карточку по названию, читаем таблицу характеристик и
 * нейтральную часть текста, и отдаём их как обычный исходный текст. Дальше
 * работает всё то же самое — extractFacts, гейт, промпт.
 *
 * Чужая страница — источник недоверенный, отсюда три ограничения:
 *   1. страница принимается, если на ней есть артикул из названия
 *      или все опознавательные слова имени (бренд + модель). Иначе
 *      в карточку уедут характеристики соседней модели;
 *   2. торговые фразы («купить», «доставка», цена в рублях) выбрасываются —
 *      это реклама чужого магазина, ей в нашем описании не место;
 *   3. адрес страницы записывается в source_url и виден в выгрузке: откуда
 *      взялся текст, должно быть видно, а не подразумеваться.
 */
const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
             + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const WEB_TRIES = Number(process.env.WEB_LOOKUP_TRIES || 3);   // страниц на товар
export const WEB_LOOKUP = process.env.WEB_LOOKUP !== '0';

/** Сравнение артикулов: «GC-Q247CAMT», «GC Q247CAMT» и «gcq247camt» — одно и то же. */
const squash = s => String(s || '').toLowerCase().replace(/[^\p{L}\d]/gu, '');

const htmlText = h => decode(String(h || '')
  .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' '));

/**
 * Страница про этот товар, а не про соседа.
 * Сначала артикул (если он есть в названии), иначе все опознавательные слова.
 */
export function pageDescribesProduct(html, product) {
  const text = htmlText(html);
  const hay = squash(text);
  const token = modelToken(product?.name);
  if (token && hay.includes(squash(token))) return { ok: true, how: 'article', token };
  const keys = nameKeyTokens(product?.name, product?.brand);
  if (!keys.length) {
    return { ok: false, reason: token ? `нет артикула ${token}` : 'в названии нет опознавательных слов' };
  }
  const missing = keys.filter(k => !containsTokenSequence(text, k) && !hay.includes(squash(k)));
  if (missing.length) {
    const why = token ? `нет артикула ${token}` : `нет в тексте «${missing.join(', ')}»`;
    return { ok: false, reason: why };
  }
  return { ok: true, how: 'name', keys };
}

/** Реклама чужого магазина: в описание нашей карточки такие фразы не идут. */
const SALES_RE = /куп(и|ить|лю)|цена|руб|₽|достав|магазин|заказ|скидк|акци|кредит|рассрочк|отзыв|корзин|самовывоз/i;

/**
 * Характеристики и проза с произвольной страницы товара.
 * Таблица «подпись / значение» есть почти у всех — она же самая ценная часть,
 * потому что из неё extractFacts достаёт факты так же, как из annotation.
 */
export function parseAnyProductPage(html) {
  const body = String(html || '').replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ');
  const attributes = [];
  const seen = new Set();
  const add = (name, value) => {
    if (!name || !value || name === value) return;
    if (name.length > 60 || value.length > 160 || /^https?:/i.test(value)) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    attributes.push({ name, value });
  };
  for (const row of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => htmlText(m[1]));
    if (cells.length === 2) add(cells[0], cells[1]);
  }
  for (const pair of body.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)) {
    add(htmlText(pair[1]), htmlText(pair[2]));
  }

  const meta = body.match(/<meta[^>]+(?:name|property)="(?:og:)?description"[^>]*content="([^"]*)"/i)?.[1] ?? '';
  const prose = [decode(meta), ...[...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => htmlText(m[1]))]
    .join(' ')
    .split(/(?<=[.!?])\s+/)
    .filter(sent => sent.length > 40 && !SALES_RE.test(sent))
    .join(' ')
    .slice(0, 2000);

  return {
    description: prose,
    // Тот же вид, в котором характеристики приходят из фида и со страницы
    // магазина: «подпись - значение» через пробел.
    annotation: attributes.map(a => `${a.name} - ${a.value}`).join('<br>'),
    attributes,
  };
}

/**
 * Адреса выдачи по запросу. Ссылки в выдаче — обычные <a href>, у DuckDuckGo
 * завёрнутые в редирект /l/?uddg=..., поэтому разворачиваем.
 * По одному адресу на домен: три страницы одного магазина — это одна и та же
 * карточка трижды.
 *
 * DuckDuckGo в футере всегда даёт mastodon.social и buttondown.email. Если
 * забрать все href подряд, «выдача» состоит из рассылки — и запасной
 * поисковик уже не вызывается, потому что ссылки формально нашлись.
 * Органика — только a.result__a; заглушка и соцсети считаются пустой выдачей.
 */
/**
 * Адрес из выдачи — недоверенный: чужая или подсунутая ссылка на 127.0.0.1 или
 * 169.254.169.254 превратила бы обогащение в чтение внутренней сети и
 * метаданных облака (тот же риск, из-за которого /api/product ходит по
 * списку хостов). Поэтому локальные и служебные адреса не читаются вовсе.
 * WEB_ALLOW_LOCAL=1 снимает запрет — он нужен только тестам с локальной
 * заглушкой поисковика.
 */
const ALLOW_LOCAL = process.env.WEB_ALLOW_LOCAL === '1';
const PRIVATE_HOST = new RegExp([
  '^localhost$', '\\.local$', '^\\[?::1\\]?$', '^\\[?f[cd]', '^\\[?fe80:',
  '^127\\.', '^10\\.', '^192\\.168\\.', '^169\\.254\\.', '^0\\.',
  '^172\\.(1[6-9]|2\\d|3[01])\\.',
].join('|'), 'i');

export function parseSearchResults(html, engineHost = '') {
  const body = String(html || '');
  if (isDuckDuckGoBlocked(body)) return [];
  if (/result__a|web-result|result-link/i.test(body)) {
    return parseDuckDuckGoResults(body);
  }

  const urls = [];
  const hosts = new Set();
  const own = new URL(ORIGIN).hostname;
  for (const m of body.matchAll(/href="([^"]+)"/g)) {
    const href = m[1].replace(/&amp;/g, '&');
    let u;
    try { u = new URL(href.startsWith('//') ? 'https:' + href : href); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (/(^|\.)duckduckgo\.com$/i.test(u.hostname)) {
      const target = u.searchParams.get('uddg');
      if (!target) continue;
      try { u = new URL(target); } catch { continue; }
    }
    const host = u.hostname.replace(/^www\./, '');
    if (host === own) continue;                          // наша же пустая карточка
    if (isJunkHost(host)) continue;
    if (engineHost && host.endsWith(engineHost)) continue;
    if (!ALLOW_LOCAL && PRIVATE_HOST.test(host)) continue;
    if (/^(yastatic|gstatic|googleusercontent)\./i.test(host)) continue;
    if (u.pathname === '/' && !u.search) continue;       // главная страница — не карточка
    if (hosts.has(host)) continue;
    hosts.add(host);
    urls.push(u.href);
  }
  return urls;
}

// Поисковик, закрывшийся от нас, закрыт и для следующего товара. Без этого
// сорок пустых карточек подряд превращаются в сорок бесполезных обходов всех
// поисковиков — это десятки минут ожидания ни за чем.
const SEARCH_GIVE_UP = Number(process.env.SEARCH_GIVE_UP || 3);
let searchFails = 0;

export async function searchWeb(query) {
  if (searchFails >= SEARCH_GIVE_UP) {
    throw new Error(`поиск отключён после ${searchFails} неудач подряд — перезапустите прогон`);
  }
  let config = {};
  try { config = loadConfig(ROOT); } catch { /* значения по умолчанию в resolveSearchSettings */ }
  try {
    const urls = await pipelineSearchWeb(query, config);
    searchFails = 0;
    return urls;
  } catch (e) {
    searchFails++;
    throw e;
  }
}

/**
 * Товар с описанием: своим, если оно есть, иначе найденным в сети.
 * Возвращает { product, gate, source }: product — то, что уходит в модель,
 * gate — вердикт по нему, source — адрес страницы, откуда добран текст.
 *
 * Атрибуты магазина остаются нетронутыми: они задают фасеты каталога, и
 * подмешивать в них чужую таблицу нельзя — спор «каталога с самим собой»
 * должен оставаться спором каталога.
 */
export async function ensureSource(product, schema, { onNote = () => {} } = {}) {
  const gate = isEnrichable(product, schema);
  if (gate.ok || !WEB_LOOKUP || !gate.web) return { product, gate };

  const token = modelToken(product.name);
  const query = `${String(product.name).replace(/["«»]/g, ' ')} ${product.brand || ''} характеристики`
    .replace(/\s+/g, ' ').trim();

  let urls = [];
  try {
    onNote(`ищем в сети: ${token || product.name}`);
    urls = await searchWeb(query);
  } catch (e) {
    return { product, gate: { ...gate, reason: `${gate.reason}; поиск в сети не удался: ${e.message}` } };
  }

  const tried = [];
  for (const url of urls.slice(0, WEB_TRIES)) {
    const host = new URL(url).hostname.replace(/^www\./, '');
    let html;
    try { html = await fetchPage(url, { ua: WEB_UA, timeoutMs: 20_000 }); }
    catch { tried.push(`${host}: не открылась`); continue; }

    // Не тот товар — не наш случай: лучше пропуск, чем чужие характеристики.
    const who = pageDescribesProduct(html, product);
    if (!who.ok) {
      tried.push(`${host}: ${who.reason}`);
      continue;
    }
    const found = parseAnyProductPage(html);
    if (!found.annotation && found.description.length < MIN_SOURCE_CHARS) {
      tried.push(`${host}: нечего взять`);
      continue;
    }
    const merged = {
      ...product,
      description: String(product.description || '').trim() || found.description,
      annotation:  [product.annotation, found.annotation].filter(Boolean).join(' ').trim(),
      source_url:  url,
    };
    const after = isEnrichable(merged, schema);
    if (!after.ok) { tried.push(`${host}: ${after.reason}`); continue; }
    onNote(`описание из сети: ${host}`);
    return { product: merged, gate: after, source: url };
  }

  const why = tried.length ? tried.join('; ') : 'выдача пуста';
  return { product, gate: { ...gate, reason: `${gate.reason}; в сети не нашлось (${why})` } };
}

// ── АВТОФИЛЬТРЫ ──────────────────────────────────────────────
/**
 * Бренд и цена строятся из самих товаров: бренд — как его классифицирует
 * магазин, цена — фактический диапазон. Ничего вручную не задаётся, поэтому
 * файл не расходится с каталогом.
 */
/**
 * Бренд товара: сначала классификация магазина, потом обогащение.
 *
 * Второй источник появился не для красоты: листинг отдаёт бренд классом
 * mr-brand, а фид products.json — нет. Прогон по фиду давал фильтр «Бренд» с
 * пустым списком и «без значения: 259», потому что assignMissingBrands строит
 * словарь из тех же товаров и без единого бренда ему не с чего начать.
 * В обогащении бренд уже разобран — не использовать его было бы расточительно.
 */
const brandOf = p => {
  const shop = p.brand || p.brand_slug;
  if (shop) return { value: p.brand || p.brand_slug, slug: p.brand_slug || null, source: p.brand_source || 'shop' };
  const ai = p.enriched?.specs?.бренд;
  return ai ? { value: String(ai).trim(), slug: null, source: 'enriched' } : null;
};

/**
 * Фильтры раздела: бренд и цена магазина плюс фасеты из обогащения.
 *
 * facetsFrom нужен CLI: бренд и цена считаются по всему листингу раздела, а
 * фасеты — только по обогащённым товарам, и это разные наборы. Без него файл
 * из CLI знал бы про раздел меньше, чем файл из интерфейса.
 */
export function buildFilters(category, products, { facetsFrom = products } = {}) {
  const brands = new Map();
  for (const p of products) {
    const b0 = brandOf(p);
    if (!b0) continue;
    const key = b0.slug || b0.value;
    const b = brands.get(key) || { value: b0.value, slug: b0.slug, count: 0 };
    b.count++;
    brands.set(key, b);
  }

  const prices = products.map(p => p.price).filter(v => Number.isFinite(v) && v > 0);
  const noBrand = products.filter(p => !brandOf(p)).length;
  const byName = products.filter(p => p.brand_source === 'name').length;
  const byAI = products.filter(p => brandOf(p)?.source === 'enriched').length;

  // Бренд из обогащения уже учтён в фасете «Бренд» — вторым списком он не нужен.
  const specs = specFacets(facetsFrom).filter(f => f.code !== 'бренд');
  const enrichedTotal = enrichedRows(facetsFrom).length;

  return {
    category_id: category.id,
    category:    category.name,
    url:         category.url,
    generated_at: new Date().toISOString(),
    products_total: products.length,
    enriched_total: enrichedTotal,
    filters: [
      {
        code: 'brand', name: 'Бренд', type: 'checkbox',
        // Сначала частые: так фильтр читается без сортировки на клиенте.
        values: [...brands.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'ru')),
        ...(noBrand ? { without_value: noBrand } : {}),
        ...(byName ? { assigned_by_name: byName } : {}),
        ...(byAI ? { assigned_by_ai: byAI } : {}),
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
      ...specs,
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
  fs.writeFileSync(filtersFile, JSON.stringify(
    buildFilters(category, filterProducts || products, { facetsFrom: products }), null, 2), 'utf-8');

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
