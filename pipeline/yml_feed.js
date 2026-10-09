/**
 * YML-фид (Яндекс.Маркет) → список товаров для массового описания фото.
 * Парсер потоковый: фид бывает 50+ МБ, целиком в одну строку его не держим.
 * Формат проверен на https://groster.me/anyquery (<offer> с <param name="…">, <picture>, categoryId).
 */

/** Служебные param фида — не факты о товаре, модели их не отдаём. */
const SERVICE_PARAMS = new Set([
  'хит', 'комплект', 'часть комплекта', 'code', 'codeclean', 'vendorcodeclean',
  'наличие', 'totalqty', 'синоним',
]);

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': ' ' };

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, m => ENT[m])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
}

/** Первые `categories`: id → { name, parentId }. */
export function parseCategories(xml) {
  const map = new Map();
  for (const m of xml.matchAll(/<category\s([^>]*)>([\s\S]*?)<\/category>/g)) {
    const id = /\bid="([^"]*)"/.exec(m[1])?.[1];
    if (!id) continue;
    map.set(id, { name: decode(m[2]), parentId: /\bparentId="([^"]*)"/.exec(m[1])?.[1] || null });
  }
  return map;
}

/** «Стеклянная тара › Стеклянные банки» — родитель важен для точного типа товара. */
export function categoryPath(categories, id) {
  const out = [];
  for (let cur = id, n = 0; cur && categories.has(cur) && n < 8; n += 1) {
    const c = categories.get(cur);
    out.unshift(c.name);
    cur = c.parentId;
  }
  return out.join(' › ');
}

export function parseOffer(xml, categories = new Map()) {
  const head = /<offer\s([^>]*)>/.exec(xml)?.[1] || '';
  const id = /\bid="([^"]*)"/.exec(head)?.[1] || '';
  const params = [];
  const synonyms = [];
  for (const m of xml.matchAll(/<param\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/param>/g)) {
    const name = decode(m[1]);
    const value = decode(m[2]);
    if (!name || !value) continue;
    if (name.toLowerCase() === 'синоним') { synonyms.push(value); continue; }
    if (SERVICE_PARAMS.has(name.toLowerCase())) continue;
    if (/^(false|true)$/i.test(value)) continue;
    params.push({ name, value });
  }
  const categoryId = tag(xml, 'categoryId');
  return {
    id,
    name: tag(xml, 'name'),
    vendor: tag(xml, 'vendor'),
    vendor_code: tag(xml, 'vendorCode'),
    description: tag(xml, 'description'),
    url: tag(xml, 'url'),
    image_url: tag(xml, 'picture'),
    category_id: categoryId,
    category: categoryPath(categories, categoryId),
    params,
    synonyms: [...new Set(synonyms)].slice(0, 12),
  };
}

/**
 * chunks — любой async/sync iterable строк или Buffer (fetch body, fs.createReadStream).
 * filter(offer) → bool
 * limit — максимум НОВЫХ товаров в ответе (после offset / skipIds)
 * offset — пропустить первые N подходящих (по filter)
 * skipIds — Set product_id уже в альбоме: их не считаем в limit, читаем дальше до конца фида
 */
export async function parseYml(chunks, {
  limit = Infinity,
  offset = 0,
  filter = null,
  skipIds = null,
} = {}) {
  const dec = new TextDecoder('utf-8');
  let buf = '';
  let categories = null;
  let seen = 0;
  let skippedKnown = 0;
  const offers = [];
  const known = skipIds instanceof Set ? skipIds : null;

  for await (const chunk of chunks) {
    buf += typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
    if (!categories) {
      const end = buf.indexOf('</categories>');
      if (end >= 0) categories = parseCategories(buf.slice(0, end));
      else if (buf.indexOf('<offer ') >= 0) categories = new Map(); // фид без categories
      else continue;
    }
    let from = 0;
    for (;;) {
      const s = buf.indexOf('<offer ', from);
      if (s < 0) break;
      const e = buf.indexOf('</offer>', s);
      if (e < 0) break;
      from = e + 8;
      const offer = parseOffer(buf.slice(s, from), categories);
      if (!offer.id || !offer.name || (filter && !filter(offer))) continue;
      if (seen++ < offset) continue;
      if (known && known.has(offer.id)) {
        skippedKnown += 1;
        continue;
      }
      offers.push(offer);
      if (offers.length >= limit) {
        return { offers, categories, scanned: seen, skipped_known: skippedKnown, exhausted: false };
      }
    }
    // оставляем только хвост с недочитанным <offer>
    const tail = buf.lastIndexOf('<offer ');
    buf = tail >= from ? buf.slice(tail) : buf.slice(from);
  }
  if (!categories) throw new Error('Не похоже на YML: нет <categories>/<offer>');
  return {
    offers,
    categories,
    scanned: seen,
    skipped_known: skippedKnown,
    exhausted: true,
  };
}

/** Читаемый блок фактов для vision-модели. */
export function offerFacts(offer) {
  return {
    name: offer.name,
    category: offer.category || null,
    brand: offer.vendor || null,
    article: offer.vendor_code || null,
    specs: Object.fromEntries(offer.params.map(p => [p.name, p.value])),
    synonyms: offer.synonyms?.length ? offer.synonyms : undefined,
    shop_description: offer.description || undefined,
  };
}
