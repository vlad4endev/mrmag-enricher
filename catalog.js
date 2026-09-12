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
import { fetchDirect } from './socks.js';
import { netError, isEnrichable, modelToken, MIN_SOURCE_CHARS, extractFacts, hasCountryFact, canSearchWeb, schemaFor, hydrateFromDump, isSourceThin } from './lib.js';
import { specFacets, enrichedRows } from './export_v2.js';
import { loadConfig, loadCategories, hasDictionary } from './pipeline/dict.js';
import { normalizeProduct } from './pipeline/normalize.js';
import { lookupMissing, needsMissingLookup, parseMissingFromPage, missingRequiredCodes } from './pipeline/external.js';
import { CRAWL_SLUGS } from './pipeline/schema.js';
import { containsTokenSequence, identityMatches, nameKeyTokens, parseIdentity } from './pipeline/identity.js';
import { extractPairsFromPage, visibleText, collectPageHits, formatParseNotes } from './pipeline/parse.js';
import {
  isDuckDuckGoBlocked, isJunkHost, parseDuckDuckGoResults,
  searchWeb as pipelineSearchWeb, countryQuery, missingQuery, searchQuery,
  firstMatchingPage, publicParserStatus,
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
    res = await fetchDirect(url, {
      headers: {
        'User-Agent': ua,
        'Accept-Language': 'ru,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
      timeoutMs,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} на ${url}`);
    html = await res.text();
  } catch (e) {
    throw new Error(/^HTTP /.test(e.message) ? e.message : `${url} — ${netError(e, (() => { try { return new URL(url).host; } catch { return ''; } })())}`);
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
const WEB_PAGE_TIMEOUT = Number(process.env.WEB_PAGE_TIMEOUT_MS || 20_000);
export const WEB_LOOKUP = process.env.WEB_LOOKUP !== '0';

const htmlText = h => decode(String(h || '')
  .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' '));

/**
 * Страница про этот товар, а не про соседа.
 * Модель часто только в JSON-LD — поэтому смотрим visibleText, а не голый HTML.
 * Подстрока без границ токена не годится: GC-Q247 не должен совпасть с GC-Q247CAMT.
 */
export function pageDescribesProduct(html, product, dict) {
  const text = visibleText(html);
  const identity = dict
    ? parseIdentity(product?.name, dict)
    : { brand: product?.brand || null, model: modelToken(product?.name), name: product?.name };
  if (product?.brand && !identity.brand) identity.brand = product.brand;

  // Модель из справочника, если в ней есть буквы: «290» одно — слишком широко.
  if (identity.model && /[A-Za-zА-Яа-яЁё]/.test(identity.model)
      && identityMatches(text, identity, dict)) {
    return { ok: true, how: 'identity', model: identity.model };
  }
  const token = modelToken(product?.name);
  if (token && containsTokenSequence(text, token)) {
    return { ok: true, how: 'article', token };
  }
  const keys = nameKeyTokens(product?.name, product?.brand || identity.brand);
  if (!keys.length) {
    return { ok: false, reason: token ? `нет артикула ${token}` : 'в названии нет опознавательных слов' };
  }
  const missing = keys.filter(k => !containsTokenSequence(text, k));
  if (missing.length) {
    const why = token ? `нет артикула ${token}` : `нет в тексте «${missing.join(', ')}»`;
    return { ok: false, reason: why };
  }
  return { ok: true, how: 'name', keys };
}

/** Реклама чужого магазина: в описание нашей карточки такие фразы не идут. */
const SALES_RE = /куп(и|ить|лю)|цена|руб|₽|достав|магазин|заказ|скидк|акци|кредит|рассрочк|отзыв|корзин|самовывоз/i;

function pageHitsFromPairs(pairs) {
  return collectPageHits((pairs || []).map(p => ({
    name: p.key || p.name,
    value: p.value,
    via: p.via || 'text',
  })));
}

function joinParseMeta(a, b) {
  return [...new Set([a, b].map(s => String(s || '').trim()).filter(Boolean))].join(' · ') || null;
}

function mergePageParse(prev, next) {
  if (!next) return prev;
  const hitsPrev = prev?.hits || [];
  const hitsNext = next.hits || [];
  let hits = hitsPrev;
  if (hitsNext.length) {
    if (!hitsPrev.length) hits = hitsNext;
    else {
      const seen = new Set(hitsPrev.map(h => String(h.key || '').toLowerCase()));
      const extra = hitsNext.filter(h => !seen.has(String(h.key || '').toLowerCase()));
      hits = extra.length ? hitsPrev.concat(extra) : hitsPrev;
    }
  }
  const counts = {};
  for (const h of hits) counts[h.via] = (counts[h.via] || 0) + 1;
  return {
    hits,
    counts,
    query: joinParseMeta(prev?.query, next.query),
    error: hits.length ? null : joinParseMeta(prev?.error, next.error),
    origin: next.origin || prev?.origin || null,
    engine: next.engine || prev?.engine || null,
  };
}

function hostOfUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return 'сеть'; }
}

function rememberPageParse(pageParse, next, origin, onNote) {
  const merged = mergePageParse(pageParse, next);
  const label = next?.origin || origin || 'сеть';
  if (next?.hits?.length && !pageParse?.hits?.length) {
    for (const msg of formatParseNotes(next, { origin: label })) {
      onNote(msg, { step: 'parse' });
    }
  } else if (next && !next.hits?.length && (next.query || next.error)) {
    const q = next.query ? ` · ${next.query}` : '';
    onNote(`Поиск (${label}): ${next.error || 'без характеристик'}${q}`, { step: 'parse' });
  }
  return merged;
}

function searchEngineLabel() {
  try { return publicParserStatus(loadConfig(ROOT)).label || 'поиск в сети'; }
  catch { return 'поиск в сети'; }
}

function emptyWebParse({ query, error, origin } = {}) {
  return {
    hits: [],
    counts: {},
    query: query || null,
    error: error || null,
    origin: origin || searchEngineLabel(),
  };
}

/**
 * Характеристики и проза с произвольной страницы товара.
 * Таблица «подпись / значение» есть почти у всех — она же самая ценная часть,
 * потому что из неё extractFacts достаёт факты так же, как из annotation.
 * Дамп и страница из Yandex Search API идут через один разбор.
 */
export function parseAnyProductPage(html, dict) {
  // Своя карточка магазина (col-sm-5/7) и чужая страница из Yandex —
  // один разбор: иначе «Парсинг» видит только дамп.
  const shop = parseProductPage(html);
  const pairs = extractPairsFromPage(html, dict);
  const attributes = [];
  const seen = new Set();
  const push = (name, value, via) => {
    const n = String(name || '').replace(/\s+/g, ' ').trim();
    const v = String(value || '').replace(/\s+/g, ' ').trim();
    if (!n || !v) return;
    const key = n.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    attributes.push({ name: n, value: v, via: via || 'text' });
  };
  for (const a of shop.attributes || []) push(a.name, a.value, 'div');
  for (const p of pairs) push(p.key, p.value, p.via);

  const body = String(html || '').replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ');
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

/** Новый прогон — снова пробуем сеть. Счётчик жил в процессе и глушил Yandex. */
export function resetWebSearch() {
  searchFails = 0;
}

/** После SEARCH_GIVE_UP таймаутов подряд сеть не дергаем до перезапуска прогона. */
export function isWebSearchDisabled() {
  return searchFails >= SEARCH_GIVE_UP;
}

export function webSearchSkippedReason() {
  if (!isWebSearchDisabled()) return null;
  return `поиск отключён после ${searchFails} неудач подряд — перезапустите прогон`;
}

export async function searchWeb(query) {
  if (isWebSearchDisabled()) {
    throw new Error(webSearchSkippedReason());
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

function dictOf(schema) {
  if (schema?.dict) return schema.dict;
  try { return schemaFor(schema)?.dict; } catch { return undefined; }
}

function minAttrsOf() {
  try {
    const c = loadConfig(ROOT);
    const n = Number(c?.description?.min_attrs ?? c?.conditions?.min_attrs ?? 5);
    return Number.isFinite(n) ? n : 5;
  } catch {
    return 5;
  }
}

/**
 * Парсер страницы запускается не только на пустой карточке: если после дампа
 * фактов меньше min_attrs (по умолчанию 5), модель додумает остальное.
 * Ищем, если товар опознаваем.
 */
export function needsWebSpecs(product, schema, { minAttrs } = {}) {
  const n = minAttrs ?? minAttrsOf();
  if (!canSearchWeb(product)) return false;
  const gate = isEnrichable(product, schema);
  if (!gate.ok) return Boolean(gate.web);
  return isSourceThin(product, schema, { minFacts: n });
}

function countryFromHtml(html, schema, dict) {
  const found = parseAnyProductPage(html, dict);
  const text = [found.annotation, found.description].filter(Boolean).join('\n');
  const v = extractFacts(text, schema).страна_производства;
  if (v != null && String(v).trim()) return String(v).trim();
  const hit = (found.attributes || []).find(a =>
    /стран[аы][\s-]*(?:производств|изготовлен|производитель)/i.test(a.name) && a.value);
  return hit ? String(hit.value).trim() : null;
}

function withCountryLine(product, country, url) {
  const line = `Страна производства - ${country}`;
  return {
    ...product,
    annotation: [product.annotation, line].filter(Boolean).join('<br>'),
    source_url: product.source_url || url,
  };
}

/**
 * Запрос за страной: бренд + модель из справочника, не урезанный артикул.
 * «Холодильник ATLANT ХМ 6025-031» → ATLANT ХМ 6025-031, а не 6025-031:
 * modelToken берёт самое длинное слово с цифрами и отбрасывает «ХМ».
 */
function countrySearchIdentity(product, schema) {
  const dict = schemaFor(schema)?.dict;
  if (dict) {
    const id = parseIdentity(product.name, dict);
    return {
      brand: id.brand || product.brand || null,
      model: id.model || modelToken(product.name),
    };
  }
  return { brand: product.brand || null, model: modelToken(product.name) };
}

function withSpecLines(product, pairs, url) {
  const lines = (pairs || []).map(p => `${p.key} - ${p.value}`);
  if (!lines.length) return product;
  return {
    ...product,
    annotation: [product.annotation, ...lines].filter(Boolean).join('<br>'),
    source_url: product.source_url || url,
  };
}

function pageFetch(url) {
  return fetchPage(url, { ua: WEB_UA, timeoutMs: WEB_PAGE_TIMEOUT });
}

/**
 * Со совпавшей страницы добираем страну и дыры в обязательных фильтрах.
 * Отдельный поиск не нужен, если таблица уже на руках.
 */
function harvestGapsFromHtml(product, html, url, schema) {
  const dict = dictOf(schema);
  let next = product;
  const pairs = [];
  if (!hasCountryFact(next, schema)) {
    const country = countryFromHtml(html, schema, dict);
    if (country) {
      next = withCountryLine(next, country, url);
      pairs.push({ key: 'Страна производства', value: country, via: 'table' });
    }
  }
  if (!dict) return { product: next, pairs };
  let rec;
  try { rec = normalizeProduct(next, dict, loadConfig(ROOT)); }
  catch { return { product: next, pairs }; }
  if (!needsMissingLookup(rec, dict)) return { product: next, pairs };
  const got = parseMissingFromPage(html, rec, dict, loadConfig(ROOT));
  if (!got.ok) return { product: next, pairs };
  next = withSpecLines(next, got.pairs, url);
  pairs.push(...got.pairs);
  return { product: next, pairs };
}

/**
 * Страны нет в исходнике → поиск по модели. Совпавшая страница даёт только
 * страну: остальные поля карточки уже свои, чужую таблицу в них не мешаем.
 */
async function fillCountryFromWeb(product, schema, { onNote = () => {} } = {}) {
  if (hasCountryFact(product, schema) || !canSearchWeb(product)) {
    return { ok: false, product };
  }
  const origin = searchEngineLabel();
  const dict = dictOf(schema);
  const query = countryQuery({
    name: product.name,
    brand: product.brand,
    identity: countrySearchIdentity(product, schema),
  });
  // Не логируем «ищем страну», если контур уже закрыт — иначе в логе сотни
  // ложных стартов поиска после трёх таймаутов. Саму попытку в Парсинге оставляем:
  // иначе кажется, что искали только дамп.
  if (isWebSearchDisabled()) {
    const why = webSearchSkippedReason();
    onNote(`страну в сети не нашли: ${why}`);
    return { ok: false, product, parser: true, pageParse: emptyWebParse({ query, error: why, origin }) };
  }
  let urls = [];
  try {
    onNote(`ищем страну: ${query}`);
    urls = await searchWeb(query);
  } catch (e) {
    onNote(`страну в сети не нашли: ${e.message}`);
    return { ok: false, product, parser: true, pageParse: emptyWebParse({ query, error: e.message, origin }) };
  }

  const found = await firstMatchingPage(urls, {
    fetchHtml: pageFetch,
    maxPages: WEB_TRIES,
    match: (html, url) => {
      const who = pageDescribesProduct(html, product, dict);
      if (!who.ok) return { ok: false, reason: who.reason };
      const country = countryFromHtml(html, schema, dict);
      if (!country) return { ok: false, reason: 'страны нет на странице' };
      return { ok: true, country };
    },
  });
  if (!found.ok) {
    const why = found.tried.length ? found.tried.join('; ') : 'выдача пуста';
    onNote(`страну в сети не нашли: ${why}`);
    return { ok: false, product, parser: true, pageParse: emptyWebParse({ query, error: why, origin }) };
  }
  const host = hostOfUrl(found.url);
  onNote(`страна из сети: ${found.country} (${host})`);
  return {
    ok: true,
    product: withCountryLine(product, found.country, found.url),
    source: found.url,
    parser: true,
    pairs: [{ key: 'Страна производства', value: found.country, via: 'table' }],
    pageParse: {
      ...pageHitsFromPairs([{ key: 'Страна производства', value: found.country, via: 'table' }]),
      query,
      origin: host || origin,
    },
  };
}

/**
 * Обязательный фильтр (отжим, шум, энергокласс…) пуст при живой карточке —
 * тот же поиск по модели, что и для страны. Не открываем сеть из‑за цвета
 * или дисплея. Совпавшая страница дописывает только пустые поля.
 */
async function fillMissingFiltersFromWeb(product, schema, { onNote = () => {} } = {}) {
  const dict = dictOf(schema);
  if (!dict || !canSearchWeb(product)) return { ok: false, product };
  let rec;
  try { rec = normalizeProduct(product, dict, loadConfig(ROOT)); }
  catch { return { ok: false, product }; }
  if (!needsMissingLookup(rec, dict)) return { ok: false, product };
  const origin = searchEngineLabel();
  const codes = missingRequiredCodes(rec, dict);
  const query = missingQuery(rec, dict, codes);
  if (isWebSearchDisabled()) {
    const why = webSearchSkippedReason();
    onNote(`недостающие фильтры в сети не искали: ${why}`);
    return { ok: false, product, parser: true, pageParse: emptyWebParse({ query, error: why, origin }) };
  }
  const got = await lookupMissing(rec, dict, loadConfig(ROOT), {
    onNote,
    search: searchWeb,
    fetchHtml: pageFetch,
  });
  if (!got.ok) {
    const why = got.reason || 'не нашли';
    return {
      ok: false,
      product,
      parser: true,
      pageParse: emptyWebParse({ query: got.query || query, error: why, origin }),
    };
  }
  return {
    ok: true,
    product: withSpecLines(product, got.pairs, got.url),
    source: got.url,
    parser: true,
    pairs: got.pairs,
    pageParse: {
      ...pageHitsFromPairs(got.pairs),
      query: got.query || query,
      origin: hostOfUrl(got.url) || origin,
    },
  };
}

/**
 * Товар с описанием: дамп заказчика, своё, иначе найденное в сети.
 * Возвращает { product, gate, source, parser }: product — то, что уходит в модель,
 * gate — вердикт по нему, source — адрес страницы, откуда добран текст,
 * parser — поиск или разбор страницы реально запускались.
 *
 * Сначала data_{catId}.json по sku/id. Если после дампа фактов меньше
 * min_attrs — парсим карточку этой модели: иначе модель додумывает объём
 * и габариты. Если товар опознаваем по имени, поиск — лучшее усилие:
 * таймаут не пропускает карточку, модели уходит исходное имя. Чужие
 * характеристики без совпадения модели по-прежнему не подставляются.
 *
 * Страна производства и дыры в обязательных фильтрах — отдельные случаи:
 * своих характеристик может быть достаточно, а отжима или страны в исходнике
 * нет. Тогда ищем их по модели. Артикул (F12, 5109) в об/мин не переводим.
 *
 * Атрибуты магазина остаются нетронутыми: они задают фасеты каталога, и
 * подмешивать в них чужую таблицу нельзя — спор «каталога с самим собой»
 * должен оставаться спором каталога.
 */
export async function ensureSource(product, schema, { onNote = () => {}, root = ROOT } = {}) {
  const fromDump = hydrateFromDump(product, schema, root);
  let current = fromDump.product;
  const gate = isEnrichable(current, schema);
  if (!WEB_LOOKUP) return { product: current, gate };
  if (!gate.ok && !gate.web) return { product: current, gate };

  const dict = dictOf(schema);
  const minAttrs = minAttrsOf();
  const wantSpecs = needsWebSpecs(current, schema, { minAttrs });

  let source = null;
  let parser = false;
  let currentGate = gate;
  let pageParse = null;

  if (wantSpecs) {
    const token = modelToken(current.name);
    const identity = dict
      ? parseIdentity(current.name, dict)
      : { brand: current.brand || null, model: token, name: current.name };
    if (current.brand && !identity.brand) identity.brand = current.brand;
    const query = searchQuery({ name: current.name, brand: current.brand, identity });

    let urls = [];
    let searchFailed = false;
    let searchWhy = null;
    if (isWebSearchDisabled()) {
      searchWhy = webSearchSkippedReason();
      onNote(`поиск не удался, отправляем как есть: ${searchWhy}`);
      if (!gate.ok) {
        currentGate = { ...gate, ok: true, reason: `${gate.reason}; поиск в сети не удался: ${searchWhy}` };
      }
      searchFailed = true;
    } else {
      try {
        onNote(fromDump.dump && fromDump.thin
          ? `в дампе мало характеристик (${fromDump.facts}) — парсим карточку: ${token || current.name}`
          : gate.ok
            ? `мало характеристик (${gate.facts ?? 0} < ${minAttrs}) — ищем в сети: ${token || current.name}`
            : `ищем в сети: ${token || current.name}`);
        urls = await searchWeb(query);
        parser = true;
      } catch (e) {
        parser = true;
        searchWhy = e.message;
        onNote(`поиск не удался, отправляем как есть: ${e.message}`);
        if (!gate.ok) {
          currentGate = { ...gate, ok: true, reason: `${gate.reason}; поиск в сети не удался: ${e.message}` };
        }
        searchFailed = true;
      }
    }

    if (searchFailed) {
      pageParse = rememberPageParse(
        pageParse,
        emptyWebParse({ query, error: searchWhy, origin: searchEngineLabel() }),
        searchEngineLabel(),
        onNote,
      );
    } else {
      const foundPage = await firstMatchingPage(urls, {
        fetchHtml: pageFetch,
        maxPages: WEB_TRIES,
        match: (html, url) => {
          const who = pageDescribesProduct(html, current, dict);
          if (!who.ok) return { ok: false, reason: who.reason };
          const found = parseAnyProductPage(html, dict);
          if (!found.annotation && found.description.length < MIN_SOURCE_CHARS) {
            return { ok: false, reason: 'нечего взять' };
          }
          const merged = {
            ...current,
            description: String(current.description || '').trim() || found.description,
            annotation:  [current.annotation, found.annotation].filter(Boolean).join('<br>'),
            source_url:  url,
          };
          const after = isEnrichable(merged, schema);
          if (!after.ok && !gate.ok) return { ok: false, reason: after.reason };
          return { ok: true, merged, found, after };
        },
      });
      if (foundPage.ok) {
        const host = hostOfUrl(foundPage.url);
        pageParse = rememberPageParse(
          pageParse,
          { ...collectPageHits(foundPage.found.attributes), query, origin: host },
          host,
          onNote,
        );
        onNote(`описание из сети: ${host}`);
        const harvested = harvestGapsFromHtml(foundPage.merged, foundPage.html, foundPage.url, schema);
        current = harvested.product;
        source = foundPage.url;
        currentGate = foundPage.after.ok
          ? isEnrichable(current, schema)
          : { ...gate, ok: true, facts: foundPage.after.facts };
        if (harvested.pairs.length) {
          pageParse = rememberPageParse(
            pageParse,
            pageHitsFromPairs(harvested.pairs),
            host,
            onNote,
          );
        }
      } else {
        const why = foundPage.tried.length ? foundPage.tried.join('; ') : 'выдача пуста';
        onNote(`в сети не нашлось, отправляем как есть: ${why}`);
        pageParse = rememberPageParse(
          pageParse,
          emptyWebParse({ query, error: why, origin: searchEngineLabel() }),
          searchEngineLabel(),
          onNote,
        );
        if (!gate.ok) {
          currentGate = { ...gate, ok: true, reason: `${gate.reason}; в сети не нашлось (${why})` };
        }
      }
    }
  }

  const [missing, country] = await Promise.all([
    fillMissingFiltersFromWeb(current, schema, { onNote }),
    fillCountryFromWeb(current, schema, { onNote }),
  ]);
  if (missing.parser || country.parser) parser = true;
  if (missing.ok) {
    current = withSpecLines(current, missing.pairs, missing.source);
    source = source || missing.source;
  }
  if (missing.pageParse) {
    pageParse = rememberPageParse(pageParse, missing.pageParse, missing.pageParse.origin, onNote);
  }
  if (country.ok) {
    const value = country.pairs?.[0]?.value;
    if (value && !hasCountryFact(current, schema)) {
      current = withCountryLine(current, value, country.source);
    }
    source = source || country.source;
  }
  if (country.pageParse) {
    pageParse = rememberPageParse(pageParse, country.pageParse, country.pageParse.origin, onNote);
  }
  if (missing.ok || country.ok) {
    currentGate = isEnrichable(current, schema);
  }
  if (source || pageParse?.query || pageParse?.error || pageParse?.hits?.length) parser = true;

  return {
    product: current,
    gate: currentGate,
    ...(source ? { source } : {}),
    ...(parser ? { parser: true } : {}),
    ...(pageParse ? { page_parse: pageParse } : {}),
  };
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
